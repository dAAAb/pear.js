// Enabling PEAR's station on a real arm (the request "enableReal"), as the page words it: what the Worker read and
// the reasons against enabling in, sentences out, in the page's language. Each reason says what the person can
// do; the confirmation's list is what the operator reads before the first write to a servo, with this line's
// numbers; and a real arm's line is told while the station holds it. Nothing here touches the document; main.ts
// only puts the parts on the page.

import { type PreflightPart, preflightParts, type Wording } from "./preflight_view";
import {
  ARMING_LIMIT_MS,
  type ArmingBlocker,
  type PreflightReport,
  type PreflightServo,
  type PreflightSetting,
  type RealLineStatus,
} from "./station_protocol";

const MINUS = "−"; // the minus sign of a number, which a hyphen is not

/** Returns a register's value as it was read, with a true minus sign. */
function raw(value: number): string {
  return String(value).replace("-", MINUS);
}

/** The servo's name with its id, as the report's tables name a servo. */
function servoName(id: number, servos: readonly PreflightServo[] | null): string {
  const servo = servos?.find((candidate) => candidate.id === id);

  return servo === undefined ? `#${id}` : `${servo.name} (${id})`;
}

/** One reason against enabling as the page says it: what was found, and what the person can do. */
export interface BlockerSentence {
  readonly code: ArmingBlocker["code"];
  readonly text: string;
  /** The Worker's own words (English), where it gave some. */
  readonly detail: string | null;
}

/** One sentence of the list the operator reads before confirming; "warn" is one to read twice. */
export interface ConfirmItem {
  readonly kind: string;
  readonly tone: "info" | "warn";
  readonly text: string;
  /** What the sentence lists, one text each, which the page shows as a list under it; empty where it lists
   * nothing. */
  readonly rows: readonly string[];
}

/** Returns the settings of the EEPROM that PEAR's enable will change on the arm of `report`: the rows whose value
 * is not PEAR's. They survive a power cycle, so the confirmation lists each one, and they are no reason against
 * enabling: PEAR writes its settings at every enable, whatever the servos hold. */
export function eepromChanges(report: PreflightReport): PreflightSetting[] {
  return (report.settings ?? []).filter((setting) => setting.area === "eeprom" && setting.held !== setting.pear);
}

/** Whether PEAR's enable will change a setting that survives a power cycle on the arm of `report`: whether the
 * confirmation lists such settings, and the tick is given to that list as well. */
export function changesEeprom(report: PreflightReport): boolean {
  return eepromChanges(report).length > 0;
}

/** One setting that PEAR's enable will change, as the confirmation lists it: the servo's name and id, the
 * register and its address, the value the servo holds and the value PEAR writes. */
function settingRow(setting: PreflightSetting, report: PreflightReport, wording: Wording): string {
  return wording.t("station.arming.setting.row", {
    servo: servoName(setting.id, report.servos),
    register: setting.register,
    address: raw(setting.address),
    held: raw(setting.held),
    pear: raw(setting.pear),
  });
}

/** The reasons against enabling that the report itself shows, found again on the window's side: the page asks
 * for no confirmation when it sees one, whatever the Worker told. */
export function reportBlockers(report: PreflightReport): ArmingBlocker[] {
  const found: ArmingBlocker[] = [];
  if (report.stop !== null) found.push({ code: "stop", stop: report.stop });
  else if (report.timing === null || report.timing.failures.length > 0) found.push({ code: "timing" });

  const servos = report.servos ?? [];
  const idsOf = (isOne: (servo: PreflightServo) => boolean): number[] => servos.filter(isOne).map((servo) => servo.id);
  const faulty = idsOf((servo) => servo.status !== 0);
  if (faulty.length > 0) found.push({ code: "status", ids: faulty });
  const phased = idsOf((servo) => (servo.phase & 0x10) !== 0);
  if (phased.length > 0) found.push({ code: "phase", ids: phased });
  const uncalibrated = idsOf((servo) => servo.homingOffset === 0 && servo.rangeMin === 0 && servo.rangeMax === 4095);
  if (uncalibrated.length > 0) found.push({ code: "uncalibrated", ids: uncalibrated });
  if (report.guard.refused > 0) found.push({ code: "guard", refused: report.guard.refused });

  return found;
}

