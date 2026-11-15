// Ports pear/deploy/station/control/robots/so101/joint/feedforward.py.
//
// PEAR's gravity model is pinocchio's generalized gravity of the arm's description
// (pear/deploy/station/control/robots/so101/description/so101_new_calib.urdf; a copy is in assets/pear/so101/). No
// description is read here: the masses below are transcribed from that file, as the chain of the kinematics is, and
// the torque is the same sum over the links that pinocchio's recursion computes.

import { FrictionFeedforward } from "../../station/joint/feedforward";
import { ValueError } from "../../station/joint/errors";
import { broadcastPair } from "../../station/joint/numeric";
import type { FeedforwardConfig } from "../config";
import type { Feedforward as DriverFeedforward } from "../hardware/driver";
import { SO101_CHAIN, type ArmChain } from "../kinematics/chain";
import {
  add,
  apply,
  column,
  cross,
  multiply,
  rotationAboutZ,
  rotationFromRpy,
  subtract,
  type Matrix3,
  type Vector3,
} from "../kinematics/linalg";
import { GRIPPER_INDEX, VECTOR_LENGTH } from "../layout";

/** A link's mass, kg, and its centre of mass in the link's own frame, m: the description's `<inertial>`. */
export interface LinkMass {
  readonly link: string;
  readonly mass: number;
  readonly centre: Readonly<Vector3>;
}

/** A link that hangs on the arm's last link by a joint that the arm joints do not turn. */
export interface AttachedMass extends LinkMass {
  /** The joint that holds it. */
  readonly joint: string;
  /** The origin of that joint in the last link's frame, as the description writes it; the joint itself is at zero. */
  readonly xyz: Readonly<Vector3>;
  readonly rpy: Readonly<Vector3>;
}

/** The masses the arm joints carry. */
export interface ArmMasses {
  /** The link each arm joint turns, base to wrist. */
  readonly links: readonly LinkMass[];
  /** What the last of them carries besides itself. */
  readonly attached: readonly AttachedMass[];
}

// Every number below is the description's own text, digit for digit. tests/station-joint/gravity.test.ts compares
// this constant with the file. The base link is not here: no joint carries it.
export const SO101_MASSES: ArmMasses = {
  links: [
    { link: "shoulder_link", mass: 0.100006, centre: [-0.0307604, -1.66727e-5, -0.0252713] },
    { link: "upper_arm_link", mass: 0.103, centre: [-0.0898471, -0.00838224, 0.0184089] },
    { link: "lower_arm_link", mass: 0.104, centre: [-0.0980701, 0.00324376, 0.0182831] },
    { link: "wrist_link", mass: 0.079, centre: [-0.000103312, -0.0386143, 0.0281156] },
    { link: "gripper_link", mass: 0.087, centre: [0.000213627, 0.000245138, -0.025187] },
  ],
  attached: [
    {
      // the fingertip's frame: a link of a nanogram, which pinocchio weighs with the rest
      link: "gripper_frame_link",
      mass: 1e-9,
      centre: [0, 0, 0],
      joint: "gripper_frame_joint",
      xyz: [-0.0079, -0.000218121, -0.0981274],
      rpy: [0, 3.14159, 0],
    },
    {
      // the moving jaw, which PEAR's gravity model leaves at its joint's zero whatever the gripper's opening
      link: "moving_jaw_so101_v1_link",
      mass: 0.012,
      centre: [-0.00157495, -0.0300244, 0.0192755],
      joint: "gripper",
      xyz: [0.0202, 0.0188, -0.0234],
      rpy: [1.5708, -5.24284e-8, -1.41553e-15],
    },
  ],
};

/** The gravity torque on the five arm joints, N*m, from the description's masses at the station's joint angles. */
export class GravityModel {
  /** The gravity pinocchio gives a model, m/s^2, along the base frame's -z. */
  static readonly GRAVITY = 9.81;

  private readonly originRotations: Matrix3[];

  constructor(
    readonly chain: ArmChain = SO101_CHAIN,
    readonly masses: ArmMasses = SO101_MASSES,
  ) {
    if (chain.joints.length !== masses.links.length) {
      throw new ValueError(`${masses.links.map(({ link }) => link).join(", ")} are not the links of the arm's joints`);
    }
    chain.joints.forEach((joint, index) => {
      if (joint.child !== masses.links[index]!.link) {
        throw new ValueError(`The joint ${joint.name} turns ${joint.child}, not ${masses.links[index]!.link}`);
      }
      if (joint.axis[0] !== 0 || joint.axis[1] !== 0 || joint.axis[2] !== 1) {
        throw new ValueError(`The joint ${joint.name} must turn about the z axis of its frame`);
      }
    });
    this.originRotations = chain.joints.map((joint) => rotationFromRpy(joint.rpy));
  }

