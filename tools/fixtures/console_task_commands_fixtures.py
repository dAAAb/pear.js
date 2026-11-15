#!/usr/bin/env python3
"""Generates tests/fixtures/console/task_commands.json from PEAR's own classes: the operator's commands (Commands
of pear/deploy/station/gui/console/commands.py, unchanged) running a task from `start` on, on PEAR's own Console
with its worker thread, PEAR's real TaskRun and PEAR's real robot, through scripted scenarios.

Run it from a checkout of PEAR, with PEAR's Python (it needs no GPU and no hardware):

    cd <PEAR> && PYTHONDONTWRITEBYTECODE=1 <PEAR's python> <pear.js>/tools/fixtures/console_task_commands_fixtures.py

`--output <directory>` writes there instead of tests/fixtures/console. `--dwell-s <seconds>` is a check of the
script, not a part of the record: the main thread then waits that long, on the machine's clock, before and after
every command; the file's bytes must not change.

The rig. It is that of tools/fixtures/console_fixtures.py (its Stage, which this script's Stage extends): PEAR's
real robot on the stepped stand-in SO-101 of PEAR's tests, on the stand-in clock; the model's client is PEAR's
StandInScriptedClient made by PEAR's own ModelsConfig and OfferedModel; PEAR's TaskRun; PEAR's Console made
without its constructor (object.__new__(Console)). Here the console also has what Commands, Console.launch and
Console._operate read: PEAR's own Commands (Commands(console)) and ControlLease (nobody holds control: its owner
is None), `worker` (None until a command launches one), `home_status` and `saved_fault_identity` (None). PEAR's
Commands.run and its handlers, Console.launch, _operate, emit, set_phase, robot_status and TaskRun.run run
unchanged, and the worker is PEAR's thread ("gui-operation"), started by Console.launch. Console.stop runs
unchanged but for one thing, which is the script's (below, "The order of the two threads").

What stands in, and what each answers. Each is console_core_fixtures.py's StandIn: it records every call made of
it (in `calls`, below) and answers None unless said here:

  recordings     start(task, camera_feed, status) and stop(reason, stopped_at=...) answer None. Its on_event, which
                 Console.emit calls first for every event, is not recorded (the events are); it is where a
                 scenario's hooks act. Its attributes: is_enabled True, active_segment None.
  preview        its attributes: is_encoding True, error_text None (the live camera feeds are there)
  camera_feed    (what recordings.start is given); no call is made of it
  uploads        attach(image_ids, owner, files) answers []: the task has no images. delete answers None.
  annotations    update answers None (no scenario has tags, so it is not called)
  health_checks  get answers None (asked only for a task with images)

The watchdog is PEAR's Watchdog (watchdog.py) made without its constructor, which starts its thread: nothing
checks by itself, so the phase Stopping that a pause leaves stays until a step {"op": "watchdog_check"}, which
calls PEAR's Watchdog._check() once, on the main thread (in PEAR it runs every Watchdog.PERIOD_S on a thread of
its own, so there the phase settles at some moment after the worker has ended, not at a step of the operator's).

Not here: the page's service and its lease, the real recordings and the preview's encoders.

Deterministic: time.monotonic and time.sleep are the stand-in clock (a new one for every scenario, first reading
meta.start_s; a sleep steps the control loop once); `time` of console.py, task_run.py and commands.py is replaced,
so that time.time() there reads meta.wall_start_s + n * meta.wall_step_s at its n-th reading of the scenario (n
from 0); uuid4 of commands.py (a task's id), of task_run.py (attempt ids), of agent_loop.py and
clients/schemas.py (the session's episode, a frame's uuid) and of control/robot.py (the robot's session, the
observations) are seeded sequences, new for every scenario. Two runs give the same bytes, and so does a run with
--dwell-s.

The threads. "main" gives the commands; "worker" is the console's worker (every Console.launch starts a new
thread of that name: a task's loop after `start` and after each `resume`, and the operation of `clear`); "model"
is any other thread, which here is the thread in which the session asks the scripted model (the model's events
are published from it).

The order of the two threads. A command is given on the main thread while the worker runs a turn. The script
chooses the moment: a hand-over, {"do": "hand_over", "point": name}, in the scripted model's answer (or as a
hook's action inside Console.emit), stops that thread at the named point until the main thread has given its
commands there. The record of a step is taken when the worker has ended (`until` "ended": the main thread has
joined it) or when it waits at a point (`until` the point's name). A command given at a point and recorded at
the same point (`at` and `until` are equal) leaves the worker waiting there: a command that is refused while the
worker runs. What the record of a command given during a turn pins:

  1. before the command: the worker has opened the turn and waits for the model's answer; the model has reported
     what its script says before the hand-over and the loop has looked at the robot's hold at least once
     ({"do": "wait_watch"}); all of this is in the record of the step before
  2. the command runs whole on the main thread: for `pause`, Console.stop(): robot.stop(), the phase Stopping,
     recordings.stop("Paused by operator", stopped_at=...), the event "stopping" (not saved), and run() returns
  3. then the worker's cancellation is set and the model's thread goes on: it waits until the loop has stopped
     its request ({"do": "wait_stop"}) and answers; of that answer the event `usage` is published (from the
     model's thread, and saved) and nothing else
  4. the worker sees the cancellation, and the session's loop stops as PEAR's own does (agent_loop.py, _stop:
     robot.stop(), then the request is told to stop, then the loop joins the request's thread): so the worker's
     robot.stop() comes before the model's `usage` of step 3 and everything else of the worker after it, on any
     machine (a run with --dwell-s, which holds the model's thread long after the cancellation, gives the same
     bytes). The worker then ends the turn as TaskRun does (turn_end, execution, interrupted), Console._operate
     sets the phase and stops the recording, and the worker ends

What in this is the script's and not PEAR's: PEAR's Console.stop() sets the cancellation at its first line, so in
PEAR the worker may end the turn while stop() still runs, and the worker's events of step 4 may come before the
event "stopping" or between the calls of step 2. The script has stop() set a cancellation of its own there and
sets the worker's when stop() has returned (as console_fixtures.py does for its pause, and for the same reason:
the order of the two threads' effects must not depend on the machine's timing). Everything else of stop() is
PEAR's, in PEAR's order. So a test may hold the order within each thread as PEAR's, and the order between the
threads (the events' ids, a call's `after_event`, the stand-in clock) as this script's choice among the orders
PEAR allows.

A command given while an action moves the arm. A hook {"on": "phase", "phase": "Executing", "do": "hand_over",
"point": name, "after_sleeps": n} hands over n control periods after the event that announces the action, inside
the worker's sleep of the stand-in clock within robot.execute (not inside Console.emit): the arm is moving, and
the record of the step before shows the robot's status word BUSY and the call of execute not yet ended. The
command (`stop`) runs whole on the main thread while the worker is held there: PEAR's robot lets a second thread
ask for the stop meanwhile, and robot.stop() steps no control period (stop_request_seconds is 0.0). The worker
goes on when the command has returned: the control periods in which the arm brakes and settles are the worker's
(the step's clock.sleeps), execute ends with the robot's own result of the stopped action, and no request of the
model is open, so no event of the model's thread follows the command.

A command that stops the worker itself. `clear` given while the task runs waits for the worker inside the command
(Commands._stop_before joins it), so the worker must leave its point before the command has returned: such a step
says `release` "stopped", and the worker leaves when Console.stop() has returned and its cancellation is set. The
rest is PEAR's own order: the first worker ends, then the main thread waits for the robot to settle and launches
the command's operation on a second worker.

The kinematics. The answers of PEAR's kinematics (SO101Kinematics.joint_target) are in every step's `ik`, as
tools/fixtures/robot_fixtures.py records them (its Rig), so a test can give the port's robot PEAR's joint targets
in the place of its own solver's. Not recorded: the values of the C library that PEAR's other arithmetic reads.
A port that computes its own differs from PEAR in the last digits of some joints (reported by the users of
console_fixtures.py), so where a test does not replay `ik` it may hold the joints (of a result, of an
observation and of what the model reads) to a tolerance, and nothing else.

The file: {"meta": {...}, "scenarios": [...]}, one scenario a line. A scenario:

  name, pins   what it is and which lines of commands.py, console.py and task_run.py it pins
  robot_session_id, control_period_s, model_timeout_s
  ids_before, sleeps_before, monotonic_s_before
               what the rig drew and slept before the first step (the robot's session; its opening), as a
               step's `ids` and `clock` give them
  console_before, robot_status_before, ik_before
               the console's fields (as a step's `console`), the robot's status word and the kinematics' answers
               (as a step's `ik`) before the first step
  steps        in order, each one command or one check of the watchdog:
    op         only in a step that is no command, and then its first key: "watchdog_check", PEAR's
               Watchdog._check() once on the main thread; such a step's `command`, `data` and `returned` are
               null, and `raised` is what _check() raised
    command, data  the command's name and data, as Commands.run(name, data) is given them
    at         null, or the point at which the worker waits while the command is given
    until      "ended": the record is taken when the worker has ended (or there is none); else the point at which
               the worker waits when the record is taken
    release    only in a step whose command stops the running operation and waits for its worker itself
               (Commands._stop_before): "stopped", the worker leaves its point when Console.stop() has returned,
               inside the command, and no longer when the command has returned
    script     what the step sets of the scripted model: `turns` (the model's requests from this step on, in
               order, each {"model": [operations]} as in console_fixtures.py, with the hand-over besides) and
               `hooks` (as in console_fixtures.py); absent keys leave what an earlier step set
    returned   null when run() raised; else what it returned, its keys in PEAR's order
    raised     null, or {"type": the class's name, "message": str of it}
    events     every event Console.emit made during the step, in order, as emit made it (id, type, data, time,
               monotonic_s, task_id), with `thread` (the thread that published it) and `saved` (whether a task's
               events.jsonl holds it; the script checks that the file's line is that event)
    phases     {"main": [...], "worker": [...], "model": [...]}: every phase Console.set_phase was given during
               the step, by thread, in order
    console    after the step: phase, error, is_stop_latched, performance, home_status, is_busy
    task       TaskRun.task after the step (null, or the task: its keys in PEAR's order)
    task_run   TaskRun's fields after the step: total_steps, turn_number, active_attempt_id, active_turn,
               resume_pending, inference_started_at (null or the wall time), has_session, has_client
    session    null, or the session's turn_count, blocked_reason and previous_result (the result's record)
    robot_status  the word of the robot's status after the step
    files      every file under the console's root after the step, by its path under the root ("<task id>/..."),
               sorted: {"name", "json": its value, keys in the file's order} for a JSON file; {"name",
               "event_ids"} for a task's events.jsonl (the ids of its lines, in order); {"name", "size",
               "sha256"} for any other (a frame); {"name", "unchanged": true} for a file whose bytes are those of
               the step before. A path under the console's root reads "<root>/...".
    calls      {"main": [...], "worker": [...], "model": [...]}: the calls made during the step of the robot from
               outside it and of each stand-in, by thread, in the order they ended. A call of the robot is {"of":
               "robot", "call": name, arguments..., "returned" or "raised", "after_event"} as
               console_fixtures.py records it (is_holding is not recorded); a call of a stand-in is {"of",
               "call", "arguments", "keywords", "returned"?, "after_event"} as console_core_fixtures.py records
               it (an argument that is no JSON value reads {"object": its class's name}). `after_event` is the
               id of the last event published when the call began.
    model_inputs  what the client was sent at each request made during the step: text (what the model reads),
               images (camera_name, uuid, name, is_jpeg) and reference_images
    ik         the answers of PEAR's kinematics during the step, in order: {"joints": the joint positions it was
               given, "delta": the action's arm quantities, "out": {"ok": the joint target} or {"error": ...}}
    ids        the UUIDs drawn during the step: commands (a task's id is the hex of one), task_run (an attempt
               id is the first 12 hex characters), session, robot
    clock      sleeps (the control periods stepped during the step), monotonic_s (the stand-in clock after it),
               wall_readings (the readings of time.time() so far in the scenario)
"""

