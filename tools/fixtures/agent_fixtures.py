"""Writes the fixtures of pear.js's agent module: what PEAR's own model client and agent loop send, emit, return and
raise, recorded while they run.

Run it with the Python of a PEAR station environment (PEAR at the commit src/index.ts pins), from any directory:

    <work dir>/envs/station/bin/python tools/fixtures/agent_fixtures.py [--sync-tables] [--output <directory>]

It writes tests/fixtures/agent/*.json and nothing else (with --sync-tables also src/agent/clients/python_printable.ts,
the table of Python's str.isprintable; without it, it stops when that file is not the table of the Python it runs in).

What runs is PEAR's code, never a restatement of it:

  client.json      VLLMClient against a recording HTTP server on 127.0.0.1 (an ephemeral port, in this process) that
                   replays scripted responses: every request it received and everything the client returned, emitted
                   and raised.
  parts.json       the pure parts: the client's refusals of its arguments, the metrics, the health checks' cache,
                   Python's str() of a decoded error body.
  model_call.json  ModelCall, the wait for the model's answer, on a scripted robot.
  loop.json        StationAgentLoop with PEAR's stand-in client on PEAR's stand-in SO-101.
  messages.json    ObservationMessage.build: the frames of a turn.
  meta.json        versions and constants.

Everything is deterministic. Times: the monotonic clock of PEAR's client modules is replaced by a clock that is one
step later at every reading (so every duration the client reports counts its own readings); the agent loop and the
stand-in robot run on the stand-in clock of PEAR's own tests, which stands still until a sleep advances it. UUIDs:
uuid4 of PEAR's modules is replaced by a seeded sequence. The server's port, the temporary directory and every other
value of this machine are left out of what is written.
"""

from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import io
import json
import random
import re
import socket
import socketserver
import struct
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import openai
import pydantic
from PIL import Image

import pear
from pear.deploy.station.agent_loop.clients import client as client_module
from pear.deploy.station.agent_loop.clients import metrics as metrics_module
from pear.deploy.station.agent_loop.clients import vllm as vllm_module
from pear.deploy.station.agent_loop.clients.client import ModelClient
from pear.deploy.station.agent_loop.clients.schemas import CameraImage, ModelInput, ReferenceImage
from pear.deploy.station.agent_loop.clients.vllm import VLLMClient
from pear.deploy.station.agent_loop.messages import SystemPrompt
from pear.deploy.station.control.robots.so101.formats import SINGLE_ARM_POSE_FORMAT

REPOSITORY = Path(__file__).resolve().parents[2]
FIXTURES = REPOSITORY / "tests" / "fixtures" / "agent"
PEAR_PACKAGE = Path(pear.__file__).resolve().parent
SEED = 20261115
MODEL = "qwen3_8_27b"  # the name the model is served under in PEAR's example station
API_KEY = "test-key"  # the only key a fixture holds
REAL_MONOTONIC = time.monotonic  # the machine's clock, for the waits of this script itself


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


class Tables:
    """The table of Python's str.isprintable, which decides how repr() writes a character of an error's text, and
    the module that embeds it."""

    MODULE = REPOSITORY / "src" / "agent" / "clients" / "python_printable.ts"
    LINE = 100  # characters of the table on one line of the module

    @staticmethod
    def ranges() -> list[tuple[int, int]]:
        """The code points str.isprintable refuses, as (first, last) of each run."""
        ranges, first = [], None
        for code in range(sys.maxunicode + 2):
            is_refused = code <= sys.maxunicode and not chr(code).isprintable()
            if is_refused and first is None:
                first = code
            elif not is_refused and first is not None:
                ranges.append((first, code - 1))
                first = None

        return ranges

    @classmethod
    def encoded(cls) -> str:
        """Each run as "<gap from the end of the run before>.<length - 1>" in base 36, joined by commas."""
        digits = "0123456789abcdefghijklmnopqrstuvwxyz"

        def base36(number: int) -> str:
            text = ""
            while True:
                number, digit = divmod(number, 36)
                text = digits[digit] + text
                if not number:
                    return text

        parts, previous = [], 0
        for first, last in cls.ranges():
            parts.append(f"{base36(first - previous)}.{base36(last - first)}")
            previous = last

        return ",".join(parts)

    @classmethod
    def module_text(cls) -> str:
        import unicodedata

        table = cls.encoded()
        python = f"{sys.version_info.major}.{sys.version_info.minor}"
        lines = [
            "// Embeds the table of Python's str.isprintable(): the code points repr() writes as an escape (Unicode",
            f"// {unicodedata.unidata_version}, the version of Python {python}). A JavaScript engine's own Unicode"
            " tables are of the",
            "// version it was built with, so they cannot stand in for it. Written by tools/fixtures/agent_fixtures.py",
            "// --sync-tables; tests/agent/parts.test.ts compares it with Python over every code point. Do not edit"
            " by hand.",
            "",
            "/** Each run of code points that are not printable, in base 36:",
            ' * "<gap from the end of the run before>.<length - 1>". */',
            "export const NOT_PRINTABLE_RUNS = [",
        ]
        lines += [f'  "{table[start : start + cls.LINE]}",' for start in range(0, len(table), cls.LINE)]
        lines += ['].join("");', ""]

        return "\n".join(lines)

    @classmethod
    def sync(cls) -> None:
        cls.MODULE.parent.mkdir(parents=True, exist_ok=True)
        cls.MODULE.write_text(cls.module_text(), encoding="ascii", newline="\n")

    @classmethod
    def check(cls) -> dict[str, Any]:
        """Returns what the fixtures record of the table; stops unless the module holds the table of this Python."""
        if not cls.MODULE.is_file() or cls.MODULE.read_text(encoding="ascii") != cls.module_text():
            sys.exit("src/agent/clients/python_printable.ts is not this Python's table: run with --sync-tables")
        flags = bytes(0 if chr(code).isprintable() else 1 for code in range(sys.maxunicode + 1))

        return {
            "runs": len(cls.ranges()),
            "not_printable": sum(flags),
            # of one byte for each code point from 0 to 0x10FFFF: 1 where str.isprintable refuses it
            "sha256": hashlib.sha256(flags).hexdigest(),
        }


class Errors:
    """What a fixture records of an exception PEAR raised."""

    @staticmethod
    def record(error: BaseException) -> dict[str, Any]:
        return {
            "type": type(error).__name__,
            "message": str(error),
            # the classes it is an instance of, nearest first: what `except` clauses and isinstance checks see
            "bases": [cls.__name__ for cls in type(error).__mro__ if cls not in (object, BaseException)],
            "is_value_error": isinstance(error, ValueError),
            "status_code": getattr(error, "status_code", None),
        }


class TickClock:
    """What stands in for the monotonic clock of PEAR's client modules: every reading is one step after the last."""

    def __init__(self) -> None:
        self.start, self.step, self.reads = 0.0, 0.0, 0

    def configure(self, start: float, step: float) -> None:
        self.start, self.step, self.reads = start, step, 0

    def monotonic(self) -> float:
        value = self.start + self.reads * self.step
        self.reads += 1

        return value


CLOCK = TickClock()


class Ids:
    """A seeded sequence of UUIDs."""

    def __init__(self, seed: int) -> None:
        self.generator = random.Random(seed)

    def next(self) -> uuid.UUID:
        return uuid.UUID(int=self.generator.getrandbits(128), version=4)


class Frames:
    """Small JPEG images, as a turn's camera frames and a task's reference images."""

    @staticmethod
    def jpeg(seed: int, size: tuple[int, int] = (16, 12)) -> bytes:
        generator = random.Random(seed)
        picture = Image.new("RGB", size)
        picture.putdata([tuple(generator.randrange(256) for _ in range(3)) for _ in range(size[0] * size[1])])
        buffer = io.BytesIO()
        picture.save(buffer, "JPEG", quality=90)

        return buffer.getvalue()


REASONS = {
    200: "OK",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    418: "I'm a teapot",
    422: "Unprocessable Entity",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
}


class Service:
    """A recording HTTP/1.1 server on 127.0.0.1 that answers each request with the next scripted response and closes
    the connection.

    A response is a dict: status (200), headers (pairs), framing ("chunked", "length" or "close": how the body's end
    is told), head ("send"; "reset": the connection is reset before any answer; "hold": nothing is answered until the
    client leaves), delay_s (a wait before the head), body (steps: {"data": text} is one write, {"sleep_s": seconds}
    a pause, {"hold_s": seconds} waits until the client leaves), encoding (of the body's text: "utf-8"; "latin-1"
    where each character of the text is one byte, so that a write can end inside a character) and end ("finish";
    "cut": the connection closes before the body is complete; "reset": it is reset).
    """

    HOLD_LIMIT_S = 20.0  # the longest a held connection waits for the client to leave

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.header_names: set[str] = set()
        self.responses: list[dict[str, Any]] = []
        self.lock = threading.Lock()
        service = self

        class Handler(socketserver.BaseRequestHandler):
            def handle(self) -> None:
                try:
                    service.serve(self.request)
                except OSError:
                    pass  # the client left

        socketserver.ThreadingTCPServer.allow_reuse_address = True
        self.server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_address[1]}"

        # a port of this machine that nothing listens on
        unused = socket.socket()
        unused.bind(("127.0.0.1", 0))
        self.closed_origin = f"http://127.0.0.1:{unused.getsockname()[1]}"
        unused.close()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def begin(self, responses: list[dict[str, Any]]) -> None:
        """Forgets the requests received and queues ``responses`` for the next ones."""
        with self.lock:
            self.requests = []
            self.responses = list(responses)

    def serve(self, connection: socket.socket) -> None:
        data = b""
        while b"\r\n\r\n" not in data:
            piece = connection.recv(65536)
            if not piece:
                return
            data += piece
        head, _, body = data.partition(b"\r\n\r\n")
        lines = head.decode("latin-1").split("\r\n")
        method, target, _ = lines[0].split(" ", 2)
        headers = {}
        for line in lines[1:]:
            name, _, value = line.partition(":")
            headers[name.strip().lower()] = value.strip()
        while len(body) < int(headers.get("content-length", "0")):
            piece = connection.recv(65536)
            if not piece:
                return
            body += piece

        with self.lock:
            self.header_names.update(headers)
            self.requests.append(
                {
                    "method": method,
                    "path": target,
                    "headers": {name: headers.get(name) for name in ("authorization", "content-type", "accept")},
                    "body": json.loads(body) if body else None,
                }
            )
            response = self.responses.pop(0) if self.responses else {"status": 599, "body": [{"data": "unscripted"}]}
        self.play(connection, response)

    def play(self, connection: socket.socket, response: dict[str, Any]) -> None:
        if response.get("delay_s"):
            time.sleep(response["delay_s"])
        head = response.get("head", "send")
        if head == "reset":
            self.reset(connection)
            return
        if head == "hold":
            self.hold(connection, self.HOLD_LIMIT_S)
            return

        status = response.get("status", 200)
        framing = response.get("framing", "chunked")
        steps = response.get("body", [])
        encoding = response.get("encoding", "utf-8")
        lines = [f"HTTP/1.1 {status} {REASONS[status]}"]
        lines += [f"{name}: {value}" for name, value in response.get("headers", [])]
        if framing == "chunked":
            lines.append("Transfer-Encoding: chunked")
        elif framing == "length":
            written = sum(len(step["data"].encode(encoding)) for step in steps if "data" in step)
            lines.append(f"Content-Length: {written + response.get('missing_bytes', 0)}")
        lines.append("Connection: close")
        connection.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))

        for step in steps:
            if "sleep_s" in step:
                time.sleep(step["sleep_s"])
            elif "hold_s" in step:
                self.hold(connection, step["hold_s"])
                return
            else:
                payload = step["data"].encode(encoding)
                if framing == "chunked":
                    payload = f"{len(payload):x}\r\n".encode() + payload + b"\r\n"
                connection.sendall(payload)

        end = response.get("end", "finish")
        if end == "finish" and framing == "chunked":
            connection.sendall(b"0\r\n\r\n")
        if end == "reset":
            self.reset(connection)

    @staticmethod
    def hold(connection: socket.socket, limit_s: float) -> None:
        """Waits until the client closes the connection, at most ``limit_s``."""
        connection.settimeout(limit_s)
        try:
            while connection.recv(4096):
                pass
        except OSError:
            pass

    @staticmethod
    def reset(connection: socket.socket) -> None:
        connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))


