// Python's json module as PEAR's station uses it (CPython 3.12, Lib/json and Modules/_json.c):
//   json.dumps with its defaults, for the state of a turn (pear/agent_loop/protocol.py) and for the report of an
//   action (pear/deploy/station/control/robots/so101/formats.py);
//   json.loads with an object_pairs_hook, for the json block of an answer
//   (pear/deploy/station/agent_loop/action_parser.py).
//
// It is with the rest of what pear.js reproduces of Python, in src/python/json.ts, and PythonError (the library's
// class for a Python exception named when it is raised, which this file defined) in src/python/errors.ts; this file
// gives them under the protocol's path.

export { PythonError } from "../python/errors";
export {
  pythonJsonDumps,
  pythonJsonLoads,
  type ObjectPairsHook,
  type PythonJsonInput,
  type PythonJsonValue,
} from "../python/json";
