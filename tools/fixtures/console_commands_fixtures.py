#!/usr/bin/env python3
"""Generates tests/fixtures/console/commands.json.gz (commands.json while it is under 300,000 bytes; it is not) from
PEAR's own classes: the operator's commands (Commands of pear/deploy/station/gui/console/commands.py, its table and
its handlers unchanged, every command given through Commands.run) on PEAR's own Console, and the Watchdog
(watchdog.py) with its PeriodicThread (periodic_thread.py), through scripted scenarios.

Run it from a checkout of PEAR, with PEAR's Python (it needs no GPU and no hardware):

    cd <PEAR> && PYTHONDONTWRITEBYTECODE=1 <PEAR's python> <pear.js>/tools/fixtures/console_commands_fixtures.py

The rig. EVERY scenario of this file stands on the rig of console_core_fixtures.py (its Stage, imported; read that
script's docstring first, this one says what is added): PEAR's Console made without its constructor, PEAR's
HomeReview, ControlLease and ModelsConfig, and scripted stand-ins that record every call made of them, by thread, for
the robot, the recordings, the preview, the camera feed, the uploads, the annotations, the health checks and THE TASK
RUN. So these records pin the lines of commands.py and watchdog.py themselves and what they ask of the console and of
the parts; they do not show PEAR's real robot or PEAR's real TaskRun (no turn runs: `task_run.run` and
`task_run.close_session` are recorded calls that return at once). No scenario of this file stands on the rig of
console_fixtures.py (the real robot on the stepped arm and the real task run): the group "a task from start to clear
on the real robot and the real task run" is NOT in this file; its scenarios named `*_on_stand_ins` hold the commands'
own part of it.

What this script adds to that rig:
- `console.commands` is PEAR's Commands(console), not a stand-in. `time` and `uuid4` of commands.py are the
  scenario's scripted clock and UUIDs (the same sequences as the console's: a task's id is the hex of the UUID drawn,
  its `created` the reading of time.time()).
- The attributes the commands and the watchdog read of the stand-ins: robot.ACTION_FORMATS, robot.HOME_ARM_CHOICES
  and robot.HOME_CAN_KEEP_GRIPPERS are those of PEAR's robot class named in meta.robot_class (meta.constants.robot);
  preview.is_encoding is true and preview.error_text null; camera_feed.reader is a marker (not None);
  recordings.is_enabled is true, recordings.active_segment null; uploads.attach(...) returns [].
- The watchdog is PEAR's Watchdog made without its constructor (which starts its thread): the script calls PEAR's
  `_check` itself, on the main thread (in PEAR it runs on the thread named meta.constants.watchdog.THREAD_NAME).

The file: {"meta": {...}, "scenarios": [...]}, one scenario a line. A scenario has the keys of the console's own
fixtures (name, pins, monotonic_step_s, initial, uuids, steps) and `group` (1 to 5, the part of the commands it
belongs to) and `rig` ("stand_ins"). A step has the keys of the console's own fixtures: script, returned (the keys in
PEAR's order), raised (null or {"type", "message"}), events (each with `saved` and `thread`), phases and calls (by
thread), operations, fields, files, clock. Added to `fields`:

  task_run    of the task run after the step: task, total_steps, turn_number, active_attempt_id, active_turn,
              resume_pending and has_session (whether task_run.session is not None). The stand-in starts with task,
              active_turn, total_steps and session only: a key no command has written yet is ABSENT.
  model       console.model
  recording_is_enabled   recordings.is_enabled

The steps this script adds (the others are the console's own fixtures'):

  {"op": "command", "name", "data", "raises"?, "join"?}   console.commands.run(name, data). In `data` a value
        {"repeat": s, "times": n} stands for the string s repeated n times. `raises` is the class the script
        expects (checked); `join`: the script waits for the worker's end before the record is taken.
  {"op": "watchdog_check"}   PEAR's Watchdog._check(), on the main thread
  {"op": "launch_until_stopped"}   console.launch of an operation that waits for its cancellation and then ends as
        PEAR's operations do (OperatorPaused.check_cancelled); the script waits until it has begun. The step that
        stops it records it in `operations`.
  {"op": "periodic", "as", "raises_at", "closes_at"?, "is_waiting_first"?, "is_ended_by_failure"?}
        `as` "watchdog": PEAR's Watchdog(console) as its constructor makes it, with PERIOD_S a millisecond and, in
        the place of _check, a scripted check; `as` "thread": PEAR's PeriodicThread(check, 0.001, "scripted", the
        two keywords given). The check counts its calls from 1, raises RuntimeError at the calls of `raises_at` and
        sets the thread's exit_event at the call `closes_at` (before it raises). The script waits for the thread's
        end, then calls close(). `returned`: checks (how many were made), thread_is_alive, thread_name, is_daemon,
        exit_event_is_set (all before close()), is_waiting_first, is_paced_from_start, is_ended_by_failure (of the
        PeriodicThread) and exit_event_is_set_after_close.
  {"op": "set", ...}   besides the keys of the console's own fixtures, applied first and in this order: cameras
        ({"is_encoding", "error_text"}: of the preview); camera_reader (false: camera_feed.reader is None);
        session (task_run.session: null or an object with these attributes, {"turn_count", "blocked_reason"});
        recording_segment (recordings.active_segment: null, or a segment whose snapshot() returns {"status": the
        member of SegmentStatus named, "error"}); worker_join_s (console.WORKER_JOIN_S of this console, so that a
        scenario with an operation that never ends does not wait PEAR's 15 s); robot_becomes ({"after": a method,
        "robot": a status}: once the robot's call of that method is recorded, the robot returns that status; null:
        no longer); attached_images (what uploads.attach returns); supports_reference_images (the console's
        supports_reference_images() answers that from then on: the model service's answer, which on this rig is
        otherwise always true).

Between the two threads the record keeps no order (as the console's own fixtures). Where a command comes while an
operation runs, the operation is one the script holds ({"do": "block"}: it takes no notice of the stop and ends when
a later step releases it) or `launch_until_stopped` (it ends because of the stop: the worker then shows the phase
Stopping while the main thread shows the same phase, so the record is the same in either order, and Commands itself
joins the worker before it goes on). Two runs give the same bytes.
"""

