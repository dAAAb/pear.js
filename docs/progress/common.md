# Progress: the shared foundation (`src/python`, `src/station/exceptions.ts`)

The modules were ported separately and each brought its own Python exceptions and its own reproductions of how
Python writes a value. This round gives them one set, without changing what any module does: every export name and
every import path that existed still works (the old files re-export), and every test that existed still passes
with its assertions as strong as before (the only ones that changed compare a Python class name directly, part 3).

State: the five parts are done. What remains is under "Left".

## Done

### Part 1: one set of Python exception classes

`src/python/errors.ts` holds Python's built-in exceptions as far as PEAR's station, lerobot and the libraries under
them raise them where pear.js throws. Each class has Python's name in `.name` and extends the class its Python
class extends, so `instanceof` answers what `isinstance` answers in PEAR, across modules:

    PythonException ("Exception")
      ArithmeticError: OverflowError, ZeroDivisionError
      AttributeError
      LookupError: IndexError, KeyError
      OSError: ConnectionError, TimeoutError
      RuntimeError: NotImplementedError, RecursionError
      StopIteration
      PythonTypeError ("TypeError"; JavaScript has a TypeError of its own)
      ValueError: JSONDecodeError (json's), UnicodeError: UnicodeDecodeError

With them: `PythonError` (an exception of a class named only when it is raised, for which pear.js has no class),
the interface `PythonIdentity` (`pythonType`, `isValueError`: how an error whose class cannot tell says which
Python class it stands for), and the helpers `pythonErrorName` (`type(error).__name__`), `pythonErrorMessage`
(`str(error)`), `isValueError` (`isinstance(error, ValueError)`) and `motionErrorOf` (`{code, message}`).

| Old place | New place | What remains at the old place |
| --- | --- | --- |
| `src/so101/kinematics/errors.ts`: `ValueError` | `src/python/errors.ts` | a re-export of `ValueError`; `UnreachablePoseError` stays (PEAR defines it in `control/motion/kinematics.py`) and extends the shared `ValueError` |
| `src/station/joint/errors.ts`: `RuntimeError`, `TimeoutError`, `PythonTypeError`, `ZeroDivisionError`, `IndexError` (and its re-export of the kinematics' `ValueError`) | `src/python/errors.ts` | re-exports of all six |
| `src/station/joint/errors.ts`: `OperatorPaused`, `Cancellation` | `src/station/exceptions.ts` (new; ports `pear/deploy/station/exceptions.py`) | re-exports |
| `src/agent/exceptions.ts`: `PythonException`, `ValueError`, `RuntimeError`, `TimeoutError` | `src/python/errors.ts` | re-exports |
| `src/agent/exceptions.ts`: `OperatorPaused` | `src/station/exceptions.ts` | a re-export |
| `src/agent/exceptions.ts`: `pythonErrorName`, `pythonErrorMessage`, `isValueError`, `motionErrorOf` | `src/python/errors.ts` | re-exports |
| `src/protocol/python_json.ts`: `PythonError` | `src/python/errors.ts` | a re-export |

What changed inside the modules, with nothing a caller or the model sees changed:

- Where a module threw `new PythonError("<Python name>", message, flag)` for a class the library now has, it
  throws that class: `JSONDecodeError`, `ValueError`, `RecursionError` (`python_json.ts`), `OverflowError`,
  `ValueError` (`action_parser.ts`), `AttributeError`, `PythonTypeError`, `KeyError`, `UnicodeDecodeError`
  (`src/agent`). Name and message are the same; the error is now also an instance of Python's bases (a
  `JSONDecodeError` is a `ValueError`). The three places that caught `PythonError` to tell Python's exceptions from
  the engine's (`parseAction`, `statusError`, `VLLMClient.decodedBody`) catch `PythonException`.
- `ActionParseError` (one class for the several exceptions PEAR's parser raises) extends `PythonException` and
  declares the class it stands for (`pythonType` is its `code`, `isValueError` its rejected status), so the helpers
  no longer name it and `src/python` imports no module. Its `name`, `code`, `status` and `error` are unchanged.
- `ImageCacheMiss` extends `PythonException` (PEAR: `Exception`). `RequestCancelled` stays an `Error` outside the
  hierarchy on purpose: it stands for asyncio's `CancelledError`, a `BaseException` that no `except Exception`
  catches.
- The unified `TimeoutError` keeps the agent's empty default message and takes the options of an `Error`; the
  unified `OperatorPaused.checkCancelled` takes the joint layer's `Cancellation` (`{ aborted }`), which an
  `AbortSignal` is, so the agent's calls are unchanged.
- `isValueError` keeps what it did for errors that are not the library's (a true `isValueError`, or a class named
  `ValueError` among the ancestors); for the library's own classes it no longer guesses: `instanceof`, or what the
  error declares.
- `src/index.ts` gives `python`; `src/station/index.ts` gives `exceptions`.

### Part 2: one home for how Python writes a value

| Old place | New place | What remains at the old place |
| --- | --- | --- |
| `src/protocol/python_float.ts`: `pythonFloatRepr` | `src/python/float.ts` | a re-export |
| `src/protocol/python_float.ts`: `pythonRound` | merged into the one of `src/python/format.ts` (below) | a re-export of the kept one |
| `src/protocol/python_json.ts`: `pythonJsonDumps`, `pythonJsonLoads` and their types | `src/python/json.ts` | re-exports (with `PythonError`, part 1) |
| `src/protocol/python_text.ts`: `pythonStrip`, `isPythonBlank`, `PYTHON_WHITESPACE_CLASS` | `src/python/whitespace.ts` | re-exports |
| `src/so101/kinematics/text.ts`: `formatFixed`, `formatGeneral`, `formatTemplate`, `pythonRound` | `src/python/format.ts` | re-exports |
| `src/station/joint/numeric.ts`: `pythonStr`, `pythonNumber`, `pythonStrRepr` | `src/python/str.ts` | re-exports; numpy's `minimum`, `maximum`, `clip`, the broadcasts, `pythonMin` and `integerPower` stay |
| `src/agent/clients/python_repr.ts`: all of it | `src/python/repr.ts` | re-exports |
| `src/agent/clients/python_printable.ts`: `NOT_PRINTABLE_RUNS` (generated) | `src/python/printable.ts` | a re-export |

Each moved file kept its text: against the base commit, `whitespace.ts` and `printable.ts` are identical, and the
others differ only in their imports, in the exception classes of part 1 and in the merge below.
`src/python/index.ts` gives everything under one name each; the one name two files share is `pythonStr`, so the
client's (of a decoded JSON value) is `pythonValueStr` there and the joint layer's (of a JavaScript value) keeps
`pythonStr`. `src/agent`'s two imports of the protocol's whitespace now name `src/python`.

**The generated table followed its file.** `tools/fixtures/agent_fixtures.py --sync-tables` writes the table of
`str.isprintable` to `src/python/printable.ts` (three lines of the script changed: the path, and the two texts that
name it). Run again in PEAR's environment with `--output` set to a scratch directory, it wrote a table identical to
the base commit's (SHA-256 `4454e968…6988`) and six fixtures identical, byte for byte, to the committed ones
(1,079,202 bytes).

**Merged: the two `pythonRound`.** The protocol's (the engine's `toFixed`, with an exact tie put right) and the
kinematics' (the float of the exactly rounded fixed-point text) were compared with `Object.is`, so the sign of a
zero counts:

