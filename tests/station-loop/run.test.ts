// The loop that PEAR's control thread runs (`_run`), its start, its end and what a close does with it.
//
// PEAR's timing rule: a motion advances by one control period at each step whatever the clock says, and the loop
// never runs several periods in a burst after a stall. The first part replays what PEAR's own `_run` did on the
// stand-in clock of its tests (tests/fixtures/station-loop/run.json, written by tools/fixtures/loop_fixtures.py as
// PEAR's test_the_control_thread_never_bursts_after_a_stall runs it: the wait after each step and the clock at
// each step, for steps that take a part of a period, a whole one, or stall for many). The second part runs the loop
// on a clock of timers, where the loop's waits and its callers' sleeps wake in the order of their hours.

import { afterEach, describe, expect, test, vi } from "vitest";

import { OSError } from "../../src/python/errors";
import type { ArmState } from "../../src/station/joint/arm_state";
import { secondsClock, type MonotonicClock } from "../../src/station/joint/clock";
import { JointControlLoop, type ControlLog } from "../../src/station/joint/control_loop";
import type { ArmVectors } from "../../src/station/joint/driver";
import { MeasuredHoldRecovery } from "../../src/station/joint/recovery";
import type { ArmTargets } from "../../src/station/joint/operations";
import { loadFixture, stationOf, type Station } from "./fixtures";
import { settle } from "./gated";
import { loopClassOf } from "./player";
import { MemoryDriver, StandInClock } from "./standins";

interface RunCase {
  name: string;
  station: string;
  /** The control periods the loop runs. */
  periods: number;
  /** The clock when the loop began. */
  started: number;
  /** How long each step took, s. */
  durations: number[];
  /** What PEAR's loop waited after each step, s. */
  waits: number[];
  /** The clock at each step. */
  steps: number[];
  ended: number;
  status: string;
}

/**
 * What PEAR's own `close` did with a control thread that does not end (run.json, `close`): how long it joined the
 * thread, what it raised, and what it left of the loop.
 */
interface CloseRecord {
  out: { error: { type: string; message: string } };
  join_timeouts_s: number[];
  exit_is_set: boolean;
  status: string;
}

/** What a test reads of the loop besides what it shows. */
interface LoopInternals {
  exitEvent: { set(): void; isSet: boolean };
  thread: { isAlive: boolean; ended: Promise<void> } | null;
}

const GenericLoop = loopClassOf("MeasuredHoldRecovery", "station_limits", false);
/** A log that keeps nothing, for the loops whose log no test here reads (a loop without one prints its faults). */
const quiet: ControlLog = () => undefined;
const STATIONS = ["so101_station", "two_arm"] as const;

describe("the loop of PEAR's control thread on the stand-in clock, as PEAR's own ran", () => {
  const cases = loadFixture<{ cases: RunCase[] }>("run.json").cases;

  test("the fixture holds PEAR's test and its variations for both layouts", () => {
    expect(cases.map((item) => item.name)).toEqual(
      ["so101", "yam"].flatMap((robot) =>
        ["on_time", "a_stall", "steps_that_take_time", "a_late_period", "always_late"].map((name) => `${name}[${robot}]`),
      ),
    );
  });

  test.each(cases)("$name: the same wait after every step, at the same clock", async (item) => {
    const station = stationOf(item.station);
    const clock = new StandInClock();
    const driver = new MemoryDriver(station.layout, station.record.rest, clock);
    const loop = await GenericLoop.create(driver, station.controlConfig, station.robotConfig, { clock, log: quiet });
    expect(clock.now).toBe(item.started);

    // PEAR's test puts a paced exit event in the loop: each wait advances the clock by its timeout, and the event
    // is set after a number of waits. Here the loop waits on its clock, which does the same.
    const exitEvent = (loop as unknown as LoopInternals).exitEvent;
    const waits: number[] = [];
    clock.onSleep = async (seconds) => {
      waits.push(seconds);
      clock.now += seconds;
      if (waits.length >= item.periods) {
        exitEvent.set();
      }
    };
    const steps: number[] = [];
    const step = loop.step.bind(loop);
    loop.step = async () => {
      steps.push(clock.now);
      await step();
      clock.now += item.durations[steps.length - 1] as number; // how long the step took
    };

    await loop.run();

    // (toEqual compares numbers with Object.is: the same doubles)
    expect(waits).toEqual(item.waits);
    expect(steps).toEqual(item.steps);
    expect(clock.now).toBe(item.ended);
    expect(loop.status).toBe(item.status);
    // never a burst: no wait is shorter than what is left of the period, and after a stall a whole period passes
    expect(waits.length).toBe(item.periods);
  });

  test("after a stall every later wait is a whole control period (PEAR's own assertion)", () => {
    for (const item of cases.filter((candidate) => candidate.name.startsWith("a_stall"))) {
      const periodS = stationOf(item.station).controlConfig.controlPeriodS;
      for (const wait of item.waits) {
        expect(Math.abs(wait - periodS)).toBeLessThan(1e-9);
      }
    }
  });
});

