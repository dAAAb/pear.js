// Ports pear/deploy/station/control/motion/planning.py: PreparedAction, HomePlanningError, HomePlanning.

import { AttributeError, ValueError } from "../../python/errors";
import type { ControlConfig, RobotConfig } from "../joint/config";
import type { JointLayout } from "../joint/layout";
import { JointLimits } from "../joint/limits";
import { maximum, minimum } from "../joint/numeric";
import { allClose } from "../joint/recovery";
import { SnapshotCheck, type VectorSnapshot } from "../joint/snapshot_checks";
import { GripperProfile, JointMove } from "../joint/trajectory";

/** What the planning reads of an observation: the measured joints and, of its snapshot, the held targets. */
export interface PlanningObservation {
  readonly joint_positions: ArrayLike<number>;
  readonly control_snapshot: VectorSnapshot;
}

/** A validated action: what its grippers are asked to do and its arm move, each if the action has one. */
export class PreparedAction<GripperRequest = unknown> {
  constructor(
    /** What the robot's gripper operation is asked for; null: no gripper moves. */
    readonly gripperRequest: GripperRequest | null,
    /** null: the arms hold. */
    readonly move: JointMove | null,
  ) {}
}

/** Raised when the direct return to Home cannot be validated. */
export class HomePlanningError extends ValueError {
  override readonly name: string = "HomePlanningError";
}

/** Python's error of reading `attribute` of a section the settings leave out (None). */
function missingSection(attribute: string): AttributeError {
  return new AttributeError(`'NoneType' object has no attribute '${attribute}'`);
}

/**
 * What the planning of every robot's direct return to Home shares: the move with its check against the position
 * bounds, the recheck once the grippers have opened, and how long a plan says Home takes.
 *
 * PEAR's class methods call each other through the class they were called on (`cls`): here through `this`, so that
 * a robot's planning that overrides one of them is the one called.
 */
export class HomePlanning {
  /** Between the approved and the current targets. */
  static readonly TARGET_TOLERANCE: number = 1e-8;
  /** Below this a Home move is not needed. */
  static readonly MOVE_TOLERANCE: number = 1e-10;
  /** The refusal of an approved move whose start the arms no longer hold. */
  static readonly TARGETS_CHANGED: string = "Home targets changed; check and confirm again";

  /**
   * Returns the checked direct move from the targets `start` to the targets `goal` at Home's speed, null when the
   * arms hold the goal already; `offset` is how far the measured joints are from the start.
   */
  static homeMove(
    robotConfig: RobotConfig,
    start: ArrayLike<number>,
    goal: ArrayLike<number>,
    offset: ArrayLike<number>,
  ): JointMove | null {
    const limits = robotConfig.jointLimits();
    const home = robotConfig.home;
    const startVector = Array.from(start, Number);
    const goalVector = Array.from(goal, Number);

    let move: JointMove | null = null;
    // numpy's max: a difference that is no number is the largest, and is not greater than the tolerance
    const distance = startVector.reduce(
      (largest, value, index) => maximum(Math.abs(value - goalVector[index]!), largest),
      -Infinity,
    );
    if (distance > this.MOVE_TOLERANCE) {
      if (home === null) {
        throw missingSection("speed_scale");
      }
      move = JointMove.build(startVector, goalVector, limits, robotConfig.LAYOUT, {
        speedScale: home.speed_scale,
        caps: home.limits,
      });
    }

    try {
      this.checkHomeBounds(robotConfig, move, startVector, offset);
    } catch (error) {
      if (error instanceof ValueError) {
        throw new HomePlanningError(`Direct Home move rejected: ${error.message}`, { cause: error });
      }
      throw error;
    }

    return move;
  }

  /**
   * Returns the entries of a Home plan that say how long Home takes: its move, its grippers' opening of `openingS`,
   * and the whole operation with the settling after each of the two.
   */
  static timeEstimates(
    controlConfig: ControlConfig,
    robotConfig: RobotConfig,
    move: JointMove | null,
    openingS: number,
    hasOpening: boolean,
  ): { trajectory_seconds: number; opening_seconds_estimate: number; operation_seconds_estimate: number } {
    const moveS = move !== null ? move.durationS : 0.0;
    if (robotConfig.home === null) {
      throw missingSection("settle_window_s");
    }
    const settleS = Math.max(controlConfig.settle_window_s, robotConfig.home.settle_window_s);

    return {
      trajectory_seconds: moveS,
      opening_seconds_estimate: openingS,
      operation_seconds_estimate: openingS + moveS + (Number(hasOpening) + Number(move !== null)) * settleS,
    };
  }

