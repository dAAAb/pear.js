# Design

## What pear.js is

A TypeScript port of the *robot station* half of [PEAR](https://github.com/mit-han-lab/pear), at commit
`f32aa1f7c2ec9c3f45630cc9f8541b3201e8e087`, for an SO-101 arm reached from a browser.

The other half, the model server, is not ported. pear.js talks to any server that serves a PEAR model through the
OpenAI-compatible Chat Completions API: PEAR's own vLLM server, or a gateway in front of one.

One turn of the station, as PEAR defines it and pear.js keeps it:

1. Wait until the arm is at rest; read its joints and take one frame of the wrist camera.
2. Show the model the arm's state (the fixed fingertip's x, y, z in cm, its pitch and roll in rad, the gripper's
   width), the report of the previous action, and the frame.
3. The model reasons and ends its answer with one fenced `json` block: an increment of the fingertip's pose and a
   gripper command.
4. Solve the inverse kinematics; if the pose cannot be reached, nothing moves and the model is told so.
5. Move, settle, judge what the gripper did, and report.

## Rules of the port

- **The model's view is byte-identical.** The system prompt, the text of every turn and the report of every action
  are the same strings PEAR produces for the same inputs, and every number shown is rounded as PEAR rounds it.
  The model was trained against these texts.
- **Every ported file names its source.** A TypeScript file that ports a Python file starts with a comment giving
  the PEAR path. Files under `assets/pear/` are PEAR's own files, unchanged, with a README that lists where each
  came from.
- **Tests compare with PEAR, not with expectations written by hand.** `tools/fixtures/*.py` run PEAR's Python at
  the pinned commit and write JSON to `tests/fixtures/`. The fixtures are committed; `npm test` needs only Node.
  A fixture script takes no machine-specific path: it runs inside a PEAR station environment
  (`<work dir>/envs/station/bin/python tools/fixtures/<name>.py`) and writes relative to the repository.
  Where PEAR's Python cannot give a record, because the thing exists only in a page (a call that arrives while a
  control period is under way, a write into a vector PEAR holds as a tuple, where a line is logged when nobody
  asked for the log), a test compares pear.js with itself or with an expectation written by hand; its file says so
  at its top, and the module's note counts such tests apart from the others. Where such an expectation can be
  taken from a run of PEAR's own classes, the script of that run is kept under `tools/rows/`.
