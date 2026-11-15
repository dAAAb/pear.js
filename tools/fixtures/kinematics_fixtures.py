"""Writes the fixtures of pear.js's SO-101 kinematics from PEAR's own Python.

Run it inside a PEAR station environment at the pinned commit (PEAR's ``scripts/install.sh station``):

    <work dir>/envs/station/bin/python tools/fixtures/kinematics_fixtures.py

It needs no device and no GPU: it builds PEAR's ``SO101Kinematics`` on the SO-101's shipped defaults (the package's
``config.yaml`` and its own description of the arm) and records what it answers. The files go to
``tests/fixtures/so101-kinematics/`` of this repository, which the script finds from its own location. Every input is
drawn from a fixed seed and stored exactly as PEAR received it; every output is rounded to nine significant digits.
"""

import hashlib
import importlib.metadata
import json
import math
import time
from pathlib import Path
from typing import Any

import numpy as np
from omegaconf import OmegaConf

from pear.deploy.station.control.joint.limits import JointLimits
from pear.deploy.station.control.motion.kinematics import BaseKinematics, UnreachablePoseError
from pear.deploy.station.control.robots.so101.config import SO101Config
from pear.deploy.station.control.robots.so101.layout import GRIPPER_INDEX, JOINTS, LAYOUT, MOTORS, VECTOR_LENGTH
from pear.deploy.station.control.robots.so101.motion.actions import SingleArmDelta
from pear.deploy.station.control.robots.so101.motion.kinematics import SO101Kinematics
from pear.deploy.station.control.robots.so101.robot import SO101Robot

OUTPUT = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "so101-kinematics"
QUANTITIES = SO101Kinematics.ARM_QUANTITIES
HOME = np.array([0.0, -0.814, 0.077, 1.423, -1.613])  # the shipped Home, the pose a task starts from
WORK = np.array([0.2, -0.35, 0.55, 0.4, 0.3])  # the working pose of PEAR's own tests of the arm
POSITION_DECIMALS, ROTATION_DECIMALS = 1, 2  # of the increments a model writes
JOINT_DECIMALS = 4  # of the joint values drawn here, so that the stored input is the input
# how far the joints are moved to see whether PEAR's answer depends on the last digits of its input: a millionth of
# the 1.5 mrad a servo's encoder resolves
PERTURBATION_RAD = 1e-9
SAME_GOAL_RAD = 1e-6  # the largest difference of two joint goals that are the same answer


def rounded(value: Any, digits: int = 9) -> Any:
    """Returns ``value`` with every float rounded to ``digits`` significant digits."""
    if isinstance(value, (float, np.floating)):
        return float(f"{float(value):.{digits}g}")
    if isinstance(value, (list, tuple, np.ndarray)):
        return [rounded(child, digits) for child in value]
    if isinstance(value, dict):
        return {key: rounded(child, digits) for key, child in value.items()}
    return value


def write(name: str, content: dict[str, Any]) -> None:
    """Writes one fixture file: an object whose lists of cases hold one case a line."""
    lines = []
    for key, value in content.items():
        if key == "cases" or key.endswith("_cases"):
            rows = ",\n".join(json.dumps(row, separators=(",", ":")) for row in value)
            lines.append(f"{json.dumps(key)}: [\n{rows}\n]")
        else:
            lines.append(f"{json.dumps(key)}: {json.dumps(value)}")
    text = "{\n" + ",\n".join(lines) + "\n}\n"
    json.loads(text)
    (OUTPUT / name).write_text(text, encoding="utf-8", newline="\n")
    print(f"{name}: {len(text)} bytes")


def default_config() -> SO101Config:
    """Returns the SO-101's settings a station has before its own file changes any: the package's defaults, a value
    left ??? read as a placeholder, as PEAR's robot makes them."""
    defaults = OmegaConf.load(SO101Robot.CONFIG_PATH)
    robot_node = OmegaConf.merge(OmegaConf.structured(SO101Config), defaults.robot)
    for key in OmegaConf.missing_keys(robot_node):
        OmegaConf.update(robot_node, key, SO101Config.PLACEHOLDER.format(key=key))

    return OmegaConf.to_object(robot_node)


