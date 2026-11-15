# Progress: the joint layer (`src/station/joint`, `src/station/schemas.ts`, `src/so101/joint`)

State: the configuration, the limits, the safety monitors and the friction feedforward of PEAR's `control/joint/` are
ported and compared with PEAR's own Python on committed fixtures. The trajectory generator, the control loop, the
operations and the recovery are not part of this module. Nothing here has run in a browser or against an arm.

Paths below are under `pear/deploy/station/control/` in PEAR unless they say otherwise.

## Done

| File | Ports |
| --- | --- |
| `src/station/joint/config.ts` | `joint/config.py`: `ConfigSection`, `ControlConfig`, `MotionLimits`, `Limits`, `HomeConfig`, `RobotConfig`; the `control` node of `pear/configs/station.yaml` (`DEFAULT_CONTROL_SETTINGS`); the placeholders of `BaseRobot.make_configs` (`robot.py`) |
| `src/station/joint/limits.ts` | `joint/limits.py`: all of `JointLimits`; the body of `RobotConfig.joint_limits` (`fromArms`) |
| `src/station/joint/layout.ts`, `texts.ts` | `joint/layout.py`, `joint/texts.py`: re-exports. The class is in `src/so101/layout.ts`, which gained `split`, `join`, `armAxisLabels`, `axisName`, `jointValues`, `gripperValue`, `withGripper`, `ARM_LABEL`, `COORDINATE_LABEL` |
| `src/station/joint/arm_state.ts` | `joint/arm_state.py` |
| `src/station/joint/stability.ts` | `joint/stability.py`: `StabilityError`, `SampleWindow`, `StabilityWindow` |
| `src/station/joint/tracking.ts` | `joint/tracking.py`: `TrackingError`, `Tracking` |
| `src/station/joint/action_guard.ts` | `joint/action_guard.py` |
| `src/station/joint/snapshot_checks.ts` | `joint/snapshot_checks.py` |
| `src/station/joint/feedforward.ts` | `joint/feedforward.py` |
| `src/station/joint/driver.ts` | `joint/driver.py` (the interface, as an abstract class with PEAR's two defaults) |
| `src/station/joint/errors.ts` | Python's `RuntimeError`, `TimeoutError`, `TypeError`, `ZeroDivisionError`, `IndexError`; `pear/deploy/station/exceptions.py` (`OperatorPaused`) |
| `src/station/joint/clock.ts`, `numeric.ts` | Not in PEAR: the injected clock; numpy's `minimum`, `maximum`, `clip` and broadcasting, Python's `min`, `str`, `repr` of a text, an exactly rounded power |
| `src/station/schemas.ts` | `schemas.py`, the whole file |
| `src/so101/joint/feedforward.ts` | `robots/so101/joint/feedforward.py`: `GravityModel`, `SO101FrictionFeedforward`, `Feedforward` (it is the `Feedforward` that `src/so101/hardware/driver.ts` takes) |
| `src/so101/config.ts` (additions) | the dataclasses of `robots/so101/config.py` with their checks: `SO101LimitsSection`, `HardwareSection`, `CameraSection`, `KinematicsSection`, `SO101HomeSection`, `FeedforwardSection`, `SO101RobotConfig` (`jointLimits()`, `armLimits()`, `motionBlockers()`, `requireCommissioned()`, `firstPlaceholder()`) |
| `tools/fixtures/joint_fixtures.py` | writes `tests/fixtures/station-joint/*.json` from PEAR's own classes |

`src/` uses no Node API and no dependency (it needs `BigInt`, `DataView`, `structuredClone` and Unicode property
escapes in a regular expression).

## How it was verified

```bash
<work dir>/envs/station/bin/python tools/fixtures/joint_fixtures.py      # regenerate (CPU, under a minute)
npx vitest run tests/station-joint                                         # 10 files, 246 tests, all pass
npx tsc --noEmit                                                           # no error in these paths
```

Python 3.12.15, numpy 2.2.6, omegaconf 2.3.1, pinocchio 3.4.0, PEAR at `f32aa1f7`; Node 24. The script stops unless
the PEAR it runs in is a checkout at the pinned commit (it reads the stations of PEAR's own tests from it), replaces
PEAR's clock by one that only the script moves, and stops if a file would hold a path of the machine. Two runs gave
byte-identical files: 8 files, 1,987,953 bytes.

Stations PEAR's classes ran on: the SO-101's shipped defaults (`so101`), the SO-101 station of PEAR's tests as it is
(`so101_station`) and with the quick settings of PEAR's arm tests (`so101_quick`), and the two YAM arms of PEAR's tests
with the wide limits (`two_arm`) and as shipped (`two_arm_station`). The YAM robot is not ported: its station is
PEAR's own layout of two arms, on which PEAR's tests run the same generic classes; the tests here make a two-arm
`RobotConfig` from what every robot's settings hold.

| Fixture | Cases (committed) | Compared |
| --- | --- | --- |
| `layout.json` | 178 calls of every `JointLayout` method on both layouts (30 refused) | result, key order, class and message of a refusal |
| `limits.json` | 1,047 calls on four stations: `check_positions` 386 (224 refused), `check_command` 310 (177), `bounds` 68 (12), `check_trajectory` 137 (61), `motion_caps` 142 (32), `braking_caps` 4; 388 speed scales with Python's and the exact powers | exact (sign of zero included); each bound's edge was found by bisecting on PEAR's own answer down to two neighbouring doubles |
| `config.json` | 1,290 sections made with one or two values changed (600 refused), 170 SO-101 settings over the shipped defaults (124 refused), 136 distinct refusal messages; 19 `placeholder_key` calls; 37 wordings (`repr` of a text, `str` of a bound) | class and message of the refusal, or the derived values: joint limits, braking caps, motion blockers, first placeholder, `require_commissioned`, the settings read back in PEAR's order |
| `stability.json` | 54 scenarios of a `StabilityWindow` (33 named: every scenario of `test_stability_in_station.py` that needs no control loop, holds that keep moving, every kind of window selection; 21 generated), 2,366 steps; 14 `SampleWindow` sequences (295 steps); 22 `StabilityError` texts | after every step what it returned or raised; the window's metrics bit for bit after 853 steps (every step of a generated scenario) and its span and sample count after the rest |
| `tracking.json` | 379 calls of `check` and `arrival` on three stations, with the edge of every fault bound and arrival tolerance | exact |
| `snapshots.json` | `raise_for_fault` 16, `validate_snapshot` 122, `validate_reference` 44, `check_timeout` 18, vectors 3; `ArmState` 48 readings and 52 ages; `poll` 23 and `wait_ready` 28 scripted waits; 33 actions on a stand-in control loop through `ActionGuard` (187 steps) | results, refusals, the count and the length of every sleep, the guard's generation and dispatch flag after every step |
| `feedforward.json` | 30 constructions (16 refused); 34 sequences, 1,450 updates (the 8 of PEAR's tests, every malformed input for each class, 24 generated); 204 gravity torques; 8 sequences of 196 goal offsets | friction: bit for bit, with the state every twentieth step; gravity and offsets: see the measured differences |
| `meta.json` | the stations, layouts, constants, enumerations and TypedDict keys of `schemas.py`, error classes with their bases | equal |

Also tested without a fixture: the `Feedforward` inside `SO101Driver`; the clock adapter; the masses of the gravity
model against `assets/pear/so101/so101_new_calib.urdf` (parsed in the test, hash equal to the file PEAR loaded); a
promise-returning method through `ActionGuard.submit`.

### Measured differences (everything else is identical)

| What | Committed set | Larger set |
| --- | --- | --- |
| Motion caps | 3,012 caps identical | 18,438 identical, 3 one unit in the last place off |
| Python's `scale ** 2`, `** 3` against the exact power | 0 and 0 of 388 scales differ | 7 and 4 of 7,513 (0.09 %, 0.05 %), each by one unit in the last place |
| Gravity torque against pinocchio | largest 1.11e-15 N*m (largest torque 0.846) | largest 1.22e-15 N*m over 19,250 torques (largest torque 0.863); 317 identical |
| Goal offset | largest 1.94e-16 rad | largest 3.33e-16 rad over 2,509 offsets |

The tests accept 4e-15 N*m and rad for the last two rows (about 40 units in the last place of the largest torque) and
nothing for the rest.

### The larger run (not committed)

```bash
<work dir>/envs/station/bin/python tools/fixtures/joint_fixtures.py --scale 20 --output <directory>   # 14.1 MB
PEAR_JS_JOINT_FIXTURES=<directory> npx vitest run tests/station-joint                                    # 1,462 tests, all pass
```

5,228 limit calls, 453 stability scenarios (11,527 steps, metrics compared after 9,466), 280 sample-window sequences
(5,929 steps), 2,279 tracking calls, 289 polls, 294 waits, 413 guarded actions (2,845 steps), 490 friction sequences
(13,622 updates, bit for bit), 3,852 gravity vectors, 103 offset sequences. `PEAR_JS_JOINT_REPORT=1` prints the
measured numbers.

### The tests fail when the code is wrong

Each change was made alone, the suite run, and the file restored (checked by hash); 246 tests pass afterwards.

| Change | Failing tests of 246 |
| --- | --- |
| `JointLimits.EPSILON` 1e-9 → 1e-8 | 15 |
| `SampleWindow.add`: a reading stamped at the last one's time no longer restarts the window (`<=` → `<`) | 6 |
| `StabilityWindow`: the mean velocity keeps its sign (no `abs`) | 12 |
| `FrictionFeedforward`: fades at the engage rate | 24 |
| `ConfigSection.checkRange`: "at most" worded "no more than" | 8 |
| `SO101_MASSES`: the lower arm one gram heavier | 10 |
| `Tracking`: a gripper can fault | 6 |
| `ActionGuard.check`: a closed loop does not end the action | 1 |

### The kinematics' `JointLimits`

`check_positions` now exists twice: in `src/so101/kinematics/limits.ts` (stage 1) and in `src/station/joint/limits.ts`
(all of PEAR's class). The joint layer's class takes the kinematics' two uses unchanged (`new JointLimits(lower, upper,
tolerance)` and `JointLimits.fromConfig(settings)`), and `limits.test.ts` runs it on the kinematics' own fixtures. The
switch was rehearsed on a copy of the repository: with `src/so101/kinematics/limits.ts` reduced to
`export { JointLimits } from "../../station/joint/limits";`, `tsc` reports no error and the kinematics suite, the
modules test and this suite pass (17 files, 285 tests). Nothing in the kinematics module was edited.

## Not verified

- Only Node 24 (V8) ran the tests; no browser engine.
- The monitors were fed scripted snapshots and `ActionGuard` a stand-in control loop that holds only what the guard
  reads; no control loop exists yet. How the control loop uses them is the next round's to verify.
- OmegaConf is not ported. A value that is missing or of the wrong kind is refused in pear.js's own words
  (`ControlConfig.rate_hz is missing`) or by the range check; PEAR's message there is OmegaConf's.
- `RobotConfig.withPlaceholders` names a missing value inside a list `key[i]`; PEAR's key for that case was not
  compared (no setting of the SO-101 is one).
- The gravity model holds the masses of the shipped description only; another description goes in through the
  constructor (tested only for refusing masses that do not match the chain).
- `pythonStrRepr` beyond the 21 texts compared: which characters outside ASCII are printable follows the engine's
  Unicode version.
- `secondsClock()` on the page's own clock is only smoke-tested.

## Deliberate differences

1. **Time is injected, in seconds.** Every monitor takes a `MonotonicClock` (`monotonic()` in seconds,
   `sleep(seconds)`), by default `secondsClock()`, which reads the Feetech layer's `Clock` (milliseconds) divided by
   1000. Tests replay PEAR's readings on a `SteppedClock` holding seconds: 30 of the 2,328 times at which the
   committed scenarios read PEAR's clock (200 of 10,941 in the larger set) are no double of milliseconds over 1000.
2. **Waits and driver calls are asynchronous** (`SnapshotCheck.poll`, `waitReady`, `JointDriver`); PEAR's block.
3. **No lock.** `ActionGuard` takes none: between two awaits a page's code is indivisible. `submit` adopts the
   operation of a method that returns a promise when the promise resolves (not in PEAR; tested).
4. **A cancellation is `{ aborted: boolean }`**, which an `AbortSignal` is, where PEAR has a `threading.Event`.
5. **Configuration without OmegaConf or a file system.** A section's class takes plain settings under PEAR's keys
   and runs PEAR's `__post_init__` checks in PEAR's order. `KinematicsConfig.urdf`, `RELATIVE_PATH_KEYS` and the
   resolution of relative paths are absent. Whether a calibration exists is asked of `calibrationExists`, an option of
   `SO101RobotConfig`; without it none exists and the arm must not move. `SO101RobotConfig` reads a value left `???`
   as its placeholder itself, as `BaseRobot.make_configs` does before PEAR's class sees it.
6. **Names.** PEAR's `SO101Config`, `HardwareConfig`, ... are stage 1's interfaces of the plain settings, so the
   checked classes are `SO101RobotConfig` and `...Section`; a refusal still begins with PEAR's class name.
   `evaluate` takes `{ arms, durationS, targets, positionTolerance }`; `ArmState` has `sampledMonotonicS`,
   `sampleId`; `ActionFormat` has `environmentPrompt`, `actionModel` (a function), `resultFeedback`. What PEAR passes
   as a dictionary (a snapshot, feedback, metrics, a violation, fault details) keeps PEAR's keys and their order.
7. **The power of a speed scale is the exact one, rounded once.** PEAR's is its C library's `pow`, which is not
   always the nearest double (numbers above), and JavaScript's `**` differs between engines.
8. **The gravity model is a sum over the links' masses**, not pinocchio's recursion, and reads no description
   (numbers above). The masses are a constant checked against the description by a test.
9. **Errors.** A structure of the wrong shape (a missing arm, a missing key) is a JavaScript `TypeError`, where
   Python raises `KeyError` or `AttributeError`. numpy's own refusals that PEAR lets through are reproduced with
   numpy's messages: vectors of unequal length (`operands could not be broadcast together ...`), a missing tolerance
   (`'>' not supported between instances of 'float' and 'NoneType'`), a load that is None.
10. **`joint/device_lock.py` is not ported**: a lock file among the processes of a machine has no meaning in a page.
11. **`JointLimits` can be made from the bounds alone** (the kinematics' use); its motion caps are then empty lists.

## To reconcile with the other modules

- **Kinematics**: done since. `src/so101/kinematics/limits.ts` is the one-line re-export, so one `JointLimits`
  remains (`tests/modules.test.ts` holds the two names to one class).
- **Hardware**: `SO101ArmState` is an interface and `armFeedback()` a function, where the joint layer has the class
  `ArmState` with `check()` and `feedback()` (PEAR's `SO101ArmState` extends it and adds `servo`); `ArmFeedback`
  exists in `hardware/arm_state.ts` and in `schemas.ts`. `ServoFault` extends `Error`; PEAR's is a `RuntimeError`.
  `SO101Driver` fits `JointDriver` except that `read()` may return `null` for the arm. Its `PositionBounds` is a
  `JointLimits`, its `monotonic` option a `MonotonicClock.monotonic`, and `ARM` is defined twice. `HardwareSection`
  now checks what `SO101HardwareOptions` and `FollowerConfig` take unchecked.
- **Protocol**: `ActionFormat` and `Camera` (`schemas.ts`) describe what `FORMAT_NAME`, `SCHEMA`, `DECIMALS`,
  `CAMERA_NAMES`, `parseAction` and `executionFeedback` are for the SO-101; nothing builds one yet.
- **Python's wording, in three places**: `kinematics/text.ts` (`formatFixed`, `formatGeneral`, `formatTemplate`,
  `pythonRound`), `protocol/python_float.ts` (`pythonRound`, `pythonFloatRepr`), `station/joint/numeric.ts`
  (`pythonStr`, `pythonNumber`, `pythonStrRepr`). One module should hold them; this layer imports the first two.
- **Ruckig / trajectory**: `JointLimits.checkTrajectory` takes `{ positionExtrema: { min, max }[] }`; `motionCaps()`
  returns `[velocity[], acceleration[], jerk[]]`, `brakingCaps()` `[acceleration[], jerk[]]`, `bounds(start)`
  `[lower[], upper[]]`.
- **Shared files**: done since. `src/station/index.ts` gives `joint` and `schemas`, `src/so101/index.ts` gives
  `joint`, `src/index.ts` gives `station`; the module map of `docs/DESIGN.md` lists them. Still open:
  `OperatorPaused` is in `joint/errors.ts` and again in `src/agent/exceptions.ts`; PEAR has one, in
  `station/exceptions.py`.
- **Formatting**: no Python formatter is installed in the station environment and none was downloaded. The fixture
  script was wrapped to PEAR's 120 columns by a scratch tool that kept each wrap only if the file's syntax tree stayed
  the same, and the wrapped script writes the committed fixtures byte for byte; `ruff format` would lay some
  constructs out differently.

## Observations about PEAR worth knowing downstream

- `Tracking.check` does not fault on a reading that is NaN (`nan > bound` is false), while `arrival` counts it as
  not reached.
- `StabilityWindow.add` checks the arms one after another: a later arm's malformed feedback raises after the earlier
  arms' samples were added, and the window is not reset.
- `StabilityWindow.evaluate` with targets and no tolerance raises numpy's `TypeError`, but only once the window is
  complete; a target that is NaN is never a violation.
- `SampleWindow` tells a repeated reading by `sample_id`, or by the stamp when there is none: a reading without an
  id whose stamp equals the previous reading's id counts as a repeat (`5 == 5.0`).
- `raise_for_fault` raises for a snapshot that holds a fault text whatever its status (`Station fault: HOLD: ...`).
- `check_hold` counts the settle timeout from the first reading that was not stable, which includes the time the
  window needs to fill.
- `GravityModel.torque` ignores the gripper's opening (the jaw stays at its joint's zero), weighs the fingertip
  frame's link of 1e-9 kg, and a single value is taken for every joint (numpy broadcasts it).
- `SO101FrictionFeedforward.checked_values` accepts NaN and infinity, which the generic class refuses; the settings'
  own check catches them earlier.
- `SO101Limits.braking_caps` falls back to the move caps for an empty list as for None.
- `check_trajectory` checks as many coordinates as the trajectory has extrema: a shorter list is no error.
- A speed scale's caps depend on the C library's rounding of `pow` in the last place.

## Left

Nothing in this module's scope. For the next round: `joint/trajectory.py` (on the Ruckig port), `joint/operations.py`,
`joint/control_loop.py`, `joint/recovery.py`, the SO-101's `joint/grippers.py` and `joint/control_loop.py`, and with
them the reconciliation items above.
