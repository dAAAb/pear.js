// The page: it joins the arm, the camera and the model check to the markup of index.html, in two languages.
// What it shows of the arm, the camera's frame and the model service comes from arm.ts, camera.ts and model.ts,
// which call the library; this file only renders it.

import { type SerialPortLike } from "../../src/feetech/index";
import { JOINTS, MOTORS, type MotorName, servoFaults } from "../../src/so101/hardware/index";
import { SO101Kinematics } from "../../src/so101/kinematics/index";
import { type ArmFailure, ArmSession, type BoundsMark } from "./arm";
import {
  CameraSession,
  DEFAULT_CAMERA_ID,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  frameOf,
  TEST_PICTURE_ID,
  TestPicture,
} from "./camera";
import { applyStaticTexts, count, initialLanguage, language, listed, onLanguageChange, setLanguage, t } from "./i18n";
import { PageLog, redact } from "./log";
import { checkModel, type ModelCheck } from "./model";
import { type GuardSelfTest, guardSelfTest } from "./readonly";
import { SIM_CALIBRATION, SIM_SCENARIOS, SimArm, type SimScenario } from "./sim_port";
import type { TextKey } from "./texts";
import { formatStats, measureTiming, READS, TIMER_PERIOD_MS, TIMER_PERIODS, type TimingReport } from "./timing";

/** What this build of the page is: the first 7 characters of the commit a GitHub Actions job built it from, or
 * "dev" for a build made anywhere else (web/vite.config.ts). */
declare const __PEARJS_BUILD__: string;
/** The commit of PEAR the library ports (PEAR_COMMIT of src/index.ts, given by the build). */
declare const __PEAR_COMMIT__: string;

type Tone = "error" | "warn" | "ok" | "info";
/** A part of a message box: a paragraph, a list, or a detail in the machine's own words. */
type Part = string | string[] | { detail: string };

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`The page has no element #${id}`);

  return element as T;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  properties: { className?: string; text?: string; data?: Record<string, string | number> } = {},
  children: readonly Node[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (properties.className !== undefined) node.className = properties.className;
  if (properties.text !== undefined) node.textContent = properties.text;
  for (const [name, value] of Object.entries(properties.data ?? {})) node.dataset[name] = String(value);
  node.append(...children);

  return node;
}

/** Returns a message box: a title, then paragraphs, lists and details. ``kind`` names it for whoever looks for
 * one message among the page's. */
function box(tone: Tone, kind: string, title: string | null, parts: readonly Part[]): HTMLElement {
  const node = element("div", { className: `box ${tone}`, data: { kind } });
  if (title !== null) node.append(element("h4", { text: title }));
  for (const part of parts) {
    if (typeof part === "string") node.append(element("p", { text: part }));
    else if (Array.isArray(part)) {
      node.append(
        element(
          "ul",
          {},
          part.map((item) => element("li", { text: item })),
        ),
      );
    } else node.append(element("p", { className: "detail", text: (part as { detail: string }).detail }));
  }

  return node;
}

/** Replaces what ``container`` holds when what it shows has changed, told by ``signature``. */
function renderOnce(container: HTMLElement, signature: string, build: () => Node[]): void {
  const stamped = `${language()}|${signature}`;
  if (container.dataset.signature === stamped) return;
  container.dataset.signature = stamped;
  container.replaceChildren(...build());
}

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function row(cells: readonly Node[], data: Record<string, string | number> = {}): HTMLTableRowElement {
  return element("tr", { data }, cells);
}

function headRow(keys: readonly TextKey[], numeric: readonly TextKey[] = []): HTMLTableSectionElement {
  return element("thead", {}, [
    row(
      keys.map((key) => {
        const cell = element("th", { text: t(key), className: numeric.includes(key) ? "number" : "" });
        cell.scope = "col";
        return cell;
      }),
    ),
  ]);
}

function cell(text: string, className = "", data: Record<string, string | number> = {}): HTMLTableCellElement {
  return element("td", { text, className, data });
}

/** How long the page goes on saying that the line reported an error, ms. */
const LINE_ERROR_SHOWN_MS = 5000;
const DASH = "—"; // U+2014, where a cell has nothing to show
const MINUS = "−"; // U+2212, the minus sign of a number, which a hyphen is not

/** Returns ``value`` with ``decimals`` places and a true minus sign. */
function fixed(value: number, decimals: number): string {
  return value.toFixed(decimals).replace("-", MINUS);
}

const log = new PageLog(byId<HTMLTextAreaElement>("log-output"));
const arm = new ArmSession({ onChange: () => renderArm(), log: (message) => log.add(message) });
const camera = new CameraSession(byId<HTMLVideoElement>("camera-video"), {
  onChange: () => renderCamera(),
  log: (message) => log.add(message),
});

/** What kept the page from asking for a port, when something did. */
let pageProblem: { kind: "insecure" | "noSerial" | "noPort" | "request"; detail?: string } | null = null;
let sim: SimArm | null = null;
let selfTest: GuardSelfTest | null = null;
/** Why the file last chosen is no calibration; null when it is one or none was chosen. */
let fileProblem: string | null = null;
let modelCheck: ModelCheck | "checking" | null = null;
let timingState: { kind: "idle" | "needsArm" | "done" } | { kind: "running"; step: string } = { kind: "idle" };

interface SerialLike {
  requestPort(): Promise<SerialPortLike>;
}

function webSerial(): SerialLike | null {
  return (navigator as Navigator & { serial?: SerialLike }).serial ?? null;
}

// ---------------------------------------------------------------- the arm

const PHASE_STATUS: Record<string, TextKey> = {
  idle: "arm.status.idle",
  opening: "arm.status.opening",
  handshake: "arm.status.handshake",
  probing: "arm.status.probing",
  registers: "arm.status.registers",
  failed: "arm.status.failed",
};

