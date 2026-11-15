// Not from PEAR: the clock whose sleep ends at its hour (src/station/joint/deadline_clock.ts). On a fake engine,
// whose timers the test makes late, early, coarse or silent and whose time the test stops or sets back; and on real
// time, only when PEAR_JS_REAL_TIME=1 is set: a runner's timers are not ours to promise, so those tests measure and
// print what they measured, and assert only what holds on any machine (a sleep never ends before its hour).

import { describe, expect, test } from "vitest";

import { secondsClock, type MonotonicClock } from "../../src/station/joint/clock";
import { DeadlineClock, realTimeClock } from "../../src/station/joint/deadline_clock";
import { ValueError } from "../../src/station/joint/errors";

const REAL_TIME = process.env["PEAR_JS_REAL_TIME"] === "1";
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** An engine of the test: its time moves when its timers run, and a little with every reading and every turn. */
class FakeEngine {
  time = 1000;
  /** What a reading of the clock takes, ms: a busy wait ends. */
  readStepMs = 0.01;
  /** What a turn of the event loop takes, ms. */
  yieldMs = 0.05;
  /** When a timer of `ms` started at `time` fires. */
  fires: (time: number, ms: number) => number = (time, ms) => time + ms;
  readonly started: number[] = [];
  yields = 0;
  private readonly timers: { due: number; order: number; wake: () => void }[] = [];

  readonly now = (): number => {
    this.time += this.readStepMs;
    return this.time;
  };

  readonly setTimer = (wake: () => void, ms: number): void => {
    this.started.push(ms);
    this.timers.push({ due: this.fires(this.time, ms), order: this.started.length, wake });
  };

  /** A turn of the event loop: time passes, and the timers whose hour has come run. */
  readonly yieldTurn = async (): Promise<void> => {
    this.yields += 1;
    this.time += this.yieldMs;
    for (let next = this.nextTimer(); next !== undefined && next.due <= this.time; next = this.nextTimer()) {
      this.timers.splice(this.timers.indexOf(next), 1);
      next.wake();
    }
  };

  /** The timers that have not fired. */
  get waiting(): number {
    return this.timers.length;
  }

  clock(options: { marginMs?: number; maxMarginMs?: number; spinMs?: number; yields?: boolean; now?: () => number } = {}): DeadlineClock {
    return new DeadlineClock({
      now: options.now ?? this.now,
      setTimer: this.setTimer,
      yieldTurn: options.yields === false ? null : this.yieldTurn,
      ...(options.marginMs === undefined ? {} : { marginMs: options.marginMs }),
      ...(options.maxMarginMs === undefined ? {} : { maxMarginMs: options.maxMarginMs }),
      ...(options.spinMs === undefined ? {} : { spinMs: options.spinMs }),
    });
  }

  /** Runs the timers in the order of their hours until `promise` ends, and returns what it gives. */
  async until<Result>(promise: Promise<Result>): Promise<Result> {
    let isDone = false;
    const ended = promise.finally(() => {
      isDone = true;
    });
    ended.catch(() => undefined);
    for (let index = 0; ; index++) {
      await settle();
      if (isDone) break;
      if (index > 100_000) throw new Error("The promise never ended");
      const next = this.nextTimer();
      if (next === undefined) throw new Error("No timer runs and the promise has not ended");
      this.timers.splice(this.timers.indexOf(next), 1);
      if (next.due > this.time) this.time = next.due;
      next.wake();
    }
    return ended;
  }

  /** Sleeps `seconds` on `clock` and returns how long after its hour the sleep ended, ms. */
  async lateness(clock: MonotonicClock, seconds: number): Promise<number> {
    const hour = this.time + seconds * 1000;
    await this.until(clock.sleep(seconds));
    return this.time - hour;
  }

  private nextTimer(): { due: number; order: number; wake: () => void } | undefined {
    let next: (typeof this.timers)[number] | undefined;
    for (const timer of this.timers) {
      if (next === undefined || timer.due < next.due || (timer.due === next.due && timer.order < next.order)) next = timer;
    }
    return next;
  }
}

