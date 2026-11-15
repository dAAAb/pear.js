// What the page must show for given servo positions, computed in Node with the library alone and by another
// route than the page's. The page reads the raw steps and has the bus convert them; here a simulated arm is put
// at the same steps and the bus reads it normalized, as PEAR's read() does, before SO101Hardware.busPosition and
// SO101Kinematics.quantities. web/tests/run_node.mjs runs this file; web/tests/browser_check.py compares.

import { SINGLE_ARM_POSE_FORMAT } from "../../src/agent/index";
import type { MotorCalibration } from "../../src/feetech/index";
import { MOTORS, type MotorName, simulatedArm, SO101Follower, SO101Hardware } from "../../src/so101/hardware/index";
import { SO101Kinematics } from "../../src/so101/kinematics/index";

export interface ExpectedInput {
  /** The calibration the servos hold, by motor. */
  calibration: Record<string, MotorCalibration>;
  /** Present_Position of each servo, steps: one entry for each pose. */
  poses: Array<Record<string, number>>;
}

export interface ExpectedPose {
  /** PEAR's joint vector: the five joints in rad, then the gripper's opening. */
  joints: number[];
  /** The state a model is shown, rounded as PEAR rounds it. */
  state: { x: number; y: number; z: number; pitch: number; roll: number; width: number };
  /** The text of the turn a model is sent. */
  turnText: string;
}

export interface ExpectedOutput {
  poses: ExpectedPose[];
  lowerBounds: number[];
  upperBounds: number[];
  feedbackTolerance: number;
  decimals: Record<string, number>;
}

export async function main(input: ExpectedInput): Promise<ExpectedOutput> {
  const kinematics = new SO101Kinematics();
  const poses: ExpectedPose[] = [];
  for (const steps of input.poses) {
    const chain = simulatedArm(input.calibration, steps as Partial<Record<MotorName, number>>);
    const follower = new SO101Follower(chain, input.calibration);
    await follower.bus.connect(false);
    const values = await follower.bus.syncRead("Present_Position");
    const joints = SO101Hardware.busPosition(values, MOTORS.slice(0, -1).map(() => 0));
    const state = kinematics.quantities(joints);
    poses.push({
      joints,
      state: { ...state.arm, width: state.gripper.width },
      turnText: SINGLE_ARM_POSE_FORMAT.turnText(state, null),
    });
  }

  return {
    poses,
    lowerBounds: [...kinematics.limits.lowerBounds],
    upperBounds: [...kinematics.limits.upperBounds],
    feedbackTolerance: kinematics.limits.feedbackTolerance,
    decimals: { ...SO101Kinematics.DECIMALS },
  };
}
