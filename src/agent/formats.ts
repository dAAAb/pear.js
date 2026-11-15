// SINGLE_ARM_POSE_FORMAT of pear/deploy/station/control/robots/so101/formats.py as the agent loop uses a format:
// the SO-101's one action format, with the functions of src/protocol. It is defined once, in the port of that
// file (src/so101/formats.ts), and given here under the agent's path; its camera is WristCamera.CAMERA of
// pear/deploy/station/control/robots/so101/hardware/cameras.py (src/so101/hardware/cameras.ts).

import type { ModelState, SingleArmDelta } from "../protocol/types";
import { SINGLE_ARM_POSE_FORMAT as STATION_FORMAT } from "../so101/formats";
import type { ActionFormat } from "./robot";

export { WRIST_CAMERA } from "../so101/formats";

/** The SO-101's one action format: the arm's pose and the gripper's width, as the model reads them and changes
 * them. */
export const SINGLE_ARM_POSE_FORMAT: ActionFormat<ModelState, SingleArmDelta> = STATION_FORMAT;