- **The core has no runtime dependencies** and runs in a browser and in Node 20 or newer: ES modules, no Node-only
  API under `src/` (tests and tools may use Node's).
- **A deliberate difference is written down** in the section of that name below, with its reason and its test.
- This repository is public. No file holds a local path, a machine or user name, an address, a key or a token.

## Module map

| pear.js | Ports (paths under `pear/` in PEAR) |
| --- | --- |
| `src/protocol/` | `agent_loop/protocol.py`; `deploy/station/agent_loop/` `messages.py`, `action_parser.py`, `system_prompt.md`; `deploy/station/control/motion/` `actions.py`, `results.py`; `deploy/station/control/robots/so101/` `formats.py`, `motion/actions.py`, `motion/results.py`, `prompts/single_arm_pose.md` |
| `src/so101/kinematics/` | `deploy/station/control/robots/so101/` `layout.py`, `config.py` and `config.yaml` (geometry, limits), `motion/kinematics.py`, `description/so101_new_calib.urdf`; `deploy/station/control/motion/kinematics.py`; `deploy/station/control/joint/limits.py`; lerobot's `RobotKinematics` as those files use it |
| `src/feetech/` | Not PEAR's own code: the Feetech STS3215 protocol as the Feetech Python SDK and lerobot's `FeetechMotorsBus` speak it (PEAR drives the arm through them); a simulated servo chain |
| `src/so101/hardware/` | `deploy/station/control/robots/so101/hardware/` `arms.py`, `driver.py`, `startup.py`, `arm_state.py`; lerobot's SO follower and its calibration file |
| `src/ruckig/` | Not PEAR's own code: Ruckig 0.15.3, community edition (MIT), which `deploy/station/control/joint/trajectory.py` calls every control period |
| `src/station/joint/`, `src/station/schemas.ts` | `deploy/station/control/schemas.py`; `deploy/station/control/joint/` `config.py`, `limits.py`, `layout.py`, `texts.py`, `arm_state.py`, `stability.py`, `tracking.py`, `action_guard.py`, `snapshot_checks.py`, `feedforward.py`, `driver.py`, and the control loop: `trajectory.py`, `operations.py`, `control_loop.py`, `recovery.py`; `deploy/station/exceptions.py`. Not in PEAR: `clock.ts` and `deadline_clock.ts`, the time the joint layer reads and sleeps on where PEAR calls `time.monotonic()` and `time.sleep()` |
| `src/so101/joint/` | `deploy/station/control/robots/so101/joint/` `feedforward.py`, `grippers.py`, `control_loop.py`; the checks of `deploy/station/control/robots/so101/config.py` are in `src/so101/config.ts` |
| `src/agent/` | `deploy/station/agent_loop/` `agent_loop.py`, `schemas.py`, `config.py`, `messages.py` (the frames of a turn); `deploy/station/agent_loop/clients/` `client.py`, `vllm.py`, `schemas.py`, `metrics.py`, `health_checks.py`; what those run of the OpenAI Python SDK |
| `src/python/` | Not PEAR's own code: what PEAR's texts and results take from Python itself (CPython 3.12), in one place for every module: the built-in exceptions under their names and bases, with how PEAR reads an error it caught (`type(error).__name__`, `isinstance(error, ValueError)`); `repr` of a float, `round` and the format specifications, `json.dumps` and `json.loads`, `repr` and `str` of a value, `str.isprintable`, whitespace |
| `src/station/motion/`, `src/station/robot.ts`, `src/station/cameras.ts` | `deploy/station/control/motion/` `actions.py`, `results.py`, `execution.py`, `planning.py`, `homing.py`; `deploy/station/control/robot.py`, `cameras.py`. `robot.ts` also holds what is not in PEAR: the adapter through which the turn loop of `src/agent/` drives a robot |
| `src/so101/motion/`, `src/so101/robot.ts`, `src/so101/formats.ts`, `src/so101/hardware/cameras.ts` | `deploy/station/control/robots/so101/` `motion/planning.py`, `motion/homing.py`, `motion/actions.py`, `motion/results.py`, `formats.py`, `robot.py`, `hardware/cameras.py` |
| `src/console/` | `deploy/station/gui/console/` `task_run.py`, `phase.py`; of `deploy/station/records/` the kinds of a task's events (`task_events.py`) and the names of a task's records (`task_files.py`). The rest of the console (`console.py`, `commands.py`, `watchdog.py` and the others) is not ported yet (`docs/progress/console.md`) |
| `web/` | Not in PEAR: the page, which GitHub Pages builds from this directory. It reaches the arm through Web Serial and the wrist camera through the browser. With a real arm it only reads: a guard between the bus and the port lets only PING, READ and SYNC READ through. The station (the robot, its control loop, its driver) runs in a dedicated Worker of the page, so far only on a simulated arm that the Worker makes itself (`docs/progress/web.md`) |
| `tests/sim-bridge/` | Not in PEAR: the servo layer on a simulated SO-101 servo chain over TCP, compared packet by packet with PEAR's Python on the same chain; PEAR's own robot stepped on that chain, recorded as the reference for step 4 of the ladder (`docs/progress/station-reference.md`); and pear.js's own station on that chain, stepped and in real time, compared with that reference (`docs/progress/station-chain.md`). The chain is not part of this repository, and the tests that need it are skipped without it |

## Verification ladder

Each step is claimed only when it has been run.

1. Protocol: every text equal to PEAR's (fixtures).
2. Kinematics: equal to PEAR within stated tolerances (fixtures).
3. Feetech: packets equal to the reference SDK's; a simulated servo bus in TypeScript; and, on a simulated SO-101
   servo chain over TCP, the packets PEAR's Python sends on the same chain (`docs/progress/sim-bridge.md`).
4. Station: actions executed on a simulated SO-101 give the results PEAR's Python station gives. Run with the
   clock stepped one control period at a time: on the stand-in arm of PEAR's own tests, the control loop period by
   period (`docs/progress/loop.md`) and the robot's sessions and the turn loop's 19 tasks
   (`docs/progress/robot.md`); on a simulated SO-101 servo chain, the whole station through 8 scripted sessions,
   with the packets and the results of PEAR's own station on that chain (`docs/progress/station-chain.md`). The
   chain is not in this repository; what every run of the tests repeats is the station on the recorded line of
   PEAR's run of those sessions, replayed. In real time (in Node; the port's own loop on its own clock) the
   station on that chain keeps every row that PEAR's own two real-time runs keep; where the arm stops after a
   fault depends on the phase of PEAR's polls of the servos, in PEAR's runs too. In a browser the station runs
   in a Worker of the page on a simulated arm of the Worker's own (`docs/progress/web.md`): the page's checks
   hold it to the format's texts and to what the arm did, not to a run of PEAR's.
5. A real model drives the simulated arm through pear.js.
6. A real SO-101, by a person at the arm.

## Deliberate differences from PEAR

Each module lists its own under "Deliberate differences" in `docs/progress/<module>.md`. The ones that shape the
library:

- Calls that reach the arm are asynchronous, and the bus makes them take turns; Python's block.
- Python's exceptions become JavaScript error classes that carry the Python class name, because that name is what
  the model reads of a refused action (`error.code`).
