# Progress: `src/console`

One file of PEAR's operator console (`pear/deploy/station/gui/console`), with the two small files it needs:
`task_run.py`, the loop around the turn loop's `step` that runs a task's turns one after another. It asks again
after an action out of reach (up to five times), ends the run after an action that did not complete and settle,
records an operator's pause of a turn as that turn's failed result, and reconciles a robot fault. Written from
PEAR's source at `f32aa1f7c2ec9c3f45630cc9f8541b3201e8e087`, and held to records of PEAR's own `TaskRun`: a
test replays fifteen scripted scenarios of it on the port, and every place of the records is the same but
the last digits of some joints in two of them (see "How it was verified").

## Done

| File | Ports |
| --- | --- |
| `src/console/task_run.ts` | `gui/console/task_run.py`, all 327 lines: `RECORD_URL` (24), the constants of `TaskRun` (31 to 43), its fields (45 to 57), `run` (64 to 112), `new_session` (114 to 142), `on_event` (144 to 182), `close_session` (184 to 196), `_resume_failed_turn` (198 to 210), `_start_turn` (212 to 230), `_save_execution_result` (232 to 246), `_reconcile_fault` (248 to 280), `_end_turn` (282 to 295), `_record_interruption` (297 to 317), `_is_unreachable` (319 to 327). Of `records/task_files.py`: `SESSION_NAME`, `OBSERVATION_RECORD`, `OUTPUT_RECORD`, `RESULT_RECORD` (15 to 27) and the file name of `turn_record_path` (91 to 93) as `turnRecordName` |
| `src/console/phase.ts` | `gui/console/phase.py`, all 52 lines: `STOPPED_STATUSES`, `Phase`, `Phase.idle_for` as `idleFor`; `Phase(word)` as `phaseOf` |
| `src/console/task_events.ts` | `records/task_events.py`: `TaskEventKind` (10 to 21). Not `TaskEvents`, which reads and writes a file |
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

## Deliberate differences

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

## How it was verified

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

## Not verified

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

## Left

Of `TaskRun`: nothing of its code; the JSON text of a record (above).

Of the console, not ported (a line each, from the classes' own descriptions; the files were not read):

- `console.py` (309 lines), `Console`: the page's console of one robot: the robot, its cameras, the recordings and
  the tasks' records, one operation at a time on a worker thread; `emit` (numbers an event, adds the running
  turn's fields, keeps it for browsers and in the task's event file), `set_phase`, `new_client`, `robot_status`.
- `commands.py` (438 lines), `Command` and `Commands`: the operator's commands, each admitted on the caller's
  thread; a long one then runs on the console's worker.
- `watchdog.py` (93 lines), `Watchdog`: a background check that pauses the robot when the browser that holds
  control, the recording or the cameras fail.
- `home_review.py` (62 lines), `HomeStatus` and `HomeReview`: a Home plan waiting for the operator's confirmation,
  and the operator's answer to it.
- `preview.py` (154 lines), `PreviewFrame` and `Preview`: the cameras as the page shows them: the latest frame of
  each camera as JPEG, and the cameras' errors.
- `lease.py` (52 lines), `ControlLease`: the one browser tab that may command the robot, held for as long as its
  heartbeats arrive.
- `periodic_thread.py` (58 lines), `PeriodicThread`: a background thread that does a step every period until it
  is closed.
