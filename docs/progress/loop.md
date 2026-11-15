# Progress: the joint control loop (`src/station/joint`, `src/so101/joint`)

State: **in progress.** This note is updated after each finished part; a restarted session continues from "Left".

Paths below are under `pear/deploy/station/control/` in PEAR unless they say otherwise.

## Done

Nothing is finished yet. Reading done: `docs/DESIGN.md`, `docs/progress/joint.md`, `docs/progress/ruckig.md`, the six
PEAR files, PEAR's rig (`tests/deploy/station/control_rig.py`, `stand_in_joint_driver.py`, `conftest.py`) and its
tests (`test_joint_control_in_station.py`, `test_so101_joint_in_station.py`, `test_stability_in_station.py`).

## Plan (decided, not yet done)

| File | Ports |
| --- | --- |
| `src/station/joint/trajectory.ts` | `joint/trajectory.py`: `CommandSample`, `JointTrajectory`, `GripperProfile`, `JointMove` |
| `src/station/joint/operations.ts` | `joint/operations.py` |
| `src/station/joint/recovery.ts` | `joint/recovery.py` |
| `src/station/joint/control_loop.ts` | `joint/control_loop.py`: `Braking`, `JointControlLoop` |
| `src/so101/joint/control_loop.ts` | `robots/so101/joint/control_loop.py` |
| `src/so101/joint/grippers.ts` | `robots/so101/joint/grippers.py` |
| `tools/fixtures/loop_fixtures.py` | writes `tests/fixtures/station-loop/*.json` from PEAR's own classes on PEAR's own rig |
| `tests/station-loop/` | the stand-in drivers of PEAR's tests in TypeScript, the scenario player, the tests |

Decisions taken while reading:

- A method is asynchronous if and only if PEAR's can read or send through the driver, sleep, or wait for the loop.
- One small asynchronous mutex stands for PEAR's `RLock` around every block that holds an await.
- The stand-in drivers of PEAR's tests are ported under `tests/station-loop` (not a replay of recorded readings): the
  loop under test then closes the loop itself, as on PEAR's rig, and what it reads is compared too (the snapshot).
- A result of Ruckig that the Python module has no name for (-101) is the module's own `ValueError`
  (`-101 is not a valid Result.`), as `docs/progress/ruckig.md` asks.

## Left

1. DONE (written, `npx tsc --noEmit` exits 0, nothing verified against PEAR yet): the six source files; exports in
   the two `index.ts`. Do not rewrite them: change them in place.
2. DONE (runs in 5 s; writes `tests/fixtures/station-loop/` `meta.json`, `trajectory.json.gz`, `loops.json.gz`,
   `run.json`: 266 scenarios, 16,680 control periods, 947 KB at scale 1). Do not rewrite it: change it in place.
   `tools/fixtures/loop_fixtures.py`: trajectory cases, then loop scenarios; `--scale`, `--output`, the commit check.
3. `tests/station-loop`: the stand-ins, the player, the comparison (exact with the reference's C library values, and
   the deviations with the engine's own).
4. Interleaving tests (a caller's stop, move, recover and close during a step) and `run()` on a virtual clock.
5. The larger run, the breakage table, this note in full.