function failureBox(failure: ArmFailure): HTMLElement {
  switch (failure.kind) {
    case "open":
      return box("error", "fail-open", t("fail.open.title"), [
        t("fail.open.body"),
        { detail: t("fail.browserSaid", { detail: `${failure.errorName}: ${failure.message}` }) },
      ]);
    case "silent": {
      const parts: Part[] = [t("fail.silent.body")];
      if (failure.isUsbAdapter === false) parts.push(t("fail.silent.notUsb"));
      // servos that were never set up would have answered the question to every servo at once
      parts.push(
        failure.wasScanned
          ? [t("fail.silent.power"), t("fail.silent.port"), t("fail.silent.cable")]
          : [t("fail.silent.power"), t("fail.silent.port"), t("fail.silent.setup"), t("fail.silent.cable")],
      );
      if (failure.wasScanned) parts.push(t("fail.silent.scanned"));
      return box("error", "fail-silent", t("fail.silent.title"), parts);
    }
    case "partial": {
      const parts: Part[] = [
        t("fail.partial.body", { answering: listed(failure.answering), missing: listed(failure.missing) }),
        t("fail.partial.advice", { first: failure.missing[0] ?? "" }),
      ];
      if (failure.others.length > 0) parts.push(t("fail.partial.others", { others: listed(failure.others.map(String)) }));
      return box("error", "fail-partial", t("fail.partial.title"), parts);
    }
    case "garbled":
      return box("error", "fail-garbled", t("fail.garbled.title"), [t("fail.garbled.body")]);
    case "ids":
      return box("error", "fail-ids", t("fail.ids.title"), [
        t("fail.ids.body", { found: listed(failure.found.map(String)) }),
      ]);
    case "baud":
      return box("error", "fail-baud", t("fail.baud.title"), [
        t("fail.baud.body", { baud: count(failure.baudRate), found: listed(failure.found.map(String)) }),
      ]);
    case "echo":
      return box("error", "fail-echo", t("fail.echo.title"), [t("fail.echo.body")]);
    case "model":
      return box("error", "fail-model", t("fail.model.title"), [
        t("fail.model.body", { found: listed(failure.wrong.map((entry) => `${entry.motor} ${entry.model}`)) }),
      ]);
    case "lost":
      return box("error", "fail-lost", t("fail.lost.title"), [
        t("fail.lost.body"),
        { detail: t("fail.browserSaid", { detail: failure.message }) },
      ]);
    case "unexpected":
      return box("error", "fail-unexpected", t("fail.unexpected.title"), [
        t("fail.unexpected.body"),
        { detail: t("fail.detail", { detail: failure.message }) },
      ]);
  }
}

function armMessages(): HTMLElement[] {
  const view = arm.view;
  const boxes: HTMLElement[] = [];

  if (selfTest !== null && selfTest.failures.length > 0) {
    boxes.push(
      box("error", "guard-broken", t("guard.broken.title"), [
        t("guard.broken.body", { failures: selfTest.failures.join("; ") }),
      ]),
    );
  }
  if (pageProblem?.kind === "insecure") boxes.push(box("warn", "fail-insecure", t("fail.insecure.title"), [t("fail.insecure.body")]));
  if (pageProblem?.kind === "noSerial") boxes.push(box("warn", "fail-no-serial", t("fail.noSerial.title"), [t("fail.noSerial.body")]));
  if (pageProblem?.kind === "noPort") boxes.push(box("warn", "fail-no-port", t("fail.noPort.title"), [t("fail.noPort.body")]));
  if (pageProblem?.kind === "request") {
    boxes.push(
      box("error", "fail-request", t("fail.unexpected.title"), [
        t("fail.unexpected.body"),
        { detail: t("fail.browserSaid", { detail: pageProblem.detail ?? "" }) },
      ]),
    );
  }
  if (view.failure !== null) boxes.push(failureBox(view.failure));

  if (view.phase === "reading" || view.phase === "registers") {
    const errors = view.servos.filter((servo) => servo.answer === "error");
    if (view.faults.length > 0 || errors.length > 0) {
      let faults =
        view.faults.length > 0
          ? view.faults
          : servoFaults(Object.fromEntries(errors.map((servo) => [servo.motor, servo.errorByte ?? 0])));
      // a jaw under load alone is no fault for PEAR, but lerobot's handshake stops at any error byte
      if (faults.length === 0) {
        faults = errors.map((servo) => `${servo.motor}: 0x${(servo.errorByte ?? 0).toString(16).padStart(2, "0")}`);
      }
      boxes.push(
        box("error", "warn-servo-error", t("warn.servoError.title"), [
          t("warn.servoError.body", { faults: faults.join("; ") }),
        ]),
      );
    }
    if (view.sameFirmware === false) {
      const versions = [...new Set(view.servos.map((servo) => servo.firmware ?? "?"))];
      boxes.push(box("warn", "warn-firmware", null, [t("warn.firmware", { versions: listed(versions) })]));
    } else if (view.handshake !== null && !view.handshake.passed && errors.length === 0) {
      boxes.push(
        box("warn", "warn-handshake", null, [
          t("warn.handshake", { message: (view.handshake.message ?? "").replace(/\s*\n\s*/g, " ") }),
        ]),
      );
    }
    const line = view.lineErrors;
    if (line !== null && line.count > 0 && performance.now() - line.lastAt < LINE_ERROR_SHOWN_MS) {
      boxes.push(box("warn", "warn-line", null, [t("warn.line", { name: line.lastName, count: count(line.count) })]));
    }
    const withTorque = MOTORS.filter((motor) => view.health[motor].torque === 1);
    if (withTorque.length > 0) {
      boxes.push(box("warn", "warn-torque", null, [t("warn.torque", { motors: listed(withTorque) })]));
    }
    if (view.isUncalibrated) {
      boxes.push(box("warn", "warn-uncalibrated", t("warn.uncalibrated.title"), [t("warn.uncalibrated.body")]));
    } else if (view.registers !== null) {
      // wrist_roll turns all the way round: its range is the whole turn on a calibrated arm too, with an offset
      const factory = view.factoryMotors;
      if (factory.length > 0) {
        boxes.push(box("warn", "warn-partly-factory", null, [t("warn.partlyFactory", { motors: listed(factory) })]));
      }
    }
    if (view.live?.boundsMessage != null) {
      boxes.push(
        box("warn", "warn-bounds", t("warn.bounds.title"), [t("warn.bounds.body", { message: view.live.boundsMessage })]),
      );
    }
    if (view.live?.problem != null) {
      boxes.push(box("warn", "warn-reading", null, [t("warn.reading", { message: view.live.problem })]));
    }
  }

  return boxes;
}

