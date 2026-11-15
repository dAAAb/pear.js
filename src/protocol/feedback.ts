// Ports SingleArmPoseFormat.result_feedback of pear/deploy/station/control/robots/so101/formats.py: what the model
// is told of the previous action. PEAR's agent loop makes it of every result it records
// (pear/deploy/station/agent_loop/agent_loop.py, StationAgentLoop.record) and shows it in the next turn.

import { pythonJsonDumps, type PythonJsonInput } from "./python_json";
import { MotionStatus, UNREACHABLE_POSE_ERROR, type MotionResult } from "./types";

/** What the model is told when there is no result of the previous turn. */
export const INTERRUPTED_FEEDBACK = "The previous inference was interrupted; no action was executed. Observe again.";

const OBSERVE_AGAIN = " Use the new measured observation.";

/**
 * Returns the sentence the model is given of the previous action's ``result``: its actual outcome.
 * ``isDispatched`` is whether that action went to the robot (false when the answer gave no action).
 */
export function executionFeedback(result: MotionResult | null, options: { isDispatched: boolean }): string {
  if (result === null) {
    return INTERRUPTED_FEEDBACK;
  }

  if (result.status === MotionStatus.REJECTED && result.error?.code === UNREACHABLE_POSE_ERROR) {
    // the offline inverse kinematics reject the whole action before any arm or gripper command
    const value = {
      status: "rejected",
      moved: false,
      error: {
        code: "out_of_reach",
        message: `Nothing moved: the whole action was discarded (arm and gripper). ${result.error.message}`,
      },
    };
    return pythonJsonDumps(value) + OBSERVE_AGAIN;
  }

  const value: Record<string, PythonJsonInput> = {
    status: result.status,
    execution_requested: options.isDispatched,
    settled: result.isSettled,
    reached: result.targetReached,
  };
  if (result.error) {
    value.error = { code: result.error.code, message: result.error.message };
  }
  if (result.gripperOutcome) {
    value.gripper = result.gripperOutcome;
  }

  return pythonJsonDumps(value) + OBSERVE_AGAIN;
}
