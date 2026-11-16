// What the page says before the first write to a real arm's servos is the only briefing the person beside the
// arm gets. This test holds the view of it (web/src/arming_view.ts) to what the Worker reports, without a
// browser: every reason against enabling with what the person can do, the confirmation's list with this line's
// numbers, the real line's sentences (lost, refused), in both languages, and that every text it uses exists in
// both.

import { describe, expect, it } from "vitest";

import {
  allBlockers,
  armingReportParts,
  blockerSentences,
  confirmationItems,
  lineSentences,
  refusalsSince,
  refusedSentence,
  reportBlockers,
} from "../../web/src/arming_view";
import type { Wording } from "../../web/src/preflight_view";
import type {
  ArmingBlocker,
  PreflightReport,
  PreflightServo,
  PreflightSetting,
  RealLineStatus,
} from "../../web/src/station_protocol";
import { EN, type TextKey, ZH_TW } from "../../web/src/texts";

type Language = "en" | "zh-TW";
const LANGUAGES: readonly Language[] = ["en", "zh-TW"];
const TEXTS: Record<Language, Record<TextKey, string>> = { en: EN, "zh-TW": ZH_TW };

/** The page's wording over one language, as i18n.ts gives it, and the keys that were asked for. */
function wordingOf(language: Language, used: Set<string> = new Set()): Wording & { used: Set<string> } {
  return {
    used,
    t: (key, values = {}) => {
      used.add(key);
      return TEXTS[language][key].replace(/\{(\w+)\}/g, (whole, name: string) =>
        Object.hasOwn(values, name) ? String(values[name]) : whole,
      );
    },
    count: (value) => value.toLocaleString(language === "zh-TW" ? "zh-TW" : "en-US"),
    listed: (names) => names.join(language === "zh-TW" ? "、" : ", "),
  };
}

const NAMES = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"] as const;

function servo(index: number, more: Partial<PreflightServo> = {}): PreflightServo {
  return {
    id: index + 1,
    name: NAMES[index] as string,
    model: 777,
    firmware: "3.10",
    homingOffset: 12 * (index + 1),
    rangeMin: 700 + index,
    rangeMax: 3300 + index,
    position: 2048 + index,
    goal: 2047 + index,
    torque: 0,
    lock: 1,
    status: 0,
    voltage: 121,
    temperature: 30 + index,
    goalVelocity: 0,
    torqueLimit: 1000,
    phase: 12,
    ...more,
  };
}

function setting(id: number, register: string, address: number, area: PreflightSetting["area"], pear: number, held: number): PreflightSetting {
  return { id, register, address, bytes: 1, area, pear, held };
}

/** An arm that lerobot has run, after a power cycle: the EEPROM holds PEAR's values, the RAM does not. */
function settingsOf(more: readonly PreflightSetting[] = []): PreflightSetting[] {
  return [
    ...NAMES.flatMap((_, index) => [
      setting(index + 1, "Return_Delay_Time", 7, "eeprom", 0, 0),
      setting(index + 1, "Maximum_Acceleration", 85, "factory", 254, 254),
      setting(index + 1, "Acceleration", 41, "ram", 254, index < 4 ? 0 : 254),
    ]),
    ...more,
  ];
}

function reportOf(more: Partial<PreflightReport> = {}): PreflightReport {
  return {
    ports: [{ vendorId: 0x1a86, productId: 0x55d3 }],
    stop: null,
    detail: "",
    servos: NAMES.map((_, index) => servo(index)),
    settings: settingsOf(),
    singleReads: { count: 63, totalMs: 187.42, maxMs: 4.1 },
    timing: { periods: 150, meanMs: 20.01, maxMs: 21.3, over25: 0, maxReadMs: 3.2, failures: [], reasons: [] },
    guard: { passed: { PING: 6, READ: 400, "SYNC READ": 150 }, refused: 0 },
    lineErrors: 0,
    isClosed: false,
    tookMs: 4321,
    ...more,
  };
}

