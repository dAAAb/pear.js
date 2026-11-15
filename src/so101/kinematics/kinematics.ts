// Ports pear/deploy/station/control/robots/so101/motion/kinematics.py, with the state and the action it reads from
// pear/deploy/station/control/robots/so101/motion/actions.py.

import { SO101_DEFAULT_CONFIG, type KinematicsConfig, type SO101Config } from "../config";
import { GRIPPER_INDEX, JOINTS, LAYOUT } from "../layout";
import { BaseKinematics } from "./base";
import { ChainKinematics, SO101_CHAIN, type ArmChain, type ChainState } from "./chain";
import { UnreachablePoseError, ValueError } from "./errors";
import { JointLimits } from "./limits";
import { add, column, cross, dot, fromColumns, norm, row, scale, subtract, apply, type Matrix3, type Vector3 } from "./linalg";
import { frameTaskStep } from "./solver";
import { formatFixed, formatGeneral, pythonRound } from "./text";
import {
  ARM_QUANTITIES,
  DECIMALS,
  type ArmQuantities,
  type GripperQuantity,
  type ModelState,
  type SingleArmDelta,
} from "../../protocol/types";

// The state the model reads and the action it writes are the protocol's: one definition for both modules.
export type { ArmQuantities, GripperQuantity, ModelState, SingleArmDelta };

/** What the kinematics read of an action: the arm's changes. What the gripper does moves no joint of the arm. */
export type ArmDelta = Pick<SingleArmDelta, "arm">;

/** The settings the kinematics read of a station's SO-101. */
export type KinematicsSettings = Pick<SO101Config, "geometry" | "limits" | "feedback_position_tolerance">;

type QuantityName = keyof ArmQuantities;

/**
 * Forward and inverse kinematics of the SO-101 on the package's description of the arm with the station's joint
 * limits; it opens no hardware.
 */
export class SO101Kinematics extends BaseKinematics {
  /** What the model reads and changes of the arm, in this order. */
  static readonly ARM_QUANTITIES = ARM_QUANTITIES satisfies readonly QuantityName[];
  /** The decimals of each quantity the model reads. */
  static readonly DECIMALS = DECIMALS;
  /** The description's frame at the tip of the fixed finger. */
  static readonly END_EFFECTOR_FRAME = "gripper_frame_link";
  /** The description's frame that shoulder_pan turns. */
  static readonly SHOULDER_FRAME = "shoulder_link";
  /** The base frame's vertical. */
  static readonly UP_AXIS: Readonly<Vector3> = [0, 0, 1];
  /** The largest joint change of a step of a solve that has converged, rad. */
  static readonly CONVERGENCE_RAD = 1e-7;
  /** The position's and the orientation's weight in a solver step. */
  static readonly IK_WEIGHT = 1.0;

  readonly geometry: KinematicsConfig;
  readonly limits: JointLimits;
  private readonly chain: ChainKinematics;
  /** The arm plane's horizontal direction, fixed in the shoulder's frame: +x at zero pan. */
  private readonly planeAxis: Vector3;

  /**
   * `robotConfig` gives the geometry, the joint limits and the feedback tolerance (by default PEAR's defaults, whose
   * gripper widths and limits a real station replaces with its own). `chain` is the arm's description: the SO-101's
   * unless a station has another.
   */
  constructor(robotConfig: KinematicsSettings = SO101_DEFAULT_CONFIG, chain: ArmChain = SO101_CHAIN) {
    super();

    if (robotConfig.geometry === null) {
      throw new ValueError("The kinematics need the geometry section of the robot's settings");
    }
    if (chain.joints.length !== JOINTS.length || chain.endEffector.child !== SO101Kinematics.END_EFFECTOR_FRAME) {
      throw new ValueError(`The description must lead through ${JOINTS.join(", ")} to ${SO101Kinematics.END_EFFECTOR_FRAME}`);
    }
    this.geometry = robotConfig.geometry;
    this.limits = JointLimits.fromConfig(robotConfig);
    this.chain = new ChainKinematics(chain);

    const shoulderRotation = this.chain.state(new Array<number>(JOINTS.length).fill(0)).firstLinkRotation;
    this.planeAxis = row(shoulderRotation, 0); // the transposed rotation applied to the base's +x
  }

