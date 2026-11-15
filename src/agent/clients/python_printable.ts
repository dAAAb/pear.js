// The table of Python's str.isprintable(): the code points repr() writes as an escape (Unicode 15.0.0, the version
// of Python 3.12).
//
// It is with the rest of what pear.js reproduces of Python, in src/python/printable.ts, where
// tools/fixtures/agent_fixtures.py --sync-tables writes it; this file gives it under the client's path.

export { NOT_PRINTABLE_RUNS } from "../../python/printable";
