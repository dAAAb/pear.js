// Python's wording of numbers, for the texts PEAR builds from them: `round(value, n)`, the format specifications
// `.nf`, `+.nf` and `+g`, and `str.format` templates. JavaScript's `toFixed` and `toPrecision` round an exact decimal
// tie upward where Python rounds it to the even digit (2.25 reads "2.2" in Python, "2.3" from `toFixed(1)`), so the
// digits here come from the double's exact decimal value.

/** Returns the magnitude of the finite `value` as `digits / 10 ** scale`, exactly. */
function exactDecimal(value: number): { digits: bigint; scale: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const exponentBits = Number(bits >> 52n);
  const fraction = bits & ((1n << 52n) - 1n);
  // a double is mantissa * 2 ** exponent; a subnormal has no implicit leading bit
  const mantissa = exponentBits === 0 ? fraction : fraction | (1n << 52n);
  const exponent = Math.max(exponentBits, 1) - 1075;

  if (exponent >= 0) {
    return { digits: mantissa << BigInt(exponent), scale: 0 };
  }
  return { digits: mantissa * 5n ** BigInt(-exponent), scale: -exponent };
}

/** Returns `dividend / divisor` rounded to the nearest integer, a tie to the even one. */
function dividedHalfEven(dividend: bigint, divisor: bigint): bigint {
  const quotient = dividend / divisor;
  const twiceRemainder = 2n * (dividend % divisor);
  const roundsUp = twiceRemainder > divisor || (twiceRemainder === divisor && quotient % 2n === 1n);

  return roundsUp ? quotient + 1n : quotient;
}

function isNegative(value: number): boolean {
  return value < 0 || Object.is(value, -0);
}

/** Returns "nan" or "inf" with Python's sign, or null for a finite `value`. */
function nonFiniteText(value: number, plus: boolean): string | null {
  if (Number.isNaN(value)) {
    return plus ? "+nan" : "nan";
  }
  if (!Number.isFinite(value)) {
    return value < 0 ? "-inf" : plus ? "+inf" : "inf";
  }
  return null;
}

/** Returns `value` as Python's `format(value, ".{decimals}f")`, or `"+.{decimals}f"` with `plus`. */
export function formatFixed(value: number, decimals: number, plus = false): string {
  const nonFinite = nonFiniteText(value, plus);
  if (nonFinite !== null) {
    return nonFinite;
  }

  const { digits, scale } = exactDecimal(value);
  const scaled =
    scale <= decimals ? digits * 10n ** BigInt(decimals - scale) : dividedHalfEven(digits, 10n ** BigInt(scale - decimals));
  const text = scaled.toString().padStart(decimals + 1, "0");
  const whole = text.slice(0, text.length - decimals);
  const sign = isNegative(value) ? "-" : plus ? "+" : "";

  return decimals > 0 ? `${sign}${whole}.${text.slice(text.length - decimals)}` : `${sign}${whole}`;
}

/** Returns `value` as Python's `round(value, decimals)` returns it: the nearest decimal, an exact tie to even. */
export function pythonRound(value: number, decimals: number): number {
  return Number.isFinite(value) ? Number(formatFixed(value, decimals)) : value;
}

const GENERAL_PRECISION = 6; // significant digits of Python's "g" when the specification names none

/** Returns `value` as Python's `format(value, "g")`, or `"+g"` with `plus`. */
export function formatGeneral(value: number, plus = false): string {
  const nonFinite = nonFiniteText(value, plus);
  if (nonFinite !== null) {
    return nonFinite;
  }
  const sign = isNegative(value) ? "-" : plus ? "+" : "";
  if (value === 0) {
    return `${sign}0`;
  }

  const { digits, scale } = exactDecimal(value);
  const length = digits.toString().length;
  let exponent = length - 1 - scale; // of the leading digit: the value is d.ddd * 10 ** exponent
  let significant =
    length <= GENERAL_PRECISION
      ? digits * 10n ** BigInt(GENERAL_PRECISION - length)
      : dividedHalfEven(digits, 10n ** BigInt(length - GENERAL_PRECISION));
  if (significant === 10n ** BigInt(GENERAL_PRECISION)) {
    // the rounding carried into a new leading digit: 999999.5 reads 1e+06
    significant /= 10n;
    exponent += 1;
  }
  const text = significant.toString();
  const withoutTrailingZeros = (number: string): string =>
    number.includes(".") ? number.replace(/0+$/, "").replace(/\.$/, "") : number;

  if (exponent < -4 || exponent >= GENERAL_PRECISION) {
    const mantissa = withoutTrailingZeros(`${text[0]}.${text.slice(1)}`);
    const exponentText = Math.abs(exponent).toString().padStart(2, "0");
    return `${sign}${mantissa}e${exponent < 0 ? "-" : "+"}${exponentText}`;
  }
  if (exponent < 0) {
    return sign + withoutTrailingZeros(`0.${"0".repeat(-exponent - 1)}${text}`);
  }
  return sign + withoutTrailingZeros(`${text.slice(0, exponent + 1)}.${text.slice(exponent + 1)}`);
}

/**
 * Fills a Python `str.format` template whose fields are `{name}` for a text and `{name:.nf}` for a number, the two
 * kinds PEAR's control texts use. A value the template does not name is ignored, as Python ignores it.
 */
export function formatTemplate(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)(?::\.(\d+)f)?\}/g, (_field, name: string, decimals: string | undefined) => {
    const value = values[name];
    if (decimals !== undefined) {
      if (typeof value !== "number") {
        throw new TypeError(`The field {${name}} of a template formats a number`);
      }
      return formatFixed(value, Number(decimals));
    }
    if (typeof value !== "string") {
      // a number without a specification would need Python's repr of a float, which no control text uses
      throw new TypeError(`The field {${name}} of a template takes a text`);
    }
    return value;
  });
}