  /** Returns the model's quantities of the arm, unrounded (cm and rad), at the measured `jointPositions`. */
  pose(jointPositions: ArrayLike<number>): [number, number, number, number, number] {
    const state = this.chain.state(jointPositions);
    return this.poseValues(state, this.planeDirection(state));
  }

  /** Returns what the model reads of the measured `jointPositions`, rounded the way it is shown. */
  override quantities(jointPositions: ArrayLike<number>): ModelState {
    const decimals = SO101Kinematics.DECIMALS;
    const pose = this.pose(jointPositions);
    // adding zero turns a rounded -0 into 0, as PEAR does
    const [x, y, z, pitch, roll] = SO101Kinematics.ARM_QUANTITIES.map(
      (name, index) => pythonRound(pose[index]!, decimals[name]) + 0.0,
    ) as [number, number, number, number, number];

    const [closedWidth, openWidth] = this.geometry.gripper_width_cm as [number, number];
    const opening = Math.min(Math.max(Number(jointPositions[GRIPPER_INDEX]), 0), 1);
    const width = pythonRound(closedWidth + opening * (openWidth - closedWidth), decimals.width) + 0.0;

    return { arm: { x, y, z, pitch, roll }, gripper: { width } };
  }

  /**
   * Returns the joint goal of the pose delta `action` from `jointPositions`; the gripper's coordinate is left as it
   * is. Throws `UnreachablePoseError`, with how far the arm can go, when the pose is out of reach, and `ValueError`
   * when the rotation exceeds the planning bound or the goal lies outside the commissioned bounds.
   */
  jointTarget(jointPositions: ArrayLike<number>, action: ArmDelta): number[] {
    const delta = SO101Kinematics.ARM_QUANTITIES.map((name) => action.arm[name]);
    if (Math.max(Math.abs(delta[3]!), Math.abs(delta[4]!)) > this.geometry.max_rotation_rad) {
      throw new ValueError("Rotation increment exceeds the planning bound");
    }

    const measured = Array.from(jointPositions, Number);
    const goal = measured.slice();
    if (delta.every((value) => value === 0)) {
      return goal;
    }

    let armGoal: number[];
    try {
      armGoal = this.solve(measured, delta);
    } catch (error) {
      if (!(error instanceof UnreachablePoseError)) {
        throw error;
      }
      const fraction = SO101Kinematics.reachableFraction((triedFraction) =>
        this.solve(
          measured,
          delta.map((value) => triedFraction * value),
        ),
      );
      throw new UnreachablePoseError(SO101Kinematics.unreachableMessage(delta, fraction));
    }
    armGoal.forEach((value, index) => {
      goal[index] = value;
    });

    this.limits.checkPositions(goal, LAYOUT, this.limits.feedbackTolerance);
    return goal;
  }

  /** Returns what the model is told of how much of the requested increment the arm can reach. */
  static unreachableMessage(requestedDelta: ArrayLike<number>, fraction: number): string {
    const changes = SO101Kinematics.ARM_QUANTITIES.flatMap((name, index) => {
      const value = Number(requestedDelta[index]);
      if (value === 0) {
        return [];
      }
      const reached = SO101Kinematics.truncatedText(fraction * value, SO101Kinematics.DECIMALS[name]);
      return [`${name} ${reached} of ${formatGeneral(value, true)}`];
    }).join(", ");

    return (
      "The target is out of reach. Along the requested change the arm can go " +
      `at most ${Math.floor(100 * fraction)}% (${changes}).`
    );
  }

