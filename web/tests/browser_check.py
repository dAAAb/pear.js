"""Checks the built page (dist-web/) in a real headless Chromium, on the simulated arm.

Needs Python 3.10 or newer with Playwright and its Chromium, and Node with the repository's node_modules (for the
expected values, which the library computes in Node). It does not build the page: run `npm run build:web` first.
The part "selftest" builds its own page, web/selftest.html, into dist-web/ (web/vite.selftest.config.ts).

    python web/tests/browser_check.py [--dist DIR] [--out DIR] [--node NODE] [--build STAMP] [--only PART ...] [--list]

It serves dist-web/ and a stand-in model service on 127.0.0.1 (ports the system picks), opens the page, and
exits with 0 only if every check passed. Screenshots and report.json go to --out (a temporary directory by
default; never a directory of the repository).

Parts: load, stamp, sim, expected, guard, cable, faults, calibration, serial, diagnostics, camera, model,
privacy, ask, languages, keyboard, layout, folder, subpath, hosted, insecure, log, transport, timing, selftest,
station, preflight, real.
"""

from __future__ import annotations

import argparse
import base64
import functools
import http.server
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import BrowserContext, Page, TimeoutError as WaitTimeout, sync_playwright

REPOSITORY = Path(__file__).resolve().parents[2]
MOTORS = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]
# never the GPU: the page needs none
CHROMIUM_ARGUMENTS = [
    "--disable-gpu",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    # nothing but this machine can be reached: a browser never sends a loopback address through a proxy, and
    # no proxy listens at this one
    "--proxy-server=http://127.0.0.1:9",
]
KEY = "not-a-real-key-of-the-check-1"
OTHER_KEY = "not-a-real-key-of-the-check-2"
URL_SECRET = "not-a-real-password-of-the-check"
MODEL = "qwen3_8_27b"
MINUS = "−"
# what a browser itself writes to the console about a request that failed; the model checks cause them on purpose
EXPECTED_CONSOLE = re.compile(r"Failed to load resource|blocked by CORS policy|net::ERR_|Mixed Content:")
# how a browser names the failure of a request that it never sent: refused as mixed content, or handed to the proxy
# of CHROMIUM_ARGUMENTS, which does not exist
UNSENT_FAILURES = ("mixed-content", "ERR_PROXY_CONNECTION_FAILED")
# the baud rates an STS3215 can be set to besides PEAR's 1,000,000, in the order the page tries them
OTHER_BAUD_RATES = [500000, 250000, 128000, 115200, 57600, 38400, 19200]
# the address the page is hosted under, as far as a check needs one: an https origin that is not this machine and
# a path below its root. The browser's requests for it are answered here and never leave this machine.
HOSTED_ORIGIN = "https://pearjs.test"
HOSTED_PATH = "/pear.js"


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *arguments):
        pass


