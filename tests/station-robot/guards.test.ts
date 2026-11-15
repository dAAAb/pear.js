// The guard checks that only a handler's stop reaches: the check before an action's result, the check before the
// observation that follows an action's arm move, and the check after a stage of Home is reported.
//
// PEAR's `execute` (control/robot.py) checks its guard, reports "Executing" to the caller's handler, runs the
// prepared action and checks the guard again before it makes the result. `run_prepared` (control/motion/
// execution.py) checks the guard before it observes for the grippers. Where no arm move runs in between, these
// checks are the first after the handler, so they are what refuses a robot that the handler stopped. Home checks
// its guard around every stage it reports (control/motion/homing.py, `report_stage`), so a stage handler's stop is
// refused before the grippers are operated.
//
// These are expectations written by hand: no record of PEAR holds a handler that stops the robot. What PEAR does
// was run on PEAR's own robot on its stepped rig (the station "so101_quick" with the drawn cameras; Home on
// "so101_quick_home" after an action of z +0.05 m that closes the gripper), and the rows below are that run's.
// tools/rows/guards_rows.py prints these rows:
//
//   an action whose handler does nothing             the result   camera reads   generation
//     an action that asks nothing (all zero)         completed    1              +0
//     a gripper action (open)                        completed    2              +1
//     a closing with no arm move                     completed    2              +1
//   the same, the handler stops the robot when "Executing" is reported
//     each: failed, RuntimeError: Action cancelled by stop or another operation; the cameras are read once (not
//     again for the grippers); the generation is two higher (the stop, and the stop of the failed action); READY
//   Home whose stage handler does nothing
//     reached; camera reads 2; stages checking, opening, checking, homing, completed; generation +2
//   Home whose stage handler stops the robot at "opening"
//     raises HomeFailed: Action cancelled by stop or another operation (its cause that RuntimeError); camera reads
//     1; stages checking, opening; generation +2; READY

import { describe, expect, test } from "vitest";

import { SO101Robot } from "../../src/so101/robot";
import { brief, delta, handRig } from "./by_hand";
import { StandInCameras } from "./rig";

const CANCELLED = "Action cancelled by stop or another operation";

/** The robot at rest with PEAR's drawn cameras, whose reads are counted. */
async function counting(station = "so101_quick") {
  const count = { reads: 0 };
  const rig = await handRig({
    station,
    cameras: (clock) => {
      const cameras = new StandInCameras(SO101Robot.CAMERAS, clock);
      const own = cameras.read.bind(cameras);
      cameras.read = () => {
        count.reads += 1;
        return own();
      };
      return cameras;
    },
  });

  return { ...rig, count, generation: (): number => rig.robot.controlLoop.snapshot().generation };
}

const ACTIONS = [
  { name: "an action that asks nothing", action: delta(0, 0), reads: 1, generations: 0 },
  { name: "a gripper action", action: { type: "gripper", command: "open" }, reads: 2, generations: 1 },
  { name: "a closing with no arm move", action: delta(0, -1), reads: 2, generations: 1 },
];

describe("an action with no arm move whose progress handler stops the robot (expectations written by hand)", () => {
  test.each(ACTIONS)("$name, the handler does nothing: completed", async ({ action, reads, generations }) => {
    const { robot, count, generation } = await counting();
    const before = generation();
    const phases: string[] = [];

    const result = await robot.execute(action, { reportProgress: (phase) => void phases.push(String(phase)) });

    expect(brief(result)).toEqual({ status: "completed", error: null });
    expect([count.reads, phases, generation() - before, String(robot.status().status)]).toEqual([reads, ["Planning", "Executing"], generations, "READY"]);
    await robot.close();
  });

  test.each(ACTIONS)("$name, the handler stops the robot at Executing: failed, and the cameras are not read again", async ({ action }) => {
    const { robot, count, generation } = await counting();
    const before = generation();
    const phases: string[] = [];

    const result = await robot.execute(action, {
      reportProgress: async (phase) => {
        phases.push(String(phase));
        if (phase === "Executing") {
          await robot.stop();
        }
      },
    });

    expect(brief(result)).toEqual({ status: "failed", error: { code: "RuntimeError", message: CANCELLED } });
    expect([count.reads, phases, generation() - before, String(robot.status().status)]).toEqual([1, ["Planning", "Executing"], 2, "READY"]);
    await robot.close();
  });
});

describe("Home whose stage handler stops the robot at the opening (expectations written by hand)", () => {
  /** Home after an action that moves away and closes the gripper, so that Home opens it; `stops`: at "opening". */
  async function home(stops: boolean) {
    const { robot, count, generation } = await counting("so101_quick_home");
    expect(brief(await robot.execute(delta(0.05, -1)))).toEqual({ status: "completed", error: null });
    count.reads = 0;
    const before = generation();
    const stages: string[] = [];

    const outcome = await robot
      .home({
        approvePlan: () => true,
        reportProgress: async (update) => {
          stages.push(String((update as { stage?: unknown }).stage));
          if (stops && stages.at(-1) === "opening") {
            await robot.stop();
          }
        },
      })
      .then(
        (report) => `reached ${String((report.results as { reached: boolean }).reached)}`,
        (error: Error & { cause?: Error }) => `${error.name}: ${error.message} | cause ${error.cause?.name}: ${error.cause?.message}`,
      );
    const seen = { outcome, reads: count.reads, stages, generations: generation() - before, status: String(robot.status().status) };
    await robot.close();

    return seen;
  }

  test("the handler does nothing: Home is reached", async () => {
    expect(await home(false)).toEqual({
      outcome: "reached true",
      reads: 2,
      stages: ["checking", "opening", "checking", "homing", "completed"],
      generations: 2,
      status: "READY",
    });
  });

  test("the handler stops the robot: Home is refused after the report, before the grippers are operated", async () => {
    expect(await home(true)).toEqual({
      outcome: `HomeFailed: ${CANCELLED} | cause RuntimeError: ${CANCELLED}`,
      reads: 1,
      stages: ["checking", "opening"],
      generations: 2,
      status: "READY",
    });
  });
});