/** A timer of Node on Windows: it fires at the next tick of 15.625 ms at or after its hour. */
const COARSE_TICK_MS = 15.625;
const coarse = (time: number, ms: number): number => Math.ceil((time + ms) / COARSE_TICK_MS) * COARSE_TICK_MS;

describe("DeadlineClock on a fake engine", () => {
  test("reads the engine's time in seconds", () => {
    const engine = new FakeEngine();
    engine.readStepMs = 0;
    expect(engine.clock().monotonic()).toBe(1.0);
  });

  test("a sleep ends at its hour, within a reading of the clock, when the timers are on time", async () => {
    const engine = new FakeEngine();
    const clock = engine.clock();
    for (let index = 0; index < 50; index++) {
      const late = await engine.lateness(clock, 0.02);
      expect(late).toBeGreaterThanOrEqual(0);
      expect(late).toBeLessThan(0.05);
    }
    // one timer a sleep, of whole milliseconds, that leaves the margin; the rest is the busy wait
    expect(engine.started.every((ms) => Number.isInteger(ms) && ms >= 18 && ms <= 19)).toBe(true);
    expect(engine.started.length).toBe(50);
    expect(clock.stats().sleeps).toBe(50);
    expect(clock.stats().timers).toBe(50);
    expect(clock.stats().lateMaxMs).toBeLessThan(0.05);
    expect(clock.marginMs).toBe(DeadlineClock.MARGIN_MS);
  });

  test("a sleep never ends before its hour when the timers fire early", async () => {
    const engine = new FakeEngine();
    engine.fires = (time, ms) => time + ms - 0.999;
    const clock = engine.clock();
    for (let index = 0; index < 20; index++) {
      const late = await engine.lateness(clock, 0.02);
      expect(late).toBeGreaterThanOrEqual(0);
      expect(late).toBeLessThan(0.05);
    }
    // a timer that fires at half its time is followed by another, and the sleep still ends at its hour
    engine.fires = (time, ms) => time + ms / 2;
    const timersBefore = engine.started.length;
    for (let index = 0; index < 5; index++) {
      const late = await engine.lateness(clock, 0.05);
      expect(late).toBeGreaterThanOrEqual(0);
      expect(late).toBeLessThan(0.05);
    }
    // of 48, 24, 12, 6 and 3 ms, and then of the 1 ms that is left before the margin
    expect(engine.started.length).toBeGreaterThan(timersBefore + 5 * 5);
    expect(engine.started.slice(timersBefore, timersBefore + 5)).toEqual([48, 24, 12, 6, 3]);
    expect(clock.stats().timerLateMaxMs).toBeLessThan(0);
    expect(clock.marginMs).toBe(DeadlineClock.MARGIN_MS);
  });

  test("coarse timers: the engine's sleep of 20 ms takes a tick more; this clock learns the tick", async () => {
    const plain = new FakeEngine();
    plain.fires = coarse;
    const plainTook: number[] = [];
    for (let index = 0; index < 40; index++) {
      const before = plain.time;
      await plain.until(new Promise<void>((resolve) => plain.setTimer(resolve, 20)));
      plainTook.push(plain.time - before);
    }
    // what docs/progress/loop.md measured on Node for Windows: 31 ms on average
    expect(plainTook.reduce((sum, value) => sum + value, 0) / plainTook.length).toBeCloseTo(31.25, 1);

    const engine = new FakeEngine();
    engine.fires = coarse;
    const clock = engine.clock();
    const late: number[] = [];
    for (let index = 0; index < 120; index++) late.push(await engine.lateness(clock, 0.02));
    expect(Math.min(...late)).toBeGreaterThanOrEqual(0);
    // the first sleeps find out how late the timers are (the lateness of a 20 ms sleep on this tick repeats
    // after 25 sleeps); then every sleep ends at its hour
    expect(Math.max(...late.slice(0, 3))).toBeGreaterThan(1);
    expect(Math.max(...late.slice(40))).toBeLessThan(0.05);
    expect(late.filter((value) => value > 0.05).length).toBeLessThan(12);
    expect(clock.marginMs).toBeGreaterThan(COARSE_TICK_MS - 1.1);
    expect(clock.marginMs).toBeLessThanOrEqual(DeadlineClock.MAX_MARGIN_MS);
    // the rest of each wait is turns of the event loop, and a busy wait of at most `spinMs`
    expect(engine.yields).toBeGreaterThan(120);
    expect(clock.stats().spinMs / 120).toBeLessThanOrEqual(DeadlineClock.SPIN_MS + 0.06);
  });

  test("after one stall a sleep of one period waits for no timer; a longer sleep's timers narrow the margin again", async () => {
    const engine = new FakeEngine();
    let stalls = 1;
    engine.fires = (time, ms) => time + ms + (stalls-- > 0 ? 300 : 0);
    const clock = engine.clock();
    expect(await engine.lateness(clock, 0.02)).toBeGreaterThan(290);
    expect(clock.marginMs).toBe(DeadlineClock.MAX_MARGIN_MS);

    // sleeps of one period, as the loop's and its callers' are: turns of the event loop and the busy wait, each
    // at its hour, and no timer tells the margin anything, so it stays
    for (let index = 0; index < 3 * DeadlineClock.TIMERS_KEPT; index++) expect(await engine.lateness(clock, 0.02)).toBeLessThan(0.05);
    expect(engine.started.length).toBe(1);
    expect(clock.marginMs).toBe(DeadlineClock.MAX_MARGIN_MS);

    // a longer sleep starts timers again, and as many on time as the clock keeps narrow the margin
    for (let index = 0; index < DeadlineClock.TIMERS_KEPT; index++) expect(await engine.lateness(clock, 0.05)).toBeLessThan(0.05);
    expect(clock.marginMs).toBe(DeadlineClock.MARGIN_MS);
    expect(await engine.lateness(clock, 0.02)).toBeLessThan(0.05);
    expect(engine.started.at(-1)).toBe(18);
  });

  test("timers that stay late (a hidden page's) cost one late sleep of one period, and no other", async () => {
    const engine = new FakeEngine();
    // a timer fires at the next whole second at or after its hour
    engine.fires = (time, ms) => Math.ceil((time + ms) / 1000) * 1000;
    const clock = engine.clock();
    expect(await engine.lateness(clock, 0.02)).toBeGreaterThan(900);
    for (let index = 0; index < 200; index++) expect(await engine.lateness(clock, 0.02)).toBeLessThan(0.05);
    expect(clock.marginMs).toBe(DeadlineClock.MAX_MARGIN_MS);
    expect(clock.stats().timers).toBe(1);
    expect(engine.waiting).toBe(0);
  });

  test("a sleep of no time or less takes one turn of the event loop and no timer", async () => {
    const engine = new FakeEngine();
    const clock = engine.clock();
    for (const [index, seconds] of [0, -0, -1, 0.001].entries()) {
      const hour = engine.time + Math.max(0, seconds) * 1000;
      await clock.sleep(seconds);
      expect(engine.time).toBeGreaterThanOrEqual(hour);
      expect(engine.yields).toBe(index + 1);
    }
    expect(engine.started.length).toBe(0);
    expect(clock.stats().sleeps).toBe(4);
    // a negative time is no time: the sleep is late by its turn, not by the time it was given
    expect(clock.stats().lateMaxMs).toBeLessThan(0.2);
  });

  test("a wait that sleeps no time between two looks sees what a timer brings", async () => {
    // the engine's own turns here: a sleep that gave none would keep this wait in the microtasks for ever
    const clock = new DeadlineClock();
    let hasCome = false;
    setTimeout(() => {
      hasCome = true;
    }, 5);
    let looks = 0;
    while (!hasCome && looks < 5_000_000) {
      looks += 1;
      await clock.sleep(0);
    }
    expect(hasCome).toBe(true);
  });

  test("a time that gives no hour is refused, and counts for nothing", async () => {
    const engine = new FakeEngine();
    const clock = engine.clock();
    for (const seconds of [NaN, Infinity, -Infinity]) {
      await expect(clock.sleep(seconds)).rejects.toThrow(ValueError);
      await expect(clock.sleep(seconds)).rejects.toThrow(`A sleep takes a finite time in seconds, not ${seconds}`);
    }
    expect(engine.started.length).toBe(0);
    expect(engine.yields).toBe(0);
    expect(clock.stats()).toMatchObject({ sleeps: 0, timers: 0, yields: 0, spinMs: 0, lateMeanMs: 0, lateMaxMs: 0 });
  });

  test("a sleep longer than the longest timer waits for one timer after another", async () => {
    const engine = new FakeEngine();
    const clock = engine.clock();
    const days30 = 30 * 86_400;
    const late = await engine.lateness(clock, days30);
    expect(late).toBeGreaterThanOrEqual(0);
    expect(late).toBeLessThan(0.05);
    expect(engine.started.length).toBe(2);
    expect(engine.started[0]).toBe(DeadlineClock.MAX_TIMER_MS);
    expect(engine.started[0]).toBe(2_147_483_647);
    expect((engine.started[0] as number) + (engine.started[1] as number)).toBeGreaterThan(days30 * 1000 - 3);
  });

  test("two sleepers each end at their own hour", async () => {
    const engine = new FakeEngine();
    const clock = engine.clock();
    const start = engine.time;
    const ends: Record<string, number> = {};
    const first = clock.sleep(0.02).then(() => {
      ends["first"] = engine.time - start;
    });
    const second = clock.sleep(0.013).then(() => {
      ends["second"] = engine.time - start;
    });
    await engine.until(Promise.all([first, second]));
    expect(ends["second"]).toBeGreaterThanOrEqual(13);
    expect(ends["second"]).toBeLessThan(13.1);
    expect(ends["first"]).toBeGreaterThanOrEqual(20);
    expect(ends["first"]).toBeLessThan(20.1);
  });

  test("two sleepers whose hours are closer than the busy wait: the second ends after its hour, by less than that wait", async () => {
    const engine = new FakeEngine();
    const clock = engine.clock();
    const start = engine.time;
    const ends: number[] = [];
    const sleepers = [0.02, 0.0204, 0.0211].map((seconds) => clock.sleep(seconds).then(() => void ends.push(engine.time - start)));
    await engine.until(Promise.all(sleepers));
    expect(ends.length).toBe(3);
    for (const [index, hour] of [20, 20.4, 21.1].entries()) {
      expect(ends[index]).toBeGreaterThanOrEqual(hour);
      expect(ends[index]).toBeLessThan(hour + DeadlineClock.SPIN_MS);
    }
  });

  test("without a turn of the event loop the whole rest is a busy wait, and a sleep of no time is a timer of 1 ms", async () => {
    const engine = new FakeEngine();
    engine.fires = coarse;
    const clock = engine.clock({ yields: false });
    for (let index = 0; index < 20; index++) await engine.lateness(clock, 0.02);
    expect(engine.yields).toBe(0);
    expect(await engine.lateness(clock, 0.02)).toBeLessThan(0.05);

    const exact = new FakeEngine();
    const turnless = exact.clock({ yields: false });
    await exact.until(turnless.sleep(0));
    expect(exact.started).toEqual([1]);
    expect(exact.yields).toBe(0);
  });

  test("a clock that stands still does not hold the thread: the busy wait takes turns until the clock moves", async () => {
    // the clock stands 1 ms before the hour, where the busy wait is; the turns are the engine's own here, so
    // that the test runs between them as a caller of the loop would
    const engine = new FakeEngine();
    engine.readStepMs = 0;
    let turns = 0;
    const clock = new DeadlineClock({
      now: engine.now,
      setTimer: engine.setTimer,
      yieldTurn: async () => {
        turns += 1;
        await settle();
      },
    });
    const hour = engine.time + 1;
    const sleeping = clock.sleep(0.001);
    let hasEnded = false;
    void sleeping.then(() => {
      hasEnded = true;
    });
    for (let turn = 0; turn < 3; turn++) await settle();
    expect(hasEnded).toBe(false);
    expect(turns).toBeGreaterThanOrEqual(3);
    expect(engine.started.length).toBe(0);

    // the clock moves again, and the sleep ends at its hour
    engine.readStepMs = 0.01;
    await sleeping;
    expect(engine.time).toBeGreaterThanOrEqual(hour);
    expect(engine.time).toBeLessThan(hour + 0.05);
    expect(clock.stats().sleeps).toBe(1);
  });

  test("a clock that is set back makes the sleep longer, never shorter", async () => {
    const engine = new FakeEngine();
    let backMs = 0;
    /** The reading after which the clock loses 5 ms, once; null for never. */
    let losesAfter: number | null = null;
    const now = (): number => {
      const reading = engine.now() - backMs;
      if (losesAfter !== null && reading > losesAfter) {
        losesAfter = null;
        backMs += 5;
        return reading - 5;
      }
      return reading;
    };
    const clock = engine.clock({ now });
    const hour = now() + 20;
    const sleeping = clock.sleep(0.02);
    await settle();
    // while the sleep waits for its timer the clock loses 50 ms: at the timer 51.5 ms are left, not 1.5
    backMs = 50;
    await engine.until(sleeping);
    expect(now()).toBeGreaterThanOrEqual(hour);
    expect(now()).toBeLessThan(hour + 0.1);
    expect(engine.started.length).toBe(2);
    expect(engine.started[1]).toBeGreaterThanOrEqual(49);
    // the first timer fired 50 ms before its hour on this clock: no lateness, and the margin stays
    expect(clock.marginMs).toBe(DeadlineClock.MARGIN_MS);

    // set back in its busy wait, half a millisecond before the hour, the sleep leaves it and waits again
    const second = now() + 20;
    losesAfter = second - 0.5;
    await engine.until(clock.sleep(0.02));
    expect(losesAfter).toBeNull();
    expect(now()).toBeGreaterThanOrEqual(second);
    expect(now()).toBeLessThan(second + 0.1);
    expect(engine.started.slice(2)).toEqual([18, 3]);
    expect(clock.stats().spinMs).toBeGreaterThan(0);
  });
});

