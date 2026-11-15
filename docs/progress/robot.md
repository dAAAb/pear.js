# Progress: the motion layer and the robot (`src/station/motion`, `src/station/robot.ts`, `src/so101/robot.ts`)

State: **done, audited twice, and corrected after the second audit.** The third session (2026-11-15 17:21 to 18:40)
audited the draft and rewrote most of it. An independent reader then audited the layer as committed: verdict "yes,
with reservations", ten findings: no failure of the arm in anything it ran, but guards that no test pinned, calls
that can arrive inside a control period, and differences from PEAR that the list below did not state. "Round 4"
says what became of each finding. What is open is under "Left" and "Not verified". Paths below are under
`pear/deploy/station/control/` in PEAR unless they say otherwise.

## Report (third session)

**The audit of the draft.** Session 1 (15:35 to 16:07) wrote the fixture script and the fixtures; session 2 (16:07
to 16:43) wrote all the TypeScript and the tests. Found:

- Fixtures: a fresh run of the script gave four files byte for byte the committed ones. `missing.txt` was no
  fixture (the C library oracle's list of unanswered arguments, written by the draft's test); it is gone, and
  `libm.json` (2,810 values) is there in its place.
- Tests: `npx vitest run tests/station-robot` did not end (the session test awaited a robot that nothing stepped);
  the parts and action tests alone: 20 of 2,370 failed. What the draft compared against what is compared now:

  | Group (cases then, now) | The draft compared | Now |
  | --- | --- | --- |
  | `action_cases` 206, 208 | request and move, the duration within 1e-12; never what the kinematics were asked, nor a cause | the whole outcome and the kinematics' inputs, exact |
  | `home_cases` 261 | the plan without its key order; 2 failed | exact, key order and cause included |
  | `bounds_cases` 162 | two of five outcomes, on a move it rebuilt its own way; `home_move` never; 12 failed | all five outcomes |
  | `recheck` 48, 56; `estimate` 24 | on that wrongly rebuilt move; 4 failed | on the move PEAR built, exact |
  | `snapshot` 522, `build` 8 | record and report when PEAR returned; nothing when it raised; the log never | outcome, log, the error's own text |
  | `camera_cases` 11, 13 | none | every step |
  | action models 737, 743 | class, fields, key order, refusal text: exact (kept) | the same |
  | sessions 59, 66 | none ran | every step's whole record, exact |
  | agent rig 19 tasks | none (no capstone) | every piece, exact |

- Code. Kept and corrected: `actions.ts`, `planning.ts`, `results.ts` (station and SO-101). Rewritten from PEAR's
  files, because they were paraphrases with invented messages: `execution.ts`, `homing.ts` (both), both `robot.ts`,
  `so101/formats.ts`, both `cameras.ts`. Differences from PEAR fixed, each pinned by a fixture case: Home's move
  checked by the wrong class's bounds check; a plan's key order; a gripper reading of -0.0; a refused Home's cause;
  a target that is no number taken for unchanged; an invented error for a robot without a Home; a state that is no
  number dropped without PEAR's log; the cameras' error class and text; the wrist camera's checks; the format's
  action model; Home's stage words; and everything of execution, Home's flow and the robot.

**Final runs** (18:31, on the committed fixtures):

- `npx tsc --noEmit`: 0 errors.
- `npx vitest run tests/station-robot`: 5 files, 4,223 tests pass. With PEAR's kinematics' answers and the
  reference's C library values every number is the same double: parts 1,656 cases, 25,347 numbers; sessions 66 (28
  are the scenarios of PEAR's four test files), 1,510 steps, 10,445 control periods, 250,502 numbers; capstone 19
  tasks, 60 turns, 2,376 control periods, 26,005 numbers. On pear.js's own kinematics and the engine's functions
  (`engine.test.ts`): largest deviation 1.65e-12; 17 of 222 out-of-reach texts give another percentage, by 1 point.
- `npx vitest run`: 61 files pass, 1 skipped; 8,276 tests pass, 4 skipped. The agent's tests are unchanged.
- The larger run, once, not committed (`--scale 6`, 18:27, with the script as it was at 64 sessions): 2,876 part
  cases and 84 sessions (2,710 steps, 18,315 control periods), 537,359 numbers of parts and sessions all the same
  double; 6,697 of 6,699 tests pass. The two that fail are one finding of `engine.test.ts`: with pear.js's own
  solver one out-of-reach text of 289 is 6 percentage points from PEAR's (18 differ at all).

**The capstone and `AgentRobot`.** `AgentRobotAdapter` (`src/station/robot.ts`) hands the robot's observation to the
turn loop under camelCase names with JPEG bytes and gives the loop's observation back as the robot's own; every
other call goes straight through. `src/agent` and `src/protocol` changed in three re-exports only ("To reconcile").
(Both statements were corrected in Round 4: what the adapter hands back, and what changed outside this layer, are
under "How the robot serves `AgentRobot`".)

**Breaks** (`tests/station-robot/BREAKAGE.md`): 36, one at a time, in a copy under the scratch directory, each
restored with its hash compared. 32 caught. Not caught: two that change nothing, one that the SO-101's jaw cannot
reach, one that needs a control loop whose thread does not end. The first round caught 12 of 23; the fixture
script was given cases from PEAR for the rest.

**Found in the control loop:** nothing. No part, session or task differs.

**Not verified:** anything in real time (a running loop, a serial line, a page's camera: `makeDriver` and
`openCameras` of `SO101Robot` only compile); six of PEAR's messages that no recorded case reaches (listed below).

**Requests for the coordinator's files:** `docs/DESIGN.md` (module map, ladder step 4); `.gitignore`
(`tests/fixtures/*/missing.txt`); `GripperOutcome` is defined in two places; the kinematics' `quantities` does not
validate its result; `numeric.clip` is not numpy's `clip` for -0.0. Details under "To reconcile".

**Surprising in PEAR:** an action's own wait margins (`MOVE_MARGIN_S`) never decide while the loop steps: the loop
gives up first ("Motion remained unstable before timeout"). `SO101Homing.is_opened` can never be false.

## Plan (what goes where)

| pear.js | Ports |
| --- | --- |
| `src/station/motion/actions.ts` | `motion/actions.py`: `StrictModel`, `GripperQuantity`, `JointPositions`, `ActionAdapter`, and pydantic's refusal texts for them |
| `src/station/motion/results.ts` | `motion/results.py`: `MotionStatus`, `MotionResult` (`build`, `toRecord`); the home of what `src/protocol/types.ts` and `src/agent/robot.ts` give under their names |
| `src/station/motion/planning.ts` | `motion/planning.py`: `PreparedAction`, `HomePlanningError`, `HomePlanning` |
| `src/station/motion/execution.ts` | `motion/execution.py`: `Execution` |
| `src/station/motion/homing.ts` | `motion/homing.py`: `HomeFailed`, `HomeStage`, `Homing` |
| `src/station/robot.ts` | `robot.py`: `ActionMode`, `BaseRobot`; not in PEAR: `AgentRobotAdapter` |
| `src/station/cameras.ts` | `cameras.py`: `CameraSource`, `CameraFeed` |
| `src/so101/motion/actions.ts` | `robots/so101/motion/actions.py`: `ArmQuantities`, `ModelState`, `SingleArmDelta`, `GripperAction`, `JointPositions` |
| `src/so101/motion/planning.ts`, `homing.ts`, `results.ts` | `robots/so101/motion/planning.py`, `homing.py`, `results.py` |
| `src/so101/formats.ts` | `robots/so101/formats.py` |
| `src/so101/robot.ts` | `robots/so101/robot.py`: `SO101Robot` |
| `src/so101/hardware/cameras.ts` | `robots/so101/hardware/cameras.py`: `WristCamera` over a frame reader that is given to it |
| `tools/fixtures/robot_fixtures.py` | writes `tests/fixtures/station-robot/` from PEAR's own classes on PEAR's own rig |
| `tests/station-robot/` | `actions.test.ts`, `parts.test.ts` (on `parts_checks.ts`), `sessions.test.ts` and `capstone.test.ts` (on `rig.ts`), `engine.test.ts`, `fixtures.ts`, `BREAKAGE.md` |

