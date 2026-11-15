// Ports pear/deploy/station/control/robots/so101/motion/results.py: SO101MotionResult.

import type { MotionStatus, ResultLog } from "../../station/motion/results";
import { MotionResult } from "../../station/motion/results";
import type { BriefStatus, ControlSnapshot, DetailedStatus } from "../../station/schemas";
import { GripperOutcome } from "../joint/grippers";
import type { BaseKinematics } from "../kinematics/base";
import { modelStateOf, type ModelState } from "./actions";

/** An SO-101 action's result, in which a jaw stopped before it closed has not reached its target. */
export class SO101MotionResult extends MotionResult<ModelState> {
  /**
   * Returns the result of an action from a control snapshot or the robot's status, with the model's state of the
   * measured joints when `kinematics` are given.
   */
  static fromSnapshot(
    snapshot: ControlSnapshot | DetailedStatus | BriefStatus | Record<string, unknown>,
    options: {
      status: MotionStatus;
      error: unknown;
      kinematics: BaseKinematics | null;
      gripperOutcome?: string | null;
      log?: ResultLog | null;
    },
  ): SO101MotionResult {
    const { kinematics } = options;
    const gripperOutcome = options.gripperOutcome ?? null;

    return this.build<ModelState, SO101MotionResult>(snapshot, {
      status: options.status,
      error: options.error,
      toModelState: kinematics === null ? null : (measuredPosition) => modelStateOf(kinematics, measuredPosition),
      isGripperReached: gripperOutcome !== GripperOutcome.STOPPED_BEFORE_CLOSED,
      gripperOutcome,
      log: options.log ?? null,
    });
  }
}
