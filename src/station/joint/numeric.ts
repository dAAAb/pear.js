// Not a file of PEAR: the arithmetic and the wording of numpy and Python that the results and the messages of
// pear/deploy/station/control/joint/*.py depend on, where JavaScript's own differ.
//
// numpy's arithmetic and its messages are here. Python's wording of a value (pythonStr, pythonNumber,
// pythonStrRepr) is with the rest of what pear.js reproduces of Python, in src/python/str.ts; this file gives the
// three under the joint layer's path.

import { ValueError } from "./errors";

export { pythonNumber, pythonStr, pythonStrRepr } from "../../python/str";

/**
 * numpy's `minimum` of two doubles: a NaN wins, and of two equal values the second is returned, so that the sign of a
 * zero follows numpy (`Math.min(0, -0)` and numpy agree, `Math.min(-0, 0)` and numpy do not).
 */
export function minimum(first: number, second: number): number {
  return first < second || Number.isNaN(first) ? first : second;
}

/** numpy's `maximum` of two doubles: a NaN wins, and of two equal values the second is returned. */
export function maximum(first: number, second: number): number {
  return first > second || Number.isNaN(first) ? first : second;
}

/** numpy's `clip`: `minimum(maximum(value, lower), upper)`. */
export function clip(value: number, lower: number, upper: number): number {
  return minimum(maximum(value, lower), upper);
}

/** Python's built-in `min` of two floats: the first unless the second is smaller. */
export function pythonMin(first: number, second: number): number {
  return second < first ? second : first;
}

/** Returns the finite, nonzero `value` as `mantissa * 2 ** exponent`, the mantissa a whole number, exactly. */
function decomposed(value: number): { mantissa: bigint; exponent: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const exponentBits = Number(bits >> 52n);
  const fraction = bits & ((1n << 52n) - 1n);

  // a subnormal has no implicit leading bit
  const mantissa = exponentBits === 0 ? fraction : fraction | (1n << 52n);

  return { mantissa, exponent: Math.max(exponentBits, 1) - 1075 };
}

/**
 * Returns `base ** order` for a whole `order` of at least 1, correctly rounded: the double nearest the exact power,
 * a tie to the even one.
 *
 * Python's `base ** order` is the C library's `pow`, which is within about half a unit in the last place of the
 * exact power but not always the nearest double (glibc: 0.52 units), and JavaScript's `**` is another approximation
 * that differs between engines. The exact power is the one value every engine can agree on; it equals PEAR's
 * wherever PEAR's C library rounded correctly (see docs/progress/joint.md for the measured share).
 */
export function integerPower(base: number, order: number): number {
  if (!Number.isInteger(order) || order < 1) {
    throw new RangeError("The order of a power is a whole number of at least 1");
  }
  if (order === 1 || !Number.isFinite(base) || base === 0) {
    return base ** order; // exact: the value itself, a zero, an infinity or NaN
  }

  const { mantissa, exponent } = decomposed(base);
  const product = mantissa ** BigInt(order); // the power is product * 2 ** scale
  const scale = exponent * order;
  const length = product.toString(2).length;
  // the last binary place of the double that holds the power: 53 significant bits, none below 2 ** -1074
  const place = Math.max(length + scale - 53, -1074);
  const shift = place - scale;

  let rounded: bigint;
  if (shift <= 0) {
    rounded = product << BigInt(-shift);
  } else {
    const divisor = 1n << BigInt(shift);
    const quotient = product / divisor;
    const twiceRemainder = 2n * (product % divisor);
    const roundsUp = twiceRemainder > divisor || (twiceRemainder === divisor && quotient % 2n === 1n);
    rounded = roundsUp ? quotient + 1n : quotient;
  }

  // at most 2 ** 53, so exact; then one binary place at a time, each step exact because the result is representable
  let power = Number(rounded);
  for (let step = 0; step < place; step++) {
    power *= 2;
  }
  for (let step = 0; step > place; step--) {
    power /= 2;
  }

  return base < 0 && order % 2 === 1 ? -power : power;
}

/** Returns numpy's text of a one-dimensional shape: `(6,)`. */
function shapeText(length: number): string {
  return `(${length},)`;
}

/** Returns the ValueError numpy raises when two vectors of these lengths meet in one operation. */
export function broadcastError(firstLength: number, secondLength: number): ValueError {
  return new ValueError(
    `operands could not be broadcast together with shapes ${shapeText(firstLength)} ${shapeText(secondLength)} `,
  );
}

/**
 * Returns two vectors as numpy broadcasts them against each other in one operation: as they are when they are
 * equally long, a single value repeated to the other's length, and numpy's ValueError otherwise.
 */
export function broadcastPair(first: ArrayLike<number>, second: ArrayLike<number>): [number[], number[]] {
  if (first.length === second.length) {
    return [Array.from(first), Array.from(second)];
  }
  if (first.length === 1) {
    return [new Array<number>(second.length).fill(first[0] as number), Array.from(second)];
  }
  if (second.length === 1) {
    return [Array.from(first), new Array<number>(first.length).fill(second[0] as number)];
  }
  throw broadcastError(first.length, second.length);
}

/**
 * Returns numpy's `broadcast_to(values, (length,))`: a number repeated, a list of `length` values as it is, a list
 * of one value repeated, and numpy's ValueError for a list of another length.
 */
export function broadcastTo(values: number | ArrayLike<number>, length: number): number[] {
  if (typeof values === "number") {
    return new Array<number>(length).fill(values);
  }
  if (values.length === length) {
    return Array.from(values);
  }
  if (values.length === 1) {
    return new Array<number>(length).fill(values[0] as number);
  }
  throw new ValueError(
    "operands could not be broadcast together with remapped shapes [original->remapped]: " +
      `${shapeText(values.length)}  and requested shape ${shapeText(length)}`,
  );
}
