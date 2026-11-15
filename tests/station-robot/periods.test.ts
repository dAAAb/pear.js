// The robot while control periods are under way.
//
// PEAR's control thread holds the loop's lock for every control period, and the guard of an action takes that lock
// to read the operation it is bound to, for each check and for each submission (joint/action_guard.py), as the
// robot does around `verify_observation` and `submit_grippers` (robot.py): none of them ever runs inside a control
// period. pear.js has one thread: a control period is suspended at each call of the driver, and a check or a
// submission of the robot runs then, at once, without waiting for the period's end (docs/progress/robot.md,
// deliberate difference 3). Only the making of a guard waits for the period that is under way.
//
// Every session of the fixtures runs on the stepped rig, where a period runs inside the sleep of whoever waits, so
// none of them has a period under way when the robot acts. Here a ticker starts the periods as a page's timer does
// and every call of the driver takes some turns of the event loop (by_hand.ts). These are expectations written by
// hand: PEAR's records cannot hold an interleaving that PEAR's lock forbids. What is expected is what the stepped
// rig gives, whose every step is compared with PEAR in sessions.test.ts.
//
// Not covered here or by the control loop's own interleaving tests (../station-loop/interleaving.test.ts,
// sweep.test.ts): a fault of the arm, a recovery and a joint chunk while periods are under way, and a real line.

import { beforeAll, describe, expect, test } from "vitest";

import { ActionGuard } from "../../src/station/joint/action_guard";
import { brief, delta, handRig, SCRIPT, steppedScript, tickedScript, turns, type HandRig, type ScriptOutcome } from "./by_hand";

const COMPLETED = SCRIPT.map(() => "completed");
const STOPPED = "failed: Action cancelled by stop or another operation";
const PAUSED = "failed: Operation interrupted by the operator";
const CLOSED = "failed: Action interrupted: CLOSED: None";
const NOT_OPEN = "threw RuntimeError: Open the station first";
/** How many schedules each test draws: the seeds 1 to this. */
const SCHEDULES = { plain: 200, stop: 120, cancel: 120, close: 180 };

let reference: ScriptOutcome;
beforeAll(async () => {
  reference = await steppedScript();
});

/** The largest distance of a joint of `outcome` from where the stepped rig ended. */
function apart(outcome: ScriptOutcome): number {
  expect(outcome.position).toHaveLength(reference.position.length);

  return Math.max(...outcome.position.map((value, index) => Math.abs(value - reference.position[index]!)));
}

describe("the script on the stepped rig", () => {
  test("every action completes and Home is reached", () => {
    expect(reference.statuses).toEqual(COMPLETED);
    expect(reference.home).toBe("reached true");
    expect(reference.fault).toBeNull();
    expect(reference.position).toHaveLength(6);
  });
});

describe("control periods started by a ticker, every call of the driver taking turns of the event loop", () => {
  test(`the script ends as on the stepped rig, to the last bit of the final pose (${SCHEDULES.plain} schedules)`, async () => {
    let inside = 0;
    let outside = 0;
    for (let seed = 1; seed <= SCHEDULES.plain; seed++) {
      const outcome = await tickedScript(seed);
      inside += outcome.inside;
      outside += outcome.outside;

      expect({ seed, statuses: outcome.statuses, home: outcome.home, fault: outcome.fault, position: outcome.position }).toEqual({
        seed,
        ...reference,
      });
    }

    // seven operations a schedule: two moves with a gripper each, the opening, a move, and Home's two
    expect(inside + outside).toBe(7 * SCHEDULES.plain);
    // the schedules do what the stepped rig cannot: a good part of the submissions falls inside a control period
    expect(inside / (inside + outside)).toBeGreaterThan(0.25);
    expect(outside / (inside + outside)).toBeGreaterThan(0.25);
  });

  test.each([
    { kind: "stopAt" as const, count: SCHEDULES.stop, failure: STOPPED, what: "a stop" },
    { kind: "cancelAt" as const, count: SCHEDULES.cancel, failure: PAUSED, what: "the first action's cancellation" },
  ])("$what at a period of the script: the action under way fails, the rest runs, Home is reached ($count schedules)", async ({ kind, count, failure }) => {
    let interrupted = 0;
    let inside = 0;
    for (let seed = 1; seed <= count; seed++) {
      const outcome = await tickedScript(seed, { [kind]: 1 + (seed % 60) });
      inside += outcome.inside;

      const failed = outcome.statuses.filter((status) => status !== "completed");
      interrupted += failed.length;
      // the one action that was under way fails as interrupted; when the event fell where none was, nothing does
      expect({ seed, failed }).toEqual({ seed, failed: failed.length === 0 ? [] : [failure] });
      expect(outcome.statuses).toHaveLength(SCRIPT.length);
      expect({ seed, home: outcome.home, fault: outcome.fault }).toEqual({ seed, home: "reached true", fault: null });
      // Home from another pose: the same pose but for the rounding of the last sample
      expect(apart(outcome)).toBeLessThan(1e-12);
    }

    expect(interrupted).toBeGreaterThan(count / 2);
    expect(inside).toBeGreaterThan(0);
  });

  test(`close() at a period of the script: the action under way fails, nothing runs after it, and the driver is not called again (${SCHEDULES.close} schedules)`, async () => {
    const closes: Record<string, number> = {};
    for (let seed = 1; seed <= SCHEDULES.close; seed++) {
      const outcome = await tickedScript(seed, { closeAt: 1 + (seed % 90) });
      closes[outcome.closed ?? "never"] = (closes[outcome.closed ?? "never"] ?? 0) + 1;

      // completed actions, then at most the one that was under way, then nothing but refusals
      const statuses = outcome.statuses.filter((status) => !status.startsWith("waitSettled threw "));
      const firstRefused = statuses.indexOf(NOT_OPEN);
      const before = statuses.slice(0, firstRefused === -1 ? statuses.length : firstRefused);
      const failed = before.filter((status) => status !== "completed");
      expect({ seed, failed: failed.length <= 1 && failed.every((status) => status === STOPPED || status === CLOSED) ? "one at most" : failed }).toEqual({
        seed,
        failed: "one at most",
      });
      expect({ seed, after: statuses.slice(before.length) }).toEqual({ seed, after: statuses.slice(before.length).map(() => NOT_OPEN) });
      expect(firstRefused).toBeGreaterThan(-1);
      expect({ seed, home: outcome.home }).toEqual({ seed, home: NOT_OPEN });

      // however close() ended, the robot is off and the driver was not called again
      expect({ seed, status: outcome.statusAfterClose, late: outcome.lateCalls, position: outcome.position }).toEqual({
        seed,
        status: "OFF",
        late: [],
        position: [],
      });
    }

    // close() rejects in some schedules although it has closed the arm: with what the action's own stop gave it
    expect(Object.keys(closes).sort()).toEqual(["rejected RuntimeError: Action cancelled by stop or another operation", "returned"]);
  });
});