function statusNames(status: number | null, motor: MotorName): string {
  if (status === null) return DASH;
  if (status === 0) return t("servos.status.ok");
  const faults = servoFaults({ [motor]: status });

  // PEAR's words for the bits that stop the arm; a jaw's load bits alone stop nothing
  return faults.length > 0 ? (faults[0] as string).replace(`${motor}: `, "") : `0x${status.toString(16).padStart(2, "0")}`;
}

function servoTable(): Node[] {
  const view = arm.view;
  const body = element(
    "tbody",
    {},
    view.servos.map((servo) => {
      const health = view.health[servo.motor];
      const status = servo.answer === "error" && health.status === null ? servo.errorByte : health.status;
      const hasFault = status !== null && servoFaults({ [servo.motor]: status }).length > 0;
      const answer = element("span", {
        className: `mark ${servo.answer === "ok" ? "ok" : "error"}`,
        text: t(`servos.answer.${servo.answer}`),
      });

      return row(
        [
          cell(String(servo.id), "number"),
          cell(servo.motor, "name"),
          element("td", { data: { field: "answer", value: servo.answer } }, [answer]),
          cell(servo.model === null ? DASH : String(servo.model), "number", { field: "model" }),
          cell(servo.firmware ?? DASH, "number"),
          element("td", { data: { field: "status", value: status ?? "" } }, [
            status === null
              ? document.createTextNode(DASH)
              : element("span", { className: `mark ${hasFault ? "error" : "ok"}`, text: statusNames(status, servo.motor) }),
          ]),
          cell(health.voltage === null ? DASH : `${health.voltage.toFixed(1)} V`, "number", { field: "voltage" }),
          cell(health.temperature === null ? DASH : `${health.temperature} °C`, "number"),
          cell(
            health.torque === null ? DASH : t(health.torque === 1 ? "servos.torque.on" : "servos.torque.off"),
            "",
            { field: "torque", value: health.torque ?? "" },
          ),
        ],
        { motor: servo.motor },
      );
    }),
  );
  const numeric: TextKey[] = ["servos.id", "servos.model", "servos.firmware", "servos.voltage", "servos.temperature"];

  return [
    headRow(
      [
        "servos.id",
        "servos.joint",
        "servos.answer",
        "servos.model",
        "servos.firmware",
        "servos.status",
        "servos.voltage",
        "servos.temperature",
        "servos.torque",
      ],
      numeric,
    ),
    body,
  ];
}

function calibrationTable(): Node[] {
  const view = arm.view;
  const registers = view.registers;
  if (registers === null) return [];

  const file = view.file;
  const keys: TextKey[] = ["cal.id", "cal.joint", "cal.offset", "cal.range"];
  if (file !== null) keys.push("cal.file", "cal.same");
  const body = element(
    "tbody",
    {},
    MOTORS.map((motor) => {
      const entry = registers[motor];
      const cells = [
        cell(String(entry.id), "number"),
        cell(motor, "name"),
        cell(String(entry.homingOffset).replace("-", MINUS), "number", { field: "offset", value: entry.homingOffset }),
        cell(`${entry.rangeMin} – ${entry.rangeMax}`, "number", { field: "range", value: `${entry.rangeMin}-${entry.rangeMax}` }),
      ];
      if (file !== null) {
        const filed = Object.hasOwn(file.calibration, motor) ? file.calibration[motor] : undefined;
        if (filed === undefined) {
          cells.push(cell(DASH, "number"), element("td", { data: { field: "same", value: "missing" } }, [
            element("span", { className: "mark error", text: t("cal.same.missing") }),
          ]));
        } else {
          // what PEAR's start-up compares: the offset and the two ends of the range
          const isSame =
            filed.homingOffset === entry.homingOffset && filed.rangeMin === entry.rangeMin && filed.rangeMax === entry.rangeMax;
          cells.push(
            cell(`${String(filed.homingOffset).replace("-", MINUS)}, ${filed.rangeMin} – ${filed.rangeMax}`, "number"),
            element("td", { data: { field: "same", value: isSame ? "yes" : "no" } }, [
              element("span", { className: `mark ${isSame ? "ok" : "error"}`, text: t(isSame ? "cal.same.yes" : "cal.same.no") }),
            ]),
          );
        }
      }

      return row(cells, { motor });
    }),
  );

  return [headRow(keys, ["cal.id", "cal.offset", "cal.range", "cal.file"]), body];
}

function calibrationVerdict(): Node[] {
  const file = arm.view.file;
  if (fileProblem !== null) {
    return [box("error", "cal-invalid", null, [t("cal.verdict.invalid", { problem: fileProblem })])];
  }
  if (file === null) return [];

  const name = file.name;
  if (file.verdict === "equal") return [box("ok", "cal-equal", null, [t("cal.verdict.equal", { name })])];
  if (file.verdict === "different") {
    const missing = MOTORS.filter((motor) => !Object.hasOwn(file.calibration, motor));
    const parts: Part[] = [t("cal.verdict.different", { name })];
    if (missing.length > 0) parts.push(t("cal.verdict.missing", { motors: listed(missing) }));

    return [box("error", "cal-different", null, parts)];
  }
  if (file.verdict === "unchecked") {
    return [box("warn", "cal-unchecked", null, [t("cal.verdict.unchecked", { name, problem: file.problem ?? "" })])];
  }

  return [box("info", "cal-waiting", null, [t("cal.verdict.waiting", { name })])];
}

