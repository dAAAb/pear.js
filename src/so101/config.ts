// Ports the SO-101's defaults, pear/deploy/station/control/robots/so101/config.yaml (its `robot` node), and the
// shape of its settings, pear/deploy/station/control/robots/so101/config.py with the sections it inherits from
// pear/deploy/station/control/joint/config.py.
//
// The keys are PEAR's own, so that a station's file written for PEAR reads over these defaults unchanged. Joint
// values are rad in the calibrated frame; the gripper's is an opening, 0 closed and 1 open; every vector follows the
// order of MOTORS in layout.ts (a vector of five values: of JOINTS).
//
// The defaults describe a generic SO-101. What a real station must measure or choose itself is marked "station".
//
// The interfaces are the settings as a station's file holds them. The classes at the end of this file are PEAR's
// dataclasses: they take those settings and refuse them as `__post_init__` refuses them, and `SO101RobotConfig` is
// what the joint layer (src/station/joint) is given as the robot's settings.

import { ConfigSection, HomeConfig, Limits, RobotConfig } from "../station/joint/config";
import { ValueError } from "../station/joint/errors";
import { brakingCapsOf } from "../station/joint/limits";
import { pythonStrRepr } from "../station/joint/numeric";
import { ARM, LAYOUT, VECTOR_LENGTH, type JointLayout } from "./layout";

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

// The dataclasses of pear/deploy/station/control/robots/so101/config.py: each takes its section of the settings and
// throws PEAR's ValueError, with PEAR's message, where `__post_init__` raises. The names PEAR's classes have are the
// interfaces' above, so the classes are called sections; a refusal still begins with PEAR's class name.

/** The number of values of a vector of settings with one value for each arm joint. */
export const ARM_JOINT_LENGTH = LAYOUT.jointCount;

/** The one camera's role, by which the format reads its frames. */
export const WRIST_ROLE = "wrist";

/** The arm's limits, with the acceleration and jerk caps a controlled STOP brakes with (PEAR's SO101Limits). */
export class SO101LimitsSection extends Limits implements SO101Limits {
  declare stop_acceleration: number[] | null;
  declare stop_jerk: number[] | null;

  constructor(settings: SO101Limits) {
    super(settings);
  }

  protected override get className(): string {
    return "SO101Limits";
  }

  protected override get fieldNames(): readonly string[] {
    return [...super.fieldNames, "stop_acceleration", "stop_jerk"];
  }

  protected override get optionalFieldNames(): readonly string[] {
    return ["stop_acceleration", "stop_jerk"];
  }

  protected override postInit(): void {
    super.postInit();

    const stopAndMoveCaps: [number[] | null, number[]][] = [
      [this.stop_acceleration, this.acceleration],
      [this.stop_jerk, this.jerk],
    ];
    const brakesMoreGently = stopAndMoveCaps.some(
      ([stopCaps, moveCaps]) =>
        stopCaps !== null &&
        stopCaps.slice(0, moveCaps.length).some((stopCap, index) => !(stopCap >= moveCaps[index]!)),
    );
    if (brakesMoreGently) {
      throw new ValueError("A STOP must not brake more gently than a move");
    }
  }

  /** Returns the acceleration and jerk caps a controlled STOP brakes with: the STOP caps, a move's where unset. */
  override brakingCaps(): [readonly number[], readonly number[]] {
    return brakingCapsOf(this);
  }
}

/** The arm's Feetech bus: its device, its lerobot calibration and the servos' settings (PEAR's HardwareConfig). */
export class HardwareSection extends ConfigSection implements HardwareConfig {
  declare port: string;
  declare calibration_id: string;
  declare calibration_dir: string;
  declare joint_offsets: number[];
  declare status_poll_ticks: number;
  declare position_p_coefficient: number;

  constructor(settings: HardwareConfig) {
    super(settings);
  }

  protected get className(): string {
    return "HardwareConfig";
  }

  protected get fieldNames(): readonly string[] {
    return [
      "port",
      "calibration_id",
      "calibration_dir",
      "joint_offsets",
      "status_poll_ticks",
      "position_p_coefficient",
    ];
  }

