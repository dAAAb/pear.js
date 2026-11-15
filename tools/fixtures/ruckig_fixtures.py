"""Writes the fixtures of pear.js's port of Ruckig from the ``ruckig`` Python module itself.

Run it inside a PEAR station environment (PEAR's ``scripts/install.sh station``), from the root of this repository:

    <work dir>/envs/station/bin/python tools/fixtures/ruckig_fixtures.py --output tests/fixtures/ruckig

It needs no device and no GPU. Every expected value is what the installed ``ruckig`` module answered; the script holds
no trajectory mathematics of its own. Every input is drawn from a fixed seed, so two runs write the same bytes.
``--scale`` multiplies the number of cases (the committed set is scale 1); ``--only`` restricts the sets written.
``--libm DIR`` writes no fixtures: it extends the table ``DIR/libm.json`` of the C library's own cube roots, sines,
cosines, arc tangents and arc cosines, with which tests/ruckig/exact.test.ts compares the port to the last bit (see
``extend_libm_table``).

The sets, one file each:

    a_pear      one coordinate in PEAR's regime: position interface, target at rest, caps of the SO-101's size
    b_general   one coordinate, any current and target state, asymmetric caps, minimum duration, discrete duration
    c_velocity  one coordinate, velocity interface: stops and velocity targets
    d_multi     2, 3, 6, 7 and 14 coordinates: time and phase synchronization and the other modes
    e_sessions  scripted sessions of ``update`` calls, among them PEAR's own call patterns
    f_refused   refused inputs and what the module raises or returns for them
    g_lower     infinite jerk or acceleration caps (Ruckig's second- and first-order paths)
    h_sort      the order in which the C++ standard library the module was built with leaves the equal elements of a
                sorted range (needs g++, the compiler the station's install built the module with): {"k", "keys",
                "order": the indices of the keys as std::sort leaves them when they are compared by their keys};
                and what std::min and std::max give for two numbers: {"k": "minmax", "keys": the two, "order": their
                minimum and maximum}

A case of the sets a, b, c, d and g is one line:

    {"k": kind, "n": coordinates,
     "i": [current_position, current_velocity, current_acceleration, target_position, target_velocity,
           target_acceleration, max_velocity, max_acceleration, max_jerk],
     "o": {the other inputs, when set: vmin, amin (min_velocity, min_acceleration), ci (control_interface),
           sync (synchronization), disc (discrete duration), dt (the generator's delta_time), mind (minimum_duration),
           enabled, pci, psync (per_dof_control_interface, per_dof_synchronization)},
     "r": result of calculate  or  "e": the message of the error it raised ("et": its class, unless RuckigError),
     "d": duration, "m": independent_min_durations, "id": intermediate_durations (when not [duration]),
     "p": one row a coordinate: [t, j, a, v, p, [pf, vf, af], repr, brake, accel]; brake and accel are
          [duration, t, j, a, v, p], and are left out when every number of theirs is +0.0,
     "x": position_extrema, one [min, max, t_min, t_max] a coordinate,
     "s": samples [time, position, velocity, acceleration] of at_time,
     "f": probes [coordinate, position, time_after, time or null] of get_first_time_at_position}

A number that is not finite is written as the string "nan", "inf" or "-inf".
"""

import argparse
import importlib.metadata
import json
import math
import platform
import random
import shutil
import subprocess
import tempfile
from collections import Counter
from collections.abc import Iterable, Iterator
from itertools import chain
from pathlib import Path
from typing import Any

import pear
import yaml
from ruckig import (
    ControlInterface,
    DurationDiscretization,
    InputParameter,
    OutputParameter,
    Ruckig,
    RuckigError,
    Synchronization,
    Trajectory,
)

VECTORS = (
    "current_position",
    "current_velocity",
    "current_acceleration",
    "target_position",
    "target_velocity",
    "target_acceleration",
    "max_velocity",
    "max_acceleration",
    "max_jerk",
)
INTERFACES = {"Position": ControlInterface.Position, "Velocity": ControlInterface.Velocity}
SYNCHRONIZATIONS = {
    "Time": Synchronization.Time,
    "TimeIfNecessary": Synchronization.TimeIfNecessary,
    "Phase": Synchronization.Phase,
    "No": Synchronization.No,
}
# velocity, acceleration and jerk caps of a release in PEAR's joint/recovery.py (RecoveryPolicy.RELEASE_CAPS)
RELEASE_CAPS = (0.1, 0.2, 1.0)
PERIODS = (0.001, 0.004, 0.01, 0.02, 0.05, 0.1)  # control periods of the cases that need one, s

# cases of each set at scale 1
BASE_COUNTS = {"a_pear": 460, "b_general": 530, "c_velocity": 290, "d_multi": 110, "e_sessions": 24, "g_lower": 40, "h_sort": 110}


# ---------------------------------------------------------------------------------------------------------------------
# PEAR's numbers


def pear_numbers() -> dict[str, Any]:
    """Returns the SO-101's limits, stop caps and Home scale and the station's control rate, as PEAR ships them."""
    root = Path(pear.__file__).resolve().parent
    robot_path = root / "deploy" / "station" / "control" / "robots" / "so101" / "config.yaml"
    robot = yaml.safe_load(robot_path.read_text(encoding="utf-8"))["robot"]
    station = yaml.safe_load((root / "configs" / "station.yaml").read_text(encoding="utf-8"))
    limits = robot["limits"]
    names = ("lower_bounds", "upper_bounds", "velocity", "acceleration", "jerk", "stop_acceleration", "stop_jerk")
    numbers = {name: [float(value) for value in limits[name]] for name in names}
    numbers["home_speed_scale"] = float(robot["home"]["speed_scale"])
    numbers["home_position"] = [float(value) for value in robot["home"]["position"]]
    numbers["rate_hz"] = float(station["control"]["rate_hz"])

    return numbers


class Pear:
    """PEAR's caps as its ``JointLimits`` hands them to Ruckig."""

    def __init__(self) -> None:
        self.numbers = pear_numbers()
        self.period = 1 / self.numbers["rate_hz"]
        self.dofs = len(self.numbers["velocity"])
        self.gripper = self.dofs - 1

    def motion_caps(self, speed_scale: float = 1.0, within: tuple[float, ...] | None = None) -> list[list[float]]:
        """Returns the velocity, acceleration and jerk caps of every coordinate, time-scaled by ``speed_scale`` as
        ``JointLimits.motion_caps`` scales them, each first lowered to ``within`` if given."""
        caps = []
        for order, name in enumerate(("velocity", "acceleration", "jerk"), 1):
            values = self.numbers[name]
            if within is not None:
                values = [min(value, within[order - 1]) for value in values]
            caps.append([value * speed_scale**order for value in values])

        return caps

    def braking_caps(self) -> list[list[float]]:
        """Returns the acceleration and jerk caps of a controlled stop."""
        return [list(self.numbers["stop_acceleration"]), list(self.numbers["stop_jerk"])]

    def coordinate_caps(self, rng: random.Random) -> tuple[list[float], int]:
        """Returns the velocity, acceleration and jerk caps of one coordinate drawn among the arm's and the
        gripper's, at full speed, at Home's speed, at another speed or as a release, and the coordinate."""
        coordinate = self.gripper if rng.random() < 0.25 else rng.randrange(self.gripper)
        style = rng.choice(["full", "full", "full", "home", "scaled", "release"])
        if style == "release":
            caps = self.motion_caps(1.0, RELEASE_CAPS)
        elif style == "home":
            caps = self.motion_caps(self.numbers["home_speed_scale"])
        elif style == "scaled":
            caps = self.motion_caps(round(rng.uniform(0.05, 1.0), 3))
        else:
            caps = self.motion_caps()

        return [values[coordinate] for values in caps], coordinate

    def position(self, rng: random.Random, coordinate: int) -> float:
        """Returns a position inside the bounds of ``coordinate``."""
        low, high = self.numbers["lower_bounds"][coordinate], self.numbers["upper_bounds"][coordinate]
        return rng.uniform(low, high)

    def pose(self, rng: random.Random) -> list[float]:
        """Returns a joint vector inside the bounds."""
        return [self.position(rng, coordinate) for coordinate in range(self.dofs)]


# ---------------------------------------------------------------------------------------------------------------------
# reading the module


def is_plain_zero(value: Any) -> bool:
    """Whether ``value`` is +0.0, or a list of them."""
    if isinstance(value, list):
        return all(is_plain_zero(child) for child in value)
    return value == 0 and math.copysign(1.0, value) > 0


def brake_row(brake: Any) -> list[Any]:
    return [brake.duration, list(brake.t), list(brake.j), list(brake.a), list(brake.v), list(brake.p)]


def profile_row(profile: Any) -> list[Any]:
    """Returns every field of one coordinate's profile the module shows; the limits, the direction and the control
    signs are read from its text, the only form in which the module gives them."""
    row = [
        list(profile.t),
        list(profile.j),
        list(profile.a),
        list(profile.v),
        list(profile.p),
        [profile.pf, profile.vf, profile.af],
        repr(profile),
    ]
    brake, accel = brake_row(profile.brake), brake_row(profile.accel)
    if not is_plain_zero(accel):
        row += [brake, accel]
    elif not is_plain_zero(brake):
        row.append(brake)

    return row


def build_input(case: dict[str, Any]) -> InputParameter:
    """Returns the module's input of ``case``."""
    ruckig_input = InputParameter(case["n"])
    for name, vector in zip(VECTORS, case["i"]):
        setattr(ruckig_input, name, list(vector))
    options = case.get("o", {})
    if "vmin" in options:
        ruckig_input.min_velocity = list(options["vmin"])
    if "amin" in options:
        ruckig_input.min_acceleration = list(options["amin"])
    if "ci" in options:
        ruckig_input.control_interface = INTERFACES[options["ci"]]
    if "sync" in options:
        ruckig_input.synchronization = SYNCHRONIZATIONS[options["sync"]]
    if options.get("disc"):
        ruckig_input.duration_discretization = DurationDiscretization.Discrete
    if "mind" in options:
        ruckig_input.minimum_duration = options["mind"]
    if "enabled" in options:
        ruckig_input.enabled = list(options["enabled"])
    if "pci" in options:
        ruckig_input.per_dof_control_interface = [INTERFACES[name] for name in options["pci"]]
    if "psync" in options:
        ruckig_input.per_dof_synchronization = [SYNCHRONIZATIONS[name] for name in options["psync"]]
    if "ip" in options:
        ruckig_input.intermediate_positions = [list(row) for row in options["ip"]]

    return ruckig_input


def build_generator(case: dict[str, Any]) -> Ruckig:
    """Returns the module's generator of ``case``: with a control period only where the case names one."""
    options = case.get("o", {})
    return Ruckig(case["n"], options["dt"]) if "dt" in options else Ruckig(case["n"])


def calculate(case: dict[str, Any]) -> tuple[Trajectory, bool]:
    """Runs ``calculate`` on ``case``, writes what it returned or raised into the case, and returns the trajectory
    and whether it was computed."""
    trajectory = Trajectory(case["n"])
    try:
        result = int(build_generator(case).calculate(build_input(case), trajectory))
        case["r"] = result
    except RuckigError as error:
        case["e"] = str(error)
        result = -1
    except Exception as error:  # what the binding itself raises, e.g. for a result it has no name for
        case["e"], case["et"] = str(error), type(error).__name__
        result = -1

    return trajectory, result >= 0