| Values | Decimals | Comparisons | Differing |
| --- | --- | --- | --- |
| every number of the committed fixtures (118,657 distinct, in 43 files) | 0 to 22 | 2,729,111 | 0 |
| 5,008,696 generated doubles (any bits; a station's magnitudes; exact ties at 0 to 12 decimals; decimals written with a 5 after the last place, a little above and below; every power of two; powers of ten; each with its sign and its two neighbours) | 0 to 22 | 115,200,008 | 0 |
| 138,361 values: a quarter of the fixtures' numbers and 108,696 generated doubles | 23 to 100 | 10,792,158 | 0 |

Kept: the kinematics', because it is Python's own method (CPython's `float.__round__` writes the digits with its
correctly rounded conversion and reads them back) and does not end at the 100 decimals an engine's `toFixed` takes.
Outside what both were made for the two differed, so there the one function is not both: past 100 decimals it
returns the value, as Python does and as the kinematics' did (the protocol's threw the engine's `RangeError`); for
negative decimals it throws a `RangeError`, as the protocol's did through `toFixed` (the kinematics' returned a
wrong number: 123 for `round(1234.5678, -1)`, where Python gives 1230.0). No caller passes either.

**Not merged: the two reprs of a text.** `pythonStrRepr` (the joint layer's: the engine's Unicode properties) and
`pythonStringRepr` (the client's: Python 3.12's own table) differ:

