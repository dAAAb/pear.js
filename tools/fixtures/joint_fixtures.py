"""Writes the fixtures of pear.js's joint layer: what PEAR's own classes of pear/deploy/station/control/joint give
for the limits, the configuration, the monitors and the feedforward that src/station/joint and src/so101/joint port.

Run it with the Python of a PEAR station environment, from any directory; PEAR must be a checkout at the commit that
src/index.ts pins, because the stations of PEAR's own tests (tests/deploy/station) are read from it:

    <work dir>/envs/station/bin/python tools/fixtures/joint_fixtures.py

It writes tests/fixtures/station-joint/*.json and nothing else. It needs no device and no GPU. Everything is
deterministic: fixed seeds, and PEAR's clock is replaced by one that only this script moves. Every expected value is
what PEAR's class returned or raised; the script holds no rule of its own about what is right.

For a longer comparison that is not committed, write a larger set elsewhere and point the tests at it:

    <work dir>/envs/station/bin/python tools/fixtures/joint_fixtures.py --scale 20 --output <directory>
    PEAR_JS_JOINT_FIXTURES=<directory> npx vitest run tests/station-joint
"""

from __future__ import annotations

import argparse
import copy
import dataclasses
import hashlib
import importlib.metadata
import json
import math
import os
import random
import re
import sys
import tempfile
import threading
import time
from collections import deque
from collections.abc import Callable, Iterable, Sequence
from enum import Enum
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
from omegaconf import OmegaConf

import pear
from pear.deploy.station.control import schemas
from pear.deploy.station.control.joint.action_guard import ActionGuard
from pear.deploy.station.control.joint.arm_state import ArmState
from pear.deploy.station.control.joint.config import ControlConfig, HomeConfig, Limits, MotionLimits, RobotConfig
from pear.deploy.station.control.joint.feedforward import FrictionFeedforward
from pear.deploy.station.control.joint.layout import JointLayout
from pear.deploy.station.control.joint.limits import JointLimits
from pear.deploy.station.control.joint.snapshot_checks import SnapshotCheck
from pear.deploy.station.control.joint.stability import SampleWindow, StabilityError, StabilityWindow
from pear.deploy.station.control.joint.tracking import Tracking, TrackingError
from pear.deploy.station.control.robot import BaseRobot
from pear.deploy.station.control.robots.so101 import config as so101_settings
from pear.deploy.station.control.robots.so101.config import (
    CameraConfig,
    FeedforwardConfig,
    HardwareConfig,
    KinematicsConfig,
    SO101Config,
    SO101HomeConfig,
    SO101Limits,
)
from pear.deploy.station.control.robots.so101.joint.feedforward import (
    Feedforward,
    GravityModel,
    SO101FrictionFeedforward,
)
from pear.deploy.station.control.robots.so101.layout import GRIPPER_INDEX, JOINTS, VECTOR_LENGTH
from pear.deploy.station.control.robots.so101.robot import SO101Robot
from pear.deploy.station.exceptions import OperatorPaused

REPOSITORY = Path(__file__).resolve().parents[2]
FIXTURES = REPOSITORY / "tests" / "fixtures" / "station-joint"
PEAR_PACKAGE = Path(pear.__file__).resolve().parent
PEAR_STATION_TESTS = PEAR_PACKAGE.parent / "tests" / "deploy" / "station"  # PEAR's own tests of the station
SEED = 20261115
START_S = 100.0  # the first reading of the clock, as of the stand-in clock of PEAR's tests

# What PEAR's tests of the SO-101's arm change of its station of the tests besides its quick settings
# (tests/deploy/station/test_so101_joint_in_station.py: ZERO_HOME_OVERRIDE and ARM_TEST_OVERRIDES)
SO101_ARM_TEST_OVERRIDES = (
    "robot.home.position=[0.0, 0.0, 0.0, 0.0, 0.0, 1.0]",
    "robot.home.joint_tolerance=[0.035, 0.035, 0.035, 0.035, 0.035]",
    "robot.position_tolerance=0.035",
    "robot.feedback_position_tolerance=0.05",
    "robot.feedforward=null",
)
FED_POSITION = 0.1  # where every coordinate of a snapshot fed to a window rests (test_stability_in_station.py)
SO101_REST = (0.0, -1.0, 1.0, 0.5, 0.0, 0.5)  # the SO-101's arm at rest, its jaw half open (the same file)
SDK_PERIOD_S = 0.004  # the control period of test_feedforward_in_station.py
ADVANCE_PERIOD_S = 0.02  # the control period of the feedforward tests of test_so101_joint_in_station.py
ABSENT = object()  # a key a snapshot leaves out


def plain(value: Any) -> Any:
    """Returns ``value`` as JSON holds it: arrays and tuples as lists, numpy's numbers as Python's, an enumeration's
    member as its word, a path as its name, and a number that is not finite as ``{"$": "nan"}`` (JSON has none)."""
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    if isinstance(value, (float, np.floating)):
        number = float(value)
        if math.isfinite(number):
            return number
        return {"$": "nan" if math.isnan(number) else "inf" if number > 0 else "-inf"}
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, (int, np.integer)):
        return int(value)
    if value is None or isinstance(value, str):
        return value
    if isinstance(value, np.ndarray):
        return plain(value.tolist())
    if isinstance(value, (list, tuple, deque)):
        return [plain(child) for child in value]
    if isinstance(value, dict):
        return {str(key): plain(child) for key, child in value.items()}
    if isinstance(value, Path):
        return value.name
    if dataclasses.is_dataclass(value):
        return plain(dataclasses.asdict(value))
    raise TypeError(f"No JSON form for {type(value).__name__}")


def outcome(call: Callable[[], Any]) -> dict[str, Any]:
    """Returns what ``call`` returned, under ``ok``, or the class and the message of what it raised, under
    ``error``: the two things PEAR's station reports of a failure."""
    try:
        return {"ok": plain(call())}
    except Exception as error:  # the class is the fixture: the station reports it as the error's code
        return {"error": {"type": type(error).__name__, "message": str(error)}}


class Clock:
    """PEAR's monotonic clock and its sleep while the script runs: time stands still until the script sets ``now``
    or PEAR sleeps, as on the stand-in clock of PEAR's tests (tests/deploy/station/control_rig.py)."""

    def __init__(self) -> None:
        self.now = START_S
        self.slept: list[float] = []  # every sleep since the last reset

    def install(self) -> Clock:
        time.monotonic = self.monotonic
        time.sleep = self.sleep
        return self

    def monotonic(self) -> float:
        return self.now

    def sleep(self, duration_s: float) -> None:
        self.now += duration_s
        self.slept.append(duration_s)


class Commit:
    """The commit of the PEAR this runs in, read from its checkout without running git."""

    @staticmethod
    def of_pear() -> str | None:
        git = PEAR_PACKAGE.parent / ".git"
        head = git / "HEAD"
        if not head.is_file():
            return None
        text = head.read_text().strip()
        if not text.startswith("ref: "):
            return text
        reference = text.removeprefix("ref: ")
        if (git / reference).is_file():
            return (git / reference).read_text().strip()
        packed = git / "packed-refs"
        if packed.is_file():
            for line in packed.read_text().splitlines():
                if line.endswith(" " + reference):
                    return line.split()[0]
        return None

    @staticmethod
    def pinned() -> str:
        return re.search(r'PEAR_COMMIT = "([0-9a-f]{40})"', (REPOSITORY / "src" / "index.ts").read_text()).group(1)


class Fixtures:
    """Writes each fixture file: ASCII only, one case a line where it holds cases, and never a path of this
    machine."""

    directory = FIXTURES  # where the files go: the committed fixtures unless --output names another place
    total_bytes = 0

    @classmethod
    def write(cls, name: str, content: dict[str, Any]) -> None:
        """Writes one file: an object whose lists of cases (a key that ends in ``cases``, ``steps`` or
        ``scenarios``) hold one item a line."""
        cls.directory.mkdir(parents=True, exist_ok=True)
        entries = []
        counts = []
        for key, value in content.items():
            if isinstance(value, list) and key.endswith(("cases", "scenarios", "sequences")):
                rows = ",\n".join("  " + json.dumps(row, ensure_ascii=True, separators=(",", ":")) for row in value)
                entries.append(f' {json.dumps(key)}: [\n{rows}\n ]')
                counts.append(f"{len(value)} {key}")
            else:
                entries.append(f" {json.dumps(key)}: {json.dumps(value, ensure_ascii=True)}")
        text = "{\n" + ",\n".join(entries) + "\n}\n"
        json.loads(text, parse_constant=cls.refuse_constant)  # (raises unless the file is JSON)
        cls.check_private(name, text)
        (cls.directory / name).write_text(text, encoding="ascii", newline="\n")
        cls.total_bytes += len(text)
        print(f"{name}: {len(text)} bytes; {', '.join(counts) or 'no cases'}")

    @staticmethod
    def refuse_constant(name: str) -> None:
        raise ValueError(f"{name} is not JSON")

    @staticmethod
    def check_private(name: str, text: str) -> None:
        """Stops if ``text`` names a place of this machine."""
        places = [str(PEAR_PACKAGE.parent), str(Path.home()), str(REPOSITORY), tempfile.gettempdir() + "/"]
        for place in places:
            if place and place != "/" and place in text:
                sys.exit(f"{name} would hold a path of this machine: {place}")


class Robots:
    """The configurations PEAR's classes run on here: the SO-101's shipped defaults and the stations of PEAR's own
    tests, of the SO-101 and of the two YAM arms. The YAM robot is not ported; its station is here because it is
    PEAR's own layout of two arms, on which PEAR's tests run the same generic classes."""

    def __init__(self) -> None:
        if not (PEAR_STATION_TESTS / "config_files.py").is_file():
            sys.exit("This PEAR has no tests/deploy/station: run from a checkout of PEAR, not an installed package")
        sys.path.insert(0, str(PEAR_STATION_TESTS))
        from config_files import ConfigFiles  # PEAR's own loader of its tests' stations

        quick = ConfigFiles.load("so101", *ConfigFiles.SO101_QUICK_OVERRIDES, *SO101_ARM_TEST_OVERRIDES)
        # each: the layout's name in the fixtures, then the control loop's configuration and the robot's settings
        self.stations: dict[str, tuple[str, ControlConfig, RobotConfig]] = {
            # the package's defaults, a value left ??? read as a placeholder, as BaseRobot.make_configs makes them
            "so101": ("so101", self.shipped_control(), self.so101_from_defaults({})),
            # the SO-101's station of PEAR's tests, as the tests of the control loop load it
            "so101_station": ("so101", *ConfigFiles.load_configs("so101")),
            # the same with the quick settings and the tolerances of the tests of the arm
            "so101_quick": ("so101", *ConfigFiles.make_configs(quick)),
            # both YAM arms with the wide limits of the tests of the control loop, and as their station ships them
            "two_arm": ("two_arm", *ConfigFiles.load_configs("yam", *ConfigFiles.WIDE_LIMITS["yam"])),
            "two_arm_station": ("two_arm", *ConfigFiles.load_configs("yam")),
        }

    def configs(self, key: str) -> tuple[ControlConfig, RobotConfig]:
        """Returns copies of the two configurations of the station ``key``, which a scenario may change."""
        _, control_config, robot_config = self.stations[key]
        return copy.deepcopy(control_config), copy.deepcopy(robot_config)

    @staticmethod
    def shipped_control() -> ControlConfig:
        """Returns the control loop's configuration every station starts from."""
        shared = OmegaConf.load(BaseRobot.STATION_CONFIG_PATH)
        return OmegaConf.to_object(OmegaConf.merge(OmegaConf.structured(ControlConfig), shared.control))

    @staticmethod
    def so101_from_defaults(patch: dict[str, Any]) -> SO101Config:
        """Returns the SO-101's settings a station has when its own file gives only ``patch`` (dotted keys under
        ``robot``): the package's defaults under it, and a value still ??? read as its placeholder, as
        ``BaseRobot.make_configs`` makes a robot's settings. Paths stay as the defaults write them."""
        # the station's own file, read over the defaults as BaseRobot.load_config reads it
        own: dict[str, Any] = {}
        for key, value in patch.items():
            *sections, name = key.split(".")
            node = own
            for section in sections:
                node = node.setdefault(section, {})
            node[name] = value
        node = OmegaConf.merge(
            OmegaConf.structured(SO101Config), OmegaConf.load(SO101Robot.CONFIG_PATH).robot, OmegaConf.create(own)
        )
        for key in OmegaConf.missing_keys(node):
            OmegaConf.update(node, key, SO101Config.PLACEHOLDER.format(key=key))

        return OmegaConf.to_object(node)

    @staticmethod
    def settings(robot_config: RobotConfig) -> dict[str, Any]:
        """Returns the settings pear.js makes the same robot from: the SO-101's whole section without the path of
        its description (pear.js has no such setting); of the two arms what every robot's settings hold."""
        if isinstance(robot_config, SO101Config):
            data = plain(dataclasses.asdict(robot_config))
            if data["geometry"] is not None:
                del data["geometry"]["urdf"]
            return data

        home = robot_config.home
        return {
            **{
                name: getattr(robot_config, name)
                for name in (
                    "position_tolerance", "gripper_tolerance", "feedback_position_tolerance", "velocity_tolerance"
                )
            },
            "home": None
            if home is None
            else {
                name: plain(getattr(home, name)) for name in (
                    "speed_scale", "limits", "settle_window_s", "arrival_timeout_s"
                )
            },
            "arm_limits": {
                arm: {
                    name: list(getattr(limits, name))
                    for name in ("velocity", "acceleration", "jerk", "lower_bounds", "upper_bounds", "tracking_error")
                }
                for arm, limits in robot_config.arm_limits().items()
            },
        }

    @staticmethod
    def joint_limits(limits: JointLimits) -> dict[str, Any]:
        return {field.name: plain(getattr(limits, field.name)) for field in dataclasses.fields(limits)}

    def record(self) -> dict[str, Any]:
        """Returns what the fixtures say of every station: its layout, its settings and what PEAR derives of them."""
        stations = {}
        for key, (layout_name, control_config, robot_config) in self.stations.items():
            limits = robot_config.joint_limits()
            stations[key] = {
                "layout": layout_name,
                "control": dataclasses.asdict(control_config),
                "control_period_s": control_config.control_period_s,
                "settings": self.settings(robot_config),
                "joint_limits": self.joint_limits(limits),
                "braking_caps": plain(limits.braking_caps()),
                "motion_caps": limits.motion_caps(),
                "feeds_velocity": {arm: robot_config.feeds_velocity(arm) for arm in robot_config.LAYOUT.arms},
            }

        return stations


class Layouts:
    """PEAR's JointLayout of each station's robot."""

    @staticmethod
    def record(layout: JointLayout) -> dict[str, Any]:
        texts = layout.texts
        return {
            "arms": list(layout.arms),
            "coordinates": list(layout.coordinates),
            "texts": {name: plain(getattr(texts, name)) for name in texts.__dataclass_fields__},
            "coordinate_count": layout.coordinate_count,
            "joint_count": layout.joint_count,
            "vector_length": layout.vector_length,
            "gripper_indices": list(layout.gripper_indices),
        }

    @staticmethod
    def cases(name: str, layout: JointLayout, generator: random.Random) -> list[dict[str, Any]]:
        """Returns calls of every method of the layout ``name``."""
        length, width = layout.vector_length, layout.coordinate_count
        cases: list[dict[str, Any]] = []

        def add(method: str, call: Callable[[], Any], **arguments: Any) -> None:
            cases.append({"layout": name, "method": method, **plain(arguments), "outcome": outcome(call)})

        vectors = [
            [float(index) for index in range(length)], [round(generator.uniform(-2, 2), 3) for _ in range(length)]
        ]
        vectors += [vectors[0][:-1], vectors[0] + [9.0], [], [1.5]]
        for vector in vectors:
            add("split", lambda vector=vector: layout.split(vector), vector=vector)
        for vector in vectors[:2]:
            parts = layout.split(vector)
            add("join", lambda parts=parts: layout.join(parts), arm_values=parts)
            backwards = dict(reversed(list(parts.items())))
            add("join", lambda backwards=backwards: layout.join(backwards), arm_values=backwards)
        for arm in layout.arms:
            for index in range(width):
                labels = layout.arm_axis_labels(arm, index)
                add(
                    "arm_axis_labels",
                    lambda arm=arm, index=index: layout.arm_axis_labels(arm, index),
                    arm=arm,
                    index=index,
                )
                add("axis_name", lambda labels=labels: JointLayout.axis_name(labels), labels=labels)
        for labels in (
            {},
            {"joint": "J1"},
            {"side": "left"},
            {"joint": "J1", "side": "left"},
            {"metric": "x", "joint": "elbow_flex", "value": 1.0},
        ):
            add("axis_name", lambda labels=labels: JointLayout.axis_name(labels), labels=labels)
        for index in range(2 * length + 1):
            add("axis_unit", lambda index=index: layout.axis_unit(index), index=index)

        good = [round(generator.uniform(-1, 1), 3) for _ in range(length)]
        bad_vectors: list[list[Any]] = [good, good[:-1], good + [0.0], [], [0] * length, [1] * length]
        for value in (math.nan, math.inf, -math.inf):
            for index in (0, length - 1):
                bad_vectors.append([*good[:index], value, *good[index + 1 :]])
        for vector in bad_vectors:
            add("vector", lambda vector=vector: layout.vector(vector), values=vector)
            arm_values = vector[:width] if len(vector) >= width else vector
            add("arm_vector", lambda arm_values=arm_values: layout.arm_vector(arm_values), values=arm_values)
        for arm_values in (good[:width], [0.25], [1.0, 2.0]):
            add(
                "joint_values",
                lambda arm_values=arm_values: JointLayout.joint_values(arm_values),
                arm_values=arm_values,
            )
            add(
                "gripper_value",
                lambda arm_values=arm_values: JointLayout.gripper_value(arm_values),
                arm_values=arm_values,
            )
            add(
                "with_gripper",
                lambda arm_values=arm_values: JointLayout.with_gripper(arm_values, 0.75),
                arm_values=arm_values,
                gripper_value=0.75,
            )

        return cases


