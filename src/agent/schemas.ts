// Ports pear/deploy/station/agent_loop/schemas.py: the phase and the events the agent loop names itself.

import type { EventData, ModelEvent } from "./clients/schemas";

/** The phase of a turn the agent loop names itself, by the word the page shows (the model's phases are ModelPhase,
 * the robot's ActionPhase). */
export const TurnPhase = {
  /** The arms come to rest and are observed. */
  OBSERVING: "Observing",
} as const;
export type TurnPhase = (typeof TurnPhase)[keyof typeof TurnPhase];

/** What the agent loop reports of a turn besides its phases, each by the name its event has on the page and in a
 * task's events. */
export const TurnEvent = {
  /** What the model is shown. */
  OBSERVATION: "observation",
  /** The model's answer. */
  MODEL_OUTPUT: "model_output",
  /** The action read from the answer. */
  ACTION: "action",
  /** What the robot recorded of the error that ended an action. */
  DIAGNOSTIC: "diagnostic",
} as const;
export type TurnEvent = (typeof TurnEvent)[keyof typeof TurnEvent];

/** Takes one event of a turn, the model's or the agent loop's: its kind and its data. */
export type TurnEventHandler = (kind: ModelEvent | TurnEvent, data: EventData) => void;
