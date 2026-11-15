// Python's built-in exceptions (CPython 3.12, Objects/exceptions.c, and json.JSONDecodeError of
// Lib/json/decoder.py), as far as PEAR's station, lerobot and the libraries under them raise them where pear.js
// throws; with how PEAR reads an error once it is caught.
//
// PEAR reports an action that did not complete as {"code": type(error).__name__, "message": str(error)}
// (pear/deploy/station/control/motion/results.py, MotionResult.build), the model reads both in the next turn, and
// PEAR's turn loop asks isinstance(error, ValueError) to record the turn as rejected or as failed
// (pear/deploy/station/agent_loop/agent_loop.py, StationAgentLoop.step). So every class here carries the Python
// class's name in `.name` and extends the class its Python class extends: `instanceof` answers what isinstance
// answers in PEAR, in whichever module of pear.js the error was thrown. A module's own exceptions (PEAR's and
// lerobot's classes) extend these; there is one class for each Python class, whatever path it is imported from.

/** Python's Exception: the base of every exception ported in pear.js. */
export class PythonException extends Error {
  override readonly name: string = "Exception";
}

/** Python's built-in ArithmeticError. */
export class ArithmeticError extends PythonException {
  override readonly name: string = "ArithmeticError";
}

/** Python's built-in OverflowError: a number too large for the type it is turned into. */
export class OverflowError extends ArithmeticError {
  override readonly name: string = "OverflowError";
}

/** Python's built-in ZeroDivisionError. */
export class ZeroDivisionError extends ArithmeticError {
  override readonly name: string = "ZeroDivisionError";
}

/** Python's built-in AttributeError. */
export class AttributeError extends PythonException {
  override readonly name: string = "AttributeError";
}

/** Python's built-in LookupError. */
export class LookupError extends PythonException {
  override readonly name: string = "LookupError";
}

/** Python's built-in IndexError. */
export class IndexError extends LookupError {
  override readonly name: string = "IndexError";
}

/** Python's built-in KeyError. Its text is the repr() of the key that was not found: the message given here is
 * that text. */
export class KeyError extends LookupError {
  override readonly name: string = "KeyError";
}

/** Python's built-in OSError. */
export class OSError extends PythonException {
  override readonly name: string = "OSError";
}

/** Python's built-in ConnectionError: an OSError. */
export class ConnectionError extends OSError {
  override readonly name: string = "ConnectionError";
}

/** Python's built-in TimeoutError: an OSError, and no RuntimeError. A wait that ended before what it waited for; a
 * request that ends at a client's own deadline raises it without a message (asyncio.timeout), so its message is
 * empty by default. */
export class TimeoutError extends OSError {
  override readonly name: string = "TimeoutError";

  constructor(message = "", options?: ErrorOptions) {
    super(message, options);
  }
}

/** Python's built-in RuntimeError. */
export class RuntimeError extends PythonException {
  override readonly name: string = "RuntimeError";
}

/** Python's built-in NotImplementedError: a RuntimeError. */
export class NotImplementedError extends RuntimeError {
  override readonly name: string = "NotImplementedError";
}

/** Python's built-in RecursionError: a RuntimeError. */
export class RecursionError extends RuntimeError {
  override readonly name: string = "RecursionError";
}

/** Python's built-in StopIteration: what next() raises of an iterator that has nothing left. */
export class StopIteration extends PythonException {
  override readonly name: string = "StopIteration";
}

/** Python's built-in TypeError: a value of the wrong kind. (JavaScript has a TypeError of its own, so the class is
 * named apart from it; its `.name` is Python's.) */
export class PythonTypeError extends PythonException {
  override readonly name: string = "TypeError";
}

/** Python's built-in ValueError: a value that is refused. PEAR's turn loop rejects a turn that ends with one, and
 * fails a turn that ends with any other exception. */
export class ValueError extends PythonException {
  override readonly name: string = "ValueError";
}

/** Python's json.JSONDecodeError: a ValueError. Its message ends with the line, the column and the character
 * position Python counts. */
export class JSONDecodeError extends ValueError {
  override readonly name: string = "JSONDecodeError";
}

/** Python's built-in UnicodeError: a ValueError. */
export class UnicodeError extends ValueError {
  override readonly name: string = "UnicodeError";
}

/** Python's built-in UnicodeDecodeError: a UnicodeError. */
export class UnicodeDecodeError extends UnicodeError {
  override readonly name: string = "UnicodeDecodeError";
}

/**
 * What an error declares when its own class does not tell which Python class it stands for: the name of that class
 * and whether it is ValueError or one of its subclasses. pythonErrorName and isValueError read these two before the
 * error's own class.
 */
export interface PythonIdentity {
  /** type(error).__name__ */
  readonly pythonType: string;
  /** isinstance(error, ValueError) */
  readonly isValueError: boolean;
}

/**
 * A Python exception of a class that is named only when it is raised, for which pear.js has no class of its own
 * (a test replays PEAR's errors by their recorded names this way). Where pear.js has the class, it throws that
 * class.
 */
export class PythonError extends PythonException implements PythonIdentity {
  override readonly name: string;
  /** The exception's class, e.g. "GripperEndpointTimeout", "HomePlanningError", "StabilityError". */
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

/** Returns type(error).__name__: the name of the Python class PEAR raises where pear.js throws ``error``. */
export function pythonErrorName(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Exception";
  }
  const declared = (error as Partial<PythonIdentity>).pythonType;

  return typeof declared === "string" ? declared : error.name;
}

/** Returns str(error): the message of the Python exception. */
export function pythonErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Returns isinstance(error, ValueError): whether PEAR's turn loop rejects the turn (true) or fails it.
 *
 * An error of pear.js is one when its class extends ValueError, or when it declares so (PythonIdentity). An error
 * that is not pear.js's own, thrown by a caller's code or by another copy of the library, is taken for one when it
 * has a true ``isValueError`` or a class named ValueError among its ancestors.
 */
export function isValueError(error: unknown): boolean {
  if (error instanceof ValueError) {
    return true;
  }
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const declared = (error as Partial<PythonIdentity>).isValueError === true;
  if (declared || error instanceof PythonException) {
    return declared;
  }
  for (let prototype = Object.getPrototypeOf(error); prototype !== null; prototype = Object.getPrototypeOf(prototype)) {
    if ((prototype as { constructor?: { name?: unknown } }).constructor?.name === "ValueError") {
      return true;
    }
  }

  return false;
}

/** Returns ``error`` as a result carries it: {"code": type(error).__name__, "message": str(error)}. */
export function motionErrorOf(error: unknown): { code: string; message: string } {
  return { code: pythonErrorName(error), message: pythonErrorMessage(error) };
}
