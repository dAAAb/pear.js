// PEAR's stepped rig of its robot, built by hand: for the tests of what no record of PEAR can hold (what a caller
// writes into an observation it holds, calls that arrive while a control period is under way, a handler that takes
// its time). The robot, its control loop, its driver and the stand-in arm are the ones of rig.ts. Nothing is
// replayed here, so the kinematics are pear.js's own and the UUIDs are counted.

import { ARM, LAYOUT } from "../../src/so101/layout";
import { SO101Robot } from "../../src/so101/robot";
import type { CameraSource } from "../../src/station/cameras";
import type { MonotonicClock } from "../../src/station/joint/clock";
import type { MotionResult } from "../../src/station/motion/results";
import { Probe, type StandInClock, type StandInSO101Driver } from "../station-loop/standins";
import { stationOf } from "./fixtures";
import { RecordingClock, StandInCameras, SteppedStandInSO101Robot } from "./rig";

/** The action of the SO-101's format that moves the gripper's tip by `z` metres and sets the gripper's `width`. */
export function delta(z: number, width = 0): Record<string, unknown> {
  return { type: "single_arm_delta", arm: { x: 0, y: 0, z, pitch: 0, roll: 0 }, gripper: { width } };
}

/** The number of commands among the driver's `calls` (the record of ../station-loop/standins.ts). */
export function sends(calls: readonly unknown[]): number {
  return calls.filter((call) => Array.isArray(call) && call[0] === "s").length;
}

/** What a call did: "returned" with its value, or "threw" with the error's class and message. */
export async function caught(call: () => unknown): Promise<string> {
  try {
    const value = await call();
    return `returned ${JSON.stringify(value)}`;
  } catch (error) {
    return `threw ${(error as Error).name}: ${(error as Error).message}`;
  }
}

/** A result's status and error, as PEAR's record of it holds them. */
export function brief(result: Pick<MotionResult, "toRecord">): { status: unknown; error: unknown } {
  const record = result.toRecord() as Record<string, unknown>;

  return { status: record["status"], error: record["error"] ?? null };
}

/** Where the arm of `robot` is measured, each joint to four decimals as PEAR's `format(value, ".4f")` gives it. */
export function measured(robot: SteppedStandInSO101Robot): string[] {
  const status = robot.status(true) as unknown as { arms: Record<string, { position: readonly number[] }> };

  return status.arms[ARM]!.position.map((value) => value.toFixed(4));
}

export interface HandRig {
  readonly clock: RecordingClock;
  readonly robot: SteppedStandInSO101Robot;
  /** What the robot logged, as "logger:level:message". */
  readonly log: string[];
  /** Takes the driver's calls since the last time. */
  io(): unknown[];
}

/**
 * Returns the SO-101 of the station `station` on the stand-in arm, opened and at rest as PEAR's sessions begin
 * (`open`, then `wait_stationary`), on the stepped rig: each sleep of the clock steps the control loop once, so no
 * control period is under way when the robot acts.
 */
export async function handRig(
  options: {
    station?: string;
    /** PEAR's drawn cameras, or the cameras a test makes on the rig's clock; by default the robot has none. */
    cameras?: "drawn" | ((clock: RecordingClock) => CameraSource<any>) | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  } = {},
): Promise<HandRig> {
  const clock = new RecordingClock();
  const log: string[] = [];
  let drawn = 0;
  let probe: Probe | null = null;
  const cameras =
    options.cameras === "drawn" ? new StandInCameras(SO101Robot.CAMERAS, clock) : (options.cameras?.(clock) ?? null);
  const robot = new SteppedStandInSO101Robot(stationOf(options.station ?? "so101_quick").config, {
    cameras: cameras as never,
    clock,
    uuid4: () => `uuid-${++drawn}`,
    log: (logger, level, message) => log.push(`${logger}:${level}:${message}`),
  });
  robot.rig = {
    attach(driver: StandInSO101Driver): void {
      probe = new Probe(driver, LAYOUT, clock as unknown as StandInClock, "so101", robot.controlPeriodS);
    },
    recordedTarget: () => null,
    asked: () => undefined,
  };
  await robot.open();
  clock.controlLoop = robot.controlLoop;
  await robot.waitStationary();
  const io = (): unknown[] => (probe as Probe | null)?.take() ?? [];
  io();

  return { clock, robot, log, io };
}