/** Returns the reasons the Worker told and, after them, every reason of `reportBlockers` it did not tell. */
export function allBlockers(report: PreflightReport, told: readonly ArmingBlocker[]): ArmingBlocker[] {
  const codes = new Set(told.map((blocker) => blocker.code));

  return [...told, ...reportBlockers(report).filter((blocker) => !codes.has(blocker.code))];
}

/** Why the timing self-check failed, in the page's language where the report gives the numbers. */
function timingFailures(report: PreflightReport, wording: Wording): string {
  const { t } = wording;
  const timing = report.timing;
  const join = t("station.timing.fail.join");
  if (timing !== null && timing.reasons.length > 0) {
    return timing.reasons
      .map((reason) => t(`station.timing.fail.${reason.code}`, { value: reason.value ?? "", limit: reason.limit ?? "" }))
      .join(join);
  }
  if (timing !== null && timing.failures.length > 0) return timing.failures.join(join);

  return t("station.arming.blocker.timing.noNumbers");
}

/** Returns each of `blockers` as a sentence that says what was found on this arm and what the person can do. */
export function blockerSentences(
  report: PreflightReport,
  blockers: readonly ArmingBlocker[],
  wording: Wording,
): BlockerSentence[] {
  const { t, count, listed } = wording;
  const names = (ids: readonly number[]): string => listed(ids.map((id) => servoName(id, report.servos)));

  return blockers.map((blocker): BlockerSentence => {
    switch (blocker.code) {
      case "stop":
        return {
          code: blocker.code,
          text: t("station.arming.blocker.stop", { reason: t(`station.preflight.stop.${blocker.stop}`) }),
          detail: report.detail === "" ? null : report.detail,
        };
      case "timing":
        return {
          code: blocker.code,
          text: t("station.arming.blocker.timing", { failures: timingFailures(report, wording) }),
          detail: null,
        };
      case "status":
        return {
          code: blocker.code,
          text: t("station.arming.blocker.status", {
            servos: listed(
              blocker.ids.map((id) => {
                const servo = report.servos?.find((candidate) => candidate.id === id);
                const name = servoName(id, report.servos);

                return servo === undefined ? name : t("station.arming.servo.value", { servo: name, value: raw(servo.status) });
              }),
            ),
          }),
          detail: null,
        };
      case "phase":
        return { code: blocker.code, text: t("station.arming.blocker.phase", { servos: names(blocker.ids) }), detail: null };
      case "uncalibrated":
        return {
          code: blocker.code,
          text: t("station.arming.blocker.uncalibrated", { servos: names(blocker.ids) }),
          detail: null,
        };
      case "calibration":
        return {
          code: blocker.code,
          text: t("station.arming.blocker.calibration", { detail: blocker.detail }),
          detail: null,
        };
      case "guard":
        return {
          code: blocker.code,
          text: t("station.arming.blocker.guard", { refused: count(blocker.refused) }),
          detail: null,
        };
    }
  });
}

/** The settings of one area that PEAR's enable writes, one text for each register and value: on how many servos,
 * and how many of them hold another value now. */
function settingRows(settings: readonly PreflightSetting[], area: PreflightSetting["area"], wording: Wording): string[] {
  const { t, count } = wording;
  const groups = new Map<string, { register: string; address: number; pear: number; servos: number; changed: number }>();
  for (const setting of settings) {
    if (setting.area !== area) continue;
    const key = `${setting.address}=${setting.pear}`;
    const group = groups.get(key) ?? { register: setting.register, address: setting.address, pear: setting.pear, servos: 0, changed: 0 };
    group.servos += 1;
    if (setting.held !== setting.pear) group.changed += 1;
    groups.set(key, group);
  }

  return [...groups.values()].map((group) =>
    t(group.changed === 0 ? "station.arming.confirm.row.same" : "station.arming.confirm.row.changed", {
      register: group.register,
      address: raw(group.address),
      pear: raw(group.pear),
      servos: count(group.servos),
      changed: count(group.changed),
    }),
  );
}

