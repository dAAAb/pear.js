// close() while an action is under way.
//
// PEAR's shutdown (joint/control_loop.py: `shutdown`) stops, waits without a guard of the caller's for the HOLD, and
// closes the driver in a `finally`. The action that was under way fails at its next check, and its failure path
// stops again (robot.py: `execute`); a stop in a HOLD advances the generation (control_loop.py: `_stop_locked`),
// which ends the shutdown's wait with "Action cancelled by stop or another operation". Then `close()` raises that
// error, and it has closed the arm all the same: the driver is closed, the torque off, the session gone. pear.js
// has the same statements, so a `close()` that rejects must not be taken for "still open".
//
// These are expectations written by hand, and PEAR's side is its code as read, not a run: the interleaving needs
// the action's thread and the closing thread, and PEAR's stepped rig has one (in the session of the fixtures that
// closes during an action, the close runs to its end inside one sleep of the action). Here the close is called
// right after a control period of the move and not awaited, so that it and the action go on in turns: when the
// action comes to its next check while the arm still brakes, the close returns; when it comes to it only after
// the brake has ended, its stop lands in the HOLD that the close waits in, and the close rejects.

import { describe, expect, test } from "vitest";

import { brief, delta, handRig, sends } from "./by_hand";

const NOT_OPEN = "RuntimeError: Open the station first";
const STOPPED = { code: "RuntimeError", message: "Action cancelled by stop or another operation" };

/** What a call did: "returned", or the error's class and message. */
async function tried(call: () => unknown): Promise<string> {
  try {
    await call();
    return "returned";
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

/**
 * Runs an action and calls `close()`, without waiting for it, right after a control period of the arm's move. The
 * close stops the arm and waits for the brake's end, a control period at a time. `noticing` says when the action,
 * which waits for its move a control period at a time too, comes to its next check: "at once" (while the arm still
 * brakes), or only "after the brake" (once the brake has ended in a HOLD, and before the close has looked again).
 * Returns the action's result, how the close ended and the driver's calls from the close on.
 */
async function closeDuringAction(noticing: "at once" | "after the brake") {
  const rig = await handRig();
  const { robot, clock, io } = rig;
  const loop = robot.controlLoop;
  const observation = await robot.observe();
  let closing: Promise<string> | null = null;
  let before: unknown[] = [];
  let letActionGoOn: () => void = () => undefined;
  const actionMayGoOn = new Promise<void>((resolve) => (letActionGoOn = resolve));
  let actionEnded: Promise<unknown> = Promise.resolve();
  let stage: "moving" | "braking" | "over" = "moving";
  clock.afterTick = async () => {
    if (stage === "moving" && loop.status === "RUNNING") {
      // inside the action's sleep: the page closes the robot
      stage = "braking";
      before = io();
      closing = tried(() => robot.close());
      if (noticing === "after the brake") {
        await actionMayGoOn;
      }
    } else if (stage === "braking" && loop.status === "HOLD") {
      // inside the close's sleep: the brake has ended
      stage = "over";
      if (noticing === "after the brake") {
        letActionGoOn();
        await actionEnded;
      }
    }
    return null;
  };

  const acting = robot.execute(delta(0.02));
  actionEnded = acting.catch(() => undefined);
  const result = await acting;
  clock.afterTick = null;
  expect(closing).not.toBeNull();
  const closed = await (closing as unknown as Promise<string>);
  // (when the action notices at once, it ends, and the hook with it, while the arm still brakes)
  expect(stage).toBe(noticing === "after the brake" ? "over" : "braking");

  return { rig, loop, observation, result, closed, commandsBefore: sends(before), calls: io() };
}
describe("close() while an action is under way", () => {
  test.each([
    { noticing: "at once" as const, closed: "returned" },
    { noticing: "after the brake" as const, closed: "RuntimeError: Action cancelled by stop or another operation" },
  ])("the action notices $noticing: close() ends as `$closed`, and the arm is closed either way", async ({ noticing, closed: expected }) => {
    const { rig, loop, observation, result, closed, commandsBefore, calls } = await closeDuringAction(noticing);
    const { robot, clock, io } = rig;

    expect(closed).toBe(expected);
    expect(commandsBefore).toBeGreaterThan(0);
    // the action that was under way failed; it never rejects
    expect(brief(result)).toEqual({ status: "failed", error: STOPPED });

    // the robot is off, its session gone, the loop closed, and the driver's last call is its close
    expect(robot.status()).toEqual({ status: "OFF" });
    expect(robot.sessionId).toBeNull();
    expect(robot.openLoop).toBeNull();
    expect(loop.status).toBe("CLOSED");
    expect(calls.at(-1)).toBe("c");
    expect(calls.filter((call) => call === "c")).toHaveLength(1);

    // every later call says that the station is not open, and the driver is not called again
    expect(await tried(() => robot.execute(delta(0.02)))).toBe(NOT_OPEN);
    expect(await tried(() => robot.home({ approvePlan: () => true }))).toBe(NOT_OPEN);
    expect(await tried(() => robot.recover())).toBe(NOT_OPEN);
    expect(await tried(() => robot.observe())).toBe(NOT_OPEN);
    expect(await tried(() => robot.waitStationary())).toBe(NOT_OPEN);
    expect(await tried(() => robot.waitSettled(1.0))).toBe(NOT_OPEN);
    expect(await tried(() => robot.isHolding(observation))).toBe(NOT_OPEN);
    expect(await tried(() => robot.stop())).toBe("returned");
    expect(await tried(() => robot.checkFault())).toBe("returned");
    expect(await tried(() => robot.close())).toBe("returned");
    expect(io()).toEqual([]);

    // and a new session opens
    await robot.open();
    clock.controlLoop = robot.controlLoop;
    await robot.waitStationary();
    expect(robot.status().status).toBe("READY");
    expect(brief(await robot.execute(delta(0.02)))).toEqual({ status: "completed", error: null });
    await robot.close();
  });
});
