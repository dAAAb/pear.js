# Progress: `src/console`

Four files of PEAR's operator console (`pear/deploy/station/gui/console`), with the two small files they need.
`task_run.py` is the loop around the turn loop's `step` that runs a task's turns one after another: it asks again
after an action out of reach (up to five times), ends the run after an action that did not complete and settle,
records an operator's pause of a turn as that turn's failed result, and reconciles a robot fault. `console.py` is
the console itself: the state the page shows, the events, the operator's stop, and the one operation that runs at
a time on its worker; `home_review.py` is a Home plan waiting for the operator's answer, and `lease.py` the one
browser tab that may command the robot. Written from PEAR's source at
`f32aa1f7c2ec9c3f45630cc9f8541b3201e8e087`, and held to records of PEAR's own classes: a test replays fifteen
scripted scenarios of PEAR's `TaskRun` on the port, and every place of the records is the same but the last
digits of some joints in two of them (see "How the task run was verified"); another replays twenty scripted
scenarios of PEAR's `Console`, `HomeReview` and `ControlLease`, and every place is the same (see "The console
itself"). The operator's commands and the watchdog are not here yet (see "Left").

## Done

| File | Ports |
| --- | --- |
| `src/console/task_run.ts` | `gui/console/task_run.py`, all 327 lines: `RECORD_URL` (24), the constants of `TaskRun` (31 to 43), its fields (45 to 57), `run` (64 to 112), `new_session` (114 to 142), `on_event` (144 to 182), `close_session` (184 to 196), `_resume_failed_turn` (198 to 210), `_start_turn` (212 to 230), `_save_execution_result` (232 to 246), `_reconcile_fault` (248 to 280), `_end_turn` (282 to 295), `_record_interruption` (297 to 317), `_is_unreachable` (319 to 327). Of `records/task_files.py`: `SESSION_NAME`, `OBSERVATION_RECORD`, `OUTPUT_RECORD`, `RESULT_RECORD` (15 to 27) and the file name of `turn_record_path` (91 to 93) as `turnRecordName` |
| `src/console/phase.ts` | `gui/console/phase.py`, all 52 lines: `STOPPED_STATUSES`, `Phase`, `Phase.idle_for` as `idleFor`; `Phase(word)` as `phaseOf` |
| `src/console/task_events.ts` | `records/task_events.py`: `TaskEventKind` (10 to 21). Not `TaskEvents`, which reads and writes a file |
| `src/console/console.ts` | `gui/console/console.py`, all 309 lines: the constants of `Console` (42 to 49), its fields (51 to 87), `phase` (89 to 92), `is_busy` (94 to 97), `action_format` (99 to 102), `set_phase` (104 to 107), `stop` (109 to 130), `snapshot` (132 to 170), `check_model` (172 to 175), `supports_reference_images` (177 to 181), `emit` (183 to 209), `launch` (211 to 232), `_operate` (234 to 260), `close` (262 to 277), `new_client` (279 to 283), `record_error` (285 to 289), `save_control_diagnostic` (291 to 305), `robot_status` (307 to 309). (The first line of each is PEAR's; each end is taken as two lines before the next begins.) |
| `src/console/home_review.ts` | `gui/console/home_review.py`, all 62 lines: `HomeStatus` (10 to 15), `HomeReview` and its fields (18 to 25), `prepare` (27 to 34), `wait_for_decision` (36 to 53), `confirm` (55 to 62) |
| `src/console/lease.ts` | `gui/console/lease.py`, all 52 lines: `LEASE_S` (9), the fields (11 to 15), `claim` (17 to 23), `heartbeat` (25 to 31), `require` (33 to 36), `lost_owner` (38 to 42), `release` (44 to 48), `is_expired` (50 to 52) |
| `src/console/index.ts` | the module's exports; `src/index.ts` gives them as `console` |

The private methods of PEAR (`_start_turn` ...) are private methods here under the same names in camelCase, as
the turn loop's are. `TaskRun.files` (59 to 62) has no counterpart: see `TaskRecords` below.

### The two interfaces

PEAR's `TaskRun` holds its `Console` and reaches everything through it. Here it is made with
`new TaskRun(console, records, options)`:

- `TaskConsole` is exactly what `TaskRun` uses of `Console`: `robot`, `agentRobot`, `model`, `actionFormat`,
  `modelTimeoutS` (`models_config.models[model].timeout_s`), `newClient(model, instruction)`,
  `emit(kind, data, {isSaved})`, `setPhase(phase)`, `performance` (written), `events` (read), `robotStatus()`,
  `SETTLE_TIMEOUT_S` (PEAR: 10.0) and, optional, `recordUrl(taskId, name)`. PEAR's console has one robot object:
  the loop takes it, and `TaskRun` calls its `wait_settled`, `status(with_snapshot=True)` and `check_fault`. In
  pear.js the loop takes an `AgentRobot` (the station's robot behind its `AgentRobotAdapter`), so the console
  gives both: `robot` (`TaskRobot`: those three calls) and `agentRobot`. `TaskRun` makes no hardware and no
  adapter. As in PEAR, `emit` is the console's: it is the console that adds the running turn's fields to an event
  (`{...taskRun.activeTurn, ...data}`), numbers it and keeps it.
- `TaskRecords` is what `TaskRun` uses of `TaskFiles`: `writeJson(taskId, name, value)`, a record under the name
  of PEAR's file (`session.json`, `<attempt id>-observation.json`, `-output.json`, `-result.json`), and
  `readFile(taskId, name)`, the bytes of a reference image. A page has no folder; the names are kept so that a
  page can keep or hand out the records.

### How the Python is carried over

1. The cancellation is an `AbortSignal` where PEAR's is a `threading.Event`: `cancellation.is_set()` is
   `cancellation.aborted`, and `OperatorPaused.check_cancelled` is the station's `OperatorPaused.checkCancelled`,
   as in the loop.
2. `functools.partial(self.on_event, cancellation, attempt_id)` is a closure.
3. `with console.lock` (line 271, in `_reconcile_fault`) is nothing: a page has one thread, and nothing is
   awaited between the look through the events and the event. A comment stands where the lock was.
4. `time.time()` is the option `wallClock`, by default the machine's clock in seconds (`Date.now() / 1000`). It is
   read where PEAR reads it: for `received_at`, `inference_started_at` and `started_at`.
5. `uuid4().hex[:12]` takes a UUID from the option `uuid` (by default a random one), removes its dashes and keeps
   the first 12 characters. The loop's own UUIDs, clock and waits are a separate option, `loop`, which is handed
   to the `StationAgentLoop` a session is made with; the two do not share a source unless a caller gives both the
   same function.
6. `asdict(last_turn.model_output)` is `modelOutputRecord` of `src/agent/clients/schemas.ts`, which the loop uses
   for the `model_output` event. `result.to_record()` is the loop's `resultRecord`.
7. `raise failure from None` throws the failure itself.
8. `str(failure)` is `pythonErrorMessage`; `RETRY_NOTICE.format` and `RECORD_URL.format` are `formatTemplate`
   with the counts written by `pythonStr`.
9. Python's truth is kept where PEAR tests a value: `self.session` and `self.model_client` (there or `None`),
   `self.active_turn`, `result.error` and `details` (there and holding a key), `session.blocked_reason` (an empty
   text is false), `bool(data.get("final"))` for a performance event and `data.get("final", True)` for a usage
   event (`pythonTruth`; a usage report without `final` is saved). `data.get("final") is True` is `=== true`,
   and `last_turn is not turn_before_step` compares the objects, not their fields.
10. The order of the keys of every object that is emitted or recorded is PEAR's: `{...data, attempt}` keeps the
    keys of `data` first, as `{**data, "attempt": id}` does, and a key that `data` already has keeps its place.
11. Where Python raises because there is no task or no session (`self.task["id"]`, `self.session.last_turn`,
    `self.active_turn["phase"] = ...`, `data["phase"]`, `details["code"]`, `Phase(word)`), the port throws the
    class of that name with Python's text (`TypeError`, `AttributeError`, `KeyError`, `ValueError`).

### The observation event

The port's loop puts into the data of `TurnEvent.OBSERVATION`, under `images`, the name of each frame's file
(`<attempt id>-<camera name>.jpg`) where PEAR's holds the file's path; the frame's JPEG bytes are not in the
event but in the turn's model input. `TaskRun` keeps PEAR's steps: it records the data as
`<attempt id>-observation.json`, then replaces `images` by `{camera name: url}` and adds `details_url`. A URL is
made by `console.recordUrl(taskId, name)` if the console has one, else by `recordUrl`, PEAR's text
(`/api/records/{task_id}/{name}`). `Path(path).name` is kept, so a loop that gave paths would give the same URLs.

The bytes are not touched: nothing writes a frame. In PEAR the loop's message builder saves each frame as a JPEG
file in the task's folder, and the page's service serves that file under the URL. A page that shows a turn's
frames takes them from `taskRun.session.lastTurn.modelInput.images` (each with `name` and `bytes`) when the
`observation` event arrives, for example into object URLs that its `recordUrl` returns.

## Deliberate differences of the task run

1. **Async.** `run`, `closeSession` and the private methods that reach the robot or the loop are async functions;
   PEAR's block the console's worker thread. `newSession` and `onEvent` are synchronous, as PEAR's: an error
   thrown in `onEvent` reaches the loop's `step` as it does in PEAR. The robot's calls may return a value or a
   promise (`TaskRobot`, `robotStatus`).
2. **Two robots**, `robot` and `agentRobot`, where PEAR's console has one (above).
3. **Records, not files.** `TaskRecords.writeJson` is synchronous and takes the value, not a text: PEAR writes the
   file before the event that names it, and so must a store. PEAR's JSON text of a record (indent 2, ASCII
   escapes, no NaN, a newline at the end) is **not given**: `src/python`'s `pythonJsonDumps` has no indent and
   writes every number as a float, and a record holds ints. PEAR refuses a NaN in a record with a `ValueError`
   (`allow_nan=False`), which ends the turn; a store decides that here.
4. **Images are bytes.** A reference image is read from the records when the session is made
   (`records.readFile(taskId, image.file)`), where PEAR hands the client a path that is read at the first request:
   a missing image fails `newSession`, not the first turn. The observation record holds each frame's file name,
   not its path (above).
5. **`isSaved` is a boolean**: Python's truth of what PEAR passes as `is_saved`.
6. **The constants** are read from `TaskRun` itself (`TaskRun.UNREACHABLE_RETRIES`), where PEAR reads them through
   `self`: a subclass that overrides one is not followed.
7. **`OperatorPaused`** is told by its class or by its Python name, as the loop tells it; the library does not
   export the loop's two-line check, so `task_run.ts` has its own. `ContextLimit` is told by its class.
8. **`catch`** takes whatever is thrown; PEAR's `except Exception` leaves a `KeyboardInterrupt` alone.
9. **`CaptionPhase`** is not ported: `Phase.COMPLETED` is the word `"Completed"`, typed in `phase.ts`. The
   turn's, the model's and the action's phases are taken from the port's own enums.

## How the task run was verified

`tests/console/task_run.test.ts` replays the fifteen scenarios of `tests/fixtures/console/task_run.json.gz` (52
calls: 21 of `run()`, 19 of `on_event` by itself, 6 of `close_session`, 4 of `new_session`, one of the private
`_start_turn`, and one assignment of a client that never started a session), records of PEAR's own `TaskRun` run
by PEAR's Python (`tools/fixtures/console_fixtures.py`), on the port's `TaskRun`: with a real
`StationAgentLoop`, pear.js's own `SO101Robot` on the stepped stand-in arm, a
scripted model made by the port's `ModelsConfig` and `OfferedModel`, and a stand-in for PEAR's `Console`
(`tests/console/rig.ts`: its `emit`, `set_phase`, `stop`, `robot_status` and `new_client` do what PEAR's lines
do; it is to be replaced when `console.py` is ported). The port and the fixtures were written without sight of
each other.

Compared for every call, exactly (a number is the same double, a dictionary has PEAR's keys in PEAR's order): what
the call raised (class name and message); every event (id, type, data, time, monotonic_s, task_id, saved); the
phases set and the phase after; the files of the task's folder (the JSON value of `session.json` and of each
turn's records, `events.jsonl` as the ids of the saved events, a frame by its name); `TaskRun`'s fields; the
session's turn count, blocked reason and previous result; `console.performance`; the robot's status; the robot's
calls with what they were given and returned and the event they came after; what the model was sent; the UUIDs
drawn; the clock (control periods, monotonic time, readings of the wall clock). Of a `new_session` also what the
new session was given (that its robot is the console's and its client the task run's, the action format, the
timeout, each reference image's file and uuid, the episode), and the task's reference image files whole (size and
SHA-256: the rig makes the stand-in bytes the fixture script made). Of a `close_session` also how often the
client's `cancel()` and `close()` were called from outside the client. A call's record holds no part that the test
does not compare: it fails on a part it does not know. Once: `TaskRun`'s constants, `RECORD_URL`, the words of
`Phase` and of `TaskEventKind`.

| Scenario | What it holds of `task_run.py` | Result |
| --- | --- | --- |
| 1 pause between turns | three turns complete, the operator pauses between turns | the same but for 55 places (below) |
| 2 pause while the model is asked | the turn's end, the interruption recorded as the failed result, then a resumed run | the same in every place |
| 3 pause while the arm moves | the same with the arm in motion, then a resumed run | the same but for 36 places (below) |
| 4 pause before the model is asked | a pause the turn meets before its request | the same in every place |
| 5 out of reach six times | five notices, the sixth ends the run; the resume with `resume_context` | the same in every place |
| 6 out of reach, reachable, out of reach | the count of retries starts again | the same in every place |
| 7 an action that fails while it runs | the failed turn's end, unsaved; `resume_pending` | the same in every place |
| 8 a fault during a turn | the reconciliation of a fault after the turn observed | the same in every place |
| 9 a fault before the turn has observed | the reconciliation without a turn of the step | the same in every place |
| 10 a fault with a diagnostic that the turn published | the arm is pushed as turn 2 opens and the control loop faults: one `diagnostic` event, the turn's, none from the reconciliation | the same in every place |
| 11 a fault with a diagnostic of a cancelled turn | the failed result with the snapshot, `resume_pending`, then the `diagnostic` of the reconciliation | the same in every place |
| 12 the model's context is full | the turn's end `Context limit`, unsaved; the blocked session; a second `run()` opens a turn and ends it the same way, the model not asked | the same in every place |
| 13 `on_event` by itself | another attempt's event dropped; Thinking twice; `USAGE` saved unless `final` is false; `PERFORMANCE` saved only when final, and `console.performance`; the observation's and the model output's records and URLs; a cancelled turn passes only final statistics | the same in every place |
| 14 `new_session` and `close_session` | a session with two reference images, the refusal of a second, a run whose model input carries the images, the close of a session, of nothing, of a client without a session, a close that raises (blocked, kept), `run()` then ends `Context limit` | the same in every place |
| 15 a blocked session when the run continues | a rejected answer, a cleanup that fails, `run()`: the wait to settle, the `ContextLimit` of the blocked session, no `resume_context` | the same in every place |

The places of scenarios 1 and 3: the five arm joints of a measured position (and of the joint positions and, in
scenario 3, the tracking error that follow from it) after an action whose joint target pear.js's own kinematics
gave. The fixture records no answers of PEAR's kinematics; the rig answers a question as PEAR did where the
turn loop's fixtures (`agent_rig.json.gz`) hold the same question (23 of 26 over the fifteen scenarios), and
pear.js's kinematics answer the other 3, in other last digits (at most 1e-12 rad apart, which the test
checks). The two tests carry the reason
in their names, fail when any other place differs, and fail when the places no longer differ.

Shown to fail (each change of `task_run.ts` made alone, the test run, the file put back): `UNREACHABLE_RETRIES`
5 to 4 (the constants, scenarios 5 and 6); the failed turn's end saved (scenarios 5, 7, 8, 9); `totalSteps`
counted by two (all nine); `details_url` before the observation's other keys (all nine). And fifteen in paths
that only scenarios 10 to 15 meet, each failing those and none of the first nine: the text "Model cleanup
incomplete: " (14, 15); `USAGE` saved when `final` is false (13); a second session not refused (14); the phase
`Failed` for a turn that ends with a `ContextLimit` (12, 14, 15); the diagnostic sent although the turn published
it (10); the diagnostic of a cancelled turn not sent (11); a blocked session's resume raising a `RuntimeError`
(15); the start of the inference set again at a second Thinking (13); a cancelled turn's statistics passed without
`final` (13); a reference image's uuid (14); a client without a session not closed (14); `closeSession` keeping
the client (14); `PERFORMANCE` always saved (13); an event of another attempt not dropped (13); the session's
client closed directly and not through the loop (14, 15).

Fixes of the port made by this comparison: none. No place was found where `task_run.ts` does other than PEAR's
record.

## Not verified of the task run

- **Nothing the fixture does not hold**: the case of `_reconcile_fault`'s own comment (the turn publishes the
  diagnostic after `execute`, then a watchdog cancels: scenario 10's fault comes before the turn observes, so it
  shows "not sent again" without a recorded result); a model's `ContextLimit` while `resume_pending` is set;
  `onEvent` for an `ACTION`, a `NOTICE` or a `DIAGNOSTIC` by itself, a `PHASE` without an active turn or without
  `phase`, a cancelled `OBSERVATION` or `MODEL_OUTPUT`, an observation without images; a client without a session
  whose close raises; the session's close failing because a step still runs; a `newSession` that fails half way;
  a second `run()` after scenario 7 with PEAR's `recover`. These rest on a reading of PEAR's source.
