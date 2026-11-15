// Ports pear/deploy/station/control/robots/so101/motion/planning.py: SO101Planning.

import { AttributeError, ValueError } from "../../python/errors";
import type { ControlConfig, RobotConfig } from "../../station/joint/config";
import { JointLimits } from "../../station/joint/limits";
import { maximum, minimum } from "../../station/joint/numeric";
import { SnapshotCheck } from "../../station/joint/snapshot_checks";
import { GripperProfile, JointMove } from "../../station/joint/trajectory";
import { HomePlanning, PreparedAction, type PlanningObservation } from "../../station/motion/planning";
import type { HomePlan } from "../../station/schemas";
import type { SO101RobotConfig } from "../config";
import type { ArmDelta } from "../kinematics/kinematics";
import { GRIPPER_INDEX, LAYOUT } from "../layout";
import { GripperAction, SingleArmDelta } from "./actions";

/** What the planning asks of the kinematics: the joint goal of a pose delta from a joint vector. */
export interface PlanningKinematics {
  jointTarget(jointPositions: ArrayLike<number>, action: ArmDelta): number[];
}

/** The plan of the SO-101's direct return to Home, which the operator reviews. */
export interface SO101HomePlan extends HomePlan {
  initial_target: number[];
  start_target: number[];
  goal_target: number[];
  open_gripper: boolean;
  trajectory_seconds: number;
  opening_seconds_estimate: number;
  operation_seconds_estimate: number;
}

/**
 * The SO-101's planning in the caller's thread: an action's arm move by inverse kinematics from its pose delta, and
 * the direct return to Home.
 */
export class SO101Planning extends HomePlanning {
  /** The refusal of an approved move held no longer. */
  static override readonly TARGETS_CHANGED: string = "Home target changed; check and confirm again";
  /** The slack on the joint bounds of a Home path. */
  static readonly BOUND_TOLERANCE: number = JointLimits.EPSILON;

  /**
   * Returns the prepared `action` from `observation`: the inverse kinematics start from the pose `deltaBase` gives,
   * the move from the held command. The gripper request is true to open, false to close, null to leave the jaw.
   */
  static checkedAction(
    robotConfig: SO101RobotConfig,
    kinematics: PlanningKinematics,
    observation: PlanningObservation,
    action: unknown,
  ): PreparedAction<boolean> {
    const [armDelta, opensGripper] = this.actionParts(action);
    const measuredPositions = Array.from(observation.joint_positions, Number);
    const origin = SnapshotCheck.targetVector(observation.control_snapshot);
    if (
      measuredPositions.length !== origin.length ||
      !measuredPositions.every(Number.isFinite) ||
      !origin.every(Number.isFinite)
    ) {
      throw new ValueError("Expected finite measured and commanded positions");
    }

    let move: JointMove | null = null;
    if (armDelta !== null) {
      const goal = kinematics.jointTarget(this.deltaBase(robotConfig, measuredPositions, origin), armDelta);
      goal[GRIPPER_INDEX] = origin[GRIPPER_INDEX]!;
      move = JointMove.build(origin, goal, robotConfig.jointLimits(), LAYOUT);
    }

    return new PreparedAction(opensGripper, move);
  }

  /**
   * Returns the plan of the direct return to Home from `observation` and its move: the gripper opens first, then
   * the arm returns.
   */
  static checkedHome(
    controlConfig: ControlConfig,
    robotConfig: SO101RobotConfig,
    observation: PlanningObservation,
  ): [SO101HomePlan, JointMove | null] {
    const initialTargets = SnapshotCheck.targetVector(observation.control_snapshot);
    const measuredPositions = this.measuredPositions(observation, LAYOUT);
    const limits = robotConfig.jointLimits();
    limits.checkPositions(initialTargets, LAYOUT, limits.feedbackTolerance);
    const needsOpening = this.needsOpening(
      initialTargets[GRIPPER_INDEX]!,
      measuredPositions[GRIPPER_INDEX]!,
      robotConfig.gripper_tolerance,
    );

    if (robotConfig.home === null) {
      throw new AttributeError("'NoneType' object has no attribute 'position'");
    }
    const start = initialTargets.slice();
    const goal = Array.from(robotConfig.home.position, Number);
    // the gripper opens first and is verified on its own, then the arm returns
    start[GRIPPER_INDEX] = goal[GRIPPER_INDEX] = GripperProfile.OPEN_ENDPOINT;
    const offset = measuredPositions.map((measured, index) => measured - initialTargets[index]!);
    offset[GRIPPER_INDEX] = 0.0;

    const move = this.homeMove(robotConfig, start, goal, offset);
    let openingS = 0.0;
    if (needsOpening) {
      openingS = GripperProfile.durationS(initialTargets[GRIPPER_INDEX]!, true, robotConfig.limits);
    }

    const plan: SO101HomePlan = {
      initial_target: initialTargets.slice(),
      start_target: start,
      goal_target: goal,
      open_gripper: needsOpening,
      ...this.timeEstimates(controlConfig, robotConfig, move, openingS, needsOpening),
    };
    return [plan, move];
  }

