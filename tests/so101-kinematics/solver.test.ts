import { describe, expect, test } from "vitest";

import { ChainKinematics, SO101_CHAIN } from "../../src/so101/kinematics/chain";
import type { Matrix3, Vector3 } from "../../src/so101/kinematics/linalg";
import { solveBoxQp, solveBoxQpByEnumeration } from "../../src/so101/kinematics/qp";
import { frameTaskStep } from "../../src/so101/kinematics/solver";
import { meta, stepCases } from "./fixtures";

const steps = stepCases();
const { lower_bounds: lowerBounds, upper_bounds: upperBounds } = meta().limits;
const settings = { positionWeight: meta().kinematics.ik_weight, orientationWeight: meta().kinematics.ik_weight, lowerBounds, upperBounds };

describe("one step of the solver", () => {
  const chain = new ChainKinematics(SO101_CHAIN);
  const difference = (kind: string): number =>
    Math.max(
      ...steps
        .filter((step) => step.kind === kind)
        .map(({ joints, rotation, position, next }) => {
          const target = { rotation: rotation as Matrix3, position: position as Vector3 };
          const ours = frameTaskStep(chain, chain.state(joints), joints, target, settings);
          return Math.max(...ours.map((value, index) => Math.abs(value - next[index]!)));
        }),
    );

  // placo's joints are stored to twelve significant digits. A step toward a near pose is well conditioned and
  // agrees to the stored digits. A far pose throws the arm against its limits and through stretched poses, where the
  // step's matrix is nearly singular (its smallest eigenvalue nears the 1e-8 regularization), and a frame turned
  // nearly half a turn takes the square-root branch of the rotation vector: both amplify the last bits of the
  // arithmetic to about 1e-8 rad, which is five orders below the 1.5 mrad a servo resolves.
  test.each([
    ["far", 2e-8],
    ["near", 1e-10],
    ["half_turn", 2e-8],
  ])("equals placo's toward a %s pose", (kind, bound) => {
    expect(steps.filter((step) => step.kind === kind).length).toBeGreaterThanOrEqual(50);
    const worst = difference(kind);

    console.info(`step (${kind}): largest joint difference from placo's ${worst.toExponential(1)} rad`);
    expect(worst).toBeLessThan(bound);
  });

  test("the fixture's steps end on a limit, start past one, and move freely", () => {
    const onLimit = steps.filter(({ next }) =>
      next.some((value, index) => Math.abs(value - lowerBounds[index]!) < 1e-9 || Math.abs(value - upperBounds[index]!) < 1e-9),
    );
    const pastLimit = steps.filter(({ joints }) =>
      joints.some((value, index) => value < lowerBounds[index]! || value > upperBounds[index]!),
    );

    expect(onLimit.length).toBeGreaterThan(20);
    expect(pastLimit.length).toBeGreaterThan(10);
    expect(steps.length - onLimit.length).toBeGreaterThan(20);
  });
});

describe("the bounded quadratic program", () => {
  // a small generator with a fixed seed, so that the problems are the same in every run
  let seed = 12345;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  test("the active-set walk finds the minimum that trying every face finds", () => {
    let worst = 0;
    let bounded = 0;

    for (let problem = 0; problem < 2000; problem++) {
      const size = 1 + Math.floor(random() * 5);
      // H = A'A + a small diagonal, as a step's matrix is; some of them nearly singular
      const rows = Array.from({ length: size + 1 }, () => Array.from({ length: size }, () => 2 * random() - 1));
      if (problem % 4 === 0) {
        rows.forEach((row) => {
          row[0] = row[size - 1]! * (1 + 1e-4 * random());
        });
      }
      const hessian = Array.from({ length: size }, (_, first) =>
        Array.from({ length: size }, (_, second) =>
          rows.reduce((sum, row) => sum + row[first]! * row[second]!, first === second ? 1e-8 : 0),
        ),
      );
      const gradient = Array.from({ length: size }, () => 2 * random() - 1);
      const centre = Array.from({ length: size }, () => 2 * random() - 1);
      const lower = centre.map((value) => value - random());
      const upper = centre.map((value) => value + random());

      const walked = solveBoxQp(hessian, gradient, lower, upper);
      const tried = solveBoxQpByEnumeration(hessian, gradient, lower, upper);
      const value = (point: number[]): number =>
        point.reduce(
          (sum, coordinate, index) =>
            sum + coordinate * (hessian[index]!.reduce((product, entry, other) => product + entry * point[other]!, 0) / 2 - gradient[index]!),
          0,
        );

      expect(walked.every((coordinate, index) => coordinate >= lower[index]! - 1e-12 && coordinate <= upper[index]! + 1e-12)).toBe(true);
      // the two minima have the same value; where the matrix is nearly singular the point itself is loosely held
      expect(Math.abs(value(walked) - value(tried))).toBeLessThanOrEqual(1e-9 * (1 + Math.abs(value(tried))));
      if (problem % 4 !== 0) {
        worst = Math.max(worst, ...walked.map((coordinate, index) => Math.abs(coordinate - tried[index]!)));
      }
      if (walked.some((coordinate, index) => coordinate === lower[index] || coordinate === upper[index])) {
        bounded += 1;
      }
    }

    expect(worst).toBeLessThan(1e-7);
    expect(bounded).toBeGreaterThan(1000);
  });
});