- **`on_event` by itself has the fixture script's payloads**, not PEAR's real ones (it reads only `final`, `phase`
  and `images` of them), and its turn is opened by `_start_turn`, not by `run()`.
- **The folder a session is given.** PEAR's session is given the task's folder and the path of each reference
  image; the port's loop is given no folder and each image's bytes, name and uuid. Compared: the name, the uuid,
  and that the bytes are the task's file's. Whether PEAR's upload store gives an image's record more keys than
  `id`, `file` and `url` is not known to the fixture.
- **Two values of the records are the rig's**, compared though they say nothing of the port: the phase before
  any phase is set ("Holding": what the fixture script gave PEAR's console and the stand-in console starts with;
  `TaskRun` does not read it), and `client.cancelled`, which leaves out the `cancel()` a client's own `close()`
  makes, on both sides.
- **The order of `attempt` among the keys TaskRun gives `emit`** cannot be seen in an event: `emit` puts the
  running turn's fields first. Moving `attempt` last in the execution event's data fails no test.
- **A frame's bytes and a frame's folder.** The port's loop writes no frame; a frame is compared by its name, and
  the path PEAR's observation record holds by its last part.
- **The numbers of the three actions above**, and whether Ruckig's inexact functions were the reference's
  everywhere: 25 of their arguments were not in the station's table and were answered by the engine.
