// Ports pear/deploy/station/control/joint/limits.py, with the body of `RobotConfig.joint_limits`
// (pear/deploy/station/control/joint/config.py), which builds the limits of the joint vector from each arm's.

import { formatTemplate } from "../../so101/kinematics/text";
import { ValueError, ZeroDivisionError } from "./errors";
import type { JointLayout } from "./layout";
import { broadcastPair, integerPower, maximum, minimum, pythonMin } from "./numeric";

/** The velocity, acceleration and jerk caps of one arm's coordinates, which bound a move's own: PEAR's MotionLimits. */
export interface MotionCaps {
  readonly velocity?: readonly number[] | null;
  readonly acceleration?: readonly number[] | null;
  readonly jerk?: readonly number[] | null;
}

/** The fields of PEAR's JointLimits: one value for each coordinate of the joint vector. */
export interface JointLimitValues {
  readonly lowerBounds: readonly number[];
  readonly upperBounds: readonly number[];
  readonly velocity: readonly number[];
  readonly acceleration: readonly number[];
  readonly jerk: readonly number[];
  readonly trackingError: readonly number[];
  /** A controlled STOP brakes with these. */
  readonly stopAcceleration: readonly number[];
  readonly stopJerk: readonly number[];
  /** How far measured feedback may rest outside the bounds. */
  readonly feedbackTolerance: number;
}

/** One arm's limits as a station's settings hold them, under PEAR's keys. */
export interface ArmLimitSettings {
  readonly lower_bounds: readonly number[];
  readonly upper_bounds: readonly number[];
  readonly velocity: readonly number[];
  readonly acceleration: readonly number[];
  readonly jerk: readonly number[];
  readonly tracking_error: readonly number[];
  /** A controlled STOP brakes with these; null or absent: with the move caps. */
  readonly stop_acceleration?: readonly number[] | null;
  readonly stop_jerk?: readonly number[] | null;
}

/** One arm's limits with the caps its controlled STOP brakes with, as `RobotConfig.joint_limits` reads them. */
export interface ArmLimits extends ArmLimitSettings {
  /** Returns the acceleration and jerk caps a controlled STOP brakes with. */
  brakingCaps(): [readonly number[], readonly number[]];
}

/** What the bounds check reads of a Ruckig trajectory: the extrema of each coordinate's position along it. */
export interface TrajectoryExtrema {
  readonly positionExtrema: readonly { readonly min: number; readonly max: number }[];
}

/**
 * Returns the acceleration and jerk caps a controlled STOP brakes with under `limits`: the STOP caps, a move's where
 * they are unset (an empty list is unset too, as in Python).
 */
export function brakingCapsOf(limits: ArmLimitSettings): [readonly number[], readonly number[]] {
  const stopAcceleration = limits.stop_acceleration;
  const stopJerk = limits.stop_jerk;

  return [
    stopAcceleration != null && stopAcceleration.length > 0 ? stopAcceleration : limits.acceleration,
    stopJerk != null && stopJerk.length > 0 ? stopJerk : limits.jerk,
  ];
}

function frozenCopy(values: readonly number[]): readonly number[] {
  return Object.freeze([...values]);
}

/** A robot's joint bounds and motion caps, one value for each coordinate of its joint vector. */
export class JointLimits implements JointLimitValues {
  /** Rounding slack of every bound comparison. */
  static readonly EPSILON = 1e-9;
  /** The motion caps, in the order of their derivatives. */
  static readonly CAP_NAMES = ["velocity", "acceleration", "jerk"] as const;

  readonly lowerBounds: readonly number[];
  readonly upperBounds: readonly number[];
  readonly velocity: readonly number[];
  readonly acceleration: readonly number[];
  readonly jerk: readonly number[];
  readonly trackingError: readonly number[];
  readonly stopAcceleration: readonly number[];
  readonly stopJerk: readonly number[];
  readonly feedbackTolerance: number;

