#!/usr/bin/env python
"""Writes station_session.json, the scripted station sessions of ladder step 4: what a task does to a robot, as a
list of the robot's calls, which PEAR's Python robot and pear.js's both run on a simulated SO-101 servo chain.

    python tests/sim-bridge/make_station_session.py        (standard library only; run from anywhere)

The reference runner (outside this repository) runs the file with PEAR's own SO101Robot and writes a
StationRunResult (station_result.ts); compare_station.ts compares two of them. docs/progress/station-reference.md
describes the reference, the result and the stepping rule a runner must reproduce.

A session is a list of steps on a freshly reset arm. A step is ONE call of the robot, under PEAR's name for it, or
one thing the test does to the servo chain or to the operation's cancellation. The order of the calls is the order
PEAR's own callers make them in: its turn loop (pear/deploy/station/agent_loop/agent_loop.py: StationAgentLoop,
ModelCall) and its console (pear/deploy/station/gui/console/: commands.py, task_run.py, console.py, watchdog.py).
Every number a runner needs is in the file as written here: a JSON number reads back as the same double in Python
and in JavaScript.

The steps (a runner keeps, between steps: the robot, the last observation, the report of the last result, the
operation's cancellation, the last status read and the error the last step raised):

    reset                          the simulated arm as after power-up; the clock back at its first reading
    open                           a robot is made from the station's settings and opened (BaseRobot.open)
    close                          BaseRobot.close
    wait_stationary [observation]  robot.wait_stationary(the last observation or none, cancellation)
    observe                        robot.observe(): becomes the last observation
    model_state                    robot.model_state(the last observation's joints, the format), and the text of
                                   the turn it makes with the report of the last result (ObservationMessage.build)
    hold TICKS                     what ModelCall does while the model works: TICKS times {raise OperatorPaused
                                   if the cancellation is set; robot.is_holding(the last observation); wait one
                                   control period}, then the two checks once more
    parse ANSWER                   ActionParser.parse(ANSWER): for an answer that is no action; it raises
    execute ANSWER | ACTION        robot.execute(the action, reference_observation = the last observation,
                                   cancellation); its result is recorded (MotionResult.to_record) with its report
                                   (the format's result_feedback, dispatched), which becomes the last result's.
                                   A model's turn gives "answer", the model's final answer, which a runner reads
                                   with ActionParser.parse ("action" then repeats what its json block holds, for a
                                   reader). An "action" with a "type" and no answer is an action of the robot
                                   outside the model's format, given to the robot as it is
    failure_result ERROR           robot.failure_result(ERROR, format, [status], [snapshot = the last status
                                   read]); recorded like a result, [dispatched or not]. ERROR is {type, message}
                                   or {from: "last_error"}: the error of the last step that raised one
    status [with_snapshot]         robot.status(): becomes the last status read
    check_fault                    robot.check_fault()
    stop                           robot.stop()
    pause                          the console's pause: the cancellation is set, then robot.stop()
    new_cancellation               a new cancellation, as the console makes one for every operation it launches
    wait_settled TIMEOUT_S         robot.wait_settled(TIMEOUT_S)
    recover                        robot.recover(cancellation)
    home REVIEW_TICKS [approve]    robot.home(cancellation, report_progress, approve_plan): the plan is reviewed
                                   for REVIEW_TICKS control periods and then approved (or not)
    idle TICKS                     TICKS control periods pass while nothing is asked of the robot
    inject FAULTS                  sets faults on the servo chain (a control of its test interface)
    place OBJECT POSITION_M        puts an object of the simulated scene somewhere, at rest (control)

A step may carry "at_tick": things that happen after the step's Nth control period, where another thread of a
station would act: {"tick": N, "do": "pause"} (the console's pause), {"tick": N, "do": "inject", "faults": ...}.

"turn" numbers the model turn a step belongs to and "about" says what it is for; a runner copies both.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

SESSION_FILE = Path(__file__).with_name("station_session.json")
SESSION_FORMAT = "pear.js-sim-bridge-station-session/1"

# The station's settings, which both runners must use: PEAR's defaults (pear/configs/station.yaml and the SO-101's
# config.yaml at the pinned commit) with the simulated arm's calibrated range and its measured gripper widths. The
# reference runner refuses to run if PEAR's own configuration of its station says otherwise.
STATION = {
    "control": {
        "rate_hz": 50,
        "state_timeout_s": 0.1,
        "deadline_tolerance_s": 0.05,
        "settle_timeout_s": 3,
        "settle_window_s": 0.5,
        "action_timeout_s": 0.5,
    },
    "robot": {
        "hardware": {
            "joint_offsets": [0.0, 0.0, 0.0, 0.0, 0.0],
            "status_poll_ticks": 10,
            "position_p_coefficient": 16,
        },
        "geometry": {
            "max_rotation_rad": 3.141592653589793,
            "position_residual_m": 0.001,
            "rotation_residual_rad": 0.01,
            "ik_iterations": 200,
            "gripper_width_cm": [0.4, 13.3],
        },
        "limits": {
            "velocity": [1.0, 1.0, 1.0, 1.0, 1.0, 0.5],
            "acceleration": [2.0, 2.0, 2.0, 2.0, 2.0, 2.0],
            "jerk": [10.0, 10.0, 10.0, 10.0, 10.0, 10.0],
            "lower_bounds": [-1.7623, -1.74, -1.6503, -1.65, -2.618, 0.0],
            "upper_bounds": [1.7623, 1.74, 1.6503, 1.65, 2.618, 1.0],
            "tracking_error": [0.25, 0.25, 0.25, 0.25, 0.25, 1.0],
            "stop_acceleration": [6.0, 6.0, 6.0, 6.0, 6.0, 6.0],
            "stop_jerk": [60.0, 60.0, 60.0, 60.0, 60.0, 60.0],
        },
        "home": {
            "speed_scale": 0.3333333333333333,
            "limits": None,
            "settle_window_s": 0.5,
            "arrival_timeout_s": 20,
            "position": [0.0, -0.814, 0.077, 1.423, -1.613, 1.0],
            "joint_tolerance": [0.035, 0.06, 0.06, 0.06, 0.035],
        },
        "feedforward": {
            "gravity_compliance": [0.0, 0.0, 0.0, 0.0, 0.0],
            "friction_offset_rad": [0.0, 0.0, 0.0, 0.0, 0.0],
            "friction_load_ratio": [0.0, 0.0, 0.0, 0.0, 0.0],
        },
        "position_tolerance": 0.06,
        "gripper_tolerance": 0.02,
        "feedback_position_tolerance": 0.06,
        "velocity_tolerance": 0.06,
    },
    "action_format": "single_arm_pose",
}

THINK_TICKS = 10  # control periods a model's answer takes in most turns: 0.2 s, far less than a real model's
REVIEW_TICKS = 25  # control periods the operator looks at a Home plan before approving it
SETTLE_TIMEOUT_S = 10.0  # PEAR's console waits this long for a stopped motion to settle (Console.SETTLE_TIMEOUT_S)
OVERLOAD = 0x20  # a bit of the servos' Status register
HOME = [0.0, -0.814, 0.077, 1.423, -1.613, 1.0]  # the Home pose, for the joint actions of the last session

# PEAR's own words, which its turn loop and its console give the robot (exceptions.py, task_run.py)
PAUSED = {"type": "OperatorPaused", "message": "Operation interrupted by the operator"}
INTERRUPTED = {
    "type": "OperatorPaused",
    "message": "The operator interrupted this turn; remaining motion was cancelled.",
}

OPS = {
    "reset", "open", "close", "wait_stationary", "observe", "model_state", "hold", "parse", "execute",
    "failure_result", "status", "check_fault", "stop", "pause", "new_cancellation", "wait_settled", "recover",
    "home", "idle", "inject", "place",
}  # fmt: skip
NEEDS_OBSERVATION = {"model_state", "hold", "execute"}


def delta(
    x: float = 0.0, y: float = 0.0, z: float = 0.0, pitch: float = 0.0, roll: float = 0.0, width: float = 0.0
) -> dict[str, Any]:
    """Returns an action of the SO-101's format: an increment of the fingertip's x, y, z in cm and of its pitch and
    roll in rad, and the gripper's command (positive opens, negative closes, zero holds)."""
    return {"arm": {"x": x, "y": y, "z": z, "pitch": pitch, "roll": roll}, "gripper": {"width": width}}