const LINE: RealLineStatus = { passed: { "SYNC READ": 500, "SYNC WRITE 42": 498 }, refused: 0, refusals: [], lineErrors: 0, isLost: false };

/** No text may show a placeholder that was not filled, or the name of a key. */
function expectWhole(text: string): void {
  expect(text).not.toMatch(/\{\w+\}/);
  expect(text).not.toMatch(/station\.(arming|real|preflight)\./);
  expect(text.trim().length).toBeGreaterThan(10);
}

describe.each(LANGUAGES)("enabling on a real arm, in %s", (language) => {
  it("says every reason against enabling with what was found on this arm", () => {
    const report = reportOf({
      stop: "open-failed",
      detail: "NetworkError: Failed to open serial port.",
      servos: [servo(0, { status: 8 }), servo(1, { phase: 0x1c }), servo(2, { homingOffset: 0, rangeMin: 0, rangeMax: 4095 }), servo(3), servo(4), servo(5)],
      timing: { periods: 150, meanMs: 26, maxMs: 80, over25: 40, maxReadMs: 30, failures: ["mean 26 ms"], reasons: [{ code: "mean", value: 26, limit: 21 }] },
    });
    const row = setting(6, "Max_Torque_Limit", 16, "eeprom", 500, 1000);
    const blockers: ArmingBlocker[] = [
      { code: "stop", stop: "open-failed" },
      { code: "timing" },
      { code: "settings", rows: [row] },
      { code: "status", ids: [1] },
      { code: "phase", ids: [2] },
      { code: "uncalibrated", ids: [3] },
      { code: "calibration", detail: "gripper: range_max 3305 in the file, 3300 in the servo" },
      { code: "guard", refused: 2 },
    ];
    const sentences = blockerSentences(report, blockers, wordingOf(language));
    expect(sentences.map((sentence) => sentence.code)).toEqual(blockers.map((blocker) => blocker.code));
    for (const sentence of sentences) expectWhole(sentence.text);
    const text = (code: ArmingBlocker["code"]): string => sentences.find((sentence) => sentence.code === code)?.text ?? "";
    expect(text("stop")).toContain(wordingOf(language).t("station.preflight.stop.open-failed"));
    expect(sentences[0]?.detail).toBe("NetworkError: Failed to open serial port.");
    expect(text("timing")).toContain("26");
    expect(text("settings")).toContain("gripper (6) Max_Torque_Limit");
    expect(text("settings")).toContain("1000");
    expect(text("settings")).toContain("500");
    expect(text("settings")).toContain("lerobot");
    expect(text("status")).toContain("shoulder_pan (1)");
    expect(text("status")).toContain("8");
    expect(text("phase")).toContain("shoulder_lift (2)");
    expect(text("phase")).toContain("0x10");
    expect(text("uncalibrated")).toContain("elbow_flex (3)");
    expect(text("uncalibrated")).toContain("4095");
    expect(text("calibration")).toContain("range_max 3305 in the file");
    expect(text("guard")).toContain("2");
  });

  it("lists what the operator confirms, with this line's numbers", () => {
    const items = confirmationItems(reportOf(), wordingOf(language));
    expect(items.map((item) => item.kind)).toEqual([
      "untried", "limp", "rest", "eeprom", "ram", "factory", "home", "stop", "disable", "lost", "warnings", "limit",
    ]);
    // the list says first, as a warning, that this step has not yet run on a real arm
    expect(items[0]?.tone).toBe("warn");
    expect(items[0]?.text).toContain(
      language === "en" ? "simulated servos only and never on a real arm" : "還沒有在真實的手臂上執行過",
    );
    for (const item of items) expectWhole(item.text);
    const text = (kind: string): string => items.find((item) => item.kind === kind)?.text ?? "";
    expect(text("limp")).toContain("187 ms"); // 187.42 ms of 63 single reads
    expect(text("limp")).toContain("63");
    expect(text("eeprom")).toContain("6"); // six registers in the EEPROM, all equal
    expect(text("ram")).toContain("Acceleration");
    expect(text("ram")).toContain("41");
    expect(text("ram")).toContain("254");
    expect(text("ram")).toContain("4"); // four servos hold another value
    expect(text("factory")).toContain("Maximum_Acceleration");
    expect(text("home")).toContain("19");
    expect(text("home")).toContain("7");
    expect(text("stop")).toContain("0.15");
    expect(text("limit")).toContain("2"); // ARMING_LIMIT_MS is two minutes
    expect(items.find((item) => item.kind === "factory")?.tone).toBe("info");
    expect(confirmationItems(reportOf(), wordingOf(language), 180_000).at(-1)?.text).toContain("3");
  });

  it("does not say that nothing lasting changes when a lasting setting differs or the time was not measured", () => {
    const changed = reportOf({ settings: settingsOf([setting(6, "Max_Torque_Limit", 16, "eeprom", 500, 1000)]), singleReads: null });
    const items = confirmationItems(changed, wordingOf(language));
    const eeprom = items.find((item) => item.kind === "eeprom");
    expect(eeprom?.tone).toBe("warn");
    expect(eeprom?.text).toContain("Max_Torque_Limit");
    expect(eeprom?.text).not.toBe(wordingOf(language).t("station.arming.confirm.eeprom", { count: "7" }));
    expect(items.find((item) => item.kind === "limp")?.tone).toBe("warn");
    expect(items.find((item) => item.kind === "limp")?.text).not.toContain("63");
  });

  it("says of the report that the line is still open while the Worker waits, and whether it was given back after", () => {
    const wording = wordingOf(language);
    const open = armingReportParts(reportOf(), wording, true).find((part) => part.kind === "closed");
    expect(open).toMatchObject({ tone: "info", text: wording.t("station.arming.line.open") });
    const after = armingReportParts(reportOf(), wording, false).find((part) => part.kind === "closed");
    expect(after).toMatchObject({ tone: "error", text: wording.t("station.preflight.closed.no") });
  });

  it("says how a refused request ended", () => {
    const wording = wordingOf(language);
    expect(refusedSentence("cancelled", wording)).toBe(wording.t("station.arming.refused.cancelled"));
    expect(refusedSentence("confirmed", wording)).toBe(wording.t("station.arming.refused.late"));
    expect(refusedSentence(null, wording)).toContain("2");
    expectWhole(refusedSentence(null, wording));
  });

  it("tells a real arm's line: what passed, a lost port, the guard's refusals", () => {
    const wording = wordingOf(language);
    const quiet = lineSentences(LINE, wording);
    expectWhole(quiet.line);
    expect(quiet.line).toContain("SYNC WRITE 42 498");
    expect(quiet.lost).toBeNull();
    expect(quiet.refused).toBeNull();
    expect(lineSentences({ ...LINE, passed: {} }, wording).line).toContain(wording.t("station.real.line.nothing"));

    const lost = lineSentences({ ...LINE, isLost: true, lineErrors: 3 }, wording);
    expect(lost.lost).toBe(wording.t("station.real.lost"));
    expect(lost.line).toContain("3");

    const refused = lineSentences({ ...LINE, refused: 2, refusals: ["WRITE 40 to servo 3 refused", "WRITE 55 refused"] }, wording);
    expectWhole(refused.refused ?? "");
    expect(refused.refused).toContain("WRITE 40 to servo 3 refused");
    expect(refused.refused).toContain("WRITE 55 refused");
    expect(refused.refused).toContain("2");
  });
});

