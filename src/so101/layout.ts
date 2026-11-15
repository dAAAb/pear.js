// Ports pear/deploy/station/control/robots/so101/layout.py, with the parts of
// pear/deploy/station/control/joint/layout.py and pear/deploy/station/control/joint/texts.py that the SO-101's joint
// vector, its limits and its kinematics read.

import { ValueError } from "./kinematics/errors";

/** The arm's joints, base to wrist. */
export const JOINTS = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll"] as const;

/** The servos on the bus, one for each coordinate of the joint vector. */
export const MOTORS = [...JOINTS, "gripper"] as const;

export type JointName = (typeof JOINTS)[number];
export type MotorName = (typeof MOTORS)[number];

/**
 * A robot's wording of the control errors a model may read. Each text is a Python `str.format` template, kept
 * verbatim; `formatTemplate` in `kinematics/text.ts` fills one.
 */
export interface ControlTexts {
  /** `{arm}`, `{details}`: a target or a reading outside the position bounds. */
  readonly outside_bounds: string;
  /** `{axis}`, `{value}`, `{unit}`, `{lower}`, `{upper}`, `{allowance}`: one coordinate of `outside_bounds`. */
  readonly outside_bounds_coordinate: string;
  /** `{arm}`, `{details}`: a streamed command leaving its bounds. */
  readonly command_outside_bounds: string;
  /** The fields of `outside_bounds_coordinate`: one coordinate of `command_outside_bounds`. */
  readonly command_outside_bounds_coordinate: string;
  /** One arm's coordinate names in the two coordinate templates. */
  readonly bound_axes: readonly string[];
  /** `{arm}`, `{age}`: feedback too old or not finite. */
  readonly stale_feedback: string;
  /** `{details}`: measured joints too far from their targets. */
  readonly tracking_error_text: string;
  /** Enabling found the arms still moving. */
  readonly unsettled_start: string;
  /** Recovery refused after the fault hold could not be sent; the reason follows. */
  readonly failed_hold: string;
}

/** A robot's streamed joint vector: its arms in order, each with the same coordinates, the gripper last. */
export class JointLayout {
  /** The unit of an arm joint. */
  static readonly JOINT_UNIT = "rad";
  /** The unit of a gripper: 0 closed, 1 open. */
  static readonly GRIPPER_UNIT = "opening";

  constructor(
    readonly arms: readonly string[],
    /** One arm's coordinate names in metrics and messages. */
    readonly coordinates: readonly string[],
    readonly texts: ControlTexts,
  ) {}

  /** How many coordinates one arm has, its gripper among them. */
  get coordinateCount(): number {
    return this.coordinates.length;
  }

  /** How many joints one arm has before its gripper. */
  get jointCount(): number {
    return this.coordinateCount - 1;
  }

  /** The length of the joint vector. */
  get vectorLength(): number {
    return this.arms.length * this.coordinateCount;
  }

  /** Where each arm's gripper sits in the joint vector. */
  get gripperIndices(): number[] {
    return this.arms.map((_, armIndex) => (armIndex + 1) * this.coordinateCount - 1);
  }

  /** Returns the unit of the coordinate at `index` of the joint vector or of one arm's coordinates. */
  axisUnit(index: number): string {
    return index % this.coordinateCount === this.jointCount ? JointLayout.GRIPPER_UNIT : JointLayout.JOINT_UNIT;
  }

  /** Returns `values` as a finite joint vector, and throws if they are not one. */
  vector(values: ArrayLike<number>): number[] {
    return this.finiteArray(values, this.vectorLength);
  }

  /** Returns `values` as one arm's finite coordinates, and throws if they are not. */
  armVector(values: ArrayLike<number>): number[] {
    return this.finiteArray(values, this.coordinateCount);
  }

  private finiteArray(values: ArrayLike<number>, length: number): number[] {
    const array = Array.from(values, Number);
    if (array.length !== length || !array.every(Number.isFinite)) {
      throw new ValueError(`Expected ${this.jointCount} finite joint radians and 1 finite gripper opening`);
    }

    return array;
  }
}

/** The arm's joints in rad, then the gripper's opening, 0 closed and 1 open. */
export const LAYOUT = new JointLayout(["arm"], MOTORS, {
  outside_bounds: "Joint or gripper target outside commissioned bounds: {details}",
  outside_bounds_coordinate: "{axis}={value:.6f} {unit}, bounds=[{lower:.6f}, {upper:.6f}], allowance={allowance:.6f}",
  command_outside_bounds: "Command leaves the position bounds: {details}",
  command_outside_bounds_coordinate: "{axis}={value:.6f} {unit}",
  bound_axes: MOTORS,
  stale_feedback: "Stale or invalid feedback, age={age:.4f}s",
  tracking_error_text: "Excessive tracking error: {details}",
  unsettled_start: "Enable requires the arm to settle; startup timed out",
  failed_hold: "Recovery blocked: the fault hold command failed; disable and enable again: ",
});

/** The one arm, which names its targets and its readings. */
export const ARM = LAYOUT.arms[0] as string;

/** The length of the joint vector: the five joints and the gripper. */
export const VECTOR_LENGTH = LAYOUT.vectorLength;

/** The index of the gripper's opening in the joint vector. */
export const GRIPPER_INDEX = LAYOUT.gripperIndices[0] as number;