describe("the clock of a part that is given none", () => {
  test("is one DeadlineClock on the engine's time, the same at every call, and reads what secondsClock() reads", () => {
    const clock = realTimeClock();
    expect(clock).toBeInstanceOf(DeadlineClock);
    expect(realTimeClock()).toBe(clock);

    const before = secondsClock().monotonic();
    const reading = clock.monotonic();
    const after = secondsClock().monotonic();
    expect(reading).toBeGreaterThanOrEqual(before);
    expect(reading).toBeLessThanOrEqual(after);
  });
});

function summary(values: number[]): Record<string, number> {
  const sorted = [...values].sort((first, second) => first - second);
  const rank = (share: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))] as number;
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  return {
    n: sorted.length,
    mean: round(values.reduce((sum, value) => sum + value, 0) / sorted.length),
    min: round(sorted[0] as number),
    p50: round(rank(0.5)),
    p99: round(rank(0.99)),
    max: round(sorted[sorted.length - 1] as number),
    over25: values.filter((value) => value > 25).length,
  };
}

/** 250 sleeps of one control period on `clock`, one after another as SnapshotCheck.poll sleeps: what each took, ms. */
async function sleeps(clock: MonotonicClock, count = 250): Promise<{ took: Record<string, number>; early: number }> {
  const took: number[] = [];
  let early = 0;
  for (let index = 0; index < count; index++) {
    const before = performance.now();
    await clock.sleep(0.02);
    const after = performance.now();
    took.push(after - before);
    if (after < before + 20) early += 1;
  }
  return { took: summary(took), early };
}

describe.skipIf(!REAL_TIME)("DeadlineClock on real time (measures; only with PEAR_JS_REAL_TIME=1)", () => {
  test("250 sleeps of one control period: the clock of a part that is given none, and secondsClock() beside it", { timeout: 60_000 }, async () => {
    const clock = realTimeClock();
    clock.resetStats();
    const mine = await sleeps(clock);
    const stats = clock.stats();
    const plain = await sleeps(secondsClock());
    console.log(
      `REAL_TIME ${JSON.stringify({ what: "sleep20", platform: process.platform, node: process.version, realTimeClock: mine, stats, secondsClock: plain })}`,
    );
    // what holds on any machine: no sleep of this clock ended before its hour (the engine's own may: it is counted)
    expect(mine.early).toBe(0);
    expect(mine.took["min"]).toBeGreaterThanOrEqual(20);
  });
});
