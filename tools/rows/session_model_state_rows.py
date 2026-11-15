"""Prints, for tests/station-robot/session.test.ts, the whole text of what PEAR's model_state raises for joint vectors
that give no state: the rows of that file's header under "model_state", which tools/rows/session_rows.py prints cut
short.

It runs PEAR's SO-101 robot on the stepped rig of tools/fixtures/robot_fixtures.py (the station "so101_quick", opened)
and prints, for a joint 1 that is nan, a joint 0 that is inf, a gripper that is nan, six nan and five joints, what is
raised: the error's class, whether it is a ValueError, the fields of pydantic's errors and the length of its text.
Then it prints the whole texts for the gripper and for joint 1 as JSON strings, whether joint 0 inf has the text of
joint 1 nan and six nan the two texts together, what five joints raise and what seven joints return.

Run it with the Python of a PEAR station environment, from the repository's root or from any other directory; PEAR
must be a checkout at the commit that src/index.ts pins, because the rig is PEAR's own test rig (tests/deploy/station),
which the fixture script imports from it:

    <work dir>/envs/station/bin/python tools/rows/session_model_state_rows.py

It takes no argument: it finds tools/fixtures/robot_fixtures.py from its own place and imports it as a module. It
needs no device and no GPU, and it writes nothing: the rows go to the standard output, and no test reads them. (Python
may keep its bytecode of the fixture script beside it, in a __pycache__ that git ignores; PYTHONDONTWRITEBYTECODE=1
prevents that.)
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

# (tools/fixtures/robot_fixtures.py, found from this file's own place)
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "robot_fixtures.py"
spec = importlib.util.spec_from_file_location("rf", FIXTURES)
rf = importlib.util.module_from_spec(spec)
sys.modules["rf"] = rf
spec.loader.exec_module(rf)
rf.silence()
rf.STATIONS = rf.Stations()
monkeypatch = pytest.MonkeyPatch()
rf.RIG = rf.Rig(monkeypatch, rf.SEED)

s = rf.Session("b20", "by hand", "b20", "so101_quick")
s.enable()
fmt = next(iter(type(s.robot).ACTION_FORMATS.values())).name
nan, inf = float("nan"), float("inf")
texts = {}
for name, joints in (
    ("joint 1 nan", [0.0, nan, 0.0, 0.0, 0.0, 1.0]),
    ("joint 0 inf", [inf, 0.0, 0.0, 0.0, 0.0, 1.0]),
    ("the gripper nan", [0.0, 0.0, 0.0, 0.0, 0.0, nan]),
    ("all nan", [nan] * 6),
    ("five joints", [0.0] * 5),
    ("seven joints", [0.0] * 7),
):
    try:
        out = "returned " + json.dumps(s.robot.model_state(joints, fmt).model_dump())
    except BaseException as error:  # noqa: BLE001
        out = f"{type(error).__name__}: {error}"
        fields = [".".join(str(part) for part in item["loc"]) for item in error.errors()] if hasattr(error, "errors") else None
        print(name, "| class", type(error).__name__, "| is ValueError", isinstance(error, ValueError), "| fields", fields, "| length", len(str(error)))
    texts[name] = out
print(json.dumps(texts["the gripper nan"]))
print(json.dumps(texts["joint 1 nan"]))
print("joint 0 inf is joint 1 nan's text:", texts["joint 0 inf"] == texts["joint 1 nan"])
print("all nan is joint 1 nan's with the gripper's:", texts["all nan"] == texts["joint 1 nan"].replace("5 validation errors", "6 validation errors") + texts["the gripper nan"].split("ModelState", 1)[1])
print(json.dumps(texts["five joints"])[:300])
print(json.dumps(texts["seven joints"])[:300])
s.result()
