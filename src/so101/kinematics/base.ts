// Ports pear/deploy/station/control/motion/kinematics.py

import { UnreachablePoseError } from "./errors";
import type { Matrix3 } from "./linalg";
import { formatFixed } from "./text";

type ErrorClass = abstract new (...parameters: never[]) => Error;

/**
 * The base of a robot's kinematics: what the model reads of the measured joints, and the parts of a solve that need
 * no model of an arm.
 */
export abstract class BaseKinematics {
  /** Halvings of a requested increment when reporting how far an arm can go. */
  static readonly REACH_BISECTIONS: number = 7;
  /** The errors of a solve that count as out of reach while the reachable fraction of an increment is sought. */
  static readonly UNREACHABLE_ERRORS: readonly ErrorClass[] = [UnreachablePoseError];

  /** Returns what the model reads of the measured `jointPositions`, rounded the way it is shown. */
  abstract quantities(jointPositions: ArrayLike<number>): unknown;

  /** Returns the largest fraction of a requested increment that `solve` solves, found by bisection. */
  static reachableFraction(solve: (fraction: number) => unknown): number {
    let [lowFraction, highFraction] = [0.0, 1.0];

    for (let bisection = 0; bisection < this.REACH_BISECTIONS; bisection++) {
      const middleFraction = (lowFraction + highFraction) / 2;
      try {
        solve(middleFraction);
        lowFraction = middleFraction;
      } catch (error) {
        if (!this.UNREACHABLE_ERRORS.some((errorClass) => error instanceof errorClass)) {
          throw error;
        }
        highFraction = middleFraction;
      }
    }

    return lowFraction;
  }

  /** Returns the angle between two rotations, each a 3x3 matrix in row-major order. */
  static rotationDistance(firstRotation: Readonly<Matrix3>, secondRotation: Readonly<Matrix3>): number {
    // the trace of first' * second, summed in numpy's order
    let productTrace = 0;
    for (let column = 0; column < 3; column++) {
      productTrace +=
        firstRotation[column]! * secondRotation[column]! +
        firstRotation[3 + column]! * secondRotation[3 + column]! +
        firstRotation[6 + column]! * secondRotation[6 + column]!;
    }

    return Math.acos(Math.min(Math.max((productTrace - 1) / 2, -1), 1));
  }

  /** Returns `value` truncated toward zero to `decimals` places, as text with its sign. */
  static truncatedText(value: number, decimals: number): string {
    const truncated = Math.trunc(value * 10 ** decimals) / 10 ** decimals;

    // an unsigned zero: "+0.0 of -2" would read as the opposite direction
    return truncated !== 0 ? formatFixed(truncated, decimals, true) : formatFixed(0, decimals);
  }
}
