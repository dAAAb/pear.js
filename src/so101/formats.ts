// Ports pear/deploy/station/control/robots/so101/formats.py: SingleArmPoseFormat and SINGLE_ARM_POSE_FORMAT.
//
// This file is the home of SINGLE_ARM_POSE_FORMAT; src/agent/formats.ts gives the same object under its path. The
// texts of the format are src/protocol's (each compared with PEAR's own there): the report of a result
// (executionFeedback is PEAR's SingleArmPoseFormat.result_feedback), the environment prompt, and the two functions
// PEAR's turn loop makes of a format's schema, decimals and action model, which the format here carries with it.

import { parseAction } from "../protocol/action_parser";
import { executionFeedback } from "../protocol/feedback";
import { ENVIRONMENT_PROMPT } from "../protocol/system_prompt";
import { turnText } from "../protocol/turn_text";
import type { ModelState } from "../protocol/types";
import type { MotionResultFields } from "../station/motion/results";
import type { ActionFormat } from "../station/schemas";
import { WRIST_CAMERA, WristCamera } from "./hardware/cameras";
import { SO101Kinematics } from "./kinematics/kinematics";
import { SingleArmDelta } from "./motion/actions";

export { WRIST_CAMERA };

/** What the model is told of an action's result in the SO-101's single-arm pose format. */
export const SingleArmPoseFormat = {
  /** Returns the sentence the model is given of the previous action's `result`: its actual outcome. */
  resultFeedback(result: MotionResultFields | null, options: { isDispatched: boolean }): string {
    return executionFeedback(result as Parameters<typeof executionFeedback>[0], options);
  },
} as const;

/** The station's format of the SO-101 with what PEAR's turn loop makes of it. */
export interface SingleArmPoseActionFormat extends ActionFormat<SingleArmDelta, MotionResultFields> {
  /** The text of a turn: the state as the model reads it, and the report of the previous action. */
  turnText(state: ModelState, feedback?: string | null): string;
  /** The action of a complete final answer; throws for an answer that gives none. */
  parseAction(answer: string): SingleArmDelta;
  readonly resultFeedback: (result: MotionResultFields | null, options: { isDispatched: boolean }) => string;
}

/**
 * The SO-101's one action format: the arm's pose and the gripper's width, as the model reads them and changes them.
 */
export const SINGLE_ARM_POSE_FORMAT: SingleArmPoseActionFormat = {
  name: "single_arm_pose",
  schema: { arm: SO101Kinematics.ARM_QUANTITIES, gripper: ["width"] },
  cameras: [WristCamera.CAMERA],
  environmentPrompt: ENVIRONMENT_PROMPT,
  decimals: SO101Kinematics.DECIMALS,
  actionModel: (action) => SingleArmDelta.modelValidate(action),
  resultFeedback: SingleArmPoseFormat.resultFeedback,
  turnText,
  parseAction,
};