from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import itertools
import json
import sys
import tempfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pydantic
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import console_fixtures as task_rig  # noqa: E402  (the rig with PEAR's real robot; PEAR's tests join sys.path there)
import console_core_fixtures as core  # noqa: E402  (the stand-in that records the calls made of it)
import robot_fixtures  # noqa: E402

from pear.deploy.station.gui.console import commands as commands_module  # noqa: E402
from pear.deploy.station.gui.console import console as console_module  # noqa: E402
from pear.deploy.station.gui.console.commands import Commands  # noqa: E402
from pear.deploy.station.gui.console.console import Console  # noqa: E402
from pear.deploy.station.gui.console.lease import ControlLease  # noqa: E402
from pear.deploy.station.gui.console.task_run import RECORD_URL  # noqa: E402
from pear.deploy.station.gui.console.watchdog import Watchdog  # noqa: E402
from pear.deploy.station.records.task_files import TaskFiles  # noqa: E402

REPOSITORY = Path(__file__).resolve().parents[2]
FIXTURES = REPOSITORY / "tests" / "fixtures" / "console"
NAME = "task_commands.json"
PACK_ABOVE_BYTES = 300_000  # a larger file is written as gzip (NAME + ".gz"), as the other fixtures are
NUMBER_BASE = 700  # a scenario's number in the rig's seeds is this plus its place: sequences of this file's own
THREADS = ("main", "worker", "model")
ENDED = "ended"  # a step's `until`: the worker has ended
CHECK = "watchdog_check"  # a step's `op`: PEAR's Watchdog._check() in the place of a command
STOPPED = "stopped"  # a step's `release`: the worker leaves its point when Console.stop() has returned
PLACEHOLDER = "placeholder"  # the folder the rig's constructor makes for a task; no task is there before `start`
WAIT_S = task_rig.WAIT_S  # (on the machine's clock) the longest this script waits for another thread
REAL_MONOTONIC = task_rig.REAL_MONOTONIC
says = task_rig.says
action = task_rig.action
turn = task_rig.Scenarios.turn