  protected override postInit(): void {
    super.postInit();

    this.checkLength("joint_offsets", ARM_JOINT_LENGTH);
    this.checkRange("joint_offsets", { atLeast: -0.2, atMost: 0.2 });
    this.checkRange("status_poll_ticks", { atLeast: 2, atMost: 100 });
    this.checkRange("position_p_coefficient", { atLeast: 8, atMost: 64 });
  }
}

/** The wrist camera's device and the frames it is asked for (PEAR's CameraConfig). */
export class CameraSection extends ConfigSection implements CameraConfig {
  declare path: string;
  declare role: string;
  declare width: number;
  declare height: number;
  declare fps: number;
  declare fourcc: string | null;

  constructor(settings: CameraConfig) {
    super(settings);
  }

  protected get className(): string {
    return "CameraConfig";
  }

  protected get fieldNames(): readonly string[] {
    return ["path", "role", "width", "height", "fps", "fourcc"];
  }

  protected override postInit(): void {
    super.postInit();

    if (this.role !== WRIST_ROLE) {
      throw new ValueError(`CameraConfig.role must be ${pythonStrRepr(WRIST_ROLE)}`);
    }
    this.checkRange("width", { above: 0 });
    this.checkRange("height", { above: 0 });
    this.checkRange("fps", { above: 0 });
  }
}

/**
 * What the inverse kinematics solve on and how far they go (PEAR's KinematicsConfig, without its `urdf`: pear.js
 * reads no description at run time).
 */
export class KinematicsSection extends ConfigSection implements KinematicsConfig {
  declare max_rotation_rad: number;
  declare position_residual_m: number;
  declare rotation_residual_rad: number;
  declare ik_iterations: number;
  declare gripper_width_cm: number[];

  constructor(settings: KinematicsConfig) {
    super(settings);
  }

  protected get className(): string {
    return "KinematicsConfig";
  }

  protected get fieldNames(): readonly string[] {
    return ["max_rotation_rad", "position_residual_m", "rotation_residual_rad", "ik_iterations", "gripper_width_cm"];
  }

  protected override postInit(): void {
    super.postInit();

    this.checkRange("max_rotation_rad", { above: 0, atMost: Math.PI });
    this.checkRange("position_residual_m", { above: 0, atMost: 0.01 });
    this.checkRange("rotation_residual_rad", { above: 0, atMost: 0.1 });
    this.checkRange("ik_iterations", { atLeast: 10, atMost: 2000 });
    this.checkLength("gripper_width_cm", 2);
    const [closedWidth, openWidth] = this.gripper_width_cm as [number, number];
    if (!(0 <= closedWidth && closedWidth < openWidth)) {
      throw new ValueError("gripper_width_cm must be [closed, open] with closed < open");
    }
  }
}

/** The arm's Home: its pose and how close each joint must come to it (PEAR's SO101HomeConfig). */
export class SO101HomeSection extends HomeConfig implements SO101HomeConfig {
  declare position: number[];
  declare joint_tolerance: number[];

  constructor(settings: SO101HomeConfig) {
    super(settings);
  }

  protected override get className(): string {
    return "SO101HomeConfig";
  }

  protected override get fieldNames(): readonly string[] {
    return [...super.fieldNames, "position", "joint_tolerance"];
  }

  protected override postInit(): void {
    super.postInit();

    this.checkLength("position", VECTOR_LENGTH);
    this.checkLength("joint_tolerance", ARM_JOINT_LENGTH);
    this.checkRange("joint_tolerance", { above: 0, atMost: 0.1 });
  }
}

/** The goal offsets of the five arm joints that the feedforward adds to a target (PEAR's FeedforwardConfig). */
export class FeedforwardSection extends ConfigSection implements FeedforwardConfig {
  declare gravity_compliance: number[];
  declare friction_offset_rad: number[];
  declare friction_load_ratio: number[];

  constructor(settings: FeedforwardConfig) {
    super(settings);
  }

  protected get className(): string {
    return "FeedforwardConfig";
  }

  protected get fieldNames(): readonly string[] {
    return ["gravity_compliance", "friction_offset_rad", "friction_load_ratio"];
  }

  protected override postInit(): void {
    super.postInit();

    for (const name of this.fieldNames) {
      this.checkLength(name, ARM_JOINT_LENGTH);
    }
    this.checkRange("gravity_compliance", { atLeast: 0, atMost: 0.3 });
    this.checkRange("friction_offset_rad", { atLeast: 0, atMost: 0.05 });
    this.checkRange("friction_load_ratio", { atLeast: 0, atMost: 0.1 });
  }
}

