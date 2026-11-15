# Progress: Ruckig (`src/ruckig`)

A TypeScript port of Ruckig 0.15.3 (community edition, MIT, github.com/pantor/ruckig, tag `v0.15.3`, commit
`37b6e7a`), the trajectory generator PEAR's station uses, compared case by case with the `ruckig` Python module of
PEAR's station environment (0.15.3).

State: **all eight stages done.** Every path of the community edition is ported: third-order (finite jerk), and
also second- and first-order (infinite jerk or acceleration cap), position and velocity interface, every
synchronization mode. With the reference's own C library values the port gives the reference's numbers to the last
bit on 109,050 calculations and 1,800 sessions of `update` calls, and in those calculations it hands the same
850,731 candidate profiles to the checks as upstream's C++ compiled from the tag. Nothing here has run in a browser.

## Done

| File | Ports (of the upstream tree) |
| --- | --- |
| `LICENSE` | upstream's `LICENSE`, unchanged (sha256 `f0880ac5…d7d3`) |
| `index.ts` | what the module offers: `Ruckig`, `InputParameter`, `OutputParameter`, `Trajectory`, `Result`, `ControlInterface`, `Synchronization`, `DurationDiscretization`, `RuckigError`, `Profile`, `BrakeProfile`, `Bound` and the enumerations of a profile |
| `ruckig.ts` | `ruckig.hpp`, `calculator.hpp`: `validateInput`, `calculate`, `update`, `reset` |
| `calculator_target.ts` | `calculator_target.hpp`: step 1 per coordinate, synchronization, phase synchronization, step 2 |
| `trajectory.ts` | `trajectory.hpp`: `atTime`, `duration`, `positionExtrema`, `independentMinDurations`, `intermediateDurations`, `profiles`, `getFirstTimeAtPosition` |
| `input_parameter.ts`, `output_parameter.ts`, `result.ts`, `error.ts` | the headers of the same names: validation and its messages, the comparison that decides a recalculation, `passToInput`, the texts |
| `profile.ts`, `block.ts`, `brake.ts`, `roots.ts`, `utils.ts` | the headers of the same names and `brake.cpp` |
| `position_third_step1.ts`, `position_third_step2.ts`, `velocity_third_step1.ts`, `velocity_third_step2.ts` | the `.cpp` files of the same names and their classes in `position.hpp`, `velocity.hpp` |
| `position_second_step1.ts`, `position_second_step2.ts`, `position_first_step1.ts`, `position_first_step2.ts`, `velocity_second_step1.ts`, `velocity_second_step2.ts` | the same for an infinite jerk or acceleration cap |
| `libm.ts` | not upstream's: the five C library functions Ruckig calls that no library rounds correctly, in one place |
| `sort.ts` | not upstream's: the order in which libstdc++'s `std::sort` leaves equal elements |

The interface is the Python module's with the names in camelCase (`current_position` → `currentPosition`, `at_time` →
`atTime`, `position_extrema` → `positionExtrema` with `{ min, max, tMin, tMax }`), `Result` with Ruckig's numbers,
`Synchronization.No` as in Python. `src/ruckig` imports nothing outside its folder and uses no Node API (a test
checks both); it needs `BigInt`, `DataView` and `performance.now`.

How the step files were written: the six `*_third_*` and `*_second_*` files come from the C++ by a converter kept
in `<scratch>/tools` (`convert.py` and one template a file). Every arithmetic line is the C++'s text; only
declarations, `std::` calls, the calls of Profile's checks and the `goto` of step 1 are reworded, and the names of
the numbers are the C++'s (`a0_p3`, `jMax_jMax`). Lines are as long as the C++'s, one expression a line. Edit those
files by hand from now on. The other files are translated by hand.

Run again on the finished files, the converter gives five of the six byte for byte; `position_third_step2.ts`
differs in one line, where a name its method uses only in a comment (`v0_v0`) was taken out of a destructuring by
hand. The same text is the same arithmetic only if the C++ holds nothing that JavaScript reads differently, so
upstream's sources were searched for that: no division of one integer literal by another, no `float`, no `pow`,
`round`, `floor` or `ceil`, and one cast to an integer type (`std::div` of two indices in the synchronization,
which is translated by hand).

