// Python's json module as PEAR's station uses it (CPython 3.12, Lib/json and Modules/_json.c):
//   json.dumps with its defaults, for the state of a turn (pear/agent_loop/protocol.py) and for the report of an
//   action (pear/deploy/station/control/robots/so101/formats.py);
//   json.loads with an object_pairs_hook, for the json block of an answer
//   (pear/deploy/station/agent_loop/action_parser.py). Its error messages reach the model in the next turn's
//   report, so they are reproduced with their line, column and character position.

import { pythonFloatRepr } from "./python_float";

/** A Python exception as a result carries it: the name of its class and its message. */
export class PythonError extends Error {
  /** The exception's class, e.g. "ValueError", "JSONDecodeError", "OverflowError". */
  readonly pythonType: string;
  /** Whether the class is ValueError or one of its subclasses: PEAR rejects an action for these and fails it for
   * any other. */
  readonly isValueError: boolean;

  constructor(pythonType: string, message: string, isValueError: boolean) {
    super(message);
    this.name = pythonType;
    this.pythonType = pythonType;
    this.isValueError = isValueError;
  }
}

/** A value json.dumps is given here: floats print as Python's repr, so 5 reads 5.0. */
export type PythonJsonInput = string | number | boolean | null | { readonly [key: string]: PythonJsonInput };

/** Python's json.dumps(value) of dicts, strings, booleans, None and floats, with its default separators and
 * ensure_ascii. */
export function pythonJsonDumps(value: PythonJsonInput): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return encodeString(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      return "NaN";
    }
    if (!Number.isFinite(value)) {
      return value > 0 ? "Infinity" : "-Infinity";
    }
    return pythonFloatRepr(value);
  }

  const items = Object.entries(value).map(([key, item]) => `${encodeString(key)}: ${pythonJsonDumps(item)}`);
  return `{${items.join(", ")}}`;
}

const SHORT_ESCAPES: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/** A string as json.dumps writes it with ensure_ascii: everything but printable ASCII escaped, a character beyond
 * the basic plane as its two surrogates, which are a JavaScript string's own units. */
function encodeString(text: string): string {
  let encoded = '"';
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    const character = text[index]!;
    if (unit >= 0x20 && unit <= 0x7e && character !== '"' && character !== "\\") {
      encoded += character;
    } else {
      encoded += SHORT_ESCAPES[character] ?? `\\u${unit.toString(16).padStart(4, "0")}`;
    }
  }

  return `${encoded}"`;
}

/** A decoded JSON value with the Python type json.loads gives it; an int keeps its literal, which may be past
 * every float. */
export type PythonJsonValue =
  | { type: "dict"; items: Map<string, PythonJsonValue> }
  | { type: "list"; items: PythonJsonValue[] }
  | { type: "str"; value: string }
  | { type: "int"; literal: string }
  | { type: "float"; value: number }
  | { type: "bool"; value: boolean }
  | { type: "none" };

/** What json.loads calls with the pairs of each object, innermost first, to make the object's value. */
export type ObjectPairsHook = (pairs: Array<[string, PythonJsonValue]>) => PythonJsonValue;

/** Python's json.loads(text, object_pairs_hook=hook); throws PythonError where Python raises. */
export function pythonJsonLoads(text: string, hook: ObjectPairsHook): PythonJsonValue {
  return new Decoder(text, hook).decode();
}

// sys.get_int_max_str_digits(): Python refuses to read a longer integer
const MAX_INTEGER_DIGITS = 4300;
// How deep CPython 3.12 nests before its C recursion limit raises RecursionError, as measured in PEAR's station
// environment (tools/fixtures/protocol_fixtures.py, Parsing.limits): a container opens while fewer than 9997 are
// open, and the hook, a Python call, runs while at most 9995 are. The exact depth in a running station depends on
// its call stack; an action is never deeper than two.
const MAX_OPEN_CONTAINERS = 9997;
const MAX_OPEN_CONTAINERS_AT_HOOK = 9995;

const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const SPACE = 0x20;
const QUOTE = 0x22;
const PLUS = 0x2b;
const COMMA = 0x2c;
const MINUS = 0x2d;
const DOT = 0x2e;
const ZERO = 0x30;
const NINE = 0x39;
const COLON = 0x3a;
const OPEN_BRACKET = 0x5b;
const BACKSLASH = 0x5c;
const CLOSE_BRACKET = 0x5d;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;

