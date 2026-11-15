"""Writes the fixtures of pear.js's joint control loop: what PEAR's own trajectory classes, operations, recovery
policies and control loops give, step by step, on the stand-in clock and the stand-in drivers of PEAR's own tests.
src/station/joint (trajectory.ts, operations.ts, recovery.ts, control_loop.ts) and src/so101/joint (control_loop.ts,
grippers.ts) port them, and tests/station-loop runs the same scripts on the port.

Run it with the Python of a PEAR station environment, from any directory; PEAR must be a checkout at the commit that
src/index.ts pins, because its test rig (tests/deploy/station) is imported from it:

    <work dir>/envs/station/bin/python tools/fixtures/loop_fixtures.py

It writes tests/fixtures/station-loop/ and nothing else (meta.json, trajectory.json, run.json and the scenarios of
the control loop, loops.json.gz: a scenario records the loop after every control period, which repeats itself). It
needs no device and no GPU. Everything is deterministic: fixed seeds, and PEAR reads the stand-in clock of its own
tests, which only a scenario moves. Every expected value is what PEAR's class returned or raised; the script holds
no rule of its own about what is right. A scenario is a script of operations that the script runs on PEAR as it
writes it, so that the next operation can be made from what PEAR holds then; the port replays the written script.

For a longer comparison that is not committed, write a larger set elsewhere and point the tests at it:

    <work dir>/envs/station/bin/python tools/fixtures/loop_fixtures.py --scale 8 --output <directory>
    PEAR_JS_LOOP_FIXTURES=<directory> npx vitest run tests/station-loop

The table of the reference's C library values that the exact comparison needs (libm.json beside the fixtures) is made
by tools/fixtures/ruckig_fixtures.py --libm, as tests/ruckig/oracle.ts describes.
"""

from __future__ import annotations

import argparse
import copy
import dataclasses
import gzip
import importlib.metadata
import json
import logging
import math
import platform
import random
import re
import sys
import tempfile
import threading
import time
from collections.abc import Callable, Sequence
from enum import Enum
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

import pear
import pear.deploy.station.control.joint.control_loop as control_loop_module
from pear.deploy.station.control.joint.action_guard import ActionGuard
from pear.deploy.station.control.joint.arm_state import ArmState
from pear.deploy.station.control.joint.config import ControlConfig, MotionLimits, RobotConfig
from pear.deploy.station.control.joint.control_loop import Braking, JointControlLoop
from pear.deploy.station.control.joint.layout import JointLayout
from pear.deploy.station.control.joint.operations import (
    GripperEndpointTimeout,
    JointMoveOperation,
    SequenceOperation,
)
from pear.deploy.station.control.joint.recovery import MeasuredHoldRecovery, RecoveryRequest, ReleaseRecovery
from pear.deploy.station.control.joint.trajectory import GripperProfile, JointMove, JointTrajectory
from pear.deploy.station.control.robots.so101.config import SO101Config
from pear.deploy.station.control.robots.so101.hardware.arm_state import ServoFault
from pear.deploy.station.control.robots.so101.joint.grippers import SO101GripperOperation
from pear.deploy.station.control.robots.so101.layout import ARM, GRIPPER_INDEX
from pear.deploy.station.control.schemas import MOVING_CONTROL_STATES, RecoveryPhase

REPOSITORY = Path(__file__).resolve().parents[2]
FIXTURES = REPOSITORY / "tests" / "fixtures" / "station-loop"
PEAR_PACKAGE = Path(pear.__file__).resolve().parent
PEAR_STATION_TESTS = PEAR_PACKAGE.parent / "tests" / "deploy" / "station"  # PEAR's own tests of the station
SEED = 20261115

if not (PEAR_STATION_TESTS / "control_rig.py").is_file():
    sys.exit("This PEAR has no tests/deploy/station: run from a checkout of PEAR, not an installed package")
sys.path.insert(0, str(PEAR_STATION_TESTS))

# PEAR's own rig of its tests of the control loop: the stand-in clock, the ticker, the stepped loops, the stand-in
# drivers, and the driver in memory and the generic loop that test_joint_control_in_station.py makes for each layout
import test_joint_control_in_station as pear_tests  # noqa: E402
from config_files import ConfigFiles  # noqa: E402
from control_rig import Robots, StandInClock, Ticker  # noqa: E402
from stand_in_joint_driver import StandInSO101Driver, StandInYAMDriver  # noqa: E402
from stand_in_robots import SteppedSO101ControlLoop, SteppedYAMControlLoop  # noqa: E402

# What PEAR's tests of the SO-101's arm change of its station of the tests besides its quick settings
# (tests/deploy/station/test_so101_joint_in_station.py: ZERO_HOME_OVERRIDE and ARM_TEST_OVERRIDES)
SO101_ARM_TEST_OVERRIDES = (
    "robot.home.position=[0.0, 0.0, 0.0, 0.0, 0.0, 1.0]",
    "robot.home.joint_tolerance=[0.035, 0.035, 0.035, 0.035, 0.035]",
    "robot.position_tolerance=0.035",
    "robot.feedback_position_tolerance=0.05",
    "robot.feedforward=null",
)
# What PEAR's test of enabling changes of the two arms' station with the wide limits
# (test_enable_waits_for_stable_feedback_but_times_out_on_persistent_motion)
ENABLE_OVERRIDES = (
    "control.settle_timeout_s=0.2",
    "control.settle_window_s=0.1",
    "robot.gripper_contact_confirm_s=0.1",
    "robot.velocity_tolerance=0.03",
)
# What makes an arm of the two take position-only commands: no planned velocity, so no friction fed along it either
UNFED_OVERRIDES = {
    arm: (
        f"robot.arms.{arm}.uses_velocity_feedforward=false",
        f"robot.arms.{arm}.friction_feedforward_nm=[0, 0, 0, 0, 0, 0]",
        f"robot.arms.{arm}.friction_load_ratio=[0, 0, 0, 0, 0, 0]",
    )
    for arm in ("left", "right")
}
ERRORS = {
    error_class.__name__: error_class
    for error_class in (RuntimeError, ValueError, TimeoutError, OSError, KeyboardInterrupt, ServoFault)
}
MOST_TICKS = 2000  # the most control periods an operation may take, as in PEAR's tests


class LogCapture(logging.Handler):
    """Keeps what PEAR's control loop logs (a request, an end of motion, a fault): the level, in lower case, and the
    message of each record since the last one taken. pear.js's loop tells its ``log`` the same."""

    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.lines: list[list[str]] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append([record.levelname.lower(), record.getMessage()])

    def take(self) -> list[list[str]]:
        """Returns the lines since the last time, and forgets them."""
        lines, self.lines = self.lines, []
        return lines

    def install(self) -> None:
        """Has no logger of PEAR write to the terminal, and the control loop's write here."""
        logging.getLogger().addHandler(logging.NullHandler())
        for name, logger in logging.root.manager.loggerDict.items():
            if name.startswith("pear") and isinstance(logger, logging.Logger):
                logger.handlers = [logging.NullHandler()]
        control_loop_module.logger.handlers = [self]
        control_loop_module.logger.setLevel(logging.INFO)


LOGS = LogCapture()


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
    if isinstance(value, (list, tuple)):
        return [plain(child) for child in value]
    if isinstance(value, dict):
        return {str(key): plain(child) for key, child in value.items()}
    if isinstance(value, Path):
        return value.name
    if dataclasses.is_dataclass(value):
        return plain(dataclasses.asdict(value))
    raise TypeError(f"No JSON form for {type(value).__name__}")


def number(value: Any) -> float:
    """Returns the number a script holds: itself, or the one ``{"$": "nan"}`` stands for."""
    if isinstance(value, dict):
        return {"nan": math.nan, "inf": math.inf, "-inf": -math.inf}[value["$"]]
    return value


def numbers(values: Sequence[Any]) -> list[float]:
    return [number(value) for value in values]


def outcome(call: Callable[[], Any], shown: Callable[[Any], Any] = plain) -> dict[str, Any]:
    """Returns what ``call`` returned, under ``ok``, or the class and the message of what it raised, under
    ``error``: the two things PEAR's station reports of a failure."""
    try:
        return {"ok": shown(call())}
    except (SystemExit, GeneratorExit):
        raise
    except BaseException as error:  # the class is the fixture: the station reports it as the error's code
        return {"error": {"type": type(error).__name__, "message": str(error)}}


def delta(previous: Any, current: Any) -> Any:
    """Returns ``current`` as what changed of ``previous``: for two objects of the same keys in the same order,
    ``{"~": {key: change}}`` of the keys whose values differ; otherwise ``current`` itself."""
    if isinstance(previous, dict) and isinstance(current, dict) and list(previous) == list(current):
        return {"~": {key: delta(previous[key], current[key]) for key in current if previous[key] != current[key]}}
    return current


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
    def write(cls, name: str, content: dict[str, Any], *, is_compressed: bool = False) -> None:
        """Writes one file: an object whose lists of cases (a key that ends in ``cases``, ``sessions`` or
        ``scenarios``) hold one item a line; with ``is_compressed``, as gzip of that text (``name`` + .gz)."""
        cls.directory.mkdir(parents=True, exist_ok=True)
        entries = []
        counts = []
        for key, value in content.items():
            if isinstance(value, list) and key.endswith(("cases", "sessions", "scenarios")):
                rows = ",\n".join("  " + json.dumps(row, ensure_ascii=True, separators=(",", ":")) for row in value)
                entries.append(f" {json.dumps(key)}: [\n{rows}\n ]")
                counts.append(f"{len(value)} {key}")
            else:
                entries.append(f" {json.dumps(key)}: {json.dumps(value, ensure_ascii=True)}")
        text = "{\n" + ",\n".join(entries) + "\n}\n"
        json.loads(text, parse_constant=cls.refuse_constant)  # (raises unless the file is JSON)
        cls.check_private(name, text)
        data = text.encode("ascii")
        if is_compressed:
            name += ".gz"
            data = gzip.compress(data, compresslevel=9, mtime=0)  # (no time of this run in the file)
        (cls.directory / name).write_bytes(data)
        cls.total_bytes += len(data)
        size = f"{len(data)} bytes" + (f" ({len(text)} of JSON)" if is_compressed else "")
        print(f"{name}: {size}; {', '.join(counts) or 'no cases'}")

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


class Stations:
    """The configurations PEAR's control loops run on here: the stations of PEAR's own tests, of the SO-101 and of
    the two YAM arms, with the settings its tests give them. The YAM robot is not ported; its station is here because
    it is PEAR's own layout of two arms, on which PEAR's tests run the generic control loop."""

    def __init__(self) -> None:
        self.stations: dict[str, tuple[str, ControlConfig, RobotConfig]] = {}
        quick = ConfigFiles.SO101_QUICK_OVERRIDES
        # the SO-101's station of PEAR's tests, as the tests of the control loop load it
        self.add("so101_station", "so101")
        # with the short settle windows and the fast caps of the tests of its arm (conftest.py: so101_config)
        self.add("so101_quick_home", "so101", *quick)
        # and with Home at zero, the tolerances of test_so101_joint_in_station.py and no feedforward
        self.add("so101_quick", "so101", *quick, *SO101_ARM_TEST_OVERRIDES)
        # both YAM arms with the wide limits of the tests of the control loop, and as their station ships them
        self.add("two_arm", "yam", *ConfigFiles.WIDE_LIMITS["yam"])
        self.add("two_arm_station", "yam")
        self.add("two_arm_enable", "yam", *ConfigFiles.WIDE_LIMITS["yam"], *ENABLE_OVERRIDES)
        # with the wide limits and the left arm, or both arms, not fed the planned velocity
        self.add("two_arm_left_unfed", "yam", *ConfigFiles.WIDE_LIMITS["yam"], *UNFED_OVERRIDES["left"])
        unfed = (*UNFED_OVERRIDES["left"], *UNFED_OVERRIDES["right"])
        self.add("two_arm_unfed", "yam", *ConfigFiles.WIDE_LIMITS["yam"], *unfed)

    def add(self, key: str, robot_name: str, *overrides: str) -> str:
        """Makes the station ``key`` of the tests' station of ``robot_name`` with ``overrides``, once."""
        if key not in self.stations:
            layout_name = "so101" if robot_name == "so101" else "two_arm"
            self.stations[key] = (layout_name, *ConfigFiles.load_configs(robot_name, *overrides))
        return key

    def configs(self, key: str) -> tuple[ControlConfig, RobotConfig]:
        """Returns copies of the two configurations of the station ``key``."""
        _, control_config, robot_config = self.stations[key]
        return copy.deepcopy(control_config), copy.deepcopy(robot_config)

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
        tolerances = ("position_tolerance", "gripper_tolerance", "feedback_position_tolerance", "velocity_tolerance")
        home_names = ("speed_scale", "limits", "settle_window_s", "arrival_timeout_s")
        limit_names = ("velocity", "acceleration", "jerk", "lower_bounds", "upper_bounds", "tracking_error")
        return {
            **{name: getattr(robot_config, name) for name in tolerances},
            "home": None if home is None else {name: plain(getattr(home, name)) for name in home_names},
            "arm_limits": {
                arm: {name: list(getattr(limits, name)) for name in limit_names}
                for arm, limits in robot_config.arm_limits().items()
            },
        }

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
                "joint_limits": {field.name: plain(getattr(limits, field.name)) for field in dataclasses.fields(limits)},
                "braking_caps": plain(limits.braking_caps()),
                "motion_caps": plain(limits.motion_caps()),
                "feeds_velocity": {arm: robot_config.feeds_velocity(arm) for arm in robot_config.LAYOUT.arms},
                "rest": plain(Robots.rest(robot_config)),
            }

        return stations


def make_error(spec: dict[str, Any]) -> BaseException:
    """Returns the exception a script names by its class and its message."""
    return ERRORS[spec["type"]](spec.get("message", ""))


def motion_caps(spec: dict[str, Any] | None) -> Any:
    """Returns the caps of one arm a script gives: None, or what holds a velocity, an acceleration and a jerk list
    (PEAR reads no more of a MotionLimits; one a script makes may hold values a MotionLimits would refuse)."""
    return None if spec is None else SimpleNamespace(**{name: list(values) for name, values in spec.items()})


class Probe:
    """Stands between a control loop and its driver: it records every call the loop makes of the driver, in order,
    and makes the driver misbehave as a scenario scripts it. A call that a scenario does not tamper with reaches
    PEAR's stand-in unchanged.

    A call is recorded as "r" (read), "R" (read_for_recovery), "h" (refresh_hold), "c" (close) or
    ["s", targets, velocities] (send: both as joint vectors, the velocities null when none were given); a call that
    raised as [code + "!", ..., class, message]."""

    CODES = {"read": "r", "read_for_recovery": "R", "send": "s", "refresh_hold": "h", "close": "c"}

    def __init__(self, driver: Any, layout: JointLayout, clock: StandInClock, kind: str, period_s: float) -> None:
        self.driver, self.layout, self.clock, self.kind, self.period_s = driver, layout, clock, kind, period_s
        self.calls: list[Any] = []  # since the last record
        self.send_count = 0
        self.tampers: dict[str, list[dict[str, Any]]] = {name: [] for name in self.CODES}
        self.real = {name: getattr(driver, name) for name in self.CODES}
        for name in self.CODES:
            setattr(driver, name, self.wrapped(name))

    def take(self) -> list[Any]:
        """Returns the calls since the last time, and forgets them."""
        calls, self.calls = self.calls, []
        return calls

    def wrapped(self, name: str) -> Callable[..., Any]:
        def call(*arguments: Any) -> Any:
            entry: Any = self.CODES[name]
            if name == "send":
                self.send_count += 1
                velocities = arguments[1] if len(arguments) > 1 else None
                entry = ["s", self.vector(arguments[0]), None if velocities is None else self.vector(velocities)]
            try:
                result = self.apply(name, arguments)
            except BaseException as error:
                failed = entry if isinstance(entry, list) else [entry]
                self.calls.append([failed[0] + "!", *failed[1:], type(error).__name__, str(error)])
                raise
            self.calls.append(entry)
            return result

        return call

    def vector(self, arm_values: dict[str, Sequence[float]]) -> Any:
        if list(arm_values) == list(self.layout.arms):
            return plain(self.layout.join(arm_values))
        return plain(arm_values)  # (not the layout's arms in their order: as it is)

    def active(self, name: str) -> list[dict[str, Any]]:
        """Returns the tampers that apply to this call of ``name``, each counted."""
        applying = []
        for tamper in self.tampers[name]:
            tamper["seen"] += 1
            after_skip = tamper["seen"] - tamper.get("skip", 0)
            if after_skip >= 1 and (tamper.get("times") is None or after_skip <= tamper["times"]):
                tamper["count"] += 1
                applying.append(tamper)
        return applying

    def apply(self, name: str, arguments: tuple[Any, ...]) -> Any:
        tampers = self.active(name)
        for tamper in tampers:
            if tamper["kind"] == "advance_clock":
                self.clock.now += tamper["seconds"]
        if name == "send":
            return self.send(tampers, arguments)
        for tamper in tampers:
            if tamper["kind"] == "raise":
                raise make_error(tamper)
        result = self.real[name](*arguments)
        if name in ("read", "read_for_recovery"):
            for tamper in tampers:
                result = self.tampered(tamper, result)
        return result

    def send(self, tampers: list[dict[str, Any]], arguments: tuple[Any, ...]) -> None:
        targets = arguments[0]
        for tamper in tampers:
            if tamper["kind"] == "partial":  # one arm takes its target, then the write fails
                self.set_position(tamper["arm"], tuple(targets[tamper["arm"]]))
                raise make_error(tamper)
            if tamper["kind"] == "raise":
                raise make_error(tamper)
        if not any(tamper["kind"] == "ignore" for tamper in tampers):  # ignore: the arms stay where they are
            self.real["send"](*arguments)
        for tamper in tampers:
            if tamper["kind"] == "bias":  # the arm rests off its target
                position = list(self.position(tamper["arm"]))
                position[tamper["index"]] += tamper["delta"]
                self.set_position(tamper["arm"], tuple(position))

    def tampered(self, tamper: dict[str, Any], states: dict[str, ArmState]) -> dict[str, ArmState]:
        """Returns the reading ``states`` changed as ``tamper`` says."""
        kind = tamper["kind"]
        arms = [tamper["arm"]] if tamper.get("arm") is not None else list(states)

        def changed(field: str, index: int | None, value: Any) -> None:
            for arm in arms:
                values = list(getattr(states[arm], field))
                if index is None:
                    values = numbers(value)
                else:
                    values[index] = number(value)
                states[arm] = dataclasses.replace(states[arm], **{field: tuple(values)})

        if kind == "drop":
            del states[tamper["arm"]]
        elif kind in ("position", "velocity"):
            changed(kind, tamper.get("index"), tamper["values"] if "values" in tamper else tamper["value"])
        elif kind == "sample_id":
            for arm in arms:
                states[arm] = dataclasses.replace(states[arm], sample_id=tamper["value"])
        elif kind == "alternate":
            if tamper["by"] == "clock":  # as PEAR's tests: by the parity of the control period
                is_odd = round((self.clock.now - StandInClock.START_S) / self.period_s) % 2
                value = tamper["magnitude"] if is_odd else -tamper["magnitude"]
            else:
                value = tamper["magnitude"] * (-1) ** tamper["count"]
            changed(tamper["field"], tamper["index"], value)
        elif kind == "drift":
            changed("position", tamper["index"], (self.clock.now - tamper["since"]) * tamper["rate"])
        elif kind == "sequence":  # the n-th reading takes the n-th value, a later one the last
            values = tamper["values"]
            changed(tamper["field"], tamper["index"], values[min(tamper["count"], len(values)) - 1])
        elif kind == "reverse":
            states = dict(reversed(states.items()))
        elif kind == "stamp":
            for arm in arms:
                stamp = states[arm].sampled_monotonic_s + tamper["offset"]
                states[arm] = dataclasses.replace(states[arm], sampled_monotonic_s=stamp)
        elif kind == "servo":
            for arm in arms:
                states[arm] = dataclasses.replace(states[arm], servo_status=copy.deepcopy(tamper["status"]))
        elif kind != "advance_clock":
            raise ValueError(f"No tamper {kind}")

        return states

    def position(self, arm: str) -> tuple[float, ...]:
        """Returns where the stand-in holds ``arm``."""
        return self.driver.hardware.position if self.kind == "so101" else self.driver.positions[arm]

    def set_position(self, arm: str, position: tuple[float, ...]) -> None:
        if self.kind == "so101":
            self.driver.hardware.position = position
        else:
            self.driver.positions = {**self.driver.positions, arm: position}


class Responses:
    """What a stand-in SO-101 arm reaches for a commanded goal from its position, by the name a script gives."""

    @staticmethod
    def make(spec: dict[str, Any] | None) -> Callable[[tuple[float, ...], tuple[float, ...]], Sequence[float]] | None:
        if spec is None:
            return None
        kind = spec["kind"]

        def min_gripper(goal: tuple[float, ...], position: tuple[float, ...]) -> Sequence[float]:
            # the jaw opens no further than a limit (test_jaw_that_never_arrives_faults)
            return (*goal[:GRIPPER_INDEX], min(goal[GRIPPER_INDEX], spec["limit"]))

        def sag(goal: tuple[float, ...], position: tuple[float, ...]) -> Sequence[float]:
            # a P-only servo: it rests ``sag`` below its goal, anywhere within +-``friction`` of that, and moves
            # only when pushed out of that band (the servo of test_so101_joint_in_station.py with a constant load)
            reached = list(goal)
            for index in range(GRIPPER_INDEX):
                centre = goal[index] - spec["sag"][index]
                low, high = centre - spec["friction"][index], centre + spec["friction"][index]
                reached[index] = min(max(position[index], low), high)
            return reached

        def lag(goal: tuple[float, ...], position: tuple[float, ...]) -> Sequence[float]:
            # each joint covers a share of what separates it from its goal
            reached = list(goal)
            for index in range(GRIPPER_INDEX):
                reached[index] = position[index] + spec["gain"] * (goal[index] - position[index])
            return reached

        return {"min_gripper": min_gripper, "sag": sag, "lag": lag}[kind]


