# Progress: SO-101 kinematics (`src/so101/kinematics`, `src/so101/layout.ts`, `src/so101/config.ts`)

State: forward kinematics, PEAR's pose quantities, the inverse kinematics of a pose increment (`joint_target`), the
position bounds and their texts are ported and compared with PEAR's own Python on committed fixtures. Nothing here has
run in a browser or against an arm.

## What exists

| File | Ports |
| --- | --- |
| `assets/pear/so101/so101_new_calib.urdf`, `README.md` | PEAR's description of the arm, unchanged (LF, sha256 `faed6e0b…506e`), with its origin |
| `src/so101/layout.ts` | `robots/so101/layout.py`; of `joint/layout.py` and `joint/texts.py`: the vector's shape, units, finite check, the control texts verbatim |
| `src/so101/config.ts` | the `robot` node of `robots/so101/config.yaml` as `SO101_DEFAULT_CONFIG` (PEAR's keys), the sections' types of `robots/so101/config.py`; every value a station must measure is marked "station" |
| `src/so101/kinematics/chain.ts` | the chain `base_link` → `gripper_frame_link` transcribed from the URDF; forward kinematics and Jacobian as pinocchio computes them |
| `src/so101/kinematics/solver.ts`, `qp.ts` | one step of lerobot's `RobotKinematics.inverse_kinematics` on placo (see "How the solver was ported") |
| `src/so101/kinematics/base.ts` | `motion/kinematics.py`: `reachable_fraction`, `rotation_distance`, `truncated_text` |
| `src/so101/kinematics/kinematics.ts` | `robots/so101/motion/kinematics.py`: `pose`, `quantities`, `joint_target`, `unreachable_message`, `_solve` and the pose convention |
| `src/so101/kinematics/limits.ts` | `joint/limits.py`: `check_positions` and its message; `RobotConfig.joint_limits` (bounds and feedback tolerance) |
| `src/so101/kinematics/errors.ts` | `UnreachablePoseError`, and `ValueError` for Python's; `.name` is the Python class name, which the station reports as the error's code |
| `src/so101/kinematics/text.ts`, `linalg.ts` | Python's `round`, `.nf`, `+g` and `str.format` templates (exact, ties to even); 3-vector and 3x3 arithmetic, pinocchio's `log3` |
| `tools/fixtures/kinematics_fixtures.py` | writes `tests/fixtures/so101-kinematics/*.json` from PEAR's `SO101Kinematics` on PEAR's defaults |

`src/` uses no Node API and no dependency (it needs `BigInt` and `DataView`, ES2020).

## How it was verified

Fixtures: `<work dir>/envs/station/bin/python tools/fixtures/kinematics_fixtures.py` (CPU, about 2 minutes; placo
0.9.15, lerobot 0.6.1, numpy 2.2.6, PEAR at `f32aa1f7`). Two consecutive runs gave byte-identical files. Total
1,122,260 bytes: `joint_targets.json` 617 KB, `poses.json` 343 KB, `texts.json` 89 KB, `steps.json` 70 KB,
`meta.json` 3 KB. That is over the 1 MB aimed at; dropping the diagnostic `first_error` field would save 51 KB.

Tests: `npx vitest run tests/so101-kinematics` → 6 files, 35 tests, all passing. Node 24.

| What | Cases | Measured |
| --- | --- | --- |
| Chain constant equals the URDF (parsed in the test); asset hash equals the hash of the file PEAR loaded | 5 joints + tip | equal |
| Fingertip frame vs placo | 40 | within 1e-8 (the stored nine digits) |
| `pose` vs PEAR | 2,010 joint vectors (3 named poses, 7 gripper openings, 2,000 random inside the default limits) | largest difference 5.0e-8 cm, 5.0e-9 rad: the rounding of the stored values |
| `quantities` vs PEAR | the same 2,010 | all six rounded values identical (`Object.is`), including widths that are decimal ties (2.25 → 2.2) |
| One solver step vs placo | 200 (75 far poses, 50 near, 75 turned nearly half a turn; 20 start past a limit) | near 5.4e-12 rad; far 5.7e-9; half turn 1.1e-8 (bounds in the test: 1e-10, 2e-8, 2e-8) |
| Active-set QP vs trying every face (no fixture: two methods of pear.js against each other) | 2,000 random bounded programs, a quarter nearly singular | same minimum value on all; the point within 1e-7 on the well-conditioned 1,500 |
| `truncated_text`, `unreachable_message`, bounds refusals vs PEAR | 398, 260, 126 | byte-identical |
| `SO101_DEFAULT_CONFIG`, layout, texts, class constants vs PEAR | `meta.json` | equal |

### `joint_target`: 2,306 starts and increments

By kind (PEAR's outcome): single position 304 solved / 196 out of reach; single rotation 221 / 79; combined 388 /
472; small 273 / 67 (these four are the 2,000 "typical" cases: up to 15 cm and 0.9 rad); start past a limit 24 / 96;
large (to 40 cm and pi) 9 / 115; 30 actions that change nothing; 16 rotations past the planning bound; 16 gripper
readings off [0, 1] (5 refused, 11 solved). In all: 1,230 solved, 1,025 out of reach, 21 refused, 30 unchanged.

| Criterion | Result |
| --- | --- |
| (a) goal's pose within 0.05 cm and 0.002 rad of the requested pose, wherever PEAR finds a solution | **1,195 of 1,230 (97.15%)**. Median 2.6e-3 cm, 99% 7.3e-2 cm, max 9.8e-2 cm; rotation max 3.6e-4 rad. In all 35 misses PEAR's own goal misses by the same amount: see below |
| (b) joint goal within 0.01 rad of PEAR's on ≥ 99% of the reachable cases | 1,229 of 1,230 (99.92%), the same 1,229 within 1e-6 rad; median 2.9e-9, 99% 5.0e-9, max 7.2e-2 rad |
| (c) reachable or not agrees on ≥ 98% | 2,254 of 2,255 (99.96%) |
| (d) percentage in the message within 2 points on ≥ 95% of the unreachable cases | 1,010 of 1,025 (98.54%); same percentage 957 (93.37%); same message byte for byte 947 (92.39%) |
| Refusals not about reach (rotation bound, bounds) | 21 of 21: PEAR's class name and message |
| Actions that change nothing | 30 of 30 returned as given (unchecked, as in PEAR) |

**(a) cannot hold as first worded, and the reason is PEAR's.** PEAR accepts a goal whose pose is within
`position_residual_m` = 0.1 cm and `rotation_residual_rad` = 0.01 rad of the request. Where a joint limit stops the
solver just short, PEAR returns a goal that misses by 0.05 to 0.098 cm; pear.js returns the same joints. The test
asserts what holds: pear.js misses by more than 0.05 cm or 0.002 rad only where PEAR's own goal misses as much, and
never by more than PEAR's residuals.

**Where the disagreements are.** PEAR's `_solve` stops after `ik_iterations` = 200 steps whether or not it converged
(joint change below 1e-7 rad) and then accepts or refuses whatever the last step was. The fixtures record for each case
how many of PEAR's solves ran out of steps (`unsettled`), and PEAR's own answer from start joints moved by 1e-9 rad
(`perturbed`, where it changed):

- Every solve converged in 1,250 of the 2,255 decided cases (969 solved, 281 out of reach). pear.js gives PEAR's
  answer on **1,250 of 1,250**: the goal within 1e-6 rad, or the message byte for byte. This is asserted.
- A solve ran out of steps in 1,005 cases (261 solved, 744 out of reach). pear.js gives PEAR's answer on 926 of them
  (92.14%). The one (b) miss, the one (c) disagreement and all 15 (d) misses are among these.
- PEAR against itself: the 1e-9 rad move changed PEAR's answer in 90 cases, all among those 1,005, and PEAR keeps its
  percentage on 944 of the 1,025 unreachable cases (92.10%), against 957 for pear.js. Asserted: pear.js keeps PEAR's
  percentage at least as often as PEAR does.

A one-off probe (not kept in the repository) followed PEAR's iterates through the 27 cases that the perturbation
left unchanged but pear.js answered differently (1 solved, 26 out of reach, by percentage): each had 1 to 8 solves
that ran all 200 steps, through poses where the step's matrix is nearly singular (smallest eigenvalue between 6e-8
and 1e-16). On the four of them checked step by step, a numpy transcription of the program below, started from each
of PEAR's own iterates, differed from PEAR's next iterate by at most 5.2e-8 rad. So the step is PEAR's; what differs
is the 200th iterate of a loop that does not settle.

## How the solver was ported

PEAR calls lerobot's `RobotKinematics`, which runs placo's `KinematicsSolver` (a QP through eiquadprog). Measured on
placo 0.9.15, one `inverse_kinematics` call is one undamped step:

    minimize    wp |Jp dq - ep|^2 + wo |Jo dq - eo|^2 + 1e-8 |dq|^2     (wp = wo = 1 in PEAR)
    subject to  lower - q <= dq <= upper - q                             (the station's limits)

`Jp`, `Jo`: the tip's Jacobian in base-frame directions; `ep`: target minus tip position (m); `eo`: pinocchio's `log3`
of target·tip⁻¹. There is no noise term and no line search; the regularization is exactly `Problem.regularization` on
the diagonal; a start outside the limits is pulled inside by the first step. The minimum of this program is unique, so
`qp.ts` solves it with an active-set method over the bounds instead of porting eiquadprog. `steps.json` holds placo's
own steps. lerobot's call takes its Jacobian from the last `update_kinematics`, not from the joints it is given; in
PEAR's loop the two always coincide, and the port computes both from the same joints.

## Deliberate differences

1. **The solver is the program above, not placo.** Reason: no runtime dependency, and a browser. Test: `solver.test.ts`.
2. **No description is read at run time**; `geometry.urdf` is not a setting. The chain is a constant checked against the
   URDF by a test; another description goes in through the constructor's `chain` argument (untested).
3. **lerobot's degrees.** PEAR passes joints through degrees and back at every step; the port stays in radians (a
   difference of one unit in the last place).
4. **No lock, no shared instance, no GIL yield**: one thread, and making the kinematics loads nothing.
5. **Plain objects instead of pydantic models.** `quantities` returns `{ arm, gripper }`; `jointTarget` takes
   `{ arm, gripper }` and does not refuse a non-finite increment, which PEAR's `StrictModel` refuses before the
   kinematics see it. The action parser must do that.
6. **Errors** are `ValueError` and `UnreachablePoseError` (JavaScript classes named after Python's).
7. **Templates** accept only `{name}` and `{name:.nf}`, the two forms PEAR's control texts use.

## Not done, not verified

- `JointLimits`: only `check_positions`. `check_command`, `bounds`, `motion_caps`, `check_trajectory` belong with the
  station's motion execution. The settings' range checks (`__post_init__` of the config classes) are not ported.
- Fixtures use PEAR's defaults only. Other limits, residuals or `ik_iterations` are not compared with PEAR; a test
  only checks that the gripper's width follows another `gripper_width_cm`.
- Joint vectors that are not finite or not six long: PEAR fails inside numpy or placo with other errors; untested.
- Not run in a browser. Speed in Node 24: the 2,306 cases, bisections included, take about 3.7 s.
- A committed fixture of placo's iterates along a few non-settling solves would let the test suite itself show the
  step-by-step agreement that the one-off probe showed (about 45 KB).

## To reconcile with the other modules

- **Protocol** (done): `ModelState`, `ArmQuantities`, `GripperQuantity`, `SingleArmDelta`, `ARM_QUANTITIES` and
  `DECIMALS` are the protocol module's (`src/protocol/types.ts`); the kinematics import them, and `jointTarget` takes
  the arm's part of an action (`ArmDelta`). The station's rejection code is the error's `name`, which
  `tests/modules.test.ts` holds equal to the protocol's `UNREACHABLE_POSE_ERROR`.
- **Protocol** (open): Python's number formats exist twice, in `kinematics/text.ts` (`pythonRound`, `formatFixed`,
  `formatGeneral`, the `str.format` templates) and in `protocol/python_float.ts` (`round`, `repr`). Each is tested
  against PEAR; one of each should remain.
- **Feetech / hardware** (done): `JOINTS`, `MOTORS`, `VECTOR_LENGTH`, `GRIPPER_INDEX` are the layout's
  (`src/so101/layout.ts`) and the servo layer re-exports them. Open: the `hardware` defaults (`joint_offsets`,
  `position_p_coefficient`, `status_poll_ticks`) and `HardwareConfig` of `src/so101/config.ts` are not yet what
  `SO101Hardware` is built from.

## Observations about PEAR worth knowing downstream

- The percentage in "at most N%" is itself unstable in PEAR for about 8% of unreachable requests (it moves with the
  ninth decimal of the measured joints), because the bisection probes exactly where the solver does not settle.
- A start that rests past a limit, even within the feedback tolerance, is pulled inside the limits by the first solver
  step, which moves the fingertip: 96 of the 120 such fixture cases are out of reach in PEAR.
- 261 of PEAR's 1,230 solved cases were accepted after the solver ran out of steps without converging.