describe("the page's own look at the report", () => {
  it("finds no reason in a report that has none, and every reason the report shows", () => {
    expect(reportBlockers(reportOf())).toEqual([]);
    const row = setting(6, "Max_Torque_Limit", 16, "eeprom", 500, 1000);
    const bad = reportOf({
      servos: [servo(0, { status: 1 }), servo(1, { phase: 0x10 }), servo(2, { homingOffset: 0, rangeMin: 0, rangeMax: 4095 }), servo(3), servo(4), servo(5)],
      settings: settingsOf([row]),
      timing: null,
      guard: { passed: {}, refused: 1 },
    });
    expect(reportBlockers(bad)).toEqual([
      { code: "timing" },
      { code: "settings", rows: [row] },
      { code: "status", ids: [1] },
      { code: "phase", ids: [2] },
      { code: "uncalibrated", ids: [3] },
      { code: "guard", refused: 1 },
    ]);
    expect(reportBlockers(reportOf({ stop: "line-lost", timing: null }))).toEqual([{ code: "stop", stop: "line-lost" }]);
    // a RAM row that differs is no reason: Enable sets it anew
    expect(reportBlockers(reportOf({ settings: [setting(1, "Acceleration", 41, "ram", 254, 0)] }))).toEqual([]);
  });

  it("keeps what the Worker told and adds only what it did not tell", () => {
    const told: ArmingBlocker[] = [{ code: "status", ids: [1, 2] }];
    const report = reportOf({ servos: [servo(0, { status: 1 }), servo(1), servo(2), servo(3), servo(4), servo(5)], guard: { passed: {}, refused: 4 } });
    expect(allBlockers(report, told)).toEqual([{ code: "status", ids: [1, 2] }, { code: "guard", refused: 4 }]);
    expect(allBlockers(reportOf(), [])).toEqual([]);
  });

  it("gives the log each refusal once", () => {
    const line: RealLineStatus = { ...LINE, refused: 7, refusals: ["c", "d", "e", "f", "g"] };
    expect(refusalsSince(line, 7)).toEqual([]);
    expect(refusalsSince(line, 5)).toEqual(["f", "g"]);
    expect(refusalsSince(line, 0)).toEqual(["c", "d", "e", "f", "g"]); // it holds the last five only
    expect(refusalsSince(LINE, 0)).toEqual([]);
  });
});

