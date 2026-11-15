// What the agent loop needs of a robot, under PEAR's names in camelCase and nothing more:
//   pear/deploy/station/control/robot.py    BaseRobot (the methods and attributes StationAgentLoop uses), ActionMode
//   pear/deploy/station/control/schemas.py  Observation, ActionFormat, Camera, ActionPhase; ControlSnapshot,
//                                           DetailedStatus and BriefStatus as values the loop only passes on
//   pear/deploy/station/control/motion/results.py  MotionResult.to_record
//
// The station module satisfies it with the real robot. A call that reaches the arm is asynchronous in pear.js, so
// each method may return its value or a promise of it. An observation's images are JPEG bytes here: a page encodes
// a camera frame before the loop sees it (PEAR's are RGB arrays, which it saves as JPEG files itself).
//
// pear/deploy/station/control/schemas.py is ported once, in src/station/schemas.ts. What this file gives of it is
// that definition: ActionPhase and Camera as they are, and the three the loop holds in another form as types made
// of the station's (the fields of its Observation under camelCase names; of its ActionFormat the name, the cameras
// and the result feedback; of its snapshot and statuses any field and none required).

import type { ModelState, MotionResult, MotionStatus, SingleArmDelta } from "../protocol/types";
import {
  ActionPhase,
  type ActionFormat as StationActionFormat,
  type BriefStatus,
  type Camera,
  type CameraFrame,
  type ControlSnapshot as StationControlSnapshot,
  type DetailedStatus,
  type Observation as StationObservation,
} from "../station/schemas";
import type { EventData } from "./clients/schemas";

export { ActionPhase };
export type { Camera };

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

/** A key of one of PEAR's dictionaries as the field of an object is named in pear.js: `observation_id` as
 * `observationId`. */
type CamelCase<Key extends string> = Key extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : Key;

/** One of PEAR's dictionaries as an object the loop holds: the same fields, each under its camelCase name. */
type CamelCased<Dictionary> = { readonly [Key in keyof Dictionary as CamelCase<Key & string>]: Dictionary[Key] };

/**
 * A control loop's snapshot or a robot's status, as observations and results carry it (the station's
 * ControlSnapshot, DetailedStatus and BriefStatus). The loop passes it on and never reads it, so any of their
 * fields may be there and none is required.
 */
export type ControlSnapshot = Readonly<Partial<StationControlSnapshot> & Partial<DetailedStatus> & Partial<BriefStatus>>;

/** When a camera's frame arrived: the frame's fields but its image (the station's CameraFrame without `rgb`). The
 * loop reads the arrival; a frame's number may be left out. */
export type CameraTimestamps = CamelCased<Pick<CameraFrame, "received_monotonic_s">> &
  Partial<CamelCased<Pick<CameraFrame, "frame_number">>>;

/**
 * One sample of a robot's session: measured joints, camera frames and the control snapshot. It is the station's
 * Observation as the loop holds it: `observationId`, `sessionId`, `capturedMonotonicS` and `jointPositions` (the
 * measured joint vector) are its fields under camelCase names; `images` holds, per camera role, the frame as JPEG
 * bytes; `cameraTimestamps`, per camera role, when the frame arrived; `controlSnapshot` is passed on unread.
 */
export type Observation = CamelCased<
  Omit<StationObservation<Uint8Array>, "images" | "camera_timestamps" | "control_snapshot">
> & {
  readonly images: Readonly<StationObservation<Uint8Array>["images"]>;
  readonly cameraTimestamps: Readonly<Record<string, CameraTimestamps>>;
  readonly controlSnapshot: ControlSnapshot;
};

/**
 * One format of the state a model reads and the action it writes, as the agent loop uses it: of the station's
 * ActionFormat its name, its cameras (those whose frames the model sees, in order) and its result feedback
 * ((result, isDispatched) -> the text for the next turn, or null). PEAR's ActionFormat also holds the schema, the
 * decimals and the action's model; here the format gives the two functions PEAR makes of them (src/protocol has
 * those of the SO-101's format).
 */
export interface ActionFormat<State = ModelState, Action = SingleArmDelta>
  extends Pick<StationActionFormat<Action, MotionResult>, "name" | "cameras" | "resultFeedback"> {
  /** The text of a turn: the state as the model reads it, and the report of the previous action
   * (ObservationMessage.build). */
  turnText(state: State, feedback: string | null): string;
  /** The action of a complete final answer; throws for an answer that gives none (ActionParser.parse). */
  parseAction(answer: string): Action;
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
