"""Writes tests/python/reference.json: what Python itself, PEAR, lerobot and the OpenAI SDK say of the things that
src/python holds for every module of pear.js.

    exceptions   each exception class pear.js has a class for: its name, the names of its bases in Python's order,
                 whether isinstance(error, ValueError) holds for it, and the text of a few instances
    servo_errors what lerobot's bus and PEAR's hardware files raise where pear.js's servo layer throws and the
                 fixtures of tests/feetech have no case: the class, its bases and the message
    floats       doubles of every kind with Python's repr(), round(x, n), format(x, ".nf"), "+.nf", "g" and "+g"
    texts        texts with Python's repr(): quotes, escapes, every plane, lone surrogates, and code points that
                 Python's Unicode version does not know

Run it with the Python of a PEAR station environment (PEAR at the commit src/index.ts pins), from any directory:

    <work dir>/envs/station/bin/python tests/python/make_reference.py

It writes that one file and nothing else, and it is deterministic: no clock, no path, fixed seeds.
tests/python/*.test.ts compare pear.js with it.

For a longer comparison that is not committed, write a larger set elsewhere and point the tests at it:

    <work dir>/envs/station/bin/python tests/python/make_reference.py --scale 50 --output <directory>
    PEAR_JS_PYTHON_REFERENCE=<directory> npx vitest run tests/python
"""

from __future__ import annotations

import argparse
import importlib
import json
import platform
import random
import re
import struct
import sys
import unicodedata
from importlib import metadata
from pathlib import Path
from typing import Any

import pear

REPOSITORY = Path(__file__).resolve().parents[2]
REFERENCE_NAME = "reference.json"
PEAR_PACKAGE = Path(pear.__file__).resolve().parent
SEED = 20261115

# every Python exception class pear.js has a class for, as "module:name": the built-ins src/python/errors.ts ports,
# PEAR's own, lerobot's and the OpenAI SDK's
EXCEPTION_CLASSES = (
    "builtins:Exception",
    "builtins:ArithmeticError",
    "builtins:OverflowError",
    "builtins:ZeroDivisionError",
    "builtins:AttributeError",
    "builtins:LookupError",
    "builtins:IndexError",
    "builtins:KeyError",
    "builtins:OSError",
    "builtins:ConnectionError",
    "builtins:TimeoutError",
    "builtins:RuntimeError",
    "builtins:NotImplementedError",
    "builtins:RecursionError",
    "builtins:StopIteration",
    "builtins:TypeError",
    "builtins:ValueError",
    "builtins:UnicodeError",
    "builtins:UnicodeDecodeError",
    "json:JSONDecodeError",
    "pear.deploy.station.exceptions:OperatorPaused",
    "pear.deploy.station.control.motion.kinematics:UnreachablePoseError",
    "pear.deploy.station.control.joint.stability:StabilityError",
    "pear.deploy.station.control.joint.tracking:TrackingError",
    "pear.deploy.station.agent_loop.clients.client:ContextLimit",
    "pear.deploy.station.agent_loop.clients.client:SessionLost",
    "pear.deploy.station.agent_loop.clients.vllm:ImageCacheMiss",
    "pear.deploy.station.control.robots.so101.hardware.arm_state:ServoFault",
    "lerobot.utils.errors:DeviceNotConnectedError",
    "lerobot.utils.errors:DeviceAlreadyConnectedError",
    "openai:OpenAIError",
    "openai:APIError",
    "openai:APIStatusError",
    "openai:APIConnectionError",
    "openai:APITimeoutError",
    "openai:BadRequestError",
    "openai:AuthenticationError",
    "openai:PermissionDeniedError",
    "openai:NotFoundError",
    "openai:ConflictError",
    "openai:UnprocessableEntityError",
    "openai:RateLimitError",
    "openai:InternalServerError",
)
# what pear.js throws in the place of an exception that no `except Exception` catches
BASE_EXCEPTION_CLASSES = ("asyncio:CancelledError",)


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