## The fixtures

`tools/fixtures/robot_fixtures.py` (session 1's; changed in place since, never rewritten) refuses a PEAR that is not
at the pinned commit, takes `--output` and `--scale` (while working also `--only parts|sessions|agent` and
`--groups`), and writes, 746,031 bytes in all with `libm.json` (the numbers are those after Round 4):

- `parts.json.gz`: `checked_action` 208 cases (with every answer of PEAR's kinematics on the way), `delta_base` 108,
  `action_parts` 42, `checked_home` 313, `check_home_bounds` and `home_move` of both classes 192,
  `recheck_home_move` 56, `time_estimates` 24, `needs_opening` 96, `measured_positions` 7, the planning of Home on a
  robot without one 4; `from_snapshot` 522 with `to_record`, the report for both values of `is_dispatched` and the
  log, `MotionResult.build` 8, the report of 145 results no robot built; `ActionAdapter.validate` 929, the models
  themselves 287, 22 inputs with whole floats, PEAR's `isinstance` of a value of each of the six models against
  each model; 13 scripts of the wrist camera and the camera feed.
- `sessions.json.gz`: 73 sessions of PEAR's `SteppedStandInSO101Robot` on `StandInClock` (28 of them the SO-101
  scenarios of PEAR's four test files, 4 generated), 1,657 steps, 11,920 control periods.
- `agent_rig.json.gz`: the 19 tasks of `tools/fixtures/agent_fixtures.py` run again by that script's own classes
  with the rig recorded (below). The script stops unless the tasks come out as `tests/fixtures/agent/loop.json`
  holds them: they do.
- `meta.json`: the stations (11), the constants, the counts, the versions.
- `libm.json`: the reference C library's values that the exact comparison takes in the place of the engine's
  (`tests/ruckig/oracle.ts`), built by `tools/fixtures/ruckig_fixtures.py --libm tests/fixtures/station-robot` in
  rounds after each change of the fixtures: 2,918 values.

Changed in the script by the third session, each from what a break or a reading showed: one session's refused input
without whole floats; `recheck` cases with a target and a reading that are no number; `no_home_cases`; two action
cases with the arm off its command and the jaw on an object; three adapter and three model cases of a literal in a
list; two camera scripts (an age exactly at its bound, a camera that raises) with the operation `clock`; the stations
`so101_no_geometry` and `so101_no_camera`; two constants (a robot made with no action mode, a wrist camera without
settings); the arm's setting `velocity`, the camera's `read_raises` and `on_read`, the step `loop_recover`; and seven
sessions (the three added to "the wrist camera's frames" count as steps): "deadlines at their bound", "an arm that
never comes to rest", "Home approved late and paused", "Home with a joint exactly at its tolerance", "a sequence on
an arm that never comes to rest", "a station without geometry" and the same in joint mode.

Added in Round 4 for the guards of motion that no case decided (each from a break that failed nothing): the group
`of_guards`, seven sessions that come last, so that the 66 before them are written as they were: "Home with the arm
pushed while the jaw opens", "a dispatch on a hold that has not settled", "a hold that does not settle before a
dispatch", "a hold that does not settle before an action's deadline", "an action on a station that is held up",
"Home and a chunk with a caller that interferes", "Home with a settle window of its own and a jaw exactly at its
tolerance". For them a script can hold the station up for one long sleep (the step `stall`), have Home's approver
write into the plan it is handed (`approve.writes`), act during the report of a stage (`on_stage`, kept under
`stage_hooks`), and change settings of its station's robot for one session (`settings`); no station was added. In
the parts: 52 `checked_home` cases (the jaw on an object, the gripper's command against its reading, a held command
past a limit with the reading inside, a gripper command past an endpoint, a joint exactly at the move tolerance) and
30 bounds cases (an arm that rests further out than its command near a bound, a path checked from targets that are
not exactly its start, the move tolerance). For the action models: 428 adapter and 67 model cases (lists past their
maximum with bad items at each level, shown inputs around 50 bytes, a gripper's target at the ends of its range)
and the table of `isinstance`; they come after the old cases, which keep their numbers.

For whoever writes a session later: build a joint chunk from readings only where the arm has not been stopped in
a Cartesian move before. After such a stop, whether a joint that the chunk does not ask to move makes an excursion
of a few milliradians depends on the last bits of what the loop holds (run on PEAR itself with the rows moved by
1e-16 to 1e-10: PEAR's own trajectory generator moves the joint 2.67e-4 rad in the first period for some and not
for others). The port gives PEAR's numbers exactly given PEAR's bits; a comparison within a tolerance, which
`engine.test.ts` makes with pear.js's own kinematics, cannot hold there.

### What `tests/fixtures/agent/loop.json` lacks for a run with the real robot

The recorded tasks hold every call the loop made of the robot and every event, but not the rig under the robot. A
run with pear.js's own robot needs, and `agent_rig.json.gz` holds for every step:

- the UUIDs the robot drew that no call returned: of the observation an action takes itself before it moves the
  gripper (`run_prepared`), in the order of the robot's own `uuid4`;
- the answers of PEAR's kinematics (`joint_target`), so that the exact comparison is not a comparison of two solvers;
- the sleeps and the driver's calls at every control period, and the robot's status with its snapshot at the step's
  end;
- the station (`so101_station` of `meta.json`), and the one clock of all 19 tasks, which is never set back.

## Audit of the draft

### B.1 The fixtures

- 17:23 `tools/fixtures/robot_fixtures.py --output <scratch>/audit_a` in PEAR's station environment (the whole
  script, under a minute): `parts.json.gz`, `sessions.json.gz`, `agent_rig.json.gz` and `meta.json` byte for byte
  the committed files (sha256 of each file equal; the decompressed contents equal too: 1,648,532, 4,289,980 and
  410,184 bytes of JSON). The run printed the counts of session 1's last run (its log is in the scratch
  directory): 2,377 cases of the parts in 16 groups, 59 sessions, 19 tasks. The PEAR tree is at the pinned commit
  with no local change.
- `tests/fixtures/station-robot/missing.txt` was not a fixture. `tests/ruckig/oracle.ts` writes it (`close()`): the
  arguments of the C library functions (`cbrt`, `sincos`, `acos`: 1,536 lines) that a test asked of a table
  `libm.json` beside the fixtures, which this directory did not have. The draft's `parts.test.ts` installed the
  oracle on this directory, so every one of its runs took the engine's own functions and wrote the list again. The
  list is the input of `tools/fixtures/ruckig_fixtures.py --libm <directory>`, which adds the reference C library's
  values to `libm.json` and removes the list. `missing.txt` does not belong in the repository; `libm.json` does.

### B.2 The strength of the draft's tests

- 17:25 `npx vitest run tests/station-robot` as the draft left it did not end: `sessions.test.ts` awaited a robot
  that nothing stepped, 30 s a session. Run alone, `parts.test.ts` and `actions.test.ts`: 2,370 tests, **20 failed**
  (`checkHomeBounds` 12, `timeEstimates` 4, `checkedHome` 2, `checkedAction` 1, `measuredPositions` 1). The draft's
  "~2200 parts tests pass" did not hold.
- What the draft's `parts.test.ts` did not compare: any camera case (11 scripts); `home_move` and
  `generic_home_move` of the 162 bounds cases; a case whose recorded outcome is an error, in `fromSnapshot`,
  `MotionResult.build` and the feedback cases (it passed without a comparison); the `log` of the 530 result cases;
  what the kinematics were asked (`ik[].joints`, `ik[].delta`: the answers were played back whatever was asked);
  the `cause` of an error and `is_value_error` when false; a move's duration as the same double (it allowed 1e-12;
  the engine's functions are up to 1.65e-12 off, so the exact comparison needs the C library table); the plan's key
  order; the format's own `resultFeedback`. It rebuilt moves with `new JointMove` and the station's Home caps where
  the fixture built them with `JointMove.build` and the spec's caps (16 of its 20 failures were in the two groups
  that used such moves; the cause of each was not traced, since the test was replaced).
