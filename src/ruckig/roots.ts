// Ports include/ruckig/roots.hpp of Ruckig 0.15.3 (https://github.com/pantor/ruckig).
// Copyright (c) 2021 Lars Berscheid, MIT licence (see LICENSE in this folder).
//
// The names of the numbers are the C++'s, and every expression keeps the C++'s order of operations: the last digits
// of a root, and with them which profile is found valid, depend on it.

import { libm } from "./libm";
import { stdSort } from "./sort";

/** C's DBL_EPSILON, which is also std::numeric_limits<double>::epsilon(). */
export const DBL_EPSILON = 2.220446049250313e-16;

export function pow2(v: number): number {
  return v * v;
}

/** C++'s std::min: the first argument unless the second is smaller, so that a NaN in either place gives the first. */
export function min(a: number, b: number): number {
  return b < a ? b : a;
}

/** C++'s std::max: the first argument unless it is smaller than the second. */
export function max(a: number, b: number): number {
  return a < b ? b : a;
}

const lessThan = (first: number, second: number): boolean => first < second;

/** A set that keeps only the values that are not negative, and gives them in ascending order. */
export class PositiveSet {
  private readonly data: number[] = [];

  insert(value: number): void {
    if (value >= 0) {
      this.data.push(value);
    }
  }

  /** The values in ascending order: the C++ set sorts itself whenever it is read. */
  values(): readonly number[] {
    stdSort(this.data, lessThan);
    return this.data;
  }
}

/** A pair of numbers, ordered by its first and then by its second. */
export interface Pair {
  first: number;
  second: number;
}

const pairLessThan = (left: Pair, right: Pair): boolean =>
  left.first < right.first || (!(right.first < left.first) && left.second < right.second);

/** A set of pairs, given in ascending order. */
export class PairSet {
  private readonly data: Pair[] = [];

  insert(value: Pair): void {
    this.data.push(value);
  }

  /** The pairs in ascending order: the C++ set sorts itself whenever it is read. */
  values(): readonly Pair[] {
    stdSort(this.data, pairLessThan);
    return this.data;
  }
}

/** Calculate all roots of a*x^3 + b*x^2 + c*x + d = 0 */
export function solveCubic(a: number, b: number, c: number, d: number): PositiveSet {
  const roots = new PositiveSet();

  if (Math.abs(d) < DBL_EPSILON) {
    // First solution is x = 0
    roots.insert(0.0);

    // Converting to a quadratic equation
    d = c;
    c = b;
    b = a;
    a = 0.0;
  }

  if (Math.abs(a) < DBL_EPSILON) {
    if (Math.abs(b) < DBL_EPSILON) {
      // Linear equation
      if (Math.abs(c) > DBL_EPSILON) {
        roots.insert(-d / c);
      }
    } else {
      // Quadratic equation
      const discriminant = c * c - 4 * b * d;
      if (discriminant >= 0) {
        const inv2b = 1.0 / (2 * b);
        const y = Math.sqrt(discriminant);
        roots.insert((-c + y) * inv2b);
        roots.insert((-c - y) * inv2b);
      }
    }
  } else {
    // Cubic equation
    const inva = 1.0 / a;
    const invaa = inva * inva;
    const bb = b * b;
    const bover3a = b * inva / 3;
    const p = (a * c - bb / 3) * invaa;
    const halfq = (2 * bb * b - 9 * a * b * c + 27 * a * a * d) / 54 * invaa * inva;
    const yy = p * p * p / 27 + halfq * halfq;

    const cos120 = -0.50;
    const sin120 = 0.866025403784438646764;

    if (yy > DBL_EPSILON) {
      // Sqrt is positive: one real solution
      const y = Math.sqrt(yy);
      const uuu = -halfq + y;
      const vvv = -halfq - y;
      const www = Math.abs(uuu) > Math.abs(vvv) ? uuu : vvv;
      const w = libm.cbrt(www);
      roots.insert(w - p / (3 * w) - bover3a);
    } else if (yy < -DBL_EPSILON) {
      // Sqrt is negative: three real solutions
      const x = -halfq;
      const y = Math.sqrt(-yy);
      let theta;
      let r;

      // Convert to polar form
      if (Math.abs(x) > DBL_EPSILON) {
        theta = (x > 0.0) ? libm.atan(y / x) : (libm.atan(y / x) + Math.PI);
        r = Math.sqrt(x * x - yy);
      } else {
        // Vertical line
        theta = Math.PI / 2;
        r = y;
      }
      // Calculate cube root
      theta /= 3;
      r = 2 * libm.cbrt(r);
      // Convert to complex coordinate
      const ux = libm.cos(theta) * r;
      const uyi = libm.sin(theta) * r;

      roots.insert(ux - bover3a);
      roots.insert(ux * cos120 - uyi * sin120 - bover3a);
      roots.insert(ux * cos120 + uyi * sin120 - bover3a);
    } else {
      // Sqrt is zero: two real solutions
      const www = -halfq;
      const w = 2 * libm.cbrt(www);

      roots.insert(w - bover3a);
      roots.insert(w * cos120 - bover3a);
    }
  }
  return roots;
}