/** What `SO101RobotConfig` is told besides the settings. */
export interface SO101ConfigOptions {
  /**
   * Whether the calibration `calibrationId` exists in `calibrationDir`. PEAR looks for the file
   * `<calibration_dir>/<calibration_id>.json`; a page has no file system, so whatever keeps its calibrations answers
   * here. Without it no calibration is known, and the arm must not move.
   */
  calibrationExists?: (calibrationDir: string, calibrationId: string) => boolean;
}

/**
 * The SO-101's settings, checked: its arm's bus, its wrist camera, its kinematics, its limits, its Home and the
 * feedforward of its servos (PEAR's SO101Config). A value the settings leave ??? reads as the placeholder of its key,
 * which the motion blockers name.
 */
export class SO101RobotConfig extends RobotConfig implements SO101Config {
  declare hardware: HardwareSection | null;
  declare camera: CameraSection | null;
  declare geometry: KinematicsSection | null;
  declare limits: SO101LimitsSection;
  declare home: SO101HomeSection | null;
  declare feedforward: FeedforwardSection | null;

  private readonly calibrationExists: (calibrationDir: string, calibrationId: string) => boolean;

  constructor(settings: SO101Config = SO101_DEFAULT_CONFIG, options: SO101ConfigOptions = {}) {
    super(RobotConfig.withPlaceholders(settings));

    this.calibrationExists = options.calibrationExists ?? (() => false);
  }

  /** The arm's joint vector. */
  get LAYOUT(): JointLayout {
    return LAYOUT;
  }

  protected get className(): string {
    return "SO101Config";
  }

  protected get fieldNames(): readonly string[] {
    return [
      "position_tolerance",
      "gripper_tolerance",
      "feedback_position_tolerance",
      "velocity_tolerance",
      "home",
      "hardware",
      "camera",
      "geometry",
      "limits",
      "feedforward",
    ];
  }

  protected override get optionalFieldNames(): readonly string[] {
    return ["home", "hardware", "camera", "geometry", "feedforward"];
  }

  protected override fieldValue(name: string, value: unknown): unknown {
    if (value === null || value instanceof ConfigSection) {
      return value;
    }

    switch (name) {
      case "home":
        return new SO101HomeSection(value as SO101HomeConfig);
      case "hardware":
        return new HardwareSection(value as HardwareConfig);
      case "camera":
        return new CameraSection(value as CameraConfig);
      case "geometry":
        return new KinematicsSection(value as KinematicsConfig);
      case "limits":
        return new SO101LimitsSection(value as SO101Limits);
      case "feedforward":
        return new FeedforwardSection(value as FeedforwardConfig);
      default:
        return value;
    }
  }

  protected override postInit(): void {
    super.postInit();

    this.checkRange("feedback_position_tolerance", { atMost: 0.2 });
    const { lower_bounds: lowerBounds, upper_bounds: upperBounds } = this.limits;
    if (
      this.home !== null &&
      this.home.position
        .slice(0, Math.min(lowerBounds.length, upperBounds.length))
        .some((coordinate, index) => !(lowerBounds[index]! <= coordinate && coordinate <= upperBounds[index]!))
    ) {
      throw new ValueError("Home must lie inside the position limits");
    }
    if (this.feedforward !== null && this.geometry === null) {
      throw new ValueError("feedforward needs geometry.urdf for the gravity model");
    }
  }

  /** Returns the limits of the one arm. */
  armLimits(): Record<string, SO101LimitsSection> {
    return { [ARM]: this.limits };
  }

  /**
   * Returns the reasons the real arm must not move under these settings: a template's placeholder first, then no
   * bus, or no calibration.
   */
  motionBlockers(): string[] {
    const hardware = this.hardware;
    const blockers: string[] = [];
    const placeholderKey = this.firstPlaceholder();
    if (placeholderKey) {
      blockers.push(`${placeholderKey} is a placeholder; see the so101 setup in README.md`);
    }
    if (hardware === null) {
      blockers.push("missing hardware section");
    } else if (!this.calibrationExists(hardware.calibration_dir, hardware.calibration_id)) {
      blockers.push(`missing calibration file for id ${pythonStrRepr(hardware.calibration_id)}`);
    }

    return blockers;
  }
}
