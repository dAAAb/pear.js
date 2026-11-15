"""Prints the rows of tests/station-robot/session.test.ts: what PEAR's own robot does at the session's edges that no
record of PEAR holds. The test file's expectations are written by hand; its header gives the rows of this script's
run. Two scripts beside it serve the same test file: session_model_state_rows.py prints the whole of the texts that
this one cuts short, and the row of seven joints; session_configuration_probe.py is the probe that came before the
section R42 and holds no row.

It runs PEAR's SO-101 robot on the stepped rig of tools/fixtures/robot_fixtures.py (the station "so101_quick"; Home on
"so101_quick_home" with the drawn cameras after an action of z +0.05 m) and prints five sections, under the names
that the cases had when the rows were taken:

    R34        a control loop that is shut down under the robot: status, observe, close
    R41        an open that fails (the session's identity cannot be drawn; the driver cannot be made), then a later open
    R42        the station's configuration changed before an open, while open, to a value that open refuses, and back
    B20        model_state of joint vectors that give no state (nan, inf), each text cut at 700 characters
    SH2, SH3   a stop at Home's first and at its second read of the cameras (and at a third, which Home never makes)

Run it with the Python of a PEAR station environment, from the repository's root or from any other directory; PEAR
must be a checkout at the commit that src/index.ts pins, because the rig is PEAR's own test rig (tests/deploy/station),
which the fixture script imports from it:

    <work dir>/envs/station/bin/python tools/rows/session_rows.py

It takes no argument: it finds tools/fixtures/robot_fixtures.py from its own place and imports it as a module. It
needs no device and no GPU, and it writes nothing: the rows go to the standard output, and no test reads them. (Python
may keep its bytecode of the fixture script beside it, in a __pycache__ that git ignores; PYTHONDONTWRITEBYTECODE=1
prevents that.)
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest
from omegaconf import OmegaConf

# (tools/fixtures/robot_fixtures.py, found from this file's own place)
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "robot_fixtures.py"
spec = importlib.util.spec_from_file_location("rf", FIXTURES)
rf = importlib.util.module_from_spec(spec)
sys.modules["rf"] = rf
spec.loader.exec_module(rf)
rf.silence()
rf.STATIONS = rf.Stations()
monkeypatch = pytest.MonkeyPatch()
rf.RIG = rf.Rig(monkeypatch, rf.SEED)
ARM = rf.ARM

import pear.deploy.station.control.robot as robot_module  # noqa: E402


def tried(call, limit=330):
    try:
        value = call()
        return f"returned {json.dumps(value, default=str)[:limit]}"
    except BaseException as error:  # noqa: BLE001
        text = " ".join(str(error).split())
        return f"raised {type(error).__name__}: {text[:limit]}"


def fmt_of(robot):
    return next(iter(type(robot).ACTION_FORMATS.values())).name


print("== R34: a control loop that is closed under the robot")
s = rf.Session("r34", "by hand", "r34", "so101_quick")
s.enable()
loop = s.robot.control_loop
loop.shutdown()
detailed = s.robot.status(with_snapshot=True)
print("   loop status", loop.status, "| robot still holds it:", s.robot._control_loop is loop)
print("   status():", json.dumps(s.robot.status(), default=str))
print("   status(True): status", detailed["status"], "control_state", detailed["control_state"], "generation", detailed["generation"])
print("   session_id kept:", s.robot.session_id is not None, "| observe:", tried(s.robot.observe, 120))
print("   close():", tried(s.robot.close), "| status after:", json.dumps(s.robot.status()), "| session_id", s.robot.session_id)
s.clock.control_loop = None

print("== R41: an open that fails")
for name in ("the session's identity cannot be drawn", "the driver cannot be made"):
    s = rf.Session("r41 " + name, "by hand", name, "so101_quick")
    robot = s.robot
    fmt = fmt_of(robot)
    closes = []
    if name.startswith("the session"):
        own_uuid4 = robot_module.uuid4

        def failing_uuid4():
            raise RuntimeError("no identity")

        own_close = type(robot).close_planner
        robot_module.uuid4 = failing_uuid4
        try:
            out = tried(robot.open)
        finally:
            robot_module.uuid4 = own_uuid4
    else:
        own_driver = type(robot).DRIVER_CLASS

        def failing_driver(*_arguments):
            raise OSError("no port")

        type(robot).DRIVER_CLASS = failing_driver
        try:
            out = tried(robot.open)
        finally:
            type(robot).DRIVER_CLASS = own_driver
    print(f"   {name}: open {out}")
    print("      status", json.dumps(robot.status()), "| session_id", robot.session_id, "| control loop", robot._control_loop,
          "| kinematics", robot.kinematics, "| model_state:", tried(lambda: robot.model_state([0.0] * 6, fmt), 80))
    s.do("open")
    print("      a later open: session", robot.session_id is not None, "| status", robot.status()["status"],
          "| model_state:", tried(lambda: robot.model_state([0.0] * 6, fmt).model_dump(), 120))
    s.result()

print("== R42: the station's configuration changed before an open")
s = rf.Session("r42", "by hand", "r42", "so101_quick", settings={})  # (a configuration of its own, not the shared one)
robot = s.robot
config = robot._station_config


def configured():
    return (robot.control_config.settle_timeout_s, robot.robot_config.gripper_tolerance, robot.status()["status"])


def opened():
    step = s.do("open")
    return "open" if "error" not in step["out"] else "open raised " + json.dumps(step["out"]["error"])


seen = [("made", *configured())]
OmegaConf.update(config, "control.settle_timeout_s", 7.5)
OmegaConf.update(config, "robot.gripper_tolerance", 0.05)
seen.append(("changed, not open", *configured()))
seen.append((opened(), *configured()))
OmegaConf.update(config, "control.settle_timeout_s", 9.5)
seen.append(("changed while open", *configured()))
s.do("close")
seen.append(("closed", *configured()))
seen.append((opened() + " again", *configured()))
s.do("close")
for row in seen:
    print("   ", row)
OmegaConf.update(config, "control.settle_timeout_s", -1.0)
print("   a configuration that is refused:", tried(robot.open, 160), "|", configured(), "| kinematics", robot.kinematics)
OmegaConf.update(config, "control.settle_timeout_s", 2.5)
print("   and repaired:", opened(), configured())
s.result()

print("== B20: joint vectors that give no state")
s = rf.Session("b20", "by hand", "b20", "so101_quick")
s.enable()
fmt = fmt_of(s.robot)
nan, inf = float("nan"), float("inf")
for name, joints in (
    ("at rest", [0.0, 0.0, 0.0, 0.0, 0.0, 1.0]),
    ("joint 1 nan", [0.0, nan, 0.0, 0.0, 0.0, 1.0]),
    ("joint 0 inf", [inf, 0.0, 0.0, 0.0, 0.0, 1.0]),
    ("the gripper nan", [0.0, 0.0, 0.0, 0.0, 0.0, nan]),
    ("the gripper inf", [0.0, 0.0, 0.0, 0.0, 0.0, inf]),
    ("all nan", [nan] * 6),
):
    print(f"   {name}:", tried(lambda: s.robot.model_state(joints, fmt).model_dump(), 700))
s.result()

print("== SH2, SH3: a stop while Home observes")
for at_read in (1, 2, 3):
    s = rf.Session(f"home {at_read}", "by hand", "home", "so101_quick_home", cameras="drawn")
    s.enable()
    s.do("execute", action=s.delta(z=0.05))  # away from Home, so that Home has a move to make
    cameras = s.robot._cameras
    read = cameras.read
    count = {"reads": 0, "approvals": 0}
    stages = []

    def hooked():
        count["reads"] += 1
        if count["reads"] == at_read:
            s.robot.stop()
        return read()

    def approve(plan):
        count["approvals"] += 1
        return True

    cameras.read = hooked
    try:
        report = s.robot.home(approve_plan=approve, report_progress=lambda stage: stages.append(stage.get("stage") if isinstance(stage, dict) else str(stage)))
        out = f"returned reached={report['results']['reached']}"
    except BaseException as error:  # noqa: BLE001
        cause = error.__cause__
        out = f"raised {type(error).__name__}: {error}" + (f" | cause {type(cause).__name__}: {cause}" if cause is not None else "")
        details = getattr(error, "details", None)
        if details:
            out += f" | details keys {sorted(details)[:8]}"
    print(f"   a stop at Home's camera read {at_read}: {out[:420]}")
    print(f"      reads {count['reads']}, approvals {count['approvals']}, stages {stages}, robot {s.robot.status()['status']}")
    s.result()
