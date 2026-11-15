#!/usr/bin/env python
"""Writes the fixtures of pear.js's feetech module to tests/fixtures/feetech/.

Run it inside a PEAR station environment (PEAR at the pinned commit, lerobot 0.6.1 with its Feetech SDK), from any
directory:

    <work dir>/envs/station/bin/python tools/fixtures/feetech_fixtures.py

What the fixtures hold comes from the reference code itself: the Feetech SDK (scservo_sdk), lerobot's FeetechMotorsBus
and SO-101 follower, PEAR's SO101Hardware and StartupChecks. No serial port is opened. Inside the SDK's port handler
pyserial's Serial is replaced by FakeSerial, behind which FakeChain answers as a chain of servos would; the SDK's clock
is replaced by one that advances only when a read finds nothing, so that a timeout is deterministic and instant; the
arm's monotonic clock is replaced by a counter.

The bytes a servo sends (status packets) are this script's own: the SDK has no code that builds them. What is recorded
about them is what the SDK and lerobot make of them.
"""

from __future__ import annotations

import importlib
import importlib.metadata
import json
import random
import tempfile
import types
from dataclasses import asdict
from pathlib import Path
from typing import Any

import numpy as np
import scservo_sdk as scs

import lerobot
import lerobot.motors.feetech.feetech as lerobot_feetech
import lerobot.motors.feetech.tables as lerobot_tables
from lerobot.motors import Motor, MotorCalibration, MotorNormMode
from lerobot.motors.encoding_utils import decode_sign_magnitude, encode_sign_magnitude
from lerobot.motors.feetech import FeetechMotorsBus
from pear.deploy.station.control.robots.so101.config import HardwareConfig
from pear.deploy.station.control.robots.so101.hardware import arms as pear_arms
from pear.deploy.station.control.robots.so101.hardware import driver as pear_driver
from pear.deploy.station.control.robots.so101.hardware.arm_state import ServoFault
from pear.deploy.station.control.robots.so101.hardware.arms import SO101Hardware
from pear.deploy.station.control.robots.so101.hardware.driver import SO101Driver
from pear.deploy.station.control.robots.so101.hardware.startup import StartupChecks
from pear.deploy.station.control.robots.so101.layout import ARM, GRIPPER_INDEX, JOINTS, MOTORS, VECTOR_LENGTH

# the SDK's package exports a class under the name of its module protocol_packet_handler: the modules by their names
sdk = importlib.import_module("scservo_sdk.protocol_packet_handler")
sdk_port_handler = importlib.import_module("scservo_sdk.port_handler")

REPOSITORY = Path(__file__).resolve().parents[2]
FIXTURES = REPOSITORY / "tests" / "fixtures" / "feetech"
SEED = 20261115
MODEL = "sts3215"
PORT_NAME = "sim"  # a name only: nothing is opened
CALIBRATION_ID = "so101_follower"
TABLE: dict[str, tuple[int, int]] = lerobot_tables.MODEL_CONTROL_TABLE[MODEL]
SIGN_BITS: dict[str, int] = lerobot_tables.MODEL_ENCODING_TABLE[MODEL]
REGISTER_BYTES = 128  # of a simulated servo's control table
FEEDBACK_DELAY_S = 0.25  # how long after a reading its feedback is asked for
FEEDBACK_EVERY = 6  # the readings between two whose feedback is recorded

# One calibrated arm: id, drive_mode, homing_offset, range_min, range_max of each servo. The numbers stand for an arm
# calibrated with lerobot's procedure; wrist_roll spans the whole turn as lerobot sets it.
ARM_CALIBRATION = {
    "shoulder_pan": (1, 0, -31, 741, 3353),
    "shoulder_lift": (2, 0, 58, 867, 3227),
    "elbow_flex": (3, 0, -7, 930, 3164),
    "wrist_flex": (4, 0, 112, 907, 3188),
    "wrist_roll": (5, 0, -204, 0, 4095),
    "gripper": (6, 0, 23, 2031, 3480),
}
# Present_Position of each servo when the arm is switched on
RESTING_POSITIONS = {
    "shoulder_pan": 2051,
    "shoulder_lift": 912,
    "elbow_flex": 3101,
    "wrist_flex": 2790,
    "wrist_roll": 2040,
    "gripper": 2060,
}


class FakeClock:
    """The SDK's clock, ms: it advances only when a read finds nothing."""

    EMPTY_READ_MS = 1.0

    def __init__(self) -> None:
        self.now_ms = 1000.0

    def advance(self) -> None:
        self.now_ms += self.EMPTY_READ_MS


class Link:
    """The wire: every packet the host sent, with the bytes that came back and the timeout the SDK set for them."""

    def __init__(self) -> None:
        self.responder: Any = None  # what answers a packet: bytes -> bytes
        self.exchanges: list[dict[str, Any]] = []
        self.rx = bytearray()  # received and not yet read by the SDK

    def sent(self, data: bytes) -> None:
        reply = self.responder(data) if self.responder is not None else b""
        self.exchanges.append({"tx": list(data), "rx": list(reply), "timeout_ms": None})
        self.rx += reply

    def note_timeout(self, timeout_ms: float) -> None:
        if self.exchanges:
            self.exchanges[-1]["timeout_ms"] = timeout_ms

    def take(self) -> list[dict[str, Any]]:
        """Returns the exchanges since the last call."""
        taken, self.exchanges = self.exchanges, []
        return taken


CLOCK = FakeClock()
LINK = Link()


class FakeSerial:
    """Stands where pyserial's Serial is in the SDK's PortHandler."""

    def __init__(self, **_: Any) -> None:
        pass

    def write(self, packet: Any) -> int:
        data = bytes(packet)
        LINK.sent(data)
        return len(data)

    def read(self, length: int) -> bytes:
        chunk = bytes(LINK.rx[: max(length, 0)])
        del LINK.rx[: len(chunk)]
        if length > 0 and not chunk:
            CLOCK.advance()
        return chunk

    def flush(self) -> None:
        pass

    def reset_input_buffer(self) -> None:
        LINK.rx.clear()

    def close(self) -> None:
        pass

    @property
    def in_waiting(self) -> int:
        return len(LINK.rx)


class FakeMonotonic:
    """PEAR's monotonic clock, s: every call is a fixed step later."""

    START_S = 100.0
    STEP_S = 0.02

    def __init__(self) -> None:
        self.calls = 0

    def monotonic(self) -> float:
        value = self.START_S + self.STEP_S * self.calls
        self.calls += 1
        return value


class DummyLock:
    def close(self) -> None:
        pass


def install_fakes() -> None:
    """Puts the fakes where the reference code looks for its serial port, its clocks and its device lock."""
    sdk_port_handler.serial = types.SimpleNamespace(Serial=FakeSerial, EIGHTBITS=8)
    scs.PortHandler.getCurrentTime = lambda self: CLOCK.now_ms

    # lerobot binds its own setPacketTimeout to every port handler; this keeps it and notes what it computed
    lerobot_set_packet_timeout = lerobot_feetech.patch_setPacketTimeout

    def recording_set_packet_timeout(self: Any, packet_length: int) -> None:
        lerobot_set_packet_timeout(self, packet_length)
        LINK.note_timeout(self.packet_timeout)

    lerobot_feetech.patch_setPacketTimeout = recording_set_packet_timeout
    StartupChecks.lock_bus = classmethod(lambda cls, port: DummyLock())  # a lock file is no part of the port


def status_packet(servo_id: int, error: int, parameters: Any) -> bytes:
    """Returns the status packet a servo sends: the format of the Feetech protocol manual."""
    body = [servo_id, len(parameters) + 2, error, *parameters]
    return bytes([0xFF, 0xFF, *body, ~sum(body) & 0xFF])


class FakeServo:
    """One servo's control table as plain memory; with torque on, its position is its goal at once."""

    def __init__(self, servo_id: int) -> None:
        self.id = servo_id
        self.registers = bytearray(REGISTER_BYTES)

    def load(self, name: str) -> int:
        address, length = TABLE[name]
        return int.from_bytes(self.registers[address : address + length], "little")

    def store(self, name: str, value: int) -> None:
        address, length = TABLE[name]
        self.registers[address : address + length] = int(value).to_bytes(length, "little")

    def settle(self) -> None:
        if self.load("Torque_Enable") != 1:
            return
        goal = decode_sign_magnitude(self.load("Goal_Position"), SIGN_BITS["Goal_Position"])
        lower, upper = self.load("Min_Position_Limit"), self.load("Max_Position_Limit")
        if lower < upper:
            goal = min(max(goal, lower), upper)
        self.store("Present_Position", encode_sign_magnitude(goal, SIGN_BITS["Present_Position"]))