/** How many sentences of the report, as the page shows it while the line is open, are warnings or errors. */
function reportWarnings(report: PreflightReport, wording: Wording): number {
  return armingReportParts(report, wording, true).filter(
    (part) => part.type === "sentence" && (part.tone === "warn" || part.tone === "error"),
  ).length;
}

/** Returns what the operator reads before the first write, in the order the page lists it: what Enable does to
 * the arm and how long the arm is limp on this line, what Enable writes of the settings, what Home, Stop and
 * Disable do, what the servos do when the page is gone, and how long the Worker waits for the answer. Where
 * Enable will change settings that survive a power cycle, the item "eeprom" is a warning that says how many and
 * has one row for each: the operator's tick is given to that list. */
export function confirmationItems(report: PreflightReport, wording: Wording, limitMs: number = ARMING_LIMIT_MS): ConfirmItem[] {
  const { t, count, listed } = wording;
  const items: ConfirmItem[] = [];
  const add = (kind: string, text: string, tone: ConfirmItem["tone"] = "info", rows: readonly string[] = []): void => {
    items.push({ kind, tone, text, rows });
  };

  // said first and as a warning: until this step has run on a real arm, whoever confirms must know that it has not
  add("untried", t("station.arming.confirm.untried"), "warn");
  if (report.singleReads === null) add("limp", t("station.arming.confirm.limp.unmeasured"), "warn");
  else {
    add(
      "limp",
      t("station.arming.confirm.limp", {
        ms: count(Math.round(report.singleReads.totalMs)),
        count: count(report.singleReads.count),
      }),
    );
  }
  add("rest", t("station.arming.confirm.rest"));

  const settings = report.settings;
  const kept = (settings ?? []).filter((setting) => setting.area === "eeprom");
  const changes = eepromChanges(report);
  if (settings === null) add("eeprom", t("station.arming.confirm.eeprom.notRead"), "warn");
  else if (changes.length === 0) add("eeprom", t("station.arming.confirm.eeprom", { count: count(kept.length) }));
  else {
    // what the operator's tick is given to: every register of every servo that will hold another value for good
    add(
      "eeprom",
      t("station.arming.confirm.eeprom.changed", { count: count(changes.length), total: count(kept.length) }),
      "warn",
      changes.map((setting) => settingRow(setting, report, wording)),
    );
  }
  if (settings !== null) {
    const ram = settingRows(settings, "ram", wording);
    if (ram.length > 0) add("ram", t("station.arming.confirm.ram", { rows: listed(ram) }));
    const factory = settingRows(settings, "factory", wording);
    const isChanged = settings.some((setting) => setting.area === "factory" && setting.held !== setting.pear);
    if (factory.length > 0) add("factory", t("station.arming.confirm.factory", { rows: listed(factory) }), isChanged ? "warn" : "info");
  }

  add("home", t("station.arming.confirm.home"));
  add("steps", t("station.arming.confirm.steps"));
  add("execute", t("station.arming.confirm.execute"));
  add("stop", t("station.arming.confirm.stop"));
  add("disable", t("station.arming.confirm.disable"));
  add("lost", t("station.arming.confirm.lost"));
  const warnings = reportWarnings(report, wording);
  if (warnings > 0) add("warnings", t("station.arming.confirm.warnings", { count: count(warnings) }), "warn");
  add("limit", t("station.arming.confirm.limit", { minutes: count(Math.round(limitMs / 60_000)) }));

  return items;
}