  /**
   * Throws unless the approved `move` still starts at the targets the arms hold in `observation`, taken once the
   * grippers have opened, and stays within the position bounds with its feedback.
   */
  static recheckHomeMove(robotConfig: RobotConfig, observation: PlanningObservation, move: JointMove | null): void {
    const measuredPositions = this.measuredPositions(observation, robotConfig.LAYOUT);
    const targets = SnapshotCheck.targetVector(observation.control_snapshot);
    if (move !== null && !allClose(targets, move.start, this.TARGET_TOLERANCE)) {
      throw new HomePlanningError(this.TARGETS_CHANGED);
    }

    this.checkHomeBounds(
      robotConfig,
      move,
      targets,
      measuredPositions.map((measured, index) => measured - targets[index]!),
    );
  }

  /**
   * Throws unless the planned motion from the targets `start` stays within the position bounds, also when the
   * offset of the measured joints shifts it.
   */
  static checkHomeBounds(
    robotConfig: RobotConfig,
    move: JointMove | null,
    start: ArrayLike<number>,
    offset: ArrayLike<number>,
  ): void {
    // a start held past a limit since enabling may only move inward; the measured pose may rest past a limit
    // within the feedback tolerance, and the shifted motion may not go beyond it
    const limits = robotConfig.jointLimits();
    const layout = robotConfig.LAYOUT;
    const startVector = Array.from(start, Number);
    const offsetVector = Array.from(offset, Number);
    const measuredPositions = startVector.map((value, index) => value + offsetVector[index]!);
    limits.checkPositions(measuredPositions, layout, limits.feedbackTolerance);
    const [lowerBounds, upperBounds] = limits.bounds(startVector);
    const shiftedLimits = new JointLimits({
      velocity: limits.velocity,
      acceleration: limits.acceleration,
      jerk: limits.jerk,
      trackingError: limits.trackingError,
      stopAcceleration: limits.stopAcceleration,
      stopJerk: limits.stopJerk,
      feedbackTolerance: limits.feedbackTolerance,
      lowerBounds: lowerBounds.map((bound, index) => minimum(bound, measuredPositions[index]!)),
      upperBounds: upperBounds.map((bound, index) => maximum(bound, measuredPositions[index]!)),
    });

    for (const point of this.pathPoints(move, startVector)) {
      limits.checkCommand(point, startVector, layout);
      shiftedLimits.checkPositions(
        point.map((value, index) => value + offsetVector[index]!),
        layout,
      );
    }
  }

  /**
   * Returns the points a Home path is checked at: the start when nothing moves, else the least and the greatest
   * position of each coordinate along the move, as Ruckig names them.
   */
  protected static pathPoints(move: JointMove | null, start: number[]): number[][] {
    if (move === null) {
      return [start];
    }
    const extrema = move.trajectory.positionExtrema;

    return [extrema.map((axis) => axis.min), extrema.map((axis) => axis.max)];
  }

  /** Returns the measured joint vector of `observation` with every gripper's opening within [0, 1]. */
  static measuredPositions(observation: Pick<PlanningObservation, "joint_positions">, layout: JointLayout): number[] {
    // the control loop accepts a gripper's feedback within its allowance: a reading just past an endpoint of the
    // opening is no commanded target
    const measuredPositions = Array.from(observation.joint_positions, Number);
    for (const gripperIndex of layout.gripperIndices) {
      // numpy's clip of one double: the bound it lies beyond, else itself (a zero keeps its sign, as numpy's does;
      // a reading that is no number stays none)
      const opening = measuredPositions[gripperIndex]!;
      measuredPositions[gripperIndex] = opening < 0 ? 0 : opening > 1 ? 1 : opening;
    }

    return measuredPositions;
  }

  /**
   * Whether a gripper opens before the arms return: its target or its measured opening is not the open endpoint.
   */
  static needsOpening(targetOpening: number, measuredOpening: number, gripperTolerance: number): boolean {
    return (
      Math.abs(targetOpening - GripperProfile.OPEN_ENDPOINT) > this.TARGET_TOLERANCE ||
      Math.abs(measuredOpening - GripperProfile.OPEN_ENDPOINT) > gripperTolerance
    );
  }
}
