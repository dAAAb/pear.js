"""Prints the rows of tests/station-robot/observation.test.ts: what PEAR's own robot does with an observation that its
holder wrote into. The test file's expectations are written by hand, because no record of PEAR holds a write into an
observation; its header gives the rows of this script's run.

It runs PEAR's SO-101 robot on the stepped rig of tools/fixtures/robot_fixtures.py (the station "so101_quick", opened
and at rest) and prints: the containers of an observation by kind, and what a write into its tuples raises; then, for
each write into a held observation, the status and the error of an action of z +0.02 m from it and joint 1 after the
action. The write is made before the action (then the line also has what is_holding and wait_stationary do with the
observation) or when the action reports "Executing" (the lines that end in "while the action is under way").

Run it with the Python of a PEAR station environment, from the repository's root or from any other directory; PEAR
must be a checkout at the commit that src/index.ts pins, because the rig is PEAR's own test rig (tests/deploy/station),
which the fixture script imports from it:

    <work dir>/envs/station/bin/python tools/rows/observation_rows.py

It takes no argument: it finds tools/fixtures/robot_fixtures.py from its own place and imports it as a module. It
needs no device and no GPU, and it writes nothing: the rows go to the standard output, and no test reads them. (Python
may keep its bytecode of the fixture script beside it, in a __pycache__ that git ignores; PYTHONDONTWRITEBYTECODE=1
prevents that.)
"""

import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
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
ARM = rf.ARM


def short(out):
    if "error" in out:
        return "RAISED " + json.dumps(out["error"])[:200]
    record = out["ok"]["record"]
    return f"status={record.get('status')} error={json.dumps(record.get('error'))[:160]}"


def run(label, alter):
    s = rf.Session(label, "by hand", label, "so101_quick")
    s.enable()
    s.do("observe", **{"as": "o"})
    o = s.observations["o"]
    note = alter(s, o)
    try:
        holding = f"is_holding {s.robot.is_holding(s.observations['o'])}"
    except Exception as error:  # noqa: BLE001
        holding = f"is_holding raised {type(error).__name__}: {error}"
    try:
        s.robot.wait_stationary(s.observations["o"])
        holding += " | wait_stationary returned"
    except Exception as error:  # noqa: BLE001
        holding += f" | wait_stationary raised {type(error).__name__}: {error}"
    note = f"{holding}" + (f"; {note}" if note else "")
    step = s.do("execute", action=s.delta(z=0.02), reference="o")
    joints = step["after"]["status"]["arms"][ARM]["position"]
    print(f"{label}: {short(step['out'])}; joint 1 after {joints[1]:.4f}" + (f"; {note}" if note else ""))
    s.result()


def facts(s, o):
    snapshot = o["control_snapshot"]
    feedback = snapshot["arms"][ARM]
    print("  observation:", type(o).__name__, "| joint_positions:", type(o["joint_positions"]).__name__,
          "writeable", o["joint_positions"].flags.writeable, "| images:", type(o["images"]).__name__,
          "| camera_timestamps:", type(o["camera_timestamps"]).__name__, "| control_snapshot:", type(snapshot).__name__)
    print("  snapshot fields:", {key: type(value).__name__ for key, value in snapshot.items()})
    print("  feedback fields:", {key: type(value).__name__ for key, value in feedback.items()})
    print("  targets[arm]:", type(snapshot["targets"][ARM]).__name__)
    for name, write in (
        ("feedback position[0] = 1.0", lambda: feedback["position"].__setitem__(0, 1.0)),
        ("targets[arm][0] = 1.0", lambda: snapshot["targets"][ARM].__setitem__(0, 1.0)),
    ):
        try:
            write()
            print("  write", name, ": accepted")
        except Exception as error:  # noqa: BLE001
            print("  write", name, ":", type(error).__name__, str(error))
    try:
        feedback["position"][0] = 1.0
    except Exception as error:  # noqa: BLE001
        print("  feedback['position'][0] = 1.0 :", type(error).__name__, str(error))
    other = s.robot.observe()
    print("  a second observation has another joint vector:", other["joint_positions"] is not o["joint_positions"],
          "| another snapshot:", other["control_snapshot"] is not snapshot)
    before = float(other["joint_positions"][1])
    o["joint_positions"][1] += 0.25
    o["joint_positions"][1] -= 0.25
    third = s.robot.observe()
    print("  a write into one observation's joints leaves a later one as measured:", float(third["joint_positions"][1]) == before)