/** Returns the words beside the confirmation's tick box. Where PEAR's enable will change settings that survive a
 * power cycle, they end with one more sentence: the person accepts that the settings listed above are changed
 * in the servos. */
export function tickLabel(report: PreflightReport, wording: Wording): string {
  const tick = wording.t("station.arming.confirm.tick");

  return changesEeprom(report) ? wording.t("station.arming.confirm.tick.settings", { tick }) : tick;
}

/** Returns what the log is told, with the operator's confirmation, of the settings that survive a power cycle:
 * how many PEAR's enable will change, and each one by its servo's id and its register's address, with the value
 * held and the value PEAR writes. The log's lines are English, as all of them are. */
export function eepromChangesLogged(report: PreflightReport): string {
  if (report.settings === null) return "what Enable writes of the servos' settings was not read";
  const changes = eepromChanges(report);
  if (changes.length === 0) return "no setting that survives a power cycle will be changed";
  const rows = changes.map(
    (setting) => `servo ${setting.id} address ${setting.address} holds ${setting.held}, PEAR writes ${setting.pear}`,
  );

  return `${changes.length} of the settings that survive a power cycle will be changed: ${rows.join("; ")}`;
}

/** Returns the report as the page shows it for the request "enableReal". While the Worker still has the line
 * open (`isLineOpen`: the event "arming", whose report says `isClosed` false for that reason), the sentence
 * about the line says so; of the request's result the report says whether the line was given back. */
export function armingReportParts(report: PreflightReport, wording: Wording, isLineOpen: boolean): PreflightPart[] {
  const parts = preflightParts(report, wording);
  if (!isLineOpen) return parts;

  return parts.map((part) =>
    part.kind === "closed"
      ? { type: "sentence", kind: "closed", tone: "info", text: wording.t("station.arming.line.open"), detail: null }
      : part,
  );
}

/** How the page says that the request ended "refused": by the operator's Cancel ("cancelled"), with an answer
 * that came after the Worker's wait ("confirmed"), or with no answer at all (null). */
export function refusedSentence(answer: "confirmed" | "cancelled" | null, wording: Wording, limitMs: number = ARMING_LIMIT_MS): string {
  const { t, count } = wording;
  if (answer === "cancelled") return t("station.arming.refused.cancelled");
  if (answer === "confirmed") return t("station.arming.refused.late");

  return t("station.arming.refused.noAnswer", { minutes: count(Math.round(limitMs / 60_000)) });
}

/** A real arm's line while the station holds the arm: one line of numbers, and the two messages that stay. */
export interface LineSentences {
  /** What the guard let through and refused, and the line's errors. */
  readonly line: string;
  /** The port is lost: what the servos do now and how the arm is released; null while the line is there. */
  readonly lost: string | null;
  /** The guard refused packets: the refusals' words and what to do; null while it refused none. */
  readonly refused: string | null;
}

export function lineSentences(line: RealLineStatus, wording: Wording): LineSentences {
  const { t, count, listed } = wording;
  const names = Object.entries(line.passed).map(([name, packets]) => `${name} ${count(packets)}`);

  return {
    line: t("station.real.line", {
      passed: names.length === 0 ? t("station.real.line.nothing") : listed(names),
      refused: count(line.refused),
      errors: count(line.lineErrors),
    }),
    lost: line.isLost ? t("station.real.lost") : null,
    refused:
      line.refused > 0
        ? t("station.real.refused", { count: count(line.refused), words: line.refusals.join(t("station.timing.fail.join")) })
        : null,
  };
}

/** Returns the words of the refusals after the first `seen`, as far as the status still holds them (it holds
 * the last five): what the log has not been told yet. */
export function refusalsSince(line: RealLineStatus, seen: number): string[] {
  const fresh = Math.max(0, line.refused - seen);

  return fresh === 0 ? [] : line.refusals.slice(-Math.min(fresh, line.refusals.length));
}
