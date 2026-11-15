// A fault that is latched is always followed by the command of its hold.
//
// PEAR's `_fail` latches FAULT, copies the error's details (`copy.deepcopy`), logs, and then commands the hold. Here
// the copy was a structured clone, which refuses values that `deepcopy` copies (a function, a symbol): an error that
// carried one would have left the loop in FAULT without a hold command, and ended `run`. Now nothing between the
// latch and the hold's command throws, whatever was thrown, whatever it carries and whatever the log does.
//
// Expectations written by hand: PEAR's own errors carry plain data (exact.test.ts compares every fault's details
// with PEAR's record), and no record of PEAR holds an error of these kinds.

import { afterEach, describe, expect, test, vi } from "vitest";

import type { JointControlLoop } from "../../src/station/joint/control_loop";
import { ControlState } from "../../src/station/schemas";
import { GatedRig } from "./gated";

/** An error with `details`, as PEAR's StabilityError and TrackingError carry them. */
function withDetails(message: string, details: unknown): Error {
  return Object.assign(new Error(message), { details });
}

/** Has the next reading of `rig` throw `thrown`, runs that control period, and returns the hold it commanded. */
async function faultWith(rig: GatedRig, thrown: unknown): Promise<unknown> {
  const held = rig.layout.join(rig.loop.targets);
  // (the rig's driver itself throws, so that it keeps no record of the reading: only the hold's command follows)
  rig.driver.read = async () => {
    throw thrown;
  };
  rig.driver.calls.length = 0;
  await rig.tick(); // (a step that threw would fail the test here)

  expect(rig.loop.status).toBe(ControlState.FAULT);
  // the hold: the targets as they were, without velocities
  expect(rig.driver.calls).toEqual([["s", held, null]]);
  // the hold went through: a recovery is not blocked
  expect((rig.loop as unknown as { faultHoldError: string | null }).faultHoldError).toBeNull();

  return rig.loop.faultDetails;
}

