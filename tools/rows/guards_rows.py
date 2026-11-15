"""Prints the rows of tests/station-robot/guards.test.ts: what PEAR's own robot does when a handler stops it right
before a guard check that nothing else can reach. The test file's expectations are written by hand, because no record
of PEAR holds a handler that stops the robot; its header gives the rows of this script's run.

It runs PEAR's SO-101 robot on the stepped rig of tools/fixtures/robot_fixtures.py (the station "so101_quick" with the
drawn cameras; Home on "so101_quick_home" after an action of z +0.05 m that closes the gripper) and prints, for three
actions with no arm move and for Home, each with a handler that does nothing and then with one that stops the robot
(when "Executing" is reported; at Home's stage "opening"): the result or what was raised, the count of the cameras'
reads, the phases or stages reported, how far the generation went up, and the robot's status.

Run it with the Python of a PEAR station environment, from the repository's root or from any other directory; PEAR
must be a checkout at the commit that src/index.ts pins, because the rig is PEAR's own test rig (tests/deploy/station),
which the fixture script imports from it:

    <work dir>/envs/station/bin/python tools/rows/guards_rows.py

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


def counted(s):
    cameras = s.robot._cameras
    read = cameras.read
    count = {"reads": 0}

    def hooked():
        count["reads"] += 1
        return read()

    cameras.read = hooked
    return count


print("== an action whose progress handler stops the robot at Executing")
for name, action in (
    ("an action that asks nothing", {"type": "single_arm_delta", "arm": dict(x=0.0, y=0.0, z=0.0, pitch=0.0, roll=0.0), "gripper": {"width": 0.0}}),
    ("a gripper action", {"type": "gripper", "command": "open"}),
    ("a closing with no arm move", {"type": "single_arm_delta", "arm": dict(x=0.0, y=0.0, z=0.0, pitch=0.0, roll=0.0), "gripper": {"width": -1.0}}),
):
    for stops in (False, True):
        s = rf.Session(name, "by hand", name, "so101_quick", cameras="drawn")
        s.enable()
        count = counted(s)
        phases = []
        generation = s.robot.control_loop.snapshot()["generation"]

        def handler(phase):
            phases.append(str(getattr(phase, "value", phase)))
            if stops and phases[-1] == "Executing":
                s.robot.stop()

        try:
            record = s.robot.execute(action, report_progress=handler).to_record()
            out = f"status={record.get('status')} error={json.dumps(record.get('error'))}"
        except Exception as error:  # noqa: BLE001
            out = f"RAISED {type(error).__name__}: {error}"
        print(f"   {name}, {'stopped' if stops else 'not stopped'}: {out}; camera reads {count['reads']}; phases {phases}; "
              f"generation +{s.robot.control_loop.snapshot()['generation'] - generation}; robot {s.robot.status()['status']}")
        s.result()

print("== Home whose stage handler stops the robot at the opening")
for stops in (False, True):
    s = rf.Session("home opening", "by hand", "home", "so101_quick_home", cameras="drawn")
    s.enable()
    step = s.do("execute", action=s.delta(-1.0, z=0.05))  # away from Home with the gripper closed: Home opens it
    count = counted(s)
    stages = []
    generation = s.robot.control_loop.snapshot()["generation"]

    def stage_handler(update):
        stages.append(update.get("stage") if isinstance(update, dict) else str(update))
        if stops and stages[-1] == "opening":
            s.robot.stop()

    try:
        report = s.robot.home(approve_plan=lambda plan: True, report_progress=stage_handler)
        out = f"returned reached={report['results']['reached']}"
    except Exception as error:  # noqa: BLE001
        cause = error.__cause__
        out = f"raised {type(error).__name__}: {error}" + (f" | cause {type(cause).__name__}: {cause}" if cause is not None else "")
    print(f"   moved away: {step['out']['ok']['record']['status']}; {'stopped' if stops else 'not stopped'}: {out[:300]}; camera reads {count['reads']}; "
          f"stages {stages}; generation +{s.robot.control_loop.snapshot()['generation'] - generation}; robot {s.robot.status()['status']}")
    s.result()
