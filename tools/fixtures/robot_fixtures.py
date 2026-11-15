"""Writes the fixtures of pear.js's motion layer and robot: what PEAR's own planning, results, action models, cameras
and its SO-101 robot give, on the stand-in clock and the stand-in arm of PEAR's own tests. src/station/motion,
src/station/robot.ts, src/station/cameras.ts, src/so101/motion, src/so101/robot.ts, src/so101/formats.ts and
src/so101/hardware/cameras.ts port them, and tests/station-robot runs the same cases and scripts on the port.

Run it with the Python of a PEAR station environment, from any directory; PEAR must be a checkout at the commit that
src/index.ts pins, because its test rig (tests/deploy/station) is imported from it:

    <work dir>/envs/station/bin/python tools/fixtures/robot_fixtures.py

It writes tests/fixtures/station-robot/ and nothing else:

    meta.json          the stations, the constants and the counts
    parts.json.gz      the parts that need no control loop: SO101Planning and HomePlanning, MotionResult and the
                       format's report of a result, the action models' refusals, the wrist camera's checks
    sessions.json.gz   PEAR's SO-101 robot on its stepped rig (SteppedStandInSO101Robot on the StandInClock: the
                       loop's thread never starts, each sleep of the clock steps the loop once), one call of the
                       robot a step, with what the driver was asked at every control period
    agent_rig.json.gz  the tasks of tools/fixtures/agent_fixtures.py (PEAR's StationAgentLoop on the same rig) run
                       again with what tests/fixtures/agent/loop.json does not hold: the robot's UUIDs, its
                       kinematics' answers and the driver's calls at every control period

It needs no device and no GPU. Everything is deterministic: fixed seeds, seeded UUIDs, and PEAR reads the stand-in
clock of its own tests. Every expected value is what PEAR's class returned or raised; the script holds no rule of its
own about what is right. A session is a script of calls that the script makes of PEAR as it writes it, so that the
next call can be made from what PEAR holds then; the port replays the written script.

For a longer comparison that is not committed, write a larger set elsewhere and point the tests at it:

    <work dir>/envs/station/bin/python tools/fixtures/robot_fixtures.py --scale 6 --output <directory>
    PEAR_JS_ROBOT_FIXTURES=<directory> npx vitest run tests/station-robot

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
import uuid
from collections.abc import Callable, Sequence
from enum import Enum
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pydantic
import pytest
from omegaconf import DictConfig, OmegaConf

import pear
from pear.deploy.station.control import robot as robot_module
from pear.deploy.station.control.cameras import CameraFeed, CameraSource
from pear.deploy.station.control.joint.action_guard import ActionGuard
from pear.deploy.station.control.joint.config import ControlConfig, MotionLimits
from pear.deploy.station.control.joint.operations import GripperEndpointTimeout, SequenceOperation
from pear.deploy.station.control.joint.stability import StabilityError
from pear.deploy.station.control.joint.trajectory import GripperProfile, JointMove
from pear.deploy.station.control.motion.homing import HomeFailed, HomeStage, Homing
from pear.deploy.station.control.motion.kinematics import UnreachablePoseError
from pear.deploy.station.control.motion.planning import HomePlanning, HomePlanningError, PreparedAction
from pear.deploy.station.control.motion.results import MotionResult, MotionStatus
from pear.deploy.station.control.robot import ActionMode, BaseRobot
from pear.deploy.station.control.robots.so101.config import SO101Config
from pear.deploy.station.control.robots.so101.formats import SINGLE_ARM_POSE_FORMAT
from pear.deploy.station.control.robots.so101.hardware.arm_state import ServoFault
from pear.deploy.station.control.robots.so101.hardware.cameras import WristCamera
from pear.deploy.station.control.robots.so101.layout import ARM, GRIPPER_INDEX, JOINTS, LAYOUT
from pear.deploy.station.control.robots.so101.motion import actions as so101_actions
from pear.deploy.station.control.robots.so101.motion.kinematics import SO101Kinematics
from pear.deploy.station.control.robots.so101.motion.planning import SO101Planning
from pear.deploy.station.control.robots.so101.motion.results import SO101MotionResult
from pear.deploy.station.control.robots.so101.robot import SO101Robot
from pear.deploy.station.control.schemas import ActionPhase, ControlState, MotionEndReason, RobotStatus
from pear.deploy.station.exceptions import OperatorPaused

REPOSITORY = Path(__file__).resolve().parents[2]
FIXTURES = REPOSITORY / "tests" / "fixtures" / "station-robot"
AGENT_FIXTURES = REPOSITORY / "tests" / "fixtures" / "agent"
PEAR_PACKAGE = Path(pear.__file__).resolve().parent
PEAR_STATION_TESTS = PEAR_PACKAGE.parent / "tests" / "deploy" / "station"  # PEAR's own tests of the station
SEED = 20261115

if not (PEAR_STATION_TESTS / "stand_in_robots.py").is_file():
    sys.exit("This PEAR has no tests/deploy/station: run from a checkout of PEAR, not an installed package")
for tests_directory in (PEAR_STATION_TESTS.parents[1], PEAR_STATION_TESTS):  # the helpers a test imports by name
    sys.path.insert(0, str(tests_directory))

# PEAR's own rig of its tests of the robot: the stand-in clock, the stand-in arm under the SO-101's own driver, the
# drawn cameras, and the robot whose control loop starts no thread
from config_files import ConfigFiles  # noqa: E402
from control_rig import StandInClock  # noqa: E402
from stand_in_cameras import StandInCameras  # noqa: E402
from stand_in_joint_driver import StandInSO101Driver  # noqa: E402
from stand_in_robots import SteppedStandInSO101Robot  # noqa: E402

FORMAT = SINGLE_ARM_POSE_FORMAT
FORMAT_NAME = FORMAT.name
ZERO = {"x": 0.0, "y": 0.0, "z": 0.0, "pitch": 0.0, "roll": 0.0}
# what PEAR's tests of the SO-101 change of its station of the tests (test_so101_robot_in_station.py,
# test_so101_motion_in_station.py, test_so101_formats_in_station.py, test_robot_in_station.py)
ZERO_HOME_OVERRIDE = "robot.home.position=[0.0, 0.0, 0.0, 0.0, 0.0, 1.0]"
TOLERANCE_OVERRIDES = (
    "robot.home.joint_tolerance=[0.035, 0.035, 0.035, 0.035, 0.035]",
    "robot.position_tolerance=0.035",
    "robot.feedback_position_tolerance=0.05",
)
ARM_TEST_OVERRIDES = (*TOLERANCE_OVERRIDES, "robot.feedforward=null")
WORK = (0.2, -0.35, 0.55, 0.4, 0.3, 1.0)  # elbow bent, wrist pitched down: the working pose of PEAR's tests
CONSOLE_PAUSE = "The operator interrupted this turn; remaining motion was cancelled."  # PEAR's console's words


# ---- values as JSON holds them ----


def plain(value: Any) -> Any:
    """Returns ``value`` as JSON holds it: arrays and tuples as lists, numpy's numbers as Python's, an enumeration's
    member as its word, a path as its name, a model as its fields, and a number that is not finite as
    ``{"$": "nan"}`` (JSON has none)."""
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    if isinstance(value, (float, np.floating)):
        number_ = float(value)
        if math.isfinite(number_):
            return number_
        return {"$": "nan" if math.isnan(number_) else "inf" if number_ > 0 else "-inf"}
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
    if isinstance(value, pydantic.BaseModel):
        return plain(value.model_dump(mode="json"))
    if isinstance(value, JointMove):
        return Moves.record(value)
    if dataclasses.is_dataclass(value):
        return plain(dataclasses.asdict(value))
    raise TypeError(f"No JSON form for {type(value).__name__}")


def decoded(value: Any) -> Any:
    """Returns the value a script holds: itself, with every ``{"$": "nan"}`` as the number it stands for and every
    ``{"$rows": [count, row]}`` as ``count`` copies of ``row``."""
    if isinstance(value, dict):
        if list(value) == ["$"]:
            return {"nan": math.nan, "inf": math.inf, "-inf": -math.inf}[value["$"]]
        if list(value) == ["$rows"]:
            count, row = value["$rows"]
            return [decoded(row) for _ in range(count)]
        return {key: decoded(child) for key, child in value.items()}
    if isinstance(value, list):
        return [decoded(child) for child in value]
    return value


def error_record(error: BaseException) -> dict[str, Any]:
    """Returns what a fixture keeps of an exception PEAR raised: its class, its message, whether PEAR's callers
    reject for it (a ValueError) or fail, what it recorded and what caused it."""
    record: dict[str, Any] = {
        "type": type(error).__name__,
        "message": str(error),
        "is_value_error": isinstance(error, ValueError),
    }
    details = getattr(error, "details", None)
    if details is not None:
        record["details"] = plain(details)
    if error.__cause__ is not None:
        record["cause"] = {"type": type(error.__cause__).__name__, "message": str(error.__cause__)}

    return record


def outcome(call: Callable[[], Any], shown: Callable[[Any], Any] = plain) -> dict[str, Any]:
    """Returns what ``call`` returned, under ``ok``, or what it raised, under ``error``."""
    try:
        return {"ok": shown(call())}
    except (SystemExit, GeneratorExit, AssertionError):
        raise
    except BaseException as error:  # the class is the fixture: the station reports it as the error's code
        return {"error": error_record(error)}


ERRORS: dict[str, type[BaseException]] = {
    error_class.__name__: error_class
    for error_class in (
        Exception,
        RuntimeError,
        ValueError,
        TimeoutError,
        OSError,
        KeyError,
        OperatorPaused,
        UnreachablePoseError,
        ServoFault,
        GripperEndpointTimeout,
        HomePlanningError,
    )
}


def make_error(spec: dict[str, Any]) -> BaseException:
    """Returns the exception a script names by its class and its message; a StabilityError and a HomeFailed with
    what they record."""
    if spec["type"] == "StabilityError":
        return StabilityError(spec["message"], copy.deepcopy(spec["metrics"]))
    if spec["type"] == "HomeFailed":
        return HomeFailed(spec["message"], copy.deepcopy(spec["details"]))
    return ERRORS[spec["type"]](spec["message"])


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
    LIST_ENDINGS = ("cases", "sessions", "scenarios")

    @classmethod
    def write(cls, name: str, content: dict[str, Any], *, is_compressed: bool = False) -> None:
        """Writes one file: an object whose lists of cases (a key that ends in ``cases``, ``sessions`` or
        ``scenarios``) hold one item a line; with ``is_compressed``, as gzip of that text (``name`` + .gz)."""
        cls.directory.mkdir(parents=True, exist_ok=True)
        entries = []
        counts = []
        for key, value in content.items():
            if isinstance(value, list) and key.endswith(cls.LIST_ENDINGS):
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
        places = [str(PEAR_PACKAGE.parent), str(Path.home()), str(REPOSITORY), tempfile.gettempdir() + "/", sys.prefix]
        for place in places:
            if place and place != "/" and place in text:
                sys.exit(f"{name} would hold a path of this machine: {place}")


class Moves:
    """A checked joint move as a fixture holds it, and the move a script names."""

    @staticmethod
    def record(move: JointMove | None) -> dict[str, Any] | None:
        if move is None:
            return None
        return {
            "start": plain(move.start),
            "goal": plain(move.goal),
            "caps": plain(move.motion_caps),
            "duration": move.duration_s,
        }

    @staticmethod
    def caps(spec: dict[str, Any] | None) -> Any:
        """Returns the caps of one arm a script gives (PEAR reads no more of a MotionLimits than its three lists)."""
        return None if spec is None else MotionLimits(**{name: list(values) for name, values in spec.items()})

    @classmethod
    def build(cls, robot_config: SO101Config, spec: dict[str, Any] | None) -> JointMove | None:
        """Returns the move ``spec`` names, built as PEAR builds a move: from its start to its goal at a speed scale
        within one arm's caps."""
        if spec is None:
            return None
        return JointMove.build(
            np.array(spec["start"], dtype=float),
            np.array(spec["goal"], dtype=float),
            robot_config.joint_limits(),
            LAYOUT,
            speed_scale=spec.get("speed_scale", 1.0),
            caps=cls.caps(spec.get("caps")),
        )


class Stations:
    """The configurations PEAR's robot runs on here: the SO-101's station of PEAR's own tests (the shipped settings
    with stand-in devices), and that station with the settings PEAR's tests of the arm give it."""

    def __init__(self) -> None:
        self.configs_: dict[str, DictConfig] = {}
        self.made: dict[str, tuple[ControlConfig, SO101Config]] = {}
        quick = ConfigFiles.SO101_QUICK_OVERRIDES
        # the station of PEAR's tests as it is: the shipped settings
        self.add("so101_station")
        # with the short settle windows and the fast caps of the tests of its arm (conftest.py: so101_config)
        self.add("so101_quick_home", *quick)
        # and with Home at zero, the tolerances of the tests of the arm and no feedforward
        # (test_so101_robot_in_station.py and test_so101_motion_in_station.py: so101_config)
        self.add("so101_quick", *quick, ZERO_HOME_OVERRIDE, *ARM_TEST_OVERRIDES)
        # the real arm's Home with those tolerances (robot_at_home of the same files)
        self.add("so101_arm_home", *quick, *ARM_TEST_OVERRIDES)
        # the contract tests' station (test_robot_in_station.py: CONTRACT_OVERRIDES)
        self.add("so101_contract", *quick, ZERO_HOME_OVERRIDE, *TOLERANCE_OVERRIDES)
        # Home just inside the base joint's upper bound (test_path_beyond_a_limit_is_rejected_before_opening)
        quick_config = self.configs_["so101_quick"]
        home = list(quick_config.robot.home.position)
        home[0] = quick_config.robot.limits.upper_bounds[0] - 0.01
        self.put("so101_home_at_limit", OmegaConf.merge(quick_config, {"robot": {"home": {"position": home}}}))
        # a short wait for the arm to arrive at Home (test_inaccurate_home_fails)
        self.put("so101_short_arrival", OmegaConf.merge(quick_config, {"robot": {"home": {"arrival_timeout_s": 0.5}}}))
        # Home with caps of its own, and a robot without a Home
        caps = {"velocity": [0.5] * 6, "acceleration": [1.5] * 6, "jerk": [8.0] * 6}
        self.put("so101_home_caps", OmegaConf.merge(self.configs_["so101_station"], {"robot": {"home": {"limits": caps}}}))
        self.put("so101_no_home", OmegaConf.merge(quick_config, {"robot": {"home": None}}))
        # a station without the geometry that Cartesian motion needs, and one without a camera
        self.put("so101_no_geometry", OmegaConf.merge(quick_config, {"robot": {"geometry": None}}))
        self.put("so101_no_camera", OmegaConf.merge(quick_config, {"robot": {"camera": None}}))

    def add(self, key: str, *overrides: str) -> None:
        self.put(key, ConfigFiles.load("so101", *overrides))

    def put(self, key: str, config: DictConfig) -> None:
        self.configs_[key] = config
        self.made[key] = ConfigFiles.make_configs(config)

    def config(self, key: str) -> DictConfig:
        """Returns the station's configuration, which a robot is made from."""
        return self.configs_[key]

    def configs(self, key: str) -> tuple[ControlConfig, SO101Config]:
        """Returns copies of the two configurations of the station ``key``."""
        control_config, robot_config = self.made[key]
        return copy.deepcopy(control_config), copy.deepcopy(robot_config)

    def kinematics(self, key: str) -> SO101Kinematics:
        return SO101Kinematics.shared_instance(self.made[key][1])

    def record(self) -> dict[str, Any]:
        """Returns what the fixtures say of every station: the settings pear.js makes the same robot from (the
        SO-101's whole section without the path of its description, which pear.js has no setting for)."""
        stations = {}
        for key, (control_config, robot_config) in self.made.items():
            settings = plain(dataclasses.asdict(robot_config))
            if settings["geometry"] is not None:
                del settings["geometry"]["urdf"]
            stations[key] = {
                "control": dataclasses.asdict(control_config),
                "control_period_s": control_config.control_period_s,
                "settings": settings,
            }

        return stations


# ---- the rig: the stand-in clock, and what records PEAR while it runs ----


class IoLog:
    """Records every call PEAR makes of the SO-101's driver, in order: "r" (read), "R" (read_for_recovery), "h"
    (refresh_hold), "c" (close) or ["s", targets, velocities] (send: both as joint vectors, the velocities null when
    none were given); a call that raised as [code + "!", ..., class, message]. The Probe of
    tools/fixtures/loop_fixtures.py records the control loop's fixtures the same way."""

    CODES = {"read": "r", "read_for_recovery": "R", "send": "s", "refresh_hold": "h", "close": "c"}

    def __init__(self) -> None:
        self.calls: list[Any] = []

    def take(self) -> list[Any]:
        """Returns the calls since the last time, and forgets them."""
        calls, self.calls = self.calls, []
        return calls

    def attach(self, driver: Any) -> None:
        """Has every call of ``driver`` join the record, on the driver itself."""
        for name in self.CODES:
            setattr(driver, name, self.wrapped(name, getattr(driver, name)))

    def wrapped(self, name: str, method: Callable[..., Any]) -> Callable[..., Any]:
        def call(*arguments: Any) -> Any:
            entry: Any = self.CODES[name]
            if name == "send":
                velocities = arguments[1] if len(arguments) > 1 else None
                entry = ["s", self.vector(arguments[0]), None if velocities is None else self.vector(velocities)]
            try:
                result = method(*arguments)
            except BaseException as error:
                failed = entry if isinstance(entry, list) else [entry]
                self.calls.append([failed[0] + "!", *failed[1:], type(error).__name__, str(error)])
                raise
            self.calls.append(entry)
            return result

        return call

    @staticmethod
    def vector(arm_values: dict[str, Sequence[float]]) -> Any:
        if list(arm_values) == list(LAYOUT.arms):
            return plain(LAYOUT.join(arm_values))
        return plain(arm_values)  # (not the layout's arms in their order: as it is)


class RecordingClock(StandInClock):
    """PEAR's stand-in clock, which also keeps what every sleep did: how long it was, the driver's calls since the
    sleep before, the control loop's state after its step, and what a script did right after it (inside the sleep,
    as another thread would between two periods)."""

    def __init__(self, io: IoLog) -> None:
        super().__init__()
        self.io = io
        self.ticks: list[dict[str, Any]] = []
        self.after_tick: Callable[[int], list[Any] | None] | None = None

    def sleep(self, duration_s: float) -> None:
        self.now += duration_s
        control_loop = self.control_loop
        if control_loop is not None:
            control_loop.step()
        tick: dict[str, Any] = {"d": duration_s, "io": self.io.take()}
        if control_loop is not None:
            tick["s"] = control_loop.status.value
        self.ticks.append(tick)
        if self.after_tick is not None:
            hooked = self.after_tick(len(self.ticks))
            if hooked:
                tick["hooks"] = hooked

    def take(self) -> list[dict[str, Any]]:
        ticks, self.ticks = self.ticks, []
        return ticks


class Ids:
    """A seeded sequence of UUIDs, which keeps the ones drawn since the last time they were taken."""

    def __init__(self, seed: int) -> None:
        self.generator = random.Random(seed)
        self.drawn: list[str] = []

    def next(self) -> uuid.UUID:
        value = uuid.UUID(int=self.generator.getrandbits(128), version=4)
        self.drawn.append(str(value))
        return value

    def take(self) -> list[str]:
        drawn, self.drawn = self.drawn, []
        return drawn


class LogCapture(logging.Handler):
    """Keeps what PEAR's robot and results log: the level and the message."""

    LOGGERS = {
        "pear.deploy.station.control.robot": "robot",
        "pear.deploy.station.control.motion.results": "results",
    }

    def __init__(self) -> None:
        super().__init__(logging.INFO)
        self.records: list[list[str]] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append([self.LOGGERS[record.name], record.levelname.lower(), record.getMessage()])

    def take(self) -> list[list[str]]:
        records, self.records = self.records, []
        return records

    def install(self) -> None:
        for name in self.LOGGERS:
            logger = logging.getLogger(name)
            logger.handlers = [self]  # (in the place of the logger's own handler, which writes to stderr)
            logger.setLevel(logging.INFO)
            logger.propagate = False