from __future__ import annotations

import argparse
import copy
import gzip
import json
import sys
import tempfile
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pydantic
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import console_core_fixtures as core  # noqa: E402  (the rig; it prepares the path of the stand-ins of PEAR's tests)
import robot_fixtures  # noqa: E402
import stand_in_robots  # noqa: E402

from pear.deploy.station.exceptions import OperatorPaused  # noqa: E402
from pear.deploy.station.gui.console import commands as commands_module  # noqa: E402
from pear.deploy.station.gui.console.commands import Commands  # noqa: E402
from pear.deploy.station.gui.console.console import Console  # noqa: E402
from pear.deploy.station.gui.console.lease import ControlLease  # noqa: E402
from pear.deploy.station.gui.console.periodic_thread import PeriodicThread  # noqa: E402
from pear.deploy.station.gui.console.phase import STOPPED_STATUSES  # noqa: E402
from pear.deploy.station.gui.console.task_run import RECORD_URL  # noqa: E402
from pear.deploy.station.gui.console.watchdog import Watchdog  # noqa: E402
from pear.deploy.station.records.recording.encode_worker import SegmentStatus  # noqa: E402

REPOSITORY = Path(__file__).resolve().parents[2]
FIXTURES = REPOSITORY / "tests" / "fixtures" / "console"
NAME = "commands.json"
PACK_ABOVE_BYTES = 300_000  # a larger file is written as gzip (NAME + ".gz")
ROBOT_CLASS_NAME = "stand_in_robots.SteppedStandInSO101Robot"  # as the rig's ModelsConfig names it
ROBOT_CLASS = stand_in_robots.SteppedStandInSO101Robot
READER = {"stand_in": "reader"}
PERIOD_S = 0.001  # (on the machine's clock) of the periodic threads this script starts
TASK_RUN_FIELDS = ("task", "total_steps", "turn_number", "active_attempt_id", "active_turn", "resume_pending")
SET_KEYS = (
    "cameras",
    "camera_reader",
    "session",
    "recording_segment",
    "worker_join_s",
    "robot_becomes",
    "attached_images",
    "supports_reference_images",
)
COMMAND_FLAGS = ("is_immediate", "needs_control", "is_latch_blocked", "stops_first", "clears_error", "clears_performance")
plain = core.plain


def expand(value: Any) -> Any:
    """Returns a command's data with every {"repeat": s, "times": n} as the string it stands for."""
    if isinstance(value, dict):
        if set(value) == {"repeat", "times"}:
            return value["repeat"] * value["times"]
        return {key: expand(item) for key, item in value.items()}
    if isinstance(value, list):
        return [expand(item) for item in value]

    return value


