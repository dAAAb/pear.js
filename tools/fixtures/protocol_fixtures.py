"""Writes the fixtures of pear.js's protocol module: what PEAR's own code gives for the texts a model reads and for
the answers it writes, in the SO-101's single_arm_pose format.

Run it with the Python of a PEAR station environment (PEAR at the commit src/index.ts pins), from any directory:

    <work dir>/envs/station/bin/python tools/fixtures/protocol_fixtures.py [--sync-prompts]

It writes tests/fixtures/protocol/*.json and nothing else. With --sync-prompts it first copies PEAR's two prompt
files to assets/pear/prompts/ and writes src/protocol/prompts.ts from them; without it, it stops when those copies
differ from the files of the PEAR it runs in. Everything is deterministic: fixed seeds, no clock, no path.

For a longer comparison that is not committed, write a larger set elsewhere and point the tests at it:

    <work dir>/envs/station/bin/python tools/fixtures/protocol_fixtures.py --scale 40 --output <directory>
    PEAR_JS_PROTOCOL_FIXTURES=<directory> npx vitest run tests/protocol
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import struct
import sys
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
import pydantic

import pear
from pear.agent_loop.protocol import JsonBlockProtocol
from pear.deploy.station.agent_loop.action_parser import ActionParser
from pear.deploy.station.agent_loop.messages import ObservationMessage, SystemPrompt
from pear.deploy.station.control.joint.operations import GripperEndpointTimeout
from pear.deploy.station.control.motion.kinematics import UnreachablePoseError
from pear.deploy.station.control.motion.results import MotionStatus
from pear.deploy.station.control.robots.so101.formats import SINGLE_ARM_POSE_FORMAT, SingleArmPoseFormat
from pear.deploy.station.control.robots.so101.joint.grippers import GripperOutcome
from pear.deploy.station.control.robots.so101.motion.actions import ModelState
from pear.deploy.station.control.robots.so101.motion.kinematics import SO101Kinematics
from pear.deploy.station.control.robots.so101.motion.results import SO101MotionResult
from pear.deploy.station.exceptions import OperatorPaused

REPOSITORY = Path(__file__).resolve().parents[2]
FIXTURES = REPOSITORY / "tests" / "fixtures" / "protocol"
ASSETS = REPOSITORY / "assets" / "pear" / "prompts"
PROMPTS_MODULE = REPOSITORY / "src" / "protocol" / "prompts.ts"
PEAR_PACKAGE = Path(pear.__file__).resolve().parent
# each copy under assets/pear/prompts: its name, PEAR's path under pear/ and the constant that embeds it
PROMPT_FILES = (
    ("system_prompt.md", "deploy/station/agent_loop/system_prompt.md", "SYSTEM_PROMPT_TEMPLATE"),
    (
        "single_arm_pose.md",
        "deploy/station/control/robots/so101/prompts/single_arm_pose.md",
        "SINGLE_ARM_POSE_ENVIRONMENT",
    ),
)

FORMAT = SINGLE_ARM_POSE_FORMAT
ARM = SO101Kinematics.ARM_QUANTITIES
SEED = 20261115
# the arm at rest and on target, as a robot's status carries it: what a turn that never reached the arm is measured at
HOLDING = {"status": "READY", "arrival": {"settled": True, "reached": True}}


class Prompts:
    """PEAR's prompt files, their copies in this repository and the module that embeds them."""

    @staticmethod
    def pear_bytes(pear_path: str) -> bytes:
        return (PEAR_PACKAGE / pear_path).read_bytes()

    @classmethod
    def sync(cls) -> None:
        """Copies PEAR's prompt files, unchanged, and writes the module that embeds them."""
        ASSETS.mkdir(parents=True, exist_ok=True)
        lines = [
            "// Embeds PEAR's prompt files, so that a bundle for a browser carries them:",
            *(f"//   {constant}: pear/{pear_path}" for _, pear_path, constant in PROMPT_FILES),
            "// Written by tools/fixtures/protocol_fixtures.py --sync-prompts from the unchanged copies under",
            "// assets/pear/prompts; tests/protocol/prompts.test.ts compares the two byte for byte. Do not edit by hand.",
        ]
        for name, pear_path, constant in PROMPT_FILES:
            data = cls.pear_bytes(pear_path)
            (ASSETS / name).write_bytes(data)
            text_lines = data.decode("utf-8").split("\n")
            lines += ["", f"export const {constant} = ["]
            lines += [f"  {json.dumps(line, ensure_ascii=False)}," for line in text_lines]
            lines += ['].join("\\n");']
        PROMPTS_MODULE.parent.mkdir(parents=True, exist_ok=True)
        PROMPTS_MODULE.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")

    @classmethod
    def check(cls) -> dict[str, Any]:
        """Returns what the fixtures record of each prompt file; stops unless this repository's copy is PEAR's."""
        record = {}
        for name, pear_path, _ in PROMPT_FILES:
            data = cls.pear_bytes(pear_path)
            copy = ASSETS / name
            if not copy.is_file() or copy.read_bytes() != data:
                sys.exit(f"assets/pear/prompts/{name} is not PEAR's pear/{pear_path}: run with --sync-prompts")
            record[name] = {"pear_path": f"pear/{pear_path}", "sha256": hashlib.sha256(data).hexdigest()}

        return record


