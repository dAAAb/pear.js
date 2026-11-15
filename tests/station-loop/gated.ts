// A driver whose every call waits until the test lets it through, and a rig of the control loop on it.
//
// PEAR's control loop is a thread and its callers are other threads, kept apart by one lock. In pear.js there is one
// thread, and what stands for another thread's turn is the time a call of the arm takes: while a control period
// awaits its driver, a caller's code runs. With this driver a test puts a caller's stop, move, recover or close at
// an exact await of a period, and compares what the loop then does with the two orders PEAR's lock allows: the
// call before the period, or the period before the call.

import type { SO101RobotConfig } from "../../src/so101/config";
import { SO101ControlLoop } from "../../src/so101/joint/control_loop";
import { ArmState } from "../../src/station/joint/arm_state";
import type { ControlConfig, RobotConfig } from "../../src/station/joint/config";
import type { JointControlLoop } from "../../src/station/joint/control_loop";
import { JointDriver, type ArmVectors } from "../../src/station/joint/driver";
import type { JointLayout } from "../../src/station/joint/layout";
import { plain } from "./compare";
import { errorOutcome, stationOf, type Outcome } from "./fixtures";
import { loopClassOf, stateOf } from "./player";
import { MemoryDriver, StandInClock, StandInSO101Driver, type ProbedMethod } from "./standins";

/** A call of the driver that waits for the test. */
export interface Gate {
  method: ProbedMethod;
  /** Lets the call through to the arm. */
  open(): void;
  /** Has the call throw instead. */
  fail(error: Error): void;
}

/** Resolves once every continuation that is ready has run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * A stand-in driver behind a gate (by default the driver in memory of PEAR's tests): while `isGated`, a call reaches
 * the arm only once the test opens it. Every call that went through is kept, in order, as the fixtures record a
 * driver's calls ("r", "R", "h", "c", ["s", targets, velocities]; a call that threw as [code + "!", class, message]).
 */
export class GatedDriver<Inner extends JointDriver<ArmState> = MemoryDriver> extends JointDriver<ArmState> {
  isGated = false;
  /** The calls that wait, the oldest first. */
  readonly waiting: Gate[] = [];
  /** The calls that went through or threw, in order. */
  readonly calls: unknown[] = [];
  /** What the next call of a method throws, once it is past its gate. */
  readonly failures: Partial<Record<ProbedMethod, Error>> = {};

  constructor(
    readonly inner: Inner,
    private readonly layout: JointLayout,
  ) {
    super();
  }

  /** What the driver behind the gate adds to a snapshot's motion: no call of the arm, so it does not wait. */
  override telemetry(): Record<string, unknown> {
    return this.inner.telemetry();
  }

  async read(): Promise<Record<string, ArmState>> {
    return this.through("read", "r", () => this.inner.read());
  }

  async readForRecovery(): Promise<Record<string, ArmState>> {
    return this.through("read_for_recovery", "R", () => this.inner.readForRecovery());
  }

  async send(targets: ArmVectors, velocities: ArmVectors | null = null): Promise<void> {
    const entry = ["s", this.layout.join(targets), velocities === null ? null : this.layout.join(velocities)];

    return this.through("send", entry, () => this.inner.send(targets, velocities));
  }

  override async refreshHold(targets: ArmVectors): Promise<void> {
    return this.through("refresh_hold", "h", () => this.inner.refreshHold(targets));
  }

  async close(): Promise<void> {
    return this.through("close", "c", () => this.inner.close());
  }

  /** Waits at the gate, then makes the call of the arm and keeps it. */
  private async through<Result>(method: ProbedMethod, entry: unknown, call: () => Promise<Result>): Promise<Result> {
    try {
      if (this.isGated) {
        await new Promise<void>((resolve, reject) => {
          this.waiting.push({ method, open: resolve, fail: reject });
        });
      }
      const failure = this.failures[method];
      if (failure !== undefined) {
        delete this.failures[method];
        throw failure;
      }
      const result = await call();
      this.calls.push(entry);

      return result;
    } catch (error) {
      const failed = Array.isArray(entry) ? entry : [entry];
      this.calls.push([`${failed[0] as string}!`, (error as Error).name, (error as Error).message]);
      throw error;
    }
  }
}

/** One line a loop told its log: the level, the message and what was thrown, if anything was. */
export type LoggedLine = [level: string, message: string, error: unknown];