/**
 * A clock of timers: a sleeper wakes when the test moves the time to its hour, the earliest first. The loop's own
 * wait between two periods and its callers' sleeps are such timers, so they wake in the order a real clock gives.
 */
class TimerClock implements MonotonicClock {
  now = 100.0;
  private readonly timers: { due: number; order: number; wake: () => void }[] = [];
  private count = 0;

  monotonic(): number {
    return this.now;
  }

  sleep(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      this.timers.push({ due: this.now + seconds, order: this.count++, wake: resolve });
    });
  }

  /** How many sleepers sleep. */
  get sleepers(): number {
    return this.timers.length;
  }

  /** Wakes the sleeper whose hour comes first, if it comes by `limit`, and returns whether one woke. */
  private async wakeNext(limit = Infinity): Promise<boolean> {
    await settle();
    let next: (typeof this.timers)[number] | undefined;
    for (const timer of this.timers) {
      if (next === undefined || timer.due < next.due || (timer.due === next.due && timer.order < next.order)) {
        next = timer;
      }
    }
    if (next === undefined || next.due > limit) {
      return false;
    }
    this.timers.splice(this.timers.indexOf(next), 1);
    this.now = next.due > this.now ? next.due : this.now;
    next.wake();
    await settle();

    return true;
  }

  /** Lets `seconds` pass. */
  async advance(seconds: number): Promise<void> {
    const end = this.now + seconds;
    for (let woken = 0; await this.wakeNext(end); woken++) {
      // (each sleeper that woke may sleep again before the end; sleepers that never get there fail the test)
      if (woken >= 200_000) {
        throw new Error("The sleepers do not reach the end of the time");
      }
    }
    this.now = end;
  }

  /** Lets the time pass until `promise` ends, and returns what it gives. */
  async until<Result>(promise: Promise<Result>): Promise<Result> {
    let isDone = false;
    const ended = promise.then(
      (value) => {
        isDone = true;
        return value;
      },
      (error: unknown) => {
        isDone = true;
        throw error;
      },
    );
    // (a rejection is the caller's to handle, when it awaits what this returns)
    ended.catch(() => undefined);
    for (let index = 0; !isDone; index++) {
      if (index >= 200_000) {
        throw new Error("The promise never ended");
      }
      if (!(await this.wakeNext()) && !isDone) {
        await settle();
        if (!isDone && this.timers.length === 0) {
          throw new Error("Nobody sleeps and the promise has not ended");
        }
      }
    }

    return ended;
  }
}

/** The driver in memory, which a test can hold at a reading, and which keeps its calls and whether it was closed. */
class HeldDriver extends MemoryDriver {
  /** The clock at each reading. */
  readonly readTimes: number[] = [];
  readonly calls: string[] = [];
  isClosed = false;
  /** What a reading waits for; null: nothing. */
  hold: Promise<void> | null = null;
  /** How long the next reading takes on the clock, s. */
  nextReadTakesS = 0;

  constructor(
    station: Station,
    private readonly timerClock: MonotonicClock,
  ) {
    super(station.layout, station.record.rest, timerClock);
  }

  override async read(): Promise<Record<string, ArmState>> {
    this.readTimes.push(this.timerClock.monotonic());
    if (this.hold !== null) {
      await this.hold;
    }
    if (this.nextReadTakesS > 0) {
      const seconds = this.nextReadTakesS;
      this.nextReadTakesS = 0;
      await this.timerClock.sleep(seconds);
    }
    this.calls.push("r");

    return super.read();
  }

  override async send(targets: ArmVectors, velocities: ArmVectors | null = null): Promise<void> {
    this.calls.push("s");
    return super.send(targets, velocities);
  }

  override async refreshHold(targets: ArmVectors): Promise<void> {
    this.calls.push("h");
    return super.refreshHold(targets);
  }

  override async close(): Promise<void> {
    this.calls.push("c");
    this.isClosed = true;
  }
}

