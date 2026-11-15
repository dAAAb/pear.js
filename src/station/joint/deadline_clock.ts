// Not a file of PEAR: a clock for the joint layer whose sleep ends at its hour, and the clock of every part that
// is given none. PEAR sleeps with time.sleep() on Linux, which ends about a tenth of a millisecond after the time
// asked for. A timer of a JavaScript engine does not: on Node for Windows a setTimeout of 20 ms takes 31 ms on
// average (a timer tick of 15.6 ms), a browser truncates the delay to whole milliseconds and clamps nested timers
// to 4 ms, and the waits of the joint layer that sleep one control period at a time (SnapshotCheck.poll) then read
// too seldom for the stability window.
//
// A sleep here takes the hour it must end at (the clock's reading when it is called, plus the time asked for),
// leaves that to a timer until `margin` before the hour, and waits the rest out itself: by turns of the event
// loop that are no timers while more than `spinMs` remain, then by reading the clock in a busy wait. It never
// ends before its hour, on the clock's own readings. The margin starts at `marginMs` and follows what the
// engine's timers need: the largest lateness of the last 32 timers plus half a millisecond, at most
// `maxMarginMs`. Only a timer that a sleep waited for tells the margin: one started beside a busy sleep is no
// measure, because on Node for Windows a timer is on time while the thread takes turns and late while it waits.
// So a margin as wide as a sleep stays: once a timer has been a control period late, sleeps of one period wait
// for no timer, and are turns of the event loop and the busy wait until a longer sleep finds the timers on time
// again. That keeps the period, on Node for Windows and after a stall, and costs a busy thread.
//
// Where time.sleep() and this differ:
// - Every sleep takes at least one turn of the event loop, a sleep of no time too. PEAR's sleep lets the other
//   threads run; here the loop and its callers share one thread, and a wait that sleeps between two looks would
//   never see what it waits for if a sleep gave no turn.
// - time.sleep() raises ValueError for a time that is negative or no number and OverflowError for an infinite
//   one. Here a time that gives no hour (NaN, infinite) is refused with ValueError, and a negative time is no
//   time, as it is to the engine's timer that this clock stands in for.
// - A busy wait that reads a clock standing still does not hold the thread: after `STILL_READINGS` equal readings
//   it takes a turn of the event loop and goes on. A clock that goes back makes the sleep longer, never shorter.
// - A timer that never fires leaves its sleep waiting, as it leaves the engine's own sleep: nothing here wakes it.
//
// No dependencies; it runs in a window, in a dedicated worker and in Node 20 or newer. A test's time still stands
// on a SteppedClock.

import type { MonotonicClock } from "./clock";
import { ValueError } from "./errors";

/** What a DeadlineClock is made with; every part has a default. */
export interface DeadlineClockOptions {
  /** Monotonic time in ms; by default `performance.now()`. */
  readonly now?: () => number;
  /** Calls `wake` after `ms` (whole milliseconds, from 1 to `MAX_TIMER_MS`); by default `setTimeout`. */
  readonly setTimer?: (wake: () => void, ms: number) => void;
  /**
   * One turn of the event loop that is no timer, or null for none (the whole rest of a wait is then a busy
   * wait, and the turn every sleep takes is a timer of 1 ms); by default `setImmediate` where there is one
   * (Node), else a MessageChannel (a window, a worker).
   */
  readonly yieldTurn?: (() => Promise<void>) | null;
  /** How long before its hour a sleep leaves its timer, ms: the margin's first and smallest value. */
  readonly marginMs?: number;
  /** The margin's largest value, ms. */
  readonly maxMarginMs?: number;
  /** The last part of a wait that is a busy wait, ms. */
  readonly spinMs?: number;
}

/** What a DeadlineClock has done since it was made or since `resetStats`: for a page's log. */
export interface DeadlineClockStats {
  /** Sleeps that have ended. */
  sleeps: number;
  /** Timers started: each one a sleep waited for. */
  timers: number;
  /** Turns of the event loop taken in the rest of a wait. */
  yields: number;
  /** Time spent in busy waits, ms. */
  spinMs: number;
  /** How long after its hour a sleep ended, ms: the mean and the largest. */
  lateMeanMs: number;
  lateMaxMs: number;
  /** How long after its own hour a timer fired, ms: the largest (negative: every timer fired early). */
  timerLateMaxMs: number;
  /** The margin now, ms. */
  marginMs: number;
}

