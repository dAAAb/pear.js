// Ports pear/deploy/station/control/motion/results.py: MotionStatus and MotionResult.
//
// This file is the home of both. src/protocol/types.ts gives MotionStatus and the fields of a result under the names
// its texts were written against, and src/agent/robot.ts gives resultRecord: each is this file's definition.

import { motionErrorOf, RuntimeError, ValueError } from "../../python/errors";
import { SnapshotCheck } from "../joint/snapshot_checks";
import type { BriefStatus, ControlSnapshot, DetailedStatus } from "../schemas";

/** How an action ended, by the word its result carries. */
export const MotionStatus = {
  COMPLETED: "completed",
  /** Refused before anything was sent to the arms. */
  REJECTED: "rejected",
  FAILED: "failed",
} as const;
export type MotionStatus = (typeof MotionStatus)[keyof typeof MotionStatus];

/** What ended an action: the class name of the Python exception PEAR raises there, and its message. */
export interface MotionError {
  code: string;
  message: string;
}

/**
 * The fields of PEAR's MotionResult: the outcome of an action. `State` is what the model reads of the measured
 * joints, `Outcome` the robot's word for how its gripper ended.
 */
export interface MotionResultFields<State = unknown, Outcome extends string = string> {
  status: MotionStatus;
  isSettled: boolean;
  /** The action completed, the arms arrived and no gripper was stopped short of its target. */
  targetReached: boolean;
  /** The measured joint vector; null of a robot that is closed. */
  measuredPosition: number[] | null;
  /** The measured joints' signed errors against what the action requested. */
  trackingError: number[] | null;
  /** What the model reads of the measured joints. */
  measuredState: State | null;
  /** How the one gripper that moved ended, in the robot's word. */
  gripperOutcome: Outcome | null;
  /** The code and the message of what ended the action. */
  error: MotionError | null;
}

/** What a new result is made of: the last three fields are null unless given, as PEAR's defaults. */
export type MotionResultInit<State = unknown> = Pick<
  MotionResultFields<State>,
  "status" | "isSettled" | "targetReached" | "measuredPosition" | "trackingError"
> &
  Partial<Pick<MotionResultFields<State>, "measuredState" | "gripperOutcome" | "error">>;

/** What the results tell their log: PEAR's logger of this module, by level and message. */
export type ResultLog = (level: "error", message: string, error?: unknown) => void;

/** What `MotionResult.build` takes besides the snapshot; `gripperOutcome` is the field a robot's result adds. */
export interface MotionResultBuildOptions<State = unknown> {
  status: MotionStatus;
  /** What ended the action; null: nothing did. */
  error: unknown;
  /** Turns the measured joints into what the model reads; null: the result carries no state. */
  toModelState: ((measuredPosition: number[]) => State) | null;
  isGripperReached: boolean;
  gripperOutcome?: string | null;
  /** Told when the measured joints have no model state. */
  log?: ResultLog | null;
}

/** Returns a result as a task's records and the page keep it, under their keys (MotionResult.to_record). */
export function resultRecord(result: MotionResultFields): Record<string, unknown> {
  return {
    status: result.status,
    settled: result.isSettled,
    reached: result.targetReached,
    measured_position: result.measuredPosition,
    tracking_error: result.trackingError,
    measured_state: result.measuredState,
    gripper_outcome: result.gripperOutcome,
    error: result.error,
  };
}

/**
 * The outcome of an action: its status, settling and arrival, the measured pose, the gripper's outcome and the error
 * that ended it.
 */
export class MotionResult<State = unknown> implements MotionResultFields<State> {
  readonly status: MotionStatus;
  readonly isSettled: boolean;
  readonly targetReached: boolean;
  readonly measuredPosition: number[] | null;
  readonly trackingError: number[] | null;
  readonly measuredState: State | null;
  readonly gripperOutcome: string | null;
  readonly error: MotionError | null;

  constructor(fields: MotionResultInit<State>) {
    this.status = fields.status;
    this.isSettled = fields.isSettled;
    this.targetReached = fields.targetReached;
    this.measuredPosition = fields.measuredPosition;
    this.trackingError = fields.trackingError;
    this.measuredState = fields.measuredState ?? null;
    this.gripperOutcome = fields.gripperOutcome ?? null;
    this.error = fields.error ?? null;
  }

  /**
   * Returns the result of an action from a control snapshot or a robot's status; `toModelState` turns the measured
   * joints into what the model reads. The result is of the class it is called on.
   */
  static build<State, Result extends MotionResult<State>>(
    this: new (fields: MotionResultInit<State>) => Result,
    snapshot: ControlSnapshot | DetailedStatus | BriefStatus | Record<string, unknown>,
    options: MotionResultBuildOptions<State>,
  ): Result {
    const { status, error, toModelState, isGripperReached } = options;
    const fields = snapshot as Record<string, unknown>;
    const arrival = ("arrival" in fields ? fields["arrival"] : {}) as Record<string, unknown>;
    const measuredPosition = "arms" in fields ? SnapshotCheck.stateVector(fields as unknown as ControlSnapshot) : null;

    let modelState: State | null = null;
    if (measuredPosition !== null && toModelState !== null) {
      try {
        modelState = toModelState(measuredPosition);
      } catch (caught) {
        if (!(caught instanceof ValueError || caught instanceof RuntimeError)) {
          throw caught;
        }
        options.log?.("error", "The measured joints have no model state", caught);
      }
    }

    return new this({
      status,
      isSettled: ("settled" in arrival ? arrival["settled"] : false) as boolean,
      // Python's `and`: the first of the three that is not true, else the last
      targetReached: (status === MotionStatus.COMPLETED &&
        ("reached" in arrival ? arrival["reached"] : false) &&
        isGripperReached) as boolean,
      measuredPosition,
      trackingError: ("signed_error" in arrival ? arrival["signed_error"] : null) as number[] | null,
      measuredState: modelState,
      error: error === null || error === undefined ? null : motionErrorOf(error),
      gripperOutcome: options.gripperOutcome ?? null,
    });
  }

  /** Returns the result as a task's records and the page keep it, under their keys and in JSON values. */
  toRecord(): Record<string, unknown> {
    return resultRecord(this);
  }
}
