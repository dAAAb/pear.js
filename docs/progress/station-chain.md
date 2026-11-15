# Progress: station-chain

Step 4 of the verification ladder, the port's side: pear.js's own station (`SO101Robot` on its real driver) run
through the scripted sessions on the simulated SO-101 servo chain, stepped by the rule of `station-reference.md`,
and compared with the reference's result of the same script (PEAR's Python robot on the same chain). The chain is
not part of this repository; the tests that need it are skipped without it. What runs everywhere is the replay:
the same station on the recorded line of PEAR's run (the section "The replay" below).

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
- **Without the chain, on the recorded line of PEAR's run** (`station_replay.test.ts`, in every `npm test`): with
  PEAR's kinematics' answers and the C library's values pear.js sends PEAR's 25,502 instruction packets, each one
  required in its place, and no value its station computes differs in the 652 steps; with its own kinematics the
  same 26 goal packets of the one step differ, and all that the chain's first test requires holds. The servo side
  of a replay is PEAR's recording and proves nothing.
- No defect of the port was found, and nothing under `src/` was changed.
- `SO101Robot.makeDriver` (`SO101Driver.fromConfig`), which no test had run, ran here on the chain's line.

## Done

| File | What it is |
| --- | --- |
| `tests/sim-bridge/station_runner.ts` | `StationRunner`: one robot of pear.js driven through the script on the chain's line, a `StationRunResult` of the form the reference writes; the line and the controls can be given to it (by default the chain over TCP) |
| `tests/sim-bridge/station_chain.test.ts` | The gated test: the sessions run twice (pear.js's own kinematics; PEAR's answers and the C library's values) and compared with the reference's result |
| `tests/sim-bridge/replayed_chain.ts` | `ReplayedChain`: a chain replayed in process from a reference result: the line that requires PEAR's instruction packets and hands back PEAR's answers, and the controls the runner asks of a chain |
| `tests/sim-bridge/station_reference.result.json.gz` | The reference's stored result of all 8 sessions (PEAR's Python station on the chain): 652 steps, 25,502 and 87,210 packets |
| `tests/sim-bridge/station_replay.test.ts` | The test that needs no chain: the 8 sessions on the replayed line, twice as above; the replayed chain by itself; the changes of the reference that must be found |
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

## The replay: the station on PEAR's recorded line

The reference's result holds, for every step, every packet that crossed the line in PEAR's run, in both directions
and in order. `replayed_chain.ts` makes of it what the chain is to the runner, in process:

