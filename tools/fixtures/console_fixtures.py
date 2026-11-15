#!/usr/bin/env python3
"""Generates tests/fixtures/console/task_run.json from PEAR's own classes: the console's task run (TaskRun of
pear/deploy/station/gui/console/task_run.py, unchanged), the loop around StationAgentLoop.step that runs a task's
turns one after another, through scripted scenarios.

Run it from a checkout of PEAR, with PEAR's Python (it needs no GPU and no hardware):

    cd <PEAR> && PYTHONDONTWRITEBYTECODE=1 <PEAR's python> <pear.js>/tools/fixtures/console_fixtures.py

The rig. The robot is PEAR's real robot on the stepped stand-in SO-101 of PEAR's tests, on the stand-in clock, with
the records of tools/fixtures/robot_fixtures.py (its Rig). The model's client is PEAR's StandInScriptedClient, as in
tools/fixtures/agent_fixtures.py, made by PEAR's own ModelsConfig and OfferedModel (no server). The console is PEAR's
own Console made without its constructor (object.__new__(Console)) and given the attributes that TaskRun and
Console.emit, set_phase, stop, robot_status, new_client and action_format read; its `recordings` and `home_review`
are stand-ins that record nothing. PEAR's emit, set_phase, stop and robot_status run unchanged. Not run: the
console's worker (Console.launch and _operate; run() is called directly, on the main thread, with a new
cancellation that is also the console's, as launch sets it) and the command that starts a task (Commands._start):
the task's folder is made empty and TaskRun.task is set to the scenario's `task`, without task.json and without
the TASK event, which are that command's.

Deterministic: time.monotonic and time.sleep are the stand-in clock (a new one for every scenario, first reading
meta.start_s; a sleep steps the control loop once); `time` of console.py and task_run.py is replaced, so that
time.time() there reads meta.wall_start_s + n * meta.wall_step_s at its n-th reading of the scenario (n from 0);
uuid4 of task_run.py (attempt ids), of agent_loop.py and clients/schemas.py (the session's episode, a frame's
uuid) and of control/robot.py (the robot's session, the observations) are seeded sequences, new for every
scenario. Two runs give the same bytes.

The operator's pause is PEAR's own Console.stop() (it stops the robot, sets the phase Stopping and publishes the
event "stopping", which is not saved). One thing is the script's: the run's cancellation is set when stop() has
returned, not at its first line, so that what the run's thread does after the pause does not depend on the
machine's timing when the pause comes from the model's thread.

The file: {"meta": {...}, "scenarios": [...]}, one scenario a line. A scenario:

  name, pins   what it is and which lines of task_run.py it pins
  task         TaskRun.task (id, instruction, model, images); an image is {id, file, url}, the keys new_session
               reads and the URL that Commands._start adds, and its file is in the task's folder before the first
               call: a stand-in of a few bytes, not a picture
  robot_session_id, control_period_s, model_timeout_s
  ids_before, sleeps_before, monotonic_s_before
               what the rig drew and slept before the first call (the robot's session; its opening), as a
               call's `ids` and `clock` give them
  calls        in order, each one call:
    op         "run": TaskRun.run(cancellation) with a new cancellation; or one of the other calls (below)
    script     the call's script (below)
    raised     null, or {"type": the class's name, "message": str of it}
    events     every event Console.emit made during the call, in order, as emit made it (id, type, data, time,
               monotonic_s, task_id), and `saved`: whether the task's events.jsonl holds it (the script checks that
               the file's line is that event)
    phases     every phase Console.set_phase was given during the call, in order
    phase      the console's phase after the call
    files      every file of the task's folder after the call, by name: {"name", "json": its value} for a JSON
               file; {"name", "event_ids"} for events.jsonl (the ids of its lines, in order); {"name", "size",
               "sha256"} for any other (a frame); {"name", "unchanged": true} for a file whose bytes are those of
               the call before. A path under the console's root reads "<root>/...".
    task_run   TaskRun's fields after the call: total_steps, turn_number, active_attempt_id, active_turn,
               resume_pending, inference_started_at (null or the wall time), has_session, has_client
    session    null, or the session's turn_count, blocked_reason and previous_result (the result's record)
    performance  console.performance after the call
    robot_status the word of the robot's status after the call
    robot      the calls made of the robot from outside it, in the order they ended, as agent_fixtures.py's
               LoopRun records them ({"call": name, arguments..., "returned" or "raised"}), and wait_settled
               (timeout_s), status (with_snapshot; returned: the status word) and check_fault as well;
               `after_event`: the id of the last event published when the call began. is_holding is not
               recorded (how often the loop asks while the model works is the machine's).
    model_inputs what the client was sent at each request: text (what the model reads), images (camera_name,
               uuid, name, is_jpeg) and reference_images
    ids        the UUIDs drawn during the call: task_run (an attempt id is the first 12 hex characters), session,
               robot
    clock      sleeps (the control periods stepped during the call), monotonic_s (the stand-in clock after it),
               wall_readings (the readings of time.time() so far in the scenario)
    session_given  (a "new_session" only) null when the call raised; else what the new session was given:
               robot_is_the_consoles and client_is_the_task_runs (whether its robot is console.robot and its
               client TaskRun.model_client), action_format (the format's name), timeout_s, directory,
               reference_images (the path and the uuid of each, in order) and the session's episode_id
    client     (a "close_session" only) null when TaskRun had no client before the call; else how often the
               client's cancel() and close() were called during it: {"cancelled", "closed"}; a cancel() that the
               client's own close() makes is not counted

The calls other than "run". Each has the whole record of a call (the events, phases and files of that call alone;
`robot` and `model_inputs` are empty when it asked nothing of them), and no `turns` and `hooks`:

  {"op": "new_session"}   TaskRun.new_session()
  {"op": "close_session", "close_raises"?: {"type", "message"}}
                          TaskRun.close_session(); with `close_raises` the client's close() raises that error
                          during this call, in the place of closing (its cancel() runs as it is)
  {"op": "new_client"}    the script's, not a method of TaskRun: TaskRun.model_client is set to
                          console.new_client(console.model, the task's instruction), a client that never started
                          a session, as the first statement of new_session leaves one
  {"op": "start_turn"}    TaskRun._start_turn(), as run() calls it when a turn opens (it needs a session)
  {"op": "on_event", "attempt", "cancelled", "kind", "data"}
                          TaskRun.on_event(cancellation, attempt, kind, data) with a new cancellation, which is
                          set before the call when `cancelled`; an `attempt` of "active" is
                          TaskRun.active_attempt_id at the call, any other is passed as it is; `kind` is the
                          value of a ModelEvent or of a TurnEvent; `data` is passed as a copy

A call's script: {"op": "run", "turns": [...], "hooks": [...]}. `turns` are the model's requests of the call in
order; a turn's `model` is what the model does when it is asked, as in agent_fixtures.py: {"emit": [kind, data]}
reports an event; {"return": output} answers; {"raise": {"type", "message"}} fails; {"do": "wait_watch"} waits
until the loop has looked at the robot's hold; {"do": "wait_stop"} waits until the loop stops the request; {"do":
"pause"} is the operator's pause; {"do": "arm_failure", "message"} has the arm's serial line fail from then on;
{"do": "advance_clock", "seconds", "times"} lets time pass; {"do": "move_arm", "joint", "offset", "velocity"}
pushes the arm as agent_fixtures.py does (the stand-in arm's position of that joint moves by `offset`, and every
reading from then on shows that joint with the velocity `velocity`); an operation's "then" lists operations that
follow it at once. A hook {"on": type, "phase"?, "turn"?, "do": ...,
"after_sleeps"?} acts once, when Console.emit is given the first event of that type (and that data.phase, and
while TaskRun.turn_number is `turn`), before the event is numbered: so what a hook publishes comes before the
event it acts on. With `after_sleeps` it acts that many sleeps of the stand-in clock later, inside that sleep.
"""