| Compared | Count | Differing |
| --- | --- | --- |
| every string of the committed fixtures, keys included | 9,132 | 2 (both in the agent's fixtures, which hold such code points on purpose) |
| every code point, alone and beside each kind of quote | 1,114,112 code points, 4,456,448 strings | 10,615 code points |
| generated strings of 1 to 12 code points | 300,000 | 3,401 |

All 10,615 are code points assigned after Unicode 15.0.0 (90 runs, from U+088F to U+33479), which Node 24.18.1
(Unicode 17.0) knows and shows. PEAR's Python (3.12.15, Unicode 15.0.0) was asked about each: it escapes all 10,615
(`repr(chr(0x088F))` is `'\u088f'`), and shows none. So `pythonStringRepr` is Python's repr and `pythonStrRepr` is
not, on an engine newer than Python's Unicode; in the other direction (Python shows, the engine escapes) there is no
code point. As the rule for this round has it, the pair was left as two functions; both are in `src/python`, the
joint layer's says in its comment where it differs, and `tests/python/wording.test.ts` holds the difference to
exactly that one direction. Changing the joint layer to the table's function would change what the SO-101's
settings and the control loop write for a text that holds such a code point (to PEAR's text, by the measurement
above): a decision for the coordinator.

**Looked at and left as they are** (not the same thing twice): the joint layer's `pythonStr` and `pythonNumber`
against the client's `pythonStr(pythonValueOf(x))`, which take a whole number of 1e16 and more differently (a float
for the first, an int's digits for the last), each as its own fixtures have it; `exactDecimal` (`format.ts`) and
`decomposed` (`numeric.ts`), two private readers of a double's bits, of which the second stays with numpy's
arithmetic; Python's `sum` and `int()` (`src/agent/clients/metrics.ts`, `src/feetech/bus.ts`), which are
arithmetic; the two private one-line printers of a dict in `src/feetech/bus.ts` and `src/so101/hardware/arms.ts`
(integer keys, one line).

### Part 3: the servo layer's errors carry Python's class names

For every place where `src/feetech` and `src/so101/hardware` throw, the Python that pear.js ports there was read
(lerobot 0.6.1: `motors/motors_bus.py`, `motors/feetech/feetech.py`, `motors/encoding_utils.py`,
`utils/errors.py`, `utils/decorators.py`; PEAR's `hardware/arms.py`, `startup.py`, `arm_state.py`, `driver.py`; the
SDK never raises), and the error thrown now has the name of the class raised there and extends the class of part 1.
The TypeScript class names that tests use stayed.

| Where | Was | Python raises | Now |
| --- | --- | --- | --- |
| `FeetechCommError` (a failed exchange; could not connect; the goal read back wrong) | `Error` named `FeetechCommError` | `ConnectionError` | extends `ConnectionError`; its name is `ConnectionError`; it keeps `result` |
| `FeetechStatusError` (an error byte) | `Error` named `FeetechStatusError` | `RuntimeError` | extends `RuntimeError`; its name is `RuntimeError`; it keeps `error` |
| `DeviceAlreadyConnectedError`, `DeviceNotConnectedError` | `Error` | lerobot's classes of those names, which are `ConnectionError`s | extend `ConnectionError`, names unchanged |
| `ServoFault` | `Error` | PEAR's `ServoFault(RuntimeError)` | extends `RuntimeError`, name unchanged |
| `bus.ts`: two motors with one id; a calibration whose range has no width; a negative value, a value too large for its register; a register length other than 1, 2, 4 | `RangeError` | `ValueError` | `ValueError` |
| `bus.ts`: a register size `serializeData` does not know | `Error` | `NotImplementedError` | `NotImplementedError` |
| `bus.ts`: no calibration registered; the motor check; firmware versions that differ | `Error` | `RuntimeError` | `RuntimeError` |
| `bus.ts`: a motor's name or id the bus does not have; a motor without a calibration | `Error` | `KeyError` (`self.motors[motor]`, `self._id_to_name_dict[id]`, `self.calibration[motor]`) | `KeyError` |
| `bus.ts`: a sync read or a sync write of no motor | `Error` | `StopIteration` (`next(iter(models))`) | `StopIteration` |
| `bus.ts`: `int()` of a position that is not finite | `RangeError` | `ValueError` of a NaN, `OverflowError` of an infinity | `ValueError`, `OverflowError` |
| `tables.ts`: a register the servo does not have | `Error` | `KeyError` (`get_address`) | `KeyError` |
| `tables.ts`: a magnitude too large for its sign bit | `RangeError` | `ValueError` | `ValueError` |
| `protocol.ts`: a status packet with fewer bytes than were read | `RangeError` | `IndexError` (the SDK indexes past the list) | `IndexError` |
| `arms.ts`: an arm that is closed | `Error` | `RuntimeError` | `RuntimeError` |
| `arms.ts`: a target that is not six finite numbers | `RangeError` | `ValueError` | `ValueError` |
| `startup.ts`: no calibration; registers that differ from the file | `Error` | `RuntimeError` | `RuntimeError` |

Two `catch` clauses now read as the Python's `except` does, with the classes that exist for it: `connect()` turns
an `OSError` of the handshake into "Could not connect on port" (lerobot: `except (FileNotFoundError, OSError,
serial.SerialException)`), and enabling the arm is tried again after a `ConnectionError` (PEAR: `except
ConnectionError`), which now includes lerobot's two errors of a bus that is or is not connected, as in PEAR. Before,
both asked for `FeetechCommError`. Nothing a test or a session reaches changed: the handshake can throw no other
`OSError`, and the arm is enabled on a bus that was just connected.

Left as JavaScript's own errors, each because no Python is ported at that place: everything in `transport.ts`
and the two `sim.ts` (not in PEAR: the Web Serial transport, the simulated servos); the two guards of
`protocol.ts` that the SDK does not have (`Not bytes`, and a sync write whose data is shorter than its register,
which the SDK would send malformed); `parseCalibration`'s checks of a file's shape (lerobot reads the file with
draccus, whose errors are its own: `DecodingError`, or none at all for a file that holds a list); `arms.ts`'s check
of the number of joint offsets (part 4: PEAR checks it in its settings).

The messages were not touched. Seven of these places word their error in pear.js's own words, as before, where
Python's text is the bare key of a dictionary (`'wrist'`, `9`), Python's sentence of `int()` (`cannot convert float
NaN to integer`), the message in quotes (a `KeyError` shows the repr of its text), or names a file and a command a
page does not have; `tests/python/servo_errors.test.ts` lists them. None is reached by a station that runs.

`tests/feetech` and `tests/sim-bridge` compare the names directly: `expectError` (`tests/feetech/helpers.ts`)
requires the error's `name` to be the fixture's `type` for all 81 recorded errors, and where it asked for a
`RangeError` it asks for the library's `ValueError` or `IndexError`; `jsErrorName` is gone from
`tests/sim-bridge/compare.ts`, which counts a class as the same only under the same name. Its `sameMappedType`
stayed as a second name of `sameType`, because `sim-bridge.test.ts` (not this round's file) reads it.

### Part 4: the hardware layer fits the joint layer's interfaces

Done from the hardware side alone: nothing under `src/station/joint` was edited for it.

| What | Was | Now |
| --- | --- | --- |
| `SO101ArmState` | an interface of five fields, beside the joint layer's class | a class that extends the joint layer's `ArmState` and adds `servoStatus`, as PEAR's does: the joint layer's `check(layout)`, and `feedback(now)` with the servos' status after the joint layer's keys (a deep copy). `SO101Hardware.read()` returns it. Its fields keep their types (`position: number[]`, `sampleId: number \| null`) |
| `armFeedback(state, now)` | built the feedback itself | `state.feedback(now)`; kept, and it takes a reading that is plain data too |
| `ArmFeedback` of `hardware/arm_state.ts` | six fields of its own | extends the `ArmFeedback` of `src/station/schemas.ts` by `servo` |
| `ServoFault` | an `Error` | a `RuntimeError` (part 3) |
| `SO101Driver` | a class of its own, of the same shape | extends `JointDriver<SO101ArmState>`: what it reads is a state of the joint layer for each arm |
| `PositionBounds` | an interface of its own | the `lowerBounds` and `upperBounds` of the joint layer's `JointLimitValues`: a robot's `jointLimits()` is given as it is |
| the `monotonic` option of the driver and of the arm | `() => number` | `MonotonicClock["monotonic"]`, and beside it `clock`, a `MonotonicClock`; without either, the joint layer's `secondsClock()`, which reads the clock the default read before |
| `ARM` | defined in `hardware/driver.ts` and in `layout.ts` | the layout's, which `driver.ts` re-exports |
| the arm and its follower | made of plain options that nothing checks (`SO101HardwareOptions`, `FollowerConfig`) | also made from the station's checked settings, as PEAR's constructors make them: `SO101Hardware.fromConfig(controlConfig, robotConfig, line)` (`require_commissioned`, the follower of the hardware section, then connect, enable and check), `makeFollower(hardwareConfig, ...)` (PEAR's `StartupChecks.make_follower`: degrees, the section's P gain, the section's port as the line's name) and `SO101Driver.fromConfig(...)` (the limits of the settings, the arm, and the feedforward built with the arm enabled; if that fails the arm is released). The plain entries stay, for the tests and for a caller with values of its own |

What `fromConfig` is given besides the settings (`SO101Line`): the line, already open, and the calibration, parsed;
PEAR finds a serial device and a calibration file through its settings, and locks the device, which a page cannot.

One thing was added at run time, `SO101ArmState.of`, through which the driver takes its arm's reading: a state of
the joint layer is returned as the object it is, and a reading that is plain data becomes a state with the same
fields. An existing test (`tests/station-joint/feedforward.test.ts`) hands the driver an arm whose readings are
object literals, so the arm's interface must take plain data, while a `JointDriver` must return states that check
themselves and give their feedback. With `SO101Hardware` under it the driver returns the arm's own object, as before.

`SO101Driver.read()` is typed as PEAR annotates it (a state for the arm). In one corner there is no reading yet,
and PEAR returns `None` there as pear.js returns `null`: a command that goes before the first read, and that read
fails. A control loop reads first.

### Part 5: one port of `control/schemas.py`

`src/station/schemas.ts` is the port. `src/agent/robot.ts` no longer defines any of it a second time: it imports
the station's definitions, re-exports the two that were the same, and makes the three that the loop holds in
another form out of the station's. Decided type by type:

| Type | In `src/agent/robot.ts` it was | Now | Why |
| --- | --- | --- | --- |
| `ActionPhase` | a second object with the same three words | the station's, re-exported (one object) | the two were identical; PEAR has one enumeration |
| `Camera` | a second interface with the same three fields | the station's, re-exported | identical |
| `Observation` | an interface of its own: camelCase fields, JPEG bytes | a type made of the station's `Observation<Uint8Array>`: its fields under camelCase names (a mapped type renames PEAR's keys), `images` and `joint_positions` with the station's types, the frames' stamps from the station's `CameraFrame` | the station's is the more faithful: it is PEAR's dictionary under PEAR's keys, which is recorded and shown as it is. The loop holds an observation as an object with camelCase fields and bytes for images (`docs/progress/agent.md`, deliberate difference 2), and the agent's tests drive the loop with such objects; so the loop's fields stayed and their definition became the station's |
| `ControlSnapshot` | `Record<string, unknown>` | the fields of the station's `ControlSnapshot`, `DetailedStatus` and `BriefStatus`, none required | the station's three are PEAR's; the loop is given one of them (or nothing a test cares to fill in) and passes it on unread |
| `ActionFormat` | an interface of its own: a name, cameras and three functions | an interface that takes `name`, `cameras` and `resultFeedback` from the station's and adds `turnText` and `parseAction` | the station's is PEAR's dataclass (schema, decimals, the action's model); the loop uses the two functions PEAR makes of those, which `src/protocol` holds for the SO-101 |
| `CameraTimestamps` | an interface of its own | the station's `CameraFrame` without its image, camelCase, the frame's number optional | PEAR: "the frame's fields but its image"; the loop reads when the frame arrived |
| `ActionMode` | here | here | it is not of `schemas.py`: PEAR defines it in `control/robot.py`, which the next round ports |