// ---- control periods started by a ticker ----
//
// On the stepped rig a control period runs inside the sleep of whoever waits, so the robot never acts while one is
// under way. On a page a timer starts the periods and each one awaits the serial line, so the robot's checks and
// submissions fall before, inside or after a period. PEAR's lock keeps them out of a period; here they are not kept
// out (docs/progress/robot.md, deliberate difference 3). Below, a ticker starts the periods, every call of the
// driver takes some turns of the event loop, and whoever sleeps is woken while a period is under way.

/** Lets the event loop take `count` turns. */
export async function turns(count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** A clock that stands still until its ticker advances it; the ticker wakes who has slept long enough. */
export class TickerClock implements MonotonicClock {
  now = RecordingClock.START_S;
  private sleepers: { at: number; wake: () => void }[] = [];

  monotonic(): number {
    return this.now;
  }

  sleep(durationS: number): Promise<void> {
    return new Promise((resolve) => this.sleepers.push({ at: this.now + durationS, wake: resolve }));
  }

  wakeDue(): void {
    const due = this.sleepers.filter((sleeper) => sleeper.at <= this.now + 1e-9);
    this.sleepers = this.sleepers.filter((sleeper) => sleeper.at > this.now + 1e-9);
    for (const sleeper of due) {
      sleeper.wake();
    }
  }
}

/** The script of every run below: a move with a closing, an opening, two moves; then Home. */
export const SCRIPT: readonly Record<string, unknown>[] = [
  delta(0.3, -1),
  { type: "gripper", command: "open" },
  delta(-0.2, 0),
  delta(0.1, 1),
];
export const SCRIPT_STATION = "so101_quick_home";

/** What a run of the script gave. */
export interface ScriptOutcome {
  /** Of each action: its result's status with its error's message, or "threw" with what `execute` threw. */
  statuses: string[];
  /** "reached" with whether Home was reached, or "threw" with what `home` threw. */
  home: string;
  /** Where the arm was measured at the end; empty once the robot is closed. */
  position: number[];
  fault: string | null;
}

/** A run with the periods started by the ticker. */
export interface TickedOutcome extends ScriptOutcome {
  /** How many submissions began an operation while a control period was under way, and how many while none was. */
  inside: number;
  outside: number;
  /** How `close()` ended when the run closed the robot during the script: "returned", or "rejected" with the error. */
  closed: string | null;
  /** The robot's status right after that `close()` ended. */
  statusAfterClose: string | null;
  /** The driver's calls after that `close()` had ended. */
  lateCalls: string[];
}

/**
 * Runs the script on `robot` as PEAR's console runs actions: after an action that did not complete it waits for
 * the brake to end in a settled HOLD.
 */
async function runScript(
  robot: SteppedStandInSO101Robot,
  cancellation: { aborted: boolean } | null = null,
): Promise<Pick<ScriptOutcome, "statuses" | "home">> {
  const statuses: string[] = [];
  for (const [index, action] of SCRIPT.entries()) {
    let result: Awaited<ReturnType<SteppedStandInSO101Robot["execute"]>>;
    try {
      result = await robot.execute(action, index === 0 && cancellation !== null ? { cancellation } : {});
    } catch (error) {
      statuses.push(`threw ${(error as Error).name}: ${(error as Error).message}`);
      continue;
    }
    statuses.push(`${result.status}${result.error ? `: ${result.error.message}` : ""}`);
    if (result.status !== "completed") {
      try {
        await robot.waitSettled(5.0);
      } catch (error) {
        statuses.push(`waitSettled threw ${(error as Error).name}: ${(error as Error).message}`);
      }
    }
  }
  let home: string;
  try {
    const report = await robot.home({ approvePlan: () => true });
    home = `reached ${String((report.results as { reached: boolean }).reached)}`;
  } catch (error) {
    home = `threw ${(error as Error).name}: ${(error as Error).message}`;
  }

  return { statuses, home };
}

/** Where the arm of `robot` is measured, or nothing once the robot is closed. */
function positionOf(robot: SteppedStandInSO101Robot): number[] {
  const arms = (robot.status(true) as unknown as { arms?: Record<string, { position: readonly number[] }> }).arms;

  return arms === undefined ? [] : [...arms[ARM]!.position];
}

/** The script on the stepped rig: what every run with a ticker is compared with. */
export async function steppedScript(): Promise<ScriptOutcome> {
  const clock = new RecordingClock();
  let drawn = 0;
  const robot = new SteppedStandInSO101Robot(stationOf(SCRIPT_STATION).config, { cameras: null, clock, uuid4: () => `uuid-${++drawn}` });
  robot.rig = { attach: () => undefined, recordedTarget: () => null, asked: () => undefined };
  await robot.open();
  clock.controlLoop = robot.controlLoop;
  const ran = await runScript(robot);
  const outcome = { ...ran, position: positionOf(robot), fault: robot.controlLoop.fault };
  await robot.close();

  return outcome;
}

/**
 * The script with the control periods started by a ticker, on the schedule that `seed` draws: how many turns of the
 * event loop each call of the driver takes before and after it acts (0 to 3, 0 to 2), and how many pass between a
 * period's start and the waking of the sleepers (0 to 3) and after its end (0 or 1). `events` names the control
 * period, counted from the script's start, right after whose start a page stops the robot, sets the first action's
 * cancellation, or closes the robot; none of them waits for the period to end.
 */
export async function tickedScript(
  seed: number,
  events: { stopAt?: number; cancelAt?: number; closeAt?: number } = {},
): Promise<TickedOutcome> {
  let state = seed >>> 0;
  const random = (most: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state >>> 8) % (most + 1);
  };
  const clock = new TickerClock();
  let drawn = 0;
  let closed: string | null = null;
  let statusAfterClose: string | null = null;
  const lateCalls: string[] = [];
  const robot = new SteppedStandInSO101Robot(stationOf(SCRIPT_STATION).config, { cameras: null, clock, uuid4: () => `uuid-${++drawn}` });
  robot.rig = {
    attach(driver: StandInSO101Driver): void {
      // each call of the driver takes some turns of the event loop, as a serial line does
      const slow = driver as unknown as Record<string, (...given: unknown[]) => Promise<unknown>>;
      for (const name of ["read", "readForRecovery", "send", "refreshHold"]) {
        const own = slow[name]!.bind(driver);
        slow[name] = async (...given: unknown[]) => {
          if (closed !== null) {
            lateCalls.push(name);
          }
          await turns(random(3));
          const value = await own(...given);
          await turns(random(2));
          return value;
        };
      }
    },
    recordedTarget: () => null,
    asked: () => undefined,
  };

  let isRunning = true;
  let isCounting = false;
  let periods = 0;
  const cancellation = { aborted: false };
  let closing: Promise<void> | null = null;
  const ticker = (async () => {
    while (isRunning) {
      clock.now += robot.controlPeriodS;
      const loop = robot.openLoop;
      const period = loop === null ? Promise.resolve() : loop.step();
      // (while the robot opens, a period is longer than a call of the driver)
      await turns(loop === null ? 8 : random(3));
      clock.wakeDue(); // whoever sleeps goes on while the control period is under way
      if (isCounting) {
        periods += 1;
        if (periods === events.stopAt) {
          void robot.stop().catch(() => undefined);
        }
        if (periods === events.cancelAt) {
          cancellation.aborted = true;
        }
        if (periods === events.closeAt) {
          const ended = (how: string) => {
            closed = how;
            statusAfterClose = String(robot.status().status);
          };
          closing = robot.close().then(
            () => ended("returned"),
            (error: Error) => ended(`rejected ${error.name}: ${error.message}`),
          );
        }
      }
      await period;
      clock.wakeDue();
      await turns(random(1));
    }
  })();

  let inside = 0;
  let outside = 0;
  await robot.open();
  await clock.sleep(robot.controlPeriodS); // the first control period
  const loop = robot.controlLoop;
  for (const name of ["dispatchJointMove", "beginGrippers", "startSequence"] as const) {
    const own = (loop[name] as (...given: unknown[]) => unknown).bind(loop);
    (loop as unknown as Record<string, unknown>)[name] = (...given: unknown[]) => {
      const isUnderWay = loop.lock.isHeld;
      const value = own(...given);
      if (value !== false) {
        if (isUnderWay) {
          inside += 1;
        } else {
          outside += 1;
        }
      }
      return value;
    };
  }
  isCounting = true;
  const ran = await runScript(robot, events.cancelAt === undefined ? null : cancellation);
  if (closing !== null) {
    await (closing as Promise<void>);
  }
  const position = positionOf(robot);
  const fault = loop.fault;
  if (robot.openLoop !== null) {
    await robot.close();
  }
  isRunning = false;
  clock.wakeDue();
  await ticker;

  return { ...ran, position, fault, inside, outside, closed, statusAfterClose, lateCalls };
}