class Stage(core.Stage):
    """One scenario's rig: that of the console's own fixtures, with PEAR's Commands and PEAR's Watchdog on it."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, number: int, root: Path, monotonic_step_s: float) -> None:
        super().__init__(monkeypatch, number, root, monotonic_step_s)
        self.monkeypatch = monkeypatch
        clock, console = self.clock, self.console
        monkeypatch.setattr(commands_module, "time", SimpleNamespace(time=clock.time, time_ns=clock.time_ns))
        monkeypatch.setattr(commands_module, "uuid4", self.ids.next)
        console.commands = Commands(console)  # PEAR's own, in the place of the stand-in
        self.watchdog = object.__new__(Watchdog)  # PEAR's own, without its thread: the script calls _check
        self.watchdog.console = console
        self.wrapped: list[str] = []

        robot = console.robot
        robot.ACTION_FORMATS = ROBOT_CLASS.ACTION_FORMATS
        robot.HOME_ARM_CHOICES = ROBOT_CLASS.HOME_ARM_CHOICES
        robot.HOME_CAN_KEEP_GRIPPERS = ROBOT_CLASS.HOME_CAN_KEEP_GRIPPERS
        console.preview.is_encoding, console.preview.error_text = True, None
        console.camera_feed.reader = READER
        console.recordings.is_enabled, console.recordings.active_segment = True, None
        console.uploads._returns["attach"] = []

    # ---- the operations and the threads of this script ----

    def launch_until_stopped(self) -> None:
        began = threading.Event()
        console = self.console

        def operation(cancellation: threading.Event) -> None:
            entry: dict[str, Any] = {
                "cancellation_is_the_consoles": cancellation is console.cancellation,
                "cancellation_was_set": cancellation.is_set(),
            }
            began.set()
            try:
                assert cancellation.wait(core.WAIT_S), "the operation was never stopped"
                OperatorPaused.check_cancelled(cancellation)
            except BaseException as error:
                entry["raised"] = {"type": type(error).__name__, "message": str(error)}
                raise
            finally:
                with self.lock:
                    self.operations.append(entry)

        console.launch(operation)
        assert began.wait(core.WAIT_S), "the operation did not begin"

    def periodic(self, spec: dict[str, Any]) -> dict[str, Any]:
        ready = threading.Event()  # set once `thread` below is the thread's own object
        checks: list[int] = []
        thread: PeriodicThread

        def check() -> None:
            assert ready.wait(core.WAIT_S)
            checks.append(len(checks) + 1)
            if checks[-1] == spec.get("closes_at"):
                thread.exit_event.set()
            if checks[-1] in spec["raises_at"]:
                raise RuntimeError(f"check {checks[-1]} failed")

        if spec["as"] == "watchdog":
            with self.monkeypatch.context() as patch:
                patch.setattr(Watchdog, "PERIOD_S", PERIOD_S)
                patch.setattr(Watchdog, "_check", lambda watchdog: check())
                closing = Watchdog(self.console)
            thread = closing.periodic_thread
        else:
            keywords = {key: spec[key] for key in ("is_waiting_first", "is_ended_by_failure")}
            closing = thread = PeriodicThread(check, PERIOD_S, "scripted", **keywords)
        ready.set()
        thread.thread.join(core.WAIT_S)
        returned = {
            "checks": len(checks),
            "thread_is_alive": thread.thread.is_alive(),
            "thread_name": thread.thread.name,
            "is_daemon": thread.thread.daemon,
            "exit_event_is_set": thread.exit_event.is_set(),
            "is_waiting_first": thread.is_waiting_first,
            "is_paced_from_start": thread.is_paced_from_start,
            "is_ended_by_failure": thread.is_ended_by_failure,
        }
        closing.close()

        return {**returned, "exit_event_is_set_after_close": thread.exit_event.is_set()}

    # ---- a step ----

    def set_more(self, spec: dict[str, Any]) -> None:
        console = self.console
        for key in SET_KEYS:
            if key not in spec:
                continue
            value = copy.deepcopy(spec[key])
            if key == "cameras":
                console.preview.is_encoding, console.preview.error_text = value["is_encoding"], value["error_text"]
            elif key == "camera_reader":
                console.camera_feed.reader = READER if value else None
            elif key == "session":
                console.task_run.session = None if value is None else SimpleNamespace(**value)
            elif key == "recording_segment":
                console.recordings.active_segment = None if value is None else self.segment(value)
            elif key == "worker_join_s":
                console.WORKER_JOIN_S = value
            elif key == "robot_becomes":
                self.becomes(value)
            elif key == "attached_images":
                console.uploads._returns["attach"] = value
            elif key == "supports_reference_images":
                console.supports_reference_images = lambda value=value: value

    @staticmethod
    def segment(value: dict[str, Any]) -> SimpleNamespace:
        return SimpleNamespace(snapshot=lambda: {"status": SegmentStatus[value["status"]], "error": value["error"]})

    def becomes(self, value: dict[str, Any] | None) -> None:
        robot = self.console.robot
        for name in self.wrapped:
            vars(robot).pop(name, None)
        self.wrapped = []
        if value is None:
            return
        recorded = core.StandIn.__getattr__(robot, value["after"])

        def call(*arguments: Any, **keywords: Any) -> Any:
            returned = recorded(*arguments, **keywords)
            robot._returns["status"] = copy.deepcopy(value["robot"])
            return returned

        vars(robot)[value["after"]] = call
        self.wrapped.append(value["after"])

    def call_of(self, spec: dict[str, Any]) -> Any:
        console, op = self.console, spec["op"]
        if op == "command":
            return lambda: console.commands.run(spec["name"], expand(copy.deepcopy(spec["data"])))
        if op == "watchdog_check":
            return self.watchdog._check  # noqa: SLF001
        if op == "launch_until_stopped":
            return self.launch_until_stopped
        if op == "periodic":
            return lambda: self.periodic(spec)
        if op == "set":
            self.set_more(spec)
            spec = {key: value for key, value in spec.items() if key not in SET_KEYS}

        return super().call_of(spec)

    def fields(self) -> dict[str, Any]:
        fields = super().fields()
        console = self.console
        values = vars(console.task_run)
        task_run = {key: values[key] for key in TASK_RUN_FIELDS if key in values}
        task_run["has_session"] = values.get("session") is not None
        fields["task_run"] = plain(task_run)
        fields["model"] = console.model
        fields["recording_is_enabled"] = console.recordings.is_enabled

        return fields


def command(name: str, data: Any, **keys: Any) -> dict[str, Any]:
    return {"op": "command", "name": name, "data": data, **keys}


def put(**keys: Any) -> dict[str, Any]:
    return {"op": "set", **keys}


def phase(name: str) -> dict[str, Any]:
    return {"op": "set_phase", "phase": name}


class Scenarios:
    """The scripted scenarios, in the file's order."""

    TASK = {"id": "task-1", "instruction": "Stack the cubes", "model": core.MODEL, "images": []}
    PERFORMANCE = {"inference_seconds": 1.5, "turn": 2}
    ERROR = "An earlier failure"
    CHECK = {"op": "watchdog_check"}
    BLOCK = {"op": "launch", "operation": {"do": "block"}}
    RELEASE = {"op": "release_operation"}
    UNTIL_STOPPED = {"op": "launch_until_stopped"}
    CAMERAS_ON = {"is_encoding": True, "error_text": None}
    CAMERAS_OFF = {"is_encoding": False, "error_text": None}
    CAMERAS_STALE = {"is_encoding": True, "error_text": "Camera wrist delivers no frames"}
    SESSION = {"turn_count": 2, "blocked_reason": None}

    def __init__(self, monkeypatch: pytest.MonkeyPatch, directory: Path) -> None:
        self.monkeypatch = monkeypatch
        self.directory = directory
        self.scenarios: list[dict[str, Any]] = []
        self.group = 0

    def play(self, name: str, pins: str, steps: list[dict[str, Any]], monotonic_step_s: float = 0.25) -> None:
        number = len(self.scenarios)
        stage = Stage(self.monkeypatch, number, self.directory / str(number), monotonic_step_s)
        initial = stage.fields()
        records = [stage.step(spec) for spec in steps]
        assert not stage.console.is_busy, f"{name} leaves its worker running"
        self.scenarios.append(
            {
                "name": name,
                "group": self.group,
                "rig": "stand_ins",
                "pins": pins,
                "monotonic_step_s": monotonic_step_s,
                "initial": initial,
                "uuids": list(stage.ids.drawn),
                "steps": records,
            }
        )

    def all(self, groups: set[int]) -> list[dict[str, Any]]:
        for number, group in enumerate((self.run, self.stop, self.task, self.motors, self.watchdog), start=1):
            self.group = number
            if number in groups:
                group()

        return self.scenarios

    def run(self) -> None:
        """Group 1: Commands.run (commands.py lines 74 to 97)."""
        play, task, check, block, release = self.play, self.TASK, self.CHECK, self.BLOCK, self.RELEASE
        state = Stage.robot_state
        shown = {"error": self.ERROR, "performance": self.PERFORMANCE}
        value = "ValueError"

        play(
            "run_unknown_command",
            "commands.py 76-80: a name the table does not hold raises 'Unknown command'; nothing is cleared",
            [
                put(**shown),
                command("nope", {}, raises=value),
                command("", None, raises=value),
                command("PAUSE", {}, raises=value),
                command("_pause", {}, raises=value),
            ],
        )
        play(
            "run_data_none",
            "commands.py 77: data that is None is read as {} (each handler then finds no key)",
            [
                put(robot=state("READY")),
                command("recording", None, raises=value),
                command("disable", None, raises=value),
                command("reset_stop", None),
                command("pause", None),
                command("stop", None),
            ],
        )
        play(
            "run_while_an_operation_runs",
            "commands.py 81-88: a command that is not immediate is refused while an operation runs, before the latch "
            "is looked at and before anything is cleared; pause and stop are immediate and run at once",
            [
                put(robot=state("READY"), **shown),
                block,
                command("enable", {}, raises=value),
                command("recording", {"enabled": False}, raises=value),
                command("reset_stop", {}, raises=value),
                command("model", {"model": "second"}, raises=value),
                command("pause", {}),
                put(**shown),
                command("stop", {}),
                command("start", {"instruction": "Stack the cubes"}, raises=value),  # busy comes before the latch
                release,
                command("start", {"instruction": "Stack the cubes"}, raises=value),  # now the latch refuses it
            ],
        )
        play(
            "run_latch_blocked",
            "commands.py 86-88 and the table's is_latch_blocked: enable, start, resume and home are refused while "
            "STOP MOTION is latched, with nothing cleared; the others are admitted",
            [
                put(robot=state("READY"), task=task),
                command("stop", {}),
                put(**shown),
                command("enable", {}, raises=value),
                command("start", {"instruction": "Stack the cubes"}, raises=value),
                command("resume", {}, raises=value),
                command("home", {}, raises=value),
                command("recording", {"enabled": False}),
                command("reconnect_cameras", {}, join=True),
                command("clear", {}, join=True),
                command("model", {"model": "second"}),
                command("disable", {"confirm": True}, join=True),
            ],
        )
        play(
            "run_clears",
            "commands.py 90-97 and the table's clears_error and clears_performance: what an admitted command clears "
            "before its handler runs (also when the handler then refuses), what it leaves, and the answer "
            "{'accepted': true} of a handler that returns None",
            [
                put(**shown),
                command("recording", {"enabled": False}),  # clears the error only
                put(**shown),
                command("model", {"model": "second"}),  # clears both
                put(**shown),
                command("reset_stop", {}),  # clears neither; its handler answers itself
                put(**shown),
                command("recording", {"enabled": "yes"}, raises=value),  # cleared, then refused by the handler
                put(**shown),
                command("disable", {}, raises=value),  # both cleared, then refused
                put(**shown),
                command("pause", {}),  # immediate: run clears nothing (the stop itself clears the performance)
                put(**shown),
                check,  # (the watchdog shows the idle phase again)
                command("recover_control", {}, raises=value),  # the error cleared, then refused: no fault
            ],
        )

    def stop(self) -> None:
        """Group 2: pause, stop, reset_stop (commands.py lines 111 to 139)."""
        play, task, block, release = self.play, self.TASK, self.BLOCK, self.RELEASE
        state = Stage.robot_state
        value = "ValueError"
        fault = state("FAULT", generation=1, fault="Serial line lost", fault_details={"joint": "elbow_flex"})

        play(
            "pause_and_stop",
            "commands.py 111-117, console.py 109-131: the stop's report, the reason, the latch that a later pause "
            "leaves, the event 'stopping' that is not saved",
            [
                put(robot=state("READY"), task=task, performance=self.PERFORMANCE),
                command("pause", {}),
                command("stop", {}),
                command("pause", {"ignored": 1}),
                command("stop", {"ignored": 1}),
            ],
        )
        play(
            "stop_while_an_operation_ends_by_it",
            "commands.py 111-117 with console.py 240-242: the operation that the pause cancels ends as paused",
            [put(robot=state("READY")), self.UNTIL_STOPPED, command("pause", {}, join=True)],
        )
        play(
            "stop_robot_stop_raises",
            "commands.py 115-117 with console.py 114-125: the robot's stop raises: the command raises, the latch is "
            "set all the same",
            [
                put(robot=state("READY"), failing={"of": "robot", "call": "stop", "message": "The bus is gone"}),
                command("pause", {}, raises="RuntimeError"),
                command("stop", {}, raises="RuntimeError"),
                put(failing=None),
                command("reset_stop", {}),
            ],
        )
        play(
            "reset_stop",
            "commands.py 125-139: refused unless the robot is READY or OFF; then the latch is released and the phase "
            "is Phase.idle_for(the status, not latched, whether a task exists)",
            [
                put(robot=state("BUSY")),
                command("stop", {}),
                command("reset_stop", {}, raises=value),
                put(robot=fault),
                command("reset_stop", {}, raises=value),
                put(robot=state("READY")),
                command("reset_stop", {}),  # Holding
                command("reset_stop", {}),  # not latched: the same answer and the phase again
                command("stop", {}),
                put(task=task),
                command("reset_stop", {}),  # Paused
                command("stop", {}),
                put(robot=state("OFF")),
                command("reset_stop", {}),  # Paused: the task comes before the motors
                put(task=None),
                command("stop", {}),
                command("reset_stop", {}),  # Disabled
            ],
        )
        play(
            "reset_stop_while_an_operation_runs",
            "commands.py 84-85 with the table: reset_stop is not immediate, an operation that runs refuses it",
            [put(robot=state("READY")), block, command("stop", {}), command("reset_stop", {}, raises=value), release,
             command("reset_stop", {})],
        )

    def task(self) -> None:
        """Group 3, the commands' own part on the stand-ins: start, resume, clear (commands.py 219 to 305, 99-109)."""
        play, task, block, release = self.play, self.TASK, self.BLOCK, self.RELEASE
        state = Stage.robot_state
        value = "ValueError"
        start = {"instruction": "Stack the cubes"}

        play(
            "start_refusals_on_stand_ins",
            "commands.py 219-236: what refuses a start, in the order PEAR checks: a task exists; the instruction "
            "(empty, absent, of spaces only, too long); images without support; no live camera feed; the robot not "
            "READY",
            [
                put(task=task, cameras=self.CAMERAS_OFF, supports_reference_images=False),
                command("start", {"instruction": "", "image_ids": ["upload-1"]}, raises=value),  # the task
                put(task=None),
                command("start", {"instruction": "", "image_ids": ["upload-1"]}, raises=value),  # the instruction
                command("start", {"image_ids": ["upload-1"]}, raises=value),
                command("start", {"instruction": " \t\n "}, raises=value),
                command("start", {"instruction": {"repeat": "x", "times": 20001}}, raises=value),
                command("start", {"instruction": {"repeat": "x", "times": 20000}}, raises=value),  # long enough: cameras
                command("start", {"instruction": 7}, raises=value),  # read as "7": the cameras refuse it
                command("start", {"instruction": "Stack", "image_ids": ["upload-1"]}, raises=value),  # the images
                command("start", {"instruction": "Stack", "image_ids": []}, raises=value),  # no image: the cameras
                put(supports_reference_images=True),
                command("start", {"instruction": "Stack", "image_ids": ["upload-1"]}, raises=value),  # the cameras
                put(cameras=self.CAMERAS_STALE),
                command("start", start, raises=value),
                put(cameras=self.CAMERAS_ON),
                command("start", start, raises=value),  # the robot is OFF
                put(robot=state("BUSY")),
                command("start", start, raises=value),
            ],
        )
        play(
            "start_resume_clear_on_stand_ins",
            "commands.py 238-305 and 425-438: an admitted start (the task's record and its keys' order, task.json, "
            "the event 'task', the recording started, the loop launched as a recorded operation), a second start "
            "refused, resume, clear, clear without a task, and a start with tags and images after it",
            [
                put(robot=state("READY"), error=self.ERROR, performance=self.PERFORMANCE),
                command("start", {"instruction": "  Stack the cubes  ", "unknown": 1}, join=True),
                command("start", start, raises=value),
                command("resume", {}, join=True),
                command("clear", {}, join=True),
                command("clear", {}, join=True),
                put(attached_images=[{"file": "image-1.png", "name": "cubes.png"}, {"file": "image-2.jpg"}]),
                command(
                    "start",
                    {"instruction": "Sort the blocks", "tags": ["blocks", "sorting"], "image_ids": ["upload-1", "upload-2"]},
                    join=True,
                ),
            ],
        )
        play(
            "start_attach_fails_on_stand_ins",
            "commands.py 256-266: the images cannot be attached: the task's folder is removed, no task is left",
            [
                put(robot=state("READY"), failing={"of": "uploads", "call": "attach", "message": "No such upload"}),
                command("start", {"instruction": "Stack the cubes", "image_ids": ["upload-9"]}, raises="RuntimeError"),
                put(failing={"of": "recordings", "call": "start", "message": "The disk is full"}),
                command("start", start, raises="RuntimeError"),  # the task stays; the recording is stopped
            ],
        )
        play(
            "resume_refusals_on_stand_ins",
            "commands.py 277-288: resume needs a task and a READY robot, live cameras, and a session that is not "
            "blocked",
            [
                command("resume", {}, raises=value),
                put(task=task),
                command("resume", {}, raises=value),  # the robot is OFF
                put(robot=state("READY"), cameras=self.CAMERAS_OFF),
                command("resume", {}, raises=value),
                put(cameras=self.CAMERAS_STALE),
                command("resume", {}, raises=value),
                put(cameras=self.CAMERAS_ON, session={"turn_count": 2, "blocked_reason": "The context is full"}),
                command("resume", {}, raises=value),
                put(session=self.SESSION),
                command("resume", {}, join=True),
            ],
        )
        play(
            "clear_stops_the_operation_on_stand_ins",
            "commands.py 81-82 and 99-109 (_stop_before), 290-305: clear while an operation runs stops it with the "
            "reason 'Stopping before clear', joins the worker, lets the robot settle, then clears on a new worker",
            [
                put(robot=state("READY"), task=task, session=self.SESSION, performance=self.PERFORMANCE),
                self.UNTIL_STOPPED,
                command("clear", {}, join=True),
            ],
        )
        play(
            "clear_robot_off_does_not_settle_on_stand_ins",
            "commands.py 108-109: an OFF robot is not waited for after the stop",
            [put(task=task), self.UNTIL_STOPPED, command("clear", {}, join=True)],
        )
        play(
            "clear_old_operation_still_stopping_on_stand_ins",
            "commands.py 105-107: the stopped operation does not end within WORKER_JOIN_S (here 0.05 s): refused, and "
            "the task stays",
            [
                put(robot=state("READY"), task=task, worker_join_s=0.05),
                block,
                command("clear", {}, raises=value),
                release,
                command("clear", {}, join=True),
            ],
        )

    def motors(self) -> None:
        """Group 4 without home: enable, disable, recover_control, reconnect_cameras, model, recording."""
        play, task = self.play, self.TASK
        state = Stage.robot_state
        value = "ValueError"
        fault = state("FAULT", generation=1, fault="Serial line lost", fault_details={"joint": "elbow_flex"})

        play(
            "enable_and_disable",
            "commands.py 164-186 and 307-336: enable (the cameras read, the phases Enabling then Holding, the "
            "robot opened on the worker) and disable (the confirmation, the session and the robot closed, the task "
            "run's fields)",
            [
                put(robot_becomes={"after": "open", "robot": state("READY")}),
                command("enable", {}, join=True),
                command("enable", {}, raises=value),  # already enabled
                command("disable", {}, raises=value),
                command("disable", {"confirm": "yes"}, raises=value),
                put(task=task, session=self.SESSION, robot_becomes={"after": "close", "robot": state("OFF")}),
                command("disable", {"confirm": True}, join=True),
            ],
        )
        play(
            "enable_refused_by_the_cameras",
            "commands.py 169-172: no reader; an encoding preview with an error; a read of the feed that raises",
            [
                put(camera_reader=False),
                command("enable", {}, raises=value),
                put(camera_reader=True, cameras=self.CAMERAS_STALE),
                command("enable", {}, raises=value),
                put(cameras={"is_encoding": False, "error_text": "Not started"}, failing={"of": "camera_feed", "call": "read", "message": "Camera top is stale"}),
                command("enable", {}, raises="RuntimeError"),
            ],
        )
        play(
            "disable_cleanup_fails",
            "commands.py 317-336: the model session does not close: the motors are disabled all the same, the task "
            "run's fields stay, the failure is shown",
            [
                put(robot=state("READY"), task=task, session=self.SESSION, failing={"of": "task_run", "call": "close_session", "message": "The model server is gone"}),
                command("disable", {"confirm": True}, join=True),
            ],
        )
        play(
            "recover_control",
            "commands.py 188-217: refused without a fault; a recovery that ends READY (with a task: Paused); one "
            "after which the robot is still faulted; one whose recover raises",
            [
                command("recover_control", {}, raises=value),
                put(robot=fault, task=task, error="Serial line lost", robot_becomes={"after": "recover", "robot": state("READY", generation=1)}),
                command("recover_control", {}, join=True),
                put(robot=fault, robot_becomes=None),
                command("recover_control", {}, join=True),
                put(failing={"of": "robot", "call": "recover", "message": "No answer from the arm"}),
                command("recover_control", {}, join=True),
            ],
        )
        play(
            "reconnect_cameras",
            "commands.py 141-162: the phase Reconnecting cameras, the preview reconnected on the worker, the notice, "
            "the earlier phase shown again",
            [
                put(robot=state("READY"), task=task),
                phase("PAUSED"),
                command("reconnect_cameras", {}, join=True),
                put(failing={"of": "preview", "call": "reconnect", "message": "No camera answers"}),
                command("reconnect_cameras", {}, join=True),
            ],
        )
        play(
            "model_and_recording",
            "commands.py 408-423: model (a name the config offers, with no task and no session) and recording (a "
            "boolean only)",
            [
                command("model", {"model": "second"}),
                command("model", {"model": "stand_in"}),
                put(task=task),
                command("model", {"model": "second"}, raises=value),
                put(task=None, session=self.SESSION),
                command("model", {"model": "second"}, raises=value),
                command("recording", {"enabled": False}),
                command("recording", {"enabled": True}),
                command("recording", {"enabled": 1}, raises=value),
                command("recording", {}, raises=value),
            ],
        )
        play(
            "home_refusals",
            "commands.py 338-355: home needs a READY robot and a boolean open_grippers, and false is refused by a "
            "robot that cannot keep its grippers (meta.constants.robot.HOME_CAN_KEEP_GRIPPERS)",
            [
                command("home", {}, raises=value),
                put(robot=state("READY")),
                command("home", {"open_grippers": "yes"}, raises=value),
                command("home", {"open_grippers": False}, raises=value),
            ],
        )

    def watchdog(self) -> None:
        """Group 5: Watchdog._check (watchdog.py) and PeriodicThread."""
        play, task, check, block, release = self.play, self.TASK, self.CHECK, self.BLOCK, self.RELEASE
        state = Stage.robot_state
        fault = state("FAULT", generation=1, fault="Serial line lost", fault_details={"joint": "elbow_flex"})
        other = next(member.name for member in SegmentStatus if member is not SegmentStatus.FAILED)

        play(
            "watchdog_stopping_to_idle",
            "watchdog.py 31-38 and 58-66: a check with nothing to do; the phase Stopping becomes the idle phase once "
            "no operation runs and the robot is READY or OFF",
            [
                check,
                put(robot=state("READY")),
                check,
                command("pause", {}),
                check,  # Holding
                command("stop", {}),
                check,  # Stopped
                put(task=task),
                command("reset_stop", {}),
                command("pause", {}),
                check,  # Paused
                put(robot=state("BUSY")),
                command("pause", {}),
                check,  # the robot has not stopped: Stopping stays
                put(robot=state("OFF")),
                check,  # Paused
                block,
                command("pause", {}),
                check,  # an operation still runs: Stopping stays
                release,
                check,
            ],
        )
        play(
            "watchdog_fault",
            "watchdog.py 44-45, 56-57 and 76-93: a fault saves the control diagnostic, stops with the fault's text, "
            "shows it as the error and the phase Fault; not again while the phase is Fault or Recovering control",
            [
                put(robot=state("READY"), task=task),
                block,
                put(robot=fault),
                check,
                check,
                release,
                check,
                phase("RECOVERING_CONTROL"),
                check,
                phase("HOLDING"),
                put(robot=state("FAULT", generation=2)),
                check,  # a fault without a text: 'Robot fault'
            ],
        )
        play(
            "watchdog_recording_failed",
            "watchdog.py 38-42: a failed segment of the recording is shown as the error and stops the operation",
            [
                put(robot=state("READY"), task=task, recording_segment={"status": other, "error": None}),
                block,
                check,
                put(recording_segment={"status": "FAILED", "error": "The encoder ended"}),
                check,
                release,
                check,
            ],
        )
        play(
            "watchdog_camera_unavailable",
            "watchdog.py 47-54: an encoding preview with an error stops a running operation that is not cancelled "
            "yet, except in the phases that need no cameras",
            [
                put(robot=state("READY"), cameras=self.CAMERAS_STALE),
                check,  # no operation runs
                block,
                check,  # stopped
                check,  # already cancelled: not again
                release,
                check,
                phase("RECONNECTING_CAMERAS"),
                block,
                check,
                release,
                phase("RECOVERING_CONTROL"),
                block,
                check,
                release,
                phase("HOLDING"),
                put(cameras={"is_encoding": False, "error_text": "Not started"}),
                block,
                check,  # the preview does not encode: nothing
                release,
            ],
        )
        play(
            "watchdog_lost_browser",
            "watchdog.py 34-36 and 68-74 with lease.py: the browser that holds control went silent: the operation "
            "is paused and control released; during a camera reconnect control is released without a stop",
            [
                put(robot=state("READY")),
                {"op": "lease", "method": "claim", "client_id": "tab-1"},
                check,
                block,
                {"op": "advance", "seconds": ControlLease.LEASE_S + 1.0},
                check,
                release,
                check,
                {"op": "lease", "method": "claim", "client_id": "tab-2"},
                phase("RECONNECTING_CAMERAS"),
                block,
                {"op": "advance", "seconds": ControlLease.LEASE_S + 1.0},
                check,
                release,
            ],
            monotonic_step_s=0.0,
        )
        play(
            "periodic_thread_and_a_check_that_raises",
            "periodic_thread.py 42-58 and watchdog.py 21-25: the watchdog's thread ends at its first check that "
            "raises (is_ended_by_failure); a thread that is not ended by a failure goes on until it is closed",
            [
                {"op": "periodic", "as": "watchdog", "raises_at": [3]},
                {"op": "periodic", "as": "watchdog", "raises_at": [], "closes_at": 4},
                {"op": "periodic", "as": "thread", "is_waiting_first": False, "is_ended_by_failure": False, "raises_at": [2, 3], "closes_at": 5},
                {"op": "periodic", "as": "thread", "is_waiting_first": True, "is_ended_by_failure": True, "raises_at": [1]},
            ],
        )


