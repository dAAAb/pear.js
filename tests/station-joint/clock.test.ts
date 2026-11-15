// Not from PEAR: how the joint layer's clock, which counts PEAR's seconds, meets the Feetech layer's, which counts
// milliseconds, and why PEAR's own readings are replayed in seconds.

import { describe, expect, test } from "vitest";

import { ManualClock } from "../../src/feetech/transport";
import { secondsClock, SteppedClock } from "../../src/station/joint/clock";
import { clip, maximum, minimum } from "../../src/station/joint/numeric";
import { loadFixture, report } from "./fixtures";

describe("the joint layer's clock", () => {
  test("a clock of milliseconds reads in seconds, and a sleep of seconds advances it", async () => {
    const milliseconds = new ManualClock(100_020);
    const clock = secondsClock(milliseconds);

    expect(clock.monotonic()).toBe(100.02);
    await clock.sleep(0.02);
    expect(milliseconds.now()).toBe(100_040);
    expect(clock.monotonic()).toBe(100.04);
  });

  test("the page's clock is the default and never runs backwards", async () => {
    const clock = secondsClock();
    const before = clock.monotonic();
    await clock.sleep(0.001);

    expect(clock.monotonic()).toBeGreaterThanOrEqual(before);
    expect(before).toBeGreaterThanOrEqual(0);
  });

  test("a stepped clock stands still until it is set or slept on, and tells its sleeper's test", async () => {
    const clock = new SteppedClock();
    const slept: number[] = [];
    clock.onSleep = (seconds) => {
      slept.push(seconds);
    };

    expect(clock.monotonic()).toBe(SteppedClock.START_S);
    expect(clock.monotonic()).toBe(100.0);
    clock.now += 1 / 50;
    await clock.sleep(0.02);
    expect(clock.monotonic()).toBe(100.0 + 1 / 50 + 0.02);
    expect(slept).toEqual([0.02]);
    expect(new SteppedClock(5).monotonic()).toBe(5);
  });

  test("not every reading of PEAR's clock is a whole count of milliseconds over 1000, so replays are in seconds", () => {
    // every time at which a scenario of the stability fixtures reads PEAR's clock
    const scenarios = loadFixture<{ scenarios: { steps: { now?: number }[] }[] }>("stability.json").scenarios;
    const times = scenarios.flatMap((scenario) => scenario.steps.flatMap((step) => (step.now === undefined ? [] : [step.now])));
    const view = new DataView(new ArrayBuffer(8));
    const neighbour = (value: number, places: bigint): number => {
      view.setFloat64(0, value);
      view.setBigInt64(0, view.getBigInt64(0) + places);
      return view.getFloat64(0);
    };
    // a time is reachable when some double of milliseconds, divided by 1000, is that very double of seconds
    const unreachable = times.filter(
      (seconds) => ![-3n, -2n, -1n, 0n, 1n, 2n, 3n].some((places) => neighbour(seconds * 1000, places) / 1000 === seconds),
    );

    report(`clock: ${unreachable.length} of ${times.length} of PEAR's clock readings are no double of milliseconds over 1000`);
    expect(times.length).toBeGreaterThan(1000);
    expect(unreachable.length).toBeGreaterThan(0);
  });
});

describe("numpy's smallest, largest and clipped value", () => {
  // The fixtures of the limits and of the feedforward hold these through PEAR's own results; here is the rule
  // itself, measured on numpy 2.2.6: of two equal values the second is returned, and a NaN wins.
  test("of two zeros of different sign the second is returned", () => {
    expect(Object.is(minimum(0, -0), -0)).toBe(true);
    expect(Object.is(minimum(-0, 0), 0)).toBe(true);
    expect(Object.is(maximum(0, -0), -0)).toBe(true);
    expect(Object.is(maximum(-0, 0), 0)).toBe(true);
    expect(Object.is(Math.min(-0, 0), 0)).toBe(false);
  });

  test("a NaN on either side is the answer, and a clip is the smallest of the largest", () => {
    expect(Number.isNaN(minimum(1, NaN))).toBe(true);
    expect(Number.isNaN(minimum(NaN, 1))).toBe(true);
    expect(Number.isNaN(maximum(1, NaN))).toBe(true);
    expect(Number.isNaN(clip(NaN, 0, 0.1))).toBe(true);
    expect(clip(-1, 0, 0.1)).toBe(0);
    expect(clip(5, 0, 0.1)).toBe(0.1);
    expect(Object.is(clip(-0, -0, 0), 0)).toBe(true);
  });
});
