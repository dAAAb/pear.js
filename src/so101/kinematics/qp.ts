// The quadratic program of one solver step: minimize 1/2 x'Hx - g'x within a box, H symmetric positive definite.
// placo hands its program to a general QP solver (eiquadprog); the minimum of a strictly convex program is unique,
// so any exact method returns the same point. Here the constraints are bounds alone, and a primal active-set method
// over at most a handful of variables is enough.

import { solveLinear } from "./linalg";

type Matrix = readonly (readonly number[])[];

// how far a multiplier may have the wrong sign, relative to the terms it is the difference of, before its bound is
// released: above the rounding of that difference, far below any multiplier that matters
const MULTIPLIER_TOLERANCE = 1e-10;

const FREE = 0;
const AT_LOWER = -1;
const AT_UPPER = 1;

/**
 * Returns the minimizer of `1/2 x'Hx - g'x` over `lower <= x <= upper`.
 * `hessian` must be symmetric positive definite and `lower <= upper` in every coordinate.
 */
export function solveBoxQp(
  hessian: Matrix,
  gradient: readonly number[],
  lower: readonly number[],
  upper: readonly number[],
): number[] {
  const size = gradient.length;
  // the unconstrained minimum, which most steps away from the joint limits take
  const unconstrained = solveLinear(hessian, gradient);
  if (unconstrained.every((value, index) => value >= lower[index]! && value <= upper[index]!)) {
    return unconstrained;
  }

  const point = lower.map((bound, index) => Math.min(Math.max(0, bound), upper[index]!));
  const states = new Array<number>(size).fill(FREE);

  for (let iteration = 0; iteration < 20 * (size + 1); iteration++) {
    const free = states.flatMap((state, index) => (state === FREE ? [index] : []));
    if (free.length > 0) {
      const target = faceMinimizer(hessian, gradient, point, free);
      // the longest step toward the face's minimum that stays inside the box, and the bound that stops it
      let step = 1;
      let blocking = -1;
      let blockingState = FREE;
      free.forEach((index, position) => {
        const change = target[position]! - point[index]!;
        if (change > 0 && point[index]! + step * change > upper[index]!) {
          step = (upper[index]! - point[index]!) / change;
          [blocking, blockingState] = [index, AT_UPPER];
        } else if (change < 0 && point[index]! + step * change < lower[index]!) {
          step = (lower[index]! - point[index]!) / change;
          [blocking, blockingState] = [index, AT_LOWER];
        }
      });
      free.forEach((index, position) => {
        point[index] = step === 1 ? target[position]! : point[index]! + step * (target[position]! - point[index]!);
      });
      if (blocking >= 0) {
        point[blocking] = blockingState === AT_UPPER ? upper[blocking]! : lower[blocking]!;
        states[blocking] = blockingState;
        continue;
      }
    }

    // at the minimum of the face: a bound whose multiplier pushes inward is released, the worst first
    let worst = -1;
    let worstViolation = 0;
    for (let index = 0; index < size; index++) {
      if (states[index] === FREE) {
        continue;
      }
      const [slope, magnitude] = slopeAt(hessian, gradient, point, index);
      const violation = states[index] === AT_LOWER ? -slope : slope;
      if (violation > MULTIPLIER_TOLERANCE * magnitude && violation > worstViolation) {
        [worst, worstViolation] = [index, violation];
      }
    }
    if (worst < 0) {
      return point;
    }
    states[worst] = FREE;
  }

  // the active-set walk ends in a few steps; rounding that keeps it turning is answered by trying every face
  return solveBoxQpByEnumeration(hessian, gradient, lower, upper);
}

/**
 * Returns the same minimizer by trying every combination of free and fixed coordinates: 3 ** n small systems. It
 * checks `solveBoxQp` in the tests and stands in for it should its walk not end.
 */
export function solveBoxQpByEnumeration(
  hessian: Matrix,
  gradient: readonly number[],
  lower: readonly number[],
  upper: readonly number[],
): number[] {
  const size = gradient.length;
  let best: number[] | null = null;
  let bestValue = Infinity;

  for (let code = 0; code < 3 ** size; code++) {
    const states = Array.from({ length: size }, (_, index) => (Math.floor(code / 3 ** index) % 3) - 1);
    const point = states.map((state, index) => (state === AT_LOWER ? lower[index]! : state === AT_UPPER ? upper[index]! : 0));
    const free = states.flatMap((state, index) => (state === FREE ? [index] : []));
    faceMinimizer(hessian, gradient, point, free).forEach((value, position) => {
      point[free[position]!] = value;
    });

    const isInside = point.every((value, index) => value >= lower[index]! - 1e-12 && value <= upper[index]! + 1e-12);
    const isStationary = states.every((state, index) => {
      if (state === FREE) {
        return true;
      }
      const [slope, magnitude] = slopeAt(hessian, gradient, point, index);
      return (state === AT_LOWER ? -slope : slope) <= MULTIPLIER_TOLERANCE * magnitude;
    });
    if (isInside && isStationary) {
      const value = objective(hessian, gradient, point);
      if (value < bestValue) {
        [best, bestValue] = [point, value];
      }
    }
  }

  if (best === null) {
    throw new Error("The quadratic program of a solver step has no minimum: its matrix is not positive definite");
  }
  return best.map((value, index) => Math.min(Math.max(value, lower[index]!), upper[index]!));
}

/** Returns the values of the `free` coordinates that minimize the objective while the others stay at `point`. */
function faceMinimizer(hessian: Matrix, gradient: readonly number[], point: readonly number[], free: readonly number[]): number[] {
  if (free.length === 0) {
    return [];
  }
  const isFree = point.map((_, index) => free.includes(index));
  const matrix = free.map((rowIndex) => free.map((columnIndex) => hessian[rowIndex]![columnIndex]!));
  const vector = free.map((rowIndex) => {
    let value = gradient[rowIndex]!;
    for (let index = 0; index < point.length; index++) {
      if (!isFree[index]) {
        value -= hessian[rowIndex]![index]! * point[index]!;
      }
    }
    return value;
  });

  return solveLinear(matrix, vector);
}

/** Returns the objective's slope along the coordinate `index` at `point`, and the size of the terms it sums. */
function slopeAt(hessian: Matrix, gradient: readonly number[], point: readonly number[], index: number): [number, number] {
  let slope = -gradient[index]!;
  let magnitude = Math.abs(gradient[index]!);
  for (let other = 0; other < point.length; other++) {
    const term = hessian[index]![other]! * point[other]!;
    slope += term;
    magnitude += Math.abs(term);
  }
  return [slope, magnitude];
}

function objective(hessian: Matrix, gradient: readonly number[], point: readonly number[]): number {
  let value = 0;
  for (let rowIndex = 0; rowIndex < point.length; rowIndex++) {
    let product = 0;
    for (let columnIndex = 0; columnIndex < point.length; columnIndex++) {
      product += hessian[rowIndex]![columnIndex]! * point[columnIndex]!;
    }
    value += point[rowIndex]! * (product / 2 - gradient[rowIndex]!);
  }
  return value;
}
