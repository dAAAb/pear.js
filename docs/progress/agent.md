# Progress: `src/agent`

The model client and the turn loop of PEAR's station (`pear/deploy/station/agent_loop`), ported file by file: a
client of the OpenAI-compatible Chat Completions API with a stream, and the loop that observes, asks the model,
reads the action of its answer, has the robot execute it and reports the result in the next turn.
Compared with PEAR at `f32aa1f7c2ec9c3f45630cc9f8541b3201e8e087`, run in its station environment (Python 3.12.15,
openai 3.35.1, pydantic 2.13.5).

## Done

| File | Ports |
| --- | --- |
| `src/agent/clients/vllm.ts` | `clients/vllm.py`: `VLLMClient` (the conversation, images by UUID and the resend after a cache miss, reasoning kept in the history, the stream, usage, context overflow, refusals) |
| `src/agent/clients/client.ts` | `clients/client.py`: `ModelClient` (one request at a time, stop, time-out, close), `ContextLimit`, `SessionLost`, `TurnProgress`, `_service_url` with Python's `urlparse` |
| `src/agent/clients/openai.ts` | what `vllm.py` runs of the OpenAI Python SDK 3.35.1: its error classes, the message of a refused request, its decoder of a server-sent event stream, how a decoded chunk reads (`_exceptions.py`, `_base_client.py`, `_client.py`, `_streaming.py`, `_models.py`) |
| `src/agent/clients/python_repr.ts`, `python_printable.ts` | CPython 3.12: `repr()` and `str()` of decoded JSON, `str.isprintable` (a generated table, Unicode 15.0.0), the errors of `bytes.decode("utf-8")` |
| `src/agent/clients/schemas.ts`, `metrics.ts`, `health_checks.ts` | `clients/schemas.py`, `clients/metrics.py` (with Python 3.12's `sum`), `clients/health_checks.py` |
| `src/agent/agent_loop.ts` | `agent_loop/agent_loop.py`: `Turn`, `ModelCall`, `StationAgentLoop` (`step`, `failureResult`, `record`, `close`) |
| `src/agent/schemas.ts`, `messages.ts`, `config.ts`, `exceptions.ts` | `agent_loop/schemas.py`; `agent_loop/messages.py` beyond the text (the frames of a turn); `agent_loop/config.py` (`OfferedModel`, `ModelsConfig`); `exceptions.py` and Python's `ValueError`, `RuntimeError`, `TimeoutError` |
| `src/agent/robot.ts` | the interface the loop needs of a robot: `AgentRobot` (of `BaseRobot`), `ActionMode`, `ActionPhase`, `Observation`, `ActionFormat`, `Camera`; `resultRecord` (`MotionResult.to_record`) |
| `src/agent/formats.ts` | `SINGLE_ARM_POSE_FORMAT` as the loop uses a format, made of `src/protocol`'s functions |
| `src/agent/clock.ts` | not in PEAR: `time.monotonic` and `time.sleep` as values a caller may replace |
| `tools/fixtures/agent_fixtures.py` | writes `tests/fixtures/agent/*.json`; with `--sync-tables` also `python_printable.ts` |

Why a client ports part of an SDK and of Python: PEAR's agent loop ends a turn that failed with a result that
carries the class name of the Python exception and its message, and the next turn shows both to the model. So a
refusal reads `BadRequestError`, `Error code: 400 - {'error': {'message': '...', 'code': 400}}` (Python's text of
the decoded body, in the quotes Python chooses), a broken connection `APIConnectionError`, `Connection error.`, a
stream that ends without the model's stop `ValueError`, `vLLM output did not finish normally: disconnected`
(a ValueError, so the turn is rejected, not failed).

A model entry of a station (`config.ts`): PEAR's shipped `pear/configs/station.yaml` names no model
(`default_model: ???`, `models: ???`); its example station offers one, `VLLMClient` with `base_url` and `model`
and nothing else, under `timeout_s` 300 (at most 1800). The client's own defaults, ported as static values:
no limit on an answer's tokens (`max_tokens: null`), context 260096, 1016 images, temperature 1, top_p 0.95,
top_k -1, repetition_penalty 1, reasoning effort `xhigh`; no key means the word `unused` as the bearer token.

## How it was verified

Fixtures: `tools/fixtures/agent_fixtures.py` runs PEAR's own classes and records them (1,079,202 bytes in six
files; written twice, identical). Times and UUIDs are replaced as its docstring says: PEAR's client modules read a
clock that is one step later at every reading; the loop and PEAR's stand-in SO-101 run on the stand-in clock of
PEAR's own tests; `uuid4` of PEAR's modules is a seeded sequence.