class FakeChain:
    """The servos on the bus, answering instruction packets; a step may be given faults, which last for that step."""

    def __init__(self, calibration: dict[str, tuple[int, int, int, int, int]]) -> None:
        self.servos: dict[int, FakeServo] = {}
        self.names: dict[str, int] = {}
        for name, (servo_id, _, homing_offset, range_min, range_max) in calibration.items():
            servo = FakeServo(servo_id)
            # the EEPROM of a calibrated servo
            servo.store("Firmware_Major_Version", 3)
            servo.store("Firmware_Minor_Version", 10)
            servo.store("Model_Number", lerobot_tables.MODEL_NUMBER_TABLE[MODEL])
            servo.store("ID", servo_id)
            servo.store("Return_Delay_Time", 250)
            servo.store("Response_Status_Level", 1)
            servo.store("Min_Position_Limit", range_min)
            servo.store("Max_Position_Limit", range_max)
            servo.store("Homing_Offset", encode_sign_magnitude(homing_offset, SIGN_BITS["Homing_Offset"]))
            servo.store("Max_Torque_Limit", 1000)
            servo.store("Phase", 12 | (0x10 if name == "wrist_flex" else 0))
            servo.store("P_Coefficient", 32)
            servo.store("D_Coefficient", 32)
            servo.store("Protection_Current", 500)
            servo.store("Overload_Torque", 80)
            servo.store("Maximum_Acceleration", 50)
            # the RAM after power-up: no torque, and a goal of 0 until one is written
            servo.store("Torque_Limit", 1000)
            servo.store("Present_Position", RESTING_POSITIONS[name])
            servo.store("Present_Voltage", 120)
            servo.store("Present_Temperature", 30)
            self.servos[servo_id] = servo
            self.names[name] = servo_id
        self.clear_faults()

    def clear_faults(self) -> None:
        self.absent: set[int] = set()  # servos that are not there
        self.drop: set[int] = set()  # which reply packets of the step are lost, counted from 0
        self.corrupt: set[int] = set()  # which arrive with a wrong checksum
        self.truncate: dict[int, int] = {}  # which lose that many last bytes
        self.noise: dict[int, bytes] = {}  # bytes on the line before a reply packet
        self.echo = False  # the adapter gives the host its own packet back
        self.miss_sync_write: set[int] = set()  # servos that miss the step's first sync write
        self.reply_count = 0

    def poke(self, name: str, register: str, value: int) -> None:
        self.servos[self.names[name]].store(register, value)

    def dump(self) -> dict[str, list[int]]:
        return {str(servo_id): list(servo.registers) for servo_id, servo in self.servos.items()}

    def respond(self, data: bytes) -> bytes:
        servo_id, instruction, parameters = data[2], data[4], data[5:-1]
        replies: list[bytes] = []
        if instruction == sdk.INST_PING:
            if servo := self.present(servo_id):
                replies.append(self.status(servo, b""))
        elif instruction == sdk.INST_READ:
            address, length = parameters
            if (servo := self.present(servo_id)) and address + length <= REGISTER_BYTES:
                replies.append(self.status(servo, servo.registers[address : address + length]))
        elif instruction == sdk.INST_WRITE:
            if servo := self.present(servo_id):
                servo.registers[parameters[0] : parameters[0] + len(parameters) - 1] = parameters[1:]
                servo.settle()
                replies.append(self.status(servo, b""))
        elif instruction == sdk.INST_SYNC_READ:
            address, length = parameters[0], parameters[1]
            for each_id in parameters[2:]:
                if servo := self.present(each_id):
                    replies.append(self.status(servo, servo.registers[address : address + length]))
        elif instruction == sdk.INST_SYNC_WRITE:
            address, length = parameters[0], parameters[1]
            missing, self.miss_sync_write = self.miss_sync_write, set()
            for start in range(2, len(parameters), length + 1):
                servo = self.present(parameters[start])
                if servo is not None and servo.id not in missing:
                    servo.registers[address : address + length] = parameters[start + 1 : start + 1 + length]
                    servo.settle()

        stream = bytearray(data if self.echo else b"")
        for reply in replies:
            index, self.reply_count = self.reply_count, self.reply_count + 1
            stream += self.noise.get(index, b"")
            if index in self.drop:
                continue
            if index in self.corrupt:
                reply = reply[:-1] + bytes([reply[-1] ^ 0xFF])
            if index in self.truncate:
                reply = reply[: -self.truncate[index]]
            stream += reply
        return bytes(stream)

    def present(self, servo_id: int) -> FakeServo | None:
        return None if servo_id in self.absent else self.servos.get(servo_id)

    @staticmethod
    def status(servo: FakeServo, parameters: Any) -> bytes:
        # a servo reports its Status register in the error byte of every status packet
        return status_packet(servo.id, servo.load("Status"), parameters)


def calibration_of(entries: dict[str, tuple[int, int, int, int, int]]) -> dict[str, MotorCalibration]:
    return {
        name: MotorCalibration(
            id=servo_id, drive_mode=drive_mode, homing_offset=homing_offset, range_min=range_min, range_max=range_max
        )
        for name, (servo_id, drive_mode, homing_offset, range_min, range_max) in entries.items()
    }


def calibration_json(calibration: dict[str, MotorCalibration]) -> dict[str, dict[str, int]]:
    return {name: asdict(entry) for name, entry in calibration.items()}


def error_of(error: BaseException) -> dict[str, str]:
    return {"type": type(error).__name__, "message": str(error)}


def sdk_port() -> Any:
    """Returns one of the SDK's port handlers, open on the fake serial port, with lerobot's packet timeout."""
    port = scs.PortHandler(PORT_NAME)
    port.setPacketTimeout = lerobot_feetech.patch_setPacketTimeout.__get__(port, scs.PortHandler)
    port.openPort()
    return port


def tables() -> dict[str, Any]:
    handler = scs.PacketHandler(lerobot_feetech.DEFAULT_PROTOCOL_VERSION)
    constants = (
        "BROADCAST_ID MAX_ID INST_PING INST_READ INST_WRITE INST_REG_WRITE INST_ACTION INST_SYNC_WRITE INST_SYNC_READ "
        "COMM_SUCCESS COMM_PORT_BUSY COMM_TX_FAIL COMM_RX_FAIL COMM_TX_ERROR COMM_RX_WAITING COMM_RX_TIMEOUT "
        "COMM_RX_CORRUPT COMM_NOT_AVAILABLE TXPACKET_MAX_LEN RXPACKET_MAX_LEN PKT_HEADER0 PKT_HEADER1 PKT_ID "
        "PKT_LENGTH PKT_INSTRUCTION PKT_ERROR PKT_PARAMETER0 ERRBIT_VOLTAGE ERRBIT_ANGLE ERRBIT_OVERHEAT "
        "ERRBIT_OVERELE ERRBIT_OVERLOAD"
    ).split()
    port = sdk_port()
    timeouts = []
    for packet_length in (6, 7, 8, 10, 48, 250):
        port.setPacketTimeout(packet_length)
        timeouts.append([packet_length, port.packet_timeout])
    port.closePort()

    return {
        "lerobot_version": lerobot.__version__,
        "sdk_version": importlib.metadata.version("feetech-servo-sdk"),
        "model": MODEL,
        "control_table": {name: list(entry) for name, entry in TABLE.items()},
        "encoding_table": SIGN_BITS,
        "baudrate_table": {str(baudrate): value for baudrate, value in lerobot_tables.MODEL_BAUDRATE_TABLE[MODEL].items()},
        "resolution": lerobot_tables.MODEL_RESOLUTION[MODEL],
        "model_number": lerobot_tables.MODEL_NUMBER_TABLE[MODEL],
        "protocol": lerobot_tables.MODEL_PROTOCOL[MODEL],
        "firmware_major_version": list(lerobot_tables.FIRMWARE_MAJOR_VERSION),
        "firmware_minor_version": list(lerobot_tables.FIRMWARE_MINOR_VERSION),
        "model_number_register": list(lerobot_tables.MODEL_NUMBER),
        "scan_baudrates": lerobot_tables.SCAN_BAUDRATES,
        "default_baudrate": lerobot_feetech.DEFAULT_BAUDRATE,
        "default_timeout_ms": lerobot_feetech.DEFAULT_TIMEOUT_MS,
        "normalized_data": lerobot_feetech.NORMALIZED_DATA,
        "operating_mode": {mode.name: mode.value for mode in lerobot_feetech.OperatingMode},
        "torque_mode": {mode.name: mode.value for mode in lerobot_feetech.TorqueMode},
        "drive_mode": {mode.name: mode.value for mode in lerobot_feetech.DriveMode},
        "sdk": {name: getattr(sdk, name) for name in constants},
        "tx_rx_result": [[code, handler.getTxRxResult(code)] for code in range(-10, 2)],
        "rx_packet_error": [handler.getRxPacketError(error) for error in range(256)],
        "packet_timeout_ms": timeouts,  # lerobot's timeout of a status packet of that many bytes, at 1 Mbaud
    }