/** The class of the loop of `rig`, to make a second loop of on the rig's driver and clock. */
function loopClassOf(rig: GatedRig): typeof JointControlLoop {
  return rig.loop.constructor as typeof JointControlLoop;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("whatever the error carries, the fault's hold is commanded", () => {
  test("details that cannot be cloned: a function and a symbol", async () => {
    const rig = await GatedRig.make();
    const callback = function retry(): void {};
    const details = { metrics: { stable: false, samples: 3 }, callback, tag: Symbol("why"), rows: [1, callback] };

    const kept = await faultWith(rig, withDetails("details that no clone takes", details));

    expect(rig.loop.fault).toBe("details that no clone takes");
    // what is data is copied, what is not is kept as its text
    expect(kept).toEqual({
      metrics: { stable: false, samples: 3 },
      callback: "<function retry>",
      tag: "Symbol(why)",
      rows: [1, "<function retry>"],
    });
    expect((kept as typeof details).metrics).not.toBe(details.metrics);
    // a snapshot shows them, and is data that can be copied on
    const snapshot = rig.loop.snapshot();
    expect(snapshot.fault_details).toEqual(kept);
    expect(snapshot.fault_details).not.toBe(kept);
    expect(structuredClone(snapshot).fault_details).toEqual(kept);
    expect(rig.logged.at(-1)?.slice(0, 2)).toEqual(["error", "station fault: details that no clone takes"]);
  });

  test("details that are a function, details that lead back to themselves, details that cannot be read", async () => {
    const lone = await GatedRig.make();
    expect(await faultWith(lone, withDetails("a function", () => undefined))).toBe("<function >");

    const cyclic = await GatedRig.make();
    const details: Record<string, unknown> = { name: "loop", refuse: Symbol("no") };
    details["self"] = details;
    expect(await faultWith(cyclic, withDetails("a cycle", details))).toEqual({
      name: "loop",
      refuse: "Symbol(no)",
      self: "[object Object]",
    });

    const unreadable = await GatedRig.make();
    const error = new Error("a getter that throws");
    Object.defineProperty(error, "details", {
      get() {
        throw new Error("no details for you");
      },
    });
    expect(await faultWith(unreadable, error)).toBeNull();
    expect(unreadable.loop.fault).toBe("a getter that throws");
  });

  test("plain details are a copy, as before: a later change to the error's own does not show", async () => {
    const rig = await GatedRig.make();
    const details = { metrics: { stable: false, span: [0.1, 0.2] }, reason: "moved" };

    const kept = await faultWith(rig, withDetails("plain", details));
    details.metrics.span[0] = 9;
    details.reason = "changed";

    expect(kept).toEqual({ metrics: { stable: false, span: [0.1, 0.2] }, reason: "moved" });
    expect(rig.loop.snapshot().fault_details).toEqual({ metrics: { stable: false, span: [0.1, 0.2] }, reason: "moved" });
  });

  test("an error without details has none", async () => {
    const rig = await GatedRig.make();
    expect(await faultWith(rig, new Error("bare"))).toBeNull();
    expect(rig.loop.snapshot().fault_details).toBeNull();
  });
});

describe("whatever is thrown, the fault's hold is commanded", () => {
  test.each([
    ["an object without a prototype, which has no text", Object.create(null) as unknown, "[object Object]"],
    ["a symbol", Symbol("thrown"), "Symbol(thrown)"],
    ["nothing", undefined, "undefined"],
    ["null", null, "null"],
    ["a text", "bus gone", "bus gone"],
    ["a number", 7, "7"],
  ])("%s", async (_name, thrown, text) => {
    const rig = await GatedRig.make();

    expect(await faultWith(rig, thrown)).toBeNull();
    expect(rig.loop.fault).toBe(text);
    expect(rig.loop.snapshot().fault).toBe(text);
    expect(rig.logged.at(-1)?.slice(0, 2)).toEqual(["error", `station fault: ${text}`]);
  });
});

describe("whatever the log does, the fault's hold is commanded", () => {
  test("a log that throws at the fault breaks neither the period nor the hold, and is printed", async () => {
    const rig = await GatedRig.make();
    const printed = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refusal = new Error("the page's log is broken");
    // (a second loop on the rig's driver and clock, whose log throws)
    const loop = await loopClassOf(rig).create(rig.driver, rig.controlConfig, rig.robotConfig, {
      clock: rig.clock,
      log: () => {
        throw refusal;
      },
    });
    const held = rig.layout.join(loop.targets);

    rig.driver.read = async () => {
      throw new Error("bus gone");
    };
    rig.driver.calls.length = 0;
    rig.clock.now += rig.periodS;
    await loop.step();

    expect(loop.status).toBe(ControlState.FAULT);
    expect(loop.fault).toBe("bus gone");
    expect(rig.driver.calls).toEqual([["s", held, null]]);
    expect(printed.mock.calls).toEqual([["--- Logging error ---", refusal]]);
  });

  test("the same when the hold itself cannot be commanded: the failed hold is remembered", async () => {
    const rig = await GatedRig.make();
    const printed = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const loop = await loopClassOf(rig).create(rig.driver, rig.controlConfig, rig.robotConfig, {
      clock: rig.clock,
      log: () => {
        throw new Error("the page's log is broken");
      },
    });

    rig.driver.read = async () => {
      throw new Error("bus gone");
    };
    rig.driver.failures.send = new Error("bus write failed");
    rig.clock.now += rig.periodS;
    await loop.step();

    expect(loop.status).toBe(ControlState.FAULT);
    expect((loop as unknown as { faultHoldError: string | null }).faultHoldError).toBe("bus write failed");
    expect(printed.mock.calls.map(([message]) => message)).toEqual(["--- Logging error ---", "--- Logging error ---"]);
  });

  test("a log that throws at a request does not undo the request", async () => {
    const rig = await GatedRig.make();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const loop = await loopClassOf(rig).create(rig.driver, rig.controlConfig, rig.robotConfig, {
      clock: rig.clock,
      log: () => {
        throw new Error("the page's log is broken");
      },
    });
    const targets = Object.fromEntries(Object.entries(loop.targets).map(([arm, target]) => [arm, [...target]]));
    targets[rig.layout.arms[0] as string]![0]! += 0.1;

    expect(() => loop.move(targets)).not.toThrow();
    expect(loop.status).toBe(ControlState.RUNNING);
  });
});
