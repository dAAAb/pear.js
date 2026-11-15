"""Prints the rows of tests/station-robot/handlers.test.ts: what PEAR's own robot does with a progress handler and a
Home approval that take their time. The test file's expectations are written by hand, because the handler of PEAR's
recorded sessions only notes the phase; its header gives the rows of this script's run.

It runs PEAR's SO-101 robot on the stepped rig of tools/fixtures/robot_fixtures.py and prints one line for an action
of z +0.02 m on the station "so101_quick" (the lines "A") and for Home on "so101_quick_home" after an action of
z +0.05 m (the lines "H"), with a progress handler, an approval or a stage handler that takes control periods,
raises, stops the robot, sets the cancellation or calls the robot again: the result or what was raised, the count of
the commands that the driver was sent since the handler last counted them, what the handler saw, and the robot's
status after it.

Run it with the Python of a PEAR station environment, from the repository's root or from any other directory; PEAR
must be a checkout at the commit that src/index.ts pins, because the rig is PEAR's own test rig (tests/deploy/station),
which the fixture script imports from it:

    <work dir>/envs/station/bin/python tools/rows/handlers_rows.py

It takes no argument: it finds tools/fixtures/robot_fixtures.py from its own place and imports it as a module. It
needs no device and no GPU, and it writes nothing: the rows go to the standard output, and no test reads them. (Python
may keep its bytecode of the fixture script beside it, in a __pycache__ that git ignores; PYTHONDONTWRITEBYTECODE=1
prevents that.)
"""

import importlib.util
import json
import sys
import threading
import time
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


def sends(s):
    # (the clock keeps the driver's calls of every sleep; the rest is still in the log)
    calls = [call for tick in s.clock.take() for call in tick["io"]] + rf.RIG.io.take()
    return sum(1 for call in calls if isinstance(call, (list, tuple)) and call and call[0] == "s")


def tried(call):
    try:
        value = call()
        return "returned" if value is None or not isinstance(value, (bool, int, str)) else f"returned {value}"
    except Exception as error:  # noqa: BLE001
        return f"{type(error).__name__}: {error}"


def action_case(label, make_handler):
    s = rf.Session(label, "by hand", label, "so101_quick")
    s.enable()
    observation = s.robot.observe()
    seen = []
    cancellation = threading.Event()
    handler = make_handler(s, seen, cancellation)
    sends(s)
    try:
        result = s.robot.execute(rf.decoded(s.delta(z=0.02)), reference_observation=observation, report_progress=handler, cancellation=cancellation)
        record = result.to_record()
        out = f"status={record.get('status')} error={json.dumps(record.get('error'))}"
    except Exception as error:  # noqa: BLE001
        out = f"RAISED {type(error).__name__}: {error}"
    print(f"A {label}: {out}; commands {sends(s)}; seen {json.dumps(seen)}; robot {s.robot.status()['status']}")
    s.result()


def home_case(label, make_approve, make_report=None):
    s = rf.Session(label, "by hand", label, "so101_quick_home")
    s.enable()
    s.do("execute", action=s.delta(z=0.05))  # away from Home, so that Home has a move to make
    seen = []
    cancellation = threading.Event()
    keywords = {"approve_plan": make_approve(s, seen, cancellation), "cancellation": cancellation}
    if make_report is not None:
        keywords["report_progress"] = make_report(s, seen, cancellation)
    sends(s)
    try:
        report = s.robot.home(**keywords)
        out = f"returned reached={report['results']['reached']}"
    except Exception as error:  # noqa: BLE001
        out = f"RAISED {type(error).__name__}: {error}"
    print(f"H {label}: {out}; commands {sends(s)}; seen {json.dumps(seen)}; robot {s.robot.status()['status']}")
    s.result()


def slow(s, seen, cancellation):
    def handler(phase):
        sends(s)
        for _ in range(3):
            time.sleep(s.period_s)
        seen.append(f"{phase.value}: {s.robot.control_loop.status.value}, {sends(s)} commands")

    return handler