def boundary_time(rng: random.Random, trajectory: Trajectory) -> float:
    """Returns a time at which a coordinate of ``trajectory`` passes from one of its phases to the next."""
    profile = rng.choice(trajectory.profiles[0])
    elapsed = profile.t[0]
    for index in range(1, rng.randrange(1, 8)):
        elapsed = elapsed + profile.t[index]

    return profile.brake.duration + elapsed


def sample_times(rng: random.Random, trajectory: Trajectory, count: int) -> list[float]:
    """Returns ``count`` times at which to read ``trajectory``: inside it, at its ends, at a phase boundary, past
    its end, and rarely before its start."""
    duration = trajectory.duration
    if not math.isfinite(duration):
        return [0.0]

    def edge() -> float:
        choice = rng.random()
        if choice < 0.4:
            return duration
        if choice < 0.6:
            return 0.0
        if choice < 0.7:
            return -rng.uniform(0.0, 0.1)
        return duration + rng.uniform(0.0, 1.0)

    times = [rng.uniform(0.0, duration)]
    if count >= 5:
        times += [rng.uniform(0.0, duration), boundary_time(rng, trajectory), edge(), duration + rng.uniform(0.0, 1.0)]
    else:
        times += [boundary_time(rng, trajectory) if rng.random() < 0.5 else rng.uniform(0.0, duration), edge()]

    return times[:count]


def finish(rng: random.Random, case: dict[str, Any], sample_count: int | None = None) -> dict[str, Any]:
    """Computes ``case`` with the module and adds everything it answers."""
    trajectory, is_computed = calculate(case)
    case["d"] = trajectory.duration
    case["m"] = list(trajectory.independent_min_durations)
    case["p"] = [profile_row(profile) for profile in trajectory.profiles[0]]
    if not is_computed:
        return case

    intermediate_durations = list(trajectory.intermediate_durations)
    if intermediate_durations != [trajectory.duration]:
        case["id"] = intermediate_durations
    case["x"] = [[bound.min, bound.max, bound.t_min, bound.t_max] for bound in trajectory.position_extrema]
    if sample_count is None:
        sample_count = 5 if case["n"] == 1 else 3
    case["s"] = [[time, *trajectory.at_time(time)] for time in sample_times(rng, trajectory, sample_count)]

    if rng.random() < 0.3 and math.isfinite(trajectory.duration):
        coordinate = rng.randrange(case["n"])
        start, goal = case["i"][0][coordinate], case["i"][3][coordinate]
        position = start + rng.uniform(-0.2, 1.2) * (goal - start)
        time_after = 0.0 if rng.random() < 0.7 else rng.uniform(0.0, trajectory.duration)
        case["f"] = [
            [coordinate, position, time_after, trajectory.get_first_time_at_position(coordinate, position, time_after)]
        ]

    return case


def is_valid(case: dict[str, Any]) -> bool:
    """Whether the module accepts the input of ``case``."""
    try:
        return bool(build_generator(case).validate_input(build_input(case)))
    except RuckigError:
        return False


def state_along(rng: random.Random, case: dict[str, Any]) -> tuple[list[float], list[float], list[float]] | None:
    """Returns the state the module gives at a time inside the trajectory of ``case``, or None if it computes
    none or one without duration."""
    trajectory, is_computed = calculate(dict(case))
    if not is_computed or not math.isfinite(trajectory.duration) or trajectory.duration <= 0:
        return None

    position, velocity, acceleration = trajectory.at_time(rng.uniform(0.0, trajectory.duration))
    return list(position), list(velocity), list(acceleration)


# ---------------------------------------------------------------------------------------------------------------------
# drawing numbers


def log_uniform(rng: random.Random, low: float, high: float) -> float:
    return math.exp(rng.uniform(math.log(low), math.log(high)))


def either_sign(rng: random.Random, value: float) -> float:
    return value if rng.random() < 0.5 else -value


def distance(rng: random.Random, most: float = 3.4) -> float:
    """Returns how far a coordinate moves: from a hundredth of a milliradian to its whole range, or nothing."""
    if rng.random() < 0.03:
        return 0.0
    return either_sign(rng, log_uniform(rng, 1e-5, most))


def random_caps(rng: random.Random) -> list[float]:
    """Returns velocity, acceleration and jerk caps over several orders of magnitude: mostly with the times to
    reach the velocity cap and the acceleration cap between hundredths of a second and seconds, as a machine's
    are, and sometimes each on its own."""
    velocity = log_uniform(rng, 0.05, 20.0)
    if rng.random() < 0.1:
        return [velocity, log_uniform(rng, 0.05, 100.0), log_uniform(rng, 0.1, 1000.0)]
    acceleration = velocity / log_uniform(rng, 0.05, 5.0)

    return [velocity, acceleration, acceleration / log_uniform(rng, 0.02, 2.0)]


def one(case_kind: str, state: list[float], target: list[float], caps: list[float], **options: Any) -> dict[str, Any]:
    """Returns a case of one coordinate from its current ``state`` and ``target`` (position, velocity,
    acceleration) and its ``caps``."""
    case: dict[str, Any] = {"k": case_kind, "n": 1, "i": [[value] for value in (*state, *target, *caps)]}
    if options:
        case["o"] = options
    return case


def many(case_kind: str, vectors: list[list[float]], **options: Any) -> dict[str, Any]:
    """Returns a case of several coordinates from its nine input vectors."""
    case: dict[str, Any] = {"k": case_kind, "n": len(vectors[0]), "i": [list(vector) for vector in vectors]}
    if options:
        case["o"] = options
    return case


def general_state(rng: random.Random, caps: list[float], overshoot: float = 0.15) -> list[float]:
    """Returns a position, velocity and acceleration: mostly within ``caps``, sometimes past them or at rest."""
    velocity_cap, acceleration_cap = caps[0], caps[1]
    style = rng.random()
    if style < 0.08:
        return [rng.uniform(-5.0, 5.0), 0.0, 0.0]
    velocity_scale = 1.4 if rng.random() < overshoot else 1.0
    acceleration_scale = 1.4 if rng.random() < overshoot else 1.0
    velocity = rng.uniform(-velocity_cap, velocity_cap) * velocity_scale
    acceleration = rng.uniform(-acceleration_cap, acceleration_cap) * acceleration_scale
    if style < 0.16:
        acceleration = 0.0
    elif style < 0.22:
        velocity = 0.0

    return [rng.uniform(-5.0, 5.0), velocity, acceleration]


def with_valid_target(rng: random.Random, case: dict[str, Any], coordinates: Iterable[int] | None = None) -> None:
    """Draws target velocities and accelerations of ``case`` until the module accepts them, and leaves the target
    at rest if it accepts none."""
    indices = list(range(case["n"])) if coordinates is None else list(coordinates)
    for _ in range(20):
        for index in indices:
            case["i"][4][index] = rng.uniform(-1.0, 1.0) * case["i"][6][index]
            case["i"][5][index] = rng.uniform(-1.0, 1.0) * case["i"][7][index] * rng.choice([1.0, 0.3, 0.0])
        if is_valid(case):
            return
    for index in indices:
        case["i"][4][index] = case["i"][5][index] = 0.0


def rounded_case(case: dict[str, Any], decimals: int) -> None:
    """Rounds every input vector of ``case`` to ``decimals`` places, keeping caps above zero."""
    for index, vector in enumerate(case["i"]):
        case["i"][index] = [
            max(round(value, decimals), 10.0**-decimals) if index >= 6 else round(value, decimals) for value in vector
        ]


# ---------------------------------------------------------------------------------------------------------------------
# set a: one coordinate, PEAR's regime


def pear_rest_case(rng: random.Random, robot: Pear, caps: list[float], coordinate: int) -> dict[str, Any]:
    start = robot.position(rng, coordinate)
    return one("rest", [start, 0.0, 0.0], [start + distance(rng), 0.0, 0.0], caps)


def pear_target(rng: random.Random, robot: Pear, coordinate: int, position: float, old_target: float) -> float:
    """Returns a new target for a coordinate now at ``position`` on its way to ``old_target``."""
    choice = rng.random()
    if choice < 0.45:
        return robot.position(rng, coordinate)
    if choice < 0.6:
        return old_target
    if choice < 0.75:
        return position + either_sign(rng, log_uniform(rng, 1e-6, 0.05))
    if choice < 0.8:
        return position
    return old_target + either_sign(rng, log_uniform(rng, 1e-4, 0.5))


def set_a(rng: random.Random, count: int, robot: Pear) -> Iterator[dict[str, Any]]:
    stop_acceleration, stop_jerk = robot.braking_caps()
    for _ in range(count):
        caps, coordinate = robot.coordinate_caps(rng)
        full_caps = [values[coordinate] for values in robot.motion_caps()]
        choice = rng.random()
        case = None

        if choice < 0.22:
            case = pear_rest_case(rng, robot, caps, coordinate)
        elif choice < 0.52:
            # retargeted in the middle of a motion, with the caps of that motion
            motion = pear_rest_case(rng, robot, caps, coordinate)
            state = state_along(rng, motion)
            if state is not None:
                position, velocity, acceleration = (vector[0] for vector in state)
                target = pear_target(rng, robot, coordinate, position, motion["i"][3][0])
                case = one("moving", [position, velocity, acceleration], [target, 0.0, 0.0], caps)
        elif choice < 0.74:
            # a motion at full caps, retargeted with lower ones: the state may lie outside them
            motion = pear_rest_case(rng, robot, full_caps, coordinate)
            state = state_along(rng, motion)
            if state is not None:
                position, velocity, acceleration = (vector[0] for vector in state)
                scale = rng.choice([robot.numbers["home_speed_scale"], round(rng.uniform(0.05, 0.9), 3)])
                lowered = [values[coordinate] for values in robot.motion_caps(scale)]
                if rng.random() < 0.2:
                    lowered = [values[coordinate] for values in robot.motion_caps(1.0, RELEASE_CAPS)]
                target = pear_target(rng, robot, coordinate, position, motion["i"][3][0])
                case = one("outside", [position, velocity, acceleration], [target, 0.0, 0.0], lowered)
        elif choice < 0.86:
            # in the middle of a controlled stop, whose caps are higher, a new target at the motion caps
            motion = pear_rest_case(rng, robot, full_caps, coordinate)
            state = state_along(rng, motion)
            if state is not None:
                stop_caps = [full_caps[0], stop_acceleration[coordinate], stop_jerk[coordinate]]
                stop = one("stop", [vector[0] for vector in state], [0.0, 0.0, 0.0], stop_caps, ci="Velocity")
                state = state_along(rng, stop)
            if state is not None:
                position, velocity, acceleration = (vector[0] for vector in state)
                target = pear_target(rng, robot, coordinate, position, motion["i"][3][0])
                case = one("after_stop", [position, velocity, acceleration], [target, 0.0, 0.0], caps)
        else:
            # the same shapes with every cap and distance scaled, or with caps of any size
            if rng.random() < 0.5:
                factor = log_uniform(rng, 0.01, 100.0)
                scaled = [value * factor for value in caps]
            else:
                factor, scaled = 1.0, random_caps(rng)
            start = robot.position(rng, coordinate) * factor
            motion = one("scaled", [start, 0.0, 0.0], [start + distance(rng) * factor, 0.0, 0.0], scaled)
            case = motion
            if rng.random() < 0.6:
                state = state_along(rng, motion)
                if state is not None:
                    position, velocity, acceleration = (vector[0] for vector in state)
                    target = position + distance(rng) * factor
                    case = one("scaled", [position, velocity, acceleration], [target, 0.0, 0.0], scaled)

        if case is None:
            case = pear_rest_case(rng, robot, caps, coordinate)
        yield finish(rng, case)