/** Returns a function that takes one turn of the event loop without a timer, or null where none is known. */
function defaultYieldTurn(): (() => Promise<void>) | null {
  const scope = globalThis as {
    setImmediate?: (callback: () => void) => unknown;
    MessageChannel?: new () => {
      port1: { onmessage: ((event: unknown) => void) | null };
      port2: { postMessage(message: unknown): void };
    };
  };
  if (typeof scope.setImmediate === "function") {
    const setImmediate = scope.setImmediate;
    return () => new Promise((resolve) => setImmediate(resolve));
  }
  if (typeof scope.MessageChannel === "function") {
    const Channel = scope.MessageChannel;
    const waiting: (() => void)[] = [];
    // made at the first turn: a clock that is only read opens no channel
    let port: { postMessage(message: unknown): void } | null = null;
    return () =>
      new Promise((resolve) => {
        if (port === null) {
          const channel = new Channel();
          channel.port1.onmessage = () => waiting.shift()?.();
          port = channel.port2;
        }
        waiting.push(resolve);
        port.postMessage(0);
      });
  }
  return null;
}

/** PEAR's `time.monotonic()` and `time.sleep()` on an engine's timers: a sleep ends at its hour, never before. */
export class DeadlineClock implements MonotonicClock {
  /** The margin's first and smallest value, ms. */
  static readonly MARGIN_MS = 1.5;
  /** The margin's largest value, ms: one control period of 50 Hz. */
  static readonly MAX_MARGIN_MS = 20;
  /** The last part of a wait that is a busy wait, ms. */
  static readonly SPIN_MS = 1.5;
  /** The timers whose lateness sets the margin (a 20 ms sleep on a tick of 15.625 ms repeats after 25). */
  static readonly TIMERS_KEPT = 32;
  /** What the margin keeps above the largest lateness kept, ms. */
  static readonly MARGIN_SLACK_MS = 0.5;
  /** The longest timer, ms: an engine keeps a delay in 32 bits, and a longer one fires at once. */
  static readonly MAX_TIMER_MS = 2 ** 31 - 1;
  /** The equal readings in a row after which a busy wait takes a turn of the event loop: the clock stands still. */
  static readonly STILL_READINGS = 1_000_000;

  private readonly now: () => number;
  private readonly setTimer: (wake: () => void, ms: number) => void;
  private readonly yieldTurn: (() => Promise<void>) | null;
  private readonly minMarginMs: number;
  private readonly maxMarginMs: number;
  private readonly spinMs: number;
  /** How long before its hour a sleep leaves its timer now, ms. */
  private margin: number;
  /** How late each of the last timers fired, ms, clipped to [0, maxMarginMs]. */
  private readonly timerLateness: number[] = [];
  private counts: DeadlineClockStats;
  private lateSumMs = 0;

  constructor(options: DeadlineClockOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.setTimer = options.setTimer ?? ((wake, ms) => void setTimeout(wake, ms));
    this.yieldTurn = options.yieldTurn === undefined ? defaultYieldTurn() : options.yieldTurn;
    this.minMarginMs = options.marginMs ?? DeadlineClock.MARGIN_MS;
    this.maxMarginMs = Math.max(this.minMarginMs, options.maxMarginMs ?? DeadlineClock.MAX_MARGIN_MS);
    this.spinMs = options.spinMs ?? DeadlineClock.SPIN_MS;
    this.margin = this.minMarginMs;
    this.counts = this.emptyStats();
  }

  /** How long before its hour a sleep leaves its timer now, ms. */
  get marginMs(): number {
    return this.margin;
  }

  monotonic(): number {
    return this.now() / 1000;
  }