class Exceptions:
    """The exception classes, as Python relates them."""

    @staticmethod
    def resolve(path: str) -> type[BaseException]:
        module_name, name = path.split(":")
        return getattr(importlib.import_module(module_name), name)

    @classmethod
    def record_class(cls, path: str) -> dict[str, Any]:
        exception_class = cls.resolve(path)
        return {
            "name": exception_class.__name__,
            "module": path.split(":")[0],
            # the class itself first, then its bases as isinstance sees them; object is left out
            "mro": [base.__name__ for base in exception_class.__mro__ if base is not object],
            "is_exception": issubclass(exception_class, Exception),
            "is_value_error": issubclass(exception_class, ValueError),
        }

    @classmethod
    def record(cls) -> dict[str, Any]:
        classes = [cls.record_class(path) for path in EXCEPTION_CLASSES + BASE_EXCEPTION_CLASSES]
        names = [each["name"] for each in classes]
        if len(set(names)) != len(names):
            sys.exit("Two of the exception classes have one name")

        return {
            "classes": classes,
            # str(error): what a result's message holds
            "texts": {
                "TimeoutError()": str(TimeoutError()),
                "KeyError('wrist')": str(KeyError("wrist")),
                "ValueError('refused')": str(ValueError("refused")),
            },
            # {"code": type(error).__name__, "message": str(error)} of MotionResult.build, for a class of each kind
            "motion_errors": [
                {"code": type(error).__name__, "message": str(error)}
                for error in (
                    ValueError("Rotation increment exceeds the planning bound"),
                    cls.resolve("pear.deploy.station.exceptions:OperatorPaused")("Operation interrupted by the operator"),
                    cls.resolve("pear.deploy.station.control.motion.kinematics:UnreachablePoseError")("out of reach"),
                    TimeoutError(),
                    KeyError("wrist"),
                )
            ],
        }


class ServoErrors:
    """What lerobot and PEAR raise at the places where pear.js's servo layer throws and no fixture of tests/feetech
    has a case: their own functions, called on a bus that opens no port."""

    PORT = "sim"  # a name only: nothing is opened

    @staticmethod
    def raised(call: Any) -> dict[str, Any]:
        try:
            call()
        except Exception as error:  # noqa: BLE001  (whatever is raised is the record)
            return {
                "type": type(error).__name__,
                "message": str(error),
                "bases": [base.__name__ for base in type(error).__mro__ if base is not object],
            }
        sys.exit("A call that pear.js's servo layer refuses was taken by the reference")

    @classmethod
    def record(cls) -> dict[str, Any]:
        from types import SimpleNamespace

        from lerobot.motors import Motor, MotorCalibration, MotorNormMode
        from lerobot.motors.feetech import FeetechMotorsBus
        from lerobot.motors.feetech.tables import MODEL_CONTROL_TABLE
        from lerobot.motors.motors_bus import get_address
        from pear.deploy.station.control.robots.so101.hardware.arms import SO101Hardware
        from pear.deploy.station.control.robots.so101.hardware.startup import StartupChecks

        model = "sts3215"
        motors = {
            "pan": Motor(1, model, MotorNormMode.DEGREES),
            "lift": Motor(2, model, MotorNormMode.DEGREES),
        }
        # the calibration of the first motor alone
        calibration = {"pan": MotorCalibration(id=1, drive_mode=0, homing_offset=0, range_min=1000, range_max=3000)}
        bus = FeetechMotorsBus(port=cls.PORT, motors=motors, calibration=calibration)

        closed = object.__new__(SO101Hardware)  # only what read() and send() look at first; nothing is opened
        closed.is_closed = True
        calls = SimpleNamespace(connect=0, disconnect=0)

        def connect(handshake: bool) -> None:
            calls.connect += 1

        def disconnect(disable_torque: bool) -> None:
            calls.disconnect += 1

        uncalibrated = SimpleNamespace(calibration={}, calibration_fpath="calibration.json")
        mismatched = SimpleNamespace(
            calibration=calibration,
            bus=SimpleNamespace(connect=connect, disconnect=disconnect, is_calibrated=False),
        )

        sites = {
            # lerobot/motors/motors_bus.py
            "two motors with one id": lambda: FeetechMotorsBus(
                port=cls.PORT,
                motors={"pan": Motor(1, model, MotorNormMode.DEGREES), "lift": Motor(1, model, MotorNormMode.DEGREES)},
            ),
            "a motor's name the bus does not have": lambda: bus.ping("wrist"),
            "a motor's id the bus does not have": lambda: bus._normalize({9: 2000}),
            "a motor without a calibration": lambda: bus._normalize({2: 2000}),
            "a register of three bytes": lambda: bus._read(0, 3, 1),
            "a position that is NaN": lambda: bus._unnormalize({1: float("nan")}),
            "a position that is infinite": lambda: bus._unnormalize({1: float("inf")}),
            "a register the servo does not have": lambda: get_address(MODEL_CONTROL_TABLE, model, "Present_Speed"),
            # pear/deploy/station/control/robots/so101/hardware
            "a read of an arm that is closed": lambda: closed.read(),
            "a command to an arm that is closed": lambda: closed.send((0.0, 0.0, 0.0, 0.0, 0.0, 0.5)),
            "an arm without a calibration": lambda: StartupChecks.connect_checked(uncalibrated),
            "a calibration that the servos do not hold": lambda: StartupChecks.connect_checked(mismatched),
        }
        recorded = {site: cls.raised(call) for site, call in sites.items()}
        if (calls.connect, calls.disconnect) != (1, 1):
            sys.exit("PEAR's connect_checked did not connect and disconnect the stand-in bus once")
        # lerobot prints the whole bus into two of its messages, with every motor: only how they begin or end is kept
        same_id = recorded["two motors with one id"]
        same_id["message"] = same_id["message"].split("\n")[0]

        return recorded