class Recorder:
    """Records what one ``joint_target`` call of PEAR's kinematics went through: the error of its first solve, the
    reachable fraction it reported, and how many of its solves took every step they may without converging."""

    def __init__(self, kinematics: SO101Kinematics) -> None:
        self.kinematics = kinematics
        self._solve, self._message = kinematics._solve, kinematics.unreachable_message
        self._step = kinematics.model.inverse_kinematics
        kinematics._solve, kinematics.unreachable_message = self.solve, self.message
        kinematics.model.inverse_kinematics = self.step
        self.reset()

    def reset(self) -> None:
        self.solves, self.first_error, self.fraction, self.unsettled, self.steps = 0, None, None, 0, 0

    def step(self, *arguments: Any) -> np.ndarray:
        self.steps += 1
        return self._step(*arguments)

    def solve(self, joint_positions: np.ndarray, delta: np.ndarray) -> np.ndarray:
        self.solves += 1
        self.steps = 0
        try:
            return self._solve(joint_positions, delta)
        except UnreachablePoseError as error:
            if self.solves == 1:
                self.first_error = str(error)
            raise
        finally:
            # a solve that converges stops before its last step (one that converges on it is counted here too)
            if self.steps >= self.kinematics.geometry.ik_iterations:
                self.unsettled += 1

    def message(self, requested_delta: np.ndarray, fraction: float) -> str:
        self.fraction = fraction
        return self._message(requested_delta, fraction)


class Cases:
    """Draws the joint vectors and the pose increments of the fixtures."""

    def __init__(self, config: SO101Config, seed: int) -> None:
        self.rng = np.random.default_rng(seed)
        self.lower = np.array(config.limits.lower_bounds[:GRIPPER_INDEX])
        self.upper = np.array(config.limits.upper_bounds[:GRIPPER_INDEX])

    def joints(self, style: str | None = None) -> list[float]:
        """Returns a joint vector inside the limits: anywhere in them, or around Home or the working pose."""
        rng = self.rng
        style = style or rng.choice(["uniform", "home", "work"], p=[0.5, 0.3, 0.2])
        if style == "uniform":
            arm = rng.uniform(self.lower, self.upper)
        else:
            centre = HOME if style == "home" else WORK
            arm = np.clip(centre + rng.normal(0, 0.35, GRIPPER_INDEX), self.lower, self.upper)
        arm = np.clip(np.round(arm, JOINT_DECIMALS), self.lower, self.upper)

        return [*arm.tolist(), float(np.round(rng.uniform(0, 1), 3))]

    def position(self, most: float) -> float:
        """Returns a position increment of at most ``most`` cm either way, never zero."""
        value = round(float(self.rng.uniform(0.1, most)), POSITION_DECIMALS)
        return value if self.rng.random() < 0.5 else -value

    def rotation(self, most: float) -> float:
        """Returns a rotation increment of at most ``most`` rad either way, never zero."""
        value = round(float(self.rng.uniform(0.01, most)), ROTATION_DECIMALS)
        return value if self.rng.random() < 0.5 else -value

    def combined(self, most_cm: float, most_rad: float, share: float) -> list[float]:
        """Returns an increment whose quantities each change with probability ``share``, one of them at least."""
        while True:
            delta = [
                (self.position(most_cm) if index < 3 else self.rotation(most_rad)) if self.rng.random() < share else 0.0
                for index in range(len(QUANTITIES))
            ]
            if any(delta):
                return delta

    def single(self, index: int, value: float) -> list[float]:
        """Returns the increment that changes the one quantity at ``index`` by ``value``."""
        delta = [0.0] * len(QUANTITIES)
        delta[index] = value
        return delta

    def joint_target_cases(self) -> list[tuple[str, list[float], list[float]]]:
        """Returns the kind, the start joints and the increment of every inverse-kinematics case."""
        rng = self.rng
        cases: list[tuple[str, list[float], list[float]]] = []

        for _ in range(500):
            cases.append(("single_position", self.joints(), self.single(int(rng.integers(0, 3)), self.position(15.0))))
        for _ in range(300):
            cases.append(("single_rotation", self.joints(), self.single(int(rng.integers(3, 5)), self.rotation(0.9))))
        for _ in range(860):
            cases.append(("combined", self.joints(), self.combined(15.0, 0.9, 0.6)))
        for _ in range(340):
            cases.append(("small", self.joints(), self.combined(2.0, 0.2, 0.7)))
        for _ in range(120):
            # a rest pose read past a limit: by the feedback tolerance at most, or by more
            joints = self.joints()
            for index in rng.choice(GRIPPER_INDEX, size=int(rng.integers(1, 3)), replace=False):
                past = round(float(rng.uniform(0.001, 0.06 if rng.random() < 0.7 else 0.15)), JOINT_DECIMALS)
                joints[index] = float(
                    round(self.upper[index] + past if rng.random() < 0.5 else self.lower[index] - past, JOINT_DECIMALS)
                )
            cases.append(("start_past_limit", joints, self.combined(6.0, 0.4, 0.6)))
        for _ in range(120):
            delta = self.combined(40.0, math.pi, 0.5)
            cases.append(("large", self.joints(), delta))
        for index in (3, 4):
            for sign in (1.0, -1.0):
                cases.append(("large", self.joints(), self.single(index, sign * math.pi)))
        for _ in range(30):
            joints = self.joints()
            if rng.random() < 0.25:
                joints[int(rng.integers(0, GRIPPER_INDEX))] = 2.9  # nothing moves: nothing is checked
            cases.append(("zero", joints, [0.0] * len(QUANTITIES)))
        for _ in range(16):
            delta = self.combined(3.0, 0.3, 0.5)
            delta[int(rng.integers(3, 5))] = float(round(rng.choice([-1, 1]) * rng.uniform(3.142, 6.0), 3))
            cases.append(("rotation_bound", self.joints(), delta))
        for _ in range(16):
            joints = self.joints("work")
            joints[GRIPPER_INDEX] = float(round(rng.choice([-1, 1]) * rng.uniform(0.0, 0.15) + rng.integers(0, 2), 3))
            cases.append(("gripper_reading", joints, self.combined(2.0, 0.2, 0.7)))

        return cases


