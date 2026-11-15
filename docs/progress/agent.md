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
npx tsc --noEmit                                                               # no error in this module's files
npx vitest run tests/agent                                                     # 7 files, 574 tests, all pass
```

The tests ran on Windows under Node 24.18.1 (undici 7.29.0) and on Linux (WSL, a clean copy with its own
`node_modules`) under Node 22.22.2 (undici 6.24.1) and, through `npx node@24`, Node 24.22.3 (undici 7.30.2);
`client.test.ts` alone also under Node 20.20.2 and 22.23.5 on Linux and 22.22.2 on Windows.

| Test file | Tests | What is compared |
| --- | --- | --- |
| `client.test.ts` | 58 | 26 scenarios, 155 steps of PEAR's `VLLMClient` against a recording HTTP server on 127.0.0.1 that replays scripted responses. pear.js's client runs each scenario twice: with an injected `fetch` that answers from the script, and with the runtime's `fetch` against a socket server on 127.0.0.1 that writes the same bytes; the scenario whose responses break runs twice more (below). Per step: every request (method, path, `Authorization`, `Content-Type`, `Accept`, the JSON body by deep equality), every event with its data in order, what was returned or raised (class name, message, whether a ValueError, status, the classes it extends), the number of clock readings, the history's roles |
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

Responses that break. Four responses of the scenario `streams that break` end before they are whole: the
connection is reset before the answer, a chunked body is cut (the connection closes before the last chunk), a
chunked body is reset, a body is shorter than its `Content-Length`. PEAR's HTTP client reported each as a failed
connection. A `fetch` reports one of three things of such bytes: it rejects, a read of the body rejects, or the
body ends; and Node's does not report the same in every version (difference 15). So a run first asks its `fetch`,
with a plain request and no client (`reportOf` in `tests/agent/service.ts`), and then holds the client to PEAR's
record for that report (`pearRecord` in `client_scenarios.ts`): for a failure, the step's own record; for a body
that ends, PEAR's record of the same response ended whole, which the fixture holds as another step (of the cut
body: `a body that ends with the connection`; of the reset one: `no finish reason`, the same body with
`data: [DONE]` after it, which PEAR's client took as it took a body's end: a test compares the two steps the
fixture records with and without it). On a given `fetch` exactly one record is right, and the test's name says
which was required: `streams that break [of its 4 broken responses this fetch reports 2 as failed connections and
2 as whole: a chunked body cut, a chunked body reset]`. The scenario's four runs:

| The `fetch` | Reports of the 4 broken responses |
| --- | --- |
| answers from the script | 4 failures |
| answers from the script and ends a cut chunked body as if it were whole, as Node's before undici 6.26.0 (so that every run holds the client to both records, whatever the runtime) | 2 failures, 2 whole |
| the runtime's, against the socket server | Node 22.23.5, 24.18.1, 24.22.3: 4 failures. Node 20.20.2, 22.22.2: 2 failures, 2 whole |
| the runtime's, against the socket server with `Connection: close` left out of the heads of the broken responses (not the recording server's bytes: those of a server that keeps its connections) | 4 failures on each of those five |

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

And for the responses that break (then 574 tests; each on Windows under Node 24.18.1 and on Linux under 22.22.2):

| Break | Failed on Windows, Node 24.18.1 | Failed on Linux, Node 22.22.2 |
| --- | --- | --- |
| `openai.ts`: a read of the body that rejects taken for the body's end | 4 (the scenario's four runs) | 4 (the same; the runtime's run at the body shorter than its length, which that Node fails too) |
| `client_scenarios.ts`, the tests' own rule: the report of the `fetch` ignored, the step's record required | 1 (the scripted `fetch` that ends a cut body) | 2 (that, and the runtime's `fetch`) |

## Not verified

- No browser engine has run the tests; Node only (its `fetch` is undici's), in the versions named above. No real
  model server was contacted: the scripted responses follow PEAR's own tests and vLLM's stream format as PEAR's
  tests write it. Whether PEAR's model server announces a connection's end was read, not run: in its server
  environment vLLM 0.28.0 serves through uvicorn 0.54.0, whose `protocols/http/httptools_impl.py` adds
  `connection: close` to a head only for a request that asked for it or came as HTTP/1.0, for a header of the
  application's own, or once the server is shutting down. A client that speaks to that server itself would then
  meet a break on a kept connection: the case every Node measured reports as PEAR's client does (difference 15).
- **A browser's `fetch`.** What it reports of a response that breaks (difference 15) is not known: of the four
  broken responses, with the connection's end announced and without. Nor whether it gives up by itself on a
  silent response, as Node's does. Nor what stands between a page and a model server: a gateway (TLS, HTTP/2,
  where no body is chunked) decides what a break of its upstream becomes for its client, and one that ends its
  own response cleanly makes of a break a body that ends. What a check in a browser needs is under "To reconcile".
- **PEAR's client on breaks the fixtures do not hold**: run once in its station environment against a server of
  the recording server's kind, outside the fixtures (a scratch script, not committed). A chunked body cut or reset
  without `Connection: close` in the head, and one reset by an RST alone, give the same `APIConnectionError` and
  the same events as the recorded steps. (The recording server's reset sent a FIN before the RST: Python's
  `socketserver` shuts a connection down before it closes it. The socket server of the tests sends the RST
  alone.) A chunked body cut or reset after the model's stop chunk is `APIConnectionError` too: the turn fails
  though the answer was complete; cut after `data: [DONE]`, the answer is returned. A body framed by the
  connection's end that an RST alone resets is `APIConnectionError`, also after the stop chunk. No test holds
  pear.js to these: the first group it meets by the tests' rule (the run without the announced end requires
  PEAR's record of the announced one); the others depend on the runtime as difference 15 says.
- What a runtime's `fetch` reports of a connection that fails in other ways than the scripted ones (a network that
  goes away without closing anything, a proxy's own error page, TLS) was not tried.
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
15. **A response that breaks is what the runtime's `fetch` says it is.** PEAR's HTTP client reports every response
    whose connection ends before the message is whole as a failed connection: `APIConnectionError`,
    `Connection error.`, a failed turn. pear.js's client learns one of three things from `fetch` and does for each
    what PEAR's client does for it: a `fetch` or a read that rejects is that failed connection; a body that ends
    without the model's stop is `ValueError`, `vLLM output did not finish normally: disconnected`, a rejected turn
    (PEAR's words for a stream that ends so); a body that ends after the model's stop is the answer. So where a
    `fetch` ends a broken body as if it were whole, the next turn tells the model `"status": "rejected"` with
    `ValueError` where PEAR tells it `"status": "failed"` with `APIConnectionError`; and an answer cut after the
    model's stop is taken, and its action executed, where PEAR's turn fails. The client cannot tell: `fetch` does
    not show how a body was framed, and PEAR's client takes a stream that ends without `data: [DONE]`.
    What Node's `fetch` reports, the same on Windows and Linux for the same Node (`client.test.ts` asks it at
    every run and says it in the test's name):
    - as PEAR's client, on every Node measured (20.20.2, 22.22.2, 22.23.5, 24.18.1, 24.22.3): nothing listens;
      the connection is reset before the answer; a body shorter than its `Content-Length`; a chunked body cut or
      reset on a response that had not announced the connection's end (no `Connection: close`: a server that
      keeps its connections);
    - a body that ends, on Node 20.20.2 and 22.22.2 (undici 6.24.1): a chunked body cut or reset on a response
      that had announced the connection's end, as the recording server does with every response. There undici's
      HTTP/1.1 client (`lib/dispatcher/client-h1.js`: the socket's `end`, `error` with `ECONNRESET`, and `close`)
      declared the message complete (`parser.onMessageComplete()`). From undici 6.26.0 and 7.26.0 it asks the
      parser (`parser.finish()`: "validate EOF for chunked h1 responses", its pull requests 5307 and 5308) and
      the read rejects: Node 22.23.5 (undici 6.29.1), 24.18.1 (7.29.0), 24.22.3 (7.30.2);
    - a body that ends, on every Node measured: a body framed by the connection's end (neither chunked nor of a
      given length) that is reset. PEAR's client fails there (see "Not verified").
    Node's `fetch` also gives up by itself after 300 s without a response's head, or without the next piece of
    its body (undici's defaults; measured once on Node 24.18.1: 304.5 s each), and the client then raises
    `APIConnectionError`. The client's own `timeoutS` comes first up to 300; above that (PEAR allows 1800) a
    model silent for 300 s ends the turn where PEAR waits for its own time-out. A caller on Node who needs more
    gives the client a `fetch` with longer time-outs (the `fetch` option).

## To reconcile with the other modules

- **The robot** (`src/agent/robot.ts`, `AgentRobot`): `actionMode`, `sessionId`, `controlPeriodS`,
  `lastErrorDiagnostics`, `waitStationary(observation?, {cancellation})`, `observe()`, `modelState(jointPositions,
  formatName)`, `isHolding(observation)`, `stop()`, `execute(action, {referenceObservation, cancellation,
  reportProgress})`, `failureResult(error, {formatName, status, snapshot})`. Each may return a value or a promise.
  `Observation` is camelCase (`observationId`, `sessionId`, `capturedMonotonicS`, `jointPositions`, `images`,
  `cameraTimestamps[role].receivedMonotonicS`, `controlSnapshot`) with JPEG bytes per camera role; the snapshot is
  opaque to the loop. Done since (`docs/progress/common.md`, part 5): `src/station/schemas.ts` is the one port of
  that PEAR file. `ActionPhase` and `Camera` here are the station's; `Observation`, `ControlSnapshot`,
  `CameraTimestamps` and `ActionFormat` are types made of the station's (its fields under camelCase names; any
  field of its snapshot and statuses; its name, cameras and result feedback). The loop's fields did not change.
  Open, for the round that takes `AgentRobot`: whether the loop reads PEAR's dictionary itself.
- **Errors.** `failureResult` must build `error` as `{code: <Python class name>, message}`: `motionErrorOf(error)`
  does it. The loop asks `isValueError(error)` to choose rejected or failed; it knows this module's classes,
  `src/protocol`'s two, and any error with a class named `ValueError` among its ancestors (which a minifier would
  rename) or a true `isValueError`. Done since (`docs/progress/common.md`, part 1): the library has one set of
  Python exception classes, `src/python/errors.ts`, with these helpers; this module's `ValueError`, `RuntimeError`,
  `TimeoutError` and `PythonException` are that set's, the kinematics' `ValueError` is the same class, and
  `OperatorPaused` is the station's one (`src/station/exceptions.ts`). The helpers no longer guess for the library's
  own errors (`instanceof`, or what `ActionParseError` and `PythonError` declare); the name and the flag are still
  read of an error that is not the library's.
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
  Not tried, and to be checked with the page: a page served over `https` is refused an `http` service as mixed
  content, except, in the browsers that say so, one on `127.0.0.1` or `localhost`.
- **A check of the client in Chromium** (the scenarios of `client.test.ts` in a page) needs, from `tests/agent`:
  1. `client_scenarios.ts`, `service.ts` and `records.ts`, which import nothing of Node (vitest's `expect` and
     `src/agent` only). Not `fixtures.ts` (it reads files: the page is given `client.json` as data) and not
     `socket_service.ts` (the stand-in server, on `node:net`: it runs in Node beside the browser).
  2. A `Service` of the page's own that drives that server: its `origin` and `closedOrigin`, `fetch: undefined`
     (the page's `fetch` is then the one asked and the one the client uses), and `begin`, `taken` and `close`
     passed on to the Node side; they may return promises for that.
  3. A way across origins, since the page and the server have two: a browser started with its cross-origin checks
     off, which leaves the bytes the recording server's; or a server that answers each request's preflight (an
     `OPTIONS` that it neither records nor spends a scripted response on) and adds `Access-Control-Allow-Origin` to
     every head, with `Authorization` and `Content-Type` allowed. The second is not written.
  4. Then `runClientScenario(scenario, service)` for each scenario, against the server as it is and with
     `unannouncedBreaks`: it asks the page's `fetch` first and holds each broken response to the matching record;
     `breakReports` and `reportsNote` give what the `fetch` reported, for a test's name. Where the browser passes
     on fewer bytes than were sent before a break, or reports what the record has no counterpart of, the run
     stops and says so: that is then a third case, to be looked at.
  5. Not looked at for a page: its timers when it is in the background (a stop is looked for every 20 ms and the
     scenarios act within tenths of a second), and a silent response of minutes (above).
- **Fixtures** (not this round's paths): to hold pear.js to what PEAR's client was only run on once, the fixture
  script would record `streams that break` also on: the reset's two events framed by the connection's end (the
  whole counterpart of `a chunked body reset`, which then needs no `[DONE]`); a chunked body cut after the stop
  chunk; the breaks without `Connection: close`; a reset that is an RST alone (the handler closes the socket
  itself after `SO_LINGER`); a body framed by the connection's end that is reset. The tests' rule finds a broken
  step's counterpart when the same body is recorded ended whole as well; a head without `Connection: close` needs
  a field of the script, which the stand-in services would read in place of `unannouncedBreaks`.
- **CI** runs no test yet. On its Node 24 the runtime's `fetch` reports the four broken responses as failures; the
  other record is then required of the scripted `fetch` alone. A job on the lowest Node of `engines` (20: today
  20.20.2, undici 6.24.1) would require it of a real `fetch` too.

## Left

Nothing in this module's scope. For a later round, both under "To reconcile": the check of the client in
Chromium, and the fixture steps that would hold pear.js to PEAR's client on more breaks. If PEAR or its SDK is
updated: run the fixture script with `--sync-tables` in the new environment, then the tests; `meta.json` records
the versions the fixtures were made with.