class Edge:
    """Finds where an answer of PEAR's changes, by asking PEAR."""

    @staticmethod
    def of(accepts: Callable[[float], bool], inside: float, outside: float) -> tuple[float, float]:
        """Returns the two neighbouring doubles between ``inside``, which PEAR accepts, and ``outside``, which it
        refuses, at which its answer changes: the last it accepts and the first it refuses."""
        if not accepts(inside) or accepts(outside):
            raise AssertionError("The two ends of a search for an edge must be accepted and refused")
        while True:
            middle = inside + (outside - inside) / 2
            if middle in (inside, outside):
                return inside, outside
            if accepts(middle):
                inside = middle
            else:
                outside = middle


class LimitCases:
    """Calls of every method of PEAR's JointLimits on one station's limits."""

    PAST = (1e-10, 1e-8, 0.001, 0.01, 0.0199, 0.02, 0.0200001, 0.05, 0.0599, 0.06, 0.0600001, 0.07, 0.5)

    def __init__(self, key: str, robot_config: RobotConfig, generator: random.Random) -> None:
        self.key, self.config, self.generator = key, robot_config, generator
        self.layout = robot_config.LAYOUT
        self.limits = robot_config.joint_limits()
        self.lower, self.upper = list(self.limits.lower_bounds), list(self.limits.upper_bounds)
        self.length = len(self.lower)
        # the coordinates whose edges are searched: every one of a single arm, the first joint and the gripper of each
        # of several
        width = self.layout.coordinate_count
        ends = [index for index in range(self.length) if index % width in (0, width - 1)]
        self.edge_indices = list(range(width)) if len(self.layout.arms) == 1 else ends
        self.cases: list[dict[str, Any]] = []

    def add(self, method: str, call: Callable[[], Any], **arguments: Any) -> None:
        self.cases.append({"station": self.key, "method": method, **plain(arguments), "outcome": outcome(call)})

    def inside(self) -> list[float]:
        """Returns a joint vector within the bounds."""
        return [
            min(max(round(self.generator.uniform(lower, upper), 4), lower), upper)
            for lower, upper in zip(self.lower, self.upper)
        ]

    def middle(self) -> list[float]:
        return [(lower + upper) / 2 for lower, upper in zip(self.lower, self.upper)]

    def pushed(self, vector: list[float], most: int) -> list[float]:
        """Returns ``vector`` with up to ``most`` coordinates moved past a bound."""
        vector = list(vector)
        for index in self.generator.sample(range(self.length), self.generator.randint(0, most)):
            past = self.generator.choice(self.PAST)
            vector[index] = self.upper[index] + past if self.generator.random() < 0.5 else self.lower[index] - past
        return vector

    def malformed(self) -> list[list[Any]]:
        """Returns joint vectors that are none."""
        good = self.inside()
        vectors: list[list[Any]] = [good[:-1], good + [0.0], [], [0.0]]
        for value in (math.nan, math.inf, -math.inf):
            index = self.generator.randrange(self.length)
            vectors.append([*good[:index], value, *good[index + 1 :]])
        return vectors

    def from_pear_tests(self) -> None:
        """Calls the limits with what PEAR's own tests call them with
        (tests/deploy/station/test_joint_control_in_station.py), on this station's layout."""
        limits, layout = self.limits, self.layout
        width = layout.coordinate_count
        rest = self.middle()  # (the tests' resting vector: the middle of each coordinate's range)

        def positions(vector: list[float], tolerance: float | None = None) -> None:
            if tolerance is None:
                self.add("check_positions", lambda: limits.check_positions(vector, layout), vector=vector)
            else:
                self.add(
                    "check_positions",
                    lambda: limits.check_positions(vector, layout, tolerance),
                    vector=vector,
                    tolerance=tolerance,
                )

        def command(target: list[float], previous: list[float]) -> None:
            self.add(
                "check_command",
                lambda: limits.check_command(target, previous, layout),
                target=target,
                previous_target=previous,
            )

        # positions outside the bounds are named
        positions([*rest[:2], limits.lower_bounds[2] - 0.15, *rest[3:]], 0.02)
        # a command outside a limit moves only inward
        previous = [rest[0], limits.lower_bounds[1] - 0.03, *rest[2:]]
        command(previous, previous)
        command([previous[0], previous[1] + 0.01, *previous[2:]], previous)
        command([previous[0], previous[1] - 0.01, *previous[2:]], previous)
        # the joint of a command past a bound is named
        command([limits.upper_bounds[0] + 0.1, *rest[1:]], rest)
        # the feedback tolerance accepts a folded arm, which rests past its second joint's lower limit, and its
        # commands may stay out or move in but not further out
        folded = [0.0, limits.lower_bounds[1] - 0.03, *[0.0] * (self.length - 2)]
        positions(folded)
        positions(folded, self.config.feedback_position_tolerance)
        command(folded, folded)
        command([folded[0], folded[1] + 0.01, *folded[2:]], folded)
        command([folded[0], folded[1] - 0.01, *folded[2:]], folded)
        # the feedback tolerance does not relax the bounds of an action
        read = [0.0, -0.0005, *[0.0] * (width - 3), 1.003] * len(layout.arms)
        positions(read)
        positions(read, limits.feedback_tolerance)
        positions([*read[: width - 1], 1.1, *read[width:]], limits.feedback_tolerance)
        # a bounds error names the axis, the value and the allowance
        targets = [*[0.0] * (width - 1), 0.5] * len(layout.arms)
        positions([*targets[:2], -0.15, *targets[3 : width - 1], 1.237412, *targets[width:]], 0.02)

    def positions(self, count: int) -> None:
        limits, layout = self.limits, self.layout
        tolerances = [0.0, limits.feedback_tolerance, 0.02]

        def check(vector: list[float], tolerance: float) -> None:
            self.add(
                "check_positions",
                lambda: limits.check_positions(vector, layout, tolerance),
                vector=vector,
                tolerance=tolerance,
            )

        def accepts(vector: list[float], tolerance: float) -> bool:
            try:
                limits.check_positions(vector, layout, tolerance)
            except ValueError:
                return False
            return True

        base = self.middle()
        for tolerance in tolerances:
            for index in self.edge_indices:
                for bound, side in ((self.lower[index], -1.0), (self.upper[index], 1.0)):
                    def with_value(value: float, index: int = index) -> list[float]:
                        return [*base[:index], value, *base[index + 1 :]]

                    edge = Edge.of(
                        lambda value: accepts(with_value(value), tolerance), bound, bound + side * (tolerance + 0.001)
                    )
                    for value in edge:
                        check(with_value(value), tolerance)
        for _ in range(count):
            check(self.pushed(self.inside(), 4), self.generator.choice(tolerances))
        for vector in self.malformed():
            check(vector, limits.feedback_tolerance)
        # values whose seventh decimal is an exact 5, which Python words to the even digit
        for sign in (1.0, -1.0):
            tie = [sign * (math.ceil(abs(bound)) + 1 + 1 / 128) for bound in self.upper]
            check(tie, 0.0)
            check([*base[:-1], sign * 1.5078125], 0.0)
        check([-0.0] * self.length, 0.0)
        with_default = self.pushed(self.inside(), 2)
        self.add("check_positions", lambda: limits.check_positions(with_default, layout), vector=with_default)

    def commands(self, count: int) -> None:
        limits, layout = self.limits, self.layout

        def check(target: list[float], previous: list[float]) -> None:
            self.add(
                "check_command",
                lambda: limits.check_command(target, previous, layout),
                target=target,
                previous_target=previous,
            )

        def accepts(target: list[float], previous: list[float]) -> bool:
            try:
                limits.check_command(target, previous, layout)
            except ValueError:
                return False
            return True

        base = self.middle()
        for index in self.edge_indices:
            for bound, side in ((self.lower[index], -1.0), (self.upper[index], 1.0)):
                def with_value(value: float, index: int = index) -> list[float]:
                    return [*base[:index], value, *base[index + 1 :]]

                # from inside the bounds, and from rest past the bound, where only inward moves pass
                for start in (base[index], bound + side * 0.03):
                    previous = with_value(start)
                    edge = Edge.of(
                        lambda value: accepts(with_value(value), previous),
                        start,
                        start + side * (abs(start - bound) + 0.01) if start == base[index] else start + side * 0.01,
                    )
                    for value in edge:
                        check(with_value(value), previous)
        steps = (0.0, 0.0, 0.01, -0.01, 0.05, -0.05, 1e-9, -1e-9, 2e-9, -2e-9)
        for _ in range(count):
            previous = self.pushed(self.inside(), 2)
            target = [value + self.generator.choice(steps) for value in previous]
            if self.generator.random() < 0.3:
                target = self.pushed(self.inside(), 2)
            check(target, previous)
        good = self.inside()
        for vector in self.malformed():
            check(vector, good)
            check(good, vector)

    def bounds(self, count: int) -> None:
        limits = self.limits

        def record(start: list[float]) -> None:
            self.add("bounds", lambda: limits.bounds(start), start=start)

        for _ in range(count):
            record(self.pushed(self.inside(), 3))
        record(list(self.lower))
        record(list(self.upper))
        # a start that equals a bound of zero with the other sign: numpy returns the start
        record([-0.0 if bound == 0 else bound for bound in self.lower])
        record([0.0] * self.length)
        record([-0.0] * self.length)
        for vector in self.malformed():
            record(vector)

    def trajectories(self, count: int) -> None:
        limits = self.limits

        def check(extrema: list[tuple[float, float]], start: list[float]) -> None:
            trajectory = SimpleNamespace(position_extrema=[SimpleNamespace(min=low, max=high) for low, high in extrema])
            self.add(
                "check_trajectory",
                lambda: limits.check_trajectory(trajectory, start),
                position_extrema=[{"min": low, "max": high} for low, high in extrema],
                start=start,
            )

        def accepts(extrema: list[tuple[float, float]], start: list[float]) -> bool:
            trajectory = SimpleNamespace(position_extrema=[SimpleNamespace(min=low, max=high) for low, high in extrema])
            try:
                limits.check_trajectory(trajectory, start)
            except ValueError:
                return False
            return True

        base = self.middle()
        resting = [(value, value) for value in base]
        for index in self.edge_indices:
            for bound, side in ((self.lower[index], -1.0), (self.upper[index], 1.0)):
                def with_extremum(value: float, index: int = index, side: float = side) -> list[tuple[float, float]]:
                    pair = (value, base[index]) if side < 0 else (base[index], value)
                    return [*resting[:index], pair, *resting[index + 1 :]]

                for value in Edge.of(lambda value: accepts(with_extremum(value), base), bound, bound + side * 0.001):
                    check(with_extremum(value), base)
        for _ in range(count):
            start = self.pushed(self.inside(), 1)
            goal = self.pushed(self.inside(), 2) if self.generator.random() < 0.5 else self.inside()
            extrema = [(min(first, second), max(first, second)) for first, second in zip(start, goal)]
            if self.generator.random() < 0.3:
                index = self.generator.randrange(self.length)
                low, high = extrema[index]
                extrema[index] = (low - self.generator.choice(self.PAST), high + self.generator.choice(self.PAST))
            check(extrema, start)
        check(resting[:-1], base)
        check(resting + [(-99.0, 99.0)], base)
        check([], base)
        outside = [(low - 9, high + 9) for low, high in resting]
        check(outside, base[:-1])
        check(outside, [0.25])
        check(outside, [])

    def motion_caps(self, count: int) -> None:
        limits = self.limits
        width = self.layout.coordinate_count
        home = self.config.home
        one_arm = lambda value: [value] * width  # noqa: E731  (one arm's caps, for every arm)
        caps_choices: list[Any] = [
            None,
            SimpleNamespace(velocity=one_arm(1e-3), acceleration=one_arm(1e3), jerk=one_arm(1e3)),
            SimpleNamespace(velocity=[0.05, 0.4, 3.0], acceleration=[0.7], jerk=[4.0, 50.0]),
            SimpleNamespace(velocity=one_arm(0.3), acceleration=None, jerk=one_arm(7.0)),
            SimpleNamespace(velocity=[math.nan, 0.2], acceleration=[math.inf], jerk=[-1.0, 5.0]),
        ]
        if home is not None and home.limits is not None:
            caps_choices.append(home.limits)
        scales = [1.0, 0.5, 0.25, 1 / 3, 0.1, 0.75, 0.2, 2 / 3, 0.001, 1e-9, 5e-324, 2.2250738585072014e-308]
        if home is not None:
            scales.append(home.speed_scale)
        scales += [self.generator.random() for _ in range(count)]
        scales += [round(self.generator.uniform(0.01, 1.0), 2) for _ in range(count)]

        def record(scale: float, caps: Any) -> None:
            arguments: dict[str, Any] = {"speed_scale": scale, "powers": [scale**order for order in (1, 2, 3)]}
            if caps is not None:
                arguments["caps"] = {name: getattr(caps, name) for name in JointLimits.CAP_NAMES}
            self.add("motion_caps", lambda: limits.motion_caps(scale, caps), **arguments)

        for index, scale in enumerate(scales):
            record(scale, caps_choices[index % len(caps_choices)])
        for caps in caps_choices:
            record(0.5, caps)
        for scale in (0.0, -0.0, -0.5, 1.0000000000000002, 1.5, math.nan, math.inf, -math.inf):
            self.add("motion_caps", lambda scale=scale: limits.motion_caps(scale), speed_scale=scale)
        self.add("motion_caps", lambda: limits.motion_caps())
        self.add("braking_caps", lambda: limits.braking_caps())

    @classmethod
    def all(cls, robots: Robots, generator: random.Random, scale: int) -> list[dict[str, Any]]:
        cases: list[dict[str, Any]] = []
        for key, count in (("so101", 40), ("so101_quick", 8), ("two_arm", 10), ("two_arm_station", 8)):
            station = cls(key, robots.configs(key)[1], generator)
            station.from_pear_tests()
            station.positions(count * scale)
            station.commands(count * scale)
            station.bounds(count * scale // 3)
            station.trajectories(count * scale // 2)
            station.motion_caps(count * scale // 4)
            cases += station.cases

        return cases

    @staticmethod
    def powers(generator: random.Random, count: int) -> list[list[Any]]:
        """Returns speed scales with their square and their cube as Python computes them (the C library's ``pow``)
        and as they are exactly, rounded once: what shows how far PEAR's own caps are from the exact ones."""
        scales = [1.0, 0.5, 0.25, 1 / 3, 0.1, 0.75, 0.2, 2 / 3, 0.001, 1e-9, 5e-324, 2.2250738585072014e-308, 1e-150]
        scales += [generator.random() for _ in range(count)]
        scales += [round(generator.uniform(0.01, 1.0), 2) for _ in range(count // 4)]

        return [
            [scale, scale**2, scale**3, float(Fraction(scale) ** 2), float(Fraction(scale) ** 3)] for scale in scales
        ]


class ConfigCases:
    """PEAR's configuration classes, made with settings that are valid and with settings that are not."""

    # values tried in every number of a section: around every bound PEAR's sections name, and what is no number
    FLOATS = (
        0.0, -0.0, -1.0, 1e-12, -0.2, -0.2000001, 0.2, 0.2000001, 0.05, 0.0500001, 0.1, 0.1000001, 0.3, 0.3000001,
        0.01, 0.0100001, 1.0, 1.0000001, 5.0, 5.0000001, 100.0, 100.0000001, math.pi,
        math.nextafter(math.pi, 4.0), 1e9, math.nan, math.inf, -math.inf,
    )  # fmt: skip
    INTEGERS = (-1, 0, 1, 2, 7, 8, 9, 10, 64, 65, 100, 101, 2000, 2001)
    INTEGER_FIELDS = ("status_poll_ticks", "position_p_coefficient", "width", "height", "fps", "ik_iterations")

    def __init__(self, generator: random.Random) -> None:
        self.generator = generator
        self.defaults = plain(OmegaConf.to_container(OmegaConf.load(SO101Robot.CONFIG_PATH).robot))
        limits = self.defaults["limits"]
        self.sections: dict[str, tuple[type, dict[str, Any]]] = {
            "ControlConfig": (ControlConfig, dataclasses.asdict(Robots.shipped_control())),
            "MotionLimits": (MotionLimits, {name: limits[name] for name in ("velocity", "acceleration", "jerk")}),
            "Limits": (Limits, {name: value for name, value in limits.items() if not name.startswith("stop_")}),
            "HomeConfig": (
                HomeConfig, {"speed_scale": 0.5, "limits": None, "settle_window_s": 0.5, "arrival_timeout_s": 20.0}
            ),
            "SO101Limits": (SO101Limits, dict(limits)),
            "HardwareConfig": (HardwareConfig, {**self.defaults["hardware"], "port": "<hardware.port>"}),
            "CameraConfig": (CameraConfig, {**self.defaults["camera"], "path": "<camera.path>"}),
            "KinematicsConfig": (KinematicsConfig, dict(self.defaults["geometry"])),
            "SO101HomeConfig": (SO101HomeConfig, {**self.defaults["home"], "limits": None}),
            "FeedforwardConfig": (FeedforwardConfig, dict(self.defaults["feedforward"])),
        }

    @staticmethod
    def made(section_class: type, settings: dict[str, Any]) -> Any:
        """Makes the section from ``settings``, a section inside it first, as OmegaConf makes them."""
        settings = dict(settings)
        if isinstance(settings.get("limits"), dict) and section_class in (HomeConfig, SO101HomeConfig):
            settings["limits"] = MotionLimits(**settings["limits"])
        return section_class(**settings)

    def section_cases(self) -> list[dict[str, Any]]:
        """Returns each section made with one of its values changed, and with two, and what PEAR answered."""
        cases: list[dict[str, Any]] = []

        def add(name: str, changes: dict[str, Any]) -> None:
            section_class, base = self.sections[name]
            settings = {**copy.deepcopy(base), **changes}

            def describe() -> Any:
                section = self.made(section_class, settings)
                described: dict[str, Any] = {}
                if not changes:
                    described["fields"] = [field.name for field in dataclasses.fields(section)]
                if isinstance(section, ControlConfig):
                    described["control_period_s"] = section.control_period_s
                if isinstance(section, Limits) and (
                    not changes or any(key.startswith(("stop_", "acceleration", "jerk")) for key in changes)
                ):
                    described["braking_caps"] = section.braking_caps()
                return described

            cases.append({"section": name, "changes": plain(changes), "outcome": outcome(describe)})

        # the fields a section has from the section it extends, which are tried in full there and thinly here
        inherited = {
            "SO101Limits": self.sections["Limits"][1],
            "SO101HomeConfig": self.sections["HomeConfig"][1],
            "Limits": self.sections["MotionLimits"][1],
        }
        for name, (_, base) in self.sections.items():
            add(name, {})
            for field, value in base.items():
                floats = self.FLOATS[::4] if field in inherited.get(name, {}) else self.FLOATS
                if isinstance(value, list):
                    # every candidate as the list's last value, every third as its first
                    for candidate in floats:
                        add(name, {field: [*value[:-1], candidate]})
                    for candidate in floats[::3]:
                        add(name, {field: [candidate, *value[1:]]})
                    for changed in (value[:-1], value + [value[-1]], [], value[:1]):
                        add(name, {field: changed})
                elif isinstance(value, bool) or value is None or isinstance(value, str):
                    continue
                else:
                    for candidate in self.INTEGERS if field in self.INTEGER_FIELDS else floats:
                        add(name, {field: candidate})

        # what a section may leave unset, and what only one section checks
        add("SO101Limits", {"stop_acceleration": None})
        add("SO101Limits", {"stop_jerk": None, "stop_acceleration": None})
        add("SO101Limits", {"stop_acceleration": []})
        add("SO101Limits", {"stop_acceleration": [2.0], "stop_jerk": [60.0] * 9})
        add("SO101Limits", {"stop_jerk": [9.999999] * 6})
        add("SO101Limits", {"stop_acceleration": [2.0] * 6, "stop_jerk": [10.0] * 6})
        add("Limits", {"lower_bounds": [0.0] * 3, "upper_bounds": [1.0] * 6})
        add("Limits", {"lower_bounds": [0.0, 2.0], "upper_bounds": [1.0, 2.0]})
        add("CameraConfig", {"role": "top"})
        add("CameraConfig", {"role": ""})
        add("CameraConfig", {"fourcc": None})
        add("KinematicsConfig", {"gripper_width_cm": [0.0, 0.0]})
        add("KinematicsConfig", {"gripper_width_cm": [-0.1, 6.0]})
        add("KinematicsConfig", {"gripper_width_cm": [6.0, 0.0]})
        add("KinematicsConfig", {"gripper_width_cm": [1.5, 1.5000001]})
        add("HomeConfig", {"limits": {"velocity": [1.0], "acceleration": [1.0], "jerk": [1.0]}})
        add("HomeConfig", {"limits": {"velocity": [1.0], "acceleration": [0.0], "jerk": [1.0]}})
        add("HomeConfig", {"limits": {"velocity": [math.inf], "acceleration": [1.0], "jerk": [1.0]}})
        add("SO101HomeConfig", {"limits": {"velocity": [0.3] * 6, "acceleration": [0.6] * 6, "jerk": [2.0] * 6}})
        add("ControlConfig", {"settle_window_s": 3.0})
        add("ControlConfig", {"settle_window_s": 2.9999999})
        add("ControlConfig", {"settle_window_s": 4.0, "settle_timeout_s": 4.0})
        add("ControlConfig", {"settle_timeout_s": 0.5})
        # two values wrong at once: the first check that fails speaks
        for name, (_, base) in self.sections.items():
            numbers = [
                field
                for field, value in base.items()
                if isinstance(value, (int, float, list)) and not isinstance(value, bool)
            ]
            for _ in range(6):
                if len(numbers) < 2:
                    break
                changes = {}
                for field in self.generator.sample(numbers, 2):
                    candidates = self.INTEGERS if field in self.INTEGER_FIELDS else self.FLOATS
                    value = base[field]
                    changes[field] = [
                        self.generator.choice(candidates)
                    ] * len(value) if isinstance(value, list) else self.generator.choice(candidates)
                add(name, changes)

        return cases

    def robot_cases(self, directory: Path) -> list[dict[str, Any]]:
        """Returns the SO-101's settings made from the shipped defaults with a station's own values over them, as
        PEAR's robot makes them, and what PEAR answered: its refusal, or what it derives of the settings."""
        cases: list[dict[str, Any]] = []
        # the station's own file is in ``directory``; its calibration, when it has one, is beside it
        os.chdir(directory)
        calibration = directory / self.defaults["hardware"][
            "calibration_dir"
        ] / f"{self.defaults['hardware']['calibration_id']}.json"
        calibration.parent.mkdir()

        def add(patch: dict[str, Any], *, has_calibration: bool = True, full: bool = False) -> None:
            if has_calibration:
                calibration.write_text("{}")
            elif calibration.exists():
                calibration.unlink()

            def describe() -> Any:
                config = Robots.so101_from_defaults(patch)
                described: dict[str, Any] = {
                    "motion_blockers": config.motion_blockers(),
                    "first_placeholder": config.first_placeholder(),
                    "require_commissioned": outcome(config.require_commissioned),
                    "joint_limits": Robots.joint_limits(config.joint_limits()),
                    "arm_limits": list(config.arm_limits()),
                }
                if full:
                    described["settings"] = Robots.settings(config)
                return described

            answer = outcome(describe)
            if answer.get("error", {}).get("type", "ValueError") != "ValueError":
                # OmegaConf refused the patch before PEAR's classes saw it: that is not a case of theirs
                raise AssertionError(f"{patch}: {answer['error']}")
            cases.append({"patch": plain(patch), "has_calibration": has_calibration, "outcome": answer})

        station = {"hardware.port": "COM7", "camera.path": "wrist"}  # what a station's own file gives of the devices
        add({}, full=True)
        add({}, has_calibration=False)
        add(station, full=True)
        add(station, has_calibration=False)
        add({"hardware.port": "COM7"})
        add({"camera.path": "wrist"}, has_calibration=False)
        add({**station, "hardware.calibration_id": "it's \"mine\""}, has_calibration=False)
        add({**station, "hardware.calibration_id": "bench's"}, has_calibration=False)
        add({**station, "hardware.calibration_id": "<calibration>"})
        add({**station, "hardware.calibration_dir": "<somewhere>"})
        add({**station, "camera.fourcc": "<auto>"})
        for section in ("hardware", "camera", "geometry", "home", "feedforward"):
            add({**station, section: None}, full=True)
        add(
            {**station, "hardware": None, "camera": None, "home": None, "feedforward": None, "geometry": None},
            full=True,
        )
        add({**station, "geometry": None, "feedforward": None})
        add({**station, "limits.stop_acceleration": None, "limits.stop_jerk": None}, full=True)
        add({**station, "limits.stop_acceleration": None})
        add(
            {**station, "home.limits": {"velocity": [0.3] * 6, "acceleration": [0.6] * 6, "jerk": [2.0] * 6}}, full=True
        )
        add({**station, "home.limits": {"velocity": [0.3] * 5, "acceleration": [0.6] * 6, "jerk": [2.0] * 6}})
        add({**station, "home.limits": {"velocity": [0.3] * 6, "acceleration": [0.6] * 6, "jerk": [2.0] * 7}})
        add({**station, "home.limits": {"velocity": [0.3] * 6, "acceleration": [-0.6] * 6, "jerk": [2.0] * 6}})

        limits, home = self.defaults["limits"], self.defaults["home"]
        for name in (
            "lower_bounds",
            "upper_bounds",
            "velocity",
            "acceleration",
            "jerk",
            "tracking_error",
            "stop_acceleration",
            "stop_jerk",
        ):
            add({**station, f"limits.{name}": limits[name][:-1]})
            add({**station, f"limits.{name}": limits[name] + [limits[name][-1]]})
        for opening in (-0.0, -1e-9, -0.1, 0.5, 1.0):
            add({**station, "limits.lower_bounds": [*limits["lower_bounds"][:-1], opening]})
        for opening in (1.0000001, 1.5, 0.5, 0.0):
            add({**station, "limits.upper_bounds": [*limits["upper_bounds"][:-1], opening]})
        for tolerance in (0.2, 0.2000001, 0.5, 0.0, -0.1, 1e-9):
            add({**station, "feedback_position_tolerance": tolerance})
        for name in ("position_tolerance", "gripper_tolerance", "velocity_tolerance"):
            for value in (0.0, -0.01, 1e-9, 0.2, 0.2000001, 5.0, math.nan, math.inf):
                add({**station, name: value})
        for index in range(VECTOR_LENGTH):
            for value in (
                limits["lower_bounds"][index],
                math.nextafter(limits["lower_bounds"][index], -9.0),
                limits["upper_bounds"][index],
                math.nextafter(limits["upper_bounds"][index], 9.0),
            ):
                add({**station, "home.position": [*home["position"][:index], value, *home["position"][index + 1 :]]})
        add({**station, "home.position": home["position"][:-1]})
        add({**station, "home.joint_tolerance": [0.035] * 6})
        # several things wrong at once: the sections are made in the order of the settings, then the robot's own
        wrong = {
            "home.speed_scale": 2.0,
            "hardware.status_poll_ticks": 1,
            "camera.role": "top",
            "geometry.ik_iterations": 1,
            "limits.velocity": [0.0, 1.0, 1.0, 1.0, 1.0, 1.0],
            "feedforward.gravity_compliance": [1.0, 0.0, 0.0, 0.0, 0.0],
            "position_tolerance": -1.0,
            "velocity_tolerance": math.nan,
            "feedback_position_tolerance": 0.5,
            "home.position": [0.0, -3.0, 0.0, 0.0, 0.0, 1.0],
            "limits.lower_bounds": [-1.0, -1.0, -1.0, -1.0, -1.0, -0.5],
        }
        keys = list(wrong)
        for first in range(len(keys)):
            for second in range(first + 1, len(keys)):
                add({**station, keys[first]: wrong[keys[first]], keys[second]: wrong[keys[second]]})
        for _ in range(12):
            chosen = self.generator.sample(keys, 3)
            if len({key.split(".")[0] for key in chosen}) == 3:
                add({**station, **{key: wrong[key] for key in chosen}})
        os.chdir(REPOSITORY)

        return cases

    @staticmethod
    def placeholder_cases() -> list[dict[str, Any]]:
        values: list[tuple[Any, str]] = [
            ("<hardware.port>", "hardware.port"),
            ("<x>", ""),
            ("plain", "key"),
            ("<", "key"),
            ("<>", "key"),
            ("<open", "key"),
            ("closed>", "key"),
            ("", "key"),
            (5, "key"),
            (None, "key"),
            (2.5, ""),
            ({"a": {"b": "<p>"}, "c": "<q>"}, ""),
            ({"a": {"b": "p"}, "c": ["x", "<q>", "<r>"]}, "top"),
            ({"a": ["x", {"b": "<deep>"}]}, ""),
            (["<first>", "<second>"], ""),
            ([[], {}, [["<nested>"]]], "list"),
            ({"a": 1, "b": None, "c": [1, 2, 3]}, ""),
            ({"": "<empty key>"}, ""),
            ({"a": {"": "<empty child>"}}, ""),
        ]
        return [
            {
                "value": plain(value),
                "key": key,
                "outcome": outcome(lambda value=value, key=key: RobotConfig.placeholder_key(value, key)),
            }
            for value, key in values
        ]

    @staticmethod
    def repr_cases() -> list[dict[str, Any]]:
        """Returns how Python words a text in a message with ``!r``, and a bound of a range."""
        texts = [
            "so101_follower", "wrist", "", "it's", 'say "hi"', "it's \"both\"", "back\\slash", "tab\there",
            "line\nbreak",
            "return\rhere", "\x00\x01\x1f\x7f", "café", "手臂", "nb sp", "​ zero width", "  line",
            "\U0001f916", "\ud800 lone", "\x80\x9f\xad", "﻿ bom", "　 wide space",
        ]  # fmt: skip
        numbers = [0, 1, 5, 100, 2000, -0.2, 0.2, 0.01, 0.05, 0.1, 0.3, math.pi, 64, 8, 10, 2]
        return [{"text": text, "repr": repr(text)} for text in texts] + [
            {"number": number, "str": str(number)} for number in numbers
        ]


class StabilityScenarios:
    """Sequences of snapshots fed to PEAR's StabilityWindow, with what it answered after each."""

    def __init__(self, robots: Robots, clock: Clock, generator: random.Random) -> None:
        self.robots, self.clock, self.generator = robots, clock, generator
        self.scenarios: list[dict[str, Any]] = []

    def run(
        self,
        name: str,
        station: str,
        ops: list[dict[str, Any]],
        *,
        control: dict[str, float] | None = None,
        robot: dict[str, float] | None = None,
        duration_s: float | None = None,
        is_strict: bool = False,
        checks_velocity_rms: bool = False,
        keeps_all_metrics: bool = True,
    ) -> None:
        """Feeds ``ops`` to a window of ``station`` and keeps what PEAR answered: what every step returned or
        raised and the window's span and sample count after it; the whole metrics after every step, or where
        ``keeps_all_metrics`` is false after the steps whose answer changed, every sixteenth one and the last."""
        control_config, robot_config = self.robots.configs(station)
        control_config = dataclasses.replace(control_config, **(control or {}))
        for field, value in (robot or {}).items():
            setattr(robot_config, field, value)
        duration_s = control_config.settle_window_s if duration_s is None else duration_s
        window = StabilityWindow(
            control_config,
            robot_config,
            duration_s=duration_s,
            is_strict=is_strict,
            checks_velocity_rms=checks_velocity_rms,
        )

        steps = []
        previous: Any = None
        for index, op in enumerate(ops):
            step = {key: value for key, value in op.items() if key != "arms"}
            kind = op["op"]
            if "now" in op:
                self.clock.now = op["now"]
            if kind in ("add", "check_hold"):
                snapshot = {"arms": op["arms"]}
                step.update(self.packed(op["arms"], op["now"], robot_config.LAYOUT.coordinate_count))
                step["outcome"] = outcome(lambda: getattr(window, kind)(snapshot))
                if keeps_all_metrics or index % 16 == 0 or step["outcome"] != previous or index == len(ops) - 1:
                    step["metrics"] = window.metrics
                else:
                    step["brief"] = [window.metrics.get("window_seconds"), window.metrics.get("samples")]
                previous = step["outcome"]
            elif kind == "evaluate":
                step["outcome"] = outcome(lambda: window.evaluate(**op["criteria"]))
            elif kind == "reset":
                window.reset()
                step["metrics"] = window.metrics
            elif kind == "relax":
                window.relax(op["duration_s"])
            elif kind == "stability_error":
                error = window.stability_error(op["reason"])
                step["outcome"] = {"type": type(error).__name__, "message": str(error), "details": error.details}
            elif kind == "set":
                for field, value in op["robot"].items():
                    setattr(robot_config, field, value)
            else:
                raise AssertionError(kind)
            steps.append(plain(step))

        self.scenarios.append(
            {
                "name": name,
                "station": station,
                "control": dataclasses.asdict(control_config),
                "robot": plain(robot or {}),
                "window": {
                    "duration_s": duration_s, "is_strict": is_strict, "checks_velocity_rms": checks_velocity_rms
                },
                "steps": steps,
            }
        )

    @staticmethod
    def packed(arms: dict[str, dict[str, Any]], now: float, width: int) -> dict[str, Any]:
        """Returns the feedback of a step as the fixture holds it, which says the same in fewer bytes: a position or
        a velocity whose ``width`` values are one value is that value, a stamp that is the step's ``now`` is left
        out, and arms whose feedback is the same share it under ``all``."""

        def pack(feedback: dict[str, Any]) -> dict[str, Any]:
            packed = dict(feedback)
            for name in ("position", "velocity"):
                values = packed[name]
                if len(values) == width and all(
                    repr(float(value)) == repr(float(values[0])) and math.isfinite(value) for value in values
                ):
                    packed[name] = values[0]
            if packed["sampled_monotonic_s"] == now:
                del packed["sampled_monotonic_s"]
            return packed

        packed_arms = {arm: pack(feedback) for arm, feedback in arms.items()}
        texts = {json.dumps(plain(feedback), sort_keys=True) for feedback in packed_arms.values()}
        if len(packed_arms) > 1 and len(texts) == 1:
            return {"all": next(iter(packed_arms.values()))}
        return {"arms": packed_arms}

    # the feedback of PEAR's tests (tests/deploy/station/test_stability_in_station.py)

    @staticmethod
    def fed(
        layout: JointLayout,
        sampled_at: float,
        *,
        sample_id: Any = None,
        velocity: Sequence[float] | None = None,
        offset: float = 0.0,
    ) -> dict[str, Any]:
        """Returns the feedback of every arm resting at FED_POSITION plus ``offset``, sampled at ``sampled_at``."""
        width = len(layout.coordinates)
        return {
            arm: {
                "position": [FED_POSITION + offset for _ in range(width)],
                "velocity": list(velocity) if velocity else [0.0] * width,
                "sampled_monotonic_s": sampled_at,
                "sample_id": sample_id,
            }
            for arm in layout.arms
        }

    def feed(
        self,
        layout: JointLayout,
        control_config: ControlConfig,
        now: float,
        *,
        velocity: float | list[float] = 0.0,
        drift: float = 0.0,
        op: str = "add",
    ) -> tuple[list[dict[str, Any]], float]:
        """Returns two windows of samples, one each control period, and the clock after them."""
        ops = []
        count = round(2 * control_config.settle_window_s * control_config.rate_hz)
        for sample in range(count):
            now += 1 / control_config.rate_hz
            value = velocity[sample] if isinstance(velocity, list) else velocity
            speeds = [value] * len(layout.coordinates)
            ops.append(
                {
                    "op": op,
                    "now": now,
                    "arms": self.fed(layout, now, sample_id=sample, velocity=speeds, offset=drift * sample / count),
                },
            )
        return ops, now

    def from_pear_tests(self) -> None:
        """Runs the scenarios of PEAR's own tests of the stability window."""
        for station in ("so101_station", "two_arm"):
            control_config, robot_config = self.robots.configs(station)
            layout = robot_config.LAYOUT
            width = len(layout.coordinates)
            sparse = {"keeps_all_metrics": False}

            ops, now = self.feed(layout, control_config, START_S)
            self.run("still feedback settles after a full window", station, ops, **sparse)

            ops, _ = self.feed(layout, control_config, START_S, velocity=2 * robot_config.velocity_tolerance)
            self.run("mean velocity beyond tolerance is unstable and named", station, ops, **sparse)

            for checks_velocity_rms in (False, True):
                # alternating velocity with a zero mean: only RMS sees it; the span moves too
                alternating = [(-1) ** sample * 2 * robot_config.velocity_tolerance for sample in range(1000)]
                ops, _ = self.feed(
                    layout, control_config, START_S, velocity=alternating, drift=4 * robot_config.position_tolerance
                )
                self.run(
                    f"a strict window bounds position span{' and velocity rms' if checks_velocity_rms else ''}",
                    station,
                    ops,
                    is_strict=True,
                    checks_velocity_rms=checks_velocity_rms,
                    **sparse,
                )

            ops, now = self.feed(layout, control_config, START_S)
            stale = {
                "op": "add",
                "now": now,
                "arms": self.fed(layout, now - 2 * control_config.state_timeout_s, sample_id=-1),
            }
            self.run("stale feedback is rejected and resets the window", station, [*ops, stale], **sparse)

            ops, now = self.feed(layout, control_config, START_S)
            now += 2 * control_config.state_timeout_s
            gap = {"op": "add", "now": now, "arms": self.fed(layout, now, sample_id=10_000)}
            self.run("a sampling gap restarts the window", station, [*ops, gap], **sparse)

            ops, now = self.feed(layout, control_config, START_S)
            position = self.fed(layout, now)[layout.arms[0]]["position"]
            missed = [position[0] + 0.1, *position[1:]]
            judged = {
                "op": "evaluate",
                "now": now,
                "criteria": {
                    "arms": list(layout.arms[:1]), "targets": {layout.arms[0]: missed}, "position_tolerance": 0.05
                },
            }
            self.run("target accuracy over the window is judged per arm", station, [*ops, judged], **sparse)

            ops, now = self.feed(layout, control_config, START_S, velocity=0.12)
            failed = {"op": "stability_error", "reason": "Unstable"}
            self.run(
                "a failure names joint, metric and window",
                station,
                [*ops, failed],
                robot={"velocity_tolerance": 0.06},
                **sparse,
            )

            if len(layout.arms) > 1:
                continue  # (the two arms' hold that keeps moving is among the holds below, on a shorter timeout)
            now = START_S
            ops = []
            for sample in range(round(2 * control_config.settle_timeout_s * control_config.rate_hz)):
                now += 1 / control_config.rate_hz
                velocity = [2 * robot_config.velocity_tolerance] * width
                ops.append(
                    {"op": "check_hold", "now": now, "arms": self.fed(layout, now, sample_id=sample, velocity=velocity)}
                )
            # PEAR's test ends at the fault: the steps after it show what the window does once it has raised
            self.run(
                "persistent motion during hold faults after the settle timeout",
                station,
                ops[: self.first_error(station, ops) + 4],
                **sparse,
            )

        self.so101_arm_tests()
        self.two_arm_tests()

    def first_error(self, station: str, ops: list[dict[str, Any]]) -> int:
        """Returns the index of the first of ``ops`` that PEAR answers with an error, on a window of ``station``."""
        control_config, robot_config = self.robots.configs(station)
        window = StabilityWindow(
            control_config,
            robot_config,
            duration_s=control_config.settle_window_s,
            is_strict=False,
            checks_velocity_rms=False,
        )
        for index, op in enumerate(ops):
            self.clock.now = op["now"]
            try:
                getattr(window, op["op"])({"arms": op["arms"]})
            except Exception:  # noqa: BLE001
                return index
        return len(ops) - 1

    def so101_arm_tests(self) -> None:
        """The SO-101's arm resting at SO101_REST on its quick settings."""
        station = "so101_quick"
        control_config, robot_config = self.robots.configs(station)

        def snapshot(
            sampled_at: float, sample_id: Any = None, velocity: Sequence[float] = (0.0,) * len(SO101_REST)
        ) -> dict[str, Any]:
            return {
                "arm": {
                    "position": list(SO101_REST),
                    "velocity": list(velocity),
                    "sampled_monotonic_s": sampled_at,
                    "sample_id": sample_id,
                    "age_seconds": START_S - sampled_at,
                }
            }

        for name, speed in (
            ("still feedback becomes stable", 0.0),
            ("velocity beyond tolerance is unstable", 2 * robot_config.velocity_tolerance),
        ):
            now, ops = START_S, []
            for sample_id in range(round(2 * control_config.settle_window_s * control_config.rate_hz)):
                now += 1 / control_config.rate_hz
                ops.append({"op": "add", "now": now, "arms": snapshot(now, sample_id, [speed] * len(SO101_REST))})
            self.run(name, station, ops)
        stale = {"op": "add", "now": START_S, "arms": snapshot(START_S - 2 * control_config.state_timeout_s)}
        self.run("stale feedback is rejected", station, [stale])

    def two_arm_tests(self) -> None:
        """The scenarios PEAR's tests run on both YAM arms; their snapshots are written here by hand, where the tests
        take them from a running control loop."""
        station = "two_arm_station"
        control_config, robot_config = self.robots.configs(station)
        layout = robot_config.LAYOUT
        period = 1 / control_config.rate_hz

        def idle(sampled_at: float, sample_id: Any = ABSENT) -> dict[str, Any]:
            arms = {
                arm: {"position": [0.0] * 7, "velocity": [0.0] * 7, "sampled_monotonic_s": sampled_at}
                for arm in layout.arms
            }
            if sample_id is not ABSENT:
                for feedback in arms.values():
                    feedback["sample_id"] = sample_id
            return arms

        # a sampling gap cannot be counted as stationary time
        now, ops = START_S, []
        for _ in range(20):
            now += period
            ops.append({"op": "add", "now": now, "arms": idle(now)})
        now += 0.3
        ops.append({"op": "add", "now": now, "arms": idle(now)})
        self.run("a sampling gap cannot be counted as stationary time", station, ops, checks_velocity_rms=True)

        # duplicate batches cannot create a stability window, and a gap resets
        now, ops = START_S, []
        for batch in range(10):
            now += 0.06
            ops += [{"op": "add", "now": now, "arms": idle(now, batch)} for _ in range(20)]
        for batch in range(10, 40):
            now += 0.02
            ops.append({"op": "add", "now": now, "arms": idle(now, batch)})
        now += 0.2
        ops.append({"op": "add", "now": now, "arms": idle(now, 40)})
        self.run(
            "duplicate batches cannot create a stability window and a gap resets",
            station,
            ops,
            checks_velocity_rms=True,
            keeps_all_metrics=False,
        )

        # one arm's repeated batch cannot hide the other arm's new motion
        for moving in layout.arms:
            now, ops = START_S, []
            sequence = dict.fromkeys(layout.arms, 0)
            stamp = dict.fromkeys(layout.arms, now)
            velocity = {arm: [0.0] * 7 for arm in layout.arms}

            def batches() -> dict[str, Any]:
                return {
                    arm: {
                        "position": [0.0] * 6 + [0.5],
                        "velocity": list(velocity[arm]),
                        "sampled_monotonic_s": stamp[arm],
                        "sample_id": sequence[arm],
                    }
                    for arm in layout.arms
                }

            for _ in range(30):
                for arm in layout.arms:
                    sequence[arm] += 1
                    stamp[arm] = now + period
                now += period
                ops.append({"op": "check_hold", "now": now, "arms": batches()})
            velocity[moving] = [2.0] + [0.0] * 6
            sequence[moving] += 1
            stamp[moving] = now + period
            now += period
            ops.append({"op": "check_hold", "now": now, "arms": batches()})
            # the high-velocity sample remains in the window until enough fresh samples arrive
            velocity[moving] = [0.0] * 7
            for _ in range(30):
                for arm in layout.arms:
                    sequence[arm] += 1
                    stamp[arm] = now + period
                now += period
                ops.append({"op": "check_hold", "now": now, "arms": batches()})
            self.run(
                f"one repeated batch cannot hide the {moving} arm's new motion",
                station,
                ops,
                checks_velocity_rms=True,
                keeps_all_metrics=False,
            )

        # a failure identifies joint, metric, units and the window it had
        now, ops = 0.0, []
        for tick in range(40):
            arms = idle(0.0)
            arms["right"]["position"][2] = 0.004 * (-1) ** tick
            arms["right"]["velocity"][2] = 0.08
            arms["left"]["velocity"][6] = 0.1
            now += period
            for feedback in arms.values():
                feedback["sampled_monotonic_s"] = now
            ops.append({"op": "add", "now": now, "arms": arms})
        ops.append({"op": "stability_error", "reason": "Station lost stability"})
        for _ in range(40):
            now += period
            ops.append({"op": "add", "now": now, "arms": idle(now)})
        self.run(
            "a stability failure identifies joint, metric, units and its window",
            station,
            ops,
            checks_velocity_rms=True,
            keeps_all_metrics=False,
        )

    # generated sequences

    DURATIONS = (None, 0.05, 0.1, 0.25, 0.5, 0.5000001, 0.6, 1.0, 0.0, -1.0, math.nan)

    def criteria(self, layout: JointLayout, positions: dict[str, list[float]]) -> dict[str, Any]:
        """Returns a selection of a window, valid or not."""
        generator = self.generator
        arms = list(layout.arms)
        width = layout.coordinate_count
        criteria: dict[str, Any] = {}
        choice = generator.random()
        if choice < 0.35:
            criteria["arms"] = generator.choice(
                [arms[:1], arms[::-1], [arms[0], arms[0]], ["nobody"], [], None, [arms[-1]]]
            )
        if generator.random() < 0.45:
            criteria["duration_s"] = generator.choice(self.DURATIONS)
        if generator.random() < 0.5:
            judged = criteria.get("arms") or arms
            targets = {
                arm: [
                    round(value + generator.choice([0.0, 0.0, 0.01, -0.03, 0.2]), 4)
                    for value in positions.get(arm, [0.0] * width)
                ]
                for arm in judged
                if arm in arms
            }
            if targets and generator.random() < 0.08:
                targets[next(iter(targets))] = targets[next(iter(targets))][:-1]
            criteria["targets"] = targets
            tolerance = generator.choice(["one", "one", "each", "each", "none", "short", "single"])
            if tolerance == "one":
                criteria["position_tolerance"] = generator.choice([0.05, 0.02, 0.2])
            elif tolerance == "each":
                criteria["position_tolerance"] = [generator.choice([0.02, 0.035, 0.06])] * (width - 1) + [0.02]
            elif tolerance == "short":
                criteria["position_tolerance"] = [0.05] * (width - 1)
            elif tolerance == "single":
                criteria["position_tolerance"] = [0.04]
            elif generator.random() < 0.5:
                criteria["position_tolerance"] = None
        return criteria

    def generated(self, name: str, station: str, control: dict[str, float]) -> None:
        """Runs one random sequence: readings that are regular, late, repeated, stale, ahead of the clock, out of
        order or malformed, each arm on its own, with a window judged in between."""
        generator = self.generator
        control_config, robot_config = self.robots.configs(station)
        control_config = dataclasses.replace(control_config, **control)
        layout = robot_config.LAYOUT
        arms, width = layout.arms, layout.coordinate_count
        period = 1 / control_config.rate_hz
        timeout_s = control_config.state_timeout_s
        is_strict = generator.random() < 0.4
        checks_velocity_rms = generator.random() < 0.5
        duration_s = generator.choice([None, None, control_config.settle_window_s / 2, 0.06])
        id_style = generator.choice(["number", "number", "none", "absent", "text"])
        speed = generator.choice([0.0, 0.0, 0.5, 0.98, 1.0, 1.02, 1.6]) * robot_config.velocity_tolerance
        alternates = generator.random() < 0.3
        drift = generator.choice([0.0, 0.0, 0.3, 2.0]) * robot_config.position_tolerance
        robot_changes = {"velocity_tolerance": 0.06} if generator.random() < 0.2 else {}

        now = START_S
        ops: list[dict[str, Any]] = []
        sequence = dict.fromkeys(arms, 0)
        stamp = dict.fromkeys(arms, now)
        positions = {arm: [round(generator.uniform(-0.5, 0.5), 3) for _ in range(width - 1)] + [0.5] for arm in arms}
        for step in range(generator.randint(14, 32)):
            roll = generator.random()
            if roll < 0.07:
                ops.append({"op": "evaluate", "now": now, "criteria": self.criteria(layout, positions)})
                continue
            if roll < 0.085:
                ops.append({"op": "reset"})
                continue
            if roll < 0.1:
                ops.append({"op": "relax", "duration_s": generator.choice([control_config.settle_window_s, 0.06, 0.2])})
                continue
            if roll < 0.12:
                ops.append(
                    {
                        "op": "stability_error",
                        "reason": generator.choice(["Unstable", "Motion remained unstable before timeout"]),
                    },
                )
                continue
            if roll < 0.13:
                ops.append({"op": "set", "robot": {"velocity_tolerance": generator.choice([0.03, 0.06, 0.12])}})
                continue

            timing = generator.choices(["period", "jitter", "repeat", "gap", "edge"], weights=[58, 22, 8, 6, 6])[0]
            now += {
                "period": period,
                "jitter": round(period * generator.uniform(0.4, 1.7), 5),
                "repeat": 0.0,
                "gap": round(timeout_s * generator.uniform(1.05, 2.5), 5),
                "edge": timeout_s,
            }[timing]
            feedback = {}
            for arm in arms:
                is_new = timing != "repeat" and generator.random() < 0.9
                if is_new:
                    sequence[arm] += 1
                    lag = generator.choices(
                        [
                            0.0,
                            round(generator.uniform(0.0, 0.02), 5),
                            timeout_s,
                            timeout_s * 1.5,
                            -0.0005,
                            -0.001,
                            -0.002,
                        ],
                        weights=[60, 20, 3, 4, 5, 3, 5],
                    )[0]
                    stamp[arm] = now - lag
                    if generator.random() < 0.04:
                        stamp[arm] = round(stamp[arm] - 0.03, 5)  # stamped before the reading before it
                    sign = -1.0 if alternates and sequence[arm] % 2 else 1.0
                    velocity = [
                        round(sign * speed + generator.choice([0.0, 0.0, 0.004, -0.004]), 5) for _ in range(width)
                    ]
                    positions[arm] = [
                        round(value + drift * period + generator.choice([0.0, 0.0, 0.0005, -0.0005]), 5)
                        for value in positions[arm]
                    ]
                else:
                    velocity = [0.0] * width
                reading: dict[str, Any] = {
                    "position": list(positions[arm]), "velocity": velocity, "sampled_monotonic_s": stamp[arm]
                }
                if id_style == "number":
                    reading["sample_id"] = sequence[arm]
                elif id_style == "none":
                    reading["sample_id"] = None
                elif id_style == "text":
                    reading["sample_id"] = f"batch-{sequence[arm]}"
                malformed = generator.random()
                if malformed < 0.012:
                    reading["position"] = reading["position"][:-1]
                elif malformed < 0.024:
                    reading["velocity"] = [*reading["velocity"][:-1], math.nan]
                elif malformed < 0.036:
                    reading["position"] = [math.inf, *reading["position"][1:]]
                elif malformed < 0.045:
                    reading["sampled_monotonic_s"] = generator.choice([math.nan, math.inf])
                feedback[arm] = reading
            ops.append({"op": "check_hold" if generator.random() < 0.3 else "add", "now": now, "arms": feedback})

        self.run(
            name,
            station,
            ops,
            control=control,
            robot=robot_changes,
            duration_s=duration_s,
            is_strict=is_strict,
            checks_velocity_rms=checks_velocity_rms,
        )

    def selections(self, station: str, control: dict[str, float]) -> None:
        """Runs every kind of selection of a window on a complete window and on one that is not: the arms, the
        span, and targets with a tolerance that is one value, one for each coordinate, missing or malformed."""
        control_config, robot_config = self.robots.configs(station)
        control_config = dataclasses.replace(control_config, **control)
        layout = robot_config.LAYOUT
        arms, width = list(layout.arms), layout.coordinate_count
        ops, now = self.feed(
            layout, control_config, START_S, velocity=0.5 * robot_config.velocity_tolerance, drift=0.01
        )
        near = [FED_POSITION + 0.004] * width
        far = [FED_POSITION, FED_POSITION + 0.3, *[FED_POSITION] * (width - 2)]
        every = {arm: near for arm in arms}
        selections: list[dict[str, Any]] = [
            {},
            {"arms": None, "duration_s": None, "targets": None, "position_tolerance": None},
            {"arms": arms[:1]},
            {"arms": arms[::-1]},
            {"arms": [arms[-1], arms[-1]]},
            {"arms": []},
            {"arms": ["nobody"]},
            {"arms": [arms[0], "nobody"]},
            *({"duration_s": duration_s} for duration_s in self.DURATIONS),
            {"duration_s": control_config.settle_window_s / 2, "arms": arms[-1:]},
            {"targets": every, "position_tolerance": 0.05},
            {"targets": every, "position_tolerance": 0.001},
            {"targets": {arm: far for arm in arms}, "position_tolerance": 0.05},
            {"targets": every, "position_tolerance": [0.05] * width},
            {"targets": {arm: far for arm in arms}, "position_tolerance": [0.001] * (width - 1) + [1.0]},
            {"targets": every, "position_tolerance": [0.05]},
            {"targets": every, "position_tolerance": [0.05] * (width - 1)},
            {"targets": every, "position_tolerance": None},
            {"targets": every},
            {"targets": {arms[0]: near}, "arms": arms[:1], "position_tolerance": 0.05},
            {"targets": {arm: near[:-1] for arm in arms}, "position_tolerance": 0.05},
            {"targets": {arm: [FED_POSITION] for arm in arms}, "position_tolerance": 0.05},
            {"targets": {arm: [math.nan, *near[1:]] for arm in arms}, "position_tolerance": 0.05},
            {"targets": {arm: near[:-1] for arm in arms}, "position_tolerance": [0.05] * (width - 1)},
            {"targets": every, "position_tolerance": 0.05, "duration_s": control_config.settle_window_s / 2},
            {"targets": every, "position_tolerance": 0.05, "duration_s": 5.0},
        ]
        judged = [{"op": "evaluate", "now": now, "criteria": criteria} for criteria in selections]
        # the same selections of a window that is not complete, which PEAR answers before it reads the targets
        cut = len(ops) // 3
        self.run(
            f"every selection of a complete window on {station}",
            station,
            [*ops, *judged],
            control=control,
            keeps_all_metrics=False,
        )
        self.run(
            f"every selection of a window that is not complete on {station}",
            station,
            [*ops[:cut], *({**op, "now": ops[cut - 1]["now"]} for op in judged)],
            control=control,
            keeps_all_metrics=False,
        )
        if len(arms) == 1:
            self.run(
                f"every selection of a strict window on {station}",
                station,
                [*ops, *judged[:3], *judged[-16:]],
                control=control,
                is_strict=True,
                checks_velocity_rms=True,
                keeps_all_metrics=False,
            )

    def held(self, name: str, station: str, control: dict[str, float], calm_from: int | None) -> None:
        """Runs a HOLD whose arms keep moving until the settle timeout faults it, or until they calm down."""
        control_config, robot_config = self.robots.configs(station)
        control_config = dataclasses.replace(control_config, **control)
        layout = robot_config.LAYOUT
        width = layout.coordinate_count
        now, ops = START_S, []
        count = round(
            (control_config.settle_timeout_s + 3 * control_config.settle_window_s) * control_config.rate_hz
        ) + 6
        for sample in range(count):
            now += 1 / control_config.rate_hz
            moving = calm_from is None or sample < calm_from or sample > calm_from + 3 * round(
                control_config.settle_window_s * control_config.rate_hz
            )
            velocity = [2 * robot_config.velocity_tolerance if moving else 0.0] * width
            ops.append(
                {"op": "check_hold", "now": now, "arms": self.fed(layout, now, sample_id=sample, velocity=velocity)}
            )
        self.run(name, station, ops, control=control, keeps_all_metrics=False)

    def all(self, scale: int) -> list[dict[str, Any]]:
        quick = {"settle_window_s": 0.1, "settle_timeout_s": 1.0}
        self.from_pear_tests()
        self.held("a hold that keeps moving faults", "so101_quick", {}, None)
        self.held(
            "a hold that calms down in time does not fault, and faults when it moves again", "so101_quick", {}, 30
        )
        self.held("a hold of two arms that keeps moving faults", "two_arm", quick, None)
        self.selections("so101_quick", {})
        self.selections("two_arm", quick)
        for index in range(14 * scale):
            self.generated(f"generated {index} on the SO-101", "so101_quick", {})
        for index in range(5 * scale):
            self.generated(f"generated {index} on two arms", "two_arm", quick)
        for index in range(2 * scale):
            self.generated(f"generated {index} on the SO-101 at the station's settings", "so101_station", {})

        return self.scenarios


class WindowCases:
    """PEAR's SampleWindow and StabilityError on their own."""

    @staticmethod
    def sample_windows(generator: random.Random, count: int) -> list[dict[str, Any]]:
        """Returns sequences of readings added to a sample window, with the stamps it keeps after each."""
        scenarios = []
        for index in range(count):
            checks_stamp_order = index % 2 == 0
            history_s = generator.choice([0.1, 0.1, 0.5, 0.06])
            control_config = dataclasses.replace(
                Robots.shipped_control(), state_timeout_s=generator.choice([0.1, 0.1, 0.05])
            )
            window = SampleWindow(control_config, history_s, checks_stamp_order=checks_stamp_order)
            now, sample_id, steps = START_S, 0, []
            for _ in range(generator.randint(12, 30)):
                roll = generator.random()
                if roll < 0.07:
                    duration_s = generator.choice([0.02, 0.05, 0.1, 0.06, 0.5, 0.0])
                    steps.append(
                        {
                            "op": "recent",
                            "duration_s": duration_s,
                            "stamps": [sample.sampled_monotonic_s for sample in window.recent(duration_s)],
                        },
                    )
                    continue
                if roll < 0.14 and window.samples:
                    duration_s, rate_hz = generator.choice(
                        [0.02, 0.05, 0.06, 0.1, 0.5]
                    ), generator.choice([50.0, 25.0, 100.0])
                    steps.append(
                        {
                            "op": "is_complete",
                            "duration_s": duration_s,
                            "rate_hz": rate_hz,
                            "outcome": SampleWindow.is_complete(window.samples, duration_s, rate_hz),
                        },
                    )
                    continue
                if roll < 0.16:
                    window.clear()
                    steps.append({"op": "clear"})
                    continue
                now += generator.choice([0.02, 0.02, 0.02, 0.0, 0.013, 0.031, 0.1, 0.1000001, 0.12, -0.01, 0.05])
                if generator.random() < 0.8:
                    sample_id += 1
                identity = generator.choice([sample_id, sample_id, None, f"id-{sample_id}"])
                value = round(generator.random(), 3)
                added = window.add(now, identity, value)
                steps.append(
                    {
                        "op": "add",
                        "sampled_monotonic_s": now,
                        "sample_id": identity,
                        "value": value,
                        "outcome": added,
                        "stamps": [sample.sampled_monotonic_s for sample in window.samples],
                        "values": [sample.value for sample in window.samples],
                        "last_identity": window.last_identity,
                    }
                )
            scenarios.append(
                {
                    "checks_stamp_order": checks_stamp_order,
                    "history_s": history_s,
                    "state_timeout_s": control_config.state_timeout_s,
                    "steps": plain(steps),
                }
            )

        return scenarios

    @staticmethod
    def stability_errors() -> list[dict[str, Any]]:
        """Returns stability errors made from metrics as a fault's details carry them, whole and in part."""
        violation = {
            "joint": "shoulder_pan",
            "metric": "velocity_mean",
            "value": 0.12000000000000002,
            "limit": 0.06,
            "units": "rad/s",
        }
        sided = {
            "side": "left", "joint": "J1", "metric": "position_span", "value": 0.0204999, "limit": 0.02, "units": "rad"
        }
        metrics_list: list[dict[str, Any]] = [
            {},
            {"window_seconds": 0.0, "samples": 0, "stable": False},
            {"window_seconds": 0.48000000000000398, "samples": 25, "stable": False, "violations": [violation]},
            {"window_seconds": 0.5, "samples": 26, "stable": False, "violations": [violation, sided]},
            {"window_seconds": 0.0005, "samples": 3, "violations": []},
            {"window_seconds": 0.0015, "samples": 3},
            {"window_seconds": 12.3456789, "violations": [{**sided, "value": 2, "limit": 1}]},
            {"samples": 7, "violations": [{**violation, "limit": math.inf, "value": 1e9}]},
            {
                "window_seconds": 1,
                "samples": 1,
                "violations": [
                    {"metric": "velocity_rms", "value": 1.0000005, "limit": 0.9999995, "units": "opening/s"}
                ],
            },
            {
                "window_seconds": 0.1235,
                "samples": 2,
                "violations": [{**violation, "value": 0.0000005, "limit": 0.0000015}],
            },
            {
                "window_seconds": 2.0005,
                "samples": 100,
                "violations": [{**sided, "extra": "kept"}],
                "position_span": [0.1, 0.2],
                "target_error_max": {"left": [0.5]},
            },
        ]
        cases = []
        for metrics in metrics_list:
            for reason in ("Unstable", "Persistent motion during HOLD"):
                error = StabilityError(reason, metrics)
                cases.append(
                    {
                        "reason": reason,
                        "metrics": plain(metrics),
                        "message": str(error),
                        "details": plain(error.details),
                    },
                )
        return cases


class TrackingCases:
    """PEAR's Tracking on each station: faults of the held targets and arrivals at the requested ones."""

    @staticmethod
    def of(key: str, robot_config: RobotConfig, generator: random.Random, count: int) -> dict[str, Any]:
        layout = robot_config.LAYOUT
        limits = robot_config.joint_limits()
        tracking = Tracking(robot_config, limits, layout)
        length = layout.vector_length
        cases: list[dict[str, Any]] = []

        def vector() -> list[float]:
            return [round(generator.uniform(-1.0, 1.0), 4) for _ in range(length)]

        def add(method: str, measured: list[Any], reference: list[Any]) -> None:
            call = {
                "check": lambda: tracking.check(measured, reference),
                "arrival": lambda: tracking.arrival(measured, reference),
            }[method]
            cases.append(
                {"method": method, "measured": plain(measured), "reference": plain(reference), "outcome": outcome(call)}
            )

        def faults(measured: list[float], reference: list[float]) -> bool:
            try:
                tracking.check(measured, reference)
            except TrackingError:
                return True
            return False

        if length == len(SO101_REST):
            # what PEAR's own tests ask of the SO-101's arm at rest (test_joint_control_in_station.py): a tracking
            # error beyond its bound faults, and the gripper's arrival uses the gripper's tolerance
            rest = list(SO101_REST)
            add("check", rest, rest)
            add("check", rest, [rest[0], rest[1] + limits.tracking_error[1] + 0.01, *rest[2:]])
            add("arrival", rest, [*rest[:5], rest[5] + 0.5 * robot_config.gripper_tolerance])
            add("arrival", rest, [*rest[:5], rest[5] + 1.5 * robot_config.gripper_tolerance])

        base = vector()
        width = layout.coordinate_count
        # the coordinates whose edges are searched: all of one arm, the first and the last of every other
        edge_indices = sorted({*range(width), *(index for index in range(length) if index % width in (0, width - 1))})
        for index in edge_indices:
            for side in (1.0, -1.0):
                def moved(distance: float, index: int = index, side: float = side) -> list[float]:
                    return [*base[:index], base[index] + side * distance, *base[index + 1 :]]

                # where a fault begins, when the coordinate can fault at all (a gripper never does)
                if faults(moved(50.0), base):
                    for distance in Edge.of(lambda distance: not faults(moved(distance), base), 0.0, 50.0):
                        add("check", moved(distance), base)
                else:
                    add("check", moved(50.0), base)
                reaches = lambda distance: tracking.arrival(moved(distance), base)["reached"]  # noqa: E731
                for distance in Edge.of(reaches, 0.0, 50.0):
                    add("arrival", moved(distance), base)
        for _ in range(count):
            reference = vector()
            scales = [generator.choice([0.0, 0.0, 0.3, 0.9, 1.0, 1.1, 2.0, 5.0]) for _ in range(length)]
            measured = [
                value + generator.choice([-1.0, 1.0]) * scale * bound
                for value, scale, bound in zip(reference, scales, tracking.arrival_tolerance)
            ]
            if generator.random() < 0.5:
                measured = [
                    value + generator.choice([-1.0, 1.0]) * generator.choice([0.0, 0.5, 1.2]) * bound
                    for value, bound in zip(reference, limits.tracking_error)
                ]
            add("check", measured, reference)
            add("arrival", measured, reference)
        good = vector()
        for value in (math.nan, math.inf, -math.inf):
            for index in (0, length - 1):
                broken = [*good[:index], value, *good[index + 1 :]]
                for method in ("check", "arrival"):
                    add(method, broken, good)
                    add(method, good, broken)
        both = [*good[:-1], math.nan]
        add("check", [*both[:1], both[1] + 9.0, *both[2:]], good)
        for method in ("check", "arrival"):
            add(method, good[:-1], good)
            add(method, good, good[:-1])
            add(method, [0.25], good)
            add(method, good, [0.25])
            add(method, [], good)
        signed_zero = [-0.0] * length
        add("arrival", signed_zero, [0.0] * length)
        add("arrival", [0.0] * length, signed_zero)

        return {
            "station": key,
            "arrival_tolerance": plain(tracking.arrival_tolerance),
            "fault_bounds": plain(tracking.fault_bounds),
            "cases": cases,
        }


class SnapshotCases:
    """PEAR's SnapshotCheck, ArmState and ActionGuard."""

    @staticmethod
    def fault_snapshots(robots: Robots, clock: Clock) -> list[dict[str, Any]]:
        """Returns snapshots with and without a fault, a stability fault as a window's error words it among them."""
        control_config, robot_config = robots.configs("so101_station")
        window = StabilityWindow(
            control_config,
            robot_config,
            duration_s=control_config.settle_window_s,
            is_strict=False,
            checks_velocity_rms=False,
        )
        clock.now = START_S
        for sample in range(40):
            clock.now += 1 / control_config.rate_hz
            arms = {
                "arm": {
                    "position": [0.1 + 0.004 * (-1) ** sample] * 6,
                    "velocity": [0.12] * 6,
                    "sampled_monotonic_s": clock.now,
                    "sample_id": sample,
                },
            }
            window.add({"arms": arms})
        error = window.stability_error("Motion remained unstable before timeout")
        empty = StabilityError("Persistent motion during HOLD", {})
        snapshots: list[dict[str, Any]] = [
            {"status": "HOLD", "fault": None},
            {"status": "HOLD", "fault": None, "fault_details": None},
            {"status": "RUNNING", "fault": ""},
            {
                "status": "STOPPING",
                "fault": None,
                "fault_details": {"code": "StabilityError", "reason": "ignored", "metrics": {}},
            },
            {"status": "FAULT", "fault": None},
            {"status": "FAULT", "fault": "Servo error: elbow_flex: overload", "fault_details": None},
            {
                "status": "FAULT",
                "fault": "Excessive tracking error: shoulder_lift error=0.300000 > 0.250000 rad",
                "fault_details": {},
            },
            {"status": "HOLD", "fault": "a fault while holding", "fault_details": None},
            {"status": "CLOSED", "fault": None},
            {"status": "CLOSED", "fault": "Station closed during recovery"},
            {"status": "FAULT", "fault": str(error), "fault_details": error.details},
            {"status": "FAULT", "fault": str(empty), "fault_details": empty.details},
            {"status": "HOLD", "fault": str(error), "fault_details": error.details},
            {
                "status": "FAULT",
                "fault": "something else",
                "fault_details": {"code": "TrackingError", "reason": "x", "metrics": {}},
            },
            {
                "status": "FAULT",
                "fault": "x",
                "fault_details": {
                    "code": "StabilityError", "reason": "Unstable", "metrics": {"window_seconds": 0.25, "samples": 4}
                },
            },
            {"status": "ODD", "fault": None},
        ]
        return plain(snapshots)

    @classmethod
    def checks(cls, robots: Robots, clock: Clock) -> dict[str, Any]:
        snapshots = cls.fault_snapshots(robots, clock)
        control_config = Robots.shipped_control()
        timeout_s = control_config.state_timeout_s

        fault_cases = [
            {
                "snapshot": snapshot,
                "outcome": outcome(lambda snapshot=snapshot: SnapshotCheck.raise_for_fault(snapshot)),
            }
            for snapshot in snapshots
        ]

        validate_cases = []
        ages = [0.0, -0.0, 0.05, timeout_s, math.nextafter(timeout_s, 1.0), 0.2, -1e-12, -0.001, math.nan, math.inf]

        def validated(whole: dict[str, Any], requires_hold: bool) -> dict[str, Any]:
            """Returns whether PEAR gave the snapshot back, as it does one it accepts, or its refusal."""
            return outcome(
                lambda: SnapshotCheck.validate_snapshot(whole, control_config, requires_hold=requires_hold) is whole
            )

        for snapshot in snapshots:
            for requires_hold in (False, True):
                whole = {**snapshot, "arms": {"arm": {"age_seconds": 0.01}}}
                validate_cases.append(
                    {
                        "snapshot": whole,
                        "state_timeout_s": timeout_s,
                        "requires_hold": requires_hold,
                        "outcome": validated(whole, requires_hold),
                    }
                )
        for status in ("HOLD", "RUNNING", "STOPPING"):
            for age in ages:
                for arms in (
                    {"arm": {"age_seconds": age}}, {"left": {"age_seconds": 0.0}, "right": {"age_seconds": age}}, {}
                ):
                    whole = {"status": status, "fault": None, "arms": arms}
                    validate_cases.append(
                        {
                            "snapshot": plain(whole),
                            "state_timeout_s": timeout_s,
                            "requires_hold": status == "HOLD",
                            "outcome": validated(whole, status == "HOLD"),
                        }
                    )

        two_arms = {
            "generation": 7,
            "arms": {"left": {"position": [0.1, 0.2, 0.3]}, "right": {"position": [1.1, 1.2, 1.3]}},
            "targets": {"right": [2.1, 2.2, 2.3], "left": [3.1, 3.2, 3.3]},
        }
        one_arm = {"generation": 3, "arms": {"arm": {"position": list(SO101_REST)}}, "targets": {"arm": [0.0] * 6}}
        vector_cases = [
            {
                "snapshot": snapshot,
                "state_vector": plain(SnapshotCheck.state_vector(snapshot)),
                "target_vector": plain(SnapshotCheck.target_vector(snapshot)),
            }
            for snapshot in (two_arms, one_arm, {"arms": {}, "targets": {}})
        ]

        observations: list[Any] = [None]
        for generation in (7, 8, 3):
            for positions in (
                [0.0] * 6,
                [0.0] * 5,
                [0.0] * 7,
                [],
                [0.0, 0.0, math.nan, 0.0, 0.0, 0.0],
                [math.inf] * 6,
                [1, 2, 3, 4, 5, 6],
            ):
                observations.append({"control_snapshot": {"generation": generation}, "joint_positions": positions})
        reference_cases = [
            {
                "snapshot": snapshot,
                "observation": plain(observation),
                "outcome": outcome(
                    lambda snapshot=snapshot, observation=observation: SnapshotCheck.validate_reference(
                        snapshot, observation
                    ),
                ),
            }
            for snapshot in (two_arms, one_arm)
            for observation in observations
        ]

        timeout_cases = [
            {
                "timeout_s": plain(value),
                "subject": subject,
                "outcome": outcome(lambda value=value, subject=subject: SnapshotCheck.check_timeout(value, subject)),
            }
            for subject in ("Recovery timeout", "Home timeout")
            for value in (1.0, 0.0, -0.0, -1.0, 1e-12, math.nan, math.inf, -math.inf, 30)
        ]

        return {
            "fault_cases": fault_cases,
            "validate_cases": validate_cases,
            "vector_cases": vector_cases,
            "reference_cases": reference_cases,
            "timeout_cases": timeout_cases,
        }

    @staticmethod
    def arm_states(robots: Robots, generator: random.Random) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Returns readings of an arm as a snapshot's feedback and their check against the layout, and ages with
        whether they are fresh."""
        cases = []
        for key in ("so101", "two_arm"):
            layout = robots.configs(key)[1].LAYOUT
            width = layout.coordinate_count
            good = [round(generator.uniform(-1, 1), 3) for _ in range(width)]
            readings = [
                (good, [0.0] * width, START_S, 12),
                (good, good, START_S - 0.02, None),
                (good[:-1], [0.0] * width, START_S, 1),
                (good, [0.0] * (width + 1), START_S, 2),
                ([*good[:-1], math.nan], [0.0] * width, START_S, 3),
                (good, [math.inf, *good[1:]], START_S, 4),
                ([], [], START_S, 5),
                (good, [0.0] * width, START_S + 0.5, "batch-9"),
            ]
            for position, velocity, sampled_at, sample_id in readings:
                state = ArmState(tuple(position), tuple(velocity), sampled_at) if sample_id is None else ArmState(
                    tuple(position), tuple(velocity), sampled_at, sample_id
                )
                for now in (START_S, START_S + 0.013, sampled_at):
                    cases.append(
                        {
                            "layout": key,
                            "position": plain(position),
                            "velocity": plain(velocity),
                            "sampled_monotonic_s": sampled_at,
                            "sample_id": sample_id,
                            "now": now,
                            "feedback": plain(state.feedback(now)),
                            "check": outcome(lambda state=state: state.check(layout)),
                        }
                    )
        fresh = []
        for age in (
            0.0,
            -0.0,
            0.05,
            0.1,
            math.nextafter(0.1, 1.0),
            0.2,
            -0.0005,
            -0.001,
            math.nextafter(-0.001, -1.0),
            -0.002,
            math.nan,
            math.inf,
            -math.inf,
        ):
            for timeout_s in (0.1, 0.0):
                fresh.append(
                    {
                        "age_s": plain(age),
                        "timeout_s": timeout_s,
                        "slack_s": None,
                        "outcome": ArmState.is_fresh(age, timeout_s),
                    },
                )
                fresh.append(
                    {
                        "age_s": plain(age),
                        "timeout_s": timeout_s,
                        "slack_s": ArmState.CLOCK_SLACK_S,
                        "outcome": ArmState.is_fresh(age, timeout_s, ArmState.CLOCK_SLACK_S),
                    },
                )
        return cases, fresh

    @staticmethod
    def polls(clock: Clock, generator: random.Random, count: int) -> list[dict[str, Any]]:
        """Returns waits of ``SnapshotCheck.poll`` over attempts that take a scripted time and end as scripted."""
        cases = []
        scripts: list[dict[str, Any]] = [
            {"timeout_s": None, "control_period_s": 0.02, "attempts": [[0.0, True, "first"]]},
            {
                "timeout_s": None,
                "control_period_s": 0.02,
                "attempts": [[0.0, False, 1], [0.0, False, 2], [0.0, True, 3]],
            },
            {"timeout_s": 0.05, "control_period_s": 0.02, "attempts": [[0.0, False, index] for index in range(8)]},
            {"timeout_s": 0.0, "control_period_s": 0.02, "attempts": [[0.0, False, "late"]]},
            {"timeout_s": 0.0, "control_period_s": 0.02, "attempts": [[0.0, True, "in time"]]},
            {
                "timeout_s": 0.04,
                "control_period_s": 0.02,
                "attempts": [[0.0, False, 0], [0.0, False, 1], [0.0, True, 2], [0.0, False, 3]],
            },
            {
                "timeout_s": 0.04,
                "control_period_s": 0.02,
                "attempts": [[0.0, False, 0], [0.0, False, 1], [0.0, False, 2], [0.0, True, 3]],
            },
            {
                "timeout_s": 0.1,
                "control_period_s": 0.02,
                "attempts": [[0.2, False, "slow"], [0.0, True, "never tried"]],
            },
            {
                "timeout_s": 1.0,
                "control_period_s": 0.0,
                "attempts": [[0.4, False, 0], [0.4, False, 1], [0.4, False, 2], [0.4, True, 3]],
            },
        ]
        for _ in range(count):
            scripts.append(
                {
                    "timeout_s": generator.choice([None, 0.05, 0.1, 0.1, 0.3, 1.0]),
                    "control_period_s": generator.choice([0.02, 0.02, 0.01, 0.033]),
                    "attempts": [
                        [
                            generator.choice([0.0, 0.0, 0.004, 0.03]), generator.random() < 0.12, index
                        ] for index in range(40)
                    ],
                }
            )
        for script in scripts:
            clock.now, clock.slept = START_S, []
            attempts = iter(script["attempts"])
            made = []

            def attempt() -> tuple[bool, Any]:
                takes, is_done, result = next(attempts, (0.0, True, "the script ended"))
                clock.now += takes
                made.append(result)
                return is_done, result

            def timed_out(result: Any) -> Exception:
                return TimeoutError(f"gave up after {result}")

            arguments = (attempt, script["control_period_s"]) + (
                () if script["timeout_s"] is None else (script["timeout_s"], timed_out)
            )
            result = outcome(lambda: SnapshotCheck.poll(*arguments))
            cases.append(
                {
                    **script,
                    "outcome": result,
                    "attempts_made": len(made),
                    "sleeps": list(clock.slept),
                    "end_s": clock.now,
                },
            )
        return cases

    @staticmethod
    def waits(clock: Clock, generator: random.Random, count: int) -> list[dict[str, Any]]:
        """Returns waits of ``SnapshotCheck.wait_ready`` over scripted snapshots, with a guard that ends the action
        at a scripted check."""
        cases = []
        hold, running = "HOLD", "RUNNING"
        scripts: list[dict[str, Any]] = [
            {"timeout_s": 1.0, "reads": [[hold, True, True]], "accepts": True, "guard_fails_at": None},
            {
                "timeout_s": 1.0,
                "reads": [[running, False, True], [hold, False, True], [hold, True, True]],
                "accepts": False,
                "guard_fails_at": None,
            },
            {
                "timeout_s": 1.0,
                "reads": [[hold, True, False], [hold, True, False], [hold, True, True]],
                "accepts": True,
                "guard_fails_at": None,
            },
            {"timeout_s": 0.05, "reads": [[running, False, True]] * 9, "accepts": False, "guard_fails_at": None},
            {"timeout_s": 0.0, "reads": [[running, True, True]], "accepts": True, "guard_fails_at": None},
            {"timeout_s": 1.0, "reads": [[running, False, True]] * 4, "accepts": True, "guard_fails_at": 0},
            {"timeout_s": 1.0, "reads": [[hold, True, True]] * 4, "accepts": True, "guard_fails_at": 1},
            {"timeout_s": 1.0, "reads": [[running, False, True]] * 4, "accepts": True, "guard_fails_at": 4},
            {
                "timeout_s": 1.0,
                "reads": [["FAULT", True, True], [hold, True, True]],
                "accepts": False,
                "guard_fails_at": None,
            },
        ]
        for timeout_s in (math.nan, math.inf, -math.inf, -0.001, -1.0):
            scripts.append(
                {"timeout_s": timeout_s, "reads": [[hold, True, True]], "accepts": False, "guard_fails_at": None}
            )
        for _ in range(count):
            scripts.append(
                {
                    "timeout_s": generator.choice([0.1, 0.3, 1.0]),
                    "reads": [
                        [
                            generator.choice([hold, hold, running, "STOPPING"]),
                            generator.random() < 0.5,
                            generator.random() < 0.6,
                        ]
                        for _ in range(30)
                    ],
                    "accepts": generator.random() < 0.7,
                    "guard_fails_at": generator.choice([None, None, None, generator.randrange(12)]),
                }
            )
        for script in scripts:
            clock.now, clock.slept = START_S, []
            reads = iter(script["reads"])
            counts = {"checks": 0, "reads": 0, "accepted": 0}
            accepted = []

            class Guard:
                def check(self) -> None:
                    counts["checks"] += 1
                    if counts["checks"] - 1 == script["guard_fails_at"]:
                        raise RuntimeError("Action cancelled by stop or another operation")

            def read_snapshot() -> dict[str, Any]:
                status, is_settled, is_accepted = next(reads, (hold, True, True))
                counts["reads"] += 1
                accepted.append(is_accepted)
                return {"status": status, "arrival": {"settled": is_settled}, "number": counts["reads"]}

            def accepts(snapshot: dict[str, Any]) -> bool:
                counts["accepted"] += 1
                return accepted[-1]

            def timed_out(snapshot: dict[str, Any]) -> Exception:
                return TimeoutError(f"Motion did not settle before timeout: {snapshot['number']}")

            result = outcome(
                lambda: SnapshotCheck.wait_ready(
                    read_snapshot,
                    timeout_s=script["timeout_s"],
                    control_period_s=0.02,
                    guard=Guard(),
                    make_timeout_error=timed_out,
                    accepts=accepts if script["accepts"] else None,
                )
            )
            cases.append({**plain(script), "outcome": result, "counts": counts, "sleeps": list(clock.slept)})
        return cases

    @staticmethod
    def guards(generator: random.Random, count: int) -> list[dict[str, Any]]:
        """Returns actions on a stand-in control loop that holds only what PEAR's ActionGuard reads and asks of
        one: each step's answer, and the guard's generation and whether it dispatched after it."""

        class StandInLoop:
            def __init__(self) -> None:
                self.lock = threading.RLock()
                self.generation = 0
                self.status: str = schemas.ControlState.HOLD
                self.fault: str | None = None
                self.fault_details: dict[str, Any] | None = None
                self.attached: list[bool] = []  # of every cancellation attached: whether it was one

            def snapshot(self) -> dict[str, Any]:
                return {"status": str(self.status), "fault": self.fault, "fault_details": self.fault_details}

            def attach_cancellation(self, cancellation: threading.Event | None) -> None:
                self.attached.append(cancellation is not None)

        stability = StabilityError(
            "Motion remained unstable before timeout", {"window_seconds": 0.1, "samples": 5, "violations": []}
        )
        changes: list[dict[str, Any]] = [
            {"generation": 1},
            {"status": "RUNNING", "generation": 1},
            {"status": "FAULT", "fault": "Servo error: gripper: overload", "generation": 1},
            {"status": "FAULT", "fault": str(stability), "fault_details": stability.details, "generation": 1},
            {"status": "CLOSED", "generation": 1},
            {"status": "CLOSED", "fault": "Station closed during recovery", "generation": 1},
            {"status": "HOLD", "fault": None, "fault_details": None, "generation": 1},
            {"status": "STOPPING"},
        ]
        effects: list[dict[str, Any]] = [
            {"advance": 1, "status": "RUNNING", "returns": True},
            {"advance": 0, "returns": False},
            {"advance": 2, "returns": "stopped"},
            {"advance": 1, "raises": "Trajectory start no longer matches held commands"},
            {"advance": 0, "raises": "Cannot start a move in STOPPING"},
            {"advance": 1, "status": "FAULT", "fault": "failed while starting", "returns": None},
        ]
        scripts: list[list[dict[str, Any]]] = [
            [
                {"op": "check"},
                {"op": "submit", "effect": effects[0]},
                {"op": "check"},
                {"op": "loop", "change": changes[0]},
                {"op": "check"},
            ],
            [{"op": "cancel"}, {"op": "check"}, {"op": "submit", "effect": effects[0]}],
            [
                {"op": "submit", "effect": effects[1]},
                {"op": "submit", "effect": effects[0]},
                {"op": "submit", "effect": effects[2]},
                {"op": "check"},
            ],
            [{"op": "submit", "effect": effects[3]}, {"op": "check"}, {"op": "submit", "effect": effects[0]}],
            [{"op": "submit", "effect": effects[5]}, {"op": "check"}],
        ]
        scripts += [
            [{"op": "loop", "change": change}, {"op": "check"}, {"op": "submit", "effect": effects[0]}]
            for change in changes
        ]
        for _ in range(count):
            script = []
            for _ in range(generator.randint(4, 10)):
                roll = generator.random()
                if roll < 0.4:
                    script.append({"op": "check"})
                elif roll < 0.75:
                    script.append(
                        {
                            "op": "submit",
                            "effect": generator.choice(effects),
                            "arguments": [generator.randrange(9), "x"],
                        },
                    )
                elif roll < 0.95:
                    script.append({"op": "loop", "change": generator.choice(changes)})
                else:
                    script.append({"op": "cancel"})
            scripts.append(script)

        cases = []
        for index, script in enumerate(scripts):
            loop = StandInLoop()
            loop.generation = index % 3
            has_cancellation = index % 2 == 0
            cancellation = threading.Event() if has_cancellation else None
            guard = ActionGuard(loop, cancellation)
            steps = []
            for op in script:
                step = dict(op)
                if op["op"] == "check":
                    step["outcome"] = outcome(guard.check)
                elif op["op"] == "cancel":
                    if cancellation is not None:
                        cancellation.set()
                elif op["op"] == "loop":
                    for field, value in op["change"].items():
                        if field == "generation":
                            loop.generation += value
                        else:
                            setattr(loop, field, value)
                else:
                    effect = op["effect"]

                    def method(*arguments: Any, effect: dict[str, Any] = effect) -> Any:
                        loop.generation += effect["advance"]
                        for field in ("status", "fault"):
                            if field in effect:
                                setattr(loop, field, effect[field])
                        if "raises" in effect:
                            raise ValueError(effect["raises"])
                        return {"arguments": list(arguments), "returns": effect["returns"]}

                    step["outcome"] = outcome(lambda: guard.submit(method, *op.get("arguments", [])))
                step["guard"] = {"generation": guard.generation, "has_dispatched": guard.has_dispatched}
                step["loop"] = {"generation": loop.generation, "attached": list(loop.attached)}
                steps.append(plain(step))
            cases.append({"start_generation": index % 3, "has_cancellation": has_cancellation, "steps": steps})
        return cases


class FeedforwardCases:
    """PEAR's friction feedforward, the generic one and the SO-101's, its gravity model and its goal offsets."""

    CLASSES = {"FrictionFeedforward": FrictionFeedforward, "SO101FrictionFeedforward": SO101FrictionFeedforward}

    @classmethod
    def constructors(cls) -> list[dict[str, Any]]:
        values: list[tuple[Any, Any]] = [
            ([1.0, 2.0, 0.0], [0.0, 0.0, 0.0]),
            ([0.5], [0.2]),
            ([], []),
            ([-0.1], [0.0]),
            ([0.5], [-0.1]),
            ([-0.0], [-0.0]),
            ([1.0, 2.0], [0.0]),
            ([1.0], [0.0, 0.0]),
            ([math.nan], [0.0]),
            ([1.0], [math.nan]),
            ([math.inf], [0.0]),
            ([1.0], [math.inf]),
            ([1.0, -1.0], [math.nan, 0.0]),
            ([1, 2], [0, 1]),
            ([-1.0], [0.0, 0.0]),
        ]
        cases = []
        for name, feedforward_class in cls.CLASSES.items():
            for magnitude, load_ratio in values:
                def made(
                    magnitude: Any = magnitude,
                    load_ratio: Any = load_ratio,
                    feedforward_class: type = feedforward_class,
                ) -> Any:
                    feedforward = feedforward_class(magnitude, load_ratio)
                    return {"magnitude": feedforward.magnitude, "load_ratio": feedforward.load_ratio}

                cases.append(
                    {
                        "class": name,
                        "magnitude": plain(magnitude),
                        "load_ratio": plain(load_ratio),
                        "outcome": outcome(made),
                    },
                )
        return cases

    @staticmethod
    def state(feedforward: FrictionFeedforward) -> dict[str, Any]:
        return plain(
            {
                "level": feedforward.level,
                "direction": feedforward.direction,
                "moved_at": feedforward.moved_at,
                "updated_at": feedforward.updated_at,
            },
        )

    @classmethod
    def sequence(
        cls, name: str, class_name: str, magnitude: list[float], load_ratio: list[float], ops: list[dict[str, Any]]
    ) -> dict[str, Any]:
        """Runs ``ops`` on a new feedforward and keeps what every update returned or raised, and the feedforward's
        state after every twentieth step, after every error and at the end."""
        feedforward = cls.CLASSES[class_name](magnitude, load_ratio)
        steps = []
        given: dict[str, str] = {}  # the planned velocity and the load of the update before, as the fixture words them
        for index, op in enumerate(ops):
            step = dict(op)
            if op["op"] == "reset":
                feedforward.reset()
            else:
                step["outcome"] = outcome(lambda: feedforward.update(op["velocity"], op["now"], op["load"]))
                # an update whose planned velocity or load is the one of the update before leaves it out
                for field in ("velocity", "load"):
                    text = json.dumps(plain(op[field]))
                    if given.get(field) == text:
                        del step[field]
                    given[field] = text
            if index % 20 == 19 or index == len(ops) - 1 or "error" in step.get("outcome", {}) or op["op"] == "reset":
                step["state"] = cls.state(feedforward)
            steps.append(plain(step))
        return {"name": name, "class": class_name, "magnitude": magnitude, "load_ratio": load_ratio, "steps": steps}

    @staticmethod
    def thread(
        velocity: list[float], start: float, seconds: float, load: Any = None
    ) -> tuple[list[dict[str, Any]], float]:
        """Returns the updates the SDK's control thread makes for ``seconds`` from ``start``, and the time then
        (test_feedforward_in_station.py)."""
        ops, now = [], start
        for _ in range(round(seconds / SDK_PERIOD_S)):
            now += SDK_PERIOD_S
            ops.append({"op": "update", "velocity": velocity, "now": now, "load": load})
        return ops, now

    @staticmethod
    def advance(velocity: list[float], start: float, end: float, load: list[float]) -> list[dict[str, Any]]:
        """Returns the updates at the control rate from ``start`` through ``end`` (test_so101_joint_in_station.py)."""
        return [
            {"op": "update", "velocity": velocity, "now": float(now), "load": load}
            for now in np.arange(start, end + 1e-9, ADVANCE_PERIOD_S)
        ]

    @classmethod
    def from_pear_tests(cls) -> list[dict[str, Any]]:
        friction = FrictionFeedforward
        def update(velocity: Any, now: float, load: Any = None) -> dict[str, Any]:
            return {"op": "update", "velocity": velocity, "now": now, "load": load}

        sequences = []

        first, now = cls.thread([0.2, -0.2, 0.2], 0.0, friction.ENGAGE_S / 2)
        second, _ = cls.thread([0.2, -0.2, 0.2], now, friction.ENGAGE_S)
        sequences.append(
            cls.sequence(
                "torque follows the planned direction after a smooth ramp",
                "FrictionFeedforward",
                [1.0, 2.0, 0.0],
                [0.0] * 3,
                [update([0, 0, 0], 0.0), *first, *second],
            ),
        )

        ops, now = cls.thread([0.3, -0.3, 0], 0.0, 0.5)
        for velocity, seconds in (
            ([0.001, -0.001, 0], 0.05),
            ([0, 0, 0], friction.LATCH_S - 0.06),
            ([0, 0, 0], 0.02 + friction.FADE_S / 2),
            ([0, 0, 0], friction.FADE_S),
        ):
            more, now = cls.thread(velocity, now, seconds)
            ops += more
        sequences.append(
            cls.sequence(
                "torque holds through the stop then fades to zero",
                "FrictionFeedforward",
                [1.0, 2.0, 0.0],
                [0.0] * 3,
                ops,
            ),
        )

        ops, now = cls.thread([0.2], 0.0, 0.3)
        for _ in range(100):
            now += SDK_PERIOD_S
            ops.append(update([-0.2], now))
        sequences.append(
            cls.sequence("a reversal ramps through zero without a step", "FrictionFeedforward", [1.0], [0.0], ops)
        )

        sequences.append(
            cls.sequence(
                "a stalled caller cannot jump the ramp",
                "FrictionFeedforward",
                [1.0],
                [0.0],
                [update([0.0], 0.0), update([0.2], 5.0)],
            ),
        )
        ops, now = cls.thread([0.2], 0.0, 0.3)
        more, _ = cls.thread([math.nan], now, friction.LATCH_S + friction.FADE_S + 0.05)
        sequences.append(cls.sequence("bad input fades", "FrictionFeedforward", [1.0], [0.0], ops + more))

        now, ops = 0.0, []
        for _ in range(50):
            now += SDK_PERIOD_S
            ops.append(update([0.2, -0.2], now, [-10.0, -10.0]))
        ops.append(update([0.2, -0.2], now + SDK_PERIOD_S, [math.nan, 0.0]))
        sequences.append(
            cls.sequence(
                "the magnitude grows with the gravity load", "FrictionFeedforward", [0.5, 0.5], [0.2, 0.0], ops
            ),
        )

        # the SO-101's (test_so101_joint_in_station.py)
        so101_friction = SO101FrictionFeedforward
        latch, fade, engage = so101_friction.LATCH_S, so101_friction.FADE_S, so101_friction.ENGAGE_S
        load = [0.0, 0.5]
        end = 0.2 + latch + fade + 0.1
        ops = [
            update([0.2, -0.2], 0.0, load),
            *cls.advance([0.2, -0.2], 0.02, 0.2, load),
            *cls.advance([0, 0], 0.22, 0.2 + latch, load),
            *cls.advance([0, 0], 0.2 + latch + 0.02, 0.2 + latch + fade / 2, load),
            *cls.advance([0, 0], end - 0.1, end, load),
        ]
        sequences.append(
            cls.sequence(
                "friction ramps in, latches past the stop and fades",
                "SO101FrictionFeedforward",
                [0.01, 0.02],
                [0.0, 0.1],
                ops,
            ),
        )
        ops = [
            *cls.advance([0.2], 0.0, 0.2, [0.0]),
            *cls.advance([-0.2], 0.2 + 0.01, 0.2 + 0.01, [0.0]),
            *cls.advance([-0.2], 0.22, 0.2 + 2 * engage + 0.02, [0.0]),
            update([math.nan], 0.4, [0.0]),
        ]
        sequences.append(
            cls.sequence(
                "friction reverses through zero and ignores a malformed velocity",
                "SO101FrictionFeedforward",
                [0.01],
                [0.0],
                ops,
            ),
        )

        return sequences

    @classmethod
    def malformed(cls) -> list[dict[str, Any]]:
        """Returns one sequence for each class through every planned velocity and load that is no vector of the
        joints: missing, too long, too short, one value, not finite."""
        speed = FrictionFeedforward.MIN_MOVING_SPEED
        plan = [0.2, -0.2, 0.0]
        inputs: list[tuple[Any, Any]] = [
            (plan, [0.1, -0.4, 0.3]),
            (plan, None),
            (plan, [0.1, -0.4, 0.3, 0.9]),
            (plan, [0.1, -0.4]),
            (plan, [0.25]),
            (plan, []),
            (plan, [math.nan, -0.4, 0.3]),
            (plan, [math.inf, -0.4, 0.3]),
            (None, [0.1, -0.4, 0.3]),
            ([*plan, 0.3], [0.1, -0.4, 0.3]),
            (plan[:-1], [0.1, -0.4, 0.3]),
            ([0.2], [0.1, -0.4, 0.3]),
            ([], [0.1, -0.4, 0.3]),
            ([math.nan, -0.2, 0.0], [0.1, -0.4, 0.3]),
            ([0.2, math.inf, 0.0], [0.1, -0.4, 0.3]),
            ([speed, -speed, math.nextafter(speed, 1.0)], [0.1, -0.4, 0.3]),
            ([-0.0, 0.0, -math.nextafter(speed, 1.0)], [-0.0, 0.0, -0.3]),
            (plan, [0.1, -0.4, 0.3]),
        ]
        sequences = []
        for class_name in cls.CLASSES:
            now, ops = START_S, []
            for velocity, load in inputs:
                for _ in range(2):
                    now += ADVANCE_PERIOD_S
                    ops.append({"op": "update", "velocity": velocity, "now": now, "load": load})
            sequences.append(
                cls.sequence("every malformed velocity and load", class_name, [0.01, 0.02, 0.5], [0.0, 0.1, 0.2], ops)
            )
        return sequences

    @classmethod
    def generated(cls, generator: random.Random, count: int) -> list[dict[str, Any]]:
        """Returns random sequences: plans that start, stop and reverse around the speed that counts as moving,
        updates that are regular, late, stalled or repeated, and loads and velocities that are no vectors."""
        sequences = []
        speed = FrictionFeedforward.MIN_MOVING_SPEED
        for index in range(count):
            class_name = "SO101FrictionFeedforward" if index % 2 else "FrictionFeedforward"
            joints = generator.choice([1, 2, 3, 5, 5, 6])
            magnitude = [generator.choice([0.0, 0.006, 0.016, 0.5, 1.0]) for _ in range(joints)]
            load_ratio = [generator.choice([0.0, 0.0, 0.0295, 0.2]) for _ in range(joints)]
            period = generator.choice([0.004, 0.02, 0.02])
            now = generator.choice([0.0, START_S])
            plan = [0.0] * joints
            ops: list[dict[str, Any]] = []
            for _ in range(generator.randint(15, 40)):
                roll = generator.random()
                if roll < 0.03:
                    ops.append({"op": "reset"})
                    continue
                now += generator.choices(
                    [period, 0.0, period * 0.3, 0.1, 0.1000001, 0.25, 5.0, -period], weights=[70, 4, 8, 4, 2, 4, 2, 6]
                )[0]
                if generator.random() < 0.25:
                    plan = [
                        generator.choice(
                            [
                                0.0,
                                0.0,
                                speed,
                                -speed,
                                math.nextafter(speed, 1.0),
                                -math.nextafter(speed, 1.0),
                                0.2,
                                -0.2,
                                0.001,
                            ],
                        )
                        for _ in range(joints)
                    ]
                velocity: Any = list(plan)
                odd = generator.random()
                if odd < 0.04:
                    velocity = None
                elif odd < 0.08:
                    velocity = [*plan[:-1], generator.choice([math.nan, math.inf])]
                elif odd < 0.12:
                    velocity = plan + [0.3]  # the planned velocity of a joint vector: the gripper's after the joints'
                elif odd < 0.15:
                    velocity = plan[:-1]
                load: Any = [round(generator.uniform(-0.6, 0.6), 4) for _ in range(joints)]
                odd = generator.random()
                if odd < 0.05:
                    load = None
                elif odd < 0.09:
                    load = [*load[:-1], math.nan]
                elif odd < 0.12:
                    load = load + [0.1]
                elif odd < 0.14:
                    load = [0.25]
                ops.append({"op": "update", "velocity": velocity, "now": now, "load": load})
            sequences.append(cls.sequence(f"generated {index}", class_name, magnitude, load_ratio, ops))
        return sequences

    @staticmethod
    def gravity(generator: random.Random, count: int) -> tuple[list[dict[str, Any]], GravityModel]:
        """Returns the gravity torque PEAR's model (pinocchio on the SO-101's description) gives joint vectors."""
        urdf = KinematicsConfig.__dataclass_fields__["urdf"].default
        model = GravityModel(urdf)
        defaults = OmegaConf.load(SO101Robot.CONFIG_PATH).robot
        lower, upper = list(defaults.limits.lower_bounds), list(defaults.limits.upper_bounds)
        vectors: list[list[Any]] = [
            [0.0] * 6,
            list(defaults.home.position),
            [0.0, -0.814, 0.077, 1.423, -1.613],
            list(SO101_REST),
            lower,
            upper,
            [0.2, -0.35, 0.55, 0.4, 0.3, 1.0],
        ]
        vectors += [[round(generator.uniform(low, high), 4) for low, high in zip(lower, upper)] for _ in range(count)]
        vectors += [[round(generator.uniform(-3.2, 3.2), 3) for _ in range(5)] for _ in range(count // 5)]
        vectors += [
            [0.1, 0.2, 0.3, 0.4], [0.3], [], [math.nan, 0.0, 0.0, 0.0, 0.0], [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]
        ]
        cases = [
            {"joints": plain(vector), "outcome": outcome(lambda vector=vector: model.torque(vector))}
            for vector in vectors
        ]
        return cases, model

    @staticmethod
    def offsets(robots: Robots, generator: random.Random, count: int) -> list[dict[str, Any]]:
        """Returns the goal offsets PEAR's Feedforward gives a target through moves and holds."""
        urdf = KinematicsConfig.__dataclass_fields__["urdf"].default
        station = robots.configs("so101_station")[1].feedforward
        settings = [
            dataclasses.asdict(station),
            # a typical task fit (test_so101_joint_in_station.py: COMPLIANCE and FRICTION)
            {
                "gravity_compliance": [0.0, 0.08, 0.10, 0.05, 0.0],
                "friction_offset_rad": [0.006, 0.016, 0.016, 0.008, 0.006],
                "friction_load_ratio": [0.0] * 5,
            },
            {"gravity_compliance": [0.0] * 5, "friction_offset_rad": [0.0] * 5, "friction_load_ratio": [0.0] * 5},
        ]
        for _ in range(count):
            settings.append(
                {
                    "gravity_compliance": [round(generator.uniform(0, 0.3), 3) for _ in range(5)],
                    "friction_offset_rad": [round(generator.uniform(0, 0.05), 4) for _ in range(5)],
                    "friction_load_ratio": [round(generator.uniform(0, 0.1), 4) for _ in range(5)],
                }
            )
        defaults = OmegaConf.load(SO101Robot.CONFIG_PATH).robot
        lower, upper = list(defaults.limits.lower_bounds), list(defaults.limits.upper_bounds)
        sequences = []
        for index, section in enumerate(settings):
            feedforward = Feedforward(FeedforwardConfig(**section), urdf)
            now = START_S
            target = [round(generator.uniform(low, high) * 0.6, 4) for low, high in zip(lower, upper)]
            steps = []
            for _ in range(generator.randint(18, 30)):
                now += generator.choice([0.02, 0.02, 0.02, 0.05, 0.3])
                roll = generator.random()
                if roll < 0.12:
                    step = {
                        "op": "hold_offset",
                        "target": list(target),
                        "outcome": outcome(lambda: feedforward.hold_offset(target)),
                    }
                else:
                    moving = roll < 0.7
                    velocity: Any = [
                        round(generator.choice([0.0, 0.3, -0.3, 0.004]) if moving else 0.0, 3) for _ in range(6)
                    ]
                    if moving:
                        target = [
                            round(min(max(value + 0.02 * speed, low), high), 5)
                            for value, speed, low, high in zip(target, velocity, lower, upper)
                        ]
                    if roll > 0.96:
                        velocity = None
                    step = {
                        "op": "offset",
                        "target": list(target),
                        "velocity": velocity,
                        "now": now,
                        "outcome": outcome(lambda: feedforward.offset(target, velocity, now)),
                    }
                steps.append(plain(step))
            sequences.append({"name": f"offsets {index}", "feedforward": section, "steps": steps})
        return sequences


class Meta:
    """What the fixtures were made from, and the constants of PEAR's classes that pear.js repeats."""

    @staticmethod
    def schemas() -> dict[str, Any]:
        enumerations = {
            cls.__name__: {member.name: member.value for member in cls}
            for cls in (
                schemas.RobotStatus,
                schemas.ControlState,
                schemas.MotionEndReason,
                schemas.RecoveryPhase,
                schemas.ActionPhase,
            )
        }
        dictionaries = {
            cls.__name__: list(cls.__annotations__)
            for cls in (
                schemas.CameraFrame, schemas.ArmFeedback, schemas.Arrival, schemas.Motion, schemas.RecoveryProgress,
                schemas.SnapshotFields, schemas.ControlSnapshot, schemas.DetailedStatus, schemas.BriefStatus,
                schemas.Observation, schemas.HomePlan, schemas.HomeReport,
            )  # fmt: skip
        }
        # a class that extends another holds the other's keys too
        for name, parent in (("ControlSnapshot", "SnapshotFields"), ("DetailedStatus", "SnapshotFields")):
            dictionaries[name] = dictionaries[parent] + [
                key for key in dictionaries[name] if key not in dictionaries[parent]
            ]
        return {
            "enumerations": enumerations,
            "moving_control_states": [state.value for state in schemas.MOVING_CONTROL_STATES],
            "dictionaries": dictionaries,
            "dataclasses": {
                cls.__name__: [field.name for field in dataclasses.fields(cls)]
                for cls in (schemas.Camera, schemas.ActionFormat)
            },
        }

    @staticmethod
    def errors() -> dict[str, list[str]]:
        """Returns each error class of the joint layer with the classes it extends, itself first."""
        classes = (
            ValueError,
            RuntimeError,
            TimeoutError,
            TypeError,
            ZeroDivisionError,
            IndexError,
            StabilityError,
            TrackingError,
            OperatorPaused,
        )
        return {
            cls.__name__: [base.__name__ for base in cls.__mro__ if base not in (object, BaseException)]
            for cls in classes
        }

    @classmethod
    def record(cls, robots: Robots, commit: str, gravity_model: GravityModel) -> dict[str, Any]:
        friction = FrictionFeedforward
        urdf = Path(KinematicsConfig.__dataclass_fields__["urdf"].default)
        layouts = {name: Layouts.record(config.LAYOUT) for name, _, config in robots.stations.values()}
        operator = None
        try:
            event = threading.Event()
            event.set()
            OperatorPaused.check_cancelled(event)
        except OperatorPaused as error:
            operator = str(error)
        return {
            "pear_commit": commit,
            "versions": {
                "python": sys.version.split()[0],
                **{name: importlib.metadata.version(name) for name in ("numpy", "omegaconf")},
                "pinocchio": sys.modules["pinocchio"].__version__,
            },
            "urdf": {"name": urdf.name, "sha256": hashlib.sha256(urdf.read_bytes()).hexdigest()},
            "gravity": {"vector": plain(gravity_model.model.gravity.linear), "joints": list(JOINTS)},
            "constants": {
                "joint_limits": {"epsilon": JointLimits.EPSILON, "cap_names": list(JointLimits.CAP_NAMES)},
                "joint_layout": {
                    "arm_label": JointLayout.ARM_LABEL,
                    "coordinate_label": JointLayout.COORDINATE_LABEL,
                    "joint_unit": JointLayout.JOINT_UNIT,
                    "gripper_unit": JointLayout.GRIPPER_UNIT,
                },
                "arm_state": {"clock_slack_s": ArmState.CLOCK_SLACK_S},
                "sample_window": {
                    "min_samples": SampleWindow.MIN_SAMPLES, "fresh_fraction": SampleWindow.FRESH_FRACTION
                },
                "stability_window": {
                    "velocity_mean": StabilityWindow.VELOCITY_MEAN,
                    "velocity_rms": StabilityWindow.VELOCITY_RMS,
                    "position_span": StabilityWindow.POSITION_SPAN,
                    "target_error_max": StabilityWindow.TARGET_ERROR_MAX,
                    "rate_suffix": StabilityWindow.RATE_SUFFIX,
                },
                "friction_feedforward": {
                    "min_moving_speed": friction.MIN_MOVING_SPEED,
                    "latch_s": friction.LATCH_S,
                    "fade_s": friction.FADE_S,
                    "engage_s": friction.ENGAGE_S,
                    "max_step_s": friction.MAX_STEP_S,
                },
                "robot_config": {"placeholder": RobotConfig.PLACEHOLDER},
                "so101": {
                    "arm_joint_length": so101_settings.ARM_JOINT_LENGTH,
                    "wrist_role": so101_settings.WRIST_ROLE,
                    "vector_length": VECTOR_LENGTH,
                    "gripper_index": GRIPPER_INDEX,
                },
                "operator_paused": operator,
            },
            "errors": cls.errors(),
            "schemas": cls.schemas(),
            "station_control": plain(OmegaConf.to_container(OmegaConf.load(BaseRobot.STATION_CONFIG_PATH).control)),
            "so101_defaults": plain(OmegaConf.to_container(OmegaConf.load(SO101Robot.CONFIG_PATH).robot)),
            "layouts": layouts,
            "stations": robots.record(),
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--scale", type=int, default=1, help="times as many generated cases (1: the committed set)")
    parser.add_argument("--output", type=Path, help="write there instead of tests/fixtures/station-joint")
    arguments = parser.parse_args()
    if arguments.scale < 1:
        sys.exit("--scale is a whole number of at least 1")
    if arguments.scale != 1 and arguments.output is None:
        sys.exit("The committed fixtures are the set of --scale 1: name another --output for a larger one")
    if arguments.output is not None:
        Fixtures.directory = arguments.output.resolve()
    scale = arguments.scale

    commit, pinned = Commit.of_pear(), Commit.pinned()
    if commit != pinned:
        sys.exit(
            f"This PEAR is at {commit or 'no commit that can be read (it is not a checkout)'}; "
            f"src/index.ts pins {pinned}",
        )

    clock = Clock().install()
    robots = Robots()

    def generator(name: str) -> random.Random:
        return random.Random(f"{SEED}-{name}")

    layout_cases: list[dict[str, Any]] = []
    for name, key in (("so101", "so101"), ("two_arm", "two_arm")):
        layout_cases += Layouts.cases(name, robots.configs(key)[1].LAYOUT, generator(f"layout-{name}"))
    Fixtures.write("layout.json", {"cases": layout_cases})

    Fixtures.write(
        "limits.json",
        {
            "cases": LimitCases.all(robots, generator("limits"), scale),
            "power_cases": LimitCases.powers(generator("powers"), 300 * scale),
        },
    )

    config_cases = ConfigCases(generator("config"))
    with tempfile.TemporaryDirectory() as directory:
        robot_cases = config_cases.robot_cases(Path(directory).resolve())
    Fixtures.write(
        "config.json",
        {
            # the valid settings each section case changes
            "sections": {name: plain(base) for name, (_, base) in config_cases.sections.items()},
            "section_cases": config_cases.section_cases(),
            "robot_cases": robot_cases,
            "placeholder_cases": config_cases.placeholder_cases(),
            "repr_cases": config_cases.repr_cases(),
        },
    )

    Fixtures.write(
        "stability.json",
        {
            "scenarios": StabilityScenarios(robots, clock, generator("stability")).all(scale),
            "window_scenarios": WindowCases.sample_windows(generator("windows"), 14 * scale),
            "error_cases": WindowCases.stability_errors(),
        },
    )

    Fixtures.write(
        "tracking.json",
        {
            "scenarios": [
                TrackingCases.of(key, robots.configs(key)[1], generator(f"tracking-{key}"), count * scale)
                for key, count in (("so101", 30), ("so101_quick", 12), ("two_arm", 8))
            ]
        },
    )

    arm_state_cases, fresh_cases = SnapshotCases.arm_states(robots, generator("arm-states"))
    Fixtures.write(
        "snapshots.json",
        {
            **SnapshotCases.checks(robots, clock),
            "arm_state_cases": arm_state_cases,
            "fresh_cases": fresh_cases,
            "poll_cases": SnapshotCases.polls(clock, generator("polls"), 14 * scale),
            "wait_cases": SnapshotCases.waits(clock, generator("waits"), 14 * scale),
            "guard_cases": SnapshotCases.guards(generator("guards"), 20 * scale),
        },
    )

    gravity_cases, gravity_model = FeedforwardCases.gravity(generator("gravity"), 160 * scale)
    Fixtures.write(
        "feedforward.json",
        {
            "constructor_cases": FeedforwardCases.constructors(),
            "sequences": FeedforwardCases.from_pear_tests()
            + FeedforwardCases.malformed()
            + FeedforwardCases.generated(generator("friction"), 24 * scale),
            "gravity_cases": gravity_cases,
            "offset_sequences": FeedforwardCases.offsets(robots, generator("offsets"), 5 * scale),
        },
    )

    Fixtures.write("meta.json", {"scale": scale, **Meta.record(robots, commit, gravity_model)})
    print(f"total: {Fixtures.total_bytes} bytes at --scale {scale}")


if __name__ == "__main__":
    main()