def answer(action: dict[str, Any], words: str = "") -> str:
    """Returns a model's final answer that ends with ``action`` as its fenced json block."""
    return words + "```json\n" + json.dumps(action) + "\n```"


class Session:
    """One session being written: its steps, under the names of who makes each call in PEAR."""

    def __init__(self, name: str, about: str, *, objects: bool = False) -> None:
        self.name, self.about, self.objects = name, about, objects
        self.steps: list[dict[str, Any]] = []
        self.turn_number = 0
        self.add("reset")

    def add(self, op: str, **fields: Any) -> None:
        step: dict[str, Any] = {"id": f"{len(self.steps):03d}", "op": op}
        step.update({key: value for key, value in fields.items() if value is not None})
        self.steps.append(step)

    def document(self) -> dict[str, Any]:
        session: dict[str, Any] = {"name": self.name, "about": self.about}
        if self.objects:
            session["objects"] = True  # a result of this session also says where the scene's objects are
        session["steps"] = self.steps
        return session

    # ---- the console's commands (gui/console/commands.py) ----

    def enable(self) -> None:
        """The enable command: the robot is opened and waited for until it holds still."""
        self.add("open", about="enable: the robot opens, which enables the servos")
        self.add("wait_stationary", about="enable: wait until the arm holds still")

    def home(self, *, review_ticks: int = REVIEW_TICKS, approve: bool | None = None, about: str | None = None) -> None:
        """The home command: refused unless the robot is ready; the plan is reviewed, then run."""
        self.add("status", about="home: the robot must be READY")
        self.add("new_cancellation")
        self.add("home", review_ticks=review_ticks, approve=approve, about=about)

    def start(self) -> None:
        """The start and the resume command: refused unless the robot is ready; a new operation."""
        self.add("status", about="start or resume: the robot must be READY")
        self.add("new_cancellation")

    def disable(self) -> None:
        self.add("close", about="disable: the robot closes, which releases the servos")

    # ---- the turn loop (agent_loop/agent_loop.py) and the task's run (gui/console/task_run.py) ----

    def look(self, about: str | None = None, *, is_turn: bool = True) -> None:
        """The start of a turn: the arm at rest, observed, and what the model reads of it. Without a turn (the look
        that closes a session) it only shows what the next turn would have read."""
        turn = None
        if is_turn:
            self.turn_number += 1
            turn = self.turn_number
        self.add("wait_stationary", turn=turn, about=about)
        self.add("observe", turn=turn)
        self.add("model_state", turn=turn)

    def last_look(self) -> None:
        self.look("what the model would read next", is_turn=False)

    def think(self, ticks: int = THINK_TICKS, *, at_tick: list[dict[str, Any]] | None = None) -> None:
        """The model works: the arm must hold the observed pose, settled, until the answer is there."""
        self.add("wait_stationary", observation=True, turn=self.turn_number)
        self.add("hold", ticks=ticks, at_tick=at_tick, turn=self.turn_number)

    def turn(
        self,
        action: dict[str, Any],
        about: str,
        *,
        think: int = THINK_TICKS,
        words: str = "",
        at_tick: list[dict[str, Any]] | None = None,
    ) -> None:
        """One whole turn: observe, the model's answer, the action executed."""
        self.look(about)
        self.think(think)
        self.add("execute", action=action, answer=answer(action, words), at_tick=at_tick, turn=self.turn_number)

    def run_ends(self) -> None:
        """What the console does when a task's run ends on an action that did not complete: its worker stops the
        robot and reads its status with the snapshot (to save a fault), then its status alone."""
        self.add("stop", about="the console's worker stops the robot after a run that failed")
        self.add("status", with_snapshot=True)
        self.add("status")

    def resume_after_failure(self) -> None:
        """The resume command after an action that did not complete: the task's run first waits for the stopped
        motion to settle."""
        self.start()
        self.add("wait_settled", timeout_s=SETTLE_TIMEOUT_S, about="resume: the run waits for the arm to settle")

    def interrupted(self, *, dispatched: bool) -> None:
        """What follows the operator's pause of a turn whose model request was made: the turn loop stops the robot
        and records the pause; the task's run waits for the arm to settle and records the interruption, which is
        what the next turn tells the model. ``dispatched``: whether the turn's action had gone to the robot."""
        self.add("stop", about="the turn loop stops the robot at the operator's pause")
        self.add("failure_result", error=PAUSED, dispatched=dispatched, turn=self.turn_number)
        self.add("status", with_snapshot=True, about="the task's run looks for a fault to reconcile")
        self.add("status")
        self.add("wait_settled", timeout_s=SETTLE_TIMEOUT_S)
        self.add("failure_result", error=INTERRUPTED, dispatched=dispatched, turn=self.turn_number)


