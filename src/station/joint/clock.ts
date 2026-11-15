// Not a file of PEAR: the time the joint layer reads, where pear/deploy/station/control/joint/*.py call
// time.monotonic() and time.sleep(). Every monitor is given its clock, so that a test's time stands still.
//
// The unit is PEAR's, the second: the windows, the timeouts and the stamps of a reading are compared as PEAR compares
// them. The Feetech layer's `Clock` (src/feetech/transport.ts) counts milliseconds; `secondsClock` reads one in
// seconds. A test replays PEAR's own readings on a `SteppedClock` rather than on a millisecond clock, because not
// every double of seconds is a double of milliseconds divided by 1000.
//
// The rule of a part that is given no clock: it takes `realTimeClock()` (deadline_clock.ts), the one clock on the
// engine's own time whose sleep ends at its hour, whether it sleeps or only reads, so that a loop made without a
// clock keeps its period and every part of one robot reads the same clock; `secondsClock` is for whoever has a
// clock of milliseconds to read in seconds.

import { systemClock, type Clock } from "../../feetech/transport";

/** Monotonic time in seconds and a wait on it: PEAR's `time.monotonic()` and `time.sleep()`. */
export interface MonotonicClock {
  /** Seconds on a clock that never runs backwards. */
  monotonic(): number;
  /** Resolves after `seconds`. */
  sleep(seconds: number): Promise<void>;
}

/** Returns `clock`, which counts milliseconds, read in seconds (by default the page's clock). */
export function secondsClock(clock: Clock = systemClock): MonotonicClock {
  return {
    monotonic: () => clock.now() / 1000,
    sleep: (seconds) => clock.sleep(seconds * 1000),
  };
}

/**
 * A clock that stands still until its user or a sleep advances it, as the stand-in clock of PEAR's tests
 * (tests/deploy/station/control_rig.py): `now` is what it reads, and each sleep advances it and then runs
 * `onSleep`, which a test uses to step what the sleeper waits for.
 */
export class SteppedClock implements MonotonicClock {
  /** The clock's first reading in PEAR's tests, s. */
  static readonly START_S = 100.0;

  /** Runs after each sleep has advanced the clock. */
  onSleep: ((seconds: number) => void | Promise<void>) | null = null;

  constructor(public now: number = SteppedClock.START_S) {}

  monotonic(): number {
    return this.now;
  }

  async sleep(seconds: number): Promise<void> {
    this.now += seconds;
    await this.onSleep?.(seconds);
  }
}
