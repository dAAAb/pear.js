// Ports pear/deploy/station/control/joint/snapshot_checks.py.
//
// The two waits sleep on the clock they are given, so they are asynchronous; PEAR's block their thread.

import { ControlState, type ArmFeedback, type ControlSnapshot, type Observation } from "../schemas";
import { ArmState } from "./arm_state";
import { secondsClock, type MonotonicClock } from "./clock";
import type { ControlSettings } from "./config";
import { RuntimeError, ValueError } from "./errors";
import { pythonStr } from "./numeric";
import { StabilityError, type StabilityMetrics } from "./stability";

/** What the checks of a fault read of a snapshot. */
export type FaultSnapshot = Pick<ControlSnapshot, "status" | "fault"> & Partial<Pick<ControlSnapshot, "fault_details">>;

/** What the checks of a snapshot's feedback read of it. */
export type FeedbackSnapshot = FaultSnapshot & {
  readonly arms: Readonly<Record<string, Pick<ArmFeedback, "age_seconds">>>;
};

/** What reads the measured joints or the held targets of a snapshot as one vector. */
export interface VectorSnapshot {
  readonly arms: Readonly<Record<string, { readonly position: ArrayLike<number> }>>;
  readonly targets: Readonly<Record<string, ArrayLike<number>>>;
}

/** What the check of an observation's reference reads of the observation. */
export type ObservationReference = Pick<Observation, "joint_positions"> & {
  readonly control_snapshot: Pick<ControlSnapshot, "generation">;
};

/** What a wait checks between its readings: an ActionGuard is one. */
export interface WaitGuard {
  /** Throws if the action the wait belongs to is no longer current. */
  check(): void;
}

export interface WaitReadyOptions<Snapshot> {
  /** The longest wait, s. */
  readonly timeoutS: number;
  /** Between two readings, s. */
  readonly controlPeriodS: number;
  readonly guard: WaitGuard;
  /** Makes the error of a wait that timed out from its last snapshot. */
  readonly makeTimeoutError: (snapshot: Snapshot) => Error;
  /** Whether a settled HOLD is the one waited for; by default every one is. */
  readonly accepts?: ((snapshot: Snapshot) => boolean) | null;
  readonly clock?: MonotonicClock;
}

/**
 * The readings and the checks of a control snapshot that every robot applies, whatever its arms, and the wait they
 * repeat.
 */
export class SnapshotCheck {
  /**
   * Returns the first checked snapshot of `readSnapshot` that shows a settled HOLD which `accepts` accepts, never
   * resetting the history; past `timeoutS` throws the error made from the last snapshot.
   */
  static async waitReady<Snapshot extends Pick<ControlSnapshot, "status" | "arrival">>(
    readSnapshot: () => Snapshot | Promise<Snapshot>,
    options: WaitReadyOptions<Snapshot>,
  ): Promise<Snapshot> {
    const { timeoutS, controlPeriodS, guard, makeTimeoutError, accepts = null } = options;
    if (!Number.isFinite(timeoutS) || timeoutS < 0) {
      throw new ValueError("Wait timeout must be finite and nonnegative");
    }

    const readSettled = async (): Promise<[boolean, Snapshot]> => {
      guard.check();
      const snapshot = await readSnapshot();
      const isAccepted = accepts !== null ? accepts(snapshot) : true;
      guard.check();
      const isSettledHold = snapshot.status === ControlState.HOLD && snapshot.arrival.settled;

      return [isSettledHold && isAccepted, snapshot];
    };

    return SnapshotCheck.poll(readSettled, controlPeriodS, timeoutS, makeTimeoutError, options.clock);
  }