Left where they are, as the round's brief has it: `resultRecord`, `SINGLE_ARM_POSE_FORMAT` (`formats.ts`) and the
`AgentRobot` interface. Every exported name of `src/agent` is as before, and no test of the agent was edited.

What this does not do: the loop still reads an observation's fields under camelCase names and takes JPEG bytes. To
have the loop read PEAR's dictionary itself (`observation_id`, `camera_timestamps[role]["received_monotonic_s"]`)
changes what `AgentRobot.observe()` must return and the observations that the agent's tests build; it belongs with
the round that ports the robot and takes `AgentRobot`.

## How it was verified

From the repository root (PowerShell; Node 24.18.1):

```
npx tsc --noEmit        # no error (while other workers' files were unfinished, none outside those files)
npx vitest run          # see the counts below
```

| | Test files | Passed | Skipped |
| --- | --- | --- | --- |
| Base (`fd854ff`) | 44 | 2,468 | 4 |
| After part 1 | 45 | 2,561 | 4 |
| After part 2 | 46 | 2,574 | 4 |
| After part 3 | 47 | 2,595 | 4 |
| After part 4 | 47 | 2,608 | 4 |
| After part 5 | 47 | 2,613 | 4 |

(The counts are of the test files of the base commit and of this round's; other workers' new test files, some of
them unfinished while this ran, are left out.)