def constants() -> dict[str, Any]:
    """The names and the numbers of PEAR's commands and watchdog that a port must hold the same, with the console's."""
    table = Commands(object.__new__(Console)).table  # (the constructor only keeps the console)
    return plain(
        {
            **core.constants(),
            "commands": {
                "MAX_INSTRUCTION_CHARS": Commands.MAX_INSTRUCTION_CHARS,
                "HOME_STAGE_PHASES": {stage.value: shown.value for stage, shown in Commands.HOME_STAGE_PHASES.items()},
                "table": {name: {flag: getattr(entry, flag) for flag in COMMAND_FLAGS} for name, entry in table.items()},
                "RECORD_URL": RECORD_URL,
            },
            "watchdog": {
                "PERIOD_S": Watchdog.PERIOD_S,
                "THREAD_NAME": Watchdog.THREAD_NAME,
                "PHASES_WITHOUT_CAMERAS": [shown.value for shown in Watchdog.PHASES_WITHOUT_CAMERAS],
            },
            "periodic_thread": {"MIN_WAIT_S": PeriodicThread.MIN_WAIT_S, "JOIN_S": PeriodicThread.JOIN_S},
            "stopped_statuses": list(STOPPED_STATUSES),
            "segment_status": {member.name: member.value for member in SegmentStatus},
            "robot": {
                "action_formats": len(ROBOT_CLASS.ACTION_FORMATS),
                "HOME_ARM_CHOICES": list(ROBOT_CLASS.HOME_ARM_CHOICES),
                "HOME_CAN_KEEP_GRIPPERS": ROBOT_CLASS.HOME_CAN_KEEP_GRIPPERS,
            },
        }
    )


