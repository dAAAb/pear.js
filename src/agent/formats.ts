// Ports SINGLE_ARM_POSE_FORMAT of pear/deploy/station/control/robots/so101/formats.py as the agent loop uses a
// format: the SO-101's one action format, made of the functions of src/protocol. Its camera is WristCamera.CAMERA
// of pear/deploy/station/control/robots/so101/hardware/cameras.py.

import { parseAction } from "../protocol/action_parser";
import { executionFeedback } from "../protocol/feedback";
import { turnText } from "../protocol/turn_text";
import { FORMAT_NAME, type ModelState, type SingleArmDelta } from "../protocol/types";
import type { ActionFormat, Camera } from "./robot";

/** The SO-101's one camera, whose role keys its frames. */
export const WRIST_CAMERA: Camera = { role: "wrist", name: "wrist", label: "Wrist Camera" };

/** The SO-101's one action format: the arm's pose and the gripper's width, as the model reads them and changes
 * them. */
export const SINGLE_ARM_POSE_FORMAT: ActionFormat<ModelState, SingleArmDelta> = {
  name: FORMAT_NAME,
  cameras: [WRIST_CAMERA],
  turnText,
  parseAction,
  resultFeedback: (result, options) => executionFeedback(result, options),
};
