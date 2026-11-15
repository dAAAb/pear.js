// A progress handler and a Home approval that take their time.
//
// PEAR calls both in the action's thread, which waits for them as long as they take (robot.py: `execute`,
// motion/homing.py: `_report_stage` and the approval). Here both may return a promise, which the action and Home
// await (docs/progress/robot.md, deliberate difference 4). No record of PEAR holds a handler that does anything:
// the fixture script's handler only notes the phase. So these are expectations written by hand, and what PEAR does
// with each was run on PEAR's own robot on its stepped rig, with a handler that sleeps control periods, raises,
// stops the robot, sets the cancellation or calls the robot again (an action of z +0.02 m from an observation on
// the station "so101_quick"; Home on "so101_quick_home" after an action of z +0.05 m). That run's results:
//
//   an action whose handler ...
//     sleeps three control periods at each phase   completed; HOLD and no command while it sleeps; 10 commands after
//     raises at Planning, or at Executing          failed: RuntimeError, the handler's message; no command
//     stops the robot at Planning                  rejected: ValueError: Observation invalidated by another operation;
//                                                  not asked again
//     sets the cancellation at Planning            failed: OperatorPaused: Operation interrupted by the operator; not
//                                                  asked again
//     stops the robot at Executing                 failed: RuntimeError: Action cancelled by stop or another operation
//     sets the cancellation at Executing           failed: OperatorPaused: Operation interrupted by the operator
//     calls execute, home and recover again        each raises RuntimeError: A station action is already running;
//                                                  the status is READY; the action completes
//   Home whose approval ...
//     sleeps three control periods                 reached; HOLD and no command while it sleeps; 12 commands after
//     raises                                       HomeFailed with its message; no command
//     stops the robot, then approves               HomeFailed: Action cancelled by stop or another operation
//     sets the cancellation, then approves         OperatorPaused: Operation interrupted by the operator
//     calls execute, home and recover again        each raises as above; Home is reached
//   Home whose stage handler ...
//     sleeps two control periods at each stage     reached; the stages checking, checking, homing, completed, each in HOLD
//     raises at its second stage                   HomeFailed with its message; no command
//
// What PEAR's one thread cannot do is at the end: a promise that never settles, and a stop, a cancellation or a
// close that comes from outside while a handler is pending. PEAR's side of those is its code as read: a handler that
// never returns blocks the action's thread with the execution lock held (robot.py: `_claim_execution`).

import { describe, expect, test } from "vitest";

import { CameraSource, type CameraPreview } from "../../src/station/cameras";
import { RuntimeError } from "../../src/station/joint/errors";
import type { CameraFrame } from "../../src/station/schemas";
import { brief, delta, handRig, sends, turns, type HandRig } from "./by_hand";
import type { DrawnFrame, RecordingClock } from "./rig";

const ACTION = delta(0.02);
const BUSY = "RuntimeError: A station action is already running";
const STOPPED = { code: "RuntimeError", message: "Action cancelled by stop or another operation" };
const PAUSED = { code: "OperatorPaused", message: "Operation interrupted by the operator" };
const HANDLER_FAILED = { code: "RuntimeError", message: "the handler failed" };
const never = new Promise<never>(() => undefined);

