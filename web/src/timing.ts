// Not in PEAR: measurements for the control loop a later version needs. PEAR's loop runs every 20 ms and, each
// period, reads the six positions and sends six goals. This measures, in the browser the page runs in, how long
// the read takes and how regularly a timer of 20 ms fires, alone and with a read in every period. It sends
// nothing but reads.

export interface Stats {
  count: number;
  min: number;
  median: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/** Returns the order statistics of ``values`` (the nearest-rank percentiles). */
export function statsOf(values: readonly number[]): Stats {
  const sorted = [...values].sort((first, second) => first - second);
  const rank = (share: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))] ?? NaN;

  return {
    count: sorted.length,
    min: sorted[0] ?? NaN,
    median: rank(0.5),
    p95: rank(0.95),
    p99: rank(0.99),
    max: sorted[sorted.length - 1] ?? NaN,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

export function formatStats(stats: Stats): string {
  const ms = (value: number): string => value.toFixed(3);

  return `n ${stats.count}, median ${ms(stats.median)} ms, p95 ${ms(stats.p95)} ms, p99 ${ms(stats.p99)} ms, max ${ms(stats.max)} ms, min ${ms(stats.min)} ms`;
}

export interface TimerRun {
  /** The time from one firing to the next, ms. */
  periods: number[];
  /** How long the work of each period took, ms; empty without work. */
  work: number[];
  /** The periods whose work had not ended when the next was due, so that it was skipped. */
  overruns: number;
}

/**
 * Fires ``periods`` + 1 times, ``periodMs`` apart, and returns the times between firings. With "interval" the
 * browser's setInterval paces it; with "deadline" each firing schedules the next for its own due time, counted
 * from the start, so that a late firing does not delay the ones after it. ``work`` runs in every period.
 */
export function runTimer(
  kind: "interval" | "deadline",
  periodMs: number,
  periods: number,
  work?: () => Promise<void>,
): Promise<TimerRun> {
  return new Promise((resolve) => {
    const run: TimerRun = { periods: [], work: [], overruns: 0 };
    const startedAt = performance.now();
    let previous = startedAt;
    let fired = 0;
    let isWorking = false;
    let handle: ReturnType<typeof setInterval> | undefined;

    const fire = (): boolean => {
      const now = performance.now();
      if (fired > 0) run.periods.push(now - previous);
      previous = now;
      fired += 1;
      if (work !== undefined) {
        if (isWorking) run.overruns += 1;
        else {
          isWorking = true;
          void work()
            .catch(() => undefined)
            .then(() => {
              run.work.push(performance.now() - now);
              isWorking = false;
            });
        }
      }

      return fired > periods;
    };
    const finish = (): void => {
      const settle = (): void => {
        if (isWorking) setTimeout(settle, 1);
        else resolve(run);
      };
      settle();
    };

    if (kind === "interval") {
      handle = setInterval(() => {
        if (fire()) {
          clearInterval(handle);
          finish();
        }
      }, periodMs);
    } else {
      const next = (): void => {
        if (fire()) {
          finish();
          return;
        }
        setTimeout(next, Math.max(startedAt + fired * periodMs - performance.now(), 0));
      };
      setTimeout(next, periodMs);
    }
  });
}

/** Returns the smallest step the page's clock makes, ms: a browser coarsens performance.now(), so that a
 * duration below the step reads as zero. */
export function clockStep(): number {
  let smallest = Infinity;
  let previous = performance.now();
  for (let index = 0; index < 200_000 && smallest > 0.001; index++) {
    const now = performance.now();
    if (now > previous) {
      smallest = Math.min(smallest, now - previous);
      previous = now;
    }
  }

  return smallest;
}

export interface TimingReport {
  visibility: string;
  hasFocus: boolean;
  /** The smallest step of the page's clock, ms: no single duration below is finer than this. */
  clockStepMs: number;
  /** One read of the six positions, one after another without a pause. */
  reads: Stats;
  /** How long those reads took together, ms: their mean is finer than the clock's step. */
  readsTotalMs: number;
  /** A 20 ms setInterval with nothing to do. */
  interval: Stats;
  /** A 20 ms timer that aims at its own due times, with nothing to do. */
  deadline: Stats;
  /** A 20 ms setInterval that reads the six positions in every period: the periods, and the reads. */
  loadedInterval: Stats;
  loadedReads: Stats;
  loadedOverruns: number;
}

export const TIMER_PERIOD_MS = 20;
export const TIMER_PERIODS = 500;
export const READS = 200;

/** Runs the measurements; ``readOnce`` reads the six positions once, ``readMany`` returns the durations of that
 * many reads in a row, ``progress`` is told which step runs. */
export async function measureTiming(
  readOnce: () => Promise<void>,
  readMany: (count: number) => Promise<number[]>,
  progress: (step: string) => void,
): Promise<TimingReport> {
  progress("1/4");
  const step = clockStep();
  const readsStartedAt = performance.now();
  const reads = statsOf(await readMany(READS));
  const readsTotalMs = performance.now() - readsStartedAt;
  progress("2/4");
  const interval = await runTimer("interval", TIMER_PERIOD_MS, TIMER_PERIODS);
  progress("3/4");
  const deadline = await runTimer("deadline", TIMER_PERIOD_MS, TIMER_PERIODS);
  progress("4/4");
  const loaded = await runTimer("interval", TIMER_PERIOD_MS, TIMER_PERIODS, readOnce);

  return {
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
    clockStepMs: step,
    reads,
    readsTotalMs,
    interval: statsOf(interval.periods),
    deadline: statsOf(deadline.periods),
    loadedInterval: statsOf(loaded.periods),
    loadedReads: statsOf(loaded.work),
    loadedOverruns: loaded.overruns,
  };
}