class Commit:
    """The commit of the PEAR this runs in, read from its checkout without running git."""

    @staticmethod
    def of_pear() -> str | None:
        git = PEAR_PACKAGE.parent / ".git"
        head = git / "HEAD"
        if not head.is_file():
            return None
        text = head.read_text().strip()
        if not text.startswith("ref: "):
            return text
        reference = text.removeprefix("ref: ")
        if (git / reference).is_file():
            return (git / reference).read_text().strip()
        packed = git / "packed-refs"
        if packed.is_file():
            for line in packed.read_text().splitlines():
                if line.endswith(" " + reference):
                    return line.split()[0]
        return None

    @staticmethod
    def pinned() -> str:
        return re.search(r'PEAR_COMMIT = "([0-9a-f]{40})"', (REPOSITORY / "src" / "index.ts").read_text()).group(1)


class Turns:
    """The text of a turn, from PEAR's ObservationMessage.build."""

    OBSERVATION = {
        "images": {FORMAT.cameras[0].role: np.zeros((4, 8, 3), dtype=np.uint8)},
        "camera_timestamps": {FORMAT.cameras[0].role: {"received_monotonic_s": 0.0}},
        "captured_monotonic_s": 1.0,
    }

    def __init__(self, directory: Path) -> None:
        self.directory = directory  # where PEAR saves the turn's frame, which the fixtures do not keep

    def text(self, state: dict[str, dict[str, float]], feedback: str | None) -> str:
        message = ObservationMessage.build(
            self.OBSERVATION, ModelState.model_validate(state), FORMAT, self.directory, "turn", feedback, ()
        )

        return message.text


class Numbers:
    """Floats whose rounding or repr differs between Python and a naive port."""

    HAND_PICKED = (
        [0.0, -0.0, 5.0, -5.0, 22.7, -1.66, 0.69, 39.1, 22.6, -0.05, 6.0, 1.0, -1.0, 0.1, 0.2, 0.3]
        # exact ties, which Python rounds to even and toFixed away from zero
        + [0.25, 0.75, 1.25, 2.25, -0.25, -0.75, 0.125, 0.375, 0.625, 0.875, -0.125, 1.125, 0.5, 1.5, 2.5, -0.5, -2.5]
        + [0.0625, 0.1875, 10.25, 100.75, 12345.125, 0.03125, 4503599627370496.5, 2251799813685248.25]
        # decimal ties that no float holds exactly
        + [0.05, 0.15, 0.35, 0.45, 0.55, 1.005, 2.675, 0.285, 1.45, 8.345, 8.575, 1.115, 0.005, 0.015, 0.045, -0.045]
        # negative values that round to zero, and values that round up to an integer
        + [-0.04, -0.004, -0.049, -0.05, -0.0049, -1e-9, -0.00499999, 22.96, 9.95, 9.96, 99.95, 0.995, 0.996, 0.999]
        + [1.9999, 5.04, 5.05, 5.06, 999.95, 999.949, -9.95, -0.995]
        # where repr changes to an exponent, and the ends of the range
        + [1e15, 9999999999999998.0, 1e16, 1.5e16, 2e16 + 8, 1e17, 1e20, 1e21, 1e22, 1.5e300, 1.7976931348623157e308]
        + [123456789012345.67, 123456789.98765433, 9007199254740992.0, 9007199254740994.0, 2.5e15 + 0.5]
        + [0.001, 0.0001, 0.00012, 0.00001, 1.5e-5, 1e-7, 1e-320, 5e-324, 2.2250738585072014e-308, -1e-5, -1e22]
    )

    @classmethod
    def samples(cls, generator: random.Random, count: int) -> list[float]:
        values = [float(value) for value in cls.HAND_PICKED]
        values += [generator.uniform(-50, 50) for _ in range(80)]
        values += [round(generator.uniform(-50, 50), 3) for _ in range(40)]  # three decimals: often near a tie
        values += [generator.randrange(-400, 400) / 8 for _ in range(30)]
        values += [generator.randrange(-4000, 4000) / 16 for _ in range(20)]
        values += [generator.uniform(-3.2, 3.2) for _ in range(30)]
        while len(values) < count:  # any finite float
            value = struct.unpack("<d", struct.pack("<Q", generator.getrandbits(64)))[0]
            if value == value and abs(value) != float("inf"):
                values.append(value)

        return values

    @staticmethod
    def case(value: float) -> list[Any]:
        return [value, repr(value), [repr(round(value, digits) + 0.0) for digits in range(4)]]


