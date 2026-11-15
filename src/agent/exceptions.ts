// The exceptions PEAR's model client and agent loop raise by name: pear/deploy/station/exceptions.py
// (OperatorPaused) and Python's built-in ValueError, RuntimeError and TimeoutError; with how the loop reads an error
// it caught.
//
// PEAR records a turn that did not complete as a result that carries the class name of the Python exception and its
// message (pear/deploy/station/control/motion/results.py, MotionResult.build), and the next turn shows both to the
// model. So every error carries the Python class's name as its `name`, and the classes extend one another as the
// Python ones do: the agent loop rejects a turn for a ValueError and fails it for any other error.
//
// The classes and the helpers are the library's one set (src/python/errors.ts) and PEAR's OperatorPaused
// (src/station/exceptions.ts); this file gives them under the agent's path.

export {
  isValueError,
  motionErrorOf,
  pythonErrorMessage,
  pythonErrorName,
  PythonException,
  RuntimeError,
  TimeoutError,
  ValueError,
} from "../python/errors";
export { OperatorPaused } from "../station/exceptions";