def raising(at):
    def make(s, seen, cancellation):
        def handler(phase):
            if phase.value == at:
                raise RuntimeError("the handler failed")

        return handler

    return make


def stopping(s, seen, cancellation):
    def handler(phase):
        if phase.value == "Executing":
            seen.append(f"stop {tried(s.robot.stop)}")

    return handler


def cancelling(s, seen, cancellation):
    def handler(phase):
        if phase.value == "Executing":
            cancellation.set()

    return handler


def at_planning(what):
    def make(s, seen, cancellation):
        def handler(phase):
            seen.append(phase.value)
            if phase.value == "Planning":
                if what == "stop":
                    seen.append(f"stop {tried(s.robot.stop)}")
                else:
                    cancellation.set()

        return handler

    return make


def nested(s, seen, cancellation):
    def handler(phase):
        if phase.value == "Executing":
            seen.append(f"execute {tried(lambda: s.robot.execute(rf.decoded(s.delta(z=0.02))))}")
            seen.append(f"home {tried(lambda: s.robot.home(approve_plan=lambda plan: True))}")
            seen.append(f"recover {tried(s.robot.recover)}")
            seen.append(f"status {s.robot.status()['status']}")

    return handler


def approve_slow(s, seen, cancellation):
    def approve(plan):
        sends(s)
        for _ in range(3):
            time.sleep(s.period_s)
        seen.append(f"review: {s.robot.control_loop.status.value}, {sends(s)} commands")
        return True

    return approve


def approve_raising(s, seen, cancellation):
    def approve(plan):
        raise RuntimeError("the review failed")

    return approve


def approve_stopping(s, seen, cancellation):
    def approve(plan):
        seen.append(f"stop {tried(s.robot.stop)}")
        return True

    return approve


def approve_cancelling(s, seen, cancellation):
    def approve(plan):
        cancellation.set()
        return True

    return approve


def approve_nested(s, seen, cancellation):
    def approve(plan):
        seen.append(f"execute {tried(lambda: s.robot.execute(rf.decoded(s.delta(z=0.02))))}")
        seen.append(f"home {tried(lambda: s.robot.home(approve_plan=lambda plan: True))}")
        seen.append(f"recover {tried(s.robot.recover)}")
        return True

    return approve


def stage_raising(at):
    def make(s, seen, cancellation):
        def report(update):
            seen.append(str(update.get("stage") if isinstance(update, dict) else update))
            if seen[-1] == at:
                raise RuntimeError("the handler failed")

        return report

    return make


def stage_raising_second(s, seen, cancellation):
    def report(update):
        seen.append(str(update.get("stage") if isinstance(update, dict) else update))
        if len(seen) == 2:
            raise RuntimeError("the handler failed")

    return report


def stage_slow(s, seen, cancellation):
    def report(update):
        sends(s)
        for _ in range(2):
            time.sleep(s.period_s)
        seen.append(f"{update.get('stage') if isinstance(update, dict) else update}: {s.robot.control_loop.status.value}")

    return report


try:
    action_case("a handler that takes three control periods", slow)
    action_case("a handler that raises at Planning", raising("Planning"))
    action_case("a handler that raises at Executing", raising("Executing"))
    action_case("a handler that stops the robot at Executing", stopping)
    action_case("a handler that sets the cancellation at Executing", cancelling)
    action_case("a handler that calls the robot again at Executing", nested)
    action_case("a handler that stops the robot at Planning", at_planning("stop"))
    action_case("a handler that sets the cancellation at Planning", at_planning("cancel"))
    home_case("an approval that takes three control periods", approve_slow)
    home_case("an approval that raises", approve_raising)
    home_case("an approval that stops the robot, then approves", approve_stopping)
    home_case("an approval that sets the cancellation, then approves", approve_cancelling)
    home_case("an approval that calls the robot again, then approves", approve_nested)
    home_case("a stage handler that takes two control periods", lambda s, seen, c: (lambda plan: True), stage_slow)
    home_case("a stage handler that raises at its second stage", lambda s, seen, c: (lambda plan: True), stage_raising_second)
finally:
    monkeypatch.undo()