from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import json
import sys
import tempfile
import threading
import time
from collections import deque
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pydantic
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agent_fixtures  # noqa: E402
import robot_fixtures  # noqa: E402  (PEAR's own rig of its tests joins sys.path there)
from config_files import ConfigFiles  # noqa: E402
from control_rig import StandInClock  # noqa: E402
from stand_in_cameras import StandInCameras  # noqa: E402
from stand_in_robots import SteppedStandInSO101Robot  # noqa: E402

from pear.deploy.station.agent_loop import agent_loop as agent_loop_module  # noqa: E402
from pear.deploy.station.agent_loop.clients import schemas as schemas_module  # noqa: E402
from pear.deploy.station.agent_loop.clients.schemas import ModelEvent, ModelOutput  # noqa: E402
from pear.deploy.station.agent_loop.config import ModelsConfig, OfferedModel  # noqa: E402
from pear.deploy.station.agent_loop.schemas import TurnEvent  # noqa: E402
from pear.deploy.station.control import robot as robot_module  # noqa: E402
from pear.deploy.station.control.robots.so101.robot import SO101Robot  # noqa: E402
from pear.deploy.station.gui.console import console as console_module  # noqa: E402
from pear.deploy.station.gui.console import task_run as task_run_module  # noqa: E402
from pear.deploy.station.gui.console.console import Console  # noqa: E402
from pear.deploy.station.gui.console.phase import Phase  # noqa: E402
from pear.deploy.station.gui.console.task_run import RECORD_URL, TaskRun  # noqa: E402
from pear.deploy.station.records.task_events import TaskEventKind  # noqa: E402
from pear.deploy.station.records.task_files import TaskFiles  # noqa: E402

REPOSITORY = Path(__file__).resolve().parents[2]
FIXTURES = REPOSITORY / "tests" / "fixtures" / "console"
NAME = "task_run.json"
PACK_ABOVE_BYTES = 300_000  # a larger file is written as gzip (NAME + .gz), as the other fixtures are
SEED = agent_fixtures.SEED
MODEL = "stand_in"  # the station's name of the one model the console offers here
MODEL_TIMEOUT_S = 60.0
ROOT = "<root>"  # what stands for the console's root (a temporary folder) in a record
REAL_MONOTONIC = time.monotonic  # the machine's clock, for the waits of this script itself
WAIT_S = 20.0  # (on the machine's clock) the longest this script waits for the loop
Jsonable = agent_fixtures.Jsonable
LoopRun = agent_fixtures.LoopRun
says = agent_fixtures.LoopScenarios.says
action = agent_fixtures.LoopScenarios.action


class WallClock:
    """What stands in for time.time() in console.py and task_run.py: every reading is one step after the last."""

    START_S = 1_800_000_000.0
    STEP_S = 0.125

    def __init__(self) -> None:
        self.reads = 0
        self.lock = threading.Lock()

    def time(self) -> float:
        with self.lock:
            value = self.START_S + self.reads * self.STEP_S
            self.reads += 1

        return value


class Recordings:
    """What stands in for the console's recordings: it records nothing. Console.emit gives it every event first,
    which is where a scenario's hooks act."""

    def __init__(self) -> None:
        self.hook: Any = None

    def on_event(self, kind: Any, data: dict[str, Any]) -> None:
        if self.hook is not None:
            self.hook(str(getattr(kind, "value", kind)), data)

    def stop(self, *arguments: Any, **keywords: Any) -> None:
        pass