```
<work dir>/envs/station/bin/python tools/fixtures/agent_fixtures.py            # in WSL; writes tests/fixtures/agent
npx tsc --noEmit                                                               # no error (whole repository)
npx vitest run tests/agent                                                     # 7 files, 570 tests, all pass (Node 24.18.1)
```

| Test file | Tests | What is compared |
| --- | --- | --- |
| `client.test.ts` | 54 | 26 scenarios, 155 steps of PEAR's `VLLMClient` against a recording HTTP server on 127.0.0.1 that replays scripted responses. pear.js's client runs each scenario twice: with an injected `fetch` that answers from the script, and with the runtime's `fetch` against a socket server on 127.0.0.1 that writes the same bytes. Per step: every request (method, path, `Authorization`, `Content-Type`, `Accept`, the JSON body by deep equality), every event with its data in order, what was returned or raised (class name, message, whether a ValueError, status, the classes it extends), the number of clock readings, the history's roles |
| `loop.test.ts` | 20 | 19 tasks, 60 turns of PEAR's `StationAgentLoop` with its stand-in scripted client on its stepped stand-in SO-101. pear.js's loop runs them on a robot that replays PEAR's and a client that follows the same script. Per step: one ordered trace of every call of the robot (with its arguments) and every event (with its data), the model's input (text, frames' names and UUIDs, reference images), the result or the error, and the session afterwards (turn count, blocked reason, the next turn's report, the last turn) |
| `model_call.test.ts` | 21 | 20 scenarios of PEAR's `ModelCall` on a scripted robot and a clock only its waits advance (PEAR's own technique: the worker thread and its queue replaced). The same calls of the robot, the same waits with the same durations as floats, the same outcome |
| `parts.test.ts` | 456 | the client's refusals of its arguments (37), `_service_url` (39), decode rates, token rates, Python's `sum`, performance reports, the health checks' cache (15 operations), `repr()` of 76 strings, `str()` of 24 documents, 12 refused documents, `bytes.decode` of 96 byte strings, the size of compact JSON, the SDK's own SSE decoder on 14 streams in 84 splittings, what a session refuses to be made on (10), `ModelsConfig` (12); `str.isprintable` over all 1,114,112 code points by SHA-256 |
| `messages.test.ts` | 13 | `ObservationMessage.build`: the frames of a turn, their order and names, the UUIDs drawn, the check of their times, for the SO-101's format and for a format with three cameras |
| `exceptions.test.ts` | 5 | TypeScript only: the errors of this module, of `src/protocol` and of `src/so101/kinematics` under one reading; a pause raised by a class of another module |
| `e2e.test.ts` | 1 | TypeScript only: the loop with the real client against a Node `http` server on 127.0.0.1, three turns, a cache miss in the third |

What the scenarios cover. Client: three turns of one task with PEAR's system prompt and JPEG frames; paced usage
reports; no usage; usage in the last chunk; both names of the reasoning field; text beyond ASCII; reference images;
a station's own values; how a stream is framed (events split inside a line and inside a character, CR, CRLF,
comments, `event`, `id`, `retry`); a cache miss and its resend, twice, after output, inside the stream; context
overflow by each marker; an answer cut at a token limit; the image limit; 20 refusals (11 statuses; bodies that are
JSON objects, lists, strings, numbers, text, nothing); 19 streams that break or end without the model's stop;
22 chunks that are no chunks; time-outs; a stop in each phase of a request; `cancel()`, `close()`, a second
request; an empty key and a key with space around it; the health check with 14 answers. Loop: completed moves; seven answers
without an action; targets out of reach; an action rejected; a motion that fails and a robot in fault; a jaw
stopped on an object; the operator's pause in five places with the console's record of it; six model failures;
the model's time-out; a lost conversation; a full context; a robot closed while it plans and while the model works;
another session and another operation while the model works; an arm pushed during the hold (with its diagnostic);
reference images; a step while one runs; a closed session.