  /** The limits with every field of PEAR's JointLimits. */
  constructor(values: JointLimitValues);
  /**
   * The position bounds alone, as the kinematics read them: the motion caps, the tracking bounds and the STOP caps
   * are empty, so that `motionCaps` and `brakingCaps` give empty lists.
   */
  constructor(lowerBounds: readonly number[], upperBounds: readonly number[], feedbackTolerance: number);
  constructor(
    first: JointLimitValues | readonly number[],
    upperBounds: readonly number[] = [],
    feedbackTolerance = 0.0,
  ) {
    const values: JointLimitValues = Array.isArray(first)
      ? {
          lowerBounds: first as readonly number[],
          upperBounds,
          velocity: [],
          acceleration: [],
          jerk: [],
          trackingError: [],
          stopAcceleration: [],
          stopJerk: [],
          feedbackTolerance,
        }
      : (first as JointLimitValues);

    this.lowerBounds = frozenCopy(values.lowerBounds);
    this.upperBounds = frozenCopy(values.upperBounds);
    this.velocity = frozenCopy(values.velocity);
    this.acceleration = frozenCopy(values.acceleration);
    this.jerk = frozenCopy(values.jerk);
    this.trackingError = frozenCopy(values.trackingError);
    this.stopAcceleration = frozenCopy(values.stopAcceleration);
    this.stopJerk = frozenCopy(values.stopJerk);
    this.feedbackTolerance = values.feedbackTolerance;
  }

  /**
   * Returns the arms' limits as the limits of the joint vector, arm after arm (the body of PEAR's
   * `RobotConfig.joint_limits`); `armLimits` are in the order of the layout's arms.
   */
  static fromArms(armLimits: readonly ArmLimits[], feedbackTolerance: number): JointLimits {
    const brakingCaps = armLimits.map((limits) => limits.brakingCaps());

    return new JointLimits({
      lowerBounds: armLimits.flatMap((limits) => [...limits.lower_bounds]),
      upperBounds: armLimits.flatMap((limits) => [...limits.upper_bounds]),
      velocity: armLimits.flatMap((limits) => [...limits.velocity]),
      acceleration: armLimits.flatMap((limits) => [...limits.acceleration]),
      jerk: armLimits.flatMap((limits) => [...limits.jerk]),
      trackingError: armLimits.flatMap((limits) => [...limits.tracking_error]),
      stopAcceleration: brakingCaps.flatMap(([acceleration]) => [...acceleration]),
      stopJerk: brakingCaps.flatMap(([, jerk]) => [...jerk]),
      feedbackTolerance,
    });
  }

  /**
   * Returns the limits of the joint vector of a robot with one arm from its settings as a station's file holds them:
   * what `fromArms` gives for that arm, its STOP braking with the STOP caps where the settings give them.
   */
  static fromConfig(config: {
    readonly limits: ArmLimitSettings;
    readonly feedback_position_tolerance: number;
  }): JointLimits {
    const limits = config.limits;

    return JointLimits.fromArms(
      [{ ...limits, brakingCaps: () => brakingCapsOf(limits) }],
      config.feedback_position_tolerance,
    );
  }

  /**
   * Returns the velocity, acceleration and jerk caps, within `caps` (one arm's values, for every arm), time-scaled by
   * `speedScale`.
   */
  motionCaps(speedScale = 1.0, caps: MotionCaps | null = null): number[][] {
    if (!Number.isFinite(speedScale) || !(0 < speedScale && speedScale <= 1)) {
      throw new ValueError("Speed scale must be finite and within (0, 1]");
    }

    return JointLimits.CAP_NAMES.map((name, nameIndex) => {
      const armCaps = caps !== null ? (caps[name] ?? null) : null;
      // a motion slowed to `speedScale` of its speed has that share of its velocity, its square of its acceleration
      // and its cube of its jerk
      const scale = integerPower(speedScale, nameIndex + 1);

      return this[name].map((cap, index) => {
        if (armCaps === null) {
          return cap * scale;
        }
        if (armCaps.length === 0) {
          throw new ZeroDivisionError("integer modulo by zero");
        }
        return pythonMin(cap, armCaps[index % armCaps.length] as number) * scale;
      });
    });
  }

