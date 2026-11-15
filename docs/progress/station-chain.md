# Progress: station-chain

Step 4 of the verification ladder, the port's side: pear.js's own station (`SO101Robot` on its real driver) run
through the scripted sessions on the simulated SO-101 servo chain, stepped by the rule of `station-reference.md`,
and compared with the reference's result of the same script (PEAR's Python robot on the same chain). The chain is
not part of this repository; the tests that need it are skipped without it.

## Result

- **With PEAR's kinematics' answers and the reference C library's values, nothing differs** in any of the 8
  sessions: 652 steps compared, 0 with a difference; 25,502 of 25,502 instruction packets and 87,210 of 87,210
  status packets the same; every value of every step's record the same in every bit (what a step returned or
  raised, the results, the report texts, the turn texts, the snapshots, the tick counts, the loop's states, the
  clock, the simulated world, the log). The reference's own comparison tool, given pear.js's result and the chain's
  raw byte log of that run, finds no difference either.
- **With pear.js's own kinematics and the engine's own functions**, every step returns or raises the same, every
  report text, turn text and model state is the same, and so are the ticks, the waits, the loop's states, the clock
  and the log of all 652 steps; the measured positions of all 81 recorded results are identical in every bit. The
  instruction packets are the same in the same order but for the value of a goal: 26 of 25,502 differ, all in one
  step (the settling of a Home: one joint's goal is one encoder count apart), and 25 status packets after them.
  Besides, 9,108 numbers differ: planned targets in their last bits and what is computed from them.
- No defect of the port was found, and nothing under `src/` was changed.
- `SO101Robot.makeDriver` (`SO101Driver.fromConfig`), which no test had run, ran here on the chain's line.

## Done

| File | What it is |
| --- | --- |
| `tests/sim-bridge/station_runner.ts` | `StationRunner`: one robot of pear.js driven through the script on the chain's line, a `StationRunResult` of the form the reference writes |
| `tests/sim-bridge/station_chain.test.ts` | The gated test: the sessions run twice (pear.js's own kinematics; PEAR's answers and the C library's values) and compared with the reference's result |
| `tests/sim-bridge/station_kinematics.json` | PEAR's kinematics' answers in a run of the reference: by session, what `SO101Kinematics.joint_target` was asked and what it returned or raised (61 questions, 9 of them refused) |
| `tests/sim-bridge/libm.json` | The reference C library's values for the 622 arguments the trajectory generator asks its five functions over the 8 sessions (the table of `tests/ruckig/oracle.ts`) |
| `tests/sim-bridge/bridge_control.ts` | Added: `place`, and the fields of the chain's state a stepped station reads |

## How the runner keeps the stepping rule

The robot is the port's own: `SO101Robot`, its driver made by `SO101Driver.fromConfig` on a TCP connection to the
chain's line with the calibration the chain serves, its control loop, motion layer, gripper operation, homing and
recovery. What is replaced is what the reference replaces in PEAR, taken from `tests/station-robot/rig.ts`:

1. The clock is `RecordingClock` (PEAR's `StandInClock`): 100.0 at each `reset`, advanced by a sleep alone.
2. Its `sleep` adds the duration and steps the attached loop once; every wait of the robot sleeps on it.
3. The loop is attached when `open()` has returned and detached when the robot has closed; the robot's loop class
   is `SteppedSO101ControlLoop`, whose `start()` starts nothing.
4. The runner itself sleeps only in `hold`, `idle` and the review of a Home plan.
5. Inside a step of the loop nothing is the runner's: the port's driver reads and sends.
6. The chain ages the arm; the runner refuses a chain on another clock.
7. The readings are stamped on the robot's clock; the bus's packet timeouts stay on the machine's.
8. An event "after tick N" runs inside the Nth sleep of the step, after the loop's step: the pause sets the
   cancellation and stops the robot, a fault is posted to the chain.
9. After `reset` the mark `session: <name>`, before every other step `<id> <op>`; the chain's record between two
   marks is the step's packets.
10. Every session makes a new robot and a new cancellation.

A step of the script is a call of PEAR's robot under PEAR's name; the runner makes the port's (`wait_stationary`
is `waitStationary`, `failure_result` is `failureResult`, ...). The turn's text is the format's `turnText` with
the report of the last result, which is what PEAR's message builder writes. Of the log, a warning or an error is
kept with PEAR's logger name for the two loggers the reference's runs show (the robot's and the control loop's).

## The two inputs of the exact comparison

pear.js answers two questions in other last bits than PEAR does, and both are known causes that are no defects:
the inverse kinematics (PEAR asks lerobot's solver on placo) and five functions of the C library that the
reference's trajectory generator is linked with (`src/ruckig/libm.ts`). For a comparison of every bit both are
given PEAR's values:

- `station_kinematics.json` was recorded by a wrapper around `SO101Kinematics.joint_target` in a run of the
  reference whose result equals the stored reference (652 steps, 0 with a difference; 25,502 and 87,210 packets, 0
  differing). The runner answers the planner from it and requires that the planner asked what PEAR's was asked, in
  every bit, and as often.
- `libm.json` was built in 3 rounds (12, 607 and 3 values), each a run followed by
  `tools/fixtures/ruckig_fixtures.py --libm`. The exact run takes 1,180 values from it and asks for none it lacks.

How much each accounts for, over the 8 sessions:

| | Steps with a difference | Differences | Instruction packets differing |
| --- | --- | --- | --- |
| pear.js's kinematics, the engine's functions | 468 of 652 | 9,159 | 26 of 25,502 |
| PEAR's answers, the engine's functions (607 of 619 arguments not yet in the table) | 6 | 18 | 0 |
| PEAR's answers, the C library's values | 0 | 0 | 0 |

So the engine's functions alone change the last bit of a planned target in 6 steps, and everything else,
the one goal of a Home included, follows from the kinematics' last bits.

### What differs with pear.js's own kinematics

| Part of a step | Differences | Steps | Largest |
| --- | --- | --- | --- |
| an action's result (`tracking_error`) | 349 | 71 | 2.3e-13 rad |
| the joint vector the arm heads for | 2,267 | 462 | 2.3e-13 rad |
| the status with its snapshot | 4,389 | 467 | 1.5e-2 (a mean speed while a Home settles) |
| what a step returned besides (snapshots, a Home report) | 2,068 | 204 | 1.5e-2 (the same) |
| the simulated world | 35 | 5 | 1.5e-3 rad (one encoder count) |
| instruction packets | 26 | 1 | one count of one goal |
| status packets | 25 | 1 | |

Every one of them is a number; no text, no status, no count differs. The 26 packets are the last sample of a Home
(`a task`, step 265), sent again at each tick of the settling: the pan joint's goal is 2046 in PEAR's run and 2047,
the middle of its range, in pear.js's, while the joint's target at the end is 0 in both. The sample itself is not
in a result; that it lies a hair on one side or the other of the middle is the likely reason, not a measured one.
The arm then rests one count apart for the 4 steps that are left of the session.

## How it was verified

2026-11-15, on the chain started with `packets --steps-per-packet 0 --steps-per-position-read 4`.

- **The exact run of all 8 sessions**, on a chain started anew: `PEAR_JS_SIM_BRIDGE_STATION=<host:port>
  PEAR_JS_STATION_SESSIONS=all PEAR_JS_STATION_REFERENCE=<the reference's result>
  npx vitest run tests/sim-bridge/station_chain.test.ts`: 652 steps compared, 0 with a difference, 0 differences;
  instruction packets 25,502 against 25,502, 0 differing; status packets 87,210 against 87,210, 0 differing; 1,180
  values taken from the table, 0 not in it; the planner asked 61 times what PEAR's was asked.
- **The reference's own comparison tool** (Python, another implementation of the comparison) on pear.js's written
  result and the chain's byte log of that run, beside the reference's: no difference, every value of every step,
  every packet; the packets cut again out of the byte log are the packets of the result.
- **The run with pear.js's own kinematics**, all 8 sessions, twice (two chains started anew): the same 9,159
  differences both times, by part as in the table above.
- **Without any variable but the chain's**, the test runs the shortest session against the committed
  `station_sample.result.json`: own kinematics 85 differences in 4 steps (the targets' last bits, at most 1e-14),
  324 of 324 instruction packets and 891 of 891 status packets the same; exact: 0 differences.
- **The test can fail.** In a scratch copy, one change at a time: the Status poll one read later
  (`src/so101/hardware/arms.ts`) fails both tests; another prefix of the report in the turn's text
  (`src/protocol/turn_text.ts`) fails both; degrees to radians by a factor one part in 10^16 off fails the exact
  test and, as it must, not the other.
- Without the chain: `npx vitest run`: 72 files pass, 2 are skipped; 9,138 tests pass, 6 are skipped (the 4 gated
  tests of `sim-bridge.test.ts` and these 2). `npx tsc --noEmit` is clean.

## Not verified

- Anything on a real arm, and anything through Web Serial: the line here is a TCP connection in Node.
- pear.js's loop on a timer against the chain's real-time clock: only the stepped run was made, so how much of a
  real-time run of the port is timing is not known (`station-reference.md` measures it for PEAR).
- A feedforward other than zero, lost answers and retries under the station, a timeout of an action, a pause
  during Home: the script has none (see `station-reference.md`).
- With pear.js's own kinematics a goal can differ by a count where a trajectory ends on the edge between two; over
  this script it happened once and changed no result. Nothing bounds it in general.
- The names of PEAR's loggers other than the two the reference's runs show.

## Left

- A run of pear.js's station in real time (its control loop on the page's timer), beside the reference's two
  real-time runs.
- The test needs the chain, so it does not run where the chain is not: nothing here runs in continuous integration.