The tests fail when the code is wrong (each break alone, then restored; `npx vitest run tests/agent`, then 565
tests):

| Break | Failed |
| --- | --- |
| `vllm.ts`: the frame before the last also sent with its data | 31 |
| `agent_loop.ts`: a ValueError no longer rejects a turn | 4 |
| `python_repr.ts`: single quotes whatever the string holds | 4 |
| `agent_loop.ts`: an answer returned whether the arm holds or not | 3 |
| `openai.ts`: `Error Code:` for `Error code:` (run on `client.test.ts` alone, then 50 tests) | 8 |

A sixth break changed nothing and is no gap: `index >= conversation.length - 2` for the rule of which frames carry
their data names the message before the last, which is never a turn's input.

## Not verified

- No browser engine has run the tests; Node 24.18.1 only (its `fetch` is undici's). No real model server was
  contacted: the scripted responses follow PEAR's own tests and vLLM's stream format as PEAR's tests write it.
- What a runtime's `fetch` does of a failing connection is taken from Node: a `fetch` or a read of the body that
  rejects is a connection error. The scripted `fetch` of the tests is a model of that; the socket server run is the
  check of it, in Node.
- Timing: a stop is looked for every 20 ms as in PEAR; scenarios keep wide margins around it. A page in the
  background has its timers slowed by the browser, so a stop may be seen later there.
- The frames of a turn are checked for their JPEG marker only; nothing here encodes or decodes an image.
- Chunks that break the API in ways other than the 22 recorded ones follow the same rules (a JSON object reads as
  a model whose missing fields are None, anything else raises Python's AttributeError or TypeError by its type's
  name) but were not compared.
- `ModelsConfig`: PEAR's refusal of an unknown or missing client argument (Python's `TypeError`) has no
  counterpart; TypeScript's types stand for it.

## Deliberate differences

1. **Threads.** PEAR's `infer` and `step` block their thread; the request runs in an event loop of its own and the
   loop watches it from a worker thread. Here both are async functions, a `threading.Event` is an `AbortSignal`,
   and a lock is a flag. The order of the robot's calls, the events, the results and the texts are PEAR's
   (the traces of `loop.test.ts` and `model_call.test.ts`). `close()` called from a request's own event handler
   ends the request and closes; in PEAR it would wait 10 s for itself and raise `SessionLost`.
2. **Images are bytes.** A `CameraImage` or `ReferenceImage` holds the JPEG bytes where PEAR's holds a file's path;
   an observation's images are JPEG bytes where PEAR's are RGB arrays that it saves at quality 90 itself
   (`JPEG_QUALITY` is exported for whoever encodes). The loop takes no `directory`. A frame keeps the name of
   PEAR's file (`<attempt id>-<camera name>.jpg`); the `observation` event's `images` hold that name, not a path.
   A frame that is no JPEG is refused with `Expected a JPEG image from the ... camera` (PEAR: `Expected a uint8
   RGB image ...`); that error ends a step before a turn exists and never reaches the model.
3. **The key.** `apiKey` is a string or a function called at each request, where PEAR reads `api_key_file` at
   each request; both strip whitespace, send `Bearer <key>`, send `Bearer unused` without one and raise the SDK's
   `OpenAIError` for an empty one. Nothing stores or logs it. `RELATIVE_PATH_ARGUMENTS` and `resolve_paths` are
   not ported.
4. **Headers.** A request carries `Authorization`, `Accept: application/json` and, with a body, `Content-Type:
   application/json`. The SDK also sends `User-Agent` and nine `X-Stainless-*` headers that name itself, its
   platform and its time-out (`meta.json` lists the names); a model service does not read them and a page cannot
   set a `User-Agent`.
5. **The request's JSON** has the SDK's fields and values, compared by deep equality: a server parses it, so the
   order of keys and the spacing reach no model. JavaScript writes `1` where Python writes `1.0` for a float that
   is a whole number.
6. **Whole numbers.** Python tells the float 20.0 from the int 20; JavaScript has one number. A whole number
   counts as an int here: `contextLimit: 4096.0` and `topK: 5.0` are taken where PEAR refuses them, a token count
   sent as `20.0` enters the rates where PEAR leaves it out, and Python's `sum` adds such a float without
   compensation. Measured: 2 argument cases and 2 decode-rate cases in `parts.json` (`whole_float`,
   `whole_floats`), each asserted to differ in this way; a server that follows the API sends ints.
