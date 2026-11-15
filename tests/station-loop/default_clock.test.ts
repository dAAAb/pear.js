// Not from PEAR: the clock of a loop that is given none (the rule in src/station/joint/clock.ts). It stands beside
// the loop's tests because it needs their stand-in arm. The first tests always run and promise no time: they
// show which clock a part reads and sleeps on. The last runs only when PEAR_JS_REAL_TIME=1 is set: it runs the
// SO-101's loop, made without a clock, on the stand-in arm in real time, prints what it measured, and asserts only
// what holds on any machine.

import { afterEach, describe, expect, test, vi } from "vitest";

import type { SO101RobotConfig } from "../../src/so101/config";
import { WristCamera } from "../../src/so101/hardware/cameras";
import { SO101ControlLoop } from "../../src/so101/joint/control_loop";
import { DeadlineClock, realTimeClock } from "../../src/station/joint/deadline_clock";
import { RecoveryRequest } from "../../src/station/joint/recovery";
import { SnapshotCheck } from "../../src/station/joint/snapshot_checks";
import { StabilityWindow } from "../../src/station/joint/stability";
import { stationOf } from "./fixtures";
import { StandInSO101Driver } from "./standins";

const REAL_TIME = process.env["PEAR_JS_REAL_TIME"] === "1";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a part that is given no clock", () => {
  test("a loop takes the one clock of real time", () => {
    const station = stationOf("so101_station");
    const clock = realTimeClock();
    const driver = new StandInSO101Driver(station.robotConfig as SO101RobotConfig, clock);
    const loop = new SO101ControlLoop(driver, station.controlConfig, station.robotConfig, { log: () => undefined });

    expect(clock).toBeInstanceOf(DeadlineClock);
    expect(loop.clock).toBe(clock);
  });

  test("a wait that tries once every period sleeps on it", async () => {
    const clock = realTimeClock();
    const before = clock.stats().sleeps;
    let attempts = 0;
    const result = await SnapshotCheck.poll((): [boolean, number] => {
      attempts += 1;
      return [attempts === 3, attempts];
    }, 0.001);

    expect(result).toBe(3);
    expect(clock.stats().sleeps).toBe(before + 2);
  });

  test("a recovery's deadline, a stability window and the wrist camera's frame age are read on it", async () => {
    const station = stationOf("so101_station");
    const read = vi.spyOn(realTimeClock(), "monotonic");

    const request = new RecoveryRequest({ stabilityError: (message: string) => new Error(message) } as unknown as StabilityWindow, 60);
    read.mockReturnValue(59.99);
    expect(() => request.checkDeadline()).not.toThrow();
    read.mockReturnValue(60);
    expect(() => request.checkDeadline()).toThrow("Recovery requires fresh stable feedback");

    type WindowParts = ConstructorParameters<typeof StabilityWindow>;
    const window = new StabilityWindow(station.controlConfig as unknown as WindowParts[0], station.robotConfig as unknown as WindowParts[1], {
      durationS: 0.5,
      isStrict: false,
      checksVelocityRms: false,
    });
    read.mockClear();
    try {
      window.add({ arms: {} } as unknown as Parameters<StabilityWindow["add"]>[0]);
    } catch {
      // a snapshot without arms is none: the window has read its clock before it finds that out
    }
    expect(read).toHaveBeenCalled();

    type CameraParts = ConstructorParameters<typeof WristCamera>;
    const reader = { isReading: true, latestFrame: {}, latestTimestamp: 10 };
    const camera = new WristCamera({ camera: { role: "wrist" } } as unknown as CameraParts[0], reader as unknown as CameraParts[1]);
    read.mockReturnValue(10 + WristCamera.MAX_AGE_S + 0.001);
    expect(await camera.readPreview()).toEqual([{}, { wrist: "Camera frame is stale" }]);
  });
});

interface LoopRun {
  open: string;
  openS: number;
  steps?: { n: number; perSecond: number; meanMs: number; p99Ms: number; maxMs: number; over25: number };
  move?: string;
  moveS?: number;
  afterStop?: string;
  afterClose?: string;
  armClosed?: boolean;
  clock?: unknown;
}

/** The SO-101's loop, made without a clock, on the stand-in arm on real time: open, a second of HOLD, a move, a stop, a close. */
async function loopOnRealTime(): Promise<LoopRun> {
  const station = stationOf("so101_station");
  const clock = realTimeClock();
  clock.resetStats();
  const driver = new StandInSO101Driver(station.robotConfig as SO101RobotConfig, clock);
  const arm = driver.hardware;
  const readAt: number[] = [];
  const read = arm.read.bind(arm);
  arm.read = async () => {
    readAt.push(performance.now());
    return read();
  };
  const began = performance.now();
  let loop: SO101ControlLoop;
  try {
    loop = (await SO101ControlLoop.open(driver, station.controlConfig, station.robotConfig, { log: () => undefined })) as SO101ControlLoop;
  } catch (error) {
    return { open: `${(error as Error).name}: ${(error as Error).message}`, openS: Math.round(performance.now() - began) / 1000, clock: clock.stats() };
  }
  const run: LoopRun = { open: loop.clock === clock ? "ok" : "ok, on another clock", openS: Math.round(performance.now() - began) / 1000 };
  try {
    const first = readAt.length;
    await clock.sleep(1.0);

    const goal = loop.requestedPosition();
    goal[0] = (goal[0] as number) + 0.2;
    const moveFrom = performance.now();
    loop.move({ [station.layout.arms[0] as string]: goal });
    const snapshot = (await loop.waitForHold(30, { label: "Motion" })) as unknown as { motion: unknown; status: string };
    run.moveS = Math.round(performance.now() - moveFrom) / 1000;
    run.move = `${snapshot.status} ${JSON.stringify(snapshot.motion)}`.slice(0, 200);

    await loop.stop();
    run.afterStop = loop.status;

    // the time from one step's read to the next, from the open to the stop
    const gaps = readAt.slice(first).map((at, index, all) => (index === 0 ? NaN : at - (all[index - 1] as number))).slice(1);
    const sorted = [...gaps].sort((one, other) => one - other);
    const round = (value: number): number => Math.round(value * 1000) / 1000;
    const total = gaps.reduce((sum, value) => sum + value, 0);
    run.steps = {
      n: gaps.length,
      perSecond: round((gaps.length / total) * 1000),
      meanMs: round(total / gaps.length),
      p99Ms: round(sorted[Math.max(0, Math.ceil(0.99 * sorted.length) - 1)] as number),
      maxMs: round(sorted[sorted.length - 1] as number),
      over25: gaps.filter((value) => value > 25).length,
    };
  } finally {
    await loop.close();
    run.afterClose = loop.status;
    run.armClosed = arm.isClosed;
    run.clock = clock.stats();
  }
  return run;
}

describe.skipIf(!REAL_TIME)("the loop made without a clock, on real time (measures; only with PEAR_JS_REAL_TIME=1)", () => {
  test("the stand-in arm: open, a second of HOLD, a move, a stop, a close; what happened is printed", { timeout: 60_000 }, async () => {
    const run = await loopOnRealTime();
    console.log(`REAL_TIME ${JSON.stringify({ what: "loop", platform: process.platform, node: process.version, ...run })}`);
    // what holds on any machine: the loop is on the clock of real time, and a loop that opened is closed again
    expect(["ok", "RuntimeError: Enable requires the arm to settle; startup timed out"]).toContain(run.open);
    if (run.open === "ok") {
      expect(run.afterClose).toBe("CLOSED");
      expect(run.armClosed).toBe(true);
    }
  });
});
