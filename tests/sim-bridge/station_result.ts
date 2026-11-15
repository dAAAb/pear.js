// Not in PEAR: the types of the scripted station sessions (station_session.json, which make_station_session.py
// writes and explains) and of one run of them, a StationRunResult. The reference runner (outside this repository)
// runs the sessions with PEAR's own SO101Robot on a simulated SO-101 servo chain and writes a StationRunResult; a
// runner of pear.js's station writes one of the same form, and compare_station.ts compares the two.
// docs/progress/station-reference.md describes the reference and the stepping rule a runner must reproduce.

export const STATION_SESSION_FORMAT = "pear.js-sim-bridge-station-session/1";
export const STATION_RESULT_FORMAT = "pear.js-sim-bridge-station-result/1";

/** One packet of the recorded traffic: ["h", hex] is an instruction packet of the host, ["s", hex] a status packet
 * of a servo. */
export type Packet = [direction: "h" | "s", hex: string];

/** A JSON value: what a result holds where PEAR's own records decide the shape (a control snapshot, a Home
 * report). */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// ---- the session file ----

/** The station's settings both runners use: PEAR's ControlConfig and the fields of its SO101Config that are not a
 * machine's own (no device, no calibration file, no camera, no path). */
export interface StationSettings {
  control: {
    rate_hz: number;
    state_timeout_s: number;
    deadline_tolerance_s: number;
    settle_timeout_s: number;
    settle_window_s: number;
    action_timeout_s: number;
  };
  robot: {
    hardware: { joint_offsets: number[]; status_poll_ticks: number; position_p_coefficient: number };
    geometry: {
      max_rotation_rad: number;
      position_residual_m: number;
      rotation_residual_rad: number;
      ik_iterations: number;
      gripper_width_cm: number[];
    };
    limits: {
      velocity: number[];
      acceleration: number[];
      jerk: number[];
      lower_bounds: number[];
      upper_bounds: number[];
      tracking_error: number[];
      stop_acceleration: number[] | null;
      stop_jerk: number[] | null;
    };
    home: {
      speed_scale: number;
      limits: { velocity: number[]; acceleration: number[]; jerk: number[] } | null;
      settle_window_s: number;
      arrival_timeout_s: number;
      position: number[];
      joint_tolerance: number[];
    } | null;
    feedforward: {
      gravity_compliance: number[];
      friction_offset_rad: number[];
      friction_load_ratio: number[];
    } | null;
    position_tolerance: number;
    gripper_tolerance: number;
    feedback_position_tolerance: number;
    velocity_tolerance: number;
  };
  /** The one action format of the sessions: "single_arm_pose". */
  action_format: string;
}

/** An action of the SO-101's format, as a model's json block gives it: increments of the fingertip's x, y, z (cm)
 * and of its pitch and roll (rad), and the gripper's command (positive opens, negative closes, zero holds). */
export interface ModelAction {
  arm: { x: number; y: number; z: number; pitch: number; roll: number };
  gripper: { width: number };
}

/** An action of the robot outside the model's format, given with its type. */
export type RobotAction =
  | { type: "gripper"; command: "open" | "close" }
  | { type: "joint_positions"; positions: number[][]; rate_hz: number };

/** What happens after a step's Nth control period, where another thread of a station would act. */
export interface TickEvent {
  tick: number;
  /** "pause": the console's pause (the cancellation is set, then robot.stop()); "inject": a fault on the chain. */
  do: "pause" | "inject";
  faults?: Record<string, Json>;
}

/** The error a failure_result step gives the robot: one PEAR's turn loop or console makes, by its Python class
 * and its message, or the error of the last step that raised one. */
export type StepError = { type: string; message: string } | { from: "last_error" };

export type StationOp =
  | "reset"
  | "open"
  | "close"
  | "wait_stationary"
  | "observe"
  | "model_state"
  | "hold"
  | "parse"
  | "execute"
  | "failure_result"
  | "status"
  | "check_fault"
  | "stop"
  | "pause"
  | "new_cancellation"
  | "wait_settled"
  | "recover"
  | "home"
  | "idle"
  | "inject"
  | "place";

/** One step of a session: one call of the robot, or one thing the test does. make_station_session.py says what
 * each op is and which fields it reads. */
export interface StationStep {
  /** The step's number in its session, three digits; with the op it labels the step's segment of the traffic. */
  id: string;
  op: StationOp;
  /** The model turn the step belongs to. */
  turn?: number;
  /** What the step is for, in words. */
  about?: string;
  /** wait_stationary: whether it waits for the hold of the last observation. */
  observation?: boolean;
  /** hold, idle: control periods. */
  ticks?: number;
  /** execute: a model's final answer (then ``action`` is what its json block holds); parse: the answer. */
  answer?: string;
  action?: ModelAction | RobotAction;
  at_tick?: TickEvent[];
  /** failure_result. */
  error?: StepError;
  status?: "failed" | "rejected";
  dispatched?: boolean;
  /** failure_result: "status": measured at the last status read. */
  snapshot?: "status";
  /** status. */
  with_snapshot?: boolean;
  /** wait_settled. */
  timeout_s?: number;
  /** home. */
  review_ticks?: number;
  approve?: boolean;
  /** inject. */
  faults?: Record<string, Json>;
  /** place. */
  object?: string;
  position_m?: number[];
}

export interface StationSession {
  name: string;
  about: string;
  /** Whether a result of the session also says where the scene's objects are. */
  objects?: boolean;
  steps: StationStep[];
}

export interface StationSessionDocument {
  format: string;
  about: string;
  station: StationSettings;
  sessions: StationSession[];
}