# ---------------------------------------------------------------------------------------------------------------------
# set b: one coordinate, general


def general_case(rng: random.Random, case_kind: str = "general") -> dict[str, Any]:
    caps = random_caps(rng)
    state = general_state(rng, caps)
    target_position = state[0] + distance(rng, 8.0) if rng.random() < 0.5 else rng.uniform(-5.0, 5.0)
    case = one(case_kind, state, [target_position, 0.0, 0.0], caps)
    if rng.random() < 0.8:
        with_valid_target(rng, case)

    return case


def with_minimum_duration(rng: random.Random, case: dict[str, Any]) -> None:
    """Sets the minimum duration of ``case`` around the duration the module gives without one."""
    trajectory, is_computed = calculate(dict(case))
    duration = trajectory.duration if is_computed and math.isfinite(trajectory.duration) else 1.0
    choice = rng.random()
    if choice < 0.5:
        minimum = duration * rng.uniform(1.0, 3.0)
    elif choice < 0.75:
        minimum = duration + rng.uniform(0.0, 5.0)
    elif choice < 0.85:
        minimum = duration
    elif choice < 0.95:
        minimum = duration * rng.uniform(0.0, 1.0)
    else:
        minimum = round(duration + rng.uniform(0.0, 2.0), 2)
    case.setdefault("o", {})["mind"] = minimum


def set_b(rng: random.Random, count: int) -> Iterator[dict[str, Any]]:
    for _ in range(count):
        choice = rng.random()
        if choice < 0.36:
            case = general_case(rng)
        elif choice < 0.5:
            case = general_case(rng, "rounded")
            rounded_case(case, rng.choice([1, 1, 2]))
            if not is_valid(case):
                case["i"][4][0] = case["i"][5][0] = 0.0
        elif choice < 0.64:
            case = general_case(rng, "asymmetric")
            options = case.setdefault("o", {})
            if rng.random() < 0.8:
                options["vmin"] = [-case["i"][6][0] * log_uniform(rng, 0.1, 3.0)]
            if rng.random() < 0.8 or "vmin" not in options:
                options["amin"] = [-case["i"][7][0] * log_uniform(rng, 0.1, 3.0)]
            if not is_valid(case):
                with_valid_target(rng, case)
        elif choice < 0.82:
            case = general_case(rng, "minimum_duration")
            if rng.random() < 0.3:
                case["i"][1][0] = case["i"][2][0] = case["i"][4][0] = case["i"][5][0] = 0.0
            if rng.random() < 0.2:
                case.setdefault("o", {})["amin"] = [-case["i"][7][0] * log_uniform(rng, 0.2, 2.0)]
                if not is_valid(case):
                    case["i"][4][0] = case["i"][5][0] = 0.0
            with_minimum_duration(rng, case)
        elif choice < 0.88:
            case = general_case(rng, "discrete")
            case.setdefault("o", {}).update(disc=True, dt=rng.choice(PERIODS))
            if rng.random() < 0.3:
                with_minimum_duration(rng, case)
        elif choice < 0.94:
            # numbers at the thresholds the algorithm compares with: nearly at rest, nearly there
            case = general_case(rng, "tiny")
            for index in (1, 2, 4, 5):
                if rng.random() < 0.6:
                    case["i"][index][0] = either_sign(rng, log_uniform(rng, 1e-17, 1e-8))
            if rng.random() < 0.5:
                case["i"][3][0] = case["i"][0][0] + either_sign(rng, log_uniform(rng, 1e-17, 1e-7))
            if not is_valid(case):
                case["i"][4][0] = case["i"][5][0] = 0.0
        elif choice < 0.96:
            case = general_case(rng, "infinite_velocity")
            case["i"][6][0] = math.inf
            case["i"][4][0] = rng.uniform(-2.0, 2.0)
        else:
            # a cap of zero: only a motion that needs no jerk, or no acceleration, exists
            case = general_case(rng, "zero_limit")
            which = rng.random()
            if which < 0.5:
                case["i"][8][0] = 0.0
                acceleration = rng.choice([0.0, rng.uniform(-1.0, 1.0) * case["i"][7][0]])
                case["i"][2][0] = case["i"][5][0] = acceleration
                velocity = rng.uniform(-1.0, 1.0) * case["i"][6][0]
                elapsed = rng.uniform(0.1, 2.0)
                case["i"][1][0] = velocity
                case["i"][4][0] = velocity + acceleration * elapsed
                case["i"][3][0] = case["i"][0][0] + velocity * elapsed + acceleration * elapsed * elapsed / 2
                if rng.random() < 0.3:
                    case["i"][3][0] += 0.1
            elif which < 0.8:
                case["i"][7][0] = 0.0
                case["i"][2][0] = case["i"][5][0] = 0.0
                velocity = rng.uniform(-1.0, 1.0) * case["i"][6][0]
                case["i"][1][0] = case["i"][4][0] = velocity
                case["i"][3][0] = case["i"][0][0] + velocity * rng.uniform(0.1, 2.0)
            else:
                case["i"][8][0] = 0.0
        yield finish(rng, case)


def at_rest(rng: random.Random, case: dict[str, Any], coordinates: Iterable[int] | None = None) -> None:
    """Puts coordinates of ``case`` at rest at their target."""
    for index in range(case["n"]) if coordinates is None else coordinates:
        case["i"][3][index] = case["i"][0][index]
        for vector in (1, 2, 4, 5):
            case["i"][vector][index] = 0.0


def aimed_b(rng: random.Random, count: int) -> Iterator[dict[str, Any]]:
    """Cases of one coordinate that random inputs do not give: a coordinate that is where it shall be and has a
    minimum duration to spend there, or a cap of zero."""
    for index in range(count):
        case = general_case(rng, "aimed")
        at_rest(rng, case)
        choice = index % 5
        if choice == 0:
            case["o"] = {"mind": round(rng.uniform(0.1, 3.0), 3)}
        elif choice == 1:
            case["o"] = {"disc": True, "dt": rng.choice(PERIODS), "mind": rng.uniform(0.1, 3.0)}
        elif choice == 2:
            case["i"][8][0] = 0.0
        elif choice == 3:
            case["i"][7][0] = 0.0
            case["o"] = {"mind": rng.uniform(0.1, 3.0)}
        else:
            # nearly there, with a minimum duration
            case["i"][3][0] = case["i"][0][0] + either_sign(rng, log_uniform(rng, 1e-12, 1e-4))
            case["o"] = {"mind": rng.uniform(0.5, 3.0)}
        yield finish(rng, case)


def aimed_c(rng: random.Random, count: int) -> Iterator[dict[str, Any]]:
    """Cases of the velocity interface that random inputs do not give: a velocity that is the target's already,
    with a minimum duration to keep it."""
    for index in range(count):
        case = velocity_case(rng, "aimed")
        case["i"][4][0] = case["i"][1][0]
        case["i"][2][0] = case["i"][5][0] = 0.0
        case["o"]["mind"] = round(rng.uniform(0.1, 3.0), 3)
        if index % 3 == 1:
            case["o"].update(disc=True, dt=rng.choice(PERIODS))
        elif index % 3 == 2:
            case["i"][4][0] = case["i"][1][0] + either_sign(rng, log_uniform(rng, 1e-12, 1e-4))
        yield finish(rng, case)


# ---------------------------------------------------------------------------------------------------------------------
# set c: velocity interface


def velocity_case(rng: random.Random, case_kind: str = "general") -> dict[str, Any]:
    caps = random_caps(rng)
    state = general_state(rng, caps, overshoot=0.25)
    target = [rng.uniform(-5.0, 5.0), rng.uniform(-1.5, 1.5) * caps[0], rng.uniform(-1.0, 1.0) * caps[1]]
    if rng.random() < 0.35:
        target[2] = 0.0
    return one(case_kind, state, target, caps, ci="Velocity")


def set_c(rng: random.Random, count: int, robot: Pear) -> Iterator[dict[str, Any]]:
    stop_acceleration, stop_jerk = robot.braking_caps()
    for _ in range(count):
        choice = rng.random()
        if choice < 0.36:
            # PEAR's controlled stop of a motion under way
            caps, coordinate = robot.coordinate_caps(rng)
            motion = pear_rest_case(rng, robot, caps, coordinate)
            state = state_along(rng, motion)
            current = [vector[0] for vector in state] if state is not None else [motion["i"][0][0], 0.0, 0.0]
            which = rng.random()
            if which < 0.6:
                stop_caps = [caps[0], stop_acceleration[coordinate], stop_jerk[coordinate]]
            elif which < 0.75:
                stop_caps = list(caps)
            else:
                scale = round(rng.uniform(0.05, 0.9), 3)
                stop_caps = [caps[0], caps[1] * scale**2, caps[2] * scale**3]
            case = one("stop", current, [motion["i"][3][0], 0.0, 0.0], stop_caps, ci="Velocity")
        elif choice < 0.46:
            case = velocity_case(rng, "stop_any")
            case["i"][4][0] = case["i"][5][0] = 0.0
        elif choice < 0.74:
            case = velocity_case(rng)
            if rng.random() < 0.3:
                case["o"]["amin"] = [-case["i"][7][0] * log_uniform(rng, 0.1, 3.0)]
            if rng.random() < 0.2:
                rounded_case(case, rng.choice([1, 2]))
        elif choice < 0.9:
            case = velocity_case(rng, "minimum_duration")
            if rng.random() < 0.3:
                case["i"][2][0] = case["i"][5][0] = 0.0
            if not is_valid(case):
                case["i"][5][0] = 0.0
            with_minimum_duration(rng, case)
        elif choice < 0.95:
            case = velocity_case(rng, "discrete")
            case["o"].update(disc=True, dt=rng.choice(PERIODS))
        else:
            case = velocity_case(rng, "zero_limit")
            case["i"][8][0] = 0.0
            if rng.random() < 0.7:
                acceleration = rng.choice([0.0, rng.uniform(-1.0, 1.0) * case["i"][7][0]])
                case["i"][2][0] = case["i"][5][0] = acceleration
                case["i"][4][0] = case["i"][1][0] + acceleration * rng.uniform(0.1, 2.0)
        if not is_valid(case):
            case["i"][5][0] = 0.0
        yield finish(rng, case)


# ---------------------------------------------------------------------------------------------------------------------
# set d: several coordinates


def multi_general(rng: random.Random, dofs: int, case_kind: str) -> dict[str, Any]:
    vectors: list[list[float]] = [[] for _ in VECTORS]
    for _ in range(dofs):
        caps = random_caps(rng)
        state = general_state(rng, caps)
        target = state[0] + distance(rng, 8.0) if rng.random() < 0.5 else rng.uniform(-5.0, 5.0)
        for vector, value in zip(vectors, (*state, target, 0.0, 0.0, *caps)):
            vector.append(value)
    case = many(case_kind, vectors)
    if rng.random() < 0.7:
        with_valid_target(rng, case)

    return case