class Scenario:
    """One control loop of PEAR on a stand-in driver and the stand-in clock, and the script that drives it: every
    operation runs on PEAR at once and is written with what PEAR did, so that pear.js can repeat the script and must
    get the same record.

    After every control period and every other operation the record holds the driver's calls since the last record
    (``io``, see Probe), what the loop logged since then, if anything (``log``, see LogCapture), and the loop's state
    (``s``): its whole snapshot and what else the loop keeps of its operation, as what changed since the record
    before (see ``delta``)."""

    def __init__(self, name: str, source: str, stations: Stations, monkeypatch: pytest.MonkeyPatch) -> None:
        self.name, self.source, self.stations, self.monkeypatch = name, source, stations, monkeypatch
        self.clock = StandInClock().install(monkeypatch)
        LOGS.take()  # (what the scenario before logged after its last record)
        self.loop: JointControlLoop | None = None
        self.driver: Any = None
        self.probe: Probe | None = None
        self.ticker: Ticker | None = None
        self.rig_record: dict[str, Any] = {}
        self.init: dict[str, Any] = {}
        self.ops: list[dict[str, Any]] = []
        self.previous_state: Any = None
        self.events: dict[str, Any] = {}
        self.observations: dict[str, Any] = {}
        self.guards: dict[str, ActionGuard] = {}
        self.gripper_operation: Any = None
        self.tick_count = 0
        self.kind = ""
        self.layout: JointLayout | None = None
        self.control_config: ControlConfig | None = None

    # -- the rig

    def rig(
        self,
        kind: str,
        station: str,
        *,
        start: Sequence[float] | None = None,
        recovery: str = "MeasuredHoldRecovery",
        braking: str = "station_limits",
        checks_velocity_rms: bool = False,
        before: Sequence[dict[str, Any]] = (),
        sleeps_while_enabling: bool = True,
    ) -> bool:
        """Makes the stand-in driver and, on it, the control loop, after the operations ``before`` on the driver;
        returns whether the loop was made. ``kind``: "so101" (PEAR's SO-101 loop on its own driver over the stand-in
        arm), "two_arm" (PEAR's loop of the two YAM arms on their stand-in joints) or "memory" (the generic loop on
        the driver in memory of PEAR's tests, with the recovery policy, the braking and the window a scenario
        names)."""
        control_config, robot_config = self.stations.configs(station)
        layout = robot_config.LAYOUT
        if kind == "so101":
            driver, loop_class = StandInSO101Driver(control_config, robot_config), SteppedSO101ControlLoop
        elif kind == "two_arm":
            driver, loop_class = StandInYAMDriver(control_config, robot_config), SteppedYAMControlLoop
        else:
            start = Robots.rest(robot_config) if start is None else tuple(start)
            driver = pear_tests.MemoryDriver(layout, start)
            loop_class = type(
                "MemoryControlLoop",
                (JointControlLoop,),
                {
                    "GRIPPER_OPERATION_CLASS": pear_tests.NoGripper,
                    "RECOVERY_POLICY_CLASS": {"MeasuredHoldRecovery": MeasuredHoldRecovery, "ReleaseRecovery": ReleaseRecovery}[recovery],
                    "BRAKING": Braking(braking),
                    "CHECKS_VELOCITY_RMS": checks_velocity_rms,
                },
            )

        self.driver = driver
        self.kind = kind
        self.layout = layout
        self.control_config = control_config
        self.probe = Probe(driver, layout, self.clock, kind, control_config.control_period_s)
        self.rig_record = {
            "kind": kind,
            "station": station,
            "start": None if start is None else plain(start),
            # what the loop's class names: read of PEAR's class, which pear.js's must name the same
            "recovery": loop_class.RECOVERY_POLICY_CLASS.__name__,
            "braking": loop_class.BRAKING.value,
            "checks_velocity_rms": loop_class.CHECKS_VELOCITY_RMS,
            "before": [],
            "sleeps_while_enabling": sleeps_while_enabling,
        }
        for operation in before:
            self.rig_record["before"].append(self.execute(dict(operation), records=False))

        with self.monkeypatch.context() as patch:
            if not sleeps_while_enabling:  # the readings alone move the clock
                patch.setattr(time, "sleep", lambda _: None)
            made = outcome(lambda: loop_class(driver, control_config, robot_config), shown=lambda loop: loop)
        if "error" in made:
            self.init = {"out": made, "rec": self.record()}
            return False

        self.loop = made["ok"]
        self.ticker = Ticker(self.loop, self.clock)
        self.init = {"out": {"ok": None}, "rec": self.record()}
        return True

    # -- what a record holds

    def state(self) -> dict[str, Any]:
        loop = self.loop
        trajectory_input = loop.trajectory.input
        operation = loop.operation
        kept: dict[str, Any] = {
            "operation": None if operation is None else type(operation).__name__,
            "settled": loop._is_settled,
            "deadline": loop._operation_deadline,
            "settle_since": loop._settle_since,
            "duration": loop.trajectory.duration_s,
            "target": list(trajectory_input.target_position),
            "interface": trajectory_input.control_interface.name,
            "speed": max(abs(velocity) for velocity in trajectory_input.current_velocity),
            "acceleration": max(abs(acceleration) for acceleration in trajectory_input.current_acceleration),
            "hold_error": loop._fault_hold_error,
            "blocked": loop._blocked_gripper_openings,
            "cancellation": loop.operation_cancellation is not None,
            # until when the recovery that is under way may take, which a release moves: null without one
            "recovery_deadline": None if loop._recovery_request is None else loop._recovery_request.deadline,
            "progress": None,
        }
        if isinstance(operation, JointMoveOperation):
            kept["progress"] = {"elapsed": operation.elapsed_s}
        elif isinstance(operation, SequenceOperation):
            kept["progress"] = {"index": operation.index, "phase": operation.row_phase, "start": operation.start_time}
        elif isinstance(operation, SO101GripperOperation):
            kept["progress"] = self.gripper_progress(operation)

        return {"snapshot": plain(loop.snapshot()), "loop": plain(kept)}

    @staticmethod
    def gripper_progress(operation: SO101GripperOperation) -> dict[str, Any]:
        return {
            "outcome": None if operation.outcome is None else operation.outcome.value,
            "samples": operation.sample_count,
            "finished_at": operation.finished_at,
            "report": operation.opening_report,
            "blocked": operation.blocked_gripper_openings,
            "window": len(operation.rest_window.samples),
        }

    def record(self) -> dict[str, Any]:
        """Returns the driver's calls since the last record, what the loop logged since then, if anything (``log``:
        each line's level and message), and what changed of the loop's state."""
        entry: dict[str, Any] = {"io": self.probe.take()}
        log = LOGS.take()
        if log:
            entry["log"] = log
        if self.loop is not None:
            state = self.state()
            entry["s"] = delta(self.previous_state, state)
            self.previous_state = state
        return entry

    def end(self) -> dict[str, Any]:
        """Returns the loop's planned state at the end of the script, in full."""
        trajectory_input = self.loop.trajectory.input
        names = (
            "current_position", "current_velocity", "current_acceleration", "target_position", "target_velocity",
            "target_acceleration", "max_velocity", "max_acceleration", "max_jerk",
        )
        return {
            **{name: plain(getattr(trajectory_input, name)) for name in names},
            "control_interface": trajectory_input.control_interface.name,
            "generation": self.loop.generation,
            "status": self.loop.status.value,
            "ticks": self.tick_count,
        }

    def result(self) -> dict[str, Any]:
        scenario = {"name": self.name, "source": self.source, "rig": self.rig_record, "init": self.init, "ops": self.ops}
        if self.loop is not None:
            scenario["end"] = self.end()
            self.loop.close()
        return scenario

    # -- operations: each runs on PEAR now and is written with its record

    def add(self, operation: dict[str, Any]) -> dict[str, Any]:
        self.ops.append(self.execute(operation))
        return self.ops[-1]

    def tick(self, count: int = 1, *, period_s: float | None = None) -> None:
        """Advances the clock by one control period (or ``period_s``) and steps, ``count`` times."""
        for _ in range(count):
            previous = self.ops[-1] if self.ops else None
            if previous is not None and previous["op"] == "tick" and previous["period_s"] == period_s:
                self.ticker.tick(period_s=period_s)
                self.tick_count += 1
                previous["n"] += 1
                previous["rec"].append(self.record())
            else:
                self.add({"op": "tick", "n": 1, "period_s": period_s})

    def until(self, statuses: Sequence[str], *, most: int = MOST_TICKS) -> int:
        """Steps until the loop's status is one of ``statuses``, and returns the steps taken."""
        for step in range(most):
            if self.loop.status in statuses:
                return step
            self.tick()
        raise AssertionError(f"{self.name}: still {self.loop.status} after {most} steps")

    def until_hold(self) -> int:
        """Steps until the loop neither runs nor stops an operation (PEAR's Ticker.until_hold)."""
        return self.until([status for status in ("HOLD", "FAULT", "CLOSED")])

    def finish(self) -> None:
        """Steps at least once, until the operation ends in a HOLD or a FAULT (the ``finish`` of PEAR's tests)."""
        self.tick()
        self.until(["HOLD", "FAULT"])

    def until_settled(self, most: int = MOST_TICKS) -> None:
        for _ in range(most):
            if self.loop.snapshot()["arrival"]["settled"]:
                return
            self.tick()
        raise AssertionError(f"{self.name}: not settled after {most} steps")

    def call(self, method: str, **arguments: Any) -> dict[str, Any]:
        """Calls a method of the loop and returns what it returned or raised."""
        return self.add({"op": "call", "method": method, "args": plain(arguments)})["out"]

    def wait(self, method: str, hooks: Sequence[dict[str, Any]] = (), **arguments: Any) -> dict[str, Any]:
        """Calls a method of the loop that waits (recover, wait_for_hold, shutdown): every sleep of the wait
        advances the clock and steps the loop, as the stand-in clock of PEAR's tests does, with ``hooks`` run
        before or after the step."""
        operation = {"op": "wait", "method": method, "args": plain(arguments), "hooks": plain(list(hooks))}
        return self.add(operation)["out"]

    def do(self, op: str, **fields: Any) -> dict[str, Any]:
        """Runs any other operation: see ``execute``."""
        return self.add({"op": op, **plain(fields)})

    def jog(self, arm: str | None, joint_number: int | None, delta: float, **options: Any) -> dict[str, Any]:
        """Moves joint ``joint_number``, counted from 1, of ``arm`` by ``delta`` from the held targets (every arm
        without a name, every coordinate without a number), and returns what the move returned or raised."""
        index = None if joint_number is None else joint_number - 1
        return self.do("jog", arm=arm, index=index, delta=delta, **options)["out"]

    def set(self, name: str, value: Any, target: str = "driver") -> None:
        """Sets an attribute of the stand-in driver (or of the SO-101's stand-in arm)."""
        self.do("set", target=target, name=name, value=value)

    def tamper(self, method: str, kind: str, **spec: Any) -> None:
        """Makes a method of the driver misbehave from now on: see Probe."""
        self.do("tamper", method=method, spec={"kind": kind, **spec})

    def fault_by_stale_feedback(self) -> None:
        """Faults the loop where it is, by one period of stale feedback, and makes the feedback fresh again (the
        ManualRecovery.fault of PEAR's tests)."""
        self.set("is_stale", True, "arm" if self.kind == "so101" else "driver")
        self.tick()
        self.set("is_stale", False, "arm" if self.kind == "so101" else "driver")

    def push(self, displacement: float) -> None:
        """Pushes the first arm's first joint while the arms stay where they are (JointRuntimeRig.push)."""
        self.set("is_following", False)
        self.do("shift", arm=self.layout.arms[0], index=0, delta=displacement)
        self.tick()

    def displaced_hold(self, displacement: float) -> None:
        """Faults the loop while a load keeps the right arm away from its command, which the arms no longer follow
        (ManualRecovery.displaced_hold)."""
        self.fault_by_stale_feedback()
        self.do("position", arm="right", values=[displacement, 0.0, 0.0, 0.0, 0.0, 0.0, 0.2])
        self.tamper("send", "ignore")

    def held(self) -> list[float]:
        """Returns the held targets as one vector."""
        return [float(value) for value in self.layout.join(self.loop.targets)]

    # -- the interpreter of an operation, which pear.js's player mirrors

    def execute(self, operation: dict[str, Any], records: bool = True) -> dict[str, Any]:
        op = operation["op"]
        if op == "tick":
            operation["rec"] = []
            for _ in range(operation["n"]):
                self.ticker.tick(period_s=operation["period_s"])
                self.tick_count += 1
                operation["rec"].append(self.record())
            return operation
        if op == "wait":
            return self.execute_wait(operation)

        if op == "until":  # steps until the loop's status is one of some: written as the control periods it took
            statuses = operation.pop("statuses")
            operation.update({"op": "tick", "n": 0, "period_s": None, "rec": []})
            while self.loop.status not in statuses:
                if operation["n"] >= MOST_TICKS:
                    raise AssertionError(f"{self.name}: still {self.loop.status} after {MOST_TICKS} steps")
                self.ticker.tick()
                self.tick_count += 1
                operation["n"] += 1
                operation["rec"].append(self.record())
            return operation
        if op == "tick_at":  # steps at each of the clock's readings given
            operation["rec"] = []
            for now in operation["times"]:
                self.clock.now = now
                self.loop.step()
                self.tick_count += 1
                operation["rec"].append(self.record())
            return operation

        if op == "step":
            self.loop.step()
        elif op == "jog":  # as ControlHelpers.jog of PEAR's tests: the held targets with some coordinates moved
            targets = {arm: list(target) for arm, target in self.loop.targets.items()}
            for arm in targets if operation["arm"] is None else [operation["arm"]]:
                for index in range(len(targets[arm])) if operation["index"] is None else [operation["index"]]:
                    targets[arm][index] += number(operation["delta"])
            # (tuples, as PEAR's own commands give a move its targets: the loop logs them as they are given)
            targets = {arm: tuple(target) for arm, target in targets.items()}
            options = {"speed_scale": operation["speed_scale"]} if "speed_scale" in operation else {}
            guard = self.guards.get(operation.get("guard"))
            if guard is not None:
                operation["out"] = outcome(lambda: guard.submit(self.loop.move, targets, **options))
            else:
                operation["out"] = outcome(lambda: self.loop.move(targets, **options))
        elif op == "shift":  # the stand-in holds an arm (every arm without a name) elsewhere by a step
            for arm in self.layout.arms if operation["arm"] is None else [operation["arm"]]:
                position = list(self.probe.position(arm))
                position[operation["index"]] += operation["delta"]
                self.probe.set_position(arm, tuple(position))
        elif op == "submit":  # a method of the loop through an action's guard, which adopts what it starts
            guard = self.guards[operation["guard"]]
            if operation["method"] == "begin_grippers":
                operation["out"] = outcome(lambda: type(guard.submit(self.loop.begin_grippers, operation["request"])).__name__)
            else:
                operation["out"] = outcome(lambda: guard.submit(self.loop.stop))
            operation["dispatched"] = guard.has_dispatched
        elif op == "clock":
            if "to" in operation:  # onto the deadline of the recovery that is under way
                self.clock.now = {"recovery_deadline": self.loop._recovery_request.deadline}[operation["to"]]
            elif "set" in operation:
                self.clock.now = operation["set"]
            else:
                self.clock.now += operation["add"]
        elif op == "set":  # an attribute of the stand-in driver, or of the SO-101's stand-in arm
            target = self.driver.hardware if operation["target"] == "arm" else self.driver
            value = operation["value"]
            if operation["name"] == "failure":
                value = None if value is None else make_error(value)
            elif operation["name"] == "response":
                value = Responses.make(value)
            setattr(target, operation["name"], value)
        elif op == "position":  # where the stand-in holds an arm
            self.probe.set_position(operation["arm"], tuple(numbers(operation["values"])))
        elif op == "tamper":
            self.probe.tampers[operation["method"]].append({**copy.deepcopy(operation["spec"]), "seen": 0, "count": 0})
        elif op == "untamper":
            for name in self.probe.tampers:
                if operation.get("method") in (None, name):
                    self.probe.tampers[name] = []
        elif op == "event":
            self.events[operation["name"]] = threading.Event()
        elif op == "cancel":
            self.events[operation["name"]].set()
        elif op == "attach":  # as PEAR's tests attach a cancellation: straight into the loop
            self.loop.operation_cancellation = self.events[operation["name"]]
        elif op == "observe":
            snapshot = self.loop.snapshot()
            positions = operation["positions"]
            if positions == "state":
                positions = pear_tests.SnapshotCheck.state_vector(snapshot)
            elif positions == "target":
                positions = pear_tests.SnapshotCheck.target_vector(snapshot)
            else:
                positions = numbers(positions)
            self.observations[operation["name"]] = {"joint_positions": positions, "control_snapshot": snapshot}
        elif op == "guard":
            cancellation = self.events.get(operation.get("cancellation"))
            self.guards[operation["name"]] = ActionGuard(self.loop, cancellation)
        elif op == "guard_check":
            operation["out"] = outcome(self.guards[operation["name"]].check)
        elif op == "break_stop":  # no stop trajectory can be planned any more
            def reject() -> None:
                raise ValueError(operation["message"])

            self.loop.trajectory.compute_trajectory = reject
        elif op == "mutate_snapshot":  # a reader changes the snapshot it was given
            snapshot = self.loop.snapshot()
            snapshot["fault_details"]["reason"] = "changed by a reader"
            snapshot["settling"]["samples"] = -1
        elif op == "set_state":  # a reading handed straight to the loop, past its own check
            state = self.loop.states[operation["arm"]]
            position = list(state.position)
            position[operation["index"]] = number(operation["value"])
            changed = dataclasses.replace(state, position=tuple(position))
            self.loop.states = {**self.loop.states, operation["arm"]: changed}
        elif op == "policy_step":  # one step of the recovery policy on a request of its own, past the loop's checks
            window = SimpleNamespace(reset=lambda: None)
            request = RecoveryRequest(window, self.clock.now + operation["timeout_s"])
            if operation.get("cancelled"):  # the operator paused it before the step
                request.cancellation = threading.Event()
                request.cancellation.set()
            if "from_phase" in operation:  # the request is that far already
                request.phase = RecoveryPhase(operation["from_phase"])
            step = self.loop.recovery_policy.step
            operation["out"] = outcome(lambda: step(self.loop, request, self.loop.snapshot(), operation["is_stable"]))
            operation["phase"] = request.phase.value
            operation["deadline"] = request.deadline
        elif op == "raise":
            raise make_error(operation)
        elif op == "set_exit":  # the control thread's exit event, set while the loop is open: its thread is gone
            self.loop._exit_event.set()
        elif op == "set_input":  # the planned state, changed behind the loop's back
            setattr(self.loop.trajectory.input, operation["name"], numbers(operation["values"]))
        elif op == "call":
            operation["out"] = self.execute_call(operation["method"], operation["args"])
        else:
            raise ValueError(f"No operation {op}")

        if records:
            operation["rec"] = [self.record()]
        return operation

    def execute_call(self, method: str, arguments: dict[str, Any]) -> dict[str, Any]:
        loop = self.loop
        observation = self.observations.get(arguments.get("observation"))

        if method == "move":
            targets = {arm: tuple(numbers(values)) for arm, values in arguments["targets"].items()}
            options = {}
            if "speed_scale" in arguments:
                options["speed_scale"] = number(arguments["speed_scale"])
            if "caps" in arguments:
                options["caps"] = motion_caps(arguments["caps"])
            return outcome(lambda: loop.move(targets, **options))
        if method == "dispatch_joint_move":
            spec = arguments["move"]
            if spec is None:  # what is no checked move
                return outcome(lambda: loop.dispatch_joint_move({"goal": []}, observation))
            options = {"speed_scale": spec.get("speed_scale", 1.0), "caps": motion_caps(spec.get("caps"))}
            built = outcome(
                lambda: JointMove.build(numbers(spec["start"]), numbers(spec["goal"]), loop.limits, loop.layout, **options),
                shown=lambda move: move,
            )
            if "error" in built:
                return {"build": built}
            return outcome(lambda: loop.dispatch_joint_move(built["ok"], observation))
        if method == "start_sequence":
            positions = [numbers(row) for row in arguments["positions"]]
            return outcome(lambda: loop.start_sequence(positions, rate_hz=arguments["rate_hz"], observation=observation))
        if method == "begin_grippers":
            def begin() -> dict[str, Any]:
                operation = loop.begin_grippers(arguments["request"])
                self.gripper_operation = operation
                return {
                    "class": type(operation).__name__,
                    "initial_opening": operation.initial_opening,
                    "opens": operation.opens_by_arm,
                    "endpoint": operation.profile.endpoint,
                    "stops_from_standstill": operation.stops_from_standstill,
                }

            return outcome(begin)
        if method == "stop":
            return outcome(lambda: loop.stop(**arguments))
        if method == "verify_reference":
            return outcome(lambda: loop.verify_reference(observation))
        if method == "stability":
            return outcome(lambda: loop.stability(**arguments))
        if method == "report":
            return outcome(lambda: {**self.gripper_operation.report(), "progress": self.gripper_progress(self.gripper_operation)})
        if method == "check_states":
            states = {
                arm: ArmState(
                    tuple(numbers(state["position"])),
                    tuple(numbers(state["velocity"])),
                    self.clock.now - state.get("age_s", 0.0),
                    state.get("sample_id"),
                )
                for arm, state in arguments["states"].items()
            }
            return outcome(lambda: loop.check_states(states))
        if method == "recover":  # (one that is refused at once: a recovery that waits is a "wait")
            options: dict[str, Any] = {}
            if "timeout_s" in arguments:
                options["timeout_s"] = number(arguments["timeout_s"])
            if "cancellation" in arguments:
                options["cancellation"] = self.events[arguments["cancellation"]]
            return outcome(lambda: loop.recover(**options))
        if method == "transfer_hold":
            targets = {arm: tuple(numbers(values)) for arm, values in arguments["targets"].items()}
            return outcome(lambda: loop.transfer_hold(targets))
        if method in ("snapshot", "requested_position", "close"):
            return outcome(getattr(loop, method))
        raise ValueError(f"No call {method}")

    def execute_wait(self, operation: dict[str, Any]) -> dict[str, Any]:
        loop, method, arguments, hooks = self.loop, operation["method"], operation["args"], operation["hooks"]
        operation["sleeps"] = []
        fired: set[int] = set()
        sends_before = self.probe.send_count

        def run_hooks(at: str, entry: dict[str, Any]) -> None:
            for index, hook in enumerate(hooks):
                if hook["at"] != at or (hook.get("once", True) and index in fired):
                    continue
                when = hook["when"]
                recovery = loop.snapshot()["recovery"] if "phase" in when else None
                if (
                    ("phase" in when and (recovery is None or recovery["phase"] != when["phase"]))
                    or ("sleep" in when and len(operation["sleeps"]) != when["sleep"])  # (this sleep is counted)
                    or ("sent_over" in when and self.probe.send_count <= sends_before + when["sent_over"])
                ):
                    continue
                fired.add(index)
                for action in hook["do"]:
                    entry["hooks"].append(self.execute(copy.deepcopy(action), records=False))

        def sleep(duration_s: float) -> None:
            self.clock.now += duration_s
            entry: dict[str, Any] = {"hooks": []}
            operation["sleeps"].append(entry)
            try:
                run_hooks("before", entry)
                loop.step()
                self.tick_count += 1
                run_hooks("after", entry)
            finally:
                entry["rec"] = self.record()

        options: dict[str, Any] = {}
        if "timeout_s" in arguments:
            options["timeout_s"] = number(arguments["timeout_s"])
        if "cancellation" in arguments:
            options["cancellation"] = self.events[arguments["cancellation"]]
        if "label" in arguments:
            options["label"] = arguments["label"]
        if "guard" in arguments:
            options["guard"] = self.guards[arguments["guard"]]
        if arguments.get("accepts") == "reached":
            options["accepts"] = lambda snapshot: snapshot["arrival"]["reached"]
        elif arguments.get("accepts") == "never":
            options["accepts"] = lambda snapshot: False

        with self.monkeypatch.context() as patch:
            patch.setattr(time, "sleep", sleep)
            operation["out"] = outcome(lambda: getattr(loop, method)(**options))
        operation["rec"] = [self.record()]
        return operation