// ---- a run's result ----

/** What the model reads of the measured joints (ModelState): the fingertip's pose and the gripper's width. */
export interface ModelStateRecord {
  arm: { x: number; y: number; z: number; pitch: number; roll: number };
  gripper: { width: number };
}

/** An action's result exactly as PEAR records it (MotionResult.to_record). */
export interface MotionRecord {
  status: "completed" | "rejected" | "failed";
  settled: boolean;
  reached: boolean;
  measured_position: number[] | null;
  tracking_error: number[] | null;
  measured_state: ModelStateRecord | null;
  gripper_outcome: string | null;
  /** ``code`` is the Python class name of the error that ended the action. */
  error: { code: string; message: string } | null;
}

/** What a step raised: the Python class name of the error, its message and, if the error carries them, its
 * details (a HomeFailed's, a StabilityError's). */
export interface RaisedRecord {
  type: string;
  message: string;
  details?: Json;
}

/** observe: the observation without its two random ids and without its frames, which are a runner's own. */
export interface ObservedRecord {
  captured_monotonic_s: number;
  joint_positions: number[];
  /** The roles of the cameras whose frames the observation holds, sorted. */
  images: string[];
  /** Per camera role, when the frame arrived on the station's clock. */
  camera_timestamps: Record<string, { received_monotonic_s: number }>;
  control_snapshot: Json;
}

/** model_state: the state, and the whole text of the turn it makes with the report of the last result. */
export interface TurnRecord {
  state: ModelStateRecord;
  text: string;
}

/** hold: what each robot.is_holding answered. */
export interface HoldRecord {
  holding: boolean[];
}

/** failure_result: the result and its report, the text the next turn tells the model. */
export interface RecordedResult {
  result: MotionRecord;
  feedback: string;
}

/** execute: also the phases the action reported and the diagnostics of its error (robot.last_error_diagnostics). */
export interface ExecutedRecord extends RecordedResult {
  progress: string[];
  diagnostics: Json;
}

/** home: PEAR's Home report, the stages it reported, and the plan the operator reviewed. */
export interface HomeRecord {
  report: Json;
  progress: Json[];
  reviewed: Json[];
}

/** What a step returned, by its op. wait_stationary, wait_settled and recover return a control snapshot, status
 * the robot's status, parse the action; the others null. */
export type Returned = ObservedRecord | TurnRecord | HoldRecord | RecordedResult | ExecutedRecord | HomeRecord | Json;

/** Where the simulated arm truly is at the end of a step: the chain's own state, not the station's reading. */
export interface WorldRecord {
  time_s: number;
  joints_rad: Record<string, number>;
  gripper_opening: number;
  /** In a session with ``objects``: the fixed fingertip, the middle between the fingers, each object's pose. */
  fingertip_m?: number[];
  grasp_m?: number[];
  objects?: Record<string, { position_m: number[]; quat: number[] }>;
}

/** What one step did. A reset has only its id and its op. */
export interface StationStepRecord {
  id: string;
  op: string;
  turn?: number;
  about?: string;
  /** Exactly one of the two, for every step but a reset. */
  returned?: Returned;
  raised?: RaisedRecord;
  /** How long the step took on the wall clock, ms. Belongs to the run: never compared. */
  wall_ms?: number;
  /** The station's clock at the step's start and at its end, s. */
  clock_s?: [number, number];
  /** Steps of the control loop during the step. */
  ticks?: number;
  /** Waits of the caller during the step, each of which steps an attached loop once; a start-up waits without a
   * loop. Null in a run that is not stepped. */
  sleeps?: number | null;
  /** The control loop's state after each of its steps, run-length encoded: HOLD, "HOLD unsettled", RUNNING,
   * "RUNNING settling", STOPPING, "STOPPING settling", FAULT, "FAULT: <recovery phase>". */
  phases?: [name: string, count: number][] | null;
  /** The robot's status with its control snapshot at the step's end (robot.status(with_snapshot=True)); null
   * before a robot is made. */
  status?: Json;
  /** The joint vector the arm heads for at the step's end (the control loop's requested_position). */
  requested?: number[] | null;
  world?: WorldRecord;
  /** PEAR's warnings and errors logged during the step: level, logger, message. */
  log?: [level: string, logger: string, message: string][];
  /** The packets that crossed the line during the step, in order: the step's segment of the chain's record. */
  packets?: Packet[];
}

export interface StationSessionResult {
  name: string;
  steps: StationStepRecord[];
  /** The chain's counters at the session's end: instruction packets by kind, packets that got no answer and why,
   * bytes that were part of no packet. */
  line: {
    instructions: Record<string, number>;
    unanswered: Record<string, number>;
    corrupt_packets: number;
    dropped_bytes: number;
    errors: string[];
  };
  /** Set when the runner had to close a robot the session left open. */
  note?: string;
  /** Belongs to the run: never compared. */
  wall_s?: number;
}

export interface StationRunResult {
  format: string;
  /** "pear-python" or "pear.js": never compared. */
  side: string;
  /** "stepped": the station's clock is a stand-in that each wait advances, and each wait steps the loop once;
   * "realtime": the wall clock and a loop of its own pace. Only stepped runs are comparable bit for bit. */
  clock: "stepped" | "realtime";
  session_sha256: string;
  station: StationSettings;
  bridge: {
    clock: string;
    steps_per_packet: number | null;
    steps_per_position_read: number | null;
    timestep_s: number;
  };
  calibration: Record<string, Record<string, number>>;
  sessions: StationSessionResult[];
  /** What belongs to this run alone (versions, the name of its line, wall times): never compared. */
  run: Record<string, Json>;
}