def sample() -> Session:
    """The shortest session that moves the arm: the one whose reference result is kept beside the tests."""
    session = Session(
        "a short session from the rest pose",
        "Enable, look, one small move up from the folded pose the arm is powered up in, look, disable.",
    )
    session.enable()
    session.start()
    session.turn(delta(z=2.0), "2 cm up from the rest pose")
    session.last_look()
    session.disable()
    return session


def task() -> Session:
    """The long session: Home, then the turns of a task, Home again."""
    session = Session(
        "a task",
        "Enable, Home, then turns as a task makes them: each axis alone in both directions, small and large; "
        "rotations; combined increments; a zero increment; the gripper on nothing; an arm move with the gripper; "
        "two increments the arm cannot reach (the run retries with a fresh observation); ten ordinary turns; one "
        "long wait for the model; Home from away with a closed gripper; disable.",
    )
    session.enable()
    session.home(about="Home from the folded rest pose: the gripper opens, then the arm returns")
    session.start()

    session.turn(delta(x=1.0), "first turn: 1 cm forward", words="The arm is at Home. I move 1 cm forward.\n\n")
    session.turn(delta(x=-1.0), "1 cm back")
    session.turn(delta(y=1.0), "1 cm left")
    session.turn(delta(y=-1.0), "1 cm right")
    session.turn(delta(z=-1.0), "1 cm down")
    session.turn(delta(z=1.0), "1 cm up")
    session.turn(delta(pitch=0.05), "a small pitch down")
    session.turn(delta(pitch=-0.05), "a small pitch up")
    session.turn(delta(roll=0.05), "a small roll")
    session.turn(delta(roll=-0.05), "a small roll back")

    session.turn(delta(x=10.0), "10 cm forward")
    session.turn(delta(x=-10.0), "10 cm back")
    session.turn(delta(y=20.0), "20 cm left: near the reach to that side")
    session.turn(delta(y=-40.0), "40 cm right, across the whole table")
    session.turn(delta(y=20.0), "20 cm left, back to the middle")
    session.turn(delta(z=-15.0), "15 cm down")
    session.turn(delta(z=15.0), "15 cm up")
    session.turn(delta(roll=3.0), "a roll of 3 rad: near the format's bound of pi")
    session.turn(delta(roll=-3.0), "and back")
    session.turn(delta(pitch=-0.7), "the fingertip nearly horizontal: near what the arm reaches")
    session.turn(delta(pitch=0.7), "and back")

    session.turn(delta(x=3.0, y=-4.0, z=-5.0), "three axes at once")
    session.turn(delta(x=-3.0, y=4.0, z=5.0, pitch=-0.3, roll=0.4), "every quantity of the arm at once")
    session.turn(delta(pitch=0.3, roll=-0.4), "both rotations back")
    session.turn(delta(), "a zero increment: nothing to do")
    session.turn(delta(width=-1.0), "the gripper closes on nothing")
    session.turn(delta(width=1.0), "the gripper opens")
    session.turn(delta(z=-3.0, width=-1.0), "an arm move, then the gripper closes")
    session.turn(delta(z=3.0, width=1.0), "an arm move, then the gripper opens")

    session.turn(delta(x=40.0), "40 cm forward: out of reach; nothing moves and the report says how far")
    session.turn(delta(roll=-1.5), "a roll past the wrist's joint limit: out of reach in the same way")

    # ten ordinary turns: an approach to something on the table to the right, from above
    session.turn(delta(y=-5.0), "ordinary turn 1 of 10")
    session.turn(delta(y=-5.0), "ordinary turn 2")
    session.turn(delta(x=-2.0, y=-3.0), "ordinary turn 3")
    session.turn(delta(z=-6.0), "ordinary turn 4")
    session.turn(delta(z=-5.0, pitch=0.2), "ordinary turn 5")
    session.turn(delta(x=1.0, z=-3.0), "ordinary turn 6")
    session.turn(delta(roll=0.3), "ordinary turn 7")
    session.turn(delta(y=1.5), "ordinary turn 8")
    session.turn(delta(z=-1.0), "ordinary turn 9")
    session.turn(delta(width=-1.0), "ordinary turn 10: the gripper closes")

    session.turn(delta(z=2.0), "a model that takes 3 s to answer", think=150)
    session.last_look()
    session.home(about="Home from away, the gripper closed: it opens first")
    session.look("the arm at Home", is_turn=False)
    session.disable()
    return session