  /**
   * Returns the arm joints that reach `delta` from `jointPositions`, iterating the solver's step from the measured
   * joints, and throws if the final pose misses.
   */
  private solve(jointPositions: readonly number[], delta: readonly number[]): number[] {
    const geometry = this.geometry;
    const seed = jointPositions.slice(0, JOINTS.length);
    let state = this.chain.state(seed);

    // the model's positions are cm, the description's m
    const position = add(state.position, [delta[0]! / 100, delta[1]! / 100, delta[2]! / 100]);
    const current = this.poseValues(state, this.planeDirection(state));
    const [pitch, roll] = [current[3] + delta[3]!, current[4] + delta[4]!];
    // the target pose, its pointing direction in the arm plane of the current iterate
    const targetAt = (iterate: ChainState) => ({
      rotation: this.poseRotation(this.planeDirection(iterate), pitch, roll),
      position,
    });
    const settings = {
      positionWeight: SO101Kinematics.IK_WEIGHT,
      orientationWeight: SO101Kinematics.IK_WEIGHT,
      lowerBounds: this.limits.lowerBounds,
      upperBounds: this.limits.upperBounds,
    };

    let solution = seed;
    for (let iteration = 0; iteration < geometry.ik_iterations; iteration++) {
      const nextSolution = frameTaskStep(this.chain, state, solution, targetAt(state), settings);
      const largestChange = Math.max(...nextSolution.map((value, index) => Math.abs(value - solution[index]!)));
      solution = nextSolution;
      state = this.chain.state(solution);
      if (largestChange < SO101Kinematics.CONVERGENCE_RAD) {
        break;
      }
    }

    const goal = targetAt(state);
    const positionError = norm(subtract(state.position, goal.position));
    if (positionError > geometry.position_residual_m) {
      throw new UnreachablePoseError(`IK position error ${formatFixed(1000 * positionError, 1)} mm`);
    }
    const angleError = SO101Kinematics.rotationDistance(state.rotation, goal.rotation);
    if (angleError > geometry.rotation_residual_rad) {
      throw new UnreachablePoseError(`IK orientation error ${formatFixed(angleError, 3)} rad`);
    }

    return solution;
  }

  /** Returns the unit horizontal direction of the arm plane at the joints of `state`. */
  private planeDirection(state: ChainState): Vector3 {
    const direction = apply(state.firstLinkRotation, this.planeAxis);
    direction[2] = 0.0;
    const length = norm(direction);

    return [direction[0] / length, direction[1] / length, direction[2] / length];
  }

  /**
   * Returns the model's quantities of the fingertip's pose `state`: the position in cm, the pitch and the roll.
   */
  private poseValues(state: ChainState, planeDirection: Vector3): [number, number, number, number, number] {
    // the pointing direction lies in the vertical plane that shoulder_pan sets: the pitch is its angle below
    // horizontal, and the roll follows wrist_roll
    const [pointingAxis, lateralAxis] = [column(state.rotation, 2), column(state.rotation, 1)];
    const pitch = Math.atan2(-pointingAxis[2], dot(pointingAxis, planeDirection));
    const horizontalNormal = cross(SO101Kinematics.UP_AXIS, planeDirection);
    const roll = Math.atan2(
      dot(cross(horizontalNormal, lateralAxis), scale(pointingAxis, -1)),
      dot(horizontalNormal, lateralAxis),
    );

    // the base frame's metres as the model's centimetres
    return [100 * state.position[0], 100 * state.position[1], 100 * state.position[2], pitch, roll];
  }

  /**
   * Returns the fingertip's rotation that points `pitch` below horizontal in the arm plane, rolled by `roll`.
   */
  private poseRotation(planeDirection: Vector3, pitch: number, roll: number): Matrix3 {
    const pointingAxis = subtract(scale(planeDirection, Math.cos(pitch)), scale(SO101Kinematics.UP_AXIS, Math.sin(pitch)));
    const horizontalNormal = cross(SO101Kinematics.UP_AXIS, planeDirection);
    const lateralAxis = add(
      scale(horizontalNormal, Math.cos(roll)),
      scale(cross(scale(pointingAxis, -1), horizontalNormal), Math.sin(roll)),
    );

    return fromColumns(cross(lateralAxis, pointingAxis), lateralAxis, pointingAxis);
  }
}
