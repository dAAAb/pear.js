// Ports pear/deploy/station/gui/console/phase.py: Phase, STOPPED_STATUSES and Phase.idle_for.
//
// PEAR's Phase is a StrEnum; here it is an object of the same words, as the port's other enums are. Its classmethod
// Phase.idle_for is the function idleFor, and Phase(word), the member a word names, is phaseOf.
//
// The phases of a turn are the words of the agent loop, the model's client and the robot, taken from where the port
// defines them. PEAR takes COMPLETED from CaptionPhase (pear/deploy/station/records/recording/captions.py), which
// pear.js does not port: that one word is written here.

import { ModelPhase } from "../agent/clients/schemas";
import { TurnPhase } from "../agent/schemas";
import { ValueError } from "../python/errors";
import { pythonRepr, pythonValueOf } from "../python/repr";
import { ActionPhase, RobotStatus } from "../station/schemas";

/** The robot's statuses in which a stop has ended. */
export const STOPPED_STATUSES: readonly RobotStatus[] = [RobotStatus.READY, RobotStatus.OFF];

/** What the console or one of its task's turns is doing, in the words the page shows. */
export const Phase = {
  DISABLED: "Disabled",
  ENABLING: "Enabling",
  HOLDING: "Holding",
  PAUSED: "Paused",
  STOPPING: "Stopping",
  STOPPED: "Stopped",
  FAULT: "Fault",
  RECOVERING_CONTROL: "Recovering control",
  RECONNECTING_CAMERAS: "Reconnecting cameras",
  CHECKING_HOME: "Checking home",
  CONFIRM_HOME: "Confirm home",
  OPENING_GRIPPERS: "Opening grippers",
  CHECKING_DIRECT_HOME: "Checking direct Home",
  HOMING: "Homing",
  HOME_COMPLETE: "Home complete",
  HOME_FAILED: "Home failed",
  // the phases of a turn, in the words the agent loop, the model's client, the robot and the recording use for them
  OBSERVING: TurnPhase.OBSERVING,
  THINKING: ModelPhase.THINKING,
  COMPACTING: ModelPhase.COMPACTING,
  PLANNING: ActionPhase.PLANNING,
  EXECUTING: ActionPhase.EXECUTING,
  SETTLING: ActionPhase.SETTLING,
  /** (PEAR: CaptionPhase.COMPLETED, the recording's word.) */
  COMPLETED: "Completed",
  REJECTED: "Rejected",
  FAILED: "Failed",
  INTERRUPTED: "Interrupted",
  CONTEXT_LIMIT: "Context limit",
} as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

const PHASE_WORDS: ReadonlySet<unknown> = new Set(Object.values(Phase));

/** Returns the phase ``word`` names (Phase(word)); throws Python's ValueError for a word that names none. */
export function phaseOf(word: unknown): Phase {
  if (!PHASE_WORDS.has(word)) {
    throw new ValueError(`${pythonRepr(pythonValueOf(word))} is not a valid Phase`);
  }

  return word as Phase;
}

/**
 * Returns the phase of a console with no running operation: a STOP latch first, then a paused task, then the
 * motors, which ``robotStatus``, the word of a RobotStatus, tells (Phase.idle_for).
 */
export function idleFor(robotStatus: string, options: { isLatched: boolean; hasTask: boolean }): Phase {
  if (options.isLatched) {
    return Phase.STOPPED;
  }
  if (options.hasTask) {
    return Phase.PAUSED;
  }

  return robotStatus === RobotStatus.READY ? Phase.HOLDING : Phase.DISABLED;
}
