// Who is told of a fault, of a hold that could not be commanded and of the end of the loop.
//
// PEAR's logger prints them at error level, with the traceback, and Python prints the traceback of a thread that
// died whatever the logger does (pear/deploy/station/control/joint/control_loop.py: `logger.error("station fault:
// %s")`, `logger.exception("Could not command a hold; a physical stop may be required")`,
// `logger.exception("The control thread failed")`). A loop that is given no `log` prints the three with
// `console.error`; the lower levels stay silent; `start` prints the failure that ended `run`, also for a loop whose
// own `log` drops it.
//
// The messages themselves are compared with PEAR's record in exact.test.ts (every line PEAR logged, through the
// `log` option). What is asserted here is where they go by default, which PEAR's record cannot hold: expectations
// written by hand.

import { afterEach, describe, expect, test, vi } from "vitest";

import { OSError } from "../../src/python/errors";
import type { ArmState } from "../../src/station/joint/arm_state";
import { JointControlLoop, logErrorsToConsole, type ControlLog } from "../../src/station/joint/control_loop";
import type { ArmTargets } from "../../src/station/joint/operations";
import { MeasuredHoldRecovery } from "../../src/station/joint/recovery";
import { ControlState } from "../../src/station/schemas";
import { stationOf } from "./fixtures";
import { settle } from "./gated";
import { loopClassOf } from "./player";
import { MemoryDriver, StandInClock } from "./standins";

const GenericLoop = loopClassOf("MeasuredHoldRecovery", "station_limits", false);

/** A recovery policy whose fault targets cannot be made: the fault itself fails, and the step throws out of the loop. */
class FailingPolicy extends MeasuredHoldRecovery {
  override faultTargets(): ArmTargets {
    throw new OSError("no targets");
  }
}
class FailingGenericLoop extends GenericLoop<ArmState> {
  static override readonly RECOVERY_POLICY_CLASS = FailingPolicy;
}
const FailingLoop = FailingGenericLoop as unknown as typeof JointControlLoop;

type LoggedLine = [level: string, message: string, error: unknown];

/** A loop in its first HOLD on the driver in memory, with `log` or, without one, the default. */
async function holding(log?: ControlLog, loopClass: typeof JointControlLoop = GenericLoop) {
  const station = stationOf("so101_station");
  const clock = new StandInClock();
  const driver = new MemoryDriver(station.layout, station.record.rest, clock);
  const options = log === undefined ? { clock } : { clock, log };
  const loop = (await loopClass.create(driver, station.controlConfig, station.robotConfig, options)) as JointControlLoop<ArmState>;
  const tick = async (count = 1): Promise<void> => {
    for (let index = 0; index < count; index++) {
      clock.now += station.controlConfig.controlPeriodS;
      await loop.step();
    }
  };

  return { station, clock, driver, loop, tick };
}