## How it was verified

**Fixtures.** `tools/fixtures/ruckig_fixtures.py` runs the Python module and holds no trajectory mathematics.

    <work dir>/envs/station/bin/python tools/fixtures/ruckig_fixtures.py --output tests/fixtures/ruckig

Two runs give identical files. Committed (scale 1): 3,006,827 bytes with the table `libm.json` (197 KB).

| Set | Committed | Large run | What |
| --- | --- | --- | --- |
| `a_pear` | 460 | 34,500 | one coordinate, position interface, target at rest, the SO-101's caps (arm, gripper, Home's third, releases, other scales): from rest, retargeted under way, with a state outside lowered caps, in the middle of a controlled stop |
| `b_general` | 536 | 40,200 | one coordinate, any current and target state, asymmetric caps, minimum duration, discrete duration, numbers at the algorithm's thresholds, a velocity cap of infinity, caps of zero |
| `c_velocity` | 296 | 22,200 | velocity interface: PEAR's stop with higher, equal and lower caps, any velocity target, minimum and discrete duration, zero jerk |
| `d_multi` | 110 | 8,250 | 2, 3, 6, 7 and 14 coordinates: time synchronization from any state, PEAR's `JointMove` (phase, rest to rest), PEAR's retarget and stop of six coordinates, collinear states, `TimeIfNecessary`, `No`, synchronization and interface per coordinate, disabled coordinates, ties |
| `e_sessions` | 24 (1,270 updates) | 1,800 (93,414 updates) | sessions of `update`: PEAR's `JointTrajectory` (hold, `set_target`, advance and accept, retarget under way, stop, the next target), `SequenceOperation`, `JointMove` played and stopped, `GripperProfile` to its endpoint and past it, a recovery's release, and the module's own loop with moving targets, changed caps, a reset, refused inputs |
| `f_refused` | 131 | 131 | every check of the validation and every failure of a calculation: what is returned or raised, word for word; the text of an input and of an output |
| `g_lower` | 52 | 3,900 | infinite jerk cap, infinite acceleration cap, mixed with finite ones |
| `h_sort` | 159 | 8,299 | `std::sort` of 1 to 100 keys with ties, and `std::min`/`std::max` of pairs with NaN and signed zeros, from a C++ program the script compiles with the machine's g++ (the compiler the module was built with) |