- `sessions.test.ts` compared, of a step, `out` and the clock within 1e-6, on a robot that could not open. No
  session ran. `rig.ts` was its unfinished player. There was no capstone.
- The table of what is compared now is in the report above. One comparison is used everywhere
  (`tests/station-loop/compare.ts`, exact mode): the same double with the sign of a zero, the same text, the same
  keys in PEAR's order.

### B.3 The code beside PEAR's

Kept and corrected: `station/motion/actions.ts`, `so101/motion/actions.ts`, `station/motion/planning.ts`,
`so101/motion/planning.ts`, `station/motion/results.ts`, `so101/motion/results.ts`.

Not ports, rewritten from PEAR's files (the draft's text was a paraphrase: invented messages such as "Robot is not
open", "Home not approved", "Sequence did not finish", "Action deadline expired"; an `open` that made no control
loop; a `status` that was one word; no session or observation checks; `execute` without validation, deadline,
observation or the result of a failure): `station/motion/execution.ts`, `station/motion/homing.ts`,
`station/robot.ts`, `so101/motion/homing.ts`, `so101/robot.ts`, `so101/formats.ts`, `so101/hardware/cameras.ts`,
`station/cameras.ts`. Of the tests: `parts.test.ts`, `sessions.test.ts`, `rig.ts` and `BREAKAGE.md` rewritten in
place; `actions.test.ts` and `fixtures.ts` kept and extended; `parts_checks.ts`, `capstone.test.ts` and
`engine.test.ts` new.

### Differences from PEAR found in the draft and fixed

1. `HomePlanning.homeMove` called `HomePlanning.checkHomeBounds` whatever class it was called on, and
   `SO101Planning.checkedHome` called `HomePlanning.homeMove`: PEAR's are class methods that call through `cls`, so
   the SO-101's Home is checked by the SO-101's own bounds check ("Home path leaves the joint bounds"). Pinned by
   `bounds_cases` (`home_move` against `generic_home_move`) and `home_cases`.
2. A Home plan's keys were not in PEAR's order. Pinned by `home_cases`.
3. `HomePlanning.measuredPositions` turned a gripper reading of `-0.0` into `0.0`; numpy's `clip` keeps `-0.0`
   (numpy 2.2.6, measured). Pinned by `measured_cases` 6.
4. `HomePlanningError` of a refused Home move had no cause (PEAR: `raise ... from error`). Pinned by the cause of
   the 97 recorded errors of the first `parts.json.gz` that have one.
5. `recheckHomeMove` took a target that is no number for close to the approved one; numpy's `allclose` does not.
   Pinned by the `recheck_cases` added for it.
6. `homeMove`, `timeEstimates` and `checkedHome` threw an invented `ValueError("No home pose configured")` for a
   robot without a Home; PEAR's read an attribute of `None` (`AttributeError`). Pinned by `no_home_cases`.
7. `MotionResult.build` dropped a state that held a number that is not finite, silently; PEAR's kinematics end with
   `ModelState.model_validate`, which raises, and `build` logs "The measured joints have no model state". The
   validation is `modelStateOf` (`so101/motion/actions.ts`), the log is the `log` option. Pinned by the `log` of
   `snapshot_cases` and `build_cases`.
8. `CameraSource.read` threw `Error` with the roles' errors as JSON; PEAR raises `RuntimeError` with Python's `repr`
   of the dict (`{'wrist': 'Camera frame is stale'}`). Pinned by `camera_cases` and the wrist camera's session.
9. `WristCamera` had none of PEAR's checks. Pinned by `camera_cases`.
10. The format's `actionModel` was a validator of its own; it is `SingleArmDelta`'s. Pinned by `actions.test.ts`.
11. Home's stages were "Checking", "Opening grippers", ...; PEAR's are `checking`, `opening`, `homing`,
    `completed`. Pinned by `meta.json`'s constants and the sessions.
12. `execution.ts`, `homing.ts`, `station/robot.ts`, `so101/robot.ts`, `so101/motion/homing.ts`: every message and
    every step. Pinned by the sessions and the capstone.

### B.4 The breaks

`tests/station-robot/BREAKAGE.md` has the table: 36 breaks in 13 files, 32 caught, and why four are not.

## How the robot serves `AgentRobot`; what changed in `src/agent` and `src/protocol`

The station's API is PEAR's (PEAR's names in camelCase; PEAR's dictionaries under PEAR's keys in what is recorded:
results, snapshots, observations, plans). `AgentRobotAdapter` (`src/station/robot.ts`, not in PEAR) is the robot as
the turn loop drives it: `new AgentRobotAdapter(robot, encodeFrame)`. An observation the robot returns is handed on
under the loop's camelCase names with each frame encoded by `encodeFrame` (a page: JPEG at quality 90). One the
loop hands back goes to the robot as PEAR's dictionary of the values the loop's object holds then: the robot reads
them at every check, and gets its own frames and their stamps back when this adapter issued the observation (the
loop holds the encoded ones). Every other call goes to the robot's method of the same name. A progress handler's
return value goes back to the robot, which waits for it (PEAR's handler blocks the action's thread).

What a page that holds a robot must know (each is PEAR's behaviour too; Round 4 pins them):

- **An observation is not protected from its holder.** PEAR's is a plain dictionary whose joint vector is a
  writable array, and PEAR's robot checks and plans from whatever it is handed back. So does this robot, directly
  and through the adapter: an observation whose session or generation was changed is refused, one whose joints were
  changed (in place, or in a copy) is accepted when they are finite and six, and the arm then goes where the plan
  from those joints leads, within the joint bounds. Only the three tuples of the control snapshot refuse a write.
- **A rejected `close()` does not mean "still open".** When `close()` arrives while an action is under way it can
  reject with "Action cancelled by stop or another operation" and has closed the arm all the same: the robot is
  OFF, the driver closed, the torque off, and every later call says "Open the station first".
- **A progress handler or an approval that never settles keeps the robot taken for good** (deliberate difference
  4).

Changes outside this layer's own files: three files (`git diff --stat` against the commit before the layer: 23
insertions, 68 deletions; `tests/agent` and `tests/protocol` unchanged). They are more than renamings:

| Name | Before | Now | What changed |
| --- | --- | --- | --- |
| `SINGLE_ARM_POSE_FORMAT` (`src/agent/formats.ts`) | an object of 5 fields made there | the object of `src/so101/formats.ts` | the value has 4 more fields (`schema`, `environmentPrompt`, `decimals`, `actionModel`); the declared type is the same |
| `WRIST_CAMERA` (`src/agent/formats.ts`) | a plain object | the SO-101's | the value is equal and is now frozen |
| `ActionMode` (`src/agent/robot.ts`) | defined there | re-exported from `src/station/robot.ts` | the same two words |
| `resultRecord` (`src/agent/robot.ts`) | a function | a constant: the function of `src/station/motion/results.ts` under a cast | the same keys in the same order |
| `MotionStatus`, `MotionError` (`src/protocol/types.ts`) | defined there | re-exported from `src/station/motion/results.ts` | the same |
| `MotionResult` (`src/protocol/types.ts`) | an interface | an alias of `MotionResultFields<ModelState, GripperOutcome>` | the same fields; no longer an interface |

Beyond names, the modules now load this layer at run time: `src/protocol/types.ts` loads
`src/station/motion/results.ts` (which loads `snapshot_checks.ts`), `src/agent/robot.ts` loads
`src/station/robot.ts` and `results.ts`, and `src/agent/formats.ts` loads `src/so101/formats.ts` with the SO-101's
kinematics and cameras. Also changed: the lines for the new modules in `src/station/index.ts`,
`src/so101/index.ts`, `src/so101/hardware/index.ts`.

## How it was verified