def packets() -> dict[str, Any]:
    """Instruction packets as the SDK builds them, and lerobot's byte order and sign encoding of register values."""
    rng = random.Random(SEED)
    handler = scs.PacketHandler(lerobot_feetech.DEFAULT_PROTOCOL_VERSION)
    port = sdk_port()
    LINK.responder = None
    cases: list[dict[str, Any]] = []

    def record(kind: str, arguments: dict[str, Any], result: int) -> None:
        exchanges = LINK.take()
        cases.append(
            {"kind": kind, "args": arguments, "result": result, "packet": exchanges[0]["tx"] if exchanges else None}
        )
        port.is_using = False

    for servo_id in [0, 1, 6, 253, 254, 255, *(rng.randrange(254) for _ in range(12))]:
        _, result, _ = handler.ping(port, servo_id)  # nothing answers: the packet is what matters
        record("ping", {"id": servo_id}, result)
    for _ in range(60):
        arguments = {"id": rng.randrange(254), "address": rng.randrange(256), "length": rng.randrange(256)}
        record("read", arguments, handler.readTx(port, arguments["id"], arguments["address"], arguments["length"]))
    for servo_id in (254, 255):
        record("read", {"id": servo_id, "address": 56, "length": 2}, handler.readTx(port, servo_id, 56, 2))
    for _ in range(60):
        data = [rng.randrange(256) for _ in range(rng.choice([1, 1, 2, 2, 2, 4, 3, 8]))]
        arguments = {"id": rng.randrange(255), "address": rng.randrange(256), "data": data}
        result = handler.writeTxOnly(port, arguments["id"], arguments["address"], len(data), data)
        record("write", arguments, result)
    for count in [0, 1, 6, 6, 40, *(rng.randrange(1, 21) for _ in range(30))]:
        ids = rng.sample(range(254), count)
        if count == 6:
            ids = [*ids, ids[0], ids[3]]  # an id given twice is asked once
        arguments = {"address": rng.randrange(256), "length": rng.choice([1, 2, 2, 4]), "ids": ids}
        group = scs.GroupSyncRead(port, handler, arguments["address"], arguments["length"])
        for servo_id in ids:
            group.addParam(servo_id)
        record("sync_read", arguments, group.txPacket())
    for count in [0, 1, 6, 6, 90, *(rng.randrange(1, 13) for _ in range(30))]:
        length = 2 if count == 90 else rng.choice([1, 2, 2, 4])  # 90 two-byte values do not fit a packet
        values = [[servo_id, [rng.randrange(256) for _ in range(length)]] for servo_id in rng.sample(range(254), count)]
        if count == 6:
            values.append([values[2][0], [0] * length])  # an id given twice keeps its first value
        arguments = {"address": rng.randrange(256), "length": length, "values": values}
        group = scs.GroupSyncWrite(port, handler, arguments["address"], length)
        for servo_id, data in values:
            group.addParam(servo_id, data)
        record("sync_write", arguments, group.txPacket())
    port.closePort()

    bus = FeetechMotorsBus(port=PORT_NAME, motors={})
    serialized = []
    for length, limit in ((1, 0xFF), (2, 0xFFFF), (4, 0xFFFFFFFF)):
        for value in [0, 1, limit, limit + 1, -1, *(rng.randrange(limit + 1) for _ in range(12))]:
            try:
                serialized.append({"value": value, "length": length, "bytes": bus._serialize_data(value, length)})
            except ValueError as error:
                serialized.append({"value": value, "length": length, "error": error_of(error)})
    try:
        bus._serialize_data(1, 3)
    except NotImplementedError as error:
        serialized.append({"value": 1, "length": 3, "error": error_of(error)})

    encoded, decoded = [], []
    for sign_bit in sorted(set(SIGN_BITS.values())):
        limit = (1 << sign_bit) - 1
        for value in [0, 1, -1, limit, -limit, limit + 1, -limit - 1, *(rng.randint(-limit, limit) for _ in range(20))]:
            try:
                encoded.append({"value": value, "sign_bit": sign_bit, "encoded": encode_sign_magnitude(value, sign_bit)})
            except ValueError as error:
                encoded.append({"value": value, "sign_bit": sign_bit, "error": error_of(error)})
        for value in [0, limit, limit + 1, 0xFFFF, *(rng.randrange(0x10000) for _ in range(20))]:
            decoded.append({"encoded": value, "sign_bit": sign_bit, "value": decode_sign_magnitude(value, sign_bit)})

    return {"instructions": cases, "serialized": serialized, "sign_encoded": encoded, "sign_decoded": decoded}


def status_streams() -> dict[str, Any]:
    """Byte streams as a port may deliver them, and what each call of the SDK's rxPacket makes of them, until a call
    finds nothing."""
    rng = random.Random(SEED + 1)
    handler = scs.PacketHandler(lerobot_feetech.DEFAULT_PROTOCOL_VERSION)
    port = sdk_port()
    LINK.responder = None

    def instruction(build: Any) -> bytes:
        """Returns the packet the SDK sends for ``build``, as an echoing adapter would hand it back."""
        build()
        port.is_using = False
        return bytes(LINK.take()[0]["tx"])

    def results_of(stream: bytes) -> list[dict[str, Any]]:
        LINK.rx.clear()
        LINK.rx += stream
        results = []
        while True:
            port.setPacketTimeoutMillis(10)
            packet, result = handler.rxPacket(port)
            results.append({"packet": list(packet), "result": result})
            if result == sdk.COMM_RX_TIMEOUT:
                return results

    def random_packet() -> bytes:
        parameters = [rng.choice([0xFF, 0x00, rng.randrange(256)]) for _ in range(rng.choice([0, 0, 1, 2, 2, 4, 9]))]
        return status_packet(rng.choice([1, 2, 6, 253, rng.randrange(254)]), rng.choice([0, 0, 0x20, 0x7F]), parameters)

    def random_segment() -> bytes:
        kind = rng.randrange(10)
        packet = bytearray(random_packet())
        if kind < 4:
            return bytes(packet)
        if kind == 4:  # a wrong checksum
            packet[-1] ^= 1 << rng.randrange(8)
        elif kind == 5:  # cut short
            del packet[rng.randrange(1, len(packet)) :]
        elif kind == 6:  # a field out of range: the id, the length or the error
            index, value = rng.choice([(2, 0xFE), (2, 0xFF), (3, 251), (3, 0xFF), (4, 0x80), (4, 0xFF)])
            packet[index] = value
        elif kind == 7:  # noise
            return bytes(rng.choice([0xFF, 0xFF, 0x00, rng.randrange(256)]) for _ in range(rng.randrange(1, 9)))
        elif kind == 8:  # a length that is too short for a status packet
            packet[3] = rng.randrange(2)
        else:  # an instruction packet echoed
            return rng.choice(echoes)
        return bytes(packet)

    echoes = [
        instruction(lambda: handler.ping(port, 3)),
        instruction(lambda: handler.readTx(port, 3, 56, 2)),
        instruction(lambda: handler.writeTxOnly(port, 3, 42, 2, [0xFF, 0x07])),
        instruction(lambda: handler.syncReadTx(port, 56, 2, [1, 2, 3, 4, 5, 6], 6)),
        instruction(lambda: handler.syncWriteTxOnly(port, 42, 2, [1, 0xFF, 0x07, 2, 0x00, 0x08], 6)),
    ]
    reply = status_packet(3, 0, [0x34, 0x08])
    named = {
        "nothing": b"",
        "a packet without parameters": status_packet(1, 0, []),
        "a packet with two parameters": reply,
        "a packet with an error": status_packet(6, 0x28, [1]),
        "two packets back to back": status_packet(1, 0, [1, 2]) + status_packet(2, 0, [3, 4]),
        "six packets back to back": b"".join(status_packet(servo_id, 0, [servo_id, 8]) for servo_id in range(1, 7)),
        "noise before a packet": bytes([0x00, 0x12]) + reply,
        "one FF before a packet": bytes([0xFF]) + reply,
        "FF FF FF before a packet": bytes([0xFF, 0xFF, 0xFF]) + reply,
        "seven bytes of noise before a packet": bytes([1, 2, 3, 4, 5, 6, 7]) + reply,
        "noise only": bytes([1, 2, 3, 4, 5, 6, 7, 8, 9]),
        "a wrong checksum": reply[:-1] + bytes([reply[-1] ^ 0x01]),
        "a wrong checksum, then a packet": reply[:-1] + bytes([reply[-1] ^ 0x01]) + reply,
        "a packet cut short": reply[:-2],
        "a header alone": bytes([0xFF, 0xFF]),
        "the broadcast id": status_packet(0xFE, 0, [1, 2]),
        "an error byte above 0x7F": status_packet(1, 0x80, [1, 2]),
        "a length above 250": bytes([0xFF, 0xFF, 1, 251, 0, 0, 0, 0]),
        "a length of zero": bytes([0xFF, 0xFF, 1, 0, 0, 0xFE]) + reply,
        "a length of one": bytes([0xFF, 0xFF, 1, 1, 0xFD, 0]) + reply,
        "the echo of a ping, then its reply": echoes[0] + status_packet(3, 0, []),
        "the echo of a read, then its reply": echoes[1] + reply,
        "the echo of a write, then its reply": echoes[2] + status_packet(3, 0, []),
        "the echo of a sync read, then its replies": echoes[3]
        + b"".join(status_packet(servo_id, 0, [servo_id, 8]) for servo_id in range(1, 7)),
        "the echo of a sync write": echoes[4],
    }
    cases = [{"name": name, "stream": list(stream), "results": results_of(stream)} for name, stream in named.items()]
    for index in range(160):
        stream = b"".join(random_segment() for _ in range(rng.randrange(1, 6)))
        cases.append({"name": f"random {index}", "stream": list(stream), "results": results_of(stream)})
    port.closePort()

    return {"streams": cases}


