# Progress: station-reference

The reference for step 4 of the verification ladder, "actions executed on a simulated SO-101 give the results PEAR's
Python station gives": PEAR's own robot on a simulated SO-101 servo chain that is not part of this repository, run
through a scripted list of what a task does, in such a way that the same script puts the same bytes on the wire and
returns the same results at every run. This note says what the reference is, what the script and a result hold,
and the stepping rule a runner of pear.js's station must reproduce to be compared with it bit for bit.

Nothing under `src/` was written or changed for it. pear.js's station has since been run against it, stepped by
this rule: `station-chain.md` has that run and what it found.

## Result

- PEAR's unmodified `SO101Robot` (its control loop, motion layer, gripper operation, homing, its real driver and
  hardware layer, lerobot, the Feetech SDK) ran 8 scripted sessions on the simulated arm: 652 steps, 72 model
  turns, 81 recorded results, 11,548 control periods, 235.4 simulated seconds, 25,502 instruction packets and
  87,210 status packets.
- **Two runs from a freshly started chain are identical**: 0 of 25,502 instruction packets and 0 of 87,210 status
  packets differ, and no value of any of the 652 steps' records does (results, report texts, turn texts,
  snapshots, tick counts, clock readings). A third run with every processor core kept busy, which took 4 times as
  long on the wall clock, is identical too. The time of such a run is a stand-in clock that only the caller's
  waits advance: nothing in it depends on the wall clock.