class Parsing:
    """Answers and what PEAR's ActionParser makes of each, with what the model is told of one it refuses."""

    VALID = '{"arm": {"x": 0, "y": 0, "z": 0, "pitch": 0, "roll": 0}, "gripper": {"width": 0}}'

    @staticmethod
    def fenced(body: str) -> str:
        return "```json\n" + body + "\n```"

    @staticmethod
    def action_text(**tokens: str) -> str:
        """Returns the JSON text of an action whose quantities are the given literal tokens, 0 unless given."""
        values = {name: "0" for name in (*ARM, "width")} | tokens
        arm = ", ".join(f'"{name}": {values[name]}' for name in ARM)

        return '{"arm": {' + arm + '}, "gripper": {"width": ' + values["width"] + "}}"

    @staticmethod
    def generated(specification: dict[str, Any]) -> str:
        """Returns the answer of a specification too long to store; tests/protocol builds the same text."""
        kind, count = specification["kind"], specification["count"]
        if kind == "nested_objects":
            return "```json\n" + '{"a":' * count + "1" + "}" * count + "\n```"
        if kind == "nested_arrays":
            return '```json\n{"a":' + "[" * count + "]" * count + "}\n```"
        if kind == "arrays_then_object":
            return '```json\n{"a":' + "[" * count + "{}" + "]" * count + "}\n```"
        if kind == "digits":
            return Parsing.fenced(Parsing.action_text(x="9" * count))
        raise ValueError(kind)

    @staticmethod
    def case(
        label: str, answer: str, specification: dict[str, Any] | None = None, *, with_feedback: bool = True
    ) -> dict[str, Any]:
        """Returns what PEAR makes of ``answer``: its action, or its error with what the model is told of it (left
        out of the many generated cases, where it only repeats the error)."""
        case: dict[str, Any] = {"label": label}
        if specification is None:
            case["answer"] = answer
        else:
            case["generated"] = specification

        try:
            action = ActionParser.parse(answer, FORMAT)
        except Exception as error:
            # as StationAgentLoop.step records a turn whose answer gave no action: a ValueError rejects it, any
            # other error fails it, and the robot's result carries the error's class and message
            status = MotionStatus.REJECTED if isinstance(error, ValueError) else MotionStatus.FAILED
            result = SO101MotionResult.from_snapshot(HOLDING, status=status, error=error, kinematics=None)
            case["error"] = {**result.error, "status": status.value}
            if with_feedback:
                case["feedback"] = SingleArmPoseFormat.result_feedback(result, is_dispatched=False)
        else:
            case["action"] = action.model_dump(mode="json")

        return case

    @classmethod
    def first_refused(cls, kind: str) -> int:
        """Returns the least count at which Python's recursion limit refuses the generated answer of ``kind``."""
        low, high = 1, 40000
        while high - low > 1:
            middle = (low + high) // 2
            try:
                ActionParser.parse(cls.generated({"kind": kind, "count": middle}), FORMAT)
            except RecursionError:
                high = middle
            except ValueError:
                low = middle

        return high

    @classmethod
    def hand_written(cls) -> list[dict[str, Any]]:
        fenced, action_text, valid = cls.fenced, cls.action_text, cls.VALID
        shuffled = '{"gripper": {"width": -1}, "arm": {"roll": 0.1, "z": -2, "pitch": 0, "y": 1.5, "x": 3}}'
        pretty = json.dumps(json.loads(valid), indent=2)
        answers = {
            # answers that give an action
            "block alone": fenced(valid),
            "reasoning before the block": "The cup is to the left.\n\nI move left.\n\n" + fenced(action_text(y="2.5")),
            "floats": fenced(action_text(x="1.5", y="-0.25", z="0.1", pitch="-0.05", roll="3.14", width="1.0")),
            "exponents": fenced(action_text(x="1e1", y="1E-2", z="2.5e+0", pitch="-1e-1", roll="0.1e1", width="-1E0")),
            "negative zeros": fenced(action_text(x="-0", y="-0.0", z="-0e0", width="-0")),
            "parts and quantities in another order": fenced(shuffled),
            "pretty printed": fenced(pretty),
            "tabs and carriage returns": "```json\r\n" + pretty.replace("\n", "\r\n").replace("  ", "\t") + "\r\n```",
            "no line breaks around the block": "```json" + valid + "```",
            "whitespace after the block": fenced(valid) + " \n\t\r\n ",
            "unicode whitespace around the object": "```json 　" + valid + " \u0085``` \x1c\x0b\x0c",
            "two blocks": fenced(action_text(x="1")) + "\nNo, further:\n" + fenced(action_text(x="2")),
            "an earlier block that is no json": "```json\n{not json}\n```\n" + fenced(action_text(z="1")),
            "a block of another language first": "```python\nprint(1)\n```\n" + fenced(valid),
            "escaped names": fenced(valid.replace('"arm"', '"\\u0061rm"').replace('"x"', '"\\u0078"')),
            "closing think tag alone": "plan</think>\n" + fenced(valid),
            "think tag in capitals": "<THINK>plan</THINK>\n" + fenced(valid),
            "large and small numbers": fenced(action_text(x="1e308", y="-1e-400", z="4.9e-324", pitch="2.5e-324")),
            "integers past 2**53": fenced(action_text(x="9007199254740993", y="-9007199254740993", z="1" + "0" * 30)),
            "the largest integer a float holds": fenced(action_text(x=str(2**1024 - 2**970 - 1))),
            "long fractions": fenced(action_text(x="0.1000000000000000055511151231257827", y="1.00000000000000011102")),
            # answers that do not end with a block
            "empty": "",
            "whitespace alone": " \n",
            "no block": "I will move the arm.",
            "text after the block": fenced(valid) + "\nDone.",
            "a backtick after the block": "````json\n" + valid + "\n````",
            "block left open": "```json\n" + valid,
            "block cut short": fenced(valid)[:-4],
            "language in capitals": "```JSON\n" + valid + "\n```",
            "no language": "```\n" + valid + "\n```",
            "another language": "```json5\n" + valid + "\n```",
            "space before the language": "``` json\n" + valid + "\n```",
            "tildes": "~~~json\n" + valid + "\n~~~",
            "an array in the block": fenced("[" + valid + "]"),
            "an empty block": "```json\n```",
            "text between the object and the fence": "```json\n" + valid + " done\n```",
            "byte order mark before the object": "```json\n﻿" + valid + "\n```",
            "zero width space after the block": fenced(valid) + "​",
            "bare object": valid,
            # answers that hold a thinking block
            "thinking block": "<think>plan</think>\n" + fenced(valid),
            "think tag after the block": fenced(valid) + "\n<think>",
            "think tag inside the block": fenced(valid.replace('"x"', '"<think>"')),
            "think tag and no block": "<think>",
            # blocks that are no JSON
            "trailing comma in an object": fenced(valid[:-1] + ",}"),
            "trailing comma in a part": fenced(valid.replace('"roll": 0}', '"roll": 0,}')),
            "single quotes": fenced(valid.replace('"', "'")),
            "unquoted names": fenced(valid.replace('"arm"', "arm")),
            "missing colon": fenced(valid.replace('"x":', '"x"')),
            "missing comma": fenced(valid.replace('0, "y"', '0 "y"')),
            "missing value": fenced(action_text(x="")),
            "equals sign": fenced(valid.replace('"x":', '"x" =')),
            "comment": fenced('{"arm": // the arm\n' + valid[8:]),
            "leading zero": fenced(action_text(x="01")),
            "plus sign": fenced(action_text(x="+1")),
            "no integer digits": fenced(action_text(x=".5")),
            "no fraction digits": fenced(action_text(x="1.")),
            "no exponent digits": fenced(action_text(x="1e")),
            "exponent sign alone": fenced(action_text(x="1e+")),
            "minus alone": fenced(action_text(x="-")),
            "minus then space": fenced(action_text(x="- 1")),
            "hexadecimal": fenced(action_text(x="0x10")),
            "underscore": fenced(action_text(x="1_000")),
            "fraction of a constant": fenced(action_text(x="tru")),
            "python constants": fenced(action_text(x="True")),
            "python none": fenced(action_text(x="None")),
            "lowercase nan": fenced(action_text(x="nan")),
            "cut infinity": fenced(action_text(x="Infinit")),
            "cut negative infinity": fenced(action_text(x="-Infinit")),
            "tab in a name": fenced(valid.replace('"x"', '"x\t"')),
            "line break in a name": fenced(valid.replace('"x"', '"x\n"')),
            "unknown escape": fenced(valid.replace('"x"', '"\\x"')),
            "short unicode escape": fenced(valid.replace('"x"', '"\\u12"')),
            "unicode escape that is no number": fenced(valid.replace('"x"', '"\\uZZZZ"')),
            "second escape of a pair that is no number": fenced(valid.replace('"x"', '"\\ud83d\\uZZZZ"')),
            "unterminated string": fenced('{"arm": "x}'),
            "string that ends in a backslash": fenced('{"arm": "x\\}'),
            "string that ends in an escaped backslash": fenced('{"arm": "x\\\\}'),
            "unicode escape at the end": fenced('{"arm": "\\u00e9}'),
            "short unicode escape at the end": fenced('{"arm": "\\u00e}'),
            "pair cut short at the end": fenced('{"arm": "\\ud83d\\ude0}'),
            "two objects": fenced("{} {}"),
            "extra closing brace": fenced(valid + "}"),
            "missing closing brace": fenced(valid[:-1]),
            "unclosed array": fenced('{"arm": [1, 2}'),
            "trailing comma in an array": fenced('{"arm": [1, 2,]}'),
            "form feed between tokens": fenced(valid.replace(", ", ",\x0c")),
            "no-break space between tokens": fenced(valid.replace(", ", ", ")),
            "error on a later line": fenced(pretty.replace('"pitch": 0,', '"pitch": 0')),
            "error after wide characters": fenced('{"備註": "\U0001f600\U0001f600", "arm" 1}'),
            "error after a line of wide characters": fenced('{"備註": "\U0001f600",\n "arm" 1}'),
            # JSON that is no action
            "missing part": fenced('{"gripper": {"width": 0}}'),
            "extra part": fenced(valid[:-1] + ', "request_id": "old"}'),
            "the action's type given": fenced('{"type": "single_arm_delta", ' + valid[1:]),
            "part in capitals": fenced(valid.replace('"arm"', '"Arm"')),
            "empty object": fenced("{}"),
            "nested twice": fenced('{"action": ' + valid + "}"),
            "arm that is a number": fenced('{"arm": 0, "gripper": {"width": 0}}'),
            "arm that is a list": fenced('{"arm": [0, 0, 0, 0, 0], "gripper": {"width": 0}}'),
            "arm that is null": fenced('{"arm": null, "gripper": {"width": 0}}'),
            "arm that is text": fenced('{"arm": "x", "gripper": {"width": 0}}'),
            "gripper that is a number": fenced(valid.replace('{"width": 0}', "0")),
            "missing quantity": fenced(valid.replace(', "roll": 0', "")),
            "extra quantity": fenced(valid.replace('"roll": 0', '"roll": 0, "yaw": 0')),
            "another quantity": fenced(valid.replace('"roll"', '"yaw"')),
            "gripper without its width": fenced(valid.replace('{"width": 0}', "{}")),
            "gripper with another quantity": fenced(valid.replace('"width"', '"opening"')),
            "text for a number": fenced(action_text(z='"up"')),
            "a number in quotes": fenced(action_text(z='"1"')),
            "true for a number": fenced(action_text(x="true")),
            "false for a number": fenced(action_text(width="false")),
            "null for a number": fenced(action_text(x="null")),
            "a list for a number": fenced(action_text(x="[0]")),
            "an object for a number": fenced(action_text(x='{"value": 0}')),
            "NaN": fenced(action_text(x="NaN")),
            "Infinity": fenced(action_text(y="Infinity")),
            "negative Infinity": fenced(action_text(width="-Infinity")),
            "a float past the largest": fenced(action_text(x="1e400")),
            "a negative float past the largest": fenced(action_text(x="-1.8e308")),
            "the first integer no float holds": fenced(action_text(x=str(2**1024 - 2**970))),
            "a huge integer": fenced(action_text(x="1" + "0" * 400)),
            "a huge negative integer for the gripper": fenced(action_text(width="-1" + "0" * 400)),
            "text before a huge integer": fenced(action_text(x='"a"', y="1" + "0" * 400)),
            "a huge integer before text": fenced(action_text(x="1" + "0" * 400, y='"a"')),
            "a bad arm and a bad gripper": fenced(action_text(x="true").replace('"width"', '"opening"')),
            "a good arm and a bad gripper number": fenced(action_text(width="null")),
            # names given twice
            "duplicate quantity": fenced(valid.replace('"x": 0', '"x": 1, "x": 0')),
            "duplicate part": fenced(valid[:-1] + ', "arm": {}}'),
            "duplicate with wide characters": fenced('{"手臂\U0001f916": 1, "手臂\U0001f916": 2}'),
            "duplicate with quotes and escapes": fenced('{"a\\"b\\\\\\n": 1, "a\\"b\\\\\\n": 2}'),
            "duplicate lone surrogate": fenced('{"\\ud800": 1, "\\ud800": 2}'),
            "duplicate of an escaped pair": fenced('{"\\ud83d\\ude00": 1, "\U0001f600": 2}'),
            "a pair that is none": fenced('{"\\ud83d\\u0041": 1, "\\ud83dA": 2}'),
            "duplicate deep inside": fenced('{"arm": {"x": [{"a": 1, "b": 2, "a": 3}]}, "gripper": {"width": 0}}'),
            "duplicate before a syntax error": fenced('{"arm": {"x": 0, "x": 1}, oops}'),
            "syntax error before the object with a duplicate ends": fenced('{"arm": {"x": 0, "x": 1,}}'),
            "duplicate in a block that is not the last": fenced('{"x": 0, "x": 1}') + "\n" + fenced(valid),
        }

        return [cls.case(label, answer) for label, answer in answers.items()]

    @classmethod
    def pear_test_cases(cls) -> list[dict[str, Any]]:
        """The answers of PEAR's test_invalid_final_action_never_parses, built as that test builds them."""
        cases = []
        for bad in (
            "missing",
            "extra",
            "bool",
            "nan",
            "infinity",
            "shape",
            "partial",
            "reasoning",
            "duplicate",
            "extra_quantity",
        ):
            data = {"arm": {name: 0.0 for name in ARM}, "gripper": {"width": 0.0}}
            if bad == "missing":
                data.pop("gripper")
            elif bad == "extra":
                data["request_id"] = "old"
            elif bad in ("bool", "nan", "infinity", "shape"):
                data["arm"]["x"] = {"bool": True, "nan": float("nan"), "infinity": float("inf")}.get(bad, [0])
            elif bad == "extra_quantity":
                data["arm"]["yaw"] = 0.0

            answer = "```json\n" + json.dumps(data) + "\n```"
            if bad == "partial":
                answer = answer[:-4]
            elif bad == "reasoning":
                answer = "<think>" + answer + "</think>"
            elif bad == "duplicate":
                answer = answer.replace('"x": 0.0', '"x": 1, "x": 0.0', 1)
            cases.append(cls.case(f"PEAR's test: {bad}", answer))

        return cases

    @classmethod
    def limits(cls) -> list[dict[str, Any]]:
        """Answers at Python's limits: the digits of an integer and the depth of nesting."""
        specifications = [{"kind": "digits", "count": count} for count in (4300, 4301)]
        for kind in ("nested_objects", "nested_arrays", "arrays_then_object"):
            first = cls.first_refused(kind)
            specifications += [{"kind": kind, "count": count} for count in range(first - 2, first + 3)]

        return [
            cls.case(f"{specification['kind']} {specification['count']}", cls.generated(specification), specification)
            for specification in specifications
        ]

    @classmethod
    def mutated(cls, generator: random.Random, count: int) -> list[dict[str, Any]]:
        """Answers a few characters away from one that gives an action."""
        bases = (
            cls.fenced(cls.VALID),
            cls.fenced(cls.action_text(x="1.5", y="-2", z="0.25e1", pitch="-0.1", roll="1E-2", width="-1")),
            "Lower the arm.\n" + cls.fenced(json.dumps(json.loads(cls.VALID), indent=1)),
            cls.fenced(cls.action_text(x="12", width="1")) + "\n",
        )
        pieces = list('{}[]",:0123456789.-+eE \n\t\\`') + [
            "true",
            "false",
            "null",
            "NaN",
            "Infinity",
            "-Infinity",
            '"x"',
            '"arm"',
            "1e999",
            "<think>",
            "```",
            "```json",
            "\\u00e9",
            "é",
            "\U0001f600",
            " ",
        ]
        cases = []
        for index in range(count):
            answer = generator.choice(bases)
            for _ in range(generator.randint(1, 3)):
                position = generator.randrange(len(answer) + 1)
                edit = generator.random()
                if edit < 0.4:
                    answer = answer[:position] + generator.choice(pieces) + answer[position:]
                elif edit < 0.7:
                    answer = answer[:position] + answer[position + generator.randint(1, 3) :]
                else:
                    answer = answer[:position] + generator.choice(pieces) + answer[position + 1 :]
            cases.append(cls.case(f"mutation {index}", answer, with_feedback=False))

        return cases

    @classmethod
    def numbers(cls, generator: random.Random, count: int) -> list[dict[str, Any]]:
        """Actions whose quantities are number literals of every shape JSON allows."""

        def literal() -> str:
            sign = generator.choice(("", "", "-"))
            integer = generator.choice(("0", str(generator.randrange(1, 10)), str(generator.randrange(10**20))))
            shape = generator.random()
            if shape < 0.25:
                return sign + integer
            fraction = "." + "".join(generator.choice("0123456789") for _ in range(generator.randint(1, 22)))
            if shape < 0.6:
                return sign + integer + fraction
            exponent = generator.choice("eE") + generator.choice(("", "+", "-")) + str(generator.randrange(0, 330))
            return sign + integer + (fraction if shape < 0.85 else "") + exponent

        cases = []
        for index in range(count):
            tokens = {name: literal() for name in (*ARM, "width")}
            cases.append(cls.case(f"numbers {index}", cls.fenced(cls.action_text(**tokens)), with_feedback=False))

        return cases


