#!/usr/bin/env python3
"""Generates tests/fixtures/console/console.json from PEAR's own classes: the operator console (Console of
pear/deploy/station/gui/console/console.py), its Home review (HomeReview of home_review.py) and its control lease
(ControlLease of lease.py), all three unchanged, through scripted scenarios.

Run it from a checkout of PEAR, with PEAR's Python (it needs no GPU and no hardware):

    cd <PEAR> && PYTHONDONTWRITEBYTECODE=1 <PEAR's python> <pear.js>/tools/fixtures/console_core_fixtures.py

The rig. The console is PEAR's own Console made without its constructor (object.__new__(Console)): the constructor
makes the robot of a station's config, the cameras' feed, the rendered recordings, the preview, the commands and the
watchdog, which a test does not have. It is given every attribute the constructor sets, with the constructor's
values (console.py lines 52 to 87): so it starts in the phase Disabled, with no error, no latch, no worker and no
event. Its `lease` is PEAR's ControlLease(lambda: console.is_busy), its `home_review` PEAR's HomeReview(console.lock),
its `models_config` PEAR's ModelsConfig of the two models of meta.models (PEAR's OfferedModel on the stand-in
scripted client of PEAR's tests; no model is asked anything). Every method of Console, HomeReview and ControlLease
that a scenario calls is PEAR's, unchanged, and launch() runs PEAR's _operate on PEAR's own worker thread.

What stands in. Each of these records every call made of it, in order, with its arguments, and does nothing else:
`robot` (a scripted robot, not PEAR's: its status() returns the scenario's scripted status, a new copy at every
call, whatever `with_snapshot`; profile() returns meta.robot_profile; session_id is scripted), `recordings`
(snapshot() returns meta.recording), `preview` (status() returns meta.cameras), `health_checks` (get() and check()
return the scripted model health, null at first), `task_run` (its fields task, active_turn, session, total_steps and
inference_started_at are the scenario's; close_session() is recorded), `watchdog`, `uploads`, `annotations`,
`commands` and `camera_feed`. A scripted status holds only the keys the console reads: status, generation, fault,
fault_details and motion.settling. A stand-in's call raises RuntimeError(message) after it is recorded where a
scenario scripts it to.

Deterministic. `time` of console.py and of lease.py and uuid4 of home_review.py are scripted, new for every
scenario: time.time() reads meta.wall_start_s + n * meta.wall_step_s at its n-th reading (n from 0); time.monotonic()
reads meta.monotonic_start_s + (the seconds the scenario advanced) + n * the scenario's monotonic_step_s at its n-th
reading; time.time_ns() reads meta.ns_start + n * meta.ns_step; uuid4 is a seeded sequence (the scenario's `uuids`,
in the order drawn; a plan_id is the UUID's hex). The worker thread is joined, or waits where the script holds it,
before a step's record is taken. Two runs give the same bytes.

The file: {"meta": {...}, "scenarios": [...]}, one scenario a line. A scenario:

  name, pins        what it is and which lines of PEAR it pins
  monotonic_step_s  what every reading of time.monotonic() adds
  initial           the console's fields (below) before the first step
  uuids             the UUIDs drawn in the scenario, in order
  steps             in order, each one step:
    script     the step as the scenario scripts it (below); `raises` in it is the class the script expects, checked
    returned   what the call returned, as JSON with the keys in PEAR's order (null for a script's own step)
    raised     null, or {"type": the class's name, "message": str of it}
    events     every event Console.emit made during the step, in the order of their ids, as emit made it (id, type,
               data, time, monotonic_s, task_id), and two keys of the record: `saved` (whether events.jsonl of the
               event's task holds the event as one of its lines) and `thread` ("main" or "worker")
    phases     {"main": [...], "worker": [...]}: every phase Console.set_phase was given during the step, by the
               thread that gave it, each thread's in order
    calls      {"main": [...], "worker": [...]}: every call made of the robot and of the stand-ins during the step,
               by thread, each thread's in order: {"of": the stand-in's name, "call": the method, "arguments": [...],
               "keywords": {...}, "after_event": console.last_event_id when the call began, "returned"?: what it
               returned unless None, "raised"?: {"type", "message"}}. Between the two threads the record keeps no
               order.
    operations what the operations of launch() that ended during the step did, in order: {"cancellation_is_the_
               consoles": whether the Event the operation was given is console.cancellation, "cancellation_was_set":
               whether it was set when the operation began, "returned" or "raised": {"type", "message"}}
    fields     the console after the step: phase, error, is_stop_latched, performance, home_status,
               saved_fault_identity (null or [the robot's session, the generation]), is_busy, worker ("none",
               "running" or "ended"), last_event_id, events_kept (how many console.events holds), first_kept_event_id
               and last_kept_event_id (null without one), cancellation_is_set, home_review {plan, decision,
               answered}, lease {owner, heartbeat_at}
    files      every file under the console's root after the step, sorted by name (the path under the root):
               {"name", "json": its value} for a .json file; {"name", "event_ids": the ids of its lines} for a
               .jsonl file
    clock      wall_readings, monotonic_readings, ns_readings (the readings so far in the scenario) and monotonic_s
               (what the next reading of time.monotonic() gives)

A step's script is {"op": ..., ...}. The calls of PEAR:

  {"op": "emit", "kind", "data", "is_saved"?, "repeat"?}   console.emit(kind, data[, is_saved=]); with `repeat` it
        is called that many times, the i-th call (from 0) with data plus {"n": i}; `returned` is the last event
  {"op": "stop", "is_latching"?, "reason"?, "join"?}       console.stop(...) with the keywords given
  {"op": "launch", "operation", "cancellation"?, "is_recorded"?}
        console.launch(operation[, cancellation=][, is_recorded=]); `cancellation` "new" gives a new Event, "set"
        one that is already set, absent none. `operation` is what the operation does when the worker calls it:
        {"do": "return"}; {"do": "raise", "error": {"type", "message", "details"?}} (type OperatorPaused,
        RuntimeError or HomeFailed, which takes `details`); {"do": "block", "then"?: operation} waits until a later
        step {"op": "release_operation"}, then does `then` (default: returns); {"do": "home_review", "plan"} returns
        home_review.wait_for_decision(home_review.prepare(plan), cancellation). After a launch that did not raise
        the script waits: for the worker's end (return, raise), until the operation blocks (block) or until the
        plan is published and the operation waits for the answer (home_review).
  {"op": "snapshot"}   console.snapshot()          {"op": "close"}   console.close()
  {"op": "confirm", "plan_id", "is_confirmed", "join"?}    console.home_review.confirm(plan_id, is_confirmed); a
        plan_id of "current" is the plan_id of the plan under review
  {"op": "home_review", "method": "prepare", "plan"}       home_review.prepare(plan); the script keeps what it returns
  {"op": "home_review", "method": "wait_for_decision", "cancelled", "decision"?}   on the main thread:
        home_review.wait_for_decision(the plan the last prepare returned, a new Event, set when `cancelled`); with
        `decision` the script first writes home_review.decision (an answer that arrived before the wait)
  {"op": "lease", "method", "client_id"?}                  console.lease.<method>([client_id])
  {"op": "robot_status"}, {"op": "phase"}, {"op": "is_busy"}, {"op": "supports_reference_images"}
        console.robot_status(), .phase, .is_busy, .supports_reference_images()
  {"op": "action_format"}   {"name": console.action_format.name}
  {"op": "set_phase", "phase"}   console.set_phase(Phase[phase]): the script names the member, the record's
        `phases` hold its word (meta.constants.phase)
  {"op": "check_model", "is_forced"?}   console.check_model([is_forced=])
  {"op": "new_client", "model", "instruction"}   {"class": the class's name of console.new_client(model, instruction)}

`join` on a step: the script waits for the worker's end after the call, before the record is taken. The script's
own steps (no call of PEAR; `returned` is null):

  {"op": "set", ...}   writes, in this order, the keys given: task (task_run.task; a task's folder <root>/<id> is
        made, as the command that starts a task leaves it), active_turn, session_turn_count (task_run.session: null,
        or a session whose turn_count is that), total_steps, inference_started_at (all of task_run); robot (the
        status the robot returns from then on), robot_session_id; model_health; model, performance, home_status,
        error (the console's fields); home_plan (home_review.plan); failing ({"of", "call", "message"}: that call of
        that stand-in raises from then on; null: none does)
  {"op": "advance", "seconds"}   lets that much time pass on time.monotonic()
  {"op": "release_operation"}    lets a blocked operation go on and waits for the worker's end
  {"op": "wake"}                 sets home_review.answered, as a STOP does, with no answer and no cancellation, and
                                 waits until the waiting operation has cleared it and waits again
"""

