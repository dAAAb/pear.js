// Ports the exceptions the joint layer raises: Python's built-in RuntimeError, TimeoutError, TypeError,
// ZeroDivisionError and IndexError as pear/deploy/station/control/joint/*.py raise them, and
// pear/deploy/station/exceptions.py (OperatorPaused).
//
// PEAR's station reports a failed action with the name of its error's class as the error's code and the error's text
// as its message, and the model reads both in the next turn. So each class here carries the Python name in `.name`,
// and every message is PEAR's. (StabilityError is in stability.ts and TrackingError in tracking.ts, as in PEAR.)

import { ValueError } from "../../so101/kinematics/errors";

export { ValueError };

/** Python's built-in RuntimeError. */
export class RuntimeError extends Error {
  override readonly name: string = "RuntimeError";
}

/** Python's built-in TimeoutError: a wait that ended before what it waited for. */
export class TimeoutError extends Error {
  override readonly name: string = "TimeoutError";
}

/** Python's built-in TypeError, where PEAR's arithmetic meets a value of the wrong kind (numpy raises it). */
export class PythonTypeError extends Error {
  override readonly name: string = "TypeError";
}

/** Python's built-in ZeroDivisionError. */
export class ZeroDivisionError extends Error {
  override readonly name: string = "ZeroDivisionError";
}

/** Python's built-in IndexError. */
export class IndexError extends Error {
  override readonly name: string = "IndexError";
}

/**
 * What the operator sets to pause an action: PEAR's `threading.Event`. An `AbortSignal` is one, so a page hands the
 * signal of its stop control's `AbortController`.
 */
export interface Cancellation {
  /** Whether the operator has paused: `threading.Event.is_set()`. */
  readonly aborted: boolean;
}

/** Raised when the operator revoked the running operation, which is then never a success that was executed. */
export class OperatorPaused extends RuntimeError {
  override readonly name: string = "OperatorPaused";

  /** Throws OperatorPaused once the operator has set `cancellation`. */
  static checkCancelled(cancellation: Cancellation | null | undefined): void {
    if (cancellation != null && cancellation.aborted) {
      throw new OperatorPaused("Operation interrupted by the operator");
    }
  }
}
