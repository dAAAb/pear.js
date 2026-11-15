// What pear.js reproduces of Python itself, in one place for every module: the built-in exceptions under their
// Python names and how PEAR reads an error it caught; how Python writes a value (a float, a rounded number, a text
// in quotes, JSON, a decoded JSON value), what it counts as whitespace.
//
//   errors      the exceptions, pythonErrorName, isValueError, motionErrorOf
//   float       repr() of a float
//   format      round(), the format specifications .nf, +.nf and +g, str.format templates
//   json        json.dumps, json.loads with its error texts
//   repr        repr() and str() of a decoded JSON value, repr() of a text by Python's own table, bytes.decode
//   printable   the table of str.isprintable (generated)
//   str         str() of a value in a message, repr() of a text by the engine's Unicode properties
//   whitespace  str.strip() and \s

export * from "./errors";
export * from "./float";
export * from "./format";
export * from "./json";
export { NOT_PRINTABLE_RUNS } from "./printable";
export {
  isPythonPrintable,
  plainOf,
  pythonDecodeUtf8,
  pythonJsonDecode,
  pythonRepr,
  pythonStringRepr,
  // str() of a decoded JSON value; `pythonStr` here is the one of ./str, which takes a JavaScript value
  pythonStr as pythonValueStr,
  pythonTruth,
  pythonTypeName,
  pythonValueOf,
  type JsonValue,
} from "./repr";
export * from "./str";
export * from "./whitespace";