def make_follower(directory: Path, calibration: dict[str, MotorCalibration] | None) -> Any:
    """Returns lerobot's SO-101 follower as PEAR makes it, with ``calibration`` as its calibration file."""
    hardware_config = HardwareConfig(
        port=PORT_NAME,
        calibration_id=CALIBRATION_ID,
        calibration_dir=directory,
        joint_offsets=[0.0] * len(JOINTS),
        status_poll_ticks=10,
        position_p_coefficient=16,
    )
    calibration_file = directory / f"{CALIBRATION_ID}.json"
    calibration_file.unlink(missing_ok=True)
    if calibration is not None:
        writer = StartupChecks.make_follower(hardware_config)
        writer.calibration = calibration
        writer._save_calibration()

    return StartupChecks.make_follower(hardware_config)


BUS_OPERATIONS = {
    "connect": lambda bus, handshake=True: bus.connect(handshake),
    "disconnect": lambda bus, disable_torque=True: bus.disconnect(disable_torque),
    "ping": lambda bus, motor, num_retry=0, raise_on_error=False: bus.ping(motor, num_retry, raise_on_error),
    "read": lambda bus, data_name, motor, normalize=True, num_retry=0: bus.read(
        data_name, motor, normalize=normalize, num_retry=num_retry
    ),
    "write": lambda bus, data_name, motor, value, normalize=True, num_retry=0: bus.write(
        data_name, motor, value, normalize=normalize, num_retry=num_retry
    ),
    "sync_read": lambda bus, data_name, motors=None, normalize=True, num_retry=0: bus.sync_read(
        data_name, motors, normalize=normalize, num_retry=num_retry
    ),
    "sync_write": lambda bus, data_name, values, normalize=True, num_retry=0: bus.sync_write(
        data_name, values, normalize=normalize, num_retry=num_retry
    ),
    "enable_torque": lambda bus, motors=None, num_retry=0: bus.enable_torque(motors, num_retry),
    "disable_torque": lambda bus, motors=None, num_retry=0: bus.disable_torque(motors, num_retry),
    "configure_motors": lambda bus: bus.configure_motors(),
    "read_calibration": lambda bus: calibration_json(bus.read_calibration()),
    "write_calibration": lambda bus, calibration, cache=True: bus.write_calibration(
        {name: MotorCalibration(**entry) for name, entry in calibration.items()}, cache
    ),
    "is_calibrated": lambda bus: bus.is_calibrated,
}


class Scenario:
    """A sequence of operations on one bus and one chain of servos, each recorded with its traffic."""

    def __init__(self, name: str, chain: FakeChain) -> None:
        self.name = name
        self.chain = chain
        self.steps: list[dict[str, Any]] = []
        LINK.responder = chain.respond
        LINK.take()

    def poke(self, name: str, register: str, value: int) -> None:
        """Changes a servo's register behind the bus's back, as the world does."""
        self.chain.poke(name, register, value)
        self.steps.append({"op": "poke", "args": {"id": self.chain.names[name], "register": register, "value": value}})

    def run(self, operation: str, call: Any, arguments: dict[str, Any] | None = None, **faults: Any) -> Any:
        """Runs ``call`` under ``faults`` and records what it returned or raised, with the packets exchanged."""
        for fault, value in faults.items():
            setattr(self.chain, fault, value)
        step: dict[str, Any] = {"op": operation, "args": arguments or {}}
        result = None
        try:
            result = call()
            step["result"] = result
        except Exception as error:  # every failure is a result of the reference
            step["error"] = error_of(error)
        step["exchanges"] = LINK.take()
        if faults:
            step["faults"] = sorted(faults)
        self.chain.clear_faults()
        self.steps.append(step)
        return result