def refused() -> Session:
    """Actions and answers that the station refuses, and what the console does about each."""
    session = Session(
        "what the station refuses",
        "Increments out of reach in each kind of quantity (retried by the run); a rotation above the planning "
        "bound (the run ends and is resumed); two answers that are no action; a Home the operator does not approve.",
    )
    session.enable()
    session.home()
    session.start()
    # PEAR's run asks again, with a fresh observation, after an increment out of reach: five times in a row
    session.turn(delta(x=40.0), "out of reach along x (retry 1 of 5)")
    session.turn(delta(y=40.0), "out of reach along y (retry 2)")
    session.turn(delta(z=15.0), "out of reach along z (retry 3)")
    session.turn(delta(pitch=1.5), "out of reach in pitch (retry 4)")
    session.turn(delta(roll=-1.5), "out of reach in roll: past the wrist's joint limit (retry 5)")
    session.turn(delta(x=40.0, width=-1.0), "out of reach a sixth time, with a gripper command: the run ends")
    session.run_ends()
    session.resume_after_failure()
    session.turn(delta(x=1.0), "the turn after it: the model reads that nothing moved")

    session.turn(delta(roll=3.5), "a roll above the planning bound of pi: refused as a ValueError; the run ends")
    session.run_ends()
    session.resume_after_failure()
    session.turn(delta(x=-1.0), "the turn after it: the model reads why")

    for text, about in (
        ("I will move the arm forward by one centimeter.", "an answer without a json block"),
        (answer({"arm": {"x": 1.0, "y": 0.0, "z": 0.0}, "gripper": {"width": 0.0}}), "an answer that lacks quantities"),
    ):
        session.look(about)
        session.think()
        session.add("parse", answer=text, turn=session.turn_number)
        session.add("stop", about="the turn loop stops the robot when a turn fails")
        session.add(
            "failure_result",
            error={"from": "last_error"},
            status="rejected",
            dispatched=False,
            turn=session.turn_number,
            about="recorded as rejected and never dispatched",
        )
        session.run_ends()
        session.resume_after_failure()
        session.turn(delta(y=1.0), "the turn after it")

    session.last_look()
    session.home(approve=False, about="a Home whose plan the operator does not approve: nothing moves")
    session.run_ends()
    session.disable()
    return session