  /**
   * Throws unless the planned motion from the targets `start` stays within the joint bounds, also when the offset
   * of the measured joints shifts it.
   */
  static override checkHomeBounds(
    robotConfig: RobotConfig,
    move: JointMove | null,
    start: ArrayLike<number>,
    offset: ArrayLike<number>,
  ): void {
    // the measured pose may rest past a limit within the feedback tolerance; the shifted motion may not go beyond
    // it, and the planned one only moves inward from a start held past a limit
    const limits = robotConfig.jointLimits();
    const startVector = Array.from(start, Number);
    const offsetVector = Array.from(offset, Number);
    const measuredPositions = startVector.map((value, index) => value + offsetVector[index]!);
    limits.checkPositions(measuredPositions, LAYOUT, limits.feedbackTolerance);
    const [lowerBounds, upperBounds] = limits.bounds(startVector);
    const shiftedLowerBounds = lowerBounds.map((bound, index) => minimum(bound, measuredPositions[index]!));
    const shiftedUpperBounds = upperBounds.map((bound, index) => maximum(bound, measuredPositions[index]!));

    const tolerance = this.BOUND_TOLERANCE;
    for (const point of this.pathPoints(move, startVector)) {
      const shiftedPoint = point.map((value, index) => value + offsetVector[index]!);
      if (
        point.some((value, index) => value < lowerBounds[index]! - tolerance) ||
        point.some((value, index) => value > upperBounds[index]! + tolerance) ||
        shiftedPoint.some((value, index) => value < shiftedLowerBounds[index]! - tolerance) ||
        shiftedPoint.some((value, index) => value > shiftedUpperBounds[index]! + tolerance)
      ) {
        throw new ValueError("Home path leaves the joint bounds");
      }
    }
  }

  /**
   * Returns the action's arm delta (null when the arm holds) and what it asks of the gripper: true opens, false
   * closes, null leaves it.
   */
  static actionParts(action: unknown): [SingleArmDelta | null, boolean | null] {
    if (SingleArmDelta.isInstance(action)) {
      const width = action.gripper.width;
      // Python's any() of the arm's quantities: a zero of either sign is no change
      const armDelta = Object.values(action.arm).some((value) => value !== 0) ? action : null;
      return [armDelta, width === 0 ? null : width > 0];
    }
    if (GripperAction.isInstance(action)) {
      return [null, action.command === "open"];
    }
    throw new ValueError("Expected a pose delta or gripper action");
  }

  /** Returns the pose a delta is added to: the held command while the arm tracks it. */
  static deltaBase(
    robotConfig: Pick<SO101RobotConfig, "position_tolerance">,
    measuredPositions: number[],
    commandedPositions: number[],
  ): number[] {
    // servos sit slightly short of their goals under gravity, so adding each delta to the measured pose would creep
    // the arm down; once any joint is off by more than the arrival tolerance the arm is blocked, and the measured
    // pose is used so that commands never wind up
    const isTracking = measuredPositions
      .slice(0, GRIPPER_INDEX)
      .every((measured, index) => Math.abs(measured - commandedPositions[index]!) <= robotConfig.position_tolerance);

    return isTracking ? commandedPositions : measuredPositions;
  }
}