def bus_scenarios(directory: Path) -> dict[str, Any]:
    """Operations of lerobot's bus on the simulated chain, good and bad, each with the packets it exchanged."""
    calibration = calibration_of(ARM_CALIBRATION)
    scenarios = []

    def new_scenario(name: str) -> tuple[Scenario, Any]:
        scenario = Scenario(name, FakeChain(ARM_CALIBRATION))
        bus = make_follower(directory, calibration).bus
        scenarios.append((scenario, bus))
        return scenario, bus

    def bus_step(scenario: Scenario, bus: Any, operation: str, arguments: dict[str, Any] | None = None, **faults: Any) -> Any:
        return scenario.run(operation, lambda: BUS_OPERATIONS[operation](bus, **(arguments or {})), arguments, **faults)

    scenario, bus = new_scenario("operations")

    def step(operation: str, arguments: dict[str, Any] | None = None, **faults: Any) -> Any:
        return bus_step(scenario, bus, operation, arguments, **faults)

    step("connect", {"handshake": True})

    step("ping", {"motor": "shoulder_pan"})
    step("ping", {"motor": 6})
    step("ping", {"motor": "elbow_flex"}, absent={3})
    step("ping", {"motor": "elbow_flex", "num_retry": 2, "raise_on_error": True}, absent={3})
    step("ping", {"motor": "elbow_flex", "num_retry": 1}, drop={0})
    step("ping", {"motor": "elbow_flex", "num_retry": 1}, drop={1})  # the model number's read is lost
    step("ping", {"motor": "elbow_flex"}, corrupt={0})
    scenario.poke("wrist_flex", "Status", 0x04)
    step("ping", {"motor": "wrist_flex"})
    step("ping", {"motor": "wrist_flex", "raise_on_error": True})
    scenario.poke("wrist_flex", "Status", 0)

    scenario.poke("shoulder_lift", "Present_Load", 0x400 | 123)
    scenario.poke("shoulder_lift", "Present_Velocity", 0x8000 | 55)
    scenario.poke("gripper", "Present_Load", 77)
    for data_name in (
        "Present_Position",
        "Goal_Position",
        "Homing_Offset",
        "Min_Position_Limit",
        "Max_Position_Limit",
        "Present_Load",
        "Present_Velocity",
        "Torque_Enable",
        "Status",
        "Present_Voltage",
        "Phase",
        "Model_Number",
        "Firmware_Minor_Version",
    ):
        for motor in ("shoulder_lift", "gripper"):
            step("read", {"data_name": data_name, "motor": motor})
            step("read", {"data_name": data_name, "motor": motor, "normalize": False})
    scenario.poke("elbow_flex", "Present_Position", 0x8000 | 12)  # a position below zero
    step("read", {"data_name": "Present_Position", "motor": "elbow_flex"})
    step("read", {"data_name": "Present_Position", "motor": "elbow_flex", "normalize": False})
    scenario.poke("elbow_flex", "Present_Position", RESTING_POSITIONS["elbow_flex"])

    position = {"data_name": "Present_Position", "motor": "wrist_roll", "normalize": False}
    step("read", position, drop={0})
    step("read", {**position, "num_retry": 1}, drop={0})
    step("read", {**position, "num_retry": 2}, drop={0, 1, 2})
    step("read", position, corrupt={0})
    step("read", {**position, "num_retry": 2}, corrupt={0, 1})
    step("read", position, truncate={0: 2})
    step("read", {**position, "num_retry": 1}, truncate={0: 1})
    step("read", position, noise={0: bytes([0x00, 0x7E, 0xFF])})
    step("read", position, noise={0: status_packet(2, 0, [9, 9])})  # another servo's late reply comes first
    step("read", position, absent={5})
    step("read", position, echo=True)  # the echo is taken for the status packet
    step("read", position)  # and the reply it left behind for this one's
    step("read", position)
    scenario.poke("wrist_roll", "Status", 0x21)
    step("read", position)
    step("read", {"data_name": "Status", "motor": "wrist_roll"})
    scenario.poke("wrist_roll", "Status", 0)

    step("write", {"data_name": "P_Coefficient", "motor": "shoulder_pan", "value": 16})
    step("write", {"data_name": "Max_Torque_Limit", "motor": "gripper", "value": 500})
    step("write", {"data_name": "Homing_Offset", "motor": "elbow_flex", "value": -100})
    step("write", {"data_name": "Homing_Offset", "motor": "elbow_flex", "value": -7})
    step("write", {"data_name": "Homing_Offset", "motor": "elbow_flex", "value": 3000})
    step("write", {"data_name": "Acceleration", "motor": "elbow_flex", "value": 300})
    step("write", {"data_name": "Acceleration", "motor": "elbow_flex", "value": -1})
    step("write", {"data_name": "Acceleration", "motor": "elbow_flex", "value": 253.9})
    step("write", {"data_name": "Goal_Position", "motor": "shoulder_lift", "value": 12.5})
    step("write", {"data_name": "Goal_Position", "motor": "shoulder_lift", "value": -200.0})
    step("write", {"data_name": "Goal_Position", "motor": "gripper", "value": 37.5})
    step("write", {"data_name": "Goal_Position", "motor": "gripper", "value": 250})
    step("write", {"data_name": "Goal_Position", "motor": "wrist_flex", "value": 2047, "normalize": False})
    step("write", {"data_name": "Goal_Position", "motor": "wrist_flex", "value": -5, "normalize": False})
    goal = {"data_name": "Goal_Position", "motor": "wrist_roll", "value": 2000, "normalize": False}
    step("write", goal, drop={0})
    step("write", {**goal, "num_retry": 1}, drop={0})
    step("write", {**goal, "num_retry": 1}, corrupt={0, 1})
    step("write", goal, echo=True)
    step("read", {"data_name": "Goal_Position", "motor": "wrist_roll", "normalize": False})
    scenario.poke("wrist_roll", "Status", 0x08)
    step("write", goal)
    scenario.poke("wrist_roll", "Status", 0)

    step("enable_torque")
    for data_name in ("Present_Position", "Goal_Position"):
        step("sync_read", {"data_name": data_name})
        step("sync_read", {"data_name": data_name, "normalize": False})
    step("sync_read", {"data_name": "Present_Position", "motors": ["gripper", "shoulder_pan"]})
    step("sync_read", {"data_name": "Present_Position", "motors": "elbow_flex"})
    step("sync_read", {"data_name": "Torque_Enable", "normalize": False})
    step("sync_read", {"data_name": "Status", "normalize": False})
    step("sync_read", {"data_name": "Present_Temperature"})
    step("sync_read", {"data_name": "Present_Load", "normalize": False})
    positions = {"data_name": "Present_Position", "normalize": False}
    step("sync_read", positions, drop={0})
    step("sync_read", positions, drop={3})
    step("sync_read", {**positions, "num_retry": 1}, drop={3})
    step("sync_read", {**positions, "num_retry": 1}, corrupt={2})
    step("sync_read", {**positions, "num_retry": 2}, corrupt={5, 6})
    step("sync_read", {**positions, "num_retry": 1}, truncate={5: 3})
    step("sync_read", {**positions, "num_retry": 2}, absent={5})
    step("sync_read", positions, noise={0: bytes([0xFF, 0x00, 0x55]), 4: bytes([0xFF])})
    step("sync_read", positions, echo=True)  # a broadcast packet's echo is skipped
    step("sync_read", positions, drop={1}, echo=True)
    scenario.poke("gripper", "Status", 0x28)
    step("sync_read", positions)  # a sync read does not look at the error byte
    step("sync_read", {"data_name": "Status", "normalize": False})
    scenario.poke("gripper", "Status", 0)
    step("sync_read", {"data_name": "Present_Position", "motors": []})

    degrees = {"shoulder_pan": 10.0, "shoulder_lift": -45.5, "elbow_flex": 90.25, "wrist_flex": -0.0, "wrist_roll": 179.9}
    step("sync_write", {"data_name": "Goal_Position", "values": {**degrees, "gripper": 50.0}})
    step("sync_read", {"data_name": "Present_Position"})
    step("sync_write", {"data_name": "Goal_Position", "values": {**degrees, "gripper": 50.0}, "num_retry": 1})
    step("sync_write", {"data_name": "Goal_Position", "values": {"gripper": 120.0, "wrist_roll": -400.0}})
    step("sync_read", {"data_name": "Present_Position"})
    raw = {"shoulder_pan": 2047, "shoulder_lift": 1000, "elbow_flex": 3000, "wrist_flex": 2047, "wrist_roll": 4095}
    step("sync_write", {"data_name": "Goal_Position", "values": {**raw, "gripper": 2100}, "normalize": False})
    step("sync_read", {"data_name": "Goal_Position", "normalize": False})
    step("sync_write", {"data_name": "Goal_Position", "values": {"wrist_roll": -17, "gripper": 2050.7}, "normalize": False})
    step("sync_write", {"data_name": "Goal_Position", "values": 2047, "normalize": False})
    step("sync_write", {"data_name": "Acceleration", "values": 254})
    step("sync_write", {"data_name": "P_Coefficient", "values": {"elbow_flex": 16, "gripper": 12}})
    step("sync_write", {"data_name": "Acceleration", "values": 256})
    step("sync_write", {"data_name": "Goal_Position", "values": 40000, "normalize": False})
    step("sync_write", {"data_name": "Goal_Position", "values": {}})

    step("disable_torque", {"motors": "gripper"})
    step("disable_torque", {"motors": ["shoulder_pan", "elbow_flex"], "num_retry": 1})
    step("disable_torque", {"motors": ["wrist_flex"], "num_retry": 1}, drop={0, 2})
    step("enable_torque", {"motors": "gripper", "num_retry": 2}, drop={0})
    step("disable_torque", {"num_retry": 0}, absent={4})
    step("disable_torque")
    step("configure_motors")
    step("configure_motors")  # the Phase bit is clear now: no second write
    step("enable_torque")

    step("read_calibration")
    step("is_calibrated")
    changed = {**ARM_CALIBRATION, "shoulder_lift": (2, 0, -1200, 900, 3200), "gripper": (6, 1, 5, 2000, 3500)}
    step("write_calibration", {"calibration": calibration_json(calibration_of(changed)), "cache": False})
    step("is_calibrated")
    step("write_calibration", {"calibration": calibration_json(calibration_of(changed))})
    step("is_calibrated")
    step("read_calibration")
    step("sync_read", {"data_name": "Present_Position"})  # the gripper's drive mode is inverted now
    step("sync_write", {"data_name": "Goal_Position", "values": {"gripper": 30.0}})
    scenario.poke("wrist_flex", "Max_Position_Limit", 3189)
    step("is_calibrated")
    step("connect")  # already connected
    step("disconnect", {"disable_torque": True})
    step("read", {"data_name": "Present_Position", "motor": "gripper"})  # not connected

    for name, prepare, faults in (
        ("connect without a handshake", None, {}),
        ("connect with a servo missing", None, {"absent": {3}}),
        ("connect with a servo reporting an error", lambda each: each.poke("elbow_flex", "Status", 0x20), {}),
        ("connect with a servo of another model", lambda each: each.poke("shoulder_lift", "Model_Number", 2825), {}),
        ("connect with another firmware", lambda each: each.poke("wrist_roll", "Firmware_Minor_Version", 9), {}),
        ("connect with a firmware read lost", None, {"drop": {12}}),
    ):
        scenario, bus = new_scenario(name)
        if prepare is not None:
            prepare(scenario)
        bus_step(scenario, bus, "connect", {"handshake": name != "connect without a handshake"}, **faults)
        bus_step(scenario, bus, "disconnect", {"disable_torque": False})

    scenario, bus = new_scenario("no calibration")
    bus.calibration = {}
    bus_step(scenario, bus, "connect", {"handshake": False})
    bus_step(scenario, bus, "read", {"data_name": "Present_Position", "motor": "gripper", "normalize": False})
    bus_step(scenario, bus, "read", {"data_name": "Present_Position", "motor": "gripper"})
    bus_step(scenario, bus, "is_calibrated")
    bus_step(scenario, bus, "disconnect", {"disable_torque": False})

    for _, bus in scenarios:  # so that no follower's destructor finds an open port
        if bus.is_connected:
            bus.port_handler.closePort()

    return {
        "port": PORT_NAME,
        "calibration": calibration_json(calibration),
        "scenarios": [{"name": scenario.name, "steps": scenario.steps} for scenario, _ in scenarios],
    }


