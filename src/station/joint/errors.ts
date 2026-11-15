// The exceptions the joint layer raises: Python's built-in ValueError, RuntimeError, TimeoutError, TypeError,
// ZeroDivisionError and IndexError as pear/deploy/station/control/joint/*.py raise them, and
// pear/deploy/station/exceptions.py (OperatorPaused).
//
// PEAR's station reports a failed action with the name of its error's class as the error's code and the error's text
// as its message, and the model reads both in the next turn. So each class carries the Python name in `.name`,
// and every message is PEAR's. (StabilityError is in stability.ts and TrackingError in tracking.ts, as in PEAR.)
//
// The classes themselves are the library's one set of Python exceptions (src/python/errors.ts) and PEAR's
// OperatorPaused (src/station/exceptions.ts); this file gives them under the joint layer's path.

export {
  IndexError,
  PythonTypeError,
  RuntimeError,
  TimeoutError,
  ValueError,
  ZeroDivisionError,
} from "../../python/errors";
export { OperatorPaused, type Cancellation } from "../exceptions";
