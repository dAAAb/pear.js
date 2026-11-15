// Ports include/ruckig/utils.hpp of Ruckig 0.15.3 (https://github.com/pantor/ruckig), and the two ways the C++
// writes a number into a message: std::to_string and a stream with a precision.
// Copyright (c) 2021 Lars Berscheid, MIT licence (see LICENSE in this folder).

/** Integrate with constant jerk for duration t. Returns new position, new velocity, and new acceleration. */
export function integrate(t: number, p0: number, v0: number, a0: number, j: number): [number, number, number] {
  return [
    p0 + t * (v0 + t * (a0 / 2 + t * j / 6)),
    v0 + t * (a0 + t * j / 2),
    a0 + t * j,
  ];
}

const bits = new DataView(new ArrayBuffer(8));

function isNegative(value: number): boolean {
  bits.setFloat64(0, value);
  return (bits.getUint8(0) & 0x80) !== 0;
}

/**
 * Returns the decimal digits of the magnitude of the finite `value`, exactly: the digits before the decimal point
 * (at least one) and those after it (none for a whole number).
 */
function exactDigits(value: number): [string, string] {
  bits.setFloat64(0, Math.abs(value));
  const high = bits.getUint32(0);
  const low = bits.getUint32(4);
  const biasedExponent = high >>> 20;
  let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  let exponent = -1074;
  if (biasedExponent !== 0) {
    mantissa |= 1n << 52n;
    exponent = biasedExponent - 1075;
  }
  if (exponent >= 0) {
    return [(mantissa << BigInt(exponent)).toString(), ""];
  }

  // mantissa / 2^k = mantissa * 5^k / 10^k
  const places = -exponent;
  const digits = (mantissa * 5n ** BigInt(places)).toString().padStart(places + 1, "0");
  const fraction = digits.slice(digits.length - places).replace(/0+$/, "");

  return [digits.slice(0, digits.length - places), fraction];
}

/** Returns the digit string `digits` plus one in its last place. */
function increment(digits: string): string {
  return (BigInt(digits) + 1n).toString().padStart(digits.length, "0");
}

/**
 * Whether cutting a number after `kept` rounds it up: `rest` holds the digits cut off. A tie goes to the even
 * digit, as the C library rounds.
 */
function roundsUp(kept: string, rest: string): boolean {
  if (rest === "" || rest[0]! < "5") {
    return false;
  }
  if (rest[0]! > "5" || /[1-9]/.test(rest.slice(1))) {
    return true;
  }
  return Number(kept[kept.length - 1] ?? "0") % 2 === 1;
}

function notFinite(value: number): string {
  if (Number.isNaN(value)) {
    return isNegative(value) ? "-nan" : "nan";
  }
  return value > 0 ? "inf" : "-inf";
}

/** C++'s std::to_string of a double: printf's %f, six digits after the decimal point. */
export function toStringDouble(value: number): string {
  if (!Number.isFinite(value)) {
    return notFinite(value);
  }

  const [whole, fraction] = exactDigits(value);
  let digits = whole + fraction.padEnd(6, "0").slice(0, 6);
  if (roundsUp(digits, fraction.slice(6))) {
    digits = increment(digits);
  }
  const text = `${digits.slice(0, digits.length - 6)}.${digits.slice(digits.length - 6)}`;

  return (isNegative(value) ? "-" : "") + text;
}

/**
 * A double written to a C++ stream with `precision` significant digits (the stream's default is 6): printf's %g.
 */
export function streamDouble(value: number, precision: number = 6): string {
  if (!Number.isFinite(value)) {
    return notFinite(value);
  }
  const sign = isNegative(value) ? "-" : "";
  if (value === 0) {
    return `${sign}0`;
  }

  const [whole, fraction] = exactDigits(value);
  // the significant digits, and the power of ten of the first of them
  let digits = (whole + fraction).replace(/^0+/, "");
  let exponent = whole === "0" ? -(fraction.length - fraction.replace(/^0+/, "").length) - 1 : whole.length - 1;
  if (digits.length > precision) {
    const rest = digits.slice(precision);
    digits = digits.slice(0, precision);
    if (roundsUp(digits, rest)) {
      digits = increment(digits);
      if (digits.length > precision) {
        // 9.99 rounded to 10.0: one digit more before the point
        digits = digits.slice(0, precision);
        exponent += 1;
      }
    }
  }
  digits = digits.replace(/0+$/, "") || "0";

  if (exponent < -4 || exponent >= precision) {
    const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const magnitude = Math.abs(exponent).toString().padStart(2, "0");
    return `${sign}${mantissa}e${exponent < 0 ? "-" : "+"}${magnitude}`;
  }
  if (exponent < 0) {
    return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  }
  if (digits.length <= exponent + 1) {
    return sign + digits.padEnd(exponent + 1, "0");
  }
  return `${sign}${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`;
}

/** The C++'s join of a vector for a message: its numbers with 16 significant digits, separated by ", ". */
export function join(array: readonly number[], highPrecision: boolean = false): string {
  return array.map((value) => streamDouble(value, highPrecision ? 16 : 6)).join(", ");
}
