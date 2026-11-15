// Python's rounding and printing of a float (CPython 3.12, Objects/floatobject.c: float.__round__ and float.__repr__),
// which decide every number the model is shown: pear/deploy/station/agent_loop/messages.py rounds each quantity with
// round(value, decimals) + 0.0 and pear/agent_loop/protocol.py prints the state with json.dumps.
//
// Both are with the rest of what pear.js reproduces of Python, in src/python (float.ts, format.ts); this file gives
// them under the protocol's path.

export { pythonFloatRepr } from "../python/float";
export { pythonRound } from "../python/format";