class Feedback:
    """Results of every kind an SO-101 action ends with, and what PEAR tells the model of each."""

    @staticmethod
    def result(
        status: MotionStatus,
        *,
        settled: bool = True,
        reached: bool = True,
        error: BaseException | None = None,
        gripper_outcome: str | None = None,
        snapshot: dict[str, Any] | None = None,
    ) -> SO101MotionResult:
        """Returns the result PEAR builds of an action that ended with ``status`` at a snapshot of the arm."""
        if snapshot is None:
            snapshot = {"status": "READY", "arrival": {"settled": settled, "reached": reached}}

        return SO101MotionResult.from_snapshot(
            snapshot, status=status, error=error, kinematics=None, gripper_outcome=gripper_outcome
        )

    @staticmethod
    def case(label: str, result: SO101MotionResult | None, is_dispatched: bool) -> dict[str, Any]:
        record = None
        if result is not None:
            record = {
                "status": result.status.value,
                "is_settled": result.is_settled,
                "target_reached": result.target_reached,
                "gripper_outcome": result.gripper_outcome,
                "error": result.error,
            }

        return {
            "label": label,
            "result": record,
            "is_dispatched": is_dispatched,
            "text": SingleArmPoseFormat.result_feedback(result, is_dispatched=is_dispatched),
        }

    @classmethod
    def cases(cls, generator: random.Random) -> list[dict[str, Any]]:
        completed, rejected, failed = MotionStatus.COMPLETED, MotionStatus.REJECTED, MotionStatus.FAILED
        cases = [cls.case("no result", None, False), cls.case("no result of a dispatched action", None, True)]

        outcomes = (None, *(outcome.value for outcome in GripperOutcome))
        for outcome in outcomes:
            for settled, reached in ((True, True), (True, False), (False, True), (False, False)):
                label = f"completed, gripper {outcome}, settled {settled}, arm reached {reached}"
                result = cls.result(completed, settled=settled, reached=reached, gripper_outcome=outcome)
                cases.append(cls.case(label, result, True))
        cases.append(cls.case("completed and never dispatched", cls.result(completed), False))

        # the inverse kinematics' refusals, in the words SO101Kinematics.joint_target gives them
        for index in range(24):
            delta = np.zeros(len(ARM))
            for position in generator.sample(range(len(ARM)), generator.randint(1, len(ARM))):
                size = generator.choice((0.3, 2.0, 5.0, 60.0, 200.0)) if position < 3 else generator.choice((0.1, 1.5))
                delta[position] = round(generator.uniform(-size, size), generator.choice((0, 1, 2)))
            fraction = generator.randrange(128) / 128  # what BaseKinematics.reachable_fraction can return
            error = UnreachablePoseError(SO101Kinematics.unreachable_message(delta, fraction))
            result = cls.result(rejected, reached=bool(index % 3), error=error)
            cases.append(cls.case(f"out of reach {index}", result, index % 4 != 0))
        for message in ("IK position error 12.3 mm", "IK orientation error 0.123 rad", "at most 18%.", ""):
            result = cls.result(rejected, error=UnreachablePoseError(message))
            cases.append(cls.case(f"out of reach, the solver's words: {message!r}", result, True))
        unsettled = cls.result(rejected, settled=False, reached=False, error=UnreachablePoseError("at most 18%."))
        cases.append(cls.case("out of reach while unsettled", unsettled, True))
        after_dispatch = cls.result(failed, error=UnreachablePoseError("at most 18%."))
        cases.append(cls.case("unreachable pose after a dispatch: failed, not rejected", after_dispatch, True))

        errors: list[tuple[MotionStatus, BaseException, bool]] = [
            (rejected, ValueError("Rotation increment exceeds the planning bound"), True),
            (rejected, ValueError("Expected finite measured and commanded positions"), True),
            (rejected, ValueError("Final answer must end with a fenced json action"), False),
            (rejected, ValueError("Final answer unexpectedly contains a thinking block"), False),
            (rejected, ValueError("Expected exactly the parts arm, gripper"), False),
            (rejected, ValueError("Action quantities must be finite numbers, not booleans"), False),
            (rejected, ValueError("Duplicate action field: 手臂\U0001f916"), False),
            (rejected, ValueError('Duplicate action field: a"b\\\n\t\r\x08\x0c\x00\x1f\x7f\x80 \ud800'), False),
            (rejected, json.JSONDecodeError("Expecting ',' delimiter", '{"a": 1\n "b"}', 8), False),
            (rejected, ValueError(""), False),
            (failed, OverflowError("int too large to convert to float"), False),
            (failed, RecursionError("maximum recursion depth exceeded"), False),
            (failed, RuntimeError("Cartesian action was interrupted"), True),
            (failed, RuntimeError("Gripper reference is no longer stable"), True),
            (failed, TimeoutError("Model request timed out; no action will execute"), False),
            (failed, TimeoutError("No stable window before dispatch; no new command sent"), True),
            (failed, TimeoutError("Action total timeout exceeded"), True),
            (failed, GripperEndpointTimeout("Gripper closing endpoint was not reached"), True),
            (failed, GripperEndpointTimeout("Gripper opening endpoint was not reached"), True),
            (failed, OperatorPaused("The operator interrupted this turn; remaining motion was cancelled."), True),
            (failed, OperatorPaused("The operator interrupted this turn; remaining motion was cancelled."), False),
            (failed, OperatorPaused("Operation interrupted by the operator"), True),
            (failed, ValueError("Station session changed during validation"), True),
            (failed, RuntimeError(""), True),
            (failed, RuntimeError(), True),
        ]
        for index, (status, error, is_dispatched) in enumerate(errors):
            for settled in (True, False):
                label = f"{status.value} {index}: {type(error).__name__}, settled {settled}"
                result = cls.result(status, settled=settled, error=error)
                cases.append(cls.case(label, result, is_dispatched))

        closed = cls.result(failed, error=RuntimeError("Open the station first"), snapshot={"status": "OFF"})
        cases.append(cls.case("failed on a closed robot", closed, True))
        both = SO101MotionResult(
            status=failed,
            is_settled=True,
            target_reached=False,
            measured_position=None,
            tracking_error=None,
            gripper_outcome=GripperOutcome.CLOSED.value,
            error={"code": "RuntimeError", "message": "Cartesian action was interrupted"},
        )
        cases.append(cls.case("an error and a gripper outcome", both, True))

        return cases