7. **The health check's time-out** is 3 s to the response's head and then 3 s between two pieces of its body;
   httpx counts the connection, the head and each read apart, 3 s each.
8. **A chunk's JSON** is read by `JSON.parse`, and by Python's rules only where that refuses it (so `NaN` and
   `Infinity` are taken and a refused chunk has Python's message). An integer past 2^53 loses its last digits, and
   Python's limit of 4300 digits does not apply. A refusal's body is read by Python's rules throughout.
9. **Text of a response** is decoded as UTF-8; httpx follows a charset the response names.
10. **`_service_url`** reads a URL as `urlparse` does (39 cases), without its checks of a bracketed host's address
    and of a network location's NFKC form.
11. **A failure while a refusal's body is read** is a connection error here; in PEAR httpx's own error escapes
    (not recorded).
12. **`config.ts`** holds a client's class where PEAR holds a class path, and reads no YAML. A message names the
    class by `clientClassName`.
13. **Not in PEAR**: `clock`, `sleep` and `uuid` as options; `RequestCancelled` (it stands for asyncio's
    `CancelledError`); `pythonErrorName`, `isValueError`, `motionErrorOf`.
14. Not ported: `clients/claude_code.py`; logging (PEAR logs a failed turn and a failed health check).

## To reconcile with the other modules

- **The robot** (`src/agent/robot.ts`, `AgentRobot`): `actionMode`, `sessionId`, `controlPeriodS`,
  `lastErrorDiagnostics`, `waitStationary(observation?, {cancellation})`, `observe()`, `modelState(jointPositions,
  formatName)`, `isHolding(observation)`, `stop()`, `execute(action, {referenceObservation, cancellation,
  reportProgress})`, `failureResult(error, {formatName, status, snapshot})`. Each may return a value or a promise.
  `Observation` is camelCase (`observationId`, `sessionId`, `capturedMonotonicS`, `jointPositions`, `images`,
  `cameraTimestamps[role].receivedMonotonicS`, `controlSnapshot`) with JPEG bytes per camera role; the snapshot is
  opaque to the loop. `src/station/schemas.ts` ports the same PEAR file: one of the two definitions should remain.
- **Errors.** `failureResult` must build `error` as `{code: <Python class name>, message}`: `motionErrorOf(error)`
  does it. The loop asks `isValueError(error)` to choose rejected or failed; it knows this module's classes,
  `src/protocol`'s two, and any error with a class named `ValueError` among its ancestors (which a minifier would
  rename) or a true `isValueError`. `src/so101/kinematics/errors.ts` has a `ValueError` of its own. One shared
  set of Python exception classes for the library would replace the guesswork; `OperatorPaused` of another module
  is known by its name.
- **`resultRecord`** (`MotionResult.to_record`) belongs with `MotionResult` in `src/protocol/types.ts`;
  `SINGLE_ARM_POSE_FORMAT` and `WRIST_CAMERA` (`formats.ts`) may belong to the station module.
- **Shared files**: done since. `src/index.ts` exports `agent`; `docs/DESIGN.md`'s module map lists `src/agent/`;
  `NOTICE` names the OpenAI Python SDK and the Unicode data behind `python_printable.ts`.
- **What PEAR's console does around a step is not ported** (`gui/console/task_run.py`) and shapes what the model
  reads: after an operator's pause of a turn whose model was asked, it waits for the arm to settle and records
  `failureResult(OperatorPaused("The operator interrupted this turn; remaining motion was cancelled."))`, which
  the next turn reports; it asks again up to five times after an action out of reach; it stops the run after any
  result that is not completed and settled. `loop.test.ts` replays the first as PEAR's console does it.
- **A page** must: encode each frame as JPEG (quality 90) before the loop sees it; give the key at run time; reach
  a model service that allows it across origins (`Authorization` and `Content-Type` headers, so a preflight; `GET
  /v1/models`, `POST /v1/chat/completions` with a streamed answer); run in a secure context (`crypto.randomUUID`).

## Left

Nothing in this module's scope. If PEAR or its SDK is updated: run the fixture script with `--sync-tables` in the
new environment, then the tests; `meta.json` records the versions the fixtures were made with.
