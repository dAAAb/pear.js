"""Prints the rows of tests/station-robot/adapter.test.ts: what PEAR's turn loop and robot do where pear.js has its
adapter (AgentRobotAdapter). The test file's expectations are written by hand, because no record of PEAR holds frames
that cannot be made into the model's message, a wait that is cancelled, a failure's result at a snapshot or a copy of
an observation; its header gives the rows of this script's run.

It runs PEAR's own StationAgentLoop over PEAR's SO-101 robot on the stepped rig of tools/fixtures/robot_fixtures.py
(the station "so101_quick" with the drawn cameras, opened and at rest) and prints: one step of the loop when a frame
is no uint8 RGB image, when the JPEG cannot be saved, when the task's folder cannot be made, and when the operator
pauses as the phase "Observing" is reported (what the step raised, the robot's stops and observations, the
generation, the turns, the events); wait_stationary with a cancellation that is set and with one that is not;
failure_result at a snapshot, at none and at None; an action from a copy of an observation.

Run it with the Python of a PEAR station environment, from the repository's root or from any other directory; PEAR
must be a checkout at the commit that src/index.ts pins, because the rig is PEAR's own test rig (tests/deploy/station),
which the fixture script imports from it:

    <work dir>/envs/station/bin/python tools/rows/adapter_rows.py

It takes no argument: it finds tools/fixtures/robot_fixtures.py from its own place and imports it as a module. It
needs no device and no GPU. PEAR's loop saves a turn's frames as files, so the script makes a temporary directory for
them and removes it when it ends; it writes nothing else: the rows go to the standard output, and no test reads them.
(Python may keep its bytecode of the fixture script beside it, in a __pycache__ that git ignores;
PYTHONDONTWRITEBYTECODE=1 prevents that.) One line of the output holds the temporary directory's path, in the
NotADirectoryError of "the task's folder cannot be made", and so is not the same from run to run.
"""

import atexit
import importlib.util
import json
import shutil
import sys
import tempfile
import threading
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

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
SCRATCH = Path(tempfile.mkdtemp(prefix="pear-js-rows-"))  # (removed when the script ends, with an error too)
atexit.register(shutil.rmtree, SCRATCH, ignore_errors=True)

from pear.deploy.station.agent_loop.agent_loop import StationAgentLoop  # noqa: E402


class Client:
    asked = 0

    def cancel(self):
        pass

    def close(self):
        pass


def session(label):
    s = rf.Session(label, "by hand", label, "so101_quick", cameras="drawn")
    s.enable()
    return s


def generation(s):
    return s.robot.control_loop.snapshot()["generation"]


def loop_row(label, prepare, directory=None, cancel_on=None):
    s = session(label)
    robot = s.robot
    counts = {"stop": 0, "observe": 0}
    stop, observe = robot.stop, robot.observe

    def counted_stop():
        counts["stop"] += 1
        return stop()

    def counted_observe():
        counts["observe"] += 1
        return observe()

    robot.stop, robot.observe = counted_stop, counted_observe
    action_format = next(iter(type(robot).ACTION_FORMATS.values()))
    loop = StationAgentLoop(
        robot, Client(), action_format=action_format, timeout_s=60.0,
        directory=directory or SCRATCH / label.replace(" ", "_"), reference_images=(),
    )
    undo = prepare(s) if prepare else None
    cancellation = threading.Event()
    events = []

    def on_event(kind, data):
        events.append(f"{getattr(kind, 'value', kind)}:{json.dumps(data, default=str)[:60]}")
        if cancel_on is not None and getattr(kind, "value", kind) == cancel_on:
            cancellation.set()

    before = generation(s)
    try:
        result = loop.step(cancellation=cancellation, on_event=on_event, attempt_id="attempt-1")
        how = f"returned {result.to_record().get('status')}"
    except BaseException as error:  # noqa: BLE001
        how = f"raised {type(error).__name__}: {str(error)[:110]}"
    finally:
        if undo:
            undo()
    print(f"{label}: step {how}")
    print(f"   robot.stop calls {counts['stop']}, observe calls {counts['observe']}, generation {before} -> {generation(s)}, "
          f"turn_count {loop.turn_count}, last_turn {loop.last_turn}, blocked {loop.blocked_reason!r}, "
          f"status {robot.status()['status']}, events {events}")
    s.result()