function codes(text: string): number[] {
  return Array.from(text, (character) => character.charCodeAt(0));
}

// what follows a backslash in a string, other than the u of a \uXXXX escape
const STRING_ESCAPES = new Map([
  ['"', '"'],
  ["\\", "\\"],
  ["/", "/"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);

const NULL_TAIL = codes("ull");
const TRUE_TAIL = codes("rue");
const FALSE_TAIL = codes("alse");
const NAN_TAIL = codes("aN");
const INFINITY_TAIL = codes("nfinity");
const NEGATIVE_INFINITY_TAIL = codes("Infinity");

/** A container being read: an object with the name whose value comes next, or an array. */
type Frame =
  | { type: "dict"; pairs: Array<[string, PythonJsonValue]>; key: string }
  | { type: "list"; items: PythonJsonValue[] };

/** _json.c's scanner. It keeps its own stack of open containers instead of recursing, so that a deeply nested
 * answer ends as it does in Python and not with the JavaScript engine's stack. */
class Decoder {
  // Python indexes a str by code point and reports positions so; a JavaScript string indexes by UTF-16 unit
  private readonly document: number[];
  private readonly length: number;
  private readonly hook: ObjectPairsHook;

  constructor(text: string, hook: ObjectPairsHook) {
    this.document = Array.from(text, (character) => character.codePointAt(0)!);
    this.length = this.document.length;
    this.hook = hook;
  }

  /** json.loads and JSONDecoder.decode: one value, with nothing but whitespace around it. */
  decode(): PythonJsonValue {
    if (this.document[0] === 0xfeff) {
      this.fail("Unexpected UTF-8 BOM (decode using utf-8-sig)", 0);
    }
    const [value, valueEnd] = this.scanOnce(this.skipWhitespace(0));
    const end = this.skipWhitespace(valueEnd);
    if (end !== this.length) {
      this.fail("Extra data", end);
    }

    return value;
  }

  /** scan_once_unicode with _parse_object_unicode and _parse_array_unicode: the value at ``start`` and the index
   * after it. */
  private scanOnce(start: number): [PythonJsonValue, number] {
    const document = this.document;
    const stack: Frame[] = [];
    let index = start;

    for (;;) {
      // reads the term at index
      let value: PythonJsonValue;
      if (index >= this.length) {
        this.fail("Expecting value", index);
      }
      const first = document[index]!;
      if (first === OPEN_BRACE) {
        this.checkDepth(stack.length, "object");
        index = this.skipWhitespace(index + 1);
        if (document[index] !== CLOSE_BRACE) {
          let key: string;
          [key, index] = this.scanKey(index);
          stack.push({ type: "dict", pairs: [], key });
          continue;
        }
        value = this.callHook([], stack.length + 1);
        index += 1;
      } else if (first === OPEN_BRACKET) {
        this.checkDepth(stack.length, "array");
        index = this.skipWhitespace(index + 1);
        if (document[index] !== CLOSE_BRACKET) {
          stack.push({ type: "list", items: [] });
          continue;
        }
        value = { type: "list", items: [] };
        index += 1;
      } else {
        [value, index] = this.scanScalar(index);
      }

      // gives the term to the containers it ends
      for (;;) {
        const frame = stack[stack.length - 1];
        if (frame === undefined) {
          return [value, index];
        }

        const isObject = frame.type === "dict";
        if (frame.type === "dict") {
          frame.pairs.push([frame.key, value]);
        } else {
          frame.items.push(value);
        }
        index = this.skipWhitespace(index);
        if (document[index] === (isObject ? CLOSE_BRACE : CLOSE_BRACKET)) {
          value =
            frame.type === "dict" ? this.callHook(frame.pairs, stack.length) : { type: "list", items: frame.items };
          stack.pop();
          index += 1;
          continue;
        }
        if (document[index] !== COMMA) {
          this.fail("Expecting ',' delimiter", index);
        }
        index = this.skipWhitespace(index + 1);
        if (frame.type === "dict") {
          [frame.key, index] = this.scanKey(index);
        }
        break;
      }
    }
  }

  /** An object's next name with its colon: the name and the index of its value. */
  private scanKey(start: number): [string, number] {
    if (this.document[start] !== QUOTE) {
      this.fail("Expecting property name enclosed in double quotes", start);
    }
    const [key, keyEnd] = this.scanString(start + 1);
    const colon = this.skipWhitespace(keyEnd);
    if (this.document[colon] !== COLON) {
      this.fail("Expecting ':' delimiter", colon);
    }

    return [key, this.skipWhitespace(colon + 1)];
  }

  /** scan_once_unicode's terms that hold no other: a string, a constant or a number. */
  private scanScalar(index: number): [PythonJsonValue, number] {
    const first = String.fromCodePoint(this.document[index]!);
    if (first === '"') {
      const [text, end] = this.scanString(index + 1);
      return [{ type: "str", value: text }, end];
    }
    if (first === "n" && this.follows(index, NULL_TAIL)) {
      return [{ type: "none" }, index + 4];
    }
    if (first === "t" && this.follows(index, TRUE_TAIL)) {
      return [{ type: "bool", value: true }, index + 4];
    }
    if (first === "f" && this.follows(index, FALSE_TAIL)) {
      return [{ type: "bool", value: false }, index + 5];
    }
    if (first === "N" && this.follows(index, NAN_TAIL)) {
      return [{ type: "float", value: NaN }, index + 3];
    }
    if (first === "I" && this.follows(index, INFINITY_TAIL)) {
      return [{ type: "float", value: Infinity }, index + 8];
    }
    if (first === "-" && this.follows(index, NEGATIVE_INFINITY_TAIL)) {
      return [{ type: "float", value: -Infinity }, index + 9];
    }

    return this.matchNumber(index);
  }

  /** Whether ``tail`` follows the character at ``index``. */
  private follows(index: number, tail: number[]): boolean {
    return tail.every((code, offset) => this.document[index + 1 + offset] === code);
  }

  /** _match_number_unicode: the number at ``start`` and the index after it. */
  private matchNumber(start: number): [PythonJsonValue, number] {
    const document = this.document;
    const last = this.length - 1;
    const isDigit = (index: number): boolean => document[index]! >= ZERO && document[index]! <= NINE;
    let index = start;
    let isFloat = false;

    if (document[index] === MINUS) {
      index += 1;
      if (index > last) {
        this.fail("Expecting value", start);
      }
    }
    if (isDigit(index) && document[index] !== ZERO) {
      index += 1;
      while (index <= last && isDigit(index)) {
        index += 1;
      }
    } else if (document[index] === ZERO) {
      index += 1; // after a leading 0 no further integer digit is read
    } else {
      this.fail("Expecting value", start);
    }

    if (index < last && document[index] === DOT && isDigit(index + 1)) {
      isFloat = true;
      index += 2;
      while (index <= last && isDigit(index)) {
        index += 1;
      }
    }

    if (index < last && (document[index] === 0x65 || document[index] === 0x45)) {
      const exponentStart = index;
      index += 1;
      if (index < last && (document[index] === MINUS || document[index] === PLUS)) {
        index += 1;
      }
      while (index <= last && isDigit(index)) {
        index += 1;
      }
      if (isDigit(index - 1)) {
        isFloat = true;
      } else {
        index = exponentStart; // an exponent without digits is no part of the number
      }
    }

    const literal = this.textOf(start, index);
    if (isFloat) {
      return [{ type: "float", value: Number(literal) }, index];
    }
    const digitCount = literal.length - (literal.startsWith("-") ? 1 : 0);
    if (digitCount > MAX_INTEGER_DIGITS) {
      throw new PythonError(
        "ValueError",
        `Exceeds the limit (${MAX_INTEGER_DIGITS} digits) for integer string conversion: value has ${digitCount} ` +
          "digits; use sys.set_int_max_str_digits() to increase the limit",
        true,
      );
    }

    return [{ type: "int", literal }, index];
  }

  /** scanstring_unicode: the string whose first character is at ``start``, after its opening quote, and the index
   * after its closing quote. */
  private scanString(start: number): [string, number] {
    const document = this.document;
    const length = this.length;
    const begin = start - 1;
    let end = start;
    let text = "";

    for (;;) {
      // finds the end of the string or the next escape
      let next = end;
      let code = 0;
      for (; next < length; next++) {
        code = document[next]!;
        if (code === QUOTE || code === BACKSLASH) {
          break;
        }
        if (code <= 0x1f) {
          this.fail("Invalid control character at", next);
        }
      }
      if (code !== QUOTE && code !== BACKSLASH) {
        this.fail("Unterminated string starting at", begin);
      }
      text += this.textOf(end, next);
      next += 1;
      if (code === QUOTE) {
        return [text, next];
      }
      if (next === length) {
        this.fail("Unterminated string starting at", begin);
      }

      const escape = String.fromCodePoint(document[next]!);
      if (escape !== "u") {
        end = next + 1;
        const escaped = STRING_ESCAPES.get(escape);
        if (escaped === undefined) {
          this.fail("Invalid \\escape", end - 2);
        }
        text += escaped;
        continue;
      }

      next += 1;
      end = next + 4;
      if (end >= length) {
        this.fail("Invalid \\uXXXX escape", next - 1);
      }
      const unit = this.hexUnit(next);
      // a high surrogate takes the low surrogate of an escape right after it; in a JavaScript string the two
      // units side by side are that character already, so only the errors of the second escape are Python's own
      if (
        unit >= 0xd800 &&
        unit <= 0xdbff &&
        end + 6 < length &&
        document[end] === BACKSLASH &&
        document[end + 1] === 0x75
      ) {
        const second = this.hexUnit(end + 2);
        if (second >= 0xdc00 && second <= 0xdfff) {
          text += String.fromCharCode(unit, second);
          end += 6;
          continue;
        }
      }
      text += String.fromCharCode(unit);
    }
  }

  /** The number of the four hexadecimal digits from ``start``, which follow the u of an escape. */
  private hexUnit(start: number): number {
    let unit = 0;
    for (let index = start; index < start + 4; index++) {
      const digit = Number.parseInt(String.fromCodePoint(this.document[index]!), 16);
      // parseInt reads nothing but 0-9, a-f and A-F as one hexadecimal digit
      if (Number.isNaN(digit)) {
        this.fail("Invalid \\uXXXX escape", start - 1);
      }
      unit = unit * 16 + digit;
    }

    return unit;
  }

  /** The characters from ``start`` to before ``end`` as a string. */
  private textOf(start: number, end: number): string {
    let text = "";
    // in pieces: an engine bounds the arguments of one call
    for (let index = start; index < end; index += 4096) {
      text += String.fromCodePoint(...this.document.slice(index, Math.min(end, index + 4096)));
    }

    return text;
  }

  /** The index of the first character from ``index`` that is none of JSON's four whitespace characters. */
  private skipWhitespace(index: number): number {
    const document = this.document;
    while (
      document[index] === SPACE ||
      document[index] === TAB ||
      document[index] === LINE_FEED ||
      document[index] === CARRIAGE_RETURN
    ) {
      index += 1;
    }

    return index;
  }

  private checkDepth(openContainers: number, container: "object" | "array"): void {
    if (openContainers >= MAX_OPEN_CONTAINERS) {
      throw new PythonError(
        "RecursionError",
        `maximum recursion depth exceeded while decoding a JSON ${container} from a unicode string`,
        false,
      );
    }
  }

  private callHook(pairs: Array<[string, PythonJsonValue]>, openContainers: number): PythonJsonValue {
    if (openContainers > MAX_OPEN_CONTAINERS_AT_HOOK) {
      throw new PythonError("RecursionError", "maximum recursion depth exceeded", false);
    }

    return this.hook(pairs);
  }

  /** Raises json.JSONDecodeError(message, document, position), with the line and column Python counts. */
  private fail(message: string, position: number): never {
    let line = 1;
    let lineStart = 0;
    for (let index = 0; index < position && index < this.length; index++) {
      if (this.document[index] === LINE_FEED) {
        line += 1;
        lineStart = index + 1;
      }
    }

    throw new PythonError(
      "JSONDecodeError",
      `${message}: line ${line} column ${position - lineStart + 1} (char ${position})`,
      true,
    );
  }
}
