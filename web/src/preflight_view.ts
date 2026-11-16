// The report of the hand-over check of a real arm's line (the request "preflight"), as the page shows it: the
// Worker's report in, sentences and tables out, in the page's language. Nothing here touches the document;
// main.ts only puts the parts on the page.

import type { PreflightReport, PreflightServo, PreflightSetting, TimingCheck, UsbIds } from "./station_protocol";
import type { TextKey } from "./texts";

/** How a part is worded: the page gives `t`, `count` and `listed` of i18n.ts, a test the same over one language. */
export interface Wording {
  t(key: TextKey, values?: Readonly<Record<string, string | number>>): string;
  count(value: number): string;
  listed(names: readonly string[]): string;
}

/** How grave a sentence is: "error" is something the person must act on or report, "warn" something to know
 * before the arm is enabled. */
export type PreflightTone = "ok" | "info" | "warn" | "error";

export interface PreflightSentence {
  readonly type: "sentence";
  /** Names the sentence for whoever looks for one among the report's. */
  readonly kind: string;
  readonly tone: PreflightTone;
  readonly text: string;
  /** The Worker's own words (English), where it gave some. */
  readonly detail: string | null;
}

export interface PreflightTable {
  readonly type: "table";
  readonly kind: string;
  readonly title: string;
  readonly head: readonly string[];
  /** For each column, whether it holds numbers. */
  readonly numeric: readonly boolean[];
  readonly rows: readonly (readonly string[])[];
}

export type PreflightPart = PreflightSentence | PreflightTable;

const MINUS = "−"; // the minus sign of a number, which a hyphen is not

/** Returns ``value`` with ``decimals`` places and a true minus sign. */
function fixed(value: number, decimals: number): string {
  return value.toFixed(decimals).replace("-", MINUS);
}

/** Returns a register's value as it was read, with a true minus sign. */
function raw(value: number): string {
  return String(value).replace("-", MINUS);
}

/** Returns a USB id as the browser's device lists write it: four hexadecimal digits. */
function hex4(value: number): string {
  return value.toString(16).padStart(4, "0");
}

function sentence(kind: string, tone: PreflightTone, text: string, detail: string | null = null): PreflightSentence {
  return { type: "sentence", kind, tone, text, detail };
}

/** Returns the rows of `settings` that PEAR's enable would change: those whose value differs from PEAR's. */
export function changedSettings(report: PreflightReport): PreflightSetting[] {
  return (report.settings ?? []).filter((setting) => setting.held !== setting.pear);
}

function portText(port: UsbIds | null, wording: Wording): string {
  return port === null
    ? wording.t("station.preflight.port.noIds")
    : wording.t("station.preflight.port.usb", { vendor: hex4(port.vendorId), product: hex4(port.productId) });
}

/** What the Worker's `getPorts()` gave: whether the Worker reached the page's adapter at all. */
function portsSentence(report: PreflightReport, wording: Wording): PreflightSentence {
  if (report.ports === null) return sentence("ports", "warn", wording.t("station.preflight.ports.noSerial"));
  if (report.ports.length === 0) return sentence("ports", "warn", wording.t("station.preflight.ports.empty"));

  return sentence(
    "ports",
    "info",
    wording.t("station.preflight.ports.list", {
      count: wording.count(report.ports.length),
      ports: wording.listed(report.ports.map((port) => portText(port, wording))),
    }),
  );
}

/** The servo's name with its id, as every table of the report names a servo. */
function servoName(id: number, servos: readonly PreflightServo[] | null): string {
  const servo = servos?.find((candidate) => candidate.id === id);

  return servo === undefined ? `#${id}` : `${servo.name} (${id})`;
}

/** The six servos as they were found: what a program before this one left in them. */
function servoTable(servos: readonly PreflightServo[], wording: Wording): PreflightTable {
  const { t } = wording;

  return {
    type: "table",
    kind: "servos",
    title: t("station.preflight.servos.title"),
    head: [
      t("station.preflight.col.servo"),
      t("station.preflight.col.torque"),
      t("station.preflight.col.lock"),
      t("station.preflight.col.status"),
      t("station.preflight.col.voltage"),
      t("station.preflight.col.temperature"),
      t("station.preflight.col.goalVelocity"),
      t("station.preflight.col.torqueLimit"),
      t("station.preflight.col.phase"),
      t("station.preflight.col.position"),
      t("station.preflight.col.goal"),
    ],
    numeric: [false, false, true, true, true, true, true, true, true, true, true],
    rows: servos.map((servo) => [
      servoName(servo.id, servos),
      servo.torque === 0
        ? t("station.preflight.torque.off")
        : servo.torque === 1
          ? t("station.preflight.torque.on")
          : raw(servo.torque),
      raw(servo.lock),
      raw(servo.status),
      fixed(servo.voltage / 10, 1),
      raw(servo.temperature),
      raw(servo.goalVelocity),
      raw(servo.torqueLimit),
      raw(servo.phase),
      raw(servo.position),
      raw(servo.goal),
    ]),
  };
}

/** What tells this arm from another: the model, the firmware and what each servo holds of the calibration. */
function identityTable(servos: readonly PreflightServo[], wording: Wording): PreflightTable {
  const { t } = wording;

  return {
    type: "table",
    kind: "identity",
    title: t("station.preflight.identity.title"),
    head: [
      t("station.preflight.col.servo"),
      t("station.preflight.col.model"),
      t("station.preflight.col.firmware"),
      t("station.preflight.col.homingOffset"),
      t("station.preflight.col.rangeMin"),
      t("station.preflight.col.rangeMax"),
    ],
    numeric: [false, true, true, true, true, true],
    rows: servos.map((servo) => [
      servoName(servo.id, servos),
      raw(servo.model),
      servo.firmware,
      raw(servo.homingOffset),
      raw(servo.rangeMin),
      raw(servo.rangeMax),
    ]),
  };
}

