// What the agent loop needs of a robot, under PEAR's names in camelCase and nothing more:
//   pear/deploy/station/control/robot.py    BaseRobot (the methods and attributes StationAgentLoop uses), ActionMode
//   pear/deploy/station/control/schemas.py  Observation, ActionFormat, Camera, ActionPhase; ControlSnapshot,
//                                           DetailedStatus and BriefStatus as values the loop only passes on
//   pear/deploy/station/control/motion/results.py  MotionResult.to_record
//
// The station module satisfies it with the real robot. A call that reaches the arm is asynchronous in pear.js, so
// each method may return its value or a promise of it. An observation's images are JPEG bytes here: a page encodes
// a camera frame before the loop sees it (PEAR's are RGB arrays, which it saves as JPEG files itself).

import type { ModelState, MotionResult, MotionStatus, SingleArmDelta } from "../protocol/types";
import type { EventData } from "./clients/schemas";

/** A value, or a promise of it. */
export type Awaitable<T> = T | Promise<T>;

/** Which actions a robot takes. */
export const ActionMode = {
  /** Every action of the robot, as a model's session gives them. */
  CARTESIAN: "cartesian",
  /** Chunks of joint targets alone, as maintenance gives them. */
  JOINT: "joint",
} as const;
export type ActionMode = (typeof ActionMode)[keyof typeof ActionMode];

/** What a robot is doing with an action, in the words its progress reports. */
export const ActionPhase = {
  PLANNING: "Planning",
  EXECUTING: "Executing",
  /** The action's motion is over and the arms come to rest. */
  SETTLING: "Settling",
} as const;
export type ActionPhase = (typeof ActionPhase)[keyof typeof ActionPhase];

/** One camera of a robot. */
export interface Camera {
  /** Key in observations, previews and recordings. */
  readonly role: string;
  /** What the model and saved files call it. */
  readonly name: string;
  /** Shown in the browser. */
  readonly label: string;
}

/** A control loop's snapshot or a robot's status, as observations and results carry it: the loop passes it on and
 * never reads it. */
export type ControlSnapshot = Readonly<Record<string, unknown>>;

/** When a camera's frame arrived: the frame's fields but its image. */
export interface CameraTimestamps {
  readonly receivedMonotonicS: number;
  readonly frameNumber?: number;
}

/** One sample of a robot's session: measured joints, camera frames and the control snapshot. */
export interface Observation {
  readonly observationId: string;
  readonly sessionId: string;
  readonly capturedMonotonicS: number;
  /** The measured joint vector. */
  readonly jointPositions: readonly number[];
  /** Per camera role, the frame as JPEG bytes. */
  readonly images: Readonly<Record<string, Uint8Array>>;
  /** Per camera role. */
  readonly cameraTimestamps: Readonly<Record<string, CameraTimestamps>>;
  readonly controlSnapshot: ControlSnapshot;
}

/**
 * One format of the state a model reads and the action it writes, as the agent loop uses it. PEAR's ActionFormat
 * holds the schema, the decimals and the action's model; here the format gives the three functions PEAR makes of
 * them (src/protocol has those of the SO-101's format).
 */
export interface ActionFormat<State = ModelState, Action = SingleArmDelta> {
  readonly name: string;
  /** The cameras whose frames the model sees, in order. */
  readonly cameras: readonly Camera[];
  /** The text of a turn: the state as the model reads it, and the report of the previous action
   * (ObservationMessage.build). */
  turnText(state: State, feedback: string | null): string;
  /** The action of a complete final answer; throws for an answer that gives none (ActionParser.parse). */
  parseAction(answer: string): Action;
  /** (result, isDispatched) -> the text for the next turn, or null. */
  resultFeedback(result: MotionResult | null, options: { isDispatched: boolean }): string | null;
}

/** What the agent loop uses of a robot's session (BaseRobot). */
export interface AgentRobot<State = ModelState, Action = SingleArmDelta> {
  /** Which actions the robot takes: a model's session needs ActionMode.CARTESIAN. */
  readonly actionMode: string;
  /** The identity of the open session; null while closed. */
  readonly sessionId: string | null;
  /** The control period of the open or the next session, s. */
  readonly controlPeriodS: number;
  /** What the last failed action's error recorded. */
  readonly lastErrorDiagnostics: EventData | null;

  /** Waits, outside an action, for a settled HOLD, of the operation of ``observation`` if one is given, and
   * returns its snapshot; a stop, a fault or another operation ends the wait with an error. */
  waitStationary(
    observation?: Observation | null,
    options?: { cancellation?: AbortSignal | null },
  ): Awaitable<ControlSnapshot>;

  /** Returns the measured joints, the cameras' frames and the control snapshot as one observation. */
  observe(): Awaitable<Observation>;

  /** Returns what the model reads of the measured ``jointPositions`` in the action format ``formatName``. */
  modelState(jointPositions: readonly number[], formatName: string): Awaitable<State>;

  /** Whether the arms still hold the operation of ``observation`` and have settled; throws once they no longer
   * hold it. */
  isHolding(observation: Observation): Awaitable<boolean>;

  /** Brakes any operation into a HOLD. */
  stop(): Awaitable<void>;

  /** Runs one action from a settled HOLD at ``referenceObservation`` and returns its result, which an action that
   * did not complete has too. */
  execute(
    action: Action,
    options: {
      referenceObservation?: Observation | null;
      cancellation?: AbortSignal | null;
      reportProgress?: ((phase: ActionPhase) => void) | null;
    },
  ): Awaitable<MotionResult>;

  /** Returns the result of an action of the format ``formatName`` that did not complete, measured at ``snapshot``
   * (by default now): its error is {code: the Python class name of ``error``, message} (see motionErrorOf). */
  failureResult(
    error: unknown,
    options: { formatName: string; status?: MotionStatus; snapshot?: ControlSnapshot | null },
  ): Awaitable<MotionResult>;
}

/** Returns the result as a task's records and the page keep it, under their keys (MotionResult.to_record). */
export function resultRecord(result: MotionResult): EventData {
  return {
    status: result.status,
    settled: result.isSettled,
    reached: result.targetReached,
    measured_position: result.measuredPosition,
    tracking_error: result.trackingError,
    measured_state: result.measuredState,
    gripper_outcome: result.gripperOutcome,
    error: result.error,
  };
}