const MARK_TONE: Record<BoundsMark, string> = { inside: "ok", tolerated: "warn", outside: "error" };

function jointTable(): Node[] {
  const live = arm.view.live;
  if (live === null) return [];

  const limits = arm.kinematics.limits;
  const body = element(
    "tbody",
    {},
    MOTORS.map((motor, index) => {
      const isGripper = index >= JOINTS.length;
      const unit = t(isGripper ? "joints.unit.opening" : "joints.unit.rad");
      const value = live.joints?.[index];
      const mark = live.marks?.[index];
      const lower = limits.lowerBounds[index] as number;
      const upper = limits.upperBounds[index] as number;

      return row(
        [
          cell(motor, "name"),
          cell(String(live.raw[motor]).replace("-", MINUS), "number", { field: "raw", value: live.raw[motor] }),
          cell(value === undefined ? DASH : `${fixed(value, 3)} ${unit}`, "number", {
            field: "value",
            value: value === undefined ? "" : String(value),
          }),
          cell(`${fixed(lower, 3)} … ${fixed(upper, 3)}`, "number"),
          element("td", { data: { field: "mark", value: mark ?? "" } }, [
            mark === undefined
              ? document.createTextNode(DASH)
              : element("span", { className: `mark ${MARK_TONE[mark]}`, text: t(`joints.mark.${mark}`) }),
          ]),
        ],
        { motor },
      );
    }),
  );

  return [
    headRow(["joints.joint", "joints.raw", "joints.value", "joints.limits", "joints.within"], [
      "joints.raw",
      "joints.value",
      "joints.limits",
    ]),
    body,
  ];
}

const STATE_UNITS: Record<string, string> = { x: "cm", y: "cm", z: "cm", pitch: "rad", roll: "rad", width: "cm" };

function modelState(): Node[] {
  const state = arm.view.live?.state ?? null;
  if (state === null) return [element("p", { className: "muted", text: t("state.none") })];

  const decimals = SO101Kinematics.DECIMALS;
  const quantities: Array<[keyof typeof decimals, number]> = [
    ["x", state.arm.x],
    ["y", state.arm.y],
    ["z", state.arm.z],
    ["pitch", state.arm.pitch],
    ["roll", state.arm.roll],
    ["width", state.gripper.width],
  ];

  return quantities.map(([name, value]) =>
    element("div", { data: { quantity: name, value: String(value) } }, [
      element("dt", { text: name }),
      element("dd", {}, [
        document.createTextNode(fixed(value, decimals[name])),
        element("span", { className: "unit", text: STATE_UNITS[name] ?? "" }),
      ]),
    ]),
  );
}

function renderGuard(): void {
  const counts = arm.view.guard;
  const passed = Object.entries(counts?.passed ?? {});
  const sent = passed.reduce((sum, [, number]) => sum + number, 0);
  const refused = Object.values(counts?.refused ?? {}).reduce((sum, number) => sum + number, 0);
  const line = byId<HTMLElement>("guard-line");
  line.dataset.sent = String(sent);
  line.dataset.refused = String(refused);
  setText(
    line,
    sent === 0 && refused === 0
      ? t("guard.idle")
      : t("guard.line", {
          sent: count(sent),
          detail: passed.map(([name, number]) => `${name} ${count(number)}`).join(", "),
          refused: count(refused),
        }),
  );
  setText(
    byId<HTMLElement>("guard-selftest"),
    selfTest === null
      ? ""
      : t("guard.selftest", {
          reading: selfTest.readingPassed,
          readingTried: selfTest.readingTried,
          writing: selfTest.writingRefused,
          writingTried: selfTest.writingTried,
        }),
  );
}

function renderArm(): void {
  const view = arm.view;
  const isBusy =
    view.phase === "opening" || view.phase === "handshake" || view.phase === "probing" || view.phase === "registers";
  const isOpen = isBusy || view.phase === "reading";
  const isGuardBroken = selfTest !== null && selfTest.failures.length > 0;

  byId<HTMLButtonElement>("arm-connect").disabled = isBusy || isGuardBroken || webSerial() === null;
  byId<HTMLButtonElement>("arm-sim").disabled = isBusy || isGuardBroken;
  const retry = byId<HTMLButtonElement>("arm-retry");
  retry.hidden = !(view.phase === "failed" && arm.lastPort !== null);
  retry.disabled = isGuardBroken;
  byId<HTMLButtonElement>("arm-disconnect").hidden = !isOpen;

  const statusKey: TextKey =
    view.phase === "reading"
      ? view.isStalled
        ? "arm.status.stalled"
        : view.isSimulated
          ? "arm.status.readingSim"
          : "arm.status.reading"
      : (PHASE_STATUS[view.phase] ?? "arm.status.idle");
  const status = byId<HTMLElement>("arm-status");
  status.dataset.phase = view.isStalled ? "stalled" : view.phase;
  setText(status, t(statusKey));
  setText(
    byId<HTMLElement>("arm-readings"),
    view.phase === "reading" && view.live !== null ? t("arm.readings", { count: count(view.live.count) }) : "",
  );

  const messages = armMessages();
  renderOnce(byId("arm-messages"), messages.map((message) => message.outerHTML).join(""), () => messages);

  byId("arm-servos").hidden = view.servos.length === 0;
  renderOnce(byId("servo-table"), JSON.stringify([view.servos, view.health]), servoTable);

  byId("arm-calibration").hidden = view.registers === null;
  renderOnce(byId("calibration-table"), JSON.stringify([view.registers, view.file]), calibrationTable);
  renderOnce(byId("calibration-verdict"), JSON.stringify([view.file, fileProblem]), calibrationVerdict);
  byId<HTMLButtonElement>("calibration-remove").hidden = view.file === null;

  byId("arm-joints").hidden = view.live === null;
  renderOnce(byId("joint-table"), JSON.stringify([view.live?.raw, view.live?.joints, view.live?.marks]), jointTable);
  renderOnce(byId("model-state"), JSON.stringify(view.live?.state ?? null), modelState);
  byId("turn-details").hidden = view.live?.turnText == null;
  setText(byId("turn-text"), view.live?.turnText ?? "");

  renderGuard();
  renderSim();
  renderTiming();
}