# ---------------------------------------------------------------------------------------------------------------------
# PEAR's trajectory classes and operations themselves, without a control loop


def input_record(trajectory: JointTrajectory) -> dict[str, Any]:
    """Returns what a JointTrajectory holds of its Ruckig input, and the duration it computed last."""
    trajectory_input = trajectory.input
    names = (
        "current_position", "current_velocity", "current_acceleration", "target_position", "target_velocity",
        "target_acceleration", "max_velocity", "max_acceleration", "max_jerk",
    )
    return {
        **{name: plain(getattr(trajectory_input, name)) for name in names},
        "control_interface": trajectory_input.control_interface.name,
        "duration": plain(trajectory.duration_s),
    }


def sample_row(sample: Any) -> list[Any]:
    """Returns a CommandSample as a row: position, velocity, acceleration, whether it is finished, and the target
    it commits (null when it commits none)."""
    requested = None if sample.requested_target is None else plain(sample.requested_target)
    return [plain(sample.position), plain(sample.velocity), plain(sample.acceleration), bool(sample.is_finished), requested]


class TrajectoryCases:
    """What PEAR's JointMove, JointTrajectory, GripperProfile and operations give for scripted inputs."""

    def __init__(self, stations: Stations, scale: int) -> None:
        self.stations, self.scale = stations, scale

    def generator(self, name: str) -> random.Random:
        return random.Random(f"{SEED}-{name}")

    # -- JointMove

    def move_case(
        self,
        kind: str,
        station: str,
        start: Sequence[Any],
        goal: Sequence[Any],
        rng: random.Random,
        *,
        speed_scale: Any = None,
        caps: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Returns what ``JointMove.build`` gives for a start and a goal on a station: the refusal, or the move's
        caps, its duration and its state at times across it, before it and past it."""
        control_config, robot_config = self.stations.configs(station)
        limits, layout = robot_config.joint_limits(), robot_config.LAYOUT
        case: dict[str, Any] = {"k": kind, "station": station, "start": plain(start), "goal": plain(goal)}
        options: dict[str, Any] = {}
        if speed_scale is not None:
            case["speed_scale"] = plain(speed_scale)
            options["speed_scale"] = speed_scale
        if caps is not None:
            case["caps"] = plain(caps)
            options["caps"] = motion_caps(caps)

        def build() -> dict[str, Any]:
            move = JointMove.build(numbers(start), numbers(goal), limits, layout, **options)
            return self.move_record(move, control_config.control_period_s, rng)

        # what build itself gave, apart from what the move gives afterwards: a refusal is build's own
        built = outcome(lambda: JointMove.build(numbers(start), numbers(goal), limits, layout, **options), shown=lambda move: None)
        case["built"] = built
        case["out"] = outcome(build, shown=lambda record: record)
        return case

    @staticmethod
    def move_record(move: JointMove, period_s: float, rng: random.Random) -> dict[str, Any]:
        duration = move.duration_s
        # the times a JointMoveOperation asks for: one control period on at each step, the last at the duration
        played, elapsed = [], 0.0
        while elapsed < duration and len(played) < 20000:
            elapsed = min(elapsed + period_s, duration)
            played.append(elapsed)
        chosen = played[:2] + played[-2:] + ([rng.choice(played) for _ in range(3)] if played else [])
        times = [0.0, duration, duration / 2, -1.0, duration + 1.0, duration * rng.random(), *chosen]
        samples = []
        for seconds in times:
            position, velocity, acceleration = move.at_time(seconds)
            samples.append([seconds, plain(position), plain(velocity), plain(acceleration)])
        refused = [[plain(seconds), outcome(lambda: move.at_time(seconds))] for seconds in (math.nan, math.inf, -math.inf)]

        return {
            "start": plain(move.start),
            "goal": plain(move.goal),
            "motion_caps": plain(move.motion_caps),
            "duration": duration,
            "periods": len(played),
            "samples": samples,
            "refused_times": refused,
        }

    def direct_case(self, kind: str, start: Sequence[float], goal: Sequence[float], caps: Sequence[Sequence[float]]) -> dict[str, Any]:
        """Returns what a JointMove made without ``build`` gives for its trajectory and its duration."""
        move = JointMove(tuple(start), tuple(goal), tuple(tuple(values) for values in caps))
        return {
            "k": kind,
            "start": plain(start),
            "goal": plain(goal),
            "motion_caps": plain(caps),
            "out": outcome(lambda: move.duration_s),
            "again": outcome(lambda: move.duration_s),  # a move that failed computes its trajectory again
        }

    def moves(self) -> list[dict[str, Any]]:
        rng = self.generator("moves")
        cases: list[dict[str, Any]] = []
        step_rad = pear_tests.STEP_RAD

        for station in ("so101_station", "two_arm"):  # the tests of every layout (robot_name)
            _, robot_config = self.stations.configs(station)
            limits = robot_config.joint_limits()
            rest = np.array(Robots.rest(robot_config))
            cases.append(self.move_case("reaches_the_goal", station, rest, rest + step_rad, rng))
            outside = rest.copy()
            outside[0] = limits.upper_bounds[0] + 0.1
            cases.append(self.move_case("goal_outside", station, rest, outside, rng))
            cases.append(self.move_case("nonfinite", station, rest, rest * np.nan, rng))
            resting = rest.copy()
            resting[1] = limits.lower_bounds[1] - limits.feedback_tolerance / 2
            inward, outward = resting.copy(), resting.copy()
            inward[1] += step_rad
            outward[1] -= step_rad
            cases.append(self.move_case("past_a_limit_inward", station, resting, inward, rng))
            cases.append(self.move_case("past_a_limit_outward", station, resting, outward, rng))

        # the SO-101 folded: shoulder_lift resting past its lower limit (JointBounds of PEAR's tests)
        station = "so101_quick_home"
        _, robot_config = self.stations.configs(station)
        folded = np.zeros(robot_config.LAYOUT.vector_length)
        folded[pear_tests.LIFT] = robot_config.limits.lower_bounds[pear_tests.LIFT] - pear_tests.PAST_RAD
        further, panned = folded.copy(), folded.copy()
        further[pear_tests.LIFT] -= pear_tests.LIFT_STEP_RAD
        panned[0] += pear_tests.PAN_STEP_RAD
        cases.append(self.move_case("folded_to_zero", station, folded, np.zeros(len(folded)), rng))
        cases.append(self.move_case("folded_further", station, folded, further, rng))
        cases.append(self.move_case("folded_other_joint", station, folded, panned, rng))

        # the two arms of their station: PEAR's recorded endpoints and the moves its tests build by hand
        station = "two_arm_station"
        _, robot_config = self.stations.configs(station)
        recorded = json.loads((ConfigFiles.YAM_RECORDED_CASES / pear_tests.ENDPOINT_TARGETS).read_text())["cases"]
        for endpoint in recorded[: 4 * self.scale]:
            for speed_scale in (1 / 3, None):
                cases.append(self.move_case("recorded_endpoint", station, endpoint["start"], endpoint["goal"], rng, speed_scale=speed_scale))
        start = np.zeros(14)
        start[[6, 13]] = 0.5
        goal = start.copy()
        goal[7:9] = [0.15, 0.06]
        cases.append(self.move_case("fixture_move", station, start, goal, rng, speed_scale=1 / 3))
        start = np.zeros(14)
        start[[6, 13]] = [0.3, 0.8]
        goal = start.copy()
        goal[[0, 2, 7, 11]] = [0.4, 0.2, -0.5, 0.3]
        cases.append(self.move_case("phase_sync", station, start, goal, rng))
        for change in (0.0, 1e-12, 1e-8, math.nan, math.inf, 100):
            start = np.zeros(14)
            start[[6, 13]] = 0.5
            goal = start.copy()
            goal[7] += change
            cases.append(self.move_case("tiny_or_invalid", station, start, goal, rng))
        home = robot_config.home
        if home is not None and home.limits is not None:
            caps = {name: list(getattr(home.limits, name)) for name in ("velocity", "acceleration", "jerk")}
            goal = np.zeros(14)
            goal[[1, 8]] = [0.2, -0.1]
            cases.append(self.move_case("home_caps", station, np.zeros(14), goal, rng, speed_scale=0.5, caps=caps))

        # generated: any start and goal inside the bounds, at any speed, within any caps
        scales = (None, None, 1.0, 0.5, 0.25, 1 / 3, 0.1, 0.7, 0.01)
        for station, count in (("so101_station", 14), ("so101_quick", 6), ("two_arm", 4), ("two_arm_station", 3)):
            _, robot_config = self.stations.configs(station)
            limits = robot_config.joint_limits()
            width = len(limits.lower_bounds)

            def inside(reach: float = 1.0) -> list[float]:
                return [
                    (low + high) / 2 + reach * rng.uniform(-0.5, 0.5) * (high - low)
                    for low, high in zip(limits.lower_bounds, limits.upper_bounds)
                ]

            for index in range(count * self.scale):
                start, goal = inside(), inside()
                for coordinate in range(width):  # some coordinates rest
                    if rng.random() < 0.4:
                        goal[coordinate] = start[coordinate]
                caps = None
                if index % 5 == 4:
                    arm_width = robot_config.LAYOUT.coordinate_count
                    caps = {
                        "velocity": [rng.uniform(0.05, 2.0) for _ in range(arm_width)],
                        "acceleration": [rng.uniform(0.1, 5.0) for _ in range(arm_width)],
                        "jerk": [rng.uniform(0.5, 50.0) for _ in range(arm_width)],
                    }
                cases.append(self.move_case("generated", station, start, goal, rng, speed_scale=rng.choice(scales), caps=caps))

            # what is refused: the speed scale, the shape, a goal at and past a bound, a move that takes too long
            start, goal = inside(0.5), inside(0.5)
            for speed_scale in (0, -0.5, 1.5, math.nan, math.inf, 1e-300):
                cases.append(self.move_case("speed_scale", station, start, goal, rng, speed_scale=speed_scale))
            cases.append(self.move_case("short_start", station, start[:-1], goal, rng))
            cases.append(self.move_case("long_goal", station, start, [*goal, 0.0], rng))
            cases.append(self.move_case("empty", station, [], [], rng))
            for beyond in (0.0, 5e-10, 2e-9, 1e-6):
                edge = list(start)
                edge[0] = limits.upper_bounds[0] + beyond
                cases.append(self.move_case("at_a_bound", station, start, edge, rng))
            far = [low if index % 2 else high for index, (low, high) in enumerate(zip(limits.lower_bounds, limits.upper_bounds))]
            near = [high if index % 2 else low for index, (low, high) in enumerate(zip(limits.lower_bounds, limits.upper_bounds))]
            for speed_scale in (0.02, 1e-3, 2e-4):  # past 120 s, and past what Ruckig itself takes
                cases.append(self.move_case("too_long", station, near, far, rng, speed_scale=speed_scale))
            arm_width = robot_config.LAYOUT.coordinate_count
            zero_caps = {"velocity": [0.0] * arm_width, "acceleration": [1.0] * arm_width, "jerk": [1.0] * arm_width}
            cases.append(self.move_case("zero_caps", station, start, goal, rng, caps=zero_caps))

        # a move made without build: its caps are not three lists, or it takes too long
        cases.append(self.direct_case("two_caps", [0.0, 0.0], [0.1, 0.2], [[1.0, 1.0], [2.0, 2.0]]))
        cases.append(self.direct_case("four_caps", [0.0, 0.0], [0.1, 0.2], [[1.0, 1.0]] * 4))
        cases.append(self.direct_case("valid", [0.0, 0.0], [0.1, 0.2], [[1.0, 1.0], [2.0, 2.0], [10.0, 10.0]]))
        cases.append(self.direct_case("slow", [0.0, 0.0], [1.0, 0.2], [[0.001, 0.001], [2.0, 2.0], [10.0, 10.0]]))
        cases.append(self.direct_case("slower", [0.0, 0.0], [1.0, 0.2], [[0.0001, 0.0001], [2.0, 2.0], [10.0, 10.0]]))
        cases.append(self.direct_case("one_coordinate_slower", [0.0], [1.0], [[0.0001], [2.0], [10.0]]))

        # a start past a limit by more than the feedback tolerance, where no held command rests: toward the bounds,
        # and along them
        more = self.generator("moves-of-starts")
        for station in ("so101_station", "two_arm"):
            _, robot_config = self.stations.configs(station)
            limits = robot_config.joint_limits()
            rest = np.array(Robots.rest(robot_config))
            for joint, bounds, sign in ((1, limits.lower_bounds, -1), (0, limits.upper_bounds, 1)):
                beyond = rest.copy()
                beyond[joint] = bounds[joint] + sign * 2 * limits.feedback_tolerance
                along = beyond.copy()
                along[-1] = rest[-1] + (0.1 if rest[-1] < 0.5 else -0.1)
                cases.append(self.move_case("start_beyond_the_tolerance", station, beyond, rest, more))
                cases.append(self.move_case("start_beyond_the_tolerance", station, beyond, along, more))

        return cases

    # -- JointTrajectory

    def trajectory_session(self, kind: str, station: str, script: Sequence[Sequence[Any]]) -> dict[str, Any]:
        """Runs a script on a JointTrajectory of a station: each operation with what it returned or raised, and the
        trajectory's input after it."""
        control_config, robot_config = self.stations.configs(station)
        trajectory = JointTrajectory(robot_config.joint_limits(), robot_config.LAYOUT, control_config)
        operations = []
        for name, *arguments in script:
            operation: dict[str, Any] = {"op": name, "args": plain(arguments)}
            if name == "hold":
                operation["out"] = outcome(lambda: trajectory.hold(numbers(arguments[0])))
            elif name == "head_for":
                caps = None if arguments[1] is None else [list(values) for values in arguments[1]]
                operation["out"] = outcome(lambda: trajectory.head_for(numbers(arguments[0]), caps))
            elif name == "set_target":
                operation["out"] = outcome(lambda: trajectory.set_target(numbers(arguments[0])))
            elif name == "stop":
                braking = None if arguments[1] is None else tuple(list(values) for values in arguments[1])
                operation["out"] = outcome(lambda: trajectory.stop(from_standstill=arguments[0], braking_caps=braking))
            elif name == "compute":
                operation["out"] = outcome(trajectory.compute_trajectory)
            elif name == "set_input":
                setattr(trajectory.input, arguments[0], numbers(arguments[1]))
            elif name == "advance":  # a row a control period: the sample, which is then accepted
                rows = []
                for _ in range(arguments[0]):
                    advanced = outcome(trajectory.advance, shown=lambda sample: sample)
                    if "error" in advanced:
                        rows.append(advanced)
                        break
                    trajectory.accept(advanced["ok"])
                    rows.append(sample_row(advanced["ok"])[:4])
                operation["rows"] = rows
            elif name == "finish":  # advances until a sample is finished, and some periods more
                rows, remaining = [], None
                for _ in range(MOST_TICKS):
                    sample = trajectory.advance()
                    trajectory.accept(sample)
                    rows.append(sample_row(sample)[:4])
                    if remaining is None and sample.is_finished:
                        remaining = arguments[0]
                    if remaining is not None:
                        if remaining == 0:
                            break
                        remaining -= 1
                operation["rows"] = rows
            else:
                raise ValueError(f"No operation {name}")
            operation["input"] = input_record(trajectory)
            operations.append(operation)

        return {"k": kind, "station": station, "ops": operations}

    def trajectory_sessions(self) -> list[dict[str, Any]]:
        rng = self.generator("trajectories")
        sessions = []

        for station in ("so101_station", "two_arm"):
            _, robot_config = self.stations.configs(station)
            limits = robot_config.joint_limits()
            rest = list(Robots.rest(robot_config))
            width = len(rest)
            outside = list(rest)
            outside[0] = limits.upper_bounds[0] + 1
            sessions.append(self.trajectory_session("rejected_target", station, [["hold", rest], ["set_target", outside]]))
            moving = [0.5 * velocity for velocity in limits.velocity]
            strong = [[4 * a for a in limits.acceleration], [8 * j for j in limits.jerk]]
            for braking in (None, strong):
                script = [["hold", rest], ["set_input", "current_velocity", moving], ["stop", False, braking], ["finish", 2]]
                sessions.append(self.trajectory_session("braking_caps", station, script))
            sessions.append(self.trajectory_session("hold_refused", station, [["hold", rest[:-1]], ["hold", [math.nan] * width], ["hold", rest]]))
            refused = [["hold", rest], ["set_target", rest[:-1]], ["set_target", [math.inf] * width]]
            sessions.append(self.trajectory_session("target_refused", station, refused))
            # an input Ruckig itself refuses: the old input comes back
            broken = [["hold", rest], ["set_input", "current_position", [math.nan] * width], ["set_target", rest], ["advance", 1]]
            sessions.append(self.trajectory_session("ruckig_refuses", station, broken))
            # a trajectory longer than Ruckig takes
            far = [low if index % 2 else high for index, (low, high) in enumerate(zip(limits.lower_bounds, limits.upper_bounds))]
            slow = [[1e-5] * width] * 3
            sessions.append(self.trajectory_session("too_long", station, [["hold", rest], ["head_for", far, slow], ["compute"], ["advance", 1]]))

        # test_native_extrema_reject_interior_overshoot_even_with_legal_endpoints
        _, robot_config = self.stations.configs("two_arm_station")
        position = [0.0] * 14
        position[0] = robot_config.arms["left"].limits.upper_bounds[0] - 0.001
        script = [["set_input", "current_position", position], ["set_input", "current_velocity", [0.4] + [0.0] * 13], ["set_target", position]]
        sessions.append(self.trajectory_session("interior_overshoot", "two_arm_station", script))

        # generated: a hold, targets, a change of target under way, a controlled stop, and on from rest
        for station, count in (("so101_station", 5), ("so101_quick", 3), ("two_arm", 2)):
            _, robot_config = self.stations.configs(station)
            limits = robot_config.joint_limits()
            braking_caps = [list(caps) for caps in limits.braking_caps()]

            def near(pose: Sequence[float], reach: float) -> list[float]:
                return [
                    value if rng.random() < 0.3 else min(max(value + rng.uniform(-reach, reach), low), high)
                    for value, low, high in zip(pose, limits.lower_bounds, limits.upper_bounds)
                ]

            for index in range(count * self.scale):
                start = near(Robots.rest(robot_config), 0.6)
                first, second, third = near(start, 0.3), near(start, 0.3), near(start, 0.2)
                script = [
                    ["hold", start],
                    ["set_target", first],
                    ["advance", rng.randint(3, 25)],
                    ["set_target", second],
                    ["advance", rng.randint(2, 20)],
                    ["stop", index % 3 == 2, braking_caps if index % 2 else None],
                    ["finish", 3],
                    ["set_target", third],
                    ["finish", 2],
                ]
                sessions.append(self.trajectory_session("generated", station, script))

        # what a hold, a new heading and a stop leave of a motion that the input still holds: the planned velocity
        # and acceleration, and the velocity and acceleration a target was to be reached with
        for station in ("so101_station", "two_arm"):
            _, robot_config = self.stations.configs(station)
            limits = robot_config.joint_limits()
            rest = list(Robots.rest(robot_config))
            width = len(rest)
            moving = [0.5 * velocity for velocity in limits.velocity]
            pushing = [0.25 * acceleration for acceleration in limits.acceleration]
            arriving = [0.1 * velocity * (-1) ** index for index, velocity in enumerate(limits.velocity)]
            easing = [0.05 * acceleration for acceleration in limits.acceleration]
            aside = [value + (0.05 if index == 0 else 0.0) for index, value in enumerate(rest)]
            moved = [["set_input", "current_velocity", moving], ["set_input", "current_acceleration", pushing]]
            aimed = [["set_input", "target_velocity", arriving], ["set_input", "target_acceleration", easing]]
            sessions.append(self.trajectory_session("hold_from_motion", station, [["hold", rest], *moved, *aimed, ["hold", aside]]))
            script = [["hold", rest], *aimed, ["head_for", aside, None], ["compute"], ["finish", 2]]
            sessions.append(self.trajectory_session("heading_from_a_moving_target", station, script))
            script = [["hold", rest], ["set_input", "current_velocity", moving], *aimed, ["stop", False, None], ["finish", 2]]
            sessions.append(self.trajectory_session("stop_from_a_moving_target", station, script))
            script = [["hold", rest], *moved, ["stop", True, None], ["finish", 2]]
            sessions.append(self.trajectory_session("stop_from_standstill", station, script))
            # a target that is refused while a stop is under way: the stop's input comes back, in velocity mode
            script = [
                ["hold", rest],
                ["set_input", "current_velocity", moving],
                ["stop", False, None],
                ["advance", 2],
                ["set_input", "current_position", [math.nan] * width],
                ["set_target", aside],
            ]
            sessions.append(self.trajectory_session("target_refused_while_stopping", station, script))

        return sessions

    # -- GripperProfile

    def gripper_session(
        self, kind: str, caps: Sequence[float], start: float, opens: bool, period_s: float, start_velocity: float | None, extra: int
    ) -> dict[str, Any]:
        """Runs one gripper's profile to its endpoint and ``extra`` control periods past it, commanding the endpoint
        once the profile is finished, as a gripper operation does."""
        limits = SimpleNamespace(velocity=[caps[0]], acceleration=[caps[1]], jerk=[caps[2]])
        session: dict[str, Any] = {"k": kind, "caps": plain(caps), "start": plain(start), "opens": opens, "period_s": period_s}
        session["duration"] = outcome(lambda: GripperProfile.duration_s(start, opens, limits))

        def play() -> dict[str, Any]:
            if start_velocity is None:
                profile = GripperProfile(start, opens, limits, period_s)
            else:
                profile = GripperProfile(start, opens, limits, period_s, start_velocity)
            rows, remaining = [], None
            for _ in range(MOST_TICKS):
                position, velocity, acceleration, is_finished = profile.advance()
                commanded = profile.endpoint if is_finished else position
                profile.accept(commanded)
                rows.append([position, velocity, acceleration, is_finished])
                if remaining is None and is_finished:
                    remaining = extra
                if remaining is not None:
                    if remaining == 0:
                        break
                    remaining -= 1
            return {"endpoint": profile.endpoint, "rows": plain(rows)}

        if start_velocity is not None:
            session["start_velocity"] = start_velocity
        session["out"] = outcome(play, shown=lambda record: record)
        return session

    def gripper_sessions(self) -> list[dict[str, Any]]:
        rng = self.generator("grippers")
        sessions = []
        caps_by_station = {}
        for station in ("so101_station", "so101_quick", "two_arm"):
            control_config, robot_config = self.stations.configs(station)
            limits = robot_config.joint_limits()
            caps_by_station[station] = ([limits.velocity[-1], limits.acceleration[-1], limits.jerk[-1]], control_config.control_period_s)

        for station, (caps, period_s) in caps_by_station.items():
            for start, opens in ((1.0, False), (0.0, True), (0.5, True), (0.5, False), (1.0, True), (0.0, False)):
                sessions.append(self.gripper_session(station, caps, start, opens, period_s, None, 6))
        caps, period_s = caps_by_station["so101_station"]
        for start, opens, start_velocity in ((1.2, True, None), (-0.1, False, None), (0.6, False, 0.3), (0.4, True, -0.2), (0.7, False, -0.4)):
            sessions.append(self.gripper_session("beyond_or_moving", caps, start, opens, period_s, start_velocity, 12))
        for _ in range(6 * self.scale):
            caps = [rng.uniform(0.1, 3.0), rng.uniform(0.5, 20.0), rng.uniform(2.0, 200.0)]
            start_velocity = rng.choice([None, None, rng.uniform(-0.2, 0.2)])
            period_s = rng.choice([0.02, 0.02, 0.01, 0.04])
            sessions.append(self.gripper_session("generated", caps, rng.random(), rng.random() < 0.5, period_s, start_velocity, 4))
        sessions.append(self.gripper_session("refused", [0.0, 1.0, 1.0], 0.5, True, 0.02, None, 0))
        sessions.append(self.gripper_session("refused", [1.0, 1.0, 1.0], math.nan, True, 0.02, None, 0))
        # a jaw without acceleration, and one without jerk
        sessions.append(self.gripper_session("refused", [1.0, 0.0, 1.0], 0.5, True, 0.02, None, 0))
        sessions.append(self.gripper_session("refused", [1.0, 1.0, 0.0], 0.5, False, 0.02, None, 0))

        return sessions

    # -- operations

    def sequence_case(self, kind: str, station: str, positions: Any, rate_hz: Any, nows: Sequence[float] = ()) -> dict[str, Any]:
        """Returns what a SequenceOperation of ``positions`` at ``rate_hz`` gives when it is made on a trajectory at
        rest in the middle of the bounds, and then for each ``now`` it is advanced at."""
        control_config, robot_config = self.stations.configs(station)
        trajectory = JointTrajectory(robot_config.joint_limits(), robot_config.LAYOUT, control_config)
        trajectory.hold(Robots.rest(robot_config))
        case: dict[str, Any] = {"k": kind, "station": station, "positions": plain(positions), "rate_hz": plain(rate_hz), "nows": plain(nows)}
        made = outcome(lambda: SequenceOperation(trajectory, positions, rate_hz), shown=lambda operation: operation)
        if "error" in made:
            case["out"] = made
            return case

        operation = made["ok"]
        case["out"] = {"ok": {"rows": len(operation.positions), "rate_hz": operation.rate_hz, "writeable": bool(operation.positions.flags.writeable)}}
        steps = []
        for now in nows:
            advanced = outcome(lambda: operation.advance(now, {}, {}), shown=lambda sample: sample)
            state = [operation.index, operation.row_phase, operation.start_time, operation.is_complete]
            if "error" in advanced:
                steps.append({"out": advanced, "state": plain(state), "target": plain(trajectory.input.target_position)})
                break
            trajectory.accept(advanced["ok"])
            steps.append({"row": sample_row(advanced["ok"])[:4], "state": plain(state), "target": plain(trajectory.input.target_position)})
        case["steps"] = steps
        return case

    def sequence_cases(self) -> list[dict[str, Any]]:
        rng = self.generator("sequences")
        cases = []
        rows_count = pear_tests.SEQUENCE_ROWS
        rate = pear_tests.SEQUENCE_RATE_HZ

        for station in ("so101_station", "two_arm"):
            control_config, robot_config = self.stations.configs(station)
            limits = robot_config.joint_limits()
            rest = list(Robots.rest(robot_config))
            period_s = control_config.control_period_s
            rows = [list(rest) for _ in range(rows_count)]
            cases.append(self.sequence_case("short_rows", station, [row[:-1] for row in rows], rate))
            cases.append(self.sequence_case("too_fast", station, rows, 2 * control_config.rate_hz))
            stepped = np.tile(rest, (rows_count, 1))
            stepped[:, 0] += np.linspace(0, 0.05, rows_count)
            nows = [period_s * (index + 1) for index in range(3 * rows_count)]
            cases.append(self.sequence_case("each_row_once", station, stepped.tolist(), rate, nows))
            cases.append(self.sequence_case("late_row", station, rows, rate, [0.0] + [1.0] * rows_count))

            for name, positions, rate_hz in (
                ("empty", [], rate),
                ("flat", rest, rate),
                ("ragged", [rest, rest[:-1]], rate),
                ("one_row", [rest], rate),
                ("too_many", [rest] * (SequenceOperation.MAX_ROWS + 1), rate),
                ("most", [rest] * SequenceOperation.MAX_ROWS, rate),
                ("slow_1", rows, 1),
                ("slow_2", rows, 2),
                ("slow_edge", rows, 2.0000001),
                ("at_controller_rate", rows, control_config.rate_hz),
                ("rate_nan", rows, math.nan),
                ("rate_inf", rows, math.inf),
                ("rate_negative", rows, -25.0),
                ("row_nan", [rest, [math.nan] * len(rest)], rate),
                ("row_inf", [[math.inf] * len(rest)], rate),
            ):
                cases.append(self.sequence_case(name, station, positions, rate_hz))
            outside = list(rest)
            outside[2] = limits.upper_bounds[2] + 0.2
            cases.append(self.sequence_case("row_outside", station, [rest, outside], rate))

            for _ in range(2 * self.scale):  # generated: rows that wander, at any rate, on a clock with jitter
                rate_hz = rng.choice([control_config.rate_hz, control_config.rate_hz / 2, 30.0, 10.0, 12.5])
                count = rng.randint(3, 14)
                wander = np.tile(rest, (count, 1))
                for coordinate in rng.sample(range(len(rest)), 2):
                    wander[:, coordinate] += np.cumsum([rng.uniform(-0.004, 0.006) for _ in range(count)])
                nows, now = [], 100.0
                for _ in range(int(count * control_config.rate_hz / rate_hz) + 12):
                    now += period_s + rng.choice([0.0, 0.0005, 0.0001, 0.0006])
                    nows.append(now)
                cases.append(self.sequence_case("generated", station, wander.tolist(), rate_hz, nows))

        # the slack of a row's phase, and how late a row may be handed over: at the edge and at the next instant
        for station in ("so101_station", "two_arm"):
            control_config, robot_config = self.stations.configs(station)
            rest = list(Robots.rest(robot_config))
            period_s = control_config.control_period_s
            rows = [list(rest) for _ in range(4)]
            # at this rate a row's time is one part in twenty million short of a control period: after one period
            # the next row is not due yet, and after two it is
            nearly = control_config.rate_hz * (1 - 5e-8)
            cases.append(self.sequence_case("phase_short_of_a_row", station, rows, nearly, [period_s * index for index in range(10)]))

            def is_too_late(now: float, station: str = station, rows: list[list[float]] = rows) -> bool:
                """Whether PEAR's operation, begun at zero, interrupts itself when its second row is due at ``now``."""
                control_config, robot_config = self.stations.configs(station)
                trajectory = JointTrajectory(robot_config.joint_limits(), robot_config.LAYOUT, control_config)
                trajectory.hold(Robots.rest(robot_config))
                operation = SequenceOperation(trajectory, rows, control_config.rate_hz)
                trajectory.accept(operation.advance(0.0, {}, {}))
                try:
                    operation.advance(now, {}, {})
                except Exception:
                    return True
                return False

            edge = self.last_before(is_too_late, period_s, 1.0)
            for name, now in (("row_as_late_as_allowed", edge), ("row_later_than_allowed", math.nextafter(edge, math.inf))):
                cases.append(self.sequence_case(name, station, rows, control_config.rate_hz, [0.0, now, now + period_s]))

        return cases

    @staticmethod
    def last_before(turns: Callable[[float], bool], low: float, high: float) -> float:
        """Returns the last double from ``low`` on for which ``turns`` is still false, when it is false at ``low``
        and true at ``high`` and turns once between them: found by halving, with PEAR's own code as the judge."""
        if turns(low) or not turns(high):
            raise AssertionError("Nothing turns between the two")
        while math.nextafter(low, math.inf) < high:
            middle = low + (high - low) / 2
            if turns(middle):
                high = middle
            else:
                low = middle
        return low

    def gripper_operation_case(self, kind: str, station: str, opens: bool, start_opening: float, script: Sequence[dict[str, Any]]) -> dict[str, Any]:
        """Runs the SO-101's gripper operation by hand: made at an opening, then advanced with the readings a script
        gives; each step with its sample or what it raised, and what the operation keeps."""
        control_config, robot_config = self.stations.configs(station)
        home = [0.0, 0.1, -0.2, 0.3, 0.0, start_opening]
        targets = {ARM: tuple(home)}

        def reading(step: dict[str, Any]) -> ArmState:
            position = (*home[:GRIPPER_INDEX], number(step["opening"]))
            return ArmState(position, (0.0,) * len(position), step["stamp"], step.get("sample_id"))

        first = reading({"opening": start_opening, "stamp": 100.0, "sample_id": 0})
        operation = SO101GripperOperation(control_config, robot_config, targets, {ARM: first}, opens)
        case: dict[str, Any] = {"k": kind, "station": station, "opens": opens, "start_opening": start_opening, "home": home, "steps": []}
        case["made"] = {"initial_opening": operation.initial_opening, "endpoint": operation.profile.endpoint, "opens": operation.opens_by_arm}

        for step in script:
            entry = dict(step)
            state = reading(step)
            if "fault" in step:  # the targets to hold after a fault of this kind
                error = GripperEndpointTimeout("late") if step["fault"] == "GripperEndpointTimeout" else RuntimeError("other")
                entry["out"] = outcome(lambda: operation.fault_targets(error, step["now"], {ARM: state}, targets))
            elif "report" in step:
                entry["out"] = outcome(operation.report)
            else:
                advanced = outcome(lambda: operation.advance(step["now"], {ARM: state}, targets), shown=lambda sample: sample)
                if "error" in advanced:
                    entry["out"] = advanced
                else:
                    sample = advanced["ok"]
                    entry["row"] = sample_row(sample)
                    targets = {ARM: tuple(float(value) for value in sample.position)}
            entry["progress"] = plain(Scenario.gripper_progress(operation))
            case["steps"].append(plain(entry))

        return case

    def gripper_operation_cases(self) -> list[dict[str, Any]]:
        rng = self.generator("gripper-operations")
        cases = []

        def script(count: int, opening: Callable[[int, float], float], *, period_s: float = 0.02, repeats: bool = False) -> list[dict[str, Any]]:
            """Returns ``count`` control periods of readings: at each, the opening that ``opening`` gives for the
            period and the opening commanded before it."""
            steps, now = [], 100.0
            for index in range(count):
                now += period_s
                sample_id = (index // 2 if repeats else index) + 1
                steps.append({"now": now, "stamp": now, "sample_id": sample_id, "opening": opening(index, now)})
            return steps

        for station in ("so101_station", "so101_quick_home"):
            for opens, start in ((False, 1.0), (True, 0.0), (True, 0.5), (False, 0.5)):
                # the jaw follows its command one period behind: the operation's own profile is replayed as the reading
                follows = self.following(station, opens, start, blocked_at=None, count=160)
                cases.append(self.gripper_operation_case("follows", station, opens, start, [*follows, {"now": 0, "stamp": 0, "opening": 0, "report": True}]))
            blocked = self.following(station, False, 1.0, blocked_at=0.4, count=220)
            cases.append(self.gripper_operation_case("blocked", station, False, 1.0, [*blocked, {"now": 0, "stamp": 0, "opening": 0, "report": True}]))
            stuck = script(260, lambda index, now: 0.5)  # the jaw never leaves the middle: opening times out
            late = {"now": 106.0, "stamp": 106.0, "opening": 0.5}
            faults = [{**late, "fault": "GripperEndpointTimeout"}, {**late, "fault": "RuntimeError"}, {**late, "stamp": 105.0, "fault": "GripperEndpointTimeout"}]
            cases.append(self.gripper_operation_case("never_opens", station, True, 0.5, [*stuck, *faults]))
            wobbling = script(260, lambda index, now: 0.4 + (0.05 if index % 2 else -0.05))  # never at rest: closing times out
            cases.append(self.gripper_operation_case("never_rests", station, False, 0.4, wobbling))
            repeated = script(260, lambda index, now: 0.3, repeats=True)  # every reading twice: fewer new samples
            cases.append(self.gripper_operation_case("repeated_readings", station, False, 0.6, repeated))
            # a report asked for before the jaw has an outcome, and once it has one
            asked = {"now": 0, "stamp": 0, "opening": 0, "report": True}
            cases.append(self.gripper_operation_case("report_before_outcome", station, False, 1.0, [asked, *blocked[:5], asked, *blocked[5:], asked]))
            # a jaw that rests a share of the gripper tolerance short of its endpoint: inside it, at it, past it
            _, robot_config = self.stations.configs(station)
            for opens in (True, False):
                for share in (0.25, 0.75, 1.0, 1.25):
                    short = share * robot_config.gripper_tolerance
                    resting = GripperProfile.OPEN_ENDPOINT - short if opens else GripperProfile.CLOSED_ENDPOINT + short
                    near = script(330, lambda index, now, resting=resting: resting)
                    cases.append(self.gripper_operation_case("rests_near_endpoint", station, opens, 0.5, [*near, asked]))
        for _ in range(3 * self.scale):
            station = rng.choice(["so101_station", "so101_quick_home"])
            stop = rng.uniform(0.05, 0.9)
            noisy = self.following(station, False, 1.0, blocked_at=stop, count=200, noise=lambda: rng.uniform(-0.004, 0.004))
            cases.append(self.gripper_operation_case("generated", station, False, 1.0, noisy))

        # the targets to hold after an opening that timed out, when the jaw reads past either end of its range, at
        # either end and inside it; and after a closing that timed out, which keeps the command
        for station in ("so101_station", "so101_quick_home"):
            late = {"now": 106.0, "stamp": 106.0}
            beyond = [{**late, "opening": opening, "fault": "GripperEndpointTimeout"} for opening in (1.2, -0.2, 1.0, 0.0, 0.37)]
            for opens in (True, False):
                start = script(3, lambda index, now: 0.5)
                cases.append(self.gripper_operation_case("fault_targets_past_the_range", station, opens, 0.5, [*start, *beyond]))
            # a jaw that stops on an object while every few readings are stamped before the one before them: its rest
            # is judged on, where a window that minded the order would start over each time
            unordered = [dict(step) for step in self.following(station, False, 1.0, blocked_at=0.4, count=220)]
            for index in range(5, len(unordered) - 1, 7):
                unordered[index]["stamp"], unordered[index + 1]["stamp"] = unordered[index + 1]["stamp"], unordered[index]["stamp"]
            cases.append(self.gripper_operation_case("readings_stamped_out_of_order", station, False, 1.0, unordered))
            # a jaw whose held command lies past an end of its range: its way starts at that end
            for opens, start in ((False, 1.04), (True, -0.03), (True, 1.04), (False, -0.03)):
                follows = self.following(station, opens, start, blocked_at=None, count=160)
                cases.append(self.gripper_operation_case("held_past_the_range", station, opens, start, follows))

        # a closing jaw that wobbles about an object: over a whole window its openings span a share of the gripper
        # tolerance. Within the tolerance it is at rest on the object; past it, it never rests and the closing times
        # out (a span between one and two tolerances tells a rest judged against twice the tolerance)
        for station in ("so101_station", "so101_quick_home"):
            _, robot_config = self.stations.configs(station)
            report = {"now": 0, "stamp": 0, "opening": 0, "report": True}
            for share in (0.5, 1.5):
                half = share * robot_config.gripper_tolerance / 2
                wobbling = script(330, lambda index, now, half=half: 0.4 + (half if index % 2 else -half))
                cases.append(self.gripper_operation_case("wobbles_by_a_share_of_the_tolerance", station, False, 0.4, [*wobbling, report]))

        return cases

    def following(self, station: str, opens: bool, start: float, *, blocked_at: float | None, count: int, noise: Callable[[], float] | None = None) -> list[dict[str, Any]]:
        """Returns the readings of a jaw that reaches each commanded opening one control period later, and stops on
        an object at ``blocked_at`` if given: made by running PEAR's own operation once, as a stand-in arm would."""
        control_config, robot_config = self.stations.configs(station)
        home = [0.0, 0.1, -0.2, 0.3, 0.0, start]
        targets = {ARM: tuple(home)}
        measured, now, steps = start, 100.0, []
        first = ArmState(tuple(home), (0.0,) * len(home), now, 0)
        operation = SO101GripperOperation(control_config, robot_config, targets, {ARM: first}, opens)
        for index in range(count):
            now += control_config.control_period_s
            steps.append({"now": now, "stamp": now, "sample_id": index + 1, "opening": measured})
            state = ArmState((*home[:GRIPPER_INDEX], measured), (0.0,) * len(home), now, index + 1)
            try:
                sample = operation.advance(now, {ARM: state}, targets)
            except Exception:
                break
            targets = {ARM: tuple(float(value) for value in sample.position)}
            measured = float(sample.position[GRIPPER_INDEX])
            if blocked_at is not None:
                measured = max(measured, blocked_at)
            if noise is not None:
                measured += noise()
            if sample.is_finished and index % 7 == 6:
                break

        return steps

    def all(self) -> dict[str, Any]:
        return {
            "move_cases": self.moves(),
            "trajectory_sessions": self.trajectory_sessions(),
            "gripper_sessions": self.gripper_sessions(),
            "sequence_cases": self.sequence_cases(),
            "gripper_operation_cases": self.gripper_operation_cases(),
        }


# ---------------------------------------------------------------------------------------------------------------------
# the scenarios of the control loop

ROBOTS = (("so101", "so101_station"), ("yam", "two_arm"))  # each robot of PEAR's tests, and its station for them
JOINT_TESTS = "test_joint_control_in_station.py"
SO101_TESTS = "test_so101_joint_in_station.py"
STABILITY_TESTS = "test_stability_in_station.py"
J4, OUTSIDE_RAD, OPENING_PAST, AWAY_RAD = pear_tests.J4, pear_tests.OUTSIDE_RAD, pear_tests.OPENING_PAST, pear_tests.AWAY_RAD


class Catalogue:
    """The scenarios of the control loop: those of PEAR's own tests, each under the test's name and stepped on the
    stand-in clock, then scenarios for what those leave out, then generated ones."""

    def __init__(self, stations: Stations, monkeypatch: pytest.MonkeyPatch, scale: int) -> None:
        self.stations, self.monkeypatch, self.scale = stations, monkeypatch, scale
        self.scenarios: list[dict[str, Any]] = []

    def begin(self, name: str, source: str, kind: str, station: str, **rig: Any) -> Scenario:
        """Returns a new scenario with its rig made (a rig that could not be made is the whole scenario)."""
        scenario = Scenario(name, source, self.stations, self.monkeypatch)
        scenario.rig(kind, station, **rig)
        return scenario

    def keep(self, scenario: Scenario) -> None:
        self.scenarios.append(scenario.result())

    def all(self) -> list[dict[str, Any]]:
        self.of_every_layout()
        self.of_two_arms()
        self.of_the_so101()
        self.beyond_pears_tests()
        self.generated()
        self.since_the_audit()
        return self.scenarios

    # -- test_joint_control_in_station.py: the generic loop on the driver in memory, for each robot's layout

    def of_every_layout(self) -> None:
        tests = pear_tests
        for robot, station in ROBOTS:
            control_config, robot_config = self.stations.configs(station)
            limits, layout = robot_config.joint_limits(), robot_config.LAYOUT
            first, period_s = layout.arms[0], control_config.control_period_s

            def begin(test: str, variant: str = "", **rig: Any) -> Scenario:
                name = f"{test}[{robot}{'-' + variant if variant else ''}]"
                return self.begin(name, f"{JOINT_TESTS}::test_{test}", "memory", station, **rig)

            start = list(Robots.rest(robot_config))
            start[1] = limits.lower_bounds[1] - limits.feedback_tolerance / 2
            self.keep(begin("the_control_loop_holds_the_measured_pose_even_past_a_limit", start=start))

            s = begin("the_control_loop_moves_to_a_target_and_holds")
            s.jog(None, None, tests.STEP_RAD)
            s.until_hold()
            self.keep(s)

            s = begin("the_control_loop_is_settled_once_the_hold_passes_its_stability_window")
            s.jog(None, 1, tests.STEP_RAD)
            s.until_hold()
            s.until_settled()
            self.keep(s)

            s = begin("a_sequence_reaches_its_last_row")
            rows = np.tile(s.held(), (5, 1))
            rows[:, 0] += np.linspace(0, 0.05, 5)
            s.call("start_sequence", positions=rows, rate_hz=control_config.rate_hz / 2)
            s.until_hold()
            self.keep(s)

            for braking in ("station_limits", "move_caps"):
                s = begin("station_limits_brake_a_slow_move_sooner_than_its_own_caps", braking, braking=braking)
                s.jog(None, 1, 10 * tests.STEP_RAD, speed_scale=tests.SLOW_SCALE)
                s.tick(50)
                s.call("stop")
                s.until_hold()
                self.keep(s)

            s = begin("stale_feedback_faults")
            s.set("is_stale", True)
            s.tick()
            self.keep(s)

            s = begin("measured_hold_recovery_holds_where_the_arm_was_pushed")
            s.push(tests.DISPLACEMENT_RAD)
            s.wait("recover")
            self.keep(s)

            s = begin("measured_hold_recovery_never_holds_a_pose_past_the_feedback_bounds")
            s.push(tests.DISPLACEMENT_RAD)
            s.do("set_state", arm=first, index=1, value=limits.lower_bounds[1] - 2 * limits.feedback_tolerance)
            s.do("policy_step", timeout_s=tests.RECOVERY_TIMEOUT_S, is_stable=True)
            self.keep(s)

            s = begin("release_recovery_releases_the_old_target_slowly", recovery="ReleaseRecovery")
            s.push(tests.DISPLACEMENT_RAD)
            s.wait("recover")
            self.keep(s)

            s = begin("a_stalled_clock_advances_one_sample_per_step")
            s.jog(None, 1, 10 * tests.STEP_RAD)
            s.tick(10)
            s.tick(period_s=tests.STALL_PERIODS * period_s)
            self.keep(s)

            s = begin("a_hold_refreshes_the_driver_every_period")
            s.tick(7)
            self.keep(s)

            s = begin("a_sequence_late_after_a_stall_stops_at_its_deadline")
            rows = np.tile(s.held(), (tests.SEQUENCE_ROWS, 1))
            rows[:, 0] += np.linspace(0, tests.SEQUENCE_SPAN_RAD, tests.SEQUENCE_ROWS)
            s.call("start_sequence", positions=rows, rate_hz=control_config.rate_hz / 2)
            s.tick(3)
            s.tick(period_s=tests.STALL_PERIODS * period_s)
            s.until_hold()
            self.keep(s)

            s = begin("a_cancelled_operation_brakes_into_a_hold")
            s.jog(None, 1, 10 * tests.STEP_RAD)
            s.do("event", name="pause")
            s.do("attach", name="pause")
            s.tick(5)
            s.do("cancel", name="pause")
            s.tick()
            s.until_hold()
            self.keep(s)

            s = begin("an_operation_past_its_deadline_brakes_into_a_hold")
            s.jog(None, 1, 10 * tests.STEP_RAD)
            s.tick(5)
            margin_s = s.loop.MOVE_MARGIN_S + control_config.settle_timeout_s + tests.LATE_S
            s.tick(period_s=s.loop.operation.move.duration_s + margin_s)
            s.until_hold()
            self.keep(s)

            s = begin("persistent_motion_in_a_hold_faults_with_its_details_in_the_snapshot")
            s.set("velocity", tests.DRIFT_RAD_S)
            s.tick(int(control_config.settle_timeout_s / period_s) + tests.STALL_PERIODS)
            s.do("mutate_snapshot")
            self.keep(s)

            s = begin("a_failed_fault_hold_blocks_every_recovery")
            s.tamper("send", "raise", type="RuntimeError", message="bus write failed")
            s.set("is_stale", True)
            s.tick()
            s.do("untamper", method="send")
            s.set("is_stale", False)
            s.wait("recover")
            self.keep(s)

            s = begin("release_recovery_is_blocked_by_an_arm_moving_during_the_release", recovery="ReleaseRecovery")
            s.push(tests.DISPLACEMENT_RAD)
            jump = {"op": "shift", "arm": first, "index": 0, "delta": tests.DRIFT_RAD}
            s.wait("recover", hooks=[{"at": "before", "when": {"phase": "Releasing old target"}, "do": [jump]}])
            self.keep(s)

            s = begin("release_recovery_extends_its_automatic_timeout_to_a_long_release", recovery="ReleaseRecovery")
            s.push(tests.LONG_DISPLACEMENT_RAD)
            s.wait("recover")
            self.keep(s)

            for recovery in ("MeasuredHoldRecovery", "ReleaseRecovery"):
                s = begin("recovery_keeps_each_gripper_command", recovery, recovery=recovery)
                s.push(tests.DISPLACEMENT_RAD)
                s.do("shift", arm=None, index=layout.coordinate_count - 1, delta=-tests.SLIP)
                s.wait("recover")
                self.keep(s)

            for checks_velocity_rms in (False, True):
                variant = "rms" if checks_velocity_rms else "mean"
                s = begin("a_recovery_window_bounds_velocity_rms_only_when_asked", variant, checks_velocity_rms=checks_velocity_rms)
                s.fault_by_stale_feedback()
                s.set("velocity", tests.DRIFT_RAD_S)
                s.set("is_oscillating", True)
                s.wait("recover", timeout_s=tests.RECOVERY_TIMEOUT_S)
                self.keep(s)

            if len(layout.arms) > 1:
                s = begin("a_driver_reading_its_arms_in_another_order_keeps_the_layout_order")
                s.tamper("read", "reverse")
                s.push(tests.DISPLACEMENT_RAD)
                self.keep(s)

    # -- test_joint_control_in_station.py and test_stability_in_station.py: the loop of the two YAM arms on their
    #    stand-in joints, with the wide limits ("two_arm") and as their station of the tests ships them

    def of_two_arms(self) -> None:
        tests = pear_tests
        wide, shipped = "two_arm", "two_arm_station"
        wide_control, wide_config = self.stations.configs(wide)
        shipped_control, shipped_config = self.stations.configs(shipped)
        period_s = wide_control.control_period_s
        displaced = tests.ManualRecovery.DISPLACED_RAD

        def begin(test: str, variant: str = "", station: str = wide, source: str = JOINT_TESTS, **rig: Any) -> Scenario:
            name = f"{test}[{variant}]" if variant else test
            return self.begin(name, f"{source}::test_{test}", "two_arm", station, **rig)

        def chunk(s: Scenario, start: float, stop: float, count: int = 10) -> np.ndarray:
            """Returns ``count`` copies of the held targets, the right arm's first joint from ``start`` to ``stop``
            (YAMStationRig.chunk)."""
            actions = np.tile(s.held(), (count, 1))
            actions[:, 7] = np.linspace(start, stop, count)
            return actions

        def move_of_right_joint(s: Scenario, step: float) -> dict[str, Any]:
            start = list(s.loop.trajectory.input.current_position)
            goal = list(start)
            goal[7] += step
            return {"start": start, "goal": goal}

        for displacement in (0.150678, -0.3, 1.5):
            s = begin("recovery_releases_the_old_target_to_the_measured_pose_within_the_release_caps", str(displacement))
            s.displaced_hold(displacement)
            s.wait("recover")
            s.tick(30)
            self.keep(s)

        failure_hooks = {
            "cancel": lambda phase: [{"op": "cancel", "name": "pause"}],
            "stop": lambda phase: [{"op": "call", "method": "stop", "args": {}}],
            "hardware": lambda phase: [{"op": "tamper", "method": "read_for_recovery", "spec": {"kind": "raise", "type": "RuntimeError", "message": "injected hardware failure"}}],
            # verification sends nothing; a failure there models losing the reader
            "write": lambda phase: [{"op": "tamper", "method": "send" if phase == "Releasing old target" else "read_for_recovery", "spec": {"kind": "raise", "type": "RuntimeError", "message": "injected hardware failure"}}],
            "drift": lambda phase: [{"op": "position", "arm": "right", "values": [0.4, 0.0, 0.0, 0.0, 0.0, 0.0, 0.2]}],
        }
        for phase in ("Releasing old target", "Verifying new hold"):
            for failure, actions in failure_hooks.items():
                s = begin("transfer_failures_never_report_recovered_or_continue_sending", f"{failure}-{phase}")
                s.displaced_hold(displaced)
                s.do("event", name="pause")
                s.wait("recover", cancellation="pause", hooks=[{"at": "before", "when": {"phase": phase}, "do": actions(phase)}])
                s.tick(50)
                self.keep(s)

        s = begin("explicit_timeout_is_not_extended_to_finish_a_transfer")
        s.displaced_hold(displaced)
        s.wait("recover", timeout_s=0.8)
        self.keep(s)

        s = begin("cancelled_transfer_can_be_retried_from_last_acknowledged_target")
        s.displaced_hold(displaced)
        s.do("event", name="pause")
        pause = {"at": "after", "when": {"sent_over": 10}, "do": [{"op": "cancel", "name": "pause"}]}
        s.wait("recover", cancellation="pause", hooks=[pause])
        s.wait("recover")
        self.keep(s)

        s = begin("recovery_requires_new_window_discards_motion_and_invalidates_old_guards")
        s.jog("left", 1, 0.5)
        s.tick(40)
        s.do("guard", name="old")
        s.do("observe", name="old", positions=[0.0] * 14)
        s.fault_by_stale_feedback()
        s.tick(50)
        s.wait("recover")
        s.do("guard_check", name="old")
        s.call("verify_reference", observation="old")
        s.jog("left", 1, 0.1)
        s.finish()
        self.keep(s)

        unhealthy = {
            "bus": lambda s: s.set("failed_arm", "right"),
            "stale": lambda s: s.set("is_stale", True),
            "missing": lambda s: s.tamper("read", "drop", arm="right"),
            "nan": lambda s: s.tamper("read", "position", arm="left", index=0, value=math.nan),
            "bounds": lambda s: s.tamper("read", "position", arm="left", index=0, value=100.0),
            # even fresh-looking repeated sample identities cannot fill the window
            "frozen": lambda s: s.tamper("read", "sample_id", value=1),
            "moving": lambda s: s.tamper("read", "velocity", arm="left", values=[0.2, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
            "oscillating": lambda s: s.tamper("read", "alternate", field="velocity", arm="left", index=0, magnitude=0.2, by="clock"),
            "position_span": lambda s: s.tamper("read", "alternate", field="position", arm="left", index=0, magnitude=0.04, by="clock"),
        }
        for failure, apply in unhealthy.items():
            s = begin("unhealthy_feedback_never_recovers_or_sends", failure)
            s.fault_by_stale_feedback()
            apply(s)
            s.wait("recover", timeout_s=0.8)
            self.keep(s)

        interruptions = {
            "cancel": {"op": "cancel", "name": "pause"},
            "stop": {"op": "call", "method": "stop", "args": {}},
            "close": {"op": "call", "method": "close", "args": {}},
        }
        for interrupt, action in interruptions.items():
            s = begin("recovery_can_be_interrupted_without_motion", interrupt)
            s.fault_by_stale_feedback()
            s.do("event", name="pause")
            s.wait("recover", cancellation="pause", hooks=[{"at": "after", "when": {}, "do": [action]}])
            self.keep(s)

        s = begin("recovery_only_accepts_fault_and_refuses_concurrent_checks")
        s.call("recover")
        s.fault_by_stale_feedback()
        again = {"at": "before", "when": {}, "once": False, "do": [{"op": "call", "method": "recover", "args": {}}]}
        s.wait("recover", hooks=[again])
        self.keep(s)

        s = begin("static_tracking_offset_is_reported_without_fault_or_target_rewrite", station=shipped)
        s.tamper("send", "bias", arm="right", index=4, delta=-0.031234)
        s.jog("right", 1, 0.05)
        s.finish()
        # an excessive deviation stays a latched fault even in HOLD
        s.do("position", arm="right", values=[1.0, *s.driver.positions["right"][1:]])
        s.tick()
        self.keep(s)

        s = begin("complete_sequence_never_stops_between_rows_and_lags_within_dynamics", station=shipped)
        s.call("start_sequence", positions=chunk(s, 0.0, 0.2, count=20), rate_hz=25)
        s.finish()
        self.keep(s)

        for mode in ("stop", "fault", "deadline"):
            s = begin("interrupted_sequence_discards_every_unconsumed_action", mode, station=shipped)
            s.call("start_sequence", positions=chunk(s, 0, 0.2, count=30), rate_hz=25)
            s.tick(7)
            if mode == "stop":
                s.call("stop")
            elif mode == "fault":
                s.set("failed_arm", "left")
            else:
                s.do("clock", add=0.2)
            s.finish()
            self.keep(s)

        for bad in ("bounds", "nan", "too_long", "too_slow", "too_fast"):
            s = begin("invalid_complete_sequence_is_atomic", bad, station=shipped)
            values = chunk(s, 0, 0.04, count=1001 if bad == "too_long" else 10)
            if bad in ("bounds", "nan"):
                values[-1, 0] = 20 if bad == "bounds" else math.nan
            s.call("start_sequence", positions=values, rate_hz={"too_slow": 1, "too_fast": 51}.get(bad, 30))
            s.call("start_sequence", positions=chunk(s, 0, 0.04), rate_hz=30)
            s.call("start_sequence", positions=chunk(s, 0, 0.5), rate_hz=30)
            s.finish()
            self.keep(s)

        s = begin("task_accuracy_cannot_relax_measured_joint_bounds", station=shipped)
        resting = [0.0, shipped_config.arms["left"].limits.lower_bounds[1] - 0.03, 0.0, 0.0, 0.0, 0.0, 0.5]
        zeros = [0.0] * 7
        s.call("check_states", states={arm: {"position": resting, "velocity": zeros} for arm in ("left", "right")})
        self.keep(s)

        s = begin("feedback_tolerance_does_not_relax_action_bounds", station=shipped)
        within = [0.0, -0.0005, 0.0, 0.0, 0.0, 0.0, 1.003]
        s.call("check_states", states={arm: {"position": within, "velocity": zeros} for arm in ("left", "right")})
        past = {"left": {"position": [*within[:-1], 1.1], "velocity": zeros}, "right": {"position": within, "velocity": zeros}}
        s.call("check_states", states=past)
        self.keep(s)

        s = begin("reached_refers_to_requested_goal_and_stop_is_not_completion", station=shipped)
        # leave enough distance that braking cannot happen to reach the goal
        s.jog("right", 1, 1.5)
        s.tick(20)
        s.call("stop")
        s.finish()
        self.keep(s)

        s = begin("wait_cannot_complete_against_a_replacement_operation", station=shipped)
        s.jog("right", 1, 0.05)
        replace = [
            {"op": "call", "method": "stop", "args": {}},
            {"op": "tick", "n": 1, "period_s": None},
            {"op": "until", "statuses": ["HOLD", "FAULT"]},
            {"op": "jog", "arm": "left", "index": 0, "delta": 0.02},
        ]
        s.wait("wait_for_hold", timeout_s=JointControlLoop.HOLD_WAIT_S, hooks=[{"at": "before", "when": {"sleep": 1}, "do": replace}])
        self.keep(s)

        s = begin("stale_cached_hold_is_not_ready", station=shipped)
        s.tick(30)
        s.do("clock", add=shipped_control.state_timeout_s + 0.01)
        self.keep(s)

        s = begin("inactive_joint_position_change_during_settling_keeps_move", station=shipped)
        s.call("dispatch_joint_move", move=move_of_right_joint(s, 0.05))
        for _ in range(200):
            s.tick()
            if s.loop.snapshot()["motion"]["settling"]:
                break
        s.do("position", arm="left", values=[0.006, *s.driver.positions["left"][1:]])
        s.tick()
        s.finish()
        self.keep(s)

        for trigger in ("deadline", "cancel"):
            s = begin("failed_controlled_stop_never_sends_another_motion_command", trigger, station=shipped)
            s.call("dispatch_joint_move", move=move_of_right_joint(s, 0.05))
            s.tick(10)
            s.do("break_stop", message="No valid stop trajectory")
            if trigger == "deadline":
                # past the move's deadline: its duration, the settle timeout and the margin from its dispatch
                duration_s = s.loop.operation.move.duration_s
                s.do("clock", add=duration_s + shipped_control.settle_timeout_s + JointControlLoop.MOVE_MARGIN_S)
            else:
                s.do("event", name="pause")
                s.do("attach", name="pause")
                s.do("cancel", name="pause")
            s.tick()
            s.tick(3)
            self.keep(s)

        s = begin("hold_timeout_is_controller_owned_and_observers_cannot_restart_it", station=shipped)
        s.tick(30)
        s.tamper("read", "velocity", arm="left", values=[0.0, 0.0, 0.0, 0.08, 0.0, 0.0, 0.0])
        for _ in range(250):
            s.tick()
            if s.loop.status == "FAULT":
                break
            s.call("stability")
        self.keep(s)

        s = begin("bimanual_motion_and_derivative_bounds")
        targets = {arm: list(target) for arm, target in s.loop.targets.items()}
        targets["left"][0], targets["right"][1] = 0.2, -0.15
        s.call("move", targets=targets)
        s.until(["HOLD", "FAULT", "STOPPING"])
        self.keep(s)

        s = begin("moves_feed_planned_arm_velocity_forward_and_holds_send_none")
        s.jog("right", 2, 0.3)
        s.until(["HOLD", "FAULT", "STOPPING"])
        self.keep(s)

        for bad in (math.nan, math.inf, 100):
            s = begin("rejected_target_never_reaches_hardware", str(bad))
            s.jog("left", 1, bad)
            self.keep(s)

        s = begin("second_move_does_not_replace_active_plan")
        s.jog("left", 1, 0.2)
        s.jog("right", 1, 0.2)
        self.keep(s)

        s = begin("stop_decelerates_continuously_and_holds_before_goal")
        s.jog("left", 1, 1.0)
        s.tick(40)
        s.call("stop")
        s.until(["HOLD", "FAULT", "RUNNING"])
        self.keep(s)

        for gap in (0.02, 0.22):
            for fault in ("stale", "right_bus", "tracking"):
                s = begin("fault_latches_and_halts_both_arms", f"{fault}-{gap}")
                s.jog("left", 1, 0.3)
                s.tick(10)
                if fault == "stale":
                    s.set("is_stale", True)
                elif fault == "right_bus":
                    s.set("failed_arm", "right")
                else:
                    s.do("position", arm="right", values=[1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.5])
                s.do("clock", add=gap)
                s.do("step")
                s.set("is_stale", False)
                s.set("failed_arm", None)
                s.tick(5)
                s.jog("right", 1, 0.1)
                self.keep(s)

        for gap in (0.084, 0.22):
            for status in ("HOLD", "RUNNING", "STOPPING"):
                s = begin("delayed_tick_with_fresh_feedback_keeps_current_operation", f"{status}-{gap}")
                if status != "HOLD":
                    s.jog("left", 1, 0.3)
                s.tick(10)
                if status == "STOPPING":
                    s.call("stop")
                s.do("clock", add=gap)
                s.do("step")
                self.keep(s)

        s = begin("partial_write_fault_attempts_hold_on_both_arms")
        s.tamper("send", "partial", arm="left", times=1, type="RuntimeError", message="right arm write failed")
        s.jog("left", 1, 0.3)
        s.tick()
        self.keep(s)

        for settles in (True, False):
            # one controller period per startup read, and no sleep between two reads moves the clock
            velocities = [0.2, 0.0, 0.0, 0.1] + [0.0] * 20 if settles else [0.2] * 30
            before = [
                {"op": "tamper", "method": "read", "spec": {"kind": "advance_clock", "seconds": 1 / wide_control.rate_hz}},
                {"op": "tamper", "method": "read", "spec": {"kind": "sequence", "field": "velocity", "index": 0, "values": velocities}},
            ]
            variant = "settles" if settles else "moves"
            s = begin("enable_waits_for_stable_feedback_but_times_out_on_persistent_motion", variant, station="two_arm_enable", before=before, sleeps_while_enabling=False)
            self.keep(s)

        hooks_of = {
            "timeout": [],
            "fault": [{"at": "before", "when": {}, "do": [{"op": "set", "target": "driver", "name": "failed_arm", "value": "right"}]}],
            "interrupt": [{"at": "before", "when": {}, "do": [{"op": "raise", "type": "KeyboardInterrupt"}]}],
        }
        for failure, hooks in hooks_of.items():
            s = begin("wait_cannot_report_success_after_timeout_fault_or_interrupt", failure)
            s.jog("left", 1, 0.3)
            s.wait("wait_for_hold", timeout_s=0.1, hooks=hooks)
            self.keep(s)

        s = begin("wait_rejects_stale_hold_feedback")
        s.do("clock", add=wide_control.state_timeout_s + 0.01)
        s.wait("wait_for_hold", timeout_s=JointControlLoop.HOLD_WAIT_S)
        self.keep(s)

        s = begin("shutdown_waits_for_stop_and_releases_once")
        s.jog("left", 1, 1.0)
        s.tick(40)
        s.wait("shutdown")
        s.wait("shutdown")
        self.keep(s)

        s = begin("repeated_stop_does_not_restart_settling")
        s.jog("left", 1, 1.0)
        s.tick(40)
        for _ in range(200):
            s.call("stop")
            s.tick()
            if s.loop.status == "HOLD":
                break
        self.keep(s)

        # a thousand rows as in PEAR's tests from --scale 4 on; fewer in the committed set
        row_count = 1000 if self.scale >= 4 else 40
        for rate in (30, 50):
            s = begin("long_finite_sequence_consumes_every_row_once_despite_jitter", str(rate), station=shipped)
            start_s = s.clock.now  # the scenario's start: the control loop waited for settled feedback when it was made
            rows = np.tile(list(s.loop.trajectory.input.current_position), (row_count, 1))
            rows[:, 0] = np.linspace(0, 0.1 * row_count / 1000, row_count)
            s.call("start_sequence", positions=rows, rate_hz=rate)
            times = []
            for tick in range(1800):
                # jitter of a fraction of a period around each tick
                times.append(start_s + (tick + 1) * 0.02 + (0.0005, 0.0001, 0.0006)[tick % 3])
                s.do("tick_at", times=[times[-1]])
                if s.loop.status != "RUNNING":
                    break
            self.keep(s)

        s = begin("sustained_sequence_backlog_still_requests_controlled_stop", station=shipped)
        rows = np.tile(list(s.loop.trajectory.input.current_position), (row_count, 1))
        s.call("start_sequence", positions=rows, rate_hz=50)
        for _ in range(30):
            s.tick(period_s=0.025)
            if s.loop.status != "RUNNING":
                break
        s.until_hold()
        self.keep(s)

        # enabled with the left arm's J4 resting past its lower limit (startup_rig)
        resting = [0.0] * 6 + [0.5]
        resting[J4] = wide_config.arms["left"].limits.lower_bounds[J4] - OUTSIDE_RAD
        startup = [{"op": "position", "arm": "left", "values": resting}]
        self.keep(begin("holds_measured_outside_limit", before=startup))

        s = begin("only_inward_motion_allowed", before=startup)
        s.jog("left", J4 + 1, -OUTSIDE_RAD)
        s.jog("left", J4 + 1, 10 * OUTSIDE_RAD)
        s.until_hold()
        self.keep(s)

        s = begin("release_recovery_moves_only_inward_to_the_limit", before=startup)
        s.fault_by_stale_feedback()
        s.wait("recover")
        self.keep(s)

        for outside in ("joint 4 below its lower limit", "gripper past fully open"):
            limits = shipped_config.arms["left"].limits
            left, right = [AWAY_RAD, 0.0, 0.0, 0.0, 0.0, 0.0, 0.5], [AWAY_RAD, 0.0, 0.0, 0.0, 0.0, 0.0, 0.5]
            if outside.startswith("joint"):
                left[J4] = limits.lower_bounds[J4] - OUTSIDE_RAD
            else:
                left[6] = limits.upper_bounds[6] + OPENING_PAST
            before = [{"op": "position", "arm": "left", "values": left}, {"op": "position", "arm": "right", "values": right}]
            s = begin("recovery_after_a_fault_reaches_a_hold", outside, station=shipped, before=before)
            s.fault_by_stale_feedback()
            s.wait("recover")
            self.keep(s)

        # test_move_readiness_and_dispatch_are_atomic_with_concurrent_stop, without its robot and its second thread
        # (pear.js has neither): the readiness of a dispatch against the observation it refers to
        for readiness in ("settled", "unsettled", "invalidated", "malformed"):
            s = begin("move_readiness_and_dispatch_are_atomic_with_concurrent_stop", readiness)
            if readiness == "unsettled":  # one period of motion leaves the HOLD unsettled
                s.tamper("read", "velocity", index=0, value=2.0, times=1)
                s.tick()
            s.do("observe", name="held", positions=[0.0] * 3 if readiness == "malformed" else "target")
            if readiness == "invalidated":
                s.call("stop")
            s.call("dispatch_joint_move", move=move_of_right_joint(s, 0.03), observation="held")
            s.call("stop")
            self.keep(s)

        # test_stability_in_station.py: how a move settles on feedback that is not still
        for mode in ("spikes", "drift", "oscillation", "sustained_velocity"):
            s = begin("settling_uses_velocity_without_position_change_limits", mode, station=shipped, source=STABILITY_TESTS)
            if mode == "spikes":
                s.tamper("read", "alternate", field="velocity", arm="left", index=3, magnitude=0.3, by="count")
            elif mode == "drift":
                s.tamper("read", "drift", arm="left", index=3, rate=0.008, since=s.clock.now)
            elif mode == "oscillation":
                s.tamper("read", "alternate", field="position", arm="left", index=3, magnitude=0.003, by="count")
            else:
                s.tamper("read", "velocity", arm="left", index=3, value=0.08)
            s.jog("right", 1, 0.01)
            s.finish()
            self.keep(s)

    # -- test_so101_joint_in_station.py: the SO-101's loop on its own driver over the stand-in arm, without the
    #    feedforward (the tests of the feedforward in the driver belong to the hardware layer)

    def of_the_so101(self) -> None:
        quick, quick_home, shipped = "so101_quick", "so101_quick_home", "so101_station"
        _, quick_config = self.stations.configs(quick)
        overload = {"type": "ServoFault", "message": "Servo error: elbow_flex: overload"}
        torque_off = {"type": "ServoFault", "message": "Servo torque is off: gripper"}

        def begin(test: str, variant: str = "", station: str = quick, **rig: Any) -> Scenario:
            name = f"{test}[{variant}]" if variant else test
            return self.begin(name, f"{SO101_TESTS}::test_{test}", "so101", station, **rig)

        self.keep(begin("the_stand_in_driver_runs_without_the_stations_feedforward", station=shipped))

        for station in (quick_home, shipped):
            s = begin("the_gripper_reaches_both_endpoints", station, station=station)
            s.call("begin_grippers", request=False)
            s.finish()
            s.call("report")
            s.call("begin_grippers", request=True)
            s.finish()
            s.call("report")
            self.keep(s)

        s = begin("blocked_jaw_is_judged_where_it_stopped", station=quick_home)
        s.set("blocked_gripper_opening", 0.4, "arm")
        s.call("begin_grippers", request=False)
        s.finish()
        s.call("report")
        s.call("requested_position")
        self.keep(s)

        s = begin("jaw_that_never_arrives_faults", station=quick_home)
        s.call("begin_grippers", request=False)
        s.finish()
        s.set("response", {"kind": "min_gripper", "limit": 0.5}, "arm")
        s.call("begin_grippers", request=True)
        s.finish()
        self.keep(s)

        past = [0.0, quick_config.limits.lower_bounds[1] - 0.03, 0.0, 0.0, 0.0, 1.0]
        self.keep(begin("initial_hold_is_the_measured_pose_even_past_a_limit", before=[{"op": "position", "arm": ARM, "values": past}]))

        s = begin("a_brief_bus_glitch_does_not_fault")
        s.until_settled()
        s.set("failure", {"type": "RuntimeError", "message": "Incorrect status packet"}, "arm")
        s.tick(2)  # two ticks, well inside state_timeout_s
        s.set("failure", None, "arm")
        s.tick(3)
        self.keep(s)

        glitch = {"kind": "raise", "skip": 1, "times": 1, "type": "RuntimeError", "message": "Incorrect status packet"}
        self.keep(begin("a_bus_glitch_while_enabling_settles_fails_the_enable", before=[{"op": "tamper", "method": "read", "spec": glitch}]))

        s = begin("lost_feedback_faults_after_state_timeout")
        s.set("failure", {"type": "RuntimeError", "message": "bus unplugged"}, "arm")
        s.until(["FAULT"], most=50)
        self.keep(s)

        s = begin("servo_fault_is_immediate_and_holds_the_measured_pose")
        s.until_settled()
        s.do("shift", arm=ARM, index=0, delta=0.1)  # the arm was pushed away from its target, within the tracking bound
        s.tick()
        s.set("failure", overload, "arm")
        s.tick()
        self.keep(s)

        s = begin("recovery_reacquires_a_hold")
        s.set("failure", torque_off, "arm")
        s.tick()
        s.set("failure", {"type": "ServoFault", "message": "still off"}, "arm")
        s.wait("recover", timeout_s=1)
        s.set("failure", None, "arm")
        s.wait("recover", timeout_s=2)
        self.keep(s)

        folded = [0.0, quick_config.limits.lower_bounds[1] - quick_config.feedback_position_tolerance / 2, 0.0, 0.0, 0.0, 1.0]
        s = begin("recovery_holds_the_folded_rest_pose_past_a_limit", before=[{"op": "position", "arm": ARM, "values": folded}])
        s.set("failure", torque_off, "arm")
        s.tick()
        s.set("failure", None, "arm")
        s.wait("recover", timeout_s=2)
        self.keep(s)

        # the servo of test_without_feedforward_the_same_arm_stops_short, with a constant load in the gravity's place
        s = begin("without_feedforward_the_same_arm_stops_short")
        s.set("response", {"kind": "sag", "sag": [0.0, 0.012, 0.015, 0.008, 0.0], "friction": [0.006, 0.016, 0.016, 0.008, 0.006]}, "arm")
        s.until_settled()
        for joint_number, step in enumerate((0.1, 0.2, -0.2, 0.15, 0.1), start=1):
            s.jog(ARM, joint_number, step)
            s.wait("wait_for_hold", timeout_s=3)
        self.keep(s)

    # -- what PEAR's tests leave out: every state a stop can meet, every fault, the waits, the refusals

    def beyond_pears_tests(self) -> None:
        tests = pear_tests
        boom = {"type": "RuntimeError", "message": "bus write failed"}
        for robot, station in ROBOTS:
            control_config, robot_config = self.stations.configs(station)
            layout = robot_config.LAYOUT
            first, width = layout.arms[0], layout.coordinate_count

            def begin(name: str, variant: str = "", **rig: Any) -> Scenario:
                return self.begin(f"{name}[{robot}{'-' + variant if variant else ''}]", "beyond PEAR's tests", "memory", station, **rig)

            for braking in ("station_limits", "move_caps"):
                s = begin("a_stop_in_every_state", braking, braking=braking)
                s.call("stop")  # in a HOLD only the generation advances
                s.jog(None, 1, 0.3)
                s.tick(8)
                s.call("stop", reason="operator")  # a word of the caller's own
                s.tick(2)
                s.call("stop")  # while stopping: nothing
                s.until_hold()
                s.fault_by_stale_feedback()
                s.call("stop")
                s.call("close")
                s.call("stop")
                s.tick(2)  # a closed loop steps nothing
                self.keep(s)

            s = begin("a_controlled_stop_past_its_deadline_faults")
            s.jog(None, 1, 10 * tests.STEP_RAD)
            s.tick(10)
            s.call("stop")
            s.do("clock", add=500.0)
            s.tick(2)
            self.keep(s)

            s = begin("a_move_that_never_comes_to_rest_faults")
            s.jog(None, 1, tests.STEP_RAD)
            s.tick(3)
            s.set("velocity", tests.DRIFT_RAD_S)
            s.until(["FAULT", "HOLD"])
            self.keep(s)

            s = begin("a_tracking_error_while_moving_faults_and_recovers")
            s.jog(None, 1, 5 * tests.STEP_RAD)
            s.tick(5)
            s.set("is_following", False)
            s.do("shift", arm=first, index=0, delta=0.6)
            s.tick(2)
            s.wait("recover")
            self.keep(s)

            for failing in ("read", "send", "send_twice", "refresh_hold", "read_in_fault"):
                s = begin("a_driver_that_raises", failing)
                if failing == "read_in_fault":
                    s.fault_by_stale_feedback()
                    s.tamper("read", "raise", type="OSError", message="bus down")
                    s.tick(3)
                    s.do("untamper", method="read")
                    s.tick(2)
                else:
                    if failing.startswith("send"):
                        s.jog(None, 1, 3 * tests.STEP_RAD)
                        s.tick(3)
                    method = "send" if failing.startswith("send") else failing
                    s.tamper(method, "raise", times=2 if failing == "send_twice" else 1, **boom)
                    s.tick(3)
                s.wait("recover")
                self.keep(s)

            malformed = {
                "nan": {"kind": "position", "arm": first, "index": 2, "value": math.nan},
                "infinite_velocity": {"kind": "velocity", "arm": first, "index": 0, "value": math.inf},
                "bounds": {"kind": "position", "arm": first, "index": 1, "value": 50.0},
                "short": {"kind": "position", "arm": first, "values": [0.0] * (width - 1)},
                "from_the_future": {"kind": "stamp", "offset": 0.5},
                "old": {"kind": "stamp", "offset": -0.5},
            }
            if len(layout.arms) > 1:
                malformed["missing_arm"] = {"kind": "drop", "arm": layout.arms[1]}
            for failing, spec in malformed.items():
                s = begin("malformed_feedback_faults", failing)
                s.do("tamper", method="read", spec={**spec, "times": 1})
                s.tick(2)
                self.keep(s)

            s = begin("recovery_is_refused_or_times_out")
            s.call("recover")
            s.fault_by_stale_feedback()
            for timeout_s in (0, math.nan, -1.0, math.inf):
                s.call("recover", timeout_s=timeout_s)
            s.do("event", name="pause")
            s.do("cancel", name="pause")
            s.call("recover", cancellation="pause")
            s.set("velocity", tests.DRIFT_RAD_S)
            s.wait("recover", timeout_s=0.3)
            s.set("velocity", 0.0)
            s.wait("recover")
            self.keep(s)

            s = begin("a_closed_loop_refuses")
            s.tick(3)
            s.call("close")
            s.call("close")
            s.jog(None, 1, tests.STEP_RAD)
            s.call("recover")
            s.wait("wait_for_hold", timeout_s=1.0)
            s.tick(2)
            self.keep(s)

            s = begin("a_close_that_fails_still_closes")
            s.tamper("close", "raise", type="OSError", message="port gone")
            s.call("close")
            self.keep(s)

            waits = {
                "settled_hold": {"timeout_s": 1.0},
                "accepts_never": {"timeout_s": 0.1, "accepts": "never"},
                "not_a_number": {"timeout_s": math.nan},
                "negative": {"timeout_s": -1.0},
            }
            for waiting, options in waits.items():
                s = begin("a_wait_for_a_hold", waiting)
                s.until_settled()
                s.wait("wait_for_hold", **options)
                self.keep(s)

            s = begin("a_wait_for_a_hold", "reached")
            s.jog(None, 1, tests.STEP_RAD)
            s.wait("wait_for_hold", timeout_s=20.0, accepts="reached")
            self.keep(s)

            s = begin("a_wait_for_a_hold", "label_and_timeout")
            s.jog(None, 1, 10 * tests.STEP_RAD)
            s.wait("wait_for_hold", timeout_s=0.05, label="Home")
            s.until_hold()
            self.keep(s)

            s = begin("a_wait_for_a_hold", "guarded_and_paused")
            s.do("event", name="pause")
            s.do("guard", name="action", cancellation="pause")
            s.jog(None, 1, 5 * tests.STEP_RAD, guard="action")
            pause = {"at": "after", "when": {"sleep": 3}, "do": [{"op": "cancel", "name": "pause"}]}
            s.wait("wait_for_hold", timeout_s=20.0, guard="action", hooks=[pause])
            s.until_hold()
            self.keep(s)

            s = begin("a_wait_for_a_hold", "guard_of_another_operation")
            s.do("guard", name="action")
            s.jog(None, 1, tests.STEP_RAD)
            s.wait("wait_for_hold", timeout_s=20.0, guard="action")
            s.until_hold()
            self.keep(s)

            s = begin("a_hold_is_transferred_by_hand")
            s.fault_by_stale_feedback()
            targets = {arm: list(target) for arm, target in s.loop.targets.items()}
            targets[first][0] += 0.01
            s.call("transfer_hold", targets=targets)
            s.tamper("send", "raise", times=1, **boom)
            s.call("transfer_hold", targets=targets)
            s.call("recover")
            self.keep(s)

            s = begin("a_reference_is_verified")
            s.call("verify_reference", observation=None)
            s.do("observe", name="held", positions="state")
            s.call("verify_reference", observation="held")
            s.do("observe", name="short", positions=[0.0])
            s.call("verify_reference", observation="short")
            s.do("observe", name="not_finite", positions=[math.nan] * layout.vector_length)
            s.call("verify_reference", observation="not_finite")
            s.call("stop")
            s.call("verify_reference", observation="held")
            s.do("clock", add=1.0)
            s.call("verify_reference", observation=None)
            self.keep(s)

            s = begin("moves_and_sequences_are_refused")
            held = s.held()
            arms = {arm: list(target) for arm, target in s.loop.targets.items()}
            s.call("move", targets={first: arms[first], "elbow": arms[first]})
            s.call("move", targets={})
            s.call("dispatch_joint_move", move=None)
            s.call("dispatch_joint_move", move={"start": [value + 0.01 for value in held], "goal": held})
            for speed_scale in (0.0, 1.5, math.nan):
                s.call("move", targets=arms, speed_scale=speed_scale)
            s.jog(None, 1, 2 * tests.STEP_RAD)
            s.tick(2)
            s.jog(None, 1, tests.STEP_RAD)
            s.call("start_sequence", positions=[held], rate_hz=25.0)
            s.call("dispatch_joint_move", move={"start": held, "goal": held})
            s.until_hold()
            self.keep(s)

            s = begin("a_move_within_caps_at_a_speed")
            caps = {"velocity": [0.15] * width, "acceleration": [0.4] * width, "jerk": [1.5] * width}
            arms = {arm: list(target) for arm, target in s.loop.targets.items()}
            arms[first][0] += 0.2
            arms[layout.arms[-1]][1] -= 0.1
            s.call("move", targets=arms, speed_scale=0.5, caps=caps)
            s.until_hold()
            self.keep(s)

            s = begin("the_stability_history_is_read")
            s.until_settled()
            s.call("stability")
            s.call("stability", arms=[first])
            s.call("stability", duration_s=control_config.settle_window_s / 2)
            s.call("stability", arms=["nobody"])
            s.call("stability", duration_s=0.0)
            self.keep(s)

            s = begin("a_move_needs_a_stationary_planned_state")
            moving = [0.0] * layout.vector_length
            moving[0] = JointControlLoop.STATIONARY_EPSILON / 2  # at rest still
            s.do("set_input", name="current_velocity", values=moving)
            s.jog(None, 1, tests.STEP_RAD)
            s.until_hold()
            moving[-1] = -0.01
            s.do("set_input", name="current_velocity", values=moving)
            s.jog(None, 1, tests.STEP_RAD)
            s.call("dispatch_joint_move", move={"start": s.held(), "goal": s.held()})
            self.keep(s)

            s = begin("a_sequence_refers_to_an_observation")
            rows = np.tile(s.held(), (3, 1))
            rows[:, 0] += np.linspace(0, 0.01, 3)
            s.tamper("read", "velocity", index=0, value=2.0, times=1)  # one period of motion: the HOLD is unsettled
            s.tick()
            s.do("observe", name="held", positions="target")
            s.call("start_sequence", positions=rows, rate_hz=25.0, observation="held")
            s.until_settled()
            s.call("start_sequence", positions=rows, rate_hz=25.0, observation="held")
            s.tick(2)
            s.do("observe", name="running", positions="target")
            s.call("dispatch_joint_move", move={"start": s.held(), "goal": s.held()}, observation="running")
            s.call("start_sequence", positions=rows, rate_hz=25.0, observation="running")
            s.until_hold()
            s.call("start_sequence", positions=rows, rate_hz=25.0, observation="held")
            s.do("observe", name="short", positions=[0.0])
            s.call("start_sequence", positions=rows, rate_hz=25.0, observation="short")
            self.keep(s)

            s = begin("a_recovery_needs_the_control_thread")
            s.fault_by_stale_feedback()
            s.do("set_exit")
            s.call("recover")
            s.tick(2)
            self.keep(s)

            s = begin("an_interrupted_sequence_whose_stop_fails")
            rows = np.tile(s.held(), (tests.SEQUENCE_ROWS, 1))
            rows[:, 0] += np.linspace(0, tests.SEQUENCE_SPAN_RAD, tests.SEQUENCE_ROWS)
            s.call("start_sequence", positions=rows, rate_hz=control_config.rate_hz / 2)
            s.tick(3)
            s.do("break_stop", message="No valid stop trajectory")
            s.tick(period_s=tests.STALL_PERIODS * control_config.control_period_s)
            s.tick(2)
            self.keep(s)

            s = begin("a_release_is_blocked_by_the_joint_that_drifted_most", recovery="ReleaseRecovery")
            s.push(tests.DISPLACEMENT_RAD)
            jumps = [
                {"op": "shift", "arm": layout.arms[-1], "index": 0, "delta": 0.6 * tests.DRIFT_RAD},
                {"op": "shift", "arm": layout.arms[-1], "index": 2, "delta": -tests.DRIFT_RAD},
            ]
            s.wait("recover", hooks=[{"at": "before", "when": {"phase": "Releasing old target"}, "do": jumps}])
            self.keep(s)

            s = begin("a_wait_for_a_hold", "unstable_hold")
            s.until_settled()
            s.tamper("read", "velocity", arm=first, index=1, value=tests.DRIFT_RAD_S)
            s.tick(8)
            s.wait("wait_for_hold", timeout_s=0.1)
            self.keep(s)

            s = begin("a_snapshot_is_read")
            s.call("snapshot")
            s.jog(None, 1, tests.STEP_RAD)
            s.tick(2)
            s.call("snapshot")
            s.call("requested_position")
            self.keep(s)

        # the SO-101's own loop: its jaw, its STOP caps, its servos' status in a snapshot
        quick_home, shipped = "so101_quick_home", "so101_station"

        def so101(name: str, station: str = quick_home, **rig: Any) -> Scenario:
            return self.begin(f"so101_{name}", "beyond PEAR's tests", "so101", station, **rig)

        s = so101("a_stop_during_a_gripper_operation")
        s.call("begin_grippers", request=False)
        s.tick(4)
        s.call("stop")
        s.until_hold()
        s.call("begin_grippers", request=True)
        s.finish()
        s.call("report")
        self.keep(s)

        s = so101("a_gripper_operation_past_its_deadline")
        s.call("begin_grippers", request=False)
        s.tick(3)
        s.do("clock", add=JointControlLoop.GRIPPER_TIMEOUT_S + 1.0)
        s.tick()
        s.until(["HOLD", "FAULT"])
        self.keep(s)

        s = so101("a_gripper_operation_is_refused")
        s.jog(ARM, 1, 0.3)
        s.call("begin_grippers", request=False)
        s.until_hold()
        s.do("clock", add=0.5)
        s.call("begin_grippers", request=False)
        self.keep(s)

        s = so101("a_cancelled_gripper_operation")
        s.do("event", name="pause")
        s.do("guard", name="action", cancellation="pause")
        s.do("submit", guard="action", method="begin_grippers", request=False)
        s.tick(3)
        s.do("cancel", name="pause")
        s.tick()
        s.until_hold()
        self.keep(s)

        s = so101("a_wait_after_a_move")
        s.jog(ARM, 1, 0.2)
        s.wait("wait_for_hold", timeout_s=3.0)
        self.keep(s)

        s = so101("a_wait_that_times_out_shows_the_servos_status", station=shipped)
        motors = ("shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper")
        status = {"torque": dict.fromkeys(motors, 1), "status": dict.fromkeys(motors, 0), "polled_monotonic_s": 99.5}
        s.tamper("read", "servo", status=status)
        s.jog(ARM, 1, 1.0)
        s.wait("wait_for_hold", timeout_s=0.06)
        s.until_hold()
        self.keep(s)

        s = so101("a_shutdown_from_a_move", station=shipped)
        s.jog(ARM, 1, 0.5)
        s.tick(20)
        s.wait("shutdown")
        self.keep(s)

        s = so101("a_shutdown_from_a_fault")
        s.set("failure", {"type": "ServoFault", "message": "Servo error: gripper: overheat"}, "arm")
        s.tick()
        s.wait("shutdown")
        self.keep(s)

        s = so101("a_sequence")
        rows = np.tile(s.held(), (12, 1))
        rows[:, 0] += np.linspace(0, 0.08, 12)
        rows[:, 5] -= np.linspace(0, 0.3, 12)
        s.call("start_sequence", positions=rows, rate_hz=25.0)
        s.finish()
        self.keep(s)

        s = so101("a_stop_with_the_stop_caps", station=shipped)
        s.jog(ARM, 1, 1.0)
        s.tick(30)
        s.call("stop")
        s.until_hold()
        self.keep(s)

        s = so101("a_tracking_fault_and_the_measured_hold")
        s.until_settled()
        s.do("shift", arm=ARM, index=1, delta=0.4)
        s.tick(2)
        s.wait("recover")
        s.jog(ARM, 1, 0.1)
        s.until_hold()
        self.keep(s)

        s = so101("an_arm_that_lags")
        s.set("response", {"kind": "lag", "gain": 0.5}, "arm")
        s.jog(ARM, 2, 0.3)
        s.wait("wait_for_hold", timeout_s=3.0)
        self.keep(s)

        for magnitude in (0.5, 0.05):
            # a velocity reading that alternates about zero: its mean is at rest, its RMS is not, and the SO-101's
            # recovery window bounds the mean alone
            s = so101(f"a_recovery_on_a_velocity_that_alternates[{magnitude}]")
            s.set("failure", {"type": "ServoFault", "message": "Servo error: elbow_flex: overload"}, "arm")
            s.tick()
            s.set("failure", None, "arm")
            s.tamper("read_for_recovery", "alternate", field="velocity", index=1, magnitude=magnitude, by="count")
            s.wait("recover", timeout_s=2.0)
            self.keep(s)

        s = so101("a_report_before_the_outcome")
        s.call("begin_grippers", request=False)
        s.tick(2)
        s.call("report")
        s.call("stop")
        s.until_hold()
        s.call("report")
        self.keep(s)

        for station in (quick_home, shipped):
            s = so101(f"a_wait_that_times_out_on_an_unstable_hold[{station}]", station=station)
            s.until_settled()
            s.tamper("read", "velocity", index=2, value=0.5)
            s.tick(8)
            s.wait("wait_for_hold", timeout_s=0.1)
            self.keep(s)

        # the two arms when one of them, or neither, is fed the planned velocity
        for station in ("two_arm_left_unfed", "two_arm_unfed"):
            s = self.begin(f"planned_velocities_of_fed_arms_alone[{station}]", "beyond PEAR's tests", "two_arm", station)
            targets = {arm: list(target) for arm, target in s.loop.targets.items()}
            targets["left"][1], targets["right"][0] = 0.1, -0.1
            s.call("move", targets=targets)
            s.until_hold()
            s.fault_by_stale_feedback()
            s.wait("recover")
            self.keep(s)

        s = self.begin("a_wait_that_times_out_on_an_unstable_hold[two_arm]", "beyond PEAR's tests", "two_arm", "two_arm")
        s.until_settled()
        s.tamper("read", "velocity", arm="right", index=3, value=0.5)
        s.tick(8)
        s.wait("wait_for_hold", timeout_s=0.1)
        self.keep(s)

        # the release recovery of two arms, where PEAR's tests stop short
        s = self.begin("a_release_stopped_by_motion", "beyond PEAR's tests", "two_arm", "two_arm")
        s.displaced_hold(tests.ManualRecovery.DISPLACED_RAD)
        shake = {"op": "tamper", "method": "read_for_recovery", "spec": {"kind": "velocity", "arm": "left", "index": 2, "value": 0.5}}
        s.wait("recover", hooks=[{"at": "before", "when": {"phase": "Releasing old target"}, "do": [shake]}])
        self.keep(s)

        self.at_the_edges()

    def at_the_edges(self) -> None:
        """Scenarios at the edges of what the loop and its recovery policies decide: how close a move must start,
        when a recovery's time is up, which checks of a policy hold when the loop's own have passed."""
        tests = pear_tests
        source = "beyond PEAR's tests"
        for robot, station in ROBOTS:
            control_config, robot_config = self.stations.configs(station)
            limits, layout = robot_config.joint_limits(), robot_config.LAYOUT
            first, last, width = layout.arms[0], layout.arms[-1], layout.coordinate_count
            gripper = width - 1

            def begin(name: str, variant: str = "", **rig: Any) -> Scenario:
                return self.begin(f"{name}[{robot}{'-' + variant if variant else ''}]", source, "memory", station, **rig)

            # how close to the held command a checked move must start: the first coordinate rests at zero, so
            # that the distances are the numbers given
            start = list(Robots.rest(robot_config))
            start[0] = 0.0
            s = begin("a_move_must_start_at_the_held_command", start=start)
            epsilon = JointControlLoop.START_EPSILON
            for apart in (2 * epsilon, math.nextafter(epsilon, math.inf), epsilon, -epsilon, epsilon / 2, 0.0):
                begun, goal = s.held(), s.held()
                begun[0] += apart
                goal[1] += tests.STEP_RAD
                if s.call("dispatch_joint_move", move={"start": begun, "goal": goal}) == {"ok": True}:
                    s.until_hold()
            for apart in (2 * epsilon, epsilon / 2, -epsilon / 2):  # and of a coordinate that does not rest at zero
                begun, goal = s.held(), s.held()
                begun[1] += apart
                goal[2] += tests.STEP_RAD
                if s.call("dispatch_joint_move", move={"start": begun, "goal": goal}) == {"ok": True}:
                    s.until_hold()
            self.keep(s)

            # a recovery whose caller gives no timeout takes the policy's, and fails when that has passed
            for recovery in ("MeasuredHoldRecovery", "ReleaseRecovery"):
                s = begin("a_recovery_without_a_timeout_ends_at_the_policys", recovery, recovery=recovery)
                s.fault_by_stale_feedback()
                s.set("velocity", tests.DRIFT_RAD_S)
                s.wait("recover")
                s.set("velocity", 0.0)
                s.wait("recover")
                self.keep(s)

            # a recovery's time is up at its deadline, not after it: the clock is put on the deadline itself
            for recovery in ("MeasuredHoldRecovery", "ReleaseRecovery"):
                s = begin("a_recovery_ends_at_its_deadline", recovery, recovery=recovery)
                s.fault_by_stale_feedback()
                on_time = {"at": "before", "when": {"sleep": 4}, "do": [{"op": "clock", "to": "recovery_deadline"}]}
                s.wait("recover", timeout_s=1.0, hooks=[on_time])
                s.tick(2)
                self.keep(s)

            # a fault while the last reading is too old keeps the targets: the measured pose is not taken from it
            s = begin("a_fault_on_an_old_reading_keeps_the_targets")
            s.set("is_following", False)
            s.do("shift", arm=first, index=0, delta=0.01)
            s.tick(2)
            s.do("clock", add=5 * control_config.state_timeout_s)
            s.tamper("read", "raise", times=1, type="OSError", message="bus down")
            s.tick(2)
            self.keep(s)

            # an arm that leaves its new hold while a recovery verifies it: the measured hold's recovery
            s = begin("a_recovery_whose_arm_leaves_the_hold_it_verifies", "MeasuredHoldRecovery")
            s.fault_by_stale_feedback()
            s.set("is_following", False)
            leaves = {"op": "shift", "arm": first, "index": 0, "delta": 0.6}
            s.wait("recover", hooks=[{"at": "before", "when": {"phase": "Verifying new hold"}, "do": [leaves]}])
            self.keep(s)

            # a gripper that slips while a release verifies its hold: neither the drift nor the tracking is the gripper's
            s = begin("a_release_whose_gripper_slips_while_it_verifies", recovery="ReleaseRecovery")
            s.push(tests.DISPLACEMENT_RAD)
            slips = {"op": "shift", "arm": first, "index": gripper, "delta": -0.3}
            s.wait("recover", hooks=[{"at": "before", "when": {"phase": "Verifying new hold"}, "do": [slips]}])
            self.keep(s)

            # two joints that drift alike during a release: the first of them is named
            s = begin("a_release_is_blocked_by_the_first_of_two_joints_that_drifted_alike", recovery="ReleaseRecovery")
            s.push(tests.DISPLACEMENT_RAD)
            jumps = [{"op": "shift", "arm": last, "index": index, "delta": tests.DRIFT_RAD} for index in (1, 0)]
            s.wait("recover", hooks=[{"at": "before", "when": {"phase": "Releasing old target"}, "do": jumps}])
            self.keep(s)

            # a joint that drifts by the position tolerance itself, and by the next number above it
            for variant, drift in (("by_the_tolerance", robot_config.position_tolerance), ("past_the_tolerance", math.nextafter(robot_config.position_tolerance, math.inf))):
                rest = list(Robots.rest(robot_config))
                rest[width * (len(layout.arms) - 1) + 2] = 0.0  # (the joint that drifts starts at zero)
                s = begin("a_release_whose_joint_drifts", variant, recovery="ReleaseRecovery", start=rest)
                s.push(tests.DISPLACEMENT_RAD)
                jump = {"op": "shift", "arm": last, "index": 2, "delta": drift}
                s.wait("recover", hooks=[{"at": "before", "when": {"phase": "Releasing old target"}, "do": [jump]}])
                self.keep(s)

            # targets next to the measured pose: a release for what is further than its epsilon, none for less
            for variant, apart in (("released", 5e-8), ("not_released", 5e-10)):
                s = begin("a_release_of_targets_next_to_the_pose", variant, recovery="ReleaseRecovery")
                s.fault_by_stale_feedback()
                s.set("is_following", False)
                s.do("shift", arm=first, index=0, delta=apart)
                s.wait("recover")
                self.keep(s)

            # targets put past the feedback bounds by hand: a release does not start from them
            s = begin("a_release_from_targets_past_the_bounds", recovery="ReleaseRecovery")
            s.fault_by_stale_feedback()
            s.set("is_following", False)
            targets = {arm: list(target) for arm, target in s.loop.targets.items()}
            targets[first][1] = limits.lower_bounds[1] - 3 * limits.feedback_tolerance
            s.call("transfer_hold", targets=targets)
            s.wait("recover")
            self.keep(s)

            # one step of a policy on a request that the operator has paused, and on one that has not been
            for recovery in ("MeasuredHoldRecovery", "ReleaseRecovery"):
                for cancelled in (True, False):
                    variant = f"{recovery}-{'paused' if cancelled else 'going'}"
                    s = begin("a_policy_steps_a_request_of_its_own", variant, recovery=recovery)
                    s.push(tests.DISPLACEMENT_RAD)
                    s.do("policy_step", timeout_s=tests.RECOVERY_TIMEOUT_S, is_stable=True, cancelled=cancelled)
                    s.do("policy_step", timeout_s=tests.RECOVERY_TIMEOUT_S, is_stable=False, cancelled=cancelled)
                    self.keep(s)

            # a pause that is set when the measured hold's recovery is about to complete: the hold is not taken
            s = begin("a_policy_does_not_complete_a_request_that_is_paused")
            s.push(tests.DISPLACEMENT_RAD)
            verifying = RecoveryPhase.VERIFYING_HOLD.value
            s.do("policy_step", timeout_s=tests.RECOVERY_TIMEOUT_S, is_stable=True, cancelled=True, from_phase=verifying)
            s.tick(2)
            self.keep(s)

            # a planned speed at the epsilon of rest, at the next number above it and at twice it
            s = begin("a_move_needs_a_planned_speed_within_the_epsilon")
            epsilon = JointControlLoop.STATIONARY_EPSILON
            for speed in (epsilon, math.nextafter(epsilon, math.inf), 2 * epsilon):
                moving = [0.0] * layout.vector_length
                moving[1] = -speed
                s.do("set_input", name="current_velocity", values=moving)
                if s.jog(None, 1, tests.STEP_RAD) == {"ok": None}:
                    s.until_hold()
            self.keep(s)

            # a recovery asked for with a pause that is set already: in a HOLD, in a FAULT, and with no time
            s = begin("a_recovery_that_is_paused_before_it_begins")
            s.do("event", name="pause")
            s.do("cancel", name="pause")
            s.call("recover", cancellation="pause")
            s.call("recover", cancellation="pause", timeout_s=0)
            s.fault_by_stale_feedback()
            s.call("recover", cancellation="pause")
            s.call("recover", cancellation="pause", timeout_s=math.nan)
            s.tick(2)
            self.keep(s)

            # readings that name other arms than the layout's: one more, as many under another name, none
            s = begin("readings_of_other_arms_are_refused")
            read = {arm: {"position": list(s.loop.targets[arm]), "velocity": [0.0] * width} for arm in layout.arms}
            s.call("check_states", states=read)
            s.call("check_states", states={**read, "elbow": read[first]})
            s.call("check_states", states={**{arm: read[arm] for arm in layout.arms[:-1]}, "elbow": read[last]})
            s.call("check_states", states={})
            self.keep(s)

            # the cancellation of an operation that faulted goes with the fault's recovery
            s = begin("a_recovery_drops_the_cancellation_of_the_operation_that_faulted")
            s.jog(None, 1, 5 * tests.STEP_RAD)
            s.do("event", name="pause")
            s.do("attach", name="pause")
            s.tick(3)
            s.fault_by_stale_feedback()
            s.tick(2)
            s.wait("recover")
            s.tick(2)
            self.keep(s)

            # a fault that has details, recovered: the details go with the fault
            s = begin("a_recovery_clears_the_details_of_its_fault")
            s.set("velocity", tests.DRIFT_RAD_S)
            s.until(["FAULT"])
            s.set("velocity", 0.0)
            s.wait("recover")
            s.call("snapshot")
            self.keep(s)

            # the time of a recovery that passes while its caller sleeps: the caller's own check ends the recovery
            s = begin("a_recovery_whose_time_passes_between_two_periods")
            s.fault_by_stale_feedback()
            late = {"at": "after", "when": {"sleep": 3}, "do": [{"op": "clock", "add": 5.0}]}
            s.wait("recover", timeout_s=1.0, hooks=[late])
            s.tick(2)
            self.keep(s)

            # a read that fails in FAULT is logged once, and once more after a good read has come between
            s = begin("a_failed_read_in_fault_is_logged_again_after_a_good_one")
            s.fault_by_stale_feedback()
            for _ in range(2):
                s.tamper("read", "raise", type="OSError", message="bus down")
                s.tick(3)
                s.do("untamper", method="read")
                s.tick(2)
            self.keep(s)

            # a move at its deadline and at the next instant: its time is up after the deadline, not at it
            s = begin("a_move_at_its_deadline")
            s.jog(None, 1, 10 * tests.STEP_RAD)
            s.tick(5)
            deadline = s.loop._operation_deadline
            s.do("tick_at", times=[deadline, math.nextafter(deadline, math.inf)])
            s.until_hold()
            self.keep(s)

            # a planned state put past the bounds behind the loop's back: the sample that follows is not sent
            s = begin("a_sample_past_the_bounds_is_not_sent")
            rows = np.tile(s.held(), (tests.SEQUENCE_ROWS, 1))
            rows[:, 0] += np.linspace(0, tests.SEQUENCE_SPAN_RAD, tests.SEQUENCE_ROWS)
            s.call("start_sequence", positions=rows, rate_hz=control_config.rate_hz / 2)
            s.tick(3)
            beyond = s.held()
            beyond[0] = limits.upper_bounds[0] + 0.05
            s.do("set_input", name="current_position", values=beyond)
            s.tick(2)
            self.keep(s)

        # a release recovery's own timeout is a second at least: the two arms with the short settle timeout
        s = self.begin("a_release_recovery_takes_a_second_at_least", source, "two_arm", "two_arm_enable")
        s.fault_by_stale_feedback()
        s.wait("recover")
        self.keep(s)

        # the SO-101's own loop: an arm that is moved while its recovery verifies the measured hold
        s = self.begin("so101_a_recovery_whose_arm_is_moved_while_it_verifies", source, "so101", "so101_quick_home")
        s.set("failure", {"type": "ServoFault", "message": "Servo error: elbow_flex: overload"}, "arm")
        s.tick()
        s.set("failure", None, "arm")
        moved = {"op": "shift", "arm": ARM, "index": 1, "delta": 0.4}
        s.wait("recover", hooks=[{"at": "before", "when": {"phase": "Verifying new hold"}, "do": [moved]}])
        self.keep(s)

        # a jaw that stopped on an object and is opened again: the opening it was judged at goes with the operation
        s = self.begin("so101_a_blocked_jaw_is_opened_again", source, "so101", "so101_quick_home")
        s.set("blocked_gripper_opening", 0.4, "arm")
        s.call("begin_grippers", request=False)
        s.finish()
        s.call("report")
        s.tick(2)
        s.set("blocked_gripper_opening", None, "arm")
        s.call("begin_grippers", request=True)
        s.tick(3)
        s.finish()
        s.call("report")
        self.keep(s)

    # -- what an audit of pear.js found no scenario to hold (kept last, so that every scenario before keeps its place)

    def since_the_audit(self) -> None:
        """Scenarios for three things no scenario decided: which instant of a control period is its ``now``, how far
        a reading's stamp may run ahead of the clock, and how long a shutdown waits for its stop."""
        tests = pear_tests
        source = "beyond PEAR's tests"
        slack = ArmState.CLOCK_SLACK_S
        for robot, station in ROBOTS:
            control_config, robot_config = self.stations.configs(station)
            layout = robot_config.LAYOUT
            width, period_s = layout.coordinate_count, control_config.control_period_s

            def begin(name: str, variant: str = "", **rig: Any) -> Scenario:
                return self.begin(f"{name}[{robot}{'-' + variant if variant else ''}]", source, "memory", station, **rig)

            # the clock moves while a control period reads its arms: the period's time is the clock before the
            # reading. A motion's settling starts then, a sequence's first row is handed over then, an operation's
            # time is up by then; the reading is stamped after it.
            s = begin("a_period_takes_its_time_before_its_reading", "move")
            s.tamper("read", "advance_clock", seconds=period_s / 8)
            s.jog(None, 1, tests.STEP_RAD)
            s.until_hold()
            s.tick(3)
            self.keep(s)

            s = begin("a_period_takes_its_time_before_its_reading", "sequence")
            s.tamper("read", "advance_clock", seconds=period_s / 16)
            rows = np.tile(s.held(), (5, 1))
            rows[:, 0] += np.linspace(0, 0.05, 5)
            s.call("start_sequence", positions=rows, rate_hz=control_config.rate_hz / 2)
            s.until_hold()
            self.keep(s)

            # a move whose period begins on its deadline is not late, though its reading ends past the deadline
            s = begin("a_period_takes_its_time_before_its_reading", "deadline")
            s.jog(None, 1, 10 * tests.STEP_RAD)
            s.tick(5)
            deadline = s.loop._operation_deadline
            s.tamper("read", "advance_clock", seconds=period_s / 8)
            s.do("tick_at", times=[deadline, math.nextafter(deadline, math.inf)])
            s.do("untamper", method="read")
            s.until_hold()
            self.keep(s)

            # a reading stamped ahead of the clock: by less than the slack the loop's check takes it (a snapshot,
            # which allows none, shows the HOLD unsettled for it), by more it is refused as stale
            s = begin("a_reading_stamped_ahead_of_the_clock", "checked")
            for ahead in (slack / 2, 0.9 * slack, 1.1 * slack, 2 * slack, 0.0):
                states = {
                    arm: {"position": list(s.loop.targets[arm]), "velocity": [0.0] * width, "age_s": -ahead}
                    for arm in layout.arms
                }
                s.call("check_states", states=states)
            self.keep(s)

            s = begin("a_reading_stamped_ahead_of_the_clock", "within_the_slack")
            s.tamper("read", "stamp", offset=slack / 2, times=3)
            s.tick(5)
            s.jog(None, 1, tests.STEP_RAD)
            s.tamper("read", "stamp", offset=0.9 * slack, times=4)
            s.until_hold()
            self.keep(s)

            s = begin("a_reading_stamped_ahead_of_the_clock", "past_the_slack")
            s.tick(2)
            s.tamper("read", "stamp", offset=1.1 * slack, times=1)
            s.tick(3)
            self.keep(s)

        # a shutdown gives up waiting for its stop after its own time, and releases the hardware all the same. No
        # stop of these stations stays unsettled for that long without a fault, so a slow move brakes with its own
        # caps (for more than two seconds) and the clock is put on during the wait's first sleep, to five control
        # periods short of the wait's time: the wait then sleeps on to its time and no further, before the stop's own
        # deadline
        control_config, _ = self.stations.configs("so101_station")
        s = self.begin("a_shutdown_gives_up_after_its_own_wait", source, "memory", "so101_station", braking="move_caps")
        s.jog(None, 1, 10 * tests.STEP_RAD, speed_scale=tests.SLOW_SCALE)
        s.tick(50)
        short = JointControlLoop.SHUTDOWN_WAIT_S - 5 * control_config.control_period_s
        gave_up = s.wait("shutdown", hooks=[{"at": "before", "when": {"sleep": 1}, "do": [{"op": "clock", "add": short}]}])
        if gave_up.get("error", {}).get("type") != "TimeoutError" or len(s.ops[-1]["sleeps"]) < 3:
            raise AssertionError(f"The shutdown did not give up at its own wait: {gave_up}")
        self.keep(s)

        # a shutdown from a HOLD that every reading shows drifting: the HOLD faults while the shutdown waits for it,
        # the shutdown raises the fault and releases the hardware
        s = self.begin("a_shutdown_whose_hold_faults_while_it_waits", source, "memory", "so101_station")
        s.set("velocity", tests.DRIFT_RAD_S)
        s.tick(40)
        if s.loop.snapshot()["arrival"]["settled"]:
            raise AssertionError("The HOLD is settled although every reading shows a drift")
        s.wait("shutdown")
        self.keep(s)

        # the SO-101's own loop: the jaw's trajectory ends at the time of its period, before the reading
        s = self.begin("so101_a_period_takes_its_time_before_its_reading", source, "so101", "so101_quick_home")
        s.set("blocked_gripper_opening", 0.4, "arm")
        s.tamper("read", "advance_clock", seconds=self.stations.configs("so101_quick_home")[0].control_period_s / 8)
        s.call("begin_grippers", request=False)
        s.finish()
        s.call("report")
        self.keep(s)

    # -- generated: any sequence of what a station does

    def generated(self) -> None:
        rng = random.Random(f"{SEED}-scenarios")
        for index in range(36 * self.scale):
            self.keep(self.random_scenario(index, rng))

    def random_scenario(self, index: int, rng: random.Random) -> Scenario:
        kind = rng.choice(["so101", "so101", "so101", "memory", "two_arm"])
        station = rng.choice({
            "so101": ["so101_quick_home", "so101_quick_home", "so101_quick", "so101_station"],
            "memory": ["so101_station", "two_arm"],
            "two_arm": ["two_arm", "two_arm_station"],
        }[kind])
        rig: dict[str, Any] = {}
        if kind == "memory":
            rig = {
                "recovery": rng.choice(["MeasuredHoldRecovery", "ReleaseRecovery"]),
                "braking": rng.choice(["station_limits", "move_caps"]),
                "checks_velocity_rms": rng.random() < 0.5,
            }
        s = self.begin(f"generated-{index}", "generated", kind, station, **rig)
        _, robot_config = self.stations.configs(station)
        limits, layout = robot_config.joint_limits(), robot_config.LAYOUT
        width = layout.coordinate_count
        flags = "arm" if kind == "so101" else "driver"

        def move() -> None:
            arm = rng.choice(layout.arms)
            joint = rng.randrange(width)
            vector_index = layout.arms.index(arm) * width + joint
            held = s.loop.targets[arm][joint]
            room_down, room_up = held - limits.lower_bounds[vector_index], limits.upper_bounds[vector_index] - held
            step = rng.uniform(-min(room_down, 0.4), min(room_up, 0.4)) * 0.9
            options = {"speed_scale": rng.choice([0.5, 0.25, 1.0])} if rng.random() < 0.3 else {}
            s.jog(arm, joint + 1, step, **options)

        def sequence() -> None:
            count = rng.randint(2, 8)
            rows = np.tile(s.held(), (count, 1))
            column = rng.randrange(layout.vector_length)
            room = min(s.held()[column] - limits.lower_bounds[column], limits.upper_bounds[column] - s.held()[column])
            rows[:, column] += np.linspace(0, rng.uniform(-1, 1) * min(room, 0.05), count)
            s.call("start_sequence", positions=rows, rate_hz=rng.choice([25.0, 50.0, 12.5, 10.0]))

        def gripper() -> None:
            if rng.random() < 0.3:
                s.set("blocked_gripper_opening", rng.choice([None, round(rng.uniform(0.1, 0.8), 2)]), "arm")
            if rng.random() < 0.15:
                s.set("response", rng.choice([None, {"kind": "min_gripper", "limit": round(rng.uniform(0.3, 0.9), 2)}]), "arm")
            s.call("begin_grippers", request=rng.random() < 0.5)

        def fault() -> None:
            choices = ["stale", "read_raises", "send_raises", "not_finite", "pushed"]
            if kind == "so101":
                choices += ["glitch", "long_glitch", "servo"]
            if len(layout.arms) > 1:
                choices.append("missing_arm")
            choice = rng.choice(choices)
            if choice == "stale":
                s.fault_by_stale_feedback()
            elif choice == "read_raises":
                s.tamper("read", "raise", times=1, type="RuntimeError", message="no status packet")
                s.tick()
            elif choice == "send_raises":
                s.tamper("send", "raise", times=rng.choice([1, 1, 2]), type="OSError", message="write timed out")
                s.tick(2)
            elif choice == "not_finite":
                s.tamper("read", "position", arm=rng.choice(layout.arms), index=rng.randrange(width), value=math.nan, times=1)
                s.tick()
            elif choice == "pushed":
                if kind == "memory":
                    s.set("is_following", rng.random() < 0.5)
                s.do("shift", arm=rng.choice(layout.arms), index=rng.randrange(width - 1), delta=rng.choice([-0.5, 0.5, 0.3, 0.05]))
                s.tick(2)
            elif choice == "glitch":
                s.set("failure", {"type": "RuntimeError", "message": "Incorrect status packet"}, "arm")
                s.tick(rng.randint(1, 3))
                s.set("failure", None, "arm")
            elif choice == "long_glitch":
                s.set("failure", {"type": "RuntimeError", "message": "bus unplugged"}, "arm")
                s.tick(rng.randint(5, 9))
                s.set("failure", None, "arm")
            elif choice == "servo":
                s.set("failure", {"type": "ServoFault", "message": "Servo error: wrist_roll: voltage"}, "arm")
                s.tick()
                if rng.random() < 0.6:
                    s.set("failure", None, "arm")
            else:
                s.tamper("read", "drop", arm=layout.arms[-1], times=1)
                s.tick()

        def recover() -> None:
            options = {"timeout_s": rng.choice([0.4, 2.0])} if rng.random() < 0.4 else {}
            if rng.random() < 0.2:
                s.do("event", name=f"pause-{len(s.ops)}")
                options["cancellation"] = f"pause-{len(s.ops) - 1}"
                pause = {"at": "after", "when": {"sleep": rng.randint(1, 12)}, "do": [{"op": "cancel", "name": options["cancellation"]}]}
                s.wait("recover", hooks=[pause], **options)
            else:
                s.wait("recover", **options)

        for _ in range(rng.randint(4, 9)):
            if s.loop is None:
                break
            status = s.loop.status.value
            if status == "CLOSED":
                break
            roll = rng.random()
            if status == "HOLD":
                if roll < 0.35:
                    move()
                elif roll < 0.5 and kind == "so101":
                    gripper()
                elif roll < 0.6:
                    sequence()
                elif roll < 0.7:
                    s.tick(rng.randint(1, 12))
                elif roll < 0.78:
                    s.call("stop")
                elif roll < 0.9:
                    fault()
                else:
                    s.wait("wait_for_hold", timeout_s=rng.choice([0.0, 0.2, 1.0]))
            elif status in ("RUNNING", "STOPPING"):
                if roll < 0.3:
                    s.tick(rng.randint(1, 15))
                elif roll < 0.45:
                    s.call("stop", **({"reason": "paused"} if rng.random() < 0.3 else {}))
                elif roll < 0.55:
                    fault()
                elif roll < 0.62:
                    s.do("clock", add=rng.choice([0.05, 0.3, 60.0]))
                    s.tick()
                elif roll < 0.75:
                    s.wait("wait_for_hold", timeout_s=rng.choice([0.04, 0.5, 30.0]))
                elif roll < 0.8:
                    move()
                else:
                    s.until_hold()
            else:  # FAULT
                if roll < 0.6:
                    recover()
                elif roll < 0.75:
                    s.tick(rng.randint(1, 5))
                elif roll < 0.85:
                    s.set("is_stale", False, flags)
                    s.do("untamper", method=None)
                    if kind == "so101":
                        s.set("failure", None, "arm")
                    recover()
                elif roll < 0.92:
                    move()
                else:
                    s.call("stop")

        if s.loop is not None and s.loop.status.value != "CLOSED":
            ending = rng.random()
            if ending < 0.25:
                s.wait("shutdown")
            elif ending < 0.4:
                s.call("close")
            elif s.loop.status.value in ("RUNNING", "STOPPING"):
                s.until_hold()

        return s


# ---------------------------------------------------------------------------------------------------------------------
# the loop that PEAR's control thread runs


def run_cases(stations: Stations, monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Returns what PEAR's own ``_run`` does on the stand-in clock, here in this thread: the wait after each step
    and the clock at each step, for steps that take a part of a period, a whole one, or stall for many.

    As in test_the_control_thread_never_bursts_after_a_stall, the loop's exit event is the PacedExit of PEAR's
    tests: each wait advances the clock by its timeout, and the event is set after a number of waits."""
    cases = []
    periods = pear_tests.LOOP_PERIODS
    plans = {
        "on_time": [0.0] * periods,
        "a_stall": [0.0] * pear_tests.STALL_AFTER + [pear_tests.STALL_PERIODS] + [0.0] * periods,  # of PEAR's test
        "steps_that_take_time": [0.15, 0.4, 0.05, 0.9, 0.999, 0.3] * 8,
        "a_late_period": [0.2, 0.2, 1.0, 0.2, 1.3, 0.2, 0.2, 2.5, 0.1, 0.1, 1.0000001, 0.1] * 4,
        "always_late": [1.1] * periods,
    }
    for robot, station in ROBOTS:
        control_config, _ = stations.configs(station)
        period_s = control_config.control_period_s
        for name, plan in plans.items():
            clock = StandInClock().install(monkeypatch)
            exit_event = pear_tests.PacedExit(clock, periods)
            # the control loop's exit event, made with the loop
            with monkeypatch.context() as patch:
                patch.setattr(threading, "Event", lambda: exit_event)
                runtime, _, _ = pear_tests.JointRuntimeRig.rig(robot, clock)
            step, steps = runtime.step, []
            durations = [share * period_s for share in plan[:periods]]

            def timed_step() -> None:
                steps.append(clock.now)
                step()
                clock.now += durations[len(steps) - 1]  # how long the step took

            runtime.step = timed_step
            started = clock.now
            runtime._run()
            cases.append({
                "name": f"{name}[{robot}]",
                "station": station,
                "periods": periods,
                "started": started,
                "durations": durations,
                "waits": exit_event.waits,
                "steps": steps,
                "ended": clock.now,
                "status": runtime.status.value,
            })
            runtime.close()

    return cases


def close_record(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Returns what PEAR's own ``close`` does with a control thread that does not end: how long it joins the thread,
    what it raises, and what it leaves of the loop (the hardware is not closed under a thread that may still command
    it). The thread is a stand-in that never ends: PEAR's ``close`` is what joins it."""

    class StuckThread:
        def __init__(self) -> None:
            self.join_timeouts: list[Any] = []

        def join(self, timeout: float | None = None) -> None:
            self.join_timeouts.append(timeout)

        def is_alive(self) -> bool:
            return True

    clock = StandInClock().install(monkeypatch)
    runtime, _, _ = pear_tests.JointRuntimeRig.rig("so101", clock)
    thread = StuckThread()
    runtime._thread = thread
    record = {
        "out": outcome(runtime.close),
        "join_timeouts_s": plain(thread.join_timeouts),
        "exit_is_set": runtime._exit_event.is_set(),
        "status": runtime.status.value,
    }
    runtime._thread = None
    runtime.close()

    return record


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--scale", type=int, default=1, help="times as many generated cases (1: the committed set)")
    parser.add_argument("--output", type=Path, help="write there instead of tests/fixtures/station-loop")
    arguments = parser.parse_args()
    if arguments.scale < 1:
        sys.exit("--scale is a whole number of at least 1")
    if arguments.output is not None:
        Fixtures.directory = arguments.output.resolve()
    elif arguments.scale != 1:
        sys.exit("The committed fixtures are the set of --scale 1: name another --output for a larger one")
    scale = arguments.scale

    commit, pinned = Commit.of_pear(), Commit.pinned()
    if commit != pinned:
        sys.exit(
            f"This PEAR is at {commit or 'no commit that can be read (it is not a checkout)'}; "
            f"src/index.ts pins {pinned}",
        )

    LOGS.install()  # PEAR logs every request and every fault of a scenario: kept in the records, not printed
    stations = Stations()
    monkeypatch = pytest.MonkeyPatch()
    try:
        trajectory = TrajectoryCases(stations, scale).all()
        scenarios = Catalogue(stations, monkeypatch, scale).all()
        runs = run_cases(stations, monkeypatch)
        closing = close_record(monkeypatch)
    finally:
        monkeypatch.undo()

    Fixtures.write("trajectory.json", trajectory, is_compressed=True)
    Fixtures.write("loops.json", {"scenarios": scenarios}, is_compressed=True)
    Fixtures.write("run.json", {"cases": runs, "close": closing})

    kinds: dict[str, int] = {}
    for scenario in scenarios:
        kinds[scenario["rig"]["kind"]] = kinds.get(scenario["rig"]["kind"], 0) + 1
    counts = {
        "scenarios": len(scenarios),
        "scenarios_by_rig": kinds,
        "scenarios_of_pears_tests": sum(scenario["source"].startswith("test_") for scenario in scenarios),
        "generated_scenarios": sum(scenario["source"] == "generated" for scenario in scenarios),
        "control_periods": sum(scenario.get("end", {}).get("ticks", 0) for scenario in scenarios),
        "operations": sum(len(scenario["ops"]) for scenario in scenarios),
        "run_cases": len(runs),
        **{name: len(cases) for name, cases in trajectory.items()},
    }
    meta = {
        "scale": scale,
        "pear_commit": commit,
        "versions": {
            "python": platform.python_version(),
            "numpy": np.__version__,
            "ruckig": importlib.metadata.version("ruckig"),
        },
        "constants": {
            "start_s": StandInClock.START_S,
            "most_ticks": MOST_TICKS,
            **{
                name: getattr(JointControlLoop, name)
                for name in (
                    "RECOVERY_WINDOW_FLOOR_S", "START_EPSILON", "STATIONARY_EPSILON", "MOVE_MARGIN_S",
                    "SEQUENCE_MARGIN_S", "GRIPPER_TIMEOUT_S", "HOLD_WAIT_S", "SHUTDOWN_WAIT_S", "THREAD_JOIN_S",
                )
            },
            "THREAD_NAME": JointControlLoop.THREAD_NAME,
            "CLOCK_SLACK_S": ArmState.CLOCK_SLACK_S,
            "MAX_DURATION_S": JointMove.MAX_DURATION_S,
            "MAX_ROWS": SequenceOperation.MAX_ROWS,
            "PHASE_EPSILON": SequenceOperation.PHASE_EPSILON,
            "OPEN_ENDPOINT": GripperProfile.OPEN_ENDPOINT,
            "CLOSED_ENDPOINT": GripperProfile.CLOSED_ENDPOINT,
            "TIMEOUT_SETTLE_COUNT": MeasuredHoldRecovery.TIMEOUT_SETTLE_COUNT,
            "MIN_TIMEOUT_S": ReleaseRecovery.MIN_TIMEOUT_S,
            "RELEASE_CAPS": list(ReleaseRecovery.RELEASE_CAPS),
            "RELEASE_MARGIN_S": ReleaseRecovery.RELEASE_MARGIN_S,
            "RELEASE_START_EPSILON": ReleaseRecovery.START_EPSILON,
            "braking": {member.name: member.value for member in Braking},
        },
        "counts": counts,
        "stations": stations.record(),
    }
    Fixtures.write("meta.json", meta)
    print(f"total: {Fixtures.total_bytes} bytes at --scale {scale}")
    print(json.dumps(counts))


if __name__ == "__main__":
    main()