/** What PEAR's enable would change: a sentence, and the rows that differ when some do. */
function settingsParts(report: PreflightReport, wording: Wording): PreflightPart[] {
  const { t, count } = wording;
  if (report.settings === null) return [sentence("settings", "info", t("station.preflight.settings.notRead"))];

  const changed = changedSettings(report);
  const total = count(report.settings.length);
  if (changed.length === 0) return [sentence("settings", "ok", t("station.preflight.settings.none", { total }))];

  return [
    sentence(
      "settings",
      "warn",
      t("station.preflight.settings.some", {
        changed: count(changed.length),
        total,
        eeprom: count(changed.filter((setting) => setting.area === "eeprom").length),
      }),
    ),
    {
      type: "table",
      kind: "settings",
      title: t("station.preflight.settings.title"),
      head: [
        t("station.preflight.col.servo"),
        t("station.preflight.col.register"),
        t("station.preflight.col.address"),
        t("station.preflight.col.held"),
        t("station.preflight.col.pear"),
        t("station.preflight.col.area"),
      ],
      numeric: [false, false, true, true, true, false],
      rows: changed.map((setting) => [
        servoName(setting.id, report.servos),
        setting.register,
        raw(setting.address),
        raw(setting.held),
        raw(setting.pear),
        t(`station.preflight.area.${setting.area}`),
      ]),
    },
  ];
}

/** The timing self-check with its numbers and its verdict, as the station's panel says it before enabling. */
function timingSentence(timing: TimingCheck | null, wording: Wording): PreflightSentence {
  const { t, count } = wording;
  if (timing === null) return sentence("timing", "info", t("station.preflight.timing.none"));

  const hasPassed = timing.failures.length === 0;
  // the reasons carry the numbers for the page's language; a check that gave none is told in the Worker's words
  const failures =
    timing.reasons.length > 0
      ? timing.reasons
          .map((reason) => t(`station.timing.fail.${reason.code}`, { value: reason.value ?? "", limit: reason.limit ?? "" }))
          .join(t("station.timing.fail.join"))
      : timing.failures.join(t("station.timing.fail.join"));

  return sentence(
    "timing",
    hasPassed ? "ok" : "warn",
    t("station.preflight.timing", {
      periods: count(timing.periods),
      mean: fixed(timing.meanMs, 2),
      max: fixed(timing.maxMs, 2),
      over: count(timing.over25),
      read: fixed(timing.maxReadMs, 2),
      verdict: hasPassed ? t("station.preflight.timing.passed") : t("station.preflight.timing.failed", { failures }),
    }),
  );
}

/** What the read-only guard let through and that it refused nothing; a refusal is a defect to report. */
function guardSentence(report: PreflightReport, wording: Wording): PreflightSentence {
  const { t, count, listed } = wording;
  const names = Object.entries(report.guard.passed).map(([name, packets]) => `${name} ${count(packets)}`);
  const passed = names.length === 0 ? t("station.preflight.guard.nothing") : listed(names);
  if (report.guard.refused !== 0) {
    return sentence("guard", "error", t("station.preflight.guard.refused", { refused: count(report.guard.refused), passed }));
  }

  return sentence("guard", "ok", t("station.preflight.guard.ok", { passed }));
}

/** Returns everything the page shows of `report`, in the order it shows it: how far the Worker came and what the
 * person can do, the ports it was given, whether it gave the line back, the servos as found, what PEAR's enable
 * would change, the limp time, the timing, the guard, the line's errors and how long the whole took. */
export function preflightParts(report: PreflightReport, wording: Wording): PreflightPart[] {
  const { t, count } = wording;
  const parts: PreflightPart[] = [];

  parts.push(
    report.stop === null
      ? sentence("outcome", "ok", t("station.preflight.outcome.read"))
      : sentence("outcome", "error", t(`station.preflight.stop.${report.stop}`), report.detail === "" ? null : report.detail),
  );
  parts.push(portsSentence(report, wording));
  parts.push(
    report.isClosed
      ? sentence("closed", "ok", t("station.preflight.closed.yes"))
      : sentence("closed", "error", t("station.preflight.closed.no")),
  );

  if (report.servos === null) parts.push(sentence("servos", "info", t("station.preflight.servos.none")));
  else parts.push(servoTable(report.servos, wording), identityTable(report.servos, wording));
  parts.push(...settingsParts(report, wording));

  parts.push(
    report.singleReads === null
      ? sentence("limp", "info", t("station.preflight.limp.none"))
      : sentence(
          "limp",
          "info",
          t("station.preflight.limp", {
            count: count(report.singleReads.count),
            total: fixed(report.singleReads.totalMs, 2),
            max: fixed(report.singleReads.maxMs, 2),
          }),
        ),
  );
  parts.push(timingSentence(report.timing, wording));
  parts.push(guardSentence(report, wording));
  parts.push(
    report.lineErrors === 0
      ? sentence("lineErrors", "ok", t("station.preflight.lineErrors.none"))
      : sentence("lineErrors", "warn", t("station.preflight.lineErrors.some", { errors: count(report.lineErrors) })),
  );
  parts.push(sentence("took", "info", t("station.preflight.took", { ms: count(Math.round(report.tookMs)) })));

  return parts;
}