from __future__ import annotations

import argparse
import copy
import gzip
import json
import sys
import tempfile
import threading
import time
from collections import deque
from enum import Enum
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pydantic
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import console_fixtures  # noqa: E402,F401  (it prepares the path of the stand-ins of PEAR's tests)
import robot_fixtures  # noqa: E402

from pear.deploy.station.agent_loop.config import ModelsConfig, OfferedModel  # noqa: E402
from pear.deploy.station.control.motion.homing import HomeFailed  # noqa: E402
from pear.deploy.station.control.schemas import RobotStatus  # noqa: E402
from pear.deploy.station.exceptions import OperatorPaused  # noqa: E402
from pear.deploy.station.gui.console import console as console_module  # noqa: E402
from pear.deploy.station.gui.console import home_review as home_review_module  # noqa: E402
from pear.deploy.station.gui.console import lease as lease_module  # noqa: E402
from pear.deploy.station.gui.console.console import Console  # noqa: E402
from pear.deploy.station.gui.console.home_review import HomeReview, HomeStatus  # noqa: E402
from pear.deploy.station.gui.console.lease import ControlLease  # noqa: E402
from pear.deploy.station.gui.console.phase import Phase  # noqa: E402
from pear.deploy.station.records.task_files import TaskFiles  # noqa: E402

REPOSITORY = Path(__file__).resolve().parents[2]
FIXTURES = REPOSITORY / "tests" / "fixtures" / "console"
NAME = "console.json"
PACK_ABOVE_BYTES = 300_000  # a larger file is written as gzip (NAME + ".gz")
SEED = console_fixtures.SEED + 5000
MODELS = {"stand_in": "Stand-in", "second": "Second stand-in"}  # the models the console offers: name and label
MODEL = "stand_in"  # the default model
WAIT_S = 20.0  # (on the machine's clock) the longest this script waits for the worker
THREADS = ("main", "worker")
ROBOT_PROFILE = {"stand_in": "profile"}
RECORDING = {"stand_in": "recording"}
CAMERAS = {"stand_in": "cameras"}
ROBOT_SESSION = "robot-session-1"


def plain(value: Any) -> Any:
    """Returns ``value`` as JSON reads it back: a copy, an enum as its value, a tuple as a list."""

    def fallback(item: Any) -> Any:
        if isinstance(item, Enum):
            return item.value
        if isinstance(item, pydantic.BaseModel):
            return item.model_dump(mode="json")
        return {"object": type(item).__name__}

    return json.loads(json.dumps(value, default=fallback, allow_nan=False))


