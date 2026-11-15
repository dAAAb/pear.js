// Ports pear/deploy/station/control/motion/execution.py: Execution.
//
// What blocks PEAR's thread is asynchronous here: a wait for the control loop, a sleep, an observation (it reads the
// cameras). PEAR reads `time.monotonic()`; the methods here read the clock of the robot they are built into, so
// `remainingS` is a method of the object (PEAR's is static, and is always called on one).

import type { ActionGuard } from "../joint/action_guard";
import type { MonotonicClock } from "../joint/clock";
import type { JointControlLoop } from "../joint/control_loop";
import { RuntimeError, TimeoutError } from "../joint/errors";
import { pythonMin, pythonStr } from "../joint/numeric";
import type { GripperOperation } from "../joint/operations";
import { SnapshotCheck } from "../joint/snapshot_checks";
import { MotionEndReason, type ControlSnapshot, type Observation } from "../schemas";
import type { JointPositions } from "./actions";
import type { PreparedAction } from "./planning";

/** Returns the control loop an action's guard is bound to: the robot's own, with every method of PEAR's. */
export function controlLoopOf(guard: ActionGuard): JointControlLoop {
  return guard.controlLoop as JointControlLoop;
}

/** The control loop's class, whose constants a robot's loop may give its own (PEAR reads them of the instance). */
function loopClassOf(controlLoop: JointControlLoop): typeof JointControlLoop {
  return controlLoop.constructor as typeof JointControlLoop;
}

/**
 * The action level a robot's class is built on: how a chunk of joint targets and a prepared action are carried out
 * under the action's guard, from the three steps of its session that the robot gives.
 */
export abstract class Execution {
  /** The time the station reads and sleeps on: PEAR's `time.monotonic()` and `time.sleep()`. */
  abstract readonly clock: MonotonicClock;

  /**
   * Streams the chunk of joint targets `action` from the hold of `observation`, waits for its HOLD until `deadline`
   * and returns the snapshot then.
   */
  async runSequence(
    action: JointPositions,
    observation: Observation,
    options: { guard: ActionGuard; deadline: number | null },
  ): Promise<ControlSnapshot> {
    const { guard, deadline } = options;
    const controlLoop = controlLoopOf(guard);
    await this.submitWhenSettled(
      guard,
      () => controlLoop.startSequence(action.positions, { rateHz: action.rate_hz, observation }),
      { deadline },
    );

    const durationS = action.positions.length / action.rate_hz;
    const snapshot = await controlLoop.waitForHold(
      this.remainingS(deadline, durationS + loopClassOf(controlLoop).SEQUENCE_MARGIN_S),
      { guard },
    );
    if (snapshot.motion.end_reason !== MotionEndReason.FINISHED) {
      throw new RuntimeError(`Sequence interrupted: ${pythonStr(snapshot.motion.end_reason)}`);
    }

    return snapshot;
  }

  /**
   * Runs the arm move of `preparedAction` from the hold of `observation`, then what it asks of the grippers, all
   * until `deadline`, and returns the grippers' report (null when it asks nothing of them).
   */
  async runPrepared(
    observation: Observation,
    preparedAction: PreparedAction,
    options: { guard: ActionGuard; deadline: number | null },
  ): Promise<Record<string, unknown> | null> {
    const { guard, deadline } = options;
    const controlLoop = controlLoopOf(guard);
    const move = preparedAction.move;
    if (move !== null) {
      await this.submitWhenSettled(guard, () => controlLoop.dispatchJointMove(move, observation), { deadline });
      const marginS = controlLoop.controlConfig.settle_timeout_s + loopClassOf(controlLoop).MOVE_MARGIN_S;
      await controlLoop.waitForHold(this.remainingS(deadline, move.durationS + marginS), { guard });
      if (controlLoop.snapshot().motion.end_reason !== MotionEndReason.FINISHED) {
        throw new RuntimeError("Cartesian action was interrupted");
      }
    }

    if (preparedAction.gripperRequest === null) {
      return null;
    }

    guard.check();
    const observationAfterMove = await this.observe();
    guard.check();

    return this.operateGrippers(preparedAction.gripperRequest, { observation: observationAfterMove, guard, deadline });
  }

  /**
   * Moves the grippers as `gripperRequest` asks while the arms hold `observation`, until `deadline`, and returns the
   * report of the operation.
   */
  async operateGrippers(
    gripperRequest: unknown,
    options: { observation: Observation; guard: ActionGuard; deadline: number | null },
  ): Promise<Record<string, unknown>> {
    const { observation, guard, deadline } = options;
    const controlLoop = controlLoopOf(guard);
    guard.check();
    const startTime = this.clock.monotonic();

    let operation: GripperOperation;
    try {
      const timeoutS = this.remainingS(deadline, loopClassOf(controlLoop).GRIPPER_TIMEOUT_S);
      operation = this.submitGrippers(guard, observation, gripperRequest);
      await controlLoop.waitForHold(timeoutS, { guard });
    } catch (error) {
      await controlLoop.stop();
      throw error;
    }

    return {
      kind: "gripper",
      completed: true,
      ...operation.report(),
      elapsed_seconds: this.clock.monotonic() - startTime,
    };
  }

  /**
   * Submits a method of the control loop through `guard` until it starts its operation, which it does not while the
   * hold has not settled; gives up at `deadline` or once the settle timeout has passed. `submit` is the call of
   * that method, which returns whether the operation started.
   */
  async submitWhenSettled(guard: ActionGuard, submit: () => boolean, options: { deadline: number | null }): Promise<void> {
    const controlConfig = controlLoopOf(guard).controlConfig;

    await SnapshotCheck.poll<null>(
      () => [guard.submit(submit), null],
      controlConfig.controlPeriodS,
      this.remainingS(options.deadline, controlConfig.settle_timeout_s),
      () => new TimeoutError("No stable window before dispatch; no new command sent"),
      this.clock,
    );
  }

  /**
   * Returns the measured joints, the cameras' frames and the control snapshot as one observation of the session.
   */
  abstract observe(): Promise<Observation>;

  /**
   * Waits under `guard`, until `deadline`, for a settled HOLD, of the operation of `observation` if one is given,
   * and returns its snapshot.
   */
  abstract waitForSettledHold(
    observation: Observation | null,
    options: { deadline?: number | null; guard: ActionGuard },
  ): Promise<ControlSnapshot>;

  /**
   * Starts the gripper operation for `gripperRequest` under `guard` while the arms hold `observation`, settled, and
   * returns it.
   */
  abstract submitGrippers(guard: ActionGuard, observation: Observation, gripperRequest: unknown): GripperOperation;

  /** Returns how long is left until `deadline`, at most `limitS`, and throws once it has passed. */
  remainingS(deadline: number | null, limitS: number): number {
    if (deadline === null) {
      return limitS;
    }

    const remainingS = pythonMin(limitS, deadline - this.clock.monotonic());
    if (remainingS <= 0) {
      throw new TimeoutError("Action total timeout exceeded");
    }

    return remainingS;
  }
}