- **The same script with PEAR's real loop thread on the wall clock** gives the model the same statuses and the
  same report texts (81 of 81), and the same turn texts but for the turns that follow a motion an event interrupted
  (a pause, a servo's fault): there the arm stops where the event finds it. See "How much is timing".
- The real-time runs also found a way in which PEAR's Python station faults without a servo's fault, after a pause
  of its process: see "Found".

## Done

| File | What it is |
| --- | --- |
| `tests/sim-bridge/make_station_session.py`, `station_session.json` | The script, as data both runners read: one call of the robot a step, every number in the file (standard library only; `python tests/sim-bridge/make_station_session.py` writes the file again) |
| `tests/sim-bridge/station_result.ts` | The types of the session file and of a run's result (`StationRunResult`) |
| `tests/sim-bridge/compare_station.ts` | `compareStationResults()`: two results compared, nothing tolerated, every difference counted under the part of a step it lies in and named by its path |
| `tests/sim-bridge/compare_station.test.ts` | 12 tests, always run: one thing at a time is changed in a copy of a real result and must be found |
| `tests/sim-bridge/station_sample.result.json` | The reference's own result of the shortest session (70 kB): the real result the tests change copies of, and an example of the format |

The reference runner, the tool that compares two results with their byte logs, and the full results are not in this
repository; the runner needs PEAR's station environment, a serial device and the chain's controls.

## What the reference is

PEAR at commit `f32aa1f7`, unchanged: `SO101Robot` made from a station's file by PEAR's own loader and opened as
its console opens it; its `SO101ControlLoop`, its motion layer (planning by `SO101Kinematics` on lerobot's
solver, execution, results), `SO101GripperOperation`, `SO101Homing`, the measured-hold recovery; its `SO101Driver`
and `SO101Hardware`; lerobot 0.6.1's follower and Feetech bus, feetech-servo-sdk 1.0.0, pyserial 3.5, Ruckig
0.15.3, placo 0.9.15, numpy 2.2.6, Python 3.12.15. Its serial device is relayed byte for byte to the chain's line.
The station's settings are PEAR's defaults with the simulated arm's calibrated range and measured gripper widths
(the `station` section of the session file; the runner refuses to run if PEAR's own configuration says otherwise).
The feedforward is PEAR's default, all zeros.

What is replaced, from outside, as PEAR's own tests do it:

1. **The clock.** `time.monotonic` and `time.sleep` are PEAR's `StandInClock`
   (`tests/deploy/station/control_rig.py`), installed the way PEAR's tests install it.
2. **The loop's thread.** The robot's control loop class is PEAR's `SteppedSO101ControlLoop`
   (`tests/deploy/station/stand_in_robots.py`): PEAR's loop whose `start()` starts no thread.
3. **The camera.** PEAR's drawn stand-in camera (`tests/deploy/station/stand_in_cameras.py`); a result keeps of a
   frame only when it arrived.

What is added: a handler on PEAR's loggers that keeps their warnings and errors; a read of
`robot.status(with_snapshot=True)` and of the control loop's `requested_position()` at the end of every step, as
PEAR's page reads the status all the time; and, for the trace below only, wrappers that note each call of the
driver and make it. PEAR's callers (its turn loop and its console) do not run: the script is the list of the calls
they make.

## What the servo chain offers for it

Besides what `sim-bridge.md` lists:

- **A clock for a stepped station.** `GET /state` answers `clock: "packets"`, `steps_per_packet: 0`,
  `steps_per_position_read: 4`, `timestep_s: 0.005`: the simulated arm ages 4 physics steps (20 ms, one control
  period) immediately before each sync read of Present_Position, and at no other time. A control loop reads the
  positions once a step, so the arm ages exactly one period between two steps of the loop whatever else is sent,
  and what the servos answer depends on the packets alone.
- **Controls that take effect at a packet boundary.** `POST /mark`, `/inject` and `/place` are answered at once and
  take effect just before the next instruction packet that is not a sync write (at the latest when `/traffic`,
  `/wait` or `/reset` is asked). A host waits for the answer of every packet a servo answers, so each such packet is
  on the chain's side before the host's next control call; a sync write is answered by nothing and may still be on
  its way. An action ends with a sync write: by this rule the next step's mark still cuts the traffic exactly, and
  a fault set between two steps of the loop appears before the next position read whenever the sync write lands. A
  runner need not keep the rule of `sim-bridge.md` that a control call never follows a sync write.
- `POST /place {object, position_m}` puts an object of the simulated scene at rest somewhere (the script uses
  `small_cube`, a 2 cm cube). `GET /state` also holds the arm's true state (`time_s`, `joints_rad`,
  `gripper_opening`) and, for a session with objects, `fingertip_m`, `grasp_m` and `objects`.

## The script

`station_session.json`: 8 sessions, each on a freshly reset arm. A step is one call of the robot under PEAR's name
(`make_station_session.py` lists them), in the order PEAR's turn loop (`agent_loop/agent_loop.py`) and console
(`gui/console/commands.py`, `task_run.py`, `console.py`, `watchdog.py`) make them:

- **enable**: `open`, `wait_stationary`. **disable**: `close`. **start / resume**: `status` (must be READY), a new
  cancellation; after an action that did not complete also `wait_settled(10)`.
- **a turn**: `wait_stationary`, `observe`, `model_state` (and the turn's text), `wait_stationary(observation)`,
  `hold` (while the model works, the robot is asked every control period whether it still holds the observed pose),
  `execute(answer, reference_observation)`; the result is recorded with its report.
- **an increment out of reach**: nothing more: the run takes the next turn (five times in a row at most).
  **Any other action that did not complete**: the run ends: `stop`, `status(with_snapshot)`, `status`.
- **an answer that is no action**: `parse` raises, `stop`, `failure_result(the error, rejected)`, never dispatched.
- **the operator's pause**: after a tick the script names, the cancellation is set and `stop` called; then `stop`,
  `failure_result(OperatorPaused)`, `status(with_snapshot)`, `status`, `wait_settled(10)`,
  `failure_result(OperatorPaused, "The operator interrupted this turn; ...")`, whose report the next turn reads.
- **a fault**: injected on the chain after a tick the script names; then the run's end, `check_fault`, the
  watchdog's pause, `recover` (refused while the fault lasts), the fault removed, `recover`, `status`, resume.
- **Home**: `status`, a new cancellation, `home` with a plan reviewed for 25 control periods and approved (once: not).

| Session | Steps | Turns | Actions | Ticks | Instruction packets | Status packets | Simulated s | Raised |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a short session from the rest pose | 15 | 1 | 1 | 76 | 324 | 891 | 2.08 | 0 |
| a task | 270 | 42 | 42 | 5404 | 11446 | 39255 | 108.64 | 0 |
| what the station refuses | 124 | 13 | 11 | 922 | 2015 | 6981 | 19.00 | 3 |
| the jaw stops on an object | 55 | 6 | 6 | 1697 | 3665 | 12561 | 34.50 | 0 |
| the operator pauses | 72 | 6 | 5 | 959 | 2198 | 7251 | 19.74 | 1 |
| a servo reports overload during a move | 44 | 2 | 2 | 780 | 1833 | 6615 | 16.14 | 2 |
| a servo loses its torque during a move | 44 | 2 | 2 | 776 | 1824 | 6585 | 16.06 | 2 |
| actions outside the model's format | 28 | 0 | 4 | 934 | 2197 | 7071 | 19.24 | 0 |

- **a task**: Home from the folded rest pose; each axis alone in both directions, 1 cm and 10 to 40 cm; pitch and
  roll, 0.05 rad, 0.7 rad and a roll of 3 rad (the format's bound is pi); three axes at once, every quantity at
  once; a zero increment; the gripper closed on nothing and opened; an arm move with a gripper command; two
  increments out of reach (retried); ten ordinary turns; a model that takes 3 s; Home from away with a closed
  gripper.
- **what the station refuses**: out of reach along x, y, z, in pitch and in roll (past the wrist's joint limit),
  and a sixth time, which ends the run; a rotation above the planning bound; two answers that are no action; a Home
  whose plan is not approved.
- **the jaw stops on an object**: the arm reaches down to the table, a cube is put between the fingers, the gripper
  closes and stops on it (`stopped_before_closed`, `reached: false`), the arm lifts the cube and lets it go.
- **the operator pauses**: 20 ticks into a move; while the model works; 30 ticks into a closing of the gripper.
- **the two faults**: a servo's Status reports overload, a servo loses its torque, each 20 ticks into a move.
- **actions outside the model's format**: the gripper action, a chunk of ten joint targets at 10 Hz, a chunk past
  a joint limit.

What the 81 recorded results are: 49 completed arm moves and holds, 10 completed with the gripper's outcome (5
`open`, 4 `closed`, 1 `stopped_before_closed`), 8 rejected as out of reach (`UnreachablePoseError`), 4 rejected as
`ValueError`, 8 failed as `OperatorPaused`, 2 failed as `RuntimeError` (the station's fault).

## The result

A `StationRunResult` (`station_result.ts`) holds, for every step: what it returned or raised (the Python class's
name and the message); for an executed action the result exactly as PEAR records it (`MotionResult.to_record()`),
the report the next turn tells the model (the format's `result_feedback`), the phases it reported; for
`model_state` the state and the whole text of the turn; the robot's status with its control snapshot at the step's
end; the joint vector the arm heads for; the ticks, the caller's waits and the loop's state after each tick; the
clock at the step's start and end; where the simulated arm truly is; PEAR's warnings and errors; and the step's
packets, which are its segment of the chain's record. `run`, `wall_s` and `wall_ms` belong to one run and are
never compared; everything else is.

## The stepping rule

What a stepped runner must do. With it, a run is a function of the script alone.

1. **The clock is a number.** It reads 100.0 at each session's `reset`. `monotonic()` returns it. Nothing advances
   it but `sleep`.
2. **`sleep(d)` advances the clock by `d`, then steps the control loop once**, if a loop is attached, and returns.
   The loop steps at no other time: there is no thread and no timer. `d` is always the control period,
   `1 / rate_hz` = 0.02, and the clock is the running sum of these doubles from 100.0: after 26 sleeps it reads
   100.5199999999999, not 100.52. The windows compare such sums, so a port must add the same doubles in the same
   order.
3. **The loop is attached when `open()` has returned** and detached when the robot has closed. The loop's
   constructor runs before: its wait for the arm to settle sleeps 26 times with no loop to step, reading the arm
   at each (28 position reads with the one of the enable), and ends by sending the first hold.
4. **Who sleeps.** Every wait of PEAR's robot is one loop (`SnapshotCheck.poll`): try; if done, return; if the
   deadline has passed, raise; `sleep(control period)`; try again. So a wait takes a tick only after a try that
   failed: `wait_stationary` on a settled hold, `observe`, `model_state`, `status`, `stop`, `failure_result`, a
   rejected action and a zero increment take none. The script's own waits are `hold` and `idle` (one sleep a tick)
   and the review of a Home plan.
5. **Within one step of the loop**, in this order: the driver reads the arm (one sync read of Present_Position; the
   reading is stamped with the clock; every 10th reading is followed by a sync read of Status and, 5 readings
   later, of Torque_Enable, counted from the arm's first reading at start-up); the reading is checked; in HOLD the
   settling window is judged and the hold refreshed (which sends nothing while the feedforward is zero); a
   cancellation that is set stops the operation; while RUNNING or STOPPING the next sample is sent (one sync write
   of the goals), also at each tick of the settling that follows the motion's last sample. Any error of the step
   latches the fault and sends one hold at the measured pose. In FAULT a step only reads (with a recovery asked
   for: the servos' torque and Status first, then the positions, then what the recovery does).
6. **The arm ages one control period before each position read** of the loop, and at no other time (the chain does
   it). A tick that reads no position, a recovery refused at its check of the servos, does not age the arm.
7. **What the clock shows.** During one step of the loop every reading of the clock is the same number, and a
   snapshot the caller takes before its next sleep is stamped with that number: the reading's age is 0.
8. **Events of other threads.** "After tick N" of a step means: inside the Nth sleep of the step, after the loop
   has stepped and before the sleep returns. The pause sets the cancellation and calls `robot.stop()` there; a
   fault is posted to the chain there and takes effect before the next position read.
9. **Marks.** After `reset`: `session: <name>`. Before each other step: `<id> <op>`. The chain's record between two
   marks is the step's packets.
10. **Between sessions** nothing carries over: a new robot, a new cancellation, the clock at 100.0.

### One action, traced

The session "a short session from the rest pose": the last tick of `hold`, then `execute` of 2 cm up (66 ticks:
39 moving, 26 settling, 1 that finds the hold). Left: the clock (rounded here). `sample 38` is the 38th reading
of the arm since start-up.

```
100.72    loop.step #10   HOLD: read = sample 37 [+0.0000 -1.6832 +1.6602 +0.9528 -0.0008 +0.0000]; refresh_hold (sends nothing) -> HOLD
100.72  step 009 hold returned
100.72  step 010 execute: planning in the caller (no sleep); the move is dispatched: RUNNING
100.72  SnapshotCheck.poll  sleep(0.02)
100.74    loop.step #1    RUNNING: read = sample 38 [.. -1.6832 +1.6602 +0.9528 ..]; send [.. -1.6832 +1.6602 +0.9528 ..] -> RUNNING
100.74  SnapshotCheck.poll  sleep(0.02)
100.76    loop.step #2    RUNNING: read = sample 39 [.. -1.6832 +1.6586 +0.9528 ..]; send [.. -1.6831 +1.6601 +0.9529 ..] -> RUNNING
   ...
101.50    loop.step #39   RUNNING: read = sample 76 [.. -1.6157 +1.5006 +1.0434 ..]; send [.. -1.6148 +1.5010 +1.0436 ..] -> RUNNING
101.50  SnapshotCheck.poll  sleep(0.02)
101.52    loop.step #40   RUNNING: read = sample 77; send the same goal, the move's last sample              -> RUNNING settling
   ...                    (26 ticks: one read and one send of the same goal each)
102.04    loop.step #66   RUNNING: read = sample 103; send the same goal; the window is stable               -> HOLD
102.04  step 010 execute returned: completed, settled, reached
102.04  step 011 wait_stationary returned (no sleep); 012 observe; 013 model_state
```

On the wire, a tick in HOLD is one sync read; a tick of a motion is one sync read and one sync write, in that
order; every fifth tick has a second sync read after the first. The action's last packet is a sync write.

## How it was verified

2026-11-15. All counts below are from the reference runner's results and the chain's raw byte logs.

- **Two stepped runs**, each on a chain started anew: 652 steps compared, 0 with a difference; instruction packets
  25,502 against 25,502, 0 differing; status packets 87,210 against 87,210, 0 differing; each run's packets cut
  again out of its byte log are the packets of its result (112,712 packets, 0 differing, no stray byte).
- **A third stepped run with every processor core busy** (64 s on the wall clock instead of 16 s), traced: the
  same 0 differences. So the wrappers of the trace change nothing, and nothing depends on the wall clock.
- **What could still depend on the wall clock**, and did not: the Feetech SDK's packet timeout of 50 ms and the
  chain's own rule that drops half a packet after 0.1 s. Neither is reached while every packet is answered: in
  all runs the chain counted 0 unanswered packets, 0 corrupt packets, 0 dropped bytes.
- **The comparison can fail.** `compare_station.test.ts` changes one thing at a time in a copy of the sample (a
  result's status, a measured position by one unit in its last place, a report text, a turn's text, a field of a
  snapshot, a tick count, a state of the loop, a packet changed, added, removed, exchanged, a raise, a warning, a
  counter of the line) and requires it found and named. On the two full runs, 14 changed copies (10 of a result, 4
  of a byte log) were each found, and the untouched pair has no difference.
- `npx vitest run tests/sim-bridge`: 28 tests pass, 4 gated tests are skipped; `npx tsc --noEmit` is clean.
- The chain's change of when a control takes effect was checked against step 3: its parity run again, 1888 of
  1888 instruction packets and 4742 of 4742 status packets equal, every reading identical, 12 refusals equal.

### How much is timing

The same script with nothing replaced: PEAR's loop in its thread, the chain on its real-time clock. Two such runs
(A, B), each beside the stepped run and beside each other:

| | stepped / A | stepped / B | A / B |
| --- | --- | --- | --- |
| steps that raised on one side only (of 652) | 0 | 0 | 0 |
| results differing in status, settled, reached, gripper outcome or error (of 81) | 0 | 0 | 0 |
| report texts differing (of 81) | 0 | 0 | 0 |
| turn texts differing (of 85) | 6 | 2 | 8 |
| measured positions of completed actions identical in every bit (of 59) | 55 | 58 | 54 |
| largest difference of a shown quantity | y 0.4 cm | y 0.3 cm | y 0.4 cm |
| largest difference of a measured joint | 0.023 rad (15 counts) | 0.015 rad (10 counts) | 0.023 rad (15 counts) |
| ticks of all steps but `open` | 11,548 / 11,682 | 11,548 / 11,686 | 11,682 / 11,686 |

Every turn text that differs follows a motion that an event interrupted (the sessions with a pause or a fault):
the pause or the fault lands, or is noticed, a few ticks earlier or later, and the arm stops elsewhere; the
completed actions whose measured positions differ are the ones that start from such a stop. Two real-time runs
differ from each other as much as either differs from the stepped run; in two more such runs the largest
difference was y 2.8 cm, a fault noticed one poll later. Where nothing interrupts a motion, the model reads the
same, and the joints come to rest on the same encoder counts. A real-time action takes up to 5 ticks more than
the stepped one, sometimes 1 or 2 fewer (1.2 % more over the whole script), and what the caller does between two
actions takes real time too.

## Found: a stalled control thread leaves the Feetech SDK one answer behind

Two earlier real-time runs faulted on their own in 3 of 16 enables: `Servo error: shoulder_pan: voltage, encoder,
temperature, current, overload; shoulder_lift: encoder, temperature, overload; ...`, although every servo had
answered Status 0. The chain's byte log and the SDK's code show why:

1. The reference runner's process paused for about 0.1 s (a garbage collection the runner then asked for right
   after the enable) while PEAR's loop thread waited for the answer to a position read.
2. The SDK measures its packet timeout (about 50 ms as lerobot sets it) on the wall clock and looks at it only
   while bytes are missing. When the thread ran again the time was up, and the read gave up without taking the
   answer that had long arrived.
3. lerobot retried. The retry read the first answer; the second stayed in the input, which the SDK never empties
   (`clearPort()` only waits for the output).
4. From then on every sync read returned the answer to the read before it. For positions that is 20 ms of age and
   nobody notices. The next poll of the Status took six position packets: the SDK takes the first data bytes of
   any status packet with the right id, so each servo's Status was the low byte of its position, which are exactly
   the bits PEAR named.

The runner no longer pauses while a robot is open, and the two runs above are without it. The hazard is not the
runner's: any pause of a station longer than the packet timeout while it waits for an answer does the same.
`src/feetech` ports the SDK as it is, input never emptied (`clearPort`); a page that is throttled or busy for 50 ms
is such a pause. Whether pear.js keeps the SDK's behaviour here or refuses a status packet of another length than
the one asked for is a decision for the bus; it would be a deliberate difference.

## Ticks and simulated time

Stepped run; a tick is 20 ms of the station's clock and of the simulated arm.

| Step | Ticks |
| --- | --- |
| `open` | 0 (26 waits before there is a loop; 0.56 s) |
| `wait_stationary`, `observe`, `model_state`, `status`, `stop`, `failure_result`, `close` on a settled hold | 0 |
| an arm move: of 1 cm / of 10 to 40 cm / a roll of 3 rad | 54 to 63 / 99 to 142 / 210 (the motion, then 25 or 26 of settling, then 1) |
| the gripper, closed or opened over its whole travel | 148 or 149 (122 + 25 or 26 + 1) |
| the gripper closing on the cube | 175 (148 + 26 + 1) |
| an arm move of 3 cm and the gripper | 226 |
| an action that is rejected, a zero increment | 0 |
| Home from the rest pose, the gripper closed | 547 (25 of review, 149 opening, 373 returning: 10.9 s) |
| a move paused after 20 ticks, then `wait_settled` | 20, then 38 (11 braking, 26 settling, 1) |
| a gripper operation paused after 30 ticks, then `wait_settled` | 30, then 27 |
| a fault set after tick 20 | the action ends at tick 26 (Status) and 21 (torque): the next poll |
| `recover`, refused / done | 1 / 54 (26 checking stability, 27 verifying the new hold, 1) |

## What a port must know

- **Settling takes 25 or 26 ticks**, by the clock's sum alone: the window is complete when the stamps of its first
  and last reading are at least 0.5 apart, and 25 additions of 0.02 give a little less (then a 26th tick is
  needed, and the window ends at 0.5199999999998965) or a little more (0.5000000000001847 to ...2558). Of 79
  settlings 45 took 26 and 34 took 25: every one of 26 ended with the clock below 128 and every one of 25 above
  it, where doubles lie twice as far apart. A port whose clock is not this sum of doubles (milliseconds, or a tick
  count times the period) will differ by a tick in some of them, and then in every packet after.
- **A short action still takes more than a second**: the 0.5 s window is counted from the motion's last sample.
- **Nothing is sent while holding**, and the first turn after `open` needs no wait: the enable's own settling
  counts as the first window.
- **Out of reach is no failure of the run**: status `rejected`, `settled: true`, no tick, and the report is the
  format's `out_of_reach` text with how far the arm can go ("at most 32% (x +12.8 of +40)").
- **`reached` is false after the jaw stopped on an object**, with status `completed` and `gripper` saying
  `stopped_before_closed`.
- **A paused action is recorded three times** by PEAR's callers: by `execute` itself (failed, not settled, measured
  in motion), by the turn loop, and by the task's run after the arm has settled; the model reads the third.
- **A fault is noticed at the next poll**, up to 10 ticks late, and `recover()` raises the servo's own fault
  (`ServoFault`) while the servo still reports it; the action's own error is `RuntimeError`, "Station fault: FAULT:
  ...". While in FAULT the loop logs "feedback read failed in FAULT" once for each poll that fails.
- **The snapshot's numbers are compared in every bit**: after a hold was sent, the feedforward's zeros are `-0.0`
  for the joints whose gravity torque is negative (zero times a negative number), and stay so in the JSON.
- **`An action did not complete`** is logged as an error for every action that is rejected or fails: 14 times here.
- PEAR's logger names are Python module paths: a port's `log` will differ from the reference's in that part alone.

## Not verified

- This note is the reference's side alone: what pear.js's station does with the script is in `station-chain.md`.
- A feedforward other than zero (then a hold sends sync writes while the friction offset fades).
- Lost answers and retries under the station (the SDK's timeout is on the wall clock): step 3 covers them below it.
- Timeouts of an action, a persistent motion during a hold, a tracking error, a pause during Home: not scripted.
- Anything on a real arm. The simulated arm's physics, its overload after 2 s at the torque limit and its answers
  are the chain's own; in a trial outside the script the arm pressed its open jaw into the table and the station
  faulted on the chain's own overload.
- The real-time numbers are from two runs on one machine.

## Left

- Done since (`station-chain.md`): a stepped runner of pear.js's station, and its result compared with the
  reference's result of all 8 sessions. That result is in the repository now
  (`tests/sim-bridge/station_reference.result.json.gz`, less the one entry of its `run` record that named a path),
  and a test replays its line to pear.js's station where no chain is.
- A run of pear.js's station in real time beside the two real-time runs of the reference above.
