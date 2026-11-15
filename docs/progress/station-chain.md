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
- **In real time** (the port's own loop started by `open` on `realTimeClock()`, the chain's arm on the wall clock;
  the section "In real time"): in every run of each of the 8 sessions on Node for Linux (four runs a session, two
  of them after the runner's control calls were made quick), every step returns or raises as in PEAR's stepped run
  and as in PEAR's two real-time runs, every action's result has the same status, settled, reached, gripper outcome
  and error, and every report text is the same; the chain counted no unanswered packet, no corrupt packet and no
  dropped byte, and no run faulted on its own. In the last two runs the station also takes PEAR's number of control
  periods (11,599 and 11,604 where PEAR's runs take 11,682 and 11,686) and logs what PEAR's logs. The loop kept its
  period on the line: 20.003 ms on average and 20.13 ms at the 99th percentile (PEAR's: 20.004 and 20.28).
- **Where the arm stops when a fault interrupts a motion is not the same from run to run, in PEAR's runs and in
  these.** PEAR polls the servos' Status and their Torque_Enable once in 10 reads of the positions each, so a fault
  is noticed between 1 and 10 control periods after it arrives, and one read more or fewer before the fault decides
  which. The script's torque loss arrives one read before a poll in PEAR's three runs (noticed 1, 1 and 2 reads
  later); in the last two runs here it was noticed 11 reads later in one (the arm 2.8 cm further on) and 1 read
  later in the other. The polls are at the same reads in every run.
- No defect of the port was found, and nothing under `src/` was changed.
- `SO101Robot.makeDriver` (`SO101Driver.fromConfig`), which no test had run, ran here on the chain's line.

## Done

| File | What it is |
| --- | --- |
| `tests/sim-bridge/station_runner.ts` | `StationRunner`: one robot of pear.js driven through the script on the chain's line, a `StationRunResult` of the form the reference writes; the line and the controls can be given to it (by default the chain over TCP) |
| `tests/sim-bridge/station_chain.test.ts` | The gated test: the sessions run twice (pear.js's own kinematics; PEAR's answers and the C library's values) and compared with the reference's result |
| `tests/sim-bridge/station_realtime.test.ts` | The gated test in real time (the section "In real time"): the runner with `clock: "realtime"`, the port's own loop on its own clock, beside the reference's stepped run and its runs in real time |
| `tests/sim-bridge/replayed_chain.ts` | `ReplayedChain`: a chain replayed in process from a reference result: the line that requires PEAR's instruction packets and hands back PEAR's answers, and the controls the runner asks of a chain |
| `tests/sim-bridge/station_reference.result.json.gz` | The reference's stored result of all 8 sessions (PEAR's Python station on the chain): 652 steps, 25,502 and 87,210 packets |
| `tests/sim-bridge/station_replay.test.ts` | The test that needs no chain: the 8 sessions on the replayed line, twice as above; the replayed chain by itself; the changes of the reference that must be found |
| `tests/sim-bridge/station_kinematics.json` | PEAR's kinematics' answers in a run of the reference: by session, what `SO101Kinematics.joint_target` was asked and what it returned or raised (61 questions, 9 of them refused) |
| `tests/sim-bridge/libm.json` | The reference C library's values for the 622 arguments the trajectory generator asks its five functions over the 8 sessions (the table of `tests/ruckig/oracle.ts`) |
| `tests/sim-bridge/bridge_control.ts` | Added: `place`, and the fields of the chain's state a stepped station reads. Changed: every call of the controls on a connection of its own (the section "In real time") |

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

## In real time

The same script with nothing replaced but the camera: the port's own control loop, started by `open` as the port
starts it (its `run()` on the clock); the robot given no clock, so that the robot, its loop and every wait run on
`realTimeClock()` as a caller of the library gets it (`loop.md`, deliberate difference 12); the chain's arm on the
wall clock. `StationRunner` with `clock: "realtime"` does what the reference's `--clock realtime` does: a hold and
an idle sleep the script's ticks as control periods of the machine's clock, an "after tick N" event is a timer of
N periods from the step's start, a step's `ticks` are the reads of the positions the chain saw during it (so an
`open` has ticks: 28 here, 27 in PEAR's runs), and a step's record holds no `sleeps` and no `phases`. Where
JavaScript makes the runner do otherwise than the reference: the loop, the caller and the events share one thread
(an event runs between two turns of the loop, and a step's record waits for an event that fired to end); the
runner's own waits sleep on the robot's clock, which is the port's `time.sleep()`, because an engine's timer of
20 ms is no sleep of 20 ms on every engine.

`station_realtime.test.ts`, gated by `PEAR_JS_SIM_BRIDGE_STATION_REALTIME`, runs the sessions once so, prints one
line `RT {...}` of JSON a session with the rows below, and asserts only what PEAR's own two real-time runs keep,
beside each other and beside PEAR's stepped run: the rows of the table of `station-reference.md` that are 0 in all
three columns, counted again from the three stored results with the reference's comparison tool. Those are: no
step raises on one side only (and none raises another class or message); no result of an action differs in
status, settled, reached, gripper outcome or error; no report text differs. It also requires what both of PEAR's
runs have of the chain's counters (no unanswered packet, no corrupt packet, no dropped byte), that the script
closed the robot, and that every event of the script was done.

### What was run, and the table

Node 22.22.2 for Linux (where PEAR's real-time runs were made), pear.js's own kinematics, each session on a chain
started anew. Two rounds: runs a and b on 2026-11-15, each of the 8 sessions twice; then, after the runner's calls
of the chain's controls were made quick (the next section), runs c and d on 2026-11-16, each of the 8 sessions
twice again. All 32 runs pass. The rows, counted by the reference's comparison tool on the written results (the
test's own lines give the same counts), beside PEAR's stepped run and PEAR's two real-time runs A and B of
`station-reference.md`, for runs c and d:

| | stepped / c | stepped / d | A / c | B / c | c / d |
| --- | --- | --- | --- | --- | --- |
| steps that raised on one side only (of 652) | 0 | 0 | 0 | 0 | 0 |
| results differing in status, settled, reached, gripper outcome or error (of 81) | 0 | 0 | 0 | 0 | 0 |
| report texts differing (of 81) | 0 | 0 | 0 | 0 | 0 |
| turn texts differing (of 85) | 2 | 2 | 8 | 4 | 2 |
| measured positions of completed actions identical in every bit (of 59) | 58 | 58 | 54 | 57 | 58 |
| largest difference of a shown quantity | y 2.8 cm | y 0.2 cm | y 2.8 cm | y 2.8 cm | y 2.6 cm |
| largest difference of a measured joint, completed actions | 0.110 rad (72 counts) | 0.009 rad (6 counts) | 0.110 rad (72 counts) | 0.110 rad (72 counts) | 0.103 rad (67 counts) |
| the same, actions not completed | 0.133 rad (87 counts) | 0.011 rad (7 counts) | 0.133 rad (87 counts) | 0.133 rad (87 counts) | 0.123 rad (80 counts) |
| ticks of all steps but `open` | 11,548 / 11,599 | 11,548 / 11,604 | 11,682 / 11,599 | 11,686 / 11,599 | 11,599 / 11,604 |

Beside run d, A and B give 8 and 4 turn texts, 54 and 57 positions, y 0.4 and 0.3 cm, 15 and 9 counts. Runs a and
b, made with the slow control calls, have the first three rows 0 as well; their turn texts are 4 and 4 beside the
stepped run, 10 and 4 beside A and B, 2 between them; their positions 57, 57, 53, 57 and 58; the largest
differences y 0.5 to 0.9 cm and 25 counts; their ticks 12,593 and 12,594. In all 32 runs the chain counted no
unanswered packet, no corrupt packet and no dropped byte; no run faulted on its own (no stale feedback, no
tracking error, no servo error, no "Persistent motion during HOLD", no stability timeout but the scripted ones),
no answer was read one behind, the loop never stopped, and no event of the script failed.

What stays: everything the test asserts, and wherever no event interrupts a motion the model reads the same as in
PEAR's stepped run and the joints rest on the same encoder counts (the six sessions without a fault: every turn
text, and every measured position of a completed action in every bit, in all four runs; the operator's pauses
stopped the arm where the stepped run's did). What moves: the two sessions with a fault. In runs c and d the
overload session reads as the stepped run in every turn text and the torque session differs in 2, by 0.2 cm in
run d and by 2.8 cm in run c ("When a fault is noticed" below); the 6 more against A are A's own, in "the operator
pauses", where A differs from the stepped run and from B too.

### The runner's calls of the chain's controls

- **What runs a and b showed, and whose it was.** 12,593 ticks where PEAR's runs show 11,682 and 11,686: 2 more on
  every step, also on those that take no time. Seven warnings "feedback read failed in FAULT" in a fault session
  where PEAR's log 5. The script's faults at the chain 2 reads late. All three were the runner's: every call of
  the chain's controls (the mark before each step is one) took about 43 ms, and the loop ran on meanwhile.
- **The cause** (measured 2026-11-16, 30 calls each way, Node 22 for Linux, the chain idle): a call by `fetch`
  takes 43.0 ms, by `node:http` on a connection kept alive 39.8 ms, by `node:http` on a connection of its own
  0.8 ms; the reference's client, Python's, which makes a connection a call, 1.0 ms. On a connection that is kept,
  every answer of the chain's server comes about 40 ms late. `BridgeControl` now makes a connection a call.
- **With that** (runs c and d): the ticks by op, A beside c: `execute` 5,788 / 5,764, `home` 4,531 / 4,535, `hold`
  873 / 867, `wait_settled` 61 / 63, `recover` 106 / 105, `open` 27 / 28 each, and nothing on the steps that take
  no time; between the calls the runner spends 4.3 ms a step (the reference's: 4.6 ms). The script's faults reach
  the chain 400.0 to 400.2 ms after the step's mark (PEAR's: 400.1 ms; once 420.1 ms). The log is PEAR's in every
  session of both runs: 14 times "An action did not complete", the two station faults, and 5 warnings "feedback
  read failed in FAULT" in each fault session. The test does not compare the log.
- **The stepped runs do not depend on it.** After the change, on chains started anew: both stepped runs of all 8
  sessions write the same comparison as before, byte for byte (0 differences; 9,159 differences and 26 packets),
  and the same results but for the wall times, in 11 s each where they took 48 s; the 4 gated tests of
  `sim-bridge.test.ts` pass on the `packets` clock.

### When a fault is noticed

PEAR's hardware layer polls the servos' Status (address 65) on every 10th read of the positions and their
Torque_Enable (address 40) on every 10th, half a cycle apart (`statusPollTicks`; `poll()` in
`src/so101/hardware/arms.ts`, as in PEAR). A fault that only one of the two registers shows is noticed at that
register's next poll: 1 to 10 reads after it arrives, up to 0.2 s, and until then the loop follows the trajectory.
At the poll the loop holds in the same period; the action returns one or two periods later, in PEAR's runs and in
these.

The torque session, in reads of the positions since the session began:

| | the action begins | the fault arrives | the action has failed | noticed after |
| --- | --- | --- | --- | --- |
| PEAR, stepped | 585 | 605 | 606 | 1 read |
| PEAR, A | 585 | 605 | 606 | 1 |
| PEAR, B | 585 | 605 | 607 | 2 |
| pear.js, run c | 586 | 606 | 617 | 11 |
| pear.js, run d | 584 | 605 | 606 | 1 |

Torque_Enable is polled at reads 596, 606 and 616 in all five. The script puts the fault "after tick 20" of an
action that begins at read 585 in PEAR's stepped run: it arrives at read 605, one read before a poll, which is the
best case. In run c the Home before it took 548 reads where it took 547 in PEAR's three runs; the fault arrived
at read 606, just after that poll, and was noticed at the next, 10 reads later: the base joint 0.13 rad further on
(87 counts), the tip 2.8 cm, and the next action went on from there. Run d began at 584 and reads as PEAR's. A run
with PEAR's kinematics' answers gave run c's three numbers again. The overload, which the Status poll shows, was
noticed 6 reads after it arrived in every run, PEAR's three and c and d.

So what a real-time run of this script shows of a fault session is the phase of the polls as much as the station.
The station is held to PEAR's at one phase by the stepped run and by the replay, where the port's Status poll made
one read later fails both ("How it was verified"); that a servo's fault can go unnoticed for up to 10 control
periods is PEAR's, and the port keeps it.

### What one thread does

- **The planner's work is the loop's delay.** The caller plans an action on the loop's thread. In run c four
  periods were late, each followed by a short one, so that the next kept its hour: 36.8 then 3.1 ms and 26.3 then
  13.7 ms in "what the station refuses" (steps 013 and 037; the first is an action out of reach that searches how
  far the arm can go), 26.1 then 13.9 ms and 26.3 then 13.7 ms in "a task" (steps 187 and 193). In run d none; in
  run a two (36.3 then 3.7 ms, 26.0 then 14.0 ms, the calls 17.6 and 7.2 ms long); in run b none: it depends on
  where in a period the call begins. PEAR's loop has its own thread and shows nothing there. Nothing came of the
  late steps.
- **An event runs between two turns of the loop**, and an action that has ended returns to its caller when the
  thread is free: one or two periods after the loop's hold, as in PEAR's runs (the table above).

### The loop's period on the line

The first measurement of pear.js's loop against a line: the time between two reads of the positions in the
chain's byte log (each entry carries the chain's own time of its arrival), from the end of `open` to the close.

| | periods | mean | p99 | largest | over 25 ms |
| --- | --- | --- | --- | --- | --- |
| pear.js, run a (Node 22 for Linux) | 12,593 | 20.003 ms | 20.125 ms | 39.983 ms | 4 |
| pear.js, run b | 12,594 | 20.003 ms | 20.138 ms | 39.968 ms | 2 |
| pear.js, run c | 11,599 | 20.003 ms | 20.130 ms | 40.118 ms | 6 |
| pear.js, run d | 11,604 | 20.003 ms | 20.126 ms | 39.996 ms | 2 |
| PEAR, A | 11,682 | 20.004 ms | 20.281 ms | 40.268 ms | 2 |
| PEAR, B | 11,686 | 20.004 ms | 20.254 ms | 40.689 ms | 2 |

Two of each of pear.js's are the 40.0 ms at the recovery of the two fault sessions, which PEAR's runs have at the
same place (B: 40.7 and 40.1 ms): a read the recovery leaves out, not a late step. The others are the planner's
above. During `open` the enable's waits read every 19.7 to 19.8 ms on average (PEAR's: 20.5 ms). The clock's own
count: in every session of runs c and d a sleep ended 0.003 ms after its hour on average, or less; the latest
ended 16.3 ms after it in run c (the planner's, in "what the station refuses") and 4.9 ms in run d.

### From Node for Windows

Node 24.18.1 for Windows against the same chain, where the clock keeps the period with a busy thread, pear.js's
own kinematics, each session on a chain started anew.

With the slow control calls, five sessions once (the shortest, "what the station refuses", "the operator pauses"
and the two with a fault; 299 steps). All five pass: beside the stepped run and beside A no step raises on one
side only, no result differs, no report text differs; the chain's counters are 0. Beside the stepped run 4 turn
texts differ (the two fault sessions, 2 each), 8 of 10 measured positions of completed actions are identical, and
the largest differences are y 2 cm and 0.081 rad (53 counts), in a fault session. The period on the line: 4,045
periods, mean 20.026 ms, p99 22.96 ms, largest 55.9 ms, 29 over 25 ms (7 over 30 ms), each late step followed by a
short one; during `open` the first waits take 28 to 33 ms, until the clock has learnt the timers.

With a connection a call, three sessions once (the shortest and the two with a fault; 103 steps). All three pass,
beside the stepped run, A and B; the counters are 0. The ticks are PEAR's (77, 784 and 780 where A has 78, 784 and
776), and an `open` has 27 reads as in PEAR's runs. The torque session reads as the stepped run in every turn text
and every measured position (the action began at read 585 and the fault was noticed 1 read after it arrived); the
overload was noticed 9 reads after it arrived and its session differs in 2 turn texts, by y 0.6 cm. The period on
the line: 1,641 periods, mean 20.024 ms, p99 22.37 ms, largest 40.1 ms (the recovery's), 8 over 25 ms. The other
five sessions were not run so.

### With PEAR's kinematics' answers

The answers of `station_kinematics.json` are those of PEAR's stepped run, given in their order. In real time they
are PEAR's answers to the same questions only where the arm rests where it rested in the stepped run. With a
connection a call, all 8 sessions once on Node for Linux: all pass, and beside the stepped run no row of the test
differs, 84 of 85 turn texts are the same, and the measured positions of all 59 completed actions are identical in
every bit; the run takes 11,592 ticks. Of the 61 questions asked, 59 were the stepped run's in every bit. The two
others: one in "a task", which changed nothing the model reads; and one in "a servo reports overload during a
move", where the arm had stopped elsewhere (the fault noticed 8 reads after it arrived, 6 in the stepped run) and
the answer given was PEAR's to PEAR's question: a joint target, so the arm went where PEAR's went and not by what
was asked, and one turn text differs, by y 0.3 cm. The test's line counts them (`asked_otherwise`). In this run
the torque loss was noticed 1 read after it arrived, and that session is the stepped run's in every text and every
position. Before the change three sessions had been run so (the shortest, "the operator pauses", the overload),
and one more with it, where the torque loss was noticed 11 reads after it arrived.

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
- **In real time**, on the chain started with `realtime`, anew for every run: `PEAR_JS_SIM_BRIDGE_STATION_REALTIME=
  <host:port> PEAR_JS_STATION_SESSIONS=<name> PEAR_JS_STATION_REALTIME_REFERENCE=<A's result>;<B's result>
  PEAR_JS_STATION_OUT=<directory> npx vitest run tests/sim-bridge/station_realtime.test.ts -t "own kinematics"`.
  2026-11-15, with the slow control calls: 16 runs on Node 22.22.2 for Linux (each session twice), 5 on Node
  24.18.1 for Windows (beside A only), and 3 with PEAR's answers on Linux. 2026-11-16, by a second hand: 4 runs on
  Linux before the change; then, with a connection a call, 19 on Linux (each session twice, and three single
  sessions), 9 with PEAR's answers (each session, the torque session twice) and 3 on Windows. Every run passes.
  The tables are the reference's comparison tool on the results put together a run (652 steps each), and the
  test's own counts agree with it. The periods and the reads of "When a fault is noticed" are read from the chain's
  byte logs. The rows asserted were found in PEAR's three stored results with the same tool.
- **The test in real time can fail.** Breaks of the port, in a scratch copy, one at a time, each run on the
  session that meets it: a result whose `reached` is turned around (`src/station/motion/results.ts`; the shortest
  session: `reached` and the report text differ); a jaw that stopped on an object reported as closed
  (`src/so101/joint/grippers.ts`; "the jaw stops on an object": the gripper's outcome, `reached` and the report
  text differ); another wording of the refusal of a target outside the commissioned bounds ("actions outside the
  model's format": the error and the report text differ). All three runs fail, each in the rows it should.
- **The stepped mode after the runner's changes**: after the real-time mode was added, the gated stepped test on a
  chain started anew, the shortest session: 85 differences in 4 steps with pear.js's own kinematics and 0 with
  PEAR's answers, as before. After the control calls took a connection each: all 8 sessions both ways, and
  `sim-bridge.test.ts` ("The runner's calls of the chain's controls").
- **The replay on a hosted runner** (Node 24, Linux): it passed, the file's 12 tests in 5.9 s.
- Without the chain: `npx vitest run`: 75 files pass, 3 are skipped; 9,169 tests pass, 10 are skipped (the 4 gated
  tests of `sim-bridge.test.ts`, the 2 of `station_chain.test.ts`, the 2 of `station_realtime.test.ts` and the 2 of
  the joint layer that measure real time). `npx tsc --noEmit` is clean.

## Not verified

- The replay on other engines than the three it has run on (Node 24.18.1 for Windows and Node 22.22.2 for Linux,
  both x64: all 12 tests pass on both, and the run with pear.js's own kinematics gives the same counts on both, the
  26 goal writes and the 9,048 numbers in 467 steps; and Node 24 for Linux on a hosted runner, where the 12 pass).
  The exact run takes PEAR's values for both known causes; the run with pear.js's own kinematics uses the engine's
  functions, and whether another engine's last bits change a count or a tick there is not known.
- Anything on a real arm, and anything through Web Serial: the line here is a TCP connection in Node.
- In real time: the numbers are from four runs a session on one machine with Node 22 for Linux (two of them with
  the quick control calls), and from a few sessions run once with Node 24 for Windows. No browser has run it:
  neither a page's nor a worker's timers under `realTimeClock()`, nor Web Serial, have met a line.
- A fault at every phase of the polls. The runs met two phases of the torque loss (noticed 1 and 11 reads after
  it arrived) and three of the overload (6, 8 and 9), by chance: in real time the script does not choose the read
  at which a fault arrives.
- What a planner's computation longer than a control period does to the station: the latest step seen came 16.8 ms
  after its hour (a period of 36.8 ms), and nothing came of it.
- A feedforward other than zero, lost answers and retries under the station, a timeout of an action, a pause
  during Home: the script has none (see `station-reference.md`).
- With pear.js's own kinematics a goal can differ by a count where a trajectory ends on the edge between two; over
  this script it happened once and changed no result. Nothing bounds it in general.
- The names of PEAR's loggers other than the two the reference's runs show.

## Left

- Done since: a run of pear.js's station in real time beside the reference's two real-time runs (the section "In
  real time"), in Node. Left of it: the same from a page (the page's timers, Web Serial); and a script whose
  faults arrive at a chosen read, so that a real-time run meets the phase of the polls it means to.
- The tests on the chain need the chain, so they do not run where the chain is not. Continuous integration runs
  the replay instead: it holds pear.js's station to the stored result of PEAR's run, and not the chain, the
  reference or a station that leaves PEAR's run to anything. Nothing in real time runs there.
- Done since: the first run of the replay on a hosted runner (Node 24, Linux): it passed, the file's 12 tests in
  5.9 s.
