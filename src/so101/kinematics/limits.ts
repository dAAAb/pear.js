// Ports the position bounds of pear/deploy/station/control/joint/limits.py (`JointLimits.check_positions` and what
// it calls) and `RobotConfig.joint_limits` of pear/deploy/station/control/joint/config.py for the SO-101's one arm.
// The motion caps, the bounds of a streamed command and of a trajectory belong to the station's motion execution.

import type { SO101Config } from "../config";
import type { JointLayout } from "../layout";
import { ValueError } from "./errors";
import { formatTemplate } from "./text";

/** A robot's joint bounds, one value for each coordinate of its joint vector. */
export class JointLimits {
  /** Rounding slack of every bound comparison. */
  static readonly EPSILON = 1e-9;

  constructor(
    readonly lowerBounds: readonly number[],
    readonly upperBounds: readonly number[],
    /** How far measured feedback may rest outside the bounds. */
    readonly feedbackTolerance: number,
  ) {}

  /** Returns the limits of the joint vector of the SO-101 whose settings are `config`. */
  static fromConfig(config: Pick<SO101Config, "limits" | "feedback_position_tolerance">): JointLimits {
    return new JointLimits(
      [...config.limits.lower_bounds],
      [...config.limits.upper_bounds],
      config.feedback_position_tolerance,
    );
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
    const outside = values.flatMap((value, index) =>
      value < lowerBounds[index]! - allowance - epsilon || value > upperBounds[index]! + allowance + epsilon ? [index] : [],
    );

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