class Recordings(core.StandIn):
    """What stands in for the console's recordings: it records the calls made of it but on_event, which
    Console.emit calls first for every event and which is where a scenario's hooks act."""

    def on_event(self, kind: Any, data: dict[str, Any]) -> None:
        self._stage.hooked(str(getattr(kind, "value", kind)), data)


class ByThread(list):
    """The list the rig's recording robot appends a call to: the call joins the calls of its thread."""

    def __init__(self, stage: Stage) -> None:
        super().__init__()
        self.stage = stage

    def append(self, entry: dict[str, Any]) -> None:
        stage = self.stage
        with stage.lock:
            stage.calls[stage.thread()].append({"of": "robot", **entry})


class Stage(task_rig.Stage):
    """One scenario's rig: that of the task run's fixtures, with PEAR's Commands, the console's worker and the
    stand-ins a command reads."""

    def __init__(self, rig: Any, monkeypatch: pytest.MonkeyPatch, number: int, root: Path, dwell_s: float) -> None:
        self.lock = threading.Lock()  # of what two threads write
        self.calls: dict[str, list[dict[str, Any]]] = {thread: [] for thread in THREADS}
        self.set_phases: dict[str, list[str]] = {thread: [] for thread in THREADS}
        self.event_threads: dict[int, str] = {}
        self.raises: dict[str, Any] | None = None  # (a stand-in reads it: no call of one fails here)
        self.reached, self.released = threading.Event(), threading.Event()
        self.point: str | None = None  # where the worker waits for the main thread
        self.is_released_by_stop = False  # (a step's `release`) the worker leaves its point as stop() returns
        self.dwell_s = dwell_s
        super().__init__(rig, monkeypatch, number, root, {"id": PLACEHOLDER})
        (root / PLACEHOLDER).rmdir()
        self.current["robot"] = ByThread(self)
        console = self.console
        console.task_run.task = None

        self.ids["commands"] = robot_fixtures.Ids(task_rig.SEED + 10 * number + 4)
        monkeypatch.setattr(commands_module, "uuid4", self.ids["commands"].next)
        monkeypatch.setattr(
            commands_module, "time", SimpleNamespace(time=self.wall.time, monotonic=lambda: time.monotonic())
        )

        # console.py names the record of a fault or of a failed Home by time.time_ns(), which the task run's rig
        # gives its stand-in `time` no reading of; no scenario here reaches one yet
        ns_counter = itertools.count(int(task_rig.WallClock.START_S * 1_000_000_000), 1_000_000)
        console_module.time.time_ns = lambda: next(ns_counter)

        # what Commands, Console.launch and Console._operate read besides what the task run's rig gives a console
        console.worker = None
        console.home_status = None
        console.saved_fault_identity = None
        console.lease = ControlLease(lambda: console.is_busy)
        console.camera_feed = core.StandIn(self, "camera_feed")
        console.uploads = core.StandIn(self, "uploads")
        console.uploads._returns["attach"] = []
        console.annotations = core.StandIn(self, "annotations")
        console.health_checks = core.StandIn(self, "health_checks")
        console.preview = core.StandIn(self, "preview", is_encoding=True, error_text=None)
        console.recordings = Recordings(self, "recordings", is_enabled=True, active_segment=None)
        console.commands = Commands(console)
        self.watchdog = object.__new__(Watchdog)  # PEAR's own, without its thread: a step calls its _check
        self.watchdog.console = console

        emit, stop = console.emit, console.stop  # PEAR's own, which still run
        set_phase = Console.set_phase.__get__(console)  # PEAR's own, in the place of the rig's recording one

        def recorded_emit(kind: Any, data: dict[str, Any], **keywords: Any) -> dict[str, Any]:
            event = emit(kind, data, **keywords)
            with self.lock:
                self.event_threads[event["id"]] = self.thread()
            return event

        def recorded_set_phase(phase: Any) -> None:
            with self.lock:
                self.set_phases[self.thread()].append(core.plain(phase.value))
            set_phase(phase)

        def ordered_stop(**keywords: Any) -> dict[str, Any]:
            """PEAR's Console.stop(); the worker's cancellation is set once it has returned or raised."""
            cancellation = console.cancellation
            console.cancellation = threading.Event()  # what stop() sets, in the place of the worker's
            try:
                return stop(**keywords)
            finally:
                console.cancellation = cancellation
                cancellation.set()
                if self.is_released_by_stop and self.point is not None:
                    # the command itself waits for the worker to end: the worker leaves its point here
                    self.point = None
                    self.released.set()

        console.emit = recorded_emit
        console.set_phase = recorded_set_phase
        console.stop = ordered_stop

    def close(self) -> None:
        """Lets every thread of the scenario end, then closes the robot."""
        self.point = None
        self.released.set()
        self.console.cancellation.set()
        worker = self.console.worker
        if worker is not None:
            worker.join(WAIT_S)
        super().close()

    @staticmethod
    def thread() -> str:
        current = threading.current_thread()
        if current.name == Console.WORKER_THREAD_NAME:
            return "worker"

        return "main" if current is threading.main_thread() else "model"

    # ---- the hand-over ----

    def act(self, operation: dict[str, Any]) -> None:
        if operation["do"] != "hand_over":
            super().act(operation)
            return
        self.point = operation["point"]
        self.released.clear()
        self.reached.set()
        if not self.released.wait(WAIT_S):
            raise AssertionError(f"the main thread never left {operation['point']!r}")
        for following in operation.get("then", []):
            self.act(following)

    def wait_point(self, name: str) -> None:
        """Waits, on the main thread, until the worker waits at the point ``name``."""
        console = self.console
        started = REAL_MONOTONIC()
        while not self.reached.wait(0.005):
            worker = console.worker
            if worker is None or not worker.is_alive():
                raise AssertionError(f"the worker ended before {name!r}: {console.error}")
            if REAL_MONOTONIC() - started > WAIT_S:
                raise AssertionError(f"the worker never came to {name!r}")
        self.reached.clear()
        if self.point != name:
            raise AssertionError(f"the worker waits at {self.point!r}, not at {name!r}")

    def dwell(self) -> None:
        if self.dwell_s:
            threading.Event().wait(self.dwell_s)

    # ---- a step and its record ----

    def step(self, spec: dict[str, Any]) -> dict[str, Any]:
        console, current = self.console, self.current
        if "turns" in spec:
            if current["asked"] != len(current["turns"]):
                raise AssertionError("the model's script before this one was not asked to its end")
            current.update(turns=copy.deepcopy(spec["turns"]), asked=0)
        if "hooks" in spec:
            if current["hooks"]:
                raise AssertionError(f"hooks that never acted: {current['hooks']}")
            current["hooks"] = copy.deepcopy(spec["hooks"])
        current["model_inputs"] = []
        with self.lock:
            for thread in THREADS:
                self.calls[thread].clear()
                self.set_phases[thread].clear()
        at = spec.get("at")
        if at != self.point:
            raise AssertionError(f"the step is given at {at!r}, and the worker waits at {self.point!r}")

        self.dwell()
        first_event = console.last_event_id
        returned = raised = None
        self.is_released_by_stop = spec.get("release") == STOPPED
        try:
            if spec.get("op") == CHECK:
                self.watchdog._check()  # noqa: SLF001
            else:
                returned = console.commands.run(spec["command"], copy.deepcopy(spec["data"]))
        except Exception as error:  # noqa: BLE001
            raised = {"type": type(error).__name__, "message": str(error)}
        self.is_released_by_stop = False
        self.dwell()

        until = spec["until"]
        if until == ENDED:
            if self.point is not None:
                self.point = None
                self.released.set()
            worker = console.worker
            if worker is not None:
                worker.join(WAIT_S)
                if worker.is_alive():
                    raise AssertionError("the worker did not end")
        elif until != self.point:
            if self.point is not None:
                raise AssertionError(f"the worker still waits at {self.point!r}")
            self.wait_point(until)

        return self.record(spec, returned, raised, first_event)

    def finish(self) -> None:
        """Checks, after the last step, that the scenario's script was played to its end."""
        current = self.current
        if self.console.is_busy:
            raise AssertionError("the scenario ends while the worker runs")
        if current["asked"] != len(current["turns"]):
            raise AssertionError(f"the model was asked {current['asked']} times of {len(current['turns'])}")
        if current["hooks"] or self.clock.after_tick is not None:
            raise AssertionError(f"hooks that never acted: {current['hooks']}")

    def fields(self) -> dict[str, Any]:
        console = self.console

        return {
            "phase": core.plain(console.phase.value),
            "error": console.error,
            "is_stop_latched": console.is_stop_latched,
            "performance": copy.deepcopy(console.performance),
            "home_status": copy.deepcopy(console.home_status),
            "is_busy": console.is_busy,
        }

    def record(
        self, spec: dict[str, Any], returned: dict[str, Any] | None, raised: dict[str, Any] | None, first_event: int
    ) -> dict[str, Any]:
        console = self.console
        task_run = console.task_run
        if console.error is not None and console.error.startswith("AssertionError"):
            raise AssertionError(f"the script failed on the worker: {console.error}")
        with self.lock:
            threads = dict(self.event_threads)
            calls = {thread: list(self.calls[thread]) for thread in THREADS}
            phases = {thread: list(self.set_phases[thread]) for thread in THREADS}
        saved: dict[int, Any] = {}
        for path in sorted(console.root.glob(f"*/{TaskFiles.EVENTS_NAME}")):
            saved.update((event["id"], event) for event in map(json.loads, path.read_text().splitlines()))
        events = []
        for event in list(console.events):
            if event["id"] <= first_event:
                continue
            value = core.plain(event)
            if event["id"] in saved and saved[event["id"]] != value:
                raise AssertionError(f"events.jsonl holds another event {event['id']}")
            events.append({**value, "thread": threads[event["id"]], "saved": event["id"] in saved})
        if len(events) != console.last_event_id - first_event:
            raise AssertionError("the console kept fewer events than it published")
        session = task_run.session
        clock = {"sleeps": len(self.clock.take()), "monotonic_s": self.clock.now, "wall_readings": self.wall.reads}

        return self.scrubbed(
            {
                **({"op": spec["op"]} if "op" in spec else {}),
                "command": spec.get("command"),
                "data": spec.get("data"),
                "at": spec.get("at"),
                "until": spec["until"],
                **({"release": spec["release"]} if "release" in spec else {}),
                "script": {key: spec[key] for key in ("turns", "hooks") if key in spec},
                "returned": None if returned is None else core.plain(returned),
                "raised": raised,
                "events": events,
                "phases": phases,
                "console": self.fields(),
                "task": copy.deepcopy(task_run.task),
                "task_run": {
                    "total_steps": task_run.total_steps,
                    "turn_number": task_run.turn_number,
                    "active_attempt_id": task_run.active_attempt_id,
                    "active_turn": copy.deepcopy(task_run.active_turn),
                    "resume_pending": task_run.resume_pending,
                    "inference_started_at": task_run.inference_started_at,
                    "has_session": task_run.session is not None,
                    "has_client": task_run.model_client is not None,
                },
                "session": None
                if session is None
                else {
                    "turn_count": session.turn_count,
                    "blocked_reason": session.blocked_reason,
                    "previous_result": None
                    if session.previous_result is None
                    else session.previous_result.to_record(),
                },
                "robot_status": str(self.status()["status"]),
                "files": self.tree(),
                "calls": calls,
                "model_inputs": list(self.current["model_inputs"]),
                "ik": self.rig.take_ik(),
                "ids": {name: ids.take() for name, ids in self.ids.items()},
                "clock": clock,
            }
        )

    def tree(self) -> list[dict[str, Any]]:
        """Every file under the console's root, as a step's `files` holds it."""
        root = self.console.root
        entries = []
        paths = {path.relative_to(root).as_posix(): path for path in root.rglob("*") if path.is_file()}
        for name in sorted(paths):
            path = paths[name]
            data = path.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            entry: dict[str, Any] = {"name": name}
            if self.file_hashes.get(name) == digest:
                entry["unchanged"] = True
            elif path.name == TaskFiles.EVENTS_NAME:
                entry["event_ids"] = [json.loads(line)["id"] for line in data.decode().splitlines()]
            elif path.suffix == ".json":
                entry["json"] = json.loads(data)
            else:
                entry["size"], entry["sha256"] = len(data), digest
            self.file_hashes[name] = digest
            entries.append(entry)

        return entries


