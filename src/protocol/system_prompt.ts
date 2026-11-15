// Ports SystemPrompt.render of pear/deploy/station/agent_loop/messages.py and JsonBlockProtocol.system_prompt of
// pear/agent_loop/protocol.py, for the SO-101's single_arm_pose format
// (pear/deploy/station/control/robots/so101/formats.py: its environment_prompt).

import { SINGLE_ARM_POSE_ENVIRONMENT, SYSTEM_PROMPT_TEMPLATE } from "./prompts";
import { pythonStrip } from "./python_text";

/** The ENVIRONMENT section's text: the format's prompt file without the whitespace around it. */
export const ENVIRONMENT_PROMPT = pythonStrip(SINGLE_ARM_POSE_ENVIRONMENT);

/** Returns the station's system prompt of the task ``instruction``: PEAR's template with the SO-101's facts as its
 * ENVIRONMENT section and the task as it is given, unchanged. */
export function systemPrompt(instruction: string): string {
  const section = ENVIRONMENT_PROMPT ? `## ENVIRONMENT\n\n${ENVIRONMENT_PROMPT}\n\n` : "";

  // Python's str.replace: every occurrence, the replacement taken literally (split and join; a replacement string
  // of String.replace would read $& and its like as patterns), and the task placed last, so that an instruction
  // that holds "{environment}" keeps it
  return SYSTEM_PROMPT_TEMPLATE.split("{environment}").join(section).split("{instruction}").join(instruction);
}