class Stage:
    """One scenario's rig: a new clock, new sequences of UUIDs, an open robot, a console and its task."""

    def __init__(self, rig: Any, monkeypatch: pytest.MonkeyPatch, number: int, root: Path, task: dict[str, Any]) -> None:
        seed = SEED + 10 * number
        self.rig = rig
        self.clock = rig.new_clock()
        self.wall = WallClock()
        self.ids = {name: robot_fixtures.Ids(seed + index) for index, name in enumerate(("task_run", "session", "robot"), 1)}
        rig.ids = self.ids["robot"]
        monkeypatch.setattr(robot_module, "uuid4", self.ids["robot"].next)
        monkeypatch.setattr(agent_loop_module, "uuid4", self.ids["session"].next)
        monkeypatch.setattr(schemas_module, "uuid4", self.ids["session"].next)
        monkeypatch.setattr(task_run_module, "uuid4", self.ids["task_run"].next)
        stand_in_time = SimpleNamespace(time=self.wall.time, monotonic=lambda: time.monotonic())
        monkeypatch.setattr(console_module, "time", stand_in_time)
        monkeypatch.setattr(task_run_module, "time", stand_in_time)

        self.robot = SteppedStandInSO101Robot(ConfigFiles.load("so101"), cameras=StandInCameras(SO101Robot.CAMERAS))
        self.robot.open()
        self.clock.control_loop = self.robot.control_loop
        self.arm = self.robot.control_loop.driver.hardware
        self.status = self.robot.status  # the robot's own, which the record of a call reads

        # the call that runs: its script, what its model was sent and what it asked of the robot
        self.current: dict[str, Any] = {"turns": [], "hooks": [], "asked": 0, "holding": 0, "model_inputs": [], "robot": []}
        self.phases: list[str] = []
        self.file_hashes: dict[str, str] = {}

        models_config = ModelsConfig(
            robot_class="stand_in_robots.SteppedStandInSO101Robot",
            config_dir=str(root),
            default_model=MODEL,
            models={
                MODEL: OfferedModel(
                    label="Stand-in",
                    client_class="stand_in_clients.StandInScriptedClient",
                    client={"answer": self.answer},
                    timeout_s=MODEL_TIMEOUT_S,
                )
            },
        )
        console = object.__new__(Console)
        console.root = root
        console.models_config = models_config
        console.robot = self.robot
        console.recordings = Recordings()
        console.recordings.hook = self.hooked
        console.lock = threading.RLock()
        console.events = deque(maxlen=Console.EVENT_CAPACITY)
        console.last_event_id = 0
        console.model = models_config.default_model
        console.cancellation = threading.Event()
        console._phase = Phase.HOLDING  # an enabled robot at rest
        console.error = None
        console.is_stop_latched = False
        console.performance = None
        console.home_review = SimpleNamespace(answered=threading.Event(), plan=None)
        console.task_run = TaskRun(console)
        self.console = console

        set_phase = console.set_phase  # PEAR's own, which still runs

        def recorded_set_phase(phase: Phase) -> None:
            self.phases.append(json.loads(json.dumps(phase.value)))
            set_phase(phase)

        console.set_phase = recorded_set_phase
        self.logged()

        # as Commands._start leaves a task, without task.json and the TASK event
        TaskFiles(root / task["id"]).directory.mkdir()
        console.task_run.task = task

    def close(self) -> None:
        self.clock.control_loop = None
        self.robot.close()

    # ---- the recording robot ----

    def logged(self) -> None:
        """Has every call made of the robot from outside it join the record of the call that runs, as
        agent_fixtures.py's LoopRun records it."""
        robot, console, current = self.robot, self.console, self.current
        depth = threading.local()

        def wrap(name: str, describe: Any) -> None:
            method = getattr(robot, name)

            def wrapper(*arguments: Any, **keywords: Any) -> Any:
                if getattr(depth, "value", 0):
                    return method(*arguments, **keywords)  # a call the robot makes of itself
                depth.value = 1
                entry: dict[str, Any] = {"call": name, "after_event": console.last_event_id}
                try:
                    describe(entry, arguments, keywords)
                    try:
                        value = method(*arguments, **keywords)
                    except Exception as error:  # noqa: BLE001
                        entry["raised"] = LoopRun.error_record(error)
                        raise
                    if name == "status":
                        entry["returned"] = str(value["status"])
                    else:
                        entry.update(LoopRun.returned(name, value, robot))
                    return value
                finally:
                    depth.value = 0
                    current["robot"].append(entry)

            setattr(robot, name, wrapper)

        def nothing(entry: dict[str, Any], arguments: tuple, keywords: dict) -> None:
            pass

        def wait_stationary(entry: dict[str, Any], arguments: tuple, keywords: dict) -> None:
            observation = arguments[0] if arguments else keywords.get("observation")
            entry["observation"] = None if observation is None else observation["observation_id"]
            entry["cancellation"] = keywords.get("cancellation") is not None

        def model_state(entry: dict[str, Any], arguments: tuple, keywords: dict) -> None:
            entry["joint_positions"] = Jsonable.of(arguments[0])
            entry["format_name"] = arguments[1]

        def execute(entry: dict[str, Any], arguments: tuple, keywords: dict) -> None:
            entry["action"] = Jsonable.of(arguments[0])
            entry["reference"] = keywords["reference_observation"]["observation_id"]
            entry["cancellation"] = keywords.get("cancellation") is not None
            entry["progress"] = []
            report_progress = keywords["report_progress"]

            def report(phase: Any) -> None:
                entry["progress"].append(phase.value)
                report_progress(phase)

            keywords["report_progress"] = report

        def failure_result(entry: dict[str, Any], arguments: tuple, keywords: dict) -> None:
            error = arguments[0]
            entry["error"] = {"type": type(error).__name__, "message": str(error)}
            entry["format_name"] = keywords.get("format_name")
            entry["status"] = keywords["status"].value if "status" in keywords else None
            entry["snapshot"] = keywords.get("snapshot") is not None

        def wait_settled(entry: dict[str, Any], arguments: tuple, keywords: dict) -> None:
            entry["timeout_s"] = arguments[0] if arguments else keywords.get("timeout_s")

        def status(entry: dict[str, Any], arguments: tuple, keywords: dict) -> None:
            entry["with_snapshot"] = bool(arguments[0] if arguments else keywords.get("with_snapshot", False))

        wrap("wait_stationary", wait_stationary)
        wrap("observe", nothing)
        wrap("model_state", model_state)
        wrap("stop", nothing)
        wrap("execute", execute)
        wrap("failure_result", failure_result)
        wrap("wait_settled", wait_settled)
        wrap("status", status)
        wrap("check_fault", nothing)

        is_holding = robot.is_holding

        def counted(observation: Any) -> bool:
            current["holding"] += 1
            return is_holding(observation)

        robot.is_holding = counted

    # ---- the model and the operator ----

    def answer(self, model_input: Any, on_event: Any, request_cancellation: threading.Event) -> ModelOutput:
        current = self.current
        index = current["asked"]
        current["asked"] += 1
        current["holding"] = 0
        current["model_inputs"].append(
            {
                "text": model_input.text,
                "images": [
                    {
                        "camera_name": image.camera_name,
                        "uuid": image.uuid,
                        "name": image.path.name,
                        "is_jpeg": image.path.read_bytes()[:2] == b"\xff\xd8",
                    }
                    for image in model_input.images
                ],
                "reference_images": [image.uuid for image in model_input.reference_images],
            }
        )
        if index >= len(current["turns"]):
            raise AssertionError("the model was asked more often than the call's script has turns")
        for operation in current["turns"][index]["model"]:
            if "emit" in operation:
                kind, data = operation["emit"]
                on_event(ModelEvent(kind), copy.deepcopy(data))
            elif "return" in operation:
                return ModelOutput(**operation["return"])
            elif "raise" in operation:
                raise agent_fixtures.Raised.make(operation["raise"])
            elif operation["do"] == "wait_stop":
                if not request_cancellation.wait(WAIT_S):
                    raise AssertionError("the loop did not stop the request")
            elif operation["do"] == "wait_watch":
                started = REAL_MONOTONIC()
                while not current["holding"]:
                    if REAL_MONOTONIC() - started > WAIT_S:
                        raise AssertionError("the loop did not watch the request")
                    threading.Event().wait(0.001)
            else:
                self.act(operation)
        raise AssertionError("a model's script ends with what it returns or raises")

    def act(self, operation: dict[str, Any]) -> None:
        name = operation["do"]
        if name == "pause":
            self.pause()
        elif name == "arm_failure":
            self.arm.failure = RuntimeError(operation["message"])
        elif name == "move_arm":
            # the arm is pushed, as in agent_fixtures.py: its reading moves and shows a velocity, at every reading
            # from now on
            arm = self.arm
            position = list(arm.position)
            position[operation["joint"]] += operation["offset"]
            arm.position = tuple(position)
            read = arm.read

            def moving() -> Any:
                state = read()
                velocity = [0.0] * len(state.velocity)
                velocity[operation["joint"]] = operation["velocity"]
                return type(state)(state.position, tuple(velocity), state.sampled_monotonic_s, state.sample_id)

            arm.read = moving
        elif name == "advance_clock":
            for _ in range(operation["times"]):
                time.sleep(operation["seconds"])  # the stand-in clock: time passes and the control loop steps
        else:
            raise AssertionError(f"unknown action {name}")
        for following in operation.get("then", []):
            self.act(following)

    def pause(self) -> None:
        """The operator's pause: PEAR's own Console.stop(); the run's cancellation is set once it has returned."""
        console = self.console
        cancellation = console.cancellation
        console.cancellation = threading.Event()  # what stop() sets, in the place of the run's until it returns
        try:
            console.stop()
        finally:
            console.cancellation = cancellation
            cancellation.set()

    def hooked(self, kind: str, data: dict[str, Any]) -> None:
        """Acts for every hook of the running call that waits for this event."""
        hooks = self.current["hooks"]
        for hook in list(hooks):
            if hook["on"] != kind or ("phase" in hook and data.get("phase") != hook["phase"]):
                continue
            if "turn" in hook and self.console.task_run.turn_number != hook["turn"]:
                continue
            hooks.remove(hook)
            if "after_sleeps" not in hook:
                self.act(hook)
                continue
            clock, due = self.clock, len(self.clock.ticks) + hook["after_sleeps"]

            def after_tick(count: int, hook: dict[str, Any] = hook, due: int = due) -> None:
                if count >= due:
                    clock.after_tick = None
                    self.act(hook)

            clock.after_tick = after_tick

    # ---- a call and its record ----

    def run(self, spec: dict[str, Any]) -> dict[str, Any]:
        console = self.console
        current = self.current
        current.update(
            turns=copy.deepcopy(spec.get("turns", [])), hooks=copy.deepcopy(spec.get("hooks", [])), asked=0, holding=0
        )
        current["model_inputs"], current["robot"] = [], []
        self.phases.clear()
        first_event = console.last_event_id
        raised = None
        extra: dict[str, Any] = {}
        if spec["op"] == "run":
            cancellation = console.cancellation = threading.Event()  # as Console.launch gives an operation
            try:
                console.task_run.run(cancellation)
            except Exception as error:  # noqa: BLE001
                raised = {"type": type(error).__name__, "message": str(error)}
        else:
            raised, extra = self.call(spec)
        if current["hooks"] or self.clock.after_tick is not None:
            raise AssertionError(f"hooks that never acted: {current['hooks']}")

        return self.record(spec, raised, first_event, extra)

    @staticmethod
    def raised_by(call: Any) -> dict[str, Any] | None:
        """What ``call`` raised, as a record holds it; None when it returned."""
        try:
            call()
        except Exception as error:  # noqa: BLE001
            return {"type": type(error).__name__, "message": str(error)}

        return None

    def call(self, spec: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any]]:
        """Makes a call of TaskRun other than run(); returns what it raised and what its record holds besides."""
        console = self.console
        task_run = console.task_run
        op = spec["op"]
        if op == "new_session":
            raised = self.raised_by(task_run.new_session)
            session = task_run.session
            given = None
            if raised is None:
                given = {
                    "robot_is_the_consoles": session.robot is console.robot,
                    "client_is_the_task_runs": session.client is task_run.model_client,
                    "action_format": session.action_format.name,
                    "timeout_s": session.timeout_s,
                    "directory": str(session.directory),
                    "reference_images": [
                        {"path": str(image.path), "uuid": image.uuid} for image in session.reference_images
                    ],
                    "episode_id": session.episode_id,
                }
            return raised, {"session_given": given}
        if op == "new_client":
            # (the script's) a client that never started a session, as new_session's first statement leaves one
            task_run.model_client = console.new_client(console.model, task_run.task["instruction"])
            return None, {}
        if op == "start_turn":
            return self.raised_by(task_run._start_turn), {}
        if op == "on_event":
            cancellation = threading.Event()
            if spec["cancelled"]:
                cancellation.set()
            attempt_id = task_run.active_attempt_id if spec["attempt"] == "active" else spec["attempt"]
            try:
                kind: Any = ModelEvent(spec["kind"])
            except ValueError:
                kind = TurnEvent(spec["kind"])
            data = copy.deepcopy(spec["data"])
            return self.raised_by(lambda: task_run.on_event(cancellation, attempt_id, kind, data)), {}
        if op == "close_session":
            client = task_run.model_client
            if client is None:
                return self.raised_by(task_run.close_session), {"client": None}
            counts = {"cancelled": 0, "closed": 0}
            cancel, close = client.cancel, client.close
            closing = []  # not empty while the client's own close() runs

            def counted_cancel(*arguments: Any, **keywords: Any) -> Any:
                if not closing:  # (a cancel() the client's close() makes of itself is not counted)
                    counts["cancelled"] += 1
                return cancel(*arguments, **keywords)

            def counted_close(*arguments: Any, **keywords: Any) -> Any:
                counts["closed"] += 1
                if "close_raises" in spec:
                    raise agent_fixtures.Raised.make(spec["close_raises"])
                closing.append(True)
                try:
                    return close(*arguments, **keywords)
                finally:
                    closing.pop()

            client.cancel, client.close = counted_cancel, counted_close
            try:
                raised = self.raised_by(task_run.close_session)
            finally:
                del client.cancel, client.close  # the client's own again
            return raised, {"client": counts}
        raise AssertionError(f"unknown operation {op}")

    def record(
        self, spec: dict[str, Any], raised: dict[str, Any] | None, first_event: int, extra: dict[str, Any]
    ) -> dict[str, Any]:
        console = self.console
        task_run = console.task_run
        files = TaskFiles(console.root / task_run.task["id"])
        saved = {}
        if files.events_path.is_file():
            saved = {event["id"]: event for event in map(json.loads, files.events_path.read_text().splitlines())}
        events = []
        for event in console.events:
            if event["id"] <= first_event:
                continue
            plain = json.loads(json.dumps(event, allow_nan=False))
            if event["id"] in saved and saved[event["id"]] != plain:
                raise AssertionError(f"events.jsonl holds another event {event['id']}")
            events.append({**plain, "saved": event["id"] in saved})
        if len(events) != console.last_event_id - first_event:
            raise AssertionError("the console kept fewer events than it published")
        session = task_run.session
        clock = {"sleeps": len(self.clock.take()), "monotonic_s": self.clock.now, "wall_readings": self.wall.reads}

        return self.scrubbed(
            {
                "op": spec["op"],
                "script": spec,
                "raised": raised,
                "events": events,
                "phases": list(self.phases),
                "phase": json.loads(json.dumps(console.phase.value)),
                "files": self.files(files.directory),
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
                "performance": copy.deepcopy(console.performance),
                "robot_status": str(self.status()["status"]),
                "robot": list(self.current["robot"]),
                "model_inputs": list(self.current["model_inputs"]),
                "ids": {name: ids.take() for name, ids in self.ids.items()},
                "clock": clock,
                **extra,
            }
        )

    def files(self, directory: Path) -> list[dict[str, Any]]:
        entries = []
        for path in sorted(directory.iterdir(), key=lambda path: path.name):
            data = path.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            entry: dict[str, Any] = {"name": path.name}
            if self.file_hashes.get(path.name) == digest:
                entry["unchanged"] = True
            elif path.name == TaskFiles.EVENTS_NAME:
                entry["event_ids"] = [json.loads(line)["id"] for line in data.decode().splitlines()]
            elif path.suffix == ".json":
                entry["json"] = json.loads(data)
            else:
                entry["size"], entry["sha256"] = len(data), digest
            self.file_hashes[path.name] = digest
            entries.append(entry)

        return entries

    def scrubbed(self, value: Any) -> Any:
        """``value`` as JSON holds it, with the console's root by the name ROOT."""
        root = str(self.console.root)

        def scrub(item: Any) -> Any:
            if isinstance(item, str):
                return item.replace(root, ROOT)
            if isinstance(item, dict):
                return {key: scrub(part) for key, part in item.items()}
            if isinstance(item, list):
                return [scrub(part) for part in item]
            return item

        return scrub(json.loads(json.dumps(Jsonable.of(value), allow_nan=False)))