  /** Returns the gravity torque of each arm joint at the joint vector `jointPositions`. */
  torque(jointPositions: ArrayLike<number>): number[] {
    const jointCount = this.chain.joints.length;
    const given = Array.from(jointPositions).slice(0, jointCount);
    if (given.length !== jointCount && given.length !== 1) {
      // numpy's refusal to put the values into the arm joints' places of the configuration
      throw new ValueError(
        `shape mismatch: value array of shape (${given.length},) could not be broadcast to indexing result of ` +
          `shape (${jointCount},)`,
      );
    }
    const angles = given.length === jointCount ? given : new Array<number>(jointCount).fill(given[0]!);

    // each joint's axis and a point on it, and each mass with the last joint that carries it, in the base frame
    let rotation: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    let position: Vector3 = [0, 0, 0];
    const axes: Vector3[] = [];
    const points: Vector3[] = [];
    const carried: { joint: number; mass: number; centre: Vector3 }[] = [];
    this.chain.joints.forEach((joint, index) => {
      position = add(position, apply(rotation, joint.xyz));
      rotation = multiply(rotation, this.originRotations[index]!);
      axes.push(column(rotation, 2));
      points.push(position);
      rotation = multiply(rotation, rotationAboutZ(angles[index]!));
      const link = this.masses.links[index]!;
      carried.push({ joint: index, mass: link.mass, centre: add(position, apply(rotation, link.centre)) });
    });
    for (const attached of this.masses.attached) {
      const origin = add(position, apply(rotation, attached.xyz));
      const frame = multiply(rotation, rotationFromRpy(attached.rpy));
      carried.push({ joint: jointCount - 1, mass: attached.mass, centre: add(origin, apply(frame, attached.centre)) });
    }

    // positive: what the joint must supply, so that its servo settles that far below its goal. Turning a joint
    // raises each mass it carries by the vertical part of axis x (centre - point) for each radian.
    return axes.map((axis, index) => {
      let moment = 0.0;
      for (const { joint, mass, centre } of carried) {
        if (joint >= index) {
          moment += mass * cross(axis, subtract(centre, points[index]!))[2];
        }
      }
      return GravityModel.GRAVITY * moment;
    });
  }
}

/**
 * The arm's friction feedforward, a goal offset in rad: the robot's own checks of its values, its planned velocity
 * cut to the arm joints, and its gravity load used as it comes.
 */
export class SO101FrictionFeedforward extends FrictionFeedforward {
  /** Returns the arm joints' part of the planned velocity: zeros when it is missing or malformed. */
  override jointVelocity(plannedVelocity: ArrayLike<number> | null | undefined): number[] {
    let velocity = new Array<number>(this.magnitude.length).fill(0);
    if (plannedVelocity != null) {
      const plan = Array.from(plannedVelocity).slice(0, this.magnitude.length);
      if (plan.length === velocity.length && plan.every(Number.isFinite)) {
        velocity = plan;
      }
    }

    return velocity;
  }

  /** Returns the gravity load as it is given: the gravity model's torque of the commanded target. */
  override jointLoad(load: ArrayLike<number> | null | undefined): ArrayLike<number> | null | undefined {
    return load;
  }

  /** Returns each joint's offset and load ratio, refused unless one of each for every joint, non-negative. */
  static override checkedValues(magnitude: ArrayLike<number>, loadRatio: ArrayLike<number>): [number[], number[]] {
    const offsetValues = Array.from(magnitude);
    const loadRatioValues = Array.from(loadRatio);
    if (offsetValues.length !== loadRatioValues.length) {
      throw new ValueError("Expected one friction offset and load ratio per joint");
    }
    if (offsetValues.some((value) => value < 0) || loadRatioValues.some((value) => value < 0)) {
      throw new ValueError("Friction offsets and load ratios must be non-negative");
    }

    return [offsetValues, loadRatioValues];
  }
}

/** The goal offset of a commanded target: gravity always, friction while it lasts. */
export class Feedforward implements DriverFeedforward {
  /** The goal offset for each N*m of gravity torque a joint carries, rad. */
  readonly compliance: number[];
  readonly frictionFeedforward: SO101FrictionFeedforward;

  /**
   * `feedforwardConfig` is the feedforward section of the robot's settings; `gravityModel` is the SO-101's unless a
   * station has another description.
   */
  constructor(
    feedforwardConfig: FeedforwardConfig,
    readonly gravityModel: GravityModel = new GravityModel(),
  ) {
    this.compliance = [...feedforwardConfig.gravity_compliance];
    this.frictionFeedforward = new SO101FrictionFeedforward(
      feedforwardConfig.friction_offset_rad,
      feedforwardConfig.friction_load_ratio,
    );
  }

  /**
   * Returns the goal offset of `target`, which moves at the arm's `plannedVelocity`, at the monotonic time `now`, s;
   * the gripper never gets one.
   */
  offset(target: ArrayLike<number>, plannedVelocity: ArrayLike<number> | null, now: number): number[] {
    const torque = this.gravityModel.torque(target);

    // the servos run a P-only position loop and take no torque command, so a joint stops short by the torque it
    // carries over P: the offset is added to its goal instead
    const gravity = this.gravityOffset(torque);
    const friction = this.frictionFeedforward.update(plannedVelocity, now, torque);
    const [gravityPart, frictionPart] = broadcastPair(gravity, friction);

    return this.vectorOffset(gravityPart.map((value, joint) => value + frictionPart[joint]!));
  }

  /** Returns the goal offset of holding `target`: gravity alone, the friction's state cleared. */
  holdOffset(target: ArrayLike<number>): number[] {
    this.frictionFeedforward.reset();

    return this.vectorOffset(this.gravityOffset(this.gravityModel.torque(target)));
  }

  /** Returns the offset that carries the gravity `torque`: the compliance times it, joint by joint. */
  private gravityOffset(torque: readonly number[]): number[] {
    const [compliance, carried] = broadcastPair(this.compliance, torque);

    return compliance.map((value, joint) => value * carried[joint]!);
  }

  /** Returns the arm joints' `offsets` as the offset of the joint vector, the gripper's zero. */
  private vectorOffset(offsets: readonly number[]): number[] {
    if (offsets.length !== GRIPPER_INDEX && offsets.length !== 1) {
      throw new ValueError(
        `could not broadcast input array from shape (${offsets.length},) into shape (${GRIPPER_INDEX},)`,
      );
    }
    const offset = new Array<number>(VECTOR_LENGTH).fill(0);
    for (let joint = 0; joint < GRIPPER_INDEX; joint++) {
      offset[joint] = offsets[offsets.length === 1 ? 0 : joint]!;
    }

    return offset;
  }
}
