// Ports pear/deploy/station/control/joint/tracking.py.

import { formatFixed, formatTemplate } from "../../so101/kinematics/text";
import { RuntimeError } from "./errors";
import { JointLayout } from "./layout";
import { broadcastPair } from "./numeric";

/** One joint further from its reference than its tolerance: its arm when the robot has several, itself, and how far. */
export interface TrackingViolation {
  side?: string;
  joint: string;
  error: number;
  limit: number;
  units: string;
}

/** The signed errors of the measured joints against a reference and the joints beyond a tolerance. */
export interface TrackingMetrics {
  signed_error: number[];
  violations: TrackingViolation[];
}

/** Whether the measured joints reached the requested ones, under the keys a snapshot's arrival carries. */
export interface ArrivalMetrics {
  reached: boolean;
  signed_error: number[];
  tolerance: number[];
}

/** Raised for measured joints too far from their held targets: a hard fault from the actual feedback. */
export class TrackingError extends RuntimeError {
  override readonly name: string = "TrackingError";

  constructor(metrics: Pick<TrackingMetrics, "violations">, layout: JointLayout) {
    const details = metrics.violations
      .map(
        (violation) =>
          `${JointLayout.axisName(violation as unknown as Record<string, unknown>)} error=` +
          `${formatFixed(violation.error, 6)} > ${formatFixed(violation.limit, 6)} ${violation.units}`,
      )
      .join("; ");
    super(formatTemplate(layout.texts.tracking_error_text, { details }));
  }
}

/** What the tracking reads of a robot's settings (a RobotConfig is one). */
export interface TrackingRobotSettings {
  readonly position_tolerance: number;
  readonly gripper_tolerance: number;
}

/** Measured joints against their targets: hard tracking faults and arrival within tolerance. */
export class Tracking {
  /** How close each coordinate of the joint vector is to its target at an arrival. */
  readonly arrivalTolerance: number[];
  /** How far each coordinate may be from its held target before it is a fault. */
  readonly faultBounds: number[];

  constructor(
    robotConfig: TrackingRobotSettings,
    limits: { readonly trackingError: readonly number[] },
    readonly layout: JointLayout,
  ) {
    const armTolerance = [
      ...new Array<number>(layout.jointCount).fill(robotConfig.position_tolerance),
      robotConfig.gripper_tolerance,
    ];
    this.arrivalTolerance = layout.arms.flatMap(() => armTolerance);
    this.faultBounds = [...limits.trackingError];
    // a gripper stopped on an object legitimately stays short of its target
    for (const gripperIndex of layout.gripperIndices) {
      this.faultBounds[gripperIndex] = Infinity;
    }
  }

  /** Throws a TrackingError if a joint is further from its target than its tracking bound. */
  check(measuredPositions: ArrayLike<number>, targets: ArrayLike<number>): void {
    const [measured, held] = broadcastPair(measuredPositions, targets);
    const [distances, bounds] = broadcastPair(
      measured.map((position, index) => Math.abs(position - held[index]!)),
      this.faultBounds,
    );
    if (distances.some((distance, index) => distance > bounds[index]!)) {
      throw new TrackingError(this.metrics(measuredPositions, targets, this.faultBounds), this.layout);
    }
  }

  /** Returns whether the measured joints reached the requested ones, independently of settling and faults. */
  arrival(measuredPositions: ArrayLike<number>, requestedPositions: ArrayLike<number>): ArrivalMetrics {
    const trackingMetrics = this.metrics(measuredPositions, requestedPositions, this.arrivalTolerance);

    return {
      reached: trackingMetrics.violations.length === 0,
      signed_error: trackingMetrics.signed_error,
      tolerance: [...this.arrivalTolerance],
    };
  }

  /** Returns the signed errors of the measured joints against `reference` and the joints beyond `tolerance`. */
  metrics(
    measuredPositions: ArrayLike<number>,
    reference: ArrayLike<number>,
    tolerance: readonly number[],
  ): TrackingMetrics {
    const [measured, referred] = broadcastPair(measuredPositions, reference);
    const errors = measured.map((position, index) => position - referred[index]!);
    const [distances, limits] = broadcastPair(errors.map(Math.abs), tolerance);
    const coordinateCount = this.layout.coordinateCount;

    const violations = distances.flatMap((distance, index) =>
      // not within the tolerance: a distance that is not a number counts too
      !(distance <= limits[index]!)
        ? [
            {
              ...this.layout.armAxisLabels(
                this.layout.arms[Math.floor(index / coordinateCount)]!,
                index % coordinateCount,
              ),
              error: distance,
              limit: limits[index]!,
              units: this.layout.axisUnit(index),
            } as TrackingViolation,
          ]
        : [],
    );

    return { signed_error: errors, violations };
  }
}