- **One thread.** PEAR's operator pauses from another thread; here a hook's pause inside `emit` starts the
  robot's stop and the rig awaits it before the robot's next call. The fixture pins one order of PEAR's threads,
  and this replay reproduces that one. A hook that sleeps inside `emit` (scenario 10: 250 control periods) cannot
  sleep there either: the time of its sleeps passes at once for the console's stamp and the loop's clock, and the
  control loop's steps run before the robot's next call, each at its own time. An event published between two
  such sleeps would not be reproduced; no record has one.
- **The JSON text of a record** (above), and a page: nothing here runs in a browser.
- `tests/console/task_run_by_hand.test.ts` (1 test) stays: it compares with nothing of PEAR's.
- Whether a console that implements `TaskConsole` on the station's robot type-checks without a cast
  (`BaseRobot` against `TaskRobot`) has not been tried: the rig's robot is a wrapper that forwards the three calls.

## The console itself: `console.ts`, `home_review.ts`, `lease.ts`

The sections above are the task run's. `_operate` is the private method `operate`. `Console` implements
`TaskConsole`: `new TaskRun(console, ...)` is made by the console itself, as PEAR's is (`console.taskRun`).

### What a console is made with

PEAR's `Console(config, root=, uploads_dir=)` makes everything it holds. Here it is given them (`ConsoleOptions`):

