# Progress: `src/protocol`

The texts a PEAR model reads and the action it writes, for the SO-101's `single_arm_pose` format.
Compared with PEAR at `f32aa1f7c2ec9c3f45630cc9f8541b3201e8e087`, run in its station environment
(Python 3.12.15, pydantic 2.13.5).

## Done

| File | What it is | Ports |
| --- | --- | --- |
| `src/protocol/system_prompt.ts` | `systemPrompt(instruction)` | `SystemPrompt.render`, `JsonBlockProtocol.system_prompt` |
| `src/protocol/turn_text.ts` | `turnText(state, feedback?)`, `shownState`, `shownQuantity` | the text of `ObservationMessage.build`, `JsonBlockProtocol.turn_text` |
| `src/protocol/action_parser.ts` | `parseAction(answer)`, `ActionParseError` | `ActionParser`, `JSON_BLOCK_PATTERN`, the validation of `SingleArmDelta` |
| `src/protocol/feedback.ts` | `executionFeedback(result, { isDispatched })` | `SingleArmPoseFormat.result_feedback` |
| `src/protocol/types.ts` | state, action, result; the format's schema, decimals, camera | the SO-101's models, `MotionResult`, `MotionStatus`, `GripperOutcome` |
| `src/protocol/prompts.ts` | the two prompt files, embedded (generated) | `system_prompt.md`, `prompts/single_arm_pose.md` |
| `src/protocol/python_float.ts` | Python's `round(x, n)` and `repr(x)` of a float | CPython 3.12 |
| `src/protocol/python_json.ts` | Python's `json.dumps` and `json.loads` with an `object_pairs_hook`, error texts included | CPython 3.12 |
| `src/protocol/python_text.ts` | Python's whitespace (`str.strip`, `\s`) | CPython 3.12 |
| `assets/pear/prompts/` | PEAR's two prompt files, unchanged (LF), with a README of paths and SHA-256 | |
| `tools/fixtures/protocol_fixtures.py` | writes `tests/fixtures/protocol/*.json` from PEAR's own functions | |

Why three files reproduce Python itself: the model's view depends on it. `round()` goes to even on an exact tie
(`0.25 -> 0.2`, where `toFixed` gives `0.3`); `repr()` always shows a decimal point and switches to an exponent at
`1e16` and `1e-05`; `json.loads` accepts `NaN`, `Infinity` and integers of any size, and when it refuses a block
its message (`Expecting ',' delimiter: line 1 column 9 (char 8)`) is shown to the model in the next turn; Python's
whitespace is not JavaScript's (`\x1c`-`\x1f` and `\x85` count, `﻿` does not).

What the model is told when its answer gives no action: `parseAction` throws `ActionParseError` with `code` (the
name of the Python exception PEAR raises), `message` and `status`. PEAR's agent loop records such a turn as a result
with that status (rejected for a `ValueError`, failed otherwise), `error = {code, message}` and
`is_dispatched = false`; `executionFeedback` of that result is the next turn's report. The parse fixtures hold that
report for every refused answer that is not randomly generated.

## How it was verified

From the repository root (PowerShell; Node 24):

```
npm run typecheck                      # passes
npx vitest run tests/protocol          # 5 files, 1491 tests, all pass
```

The fixtures (376 KB, deterministic: generated twice, identical) and what each compares, by string equality:

| Fixture | Cases | Compared |
| --- | --- | --- |
| `system_prompt.json` | 9 instructions (English, Traditional Chinese, several lines, CRLF, `{instruction}`, `$&`) | the whole prompt |
| `turn_text.json` | 180 states with and without a report | the whole turn text |
| `python.json` | 400 floats (ties, negative zeros, values that round up, both ends of the range, random bit patterns); 8 strings | `repr`, `round` to 0-3 places; `json.dumps` escapes |
| `parse.json` | 373 answers: 136 hand-written, the 10 of PEAR's own test, 17 at Python's limits, 60 of random number literals, 150 random mutations; 84 parse, 289 are refused | the action (sign of zero and field order included) or the error's class, message and status; the next turn's report for 141 refused ones |
| `feedback.json` | 101 results: no result; completed with each gripper outcome, settled or not, reached or not; out of reach (24 messages from `SO101Kinematics.unreachable_message`); rejected otherwise; failed; interrupted by the operator; a closed robot; messages with quotes, control characters, CJK, emoji, a lone surrogate | the whole report |
| `meta.json` | PEAR's four stored texts of the SO-101 (`prompt-`, `observation-`, `parse-`, `feedback-so101-single_arm_pose.txt`) with the inputs that give them; the format's constants; Python's whitespace set; the prompts' hashes; the PEAR commit | each stored text reproduced; constants equal; whitespace equal over all code points |

The fixture script stops unless the four texts it makes equal PEAR's stored files, unless the PEAR it runs in is at
the pinned commit, and unless `assets/pear/prompts` holds that PEAR's files.

A larger run, not committed (40 times the generated cases: 16,000 floats, 7,200 turns, 8,563 answers), in WSL then
PowerShell:

```
<work dir>/envs/station/bin/python tools/fixtures/protocol_fixtures.py --scale 40 --output <directory>
$env:PEAR_JS_PROTOCOL_FIXTURES = "<directory>"; npx vitest run tests/protocol     # 47,901 tests, all pass
```

