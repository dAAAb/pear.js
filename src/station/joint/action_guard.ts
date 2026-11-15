// Ports pear/deploy/station/control/joint/action_guard.py.
//
// PEAR's guard takes the control loop's lock around each check and each submission, so that no stop, fault or other
// operation falls between a check and what follows it. A page has one thread: what runs between two awaits is
// already indivisible, so the guard takes no lock, and a submitted method must do its work before it first awaits.

import { ControlState, type ControlSnapshot } from "../schemas";
import { OperatorPaused, RuntimeError, type Cancellation } from "./errors";
import { pythonStr } from "./numeric";
import { SnapshotCheck, type FaultSnapshot } from "./snapshot_checks";

/** What an action guard reads and asks of the control loop it guards (PEAR's JointControlLoop). */
export interface GuardedControlLoop {
  /** Advances with every operation, stop and fault. */
  readonly generation: number;
  /** The word of a ControlState. */
  readonly status: string;
  /** The latched fault's text; null without one. */
  readonly fault: string | null;
  /** Returns the control loop's state, measured now. */
  snapshot(): FaultSnapshot | ControlSnapshot;
  /** Has the operation that runs, if one does, stop once `cancellation` is set. */
  attachCancellation(cancellation: Cancellation | null): void;
}

/** Binds every phase of one caller's action to the operation generation its own submissions started. */
export class ActionGuard {
  /** A stop, a fault, a close or a competing operation advances the generation, which ends every later phase. */
  generation: number;
  /** Whether a submission of this action started an operation. */
  hasDispatched = false;

  constructor(
    readonly controlLoop: GuardedControlLoop,
    /** Set by the operator to pause the action. */
    readonly cancellation: Cancellation | null = null,
  ) {
    this.generation = controlLoop.generation;
  }

  /** Throws if the action was cancelled, the control loop faulted or closed, or another operation began. */
  check(): void {
    const controlLoop = this.controlLoop;
    OperatorPaused.checkCancelled(this.cancellation);

    if (controlLoop.status === ControlState.FAULT) {
      SnapshotCheck.raiseForFault(controlLoop.snapshot());
    }
    if (controlLoop.status === ControlState.CLOSED) {
      throw new RuntimeError(`Action interrupted: ${pythonStr(controlLoop.status)}: ${pythonStr(controlLoop.fault)}`);
    }
    if (this.generation !== controlLoop.generation) {
      throw new RuntimeError("Action cancelled by stop or another operation");
    }
  }

  /**
   * Calls a method of the control loop if the action is still current, adopts the operation it starts and returns
   * what it returns. A method that returns a promise is adopted when the promise resolves, and not at all when it
   * rejects.
   */
  submit<Arguments extends unknown[], Result>(
    controlLoopMethod: (...methodArguments: Arguments) => Result,
    ...methodArguments: Arguments
  ): Result {
    this.check();
    const result = controlLoopMethod(...methodArguments);
    if (result instanceof Promise) {
      return result.then((value: unknown) => {
        this.adopt();
        return value;
      }) as Result;
    }
    this.adopt();

    return result;
  }

  /** Follows the control loop's generation after a submission: the method started an operation or stopped. */
  private adopt(): void {
    const controlLoop = this.controlLoop;
    const hasAdvanced = this.generation !== controlLoop.generation;
    if (hasAdvanced) {
      controlLoop.attachCancellation(this.cancellation);
    }
    this.hasDispatched ||= hasAdvanced;
    this.generation = controlLoop.generation;
  }
}