Log, one line a step (times are the machine's clock; newest last):

- 16:04 (session 1) the fixture script ran in PEAR's station environment: 2,496 cases, 59 sessions, 19 tasks; the
  19 tasks equal the committed `tests/fixtures/agent/loop.json` value for value.
- 17:23 to 17:40 the audit's readings and first runs (B.1, B.2, B.3 above).
- 17:47 the eight files rewritten from PEAR's and the six kept ones corrected; `npx tsc --noEmit` passes.
- 17:52 `parts.test.ts` rewritten on `parts_checks.ts`. 2,387 tests pass with `actions.test.ts`; parts: 1,640 cases,
  0 differ, 25,222 numbers all the same double; `libm.json` built in 2 rounds (1,538 values). Before the table 11
  cases differed (10 of `checked_action`, which pass with the table's values, and difference 3 above).
- 17:57 `rig.ts` rewritten (PEAR's stepped rig: the recording clock, the SO-101's loop without a thread, the stand-in
  robot on the control loop's tests' stand-in arm, PEAR's own UUIDs and kinematics answers fed from each step's
  record, a player that rebuilds every field of a step) and `sessions.test.ts` on it. First run: 53 of 59 sessions
  equal; after two more rounds of `libm.json` 58 of 59; the last differed in one text, a refusal that shows its
  input with floats of a whole value, which JavaScript cannot tell from ints: the script gives 0.5 there now.
- 18:02 fixtures written again from PEAR (first into the scratch directory, then into the repository: byte for byte
  the same): 59 sessions, 1,381 steps, 9,644 control periods, 0 differ, 233,965 numbers all the same double.
- 18:06 the capstone: first run, every task equal: 19 tasks, 60 turns, 104 of 104 pieces of the rig, 2,376 of 2,376
  control periods, 26,005 numbers all the same double.
- 18:10 `engine.test.ts`: 1,713 tests pass (numbers below).
- 18:15 first round of breaks (23): 12 caught. 18:17 to 18:31 the fixture script given cases for the rest, the
  fixtures written again four times (each time twice, the two runs byte for byte the same), the tests run again.
- 18:24 to 18:26 the breaks of `BREAKAGE.md` (36, on the fixtures of 64 sessions): 32 caught, 36 of 36 restored
  with equal hashes.
- 18:27 the larger run: `robot_fixtures.py --scale 6 --output <scratch>/scale6` (1,156,652 bytes: 2,876 part cases,
  84 sessions; its `libm.json` in 7 rounds, 7,963 values), `PEAR_JS_ROBOT_FIXTURES=<scratch>/scale6 npx vitest run
  tests/station-robot`: 6,697 of 6,699 tests pass. Exact: parts 60,240 numbers, sessions 2,710 steps, 18,315
  control periods, 477,119 numbers, capstone as committed: all the same double. Engine mode: parts 97.286 % the
  same double, largest 1.65e-12; sessions 70.868 %, largest 8.55e-13; of 289 out-of-reach texts of the parts 18
  give another percentage and one of them is 6 points from PEAR's, which fails that case and the summary test (the
  bound is 3 points). The run's directory was removed afterwards.
- 18:31 the final runs, on the committed fixtures (66 sessions), after one more run of the script into the scratch
  directory gave the committed files byte for byte:
  - `npx tsc --noEmit`: 0 errors.
  - `npx vitest run tests/station-robot`: 5 files, 4,223 tests pass (1.6 s): `actions` 747, `parts` 1,663,
    `sessions` 68, `capstone` 21, `engine` 1,724. Parts: 1,656 cases, 25,347 numbers all the same double. Sessions:
    66, 1,510 of 1,510 steps, 10,445 of 10,445 control periods, 250,502 numbers all the same double. Capstone: 19
    tasks, 60 turns, 104 pieces, 2,376 control periods, 26,005 numbers all the same double. `libm.json`: 2,810
    values, 0 arguments missing in any of the three files that use it.
  - `engine.test.ts`, within 1e-9: parts 23,399 numbers, 97.491 % the same double, largest deviation 1.65e-12 (a
    move's duration), 146 out-of-reach texts of which 5 give another percentage, by 1 point; sessions 250,502
    numbers, 72.728 % the same double, largest 8.55e-13 (a commanded position), 76 out-of-reach texts of which 12
    give another percentage, by 1 point, and 3 texts that show numbers within the tolerance. Steps, control
    periods, driver calls, classes and every other text are PEAR's.
  - `npx vitest run`: 61 files pass, 1 skipped; 8,276 tests pass, 4 skipped (20 s).

## Found in the control loop

Nothing. With the control loop as it was between 17:57 and 18:31, no part, session or task differs from PEAR's in
any control period.

## Round 4 (after the independent audit)

An independent reader audited the layer as it was committed: the code beside PEAR's, 225 deliberate breaks (58
failed no test), and scenarios of its own on the stepped rig and with a ticker. Its verdict: "yes, with
reservations". Its ten findings, and what became of each:

| | Finding | What it is | What became of it |
| --- | --- | --- | --- |
| 1 | a check or a submission of the robot can fall inside a control period, which PEAR's lock forbids | a difference this note did not state; no failure in the audit's 1,200 schedules | deliberate difference 3 says both halves; run and pinned on the robot's side ("By hand") |
| 2 | guards of motion that the port has and no test pins | test gaps | "PEAR's records for the guards of motion" |
| 3 | `actions.ts`: a list that is too long and holds a bad item gives another refusal text than PEAR | a difference of logic | "Refusal texts of the action models" |
| 4 | `actions.ts`: the shown input cut at 50 characters, not 50 bytes; keys that read as an index come first | differences | the same section |
| 5 | an observation handed back with other measured joints is accepted and moves the arm elsewhere | equal to PEAR | run on PEAR and pinned; through the adapter one defect was found and fixed ("By hand") |
| 6 | planning holds the page's one thread | real time | deliberate difference 16; "Not verified"; "Left" |
| 7 | `AgentRobotAdapter`: what no test reaches | test gaps | the observation it hands back: "By hand"; the rest (the cancellation of `waitStationary`, the frame encoder, the snapshot of `failureResult`): "Left" |
| 8 | a handler or an approval that never settles keeps the robot taken for good | equal to PEAR, easier on a page | deliberate difference 4; what a handler can do was run on PEAR and pinned ("By hand") |
| 9 | `close()` during an action can reject although it has closed the arm | equal to PEAR by reading | deliberate difference 15; pinned ("By hand") |
| 10 | statements of this note that did not hold | | corrected: "State", "Left", "Deliberate differences", the re-exports, `BREAKAGE.md` |

### By hand

What PEAR's records cannot hold is tested by expectations written by hand, in the manner of
`tests/station-loop/readers.test.ts`: `tests/station-robot/by_hand.ts` builds the robot on the stepped rig without a
recorded session (pear.js's own kinematics), and has the ticker.

**An observation handed back** (`observation.test.ts`, 34 tests). The audit's finding 5 and its part F asked
whether a page that writes into an observation it holds can change what is checked or where the arm goes. What an
observation is in PEAR (`schemas.py:141-150`, `robot.py:281-309`, `joint/snapshot_checks.py:95-105, 125-128`): a
plain `dict`; `joint_positions` a new numpy array at every `observe`, writable; of every container under it only
`control_snapshot.targets.<arm>` and the `position` and `velocity` of `control_snapshot.arms.<arm>` are tuples (a
write: `TypeError: 'tuple' object does not support item assignment`). PEAR's robot reads the dictionary it is
handed at every check. Run on PEAR's own robot on its stepped rig (station `so101_quick`, opened and at rest, an
action of z +0.02 m from the observation):

| What the holder did to the observation | PEAR's `is_holding` and `wait_stationary` | PEAR's action | Joint 1 after |
| --- | --- | --- | --- |
| nothing, or handed back a copy | True; returns | completed | 0.0001 |
| `session_id` changed in place | ValueError: Observation belongs to a different station session | rejected with it | 0.0000 |
| the snapshot's `generation` changed in place, or the snapshot replaced by a copy of another generation | ValueError: Observation invalidated by another operation | rejected with it | 0.0000 |
| a copy with joint 1 changed by 0.3 rad | True; returns | completed | 0.2995 |
| joint 1 changed in place by 0.3 rad | True; returns | completed | 0.2995 |
| joint 1 made NaN in place, or the joints replaced by a list of five | ValueError: Invalid observation reference | rejected with it | 0.0000 |
| written when the action reports "Executing": the joints replaced or made NaN, the generation changed, the snapshot replaced | | rejected with the same messages | 0.0000 |
| written then: `session_id` changed in place | | completed (the dispatch asks no session) | 0.0001 |

So PEAR does not protect an observation from its holder, and neither does the port: nothing is frozen beyond the
loop's three tuples, and no frame is copied. The base robot already did all of the above. `AgentRobotAdapter` did
not: it recognised an observation it had issued by the identity of the loop's object and handed the robot a record
kept aside, so the loop's object with its `sessionId` changed in place completed an action that PEAR rejects, and
one whose `jointPositions` or `controlSnapshot` had been replaced was planned from the old values. Now
`stationObservation` hands the robot a view of the loop's object, read at every check; the record kept aside
serves only to give the robot its own frames and their stamps back. The tests: the containers of an observation
are PEAR's, path by path; a write into each tuple throws a TypeError; the joint vector is the observation's own
and the frames are the cameras' own objects; every row above with PEAR's status, error and joint 1 to four
decimals, on the robot and through the adapter (14 rows each).

**The robot while control periods are under way** (`periods.test.ts`, 7 tests, 2.1 s). The ticker of `by_hand.ts`
starts the control periods as a page's timer does, every call of the driver takes 0 to 5 turns of the event loop,
and whoever sleeps is woken while a period is under way. The script: a move with a closing, an opening, two moves,
Home. Each schedule is one seed (1 to N):

| | Schedules | Result |
| --- | --- | --- |
| the script alone | 200 | all end as the stepped rig does: the same results, Home reached, no fault, the final pose equal to the last bit. 481 of 1,400 submissions (34 %) began an operation inside a control period |
| a stop right after the start of period 1 + (seed mod 60) | 120 | the action under way fails ("Action cancelled by stop or another operation"; the first in 107, the second in 13), the others complete, Home is reached, no fault; the final pose within 2.2e-16 of the stepped rig's |
| the first action's cancellation at that period | 120 | it fails ("Operation interrupted by the operator") in 107; in 13 it had ended; otherwise as above |
| `close()` at period 1 + (seed mod 90) | 180 | the action under way fails in all, every later call says "Open the station first", the robot is OFF, and the driver is not called once after `close()` has ended; `close()` returned in 171 and rejected in 9 |

By hand, with one control period held at the arm's reading: a stop and then an action called meanwhile both wait
for the period, the stop runs first and the action, bound to the operation after it, completes; a check and a
gripper's submission made meanwhile run at once, the operation begins inside the period and the period sends its
first command itself. The audit's break R21 (the guard made at once although a period is under way), which failed
no test, fails the first of the two.

**A handler and an approval that take their time** (`handlers.test.ts`, 23 tests). No record of PEAR has a
handler that does anything. Run on PEAR's own robot on its stepped rig (an action of z +0.02 m on `so101_quick`;
Home on `so101_quick_home` after an action of z +0.05 m), with a handler that sleeps control periods, raises,
stops the robot, sets the cancellation or calls the robot again:

| The handler or the approval | PEAR |
| --- | --- |
| an action's handler sleeps three control periods at each phase | completed; HOLD and no command while it sleeps; 10 commands after |
| raises at Planning, or at Executing | failed: RuntimeError with its message; no command |
| stops the robot at Planning | rejected: ValueError: Observation invalidated by another operation; not asked again |
| sets the cancellation at Planning | failed: OperatorPaused: Operation interrupted by the operator; not asked again |
| stops the robot at Executing; sets the cancellation at Executing | failed: RuntimeError: Action cancelled by stop or another operation; failed: OperatorPaused |
| calls `execute`, `home` and `recover` again | each raises RuntimeError: A station action is already running; the action completes |
| Home's approval sleeps three control periods | reached; HOLD and no command meanwhile; 12 commands after |
| raises; stops the robot and approves; sets the cancellation and approves | HomeFailed with its message; HomeFailed: Action cancelled by stop or another operation; OperatorPaused: Operation interrupted by the operator; no command in any |
| calls the robot again and approves | each call refused as above; Home is reached |
| Home's stage handler sleeps two control periods at each stage; raises at its second stage | reached, the stages checking, checking, homing, completed, each in HOLD; HomeFailed with its message |