  /** Returns the acceleration and jerk caps of a controlled STOP. */
  brakingCaps(): [readonly number[], readonly number[]] {
    return [this.stopAcceleration, this.stopJerk];
  }

  /** Throws unless `vector` lies within the bounds, widened by `tolerance` for measured feedback. */
  checkPositions(vector: ArrayLike<number>, layout: JointLayout, tolerance = 0.0): void {
    const texts = layout.texts;

    this.checkBounds(
      layout.vector(vector),
      this.lowerBounds,
      this.upperBounds,
      tolerance,
      layout,
      texts.outside_bounds,
      texts.outside_bounds_coordinate,
    );
  }

  /** Throws if `target` lies outside a bound and further outside it than `previousTarget`. */
  checkCommand(target: ArrayLike<number>, previousTarget: ArrayLike<number>, layout: JointLayout): void {
    const [lowerBounds, upperBounds] = this.bounds(layout.vector(previousTarget));
    const texts = layout.texts;

    this.checkBounds(
      layout.vector(target),
      lowerBounds,
      upperBounds,
      0.0,
      layout,
      texts.command_outside_bounds,
      texts.command_outside_bounds_coordinate,
    );
  }

  /** Throws if the position extrema of `trajectory` leave the bounds for a motion from `start`. */
  checkTrajectory(trajectory: TrajectoryExtrema, start: ArrayLike<number>): void {
    const [lowerBounds, upperBounds] = this.bounds(start);
    const epsilon = JointLimits.EPSILON;
    const extrema = trajectory.positionExtrema;
    const count = Math.min(extrema.length, lowerBounds.length, upperBounds.length);

    for (let index = 0; index < count; index++) {
      const extremum = extrema[index]!;
      if (extremum.min < lowerBounds[index]! - epsilon || extremum.max > upperBounds[index]! + epsilon) {
        throw new ValueError("Ruckig trajectory crosses a position limit");
      }
    }
  }

  /**
   * Returns the position bounds for a motion from `start`, which may rest outside a limit and move only inward: the
   * lower and the upper bounds.
   */
  bounds(start: ArrayLike<number>): [number[], number[]] {
    const [lowerBounds, lowerStart] = broadcastPair(this.lowerBounds, start);
    const [upperBounds, upperStart] = broadcastPair(this.upperBounds, start);

    return [
      lowerBounds.map((bound, index) => minimum(bound, lowerStart[index]!)),
      upperBounds.map((bound, index) => maximum(bound, upperStart[index]!)),
    ];
  }

  /** Throws the robot's message for the first arm of which a value lies outside its bounds by more than `allowance`. */
  private checkBounds(
    values: readonly number[],
    lowerBounds: readonly number[],
    upperBounds: readonly number[],
    allowance: number,
    layout: JointLayout,
    messageTemplate: string,
    coordinateTemplate: string,
  ): void {
    const epsilon = JointLimits.EPSILON;
    const coordinateCount = layout.coordinateCount;
    const outside = values.flatMap((value, index) => {
      const isBelow = value < lowerBounds[index]! - allowance - epsilon;
      const isAbove = value > upperBounds[index]! + allowance + epsilon;

      return isBelow || isAbove ? [index] : [];
    });

    layout.arms.forEach((arm, armIndex) => {
      const indices = outside.filter((index) => Math.floor(index / coordinateCount) === armIndex);
      if (indices.length > 0) {
        const details = indices
          .map((index) =>
            formatTemplate(coordinateTemplate, {
              axis: layout.texts.bound_axes[index % coordinateCount]!,
              value: values[index]!,
              unit: layout.axisUnit(index),
              lower: lowerBounds[index]!,
              upper: upperBounds[index]!,
              allowance,
            }),
          )
          .join("; ");
        throw new ValueError(formatTemplate(messageTemplate, { arm, details }));
      }
    });
  }
}