class Rig:
    """What every stepped run of PEAR's robot here runs on: the stand-in clock in the place of time.monotonic and
    time.sleep, a seeded uuid4 for the robot's session and observations, and the records of the driver's calls, of
    the kinematics' answers and of the robot's log."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, seed: int) -> None:
        self.monkeypatch = monkeypatch
        self.io = IoLog()
        self.ids = Ids(seed)
        self.log = LogCapture()
        self.log.install()
        self.ik: list[dict[str, Any]] = []
        self.clock = RecordingClock(self.io)
        self.clock.install(monkeypatch)
        monkeypatch.setattr(robot_module, "uuid4", self.ids.next)

        io = self.io
        make_driver = StandInSO101Driver.__init__

        def recorded_driver(driver: Any, control_config: Any, robot_config: Any) -> None:
            make_driver(driver, control_config, robot_config)
            io.attach(driver)

        monkeypatch.setattr(StandInSO101Driver, "__init__", recorded_driver)

        calls = self.ik
        solve = SO101Kinematics.joint_target

        def recorded_target(kinematics: Any, joint_positions: Any, action: Any) -> Any:
            entry: dict[str, Any] = {
                "joints": plain(list(joint_positions)),
                "delta": [getattr(action.arm, name) for name in SO101Kinematics.ARM_QUANTITIES],
            }
            try:
                goal = solve(kinematics, joint_positions, action)
            except Exception as error:
                entry["out"] = {"error": error_record(error)}
                calls.append(entry)
                raise
            entry["out"] = {"ok": plain(goal)}
            calls.append(entry)
            return goal

        monkeypatch.setattr(SO101Kinematics, "joint_target", recorded_target)

    def new_clock(self) -> RecordingClock:
        """Returns a new clock at its first reading, in the place of the one before."""
        self.clock = RecordingClock(self.io)
        self.clock.install(self.monkeypatch)
        return self.clock

    def take_ik(self) -> list[dict[str, Any]]:
        calls = list(self.ik)
        self.ik.clear()
        return calls


# ---- part 1: what needs no control loop ----


class Snapshots:
    """The least of a control snapshot that PEAR's planning and results read."""

    @staticmethod
    def of(measured: Sequence[float], targets: Sequence[float]) -> dict[str, Any]:
        return {"arms": {ARM: {"position": tuple(measured)}}, "targets": {ARM: tuple(targets)}}

    @classmethod
    def observation(cls, measured: Sequence[float], targets: Sequence[float]) -> dict[str, Any]:
        return {"joint_positions": list(measured), "control_snapshot": cls.of(measured, targets)}


class PlanningCases:
    """SO101Planning and HomePlanning on generated and boundary inputs."""

    HOME = (0.0, -0.814, 0.077, 1.423, -1.613, 1.0)  # the shipped Home

    def __init__(self, stations: Stations, scale: int) -> None:
        self.stations, self.scale = stations, scale

    def generator(self, name: str) -> random.Random:
        return random.Random(f"{SEED}:{name}")

    @staticmethod
    def delta(width: float = 0.0, **arm: float) -> dict[str, Any]:
        return {"type": "single_arm_delta", "arm": {**ZERO, **arm}, "gripper": {"width": width}}

    def random_pose(self, rng: random.Random, station: str, share: float = 0.8) -> list[float]:
        """Returns a joint vector inside ``share`` of the station's bounds, the gripper anywhere in [0, 1]."""
        limits = self.stations.made[station][1].limits
        pose = [
            share * rng.uniform(lower, upper)
            for lower, upper in zip(limits.lower_bounds[:GRIPPER_INDEX], limits.upper_bounds[:GRIPPER_INDEX])
        ]
        return [*pose, rng.choice([0.0, 0.25, 0.4, 1.0, rng.random()])]

    def random_delta(self, rng: random.Random) -> dict[str, Any]:
        kind = rng.choice(["axis", "axis", "combined", "rotation", "small", "far", "zero"])
        arm = dict(ZERO)
        if kind == "axis":
            arm[rng.choice(["x", "y", "z"])] = round(rng.uniform(-8, 8), 1)
        elif kind == "combined":
            for name in ("x", "y", "z"):
                arm[name] = round(rng.uniform(-4, 4), 1)
            arm["pitch"] = round(rng.uniform(-0.4, 0.4), 2)
            arm["roll"] = round(rng.uniform(-0.6, 0.6), 2)
        elif kind == "rotation":
            arm[rng.choice(["pitch", "roll"])] = round(rng.uniform(-1.2, 1.2), 2)
        elif kind == "small":
            arm[rng.choice(["x", "y", "z"])] = rng.choice([0.1, -0.1, 0.5, -0.5])
        elif kind == "far":
            arm[rng.choice(["x", "y", "z"])] = rng.choice([40.0, -40.0, 25.0, -60.0, 200.0])
        return {"type": "single_arm_delta", "arm": arm, "gripper": {"width": rng.choice([0.0, 0.0, 1.0, -1.0, 0.3])}}

    # -- checked_action

    def action_case(
        self, kind: str, station: str, measured: Sequence[Any], targets: Sequence[Any], action: dict[str, Any]
    ) -> dict[str, Any]:
        """Returns what SO101Planning.checked_action gave for ``action`` from an observation of the ``measured``
        joints at the held ``targets``, with every answer of the kinematics on the way."""
        _, robot_config = self.stations.configs(station)
        kinematics = self.stations.kinematics(station)
        case = {"kind": kind, "station": station, "measured": plain(measured), "targets": plain(targets), "action": action}
        observation = Snapshots.observation(decoded(case["measured"]), decoded(case["targets"]))
        RIG.take_ik()

        def prepare() -> PreparedAction:
            model = SO101Robot.ACTION_ADAPTER.validate(decoded(action))
            return SO101Planning.checked_action(robot_config, kinematics, observation, model)

        case["out"] = outcome(
            prepare,
            shown=lambda prepared: {"gripper_request": prepared.gripper_request, "move": Moves.record(prepared.move)},
        )
        case["ik"] = RIG.take_ik()

        return case

    def action_cases(self) -> list[dict[str, Any]]:
        cases = []
        station = "so101_station"
        limits = self.stations.made[station][1].limits
        tolerance = self.stations.made[station][1].position_tolerance

        def add(kind: str, measured: Sequence[Any], targets: Sequence[Any], action: dict[str, Any], on: str = station) -> None:
            cases.append(self.action_case(kind, on, measured, targets, action))

        for name, pose in (("home", self.HOME), ("work", WORK)):
            for axis in ("x", "y", "z"):
                for change in (1.0, -1.0, 3.0, -3.0):
                    add(f"{name} {axis}", pose, pose, self.delta(**{axis: change}))
            for axis, change in (("pitch", 0.2), ("pitch", -0.2), ("roll", 0.5), ("roll", -0.5), ("roll", 3.0)):
                add(f"{name} {axis}", pose, pose, self.delta(**{axis: change}))
            add(f"{name} combined", pose, pose, self.delta(x=-2.0, z=2.0, pitch=-0.2, roll=0.4))
            add(f"{name} combined with the gripper", pose, pose, self.delta(-1.0, x=1.0, z=-0.5))
            # no change of the arm: the gripper alone, or nothing at all
            for width in (0.0, 1.0, -1.0, 0.25, -1e-9, -0.0):
                add(f"{name} held", pose, pose, self.delta(width))
            add(f"{name} held", pose, pose, self.delta(0.0, x=-0.0, roll=-0.0))
            for command in ("open", "close"):
                add(f"{name} gripper action", pose, pose, {"type": "gripper", "command": command})
            # out of reach, a rotation past the planning bound, and what is no action of the planning
            for far in (dict(x=40.0), dict(x=200.0), dict(z=-30.0), dict(y=35.0), dict(pitch=2.5), dict(x=12.0, z=9.0)):
                add(f"{name} out of reach", pose, pose, self.delta(**far))
            for turn in (dict(roll=4.0), dict(pitch=-3.3), dict(roll=math.pi), dict(roll=math.nextafter(math.pi, 4))):
                add(f"{name} rotation bound", pose, pose, self.delta(**turn))
            chunk = {"type": "joint_positions", "positions": [list(pose)], "rate_hz": 10.0}
            add(f"{name} no planned action", pose, pose, chunk)

        # the pose a delta is added to: the held command while the arm tracks it, the measured pose once it does not
        for error in (0.01, tolerance, math.nextafter(tolerance, 1), math.nextafter(tolerance, 0), 0.1, -0.1):
            measured = list(WORK)
            measured[2] += error
            add("sag", measured, WORK, self.delta(x=1.0))
            add("sag", measured, WORK, self.delta(pitch=0.1))
        measured = list(WORK)
        measured[GRIPPER_INDEX] = 0.4
        targets = list(WORK)
        targets[GRIPPER_INDEX] = 0.0
        add("jaw stopped on an object", measured, targets, self.delta(z=2.0))  # the gripper's difference is ignored
        add("jaw stopped on an object", measured, targets, self.delta(1.0))
        # the same with the arm off its command by more than the arrival tolerance: the delta is added to the
        # measured pose, whose gripper reading is not the move's gripper target
        measured[2] += 0.1
        add("jaw stopped on an object, the arm off its command", measured, targets, self.delta(z=2.0))
        add("jaw stopped on an object, the arm off its command", measured, targets, self.delta(-1.0, x=1.0))

        # a held command past a limit: within the feedback tolerance it may move inward, beyond it nothing moves
        for index, (bound, sign) in enumerate(
            [(limits.lower_bounds[1], -1), (limits.upper_bounds[2], 1), (limits.upper_bounds[0], 1)]
        ):
            joint = (1, 2, 0)[index]
            for past in (0.03, 0.059, 0.1):
                pose = list(WORK)
                pose[joint] = bound + sign * past
                for change in (dict(z=1.0), dict(z=-1.0), dict(x=-2.0), dict(pitch=0.2)):
                    add("past a limit", pose, pose, self.delta(**change))
        # readings that are no joint vector
        add("not finite", [*WORK[:2], math.nan, *WORK[3:]], WORK, self.delta(z=1.0))
        add("not finite", WORK, [*WORK[:4], math.inf, WORK[5]], self.delta(z=1.0))
        add("not finite", [*WORK[:2], math.nan, *WORK[3:]], WORK, self.delta(1.0))
        add("another length", WORK[:5], WORK, self.delta(z=1.0))
        add("another length", WORK, WORK[:5], self.delta(z=1.0))
        add("another length", [*WORK, 0.0], [*WORK, 0.0], self.delta(z=1.0))

        # other settings: the tolerances and the caps of PEAR's tests of the arm
        for on in ("so101_quick", "so101_quick_home"):
            for change in (dict(x=-8.0, z=-6.0, pitch=0.6), dict(z=2.0), dict(x=40.0), dict(x=0.5)):
                add("other settings", WORK, WORK, self.delta(**change), on)
            for error in (0.02, 0.05):
                measured = list(WORK)
                measured[2] += error
                add("other settings sag", measured, WORK, self.delta(x=1.0), on)

        rng = self.generator("checked_action")
        for _ in range(60 * self.scale):
            targets = self.random_pose(rng, station)
            measured = list(targets)
            if rng.random() < 0.4:
                joint = rng.randrange(GRIPPER_INDEX)
                measured[joint] += rng.choice([1, -1]) * rng.choice([0.004, 0.02, 0.059, 0.07, 0.15])
            if rng.random() < 0.2:
                measured[GRIPPER_INDEX] = rng.choice([0.0, 0.4, 1.0, 1.01, -0.01])
            add("generated", measured, targets, self.random_delta(rng))

        return cases

    # -- the small parts of an action's planning

    def delta_base_cases(self) -> list[dict[str, Any]]:
        cases = []
        rng = self.generator("delta_base")
        for station in ("so101_station", "so101_quick"):
            _, robot_config = self.stations.configs(station)
            tolerance = robot_config.position_tolerance
            errors = [0.0, 0.02, -0.02, tolerance, -tolerance, math.nextafter(tolerance, 1), math.nextafter(tolerance, 0)]
            errors += [math.nextafter(-tolerance, -1), 0.05, 0.5, math.nan, math.inf, -math.inf]
            vectors = [[error if index == joint else 0.0 for index in range(6)] for error in errors for joint in (0, 2, 4)]
            vectors += [[0.0, 0.0, 0.0, 0.0, 0.0, 0.5], [0.0, 0.0, 0.0, 0.0, 0.0, math.nan], [tolerance] * 6]
            vectors += [[rng.uniform(-1.5, 1.5) * tolerance for _ in range(6)] for _ in range(12 * self.scale)]
            for offsets in vectors:
                commanded = np.array(self.random_pose(rng, station))
                measured = commanded + np.array(offsets)
                base = SO101Planning.delta_base(robot_config, measured, commanded)
                cases.append({
                    "station": station,
                    "measured": plain(measured),
                    "commanded": plain(commanded),
                    "out": "commanded" if base is commanded else "measured",
                })
        return cases

    def action_parts_cases(self) -> list[dict[str, Any]]:
        actions = [self.delta(width) for width in (0.0, 1.0, -1.0, 0.3, -0.3, 1e-300, -1e-300, -0.0, 5)]
        actions += [self.delta(width, **{name: change}) for name in ZERO for change in (1.5, -0.0, 1e-300) for width in (0.0, -2.0)]
        actions += [{"type": "gripper", "command": command} for command in ("open", "close")]
        actions += [{"type": "joint_positions", "positions": [list(WORK)], "rate_hz": 5.0}]
        cases = []
        for action in actions:
            model = SO101Robot.ACTION_ADAPTER.validate(action)
            cases.append({
                "action": plain(action),
                "out": outcome(
                    lambda model=model: SO101Planning.action_parts(model),
                    shown=lambda parts: {"moves_arm": parts[0] is not None, "opens_gripper": parts[1]},
                ),
            })
        return cases

    # -- Home

    def home_case(self, kind: str, station: str, measured: Sequence[Any], targets: Sequence[Any]) -> dict[str, Any]:
        control_config, robot_config = self.stations.configs(station)
        case = {"kind": kind, "station": station, "measured": plain(measured), "targets": plain(targets)}
        observation = Snapshots.observation(decoded(case["measured"]), decoded(case["targets"]))
        case["out"] = outcome(
            lambda: SO101Planning.checked_home(control_config, robot_config, observation),
            shown=lambda planned: {"plan": plain(planned[0]), "move": Moves.record(planned[1])},
        )
        return case

    def home_cases(self) -> list[dict[str, Any]]:
        cases = []

        def add(kind: str, station: str, measured: Sequence[Any], targets: Sequence[Any]) -> None:
            cases.append(self.home_case(kind, station, measured, targets))

        rng = self.generator("checked_home")
        for station in ("so101_station", "so101_quick", "so101_home_caps", "so101_home_at_limit"):
            _, robot_config = self.stations.configs(station)
            home = list(robot_config.home.position)
            limits = robot_config.limits
            add("at Home", station, home, home)
            for opening in (0.0, 0.2, 0.5, 1.0 - 1e-9, 1.0 - 1e-7, 0.99):
                held = [*home[:GRIPPER_INDEX], opening]
                add("at Home, the gripper not open", station, held, held)
            for measured_opening in (0.97, 0.98, math.nextafter(0.98, 0), 1.02, 1.03, -0.01, 0.5):
                add("at Home, the gripper's reading", station, [*home[:GRIPPER_INDEX], measured_opening], home)
            for joint, away in ((0, 0.3), (0, -0.3), (1, 0.2), (2, 0.4), (3, -0.5), (4, 1.0), (0, 1e-11), (2, 2e-10)):
                for opening in (1.0, 0.2):
                    held = [*home[:GRIPPER_INDEX], opening]
                    held[joint] += away
                    add("away", station, held, held)
            # the arm rests off its command
            for sag in (0.01, -0.02, 0.04, 0.07, 0.12):
                held = list(home)
                held[0] -= 0.3
                measured = list(held)
                measured[2] += sag
                add("away, resting off the command", station, measured, held)
            # the held command or the reading past a limit, on the side Home leaves and on the other
            for joint, bound, sign in ((0, limits.upper_bounds[0], 1), (1, limits.lower_bounds[1], -1)):
                for past in (0.02, 0.049, 0.059, 0.07, 0.2):
                    held = list(home)
                    held[joint] = bound + sign * past
                    add("held past a limit", station, held, held)
                    measured = list(home)
                    measured[joint] = bound + sign * past
                    inside = list(home)
                    inside[joint] = bound - sign * 0.05
                    add("reading past a limit", station, measured, inside)
            for _ in range(10 * self.scale):
                held = self.random_pose(rng, station)
                measured = [value + rng.choice([0.0, 0.0, 0.01, -0.03]) for value in held[:GRIPPER_INDEX]]
                add("generated", station, [*measured, held[GRIPPER_INDEX]], held)
        add("not finite", "so101_station", [*self.HOME[:2], math.nan, *self.HOME[3:]], self.HOME)
        # what no case above decides (they come last, so that every case above keeps its place)
        for station in ("so101_station", "so101_quick"):
            _, robot_config = self.stations.configs(station)
            home = list(robot_config.home.position)
            limits = robot_config.limits
            away = list(home)
            away[0] -= 0.3
            # the jaw rests on an object, above its closed command: the gripper opens first, so that its reading
            # shifts no path
            for held in (home, away):
                for command, reading in ((0.0, 0.3), (0.0, 0.9), (0.2, 0.6)):
                    add("the jaw on an object", station, [*held[:GRIPPER_INDEX], reading], [*held[:GRIPPER_INDEX], command])
            # the two openings told apart: an open command with a reading short of open within the gripper's tolerance,
            # and a command short of open with an open reading
            for command, reading in ((1.0, 0.99), (0.99, 1.0), (1.0, 1.0 - 1e-6), (1.0 - 1e-6, 1.0)):
                add("the gripper's command and its reading", station, [*away[:GRIPPER_INDEX], reading], [*away[:GRIPPER_INDEX], command])
            # the held command past a limit, by less and by more than a reading may rest there, with the reading inside
            for joint, bound, sign in ((0, limits.upper_bounds[0], 1), (1, limits.lower_bounds[1], -1)):
                for past in (0.049, 0.07, 0.2):
                    held = list(home)
                    held[joint] = bound + sign * past
                    measured = list(home)
                    measured[joint] = bound - sign * 0.01
                    add("held past a limit, the reading inside", station, measured, held)
            # the gripper's command past an endpoint of its opening (Home's move starts from the open endpoint, so
            # nothing but the check of the held targets refuses it)
            for held in (home, away):
                for command in (1.04, 1.2, -0.04, -0.1):
                    add("the gripper's command past an endpoint", station, held, [*held[:GRIPPER_INDEX], command])
            # a joint exactly as far from Home as a move is not needed for, and the next number further
            for distance in (HomePlanning.MOVE_TOLERANCE, math.nextafter(HomePlanning.MOVE_TOLERANCE, 1)):
                held = list(home)
                held[1] += distance
                add("away by the move tolerance", station, held, held)

        return cases

    def bounds_cases(self) -> list[dict[str, Any]]:
        """check_home_bounds of SO101Planning and of HomePlanning itself, and home_move, on the same inputs."""
        cases = []
        rng = self.generator("bounds")
        for station in ("so101_station", "so101_quick", "so101_home_at_limit"):
            _, robot_config = self.stations.configs(station)
            home = list(robot_config.home.position)
            limits = robot_config.limits
            tolerance = robot_config.feedback_position_tolerance
            inputs: list[tuple[list[float], list[float], list[float]]] = []  # start, goal, offset
            still = [0.0] * 6
            away = list(home)
            away[0] -= 0.3
            inputs.append((home, home, still))
            inputs.append((away, home, still))
            for joint, bound, sign in ((0, limits.upper_bounds[0], 1), (2, limits.lower_bounds[2], -1)):
                # the reading past the bound by a share of the feedback tolerance, at Home and on the way to it
                for share in (0.5, 0.99, 1.0, 1.01, 2.0):
                    for start in (home, away):
                        offset = list(still)
                        offset[joint] = bound + sign * share * tolerance - start[joint]
                        inputs.append((start, home, offset))
                # a start held past the bound: it may only move inward
                for past in (0.01, 0.04):
                    start = list(home)
                    start[joint] = bound + sign * past
                    inward = list(home)
                    outward = list(start)
                    outward[joint] += sign * 0.005
                    inputs.append((start, inward, still))
                    inputs.append((start, outward, still))
                    inputs.append((start, start, still))
                    offset = list(still)
                    offset[joint] = sign * 0.02
                    inputs.append((start, inward, offset))
            for _ in range(16 * self.scale):
                start = self.random_pose(rng, station, 0.95)
                goal = self.random_pose(rng, station, 0.95) if rng.random() < 0.8 else list(start)
                goal[GRIPPER_INDEX] = start[GRIPPER_INDEX] = 1.0
                offset = [rng.choice([0.0, 0.0, 0.02, -0.04, 0.2]) for _ in range(GRIPPER_INDEX)] + [0.0]
                inputs.append((start, goal, offset))
            # what no input above decides (they come last, so that every case above keeps its place)
            moved_from: dict[int, list[float]] = {}  # by its place in the inputs: where the case's move started
            for joint, bound, sign in ((0, limits.upper_bounds[0], 1), (2, limits.lower_bounds[2], -1)):
                # a path that ends 0.005 inside the bound, of an arm that rests further out than its command (below it
                # at a lower bound, as an arm that sags under gravity): by 0.02 the shifted path ends past the bound, by
                # 0.004 it does not, and by 0.005 and 5e-8 it ends 5e-8 past it
                for rest in (0.02, 0.004, 0.005 + 5e-8):
                    start, goal, offset = list(home), list(home), list(still)
                    start[joint], goal[joint], offset[joint] = bound - sign * 0.03, bound - sign * 0.005, sign * rest
                    inputs.append((start, goal, offset))
                # a move that started 0.01 past the bound, checked from targets 5e-9 further in (a recheck lets the
                # targets be 1e-8 from the move's start) with a reading 0.01 further in: the planned path alone lies
                # outside the bounds of those targets
                held, offset = list(home), list(still)
                held[joint], offset[joint] = bound + sign * 0.01, -sign * 0.01
                targets = list(held)
                targets[joint] -= sign * 5e-9
                moved_from[len(inputs)] = held
                inputs.append((targets, home, offset))
            # a joint exactly as far from its goal as a move is not needed for, and the next number further
            for distance in (HomePlanning.MOVE_TOLERANCE, math.nextafter(HomePlanning.MOVE_TOLERANCE, 1)):
                start = list(home)
                start[1] += distance
                inputs.append((start, home, still))

            for index, (start, goal, offset) in enumerate(inputs):
                move_spec = None
                if max(abs(first - second) for first, second in zip(start, goal)) > 0:
                    move_spec = {"start": moved_from.get(index, start), "goal": goal, "speed_scale": robot_config.home.speed_scale}
                built = outcome(lambda move_spec=move_spec: Moves.build(robot_config, move_spec), shown=lambda move: move)
                case: dict[str, Any] = {"station": station, "start": start, "goal": goal, "offset": offset, "move": move_spec}
                if "error" in built:
                    case["build"] = built
                else:
                    move = built["ok"]
                    arguments = (robot_config, move, np.array(start), np.array(offset))
                    case["so101"] = outcome(lambda arguments=arguments: SO101Planning.check_home_bounds(*arguments))
                    case["generic"] = outcome(lambda arguments=arguments: HomePlanning.check_home_bounds(*arguments))
                home_move = (robot_config, np.array(start), np.array(goal), np.array(offset))
                case["home_move"] = outcome(lambda home_move=home_move: SO101Planning.home_move(*home_move), shown=Moves.record)
                case["generic_home_move"] = outcome(lambda home_move=home_move: HomePlanning.home_move(*home_move), shown=Moves.record)
                cases.append(case)

        return cases

    def recheck_cases(self) -> list[dict[str, Any]]:
        """recheck_home_move of both classes: the approved move against the targets and the readings of a later
        observation."""
        cases = []
        for station in ("so101_station", "so101_quick"):
            _, robot_config = self.stations.configs(station)
            home = list(robot_config.home.position)
            start = list(home)
            start[0] -= 0.3
            move_spec = {"start": start, "goal": home, "speed_scale": robot_config.home.speed_scale}
            observations = []
            for change in (0.0, 1e-9, 9.9e-9, 1.1e-8, 1e-6, 0.01):
                targets = list(start)
                targets[1] += change
                observations.append((targets, targets))
            for measured_change in (0.02, 0.07, 0.3):
                measured = list(start)
                measured[2] += measured_change
                observations.append((measured, start))
            observations.append(([*start[:GRIPPER_INDEX], 1.03], start))
            observations.append(([*start[:GRIPPER_INDEX], 0.5], start))
            past = list(start)
            past[0] = robot_config.limits.upper_bounds[0] + 0.1  # a reading past a limit by more than it may rest there
            observations.append((past, start))
            # a held target and a reading that are no number
            observations.append((start, [start[0], math.nan, *start[2:]]))
            observations.append(([*start[:3], math.nan, *start[4:]], start))
            for spec in (move_spec, None):
                move = Moves.build(robot_config, spec)
                for measured, targets in observations:
                    observation = Snapshots.observation(measured, targets)
                    arguments = (robot_config, observation, move)
                    cases.append({
                        "station": station,
                        "move": spec,
                        "measured": plain(measured),
                        "targets": plain(targets),
                        "so101": outcome(lambda arguments=arguments: SO101Planning.recheck_home_move(*arguments)),
                        "generic": outcome(lambda arguments=arguments: HomePlanning.recheck_home_move(*arguments)),
                    })
        return cases

    def estimate_cases(self) -> list[dict[str, Any]]:
        cases = []
        for station in ("so101_station", "so101_quick", "so101_home_caps"):
            control_config, robot_config = self.stations.configs(station)
            home = list(robot_config.home.position)
            start = list(home)
            start[0] -= 0.3
            for spec in (None, {"start": start, "goal": home, "speed_scale": robot_config.home.speed_scale}):
                move = Moves.build(robot_config, spec)
                for opening_s, has_opening in ((0.0, False), (2.5, True), (0.0, True), (1.25, False)):
                    cases.append({
                        "station": station,
                        "move": spec,
                        "opening_s": opening_s,
                        "has_opening": has_opening,
                        "out": plain(HomePlanning.time_estimates(control_config, robot_config, move, opening_s, has_opening)),
                    })
        return cases

    def opening_cases(self) -> list[dict[str, Any]]:
        cases = []
        tolerances = (0.02, 0.035)
        targets = (1.0, 1.0 - 1e-9, 1.0 - 1e-8, 1.0 - 1.1e-8, 0.99, 0.0, 1.0 + 1e-8, 1.0 + 2e-8)
        for tolerance in tolerances:
            measured = (1.0, 1.0 - tolerance, math.nextafter(1.0 - tolerance, 0), 1.0 + tolerance, 1.0 + 2 * tolerance, 0.5)
            for target in targets:
                for reading in measured:
                    cases.append({
                        "target": target,
                        "measured": reading,
                        "tolerance": tolerance,
                        "out": HomePlanning.needs_opening(target, reading, tolerance),
                    })
        return cases

    def measured_cases(self) -> list[dict[str, Any]]:
        cases = []
        for opening in (0.0, 1.0, 0.4, 1.03, -0.02, 2.0, -0.0):
            joints = [*WORK[:GRIPPER_INDEX], opening]
            observation = {"joint_positions": joints}
            cases.append({"joints": joints, "out": plain(HomePlanning.measured_positions(observation, LAYOUT))})
        return cases

    def no_home_cases(self) -> list[dict[str, Any]]:
        """The planning of Home on a robot whose settings have no Home: the robot refuses Home before it plans, so
        only a caller of the planning itself gets here, and what it gets is Python's error of reading the section
        that is not there."""
        control_config, robot_config = self.stations.configs("so101_no_home")
        away = list(WORK)
        away[0] += 0.2
        still = [0.0] * 6
        cases = []
        for call, arguments, run in (
            ("checked_home", {"measured": list(WORK), "targets": list(WORK)},
             lambda: SO101Planning.checked_home(control_config, robot_config, Snapshots.observation(WORK, WORK))),
            ("home_move", {"start": list(WORK), "goal": away, "offset": still},
             lambda: SO101Planning.home_move(robot_config, np.array(WORK), np.array(away), np.array(still))),
            ("home_move", {"start": list(WORK), "goal": list(WORK), "offset": still},
             lambda: SO101Planning.home_move(robot_config, np.array(WORK), np.array(WORK), np.array(still))),
            ("time_estimates", {"opening_s": 0.0, "has_opening": False},
             lambda: HomePlanning.time_estimates(control_config, robot_config, None, 0.0, False)),
        ):  # fmt: skip
            shown = Moves.record if call == "home_move" else plain
            cases.append({"station": "so101_no_home", "call": call, **arguments, "out": outcome(run, shown=shown)})
        return cases

    def all(self) -> dict[str, Any]:
        return {
            "action_cases": self.action_cases(),
            "delta_base_cases": self.delta_base_cases(),
            "action_parts_cases": self.action_parts_cases(),
            "home_cases": self.home_cases(),
            "bounds_cases": self.bounds_cases(),
            "recheck_cases": self.recheck_cases(),
            "estimate_cases": self.estimate_cases(),
            "opening_cases": self.opening_cases(),
            "measured_cases": self.measured_cases(),
            "no_home_cases": self.no_home_cases(),
        }