def pear_move(rng: random.Random, robot: Pear, case_kind: str = "pear_move") -> dict[str, Any]:
    """Returns PEAR's rest-to-rest ``JointMove`` between two poses inside the bounds: phase synchronized, at the
    station's caps or at a share of them, some coordinates unmoved."""
    start, goal = robot.pose(rng), robot.pose(rng)
    for coordinate in range(robot.dofs):
        choice = rng.random()
        if choice < 0.3:
            goal[coordinate] = start[coordinate]
        elif choice < 0.5:
            goal[coordinate] = start[coordinate] + either_sign(rng, log_uniform(rng, 1e-5, 0.2))
    scale = rng.choice([1.0, robot.numbers["home_speed_scale"], round(rng.uniform(0.05, 1.0), 3)])
    zeros = [0.0] * robot.dofs

    return many(case_kind, [start, zeros, zeros, goal, zeros, zeros, *robot.motion_caps(scale)], sync="Phase")


def collinear(rng: random.Random, dofs: int) -> dict[str, Any]:
    """Returns a case whose distance, velocities and accelerations all lie along one direction."""
    direction = [either_sign(rng, log_uniform(rng, 0.05, 2.0)) for _ in range(dofs)]
    for index in range(dofs):
        if rng.random() < 0.15:
            direction[index] = 0.0
    if not any(direction):
        direction[0] = 1.0
    base_caps = random_caps(rng)
    is_proportional = rng.random() < 0.5
    vectors: list[list[float]] = [[] for _ in VECTORS]
    scales = [rng.uniform(0.2, 3.0), rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3)]
    target_scales = [rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3)]
    if rng.random() < 0.4:
        scales[1] = scales[2] = target_scales[0] = target_scales[1] = 0.0
    elif rng.random() < 0.5:
        target_scales = [0.0, 0.0]
    for index in range(dofs):
        size = abs(direction[index]) if is_proportional and direction[index] else 1.0
        caps = [value * size * (1.0 if is_proportional else rng.uniform(0.5, 2.0)) for value in base_caps]
        start = rng.uniform(-3.0, 3.0)
        values = (
            start,
            scales[1] * direction[index] * base_caps[0],
            scales[2] * direction[index] * base_caps[1],
            start + scales[0] * direction[index],
            target_scales[0] * direction[index] * base_caps[0],
            target_scales[1] * direction[index] * base_caps[1],
            *caps,
        )
        for vector, value in zip(vectors, values):
            vector.append(value)
    case = many("phase_collinear", vectors, sync="Phase")
    if not is_valid(case):
        for index in range(dofs):
            case["i"][4][index] = case["i"][5][index] = 0.0

    return case


def set_d(rng: random.Random, count: int, robot: Pear) -> Iterator[dict[str, Any]]:
    stop_acceleration, stop_jerk = robot.braking_caps()
    for _ in range(count):
        dofs = rng.choice([2, 2, 3, 3, 6, 7])
        choice = rng.random()
        sample_count = None

        if choice < 0.16:
            case = multi_general(rng, dofs, "time")
        elif choice < 0.3:
            case = pear_move(rng, robot)
        elif choice < 0.42:
            # PEAR's online trajectory, retargeted in the middle of a motion of all six coordinates
            motion = pear_move(rng, robot)
            if rng.random() < 0.5:
                del motion["o"]
            state = state_along(rng, motion)
            caps = robot.motion_caps(rng.choice([1.0, 1.0, robot.numbers["home_speed_scale"]]))
            zeros = [0.0] * robot.dofs
            if state is None:
                state = (motion["i"][0], zeros, zeros)
            target = [
                motion["i"][3][index] if rng.random() < 0.3 else robot.position(rng, index)
                for index in range(robot.dofs)
            ]
            case = many("pear_retarget", [*state, target, zeros, zeros, *caps])
        elif choice < 0.5:
            # PEAR's controlled stop in the middle of a JointMove
            motion = pear_move(rng, robot)
            state = state_along(rng, motion)
            zeros = [0.0] * robot.dofs
            if state is None:
                state = (motion["i"][0], zeros, zeros)
            caps = [motion["i"][6], stop_acceleration, stop_jerk]
            if rng.random() < 0.25:
                scale = round(rng.uniform(0.1, 0.9), 3)
                caps = [motion["i"][6], *(robot.motion_caps(scale)[1:])]
            case = many("pear_stop", [*state, motion["i"][3], zeros, zeros, *caps], ci="Velocity")
        elif choice < 0.57:
            case = multi_general(rng, dofs, "phase_rest")
            for index in (1, 2, 4, 5):
                case["i"][index] = [0.0] * dofs
            case["o"] = {"sync": "Phase"}
        elif choice < 0.67:
            case = collinear(rng, dofs)
        elif choice < 0.71:
            case = multi_general(rng, dofs, "phase_other")
            case["o"] = {"sync": "Phase"}
        elif choice < 0.76:
            case = multi_general(rng, dofs, "time_if_necessary")
            case["o"] = {"sync": "TimeIfNecessary"}
            for index in range(dofs):
                if rng.random() < 0.5:
                    case["i"][4][index] = case["i"][5][index] = 0.0
        elif choice < 0.8:
            case = multi_general(rng, dofs, "none")
            case["o"] = {"sync": "No"}
        elif choice < 0.84:
            case = multi_general(rng, dofs, "per_dof_synchronization")
            case["o"] = {"psync": [rng.choice(list(SYNCHRONIZATIONS)) for _ in range(dofs)]}
            if rng.random() < 0.5:
                for index in (1, 2, 4, 5):
                    case["i"][index] = [0.0] * dofs
        elif choice < 0.88:
            case = multi_general(rng, dofs, "per_dof_control_interface")
            case["o"] = {"pci": [rng.choice(list(INTERFACES)) for _ in range(dofs)]}
            if rng.random() < 0.3:
                case["o"]["sync"] = rng.choice(["Phase", "No", "TimeIfNecessary"])
        elif choice < 0.91:
            case = multi_general(rng, dofs, "enabled")
            enabled = [rng.random() < 0.6 for _ in range(dofs)]
            case["o"] = {"enabled": enabled}
            if rng.random() < 0.3:
                case["o"]["sync"] = "Phase"
        elif choice < 0.95:
            case = multi_general(rng, dofs, "minimum_duration")
            if rng.random() < 0.4:
                case["o"] = {"amin": [-value * log_uniform(rng, 0.2, 2.0) for value in case["i"][7]]}
                if not is_valid(case):
                    case["i"][4] = [0.0] * dofs
                    case["i"][5] = [0.0] * dofs
            with_minimum_duration(rng, case)
        elif choice < 0.97:
            case = multi_general(rng, dofs, "discrete")
            case["o"] = {"disc": True, "dt": rng.choice(PERIODS)}
        elif choice < 0.985:
            # the same coordinate several times over: every comparison of durations is a tie
            single = general_case(rng, "ties")
            case = many("ties", [vector * dofs for vector in single["i"]])
            if rng.random() < 0.5:
                case["o"] = {"sync": "Phase"}
        else:
            # PEAR's two arms at once
            first, second = pear_move(rng, robot), pear_move(rng, robot)
            vectors = [left + right for left, right in zip(first["i"][:6], second["i"][:6])]
            vectors += [left + left for left in first["i"][6:]]
            case = many("pear_two_arms", vectors, sync="Phase")
            sample_count = 2
        if not is_valid(case):
            case["i"][4] = [0.0] * case["n"]
            case["i"][5] = [0.0] * case["n"]
        yield finish(rng, case, sample_count)


# ---------------------------------------------------------------------------------------------------------------------
# set g: infinite jerk or acceleration caps


def set_g(rng: random.Random, count: int) -> Iterator[dict[str, Any]]:
    for _ in range(count):
        dofs = rng.choice([1, 1, 1, 2, 3])
        case = multi_general(rng, dofs, "second_order")
        choice = rng.random()
        for index in range(dofs):
            case["i"][2][index] = case["i"][5][index] = 0.0
            case["i"][8][index] = math.inf
        if choice < 0.3:
            case["k"] = "first_order"
            for index in range(dofs):
                case["i"][7][index] = math.inf
                case["i"][1][index] = case["i"][4][index] = 0.0
        elif choice < 0.5:
            case["k"] = "second_order_velocity"
            case["o"] = {"ci": "Velocity"}
        elif choice < 0.6 and dofs > 1:
            case["k"] = "mixed_order"
            case["i"][8][0] = log_uniform(rng, 0.5, 100.0)
        if rng.random() < 0.25:
            case.setdefault("o", {})["sync"] = "Phase"
            if rng.random() < 0.5:
                for index in (1, 4):
                    case["i"][index] = [0.0] * dofs
        if rng.random() < 0.2:
            with_minimum_duration(rng, case)
        if not is_valid(case):
            case["i"][4] = [0.0] * dofs
        yield finish(rng, case, 2)


def aimed_g(rng: random.Random, count: int) -> Iterator[dict[str, Any]]:
    """Cases without a jerk cap, or without an acceleration cap either, that random inputs do not give: several
    coordinates from rest to rest along a line (phase synchronized), a coordinate that is where it shall be and has
    a minimum duration to spend there, and a velocity cap of zero."""
    for index in range(count):
        dofs = rng.choice([2, 3, 6])
        case = multi_general(rng, dofs, "aimed")
        for coordinate in range(dofs):
            case["i"][8][coordinate] = math.inf
            for vector in (1, 2, 4, 5):
                case["i"][vector][coordinate] = 0.0
        choice = index % 6
        if choice in (0, 1):
            # the first-order path for every coordinate, or for all but the first, phase synchronized
            for coordinate in range(dofs):
                if choice == 0 or coordinate > 0:
                    case["i"][7][coordinate] = math.inf
            case["o"] = {"sync": "Phase"}
        elif choice == 2:
            case["o"] = {"sync": "Phase", "ci": "Velocity"}
            for coordinate in range(dofs):
                case["i"][4][coordinate] = (coordinate + 1) * 0.25 * case["i"][7][0] * rng.uniform(0.2, 1.0)
        elif choice == 3:
            at_rest(rng, case)
            case["o"] = {"mind": round(rng.uniform(0.1, 3.0), 3)}
            if rng.random() < 0.5:
                case["o"]["ci"] = "Velocity"
        elif choice == 4:
            at_rest(rng, case, [0])
            case["i"][6][0] = 0.0
        else:
            case["i"][6][0] = 0.0
        if not is_valid(case):
            case["i"][4] = [0.0] * dofs
        yield finish(rng, case, 2)


# ---------------------------------------------------------------------------------------------------------------------
# set h: the order of a sort

# Ruckig sorts the candidate durations of a synchronization with std::sort, through their indices. Equal candidates
# are common, std::sort keeps no order among them, and which index comes first decides which coordinate is taken as
# the limiting one: so the order is part of the reference. This program is that sort and nothing else.
SORT_PROGRAM = r"""
#include <algorithm>
#include <cstdio>
#include <vector>

int main() {
    int n;
    while (std::scanf("%d", &n) == 1) {
        std::vector<double> keys(n);
        for (int i = 0; i < n; ++i) {
            if (std::scanf("%lf", &keys[i]) != 1) { return 1; }
        }
        std::vector<size_t> idx(n);
        for (int i = 0; i < n; ++i) { idx[i] = i; }
        std::sort(idx.begin(), idx.end(), [&](size_t i, size_t j) { return keys[i] < keys[j]; });
        for (int i = 0; i < n; ++i) { std::printf(i ? " %zu" : "%zu", idx[i]); }
        std::printf("\n");
    }
    return 0;
}
"""