def write(directory: Path, meta: dict[str, Any], scenarios: list[dict[str, Any]]) -> None:
    """Writes the file: ASCII only, one scenario a line, never a path of this machine; as gzip when it is large."""
    rows = ",\n".join("  " + json.dumps(scenario, ensure_ascii=True, separators=(",", ":")) for scenario in scenarios)
    text = "{\n" + f' "meta": {json.dumps(meta, ensure_ascii=True)},\n "scenarios": [\n{rows}\n ]' + "\n}\n"
    json.loads(text, parse_constant=robot_fixtures.Fixtures.refuse_constant)  # (raises unless the file is JSON)
    robot_fixtures.Fixtures.check_private(NAME, text)
    data = text.encode("ascii")
    is_packed = len(data) > PACK_ABOVE_BYTES
    name, other = (NAME + ".gz", NAME) if is_packed else (NAME, NAME + ".gz")
    if is_packed:
        data = gzip.compress(data, compresslevel=9, mtime=0)  # (no time of this run in the file)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / other).unlink(missing_ok=True)
    (directory / name).write_bytes(data)
    size = f"{len(data)} bytes" + (f" ({len(text)} of JSON)" if is_packed else "")
    print(f"{name}: {size}; {len(scenarios)} scenarios")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", type=Path, help="write there instead of tests/fixtures/console")
    parser.add_argument("--groups", default="1,2,3,4,5", help="the groups to generate (the file holds all five)")
    arguments = parser.parse_args()
    directory = FIXTURES if arguments.output is None else arguments.output.resolve()
    groups = {int(group) for group in arguments.groups.split(",")}

    commit, pinned = robot_fixtures.Commit.of_pear(), robot_fixtures.Commit.pinned()
    if commit != pinned:
        sys.exit(
            f"This PEAR is at {commit or 'no commit that can be read (it is not a checkout)'}; "
            f"src/index.ts pins {pinned}",
        )

    robot_fixtures.silence()
    monkeypatch = pytest.MonkeyPatch()
    try:
        with tempfile.TemporaryDirectory() as temporary:
            scenarios = Scenarios(monkeypatch, Path(temporary)).all(groups)
    finally:
        monkeypatch.undo()

    steps = [step for scenario in scenarios for step in scenario["steps"]]
    commands = [step for step in steps if step["script"]["op"] == "command"]
    meta = {
        "pear_commit": commit,
        "versions": {"python": sys.version.split()[0], "numpy": np.__version__, "pydantic": pydantic.VERSION},
        "seed": core.SEED,
        "groups": sorted(groups),
        "rig": "stand_ins",
        "models": core.MODELS,
        "model": core.MODEL,
        "robot_class": ROBOT_CLASS_NAME,
        "robot_profile": core.ROBOT_PROFILE,
        "robot_session_id": core.ROBOT_SESSION,
        "recording": core.RECORDING,
        "cameras": core.CAMERAS,
        "camera_reader": READER,
        "wall_start_s": core.Clock.WALL_START_S,
        "wall_step_s": core.Clock.WALL_STEP_S,
        "monotonic_start_s": core.Clock.MONOTONIC_START_S,
        "ns_start": core.Clock.NS_START,
        "ns_step": core.Clock.NS_STEP,
        "constants": constants(),
        "counts": {
            "scenarios": len(scenarios),
            "steps": len(steps),
            "commands": len(commands),
            "commands_that_raised": sum(step["raised"] is not None for step in commands),
            "events": sum(len(step["events"]) for step in steps),
            "events_saved": sum(event["saved"] for step in steps for event in step["events"]),
            "calls_of_stand_ins": sum(len(calls) for step in steps for calls in step["calls"].values()),
            "operations": sum(len(step["operations"]) for step in steps),
        },
    }
    write(directory, meta, scenarios)


if __name__ == "__main__":
    main()