- `modelsConfig` (PEAR: `ModelsConfig.from_station_config(config)`), `robot` (the station's robot), `agentRobot`
  (the same robot as the turn loop takes it), `cameraFeed` (the feed the robot was made with), `robotProfile`.
- `records` (`ConsoleRecords`, which extends the task run's `TaskRecords`): `writeRootJson(name, value)` for
  `TaskFiles.write_json(root / name, value)` (`home-failed-<ns>.json`, `control-fault-<ns>.json`) and
  `appendEvent(taskId, event)` for `TaskEvents(TaskFiles(root / task_id).events_path).append(event)`. No path, no
  file system; PEAR's JSON text (a record: indent 2, no NaN, a newline; an event: one line, no NaN) belongs to
  whoever stores it.
- The parts that are not ported, each an interface with exactly what `console.py` uses of it:
  `ConsoleRecordings` (`stop(reason, {stoppedAt})`, `snapshot()`, `onEvent(kind, data)`, `close()`),
  `ConsolePreview` (`status()`, `close()`), `ConsoleWatchdog` (`close()`); `ConsoleUploads`, `ConsoleAnnotations`
  and `ConsoleCommands` are `object`: `console.py` calls nothing of them, the console only holds them.
  `commands` and `watchdog` are functions of the console, called where PEAR calls `Commands(self)` (after the task
  run and the Home review, before the preview) and `Watchdog(self)` (last).
- `ConsoleRobot` is what `Console` calls of the robot beside `TaskRobot`: `sessionId`, `stop()`, `status()` and
  `status(true)`, `close()`. The station's `BaseRobot` satisfies it without a cast (held by the type check, in
  `tests/console/console_by_hand.test.ts`). `self.robot.CAMERAS` and `open_cameras` are used only to make the
  recordings and the preview, which are given, so they are not in it.

### How the console's Python is carried over

1. **The worker thread.** An operation is an async function (`Operation`: it is given the cancellation's signal).
   `launch` checks and starts it and does not await it; it stays synchronous. `ConsoleWorker` stands for the
   thread: `isAlive` (`is_alive()`), `ended` (a promise of the end of the body) and `join(timeoutS)`
   (`Thread.join`: it returns at the end or at the time limit, which waits on the option `sleep`). `isBusy` is
   `worker !== null && worker.isAlive`. The body begins on a later microtask, so whatever the caller of `launch`
   still does without awaiting comes first: a thread that is started and has not run yet. In PEAR the callers
   hold the console's lock around `launch`, so the operation's first write waits for them there too.
2. **The cancellation** is an `AbortController` the console holds (`console.cancellation`); `launch` takes one
   (`{cancellation}`) or makes a new one, as PEAR does with its event; `stop()` aborts it. `launch` replaces the
   console's controller before it checks it, as PEAR does. `HomeReview.answered` is an `AbortController` too:
   `set()` is `abort()`, `wait()` waits for the signal, and `clear()` puts a new controller in the place of an
   aborted one (one that is not aborted stays, so a waiter is still woken). Nobody may keep a reference to it.
3. **The lock.** `with self.lock` is nothing at every place (a comment stands at each): nothing is awaited inside
   one. No call that the port awaits is under PEAR's lock in these files. `HomeReview` is made without a lock.
4. **What an await lets in.** `stop()` aborts the cancellation and calls the robot's stop before it returns its
   promise; the latch, the phase `Stopping`, the recording's stop and the event `stopping` come once the robot's
   stop has ended, and the cancelled operation may end before them (in PEAR the two run on two threads, so the
   same order is possible there). In `operate` the robot's stop is awaited between the log line and
   `record_error`; in `close` each of the stop, the join, the closes and `close_session` is awaited in PEAR's
   order.
5. **Synchronous where PEAR is**: `snapshot`, `emit`, `setPhase`, `robotStatus`, `recordError`,
   `saveControlDiagnostic`, `launch`, and all of `ControlLease`. The robot's `status` is read without awaiting
   (`ConsoleRobot` narrows `TaskRobot`'s, which may return a promise), so a snapshot is one moment.
6. **Clocks and ids**: `wallClock` (`time.time()`), `clock` (`time.monotonic()`; the lease and the health checks
   are given the same), `timeNs` (`time.time_ns()`, a `bigint`), `uuid` (`uuid4()`, handed to the task run and the
   Home review), `sleep` (the join's time limit), `loop` (the task run's). `uuid4().hex` removes the dashes.
7. **The log**: `logger.exception(text)` is `log("console", "error", text, error)`, the station's robot's
   `RobotLog`; by default nothing.
8. **Python's truth** is kept: `self.error or "Task paused"`, `if active_turn and ...`, `(task or {}).get("id")`,
   `is_saved and task_id`, `not robot_state.get("fault")`, `robot_state.get("motion", {}).get("settling")`,
   `not self.plan`. The tuple `(session_id, generation)` is compared element by element.
9. **Order of keys**: `snapshot()`, the event (`id`, `type`, `data`, `time`, `monotonic_s`, `task_id`), the
   `stopping` data, the fault record and `{**error.details, "status": ...}` are written in PEAR's order;
   `{...activeTurn, ...data}` as `{**active_turn, **data}`. `emit` hands the recordings the data as given, then
   copies it. The events are an array that drops its oldest beyond `EVENT_CAPACITY` (PEAR: a deque).
10. **Errors**: `ValueError` and `RuntimeError` with PEAR's texts; `models[model]` for a name that is not
    offered and `robot_state["fault_details"]`, `plan["plan_id"]` for a missing key throw `KeyError` with
    Python's text. `except (OSError, ValueError)` is `instanceof OSError || isValueError(error)`.

### Deliberate differences of the console

1. **Async**: `stop`, `close`, `waitForDecision` and the worker's body return promises; `checkModel` too (the
   port's `HealthChecks.check` does).
2. **`robotProfile`** is an option: PEAR calls `self.robot.profile()`, a classmethod, on the object; the port's
   `BaseRobot.profile` is static, which an object does not give.
3. **The system prompt.** PEAR renders `SystemPrompt.render(instruction, action_format)`. The port's
   `systemPrompt(instruction)` takes no format, so `newClient` calls the option `renderSystemPrompt(instruction,
   format)`, by default the port's function without the format.
4. **`supportsReferenceImages`** reads the static method of the client's class through a cast: `ModelClientClass`
   is the constructor's type alone.
5. **Members that are not PEAR's**: `agentRobot`, `modelTimeoutS` and `recordUrl` (what `TaskConsole` asks for),
   `records` in the place of `root`, the instance's `SETTLE_TIMEOUT_S` beside the static one.
6. **An error that leaves the worker's body** (the robot's stop failing in the failure handling, a record that
   cannot be kept) ends the worker as it ends PEAR's thread; Python prints it, here it goes to the log as
   `Exception in thread gui-operation`.
7. **`timeNs`** by default advances by a millisecond (`Date.now()`), where PEAR's clock has nanoseconds: two
   records of one kind in the same millisecond would have the same name.
8. **`catch`** takes whatever is thrown; `OperatorPaused` is told by its class or by its Python name (a third
   copy of the loop's two-line check, which the library does not export).
9. **The constants** are read from the classes themselves (`Console.EVENT_CAPACITY`, `ControlLease.LEASE_S`).
10. **`models`** of the snapshot are in the order of the object's keys: a model whose name is a whole number
    would come first in JavaScript, where Python keeps the order they were given in.

### How the console was verified

`tests/console/console.test.ts` replays the 20 scenarios (174 steps) of `tests/fixtures/console/console.json` on
the port. The record is of PEAR's own `Console`, `HomeReview` and `ControlLease`, unchanged, run by PEAR's Python
through `tools/fixtures/console_core_fixtures.py`; `tests/console/console_rig.ts` is that script's rig (its scripted
clocks and UUIDs, its recording stand-ins, its scripted operations, its steps) in TypeScript, around the port's
`Console`.

For every step, every part of the record is compared (the same double, the same keys in the same order, the same
number of items): what the call returned (`snapshot()` whole, the event of `emit`, the report of `stop`) or raised
(the class's name and the message); every event as `emit` made it, the thread that emitted it and whether the
task's events hold it; every phase `set_phase` was given, by thread; every call of the robot and of each stand-in,
by thread, with its arguments, its keywords, the id of the last event when it began and what it returned or
raised; what each operation of a `launch` was given and how it ended; the console's fields after the step; the
files under the console's root; how often each clock was read. Before the first step the console's fields are
compared with the scenario's `initial`; at its end, every UUID of the scenario was drawn. One test compares the
constants of `Console`, `ControlLease`, `HomeStatus`, `Phase` and `RobotStatus` with the record's (an
enumeration's members in PEAR's order), and one counts what the replays made against the fixture's own counts
(174 steps, 14 that raised, 534 events, 6 saved, 672 calls of stand-ins, 26 operations).

The port needed no fix: all 20 scenarios are the same as PEAR's, part for part.

How the port's `Console` is given what the script sets on PEAR's by attributes: it is made by its constructor with
the stand-ins as its options, and the two parts the constructor makes itself and the script replaces (`task_run`,
`health_checks`) are written over the made console's `taskRun` and `healthChecks`. PEAR's `robot.profile()` is the
option `robotProfile`, recorded as the robot's call. PEAR's worker thread is the async context in which the rig
calls `launch`: what the worker's body does is compared with the record's worker thread, everything else with its
main thread.

That the test can fail: changes were made to the port on purpose, one at a time, in a scratch copy. Of 21 made
by the test's author 20 made the replay fail: the event capacity (499); the latch when the robot's stop raises;
the phase after a failure with the robot in FAULT; the order of what `close` closes; a key of `snapshot()` moved;
the order of the turn's fields in an event; an event saved although `is_saved` is false; `stop` without
`stopped_at`; a Home plan not withdrawn at an operation's end; the console's cancellation kept when `launch` is
given one that is set; the error event saved; a fault's identity without the robot's session; Executing not shown
as Settling; `close` with the motors on; an event's `time` read from the monotonic clock; an event without its
`task_id`; the turn's fields on an event of another attempt; a lease expired at exactly `LEASE_S`; `prepare`
keeping the last answer; the plan kept after the answer. The one that passed, an event that keeps the caller's
data and no copy of it, now fails a test written by hand (below). Nine more, made by a second reader, each made
the replay fail: `stop` keeping the performance; the recording told of an event after the event is made; `launch`
while an operation runs; a failed operation shown before the robot is stopped; a failed Home shown as Stopping; a
recorded operation always ended as "Task paused"; a snapshot that never says busy; the error's text without its
class; another default reason of `stop`.

`tests/console/console_by_hand.test.ts` (5 tests) compares with nothing of PEAR's; its expectations were typed
from a reading of `console.py`: an operation that fails (the log line, the robot's stop, the event `error` with
its keys, the phase, the recording's stop with the error's text), `launch` refusing a second operation, the type
check of the station's `BaseRobot` against `ConsoleRobot`, and the two things of `emit` that no record holds: the
copy of the data (next section but one) and the attempt of a turn that has none (next section). Each of the two
fails when the port is changed back.

### A fix made from a reading of PEAR

No scenario disagreed, so the records asked for no fix. One difference was found by reading: PEAR merges the
running turn's fields into an event when `data.get("attempt") == active_turn["attempt"]` (console.py line 191),
which is true for a turn whose attempt is None and data without an attempt; the port compared with `===`, which
is false there. The port now takes data without an attempt as None. PEAR's `TaskRun` gives every turn an attempt
id, so only a stand-in's turn shows the difference and no record does: a test written by hand holds it.

### Not verified of the console

- **`emit`'s copy of the data** (console.py line 194, `data = dict(data)`) is held by the test written by hand
  alone: no record changes the data after the call, so PEAR's record cannot show the copy.
- **The constructor.** The script makes PEAR's console without its constructor, and the rig replaces the port's
  `taskRun` and `healthChecks`: how the port's constructor makes its `TaskRun` and its `HealthChecks` (console.py
  lines 52 to 87; a check's client made with `CHECK_INSTRUCTION`) is held by no record. The test holds only that
  the constructor calls no stand-in, reads no clock, and leaves the fields of every scenario's `initial`.
- **The order between the main thread and the worker within a step**: PEAR's record keeps the two threads' calls
  and phases apart, each in its own order; so are they compared. The port's worker begins on a later microtask
  and PEAR's on a thread; where a scenario lets both act in one step, any interleaving that gives the same lists
  for each thread passes.
- **`ConsoleWorker.join`'s time limit** (the option `sleep`): no scenario closes a console whose worker still runs.
- **A fault record that cannot be written** (`saveControlDiagnostic`'s `catch`, console.py lines 304 to 305), an
  event whose kind is an enum member, `supports_reference_images` answering false, a model that names an action
  format of its own, the system prompt of `new_client`: in no record.
- **The robot, the task run and the health checks of the record are scripted stand-ins**: nothing here is the
  console on PEAR's robot or with PEAR's `TaskRun`, with real models, or in a page. `HomeReview` and
  `ControlLease` are run as the console's own, not alone.
- **The rig's translation of a call** into PEAR's form (an options object into PEAR's keywords, `status(true)`
  into `status(with_snapshot=True)`, PEAR's `robot.profile()` as the option `robotProfile`) was checked by
  reading: a call of another shape shows as a difference, but a wrong rule that matched a wrong port would not.
- What PEAR logs (`logger.exception`) is not in the record; the port's log lines are not compared.

## Left

Of `TaskRun`: nothing of its code; the JSON text of a record (above).

Of `Console`, `HomeReview` and `ControlLease`: nothing of their code; a record of the console on PEAR's robot
with PEAR's `TaskRun` (the two fixtures hold the task run and the console apart), and the two things of `emit`
that only a test written by hand holds.

Of the console, not in the repository:

- `commands.py` (438 lines), `Command` and `Commands`: the operator's commands, each admitted on the caller's
  thread; a long one then runs on the console's worker. `watchdog.py` (93 lines), `Watchdog`: a background check
  that pauses the robot when the browser that holds control, the recording or the cameras fail.
  `periodic_thread.py` (58 lines), `PeriodicThread`: a background thread that does a step every period until it
  is closed. These three are written and are being compared with records of PEAR's own; they come into the
  repository when a test holds them.
- `preview.py` (154 lines), `PreviewFrame` and `Preview`: the cameras as the page shows them: the latest frame of
  each camera as JPEG, and the cameras' errors. Not ported.