def session_changed(s, o):
    o["session_id"] = "another"


def generation_changed(s, o):
    o["control_snapshot"]["generation"] += 1


def snapshot_replaced(s, o):
    o["control_snapshot"] = {**o["control_snapshot"], "generation": o["control_snapshot"]["generation"] + 1}


def copy_other_joints(s, o):
    joints = o["joint_positions"].copy()
    joints[1] += 0.3
    s.observations["o"] = {**o, "joint_positions": joints}


def joints_in_place(s, o):
    o["joint_positions"][1] += 0.3


def joints_not_finite(s, o):
    o["joint_positions"][1] = float("nan")


def joints_replaced(s, o):
    o["joint_positions"] = [float(value) for value in o["joint_positions"]][:5]


def kinds(value, path, found):
    """Lists every container of ``value`` with its kind: what Python code can write into and what it cannot."""
    if isinstance(value, dict):
        found.append((path or ".", "dict"))
        for key, item in value.items():
            kinds(item, f"{path}.{key}", found)
    elif isinstance(value, tuple):
        found.append((path, "tuple"))
        for index, item in enumerate(value):
            kinds(item, f"{path}[{index}]", found)
    elif isinstance(value, list):
        found.append((path, "list"))
        for index, item in enumerate(value):
            kinds(item, f"{path}[{index}]", found)
    elif isinstance(value, np.ndarray):
        found.append((path, f"ndarray writeable={value.flags.writeable} shape={list(value.shape)}"))
    return found


def containers():
    s = rf.Session("containers", "by hand", "containers", "so101_quick", cameras="drawn")
    s.enable()
    s.do("execute", action=s.delta(z=0.02))
    o = s.robot.observe()
    found = kinds(o, "", [])
    print("containers of an observation (drawn cameras, after one action):")
    for kind in ("tuple", "list"):
        print(f"  {kind}:", json.dumps([path for path, what in found if what == kind]))
    print("  ndarray:", json.dumps([f"{path} {what}" for path, what in found if what.startswith("ndarray")]))
    print("  dict:", json.dumps([path for path, what in found if what == "dict"]))
    s.result()


def during(label, alter):
    """The observation is written while the action is under way: when the robot reports that it executes."""
    s = rf.Session(label, "by hand", label, "so101_quick")
    s.enable()
    o = s.robot.observe()

    def report(phase):
        if phase.value == "Executing":
            alter(s, o)

    result = s.robot.execute(rf.decoded(s.delta(z=0.02)) if hasattr(rf, "decoded") else s.delta(z=0.02), reference_observation=o, report_progress=report)
    record = result.to_record()
    joints = s.robot.status(with_snapshot=True)["arms"][ARM]["position"]
    print(f"{label}: status={record.get('status')} error={json.dumps(record.get('error'))[:160]}; joint 1 after {joints[1]:.4f}")
    s.result()


try:
    containers()
    during("10 joint_positions replaced by a list of five while the action is under way", joints_replaced)
    during("11 joint_positions[1] = nan in place while the action is under way", joints_not_finite)
    during("12 session_id changed in place while the action is under way", session_changed)
    during("13 generation changed in place while the action is under way", generation_changed)
    run("1 the observation as it is", facts)
    run("2 a copy of it", lambda s, o: s.observations.__setitem__("o", dict(o)))
    run("5 session_id changed in place", session_changed)
    run("5b control_snapshot.generation changed in place", generation_changed)
    run("5c control_snapshot replaced by a copy of another generation", snapshot_replaced)
    during("14 control_snapshot replaced by a copy of another generation while the action is under way", snapshot_replaced)
    run("6 a copy with joint 1 changed by 0.3 rad", copy_other_joints)
    run("7 joint_positions changed in place by 0.3 rad", joints_in_place)
    run("8 joint_positions[1] = nan in place", joints_not_finite)
    run("9 joint_positions replaced by a list of five", joints_replaced)
finally:
    monkeypatch.undo()