class Clock:
    """The scripted clocks of one scenario."""

    WALL_START_S = 1_800_000_000.0
    WALL_STEP_S = 0.125
    MONOTONIC_START_S = 1000.0
    NS_START = 1_800_000_000_000_000_000
    NS_STEP = 1_000_000_000

    def __init__(self, monotonic_step_s: float) -> None:
        self.lock = threading.Lock()
        self.monotonic_step_s = monotonic_step_s
        self.advanced_s = 0.0
        self.wall_readings = self.monotonic_readings = self.ns_readings = 0

    def time(self) -> float:
        with self.lock:
            self.wall_readings += 1
            return self.WALL_START_S + (self.wall_readings - 1) * self.WALL_STEP_S

    def next_monotonic(self) -> float:
        return self.MONOTONIC_START_S + self.advanced_s + self.monotonic_readings * self.monotonic_step_s

    def monotonic(self) -> float:
        with self.lock:
            value = self.next_monotonic()
            self.monotonic_readings += 1
            return value

    def time_ns(self) -> int:
        with self.lock:
            self.ns_readings += 1
            return self.NS_START + (self.ns_readings - 1) * self.NS_STEP

    def record(self) -> dict[str, Any]:
        return {
            "wall_readings": self.wall_readings,
            "monotonic_readings": self.monotonic_readings,
            "ns_readings": self.ns_readings,
            "monotonic_s": self.next_monotonic(),
        }


class StandIn:
    """What stands in for a part of the console: it records every call made of it."""

    def __init__(self, stage: Stage, name: str, **attributes: Any) -> None:
        self.__dict__.update(attributes)
        self._stage, self._name = stage, name
        self._returns: dict[str, Any] = {}

    def __getattr__(self, method: str) -> Any:
        if method.startswith("_"):
            raise AttributeError(method)

        def call(*arguments: Any, **keywords: Any) -> Any:
            stage = self._stage
            entry: dict[str, Any] = {
                "of": self._name,
                "call": method,
                "arguments": plain(list(arguments)),
                "keywords": plain(keywords),
                "after_event": stage.console.last_event_id,
            }
            raises = stage.raises
            try:
                if raises and raises["of"] == self._name and raises["call"] == method:
                    entry["raised"] = {"type": "RuntimeError", "message": raises["message"]}
                    raise RuntimeError(raises["message"])
                value = plain(self._returns.get(method))
                if value is not None:
                    entry["returned"] = copy.deepcopy(value)
                return value
            finally:
                with stage.lock:
                    stage.calls[stage.thread()].append(entry)

        return call