def normalization() -> dict[str, Any]:
    """Raw positions to lerobot's degrees and percent to PEAR's joint vector, and joint vectors back to the goals
    PEAR's SO101Hardware.send() gives the bus and the packet they become."""
    rng = random.Random(SEED + 2)
    motors = make_motors()
    calibrations = {
        "a calibrated arm": (ARM_CALIBRATION, [0.0] * 5),
        "joint offsets": (ARM_CALIBRATION, [0.01, -0.02, 0.15, -0.2, 0.0031]),
        "odd ranges, so that their middle is a half step": (
            {
                "shoulder_pan": (1, 0, 0, 740, 3353),
                "shoulder_lift": (2, 0, 0, 1, 4094),
                "elbow_flex": (3, 0, 0, 1000, 1001),
                "wrist_flex": (4, 0, 0, 0, 4095),
                "wrist_roll": (5, 0, 0, 0, 4095),
                "gripper": (6, 0, 0, 2031, 3478),
            },
            [0.0] * 5,
        ),
        "inverted drive modes": (
            {name: (entry[0], 1, *entry[2:]) for name, entry in ARM_CALIBRATION.items()},
            [0.0] * 5,
        ),
        "a narrow gripper": ({**ARM_CALIBRATION, "gripper": (6, 0, 0, 2000, 2003)}, [0.0] * 5),
    }

    cases = []
    for name, (entries, joint_offsets) in calibrations.items():
        calibration = calibration_of(entries)
        bus = FeetechMotorsBus(port=PORT_NAME, motors=motors, calibration=calibration)
        bus.port_handler.openPort()
        LINK.responder = None
        hardware = object.__new__(SO101Hardware)  # only what send() reads; nothing is opened
        hardware.is_closed = False
        hardware.joint_offsets = np.array(joint_offsets, dtype=float)
        hardware.follower = types.SimpleNamespace(bus=bus)
        goals: dict[str, float] = {}
        bus_sync_write = bus.sync_write

        def noting_sync_write(data_name: str, values: Any, **keywords: Any) -> None:
            goals.clear()
            goals.update(values)
            bus_sync_write(data_name, values, **keywords)

        bus.sync_write = noting_sync_write

        readings = []
        for index in range(16):
            raw = {
                motor: rng.randint(-50, 4200) if index % 8 == 7 else rng.randint(entries[motor][3], entries[motor][4])
                for motor in MOTORS
            }
            if index < 2:  # the two ends of every range
                raw = {motor: entries[motor][3 + index] for motor in MOTORS}
            normalized = bus._normalize({bus.motors[motor].id: value for motor, value in raw.items()})
            values = {bus._id_to_name(servo_id): value for servo_id, value in normalized.items()}
            position = SO101Hardware.bus_position(values, hardware.joint_offsets)
            readings.append({"raw": raw, "normalized": values, "position": position.tolist()})

        commands = []
        for index in range(16):
            wide = index % 8 == 7  # past the ranges, where the gripper is clamped and the joints are not
            target = [rng.uniform(-3.3, 3.3) if wide else rng.uniform(-1.9, 1.9) for _ in JOINTS]
            target.append(rng.uniform(-0.3, 1.3) if wide else rng.random())
            if index < 2:
                target = [0.0] * 5 + [float(index)]
            LINK.take()
            command: dict[str, Any] = {"target": target}
            try:
                hardware.send(target)
                raw_goals = bus._unnormalize({bus.motors[motor].id: value for motor, value in goals.items()})
                command["goal"] = dict(goals)
                command["raw"] = {bus._id_to_name(servo_id): value for servo_id, value in raw_goals.items()}
                command["packet"] = LINK.take()[0]["tx"]
            except Exception as error:
                command["error"] = error_of(error)
            commands.append(command)
        for target in ([0.0] * 5, [0.0] * 7):
            try:
                hardware.send(target)
            except ValueError as error:
                commands.append({"target": target, "error": error_of(error)})
        bus.port_handler.closePort()

        cases.append(
            {
                "name": name,
                "calibration": calibration_json(calibration),
                "joint_offsets": joint_offsets,
                "readings": readings,
                "commands": commands,
            }
        )

    # the joints from -100 to 100, as lerobot reads them when use_degrees is off
    percent_motors = {
        name: Motor(motor.id, motor.model, motor.norm_mode if name == "gripper" else MotorNormMode.RANGE_M100_100)
        for name, motor in motors.items()
    }
    percent_cases = []
    for name in ("a calibrated arm", "inverted drive modes"):
        entries, _ = calibrations[name]
        bus = FeetechMotorsBus(port=PORT_NAME, motors=percent_motors, calibration=calibration_of(entries))
        rows = []
        for index in range(20):
            raw = {
                motor: rng.randint(-50, 4200) if index % 4 == 3 else rng.randint(entries[motor][3], entries[motor][4])
                for motor in MOTORS
            }
            values = {motor: rng.uniform(-130.0, 130.0) for motor in MOTORS}
            normalized = bus._normalize({bus.motors[motor].id: value for motor, value in raw.items()})
            unnormalized = bus._unnormalize({bus.motors[motor].id: value for motor, value in values.items()})
            rows.append(
                {
                    "raw": raw,
                    "normalized": {bus._id_to_name(servo_id): value for servo_id, value in normalized.items()},
                    "values": values,
                    "unnormalized": {bus._id_to_name(servo_id): value for servo_id, value in unnormalized.items()},
                }
            )
        percent_cases.append({"name": name, "calibration": calibration_json(calibration_of(entries)), "rows": rows})

    # a range of no width is refused in both directions
    entries = {**ARM_CALIBRATION, "gripper": (6, 0, 0, 2000, 2000)}
    bus = FeetechMotorsBus(port=PORT_NAME, motors=motors, calibration=calibration_of(entries))
    invalid = {"calibration": calibration_json(calibration_of(entries))}
    for direction, convert in (("normalize", bus._normalize), ("unnormalize", bus._unnormalize)):
        try:
            convert({6: 2000})
        except ValueError as error:
            invalid[direction] = error_of(error)

    return {
        "joints": list(JOINTS),
        "motors": list(MOTORS),
        "cases": cases,
        "range_m100_100": percent_cases,
        "invalid": invalid,
    }


def make_motors() -> dict[str, Any]:
    """Returns the SO-101's motors as lerobot's follower declares them, read from a follower that opens nothing."""
    with tempfile.TemporaryDirectory() as directory:
        return make_follower(Path(directory), None).bus.motors


def arm_state_json(state: Any) -> dict[str, Any]:
    reading = {
        "position": list(state.position),
        "velocity": list(state.velocity),
        "sampled_monotonic_s": state.sampled_monotonic_s,
        "sample_id": state.sample_id,
        "servo_status": state.servo_status,
    }
    if state.sample_id % FEEDBACK_EVERY == 1:  # it repeats the reading: a few are enough
        reading["feedback"] = state.feedback(state.sampled_monotonic_s + FEEDBACK_DELAY_S)

    return reading