Each calculation records the result or the error, the duration, every field of every profile (`t`, `j`, `a`, `v`,
`p`, `pf`, `vf`, `af`, brake and accel profiles, and limits, direction and control signs through the profile's text),
the position extrema, the independent minimum durations, samples of `at_time` (inside, at a phase boundary, at the
ends, past the end, before the start) and probes of `get_first_time_at_position`.

**Tests.** `npx vitest run tests/ruckig` → 6 files, 42 tests, all passing (Node 24, 0.5 s). `npx tsc --noEmit` →
no error in the repository.

1. `exact.test.ts`: the port with the reference's C library values (see "The last digit"). **Every number is the
   same double as the reference's**: outcome, error text, kind of profile, 1,454 calculations and 24 sessions.
   Large run: 109,050 calculations and 1,800 sessions (93,414 updates, 5,716 recalculations, 3,087 raised), all
   identical; the table held 615,110 values and answered 816,920 calls.
2. `calculate.test.ts`, `sessions.test.ts`: the port as it ships, with the engine's own functions; tolerances below.
3. `refused.test.ts`: 131 calls; 79 raised errors word for word, 28 returned values, 20 texts of an input or an
   output, 4 results the Python module cannot name.
4. `sort.test.ts`: the order of 110 sorts (8,250 in the large run) and 49 minima and maxima.
5. `api.test.ts`: copies on get and set, defaults, the deliberate differences, and that `src/ruckig` names its
   sources, has upstream's licence file and reaches the inexact functions only through `libm.ts`.

**Large run** (not committed: 204 MB, written to `<scratch>` and removed after the run):

    <work dir>/envs/station/bin/python tools/fixtures/ruckig_fixtures.py --output <scratch>/big --scale 75
    RUCKIG_FIXTURES=<scratch>/big npx vitest run tests/ruckig        (42 tests pass, 8.6 s)

with `libm.json` built beside it in five rounds (see `tests/ruckig/oracle.ts`). 109,050 calculations, 1,800
sessions, 131 refused calls, 8,299 sorts.

The large run and the breakage table below were repeated on the final files, after the last changes to them (the
two findings of the independent reading, the unused name above): the same count of failing tests for every break,
and the same 202 lines of results as the run before, timings apart.

**Deliberate breakage** (one at a time, each file restored and its hash checked; 42 tests):

| Break | Tests failing |
| --- | --- |
| the order of operations of one line of `profile.ts` (`p + t*(v + …)` written `p + t*v + t*t*(…)`) | 9 (calculate, exact) |
| a sign in the velocity brake (`brake.ts`) | 9 (calculate, exact) |
| `update` no longer advances the input it keeps for the comparison (`ruckig.ts`) | 8 (api, exact, sessions) |
| a coefficient of one candidate profile (`position_third_step1.ts`) | 10 (calculate, exact, sessions) |
| the limiting coordinate of a synchronization (`calculator_target.ts`) | 10 (calculate, exact, refused, sessions) |
| a tie rounded up instead of to even in a message's number (`utils.ts`) | 1 (refused) |
| the pivot of a partition (`sort.ts`) | 1 (sort) |
| `std::min` or `std::max` replaced by `Math.min` or `Math.max` (`roots.ts`) | 1 each (sort); 0 before the fixture held minima and maxima: no calculation of the 109,050 tells them apart |

**Coverage of the candidate profiles.** The step files hold 88 calls of a profile check, one for each family of
candidate profile. Over the large run 62 are accepted at least once. The other 26: five in `time_none_smooth`,
which the Python module cannot reach (`minimize_jerk` is not exposed); four phase checks with control signs UDUD,
which cannot occur (the limiting profile always comes from step 1, which makes only UDDU); the first-order phase
check, which the reference itself never passes (see the observations); one zero-limit case the validation excludes;
and fifteen families for numerical corner cases: thirteen were tried (8 to 1,020 times each) and never accepted,
two were never reached because an earlier candidate of their step always succeeded. Their arithmetic is the C++'s
text; it is not verified by a result.

**Every candidate, accepted or not, against upstream's C++.** A candidate that is tried and refused leaves no
trace in a fixture, so an error in a profile that is never accepted passes every test above: with a sign changed
in the two-step `ACC1_VEL` candidate of step 1, none of the 42 tests fails on the large set. A one-off probe (kept
in `<scratch>/probe`, not in the repository) looks at the candidates themselves. Upstream's sources at the tag are
compiled (g++ 13.3.0, `-std=c++17 -O3`; the binary holds no fused multiply-add) with a wrapper around each of
Profile's five checks that records the kind of check, the control signs, the reached limits, the seven times of
the candidate, the arguments and the verdict; the port runs the same cases with the same wrapper and the
reference's C library values:

    python3 <scratch>/probe/export_cases.py <scratch>/big <scratch>/probe/cases.txt
    bash <scratch>/probe/build.sh; <the driver it builds> <scratch>/probe/cases.txt <scratch>/probe/cpp.txt
    RUCKIG_FIXTURES=<scratch>/big RUCKIG_PROBE=<scratch>/probe/cpp.txt npx vitest run tests/ruckig/zz_probe.test.ts

(the test file is copied into `tests/ruckig` for the run and removed after it). Over the 109,050 calculations of
the large run both hand 850,731 candidates to a check, and for every calculation the number of candidates, two
32-bit hashes over all that is recorded of them, the outcome and the duration are the same: no difference. With the
sign changed as above, 129 calculations differ. So the fourteen candidates that are tried and never accepted
(the thirteen numerical ones and the first-order phase check) are the C++'s as far as they are computed; the twelve
that no case reaches, in the C++ either, remain unverified.

**Independent reading.** A second reader compared the hand-translated files line by line with the C++ (profile,
block, brake, roots, calculator, trajectory, the three main classes, the `getProfile` methods, the formatters on
50,751 numbers, the sort). Two findings, both fixed: `update` cleared a flag before the validation instead of after
it, and a vector longer than the degrees of freedom was refused where the C++ uses its first elements. It was a
reading: the C++ was not compiled for it. The sort was held against what the reader knows of libstdc++ (the set
`h_sort` holds it against the library itself) and the formatters against Python's `%` formatting; the arithmetic
of the step files was compared as text (833 of the 857 lines of `position_third_step2` the same, the others
reworded declarations), not read.

## The last digit

Ruckig is arithmetic that IEEE 754 fixes to the last bit, and five calls that it does not: `cbrt`, `sin`, `cos`,
`atan`, `acos` (in `roots.hpp`, eleven call sites). The reference takes them from glibc 2.39, the port from the
JavaScript engine, and they differ in the last digit for some arguments. `src/ruckig/libm.ts` is the one place the
port calls them, and a test can replace them.

`tests/fixtures/ruckig/libm.json` holds what the reference's C library gives for the 8,406 arguments the port asks
for over the committed fixtures (`ruckig_fixtures.py --libm`, through ctypes on the library the module is linked
with). With it the port's numbers do not depend on the engine, and they are the reference's to the last bit. So the
port is the same algorithm in the same order of operations, and every difference below is one of those five
functions.

## Tolerances

Measured on the large run with Node 24 (V8). A deviation is relative to the number or to the size of its quantity in
its trajectory (largest position, velocity cap, acceleration cap, duration), whichever is larger.

| Set | Cases | Identical to the last bit | Duration: abs, rel | Samples of `at_time`: abs, rel | Other profile / outcome |
| --- | --- | --- | --- | --- | --- |
| `a_pear` | 34,500 | 31,563 | 2.7e-12 s, 4.7e-11 | 2.4e-13, 5.3e-15 | 1 / 0 |
| `b_general` | 40,200 | 38,284 | 1.2e-14 s, 4.5e-14 | 2.8e-13, 8.7e-15 | 3 / 1 |
| `c_velocity` | 22,200 | 21,834 | 0, 0 | 0, 0 | 0 / 0 |
| `d_multi` | 8,250 | 7,124 | 1.1e-14 s, 1.4e-15 | 5.1e-11, 1.3e-13 | 2 / 0 |
| `g_lower` | 3,900 | 3,889 | 1.8e-15 s, 2.4e-16 | 1.8e-14, 4.3e-14 | 0 / 0 |

Profile times and states: at most 2.4e-11 relative (set a); position extrema 2.3e-15. The velocity interface calls
none of the five functions: its profiles are identical.

- **General bound 1e-9** (durations, profile fields, extrema, samples): twenty times the largest measured (4.7e-11).
- **Time of a position extremum: 1e-5 of the duration** (measured 6.1e-7). It is a root of the velocity, often a
  double one, so it is known only to the square root of the rounding. Where two extrema are level, a last digit
  decides which one is named: 1 such time in 109,050 cases is elsewhere in the trajectory; it is counted, not
  compared. The extreme positions themselves agree to 2.3e-15 (8.7e-14 absolute).
- **`getFirstTimeAtPosition`: 1e-4 of the duration** (measured 5.3e-6). A position approached with zero velocity and
  acceleration is reached at a triple root: known to the cube root of the rounding. 1 probe was elsewhere.
- **Jerk** is compared as the change of acceleration over its phase: a phase of 1e-17 s has its jerk or none by the
  last digit of a root (7 phases in the large run).
- **Another valid profile** (6 cases in 109,050) or **another outcome** (1 case): a last digit makes another
  candidate pass Ruckig's own check, which accepts an end position within 1e-8. Classes found: `UP_NONE` against
  `DOWN_NONE` for a retarget near its target (durations 2e-8 apart) and for collinear phase-synchronized
  coordinates; `NONE` against `VEL` and `ACC1` against `ACC1_VEL` in step 2 with a minimum duration (same duration);
  and one input the reference refuses with "error in step 1" that the port solves (from rest at -0.6 to rest at
  -0.4 with caps 0.1, 0.1, 0.1). The tests allow 0.1% of a set, and at least one case.
- **Sessions.** A step further than 1e-6 from the reference's is another trajectory: the session has diverged and is
  not followed further. Of 1,800 sessions 12 diverged: 5 of 180 arm sessions and 4 of 180 sequences took another
  valid trajectory after a retarget under way (extrema up to 0.05 rad apart); 3 of 540 gripper sessions made, or
  did not make, a recalculation past the endpoint (the commanded opening is the endpoint either way); none of the
  180 `JointMove`, 180 recovery and 540 generic sessions. In the sessions followed to their end every step is
  within 1.6e-12 of the reference's (1.1e-14 in PEAR's patterns), except one sequence with a neighbouring solution
  (8.1e-8). The tests allow 6% of the sessions of a kind, and at least one.