class Floats:
    """Doubles with what Python writes of each."""

    DECIMALS = (0, 1, 2, 3, 6, 17)  # of round(x, n) and of format(x, ".nf")
    PLUS_DECIMALS = (1, 3)  # of format(x, "+.nf")
    MANY_DECIMALS = 101  # more than a JavaScript engine's toFixed takes: round(x, 101)

    @staticmethod
    def bits(value: float) -> str:
        """The double's 64 bits, as 16 hexadecimal digits: every value, the sign of a zero and a NaN included."""
        return struct.pack(">d", value).hex()

    @staticmethod
    def from_bits(bits: int) -> float:
        return struct.unpack(">d", bits.to_bytes(8, "big"))[0]

    @classmethod
    def values(cls, generator: random.Random, scale: int) -> list[float]:
        values = [0.0, -0.0, float("nan"), float("inf"), float("-inf")]
        # ties a float holds exactly, where round() goes to the even digit and toFixed away from zero
        values += [0.5, 1.5, 2.5, 0.25, 0.75, 2.25, 2.35, 0.125, 0.375, 1.0625, -0.5, -2.25, -0.125, 1e15 + 0.5]
        # where repr() and "g" change their form
        values += [1e16, 9999999999999998.0, 1e-4, 9.999e-5, 1e-5, 123456.5, 999999.5, 1e6, 1234567.0, 1e21, 1e22]
        values += [5e-324, 2.2250738585072014e-308, 1.7976931348623157e308, 4.35, 0.1, 0.3, 1 / 3, 100.0, 6.0, -6.0]

        for _ in range(120 * scale):  # the magnitudes of a station's quantities
            values.append(generator.uniform(-1, 1) * 10 ** generator.randint(-4, 3))
        for _ in range(60 * scale):  # exact ties at 0 to 6 decimals
            decimals = generator.randint(0, 6)
            odd = 2 * generator.randrange(2 ** generator.randint(1, 30)) + 1
            values.append(generator.choice((1, -1)) * odd / 2 ** (decimals + 1))
        for _ in range(60 * scale):  # decimals written with a 5 after the last place kept
            decimals = generator.randint(0, 6)
            whole = generator.randrange(10 ** generator.randint(0, 6))
            kept = str(generator.randrange(10**decimals)).rjust(decimals, "0") if decimals else ""
            tail = generator.choice(("5", "49999999999", "50000000001"))
            values.append(float(f"{whole}.{kept}{tail}"))
        for _ in range(60 * scale):  # any bits, of a magnitude whose fixed-point text stays short
            sign = generator.getrandbits(1) << 63
            exponent = generator.randint(1023 - 70, 1023 + 70) << 52
            values.append(cls.from_bits(sign | exponent | generator.getrandbits(52)))
        for _ in range(6 * scale):  # any bits at all
            values.append(cls.from_bits(generator.getrandbits(64)))

        return values

    @classmethod
    def record_value(cls, value: float) -> dict[str, Any]:
        return {
            "bits": cls.bits(value),
            "repr": repr(value),
            "round": [cls.bits(round(value, decimals)) for decimals in cls.DECIMALS],
            "round_many": cls.bits(round(value, cls.MANY_DECIMALS)),
            "fixed": [format(value, f".{decimals}f") for decimals in cls.DECIMALS],
            "fixed_plus": [format(value, f"+.{decimals}f") for decimals in cls.PLUS_DECIMALS],
            "general": format(value, "g"),
            "general_plus": format(value, "+g"),
        }

    @classmethod
    def record(cls, generator: random.Random, scale: int) -> dict[str, Any]:
        return {
            "decimals": list(cls.DECIMALS),
            "plus_decimals": list(cls.PLUS_DECIMALS),
            "many_decimals": cls.MANY_DECIMALS,
            "values": [cls.record_value(value) for value in cls.values(generator, scale)],
        }