def so101(directory: Path) -> dict[str, Any]:
    """lerobot's calibration file, PEAR's reading of the servos' Status, and whole sessions of PEAR's SO101Hardware
    on the simulated chain: enabling, reading, commanding, faults, closing."""
    calibration = calibration_of(ARM_CALIBRATION)
    follower = make_follower(directory, calibration)
    calibration_text = (directory / f"{CALIBRATION_ID}.json").read_text()
    motors = {
        name: {"id": motor.id, "model": motor.model, "norm_mode": motor.norm_mode.value}
        for name, motor in follower.bus.motors.items()
    }
    follower_config = {
        name: getattr(follower.config, name)
        for name in (
            "use_degrees",
            "position_p_coefficient",
            "position_i_coefficient",
            "position_d_coefficient",
            "disable_torque_on_disconnect",
            "num_read_retries",
        )
    }

    faults = {
        "elbow_flex": [StartupChecks.servo_faults({"elbow_flex": value}) for value in range(256)],
        "gripper": [StartupChecks.servo_faults({"gripper": value}) for value in range(256)],
    }
    checks = []
    for register, check in (("status", SO101Hardware._check_status), ("torque", SO101Hardware._check_torque)):
        for values in ([0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1], [0, 0x20, 1, 0, 0x06, 0x28], [1, 1, 0, 1, 1, 0], [0x40, 0, 0, 0, 0, 0x41]):
            servo_values = dict(zip(MOTORS, values))
            try:
                check(servo_values)
                checks.append({"register": register, "values": servo_values, "error": None})
            except Exception as error:
                checks.append({"register": register, "values": servo_values, "error": error_of(error)})

    control_config = types.SimpleNamespace(state_timeout_s=0.2)
    joint_offsets = [0.01, -0.02, 0.0, 0.03, -0.004]
    hardware_config = HardwareConfig(
        port=PORT_NAME,
        calibration_id=CALIBRATION_ID,
        calibration_dir=directory,
        joint_offsets=joint_offsets,
        status_poll_ticks=10,
        position_p_coefficient=16,
    )
    robot_config = types.SimpleNamespace(require_commissioned=lambda: None, hardware=hardware_config)
    sessions = []

    def new_session(name: str) -> tuple[Scenario, dict[str, Any]]:
        scenario = Scenario(name, FakeChain(ARM_CALIBRATION))
        pear_arms.time = FakeMonotonic()  # the arm's clock starts again with every session
        holder: dict[str, Any] = {}
        sessions.append((scenario, holder))
        return scenario, holder

    def open_arm(scenario: Scenario, holder: dict[str, Any], **step_faults: Any) -> None:
        holder["registers"] = scenario.chain.dump()

        def open_hardware() -> None:
            holder["hardware"] = SO101Hardware(control_config, robot_config)

        scenario.run("open", open_hardware, **step_faults)

    def arm_step(scenario: Scenario, holder: dict[str, Any], operation: str, target: list[float] | None = None) -> None:
        hardware = holder["hardware"]
        if operation == "send":
            scenario.run("send", lambda: hardware.send(target), {"target": target})
        elif operation == "close":
            scenario.run("close", hardware.close)
        else:
            scenario.run(operation, lambda: arm_state_json(getattr(hardware, operation)()))

    scenario, holder = new_session("a session")
    open_arm(scenario, holder)
    for _ in range(12):
        arm_step(scenario, holder, "read")
    arm_step(scenario, holder, "send", [0.1, -0.8, 0.7, 1.2, -1.5, 1.0])
    arm_step(scenario, holder, "read")
    arm_step(scenario, holder, "send", [-0.3, -0.5, 0.2, 0.9, 0.0, 0.25])
    arm_step(scenario, holder, "read")
    arm_step(scenario, holder, "read")
    scenario.poke("elbow_flex", "Status", 0x20)
    for _ in range(6):  # the fault shows at the next poll of the Status
        arm_step(scenario, holder, "read")
    arm_step(scenario, holder, "read_for_recovery")
    scenario.poke("elbow_flex", "Status", 0)
    scenario.poke("gripper", "Status", 0x28)  # a jaw squeezing an object
    arm_step(scenario, holder, "read_for_recovery")
    for _ in range(11):
        arm_step(scenario, holder, "read")
    scenario.poke("gripper", "Status", 0)
    scenario.poke("wrist_roll", "Torque_Enable", 0)
    for _ in range(11):  # the lost torque shows at the next poll of Torque_Enable
        arm_step(scenario, holder, "read")
    arm_step(scenario, holder, "read_for_recovery")
    scenario.poke("wrist_roll", "Torque_Enable", 1)
    arm_step(scenario, holder, "read_for_recovery")
    arm_step(scenario, holder, "send", [0.0, -0.814, 0.077, 1.423, -1.613, 1.0])
    arm_step(scenario, holder, "read")
    arm_step(scenario, holder, "close")
    arm_step(scenario, holder, "close")
    arm_step(scenario, holder, "read")
    arm_step(scenario, holder, "send", [0.0] * 6)

    scenario, holder = new_session("a servo misses the first goal")
    open_arm(scenario, holder, miss_sync_write={3})
    arm_step(scenario, holder, "read")
    arm_step(scenario, holder, "close")

    scenario, holder = new_session("a position read is lost while running")
    open_arm(scenario, holder)
    arm_step(scenario, holder, "read")
    scenario.run("read", lambda: arm_state_json(holder["hardware"].read()), drop={2})
    scenario.run("read", lambda: arm_state_json(holder["hardware"].read()), drop={2, 8})
    arm_step(scenario, holder, "read")
    arm_step(scenario, holder, "close")

    scenario, holder = new_session("the bus stays silent while enabling")
    open_arm(scenario, holder, drop=set(range(42, 400)))

    scenario, holder = new_session("the servos' calibration differs from the file")
    scenario.poke("shoulder_lift", "Max_Position_Limit", 3228)
    open_arm(scenario, holder)

    scenario, holder = new_session("a servo reports an error before the arm is enabled")
    scenario.poke("elbow_flex", "Status", 0x20)
    open_arm(scenario, holder)

    scenario, holder = new_session("a servo reports an error when the arm is closed")
    open_arm(scenario, holder)
    scenario.poke("elbow_flex", "Status", 0x20)
    arm_step(scenario, holder, "close")
    scenario.poke("elbow_flex", "Status", 0)

    for _, holder in sessions:  # so that no follower's destructor finds an open port
        hardware = holder.get("hardware")
        if hardware is not None and hardware.follower.bus.is_connected:
            hardware.follower.bus.port_handler.closePort()

    return {
        "port": PORT_NAME,
        "motors": motors,
        "follower_config": follower_config,
        "calibration": calibration_json(calibration),
        "calibration_file": calibration_text,
        "status_bits": {str(bit): name for bit, name in StartupChecks.STATUS_BITS.items()},
        "gripper_load_bits": StartupChecks.GRIPPER_LOAD_BITS,
        "servo_faults": faults,
        "servo_checks": checks,
        "constants": {
            "enable_attempts": SO101Hardware.ENABLE_ATTEMPTS,
            "bus_retries": SO101Hardware.BUS_RETRIES,
            "run_retries": SO101Hardware.RUN_RETRIES,
            "vector_length": VECTOR_LENGTH,
            "gripper_index": GRIPPER_INDEX,
        },
        "hardware": {
            "joint_offsets": joint_offsets,
            "status_poll_ticks": hardware_config.status_poll_ticks,
            "position_p_coefficient": hardware_config.position_p_coefficient,
            "state_timeout_s": control_config.state_timeout_s,
        },
        "monotonic": {"start_s": FakeMonotonic.START_S, "step_s": FakeMonotonic.STEP_S},
        "feedback_delay_s": FEEDBACK_DELAY_S,
        "feedback_every": FEEDBACK_EVERY,
        "sessions": [
            {"name": scenario.name, "registers": holder["registers"], "steps": scenario.steps}
            for scenario, holder in sessions
        ],
    }


class StubHardware:
    """The arm under PEAR's driver: its readings and failures as a script, and what it was sent."""

    def __init__(self) -> None:
        self.script: list[Any] = []
        self.sent: list[list[float]] = []
        self.is_closed = False

    def read(self) -> Any:
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    read_for_recovery = read

    def send(self, target: Any) -> None:
        self.sent.append([float(coordinate) for coordinate in target])

    def close(self) -> None:
        self.is_closed = True