def pose_fixture(kinematics: SO101Kinematics, cases: Cases) -> dict[str, Any]:
    """Returns the pose and the quantities PEAR reads of joint vectors inside the default limits, with the fingertip's
    frame of the first of them."""
    vectors = [[0.0] * VECTOR_LENGTH, [*HOME.tolist(), 1.0], [*WORK.tolist(), 1.0]]
    # openings whose width is a decimal tie (2.25, 5.25, 0.75 and 3.75 cm), and openings past the endpoints
    vectors += [[*WORK.tolist(), opening] for opening in (0.375, 0.875, 0.125, 0.625, -0.02, 1.03, 0.0)]
    vectors += [cases.joints() for _ in range(2000)]
    rows = []
    for index, vector in enumerate(vectors):
        state = kinematics.quantities(vector)
        row = {
            "joints": vector,
            "pose": rounded(kinematics.pose(vector)),
            # x, y, z, pitch, roll of the arm, then the gripper's width
            "quantities": [*(getattr(state.arm, name) for name in QUANTITIES), state.gripper.width],
        }
        if index < 40:
            frame = kinematics._frame(vector)
            row["frame"] = rounded(frame[:3, :].tolist())
        rows.append(row)

    return {"cases": rows}


def step_fixture(kinematics: SO101Kinematics, cases: Cases) -> dict[str, Any]:
    """Returns single steps of the solver PEAR iterates, lerobot's ``inverse_kinematics`` on placo, each from joints
    whose pose placo holds, as PEAR's solve leaves it: toward a far pose, a near pose, and a frame turned nearly half
    a turn, where the orientation's error is computed another way."""
    rng = cases.rng
    weight = SO101Kinematics.IK_WEIGHT
    rows = []
    for index in range(200):
        joints = np.array(cases.joints("uniform")[:GRIPPER_INDEX])
        if index % 10 == 0:
            joints[int(rng.integers(0, GRIPPER_INDEX))] += 3.6  # a reading far past a limit
        kind = ("far", "near", "half_turn")[index % 3 if index < 150 else 2 * (index % 2)]
        if kind == "far":
            target = kinematics._frame(np.array(cases.joints("uniform")[:GRIPPER_INDEX])).copy()
        elif kind == "near":
            target = kinematics._frame(joints + rng.normal(0, 0.08, GRIPPER_INDEX)).copy()
        else:
            target = kinematics._frame(joints).copy()
            axis = rng.normal(0, 1, 3)
            axis /= np.linalg.norm(axis)
            angle = math.pi - float(rng.uniform(0, 0.02))
            skew = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
            turn = np.eye(3) + math.sin(angle) * skew + (1 - math.cos(angle)) * skew @ skew
            target[:3, :3] = turn @ target[:3, :3]
            target[:3, 3] += rng.normal(0, 0.01, 3)
        target = np.array(rounded(target.tolist(), 12))

        kinematics._frame(joints)
        next_joints = np.radians(kinematics.model.inverse_kinematics(np.degrees(joints), target, weight, weight))
        rows.append(
            {
                "kind": kind,
                "joints": joints.tolist(),
                "rotation": target[:3, :3].reshape(-1).tolist(),
                "position": target[:3, 3].tolist(),
                # twelve digits, as the target: the file pins a numerical procedure
                "next": rounded(next_joints, 12),
            }
        )

    return {"cases": rows}