  /**
   * Returns the result of the first `attempt` that is done, trying once every control period; when `timeoutS` pass
   * first, throws the error made from the last result (by default the wait has no timeout of its own: an attempt
   * ends it).
   */
  static async poll<Result>(
    attempt: () => [boolean, Result] | Promise<[boolean, Result]>,
    controlPeriodS: number,
    timeoutS = Infinity,
    makeTimeoutError: ((result: Result) => Error) | null = null,
    clock: MonotonicClock = secondsClock(),
  ): Promise<Result> {
    const deadline = clock.monotonic() + timeoutS;

    for (;;) {
      const [isDone, result] = await attempt();
      if (isDone) {
        return result;
      }
      if (clock.monotonic() >= deadline) {
        throw (makeTimeoutError as (result: Result) => Error)(result);
      }

      await clock.sleep(controlPeriodS);
    }
  }

  /** Returns `snapshot` unless it shows a fault, an unexpected status or feedback too old to trust. */
  static validateSnapshot<Snapshot extends FeedbackSnapshot>(
    snapshot: Snapshot,
    controlConfig: Pick<ControlSettings, "state_timeout_s">,
    requiresHold = false,
  ): Snapshot {
    SnapshotCheck.raiseForFault(snapshot);

    const allowedStates: readonly string[] = requiresHold
      ? [ControlState.HOLD]
      : [ControlState.HOLD, ControlState.RUNNING, ControlState.STOPPING];
    if (!allowedStates.includes(snapshot.status)) {
      throw new RuntimeError(
        `Station requires valid ${requiresHold ? "HOLD" : "feedback"}: ` +
          `${pythonStr(snapshot.status)}: ${pythonStr(snapshot.fault)}`,
      );
    }
    if (
      Object.values(snapshot.arms).some(
        (feedback) => !ArmState.isFresh(feedback.age_seconds, controlConfig.state_timeout_s),
      )
    ) {
      throw new RuntimeError("Stale station feedback");
    }

    return snapshot;
  }

  /**
   * Throws unless `observation` is valid data of the snapshot's operation, whose targets it then still holds.
   */
  static validateReference(
    snapshot: VectorSnapshot & Pick<ControlSnapshot, "generation">,
    observation: ObservationReference | null,
  ): void {
    if (observation === null) {
      return;
    }

    if (observation.control_snapshot.generation !== snapshot.generation) {
      throw new ValueError("Observation invalidated by another operation");
    }
    const reference = Array.from(observation.joint_positions);
    if (reference.length !== SnapshotCheck.targetVector(snapshot).length || !reference.every(Number.isFinite)) {
      throw new ValueError("Invalid observation reference");
    }
  }

  /** Throws the latched fault of `snapshot` with its diagnostics, if it has one. */
  static raiseForFault(snapshot: FaultSnapshot): void {
    if (snapshot.status !== ControlState.FAULT && !snapshot.fault) {
      return;
    }

    const details = snapshot.fault_details || {};
    if (details["code"] === "StabilityError") {
      throw new StabilityError(details["reason"] as string, details["metrics"] as StabilityMetrics);
    }
    throw new RuntimeError(`Station fault: ${pythonStr(snapshot.status)}: ${pythonStr(snapshot.fault)}`);
  }

  /** Throws unless `timeoutS`, the timeout that `subject` names in the error, is finite and positive. */
  static checkTimeout(timeoutS: number, subject: string): void {
    if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
      throw new ValueError(`${subject} must be finite and positive`);
    }
  }

  /**
   * Returns the measured position of every arm in `snapshot` as one vector, in the snapshot's arm order, which is
   * the robot's.
   */
  static stateVector(snapshot: Pick<VectorSnapshot, "arms">): number[] {
    return Object.values(snapshot.arms).flatMap((feedback) => Array.from(feedback.position));
  }

  /** Returns the held command targets in `snapshot` as one vector, in the order of its measured arms. */
  static targetVector(snapshot: VectorSnapshot): number[] {
    return Object.keys(snapshot.arms).flatMap((arm) => Array.from(snapshot.targets[arm] as ArrayLike<number>));
  }
}