class Texts:
    """Texts with Python's repr() of each."""

    # assigned after Unicode 15.0.0, which Python 3.12 holds: an engine that knows them finds them printable
    LATER_CODE_POINTS = (0x088F, 0x0897, 0x1C89, 0x2FFC, 0xA7CB, 0x105C0, 0x1CC00, 0x1FAE9, 0x2EBF0, 0x323B0)

    @classmethod
    def values(cls, generator: random.Random, scale: int) -> list[str]:
        texts = [
            "",
            "plain",
            "it's",
            'say "hi"',
            "both ' and \"",
            "back\\slash",
            "tab\tline\nreturn\r",
            "\x00\x01\x1f\x7f",
            "\x80\x85\x9f\xa0\xad\xff",
            "caf\u00e9 \u00fc\u00f1 \u4e2d\u6587 \u65e5\u672c\u8a9e \ud55c\uad6d\uc5b4",
            "\U0001f600 \U0001f9d1\u200d\U0001f680",
            "e\u0301 a\u030a",
            "\u2028\u2029\u200b\u200e\ufeff\u00a0\u1680\u3000",
            "\ue000\uf8ff\U000f0000\U0010ffff\U000e0001",
            "\ud800",
            "\udfff x \udc00",
            "wrist",
            "CameraConfig.role",
            "{'error': \"it's\"}",
        ]
        texts += [chr(code_point) for code_point in cls.LATER_CODE_POINTS]
        texts += [f"'{chr(code_point)}\" {chr(code_point - 1)}" for code_point in cls.LATER_CODE_POINTS]
        # every code point up to U+02FF, in pieces: the escapes \x and \u, Latin-1's controls and spaces
        texts += ["".join(chr(code_point) for code_point in range(start, start + 64)) for start in range(0, 0x300, 64)]

        limits = (0x80, 0x800, 0x10000, 0x110000)
        for _ in range(150 * scale):
            text = ""
            for _ in range(generator.randint(1, 10)):
                character = chr(generator.randrange(generator.choice(limits)))
                # a low surrogate right after a high one is one character in a JavaScript string, two in Python's
                if not (text and "\ud800" <= text[-1] <= "\udbff" and "\udc00" <= character <= "\udfff"):
                    text += character
            texts.append(text + generator.choice(("", "'", '"', "'\"")))

        return texts

    @classmethod
    def record(cls, generator: random.Random, scale: int) -> dict[str, Any]:
        return {
            "unicode": unicodedata.unidata_version,
            "later_code_points": list(cls.LATER_CODE_POINTS),
            # (a text's code points, so that a lone surrogate needs no escape of JSON's own to be told apart)
            "values": [
                {"code_points": [ord(character) for character in text], "repr": repr(text)}
                for text in cls.values(generator, scale)
            ],
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--scale", type=int, default=1, help="times as many generated cases (1: the committed set)")
    parser.add_argument("--output", type=Path, help="write there instead of tests/python")
    arguments = parser.parse_args()
    if arguments.scale != 1 and arguments.output is None:
        sys.exit("The committed reference is the set of --scale 1: name another --output for a larger one")
    directory = arguments.output if arguments.output is not None else Path(__file__).resolve().parent

    commit, pinned = Commit.of_pear(), Commit.pinned()
    if commit != pinned:
        sys.exit(f"This PEAR is at {commit}; src/index.ts pins {pinned}")

    reference = {
        "meta": {
            "pear_commit": commit,
            "python": platform.python_version(),
            "lerobot": metadata.version("lerobot"),
            "openai": metadata.version("openai"),
            "script": "tests/python/make_reference.py",
            "scale": arguments.scale,
        },
        "exceptions": Exceptions.record(),
        "servo_errors": ServoErrors.record(),
        "floats": Floats.record(random.Random(SEED), arguments.scale),
        "texts": Texts.record(random.Random(SEED + 1), arguments.scale),
    }

    text = json.dumps(reference, indent=None, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
    # one case on a line, so that a change shows in a diff
    text = text.replace('{"bits":', '\n{"bits":').replace('{"code_points":', '\n{"code_points":')
    text = text.replace('{"name":', '\n{"name":').replace('"exceptions":', '\n"exceptions":')
    text = text.replace('"servo_errors":', '\n"servo_errors":').replace('{"type":', '\n{"type":') + "\n"
    json.loads(text)
    for private in (str(Path.home()), str(REPOSITORY), str(PEAR_PACKAGE.parent)):
        if private in text:
            sys.exit(f"The reference would hold a path of this machine: {private}")
    directory.mkdir(parents=True, exist_ok=True)
    (directory / REFERENCE_NAME).write_text(text, encoding="ascii", newline="\n")
    print(
        f"wrote {REFERENCE_NAME}: {len(text)} bytes, {len(reference['exceptions']['classes'])} classes, "
        f"{len(reference['floats']['values'])} floats, {len(reference['texts']['values'])} texts"
    )


if __name__ == "__main__":
    main()