class Scenarios:
    """The scenarios of PEAR's TaskRun, in the order of the lines they pin."""

    LIFT = "Lifting.\n" + action(z=0.5)

    def __init__(self, rig: Any, monkeypatch: pytest.MonkeyPatch, directory: Path) -> None:
        self.rig = rig
        self.monkeypatch = monkeypatch
        self.directory = directory
        self.task_ids = robot_fixtures.Ids(SEED + 5)
        self.count = 0

    def play(
        self, name: str, pins: str, instruction: str, calls: list[dict[str, Any]], images: int = 0
    ) -> dict[str, Any]:
        self.count += 1
        print(f"scenario {self.count}: {name}", file=sys.stderr)
        root = self.directory / f"console-{self.count}"
        root.mkdir()
        task = {"id": self.task_ids.next().hex, "instruction": instruction, "model": MODEL, "images": []}
        for _ in range(images):  # the task's reference images, as Commands._start records them (id, file, url)
            upload_id = self.task_ids.next().hex
            file = TaskFiles.REFERENCE_IMAGE_NAME.format(upload_id=upload_id)
            url = RECORD_URL.format(task_id=task["id"], name=file)
            task["images"].append({"id": upload_id, "file": file, "url": url})
        stage = Stage(self.rig, self.monkeypatch, self.count, root, task)
        for image in task["images"]:  # a stand-in for the picture: the file is there, with bytes of its own
            (root / task["id"] / image["file"]).write_bytes(b"\xff\xd8" + image["id"].encode("ascii") + b"\xff\xd9")
        try:
            recorded = {
                "name": name,
                "pins": pins,
                "task": copy.deepcopy(task),
                "robot_session_id": stage.robot.session_id,
                "control_period_s": stage.robot.control_period_s,
                "model_timeout_s": MODEL_TIMEOUT_S,
                # what the rig drew and slept before the first call (the robot's session; its opening)
                "ids_before": {name: ids.take() for name, ids in stage.ids.items()},
                "sleeps_before": len(stage.clock.take()),
                "monotonic_s_before": stage.clock.now,
                "calls": [stage.run(spec) for spec in calls],
            }
        finally:
            stage.close()

        return recorded

    @staticmethod
    def turn(answer: str, reasoning: str = "Next move.") -> dict[str, Any]:
        return {"model": says(answer, reasoning)}

    @staticmethod
    def event(kind: str, data: dict[str, Any], attempt: str = "active", cancelled: bool = False) -> dict[str, Any]:
        return {"op": "on_event", "attempt": attempt, "cancelled": cancelled, "kind": kind, "data": data}

    def all(self) -> list[dict[str, Any]]:
        lift = self.turn(self.LIFT)
        out = self.turn(action(x=200.0))  # two metres ahead: out of the arm's reach
        bus_failure = {"do": "arm_failure", "message": "stand-in bus failure"}
        # one sleep longer than the control loop accepts its feedback to be old: the loop faults in that step
        stale = {"do": "advance_clock", "seconds": 0.2, "times": 1}
        # the arm is pushed and, for five seconds of control periods, its readings show it moving: longer than the
        # control loop lets a hold be unsettled, so the loop faults with a StabilityError, whose details have a code
        pushed = {"do": "move_arm", "joint": 1, "offset": 0.05, "velocity": 0.5}
        unsettled = {"do": "advance_clock", "seconds": 0.02, "times": 250}
        full = {"type": "ContextLimit", "message": "The conversation no longer fits the model's context"}
        cleanup = {"type": "RuntimeError", "message": "The model's server did not confirm the session's end"}
        event = self.event
        another = "0123456789ab"  # an attempt id that is no turn's
        timing = {"time_to_first_token_s": 0.25}
        observation = {
            "observation_id": "observation-of-the-script",
            "images": {"wrist": "frames/0123456789ab-wrist.jpg", "front": "frames/0123456789ab-front.jpg"},
        }

        return [
            self.play(
                "pause between turns",
                "three turns complete and settle (lines 107 and 108: total_steps counts each), then the operator "
                "pauses as the third turn's result is published, and the check at the top of the loop (line 78) "
                "ends the run with no turn open: no turn_end, no interruption",
                "Lift the cube.",
                [
                    {
                        "op": "run",
                        "turns": [lift, self.turn(action(-1.0, x=1.0, z=-0.5), "Close on it."), self.turn(action(1.0), "")],
                        "hooks": [{"on": "execution", "turn": 3, "do": "pause"}],
                    }
                ],
            ),
            self.play(
                "pause while the model is asked",
                "the operator pauses the second turn while its model works: the turn ends as Interrupted (lines "
                "284 to 290), the pause is recorded as the turn's failed result and the event interrupted follows "
                "(lines 297 to 317); resume_pending stays false, so a second run() opens the next turn at once "
                "(lines 72 to 75), whose model reads of the interruption",
                "Lift the cube.",
                [
                    {
                        "op": "run",
                        "turns": [
                            lift,
                            {
                                "model": [
                                    {"emit": ["reasoning_delta", {"text": "Still thinking.", "reasoning_kind": "full"}]},
                                    {"do": "wait_watch"},
                                    {"do": "pause"},
                                    {"do": "wait_stop"},
                                    *says(action(z=0.5), ""),
                                ]
                            },
                        ],
                    },
                    {"op": "run", "turns": [lift], "hooks": [{"on": "execution", "turn": 3, "do": "pause"}]},
                ],
            ),
            self.play(
                "pause while the arm moves",
                "the operator pauses ten control periods into the first turn's motion: the robot's own result of "
                "the stopped action is what the step returns or raises, the turn ends as lines 282 to 317 say, "
                "and a second run() opens the next turn, whose model reads what happened",
                "Lift the cube.",
                [
                    {
                        "op": "run",
                        "turns": [self.turn("The cube is ahead.\n" + action(z=1.5), "The cube is ahead and below.")],
                        "hooks": [{"on": "phase", "phase": "Executing", "do": "pause", "after_sleeps": 10}],
                    },
                    {"op": "run", "turns": [lift], "hooks": [{"on": "execution", "turn": 2, "do": "pause"}]},
                ],
            ),
            self.play(
                "pause before the model is asked",
                "the operator pauses as the second turn opens, before it has observed: the turn ends as "
                "Interrupted, and no result is recorded, since the session's last turn is still the first one "
                "(line 301); a second run() opens the next turn, whose model reads the first turn's result",
                "Lift the cube.",
                [
                    {"op": "run", "turns": [lift], "hooks": [{"on": "turn_started", "turn": 2, "do": "pause"}]},
                    {"op": "run", "turns": [lift], "hooks": [{"on": "execution", "turn": 3, "do": "pause"}]},
                ],
            ),
            self.play(
                "out of reach six times",
                "six actions in a row that the offline inverse kinematics refuse: five notices, each before a new "
                "turn (lines 93 to 97), then the sixth ends the run with the result's message, resume_pending set "
                "and a turn_end that is not saved (lines 99 to 105, 291 to 295); a second run() waits for the arm "
                "to settle and publishes resume_context (lines 198 to 210), then a turn completes",
                "Lift the cube.",
                [
                    {"op": "run", "turns": [out] * 6},
                    {"op": "run", "turns": [lift], "hooks": [{"on": "execution", "turn": 7, "do": "pause"}]},
                ],
            ),
            self.play(
                "out of reach, reachable, out of reach",
                "an action out of reach, one that completes and one out of reach again: the second notice counts "
                "from one again (line 107); the operator pauses as that notice is published",
                "Lift the cube.",
                [{"op": "run", "turns": [out, lift, out], "hooks": [{"on": "notice", "turn": 3, "do": "pause"}]}],
            ),
            self.play(
                "an action that fails while it runs",
                "the arm's serial line fails while the second turn's action runs: the step returns a failed result, "
                "which is saved, and the run ends with the result's message and resume_pending set (lines 99 to "
                "105)",
                "Lift the cube.",
                [{"op": "run", "turns": [lift, lift], "hooks": [{**bus_failure, "on": "phase", "phase": "Executing", "turn": 2}]}],
            ),
            self.play(
                "a fault during a turn",
                "the second turn's model request is cancelled (Console.stop(), as a watchdog of the console "
                "would on a fault) and, before the step has raised, the arm's serial line fails and the control "
                "loop faults: the step raises OperatorPaused, the robot's fault replaces it, the failed result "
                "is recorded with the robot's snapshot, resume_pending is set and the turn ends as Failed (lines "
                "248 to 270, 291 to 295); this fault carries no details, so no diagnostic is published and lines "
                "272 to 278 are not pinned",
                "Lift the cube.",
                [
                    {
                        "op": "run",
                        "turns": [
                            lift,
                            {
                                "model": [
                                    {"emit": ["reasoning_delta", {"text": "Still thinking.", "reasoning_kind": "full"}]},
                                    {"do": "wait_watch"},
                                    {"do": "pause"},
                                    {"do": "wait_stop"},
                                    {**bus_failure, "then": [stale]},
                                    *says(action(z=0.5), ""),
                                ]
                            },
                        ],
                    }
                ],
            ),
            self.play(
                "a fault before the turn has observed",
                "the arm's serial line fails and the control loop faults as the second turn opens: the step raises "
                "before it observes, the session's last turn is still the first one, so no result is recorded and "
                "resume_pending stays false (line 264)",
                "Lift the cube.",
                [{"op": "run", "turns": [lift], "hooks": [{**bus_failure, "then": [stale], "on": "turn_started", "turn": 2}]}],
            ),
            self.play(
                "a fault with a diagnostic that the turn published",
                "the arm is pushed as the second turn opens and its readings show motion until the control loop "
                "faults (Persistent motion during HOLD, a StabilityError, whose details carry a code): the step "
                "raises that error before it observes, after it published the error's details as the turn's "
                "diagnostic; the fault that check_fault raises carries the same code, so _reconcile_fault finds "
                "the turn's diagnostic among console.events and does not send it again (lines 272 to 278); no "
                "result is recorded (line 264)",
                "Lift the cube.",
                [
                    {
                        "op": "run",
                        "turns": [lift],
                        "hooks": [{**pushed, "then": [unsettled], "on": "turn_started", "turn": 2}],
                    }
                ],
            ),
            self.play(
                "a fault with a diagnostic of a cancelled turn",
                "the second turn's model request is cancelled (Console.stop(), as in the scenario of a fault "
                "during a turn) and, before the step has raised, the arm is pushed and its readings show motion "
                "until the control loop faults with a StabilityError: the step raises OperatorPaused and "
                "published no diagnostic, the robot's fault replaces it, the failed result is recorded with the "
                "robot's snapshot, and _reconcile_fault publishes the fault's details as the turn's diagnostic, "
                "with the attempt (lines 268 to 278), before the turn ends as Failed",
                "Lift the cube.",
                [
                    {
                        "op": "run",
                        "turns": [
                            lift,
                            {
                                "model": [
                                    {"emit": ["reasoning_delta", {"text": "Still thinking.", "reasoning_kind": "full"}]},
                                    {"do": "wait_watch"},
                                    {"do": "pause"},
                                    {"do": "wait_stop"},
                                    {**pushed, "then": [unsettled]},
                                    *says(action(z=0.5), ""),
                                ]
                            },
                        ],
                    }
                ],
            ),
            self.play(
                "the model's context is full",
                "the second turn's model request ends with a ContextLimit: the step blocks the session "
                "(blocked_reason) and raises it, the robot is not in FAULT so the error stays (line 254), and the "
                "turn ends with the phase Context limit in an event that is not saved (lines 291 to 295); "
                "resume_pending stays false. run() again, without resume_pending, opens a third turn, whose step "
                "raises ContextLimit of the blocked reason before it observes, and ends it the same way: the "
                "model is not asked, and lines 201 to 203 are not reached",
                "Lift the cube.",
                [{"op": "run", "turns": [lift, {"model": [{"raise": full}]}]}, {"op": "run"}],
            ),
            self.play(
                "on_event by itself",
                "TaskRun.on_event called directly (lines 144 to 182) on a turn that _start_turn opened: an event of "
                "another attempt is dropped (line 150); a phase of Thinking sets the console's phase, the turn's "
                "phase and, the first time only, inference_started_at; a usage is saved unless its `final` is "
                "false; a performance is kept as console.performance with received_at and saved only when its "
                "`final` is true; an observation and a model output are written as the turn's records, and the "
                "observation's event carries URLs in the place of paths; with the cancellation set only a usage "
                "or a performance whose `final` is true is published (lines 152 and 153)",
                "Lift the cube.",
                [
                    {"op": "new_session"},
                    {"op": "start_turn"},
                    event("reasoning_delta", {"text": "Of another turn.", "reasoning_kind": "full"}, attempt=another),
                    event("phase", {"phase": "Thinking"}),
                    event("phase", {"phase": "Thinking"}),
                    event("reasoning_delta", {"text": "Next move.", "reasoning_kind": "full"}),
                    event("usage", {"input": 1200, "output": 10}),
                    event("usage", {"input": 1200, "output": 20, "final": False}),
                    event("usage", {"input": 1200, "output": 30, "final": True}),
                    event("performance", {**timing, "tokens_per_second": 40.0}),
                    event("performance", {**timing, "tokens_per_second": 42.0, "final": False}),
                    event("performance", {**timing, "tokens_per_second": 44.0, "final": True}),
                    event("observation", observation),
                    event("model_output", {"text": self.LIFT, "reasoning": "Next move."}),
                    event("reasoning_delta", {"text": "Too late.", "reasoning_kind": "full"}, cancelled=True),
                    event("phase", {"phase": "Planning"}, cancelled=True),
                    event("usage", {"input": 1200, "output": 40}, cancelled=True),
                    event("usage", {"input": 1200, "output": 50, "final": False}, cancelled=True),
                    event("usage", {"input": 1200, "output": 60, "final": True}, cancelled=True),
                    event("performance", {**timing, "tokens_per_second": 46.0}, cancelled=True),
                    event("performance", {**timing, "tokens_per_second": 48.0, "final": True}, cancelled=True),
                ],
            ),
            self.play(
                "new_session and close_session",
                "new_session starts the task's session with the task's two reference images and is refused while "
                "a session exists (lines 117 and 118); run() then uses that session, and the model's input "
                "carries the images; close_session ends a session (the client is cancelled and closed), does "
                "nothing without a session and a client, and closes a client that never started a session (line "
                "194); a cleanup that fails blocks the session, which is kept, and the error is passed on (lines "
                "189 to 192): run() then opens a turn that ends with the phase Context limit, and a second "
                "close_session ends the blocked session",
                "Lift the cube.",
                [
                    {"op": "new_session"},
                    {"op": "new_session"},
                    {"op": "run", "turns": [lift], "hooks": [{"on": "execution", "turn": 1, "do": "pause"}]},
                    {"op": "close_session"},
                    {"op": "close_session"},
                    {"op": "new_client"},
                    {"op": "close_session"},
                    {"op": "new_session"},
                    {"op": "close_session", "close_raises": cleanup},
                    {"op": "run"},
                    {"op": "close_session"},
                ],
                images=2,
            ),
            self.play(
                "a blocked session when the run continues",
                "an answer without an action is rejected and the run ends with resume_pending set; the session's "
                "cleanup then fails, which blocks the session; run() again reaches _resume_failed_turn, which "
                "waits for the arm to settle and raises ContextLimit of the blocked reason (lines 201 to 203): no "
                "resume_context, resume_pending stays set, no turn opens, and the last turn ends once more, with "
                "the phase Context limit, in an event that is not saved",
                "Lift the cube.",
                [
                    {"op": "run", "turns": [self.turn("I would rather wait and see.")]},
                    {"op": "close_session", "close_raises": cleanup},
                    {"op": "run"},
                ],
            ),
        ]