- The inverse kinematics solve the same optimisation problem as PEAR's solver (placo) with code of their own, and
  no robot description is read at run time: the kinematic chain is a constant, checked against the URDF by a test.
- A transport is handed to the bus already open; the library never scans for ports or changes baud rates. (The page
  looks for servos at the other baud rates when none answers, by reopening the port and pinging; it writes nothing.)
- Before a command the bus drops bytes left over from an answer that came late. The Feetech SDK does not, so after
  one stalled moment PEAR's Python reads every later answer one behind, and a page stalls more often than a process
  does (`docs/progress/feetech.md`). No packet that is sent changes.
- A camera frame is encoded by the browser, not by PIL. In Chromium the decoded picture is the same, pixel for
  pixel, and the file's bytes differ (`docs/progress/web.md`).

The control loop: PEAR streams joint targets from a 50 Hz loop in its own process. pear.js ports that loop as it is,
with the trajectory generator it calls (`src/ruckig`), and takes its clock as a parameter. A loop that is given no
clock does not sleep on the engine's timer, whose 20 ms take 31 ms on Node for Windows, too long for the loop to be
enabled: it sleeps on a clock that leaves the wait to a timer until shortly before its hour and waits the rest out
itself, which keeps the period and can cost a busy thread (`src/station/joint/deadline_clock.ts`;
`docs/progress/loop.md`, deliberate difference 12). It is measured in Node and, in a Worker of the page, in
headless Chromium on Linux (`docs/progress/web.md`); not yet in a visible browser window or on macOS.
PEAR's loop advances a
motion by one control period at each step, whatever the wall clock says, and never runs several periods in a burst
after a stall: a period that comes late stretches the motion and skips none of it. That holds in a page too, where
a hidden tab's timers are slowed, and between two steps the servos hold the last target they were sent. Measured in
Node on a simulated servo chain, a period's read and send take about 1 ms of the 20 ms
(`docs/progress/sim-bridge.md`). In a visible page in headless Chromium a 20 ms timer held its period within about
3 ms at the 99th percentile and 6 ms at worst, and no period was skipped (`docs/progress/web.md`); a hidden tab, and
what Web Serial on a real adapter adds, are still to be measured.

PEAR's loop runs in a thread of its own and steps under a lock: a caller's thread waits, so every call falls before
a control period or after it. A page has one thread. There the loop is an asynchronous function, and a call can
arrive while a period awaits the serial line. The loop is written so that such a call acts as PEAR's would just
before that period or just after it, and `tests/station-loop/interleaving.test.ts` and `sweep.test.ts` hold it to
that by comparing with a second loop on which the call is made before and after. PEAR's thread and lock are in no
record, so these tests compare pear.js with itself. What PEAR holds as tuples, an arm's targets and readings, are
frozen arrays: a reader of a snapshot cannot change what the loop holds and commands. What PEAR logs goes to a
`log` option; a loop that is given none prints the error level (a fault, a hold that could not be commanded, the
end of the loop) with `console.error` (`docs/progress/loop.md`, "Deliberate differences").

The robot above the loop keeps PEAR's order of checks and acts. Where PEAR's lock keeps a check and a submission
out of a control period, here both are synchronous, so nothing falls between them, but both can run while a period
awaits the line; `tests/station-robot/periods.test.ts` runs that with control periods started by a ticker, and what
it does not run is listed in `docs/progress/robot.md`. Planning runs on the page's one thread: no control period
starts during a plan. An observation is what PEAR's is, a plain object that its holder can write into, and the
robot plans from what the object holds when it is handed back. A progress handler or an approval that never
settles keeps the robot taken, as a handler that never returns blocks PEAR's thread.

## Safety

The model does what it is asked and is not a safety mechanism. The station bounds what an answer can do: joint
limits, a bound on each increment, speed and acceleration limits, a stop that latches. A page that drives an arm
keeps a visible stop control and assumes a person is at the arm. When the page is closed the servos hold their
last target; pear.js has no process that outlives the page.

To stop an arm, call the control loop's `stop()`: it brakes into a hold, with the torque on. A fault and a timeout
command a hold too; if that command cannot be sent, the loop says so ("Could not command a hold; a physical stop
may be required"). `close()`, `shutdown()` and an `open()` that fails release the hardware as PEAR's do: they
switch the SO-101's torque off, and an arm that is not supported then falls under its own weight. A page's stop
control must never close the loop to stop an arm. The robot's `close()` can reject while an action is under way
although it has released the arm: a page must not take a rejected `close()` for a robot that is still open.

## Conventions

- TypeScript, `strict`. Two-space indentation, double quotes, semicolons.
- A comment says what a reader cannot see in the code: a constraint, a unit, where a number comes from.
- Tests live in `tests/<module>/*.test.ts`; fixtures in `tests/fixtures/<module>/`.
- Progress notes for work in flight: `docs/progress/<module>.md` (what is done, how it was verified, what is next).
