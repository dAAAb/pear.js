// The SO-101's servos as this directory needs them. The joints' names and order are the layout's
// (src/so101/layout.ts, from pear/deploy/station/control/robots/so101/layout.py); the servos' ids and the units they
// are read in are those of lerobot 0.6.1's SO follower (lerobot/robots/so_follower/so_follower.py).

import type { Motor } from "../../feetech/bus";
import { GRIPPER_INDEX, JOINTS, MOTORS, VECTOR_LENGTH, type MotorName } from "../layout";

export { GRIPPER_INDEX, JOINTS, MOTORS, VECTOR_LENGTH, type MotorName };

/** Returns the follower's servos: ids 1 to 6 from the base; the joints read in degrees (or, as older lerobot
 * datasets have them, from -100 to 100), the gripper from 0 to 100. */
export function followerMotors(useDegrees = true): Record<MotorName, Motor> {
  const normMode = useDegrees ? "degrees" : "range_m100_100";

  return {
    shoulder_pan: { id: 1, normMode },
    shoulder_lift: { id: 2, normMode },
    elbow_flex: { id: 3, normMode },
    wrist_flex: { id: 4, normMode },
    wrist_roll: { id: 5, normMode },
    gripper: { id: 6, normMode: "range_0_100" },
  };
}