export interface RigOptions {
  /**
   * The loop and its driver: "memory" (by default), a generic loop on the driver in memory, as the fixtures'
   * "memory" rig; "so101", the SO-101's own loop on its own driver over the stand-in arm, as the fixtures' "so101"
   * rig (its station, its recovery and its braking are the SO-101's).
   */
  kind?: "memory" | "so101";
  /** The station of the fixtures whose layout and settings the loop takes (by default the SO-101's). */
  station?: string;
  recovery?: "MeasuredHoldRecovery" | "ReleaseRecovery";
  braking?: "station_limits" | "move_caps";
}

/**
 * A control loop on a gated driver and the stand-in clock: a generic loop on the driver in memory, as the fixtures'
 * "memory" rig makes it (`make`), or the SO-101's loop on its driver, as their "so101" rig (`makeSO101`).
 */
export class GatedRig<Inner extends JointDriver<ArmState> = MemoryDriver> {
  /** The most control periods the callers that wait may sleep once their sleeps step the loop. */
  static readonly MOST_SLEEPS = 5000;

  /** One control period, s. */
  readonly periodS: number;

  private constructor(
    readonly clock: StandInClock,
    readonly driver: GatedDriver<Inner>,
    readonly loop: JointControlLoop<ArmState>,
    readonly layout: JointLayout,
    readonly controlConfig: ControlConfig,
    readonly robotConfig: RobotConfig,
    /**
     * What the loop told its log, in order: the rig gives the loop a log of its own, so that the faults a test makes
     * on purpose are kept here and not printed (a loop that is given no log prints what PEAR logs at error level).
     */
    readonly logged: LoggedLine[],
  ) {
    this.periodS = controlConfig.controlPeriodS;
  }

  static async make(options: RigOptions = {}): Promise<GatedRig> {
    const station = stationOf(options.station ?? "so101_station");
    const clock = new StandInClock();
    const driver = new GatedDriver(new MemoryDriver(station.layout, station.record.rest, clock), station.layout);
    const loopClass = loopClassOf(
      options.recovery ?? "MeasuredHoldRecovery",
      options.braking ?? "station_limits",
      false,
    );
    const logged: LoggedLine[] = [];
    const loop = (await loopClass.create(driver, station.controlConfig, station.robotConfig, {
      clock,
      log: (level, message, error) => logged.push([level, message, error]),
    })) as JointControlLoop<ArmState>;

    return new GatedRig(clock, driver, loop, station.layout, station.controlConfig, station.robotConfig, logged);
  }

  /** The SO-101's own loop (its gripper operation, its recovery, its braking) on its own driver behind the gate. */
  static async makeSO101(): Promise<GatedRig<StandInSO101Driver>> {
    const station = stationOf("so101_station");
    const clock = new StandInClock();
    const inner = new StandInSO101Driver(station.robotConfig as SO101RobotConfig, clock);
    const driver = new GatedDriver<StandInSO101Driver>(inner, station.layout);
    const logged: LoggedLine[] = [];
    const loop = (await SO101ControlLoop.create(driver, station.controlConfig, station.robotConfig, {
      clock,
      log: (level, message, error) => logged.push([level, message, error]),
    })) as JointControlLoop<ArmState>;

    return new GatedRig<StandInSO101Driver>(
      clock,
      driver,
      loop,
      station.layout,
      station.controlConfig,
      station.robotConfig,
      logged,
    );
  }

  /** Makes every reading of the stand-in arm stale, or fresh again. */
  setStale(isStale: boolean): void {
    const inner: unknown = this.driver.inner;
    if (inner instanceof StandInSO101Driver) {
      inner.hardware.isStale = isStale;
    } else {
      (inner as MemoryDriver).isStale = isStale;
    }
  }

  /** Advances the clock by one control period and steps, `count` times, with no call waiting. */
  async tick(count = 1): Promise<void> {
    this.driver.isGated = false;
    for (let index = 0; index < count; index++) {
      this.clock.now += this.periodS;
      await this.loop.step();
    }
  }

  /** Steps until the loop's status is one of `statuses`. */
  async until(...statuses: string[]): Promise<void> {
    for (let index = 0; !statuses.includes(this.loop.status); index++) {
      if (index >= 2000) {
        throw new Error(`Still ${this.loop.status} after 2000 steps`);
      }
      await this.tick();
    }
  }

  /** Advances the clock by one control period and starts a step whose every driver call waits. */
  begin(): Promise<void> {
    this.driver.isGated = true;
    this.clock.now += this.periodS;

    return this.loop.step();
  }