Part 1 added 93 tests: `tests/python/errors.test.ts` (88) and 5 in `tests/modules.test.ts`. Part 2 added 13:
`tests/python/wording.test.ts` (9) and 4 in `tests/modules.test.ts`. No existing test was edited in parts 1 and 2
except `tests/modules.test.ts`, which gained tests and imports; the 1,491 tests of `tests/protocol` and the 35 of
`tests/so101-kinematics` now run the one `pythonRound`.

Part 3 added 21 tests, all in `tests/python`: 7 in `errors.test.ts` (PEAR's `ServoFault` and lerobot's two classes
joined the reference, 44 classes now; the two classes that keep a TypeScript name) and `servo_errors.test.ts` (14).
The existing tests it changed, each only in the class it compares: `tests/feetech/helpers.ts` (`expectError`: the
name of every error against the fixture's `type`; `ValueError` and `IndexError` where it asked for `RangeError`),
`protocol.test.ts` (one `toThrow(RangeError)` is `toThrow(IndexError)`), `so101.test.ts` (two `new RangeError` are
`new ValueError`), `driver.test.ts` (one comparison of the name added), `tests/sim-bridge/compare.test.ts` (the
candidate's names are Python's; the test of `jsErrorName`'s five cases is a test that each of those five names is
compared as it is, and that the name each class had before is found as a difference). No case was dropped.

`servo_errors.test.ts` covers the places the fixtures of `tests/feetech` have no case for. The script calls
lerobot's and PEAR's own functions on a bus that opens no port (two motors with one id, a name, an id and a
calibration the bus does not have, a register of three bytes, a position that is NaN or infinite, a register the
servo does not have, a read of and a command to an arm that is closed, an arm without a calibration, a calibration
the servos do not hold) and records the class, its bases and the message of what each raised; the test makes the
same twelve calls in pear.js and requires the name, `instanceof` each recorded base and no other, and the message
(or, for the seven places worded in pear.js's own words, that text, listed).

Part 4 added 13 tests to `tests/modules.test.ts` and changed no existing test: the tests that make an arm of plain
options, a driver of literal bounds and a clock function, and an arm of object literals compile and pass as they
were. The new ones: a reading of the arm is the joint layer's `ArmState`, checks itself against the layout and
gives PEAR's feedback; plain data becomes a state and a state stays the object it is; the driver is a
`JointDriver` on the joint layer's `JointLimits` and `MonotonicClock`; the arm's name is the layout's; settings that
PEAR's `HardwareConfig` refuses (four, in PEAR's words) or under which the arm must not move (three) write nothing
to the line; the driver made from the settings carries their gravity offset and releases its arm when its
feedforward cannot be built. And the seven sessions of PEAR's `SO101Hardware` that `tests/fixtures/feetech/so101.json`
records (70 operations, 731 packets) run through `SO101Hardware.fromConfig` on the recorded line: the same packets
in the same order, the same readings and refusals, and for one reading in six PEAR's own
`SO101ArmState.feedback()` against the class's method.

Part 5 added 5 tests to `tests/modules.test.ts` and changed no existing test. `ActionPhase` is the station's object
under both paths; the compiler is asked (a type that is `true` only for two identical types) that the agent's
`ActionPhase` and `Camera` are the station's, that the agent's `Observation` has exactly the seven camelCase fields
and the station's types for the joints and the images, and that its `ControlSnapshot` has exactly the keys of
PEAR's three dictionaries; at run time the keys of an observation of each form are compared with PEAR's own
(`tests/fixtures/station-joint/meta.json`: the keys of PEAR's `Observation`, `CameraFrame`, `ControlSnapshot`,
`DetailedStatus`, `Camera` and `ActionFormat`), and the loop's own reading of an observation
(`ObservationMessage.build`) takes one built from the station's field by field.

`tests/python/reference.json` is written by `tests/python/make_reference.py` in PEAR's station environment
(Python 3.12.15, lerobot 0.6.1, openai 3.35.1, PEAR at the pinned commit; it stops at another commit and if the
file would hold a path of the machine):

```
<work dir>/envs/station/bin/python tests/python/make_reference.py
```

It records, for each of the 44 Python exception classes pear.js has a class for (20 of Python, PEAR's 8, lerobot's
2, the OpenAI SDK's 13, asyncio's `CancelledError`), the class's name, its bases in Python's order and whether it is a
`ValueError`. The tests require of each pear.js class: Python's name, the same chain of bases up to `Exception`,
`instanceof` every recorded base and no other class of the table, and `isValueError` equal to Python's
`issubclass(cls, ValueError)`; and that the table and the reference name the same classes. `tests/modules.test.ts`
requires that each built-in is one class under every path that gives it (the module entries and the four old
files), that `OperatorPaused` is one class, that the helpers are the same functions, that no module exports a class
of its own under a Python exception's name (a walk over everything the package's entry gives), and that an error
thrown in one module is an instance of the class another module asks for.