/** Catches what is printed with each method of the console, and prints none of it. */
function caught() {
  const methods = ["error", "warn", "info", "log", "debug"] as const;

  return Object.fromEntries(
    methods.map((method) => [method, vi.spyOn(console, method).mockImplementation(() => undefined)]),
  ) as Record<(typeof methods)[number], ReturnType<typeof vi.spyOn>>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a loop that is given no log", () => {
  test("prints a fault with what was thrown", async () => {
    // (the audit's second scratch test: before, a fault was told to nobody)
    const { driver, loop, tick } = await holding();
    const printed = caught();

    driver.isStale = true; // the reading is too old: the period faults
    await tick();

    expect(loop.status).toBe(ControlState.FAULT);
    expect(printed.error.mock.calls).toHaveLength(1);
    const [message, thrown] = printed.error.mock.calls[0] as [string, Error];
    expect(message).toBe(`station fault: ${loop.fault}`);
    expect(message).toMatch(/^station fault: .*stale/i);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toBe(loop.fault);
    for (const method of ["warn", "info", "log", "debug"] as const) {
      expect(printed[method].mock.calls).toEqual([]);
    }
  });

  test("prints that the fault's hold could not be commanded, with what the driver threw", async () => {
    const { station, driver, loop, tick } = await holding();
    const printed = caught();
    const refused = new Error("bus write failed");

    driver.isStale = true;
    driver.send = async () => {
      throw refused; // the fault's hold cannot be commanded
    };
    await tick();

    expect(loop.status).toBe(ControlState.FAULT);
    expect(printed.error.mock.calls).toHaveLength(2);
    expect((printed.error.mock.calls[0] as [string, Error])[0]).toBe(`station fault: ${loop.fault}`);
    expect(printed.error.mock.calls[1]).toEqual(["Could not command a hold; a physical stop may be required", refused]);
    // the loop knows it too: no recovery leaves this FAULT
    await expect(loop.recover()).rejects.toMatchObject({
      name: "RuntimeError",
      message: `${station.layout.texts.failed_hold}bus write failed`,
    });
  });

  test("prints the end of the loop that `start` began: the log's line, and the report of `start` itself", async () => {
    const { driver, loop } = await holding(undefined, FailingLoop);
    const printed = caught();

    driver.isStale = true; // the first period faults, and the fault itself fails: the step throws out of the loop
    loop.start();
    await settle();

    expect(printed.error.mock.calls).toHaveLength(2);
    const [[logged, thrown], [reported, rejection]] = printed.error.mock.calls as [[string, Error], [string, Error]];
    expect(logged).toBe("The control thread failed");
    expect(thrown).toBeInstanceOf(OSError);
    expect(thrown.message).toBe("no targets");
    expect(reported).toBe("Exception in thread station-control:");
    expect(rejection).toBe(thrown);
    // the loop keeps the state it had, and nothing steps it any more
    expect(loop.status).toBe(ControlState.HOLD);
    expect((loop as unknown as { thread: { isAlive: boolean } }).thread.isAlive).toBe(false);
    const reads = driver.reads;
    await settle();
    expect(driver.reads).toBe(reads);
  });

  test("prints nothing of the lower levels: a request, an end of motion, a stop, a failed read in FAULT", async () => {
    const { driver, loop, tick } = await holding();
    const printed = caught();
    const arm = loop.layout.arms[0] as string;
    const jogged = (delta: number): Record<string, number[]> => {
      const targets = Object.fromEntries(Object.entries(loop.targets).map(([name, target]) => [name, [...target]]));
      targets[arm]![0]! += delta;
      return targets;
    };

    loop.move(jogged(0.05));
    for (let period = 0; loop.status !== ControlState.HOLD; period++) {
      expect(period).toBeLessThan(2000);
      await tick();
    }
    loop.move(jogged(0.2));
    await tick(3);
    await loop.stop();
    for (let period = 0; loop.status !== ControlState.HOLD; period++) {
      expect(period).toBeLessThan(2000);
      await tick();
    }
    for (const method of ["error", "warn", "info", "log", "debug"] as const) {
      expect(printed[method].mock.calls).toEqual([]);
    }

    driver.isStale = true;
    await tick();
    driver.read = async () => {
      throw new Error("bus read failed");
    };
    await tick(2);
    expect(loop.status).toBe(ControlState.FAULT);
    expect(printed.error.mock.calls).toHaveLength(1); // the fault alone
    for (const method of ["warn", "info", "log", "debug"] as const) {
      expect(printed[method].mock.calls).toEqual([]);
    }
  });
});

describe("a console that throws", () => {
  test("breaks neither the fault's hold nor the end of the loop", async () => {
    const { driver, loop, tick } = await holding();
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("no console");
    });

    driver.isStale = true;
    await tick();
    expect(loop.status).toBe(ControlState.FAULT);
    // the first hold, then the fault's: commanded without velocities, and it went through
    expect(driver.sent).toHaveLength(2);
    expect(driver.sent[1]?.[1]).toBeNull();
    expect((loop as unknown as { faultHoldError: string | null }).faultHoldError).toBeNull();

    // a loop that `start` began and that died: what `close` awaits of it has ended, not failed
    const died = await holding(undefined, FailingLoop);
    died.driver.isStale = true;
    died.loop.start();
    await settle();
    expect((died.loop as unknown as { thread: { isAlive: boolean } }).thread.isAlive).toBe(false);
    await expect(died.loop.close()).resolves.toBeUndefined();
    expect(died.loop.status).toBe(ControlState.CLOSED);
  });
});