def grasp() -> Session:
    """The jaw stopped by an object: the arm reaches down, a hand puts a cube between the fingers, the jaw closes
    on it, the arm lifts it and lets it go."""
    session = Session(
        "the jaw stops on an object",
        "The arm reaches down to the table in three turns; a 2 cm cube is put between the fingers; the gripper "
        "closes and stops on it; the arm lifts the cube and opens the gripper; Home; disable.",
        objects=True,
    )
    session.enable()
    session.home()
    session.start()
    session.turn(delta(z=-12.0), "12 cm down")
    session.turn(delta(z=-6.0, pitch=0.4), "6 cm down, the fingers tilting down")
    session.turn(delta(z=-1.5, pitch=0.4), "the fingertip 1.4 cm above the table, the fingers pointing down")
    # the middle between the two fingers is then at x 22.50, y -1.21 cm; the cube's centre rests 1.05 cm high
    session.add(
        "place",
        object="small_cube",
        position_m=[0.2250, -0.0121, 0.0105],
        about="a hand puts the 2 cm cube on the table between the fingers",
    )
    session.add("idle", ticks=25)
    session.turn(delta(width=-1.0), "the gripper closes: the jaw stops on the cube")
    session.turn(delta(z=6.0), "6 cm up, with the cube")
    session.add("idle", ticks=50)
    session.turn(delta(width=1.0), "the gripper opens: the cube falls")
    session.add("idle", ticks=50)
    session.last_look()
    session.home(about="Home: the gripper is open, the arm returns")
    session.disable()
    return session