describe("the texts of enabling on a real arm", () => {
  it("exist in both languages, every key the view asks for", () => {
    const used = new Set<string>();
    for (const language of LANGUAGES) {
      const wording = wordingOf(language, used);
      const report = reportOf({ stop: "other-arm", singleReads: null, settings: null });
      blockerSentences(
        reportOf({ timing: null }),
        [
          { code: "stop", stop: "other-arm" }, { code: "timing" }, { code: "settings", rows: [] }, { code: "status", ids: [9] },
          { code: "phase", ids: [1] }, { code: "uncalibrated", ids: [1] }, { code: "calibration", detail: "x" }, { code: "guard", refused: 1 },
        ],
        wording,
      );
      confirmationItems(reportOf(), wording);
      confirmationItems(report, wording);
      confirmationItems(reportOf({ settings: settingsOf([setting(1, "Acceleration", 41, "ram", 254, 254)]) }), wording);
      armingReportParts(reportOf(), wording, true);
      for (const answer of ["confirmed", "cancelled", null] as const) refusedSentence(answer, wording);
      lineSentences({ ...LINE, passed: {}, refused: 1, refusals: ["x"], isLost: true }, wording);
    }
    const own = [...used].filter((key) => key.startsWith("station.arming.") || key.startsWith("station.real."));
    expect(own.length).toBeGreaterThan(30);
    for (const key of used) {
      expect(EN[key as TextKey], key).toBeTypeOf("string");
      expect(ZH_TW[key as TextKey], key).toBeTypeOf("string");
      expect((ZH_TW[key as TextKey] ?? "").length, key).toBeGreaterThan(0);
    }
  });

  it("hold the same placeholders in both languages, and Chinese in the Chinese ones", () => {
    const keys = (Object.keys(EN) as TextKey[]).filter(
      (key) => key.startsWith("station.arming.") || key.startsWith("station.real.") || key.endsWith("Real"),
    );
    expect(keys.length).toBeGreaterThan(60);
    const holes = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort();
    for (const key of keys) {
      expect(holes(ZH_TW[key]), key).toEqual(holes(EN[key]));
      if (key !== "station.arming.servo.value") expect(ZH_TW[key], key).toMatch(/[一-鿿]/);
    }
  });
});