/**
 * Solve resolvent eqaution of corresponding Quartic equation
 * The input x must be of length 3
 * Number of zeros are returned
 */
export function solveResolvent(x: number[], a: number, b: number, c: number): number {
  const cos120 = -0.50;
  const sin120 = 0.866025403784438646764;

  a /= 3;
  const a2 = a * a;
  let q = a2 - b / 3;
  const r = (a * (2 * a2 - b) + c) / 2;
  const r2 = r * r;
  const q3 = q * q * q;

  if (r2 < q3) {
    const qsqrt = Math.sqrt(q);
    const t = min(max(r / (q * qsqrt), -1.0), 1.0);
    q = -2 * qsqrt;

    const theta = libm.acos(t) / 3;
    const ux = libm.cos(theta) * q;
    const uyi = libm.sin(theta) * q;
    x[0] = ux - a;
    x[1] = ux * cos120 - uyi * sin120 - a;
    x[2] = ux * cos120 + uyi * sin120 - a;
    return 3;
  } else {
    let A = -libm.cbrt(Math.abs(r) + Math.sqrt(r2 - q3));
    if (r < 0.0) {
      A = -A;
    }
    const B = (0.0 === A ? 0.0 : q / A);

    x[0] = (A + B) - a;
    x[1] = -(A + B) / 2 - a;
    x[2] = Math.sqrt(3) * (A - B) / 2;
    if (Math.abs(x[2]) < DBL_EPSILON) {
      x[2] = x[1];
      return 2;
    }

    return 1;
  }
}

/** Calculate all roots of the monic quartic equation: x^4 + a*x^3 + b*x^2 + c*x + d = 0 */
export function solveQuartMonic(a: number, b: number, c: number, d: number): PositiveSet {
  const roots = new PositiveSet();

  if (Math.abs(d) < DBL_EPSILON) {
    if (Math.abs(c) < DBL_EPSILON) {
      roots.insert(0.0);

      const D = a * a - 4 * b;
      if (Math.abs(D) < DBL_EPSILON) {
        roots.insert(-a / 2);
      } else if (D > 0.0) {
        const sqrtD = Math.sqrt(D);
        roots.insert((-a - sqrtD) / 2);
        roots.insert((-a + sqrtD) / 2);
      }
      return roots;
    }

    if (Math.abs(a) < DBL_EPSILON && Math.abs(b) < DBL_EPSILON) {
      roots.insert(0.0);
      roots.insert(-libm.cbrt(c));
      return roots;
    }
  }

  const a3 = -b;
  const b3 = a * c - 4 * d;
  const c3 = -a * a * d - c * c + 4 * b * d;

  const x3 = [0.0, 0.0, 0.0];
  const number_zeroes = solveResolvent(x3, a3, b3, c3);

  let y = x3[0];
  // Choosing Y with maximal absolute value.
  if (number_zeroes !== 1) {
    if (Math.abs(x3[1]) > Math.abs(y)) {
      y = x3[1];
    }
    if (Math.abs(x3[2]) > Math.abs(y)) {
      y = x3[2];
    }
  }

  let q1, q2, p1, p2;

  let D = y * y - 4 * d;
  if (Math.abs(D) < DBL_EPSILON) {
    q1 = q2 = y / 2;
    D = a * a - 4 * (b - y);
    if (Math.abs(D) < DBL_EPSILON) {
      p1 = p2 = a / 2;
    } else {
      const sqrtD = Math.sqrt(D);
      p1 = (a + sqrtD) / 2;
      p2 = (a - sqrtD) / 2;
    }
  } else {
    const sqrtD = Math.sqrt(D);
    q1 = (y + sqrtD) / 2;
    q2 = (y - sqrtD) / 2;
    p1 = (a * q1 - c) / (q1 - q2);
    p2 = (c - a * q2) / (q1 - q2);
  }

  const eps = 16 * DBL_EPSILON;

  D = p1 * p1 - 4 * q1;
  if (Math.abs(D) < eps) {
    roots.insert(-p1 / 2);
  } else if (D > 0.0) {
    const sqrtD = Math.sqrt(D);
    roots.insert((-p1 - sqrtD) / 2);
    roots.insert((-p1 + sqrtD) / 2);
  }

  D = p2 * p2 - 4 * q2;
  if (Math.abs(D) < eps) {
    roots.insert(-p2 / 2);
  } else if (D > 0.0) {
    const sqrtD = Math.sqrt(D);
    roots.insert((-p2 - sqrtD) / 2);
    roots.insert((-p2 + sqrtD) / 2);
  }

  return roots;
}

