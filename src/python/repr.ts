// Python's own text of a value (CPython 3.12: str(), repr(), bytes.decode), where it reaches what PEAR's model
// client raises. The OpenAI SDK that pear/deploy/station/agent_loop/clients/vllm.py drives writes a refusal as
// f"Error code: {status} - {body}", with the decoded JSON body as Python prints it, and PEAR's agent loop shows the
// message of whatever ended a turn to the model in the next one. So a dict prints as {'message': 'text', 'code': 400},
// a string in the quotes Python chooses, None, True and False by their Python names, a float as repr() writes it.

import { UnicodeDecodeError } from "./errors";
import { pythonFloatRepr } from "./float";
import { pythonJsonLoads, type PythonJsonValue } from "./json";
import { NOT_PRINTABLE_RUNS } from "./printable";

// the first and the last code point of each run that str.isprintable() refuses, in order
let notPrintable: { first: Uint32Array; last: Uint32Array } | undefined;

function notPrintableRuns(): { first: Uint32Array; last: Uint32Array } {
  if (notPrintable === undefined) {
    const runs = NOT_PRINTABLE_RUNS.split(",");
    const first = new Uint32Array(runs.length);
    const last = new Uint32Array(runs.length);
    let previous = 0;
    runs.forEach((run, index) => {
      const [gap, extent] = run.split(".") as [string, string];
      first[index] = previous + Number.parseInt(gap, 36);
      last[index] = first[index]! + Number.parseInt(extent, 36);
      previous = last[index]!;
    });
    notPrintable = { first, last };
  }

  return notPrintable;
}

/** Python's str.isprintable() of one code point. */
export function isPythonPrintable(codePoint: number): boolean {
  const { first, last } = notPrintableRuns();
  let low = 0;
  let high = first.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (codePoint < first[middle]!) {
      high = middle - 1;
    } else if (codePoint > last[middle]!) {
      low = middle + 1;
    } else {
      return false;
    }
  }

  return true;
}

function hex(codePoint: number, digits: number): string {
  return codePoint.toString(16).padStart(digits, "0");
}

/** Python's repr() of a str: in single quotes unless it holds one and no double quote, with the escapes Python
 * writes. A JavaScript string's lone surrogate is Python's lone surrogate. */
export function pythonStringRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let shown = quote;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (character === quote || character === "\\") {
      shown += `\\${character}`;
    } else if (character === "\t") {
      shown += "\\t";
    } else if (character === "\n") {
      shown += "\\n";
    } else if (character === "\r") {
      shown += "\\r";
    } else if (codePoint < 0x20 || codePoint === 0x7f) {
      shown += `\\x${hex(codePoint, 2)}`;
    } else if (codePoint < 0x7f || isPythonPrintable(codePoint)) {
      shown += character;
    } else if (codePoint <= 0xff) {
      shown += `\\x${hex(codePoint, 2)}`;
    } else if (codePoint <= 0xffff) {
      shown += `\\u${hex(codePoint, 4)}`;
    } else {
      shown += `\\U${hex(codePoint, 8)}`;
    }
  }

  return shown + quote;
}

/** Python's repr() of a value json.loads returned. */
export function pythonRepr(value: PythonJsonValue): string {
  switch (value.type) {
    case "none":
      return "None";
    case "bool":
      return value.value ? "True" : "False";
    case "int":
      return /^-?0+$/.test(value.literal) ? "0" : value.literal; // the int -0 is 0
    case "float":
      return pythonFloatRepr(value.value);
    case "str":
      return pythonStringRepr(value.value);
    case "list":
      return `[${value.items.map(pythonRepr).join(", ")}]`;
    case "dict":
      return `{${[...value.items].map(([key, item]) => `${pythonStringRepr(key)}: ${pythonRepr(item)}`).join(", ")}}`;
  }
}

/** Python's str() of a value json.loads returned: a string as it is, anything else as repr() writes it. */
export function pythonStr(value: PythonJsonValue): string {
  return value.type === "str" ? value.value : pythonRepr(value);
}

/** Python's json.loads(text): a name an object holds twice keeps its first place and its last value, as a dict
 * does; throws the exception Python raises (see pythonJsonLoads). */
export function pythonJsonDecode(text: string): PythonJsonValue {
  return pythonJsonLoads(text, (pairs) => ({ type: "dict", items: new Map(pairs) }));
}

/** A JSON value as JavaScript holds it. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * Returns the value JSON.parse would give of what json.loads decoded: an int as a number (a long one loses its
 * last digits), NaN and the infinities as the numbers they are.
 */
export function plainOf(value: PythonJsonValue): JsonValue {
  switch (value.type) {
    case "none":
      return null;
    case "bool":
    case "float":
    case "str":
      return value.value;
    case "int":
      return Number(value.literal) + 0;
    case "list":
      return value.items.map(plainOf);
    case "dict": {
      const object: { [key: string]: JsonValue } = {};
      for (const [key, item] of value.items) {
        // (defined, not assigned: a name such as __proto__ is a name like any other)
        const property = { value: plainOf(item), enumerable: true, writable: true, configurable: true };
        Object.defineProperty(object, key, property);
      }
      return object;
    }
  }
}