describe("one control period held at the arm's reading", () => {
  /** Starts a control period on `rig` that waits for the arm's reading until the returned `release` is called. */
  async function heldPeriod(rig: HandRig): Promise<{ period: Promise<void>; release: () => void }> {
    const { robot, clock } = rig;
    const arm = robot.arm;
    const read = arm.read.bind(arm);
    let isReading = false;
    let release: () => void = () => undefined;
    arm.read = (async () => {
      isReading = true;
      await new Promise<void>((resolve) => (release = resolve));
      arm.read = read;

      return read();
    }) as typeof arm.read;
    clock.now += robot.controlPeriodS;
    const period = robot.controlLoop.step();
    for (let index = 0; index < 50 && !isReading; index++) {
      await Promise.resolve();
    }
    expect(isReading).toBe(true);
    expect(robot.controlLoop.lock.isHeld).toBe(true);

    return { period, release: () => release() };
  }

  test("an action called meanwhile begins after the period, and after a stop that was called before it", async () => {
    const rig = await handRig();
    const { robot } = rig;
    const loop = robot.controlLoop;
    const { period, release } = await heldPeriod(rig);
    const generation = loop.generation;

    const stopping = robot.stop();
    const acting = robot.execute(delta(0.02));
    await turns(5);

    // PEAR's guard is made under the loop's lock: the action has not begun, and neither has the stop
    expect({ status: loop.status, generation: loop.generation, isHeld: loop.lock.isHeld }).toEqual({ status: "HOLD", generation, isHeld: true });

    release();
    await period;
    await stopping;
    // the stop came first, so the action is bound to the operation after it and runs to its end
    expect(brief(await acting)).toEqual({ status: "completed", error: null });
    expect(loop.fault).toBeNull();
    await robot.close();
  });

  test("a check and a submission made meanwhile run at once, inside the period, where PEAR's would wait for its end", async () => {
    const rig = await handRig();
    const { robot, clock, io } = rig;
    const loop = robot.controlLoop;
    const observation = await robot.observe();
    io();
    const { period, release } = await heldPeriod(rig);
    const generation = loop.generation;

    // the check, and the gripper's submission as an action makes it
    expect(robot.verifyObservation(observation).generation).toBe(generation);
    const operation = robot.submitGrippers(new ActionGuard(loop), observation, false);

    expect({ status: loop.status, generation: loop.generation, isHeld: loop.lock.isHeld }).toEqual({
      status: "RUNNING",
      generation: generation + 1,
      isHeld: true,
    });

    release();
    await period;
    // the period that was under way takes the operation for begun before it: it sends the first command itself
    expect(io().map((call) => (Array.isArray(call) ? call[0] : call))).toEqual(["r", "s"]);
    expect(loop.fault).toBeNull();
    for (let index = 0; index < 200 && loop.status !== "HOLD"; index++) {
      await clock.sleep(robot.controlPeriodS);
    }
    await robot.waitStationary();
    expect({ status: robot.status().status, fault: loop.fault }).toEqual({ status: "READY", fault: null });
    expect(operation).toBeDefined();
    await robot.close();
  });
});