  /**
   * Resolves `seconds` after the call, as near after that hour as the engine allows and never before it, after
   * at least one turn of the event loop. A negative time is no time; one that is NaN or infinite is refused.
   */
  async sleep(seconds: number): Promise<void> {
    if (!Number.isFinite(seconds)) {
      throw new ValueError(`A sleep takes a finite time in seconds, not ${seconds}`);
    }
    const hour = this.now() + Math.max(0, seconds) * 1000;
    let hasTurned = false;
    let ended: number;

    for (;;) {
      const leftMs = hour - this.now();

      // the timer's part: to `margin` before the hour (a timer that fired early is followed by another, and so
      // is the longest timer of a longer sleep)
      const timerMs = Math.min(Math.floor(leftMs - this.margin), DeadlineClock.MAX_TIMER_MS);
      if (timerMs >= 1) {
        await this.timer(timerMs);
        hasTurned = true;
        continue;
      }

      // the rest: turns of the event loop while there is room for one, and one in any case
      if (!hasTurned || (this.yieldTurn !== null && leftMs > this.spinMs)) {
        await this.turn();
        hasTurned = true;
        continue;
      }

      // then the busy wait, as long as the clock moves towards the hour (without a turn to take, it is the
      // whole of what the timer left)
      const busyMs = this.yieldTurn === null ? Math.max(this.spinMs, leftMs) : this.spinMs;
      const from = this.now();
      let reading = from;
      let still = 0;
      while (reading < hour && hour - reading <= busyMs && still < DeadlineClock.STILL_READINGS) {
        const next = this.now();
        still = next === reading ? still + 1 : 0;
        reading = next;
      }
      this.counts.spinMs += Math.max(0, reading - from);
      if (reading >= hour) {
        ended = reading;
        break;
      }
      // the clock stood still or went back: the others run, and the wait goes on
      await this.turn();
    }

    this.counts.sleeps += 1;
    const lateMs = ended - hour;
    this.lateSumMs += lateMs;
    this.counts.lateMaxMs = Math.max(this.counts.lateMaxMs, lateMs);
  }

  /** Returns what the clock has done since it was made or since `resetStats`. */
  stats(): DeadlineClockStats {
    return {
      ...this.counts,
      lateMeanMs: this.counts.sleeps > 0 ? this.lateSumMs / this.counts.sleeps : 0,
      marginMs: this.margin,
    };
  }

  /** Forgets what `stats` counts; the margin stays. */
  resetStats(): void {
    this.counts = this.emptyStats();
    this.lateSumMs = 0;
  }

  /** Waits for a timer of `ms` and keeps how late it fired. */
  private async timer(ms: number): Promise<void> {
    const due = this.now() + ms;
    this.counts.timers += 1;
    await new Promise<void>((resolve) => this.setTimer(resolve, ms));
    this.noteTimer(this.now() - due);
  }

  /** Takes one turn of the event loop: one that is no timer where the engine has one, else a timer of 1 ms. */
  private turn(): Promise<void> {
    if (this.yieldTurn === null) {
      return this.timer(1);
    }
    this.counts.yields += 1;
    return this.yieldTurn();
  }

  /** Keeps how late a timer fired and sets the margin to what the timers kept need. */
  private noteTimer(lateMs: number): void {
    this.counts.timerLateMaxMs = Math.max(this.counts.timerLateMaxMs, lateMs);
    this.timerLateness.push(Math.min(Math.max(lateMs, 0), this.maxMarginMs));
    if (this.timerLateness.length > DeadlineClock.TIMERS_KEPT) {
      this.timerLateness.shift();
    }
    const needed = Math.max(...this.timerLateness) + DeadlineClock.MARGIN_SLACK_MS;
    this.margin = Math.min(this.maxMarginMs, Math.max(this.minMarginMs, needed));
  }

  private emptyStats(): DeadlineClockStats {
    return {
      sleeps: 0,
      timers: 0,
      yields: 0,
      spinMs: 0,
      lateMeanMs: 0,
      lateMaxMs: 0,
      timerLateMaxMs: -Infinity,
      marginMs: this.margin,
    };
  }
}

let shared: DeadlineClock | null = null;

/**
 * Returns the clock of a part that is given none: the one DeadlineClock on the engine's own time, made at the
 * first call, so that every such part reads and sleeps on the same clock.
 */
export function realTimeClock(): DeadlineClock {
  shared ??= new DeadlineClock();
  return shared;
}