# std::min and std::max, which Ruckig takes of numbers that may be NaN: each returns its first argument unless the
# comparison says otherwise, so a NaN comes out or not by its place.
MINMAX_PROGRAM = r"""
#include <algorithm>
#include <cstdio>

int main() {
    double a, b;
    while (std::scanf("%lf %lf", &a, &b) == 2) {
        std::printf("%.17g %.17g\n", std::min(a, b), std::max(a, b));
    }
    return 0;
}
"""


def compiled(compiler: str, program: str, lines: Iterable[str]) -> list[str]:
    """Returns the lines the C++ ``program`` writes when it reads ``lines``."""
    with tempfile.TemporaryDirectory() as directory:
        source, binary = Path(directory) / "program.cpp", Path(directory) / "program"
        source.write_text(program, encoding="utf-8")
        subprocess.run([compiler, "-O2", "-std=c++17", "-o", str(binary), str(source)], check=True)
        answer = subprocess.run([str(binary)], input="\n".join(lines) + "\n", capture_output=True, text=True, check=True)

    return answer.stdout.splitlines()


def set_h(rng: random.Random, count: int) -> Iterator[dict[str, Any]]:
    """Sorts arrays of keys with many equal ones, of the lengths Ruckig sorts (three candidates a coordinate and
    one more: 19 for 6 coordinates, 22 for 7, 43 for 14) and others, with the C++ standard library of this
    machine's compiler."""
    compiler = shutil.which("g++")
    if compiler is None:
        raise SystemExit("the set h_sort needs g++ (the compiler the module was built with); leave it out with --only")

    arrays = []
    for index in range(count):
        size = index + 1 if index < 24 else rng.choice([17, 18, 19, 19, 19, 20, 21, 22, 22, 22, 25, 31, 37, 43, 43, 64, 100])
        distinct = rng.choice([1, 2, 3, 5, 8, size])
        keys: list[float] = [float(rng.randrange(distinct)) for _ in range(size)]
        style = rng.random()
        if style < 0.4:
            # as in a synchronization: most candidates are infinite
            keys = [math.inf if rng.random() < 0.6 else key for key in keys]
        elif style < 0.5:
            keys.sort()
        elif style < 0.6:
            keys.sort(reverse=True)
        arrays.append(keys)

    lines = (f"{len(keys)} " + " ".join("inf" if math.isinf(key) else str(int(key)) for key in keys) for keys in arrays)
    orders = compiled(compiler, SORT_PROGRAM, lines)
    assert len(orders) == len(arrays)
    for keys, order in zip(arrays, orders):
        yield {
            "k": "insertion" if len(keys) <= 16 else "partitioned",
            "keys": [key if math.isinf(key) else int(key) for key in keys],
            "order": [int(index) for index in order.split()],
        }

    # the minimum and the maximum of every pair of these, in "order"
    values = [1.0, 2.0, math.nan, 0.0, -0.0, math.inf, -math.inf]
    pairs = [(first, second) for first in values for second in values]
    answers = compiled(compiler, MINMAX_PROGRAM, (f"{first!r} {second!r}" for first, second in pairs))
    assert len(answers) == len(pairs)
    for pair, answer in zip(pairs, answers):
        yield {"k": "minmax", "keys": list(pair), "order": [float(value) for value in answer.split()]}


# ---------------------------------------------------------------------------------------------------------------------
# set e: sessions of update calls


class Fault(Exception):
    """The module failed to calculate a target or a stop of a session that follows PEAR: PEAR's control loop faults
    there, and makes no further update."""

    def __init__(self, session: "Session") -> None:
        super().__init__("the session ends in a fault")
        self.session = session


class Session:
    """One generator, input and output of the module, driven by a script; every step is recorded as an operation a
    test can repeat on the port:

        ["set", name, value]     set an attribute of the input (enumerations by name)
        ["update", rows]         one update a row
        ["advance", rows]        a row: update, then PEAR's ``JointTrajectory.accept`` of the sample (the output's new
                                 position, velocity and acceleration become the input's current ones)
        ["gripper", endpoint, rows]  a row: update, then PEAR's ``GripperProfile.accept`` of the opening it
                                 commands: the endpoint once the update returns Finished, else the new position
        ["pass"]                 output.pass_to_input(input)
        ["calculate", answer]    calculate with the input and a new trajectory: {"r" or "e", "d", "x"}; and "u" where
                                 the module's own trajectory is another one when the input's current state is moved
                                 by one unit in the last place: in how many of six ways of moving it (see
                                 ``changes_with_last_bit``)
        ["reset"]                the generator's reset
        ["time", value]          set the output's time
        ["move", goal, caps, answer]   PEAR's ``JointMove`` from the input's current position: another generator's
                                 calculate, phase synchronized, at rest at both ends
        ["play", rows]           a row: PEAR's ``JointMoveOperation.advance`` then ``accept``: the move's state one
                                 control period on becomes the input's current state; [elapsed, p, v, a, finished]

    A row of an update is [result, time, new_calculation, new_position, new_velocity, new_acceleration], or
    {"e": message} where the update raised ("et": the class of what it raised, unless RuckigError).
    """

    def __init__(self, session_kind: str, dofs: int, period: float | None) -> None:
        self.kind, self.dofs, self.period = session_kind, dofs, period
        self.generator = Ruckig(dofs, period) if period is not None else Ruckig(dofs)
        self.input, self.output = InputParameter(dofs), OutputParameter(dofs)
        self.operations: list[list[Any]] = []
        self.last_result: int | None = None
        self.move: Trajectory | None = None
        self.elapsed = 0.0

    # -- primitive operations

    def set(self, name: str, value: Any) -> None:
        if name == "control_interface":
            setattr(self.input, name, INTERFACES[value])
        elif name == "synchronization":
            setattr(self.input, name, SYNCHRONIZATIONS[value])
        elif name == "duration_discretization":
            setattr(self.input, name, getattr(DurationDiscretization, value))
        else:
            value = list(value) if isinstance(value, (list, tuple)) else value
            setattr(self.input, name, value)
        self.operations.append(["set", name, value])

    def _update(self) -> Any:
        try:
            result = int(self.generator.update(self.input, self.output))
        except RuckigError as error:
            self.last_result = None
            return {"e": str(error)}
        except Exception as error:  # what the binding itself raises for a result it has no name for
            self.last_result = None
            return {"e": str(error), "et": type(error).__name__}
        self.last_result = result
        output = self.output

        return [
            result,
            output.time,
            1 if output.new_calculation else 0,
            list(output.new_position),
            list(output.new_velocity),
            list(output.new_acceleration),
        ]

    def _accept(self) -> None:
        self.input.current_position = list(self.output.new_position)
        self.input.current_velocity = list(self.output.new_velocity)
        self.input.current_acceleration = list(self.output.new_acceleration)

    def update(self, count: int = 1) -> None:
        self.operations.append(["update", [self._update() for _ in range(count)]])

    def advance(self, count: int = 1) -> None:
        rows = []
        for _ in range(count):
            rows.append(self._update())
            self._accept()
        self.operations.append(["advance", rows])

    def advance_until_finished(self, extra: int, most: int = 250) -> None:
        """Advances until an update returns Finished, and ``extra`` periods more."""
        rows = []
        remaining = None
        for _ in range(most):
            rows.append(self._update())
            self._accept()
            if remaining is None and self.last_result == 1:
                remaining = extra
            if remaining is not None:
                if remaining == 0:
                    break
                remaining -= 1
        self.operations.append(["advance", rows])

    def gripper(self, endpoint: float, count: int) -> None:
        rows = []
        for _ in range(count):
            rows.append(self._update())
            position = endpoint if self.last_result == 1 else self.output.new_position[0]
            self.output.pass_to_input(self.input)
            self.input.current_position = [position]
        self.operations.append(["gripper", endpoint, rows])

    def pass_to_input(self) -> None:
        self.output.pass_to_input(self.input)
        self.operations.append(["pass"])

    def moved_input(self, variant: int) -> InputParameter:
        """Returns the input with its current state moved by one unit in the last place: every number up
        (variant 0), down (1), only the positions, the velocities or the accelerations up (2, 3, 4), or up and
        down by turns of the coordinates (5)."""
        moved = InputParameter(self.dofs)
        names = (*VECTORS[3:], "control_interface", "synchronization", "duration_discretization", "minimum_duration")
        for name in (*names, "min_velocity", "min_acceleration", "enabled"):
            setattr(moved, name, getattr(self.input, name))
        for index, name in enumerate(VECTORS[:3]):
            values = list(getattr(self.input, name))
            if variant == 0 or variant - 2 == index:
                values = [math.nextafter(value, math.inf) for value in values]
            elif variant == 1:
                values = [math.nextafter(value, -math.inf) for value in values]
            elif variant == 5:
                values = [math.nextafter(value, math.inf if dof % 2 else -math.inf) for dof, value in enumerate(values)]
            setattr(moved, name, values)

        return moved

    def trajectory_signature(self, ruckig_input: InputParameter) -> tuple[Any, ...]:
        """Returns the duration of the module's trajectory for ``ruckig_input`` and its positions at 17 times across
        it, or what the calculation raised."""
        trajectory = Trajectory(self.dofs)
        generator = Ruckig(self.dofs, self.period) if self.period is not None else Ruckig(self.dofs)
        try:
            generator.calculate(ruckig_input, trajectory)
        except Exception as error:
            return (str(error),)
        duration = trajectory.duration
        return (duration, [trajectory.at_time(duration * index / 16)[0] for index in range(17)])

    def changes_with_last_bit(self) -> int:
        """Returns in how many of six ways of moving the input's current state by one unit in the last place the
        module itself gives another trajectory: another outcome, or a duration or a position that differs by more
        than a billionth (of itself, or of 1 where it is smaller)."""

        def is_other(first: tuple[Any, ...], second: tuple[Any, ...]) -> bool:
            if len(first) == 1 or len(second) == 1:
                return first != second
            if abs(first[0] - second[0]) > 1e-9 * max(1.0, abs(first[0])):
                return True
            return any(
                abs(value - other) > 1e-9 * max(1.0, abs(value))
                for row, other_row in zip(first[1], second[1])
                for value, other in zip(row, other_row)
            )

        reference = self.trajectory_signature(self.input)
        return sum(is_other(reference, self.trajectory_signature(self.moved_input(variant))) for variant in range(6))

    def calculate(self) -> float:
        trajectory = Trajectory(self.dofs)
        answer: dict[str, Any] = {}
        try:
            answer["r"] = int(self.generator.calculate(self.input, trajectory))
            answer["d"] = trajectory.duration
            answer["x"] = [[bound.min, bound.max, bound.t_min, bound.t_max] for bound in trajectory.position_extrema]
            unstable = self.changes_with_last_bit()
            if unstable:
                answer["u"] = unstable
        except RuckigError as error:
            answer["e"] = str(error)
        except Exception as error:
            answer["e"], answer["et"] = str(error), type(error).__name__
        self.operations.append(["calculate", answer])

        return trajectory.duration

    def reset(self) -> None:
        self.generator.reset()
        self.operations.append(["reset"])

    def set_time(self, value: float) -> None:
        self.output.time = value
        self.operations.append(["time", value])

    def build_move(self, goal: list[float], caps: list[list[float]]) -> None:
        ruckig_input = InputParameter(self.dofs)
        ruckig_input.current_position, ruckig_input.target_position = list(self.input.current_position), list(goal)
        ruckig_input.max_velocity, ruckig_input.max_acceleration, ruckig_input.max_jerk = caps
        ruckig_input.synchronization = Synchronization.Phase
        self.move = Trajectory(self.dofs)
        answer: dict[str, Any] = {}
        try:
            answer["r"] = int(Ruckig(self.dofs).calculate(ruckig_input, self.move))
            answer["d"] = self.move.duration
        except RuckigError as error:
            answer["e"] = str(error)
        except Exception as error:
            answer["e"], answer["et"] = str(error), type(error).__name__
        self.elapsed = 0.0
        self.operations.append(["move", list(goal), [list(values) for values in caps], answer])

    def play(self, count: int) -> None:
        assert self.move is not None and self.period is not None
        rows = []
        for _ in range(count):
            self.elapsed = min(self.elapsed + self.period, self.move.duration)
            position, velocity, acceleration = self.move.at_time(self.elapsed)
            self.input.current_position = list(position)
            self.input.current_velocity = list(velocity)
            self.input.current_acceleration = list(acceleration)
            is_finished = self.elapsed >= self.move.duration
            rows.append([self.elapsed, list(position), list(velocity), list(acceleration), 1 if is_finished else 0])
        self.operations.append(["play", rows])

    # -- PEAR's JointTrajectory, operation by operation

    def head_for(self, target: list[float], caps: list[list[float]]) -> None:
        for name, values in zip(("max_velocity", "max_acceleration", "max_jerk"), caps):
            self.set(name, values)
        self.set("control_interface", "Position")
        self.set("target_position", [float(value) for value in target])
        zeros = [0.0] * self.dofs
        self.set("target_velocity", zeros)
        self.set("target_acceleration", zeros)

    def hold(self, position: list[float], caps: list[list[float]]) -> None:
        self.head_for(position, caps)
        self.set("current_position", position)
        zeros = [0.0] * self.dofs
        self.set("current_velocity", zeros)
        self.set("current_acceleration", zeros)

    def set_target(self, target: list[float], caps: list[list[float]]) -> None:
        names = ("target_position", "control_interface", "max_velocity", "max_acceleration", "max_jerk")
        previous = {name: getattr(self.input, name) for name in names}
        self.head_for(target, caps)
        self.calculate()
        if "e" in self.operations[-1][1]:
            # the module rejects the target: PEAR keeps the old input, and the operation that asked faults
            for name, value in previous.items():
                if name == "control_interface":
                    value = next(key for key, interface in INTERFACES.items() if interface == value)
                self.set(name, value)
            raise Fault(self)

    def stop(self, from_standstill: bool, braking_caps: list[list[float]] | None) -> None:
        zeros = [0.0] * self.dofs
        if from_standstill:
            self.set("current_velocity", zeros)
            self.set("current_acceleration", zeros)
        if braking_caps is not None:
            self.set("max_acceleration", braking_caps[0])
            self.set("max_jerk", braking_caps[1])
        self.set("control_interface", "Velocity")
        self.set("target_velocity", zeros)
        self.set("target_acceleration", zeros)
        self.calculate()
        if "e" in self.operations[-1][1]:
            raise Fault(self)

    def record(self) -> dict[str, Any]:
        session: dict[str, Any] = {"k": self.kind, "n": self.dofs, "ops": self.operations}
        if self.period is not None:
            session["dt"] = self.period
        return session