def paused() -> Session:
    """The operator's pause: in the middle of a move, while the model works, in the middle of a gripper operation."""
    session = Session(
        "the operator pauses",
        "A stop requested 20 control periods into a move, and the turn that follows it; a pause while the model "
        "works; a pause 30 control periods into a closing of the gripper; each resumed.",
    )
    session.enable()
    session.home()
    session.start()

    session.turn(delta(y=12.0), "a move that is paused after 20 control periods", at_tick=[{"tick": 20, "do": "pause"}])
    session.interrupted(dispatched=True)
    session.start()
    session.turn(delta(y=12.0), "the turn after the pause: the same increment again, from where the arm stopped")

    session.look("a turn that is paused while the model works")
    session.think(at_tick=[{"tick": 4, "do": "pause"}])
    session.add("stop", about="the model call stops the robot when it ends without an answer")
    session.interrupted(dispatched=False)
    session.start()
    session.turn(delta(y=-12.0), "the turn after it")

    session.turn(delta(width=-1.0), "a closing of the gripper that is paused", at_tick=[{"tick": 30, "do": "pause"}])
    session.interrupted(dispatched=True)
    session.start()
    session.turn(delta(width=1.0), "the turn after it: the gripper opens")
    session.last_look()
    session.disable()
    return session


def fault(name: str, about: str, faults: dict[str, Any], repair: dict[str, Any], repair_about: str) -> Session:
    """A fault of a servo 20 control periods into a move, a recovery that is refused while the fault lasts, the
    fault removed, the recovery, and a move after it."""
    session = Session(name, about)
    session.enable()
    session.home()
    session.start()
    session.turn(
        delta(y=12.0),
        "a move during which the fault appears",
        at_tick=[{"tick": 20, "do": "inject", "faults": faults}],
    )
    session.run_ends()
    session.add("check_fault", about="the fault as the robot raises it")
    session.add("pause", about="the console's watchdog pauses the task for the fault")
    session.add("idle", ticks=50, about="the operator reads the fault")
    session.add("status", about="recover_control: the robot must be in FAULT")
    session.add("new_cancellation")
    session.add("recover", about="a recovery while the servo still reports the fault: refused")
    session.add("stop", about="the console's worker stops the robot after an operation that failed")
    session.add("status")
    session.add("inject", faults=repair, about=repair_about)
    session.add("idle", ticks=10)
    session.add("status", about="recover_control again")
    session.add("new_cancellation")
    session.add("recover", about="the recovery: the measured pose becomes the hold")
    session.add("status", about="the robot must be READY after it")
    session.resume_after_failure()
    session.turn(delta(y=5.0), "the turn after the recovery: the model reads of the fault")
    session.last_look()
    session.disable()
    return session


def other_actions() -> Session:
    """The robot's actions that are not of the model's format: the gripper's own action and a chunk of joint
    targets, which PEAR's commands and maintenance use."""
    session = Session(
        "actions outside the model's format",
        "The gripper action (close, open); a chunk of ten joint targets at 10 Hz; a chunk that leaves the joint "
        "limits, which is refused.",
    )
    session.enable()
    session.home()
    session.start()
    session.look(is_turn=False)
    session.add("execute", action={"type": "gripper", "command": "close"}, about="the gripper action: close")
    session.look(is_turn=False)
    session.add("execute", action={"type": "gripper", "command": "open"}, about="the gripper action: open")
    session.look(is_turn=False)
    rows = [[0.02 * row, *HOME[1:]] for row in range(1, 11)]
    session.add(
        "execute",
        action={"type": "joint_positions", "positions": rows, "rate_hz": 10.0},
        about="ten joint targets, the base turning 0.02 rad each, streamed at 10 Hz",
    )
    session.look(is_turn=False)
    session.add(
        "execute",
        action={"type": "joint_positions", "positions": [[2.0, *HOME[1:]]], "rate_hz": 10.0},
        about="a joint target past the base's limit: refused before anything is sent",
    )
    session.last_look()
    session.disable()
    return session


