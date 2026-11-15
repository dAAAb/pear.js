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
| `src/feetech/` | The Feetech STS3215 protocol as lerobot's `FeetechMotorsBus` speaks it; `deploy/station/control/robots/so101/hardware/` `arms.py`, `driver.py`, `startup.py`, `arm_state.py` |
| `src/station/` (later) | `deploy/station/control/joint/*`, `deploy/station/control/motion/` `execution.py`, `planning.py`, `homing.py`; the SO-101's `joint/grippers.py`, `motion/planning.py`, `motion/homing.py`, `robot.py`; `deploy/station/agent_loop/agent_loop.py`; `deploy/station/agent_loop/clients/` `client.py`, `vllm.py` |
| `src/web/` (later) | Not in PEAR: the Web Serial transport, camera capture, a demo page |

## Verification ladder

Each step is claimed only when it has been run.

1. Protocol: every text equal to PEAR's (fixtures).
2. Kinematics: equal to PEAR within stated tolerances (fixtures).
3. Feetech: packets equal to the reference SDK's; a simulated servo bus in TypeScript.
4. Station: actions executed on a simulated SO-101 give the results PEAR's Python station gives.
5. A real model drives the simulated arm through pear.js.
6. A real SO-101, by a person at the arm.

## Deliberate differences from PEAR

None yet. Expected when the station is ported: PEAR streams joint targets from a 50 Hz loop in its own process; a
web page cannot promise that timing, so pear.js will lean on the servos' own speed and acceleration limits and on
checks between moves. What that changes for the model (nothing, if the reports stay the same) will be tested at
step 4.

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