/** What a call did, as the run of PEAR printed it: "returned", or the error's class and message. */
async function tried(call: () => unknown): Promise<string> {
  try {
    await call();
    return "returned";
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

/** Sleeps `periods` control periods of `rig`, each of which steps the control loop. */
async function sleepPeriods(rig: HandRig, periods: number): Promise<void> {
  for (let index = 0; index < periods; index++) {
    await rig.clock.sleep(rig.robot.controlPeriodS);
  }
}

/** The robot of PEAR's run of Home: away from Home, so that Home has a move to make. */
async function awayFromHome(): Promise<HandRig> {
  const rig = await handRig({ station: "so101_quick_home" });
  expect(brief(await rig.robot.execute(delta(0.05)))).toEqual({ status: "completed", error: null });
  rig.io();

  return rig;
}

/** A camera whose read number `at` (null: none) calls `during` before it returns its frame. */
class HookedCamera extends CameraSource<DrawnFrame> {
  reads = 0;

  constructor(
    private readonly clock: RecordingClock,
    public at: number | null,
    private readonly during: () => void,
  ) {
    super();
  }

  override async readPreview(): Promise<CameraPreview<DrawnFrame>> {
    this.reads += 1;
    if (this.reads === this.at) {
      this.during();
    }
    const frame: CameraFrame<DrawnFrame> = { rgb: { shape: [480, 640, 3] }, received_monotonic_s: this.clock.monotonic(), frame_number: this.reads };

    return [{ wrist: frame }, {}];
  }

  override async close(): Promise<void> {}
}

describe("an action's progress handler (PEAR's run)", () => {
  test("the action waits for a handler that sleeps three control periods at each phase, and commands nothing meanwhile", async () => {
    const rig = await handRig();
    const { robot, io } = rig;
    const observation = await robot.observe();
    const seen: string[] = [];

    const result = await robot.execute(ACTION, {
      referenceObservation: observation,
      reportProgress: async (phase) => {
        io();
        await sleepPeriods(rig, 3);
        seen.push(`${phase}: ${robot.controlLoop.status}, ${sends(io())} commands`);
      },
    });

    expect(seen).toEqual(["Planning: HOLD, 0 commands", "Executing: HOLD, 0 commands"]);
    expect(brief(result)).toEqual({ status: "completed", error: null });
    expect(sends(io())).toBe(10);
    expect(robot.status().status).toBe("READY");
    await robot.close();
  });

  test.each(["Planning", "Executing"])("a handler that fails at %s fails the action with its error, by throwing or by rejecting", async (at) => {
    for (const isAsync of [false, true]) {
      const { robot, io } = await handRig();
      const observation = await robot.observe();
      const fail = (phase: string): void => {
        if (phase === at) {
          throw new RuntimeError("the handler failed");
        }
      };

      const result = await robot.execute(ACTION, {
        referenceObservation: observation,
        reportProgress: isAsync ? async (phase) => fail(phase) : fail,
      });

      expect(brief(result)).toEqual({ status: "failed", error: HANDLER_FAILED });
      expect(sends(io())).toBe(0);
      expect(robot.status().status).toBe("READY");
      await robot.close();
    }
  });

  test.each([
    { what: "stops the robot", status: "rejected", error: { code: "ValueError", message: "Observation invalidated by another operation" }, seen: ["Planning", "stop returned"] },
    { what: "sets the cancellation", status: "failed", error: PAUSED, seen: ["Planning"] },
  ])("a handler that $what at Planning ends the action and is not asked again", async ({ what, status, error, seen: expected }) => {
    const { robot, io } = await handRig();
    const observation = await robot.observe();
    const cancellation = { aborted: false };
    const seen: string[] = [];

    const result = await robot.execute(ACTION, {
      referenceObservation: observation,
      cancellation,
      reportProgress: async (phase) => {
        seen.push(phase);
        if (phase === "Planning" && what === "stops the robot") {
          seen.push(`stop ${await tried(() => robot.stop())}`);
        } else if (phase === "Planning") {
          cancellation.aborted = true;
        }
      },
    });

    expect(seen).toEqual(expected);
    expect(brief(result)).toEqual({ status, error });
    expect(sends(io())).toBe(0);
    expect(robot.status().status).toBe("READY");
    await robot.close();
  });

  test.each([
    { what: "stops the robot", error: STOPPED, seen: ["stop returned"] },
    { what: "sets the cancellation", error: PAUSED, seen: [] },
  ])("a handler that $what at Executing fails the action before its move is dispatched", async ({ what, error, seen: expected }) => {
    const { robot, io } = await handRig();
    const observation = await robot.observe();
    const cancellation = { aborted: false };
    const seen: string[] = [];

    const result = await robot.execute(ACTION, {
      referenceObservation: observation,
      cancellation,
      reportProgress: async (phase) => {
        if (phase === "Executing" && what === "stops the robot") {
          seen.push(`stop ${await tried(() => robot.stop())}`);
        } else if (phase === "Executing") {
          cancellation.aborted = true;
        }
      },
    });

    expect(seen).toEqual(expected);
    expect(brief(result)).toEqual({ status: "failed", error });
    expect(sends(io())).toBe(0);
    expect(robot.status().status).toBe("READY");
    await robot.close();
  });

  test("a handler that calls the robot again is refused each time, and the action completes", async () => {
    const { robot, io } = await handRig();
    const observation = await robot.observe();
    const seen: string[] = [];

    const result = await robot.execute(ACTION, {
      referenceObservation: observation,
      reportProgress: async (phase) => {
        if (phase === "Executing") {
          seen.push(`execute ${await tried(() => robot.execute(ACTION))}`);
          seen.push(`home ${await tried(() => robot.home({ approvePlan: () => true }))}`);
          seen.push(`recover ${await tried(() => robot.recover())}`);
          seen.push(`status ${robot.status().status}`);
          io();
        }
      },
    });

    expect(seen).toEqual([`execute ${BUSY}`, `home ${BUSY}`, `recover ${BUSY}`, "status READY"]);
    expect(brief(result)).toEqual({ status: "completed", error: null });
    expect(sends(io())).toBe(10);
    await robot.close();
  });

  test("a cancellation set while the cameras are read for the action's observation: the handler is not asked at all", async () => {
    // (by PEAR's order, robot.py: the settled HOLD, the observation, its verification, the guard's check, the report)
    const cancellation = { aborted: false };
    const rig = await handRig({ cameras: (clock) => new HookedCamera(clock, 1, () => (cancellation.aborted = true)) });
    const { robot, io } = rig;
    const seen: string[] = [];

    const result = await robot.execute(ACTION, { cancellation, reportProgress: (phase) => void seen.push(phase) });

    expect(seen).toEqual([]);
    expect(brief(result)).toEqual({ status: "failed", error: PAUSED });
    expect(sends(io())).toBe(0);
    await robot.close();
  });
});

describe("Home's approval and stage handler (PEAR's run)", () => {
  test("Home waits for an approval that sleeps three control periods, and commands nothing meanwhile", async () => {
    const rig = await awayFromHome();
    const { robot, io } = rig;
    const seen: string[] = [];

    const report = await robot.home({
      approvePlan: async () => {
        io();
        await sleepPeriods(rig, 3);
        seen.push(`review: ${robot.controlLoop.status}, ${sends(io())} commands`);
        return true;
      },
    });

    expect(seen).toEqual(["review: HOLD, 0 commands"]);
    expect((report.results as { reached: boolean }).reached).toBe(true);
    expect(sends(io())).toBe(12);
    expect(robot.status().status).toBe("READY");
    await robot.close();
  });

  test.each([
    { what: "raises", outcome: "HomeFailed: the review failed", seen: [] },
    { what: "stops the robot, then approves", outcome: "HomeFailed: Action cancelled by stop or another operation", seen: ["stop returned"] },
    { what: "sets the cancellation, then approves", outcome: "OperatorPaused: Operation interrupted by the operator", seen: [] },
  ])("an approval that $what: Home fails and nothing is commanded", async ({ what, outcome, seen: expected }) => {
    const { robot, io } = await awayFromHome();
    const cancellation = { aborted: false };
    const seen: string[] = [];

    const home = await tried(() =>
      robot.home({
        cancellation,
        approvePlan: async () => {
          if (what === "raises") {
            throw new RuntimeError("the review failed");
          }
          if (what.startsWith("stops")) {
            seen.push(`stop ${await tried(() => robot.stop())}`);
          } else {
            cancellation.aborted = true;
          }
          return true;
        },
      }),
    );

    expect(seen).toEqual(expected);
    expect(home).toBe(outcome);
    expect(sends(io())).toBe(0);
    expect(robot.status().status).toBe("READY");
    await robot.close();
  });

  test("an approval that calls the robot again is refused each time, and Home is reached", async () => {
    const { robot, io } = await awayFromHome();
    const seen: string[] = [];

    const report = await robot.home({
      approvePlan: async () => {
        seen.push(`execute ${await tried(() => robot.execute(ACTION))}`);
        seen.push(`home ${await tried(() => robot.home({ approvePlan: () => true }))}`);
        seen.push(`recover ${await tried(() => robot.recover())}`);
        return true;
      },
    });

    expect(seen).toEqual([`execute ${BUSY}`, `home ${BUSY}`, `recover ${BUSY}`]);
    expect((report.results as { reached: boolean }).reached).toBe(true);
    expect(sends(io())).toBe(12);
    await robot.close();
  });

  test("Home waits for a stage handler that sleeps two control periods at each stage", async () => {
    const rig = await awayFromHome();
    const { robot } = rig;
    const seen: string[] = [];

    const report = await robot.home({
      approvePlan: () => true,
      reportProgress: async (update) => {
        await sleepPeriods(rig, 2);
        seen.push(`${String(update.stage)}: ${robot.controlLoop.status}`);
      },
    });

    expect(seen).toEqual(["checking: HOLD", "checking: HOLD", "homing: HOLD", "completed: HOLD"]);
    expect((report.results as { reached: boolean }).reached).toBe(true);
    await robot.close();
  });

  test("a stage handler that fails at its second stage fails Home with its error, by throwing or by rejecting", async () => {
    for (const isAsync of [false, true]) {
      const { robot, io } = await awayFromHome();
      const seen: string[] = [];
      const fail = (update: { stage?: unknown }): void => {
        seen.push(String(update.stage));
        if (seen.length === 2) {
          throw new RuntimeError("the handler failed");
        }
      };

      const home = await tried(() => robot.home({ approvePlan: () => true, reportProgress: isAsync ? async (update) => fail(update) : fail }));

      expect(seen).toEqual(["checking", "checking"]);
      expect(home).toBe("HomeFailed: the handler failed");
      expect(sends(io())).toBe(0);
      expect(robot.status().status).toBe("READY");
      await robot.close();
    }
  });

  test("a cancellation set while Home reads the cameras: the approval is not asked", async () => {
    // (by PEAR's order, motion/homing.py: the observation, the plan, the guard's check, then the review)
    const cancellation = { aborted: false };
    let cameras: HookedCamera | null = null;
    const rig = await handRig({ station: "so101_quick_home", cameras: (clock) => (cameras = new HookedCamera(clock, null, () => (cancellation.aborted = true))) });
    const { robot, io } = rig;
    expect(brief(await robot.execute(delta(0.05)))).toEqual({ status: "completed", error: null });
    const camera = cameras as HookedCamera | null;
    camera!.at = camera!.reads + 1; // Home's own observation is the next read
    io();
    let asked = 0;

    const home = await tried(() => robot.home({ cancellation, approvePlan: () => ((asked += 1), true) }));

    expect(home).toBe("OperatorPaused: Operation interrupted by the operator");
    expect(camera!.reads).toBe(camera!.at);
    expect(asked).toBe(0);
    expect(sends(io())).toBe(0);
    await robot.close();
  });
});

describe("what PEAR's one thread cannot do: a promise that is pending while the page goes on", () => {
  test("a handler that never settles keeps the robot taken for good: a stop works, every later action is refused, also in a new session", async () => {
    const rig = await handRig();
    const { robot, clock, io } = rig;
    let phase = "";
    let hasEnded = false;
    const first = robot.execute(ACTION, { reportProgress: (reported) => ((phase = reported), reported === "Executing" ? never : undefined) });
    void first.then(
      () => (hasEnded = true),
      () => (hasEnded = true),
    );
    await turns(3);
    expect(phase).toBe("Executing");

    expect(await tried(() => robot.stop())).toBe("returned");
    expect(await tried(() => robot.execute(ACTION))).toBe(BUSY);
    expect(await tried(() => robot.home({ approvePlan: () => true }))).toBe(BUSY);
    expect(await tried(() => robot.recover())).toBe(BUSY);
    expect(sends(io())).toBe(0);
    expect(robot.status().status).toBe("READY");

    // a close and a new session do not give the place back
    expect(await tried(() => robot.close())).toBe("returned");
    expect(robot.status()).toEqual({ status: "OFF" });
    await robot.open();
    clock.controlLoop = robot.controlLoop;
    await robot.waitStationary();
    expect(await tried(() => robot.execute(ACTION))).toBe(BUSY);
    expect(await tried(() => robot.home({ approvePlan: () => true }))).toBe(BUSY);
    expect(await tried(() => robot.recover())).toBe(BUSY);
    await turns(3);
    expect(hasEnded).toBe(false);
    await robot.close();
  });

  test("an approval that never settles: Home never returns, nothing is commanded, and the robot stays taken", async () => {
    const { robot, io } = await awayFromHome();
    let isAsked = false;
    let hasEnded = false;
    const home = robot.home({ approvePlan: () => ((isAsked = true), never) });
    void home.then(
      () => (hasEnded = true),
      () => (hasEnded = true),
    );
    await turns(3);
    expect(isAsked).toBe(true);

    expect(await tried(() => robot.stop())).toBe("returned");
    expect(await tried(() => robot.execute(ACTION))).toBe(BUSY);
    expect(await tried(() => robot.home({ approvePlan: () => true }))).toBe(BUSY);
    expect(sends(io())).toBe(0);
    await turns(3);
    expect(hasEnded).toBe(false);
    await robot.close();
  });

  test.each([
    { what: "a stop", error: STOPPED },
    { what: "the cancellation", error: PAUSED },
  ])("$what from outside while a handler is pending: the action fails once the handler settles, with nothing commanded", async ({ what, error }) => {
    const { robot, io } = await handRig();
    const cancellation = { aborted: false };
    let release: () => void = () => undefined;
    let phase = "";
    const acting = robot.execute(ACTION, {
      cancellation,
      reportProgress: (reported) => ((phase = reported), reported === "Executing" ? new Promise<void>((resolve) => (release = resolve)) : undefined),
    });
    await turns(3);
    expect(phase).toBe("Executing");

    if (what === "a stop") {
      await robot.stop();
    } else {
      cancellation.aborted = true;
    }
    release();

    expect(brief(await acting)).toEqual({ status: "failed", error });
    expect(sends(io())).toBe(0);
    expect(robot.status().status).toBe("READY");
    await robot.close();
  });

  test.each([
    { what: "a stop", outcome: "HomeFailed: Action cancelled by stop or another operation" },
    { what: "the cancellation", outcome: "OperatorPaused: Operation interrupted by the operator" },
  ])("$what from outside while the approval is pending, then the approval: Home fails with nothing commanded", async ({ what, outcome }) => {
    const { robot, io } = await awayFromHome();
    const cancellation = { aborted: false };
    let approve: (answer: boolean) => void = () => undefined;
    let isAsked = false;
    const home = tried(() => robot.home({ cancellation, approvePlan: () => ((isAsked = true), new Promise<boolean>((resolve) => (approve = resolve))) }));
    await turns(3);
    expect(isAsked).toBe(true);

    if (what === "a stop") {
      await robot.stop();
    } else {
      cancellation.aborted = true;
    }
    approve(true);

    expect(await home).toBe(outcome);
    expect(sends(io())).toBe(0);
    expect(robot.status().status).toBe("READY");
    await robot.close();
  });
});