pear.js gives every row, with a handler that returns a promise and, for a failure, with one that throws. By PEAR's
order of statements and not by a run: a cancellation set while the cameras are read for the action's observation
ends the action before its handler is asked at all, and one set while Home reads the cameras ends Home before the
approval is asked. What PEAR's one thread cannot do: a handler or an approval that never settles (a stop returns,
nothing is commanded, every later `execute`, `home` and `recover` throws "A station action is already running",
also in a new session after `close()` and `open()`; the first call never returns), and a stop or a cancellation
that comes from outside while a handler or an approval is pending (the action or Home fails once it settles, with
nothing commanded).

**`close()` during an action** (`close.test.ts`, 2 tests). The close is called right after a control period of
the arm's move and not awaited. When the action comes to its next check while the arm still brakes, `close()`
returns. When it comes to it only after the brake has ended, its failure path's stop lands in the HOLD that the
shutdown waits in, and `close()` rejects with "Action cancelled by stop or another operation". In both the action
fails (it never rejects), the robot is OFF, its session is gone, the loop CLOSED, the driver's last call is its
one `close`, every later call throws "Open the station first" without a call of the driver, and a new session
opens. PEAR's side is its code as read (the audit's finding 9): its stepped rig has one thread.

**Breaks** (each alone, in a scratch copy, against `tests/station-robot`; the file restored and its hash compared;
in brackets how many tests fail, all of them in the new files). The observation: the session, the joints or the
snapshot read from the record kept aside (1, 2, 2); no record kept aside, which is `BREAKAGE.md`'s break 12 (1);
the loop's object copied when it is handed back (2); the robot's joint vector frozen (9) or the loop's object
frozen (7), each more immutable than PEAR. The periods: the audit's R21 (1). The handlers, by the audit's names:
H11, Home's stage handler not awaited (2); R12b, the action's handler not awaited at Executing (6); R05 and R06,
the guard's check before each report removed (1 each); H02, the check before the approval removed (1). The
close: the session forgotten only when the shutdown returned (2); the driver closed only when the shutdown's wait
returned (2). None of the fifteen was noticed by a test that existed before; the audit had found R21, H11, R12b,
R05, R06 and H02 to fail nothing.

**Counts.** The four files of this part add 66 tests (`observation` 34, `periods` 7, `handlers` 23, `close` 2), of
which `periods.test.ts` takes about 2 s.

### PEAR's records for the guards of motion

No new record showed a difference between the port and PEAR: the seven new sessions and the 82 new cases (listed
under "The fixtures") replay to the last bit, and no source file changed. What they decide, by the audit's names
of its breaks (each made alone again; the test that fails is in brackets):

- **Home is checked again once the gripper has opened** (H05, SH4): session 67, the arm pushed 0.02 rad towards a
  bound while the jaw opens: PEAR opens the jaw and refuses at the second "checking" ("Home path leaves the joint
  bounds"), no move sent; pushed the other way, Home completes.
- **A dispatch on a HOLD that has not settled** (E01, E05, H19, E14, E15, R23): sessions 68 to 70. PEAR defers a
  move, a chunk and Home's move until the HOLD has settled again; with a deadline that passes meanwhile it ends
  with "No stable window before dispatch; no new command sent" (an action's first wait: "Station did not pass the
  continuous stability window"); without one the loop faults first ("Persistent motion during HOLD").
- **Home's bounds check** (S18, S10, S17, S05, S04, S20, P16, S23, P15): `home_cases` 261 to 312 and ten more
  `bounds_cases` a station; each of the four conditions of "Home path leaves the joint bounds" is decided by a case
  (an arm that sags below its command near a lower bound among them).
- **Deadlines of waits** (H22, E02, E11, E20): session 69's Home at Home, and session 71, a station held up for one
  long sleep inside a wait. The limits of an action's own waits are pinned from below only (the wait does not give
  up earlier than PEAR's); a limit longer than PEAR's is seen by no test, because the loop ends the operation
  first.
- **A caller that interferes** (H04, H10, E04, H12, P05, H23, H15): sessions 72 and 73: an approver that writes
  into the plan it is handed, a stop and a pause during the report of the last stage, a pause during a chunk, a
  settle window of Home's own, a timeout of exactly the plan's estimate, a jaw exactly at its tolerance.

Not reached by a session: "Home target changed; check and confirm again" (the SO-101's held targets change only
through an operation that the guard refuses first; `recheck_cases` hold the text), and the wait before a dispatch
ended by the settle timeout itself (on the stepped clock the loop faults one control period earlier).

### Refusal texts of the action models

Three differences of text in what `ActionAdapter.validate` and the models refuse, found by the audit on 6,183
actions of its own against PEAR's pydantic (18,549 validations; what is accepted, the values and the error's class
were PEAR's in all of them):

- **A list past its maximum.** pydantic-core counts an item of a list once it is validated, valid or not; the
  first one past the maximum ends the list's validation with the one error `too_long`, which names the length of
  the whole list and takes the place of the errors of the items before it. A row that is too long is one error of
  the rows, which go on. `actions.ts` reported the items' errors and `too_long` only of a list with none (38 of the
  18,549). Fixed; pinned by the `too long: ...` cases (49 adapter, 40 model).
- **The input a refusal shows.** pydantic-core measures the repr in UTF-8 bytes: one of at most 50 is shown whole,
  a longer one as its first 25 bytes, `...` and its last 24, each less the bytes of a character its cut would
  split. `actions.ts` counted characters (12 of the 18,549: every long input with a character outside ASCII).
  Fixed; pinned by the `shown input: ...` cases (352), the rule itself against PEAR on 53,566 random inputs.
- **A key that reads as an array index comes first**: not fixed, because JavaScript cannot hold the order:
  deliberate difference 17.

Also recorded now: a gripper's target of `0.0`, `-0.0`, `0`, `1.0`, `1` and the nearest floats inside, which PEAR
takes, and the nearest floats outside, which it refuses (`chunk grippers: at the bounds`, 27 adapter and 27 model
cases); PEAR's `isinstance` of each model's value against each model (`instance_cases`).

After the fix, on the audit's 18,549 validations: 18,023 are PEAR's text; the 526 others are the two causes that
JavaScript cannot avoid (336 a whole float shown as an int, deliberate difference 8; 190 index-like keys first),
and each of them is, to the character, what PEAR gives for the action as JavaScript holds it. On 990 fuzzed
actions with a list past its maximum and 4,000 with shown inputs around the limit: no difference.

None of these texts can come from a model's answer through the turn loop: `parseAction` (`src/protocol`) builds
the action from exactly the format's quantities, each a finite number, and refuses everything else with texts of
its own. They are what a page gets that calls the robot with an action it made itself.

### The audit's breaks, run again

The audit's 225 breaks, each alone, on the merged state against `tests/station-robot` (4,966 tests; every file
restored): 4 could not be made, because the lines they change were rewritten (A05, A22 and A24 in `actions.ts`,
which were made again on the new lines and fail a test there, as do 16 further breaks of those lines; the
adapter's R54); of the other 221, **200 fail a test and 21 fail nothing** (in the audit: 167 and 58). No break that
the audit saw noticed went unnoticed. The two files as they were before their fixes fail the new tests: the old
`actions.ts` 359 of them, the old adapter 5. Of the 58:

- 36 fail a test now: 28 of the 35 that would change what a real arm or an operator gets, and 8 of the 14 that
  show only at an exact bound or in a refusal's order.
- 21 still fail nothing: the nine for which nothing can differ in the port (E07, E09, H25, R07, R20, R25, B08, E03,
  H21: the same check follows with no wait between, or the guard raises first); six at a bound or in an order
  (R34, R41, R42, B20, SH2, SH3); and six that a real arm or an operator would notice, all in the adapter and the
  cameras: R49, R51, R53, C02, C04, W06 ("Left").
- 1 is gone (R54); the breaks of the rewritten `stationObservation` are under "By hand".

**Counts after Round 4.** `tests/station-robot`: 9 files, 4,966 tests in about 3 s (before the audit: 5 files,
4,223): `actions` 1,246, `parts` 1,745, `sessions` 75, `capstone` 21, `engine` 1,813, `observation` 34,
`handlers` 23, `periods` 7, `close` 2. Of them 3,053 compare with PEAR's record exactly, 1,811 with pear.js's own
kinematics within 1e-9, 22 with PEAR's answer to the input as JavaScript holds it, 12 are bookkeeping and 68 are
written by hand (most of them from a run of PEAR by a script). The whole suite: 68 files pass, 1 skipped; 9,076
tests pass, 4 skipped. `npx tsc --noEmit`: 0 errors.

## Not verified

- **Real time.** Every session of the fixtures runs on the stepped rig, where the loop steps only inside a sleep.
  Calls of the robot that arrive while a control period is under way are run by Round 4's `periods.test.ts` for one
  script of actions with a Home (a ticker starts the periods; a stop, a cancellation or a close at a period), and
  by the control loop's own interleaving tests on the loop's side. Not run by either: a fault of the arm, a
  recovery or a joint chunk while control periods are under way; the robot on a loop that runs on a page's timers;
  `SO101Robot.makeDriver` on a real line (`SO101Driver.fromConfig`) and `openCameras` on a page's frame reader
  (they compile; their two own messages have no test).
- **PEAR's side of two interleavings**, which PEAR's stepped rig cannot make with its one thread: a `close()` that
  rejects during an action (equal to PEAR by reading), and a handler that never returns.
- **How long planning holds the page's one thread on a slow device** (the audit measured at most 8.0 ms of a 20 ms
  control period for a request out of reach, in node on its machine). PEAR plans in the caller's thread while its
  control thread goes on; here no control period can start during a plan.