class Scenarios:
    """The scenarios of PEAR's Commands running a task, in the order a task goes through them."""

    ASKED = "turn 3: the model is asked"  # the point at which the first scenario's pause is given
    # the second scenario's points
    SECOND = "turn 2: the model is asked"
    RESUMED = "turn 4: the model is asked"
    AGAIN = "the second task's turn 2: the model is asked"
    MOVING = "turn 1: the action moves the arm"  # ten control periods into the action, inside its next sleep

    def __init__(self, rig: Any, monkeypatch: pytest.MonkeyPatch, directory: Path, dwell_s: float) -> None:
        self.rig = rig
        self.monkeypatch = monkeypatch
        self.directory = directory
        self.dwell_s = dwell_s
        self.count = 0

    def play(self, name: str, pins: str, steps: list[dict[str, Any]]) -> dict[str, Any]:
        self.count += 1
        print(f"scenario {self.count}: {name}", file=sys.stderr)
        root = self.directory / f"console-{self.count}"
        root.mkdir()
        stage = Stage(self.rig, self.monkeypatch, NUMBER_BASE + self.count, root, self.dwell_s)
        try:
            recorded = {
                "name": name,
                "pins": pins,
                "robot_session_id": stage.robot.session_id,
                "control_period_s": stage.robot.control_period_s,
                "model_timeout_s": task_rig.MODEL_TIMEOUT_S,
                # what the rig drew and slept before the first step (the robot's session; its opening)
                "ids_before": {name: ids.take() for name, ids in stage.ids.items()},
                "sleeps_before": len(stage.clock.take()),
                "monotonic_s_before": stage.clock.now,
                "console_before": stage.fields(),
                "robot_status_before": str(stage.status()["status"]),
                "ik_before": stage.rig.take_ik(),
                "steps": [stage.step(spec) for spec in steps],
            }
            stage.finish()
        finally:
            stage.close()

        return recorded

    @staticmethod
    def asked(point: str) -> dict[str, Any]:
        """A request during which the main thread gives commands: the model reports, waits until the loop has
        looked at the robot's hold, hands over at ``point``, then waits until the loop stops its request and
        answers."""
        return {
            "model": [
                {"emit": ["reasoning_delta", {"text": "Still thinking.", "reasoning_kind": "full"}]},
                {"do": "wait_watch"},
                {"do": "hand_over", "point": point},
                {"do": "wait_stop"},
                *says(action(z=0.5), ""),
            ]
        }

    def all(self) -> list[dict[str, Any]]:
        lift = turn(task_rig.Scenarios.LIFT)  # a small move: half a centimetre up
        grip = turn(action(-1.0), "Close the gripper.")  # a gripper action: the arm stays where it is
        asked = self.asked(self.ASKED)
        check = {"op": CHECK, "until": ENDED}
        rise = turn("Higher.\n" + action(z=1.5), "A longer move.")  # a move of many control periods

        return [
            self.play(
                "start, two turns, pause while the model is asked",
                "commands.py: `start` is admitted (run, 74 to 97), _start (219 to 277) makes the task's folder and "
                "task.json, publishes the event task and starts the recorded loop (424 to 438: recordings.start, "
                "then Console.launch with the cancellation made there); console.py: the worker (_operate, 234 to "
                "260) runs TaskRun.run, two turns complete and settle (task_run.py 107 and 108) and the third "
                "turn's model is asked. Then `pause` (commands.py 111 to 113; immediate: 81 and 82) runs "
                "Console.stop (console.py 109 to 131) on the main thread; the worker ends the turn as interrupted "
                "(task_run.py 109 to 112), _operate sets the phase Stopping (console.py 241 and 242) and stops the "
                "recording with \"Task paused\" (257 and 258)",
                [
                    {
                        "command": "start",
                        "data": {"instruction": "Lift the cube."},
                        "turns": [lift, grip, asked],
                        "until": self.ASKED,
                    },
                    {"command": "pause", "data": {}, "at": self.ASKED, "until": ENDED},
                ],
            ),
            self.play(
                "pause, the watchdog's check, resume, a resume refused, pause, clear, start again",
                "commands.py: `start` (219 to 277) and, while the second turn's model is asked, `pause` (111 to 113), "
                "as in the first scenario: the turn ends as interrupted and the session is kept (task_run.py 109 to "
                "112). watchdog.py: a check (_check, 30 to 66) that has nothing else to do settles the phase "
                "Stopping into the idle phase of a ready robot that has a task, Paused (58 to 66), on the thread "
                "that checks. commands.py: `resume` (279 to 290) starts the recorded loop again (424 to 438: a new "
                "cancellation, recordings.start, Console.launch); task_run.py: run (64 to 112) finds the session "
                "and no resume pending (72 to 75), so no session is opened and no event session is published: turn "
                "3 opens in the same episode, its request tells the model of the interrupted turn (the previous "
                "execution's error OperatorPaused), it completes, and turn 4's model is asked. A second `resume` "
                "given there is refused because the worker runs (commands.py 86 and 87) and changes nothing: no "
                "event, phase, call, file or reading of a clock. `pause` again; then `clear` (292 to 294; nothing "
                "runs, so _stop_before, 84 and 85, is not called) launches _clear_task (296 to 305) on a new "
                "worker: the session is closed, the event task_end is saved in the task's events.jsonl, task, "
                "total_steps, active_attempt_id and active_turn are reset (turn_number is not: _start resets it, "
                "274) and the phase is the idle phase of a ready robot without a task, Holding (305); _operate "
                "has no recording to stop (console.py 257). `start` again (commands.py 223: no task is there) "
                "makes a new task id and a second folder beside the first under the same root, opens a new session "
                "(task_run.py 74 and 75) and counts the turns from 1; a last `pause` ends the worker",
                [
                    {
                        "command": "start",
                        "data": {"instruction": "Lift the cube."},
                        "turns": [lift, self.asked(self.SECOND)],
                        "until": self.SECOND,
                    },
                    {"command": "pause", "data": {}, "at": self.SECOND, "until": ENDED},
                    check,
                    {"command": "resume", "data": {}, "turns": [grip, self.asked(self.RESUMED)], "until": self.RESUMED},
                    {"command": "resume", "data": {}, "at": self.RESUMED, "until": self.RESUMED},
                    {"command": "pause", "data": {}, "at": self.RESUMED, "until": ENDED},
                    {"command": "clear", "data": {}, "until": ENDED},
                    {
                        "command": "start",
                        "data": {"instruction": "Lift the cube again."},
                        "turns": [lift, self.asked(self.AGAIN)],
                        "until": self.AGAIN,
                    },
                    {"command": "pause", "data": {}, "at": self.AGAIN, "until": ENDED},
                ],
            ),
            self.play(
                "clear while the task runs",
                "commands.py: `clear` is given while the second turn's model is asked: the worker runs, so run (84 "
                "and 85) calls _stop_before (99 to 109) on the main thread: Console.stop with the reason "
                "\"Stopping before clear\" (103; console.py 109 to 131: robot.stop, the phase Stopping, "
                "recordings.stop with that reason, the event stopping), then the join of the worker (105), which "
                "ends the turn as interrupted (task_run.py 109 to 112), sets the phase Stopping and stops the "
                "recording with \"Task paused\" (console.py 241, 242, 257 and 258), then robot.wait_settled, the "
                "robot being neither off nor faulted (108 and 109). Nothing runs any more (86), so _clear (292 to "
                "294) launches _clear_task (296 to 305) on a new worker: the session is closed, the event task_end "
                "is saved, the task's fields are reset and the phase is the idle phase without a task (305)",
                [
                    {
                        "command": "start",
                        "data": {"instruction": "Lift the cube."},
                        "turns": [lift, self.asked(self.SECOND)],
                        "until": self.SECOND,
                    },
                    {"command": "clear", "data": {}, "at": self.SECOND, "release": STOPPED, "until": ENDED},
                ],
            ),
            self.play(
                "STOP MOTION while an action moves the arm, reset, resume",
                "commands.py: `stop` (115 to 117; immediate: 81 and 82) is given ten control periods into the first "
                "turn's action, while the worker is inside robot.execute and the arm moves: Console.stop with "
                "is_latching and the reason \"STOP MOTION activated\" (console.py 109 to 131: robot.stop, the latch "
                "at 121 and 122, the phase Stopping, recordings.stop with that reason, the event stopping); the "
                "action ends where the arm stopped, the turn ends as interrupted (task_run.py 109 to 112) and the "
                "worker ends (console.py 241, 242, 257 and 258). `resume` is refused by the latch (commands.py 88 "
                "and 89) and changes nothing. watchdog.py: the check settles the phase Stopping into the idle "
                "phase of a latched console, Stopped (58 to 66). commands.py: `reset_stop` (125 to 139) releases "
                "the latch of the stopped, stable robot and shows the idle phase of a task, Paused (134 to 137). "
                "`resume` (279 to 290) runs the task's turns again in its session: turn 2's request tells the "
                "model of the action that was stopped (the previous execution failed, not reached, with the error "
                "OperatorPaused); a `pause` while that model is asked ends the worker",
                [
                    {
                        "command": "start",
                        "data": {"instruction": "Lift the cube."},
                        "turns": [rise],
                        "hooks": [
                            {
                                "on": "phase",
                                "phase": "Executing",
                                "do": "hand_over",
                                "point": self.MOVING,
                                "after_sleeps": 10,
                            }
                        ],
                        "until": self.MOVING,
                    },
                    {"command": "stop", "data": {}, "at": self.MOVING, "until": ENDED},
                    {"command": "resume", "data": {}, "until": ENDED},
                    check,
                    {"command": "reset_stop", "data": {}, "until": ENDED},
                    {"command": "resume", "data": {}, "turns": [self.asked(self.SECOND)], "until": self.SECOND},
                    {"command": "pause", "data": {}, "at": self.SECOND, "until": ENDED},
                ],
            ),
        ]


