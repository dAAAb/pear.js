// Python's notion of whitespace, which PEAR's texts depend on in three places: str.strip() of the environment prompt
// (pear/deploy/station/control/robots/so101/formats.py), str.strip() of what follows an answer's json block
// (pear/deploy/station/agent_loop/action_parser.py) and \s of JSON_BLOCK_PATTERN (pear/agent_loop/protocol.py).
//
// It is with the rest of what pear.js reproduces of Python, in src/python/whitespace.ts; this file gives it under
// the protocol's path.

export { isPythonBlank, PYTHON_WHITESPACE_CLASS, pythonStrip } from "../python/whitespace";