For part 2 the same script writes 346 doubles (with Python's `repr`, `round(x, n)` for n of 0, 1, 2, 3, 6, 17 and
101, `format(x, ".nf")`, `"+.nf"`, `"g"` and `"+g"`) and 201 texts with Python's `repr` (quotes, escapes, every
plane, lone surrogates, ten code points assigned after Unicode 15.0.0). The reference is 172,630 bytes with the
servo layer's places of part 3, and two runs gave the same file. `tests/python/wording.test.ts` requires Python's
value of each (a rounded float to the sign of its zero), that `pythonStringRepr` is Python's repr of every text,
and that `pythonStrRepr` differs from it over all 1,114,112 code points in the one direction described above and no
other. `tests/modules.test.ts` requires that each function is the same function under its old path and under
`src/python`. A larger reference, not committed:

```
<work dir>/envs/station/bin/python tests/python/make_reference.py --scale 50 --output <directory>   # 6.7 MB
$env:PEAR_JS_PYTHON_REFERENCE = "<directory>"; npx vitest run tests/python                          # 118 tests, all pass
```

15,340 doubles and 7,551 texts. The proofs of agreement above ran on scratch scripts kept outside the repository
(the repository's own vitest, pointed at a scratch folder whose scripts import both functions of a pair).

### The tests fail when the unification is broken

Each change was made alone, `npx tsc --noEmit` and the whole suite run, and the file written back (its hash
compared with the hash before); 2,613 tests pass afterwards. None of the eight is a compile error: the tests find
them.

| Change | Failing tests of 2,613 |
| --- | --- |
| A second `ValueError`: `src/so101/kinematics/errors.ts` defines its own class again | 8 (`tests/modules` 4, `tests/python` 2, `tests/so101-kinematics` 2) |
| A second `OperatorPaused`: `src/agent/exceptions.ts` defines its own class again | 1 (`tests/modules`) |
| A helper that rounds differently: `pythonRound` through the engine's `toFixed`, so that a tie goes up | 73 (`tests/protocol` 67, `tests/so101-kinematics` 3, `tests/python` 2, `tests/modules` 1) |
| A wrong Python name on a servo error: `FeetechCommError` under its own name again | 10 (`tests/feetech` 5, `tests/modules` 2, `tests/python` 2, `tests/sim-bridge` 1) |
| A servo error of a JavaScript class again: a closed arm throws a plain `Error` | 5 (`tests/feetech` 2, `tests/python` 2, `tests/modules` 1) |
| The arm's reading without the servos' status in its feedback | 10 (`tests/modules` 6, `tests/feetech` 4) |
| The arm's reading as plain data again: `SO101Hardware.read()` returns no `ArmState` | 4 (`tests/modules`) |
| A second `ActionPhase`: `src/agent/robot.ts` exports a copy of the station's enumeration | 1 (`tests/modules`) |

## What turned out to differ from Python or PEAR

Found while comparing; none was changed, each is for the coordinator to decide.

1. **`pythonStrRepr` is not Python 3.12's `repr` on an engine with a newer Unicode** (part 2): 10,615 code points
   on Node 24.18.1, all escaped by Python and shown by the function. `src/so101/config.ts` (two messages of the
   settings) and `src/station/joint/control_loop.ts` (a new file of this round's other work) use it; the client's
   `pythonStringRepr` is right on all of them.
2. **Seven messages of the servo layer are pear.js's own words** where the class is now Python's (part 3): an
   unknown motor name, id and calibration (`KeyError`, whose Python text is the bare key), `int()` of a NaN or an
   infinity (Python: `cannot convert float NaN to integer`, `cannot convert float infinity to integer`), a register
   the servo does not have (Python shows the message in quotes), an arm without a calibration (PEAR names the file
   and its own command). None is reached by a station that runs.
3. **`parseCalibration` is stricter than lerobot** (part 3): lerobot's reading of a calibration file (draccus) takes
   a file that holds a list as no calibration at all, and refuses a wrong field with its own `DecodingError`;
   pear.js refuses both with a JavaScript `TypeError` in its own words.
4. **The kinematics' `pythonRound` returned a wrong number for negative decimals** (part 2): 123 for
   `round(1234.5678, -1)`, where Python gives 1230.0. No caller passes them; the one function now refuses them.
5. **A Web Serial port that closes while it is read throws a plain `Error`** (`src/feetech/transport.ts`, not
   PEAR's code). In PEAR the serial library raises its own `SerialException`, an `OSError`, which lerobot's
   `connect` turns into `ConnectionError` ("Could not connect on port"). `connect()` here now does that for any
   `OSError`; whether the transport should throw one is for the work on the page to decide.

## Requests for the coordinator

Files this round may not edit:

- `NOTICE`, line 41, names `src/agent/clients/python_printable.ts` as the file that holds the table derived from
  the Unicode data: the table is in `src/python/printable.ts` (the old file re-exports it).
- `README.md`: the table of modules has no row for `src/python`.
- `docs/DESIGN.md`: the row of `src/station/joint/`, `src/station/schemas.ts` lists `deploy/station/exceptions.py`,
  which is now `src/station/exceptions.ts`.
- `tests/sim-bridge/sim-bridge.test.ts`, line 111, reads `refusals.sameMappedType`; it is now the same count as
  `sameType` and exists only for that line. `docs/progress/sim-bridge.md` ("Found" 1, the table of the 12
  refusals, "Left") and the bullet "Exceptions" of `docs/progress/feetech.md` describe the classes before part 3.
- `tests/station-loop/standins.ts` defines a `ServoFault` and an SO-101 state and driver of its own "until
  `SO101Driver` fits the joint layer's `JointDriver`": it does now, and `so101.hardware.ServoFault` is a
  `RuntimeError`.
- The bridge check (`PEAR_JS_SIM_BRIDGE`) was not run in this round, as its brief has it: after part 3 the class
  names of the 12 refusals should be equal on both sides (`sameType` 12 of 12).
- The page (`web/src/arm.ts`) shows an error's `name` beside its message: for an error of the servo layer that name
  is now Python's (`ConnectionError`, `RuntimeError`, `KeyError`) where it was `FeetechCommError`,
  `FeetechStatusError` or `Error`. Its `instanceof FeetechCommError` and `FeetechStatusError` hold as before.

## Left

Nothing of this round's five parts. Open decisions are in the two sections above. For the round that ports the
robot: whether the agent's loop reads PEAR's observation dictionary itself (part 5), and `SO101Driver.fromConfig`
and `SO101Hardware.fromConfig`, which are what PEAR's robot calls.