/** Calculate the quartic equation: x^4 + b*x^3 + c*x^2 + d*x + e = 0 */
export function solveQuartMonicOf(polynom: readonly number[]): PositiveSet {
  return solveQuartMonic(polynom[0], polynom[1], polynom[2], polynom[3]);
}

/** Evaluate a polynomial of order N at x */
export function polyEval(p: readonly number[], x: number): number {
  const N = p.length;
  let retVal = 0.0;
  if (N === 0) {
    return retVal;
  }

  if (Math.abs(x) < DBL_EPSILON) {
    retVal = p[N - 1];
  } else if (x === 1.0) {
    for (let i = N - 1; i >= 0; i--) {
      retVal += p[i];
    }
  } else {
    let xn = 1.0;

    for (let i = N - 1; i >= 0; i--) {
      retVal += p[i] * xn;
      xn *= x;
    }
  }

  return retVal;
}

/** Calculate the derivative poly coefficients of a given poly */
export function polyDerivative(coeffs: readonly number[]): number[] {
  const N = coeffs.length;
  const deriv = new Array<number>(N - 1);
  for (let i = 0; i < N - 1; ++i) {
    deriv[i] = (N - 1 - i) * coeffs[i];
  }
  return deriv;
}

export function polyMonicDerivative(monic_coeffs: readonly number[]): number[] {
  const N = monic_coeffs.length;
  const deriv = new Array<number>(N - 1);
  deriv[0] = 1.0;
  for (let i = 1; i < N - 1; ++i) {
    deriv[i] = (N - 1 - i) * monic_coeffs[i] / (N - 1);
  }
  return deriv;
}

// Safe Newton Method
export const tolerance = 1e-14;

/**
 * Calculate a single zero of polynom p(x) inside [lbound, ubound]
 * Requirements: p(lbound)*p(ubound) < 0, lbound < ubound
 */
export function shrinkInterval(p: readonly number[], l: number, h: number, maxIts = 128): number {
  const fl = polyEval(p, l);
  const fh = polyEval(p, h);
  if (fl === 0.0) {
    return l;
  }
  if (fh === 0.0) {
    return h;
  }
  if (fl > 0.0) {
    const swapped = l;
    l = h;
    h = swapped;
  }

  let rts = (l + h) / 2;
  let dxold = Math.abs(h - l);
  let dx = dxold;
  const deriv = polyDerivative(p);
  let f = polyEval(p, rts);
  let df = polyEval(deriv, rts);
  let temp;
  for (let j = 0; j < maxIts; j++) {
    if ((((rts - h) * df - f) * ((rts - l) * df - f) > 0.0) || (Math.abs(2 * f) > Math.abs(dxold * df))) {
      dxold = dx;
      dx = (h - l) / 2;
      rts = l + dx;
      if (l === rts) {
        break;
      }
    } else {
      dxold = dx;
      dx = f / df;
      temp = rts;
      rts -= dx;
      if (temp === rts) {
        break;
      }
    }

    if (Math.abs(dx) < tolerance) {
      break;
    }

    f = polyEval(p, rts);
    df = polyEval(deriv, rts);
    if (f < 0.0) {
      l = rts;
    } else {
      h = rts;
    }
  }

  return rts;
}
