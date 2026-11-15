// Ports pear/deploy/station/exceptions.py (OperatorPaused), with the built-in Python exceptions PEAR's model client
// and agent loop raise by name (ValueError, RuntimeError, TimeoutError).
//
// PEAR records a turn that did not complete as a result that carries the class name of the Python exception and its
// message (pear/deploy/station/control/motion/results.py, MotionResult.build), and the next turn shows both to the
// model. So every error here carries the Python class's name as its `name`, and the classes extend one another as
// the Python ones do: the agent loop rejects a turn for a ValueError and fails it for any other error.

import { ActionParseError } from "../protocol/action_parser";
import { PythonError } from "../protocol/python_json";
import { MotionStatus, type MotionError } from "../protocol/types";

/** Python's Exception, as the base of the exceptions ported here. */
export class PythonException extends Error {
  override readonly name: string = "Exception";
}

/** Python's built-in ValueError: a value the station refuses. */
export class ValueError extends PythonException {
  override readonly name: string = "ValueError";
}

/** Python's built-in RuntimeError. */
export class RuntimeError extends PythonException {
  override readonly name: string = "RuntimeError";
}

/** Python's built-in TimeoutError. A request that ends at the client's own deadline raises it without a message
 * (asyncio.timeout), so its message is empty by default. */
export class TimeoutError extends PythonException {
  override readonly name: string = "TimeoutError";

  constructor(message = "") {
    super(message);
  }
}

/** Raised when the operator revoked the running operation, which is then never a success that was executed. */
export class OperatorPaused extends RuntimeError {
  override readonly name: string = "OperatorPaused";

  /** Throws OperatorPaused once the operator has aborted ``cancellation``. */
  static checkCancelled(cancellation: AbortSignal | null | undefined): void {
    if (cancellation?.aborted) {
      throw new OperatorPaused("Operation interrupted by the operator");
    }
  }
}

/** Returns type(error).__name__: the name of the Python class PEAR raises where pear.js throws ``error``. */
export function pythonErrorName(error: unknown): string {
  if (error instanceof PythonError) {
    return error.pythonType;
  }
  if (error instanceof ActionParseError) {
    return error.code;
  }
  if (error instanceof Error) {
    return error.name;
  }

  return "Exception";
}

/** Returns str(error): the message of the Python exception. */
export function pythonErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Returns isinstance(error, ValueError): whether PEAR's agent loop rejects the turn (true) or fails it.
 *
 * Besides the classes of this module it knows the two errors of src/protocol, and any error with a class named
 * ValueError among its ancestors or a true ``isValueError``: the other modules of pear.js define their Python
 * exceptions apart from these.
 */
export function isValueError(error: unknown): boolean {
  if (error instanceof ValueError) {
    return true;
  }
  if (error instanceof PythonError) {
    return error.isValueError;
  }
  if (error instanceof ActionParseError) {
    return error.status === MotionStatus.REJECTED;
  }
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if ((error as { isValueError?: unknown }).isValueError === true) {
    return true;
  }
  for (let prototype = Object.getPrototypeOf(error); prototype !== null; prototype = Object.getPrototypeOf(prototype)) {
    if ((prototype as { constructor?: { name?: unknown } }).constructor?.name === "ValueError") {
      return true;
    }
  }

  return false;
}

/** Returns ``error`` as a result carries it: {"code": type(error).__name__, "message": str(error)}. */
export function motionErrorOf(error: unknown): MotionError {
  return { code: pythonErrorName(error), message: pythonErrorMessage(error) };
}