/** A started loop on the clock of timers. */
async function started(stationKey: string, log?: ControlLog): Promise<{
  clock: TimerClock;
  driver: HeldDriver;
  loop: JointControlLoop<ArmState>;
  periodS: number;
}> {
  const station = stationOf(stationKey);
  const clock = new TimerClock();
  const driver = new HeldDriver(station, clock);
  const loop = (await clock.until(
    GenericLoop.open(driver, station.controlConfig, station.robotConfig, { clock, log: log ?? quiet }),
  )) as JointControlLoop<ArmState>;
  driver.calls.length = 0;
  driver.readTimes.length = 0;

  return { clock, driver, loop, periodS: station.controlConfig.controlPeriodS };
}

describe.each(STATIONS)("a started loop on a clock of timers (%s)", (station) => {
  test("open returns a loop that holds and steps once every control period", async () => {
    const { clock, driver, loop, periodS } = await started(station);
    expect(loop.status).toBe("HOLD");

    const begin = clock.now;
    await clock.advance(10 * periodS + periodS / 2);

    // open's own start made the first step at once; then one step a period
    expect(driver.readTimes.length).toBe(10);
    driver.readTimes.forEach((time, index) => {
      expect(Math.abs(time - (begin + (index + 1) * periodS))).toBeLessThan(1e-9);
    });
    expect(driver.calls.join("")).toBe("rh".repeat(10));
    await loop.close();
  });

  test("a second start is refused", async () => {
    const { loop } = await started(station);

    expect(() => loop.start()).toThrowError(expect.objectContaining({ name: "RuntimeError", message: "Runtime already started" }));
    await loop.close();
  });

  test("after a period that stalls, the next step waits a whole period: never a burst", async () => {
    const { clock, driver, loop, periodS } = await started(station);
    await clock.advance(3 * periodS + periodS / 2);
    driver.nextReadTakesS = 6.4 * periodS; // the reading of the fourth step stalls for more than six periods
    await clock.advance(20 * periodS);

    const gaps = driver.readTimes.slice(1).map((time, index) => time - (driver.readTimes[index] as number));
    // three periods on time, the stalled one, then whole periods again
    expect(gaps.slice(0, 2).every((gap) => Math.abs(gap - periodS) < 1e-9)).toBe(true);
    expect(Math.abs((gaps[3] as number) - (6.4 * periodS + periodS))).toBeLessThan(1e-9);
    expect(gaps.slice(4).every((gap) => Math.abs(gap - periodS) < 1e-9)).toBe(true);
    // twenty periods passed while the loop ran: a burst would have made up for the six that were missed
    expect(driver.readTimes.length).toBe(3 + 1 + 13);
    await loop.close();
  });

  test("a close between two periods ends the loop at once and releases the hardware", async () => {
    const { clock, driver, loop, periodS } = await started(station);
    await clock.advance(3 * periodS + periodS / 2);
    const now = clock.now;
    const reads = driver.readTimes.length;

    await loop.close();

    // no time passed: the loop's wait ended with the close, not with its period
    expect(clock.now).toBe(now);
    expect(loop.status).toBe("CLOSED");
    expect(driver.isClosed).toBe(true);
    expect((loop as unknown as LoopInternals).thread!.isAlive).toBe(false);
    await clock.advance(10 * periodS);
    expect(driver.readTimes.length).toBe(reads);
    expect(driver.calls.at(-1)).toBe("c");
    // a second close does nothing
    await loop.close();
    expect(driver.calls.filter((call) => call === "c").length).toBe(1);
  });

  test("a close during a period waits for the period, then releases the hardware", async () => {
    const { clock, driver, loop, periodS } = await started(station);
    await clock.advance(2 * periodS + periodS / 2);
    let release!: () => void;
    driver.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await clock.advance(periodS); // the third period began and waits at its reading
    driver.calls.length = 0;

    const closing = loop.close();
    await settle();
    expect(driver.isClosed).toBe(false);
    expect(loop.status).toBe("HOLD");

    driver.hold = null;
    release();
    await closing;

    // the period's own calls, then the close
    expect(driver.calls.join("")).toBe("rhc");
    expect(loop.status).toBe("CLOSED");
    expect(clock.now).toBeLessThan(100 + 100 * periodS);
  });

  test("a loop that does not end within its time keeps the hardware: the close throws", async () => {
    const { clock, driver, loop, periodS } = await started(station);
    await clock.advance(2 * periodS + periodS / 2);
    driver.hold = new Promise<void>(() => undefined); // a reading that never returns
    await clock.advance(periodS);
    const began = clock.now;

    const closing = loop.close();
    const failure = clock.until(closing).then(
      () => null,
      (error: unknown) => error as Error,
    );
    const error = await failure;

    expect(error).toMatchObject({
      name: "RuntimeError",
      message: "Control thread did not stop; hardware not closed concurrently",
    });
    expect(driver.isClosed).toBe(false);
    expect(loop.status).toBe("HOLD");
    // PEAR joins its thread for THREAD_JOIN_S
    expect(clock.now).toBeGreaterThanOrEqual(100 + 2 * periodS + JointControlLoop.THREAD_JOIN_S);

    // and for no longer: what PEAR's own close did with a thread that does not end (its join's timeout, what it
    // raised, the loop it left) is what this close did, to the instant
    const pears = loadFixture<{ close: CloseRecord }>("run.json").close;
    expect(pears.join_timeouts_s).toHaveLength(1);
    expect(clock.now).toBe(began + (pears.join_timeouts_s[0] as number));
    expect({ type: error?.name, message: error?.message }).toEqual(pears.out.error);
    expect(loop.status).toBe(pears.status);
    expect((loop as unknown as LoopInternals).exitEvent.isSet).toBe(pears.exit_is_set);
    expect(clock.sleepers).toBe(0);
  });

  test("a move on the running loop is waited for, and a shutdown stops, waits and closes", async () => {
    const { clock, driver, loop } = await started(station);
    const targets = Object.fromEntries(Object.entries(loop.targets).map(([arm, target]) => [arm, [...target]]));
    targets[loop.layout.arms[0] as string]![0]! += 0.1;

    loop.move(targets);
    const reached = await clock.until(loop.waitForHold(20.0));

    expect(reached.status).toBe("HOLD");
    expect(reached.arrival.settled).toBe(true);
    expect(reached.arrival.reached).toBe(true);
    expect(reached.motion.end_reason).toBe("finished");
    // (the held targets are the move's last sample, which is the goal to within the last digits)
    for (const [arm, target] of Object.entries(targets)) {
      target.forEach((coordinate, index) => {
        expect(Math.abs((reached.targets[arm]![index] as number) - coordinate)).toBeLessThan(1e-12);
      });
    }

    targets[loop.layout.arms[0] as string]![0]! += 1.0;
    loop.move(targets);
    await clock.advance(0.5);
    expect(loop.status).toBe("RUNNING");
    await clock.until(loop.shutdown());

    expect(loop.status).toBe("CLOSED");
    expect(driver.isClosed).toBe(true);
    expect(loop.snapshot().motion.end_reason).toBe("stopped");
  });

  test("a recovery on the running loop reacquires the hold", async () => {
    const { clock, driver, loop, periodS } = await started(station);
    driver.isStale = true;
    await clock.advance(2 * periodS);
    driver.isStale = false;
    expect(loop.status).toBe("FAULT");

    const recovered = await clock.until(loop.recover());

    expect(recovered.status).toBe("HOLD");
    expect(recovered.motion.end_reason).toBe("recovered");
    await loop.close();
  });
});