- **PEAR's messages that no recorded case reaches** (of 32 in this layer's files, looked for in every fixture):
  "Sequence interrupted: ..." and "Home move was interrupted" (an operation that ends otherwise than finished while
  the action's guard still holds: a stop makes the guard raise first); "Home opening did not complete; no arm move
  dispatched" (unreachable with the SO-101's jaw); "Station session changed during validation" (needs a second
  thread; it cannot happen here, where the check runs without a wait). Reached since Round 4: "No stable window
  before dispatch; no new command sent" and "Station did not pass the continuous stability window", both by an
  action's deadline (sessions 69 and 70); without a deadline the loop still faults first ("Persistent motion during
  HOLD"): the two limits are the same settle timeout, and on the stepped clock the loop's ends a control period
  earlier. Not reached in a session: "Home target changed; check and confirm again" (`recheck_cases` hold it).
- **The limits of an action's own waits** (the sequence's and the gripper's margins, the move's) are pinned from
  below only, by a station that is held up for one sleep (session 71): a limit longer than PEAR's is seen by no
  test, because the loop ends the operation first.
- **`close()` after a shutdown that leaves the loop open** (break 27): needs a loop whose thread does not end.
- **The percentage of an out-of-reach text with pear.js's own solver**: equal or 1 point off on the committed set;
  6 points off once in the larger run. It is the kinematics module's (`docs/progress/kinematics.md`, criterion d),
  not this layer's; with PEAR's solver's answers every text is PEAR's.
- The larger run was made when the script had 64 sessions; the two sessions and two constants added after it are in
  the committed set only.

## Deliberate differences

1. **What blocks PEAR's thread is asynchronous**: `open`, `close`, `observe`, `execute`, `home`, `recover`, `stop`,
   the waits, a camera's `read`, `readPreview` and `close`, `CameraFeed.setReader`. What only reads the control
   loop is synchronous: `status`, `isHolding`, `holdSnapshot`, `verifyObservation`, `submitGrippers`, `checkFault`,
   `modelState`, `failureResult`, the SO-101's `plan` and Home's `plan` and `recheck`.
2. **`remainingS` and `checkTime` are methods**, not static: they read the robot's clock (an option, as in the joint
   layer), where PEAR reads `time.monotonic()`.
3. **Locks.** The execution lock is a flag. The lifecycle lock is a queue that `open`, `close`, `observe`, an
   action's start and `recover` take their turn in; `open` runs `close`'s body itself when it fails (PEAR's lock is
   reentrant). PEAR takes the control loop's lock for the operation a guard is bound to, for each check and each
   submission of a guard, and around `verify_observation` and `submit_grippers`. Here there are two halves:
   - A check and what follows it are synchronous (`guard.submit`, `verifyObservation`, `submitGrippers`), so
     nothing falls between a check and its act.
   - But both can run while a control period is suspended at a call of the driver, where PEAR's wait for the
     period's end. A submission then begins its operation inside the period, and the period takes it for begun
     before it and sends its first command itself. On a page this is the ordinary case (a third of the submissions
     in the runs below). Only the making of a guard waits for the period under way, first come, first served
     behind whoever waits for the loop's lock (`newGuard`).

   What covers it: on the loop's side `tests/station-loop/interleaving.test.ts` and `sweep.test.ts` (calls that
   arrive while a control period is under way); on the robot's side `tests/station-robot/periods.test.ts` (620
   schedules of one script with the periods started by a ticker, 34 % of the submissions inside a period, all
   ending as the stepped rig does; by hand, a submission and an action's start inside a period held at the arm's
   reading). What neither covers: a fault of the arm, a recovery or a joint chunk while periods are under way, and
   a real line. That every such interleaving is safe rests on the control loop's code, not on a lock; what was run
   is a sample.
4. **A progress handler and a plan's approval may return a promise**, which the action and Home wait for. One that
   never settles keeps the robot taken for good: `stop()` still works and nothing is sent, but every later
   `execute`, `home` and `recover` throws "A station action is already running", also after `close()` and `open()`;
   only a new robot (a reload of the page) frees it. PEAR's thread blocks the same way in a handler that never
   returns (`robot.py:343-348`, `motion/homing.py:73, 140`); on a page a promise that never settles is an ordinary
   bug.
5. **A robot is made from its settings as plain objects** (`{ control, robot }`); `load_config` and OmegaConf are
   not ported. `SO101Robot` is given the open line to the servos and, for `openCameras`, the wrist camera's frame
   reader (`SO101RobotOptions`); PEAR finds both through device paths. Its kinematics are made at each `open`
   (PEAR shares one loaded instance and loads it in the constructor, because its load takes seconds).
6. **The wrist camera opens no device.** It is given its frame reader (what lerobot's camera object is to PEAR's);
   `START_TIMEOUT_MS` is kept as a constant for whoever starts a reader. A frame is copied when it is a typed
   array or the reader gives `copyFrame`.