def sessions() -> list[Session]:
    return [
        sample(),
        task(),
        refused(),
        grasp(),
        paused(),
        fault(
            "a servo reports overload during a move",
            "The elbow's Status register reports overload 20 control periods into a move; the station faults at its "
            "next poll of the Status; a recovery is refused while the bit is set; the bit is cleared; the recovery; "
            "a move.",
            {"status": {"elbow_flex": OVERLOAD}},
            {"clear": True},
            "the servo's fault is gone",
        ),
        fault(
            "a servo loses its torque during a move",
            "The wrist's roll servo loses its torque 20 control periods into a move; the station faults at its next "
            "poll of the torque; a recovery is refused while the servo is limp; its torque is restored; the "
            "recovery; a move.",
            {"registers": {"wrist_roll": {"Torque_Enable": 0}}},
            {"registers": {"wrist_roll": {"Torque_Enable": 1}}},
            "the servo holds torque again",
        ),
        other_actions(),
    ]


def check(all_sessions: list[Session]) -> None:
    """Raises unless every session is one a runner can run: known steps, a reset first, a robot opened before it is
    used and closed at the end, an observation before what refers to one."""
    names = [session.name for session in all_sessions]
    if len(set(names)) != len(names):
        raise ValueError("Two sessions have one name")

    for session in all_sessions:
        steps = session.steps
        where = f"{session.name}: step"
        if steps[0]["op"] != "reset" or any(step["op"] == "reset" for step in steps[1:]):
            raise ValueError(f"{session.name}: a session starts with its one reset")
        if steps[-1]["op"] != "close":
            raise ValueError(f"{session.name}: a session ends by closing its robot")
        is_open = has_observation = False
        for index, step in enumerate(steps):
            op = step["op"]
            if step["id"] != f"{index:03d}":
                raise ValueError(f"{where} {index} has the id {step['id']}")
            if op not in OPS:
                raise ValueError(f"{where} {step['id']} has the unknown op {op!r}")
            if op == "open":
                if is_open:
                    raise ValueError(f"{where} {step['id']} opens a robot that is open")
                is_open, has_observation = True, False
            elif op == "close":
                is_open = False
            elif op not in ("reset", "inject", "place", "new_cancellation", "parse") and not is_open:
                raise ValueError(f"{where} {step['id']} ({op}) has no open robot")
            if op == "observe":
                has_observation = True
            if (op in NEEDS_OBSERVATION or step.get("observation")) and not has_observation:
                raise ValueError(f"{where} {step['id']} ({op}) refers to an observation that was never made")
            if op == "execute" and ("answer" in step) == ("type" in step["action"]):
                raise ValueError(f"{where} {step['id']} gives a model's answer or an action with its type, one of them")
            for event in step.get("at_tick", []):
                if event["do"] not in ("pause", "inject") or event["tick"] < 1:
                    raise ValueError(f"{where} {step['id']} has an event that no runner knows")


def main() -> None:
    all_sessions = sessions()
    check(all_sessions)
    document = {
        "format": SESSION_FORMAT,
        "about": "Scripted station sessions for ladder step 4 (the station on a simulated SO-101); written by "
        "make_station_session.py.",
        "station": STATION,
        "sessions": [session.document() for session in all_sessions],
    }
    SESSION_FILE.write_text(json.dumps(document, indent=1) + "\n")
    step_count = sum(len(session.steps) for session in all_sessions)
    turn_count = sum(session.turn_number for session in all_sessions)
    print(f"{SESSION_FILE.name}: {len(all_sessions)} sessions, {step_count} steps, {turn_count} turns")


if __name__ == "__main__":
    main()
