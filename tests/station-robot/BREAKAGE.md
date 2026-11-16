# The tests can fail

36 deliberate breaks of the motion layer and the robot, each made alone and run against the whole of
`tests/station-robot` as it was then (5 files: `actions`, `parts`, `sessions`, `capstone`, `engine`). They were made
in a copy of the repository under the scratch directory (`src`, `tests` and the configuration copied,
`node_modules` linked), never in the repository itself; after each run the copy's file was the repository's again,
the two sha256 compared (36 of 36 equal). Run on 2026-11-15, 18:24 to 18:26, when the directory had 4,219 tests on
the fixtures of 64 sessions. Two sessions were added after that run (4,223 tests, 66 sessions, as committed); the
36 breaks were not run again on them.

The directory now has 13 files and 5,049 tests on the fixtures of 73 sessions. An independent audit later made 225
breaks of its own (none of these 36), and they were run again after its findings were answered: 214 of the 221
that can still be made fail a test, and the other 7 change nothing that can be told from outside
(`docs/progress/robot.md`, "Round 4"). One more break was made on 2026-11-16, in the same way (a copy, never the
repository): a chunk's grippers' range checked although the chunk has a key that is none of its fields
(`station/motion/actions.ts`). It failed nothing; since PEAR's record of such chunks is in the fixtures it fails 10
tests (`docs/progress/robot.md`, "Refusal texts of the action models").

"Failed" counts tests of the 4,219 of that run. A session or a task that differs fails its own test and the file's
summary test, and `engine` runs the same cases again, so one differing session shows as 4.

| # | Break | File | Failed | By file (failed) |
| --- | --- | --- | --- | --- |
| 1 | the margin of a move's wait left out (`settle_timeout_s` alone) | `station/motion/execution.ts` | 4 | sessions 2, engine 2 |
| 2 | the second `guard.check()` after the observation in `runPrepared` removed | `station/motion/execution.ts` | **0** | see below |
| 3 | `remainingS`: `<= 0` as `< 0` | `station/motion/execution.ts` | 4 | sessions 2, engine 2 |
| 4 | a plan approved by anything but `false` (`!== true` as `=== false`) | `station/motion/homing.ts` | 4 | sessions 2, engine 2 |
| 5 | Home judged against the goal before the gripper has opened | `station/motion/homing.ts` | 6 | sessions 3, engine 3 |
| 6 | `WAIT_MARGIN_S` 5.0 as 6.0 | `station/motion/homing.ts` | 7 | parts 1, sessions 3, engine 3 |
| 7 | rejected for a `ValueError` also after a dispatch | `station/robot.ts` | 4 | sessions 2, engine 2 |
| 8 | READY for a HOLD that has not settled | `station/robot.ts` | 6 | sessions 3, engine 3 |
| 9 | the check of the session after the cameras' read removed | `station/robot.ts` | 4 | sessions 2, engine 2 |
| 10 | another session's observation accepted | `station/robot.ts` | 8 | sessions 3, capstone 2, engine 3 |
| 11 | a second action let in while one runs | `station/robot.ts` | 4 | sessions 2, engine 2 |
| 12 | the adapter no longer keeps the robot's own observation | `station/robot.ts` | **0** | see below |
| 13 | the model's state in every action's result | `so101/robot.ts` | 4 | sessions 2, engine 2 |
| 14 | planning past its deadline not refused | `so101/robot.ts` | 6 | sessions 3, engine 3 |
| 15 | the jaw taken for open unless it is closed | `so101/motion/homing.ts` | **0** | see below |
| 16 | a frame stale at exactly its bound (`>` as `>=`) | `so101/hardware/cameras.ts` | 4 | parts 2, engine 2 |
| 17 | a feed keeps the reader it closed | `station/cameras.ts` | 6 | parts 3, engine 3 |
| 18 | the format's action model takes anything | `so101/formats.ts` | 1 | actions 1 |
| 19 | reached without an arrival in the snapshot | `station/motion/results.ts` | 98 | parts 49, engine 49 |
| 20 | `MOVE_TOLERANCE` 1e-10 as 1e-9 | `station/motion/planning.ts` | 19 | parts 10, engine 9 |
| 21 | the goal keeps the kinematics' gripper coordinate | `so101/motion/planning.ts` | 6 | parts 3, engine 3 |
| 22 | a jaw stopped on an object counts as reached | `so101/motion/results.ts` | 33 | parts 5, sessions 4, capstone 15, engine 9 |
| 23 | a literal compared with `==` | `station/motion/actions.ts` | 5 | actions 5 |
| 24 | no stop after the cameras failed in an observation | `station/robot.ts` | 4 | sessions 2, engine 2 |
| 25 | no stop after a gripper operation failed | `station/motion/execution.ts` | 6 | sessions 3, engine 3 |
| 26 | an action does not forget the last failed action's record | `station/robot.ts` | 4 | sessions 2, engine 2 |
| 27 | a session forgotten although its control loop did not close | `station/robot.ts` | **0** | see below |
| 28 | no check of the guard after the plan's approval | `station/motion/homing.ts` | 4 | sessions 2, engine 2 |
| 29 | Home's accuracy strict at the tolerance (`<=` as `<`) | `station/motion/homing.ts` | 4 | sessions 2, engine 2 |
| 30 | the delta's base strict at the tolerance (`<=` as `<`) | `so101/motion/planning.ts` | 18 | parts 9, engine 9 |
| 31 | no log when the measured joints have no model state | `station/motion/results.ts` | 26 | parts 13, engine 13 |
| 32 | a failure's result without the model's state | `so101/robot.ts` | 41 | sessions 11, capstone 19, engine 11 |
| 33 | a recovery does not forget the last failed action's record | `station/robot.ts` | 4 | sessions 2, engine 2 |
| 34 | the adapter hands a frame's stamps on under PEAR's keys | `station/robot.ts` | 20 | capstone 20 |
| 35 | `waitStationary` ignores its observation | `station/robot.ts` | 6 | sessions 3, engine 3 |
| 36 | no log of an action that did not complete | `station/robot.ts` | 66 | sessions 33, engine 33 |

32 were caught in that run. The four that were not:

- **2** changes nothing that can be seen: the check after the observation is followed at once by the first line of
  `operateGrippers`, which is the same check.
- **12** changed something that no test saw. With the map, the adapter handed the robot a record kept aside for an
  observation it had issued, so the loop's object with its `sessionId` changed in place was accepted; without the
  map it was refused, as PEAR refuses it. Since then the adapter hands the robot the values the loop's object holds
  (`docs/progress/robot.md`, Round 4), the map serves only to give the robot its own frames back, and break 12
  fails `observation.test.ts` ("the robot is handed its own frames and their stamps back").
- **15** cannot show on the SO-101: its jaw's opening ends `open` or raises `GripperEndpointTimeout`; the outcomes
  `closed` and `stopped_before_closed` are of a closing. PEAR's "Home opening did not complete; no arm move
  dispatched" is unreachable with this robot's gripper operation.
- **27** needs a control loop that does not reach CLOSED in a shutdown, which is the loop whose thread does not end
  ("Control thread did not stop"). The stepped loop has no thread.

The first round (18:15, on the fixtures of 59 sessions) had 23 of these breaks, and 11 were not caught. Eight of
those are caught now because the fixture script was given a case for each from PEAR (1, 3, 7, 9, 16, 18, 21, 23);
of the 13 added afterwards, five were not caught at first (26, 27, 28, 29, 34): 26, 28 and 29 are caught now by new
sessions, 34 by a comparison the capstone lacked (it compared a frame's stamps after renaming them itself), and 27
is the one above.