7. **A model is a plain object**, not an instance of a class: `SingleArmDelta.isInstance` reads its `type`.
   `modelStateOf` validates what the kinematics return, because `src/so101/kinematics` does not.
8. **JavaScript has one number for 2.0 and 2**: a refusal that shows its input shows a whole float as PEAR shows the
   int (`whole_float_cases` hold what PEAR gives for each).
9. **The log, the UUIDs** are options (`log(logger, level, message, error)` with PEAR's module as `robot`,
   `results` or `control_loop`; `uuid4`).
10. **Every thrown value is caught where PEAR catches `Exception`**: pear.js has no class for Python's
    `BaseException`s that are no `Exception` (a keyboard interrupt).
11. **`SINGLE_ARM_POSE_FORMAT` carries `turnText` and `parseAction`** beside PEAR's fields, so that the one object
    is the station's format and the turn loop's. Its `resultFeedback` is `executionFeedback` of `src/protocol` and
    its `actionModel` a function (`src/so101/formats.ts`); both are compared with PEAR's in the fixtures (the 145
    feedback cases, the two reports of each of the 522 snapshot cases and of every session's result).
12. **The guard of an action is made after the lifecycle turn**, PEAR's inside it (`robot.py:490-493`). By the
    order of the queue and of the loop's lock (both first come, first served) no `close()` can come between; a
    guard that fails to be made gives the execution place back here and not in PEAR. Harmless.
13. **The turn loop's observation is another object than the robot's** (camelCase names, JPEG bytes), where PEAR's
    loop holds the robot's own dictionary. The robot reads the loop's object at every check, so a write into it
    is seen as PEAR's robot sees a write into the dictionary; the one exception is the frames and their stamps,
    which the robot gets back as its own (nothing in `src/station` or `src/so101` reads either of an observation
    that is handed back).
14. **`home({ timeoutS: null })` takes the default 420 s**; PEAR's `home(timeout_s=None)` fails on the None
    (`check_timeout` raises a TypeError). Harmless.
15. **`close()` during an action can reject although it has closed the arm.** No difference from PEAR by reading
    (`joint/control_loop.py:404-411, 384, 237-239`, `robot.py:357`): the shutdown stops, waits unguarded for the
    HOLD and closes the driver in a `finally`; the action's failure path stops again, which in a HOLD advances the
    generation and ends the shutdown's wait. It is listed because a page meets it far more easily than a caller of
    PEAR: see "How the robot serves `AgentRobot`".
16. **Planning runs on the page's one thread** (the SO-101's `plan`, Home's `plan` and `recheck`): no control
    period can start during a plan. PEAR plans in the caller's thread while its control thread goes on.
17. **A key that reads as an array index comes first.** JavaScript enumerates the keys of an object that are
    canonical array indices (`"0"`, `"7"`, `"42"`: digits without a leading zero, below 2**32 - 1) first, in
    ascending order, whatever their place in the JSON; Python keeps a dict in the order it was written. So when
    an action, or a dict inside it, has such a key that is not the first one written, a refusal that shows that
    dict shows the key first, and the `extra_forbidden` errors of that dict come in JavaScript's order: the text
    is what PEAR gives for the same action with those keys first. For `{"type": "gripper", "note": 1.5, "0": 2.5}`
    PEAR writes `gripper.command ... input_value={'type': 'gripper', 'note': 1.5, '0': 2.5}`, then `gripper.note`,
    then `gripper.0`; pear.js writes `gripper.command ... input_value={'0': 2.5, 'type': 'gripper', 'note': 1.5}`,
    then `gripper.0`, then `gripper.note`. Nothing else differs: the same errors, the same count, and no action
    is taken or refused otherwise (190 of the audit's 18,549 validations). No fixture holds it as
    `whole_float_cases` hold difference 8; a run of the audit's cases against PEAR showed it.

## To reconcile with the other modules

- **`GripperOutcome`** is defined in `src/protocol/types.ts` and in `src/so101/joint/grippers.ts` (the control
  loop's file): the same three words twice. Not in this round's list of re-exports.
- **`src/so101/kinematics`**: `quantities` returns its result without PEAR's `ModelState.model_validate`; this layer
  validates in `modelStateOf`. If the kinematics validate themselves (they can import `ModelState` from
  `src/so101/motion/actions.ts`), `modelStateOf` becomes a plain call.
- **`src/station/joint/numeric.ts`**: `clip` is described as numpy's and is `minimum(maximum(...))`, which gives
  `0.0` for `-0.0`; numpy's `clip` keeps `-0.0`. This layer does not use it.
- **The page** (`web/`): it can make an `SO101Robot` with `line` and `wristFrames`, wrap it in `AgentRobotAdapter`
  with its JPEG encoder, and hand that to `StationAgentLoop`. None of that has run on a real line.
- **`tests/agent/loop.test.ts`** still replays PEAR's answers on a robot that only plays back; the capstone runs
  the same 19 tasks on the real robot. Both are kept: the first needs no rig.

## Left

From the independent audit (the numbers are its findings; Round 4 has the table):

- 1: the interleavings that no test runs: a fault of the arm, a recovery or a joint chunk while control periods are
  under way; and anything on a real line.
- 2: six breaks that show only at an exact bound or in a refusal's order still fail nothing (R34, R41, R42, B20,
  SH2, SH3); "Home target changed" is reached by no session; an action's own waits are pinned from below only.
- 3 and 4: **a lone surrogate is refused with another text than PEAR's** (found in Round 4, not fixed). For a JSON
  `"\ud800"` as a literal's value PEAR says `Input should be a valid string, unable to parse raw data as a unicode
  string [type=string_unicode, ...]` and pear.js `Input should be 'open' or 'close' [type=literal_error, ...]`; as a
  key of a model's dict PEAR gives the one error `string_unicode` at the model's place and pear.js
  `extra_forbidden` beside the model's other errors; as a tag PEAR shows three U+FFFD and pear.js the surrogate.
  Both refuse and nothing moves. Deliberate difference 17 is held by no fixture. A hole of a sparse array is read
  as `undefined` by the list's validation (JSON gives none; no test).
- 6: planning on a slow device was not measured and nothing was changed (deliberate difference 16).
- 7: of `AgentRobotAdapter`, no test reaches the cancellation of `waitStationary` (the audit's break R49), a frame
  encoder that is not awaited, throws, takes long or returns no bytes (R51; the encoder's result is handed on
  unchecked), and the snapshot of `failureResult` (R53). Of the cameras: a read or a new reader that does not wait
  its turn, a read during a pending close (C02, C04), and a reader that reuses its buffer (W06).
- 9: PEAR's side of a `close()` that rejects is from reading; its stepped rig cannot make that interleaving.
- The rows of `tests/station-robot/observation.test.ts` are a run of PEAR by a script that is not in the
  repository (it imports `tools/fixtures/robot_fixtures.py` for its rig); if it is to be run again with a new PEAR
  it belongs under `tools/`.

If PEAR is updated: run `tools/fixtures/robot_fixtures.py` in the new environment,
then `npx vitest run tests/station-robot/parts.test.ts`, `sessions.test.ts` and `capstone.test.ts` one at a time,
each followed by `tools/fixtures/ruckig_fixtures.py --libm tests/fixtures/station-robot` until no `missing.txt` is
written.