- **The line** (the bus's transport). Every instruction packet pear.js writes must be the next one of the step's
  record; then the status packets that follow it there are handed back. A packet that is not PEAR's ends the run
  with an error that names the session, the step, the packet's number among the step's instruction packets and
  both packets. One tolerance, off by default and used only for the run with pear.js's own kinematics: a sync write
  of Goal_Position to the same servos in the same order whose goals alone differ; each one is listed.
- **The controls.** `mark` moves to the next step's record by the chain's own rule (it takes effect just before the
  next instruction packet that is not a sync write); a step that is not the next one of PEAR's run, and packets
  that PEAR's run still holds of the step before, are errors. `reset` starts a session. `inject` and `place` do
  nothing: what they caused is in the answers. `traffic` hands back what crossed the replayed line, under the same
  labels. `state` and the calibration are the reference's: the world of a step is the reference's record of it.

`StationRunner` takes the line and the controls as options; without a line it connects to the chain over TCP as
before, and `station_chain.test.ts` is unchanged. If pear.js sends exactly what PEAR sent, it reads exactly what
PEAR read, and must then compute and return exactly what PEAR's station did. `station_replay.test.ts` requires
that, without any variable of the environment.

### What is compared, and what is a copy

| In the result of a replayed run | |
| --- | --- |
| the instruction packets, in their order | pear.js's: the line requires each one, and the comparison counts them again |
| of each step: whether it returned or raised, what it raised, an action's result, the report, the turn's text, the model's state, whatever else it returned, the status with its control snapshot, the joint vector the arm heads for, the ticks, the waits, the loop's states, the clock, the log | pear.js's: compared with PEAR's, each number in every bit |
| what the planner asked the kinematics and how often, and the arguments the trajectory generator gives the C library's five functions (the exact run) | pear.js's: required to be PEAR's |
| a step's id, op, turn and about; the session file's hash; the station's settings | the script's, which both runners copy: they show that the reference ran the committed script |
| the status packets, the simulated world, the line's counters of a session, the chain's clock, the calibration | copies of the reference's: they prove nothing (the calibration is an input: the driver converts with it) |

### What a replay cannot show

- Nothing of the servo side. The simulated chain is not there: that pear.js and PEAR's Python ran on the same
  chain, and what the chain answered pear.js, is the chain's run above. The replay holds the station to the stored
  result of PEAR's run.
- Nothing after the first packet that is not PEAR's. No chain answers such a packet, so a replay says where a
  station leaves PEAR's run and not how far it then goes from it. With pear.js's own kinematics the answers after
  the goal that differs are still those PEAR's arm gave; on the chain the arm then rested one count apart (the
  world's 35 differences and the 25 status packets of the table above), which a replay does not show.
- Nothing of the line's timing: an answer is there as soon as its packet is written, none is late or lost, and no
  packet timeout of the bus runs.

### The numbers

- **Exact** (PEAR's kinematics' answers, the C library's values), all 8 sessions: 652 steps compared, 0 with a
  difference; 25,502 instruction packets required and 25,502 compared, 0 differing; 87,210 status packets handed
  back; 1,180 values taken from the C library's table, 0 not in it; the planner asked 61 times what PEAR's was
  asked.
- **pear.js's own kinematics and the engine's functions**, all 8 sessions: every part that does not depend on a
  planned target's last bits is the same in all 652 steps; the line let 26 goal writes pass with another goal, all
  in `a task`, step 265 (the settling of a Home; the first is the step's instruction packet #859: the pan joint's
  goal 2047 where PEAR's is 2046), and without the tolerance the run ends at that packet. 9,048 numbers differ in
  467 steps (an action's result 349, the joint vector 2,267, the status 4,369, what a step returned besides 2,037,
  the 26 packets): the 9,159 of the chain's run less the world's 35 and the 25 status packets, which are copies
  here, and less 51 that followed on the chain from the arm resting one count apart. The measured positions of all
  81 recorded results are identical in every bit.
- **Time**: the file's 12 tests take 1.2 s alone and 2.0 s in the whole suite on the machine of the chain's run
  (a run of the 8 sessions about 0.6 s; the reference is unpacked, hashed and parsed in 24 ms).

### The reference's file

`station_reference.result.json.gz` (330,084 bytes) holds 5,481,450 bytes of JSON whose SHA-256, which the test
requires, is `f243b76509ae98d465bcfd77900aa2ae0512a0a77f29b095ee8e72b18e79c3ba`. It is the result the reference
runner stored of the run of all 8 sessions (5,481,492 bytes, SHA-256
`b6645b37750eed6974217e00d0bc7fbd92099288d964a981f9ced2ef48a79035`), byte for byte but for the 42 bytes of one entry
of its `run` record: the name of the reference's own serial line, a path on the reference's machine, which no file
of this repository may hold. `run` is what belongs to a run alone and is never compared. The header of
`replayed_chain.ts` says how the file is made; made again from the stored result it was the same file, byte for
byte (the packed bytes depend on the zlib at hand, the content does not). The gzip header holds no time and no
file name. The file's first session is that of the committed `station_sample.result.json` in every key and every
bit, and so are the fields outside the sessions but `run`.

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
- **The replay**, without the chain: `npx vitest run tests/sim-bridge/station_replay.test.ts`: 12 tests pass, with
  the numbers of the section above.
- **The replay can fail.** In the test itself, on a copy of the reference's shortest session with one thing
  changed: one encoder count in a servo's answer to the last position read of a hold (the checksum made valid
  again): the run goes on, and the comparison finds the step's status and nothing else; one count in a goal of
  PEAR's first goal write of an action: the line refuses pear.js's packet with the whole text of the error (the
  tolerant line lets it pass and lists it, and the comparison counts it); one instruction packet more at the end
  of a step of PEAR's run: the next step's mark is the error; one last bit of a measured position in a step's
  result: the comparison finds that one difference. And the chain by itself, on a run of two steps written by
  hand: the answers, the rule of a mark, the errors.
- **Breaks of the port, in a scratch copy, one at a time**: the Status poll one read later
  (`src/so101/hardware/arms.ts`): both runs of the 8 sessions end at `a short session from the rest pose / 001
  open: instruction packet #127`; another prefix of the report (`src/protocol/turn_text.ts`): both fail, the exact
  run with 77 steps that differ and every packet the same, the other at the turn's text; degrees to radians by a
  factor one part in 2^52 off: the exact run ends at `001 open: instruction packet #154` (a goal one count apart),
  the run with pear.js's own kinematics passes, as it must.
- **Breaks of the replayed chain, likewise**: a line that compares nothing fails 2 tests (the run with pear.js's
  own kinematics, whose 26 packets are then not listed, and the changed instruction packet); a mark that does not
  look at what PEAR's run still holds fails 1; marks that take effect at once fail 1 (the chain by itself: in
  process the runner's own packets never wait behind a mark).
- **The runner's line over TCP after the change**, without the chain: a local socket in front of the replayed line,
  the runner given no line, the shortest session with pear.js's own kinematics: one connection, 324 of 324
  instruction packets, 85 differences in 4 steps, as on the chain.
- **The gated test on the chain again, after the runner's change** and after the joint layer's parts that are
  given no clock took another one (`loop.md`, deliberate difference 12; a stepped run gives every part its clock):
  all 8 sessions, each way on a chain started anew: exact, 0 differences, and the reference's own tool finds none on
  the byte log; with pear.js's own kinematics the same 9,159 differences and the same 26 packets as before.
- Without the chain: `npx vitest run`: 75 files pass, 2 are skipped; 9,169 tests pass, 8 are skipped (the 4 gated
  tests of `sim-bridge.test.ts`, the 2 of `station_chain.test.ts` and the 2 of the joint layer that measure real
  time). `npx tsc --noEmit` is clean.

## Not verified

- The replay on other engines than the two it has run on (Node 24.18.1 for Windows and Node 22.22.2 for Linux,
  both x64: all 12 tests pass on both, and the run with pear.js's own kinematics gives the same counts on both, the
  26 goal writes and the 9,048 numbers in 467 steps). The exact run takes PEAR's values for both known causes; the
  run with pear.js's own kinematics uses the engine's functions, and whether another engine's last bits change a
  count or a tick there is not known.
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
- The test on the chain needs the chain, so it does not run where the chain is not. Continuous integration runs
  the replay instead: it holds pear.js's station to the stored result of PEAR's run, and not the chain, the
  reference or a station that leaves PEAR's run to anything.
- The first run of the replay on a hosted runner, and its time there.