class StubFeedforward:
    """Goal offsets as a script, in place of the gravity and friction model; it notes what it was asked."""

    def __init__(self) -> None:
        self.script: list[Any] = []
        self.calls: list[Any] = []

    def hold_offset(self, target: Any) -> Any:
        self.calls.append(["hold_offset", list(target)])
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return np.array(item, dtype=float)

    def offset(self, target: Any, planned_velocity: Any, now: float) -> Any:
        self.calls.append(["offset", list(target), None if planned_velocity is None else list(planned_velocity), now])
        return np.array(self.script.pop(0), dtype=float)


def driver() -> dict[str, Any]:
    """PEAR's SO101Driver on a scripted arm: which reading it returns after a failed read, what goal it sends for a
    target and a feedforward offset, when a held target is sent again."""
    rng = random.Random(SEED + 3)
    lower_bounds = [-1.7623, -1.7569, -1.6503, -1.7201, -2.618, 0.0]  # PEAR's config.yaml
    upper_bounds = [1.7623, 1.7569, 1.6503, 1.7201, 2.618, 1.0]
    failures = {
        "ConnectionError": lambda: ConnectionError("no status packet"),
        "ServoFault": lambda: ServoFault("Servo error: elbow_flex: overload"),
    }
    cases = []

    def new_driver(name: str, has_feedforward: bool) -> tuple[Any, list[dict[str, Any]]]:
        pear_driver.time = FakeMonotonic()
        made = object.__new__(SO101Driver)  # the state of __init__, without an arm to open
        made.limits = types.SimpleNamespace(lower_bounds=lower_bounds, upper_bounds=upper_bounds)
        made.hardware = StubHardware()
        made.feedforward = StubFeedforward() if has_feedforward else None
        made.offset = np.zeros(VECTOR_LENGTH)
        made.state = None
        made.has_commanded = False
        steps: list[dict[str, Any]] = []
        cases.append({"name": name, "has_feedforward": has_feedforward, "steps": steps})
        return made, steps

    def run(made: Any, steps: list[dict[str, Any]], operation: str, arguments: dict[str, Any] | None = None) -> None:
        arguments = arguments or {}
        step: dict[str, Any] = {"op": operation, "args": arguments}
        if "reading" in arguments:  # what the arm gives the next read: a reading, or the name of a failure
            reading = arguments["reading"]
            made.hardware.script.append(failures[reading]() if reading in failures else {"reading": reading})
        if "offset" in arguments:  # what the feedforward answers next: an offset, or a failure
            offset = arguments["offset"]
            made.feedforward.script.append(RuntimeError("no gravity model") if offset is None else offset)
        targets = {ARM: arguments["target"]} if "target" in arguments else None
        velocities = {ARM: arguments["velocity"]} if "velocity" in arguments else None
        try:
            if operation == "send":
                step["result"] = made.send(targets, velocities)
            elif operation == "refresh_hold":
                step["result"] = made.refresh_hold(targets)
            else:
                step["result"] = getattr(made, operation)()
        except Exception as error:
            step["error"] = error_of(error)
        step["sent"], made.hardware.sent = made.hardware.sent, []
        if made.feedforward is not None:
            step["asked"], made.feedforward.calls = made.feedforward.calls, []
        step["is_closed"] = made.hardware.is_closed
        steps.append(step)

    def random_target(index: int) -> list[float]:
        scale = 1.2 if index % 3 == 2 else 0.95  # one in three is past a bound
        return [rng.uniform(scale * lower, scale * upper) for lower, upper in zip(lower_bounds, upper_bounds)]

    inside = [0.1, -0.8, 0.7, 1.2, -1.5, 1.0]
    made, steps = new_driver("without a feedforward", False)
    run(made, steps, "telemetry")
    run(made, steps, "read", {"reading": "ConnectionError"})  # before the first command a failed read is raised
    run(made, steps, "read", {"reading": 1})
    run(made, steps, "send", {"target": inside})
    run(made, steps, "read", {"reading": "ConnectionError"})  # after it the last reading is kept
    run(made, steps, "read", {"reading": "ServoFault"})
    run(made, steps, "read", {"reading": 2})
    run(made, steps, "send", {"target": inside, "velocity": [0.2, 0.0, -0.1, 0.0, 0.0, 0.0]})
    run(made, steps, "refresh_hold", {"target": inside})
    for index in range(9):
        run(made, steps, "send", {"target": random_target(index)})
    run(made, steps, "read_for_recovery", {"reading": 3})
    run(made, steps, "read_for_recovery", {"reading": "ServoFault"})
    run(made, steps, "read_for_recovery", {"reading": "ConnectionError"})
    run(made, steps, "read", {"reading": "ConnectionError"})
    run(made, steps, "telemetry")
    run(made, steps, "close")

    made, steps = new_driver("with a feedforward", True)
    run(made, steps, "send", {"target": inside, "offset": [0.01, -0.02, 0.03, 0.0, -0.005, 0.0]})
    run(made, steps, "telemetry")
    run(made, steps, "send", {"target": inside, "offset": None})  # a hold never depends on the gravity model
    run(made, steps, "telemetry")
    velocity = [0.2, 0.0, -0.1, 0.0, 0.0, 0.0]
    run(made, steps, "send", {"target": inside, "velocity": velocity, "offset": [0.02, 0.0, 0.0, 0.0, 0.0, 0.0]})
    run(made, steps, "refresh_hold", {"target": inside, "offset": [0.02 + 5e-7, 0.0, 0.0, 0.0, 0.0, 0.0]})
    run(made, steps, "refresh_hold", {"target": inside, "offset": [0.02 + 2e-6, 0.0, 0.0, 0.0, 0.0, 0.0]})
    run(made, steps, "refresh_hold", {"target": inside, "offset": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]})
    for index in range(12):  # offsets large enough to cross a bound
        offset = [rng.uniform(-0.3, 0.3) for _ in range(5)] + [0.0]
        arguments: dict[str, Any] = {"target": random_target(index), "offset": offset}
        if index % 2 == 1:
            arguments["velocity"] = [rng.uniform(-1.0, 1.0) for _ in range(6)]
        run(made, steps, "send", arguments)
    run(made, steps, "telemetry")
    run(made, steps, "close")

    return {
        "arm": ARM,
        "offset_epsilon": SO101Driver.OFFSET_EPSILON,
        "lower_bounds": lower_bounds,
        "upper_bounds": upper_bounds,
        "monotonic": {"start_s": FakeMonotonic.START_S, "step_s": FakeMonotonic.STEP_S},
        "drivers": cases,
    }


def dump(data: dict[str, Any]) -> str:
    """Returns ``data`` as JSON with one line for each case of a list of cases: small files and readable diffs."""

    def default(value: Any) -> Any:
        if isinstance(value, (set, frozenset)):
            return sorted(value)
        if isinstance(value, (bytes, bytearray)):
            return list(value)
        if isinstance(value, np.generic):
            return value.item()
        raise TypeError(type(value))

    def compact(value: Any) -> str:
        return json.dumps(value, separators=(",", ":"), default=default, allow_nan=False)

    def lines_of(value: Any, indent: str, depth: int) -> str:
        if depth > 0 and isinstance(value, list) and value and all(isinstance(item, (dict, list)) for item in value):
            body = ",\n".join(indent + "  " + lines_of(item, indent + "  ", depth - 1) for item in value)
            return "[\n" + body + "\n" + indent + "]"
        if depth > 0 and isinstance(value, dict) and any(isinstance(item, list) and len(item) > 8 for item in value.values()):
            body = ",\n".join(
                indent + "  " + json.dumps(key) + ":" + lines_of(item, indent + "  ", depth - 1)
                for key, item in value.items()
            )
            return "{\n" + body + "\n" + indent + "}"
        return compact(value)

    return lines_of(data, "", 4) + "\n"


def main() -> None:
    install_fakes()
    FIXTURES.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as directory:
        files = {
            "tables.json": tables(),
            "packets.json": packets(),
            "status.json": status_streams(),
            "bus.json": bus_scenarios(Path(directory)),
            "normalize.json": normalization(),
            "so101.json": so101(Path(directory)),
            "driver.json": driver(),
        }
    for name, data in files.items():
        text = dump(data)
        (FIXTURES / name).write_text(text, encoding="utf-8", newline="\n")
        print(f"{name}: {len(text)} bytes")


if __name__ == "__main__":
    main()