def near_pose(rng: random.Random, robot: Pear, pose: list[float], reach: float) -> list[float]:
    """Returns a pose inside the bounds within ``reach`` of ``pose``, some coordinates unmoved."""
    lower, upper = robot.numbers["lower_bounds"], robot.numbers["upper_bounds"]
    target = []
    for index, value in enumerate(pose):
        if rng.random() < 0.3:
            target.append(value)
        else:
            target.append(min(max(value + rng.uniform(-reach, reach), lower[index]), upper[index]))

    return target


def session_arm(rng: random.Random, robot: Pear) -> dict[str, Any]:
    """PEAR's online trajectory through a hold, targets, a change of target under way, a controlled stop and a
    new target after it. The two updates in the first hold are this script's own (PEAR makes none in a HOLD);
    everything after them is the order of calls of PEAR's control loop."""
    session = Session("pear_arm", robot.dofs, robot.period)
    caps = robot.motion_caps()
    pose = robot.pose(rng)
    session.hold(pose, caps)
    session.update(2)
    target = near_pose(rng, robot, pose, 0.35)
    session.set_target(target, caps)
    session.advance(rng.randrange(4, 14))
    if rng.random() < 0.7:
        target = near_pose(rng, robot, target, 0.3)
        session.set_target(target, caps)
        session.advance(rng.randrange(3, 12))
    if rng.random() < 0.8:
        lowered = None
        if rng.random() < 0.3:
            # braking caps below those of the motion being stopped: the state may lie outside them
            lowered = robot.motion_caps(round(rng.uniform(0.6, 0.9), 2))[1:]
        session.stop(False, robot.braking_caps() if lowered is None else lowered)
        session.advance_until_finished(rng.randrange(1, 4))
        # In the HOLD that follows PEAR makes no update. Its next operation takes the trajectory up as the stop
        # left it: a gripper operation, which only heads for the held targets and is stopped from standstill,
        if rng.random() < 0.35:
            session.head_for(list(session.input.current_position), caps)
            session.stop(True, robot.braking_caps())
            session.advance_until_finished(rng.randrange(1, 3))
        # or the first row of a sequence
        target = near_pose(rng, robot, list(session.input.current_position), 0.25)
        session.set_target(target, caps)
    session.advance_until_finished(rng.randrange(2, 6))

    return session.record()


def session_sequence(rng: random.Random, robot: Pear) -> dict[str, Any]:
    """PEAR's ``SequenceOperation``: a row of targets every few control periods, each taken up under way."""
    session = Session("pear_sequence", robot.dofs, robot.period)
    caps = robot.motion_caps()
    pose = robot.pose(rng)
    session.hold(pose, caps)
    every = rng.choice([1, 2, 3, 5])
    target = pose
    for _ in range(rng.randrange(4, 10)):
        target = near_pose(rng, robot, target, 0.06)
        session.set_target(target, caps)
        session.advance(every)
    session.advance_until_finished(rng.randrange(1, 4))

    return session.record()


def session_move(rng: random.Random, robot: Pear) -> dict[str, Any]:
    """PEAR's ``JointMove`` played at the control rate, then stopped under way or played to its end."""
    session = Session("pear_move", robot.dofs, robot.period)
    caps = robot.motion_caps()
    pose = robot.pose(rng)
    session.hold(pose, caps)
    goal = near_pose(rng, robot, pose, 0.5)
    move_caps = robot.motion_caps(rng.choice([1.0, 1.0, robot.numbers["home_speed_scale"]]))
    session.build_move(goal, move_caps)
    session.head_for(goal, move_caps)
    assert session.move is not None
    periods = max(int(session.move.duration / robot.period), 1)
    if rng.random() < 0.65:
        session.play(rng.randrange(1, max(min(periods, 25), 2)))
        session.stop(False, robot.braking_caps())
        session.advance_until_finished(rng.randrange(1, 4))
    else:
        session.play(min(periods + 3, 60))
        session.head_for(goal, caps)
        session.advance(3)

    return session.record()


def session_gripper(rng: random.Random, robot: Pear) -> dict[str, Any]:
    """PEAR's ``GripperProfile``: one coordinate to an endpoint of its opening, from rest or with a velocity, the
    command clamped to the endpoint once the profile has finished; sometimes the jaw is found elsewhere."""
    session = Session("pear_gripper", 1, robot.period)
    opens = rng.random() < 0.5
    start = round(rng.uniform(0.0, 1.0), 3) if rng.random() < 0.8 else rng.choice([0.0, 1.0])
    endpoint = 1.0 if opens else 0.0
    gripper = robot.gripper
    session.set("current_position", [float(start)])
    session.set("current_velocity", [0.0])
    session.set("current_acceleration", [0.0])
    session.set("target_position", [endpoint])
    session.set("target_velocity", [0.0])
    session.set("target_acceleration", [0.0])
    session.set("max_velocity", [robot.numbers["velocity"][gripper]])
    session.set("max_acceleration", [robot.numbers["acceleration"][gripper]])
    session.set("max_jerk", [robot.numbers["jerk"][gripper]])
    start_velocity = 0.0
    if rng.random() < 0.4:
        start_velocity = rng.uniform(-1.0, 1.0) * robot.numbers["velocity"][gripper]
    session.set("current_velocity", [start_velocity])
    if rng.random() < 0.3:
        session.gripper(endpoint, rng.randrange(3, 15))
        # the jaw is commanded from where it was measured
        session.set("current_position", [round(rng.uniform(0.0, 1.0), 3)])
    session.gripper(endpoint, 400)
    rows = session.operations[-1][2]
    finished = next((index for index, row in enumerate(rows) if isinstance(row, list) and row[0] == 1), len(rows) - 1)
    del rows[finished + rng.randrange(3, 8) :]

    return session.record()


def session_recovery(rng: random.Random, robot: Pear) -> dict[str, Any]:
    """PEAR's release of a hold in a recovery: its own slow caps."""
    session = Session("pear_recovery", robot.dofs, robot.period)
    caps = robot.motion_caps()
    pose = robot.pose(rng)
    session.hold(pose, caps)
    goal = near_pose(rng, robot, pose, 0.02)
    session.head_for(goal, robot.motion_caps(1.0, RELEASE_CAPS))
    session.calculate()
    session.advance_until_finished(rng.randrange(1, 4), most=80)

    return session.record()


def session_generic(rng: random.Random) -> dict[str, Any]:
    """The module's own loop (``pass_to_input`` after every update) with targets that move, caps that change, a
    change of interface, a reset, a refused input, and a loop that feeds nothing back."""
    dofs = rng.choice([1, 2, 3, 3, 7])
    case = multi_general(rng, dofs, "generic")
    # a control period that gives the first trajectory some tens of updates
    trajectory, is_computed = calculate(dict(case))
    duration = trajectory.duration if is_computed and 0 < trajectory.duration < 1e3 else 1.0
    period = float(f"{duration / rng.uniform(15.0, 40.0):.3g}")
    session = Session("generic", dofs, period)
    for name, vector in zip(VECTORS, case["i"]):
        session.set(name, vector)
    if rng.random() < 0.3:
        session.set("synchronization", rng.choice(["Phase", "No", "TimeIfNecessary"]))

    def loop(count: int) -> None:
        for _ in range(count):
            session.update()
            session.pass_to_input()

    loop(rng.randrange(3, 12))
    for _ in range(rng.randrange(1, 4)):
        choice = rng.random()
        if choice < 0.35:
            session.set("target_position", [value + distance(rng, 2.0) for value in case["i"][3]])
            session.set("target_velocity", [0.0] * dofs)
            session.set("target_acceleration", [0.0] * dofs)
        elif choice < 0.5:
            session.set("max_velocity", [value * rng.uniform(0.3, 1.5) for value in case["i"][6]])
        elif choice < 0.62:
            session.set("control_interface", "Velocity")
            session.set("target_velocity", [0.0] * dofs)
            session.set("target_acceleration", [0.0] * dofs)
        elif choice < 0.72:
            session.reset()
        elif choice < 0.8:
            session.set("minimum_duration", round(rng.uniform(0.5, 3.0), 2))
        elif choice < 0.88:
            # a refused input: the update raises and the trajectory under way is kept
            session.set("max_jerk", [-1.0] * dofs)
            session.update(2)
            session.set("max_jerk", case["i"][8])
        elif choice < 0.94:
            session.set_time(round(rng.uniform(0.0, 1.0), 3))
        else:
            # nothing fed back: the input no longer equals the one the generator kept
            session.update(3)
        loop(rng.randrange(3, 10))
    if rng.random() < 0.7:
        for _ in range(120):
            session.update()
            session.pass_to_input()
            if session.last_result == 1:
                break
        loop(rng.randrange(2, 5))

    return session.record()


