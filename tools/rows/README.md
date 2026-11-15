# tools/rows

Six test files of `tests/station-robot` hold expectations written by hand, because no record of PEAR holds what they
test; the header of each gives rows that are a run of PEAR's own classes. These scripts are those runs: each prints
what the rows of its test file are taken from.

| Script | Test file |
| --- | --- |
| `observation_rows.py` | `observation.test.ts` |
| `handlers_rows.py` | `handlers.test.ts` |
| `cameras_rows.py` | `cameras.test.ts` |
| `adapter_rows.py` | `adapter.test.ts` |
| `session_rows.py` | `session.test.ts` |
| `session_model_state_rows.py` | `session.test.ts`: the whole texts of `model_state`'s errors, the row of seven joints |
| `session_configuration_probe.py` | `session.test.ts`: the probe before the configuration's rows; it holds no row |
| `guards_rows.py` | `guards.test.ts` |

Run one with the Python of a PEAR station environment, from any directory, with no argument; PEAR must be a checkout
at the commit that `src/index.ts` pins. All but `cameras_rows.py` import the rig of `tools/fixtures/robot_fixtures.py`:

    <work dir>/envs/station/bin/python tools/rows/observation_rows.py

They are not fixture scripts: they write nothing that the tests read (`adapter_rows.py` makes a temporary directory
and removes it). To check the rows against a new PEAR, run a script and compare its output with its test file's header.
