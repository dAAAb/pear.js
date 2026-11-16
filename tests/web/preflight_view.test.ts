// The report of the hand-over check of a real arm's line is read by someone who is alone with the arm, and what
// is decided next rests on it. This test holds its view (web/src/preflight_view.ts) to the report without a
// browser: a full report, every stop, settings that differ and settings that do not, a guard that refused
// something, in both languages, and that every text it uses exists in both.

import { describe, expect, it } from "vitest";

import {
  changedSettings,
  type PreflightPart,
  type PreflightSentence,
  type PreflightTable,
  preflightParts,
  type Wording,
} from "../../web/src/preflight_view";
import type {
  PreflightReport,
  PreflightServo,
  PreflightSetting,
  PreflightStop,
  TimingCheck,
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
    homingOffset: index === 1 ? -1024 : 12 * index,
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

/** Four registers for each of the six servos, each holding what PEAR's enable writes. */
function settings(): PreflightSetting[] {
  return NAMES.flatMap((_, index): PreflightSetting[] => [
    { id: index + 1, register: "Return_Delay_Time", address: 7, bytes: 1, area: "eeprom", pear: 0, held: 0 },
    { id: index + 1, register: "P_Coefficient", address: 21, bytes: 1, area: "eeprom", pear: 16, held: 16 },
    { id: index + 1, register: "Acceleration", address: 41, bytes: 1, area: "ram", pear: 254, held: 254 },
    { id: index + 1, register: "Maximum_Acceleration", address: 85, bytes: 1, area: "factory", pear: 254, held: 254 },
  ]);
}

const PASSED: TimingCheck = {
  periods: 150,
  meanMs: 20.004,
  maxMs: 21.37,
  over25: 0,
  maxReadMs: 3.918,
  failures: [],
  reasons: [],
};

/** A report of a preflight that read everything and found nothing to remark. */
function fullReport(more: Partial<PreflightReport> = {}): PreflightReport {
  return {
    ports: [{ vendorId: 0x1a86, productId: 0x55d3 }],
    stop: null,
    detail: "",
    servos: NAMES.map((_, index) => servo(index, index === 1 ? { torque: 1 } : index === 2 ? { torque: 128 } : {})),
    settings: settings(),
    singleReads: { count: 14, totalMs: 61.237, maxMs: 6.5 },
    timing: PASSED,
    guard: { passed: { PING: 6, READ: 1234, "SYNC READ": 151 }, refused: 0 },
    lineErrors: 0,
    isClosed: true,
    tookMs: 4321.6,
    ...more,
  };
}

/** A report of a preflight that stopped at `stop` before it had read a servo. */
function stoppedReport(stop: PreflightStop): PreflightReport {
  const hasSerial = stop !== "no-serial";
  return fullReport({
    ports: !hasSerial ? null : stop === "no-port" ? [] : [{ vendorId: 0x1a86, productId: 0x55d3 }, null],
    stop,
    detail: `the Worker's words for ${stop}`,
    servos: null,
    settings: null,
    singleReads: null,
    timing: null,
    guard: { passed: stop === "handshake-failed" || stop === "other-arm" || stop === "line-lost" ? { PING: 6 } : {}, refused: 0 },
  });
}

const STOPS: readonly PreflightStop[] = [
  "no-serial",
  "no-port",
  "several-ports",
  "open-failed",
  "handshake-failed",
  "other-arm",
  "line-lost",
];

/** Settings of which four differ from PEAR's: two in the EEPROM, one in the RAM, one in the factory block. */
function differingSettings(): PreflightSetting[] {
  return settings().map((setting) =>
    (setting.id === 1 && setting.register === "P_Coefficient") ||
    (setting.id === 2 && setting.register === "Return_Delay_Time") ||
    (setting.id === 3 && setting.register === "Acceleration") ||
    (setting.id === 6 && setting.register === "Maximum_Acceleration")
      ? { ...setting, held: setting.pear + 34 }
      : setting,
  );
}

const FAILED: TimingCheck = {
  ...PASSED,
  maxMs: 41.2,
  failures: ["a period took 41.2 ms (limit 40 ms)", "the page is not visible"],
  reasons: [
    { code: "period", value: 41.2, limit: 40 },
    { code: "hidden", value: null, limit: null },
  ],
};

/** Every report the tests below look at: between them they reach every text of the view. */
function everyReport(): PreflightReport[] {
  return [
    fullReport(),
    ...STOPS.map(stoppedReport),
    fullReport({ settings: differingSettings() }),
    fullReport({ guard: { passed: { PING: 6 }, refused: 2 } }),
    fullReport({ timing: FAILED, lineErrors: 3, isClosed: false }),
  ];
}

function sentenceOf(parts: readonly PreflightPart[], kind: string): PreflightSentence {
  const found = parts.filter((part): part is PreflightSentence => part.type === "sentence" && part.kind === kind);
  expect(found, `one sentence "${kind}"`).toHaveLength(1);

  return found[0] as PreflightSentence;
}

function tablesOf(parts: readonly PreflightPart[], kind: string): PreflightTable[] {
  return parts.filter((part): part is PreflightTable => part.type === "table" && part.kind === kind);
}

/** Every string a person would read of `parts`. */
function stringsOf(parts: readonly PreflightPart[]): string[] {
  return parts.flatMap((part) =>
    part.type === "sentence" ? [part.text] : [part.title, ...part.head, ...part.rows.flat()],
  );
}

describe("a full report", () => {
  it("is said in English, with every number", () => {
    const parts = preflightParts(fullReport(), wordingOf("en"));

    expect(parts.map((part) => `${part.type}:${part.kind}`)).toEqual([
      "sentence:outcome",
      "sentence:ports",
      "sentence:closed",
      "table:servos",
      "table:identity",
      "sentence:settings",
      "sentence:limp",
      "sentence:timing",
      "sentence:guard",
      "sentence:lineErrors",
      "sentence:took",
    ]);
    expect(sentenceOf(parts, "outcome")).toMatchObject({ tone: "ok", text: EN["station.preflight.outcome.read"], detail: null });
    expect(sentenceOf(parts, "ports")).toMatchObject({
      tone: "info",
      text: "Ports the Worker was given (1): USB vendor 1a86, product 55d3.",
    });
    expect(sentenceOf(parts, "closed")).toMatchObject({ tone: "ok", text: EN["station.preflight.closed.yes"] });
    expect(sentenceOf(parts, "settings")).toMatchObject({
      tone: "ok",
      text: "PEAR's enable would change no setting: the 24 registers it writes besides the goal, the torque and the lock already hold its values.",
    });
    expect(sentenceOf(parts, "limp").text).toBe(
      "The limp time: PEAR's enable switches each servo's torque off for the time of 14 transactions. On this line 14 single reads took 61.24 ms together, the longest of them 6.50 ms.",
    );
    expect(sentenceOf(parts, "timing")).toMatchObject({
      tone: "ok",
      text: "Timing self-check on this line (reads only): 150 control periods, mean 20.00 ms, longest 21.37 ms, 0 over 25 ms, longest read 3.92 ms: passed.",
    });
    expect(sentenceOf(parts, "guard")).toMatchObject({
      tone: "ok",
      text: "The read-only guard let through: PING 6, READ 1,234, SYNC READ 151. It refused nothing.",
    });
    expect(sentenceOf(parts, "lineErrors")).toMatchObject({ tone: "ok", text: EN["station.preflight.lineErrors.none"] });
    expect(sentenceOf(parts, "took").text).toBe("The whole check took 4,322 ms.");
  });

  it("shows the six servos as found, the torque in a word and every register as read", () => {
    const [servos] = tablesOf(preflightParts(fullReport(), wordingOf("en")), "servos");

    expect(servos?.title).toBe(EN["station.preflight.servos.title"]);
    expect(servos?.head).toEqual([
      "Servo (ID)",
      "Torque",
      "Lock",
      "Status",
      "Voltage (V)",
      "Temperature (°C)",
      "Goal_Velocity",
      "Torque_Limit",
      "Phase",
      "Present_Position",
      "Goal_Position",
    ]);
    expect(servos?.numeric).toHaveLength(servos?.head.length ?? 0);
    expect(servos?.rows).toEqual([
      ["shoulder_pan (1)", "off", "1", "0", "12.1", "30", "0", "1000", "12", "2048", "2047"],
      ["shoulder_lift (2)", "on", "1", "0", "12.1", "31", "0", "1000", "12", "2049", "2048"],
      ["elbow_flex (3)", "128", "1", "0", "12.1", "32", "0", "1000", "12", "2050", "2049"],
      ["wrist_flex (4)", "off", "1", "0", "12.1", "33", "0", "1000", "12", "2051", "2050"],
      ["wrist_roll (5)", "off", "1", "0", "12.1", "34", "0", "1000", "12", "2052", "2051"],
      ["gripper (6)", "off", "1", "0", "12.1", "35", "0", "1000", "12", "2053", "2052"],
    ]);
  });

  it("shows what tells the arm from another, a negative offset with a true minus sign", () => {
    const [identity] = tablesOf(preflightParts(fullReport(), wordingOf("en")), "identity");

    expect(identity?.head).toEqual(["Servo (ID)", "Model_Number", "Firmware", "Homing_Offset", "Min_Position_Limit", "Max_Position_Limit"]);
    expect(identity?.rows[0]).toEqual(["shoulder_pan (1)", "777", "3.10", "0", "700", "3300"]);
    expect(identity?.rows[1]).toEqual(["shoulder_lift (2)", "777", "3.10", "−1024", "701", "3301"]);
    expect(identity?.rows).toHaveLength(6);
  });

  it("is said in Chinese with the same numbers", () => {
    const parts = preflightParts(fullReport(), wordingOf("zh-TW"));

    expect(sentenceOf(parts, "outcome").text).toBe(ZH_TW["station.preflight.outcome.read"]);
    expect(sentenceOf(parts, "ports").text).toBe("Worker 拿到的埠（1 個）：USB 廠商 1a86、產品 55d3。");
    expect(sentenceOf(parts, "timing").text).toBe(
      "這條線路上的計時自我檢查（只讀取）：150 個控制週期，平均 20.00 ms，最長 21.37 ms，0 個超過 25 ms，最長的一次讀取 3.92 ms：通過。",
    );
    expect(sentenceOf(parts, "guard").text).toBe("唯讀保護放行了：PING 6、READ 1,234、SYNC READ 151。它沒有擋下任何封包。");
    expect(sentenceOf(parts, "took").text).toBe("整個檢查花了 4,322 ms。");
    expect(sentenceOf(parts, "limp").text).toContain("14 次單獨讀取一共花了 61.24 ms，其中最長的一次 6.50 ms");
    const [servos] = tablesOf(parts, "servos");
    expect(servos?.head[0]).toBe("伺服馬達（ID）");
    expect(servos?.rows[1]).toEqual(["shoulder_lift (2)", "開", "1", "0", "12.1", "31", "0", "1000", "12", "2049", "2048"]);
    // the numbers of the tables are the same in both languages
    const english = preflightParts(fullReport(), wordingOf("en"));
    expect(tablesOf(parts, "identity")[0]?.rows).toEqual(tablesOf(english, "identity")[0]?.rows);
  });
});

describe("a report that stopped", () => {
  for (const language of LANGUAGES) {
    for (const stop of STOPS) {
      it(`says what the person can do after "${stop}" (${language})`, () => {
        const parts = preflightParts(stoppedReport(stop), wordingOf(language));

        expect(sentenceOf(parts, "outcome")).toEqual({
          type: "sentence",
          kind: "outcome",
          tone: "error",
          text: TEXTS[language][`station.preflight.stop.${stop}`],
          detail: `the Worker's words for ${stop}`,
        });
        // what was not read is said, and no table is made of it
        expect(sentenceOf(parts, "servos")).toMatchObject({ tone: "info", text: TEXTS[language]["station.preflight.servos.none"] });
        expect(sentenceOf(parts, "settings").text).toBe(TEXTS[language]["station.preflight.settings.notRead"]);
        expect(sentenceOf(parts, "limp").text).toBe(TEXTS[language]["station.preflight.limp.none"]);
        expect(sentenceOf(parts, "timing").text).toBe(TEXTS[language]["station.preflight.timing.none"]);
        expect(parts.filter((part) => part.type === "table")).toEqual([]);
        expect(sentenceOf(parts, "guard").tone).toBe("ok");
      });
    }

    it(`has a sentence of its own for every stop (${language})`, () => {
      const texts = STOPS.map((stop) => sentenceOf(preflightParts(stoppedReport(stop), wordingOf(language)), "outcome").text);

      expect(new Set(texts).size).toBe(STOPS.length);
      for (const text of texts) expect(text.length).toBeGreaterThan(30);
    });
  }

  it("says which ports the Worker was given, or that it has no serial API", () => {
    const en = wordingOf("en");

    expect(sentenceOf(preflightParts(stoppedReport("no-serial"), en), "ports")).toMatchObject({
      tone: "warn",
      text: EN["station.preflight.ports.noSerial"],
    });
    expect(sentenceOf(preflightParts(stoppedReport("no-port"), en), "ports")).toMatchObject({
      tone: "warn",
      text: EN["station.preflight.ports.empty"],
    });
    expect(sentenceOf(preflightParts(stoppedReport("several-ports"), en), "ports")).toMatchObject({
      tone: "info",
      text: "Ports the Worker was given (2): USB vendor 1a86, product 55d3, a port without USB ids.",
    });
    expect(sentenceOf(preflightParts(stoppedReport("several-ports"), wordingOf("zh-TW")), "ports").text).toBe(
      "Worker 拿到的埠（2 個）：USB 廠商 1a86、產品 55d3、一個沒有 USB 識別碼的埠。",
    );
    // a guard that let nothing through says so in place of a list
    expect(sentenceOf(preflightParts(stoppedReport("no-port"), en), "guard").text).toBe(
      "The read-only guard let through: no packet. It refused nothing.",
    );
  });

  it("gives no detail when the Worker gave none", () => {
    const report = { ...stoppedReport("open-failed"), detail: "" };

    expect(sentenceOf(preflightParts(report, wordingOf("en")), "outcome").detail).toBeNull();
  });
});

describe("what PEAR's enable would change", () => {
  it("is the rows whose value differs, the EEPROM ones marked as surviving a power cycle", () => {
    const report = fullReport({ settings: differingSettings() });
    const parts = preflightParts(report, wordingOf("en"));

    expect(changedSettings(report).map((setting) => `${setting.id}:${setting.register}`)).toEqual([
      "1:P_Coefficient",
      "2:Return_Delay_Time",
      "3:Acceleration",
      "6:Maximum_Acceleration",
    ]);
    expect(sentenceOf(parts, "settings")).toMatchObject({
      tone: "warn",
      text: "PEAR's enable would change 4 of the 24 settings it writes besides the goal, the torque and the lock. 2 of them are in the EEPROM and survive a power cycle.",
    });
    const tables = tablesOf(parts, "settings");
    expect(tables).toHaveLength(1);
    expect(tables[0]?.title).toBe("What PEAR's enable would change");
    expect(tables[0]?.head).toEqual(["Servo (ID)", "Register", "Address", "Holds now", "PEAR writes", "Where it is kept"]);
    expect(tables[0]?.rows).toEqual([
      ["shoulder_pan (1)", "P_Coefficient", "21", "50", "16", "EEPROM: survives a power cycle"],
      ["shoulder_lift (2)", "Return_Delay_Time", "7", "34", "0", "EEPROM: survives a power cycle"],
      ["elbow_flex (3)", "Acceleration", "41", "288", "254", "RAM: lost when the power goes off"],
      ["gripper (6)", "Maximum_Acceleration", "85", "288", "254", "factory block: not known whether it survives a power cycle"],
    ]);
  });

  it("is said in Chinese with the same rows", () => {
    const parts = preflightParts(fullReport({ settings: differingSettings() }), wordingOf("zh-TW"));

    expect(sentenceOf(parts, "settings").text).toBe(
      "除了目標位置、扭力和 Lock 之外，PEAR 啟用時會寫入 24 個設定，其中 4 個會被更動。這些當中有 2 個在 EEPROM 裡，斷電重開之後仍然保留。",
    );
    expect(tablesOf(parts, "settings")[0]?.rows[0]).toEqual(["shoulder_pan (1)", "P_Coefficient", "21", "50", "16", "EEPROM：斷電重開後仍保留"]);
    expect(tablesOf(parts, "settings")[0]?.rows).toHaveLength(4);
  });

  it("is one sentence and no table when no setting differs", () => {
    for (const language of LANGUAGES) {
      const report = fullReport();
      const parts = preflightParts(report, wordingOf(language));

      expect(changedSettings(report)).toEqual([]);
      expect(tablesOf(parts, "settings")).toEqual([]);
      expect(sentenceOf(parts, "settings")).toMatchObject({
        tone: "ok",
        text: TEXTS[language]["station.preflight.settings.none"].replace("{total}", "24"),
      });
    }
  });

  it("names a servo that is not among the six by its id", () => {
    const report = fullReport({
      settings: [{ id: 9, register: "P_Coefficient", address: 21, bytes: 1, area: "eeprom", pear: 16, held: 32 }],
    });

    expect(tablesOf(preflightParts(report, wordingOf("en")), "settings")[0]?.rows[0]?.[0]).toBe("#9");
  });
});

describe("what must be reported or known", () => {
  it("shows a guard that refused something as a defect, in both languages", () => {
    const report = fullReport({ guard: { passed: { PING: 6 }, refused: 2 } });
    const english = sentenceOf(preflightParts(report, wordingOf("en")), "guard");
    const chinese = sentenceOf(preflightParts(report, wordingOf("zh-TW")), "guard");

    expect(english.tone).toBe("error");
    expect(english.text).toBe(
      "The read-only guard refused 2 packets (it let through: PING 6). No refused packet reached the arm, but this check should never try to send one: that is a defect of the page. Please report it with the log.",
    );
    expect(chinese.tone).toBe("error");
    expect(chinese.text).toContain("唯讀保護擋下了 2 個封包（放行的有：PING 6）");
    expect(chinese.text).toContain("缺陷");
    // and a guard that refused nothing is not one
    expect(sentenceOf(preflightParts(fullReport(), wordingOf("en")), "guard").tone).toBe("ok");
  });

  it("gives the reasons of a timing self-check that failed, with their numbers", () => {
    const report = fullReport({ timing: FAILED });

    expect(sentenceOf(preflightParts(report, wordingOf("en")), "timing")).toMatchObject({
      tone: "warn",
      text: "Timing self-check on this line (reads only): 150 control periods, mean 20.00 ms, longest 41.20 ms, 0 over 25 ms, longest read 3.92 ms: failed, so the station would not enable on this line (a period took 41.2 ms (limit 40 ms); the page is not visible).",
    });
    expect(sentenceOf(preflightParts(report, wordingOf("zh-TW")), "timing").text).toContain(
      "未通過，所以工作站在這條線路上不會啟用（有一個週期花了 41.2 ms（上限 40 ms）；頁面目前沒有顯示在畫面上）",
    );
    // a check that gave its reasons only in words is told in those words
    const worded = fullReport({ timing: { ...FAILED, reasons: [] } });
    expect(sentenceOf(preflightParts(worded, wordingOf("en")), "timing").text).toContain(
      "(a period took 41.2 ms (limit 40 ms); the page is not visible)",
    );
  });

  it("says that the Worker did not give the line back and that reloading does, and counts the line's errors", () => {
    const report = fullReport({ isClosed: false, lineErrors: 3 });
    for (const language of LANGUAGES) {
      const parts = preflightParts(report, wordingOf(language));

      expect(sentenceOf(parts, "closed")).toMatchObject({ tone: "error", text: TEXTS[language]["station.preflight.closed.no"] });
      expect(sentenceOf(parts, "lineErrors").tone).toBe("warn");
      expect(sentenceOf(parts, "lineErrors").text).toBe(TEXTS[language]["station.preflight.lineErrors.some"].replace("{errors}", "3"));
    }
    expect(EN["station.preflight.closed.no"]).toContain("Reload the page");
    expect(ZH_TW["station.preflight.closed.no"]).toContain("重新載入頁面");
  });
});

describe("the texts of the report", () => {
  /** The keys the page itself uses for the control, outside the view. */
  const OF_THE_PAGE = ["run", "note", "running", "failed", "title"].map((name) => `station.preflight.${name}`);

  it("every key the view uses exists in both languages, and every key of the report is used", () => {
    const used = new Set<string>();
    for (const language of LANGUAGES) {
      for (const report of everyReport()) preflightParts(report, wordingOf(language, used));
    }

    expect(used.size).toBeGreaterThan(50);
    for (const key of used) {
      expect(typeof (EN as Record<string, string>)[key], `EN has ${key}`).toBe("string");
      expect(typeof (ZH_TW as Record<string, string>)[key], `ZH_TW has ${key}`).toBe("string");
      expect((EN as Record<string, string>)[key], `EN ${key} is not empty`).not.toBe("");
      expect((ZH_TW as Record<string, string>)[key], `ZH_TW ${key} is not empty`).not.toBe("");
    }
    const ofTheReport = Object.keys(EN).filter((key) => key.startsWith("station.preflight.") && !OF_THE_PAGE.includes(key));
    expect(ofTheReport.filter((key) => !used.has(key))).toEqual([]);
    for (const key of OF_THE_PAGE) {
      expect((EN as Record<string, string>)[key], `EN has ${key}`).toBeTruthy();
      expect((ZH_TW as Record<string, string>)[key], `ZH_TW has ${key}`).toBeTruthy();
    }
  });

  it("both languages take the same values, and none is left unfilled", () => {
    const names = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort();
    for (const key of Object.keys(EN).filter((candidate) => candidate.startsWith("station.preflight."))) {
      expect(names(ZH_TW[key as TextKey]), key).toEqual(names(EN[key as TextKey]));
    }
    for (const language of LANGUAGES) {
      for (const report of everyReport()) {
        for (const text of stringsOf(preflightParts(report, wordingOf(language)))) expect(text).not.toMatch(/\{\w+\}/);
      }
    }
  });

  it("the Chinese of a sentence is not its English", () => {
    for (const report of everyReport()) {
      const english = preflightParts(report, wordingOf("en"));
      const chinese = preflightParts(report, wordingOf("zh-TW"));

      expect(chinese.map((part) => `${part.type}:${part.kind}`)).toEqual(english.map((part) => `${part.type}:${part.kind}`));
      english.forEach((part, index) => {
        const other = chinese[index] as PreflightPart;
        if (part.type === "sentence" && other.type === "sentence") {
          expect(other.tone).toBe(part.tone);
          expect(other.text).not.toBe(part.text);
          expect(other.text).toMatch(/[一-鿿]/);
        }
      });
    }
  });
});