class ResultCases:
    """MotionResult.build, SO101MotionResult.from_snapshot, to_record and the format's report of the result."""

    def __init__(self, stations: Stations, scale: int) -> None:
        self.stations, self.scale = stations, scale

    @staticmethod
    def feedback(result: MotionResult | None) -> dict[str, Any]:
        return {
            "dispatched": FORMAT.result_feedback(result, is_dispatched=True),
            "not_dispatched": FORMAT.result_feedback(result, is_dispatched=False),
        }

    def snapshots(self) -> list[tuple[str, dict[str, Any]]]:
        """The control snapshots and the statuses a result is built from."""
        rng = random.Random(f"{SEED}:results")
        error = [2.7e-20, 1.1e-16, -2.8e-17, 0.0, 0.0, 0.0]
        tolerance = [0.06, 0.06, 0.06, 0.06, 0.06, 0.02]

        def arrival(settled: bool, reached: bool) -> dict[str, Any]:
            return {"reached": reached, "signed_error": error, "tolerance": tolerance, "settled": settled}

        def snapshot(position: Sequence[float], settled: bool = True, reached: bool = True, **fields: Any) -> dict[str, Any]:
            return {"status": "HOLD", "arms": {ARM: {"position": tuple(position)}}, "arrival": arrival(settled, reached), **fields}

        snapshots = [
            ("a settled hold at Home", snapshot(PlanningCases.HOME)),
            ("a settled hold at work", snapshot(WORK)),
            ("not reached", snapshot(WORK, True, False)),
            ("not settled", snapshot(WORK, False, True)),
            ("neither", snapshot(WORK, False, False)),
            ("the robot's status with its snapshot", {**snapshot(WORK), "status": "READY", "control_state": "HOLD"}),
            ("a fault's status", {**snapshot(WORK, False, False), "status": "FAULT", "control_state": "FAULT", "fault": "x"}),
            ("the jaw past its range", snapshot([*WORK[:GRIPPER_INDEX], 1.02])),
            ("the jaw on an object", snapshot([*WORK[:GRIPPER_INDEX], 0.4])),
            ("no arrival", {"status": "HOLD", "arms": {ARM: {"position": tuple(WORK)}}}),
            ("an arrival without its flags", {"arms": {ARM: {"position": tuple(WORK)}}, "arrival": {"signed_error": error}}),
            ("the brief status", {"status": "READY", "settled": True, "reached": True, "fault": None}),
            ("a closed robot", {"status": "OFF"}),
            ("nothing", {}),
            ("joints that are no number", snapshot([*WORK[:2], math.nan, *WORK[3:]])),
        ]
        for index in range(6 * self.scale):
            pose = [rng.uniform(-1.5, 1.5) for _ in range(GRIPPER_INDEX)] + [rng.random()]
            snapshots.append((f"generated {index}", snapshot(pose, rng.random() < 0.7, rng.random() < 0.7)))
        return snapshots

    def all(self) -> dict[str, Any]:
        kinematics = self.stations.kinematics("so101_station")
        errors: list[dict[str, Any] | None] = [
            None,
            {"type": "ValueError", "message": "Observation invalidated by another operation"},
            {"type": "RuntimeError", "message": "Station fault: FAULT: stand-in bus failure"},
            {"type": "TimeoutError", "message": "Action total timeout exceeded"},
            {"type": "TimeoutError", "message": ""},
            {"type": "OperatorPaused", "message": "Operation interrupted by the operator"},
            {"type": "OperatorPaused", "message": CONSOLE_PAUSE},
            {"type": "UnreachablePoseError", "message": "The target is out of reach. Along the requested change the arm can go at most 25% (x +10.0 of +40)."},
            {"type": "GripperEndpointTimeout", "message": "Gripper closing endpoint was not reached"},
            {"type": "HomePlanningError", "message": "Home target changed; check and confirm again"},
            {"type": "KeyError", "message": "arm"},
            {"type": "Exception", "message": 'a "quoted" message\nwith a second line and café'},
            {"type": "StabilityError", "message": "Persistent motion during HOLD", "metrics": {"stable": False, "samples": 3}},
            {"type": "HomeFailed", "message": "Home cancelled before execution", "details": {"stage": "checking", "error": "Home cancelled before execution", "completed_stages": [], "results": {}}},
        ]
        outcomes = [None, "open", "closed", "stopped_before_closed"]
        build_cases, snapshot_cases = [], []
        rng = random.Random(f"{SEED}:result cases")
        snapshots = dict(self.snapshots())
        whole = ("a settled hold at work", "a closed robot", "the jaw on an object")  # with every error and outcome
        for name, snapshot in snapshots.items():
            for status in MotionStatus:
                picked = errors if name in whole else [None, *rng.sample(errors[1:], 2)]
                for error_spec in picked:
                    for gripper_outcome in outcomes if error_spec is None and name in whole else [None]:
                        for has_kinematics in (True, False) if error_spec is None or name in whole else (True,):
                            error = None if error_spec is None else make_error(error_spec)
                            case = {
                                "snapshot": name,
                                "status": status.value,
                                # (the message as Python prints it: of a KeyError, the key's repr)
                                "error": None if error_spec is None else {**error_spec, "message": str(error)},
                                "gripper_outcome": gripper_outcome,
                                "kinematics": "so101_station" if has_kinematics else None,
                            }
                            case["out"] = outcome(
                                lambda: SO101MotionResult.from_snapshot(
                                    snapshot,
                                    status=status,
                                    error=error,
                                    kinematics=kinematics if has_kinematics else None,
                                    gripper_outcome=gripper_outcome,
                                ),
                                shown=lambda result: {"record": plain(result.to_record()), "feedback": self.feedback(result)},
                            )
                            case["log"] = RIG.log.take()
                            snapshot_cases.append(case)

        # MotionResult.build itself: a state that cannot be made, and a robot's own fields
        raising = {
            "ValueError": ValueError("no state"),
            "RuntimeError": RuntimeError("no state"),
            "UnreachablePoseError": UnreachablePoseError("no state"),
            "KeyError": KeyError("no state"),
            "TimeoutError": TimeoutError("no state"),
        }
        snapshot = snapshots["a settled hold at work"]
        for state_error, is_gripper_reached, status in (
            (None, True, MotionStatus.COMPLETED),
            (None, False, MotionStatus.COMPLETED),
            (None, False, MotionStatus.FAILED),
            ("ValueError", True, MotionStatus.COMPLETED),
            ("RuntimeError", True, MotionStatus.COMPLETED),
            ("UnreachablePoseError", True, MotionStatus.REJECTED),
            ("KeyError", True, MotionStatus.COMPLETED),
            ("TimeoutError", True, MotionStatus.COMPLETED),
        ):

            def to_model_state(position: list[float], state_error: str | None = state_error) -> Any:
                if state_error is not None:
                    raise raising[state_error]
                return kinematics.quantities(position)

            RIG.log.take()
            case = {
                "snapshot": "a settled hold at work",
                "status": status.value,
                "state_error": state_error,
                "is_gripper_reached": is_gripper_reached,
                "out": outcome(
                    lambda: MotionResult.build(
                        snapshot,
                        status=status,
                        error=None,
                        to_model_state=to_model_state,
                        is_gripper_reached=is_gripper_reached,
                        gripper_outcome="closed",
                    ),
                    shown=lambda result: {"record": plain(result.to_record()), "feedback": self.feedback(result)},
                ),
            }
            case["log"] = RIG.log.take()
            build_cases.append(case)

        # the report of results that no robot built: what the format reads of each field
        feedback_cases = [{"result": None, "out": {"ok": self.feedback(None)}}]
        for status in MotionStatus:
            for error in (
                None,
                {"code": "UnreachablePoseError", "message": "at most 18%."},
                {"code": "ValueError", "message": "Rotation increment exceeds the planning bound"},
                {"code": "RuntimeError", "message": 'a "quoted" message\nwith a second line, café and \U0001f600'},
            ):
                for gripper_outcome in (None, "", "closed", "stopped_before_closed"):
                    for is_settled, target_reached in ((True, False), (False, False), (True, True)):
                        fields = {
                            "status": status.value,
                            "is_settled": is_settled,
                            "target_reached": target_reached,
                            "measured_position": None,
                            "tracking_error": None,
                            "gripper_outcome": gripper_outcome,
                            "error": error,
                        }
                        result = SO101MotionResult(**{**fields, "status": status})
                        feedback_cases.append({"result": fields, "out": outcome(lambda result=result: self.feedback(result))})

        return {
            "result_snapshots": plain(snapshots),
            "snapshot_cases": snapshot_cases,
            "build_cases": build_cases,
            "feedback_cases": feedback_cases,
        }


