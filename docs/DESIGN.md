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
| `src/station/joint/`, `src/station/schemas.ts` | `deploy/station/control/schemas.py`; `deploy/station/control/joint/` `config.py`, `limits.py`, `layout.py`, `texts.py`, `arm_state.py`, `stability.py`, `tracking.py`, `action_guard.py`, `snapshot_checks.py`, `feedforward.py`, `driver.py`; `deploy/station/exceptions.py` |
| `src/so101/joint/` | `deploy/station/control/robots/so101/joint/feedforward.py`; the checks of `deploy/station/control/robots/so101/config.py` are in `src/so101/config.ts` |
| `src/agent/` | `deploy/station/agent_loop/` `agent_loop.py`, `schemas.py`, `config.py`, `messages.py` (the frames of a turn); `deploy/station/agent_loop/clients/` `client.py`, `vllm.py`, `schemas.py`, `metrics.py`, `health_checks.py`; what those run of the OpenAI Python SDK |
| `src/station/` (next) | `deploy/station/control/joint/` `trajectory.py`, `operations.py`, `control_loop.py`, `recovery.py`; `deploy/station/control/motion/` `execution.py`, `planning.py`, `homing.py`; `deploy/station/control/robot.py`, `cameras.py`; the SO-101's `joint/grippers.py`, `joint/control_loop.py`, `motion/planning.py`, `motion/homing.py`, `robot.py` |
| `web/` (next) | Not in PEAR: a page that reaches the arm through Web Serial and the wrist camera through the browser |
| `tests/sim-bridge/` | Not in PEAR: the servo layer on a simulated SO-101 servo chain over TCP, compared packet by packet with PEAR's Python on the same chain |

## Verification ladder

Each step is claimed only when it has been run.

1. Protocol: every text equal to PEAR's (fixtures).
2. Kinematics: equal to PEAR within stated tolerances (fixtures).
3. Feetech: packets equal to the reference SDK's; a simulated servo bus in TypeScript; and, on a simulated SO-101
   servo chain over TCP, the packets PEAR's Python sends on the same chain (`docs/progress/sim-bridge.md`).
4. Station: actions executed on a simulated SO-101 give the results PEAR's Python station gives.
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
- A transport is handed to the bus already open; pear.js never scans for ports or changes baud rates.

The control loop: PEAR streams joint targets from a 50 Hz loop in its own process. pear.js ports that loop as it is,
with the trajectory generator it calls (`src/ruckig`), and takes its clock as a parameter. PEAR's loop advances a
motion by one control period at each step, whatever the wall clock says, and never runs several periods in a burst
after a stall: a period that comes late stretches the motion and skips none of it. That holds in a page too, where
a hidden tab's timers are slowed, and between two steps the servos hold the last target they were sent. Measured in
Node on a simulated servo chain, a period's read and send take about 1 ms of the 20 ms
(`docs/progress/sim-bridge.md`); what a page's timers and Web Serial add is still to be measured on a real adapter.

## Safety

The model does what it is asked and is not a safety mechanism. The station bounds what an answer can do: joint
limits, a bound on each increment, speed and acceleration limits, a stop that latches. A page that drives an arm
keeps a visible stop control and assumes a person is at the arm. When the page is closed the servos hold their
last target; pear.js has no process that outlives the page.

## Conventions

- TypeScript, `strict`. Two-space indentation, double quotes, semicolons.
- A comment says what a reader cannot see in the code: a constraint, a unit, where a number comes from.
- Tests live in `tests/<module>/*.test.ts`; fixtures in `tests/fixtures/<module>/`.
- Progress notes for work in flight: `docs/progress/<module>.md` (what is done, how it was verified, what is next).