class StoredTexts:
    """PEAR's own stored texts of the SO-101 format, with the inputs that give them: made here the way PEAR's tests
    make them, and refused unless they equal PEAR's files."""

    INSTRUCTION = "Pick up the red cube."  # INSTRUCTION of PEAR's test_agent_loop_messages_in_station.py
    DIRECTORY = PEAR_PACKAGE.parent / "tests" / "deploy" / "station" / "stored_texts"

    @classmethod
    def read(cls, kind: str) -> str:
        return (cls.DIRECTORY / f"{kind}-so101-{FORMAT.name}.txt").read_text(encoding="utf-8")

    @classmethod
    def expect(cls, kind: str, text: str) -> str:
        if text != cls.read(kind):
            sys.exit(f"The {kind} text made here is not PEAR's stored text")

        return text

    @classmethod
    def record(cls, turns: Turns) -> dict[str, Any] | None:
        if not cls.DIRECTORY.is_dir():
            return None

        prompt = cls.expect("prompt", SystemPrompt.render(cls.INSTRUCTION, FORMAT))

        stored_observation = cls.read("observation")
        state = json.loads(stored_observation.splitlines()[0])
        feedback = stored_observation.splitlines()[-1].removeprefix("Previous execution: ")
        images = "--- images: " + ", ".join(f"{camera.name} turn-1-{camera.name}.jpg" for camera in FORMAT.cameras)
        observation_parts = [turns.text(state, None), images, "--- with feedback:", turns.text(state, feedback)]
        cls.expect("observation", "\n".join(observation_parts) + "\n")

        # DemonstrationActions.action("single_arm_pose", 0, True) of PEAR's tests
        action = {"arm": dict(x=0.0, y=0.0, z=0.3, pitch=0.0, roll=0.0), "gripper": {"width": 0.0}}
        missing = {part: fields for part, fields in action.items() if part != "arm"}
        text_value = {**action, "arm": {**action["arm"], "z": "up"}}
        answers = {
            "valid": f"Moving.\n```json\n{json.dumps(action)}\n```",
            "missing part": f"```json\n{json.dumps(missing)}\n```",
            "text after the block": f"```json\n{json.dumps(action)}\n```\nDone.",
            "non-number": f"```json\n{json.dumps(text_value)}\n```",
            "thinking block": f"<think>plan</think>\n```json\n{json.dumps(action)}\n```",
            "duplicate field": '```json\n{"arm": {"x": 0, "x": 1}}\n```',
            "no block": "I will move the arm.",
        }
        parse_lines = []
        for label, answer in answers.items():
            try:
                parsed = ActionParser.parse(answer, FORMAT).model_dump(mode="json")
                parse_lines.append(f"{label}: {json.dumps(parsed, sort_keys=True)}")
            except ValueError as error:
                parse_lines.append(f"{label}: {type(error).__name__}: {error}")
        cls.expect("parse", "\n".join(parse_lines) + "\n")

        # what the arm of PEAR's test reaches of 200 cm along x: 3/128 of it
        out_of_reach = UnreachablePoseError(SO101Kinematics.unreachable_message(np.array([200.0, 0, 0.3, 0, 0]), 3 / 128))
        results = {
            "interrupted": (None, False),
            "completed move": (Feedback.result(MotionStatus.COMPLETED), True),
            "out of reach": (Feedback.result(MotionStatus.REJECTED, error=out_of_reach), True),
            "gripper closing": (Feedback.result(MotionStatus.COMPLETED, gripper_outcome="closed"), True),
        }
        feedback_cases = [Feedback.case(label, result, is_dispatched) for label, (result, is_dispatched) in results.items()]
        cls.expect("feedback", "".join(f"{case['label']}: {case['text']}\n" for case in feedback_cases))

        return {
            "prompt": {"instruction": cls.INSTRUCTION, "text": prompt},
            "observation": {"state": state, "feedback": feedback, "parts": observation_parts},
            "parse": {"answers": answers, "lines": parse_lines},
            "feedback": {"cases": feedback_cases},
        }


