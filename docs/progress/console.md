# Progress: `src/console`

Seven files of PEAR's operator console (`pear/deploy/station/gui/console`), with the two small files they need.
`task_run.py` is the loop around the turn loop's `step` that runs a task's turns one after another: it asks again
after an action out of reach (up to five times), ends the run after an action that did not complete and settle,
records an operator's pause of a turn as that turn's failed result, and reconciles a robot fault. `console.py` is
the console itself: the state the page shows, the events, the operator's stop, and the one operation that runs at
a time on its worker; `home_review.py` is a Home plan waiting for the operator's answer, and `lease.py` the one
browser tab that may command the robot. `commands.py` holds the operator's commands (start, pause, resume, clear,
STOP MOTION and its reset, enable, disable, Home and its confirmation, the recovery of control, the cameras'
reconnection, the model, the recording); `watchdog.py` is the background check that pauses the robot when the
browser that holds control, the recording, the cameras or the control fail, and `periodic_thread.py` the loop it
checks on.

Written from PEAR's source at `f32aa1f7c2ec9c3f45630cc9f8541b3201e8e087`, and held to records of PEAR's own
classes by four replays, each comparing every part of every step: fifteen scripted scenarios of PEAR's `TaskRun`
(every place of the records the same but the last digits of some joints in two of them: see "How the task run
was verified"); twenty of PEAR's `Console`, `HomeReview` and `ControlLease` (see "The console itself"); thirty of
PEAR's `Commands` and `Watchdog` (see "The operator's commands"); and four of PEAR's `Commands` running a task on
PEAR's `Console`, `TaskRun` and real robot, replayed on the three ported parts together (see "The three parts
together"). The second and the third stand on scripted stand-ins for the robot and the task run. The fourth is
the only one in which the commands run a task on the real robot: a task started, paused, resumed, cleared and
started again, with the watchdog's check between; `clear` while the task runs; and STOP MOTION while an action
moves the arm, with its reset. A turn that fails is not among its scenarios yet. What the records do not reach
is either held by tests written by hand, which compare with nothing of PEAR's, or named as not verified.
The camera preview and the page's service are not here (see "Left"), and no page uses the console yet.

## Done

| File | Ports |
| --- | --- |
| `src/console/task_run.ts` | `gui/console/task_run.py`, all 327 lines: `RECORD_URL` (24), the constants of `TaskRun` (31 to 43), its fields (45 to 57), `run` (64 to 112), `new_session` (114 to 142), `on_event` (144 to 182), `close_session` (184 to 196), `_resume_failed_turn` (198 to 210), `_start_turn` (212 to 230), `_save_execution_result` (232 to 246), `_reconcile_fault` (248 to 280), `_end_turn` (282 to 295), `_record_interruption` (297 to 317), `_is_unreachable` (319 to 327). Of `records/task_files.py`: `SESSION_NAME`, `OBSERVATION_RECORD`, `OUTPUT_RECORD`, `RESULT_RECORD` (15 to 27) and the file name of `turn_record_path` (91 to 93) as `turnRecordName` |
| `src/console/phase.ts` | `gui/console/phase.py`, all 52 lines: `STOPPED_STATUSES`, `Phase`, `Phase.idle_for` as `idleFor`; `Phase(word)` as `phaseOf` |
| `src/console/task_events.ts` | `records/task_events.py`: `TaskEventKind` (10 to 21). Not `TaskEvents`, which reads and writes a file |
| `src/console/console.ts` | `gui/console/console.py`, all 309 lines: the constants of `Console` (42 to 49), its fields (51 to 87), `phase` (89 to 92), `is_busy` (94 to 97), `action_format` (99 to 102), `set_phase` (104 to 107), `stop` (109 to 130), `snapshot` (132 to 170), `check_model` (172 to 175), `supports_reference_images` (177 to 181), `emit` (183 to 209), `launch` (211 to 232), `_operate` (234 to 260), `close` (262 to 277), `new_client` (279 to 283), `record_error` (285 to 289), `save_control_diagnostic` (291 to 305), `robot_status` (307 to 309). (The first line of each is PEAR's; each end is taken as two lines before the next begins.) |
| `src/console/home_review.ts` | `gui/console/home_review.py`, all 62 lines: `HomeStatus` (10 to 15), `HomeReview` and its fields (18 to 25), `prepare` (27 to 34), `wait_for_decision` (36 to 53), `confirm` (55 to 62) |
| `src/console/lease.ts` | `gui/console/lease.py`, all 52 lines: `LEASE_S` (9), the fields (11 to 15), `claim` (17 to 23), `heartbeat` (25 to 31), `require` (33 to 36), `lost_owner` (38 to 42), `release` (44 to 48), `is_expired` (50 to 52) |
| `src/console/commands.ts` | `gui/console/commands.py`, all 438 lines: `Command` (28 to 37), the constants of `Commands` (44 to 51), the table (53 to 72), `run` (74 to 97), `_stop_before` (99 to 109), `_pause` (111), `_stop` (115), `_confirm_home` (119), `_reset_stop` (125 to 139), `_reconnect_cameras` (141), `_replace_cameras` (150), `_enable` (160), `_open_robot` (172), `_recover_control` (181), `_recover` (196 to 217), `_start` (219 to 277), `_resume` (279), `_clear` (292), `_clear_task` (296), `_disable` (307), `_close_robot` (315 to 334), `_home` (336), `_return_home` (357 to 386), `_report_home_progress` (388), `_review_home` (398), `_select_model` (407), `_set_recording` (417), `_start_recorded_loop` (424 to 438). Of `records/task_files.py`: `TASK_NAME` (17) |
| `src/console/periodic_thread.ts` | `gui/console/periodic_thread.py`, all 58 lines: `PeriodicThread` with `MIN_WAIT_S`, `JOIN_S`, `close` (37), `_run` (42 to 58) |
| `src/console/watchdog.ts` | `gui/console/watchdog.py`, all 93 lines: `Watchdog` with `PERIOD_S`, `THREAD_NAME`, `PHASES_WITHOUT_CAMERAS`, `close` (26), `_check` (30 to 66), `_release_lost_browser` (68), `_stop_for_fault` (77 to 93). Of `records/recording/encode_worker.py`: `SegmentStatus.FAILED` (29) as `SEGMENT_FAILED` |
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

## The operator's commands: `commands.ts`, `watchdog.ts`, `periodic_thread.ts`

In the table above, the line of a method is its first; a range is given where the end was read off the source.
PEAR's private methods are private methods here under the same names in camelCase (`_stop_before` is
`stopBefore`).

### What `Commands` and `Watchdog` are made with

PEAR makes both with the console alone. Here:

- `new Commands(console, options)`: `console` is a `CommandsConsole`, the `Console` whose parts have what
  `commands.py` uses of them; `options` are `robotClass` (required: `ACTION_FORMATS`, `HOME_ARM_CHOICES`,
  `HOME_CAN_KEEP_GRIPPERS`, which PEAR reads through the robot object and the port's robot has as static
  members; the robot's class itself fits) and `wallClock`, `timeNs`, `uuid`, `log`.
- `new Watchdog(console, options)`: `console` is a `WatchdogConsole`; `options` are `clock`, `sleep`, `log`, handed
  to its `PeriodicThread`.
- `console.ts` is unchanged. Its interfaces of the parts hold what `console.py` uses; what `commands.py` and
  `watchdog.py` use beyond that is in interfaces that extend them: `CommandsRobot` (`open`, `waitStationary`,
  `recover({cancellation})`, `home(options)`), `CommandsPreview` (`isEncoding`, `errorText`,
  `reconnect(cancellation)`), `CommandsUploads` (`attach(uploadIds, owner, taskId)`, `delete(uploadId, owner)`),
  `CommandsAnnotations` (`cleanTags(rawTags)`, `update(taskId, {tags})`), `CommandsRecordings` (`isEnabled`,
  `start(task, cameraFeed, robotStatusReader)`), `CommandsRecords` (`createTask(taskId)`, `removeTask(taskId)`),
  `WatchdogRecordings` (`activeSegment`, whose `snapshot()` gives `status` and `error`), `WatchdogPreview`
  (`isEncoding`, `errorText`). A page that makes a console casts once in each factory:
  `commands: (console) => new Commands(console as CommandsConsole, {...})`.

### How the commands' Python is carried over

1. `run` is an async function; what PEAR raises is its promise's rejection. Nothing is awaited before a handler
   is called unless the command stops the running operation first. When `run` returns its promise: for `pause`
   and `stop`, `Console.stop` has been called (the cancellation aborted, the robot's stop called); for
   `home_confirm`, `reset_stop`, `model`, `recording`, `recover_control`, `start`, `resume` and
   `reconnect_cameras`, all of the handler has run (an operation it launches begins on a later microtask); for
   `enable`, its two checks and the call of the cameras' read; for `clear`, `disable` and `home`, all of the
   handler while no operation runs, and `Console.stop` while one does.
2. `None` is answered as `{accepted: true}`: a handler that returns `undefined` or `null`.
3. `data or {}` is `data ?? {}`; `data.get(key, default)` reads an own key, and a key that is not there or holds
   `undefined` gives the default. `data.get("confirm") is True` is `=== true`; `type(...) is bool` and
   `isinstance(..., bool)` are `typeof ... === "boolean"`.
4. `str(data.get("instruction", "")).strip()` is `pythonStrip(pythonStr(pythonValueOf(...)))`: what is no text is
   taken as Python writes it (a JSON `null` is the instruction `None`). `len(instruction)` counts code points.
   The text of the limit has PEAR's en dash (U+2013).
5. `uuid4().hex` is the option `uuid` without its dashes; `time.time()` is `wallClock`; `time.time_ns()` is
   `timeNs` (a `bigint`), in the names `home-<ns>.json` and `home-plan-<ns>.json`.
6. The keys of a task's record in PEAR's order: `id`, `instruction`, `created`, `model`, `model_label`, then
   `action_format` only for a robot with more than one action format, `reasoning_effort` only for a client whose
   class names one, then `images` (always, an empty list without images).
7. `TaskFiles(root / id).directory.mkdir()` is `records.createTask(id)`, `shutil.rmtree` of it
   `records.removeTask(id)`, `TaskFiles.write_json(files.task_path, task)` `records.writeJson(id, "task.json",
   task)`, and the Home's report and plan go through `records.writeRootJson`.
8. `with console.lock` is nothing where nothing is awaited inside it (`_reset_stop`, `_reconnect_cameras`,
   `_recover_control`, the end of `_recover`, the last step of the watchdog's check). `_stop_for_fault` holds the
   lock around the robot's stop, which the port awaits: see the differences.
9. `threading.Thread` of the periodic thread is a `ConsoleWorker`; `exit_event` is an `AbortController`, and
   `exit_event.wait(seconds)` the option `sleep` woken by its signal.
10. Where Python raises for a missing key or a value of the wrong kind (`progress["stage"]`,
    `HOME_STAGE_PHASES[stage]`, `models[model]`, `snapshot()["error"]`, `require` of a model that is no text,
    `previous_worker.join` without a worker), the port throws the class of that name with Python's text.
11. `logger.warning` and `logger.exception` go to the option `log` under the loggers `commands` and
    `periodic_thread`.

### Deliberate differences of the commands

1. **Async.** `run`, `stopBefore`, `pause`, `stop`, `enable` and every operation are async; the calls of the
   uploads, the annotations, the recordings' `start` and the records are synchronous, so `start` and `resume`
   await nothing.
2. **`enable` awaits the cameras' read** between its checks and its launch. PEAR blocks its caller there, and
   PEAR's page service gives the commands that are not immediate one at a time
   (`gui/server/command_cache.py`, `async with self.lock`). `run` does not queue them: a page's service must, or
   a second command can be admitted during the read (its launch, or the first one's, then throws
   `Wait for the current operation to finish stopping.`).
3. **`_stop_for_fault` without its lock.** A command admitted while the watchdog awaits the robot's stop is not
   held back. The one a faulted robot admits is `recover_control`: the page can then show `Stopping` and `Fault`
   while the recovery already runs, where PEAR shows `Fault` first. The recovery is not cancelled by it and ends
   in the idle phase with the failure cleared.
4. **A long step of a periodic thread.** In PEAR and here the next step never begins before this one has ended
   (the watchdog: a whole period after its end). PEAR's long step holds its own thread only; here a step that
   awaits lets the page's other work run, and a step that computes without awaiting holds the page's one thread.
   A page's timer is not exact to a millisecond, so `MIN_WAIT_S` may last several.
5. **The robot's class is given apart** (`CommandsOptions.robotClass`), and the Home's own options are `side` and
   `opensGrippers` in the options object of `robot.home` where PEAR passes keywords (`side`, `opens_grippers`).
6. **`Annotations.clean_tags`**, a classmethod PEAR calls on the class, is `console.annotations.cleanTags`.
7. **A task's image URL** is made by `console.recordUrl` if the console has one, else PEAR's, as the task run
   makes a frame's.
8. **A number as an instruction**: JavaScript does not know `5.0` from `5`, so a whole float is written as an
   int.
9. **`catch`** takes whatever is thrown; PEAR's `except Exception` leaves a `KeyboardInterrupt` alone.

### How the commands were verified

`tests/console/commands.test.ts` replays the thirty scenarios of `tests/fixtures/console/commands.json.gz` (258
steps; 119 commands given through `Commands.run`, 60 of them refused; 46 events, 255 calls of the stand-ins, 15
operations), records of PEAR's own `Commands` and `Watchdog` on PEAR's own `Console`, run by PEAR's Python
(`tools/fixtures/console_commands_fixtures.py`), on the port's `Commands`, `Watchdog` and `PeriodicThread` around
the port's `Console`. The rig is `tests/console/commands_rig.ts`: `CommandsStage` extends the stage of the
console's own fixtures (`console_rig.ts`) with what the script's `Stage` adds to PEAR's: the port's
`Commands(console)` on the scenario's scripted clock and UUIDs, the watchdog made without its constructor (the
step `watchdog_check` calls its check on the main thread), the steps `command`, `launch_until_stopped` and
`periodic`, the further keys of `set`, and the parts `commands.py` and `watchdog.py` use of the robot, the
cameras, the recordings, the uploads, the annotations and the task run, each call recorded under PEAR's name with
PEAR's arguments and keywords. The port, the fixtures and the rig were written without sight of each other; the
first replay agreed in every part of every step, and no line of the port was changed.

Compared for every scenario and every step, exactly (a number is the same double, a dictionary has PEAR's keys in
PEAR's order, a list has as many items): the fields before the first step; what the step returned (a command's
answer) or raised (class name and message); every event (id, type, data, time, monotonic_s, task_id), its thread
and whether the task's events hold it; the phases set, by thread; every call of the robot and of each stand-in, by
thread (name, arguments, keywords, the last event's id when it began, what it returned or raised); the operations
that ended in the step; the console's fields after the step, with the task run's (`task`, `total_steps`,
`turn_number`, `active_attempt_id`, `active_turn`, `resume_pending`, a key no command has written yet being
absent, and whether it has a session), the model and whether tasks are recorded; every file under the console's
root; how often each clock was read. Also: that every UUID of a scenario was drawn; that the port waited on a
worker's time limit at most once in a step, for the limit in force, and exactly once where PEAR found the old
operation still stopping; `meta.constants` (the commands' table with its six flags for all fourteen commands in
PEAR's order, `MAX_INSTRUCTION_CHARS`, `HOME_STAGE_PHASES`, `RECORD_URL`, the watchdog's `PERIOD_S`, `THREAD_NAME`
and `PHASES_WITHOUT_CAMERAS`, the periodic thread's `MIN_WAIT_S` and `JOIN_S`, the stopped statuses, the failed
member of `SegmentStatus`, the console's constants); and the fixture's own counts against what the replays made.

That the replay can fail: changes were made to the port on purpose, one at a time, in a scratch copy. Of 26 made
by the test's author 22 made the replay fail, each in the scenarios that hold the behaviour: the order of `run`'s
refusals (busy before latched); a command that does not clear the error; a flag of the table; a refusal's text;
`clear` while STOP MOTION is latched (PEAR shows Holding and leaves the latch set); `reset_stop` with the robot
not stopped; the watchdog's step from Stopping to the idle phase; a periodic thread a failed step does not end;
the turn number `start` resets; settling before a command when the robot is OFF; the phases without cameras; the
answer `{accepted: true}`; STOP that does not latch; a lost browser that stops camera maintenance; the text of a
failed recording; the reason of the stop before a command; a fault while control is recovered; the gripper
refusal of `home`; `resume` with the robot not ready; `model` with a session and no task; `enable` with a camera
error; `disable` that keeps the session. Of 16 more, made by a second reader, 12 made it fail: the order of a
task record's keys; a task's image without its URL; the text of a blocked session's refusal; a failed cleanup at
`disable` that is not shown; a recording that did not start and is not stopped; a command that does not clear
the performance; `enable` without the cameras' read; the text of a failed recovery; a lost browser that keeps
control; a fault's text; a fault the watchdog does not save; the idle phase without the latch.

The eight that passed the replay name what the records do not show: the handler of `home_confirm`; the file of a
Home report; a periodic thread that waits before its first step when it should not; the pacing from a step's
start; the folder of a task whose images cannot be attached (the record lists files, and the folder is empty); a
draft image that cannot be removed (no record has one); the count of steps `clear` forgets (it is 0 in every
record, where no turn runs); the failure a recovery clears (the command has cleared the earlier one). Each of
them now fails a test written by hand, as do 15 more changes in the same parts.

Those tests are `tests/console/commands_by_hand.test.ts` (12 tests) and
`tests/console/periodic_thread_by_hand.test.ts` (6 tests). They compare with nothing of PEAR's: their
expectations were typed from a reading of `commands.py` and `periodic_thread.py`, and their robot, records and
clock are stand-ins of their own. They hold the table's names in order, three refusals of `run`, and that STOP
has stopped the robot when `run` returns its promise; a Home that is admitted, from the task's end through the
stages' phases, the plan's review and its file to the report's file, the Home status and the notice; the answer
`home_confirm` passes on (true for `confirm: true` alone) and its refusal for another plan; the arm and the
grippers' choice of a robot whose class has them; the four single lines of the paragraph above; and when a
periodic thread waits (at once or after one period, a whole period after a step's end or a period after its
start, never less than `MIN_WAIT_S`, and `close` with `JOIN_S`).

### Fixes of the commands' port

None: no scenario disagreed, and the second reading of `commands.py`, `watchdog.py` and `periodic_thread.py`
against the port found no difference beyond the deliberate ones above.

### Not verified of the commands

- **The commands on PEAR's robot and PEAR's `TaskRun`.** Every scenario of this replay stands on scripted
  stand-ins: no turn runs (`task_run.run` and `close_session` are recorded calls that return at once), and the
  robot answers what the scenario scripts. The replay of the three parts together (below) has four scenarios on
  the real robot: `start`, `pause`, `resume`, `clear`, `start` again, STOP MOTION during a move and its reset. A
  turn that fails has no record on the real robot yet; neither have `enable`, `disable`, the recovery of control
  and the robot's own Home under the console's review.
- **Held by tests written by hand alone, by no record of PEAR's**: a Home that is admitted and `home_confirm`; a
  robot class with a choice of Home arms or with a Home that can keep the grippers; the folder of a task whose
  images cannot be attached; a draft image that cannot be removed; the count of steps at `clear`; the failure a
  recovery clears; when a periodic thread waits. For these the expectation is one reader's reading of PEAR's
  source.
- **In no record and in no test**: a robot class with more than one action format (the key `action_format` of a
  task's record) and a client class that names a reasoning effort (`reasoning_effort`); a draft image whose
  removal fails with another error than a ValueError; `home` for a plan that is not approved by a real robot.
- **`is_daemon` of a periodic thread**: the port's loop is no thread and holds no such flag; the test checks only
  that PEAR's record says true.
- **The watchdog on its own thread.** The record calls PEAR's `_check` on the main thread, and so does the
  replay. What the port does when a command comes between the awaits of one check (`watchdog.ts` describes the
  one such case, a fault while `recover_control` is admitted) has no record.
- **The order between the main thread and the worker within one step**, beyond what the events' ids, each call's
  `after_event` and the fields show (as for `console.ts`). The time limit of a worker's join is, in the rig, one
  turn of the event loop: a worker that ends because of the stop has ended by then, one the scenario holds has
  not; no seconds pass.
- **`Annotations.clean_tags`**: PEAR's ran for the record; the port takes it as an interface
  (`CommandsAnnotations.cleanTags`) and has no port of it. The rig gives its own copy, with JavaScript's white
  space and lower-casing in the place of Python's `split()` and `casefold()`. Whoever makes a console must give
  one.
- **One command at a time.** PEAR's page service gives the commands that are not immediate one at a time
  (`gui/server/command_cache.py`); `run` does not queue them, and nothing here tests two given at once.
- What PEAR logs (`logger.warning`, `logger.exception`) is not in the record; of the port's log lines only the
  warning for a draft image is compared, by hand.

## The three parts together: a task run by the commands

The replays above hold each part by itself: the task run on the real robot with a console written for the test,
the console and the commands on scripted stand-ins. `tests/console/task_commands.test.ts` runs the three ported
parts together: the port's `Commands` start, pause, resume, stop and clear a task that the port's `Console` runs
on its worker, with its own `TaskRun`, on pear.js's real robot on the stepped stand-in arm.

### The record

`tests/fixtures/console/task_commands.json` is PEAR's own `Commands` (`Commands(console)`), `Console` with its
worker thread (`launch`, `_operate`, `emit`, `set_phase` unchanged), `TaskRun` and real robot on the stepped
stand-in SO-101 of PEAR's tests, with PEAR's scripted model, run by PEAR's Python through
`tools/fixtures/console_task_commands_fixtures.py`. The recordings, the preview, the camera feed, the uploads,
the annotations and the health checks are stand-ins that record their calls. The watchdog is PEAR's `Watchdog`
made without its constructor, which would start its thread: nothing checks by itself, and a step of a scenario
calls `_check` once on the main thread. A step is a command given through `Commands.run` on the main thread, or
such a check; its record is taken when the worker has ended, or while a thread waits at a point the script
names (the model's request while the model is asked; the worker inside the robot's `execute`, a number of
control periods into an action). Four scenarios, 20 steps, 159 events, 13 requests of the model, 154 calls:

1. `start` (the task's record and its `task.json`, the event `task`, the recording started), two completed
   turns (a lift of the arm, the gripper closed), and `pause` while the model is asked for the third: the event
   `stopping`, the model's late `usage`, the turn's end as an interruption, the recording stopped by both
   threads.
2. `start`, a turn, `pause`; the watchdog's check, which settles the phase Stopping into Paused; `resume` (the
   turns go on in the same session: the interrupted turn keeps its number, the next one completes); a second
   `resume` while the worker runs, refused, which changes nothing; `pause`; `clear` of the paused task (the
   session closed, the event `task_end`, the count of steps forgotten, the phase Holding); `start` again (a new
   task, a second folder under the same root, the turns counted from the beginning); `pause`.
3. `clear` while the task runs: the command stops the operation itself, waits for its worker and for the robot
   to settle, and launches its own operation on a second worker.
4. STOP MOTION ten control periods into the first turn's action, while the arm moves: the robot is stopped from
   the main thread while the worker is inside `execute`, the arm brakes and settles in the worker's control
   periods, and the turn ends as an interruption; `resume`, refused while the latch is set; the watchdog's check
   (Stopped); `reset_stop` (Paused); `resume` and the next turn's observation; `pause`.

Three runs of the script, and one that holds the main thread before and after every command, give the same
bytes.

The order of the two threads in the record is the script's choice, and its docstring says so: PEAR's
`Console.stop` sets the cancellation at its first line, so in PEAR the worker may react while `stop()` still
runs. The script has `stop()` run with a cancellation of its own and sets the worker's when `stop()` has
returned, so that every effect of the command comes before the worker's reaction on any machine.

### How the three parts together were verified

`tests/console/task_commands_rig.ts` makes a scenario's rig as the script makes PEAR's: the port's `Console` by
its constructor, with the `TaskRun` and the worker it makes itself; the port's `Commands`, made in the console's
option `commands`; the port's `Watchdog` made without its constructor, its check called at a step; the real
robot as the task run's rig makes it; the scripted model through the port's `ModelsConfig` and `OfferedModel`;
the stand-ins, each recording its calls in PEAR's form; the records in memory; the stand-in clock, the wall
clock's readings and the UUIDs by who draws them. PEAR's three threads (`main` gives the commands, `worker` is
the console's worker, `model` is the thread in which the session asks the model) are one thread here and are
told apart by an async context around what `launch` starts and around the model's request. The script's
hand-over is a promise the rig releases: it holds the model's request, or the worker inside a sleep of the
stand-in clock within the robot's `execute`; a command that waits for the worker itself (`clear` of a running
task) releases it when `stop()` has returned, inside the command, as the script does. The port's `stop` is
wrapped as the script wraps PEAR's, so the order within each thread is compared as PEAR's, and the order between
the threads (the events' ids, each call's `after_event`, the clock) as the script's choice among the orders
PEAR allows. PEAR's kinematics' answers are given to the port's robot from the record's `ik`; the test fails if
the robot asks a question the record does not answer.

Compared for each of the 20 steps, exactly (a number is the same double, a dictionary has PEAR's keys in PEAR's
order, a list has as many items): what `run` returned or raised; every event (id, type, data, time,
`monotonic_s`, `task_id`), its thread and whether the task's events hold it; the phases by thread; the console's
fields; the task; the task run's fields and the session's (its turn count, its blocked reason, the last result's
record); the robot's status; every file under the root; the calls of the robot and of each stand-in by thread;
what the model was sent at each request; the UUIDs drawn and the clock (the control periods stepped, the
stand-in clock, the readings of the wall clock); and before the first step the console's fields, the robot's
status, the UUIDs and the periods of the robot's opening. One test counts what the replays made against the
record's own counts. **No difference, and no tolerance**: with PEAR's kinematics' answers given, every double of
the four scenarios is PEAR's. The port and the record were written without sight of each other; no line of the
port was changed.

That the replay can fail: changes were made to the port on purpose, one at a time. Ten made by the first
scenario's author each made it fail: `start` leaving the turn number at 1; the event `task` not published; the
event `task` published before `task.json` is written; a turn that opens as Thinking; the task run launched as
not recorded; a turn's phase not shown on the console; `pause` that latches; `stop` without the event
`stopping`; another reason of the pause; another phase in `stop`. Twenty-eight more, made by a second reader,
each made it fail: a completed turn counted twice; an interrupted turn's end not saved; the worker's phase after
an operator's pause; the reason with which the worker ends the recording; a second reading of the wall clock in
`start`; a task's record without `images`; `pause` that is not immediate; the uploads given another task's id;
another time in the stop's report; an event's id; the count of steps kept at `clear`; no wait for the robot to
settle before a command that stops first; another reason of that stop; the turn number kept at a second `start`;
a latch-blocked command admitted under the latch; a command admitted while an operation runs; `reset_stop`
leaving the latch; `reset_stop` forgetting the paused task; another message of a cleared task; `resume` without
a reading of the robot's status; STOP MOTION that does not latch; the watchdog's idle phase without the latch;
the watchdog not settling the phase Stopping; a join of the worker that does not wait; a resumed run with a new
session; `clear` leaving the session; `resume` without the recording; an operator's stop shown as a failure.

Four passed, and each changes nothing these scenarios can show: `start` not resetting the count of steps (a new
console's is 0, and `clear` has reset it before the second `start`; a `start` after `disable` or after Home
would show it); the recording started after the launch (the port's worker begins on a later microtask, so the
recording is started before the worker's first step either way; in PEAR the two would race); the interrupted
turn's phase set to another word at the turn's end (the record of the interruption sets it again before the
step ends, in PEAR as here); `clear` taking the latch into account for its phase (no scenario clears under the
latch here; the commands' replay on stand-ins holds that one).

### Not verified of the three parts together

- **A turn that fails.** An action that does not complete, a robot fault with its record, `resume_pending` and
  the `resume` after it are in no record of the three parts together; the task run's replay holds them without
  the commands. Nor are a task of a model that names a reasoning effort or an action format of its own, `start`
  after `disable` or after Home, and `enable`, `disable`, the recovery of control and the robot's own Home on
  the real robot (the rig's robot is open and holds from the first step).
- **One order of the threads.** The record pins the order in which the command's stop has returned before the
  worker reacts. What the port does when its worker reacts while `stop()` still awaits the robot is not
  compared with anything; PEAR allows that order too.
- **The watchdog at a step.** The record calls PEAR's `_check` once, on the main thread, where a scenario says
  so, and so does the replay. In PEAR and in a page it checks by itself every 0.1 s, so the phase settles at
  some moment after the worker has ended, and a check can come between the awaits of a command.
- **One moment of a move.** STOP MOTION comes ten control periods into one action. A stop while the arm
  settles, during an observation or between two calls of the robot is not in the record.
- **A frame's bytes and a frame's folder**, as for the task run: the port's loop writes no frame; a frame is
  compared by its name, as a file of the task whose turn sent it to the model, and the path an observation's
  record holds by its last part.
- **The stand-ins' answers.** The uploads attach nothing (the tasks have no images, no tags), the preview says
  the cameras are live, the health checks are asked nothing: the real records, recordings and preview are not
  ported.
- **The values of the C library** are not in the record. Nothing differed without them in these scenarios (five
  answers of the kinematics were given); another scenario may show last digits.
- The robot is on the stepped stand-in arm and the model is scripted: nothing here is a real arm, a real model
  or a page.

## Left

Of `TaskRun`: nothing of its code; the JSON text of a record (above).

Of `Console`, `HomeReview` and `ControlLease`: nothing of their code; the two things of `emit` that only a test
written by hand holds.

Of `Commands`, `Watchdog` and `PeriodicThread`: nothing of their code. Records for what tests written by hand
hold now: a scenario that gives `home_confirm` (the right and a wrong plan id; confirm true, not true, absent);
`home` on the stand-ins through to its end and to a failed Home; the times a periodic thread waits with; a robot
class with two action formats, with a choice of Home arms and with a Home that can keep the grippers; a task
whose images cannot be attached, with the folders under the root; a draft image that cannot be removed; `clear`
after turns; a failure shown while a recovery runs.

Of the three parts together: a turn that fails and the `resume` after it (an action that does not complete; a
robot fault and its record), a task of a model that names a reasoning effort or an action format of its own,
`start` after `disable` or after Home, `enable`, `disable` and the recovery of control on the real robot, and
the robot's own Home under the console's review.
Of the console, not ported:

- `preview.py` (154 lines), `PreviewFrame` and `Preview`: the cameras as the page shows them: the latest frame of
  each camera as JPEG, and the cameras' errors. `Commands` and `Watchdog` reach it through `CommandsPreview` and
  `WatchdogPreview`.
- The page's service under `gui/server`: among it `command_cache.py`, which admits a command (the lease for a
  command that needs control, the lock that gives the commands that are not immediate one at a time, the cache
  of a request's answer). A page that uses `Commands` must do these itself.
- The records' parts that `Commands` reaches through interfaces: `ImageUploads`, `Annotations` (with
  `clean_tags`), `RenderedRecordings`, `TaskFiles`.

And one thing of the port's own: the interfaces of `console.ts` hold what `console.py` uses of the console's
parts, and what `commands.py` and `watchdog.py` use beyond that is in interfaces that extend them
(`CommandsConsole`, `WatchdogConsole`), so a page casts once where it makes each. Widening `console.ts` itself
would remove the cast.
