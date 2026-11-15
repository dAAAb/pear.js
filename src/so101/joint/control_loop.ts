// Ports pear/deploy/station/control/robots/so101/joint/control_loop.py.

import type { ArmState } from "../../station/joint/arm_state";
import { Braking, JointControlLoop } from "../../station/joint/control_loop";
import { MeasuredHoldRecovery } from "../../station/joint/recovery";
import { SO101GripperOperation } from "./grippers";

/**
 * The SO-101's control loop: servos with feedforward goal offsets, a jaw judged where it stops, and the measured pose
 * held after a fault.
 */
export class SO101ControlLoop<State extends ArmState = ArmState> extends JointControlLoop<State> {
  /** The jaw, which no force sensing tells on an object. */
  static override readonly GRIPPER_OPERATION_CLASS = SO101GripperOperation;
  /** The stiff position servos keep pushing toward an old target. */
  static override readonly RECOVERY_POLICY_CLASS = MeasuredHoldRecovery;
  /** A STOP brakes with the arm's STOP caps. */
  static override readonly BRAKING = Braking.STATION_LIMITS;
  /** A recovery's window bounds the mean velocity alone. */
  static override readonly CHECKS_VELOCITY_RMS = false;

  /** Starts the jaw's operation: opening if `opensGripper`, else closing (the request of PEAR's `begin_grippers`). */
  override beginGrippers(opensGripper: boolean): SO101GripperOperation {
    return super.beginGrippers(opensGripper) as SO101GripperOperation;
  }
}
