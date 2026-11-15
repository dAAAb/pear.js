// Python's wording of a value in a message (CPython 3.12: str() and the `!r` of an f-string), as the messages of
// pear/deploy/station/control/joint/*.py and of the robots' settings depend on it, where JavaScript's own differ.
// (Moved from src/station/joint/numeric.ts, which keeps numpy's arithmetic.)

import { pythonFloatRepr } from "./float";

/**
 * Returns Python's `str()` of a value an f-string of PEAR's words: None for null, a text as it is, a whole number
 * as an int (which PEAR's counts are).
 */
export function pythonStr(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return "None";
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) && Math.abs(value) < 1e16 ? String(value) : pythonFloatRepr(value);
  }
  return value;
}

/** Returns the number of a bound of a setting as Python words it: a whole number as an int, another as a float. */
export function pythonNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : pythonFloatRepr(value);
}

// what Python's repr escapes of a text besides the quote, the backslash and the ASCII controls: every character that
// is not printable (the Unicode categories Cc, Cf, Cs, Co, Cn, Zl, Zp and Zs, the space excepted)
const NOT_PRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;

/**
 * Returns Python's `repr()` of a text, which `{value!r}` in an f-string gives: in single quotes, or in double quotes
 * when the text holds a single quote and no double one. Which characters beyond ASCII are printable follows the
 * engine's Unicode version, as it follows Python's there.
 *
 * It is not Python 3.12's repr on every text: an engine that knows a newer Unicode than Python's 15.0.0 shows the
 * code points assigned since, which Python escapes (10,615 of them on Node 24.18.1, Unicode 17.0; measured in
 * docs/progress/common.md). pythonStringRepr of ./repr.ts reads Python's own table and is Python's repr on every
 * code point; the two were not merged because they differ.
 */
export function pythonStrRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let body = "";

  for (const character of text) {
    const code = character.codePointAt(0) as number;
    if (character === quote || character === "\\") {
      body += `\\${character}`;
    } else if (character === "\t") {
      body += "\\t";
    } else if (character === "\n") {
      body += "\\n";
    } else if (character === "\r") {
      body += "\\r";
    } else if (code < 0x20 || code === 0x7f) {
      body += `\\x${code.toString(16).padStart(2, "0")}`;
    } else if (code < 0x7f || !NOT_PRINTABLE.test(character)) {
      body += character;
    } else if (code <= 0xff) {
      body += `\\x${code.toString(16).padStart(2, "0")}`;
    } else if (code <= 0xffff) {
      body += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      body += `\\U${code.toString(16).padStart(8, "0")}`;
    }
  }

  return quote + body + quote;
}
