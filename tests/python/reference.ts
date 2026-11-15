// Reads tests/python/reference.json, which tests/python/make_reference.py wrote from Python itself and from the
// classes of PEAR, lerobot and the OpenAI SDK in PEAR's station environment. PEAR_JS_PYTHON_REFERENCE names a
// directory that holds a larger set (make_reference.py --scale N --output <directory>).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** An exception class as Python relates it to the others. */
export interface ReferenceClass {
  name: string;
  /** The module the script took it from. */
  module: string;
  /** The class's own name, then its bases' in the order of Python's method resolution; `object` is left out. */
  mro: string[];
  /** issubclass(cls, Exception) */
  is_exception: boolean;
  /** issubclass(cls, ValueError) */
  is_value_error: boolean;
}

/** What the reference raised at one place: type(error).__name__, str(error) and the names of the class's bases. */
export interface ReferenceRaised {
  type: string;
  message: string;
  bases: string[];
}

/** A double with what Python writes of it; a double is given by its 64 bits as 16 hexadecimal digits. */
export interface ReferenceFloat {
  bits: string;
  repr: string;
  /** round(x, n) for each n of `decimals`. */
  round: string[];
  /** round(x, many_decimals). */
  round_many: string;
  /** format(x, ".nf") for each n of `decimals`. */
  fixed: string[];
  /** format(x, "+.nf") for each n of `plus_decimals`. */
  fixed_plus: string[];
  /** format(x, "g") */
  general: string;
  /** format(x, "+g") */
  general_plus: string;
}

/** A text, by its code points (a lone surrogate is one), with Python's repr() of it. */
export interface ReferenceText {
  code_points: number[];
  repr: string;
}

export interface Reference {
  meta: { pear_commit: string; python: string; lerobot: string; openai: string; script: string; scale: number };
  exceptions: {
    classes: ReferenceClass[];
    /** str() of a few instances, by the expression that makes each. */
    texts: Record<string, string>;
    /** What MotionResult.build makes of a few errors. */
    motion_errors: Array<{ code: string; message: string }>;
  };
  /** What lerobot's bus and PEAR's hardware files raise at places of the servo layer, by a description of each. */
  servo_errors: Record<string, ReferenceRaised>;
  floats: { decimals: number[]; plus_decimals: number[]; many_decimals: number; values: ReferenceFloat[] };
  texts: {
    /** The Unicode version of the Python that wrote the reference. */
    unicode: string;
    /** Code points assigned after that version. */
    later_code_points: number[];
    values: ReferenceText[];
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DIRECTORY = process.env.PEAR_JS_PYTHON_REFERENCE ?? HERE;

export const reference = JSON.parse(readFileSync(join(DIRECTORY, "reference.json"), "utf8")) as Reference;

const view = new DataView(new ArrayBuffer(8));

/** Returns the double of 16 hexadecimal digits. */
export function fromBits(bits: string): number {
  view.setBigUint64(0, BigInt(`0x${bits}`));

  return view.getFloat64(0);
}

/** Whether ``value`` is the double of 16 hexadecimal digits: the same bits, the sign of a zero included; any NaN
 * is a NaN. */
export function isSameFloat(value: number, bits: string): boolean {
  const expected = fromBits(bits);

  return Number.isNaN(expected) ? Number.isNaN(value) : Object.is(value, expected);
}

/** Returns the text of a list of code points; a surrogate's code point is a lone surrogate (the script never puts
 * a low one right after a high one, which a JavaScript string would read as one character). */
export function textOf(codePoints: readonly number[]): string {
  return codePoints.map((codePoint) => String.fromCodePoint(codePoint)).join("");
}
