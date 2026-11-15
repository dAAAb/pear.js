// Ports pear/deploy/station/gui/console/watchdog.py: Watchdog, the background check that pauses the robot when
// the browser that holds control, the recording, the cameras or the control fail.
//
// The check runs on a PeriodicThread (periodic_thread.ts): every PERIOD_S after the end of the check before, the
// first one a period after the watchdog is made, and a check that throws ends the watchdog for good, as in PEAR.
// Console.stop is async here, so a check that stops the robot awaits it: the next check waits for it, as PEAR's
// thread does, while the commands and the worker's operation go on.
//
// The lock. PEAR's _stop_for_fault holds console.lock around the robot's stop; here that stop is awaited, and what
// can come between is said there. The last step of a check (the idle phase) awaits nothing.
//
// What watchdog.py uses of the parts that are not ported beyond what console.py uses is in the interfaces of this
// file (WatchdogRecordings, WatchdogPreview); WatchdogConsole is the Console whose parts have them. The clock, the
// waits and the log are options, handed to the periodic thread: the console keeps its own private, so whoever
// makes both gives both the same functions.

import type { ModelState, SingleArmDelta } from "../protocol/types";
import { KeyError } from "../python/errors";
import { pythonStr, pythonTruth, pythonValueOf } from "../python/repr";
import { RobotStatus, type BriefStatus } from "../station/schemas";
import type { Console, ConsolePreview, ConsoleRecordings } from "./console";
import { PeriodicThread, type PeriodicThreadOptions } from "./periodic_thread";
import { idleFor, Phase, STOPPED_STATUSES } from "./phase";

/** The status of a recording segment that ended without its videos (SegmentStatus.FAILED of
 * records/recording/encode_worker.py). */
export const SEGMENT_FAILED = "failed";

/** What watchdog.py calls of the recording segment that is recording (PEAR's Segment). */
export interface WatchdogSegment {
  /** Returns what the page shows of the segment: its `status`, the word of a SegmentStatus, and its `error`. */
  snapshot(): Readonly<Record<string, unknown>>;
}

/** What watchdog.py uses of PEAR's RenderedRecordings, beside what console.py calls. */
export interface WatchdogRecordings extends ConsoleRecordings {
  /** The segment that is recording; null while none is. */
  readonly activeSegment: WatchdogSegment | null;
}

/** What watchdog.py uses of PEAR's Preview, beside what console.py calls. */
export interface WatchdogPreview extends ConsolePreview {
  /** Whether previews are encoded: the cameras' reader is open. */
  readonly isEncoding: boolean;
  /** The cameras' errors in one sentence; null without one. */
  readonly errorText: string | null;
}

/** The Console as Watchdog uses it: its parts with what watchdog.py uses of them. */
export type WatchdogConsole<State = ModelState, Action = SingleArmDelta, Image = unknown> = Console<
  State,
  Action,
  Image
> & {
  readonly recordings: WatchdogRecordings;
  readonly preview: WatchdogPreview;
};

/** What a watchdog is made with, beside its console: the clock, the waits and the log of its periodic thread. */
export type WatchdogOptions = Pick<PeriodicThreadOptions, "clock" | "sleep" | "log">;

/** Returns ``record[key]``; throws Python's KeyError when the record has no such key. */
function item(record: Readonly<Record<string, unknown>>, key: string): unknown {
  if (!Object.hasOwn(record, key)) {
    throw new KeyError(`'${key}'`);
  }

  return record[key];
}

/** A background check that pauses the robot when the browser that holds control, the recording, the cameras or
 * the control fail. */
export class Watchdog<State = ModelState, Action = SingleArmDelta, Image = unknown> {
  /** Between two checks, s. */
  static readonly PERIOD_S = 0.1;
  /** Of the thread that checks. */
  static readonly THREAD_NAME = "gui-watchdog";
  /** The phases that need no camera feeds. */
  static readonly PHASES_WITHOUT_CAMERAS: readonly Phase[] = [Phase.RECONNECTING_CAMERAS, Phase.RECOVERING_CONTROL];

