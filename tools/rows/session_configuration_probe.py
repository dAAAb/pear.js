"""A probe for tests/station-robot/session.test.ts: does PEAR's open read the station's configuration again? It is the
first look that was taken at that question, and it holds no row of that file's header: the rows under "the station's
configuration" are printed by tools/rows/session_rows.py (its section R42, with a tolerance that PEAR accepts).

It makes PEAR's SO-101 robot on the stepped rig of tools/fixtures/robot_fixtures.py (the station "so101_quick", with
settings of its own) and changes the station's configuration to control.settle_timeout_s 7.5 and
robot.gripper_tolerance 0.25. PEAR refuses that tolerance ("SO101Config.gripper_tolerance must be at most 0.2"), so
every open of the probe is refused and the robot is never open in it, whatever the labels of its lines say ("open",
"changed while open", "closed", "open again"). What it shows: the configuration of such a session is not the one
that the fixture script shares among its sessions; and an open that is refused, for the robot's configuration or for
the control's (settle_timeout_s -1.0), leaves the robot's two configurations as they were made (1.0 and 0.02).

Run it with the Python of a PEAR station environment, from the repository's root or from any other directory; PEAR
must be a checkout at the commit that src/index.ts pins, because the rig is PEAR's own test rig (tests/deploy/station),
which the fixture script imports from it:

    <work dir>/envs/station/bin/python tools/rows/session_configuration_probe.py

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
from omegaconf import OmegaConf

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

s = rf.Session("r42", "by hand", "r42", "so101_quick", settings={})
robot = s.robot
config = robot._station_config
print("config is the shared one:", config is rf.STATIONS.config("so101_quick"), "| type", type(config).__name__)
print("made:", robot._control_config.settle_timeout_s, robot._robot_config.gripper_tolerance)
OmegaConf.update(config, "control.settle_timeout_s", 7.5)
OmegaConf.update(config, "robot.gripper_tolerance", 0.25)
print("config now:", config.control.settle_timeout_s, config.robot.gripper_tolerance)
print("changed, not open:", robot._control_config.settle_timeout_s, robot._robot_config.gripper_tolerance)
step = s.do("open")
print("open step:", json.dumps(step.get("out"), default=str)[:300])
print("open:", robot._control_config.settle_timeout_s, robot._robot_config.gripper_tolerance, "| copies:", robot.control_config.settle_timeout_s, robot.robot_config.gripper_tolerance)
OmegaConf.update(config, "control.settle_timeout_s", 9.5)
print("changed while open:", robot._control_config.settle_timeout_s)
s.do("close")
print("closed:", robot._control_config.settle_timeout_s)
s.do("open")
print("open again:", robot._control_config.settle_timeout_s, robot._robot_config.gripper_tolerance)
s.do("close")
OmegaConf.update(config, "control.settle_timeout_s", -1.0)
try:
    robot.open()
    print("refused configuration: opened")
except Exception as error:  # noqa: BLE001
    print("refused configuration:", type(error).__name__, error, "| status", robot.status(), "| kept:", robot._control_config.settle_timeout_s, "| kinematics", robot.kinematics)
OmegaConf.update(config, "control.settle_timeout_s", 9.5)
s.result()
