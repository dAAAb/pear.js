#!/usr/bin/env python
"""Writes session.json, the scripted sessions that pear.js and PEAR's Python both run on a simulated servo chain.

    python tests/sim-bridge/make_session.py        (standard library only; run from anywhere)

A session is a list of steps. Both runners execute the same steps on a freshly reset arm, and what each put on the
wire is compared. Every number a runner needs is in the file as written here, so that the two never compute a
target separately: a JSON number reads back as the same double in Python and in JavaScript.

The steps:

    reset                        the simulated arm as after power-up (a control of the servo chain's test interface)
    mark LABEL                   a label in the recorded traffic (control)
    wait SECONDS                 lets the simulated arm age (control)
    inject FAULTS                sets faults on the servo chain (control)
    open                         start-up checks, the goal verified, torque on, the servos checked
    read, read_for_recovery      the driver's reading of the arm
    send TARGET [VELOCITY]       commands a joint vector; without a velocity it is held
    refresh_hold TARGET          sends the held target again if its feedforward offset changed
    cycle TARGET VELOCITY        one control period: read, then send; paced at the control rate and timed
    burst COUNT TARGET           COUNT cycles of read and send without a pause, timed
    close                        torque off, the bus released
    release                      the runner lets go of whatever is still open (it puts nothing on the wire)

A control step must follow a step whose last packet a servo answers (open, read, close), never directly a send: a
sync write gets no answer, so it may still be on its way when the control call arrives. The file is checked for it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

SESSION_FILE = Path(__file__).with_name("session.json")

CONTROL_PERIOD_S = 0.02  # PEAR's control loop: 50 periods a second (pear/configs/station.yaml)
STATUS_POLL_TICKS = 10  # PEAR's default (so101/config.yaml): Status at every 10th read, Torque_Enable 5 reads later

# Joint vectors: five joints in rad, then the gripper's opening.
REST = [0.0, -1.6828, 1.6605, 0.9523, 0.0, 0.0]  # folded, as the simulated arm is powered up
HOME = [0.0, -0.814, 0.077, 1.423, -1.613, 1.0]  # PEAR's Home of the SO-101 (so101/config.yaml)
SIDE = [0.35, -0.55, 0.45, 1.05, -0.9, 0.3]

# The arm's settings, which both runners must use. The reference runner refuses to run if PEAR's configuration of
# its station says otherwise.
ARM = {
    "joint_offsets": [0.0, 0.0, 0.0, 0.0, 0.0],
    "status_poll_ticks": STATUS_POLL_TICKS,
    "state_timeout_s": 0.1,
    "position_p_coefficient": 16,
    "control_period_s": CONTROL_PERIOD_S,
    # the position bounds an offset never pushes a target past: the simulated arm's calibrated range
    "lower_bounds": [-1.7623, -1.74, -1.6503, -1.65, -2.618, 0.0],
    "upper_bounds": [1.7623, 1.74, 1.6503, 1.65, 2.618, 1.0],
}

OVERLOAD = 0x20  # a bit of the servos' Status register
GRIPPER_LOAD = 0x08 | 0x20  # what a jaw squeezing an object may report
UNKNOWN_BIT = 0x40

# How many status packets the servos have sent when PEAR's start-up reaches the first sync read of its enable:
# six pings with the model number read (12), two firmware reads a servo (12), three calibration reads a servo (18).
REPLIES_BEFORE_ENABLE = 42
REPLIES_BEFORE_FIRMWARE = 12
SERVOS = 6
ENABLE_TRIES = 3  # of one bus access while enabling: PEAR's BUS_RETRIES + 1


def move(start: list[float], end: list[float], ticks: int) -> list[dict[str, Any]]:
    """Returns the cycles of a move from ``start`` to ``end`` in ``ticks`` control periods: a smooth step, at rest
    at both ends, with the velocity the targets move at."""
    steps = []
    for tick in range(1, ticks + 1):
        phase = tick / ticks
        blend = phase * phase * (3 - 2 * phase)
        rate = 6 * phase * (1 - phase) / (ticks * CONTROL_PERIOD_S)
        steps.append(
            {
                "op": "cycle",
                "target": [a + (b - a) * blend for a, b in zip(start, end)],
                "velocity": [(b - a) * rate for a, b in zip(start, end)],
            }
        )

    return steps


def reads(count: int) -> list[dict[str, Any]]:
    return [{"op": "read"} for _ in range(count)]


def nominal() -> list[dict[str, Any]]:
    """The session that matters: start-up, readings, two moves at the control rate, faults while running, close."""
    steps: list[dict[str, Any]] = [
        {"op": "reset"},
        {"op": "mark", "label": "start-up"},
        {"op": "open"},
        {"op": "mark", "label": "readings at rest"},
        {"op": "wait", "seconds": 0.5},
        *reads(12),
        {"op": "mark", "label": "move to Home"},
        *move(REST, HOME, 150),
        {"op": "send", "target": HOME},  # held: no velocity
        {"op": "refresh_hold", "target": HOME},
        {"op": "read"},
        {"op": "mark", "label": "readings at Home"},
        {"op": "wait", "seconds": 1.5},
        *reads(12),
        {"op": "mark", "label": "move aside"},
        *move(HOME, SIDE, 100),
        {"op": "send", "target": SIDE},
        {"op": "read"},
        {"op": "mark", "label": "readings aside"},
        {"op": "wait", "seconds": 1.5},
        *reads(12),
        {"op": "mark", "label": "burst"},
        {"op": "burst", "count": 200, "target": SIDE},
        {"op": "read"},
        # a servo reports an error: the next poll of the Status stops the arm
        {"op": "mark", "label": "a servo reports an error"},
        {"op": "inject", "faults": {"status": {"elbow_flex": OVERLOAD}}},
        *reads(STATUS_POLL_TICKS),
        {"op": "read_for_recovery"},
        {"op": "inject", "faults": {"clear": True, "status": {"shoulder_pan": UNKNOWN_BIT}}},
        {"op": "read_for_recovery"},
        {"op": "inject", "faults": {"clear": True}},
        {"op": "read_for_recovery"},
        # a servo lost its torque: the next poll of Torque_Enable stops the arm
        {"op": "mark", "label": "a servo lost its torque"},
        {"op": "inject", "faults": {"registers": {"wrist_roll": {"Torque_Enable": 0}}}},
        *reads(STATUS_POLL_TICKS),
        {"op": "read_for_recovery"},
        {"op": "inject", "faults": {"registers": {"wrist_roll": {"Torque_Enable": 1}}}},
        {"op": "read_for_recovery"},
        # the jaw's load bits are no fault
        {"op": "mark", "label": "the jaw reports load"},
        {"op": "inject", "faults": {"status": {"gripper": GRIPPER_LOAD}}},
        *reads(STATUS_POLL_TICKS),
        {"op": "read_for_recovery"},
        {"op": "inject", "faults": {"clear": True}},
        # answers are lost after the first command: one retry saves a read, two lost keep the last reading
        {"op": "mark", "label": "answers are lost while running"},
        {"op": "inject", "faults": {"lose_reads": 1}},
        {"op": "read"},
        {"op": "inject", "faults": {"lose_reads": 2}},
        {"op": "read"},
        {"op": "read"},
        {"op": "mark", "label": "close"},
        {"op": "close"},
        {"op": "release"},
    ]

    return steps


def refused_start(label: str, faults: dict[str, Any]) -> list[dict[str, Any]]:
    """A session whose start-up meets ``faults``; if the arm opens all the same it is read and closed."""
    return [
        {"op": "reset"},
        {"op": "inject", "faults": faults},
        {"op": "mark", "label": label},
        {"op": "open"},
        {"op": "read"},
        {"op": "read"},
        {"op": "close"},
        {"op": "release"},
    ]


def sessions() -> list[dict[str, Any]]:
    silent_while_running = [
        {"op": "reset"},
        {"op": "mark", "label": "start-up"},
        {"op": "open"},
        {"op": "read"},
        {"op": "mark", "label": "the line is silent before the first command"},
        {"op": "inject", "faults": {"silent": True}},
        {"op": "read"},
        {"op": "inject", "faults": {"clear": True}},
        {"op": "read"},
        {"op": "mark", "label": "close"},
        {"op": "close"},
        {"op": "release"},
    ]
    error_at_close = [
        {"op": "reset"},
        {"op": "mark", "label": "start-up"},
        {"op": "open"},
        {"op": "read"},
        {"op": "mark", "label": "a servo reports an error when the arm is closed"},
        {"op": "inject", "faults": {"status": {"elbow_flex": OVERLOAD}}},
        {"op": "close"},
        {"op": "inject", "faults": {"clear": True}},
        {"op": "release"},
    ]

    return [
        {"name": "nominal", "steps": nominal()},
        {
            "name": "a servo is missing at start-up",
            "steps": refused_start("start-up without a servo", {"absent": ["elbow_flex"]}),
        },
        {
            "name": "the line is silent at start-up",
            "steps": refused_start("start-up on a silent line", {"silent": True}),
        },
        {
            "name": "an answer is lost during the handshake",
            "steps": refused_start(
                "start-up with a lost firmware answer", {"lose_replies": {"skip": REPLIES_BEFORE_FIRMWARE, "count": 1}}
            ),
        },
        {
            "name": "one answer is lost while enabling",
            "steps": refused_start(
                "start-up with one lost answer", {"lose_replies": {"skip": REPLIES_BEFORE_ENABLE, "count": 1}}
            ),
        },
        {
            "name": "a whole enable attempt is lost",
            "steps": refused_start(
                "start-up with a lost enable attempt",
                {"lose_replies": {"skip": REPLIES_BEFORE_ENABLE, "count": SERVOS * ENABLE_TRIES}},
            ),
        },
        {
            "name": "a servo reports an error at start-up",
            "steps": refused_start("start-up with a servo's error", {"status": {"elbow_flex": OVERLOAD}}),
        },
        {
            "name": "the servos' calibration differs from the file",
            "steps": refused_start(
                "start-up with another calibration", {"registers": {"shoulder_lift": {"Max_Position_Limit": 3185}}}
            ),
        },
        {"name": "the line is silent while running", "steps": silent_while_running},
        {"name": "a servo reports an error when the arm is closed", "steps": error_at_close},
    ]


CONTROL_OPS = {"reset", "mark", "wait", "inject"}
ANSWERED_OPS = {"open", "read", "read_for_recovery", "close"}  # their last packet is answered, or nothing answers at all
UNANSWERED_OPS = {"send", "refresh_hold", "cycle", "burst"}  # they may end with a sync write


def check(all_sessions: list[dict[str, Any]]) -> None:
    """Raises if a control step follows a step that may end with a sync write."""
    for session in all_sessions:
        previous = "reset"
        for index, step in enumerate(session["steps"]):
            op = step["op"]
            if op not in CONTROL_OPS | ANSWERED_OPS | UNANSWERED_OPS | {"release"}:
                raise ValueError(f"{session['name']}: step {index} has the unknown op {op!r}")
            if op in CONTROL_OPS and previous in UNANSWERED_OPS:
                raise ValueError(f"{session['name']}: step {index} ({op}) follows {previous}, which nothing answers")
            if op not in CONTROL_OPS and op != "release":
                previous = op


def named(all_sessions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Returns the sessions, each with a mark of its name right after its reset: a recording of the wire then says
    itself where a session starts."""
    for session in all_sessions:
        steps = session["steps"]
        if steps[0]["op"] != "reset":
            raise ValueError(f"{session['name']}: a session starts with a reset")
        steps.insert(1, {"op": "mark", "label": f"session: {session['name']}"})

    return all_sessions


def main() -> None:
    all_sessions = named(sessions())
    check(all_sessions)
    document = {
        "format": "pear.js-sim-bridge-session/1",
        "about": "Scripted sessions for the parity check of src/so101/hardware; written by make_session.py.",
        "arm": ARM,
        "sessions": all_sessions,
    }
    SESSION_FILE.write_text(json.dumps(document, indent=1) + "\n")
    step_count = sum(len(session["steps"]) for session in all_sessions)
    print(f"{SESSION_FILE.name}: {len(all_sessions)} sessions, {step_count} steps")


if __name__ == "__main__":
    main()
