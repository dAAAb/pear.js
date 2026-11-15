// Not a PEAR file: what stands for Python's time.monotonic() and time.sleep() in the port of
// pear/deploy/station/agent_loop. PEAR reads the process's clock itself; here a clock is a value a caller may
// replace, so that a test runs PEAR's own durations on a clock of its own.

/** A monotonic clock: seconds, from an origin that means nothing. */
export type Clock = () => number;

/** Waits ``seconds`` and resolves, sooner once ``wake`` is aborted. A test's own sleep may advance its clock
 * instead of waiting. */
export type Sleep = (seconds: number, wake?: AbortSignal) => Promise<void>;

/** The machine's monotonic clock, in seconds (time.monotonic). */
export const monotonic: Clock = () => performance.now() / 1000;

/** Waits ``seconds`` on the machine's timers (time.sleep, without blocking); aborting ``wake`` ends the wait and
 * drops its timer. */
export const sleep: Sleep = (seconds, wake) =>
  new Promise((resolve) => {
    if (wake?.aborted) {
      resolve();
      return;
    }
    const handle = setTimeout(resolve, Math.max(0, seconds) * 1000);
    wake?.addEventListener(
      "abort",
      () => {
        clearTimeout(handle);
        resolve();
      },
      { once: true },
    );
  });

/** A timer that can be dropped before it is due, so that nothing waits for it. */
export interface Timer {
  /** Resolves once ``seconds`` have passed; never when the timer was cancelled first. */
  readonly due: Promise<void>;
  cancel(): void;
}

/** Starts a timer of ``seconds`` on the machine's timers. */
export function startTimer(seconds: number): Timer {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const due = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, Math.max(0, seconds) * 1000);
  });

  return { due, cancel: () => clearTimeout(handle) };
}