def constants() -> dict[str, Any]:
    """PEAR's constants that the scenarios turn on."""
    return {
        "WORKER_JOIN_S": Console.WORKER_JOIN_S,
        "SETTLE_TIMEOUT_S": Console.SETTLE_TIMEOUT_S,
        "WORKER_THREAD_NAME": Console.WORKER_THREAD_NAME,
        "PAUSE_REASON": Console.PAUSE_REASON,
        "STOPPING_EVENT": Console.STOPPING_EVENT,
        "ERROR_EVENT": Console.ERROR_EVENT,
        "MAX_INSTRUCTION_CHARS": Commands.MAX_INSTRUCTION_CHARS,
        "RECORD_URL": RECORD_URL,
        "EVENTS_NAME": TaskFiles.EVENTS_NAME,
    }


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
    parser.add_argument("--dwell-s", type=float, default=0.0, help="a check: wait that long around every command")
    arguments = parser.parse_args()
    directory = FIXTURES if arguments.output is None else arguments.output.resolve()

    commit, pinned = robot_fixtures.Commit.of_pear(), robot_fixtures.Commit.pinned()
    if commit != pinned:
        sys.exit(
            f"This PEAR is at {commit or 'no commit that can be read (it is not a checkout)'}; "
            f"src/index.ts pins {pinned}",
        )

    robot_fixtures.silence()
    monkeypatch = pytest.MonkeyPatch()
    try:
        rig = robot_fixtures.Rig(monkeypatch, task_rig.SEED)
        with tempfile.TemporaryDirectory() as temporary:
            scenarios = Scenarios(rig, monkeypatch, Path(temporary), arguments.dwell_s).all()
    finally:
        monkeypatch.undo()

    steps = [step for scenario in scenarios for step in scenario["steps"]]
    meta = {
        "pear_commit": commit,
        "versions": {"python": sys.version.split()[0], "numpy": np.__version__, "pydantic": pydantic.VERSION},
        "seed": task_rig.SEED,
        "number_base": NUMBER_BASE,
        "station": "so101",
        "model": task_rig.MODEL,
        "root": task_rig.ROOT,
        "threads": list(THREADS),
        "start_s": task_rig.StandInClock.START_S,
        "wall_start_s": task_rig.WallClock.START_S,
        "wall_step_s": task_rig.WallClock.STEP_S,
        "constants": constants(),
        "counts": {
            "scenarios": len(scenarios),
            "steps": len(steps),
            "steps_that_raised": sum(step["raised"] is not None for step in steps),
            "events": sum(len(step["events"]) for step in steps),
            "events_saved": sum(event["saved"] for step in steps for event in step["events"]),
            "model_requests": sum(len(step["model_inputs"]) for step in steps),
            "calls": sum(len(calls) for step in steps for calls in step["calls"].values()),
            "kinematics_answers": sum(len(step["ik"]) for step in steps),
        },
    }
    write(directory, meta, scenarios)
    print(json.dumps(meta["counts"]))


if __name__ == "__main__":
    main()