def joint_target_fixture(kinematics: SO101Kinematics, cases: Cases) -> dict[str, Any]:
    """Returns what PEAR's ``joint_target`` answers each case: the joint goal, or the class and the message of its
    error; for an unreachable pose also the error of the first solve and the reachable fraction."""
    recorder = Recorder(kinematics)
    rows = []
    started = time.monotonic()
    for kind, joints, delta in cases.joint_target_cases():
        action = SingleArmDelta.model_validate({"arm": dict(zip(QUANTITIES, delta)), "gripper": {"width": 0.0}})
        recorder.reset()
        row: dict[str, Any] = {"kind": kind, "joints": joints, "delta": delta}
        goal = None
        try:
            goal = kinematics.joint_target(joints, action)
            row["goal"] = rounded(goal)
        except Exception as error:  # the class is the fixture: the station reports it as the error's code
            row["error"] = {"type": type(error).__name__, "message": str(error)}
            if recorder.fraction is not None:
                row["fraction"] = recorder.fraction
                row["first_error"] = recorder.first_error
        if recorder.unsettled:
            # how many of the solves behind this answer ran out of steps: each returned whatever its last step was
            row["unsettled"] = recorder.unsettled

        # PEAR's own answer again, from joints moved by PERTURBATION_RAD: where the solver's loop does not settle,
        # the answer follows the last digits of its input, and no port can be held to it
        fraction = recorder.fraction
        if any(delta) and (goal is not None or fraction is not None):
            moved = [*(np.array(joints[:GRIPPER_INDEX]) + PERTURBATION_RAD).tolist(), joints[GRIPPER_INDEX]]
            recorder.reset()
            moved_goal = None
            try:
                moved_goal = kinematics.joint_target(moved, action)
            except UnreachablePoseError:
                pass
            if goal is not None and moved_goal is not None:
                is_same = bool(np.max(np.abs(moved_goal - goal)) <= SAME_GOAL_RAD)
            else:
                is_same = goal is None and moved_goal is None and recorder.fraction == fraction
            if not is_same:
                row["perturbed"] = {"reachable": moved_goal is not None, "fraction": recorder.fraction}
        rows.append(row)
    print(f"joint_target: {len(rows)} cases in {time.monotonic() - started:.0f} s")

    return {"cases": rows}


def text_fixture(config: SO101Config) -> dict[str, Any]:
    """Returns the texts PEAR words from numbers: the unreachable message, the truncated values and the bounds'
    refusal."""
    rng = np.random.default_rng(7)
    values = [0.0, 0.05, -0.05, 0.1, -0.1, 0.149999, 0.15, 0.85, 1.0, -1.0, 2.5, -2.5, 0.25, 0.75, 0.125, 0.375]
    values += [15.25, -15.25, 40.0, 100.0, 0.001, -0.001, 0.0001, 0.00001, 123456.0, 1234567.0, 1234565.0, 100000.5]
    values += [999999.5, 0.000123456789, 1e16, 1.5e-7, 2.675, 0.3, 0.1 + 0.2, 1 / 3, -2 / 3, 0.0999999, 9.99999949]
    values += [float(value) for value in np.round(rng.uniform(-20, 20, 60), 1)]
    values += [float(value) for value in np.round(rng.uniform(-1, 1, 60), 2)]
    values += [float(value) for value in rng.uniform(-20, 20, 40)]

    truncated = [
        {"value": value, "decimals": decimals, "text": BaseKinematics.truncated_text(value, decimals)}
        for value in values
        for decimals in (1, 2)
    ]

    messages = []
    fractions = [index / 2**BaseKinematics.REACH_BISECTIONS for index in (0, 1, 3, 23, 24, 64, 77, 100, 127)]
    for index in range(260):
        if index < len(values):
            delta = [0.0] * len(QUANTITIES)
            delta[index % len(QUANTITIES)] = values[index]
        else:
            delta = [float(value) if rng.random() < 0.6 else 0.0 for value in rng.choice(values, len(QUANTITIES))]
        fraction = float(rng.choice(fractions))
        messages.append(
            {
                "delta": delta,
                "fraction": fraction,
                "text": SO101Kinematics.unreachable_message(np.array(delta, dtype=float), fraction),
            }
        )

    limits = config.joint_limits()
    lower, upper = np.array(limits.lower_bounds), np.array(limits.upper_bounds)
    bounds = []
    for index in range(120):
        vector = np.round(rng.uniform(lower, upper), 4)
        for coordinate in rng.choice(VECTOR_LENGTH, size=int(rng.integers(0, 4)), replace=False):
            past = float(rng.choice([1e-10, 1e-8, 0.001, 0.0599, 0.06, 0.0600001, 0.07, 0.5]))
            vector[coordinate] = upper[coordinate] + past if rng.random() < 0.5 else lower[coordinate] - past
        tolerance = limits.feedback_tolerance if index % 2 else 0.0
        bounds.append(bounds_case(limits, vector.tolist(), tolerance))
    for vector in ([0.0] * 5, [0.0] * 7, [0.0, 0.0, math.nan, 0.0, 0.0, 0.5], [0.0, math.inf, 0.0, 0.0, 0.0, 0.5]):
        bounds.append(bounds_case(limits, vector, limits.feedback_tolerance))
    # values whose seventh decimal is an exact 5: Python words such a tie to the even digit
    for vector in ([2.0078125, 0.0, 0.0, 0.0, 0.0, 1.5078125], [0.0, -1.8203125, 1.6796875, 0.0, 0.0, -0.3046875]):
        bounds.append(bounds_case(limits, vector, 0.0))

    return {"truncated_cases": truncated, "message_cases": messages, "bounds_cases": bounds}


