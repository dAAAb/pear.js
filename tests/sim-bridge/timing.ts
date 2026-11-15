// Not in PEAR: how long the hardware layer's read and send took in a run of the scripted sessions.

import type { RunResult, StepRecord } from "./session";

export interface Spread {
  count: number;
  median: number;
  p95: number;
  p99: number;
  max: number;
}

export function spread(values: readonly number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share: number): number => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? Number.NaN;

  return { count: sorted.length, median: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1] ?? Number.NaN };
}

export interface Timing {
  /** Cycles at the control rate: a read, then a send. */
  paced: { cycle: Spread; read: Spread; send: Spread; period: Spread } | null;
  /** Cycles without a pause between them. */
  burst: { cycle: Spread; read: Spread; send: Spread; cyclesPerSecond: number } | null;
}

/** Returns the times of the cycles and of the bursts of every session of ``result``, ms. */
export function timingOf(result: RunResult): Timing {
  const cycleMs: number[] = [];
  const readMs: number[] = [];
  const sendMs: number[] = [];
  const periodMs: number[] = [];
  const burstRead: number[] = [];
  const burstSend: number[] = [];

  for (const session of result.sessions) {
    let previous: StepRecord | null = null; // the cycle right before this step, if it is one
    for (const step of session.steps) {
      if (step.op === "cycle" && typeof step.read_ms === "number" && typeof step.send_ms === "number") {
        cycleMs.push(step.read_ms + step.send_ms);
        readMs.push(step.read_ms);
        sendMs.push(step.send_ms);
        if (previous?.tick_started_ms !== undefined && step.tick_started_ms !== undefined) {
          periodMs.push(step.tick_started_ms - previous.tick_started_ms);
        }
        previous = step;
      } else {
        previous = null;
      }
      if (step.op === "burst" && Array.isArray(step.read_ms) && Array.isArray(step.send_ms)) {
        burstRead.push(...step.read_ms);
        burstSend.push(...step.send_ms);
      }
    }
  }

  const burstCycle = burstRead.map((read, index) => read + burstSend[index]);
  const burstTotal = burstCycle.reduce((sum, each) => sum + each, 0);

  return {
    paced:
      cycleMs.length === 0
        ? null
        : { cycle: spread(cycleMs), read: spread(readMs), send: spread(sendMs), period: spread(periodMs) },
    burst:
      burstCycle.length === 0
        ? null
        : {
            cycle: spread(burstCycle),
            read: spread(burstRead),
            send: spread(burstSend),
            cyclesPerSecond: (1000 * burstCycle.length) / burstTotal,
          },
  };
}

/** Returns the timing as lines of text. ``isPaced`` says whether the cycles of a move waited for the control
 * period (they do not when the simulated arm ages with the packets alone). */
export function describeTiming(timing: Timing, controlPeriodS: number, isPaced: boolean): string[] {
  const line = (name: string, each: Spread): string =>
    `${name}: n ${each.count}, median ${each.median.toFixed(3)}, p95 ${each.p95.toFixed(3)}, p99 ${each.p99.toFixed(3)}, ` +
    `max ${each.max.toFixed(3)} ms`;
  const lines: string[] = [];
  if (timing.paced !== null) {
    const pace = isPaced ? `paced at ${(controlPeriodS * 1000).toFixed(0)} ms` : "not paced";
    lines.push(
      line(`cycles of the moves (${pace}), read + send`, timing.paced.cycle),
      line("  read alone", timing.paced.read),
      line("  send alone", timing.paced.send),
      line("  period between two cycles", timing.paced.period),
    );
  }
  if (timing.burst !== null) {
    lines.push(
      line("cycles without a pause, read + send", timing.burst.cycle),
      line("  read alone", timing.burst.read),
      line("  send alone", timing.burst.send),
      `  ${timing.burst.cyclesPerSecond.toFixed(0)} cycles a second`,
    );
  }

  return lines;
}
