// Ports the SO-101's defaults, pear/deploy/station/control/robots/so101/config.yaml (its `robot` node), and the
// shape of its settings, pear/deploy/station/control/robots/so101/config.py with the sections it inherits from
// pear/deploy/station/control/joint/config.py.
//
// The keys are PEAR's own, so that a station's file written for PEAR reads over these defaults unchanged. Joint
// values are rad in the calibrated frame; the gripper's is an opening, 0 closed and 1 open; every vector follows the
// order of MOTORS in layout.ts (a vector of five values: of JOINTS).
//
// The defaults describe a generic SO-101. What a real station must measure or choose itself is marked "station".

/** What PEAR's defaults leave for the station's own file to give (OmegaConf's marker of a missing value). */
export const MISSING = "???";

/** The arm's Feetech bus: its device, its lerobot calibration and the servos' settings. */
export interface HardwareConfig {
  /** The bus's serial device. */
  readonly port: string;
  /** The name of lerobot's calibration file in `calibration_dir`. */
  readonly calibration_id: string;
  /** Where the calibration file is; a relative directory is relative to the station's own file. */
  readonly calibration_dir: string;
  /** A software zero correction on top of lerobot's calibration, rad: the joint's angle is lerobot's reading plus it. */
  readonly joint_offsets: readonly number[];
  /** The control periods between two polls of the servos' Status. */
  readonly status_poll_ticks: number;
  /** The servos' position P gain. */
  readonly position_p_coefficient: number;
}

/** The wrist camera's device and the frames it is asked for. */
export interface CameraConfig {
  readonly path: string;
  /** The role its frames are keyed by: wrist, the format's one camera. */
  readonly role: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /** The pixel format the device is asked for; null: the device's own. */
  readonly fourcc: string | null;
}

/**
 * What the inverse kinematics solve on and how far they go. PEAR's `urdf` key is absent: pear.js reads no
 * description at run time (see kinematics/chain.ts).
 */
export interface KinematicsConfig {
  /** The fingertips' distance when the gripper is closed and when it is open, cm. */
  readonly gripper_width_cm: readonly number[];
  /** The largest pitch or roll increment an action may ask, rad. */
  readonly max_rotation_rad: number;
  /** The largest position error of a solution, m. */
  readonly position_residual_m: number;
  /** The largest orientation error of a solution, rad. */
  readonly rotation_residual_rad: number;
  /** The most steps one solve takes. */
  readonly ik_iterations: number;
}

/** The arm's limits: its position bounds, its motion caps and how far a joint may be from its target. */
export interface SO101Limits {
  readonly lower_bounds: readonly number[];
  readonly upper_bounds: readonly number[];
  readonly velocity: readonly number[];
  readonly acceleration: readonly number[];
  readonly jerk: readonly number[];
  readonly tracking_error: readonly number[];
  /** A controlled STOP brakes with these; null: with the move caps. */
  readonly stop_acceleration: readonly number[] | null;
  readonly stop_jerk: readonly number[] | null;
}

/** The arm's Home: its pose, how close each joint must come to it, and how the arm returns. */
export interface SO101HomeConfig {
  /** The joint vector at Home, rad and the gripper's opening. */
  readonly position: readonly number[];
  /** How close each arm joint must come to Home, rad. */
  readonly joint_tolerance: readonly number[];
  /** The share of the move caps a return to Home uses. */
  readonly speed_scale: number;
  /** The readings Home's own judgement of arrival looks back over, s. */
  readonly settle_window_s: number;
  /** The longest wait after the move for the arm to arrive at Home, s. */
  readonly arrival_timeout_s: number;
}

/** The goal offsets of the five arm joints that the feedforward adds to a target, rad; zeros disable a term. */
export interface FeedforwardConfig {
  /** The offset for each N*m of gravity torque the joint carries. */
  readonly gravity_compliance: readonly number[];
  /** The offset against friction while the joint moves. */
  readonly friction_offset_rad: readonly number[];
  /** What each N*m of the joint's gravity load adds to it. */
  readonly friction_load_ratio: readonly number[];
}