async function connectSerial(): Promise<void> {
  pageProblem = null;
  const serial = webSerial();
  if (serial === null) {
    pageProblem = { kind: window.isSecureContext ? "noSerial" : "insecure" };
    renderArm();
    return;
  }

  let port: SerialPortLike;
  try {
    port = await serial.requestPort();
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    log.add(`No port: ${name}: ${message}`);
    // the browser's chooser was closed without a choice
    pageProblem = name === "NotFoundError" ? { kind: "noPort" } : { kind: "request", detail: `${name}: ${message}` };
    renderArm();
    return;
  }

  sim = null;
  await connectArm(port, { isSimulated: false, label: "Web Serial" });
}

interface BrandVersion {
  brand: string;
  version: string;
}

/** The part of navigator.userAgentData the page reads; TypeScript's DOM library does not declare it. */
interface UserAgentData {
  brands?: BrandVersion[];
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{
    platformVersion?: string;
    architecture?: string;
    bitness?: string;
    fullVersionList?: BrandVersion[];
  }>;
}

/** How long the page waits for the browser's fuller description of itself, ms. */
const BROWSER_DETAIL_MS = 500;

/** Returns what the browser says it is: its brands, their versions and its platform (navigator.userAgentData)
 * where it has them, and its user agent string where it has not: a browser without that object, or a page that
 * is not served securely. A browser freezes parts of its user agent string, so the object says more. */
