"""Checks the built page (dist-web/) in a real headless Chromium, on the simulated arm.

Needs Python 3.10 or newer with Playwright and its Chromium, and Node with the repository's node_modules (for the
expected values, which the library computes in Node). It does not build the page: run `npm run build:web` first.
The part "selftest" builds its own page, web/selftest.html, into dist-web/ (web/vite.selftest.config.ts).

    python web/tests/browser_check.py [--dist DIR] [--out DIR] [--node NODE] [--build STAMP] [--only PART ...] [--list]

It serves dist-web/ and a stand-in model service on 127.0.0.1 (ports the system picks), opens the page, and
exits with 0 only if every check passed. Screenshots and report.json go to --out (a temporary directory by
default; never a directory of the repository).

Parts: load, stamp, sim, expected, guard, cable, faults, calibration, serial, diagnostics, camera, model,
privacy, languages, keyboard, layout, folder, subpath, hosted, insecure, log, transport, timing, selftest.
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

from playwright.sync_api import BrowserContext, Page, sync_playwright

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

    def _record(self) -> None:
        type(self).seen.append(
            {"method": self.command, "path": self.path, "headers": {name.lower(): value for name, value in self.headers.items()}}
        )

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

    @classmethod
    def configure(cls, **settings) -> None:
        defaults = {
            "allowed_origins": ["*"],
            "keys": [],
            "refusal_has_cors": False,
            "models": [MODEL],
            "delay_s": 0.0,
            "is_other_service": False,
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
    check.ok("the notice says it cannot move the arm", "cannot move the arm" in page.locator("#notice").inner_text())
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
    check.ok("the instruction is disabled", page.locator("#task-instruction").is_disabled())
    check.ok("the task says this version cannot move the arm", "cannot move the arm" in page.locator("#task").inner_text())
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
    check.ok("the notice says unofficial, experimental, cannot move", all(word in page.locator("#notice").inner_text() for word in ("非官方", "實驗", "不會讓手臂動")))
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


PARTS = [
    "load", "stamp", "sim", "expected", "guard", "cable", "faults", "calibration", "serial", "diagnostics", "camera",
    "model", "privacy", "languages", "keyboard", "layout", "folder", "subpath", "hosted", "insecure", "log",
    "transport", "timing", "selftest",
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
