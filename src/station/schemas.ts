// Ports pear/deploy/station/control/schemas.py.
//
// What PEAR passes around as a dictionary (a snapshot, a status, an observation) keeps PEAR's keys, because it is
// recorded and shown as it is. An enumeration is the object of its words, as in src/protocol/types.ts.

/** What a robot reports of itself: closed, a settled hold ready for an action, busy, or a latched fault. */
export const RobotStatus = {
  OFF: "OFF",
  READY: "READY",
  BUSY: "BUSY",
  FAULT: "FAULT",
} as const;
export type RobotStatus = (typeof RobotStatus)[keyof typeof RobotStatus];

/** The state of the control loop under a robot. */
export const ControlState = {
  HOLD: "HOLD",
  RUNNING: "RUNNING",
  STOPPING: "STOPPING",
  FAULT: "FAULT",
  CLOSED: "CLOSED",
} as const;
export type ControlState = (typeof ControlState)[keyof typeof ControlState];

/** The states in which the arms follow an operation. */
export const MOVING_CONTROL_STATES: readonly ControlState[] = [ControlState.RUNNING, ControlState.STOPPING];

/** How the last operation of a control loop ended, each by the word a snapshot's motion names it with. */
export const MotionEndReason = {
  /** No operation ran yet: the hold that enabling took. */
  INITIAL_HOLD: "initial_hold",
  FINISHED: "finished",
  STOPPED: "stopped",
  /** The operator's pause. */
  CANCELLED: "cancelled",
  ACTION_TIMEOUT: "action_timeout",
  /** A sequence that fell behind its own rate. */
  SEQUENCE_DEADLINE: "sequence_deadline",
  FAULT: "fault",
  RECOVERED: "recovered",
} as const;
export type MotionEndReason = (typeof MotionEndReason)[keyof typeof MotionEndReason];

/** What a fault recovery is doing, in the words the page shows. */
export const RecoveryPhase = {
  CHECKING_STABILITY: "Checking stability",
  RELEASING_TARGET: "Releasing old target",
  VERIFYING_HOLD: "Verifying new hold",
} as const;
export type RecoveryPhase = (typeof RecoveryPhase)[keyof typeof RecoveryPhase];

/** What a robot is doing with an action, in the words its progress reports. */
export const ActionPhase = {
  PLANNING: "Planning",
  EXECUTING: "Executing",
  /** The action's motion is over and the arms come to rest. */
  SETTLING: "Settling",
} as const;
export type ActionPhase = (typeof ActionPhase)[keyof typeof ActionPhase];

/** One camera image and when it arrived; `Image` is what the station's cameras give (PEAR: an RGB array). */
export interface CameraFrame<Image = unknown> {
  rgb: Image;
  received_monotonic_s: number;
  frame_number: number;
}

/** What identifies the raw feedback batch of a reading, so that a repeated batch adds nothing. */
export type SampleId = number | string | null;

/** One arm's latest measurement, as a snapshot carries it; a robot adds its own telemetry. */
export interface ArmFeedback {
  position: readonly number[];
  velocity: readonly number[];
  sampled_monotonic_s: number;
  sample_id: SampleId;
  age_seconds: number;
}

/** Whether the arms reached what the operation requested and have settled there. */
export interface Arrival {
  settled: boolean;
  reached: boolean;
  signed_error: number[];
  tolerance: number[];
}

/** How the last operation ended and whether it is settling; a robot's driver adds its telemetry. */
export interface Motion {
  /** The word of a MotionEndReason or a robot's own; null while an operation runs. */
  end_reason: string | null;
  settling: boolean;
  [telemetry: string]: unknown;
}

/** A fault recovery in progress. */
export interface RecoveryProgress {
  /** The word of a RecoveryPhase. */
  phase: string;
  metrics: Record<string, unknown>;
}

/** The control state of a robot's arms at one instant. */
export interface SnapshotFields {
  captured_monotonic_s: number;
  fault: string | null;
  fault_details: Record<string, unknown> | null;
  /** Advances with every operation, stop and fault. */
  generation: number;
  /** Per arm. */
  targets: Record<string, readonly number[]>;
  arms: Record<string, ArmFeedback>;
  arrival: Arrival;
  /** The stability window's metrics. */
  settling: Record<string, unknown>;
  recovery: RecoveryProgress | null;
  motion: Motion;
}

/** A control loop's snapshot, as observations and results carry it. */
export interface ControlSnapshot extends SnapshotFields {
  /** The word of a ControlState. */
  status: string;
}

/** A robot's status with its control snapshot. */
export interface DetailedStatus extends SnapshotFields {
  /** The word of a RobotStatus. */
  status: string;
  /** The word of a ControlState. */
  control_state: string;
}

/** A robot's status; only `status` while it is closed. */
export interface BriefStatus {
  /** The word of a RobotStatus. */
  status: string;
  settled?: boolean;
  reached?: boolean;
  fault?: string | null;
}

/** One sample of a robot's session: measured joints, camera frames and the control snapshot. */
export interface Observation<Image = unknown> {
  observation_id: string;
  session_id: string;
  captured_monotonic_s: number;
  /** The measured joint vector. */
  joint_positions: readonly number[];
  /** Per camera role. */
  images: Record<string, Image>;
  /** Per camera role, the frame's fields but its image. */
  camera_timestamps: Record<string, Record<string, unknown>>;
  control_snapshot: ControlSnapshot;
}

/** A checked Home plan that an operator reviews before anything moves; a robot adds its own fields. */
export interface HomePlan {
  /** How long Home takes once approved, s. */
  operation_seconds_estimate: number;
  [field: string]: unknown;
}

/** What a completed Home did and how close each joint ended to its Home target. */
export interface HomeReport {
  plan: HomePlan;
  before: ControlSnapshot;
  /** The completed stages in order, each with its stage name and snapshot after it. */
  phases: Record<string, unknown>[];
  after: ControlSnapshot;
  /** Per-joint accuracy over the final stability window. */
  results: Record<string, unknown>;
}

/** One camera of a robot. */
export interface Camera {
  /** Key in observations, previews and recordings. */
  readonly role: string;
  /** What the model and saved files call it. */
  readonly name: string;
  /** Shown in the browser. */
  readonly label: string;
}

/** One format of the state a model reads and the action it writes. */
export interface ActionFormat<Action = unknown, Result = unknown> {
  readonly name: string;
  /** The parts and the quantities an action sets, in the order the model reads. */
  readonly schema: Readonly<Record<string, readonly string[]>>;
  /** The cameras whose frames the model sees, in order. */
  readonly cameras: readonly Camera[];
  /** The ENVIRONMENT section of the system prompt; empty: no section. */
  readonly environmentPrompt: string;
  /** Rounding of each quantity in observations. */
  readonly decimals: Readonly<Record<string, number>>;
  /** Reads one parsed action, and throws if it is not one of this format (PEAR: the model class of an action). */
  readonly actionModel: (action: unknown) => Action;
  /** Returns the text for the next turn of what the action did, or null. */
  readonly resultFeedback: (result: Result | null, options: { isDispatched: boolean }) => string | null;
}