async function describeBrowser(): Promise<string> {
  const data = (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData;
  if (data === undefined || !Array.isArray(data.brands) || data.brands.length === 0) return navigator.userAgent;

  // a browser adds a brand that is none ("Not A;Brand"), so that pages do not rely on the list's form
  const named = (brands: readonly BrandVersion[]): string =>
    brands
      .filter((entry) => !/not[^a-z]*a[^a-z]*brand/i.test(entry.brand))
      .map((entry) => `${entry.brand} ${entry.version}`)
      .join(", ");
  let brands = named(data.brands);
  let platform = data.platform ?? "";
  try {
    const more = await Promise.race([
      data.getHighEntropyValues?.(["platformVersion", "architecture", "bitness", "fullVersionList"]),
      new Promise<undefined>((resolve) => setTimeout(resolve, BROWSER_DETAIL_MS)),
    ]);
    if (more !== undefined) {
      if (Array.isArray(more.fullVersionList) && more.fullVersionList.length > 0) brands = named(more.fullVersionList);
      const details = [more.platformVersion, more.architecture, more.bitness === undefined ? undefined : `${more.bitness} bit`];
      platform = [platform, ...details].filter((part) => part !== undefined && part !== "").join(" ");
    }
  } catch {
    // the browser gives no more: the brands and the platform are enough
  }

  return `${brands}; platform ${platform}`;
}

/** Asked once, when the page starts; every connection writes it to the log. */
let browserDescription: Promise<string> | null = null;

/** Connects ``port`` and first writes to the log what the browser is: a log copied after a failed connection
 * then holds, next to the port and the baud rate, what it ran in. */
async function connectArm(port: SerialPortLike, options: { isSimulated: boolean; label: string }): Promise<void> {
  browserDescription ??= describeBrowser();
  log.add(`Browser: ${await browserDescription}`);
  await arm.connect(port, options);
}

async function connectSim(): Promise<void> {
  pageProblem = null;
  if (sim === null) {
    const asked = new URLSearchParams(location.search).get("sim");
    sim = new SimArm(SIM_SCENARIOS.includes(asked as SimScenario) ? (asked as SimScenario) : "normal");
    byId("sim-sliders").dataset.signature = "";
  }
  sim.port.plug();
  log.add(`Simulated arm: ${sim.scenario}`);
  const connecting = connectArm(sim.port, { isSimulated: true, label: "simulated port" });
  // a simulated arm has a simulated camera, unless a camera already runs
  if (camera.view.phase === "off") void camera.start(TEST_PICTURE_ID);
  await connecting;
}

async function retryPort(): Promise<void> {
  const port = arm.lastPort;
  if (port === null) return;
  pageProblem = null;
  const isSimulated = sim !== null && port === sim.port;
  await connectArm(port, { isSimulated, label: isSimulated ? "simulated port" : "Web Serial" });
}

// ---------------------------------------------------------------- the simulated arm

function renderSim(): void {
  const panel = byId("sim-panel");
  panel.hidden = sim === null;
  if (sim === null) return;
  const simulated = sim;

  const select = byId<HTMLSelectElement>("sim-scenario");
  renderOnce(select, "scenarios", () =>
    SIM_SCENARIOS.map((scenario) => {
      const option = element("option", { text: t(`sim.scenario.${scenario}`) });
      option.value = scenario;
      return option;
    }),
  );
  select.value = simulated.scenario;

  renderOnce(byId("sim-sliders"), "sliders", () =>
    MOTORS.map((motor) => {
      const calibration = SIM_CALIBRATION[motor];
      const input = element("input");
      input.type = "range";
      input.id = `sim-slider-${motor}`;
      input.min = String(calibration.rangeMin);
      input.max = String(calibration.rangeMax);
      input.step = "1";
      input.value = String(simulated.position(motor));
      const value = element("span", { text: t("sim.steps", { value: input.value }) });
      input.addEventListener("input", () => {
        simulated.setPosition(motor, Number(input.value));
        value.textContent = t("sim.steps", { value: input.value });
      });
      const label = element("label", {}, [element("span", { text: motor }), value]);
      label.htmlFor = input.id;

      return element("div", { className: "slider" }, [label, input]);
    }),
  );

  const cable = byId<HTMLButtonElement>("sim-cable");
  cable.dataset.plugged = String(simulated.port.isPlugged);
  setText(cable, t(simulated.port.isPlugged ? "sim.unplug" : "sim.plug"));
}

// ---------------------------------------------------------------- the camera

function cameraMessages(): HTMLElement[] {
  const view = camera.view;
  const boxes: HTMLElement[] = [];
  if (!CameraSession.isAvailable) boxes.push(box("warn", "camera-unavailable", null, [t("camera.fail.unavailable")]));
  if (view.failure !== null) {
    const known = ["NotAllowedError", "NotFoundError", "NotReadableError", "TrackEnded"];
    const name = view.failure.errorName;
    boxes.push(
      box("error", `camera-fail-${name}`, null, [
        known.includes(name)
          ? t(`camera.fail.${name}` as TextKey)
          : t("camera.fail.other", { name, message: view.failure.message }),
      ]),
    );
  }
  const format = view.format;
  if (view.phase === "live" && format !== null) {
    if (format.width !== FRAME_WIDTH || format.height !== FRAME_HEIGHT) {
      boxes.push(box("warn", "camera-size-other", null, [t("camera.size.other", { width: format.width, height: format.height })]));
    } else if (format.resizeMode === "crop-and-scale") {
      boxes.push(box("warn", "camera-size-rescaled", null, [t("camera.size.rescaled")]));
    } else {
      boxes.push(box("ok", "camera-size-ok", null, [t("camera.size.ok")]));
    }
  }
  if (view.captureProblem !== null) {
    boxes.push(box("error", "camera-capture-problem", null, [t("camera.captureProblem", { problem: view.captureProblem })]));
  }

  return boxes;
}

function renderCamera(): void {
  const view = camera.view;
  const select = byId<HTMLSelectElement>("camera-select");
  renderOnce(select, JSON.stringify(view.devices), () => {
    const options: Array<[string, string]> = [[DEFAULT_CAMERA_ID, t("camera.option.default")]];
    view.devices.forEach((device, index) => {
      options.push([device.id, device.label === "" ? t("camera.option.unnamed", { number: index + 1 }) : device.label]);
    });
    options.push([TEST_PICTURE_ID, t("camera.option.test")]);

    return options.map(([value, text]) => {
      const option = element("option", { text });
      option.value = value;
      return option;
    });
  });
  select.value = view.selectedId;

  const isLive = view.phase === "live";
  const canStart = CameraSession.isAvailable || view.selectedId === TEST_PICTURE_ID;
  const start = byId<HTMLButtonElement>("camera-start");
  start.hidden = isLive;
  start.disabled = view.phase === "starting" || !canStart;
  byId<HTMLButtonElement>("camera-stop").hidden = !isLive;
  byId<HTMLButtonElement>("camera-capture").disabled = !isLive;

  const status = byId<HTMLElement>("camera-status");
  status.dataset.phase = view.phase;
  const format = view.format;
  if (isLive && format !== null) {
    status.dataset.width = String(format.width);
    status.dataset.height = String(format.height);
    setText(
      status,
      t("camera.status.live", {
        label:
          view.selectedId === TEST_PICTURE_ID
            ? t("camera.status.test")
            : format.label === ""
              ? t("camera.status.unnamed")
              : format.label,
        width: format.width,
        height: format.height,
        rate: format.frameRate === null ? "" : t("camera.status.rate", { fps: Math.round(format.frameRate) }),
      }),
    );
  } else setText(status, t(view.phase === "starting" ? "camera.status.starting" : "camera.status.off"));

  const messages = cameraMessages();
  renderOnce(byId("camera-messages"), messages.map((message) => message.outerHTML).join(""), () => messages);

  const image = byId<HTMLImageElement>("camera-captured");
  const capture = view.capture;
  image.hidden = capture === null;
  byId("camera-captured-none").hidden = capture !== null;
  const info = byId<HTMLElement>("camera-info");
  if (capture === null) setText(info, "");
  else {
    if (image.src !== capture.url) image.src = capture.url;
    info.dataset.bytes = String(capture.bytes.length);
    info.dataset.width = String(capture.header?.width ?? "");
    info.dataset.height = String(capture.header?.height ?? "");
    info.dataset.subsampling = capture.header?.subsampling ?? "";
    info.dataset.progressive = String(capture.header?.isProgressive ?? "");
    setText(
      info,
      t("camera.info", {
        width: capture.header?.width ?? "?",
        height: capture.header?.height ?? "?",
        bytes: count(capture.bytes.length),
        quality: capture.quality,
        subsampling: capture.header?.subsampling ?? "?",
      }),
    );
  }
}

// ---------------------------------------------------------------- the model service

function modelResult(): Node[] {
  if (modelCheck === null) return [element("p", { className: "muted", text: t("model.unchecked") })];
  if (modelCheck === "checking") return [element("p", { className: "muted", text: t("model.checking") })];

  const { outcome, message, where, localNetwork } = modelCheck;
  const said: Part = { detail: t("model.clientSaid", { message }) };
  // where the check got no answer and this page came from the internet: the browser's own question about the
  // local network, which the page cannot see being asked
  const permission: Part[] =
    localNetwork === "denied"
      ? [t("model.permission.denied")]
      : localNetwork === "prompt"
        ? [t("model.permission.prompt")]
        : [];
  const choices = (served: readonly string[]): HTMLElement =>
    element(
      "div",
      { className: "actions" },
      served.map((name) => {
        const button = element("button", { text: t("model.use", { model: name }), data: { model: name } });
        button.type = "button";
        button.addEventListener("click", () => {
          byId<HTMLInputElement>("model-name").value = name;
          void runModelCheck();
        });
        return button;
      }),
    );

  switch (outcome.kind) {
    case "ok": {
      const parts: Part[] = [t("model.ok", { model: outcome.model })];
      if (outcome.wasFound) parts.push(t("model.okFound"));
      return [box("ok", "model-ok", null, parts)];
    }
    case "not-served": {
      const node = box("error", "model-not-served", null, [t("model.notServed", { model: outcome.model })]);
      node.append(choices(outcome.served));
      node.append(element("p", { className: "detail", text: t("model.clientSaid", { message }) }));
      return [node];
    }
    case "choose": {
      if (outcome.served.length === 0) return [box("error", "model-none", null, [t("model.none")])];
      const node = box("info", "model-choose", null, [t("model.choose")]);
      node.append(choices(outcome.served));
      return [node];
    }
    case "key":
      return [box("error", "model-key", null, [t("model.key.refused", { status: outcome.status }), said])];
    case "not-found":
      return [box("error", "model-not-found", null, [t("model.notFound", { where }), said])];
    case "http":
      return [box("error", "model-http", null, [t("model.http", { status: outcome.status }), said])];
    case "timeout":
      return [box("error", "model-timeout", null, [t("model.timeout"), ...permission, said])];
    case "blocked": {
      // a page opened from a folder names itself "null" to a service, whatever its own address reads
      const isFolder = location.protocol === "file:";
      const origin = isFolder ? "null" : location.origin;
      const parts: Part[] = [t("model.blocked.body"), [t("model.blocked.origin", { origin }), t("model.blocked.key")]];
      if (isFolder) parts.push(t("model.blocked.folder"));
      return [box("error", "model-blocked", t("model.blocked.title"), [...parts, said])];
    }
    case "unreachable":
      return [
        box("error", "model-unreachable", t("model.unreachable.title"), [
          t("model.unreachable.body", { where }),
          ...permission,
          said,
        ]),
      ];
    case "mixed": {
      const parts: Part[] = [t("model.mixed.body", { where }), [t("model.mixed.https"), t("model.mixed.same")]];
      if (outcome.isLocalAddress) parts.push(t("model.mixed.local"), ...permission);
      return [box("error", "model-mixed", t("model.mixed.title"), [...parts, said])];
    }
    case "refused":
      return [box("error", "model-refused", null, [t("model.refused"), said])];
    case "not-a-service":
      return [box("error", "model-not-a-service", null, [t("model.notService", { where }), said])];
  }
}

function renderModel(): void {
  const button = byId<HTMLButtonElement>("model-check");
  button.disabled = modelCheck === "checking";
  const result = byId<HTMLElement>("model-result");
  result.dataset.outcome = modelCheck === null ? "" : modelCheck === "checking" ? "checking" : modelCheck.outcome.kind;
  result.dataset.signature = "";
  result.replaceChildren(...modelResult());
}

async function runModelCheck(): Promise<void> {
  if (modelCheck === "checking") return;
  const key = byId<HTMLInputElement>("model-key").value;
  modelCheck = "checking";
  renderModel();
  try {
    const check = await checkModel(
      { baseUrl: byId<HTMLInputElement>("model-url").value, model: byId<HTMLInputElement>("model-name").value, apiKey: key },
      (message) => log.add(redact(message, key)),
    );
    // a service may repeat a key in its refusal: it is not shown
    modelCheck = { ...check, message: redact(check.message, key) };
    if (check.outcome.kind === "ok") byId<HTMLInputElement>("model-name").value = check.outcome.model;
  } catch (error) {
    modelCheck = {
      outcome: { kind: "refused" },
      message: redact(error instanceof Error ? error.message : String(error), key),
      where: "",
      localNetwork: null,
    };
  }
  renderModel();
}

// ---------------------------------------------------------------- timing

function renderTiming(): void {
  const button = byId<HTMLButtonElement>("timing-run");
  button.disabled = timingState.kind === "running";
  const result = byId<HTMLElement>("timing-result");
  result.dataset.state = timingState.kind;
  setText(
    result,
    timingState.kind === "running"
      ? t("timing.running", { step: timingState.step })
      : timingState.kind === "needsArm"
        ? t("timing.needsArm")
        : timingState.kind === "done"
          ? t("timing.done")
          : "",
  );
}

async function runTiming(): Promise<void> {
  const bus = arm.bus;
  if (bus === null || arm.view.phase !== "reading") {
    timingState = { kind: "needsArm" };
    renderTiming();
    return;
  }

  timingState = { kind: "running", step: "" };
  renderTiming();
  try {
    const report: TimingReport = await arm.exclusively(() =>
      measureTiming(
        async () => {
          await bus.syncRead("Present_Position", null, { normalize: false });
        },
        (reads) => arm.measureReads(reads),
        (step) => {
          timingState = { kind: "running", step };
          renderTiming();
        },
      ),
    );
    debug.timing = report;
    log.add(
      `Timing on ${arm.view.isSimulated ? "the simulated arm" : "a real port"} ` +
        `(page ${report.visibility}, ${report.hasFocus ? "focused" : "not focused"}):`,
    );
    log.add(
      `  one read of the six positions, ${READS} in a row: ${formatStats(report.reads)}; ` +
        `all together ${report.readsTotalMs.toFixed(1)} ms, ${(report.readsTotalMs / READS).toFixed(3)} ms each ` +
        `(the clock's step is ${report.clockStepMs.toFixed(3)} ms)`,
    );
    log.add(`  setInterval ${TIMER_PERIOD_MS} ms, nothing to do, ${TIMER_PERIODS} periods: ${formatStats(report.interval)}`);
    log.add(`  timer aiming at its due times, ${TIMER_PERIOD_MS} ms, ${TIMER_PERIODS} periods: ${formatStats(report.deadline)}`);
    log.add(`  setInterval ${TIMER_PERIOD_MS} ms with a read in each period: ${formatStats(report.loadedInterval)}`);
    log.add(`  the reads inside those periods: ${formatStats(report.loadedReads)}; periods skipped: ${report.loadedOverruns}`);
    timingState = { kind: "done" };
  } catch (error) {
    log.add(`Timing failed: ${error instanceof Error ? error.message : String(error)}`);
    timingState = { kind: "idle" };
  }
  renderTiming();
}

// ---------------------------------------------------------------- the page

function renderLanguageButtons(): void {
  byId("language-en").setAttribute("aria-pressed", String(language() === "en"));
  byId("language-zh").setAttribute("aria-pressed", String(language() === "zh-TW"));
  // what this build is and which commit of PEAR it ports: the first line of the log says the same
  const stamp = byId("footer-commit");
  stamp.dataset.build = __PEARJS_BUILD__;
  stamp.dataset.pear = __PEAR_COMMIT__;
  setText(stamp, t("footer.commit", { commit: __PEAR_COMMIT__.slice(0, 8), build: __PEARJS_BUILD__ }));
}

function renderAll(): void {
  renderLanguageButtons();
  renderArm();
  renderCamera();
  renderModel();
}

/** What a check, or a curious person at the console, may reach: every byte to the servos still passes the guard. */
const debug: {
  arm: ArmSession;
  camera: CameraSession;
  log: PageLog;
  sim: () => SimArm | null;
  selfTest: () => GuardSelfTest | null;
  timing: TimingReport | null;
  build: string;
  pearCommit: string;
  /** The page's one way to make a turn's frame of a picture, and its test picture: for comparing encoders. */
  frameOf: typeof frameOf;
  testPicture: () => HTMLCanvasElement;
} = {
  arm,
  camera,
  log,
  sim: () => sim,
  selfTest: () => selfTest,
  timing: null,
  build: __PEARJS_BUILD__,
  pearCommit: __PEAR_COMMIT__,
  frameOf,
  testPicture: () => new TestPicture().canvas,
};
(window as Window & { pearjs?: typeof debug }).pearjs = debug;

function start(): void {
  setLanguage(initialLanguage(location.search, navigator.languages ?? [navigator.language]));
  applyStaticTexts(document);
  onLanguageChange(renderAll);

  byId("language-en").addEventListener("click", () => setLanguage("en"));
  byId("language-zh").addEventListener("click", () => setLanguage("zh-TW"));
  byId("arm-connect").addEventListener("click", () => void connectSerial());
  byId("arm-sim").addEventListener("click", () => void connectSim());
  byId("arm-retry").addEventListener("click", () => void retryPort());
  byId("arm-disconnect").addEventListener("click", () => void arm.disconnect());

  byId<HTMLSelectElement>("sim-scenario").addEventListener("change", (event) => {
    if (sim === null) return;
    sim.setScenario((event.target as HTMLSelectElement).value as SimScenario);
    void connectSim();
  });
  byId("sim-cable").addEventListener("click", () => {
    if (sim === null) return;
    if (sim.port.isPlugged) {
      sim.port.unplug();
      log.add("Simulated arm: the cable was pulled");
    } else {
      sim.port.plug();
      log.add("Simulated arm: the cable is back");
    }
    renderSim();
  });

  const fileInput = byId<HTMLInputElement>("calibration-file");
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file === undefined) return;
    void (async () => {
      try {
        const text = await file.text();
        fileProblem = null;
        await arm.loadCalibrationFile(file.name, text);
      } catch (error) {
        fileProblem = error instanceof Error ? error.message : String(error);
        log.add(`Calibration file refused: ${fileProblem}`);
        await arm.dropCalibrationFile();
      }
      renderArm();
    })();
  });
  byId("calibration-remove").addEventListener("click", () => {
    fileInput.value = "";
    fileProblem = null;
    void arm.dropCalibrationFile();
  });

  byId<HTMLSelectElement>("camera-select").addEventListener("change", (event) => {
    const id = (event.target as HTMLSelectElement).value;
    if (camera.view.phase === "live" || camera.view.phase === "starting") void camera.start(id);
    else {
      camera.view.selectedId = id;
      renderCamera();
    }
  });
  byId("camera-start").addEventListener("click", () => void camera.start(camera.view.selectedId));
  byId("camera-stop").addEventListener("click", () => camera.stop());
  byId("camera-capture").addEventListener("click", () => void camera.capture());

  byId("model-check").addEventListener("click", () => void runModelCheck());
  for (const id of ["model-url", "model-name", "model-key"]) {
    byId(id).addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter") void runModelCheck();
    });
  }

  byId("log-copy").addEventListener("click", () => {
    void log.copy().then((isCopied) => {
      setText(byId("log-copy-result"), t(isCopied ? "log.copied" : "log.copyFailed"));
    });
  });
  byId("timing-run").addEventListener("click", () => void runTiming());

  // the log's first three lines stay whatever comes later (log.ts): the build, the browser, the page
  log.add(`pear.js build ${__PEARJS_BUILD__}, ports PEAR ${__PEAR_COMMIT__}; read-only first version`);
  log.add(`User agent: ${navigator.userAgent}`);
  log.add(
    `Page: ${location.protocol} ${window.isSecureContext ? "secure context" : "not a secure context"}; ` +
      `Web Serial ${webSerial() === null ? "absent" : "present"}; camera ${CameraSession.isAvailable ? "available" : "unavailable"}; ` +
      `language ${language()}; viewport ${window.innerWidth}x${window.innerHeight}`,
  );

  if (webSerial() === null) pageProblem = { kind: window.isSecureContext ? "noSerial" : "insecure" };
  renderAll();
  void camera.refreshDevices();

  void guardSelfTest().then((result) => {
    selfTest = result;
    log.add(
      `Read-only guard self-test: ${result.readingPassed}/${result.readingTried} reading packets passed, ` +
        `${result.writingRefused}/${result.writingTried} writing or malformed refused` +
        `${result.failures.length > 0 ? `; FAILED: ${result.failures.join("; ")}` : ""}`,
    );
    renderArm();
    if (result.failures.length === 0 && new URLSearchParams(location.search).get("arm") === "sim") void connectSim();
  });
}

start();