def set_e(rng: random.Random, count: int, robot: Pear) -> Iterator[dict[str, Any]]:
    makers = [
        lambda: session_arm(rng, robot),
        lambda: session_gripper(rng, robot),
        lambda: session_generic(rng),
        lambda: session_move(rng, robot),
        lambda: session_gripper(rng, robot),
        lambda: session_sequence(rng, robot),
        lambda: session_generic(rng),
        lambda: session_gripper(rng, robot),
        lambda: session_recovery(rng, robot),
        lambda: session_generic(rng),
    ]
    for index in range(count):
        try:
            yield makers[index % len(makers)]()
        except Fault as fault:
            yield fault.session.record()


# ---------------------------------------------------------------------------------------------------------------------
# set f: refused inputs


def refused_base(dofs: int = 1) -> dict[str, Any]:
    vectors = [[0.0] * dofs, [0.0] * dofs, [0.0] * dofs, [1.0] * dofs, [0.0] * dofs, [0.0] * dofs]
    vectors += [[1.0] * dofs, [2.0] * dofs, [10.0] * dofs]
    return {"n": dofs, "i": vectors}


def call(case: dict[str, Any]) -> dict[str, Any]:
    """Makes the call ``case`` names on the module and records what it returns or raises: {"call": name, "args":
    the two flags of a validation, "returns" or "e"}; an update is made with an output of ``case["out"]``
    coordinates, a generator of ``case["gen"]``."""
    name = case["call"]
    arguments = case.get("args", [])
    try:
        ruckig_input = build_input(case)
        generator_dofs = case.get("gen", case["n"])
        options = case.get("o", {})
        generator = Ruckig(generator_dofs, options["dt"]) if "dt" in options else Ruckig(generator_dofs)
        if name == "validate":
            case["returns"] = bool(ruckig_input.validate(*arguments))
        elif name == "validate_input":
            case["returns"] = bool(generator.validate_input(ruckig_input, *arguments))
        elif name == "calculate":
            trajectory = Trajectory(case["n"])
            case["returns"] = int(generator.calculate(ruckig_input, trajectory))
            case["d"] = trajectory.duration
        elif name == "update":
            case["returns"] = int(generator.update(ruckig_input, OutputParameter(case.get("out", case["n"]))))
        elif name == "repr":
            case["returns"] = repr(ruckig_input)
        elif name == "repr_output":
            # an output after one update, without its last line: the time the calculation took
            output = OutputParameter(case["n"])
            generator.update(ruckig_input, output)
            case["returns"] = "\n".join(repr(output).split("\n")[:6])
        else:
            raise AssertionError(name)
    except RuckigError as error:
        case["e"] = str(error)
    except Exception as error:
        case["e"], case["et"] = str(error), type(error).__name__

    return case


def set_f() -> Iterator[dict[str, Any]]:
    nan, inf = math.nan, math.inf

    def variant(label: str, call_name: str = "calculate", dofs: int = 1, **changes: Any) -> dict[str, Any]:
        case = refused_base(dofs)
        case["k"], case["call"] = label, call_name
        options: dict[str, Any] = {}
        for key, value in changes.items():
            if key in VECTORS:
                case["i"][VECTORS.index(key)] = list(value)
            elif key in ("args", "gen", "out"):
                case[key] = value
            else:
                options[key] = value
        if options:
            case["o"] = options
        return call(case)

    # every check of the input's validation, in the order the module makes them
    for value in (nan, -1.0, -inf):
        yield variant("max_jerk", max_jerk=[value])
    for value in (nan, -0.5):
        yield variant("max_acceleration", max_acceleration=[value])
    for value in (nan, 0.5, inf):
        yield variant("min_acceleration", amin=[value])
    yield variant("current_acceleration", current_acceleration=[nan])
    yield variant("target_acceleration", target_acceleration=[nan])
    for name in ("validate", "validate_input"):
        yield variant("current_acceleration_above", name, current_acceleration=[2.5], args=[True, True])
        yield variant("current_acceleration_below", name, current_acceleration=[-2.5], args=[True, True])
        yield variant("current_acceleration_below_min", name, current_acceleration=[-1.5], amin=[-1.0], args=[True])
        yield variant("current_acceleration_unchecked", name, current_acceleration=[2.5], args=[False, True])
    yield variant("target_acceleration_above", target_acceleration=[2.5])
    yield variant("target_acceleration_below", target_acceleration=[-2.5])
    yield variant("target_acceleration_below_min", target_acceleration=[-1.5], amin=[-1.0])
    yield variant("target_acceleration_unchecked", "validate", target_acceleration=[2.5], args=[False, False])
    yield variant("current_velocity", current_velocity=[nan])
    yield variant("target_velocity", target_velocity=[nan])
    yield variant("current_position", current_position=[nan])
    yield variant("target_position", target_position=[nan])
    for value in (nan, -1.0):
        yield variant("max_velocity", max_velocity=[value])
    for value in (nan, 0.25):
        yield variant("min_velocity", vmin=[value])
    yield variant("current_velocity_above", "validate", current_velocity=[1.5], args=[True, True])
    yield variant("current_velocity_below", "validate", current_velocity=[-1.5], args=[True, True])
    yield variant("current_velocity_below_min", "validate", current_velocity=[-0.75], vmin=[-0.5], args=[True, True])
    yield variant("current_velocity_unchecked", "validate", current_velocity=[1.5])
    yield variant("target_velocity_above", target_velocity=[1.5])
    yield variant("target_velocity_below", target_velocity=[-1.5])
    yield variant("target_velocity_below_min", target_velocity=[-0.75], vmin=[-0.5])
    yield variant("target_velocity_unchecked", "validate", target_velocity=[1.5], args=[False, False])
    yield variant("current_inevitable_above", "validate", current_velocity=[0.95], current_acceleration=[1.5], args=[True])
    yield variant("current_inevitable_below", "validate", current_velocity=[-0.95], current_acceleration=[-1.5], args=[True])
    yield variant("target_inevitable_above", target_velocity=[0.95], target_acceleration=[-1.5])
    yield variant("target_inevitable_below", target_velocity=[-0.95], target_acceleration=[1.5])
    yield variant("target_inevitable_zero_jerk", target_velocity=[0.95], target_acceleration=[-1.5], max_jerk=[0.0])
    # the second coordinate is the one refused; decimals of the numbers in a message
    yield variant("second_coordinate", dofs=3, max_jerk=[10.0, -0.0000004, 10.0])
    yield variant("second_coordinate", dofs=3, target_velocity=[0.0, 1.0078125, 0.0])
    yield variant("second_coordinate", dofs=3, target_velocity=[0.0, 123456789.123456789, 0.0])
    yield variant("second_coordinate", dofs=3, target_acceleration=[0.0, 1e22, 0.0])
    yield variant("message_decimals", target_velocity=[1.0000005])
    yield variant("message_decimals", target_velocity=[1.00000049])
    yield variant("message_decimals", target_velocity=[2.5], max_velocity=[0.0078125])
    yield variant("message_decimals", target_velocity=[1e-7], max_velocity=[0.0])
    # the velocity interface ignores positions and velocity caps
    yield variant("velocity_interface", ci="Velocity", current_position=[nan], target_position=[nan])
    yield variant("velocity_interface", ci="Velocity", max_velocity=[-1.0], target_velocity=[5.0])
    yield variant("velocity_interface", ci="Velocity", current_velocity=[nan])
    yield variant("velocity_interface", pci=["Velocity", "Position"], dofs=2, max_velocity=[-1.0, 1.0])
    yield variant("velocity_interface", pci=["Velocity", "Position"], dofs=2, max_velocity=[1.0, -1.0])
    # intermediate positions belong to another edition
    yield variant("intermediate", ip=[[0.5]])
    yield variant("intermediate", ip=[[0.5], [0.7]], mind=2.0)
    yield variant("intermediate", ip=[[0.5]], disc=True, dt=0.01)
    yield variant("intermediate", ip=[[0.5]], pci=["Position"])
    yield variant("intermediate", ip=[[0.5]], psync=["Time"])
    yield variant("intermediate", ip=[[0.5]], max_jerk=[inf])
    yield variant("intermediate", ip=[[0.5]], ci="Velocity")
    yield variant("intermediate", "validate", ip=[[0.5]])
    # a discrete duration needs a control period
    yield variant("delta_time", disc=True)
    yield variant("delta_time", disc=True, dt=0.0)
    yield variant("delta_time", disc=True, dt=-0.5)
    yield variant("delta_time", "validate_input", disc=True)
    yield variant("delta_time", "validate", disc=True)
    # an update checks the sizes
    yield variant("degrees_of_freedom", "update", dofs=2, out=3, dt=0.01)
    yield variant("degrees_of_freedom", "update", dofs=2, gen=3, out=3, dt=0.01)
    yield variant("degrees_of_freedom", "update", dofs=2, dt=0.01)
    # inputs the validation lets through and the calculation refuses
    yield variant("calculation", current_position=[inf])
    yield variant("calculation", target_position=[-inf])
    yield variant("calculation", current_velocity=[inf])
    yield variant("calculation", current_acceleration=[inf])
    yield variant("calculation", dofs=2, current_position=[0.0, inf])
    yield variant("calculation", max_jerk=[0.0], current_velocity=[0.3])
    yield variant("calculation", max_acceleration=[0.0], current_velocity=[0.3])
    yield variant("calculation", max_acceleration=[0.0], amin=[0.0], current_velocity=[0.3])
    yield variant("calculation", amin=[0.0], current_velocity=[0.3], target_position=[-1.0])
    yield variant("calculation", ci="Velocity", max_jerk=[0.0], current_acceleration=[0.5])
    yield variant("calculation", dofs=2, max_jerk=[0.0, 10.0], current_velocity=[0.5, 0.0], target_position=[1.0, 3.0])
    yield variant("calculation", dofs=2, max_jerk=[0.0, 10.0], current_velocity=[0.5, 0.0], target_velocity=[0.5, 0.0])
    yield variant("calculation", dofs=2, max_velocity=[0.0, 1.0])
    yield variant("calculation", max_velocity=[0.0])
    yield variant("calculation", max_velocity=[0.0], target_position=[0.0])
    # a duration past the module's bound
    yield variant("duration", target_position=[1e6])
    yield variant("duration", dofs=2, target_position=[1e6, 1.0])
    yield variant("duration", dofs=2, target_position=[7000.0, 1.0])
    yield variant("duration", dofs=2, target_position=[1.0, 1.0], mind=8000.0)
    yield variant("duration", mind=8000.0)
    yield variant("duration", dofs=2, target_position=[7600.0, 1.0], sync="No")
    yield variant("duration", dofs=2, target_position=[1e13, 1.0])
    yield variant("duration", target_position=[1e13])
    # accepted inputs, as a control
    yield variant("accepted", "validate")
    yield variant("accepted", "validate", args=[True, True])
    yield variant("accepted", "validate_input", args=[True, True])
    yield variant("accepted", "validate_input", dofs=3)
    yield variant("accepted", "calculate")
    yield variant("accepted", "update", dt=0.01)
    yield variant("accepted", "validate", max_velocity=[inf], max_acceleration=[inf], max_jerk=[inf])
    yield variant("accepted", "validate", max_velocity=[0.0], max_acceleration=[0.0], max_jerk=[0.0])
    yield variant("accepted", "validate", amin=[-0.0], vmin=[-0.0])
    # a vector longer than the degrees of freedom: its first elements are used
    yield variant("longer_vector", "calculate", dofs=2, target_position=[1.0, 1.0, 5.0], max_velocity=[1.0, 1.0, -3.0])
    yield variant("longer_vector", "validate", dofs=2, max_jerk=[10.0, 10.0, -1.0], args=[True, True])
    yield variant("longer_vector", "update", dofs=2, dt=0.01, current_position=[0.0, 0.0, 7.0])
    yield variant("longer_vector", "repr", dofs=2, target_position=[1.0, 1.0, 5.0])
    # the text of an input, which the errors of a calculation quote
    yield variant("text", "repr", dofs=2)
    yield variant("text", "repr", dofs=2, ci="Velocity", sync="Phase", disc=True)
    yield variant("text", "repr", sync="No", mind=1.23456789012345, vmin=[-0.5], amin=[-1e-5])
    yield variant("text", "repr", sync="TimeIfNecessary", mind=1e-7)
    yield variant("text", "repr", sync="Time", mind=123456789.0)
    yield variant(
        "text",
        "repr",
        dofs=3,
        current_position=[0.1, 1 / 3, -2 / 3],
        current_velocity=[1e-5, 1e-4, 123456789012345678.0],
        current_acceleration=[1e16, 1e15, 0.1 + 0.2],
        target_position=[nan, inf, -inf],
        target_velocity=[-0.0, 5e-324, 1.7976931348623157e308],
        target_acceleration=[0.30000000000000004, 1.0000000000000002, 9007199254740993.0],
        max_velocity=[2.5, 0.5, 1234567.890123456],
        max_acceleration=[0.000123456789012345678, 100.0, 1e100],
        max_jerk=[0.1, 0.01, 0.001],
    )
    yield variant("text", "repr", ip=[[0.5], [0.25]], current_position=[0.1])
    for minimum in (999999.5, 0.000123456, 100000.0, 1e-5, 1234567.0, 0.1 + 0.2, 2.5, 0.00001234565, 1e300):
        yield variant("text", "repr", mind=minimum)
    yield variant("text", "repr_output", dofs=2, dt=0.25)
    yield variant("text", "repr_output", dt=0.001, current_position=[0.1], current_velocity=[0.3])
    yield variant("text", "repr_output", dofs=3, dt=1 / 3, target_position=[1.0, -2.0, 1e-7])
    # numbers whose sixth decimal is a tie: the C library rounds it to the even digit
    yield variant("message_decimals", target_velocity=[1.0234375])
    yield variant("message_decimals", target_velocity=[2.5], max_velocity=[0.0234375])
    yield variant("message_decimals", target_velocity=[-1.5], vmin=[-0.0390625])
    yield variant("message_decimals", target_velocity=[1.9999995], max_velocity=[1.5])