describe("a loop that is given a log", () => {
  test("tells it every level, and prints nothing", async () => {
    const logged: LoggedLine[] = [];
    const { driver, loop, tick } = await holding((level, message, error) => logged.push([level, message, error]));
    const printed = caught();
    const refused = new Error("bus write failed");
    const targets = Object.fromEntries(Object.entries(loop.targets).map(([name, target]) => [name, [...target]]));
    targets[loop.layout.arms[0] as string]![0]! += 0.2;

    loop.move(targets);
    await tick(3);
    await loop.stop();
    for (let period = 0; loop.status !== ControlState.HOLD; period++) {
      expect(period).toBeLessThan(2000);
      await tick();
    }
    driver.isStale = true;
    driver.send = async () => {
      throw refused;
    };
    await tick();
    driver.read = async () => {
      throw new Error("bus read failed");
    };
    await tick();

    expect(logged.map(([level, message]) => [level, message.replace(/: .*$/s, "")])).toEqual([
      ["info", "move requested"],
      ["info", "controlled stop requested"],
      ["info", "motion finished at {'arm'"],
      ["error", "station fault"],
      ["error", "Could not command a hold; a physical stop may be required"],
      ["warning", "feedback read failed in FAULT"],
    ]);
    expect((logged[3] as LoggedLine)[2]).toBeInstanceOf(Error);
    expect((logged[4] as LoggedLine)[2]).toBe(refused);
    for (const method of ["error", "warn", "info", "log", "debug"] as const) {
      expect(printed[method].mock.calls).toEqual([]);
    }
  });

  test("the end of the loop that `start` began is told to the log and still printed by `start`", async () => {
    // (Python prints the traceback of a thread that died whatever the logger does: a log that drops the line does
    // not make the loop's end silent)
    const logged: LoggedLine[] = [];
    const { driver, loop } = await holding((level, message, error) => logged.push([level, message, error]), FailingLoop);
    const printed = caught();

    driver.isStale = true;
    loop.start();
    await settle();

    expect(logged.map(([level, message]) => [level, message])).toEqual([["error", "The control thread failed"]]);
    expect(printed.error.mock.calls).toEqual([["Exception in thread station-control:", (logged[0] as LoggedLine)[2]]]);
  });

  test("`run`, awaited by its caller, prints nothing: the caller gets the failure", async () => {
    const logged: LoggedLine[] = [];
    const { driver, loop } = await holding((level, message, error) => logged.push([level, message, error]), FailingLoop);
    const printed = caught();

    driver.isStale = true;
    await expect(loop.run()).rejects.toBeInstanceOf(OSError);

    expect(logged.map(([level, message]) => [level, message])).toEqual([["error", "The control thread failed"]]);
    expect(printed.error.mock.calls).toEqual([]);
  });
});

describe("the default log", () => {
  test("prints the error level alone, the message by itself when nothing was thrown", () => {
    const printed = caught();
    const thrown = new Error("thrown");

    logErrorsToConsole("info", "move requested: {}");
    logErrorsToConsole("warning", "feedback read failed in FAULT: text", thrown);
    expect(printed.error.mock.calls).toEqual([]);

    logErrorsToConsole("error", "station fault: text", thrown);
    logErrorsToConsole("error", "The control thread failed");
    expect(printed.error.mock.calls).toEqual([["station fault: text", thrown], ["The control thread failed"]]);
    for (const method of ["warn", "info", "log", "debug"] as const) {
      expect(printed[method].mock.calls).toEqual([]);
    }
  });

  test("the control thread has PEAR's name", () => {
    expect(JointControlLoop.THREAD_NAME).toBe("station-control");
  });
});
