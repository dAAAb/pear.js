// Ports pear/deploy/station/gui/console/periodic_thread.py: PeriodicThread, a step done every period until it is
// closed.
//
// The thread is a loop: an async function that the constructor starts and does not await, behind a ConsoleWorker,
// which stands for PEAR's threading.Thread (whether the loop still runs, and a wait for its end up to a time
// limit). The loop begins on a later microtask, after whatever its maker still does without awaiting: a thread
// that has been started and has not run yet. exit_event is an AbortController; exit_event.wait(seconds) is the
// option `sleep` with the controller's signal as its wake, by default the machine's timers; time.monotonic() is
// the option `clock`; logger.exception goes to the option `log`, under the logger "periodic_thread".
//
// A step may return a promise, which the loop awaits before it paces the next step: PEAR's step blocks its thread.
//
// A step that takes longer than the period. In PEAR and here the next step never begins before this one has
// ended: paced from the steps' starts, it begins MIN_WAIT_S after this one's end; paced from their ends (the
// default), a whole period after it. What differs is who else waits. PEAR's long step holds its own thread and no
// other. Here a step that awaits (the watchdog's stop of the robot) lets the page's other work run meanwhile, as
// PEAR's other threads run; a step that computes without awaiting holds the page's one thread for as long: the
// commands, the worker's operation and every timer. And a page's timer is not exact to a millisecond: a wait of
// MIN_WAIT_S may last several.

import { monotonic, sleep as machineSleep, type Clock, type Sleep } from "../agent/clock";
import type { Awaitable } from "../agent/robot";
import type { RobotLog } from "../station/robot";
import { ConsoleWorker } from "./console";

/** What a periodic thread is made with, beside its step, its period and its name. */
export interface PeriodicThreadOptions {
  /** Whether the first step waits one period; by default not. */
  isWaitingFirst?: boolean;
  /** Whether a period counts from a step's start, not its end; by default not. */
  isPacedFromStart?: boolean;
  /** Whether a step that fails ends the thread; by default not. */
  isEndedByFailure?: boolean;
  /** The monotonic clock, s (time.monotonic()); by default the machine's. */
  clock?: Clock;
  /** The wait between two steps and behind the time limit of close; by default the machine's timers. */
  sleep?: Sleep;
  /** Where logger.exception goes; by default nowhere. */
  log?: RobotLog;
}

/** A background loop that does a step every period until it is closed: the first step at once or after one
 * period, each next one a period after a step's start or a whole period after its end; a step that fails is
 * logged with its error, and the loop then goes on or ends. */
export class PeriodicThread {
  /** Between two steps paced from their starts, even when one took longer than the period, s. */
  static readonly MIN_WAIT_S = 0.001;
  /** For the step in progress at close, s. */
  static readonly JOIN_S = 2.0;

  /** Whether the first step waits one period. */
  readonly isWaitingFirst: boolean;
  /** Whether a period counts from a step's start, not its end. */
  readonly isPacedFromStart: boolean;
  /** Whether a step that fails ends the thread. */
  readonly isEndedByFailure: boolean;
  /** Aborted at close (PEAR: exit_event, set at close). */
  readonly exitEvent = new AbortController();
  /** What stands for the thread that does the steps. */
  readonly thread: ConsoleWorker;

  private readonly clock: Clock;
  private readonly sleep: Sleep;
  private readonly log: RobotLog;

  constructor(
    /** One step; what it returns is not used, and a promise is awaited. */
    readonly step: () => Awaitable<unknown>,
    /** Between two steps, s. */
    readonly periodS: number,
    threadName: string,
    options: PeriodicThreadOptions = {},
  ) {
    this.isWaitingFirst = options.isWaitingFirst ?? false;
    this.isPacedFromStart = options.isPacedFromStart ?? false;
    this.isEndedByFailure = options.isEndedByFailure ?? false;
    this.clock = options.clock ?? monotonic;
    this.sleep = options.sleep ?? machineSleep;
    this.log = options.log ?? (() => undefined);
    this.thread = new ConsoleWorker(
      threadName,
      () => this.run(),
      this.sleep,
      // what leaves the loop ends the thread; Python prints it, here it goes to the log
      (error) => this.log("periodic_thread", "error", `Exception in thread ${threadName}`, error),
    );
  }

  /** Ends the steps and waits up to JOIN_S for the one in progress; the loop may outlive the wait. */
  async close(): Promise<void> {
    this.exitEvent.abort();
    await this.thread.join(PeriodicThread.JOIN_S);
  }

  /** Does a step every period until the thread is closed, or until a step fails when that ends it (PEAR: _run). */
  private async run(): Promise<void> {
    const exit = this.exitEvent.signal;
    if (this.isWaitingFirst) {
      await this.sleep(this.periodS, exit); // (exit_event.wait(period_s): true once the event is set)
      if (exit.aborted) {
        return;
      }
    }

    while (!exit.aborted) {
      const startTime = this.clock();
      try {
        await this.step();
      } catch (error) {
        this.log("periodic_thread", "error", `A step of ${this.thread.name} failed`, error);
        if (this.isEndedByFailure) {
          return;
        }
      }
      if (this.isPacedFromStart) {
        await this.sleep(Math.max(PeriodicThread.MIN_WAIT_S, this.periodS - (this.clock() - startTime)), exit);
      } else {
        await this.sleep(this.periodS, exit);
      }
    }
  }
}