class ActionCases:
    """What PEAR's action models take and refuse, and the text of each refusal: the robot's ActionAdapter, as
    BaseRobot.execute validates an action, and the models themselves."""

    DELTA = {
        "type": "single_arm_delta",
        "arm": {"x": 0.5, "y": -1.25, "z": 2.5, "pitch": 0.1, "roll": -0.2},
        "gripper": {"width": 0.5},
    }
    GRIPPER = {"type": "gripper", "command": "open"}
    CHUNK = {
        "type": "joint_positions",
        "positions": [[0.1, -0.2, 0.3, 0.4, -0.5, 0.25], [0.15, -0.2, 0.3, 0.4, -0.5, 0.75]],
        "rate_hz": 12.5,
    }
    STATE = {"arm": {"x": 22.7, "y": 0.8, "z": 20.8, "pitch": 0.69, "roll": -1.66}, "gripper": {"width": 5.5}}
    # what takes the place of a value: no value of a whole float among them (see whole_float_cases)
    WRONG = (
        None, True, False, "text", "1.5", "", 7, -3, 1.5, math.nan, math.inf, -math.inf, [], [1.5], {}, {"a": 1.5},
        "open", "single_arm_delta", 1e-05, 1.5e16, 123456789.125,
    )  # fmt: skip
    EXTRA = (1.5, "x", None, {"k": 2}, [1, 2], True)
    MODELS = {
        "SingleArmDelta": so101_actions.SingleArmDelta,
        "GripperAction": so101_actions.GripperAction,
        "JointPositions": so101_actions.JointPositions,
        "ModelState": so101_actions.ModelState,
        "ArmQuantities": so101_actions.ArmQuantities,
        "GripperQuantity": so101_actions.GripperQuantity,
    }

    def __init__(self, scale: int) -> None:
        self.scale = scale

    @classmethod
    def validate(cls, via: str, value: Any) -> Any:
        if via == "adapter":
            return SO101Robot.ACTION_ADAPTER.validate(value)
        return cls.MODELS[via].model_validate(value)

    @classmethod
    def case(cls, via: str, value: Any, kind: str) -> dict[str, Any]:
        """Returns what validating ``value`` gave: the model's class and its fields, or the refusal."""
        return {
            "kind": kind,
            "via": via,
            "input": plain(value),
            "out": outcome(
                lambda: cls.validate(via, value),
                shown=lambda model: {"class": type(model).__name__, "fields": model.model_dump(mode="json")},
            ),
        }

    @staticmethod
    def paths(value: Any, path: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
        """Returns the path of every value in ``value``, itself excluded."""
        children = value.items() if isinstance(value, dict) else enumerate(value) if isinstance(value, list) else ()
        found = []
        for key, child in children:
            found.append((*path, key))
            found.extend(ActionCases.paths(child, (*path, key)))
        return found

    @staticmethod
    def changed(value: Any, path: tuple[Any, ...], change: Callable[[Any, Any], None]) -> Any:
        """Returns a copy of ``value`` with ``change(parent, key)`` applied at ``path``."""
        value = copy.deepcopy(value)
        parent = value
        for key in path[:-1]:
            parent = parent[key]
        change(parent, path[-1])
        return value

    def mutations(self, via: str, base: dict[str, Any], kind: str, wrong_values: Sequence[Any] | None = None) -> list[dict[str, Any]]:
        """Returns ``base`` and what it becomes with one value left out, replaced by a wrong one, or added."""
        cases = [self.case(via, base, f"{kind}: valid")]
        for path in self.paths(base):
            if any(isinstance(key, int) and key > 0 for key in path[:-1]):
                continue  # (the second row: its values are refused as the first row's are)
            if len(path) > 1 and isinstance(path[-1], int) and path[-1] not in (0, GRIPPER_INDEX):
                continue  # (of a row, its first joint and its gripper)
            if isinstance(path[-1], str):
                cases.append(self.case(via, self.changed(base, path, lambda parent, key: parent.pop(key)), f"{kind}: missing"))
            for wrong in self.WRONG if wrong_values is None else wrong_values:
                cases.append(self.case(via, self.changed(base, path, lambda parent, key: parent.__setitem__(key, wrong)), f"{kind}: wrong value"))
        dicts = [()] + [path for path in self.paths(base) if isinstance(self.at(base, path), dict)]
        for path in dicts:
            for extra in self.EXTRA:
                value = copy.deepcopy(base)
                self.at(value, path)["extra"] = extra
                cases.append(self.case(via, value, f"{kind}: extra"))
        return cases

    @staticmethod
    def at(value: Any, path: tuple[Any, ...]) -> Any:
        for key in path:
            value = value[key]
        return value

    def adapter_cases(self) -> list[dict[str, Any]]:
        cases = []
        for base, kind in ((self.DELTA, "delta"), (self.GRIPPER, "gripper"), (self.CHUNK, "chunk")):
            cases += self.mutations("adapter", base, kind)

        def add(value: Any, kind: str) -> None:
            cases.append(self.case("adapter", value, kind))

        # what is no dictionary, and dictionaries that name no action
        for value in (None, 5, 1.5, "text", True, [], [self.DELTA], {}, {"type": None}, {"arm": self.DELTA["arm"]}):
            add(value, "no action")
        for tag in ("Single_Arm_Delta", "gripper ", "", "joint positions", 5, 1.5, True, None, ["gripper"], {"a": 1}):
            add({**self.DELTA, "type": tag}, "another tag")
            add({"type": tag}, "another tag")
        # every part's quantities as whole numbers, and several refusals at once
        whole = {"type": "single_arm_delta", "arm": dict.fromkeys(ZERO, 0), "gripper": {"width": 1}}
        add(whole, "whole numbers")
        add({**whole, "arm": {**whole["arm"], "x": -2}}, "whole numbers")
        add({"type": "single_arm_delta"}, "several")
        add({"type": "single_arm_delta", "arm": {}, "gripper": {}}, "several")
        add({"type": "single_arm_delta", "arm": {"x": "a", "yaw": 1.5, "y": None}, "gripper": {"width": True, "force": 2.5}, "id": "t"}, "several")
        add({"type": "gripper"}, "several")
        add({"type": "gripper", "command": "close", "force": 0.5, "speed": None}, "several")
        add({"type": "joint_positions"}, "several")
        add({"type": "joint_positions", "positions": [[0.1] * 5, [0.2] * 7, "row", [0.1, 0.2, "c", None, math.nan, 2.5]], "rate_hz": -1.5}, "several")
        # texts that Python writes its own way
        for text in ("it's", 'say "x"', "it's \"x\"", "back\\slash", "line\nbreak", "tab\there", "café", "日本", "\U0001f600", "\x00\x7f", "x" * 100):
            add({**self.GRIPPER, "command": text}, "texts")
            add({"type": text}, "texts")
        # a list that holds a literal is not the literal (JavaScript's == takes ["open"] for "open")
        add({**self.GRIPPER, "command": ["open"]}, "a literal in a list")
        add({**self.GRIPPER, "type": ["gripper"]}, "a literal in a list")
        add({**self.DELTA, "type": ["single_arm_delta"]}, "a literal in a list")
        add({**self.GRIPPER, "close": "open"}, "texts")
        add({**self.GRIPPER, "a key with spaces": 1.5, "café": 2.5, "": 3.5}, "texts")
        # a chunk's own rules: its rows, its rate and its grippers' range
        row = self.CHUNK["positions"][0]
        chunk = lambda **fields: {**self.CHUNK, **fields}  # noqa: E731
        add(chunk(positions=[]), "chunk rows")
        add(chunk(positions=[row] * SequenceOperation.MAX_ROWS), "chunk rows")
        cases.append({
            "kind": "chunk rows",
            "via": "adapter",
            "input": chunk(positions={"$rows": [SequenceOperation.MAX_ROWS + 1, row]}),
            "out": outcome(lambda: self.validate("adapter", chunk(positions=[row] * (SequenceOperation.MAX_ROWS + 1)))),
        })
        for length in (0, 1, 5, 7, 12):
            add(chunk(positions=[[0.25] * length]), "chunk rows")
        for opening in (1.5, -0.25, 1.0000001, -1e-09, math.nextafter(1.0, 2.0)):
            add(chunk(positions=[[*row[:5], opening]]), "chunk grippers")
            add(chunk(positions=[row, [*row[:5], opening]]), "chunk grippers")
            add(chunk(positions=[[*row[:5], opening]], rate_hz=-2.5), "chunk grippers")
        for rate in (0, -2.5, 1e-300, 1e300, 5, 0.5):
            add(chunk(rate_hz=rate), "chunk rate")
        add({"type": "joint_positions", "positions": [row]}, "chunk rate")
        add({"positions": [row], "rate_hz": 2.5}, "chunk rate")
        cases += self.gripper_bound_cases("adapter")
        cases += self.length_cases("adapter", with_many_rows=True)
        cases += self.shown_cases()

        return cases

    def model_cases(self) -> list[dict[str, Any]]:
        """The models themselves, as PEAR's parser and kinematics validate with them: no union, so a refusal's title
        is the model's name and its places carry no tag."""
        cases = []
        few = (None, True, "text", 7, 1.5, math.nan, [], {"a": 1.5})
        untagged = {key: value for key, value in self.DELTA.items() if key != "type"}
        cases += self.mutations("SingleArmDelta", untagged, "delta without its type", few)
        cases += self.mutations("ModelState", self.STATE, "state", few)
        cases += self.mutations("GripperQuantity", {"width": 2.5}, "gripper quantity", few)
        for via, value in (
            ("SingleArmDelta", self.DELTA),
            ("SingleArmDelta", {**self.DELTA, "type": "gripper"}),
            ("SingleArmDelta", None),
            ("SingleArmDelta", [1.5]),
            ("GripperAction", self.GRIPPER),
            ("GripperAction", {"command": "close"}),
            ("GripperAction", {"command": "shut"}),
            ("GripperAction", {"type": "single_arm_delta", "command": "open"}),
            ("GripperAction", {"command": ["close"]}),
            ("GripperAction", {"type": ["gripper"], "command": "open"}),
            ("SingleArmDelta", {**self.DELTA, "type": ["single_arm_delta"]}),
            ("GripperAction", {}),
            ("JointPositions", self.CHUNK),
            ("JointPositions", {"positions": self.CHUNK["positions"], "rate_hz": 2.5}),
            ("JointPositions", {"positions": [[0.5] * 6], "rate_hz": 0}),
            ("JointPositions", {"positions": [[0.5, 0.5, 0.5, 0.5, 0.5, 1.5]], "rate_hz": 2.5}),
            ("JointPositions", {"type": "chunk", "positions": [], "rate_hz": "fast"}),
            ("ArmQuantities", self.DELTA["arm"]),
            ("ArmQuantities", {**self.DELTA["arm"], "yaw": 0.5}),
            ("ArmQuantities", {"x": 1.5}),
            ("ArmQuantities", "arm"),
            ("ModelState", {"arm": {**self.STATE["arm"], "x": math.nan}, "gripper": {"width": math.inf}}),
        ):
            cases.append(self.case(via, value, "a model"))
        cases += self.gripper_bound_cases("JointPositions")
        cases += self.length_cases("JointPositions", with_many_rows=False)
        return cases

    def gripper_bound_cases(self, via: str) -> list[dict[str, Any]]:
        """A gripper's target at the ends of [0, 1] and the nearest floats within, which PEAR takes (the float -0.0
        and the ints 0 and 1 among them), and the nearest floats outside, which it refuses: in a row alone, in the
        first of two and in the last."""
        row = self.CHUNK["positions"][0]
        cases = []
        for target in (0.0, -0.0, 0, 1.0, 1, 5e-324, math.nextafter(1.0, 0.0), -5e-324, math.nextafter(1.0, 2.0)):
            end = [*row[:GRIPPER_INDEX], target, *row[GRIPPER_INDEX + 1 :]]
            for positions in ([end], [end, row], [row, end]):
                cases.append(self.case(via, {**self.CHUNK, "positions": positions}, "chunk grippers: at the bounds"))
        return cases

    def length_cases(self, via: str, *, with_many_rows: bool) -> list[dict[str, Any]]:
        """Lists past their maximum. PEAR counts an item once it is validated, valid or not: the first one past the
        maximum ends the list's validation, and the length error alone stands for the list, in place of its items'
        errors. A row that is too long is one error of the rows, which go on; the action's other errors stay, and
        the grippers' range is not checked. No value of a whole float is shown (see whole_float_cases)."""
        most, width = SequenceOperation.MAX_ROWS, LAYOUT.vector_length
        good = self.CHUNK["positions"][0]
        cases = []

        def row(length: int, bad: Sequence[int] = (), wrong: Any = "x") -> list[Any]:
            return [wrong if index in bad else 0.25 for index in range(length)]

        def add(positions: Any, kind: str, **fields: Any) -> None:
            cases.append(self.case(via, {**self.CHUNK, "positions": positions, **fields}, f"too long: {kind}"))

        # a row: a bad item at each place, the one past the maximum and those after it among them
        for index in range(width + 1):
            add([row(width + 1, [index])], "a row with a bad item")
        for wrong in (None, True, math.nan, math.inf, [1.5], {"a": 1.5}, ""):
            add([row(width + 1, [0], wrong)], "a row with a bad item")
            add([row(width + 1, [width], wrong)], "a row with a bad item")
        add([row(width + 1, range(width + 1))], "a row with a bad item")
        add([row(width + 2, [width])], "a row with a bad item")
        add([row(width + 2, [width + 1])], "a row with a bad item")
        add([row(width + 2, [0, width + 1])], "a row with a bad item")
        add([row(2 * width, [2, width + 3])], "a row with a bad item")
        # a row among others: the rows go on, each with its own error
        add([row(width + 1, [0]), row(width, [0])], "a row among others")
        add([row(width, [0]), row(width + 1, [0])], "a row among others")
        add([row(width + 1), row(width + 1, [width])], "a row among others")
        add([row(width - 1), row(width + 1)], "a row among others")
        add([row(width - 1, [1]), row(width + 1, [1])], "a row among others")
        add([row(width + 1, [0]), "row", row(width, [GRIPPER_INDEX])], "a row among others")
        add([good, row(width + 1, [3]), good], "a row among others")
        # the action's other errors stay; its grippers' range is not checked
        add([row(width + 1, [0])], "with the action's other errors", rate_hz="fast")
        add([row(width + 1, [0])], "with the action's other errors", rate_hz=-1.5)
        add([row(width + 1, [0])], "with the action's other errors", extra=1.5)
        cases.append(self.case(via, {"type": "joint_positions", "positions": [row(width + 1, [0])]}, "too long: with the action's other errors"))
        outside = [*good[:GRIPPER_INDEX], 1.5, *good[GRIPPER_INDEX + 1 :]]
        add([[*outside, 0.25]], "a gripper outside its range")
        add([outside, row(width + 1)], "a gripper outside its range")
        # the rows: every row too long and bad (as a count and the row: the list is long)
        every = row(width + 1, [0])
        cases.append({
            "kind": "too long: the rows",
            "via": via,
            "input": {**self.CHUNK, "positions": {"$rows": [most + 1, every]}},
            "out": outcome(lambda: self.validate(via, {**self.CHUNK, "positions": [every] * (most + 1)})),
        })
        if with_many_rows:
            add([row(width, [0]), *[good] * most], "the rows")  # the first row bad
            add([*[good] * (most - 1), row(width, [0]), good], "the rows")  # the last row within the maximum
            add([*[good] * most, row(width, [0])], "the rows")  # the row past the maximum
            add([*[good] * (most + 1), row(width, [0])], "the rows")  # the row after it, which is never validated
            add(["row", *[good] * most], "the rows")
            add([row(width + 1), row(width - 1), *[good] * (most - 1)], "the rows")
            add([row(width, [0]), *[good] * most], "the rows", rate_hz=-1.5)
            # at the maximum the rows are not too long: an item's error, a row's length error
            add([row(width, [0]), *[good] * (most - 1)], "the rows at their maximum")
            add([*[good] * (most - 1), row(width + 1, [width])], "the rows at their maximum")
        return cases

    def shown_cases(self) -> list[dict[str, Any]]:
        """The input a refusal shows. PEAR measures its repr in UTF-8 bytes and shows one of at most 50 whole; of a
        longer one it shows the first 25 bytes and the last 24 around "...", each less the bytes of a character its
        cut would split. What repr escapes counts as it is written. The texts are a command, in a list, a key and
        its value, and an item of a row that is too long."""
        texts = ["x" * count for count in (47, 48, 49, 50)]
        for letter, counts in (("\u00e9", (23, 24, 25, 30)), ("\u65e5", (15, 16, 17, 20)), ("\U0001f600", (11, 12, 13, 20))):
            size = len(letter.encode())
            texts += ["abc"[:lead] + letter * count for lead in range(size) for count in counts]  # the cut at each byte
            texts += [letter * counts[2] + "abc"[:tail] for tail in range(1, size)]  # and the back's cut
        texts.append("a\u00e9\u65e5\U0001f600" * 6)
        # what repr escapes: a control character, a no-break space, a zero-width space, a tag character; the quotes
        texts += ["\x00" * 12, "\x00" * 13, "\u00a0" * 12, "\u00a0" * 13, "\u200b" * 8, "\u200b" * 9, "\U000e0001" * 5]
        texts += ["'" + "\u00e9" * 24, "'\"" + "\u00e9" * 23]
        # the printable characters nearest to where UTF-8 takes a byte more: a repr of exactly 50 bytes, and the next
        for letter in ("~", "\u00a1", "\u07ff", "\u0800", "\ufffd", "\U00010000"):
            whole = 48 // len(letter.encode())
            texts += [letter * whole, letter * (whole + 1)]
        cases = []
        for text in texts:
            cases.append(self.case("adapter", {**self.GRIPPER, "command": text}, "shown input: a text"))
            cases.append(self.case("adapter", {**self.GRIPPER, "command": [text, 1.5]}, "shown input: a text in a list"))
            cases.append(self.case("adapter", {"type": "gripper", text: text}, "shown input: a key and its value"))
            cases.append(self.case("adapter", {**self.CHUNK, "positions": [[text, *[0.25] * LAYOUT.vector_length]]}, "shown input: in a row that is too long"))
        rng = random.Random(f"{SEED}:shown inputs")
        letters = "aZ0 '\"\\\n\u00e9\u00df\u0416\u00a0\u65e5\u672c\u20ac\u200b\U0001f600\U00010348\U000e0001"
        for _ in range(40 * self.scale):
            text = "".join(rng.choice(letters) for _ in range(rng.randint(8, 30)))
            cases.append(self.case("adapter", {**self.GRIPPER, "command": text}, "shown input: a text"))
            cases.append(self.case("adapter", {"type": "gripper", text: text}, "shown input: a key and its value"))
        return cases

    def instance_cases(self) -> list[dict[str, Any]]:
        """Of which models a validated value is an instance. PEAR's classes are apart, so a value is one of its own
        class alone: an action of the single-arm format holds the fields of a ModelState and is none."""
        values = {
            "SingleArmDelta": self.DELTA,
            "GripperAction": self.GRIPPER,
            "JointPositions": self.CHUNK,
            "ModelState": self.STATE,
            "ArmQuantities": self.STATE["arm"],
            "GripperQuantity": self.STATE["gripper"],
        }
        cases = []
        for name, value in values.items():
            model = self.validate(name, value)
            cases.append({
                "class": type(model).__name__,
                "fields": model.model_dump(mode="json"),
                "instance_of": {other: isinstance(model, model_class) for other, model_class in self.MODELS.items()},
            })
        return cases

    def whole_float_cases(self) -> list[dict[str, Any]]:
        """Inputs that hold a float of a whole value. JavaScript has one number for 2.0 and 2, so pear.js reads each as
        the int; ``as_ints`` is what PEAR gave for the input with those floats as ints (the float -0.0 stays one:
        JavaScript tells it from 0)."""
        still = {"type": "single_arm_delta", "arm": dict(ZERO), "gripper": {"width": 0.0}}
        inputs: list[tuple[str, Any]] = [
            ("adapter", still),
            ("adapter", {**still, "extra": 2.0}),
            ("adapter", {**still, "type": "another"}),
            ("adapter", {"arm": still["arm"], "gripper": still["gripper"]}),
            ("adapter", {**still, "arm": {**ZERO, "x": "a"}}),
            ("adapter", {**still, "arm": {**ZERO, "yaw": 1.0}}),
            ("adapter", {**still, "gripper": {"width": 1.0, "force": 3.0}}),
            ("adapter", {**still, "gripper": 1.0}),
            ("adapter", {**still, "arm": 0.0}),
            ("adapter", {**still, "arm": {**ZERO, "x": -0.0}, "extra": -0.0}),
            ("adapter", {"type": 1.0}),
            ("adapter", 2.0),
            ("adapter", {"type": "gripper", "command": 1.0}),
            ("adapter", {"type": "joint_positions", "positions": [[0.0, 0.0, 0.0, 0.0, 0.0, 1.0]], "rate_hz": 10.0}),
            ("adapter", {"type": "joint_positions", "positions": [[0.0, 0.0, 0.0, 0.0, 0.0, 2.0]], "rate_hz": 10.0}),
            ("adapter", {"type": "joint_positions", "positions": [[0.0, 0.0, 0.0, 0.0, 0.0]], "rate_hz": 0.0}),
            ("adapter", {"type": "joint_positions", "positions": 3.0, "rate_hz": 10.0}),
            ("adapter", {"type": "joint_positions", "positions": [0.0, [1.0]], "rate_hz": 1e16}),
            ("SingleArmDelta", {"arm": dict(ZERO), "gripper": {"width": 0.0}, "extra": 0.0}),
            ("ModelState", {"arm": {**ZERO, "x": 22.0}, "gripper": {"width": 6.0}, "extra": [1.0, 2.5]}),
            ("GripperQuantity", {"width": 6.0, "depth": 100.0}),
            ("GripperQuantity", 6.0),
        ]
        cases = []
        for via, value in inputs:
            case = self.case(via, value, "whole floats")
            case["as_ints"] = self.case(via, self.as_ints(value), "")["out"]
            cases.append(case)
        return cases

    @classmethod
    def as_ints(cls, value: Any) -> Any:
        if isinstance(value, float) and math.isfinite(value) and value.is_integer() and not (value == 0 and math.copysign(1, value) < 0):
            return int(value)
        if isinstance(value, dict):
            return {key: cls.as_ints(child) for key, child in value.items()}
        if isinstance(value, list):
            return [cls.as_ints(child) for child in value]
        return value

    def all(self) -> dict[str, Any]:
        return {
            "adapter_cases": self.adapter_cases(),
            "model_cases": self.model_cases(),
            "whole_float_cases": self.whole_float_cases(),
            "instance_cases": self.instance_cases(),
        }


class ScriptedCamera:
    """PEAR's WristCamera over a camera that a script feeds: the object lerobot's OpenCVCamera is to it (its reader
    thread, its latest frame and the frame's stamp), without a device. The WristCamera is made without its
    constructor, which opens the device; everything it does afterwards is PEAR's own."""

    def __init__(self, role: str = "wrist") -> None:
        self.is_reading: bool | None = True  # None: no reader thread at all
        self.disconnects = 0
        self.fails_to_close = False
        camera = SimpleNamespace(
            frame_lock=threading.Lock(), latest_frame=None, latest_timestamp=None, is_connected=True, disconnect=self.disconnect
        )
        self.camera = camera
        script = self

        class Thread:
            def is_alive(self) -> bool:
                return bool(script.is_reading)

        self.thread = Thread()
        camera.thread = self.thread
        self.source = WristCamera.__new__(WristCamera)
        self.source.role = role
        self.source.camera = camera
        self.source._last_frame_stamp = None
        self.source._frame_count = 0

        # what a script has the camera do at a read: something once, before the read (as another thread would
        # during it), and an error in the place of the read (a camera source may raise anything)
        self.on_read: Callable[[], None] | None = None
        self.read_raises: dict[str, Any] | None = None
        read_preview = self.source.read_preview

        def scripted_read_preview() -> Any:
            on_read, self.on_read = self.on_read, None
            if on_read is not None:
                on_read()
            if self.read_raises is not None:
                raise make_error(self.read_raises)
            return read_preview()

        self.source.read_preview = scripted_read_preview

    def disconnect(self) -> None:
        if self.fails_to_close:
            raise OSError("the camera did not close")
        self.disconnects += 1
        self.camera.is_connected = False

    def apply(self, operation: dict[str, Any]) -> None:
        """Does what a script says of the camera: a new frame (its number fills every pixel) with its age, the
        reader thread's state, or a failing close."""
        if "frame" in operation:
            frame = operation["frame"]
            self.camera.latest_frame = None if frame is None else np.full((2, 3, 3), frame, dtype=np.uint8)
            age_s = operation.get("age_s", 0.0)
            self.camera.latest_timestamp = None if age_s is None else time.monotonic() - age_s
        if "reading" in operation:
            self.is_reading = operation["reading"]
            self.camera.thread = None if self.is_reading is None else self.thread
        if "fails_to_close" in operation:
            self.fails_to_close = operation["fails_to_close"]
        if "read_raises" in operation:
            self.read_raises = operation["read_raises"]

    @staticmethod
    def frames(frames: dict[str, Any]) -> dict[str, Any]:
        """A read's frames as a fixture holds them: the number that fills the frame in the place of its pixels."""
        return {
            role: {"frame": int(frame["rgb"][0, 0, 0]), "received_monotonic_s": frame["received_monotonic_s"], "frame_number": frame["frame_number"]}
            for role, frame in frames.items()
        }


class CameraCases:
    """The wrist camera's checks and the camera feed, on scripted frames and the stand-in clock."""

    def __init__(self, clock: RecordingClock) -> None:
        self.clock = clock

    def run(self, name: str, script: list[dict[str, Any]]) -> dict[str, Any]:
        self.clock.now = StandInClock.START_S
        camera = ScriptedCamera()
        other = ScriptedCamera()
        feed: CameraFeed | None = None
        steps = []
        for operation in script:
            step = dict(operation)
            op = operation["op"]
            target = other if operation.get("camera") == "other" else camera
            if op == "set":
                target.apply(operation)
            elif op == "advance":
                self.clock.now += operation["seconds"]
            elif op == "clock":
                self.clock.now = operation["now"]  # (a reading at which an age is an exact difference)
            elif op == "read_preview":
                step["out"] = outcome(
                    lambda: target.source.read_preview(),
                    shown=lambda preview: {"frames": ScriptedCamera.frames(preview[0]), "errors": preview[1]},
                )
            elif op == "read":
                step["out"] = outcome(lambda: target.source.read(), shown=ScriptedCamera.frames)
            elif op == "close":
                step["out"] = outcome(lambda: target.source.close())
                step["disconnects"] = target.disconnects
            elif op == "feed":
                reader = {"camera": camera.source, "other": other.source, None: None}[operation["reader"]]
                feed = CameraFeed(reader)
            elif op == "feed_set_reader":
                feed.set_reader({"camera": camera.source, "other": other.source}[operation["reader"]])
            elif op == "feed_read_preview":
                step["out"] = outcome(
                    lambda: feed.read_preview(),
                    shown=lambda preview: {"frames": ScriptedCamera.frames(preview[0]), "errors": preview[1]},
                )
            elif op == "feed_read":
                step["out"] = outcome(lambda: feed.read(), shown=ScriptedCamera.frames)
            elif op == "feed_close":
                step["out"] = outcome(lambda: feed.close())
                step["disconnects"] = [camera.disconnects, other.disconnects]
                step["has_reader"] = feed.reader is not None
            else:
                raise AssertionError(f"unknown camera operation {op}")
            step["clock"] = self.clock.now
            steps.append(step)
        return {"name": name, "steps": steps}

    def all(self) -> dict[str, Any]:
        max_age_s = CameraSource.MAX_AGE_S
        read, preview = {"op": "read"}, {"op": "read_preview"}
        scripts = {
            "before the first frame": [preview, read],
            "fresh frames are numbered": [
                {"op": "set", "frame": 11}, preview, preview, read,
                {"op": "advance", "seconds": 0.03}, {"op": "set", "frame": 12}, read,
                {"op": "advance", "seconds": 0.03}, {"op": "set", "frame": 13}, preview, read, read,
            ],  # fmt: skip
            "a frame ages": [
                {"op": "set", "frame": 21}, read,
                {"op": "advance", "seconds": 0.1}, read,
                {"op": "advance", "seconds": 0.1}, preview, read,
                {"op": "advance", "seconds": 0.02}, preview, read,
                {"op": "set", "frame": 22}, read,
            ],  # fmt: skip
            "the age at its bound": [
                {"op": "set", "frame": 31, "age_s": max_age_s}, preview,
                {"op": "set", "frame": 32, "age_s": math.nextafter(max_age_s, 1)}, preview,
                {"op": "set", "frame": 33, "age_s": 0.19}, preview,
                {"op": "set", "frame": 34, "age_s": 0.25}, preview, read,
                {"op": "set", "frame": 35, "age_s": -0.05}, preview,
            ],  # fmt: skip
            # at 100 s no age of a frame is exactly the bound (the doubles there lie 1.4e-14 apart, and 0.2 is none
            # of their differences); at 0.4 s the frame stamped 0.2 s ago is exactly 0.2 s old, and still fresh
            "the age exactly at its bound": [
                {"op": "clock", "now": 0.4},
                {"op": "set", "frame": 36, "age_s": max_age_s}, preview, read,
                {"op": "set", "frame": 37, "age_s": math.nextafter(max_age_s, 1)}, preview,
                {"op": "set", "frame": 38, "age_s": math.nextafter(max_age_s, 0)}, preview,
            ],  # fmt: skip
            "a camera that raises": [
                {"op": "set", "frame": 39}, read,
                {"op": "set", "read_raises": {"type": "ValueError", "message": "the frame is no picture"}}, preview, read,
                {"op": "feed", "reader": "camera"}, {"op": "feed_read"}, {"op": "feed_read_preview"},
                {"op": "set", "read_raises": None}, {"op": "feed_read"},
            ],  # fmt: skip
            "a frame without its stamp, a stamp without its frame": [
                {"op": "set", "frame": 41, "age_s": None}, preview, read,
                {"op": "set", "frame": None, "age_s": 0.0}, preview,
                {"op": "set", "frame": 42}, preview,
            ],  # fmt: skip
            "the reader stops": [
                {"op": "set", "frame": 51}, read,
                {"op": "set", "reading": False}, preview, read,
                {"op": "set", "reading": True}, read,
                {"op": "set", "reading": None}, preview, read,
            ],  # fmt: skip
            "closing": [
                {"op": "set", "frame": 61}, read, {"op": "close"}, {"op": "close"}, preview,
            ],  # fmt: skip
            "a feed passes its reader's frames on": [
                {"op": "feed", "reader": "camera"}, {"op": "feed_read_preview"}, {"op": "feed_read"},
                {"op": "set", "frame": 71}, {"op": "feed_read_preview"}, {"op": "feed_read"},
                {"op": "advance", "seconds": 0.5}, {"op": "feed_read_preview"}, {"op": "feed_read"},
            ],  # fmt: skip
            "a feed whose reader is replaced": [
                {"op": "feed", "reader": "camera"}, {"op": "set", "frame": 81}, {"op": "feed_read"},
                {"op": "set", "camera": "other", "frame": 82}, {"op": "feed_set_reader", "reader": "other"}, {"op": "feed_read"},
                {"op": "feed_close"}, {"op": "feed_read"}, {"op": "feed_read_preview"}, {"op": "feed_close"},
                {"op": "feed_set_reader", "reader": "camera"}, {"op": "feed_read"},
            ],  # fmt: skip
            "a feed without a reader": [
                {"op": "feed", "reader": None}, {"op": "feed_read"}, {"op": "feed_read_preview"}, {"op": "feed_close"},
            ],  # fmt: skip
            "a feed whose reader fails to close": [
                {"op": "feed", "reader": "camera"}, {"op": "set", "frame": 91}, {"op": "set", "fails_to_close": True},
                {"op": "feed_close"}, {"op": "feed_read"},
                {"op": "set", "fails_to_close": False}, {"op": "feed_close"}, {"op": "feed_read"},
            ],  # fmt: skip
        }
        return {"camera_cases": [self.run(name, script) for name, script in scripts.items()]}


# ---- part 2: the robot on PEAR's stepped rig ----


class Responses:
    """What a stand-in SO-101 arm reaches for a commanded goal from its position, by the name a script gives (the
    same as the control loop's fixtures give: tools/fixtures/loop_fixtures.py)."""

    @staticmethod
    def make(spec: dict[str, Any] | None) -> Callable[[tuple[float, ...], tuple[float, ...]], Sequence[float]] | None:
        if spec is None:
            return None
        kind = spec["kind"]

        def min_gripper(goal: tuple[float, ...], position: tuple[float, ...]) -> Sequence[float]:
            # the jaw opens no further than a limit
            return (*goal[:GRIPPER_INDEX], min(goal[GRIPPER_INDEX], spec["limit"]))

        def sag(goal: tuple[float, ...], position: tuple[float, ...]) -> Sequence[float]:
            # a P-only servo: it rests ``sag`` below its goal, anywhere within +-``friction`` of that, and moves
            # only when pushed out of that band
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


class Session:
    """One robot of PEAR's on its stepped rig and the script that drives it: every step is one call of the robot
    under PEAR's name, runs on PEAR at once and is written with what PEAR did, so that pear.js can repeat the script
    and must get the same record.

    A step holds what the call returned or raised (``out``); every sleep it took (``ticks``: how long, the driver's
    calls since the sleep before, the loop's state after its step, and what the script did right after it); the
    driver's calls after the last sleep (``io``); the clock before and after; the UUIDs the robot drew; the answers
    of the kinematics; what the robot logged; and the robot's status with its snapshot and the joint vector its
    operation heads for at the step's end (``after``). What a script did right after a move's dispatch is under
    ``dispatch_hooks``, what it did during a read of the wrist camera under ``read_hooks``, what it did during the
    report of a stage of Home under ``stage_hooks``. A session may change settings of its station's robot for itself
    alone (``settings``)."""

    def __init__(
        self,
        name: str,
        source: str,
        about: str,
        station: str,
        *,
        cameras: str = "none",
        action_mode: str = "cartesian",
        settings: dict[str, Any] | None = None,
    ) -> None:
        self.name, self.source, self.about, self.station = name, source, about, station
        self.cameras_kind, self.action_mode = cameras, action_mode
        self.settings = settings  # what this session alone changes of the settings of its station's robot
        self.clock = RIG.new_clock()
        self.steps: list[dict[str, Any]] = []
        self.observations: dict[str, Any] = {}
        self.cancellations: dict[str, threading.Event] = {}
        self.wrist: ScriptedCamera | None = None
        self.side: dict[str, Any] = {}  # what the step that runs keeps beside what it returns
        self.dispatch_hook: list[dict[str, Any]] | None = None
        self.arm_reads: dict[int, Any] = {}  # each stand-in arm's own read, while a script has it show a velocity
        RIG.io.take(), RIG.ids.take(), RIG.take_ik(), RIG.log.take()

        cameras_source: Any = None
        if cameras == "drawn":
            cameras_source = StandInCameras(SO101Robot.CAMERAS)
        elif cameras == "wrist":
            self.wrist = ScriptedCamera()
            cameras_source = self.wrist.source
        config = STATIONS.config(station)
        if settings is not None:
            config = OmegaConf.merge(config, {"robot": settings})
        self.robot = SteppedStandInSO101Robot(config, cameras=cameras_source, action_mode=ActionMode(action_mode))
        self.period_s = self.robot.control_period_s

    # -- the record

    def result(self) -> dict[str, Any]:
        if self.robot._control_loop is not None:
            self.do("close")
        self.clock.control_loop = None
        return {
            "name": self.name,
            "source": self.source,
            "about": self.about,
            "station": self.station,
            "cameras": self.cameras_kind,
            "action_mode": self.action_mode,
            **({} if self.settings is None else {"settings": plain(self.settings)}),
            "steps": self.steps,
        }

    def after(self) -> dict[str, Any]:
        robot = self.robot
        control_loop = robot._control_loop
        return {
            "status": plain(robot.status(with_snapshot=True)),
            "requested": None if control_loop is None else plain(control_loop.requested_position()),
            "session_id": robot.session_id,
            "diagnostics": plain(robot.last_error_diagnostics),
        }

    def do(self, op: str, hooks: Sequence[dict[str, Any]] = (), **arguments: Any) -> dict[str, Any]:
        """Runs one step on PEAR and appends it with its record."""
        step: dict[str, Any] = {"op": op, **plain(arguments)}
        if hooks:
            step["hooks"] = plain(list(hooks))
        self.side = {}
        clock_before = self.clock.now
        pending = {hook["tick"]: hook["do"] for hook in hooks if "tick" in hook}
        # a hook of a generated script may name a control period that its step never reaches: then it does nothing
        optional = {hook["tick"] for hook in hooks if "tick" in hook and hook.get("optional")}
        on_dispatch = [hook["do"] for hook in hooks if hook.get("on") == "dispatch"]

        def after_tick(count: int) -> list[Any] | None:
            operations = pending.pop(count, None)
            return None if operations is None else [self.hooked(operation) for operation in operations]

        self.clock.after_tick = after_tick
        if on_dispatch:
            self.intercept_dispatch(on_dispatch[0], step)
        try:
            step["out"] = outcome(lambda: self.call(op, step))
        finally:
            self.clock.after_tick = None
            if on_dispatch:
                self.restore_dispatch()
        if set(pending) - optional:
            raise AssertionError(f"{self.name}: step {len(self.steps)} ({op}) ended before tick {min(pending)}: {json.dumps(step['out'])[:600]}")
        step.update(self.side)
        step["ticks"] = self.clock.take()
        step["io"] = RIG.io.take()
        step["clock"] = [clock_before, self.clock.now]
        for key, value in (("uuids", RIG.ids.take()), ("ik", RIG.take_ik()), ("log", RIG.log.take())):
            if value:
                step[key] = value
        step["after"] = self.after()
        self.steps.append(step)
        return step

    def hooked(self, operation: dict[str, Any]) -> dict[str, Any]:
        """Runs what a script does right after a control period, inside the caller's sleep."""
        record = dict(plain(operation))
        record["out"] = outcome(lambda: self.call(operation["op"], record))
        return record

    def intercept_dispatch(self, operations: list[dict[str, Any]], step: dict[str, Any]) -> None:
        """Has the script act right after the action's move is dispatched, before any control period, as PEAR's
        test_an_interrupted_execution_is_not_reported_as_completed does."""
        control_loop = self.robot.control_loop
        dispatch = control_loop.dispatch_joint_move

        def interrupted(*arguments: Any, **keywords: Any) -> bool:
            value = dispatch(*arguments, **keywords)
            if value:
                self.side["dispatch_hooks"] = [self.hooked(operation) for operation in operations]
            return value

        self.dispatch_restore = (control_loop, dispatch)
        control_loop.dispatch_joint_move = interrupted

    def restore_dispatch(self) -> None:
        control_loop, dispatch = self.dispatch_restore
        control_loop.dispatch_joint_move = dispatch

    # -- the calls

    def observation(self, name: str | None) -> Any:
        return None if name is None else self.observations[name]

    def arm(self) -> Any:
        return self.robot.control_loop.driver.hardware

    @staticmethod
    def observation_record(observation: dict[str, Any]) -> dict[str, Any]:
        return {
            "observation_id": observation["observation_id"],
            "session_id": observation["session_id"],
            "captured_monotonic_s": observation["captured_monotonic_s"],
            "joint_positions": plain(observation["joint_positions"]),
            "camera_timestamps": plain(observation["camera_timestamps"]),
            "images": {
                role: (int(image[0, 0, 0]) if image.shape == (2, 3, 3) else list(image.shape))
                for role, image in observation["images"].items()
            },
            "control_snapshot": plain(observation["control_snapshot"]),
        }

    def result_record(self, result: MotionResult) -> dict[str, Any]:
        return {
            "record": plain(result.to_record()),
            "feedback": ResultCases.feedback(result),
            "diagnostics": plain(self.robot.last_error_diagnostics),
        }

    def call(self, op: str, a: dict[str, Any]) -> Any:
        """Makes the call a step names of PEAR's robot and returns what a fixture keeps of what it returned."""
        robot, clock = self.robot, self.clock
        if op == "open":
            robot.open()
            clock.control_loop = robot.control_loop
            return {"session_id": robot.session_id, "control_period_s": robot.control_period_s, "action_mode": robot.action_mode.value}
        if op == "close":
            try:
                return robot.close()
            finally:
                if robot._control_loop is None:
                    clock.control_loop = None
        if op == "status":
            return robot.status(with_snapshot=a.get("with_snapshot", False))
        if op == "wait_stationary":
            keywords = {"cancellation": self.cancellations[a["cancellation"]]} if "cancellation" in a else {}
            return robot.wait_stationary(self.observation(a.get("observation")), **keywords)
        if op == "observe":
            observation = robot.observe()
            self.observations[a["as"]] = observation
            return self.observation_record(observation)
        if op == "model_state":
            joints = self.observations[a["observation"]]["joint_positions"] if "observation" in a else decoded(a["joints"])
            return robot.model_state(joints, a.get("format", FORMAT_NAME)).model_dump(mode="json")
        if op == "execute":
            keywords: dict[str, Any] = {}
            if "reference" in a:
                keywords["reference_observation"] = self.observation(a["reference"])
            if "timeout_s" in a:
                keywords["timeout_s"] = decoded(a["timeout_s"])
            if "cancellation" in a:
                keywords["cancellation"] = self.cancellations[a["cancellation"]]
            progress = self.side.setdefault("progress", [])
            keywords["report_progress"] = lambda phase: progress.append(phase.value)
            return self.result_record(robot.execute(decoded(a["action"]), **keywords))
        if op == "home":
            return self.home(a)
        if op == "stop":
            return robot.stop()
        if op == "recover":
            keywords = {}
            if "timeout_s" in a:
                keywords["timeout_s"] = decoded(a["timeout_s"])
            if "cancellation" in a:
                keywords["cancellation"] = self.cancellations[a["cancellation"]]
            return robot.recover(**keywords)
        if op == "check_fault":
            return robot.check_fault()
        if op == "failure_result":
            keywords = {"format_name": a.get("format", FORMAT_NAME)}
            if "status" in a:
                keywords["status"] = MotionStatus(a["status"])
            snapshot = a.get("snapshot")
            if snapshot == "status":
                keywords["snapshot"] = robot.status(with_snapshot=True)
            elif snapshot == "brief":
                keywords["snapshot"] = robot.status()
            elif snapshot is not None:
                keywords["snapshot"] = self.observations[snapshot]["control_snapshot"]
            return self.result_record(robot.failure_result(make_error(a["error"]), **keywords))
        if op == "is_holding":
            return robot.is_holding(self.observation(a["observation"]))
        if op == "wait_settled":
            return robot.wait_settled(decoded(a["timeout_s"]))
        if op == "hold":
            # what PEAR's turn loop does while the model works: once a control period, whether the arm still holds
            # the observed pose
            held = self.side.setdefault("held", [])
            for _ in range(a["ticks"]):
                held.append(robot.is_holding(self.observation(a["observation"])))
                time.sleep(self.period_s)
            return None
        if op == "idle":
            for _ in range(a["ticks"]):
                time.sleep(self.period_s)
            return None
        if op == "idle_until":
            # control periods until the robot's status is one of some
            for count in range(a.get("most", 500)):
                if robot.status()["status"] in a["statuses"]:
                    return count
                time.sleep(self.period_s)
            raise AssertionError(f"{self.name}: still {robot.status()} after {a.get('most', 500)} control periods")
        if op == "stall":
            # the station is held up: one sleep of that long, after which the control loop steps once
            time.sleep(a["seconds"])
            return None
        if op == "arm":
            # the stand-in arm changed, as a test changes it
            arm = self.arm()
            for name, value in a["set"].items():
                if name == "velocity":
                    # every reading shows this velocity from now on (None: the arm's own readings again), as the
                    # pushed arm of tools/fixtures/agent_fixtures.py: the stand-in arm itself always reads at rest
                    read = self.arm_reads.setdefault(id(arm), arm.read)
                    if value is None:
                        arm.read = read
                    else:

                        def moving(read: Any = read, velocity: tuple[float, ...] = tuple(value)) -> Any:
                            state = read()
                            return type(state)(state.position, velocity, state.sampled_monotonic_s, state.sample_id)

                        arm.read = moving
                    continue
                if name == "failure":
                    value = None if value is None else make_error(value)
                elif name == "response":
                    value = Responses.make(value)
                elif name == "position":
                    value = tuple(float(coordinate) for coordinate in value)
                setattr(arm, name, value)
            return None
        if op == "arm_shift":
            # the arm rests elsewhere than its command put it
            arm = self.arm()
            position = list(arm.position)
            position[a["index"]] += a["delta"]
            arm.position = tuple(position)
            return None
        if op == "new_cancellation":
            self.cancellations[a["name"]] = threading.Event()
            return None
        if op == "cancel":
            self.cancellations[a["name"]].set()
            return None
        if op == "advance_generation":
            # another operation took the arm (as the control loop's own stop in a HOLD does)
            with robot.control_loop.lock:
                robot.control_loop.generation += 1
            return None
        if op == "change_session":
            robot.session_id = a["session_id"]
            return None
        if op == "loop_move":
            # the control loop moved by hand, as PEAR's tests put the arm somewhere
            targets = list(robot.control_loop.targets[ARM])
            for index, value in a.get("set", {}).items():
                targets[int(index)] = value
            for index, value in a.get("add", {}).items():
                targets[int(index)] += value
            return robot.control_loop.move({ARM: targets})
        if op == "loop_wait_for_hold":
            return robot.control_loop.wait_for_hold(a["timeout_s"])
        if op == "loop_recover":
            # the control loop recovered by hand, as a maintenance command does: the robot's own record of the last
            # failed action stays
            return robot.control_loop.recover()
        if op == "plan":
            action = robot.ACTION_ADAPTER.validate(decoded(a["action"]))
            deadline = None if a.get("deadline_in") is None else time.monotonic() + a["deadline_in"]
            prepared = robot.plan(self.observation(a["observation"]), action, deadline=deadline)
            return {"gripper_request": prepared.gripper_request, "move": Moves.record(prepared.move)}
        if op == "operate_grippers":
            deadline = None if a.get("deadline_in") is None else time.monotonic() + a["deadline_in"]
            return robot.operate_grippers(
                a["request"], observation=self.observation(a["observation"]), guard=ActionGuard(robot.control_loop), deadline=deadline
            )
        if op == "hold_snapshot":
            return robot.hold_snapshot(self.observation(a.get("observation")))
        if op == "verify_observation":
            return robot.verify_observation(self.observation(a["observation"]))
        if op == "camera":
            self.wrist.apply(a)
            if "on_read" in a:
                # what the script does once, during the camera's next read (kept with the step that reads)
                operations = a["on_read"]

                def on_read() -> None:
                    self.side.setdefault("read_hooks", []).extend(self.hooked(operation) for operation in operations)

                self.wrist.on_read = on_read
            return None
        if op == "facts":
            return {
                "session_id": robot.session_id,
                "control_period_s": robot.control_period_s,
                "action_mode": robot.action_mode.value,
                "has_kinematics": robot.kinematics is not None,
                "last_error_diagnostics": plain(robot.last_error_diagnostics),
                "rate_hz": robot.control_config.rate_hz,
                "position_tolerance": robot.robot_config.position_tolerance,
            }
        raise AssertionError(f"unknown step {op}")

    def home(self, a: dict[str, Any]) -> Any:
        robot = self.robot
        plans = self.side.setdefault("plans", [])
        stages = self.side.setdefault("stages", [])
        approve = a.get("approve", True)
        started = time.monotonic()

        def approve_plan(plan: dict[str, Any]) -> Any:
            plans.append(plain(plan))
            if approve == "late":
                # the operator answers once only half of the plan's estimated time is left
                # (test_late_approval_sends_nothing)
                left = plan["operation_seconds_estimate"] / 2
                time.sleep(max(0.0, started + a["timeout_s"] - left - time.monotonic()))
                return True
            if approve == "raises":
                raise RuntimeError("the review failed")
            if isinstance(approve, dict):
                for _ in range(approve.get("review_ticks", 0)):  # the operator reads the plan for some control periods
                    time.sleep(self.period_s)
                plan.update(decoded(approve.get("writes", {})))  # a caller that writes into the plan it was handed
                return approve["answer"]
            return approve

        def report(progress: dict[str, Any]) -> None:
            stages.append(plain(progress))
            # what the script does during the report of a stage (the caller's handler runs in Home's thread)
            for operation in a.get("on_stage", {}).get(progress["stage"], ()):
                self.side.setdefault("stage_hooks", []).append(self.hooked(operation))

        keywords: dict[str, Any] = {"report_progress": report}
        if approve != "unasked":
            keywords["approve_plan"] = approve_plan
        if "timeout_s" in a:
            keywords["timeout_s"] = decoded(a["timeout_s"])
        if "cancellation" in a:
            keywords["cancellation"] = self.cancellations[a["cancellation"]]
        return robot.home(**keywords)

    # -- what a script is made of

    def delta(self, width: float = 0.0, **arm: float) -> dict[str, Any]:
        return {"type": "single_arm_delta", "arm": {**ZERO, **arm}, "gripper": {"width": width}}

    def turn(self, action: dict[str, Any], *, hold: int = 2, hooks: Sequence[dict[str, Any]] = (), **arguments: Any) -> dict[str, Any]:
        """The calls PEAR's turn loop makes of the robot for one turn: it waits for the arm at rest, observes, reads
        the model's state, waits for the hold of the observation, watches the hold while the model works, and has
        the robot execute the answer's action from the observation."""
        self.do("wait_stationary")
        self.do("observe", **{"as": "turn"})
        self.do("model_state", observation="turn")
        self.do("wait_stationary", observation="turn")
        if hold:
            self.do("hold", observation="turn", ticks=hold)
        return self.do("execute", hooks=hooks, action=action, reference="turn", **arguments)

    def enable(self) -> None:
        self.do("open")
        self.do("wait_stationary")


class Catalogue:
    """The sessions: every scenario of PEAR's own tests of the SO-101 as one robot, what a task does turn after
    turn, and generated ones."""

    LONG = dict(x=-8.0, z=-6.0)  # an action long enough to be interrupted on its way (PEAR's tests' long_action)

    def __init__(self, scale: int) -> None:
        self.scale = scale
        self.sessions: list[dict[str, Any]] = []

    def begin(self, name: str, source: str, about: str, station: str, **rig: Any) -> Session:
        print(f"session {len(self.sessions) + 1}: {name}", file=sys.stderr)
        return Session(name, source, about, station, **rig)

    def keep(self, session: Session) -> None:
        self.sessions.append(session.result())

    def all(self, chosen: str | None = None) -> list[dict[str, Any]]:
        """Returns every session; with `chosen`, those of the groups whose name holds it (while working)."""
        groups = (
            self.of_the_contract,
            self.of_the_so101_robot,
            self.of_the_so101_motion,
            self.of_the_so101_format,
            self.of_a_task,
            self.of_interruptions,
            self.of_faults,
            self.of_the_cameras,
            self.of_a_closed_robot,
            self.of_other_actions,
            self.of_home,
            self.generated,
            self.of_guards,
        )
        for group in groups:
            if chosen is None or chosen in group.__name__:
                group()
        return self.sessions

    # -- test_robot_in_station.py: what every robot must do

    def of_the_contract(self) -> None:
        source, station = "test_robot_in_station.py", "so101_contract"
        sample = {"type": "single_arm_delta", "arm": {**ZERO, "z": 1.0}, "gripper": {"width": 0.0}}
        long_action = {"type": "single_arm_delta", "arm": {**ZERO, **self.LONG}, "gripper": {"width": 0.0}}

        s = self.begin("test_constructing_opens_nothing", source, "a robot that was made and not opened", station)
        s.do("status")
        s.do("facts")
        s.do("observe", **{"as": "o"})
        self.keep(s)

        s = self.begin("test_status_and_observation_have_the_contract_shape", source, "the brief status, the status with its snapshot and an observation", station)
        s.enable()
        s.do("status")
        s.do("status", with_snapshot=True)
        s.do("observe", **{"as": "o"})
        self.keep(s)

        s = self.begin("test_a_robot_opens_ready_with_a_session_and_closes_off_without_one", source, "open, ready, closed", station)
        s.do("open")
        s.do("wait_stationary")
        s.do("status")
        s.do("facts")
        s.do("close")
        s.do("status")
        s.do("facts")
        self.keep(s)

        s = self.begin("test_an_observation_carries_its_session_and_a_held_pose", source, "an observation and the hold it is of", station)
        s.enable()
        s.do("observe", **{"as": "o"})
        s.do("is_holding", observation="o")
        self.keep(s)

        s = self.begin("test_an_action_completes_settled_at_its_target", source, "a small lift", station)
        s.enable()
        s.do("execute", action=sample)
        s.do("status")
        self.keep(s)

        s = self.begin("test_an_action_based_on_an_observation_from_before_another_action_is_rejected", source, "an old observation", station)
        s.enable()
        s.do("observe", **{"as": "o"})
        s.do("execute", action=sample)
        s.do("execute", action=sample, reference="o")
        self.keep(s)

        s = self.begin("test_a_stop_during_an_action_fails_it_and_ends_in_a_settled_hold", source, "a stop while the arm moves", station)
        s.enable()
        s.do("execute", action=long_action, hooks=[{"tick": 3, "do": [{"op": "stop"}]}])
        s.do("wait_settled", timeout_s=10.0)
        s.do("status")
        s.do("status", with_snapshot=True)
        self.keep(s)

        s = self.begin("test_stale_feedback_faults_the_station_and_recover_makes_it_ready", source, "stale readings, then a recovery", station)
        s.enable()
        s.do("arm", set={"is_stale": True})
        s.do("idle_until", statuses=["FAULT"])
        s.do("check_fault")
        s.do("arm", set={"is_stale": False})
        s.do("recover")
        s.do("check_fault")
        s.do("status")
        self.keep(s)

        s = self.begin(
            "test_a_refused_home_review_fails_before_anything_moves_and_an_approved_home_returns_its_plan_and_report",
            source, "Home refused, then approved", station,
        )  # fmt: skip
        s.enable()
        s.do("execute", action=sample)
        s.do("home", approve=False)
        s.do("home", approve=True)
        s.do("status")
        self.keep(s)

        s = self.begin("test_a_cancel_during_an_action_fails_it_as_paused_and_ends_in_a_settled_hold", source, "the operator's pause while the arm moves", station)
        s.enable()
        s.do("new_cancellation", name="pause")
        s.do("execute", action=long_action, cancellation="pause", hooks=[{"tick": 3, "do": [{"op": "cancel", "name": "pause"}]}])
        s.do("wait_settled", timeout_s=10.0)
        s.do("status")
        self.keep(s)

        s = self.begin(
            "test_the_model_state_has_the_parts_of_each_format_and_a_failure_is_a_failed_result_carrying_the_error",
            source, "the model's state and a failure's result", station,
        )  # fmt: skip
        s.enable()
        s.do("observe", **{"as": "o"})
        s.do("model_state", observation="o")
        s.do("failure_result", error={"type": "RuntimeError", "message": "injected"})
        self.keep(s)

    # -- test_so101_robot_in_station.py

    def of_the_so101_robot(self) -> None:
        source, station = "test_so101_robot_in_station.py", "so101_quick"

        s = self.begin("test_pose_action_completes_and_reports_the_model_state", source, "a pose delta on three quantities", station)
        s.enable()
        s.do("observe", **{"as": "before"})
        s.do("model_state", observation="before")
        s.do("execute", action=s.delta(x=-8.0, z=-6.0, pitch=0.6))
        self.keep(s)

        s = self.begin("test_the_gripper_closes_opens_and_stops_on_an_object", source, "the jaw closes, opens, and stops on an object", station)
        s.enable()
        s.do("execute", action=s.delta(-1.0))
        s.do("execute", action=s.delta(1.0))
        s.do("arm", set={"blocked_gripper_opening": 0.4})
        s.do("execute", action=s.delta(-1.0))
        s.do("execute", action=s.delta(z=2.0))
        self.keep(s)

        s = self.begin("test_unreachable_action_is_rejected_without_motion", source, "an increment out of reach", station)
        s.enable()
        s.do("execute", action=s.delta(x=40.0))
        self.keep(s)

        s = self.begin("test_planning_past_the_deadline_is_refused", source, "planning after the action's deadline", station)
        s.enable()
        s.do("observe", **{"as": "o"})
        s.do("plan", observation="o", action=s.delta(z=1.0), deadline_in=-1.0)
        s.do("plan", observation="o", action=s.delta(z=1.0), deadline_in=None)
        s.do("plan", observation="o", action=s.delta(z=1.0), deadline_in=5.0)
        self.keep(s)

        s = self.begin("test_home_requires_approval_and_opens_the_gripper_first", source, "Home from away with a closed gripper", station)
        s.enable()
        s.do("execute", action=s.delta(-1.0, x=-5.0))
        s.do("home", approve=False)
        s.do("home", approve=True)
        s.do("observe", **{"as": "o"})
        self.keep(s)

        s = self.begin("test_joint_mode_runs_sequences_only", source, "a robot in joint mode", station, action_mode="joint")
        s.enable()
        observation = s.do("observe", **{"as": "o"})["out"]["ok"]
        start = observation["joint_positions"]
        rows = [start[:1] + [float(value)] + start[2:] for value in np.linspace(0, 0.2, 5)]
        s.do("execute", action={"type": "joint_positions", "positions": rows, "rate_hz": 25})
        s.do("execute", action=s.delta(z=1.0))
        s.do("facts")
        s.do("model_state", observation="o")
        s.do("failure_result", error={"type": "RuntimeError", "message": "injected"})
        self.keep(s)

    # -- test_so101_motion_in_station.py

    def of_the_so101_motion(self) -> None:
        source, station = "test_so101_motion_in_station.py", "so101_quick"

        s = self.begin("test_expired_deadline_sends_no_gripper_command", source, "a gripper operation past the action's deadline", station)
        s.enable()
        s.do("observe", **{"as": "o"})
        s.do("operate_grippers", request=False, observation="o", deadline_in=-1.0)
        self.keep(s)

        s = self.begin("test_home_at_home_sends_nothing_and_verifies_the_pose", source, "Home at Home", station)
        s.enable()
        s.do("home", approve=True)
        self.keep(s)

        s = self.begin("test_path_beyond_a_limit_is_rejected_before_opening", source, "a Home that would end past a limit", "so101_home_at_limit")
        s.enable()
        s.do("loop_move", set={"0": 0.0, "5": 0.5})
        s.do("loop_wait_for_hold", timeout_s=5)
        s.do("arm_shift", index=0, delta=0.1)  # the arm rests 0.1 rad past its command
        s.do("idle", ticks=3)
        s.do("observe", **{"as": "o"})
        s.do("home", approve=True)
        self.keep(s)

        s = self.begin("test_home_opens_the_gripper_before_the_arm_returns", source, "Home opens, then returns", station)
        s.enable()
        s.do("loop_move", set={"0": 0.3, "5": 0.2})
        s.do("loop_wait_for_hold", timeout_s=5)
        s.do("home", approve=True)
        self.keep(s)

        s = self.begin("test_late_approval_sends_nothing", source, "a Home approved too late", station)
        s.enable()
        s.do("loop_move", set={"0": 0.3, "5": 0.2})
        s.do("loop_wait_for_hold", timeout_s=5)
        s.do("home", approve="late", timeout_s=2.0)
        s.do("status", with_snapshot=True)
        self.keep(s)

        s = self.begin("test_inaccurate_home_fails", source, "an arm that rests off Home", "so101_short_arrival")
        s.enable()
        s.do("loop_move", add={"2": 0.3})
        s.do("loop_wait_for_hold", timeout_s=5)
        sag = STATIONS.made["so101_short_arrival"][1].home.joint_tolerance[2] + 0.01
        # the elbow rests past every goal by more than Home's tolerance
        s.do("arm", set={"response": {"kind": "sag", "sag": [0.0, 0.0, -sag, 0.0, 0.0], "friction": [0.0] * 5}})
        s.do("home", approve=True)
        self.keep(s)

        s = self.begin(
            "test_an_interrupted_execution_is_not_reported_as_completed", source,
            "a stop right after the action's move was dispatched", "so101_arm_home", cameras="drawn",
        )  # fmt: skip
        s.enable()
        s.turn(s.delta(z=0.3), hooks=[{"on": "dispatch", "do": [{"op": "stop"}]}])
        self.keep(s)

        s = self.begin("test_gravity_sag_does_not_accumulate_over_steps", source, "an elbow that settles short of every goal", station)
        s.enable()
        s.do("execute", action=s.delta(x=-8.0, z=-6.0, pitch=0.6))
        # the elbow settles 0.01 rad off each goal, as under gravity
        s.do("arm", set={"response": {"kind": "sag", "sag": [0.0, 0.0, -0.01, 0.0, 0.0], "friction": [0.0] * 5}})
        s.do("execute", action=s.delta(x=0.5))
        s.do("observe", **{"as": "o"})
        s.do("model_state", observation="o")
        for change in (1.0, -1.0) * 3:
            s.do("execute", action=s.delta(x=change))
        s.do("observe", **{"as": "o"})
        s.do("model_state", observation="o")
        self.keep(s)

    # -- test_so101_formats_in_station.py: the turns of a model session, as its loop calls the robot

    def of_the_so101_format(self) -> None:
        source, station = "test_so101_formats_in_station.py", "so101_arm_home"

        s = self.begin("test_round_trip_moves_the_arm_and_feeds_back", source, "two turns that lift the arm", station, cameras="drawn")
        s.enable()
        s.turn(s.delta(z=1.0))
        s.turn(s.delta(z=1.0))
        s.do("observe", **{"as": "o"})
        self.keep(s)

        s = self.begin("test_gripper_outcome_is_fed_back", source, "a turn that closes the gripper, and the next", station, cameras="drawn")
        s.enable()
        s.turn(s.delta(-1.0))
        s.turn(s.delta())
        self.keep(s)

        s = self.begin("test_unreachable_action_is_rejected_and_fed_back", source, "a turn out of reach, and the next", station, cameras="drawn")
        s.enable()
        s.turn(s.delta(x=60.0))
        s.turn(s.delta())
        self.keep(s)

    # -- beyond PEAR's tests: the shipped settings, turn after turn

    def of_a_task(self) -> None:
        source, station = "beyond PEAR's tests", "so101_station"

        s = self.begin("a short session", source, "enable, one turn that lifts the arm 2 cm, disable", station, cameras="drawn")
        s.do("status")
        s.enable()
        s.do("status")
        s.turn(s.delta(z=2.0), hold=10)
        s.do("wait_stationary")
        s.do("observe", **{"as": "o"})
        s.do("model_state", observation="o")
        s.do("close")
        s.do("status")
        self.keep(s)

        s = self.begin("each quantity alone", source, "every axis in both directions, pitch and roll", station, cameras="drawn")
        s.enable()
        for change in (
            dict(x=1.0), dict(x=-1.0), dict(y=1.0), dict(y=-1.0), dict(z=1.0), dict(z=-1.0),
            dict(z=-6.0), dict(x=-6.0), dict(y=5.0), dict(z=4.0), dict(pitch=0.05), dict(pitch=-0.05), dict(roll=0.5),
            dict(roll=-0.5), dict(pitch=-0.7), dict(roll=3.0),
        ):  # fmt: skip
            s.turn(s.delta(**change))
        self.keep(s)

        s = self.begin("several quantities at once, and none", source, "combined increments, a zero increment, the gripper", station, cameras="drawn")
        s.enable()
        s.turn(s.delta(x=-2.0, y=1.5, z=1.0))
        s.turn(s.delta(x=1.0, y=-1.0, z=0.5, pitch=0.2, roll=-0.3))
        s.turn(s.delta())  # a zero increment: nothing moves
        s.turn(s.delta(-1.0))  # the gripper closes on nothing
        s.turn(s.delta(1.0))  # and opens
        s.turn(s.delta(-1.0, x=-3.0))  # an arm move with a gripper command
        s.turn(s.delta(0.5, z=1.0))
        s.turn(s.delta(1.0))  # opening an open gripper
        self.keep(s)

        s = self.begin("what the planning refuses", source, "increments out of reach, past the rotation bound and past the joint limits", station, cameras="drawn")
        s.enable()
        for change in (dict(x=40.0), dict(y=-45.0), dict(z=30.0), dict(pitch=2.5), dict(roll=4.0), dict(pitch=-3.5), dict(x=200.0, z=5.0)):
            s.turn(s.delta(**change))
        s.turn(s.delta(-1.0, x=40.0))  # out of reach: the gripper does not move either
        s.turn(s.delta(z=1.0))
        self.keep(s)

        s = self.begin("the jaw stops on an object", source, "closing stops on an object; the arm lifts it and lets it go", "so101_quick_home", cameras="drawn")
        s.enable()
        s.turn(s.delta(z=-2.0))
        s.do("arm", set={"blocked_gripper_opening": 0.35})
        s.turn(s.delta(-1.0))
        s.turn(s.delta(z=3.0))
        s.turn(s.delta(-1.0))  # closing again on the object
        s.do("arm", set={"blocked_gripper_opening": None})
        s.turn(s.delta(1.0))
        s.turn(s.delta(-1.0))
        self.keep(s)

    def of_interruptions(self) -> None:
        source, station = "beyond PEAR's tests", "so101_station"
        pause = {"type": "OperatorPaused", "message": CONSOLE_PAUSE}

        def console_pause(s: Session) -> None:
            # what PEAR's console does after a paused turn: it stops, reads the status, waits for the arm to settle
            # and records the pause, which the next turn reports
            s.do("stop")
            s.do("failure_result", error={"type": "OperatorPaused", "message": "Operation interrupted by the operator"})
            s.do("status", with_snapshot=True)
            s.do("status")
            s.do("wait_settled", timeout_s=10.0)
            s.do("failure_result", error=pause)

        s = self.begin("the operator pauses", source, "a pause during a move, while the model works, during a gripper operation and while the arm settles", station, cameras="drawn")
        s.enable()
        s.do("new_cancellation", name="pause")
        s.turn(s.delta(**self.LONG), cancellation="pause", hooks=[{"tick": 20, "do": [{"op": "cancel", "name": "pause"}, {"op": "stop"}]}])
        console_pause(s)
        s.do("new_cancellation", name="pause")
        s.turn(s.delta(z=1.0), cancellation="pause")
        # while the model works: the hold is watched, the cancellation set, and the robot stopped
        s.do("wait_stationary")
        s.do("observe", **{"as": "turn"})
        s.do("model_state", observation="turn")
        s.do("wait_stationary", observation="turn", cancellation="pause")
        s.do("hold", observation="turn", ticks=4, hooks=[{"tick": 2, "do": [{"op": "cancel", "name": "pause"}, {"op": "stop"}]}])
        s.do("wait_stationary", observation="turn", cancellation="pause")
        console_pause(s)
        s.do("new_cancellation", name="pause")
        s.turn(s.delta(-1.0), cancellation="pause", hooks=[{"tick": 30, "do": [{"op": "cancel", "name": "pause"}, {"op": "stop"}]}])
        console_pause(s)
        s.do("new_cancellation", name="pause")
        # the cancellation alone, without the console's stop: the loop's own check ends the move
        s.turn(s.delta(z=-2.0), cancellation="pause", hooks=[{"tick": 12, "do": [{"op": "cancel", "name": "pause"}]}])
        console_pause(s)
        s.do("new_cancellation", name="pause")
        s.turn(s.delta(1.0, z=1.0), cancellation="pause")
        self.keep(s)

        s = self.begin("stops", source, "a stop during a move, during the settling, during a gripper operation and in a hold", "so101_quick_home")
        s.enable()
        s.turn(s.delta(**self.LONG), hooks=[{"tick": 4, "do": [{"op": "stop"}]}])
        s.do("status")
        s.do("wait_settled", timeout_s=10.0)
        s.turn(s.delta(z=0.5), hooks=[{"tick": 9, "optional": True, "do": [{"op": "stop"}]}])
        s.do("wait_settled", timeout_s=10.0)
        s.turn(s.delta(-1.0), hooks=[{"tick": 6, "do": [{"op": "stop"}]}])
        s.do("wait_settled", timeout_s=10.0)
        s.do("observe", **{"as": "o"})
        s.do("stop")  # in a hold: it invalidates the observation
        s.do("is_holding", observation="o")
        s.do("execute", action=s.delta(z=1.0), reference="o")
        s.turn(s.delta(z=1.0))
        s.do("wait_settled", timeout_s=0.0)
        s.do("wait_settled", timeout_s=-1.0)
        self.keep(s)

        s = self.begin("an action already runs", source, "a second action, a recovery and a Home asked for while an action runs", "so101_quick_home")
        s.enable()
        nested = [
            {"op": "execute", "action": s.delta(z=1.0)},
            {"op": "recover"},
            {"op": "home", "approve": True},
            {"op": "status"},
            {"op": "is_holding", "observation": "turn"},
            {"op": "check_fault"},
        ]
        s.turn(s.delta(x=-4.0), hooks=[{"tick": 3, "do": nested}])
        s.turn(s.delta(z=1.0))
        self.keep(s)

        s = self.begin("timeouts", source, "an action's own timeout, and timeouts that are none", "so101_station")
        s.enable()
        s.do("execute", action=s.delta(x=-6.0), timeout_s=0.3)
        s.do("status", with_snapshot=True)
        s.do("wait_settled", timeout_s=10.0)
        for timeout_s in (0, -1.0, {"$": "nan"}, {"$": "inf"}):
            s.do("execute", action=s.delta(z=1.0), timeout_s=timeout_s)
        s.do("execute", action=s.delta(z=1.0), timeout_s=30.0)
        s.do("home", approve=True, timeout_s=0)
        s.do("home", approve=True, timeout_s=0.5)
        s.do("recover", timeout_s=1.0)
        self.keep(s)

        s = self.begin(
            "deadlines at their bound", source,
            "planning with no time left, next to none, none and enough; a gripper operation on a hold that is no longer settled",
            "so101_quick_home",
        )  # fmt: skip
        s.enable()
        s.do("observe", **{"as": "o"})
        for deadline_in in (0.0, 1e-9, -0.5, 30.0, None):
            s.do("plan", observation="o", action=s.delta(z=1.0), deadline_in=deadline_in)
        s.do("operate_grippers", observation="o", request=False, deadline_in=0.0)
        # a gripper operation asked for while the arm brakes after a stop, and while its hold has not settled yet:
        # at every control period after the stop, an observation and the operation from it
        s.turn(s.delta(**self.LONG), hooks=[{"tick": 3, "do": [{"op": "stop"}]}])
        for _ in range(2):
            s.do("observe", **{"as": "o"})
            s.do("operate_grippers", observation="o", request=False, deadline_in=None)
            s.do("idle", ticks=1)
        s.do("wait_settled", timeout_s=10.0)
        # and on a hold whose readings show the arm moving: after one control period the window's mean is still
        # below the bound, after three it is not, and the arm holds the observation's operation unsettled
        velocity = [0.0, 0.2, 0.0, 0.0, 0.0, 0.0]
        s.do("arm", set={"velocity": velocity})
        s.do("idle", ticks=1)
        s.do("status", with_snapshot=True)
        s.do("idle", ticks=2)
        s.do("status", with_snapshot=True)
        s.do("observe", **{"as": "o"})
        s.do("is_holding", observation="o")
        s.do("operate_grippers", observation="o", request=False, deadline_in=None)
        s.do("status")
        s.do("observe", **{"as": "o"})
        s.do("execute", action=s.delta(z=1.0), reference="o")
        s.do("status", with_snapshot=True)
        s.do("arm", set={"velocity": None})
        s.do("idle_until", statuses=["READY", "FAULT"])
        s.do("status")
        self.keep(s)

        s = self.begin(
            "a station without geometry", source, "a Cartesian robot that cannot open: nothing stays open", "so101_no_geometry"
        )
        s.do("open")
        s.do("status")
        s.do("facts")
        s.do("open")
        s.do("close")
        self.keep(s)

        s = self.begin(
            "a station without geometry, in joint mode", source,
            "the same station opens in joint mode: no state for a model, no pose delta, and a chunk that outruns the control loop",
            "so101_no_geometry", action_mode="joint",
        )  # fmt: skip
        s.enable()
        s.do("facts")
        start = s.do("observe", **{"as": "o"})["out"]["ok"]["joint_positions"]
        s.do("model_state", observation="o")
        s.do("execute", action=s.delta(z=1.0))
        s.do("failure_result", error={"type": "RuntimeError", "message": "the run ended"})
        rows = [[start[0] + 0.01 * (row + 1), *start[1:]] for row in range(40)]
        s.do("observe", **{"as": "o"})  # (the rejected action's stop made the first observation another operation's)
        s.do("execute", action={"type": "joint_positions", "positions": rows, "rate_hz": 500.0}, reference="o")
        s.do("status", with_snapshot=True)
        s.do("wait_settled", timeout_s=10.0)
        s.do("observe", **{"as": "o"})
        s.do("execute", action={"type": "joint_positions", "positions": rows[:5], "rate_hz": 10.0}, reference="o")
        self.keep(s)

        # an arm whose readings never show it at rest (a velocity on one joint from the action's first control period
        # on): the control loop itself gives up once its settle timeout has passed, long before the action's own
        # wait for the arm's rest would (that wait's margin never decides while the loop is stepped)
        moving = {"tick": 1, "do": [{"op": "arm", "set": {"velocity": velocity}}]}
        s = self.begin("an arm that never comes to rest", source, "a move that never settles: the control loop faults", "so101_quick_home")
        s.enable()
        s.turn(s.delta(z=1.0))
        s.do("execute", action=s.delta(z=1.0), hooks=[moving])
        s.do("status", with_snapshot=True)
        s.do("arm", set={"velocity": None})
        s.do("idle", ticks=10)
        s.do("status", with_snapshot=True)
        s.do("loop_recover")  # by the control loop itself: the robot still holds what the failed action recorded
        s.do("facts")
        s.turn(s.delta(z=1.0))  # an action that completes forgets it
        s.do("facts")
        self.keep(s)

        s = self.begin(
            "Home approved late and paused", source,
            "the operator pauses during a review that also ends too late: the pause is what Home ends with", "so101_quick_home",
        )  # fmt: skip
        s.enable()
        s.turn(s.delta(z=1.0))
        s.do("new_cancellation", name="pause")
        s.do("home", approve="late", timeout_s=30.0, cancellation="pause", hooks=[{"tick": 1, "do": [{"op": "cancel", "name": "pause"}]}])
        s.do("status")
        s.do("home", approve="late", timeout_s=30.0)
        s.do("status")
        self.keep(s)

        s = self.begin(
            "Home with a joint exactly at its tolerance", source,
            "a joint that rests exactly as far from Home as Home allows, and one double further", "so101_short_arrival",
        )  # fmt: skip
        s.enable()
        for offset in (0.035, math.nextafter(0.035, 1)):
            s.do("arm", set={"position": [offset, 0.0, 0.0, 0.0, 0.0, 1.0]})
            s.do("idle", ticks=8)
            s.do("status", with_snapshot=True)
            s.do("home", approve=True)
            s.do("status")
        self.keep(s)

        s = self.begin(
            "a sequence on an arm that never comes to rest", source, "a chunk of joint targets that never settles: the control loop faults",
            "so101_quick_home", action_mode="joint",
        )  # fmt: skip
        s.enable()
        start = s.do("observe", **{"as": "o"})["out"]["ok"]["joint_positions"]
        rows = [[start[0] + 0.02 * (row + 1), *start[1:]] for row in range(5)]
        s.do("execute", action={"type": "joint_positions", "positions": rows, "rate_hz": 10.0}, reference="o", hooks=[moving])
        s.do("status", with_snapshot=True)
        s.do("arm", set={"velocity": None})
        s.do("idle", ticks=10)
        s.do("status", with_snapshot=True)
        s.do("recover")
        s.do("status")
        self.keep(s)

    def of_faults(self) -> None:
        source = "beyond PEAR's tests"

        def after_fault(s: Session, clear: dict[str, Any]) -> None:
            # what PEAR's console does of a fault: the run ends, the fault is read, a recovery is refused while the
            # fault lasts, then the fault is removed and the recovery succeeds
            s.do("stop")
            s.do("status", with_snapshot=True)
            s.do("status")
            s.do("check_fault")
            s.do("failure_result", error={"type": "RuntimeError", "message": "the run ended"})
            s.do("wait_stationary")
            s.do("observe", **{"as": "faulted"})
            s.do("execute", action=s.delta(z=1.0))
            s.do("recover")
            s.do("arm", set=clear)
            s.do("recover")
            s.do("check_fault")
            s.do("status")
            s.turn(s.delta(z=1.0))

        faults = (
            ("the arm's bus fails during a move", {"failure": {"type": "RuntimeError", "message": "stand-in bus failure"}}, {"failure": None}),
            ("a servo reports a fault during a move", {"failure": {"type": "ServoFault", "message": "Servo error: elbow_flex: overload"}}, {"failure": None}),
            ("the readings go stale during a move", {"is_stale": True}, {"is_stale": False}),
            ("the arm does not follow during a move", {"response": {"kind": "lag", "gain": 0.0}}, {"response": None}),
        )
        for station in ("so101_station", "so101_quick_home"):
            for name, fault, clear in faults:
                s = self.begin(f"{name} ({station})", source, "a fault during a move, a recovery that is refused, one that succeeds, and a move after it", station, cameras="drawn")
                s.enable()
                s.turn(s.delta(z=1.0))
                s.turn(s.delta(**self.LONG), hooks=[{"tick": 8, "do": [{"op": "arm", "set": fault}]}])
                after_fault(s, clear)
                self.keep(s)

        s = self.begin("faults in a hold and during a gripper operation", source, "a pushed arm, a fault while the jaw closes, a jaw that never arrives", "so101_quick_home")
        s.enable()
        s.do("observe", **{"as": "o"})
        s.do("arm_shift", index=1, delta=0.3)  # the arm is pushed further than a joint may be from its target
        s.do("idle", ticks=2)
        s.do("is_holding", observation="o")
        s.do("check_fault")
        s.do("status", with_snapshot=True)
        s.do("recover")
        s.do("status")
        s.turn(s.delta(-1.0), hooks=[{"tick": 5, "do": [{"op": "arm", "set": {"failure": {"type": "ServoFault", "message": "Servo error: gripper: overload"}}}]}])
        s.do("recover")
        s.do("arm", set={"failure": None})
        s.do("recover")
        s.do("arm", set={"response": {"kind": "min_gripper", "limit": 0.6}})  # the jaw opens no further than 0.6
        s.turn(s.delta(1.0))
        s.do("status", with_snapshot=True)
        s.do("arm", set={"response": None})
        s.do("recover")
        s.turn(s.delta(1.0))
        s.do("new_cancellation", name="pause")
        s.do("arm", set={"is_stale": True})
        s.do("idle_until", statuses=["FAULT"])
        s.do("arm", set={"is_stale": False})
        s.do("cancel", name="pause")
        s.do("recover", cancellation="pause")
        s.do("recover", timeout_s=0)
        s.do("recover", timeout_s=4.0)
        s.do("recover")
        self.keep(s)

    def of_the_cameras(self) -> None:
        source, station = "beyond PEAR's tests", "so101_quick_home"

        s = self.begin("the wrist camera's frames", source, "a fresh frame, a stale one, none yet, a reader that stopped", station, cameras="wrist")
        s.enable()
        s.do("observe", **{"as": "o"})  # no frame yet
        s.do("status")
        s.do("camera", frame=3)
        s.do("observe", **{"as": "o"})
        s.do("execute", action=s.delta(z=1.0))  # the frame is older than a frame may be once the action observes
        s.do("status", with_snapshot=True)
        s.do("camera", frame=4)
        s.turn(s.delta(z=1.0), hold=0)
        s.do("camera", frame=5)
        s.do("idle", ticks=12)
        s.do("observe", **{"as": "o"})  # stale: the frame is 0.24 s old
        s.do("camera", frame=6)
        s.do("execute", action=s.delta(-1.0, z=1.0))  # the frame goes stale while the arm moves: the gripper never starts
        s.do("status", with_snapshot=True)
        s.do("camera", frame=7, reading=False)
        s.do("observe", **{"as": "o"})
        s.do("execute", action=s.delta(z=-1.0))
        s.do("camera", frame=8, reading=True)
        s.do("observe", **{"as": "o"})
        s.do("execute", action=s.delta(z=-1.0), reference="o")
        s.do("observe", **{"as": "o"})
        # the session changes while the camera is read
        session_id = s.steps[0]["out"]["ok"]["session_id"]
        s.do("camera", frame=9, on_read=[{"op": "change_session", "session_id": "another-session"}])
        s.do("observe", **{"as": "o"})
        s.do("change_session", session_id=session_id)
        # a camera that raises a ValueError once the action has moved the arm: the action failed, it is not rejected
        s.do("camera", frame=10)
        raises = {"op": "camera", "read_raises": {"type": "ValueError", "message": "the frame is no picture"}}
        s.do("execute", action=s.delta(-1.0, z=1.0), hooks=[{"tick": 1, "do": [raises]}])
        s.do("status", with_snapshot=True)
        s.do("observe", **{"as": "o"})  # before anything moved: the same error, and nothing to stop
        s.do("execute", action=s.delta(z=1.0))  # rejected: the action's own observation raises before a dispatch
        s.do("camera", frame=11, read_raises=None)
        s.do("wait_settled", timeout_s=10.0)
        s.do("observe", **{"as": "o"})
        self.keep(s)

        s = self.begin("a robot without a camera", source, "observations without frames", station)
        s.enable()
        s.do("observe", **{"as": "o"})
        s.do("execute", action=s.delta(-1.0, z=1.0))
        self.keep(s)

    def of_a_closed_robot(self) -> None:
        source, station = "beyond PEAR's tests", "so101_quick_home"

        s = self.begin("what a closed robot refuses", source, "every call of a robot that is closed, and a second session", station, cameras="drawn")
        s.enable()
        s.do("open")  # already open
        s.do("observe", **{"as": "first"})
        s.turn(s.delta(z=1.0))
        s.do("close")
        s.do("close")
        s.do("status")
        s.do("status", with_snapshot=True)
        s.do("facts")
        s.do("observe", **{"as": "o"})
        s.do("wait_stationary")
        s.do("wait_stationary", observation="first")
        s.do("model_state", observation="first")
        s.do("is_holding", observation="first")
        s.do("execute", action=s.delta(z=1.0))
        s.do("execute", action=s.delta(z=1.0), reference="first")
        s.do("home", approve=True)
        s.do("recover")
        s.do("stop")
        s.do("check_fault")
        s.do("wait_settled", timeout_s=1.0)
        s.do("hold_snapshot")
        s.do("verify_observation", observation="first")
        s.do("failure_result", error={"type": "RuntimeError", "message": "injected"})
        s.do("failure_result", error={"type": "RuntimeError", "message": "injected"}, snapshot="first")
        s.do("failure_result", error={"type": "ValueError", "message": "refused"}, status="rejected", snapshot="brief")
        s.do("failure_result", error={"type": "RuntimeError", "message": "injected"}, format="another_format")
        s.do("open")
        s.do("wait_stationary")
        s.do("facts")
        s.do("is_holding", observation="first")  # of the session before
        s.do("execute", action=s.delta(z=1.0), reference="first")
        s.do("wait_stationary", observation="first")
        s.do("hold_snapshot", observation="first")
        s.do("verify_observation", observation="first")
        s.turn(s.delta(z=1.0))
        s.do("model_state", observation="first", format="another_format")
        s.do("model_state", joints=[0.1, 0.2, 0.3, 0.4, 0.5, 0.5])
        self.keep(s)

        s = self.begin("a robot closed under an action", source, "the robot is closed while it moves, while it holds, and its session changes", station, cameras="drawn")
        s.enable()
        s.turn(s.delta(x=-5.0), hooks=[{"tick": 4, "do": [{"op": "close"}]}])
        s.do("status")
        s.do("open")
        s.do("wait_stationary")
        s.do("observe", **{"as": "o"})
        s.do("change_session", session_id="another-session")
        s.do("is_holding", observation="o")
        s.do("execute", action=s.delta(z=1.0), reference="o")
        s.do("observe", **{"as": "o"})
        s.do("advance_generation")
        s.do("wait_stationary", observation="o")
        s.do("execute", action=s.delta(z=1.0), reference="o")
        s.do("execute", action=s.delta(z=1.0))
        self.keep(s)

    def of_other_actions(self) -> None:
        source, station = "beyond PEAR's tests", "so101_station"

        s = self.begin("actions outside the model's format", source, "the gripper action, chunks of joint targets, and what is no action", station, cameras="drawn")
        s.enable()
        s.do("execute", action={"type": "gripper", "command": "close"})
        s.do("execute", action={"type": "gripper", "command": "open"})
        observation = s.do("observe", **{"as": "o"})["out"]["ok"]
        start = observation["joint_positions"]
        rows = [[start[0] + 0.02 * (row + 1), *start[1:]] for row in range(10)]
        s.do("execute", action={"type": "joint_positions", "positions": rows, "rate_hz": 10.0}, reference="o")
        s.do("observe", **{"as": "o"})
        past = [[2.5, *start[1:]]]
        s.do("execute", action={"type": "joint_positions", "positions": past, "rate_hz": 10.0}, reference="o")
        s.do("status", with_snapshot=True)
        s.do("wait_settled", timeout_s=10.0)
        for action in (
            {"type": "single_arm_delta", "arm": {**ZERO, "x": "a"}, "gripper": {"width": 0.5}},
            {"type": "nothing"},
            # (no float of a whole value in what a refusal shows of its input: JavaScript has one number for 0.0 and
            # 0, so pear.js would show the int; whole_float_cases hold what PEAR gives for each of the two)
            {"arm": dict.fromkeys(ZERO, 0.5), "gripper": {"width": 0.5}},
            None,
            {"type": "gripper", "command": "squeeze"},
            {"type": "joint_positions", "positions": [[0.5] * 5], "rate_hz": 0},
            {"type": "single_arm_delta", "arm": {**ZERO, "x": {"$": "nan"}}, "gripper": {"width": 0.5}},
        ):
            s.do("execute", action=action)
        s.do("recover")
        s.do("execute", action=s.delta(z=1.0))
        self.keep(s)

    def of_home(self) -> None:
        source = "beyond PEAR's tests"

        s = self.begin("Home from away", source, "Home with the shipped settings: reviewed for 25 control periods, approved; refused; unasked", "so101_station", cameras="drawn")
        s.enable()
        s.turn(s.delta(-1.0, **self.LONG))
        s.do("home", approve={"review_ticks": 25, "answer": True})
        s.do("status")
        s.turn(s.delta(y=4.0))
        s.do("home", approve={"review_ticks": 25, "answer": False})
        for answer in (1, "yes", None):
            s.do("home", approve=answer)
        s.do("home", approve="raises")
        s.do("home", approve="unasked")
        s.do("home", approve="unasked")  # at Home already
        self.keep(s)

        s = self.begin("Home interrupted", source, "a pause and a stop while Home opens the gripper and while the arm returns", "so101_quick_home")
        s.enable()
        for tick, how in ((4, "cancel"), (4, "stop"), (40, "cancel"), (40, "stop")):
            s.do("execute", action=s.delta(-1.0, x=-5.0))
            s.do("new_cancellation", name="pause")
            operation = {"op": "cancel", "name": "pause"} if how == "cancel" else {"op": "stop"}
            s.do("home", approve=True, cancellation="pause", hooks=[{"tick": tick, "do": [operation]}])
            s.do("status", with_snapshot=True)
            s.do("wait_settled", timeout_s=10.0)
            s.do("home", approve=True)
        s.do("new_cancellation", name="pause")
        s.do("cancel", name="pause")
        s.do("home", approve=True, cancellation="pause")
        self.keep(s)

        s = self.begin("Home that fails", source, "a fault while the arm returns, a jaw that does not open, a robot without a Home", "so101_quick_home")
        s.enable()
        s.do("execute", action=s.delta(x=-5.0))
        s.do("home", approve=True, hooks=[{"tick": 6, "do": [{"op": "arm", "set": {"failure": {"type": "ServoFault", "message": "Servo error: shoulder_lift: overload"}}}]}])
        s.do("arm", set={"failure": None})
        s.do("recover")
        s.do("execute", action=s.delta(-1.0))
        s.do("arm", set={"response": {"kind": "min_gripper", "limit": 0.5}})
        s.do("home", approve=True)
        s.do("status")
        self.keep(s)

        s = self.begin("a robot without a Home", source, "Home asked of a robot whose settings have none", "so101_no_home")
        s.do("home", approve=True)
        s.enable()
        s.do("home", approve=True)
        s.do("home", approve=True, timeout_s=0)
        s.do("execute", action=s.delta(z=1.0))
        self.keep(s)

    def generated(self) -> None:
        rng = random.Random(f"{SEED}:sessions")
        for index in range(4 * self.scale):
            station = rng.choice(["so101_station", "so101_quick_home", "so101_quick", "so101_arm_home"])
            s = self.begin(f"generated {index + 1}", "generated", "turns with generated actions", station, cameras="drawn")
            s.enable()
            planner = PlanningCases(STATIONS, 1)
            for _ in range(rng.randint(8, 14)):
                roll = rng.random()
                if roll < 0.08:
                    s.do("home", approve=rng.random() < 0.8)
                elif roll < 0.16:
                    s.do("arm", set={"blocked_gripper_opening": rng.choice([None, 0.3, 0.55])})
                    s.turn(s.delta(rng.choice([-1.0, 1.0])))
                elif roll < 0.24:
                    s.turn(planner.random_delta(rng), hooks=[{"tick": rng.randint(1, 6), "optional": True, "do": [{"op": "stop"}]}])
                    s.do("wait_settled", timeout_s=10.0)
                else:
                    s.turn(planner.random_delta(rng), hold=rng.randint(0, 3))
                if s.steps[-1]["after"]["status"]["status"] == "FAULT":
                    s.do("recover")
            self.keep(s)

    # -- the guards of motion that no session above reaches (they come last, so that every session above stays as
    # it was written)

    def of_guards(self) -> None:
        source = "beyond PEAR's tests"
        still = [0.0] * GRIPPER_INDEX

        # Home is checked again once the jaw has opened: an arm that was pushed 0.02 rad past its command while the
        # jaw opened would end past the bound that Home lies 0.01 rad inside of; pushed the other way, Home goes on
        s = self.begin(
            "Home with the arm pushed while the jaw opens", source,
            "the base joint rests off its command once the jaw has opened: towards the bound Home lies at (refused), and away from it",
            "so101_home_at_limit",
        )  # fmt: skip
        s.enable()
        for sag in (-0.02, 0.02):
            s.do("loop_move", set={"0": 0.0, "5": 0.2})
            s.do("loop_wait_for_hold", timeout_s=5)
            pushed = {"op": "arm", "set": {"response": {"kind": "sag", "sag": [sag, *still[1:]], "friction": still}}}
            s.do("home", approve=True, hooks=[{"tick": 4, "do": [pushed]}])
            s.do("status", with_snapshot=True)
            s.do("arm", set={"response": None})
            s.do("wait_settled", timeout_s=10.0)
        self.keep(s)

        # a hold that loses its rest between the action's first wait and its dispatch: the readings show a joint
        # moving for three control periods, during the wrist camera's read of the action's observation or during the
        # review of Home's plan. The control loop starts nothing on an unsettled hold of the observation, and the
        # action asks again every control period
        velocity = [0.0, 0.5, 0.0, 0.0, 0.0, 0.0]

        def moving(rests: bool = True) -> list[dict[str, Any]]:
            operations: list[dict[str, Any]] = [{"op": "arm", "set": {"velocity": velocity}}, {"op": "idle", "ticks": 3}]
            return [*operations, {"op": "arm", "set": {"velocity": None}}] if rests else operations

        def chunk(s: Session, frame: int) -> dict[str, Any]:
            s.do("camera", frame=frame)
            start = s.do("observe", **{"as": "o"})["out"]["ok"]["joint_positions"]
            rows = [[start[0] + 0.02 * (row + 1), *start[1:]] for row in range(5)]
            return {"type": "joint_positions", "positions": rows, "rate_hz": 10.0}

        s = self.begin(
            "a dispatch on a hold that has not settled", source,
            "a move, a chunk of joint targets and Home's move wait for the hold to settle again, and start then",
            "so101_quick_home", cameras="wrist",
        )  # fmt: skip
        s.enable()
        s.do("camera", frame=1, on_read=moving())
        s.do("execute", action=s.delta(z=1.0))
        action = chunk(s, 2)
        s.do("camera", frame=3, on_read=moving())
        s.do("execute", action=action)
        s.do("camera", frame=4)
        s.do(
            "home", approve={"review_ticks": 6, "answer": True},
            hooks=[
                {"tick": 2, "do": [{"op": "arm", "set": {"velocity": velocity}}]},
                {"tick": 6, "do": [{"op": "arm", "set": {"velocity": None}}, {"op": "camera", "frame": 5}]},
            ],
        )  # fmt: skip
        s.do("status", with_snapshot=True)
        self.keep(s)

        # the same hold that never settles again. With a deadline the action's wait before its dispatch ends at the
        # deadline; without one that wait and the control loop's own limit of an unsettled hold are the same settle
        # timeout, counted from the same reading of the clock at the earliest, and here the loop faults first
        s = self.begin(
            "a hold that does not settle before a dispatch", source,
            "the action's deadline ends the wait before a dispatch; without a deadline the control loop faults first",
            "so101_quick_home", cameras="wrist",
        )  # fmt: skip
        s.enable()
        frame = 0

        def rest_again(s: Session) -> None:
            s.do("status", with_snapshot=True)
            s.do("arm", set={"velocity": None})
            s.do("idle_until", statuses=["READY", "FAULT"])
            if s.steps[-1]["after"]["status"]["status"] == "FAULT":
                s.do("recover")

        for timeout in ({"timeout_s": 0.3}, {}):
            frame += 1
            s.do("camera", frame=frame, on_read=moving(rests=False))
            s.do("execute", action=s.delta(z=1.0), **timeout)
            rest_again(s)
            frame += 1
            action = chunk(s, frame)
            frame += 1
            s.do("camera", frame=frame, on_read=moving(rests=False))
            s.do("execute", action=action, **timeout)
            rest_again(s)
        # Home: the review of its plan ends with the arm moving, and Home's timeout is over before the hold has
        # settled; away from Home that ends the wait before the move's dispatch, at Home the wait for the arrival
        def reviewed_home(s: Session, frame: int) -> None:
            s.do("camera", frame=frame)
            s.do(
                "home", approve={"review_ticks": 4, "answer": True}, timeout_s=1.0,
                hooks=[{"tick": 2, "do": [{"op": "arm", "set": {"velocity": velocity}}]}, {"tick": 4, "do": [{"op": "camera", "frame": frame + 1}]}],
            )  # fmt: skip
            rest_again(s)

        frame += 1
        action = chunk(s, frame)
        s.do("execute", action=action, reference="o")
        reviewed_home(s, frame + 1)
        s.do("camera", frame=frame + 3)
        s.do("home", approve=True)
        reviewed_home(s, frame + 4)
        self.keep(s)

        # a hold that is unsettled when the action begins: the deadline ends the action's first wait
        s = self.begin(
            "a hold that does not settle before an action's deadline", source,
            "an action and Home begin on a hold that is not at rest, and their deadline passes in their first wait",
            "so101_quick_home",
        )  # fmt: skip
        s.enable()
        for op, arguments in (("execute", {"action": s.delta(z=1.0)}), ("home", {"approve": True})):
            s.do("arm", set={"velocity": velocity})
            s.do("idle", ticks=3)
            s.do(op, timeout_s=0.3, **arguments)
            s.do("status", with_snapshot=True)
            s.do("arm", set={"velocity": None})
            s.do("wait_settled", timeout_s=10.0)
        self.keep(s)

        # the limits of an action's own waits. A stepped control loop ends every operation long before them, so the
        # station is held up for one long sleep while an operation runs. The operations that count control periods
        # go on afterwards (a move, the jaw, a chunk once its last row is handed over): within the limit of the
        # action's wait the action completes, and past the control loop's limit of the operation the loop stops it
        s = self.begin(
            "an action on a station that is held up", source,
            "one long sleep during a move, a chunk of joint targets and the jaw's operation: within the limit of the action's wait, and past the control loop's",
            "so101_quick_home",
        )  # fmt: skip
        s.enable()

        def held_up(tick: int, seconds: float) -> list[dict[str, Any]]:
            return [{"tick": tick, "do": [{"op": "stall", "seconds": seconds}]}]

        def settled(s: Session) -> None:
            s.do("status", with_snapshot=True)
            s.do("wait_settled", timeout_s=10.0)

        # the jaw's wait ends 45 s after its start
        for seconds, command in ((10.0, "close"), (46.0, "open")):
            s.do("execute", action={"type": "gripper", "command": command}, hooks=held_up(3, seconds))
            settled(s)
        # a chunk's wait ends its duration and 30 s after its start (the fifth row is handed over at the 21st period)
        for seconds in (10.0, 31.0):
            start = s.do("observe", **{"as": "o"})["out"]["ok"]["joint_positions"]
            rows = [[start[0] + 0.02 * (row + 1), *start[1:]] for row in range(5)]
            s.do("execute", action={"type": "joint_positions", "positions": rows, "rate_hz": 10.0}, reference="o", hooks=held_up(24, seconds))
            settled(s)
        # a move's wait ends its duration, the settle timeout (1 s) and 5 s after its dispatch
        for seconds, z in ((5.6, 1.0), (6.2, -1.0)):
            s.do("execute", action=s.delta(z=z), hooks=held_up(3, seconds))
            settled(s)
        self.keep(s)

        s = self.begin(
            "Home and a chunk with a caller that interferes", source,
            "a caller that writes into the plan it reviews, that stops and that pauses during Home's last report, a pause "
            "during a chunk of joint targets, and a timeout of exactly the time the plan estimates",
            "so101_quick_home",
        )  # fmt: skip
        s.enable()
        s.do("execute", action=s.delta(z=1.0))
        # Home hands its caller a copy of the plan: what the caller writes into it changes nothing
        writes = {"start_target": [0.0] * 6, "goal_target": [0.0] * 6, "open_gripper": True, "operation_seconds_estimate": 1e9}
        s.do("home", approve={"writes": writes, "answer": True})
        s.do("status", with_snapshot=True)
        # a stop and a pause while the caller is told that Home has completed: Home has not completed
        for operation in ({"op": "stop"}, {"op": "cancel", "name": "pause"}):
            s.do("execute", action=s.delta(z=1.0))
            s.do("new_cancellation", name="pause")
            s.do("home", approve=True, cancellation="pause", on_stage={"completed": [operation]})
            settled(s)
        # the operator pauses while a chunk is streamed (the arm is at Home: the chunk starts at what PEAR holds)
        start = s.do("observe", **{"as": "o"})["out"]["ok"]["joint_positions"]
        rows = [[start[0] + 0.02 * (row + 1), *start[1:]] for row in range(5)]
        s.do("new_cancellation", name="pause")
        s.do(
            "execute", action={"type": "joint_positions", "positions": rows, "rate_hz": 10.0}, reference="o", cancellation="pause",
            hooks=[{"tick": 3, "do": [{"op": "cancel", "name": "pause"}]}],
        )  # fmt: skip
        settled(s)
        # Home is refused when its timeout is exactly the time its plan estimates, and goes on with half a second more
        s.do("execute", action=s.delta(z=1.0))
        estimate = s.do("home", approve=False)["plans"][0]["operation_seconds_estimate"]
        s.do("home", approve=True, timeout_s=estimate)
        s.do("home", approve=True, timeout_s=estimate + 0.5)
        s.do("status", with_snapshot=True)
        self.keep(s)

        # Home's own settle window, longer than the control loop's (they are equal in every station), and a gripper
        # tolerance that a double holds exactly, with a jaw that opens no further than exactly that far from open
        s = self.begin(
            "Home with a settle window of its own and a jaw exactly at its tolerance", source,
            "Home waits and estimates with its own, longer settle window; a jaw that rests exactly its tolerance short of open is open",
            "so101_quick_home", settings={"home": {"settle_window_s": 0.3}, "gripper_tolerance": 0.015625},
        )  # fmt: skip
        s.enable()
        s.do("facts")
        s.do("execute", action=s.delta(-1.0, z=1.0))
        s.do("home", approve=True)
        s.do("execute", action=s.delta(-1.0, z=1.0))
        s.do("arm", set={"response": {"kind": "min_gripper", "limit": 1.0 - 0.015625}})
        s.do("home", approve=True)
        s.do("status", with_snapshot=True)
        self.keep(s)


# ---- part 4: the tasks of the agent loop's fixtures, with their rig ----


class AgentRig:
    """Runs the tasks of tools/fixtures/agent_fixtures.py again (PEAR's StationAgentLoop with its stand-in client on
    its stepped stand-in SO-101), by that script's own classes, and keeps what tests/fixtures/agent/loop.json does
    not hold of the rig: at every step the sleeps and the driver's calls, the UUIDs the robot drew (of its session
    and of every observation, also the ones an action takes itself), the answers of the kinematics, and the robot's
    status with its snapshot at the end. What that fixture does hold must come out the same, which is checked."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.monkeypatch = monkeypatch

    def run(self) -> dict[str, Any]:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import agent_fixtures

        from pear.deploy.station.agent_loop import agent_loop as agent_loop_module
        from pear.deploy.station.agent_loop.clients import schemas as schemas_module

        silence()
        rig = RIG
        clock = rig.new_clock()  # one clock for every task, as in agent_fixtures.py: it is never set back
        seed = agent_fixtures.SEED
        session_ids = agent_fixtures.Ids(seed + 1)
        rig.ids = Ids(seed + 2)  # the robot's: the same sequence as agent_fixtures.py draws
        self.monkeypatch.setattr(agent_loop_module, "uuid4", session_ids.next)
        self.monkeypatch.setattr(schemas_module, "uuid4", session_ids.next)
        self.monkeypatch.setattr(robot_module, "uuid4", rig.ids.next)
        records: list[dict[str, Any]] = []
        current: dict[str, Any] = {}

        def cut() -> dict[str, Any]:
            piece: dict[str, Any] = {"ticks": clock.take(), "io": rig.io.take()}
            for key, value in (("uuids", rig.ids.take()), ("ik", rig.take_ik())):
                if value:
                    piece[key] = value
            return piece

        class RiggedLoopRun(agent_fixtures.LoopRun):
            def logged(self, robot: Any, state: dict[str, Any]) -> None:
                current["robot"] = robot
                current["record"] = {"open": cut(), "steps": []}
                super().logged(robot, state)

            @staticmethod
            def state(session: Any) -> dict[str, Any]:
                robot = current["robot"]
                piece = cut()
                piece["after"] = {
                    "status": plain(robot.status(with_snapshot=True)),
                    "requested": None if robot._control_loop is None else plain(robot.control_loop.requested_position()),
                }
                current["record"]["steps"].append(piece)
                return agent_fixtures.LoopRun.state(session)

        rig.io.take(), rig.take_ik(), rig.log.take()
        with tempfile.TemporaryDirectory() as directory:
            loop_run = RiggedLoopRun(clock, session_ids, rig.ids, Path(directory))
            loops = []
            for scenario in agent_fixtures.LoopScenarios(agent_fixtures.Ids(seed + 3)).all():
                loops.append(loop_run.run(scenario))
                record = current["record"]
                record["name"] = scenario["name"]
                record["close"] = cut()
                records.append({key: record[key] for key in ("name", "open", "steps", "close")})

        committed = json.loads((AGENT_FIXTURES / "loop.json").read_text())["scenarios"]
        again = json.loads(json.dumps(loops))
        same = [name for name, first, second in zip((s["name"] for s in committed), committed, again) if first == second]
        if len(same) != len(committed) or len(again) != len(committed):
            differing = [scenario["name"] for scenario, other in zip(committed, again) if scenario != other]
            sys.exit(f"The tasks did not come out as tests/fixtures/agent/loop.json holds them: {differing}")
        print(f"  the {len(committed)} tasks came out as tests/fixtures/agent/loop.json holds them", file=sys.stderr)

        return {"station": "so101_station", "start_s": StandInClock.START_S, "scenarios": records}


# ---- the run ----

STATIONS: Stations
RIG: Rig


def camera_record(camera: Any) -> dict[str, str]:
    return {"role": camera.role, "name": camera.name, "label": camera.label}


def silence() -> None:
    """Keeps PEAR's loggers from stderr (PEAR logs every request and every fault of a session), but the two whose
    records the fixtures keep."""
    for name in list(logging.root.manager.loggerDict):
        if name.startswith("pear.") and name not in LogCapture.LOGGERS:
            logger = logging.getLogger(name)
            logger.handlers = [logging.NullHandler()]
            logger.propagate = False


def constants() -> dict[str, Any]:
    """The names and the numbers of PEAR's classes that pear.js's must hold the same."""
    return {
        "action_mode": {member.name: member.value for member in ActionMode},
        "motion_status": {member.name: member.value for member in MotionStatus},
        "home_stage": {member.name: member.value for member in HomeStage},
        "action_phase": {member.name: member.value for member in ActionPhase},
        "robot_status": {member.name: member.value for member in RobotStatus},
        "control_state": {member.name: member.value for member in ControlState},
        "motion_end_reason": {member.name: member.value for member in MotionEndReason},
        "robot": {
            "PLANNING_TIMEOUT_S": BaseRobot.PLANNING_TIMEOUT_S,
            "HOME_TIMEOUT_S": BaseRobot.HOME_TIMEOUT_S,
            "FOREIGN_OBSERVATION": BaseRobot.FOREIGN_OBSERVATION,
            "HOME_ARM_CHOICES": list(SO101Robot.HOME_ARM_CHOICES),
            "HOME_CAN_KEEP_GRIPPERS": SO101Robot.HOME_CAN_KEEP_GRIPPERS,
            "profile": SO101Robot.profile(),
            # a robot made with an action mode that is none
            "bad_action_mode": outcome(
                lambda: SteppedStandInSO101Robot(STATIONS.config("so101_station"), action_mode="sideways"),
                shown=lambda robot: type(robot).__name__,
            ),
        },
        "homing": {
            "WAIT_MARGIN_S": Homing.WAIT_MARGIN_S,
            "TARGET_TOLERANCE": HomePlanning.TARGET_TOLERANCE,
            "MOVE_TOLERANCE": HomePlanning.MOVE_TOLERANCE,
            "TARGETS_CHANGED": HomePlanning.TARGETS_CHANGED,
            "SO101_TARGETS_CHANGED": SO101Planning.TARGETS_CHANGED,
            "BOUND_TOLERANCE": SO101Planning.BOUND_TOLERANCE,
            "OPEN_ENDPOINT": GripperProfile.OPEN_ENDPOINT,
        },
        "cameras": {
            "MAX_AGE_S": CameraSource.MAX_AGE_S,
            "START_TIMEOUT_MS": WristCamera.START_TIMEOUT_MS,
            "CAMERA": camera_record(WristCamera.CAMERA),
            # the wrist camera of a station whose settings have no camera (it raises before it opens a device)
            "without_settings": outcome(
                lambda: WristCamera(STATIONS.configs("so101_no_camera")[1]), shown=lambda camera: type(camera).__name__
            ),
        },
        "format": {
            "name": FORMAT.name,
            "schema": {part: list(names) for part, names in FORMAT.schema.items()},
            "cameras": [camera_record(camera) for camera in FORMAT.cameras],
            "environment_prompt": FORMAT.environment_prompt,
            "decimals": dict(FORMAT.decimals),
            "action_model": FORMAT.action_model.__name__,
        },
        "joints": list(JOINTS),
        "max_rows": SequenceOperation.MAX_ROWS,
        "start_s": StandInClock.START_S,
    }


def main() -> None:
    global STATIONS, RIG
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--scale", type=int, default=1, help="times as many generated cases (1: the committed set)")
    parser.add_argument("--output", type=Path, help="write there instead of tests/fixtures/station-robot")
    parser.add_argument("--only", choices=("parts", "sessions", "agent"), help="write that file alone (while working)")
    parser.add_argument("--groups", help="of the sessions, the groups whose name holds this (while working)")
    arguments = parser.parse_args()
    if arguments.scale < 1:
        sys.exit("--scale is a whole number of at least 1")
    if arguments.output is not None:
        Fixtures.directory = arguments.output.resolve()
    elif arguments.scale != 1:
        sys.exit("The committed fixtures are the set of --scale 1: name another --output for a larger one")
    scale, only = arguments.scale, arguments.only

    commit, pinned = Commit.of_pear(), Commit.pinned()
    if commit != pinned:
        sys.exit(
            f"This PEAR is at {commit or 'no commit that can be read (it is not a checkout)'}; "
            f"src/index.ts pins {pinned}",
        )

    silence()
    STATIONS = Stations()
    monkeypatch = pytest.MonkeyPatch()
    counts: dict[str, Any] = {}
    try:
        RIG = Rig(monkeypatch, SEED)
        if only in (None, "parts"):
            parts = {
                **PlanningCases(STATIONS, scale).all(),
                **ResultCases(STATIONS, scale).all(),
                **ActionCases(scale).all(),
                **CameraCases(RIG.new_clock()).all(),
            }
            Fixtures.write("parts.json", parts, is_compressed=True)
            counts.update({name: len(cases) for name, cases in parts.items() if isinstance(cases, list)})
        if only in (None, "sessions"):
            RIG.ids = Ids(SEED)
            monkeypatch.setattr(robot_module, "uuid4", RIG.ids.next)
            sessions = Catalogue(scale).all(arguments.groups)
            Fixtures.write("sessions.json", {"sessions": sessions}, is_compressed=True)
            steps = [step for session in sessions for step in session["steps"]]
            results = [step["out"]["ok"]["record"] for step in steps if step["op"] in ("execute", "failure_result") and "ok" in step["out"]]
            counts.update({
                "sessions": len(sessions),
                "sessions_of_pears_tests": sum(session["source"].startswith("test_") for session in sessions),
                "generated_sessions": sum(session["source"] == "generated" for session in sessions),
                "steps": len(steps),
                "steps_that_raised": sum("error" in step["out"] for step in steps),
                "control_periods": sum(len(step["ticks"]) for step in steps),
                "results": len(results),
                "results_by_status": {status.value: sum(result["status"] == status.value for result in results) for status in MotionStatus},
                "kinematics_answers": sum(len(step.get("ik", [])) for step in steps),
            })
        if only in (None, "agent"):
            agent = AgentRig(monkeypatch).run()
            Fixtures.write("agent_rig.json", agent, is_compressed=True)
            counts.update({
                "agent_tasks": len(agent["scenarios"]),
                "agent_steps": sum(len(scenario["steps"]) for scenario in agent["scenarios"]),
                "agent_control_periods": sum(
                    len(piece["ticks"]) for scenario in agent["scenarios"] for piece in (scenario["open"], *scenario["steps"], scenario["close"])
                ),
            })
    finally:
        monkeypatch.undo()

    if only is None:
        meta = {
            "scale": scale,
            "pear_commit": commit,
            "versions": {
                "python": platform.python_version(),
                "numpy": np.__version__,
                "pydantic": pydantic.VERSION,
                "pydantic_core": importlib.metadata.version("pydantic_core"),
                "ruckig": importlib.metadata.version("ruckig"),
                "placo": importlib.metadata.version("placo"),
                "lerobot": importlib.metadata.version("lerobot"),
            },
            "constants": constants(),
            "counts": counts,
            "stations": STATIONS.record(),
        }
        Fixtures.write("meta.json", meta)
    print(f"total: {Fixtures.total_bytes} bytes at --scale {scale}")
    print(json.dumps(counts))


if __name__ == "__main__":
    main()