class ModelService(http.server.BaseHTTPRequestHandler):
    """A stand-in for a vLLM server's OpenAI API, as vLLM 0.28 with Starlette's CORSMiddleware answers a browser:
    the preflight is answered without a key; a refused key is answered 401 from outside the CORS middleware, so
    without any Access-Control header; every other answer carries the header for an allowed origin."""

    protocol_version = "HTTP/1.1"
    # the settings a check changes between its cases
    allowed_origins: list[str] = ["*"]
    keys: list[str] = []
    refusal_has_cors = False  # True: a gateway that answers a wrong key with the CORS headers
    models: list[str] = [MODEL]
    delay_s = 0.0
    is_other_service = False
    # the answer to POST /v1/chat/completions: the pieces of the body of a server-sent event stream, the pause
    # after each, after how many of them the stream stalls until the browser gives up, and whether the service is
    # gone (it closes the connection without an answer)
    stream: list[str] = []
    stream_pause_s = 0.0
    stream_stalls_after: int | None = None
    is_gone = False
    seen: list[dict] = []

    def log_message(self, *arguments):
        pass

    def _origin_allowed(self) -> bool:
        origin = self.headers.get("Origin")
        return origin is not None and ("*" in self.allowed_origins or origin in self.allowed_origins)

    def _cors(self) -> dict[str, str]:
        origin = self.headers.get("Origin")
        if origin is None:
            return {}
        if "*" in self.allowed_origins:
            return {"Access-Control-Allow-Origin": "*"}
        if origin in self.allowed_origins:
            return {"Access-Control-Allow-Origin": origin, "Vary": "Origin"}
        return {}

    def _send(self, status: int, body: bytes, content_type: str, headers: dict[str, str]) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in headers.items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def _record(self, body: bytes | None = None) -> None:
        entry = {"method": self.command, "path": self.path, "headers": {name.lower(): value for name, value in self.headers.items()}}
        if body is not None:
            entry["body"] = body
        type(self).seen.append(entry)

    def do_OPTIONS(self) -> None:
        self._record()
        headers = {
            "Vary": "Origin",
            "Access-Control-Allow-Methods": "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT",
            "Access-Control-Max-Age": "600",
        }
        requested = self.headers.get("Access-Control-Request-Headers")
        if requested is not None:
            headers["Access-Control-Allow-Headers"] = requested
        if self._origin_allowed():
            headers["Access-Control-Allow-Origin"] = "*" if "*" in self.allowed_origins else self.headers["Origin"]
            self._send(200, b"OK", "text/plain; charset=utf-8", headers)
        else:
            self._send(400, b"Disallowed CORS origin", "text/plain; charset=utf-8", headers)

    def do_GET(self) -> None:
        self._record()
        if self.is_gone:  # a service that is gone answers nothing, whatever is asked
            self.close_connection = True
            return
        if self.delay_s:
            time.sleep(self.delay_s)
        if self.is_other_service:
            self._send(200, b"<!doctype html><title>Hello</title><p>Another service.</p>", "text/html", self._cors())
            return
        if self.path.startswith("/v1") and self.keys:
            scheme, _, token = self.headers.get("Authorization", "").partition(" ")
            if scheme.lower() != "bearer" or token not in self.keys:
                body = json.dumps({"error": "Unauthorized"}).encode()
                self._send(401, body, "application/json", self._cors() if self.refusal_has_cors else {})
                return
        if self.path == "/v1/models":
            cards = [
                {
                    "id": name,
                    "object": "model",
                    "created": 1763186400,
                    "owned_by": "vllm",
                    "root": name,
                    "parent": None,
                    "max_model_len": 262144,
                    "permission": [{"id": "modelperm-0", "object": "model_permission", "allow_sampling": True}],
                }
                for name in self.models
            ]
            self._send(200, json.dumps({"object": "list", "data": cards}).encode(), "application/json", self._cors())
        else:
            self._send(404, json.dumps({"detail": "Not Found"}).encode(), "application/json", self._cors())

    def do_POST(self) -> None:
        """Answers a chat completion as a vLLM server answers a request for a stream: the scripted pieces, each as
        one chunk of the body. What the request carried is kept for the check."""
        self._record(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
        self.close_connection = True
        if self.is_gone:
            return
        if self.path.startswith("/v1") and self.keys:
            scheme, _, token = self.headers.get("Authorization", "").partition(" ")
            if scheme.lower() != "bearer" or token not in self.keys:
                body = json.dumps({"error": "Unauthorized"}).encode()
                self._send(401, body, "application/json", self._cors() if self.refusal_has_cors else {})
                return
        if self.path != "/v1/chat/completions":
            self._send(404, json.dumps({"detail": "Not Found"}).encode(), "application/json", self._cors())
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        for name, value in self._cors().items():
            self.send_header(name, value)
        self.end_headers()
        try:
            for index, piece in enumerate(self.stream):
                if self.stream_stalls_after is not None and index >= self.stream_stalls_after:
                    self.connection.settimeout(30)
                    while self.rfile.read(1):  # nothing more is sent, until the browser closes the connection
                        pass
                    return
                data = piece.encode()
                self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
                self.wfile.flush()
                if self.stream_pause_s:
                    time.sleep(self.stream_pause_s)
            self.wfile.write(b"0\r\n\r\n")
        except OSError:
            pass  # the browser gave up on the answer

    @classmethod
    def configure(cls, **settings) -> None:
        defaults = {
            "allowed_origins": ["*"],
            "keys": [],
            "refusal_has_cors": False,
            "models": [MODEL],
            "delay_s": 0.0,
            "is_other_service": False,
            "stream": [],
            "stream_pause_s": 0.0,
            "stream_stalls_after": None,
            "is_gone": False,
        }
        for name, value in {**defaults, **settings}.items():
            setattr(cls, name, value)


class QuietServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass  # a browser that gave up on a request closed its connection: nothing to report


def serve(handler) -> tuple[http.server.ThreadingHTTPServer, str]:
    server = QuietServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


class WithFixtures(http.server.SimpleHTTPRequestHandler):
    """Serves a folder and, under /fixtures/, the library's test fixtures (tests/fixtures): the self-test page asks
    for them beside itself, at its own origin."""

    def log_message(self, *arguments):
        pass

    def translate_path(self, path: str) -> str:
        if not urlsplit(path).path.startswith("/fixtures/"):
            return super().translate_path(path)
        folder = self.directory
        self.directory = str(REPOSITORY / "tests" / "fixtures")
        try:
            return super().translate_path(path[len("/fixtures") :])
        finally:
            self.directory = folder


class UnderPath(http.server.SimpleHTTPRequestHandler):
    """Serves a folder under one path of a host and nothing beside it, as GitHub Pages serves a project's page:
    the folder's address without its slash is redirected to the one with it, and every other path is not found."""

    served: list[tuple[str, int]] = []  # every path that was asked for, and how it was answered

    def log_message(self, *arguments):
        pass

    def send_response(self, code, message=None):
        type(self).served.append((self.path, code))
        super().send_response(code, message)

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == HOSTED_PATH:
            self.send_response(301)
            self.send_header("Location", f"{HOSTED_PATH}/")
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif not path.startswith(f"{HOSTED_PATH}/"):
            self.send_error(404)
        else:
            super().do_GET()

    def translate_path(self, path: str) -> str:
        return super().translate_path(path[len(HOSTED_PATH) :])


def jpeg_frame_header(data: bytes) -> dict | None:
    """Returns what the frame header of a JPEG says, read here and not by the page."""
    if data[:2] != b"\xff\xd8":
        return None
    offset = 2
    while offset + 4 <= len(data):
        if data[offset] != 0xFF:
            return None
        marker = data[offset + 1]
        if marker == 0xFF:
            offset += 1
            continue
        (length,) = struct.unpack(">H", data[offset + 2 : offset + 4])
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            precision, height, width, components = struct.unpack(">BHHB", data[offset + 4 : offset + 10])
            sampling = [data[offset + 11 + 3 * index] for index in range(components)]
            return {
                "marker": marker,
                "precision": precision,
                "width": width,
                "height": height,
                "components": components,
                "sampling": [f"{value >> 4}x{value & 15}" for value in sampling],
            }
        offset += 2 + length
    return None


class Check:
    """The run: what was checked and what failed, the pages' console and requests."""

    def __init__(self, arguments: argparse.Namespace) -> None:
        self.arguments = arguments
        self.out = Path(arguments.out or tempfile.mkdtemp(prefix="pearjs-web-check-")).resolve()
        if REPOSITORY in self.out.parents or self.out == REPOSITORY:
            raise SystemExit("--out must not be inside the repository")
        self.out.mkdir(parents=True, exist_ok=True)
        self.results: list[dict] = []
        self.part = ""
        self.console_errors: list[str] = []
        self.expected_console: list[str] = []
        self.page_errors: list[str] = []
        self.requests: list[dict] = []
        self.foreign_requests: list[str] = []
        self.allowed_hosts = {"127.0.0.1"}
        self.numbers: dict = {}
        self.page_for_privacy: Page | None = None  # the page the model part leaves for the privacy part
        self.named_services: set[str] = set()  # the hosts given to the page as a model service besides the stand-in

    def ok(self, name: str, condition: bool, detail: object = "") -> bool:
        self.results.append({"part": self.part, "name": name, "passed": bool(condition), "detail": str(detail)[:600]})
        if not condition:
            print(f"  FAIL [{self.part}] {name}: {str(detail)[:600]}")
        return bool(condition)

    def equal(self, name: str, actual: object, expected: object) -> bool:
        return self.ok(name, actual == expected, f"got {actual!r}, expected {expected!r}")

    def close(self, name: str, actual: float, expected: float, tolerance: float) -> bool:
        return self.ok(name, abs(actual - expected) <= tolerance, f"got {actual!r}, expected {expected!r} within {tolerance}")

    def watch(self, context: BrowserContext) -> None:
        """Records every request of every page of ``context`` and keeps what the pages write to their consoles.
        The requests are only watched, never intercepted: a browser whose requests are intercepted no longer
        sends its own preflight requests, which the model checks are about."""

        def on_request(request) -> None:
            url = urlsplit(request.url)
            try:
                body = request.post_data
            except Exception:  # a body that is no text
                body = "<binary>"
            self.requests.append({"url": request.url, "method": request.method, "headers": dict(request.headers), "body": body})
            if url.scheme in ("http", "https") and url.hostname not in self.allowed_hosts:
                self.foreign_requests.append(request.url)

        def on_request_failed(request) -> None:
            # a request the browser refused before sending it, or gave to the proxy that does not exist, did not
            # leave this machine: it is kept, marked, and is no request to another machine
            failure = request.failure or ""
            if not any(name in failure for name in UNSENT_FAILURES):
                return
            for entry in reversed(self.requests):
                if entry["url"] == request.url and "unsent" not in entry:
                    entry["unsent"] = failure
                    break
            if request.url in self.foreign_requests:
                self.foreign_requests.remove(request.url)

        context.on("request", on_request)
        context.on("requestfailed", on_request_failed)

        def on_page(page: Page) -> None:
            def on_console(message) -> None:
                if message.type != "error":
                    return
                (self.expected_console if EXPECTED_CONSOLE.search(message.text) else self.console_errors).append(
                    f"[{self.part}] {message.text}"
                )

            page.on("console", on_console)
            page.on("pageerror", lambda error: self.page_errors.append(f"[{self.part}] {error}"))

        context.on("page", on_page)


def phase(page: Page) -> str:
    return page.locator("#arm-status").get_attribute("data-phase") or ""


def wait_phase(page: Page, wanted: str, timeout_ms: int = 60000) -> None:
    # a connection on which nothing answers takes about nine seconds: the page asks at every baud rate
    page.wait_for_function(
        "wanted => document.querySelector('#arm-status').dataset.phase === wanted", arg=wanted, timeout=timeout_ms
    )


def log_lines(page: Page) -> list[str]:
    """Returns the page's log, each line without the seconds it begins with."""
    return [re.sub(r"^\s*\d+\.\d\d  ", "", line) for line in page.locator("#log-output").input_value().split("\n")]


def log_seconds(page: Page, beginning: str) -> float:
    """Returns the seconds since the page loaded at which the last line of the log with this beginning was written."""
    for line in reversed(page.locator("#log-output").input_value().split("\n")):
        match = re.match(r"^\s*(\d+\.\d\d)  (.*)$", line)
        if match is not None and match.group(2).startswith(beginning):
            return float(match.group(1))
    raise ValueError(f"no line of the log begins with {beginning!r}")


def trace_after(lines: list[str], beginning: str) -> tuple[str, list[tuple[float, str, list[int]]]]:
    """Returns the last line trace of the log whose first line has this beginning: that line, and its pieces as
    (ms after the port was opened, "TX" or "RX" or "error", bytes)."""
    start = max((index for index, line in enumerate(lines) if line.startswith(beginning)), default=None)
    if start is None:
        raise ValueError(f"no line of the log begins with {beginning!r}")
    pieces = []
    for line in lines[start + 1 :]:
        match = re.fullmatch(r"  \+(\d+\.\d) ms (TX|RX|line error)(.*)", line)
        if match is None:
            break
        kind = "error" if match.group(2) == "line error" else match.group(2)
        hexadecimal = [] if kind == "error" else [word for word in match.group(3).split() if word != "..."]
        pieces.append((float(match.group(1)), kind, [int(word, 16) for word in hexadecimal]))
    return lines[start], pieces


def flat(packets: list[list[int]]) -> list[int]:
    return [byte for packet in packets for byte in packet]


def kinds(page: Page, container: str = "#arm-messages") -> list[str]:
    return page.evaluate(
        "selector => [...document.querySelectorAll(selector + ' .box')].map(box => box.dataset.kind || '')", container
    )


def joints_shown(page: Page) -> dict[str, dict]:
    """Returns the joint table as the page shows it: for each motor the raw steps, the value's text and number."""
    return page.evaluate(
        """() => Object.fromEntries([...document.querySelectorAll('#joint-table tbody tr')].map(row => {
            const field = name => row.querySelector(`[data-field="${name}"]`);
            return [row.dataset.motor, {
                raw: Number(field('raw').dataset.value),
                rawText: field('raw').textContent,
                value: field('value').dataset.value,
                valueText: field('value').textContent,
                mark: field('mark').dataset.value,
            }];
        }))"""
    )


def state_shown(page: Page) -> dict[str, dict]:
    return page.evaluate(
        """() => Object.fromEntries([...document.querySelectorAll('#model-state div[data-quantity]')].map(item =>
            [item.dataset.quantity, { value: item.dataset.value, text: item.querySelector('dd').textContent }]))"""
    )


def registers_shown(page: Page) -> dict[str, dict]:
    """Returns the calibration table as lerobot's calibration file holds a calibration."""
    rows = page.evaluate(
        """() => [...document.querySelectorAll('#calibration-table tbody tr')].map(row => ({
            motor: row.dataset.motor,
            id: Number(row.cells[0].textContent),
            offset: Number(row.querySelector('[data-field="offset"]').dataset.value),
            range: row.querySelector('[data-field="range"]').dataset.value,
            same: row.querySelector('[data-field="same"]')?.dataset.value ?? null,
        }))"""
    )
    return {
        row["motor"]: {
            "id": row["id"],
            "drive_mode": 0,
            "homing_offset": row["offset"],
            "range_min": int(row["range"].split("-")[0]),
            "range_max": int(row["range"].split("-")[1]),
            "same": row["same"],
        }
        for row in rows
    }


def set_slider(page: Page, motor: str, steps: int) -> None:
    page.evaluate(
        """([motor, steps]) => {
            const slider = document.getElementById(`sim-slider-${motor}`);
            slider.value = String(steps);
            slider.dispatchEvent(new Event('input', { bubbles: true }));
        }""",
        [motor, steps],
    )


def wait_raw(page: Page, pose: dict[str, int]) -> None:
    page.wait_for_function(
        """pose => Object.entries(pose).every(([motor, steps]) =>
            document.querySelector(`#joint-table tr[data-motor="${motor}"] [data-field="raw"]`)?.dataset.value === String(steps))""",
        arg=pose,
        timeout=5000,
    )


def number_in(text: str) -> float:
    match = re.search(r"[-−]?\d+(?:\.\d+)?", text)
    if match is None:
        raise ValueError(f"no number in {text!r}")
    return float(match.group(0).replace(MINUS, "-"))


def expected_values(check: Check, calibration: dict[str, dict], poses: list[dict[str, int]]) -> dict:
    """Asks the library, in Node, what these servo positions are."""
    request = {
        "calibration": {
            motor: {
                "id": entry["id"],
                "driveMode": entry["drive_mode"],
                "homingOffset": entry["homing_offset"],
                "rangeMin": entry["range_min"],
                "rangeMax": entry["range_max"],
            }
            for motor, entry in calibration.items()
        },
        "poses": poses,
    }
    completed = subprocess.run(
        [check.arguments.node, "web/tests/run_node.mjs", "web/tests/expected_entry.ts"],
        input=json.dumps(request).encode(),
        cwd=REPOSITORY,
        capture_output=True,
        timeout=180,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"expected_entry.ts failed: {completed.stderr.decode(errors='replace')[-800:]}")
    return json.loads(completed.stdout.decode())


def compare_with_node(check: Check, page: Page, label: str, calibration: dict[str, dict], pose: dict[str, int]) -> None:
    """Checks the joint table, the marks, the model's state and the turn's text against Node for one pose."""
    wait_raw(page, pose)
    shown = joints_shown(page)
    state = state_shown(page)
    turn_text = page.locator("#turn-text").text_content()
    node = expected_values(check, calibration, [pose])
    wanted = node["poses"][0]
    for index, motor in enumerate(MOTORS):
        value = wanted["joints"][index]
        check.equal(f"{label}: {motor} raw steps shown", shown[motor]["raw"], pose[motor])
        check.close(f"{label}: {motor} joint value equals Node's", float(shown[motor]["value"]), value, 1e-12)
        check.close(f"{label}: {motor} joint value as shown", number_in(shown[motor]["valueText"]), value, 0.0005 + 1e-9)
        unit = "opening" if motor == "gripper" else "rad"
        check.ok(f"{label}: {motor} is shown in {unit}", shown[motor]["valueText"].strip().endswith(unit), shown[motor]["valueText"])
        lower, upper, tolerance = node["lowerBounds"][index], node["upperBounds"][index], node["feedbackTolerance"]
        if lower - 1e-9 <= value <= upper + 1e-9:
            mark = "inside"
        elif lower - tolerance - 1e-9 <= value <= upper + tolerance + 1e-9:
            mark = "tolerated"
        else:
            mark = "outside"
        check.equal(f"{label}: {motor} mark against PEAR's limits", shown[motor]["mark"], mark)
    for name, value in wanted["state"].items():
        check.close(f"{label}: state {name} equals Node's", float(state[name]["value"]), value, 1e-12)
        decimals = node["decimals"][name]
        check.equal(f"{label}: state {name} as shown", number_in(state[name]["text"]), round(value, decimals))
        unit = "rad" if name in ("pitch", "roll") else "cm"
        check.ok(f"{label}: state {name} is shown in {unit}", state[name]["text"].strip().endswith(unit), state[name]["text"])
    check.equal(f"{label}: the turn's text equals Node's", turn_text, wanted["turnText"])


def open_page(check: Check, context: BrowserContext, base: str, query: str = "?lang=en") -> Page:
    page = context.new_page()
    page.goto(f"{base}/index.html{query}")
    page.wait_for_function("window.pearjs !== undefined && window.pearjs.selfTest() !== null")
    return page


def connect_sim(page: Page) -> None:
    page.click("#arm-sim")
    wait_phase(page, "reading")


def part_load(check: Check, context: BrowserContext, base: str) -> None:
    page = open_page(check, context, base)
    check.equal("the page starts not connected", phase(page), "idle")
    check.ok("the notice says unofficial and experimental", "unofficial, experimental" in page.locator("#notice").inner_text())
    notice = page.locator("#notice").inner_text()
    check.ok("the notice says that the station runs in a Worker of the page and drives a simulated arm", "The station runs in a Worker of this page and drives a simulated arm." in notice, notice)
    check.ok("the notice says that with a real arm the page reads, that it writes to the servos only after \"Enable the station on this arm\" and the confirmation, and that no model moves an arm", "With a real arm connected the page reads" in notice and "It writes to the servos only after you press “Enable the station on this arm” and confirm" in notice and "No model moves an arm." in notice, notice)
    check.ok("the notice no longer says that the page cannot move the arm at all", "cannot move the arm" not in notice and "first version only reads" not in notice, notice)
    links = page.evaluate("[...document.querySelectorAll('a[href]')].map(link => link.getAttribute('href'))")
    outside = sorted({link for link in links if not link.startswith("#")})
    check.equal(
        "the page links to the two repositories and nothing else",
        outside,
        ["https://github.com/dAAAb/pear.js", "https://github.com/mit-han-lab/pear"],
    )
    self_test = page.evaluate("window.pearjs.selfTest()")
    check.equal("guard self-test: reading packets passed", self_test["readingPassed"], self_test["readingTried"])
    check.equal("guard self-test: writing packets refused", self_test["writingRefused"], self_test["writingTried"])
    check.ok("guard self-test: at least 3 reading and 12 writing inputs", self_test["readingTried"] >= 3 and self_test["writingTried"] >= 12, self_test)
    check.equal("guard self-test: no failure", self_test["failures"], [])
    check.ok("the self-test is shown", "12 of 12" in page.locator("#guard-selftest").inner_text(), page.locator("#guard-selftest").inner_text())
    check.ok("Stop is laid out and disabled", page.locator("#task-stop").is_disabled() and page.locator("#task-stop").is_visible())
    check.ok("Stop stays in view at the bottom", page.evaluate("getComputedStyle(document.getElementById('stopbar')).position") == "fixed")
    check.ok("Start is disabled", page.locator("#task-start").is_disabled())
    check.ok("the instruction can be written", page.locator("#task-instruction").is_enabled())
    check.ok("Ask the model once is not offered before an arm is read", page.locator("#ask-once").is_disabled())
    task_text = page.locator("#task").inner_text()
    check.ok("the task says that the station drives a simulated arm, in a Worker of the page", "The station below drives a simulated arm, in a Worker of this page." in task_text, task_text[:300])
    check.ok("the task says that with a real arm the page reads, and writes to the servos only after \"Enable the station on this arm\" and its confirmation", "With a real arm connected the page reads; it writes to the servos only after “Enable the station on this arm” and its confirmation" in task_text, task_text[:300])
    check.ok(
        "the task says that it can ask a model once, does not execute the action, and that no model moves an arm",
        "It can ask a model once and show the answer: it does not execute the action the model asks for, and no model moves an arm. On the simulated arm" in task_text,
        task_text[:420],
    )
    jog_lead = page.locator("[data-i18n='station.jogLead']").text_content() or ""
    check.ok(
        "the station's actions are said to observe the wrist camera's frame, and not to run without a fresh one",
        "the wrist camera's frame as the station sees it; without a fresh frame the action is not run" in jog_lead and "no camera" not in jog_lead,
        jog_lead,
    )
    check.ok("the station cannot be enabled without an arm", page.locator("#station-enable").is_disabled())
    check.equal("the key's field hides what is typed", page.locator("#model-key").get_attribute("type"), "password")
    check.equal("no form that a browser would offer to remember", page.locator("form").count(), 0)
    scripts = page.evaluate("[...document.scripts].map(script => [script.src, script.type])")
    check.ok("one classic script of the page's own", len(scripts) == 1 and scripts[0][1] == "" and scripts[0][0].startswith(base), scripts)
    page.close()


def node_json(check: Check, entry: str) -> dict:
    """Returns what a TypeScript entry of web/tests gives when Node runs it."""
    completed = subprocess.run(
        [check.arguments.node, "web/tests/run_node.mjs", entry], cwd=REPOSITORY, capture_output=True, timeout=180, check=False
    )
    if completed.returncode != 0:
        raise RuntimeError(f"{entry} failed: {completed.stderr.decode(errors='replace')[-800:]}")
    return json.loads(completed.stdout.decode())


def part_stamp(check: Check, context: BrowserContext, base: str) -> None:
    """What the page says it was built from, in its footer and in the first line of its log: the build (the first
    seven characters of the commit a GitHub Actions job built, "dev" otherwise) and the commit of PEAR."""
    pear = node_json(check, "web/tests/stamp_entry.ts")["pearCommit"]
    build = check.arguments.build
    check.ok("the library's PEAR commit is a whole commit", re.fullmatch(r"[0-9a-f]{40}", pear) is not None, pear)
    check.ok("a build is 'dev' or seven characters of a commit", re.fullmatch(r"dev|[0-9a-f]{7}", build) is not None, build)

    page = open_page(check, context, base)
    footer = page.locator("#footer-commit")
    check.equal("the footer's build is the one the page was built as (--build)", footer.get_attribute("data-build"), build)
    check.equal("the footer's PEAR commit is the library's", footer.get_attribute("data-pear"), pear)
    check.equal("the footer says both", footer.inner_text(), f"pear.js build {build}. Ports PEAR at commit {pear[:8]}.")
    check.ok("the footer is laid out", footer.is_visible())
    lines = page.locator("#log-output").input_value().split("\n")
    first = f"pear.js build {build}, ports PEAR {pear}; read-only first version"
    check.equal("the log's first line says both", re.sub(r"^\s*\d+\.\d\d  ", "", lines[0]), first)
    check.equal("the page's own objects say the same", page.evaluate("[window.pearjs.build, window.pearjs.pearCommit]"), [build, pear])
    page.click("#language-zh")
    text = footer.inner_text()
    check.ok("the Chinese footer says both", f"pear.js 建置版本 {build}。" in text and f"commit {pear[:8]}。" in text and has_han(text), text)
    page.click("#language-en")

    # a log that outgrows its length drops old lines, never its head: the build, the browser, the page
    head = log_lines(page)[:3]
    page.evaluate("for (let index = 0; index < 2100; index++) window.pearjs.log.add('filler ' + index)")
    lines = log_lines(page)
    check.equal("a full log keeps its length", len(lines), 2000)
    check.equal("and its first three lines", lines[:3], head)
    check.ok("the build is still the first line", lines[0] == first, lines[0])
    check.ok("it says where lines were dropped", "older lines were dropped here" in lines[3], lines[3])
    check.equal("and ends with the newest line", lines[-1], "filler 2099")
    page.close()


def part_sim(check: Check, context: BrowserContext, base: str) -> None:
    page = open_page(check, context, base)
    connect_sim(page)
    check.equal("the button leads to the live read-out", phase(page), "reading")
    check.ok("the status names the simulated arm", "simulated arm" in page.locator("#arm-status").inner_text())
    check.ok("the simulated arm's panel is shown", page.locator("#sim-panel").is_visible())
    first = number_in(page.locator("#arm-readings").inner_text())
    page.wait_for_timeout(1050)
    second = number_in(page.locator("#arm-readings").inner_text())
    check.ok("about ten readings a second", 8 <= second - first <= 12, f"{second - first} readings in 1.05 s")
    servos = page.evaluate(
        "[...document.querySelectorAll('#servo-table tbody tr')].map(row => [row.dataset.motor, row.querySelector('[data-field=answer]').dataset.value, row.querySelector('[data-field=model]').textContent, row.querySelector('[data-field=torque]').dataset.value])"
    )
    check.equal("six servos answer, model 777, torque off as found", servos, [[motor, "ok", "777", "0"] for motor in MOTORS])
    check.equal("no message when all is well", kinds(page), [])
    opened = page.evaluate("window.pearjs.sim().port.openedWith")
    check.equal("the port is opened at PEAR's baud rate", opened, {"baudRate": 1000000})
    registers = registers_shown(page)
    wanted = page.evaluate(
        "() => Object.fromEntries(['shoulder_pan','shoulder_lift','elbow_flex','wrist_flex','wrist_roll','gripper'].map(motor => { const servo = window.pearjs.sim().servo(motor); const offset = servo.get('Homing_Offset'); return [motor, [servo.id, (offset & 0x800) ? -(offset & 0x7ff) : offset, servo.get('Min_Position_Limit'), servo.get('Max_Position_Limit')]]; }))"
    )
    for motor in MOTORS:
        entry = registers[motor]
        check.equal(
            f"calibration registers of {motor} are the servo's", [entry["id"], entry["homing_offset"], entry["range_min"], entry["range_max"]], wanted[motor]
        )

    # a slider moves a servo behind the bus's back; the read-out follows
    before = joints_shown(page)
    set_slider(page, "shoulder_pan", 1500)
    wait_raw(page, {"shoulder_pan": 1500})
    after = joints_shown(page)
    check.equal("a slider moves the raw position", after["shoulder_pan"]["raw"], 1500)
    check.ok("and the joint value", after["shoulder_pan"]["value"] != before["shoulder_pan"]["value"], after["shoulder_pan"])
    check.equal("and no other joint", {m: after[m]["raw"] for m in MOTORS[1:]}, {m: before[m]["raw"] for m in MOTORS[1:]})
    page.focus("#sim-slider-gripper")
    page.keyboard.press("ArrowLeft")
    wait_raw(page, {"gripper": before["gripper"]["raw"] - 1})
    check.equal("a slider follows the keyboard", joints_shown(page)["gripper"]["raw"], before["gripper"]["raw"] - 1)

    page.click("#arm-disconnect")
    wait_phase(page, "idle")
    check.equal("Disconnect ends the reading", phase(page), "idle")
    check.ok("the tables are gone", not page.locator("#arm-joints").is_visible() and not page.locator("#arm-servos").is_visible())
    received = page.evaluate("window.pearjs.sim().chain.received.map(packet => packet[4])")
    check.ok("the simulated servos received pings and reads only", set(received) <= {1, 2, 0x82} and len(received) > 50, sorted(set(received)))
    torque = page.evaluate("['shoulder_pan','gripper'].map(motor => window.pearjs.sim().servo(motor).torqueEnabled)")
    check.equal("torque is still off after the port was closed", torque, [False, False])
    page.close()

    # ?arm=sim connects without a click
    page = open_page(check, context, base, "?arm=sim&lang=en")
    wait_phase(page, "reading")
    check.equal("?arm=sim connects the simulated arm", phase(page), "reading")
    page.wait_for_function("document.querySelector('#camera-status').dataset.phase === 'live'")
    check.equal("the simulated arm brings its test picture", page.locator("#camera-select").input_value(), "test-picture")
    page.close()


def part_expected(check: Check, context: BrowserContext, base: str) -> None:
    page = open_page(check, context, base)
    connect_sim(page)
    calibration = registers_shown(page)
    start = {motor: joints_shown(page)[motor]["raw"] for motor in MOTORS}
    compare_with_node(check, page, "start pose", calibration, start)
    poses = {
        "another pose": {"shoulder_pan": 2600, "shoulder_lift": 2300, "elbow_flex": 1500, "wrist_flex": 1700, "wrist_roll": 3000, "gripper": 2700},
        # shoulder_pan just outside its bound, inside the feedback tolerance
        "tolerated pose": {"shoulder_pan": 3185, "shoulder_lift": 2070, "elbow_flex": 1953, "wrist_flex": 1988, "wrist_roll": 2048, "gripper": 2037},
        # every joint at an end of its calibrated range
        "ends of the ranges": {"shoulder_pan": 758, "shoulder_lift": 3284, "elbow_flex": 836, "wrist_flex": 3138, "wrist_roll": 0, "gripper": 3499},
    }
    for label, pose in poses.items():
        for motor, steps in pose.items():
            set_slider(page, motor, steps)
        compare_with_node(check, page, label, calibration, pose)
        marks = {motor: joints_shown(page)[motor]["mark"] for motor in MOTORS}
        if label == "another pose":
            check.equal("another pose: all inside", set(marks.values()), {"inside"})
            check.ok("another pose: no warning", "warn-bounds" not in kinds(page), kinds(page))
        if label == "tolerated pose":
            check.equal("tolerated pose: shoulder_pan within tolerance", marks["shoulder_pan"], "tolerated")
            check.ok("tolerated pose: PEAR accepts it, no warning", "warn-bounds" not in kinds(page), kinds(page))
        if label == "ends of the ranges":
            check.equal("ends: shoulder_pan outside", marks["shoulder_pan"], "outside")
            check.ok("ends: the warning is shown", "warn-bounds" in kinds(page), kinds(page))
            text = page.locator("#arm-messages .box[data-kind=warn-bounds]").inner_text()
            check.ok("ends: with PEAR's own refusal", "Joint or gripper target outside commissioned bounds: shoulder_pan=" in text, text)
    page.close()


def part_guard(check: Check, context: BrowserContext, base: str) -> None:
    page = open_page(check, context, base)
    connect_sim(page)
    attempts = {
        "a write of Torque_Enable": "bus => bus.write('Torque_Enable', 'shoulder_pan', 1)",
        "a write of Goal_Position": "bus => bus.write('Goal_Position', 'shoulder_pan', 2048, { normalize: false })",
        "a sync write of Goal_Position": "bus => bus.syncWrite('Goal_Position', 2048, { normalize: false })",
        "enabling torque": "bus => bus.enableTorque()",
        "writing a calibration": "bus => bus.writeCalibration(bus.calibration)",
        "lerobot's configuration of the servos": "bus => bus.configureMotors()",
    }
    for label, call in attempts.items():
        outcome = page.evaluate(
            """async call => {
                const sim = window.pearjs.sim();
                const before = sim.chain.received.length;
                const registers = [...sim.chain.servos.values()].map(servo => servo.registers.join(','));
                // the periodic read goes on while this is tried: count what is no ping and no read
                let error = null;
                try { await (0, eval)(call)(window.pearjs.arm.bus); } catch (thrown) { error = { name: thrown.name, message: thrown.message }; }
                const writes = sim.chain.received.slice(before).filter(packet => ![1, 2, 0x82].includes(packet[4])).length;
                const unchanged = [...sim.chain.servos.values()].every((servo, index) =>
                    servo.registers.join(',') === registers[index]);
                return { error, writes, unchanged };
            }""",
            call,
        )
        check.equal(f"{label} is refused", (outcome["error"] or {}).get("name"), "ReadOnlyViolation")
        check.equal(f"{label}: nothing but reads reached the servos", outcome["writes"], 0)
        check.ok(f"{label}: no register changed", outcome["unchanged"], outcome)
    refused = int(page.locator("#guard-line").get_attribute("data-refused") or "0")
    page.wait_for_function("Number(document.querySelector('#guard-line').dataset.refused) >= 6")
    check.ok("the page counts the refusals", int(page.locator("#guard-line").get_attribute("data-refused")) >= 6, refused)
    check.ok("and logs them", "Read-only guard: Refused: WRITE" in page.locator("#log-output").input_value())
    check.ok("and SYNC WRITE by name", "Refused: SYNC WRITE" in page.locator("#log-output").input_value())
    check.equal("the reading goes on after a refusal", phase(page), "reading")
    torque = page.evaluate("[...window.pearjs.sim().chain.servos.values()].map(servo => servo.torqueEnabled)")
    check.equal("torque is off on every servo", torque, [False] * 6)
    page.close()


def part_cable(check: Check, context: BrowserContext, base: str) -> None:
    page = open_page(check, context, base)
    connect_sim(page)
    page.click("#sim-cable")
    wait_phase(page, "failed")
    check.equal("pulling the cable ends the reading", kinds(page), ["fail-lost"])
    check.ok("with the browser's own words", "The device has been lost" in page.locator("#arm-messages").inner_text())
    check.ok("the read-out is gone", not page.locator("#arm-joints").is_visible())
    check.ok("a retry is offered", page.locator("#arm-retry").is_visible())
    page.click("#arm-retry")
    wait_phase(page, "failed")
    page.wait_for_function("document.querySelector('#arm-messages .box')?.dataset.kind === 'fail-open'")
    check.equal("a retry without the cable cannot open the port", kinds(page), ["fail-open"])
    page.click("#sim-cable")
    page.click("#arm-retry")
    wait_phase(page, "reading")
    check.equal("with the cable back, reading resumes without a reload", phase(page), "reading")
    check.equal("and the message is gone", kinds(page), [])
    page.click("#sim-cable")
    wait_phase(page, "failed")
    page.click("#arm-sim")
    wait_phase(page, "reading")
    check.equal("the button plugs the simulated cable back in", phase(page), "reading")

    # the servos lose power while the adapter stays: the page says so and recovers by itself
    page.evaluate("[1, 2, 3, 4, 5, 6].forEach(id => window.pearjs.sim().chain.absent.add(id))")
    wait_phase(page, "stalled")
    check.ok("servos that stop answering are told apart from a lost port", "stopped answering" in page.locator("#arm-status").inner_text())
    page.evaluate("window.pearjs.sim().chain.absent.clear()")
    wait_phase(page, "reading")
    check.ok("and the page says when they answer again", "The servos answer again" in page.locator("#log-output").input_value())

    # an error of the line that a port survives (a break, a framing error): the reading goes on
    page.evaluate("window.pearjs.sim().port.glitch('BreakError')")
    page.wait_for_function("document.querySelector('#arm-messages .box[data-kind=warn-line]') !== null")
    check.ok("a line error is said", "BreakError" in page.locator("#arm-messages").inner_text(), page.locator("#arm-messages").inner_text())
    for _ in range(8):
        page.evaluate("window.pearjs.sim().port.glitch('FramingError')")
        page.wait_for_timeout(40)
    wait_phase(page, "reading")
    before = number_in(page.locator("#arm-readings").inner_text())
    page.wait_for_function("before => Number(document.querySelector('#arm-readings').textContent.replace(/\\D/g, '')) >= before + 5", arg=before)
    check.equal("after nine line errors the arm is still read", phase(page), "reading")
    check.equal("and no connection was lost", [kind for kind in kinds(page) if kind.startswith("fail")], [])
    check.ok("the line errors are logged", "Serial line error 1, reading goes on: BreakError" in page.locator("#log-output").input_value())
    page.close()


def part_faults(check: Check, context: BrowserContext, base: str) -> None:
    page = open_page(check, context, base, "?arm=sim&sim=missing&lang=en")
    wait_phase(page, "failed")
    check.equal("missing servo: the message", kinds(page), ["fail-partial"])
    text = page.locator("#arm-messages").inner_text()
    check.ok("missing servo: named", "Not answering: elbow_flex." in text and "shoulder_pan, shoulder_lift, wrist_flex, wrist_roll, gripper" in text, text)
    answers = page.evaluate("[...document.querySelectorAll('#servo-table [data-field=answer]')].map(cell => cell.dataset.value)")
    check.equal("missing servo: the table", answers, ["ok", "ok", "silent", "ok", "ok", "ok"])
    check.ok("missing servo: no read-out", not page.locator("#arm-joints").is_visible())

    # the scenario's list reconnects
    page.select_option("#sim-scenario", "error")
    wait_phase(page, "reading")
    check.equal("servo error: the message", kinds(page), ["warn-servo-error"])
    text = page.locator("#arm-messages").inner_text()
    check.ok("servo error: PEAR's words for it", "wrist_flex: overload" in text, text)
    answers = page.evaluate("[...document.querySelectorAll('#servo-table [data-field=answer]')].map(cell => cell.dataset.value)")
    check.equal("servo error: the table", answers, ["ok", "ok", "ok", "error", "ok", "ok"])
    status = page.evaluate("[...document.querySelectorAll('#servo-table [data-field=status]')].map(cell => cell.dataset.value)")
    check.equal("servo error: the Status register", status, ["0", "0", "0", "32", "0", "0"])
    check.ok("servo error: the arm is still read", page.locator("#arm-joints").is_visible() and len(joints_shown(page)) == 6)
    check.ok("servo error: lerobot's handshake had called it missing", "Missing motor IDs: | - 4" in page.locator("#log-output").input_value())

    page.select_option("#sim-scenario", "factory")
    wait_phase(page, "reading")
    check.equal("never calibrated: the message", kinds(page), ["warn-uncalibrated"])
    registers = registers_shown(page)
    check.ok(
        "never calibrated: the registers are a servo's factory values",
        all(entry["homing_offset"] == 0 and entry["range_min"] == 0 and entry["range_max"] == 4095 for entry in registers.values()),
        registers,
    )
    shown = joints_shown(page)
    check.ok("never calibrated: raw positions, no joint values", all(shown[m]["value"] == "" and shown[m]["raw"] > 0 for m in MOTORS), shown)
    check.ok("never calibrated: no state for a model", page.locator("#model-state div[data-quantity]").count() == 0)

    page.select_option("#sim-scenario", "silent")
    wait_phase(page, "failed")
    check.equal("nothing answers: the message", kinds(page), ["fail-silent"])
    check.ok("nothing answers: the servos' own power supply is named", "need their own power supply" in page.locator("#arm-messages").inner_text())

    page.select_option("#sim-scenario", "echo")
    wait_phase(page, "failed")
    check.equal("an echoing adapter is recognised", kinds(page), ["fail-echo"])

    page.select_option("#sim-scenario", "normal")
    wait_phase(page, "reading")
    check.equal("back to a healthy arm", kinds(page), [])
    received = page.evaluate("window.pearjs.sim().chain.received.map(packet => packet[4])")
    check.ok("in every scenario the servos received pings and reads only", set(received) <= {1, 2, 0x82}, sorted(set(received)))
    page.close()


def calibration_file(calibration: dict[str, dict]) -> bytes:
    entries = {motor: {key: value for key, value in entry.items() if key != "same"} for motor, entry in calibration.items()}
    return json.dumps(entries, indent=4).encode()


def load_file(page: Page, content: bytes, name: str = "so101_follower.json") -> None:
    page.set_input_files("#calibration-file", files=[{"name": name, "mimeType": "application/json", "buffer": content}])


def wait_verdict(page: Page, kind: str) -> None:
    page.wait_for_function(
        "kind => document.querySelector('#calibration-verdict .box')?.dataset.kind === kind", arg=kind, timeout=8000
    )


def part_calibration(check: Check, context: BrowserContext, base: str) -> None:
    page = open_page(check, context, base)
    connect_sim(page)
    registers = registers_shown(page)

    load_file(page, calibration_file(registers))
    wait_verdict(page, "cal-equal")
    check.equal("equal file: every row the same", [entry["same"] for entry in registers_shown(page).values()], ["yes"] * 6)
    check.ok("equal file: PEAR's check passes", "PEAR's start-up check passes" in page.locator("#calibration-verdict").inner_text())

    different = json.loads(calibration_file(registers))
    different["elbow_flex"]["range_min"] += 7
    load_file(page, json.dumps(different).encode())
    wait_verdict(page, "cal-different")
    same = {motor: entry["same"] for motor, entry in registers_shown(page).items()}
    check.equal("different file: the row that differs", same, {**{motor: "yes" for motor in MOTORS}, "elbow_flex": "no"})
    check.ok(
        "different file: PEAR's refusal is quoted",
        "Servo calibration registers differ from the calibration file" in page.locator("#calibration-verdict").inner_text(),
    )

    offset = json.loads(calibration_file(registers))
    offset["wrist_roll"]["homing_offset"] -= 1
    load_file(page, json.dumps(offset).encode())
    wait_verdict(page, "cal-different")
    page.wait_for_function("document.querySelector('#calibration-table tr[data-motor=wrist_roll] [data-field=same]').dataset.value === 'no'")
    check.equal("a homing offset that differs is found too", registers_shown(page)["wrist_roll"]["same"], "no")

    fewer = json.loads(calibration_file(registers))
    del fewer["gripper"]
    load_file(page, json.dumps(fewer).encode())
    wait_verdict(page, "cal-different")
    page.wait_for_function("document.querySelector('#calibration-table tr[data-motor=gripper] [data-field=same]').dataset.value === 'missing'")
    check.ok("a file without a motor: said", "The file has no entry for: gripper." in page.locator("#calibration-verdict").inner_text())

    for label, content in {
        "not JSON": b"this is not a calibration",
        "another JSON": b'{"shoulder_pan": {"id": 1}}',
        "a list": b"[1, 2, 3]",
    }.items():
        load_file(page, content)
        wait_verdict(page, "cal-invalid")
        check.ok(f"{label} is refused as no calibration file", "not a lerobot calibration file" in page.locator("#calibration-verdict").inner_text())
        check.equal(f"{label}: the reading goes on", phase(page), "reading")

    # PEAR's check does not compare the drive mode; with an equal file the bus computes with the file's
    inverted = json.loads(calibration_file(registers))
    inverted["gripper"]["drive_mode"] = 1
    load_file(page, json.dumps(inverted).encode())
    wait_verdict(page, "cal-equal")
    pose = {motor: joints_shown(page)[motor]["raw"] for motor in MOTORS}
    page.wait_for_function("Number(document.querySelector('#joint-table tr[data-motor=gripper] [data-field=value]').dataset.value) < 0.5")
    compare_with_node(check, page, "file with an inverted gripper", {m: {**inverted[m]} for m in MOTORS}, pose)
    check.close("with the file's drive mode the open jaw reads closed", float(joints_shown(page)["gripper"]["value"]), 0.0, 1e-12)

    page.click("#calibration-remove")
    page.wait_for_function("document.querySelector('#calibration-verdict .box') === null")
    page.wait_for_function("Number(document.querySelector('#joint-table tr[data-motor=gripper] [data-field=value]').dataset.value) > 0.5")
    check.close("without the file the registers count again", float(joints_shown(page)["gripper"]["value"]), 1.0, 1e-12)
    page.close()

    # a file chosen before the arm is connected is compared once the arm is read
    page = open_page(check, context, base)
    load_file(page, calibration_file(registers))
    wait_verdict(page, "cal-waiting")
    check.ok("a file before the arm waits", "compared as soon as an arm is read" in page.locator("#calibration-verdict").inner_text())
    connect_sim(page)
    wait_verdict(page, "cal-equal")
    check.equal("and is compared at the connection", [entry["same"] for entry in registers_shown(page).values()], ["yes"] * 6)
    check.ok("the file's name is not written to the log", "so101_follower.json" not in page.locator("#log-output").input_value())
    received = page.evaluate("window.pearjs.sim().chain.received.map(packet => packet[4])")
    check.ok("comparing a file sends pings and reads only", set(received) <= {1, 2, 0x82}, sorted(set(received)))
    page.close()


SERIAL_STUBS = {
    "none": "delete Navigator.prototype.serial;",
    "cancel": """Object.defineProperty(navigator, 'serial', { configurable: true, value: {
        requestPort: () => Promise.reject(new DOMException('No port selected by the user.', 'NotFoundError')) } });""",
    "busy": """Object.defineProperty(navigator, 'serial', { configurable: true, value: {
        requestPort: async () => ({
            readable: null, writable: null,
            getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x55d3 }),
            open: () => Promise.reject(new DOMException('Failed to open serial port.', 'NetworkError')),
            close: async () => undefined }) } });""",
    # a port that opens and on which nothing ever answers. As the Web Serial specification has it, a stream that
    # was cancelled or closed is no longer the port's, and close() refuses while a stream of the port is locked.
    "silent": """window.openedWith = [];
      window.written = [];
      const port = {
        readable: null, writable: null,
        getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x55d3 }),
        async open(options) {
            window.openedWith.push(options);
            port.readable = new ReadableStream({ cancel() { port.readable = null; } });
            port.writable = new WritableStream({
                write(bytes) { window.written.push([...bytes]); },
                close() { port.writable = null; },
                abort() { port.writable = null; } });
        },
        async close() {
            if (port.readable?.locked) throw new TypeError('Cannot cancel a locked stream');
            if (port.writable?.locked) throw new TypeError('Cannot abort a locked stream');
            port.readable = null; port.writable = null; window.portClosed = true;
        } };
      Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => port } });""",
}


def part_serial(check: Check, browser, base: str) -> None:
    """The Connect button on a browser's own Web Serial, which a stand-in of each failure replaces."""

    def page_with(stub: str) -> tuple[BrowserContext, Page]:
        context = browser.new_context(viewport={"width": 1280, "height": 800}, locale="en-US")
        check.watch(context)
        context.add_init_script(SERIAL_STUBS[stub])
        return context, open_page(check, context, base)

    context, page = page_with("none")
    check.equal("without Web Serial: the message is there from the start", kinds(page), ["fail-no-serial"])
    text = page.locator("#arm-messages").inner_text()
    check.ok("without Web Serial: the browsers that have it are named", all(name in text for name in ("Chrome", "Edge", "Opera", "Firefox", "Safari")), text)
    check.ok("without Web Serial: Connect is disabled", page.locator("#arm-connect").is_disabled())
    connect_sim(page)
    check.equal("without Web Serial: the simulated arm still works", phase(page), "reading")
    context.close()

    context, page = page_with("cancel")
    check.ok("with Web Serial: Connect is enabled", page.locator("#arm-connect").is_enabled())
    page.click("#arm-connect")
    page.wait_for_function("document.querySelector('#arm-messages .box')?.dataset.kind === 'fail-no-port'")
    check.equal("no port chosen: the message", kinds(page), ["fail-no-port"])
    check.equal("no port chosen: still not connected", phase(page), "idle")
    context.close()

    context, page = page_with("busy")
    page.click("#arm-connect")
    wait_phase(page, "failed")
    check.equal("the port cannot be opened: the message", kinds(page), ["fail-open"])
    text = page.locator("#arm-messages").inner_text()
    check.ok("the port cannot be opened: another program is named", "Another program is probably using it" in text, text)
    check.ok("the port cannot be opened: the browser's words are kept", "NetworkError: Failed to open serial port." in text, text)
    check.ok("the adapter's USB ids are logged", "USB vendor 1a86, product 55d3" in page.locator("#log-output").input_value())
    context.close()

    context, page = page_with("silent")
    page.click("#arm-connect")
    wait_phase(page, "failed")
    check.equal("a port on which nothing answers: the message", kinds(page), ["fail-silent"])
    opened = page.evaluate("window.openedWith")
    check.equal(
        "the port is opened as the servos speak",
        opened[0],
        {"baudRate": 1000000, "dataBits": 8, "stopBits": 1, "parity": "none"},
    )
    # nothing answered at all, so the page asked again at each other baud rate a servo can be set to
    check.equal("and then at the other baud rates", [entry["baudRate"] for entry in opened[1:]], OTHER_BAUD_RATES)
    check.ok("always with 8 data bits, no parity, one stop bit", all([entry["dataBits"], entry["stopBits"], entry["parity"]] == [8, 1, "none"] for entry in opened), opened)
    written = page.evaluate("window.written.map(packet => packet[4])")
    check.ok("only pings and reads were written to it", set(written) <= {1, 2, 0x82} and len(written) >= 12, written)
    check.ok("the port was closed again", page.evaluate("window.portClosed === true"))
    page.click("#arm-retry")
    wait_phase(page, "failed")
    check.equal("the same port can be tried again", len(page.evaluate("window.openedWith")), 2 * (1 + len(OTHER_BAUD_RATES)))
    context.close()


def scripted_port(info: str, answer: str) -> str:
    """Returns the script of a stand-in for navigator.serial with one port, made after the Web Serial
    specification as far as the page uses a port. ``info`` is the JavaScript of what the port says of itself;
    ``answer`` that of a function from the bytes written and the port's baud rate to the bytes that come back.
    window.portLog keeps what the page did with the port: the truth the page's log is held against."""
    return (
        "window.portLog = { opened: [], written: [], closed: 0 };\n"
        f"const portInfo = {info};\n"
        f"const portAnswer = {answer};\n"
        """const port = {
          readable: null, writable: null,
          getInfo: () => portInfo,
          async open(options) {
              window.portLog.opened.push(options);
              let controller = null;
              port.readable = new ReadableStream({ start(given) { controller = given; }, cancel() { port.readable = null; } });
              port.writable = new WritableStream({
                  write(bytes) {
                      window.portLog.written.push({ baudRate: options.baudRate, bytes: [...bytes] });
                      const answer = portAnswer([...bytes], options.baudRate);
                      if (answer.length > 0) controller.enqueue(new Uint8Array(answer));
                  },
                  close() { port.writable = null; },
                  abort() { port.writable = null; } });
          },
          async close() {
              if (port.readable?.locked) throw new TypeError('Cannot cancel a locked stream');
              if (port.writable?.locked) throw new TypeError('Cannot abort a locked stream');
              port.readable = null; port.writable = null; window.portLog.closed += 1;
          } };
        Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => port } });"""
    )


USB_ADAPTER = "{ usbVendorId: 0x1a86, usbProductId: 0x55d3 }"
# five of the six servos and one with an id that is none of PEAR's: they answer PING, READ and SYNC READ as an
# STS3215 does (model 777 at address 3), and all of them a PING to every servo at once
FIVE_AND_A_STRANGER = """(bytes) => {
    const status = (id, data) => { const body = [id, data.length + 2, 0, ...data]; return [0xff, 0xff, ...body, ~body.reduce((sum, byte) => sum + byte, 0) & 0xff]; };
    const memory = (address, length) => Array.from({ length }, (_, index) => ({ 3: 0x09, 4: 0x03 })[address + index] ?? 0);
    const here = [1, 2, 3, 4, 5];
    const id = bytes[2], instruction = bytes[4], parameters = bytes.slice(5, -1);
    if (instruction === 1 && id === 0xfe) return [...here, 9].flatMap(each => status(each, []));
    if (instruction === 1) return here.includes(id) ? status(id, []) : [];
    if (instruction === 2) return here.includes(id) ? status(id, memory(parameters[0], parameters[1])) : [];
    if (instruction === 0x82) return parameters.slice(2).filter(each => here.includes(each)).flatMap(each => status(each, memory(parameters[0], parameters[1])));
    return [];
}"""
# six servos that answer PING, READ and SYNC READ as STS3215 do (model 777, firmware 3.10) and hold a calibration
# and a pose (those of the page's simulated arm): what the page reads as a calibrated arm on a port that is not
# its simulated one. Whatever is not a read gets no answer.
SIX_CALIBRATED = """(bytes) => {
    const status = (id, data) => { const body = [id, data.length + 2, 0, ...data]; return [0xff, 0xff, ...body, ~body.reduce((sum, byte) => sum + byte, 0) & 0xff]; };
    const word = (value) => [value & 0xff, value >> 8];
    // by id: Homing_Offset, Min_Position_Limit, Max_Position_Limit, Present_Position
    const servos = { 1: [-1470, 758, 3292, 2025], 2: [97, 857, 3284, 1540], 3: [1238, 836, 3069, 2003], 4: [-1028, 838, 3138, 2915], 5: [-233, 0, 4095, 996], 6: [1269, 2037, 3499, 3499] };
    const here = (each) => Object.hasOwn(servos, each);
    const memory = (id, address, length) => {
        const [homing, low, high, position] = servos[id];
        const offset = word(homing < 0 ? -homing | 0x800 : homing);  // sign and magnitude, the sign in bit 11
        const table = { 0: 3, 1: 10, 3: 0x09, 4: 0x03, 5: id, 9: word(low)[0], 10: word(low)[1], 11: word(high)[0], 12: word(high)[1],
                        31: offset[0], 32: offset[1], 56: word(position)[0], 57: word(position)[1], 62: 120, 63: 30 };
        return Array.from({ length }, (_, index) => table[address + index] ?? 0);
    };
    const id = bytes[2], instruction = bytes[4], parameters = bytes.slice(5, -1);
    if (instruction === 1 && id === 0xfe) return [1, 2, 3, 4, 5, 6].flatMap(each => status(each, []));
    if (instruction === 1) return here(id) ? status(id, []) : [];
    if (instruction === 2) return here(id) ? status(id, memory(id, parameters[0], parameters[1])) : [];
    if (instruction === 0x82) return parameters.slice(2).filter(each => here(each)).flatMap(each => status(each, memory(each, parameters[0], parameters[1])));
    return [];
}"""
# servos that answer only when all are asked at once
ONLY_TOGETHER = "(bytes) => bytes[2] === 0xfe && bytes[4] === 1 ? [1, 2, 3, 4, 5, 6].flatMap(id => [0xff, 0xff, id, 2, 0, ~(id + 2) & 0xff]) : []"


def instruction_packet(servo: int, instruction: int, parameters: list[int]) -> list[int]:
    """Returns FF FF ID LENGTH INSTRUCTION PARAMETERS... CHECKSUM, written out here and not taken from the page;
    a status packet without an error is the same with 0 for the instruction."""
    body = [servo, len(parameters) + 2, instruction, *parameters]
    return [0xFF, 0xFF, *body, ~sum(body) & 0xFF]


def part_diagnostics(check: Check, browser, context: BrowserContext, base: str) -> None:
    """What a log copied after a first contact holds: the browser, the port and the baud rate at every connection;
    the bytes that went over the line, with their times, when the handshake or a read fails; and what the page
    finds when it looks further: servos with other ids, another baud rate, a port that is not the arm's."""
    ping = lambda servo: instruction_packet(servo, 1, [])  # noqa: E731
    ping_all = instruction_packet(0xFE, 1, [])
    all_rates = [1000000, *OTHER_BAUD_RATES]

    # at a connection: the browser, what the port says of itself, the baud rate
    page = open_page(check, context, base)
    connect_sim(page)
    lines = log_lines(page)
    told = page.evaluate(
        "({ brands: navigator.userAgentData.brands.map(entry => entry.brand), platform: navigator.userAgentData.platform, agent: navigator.userAgent })"
    )
    brands = [brand for brand in told["brands"] if re.search(r"not[^a-z]*a[^a-z]*brand", brand, re.I) is None]
    browser_line = next((line for line in lines if line.startswith("Browser: ")), "")
    check.ok("at a connection the log names the browser's brands", len(brands) > 0 and all(brand in browser_line for brand in brands), [browser_line, brands])
    check.ok("with their versions and the platform", re.search(r" \d+\.\d+\.\d+\.\d+", browser_line) is not None and f"platform {told['platform']}" in browser_line, browser_line)
    check.ok("and not the brand that is none", re.search(r"not[^a-z]*a[^a-z]*brand", browser_line, re.I) is None, browser_line)
    check.ok("what the port says of itself", "Port chosen (simulated port): no USB device (simulated)" in lines, lines[:12])
    check.ok("the baud rate and the line's settings", "Port open at 1000000 baud, 8 data bits, no parity, 1 stop bit (simulated port)" in lines, lines[:12])
    order = [next((index for index, line in enumerate(lines) if line.startswith(start)), -1) for start in ("Browser: ", "Port chosen", "Port open at", "Handshake passed")]
    check.ok("in this order, before the handshake", -1 not in order and order == sorted(order), order)
    check.ok("a handshake that passes leaves no bytes in the log", not any(line.startswith("Line trace") for line in lines), lines)

    # a read fails: one servo stops answering. The log shows the bytes of that read and when they went.
    stored = page.evaluate("[1, 2, 3, 4, 5, 6].map(id => window.pearjs.sim().chain.servo(id).get('Present_Position'))")
    page.evaluate("window.pearjs.sim().chain.absent.add(3)")
    page.wait_for_function("document.getElementById('log-output').value.includes('Line trace, the failed read')")
    page.evaluate("window.pearjs.sim().chain.absent.clear()")
    lines = log_lines(page)
    check.ok("a failed read is said with lerobot's words", any(line.startswith("Read failed (1 of this connection): Failed to sync read 'Present_Position'") for line in lines), lines[-12:])
    head, pieces = trace_after(lines, "Line trace, the failed read")
    sync_read = instruction_packet(0xFE, 0x82, [56, 2, 1, 2, 3, 4, 5, 6])
    answers = flat([instruction_packet(servo, 0, [stored[servo - 1] & 0xFF, stored[servo - 1] >> 8]) for servo in (1, 2, 4, 5, 6)])
    check.ok("failed read: the totals of both attempts", "sent 28 bytes in 2 packets, received 80 bytes" in head, head)
    check.equal("failed read: what was sent, as the protocol writes a sync read of the positions", [piece[2] for piece in pieces if piece[1] == "TX"], [sync_read, sync_read])
    received = [piece[2] for piece in pieces if piece[1] == "RX"]
    check.equal("failed read: what came back is the five other servos' answers", received[0] if received else None, answers)
    check.ok("failed read: the servo that was silent is not among them", [0xFF, 0xFF, 3] not in [received[0][index : index + 3] for index in range(len(received[0]))] if received else False)
    check.equal("failed read: no more than 64 bytes of a direction are shown", sum(len(piece) for piece in received), 64)
    check.ok("failed read: a piece that was cut short says so", any(line.endswith(" ...") for line in lines if line.startswith("  +")), lines[-8:])
    times = [piece[0] for piece in pieces]
    check.ok("failed read: the times go forward", times == sorted(times) and len(times) == 4, times)
    check.ok("failed read: the second attempt comes after the time lerobot gives an answer", 45 <= times[2] - times[0] <= 250, times)
    since_open_ms = (log_seconds(page, "Read failed (1") - log_seconds(page, "Port open at")) * 1000
    check.ok("failed read: the times count from the opening of the port", 0 <= since_open_ms - times[0] <= 500, [since_open_ms, times])
    wait_phase(page, "reading")
    page.wait_for_function("document.getElementById('log-output').value.includes('The servos answer again') || !document.getElementById('log-output').value.includes('stopped answering')")
    page.close()

    # the simulated faults in which no servo answers a ping of its own
    def simulated(scenario: str) -> tuple[Page, list[str]]:
        page = open_page(check, context, base, f"?arm=sim&sim={scenario}&lang=en")
        wait_phase(page, "failed")
        return page, log_lines(page)

    page, lines = simulated("silent")
    check.equal("nothing answers: the message", kinds(page), ["fail-silent"])
    head, pieces = trace_after(lines, "Line trace, the handshake and the ping of each servo")
    check.ok("nothing answers: the totals", "sent 108 bytes in 18 packets, received 0 bytes." in head, head)
    sent = page.evaluate("window.pearjs.sim().chain.received.map(packet => [...packet])")
    check.equal("nothing answers: the simulated line got each id's ping once, then twice, a sync read and a ping to all", sent, [ping(servo) for servo in range(1, 7)] + [ping(servo) for servo in range(1, 7) for _ in range(2)] + [instruction_packet(0xFE, 0x82, [56, 2, 1, 2, 3, 4, 5, 6]), ping_all])
    check.equal("nothing answers: the log shows the first 64 bytes that the line got", flat([piece[2] for piece in pieces]), flat(sent)[:64])
    check.ok("nothing answers: every piece shown is a packet sent, none received", all(piece[1] == "TX" for piece in pieces) and len(pieces) == 11, pieces)
    times = [piece[0] for piece in pieces]
    check.ok("nothing answers: each ping waits lerobot's time for an answer", all(45 <= later - earlier <= 250 for earlier, later in zip(times, times[1:])), times)
    for rate in all_rates:
        check.ok(f"nothing answers: asked every servo at once at {rate} baud", any(line.startswith(f"Ping to every servo at once, {rate} baud: nothing came back in ") for line in lines), lines[-14:])
    check.equal("nothing answers: the port was opened at each baud rate in turn", page.evaluate("window.pearjs.sim().port.baudRates"), all_rates)
    check.ok("nothing answers: the page's conclusion is one line of the log", 'Not connected: {"kind":"silent","isUsbAdapter":null,"wasScanned":true}' in lines, lines[-3:])
    text = page.locator("#arm-messages").inner_text()
    check.ok("nothing answers: the message says what was tried", "each other baud rate a servo can be set to" in text and "never set up" not in text, text)
    check.equal("nothing answers: the port is closed at the end", page.evaluate("window.pearjs.sim().port.readable"), None)
    check.equal("nothing answers: the page counts every packet it sent", int(page.locator("#guard-line").get_attribute("data-sent")), len(sent) + len(OTHER_BAUD_RATES))
    page.close()

    page, lines = simulated("ids")
    check.equal("other ids: the message", kinds(page), ["fail-ids"])
    check.ok("other ids: named", "these ids answered: 11, 12, 13, 14, 15, 16." in page.locator("#arm-messages").inner_text(), page.locator("#arm-messages").inner_text())
    answer = flat([instruction_packet(servo, 0, []) for servo in range(11, 17)])
    wanted = f"Ping to every servo at once, 1000000 baud: answered by the ids 11, 12, 13, 14, 15, 16 (36 bytes in "
    found = next((line for line in lines if line.startswith(wanted)), "")
    check.ok("other ids: the log holds the ids and the bytes that came back", found.endswith(": " + " ".join(f"{byte:02x}" for byte in answer) + ")"), found)
    check.ok("other ids: the conclusion", 'Not connected: {"kind":"ids","found":[11,12,13,14,15,16]}' in lines, lines[-3:])
    check.equal("other ids: no other baud rate is tried", page.evaluate("window.pearjs.sim().port.baudRates"), [1000000])
    page.close()

    page, lines = simulated("baud")
    check.equal("another baud rate: the message", kinds(page), ["fail-baud"])
    text = page.locator("#arm-messages").inner_text()
    check.ok("another baud rate: named, with the ids", "at 115,200 baud these ids answered when every servo was asked at once: 1, 2, 3, 4, 5, 6." in text, text)
    check.ok("another baud rate: nothing at PEAR's", any(line.startswith("Ping to every servo at once, 1000000 baud: nothing came back in ") for line in lines), lines)
    check.ok("another baud rate: found in the log", any(line.startswith("Ping to every servo at once, 115200 baud: answered by the ids 1, 2, 3, 4, 5, 6 (36 bytes in ") for line in lines), lines[-4:])
    check.ok("another baud rate: the conclusion", 'Not connected: {"kind":"baud","baudRate":115200,"found":[1,2,3,4,5,6]}' in lines, lines[-3:])
    check.equal("another baud rate: the search ends where the servos answer", page.evaluate("window.pearjs.sim().port.baudRates"), all_rates[:5])
    received = page.evaluate("window.pearjs.sim().chain.received.map(packet => [packet[2], packet[4]])")
    check.equal("another baud rate: what reached the servos at their rate is one ping to all", received, [[0xFE, 1]])
    page.close()

    page, lines = simulated("missing")
    head, pieces = trace_after(lines, "Line trace, the handshake and the ping of each servo")
    check.ok("one servo missing: bytes went both ways", any(piece[1] == "RX" for piece in pieces) and any(piece[1] == "TX" for piece in pieces), pieces[:4])
    check.equal("one servo missing: the first exchange is the ping of id 1 and its answer", [pieces[0][1:], pieces[1][1:]], [("TX", ping(1)), ("RX", instruction_packet(1, 0, []))])
    check.ok("one servo missing: who is on the line", any(line.startswith("Ping to every servo at once, 1000000 baud: answered by the ids 1, 2, 4, 5, 6 (30 bytes in ") for line in lines), lines[-4:])
    concluded = next((line for line in reversed(lines) if line.startswith("Not connected: ")), "")
    check.ok("one servo missing: the conclusion names it", '"kind":"partial","missing":["elbow_flex"]' in concluded and '"others":[]' in concluded, concluded)
    page.close()

    # the Connect button on a stand-in of a browser's own port
    def connected(info: str, answer: str, init: str = "") -> tuple[BrowserContext, Page, list[str]]:
        own = browser.new_context(viewport={"width": 1280, "height": 800}, locale="en-US")
        check.watch(own)
        own.add_init_script(scripted_port(info, answer) + init)
        page = open_page(check, own, base)
        page.click("#arm-connect")
        wait_phase(page, "failed")
        return own, page, log_lines(page)

    own, page, lines = connected(USB_ADAPTER, "() => []")
    check.equal("a silent USB adapter: the message", kinds(page), ["fail-silent"])
    check.ok("a silent USB adapter: its ids are in the log", "Port chosen (Web Serial): USB vendor 1a86, product 55d3" in lines, lines[:10])
    check.ok("a silent USB adapter: the baud rate too", "Port open at 1000000 baud, 8 data bits, no parity, 1 stop bit (Web Serial)" in lines, lines[:10])
    port_log = page.evaluate("window.portLog")
    head, pieces = trace_after(lines, "Line trace, the handshake and the ping of each servo")
    written = [entry["bytes"] for entry in port_log["written"] if entry["baudRate"] == 1000000]
    check.equal("a silent USB adapter: the log shows the first 64 bytes the port was given", flat([piece[2] for piece in pieces]), flat(written)[:64])
    check.equal("a silent USB adapter: opened at each baud rate, as the servos speak", port_log["opened"], [{"baudRate": rate, "dataBits": 8, "stopBits": 1, "parity": "none"} for rate in all_rates])
    check.equal("a silent USB adapter: closed as often as opened", port_log["closed"], len(all_rates))
    check.equal("a silent USB adapter: at the other baud rates one ping to all each", [[entry["baudRate"], entry["bytes"]] for entry in port_log["written"] if entry["baudRate"] != 1000000], [[rate, ping_all] for rate in OTHER_BAUD_RATES])
    check.ok("a silent USB adapter: every packet is a ping or a read", {entry["bytes"][4] for entry in port_log["written"]} <= {1, 2, 0x82}, sorted({entry["bytes"][4] for entry in port_log["written"]}))
    check.ok("a silent USB adapter: the conclusion", 'Not connected: {"kind":"silent","isUsbAdapter":true,"wasScanned":true}' in lines, lines[-3:])
    check.ok("a silent USB adapter: no user agent data is missing from the log", any(line.startswith("Browser: ") for line in lines))
    own.close()

    own, page, lines = connected("{}", "() => []")
    check.equal("a port that is no USB adapter: the message", kinds(page), ["fail-silent"])
    check.ok("a port that is no USB adapter: said in the log", "Port chosen (Web Serial): no USB vendor id: not a USB adapter (a Bluetooth or built-in serial port)" in lines, lines[:10])
    check.ok("a port that is no USB adapter: said to the person", "not a USB adapter" in page.locator("#arm-messages").inner_text(), page.locator("#arm-messages").inner_text())
    check.equal("a port that is no USB adapter: no other baud rate is tried on it", [entry["baudRate"] for entry in page.evaluate("window.portLog.opened")], [1000000])
    check.ok("a port that is no USB adapter: the log says why", "The other baud rates are not tried: the port is not a USB adapter" in lines, lines[-6:])
    check.ok("a port that is no USB adapter: the conclusion", 'Not connected: {"kind":"silent","isUsbAdapter":false,"wasScanned":false}' in lines, lines[-3:])
    own.close()

    own, page, lines = connected(USB_ADAPTER, "() => [0x6f, 0x6b, 0x0d, 0x0a]")
    check.equal("another device answers: the message", kinds(page), ["fail-garbled"])
    head, pieces = trace_after(lines, "Line trace, the handshake and the ping of each servo")
    check.equal("another device answers: its bytes are in the log, after the ping they answer", [pieces[0][1:], pieces[1][1:]], [("TX", ping(1)), ("RX", [0x6F, 0x6B, 0x0D, 0x0A])])
    check.ok("another device answers: at every baud rate, and never a whole answer", sum(1 for line in lines if re.match(r"Ping to every servo at once, \d+ baud: 4 bytes came back in \d+ ms that are no whole answer: 6f 6b 0d 0a$", line)) == len(all_rates), lines[-12:])
    check.ok("another device answers: the conclusion", 'Not connected: {"kind":"garbled"}' in lines, lines[-3:])
    check.ok("another device answers: the message names that case", "another device than the arm" in page.locator("#arm-messages").inner_text())
    own.close()

    own, page, lines = connected(USB_ADAPTER, ONLY_TOGETHER)
    check.equal("servos that answer only together: the message", kinds(page), ["fail-ids"])
    check.ok("servos that answer only together: named", "these ids answered: 1, 2, 3, 4, 5, 6." in page.locator("#arm-messages").inner_text())
    check.equal("servos that answer only together: no other baud rate is tried", [entry["baudRate"] for entry in page.evaluate("window.portLog.opened")], [1000000])
    own.close()

    own, page, lines = connected(USB_ADAPTER, FIVE_AND_A_STRANGER)
    check.equal("five servos and a stranger: the message", kinds(page), ["fail-partial"])
    text = page.locator("#arm-messages").inner_text()
    check.ok("five servos and a stranger: the missing one and the stranger are named", "Not answering: gripper." in text and "Servos with other ids answer as well: 9." in text, text)
    concluded = next((line for line in reversed(lines) if line.startswith("Not connected: ")), "")
    check.ok("five servos and a stranger: the conclusion", '"missing":["gripper"]' in concluded and '"others":[9]' in concluded, concluded)
    own.close()

    # a browser without navigator.userAgentData: its user agent string stands in
    own = browser.new_context(viewport={"width": 1280, "height": 800}, locale="en-US")
    check.watch(own)
    own.add_init_script("delete Navigator.prototype.userAgentData;")
    page = open_page(check, own, base)
    connect_sim(page)
    agent = page.evaluate("[navigator.userAgentData === undefined, navigator.userAgent]")
    check.ok("without userAgentData: the browser has none", agent[0])
    check.ok("without userAgentData: the log holds the user agent string", f"Browser: {agent[1]}" in log_lines(page), log_lines(page)[:8])
    own.close()


def captured_bytes(page: Page) -> bytes:
    encoded = page.evaluate(
        """async () => {
            const bytes = new Uint8Array(await (await fetch(document.getElementById('camera-captured').src)).arrayBuffer());
            let text = '';
            for (const byte of bytes) text += String.fromCharCode(byte);
            return btoa(text);
        }"""
    )
    return base64.b64decode(encoded)


def pixel_of_capture(page: Page, x: int, y: int) -> list[int]:
    return page.evaluate(
        """async ([x, y]) => {
            const image = document.getElementById('camera-captured');
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
            const context = canvas.getContext('2d');
            context.drawImage(image, 0, 0);
            return [...context.getImageData(x, y, 1, 1).data].slice(0, 3);
        }""",
        [x, y],
    )


def check_capture(check: Check, page: Page, label: str) -> bytes:
    before = page.locator("#camera-info").get_attribute("data-bytes")
    page.click("#camera-capture")
    page.wait_for_function(
        "before => document.getElementById('camera-info').dataset.bytes !== undefined && document.getElementById('camera-info').dataset.bytes !== before",
        arg=before,
    )
    data = captured_bytes(page)
    header = jpeg_frame_header(data)
    check.ok(f"{label}: the frame is a JPEG", data[:3] == b"\xff\xd8\xff" and header is not None, data[:4])
    if header is None:
        return data
    check.equal(f"{label}: 640 x 480, as PEAR asks its camera", [header["width"], header["height"]], [640, 480])
    check.equal(f"{label}: baseline, 8 bits, three components", [header["marker"], header["precision"], header["components"]], [0xC0, 8, 3])
    check.equal(f"{label}: chroma halved both ways", header["sampling"], ["2x2", "1x1", "1x1"])
    check.equal(f"{label}: the page shows the file's size", int(page.locator("#camera-info").get_attribute("data-bytes")), len(data))
    check.ok(f"{label}: the size is plausible", 8_000 < len(data) < 200_000, len(data))
    info = page.locator("#camera-info").inner_text()
    check.ok(f"{label}: size, bytes and quality are shown", "640 × 480" in info and "quality 90" in info and f"{len(data):,}" in info, info)
    natural = page.evaluate("[document.getElementById('camera-captured').naturalWidth, document.getElementById('camera-captured').naturalHeight]")
    check.equal(f"{label}: the shown image is the file", natural, [640, 480])
    return data


def part_camera(check: Check, context: BrowserContext, base: str) -> None:
    page = open_page(check, context, base)
    check.equal("the camera starts off", page.locator("#camera-status").get_attribute("data-phase"), "off")
    check.ok("no capture before a camera runs", page.locator("#camera-capture").is_disabled())
    page.click("#camera-start")
    page.wait_for_function("document.querySelector('#camera-status').dataset.phase === 'live'")
    status = page.locator("#camera-status")
    check.equal("the fake camera delivers PEAR's size", [status.get_attribute("data-width"), status.get_attribute("data-height")], ["640", "480"])
    check.equal("and the page says so", kinds(page, "#camera-messages"), ["camera-size-ok"])
    options = page.evaluate("[...document.getElementById('camera-select').options].map(option => option.textContent)")
    check.ok("the video inputs are listed by name", any("fake" in option.lower() for option in options), options)
    check.equal("the test picture closes the list", options[-1], "Test picture (no camera needed)")
    check.ok("the preview plays", page.evaluate("(() => { const video = document.getElementById('camera-video'); return !video.paused && video.videoWidth === 640 && video.videoHeight === 480; })()"))
    asked = page.evaluate("document.getElementById('camera-video').srcObject.getVideoTracks()[0].getConstraints()")
    check.equal("the camera was asked for 640 x 480", [asked.get("width"), asked.get("height")], [{"exact": 640}, {"exact": 480}])
    check.ok("at 30 frames a second", asked.get("frameRate") in (30, {"ideal": 30}), asked.get("frameRate"))
    first = check_capture(check, page, "fake camera")
    page.wait_for_timeout(400)
    second = check_capture(check, page, "fake camera, again")
    check.ok("a second capture is a new frame", first != second)
    check.ok("the capture is logged", "Captured: JPEG 640x480" in page.locator("#log-output").input_value())

    # another device of the list
    devices = page.evaluate("[...document.getElementById('camera-select').options].map(option => option.value)")
    real = [value for value in devices if value not in ("default", "test-picture")]
    if len(real) > 1:
        page.select_option("#camera-select", real[-1])
        page.wait_for_function("document.querySelector('#camera-status').dataset.phase === 'live'")
        page.wait_for_timeout(300)
        check.equal("choosing another camera restarts the preview", page.locator("#camera-select").input_value(), real[-1])

    # the drawn test picture, through the same preview and capture
    page.select_option("#camera-select", "test-picture")
    page.wait_for_function("document.querySelector('#camera-status').textContent.startsWith('Test picture')")
    page.wait_for_function("document.getElementById('camera-video').videoWidth === 640")
    page.wait_for_timeout(300)
    check_capture(check, page, "test picture")
    # its colour bars: a swapped colour order would show here (JPEG keeps a flat colour within a few counts)
    for name, (x, y), colour in [("red bar", (440, 28), (224, 58, 47)), ("blue bar", (520, 28), (47, 85, 224)), ("yellow bar", (120, 28), (255, 212, 0))]:
        pixel = pixel_of_capture(page, x, y)
        check.ok(f"test picture: the {name} keeps its colour", all(abs(pixel[i] - colour[i]) <= 12 for i in range(3)), f"{pixel} against {colour}")

    page.click("#camera-stop")
    page.wait_for_function("document.querySelector('#camera-status').dataset.phase === 'off'")
    check.ok("stopping the camera keeps the captured frame", page.locator("#camera-captured").is_visible())
    check.ok("and ends its track", page.evaluate("document.getElementById('camera-video').srcObject === null"))
    page.close()


def part_camera_failures(check: Check, playwright, browser, base: str) -> None:
    """A browser with no camera at all, one that refuses in its own way, and the refusals a headless browser
    cannot be brought to make itself, which a stand-in of getUserMedia makes."""
    plain = playwright.chromium.launch(headless=True, args=["--disable-gpu"])
    context = plain.new_context(viewport={"width": 1280, "height": 800}, locale="en-US")
    check.watch(context)
    page = open_page(check, context, base)
    page.click("#camera-start")
    page.wait_for_function("document.querySelector('#camera-messages .box') !== null")
    check.equal("no camera: the message", kinds(page, "#camera-messages"), ["camera-fail-NotFoundError"])
    check.ok("no camera: what to do", "Plug in the wrist camera's USB cable" in page.locator("#camera-messages").inner_text())
    page.select_option("#camera-select", "test-picture")
    page.click("#camera-start")
    page.wait_for_function("document.querySelector('#camera-status').dataset.phase === 'live'")
    check.equal("the test picture works without any camera", kinds(page, "#camera-messages"), ["camera-size-ok"])
    context.close()
    plain.close()

    # a headless Chromium with a camera and nobody to ask refuses with an error of its own
    silent = playwright.chromium.launch(headless=True, args=["--disable-gpu", "--use-fake-device-for-media-stream"])
    context = silent.new_context(viewport={"width": 1280, "height": 800}, locale="en-US")
    check.watch(context)
    page = open_page(check, context, base)
    page.click("#camera-start")
    page.wait_for_function("document.querySelector('#camera-messages .box') !== null")
    text = page.locator("#camera-messages").inner_text()
    check.ok("an error the page has no words for is shown in the browser's", "The camera could not be started: " in text and "Error" in text, text)
    context.close()
    silent.close()

    for name, phrase in (("NotAllowedError", "System Settings"), ("NotReadableError", "Another program is probably using it")):
        context = browser.new_context(viewport={"width": 1280, "height": 800}, locale="en-US")
        check.watch(context)
        context.add_init_script(
            "if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => "
            f"Promise.reject(new DOMException('refused for the check', '{name}'));"
        )
        page = open_page(check, context, base)
        page.click("#camera-start")
        page.wait_for_function("document.querySelector('#camera-messages .box') !== null")
        check.equal(f"{name}: the message", kinds(page, "#camera-messages"), [f"camera-fail-{name}"])
        check.ok(f"{name}: what to do", phrase in page.locator("#camera-messages").inner_text(), page.locator("#camera-messages").inner_text())
        check.ok(f"{name}: the camera can be started again", page.locator("#camera-start").is_enabled())
        context.close()


def run_model_check(page: Page, url: str, model: str, key: str) -> str:
    page.fill("#model-url", url)
    page.fill("#model-name", model)
    page.fill("#model-key", key)
    page.click("#model-check")
    page.wait_for_function("!['', 'checking'].includes(document.getElementById('model-result').dataset.outcome)", timeout=20000)
    return page.locator("#model-result").get_attribute("data-outcome") or ""


def part_model(check: Check, context: BrowserContext, base: str, service: str, closed_port: int) -> None:
    page = open_page(check, context, base)
    api = f"{service}/v1"
    result = page.locator("#model-result")

    ModelService.configure()
    check.equal("no key asked, no name given: connected", run_model_check(page, api, "", ""), "ok")
    check.equal("the one served model's name is filled in", page.locator("#model-name").input_value(), MODEL)
    check.ok("and the page says where the name came from", "taken from the service's own list" in result.inner_text(), result.inner_text())
    sent = [entry for entry in ModelService.seen if entry["method"] == "GET"][-1]
    check.equal("without a key the client sends PEAR's word", sent["headers"].get("authorization"), "Bearer unused")

    ModelService.configure(keys=[KEY])
    check.equal("the right key: connected", run_model_check(page, api, MODEL, KEY), "ok")
    sent = [entry for entry in ModelService.seen if entry["method"] == "GET"][-1]
    check.equal("the key goes out as a bearer token", sent["headers"].get("authorization"), f"Bearer {KEY}")
    check.ok("a preflight came first, without the key", any(entry["method"] == "OPTIONS" and "authorization" not in entry["headers"] for entry in ModelService.seen))

    check.equal("a wrong key, as a vLLM server refuses it: withheld by the browser", run_model_check(page, api, MODEL, OTHER_KEY), "blocked")
    text = result.inner_text()
    check.ok("withheld: both reasons are given", "does not allow this page's origin" in text and "The key is wrong" in text, text)
    check.ok("withheld: the page's origin is named", base in text, text)
    check.ok("withheld: what the operator must allow", all(word in text for word in ("GET", "POST", "Authorization", "Content-Type", "OPTIONS", "--allowed-origins")), text)

    ModelService.configure(keys=[KEY], refusal_has_cors=True)
    check.equal("a wrong key, refused where the browser may show it", run_model_check(page, api, MODEL, OTHER_KEY), "key")
    check.ok("said with its status", "refused the key (HTTP 401)" in result.inner_text(), result.inner_text())

    ModelService.configure(keys=[KEY], allowed_origins=["http://allowed.invalid"])
    check.equal("a service that does not allow the page's origin", run_model_check(page, api, MODEL, KEY), "blocked")
    check.ok("its refusal names the origin to allow", base in result.inner_text())
    ModelService.configure(keys=[KEY], allowed_origins=[base])
    check.equal("a service that allows exactly the page's origin", run_model_check(page, api, MODEL, KEY), "ok")

    ModelService.configure(models=["model-a", "model-b"])
    check.equal("several models and no name: a choice", run_model_check(page, api, "", ""), "choose")
    check.equal("the served names are offered", page.evaluate("[...document.querySelectorAll('#model-result button')].map(button => button.dataset.model)"), ["model-a", "model-b"])
    page.click("#model-result button[data-model=model-b]")
    page.wait_for_function("document.getElementById('model-result').dataset.outcome === 'ok'")
    check.equal("choosing one checks it", page.locator("#model-name").input_value(), "model-b")
    check.equal("a name the service does not serve", run_model_check(page, api, "model-c", ""), "not-served")
    check.ok("with the names it does serve", "model-a" in result.inner_text() and "model-b" in result.inner_text())
    check.ok("and the library's own sentence", "vLLM model is not served: model-c" in result.inner_text(), result.inner_text())
    ModelService.configure(models=[])
    check.equal("a service that lists no model", run_model_check(page, api, "", ""), "choose")
    check.ok("said plainly", "list of models is empty" in result.inner_text())

    ModelService.configure()
    check.equal("a base URL without /v1", run_model_check(page, service, MODEL, ""), "not-found")
    check.ok("the usual ending is named", "usually ends in /v1" in result.inner_text())
    ModelService.configure(is_other_service=True)
    check.equal("an address that is no model service", run_model_check(page, api, MODEL, ""), "not-a-service")
    ModelService.configure(delay_s=3.6)
    started = time.monotonic()
    check.equal("a service that does not answer in time", run_model_check(page, api, MODEL, ""), "timeout")
    check.ok("after the client's 3 s", 2.9 <= time.monotonic() - started <= 6, time.monotonic() - started)
    ModelService.configure()
    time.sleep(0.8)

    check.named_services.add(f"127.0.0.1:{closed_port}")
    check.equal("nothing listens at the address", run_model_check(page, f"http://127.0.0.1:{closed_port}/v1", MODEL, KEY), "unreachable")
    check.ok("what to check is said", "that the service is running" in result.inner_text())
    for label, url in {
        "no address": "",
        "not HTTP": "ftp://127.0.0.1/v1",
        "a user name and password in the address": f"http://operator:{URL_SECRET}@127.0.0.1:{closed_port}/v1",
    }.items():
        requests_before = len(check.requests)
        check.equal(f"{label}: refused", run_model_check(page, url, MODEL, KEY), "refused")
        check.equal(f"{label}: no request was made", len(check.requests), requests_before)
    check.ok("the library's reason is shown", "Model base_url must be HTTP(S) without embedded credentials" in result.inner_text(), result.inner_text())
    check.equal("the key's field still holds the key", page.locator("#model-key").input_value(), KEY)

    # Enter in a field runs the check
    ModelService.configure()
    page.fill("#model-url", api)
    page.fill("#model-key", "")
    page.press("#model-name", "Enter")
    page.wait_for_function("document.getElementById('model-result').dataset.outcome === 'ok'")
    check.equal("Enter runs the check", result.get_attribute("data-outcome"), "ok")
    check.page_for_privacy = page  # the privacy part looks at this page as it was left


def part_privacy(check: Check, context: BrowserContext, service: str) -> None:
    page = check.page_for_privacy
    page.fill("#model-key", KEY)
    ModelService.configure(keys=[KEY])
    check.equal("privacy: a check with the key", run_model_check(page, f"{service}/v1", MODEL, KEY), "ok")
    # with the key in its field the page writes the bytes of a failed read to its log: servo bytes, nothing else
    connect_sim(page)
    page.evaluate("window.pearjs.sim().chain.absent.add(2)")
    page.wait_for_function("document.getElementById('log-output').value.includes('Line trace, the failed read')")
    page.evaluate("window.pearjs.sim().chain.absent.clear()")
    check.ok("privacy: the log now holds a line trace", "Line trace, the failed read" in page.locator("#log-output").input_value())
    stored = page.evaluate(
        """async () => ({
            local: Object.entries(localStorage), session: Object.entries(sessionStorage), cookie: document.cookie,
            databases: (await indexedDB.databases()).map(database => database.name),
            caches: 'caches' in window ? await caches.keys() : [],
            url: location.href, title: document.title,
            markup: document.documentElement.outerHTML, text: document.body.innerText,
            log: document.getElementById('log-output').value,
            history: history.length,
        })"""
    )
    check.equal("nothing in localStorage", stored["local"], [])
    check.equal("nothing in sessionStorage", stored["session"], [])
    check.equal("no cookie", stored["cookie"], "")
    check.equal("no database", stored["databases"], [])
    check.equal("no cache", stored["caches"], [])
    check.equal("no cookie in the browser's jar", context.cookies(), [])
    for secret, label in ((KEY, "the key"), (OTHER_KEY, "the wrong key"), (URL_SECRET, "the password of an address")):
        check.ok(f"{label} is not in the address", secret not in stored["url"])
        check.ok(f"{label} is not in the log", secret not in stored["log"])
        check.ok(f"{label} is not in the page's text", secret not in stored["text"])
        check.ok(f"{label} is not in the page's markup", secret not in stored["markup"])
    check.ok("the log holds the check without the key", "Model check: GET http://127.0.0.1:" in stored["log"], stored["log"][-400:])

    carriers = []
    for entry in check.requests:
        places = []
        if KEY in entry["url"] or OTHER_KEY in entry["url"] or URL_SECRET in entry["url"]:
            places.append("url")
        if entry["body"] and (KEY in entry["body"] or OTHER_KEY in entry["body"]):
            places.append("body")
        for name, value in entry["headers"].items():
            if KEY in value or OTHER_KEY in value:
                places.append(f"header {name.lower()}")
        if places:
            carriers.append((urlsplit(entry["url"]).netloc, entry["method"], tuple(places)))
    # the addresses that were given to the page as the model service's
    named = {urlsplit(service).netloc, *check.named_services}
    check.ok("the key was sent at all", len(carriers) > 0)
    check.ok(
        "the key left the page only in the Authorization header to the model service",
        all(host in named and places == ("header authorization",) for host, _, places in carriers),
        sorted(set(carriers)),
    )
    probes = [entry for entry in ModelService.seen if entry["headers"].get("sec-fetch-mode") == "no-cors"]
    check.ok("the page asked whether the address is there, where a check had failed", len(probes) >= 2, len(probes))
    check.ok("and that question carried no key", all("authorization" not in entry["headers"] for entry in probes))
    seen_keys = [
        (entry["method"], name)
        for entry in ModelService.seen
        for name, value in entry["headers"].items()
        if KEY in value or OTHER_KEY in value or KEY in entry["path"] or OTHER_KEY in entry["path"]
    ]
    check.ok("the service saw the key in Authorization only", set(seen_keys) <= {("GET", "authorization")} and len(seen_keys) > 0, sorted(set(seen_keys)))
    check.ok("no preflight carried the key", all(method != "OPTIONS" for method, _ in seen_keys))
    page.reload()
    page.wait_for_function("window.pearjs !== undefined")
    check.equal("after a reload the key is gone", page.locator("#model-key").input_value(), "")
    page.close()


def texts_filled(page: Page) -> list[str]:
    """Returns what is wrong with the texts of the page as it stands: an element left empty, a name left unfilled."""
    return page.evaluate(
        """() => {
            const problems = [];
            for (const element of document.querySelectorAll('[data-i18n]')) {
                if (element.textContent.trim() === '') problems.push('empty: ' + element.dataset.i18n);
            }
            for (const name of ['placeholder', 'aria-label']) {
                for (const element of document.querySelectorAll(`[data-i18n-${name}]`)) {
                    if (!element.getAttribute(name)) problems.push(`no ${name}: ` + element.id);
                }
            }
            const unfilled = document.body.innerText.match(/\\{[a-zA-Z]+\\}/g);
            if (unfilled) problems.push('unfilled: ' + unfilled.join(' '));
            return problems;
        }"""
    )


def has_han(text: str) -> bool:
    return re.search(r"[一-鿿]", text) is not None


INSTRUCTION = "Put the red block into the box (check 7421)."
COUNT_WORKERS = (
    "window.workersStarted = 0;\n"
    "window.Worker = class extends Worker { constructor(...parts) { super(...parts); window.workersStarted += 1; } };\n"
)
# The kinds of packets the guard has counted: the names of its counts above zero.
GUARD_KINDS = """() => {
  const kinds = [];
  const walk = (value, path) => {
    if (typeof value === 'number') { if (value > 0) kinds.push(path); }
    else if (value !== null && typeof value === 'object') {
      for (const [name, inner] of Object.entries(value)) walk(inner, path === '' ? name : `${path}.${name}`);
    }
  };
  walk(window.pearjs.arm.view.guard, '');
  return kinds.sort();
}"""
DECODE_JPEG = """async (data) => {
  const bytes = Uint8Array.from(atob(data), (letter) => letter.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  return [bitmap.width, bitmap.height];
}"""


def recorded_answer() -> tuple[list[str], dict]:
    """Returns a complete answer of a vLLM server as the library's fixtures recorded one for PEAR's own client
    (tests/fixtures/agent/client.json, the first turn of "three turns of one task"): the pieces of the response's
    body as the recording server sent them, and what PEAR's client returned for them."""
    recorded = json.loads((REPOSITORY / "tests" / "fixtures" / "agent" / "client.json").read_text(encoding="utf-8"))
    scenario = next(entry for entry in recorded["scenarios"] if entry["name"] == "three turns of one task")
    step = next(entry for entry in scenario["steps"] if entry["op"] == "infer")
    return [piece["data"] for piece in step["responses"][0]["body"]], step["outcome"]["returned"]


def wait_asked(page: Page) -> str:
    page.wait_for_function("!['', 'asking'].includes(document.getElementById('ask-result').dataset.outcome)", timeout=20000)
    return page.locator("#ask-result").get_attribute("data-outcome") or ""


def wait_missing(page: Page, wanted: str) -> str | None:
    """Waits, at most five seconds, until the page names ``wanted`` as what an ask lacks ("" for nothing) and
    returns what it names then: a check of the note may not depend on whether the page had rendered it yet."""
    try:
        page.wait_for_function("wanted => document.getElementById('ask-missing').dataset.missing === wanted", arg=wanted, timeout=5000)
    except WaitTimeout:
        pass
    return page.locator("#ask-missing").get_attribute("data-missing")


# How many packets the guard has counted so far, of every kind, passed or refused: every read of the arm raises it.
GUARD_PACKETS = """(() => {
  let total = 0;
  const walk = (value) => {
    if (typeof value === 'number') total += value;
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(window.pearjs.arm.view.guard);
  return total;
})()"""


def wait_read_again(page: Page, count: str, before: int) -> int:
    """Waits, at most five seconds, for the page's next read of the arm: until ``count``, an expression that every
    read raises, is above ``before``. Returns the count then; it is still ``before`` when no read came."""
    try:
        page.wait_for_function(f"before => ({count}) > before", arg=before, timeout=5000)
    except WaitTimeout:
        pass
    return page.evaluate(count)


def ask_page(check: Check, browser, base: str, service: str, label: str, port: str | None) -> tuple[BrowserContext, Page]:
    """Opens a page of its own and brings it to where "Ask the model once" is offered, on the simulated arm or,
    with ``port``, on a stand-in of a browser's port; checks at each step what the page calls missing."""
    own = browser.new_context(viewport={"width": 1280, "height": 800}, locale="en-US")
    check.watch(own)
    own.add_init_script(COUNT_WORKERS)
    if port is not None:
        own.add_init_script(port)
    page = open_page(check, own, base)
    button = page.locator("#ask-once")

    # what the page calls missing is asked with a wait for it (wait_missing), never read at once
    lacking = wait_missing(page, "ask.need.arm")
    check.ok(f"{label}: no arm is read: Ask is not offered, an arm is missing", button.is_disabled() and lacking == "ask.need.arm", lacking)
    page.click("#arm-sim" if port is None else "#arm-connect")
    wait_phase(page, "reading")
    page.wait_for_function("window.pearjs.arm.view.live !== null && window.pearjs.arm.view.live.turnText !== null")
    if port is not None:
        check.equal(f"{label}: an arm is read: a camera is missing", wait_missing(page, "ask.need.camera"), "ask.need.camera")
        page.select_option("#camera-select", "test-picture")
        page.click("#camera-start")
    page.wait_for_function("document.querySelector('#camera-status').dataset.phase === 'live'")
    check.equal(f"{label}: a camera runs: a checked model service is missing", wait_missing(page, "ask.need.model"), "ask.need.model")
    check.equal(f"{label}: the service is checked", run_model_check(page, f"{service}/v1", MODEL, KEY), "ok")
    check.equal(f"{label}: the service is checked: an instruction is missing", wait_missing(page, "ask.need.instruction"), "ask.need.instruction")
    check.ok(f"{label}: Ask is still not offered", button.is_disabled())
    page.fill("#task-instruction", INSTRUCTION)
    lacking = wait_missing(page, "")
    check.ok(f"{label}: an instruction is written: Ask is offered", lacking == "" and button.is_enabled(), lacking)
    return own, page


def ask_once(check: Check, browser, base: str, service: str, label: str, port: str | None) -> None:
    """One ask that is answered: what the service was sent, what the page shows, and that nothing moved."""
    pieces, returned = recorded_answer()
    ModelService.configure(keys=[KEY], stream=pieces)
    own, page = ask_page(check, browser, base, service, label, port)
    seen_before = len(ModelService.seen)
    log_before = len(log_lines(page))
    turn_text = page.locator("#turn-text").text_content()
    kinds_before = page.evaluate(GUARD_KINDS)
    written_before = page.evaluate("window.portLog.written.length") if port is not None else 0
    page.click("#ask-once")
    check.equal(f"{label}: the model answered, and the answer ends in an action", wait_asked(page), "action")
    packets_at_answer = page.evaluate(GUARD_PACKETS)
    written_at_answer = page.evaluate("window.portLog.written.length") if port is not None else 0
    asked = ModelService.seen[seen_before:]
    posts = [entry for entry in asked if entry["method"] == "POST"]
    check.equal(f"{label}: the service was asked once", [entry["path"] for entry in posts], ["/v1/chat/completions"])
    if len(posts) != 1:
        own.close()
        return

    headers, body = posts[0]["headers"], json.loads(posts[0]["body"])
    check.equal(f"{label}: the request's Origin is the page's origin", headers.get("origin"), base)
    check.equal(f"{label}: its Authorization carries the key", headers.get("authorization"), f"Bearer {KEY}")
    check.ok(
        f"{label}: a preflight for the POST came first, without the key",
        any(entry["method"] == "OPTIONS" and entry["headers"].get("access-control-request-method") == "POST" and "authorization" not in entry["headers"] for entry in asked),
        [(entry["method"], entry["path"]) for entry in asked],
    )
    check.equal(f"{label}: the request asks for a stream", body.get("stream"), True)
    check.equal(f"{label}: it names the model that was checked", body.get("model"), MODEL)
    messages = body.get("messages", [])
    check.equal(f"{label}: a system message, then the turn", [message["role"] for message in messages], ["system", "user"])
    check.ok(f"{label}: the system message holds the instruction", INSTRUCTION in messages[0]["content"], messages[0]["content"][-160:])
    parts = messages[1]["content"]
    texts = [part["text"] for part in parts if part["type"] == "text"]
    images = [part["image_url"]["url"] for part in parts if part["type"] == "image_url"]
    check.equal(f"{label}: the user message's text is exactly the turn's text of step 1, then PEAR's name of the camera", texts, [turn_text, "[wrist]"])
    check.ok(f"{label}: one image, as a JPEG's data", len(images) == 1 and images[0].startswith("data:image/jpeg;base64,"), [image[:40] for image in images])
    data = images[0].split(",", 1)[1]
    jpeg = base64.b64decode(data)
    check.equal(f"{label}: the image decodes to 640 x 480", page.evaluate(DECODE_JPEG, data), [640, 480])
    check.ok(f"{label}: its bytes are a JPEG's from the first to the last", jpeg[:2] == b"\xff\xd8" and jpeg[-2:] == b"\xff\xd9", (jpeg[:2], jpeg[-2:]))

    result = page.locator("#ask-result")
    written = returned["answer"].split("```json")[-1].split("```")[0].strip()
    check.equal(f"{label}: the page shows the scripted answer byte for byte", page.locator("#ask-answer").text_content(), returned["answer"])
    check.equal(f"{label}: and the scripted reasoning", page.locator("#ask-reasoning").text_content(), returned["reasoning"])
    check.ok(f"{label}: the phase is no longer shown once the answer is there", page.locator("#ask-phase-part").is_hidden())
    timings = page.locator("#ask-performance").text_content() or ""
    check.ok(f"{label}: the timings the client reported", page.locator("#ask-performance-part").is_visible() and timings != "", timings)
    usage = page.locator("#ask-usage").text_content() or ""
    check.ok(f"{label}: the tokens the service reported", all(f"{name} {returned['usage'][name]}" in usage for name in ("input", "output", "cached_input")), usage)
    shown = json.loads(page.locator("#ask-action").get_attribute("data-action") or "{}")
    check.equal(f"{label}: the action is the scripted one", {name: shown.get(name) for name in ("arm", "gripper")}, json.loads(written))
    check.equal(f"{label}: shown as the JSON the model wrote", page.locator("#ask-action-json").text_content(), written)
    sentence = page.locator("#ask-action-sentence").inner_text()
    check.ok(f"{label}: and in a sentence", "z +1.5 cm" in sentence and "x +0.0 cm" in sentence and "hold the gripper as it is" in sentence, sentence)
    check.equal(f"{label}: what was sent is shown: the turn's text", page.locator("#ask-sent-text").text_content(), turn_text)
    # step 1's text is compared after the page's next render of the arm, which follows the answer: the render that
    # writes the text also writes the count of the readings, so the count's change is waited for (at most 5 s)
    readings_at_answer = page.locator("#arm-readings").text_content()
    try:
        page.wait_for_function("before => document.getElementById('arm-readings').textContent !== before", arg=readings_at_answer, timeout=5000)
    except WaitTimeout:
        pass
    readings_after = page.locator("#arm-readings").text_content()
    check.ok(f"{label}: step 1 was rendered again after the answer", readings_after != readings_at_answer and readings_after != "", (readings_at_answer, readings_after))
    check.equal(f"{label}: and step 1 shows the same text after the ask as before it", page.locator("#turn-text").text_content(), turn_text)
    check.ok(f"{label}: the page says that nothing was sent to the arm", "Nothing was sent to the arm" in page.locator("#ask-not-sent").inner_text())
    check.equal(f"{label}: the client was closed", result.get_attribute("data-closed"), "true")
    check.ok(f"{label}: Ask is offered again, Cancel is not", page.locator("#ask-once").is_enabled() and page.locator("#ask-cancel").is_disabled())

    # nothing moved, nothing was started. Asked after the page's next read of the arm: a recorded answer can come
    # faster than that read (about ten a second), and what is asked here may not depend on which came first
    packets_after = wait_read_again(page, GUARD_PACKETS, packets_at_answer)
    check.ok(f"{label}: the arm was read again after the answer", packets_after > packets_at_answer, (packets_at_answer, packets_after))
    check.equal(f"{label}: the guard refused nothing", int(page.locator("#guard-line").get_attribute("data-refused") or "0"), 0)
    check.ok(f"{label}: the guard counts packets", len(kinds_before) > 0, kinds_before)
    check.equal(f"{label}: the guard counts no new kind of packet", page.evaluate(GUARD_KINDS), kinds_before)
    check.equal(f"{label}: no Worker was started", page.evaluate("window.workersStarted"), 0)
    if port is not None:
        written_after = wait_read_again(page, "window.portLog.written.length", written_at_answer)
        check.ok(
            f"{label}: and the reading went on: the port was written to again after the answer",
            written_after > written_at_answer >= written_before,
            (written_before, written_at_answer, written_after),
        )
        instructions = page.evaluate("[...new Set(window.portLog.written.map((entry) => entry.bytes[4]))].sort((a, b) => a - b)")
        check.ok(f"{label}: the port was given nothing but reads (the instructions 1, 2 and 0x82)", len(instructions) > 0 and set(instructions) <= {1, 2, 0x82}, instructions)

    lines = log_lines(page)[log_before:]
    said = "\n".join(lines)
    check.ok(
        f"{label}: the log says what happened",
        all(any(words in line for line in lines) for words in ("Ask the model once: asked.", "answered after", "the answer ends in an action, which was not executed", "the client is closed")),
        lines,
    )
    secrets = (KEY, urlsplit(service).netloc, INSTRUCTION, "Moving up", "The cube is", '"arm"', "base64", turn_text.split("\n")[0])
    check.equal(f"{label}: the log holds no key, no address, no instruction, no answer, no state and no image", [secret for secret in secrets if secret in said], [])
    check.ok(f"{label}: the whole log holds no key", KEY not in page.locator("#log-output").input_value())
    own.close()


def ask_failures(check: Check, browser, base: str, service: str) -> None:
    """What can go wrong, on one page of the simulated arm: each time what the page shows, in PEAR's words, that
    the client is closed and that Ask is offered again."""
    pieces, _ = recorded_answer()
    ModelService.configure(keys=[KEY], stream=pieces)
    own, page = ask_page(check, browser, base, service, "what can go wrong", None)
    result, button, pear = page.locator("#ask-result"), page.locator("#ask-once"), page.locator("#ask-pear")

    def after(label: str, outcome: str, words: list[str]) -> None:
        check.equal(f"{label}: the page says so", wait_asked(page), outcome)
        said = pear.text_content() or ""
        check.ok(f"{label}: in PEAR's words", said != "" and all(word in said for word in words), said)
        check.ok(f"{label}: the key is not shown", KEY not in page.locator("#ask").inner_text() and OTHER_KEY not in page.locator("#ask").inner_text())
        check.equal(f"{label}: the client is closed", result.get_attribute("data-closed"), "true")
        check.ok(f"{label}: no action is shown", page.locator("#ask-action").is_hidden())
        check.ok(f"{label}: the page says that nothing was sent to the arm", "Nothing was sent to the arm" in page.locator("#ask-not-sent").inner_text())
        check.ok(f"{label}: Ask is offered again", button.is_enabled() and page.locator("#ask-cancel").is_disabled())

    # the service takes another key now, and answers where the browser may show it
    ModelService.configure(keys=[OTHER_KEY], refusal_has_cors=True, stream=pieces)
    page.click("#ask-once")
    after("a wrong key (401)", "failed", ["AuthenticationError", "Error code: 401", "Unauthorized"])
    # as a vLLM server refuses it, outside its CORS middleware: the browser withholds the refusal from the page
    ModelService.configure(keys=[OTHER_KEY], stream=pieces)
    page.click("#ask-once")
    after("a wrong key, withheld by the browser", "failed", ["Connection error"])
    # the page asked whether something answers there, and says why a browser shows no reason, as step 3 words it
    explain = page.locator("#ask-explain")
    said = explain.inner_text()
    check.ok(
        "a wrong key, withheld by the browser: the page says that the browser withheld the answer, and the two usual reasons",
        result.get_attribute("data-withheld") == "true"
        and "the browser withheld its answer" in said
        and "the key is wrong" in said
        and f"does not allow this page's origin ({page.evaluate('location.origin')})" in said,
        said,
    )
    lines = [line for line in page.locator("#log-output").input_value().splitlines() if "the browser withheld its answer from this page" in line]
    check.ok("a wrong key, withheld by the browser: the log says so once, without an address", len(lines) == 1 and "http" not in lines[0], lines)
    page.click("#language-zh")
    try:
        page.wait_for_function("document.getElementById('ask-explain').textContent.includes('瀏覽器不讓本頁讀取回應')", timeout=5000)
    except WaitTimeout:
        pass
    said = explain.inner_text()
    check.ok("a wrong key, withheld by the browser: and in Chinese", "瀏覽器不讓本頁讀取回應" in said and "金鑰不對" in said and "PEAR 的原話" in said, said)
    page.click("#language-en")
    try:
        page.wait_for_function("!document.getElementById('ask-explain').textContent.includes('PEAR 的原話')", timeout=5000)
    except WaitTimeout:
        pass

    ModelService.configure(keys=[KEY], stream=[piece for piece in pieces if "```" not in piece])
    page.click("#ask-once")
    after("an answer without an action", "no-action", ["ValueError: Final answer must end with a fenced json action"])
    check.equal("an answer without an action: the answer is shown", (page.locator("#ask-answer").text_content() or "").strip(), "Moving up.")

    ModelService.configure(keys=[KEY], stream=pieces, stream_stalls_after=4)
    page.click("#ask-once")
    page.wait_for_function("document.getElementById('ask-result').dataset.outcome === 'asking' && document.getElementById('ask-answer').textContent.includes('Moving up.')")
    check.ok("Cancel: it is offered while the answer streams, Ask is not", page.locator("#ask-cancel").is_enabled() and button.is_disabled())
    check.equal("Cancel: PEAR's word for the phase is shown while the answer streams", page.locator("#ask-phase").text_content(), "Thinking")
    check.equal("Cancel: and the reasoning so far", page.locator("#ask-reasoning").text_content(), "The cube is left of the gripper.")
    check.equal("Cancel: the page shows the answer so far", (page.locator("#ask-answer").text_content() or "").strip(), "Moving up.")
    page.click("#ask-cancel")
    after("Cancel while the answer streams", "cancelled", [])

    ModelService.configure(keys=[KEY], stream=pieces, is_gone=True)
    page.click("#ask-once")
    after("a service that is gone", "failed", ["Connection error"])
    said = page.locator("#ask-explain").inner_text()
    check.ok(
        "a service that is gone: the page does not say that an answer was withheld",
        result.get_attribute("data-withheld") == "false" and "withheld" not in said and "The model service gave no answer" in said,
        said,
    )

    ModelService.configure(keys=[KEY], stream=pieces)
    page.click("#ask-once")
    check.equal("after the failures the next ask is answered", wait_asked(page), "action")
    packets = page.evaluate(GUARD_PACKETS)
    check.ok("the arm was read again after that answer", wait_read_again(page, GUARD_PACKETS, packets) > packets, packets)
    check.equal("nothing was refused by the guard meanwhile", int(page.locator("#guard-line").get_attribute("data-refused") or "0"), 0)
    check.equal("and no Worker was started", page.evaluate("window.workersStarted"), 0)
    check.ok("the log holds no key", KEY not in page.locator("#log-output").input_value() and OTHER_KEY not in page.locator("#log-output").input_value())

    # while the station drives the simulated arm this window does not read it: the ask is not offered, and the page
    # says what to do; with the station disabled again it is offered as before
    check.ok("before the station is enabled Ask is offered", wait_missing(page, "") == "" and button.is_enabled())
    page.click("#station-enable")
    wait_station(page, "view.phase === 'on' && view.status !== null && view.status.robot === 'READY'")
    lacking = wait_missing(page, "ask.need.station")
    said = page.locator("#ask-missing").inner_text()
    check.ok(
        "while the station drives the arm Ask is not offered, and the page says to disable the station first",
        lacking == "ask.need.station" and button.is_disabled() and "Disable the station first" in said,
        (lacking, said),
    )
    page.click("#station-disable")
    wait_station(page, "view.phase === 'off'")
    lacking = wait_missing(page, "")
    check.ok("with the station disabled again Ask is offered", lacking == "" and button.is_enabled(), lacking)

    # a camera that runs and gives no frame at the click (the preview's picture is taken away for the moment): no
    # request goes out, and the ask says so itself; with the picture back the next ask is answered. Each step
    # waits for the note or the answer it means.
    seen_before = len(ModelService.seen)
    page.evaluate("(() => { const video = document.getElementById('camera-video'); window.heldStream = video.srcObject; video.srcObject = null; })()")
    page.click("#ask-once")
    try:
        page.wait_for_function("document.getElementById('ask-missing').dataset.frame === 'none'", timeout=5000)
    except WaitTimeout:
        pass
    said = page.locator("#ask-missing").inner_text()
    check.ok(
        "a camera without a frame at the click: the ask says that the model was not asked, and why",
        page.locator("#ask-missing").get_attribute("data-frame") == "none" and "The model was not asked" in said and "no fresh frame" in said,
        said,
    )
    check.ok("a camera without a frame at the click: Ask is offered again, and no result is shown", button.is_enabled() and result.is_hidden())
    check.equal("a camera without a frame at the click: the service saw no request", len(ModelService.seen) - seen_before, 0)
    check.equal("a camera without a frame at the click: the camera is still called running", page.locator("#camera-status").get_attribute("data-phase"), "live")
    page.evaluate("(async () => { const video = document.getElementById('camera-video'); video.srcObject = window.heldStream; await video.play(); })()")
    page.wait_for_function("(() => { const video = document.getElementById('camera-video'); return video.readyState >= 2 && video.videoWidth > 0; })()")
    page.click("#ask-once")
    check.equal("with a frame again the ask is answered", wait_asked(page), "action")
    check.equal("and the note of the missing frame is gone", page.locator("#ask-missing").inner_text(), "")

    # an arm that is connected and read, and whose state the page cannot make (the simulated arm as it leaves the
    # factory: never calibrated): the ask is not offered, and the page names the reading, not a missing arm
    page.select_option("#sim-scenario", "factory")
    lacking = wait_missing(page, "ask.need.reading")
    wait_phase(page, "reading")
    lacking = wait_missing(page, "ask.need.reading")
    said = page.locator("#ask-missing").inner_text()
    check.ok(
        "an arm that is read without a complete reading: Ask is not offered, and the page names the reading, not a missing arm",
        lacking == "ask.need.reading" and button.is_disabled() and "no complete reading" in said and "Start the simulated arm" not in said,
        (lacking, said),
    )
    page.select_option("#sim-scenario", "normal")
    lacking = wait_missing(page, "")
    check.ok("with a complete reading again Ask is offered", lacking == "" and button.is_enabled(), lacking)
    own.close()


def part_ask(check: Check, browser, base: str, service: str) -> None:
    ask_once(check, browser, base, service, "simulated arm", None)
    ask_once(check, browser, base, service, "a real arm", scripted_port(USB_ADAPTER, SIX_CALIBRATED))
    ask_failures(check, browser, base, service)
    ModelService.configure()


def part_languages(check: Check, browser, base: str, service: str) -> None:
    for locale, wanted in (("zh-TW", "zh-Hant-TW"), ("zh-HK", "zh-Hant-TW"), ("en-GB", "en"), ("ja-JP", "en")):
        context = browser.new_context(viewport={"width": 1280, "height": 800}, locale=locale)
        check.watch(context)
        page = context.new_page()
        page.goto(f"{base}/index.html")
        page.wait_for_function("window.pearjs !== undefined && window.pearjs.selfTest() !== null")
        check.equal(f"a browser in {locale} starts in", page.evaluate("document.documentElement.lang"), wanted)
        context.close()

    context = browser.new_context(viewport={"width": 1280, "height": 800}, locale="en-US")
    check.watch(context)
    page = open_page(check, context, base, "?lang=zh-TW")
    check.equal("?lang=zh-TW pins Chinese", page.evaluate("document.documentElement.lang"), "zh-Hant-TW")
    check.ok("the title is Chinese", has_han(page.title()), page.title())
    check.equal("no text is missing at the start (Chinese)", texts_filled(page), [])
    check.ok(
        "the notice says unofficial, experimental, a station in a Worker that drives a simulated arm, and that a real arm is written to only after its Enable and the confirmation",
        all(word in page.locator("#notice").inner_text() for word in ("非官方", "實驗", "工作站在這個頁面的 Worker 裡執行，驅動的是模擬手臂", "連接真實的手臂時，頁面會讀取", "只有在你按下「在這支手臂上啟用工作站」並確認之後，它才會對伺服馬達寫入", "不會有任何模型讓手臂動")),
        page.locator("#notice").inner_text(),
    )
    check.ok(
        "the task says the same in Chinese",
        all(word in page.locator("#task").inner_text() for word in ("下面的工作站驅動的是模擬手臂，在這個頁面的 Worker 裡執行", "連接真實的手臂時，頁面會讀取", "只有在按下「在這支手臂上啟用工作站」並確認之後才會對伺服馬達寫入")),
        page.locator("#task").inner_text()[:200],
    )
    check.ok(
        "the task says in Chinese that it can ask a model once, does not execute the action, and that no model moves an arm",
        all(word in page.locator("#task").inner_text() for word in ("它可以問模型一次並顯示回答", "不會執行模型要求的動作", "不會有任何模型讓手臂動")),
        page.locator("#task").inner_text()[:260],
    )
    jog_lead = page.locator("[data-i18n='station.jogLead']").text_content() or ""
    check.ok(
        "the station's actions are said in Chinese to observe the wrist camera's frame, and not to run without a fresh one",
        "工作站看到的手腕攝影機畫面" in jog_lead and "沒有新的畫面時，動作不會執行" in jog_lead and "沒有相機" not in jog_lead,
        jog_lead,
    )
    check.equal("the Chinese button is the pressed one", page.locator("#language-zh").get_attribute("aria-pressed"), "true")

    # every state the page can be brought to here, in both languages: no name left unfilled, and the Chinese
    # page speaks Chinese in every message
    def both(label: str, containers: list[str]) -> None:
        for language_button, name in (("#language-zh", "Chinese"), ("#language-en", "English")):
            page.click(language_button)
            check.equal(f"{label}: nothing unfilled ({name})", texts_filled(page), [])
            for container in containers:
                for text in page.evaluate(
                    "selector => [...document.querySelectorAll(selector)].map(node => node.innerText)", container
                ):
                    # PEAR's and lerobot's own words stay as they are: a message must hold more than those
                    if name == "Chinese":
                        check.ok(f"{label}: {container} is in Chinese", has_han(text), text[:160])
                    else:
                        check.ok(f"{label}: {container} is in English", not has_han(text), text[:160])
        page.click("#language-zh")

    connect_sim(page)
    both("reading", ["#arm-status", "#arm h3", "#arm .lead", "#joint-table thead", "#servo-table thead", "#calibration-table thead", "#guard-line", "#guard-selftest"])
    check.ok("the joints' names stay PEAR's", "shoulder_pan" in page.locator("#joint-table").inner_text())
    check.ok("the gripper's unit is translated", "開合" in page.locator("#joint-table tr[data-motor=gripper]").inner_text())
    for scenario in ("missing", "error", "factory", "silent", "ids", "baud", "echo"):
        page.select_option("#sim-scenario", scenario)
        if scenario == "silent":
            # while the page looks for the servos at other baud rates it says so
            page.wait_for_function("document.querySelector('#arm-status').dataset.phase === 'probing'")
            both("looking for the servos", ["#arm-status"])
        wait_phase(page, "reading" if scenario in ("error", "factory") else "failed")
        both(f"scenario {scenario}", ["#arm-status", "#arm-messages .box"])
    page.select_option("#sim-scenario", "normal")
    wait_phase(page, "reading")
    set_slider(page, "shoulder_pan", 758)
    page.wait_for_function("document.querySelector('#arm-messages .box[data-kind=warn-bounds]') !== null")
    both("a joint outside its limits", ["#arm-messages .box", "#joint-table tbody tr[data-motor=shoulder_pan] [data-field=mark]"])
    page.click("#sim-cable")
    wait_phase(page, "failed")
    both("a pulled cable", ["#arm-messages .box", "#sim-cable"])
    page.click("#arm-sim")
    wait_phase(page, "reading")
    registers = registers_shown(page)
    load_file(page, calibration_file(registers))
    wait_verdict(page, "cal-equal")
    both("an equal calibration file", ["#calibration-verdict .box"])
    changed = json.loads(calibration_file(registers))
    changed["gripper"]["range_max"] -= 3
    load_file(page, json.dumps(changed).encode())
    wait_verdict(page, "cal-different")
    both("a different calibration file", ["#calibration-verdict .box", "#calibration-table tbody [data-field=same]"])
    load_file(page, b"nothing")
    wait_verdict(page, "cal-invalid")
    both("no calibration file", ["#calibration-verdict .box"])

    # the simulated arm started its test picture when it connected
    page.wait_for_function("document.querySelector('#camera-status').dataset.phase === 'live'")
    check.equal("the camera in use is the test picture", page.locator("#camera-select").input_value(), "test-picture")
    page.click("#camera-capture")
    page.wait_for_function("document.getElementById('camera-info').dataset.bytes !== undefined")
    both("camera", ["#camera-status", "#camera-messages .box", "#camera-info", "#camera .lead", "#camera .hint"])

    cases = {
        "ok": dict(settings={}, url=f"{service}/v1", model="", key=""),
        "blocked": dict(settings={"keys": [KEY]}, url=f"{service}/v1", model=MODEL, key=OTHER_KEY),
        "key": dict(settings={"keys": [KEY], "refusal_has_cors": True}, url=f"{service}/v1", model=MODEL, key=OTHER_KEY),
        "not-served": dict(settings={}, url=f"{service}/v1", model="another", key=""),
        "choose": dict(settings={"models": ["a", "b"]}, url=f"{service}/v1", model="", key=""),
        "not-found": dict(settings={}, url=service, model=MODEL, key=""),
        "not-a-service": dict(settings={"is_other_service": True}, url=f"{service}/v1", model=MODEL, key=""),
        "unreachable": dict(settings={}, url="http://127.0.0.1:9/v1", model=MODEL, key=""),
        "refused": dict(settings={}, url="ftp://127.0.0.1/v1", model=MODEL, key=""),
    }
    for outcome, case in cases.items():
        ModelService.configure(**case["settings"])
        check.equal(f"model {outcome} (for its texts)", run_model_check(page, case["url"], case["model"], case["key"]), outcome)
        both(f"model {outcome}", ["#model-result .box > p:not(.detail), #model-result .box li, #model-result .box h4"])
    ModelService.configure()

    page.click("#timing-run")
    page.wait_for_function("document.getElementById('timing-result').dataset.state === 'running'")
    check.ok("timing: the progress is in Chinese", has_han(page.locator("#timing-result").inner_text()))
    page.click("#language-en")
    check.equal("switching leaves English", page.evaluate("document.documentElement.lang"), "en")
    check.equal("the page's title follows", page.title(), "pear.js: PEAR's robot station in the browser")
    check.equal("the reading went on through the switches", phase(page), "reading")
    context.close()


def part_keyboard(check: Check, context: BrowserContext, base: str) -> None:
    page = open_page(check, context, base)
    unlabelled = page.evaluate(
        """() => [...document.querySelectorAll('input, select, textarea')].filter(control =>
            !document.querySelector(`label[for="${control.id}"]`) && !control.getAttribute('aria-label')).map(control => control.id)"""
    )
    check.equal("every field has a label", unlabelled, [])
    check.equal("every control is a native one", page.evaluate("document.querySelectorAll('[onclick], [role=button], div[tabindex], span[tabindex]').length"), 0)
    visited = []
    for _ in range(40):
        page.keyboard.press("Tab")
        visited.append(page.evaluate("document.activeElement.id || document.activeElement.className || document.activeElement.tagName"))
    wanted = ["language-en", "language-zh", "arm-sim", "calibration-file", "camera-select", "camera-start", "model-url", "model-name", "model-key", "model-check", "log-output", "log-copy", "timing-run"]
    positions = [visited.index(name) if name in visited else -1 for name in wanted]
    check.ok("Tab reaches the controls in the page's order", all(position >= 0 for position in positions) and positions == sorted(positions), dict(zip(wanted, positions)))
    check.equal("the first Tab stop skips to the arm", visited[0], "skip")
    page.focus("#arm-sim")
    outline = page.evaluate("getComputedStyle(document.activeElement).outlineStyle")
    page.keyboard.press("Enter")
    wait_phase(page, "reading")
    check.equal("Enter on the focused button connects", phase(page), "reading")
    page.keyboard.press("Tab")
    focused = page.evaluate("[document.activeElement.id, getComputedStyle(document.activeElement).outlineStyle, getComputedStyle(document.activeElement).outlineWidth]")
    check.ok("a focused control shows a focus ring", focused[1] != "none" and focused[2] != "0px", [outline, focused])
    page.close()


def overflow(page: Page) -> list[str]:
    """Returns what sticks out of the viewport's width: the page itself, or an element outside a scrolling box."""
    return page.evaluate(
        """() => {
            const problems = [];
            const width = document.documentElement.clientWidth;
            if (document.documentElement.scrollWidth > width + 1) problems.push(`page ${document.documentElement.scrollWidth} > ${width}`);
            for (const element of document.querySelectorAll('main *, header *, footer *, .stopbar *, .notice')) {
                if (element.closest('.scroll') && !element.classList.contains('scroll')) continue;
                const box = element.getBoundingClientRect();
                if (box.width === 0 || box.height === 0) continue;
                if (box.right > width + 1 || box.left < -1) problems.push(`${element.tagName.toLowerCase()}#${element.id}.${element.className} ${Math.round(box.left)}..${Math.round(box.right)}`);
            }
            return problems.slice(0, 8);
        }"""
    )


def part_layout(check: Check, browser, base: str, service: str) -> None:
    """Screenshots in both languages, light and dark, on a laptop and on a phone; nothing may stick out."""
    shots = check.out / "screenshots"
    shots.mkdir(exist_ok=True)
    for language in ("en", "zh-TW"):
        for scheme in ("light", "dark"):
            for device, viewport in (("laptop", {"width": 1280, "height": 800}), ("phone", {"width": 390, "height": 844})):
                label = f"{language} {scheme} {device}"
                context = browser.new_context(viewport=viewport, locale="en-US", color_scheme=scheme, device_scale_factor=1)
                check.watch(context)
                page = open_page(check, context, base, f"?lang={language}")
                check.equal(f"{label}: nothing sticks out before a connection", overflow(page), [])
                connect_sim(page)
                page.wait_for_function("document.querySelector('#camera-status').dataset.phase === 'live'")
                page.click("#camera-capture")
                page.wait_for_function("document.getElementById('camera-info').dataset.bytes !== undefined")
                ModelService.configure()
                run_model_check(page, f"{service}/v1", "", KEY)
                registers = registers_shown(page)
                changed = json.loads(calibration_file(registers))
                changed["wrist_flex"]["range_max"] -= 5
                load_file(page, json.dumps(changed).encode())
                wait_verdict(page, "cal-different")
                set_slider(page, "shoulder_pan", 758)
                page.wait_for_function("document.querySelector('#arm-messages .box[data-kind=warn-bounds]') !== null")
                check.equal(f"{label}: nothing sticks out while reading", overflow(page), [])
                colours = page.evaluate("[getComputedStyle(document.body).backgroundColor, getComputedStyle(document.body).color]")
                check.numbers.setdefault("colours", {})[label] = colours
                name = label.replace(" ", "-")
                for section in ("arm", "camera", "model", "task", "log"):
                    page.locator(f"#{section}").screenshot(path=str(shots / f"{name}-{section}.png"))
                page.evaluate("window.scrollTo(0, 0)")
                page.screenshot(path=str(shots / f"{name}-top.png"))
                ModelService.configure(keys=[KEY])
                run_model_check(page, f"{service}/v1", MODEL, OTHER_KEY)
                check.equal(f"{label}: nothing sticks out with a long message", overflow(page), [])
                page.locator("#model").screenshot(path=str(shots / f"{name}-model-blocked.png"))
                page.select_option("#sim-scenario", "silent")
                wait_phase(page, "failed")
                check.equal(f"{label}: nothing sticks out after a failure", overflow(page), [])
                page.evaluate("window.scrollTo(0, 0)")
                page.screenshot(path=str(shots / f"{name}-silent.png"))
                context.close()
    ModelService.configure()
    light, dark = check.numbers["colours"]["en light laptop"], check.numbers["colours"]["en dark laptop"]
    check.ok("light and dark follow the system's setting", light != dark, [light, dark])
    check.numbers["screenshots"] = len(list(shots.glob("*.png")))


def part_folder(check: Check, browser, dist: Path, service: str) -> None:
    """The built folder opened from a file:// URL, without any server."""
    context = browser.new_context(viewport={"width": 1280, "height": 800}, locale="en-US")
    check.watch(context)
    page = context.new_page()
    page.goto(f"{dist.as_uri()}/index.html?lang=en")
    page.wait_for_function("window.pearjs !== undefined && window.pearjs.selfTest() !== null", timeout=10000)
    check.equal("from a folder: the page runs", phase(page), "idle")
    check.ok("from a folder: the style sheet applies", page.evaluate("getComputedStyle(document.getElementById('stopbar')).position") == "fixed")
    check.equal("from a folder: the page's own address", page.evaluate("location.protocol"), "file:")
    connect_sim(page)
    check.equal("from a folder: the simulated arm is read", phase(page), "reading")
    page.wait_for_function("document.querySelector('#camera-status').dataset.phase === 'live'")
    page.click("#camera-capture")
    page.wait_for_function("document.getElementById('camera-info').dataset.bytes !== undefined")
    check.equal("from a folder: a frame is captured", page.locator("#camera-info").get_attribute("data-width"), "640")
    check.numbers["folder"] = {"secure": page.evaluate("isSecureContext"), "serial": page.evaluate("'serial' in navigator")}
    # a page from a folder names itself "null" to a service: one that allows every origin answers it
    ModelService.configure()
    check.equal("from a folder: a service that allows every origin is reached", run_model_check(page, f"{service}/v1", "", ""), "ok")
    origins = [entry["headers"].get("origin") for entry in ModelService.seen if entry["method"] == "GET"]
    check.equal("from a folder: the origin the service is told", origins[-1], "null")
    ModelService.configure(allowed_origins=["http://allowed.invalid"])
    check.equal("from a folder: a service that allows one origin is not", run_model_check(page, f"{service}/v1", MODEL, ""), "blocked")
    text = page.locator("#model-result").inner_text()
    check.ok("from a folder: the page says what its origin is", "opened from a folder" in text and "(null)" in text, text)
    ModelService.configure()
    context.close()


def part_subpath(check: Check, browser, dist: Path) -> None:
    """The built folder served under a path of a host and not at its root, as GitHub Pages serves a project's
    page: every file of the page must be asked for under that path, and the simulated arm must work there."""
    UnderPath.served = []
    server, origin = serve(functools.partial(UnderPath, directory=str(dist)))
    address = f"{origin}{HOSTED_PATH}"
    try:
        context = browser.new_context(viewport={"width": 1280, "height": 800}, locale="en-US")
        check.watch(context)
        page = context.new_page()
        # the folder's address, as a person opens the hosted page
        page.goto(f"{address}/?lang=en")
        page.wait_for_function("window.pearjs !== undefined && window.pearjs.selfTest() !== null", timeout=10000)
        check.equal("under a path: the page runs", phase(page), "idle")
        check.ok("under a path: the style sheet applies", page.evaluate("getComputedStyle(document.getElementById('stopbar')).position") == "fixed")
        files = page.evaluate(
            "[...document.scripts].map(script => script.src).concat([...document.querySelectorAll('link[rel=stylesheet]')].map(link => link.href))"
        )
        check.ok("under a path: the script and the style sheet are asked for under it", len(files) == 2 and all(file.startswith(f"{address}/assets/") for file in files), files)
        check.equal("under a path: the guard's self-test passed", page.evaluate("window.pearjs.selfTest().failures"), [])
        connect_sim(page)
        check.equal("under a path: the simulated arm is read", phase(page), "reading")
        calibration = registers_shown(page)
        compare_with_node(check, page, "under a path", calibration, {motor: joints_shown(page)[motor]["raw"] for motor in MOTORS})
        set_slider(page, "elbow_flex", 1800)
        wait_raw(page, {"elbow_flex": 1800})
        check.equal("under a path: a slider moves a joint", joints_shown(page)["elbow_flex"]["raw"], 1800)
        page.wait_for_function("document.querySelector('#camera-status').dataset.phase === 'live'")
        page.click("#camera-capture")
        page.wait_for_function("document.getElementById('camera-info').dataset.bytes !== undefined")
        check.equal("under a path: a frame is captured", page.locator("#camera-info").get_attribute("data-width"), "640")
        check.ok("under a path: the log begins with the build", log_lines(page)[0].startswith(f"pear.js build {check.arguments.build}, "), log_lines(page)[0])
        page.close()

        # the folder's address without its slash, which GitHub Pages redirects; and the page's file by its name
        page = context.new_page()
        page.goto(address)
        page.wait_for_function("window.pearjs !== undefined && window.pearjs.selfTest() !== null", timeout=10000)
        check.equal("under a path: the address without its slash leads to the page", [page.url, phase(page)], [f"{address}/", "idle"])
        page.goto(f"{address}/index.html?arm=sim&lang=zh-TW")
        page.wait_for_function("window.pearjs !== undefined && window.pearjs.selfTest() !== null", timeout=10000)
        wait_phase(page, "reading")
        check.equal("under a path: index.html by its name, in Chinese, with the simulated arm", [page.evaluate("document.documentElement.lang"), phase(page)], ["zh-Hant-TW", "reading"])
        context.close()

        asked = list(UnderPath.served)
        check.equal("under a path: nothing was asked for outside it", [entry for entry in asked if not entry[0].startswith(f"{HOSTED_PATH}/") and entry != (HOSTED_PATH, 301)], [])
        check.equal("under a path: everything asked for was found", [entry for entry in asked if entry[1] not in (200, 301, 304)], [])
        check.ok("under a path: the page, its script and its style sheet were asked for", len({urlsplit(entry[0]).path for entry in asked}) >= 5, sorted({urlsplit(entry[0]).path for entry in asked}))
        # the stand-in is as strict as the host: a page that asked for its files at the root would not find them
        statuses = []
        for path in ("/index.html", "/assets/", "/"):
            try:
                with urllib.request.urlopen(f"{origin}{path}", timeout=10) as response:
                    statuses.append(response.status)
            except urllib.error.HTTPError as error:
                statuses.append(error.code)
        check.equal("under a path: nothing is served at the host's root", statuses, [404, 404, 404])
    finally:
        server.shutdown()
        server.server_close()


def part_hosted(check: Check, browser, dist: Path, service: str) -> None:
    """The page as it is hosted: on an https origin that is not this machine, under a path. The browser's requests
    for that origin are answered here from the built folder, without a certificate and without a network, and
    the browser has a proxy that does not exist: whatever the page asks for, nothing leaves this machine.

    What is checked is what the page says when its model service is a plain http address: a browser refuses such
    a request from an https page (mixed content), lets an address of a local network written as numbers through
    to its question about the local network, and asks that question for this computer's own address too."""
    address = f"{HOSTED_ORIGIN}{HOSTED_PATH}"
    host = urlsplit(HOSTED_ORIGIN).hostname
    local_service = f"http://127.0.0.1:{urlsplit(service).port}/v1"
    texts = "#model-result .box > p:not(.detail), #model-result .box li, #model-result .box h4"

    def answer(route) -> None:
        path = urlsplit(route.request.url).path
        file = dist / (path[len(HOSTED_PATH) + 1 :] or "index.html") if path.startswith(f"{HOSTED_PATH}/") else None
        if file is not None and file.is_file() and dist in file.resolve().parents:
            route.fulfill(path=str(file))
        else:
            route.fulfill(status=404, content_type="text/plain", body="not found")

    def hosted(permissions: list[str] | None, query: str = "?lang=en") -> tuple[BrowserContext, Page]:
        # no list: the browser has not asked its user yet. A list: the browser was told, and whatever is not in
        # it is refused, as after the user's "Block".
        options = {} if permissions is None else {"permissions": permissions}
        context = browser.new_context(viewport={"width": 1280, "height": 800}, locale="en-US", **options)
        check.watch(context)
        context.route(f"{HOSTED_ORIGIN}/**", answer)
        page = context.new_page()
        page.goto(f"{address}/{query}")
        page.wait_for_function("window.pearjs !== undefined && window.pearjs.selfTest() !== null", timeout=10000)
        return context, page

    def requests_to(name: str) -> list[dict]:
        return [entry for entry in check.requests if urlsplit(entry["url"]).hostname == name]

    check.allowed_hosts.add(host)
    try:
        context, page = hosted(None)
        told = page.evaluate("({ protocol: location.protocol, secure: isSecureContext, serial: 'serial' in navigator, origin: location.origin, path: location.pathname })")
        check.equal("hosted: an https page of another origin, under a path, with Web Serial", told, {"protocol": "https:", "secure": True, "serial": True, "origin": HOSTED_ORIGIN, "path": f"{HOSTED_PATH}/"})
        check.ok("hosted: Connect is enabled", page.locator("#arm-connect").is_enabled())
        check.ok("hosted: the log says how the page was opened", any(line.startswith("Page: https: secure context; Web Serial present") for line in log_lines(page)), log_lines(page)[:4])
        connect_sim(page)
        check.equal("hosted: the simulated arm is read", phase(page), "reading")
        result = page.locator("#model-result")
        ModelService.configure()

        # plain http on another machine: the browser refuses it before it is sent, and the page says so at once
        for label, url in (("an address", "http://192.0.2.10:8000/v1"), ("a name", "http://service.example:8000/v1")):
            started = time.monotonic()
            check.equal(f"hosted: plain http to {label} of another machine", run_model_check(page, url, MODEL, KEY), "mixed")
            check.ok(f"hosted: {label}: said at once, not after a wait", time.monotonic() - started < 3, time.monotonic() - started)
            text = result.inner_text()
            check.equal(f"hosted: {label}: one message, of its own kind", kinds(page, "#model-result"), ["model-mixed"])
            check.ok(f"hosted: {label}: the title says what is in the way", "This page is on https, and the address is plain http" in text, text)
            check.ok(f"hosted: {label}: both ways out are named", "Give the service an https:// address" in text and "on the same machine as the service" in text and "http://127.0.0.1 or http://localhost" in text, text)
            check.ok(f"hosted: {label}: no word of a local network, which this is not", "local network" not in text, text)
            sent = requests_to(urlsplit(url).hostname)
            check.ok(f"hosted: {label}: the browser refused the request as mixed content and sent nothing", len(sent) == 1 and "mixed-content" in sent[0].get("unsent", ""), [entry.get("unsent") for entry in sent])
        log = page.locator("#log-output").input_value()
        check.ok("hosted: the log says why", "/v1/models -> failed (TypeError); mixed (this page is on https, the address is plain http)" in log, log[-500:])
        check.ok("hosted: the log holds neither the address nor the key", all(secret not in log for secret in ("192.0.2.10", "service.example", KEY)), log[-500:])

        # plain http to an address of a local network written as numbers: Chromium lets it through to its question
        check.equal("hosted: plain http to an address of a local network", run_model_check(page, "http://192.168.77.77:8000/v1", MODEL, ""), "mixed")
        text = result.inner_text()
        check.ok("hosted: a local address: said to be one, with what Chrome asks", "This address is on a local network" in text and "Chrome asks whether this page may connect to devices on the local network" in text, text)
        check.ok("hosted: a local address: the ways out are the same", "Give the service an https:// address" in text and "http://127.0.0.1 or http://localhost" in text, text)
        check.numbers["hosted"] = {"what this browser did with plain http to a private address": sorted({entry.get("unsent", "sent") for entry in requests_to("192.168.77.77")})}

        # this computer's own address is no mixed content; the browser asks its user first, and a headless one
        # has nobody to ask
        seen = len(ModelService.seen)
        check.equal("hosted: http to this computer, the browser's question unanswered", run_model_check(page, local_service, MODEL, ""), "unreachable")
        text = result.inner_text()
        check.ok("hosted: this computer: the page says what Chrome asks", "Chrome asks whether this page may connect to devices on the local network" in text and "press Check again" in text, text)
        check.equal("hosted: this computer: the service was not reached", len(ModelService.seen), seen)
        lines = log_lines(page)
        check.ok("hosted: this computer: the permission's state is in the log", re.search(r"; unreachable; permission to reach the local network: .*=prompt", lines[-1]) is not None, lines[-1])
        check.numbers["hosted"]["the permission as this browser names it"] = lines[-1].split("permission to reach the local network: ")[-1]

        # the same in Chinese: every paragraph of the messages
        page.click("#language-zh")
        for label, url, outcome in (("this computer", local_service, "unreachable"), ("another machine", "http://192.0.2.10:8000/v1", "mixed"), ("a local address", "http://192.168.77.77:8000/v1", "mixed")):
            check.equal(f"hosted, Chinese: {label}", run_model_check(page, url, MODEL, ""), outcome)
            check.equal(f"hosted, Chinese: {label}: nothing unfilled", texts_filled(page), [])
            paragraphs = page.evaluate("selector => [...document.querySelectorAll(selector)].map(node => node.innerText)", texts)
            check.ok(f"hosted, Chinese: {label}: every paragraph is in Chinese", len(paragraphs) >= 3 and all(has_han(text) for text in paragraphs), [text[:60] for text in paragraphs])
        check.ok("hosted, Chinese: the title of the message", "本頁使用 https，但服務網址是一般的 http" in result.inner_text(), result.inner_text()[:200])
        context.close()

        # the permission refused, as after the person's answer "Block"
        context, page = hosted([])
        seen = len(ModelService.seen)
        check.equal("hosted: http to this computer, the permission refused", run_model_check(page, local_service, MODEL, ""), "unreachable")
        text = page.locator("#model-result").inner_text()
        check.ok("hosted: refused: the page says that it is blocked and where to change it", "is set to block" in text and "the site's settings" in text and "press Check again" in text, text)
        check.equal("hosted: refused: the service was not reached", len(ModelService.seen), seen)
        check.ok("hosted: refused: the state is in the log", re.search(r"; unreachable; permission to reach the local network: .*=denied", log_lines(page)[-1]) is not None, log_lines(page)[-1])
        page.click("#language-zh")
        paragraphs = page.evaluate("selector => [...document.querySelectorAll(selector)].map(node => node.innerText)", texts)
        check.ok("hosted, Chinese: refused: every paragraph is in Chinese", len(paragraphs) >= 2 and all(has_han(text) for text in paragraphs), [text[:60] for text in paragraphs])
        check.ok("hosted, Chinese: refused: said", "封鎖" in page.locator("#model-result").inner_text(), page.locator("#model-result").inner_text()[:300])
        context.close()

        # with the permission, as after the person's answer "Allow"
        context, page = hosted(["local-network-access"])
        check.equal("hosted: http to this computer once the page may reach the local network", run_model_check(page, local_service, "", ""), "ok")
        check.equal("hosted: the served model is found", page.locator("#model-name").input_value(), MODEL)
        origins = [entry["headers"].get("origin") for entry in ModelService.seen if entry["method"] == "GET"]
        check.equal("hosted: the service is told the page's origin", origins[-1], HOSTED_ORIGIN)
        check.equal("hosted: an https address is no mixed content: one that is not there is unreachable", run_model_check(page, "https://service.example/v1", MODEL, ""), "unreachable")
        check.ok("hosted: with the permission given, the page does not ask for it", "Chrome" not in page.locator("#model-result").inner_text(), page.locator("#model-result").inner_text())
        context.close()
    finally:
        check.allowed_hosts.discard(host)
        ModelService.configure()


def part_insecure(check: Check, playwright, base: str) -> None:
    """The page served over plain http under a name that is not this machine's own: no secure context."""
    port = urlsplit(base).port
    browser = playwright.chromium.launch(
        headless=True, args=["--disable-gpu", "--host-resolver-rules=MAP pearjs.test 127.0.0.1"]
    )
    context = browser.new_context(viewport={"width": 1280, "height": 800}, locale="en-US")
    check.allowed_hosts.add("pearjs.test")
    check.watch(context)
    page = context.new_page()
    page.goto(f"http://pearjs.test:{port}/index.html?lang=en")
    page.wait_for_function("window.pearjs !== undefined && window.pearjs.selfTest() !== null")
    check.equal("plain http: not a secure context", page.evaluate("isSecureContext"), False)
    check.equal("plain http: the page says why there is no Web Serial", kinds(page), ["fail-insecure"])
    check.ok("plain http: Connect is disabled", page.locator("#arm-connect").is_disabled())
    check.equal("plain http: the camera is explained too", kinds(page, "#camera-messages"), ["camera-unavailable"])
    connect_sim(page)
    check.equal("plain http: the simulated arm works", phase(page), "reading")
    page.wait_for_function("document.querySelector('#camera-status').dataset.phase === 'live'")
    check.equal("plain http: the test picture works", page.locator("#camera-select").input_value(), "test-picture")
    page.click("#log-copy")
    page.wait_for_function("document.getElementById('log-copy-result').textContent !== ''")
    check.ok("plain http: copying the log answers", page.locator("#log-copy-result").inner_text() in ("Copied.", "Could not copy. Select the text and copy it yourself."))
    context.close()
    browser.close()
    check.allowed_hosts.discard("pearjs.test")


def part_log(check: Check, browser, base: str) -> None:
    context = browser.new_context(viewport={"width": 1280, "height": 800}, locale="en-US", permissions=["clipboard-read", "clipboard-write"])
    check.watch(context)
    page = open_page(check, context, base)
    connect_sim(page)
    page.click("#log-copy")
    page.wait_for_function("document.getElementById('log-copy-result').textContent !== ''")
    check.equal("copying the log", page.locator("#log-copy-result").inner_text(), "Copied.")
    copied = page.evaluate("navigator.clipboard.readText()")
    check.ok("the clipboard holds the log", "read-only first version" in copied and "Handshake passed" in copied, copied[:200])
    check.ok("the log names the browser and the build", "User agent: Mozilla" in copied and "pear.js build " in copied)
    shown = page.locator("#log-output").input_value()
    check.ok("the clipboard holds the log as the page shows it, from its first line", shown.startswith(copied) and len(copied) > 400, [len(copied), len(shown)])
    context.close()


def part_timing(check: Check, context: BrowserContext, base: str) -> None:
    page = open_page(check, context, base)
    page.click("#timing-run")
    page.wait_for_function("document.getElementById('timing-result').dataset.state === 'needsArm'")
    check.ok("timing without an arm asks for one", "Connect an arm first" in page.locator("#timing-result").inner_text())
    connect_sim(page)
    page.bring_to_front()
    page.click("#timing-run")
    page.wait_for_function("document.getElementById('timing-result').dataset.state === 'done'", timeout=90000)
    report = page.evaluate("window.pearjs.timing")
    check.numbers["timing"] = report
    check.equal("timing: the page was visible", report["visibility"], "visible")
    check.equal("timing: 200 reads", report["reads"]["count"], 200)
    check.equal("timing: 500 periods of each timer", [report["interval"]["count"], report["deadline"]["count"], report["loadedInterval"]["count"]], [500, 500, 500])
    check.ok("timing: a read of the simulated arm takes under 5 ms at the median", report["reads"]["median"] < 5, report["reads"])
    check.ok("timing: a 20 ms timer fires about every 20 ms at the median", 19 <= report["interval"]["median"] <= 21, report["interval"])
    check.ok("timing: the numbers are in the log", "one read of the six positions, 200 in a row" in page.locator("#log-output").input_value())
    check.equal("timing: the reading goes on afterwards", phase(page), "reading")
    received = page.evaluate("window.pearjs.sim().chain.received.map(packet => packet[4])")
    check.ok("timing: pings and reads only", set(received) <= {1, 2, 0x82}, sorted(set(received)))
    page.close()


def part_transport(check: Check) -> None:
    """What the library's transport does around an error of the line and a lost device, in Node, on a port made
    after the Web Serial specification; and the page's own port on the same events."""
    completed = subprocess.run(
        [check.arguments.node, "web/tests/run_node.mjs", "web/tests/transport_probe_entry.ts"],
        cwd=REPOSITORY,
        capture_output=True,
        timeout=180,
        check=False,
    )
    check.ok("the probe ran", completed.returncode == 0, completed.stderr.decode(errors="replace")[-600:])
    if completed.returncode != 0:
        return
    probe = json.loads(completed.stdout.decode())
    check.numbers["transport probe"] = probe
    resilient = probe["resilient"]
    check.equal("the page's port: read before the line error", resilient["before"], "read")
    check.equal("the page's port: read after it", resilient["later"], "read")
    check.equal("the page's port: the error was counted", resilient["lineErrors"], 1)
    check.equal("the page's port: closes", resilient["close"], "closed")
    check.equal("a lost device ends the reading", probe["lost"]["after"], {"error": "SerialException: The device has been lost."})
    # what the library's transport does by itself is recorded, not required: see docs/progress/web.md, Found
    check.numbers["bare transport after a line error"] = probe["bare"]


def part_selftest(check: Check, browser) -> None:
    """The library's own fixtures replayed in the browser by web/selftest.html and, the same cases, in Node: the
    counts must be equal. The page is not part of what `npm run build:web` builds and is not published; this
    part builds it into dist-web/ of the repository (web/vite.selftest.config.ts) and serves it from there."""
    built = subprocess.run(
        [check.arguments.node, "node_modules/vite/bin/vite.js", "build", "--config", "web/vite.selftest.config.ts", "--logLevel", "error"],
        cwd=REPOSITORY, capture_output=True, timeout=180, check=False,
    )
    folder = REPOSITORY / "dist-web"
    if not check.ok("the self-test page was built", built.returncode == 0 and (folder / "selftest.html").is_file(), (built.stdout + built.stderr).decode(errors="replace")[-800:]):
        return
    expected = node_json(check, "web/tests/selftest_expected.ts")

    pages, base = serve(functools.partial(WithFixtures, directory=str(folder)))
    try:
        context = browser.new_context(viewport={"width": 1280, "height": 800}, locale="en-US")
        check.watch(context)
        page = context.new_page()
        # without ?fixtures= the page asks for the fixtures beside itself, under fixtures/
        page.goto(f"{base}/selftest.html")
        page.wait_for_function("() => window.selftestResult !== undefined", timeout=120000)
        result = page.evaluate("async () => await window.selftestResult")

        check.equal("the self-test ran without an error of its own", result.get("errors"), [])
        check.equal("the browser ran the suites Node ran", [suite["name"] for suite in result.get("suites", [])], [suite["name"] for suite in expected])
        for node_suite in expected:
            name = node_suite["name"]
            browser_suite = next((suite for suite in result.get("suites", []) if suite["name"] == name), None)
            if browser_suite is None:
                continue
            check.equal(f"{name}: cases", browser_suite["total"], node_suite["total"])
            check.equal(f"{name}: passed, as in Node", browser_suite["passed"], node_suite["passed"])
            check.equal(f"{name}: failed, as in Node", browser_suite["failed"], node_suite["failed"])
            check.equal(f"{name}: none failed", browser_suite["failed"], 0)
        check.ok("the suites hold cases", sum(suite["total"] for suite in expected) >= 900, [suite["total"] for suite in expected])
        check.equal("the page shows the total", page.locator("#selftest-status").inner_text(), f"All passed: {result.get('totalPassed')} of {result.get('totalCases')}")
        check.numbers["selftest"] = {suite["name"]: suite["total"] for suite in expected}
        shots = check.out / "screenshots"
        shots.mkdir(exist_ok=True)
        page.screenshot(path=str(shots / "selftest.png"))
        context.close()
    finally:
        pages.shutdown()
        pages.server_close()


# Keeps the Blob behind every URL the page makes of one. The Worker's text is a Blob of the page's one script, and
# the Worker revokes its own URL as it starts, so the page cannot fetch that URL afterwards: the text the Worker
# was started from is read from the Blob kept here, found by the Worker's URL.
BLOB_TEXTS = """(() => {
    const made = new Map();
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = object => { const url = create(object); made.set(url, object); return url; };
    window.blobOf = url => made.get(url) ?? null;
})();"""

# The entry points of Web Serial. The Worker's text names getPorts, by which its hand-over check finds the port the
# page was granted, and never requestPort: asking a person for a port stays the window's.
WEB_SERIAL_NAMES = ("navigator.serial", "requestPort", "getPorts")

# The numbers of the Worker's clock (realTimeClock().stats()), as the status and the panel's line carry them.
CLOCK_NUMBERS = ("sleeps", "timers", "yields", "spinMs", "lateMeanMs", "lateMaxMs", "timerLateMaxMs", "marginMs")


def is_number(value: object) -> bool:
    """Whether ``value`` is a finite number (and not a truth value)."""
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value and abs(value) != float("inf")


def as_number(text: object) -> float | None:
    """Returns the number that ``text`` writes, or None when it writes none."""
    try:
        return float(text) if isinstance(text, str) and text.strip() != "" else None
    except ValueError:
        return None


def json_or_none(text: str | None) -> object:
    """Returns what ``text`` writes as JSON, or None when it is empty or is no JSON."""
    try:
        return json.loads(text) if text else None
    except ValueError:
        return None


def clock_entries(page: Page, at: str) -> list:
    """Returns the entries of the Worker's clock that the page's log holds for ``at`` ("stop", "disable" or
    "hidden"), each read back as JSON; an entry that does not parse is returned as None."""
    entries = []
    for line in log_lines(page):
        if line.startswith("Station: clock "):
            try:
                entry = json.loads(line.removeprefix("Station: clock "))
            except ValueError:
                entry = None
            if not isinstance(entry, dict) or entry.get("at") == at:
                entries.append(entry if isinstance(entry, dict) else None)
    return entries


def camera_plausible(camera: object) -> bool:
    """Whether the camera's numbers of a clock entry are numbers and plausible: counts that are not negative, a
    longest time between two frames only once two came, times over 200 ms only with a longest one over 200 ms, and
    a time for making a frame exactly when the window made one."""
    if not isinstance(camera, dict):
        return False
    if not all(is_number(camera.get(name)) and camera[name] >= 0 for name in ("frames", "gapsOver200", "made", "leftOut")):
        return False
    gap, mean, longest = camera.get("maxGapMs"), camera.get("makeMeanMs"), camera.get("makeMaxMs")
    if gap is None:
        gaps_fit = camera["gapsOver200"] == 0
    else:
        gaps_fit = is_number(gap) and gap > 0 and camera["frames"] >= 2 and (camera["gapsOver200"] == 0 or gap > 200)
    if camera["made"] == 0:
        return gaps_fit and mean is None and longest is None
    return gaps_fit and is_number(mean) and is_number(longest) and 0 < mean <= longest


def camera_kept_fresh(camera: object) -> bool:
    """Whether, by the camera's numbers of a clock entry, the frames came closer together than PEAR's 0.2 s the
    whole time: frames arrived, the longest time between two is under 200 ms, none was over, and the window timed
    the frames it made."""
    return (
        camera_plausible(camera)
        and camera["frames"] >= 2
        and camera["made"] >= 2
        and camera["maxGapMs"] is not None
        and camera["maxGapMs"] < 200
        and camera["gapsOver200"] == 0
    )


def camera_rate(page: Page, low: int, high: int, timeout_ms: int = 4000) -> dict:
    """Returns the camera's numbers of the station's status once ``low`` to ``high`` frames arrived in the last
    second, or the last ones read when the time is over."""
    deadline = time.monotonic() + timeout_ms / 1000
    while True:
        seen = (station_view(page).get("status") or {}).get("camera") or {}
        if low <= (seen.get("perSecond") or 0) <= high or time.monotonic() > deadline:
            return seen
        page.wait_for_timeout(100)


def clock_plausible(entry: object) -> bool:
    """Whether a clock entry of the log has plausible counts: the clock has slept, the periods since enabling are
    one fewer than the steps (2 at most), those over 40 ms are among those over 25 ms, the timing self-check
    is the one of 150 periods, with its numbers, and the camera's numbers are plausible."""
    if not isinstance(entry, dict):
        return False
    clock, periods, timing, steps = entry.get("clock"), entry.get("periods"), entry.get("timing"), entry.get("steps")
    if not (isinstance(clock, dict) and isinstance(periods, dict) and isinstance(timing, dict) and is_number(steps)):
        return False
    if not all(is_number(clock.get(name)) for name in ("sleeps", "timers", "yields")):
        return False
    if not all(is_number(periods.get(name)) for name in ("count", "meanMs", "maxMs", "over25", "over40")):
        return False
    if not all(is_number(timing.get(name)) for name in ("periods", "meanMs", "maxMs", "over25", "maxReadMs")):
        return False
    return (
        clock["sleeps"] > 0
        and periods["count"] > 0
        and 0 <= steps - periods["count"] <= 2
        and 0 <= periods["over40"] <= periods["over25"] <= periods["count"]
        and timing["periods"] == 150
        and camera_plausible(entry.get("camera"))
    )


def station_view(page: Page) -> dict:
    """Returns what the page holds of the station: its phase, the Worker's last status, and what is under way."""
    return page.evaluate(
        """(() => {
            const view = window.pearjs.station();
            return { phase: view.phase, status: view.status, lost: view.lost, problem: view.problem, timing: view.timing,
                     action: view.action, outcome: view.outcome, plan: view.plan, report: view.report };
        })()"""
    )


def station_frame(page: Page) -> "dict | None":
    """Returns the frame the last action's observation held, as the page holds and shows it: its first and last
    bytes, its size, its number among the frames the station's camera has seen, its age at the observation, and
    the size the page decoded it to; None when the page holds none."""
    return page.evaluate(
        """async () => {
            const frame = window.pearjs.station().frame;
            if (frame === null) return null;
            const image = document.getElementById('station-frame-image');
            for (let turn = 0; turn < 40 && !(image.src === frame.url && image.complete && image.naturalWidth > 0); turn++) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            const bytes = frame.bytes;
            return { first: [bytes[0], bytes[1]], last: [bytes[bytes.length - 2], bytes[bytes.length - 1]], bytes: bytes.length,
                     number: frame.number, ageMs: frame.ageMs, width: image.naturalWidth, height: image.naturalHeight,
                     isShown: image.src === frame.url && !document.getElementById('station-frame').hidden,
                     caption: document.getElementById('station-frame-caption').textContent };
        }"""
    )


def wait_station(page: Page, condition: str, timeout_ms: int = 20000) -> None:
    """Waits until ``condition``, an expression of JavaScript about ``view`` (the page's station), holds."""
    page.wait_for_function(f"(() => {{ const view = window.pearjs.station(); return {condition}; }})()", timeout=timeout_ms)


def station_enabled(check: Check, page: Page, label: str) -> dict:
    """Connects the simulated arm, moves one of its joints, enables the station and checks what the Worker
    tells: the robot at rest in a hold, at the pose the window's arm had, its loop keeping its 20 ms."""
    check.equal(f"{label}: without an arm the page says why Enable is disabled", [page.locator("#station-enable").is_disabled(), page.locator("#station-why").get_attribute("data-why")], [True, "station.why.noArm"])
    check.ok(f"{label}: Stop is disabled while the station holds no arm", page.locator("#task-stop").is_disabled())
    check.equal(f"{label}: no Worker runs before Enable", len(page.workers), 0)
    connect_sim(page)
    set_slider(page, "wrist_roll", 1100)
    wait_raw(page, {"wrist_roll": 1100})
    page.wait_for_function("!document.getElementById('station-enable').disabled")
    check.equal(f"{label}: with the simulated arm read, Enable is offered", page.locator("#station-why").get_attribute("data-why"), "station.why.ready")
    turn_before = page.locator("#turn-text").text_content()
    joints_before = page.evaluate("window.pearjs.arm.view.live.joints")
    page.click("#station-enable")
    try:
        wait_station(page, "view.phase === 'on' && view.status !== null && view.status.robot === 'READY'")
    except Exception as error:  # a failed Enable is otherwise only a timeout: say what the page says of it
        seen = station_view(page)
        said = json.dumps({name: seen[name] for name in ("phase", "problem", "lost", "timing")})
        raise RuntimeError(f"{label}: Enable did not reach READY; the page says {said[:700]}") from error
    view = station_view(page)
    status = view["status"]
    check.equal(f"{label}: the robot is READY in a settled HOLD, without a fault", [status["robot"], status["control"], status["isSettled"], status["fault"]], ["READY", "HOLD", True, None])
    check.equal(f"{label}: the status line shows it", [page.locator("#station-status").get_attribute("data-phase"), page.locator("#station-status").get_attribute("data-robot")], ["on", "READY"])
    check.ok(f"{label}: six joints and six targets are told", len(status["joints"]) == 6 and len(status["targets"]) == 6, status)
    check.equal(f"{label}: the station starts where the window's arm stood: the same turn's text", status["turnText"], turn_before)
    check.equal(f"{label}: the page shows the turn's text of the Worker", page.locator("#station-turn").text_content(), status["turnText"])
    check.equal(f"{label}: the window's reading of the arm has ended", phase(page), "idle")
    workers = [worker.url for worker in page.workers]
    check.ok(f"{label}: one Worker runs, started from a Blob URL", len(workers) == 1 and workers[0].startswith("blob:"), workers)
    check.ok(f"{label}: Stop is enabled while the station holds the arm", not page.locator("#task-stop").is_disabled())
    check.ok(f"{label}: Disable is offered with its sentence about the torque", page.locator("#station-disable").is_visible() and "torque" in page.locator("#station-disable-note").inner_text())
    check.ok(f"{label}: Enable is no longer offered", not page.locator("#station-enable").is_visible())

    # step 1 while the station drives: what the Worker tells of the arm, not "Not connected"
    arm_status = page.locator("#arm-status")
    check.equal(f"{label}: step 1 says that the station drives the simulated arm", [arm_status.get_attribute("data-driven"), "The station drives the simulated arm" in arm_status.inner_text()], ["true", True])
    check.ok(f"{label}: the Worker's joints are the ones the window read, in the same units", len(status["joints"]) == 6 and all(abs(told - read) < 0.002 for told, read in zip(status["joints"], joints_before)), [status["joints"], joints_before])
    shown_joints = page.evaluate("[...document.querySelectorAll('#joint-table tbody tr [data-field=value]')].map(cell => Number(cell.dataset.value))")
    check.ok(f"{label}: step 1 shows the six joints of the Worker's status and says what it leaves out", page.locator("#arm-joints").is_visible() and len(shown_joints) == 6 and page.locator("#arm-driven-note").is_visible() and page.locator("#joint-table [data-field=raw]").count() == 0, shown_joints)
    shown_state = page.evaluate("Object.fromEntries([...document.querySelectorAll('#model-state [data-quantity]')].map(node => [node.dataset.quantity, Number(node.dataset.value)]))")
    told_state = station_view(page)["status"]["state"]
    check.equal(f"{label}: the model's state that step 1 shows is the Worker's", shown_state, {**{name: told_state["arm"][name] for name in ("x", "y", "z", "pitch", "roll")}, "width": told_state["gripper"]["width"]})
    check.ok(f"{label}: the simulated arm's sliders, its fault and its cable are disabled while the station drives", page.evaluate("[...document.querySelectorAll('#sim-sliders input'), document.getElementById('sim-scenario'), document.getElementById('sim-cable')].every(control => control.disabled)") and page.locator("#sim-driven").is_visible())
    check.equal(f"{label}: while the station drives no arm can be connected beside it: Connect and Try without an arm are disabled", [page.locator("#arm-connect").is_disabled(), page.locator("#arm-sim").is_disabled()], [True, True])
    page.click("#arm-sim", force=True, timeout=2000)
    page.wait_for_timeout(200)
    check.equal(f"{label}: a click on the disabled Try without an arm connects nothing", [phase(page), station_view(page)["phase"]], ["idle", "on"])
    check.ok(f"{label}: step 1 says how to connect an arm: disable the station first", "disable the station first" in arm_status.inner_text(), arm_status.inner_text())

    timing = view["timing"]
    check.equal(f"{label}: the timing self-check ran 150 periods before enabling and passed", [timing["periods"], timing["failures"]], [150, []])
    check.ok(f"{label}: its numbers are within the limits", 19.5 <= timing["meanMs"] <= 20.5 and timing["maxMs"] <= 40 and timing["over25"] <= 3 and timing["maxReadMs"] <= 15, timing)
    check.equal(f"{label}: the page shows the self-check as passed", page.locator("#station-timing").get_attribute("data-verdict"), "passed")
    check.ok(f"{label}: and the log holds its numbers", any(line.startswith('Station: timing self-check {"periods":150,') for line in log_lines(page)))
    check.numbers.setdefault("station", {})[f"{label}: timing self-check"] = timing

    # the status events and the loop's periods over a second and a half
    first = station_view(page)["status"]["steps"]  # read now: the checks above took time, and the loop ran on
    began = time.monotonic()
    page.wait_for_timeout(1500)
    elapsed = time.monotonic() - began
    status = station_view(page)["status"]
    periods = status["periods"]
    rate = (status["steps"] - first) / elapsed
    check.ok(f"{label}: the loop steps about 50 times a second", 44 <= rate <= 56, rate)
    check.ok(f"{label}: about 50 periods in the last second", 44 <= periods["count"] <= 52, periods)
    check.ok(f"{label}: the periods' mean is 20 ms", 19.5 <= periods["meanMs"] <= 20.5, periods)
    check.ok(f"{label}: no period over 40 ms", periods["maxMs"] <= 40, periods)
    check.equal(f"{label}: the page shows the periods", page.locator("#station-periods").get_attribute("data-count"), str(periods["count"]))
    check.numbers.setdefault("station", {})[label] = {"periods": periods, "steps a second": round(rate, 2)}

    # the wrist camera as the station sees it: the window sends it the frames of the simulated arm's camera (the
    # test picture), and the loop above kept its period with them flowing
    seen = status.get("camera") or {}
    check.ok(f"{label}: the status says that the camera's frames arrive: at least five in the last second, the last one younger than 0.2 s", seen.get("isRunning") is True and (seen.get("perSecond") or 0) >= 5 and seen.get("ageMs") is not None and 0 <= seen["ageMs"] < 200, seen)
    check.ok(f"{label}: no frame is in a status: its camera holds six numbers", sorted(seen) == ["ageMs", "frames", "gapsOver200", "isRunning", "maxGapMs", "perSecond"] and len(json.dumps(status)) < 4000, [sorted(seen), len(json.dumps(status))])
    seen = camera_rate(page, 15, 22)
    check.ok(f"{label}: the window sends a frame every 50 ms: 15 to 22 arrived in the last second", 15 <= (seen.get("perSecond") or 0) <= 22, seen)
    line = page.locator("#station-camera")
    told = [line.inner_text(), line.get_attribute("data-max-gap-ms"), line.get_attribute("data-gaps-over200")]
    check.ok(f"{label}: the camera's line tells the longest time between two frames, under 200 ms, and that none was over", "the longest time between two frames was" in told[0] and told[0].endswith(": 0.") and 0 < float(told[1] or 0) < 200 and told[2] == "0", told)
    check.numbers["station"][f"{label}: the camera"] = seen

    # the Worker's clock, for a measurement: in the status, and as one line of the station's panel
    told_clock = status.get("clock") or {}
    check.ok(f"{label}: the Worker's status carries the clock's eight numbers, each a number, and the clock has slept", sorted(told_clock) == sorted(CLOCK_NUMBERS) and all(is_number(told_clock[name]) for name in CLOCK_NUMBERS) and told_clock["sleeps"] > 0, told_clock)
    clock_line = page.locator("#station-clock")
    shown_clock = page.evaluate("Object.assign({}, document.getElementById('station-clock').dataset)")
    check.ok(f"{label}: the station's panel shows the clock as one line, each of its eight numbers a number", clock_line.is_visible() and "\n" not in clock_line.inner_text().strip() and "The Worker's clock since enabling" in clock_line.inner_text() and sorted(shown_clock) == sorted(CLOCK_NUMBERS) and all(is_number(as_number(shown_clock[name])) for name in CLOCK_NUMBERS), [clock_line.inner_text(), shown_clock])
    check.numbers["station"][f"{label}: the clock"] = {"clock": told_clock, "since enabling": status.get("since"), "steps": status["steps"]}
    return status


def station_disabled(check: Check, page: Page, label: str, turn_text: str) -> None:
    """Disables the station and checks that the window reads the simulated arm again, where the station left it."""
    page.click("#station-disable")
    wait_station(page, "view.phase === 'off'")
    wait_phase(page, "reading")
    check.equal(f"{label}: after Disable the window reads the simulated arm again", phase(page), "reading")
    page.wait_for_function("document.getElementById('turn-text').textContent !== ''")
    # the state the model reads is the first line of a turn's text; the station's text may end with a report
    check.equal(f"{label}: where the station left it: the same state", page.locator("#turn-text").text_content().split("\n")[0], turn_text.split("\n")[0])
    check.ok(f"{label}: Stop is disabled again", page.locator("#task-stop").is_disabled())
    check.equal(f"{label}: step 1 reads the arm itself again: not driven, the servos' steps shown", [page.locator("#arm-status").get_attribute("data-driven"), page.locator("#joint-table [data-field=raw]").count(), page.locator("#arm-driven-note").is_visible()], ["false", 6, False])
    check.ok(f"{label}: the simulated arm's sliders, its fault and its cable can be used again", page.evaluate("[...document.querySelectorAll('#sim-sliders input'), document.getElementById('sim-scenario'), document.getElementById('sim-cable')].every(control => !control.disabled)") and not page.locator("#sim-driven").is_visible())
    check.equal(f"{label}: after Disable an arm can be connected again: Try without an arm, and Connect where the browser has Web Serial", [page.locator("#arm-sim").is_disabled(), page.locator("#arm-connect").is_disabled()], [False, page.evaluate("navigator.serial == null")])
    check.ok(f"{label}: Enable is offered again", page.locator("#station-enable").is_visible() and not page.locator("#station-enable").is_disabled())
    entries = clock_entries(page, "disable")
    check.ok(f"{label}: at Disable the log holds the clock's entry: one line of JSON with plausible counts", len(entries) == 1 and clock_plausible(entries[0]), entries)
    cameras = [entry.get("camera") if isinstance(entry, dict) else None for entry in entries]
    check.ok(f"{label}: over the station's time the camera's frames were never 0.2 s apart: the entry's longest time between two is under 200 ms and none was over", len(cameras) == 1 and camera_kept_fresh(cameras[0]), cameras)
    check.numbers.setdefault("station", {})[f"{label}: the camera at Disable"] = cameras
    lines = log_lines(page)
    check.ok(f"{label}: the log tells of enabling and disabling", any(line.startswith("Station: enabled; the robot opened in ") for line in lines) and any(line.startswith("Station: disabled; the simulated arm stands at ") for line in lines), lines[-6:])
    guard = page.locator("#guard-line")
    check.equal(f"{label}: the guard refused nothing", guard.get_attribute("data-refused"), "0")
    check.equal(f"{label}: the guard's self-test still reads as passed", page.evaluate("window.pearjs.selfTest().failures"), [])


def delta_action(**arm: float) -> str:
    """Returns, as JavaScript, an action of the model's format that moves the arm's tip by ``arm`` (cm, rad)."""
    return json.dumps({"type": "single_arm_delta", "arm": {"x": 0, "y": 0, "z": 0, "pitch": 0, "roll": 0, **arm}, "gripper": {"width": 0}})


def station_actions(check: Check, page: Page) -> dict:
    """On the enabled station: one action by its button, an action out of reach, Stop during a move, and Home
    with its plan refused and approved. Returns the Worker's status at the end."""
    before = station_view(page)["status"]
    shown_z = "Number(document.querySelector('#model-state [data-quantity=z]').dataset.value)"
    z_before = page.evaluate(shown_z)

    # one action of the model's format by its button: 1 cm up
    page.click("#station-jog button[data-jog='z-plus']")
    wait_station(page, "view.action === null && view.report !== null", 30000)
    report = station_view(page)["report"]
    check.equal("action: the button z +1 cm is one action that completed", report["record"]["status"], "completed")
    wait_station(page, "view.status.robot === 'READY' && view.status.isSettled === true")
    page.wait_for_timeout(250)
    check.ok("action: after z +1 cm the z that step 1 shows is 1 cm higher", abs(page.evaluate(shown_z) - z_before - 1) < 0.15, [z_before, page.evaluate(shown_z)])
    check.equal("action: the page shows the report as the model would read it", page.locator("#station-feedback").text_content(), report["feedback"])
    check.ok("action: the report ends as every report of the format does", report["feedback"].endswith(" Use the new measured observation."), report["feedback"])
    told = json.loads(report["feedback"].removesuffix(" Use the new measured observation."))
    check.equal("action: the report is the format's: completed, requested, settled, reached", [told.get(key) for key in ("status", "execution_requested", "settled", "reached")], ["completed", True, True, True])
    check.ok("action: the next turn's text carries the report", report["turnText"].endswith(f"Previous execution: {report['feedback']}"), report["turnText"])
    wait_station(page, "view.status.robot === 'READY'")
    after = station_view(page)["status"]
    check.close("action: the arm's tip is 1 cm higher", after["state"]["arm"]["z"] - before["state"]["arm"]["z"], 1.0, 0.15)
    check.ok("action: the turn's text the page shows ends with the report", page.locator("#station-turn").text_content().endswith(report["feedback"]), page.locator("#station-turn").text_content())
    lines = log_lines(page)
    check.ok("action: the log holds the action, its phases and its result", any(line.startswith('Station: action {"type":"single_arm_delta"') for line in lines) and "Station: phase Planning" in lines and "Station: phase Executing" in lines and f"Station: result {report['feedback']}" in lines, lines[-8:])
    check.equal("action: the action's line names the button and the status", [page.locator("#station-action").get_attribute("data-status"), "z +1 cm" in page.locator("#station-action").inner_text()], ["completed", True])

    # out of reach: the whole action is rejected with the format's own text, and nothing moves
    page.evaluate(f"window.pearjs.jog({delta_action(x=60)})")
    report = station_view(page)["report"]
    check.equal("out of reach: the action is rejected", report["record"]["status"], "rejected")
    check.ok("out of reach: the report is the format's own text", '"code": "out_of_reach"' in report["feedback"] and "Nothing moved: the whole action was discarded (arm and gripper)." in report["feedback"], report["feedback"])
    wait_station(page, "view.status.robot === 'READY'")
    check.equal("out of reach: nothing moved", station_view(page)["status"]["state"], after["state"])

    # Stop while a move is under way: the action ends as not completed, and the arm holds where it braked
    page.evaluate(f"void window.pearjs.jog({delta_action(z=-6)})")
    wait_station(page, "view.status.control !== 'HOLD'", 10000)
    check.ok("stop: while an action is under way no other is offered", page.evaluate("[...document.querySelectorAll('#station-jog button')].every(button => button.disabled)") and page.locator("#station-home").is_disabled())
    page.click("#task-stop")
    wait_station(page, "view.action === null", 15000)
    report = station_view(page)["report"]
    check.ok("stop: Stop during a move ends the action, and not as completed", report["record"]["status"] in ("failed", "stopped", "cancelled"), report["record"])
    # PEAR's result is what the model would read and stays as it is; the page's own line says who stopped it
    stopped_line = page.locator("#station-action").inner_text()
    check.equal("stop: PEAR's result stays what it is, and the page's own line and the report panel say that the person stopped it", [report["record"]["status"], (report["record"].get("error") or {}).get("message"), page.locator("#station-feedback").text_content() == report["feedback"], "you pressed Stop while it ran" in stopped_line, "you pressed Stop while it ran" in page.locator("#station-report-line").inner_text()], ["failed", "Action cancelled by stop or another operation", True, True, True])
    page.click("#language-zh")
    check.ok("stop: the page's own line is in Chinese when the page is Chinese", "你在它執行時按了停止" in page.locator("#station-action").inner_text(), page.locator("#station-action").inner_text())
    page.click("#language-en")
    check.numbers.setdefault("station", {})["a stopped action"] = {"status": report["record"]["status"], "error": report["record"].get("error"), "feedback": report["feedback"]}
    wait_station(page, "view.status.robot === 'READY'")
    held = station_view(page)["status"]
    lowered = after["state"]["arm"]["z"] - held["state"]["arm"]["z"]
    check.ok("stop: the arm braked on the way, short of the 6 cm", -0.2 <= lowered < 5.5, lowered)
    check.equal("stop: the station still holds the arm", [station_view(page)["phase"], held["control"]], ["on", "HOLD"])
    page.wait_for_timeout(600)
    check.equal("stop: the arm holds: half a second later it is where it was", station_view(page)["status"]["state"], held["state"])

    # Home: PEAR's plan is shown and waits; refused, nothing moves; approved, the arm goes Home
    page.click("#station-home")
    wait_station(page, "view.plan !== null", 15000)
    check.ok("home: PEAR's plan is shown and waits for an answer", page.locator("#station-plan").is_visible() and "operation_seconds_estimate" in page.locator("#station-plan-text").text_content(), page.locator("#station-plan-text").text_content())
    page.click("#station-refuse")
    wait_station(page, "view.action === null", 15000)
    view = station_view(page)
    check.equal("home: a refused plan ends Home as not run", view["outcome"]["key"], "station.action.failed")
    not_run = page.locator("#station-report-line").inner_text()
    check.ok("home: a Home the robot did not run is told in the report panel, in the robot's words, and no earlier report is shown there", page.locator("#station-report").is_visible() and "did not run" in not_run and str(view["outcome"]["values"].get("error")) in not_run and not page.locator("#station-report-model").is_visible() and not page.locator("#station-home-result").is_visible(), not_run)
    check.numbers["station"]["a refused Home"] = view["outcome"]["values"]
    wait_station(page, "view.status.robot === 'READY'")
    check.equal("home: and nothing moved", station_view(page)["status"]["state"], held["state"])
    page.click("#station-home")
    wait_station(page, "view.plan !== null", 15000)
    page.click("#station-approve")
    wait_station(page, "view.action === null", 90000)
    view = station_view(page)
    check.equal("home: an approved plan is run to its end", view["outcome"]["key"], "station.action.homed")
    check.ok("home: the page names the stages", "Home is done" in page.locator("#station-action").inner_text(), page.locator("#station-action").inner_text())
    home_shown = json_or_none(page.locator("#station-home-results").text_content())
    home_logged = json_or_none(next((line.removeprefix("Station: Home done: ") for line in reversed(log_lines(page)) if line.startswith("Station: Home done: ")), ""))
    check.ok("home: the report panel shows Home's stages and PEAR's result for each joint, and no earlier report", page.locator("#station-report").is_visible() and page.locator("#station-home-result").is_visible() and not page.locator("#station-report-model").is_visible() and "Home is done" in page.locator("#station-report-line").inner_text() and isinstance(home_logged, dict) and len(home_logged) > 0 and home_shown == {"stages": view["outcome"]["values"]["stages"].split(", "), "results": home_logged}, home_shown)
    wait_station(page, "view.status.robot === 'READY'")
    homed = station_view(page)["status"]
    check.ok("home: the arm moved", homed["state"] != held["state"], homed["state"])
    check.numbers["station"]["Home"] = {"stages": view["outcome"]["values"], "state": homed["state"], "periods": homed["periods"]}
    check.ok("home: the loop kept its periods through the actions", homed["periods"]["maxMs"] <= 40 and 44 <= homed["periods"]["count"] <= 52, homed["periods"])
    lines = log_lines(page)
    check.ok("home: the log holds the plan, the answers and the end", any(line.startswith("Station: Home plan {") for line in lines) and "Station: Home plan refused" in lines and "Station: Home plan approved" in lines and any(line.startswith("Station: Home done: ") for line in lines), lines[-6:])
    return homed


# The twelve buttons, in the order the check clicks them (each pair ends where it began): the button's id, the
# part and the quantity of the model's state that it names, its amount with its sign (cm, rad), and the tolerance.
# A wrong sign or another quantity cannot meet the tolerance; the state is told to 0.1 cm and 0.01 rad.
# The gripper's command is a direction, not an amount: PEAR closes it wholly on `width` -1 and opens it wholly on
# +1, and tells the outcome ("closed", "open") in its record and in the report. The simulated arm stands open
# after Home, at 6 cm, and closed at 0 cm: so the check closes before it opens. The last entry is that outcome.
JOG_BUTTONS = (
    ("x-plus", "arm", "x", 1.0, 0.15, None),
    ("x-minus", "arm", "x", -1.0, 0.15, None),
    ("y-plus", "arm", "y", 1.0, 0.15, None),
    ("y-minus", "arm", "y", -1.0, 0.15, None),
    ("z-minus", "arm", "z", -1.0, 0.15, None),
    ("z-plus", "arm", "z", 1.0, 0.15, None),
    ("pitch-plus", "arm", "pitch", 0.05, 0.02, None),
    ("pitch-minus", "arm", "pitch", -0.05, 0.02, None),
    ("roll-plus", "arm", "roll", 0.05, 0.02, None),
    ("roll-minus", "arm", "roll", -0.05, 0.02, None),
    ("gripper-close", "gripper", "width", -6.0, 0.15, "closed"),
    ("gripper-open", "gripper", "width", 6.0, 0.15, "open"),
)


def settled_status(page: Page) -> dict:
    """Returns a status the Worker told after this call began (ten control steps newer than the one the page
    holds now), with the robot at rest."""
    steps = station_view(page)["status"]["steps"]
    wait_station(page, f"view.status.steps >= {steps + 10} && view.status.robot === 'READY' && view.status.isSettled === true")
    return station_view(page)["status"]


CAMERA_STOPPED = "Camera unavailable: {'wrist': 'Camera reader stopped; reconnect the camera'}"


def station_camera(check: Check, page: Page) -> dict:
    """On the enabled station: with the camera of step 2 stopped an action is not run, the page shows PEAR's
    error as it is and says what to do, in both languages; with the camera started again an action completes.
    Returns the Worker's status at the end."""
    button = f"#station-jog button[data-jog='{JOG_BUTTONS[0][0]}']"
    line = page.locator("#station-camera")
    check.equal("camera: while frames arrive the panel says so", line.get_attribute("data-state"), "station.camera.arriving")
    page.click("#camera-stop")
    wait_station(page, "view.status.camera.isRunning === false && view.status.camera.perSecond === 0", 8000)
    page.wait_for_function("document.getElementById('station-camera').dataset.state === 'station.camera.stopped'")
    english = line.inner_text()
    page.click("#language-zh")
    page.wait_for_timeout(300)
    chinese = line.inner_text()
    page.click("#language-en")
    check.ok("camera: with the camera of step 2 stopped the station is told, and its panel says that no frames arrive and what to do, in English and in Chinese", "no frames arrive" in english and "start the camera in step 2" in english and "test picture" in english and "沒有畫面送達" in chinese and "請在步驟 2 啟動攝影機" in chinese and "測試畫面" in chinese, [english, chinese])
    page.click(button)
    wait_station(page, "view.action === null && view.outcome !== null", 30000)
    failed = (station_view(page)["report"] or {}).get("record") or {}
    check.equal("camera: an action after the stop is not run: PEAR's result is failed, with PEAR's error and the reader's reason", [failed.get("status"), (failed.get("error") or {}).get("message")], ["failed", CAMERA_STOPPED])
    check.ok("camera: the page shows PEAR's error byte for byte, in the report the model would read, and no frame of an observation", CAMERA_STOPPED in page.locator("#station-feedback").inner_text() and station_frame(page) is None and page.locator("#station-frame").is_hidden(), page.locator("#station-feedback").inner_text()[:300])
    # with PEAR's result and report, the page's own sentence at the report: what happened and what to do
    advice = page.locator("#station-report-camera")
    advice_english = advice.inner_text() if advice.is_visible() else ""
    page.click("#language-zh")
    page.wait_for_timeout(300)
    advice_chinese = advice.inner_text() if advice.is_visible() else ""
    page.click("#language-en")
    page.wait_for_timeout(300)
    check.ok("camera: at the report of the action that was not run the page says in its own sentence that there was no fresh frame and what to do, in English", "did not run this action, because it had no fresh frame of the wrist camera" in advice_english and "start it (with the simulated arm the test picture is enough)" in advice_english, advice_english)
    check.ok("camera: and in Chinese when the page is Chinese", "沒有手腕攝影機的新畫面" in advice_chinese and "請啟動它（使用模擬手臂時，測試畫面就夠了）" in advice_chinese, advice_chinese)
    check.ok("camera: beside the page's sentence PEAR's report and result line are unchanged", CAMERA_STOPPED in page.locator("#station-feedback").inner_text() and page.locator("#station-report-line").get_attribute("data-outcome") == "station.action.done", [page.locator("#station-feedback").inner_text()[:200], page.locator("#station-report-line").get_attribute("data-outcome")])
    status = settled_status(page)
    check.equal("camera: the station still holds the arm, at rest", [status["robot"], status["control"]], ["READY", "HOLD"])
    page.click("#camera-start")
    wait_station(page, "view.status.camera.isRunning === true && view.status.camera.perSecond >= 5", 10000)
    page.click(button)
    wait_station(page, "view.action === null && view.outcome !== null", 30000)
    record = (station_view(page)["report"] or {}).get("record") or {}
    frame = station_frame(page) or {}
    check.equal("camera: with the camera started again an action completes, and its observation held a frame", [record.get("status"), frame.get("first"), frame.get("width"), frame.get("height")], ["completed", [0xFF, 0xD8], 640, 480])
    check.equal("camera: after an action that completes the page's sentence about the frame is gone", [advice.is_visible(), advice.text_content()], [False, ""])
    lines = log_lines(page)
    told = [line for line in lines if line.startswith("Station: the camera ")]
    text = "\n".join(lines)
    check.ok("camera: the log tells when the station's camera went on, off and on again, and holds no frame's bytes", [line.split(";")[0] for line in told[-3:]] == ["Station: the camera runs", "Station: the camera stopped", "Station: the camera runs"] and "/9j/" not in text and max(len(line) for line in lines) < 5000, told)
    check.numbers.setdefault("station", {})["the camera stopped and started"] = {"stopped": failed, "frame after the start": frame, "the panel's line": [english, chinese]}
    return settled_status(page)


def station_buttons(check: Check, page: Page) -> dict:
    """On the enabled station, after Home: each of the twelve buttons is one action of the model's format that
    completes and changes the quantity it names, in the model's state the Worker tells, by its amount with its
    sign. Returns the Worker's status at the end."""
    seen = {}
    status = settled_status(page)
    last_number = 0
    for button, part, quantity, amount, tolerance, gripper in JOG_BUTTONS:
        before = status
        page.click(f"#station-jog button[data-jog='{button}']")
        wait_station(page, "view.action === null && view.outcome !== null", 30000)
        view = station_view(page)
        report = view["report"] or {}
        record = report.get("record") or {}
        status = settled_status(page)
        change = status["state"][part][quantity] - before["state"][part][quantity]
        check.equal(f"buttons: {button} is one action that completed", [view["outcome"]["key"], record.get("status")], ["station.action.done", "completed"])
        check.close(f"buttons: {button} changed {part}.{quantity} of the model's state by {amount:+g}", change, amount, tolerance)
        seen[button] = {"status": record.get("status"), "change": round(change, 4), "before": before["state"], "after": status["state"]}
        # the frame its observation held, as the Worker told it once: the very bytes, which the page decodes
        frame = station_frame(page) or {}
        check.equal(f"buttons: {button}: its observation held a frame: JPEG bytes (FF D8 first, FF D9 last) that the page decodes to 640 x 480 and shows in the panel", [frame.get("first"), frame.get("last"), frame.get("width"), frame.get("height"), frame.get("isShown")], [[0xFF, 0xD8], [0xFF, 0xD9], 640, 480, True])
        check.ok(f"buttons: {button}: the frame's number is at least 1 and higher than that of the action before, and the frame was no older than 0.2 s", frame.get("number", 0) >= 1 and frame.get("number", 0) > last_number and 0 <= frame.get("ageMs", 999) <= 200, [last_number, frame])
        last_number = frame.get("number", 0)
        seen[button]["frame"] = frame
        if gripper is not None:
            told = json_or_none(str(report.get("feedback") or "").removesuffix(" Use the new measured observation.")) or {}
            check.equal(f"buttons: {button}: PEAR's record and the report the model reads tell the gripper as {gripper}", [record.get("gripper_outcome"), told.get("gripper")], [gripper, gripper])
            seen[button].update({"record": record, "feedback": report.get("feedback")})
    check.numbers.setdefault("station", {})["buttons"] = seen
    return status


def station_home_stopped(check: Check, page: Page) -> dict:
    """A Home that the person's Stop ends, while its plan waits for an answer and while it moves the arm: the
    page's own line says that the person pressed Stop, followed by the robot's own words. Called where the arm
    stands away from Home. Returns the Worker's status at the end."""
    report_line = page.locator("#station-report-line")
    expected = ["station.action.homeStopped", "station.action.homeStopped", True, True]

    def at_rest() -> dict:
        steps = station_view(page)["status"]["steps"]
        wait_station(page, f"view.status.steps >= {steps + 10} && view.status.robot === 'READY'")
        return station_view(page)["status"]

    def told() -> tuple:
        outcome = station_view(page)["outcome"] or {"key": None, "values": {}}
        line = report_line.inner_text()
        error = str(outcome["values"].get("error") or "")
        return outcome, [outcome["key"], report_line.get_attribute("data-outcome"), "you pressed Stop before it was done" in line, error != "" and line.endswith(f"The robot says: {error}")]

    # Stop while the plan waits for an answer: Home ends there, the plan is no longer shown, and nothing moved
    before = at_rest()
    page.click("#station-home")
    wait_station(page, "view.plan !== null", 15000)
    page.click("#task-stop")
    wait_station(page, "view.action === null && view.outcome !== null", 15000)
    outcome, shown = told()
    check.equal("home stopped: Stop while the plan waits: the page's own line in the report panel says that the person pressed Stop, followed by the robot's words", shown, expected)
    check.equal("home stopped: Stop while the plan waits: the plan is no longer shown", [station_view(page)["plan"], page.locator("#station-plan").is_visible()], [None, False])
    waited = at_rest()
    check.equal("home stopped: Stop while the plan waits: nothing moved", waited["state"], before["state"])
    check.numbers.setdefault("station", {})["a Home stopped while its plan waited"] = outcome

    # Stop while Home moves the arm: the arm holds where it braked, the station is still on, and an action runs after it.
    # Home is given a way to go (the arm is lowered by 4 cm first), and Stop is pressed once the tip has moved 0.3 cm
    page.evaluate(f"window.pearjs.jog({delta_action(z=-4)})")
    low = settled_status(page)
    page.click("#station-home")
    wait_station(page, "view.plan !== null", 15000)
    page.click("#station-approve")
    wait_station(page, f"view.status.control !== 'HOLD' && ['x', 'y', 'z'].some(name => Math.abs(view.status.state.arm[name] - {json.dumps(low['state']['arm'])}[name]) >= 0.3)", 15000)
    page.click("#task-stop")
    wait_station(page, "view.action === null && view.outcome !== null", 15000)
    outcome, shown = told()
    check.equal("home stopped: Stop while Home moves the arm: the page's own line in the report panel says that the person pressed Stop, followed by the robot's words", shown, expected)
    page.click("#language-zh")
    check.ok("home stopped: the page's own line is in Chinese when the page is Chinese", "\u4f60\u5728\u5b83\u5b8c\u6210\u4e4b\u524d\u6309\u4e86\u505c\u6b62" in report_line.inner_text() and "\u6a5f\u5668\u4eba\u56de\u5831\uff1a" in report_line.inner_text(), report_line.inner_text())
    page.click("#language-en")
    held = at_rest()
    check.equal("home stopped: Stop while Home moves the arm: the station is still on, the robot READY in HOLD", [station_view(page)["phase"], held["robot"], held["control"]], ["on", "READY", "HOLD"])
    page.wait_for_timeout(500)
    check.equal("home stopped: the arm holds: half a second later its state is the same", station_view(page)["status"]["state"], held["state"])
    home_arm = ((check.numbers["station"].get("Home") or {}).get("state") or {}).get("arm") or {}
    left = max(abs(held["state"]["arm"][name] - low["state"]["arm"][name]) for name in ("x", "y", "z"))
    short = max((abs(held["state"]["arm"][name] - home_arm[name]) for name in ("x", "y", "z") if name in home_arm), default=0)
    check.ok("home stopped: Stop while Home moves the arm: the tip had left where it stood and braked short of Home", left >= 0.3 and short >= 0.3, [low["state"], held["state"], home_arm])
    check.numbers["station"]["a Home stopped while the arm moved"] = {**outcome, "state before": low["state"], "state held": held["state"], "Home": home_arm}
    page.click("#station-jog button[data-jog='z-plus']")
    wait_station(page, "view.action === null && view.outcome !== null", 30000)
    check.equal("home stopped: an action runs after it", ((station_view(page)["report"] or {}).get("record") or {}).get("status"), "completed")
    return settled_status(page)


def set_hidden(page: Page, is_hidden: bool) -> None:
    """Makes the page hold itself for hidden, or visible again, and tells it so. A headless page cannot be
    hidden: what is shown is what the page does when the browser says that it is."""
    page.evaluate(
        """isHidden => {
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => isHidden });
            Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (isHidden ? 'hidden' : 'visible') });
            document.dispatchEvent(new Event('visibilitychange'));
        }""",
        is_hidden,
    )


def station_hidden(check: Check, page: Page, status: dict) -> dict:
    """The page hidden while the station drives: the action under way is stopped, no action is started, the loop
    goes on and nothing is closed; visible again, actions are offered. Returns the Worker's status at the end."""
    page.evaluate(f"void window.pearjs.jog({delta_action(z=-6)})")
    wait_station(page, "view.status.control !== 'HOLD'", 10000)
    set_hidden(page, True)
    wait_station(page, "view.action === null && view.status.isHidden === true", 15000)
    view = station_view(page)
    check.equal("hidden: the action under way is stopped", [view["report"]["record"]["status"], (view["report"]["record"].get("error") or {}).get("message")], ["failed", "Action cancelled by stop or another operation"])
    check.ok("hidden: the page's own line says that the page was hidden while the action ran", "the page was hidden while it ran, so the station stopped it" in page.locator("#station-action").inner_text() and page.locator("#station-action").get_attribute("data-status") == "failed", page.locator("#station-action").inner_text())
    wait_station(page, "view.status.robot === 'READY'")
    held = station_view(page)["status"]
    check.ok("hidden: the arm braked on the way", status["state"]["arm"]["z"] - held["state"]["arm"]["z"] < 5.5, [status["state"], held["state"]])
    check.equal("hidden: the station still holds the arm; nothing is closed", [station_view(page)["phase"], held["robot"], held["control"]], ["on", "READY", "HOLD"])
    check.ok("hidden: no action is offered", page.evaluate("[...document.querySelectorAll('#station-jog button')].every(button => button.disabled)") and page.locator("#station-home").is_disabled())
    check.equal("hidden: an action asked for all the same is refused by the Worker", page.evaluate(f"window.pearjs.stationClient.request({{ type: 'jog', action: {delta_action(z=1)} }}).then(() => 'answered', error => error.message)"), "RuntimeError: The page is hidden: no action is started")
    check.equal("hidden: Home too", page.evaluate("window.pearjs.stationClient.request({ type: 'home' }).then(() => 'answered', error => error.message)"), "RuntimeError: The page is hidden: no action is started")
    page.evaluate(f"window.pearjs.jog({delta_action(z=1)})")
    wait_station(page, "view.action === null")
    not_run = page.locator("#station-report-line").inner_text()
    check.ok("hidden: an action the Worker refused is told in the report panel as not run, in the Worker's words, and no earlier report is shown there", page.locator("#station-report").is_visible() and "did not run" in not_run and "The page is hidden: no action is started" in not_run and not page.locator("#station-report-model").is_visible(), not_run)
    before = held["steps"]
    page.wait_for_timeout(400)
    check.ok("hidden: the loop goes on", station_view(page)["status"]["steps"] - before >= 15, station_view(page)["status"]["steps"] - before)
    check.ok("hidden: the page says what happened", page.locator("#station-messages [data-kind='station-hidden']").count() == 1 and "hidden" in page.locator("#station-messages").inner_text())
    entries = clock_entries(page, "hidden")
    check.ok("hidden: the log holds the clock's entry written when the page became hidden: one line of JSON with plausible counts", len(entries) == 1 and clock_plausible(entries[0]), entries)
    check.ok("hidden: Stop stays enabled", not page.locator("#task-stop").is_disabled())
    set_hidden(page, False)
    wait_station(page, "view.status.isHidden === false")
    check.ok("visible again: actions are offered", page.evaluate("[...document.querySelectorAll('#station-jog button')].every(button => !button.disabled)") and not page.locator("#station-home").is_disabled())
    page.wait_for_timeout(300)
    warning = page.locator("#station-messages [data-kind='station-hidden']")
    warning_text = warning.inner_text() if warning.count() == 1 else ""
    check.ok("visible again: the warning speaks in the past and no longer says that no action starts", "The page was hidden for a while: the station stopped then" in warning_text and "starts no action" not in warning_text, warning_text)
    page.click("#station-jog button[data-jog='z-plus']")
    wait_station(page, "view.action === null && view.report.record.status === 'completed'", 30000)
    wait_station(page, "view.status.robot === 'READY'")
    check.ok("visible again: an action runs", True)
    lines = log_lines(page)
    check.ok("hidden: the log tells of both", "Station: the page is hidden: stop, and no action until it is visible" in lines and "Station: the page is visible again" in lines, lines[-8:])
    return station_view(page)["status"]


def station_real_arm(check: Check, browser, base: str) -> None:
    """A port that is not the simulated one, read as a calibrated arm: the station stays disabled and says why, in
    both languages; and whatever is asked of the station's client all the same, nothing but reads is written to
    that port (the Worker has no way to it: it drives an arm it makes itself)."""
    own = browser.new_context(viewport={"width": 1280, "height": 800}, locale="en-US")
    check.watch(own)
    own.add_init_script(scripted_port(USB_ADAPTER, SIX_CALIBRATED))
    page = open_page(check, own, base)
    page.click("#arm-connect")
    wait_phase(page, "reading")
    page.wait_for_function("window.pearjs.arm.view.live !== null")
    view = page.evaluate("(() => { const view = window.pearjs.arm.view; return { isSimulated: view.isSimulated, isUncalibrated: view.isUncalibrated, servos: view.servos.length, hasLive: view.live !== null }; })()")
    check.equal("a real arm: the stand-in port is read as a calibrated arm of six servos, not the simulated one", view, {"isSimulated": False, "isUncalibrated": False, "servos": 6, "hasLive": True})
    check.ok("a real arm: the log names the port as the browser's own", "Port chosen (Web Serial): USB vendor 1a86, product 55d3" in log_lines(page), log_lines(page)[:8])

    why = page.locator("#station-why")
    check.equal("a real arm: Enable is disabled, for the reason of a real arm", [page.locator("#station-enable").is_disabled(), why.get_attribute("data-why")], [True, "station.why.realArm"])
    check.ok("a real arm: the sentence says that this Enable is for the simulated arm, and names the control that enables the station on a real arm after a confirmation", all(words in why.inner_text() for words in ("A real arm is connected", "“Enable” here is for the simulated arm", "use “Enable the station on this arm” below", "writes to the servos only after your confirmation")), why.inner_text())
    page.click("#language-zh")
    check.ok("a real arm: the same sentence in Chinese", all(words in why.inner_text() for words in ("目前連接的是真實的手臂", "這裡的「啟用」是給模擬手臂用的", "請按下面的「在這支手臂上啟用工作站」", "等你確認之後才對伺服馬達寫入")), why.inner_text())
    page.click("#language-en")
    check.ok("a real arm: Stop is disabled", page.locator("#task-stop").is_disabled())
    check.ok("a real arm: no action is offered", page.locator("#station-home").is_disabled() and page.evaluate("[...document.querySelectorAll('#station-jog button')].every(button => button.disabled)"))
    check.equal("a real arm: no Worker runs", len(page.workers), 0)
    page.click("#station-enable", force=True, timeout=2000)
    page.wait_for_timeout(300)
    check.equal("a real arm: a click on the disabled Enable starts no Worker", [len(page.workers), station_view(page)["phase"]], [0, "off"])

    # a request sent to the station's client all the same: without a Worker it is not even sent
    check.equal("a real arm: a request to the station's client is refused, as no Worker runs", page.evaluate("window.pearjs.stationClient.request({ type: 'enable', positions: {}, isHidden: false }).then(() => 'answered', error => error.message)"), "the Worker does not run")
    # and with the Worker started by hand (which the page never does on a real arm): the Worker drives the arm it
    # makes itself, and the port is given nothing but reads
    written_before = page.evaluate("window.portLog.written.length")
    asked = page.evaluate(
        f"""(async () => {{
            const client = window.pearjs.stationClient;
            client.start();
            const positions = {{ shoulder_pan: 2025, shoulder_lift: 1540, elbow_flex: 2003, wrist_flex: 2915, wrist_roll: 996, gripper: 3499 }};
            const enabled = await client.request({{ type: 'enable', positions, isHidden: false }});
            // nothing was told of a camera: the robot runs no action
            const blind = await client.request({{ type: 'jog', action: {delta_action(z=1)} }});
            // the camera told by hand as the window tells it: that it runs, and frames of the test picture
            const picture = window.pearjs.testPicture();
            const send = async () => {{
                const frame = await window.pearjs.frameOf(picture, 640, 480);
                URL.revokeObjectURL(frame.url);
                client.tell({{ kind: 'frame', jpeg: frame.bytes.buffer }});
            }};
            client.tell({{ kind: 'camera', isRunning: true }});
            await send();
            const feeder = setInterval(send, 100);
            const report = await client.request({{ type: 'jog', action: {delta_action(z=1)} }});
            clearInterval(feeder);
            const disabled = await client.request({{ type: 'disable' }});
            return {{ failures: enabled.timing.failures, status: report.record.status, motors: Object.keys(disabled.positions).length, blind: blind.record }};
        }})()"""
    )
    blind = asked.pop("blind", None) or {}
    check.equal("a real arm: asked all the same, the Worker enables, runs one action and disables on its own simulated arm", asked, {"failures": [], "status": "completed", "motors": 6})
    check.ok("a real arm: before the Worker was told of a camera its robot ran no action: the result failed with PEAR's \"Camera unavailable\" and the reader's reason", blind.get("status") == "failed" and "Camera unavailable: {'wrist': 'Camera reader stopped; reconnect the camera'}" in json.dumps(blind), blind)
    check.numbers.setdefault("station", {})["a real arm: the action without a camera"] = blind
    port_log = page.evaluate("window.portLog")
    instructions = sorted({entry["bytes"][4] for entry in port_log["written"]})
    check.ok("a real arm: every packet the port was given is a PING, a READ or a SYNC READ", len(instructions) > 0 and set(instructions) <= {1, 2, 0x82}, instructions)
    check.ok("a real arm: the page went on reading the arm meanwhile", len(port_log["written"]) > written_before + 10, [written_before, len(port_log["written"])])
    check.equal("a real arm: the port was opened once, at the servos' baud rate, and not closed", [[entry["baudRate"] for entry in port_log["opened"]], port_log["closed"]], [[1000000], 0])
    check.equal("a real arm: the guard refused nothing", page.locator("#guard-line").get_attribute("data-refused"), "0")
    check.equal("a real arm: the guard's self-test still reads as passed", page.evaluate("window.pearjs.selfTest().failures"), [])
    check.equal("a real arm: the page still reads the arm and Enable stays disabled for the same reason", [phase(page), page.locator("#station-enable").is_disabled(), why.get_attribute("data-why")], ["reading", True, "station.why.realArm"])
    own.close()


def part_station(check: Check, browser, context: BrowserContext, base: str, dist: Path) -> None:
    """The station in the page's Worker on the simulated arm: Enable, the status events, Stop and Disable; from a
    host, from a folder and under a path of a host; and a Worker that is gone."""
    context.add_init_script(BLOB_TEXTS)
    page = open_page(check, context, base)
    status = station_enabled(check, page, "served")

    # the text the Worker was started from (the Blob behind the Worker's URL): of Web Serial it names what its
    # hand-over check needs to find a granted port, and nothing by which it could ask for one
    worker_text = page.evaluate("async url => { const blob = window.blobOf(url); return blob === null ? null : await blob.text(); }", page.workers[0].url if page.workers else "")
    named = [name for name in WEB_SERIAL_NAMES if name in (worker_text or "")]
    check.equal("served: the text the Worker was started from is the station's code; of Web Serial's entry points it names getPorts and never requestPort", [worker_text is not None and "The timing self-check failed" in worker_text, "getPorts" in named, "requestPort" in named], [True, True, False])
    check.numbers["station"]["the Worker's text"] = {"characters": len(worker_text or ""), "names of Web Serial in it": named}
    page.click("#language-zh")
    page.wait_for_timeout(300)
    check.ok("served: the clock's line is in Chinese when the page is Chinese", "啟用以來 Worker 的時鐘" in page.locator("#station-clock").inner_text(), page.locator("#station-clock").inner_text())
    camera_line = page.locator("#station-camera").inner_text()
    check.ok("served: the camera's line tells the longest time between two frames in Chinese when the page is Chinese", "兩張畫面之間最長間隔" in camera_line and camera_line.endswith("的次數：0。"), camera_line)
    page.click("#language-en")

    # Stop while the arm holds: the robot's stop(), which never closes
    page.click("#task-stop")
    page.wait_for_function("document.getElementById('log-output').value.includes('Station: stopped')")
    entries = clock_entries(page, "stop")
    check.ok("served: at Stop the log holds the clock, the periods since enabling and the self-check's numbers: one line of JSON with plausible counts", len(entries) == 1 and clock_plausible(entries[0]), entries)
    check.ok("served: at Stop the entry holds the camera's numbers: frames arrived, never 0.2 s apart, and the window timed the frames it made", len(entries) == 1 and isinstance(entries[0], dict) and camera_kept_fresh(entries[0].get("camera")), [entry.get("camera") if isinstance(entry, dict) else None for entry in entries])
    if len(entries) == 1 and entries[0] is not None:
        check.numbers["station"]["the log's entry at Stop"] = entries[0]
    wait_station(page, "view.status.robot === 'READY'")
    view = station_view(page)
    check.equal("served: after Stop the station still holds the arm, at rest", [view["phase"], view["status"]["robot"], view["status"]["control"]], ["on", "READY", "HOLD"])
    check.equal("served: Stop moved nothing", view["status"]["turnText"], status["turnText"])
    before = view["status"]["steps"]
    page.wait_for_timeout(300)
    check.ok("served: the loop goes on after Stop", station_view(page)["status"]["steps"] > before)
    check.equal("served: a request the station refuses comes back in the robot's words", page.evaluate("window.pearjs.stationClient.request({ type: 'enable', positions: {}, isHidden: false }).then(() => 'answered', error => error.message)"), "RuntimeError: Station already open")
    station_actions(check, page)
    status = station_buttons(check, page)
    status = station_camera(check, page)
    status = station_hidden(check, page, status)
    status = station_home_stopped(check, page)
    page.screenshot(path=str(check.out / "station.png"), full_page=True)
    station_disabled(check, page, "served", status["turnText"])

    # a hidden page fails the timing self-check, which refuses to enable; the window reads the arm again
    set_hidden(page, True)
    page.click("#station-enable")
    wait_station(page, "view.phase === 'off' && view.problem !== null", 15000)
    problem = station_view(page)["problem"]
    check.ok("hidden: enabling on a hidden page is refused by the timing self-check", "The timing self-check failed" in problem["error"] and "the page is not visible" in problem["error"], problem)
    check.equal("hidden: the page shows the self-check as failed", page.locator("#station-timing").get_attribute("data-verdict"), "failed")
    timing_line = page.locator("#station-timing").inner_text()
    check.ok("hidden: the self-check's line gives the reason in the page's own sentence", "failed, so the station was not enabled (the page is not visible)" in timing_line, timing_line)
    page.click("#language-zh")
    timing_line = page.locator("#station-timing").inner_text()
    check.ok("hidden: and in Chinese when the page is Chinese", "未通過，所以沒有啟用工作站（頁面目前沒有顯示在畫面上）" in timing_line, timing_line)
    box_zh = page.locator("#station-messages").inner_text()
    page.click("#language-en")
    check.ok("hidden: and says that the station could not be enabled", "could not be enabled" in page.locator("#station-messages").inner_text(), page.locator("#station-messages").inner_text())
    box_en = page.locator("#station-messages").inner_text()
    check.equal("hidden: the box under the self-check says in the page's language that the self-check failed; the Worker's English error is in the log only", ["the timing self-check failed. Its line above gives the reasons" in box_en, "計時自我檢查未通過" in box_zh, any(words in text for words in ("RuntimeError", "The timing self-check failed:") for text in (box_en, box_zh)), any(line.startswith("Station: could not be enabled: RuntimeError: The timing self-check failed: the page is not visible") for line in log_lines(page))], [True, True, False, True])
    wait_phase(page, "reading")
    check.ok("hidden: Stop stays disabled", page.locator("#task-stop").is_disabled())
    set_hidden(page, False)

    # a second session in the same Worker
    page.click("#station-enable")
    wait_station(page, "view.phase === 'on' && view.status !== null && view.status.robot === 'READY'")
    check.equal("served: the station can be enabled again, in the same Worker", len(page.workers), 1)

    # a Worker that is gone is shown as that, and the page offers nothing that would need it
    page.evaluate("window.pearjs.stationClient.worker.terminate()")
    wait_station(page, "view.lost !== null", 8000)
    check.equal("served: a Worker that tells nothing is shown as not answering", page.locator("#station-status").get_attribute("data-phase"), "lost")
    check.ok("served: and the page says so", "does not answer" in page.locator("#station-status").inner_text(), page.locator("#station-status").inner_text())
    check.ok("served: and what to do about it: reload the page", "reload the page" in page.locator("#station-status").inner_text(), page.locator("#station-status").inner_text())
    check.equal("served: with the Worker gone no arm can be connected beside the station it held", [page.locator("#arm-connect").is_disabled(), page.locator("#arm-sim").is_disabled()], [True, True])
    check.ok("served: no action is offered then", page.locator("#station-home").is_disabled() and page.evaluate("[...document.querySelectorAll('#station-jog button')].every(button => button.disabled)"))
    page.click("#task-stop")
    page.wait_for_function("document.getElementById('log-output').value.includes('Station: Stop got no answer')", timeout=8000)
    check.ok("served: a Stop that is not answered is told", "Stop got no answer" in page.locator("#station-messages").inner_text(), page.locator("#station-messages").inner_text())
    check.ok("served: the log tells that the Worker does not answer", any(line.startswith("Station: the Worker does not answer") for line in log_lines(page)))
    page.close()

    # a port that is not the simulated one, read as an arm: the station stays disabled
    station_real_arm(check, browser, base)

    # from a folder: the Worker starts from a Blob URL of a page that has no origin
    folder = browser.new_context(viewport={"width": 1280, "height": 800}, locale="en-US")
    check.watch(folder)
    page = folder.new_page()
    page.goto(f"{dist.as_uri()}/index.html?lang=en")
    page.wait_for_function("window.pearjs !== undefined && window.pearjs.selfTest() !== null", timeout=10000)
    check.equal("from a folder: the page's own address", page.evaluate("location.protocol"), "file:")
    status = station_enabled(check, page, "from a folder")
    station_disabled(check, page, "from a folder", status["turnText"])
    folder.close()

    # under a path of a host, as GitHub Pages serves a project's page
    UnderPath.served = []
    server, origin = serve(functools.partial(UnderPath, directory=str(dist)))
    try:
        hosted = browser.new_context(viewport={"width": 1280, "height": 800}, locale="en-US")
        check.watch(hosted)
        page = hosted.new_page()
        page.goto(f"{origin}{HOSTED_PATH}/?lang=en")
        page.wait_for_function("window.pearjs !== undefined && window.pearjs.selfTest() !== null", timeout=10000)
        status = station_enabled(check, page, "under a path")
        station_disabled(check, page, "under a path", status["turnText"])
        hosted.close()
        asked = sorted({urlsplit(entry[0]).path for entry in UnderPath.served})
        check.ok("under a path: the station asked the host for nothing but the page, its script and its style sheet", len(asked) == 3 and all(path.startswith(f"{HOSTED_PATH}/") for path in asked), asked)
    finally:
        server.shutdown()
        server.server_close()


# The hand-over check of a real arm's line (the request "preflight"): how the page's log begins the line of the
# Worker's report, and the lines by which it says that a check has ended, whichever way.
PREFLIGHT_REPORT = "Station: real-arm preflight "
PREFLIGHT_ENDS = (
    "Station: the window reads the arm again, on the same port",
    "Station: the window does not read the arm again on the same port",
    "Station: the Worker did not give the line back",
)
# The fields of the Worker's report (PreflightReport in station_protocol.ts).
PREFLIGHT_FIELDS = ["detail", "guard", "isClosed", "lineErrors", "ports", "servos", "settings", "singleReads", "stop", "timing", "tookMs"]
# What the page's simulated arm holds of its calibration, by servo id (Homing_Offset and the two position limits),
# the model number of an STS3215, and the USB ids of the adapter (a CH343's), written out here.
SIM_ARM = {1: [-1470, 758, 3292], 2: [97, 857, 3284], 3: [1238, 836, 3069], 4: [-1028, 838, 3138], 5: [-233, 0, 4095], 6: [1269, 2037, 3499]}
STS3215 = 777
ADAPTER_IDS = {"vendorId": 0x1A86, "productId": 0x55D3}
# Where a servo keeps a setting, as the report's table says it in English.
SETTING_AREAS = {
    "eeprom": "EEPROM: survives a power cycle",
    "ram": "RAM: lost when the power goes off",
    "factory": "factory block: not known whether it survives a power cycle",
}
# Keeps what the stand-in port had seen of the page at two moments (window.handOver): when the request "preflight"
# went to the Worker, and when the Worker's report came back, before the page's own listener got it.
HANDOVER_MOMENTS = """window.handOver = [];
window.Worker = class extends Worker {
    constructor(...parts) {
        super(...parts);
        this.addEventListener('message', event => {
            let text = '';
            try { text = JSON.stringify(event.data) ?? ''; } catch { text = ''; }
            if (text.includes('"tookMs"')) window.handOverMoment('report');
        });
    }
    postMessage(message, ...rest) {
        if (message?.request?.type === 'preflight') window.handOverMoment('request');
        return super.postMessage(message, ...rest);
    }
};
window.handOverMoment = what => {
    const log = window.portLog;
    window.handOver.push({ what, opened: log.opened.length, closed: log.closed, written: log.written.length });
};"""
# What the page shows of the hand-over check: whether its control is shown and can be pressed, the line while it
# runs, and the report's parts in their order, each with its kind, its tone ("table" for a table), its sentence or
# title, the Worker's own words and a table's rows.
PREFLIGHT_SHOWN = """(() => {
    const visible = node => node.getClientRects().length > 0;
    const control = document.getElementById('station-preflight-run');
    const line = document.getElementById('station-preflight-status');
    const found = document.getElementById('station-preflight-report');
    const parts = [...document.getElementById('station-preflight-parts').children].map(node => ({
        kind: (node.dataset.kind ?? '').replace(/^preflight-/, ''),
        tone: node.dataset.tone ?? (['error', 'warn'].find(tone => node.classList.contains(tone)) ?? 'table'),
        text: (node.matches('p') ? node : node.querySelector('h4, p'))?.textContent ?? '',
        detail: node.querySelector('p.detail')?.textContent ?? null,
        rows: [...node.querySelectorAll('tbody tr')].map(row => [...row.cells].map(cell => cell.textContent)),
    }));
    return { isShown: visible(control), isOffered: visible(control) && !control.disabled, running: line.dataset.running ?? '',
             line: line.textContent, isReportShown: visible(found), stop: found.dataset.stop ?? '', closed: found.dataset.closed ?? '', parts };
})()"""


def preflight_shown(page: Page) -> dict:
    """Returns what the page shows of the hand-over check (PREFLIGHT_SHOWN)."""
    return page.evaluate(PREFLIGHT_SHOWN)


def preflight_sentences(shown: dict) -> dict:
    """Returns the sentences of the report the page shows, by their kind."""
    return {part["kind"]: part for part in shown["parts"] if part["tone"] != "table"}


def preflight_tables(shown: dict) -> dict:
    """Returns the tables of the report the page shows, by their kind."""
    return {part["kind"]: part for part in shown["parts"] if part["tone"] == "table"}


def preflight_order(shown: dict) -> list[list[str]]:
    """Returns the kind and the tone of each part of the report the page shows, in the page's order."""
    return [[part["kind"], part["tone"]] for part in shown["parts"]]


def preflight_reports(page: Page) -> list:
    """Returns the reports of the hand-over check in the page's log: what each line "Station: real-arm preflight
    {...}" writes as JSON, None for one that is no JSON."""
    return [json_or_none(line[len(PREFLIGHT_REPORT):]) for line in log_lines(page) if line.startswith(PREFLIGHT_REPORT + "{")]


def preflight_ended(page: Page) -> int:
    """Returns how many hand-over checks the page's log says have ended, whichever way."""
    return sum(1 for line in log_lines(page) if line.startswith(PREFLIGHT_ENDS))


def wait_offered(page: Page, timeout_ms: int = 10000) -> bool:
    """Waits until the hand-over check's control is shown and can be pressed; returns whether it is."""
    try:
        page.wait_for_function("(() => { const control = document.getElementById('station-preflight-run'); return control.getClientRects().length > 0 && !control.disabled; })()", timeout=timeout_ms)
        return True
    except WaitTimeout:
        return False


def preflight_pressed(page: Page) -> tuple[int, int]:
    """Presses the hand-over check's control; returns how many lines the log held and how many hand-over checks it
    said had ended, both before the press."""
    before = (len(log_lines(page)), preflight_ended(page))
    page.click("#station-preflight-run")
    return before


def preflight_report(check: Check, page: Page, label: str, before: tuple[int, int], reports: int) -> tuple[dict, list[str]]:
    """Waits for the end of the hand-over check that was pressed; returns its report as the log holds it, and the
    lines the log gained by it. ``reports`` is how many reports the log must hold then."""
    try:
        page.wait_for_function(
            "([beginnings, before]) => document.getElementById('log-output').value.split('\\n').filter(line => beginnings.some(beginning => line.includes(beginning))).length > before",
            arg=[list(PREFLIGHT_ENDS), before[1]],
            timeout=45000,
        )
    except WaitTimeout:
        pass
    check.equal(f"{label}: the hand-over check ends, and the log says how", preflight_ended(page), before[1] + 1)
    gained = log_lines(page)[before[0]:]
    found = preflight_reports(page)
    check.equal(f"{label}: the log holds one line \"Station: real-arm preflight {{...}}\" for each check that was run, and each is JSON", [len(found), all(isinstance(report, dict) for report in found)], [reports, True])
    report = found[-1] if found and isinstance(found[-1], dict) else {}
    check.equal(f"{label}: the report has the fields of the protocol's PreflightReport", sorted(report), PREFLIGHT_FIELDS)
    return report, gained


def reads_only(port_log: dict) -> list[int]:
    """Returns the instructions of the packets a stand-in port was given, each once: 1 is PING, 2 READ, 0x82 SYNC
    READ."""
    return sorted({entry["bytes"][4] for entry in port_log["written"]})


def enable_refused(page: Page) -> list:
    """Returns whether the station's Enable is disabled, and the reason the page gives."""
    return [page.locator("#station-enable").is_disabled(), page.locator("#station-why").get_attribute("data-why")]


def preflight_real_path(check: Check, browser, base: str) -> None:
    """Without ?preflight=sim, on a stand-in of a browser's port that answers as a calibrated arm of six servos:
    the control is offered and the hand-over runs as on a real arm, up to where a headless browser ends it. The
    Worker asks its own navigator.serial, whose getPorts() gives no port (the stand-in lives in the window), so
    the report stops at "no-port"; the port's own record tells what the window did around the request."""
    label = "the real path"
    own = browser.new_context(viewport={"width": 1280, "height": 800}, locale="en-US")
    check.watch(own)
    own.add_init_script(scripted_port(USB_ADAPTER, SIX_CALIBRATED))
    own.add_init_script(HANDOVER_MOMENTS)
    page = open_page(check, own, base)
    check.equal(f"{label}: before an arm is read the control is not shown", preflight_shown(page)["isShown"], False)
    page.click("#arm-connect")
    wait_phase(page, "reading")
    page.wait_for_function("window.pearjs.arm.view.live !== null")
    check.ok(f"{label}: on a port that is read as a calibrated arm of six servos, not the simulated one, the control is offered", wait_offered(page) and page.evaluate("window.pearjs.arm.view.isSimulated") is False, preflight_shown(page))
    why = page.locator("#station-why")
    check.equal(f"{label}: the station's Enable is still refused on a real arm", enable_refused(page), [True, "station.why.realArm"])
    check.ok(f"{label}: and its sentence says that this Enable is for the simulated arm", "“Enable” here is for the simulated arm" in why.inner_text(), why.inner_text())
    check.equal(f"{label}: no Worker runs before the control is pressed", len(page.workers), 0)
    port_log = page.evaluate("window.portLog")
    check.equal(f"{label}: before the hand-over the window has opened the port once, at the servos' baud rate, and not closed it", [[entry["baudRate"] for entry in port_log["opened"]], port_log["closed"]], [[1000000], 0])

    before = preflight_pressed(page)
    report, gained = preflight_report(check, page, label, before, 1)
    check.numbers.setdefault("preflight", {})["the real path: the report"] = report
    # the one fact of a real browser here: a Worker started from a Blob has a navigator.serial, and getPorts()
    # answers; null in place of the list would mean that this browser gives such a Worker no Web Serial
    check.equal(f"{label}: the Worker has a navigator.serial of its own and its getPorts() gave no port: the report's ports is an empty list, not null", report.get("ports", "absent"), [])
    check.equal(
        f"{label}: the report stops at no-port: nothing was read, no port was taken, the guard was given no packet",
        {name: report.get(name, "absent") for name in ("stop", "servos", "settings", "singleReads", "timing", "guard", "lineErrors", "isClosed")},
        {"stop": "no-port", "servos": None, "settings": None, "singleReads": None, "timing": None, "guard": {"passed": {}, "refused": 0}, "lineErrors": 0, "isClosed": True},
    )
    detail = str(report.get("detail", ""))
    check.equal(f"{label}: the Worker's own words name the adapter the window read and how many ports the Worker was given", detail, "The Worker was given no granted port with the USB ids 1a86:55d3 (0 granted in all)")
    asked = [line for line in gained if line.startswith("Station: real-arm preflight asked")]
    check.ok(f"{label}: the log says what the Worker was asked: a granted port, the adapter's ids, and that the window closed its session", len(asked) == 1 and "source granted;" in asked[0] and "the window closed its session" in asked[0] and 'usb {"vendorId":6790,"productId":21971}' in asked[0], asked)

    shown = preflight_shown(page)
    sentences = preflight_sentences(shown)
    check.equal(f"{label}: the page shows the report, stopped at no-port, with the line given back", [shown["isReportShown"], shown["stop"], shown["closed"]], [True, "no-port", "true"])
    check.equal(
        f"{label}: the report's parts, in their order: the stop as an error, the empty list of ports as a warning, and that nothing was read",
        preflight_order(shown),
        [["outcome", "error"], ["ports", "warn"], ["closed", "ok"], ["servos", "info"], ["settings", "info"], ["limp", "info"], ["timing", "info"], ["guard", "ok"], ["lineErrors", "ok"], ["took", "info"]],
    )
    outcome = sentences.get("outcome") or {}
    check.ok(f"{label}: the page says in a sentence that the Worker was given no port of this adapter, and what to do", str(outcome.get("text", "")).startswith("The Worker was given no port of this adapter, although the page was granted one. Reload the page, connect the arm in step 1 again and check once more;"), outcome)
    check.equal(f"{label}: under the sentence, the Worker's own words", outcome.get("detail"), detail)
    check.equal(
        f"{label}: the other sentences say the empty list, that the line is the window's again, and that nothing was read",
        [(sentences.get(kind) or {}).get("text") for kind in ("ports", "closed", "servos", "settings", "limp", "timing", "guard", "lineErrors")],
        [
            "Ports the Worker was given: none. Its getPorts() gave an empty list.",
            "The Worker does not hold the arm's line any more, so the window can read the arm again.",
            "The servos were not read.",
            "What PEAR's enable would change was not read.",
            "The limp time was not measured.",
            "The timing self-check was not run.",
            "The read-only guard let through: no packet. It refused nothing.",
            "The line reported no error while the Worker had it.",
        ],
    )
    page.click("#language-zh")
    page.wait_for_function("!document.getElementById('station-preflight-parts').dataset.signature.startsWith('en')")
    chinese = preflight_sentences(preflight_shown(page))
    check.ok(f"{label}: the stop's sentence in Chinese, with the Worker's own words as they are", str((chinese.get("outcome") or {}).get("text", "")).startswith("頁面已經取得這塊轉接板的授權，Worker 卻沒有拿到它的埠。") and (chinese.get("outcome") or {}).get("detail") == detail, chinese.get("outcome"))
    check.equal(f"{label}: the empty list and the line given back, in Chinese", [(chinese.get(kind) or {}).get("text") for kind in ("ports", "closed")], ["Worker 拿到的埠：沒有。它的 getPorts() 回傳的是空清單。", "Worker 已經不再占用手臂的線路，所以視窗可以重新讀取手臂。"])
    page.click("#language-en")

    # the port's own record: the truth the page's sentences and its log are held against
    moments = page.evaluate("window.handOver")
    check.equal(
        f"{label}: by the port's own record the window had closed the port when the request went to the Worker, and had not opened it again when the report came back",
        [[moment["what"], moment["opened"], moment["closed"]] for moment in moments],
        [["request", 1, 1], ["report", 1, 1]],
    )
    check.equal(f"{label}: between the request and the report nothing was written to the port", len(moments) == 2 and moments[1]["written"] - moments[0]["written"], 0)
    port_log = page.evaluate("window.portLog")
    check.equal(f"{label}: after the report the window opened the same port again, at the servos' baud rate, and it is not closed again", [[entry["baudRate"] for entry in port_log["opened"]], port_log["closed"]], [[1000000, 1000000], 1])
    written = len(port_log["written"])
    check.ok(f"{label}: the window reads the arm again: the port is given packets after the hand-over", len(moments) == 2 and wait_read_again(page, "window.portLog.written.length", written) > written > moments[1]["written"], [moments, written])
    check.ok(f"{label}: every packet the port was ever given is a PING, a READ or a SYNC READ", set(reads_only(page.evaluate("window.portLog"))) <= {1, 2, 0x82} and written > 0, reads_only(page.evaluate("window.portLog")))
    check.ok(f"{label}: the log says that the window reads the arm again, on the same port", "Station: the window reads the arm again, on the same port" in gained, gained[-3:])
    check.equal(f"{label}: step 1 reads the arm, and the window's guard refused nothing", [phase(page), page.locator("#guard-line").get_attribute("data-refused")], ["reading", "0"])
    check.ok(f"{label}: after it the control is offered again", wait_offered(page), preflight_shown(page))
    check.equal(f"{label}: after it the station is off, and its Enable is refused on a real arm as before", [station_view(page)["phase"], *enable_refused(page)], ["off", True, "station.why.realArm"])
    own.close()


def preflight_whole(check: Check, browser, base: str, service: str) -> None:
    """With ?preflight=sim, on the page's simulated arm: the whole hand-over. The Worker takes a simulated port of
    its own that holds the same calibration, reads it behind the read-only guard, measures the timing and gives
    the line back; the page shows every part of the report and the window reads the arm again. Then the gates
    around the station's Enable, and an arm that holds another calibration than the Worker's."""
    label = "the whole hand-over"
    own = browser.new_context(viewport={"width": 1280, "height": 800}, locale="en-US")
    check.watch(own)
    page = open_page(check, own, base, "?lang=en&preflight=sim")
    check.equal(f"{label}: with ?preflight=sim, before an arm is read the control is not shown", preflight_shown(page)["isShown"], False)
    connect_sim(page)
    page.wait_for_function("window.pearjs.arm.view.live !== null")
    check.ok(f"{label}: with ?preflight=sim the control is offered on the simulated arm", wait_offered(page), preflight_shown(page))
    check.equal(f"{label}: no Worker runs before the control is pressed", len(page.workers), 0)
    # the page is given a key and an address first: neither may come into what the hand-over writes to the log
    check.equal(f"{label}: a model service with a key is checked, so that the page holds a key and an address", run_model_check(page, f"{service}/v1", MODEL, KEY), "ok")
    window_read = page.evaluate("window.pearjs.arm.fingerprint")
    check.equal(
        f"{label}: what the window read of the six servos, and will ask the Worker to find: the simulated arm's calibration",
        [[servo["id"], servo["model"], servo["homingOffset"], servo["rangeMin"], servo["rangeMax"]] for servo in window_read or []],
        [[servo, STS3215, *SIM_ARM[servo]] for servo in SIM_ARM],
    )

    before = preflight_pressed(page)
    page.wait_for_function("document.getElementById('log-output').value.includes('Station: real-arm preflight asked')")
    during = page.evaluate(
        """(() => {
            const disabled = id => document.getElementById(id).disabled;
            return { enable: disabled('station-enable'), control: disabled('station-preflight-run'), connect: disabled('arm-connect'),
                     simulated: disabled('arm-sim'), isRead: window.pearjs.arm.view.phase === 'reading',
                     running: document.getElementById('station-preflight-status').dataset.running,
                     line: document.getElementById('station-preflight-status').textContent };
        })()"""
    )
    check.equal(
        f"{label}: while it runs, neither Enable nor the control can be pressed, nor step 1's Connect and Try without an arm; the window does not read the arm, and the page says that the Worker has the line",
        during,
        {"enable": True, "control": True, "connect": True, "simulated": True, "isRead": False, "running": "true", "line": "Checking: the Worker has the arm's line and reads it. This takes a few seconds…"},
    )
    refused = page.evaluate(
        """async expected => {
            const client = window.pearjs.stationClient;
            const told = request => client.request(request).then(() => 'answered', error => String(error?.message ?? error));
            const positions = { shoulder_pan: 2025, shoulder_lift: 1540, elbow_flex: 2003, wrist_flex: 2915, wrist_roll: 996, gripper: 3499 };
            return [await told({ type: 'enable', positions, isHidden: false }),
                    await told({ type: 'preflight', source: 'simulated', usb: null, expected, isHidden: false })];
        }""",
        window_read,
    )
    check.ok(f"{label}: asked all the same while it runs, the Worker refuses Enable and a second hand-over check", len(refused) == 2 and "A preflight of a real arm is under way" in refused[0] and "Another preflight of a real arm is under way" in refused[1], refused)
    report, gained = preflight_report(check, page, label, before, 1)
    check.numbers.setdefault("preflight", {})["the whole hand-over: the report"] = report

    servos = report.get("servos") or []
    settings = report.get("settings") or []
    guard = report.get("guard") or {}
    passed = guard.get("passed") or {}
    check.equal(
        f"{label}: nothing stopped it, the line was given back, the guard refused nothing, the line had no error, six servos and 45 settings were read",
        [report.get("stop", "absent"), report.get("detail"), report.get("isClosed"), guard.get("refused"), report.get("lineErrors"), len(servos), len(settings)],
        [None, "", True, 0, 0, 6, 45],
    )
    check.equal(f"{label}: the Worker was given one port, the simulated adapter's", report.get("ports"), [ADAPTER_IDS])
    check.equal(
        f"{label}: the same arm: the six servos the Worker read hold the model and the calibration the window read",
        [[servo.get("id"), servo.get("model"), servo.get("homingOffset"), servo.get("rangeMin"), servo.get("rangeMax")] for servo in servos],
        [[servo["id"], servo["model"], servo["homingOffset"], servo["rangeMin"], servo["rangeMax"]] for servo in window_read or []],
    )
    check.equal(f"{label}: the servos are named as PEAR names them, in the order of their ids", [[servo.get("id"), servo.get("name")] for servo in servos], [[index + 1, motor] for index, motor in enumerate(MOTORS)])
    check.ok(f"{label}: the guard let through reads only: PING, READ and SYNC READ, some of each", set(passed) == {"PING", "READ", "SYNC READ"} and all(isinstance(count, int) and count > 0 for count in passed.values()), passed)
    check.equal(f"{label}: the 45 settings are seven for each servo and three more for the gripper", {servo: sum(1 for setting in settings if setting.get("id") == servo) for servo in SIM_ARM}, {1: 7, 2: 7, 3: 7, 4: 7, 5: 7, 6: 10})
    changed = [setting for setting in settings if setting.get("held") != setting.get("pear")]
    check.ok(f"{label}: the simulated servos do not hold all of PEAR's values: some settings would be changed", 0 < len(changed) <= 45, len(changed))
    check.ok(f"{label}: each setting says where the servo keeps it, by its address", all(setting.get("area") == ("eeprom" if setting.get("address", -1) < 40 else "ram" if setting["address"] < 80 else "factory") for setting in settings) and len(settings) > 0, [[setting.get("address"), setting.get("area")] for setting in settings][:12])
    reads = report.get("singleReads") or {}
    timing = report.get("timing") or {}
    check.ok(f"{label}: the limp time was measured: single reads, their time together and the longest one", isinstance(reads.get("count"), int) and reads["count"] > 0 and is_number(reads.get("totalMs")) and is_number(reads.get("maxMs")) and 0 <= reads["maxMs"] <= reads["totalMs"], reads)
    check.equal(f"{label}: the timing self-check ran its 150 periods on the Worker's line and passed", [timing.get("periods"), timing.get("failures"), timing.get("reasons")], [150, [], []])
    check.ok(f"{label}: its numbers are those of a 20 ms loop", all(is_number(timing.get(name)) for name in ("meanMs", "maxMs", "maxReadMs", "over25")) and 15 <= timing["meanMs"] <= 25 and timing["maxMs"] >= timing["meanMs"], timing)
    check.ok(f"{label}: the report says how long the whole took, at least the timing self-check's three seconds", is_number(report.get("tookMs")) and 2900 <= report["tookMs"] < 30000, report.get("tookMs"))

    # the lines the hand-over wrote to the log
    asked = [line for line in gained if line.startswith("Station: real-arm preflight asked")]
    check.ok(f"{label}: the log says what the Worker was asked: a simulated port of its own, no adapter's ids, and what the window read", len(asked) == 1 and "source simulated (?preflight=sim: the Worker takes a simulated port of its own, no granted one)" in asked[0] and "usb null, expected " + json.dumps(window_read, separators=(",", ":")) in asked[0], asked)
    address = service.split("//")[-1]
    check.ok(f"{label}: no line the hand-over wrote to the log holds the key or the model service's address", len(gained) >= 3 and all(KEY not in line and address not in line for line in gained), [line[:160] for line in gained if KEY in line or address in line])
    check.ok(f"{label}: and the whole log holds no key", KEY not in "\n".join(log_lines(page)))

    # the report on the page, held against the report's JSON
    shown = preflight_shown(page)
    sentences = preflight_sentences(shown)
    tables = preflight_tables(shown)
    text = lambda value: str(value).replace("-", MINUS)  # noqa: E731
    named = {servo.get("id"): f"{servo.get('name')} ({servo.get('id')})" for servo in servos}
    check.equal(f"{label}: the page shows the report: no stop, the line given back", [shown["isReportShown"], shown["stop"], shown["closed"]], [True, "none", "true"])
    check.equal(
        f"{label}: the report's parts, in their order: the outcome, the ports, the line given back, the servos, what tells the arm, the settings as a warning with their rows, the limp time, the timing as passed, the guard, the line's errors, the time",
        preflight_order(shown),
        [["outcome", "ok"], ["ports", "info"], ["closed", "ok"], ["servos", "table"], ["identity", "table"], ["settings", "warn"], ["settings", "table"], ["limp", "info"], ["timing", "ok"], ["guard", "ok"], ["lineErrors", "ok"], ["took", "info"]],
    )
    check.equal(
        f"{label}: the page says that the Worker reached the adapter and read six servos, which port it was given, and that the line is the window's again",
        [(sentences.get(kind) or {}).get("text") for kind in ("outcome", "ports", "closed", "lineErrors")],
        [
            "The Worker reached the arm's adapter, opened the line behind the read-only guard and read all six servos.",
            "Ports the Worker was given (1): USB vendor 1a86, product 55d3.",
            "The Worker does not hold the arm's line any more, so the window can read the arm again.",
            "The line reported no error while the Worker had it.",
        ],
    )
    check.equal(
        f"{label}: the table of the six servos holds the report's values: torque, Lock, Status, voltage, temperature, Goal_Velocity, Torque_Limit, Phase and both positions",
        (tables.get("servos") or {}).get("rows"),
        [[named[servo["id"]], "off" if servo["torque"] == 0 else "on" if servo["torque"] == 1 else text(servo["torque"]), text(servo["lock"]), text(servo["status"]), f"{servo['voltage'] / 10:.1f}", text(servo["temperature"]),
          text(servo["goalVelocity"]), text(servo["torqueLimit"]), text(servo["phase"]), text(servo["position"]), text(servo["goal"])] for servo in servos],
    )
    check.equal(
        f"{label}: the table of what tells this arm from another holds the model, the firmware, Homing_Offset and the limits the Worker read",
        (tables.get("identity") or {}).get("rows"),
        [[named[servo["id"]], text(servo["model"]), servo["firmware"], text(servo["homingOffset"]), text(servo["rangeMin"]), text(servo["rangeMax"])] for servo in servos],
    )
    check.equal(
        f"{label}: the settings' sentence counts what PEAR's enable would change, of how many, and how many of them in the EEPROM",
        (sentences.get("settings") or {}).get("text"),
        f"PEAR's enable would change {len(changed)} of the 45 settings it writes besides the goal, the torque and the lock. {sum(1 for setting in changed if setting.get('area') == 'eeprom')} of them are in the EEPROM and survive a power cycle.",
    )
    check.equal(
        f"{label}: the settings' table lists exactly the rows of the report whose value differs from PEAR's: the servo, the register, its address, what it holds, what PEAR writes and where it is kept",
        (tables.get("settings") or {}).get("rows"),
        [[named.get(setting["id"]), setting["register"], text(setting["address"]), text(setting["held"]), text(setting["pear"]), SETTING_AREAS.get(setting["area"])] for setting in changed],
    )
    fixed = page.evaluate("values => values.map(value => typeof value === 'number' ? value.toFixed(2) : String(value))", [reads.get("totalMs"), reads.get("maxMs"), timing.get("meanMs"), timing.get("maxMs"), timing.get("maxReadMs")])
    check.equal(
        f"{label}: the limp time's sentence holds the report's count and times",
        (sentences.get("limp") or {}).get("text"),
        f"The limp time: PEAR's enable switches each servo's torque off for the time of {reads.get('count')} transactions. On this line {reads.get('count')} single reads took {fixed[0]} ms together, the longest of them {fixed[1]} ms.",
    )
    check.equal(
        f"{label}: the timing's sentence holds the self-check's numbers and its verdict",
        (sentences.get("timing") or {}).get("text"),
        f"Timing self-check on this line (reads only): {timing.get('periods')} control periods, mean {fixed[2]} ms, longest {fixed[3]} ms, {timing.get('over25')} over 25 ms, longest read {fixed[4]} ms: passed.",
    )
    guard_text = str((sentences.get("guard") or {}).get("text", ""))
    check.ok(f"{label}: the guard's sentence names what it let through, with the report's counts, and says that it refused nothing", guard_text.startswith("The read-only guard let through: ") and guard_text.endswith(". It refused nothing.") and all(f"{name} {count:,}" in guard_text for name, count in passed.items()) and len(passed) == 3, guard_text)
    check.equal(f"{label}: the last sentence says how long the whole took", (sentences.get("took") or {}).get("text"), f"The whole check took {round(report.get('tookMs') or 0):,} ms.")

    # the same report in Chinese
    page.click("#language-zh")
    page.wait_for_function("!document.getElementById('station-preflight-parts').dataset.signature.startsWith('en')")
    shown_zh = preflight_shown(page)
    chinese = preflight_sentences(shown_zh)
    tables_zh = preflight_tables(shown_zh)
    check.equal(f"{label}: in Chinese the report has the same parts in the same order", preflight_order(shown_zh), preflight_order(shown))
    check.equal(
        f"{label}: the report's sentences in Chinese, with the same numbers",
        [(chinese.get(kind) or {}).get("text") for kind in ("outcome", "ports", "closed", "settings", "limp", "timing", "lineErrors", "took")],
        [
            "Worker 找到了手臂的轉接板，在唯讀保護之後開啟線路，並讀完了六顆伺服馬達。",
            "Worker 拿到的埠（1 個）：USB 廠商 1a86、產品 55d3。",
            "Worker 已經不再占用手臂的線路，所以視窗可以重新讀取手臂。",
            f"除了目標位置、扭力和 Lock 之外，PEAR 啟用時會寫入 45 個設定，其中 {len(changed)} 個會被更動。這些當中有 {sum(1 for setting in changed if setting.get('area') == 'eeprom')} 個在 EEPROM 裡，斷電重開之後仍然保留。",
            f"鬆軟的時間：PEAR 啟用時，每顆伺服馬達的扭力會關閉 {reads.get('count')} 次通訊的時間。在這條線路上，{reads.get('count')} 次單獨讀取一共花了 {fixed[0]} ms，其中最長的一次 {fixed[1]} ms。",
            f"這條線路上的計時自我檢查（只讀取）：{timing.get('periods')} 個控制週期，平均 {fixed[2]} ms，最長 {fixed[3]} ms，{timing.get('over25')} 個超過 25 ms，最長的一次讀取 {fixed[4]} ms：通過。",
            "Worker 占用線路的期間，線路沒有回報任何錯誤。",
            f"整個檢查花了 {round(report.get('tookMs') or 0):,} ms。",
        ],
    )
    guard_zh = str((chinese.get("guard") or {}).get("text", ""))
    check.ok(f"{label}: the guard's sentence in Chinese: what it let through, and that it refused nothing", guard_zh.startswith("唯讀保護放行了：") and guard_zh.endswith("。它沒有擋下任何封包。") and all(f"{name} {count:,}" in guard_zh for name, count in passed.items()), guard_zh)
    check.equal(f"{label}: the tables' titles in Chinese", [(tables_zh.get(kind) or {}).get("text") for kind in ("servos", "settings")], ["Worker 讀到的六顆伺服馬達現況（沒有更動任何東西）", "PEAR 啟用時會更動的設定"])
    check.equal(
        f"{label}: the tables' numbers are the same in Chinese",
        [[row[2:] for row in (tables_zh.get("servos") or {}).get("rows") or []], [row[1:] for row in (tables_zh.get("identity") or {}).get("rows") or []], [row[1:5] for row in (tables_zh.get("settings") or {}).get("rows") or []]],
        [[row[2:] for row in (tables.get("servos") or {}).get("rows") or []], [row[1:] for row in (tables.get("identity") or {}).get("rows") or []], [row[1:5] for row in (tables.get("settings") or {}).get("rows") or []]],
    )
    page.click("#language-en")

    # the window reads the arm again
    check.ok(f"{label}: the log says that the window reads the arm again, on the same port", "Station: the window reads the arm again, on the same port" in gained, gained[-3:])
    check.equal(f"{label}: step 1 reads the simulated arm again", [phase(page), page.evaluate("window.pearjs.arm.view.isSimulated")], ["reading", True])
    page.evaluate("window.pearjs.sim().setPosition('wrist_roll', 1234)")
    try:
        wait_raw(page, {"wrist_roll": 1234})
        moved = True
    except WaitTimeout:
        moved = False
    check.ok(f"{label}: its readings go on: a servo turned by hand after the hand-over shows in step 1", moved, joints_shown(page))
    check.equal(f"{label}: the window's guard refused nothing", page.locator("#guard-line").get_attribute("data-refused"), "0")

    # the gates
    label = "the gates"
    check.ok(f"{label}: after a hand-over check the control is offered again", wait_offered(page), preflight_shown(page))
    try:
        page.wait_for_function("!document.getElementById('station-enable').disabled", timeout=10000)
    except WaitTimeout:
        pass
    check.equal(f"{label}: after a hand-over check Enable is offered again on the simulated arm", enable_refused(page), [False, "station.why.ready"])
    page.click("#station-enable")
    wait_station(page, "view.phase === 'on'", 40000)
    shown = preflight_shown(page)
    check.equal(f"{label}: while the station drives the simulated arm the control is not shown", [station_view(page)["phase"], shown["isShown"], shown["isOffered"]], ["on", False, False])
    refused = page.evaluate(
        """expected => window.pearjs.stationClient.request({ type: 'preflight', source: 'simulated', usb: null, expected, isHidden: false })
            .then(() => 'answered', error => String(error?.message ?? error))""",
        window_read,
    )
    check.ok(f"{label}: asked all the same while the station is open, the Worker refuses the hand-over check", "Station already open" in refused, refused)
    check.equal(f"{label}: and the station is still on, with the same one report in the log", [station_view(page)["phase"], len(preflight_reports(page))], ["on", 1])
    page.click("#station-disable")
    wait_station(page, "view.phase === 'off'")
    wait_phase(page, "reading")
    check.ok(f"{label}: after Disable the control is offered again", wait_offered(page), preflight_shown(page))

    # another arm: the window reads a calibration that the Worker's simulated port does not hold
    label = "another arm"
    page.evaluate("window.pearjs.sim().servo('elbow_flex').set('Homing_Offset', 1239)")
    page.click("#arm-disconnect")
    wait_phase(page, "idle")
    page.click("#arm-sim")
    wait_phase(page, "reading")
    page.wait_for_function("window.pearjs.arm.view.live !== null")
    other_read = page.evaluate("window.pearjs.arm.fingerprint") or []
    check.equal(f"{label}: one servo of the window's simulated arm is given another Homing_Offset behind the bus's back, and the window reads it when it connects again", [servo["homingOffset"] for servo in other_read], [-1470, 97, 1239, -1028, -233, 1269])
    check.ok(f"{label}: the control is offered on it", wait_offered(page), preflight_shown(page))
    before = preflight_pressed(page)
    report, gained = preflight_report(check, page, label, before, 2)
    check.numbers.setdefault("preflight", {})["another arm: the report"] = report
    guard = report.get("guard") or {}
    check.equal(
        f"{label}: the report stops at other-arm: nothing more was read, the line was given back, the guard refused nothing",
        {name: report.get(name, "absent") for name in ("stop", "servos", "settings", "singleReads", "timing", "isClosed", "lineErrors")} | {"refused": guard.get("refused")},
        {"stop": "other-arm", "servos": None, "settings": None, "singleReads": None, "timing": None, "isClosed": True, "lineErrors": 0, "refused": 0},
    )
    detail = str(report.get("detail", ""))
    check.ok(f"{label}: the Worker's own words name the difference: the servo, the register, what it read and what the window read", "servo 3 Homing_Offset: read 1238, expected 1239" in detail, detail)
    check.ok(f"{label}: up to the comparison the guard let through reads only", 0 < len(guard.get("passed") or {}) and set(guard.get("passed") or {}) <= {"PING", "READ", "SYNC READ"}, guard)
    shown = preflight_shown(page)
    outcome = preflight_sentences(shown).get("outcome") or {}
    check.equal(f"{label}: the page shows this report in place of the first, stopped at other-arm", [shown["isReportShown"], shown["stop"], shown["closed"], outcome.get("tone")], [True, "other-arm", "true", "error"])
    check.ok(f"{label}: the page says in a sentence that the Worker reached another arm, with the Worker's own words under it", str(outcome.get("text", "")).startswith("The servos the Worker read do not hold what this window read: the Worker reached another arm.") and outcome.get("detail") == detail, outcome)
    page.click("#language-zh")
    page.wait_for_function("!document.getElementById('station-preflight-parts').dataset.signature.startsWith('en')")
    outcome = preflight_sentences(preflight_shown(page)).get("outcome") or {}
    check.ok(f"{label}: the same sentence in Chinese", str(outcome.get("text", "")).startswith("Worker 讀到的伺服馬達，和這個視窗讀到的內容不一樣：Worker 接到的是另一隻手臂。") and outcome.get("detail") == detail, outcome)
    page.click("#language-en")
    check.ok(f"{label}: the window reads its arm again, and the log says so", "Station: the window reads the arm again, on the same port" in gained and phase(page) == "reading", gained[-3:])
    own.close()


def preflight_addresses(check: Check, browser, base: str) -> None:
    """Which arm is offered the control under which address: with ?preflight=sim a real arm is not, and without it
    the simulated arm is not."""
    label = "the gates"
    own = browser.new_context(viewport={"width": 1280, "height": 800}, locale="en-US")
    check.watch(own)
    own.add_init_script(scripted_port(USB_ADAPTER, SIX_CALIBRATED))
    page = open_page(check, own, base, "?lang=en&preflight=sim")
    page.click("#arm-connect")
    wait_phase(page, "reading")
    page.wait_for_function("window.pearjs.arm.view.live !== null && window.pearjs.arm.fingerprint !== null")
    page.wait_for_timeout(500)
    shown = preflight_shown(page)
    check.equal(f"{label}: with ?preflight=sim a real arm (a stand-in port, read as a calibrated arm of six servos) is not offered the control", [page.evaluate("window.pearjs.arm.view.isSimulated"), shown["isShown"], shown["isOffered"]], [False, False, False])
    check.equal(f"{label}: and the station's Enable is refused on it as on any real arm", enable_refused(page), [True, "station.why.realArm"])
    check.equal(f"{label}: no Worker runs for it", len(page.workers), 0)
    page.close()

    page = open_page(check, own, base)
    connect_sim(page)
    page.wait_for_function("window.pearjs.arm.view.live !== null && window.pearjs.arm.fingerprint !== null")
    page.wait_for_timeout(500)
    shown = preflight_shown(page)
    check.equal(f"{label}: without ?preflight=sim the simulated arm is not offered the control", [page.evaluate("window.pearjs.arm.view.isSimulated"), shown["isShown"], shown["isOffered"]], [True, False, False])
    try:
        page.wait_for_function("!document.getElementById('station-enable').disabled", timeout=10000)
    except WaitTimeout:
        pass
    check.equal(f"{label}: and the station's Enable is offered on it, as before", enable_refused(page), [False, "station.why.ready"])
    own.close()


def part_preflight(check: Check, browser, base: str, service: str) -> None:
    """The read-only hand-over of a real arm's serial line to the page's Worker and back (the request "preflight"):
    the real path as far as a headless browser goes, the whole of it on the simulated arm, the gates around it, and
    an arm that is not the one the window read."""
    preflight_real_path(check, browser, base)
    preflight_whole(check, browser, base, service)
    preflight_addresses(check, browser, base)
    ModelService.configure()


REAL_UNTRIED = "This step has so far run on simulated servos only and never on a real arm."
REAL_UNTRIED_CHINESE = "這個步驟到目前為止只在模擬的伺服馬達上執行過，還沒有在真實的手臂上執行過。"
REAL_REPORT = "Station: arming report "
REAL_READ_AGAIN = "Station: the window reads the arm again, on the same port"
REAL_BLOCKED = "Station: not enabled on the real arm: blocked"
# What the window asked the station's Worker, in its order: every request it posted, with what an answer to the
# arming report says, and the moment the Worker's arming report arrived; beside each the stand-in port's own
# record at that moment (null where the page has no stand-in port). Kept by a subclass of Worker the check puts
# into the page, so that it is the truth the page's log and its sentences are held against.
REAL_ASKED = """window.asked = [];
window.Worker = class extends Worker {
    constructor(...parts) {
        super(...parts);
        this.addEventListener('message', event => {
            if (event.data?.kind === 'event' && event.data.event?.type === 'arming') window.askedMoment({ type: 'arming report', id: event.data.event.requestId });
        });
    }
    postMessage(message, ...rest) {
        const request = message?.request;
        if (request && typeof request.type === 'string') {
            window.askedMoment({ type: request.type, id: message.id ?? null, isConfirmed: request.isConfirmed ?? null, requestId: request.requestId ?? null });
        }
        return super.postMessage(message, ...rest);
    }
};
window.askedMoment = entry => {
    const log = window.portLog ?? null;
    window.asked.push({ ...entry, opened: log === null ? null : log.opened.length, closed: log === null ? null : log.closed, written: log === null ? null : log.written.length });
};"""
# What the page shows of "Enable the station on this arm": the control, the part with its phase and its reasons
# against enabling, and the confirmation: its list (each item with its kind and tone), the tick box and the button.
REAL_SHOWN = """(() => {
    const visible = node => node !== null && node.getClientRects().length > 0;
    const run = document.getElementById('station-arming-run');
    const part = document.getElementById('station-arming');
    const tick = document.getElementById('station-arming-tick');
    const go = document.getElementById('station-arming-go');
    const list = tick === null ? null : tick.closest('label').parentElement.parentElement.querySelector('ul');
    return {
        isOffered: visible(run) && !run.disabled,
        isPartShown: visible(part), phase: part.dataset.phase, blockers: part.dataset.blockers, text: part.innerText,
        hasConfirm: visible(tick) && visible(go), isTicked: tick !== null && tick.checked,
        isGoDisabled: go === null ? null : go.disabled, go: go === null ? null : go.textContent,
        tick: tick === null ? null : tick.closest('label').textContent.trim(),
        items: list === null ? [] : [...list.children].map(item => ({ kind: item.dataset.kind, tone: item.dataset.tone, text: item.textContent })),
    };
})()"""
# A script of the page takes the button's disabling away, as far as a script can: the property no longer
# disables it and the attribute is gone, until REAL_BUTTON_AS_BUILT gives the property back.
REAL_BUTTON_FORCED = """(() => {
    const go = document.getElementById('station-arming-go');
    if (go === null) return;
    Object.defineProperty(go, 'disabled', { configurable: true, get: () => false, set: () => {} });
    go.removeAttribute('disabled');
})()"""
REAL_BUTTON_AS_BUILT = "(() => { const go = document.getElementById('station-arming-go'); if (go !== null) delete go.disabled; })()"


def real_page(check: Check, browser, base: str, query: str, scripts: tuple = ()) -> Page:
    """Opens the page in a context of its own that records what the window asks the station's Worker."""
    own = browser.new_context(viewport={"width": 1280, "height": 800}, locale="en-US")
    check.watch(own)
    for script in scripts:
        own.add_init_script(script)
    own.add_init_script(REAL_ASKED)
    return open_page(check, own, base, query)


def real_shown(page: Page) -> dict:
    return page.evaluate(REAL_SHOWN)


def real_asked(page: Page, kind: "str | None" = None) -> list:
    """Returns what the window asked the Worker so far, or only the entries of one type."""
    asked = page.evaluate("window.asked")
    return asked if kind is None else [entry for entry in asked if entry["type"] == kind]


def real_wait(page: Page, expression: str, timeout_ms: int = 20000) -> bool:
    """Waits until ``expression`` of JavaScript holds; returns whether it did in that time."""
    try:
        page.wait_for_function(expression, timeout=timeout_ms)
        return True
    except WaitTimeout:
        return False


def real_wait_station(page: Page, condition: str, timeout_ms: int = 20000) -> bool:
    """Waits as wait_station does; returns whether the condition held in that time."""
    try:
        wait_station(page, condition, timeout_ms)
        return True
    except WaitTimeout:
        return False


def real_wait_log(page: Page, words: str, timeout_ms: int = 45000) -> bool:
    """Waits until the page's log holds ``words``; returns whether it did in that time."""
    try:
        page.wait_for_function("words => document.getElementById('log-output').value.includes(words)", arg=words, timeout=timeout_ms)
        return True
    except WaitTimeout:
        return False


def real_input(action) -> bool:
    """Gives the page real input through Playwright; returns whether the element took it in time. An element that
    is gone or disabled is a finding of the check that follows, not the end of the part."""
    try:
        action()
        return True
    except WaitTimeout:
        return False


def real_offered(page: Page) -> bool:
    """Waits until "Enable the station on this arm" is shown and can be pressed; returns whether it is."""
    return real_wait(page, "(() => { const control = document.getElementById('station-arming-run'); return control.getClientRects().length > 0 && !control.disabled; })()", 10000)


def real_asking(page: Page) -> bool:
    """Waits until the confirmation is shown: the Worker has read the arm and waits for the operator's answer."""
    return real_wait(page, "document.getElementById('station-arming').dataset.phase === 'asking' && document.getElementById('station-arming-go') !== null", 45000)


def real_told(page: Page) -> dict:
    """Returns the last arming report in the page's log, {"report": ..., "blockers": ...}; {} when there is none."""
    found = [json_or_none(line[len(REAL_REPORT):]) for line in log_lines(page) if line.startswith(REAL_REPORT + "{")]
    return found[-1] if found and isinstance(found[-1], dict) else {}


def real_reads_only(guard: object) -> bool:
    """Returns whether a guard's counts hold packets, none of them a write, and no refusal."""
    passed = guard.get("passed") if isinstance(guard, dict) else None
    return isinstance(passed, dict) and len(passed) > 0 and all("WRITE" not in name.upper() for name in passed) and guard.get("refused") == 0


def real_in_order(lines: list, beginnings: list) -> list:
    """Returns the beginnings that the lines do not hold in this order: [] when each is found after the one before."""
    at = 0
    missing = []
    for beginning in beginnings:
        found = next((index for index in range(at, len(lines)) if lines[index].startswith(beginning)), None)
        if found is None:
            missing.append(beginning)
        else:
            at = found + 1
    return missing


def real_home_to_plan(page: Page) -> bool:
    """Presses Home and waits for its plan; returns whether the plan came."""
    page.click("#station-home")
    return real_wait_station(page, "view.plan !== null", 15000)


def real_station(check: Check, browser, base: str, service: str) -> None:
    """With ?preflight=sim-configured the Worker takes a simulated port whose servos hold PEAR's settings, as an arm
    that lerobot has run: a confirmation that is cancelled; then the whole session: the confirmation, the gates
    before the first write, Enable, Home without and with the camera, Stop on the way, Home, Disable."""
    numbers = check.numbers.setdefault("real", {})
    page = real_page(check, browser, base, "?lang=en&preflight=sim-configured")
    connect_sim(page)
    page.wait_for_function("window.pearjs.arm.view.live !== null")
    check.ok("the control: with ?preflight=sim-configured it is offered on the simulated arm", real_offered(page), real_shown(page))
    check.equal("the control: a model service with a key is checked, so that the page holds a key and an address", run_model_check(page, f"{service}/v1", MODEL, KEY), "ok")
    note = page.locator("#station-preflight").inner_text()
    check.ok("the control: its note says that nothing is written until the confirmation, and that this step has so far run on simulated servos only and never on a real arm", "Nothing is written to a servo until you have confirmed there." in note and REAL_UNTRIED in note, note[-500:])
    check.equal("the control: before it is pressed no Worker runs and the window has asked nothing", [len(page.workers), real_asked(page)], [0, []])
    # no camera runs from here until Home has been asked once without it
    camera_stop = page.locator("#camera-stop")
    if camera_stop.is_visible() and camera_stop.is_enabled():
        camera_stop.click()
    numbers["the camera before the control is pressed"] = page.locator("#camera-status").inner_text()

    # refused: the confirmation in both languages, then Cancel
    label = "cancelled"
    lines = len(log_lines(page))
    page.click("#station-arming-run")
    check.ok(f"{label}: the Worker's report comes and the confirmation is shown", real_asking(page), real_shown(page))
    english = real_shown(page)
    page.check("#station-arming-tick")
    real_wait(page, "document.getElementById('station-arming-go').disabled === false", 5000)
    ticked = real_shown(page)
    page.click("#language-zh")
    real_wait(page, "document.getElementById('station-arming-go')?.textContent !== 'Switch the torque on'", 5000)
    chinese = real_shown(page)
    check.equal("languages: a switch of the language builds the confirmation anew: what was ticked is unticked and the button is disabled", [ticked["isTicked"], ticked["isGoDisabled"], chinese["hasConfirm"], chinese["isTicked"], chinese["isGoDisabled"]], [True, False, True, False, True])
    check.equal("languages: the confirmation's list has the same items in Chinese", [item["kind"] for item in chinese["items"]], [item["kind"] for item in english["items"]])
    check.ok("languages: every sentence of the list, the tick box and the button are in Chinese: none is as in English, none is empty", len(chinese["items"]) > 0 and all(item["text"] and item["text"] != other["text"] for item, other in zip(chinese["items"], english["items"])) and chinese["tick"] not in ("", None, english["tick"]) and chinese["go"] not in ("", None, english["go"]), [chinese["tick"], chinese["go"]])
    check.equal("languages: the list says first, as a warning, in Chinese that this step has run on simulated servos only and never on a real arm", chinese["items"][:1], [{"kind": "untried", "tone": "warn", "text": REAL_UNTRIED_CHINESE}])
    numbers["the confirmation in Chinese"] = chinese["items"]
    page.click("#language-en")
    real_wait(page, "document.getElementById('station-arming-go')?.textContent === 'Switch the torque on'", 5000)
    page.click("#station-arming-cancel")
    check.ok(f"{label}: the request ends refused, and the log says that the operator cancelled", real_wait_log(page, "Station: not enabled on the real arm: refused (the operator cancelled"), log_lines(page)[-3:])
    check.ok(f"{label}: the window reads the arm again", real_wait_log(page, REAL_READ_AGAIN, 10000), log_lines(page)[-3:])
    gained = log_lines(page)[lines:]
    asked = real_asked(page)
    check.equal(f"{label}: the window asked the Worker to enable, got its report, and answered it once: not confirmed, naming that request", [[entry["type"], entry.get("isConfirmed")] for entry in asked] + [len(asked) == 3 and asked[2]["requestId"] == asked[0]["id"] == asked[1]["id"]], [["enableReal", None], ["arming report", None], ["arm", False], True])
    check.ok(f"{label}: the guard let through reads only and refused nothing", real_reads_only((real_told(page).get("report") or {}).get("guard")), (real_told(page).get("report") or {}).get("guard"))
    shown = real_shown(page)
    check.ok(f"{label}: the page says that the station was not enabled and nothing was written, and offers no confirmation any more", "Cancelled: the station was not enabled, and nothing was written to a servo." in shown["text"] and shown["hasConfirm"] is False, shown["text"][:300])
    check.ok(f"{label}: the log says that the operator cancelled", any(line.startswith("Station: the operator cancelled") for line in gained), gained)
    check.equal(f"{label}: the station is off, step 1 reads the arm, and the control is offered again", [station_view(page)["phase"], phase(page), real_offered(page)], ["off", "reading", True])

    # the confirmation, and the gates before the first write
    label = "the confirmation"
    lines = len(log_lines(page))
    cancelled = len(real_asked(page))
    page.click("#station-arming-run")
    check.ok(f"{label}: pressed again, the Worker's report comes and the confirmation is shown", real_asking(page), real_shown(page))
    told = real_told(page)
    report = told.get("report") or {}
    numbers["the arming report"] = told
    shown = real_shown(page)
    check.equal(f"{label}: the Worker read the arm to its end and tells no reason against enabling", [report.get("stop", "absent"), told.get("blockers"), shown["blockers"]], [None, [], ""])
    check.ok(f"{label}: until the press the report's guard has let through reads only and refused nothing", real_reads_only(report.get("guard")), report.get("guard"))
    check.equal(f"{label}: the box is unticked and \"Switch the torque on\" is disabled", [shown["hasConfirm"], shown["isTicked"], shown["isGoDisabled"], shown["go"]], [True, False, True, "Switch the torque on"])
    kinds = [item["kind"] for item in shown["items"]]
    check.equal(f"{label}: the list, in its order (the warnings' line only when the report has some)", [kind for kind in kinds if kind != "warnings"], ["untried", "limp", "rest", "eeprom", "ram", "factory", "home", "stop", "disable", "lost", "limit"])
    check.equal(f"{label}: the list says first, as a warning, that this step has so far run on simulated servos only and never on a real arm", shown["items"][:1], [{"kind": "untried", "tone": "warn", "text": REAL_UNTRIED}])
    texts = {item["kind"]: item["text"] for item in shown["items"]}
    reads = report.get("singleReads") or {}
    kept = [setting for setting in report.get("settings") or [] if setting.get("area") == "eeprom"]
    check.ok(f"{label}: the list has this line's numbers: the limp time measured just now and how many transactions it is the time of", f"about {round(reads.get('totalMs', -1))} ms on this line (the time of {reads.get('count')} transactions" in texts.get("limp", ""), [reads, texts.get("limp")])
    check.ok(f"{label}: the list says that no setting that survives a power cycle changes, with how many such registers this arm holds", len(kept) > 0 and f"the {len(kept)} such registers it writes hold its values on this arm already" in texts.get("eeprom", ""), [len(kept), texts.get("eeprom")])
    check.equal(f"{label}: the window has asked the Worker to enable and has got its report: no answer yet", [entry["type"] for entry in real_asked(page)[cancelled:]], ["enableReal", "arming report"])

    def unanswered(name: str) -> None:
        page.wait_for_timeout(400)
        check.equal(f"{label}: {name}: the window sends no answer and the confirmation still waits", [[entry["type"] for entry in real_asked(page)[cancelled:]], real_shown(page)["phase"], station_view(page)["phase"]], [["enableReal", "arming report"], "asking", "enabling"])

    page.evaluate("document.getElementById('station-arming-go')?.click()")
    unanswered("a script's click on the disabled button")
    page.evaluate(REAL_BUTTON_FORCED)
    check.ok(f"{label}: a script takes the button's disabling away, and the button is pressed with real input while the box is unticked", real_input(lambda: page.click("#station-arming-go", timeout=5000)))
    unanswered("a real press without the tick")
    page.evaluate(REAL_BUTTON_AS_BUILT)
    check.ok(f"{label}: the page disables the button again", real_wait(page, "document.getElementById('station-arming-go')?.disabled === true", 5000))
    page.evaluate("(() => { const tick = document.getElementById('station-arming-tick'); if (tick === null) return; tick.checked = true; tick.dispatchEvent(new Event('change', { bubbles: true })); })()")
    page.wait_for_timeout(300)
    scripted = real_shown(page)
    check.equal(f"{label}: a tick that a script sets does not count: the box is unticked again and the button stays disabled", [scripted["isTicked"], scripted["isGoDisabled"]], [False, True])
    check.ok(f"{label}: ticked with real input, the button can be pressed", real_input(lambda: page.check("#station-arming-tick", timeout=5000)) and real_wait(page, "document.getElementById('station-arming-go')?.disabled === false", 5000), real_shown(page))
    page.evaluate("document.getElementById('station-arming-go')?.click()")
    unanswered("a script's click on the button with the box ticked")
    check.ok(f"{label}: the button is pressed with real input", real_input(lambda: page.click("#station-arming-go", timeout=5000)), real_shown(page))

    # enabled
    label = "enabled"
    check.ok(f"{label}: after the tick and a real press the station holds the arm", real_wait_station(page, "view.phase === 'on' && view.status !== null && view.status.robot === 'READY' && view.status.line !== null", 45000), station_view(page)["phase"])
    answers = real_asked(page, "arm")
    enables = real_asked(page, "enableReal")
    check.equal(f"{label}: the window answered that report once: confirmed, naming the request it answers", [[entry["isConfirmed"], entry["requestId"]] for entry in answers[1:]], [[True, enables[-1]["id"]]])
    view = station_view(page)
    status = view["status"] or {}
    line = status.get("line") or {}
    numbers["the line when enabled"] = line
    check.equal(f"{label}: the Worker's status says a real arm, ready and holding", [status.get("arm"), status.get("robot"), status.get("control")], ["real", "READY", "HOLD"])
    status_line = page.locator("#station-status").inner_text()
    check.ok(f"{label}: the status line says that the station holds the real arm, torque on", status_line.startswith("The station holds the real arm, torque on: robot READY, control loop HOLD."), status_line)
    check.ok(f"{label}: step 1 says that the station holds the real arm and that it reads here again after Disable", "The station holds the real arm." in page.locator("#arm-status").inner_text(), page.locator("#arm-status").inner_text())
    passed = line.get("passed") or {}
    check.ok(f"{label}: the line's counts hold the writes of PEAR's enable: WRITE 40, WRITE 55, SYNC WRITE 42 and the settings", all(passed.get(name, 0) > 0 for name in ("WRITE 40", "WRITE 55", "SYNC WRITE 42")) and len([name for name in passed if name.startswith("WRITE ")]) > 3, passed)
    check.equal(f"{label}: the guard refused nothing, the line reported no error and is not lost", [line.get("refused"), line.get("lineErrors"), line.get("isLost")], [0, 0, False])
    check.ok(f"{label}: the page's line about the arm's line says the same", "it refused 0" in page.locator("#station-line").inner_text(), page.locator("#station-line").inner_text())
    real_note = page.locator("#station-real-note").inner_text()
    check.equal(f"{label}: no single actions are offered, and the note says what a real arm is offered", [page.locator("#station-jog-part").is_visible(), "On a real arm this version offers Home, Stop and Disable. Single actions are not offered, and no model is asked while a real arm is enabled." in real_note], [False, True])
    check.equal(f"{label}: \"Ask the model once\" is not offered", page.locator("#ask-once").is_disabled(), True)
    numbers["why no model is asked"] = page.locator("#ask-missing").inner_text()
    check.equal(f"{label}: the hand-over check and \"Enable the station on this arm\" are not offered, the simulated Enable is not shown, and Home, Stop and Disable are", [page.locator("#station-preflight-run").is_visible() and page.locator("#station-preflight-run").is_enabled(), real_shown(page)["isOffered"], page.locator("#station-enable").is_visible(), page.locator("#station-home").is_enabled(), page.locator("#task-stop").is_enabled(), page.locator("#station-disable").is_enabled()], [False, False, False, True, True, True])
    page.click("#language-zh")
    real_wait(page, "!document.getElementById('station-status').textContent.startsWith('The station')", 5000)
    numbers["the real arm's panel in Chinese"] = [page.locator(f"#{name}").inner_text() for name in ("station-status", "station-real-note", "station-line")]
    check.ok("languages: the real arm's status, its note and its line's counts are in Chinese", "Home 需要先在步驟 2 啟動攝影機" in page.locator("#station-real-note").inner_text() and not any(words in page.locator(f"#{name}").inner_text() for name in ("station-status", "station-real-note", "station-line") for words in ("The station", "On a real arm", "The arm's line")), numbers["the real arm's panel in Chinese"])
    page.click("#language-en")
    real_wait(page, "document.getElementById('station-status').textContent.startsWith('The station')", 5000)

    # Home needs the wrist camera's frames: without the camera of step 2 it does not run, and the page says so
    label = "Home without the camera"
    check.ok(f"{label}: before the press the real arm's note says that Home needs the camera of step 2 started", "Home needs the camera of step 2 started" in real_note, real_note)
    camera_line = page.locator("#station-camera").inner_text()
    check.ok(f"{label}: and the camera's line says that no frames arrive because the camera in step 2 does not run, and to start it", "no frames arrive, because the camera in step 2 does not run" in camera_line and "start the camera in step 2" in camera_line, camera_line)
    page.click("#station-home")
    real_wait_station(page, "view.action === null && view.outcome !== null", 20000)
    outcome = station_view(page)["outcome"] or {"key": None, "values": {}}
    check.ok(f"{label}: Home does not run, with PEAR's words", outcome["key"] == "station.action.failed" and "Camera unavailable" in str(outcome["values"].get("error")), outcome)
    advice = page.locator("#station-report-camera")
    advice_text = advice.inner_text() if advice.is_visible() else ""
    check.ok(f"{label}: with the failure the page says that there was no fresh frame of the wrist camera and to start the camera in step 2", "it had no fresh frame of the wrist camera" in advice_text and "If the camera in step 2 does not run, start it" in advice_text, advice_text)
    check.equal(f"{label}: the station still holds the arm", [station_view(page)["phase"], station_view(page)["status"]["robot"]], ["on", "READY"])

    # with the camera's test picture: Home, the plan, approve, Stop on the way, Home to its end
    label = "Home"
    page.click("#camera-start")
    check.ok(f"{label}: with the camera's test picture started the station gets its frames", real_wait_station(page, "view.status.camera != null && view.status.camera.isRunning === true && view.status.camera.perSecond >= 5", 20000), station_view(page)["status"].get("camera"))
    start = station_view(page)["status"]["joints"]
    check.ok(f"{label}: pressed, it shows its plan and waits", real_home_to_plan(page) and page.locator("#station-plan").is_visible(), station_view(page)["plan"])
    page.wait_for_timeout(500)
    check.equal(f"{label}: nothing moves before the plan is approved", station_view(page)["status"]["joints"], start)
    page.click("#station-approve")
    check.ok(f"{label}: approved, the arm moves", real_wait_station(page, "view.status.control !== 'HOLD'", 15000), station_view(page)["status"].get("control"))
    page.wait_for_timeout(600)
    page.click("#task-stop")
    real_wait_station(page, "view.action === null && view.outcome !== null", 15000)
    real_wait_station(page, "view.status.robot === 'READY' && view.status.control === 'HOLD'", 15000)
    view = station_view(page)
    stopped = view["status"]
    check.equal("Stop on the way: Home is ended by Stop, and the station still holds the real arm, ready and holding", [(view["outcome"] or {}).get("key"), view["phase"], stopped.get("arm"), stopped.get("robot"), stopped.get("control")], ["station.action.homeStopped", "on", "real", "READY", "HOLD"])
    check.ok("Stop on the way: the status line says that the torque is on", "torque on" in page.locator("#station-status").inner_text(), page.locator("#station-status").inner_text())
    session = log_lines(page)[lines:]
    check.ok("Stop on the way: Stop was pressed while Home moved the arm: the log holds Home's phase homing before Stop, and Home ended by it", real_in_order(session, ["Station: Home plan approved", "Station: phase homing", "Station: Stop", "Station: Home ended by Stop"]) == [] and not any(line.startswith("Station: Home done") for line in session), session[-6:])
    page.wait_for_timeout(700)
    check.equal("Stop on the way: after the brake the arm stands still", station_view(page)["status"]["joints"], stopped["joints"])
    # the Worker's simulated arm stands at Home's pose when it is enabled, so this Home has almost no way to go
    numbers["Stop on the way: the largest travel of a joint since the plan, in radians"] = max(abs(now - before) for now, before in zip(stopped["joints"], start))
    check.ok(f"{label}: pressed again, it shows its plan again", real_home_to_plan(page), station_view(page)["plan"])
    page.click("#station-approve")
    real_wait_station(page, "view.action === null && view.outcome !== null", 60000)
    view = station_view(page)
    check.equal(f"{label}: approved, it runs to its end, and the station holds the arm at Home", [(view["outcome"] or {}).get("key"), view["phase"], view["status"].get("robot")], ["station.action.homed", "on", "READY"])
    numbers["Home's result"] = page.locator("#station-home-results").inner_text()[:600]

    # Disable behind a second press
    label = "Disable"
    real_wait_station(page, "view.status.control === 'HOLD'", 10000)
    last = station_view(page)["status"].get("line") or {}
    numbers["the line before Disable"] = last
    check.equal("the whole session: the guard refused nothing, and the line reported no error and was not lost", [last.get("refused"), last.get("lineErrors"), last.get("isLost")], [0, 0, False])
    page.click("#station-disable")
    page.wait_for_timeout(500)
    confirm = page.locator("#station-disable-confirm")
    confirm_text = confirm.inner_text() if confirm.is_visible() else ""
    check.equal(f"{label}: the first press only asks: the page says that the arm will go limp and to hold it, the station still holds the arm, and the Worker was not asked to disable", ["The arm will go limp: hold it" in confirm_text, station_view(page)["phase"], (station_view(page)["status"] or {}).get("robot"), real_asked(page, "disable")], [True, "on", "READY", []])
    check.ok(f"{label}: the button of the second press is offered and pressed", real_input(lambda: page.click("#station-disable-go", timeout=5000)), confirm_text)
    check.ok(f"{label}: the second press disables", real_wait_station(page, "view.phase === 'off'", 30000), station_view(page)["phase"])
    check.equal(f"{label}: the Worker was asked to disable once", len(real_asked(page, "disable")), 1)
    check.ok(f"{label}: the Worker gives the line back and the window reads the arm again", real_wait_log(page, REAL_READ_AGAIN + "", 10000) and log_lines(page)[lines:].count(REAL_READ_AGAIN) == 1, log_lines(page)[-3:])
    wait_phase(page, "reading", 10000)
    check.equal(f"{label}: step 1 reads the arm, and the control is offered again", [phase(page), real_offered(page)], ["reading", True])
    gained = log_lines(page)[lines:]
    missing = real_in_order(gained, [
        "Station: enabling on the real arm asked, source simulated-configured; the window closed its session",
        REAL_REPORT + "{",
        "Station: the operator ticked the box and pressed: switch the torque on",
        "Station: enabled on the real arm; the robot opened in ",
        "Station: Home asked",
        "Station: Home did not run: ",
        "Station: Home asked",
        "Station: Home plan approved",
        "Station: Stop",
        "Station: Home ended by Stop",
        "Station: Home asked",
        "Station: Home plan approved",
        "Station: Home done: ",
        "Station: disabled on the real arm; the Worker closed the line",
        REAL_READ_AGAIN,
    ])
    check.equal("the log: it holds each step's line, in the order of the session", missing, [])
    address = service.split("//")[-1]
    check.equal("the log: the session's lines hold no key and no address, and none says that the guard refused a packet", [line[:120] for line in gained if KEY in line or address in line or "the guard refused" in line or "the guard has refused" in line], [])
    numbers["the session's log"] = [line[:160] for line in gained if not line.startswith(REAL_REPORT)]


def real_blocked(check: Check, browser, base: str) -> None:
    """With ?preflight=sim the Worker's simulated servos hold their own settings, as an arm lerobot never ran:
    PEAR's enable would change settings that survive a power cycle, so nothing is offered and nothing written."""
    label = "blocked"
    page = real_page(check, browser, base, "?lang=en&preflight=sim")
    connect_sim(page)
    page.wait_for_function("window.pearjs.arm.view.live !== null")
    check.ok(f"{label}: with ?preflight=sim the control is offered on the simulated arm", real_offered(page), real_shown(page))
    lines = len(log_lines(page))
    page.click("#station-arming-run")
    check.ok(f"{label}: the request ends blocked, and the log says for which reason and that nothing was written", real_wait_log(page, REAL_BLOCKED + " (settings); nothing was written"), log_lines(page)[-3:])
    check.ok(f"{label}: the window reads the arm again", real_wait_log(page, REAL_READ_AGAIN, 10000), log_lines(page)[-3:])
    told = real_told(page)
    report = told.get("report") or {}
    blockers = told.get("blockers") or []
    rows = (blockers[0].get("rows") or []) if blockers else []
    check.numbers.setdefault("real", {})["blocked: the reasons"] = blockers
    check.ok(f"{label}: the Worker tells one reason, settings, with the rows PEAR's enable would change: registers that survive a power cycle and hold another value", len(blockers) == 1 and blockers[0].get("code") == "settings" and len(rows) > 0 and all(row.get("area") == "eeprom" and row.get("held") != row.get("pear") for row in rows), blockers)
    check.ok(f"{label}: the guard let through reads only and refused nothing", real_reads_only(report.get("guard")), report.get("guard"))
    check.equal(f"{label}: the window asked the Worker to enable, got its report, and sent no answer", [entry["type"] for entry in real_asked(page)], ["enableReal", "arming report"])
    shown = real_shown(page)
    check.equal(f"{label}: the page shows the reason and offers no confirmation", [shown["isPartShown"], shown["blockers"], shown["hasConfirm"]], [True, "settings", False])
    check.ok(f"{label}: the page says in sentences that nothing was written, which settings would change and how many, and what to do", all(words in shown["text"] for words in ("The station was not enabled on this arm, and nothing was written to a servo", f"PEAR's enable would change settings that survive a power cycle ({len(rows)}): ", "Run the arm with lerobot, then try again.")), shown["text"][:700])
    check.ok(f"{label}: the report under it says that the Worker does not hold the line any more", "The Worker does not hold the arm's line any more, so the window can read the arm again." in shown["text"], shown["text"][-600:])
    page.click("#language-zh")
    real_wait(page, "!document.getElementById('station-arming').innerText.includes('The station was not enabled')", 5000)
    chinese = real_shown(page)["text"]
    check.numbers["real"]["blocked: the page in Chinese"] = chinese[:500]
    check.ok("languages: the reason and its sentences are in Chinese", "lerobot" in chinese and not any(words in chinese for words in ("The station was not enabled", "PEAR's enable would change", "Run the arm")), chinese[:400])
    page.click("#language-en")
    check.equal(f"{label}: the station is off, step 1 reads the arm, and the control is offered again", [station_view(page)["phase"], phase(page), real_offered(page)], ["off", "reading", True])


def real_real_path(check: Check, browser, base: str) -> None:
    """Without ?preflight=..., on a stand-in of a browser's port that answers as a calibrated arm of six servos: the
    control is offered and the request runs as on a real arm, up to where a headless browser ends it. The Worker's
    own getPorts() gives no port (the stand-in lives in the window), so the request ends blocked at "no-port"; the
    port's own record tells what the window did around it."""
    label = "the real path"
    page = real_page(check, browser, base, "?lang=en", (scripted_port(USB_ADAPTER, SIX_CALIBRATED),))
    page.click("#arm-connect")
    wait_phase(page, "reading")
    page.wait_for_function("window.pearjs.arm.view.live !== null")
    check.ok(f"{label}: on a port that is read as a calibrated arm of six servos, not the simulated one, the control is offered", real_offered(page) and page.evaluate("window.pearjs.arm.view.isSimulated") is False, real_shown(page))
    port_log = page.evaluate("window.portLog")
    check.equal(f"{label}: before it is pressed the window has opened the port once, at the servos' baud rate, and not closed it, and no Worker runs", [[entry["baudRate"] for entry in port_log["opened"]], port_log["closed"], len(page.workers)], [[1000000], 0, 0])
    lines = len(log_lines(page))
    page.click("#station-arming-run")
    check.ok(f"{label}: the request ends blocked, and the log says at the stop and that nothing was written", real_wait_log(page, REAL_BLOCKED + " (stop); nothing was written"), log_lines(page)[-3:])
    check.ok(f"{label}: the log says that the window reads the arm again, on the same port", real_wait_log(page, REAL_READ_AGAIN, 10000), log_lines(page)[-3:])
    gained = log_lines(page)[lines:]
    told = real_told(page)
    report = told.get("report") or {}
    check.numbers.setdefault("real", {})["the real path: the arming report"] = told
    check.equal(
        f"{label}: the Worker's own getPorts() gave no port: the report stops at no-port, nothing was read, the guard was given no packet and no line is held",
        {name: report.get(name, "absent") for name in ("stop", "ports", "servos", "settings", "guard", "isClosed")},
        {"stop": "no-port", "ports": [], "servos": None, "settings": None, "guard": {"passed": {}, "refused": 0}, "isClosed": True},
    )
    check.equal(f"{label}: the Worker tells one reason against enabling: the stop no-port", told.get("blockers"), [{"code": "stop", "stop": "no-port"}])
    check.ok(f"{label}: the log says what the Worker was asked: a granted port, and that the window closed its session", any(line.startswith("Station: enabling on the real arm asked, source granted; the window closed its session") for line in gained), gained[:2])
    shown = real_shown(page)
    check.equal(f"{label}: the page shows the reason and offers no confirmation", [shown["isPartShown"], shown["blockers"], shown["hasConfirm"]], [True, "stop", False])
    check.ok(f"{label}: the page says in sentences that nothing was written, that the Worker did not read the arm to its end, and that it was given no port of this adapter", all(words in shown["text"] for words in ("The station was not enabled on this arm, and nothing was written to a servo", "The Worker did not read the arm to its end.", "The Worker was given no port of this adapter")), shown["text"][:700])
    asked = real_asked(page)
    check.equal(f"{label}: the window asked the Worker to enable, got its report, and sent no answer", [entry["type"] for entry in asked], ["enableReal", "arming report"])
    check.equal(
        f"{label}: by the port's own record the window had closed the port when the request went to the Worker and had not opened it again when the report came, and nothing was written in between",
        [[entry["opened"], entry["closed"]] for entry in asked] + [len(asked) == 2 and asked[1]["written"] - asked[0]["written"]],
        [[1, 1], [1, 1], 0],
    )
    written = len(page.evaluate("window.portLog")["written"])
    again = wait_read_again(page, "window.portLog.written.length", written)
    port_log = page.evaluate("window.portLog")
    check.equal(f"{label}: after it the window opened the same port again, at the servos' baud rate, and it is not closed again", [[entry["baudRate"] for entry in port_log["opened"]], port_log["closed"]], [[1000000, 1000000], 1])
    check.ok(f"{label}: the window reads the arm again: the port is given packets after the report", len(asked) == 2 and again > written >= asked[1]["written"], [asked[-1], written, again])
    check.ok(f"{label}: every packet the port was ever given is a PING, a READ or a SYNC READ", set(reads_only(port_log)) <= {1, 2, 0x82} and len(port_log["written"]) > 0, reads_only(port_log))
    check.equal(f"{label}: the station is off, step 1 reads the arm, the window's guard refused nothing, and the control is offered again", [station_view(page)["phase"], phase(page), page.locator("#guard-line").get_attribute("data-refused"), real_offered(page)], ["off", "reading", "0", True])


def part_real(check: Check, browser, base: str, service: str) -> None:
    """The station on a real arm (the requests "enableReal" and "arm"): the page asks for the first write only
    after the tick and a real press; Enable, Home, Stop and Disable on the Worker's simulated port that holds
    PEAR's settings; an arm whose settings PEAR's enable would change; and the real path as far as a headless
    browser goes. Every way out ends with the arm's line given back and the window reading again."""
    real_station(check, browser, base, service)
    real_blocked(check, browser, base)
    real_real_path(check, browser, base)
    ModelService.configure()


PARTS = [
    "load", "stamp", "sim", "expected", "guard", "cable", "faults", "calibration", "serial", "diagnostics", "camera",
    "model", "privacy", "ask", "languages", "keyboard", "layout", "folder", "subpath", "hosted", "insecure", "log",
    "transport", "timing", "selftest", "station", "preflight", "real",
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dist", default=str(REPOSITORY / "dist-web"), help="the built page (npm run build:web)")
    parser.add_argument("--out", default=None, help="where screenshots and report.json go; not in the repository")
    parser.add_argument("--node", default="node", help="the Node that runs web/tests/run_node.mjs")
    parser.add_argument(
        "--build",
        default=(os.environ.get("GITHUB_SHA") or "").strip()[:7] or "dev",
        help="what the page must say it was built as: the first 7 characters of the GITHUB_SHA the build ran with; "
        "by default those of this environment's GITHUB_SHA, and 'dev' without one, as the build does",
    )
    parser.add_argument("--only", nargs="*", default=None, help="the parts to run; all by default")
    parser.add_argument("--list", action="store_true", help="list the parts and exit")
    arguments = parser.parse_args()
    if arguments.list:
        print(" ".join(PARTS))
        return 0

    dist = Path(arguments.dist).resolve()
    if not (dist / "index.html").exists():
        print(f"No built page at {dist}: run `npm run build:web` first")
        return 2
    wanted = arguments.only or PARTS
    unknown = [part for part in wanted if part not in PARTS]
    if unknown:
        print(f"Unknown parts: {unknown}; known: {PARTS}")
        return 2

    check = Check(arguments)
    pages, base = serve(functools.partial(Quiet, directory=str(dist)))
    models, service = serve(ModelService)
    # a port nothing listens on: one the system just gave out and took back
    spare, _ = serve(Quiet)
    closed_port = spare.server_address[1]
    spare.shutdown()
    spare.server_close()
    started = time.monotonic()

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, args=CHROMIUM_ARGUMENTS)
            context = browser.new_context(viewport={"width": 1280, "height": 800}, locale="en-US")
            check.watch(context)

            def run(part: str, body) -> None:
                if part not in wanted:
                    return
                check.part = part
                before = len(check.results)
                began = time.monotonic()
                try:
                    body()
                except Exception as error:  # a part that cannot go on is a failure, and the others still run
                    check.ok("the part ran to its end", False, f"{type(error).__name__}: {error}")
                failed = sum(1 for result in check.results[before:] if not result["passed"])
                print(f"{part}: {len(check.results) - before} checks, {failed} failed, {time.monotonic() - began:.1f} s", flush=True)

            run("load", lambda: part_load(check, context, base))
            run("stamp", lambda: part_stamp(check, context, base))
            run("sim", lambda: part_sim(check, context, base))
            run("expected", lambda: part_expected(check, context, base))
            run("guard", lambda: part_guard(check, context, base))
            run("cable", lambda: part_cable(check, context, base))
            run("faults", lambda: part_faults(check, context, base))
            run("calibration", lambda: part_calibration(check, context, base))
            run("serial", lambda: part_serial(check, browser, base))
            run("diagnostics", lambda: part_diagnostics(check, browser, context, base))
            run("camera", lambda: (part_camera(check, context, base), part_camera_failures(check, playwright, browser, base)))
            run("model", lambda: part_model(check, context, base, service, closed_port))
            if "model" in wanted:
                run("privacy", lambda: part_privacy(check, context, service))
            run("ask", lambda: part_ask(check, browser, base, service))
            run("languages", lambda: part_languages(check, browser, base, service))
            run("keyboard", lambda: part_keyboard(check, context, base))
            run("layout", lambda: part_layout(check, browser, base, service))
            run("folder", lambda: part_folder(check, browser, dist, service))
            run("subpath", lambda: part_subpath(check, browser, dist))
            run("hosted", lambda: part_hosted(check, browser, dist, service))
            run("insecure", lambda: part_insecure(check, playwright, base))
            run("log", lambda: part_log(check, browser, base))
            run("transport", lambda: part_transport(check))
            run("timing", lambda: part_timing(check, context, base))
            run("selftest", lambda: part_selftest(check, browser))
            run("station", lambda: part_station(check, browser, context, base, dist))
            run("preflight", lambda: part_preflight(check, browser, base, service))
            run("real", lambda: part_real(check, browser, base, service))

            check.part = "whole run"
            check.equal("no uncaught error in any page", check.page_errors, [])
            check.equal("no console error of the page's own", check.console_errors, [])
            check.equal("no request left this machine", check.foreign_requests, [])
            # a request the browser refused, or gave to the proxy that does not exist, went nowhere (part hosted)
            sent = [entry for entry in check.requests if "unsent" not in entry]
            hosts = sorted({urlsplit(entry["url"]).hostname or urlsplit(entry["url"]).scheme for entry in sent})
            check.ok("every request that was sent went to 127.0.0.1 or was no network request", set(hosts) <= {"127.0.0.1", "file", "blob", "data", "pearjs.test"}, hosts)
            check.ok("requests were recorded", len(check.requests) > 0, len(check.requests))
            check.numbers["requests the browser did not send"] = len(check.requests) - len(sent)
            context.close()
            browser.close()
    finally:
        pages.shutdown()
        pages.server_close()
        models.shutdown()
        models.server_close()

    failed = [result for result in check.results if not result["passed"]]
    by_part: dict[str, list[int]] = {}
    for result in check.results:
        counts = by_part.setdefault(result["part"], [0, 0])
        counts[0] += 1
        counts[1] += 0 if result["passed"] else 1
    report = {
        "parts": {part: {"checks": counts[0], "failed": counts[1]} for part, counts in by_part.items()},
        "checks": len(check.results),
        "failed": len(failed),
        "failures": failed,
        "requests": len(check.requests),
        "request_hosts": sorted({urlsplit(entry["url"]).netloc or urlsplit(entry["url"]).scheme for entry in check.requests}),
        "browser_reports_of_failed_requests": len(check.expected_console),
        "numbers": check.numbers,
        "chromium_arguments": CHROMIUM_ARGUMENTS,
        "seconds": round(time.monotonic() - started, 1),
    }
    (check.out / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"{len(check.results)} checks, {len(failed)} failed, {len(check.requests)} requests recorded, {report['seconds']} s")
    print(f"report: {check.out / 'report.json'}")
    return 0 if not failed and check.results else 1


if __name__ == "__main__":
    sys.exit(main())
