// Ports the text of ObservationMessage.build of pear/deploy/station/agent_loop/messages.py and
// JsonBlockProtocol.turn_text of pear/agent_loop/protocol.py, for the SO-101's single_arm_pose format and its one
// camera. (The camera frame itself is the station's to capture and send.)

import { pythonRound } from "./python_float";
import { pythonJsonDumps } from "./python_json";
import { ARM_QUANTITIES, DECIMALS, type ModelState } from "./types";

/** What follows the state in every turn of a format with one camera (PEAR writes "frames follow" for several). */
export const TURN_REMINDER =
  "The current camera frame follows. End your response with one json block containing the next action.";

/** What introduces the report of the previous action. */
export const FEEDBACK_PREFIX = "Previous execution: ";

/** Returns ``value`` as an observation shows it: rounded as Python rounds to ``decimals`` places, and never -0. */
export function shownQuantity(value: number, decimals: number): number {
  if (!Number.isFinite(value)) {
    // PEAR's state model (StrictModel, allow_inf_nan=False) refuses such a state before any text is made of it
    throw new RangeError("A state's quantities must be finite numbers");
  }

  return pythonRound(value, decimals) + 0; // + 0 makes a quantity rounded to -0 read 0.0
}

/** Returns the state as a turn shows it: every quantity rounded to its decimals, in the order the model reads. */
export function shownState(state: ModelState): ModelState {
  const [x, y, z, pitch, roll] = ARM_QUANTITIES.map((name) => shownQuantity(state.arm[name], DECIMALS[name])) as [
    number,
    number,
    number,
    number,
    number,
  ];

  return { arm: { x, y, z, pitch, roll }, gripper: { width: shownQuantity(state.gripper.width, DECIMALS.width) } };
}

/**
 * Returns the text of a user turn: the measured state as JSON, the reminder, and the report of the previous action
 * when there is one (``feedback``, from executionFeedback; none on the first turn).
 */
export function turnText(state: ModelState, feedback?: string | null): string {
  const shown = shownState(state);
  let text = `${pythonJsonDumps({ arm: { ...shown.arm }, gripper: { ...shown.gripper } })}\n\n${TURN_REMINDER}`;
  if (feedback) {
    text += `\n\n${FEEDBACK_PREFIX}${feedback}`;
  }

  return text;
}