describe("the start and the end of a loop", () => {
  const station = stationOf("so101_station");

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a start that fails closes the driver; the constructor alone does not", async () => {
    const texts = station.layout.texts;
    for (const [make, closes] of [
      ["open", true],
      ["create", false],
    ] as const) {
      const clock = new TimerClock();
      const driver = new HeldDriver(station, clock);
      driver.velocity = 1.0; // arms that never come to rest: enabling times out
      const made = clock.until(GenericLoop[make](driver, station.controlConfig, station.robotConfig, { clock }));

      await expect(made).rejects.toMatchObject({ name: "RuntimeError", message: texts.unsettled_start });
      expect(driver.isClosed).toBe(closes);
    }
  });

  test("the configurations a loop shows are copies of the copies it runs with", async () => {
    const clock = new StandInClock();
    const driver = new MemoryDriver(station.layout, station.record.rest, clock);
    const controlConfig = station.controlConfig;
    const loop = await GenericLoop.create(driver, controlConfig, station.robotConfig, { clock, log: quiet });

    // a caller's later change to its own objects is not seen
    const rate = controlConfig.rate_hz;
    controlConfig.rate_hz = rate / 2;
    expect(loop.controlConfig.rate_hz).toBe(rate);
    expect(loop._controlConfig.rate_hz).toBe(rate);
    // nor a change to what the loop shows
    loop.controlConfig.rate_hz = 1;
    (loop.robotConfig as unknown as { position_tolerance: number }).position_tolerance = 99;
    expect(loop.controlConfig.rate_hz).toBe(rate);
    expect((loop.robotConfig as unknown as { position_tolerance: number }).position_tolerance).not.toBe(99);
    expect(loop.robotConfig).not.toBe(loop._robotConfig);
    expect(loop.robotConfig.constructor).toBe(station.robotConfig.constructor);
    expect(loop.robotConfig.jointLimits().lowerBounds).toEqual(station.robotConfig.jointLimits().lowerBounds);
    controlConfig.rate_hz = rate;
  });

  test("a step that fails ends the loop, which is told; a recovery is then refused", async () => {
    // a recovery policy whose fault targets cannot be made: the fault itself fails, once
    let failures = 1;
    class FailingPolicy extends MeasuredHoldRecovery {
      override faultTargets(controlLoop: JointControlLoop): ArmTargets {
        if (failures > 0) {
          failures -= 1;
          throw new OSError("no targets");
        }
        return super.faultTargets(controlLoop);
      }
    }
    class FailingLoop extends GenericLoop<ArmState> {
      static override readonly RECOVERY_POLICY_CLASS = FailingPolicy;
    }
    const logged: [string, string, unknown][] = [];
    const clock = new TimerClock();
    const driver = new HeldDriver(station, clock);
    const loop = await clock.until(
      FailingLoop.open(driver, station.controlConfig, station.robotConfig, {
        clock,
        log: (level, message, error) => logged.push([level, message, error]),
      }),
    );
    const periodS = station.controlConfig.controlPeriodS;
    await clock.advance(2 * periodS);
    const reads = driver.readTimes.length;
    const printed = vi.spyOn(console, "error").mockImplementation(() => undefined);

    driver.isStale = true;
    await clock.advance(3 * periodS);

    // the step threw out of the loop, which ended with the state as it was and told its log
    expect(logged.at(-1)?.slice(0, 2)).toEqual(["error", "The control thread failed"]);
    expect((logged.at(-1)?.[2] as Error).message).toBe("no targets");
    // `start` prints the failure too, whatever the log does (Python prints the traceback of a thread that died)
    expect(printed.mock.calls).toEqual([["Exception in thread station-control:", logged.at(-1)?.[2]]]);
    expect((loop as unknown as LoopInternals).thread!.isAlive).toBe(false);
    expect(driver.readTimes.length).toBe(reads + 1);
    expect(loop.status).toBe("HOLD");

    // a step by hand now faults; the recovery finds no control thread
    await loop.step();
    driver.isStale = false;
    expect(loop.status).toBe("FAULT");
    await expect(loop.recover()).rejects.toMatchObject({
      name: "RuntimeError",
      message: "Recovery blocked: control thread is not running",
    });
    await loop.close();
    expect(driver.isClosed).toBe(true);
  });

  test("run, awaited by its caller, throws what the step threw, after its log was told", async () => {
    // (PEAR's thread logs the failure and raises it again: a caller that runs the loop itself gets the error)
    class FailingPolicy extends MeasuredHoldRecovery {
      override faultTargets(): ArmTargets {
        throw new OSError("no targets");
      }
    }
    class FailingLoop extends GenericLoop<ArmState> {
      static override readonly RECOVERY_POLICY_CLASS = FailingPolicy;
    }
    const logged: [string, string][] = [];
    const clock = new TimerClock();
    const driver = new HeldDriver(station, clock);
    const loop = await clock.until(
      FailingLoop.create(driver, station.controlConfig, station.robotConfig, {
        clock,
        log: (level, message) => logged.push([level, message]),
      }),
    );
    const running = loop.run();
    const outcome = running.then(
      () => "ended",
      (error: unknown) => error,
    );
    const periodS = station.controlConfig.controlPeriodS;
    await clock.advance(2 * periodS);
    expect(logged).toEqual([]);

    driver.isStale = true;
    await clock.advance(3 * periodS);

    const thrown = await outcome;
    expect(thrown).toBeInstanceOf(OSError);
    expect((thrown as Error).message).toBe("no targets");
    expect(logged.at(-1)).toEqual(["error", "The control thread failed"]);
    expect(loop.status).toBe("HOLD");
  });

  test("a loop that is given no clock reads the page's, in seconds", () => {
    // (no test here runs on real time: what a real timer makes of a control period is measured, not asserted; see
    // docs/progress/loop.md)
    const driver = new MemoryDriver(station.layout, station.record.rest, secondsClock());
    const loop = new GenericLoop(driver, station.controlConfig, station.robotConfig);

    expect(Math.abs(loop.clock.monotonic() - performance.now() / 1000)).toBeLessThan(1.0);
    expect(loop.status).toBe("HOLD");
    expect(loop.generation).toBe(0);
  });
});
