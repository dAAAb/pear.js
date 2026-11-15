// Ports the kinematic chain of pear/deploy/station/control/robots/so101/description/so101_new_calib.urdf (a copy is
// in assets/pear/so101/), from base_link to gripper_frame_link, and the forward kinematics and the Jacobian that
// placo (pinocchio) computes on it for lerobot's RobotKinematics.

import {
  apply,
  add,
  column,
  cross,
  multiply,
  rotationAboutZ,
  rotationFromRpy,
  subtract,
  type Matrix3,
  type Vector3,
} from "./linalg";

/** A joint of the description: where its frame sits in its parent link's frame. */
export interface ChainJoint {
  readonly name: string;
  readonly parent: string;
  readonly child: string;
  /** The origin's translation, m. */
  readonly xyz: Readonly<Vector3>;
  /** The origin's rotation as the URDF writes it: roll, pitch, yaw about fixed axes, rad. */
  readonly rpy: Readonly<Vector3>;
}

/** A revolute joint: it turns its child link about `axis`, a direction of its own frame. */
export interface RevoluteJoint extends ChainJoint {
  readonly axis: Readonly<Vector3>;
}

/** The arm of a description: its revolute joints from the base to the wrist, then the fixed joint of its tip. */
export interface ArmChain {
  readonly joints: readonly RevoluteJoint[];
  readonly endEffector: ChainJoint;
}

// Every number below is the description's own text, digit for digit: the file writes pi as 3.14159 and pi / 2 as
// 1.5708, and the kinematics PEAR runs carry those few-microradian differences. tests/so101-kinematics/chain.test.ts
// compares this constant with the file.
export const SO101_CHAIN: ArmChain = {
  joints: [
    {
      name: "shoulder_pan",
      parent: "base_link",
      child: "shoulder_link",
      xyz: [0.0388353, -8.97657e-9, 0.0624],
      rpy: [3.14159, 4.18253e-17, -3.14159],
      axis: [0, 0, 1],
    },
    {
      name: "shoulder_lift",
      parent: "shoulder_link",
      child: "upper_arm_link",
      xyz: [-0.0303992, -0.0182778, -0.0542],
      rpy: [-1.5708, -1.5708, 0],
      axis: [0, 0, 1],
    },
    {
      name: "elbow_flex",
      parent: "upper_arm_link",
      child: "lower_arm_link",
      xyz: [-0.11257, -0.028, 1.73763e-16],
      rpy: [-3.63608e-16, 8.74301e-16, 1.5708],
      axis: [0, 0, 1],
    },
    {
      name: "wrist_flex",
      parent: "lower_arm_link",
      child: "wrist_link",
      xyz: [-0.1349, 0.0052, 3.62355e-17],
      rpy: [4.02456e-15, 8.67362e-16, -1.5708],
      axis: [0, 0, 1],
    },
    {
      name: "wrist_roll",
      parent: "wrist_link",
      child: "gripper_link",
      xyz: [5.55112e-17, -0.0611, 0.0181],
      rpy: [1.5708, 0.0486795, 3.14159],
      axis: [0, 0, 1],
    },
  ],
  endEffector: {
    name: "gripper_frame_joint",
    parent: "gripper_link",
    child: "gripper_frame_link",
    xyz: [-0.0079, -0.000218121, -0.0981274],
    rpy: [0, 3.14159, 0],
  },
};

/** The pose of the arm at one joint vector, in the base frame. */
export interface ChainState {
  /** The rotation of the tip's frame. */
  readonly rotation: Matrix3;
  /** The origin of the tip's frame, m. */
  readonly position: Vector3;
  /** The rotation of the first joint's child link (the SO-101's shoulder_link). */
  readonly firstLinkRotation: Matrix3;
  /** Each joint's axis, a unit vector. */
  readonly axes: Vector3[];
  /** A point on each joint's axis: the origin of its frame, m. */
  readonly points: Vector3[];
}

/** The forward kinematics of an arm's description. */
export class ChainKinematics {
  readonly jointCount: number;
  private readonly originRotations: Matrix3[];
  private readonly tipRotation: Matrix3;

  constructor(readonly chain: ArmChain) {
    for (const joint of chain.joints) {
      // pinocchio turns such a joint about its own z; another axis would need its general revolute joint
      if (joint.axis[0] !== 0 || joint.axis[1] !== 0 || joint.axis[2] !== 1) {
        throw new Error(`The joint ${joint.name} must turn about the z axis of its frame`);
      }
    }
    this.jointCount = chain.joints.length;
    this.originRotations = chain.joints.map((joint) => rotationFromRpy(joint.rpy));
    this.tipRotation = rotationFromRpy(chain.endEffector.rpy);
  }

  /** Returns the pose of the arm at the first `jointCount` values of `jointPositions`, rad. */
  state(jointPositions: ArrayLike<number>): ChainState {
    let rotation: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    let position: Vector3 = [0, 0, 0];
    let firstLinkRotation = rotation;
    const axes: Vector3[] = [];
    const points: Vector3[] = [];

    this.chain.joints.forEach((joint, index) => {
      position = add(position, apply(rotation, joint.xyz));
      rotation = multiply(rotation, this.originRotations[index]!);
      axes.push(column(rotation, 2));
      points.push(position);
      rotation = multiply(rotation, rotationAboutZ(Number(jointPositions[index])));
      if (index === 0) {
        firstLinkRotation = rotation;
      }
    });
    position = add(position, apply(rotation, this.chain.endEffector.xyz));
    rotation = multiply(rotation, this.tipRotation);

    return { rotation, position, firstLinkRotation, axes, points };
  }

  /**
   * Returns the Jacobian of the tip at `state`, one column a joint: how the tip's origin moves (m/rad) and how its
   * frame turns (rad/rad, the joint's axis), both in the base frame's directions.
   */
  jacobian(state: ChainState): { linear: Vector3[]; angular: Vector3[] } {
    return {
      linear: state.axes.map((axis, index) => cross(axis, subtract(state.position, state.points[index]!))),
      angular: state.axes,
    };
  }
}