def not_uint8(s):
    cameras = s.robot._cameras
    read = cameras.read

    def floats():
        return {role: {**frame, "rgb": frame["rgb"].astype("float32")} for role, frame in read().items()}

    cameras.read = floats


def save_fails(_s):
    save = Image.Image.save

    def failing(self, *args, **kwargs):
        raise OSError("the frame could not be written")

    Image.Image.save = failing

    def undo():
        Image.Image.save = save

    return undo


print("== the loop when the frames cannot be made into the model's message")
loop_row("a frame that is no uint8 RGB image", not_uint8)
loop_row("the JPEG cannot be saved", save_fails)
blocker = SCRATCH / "a_file"
blocker.write_text("x")
loop_row("the task's folder cannot be made", None, directory=blocker / "task")
print("== the loop when the operator pauses as the turn begins to observe")
loop_row("paused at the Observing phase", None, cancel_on="phase")

print("== wait_stationary with a cancellation that is set")
s = session("wait")
for name, observation in (("no observation", None), ("its own observation", s.robot.observe())):
    event = threading.Event()
    event.set()
    before = generation(s)
    try:
        out = s.robot.wait_stationary(observation, cancellation=event)
        how = f"returned a snapshot of status {out['status']}"
    except BaseException as error:  # noqa: BLE001
        how = f"raised {type(error).__name__}: {error}"
    print(f"   {name}: {how}; generation {before} -> {generation(s)}; robot status {s.robot.status()['status']}")
event = threading.Event()
out = s.robot.wait_stationary(None, cancellation=event)
print(f"   a cancellation that is not set: returned a snapshot of status {out['status']}, generation {out['generation']}")
s.result()

print("== failure_result with a snapshot")
s = session("failure")
fmt = next(iter(type(s.robot).ACTION_FORMATS.values())).name
old = s.robot.status(with_snapshot=True)
s.do("observe", **{"as": "o"})
step = s.do("execute", action=s.delta(z=0.02), reference="o")
print("   moved:", step["out"]["ok"]["record"]["status"])
error = RuntimeError("the model did not answer")
at_old = s.robot.failure_result(error, format_name=fmt, snapshot=old).to_record()
at_now = s.robot.failure_result(error, format_name=fmt).to_record()
at_none = s.robot.failure_result(error, format_name=fmt, snapshot=None).to_record()
print("   record keys:", list(at_old))
for key in at_old:
    same = json.dumps(at_old[key], default=str) == json.dumps(at_now[key], default=str)
    text = json.dumps(at_old[key], default=str)
    print(f"   {key}: {'same' if same else 'DIFFERS'} | at the snapshot {text[:150]}" + ("" if same else f" | now {json.dumps(at_now[key], default=str)[:150]}"))
print("   snapshot=None equals no snapshot:", json.dumps(at_none, default=str) == json.dumps(at_now, default=str))
print("   joint 1 of the snapshot %.4f, now %.4f" % (old["arms"][ARM]["position"][1], s.robot.status(with_snapshot=True)["arms"][ARM]["position"][1]))
s.result()

print("== an observation the robot did not issue")
for name, make in (
    ("a copy of another session", lambda o: {**o, "session_id": "another"}),
    ("a copy of another operation", lambda o: {**o, "control_snapshot": {**o["control_snapshot"], "generation": o["control_snapshot"]["generation"] + 1}}),
    ("a copy", lambda o: dict(o)),
):
    s = session(name)
    s.do("observe", **{"as": "o"})
    s.observations["o"] = make(s.observations["o"])
    try:
        holding = f"is_holding {s.robot.is_holding(s.observations['o'])}"
    except Exception as error:  # noqa: BLE001
        holding = f"is_holding raised {type(error).__name__}: {error}"
    step = s.do("execute", action=s.delta(z=0.02), reference="o")
    record = step["out"]["ok"]["record"]
    print(f"   {name}: {holding}; execute {record['status']} {json.dumps(record.get('error'))[:120]}")
    s.result()