  readonly periodicThread: PeriodicThread;

  constructor(
    readonly console: WatchdogConsole<State, Action, Image>,
    options: WatchdogOptions = {},
  ) {
    this.periodicThread = new PeriodicThread(() => this.check(), Watchdog.PERIOD_S, Watchdog.THREAD_NAME, {
      isWaitingFirst: true,
      isEndedByFailure: true,
      ...options,
    });
  }

  /** Stops checking. */
  close(): Promise<void> {
    return this.periodicThread.close();
  }

  /** Checks the browser, the recording, the cameras and the robot once (PEAR: _check). */
  private async check(): Promise<void> {
    const console = this.console;
    const lostOwner = console.lease.lostOwner();
    if (lostOwner !== null) {
      await this.releaseLostBrowser(lostOwner);
    }

    let robotState = console.robot.status();
    const segment = console.recordings.activeSegment;
    if (segment !== null && item(segment.snapshot(), "status") === SEGMENT_FAILED) {
      console.error = "Recording failed: " + pythonStr(pythonValueOf(item(segment.snapshot(), "error")));
      await console.stop({ reason: console.error });
    }

    if (robotState.status === RobotStatus.FAULT) {
      console.saveControlDiagnostic();
    }

    if (
      console.isBusy &&
      !console.cancellation.signal.aborted &&
      !Watchdog.PHASES_WITHOUT_CAMERAS.includes(console.phase) &&
      console.preview.isEncoding &&
      pythonTruth(console.preview.errorText)
    ) {
      await console.stop({ reason: "Camera unavailable; restore the feed before resuming." });
    }

    if (robotState.status === RobotStatus.FAULT) {
      robotState = await this.stopForFault();
    }

    // under the lock a phase a command shows meanwhile is not replaced by the idle one
    // (PEAR: with console.lock; nothing is awaited here)
    if (
      console.phase === Phase.STOPPING &&
      !console.isBusy &&
      (STOPPED_STATUSES as readonly string[]).includes(robotState.status)
    ) {
      const idlePhase = idleFor(robotState.status, {
        isLatched: console.isStopLatched,
        hasTask: console.taskRun.task !== null,
      });
      console.setPhase(idlePhase);
    }
  }

  /** Pauses the operation of a browser that went silent, then frees control for the next one. */
  private async releaseLostBrowser(owner: string): Promise<void> {
    const console = this.console;
    // camera maintenance has no motor or task side effects: a lost browser must not cancel it and leave every
    // camera reader closed
    if (console.phase !== Phase.RECONNECTING_CAMERAS) {
      await console.stop({ reason: "Control connection lost; resume explicitly after reconnecting." });
    }
    console.lease.release(owner);
  }

  /**
   * Pauses for a robot fault and shows it, unless recovery is under way; returns the robot's status as it was read
   * before the stop.
   *
   * PEAR holds console.lock from the status read to the phase FAULT, so no command comes between. Here the robot's
   * stop is awaited, and a command can be admitted meanwhile. The one a faulted robot admits is recover_control:
   * it shows RECOVERING_CONTROL and launches the recovery under a new cancellation, which this stop, having
   * aborted the old one already, does not cancel; the stop then shows STOPPING and this method the fault and the
   * phase FAULT while the recovery runs, where PEAR shows FAULT first and RECOVERING_CONTROL after it. The
   * recovery's end shows the idle phase and clears the failure in either order.
   */
  private async stopForFault(): Promise<BriefStatus> {
    const console = this.console;

    // recovery may have completed after the earlier status read
    const robotState = console.robot.status();
    if (
      robotState.status === RobotStatus.FAULT &&
      console.phase !== Phase.FAULT &&
      console.phase !== Phase.RECOVERING_CONTROL
    ) {
      const fault: unknown = pythonTruth(robotState.fault) ? robotState.fault : "Robot fault";
      await console.stop({ reason: fault as string });
      console.error = pythonStr(pythonValueOf(fault));
      console.setPhase(Phase.FAULT);
    }

    return robotState;
  }
}
