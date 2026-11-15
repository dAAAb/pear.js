// Ports pear/deploy/station/control/joint/feedforward.py.

import { PythonTypeError, ValueError } from "./errors";
import { broadcastPair, clip } from "./numeric";

/**
 * The signed friction feedforward of each joint, which follows the planned velocity: it ramps in, stays latched
 * after the plan stops and then fades.
 */
export class FrictionFeedforward {
  /** The planned speed above which a joint counts as moving, rad/s. */
  static readonly MIN_MOVING_SPEED: number = 0.005;
  /** How long the feedforward stays after the plan stops, s. */
  static readonly LATCH_S: number = 0.2;
  /** How long it then takes to fade out, s. */
  static readonly FADE_S: number = 0.3;
  /** How long engaging and reversing take, so that no step reaches the motors, s. */
  static readonly ENGAGE_S: number = 0.05;
  /** The most one update advances the ramps, s: a stalled caller must not advance them by a whole stall. */
  static readonly MAX_STEP_S: number = 0.1;

  /** Each joint's feedforward at no load, in its user's unit (a torque or a goal offset). */
  readonly magnitude: number[];
  /** What each unit of the gravity load the joint carries adds to it (gearbox friction). */
  readonly loadRatio: number[];
  /** The signed fraction of the magnitude, in [-1, 1]. */
  level!: number[];
  direction!: number[];
  movedAt!: number[];
  updatedAt: number | null = null;

  constructor(magnitude: ArrayLike<number>, loadRatio: ArrayLike<number>) {
    [this.magnitude, this.loadRatio] = this.constants.checkedValues(magnitude, loadRatio);
    this.reset();
  }

  /** The class of this feedforward, whose constants and whose check of the values a robot's own class may replace. */
  private get constants(): typeof FrictionFeedforward {
    return this.constructor as typeof FrictionFeedforward;
  }

  /** Forgets every joint's motion: no feedforward until the plan moves again. */
  reset(): void {
    const jointCount = this.magnitude.length;
    this.level = new Array<number>(jointCount).fill(0);
    this.direction = new Array<number>(jointCount).fill(0);
    this.movedAt = new Array<number>(jointCount).fill(-Infinity);
    this.updatedAt = null;
  }

  /** Advances to `now`, s, and returns each joint's feedforward for the gravity load it carries. */
  update(
    plannedVelocity: ArrayLike<number> | null | undefined,
    now: number,
    load: ArrayLike<number> | null | undefined,
  ): number[] {
    const constants = this.constants;
    // the sign comes from the plan, never from the measured velocity, which chatters around zero at rest
    const velocity = this.jointVelocity(plannedVelocity);
    const jointLoad = this.jointLoad(load);
    const elapsedS = this.updatedAt === null ? 0.0 : clip(now - this.updatedAt, 0.0, constants.MAX_STEP_S);
    this.updatedAt = now;

    velocity.forEach((speed, joint) => {
      if (Math.abs(speed) > constants.MIN_MOVING_SPEED) {
        this.direction[joint] = Math.sign(speed);
        this.movedAt[joint] = now;
      }
    });
    this.level = this.level.map((level, joint) => {
      const isLatched = now - this.movedAt[joint]! <= constants.LATCH_S;
      const targetLevel = isLatched ? this.direction[joint]! : 0.0;
      const rate = targetLevel !== 0 ? 1 / constants.ENGAGE_S : 1 / constants.FADE_S;

      return level + clip(targetLevel - level, -rate * elapsedS, rate * elapsedS);
    });

    if (jointLoad == null) {
      throw new PythonTypeError("bad operand type for abs(): 'NoneType'");
    }
    const [loadRatio, carried] = broadcastPair(this.loadRatio, jointLoad);
    const [magnitude, loadShare] = broadcastPair(
      this.magnitude,
      loadRatio.map((ratio, joint) => ratio * Math.abs(carried[joint]!)),
    );
    const [strength, level] = broadcastPair(
      magnitude.map((value, joint) => value + loadShare[joint]!),
      this.level,
    );

    return strength.map((value, joint) => value * level[joint]!);
  }

  /**
   * Returns the planned velocity of each joint: zeros when it is missing or malformed, so that the feedforward
   * fades.
   */
  jointVelocity(plannedVelocity: ArrayLike<number> | null | undefined): number[] {
    return this.jointValues(plannedVelocity);
  }

  /** Returns the gravity load each joint carries: zeros when it is missing or malformed. */
  jointLoad(load: ArrayLike<number> | null | undefined): ArrayLike<number> | null | undefined {
    return this.jointValues(load);
  }

  /** Returns `values` as one finite number for each joint: zeros when they are missing or malformed. */
  private jointValues(values: ArrayLike<number> | null | undefined): number[] {
    if (values != null) {
      const array = Array.from(values);
      if (array.length === this.magnitude.length && array.every(Number.isFinite)) {
        return array;
      }
    }

    return new Array<number>(this.magnitude.length).fill(0);
  }

  /**
   * Returns each joint's magnitude and load ratio, refused unless both are finite and non-negative, one for each
   * joint.
   */
  static checkedValues(magnitude: ArrayLike<number>, loadRatio: ArrayLike<number>): [number[], number[]] {
    const magnitudeValues = Array.from(magnitude);
    if (magnitudeValues.some((value) => value < 0) || !magnitudeValues.every(Number.isFinite)) {
      throw new ValueError("Friction torques must be finite and non-negative");
    }
    const loadRatioValues = Array.from(loadRatio);
    if (
      loadRatioValues.length !== magnitudeValues.length ||
      !(loadRatioValues.every(Number.isFinite) && loadRatioValues.every((value) => value >= 0))
    ) {
      throw new ValueError("Friction load ratios must be finite, non-negative, one per joint");
    }

    return [magnitudeValues, loadRatioValues];
  }
}