  /** Lets the calls before it through until the oldest call that waits is `method`; throws if another one is. */
  async at(method: ProbedMethod, occurrence = 1): Promise<void> {
    let seen = 0;
    for (let index = 0; index < 50; index++) {
      await settle();
      const gate = this.driver.waiting[0];
      if (gate === undefined) {
        throw new Error(`No call of the driver waits (wanted ${method}); calls so far: ${JSON.stringify(this.driver.calls.slice(-4))}`);
      }
      if (gate.method === method) {
        seen += 1;
        if (seen === occurrence) {
          return;
        }
      }
      this.driver.waiting.shift();
      gate.open();
    }
    throw new Error(`The period never reached ${method} (${occurrence})`);
  }

  /** Lets the oldest call that waits through. */
  async pass(): Promise<void> {
    await settle();
    const gate = this.driver.waiting.shift();
    if (gate === undefined) {
      throw new Error("No call of the driver waits");
    }
    gate.open();
    await settle();
  }

  /** Has the oldest call that waits throw `error`. */
  async fail(error: Error): Promise<void> {
    await settle();
    const gate = this.driver.waiting.shift();
    if (gate === undefined) {
      throw new Error("No call of the driver waits");
    }
    gate.fail(error);
    await settle();
  }

  /** Stops gating and lets every call through until `promises` have all ended, however they end. */
  async drain(...promises: Promise<unknown>[]): Promise<void> {
    this.driver.isGated = false;
    let isDone = false;
    void Promise.allSettled(promises).then(() => {
      isDone = true;
    });
    for (let index = 0; !isDone; index++) {
      if (index >= 10_000) {
        throw new Error("The calls never ended");
      }
      for (const gate of this.driver.waiting.splice(0)) {
        gate.open();
      }
      await settle();
    }
  }

  /** The sleeps of waiting callers that are held, the oldest first: each wakes its sleeper. */
  private readonly parked: (() => Promise<void>)[] = [];

  /** Holds every sleeper where it sleeps, so that the test steps the loop by hand while a caller waits. */
  parkSleeps(): void {
    this.clock.onSleep = (seconds) =>
      new Promise<void>((resolve) => {
        this.parked.push(async () => {
          this.clock.now += seconds;
          await this.loop.step();
          resolve();
        });
      });
  }

  /**
   * Wakes the sleepers that are held and has every sleep from now on advance the clock and step the loop once, as
   * the stand-in clock of PEAR's tests does.
   */
  async resumeSleeps(): Promise<void> {
    this.driver.isGated = false;
    let sleeps = 0;
    this.clock.onSleep = async (seconds) => {
      sleeps += 1;
      if (sleeps > GatedRig.MOST_SLEEPS) {
        // (a wait that never ends fails its test instead of stepping for ever)
        throw new Error(`A caller still sleeps after ${GatedRig.MOST_SLEEPS} control periods`);
      }
      this.clock.now += seconds;
      await this.loop.step();
    };
    await settle();
    for (const wake of this.parked.splice(0)) {
      await wake();
    }
  }

  /** The held targets with one coordinate of the first arm moved by `delta`. */
  jogged(delta: number, index = 0): Record<string, number[]> {
    const targets = Object.fromEntries(Object.entries(this.loop.targets).map(([arm, target]) => [arm, [...target]]));
    targets[this.layout.arms[0] as string]![index]! += delta;

    return targets;
  }

  /** Faults the loop where it is, by one period of stale feedback, and makes the feedback fresh again. */
  async faultByStaleFeedback(): Promise<void> {
    this.setStale(true);
    await this.tick();
    this.setStale(false);
  }

  /** What the loop holds: its snapshot and what else it keeps of its operation, as the fixtures record it. */
  state(): unknown {
    return stateOf(this.loop);
  }
}

/** What a caller's call gave: what it returned or threw, awaited if it is a promise. */
export async function outcomeOfCall(call: () => unknown): Promise<Outcome> {
  try {
    const value = await call();
    return { ok: plain(value) };
  } catch (error) {
    return errorOutcome(error);
  }
}

/** A caller's call that was made at once and whose outcome is collected later. */
export interface Started {
  /** What the call gave, once it has ended. */
  outcome: Promise<Outcome>;
}

/** Makes `call` now, and returns what collects its outcome: a synchronous call has its outcome already. */
export function startCall(call: () => unknown): Started {
  let result: unknown;
  try {
    result = call();
  } catch (error) {
    return { outcome: Promise.resolve(errorOutcome(error)) };
  }
  if (result instanceof Promise) {
    return {
      outcome: result.then(
        (value: unknown): Outcome => ({ ok: plain(value) }),
        (error: unknown) => errorOutcome(error),
      ),
    };
  }

  return { outcome: Promise.resolve({ ok: plain(result) }) };
}