# ---------------------------------------------------------------------------------------------------------------------
# writing


def jsonable(value: Any) -> Any:
    """Returns ``value`` with every number that is not finite as a string."""
    if isinstance(value, float):
        if math.isnan(value):
            return "nan"
        if math.isinf(value):
            return "inf" if value > 0 else "-inf"
        return value
    if isinstance(value, (list, tuple)):
        return [jsonable(child) for child in value]
    if isinstance(value, dict):
        return {key: jsonable(child) for key, child in value.items()}
    return value


def write(output: Path, name: str, cases: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Writes one set, a case a line, and returns its size and the number of its cases of each kind."""
    kinds: Counter[str] = Counter()
    size = 0
    path = output / f"{name}.json"
    with path.open("w", encoding="utf-8", newline="\n") as file:
        size += file.write('{"set": ' + json.dumps(name) + ',\n"cases": [\n')
        for index, case in enumerate(cases):
            kinds[case["k"]] += 1
            line = json.dumps(jsonable(case), separators=(",", ":"), allow_nan=False)
            size += file.write((",\n" if index else "") + line)
        size += file.write("\n]}\n")
    print(f"{name}: {sum(kinds.values())} cases, {size} bytes")

    return {"cases": sum(kinds.values()), "bytes": size, "kinds": dict(sorted(kinds.items()))}


def extend_libm_table(directory: Path) -> None:
    """Adds to ``libm.json`` of ``directory`` what the C library this module is linked with gives for the arguments
    listed in its ``missing.txt`` (a line a call: the function and the 64 bits of its argument in hexadecimal), and
    removes that list. The functions are those Ruckig takes from the library that are not correctly rounded:
    ``cbrt``, ``sincos``, ``atan``, ``acos``.

    tests/ruckig/exact.test.ts runs the port on that table, and so with the reference's last digits; it writes
    ``missing.txt`` when the port asks for an argument the table does not hold. A value of the table changes later
    arguments, so a table is built in a few rounds of that test and this function. The table of the committed
    fixtures is committed beside them."""
    import base64
    import ctypes
    import struct

    library = ctypes.CDLL("libm.so.6")
    for name in ("cbrt", "atan", "acos"):
        function = getattr(library, name)
        function.restype, function.argtypes = ctypes.c_double, [ctypes.c_double]
    pointer = ctypes.POINTER(ctypes.c_double)
    library.sincos.restype, library.sincos.argtypes = None, [ctypes.c_double, pointer, pointer]

    def number(bits: int) -> float:
        return struct.unpack(">d", struct.pack(">Q", bits))[0]

    def bits_of(value: float) -> int:
        return struct.unpack(">Q", struct.pack(">d", value))[0]

    # per function: the bits of an argument -> the bits of its value (of its sine and cosine for sincos)
    widths = {"cbrt": 2, "atan": 2, "acos": 2, "sincos": 3}
    table: dict[str, dict[int, tuple[int, ...]]] = {name: {} for name in widths}
    path = directory / "libm.json"
    if path.exists():
        stored = json.loads(path.read_text(encoding="utf-8"))
        for name, width in widths.items():
            data = base64.b64decode(stored[name])
            words = struct.unpack(f">{len(data) // 8}Q", data)
            for index in range(0, len(words), width):
                table[name][words[index]] = tuple(words[index + 1 : index + width])

    missing_path = directory / "missing.txt"
    added = 0
    for line in missing_path.read_text(encoding="utf-8").split("\n") if missing_path.exists() else []:
        if not line:
            continue
        name, argument = line.split(" ")
        argument_bits = int(argument, 16)
        if name == "sincos":
            sine, cosine = ctypes.c_double(), ctypes.c_double()
            library.sincos(number(argument_bits), ctypes.byref(sine), ctypes.byref(cosine))
            table[name][argument_bits] = (bits_of(sine.value), bits_of(cosine.value))
        else:
            table[name][argument_bits] = (bits_of(getattr(library, name)(number(argument_bits))),)
        added += 1

    content = {
        "about": "Values of the C library the ruckig module is linked with, for the port's exactness test: per "
        "function, base64 of big-endian doubles: argument, value (sincos: argument, sine, cosine).",
        "library": f"{platform.libc_ver()[0]} {platform.libc_ver()[1]}",
    }
    for name in widths:
        words = [word for argument_bits in sorted(table[name]) for word in (argument_bits, *table[name][argument_bits])]
        content[name] = base64.b64encode(struct.pack(f">{len(words)}Q", *words)).decode("ascii")
    text = "{\n" + ",\n".join(f"{json.dumps(key)}: {json.dumps(value)}" for key, value in content.items()) + "\n}\n"
    path.write_text(text, encoding="utf-8", newline="\n")
    missing_path.unlink(missing_ok=True)
    total = sum(len(entries) for entries in table.values())
    print(f"libm.json: {added} values added, {total} in all, {len(text)} bytes")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--output", type=Path, help="the directory the fixture files are written to")
    parser.add_argument("--scale", type=float, default=1.0, help="multiplies the number of cases of each set")
    parser.add_argument("--only", nargs="*", default=None, help="the sets to write (by default all)")
    parser.add_argument("--libm", type=Path, help="instead of fixtures: extend the table of C library values there")
    arguments = parser.parse_args()
    if arguments.libm is not None:
        extend_libm_table(arguments.libm)
        return
    if arguments.output is None:
        parser.error("--output is required")
    arguments.output.mkdir(parents=True, exist_ok=True)

    robot = Pear()
    counts = {name: max(int(round(count * arguments.scale)), 1) for name, count in BASE_COUNTS.items()}
    aimed = max(int(round(6 * arguments.scale)), 6)  # cases aimed at branches random inputs do not reach, a set
    makers = {
        "a_pear": lambda: set_a(random.Random(1101), counts["a_pear"], robot),
        "b_general": lambda: chain(set_b(random.Random(2202), counts["b_general"]), aimed_b(random.Random(2203), aimed)),
        "c_velocity": lambda: chain(set_c(random.Random(3303), counts["c_velocity"], robot), aimed_c(random.Random(3304), aimed)),
        "d_multi": lambda: set_d(random.Random(4404), counts["d_multi"], robot),
        "e_sessions": lambda: set_e(random.Random(5505), counts["e_sessions"], robot),
        "f_refused": set_f,
        "g_lower": lambda: chain(set_g(random.Random(7707), counts["g_lower"]), aimed_g(random.Random(7708), 2 * aimed)),
        "h_sort": lambda: set_h(random.Random(8808), counts["h_sort"]),
    }
    selected = list(makers) if arguments.only is None else arguments.only
    sets = {name: write(arguments.output, name, makers[name]()) for name in selected}

    meta = {
        "versions": {
            "ruckig": importlib.metadata.version("ruckig"),
            "python": platform.python_version(),
            "machine": platform.machine(),
        },
        "scale": arguments.scale,
        "pear": {**robot.numbers, "control_period_s": robot.period, "release_caps": list(RELEASE_CAPS)},
        "sets": sets,
    }
    if arguments.only is None:
        text = json.dumps(meta, indent=1) + "\n"
        (arguments.output / "meta.json").write_text(text, encoding="utf-8", newline="\n")
        print(f"meta.json: {len(text)} bytes; total {sum(entry['bytes'] for entry in sets.values()) + len(text)} bytes")


if __name__ == "__main__":
    main()