def constants() -> dict[str, Any]:
    """The names and the numbers of PEAR's console that a port must hold the same."""

    def word(value: Any) -> Any:
        return json.loads(json.dumps(value))

    return {
        "task_run": {
            "UNREACHABLE_RETRIES": TaskRun.UNREACHABLE_RETRIES,
            "RETRY_NOTICE": TaskRun.RETRY_NOTICE,
            "ATTEMPT_ID_CHARS": TaskRun.ATTEMPT_ID_CHARS,
            "STATISTICS_EVENTS": [word(kind.value) for kind in TaskRun.STATISTICS_EVENTS],
            "OUTCOME_PHASES": {word(status.value): word(phase.value) for status, phase in TaskRun.OUTCOME_PHASES.items()},
            "RESUME_CONTEXT_EVENT": TaskRun.RESUME_CONTEXT_EVENT,
            "INTERRUPTED_EVENT": TaskRun.INTERRUPTED_EVENT,
            "RECORD_URL": RECORD_URL,
        },
        "console": {
            "SETTLE_TIMEOUT_S": Console.SETTLE_TIMEOUT_S,
            "EVENT_CAPACITY": Console.EVENT_CAPACITY,
            "PAUSE_REASON": Console.PAUSE_REASON,
            "STOPPING_EVENT": Console.STOPPING_EVENT,
            "ERROR_EVENT": Console.ERROR_EVENT,
        },
        "phase": {member.name: word(member.value) for member in Phase},
        "task_event_kind": {member.name: word(member.value) for member in TaskEventKind},
        "task_files": {
            "JSON_INDENT": TaskFiles.JSON_INDENT,
            "EVENTS_NAME": TaskFiles.EVENTS_NAME,
            "SESSION_NAME": TaskFiles.SESSION_NAME,
            "OBSERVATION_RECORD": TaskFiles.OBSERVATION_RECORD,
            "OUTPUT_RECORD": TaskFiles.OUTPUT_RECORD,
            "RESULT_RECORD": TaskFiles.RESULT_RECORD,
        },
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
        rig = robot_fixtures.Rig(monkeypatch, SEED)
        with tempfile.TemporaryDirectory() as temporary:
            scenarios = Scenarios(rig, monkeypatch, Path(temporary)).all()
    finally:
        monkeypatch.undo()

    calls = [call for scenario in scenarios for call in scenario["calls"]]
    meta = {
        "pear_commit": commit,
        "versions": {"python": sys.version.split()[0], "numpy": np.__version__, "pydantic": pydantic.VERSION},
        "seed": SEED,
        "station": "so101",
        "model": MODEL,
        "root": ROOT,
        "start_s": StandInClock.START_S,
        "wall_start_s": WallClock.START_S,
        "wall_step_s": WallClock.STEP_S,
        "constants": constants(),
        "counts": {
            "scenarios": len(scenarios),
            "calls": len(calls),
            "calls_that_raised": sum(call["raised"] is not None for call in calls),
            "events": sum(len(call["events"]) for call in calls),
            "events_saved": sum(event["saved"] for call in calls for event in call["events"]),
            "model_requests": sum(len(call["model_inputs"]) for call in calls),
            "robot_calls": sum(len(call["robot"]) for call in calls),
        },
    }
    write(directory, meta, scenarios)
    print(json.dumps(meta["counts"]))


if __name__ == "__main__":
    main()