/** The SO-101's settings: the `robot` node of a station's configuration. */
export interface SO101Config {
  /** null: the arm must not move. */
  readonly hardware: HardwareConfig | null;
  /** null: the station has no camera. */
  readonly camera: CameraConfig | null;
  /** null: no Cartesian motion. */
  readonly geometry: KinematicsConfig | null;
  readonly limits: SO101Limits;
  /** null: the robot has no Home. */
  readonly home: SO101HomeConfig | null;
  /** null: the servos get no goal offsets. */
  readonly feedforward: FeedforwardConfig | null;
  /** How close an arm joint is to its target at an arrival, rad. */
  readonly position_tolerance: number;
  /** How close the gripper's opening is to its target at an arrival. */
  readonly gripper_tolerance: number;
  /** How far measured feedback may rest outside the position bounds. */
  readonly feedback_position_tolerance: number;
  /** The mean speed below which a coordinate is at rest. */
  readonly velocity_tolerance: number;
}

function frozen<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}

/** PEAR's defaults for one SO-101 follower arm with a wrist camera. tests/so101-kinematics compares them with PEAR's file. */
export const SO101_DEFAULT_CONFIG: SO101Config = frozen({
  hardware: {
    port: MISSING, // station: the arm's Feetech bus device (in a browser, the port the person picks)
    calibration_id: "so101_follower",
    calibration_dir: "calibration", // station: every arm has its own lerobot calibration, made on that arm
    joint_offsets: [0.0, 0.0, 0.0, 0.0, 0.0], // station: measured on the arm where the calibration's zero is off
    status_poll_ticks: 10,
    // higher reduces sag but makes the arm shake; every feedforward value scales with 1 / P
    position_p_coefficient: 16,
  },
  camera: {
    path: MISSING, // station: the wrist camera's device
    role: "wrist",
    width: 640,
    height: 480,
    fps: 30,
    fourcc: "MJPG",
  },
  geometry: {
    // station: fingertip distance when closed and when open, measured with a ruler on the arm. The model reads the
    // gripper's width from it, so a guess here misreports every grasp.
    gripper_width_cm: [0.0, 6.0],
    max_rotation_rad: 3.141592653589793,
    position_residual_m: 0.001,
    rotation_residual_rad: 0.01,
    ik_iterations: 200,
  },
  limits: {
    // station: the SO-101's generic range, to verify after a calibration: a calibrated arm may stop short of it. A
    // folded rest pose may sit just outside lift and elbow: feedback_position_tolerance accepts it, and moves may
    // only go inward.
    lower_bounds: [-1.7623, -1.7569, -1.6503, -1.7201, -2.618, 0.0],
    upper_bounds: [1.7623, 1.7569, 1.6503, 1.7201, 2.618, 1.0],
    velocity: [1.0, 1.0, 1.0, 1.0, 1.0, 0.5],
    acceleration: [2.0, 2.0, 2.0, 2.0, 2.0, 2.0],
    jerk: [10.0, 10.0, 10.0, 10.0, 10.0, 10.0],
    tracking_error: [0.25, 0.25, 0.25, 0.25, 0.25, 1.0], // the gripper's is not checked while the arm runs
    // a STOP brakes with these, higher than the move caps
    stop_acceleration: [6.0, 6.0, 6.0, 6.0, 6.0, 6.0],
    stop_jerk: [60.0, 60.0, 60.0, 60.0, 60.0, 60.0],
  },
  home: {
    // the fingertip tilted down with the jaw rolled 90 degrees so that it closes sideways; Home opens the gripper.
    // station: a pose that is clear of the table and the camera's view on that bench
    position: [0.0, -0.814, 0.077, 1.423, -1.613, 1.0],
    joint_tolerance: [0.035, 0.06, 0.06, 0.06, 0.035], // lift, elbow and wrist_flex carry gravity
    speed_scale: 0.3333333333333333,
    settle_window_s: 0.5,
    arrival_timeout_s: 20,
  },
  // station: goal offsets for the servos' P-only loop, joint 1 to 5, measured on the arm (PEAR's
  // `pear-station so101 friction-sweep`); zeros switch the compensation off
  feedforward: {
    gravity_compliance: [0.0, 0.0, 0.0, 0.0, 0.0],
    friction_offset_rad: [0.0, 0.0, 0.0, 0.0, 0.0],
    friction_load_ratio: [0.0, 0.0, 0.0, 0.0, 0.0],
  },
  position_tolerance: 0.06, // of an arm joint's arrival; under gravity the elbow settles short of its command
  gripper_tolerance: 0.02,
  feedback_position_tolerance: 0.06,
  velocity_tolerance: 0.06,
});