## Deliberate differences

1. **The five inexact functions are the engine's** (see above). Reason: a browser has no glibc; copying glibc's
   routines would bring LGPL code here, and another machine's C library differs in the same way. Tests: `exact`
   (none with the reference's values), `calculate`, `sessions` (what follows with the engine's).
2. **Errors.** As in the Python module (the C++'s `RuckigThrow`), an input that is refused and a calculation that
   fails throw `RuckigError` (`name` and Python class the same; the message begins with a line break and
   `[ruckig] `). The result -101 (`ErrorTrajectoryDuration`, a duration above 7,600 s) is returned, where the Python
   module raises `ValueError: -101 is not a valid Result.` because its `Result` has no such member. Tests:
   `refused`, `api`.
3. **A vector shorter than the degrees of freedom is refused** ("mismatch in degrees of freedom (vector size)."),
   and so is a `calculate` with an input or a trajectory of another number of coordinates. The C++ reads past the
   end. A longer vector is used as far as it is needed, as in the C++. Test: `api`, set f.
4. **Vectors are copied when set and when read**, as the Python module's lists are; `None` is `undefined`.
   `OutputParameter.newJerk` exists (the C++ has it, Python does not show it). Python's `copy.copy(output)` has no
   counterpart.
5. **What the C++ leaves uninitialized is zero**: `intermediateDurations`, `calculationDuration` and the cumulative
   times before a first calculation, the times of a `Bound`, a block's `t_min`, the valid profiles of step 1, the
   profile of an interval made from two numbers. The second reader found no path that reads one of them before it
   is written, apart from a NaN position or a negative time asked of a trajectory that was never calculated.
6. **The lists of valid profiles of step 1 grow**; the C++ has arrays of 6 and 3 and writes past them if more
   profiles are found (it never did in 109,050 cases, or the results would differ).
7. **`std::sort`'s heap-sort fallback** (a range that defeats the median-of-three partition) is a plain sort.
   Unreachable for the lengths Ruckig sorts unless the durations are arranged against it. The insertion sort behind
   the first 16 elements stops at the start of the range, which libstdc++'s does not check: the same result for
   any order of numbers; with a NaN among the durations the C++ is undefined.
8. **`calculationDuration`** is measured with `performance.now()`, in microseconds as upstream.
9. **Not ported**: intermediate waypoints and per-section limits (the cloud client; the community module refuses
   them with the same message), `Block::to_string`, `continue_calculation`.

## Not verified

- **Any engine but Node 24's V8.** With another engine's `Math.cbrt` and trigonometry the numbers of "Tolerances"
  will differ in size, not in kind; `exact.test.ts` does not depend on the engine.
- The twelve candidate profiles above that no case reaches (`time_none_smooth` among them). The fourteen that are
  tried and never accepted are compared with upstream's C++ as candidates, not by a profile that was accepted.
- A time that is NaN (`atTime`, an `update` with a NaN period): the C++ reads out of bounds, the port throws a
  `TypeError`. The sign of a NaN in a message follows its sign bit, which an engine need not keep.
- Speed was not measured beyond this: the large run (109,050 calculations and 93,414 updates, twice) takes 8.6 s.
- Not run in a browser.

## To reconcile with the other modules

- Done since: `src/index.ts` exports `ruckig`; `NOTICE` names Ruckig and its licence; `README.md` and the module
  map of `docs/DESIGN.md` list `src/ruckig/`. The fixtures were written again from the reference module on the
  day of the port and are byte for byte the committed ones (the nine files the script writes; `libm.json` is made
  by the second step described above).
- **Station (`joint/trajectory.py` and the control loop)**: in Python, `calculate` and `update` never return a
  negative result: they raise. PEAR's `if result < 0` branches are dead; what its callers see is `RuckigError`
  (caught by `set_target`'s `except BaseException` and by `stop`'s `except Exception`) or the `ValueError` of
  difference 2. A port of the station must catch `RuckigError` in the same places, and treat a returned -101 as
  Python's `ValueError("-101 is not a valid Result.")` if it wants PEAR's fault text.
- **`JointLimits.checkTrajectory`** (`src/station/joint/limits.ts`) takes `{ positionExtrema: { min, max }[] }`:
  a `Trajectory` is one.
- **Copies**: `output.newPosition` is a new array at every read, so a sample kept from one update survives the
  next, as PEAR's `CommandSample` assumes.
- **The size of the committed fixtures** is at the 3 MB aimed at; 197 KB of it is `libm.json`.

## Observations about the reference worth knowing downstream

- **A retarget of six coordinates under way is on a knife edge in the reference itself.** For 77 of 2,119
  trajectories calculated in PEAR-pattern sessions (46 of 650 in the arm sessions, 30 of 1,175 in the sequences),
  the Python module gives another trajectory when its input's current state is moved by one unit in the last place
  (the fixtures record it as `u`; six ways of moving the state are tried). Time synchronization has several valid
  profiles for one duration, and which one passes first hangs on the last digit. The port parts from the reference
  in 9 of those 360 sessions for the same reason. A `JointMove` (rest to rest, phase synchronized), which is what
  the agent's turn uses, never did: 0 of 113, and 0 of 180 sessions diverged.
- **A controlled stop with braking caps below the motion's can fail in the reference.** In 1 of 48 such stops of six
  coordinates the module raised `error in step 2 in dof: 3 for t sync: 0.728642` (velocity interface, the state
  outside the lowered caps); PEAR's `stop` turns that into a fault. None of the 261 stops with the shipped caps
  (which are higher than the motion's) failed.
- The reference fails on inputs it should solve, with `error in step 1`: 23 of 34,500 cases of set a (15 of 7,411
  with a state outside lowered caps, 8 of 4,147 in the middle of a stop; none from rest or retargeted within the
  caps), 30 of 14,285 general states of one coordinate, 15 of 1,340 of several, and the plain move quoted under
  "Tolerances".
- **Phase synchronization never succeeds without an acceleration cap**: the phase control is taken from the jerk or
  acceleration cap of the limiting coordinate, which is infinite, so the check fails and the calculation falls back
  to time synchronization (94 of 94 tries).
- `Profile.limits`, `.direction` and `.control_signs` cannot be read from Python (the binding has no conversion);
  `repr(profile)` gives the three as text.
- One coordinate without a minimum or discrete duration has no bound on its duration: the 7,600 s check comes after
  that early return.
- A `GripperProfile` past its endpoint is calculated anew at every period in which the profile's last position is
  not the endpoint to the last bit (PEAR commands the endpoint and feeds it back): the 7 committed gripper sessions
  make 28 calculations in 449 updates, 21 of them after the first.
- The module in the station environment was compiled on the machine (scikit-build-core 0.9.10, GCC 13.3.0, plain
  x86-64): its binary holds no fused multiply-add instruction, and it imports `cbrt`, `sincos`, `atan`, `acos`,
  `fmod` and `sqrt` from glibc 2.39.

## Left

Nothing of the task. If the work goes on:

- Run `tests/ruckig` in a browser engine, to measure "Tolerances" there.
- A case that accepts each of the thirteen numerical corner-case profiles that are tried, if inputs that need them
  can be found; the probe above could then become a fixture (the candidates of the committed cases: about 60 KB).
- `OutputParameter` copy, if the station port wants it.