class Stage:
    """One scenario's rig: new clocks, a new sequence of UUIDs, PEAR's console and what stands in around it."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, number: int, root: Path, monotonic_step_s: float) -> None:
        self.root = root
        root.mkdir()
        self.clock = Clock(monotonic_step_s)
        self.ids = robot_fixtures.Ids(SEED + number)
        clock = self.clock
        stand_in_time = SimpleNamespace(time=clock.time, monotonic=clock.monotonic, time_ns=clock.time_ns)
        monkeypatch.setattr(console_module, "time", stand_in_time)
        monkeypatch.setattr(lease_module, "time", SimpleNamespace(monotonic=clock.monotonic))
        monkeypatch.setattr(home_review_module, "uuid4", self.ids.next)

        self.lock = threading.Lock()  # of the lists below, which two threads write
        self.events: list[dict[str, Any]] = []
        self.phases: dict[str, list[str]] = {thread: [] for thread in THREADS}
        self.calls: dict[str, list[dict[str, Any]]] = {thread: [] for thread in THREADS}
        self.operations: list[dict[str, Any]] = []
        self.raises: dict[str, Any] | None = None
        self.reached, self.release = threading.Event(), threading.Event()
        self.review_plan: dict[str, Any] | None = None

        def never(*arguments: Any, **keywords: Any) -> Any:
            raise AssertionError("no scenario asks the model anything")

        models = {
            name: OfferedModel(
                label=label,
                client_class="stand_in_clients.StandInScriptedClient",
                client={"answer": never},
                timeout_s=60.0,
            )
            for name, label in MODELS.items()
        }
        # as Console.__init__ leaves a console (console.py lines 52 to 87), with the stand-ins in the place of the
        # parts a test does not have
        console = object.__new__(Console)
        self.console = console
        console.root = root
        console.models_config = ModelsConfig(
            robot_class="stand_in_robots.SteppedStandInSO101Robot",
            config_dir=str(root),
            default_model=MODEL,
            models=models,
        )
        console.camera_feed = StandIn(self, "camera_feed")
        console.robot = StandIn(self, "robot", session_id=ROBOT_SESSION)
        console.robot._returns.update(status=self.robot_state("OFF"), profile=ROBOT_PROFILE)
        console.uploads = StandIn(self, "uploads")
        console.recordings = StandIn(self, "recordings")
        console.recordings._returns.update(snapshot=RECORDING)
        console.annotations = StandIn(self, "annotations")
        console.lock = threading.RLock()
        console.events = deque(maxlen=Console.EVENT_CAPACITY)
        console.last_event_id = 0
        console.lease = ControlLease(lambda: console.is_busy)
        console.model = console.models_config.default_model
        console.health_checks = StandIn(self, "health_checks")
        console.worker = None
        console.cancellation = threading.Event()
        console._phase = Phase.DISABLED
        console.error = None
        console.is_stop_latched = False
        console.performance = None
        console.home_status = None
        console.saved_fault_identity = None
        console.task_run = StandIn(
            self, "task_run", task=None, active_turn=None, session=None, total_steps=0, inference_started_at=None
        )
        console.home_review = HomeReview(console.lock)
        console.commands = StandIn(self, "commands")
        console.preview = StandIn(self, "preview")
        console.preview._returns.update(status=CAMERAS)
        console.watchdog = StandIn(self, "watchdog")

        emit, set_phase = console.emit, console.set_phase  # PEAR's own, which still run

        def recorded_emit(kind: Any, data: dict[str, Any], **keywords: Any) -> dict[str, Any]:
            event = emit(kind, data, **keywords)
            with self.lock:
                self.events.append({**plain(event), "thread": self.thread()})
            return event

        def recorded_set_phase(phase: Phase) -> None:
            with self.lock:
                self.phases[self.thread()].append(plain(phase.value))
            set_phase(phase)

        console.emit = recorded_emit
        console.set_phase = recorded_set_phase

    @staticmethod
    def thread() -> str:
        return "worker" if threading.current_thread().name == Console.WORKER_THREAD_NAME else "main"

    @staticmethod
    def robot_state(status: str, **keys: Any) -> dict[str, Any]:
        """A scripted status of the robot: the keys the console reads."""
        state = {"status": status, "generation": 0, "fault": None, "fault_details": None, "motion": {"settling": False}}
        return {**state, **keys}

    # ---- the worker ----

    def join(self) -> None:
        worker = self.console.worker
        assert worker is not None, "no worker to wait for"
        worker.join(WAIT_S)
        assert not worker.is_alive(), "the worker did not end"

    def is_review_waiting(self) -> bool:
        """Whether a thread waits inside home_review.answered.wait() (read from the Event's own condition): only
        then does the next step find the waiting operation at the same place on every machine."""
        return len(self.console.home_review.answered._cond._waiters) > 0  # noqa: SLF001

    @staticmethod
    def wait_until(condition: Any) -> None:
        deadline = time.monotonic() + WAIT_S
        while not condition():
            assert time.monotonic() < deadline, "the script waited too long"
            time.sleep(0.001)

    def operation_of(self, spec: dict[str, Any]) -> Any:
        """Returns the operation ``spec`` scripts, which records what it was given and how it ended."""
        review = self.console.home_review
        reached, release = threading.Event(), threading.Event()  # this operation's own, while it blocks

        def run(spec: dict[str, Any], cancellation: threading.Event) -> Any:
            do = spec["do"]
            if do == "return":
                return None
            if do == "raise":
                error = spec["error"]
                if error["type"] == "HomeFailed":
                    raise HomeFailed(error["message"], copy.deepcopy(error["details"]))
                raise {"OperatorPaused": OperatorPaused, "RuntimeError": RuntimeError}[error["type"]](error["message"])
            if do == "block":
                reached.set()
                assert release.wait(WAIT_S), "the blocked operation was never released"
                return run(spec.get("then", {"do": "return"}), cancellation)
            if do == "home_review":
                return review.wait_for_decision(review.prepare(copy.deepcopy(spec["plan"])), cancellation)
            raise AssertionError(do)

        def operation(cancellation: threading.Event) -> None:
            entry: dict[str, Any] = {
                "cancellation_is_the_consoles": cancellation is self.console.cancellation,
                "cancellation_was_set": cancellation.is_set(),
            }
            try:
                entry["returned"] = run(spec, cancellation)
            except BaseException as error:
                entry["raised"] = {"type": type(error).__name__, "message": str(error)}
                raise
            finally:
                with self.lock:
                    self.operations.append(entry)

        operation.reached, operation.release = reached, release

        return operation

    # ---- a step ----

    def set(self, spec: dict[str, Any]) -> None:
        console, task_run = self.console, self.console.task_run
        for key, value in spec.items():
            value = copy.deepcopy(value)
            if key == "op":
                continue
            if key == "task":
                task_run.task = value
                if value is not None:
                    TaskFiles(self.root / value["id"]).directory.mkdir(exist_ok=True)
            elif key in ("active_turn", "total_steps", "inference_started_at"):
                setattr(task_run, key, value)
            elif key == "session_turn_count":
                task_run.session = None if value is None else SimpleNamespace(turn_count=value)
            elif key == "robot":
                console.robot._returns["status"] = value
            elif key == "robot_session_id":
                console.robot.session_id = value
            elif key == "model_health":
                console.health_checks._returns.update(get=value, check=value)
            elif key in ("model", "performance", "home_status", "error"):
                setattr(console, key, value)
            elif key == "home_plan":
                console.home_review.plan = value
            elif key == "failing":
                self.raises = value
            else:
                raise AssertionError(key)

    def call_of(self, spec: dict[str, Any]) -> Any:
        """Returns the call of PEAR that the step ``spec`` scripts, or None after a step of the script's own."""
        console, op = self.console, spec["op"]
        review = console.home_review
        keywords = {key: spec[key] for key in ("is_saved", "is_latching", "reason", "is_recorded", "is_forced") if key in spec}

        if op == "set":
            self.set(spec)
        elif op == "advance":
            self.clock.advanced_s += spec["seconds"]
        elif op == "release_operation":
            self.release.set()
            self.join()
        elif op == "wake":
            review.answered.set()
            self.wait_until(lambda: not review.answered.is_set() and self.is_review_waiting())
        elif op == "emit":
            count = spec.get("repeat")

            def emit() -> Any:
                if count is None:
                    return console.emit(spec["kind"], copy.deepcopy(spec["data"]), **keywords)
                for index in range(count):
                    event = console.emit(spec["kind"], {**copy.deepcopy(spec["data"]), "n": index}, **keywords)
                return event

            return emit
        elif op == "stop":
            return lambda: console.stop(**keywords)
        elif op == "launch":
            do = spec["operation"]["do"]
            if "cancellation" in spec:
                keywords["cancellation"] = threading.Event()
                if spec["cancellation"] == "set":
                    keywords["cancellation"].set()
            operation = self.operation_of(spec["operation"])

            def launch() -> None:
                console.launch(operation, **keywords)
                self.reached, self.release = operation.reached, operation.release  # of the operation that runs
                if do == "block":
                    assert self.reached.wait(WAIT_S), "the operation did not begin"
                elif do == "home_review":
                    assert not keywords.get("is_recorded"), "its record would depend on the threads' timing"
                    self.wait_until(lambda: review.plan is not None and self.is_review_waiting())
                else:
                    self.join()

            return launch
        elif op == "snapshot":
            return console.snapshot
        elif op == "close":
            return console.close
        elif op == "confirm":
            plan_id = review.plan["plan_id"] if spec["plan_id"] == "current" else spec["plan_id"]
            return lambda: review.confirm(plan_id, spec["is_confirmed"])
        elif op == "home_review" and spec["method"] == "prepare":

            def prepare() -> dict[str, Any]:
                self.review_plan = review.prepare(copy.deepcopy(spec["plan"]))
                return self.review_plan

            return prepare
        elif op == "home_review" and spec["method"] == "wait_for_decision":
            cancellation = threading.Event()
            if spec["cancelled"]:
                cancellation.set()
            if "decision" in spec:
                review.decision = spec["decision"]
            return lambda: review.wait_for_decision(self.review_plan, cancellation)
        elif op == "lease":
            arguments = [spec["client_id"]] if "client_id" in spec else []
            return lambda: getattr(console.lease, spec["method"])(*arguments)
        elif op == "robot_status":
            return console.robot_status
        elif op == "phase":
            return lambda: console.phase
        elif op == "is_busy":
            return lambda: console.is_busy
        elif op == "supports_reference_images":
            return console.supports_reference_images
        elif op == "action_format":
            return lambda: {"name": console.action_format.name}
        elif op == "set_phase":
            return lambda: console.set_phase(Phase[spec["phase"]])
        elif op == "check_model":
            return lambda: console.check_model(**keywords)
        elif op == "new_client":
            return lambda: {"class": type(console.new_client(spec["model"], spec["instruction"])).__name__}
        else:
            raise AssertionError(op)

        return None

    def step(self, spec: dict[str, Any]) -> dict[str, Any]:
        call = self.call_of(spec)
        returned, raised = None, None
        if call is not None:
            try:
                returned = call()
            except Exception as error:  # noqa: BLE001
                raised = {"type": type(error).__name__, "message": str(error)}
        assert (raised or {}).get("type") == spec.get("raises"), f"{spec}: raised {raised}"
        if spec.get("join"):
            self.join()

        with self.lock:
            events = sorted(self.events, key=lambda event: event["id"])
            phases, calls, operations = self.phases, self.calls, self.operations
            self.events, self.operations = [], []
            # (PEAR's worker takes an operation's error as the operation's failure: a failed check of this script
            # inside an operation must not pass as a record)
            scripted = [operation.get("raised", {}).get("type") for operation in operations]
            assert "AssertionError" not in scripted, f"{spec}: a check of the script failed on the worker: {operations}"
            self.phases = {thread: [] for thread in THREADS}
            self.calls = {thread: [] for thread in THREADS}

        return {
            "script": spec,
            "returned": plain(returned),
            "raised": raised,
            "events": [{**event, "saved": self.is_saved(event)} for event in events],
            "phases": phases,
            "calls": calls,
            "operations": operations,
            "fields": self.fields(),
            "files": self.files(),
            "clock": self.clock.record(),
        }

    def is_saved(self, event: dict[str, Any]) -> bool:
        """Whether the event file of the event's task holds the event as one of its lines."""
        if not event["task_id"]:
            return False
        path = TaskFiles(self.root / event["task_id"]).events_path
        made = {key: value for key, value in event.items() if key != "thread"}

        return path.exists() and any(json.loads(line) == made for line in path.read_text().splitlines())

    def fields(self) -> dict[str, Any]:
        console = self.console
        review, lease, worker = console.home_review, console.lease, console.worker
        ids = [event["id"] for event in console.events]
        identity = console.saved_fault_identity

        return plain(
            {
                "phase": console.phase.value,
                "error": console.error,
                "is_stop_latched": console.is_stop_latched,
                "performance": console.performance,
                "home_status": console.home_status,
                "saved_fault_identity": None if identity is None else list(identity),
                "is_busy": console.is_busy,
                "worker": "none" if worker is None else "running" if worker.is_alive() else "ended",
                "last_event_id": console.last_event_id,
                "events_kept": len(ids),
                "first_kept_event_id": ids[0] if ids else None,
                "last_kept_event_id": ids[-1] if ids else None,
                "cancellation_is_set": console.cancellation.is_set(),
                "home_review": {"plan": review.plan, "decision": review.decision, "answered": review.answered.is_set()},
                "lease": {"owner": lease.owner, "heartbeat_at": lease.heartbeat_at},
            }
        )

    def files(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for path in sorted(item for item in self.root.rglob("*") if item.is_file()):
            name, text = path.relative_to(self.root).as_posix(), path.read_text()
            if path.suffix == ".jsonl":
                rows.append({"name": name, "event_ids": [json.loads(line)["id"] for line in text.splitlines()]})
            else:
                rows.append({"name": name, "json": json.loads(text)})

        return rows


class Scenarios:
    """The scripted scenarios, in the file's order."""

    TASK = {"id": "task-1", "instruction": "Stack the cubes", "model": MODEL, "images": []}
    TURN = {"attempt": "a1b2c3d4e5f6", "turn_number": 2, "episode": "episode-1", "started_at": 1799999990.5}
    PLAN = {"stages": ["open_grippers", "home"], "joints": {"shoulder_pan": 0.25}}
    BOOM = {"type": "RuntimeError", "message": "boom"}
    HOME_FAILED = {
        "type": "HomeFailed",
        "message": "Home stopped at the shoulder",
        "details": {"stage": "home", "error": "RuntimeError: stalled", "completed": ["open_grippers"]},
    }

    def __init__(self, monkeypatch: pytest.MonkeyPatch, directory: Path) -> None:
        self.monkeypatch = monkeypatch
        self.directory = directory
        self.scenarios: list[dict[str, Any]] = []

    def play(self, name: str, pins: str, steps: list[dict[str, Any]], monotonic_step_s: float = 0.25) -> None:
        number = len(self.scenarios)
        stage = Stage(self.monkeypatch, number, self.directory / str(number), monotonic_step_s)
        initial = stage.fields()
        records = [stage.step(spec) for spec in steps]
        assert not stage.console.is_busy, f"{name} leaves its worker running"
        self.scenarios.append(
            {
                "name": name,
                "pins": pins,
                "monotonic_step_s": monotonic_step_s,
                "initial": initial,
                "uuids": list(stage.ids.drawn),
                "steps": records,
            }
        )

    def all(self) -> list[dict[str, Any]]:
        task, turn, plan, boom = self.TASK, self.TURN, self.PLAN, self.BOOM
        state = Stage.robot_state
        fault = state("FAULT", generation=1, fault="Serial line lost", fault_details={"joint": "elbow_flex", "code": 7})
        launch_boom = {"op": "launch", "operation": {"do": "raise", "error": boom}}

        # ---- 1. emit ----
        self.play(
            "emit_without_task",
            "console.py 183-210: no task: task_id null, nothing saved; an attempt in the data without an active turn",
            [
                {"op": "emit", "kind": "note", "data": {"a": 1}},
                {"op": "emit", "kind": "note", "data": {"a": 2}, "is_saved": False},
                {"op": "emit", "kind": "note", "data": {"attempt": "a1b2c3d4e5f6", "x": 1}},
            ],
        )
        self.play(
            "emit_with_task",
            "console.py 205-207: with a task the event is a line of the task's events.jsonl unless is_saved=False",
            [
                {"op": "set", "task": task},
                {"op": "emit", "kind": "note", "data": {"a": 1}},
                {"op": "emit", "kind": "note", "data": {"a": 2}, "is_saved": False},
                {"op": "emit", "kind": "note", "data": {"a": 3}, "is_saved": True},
            ],
        )
        self.play(
            "emit_in_a_turn",
            "console.py 189-194: the active turn's fields merged into an event of its attempt, the data's own "
            "winning; another attempt and no attempt are left as they are",
            [
                {"op": "set", "task": task, "active_turn": turn},
                {"op": "emit", "kind": "model_text", "data": {"attempt": turn["attempt"], "turn_number": 9, "text": "hi"}},
                {"op": "emit", "kind": "model_text", "data": {"text": "first", "attempt": turn["attempt"]}, "is_saved": False},
                {"op": "emit", "kind": "model_text", "data": {"attempt": "0f0f0f0f0f0f", "text": "other"}},
                {"op": "emit", "kind": "note", "data": {"text": "no attempt"}},
                {"op": "set", "active_turn": None},
                {"op": "emit", "kind": "model_text", "data": {"attempt": turn["attempt"], "text": "after the turn"}},
            ],
        )
        self.play(
            "emit_over_capacity",
            "console.py 45, 66, 195, 207: more than EVENT_CAPACITY events: the oldest dropped, the ids go on",
            [
                {"op": "emit", "kind": "tick", "data": {}, "repeat": Console.EVENT_CAPACITY},
                {"op": "emit", "kind": "tick", "data": {"last": True}},
                {"op": "emit", "kind": "tick", "data": {}, "repeat": 2},
            ],
        )

        # ---- 2. stop ----
        self.play(
            "stop_plain",
            "console.py 109-130: the stop's order, the phase Stopping, the inference report dropped, the event "
            "`stopping` that is not saved even with a task, what is returned",
            [
                {"op": "set", "robot": state("READY"), "performance": {"tokens_per_second": 12.5}},
                {"op": "stop"},
                {"op": "set", "task": task},
                {"op": "stop"},
            ],
        )
        self.play(
            "stop_latching",
            "console.py 109, 120-122, 127: is_latching and a reason; a later plain stop leaves the latch",
            [
                {"op": "set", "robot": state("READY")},
                {"op": "stop", "is_latching": True, "reason": "STOP MOTION"},
                {"op": "stop"},
                {"op": "stop", "is_latching": False, "reason": "Lease lost"},
            ],
        )
        self.play(
            "stop_while_home_review_waits",
            "console.py 113, 118, 241-242, 259-260 and home_review.py 43-46: a STOP wakes a waiting Home review, "
            "which ends as OperatorPaused; the plan is withdrawn at the operation's end",
            [
                {"op": "set", "robot": state("READY")},
                {"op": "launch", "operation": {"do": "home_review", "plan": plan}},
                {"op": "stop", "join": True},
            ],
        )
        self.play(
            "stop_robot_raises",
            "console.py 114-125: a robot whose stop raises: the finally still wakes the review, latches, sets the "
            "phase, drops the report and stops the recording; no event, the robot's error raised",
            [
                {"op": "set", "robot": state("READY"), "performance": {"tokens_per_second": 12.5}},
                {"op": "set", "failing": {"of": "robot", "call": "stop", "message": "Serial port closed"}},
                {"op": "stop", "raises": "RuntimeError"},
                {"op": "stop", "is_latching": True, "reason": "STOP MOTION", "raises": "RuntimeError"},
            ],
        )

        # ---- 3. launch and _operate ----
        self.play(
            "launch_returns",
            "console.py 211-240, 256-260: an operation that returns, not recorded and recorded (the recording "
            "stopped with `Task paused`); a new launch after the worker ended",
            [
                {"op": "launch", "operation": {"do": "return"}},
                {"op": "launch", "operation": {"do": "return"}, "is_recorded": True},
                {"op": "launch", "operation": {"do": "return"}, "cancellation": "new", "is_recorded": False},
            ],
        )
        self.play(
            "launch_operator_paused",
            "console.py 241-242: OperatorPaused: the phase Stopping, no stop of the robot, no error",
            [
                {"op": "set", "robot": state("READY")},
                {"op": "launch", "operation": {"do": "raise", "error": {"type": "OperatorPaused", "message": "paused"}}},
                {
                    "op": "launch",
                    "operation": {"do": "raise", "error": {"type": "OperatorPaused", "message": "paused"}},
                    "is_recorded": True,
                },
            ],
        )
        self.play(
            "launch_error_robot_ready",
            "console.py 243-258, 285-299: another error with the robot READY: the robot stopped, the error shown and "
            "published (not saved), no fault saved, the phase Stopping; the error stays for a later recorded operation",
            [
                {"op": "set", "robot": state("READY"), "task": task, "performance": {"tokens_per_second": 12.5}},
                launch_boom,
                {"op": "launch", "operation": {"do": "return"}, "is_recorded": True},
                {"op": "launch", "operation": {"do": "raise", "error": {"type": "RuntimeError", "message": "again"}}, "is_recorded": True},
            ],
        )
        self.play(
            "launch_error_robot_fault",
            "console.py 252-253, 291-305: the robot in FAULT: the phase Fault and the fault saved once for each "
            "(session, generation)",
            [
                {"op": "set", "robot": fault},
                launch_boom,
                launch_boom,
                {"op": "set", "robot": {**fault, "generation": 2}},
                launch_boom,
                {"op": "set", "robot_session_id": "robot-session-2"},
                launch_boom,
                {"op": "set", "robot": state("READY", generation=3)},
                launch_boom,
            ],
        )
        self.play(
            "launch_home_failed",
            "console.py 249-255: HomeFailed: the Home's status and its file; the phase Home failed with the robot "
            "READY, Fault with the robot in FAULT",
            [
                {"op": "set", "robot": state("READY")},
                {"op": "launch", "operation": {"do": "raise", "error": self.HOME_FAILED}},
                {"op": "set", "robot": fault},
                {"op": "launch", "operation": {"do": "raise", "error": self.HOME_FAILED}},
            ],
        )
        self.play(
            "launch_while_busy_and_cancelled",
            "console.py 220-232: a second launch while one runs is refused; a launch whose cancellation is already "
            "set raises OperatorPaused and starts nothing, and the console keeps that cancellation",
            [
                {"op": "launch", "operation": {"do": "block"}},
                {"op": "launch", "operation": {"do": "return"}, "raises": "ValueError"},
                {"op": "release_operation"},
                {"op": "launch", "operation": {"do": "return"}, "cancellation": "set", "raises": "OperatorPaused"},
                {"op": "launch", "operation": {"do": "block", "then": {"do": "raise", "error": boom}}},
                {"op": "is_busy"},
                {"op": "release_operation"},
            ],
        )
        self.play(
            "launch_withdraws_home_plan",
            "console.py 256-260: the Home plan under review is withdrawn at the operation's end",
            [
                {"op": "set", "home_plan": {**plan, "plan_id": "0123456789abcdef0123456789abcdef"}},
                {"op": "launch", "operation": {"do": "return"}},
            ],
        )

        # ---- 4. snapshot ----
        self.play(
            "snapshot_states",
            "console.py 132-170: the snapshot in the states a page shows: disabled; enabled and holding; a task "
            "running in a turn (Executing shown as Settling while the robot settles, no other phase); busy; paused; "
            "a fault; STOP MOTION latched; an inference report; a Home's status and plan; the lease's owner",
            [
                {"op": "snapshot"},
                {"op": "set", "robot": state("READY")},
                {"op": "set_phase", "phase": "HOLDING"},
                {"op": "lease", "method": "claim", "client_id": "tab-a"},
                {"op": "snapshot"},
                {"op": "set", "task": task, "active_turn": turn, "session_turn_count": 3, "total_steps": 5},
                {"op": "set", "inference_started_at": 1800000100.5, "model_health": {"status": "ok", "model": "stand-in-1"}},
                {"op": "set", "robot": state("BUSY", motion={"settling": True})},
                {"op": "set_phase", "phase": "EXECUTING"},
                {"op": "snapshot"},
                {"op": "set", "robot": state("BUSY")},
                {"op": "snapshot"},
                {"op": "set", "robot": state("BUSY", motion={"settling": True})},
                {"op": "set_phase", "phase": "THINKING"},
                {"op": "launch", "operation": {"do": "block"}},
                {"op": "snapshot"},
                {"op": "release_operation"},
                {"op": "set", "active_turn": None, "inference_started_at": None, "robot": state("READY")},
                {"op": "set_phase", "phase": "PAUSED"},
                {"op": "snapshot"},
                {"op": "set", "robot": fault, "error": "RuntimeError: boom"},
                {"op": "set_phase", "phase": "FAULT"},
                {"op": "snapshot"},
                {"op": "set", "robot": state("READY"), "error": None, "model": "second"},
                {"op": "stop", "is_latching": True, "reason": "STOP MOTION"},
                {"op": "set_phase", "phase": "STOPPED"},
                {"op": "snapshot"},
                {"op": "set", "performance": {"tokens_per_second": 12.5, "turn": 3}},
                {"op": "set", "home_status": {"stage": "home", "status": "running"}},
                {"op": "launch", "operation": {"do": "home_review", "plan": plan}},
                {"op": "snapshot"},
                {"op": "confirm", "plan_id": "current", "is_confirmed": True, "join": True},
                {"op": "snapshot"},
            ],
        )

        # ---- 5. close ----
        self.play(
            "close",
            "console.py 262-277: refused with the motors on (after the stop and the join); with them off the order "
            "of what is closed; a model session whose close raises: the robot and the preview are still closed",
            [
                {"op": "set", "robot": state("READY")},
                {"op": "launch", "operation": {"do": "return"}},
                {"op": "close", "raises": "RuntimeError"},
                {"op": "set", "robot": state("OFF")},
                {"op": "close"},
                {"op": "set", "failing": {"of": "task_run", "call": "close_session", "message": "The session is gone"}},
                {"op": "close", "raises": "RuntimeError"},
            ],
        )

        # ---- 6. HomeReview and ControlLease ----
        self.play(
            "home_review",
            "home_review.py 21-62: prepare; a wait that finds an answer; one that finds the cancellation, before "
            "and after an answer; an answer while it waits, confirming and refusing; a wake without an answer; "
            "confirm without a plan and with another plan's id",
            [
                {"op": "confirm", "plan_id": "0123456789abcdef0123456789abcdef", "is_confirmed": True, "raises": "ValueError"},
                {"op": "home_review", "method": "prepare", "plan": plan},
                {"op": "home_review", "method": "wait_for_decision", "cancelled": False, "decision": True},
                {"op": "home_review", "method": "prepare", "plan": plan},
                {"op": "home_review", "method": "wait_for_decision", "cancelled": False, "decision": False},
                {"op": "home_review", "method": "prepare", "plan": plan},
                {"op": "home_review", "method": "wait_for_decision", "cancelled": True, "raises": "OperatorPaused"},
                {"op": "confirm", "plan_id": "0123456789abcdef0123456789abcdef", "is_confirmed": True, "raises": "ValueError"},
                {"op": "confirm", "plan_id": "current", "is_confirmed": True},
                {"op": "home_review", "method": "prepare", "plan": plan},
                {"op": "home_review", "method": "wait_for_decision", "cancelled": True, "decision": True, "raises": "OperatorPaused"},
                {"op": "set", "home_plan": None},
                {"op": "launch", "operation": {"do": "home_review", "plan": plan}},
                {"op": "wake"},
                {"op": "confirm", "plan_id": "current", "is_confirmed": True, "join": True},
                {"op": "launch", "operation": {"do": "home_review", "plan": plan}},
                {"op": "confirm", "plan_id": "current", "is_confirmed": False, "join": True},
                {"op": "confirm", "plan_id": "0123456789abcdef0123456789abcdef", "is_confirmed": True, "raises": "ValueError"},
            ],
        )
        lease = lambda method, client_id=None, **keys: {  # noqa: E731
            "op": "lease",
            "method": method,
            **({} if client_id is None else {"client_id": client_id}),
            **keys,
        }
        self.play(
            "control_lease",
            "lease.py 11-52: every method and branch: a free lease, a held one, an idle holder gone silent, a silent "
            "holder whose operation runs; exactly LEASE_S of silence is not expired",
            [
                lease("lost_owner"),
                lease("is_expired"),
                lease("heartbeat", "tab-a"),
                lease("require", "tab-a", raises="ValueError"),
                lease("claim", "tab-a"),
                lease("claim", "tab-b"),
                lease("heartbeat", "tab-b"),
                lease("require", "tab-a"),
                lease("require", "tab-b", raises="ValueError"),
                {"op": "advance", "seconds": 3.0},
                lease("is_expired"),
                lease("heartbeat", "tab-a"),
                {"op": "advance", "seconds": 3.5},
                lease("is_expired"),
                lease("require", "tab-a", raises="ValueError"),
                lease("lost_owner"),
                lease("heartbeat", "tab-a"),
                {"op": "advance", "seconds": 4.0},
                lease("claim", "tab-b"),
                lease("release", "tab-a"),
                {"op": "launch", "operation": {"do": "block"}},
                lease("lost_owner"),
                {"op": "advance", "seconds": 4.0},
                lease("lost_owner"),
                lease("heartbeat", "tab-b"),
                lease("claim", "tab-c"),
                lease("is_expired"),
                {"op": "release_operation"},
                lease("lost_owner"),
                lease("claim", "tab-c"),
                lease("release", "tab-c"),
                lease("release", "tab-c"),
                lease("lost_owner"),
            ],
            monotonic_step_s=0.0,
        )

        # ---- 7. the small things ----
        self.play(
            "small_things",
            "console.py 89-107, 172-181, 279-283, 307-309: phase, is_busy, action_format, set_phase, check_model, "
            "supports_reference_images, new_client, robot_status",
            [
                {"op": "phase"},
                {"op": "is_busy"},
                {"op": "robot_status"},
                {"op": "action_format"},
                {"op": "supports_reference_images"},
                {"op": "check_model"},
                {"op": "set", "model_health": {"status": "ok", "model": "stand-in-1"}, "robot": state("READY"), "model": "second"},
                {"op": "check_model", "is_forced": True},
                {"op": "check_model", "is_forced": False},
                {"op": "supports_reference_images"},
                {"op": "action_format"},
                {"op": "robot_status"},
                {"op": "set_phase", "phase": "ENABLING"},
                {"op": "phase"},
                {"op": "launch", "operation": {"do": "block"}},
                {"op": "is_busy"},
                {"op": "release_operation"},
                {"op": "is_busy"},
                {"op": "new_client", "model": "stand_in", "instruction": "Stack the cubes"},
            ],
        )

        return self.scenarios


def constants() -> dict[str, Any]:
    """The names and the numbers of PEAR's console that a port must hold the same."""
    return plain(
        {
            "console": {
                name: getattr(Console, name)
                for name in (
                    "WORKER_JOIN_S",
                    "SETTLE_TIMEOUT_S",
                    "CHECK_INSTRUCTION",
                    "EVENT_CAPACITY",
                    "WORKER_THREAD_NAME",
                    "PAUSE_REASON",
                    "STOPPING_EVENT",
                    "ERROR_EVENT",
                )
            },
            "lease": {"LEASE_S": ControlLease.LEASE_S},
            "home_status": {member.name: member.value for member in HomeStatus},
            "phase": {member.name: member.value for member in Phase},
            "robot_status": {member.name: member.value for member in RobotStatus},
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
        with tempfile.TemporaryDirectory() as temporary:
            scenarios = Scenarios(monkeypatch, Path(temporary)).all()
    finally:
        monkeypatch.undo()

    steps = [step for scenario in scenarios for step in scenario["steps"]]
    meta = {
        "pear_commit": commit,
        "versions": {"python": sys.version.split()[0], "numpy": np.__version__, "pydantic": pydantic.VERSION},
        "seed": SEED,
        "models": MODELS,
        "model": MODEL,
        "robot_profile": ROBOT_PROFILE,
        "robot_session_id": ROBOT_SESSION,
        "recording": RECORDING,
        "cameras": CAMERAS,
        "wall_start_s": Clock.WALL_START_S,
        "wall_step_s": Clock.WALL_STEP_S,
        "monotonic_start_s": Clock.MONOTONIC_START_S,
        "ns_start": Clock.NS_START,
        "ns_step": Clock.NS_STEP,
        "constants": constants(),
        "counts": {
            "scenarios": len(scenarios),
            "steps": len(steps),
            "steps_that_raised": sum(step["raised"] is not None for step in steps),
            "events": sum(len(step["events"]) for step in steps),
            "events_saved": sum(event["saved"] for step in steps for event in step["events"]),
            "calls_of_stand_ins": sum(len(calls) for step in steps for calls in step["calls"].values()),
            "operations": sum(len(step["operations"]) for step in steps),
        },
    }
    write(directory, meta, scenarios)


if __name__ == "__main__":
    main()
