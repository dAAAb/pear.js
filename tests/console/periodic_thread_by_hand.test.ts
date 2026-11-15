// Written by hand: this test compares with nothing of PEAR's. Its expectations were typed from a reading of
// pear/deploy/station/gui/console/periodic_thread.py, with a clock and a wait of its own. It holds when a periodic
// thread waits and for how long, which no record of PEAR's holds (commands.test.ts replays a record that counts
// the steps and keeps no time): the first step at once or after one period (is_waiting_first), the next one a
// whole period after a step's end or a period after its start (is_paced_from_start), never sooner than MIN_WAIT_S
// after a step that took longer than the period, and close, which ends the wait and waits up to JOIN_S for the
// loop.

import { describe, expect, it } from "vitest";

import type { Sleep } from "../../src/agent/clock";
import { PeriodicThread, type PeriodicThreadOptions } from "../../src/console/index";

/** One periodic thread on a clock of this test's own, and what it did. */
interface Run {
  thread: PeriodicThread;
  /** The clock's reading at each step's start, s. */
  starts: number[];
  /** Every wait the loop asked for, s, and whether the thread was closed when it asked. */
  waits: [number, boolean][];
}

/**
 * Runs a periodic thread of period 0.5 s whose every step takes ``stepSeconds`` on the test's clock, which begins
 * at 100 s, and closes it at the start of its third step; returns it once its loop has ended.
 *
 * A wait passes at once: it moves the clock on by its time, unless the thread is closed, as exit_event.wait
 * returns at once then. The numbers are chosen so that every reading is exact in binary.
 */
async function runThree(stepSeconds: number, options: PeriodicThreadOptions): Promise<Run> {
  let now = 100;
  const starts: number[] = [];
  const waits: [number, boolean][] = [];
  const sleep: Sleep = (seconds, wake) => {
    const isClosed = wake?.aborted === true;
    waits.push([seconds, isClosed]);
    if (!isClosed) {
      now += seconds;
    }

    return Promise.resolve();
  };
  const thread: PeriodicThread = new PeriodicThread(
    () => {
      starts.push(now);
      now += stepSeconds;
      if (starts.length === 3) {
        thread.exitEvent.abort();
      }
    },
    0.5,
    "by-hand",
    { ...options, clock: () => now, sleep },
  );
  // the thread is started and has not run yet
  expect(starts).toEqual([]);
  await thread.thread.ended;

  return { thread, starts, waits };
}

describe("PeriodicThread, by hand", () => {
  it("does the first step at once and each next one a whole period after a step's end", async () => {
    const { thread, starts, waits } = await runThree(0.25, {});

    expect(starts).toEqual([100, 100.75, 101.5]);
    // the wait after the last step is asked for with the thread closed, and ends at once
    expect(waits).toEqual([
      [0.5, false],
      [0.5, false],
      [0.5, true],
    ]);
    expect(thread.thread.isAlive).toBe(false);
  });

  it("waits one period before the first step when it is made so", async () => {
    const { starts, waits } = await runThree(0.25, { isWaitingFirst: true });

    expect(starts).toEqual([100.5, 101.25, 102]);
    expect(waits).toEqual([
      [0.5, false],
      [0.5, false],
      [0.5, false],
      [0.5, true],
    ]);
  });

  it("does no step when it is closed during the wait before the first one", async () => {
    let steps = 0;
    const waits: number[] = [];
    const thread: PeriodicThread = new PeriodicThread(() => void (steps += 1), 0.5, "by-hand", {
      isWaitingFirst: true,
      clock: () => 100,
      sleep: (seconds) => {
        waits.push(seconds);
        thread.exitEvent.abort(); // closed while it waits

        return Promise.resolve();
      },
    });
    await thread.thread.ended;

    expect(steps).toBe(0);
    expect(waits).toEqual([0.5]);
  });

  it("paces the steps from their starts when it is made so", async () => {
    const { starts, waits } = await runThree(0.25, { isPacedFromStart: true });

    // a period from start to start: the wait is what the step left of it
    expect(starts).toEqual([100, 100.5, 101]);
    expect(waits).toEqual([
      [0.25, false],
      [0.25, false],
      [0.25, true],
    ]);
  });

  it("waits MIN_WAIT_S after a step that took longer than the period, paced from the starts", async () => {
    const { starts, waits } = await runThree(0.75, { isPacedFromStart: true });

    expect(PeriodicThread.MIN_WAIT_S).toBe(0.001);
    expect(waits).toEqual([
      [0.001, false],
      [0.001, false],
      [0.001, true],
    ]);
    expect(starts).toHaveLength(3);
    expect(starts[1]! - starts[0]!).toBeCloseTo(0.751, 9);
  });

  it("ends the wait between two steps at close, and waits up to JOIN_S for the loop", async () => {
    let steps = 0;
    const waits: number[] = [];
    // a wait that lasts until it is woken, as exit_event.wait does when nobody sets the event
    const sleep: Sleep = (seconds, wake) =>
      new Promise((resolve) => {
        waits.push(seconds);
        if (wake === undefined || wake.aborted) {
          resolve();
        } else {
          wake.addEventListener("abort", () => resolve(), { once: true });
        }
      });
    const thread = new PeriodicThread(() => void (steps += 1), 0.5, "by-hand", { clock: () => 100, sleep });
    for (let turn = 0; turn < 20 && waits.length === 0; turn++) {
      await Promise.resolve();
    }
    // the first step is done and the loop waits for the second
    expect(steps).toBe(1);
    expect(waits).toEqual([0.5]);
    expect(thread.thread.isAlive).toBe(true);

    await thread.close();

    expect(PeriodicThread.JOIN_S).toBe(2);
    expect(waits).toEqual([0.5, 2]); // the time limit of the join, which the loop's end came before
    expect(steps).toBe(1);
    expect(thread.exitEvent.signal.aborted).toBe(true);
    expect(thread.thread.isAlive).toBe(false);
  });
});