def bounds_case(limits: JointLimits, vector: list[float], tolerance: float) -> dict[str, Any]:
    """Returns what PEAR's bounds check says of ``vector``: None when it passes, else its refusal."""
    try:
        limits.check_positions(vector, LAYOUT, tolerance)
        message = None
    except ValueError as error:
        message = str(error)
    # JSON has no NaN and no infinity: a value that is not finite is stored as its name
    stored = [value if math.isfinite(value) else str(value) for value in vector]

    return {"vector": stored, "tolerance": tolerance, "message": message}


def meta_fixture(config: SO101Config, kinematics: SO101Kinematics) -> dict[str, Any]:
    """Returns what the fixtures were made from: the versions, the description's hash, PEAR's defaults and the
    constants of its classes that pear.js repeats."""
    defaults = OmegaConf.to_container(OmegaConf.load(SO101Robot.CONFIG_PATH))
    limits = config.joint_limits()
    texts = LAYOUT.texts

    return {
        "versions": {name: importlib.metadata.version(name) for name in ("placo", "lerobot", "numpy")},
        "urdf": {
            "name": Path(config.geometry.urdf).name,
            "sha256": hashlib.sha256(Path(config.geometry.urdf).read_bytes()).hexdigest(),
        },
        "config": defaults,
        "layout": {
            "joints": list(JOINTS),
            "motors": list(MOTORS),
            "arms": list(LAYOUT.arms),
            "vector_length": VECTOR_LENGTH,
            "gripper_index": GRIPPER_INDEX,
            "joint_unit": LAYOUT.JOINT_UNIT,
            "gripper_unit": LAYOUT.GRIPPER_UNIT,
            "texts": {name: getattr(texts, name) for name in texts.__dataclass_fields__},
        },
        "kinematics": {
            "arm_quantities": list(QUANTITIES),
            "decimals": SO101Kinematics.DECIMALS,
            "end_effector_frame": SO101Kinematics.END_EFFECTOR_FRAME,
            "shoulder_frame": SO101Kinematics.SHOULDER_FRAME,
            "convergence_rad": SO101Kinematics.CONVERGENCE_RAD,
            "ik_weight": SO101Kinematics.IK_WEIGHT,
            "reach_bisections": BaseKinematics.REACH_BISECTIONS,
            "plane_axis": rounded(kinematics._plane_axis),
        },
        "limits": {
            "epsilon": JointLimits.EPSILON,
            "feedback_tolerance": limits.feedback_tolerance,
            "lower_bounds": list(limits.lower_bounds),
            "upper_bounds": list(limits.upper_bounds),
        },
    }


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    config = default_config()
    kinematics = SO101Kinematics(config)

    write("meta.json", meta_fixture(config, kinematics))
    write("texts.json", text_fixture(config))
    write("poses.json", pose_fixture(kinematics, Cases(config, seed=101)))
    write("steps.json", step_fixture(kinematics, Cases(config, seed=303)))
    write("joint_targets.json", joint_target_fixture(kinematics, Cases(config, seed=202)))


if __name__ == "__main__":
    main()