class Fixtures:
    """Writes each fixture file: ASCII only, and one case a line where it holds cases."""

    directory = FIXTURES  # where the files go: the committed fixtures unless --output names another place

    @classmethod
    def write(cls, name: str, fields: dict[str, Any], cases: list[Any] | None = None) -> None:
        cls.directory.mkdir(parents=True, exist_ok=True)
        if cases is None:
            text = json.dumps(fields, ensure_ascii=True, indent=1) + "\n"
        else:
            entries = [f" {json.dumps(key)}: {json.dumps(value, ensure_ascii=True)}" for key, value in fields.items()]
            lines = ",\n".join("  " + json.dumps(case, ensure_ascii=True) for case in cases)
            entries.append(f' "cases": [\n{lines}\n ]')
            text = "{\n" + ",\n".join(entries) + "\n}\n"
        json.loads(text)  # (raises unless the file is JSON)
        (cls.directory / name).write_text(text, encoding="ascii", newline="\n")
        print(f"{name}: {'no' if cases is None else len(cases)} cases, {len(text)} bytes")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sync-prompts", action="store_true", help="copy PEAR's prompt files and embed them first")
    parser.add_argument("--scale", type=int, default=1, help="times as many generated cases (1: the committed set)")
    parser.add_argument("--output", type=Path, help="write there instead of tests/fixtures/protocol")
    arguments = parser.parse_args()
    if arguments.scale != 1 and arguments.output is None:
        sys.exit("The committed fixtures are the set of --scale 1: name another --output for a larger one")
    if arguments.output is not None:
        Fixtures.directory = arguments.output
    scale = arguments.scale

    commit, pinned = Commit.of_pear(), Commit.pinned()
    if commit is not None and commit != pinned:
        sys.exit(f"This PEAR is at {commit}; src/index.ts pins {pinned}")
    if arguments.sync_prompts:
        Prompts.sync()
    prompts = Prompts.check()

    whitespace = [code for code in range(sys.maxunicode + 1) if chr(code).isspace()]
    if whitespace != [code for code in range(sys.maxunicode + 1) if re.fullmatch(r"\s", chr(code))]:
        sys.exit("str.isspace and the pattern \\s differ")
    meta = {
        "pear_commit": commit,
        "python": sys.version.split()[0],
        "pydantic": pydantic.VERSION,
        "format": FORMAT.name,
        "schema": {part: list(names) for part, names in FORMAT.schema.items()},
        "decimals": FORMAT.decimals,
        "cameras": [camera.name for camera in FORMAT.cameras],
        "json_block_pattern": JsonBlockProtocol.JSON_BLOCK_PATTERN.pattern,
        "think_start": ActionParser.THINK_START,
        "unreachable_code": UnreachablePoseError.__name__,
        "motion_statuses": [status.value for status in MotionStatus],
        "gripper_outcomes": [outcome.value for outcome in GripperOutcome],
        "whitespace": whitespace,
        "prompts": prompts,
    }

    generator = random.Random(SEED)

    instructions = [
        "Pick up the red cube.",
        "",
        "把紅色的方塊放進藍色的盒子裡。",
        "拿起桌上的杯子，然後放到盤子上。\n動作要慢。",
        "1. Open the gripper.\n2. Move above the cube.\n\n3. Close the gripper.\n",
        "  Windows line breaks\r\nand a tab\there, spaces around  ",
        "Write {instruction} and {environment} as they are; $& $1 $$ $` $' too",
        "## TASK\n\nQuotes \"double\" 'single' and a backslash \\ and a block:\n```json\n{}\n```",
        "Emoji \U0001f916 and accents café naïve. " + "A long task. " * 8,
    ]
    Fixtures.write(
        "system_prompt.json",
        {},
        [{"instruction": text, "prompt": SystemPrompt.render(text, FORMAT)} for text in instructions],
    )

    numbers = Numbers.samples(generator, 400 * scale)
    strings = [
        "",
        "plain",
        'quote " backslash \\ slash /',
        "\x00\x01\x02\x03\x04\x05\x06\x07\x08\t\n\x0b\x0c\r\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b",
        "\x1c\x1d\x1e\x1f !~\x7f\x80\x9f\xa0\xff",
        "café 手臂    ﻿ ￿",
        "\U0001f916 \U00010000 \U0010ffff",
        "\ud800 \udfff \udc00\ud800",
    ]
    Fixtures.write(
        "python.json",
        {"strings": [[text, json.dumps(text)] for text in strings]},
        [Numbers.case(value) for value in numbers],
    )

    with tempfile.TemporaryDirectory() as directory:
        turns = Turns(Path(directory))
        feedbacks = [
            None,
            None,
            None,
            "",
            "an earlier execution report",
            SingleArmPoseFormat.result_feedback(Feedback.result(MotionStatus.COMPLETED), is_dispatched=True),
            "上一個動作的報告\n第二行 \U0001f916",
        ]
        widths = [0.0, 6.0, 1.0, -1.0, 0.5, 3.0, 5.96, 0.04, -0.04, 2.25, 0, 6]
        turn_cases = []
        for index in range(180 * scale):
            pick = (lambda: generator.choice(numbers[:140])) if index % 3 else (lambda: generator.choice(numbers))
            state = {
                "arm": {name: pick() for name in ARM},
                "gripper": {"width": generator.choice(widths) if index % 2 else pick()},
            }
            if index % 40 == 0:  # whole numbers given as integers, which the state's model takes as floats
                state["arm"]["x"], state["arm"]["roll"] = generator.randrange(-40, 40), generator.randrange(-3, 3)
            feedback = generator.choice(feedbacks)
            turn_cases.append({"state": state, "feedback": feedback, "text": turns.text(state, feedback)})
        Fixtures.write("turn_text.json", {}, turn_cases)

        stored = StoredTexts.record(turns)

    parse_cases = Parsing.hand_written() + Parsing.pear_test_cases() + Parsing.limits()
    parse_cases += Parsing.numbers(generator, 60 * scale) + Parsing.mutated(generator, 150 * scale)
    Fixtures.write("parse.json", {}, parse_cases)
    refused, parsed = sum("error" in case for case in parse_cases), sum("action" in case for case in parse_cases)
    print(f"  parsed {parsed}, refused {refused}")

    Fixtures.write("feedback.json", {}, Feedback.cases(generator))

    Fixtures.write("meta.json", {**meta, "stored_texts": stored})


if __name__ == "__main__":
    main()