The tests fail when the code is wrong: with the tie rule of `pythonRound` disabled and the column of a JSON error
off by one, 199 of the 1491 failed.

## Not verified

- Only Node 24 (V8) has run the tests; no browser engine. One point depends on the engine: `Number()` of a long
  digit string must be correctly rounded (ECMAScript allows less past 20 digits; the current engines are exact).
- The results in `feedback.json` are built by PEAR's `SO101MotionResult.from_snapshot` from a bare arrival, and the
  status of a refused answer by the one rule of `StationAgentLoop.step`, restated in the fixture script: no robot
  or agent loop ran. Building a result from a snapshot is the station module's part.
- The out-of-reach messages come from PEAR's message function with random increments and fractions, not from
  inverse-kinematics solves (the stored-text case is the one PEAR's own test solved).

## Deliberate differences

1. `parseAction` throws one class, `ActionParseError`, with the Python exception's name as `code`, where PEAR
   raises `ValueError`, `json.JSONDecodeError`, `OverflowError` or `RecursionError`. Nothing is lost: `code`,
   `message` and `status` are what PEAR's result carries.
2. JSON nested about 9,996 deep or more ends in PEAR with `RecursionError`, by the interpreter's C recursion limit
   at that moment. pear.js uses the depths measured in PEAR's environment (`python_json.ts`, tested at each
   boundary) and reads the block without recursing, so that such an answer ends as in PEAR and not with the
   engine's stack. In a running station the depth may differ by its call stack. An action is two deep.
3. `turnText` throws `RangeError` for a state that holds NaN or an infinity. PEAR never reaches the text with
   one: its state model refuses it first (pydantic `ValidationError`).
4. `turnText` gives the text only; PEAR's `ObservationMessage.build` also saves the frames as JPEG (quality 90) and
   checks their times. That belongs to the station and web modules.
5. Not ported: `JsonBlockProtocol.check_action` (used by PEAR's simulated environments, `pear/envs/tool.py`, not
   by the station); the "frames follow" wording of formats with several cameras; YAM's format.

## To reconcile with the other modules

- **Constants that live in PEAR's kinematics and hardware code**, defined here in `types.ts`: `ARM_QUANTITIES` and
  `DECIMALS` (`SO101Kinematics`), `UNREACHABLE_POSE_ERROR` (the class name `UnreachablePoseError`), `CAMERA_NAMES`
  (`WristCamera.CAMERA`). `tests/protocol/prompts.test.ts` checks them against PEAR. Done since: the kinematics
  module takes `ARM_QUANTITIES`, `DECIMALS` and the state and action types from here, and `tests/modules.test.ts`
  holds its error's name equal to `UNREACHABLE_POSE_ERROR`.
- **Kinematics**: `SO101Kinematics.quantities` rounds exactly as a turn does (`round(v, decimals) + 0.0`):
  `shownQuantity` is that function. The out-of-reach message (`unreachable_message`, `truncated_text`) is the
  kinematics module's to produce; this module only embeds it. Done since (`docs/progress/common.md`, part 2): the
  two round with one `pythonRound`, the library's (`src/python/format.ts`); this module's own, made of the
  engine's `toFixed`, gave the same float on every value compared and was dropped.
- **Python itself** (done since, `docs/progress/common.md`, parts 1 and 2): `python_float.ts`, `python_json.ts` and
  `python_text.ts` are in `src/python` (`float.ts`, `json.ts`, `whitespace.ts`) and re-exported here. `PythonError`
  is the library's class for an exception named when it is raised (`src/python/errors.ts`); `json.loads` and the
  parser throw the library's `JSONDecodeError`, `ValueError`, `RecursionError` and `OverflowError`, and
  `ActionParseError` (still the one class `parseAction` throws, deliberate difference 1) extends the library's
  base and tells which of them it stands for.
- **The gripper's width in an observation**: PEAR computes `closed + opening * (open - closed)` from
  `geometry.gripper_width_cm`, shipped as `[0.0, 6.0]`, so an open gripper reads `6.0` (as in PEAR's stored
  observation), while the environment prompt says "Observations: unitless -1 closed, +1 open". Which
  configuration the released model was trained with is an open question for the station module.
- **Station**: a result's `error.code` is the Python class name of what PEAR raises (`ValueError`, `RuntimeError`,
  `TimeoutError`, `GripperEndpointTimeout`, `OperatorPaused`, `StabilityError`, ...) and `error.message` its
  text; both reach the model through `executionFeedback`, so the station must use PEAR's names and words.
  `executionFeedback(null, ...)` (the "interrupted" sentence) is never called by PEAR's station, only by its tests.
- **Station or web**: PEAR's console strips the instruction (Python's `strip`, exported here as `pythonStrip`) and
  accepts 1 to 20,000 characters before it renders the prompt (`gui/console/commands.py`). `systemPrompt` takes
  the instruction as given, as `SystemPrompt.render` does. The `<think>` check is on the answer alone: the client
  must keep the model's reasoning out of it, as PEAR's clients do.
- `MotionResult` here uses camelCase fields; PEAR's records use `to_record()`'s keys (`settled`, `reached`,
  `measured_position`, ...). Not needed until the station writes records.

## Left

Nothing in this module's scope for the SO-101. If PEAR is updated: run the fixture script with `--sync-prompts`
in the new environment, then the tests.