/**
 * Returns a JavaScript value as the Python value it stands for: a whole number as an int (Python would know a
 * float 2.0 from the int 2, JavaScript does not), an object as a dict.
 */
export function pythonValueOf(value: unknown): PythonJsonValue {
  if (value === null || value === undefined) {
    return { type: "none" };
  }
  if (typeof value === "boolean") {
    return { type: "bool", value };
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? { type: "int", literal: integerLiteral(value) } : { type: "float", value };
  }
  if (typeof value === "string") {
    return { type: "str", value };
  }
  if (Array.isArray(value)) {
    return { type: "list", items: value.map(pythonValueOf) };
  }

  return {
    type: "dict",
    items: new Map(Object.entries(value as object).map(([key, item]) => [key, pythonValueOf(item)])),
  };
}

/** The digits of a whole number, without the exponent JavaScript writes from 1e21 on. */
function integerLiteral(value: number): string {
  return Math.abs(value) < 1e21 ? String(value + 0) : BigInt(value).toString();
}

/** The name of a JavaScript value's Python type, as Python's error messages give it. */
export function pythonTypeName(value: unknown): string {
  if (value === null || value === undefined) {
    return "NoneType";
  }
  if (typeof value === "boolean") {
    return "bool";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "int" : "float";
  }
  if (typeof value === "string") {
    return "str";
  }

  return Array.isArray(value) ? "list" : "dict";
}

/** Python's truth of a JSON value: None, False, zero and what is empty are false; NaN is true. */
export function pythonTruth(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }

  return true;
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Python's bytes.decode("utf-8"): the text, a byte order mark kept; throws UnicodeDecodeError, a ValueError, with
 * Python's message for bytes that are no UTF-8. */
export function pythonDecodeUtf8(bytes: Uint8Array): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw utf8Error(bytes);
  }
}

/** The error of CPython's UTF-8 decoder (Objects/stringlib/codecs.h, utf8_decode) at the first bytes it refuses. */
function utf8Error(bytes: Uint8Array): UnicodeDecodeError {
  const end = bytes.length;
  const isContinuation = (byte: number): boolean => byte >= 0x80 && byte < 0xc0;
  const error = (start: number, stop: number, reason: string): UnicodeDecodeError => {
    const where =
      stop - start === 1
        ? `byte 0x${hex(bytes[start]!, 2)} in position ${start}`
        : `bytes in position ${start}-${stop - 1}`;
    return new UnicodeDecodeError(`'utf-8' codec can't decode ${where}: ${reason}`);
  };
  const START = "invalid start byte";
  const CONTINUATION = "invalid continuation byte";
  const END = "unexpected end of data";

  let index = 0;
  while (index < end) {
    const lead = bytes[index]!;
    const second = bytes[index + 1]!;
    const third = bytes[index + 2]!;
    const left = end - index;
    if (lead < 0x80) {
      index += 1;
    } else if (lead < 0xe0) {
      if (lead < 0xc2) {
        return error(index, index + 1, START);
      }
      if (left < 2) {
        return error(index, end, END);
      }
      if (!isContinuation(second)) {
        return error(index, index + 1, CONTINUATION);
      }
      index += 2;
    } else if (lead < 0xf0) {
      if (left < 2) {
        return error(index, end, END);
      }
      // an overlong form after 0xE0 and a surrogate after 0xED are refused at their second byte
      if (!isContinuation(second) || (second < 0xa0 ? lead === 0xe0 : lead === 0xed)) {
        return error(index, index + 1, CONTINUATION);
      }
      if (left < 3) {
        return error(index, end, END);
      }
      if (!isContinuation(third)) {
        return error(index, index + 2, CONTINUATION);
      }
      index += 3;
    } else if (lead < 0xf5) {
      if (left < 2) {
        return error(index, end, END);
      }
      // an overlong form after 0xF0 and a code point past U+10FFFF after 0xF4 are refused at their second byte
      if (!isContinuation(second) || (second < 0x90 ? lead === 0xf0 : lead === 0xf4)) {
        return error(index, index + 1, CONTINUATION);
      }
      if (left < 3) {
        return error(index, end, END);
      }
      if (!isContinuation(third)) {
        return error(index, index + 2, CONTINUATION);
      }
      if (left < 4) {
        return error(index, end, END);
      }
      if (!isContinuation(bytes[index + 3]!)) {
        return error(index, index + 3, CONTINUATION);
      }
      index += 4;
    } else {
      return error(index, index + 1, START);
    }
  }

  // (the engine refused bytes this reading takes: no such bytes are known)
  return new UnicodeDecodeError("'utf-8' codec can't decode bytes");
}