class Wire:
    """Scripted responses of a vLLM server's Chat Completions and model list."""

    STREAM = [["Content-Type", "text/event-stream; charset=utf-8"]]
    JSON = [["Content-Type", "application/json"]]
    DONE = {"data": "data: [DONE]\n\n"}

    @staticmethod
    def event(value: Any, *, ascii_only: bool = False) -> dict[str, str]:
        """One server-sent event that carries ``value`` as JSON."""
        return {"data": "data: " + json.dumps(value, ensure_ascii=ascii_only) + "\n\n"}

    @staticmethod
    def chunk(delta: dict[str, Any] | None = None, finish: str | None = None, **fields: Any) -> dict[str, Any]:
        """A chunk of a streamed completion: one choice with ``delta``, or none without it."""
        choices = [] if delta is None else [{"index": 0, "delta": delta, "logprobs": None, "finish_reason": finish}]

        return {
            "id": "chatcmpl-fixture",
            "object": "chat.completion.chunk",
            "created": 1763000000,
            "model": MODEL,
            "choices": choices,
            **fields,
        }

    @staticmethod
    def usage(prompt: int, completion: int, cached: int | None = None) -> dict[str, Any]:
        usage: dict[str, Any] = {
            "prompt_tokens": prompt,
            "total_tokens": prompt + completion,
            "completion_tokens": completion,
        }
        if cached is not None:
            usage["prompt_tokens_details"] = {"cached_tokens": cached}

        return usage

    @classmethod
    def stream(
        cls,
        reasoning: list[str],
        answer: list[str],
        *,
        prompt_tokens: int = 1200,
        cached_tokens: int | None = 1100,
        usage: str = "continuous",
        metrics: dict[str, Any] | None = None,
        reasoning_field: str = "reasoning",
        finish: str = "stop",
        sleep_s: float = 0.0,
    ) -> dict[str, Any]:
        """A whole streamed answer as a vLLM server sends it: the role, the reasoning's pieces, the answer's pieces,
        the finish reason, the final token counts and [DONE]. ``usage`` is "continuous" (every chunk counts the
        tokens so far), "final" (only the last chunk does) or "none"."""
        completion = 0

        def chunk(delta: dict[str, Any], finish: str | None = None, tokens: int = 0) -> dict[str, str]:
            nonlocal completion
            completion += tokens
            fields = {"usage": cls.usage(prompt_tokens, completion)} if usage == "continuous" else {}

            return cls.event(cls.chunk(delta, finish, **fields))

        body = [chunk({"role": "assistant", "content": ""})]
        for piece in reasoning:
            body.append(chunk({reasoning_field: piece}, tokens=max(1, len(piece) // 4)))
            if sleep_s:
                body.append({"sleep_s": sleep_s})
        for piece in answer:
            body.append(chunk({"content": piece}, tokens=max(1, len(piece) // 4)))
        body.append(chunk({"content": ""}, finish, tokens=1))
        if usage != "none":
            final = cls.chunk(None, usage=cls.usage(prompt_tokens, completion, cached_tokens))
            if metrics is not None:
                final["metrics"] = metrics
            body.append(cls.event(final))
        body.append(cls.DONE)

        return {"headers": cls.STREAM, "body": body}

    @classmethod
    def refusal(cls, status: int, body: Any, *, raw: bool = False) -> dict[str, Any]:
        """A response of ``status`` whose body is ``body`` as JSON, or as it is with ``raw``."""
        text = body if raw else json.dumps(body, ensure_ascii=False)

        return {"status": status, "framing": "length", "headers": cls.JSON, "body": [{"data": text}]}

    @classmethod
    def models(cls, *names: str) -> dict[str, Any]:
        """The server's model list."""
        data = [{"id": name, "object": "model", "created": 1763000000, "owned_by": "vllm"} for name in names]

        return cls.refusal(200, {"object": "list", "data": data})


class ClientScenarios:
    """The scenarios PEAR's VLLMClient runs through, each a list of steps on one client."""

    CACHE_MISS = {"error": {"message": "Cache miss for image 3f2c and data is not provided", "type": "BadRequestError"}}
    ANSWER = '```json\n{"arm": {"x": 0.0, "y": 0.0, "z": 1.5, "pitch": 0.0, "roll": 0.0}, "gripper": {"width": 0.0}}\n```'

    SYSTEM_PROMPT = "You control a robot arm. Task: pick up the red cube."  # where the prompt's text plays no part

    def __init__(self, ids: Ids) -> None:
        self.ids = ids
        self.frame_seed = 0
        self.jpeg_frames = False  # whether the frames are JPEG images, or a few bytes between a JPEG's two markers

    def frame(self) -> str:
        """The bytes of the next image, as base64."""
        self.frame_seed += 1
        if self.jpeg_frames:
            data = Frames.jpeg(self.frame_seed)
        else:
            data = b"\xff\xd8" + random.Random(self.frame_seed).randbytes(self.frame_seed % 7 + 4) + b"\xff\xd9"

        return base64.b64encode(data).decode("ascii")

    def image(self, camera_name: str = "wrist") -> dict[str, str]:
        return {"camera_name": camera_name, "uuid": str(self.ids.next()), "data": self.frame()}

    def reference(self) -> dict[str, str]:
        return {"uuid": str(self.ids.next()), "data": self.frame()}

    def turn(self, number: int, *, cameras: tuple[str, ...] = ("wrist",), feedback: str | None = None) -> dict[str, Any]:
        """A turn's input: a state's text as a turn shows it, and one frame of each camera."""
        state = {"arm": {"x": 22.7, "y": 0.8, "z": 20.8 + number, "pitch": 0.69, "roll": -1.66}, "gripper": {"width": 6.0}}
        text = json.dumps(state) + (
            "\n\nThe current camera frame follows. End your response with one json block containing the next action."
        )
        if feedback:
            text += "\n\nPrevious execution: " + feedback

        return {"text": text, "images": [self.image(camera) for camera in cameras], "reference_images": []}

    @classmethod
    def client(cls, **fields: Any) -> dict[str, Any]:
        """A client's arguments: PEAR's own defaults but what ``fields`` give."""
        return {
            "system_prompt": cls.SYSTEM_PROMPT,
            "timeout_s": 300.0,
            "base_url": "{service}/v1",
            "model": MODEL,
            "api_key": API_KEY,
            "options": {},
            **fields,
        }

    def all(self) -> list[dict[str, Any]]:
        return [
            *self.conversations(),
            *self.cache_misses(),
            *self.context_limits(),
            *self.refusals(),
            *self.broken_streams(),
            *self.malformed_chunks(),
            *self.time_outs(),
            *self.cancellations(),
            *self.health_checks(),
        ]

    def conversations(self) -> list[dict[str, Any]]:
        feedback = (
            '{"status": "completed", "execution_requested": true, "settled": true, "reached": true}'
            " Use the new measured observation."
        )
        self.jpeg_frames = True
        three_turns = {
            "name": "three turns of one task",
            "about": "the health check, then three turns with PEAR's system prompt and JPEG frames: the history "
            "grows, earlier frames go by their UUID alone, the reasoning stays in the history, the usage and the "
            "timings are reported",
            "client": self.client(system_prompt=SystemPrompt.render("Pick up the red cube.", SINGLE_ARM_POSE_FORMAT)),
            "clock": {"start": 1000.0, "step": 0.0625},
            "steps": [
                {"op": "check", "responses": [Wire.models(MODEL, "draft")]},
                {
                    "op": "infer",
                    "input": self.turn(0),
                    "responses": [
                        Wire.stream(["The cube is ", "left of the gripper."], ["Moving up.\n", self.ANSWER]),
                    ],
                },
                {
                    "op": "infer",
                    "input": self.turn(1, feedback=feedback),
                    "responses": [
                        Wire.stream(["Now ", "lower."], [self.ANSWER], prompt_tokens=2400, cached_tokens=2300),
                    ],
                },
                {
                    "op": "infer",
                    "input": self.turn(2, feedback=feedback),
                    "responses": [
                        Wire.stream(
                            ["Close the gripper."],
                            [self.ANSWER],
                            prompt_tokens=3600,
                            cached_tokens=3500,
                            metrics={"generation_time_ms": 190, "tokens_per_second": 25},
                        ),
                    ],
                },
                {"op": "close"},
            ],
        }
        self.jpeg_frames = False

        # token counts in every chunk, a clock that is 1/64 s later at every reading: most reports are held back
        pacing = {
            "name": "the usage reports are paced",
            "about": "continuous usage on a fine clock: a report follows the last by at least 0.25 s of the client's "
            "clock, the token rate spans the first to the last count",
            "client": self.client(),
            "clock": {"start": 50.0, "step": 0.015625},
            "steps": [
                {
                    "op": "infer",
                    "input": self.turn(0),
                    "responses": [
                        Wire.stream(
                            [f"Step {index}. " for index in range(24)],
                            ["Done.\n", self.ANSWER],
                            metrics={"generation_time_ms": 812.5, "tokens_per_second": 61.5},
                        )
                    ],
                }
            ],
        }

        no_usage = {
            "name": "a server that reports no usage",
            "about": "no token count is invented: no usage event, no throughput",
            "client": self.client(),
            "clock": {"start": 10.0, "step": 0.125},
            "steps": [
                {
                    "op": "infer",
                    "input": self.turn(0),
                    "responses": [Wire.stream(["Thinking."], [self.ANSWER], usage="none")],
                },
            ],
        }

        final_usage = {
            "name": "usage in the last chunk only",
            "about": "one usage report, the final one, and the decode rate from the server's own timing",
            "client": self.client(options={"context_limit": 191168}),
            "clock": {"start": 10.0, "step": 0.125},
            "steps": [
                {
                    "op": "infer",
                    "input": self.turn(0),
                    "responses": [
                        Wire.stream(
                            ["Thinking."],
                            [self.ANSWER],
                            usage="final",
                            cached_tokens=None,
                            metrics={"generation_time_ms": 250.0},
                        )
                    ],
                },
                {
                    "op": "infer",
                    "input": self.turn(1),
                    "responses": [
                        Wire.stream(["More."], [self.ANSWER], usage="final", metrics={"generation_time_ms": 0}),
                    ],
                },
                {
                    "op": "infer",
                    "input": self.turn(2),
                    "responses": [
                        Wire.stream(["More."], [self.ANSWER], usage="final", metrics={"generation_time_ms": True}),
                    ],
                },
                {
                    "op": "infer",
                    "input": self.turn(3),
                    "responses": [Wire.stream(["More."], [self.ANSWER], usage="final", metrics=[190])],
                },
            ],
        }

        reasoning_fields = {
            "name": "the reasoning under either name",
            "about": "reasoning_content, the older name of a delta's reasoning, and both names in one delta",
            "client": self.client(),
            "clock": {"start": 10.0, "step": 0.125},
            "steps": [
                {
                    "op": "infer",
                    "input": self.turn(0),
                    "responses": [Wire.stream(["Older ", "field."], [self.ANSWER], reasoning_field="reasoning_content")],
                },
                {
                    "op": "infer",
                    "input": self.turn(1),
                    "responses": [
                        {
                            "headers": Wire.STREAM,
                            "body": [
                                Wire.event(Wire.chunk({"reasoning": "", "reasoning_content": "second name"})),
                                Wire.event(Wire.chunk({"reasoning": "first name", "reasoning_content": "ignored"})),
                                Wire.event(Wire.chunk({"reasoning": "both", "content": " and text"})),
                                Wire.event(Wire.chunk({"content": None, "reasoning": None}, "stop")),
                                Wire.DONE,
                            ],
                        }
                    ],
                },
            ],
        }

        chinese = "把紅色的方塊放進藍色的盒子裡。\n動作要慢。 \U0001f916"
        non_ascii = {
            "name": "text beyond ASCII",
            "about": "a task in Traditional Chinese with an emoji; an answer and its reasoning with both, sent as "
            "UTF-8 and as JSON escapes; the size of the conversation counts Python's escaped JSON",
            "client": self.client(system_prompt=SystemPrompt.render(chinese, SINGLE_ARM_POSE_FORMAT)),
            "clock": {"start": 10.0, "step": 0.125},
            "steps": [
                {
                    "op": "infer",
                    "input": self.turn(0),
                    "responses": [Wire.stream(["方塊在左邊。", "\U0001f914 café"], ["往上。\n", self.ANSWER])],
                },
                {
                    "op": "infer",
                    "input": self.turn(1, feedback="上一個動作的報告 \U0001f916 \"quoted\" \\ back\ttab"),
                    "responses": [
                        {
                            "headers": Wire.STREAM,
                            "body": [
                                Wire.event(Wire.chunk({"reasoning": "夾爪 \U0001f600 \x7f\u2028"}), ascii_only=True),
                                Wire.event(Wire.chunk({"content": self.ANSWER}, "stop"), ascii_only=True),
                                Wire.DONE,
                            ],
                        }
                    ],
                },
                {"op": "infer", "input": self.turn(2), "responses": [Wire.stream([], [self.ANSWER])]},
            ],
        }

        references = (self.reference(), self.reference())
        with_references = [{**self.turn(number), "reference_images": list(references)} for number in range(3)]
        reference_images = {
            "name": "a task's reference images",
            "about": "sent once, before the first turn's text and without a label; a cache miss in the second turn "
            "sends them again with every saved frame",
            "client": self.client(),
            "clock": {"start": 10.0, "step": 0.125},
            "steps": [
                {"op": "infer", "input": with_references[0], "responses": [Wire.stream(["One."], [self.ANSWER])]},
                {
                    "op": "infer",
                    "input": with_references[1],
                    "responses": [Wire.refusal(400, self.CACHE_MISS), Wire.stream(["Two."], [self.ANSWER])],
                },
                {"op": "infer", "input": with_references[2], "responses": [Wire.stream(["Three."], [self.ANSWER])]},
            ],
        }

        retried = {**self.turn(0), "reference_images": [self.reference()]}
        retried_references = {
            "name": "reference images after a failed first request",
            "about": "a first request that failed left no input in the history: the next one sends the reference "
            "images again",
            "client": self.client(),
            "clock": {"start": 10.0, "step": 0.125},
            "steps": [
                {
                    "op": "infer",
                    "input": retried,
                    "responses": [Wire.refusal(400, {"error": {"message": "maximum context length exceeded"}})],
                },
                {"op": "infer", "input": retried, "responses": [Wire.stream(["Again."], [self.ANSWER])]},
            ],
        }

        options = {
            "name": "a station's own values",
            "about": "a token limit, sampling values, a context length and an image limit of the station's own; no "
            "key: the word PEAR sends in its place; a base URL with a slash at its end; three cameras",
            "client": self.client(
                api_key=None,
                base_url="{service}/v1/",
                timeout_s=120.0,
                options={
                    "max_output_tokens": 4096,
                    "context_limit": 191168,
                    "max_images": 12,
                    "temperature": 0.7,
                    "top_p": 0.9,
                    "top_k": 20,
                    "repetition_penalty": 1.05,
                    "reasoning_effort": "xhigh",
                },
            ),
            "clock": {"start": 10.0, "step": 0.125},
            "steps": [
                {
                    "op": "infer",
                    "input": self.turn(0, cameras=("head", "left_wrist", "right_wrist")),
                    "responses": [Wire.stream(["Three views."], [self.ANSWER])],
                },
                {
                    "op": "infer",
                    "input": self.turn(1, cameras=("head", "left_wrist", "right_wrist")),
                    "responses": [Wire.stream([], [self.ANSWER], finish="length")],
                },
            ],
        }

        role = Wire.event(Wire.chunk({"role": "assistant", "content": ""}))["data"]
        thinking = Wire.event(Wire.chunk({"reasoning": "Split 分割 across writes."}))["data"].encode()
        answer = Wire.event(Wire.chunk({"content": self.ANSWER}, "stop"))["data"]
        final = Wire.event(Wire.chunk(None, usage=Wire.usage(900, 40, 800)))["data"]
        middle = thinking.index("分".encode()) + 1  # inside a character of three bytes
        # (the other texts of that response are ASCII, so that each of their characters is one byte too)
        framing = {
            "name": "how the stream is framed",
            "about": "events in one write and split across writes (inside a line and inside a character), CRLF and "
            "CR line ends, comments, an event field, an id, a retry, two data lines of one event, text after [DONE]",
            "client": self.client(),
            "clock": {"start": 10.0, "step": 0.125},
            "steps": [
                {
                    "op": "infer",
                    "input": self.turn(0),
                    "responses": [
                        {
                            "headers": Wire.STREAM,
                            "body": [
                                {"data": ": keep-alive\n\n" + role + thinking[:middle].decode("latin-1")},
                                {"sleep_s": 0.05},
                                {"data": thinking[middle:].decode("latin-1") + answer[:40]},
                                {"data": answer[40:] + final + "data: [DONE]\n\ndata: {not read}\n\n"},
                            ],
                            "encoding": "latin-1",
                        }
                    ],
                },
                {
                    "op": "infer",
                    "input": self.turn(1),
                    "responses": [
                        {
                            "headers": Wire.STREAM,
                            "body": [
                                {"data": role.replace("\n", "\r\n")},
                                {"data": "event: completion\r"},
                                {"data": "\ndata:" + json.dumps(Wire.chunk({"reasoning": "CR and CRLF."})) + "\r\r"},
                                {"data": "retry: 3000\nid: 7\n: a comment\nunknown: field\n"},
                                {
                                    "data": "data: "
                                    + json.dumps(Wire.chunk({"content": self.ANSWER}, "stop")).replace(
                                        ', "choices"', ',\ndata: "choices"'
                                    )
                                    + "\n\n"
                                },
                                Wire.DONE,
                            ],
                        }
                    ],
                },
            ],
        }

        plain = {
            "name": "answers without reasoning and without text",
            "about": "an answer alone has no reasoning kind; an empty answer that the model ended itself is returned",
            "client": self.client(),
            "clock": {"start": 10.0, "step": 0.125},
            "steps": [
                {"op": "infer", "input": self.turn(0), "responses": [Wire.stream([], [self.ANSWER])]},
                {
                    "op": "infer",
                    "input": self.turn(1),
                    "responses": [
                        {"headers": Wire.STREAM, "body": [Wire.event(Wire.chunk({"content": ""}, "stop")), Wire.DONE]}
                    ],
                },
                {
                    "op": "infer",
                    "input": self.turn(2),
                    "responses": [
                        {"headers": Wire.STREAM, "framing": "close", "body": [Wire.event(Wire.chunk({}, "stop"))]}
                    ],
                },
            ],
        }

        empty_key = {
            "name": "a key that is empty",
            "about": "a key file without a key: the SDK refuses to be made, before anything is sent or reported",
            "client": self.client(api_key=""),
            "clock": {"start": 10.0, "step": 0.125},
            "steps": [
                {"op": "check", "responses": [Wire.models(MODEL)]},
                {"op": "infer", "input": self.turn(0), "responses": [Wire.stream(["Never."], [self.ANSWER])]},
            ],
        }
        spaced_key = {
            "name": "a key with space around it",
            "about": "the key is sent without the whitespace around it",
            "client": self.client(api_key="  test-key \t"),
            "clock": {"start": 10.0, "step": 0.125},
            "steps": [
                {"op": "check", "responses": [Wire.models(MODEL)]},
                {"op": "infer", "input": self.turn(0), "responses": [Wire.stream([], [self.ANSWER])]},
            ],
        }

        return [
            three_turns,
            pacing,
            no_usage,
            final_usage,
            reasoning_fields,
            non_ascii,
            reference_images,
            retried_references,
            options,
            framing,
            plain,
            empty_key,
            spaced_key,
        ]

    def cache_misses(self) -> list[dict[str, Any]]:
        late = {
            "headers": Wire.STREAM,
            "body": [
                Wire.event(Wire.chunk({"reasoning": "visible thinking"})),
                Wire.event({"error": "Cache miss for image 3f2c and data is not provided"}),
            ],
        }
        in_stream = {"headers": Wire.STREAM, "body": [Wire.event(self.CACHE_MISS)]}
        one_phrase = {"error": {"message": "Cache miss for image 3f2c", "type": "BadRequestError"}}
        upper = {"error": {"message": "CACHE MISS FOR IMAGE 3f2c AND DATA IS NOT PROVIDED"}}

        return [
            {
                "name": "a cache miss is answered by sending the saved images once",
                "about": "the server lost the earlier frames: one notice, every frame of the history again with its "
                "data, the answer of the second request",
                "client": self.client(),
                "clock": {"start": 10.0, "step": 0.125},
                "steps": [
                    {"op": "infer", "input": self.turn(0), "responses": [Wire.stream(["One."], [self.ANSWER])]},
                    {"op": "infer", "input": self.turn(1), "responses": [Wire.stream(["Two."], [self.ANSWER])]},
                    {
                        "op": "infer",
                        "input": self.turn(2),
                        "responses": [Wire.refusal(400, self.CACHE_MISS), Wire.stream(["Three."], [self.ANSWER])],
                    },
                    {
                        "op": "infer",
                        "input": self.turn(3),
                        "responses": [Wire.refusal(400, upper), Wire.stream(["Four."], [self.ANSWER])],
                    },
                    {
                        "op": "infer",
                        "input": self.turn(4),
                        "responses": [in_stream, Wire.stream(["Five."], [self.ANSWER])],
                    },
                ],
            },
            {
                "name": "a cache miss is not answered twice, nor after output",
                "about": "a second miss, a miss after text has streamed and a refusal with one of the two phrases "
                "are errors; the history keeps what it held",
                "client": self.client(),
                "clock": {"start": 10.0, "step": 0.125},
                "steps": [
                    {"op": "infer", "input": self.turn(0), "responses": [Wire.stream(["One."], [self.ANSWER])]},
                    {
                        "op": "infer",
                        "input": self.turn(1),
                        "responses": [Wire.refusal(400, self.CACHE_MISS), Wire.refusal(400, self.CACHE_MISS)],
                    },
                    {"op": "infer", "input": self.turn(2), "responses": [late]},
                    {"op": "infer", "input": self.turn(3), "responses": [Wire.refusal(400, one_phrase)]},
                    {"op": "infer", "input": self.turn(4), "responses": [Wire.refusal(500, self.CACHE_MISS)]},
                    {"op": "infer", "input": self.turn(5), "responses": [Wire.stream(["Six."], [self.ANSWER])]},
                ],
            },
        ]

    def context_limits(self) -> list[dict[str, Any]]:
        def overflow(text: str, status: int = 400) -> dict[str, Any]:
            return Wire.refusal(status, {"error": {"message": text, "type": "BadRequestError", "code": status}})

        in_stream = {
            "headers": Wire.STREAM,
            "body": [
                Wire.event(Wire.chunk({"reasoning": "some"})),
                Wire.event({"error": {"message": "the request is past max_model_len", "code": 400}}),
            ],
        }
        vllm_text = (
            "This model's maximum context length is 191168 tokens. However, you requested 191200 tokens in the "
            "messages, Please reduce the length of the messages."
        )

        return [
            {
                "name": "a conversation past the context length",
                "about": "a bad request with one of the three markers, in any case, is a full context; another "
                "status is not; an error of the stream with a marker is",
                "client": self.client(),
                "clock": {"start": 10.0, "step": 0.125},
                "steps": [
                    {"op": "infer", "input": self.turn(0), "responses": [overflow(vllm_text)]},
                    {"op": "infer", "input": self.turn(1), "responses": [overflow("Maximum Context Length")]},
                    {"op": "infer", "input": self.turn(2), "responses": [overflow("max_model_len is 191168")]},
                    {"op": "infer", "input": self.turn(3), "responses": [overflow("Context length exceeded")]},
                    {"op": "infer", "input": self.turn(4), "responses": [overflow("maximum context length", 500)]},
                    {"op": "infer", "input": self.turn(5), "responses": [overflow("maximum context length", 422)]},
                    {"op": "infer", "input": self.turn(6), "responses": [in_stream]},
                    {"op": "infer", "input": self.turn(7), "responses": [overflow("context length", 400)]},
                    {"op": "infer", "input": self.turn(8), "responses": [Wire.stream(["Fits."], [self.ANSWER])]},
                ],
            },
            {
                "name": "an answer cut at a token limit",
                "about": "with no limit of the client's own the server cuts an answer only where the context ends",
                "client": self.client(),
                "clock": {"start": 10.0, "step": 0.125},
                "steps": [
                    {
                        "op": "infer",
                        "input": self.turn(0),
                        "responses": [Wire.stream(["Long."], ["cut he"], finish="length")],
                    },
                ],
            },
            {
                "name": "the image limit",
                "about": "a conversation that would hold more images than the limit is refused before it is sent",
                "client": self.client(options={"max_images": 2}),
                "clock": {"start": 10.0, "step": 0.125},
                "steps": [
                    {"op": "infer", "input": self.turn(0), "responses": [Wire.stream(["One."], [self.ANSWER])]},
                    {"op": "infer", "input": self.turn(1), "responses": [Wire.stream(["Two."], [self.ANSWER])]},
                    {"op": "infer", "input": self.turn(2), "responses": []},
                    {"op": "infer", "input": {**self.turn(3), "images": []}, "responses": [Wire.stream([], ["ok"])]},
                ],
            },
        ]

    def refusals(self) -> list[dict[str, Any]]:
        vllm_error = {
            "error": {
                "message": "1 validation error:\n  {'type': 'missing', 'loc': ('body', 'messages')}",
                "type": "BadRequestError",
                "param": None,
                "code": 400,
            }
        }
        texts = {
            "object": "error",
            "message": "It's \"quoted\" 中文 \U0001f916 café \x7f\x00\x1f \u00a0 \u200b \u2028 \\ end\n",
            "plain": "double \" only",
            "single": "single ' only",
            "empty": "",
        }
        values = {
            "numbers": [0, -1, 1.5, -0.0, 1e16, 1e-05, 123456789012345678901234567890, 2.0, 1e400, -1e400],
            "constants": [True, False, None],
            "nested": {"a": {"b": [[], {}, [{}]]}},
            "detail": [{"loc": ["body", "messages", 0], "msg": "field required", "type": "missing"}],
        }
        responses = [
            Wire.refusal(400, vllm_error),
            Wire.refusal(400, texts),
            Wire.refusal(400, "  plain text refusal \r\n", raw=True),
            Wire.refusal(401, {"error": "Unauthorized"}),
            Wire.refusal(403, {"detail": "Forbidden"}),
            Wire.refusal(404, "<html><body>Not Found</body></html>", raw=True),
            Wire.refusal(409, values),
            Wire.refusal(422, {"detail": values["detail"]}),
            Wire.refusal(429, {"error": {"message": "slow down"}}),
            Wire.refusal(500, {"error": {"message": "unavailable"}}),
            Wire.refusal(502, "bad gateway"),
            Wire.refusal(503, "", raw=True),
            Wire.refusal(418, 5),
            Wire.refusal(500, [1, 2.0, "x", None, True, {"k": []}]),
            Wire.refusal(500, '{"a": NaN, "b": Infinity, "c": -Infinity, "a": 1}', raw=True),
            Wire.refusal(500, " \n {\"padded\" : [ 1 , 2 ] } \n ", raw=True),
            Wire.refusal(500, '{"unfinished": ', raw=True),
            Wire.refusal(500, "null", raw=True),
            Wire.refusal(500, "true", raw=True),
            Wire.refusal(500, '"\\ud83e\\udd16 \\u00e9 \\ud800"', raw=True),
        ]
        steps = [{"op": "infer", "input": self.turn(0), "responses": [response]} for response in responses]
        steps.append({"op": "infer", "input": self.turn(1), "responses": [Wire.stream(["Fine."], [self.ANSWER])]})

        return [
            {
                "name": "refusals of each status",
                "about": "the error's class follows the status, its message is the status with Python's text of "
                "the decoded body, or the body's own text when it is no JSON; nothing joins the history",
                "client": self.client(),
                "clock": {"start": 10.0, "step": 0.125},
                "steps": steps,
            }
        ]

    def broken_streams(self) -> list[dict[str, Any]]:
        thinking = Wire.event(Wire.chunk({"reasoning": "visible thinking"}))
        text = Wire.event(Wire.chunk({"content": "partial"}))

        def stream(*body: dict[str, Any], **fields: Any) -> dict[str, Any]:
            return {"headers": Wire.STREAM, "body": list(body), **fields}

        not_a_stream = Wire.refusal(200, {"error": {"message": "not a stream"}})
        responses = {
            "reset before the answer": {"head": "reset"},
            "a chunked body cut": stream(thinking, end="cut"),
            "a chunked body reset": stream(thinking, text, end="reset"),
            "a body shorter than its length": stream(thinking, framing="length", missing_bytes=10),
            "a body that ends with the connection": stream(thinking, framing="close"),
            "an empty body": stream(),
            "[DONE] alone": stream(Wire.DONE),
            "no finish reason": stream(thinking, text, Wire.DONE),
            "another finish reason": stream(text, Wire.event(Wire.chunk({}, "tool_calls")), Wire.DONE),
            "JSON in place of a stream": not_a_stream,
            "a line that is no JSON": stream(thinking, {"data": "data: {not json}\n\n"}),
            "a line that is no UTF-8": stream(thinking, {"data": 'data: {"id": "\xe4\xb8"}\n\n'}, encoding="latin-1"),
            "an event without data": stream({"data": "event: ping\n\n"}),
            "an error of the stream": stream(thinking, Wire.event({"error": {"message": "boom in stream", "code": 500}})),
            "an error of the stream without a message": stream(Wire.event({"error": {"code": 1}})),
            "an error of the stream that is no text": stream(Wire.event({"error": {"message": 5}})),
            "an empty error": stream(Wire.event({"error": {}}), Wire.event(Wire.chunk({"content": "ok"}, "stop"))),
            "an error field in a chunk": stream(Wire.event(Wire.chunk({"content": "x"}, "stop", error=None))),
        }
        steps: list[dict[str, Any]] = [
            {"op": "infer", "label": "no listener", "input": self.turn(0), "responses": [], "base_url": "{closed}/v1"}
        ]
        steps += [
            {"op": "infer", "label": label, "input": self.turn(0), "responses": [response]}
            for label, response in responses.items()
        ]
        steps.append({"op": "infer", "input": self.turn(1), "responses": [Wire.stream(["Fine."], [self.ANSWER])]})

        return [
            {
                "name": "streams that break",
                "about": "a connection that fails is a connection error whether it fails before or within the "
                "stream; a stream that ends without the model's own stop is refused; nothing joins the history",
                "client": self.client(),
                "clock": {"start": 10.0, "step": 0.125},
                "steps": steps,
            },
            {
                "name": "an answer cut at the station's token limit",
                "about": "under a limit of the station's own, a length finish is an unfinished answer",
                "client": self.client(options={"max_output_tokens": 64}),
                "clock": {"start": 10.0, "step": 0.125},
                "steps": [
                    {
                        "op": "infer",
                        "input": self.turn(0),
                        "responses": [Wire.stream(["Long."], ["cut he"], finish="length")],
                    },
                ],
            },
        ]

    def malformed_chunks(self) -> list[dict[str, Any]]:
        def body(*values: Any) -> dict[str, Any]:
            return {"headers": Wire.STREAM, "body": [Wire.event(value) for value in values]}

        stop = Wire.chunk({"content": "ok"}, "stop")
        odd_usage = {
            "prompt_tokens": "many",
            "completion_tokens": 2.5,
            "prompt_tokens_details": {"cached_tokens": None},
        }
        listed_usage = {"prompt_tokens": 1, "completion_tokens": 2, "prompt_tokens_details": [3]}
        two_choices = [
            {"index": 0, "delta": {"content": "a"}},
            {"index": 1, "delta": {"content": "b", "reasoning": "r"}, "finish_reason": "stop"},
        ]
        responses = [
            ("no choices", body({"id": "c"})),
            ("choices that are null", body({"id": "c", "choices": None})),
            ("choices that are a number", body({"choices": 5})),
            ("a choice that is null", body({"choices": [None]})),
            ("a choice that is a number", body({"choices": [5]})),
            ("no delta", body({"choices": [{"index": 0, "finish_reason": "stop"}]})),
            ("a delta that is null", body({"choices": [{"index": 0, "delta": None, "finish_reason": "stop"}]})),
            ("a delta that is a list", body({"choices": [{"index": 0, "delta": [], "finish_reason": "stop"}]})),
            ("usage without counts", body({"choices": [], "usage": {"completion_tokens": 3}}, stop)),
            ("usage with other values", body({"choices": [], "usage": odd_usage}, stop)),
            ("usage that is a list", body({"choices": [], "usage": [1]})),
            ("cached tokens of a list", body({"choices": [], "usage": listed_usage}, stop)),
            ("a chunk that is a list", body([1, 2])),
            ("a chunk that is text", body("text")),
            ("a chunk that is null", body(None, stop)),
            ("a chunk that is a number", body(5)),
            ("content that is a number", body(Wire.chunk({"content": 5}, "stop"))),
            ("content that is a list", body(Wire.chunk({"content": ["part"]}, "stop"))),
            ("content that is zero", body(Wire.chunk({"content": 0, "reasoning": False}), stop)),
            ("reasoning that is a number", body(Wire.chunk({"reasoning": 1.5}))),
            ("a finish reason that is no text", body(Wire.chunk({"content": "x"}, 7))),
            ("two choices", body({"choices": two_choices})),
        ]
        steps = [
            {"op": "infer", "label": label, "input": self.turn(0), "responses": [response]}
            for label, response in responses
        ]

        return [
            {
                "name": "chunks that are no chunks",
                "about": "what a server that does not follow the API makes PEAR raise: the names and messages of "
                "Python's own errors, which a turn's result would carry",
                "client": self.client(),
                "clock": {"start": 10.0, "step": 0.125},
                "steps": steps,
            }
        ]

    def time_outs(self) -> list[dict[str, Any]]:
        thinking = Wire.event(Wire.chunk({"reasoning": "visible thinking"}))

        return [
            {
                "name": "a model that takes too long",
                "about": "past the client's time-out the request ends with Python's TimeoutError, whether nothing "
                "or some text has come; the history keeps what it held",
                "client": self.client(timeout_s=0.25),
                "clock": {"start": 10.0, "step": 0.125},
                "steps": [
                    {"op": "infer", "input": self.turn(0), "responses": [{"head": "hold"}]},
                    {
                        "op": "infer",
                        "input": self.turn(0),
                        "responses": [{"headers": Wire.STREAM, "body": [thinking, {"hold_s": 5.0}]}],
                    },
                    {"op": "infer", "input": self.turn(0), "responses": [Wire.stream(["In time."], [self.ANSWER])]},
                ],
            }
        ]

    def cancellations(self) -> list[dict[str, Any]]:
        thinking = Wire.event(Wire.chunk({"reasoning": "visible thinking"}))
        text = Wire.event(Wire.chunk({"content": "partial answer"}))
        held_after_thinking = {"headers": Wire.STREAM, "body": [thinking, {"hold_s": 5.0}]}
        held_after_text = {"headers": Wire.STREAM, "body": [thinking, text, {"hold_s": 5.0}]}
        whole = Wire.stream(["Whole."], [self.ANSWER])

        def step(responses: list[dict[str, Any]], **fields: Any) -> dict[str, Any]:
            return {"op": "infer", "input": self.turn(0), "responses": responses, **fields}

        return [
            {
                "name": "a stop in each phase of a request",
                "about": "the operator's cancellation: set before the request, before any answer, while the "
                "reasoning streams, while the answer streams, after a cache miss and at the last report; a "
                "stopped request leaves the history as it was, a complete answer is kept",
                "client": self.client(),
                "clock": {"start": 10.0, "step": 0.125},
                "steps": [
                    step([], cancelled_before=True),
                    step([{"head": "hold"}], triggers=[{"after_s": 0.1, "do": "set_cancellation"}]),
                    step([held_after_thinking], triggers=[{"on": "reasoning_delta", "count": 1, "do": "set_cancellation"}]),
                    step([held_after_text], triggers=[{"on": "answer_delta", "count": 1, "do": "set_cancellation"}]),
                    step(
                        [Wire.refusal(400, self.CACHE_MISS), whole],
                        triggers=[{"on": "notice", "count": 1, "do": "set_cancellation"}],
                    ),
                    step([{"delay_s": 0.3, **whole}], triggers=[{"on": "request_metrics", "count": 1, "do": "set_cancellation"}]),
                    step([whole], triggers=[{"on": "performance", "final": True, "do": "set_cancellation"}]),
                    step([whole]),
                ],
            },
            {
                "name": "a stop through the client",
                "about": "cancel() stops the running request as the operator's cancellation does; one before a "
                "request stops nothing; a second request while one runs is refused; close() stops the request, "
                "waits for it and forgets the conversation, and a closed client takes no request",
                "client": self.client(),
                "clock": {"start": 10.0, "step": 0.125},
                "steps": [
                    {"op": "cancel"},
                    step([whole]),
                    step([{"head": "hold"}], triggers=[{"after_s": 0.1, "do": "client_cancel"}]),
                    step([held_after_thinking], triggers=[{"on": "reasoning_delta", "count": 1, "do": "client_cancel"}]),
                    step([held_after_text], triggers=[{"on": "answer_delta", "count": 1, "do": "infer"}, {"after_s": 0.2, "do": "client_cancel"}]),
                    step([held_after_thinking], triggers=[{"on": "reasoning_delta", "count": 1, "do": "close"}]),
                    step([whole]),
                    {"op": "close"},
                    {"op": "check", "responses": [Wire.models(MODEL)]},
                ],
            },
        ]

    def health_checks(self) -> list[dict[str, Any]]:
        def check(response: dict[str, Any] | None, **fields: Any) -> dict[str, Any]:
            return {"op": "check", "responses": [] if response is None else [response], **fields}

        def answer(content_type: str, text: str) -> dict[str, Any]:
            return {"status": 200, "framing": "length", "headers": [["Content-Type", content_type]], "body": [{"data": text}]}

        html = answer("text/html", "<html></html>")
        text_json = answer("text/plain", json.dumps({"object": "list", "data": [{"id": MODEL}]}))

        return [
            {
                "name": "the health check",
                "about": "the model list of the server: connected when it lists the model; what each other answer "
                "raises",
                "client": self.client(),
                "clock": {"start": 10.0, "step": 0.125},
                "steps": [
                    check(Wire.models("draft", MODEL)),
                    check(Wire.models("draft")),
                    check(Wire.models()),
                    check(Wire.refusal(500, {"error": {"message": "loading the model"}})),
                    check(Wire.refusal(401, {"error": "Unauthorized"})),
                    check(None, base_url="{closed}/v1"),
                    check(Wire.refusal(200, "hello", raw=True)),
                    check(html),
                    check(text_json),
                    check(Wire.refusal(200, {"object": "list"})),
                    check(Wire.refusal(200, {"object": "list", "data": None})),
                    check(Wire.refusal(200, {"object": "list", "data": [{"object": "model"}, None]})),
                    check(Wire.refusal(200, [1])),
                    check({"head": "hold"}),
                ],
            }
        ]


class ClientRun:
    """Runs PEAR's VLLMClient through scenarios and records what it sends, emits, returns and raises."""

    def __init__(self, service: Service, directory: Path) -> None:
        self.service = service
        self.directory = directory
        self.file_count = 0

    def file(self, data: bytes) -> Path:
        self.file_count += 1
        path = self.directory / f"file-{self.file_count}"
        path.write_bytes(data)

        return path

    def url(self, template: str) -> str:
        return template.replace("{service}", self.service.origin).replace("{closed}", self.service.closed_origin)

    def new_client(self, arguments: dict[str, Any], base_url: str | None = None) -> VLLMClient:
        key_file = None if arguments["api_key"] is None else str(self.file((arguments["api_key"] + "\n").encode()))

        return VLLMClient(
            arguments["system_prompt"],
            timeout_s=arguments["timeout_s"],
            base_url=self.url(base_url or arguments["base_url"]),
            model=arguments["model"],
            api_key_file=key_file,
            **arguments["options"],
        )

    def model_input(self, spec: dict[str, Any]) -> ModelInput:
        images = tuple(
            CameraImage(image["camera_name"], self.file(base64.b64decode(image["data"])), image["uuid"])
            for image in spec["images"]
        )
        references = tuple(
            ReferenceImage(self.file(base64.b64decode(image["data"])), image["uuid"])
            for image in spec["reference_images"]
        )

        return ModelInput(spec["text"], images, references)

    def run(self, scenario: dict[str, Any]) -> dict[str, Any]:
        CLOCK.configure(scenario["clock"]["start"], scenario["clock"]["step"])
        client = self.new_client(scenario["client"])
        steps = []
        for spec in scenario["steps"]:
            step = copy.deepcopy(spec)
            reads = CLOCK.reads
            # a step may name another server: the conversation is the client's, so its address is set for the step
            saved_url = client.base_url
            if "base_url" in step:
                client.base_url = self.url(step["base_url"])
            self.service.begin(step.get("responses", []))
            try:
                if step["op"] == "infer":
                    self.infer(client, step)
                elif step["op"] == "check":
                    step["outcome"] = self.outcome(client.check)
                elif step["op"] == "close":
                    step["outcome"] = self.outcome(client.close)
                elif step["op"] == "cancel":
                    step["outcome"] = self.outcome(client.cancel)
            finally:
                client.base_url = saved_url
            step["requests"] = self.service.requests
            step["unused_responses"] = len(self.service.responses)
            step["clock_reads"] = CLOCK.reads - reads
            step["history"] = [message["role"] for message in client.history]
            steps.append(step)
        client.close()

        return {**scenario, "steps": steps}

    @staticmethod
    def outcome(call: Any) -> dict[str, Any]:
        try:
            value = call()
        except Exception as error:  # noqa: BLE001  (whatever PEAR raises is what is recorded)
            return {"raised": Errors.record(error)}
        if hasattr(value, "answer"):
            value = {
                "answer": value.answer,
                "reasoning": value.reasoning,
                "reasoning_kind": value.reasoning_kind,
                "usage": value.usage,
            }

        return {"returned": copy.deepcopy(value)}

    def infer(self, client: VLLMClient, step: dict[str, Any]) -> None:
        cancellation = threading.Event()
        if step.get("cancelled_before"):
            cancellation.set()
        events: list[list[Any]] = []
        counts: dict[str, int] = {}
        triggers = step.get("triggers", [])
        results: dict[int, Any] = {}
        threads: list[threading.Thread] = []
        model_input = self.model_input(step["input"])

        def fire(index: int, trigger: dict[str, Any]) -> None:
            action = trigger["do"]
            if action == "set_cancellation":
                cancellation.set()
            elif action == "client_cancel":
                client.cancel()
            elif action == "infer":
                # a second request, made from the handler of the first one's event
                results[index] = self.outcome(
                    lambda: client.infer(model_input, on_event=lambda *_: None, cancellation=threading.Event())
                )
            elif action == "close":
                # from a thread of its own: close waits for the request, which this handler is part of
                thread = threading.Thread(target=lambda: results.__setitem__(index, self.outcome(client.close)))
                thread.start()
                threads.append(thread)

        def on_event(kind: Any, data: dict[str, Any]) -> None:
            name = str(kind.value)
            events.append([name, copy.deepcopy(data)])
            counts[name] = counts.get(name, 0) + 1
            for index, trigger in enumerate(triggers):
                if trigger.get("on") != name:
                    continue
                if "count" in trigger and counts[name] != trigger["count"]:
                    continue
                if "final" in trigger and data.get("final") is not trigger["final"]:
                    continue
                fire(index, trigger)

        timers = [
            threading.Timer(trigger["after_s"], fire, (index, trigger))
            for index, trigger in enumerate(triggers)
            if "after_s" in trigger
        ]
        for timer in timers:
            timer.start()
        try:
            step["outcome"] = self.outcome(
                lambda: client.infer(model_input, on_event=on_event, cancellation=cancellation)
            )
        finally:
            for timer in timers:
                timer.join()
            for thread in threads:
                thread.join()
        step["events"] = events
        if results:
            step["trigger_outcomes"] = {str(index): result for index, result in sorted(results.items())}


class Raised:
    """The exceptions a scenario has a stand-in raise, by the name of their class: PEAR's own class where PEAR has
    one, Python's built-in one, or a class of that name where the scenario stands for a library's error (the agent
    loop reads an error's class name, its message and whether it is a ValueError, and nothing else)."""

    @classmethod
    def classes(cls) -> dict[str, type[BaseException]]:
        from pear.deploy.station.agent_loop.clients.client import ContextLimit, SessionLost
        from pear.deploy.station.exceptions import OperatorPaused

        return {
            "ContextLimit": ContextLimit,
            "SessionLost": SessionLost,
            "OperatorPaused": OperatorPaused,
            "ValueError": ValueError,
            "RuntimeError": RuntimeError,
            "TimeoutError": TimeoutError,
            "ConnectionError": ConnectionError,
        }

    @classmethod
    def make(cls, spec: dict[str, Any]) -> BaseException:
        """The exception of ``spec``: its type's name, its message and, for a class of the scenario's own, whether
        it is a ValueError."""
        known = cls.classes().get(spec["type"])
        if known is None:
            base = ValueError if spec.get("is_value_error") else Exception
            known = type(spec["type"], (base,), {})
        error = known(spec["message"]) if spec["message"] else known()
        if "details" in spec:
            error.details = spec["details"]

        return error


class CallRig:
    """PEAR's ModelCall on a scripted robot and a clock that only its waits advance, as PEAR's own tests of the wait
    run it: the worker's thread and its queue are stand-ins, so that every call of the robot and every wait happens
    in one order.

    A scenario: timeout_s; cancelled_before; wait_stationary ({"raises": error}); holding, what is_holding does at
    each call, the last entry again after it (true or false, {"raises": error}, or {"value": ..., "pause": true}:
    the operator pauses at that call); call, what the request does ({"delay_s", "returns"} or {"delay_s", "raises"},
    or {"never": true}); after_abort, what a request that has not ended does once it is stopped (the same forms).
    """

    CONTROL_PERIOD_S = 0.02
    START_S = 100.0

    def __init__(self, scenario: dict[str, Any]) -> None:
        self.scenario = scenario
        self.now = self.START_S
        self.log: list[list[Any]] = []
        self.cancellation = threading.Event()
        self.holding_calls = 0
        self.item: Any = None  # what the request ended with, once it is known
        self.available_at: float | None = None  # when the request ends, on the rig's clock; None: never
        self.is_aborted = False

    # the clock of the agent loop's module
    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        before = self.now
        self.now += seconds
        self.log.append(["pause", seconds, self.now - before])  # (what passed on the clock: its floats' own sum)

    def wait_ended(self, timeout: float) -> bool:
        """Waits until the request has ended, at most ``timeout``, as a queue's get and a thread's join do."""
        before = self.now
        has_ended = self.available_at is not None and self.available_at <= self.now + timeout
        self.now = max(self.now, self.available_at) if has_ended else self.now + timeout
        if self.now != before or not has_ended:
            self.log.append(["pause", timeout, self.now - before])

        return has_ended

    def has_ended(self) -> bool:
        return self.available_at is not None and self.available_at <= self.now

    # the robot
    control_period_s = CONTROL_PERIOD_S

    def wait_stationary(self, observation: Any = None, *, cancellation: Any = None) -> dict[str, Any]:
        self.log.append(["wait_stationary", observation["observation_id"], cancellation is self.cancellation])
        behaviour = self.scenario.get("wait_stationary")
        if behaviour:
            raise Raised.make(behaviour["raises"])

        return {}

    def is_holding(self, observation: Any) -> bool:
        behaviours = self.scenario["holding"]
        behaviour = behaviours[min(self.holding_calls, len(behaviours) - 1)]
        self.holding_calls += 1
        if isinstance(behaviour, dict):
            if behaviour.get("pause"):
                self.cancellation.set()
            if "raises" in behaviour:
                self.log.append(["is_holding", "raises"])
                raise Raised.make(behaviour["raises"])
            behaviour = behaviour["value"]
        self.log.append(["is_holding", behaviour])

        return behaviour

    def stop(self) -> None:
        self.log.append(["stop"])

    # the request
    def call(self) -> Any:
        self.log.append(["call"])
        return self.end_with(self.scenario["call"])

    def end_with(self, behaviour: dict[str, Any]) -> Any:
        """Sets when the request ends and returns or raises what it ends with, as the worker's thread would."""
        self.available_at = None if behaviour.get("never") else self.now + behaviour["delay_s"]
        if "raises" in behaviour:
            raise Raised.make(behaviour["raises"])

        return behaviour.get("returns")

    def abort(self) -> None:
        self.log.append(["abort"])
        self.is_aborted = True
        behaviour = self.scenario.get("after_abort")
        if behaviour and not self.has_ended():
            try:
                self.item = (True, self.end_with(behaviour))
            except BaseException as error:  # noqa: BLE001  (the request's error is what the queue holds)
                self.item = (False, error)

    def run(self) -> dict[str, Any]:
        import queue

        from pear.deploy.station.agent_loop import agent_loop as agent_loop_module
        from pear.deploy.station.agent_loop.agent_loop import ModelCall

        rig = self

        class RigQueue:
            def __init__(self, **_: Any) -> None:
                pass

            def put(self, item: Any) -> None:
                rig.item = item

            def get(self, *, timeout: float) -> Any:
                if not rig.wait_ended(timeout):
                    raise queue.Empty
                return rig.item

            def get_nowait(self) -> Any:
                if not rig.has_ended():
                    raise queue.Empty
                return rig.item

        class RigThread:
            def __init__(self, *, target: Any, **_: Any) -> None:
                self.target = target

            def start(self) -> None:
                self.target()  # the request is made at once; when it ends is the scenario's

            def join(self, timeout: float) -> None:
                rig.wait_ended(timeout)

            def is_alive(self) -> bool:
                return not rig.has_ended()

        saved = agent_loop_module.time, agent_loop_module.queue, agent_loop_module.threading
        agent_loop_module.time = SimpleNamespace(monotonic=self.monotonic, sleep=self.sleep)
        agent_loop_module.queue = SimpleNamespace(Queue=RigQueue, Empty=queue.Empty)
        agent_loop_module.threading = SimpleNamespace(Thread=RigThread, Event=threading.Event)
        if self.scenario.get("cancelled_before"):
            self.cancellation.set()
        try:
            outcome = ClientRun.outcome(
                lambda: ModelCall(
                    self,
                    {"observation_id": "reference"},
                    self.call,
                    timeout_s=self.scenario["timeout_s"],
                    cancellation=self.cancellation,
                    abort=self.abort,
                ).run()
            )
        finally:
            agent_loop_module.time, agent_loop_module.queue, agent_loop_module.threading = saved

        return {**self.scenario, "log": self.log, "outcome": outcome, "elapsed_s": self.now - self.START_S}

    @staticmethod
    def scenarios() -> list[dict[str, Any]]:
        answer = {"answer": "```json\n{}\n```", "reasoning": "", "reasoning_kind": "none", "usage": {}}
        lost = {"type": "SessionLost", "message": "Native interrupt could not be confirmed"}
        paused = {"type": "OperatorPaused", "message": "vLLM inference interrupted; no partial action is valid"}
        fault = {"type": "RuntimeError", "message": "Station fault: FAULT: Stale or invalid feedback, age=0.1200s"}
        moved = {"type": "ValueError", "message": "Observation invalidated by another operation"}

        def scenario(name: str, call: dict[str, Any], **fields: Any) -> dict[str, Any]:
            return {"name": name, "timeout_s": 60.0, "holding": [True], "call": call, **fields}

        return [
            scenario("the answer comes while the arm holds", {"delay_s": 0.05, "returns": answer}),
            scenario("the answer comes at once", {"delay_s": 0.0, "returns": answer}),
            scenario("the answer comes within a wait", {"delay_s": 0.031, "returns": answer}),
            scenario(
                "the answer waits for the arm to settle again",
                {"delay_s": 0.03, "returns": answer},
                holding=[True, True, False, False, False, True],
            ),
            scenario(
                "an arm that never settles again runs into the deadline",
                {"delay_s": 0.03, "returns": answer},
                holding=[True, False],
                timeout_s=0.11,
                after_abort={"delay_s": 0.0, "returns": answer},
            ),
            scenario(
                "no answer by the deadline, and the request ends once it is stopped",
                {"never": True},
                timeout_s=0.05,
                after_abort={"delay_s": 0.004, "raises": paused},
            ),
            scenario("no answer by the deadline, and the request does not end", {"never": True}, timeout_s=0.05),
            scenario(
                "no answer by the deadline, and the request has lost the conversation",
                {"never": True},
                timeout_s=0.05,
                after_abort={"delay_s": 0.5, "raises": lost},
            ),
            scenario(
                "a deadline of whole control periods",
                {"never": True},
                timeout_s=0.06,
                after_abort={"delay_s": 0.0, "returns": answer},
            ),
            scenario(
                "the request fails",
                {"delay_s": 0.03, "raises": {"type": "ConnectionError", "message": "network down"}},
            ),
            scenario("the request loses the conversation", {"delay_s": 0.03, "raises": lost}),
            scenario("the request fails at once", {"delay_s": 0.0, "raises": {"type": "ValueError", "message": "refused"}}),
            scenario("the operator paused before the call", {"delay_s": 0.05, "returns": answer}, cancelled_before=True),
            scenario(
                "the operator pauses while the model works",
                {"delay_s": 5.0, "returns": answer},
                holding=[True, True, {"value": True, "pause": True}],
                after_abort={"delay_s": 0.01, "raises": paused},
            ),
            scenario(
                "a pause does not hide a lost conversation",
                {"delay_s": 5.0, "returns": answer},
                holding=[True, True, {"value": True, "pause": True}],
                after_abort={"delay_s": 0.01, "raises": lost},
            ),
            scenario(
                "a pause discards an answer that has come",
                {"delay_s": 0.03, "returns": answer},
                holding=[True, True, {"value": False, "pause": True}],
            ),
            scenario(
                "a pause while the request has not ended and never does",
                {"never": True},
                holding=[True, {"value": True, "pause": True}],
            ),
            scenario(
                "the arm faults while the model works",
                {"delay_s": 5.0, "returns": answer},
                holding=[True, True, {"raises": fault}],
                after_abort={"delay_s": 0.0, "raises": paused},
            ),
            scenario(
                "another operation takes the arm once the answer has come",
                {"delay_s": 0.03, "returns": answer},
                holding=[True, True, {"raises": moved}],
            ),
            scenario(
                "the arm does not come to rest before the call",
                {"delay_s": 0.05, "returns": answer},
                wait_stationary={"raises": {"type": "RuntimeError", "message": "Open the station first"}},
            ),
        ]


class Jsonable:
    """A value of PEAR as JSON holds it."""

    @classmethod
    def of(cls, value: Any) -> Any:
        import enum

        import numpy as np

        if isinstance(value, dict):
            return {str(key): cls.of(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [cls.of(item) for item in value]
        if isinstance(value, np.ndarray):
            return value.tolist()
        if isinstance(value, np.generic):
            return value.item()
        if isinstance(value, enum.Enum):
            return value.value
        if isinstance(value, Path):
            return value.name  # (a file's name: its directory is this machine's)
        if hasattr(value, "model_dump"):
            return value.model_dump(mode="json")

        return value


class LoopRun:
    """PEAR's StationAgentLoop with PEAR's stand-in scripted client on PEAR's stepped stand-in SO-101, on the stand-in
    clock of PEAR's tests: everything the loop asks of the robot and reports, in order.

    A scenario is a list of operations on one session. A step's `model` is what the model does when it is asked, in
    order: {"emit": [kind, data]} reports an event; {"do": "wait_watch"} waits until the loop watches the request (it
    has looked at the robot's hold once); {"do": "pause"} sets the operator's cancellation; {"do": "advance_clock",
    "seconds", "times"} lets time pass; {"do": "wait_stop"} waits until the loop stops the request; {"do":
    "change_session" | "advance_generation" | "close_robot" | "move_arm"} changes the robot under the loop;
    {"return": output} answers and {"raise": error} fails. (The two waits make the order of what happens the
    script's own, whatever the machine's timing.) A step's `hooks` act when an event is reported: {"on":
    kind, "phase", "do": "pause" | "arm_failure" | "close_robot" | "advance_generation" | "step"}.
    """

    WAIT_S = 20.0  # (on the machine's clock) the longest this script waits for the loop to stop a request
    CONSOLE_PAUSE = "The operator interrupted this turn; remaining motion was cancelled."  # PEAR's console's words

    def __init__(self, clock: Any, ids: Ids, robot_ids: Ids, directory: Path) -> None:
        self.clock = clock
        self.ids = ids
        self.robot_ids = robot_ids
        self.directory = directory
        self.scenario_count = 0

    # ---- the recording robot ----

    def logged(self, robot: Any, current: dict[str, Any]) -> None:
        """Has every call the loop makes of ``robot`` join the trace of the step that runs, with what it returned or
        raised; the checks of the hold while the model works, whose number is the machine's, are counted apart."""
        depth = threading.local()

        def wrap(name: str, describe: Any) -> None:
            method = getattr(robot, name)

            def wrapper(*arguments: Any, **keywords: Any) -> Any:
                if getattr(depth, "value", 0):
                    return method(*arguments, **keywords)  # a call the robot makes of itself
                depth.value = 1
                entry: dict[str, Any] = {"call": name}
                try:
                    describe(entry, arguments, keywords)
                    try:
                        value = method(*arguments, **keywords)
                    except Exception as error:  # noqa: BLE001
                        entry["raised"] = self.error_record(error)
                        raise
                    entry.update(self.returned(name, value, robot))
                    return value
                finally:
                    depth.value = 0
                    current["trace"].append(["robot", entry])

            setattr(robot, name, wrapper)

        def wait_stationary(entry: dict[str, Any], arguments: tuple, keywords: dict) -> None:
            observation = arguments[0] if arguments else keywords.get("observation")
            entry["observation"] = None if observation is None else observation["observation_id"]
            entry["cancellation"] = keywords.get("cancellation") is not None

        def model_state(entry: dict[str, Any], arguments: tuple, keywords: dict) -> None:
            entry["joint_positions"] = Jsonable.of(arguments[0])
            entry["format_name"] = arguments[1]

        def execute(entry: dict[str, Any], arguments: tuple, keywords: dict) -> None:
            entry["action"] = Jsonable.of(arguments[0])
            entry["reference"] = keywords["reference_observation"]["observation_id"]
            entry["cancellation"] = keywords.get("cancellation") is not None
            entry["progress"] = []
            report_progress = keywords["report_progress"]

            def report(phase: Any) -> None:
                entry["progress"].append(phase.value)
                report_progress(phase)

            keywords["report_progress"] = report

        def failure_result(entry: dict[str, Any], arguments: tuple, keywords: dict) -> None:
            error = arguments[0]
            entry["error"] = {"type": type(error).__name__, "message": str(error)}
            entry["format_name"] = keywords["format_name"]
            entry["status"] = keywords["status"].value if "status" in keywords else None
            entry["snapshot"] = keywords.get("snapshot") is not None

        wrap("wait_stationary", wait_stationary)
        wrap("observe", lambda entry, arguments, keywords: None)
        wrap("model_state", model_state)
        wrap("stop", lambda entry, arguments, keywords: None)
        wrap("execute", execute)
        wrap("failure_result", failure_result)

        is_holding = robot.is_holding

        def counted(observation: Any) -> bool:
            current["holding"]["calls"] += 1
            try:
                return is_holding(observation)
            except Exception as error:  # noqa: BLE001
                current["holding"]["raised"] = self.error_record(error)
                raise

        robot.is_holding = counted

    @staticmethod
    def error_record(error: BaseException) -> dict[str, Any]:
        record = Errors.record(error)
        if getattr(error, "details", None):
            record["details"] = Jsonable.of(error.details)

        return record

    @staticmethod
    def returned(name: str, value: Any, robot: Any) -> dict[str, Any]:
        """What a call of the robot returned, as much of it as the loop reads or passes on."""
        if name == "observe":
            return {
                "returned": {
                    "observation_id": value["observation_id"],
                    "session_id": value["session_id"],
                    "captured_monotonic_s": value["captured_monotonic_s"],
                    "joint_positions": Jsonable.of(value["joint_positions"]),
                    "camera_timestamps": Jsonable.of(value["camera_timestamps"]),
                    "image_roles": sorted(value["images"]),
                }
            }
        if name == "model_state":
            return {"returned": value.model_dump()}
        if name in ("execute", "failure_result"):
            record = {"returned": value.to_record()}
            if name == "execute":
                record["diagnostics"] = Jsonable.of(robot.last_error_diagnostics)
            return record

        return {}

    # ---- a scenario ----

    def run(self, scenario: dict[str, Any]) -> dict[str, Any]:
        from config_files import ConfigFiles
        from stand_in_cameras import StandInCameras
        from stand_in_clients import StandInScriptedClient
        from stand_in_robots import SteppedStandInSO101Robot

        from pear.deploy.station.agent_loop.agent_loop import StationAgentLoop
        from pear.deploy.station.agent_loop.clients.schemas import ModelEvent, ModelOutput
        from pear.deploy.station.control.robots.so101.robot import SO101Robot
        from pear.deploy.station.exceptions import OperatorPaused

        self.scenario_count += 1
        print(f"task {self.scenario_count}: {scenario['name']}", file=sys.stderr)
        directory = self.directory / f"task-{self.scenario_count}"
        directory.mkdir()
        robot = SteppedStandInSO101Robot(ConfigFiles.load("so101"), cameras=StandInCameras(SO101Robot.CAMERAS))
        robot.open()
        self.clock.control_loop = robot.control_loop
        arm = robot.control_loop.driver.hardware

        references = []
        for index, image in enumerate(scenario.get("reference_images", [])):
            path = directory / f"reference-{index}.jpg"
            path.write_bytes(base64.b64decode(image["data"]))
            references.append(ReferenceImage(path, image["uuid"]))

        # the step that runs: what its model does, what happens at its events, and what it records
        current: dict[str, Any] = {}

        def answer(model_input: ModelInput, on_event: Any, request_cancellation: threading.Event) -> ModelOutput:
            current["model_inputs"].append(
                {
                    "text": model_input.text,
                    "images": [
                        {
                            "camera_name": image.camera_name,
                            "uuid": image.uuid,
                            "name": image.path.name,
                            "is_jpeg": image.path.read_bytes()[:2] == b"\xff\xd8",
                        }
                        for image in model_input.images
                    ],
                    "reference_images": [image.uuid for image in model_input.reference_images],
                }
            )
            for operation in current["spec"]["model"]:
                if "emit" in operation:
                    kind, data = operation["emit"]
                    on_event(ModelEvent(kind), copy.deepcopy(data))
                elif "return" in operation:
                    return ModelOutput(**operation["return"])
                elif "raise" in operation:
                    raise Raised.make(operation["raise"])
                elif operation["do"] == "wait_stop":
                    if not request_cancellation.wait(self.WAIT_S):
                        raise AssertionError("the loop did not stop the request")
                elif operation["do"] == "wait_watch":
                    # until the loop has looked at the hold once: it watches the request from then on
                    started = REAL_MONOTONIC()
                    while not current["holding"]["calls"]:
                        if REAL_MONOTONIC() - started > self.WAIT_S:
                            raise AssertionError("the loop did not watch the request")
                        threading.Event().wait(0.001)
                else:
                    act(operation)
            raise AssertionError("a model's script ends with what it returns or raises")

        def act(operation: dict[str, Any]) -> None:
            action = operation["do"]
            if action == "pause":
                current["cancellation"].set()
            elif action == "advance_clock":
                for _ in range(operation["times"]):
                    time.sleep(operation["seconds"])  # the stand-in clock: time passes and the control loop steps
            elif action == "change_session":
                robot.session_id = "another-session"
            elif action == "advance_generation":
                with robot.control_loop.lock:
                    robot.control_loop.generation += 1
            elif action == "close_robot":
                robot.close()
            elif action == "arm_failure":
                arm.failure = RuntimeError(operation["message"])
            elif action == "move_arm":
                # the arm is pushed: its reading moves and shows a velocity, at every reading from now on
                position = list(arm.position)
                position[operation["joint"]] += operation["offset"]
                arm.position = tuple(position)
                read = arm.read

                def moving() -> Any:
                    state = read()
                    velocity = [0.0] * len(state.velocity)
                    velocity[operation["joint"]] = operation["velocity"]
                    return type(state)(state.position, tuple(velocity), state.sampled_monotonic_s, state.sample_id)

                arm.read = moving
            elif action == "step":
                current["nested"].append(
                    ClientRun.outcome(
                        lambda: session.step(
                            cancellation=threading.Event(), on_event=lambda *_: None, attempt_id="nested"
                        )
                    )
                )
            else:
                raise AssertionError(f"unknown action {action}")

        def on_event(kind: Any, data: dict[str, Any]) -> None:
            name = str(kind.value)
            current["trace"].append(["event", name, Jsonable.of(self.without_paths(name, data))])
            for hook in current["spec"].get("hooks", []):
                if hook["on"] == name and ("phase" not in hook or data.get("phase") == hook["phase"]):
                    act(hook)

        client = StandInScriptedClient("system", answer, timeout_s=scenario.get("client_timeout_s", 60.0))
        session = StationAgentLoop(
            robot,
            client,
            action_format=SINGLE_ARM_POSE_FORMAT,
            timeout_s=scenario["timeout_s"],
            directory=directory,
            reference_images=tuple(references),
        )
        recorded: dict[str, Any] = {
            **scenario,
            "session_id": robot.session_id,
            "action_mode": robot.action_mode.value,
            "control_period_s": robot.control_period_s,
            "episode_id": session.episode_id,
            "client_label": client.LABEL,
            "steps": [],
        }
        self.logged(robot, current)

        try:
            for spec in scenario["steps"]:
                step = copy.deepcopy(spec)
                trace: list[Any] = []
                holding = {"calls": 0, "raised": None}
                current.clear()
                current.update(
                    spec=spec, trace=trace, holding=holding, model_inputs=[], nested=[], cancellation=threading.Event()
                )
                if spec["op"] == "step":
                    for setting, value in spec.get("arm", {}).items():
                        setattr(arm, setting, value)
                    if spec.get("cancelled_before"):
                        current["cancellation"].set()
                    step["outcome"] = self.result_outcome(
                        lambda: session.step(
                            cancellation=current["cancellation"], on_event=on_event, attempt_id=spec["attempt_id"]
                        )
                    )
                    step["model_inputs"] = current["model_inputs"]
                    if current["nested"]:
                        step["nested"] = current["nested"]
                    step["holding"] = {"checked": holding["calls"] > 0, "raised": holding["raised"]}
                elif spec["op"] == "record_interruption":
                    # as PEAR's console records an operator's pause of a turn whose model request was made
                    robot.wait_settled(self.WAIT_S)
                    step["outcome"] = self.result_outcome(
                        lambda: session.record(session.failure_result(OperatorPaused(self.CONSOLE_PAUSE)))
                    )
                elif spec["op"] == "recover":
                    # as the operator recovers a robot from a fault, before the task goes on
                    arm.failure = None
                    robot.recover()
                    robot.wait_settled(self.WAIT_S)
                elif spec["op"] == "settle":
                    robot.wait_settled(self.WAIT_S)
                elif spec["op"] == "close":
                    step["outcome"] = ClientRun.outcome(session.close)
                step["trace"] = trace
                step["state"] = self.state(session)
                recorded["steps"].append(step)
        finally:
            self.clock.control_loop = None
            robot.close()

        return recorded

    @staticmethod
    def without_paths(kind: str, data: dict[str, Any]) -> dict[str, Any]:
        """An event's data without this machine's directory: a frame's file by its name alone."""
        if kind != "observation":
            return data

        return {**data, "images": {camera: Path(path).name for camera, path in data["images"].items()}}

    @staticmethod
    def result_outcome(call: Any) -> dict[str, Any]:
        try:
            result = call()
        except Exception as error:  # noqa: BLE001
            return {"raised": LoopRun.error_record(error)}

        return {"returned": result.to_record()}

    @staticmethod
    def state(session: Any) -> dict[str, Any]:
        from dataclasses import asdict

        turn = session.last_turn

        return {
            "turn_count": session.turn_count,
            "blocked_reason": session.blocked_reason,
            "feedback": session._feedback,
            "previous_result": None if session.previous_result is None else session.previous_result.to_record(),
            "last_turn": None
            if turn is None
            else {
                "attempt_id": turn.attempt_id,
                "observation_id": turn.observation["observation_id"],
                "is_dispatched": turn.is_dispatched,
                "model_output": None if turn.model_output is None else asdict(turn.model_output),
                "station_result": None if turn.station_result is None else turn.station_result.to_record(),
            },
        }


class LoopScenarios:
    """The tasks PEAR's StationAgentLoop runs through on the stand-in SO-101."""

    CONTEXT_FULL = "vLLM context is full. History is preserved; clear the task to restart."
    USAGE = {"input": 1200, "output": 30, "context_limit": 260096}

    def __init__(self, ids: Ids) -> None:
        self.ids = ids

    def attempt(self) -> str:
        """An attempt id as PEAR's console gives a turn: twelve hexadecimal characters."""
        return self.ids.next().hex[:12]

    @staticmethod
    def action(width: float = 0.0, **arm: float) -> str:
        """An answer's json block with an action that changes ``arm`` and sets the gripper's ``width``."""
        value = {"arm": {"x": 0.0, "y": 0.0, "z": 0.0, "pitch": 0.0, "roll": 0.0, **arm}, "gripper": {"width": width}}

        return "```json\n" + json.dumps(value) + "\n```"

    @classmethod
    def says(cls, answer: str, reasoning: str = "Next move.") -> list[dict[str, Any]]:
        """What a model does that reasons, answers and reports its usage, as a client's events show it."""
        kind = "full" if reasoning else "none"
        script: list[dict[str, Any]] = []
        if reasoning:
            script.append({"emit": ["reasoning_delta", {"text": reasoning, "reasoning_kind": "full"}]})
        script.append({"emit": ["answer_delta", {"text": answer}]})
        script.append({"emit": ["usage", {**cls.USAGE, "final": True}]})
        script.append({"return": {"answer": answer, "reasoning": reasoning, "reasoning_kind": kind, "usage": cls.USAGE}})

        return script

    def step(self, model: list[dict[str, Any]], **fields: Any) -> dict[str, Any]:
        return {"op": "step", "attempt_id": self.attempt(), "model": model, **fields}

    def moves(self, **fields: Any) -> dict[str, Any]:
        """A turn whose model lifts the arm a little."""
        return self.step(self.says("Lifting.\n" + self.action(z=0.5)), **fields)

    def changed_under(self, *changes: dict[str, Any]) -> dict[str, Any]:
        """A turn during which the robot changes while the model works: the model reasons, the change happens, and
        the model answers only once the loop has stopped its request (so that what the loop sees first is the
        change, whatever the machine's timing)."""
        thought = {"emit": ["reasoning_delta", {"text": "Still thinking.", "reasoning_kind": "full"}]}
        watched = {"do": "wait_watch"}

        return self.step([thought, watched, *changes, {"do": "wait_stop"}, *self.says(self.action(z=0.5), "")])

    def all(self) -> list[dict[str, Any]]:
        def task(name: str, about: str, steps: list[dict[str, Any]], **fields: Any) -> dict[str, Any]:
            return {"name": name, "about": about, "timeout_s": 60.0, **fields, "steps": steps}

        lost = {"type": "SessionLost", "message": "Native interrupt could not be confirmed"}
        no_block = "I will move the arm to the cube."
        thinking = "<think>plan</think>\n" + self.action(z=0.5)
        missing_part = '```json\n{"arm": {"x": 0.0, "y": 0.0, "z": 0.5, "pitch": 0.0, "roll": 0.0}}\n```'
        not_json = '```json\n{"arm": {"x": 0.0, "y": 0.0, "z": 0.5, "pitch": 0.0, "roll": 0.0}, "gripper": {"width": }}\n```'
        trailing = self.action(z=0.5) + "\nDone."
        too_large = self.action(z=0.5).replace('"z": 0.5', '"z": 1' + "0" * 400)
        references = [
            {"uuid": str(self.ids.next()), "data": base64.b64encode(Frames.jpeg(900 + index)).decode("ascii")}
            for index in range(2)
        ]

        return [
            task(
                "completed moves",
                "four turns that complete: a lift, a move that closes the gripper, a hold that opens it, a hold; "
                "each turn shows the model the report of the one before",
                [
                    self.step(self.says("The cube is ahead.\n" + self.action(z=1.5), "The cube is ahead and below.")),
                    self.step(self.says(self.action(-1.0, x=1.0, z=-0.5), "Close on it.")),
                    self.step(self.says(self.action(1.0), "")),
                    self.step(self.says(self.action())),
                ],
            ),
            task(
                "answers without an action",
                "an answer that gives no action never reaches the robot: the next turn tells the model why",
                [
                    self.step(self.says(no_block)),
                    self.step(self.says(thinking)),
                    self.step(self.says(missing_part)),
                    self.step(self.says(not_json)),
                    self.step(self.says(trailing)),
                    self.step(self.says(too_large)),
                    self.step(self.says("")),
                    self.moves(),
                ],
            ),
            task(
                "targets out of reach",
                "the offline inverse kinematics refuse the whole action; the next turn says how far the arm can go",
                [
                    self.step(self.says(self.action(x=200.0))),
                    self.step(self.says(self.action(-1.0, pitch=2.5))),
                    self.moves(),
                ],
            ),
            task(
                "an action the robot rejects",
                "another operation took the arm between the answer and its action: the action is refused before "
                "anything is sent",
                [
                    self.moves(hooks=[{"on": "action", "do": "advance_generation"}]),
                    self.moves(),
                ],
            ),
            task(
                "a motion that fails",
                "the arm's bus fails while the action runs: a failed result, a robot in fault that takes no turn "
                "until it is recovered, then the report of the failure",
                [
                    self.moves(),
                    self.moves(hooks=[{"on": "phase", "phase": "Executing", "do": "arm_failure", "message": "stand-in bus failure"}]),
                    self.moves(),
                    {"op": "recover"},
                    self.moves(),
                ],
            ),
            task(
                "a jaw stopped on an object",
                "closing stops before the jaw is closed: the action completes without reaching its target",
                [
                    self.step(self.says(self.action(-1.0)), arm={"blocked_gripper_opening": 0.4}),
                    self.step(self.says(self.action(1.0)), arm={"blocked_gripper_opening": None}),
                    self.moves(),
                ],
            ),
            task(
                "the operator pauses",
                "a pause before a turn, while the model works, at its answer, at its action and while the robot "
                "moves; the console records the pause of a turn whose model was asked, and the next turn reports it",
                [
                    self.moves(cancelled_before=True),
                    self.step([
                        {"emit": ["reasoning_delta", {"text": "Thinking.", "reasoning_kind": "full"}]},
                        {"do": "wait_watch"},
                        {"do": "pause"},
                        {"do": "wait_stop"},
                        *self.says(self.action(z=0.5), ""),
                    ]),
                    {"op": "record_interruption"},
                    self.moves(hooks=[{"on": "model_output", "do": "pause"}]),
                    {"op": "record_interruption"},
                    self.moves(hooks=[{"on": "action", "do": "pause"}]),
                    self.moves(hooks=[{"on": "phase", "phase": "Executing", "do": "pause"}]),
                    {"op": "record_interruption"},
                    self.moves(),
                ],
            ),
            task(
                "the model fails",
                "a request that fails ends its turn with a failed result, or a rejected one for a ValueError, that "
                "carries the error's class name and message; the next turn reports it",
                [
                    self.step([{"raise": {"type": "APIConnectionError", "message": "Connection error."}}]),
                    self.step([{"raise": {"type": "ValueError", "message": "vLLM output did not finish normally: disconnected"}}]),
                    self.step([
                        {"emit": ["reasoning_delta", {"text": "Half a thought", "reasoning_kind": "full"}]},
                        {"raise": {"type": "InternalServerError", "message": "Error code: 500 - {'error': {'message': 'unavailable'}}"}},
                    ]),
                    self.step([{"raise": {"type": "TimeoutError", "message": ""}}]),
                    self.step([{"raise": {"type": "JSONDecodeError", "message": "Expecting value: line 1 column 1 (char 0)", "is_value_error": True}}]),
                    self.step([{"raise": {"type": "ConnectionError", "message": "network down"}}]),
                    self.moves(),
                ],
            ),
            task(
                "the model takes too long",
                "past the session's time-out the turn fails and the request is stopped; an answer that comes "
                "afterwards moves nothing",
                [
                    self.step([
                        {"do": "wait_watch"},
                        {"do": "advance_clock", "seconds": 0.02, "times": 3},
                        {"do": "wait_stop"},
                        *self.says(self.action(z=0.5)),
                    ]),
                    self.moves(),
                ],
                timeout_s=0.05,
            ),
            task(
                "a pause that loses the conversation",
                "the request could not be stopped cleanly: the session takes no further turn",
                [
                    self.moves(),
                    self.step([{"do": "wait_watch"}, {"do": "pause"}, {"do": "wait_stop"}, {"raise": lost}]),
                    self.moves(),
                    {"op": "close"},
                ],
            ),
            task(
                "a lost conversation",
                "a client that lost its conversation blocks the session",
                [self.step([{"raise": lost}]), self.moves()],
            ),
            task(
                "a full context",
                "the client's context limit blocks the session, which says why at every later step",
                [
                    self.moves(),
                    self.step([{"raise": {"type": "ContextLimit", "message": self.CONTEXT_FULL}}]),
                    self.moves(),
                    self.moves(cancelled_before=True),
                ],
            ),
            task(
                "a robot closed while it plans",
                "the robot's session ends between the answer and the motion: nothing moves, and no turn follows",
                [
                    self.moves(hooks=[{"on": "phase", "phase": "Planning", "do": "close_robot"}]),
                    self.moves(),
                ],
            ),
            task(
                "a robot closed while the model works",
                "the result of a turn on a closed robot carries no measurement",
                [self.changed_under({"do": "close_robot"})],
            ),
            task(
                "another session while the model works",
                "a turn whose observation is of another session is rejected",
                [self.changed_under({"do": "change_session"})],
            ),
            task(
                "another operation while the model works",
                "a turn whose observation another operation invalidated is rejected",
                [self.changed_under({"do": "advance_generation"}), self.moves()],
            ),
            task(
                "the arm is pushed while the model works",
                "motion during the hold faults the robot: the turn fails with the robot's own error, whose "
                "diagnostic is reported",
                [
                    self.changed_under(
                        {"do": "move_arm", "joint": 1, "offset": 0.05, "velocity": 0.5},
                        {"do": "advance_clock", "seconds": 0.02, "times": 250},
                    ),
                ],
            ),
            task(
                "a task's reference images",
                "every turn's input carries the task's images; the client sends them once",
                [self.moves(), self.moves()],
                reference_images=references,
            ),
            task(
                "a step while one runs, and a closed session",
                "a second step is refused while one runs; a closed session's client takes no request",
                [
                    self.moves(hooks=[{"on": "observation", "do": "step"}]),
                    {"op": "close"},
                    self.moves(),
                    self.moves(),
                ],
            ),
        ]


class Special:
    """Numbers JSON has no text for, as a fixture holds them: {"$float": "inf" | "-inf" | "nan"}."""

    @classmethod
    def encode(cls, value: Any) -> Any:
        import math

        if isinstance(value, float) and not math.isfinite(value):
            return {"$float": "nan" if math.isnan(value) else ("inf" if value > 0 else "-inf")}
        if isinstance(value, dict):
            return {key: cls.encode(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [cls.encode(item) for item in value]

        return value


class Parts:
    """The parts of PEAR's client and loop that need no service and no robot."""

    @staticmethod
    def arguments() -> list[dict[str, Any]]:
        """What the client makes of its arguments. `whole_float` marks a float that is a whole number, which Python
        refuses where a count is asked for and JavaScript cannot tell from the count."""
        cases: list[dict[str, Any]] = [
            {},
            {"base_url": "ftp://server/v1"},
            {"base_url": "http://name:word@server/v1"},
            {"model": ""},
            {"model": 5},
            {"max_output_tokens": 0},
            {"max_output_tokens": 1},
            {"max_output_tokens": None},
            {"context_limit": 1.5},
            {"context_limit": -1},
            {"context_limit": 4096.0, "whole_float": True},
            {"max_images": True},
            {"max_images": 0},
            {"temperature": 2.5},
            {"temperature": -0.1},
            {"temperature": 0},
            {"temperature": 2},
            {"temperature": "1"},
            {"temperature": True},
            {"temperature": float("nan")},
            {"top_p": 0},
            {"top_p": 1},
            {"top_p": 1.01},
            {"top_p": float("nan")},
            {"top_k": 1.5},
            {"top_k": 0},
            {"top_k": -1},
            {"top_k": 5.0, "whole_float": True},
            {"repetition_penalty": float("inf")},
            {"repetition_penalty": 0},
            {"repetition_penalty": 1.3},
            {"repetition_penalty": float("nan")},
            {"reasoning_effort": "low"},
            {"reasoning_effort": "xhigh"},
            {"model": "", "max_images": 0, "temperature": 9, "base_url": "ftp://x"},
            {"max_images": 0, "context_limit": 0, "max_output_tokens": 0},
            {"temperature": 9, "top_p": 9, "top_k": 1.5, "repetition_penalty": -1, "reasoning_effort": "low"},
        ]
        recorded = []
        for case in cases:
            options = {"base_url": "http://server/v1", "model": MODEL, **case}
            is_whole_float = options.pop("whole_float", False)
            outcome = ClientRun.outcome(lambda: VLLMClient("system", timeout_s=300.0, **options).base_url)  # noqa: B023
            recorded.append({"options": Special.encode(options), "whole_float": is_whole_float, "outcome": outcome})

        return recorded

    @staticmethod
    def service_urls() -> list[dict[str, Any]]:
        urls = [
            "http://server/v1",
            "http://server/v1/",
            "http://server/v1///",
            "https://Server.Example:8443/v1",
            "HTTP://server:8000/v1",
            "http://127.0.0.1:8000/v1",
            "http://[::1]:8000/v1",
            "http://[fe80::1%Eth0]:8000/v1",
            "http://server",
            "http://server/",
            "http://server?x=1",
            "http://server#fragment",
            "http://@server/v1",
            "http://name@server/v1",
            "http://name:word@server/v1",
            "http://:word@server/v1",
            "http://name:@server/v1",
            "http://a@b@server/v1",
            "http:///v1",
            "http://:8000/v1",
            "http:server/v1",
            "server/v1",
            "//server/v1",
            "ftp://server/v1",
            "ws://server/v1",
            "file:///models/x",
            "",
            "/",
            " http://server/v1",
            "\thttp://server/v1\n",
            "ht\ntp://server/v1",
            "http://ser\tver/v1",
            "http://server /v1",
            "http://[::1/v1",
            "http://::1]/v1",
            "http://server/v1 ",
            "1http://server/v1",
            "h+t.t-p://server/v1",
            "http://SERVER\u00c9/v1",
        ]

        return [{"url": url, "outcome": ClientRun.outcome(lambda: ModelClient._service_url(url))} for url in urls]  # noqa: B023

    @staticmethod
    def metrics() -> dict[str, Any]:
        from pear.deploy.station.agent_loop.clients.metrics import Performance, RequestStatus, TokenRate

        nan, infinity = float("nan"), float("inf")
        decode_samples: list[list[list[Any]]] = [
            [],
            [[20, 190]],
            [[20, 190.5]],
            [[11, 100], [21, 300]],
            [[20, None]],
            [[20, 190], [1, 190]],
            [[20, 190], [20, 0]],
            [[20, True]],
            [[20, "190"]],
            [[20, -1]],
            [[20, nan]],
            [[20, infinity]],
            [[None, 190]],
            [[True, 190]],
            [["20", 190]],
            [[0, 190]],
            [[1, 190]],
            [[2, 190]],
            [[2.5, 190]],
            [[20, 0.1], [20, 0.2], [20, 0.3]],
            [[3, 1125899906842624.25], [3, 0.1], [3, 2.5]],
            [[7, 0.1]] * 10,
            [[9, 1], [9, 0.25], [9, 2], [9, 0.125]],
        ]
        decode_rates = [
            {"samples": Special.encode(samples), "rate": Performance.decode_rate([tuple(sample) for sample in samples])}
            for samples in decode_samples
        ]
        # a float that is a whole number: Python does not count it as a number of tokens
        whole_floats = [
            {"samples": samples, "rate": Performance.decode_rate([tuple(sample) for sample in samples])}
            for samples in ([[20.0, 190]], [[20.0, 190.0]])
        ]

        token_reports: list[list[list[Any]]] = [
            [],
            [["a", 10, 1.0]],
            [["a", 10, 1.0], ["a", 30, 3.0]],
            [["a", 10, 0.0], ["a", 20, 1.0], ["b", 5, 5.0], ["b", 35, 7.0]],
            [["a", None, 1.0], ["a", 0, 2.0], ["a", True, 3.0], ["a", "5", 4.0]],
            [["a", 10, 1.0], ["a", 10, 2.0], ["a", 9, 3.0], ["a", 12, 3.5]],
            [["a", 5, 1.25], ["a", 6, 1.25]],
            [["a", 1, 0.1], ["a", 2, 0.2], ["b", 1, 0.3], ["b", 4, 0.6], ["c", 1, 0.7], ["c", 2, 1.1]],
            [["a", 1, 0.5], ["a", 3, 1125899906842624.75], ["b", 1, 0.25], ["b", 2, 0.35], ["c", 1, 1.1], ["c", 9, 2.5]],
            [["request", 0, 10.0], ["request", 3, 10.5], ["request", 40, 12.75]],
        ]
        token_rates = []
        for reports in token_reports:
            rate = TokenRate()
            for request_id, count, received_at in reports:
                rate.add(request_id, count, received_at)
            token_rates.append({"reports": reports, "rate": rate.tokens_per_second()})

        # (no float that is a whole number among them: JavaScript cannot tell one from an int, which Python adds
        # without compensation)
        sums = [
            [],
            [1, 2, 3],
            [0.1] * 10,
            [1, 0.1, 0.2],
            [1125899906842624.25, 0.1, -1125899906842624.25],
            [0.1, 1125899906842624.25, -1125899906842624.25],
            [1.5, 10**16, -(10**16)],
            [3, 4, 0.5, 5, 1e-3],
            [0.1, 0.2, 0.3],
            [1.7e308, 1.7e308, -1.7e308],
            [infinity, 1.5],
            [0.5, infinity, -infinity],
            [0.5, nan, 1.5],
            [2.5, -2.5],
            [0.1, 0.7, 1e-17, 3, 0.25],
        ]

        clock = SimpleNamespace(monotonic=lambda: 12.5)
        saved = metrics_module.time
        metrics_module.time = clock
        try:
            reports = [
                {
                    "start_time": start,
                    "first_output_s": first,
                    "usage": usage,
                    "status": status.value,
                    "report": Performance.report("vllm", start, first, usage, status=status),
                }
                for start, first, usage, status in (
                    (10.0, 0.5, {}, RequestStatus.COMPLETED),
                    (10.0, None, {"output": 20}, RequestStatus.STREAMING),
                    (12.5, 0.25, {"output": 20}, RequestStatus.COMPLETED),
                    (13.0, 0.25, {"output": 20}, RequestStatus.FAILED),
                    (0.0, 0.0, {"output": 0, "input": 5}, RequestStatus.INTERRUPTED),
                    (11.75, 0.125, {"output": None}, RequestStatus.STREAMING),
                )
            ]
        finally:
            metrics_module.time = saved

        return {
            "decode_rates": decode_rates,
            "whole_floats": whole_floats,
            "token_rates": token_rates,
            "sums": [{"values": Special.encode(values), "sum": Special.encode(sum(values))} for values in sums],
            "reports": {"now": 12.5, "cases": reports},
        }

    @staticmethod
    def health_checks() -> dict[str, Any]:
        """PEAR's HealthChecks over stand-in clients, on a clock the script sets: each operation with what it
        returned and how many clients had been made by then."""
        from pear.deploy.station.agent_loop.clients import health_checks as health_checks_module
        from pear.deploy.station.agent_loop.clients.health_checks import HealthChecks

        operations = [
            {"op": "get", "model": "a"},
            {"op": "check", "model": "a", "at": 100.0, "takes": 0.5, "answer": {"status": "ok", "message": "connected"}},
            {"op": "get", "model": "a"},
            {"op": "check", "model": "a", "at": 110.0, "takes": 0.5, "answer": {"raises": "must not be asked"}},
            {"op": "check", "model": "a", "at": 130.4, "takes": 0.5, "answer": {"raises": "must not be asked"}},
            {"op": "check", "model": "a", "at": 130.5, "takes": 0.25, "answer": {"raises": "Connection error."}},
            {"op": "get", "model": "a"},
            {"op": "check", "model": "b", "at": 131.0, "takes": 1.0, "answer": {"status": "ok", "message": "b"}},
            {"op": "check", "model": "a", "at": 132.0, "takes": 0.5, "is_forced": True, "answer": {"status": "ok", "message": "again"}},
            {"op": "check", "model": "a", "at": 132.25, "takes": 0.5, "is_forced": True, "answer": {"raises": "must not be asked"}},
            {"op": "check", "model": "a", "at": 132.5, "takes": 0.5, "is_forced": True, "answer": {"status": "ok", "message": "forced"}},
            {"op": "check", "model": "c", "at": 140.0, "takes": 0.0, "answer": {"unbuilt": "no such model"}},
            {"op": "get", "model": "c"},
            {"op": "check", "model": "a", "at": 163.0, "takes": 0.5, "answer": {"status": "ok", "message": "aged"}},
            {"op": "get", "model": "unknown"},
        ]
        clock = SimpleNamespace(now=0.0)
        saved = health_checks_module.time
        health_checks_module.time = SimpleNamespace(monotonic=lambda: clock.now)
        made: list[str] = []
        closed: list[str] = []
        current: dict[str, Any] = {}

        class CheckedClient(ModelClient):
            LABEL = "Checked"

            def __init__(self, model: str) -> None:
                super().__init__("", timeout_s=1.0)
                self.model = model

            def check(self) -> Any:
                clock.now += current["takes"]
                if "raises" in current["answer"]:
                    raise RuntimeError(current["answer"]["raises"])
                return dict(current["answer"])

            def close(self) -> None:
                closed.append(self.model)
                super().close()

            async def _infer_async(self, *_: Any) -> Any:
                raise AssertionError("a client that checks a connection takes no request")

        def new_client(model: str) -> ModelClient:
            if "unbuilt" in current["answer"]:
                raise ValueError(current["answer"]["unbuilt"])
            made.append(model)
            return CheckedClient(model)

        checks = HealthChecks(new_client)
        recorded = []
        try:
            for operation in operations:
                current.clear()
                current.update(operation)
                if operation["op"] == "get":
                    outcome = {"returned": dict(checks.get(operation["model"]))}
                else:
                    clock.now = operation["at"]
                    outcome = ClientRun.outcome(
                        lambda: checks.check(operation["model"], is_forced=operation.get("is_forced", False))  # noqa: B023
                    )
                recorded.append({**operation, "outcome": outcome, "made": len(made), "closed": len(closed)})
        finally:
            health_checks_module.time = saved

        return {
            "max_age_s": HealthChecks.MAX_AGE_S,
            "unchecked": dict(HealthChecks.UNCHECKED_HEALTH),
            "operations": recorded,
        }

    @staticmethod
    def texts() -> dict[str, Any]:
        """Python's own texts: repr() of strings, str() of decoded JSON, bytes.decode, and the size of compact JSON."""
        generator = random.Random(SEED)
        strings = [
            "",
            "plain",
            "it's",
            'say "hi"',
            "both ' and \"",
            "back\\slash",
            "tab\there\nnew\rreturn",
            "\x00\x01\x07\x08\x0b\x0c\x1b\x1f\x7f",
            "\x80\x85\x9f\xa0\xad\xff",
            "caf\u00e9 \u4e2d\u6587 \u3042 \u0416",
            "\u200b\u200e\u2028\u2029\u202f\u2060\ufeff\ufffd\ufffe\uffff",
            "\u0378\u0379 \u0530 \u1680 \u180e \u3000",
            "\U0001f916 \U0001f600 \U00010000 \U0001f1f9\U0001f1fc",
            "\U000e0001 \U000f0000 \U0010ffff \U0002ebf0 \U0002ffff \U00030000 \U000323af \U000323b0",
            "\ud800 \udfff \udc00\ud800",
            "\u0301combining \u1ab0",
        ]
        def code_point() -> int:
            # of the Latin scripts, of the scripts before the ideographs, or any
            return generator.choice((generator.randrange(0x250), generator.randrange(0x3400), generator.randrange(0x110000)))

        for _ in range(60):
            strings.append("".join(chr(code_point()) for _ in range(generator.randrange(1, 12))))
        documents = [
            "null",
            "true",
            "[]",
            "{}",
            '"text"',
            "0",
            "-0",
            "-0.0",
            "1.0",
            "1e5",
            "1E+5",
            "1e16",
            "1e-5",
            "0.1",
            "123456789012345678901234567890",
            "1e400",
            "-1e400",
            "NaN",
            '{"a": 1, "b": [true, false, null], "c": {"d": "e"}}',
            '{"a": 1, "a": 2, "b": 3, "a": 4}',
            '[1, [2, [3, [4, []]]], {"k": {}}]',
            '{"message": "It\'s \\"quoted\\" \\u4e2d \\ud83e\\udd16 \\u0000 \\u007f \\n", "code": 400.0}',
            '["\\ud800", "\\udc00\\ud800", "a\\\\b"]',
            ' \n\t {"padded" : [ 1 , 2 ] } \r\n',
        ]
        broken = ["", "{", "[1,]", "{'a': 1}", "nul", '{"a" 1}', '"unterminated', "[1] 2", "\ufeff{}", "tru", "-", "01"]
        byte_strings = [
            b"",
            b"plain",
            "caf\u00e9 \u4e2d\u6587 \U0001f916".encode(),
            b"\xef\xbb\xbfbom",
            b"\x80",
            b"abc\xff",
            b"\xc3",
            b"ab\xc3\x28",
            b"\xe4\xb8",
            b"\xe4\x28\xa1",
            b"\xe4\xb8\x28",
            b"\xf0\x9f\x98",
            b"\xf0\x9f",
            b"\xf0",
            b"\xf0\x28\x8c\xbc",
            b"\xf0\x90\x28\xbc",
            b"\xf0\x90\x8c\x28",
            b"\xed\xa0\x80",
            b"\xed\x9f\xbf",
            b"\xe0\x80\x80",
            b"\xe0\xa0\x80",
            b"\xc0\xaf",
            b"\xc1\xbf",
            b"\xc2\x80",
            b"\xf5\x80\x80\x80",
            b"\xf4\x90\x80\x80",
            b"\xf4\x8f\xbf\xbf",
            b"\xf0\x80\x80\x80",
            b"\xf0\x90\x80\x80",
            b"ok \xe4\xb8\xad \xe4",
            b"\xe0\x80",
            b"\xed\xa0",
            b"\xf0\x80",
            b"\xf4\x90",
            b"\xf4\x8f\x28",
            b"\xfe\xff",
        ]
        def byte() -> int:
            # of ASCII, or beyond it
            return generator.choice((generator.randrange(0x80), generator.randrange(0x80, 0x100)))

        for _ in range(60):
            byte_strings.append(bytes(byte() for _ in range(generator.randrange(1, 7))))

        def decode(data: bytes) -> dict[str, Any]:
            outcome = ClientRun.outcome(lambda: data.decode("utf-8"))

            return {"bytes": base64.b64encode(data).decode("ascii"), "outcome": outcome}

        parts = [
            {"type": "text", "text": 'quote " back \\ tab \t line \n'},
            {"type": "image_url", "image_url": None, "uuid": "u"},
        ]
        values = [
            [{"role": "system", "content": "plain"}],
            [{"role": "user", "content": parts}],
            {"text": "\x00\x1f\x7f\x80 caf\u00e9 \u4e2d \U0001f916 \u2028 \b\f\r"},
            {"empty": "", "list": [], "dict": {}, "nested": [[], [{}], [None, True, False]]},
            [],
            {},
            "",
            None,
        ]

        return {
            "reprs": [[text, repr(text)] for text in strings],
            "documents": [{"text": text, "str": str(json.loads(text)), "repr": repr(json.loads(text))} for text in documents],
            "broken": [{"text": text, "outcome": ClientRun.outcome(lambda: json.loads(text))} for text in broken],  # noqa: B023
            "utf8": [decode(data) for data in byte_strings],
            "json_lengths": [
                {"value": value, "length": len(json.dumps(value, separators=(",", ":")).encode())} for value in values
            ],
        }

    @staticmethod
    def event_streams() -> list[dict[str, Any]]:
        """The SDK's own decoder of a server-sent event stream, on streams in pieces."""
        from openai._streaming import SSEDecoder

        generator = random.Random(SEED + 7)
        streams = [
            b"data: one\n\ndata: two\n\n",
            b"data: one\r\n\r\ndata: two\r\rdata: three\n\n",
            b": comment\n\nevent: named\ndata: {\"a\": 1}\nid: 7\nretry: 3000\n\ndata: after\n\n",
            b"data: first line\ndata: second line\n\ndata\n\ndata:\n\ndata:no space\n\ndata:  two spaces\n\n",
            b"id: 1\n\nid: \n\ndata: x\n\nid: with\x00null\n\n",
            b"retry: abc\n\nretry: 12\n\nretry: 1_000\n\nretry:  +7 \n\nretry: 1.5\n\nretry: -3\n\nretry: 1__0\n\n",
            b"unknown: field\nevent\ndata: x\n\nevent: \ndata: y\n\n",
            "data: caf\u00e9 \u4e2d\u6587 \U0001f916\n\n".encode(),
            b"data: no end",
            b"data: ends with CR\r",
            b"\n\n\ndata: after blank lines\n\n\n",
            b"data: [DONE]\n\ndata: more\n\n",
            b"\r\ndata: x\r\n\r\n",
            b"event: only\n\n\n\nid: 5\n\n\n\n",
        ]
        cases = []
        for stream in streams:
            splits = [[stream], [stream[index : index + 1] for index in range(len(stream))]]
            for _ in range(4):
                cuts = sorted(generator.randrange(len(stream) + 1) for _ in range(generator.randrange(1, 6)))
                splits.append([stream[start:end] for start, end in zip([0, *cuts], [*cuts, len(stream)])])
            for pieces in splits:
                events = [
                    {"event": sse.event, "data": sse.data, "id": sse.id, "retry": sse.retry}
                    for sse in SSEDecoder().iter_bytes(iter(pieces))
                ]
                cases.append({"pieces": [base64.b64encode(piece).decode("ascii") for piece in pieces], "events": events})

        return cases

    @staticmethod
    def sessions() -> list[dict[str, Any]]:
        """What a model session refuses to be made on."""
        from pear.deploy.station.agent_loop.agent_loop import StationAgentLoop

        cases = [
            {"action_mode": "cartesian", "session_id": "session", "timeout_s": 60.0},
            {"action_mode": "joint", "session_id": "session", "timeout_s": 60.0},
            {"action_mode": "unknown", "session_id": "session", "timeout_s": 60.0},
            {"action_mode": "cartesian", "session_id": None, "timeout_s": 60.0},
            {"action_mode": "joint", "session_id": None, "timeout_s": 0},
            {"action_mode": "cartesian", "session_id": "session", "timeout_s": 0},
            {"action_mode": "cartesian", "session_id": "session", "timeout_s": -1},
            {"action_mode": "cartesian", "session_id": "session", "timeout_s": float("nan")},
            {"action_mode": "cartesian", "session_id": "session", "timeout_s": float("inf")},
            {"action_mode": "cartesian", "session_id": "session", "timeout_s": 0.001},
        ]
        recorded = []
        with tempfile.TemporaryDirectory() as directory:
            for case in cases:
                robot = SimpleNamespace(action_mode=case["action_mode"], session_id=case["session_id"])
                outcome = ClientRun.outcome(
                    lambda: StationAgentLoop(  # noqa: B023
                        robot,  # noqa: B023
                        None,
                        action_format=SINGLE_ARM_POSE_FORMAT,
                        timeout_s=case["timeout_s"],  # noqa: B023
                        directory=Path(directory),
                        reference_images=(),
                    ).turn_count
                )
                recorded.append({**Special.encode(case), "outcome": outcome})

        return recorded

    @staticmethod
    def models() -> dict[str, Any]:
        """What PEAR's models of a station's configuration accept and refuse."""
        from pear.deploy.station.agent_loop.config import ModelsConfig, OfferedModel
        from pear.deploy.station.control.robots.so101.robot import SO101Robot

        vllm = "pear.deploy.station.agent_loop.clients.vllm.VLLMClient"
        robot = "pear.deploy.station.control.robots.so101.robot.SO101Robot"
        served = {"label": "Qwen3.8-27B", "client_class": vllm, "client": {"base_url": "http://server:8000/v1", "model": MODEL}}
        cases: list[dict[str, Any]] = [
            {"default_model": "served", "models": {"served": served}},
            {"default_model": "served", "models": {"served": {**served, "timeout_s": 1800, "action_format": "single_arm_pose"}}},
            {"default_model": "other", "models": {"served": served, "second": {**served, "label": "Second"}}},
            {"default_model": "it's", "models": {"served": served}},
            {"default_model": "served", "models": {"served": {**served, "label": ""}}},
            {"default_model": "served", "models": {"served": {**served, "timeout_s": 0}}},
            {"default_model": "served", "models": {"served": {**served, "timeout_s": 1800.5}}},
            {"default_model": "served", "models": {"served": {**served, "client_class": "builtins.dict"}}},
            {"default_model": "served", "models": {"served": {**served, "client": {"base_url": "ftp://server", "model": MODEL}}}},
            {"default_model": "served", "models": {"served": {**served, "client": {"base_url": "http://server/v1", "model": MODEL, "top_p": 0}}}},
            {"default_model": "served", "models": {"served": {**served, "action_format": "bimanual_pose"}}},
            {"default_model": "served", "models": {"first": {**served, "label": ""}, "served": {**served, "timeout_s": 0}}},
        ]
        recorded = []
        for case in cases:
            def make() -> dict[str, Any]:
                config = ModelsConfig(
                    robot_class=robot,
                    config_dir=".",
                    default_model=case["default_model"],  # noqa: B023
                    models={name: OfferedModel(**fields) for name, fields in case["models"].items()},  # noqa: B023
                )
                names = list(config.models)
                clients = {name: type(config.models[name].new_client("prompt")).__name__ for name in names}
                return {
                    "formats": {name: config.action_format(name).name for name in names},
                    "timeouts": {name: config.models[name].timeout_s for name in names},
                    "clients": clients,
                    "require_unknown": ClientRun.outcome(lambda: config.require("nope")),
                }

            recorded.append({**case, "outcome": ClientRun.outcome(make)})

        return {
            "robot": {"title": SO101Robot.TITLE, "formats": list(SO101Robot.ACTION_FORMATS)},
            "max_timeout_s": OfferedModel.MAX_TIMEOUT_S,
            "default_timeout_s": OfferedModel(label="x", client_class=vllm, client={}).timeout_s,
            "cases": recorded,
        }

    @classmethod
    def frames(cls) -> dict[str, Any]:
        """ObservationMessage.build: which frames a turn carries, in what order and under what names, and the check
        of their times."""
        import numpy as np

        from pear.deploy.station.agent_loop.clients import schemas as schemas_module
        from pear.deploy.station.agent_loop.messages import JPEG_QUALITY, ObservationMessage
        from pear.deploy.station.control.robots.so101.motion.actions import ModelState
        from pear.deploy.station.control.robots.yam.formats import BIMANUAL_POSE

        ids = Ids(SEED + 5)
        drawn: list[Any] = []  # the UUIDs given so far: one for each frame that joined a turn
        saved = schemas_module.uuid4
        schemas_module.uuid4 = lambda: drawn.append(ids.next()) or drawn[-1]
        state = ModelState.model_validate(
            {"arm": {"x": 22.7, "y": 0.8, "z": 20.8, "pitch": 0.69, "roll": -1.66}, "gripper": {"width": 6.0}}
        )

        def build(action_format: Any, observation: dict[str, Any], attempt_id: str, references: int = 0) -> dict[str, Any]:
            with tempfile.TemporaryDirectory() as directory:
                reference_images = tuple(
                    ReferenceImage(Path(directory) / f"goal-{index}.jpg", f"reference-{index}") for index in range(references)
                )
                model_input = ObservationMessage.build(
                    observation, state, action_format, Path(directory), attempt_id, None, reference_images
                )
                return {
                    "images": [
                        {
                            "camera_name": image.camera_name,
                            "uuid": image.uuid,
                            "name": image.path.name,
                            "is_jpeg": image.path.read_bytes()[:2] == b"\xff\xd8",
                        }
                        for image in model_input.images
                    ],
                    "reference_images": [image.uuid for image in model_input.reference_images],
                }

        def observation(roles: list[str], captured: float, received: dict[str, float]) -> dict[str, Any]:
            return {
                "images": {role: np.zeros((4, 8, 3), dtype=np.uint8) for role in roles},
                "camera_timestamps": {role: {"received_monotonic_s": time_s, "frame_number": 3} for role, time_s in received.items()},
                "captured_monotonic_s": captured,
            }

        formats = {
            "single_arm_pose": SINGLE_ARM_POSE_FORMAT,
            "bimanual_pose": BIMANUAL_POSE,
        }
        cameras = {
            name: [{"role": camera.role, "name": camera.name, "label": camera.label} for camera in action_format.cameras]
            for name, action_format in formats.items()
        }
        three = [camera.role for camera in BIMANUAL_POSE.cameras]
        cases = [
            {"format": "single_arm_pose", "roles": ["wrist"], "captured": 5.0, "received": {"wrist": 4.9}, "attempt_id": "a1b2c3d4e5f6"},
            {"format": "single_arm_pose", "roles": ["wrist"], "captured": 5.0, "received": {"wrist": 5.0}, "attempt_id": "turn"},
            {"format": "single_arm_pose", "roles": ["wrist"], "captured": 5.0, "received": {"wrist": 5.000001}, "attempt_id": "turn"},
            {"format": "single_arm_pose", "roles": ["wrist", "extra"], "captured": 5.0, "received": {"wrist": 1.0, "extra": 9.0}, "attempt_id": "turn", "references": 2},
            {"format": "single_arm_pose", "roles": [], "captured": 5.0, "received": {"wrist": 1.0}, "attempt_id": "turn"},
            {"format": "single_arm_pose", "roles": ["wrist"], "captured": 5.0, "received": {}, "attempt_id": "turn"},
            {"format": "bimanual_pose", "roles": three, "captured": 5.0, "received": dict.fromkeys(three, 4.0), "attempt_id": "t3"},
            {"format": "bimanual_pose", "roles": list(reversed(three)), "captured": 5.0, "received": dict.fromkeys(three, 4.0), "attempt_id": "t3"},
            {"format": "bimanual_pose", "roles": three, "captured": 5.0, "received": {three[0]: 4.0, three[1]: 4.0, three[2]: 6.0}, "attempt_id": "t3"},
            {"format": "bimanual_pose", "roles": three, "captured": 5.0, "received": {three[0]: 4.0, three[1]: 6.0, three[2]: 4.0}, "attempt_id": "t3"},
            {"format": "bimanual_pose", "roles": three[:2], "captured": 5.0, "received": dict.fromkeys(three, 4.0), "attempt_id": "t3"},
        ]
        recorded = []
        try:
            for case in cases:
                before = len(drawn)
                outcome = ClientRun.outcome(
                    lambda: build(  # noqa: B023
                        formats[case["format"]],  # noqa: B023
                        observation(case["roles"], case["captured"], case["received"]),  # noqa: B023
                        case["attempt_id"],  # noqa: B023
                        case.get("references", 0),  # noqa: B023
                    )
                )
                uuids = [str(value) for value in drawn[before:]]
                recorded.append({**case, "uuids": uuids, "outcome": outcome})
        finally:
            schemas_module.uuid4 = saved

        return {"jpeg_quality": JPEG_QUALITY, "cameras": cameras, "cases": recorded}


class Fixtures:
    """Writes each fixture file: ASCII only, one scenario or case a line where a file holds several."""

    directory = FIXTURES  # where the files go: the committed fixtures unless --output names another place

    @staticmethod
    def machine_words() -> list[str]:
        """What no fixture may hold: the directories of this machine that the script works in, and its name."""
        words = {
            tempfile.gettempdir(),
            str(Path.home()),
            str(PEAR_PACKAGE.parent),
            str(REPOSITORY),
            sys.prefix,
            socket.gethostname(),
        }

        return sorted(word for word in words if len(word) > 3)

    @classmethod
    def write(
        cls,
        name: str,
        fields: dict[str, Any],
        cases: list[Any] | None = None,
        key: str = "cases",
        *,
        is_wide: bool = False,
    ) -> None:
        """Writes ``fields`` and, after them, ``cases`` under ``key`` one a line; without cases, ``fields`` indented,
        or one field a line when ``is_wide``."""
        cls.directory.mkdir(parents=True, exist_ok=True)
        if cases is None and is_wide:
            entries = [f" {json.dumps(name_)}: {json.dumps(value, ensure_ascii=True)}" for name_, value in fields.items()]
            text = "{\n" + ",\n".join(entries) + "\n}\n"
        elif cases is None:
            text = json.dumps(fields, ensure_ascii=True, indent=1) + "\n"
        else:
            entries = [f" {json.dumps(name_)}: {json.dumps(value, ensure_ascii=True)}" for name_, value in fields.items()]
            lines = ",\n".join("  " + json.dumps(case, ensure_ascii=True) for case in cases)
            entries.append(f' {json.dumps(key)}: [\n{lines}\n ]')
            text = "{\n" + ",\n".join(entries) + "\n}\n"
        json.loads(text)  # (raises unless the file is JSON)
        for word in cls.machine_words():
            if word in text:
                sys.exit(f"{name} would hold a directory or the name of this machine ({len(word)} characters)")
        (cls.directory / name).write_text(text, encoding="ascii", newline="\n")
        print(f"{name}: {'no' if cases is None else len(cases)} {key}, {len(text)} bytes")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sync-tables", action="store_true", help="write the table of Python's str.isprintable first")
    parser.add_argument("--output", type=Path, help="write there instead of tests/fixtures/agent")
    arguments = parser.parse_args()
    if arguments.output is not None:
        Fixtures.directory = arguments.output

    commit, pinned = Commit.of_pear(), Commit.pinned()
    if commit is not None and commit != pinned:
        sys.exit(f"This PEAR is at {commit}; src/index.ts pins {pinned}")
    if arguments.sync_tables:
        Tables.sync()
    printable = Tables.check()

    # the clock of PEAR's client modules: one step later at every reading
    stand_in_time = SimpleNamespace(monotonic=CLOCK.monotonic)
    client_module.time = vllm_module.time = metrics_module.time = stand_in_time

    ids = Ids(SEED)
    service = Service()
    try:
        with tempfile.TemporaryDirectory() as directory:
            run = ClientRun(service, Path(directory))
            scenarios = [run.run(scenario) for scenario in ClientScenarios(ids).all()]
    finally:
        service.close()
    Fixtures.write("client.json", {}, scenarios, key="scenarios")
    steps = [step for scenario in scenarios for step in scenario["steps"]]
    raised = sum("raised" in step.get("outcome", {}) for step in steps)
    print(f"  {len(steps)} steps, {raised} raised, {sum(len(step['requests']) for step in steps)} requests")

    # ---- the parts that need no service and no robot ----
    station_tests = PEAR_PACKAGE.parent / "tests" / "deploy" / "station"
    for tests_directory in (station_tests.parents[1], station_tests):  # the helpers a test imports by name
        sys.path.insert(0, str(tests_directory))
    parts = {
        "arguments": Parts.arguments(),
        "service_urls": Parts.service_urls(),
        "metrics": Parts.metrics(),
        "health_checks": Parts.health_checks(),
        "texts": Parts.texts(),
        "event_streams": Parts.event_streams(),
        "sessions": Parts.sessions(),
        "models": Parts.models(),
    }
    Fixtures.write("parts.json", parts, is_wide=True)
    Fixtures.write("messages.json", Parts.frames(), is_wide=True)

    # ---- the wait for the model's answer: PEAR's ModelCall on a scripted robot and a clock of its own ----
    model_calls = [CallRig(scenario).run() for scenario in CallRig.scenarios()]
    Fixtures.write(
        "model_call.json",
        {"control_period_s": CallRig.CONTROL_PERIOD_S, "cleanup_timeout_s": ModelClient.CLEANUP_TIMEOUT_S},
        model_calls,
        key="scenarios",
    )

    # ---- the agent loop: PEAR's stand-ins, on the stand-in clock of PEAR's tests and seeded UUIDs ----
    from control_rig import StandInClock

    from pear.deploy.station.agent_loop import agent_loop as agent_loop_module
    from pear.deploy.station.agent_loop.clients import schemas as schemas_module
    from pear.deploy.station.control import robot as robot_module

    stand_in_clock = StandInClock()
    machine_clock = time.monotonic, time.sleep
    time.monotonic, time.sleep = stand_in_clock.monotonic, stand_in_clock.sleep
    session_ids, robot_ids = Ids(SEED + 1), Ids(SEED + 2)
    agent_loop_module.uuid4 = schemas_module.uuid4 = session_ids.next  # a session's identity, then each frame's
    robot_module.uuid4 = robot_ids.next  # a robot's session and its observations
    try:
        with tempfile.TemporaryDirectory() as directory:
            loop_run = LoopRun(stand_in_clock, session_ids, robot_ids, Path(directory))
            loops = [loop_run.run(scenario) for scenario in LoopScenarios(Ids(SEED + 3)).all()]
    finally:
        time.monotonic, time.sleep = machine_clock
    Fixtures.write("loop.json", {}, loops, key="scenarios")
    loop_steps = [step for scenario in loops for step in scenario["steps"] if step["op"] == "step"]
    print(f"  {len(loop_steps)} turns, {sum('raised' in step['outcome'] for step in loop_steps)} raised")

    meta = {
        "pear_commit": commit,
        "python": sys.version.split()[0],
        "openai": openai.__version__,
        "pydantic": pydantic.VERSION,
        "model": MODEL,
        "request_header_names": sorted(service.header_names),
        "printable": printable,
        "label": VLLMClient.LABEL,
        "cancel_poll_s": ModelClient.CANCEL_POLL_S,
        "cleanup_timeout_s": ModelClient.CLEANUP_TIMEOUT_S,
    }
    Fixtures.write("meta.json", meta)


if __name__ == "__main__":
    main()
