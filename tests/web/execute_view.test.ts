// "Execute this action" is the page's one way from a model's answer to the arm. This test holds its view
// (web/src/execute_view.ts) to the rules without a browser: what is a large action and what is not, the sentences
// of the row a real arm's first press shows, in both languages, when the control is offered (the station enabled
// and idle, an action in the answer, asked from the station's state, not spent) and why it is not, and that every
// text the view uses exists in both languages.

import { describe, expect, it } from "vitest";

import {
  type ActionParts,
  actionSentence,
  type ExecuteFacts,
  executeOffer,
  executeRow,
  LARGE_CM,
  LARGE_RAD,
  largeParts,
  largeWarning,
  signed,
} from "../../web/src/execute_view";
import type { Wording } from "../../web/src/preflight_view";
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

function action(arm: Partial<ActionParts["arm"]> = {}, width = 0): ActionParts {
  return { arm: { x: 0, y: 0, z: 0, pitch: 0, roll: 0, ...arm }, gripper: { width } };
}

/** The facts of an answer that may be executed: each test changes one of them. */
const OFFERED: ExecuteFacts = {
  hasAction: true,
  source: "station",
  isEnabled: true,
  isSameHold: true,
  isSpent: false,
  isIdle: true,
};

describe("a large action", () => {
  it("is x, y or z over 5 cm and pitch or roll over 0.5 rad, either way", () => {
    expect(LARGE_CM).toBe(5);
    expect(LARGE_RAD).toBe(0.5);
    expect(largeParts(action({ x: 5.1 }))).toEqual([{ name: "x", value: 5.1, unit: "cm" }]);
    expect(largeParts(action({ y: -5.1 }))).toEqual([{ name: "y", value: -5.1, unit: "cm" }]);
    expect(largeParts(action({ z: 12 }))).toEqual([{ name: "z", value: 12, unit: "cm" }]);
    expect(largeParts(action({ pitch: 0.51 }))).toEqual([{ name: "pitch", value: 0.51, unit: "rad" }]);
    expect(largeParts(action({ roll: -0.6 }))).toEqual([{ name: "roll", value: -0.6, unit: "rad" }]);
  });

  it("is not a part at the limit or under it, nor the gripper's command", () => {
    expect(largeParts(action())).toEqual([]);
    expect(largeParts(action({ x: 5, y: -5, z: 5, pitch: 0.5, roll: -0.5 }))).toEqual([]);
    expect(largeParts(action({ x: 1, y: -4.9, z: 0.1, pitch: 0.05, roll: -0.49 }, 1))).toEqual([]);
    expect(largeParts(action({}, -1))).toEqual([]);
    // a rotation is not measured against the centimetres' limit, nor a translation against the radians'
    expect(largeParts(action({ x: 0.6, pitch: 0.4 }))).toEqual([]);
  });

  it("names every large part, in the order the model writes them", () => {
    expect(largeParts(action({ roll: 1, x: -6, z: 7, pitch: -0.7 })).map((part) => part.name)).toEqual(["x", "z", "pitch", "roll"]);
  });

  it("counts a part that is no number as large", () => {
    expect(largeParts(action({ x: Number.NaN })).map((part) => part.name)).toEqual(["x"]);
    expect(largeParts(action({ roll: Number.POSITIVE_INFINITY })).map((part) => part.name)).toEqual(["roll"]);
  });
});

describe("the action in words", () => {
  it("writes each part with its sign and the format's decimals", () => {
    expect(signed(1, 1)).toBe("+1.0");
    expect(signed(-0.05, 2)).toBe("−0.05");
    expect(signed(0, 1)).toBe("+0.0");
    const english = actionSentence(action({ x: 1.5, y: -2, pitch: -0.05 }, 1), wordingOf("en"));
    expect(english).toContain("x +1.5 cm");
    expect(english).toContain("y −2.0 cm");
    expect(english).toContain("pitch −0.05 rad");
    expect(english).toContain("open the gripper");
    const chinese = actionSentence(action({ x: 1.5, y: -2, pitch: -0.05 }, -1), wordingOf("zh-TW"));
    expect(chinese).toContain("x +1.5 公分");
    expect(chinese).toContain("pitch −0.05 弧度");
    expect(chinese).toContain(ZH_TW["ask.gripper.close"]);
    expect(actionSentence(action(), wordingOf("en"))).toContain(EN["ask.gripper.hold"]);
  });
});

describe("the row of a real arm's second press", () => {
  it("says the action in words once more and that the arm moves at the press, in both languages", () => {
    for (const language of LANGUAGES) {
      const wording = wordingOf(language);
      const small = action({ x: 1, z: -2.5, roll: 0.1 }, 1);
      const row = executeRow(small, wording);
      expect(row.ask).toContain(actionSentence(small, wording));
      expect(row.ask).toContain(TEXTS[language]["execute.real.go"]);
      expect(row.ask).not.toMatch(/\{\w+\}/);
      expect(row.warning).toBeNull();
    }
    expect(executeRow(action(), wordingOf("en")).ask).toContain("real arm");
    expect(executeRow(action(), wordingOf("zh-TW")).ask).toContain("真實的手臂");
  });

  it("warns of a large action: which parts, and what PEAR checks and does not look for", () => {
    const big = action({ x: 6.2, y: 1, pitch: -0.75 });
    const english = executeRow(big, wordingOf("en")).warning ?? "";
    expect(english).toContain("x +6.2 cm");
    expect(english).toContain("pitch −0.75 rad");
    expect(english).not.toContain("y +1.0");
    expect(english).toContain("reach");
    expect(english).toContain("limits");
    expect(english).toContain("obstacle");
    expect(english).toContain("table");
    expect(english).not.toMatch(/\{\w+\}/);
    const chinese = executeRow(big, wordingOf("zh-TW")).warning ?? "";
    expect(chinese).toContain("x +6.2 公分");
    expect(chinese).toContain("pitch −0.75 弧度");
    expect(chinese).toContain("障礙物");
    expect(chinese).toContain("桌面");
    expect(chinese).toContain("關節");
    expect(chinese).not.toMatch(/\{\w+\}/);
    for (const language of LANGUAGES) {
      expect(largeWarning(action({ x: 5, roll: 0.5 }), wordingOf(language))).toBeNull();
      expect(largeWarning(action({ z: -5.5 }), wordingOf(language))).toContain("z −5.5");
    }
  });
});

describe("Execute this action", () => {
  it("is offered for an answer's action asked from the station that holds the arm, enabled and idle, not spent", () => {
    expect(executeOffer(OFFERED)).toEqual({ isShown: true, isOffered: true, why: null });
  });

  it("is not shown without an action in the answer", () => {
    expect(executeOffer({ ...OFFERED, hasAction: false })).toEqual({ isShown: false, isOffered: false, why: null });
  });

  it("is not offered while the station is not enabled, or gave up the arm since the ask", () => {
    expect(executeOffer({ ...OFFERED, isEnabled: false })).toEqual({ isShown: true, isOffered: false, why: "execute.why.released" });
    expect(executeOffer({ ...OFFERED, isSameHold: false })).toEqual({ isShown: true, isOffered: false, why: "execute.why.released" });
  });

  it("is not offered once an action has started since the ask: the answer is spent", () => {
    expect(executeOffer({ ...OFFERED, isSpent: true })).toEqual({ isShown: true, isOffered: false, why: "execute.why.spent" });
    // spent stays spent while the next action is under way and after it
    expect(executeOffer({ ...OFFERED, isSpent: true, isIdle: false }).why).toBe("execute.why.spent");
  });

  it("is not offered while the station cannot take an action", () => {
    expect(executeOffer({ ...OFFERED, isIdle: false })).toEqual({ isShown: true, isOffered: false, why: "execute.why.busy" });
  });

  it("is not offered for an answer asked from the window's reading, whatever the station is now", () => {
    expect(executeOffer({ ...OFFERED, source: "window" })).toEqual({ isShown: true, isOffered: false, why: "execute.why.window" });
    expect(executeOffer({ ...OFFERED, source: "window", isEnabled: false, isSameHold: false, isIdle: false }).why).toBe(
      "execute.why.window",
    );
  });

  it("is offered in one case only, of all the facts can be", () => {
    const flags = [true, false];
    let offered = 0;
    for (const hasAction of flags) {
      for (const source of ["station", "window"] as const) {
        for (const isEnabled of flags) {
          for (const isSameHold of flags) {
            for (const isSpent of flags) {
              for (const isIdle of flags) {
                const offer = executeOffer({ hasAction, source, isEnabled, isSameHold, isSpent, isIdle });
                if (offer.isOffered) offered += 1;
                // a reason is given exactly when the control is shown and not offered
                expect(offer.why !== null).toBe(offer.isShown && !offer.isOffered);
              }
            }
          }
        }
      }
    }
    expect(offered).toBe(1);
  });
});

describe("the texts of executing", () => {
  /** The keys the page asks for by name around Execute (main.ts, ask.ts, index.html). */
  const PAGE_KEYS = [
    "execute.button",
    "execute.lead",
    "execute.name",
    "execute.real.go",
    "execute.real.keep",
    "ask.source.window",
    "ask.source.station",
    "ask.need.stationState",
    "ask.need.stationIdle",
    "ask.notSent",
    "task.startNote",
    "station.real.steps",
    "execute.why.window",
    "execute.why.released",
    "execute.why.spent",
    "execute.why.busy",
  ] as const satisfies readonly TextKey[];

  it("exist in both languages, every key the view asks for and every key of the page around it", () => {
    const used = new Set<string>();
    for (const language of LANGUAGES) {
      const wording = wordingOf(language, used);
      executeRow(action({ x: 9, roll: 1 }, 1), wording);
      executeRow(action({}, -1), wording);
      executeRow(action(), wording);
    }
    for (const key of [...used, ...PAGE_KEYS]) {
      for (const language of LANGUAGES) {
        const text = (TEXTS[language] as Record<string, string | undefined>)[key];
        expect(text, `${key} in ${language}`).toBeTypeOf("string");
        expect((text ?? "").trim(), `${key} in ${language}`).not.toBe("");
      }
    }
    expect(used).toContain("execute.real.ask");
    expect(used).toContain("execute.large");
    expect(used).toContain("execute.large.cm");
    expect(used).toContain("execute.large.rad");
    expect(used).toContain("ask.sentence");
  });

  it("hold the same placeholders in both languages, and Chinese in the Chinese ones", () => {
    const keys = (Object.keys(EN) as TextKey[]).filter(
      (key) => key.startsWith("execute.") || key.startsWith("ask.source.") || (PAGE_KEYS as readonly string[]).includes(key),
    );
    expect(keys.length).toBeGreaterThanOrEqual(PAGE_KEYS.length + 4);
    const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort();
    for (const key of keys) {
      expect(placeholders(ZH_TW[key]), key).toEqual(placeholders(EN[key]));
      expect(ZH_TW[key], key).toMatch(/[一-鿿]/);
    }
  });

  it("no longer say that no model moves an arm or that the page does not execute, and say what is true now", () => {
    for (const key of ["page.notice", "task.notice", "ask.lead", "ask.notSent"] as const) {
      expect(EN[key], key).not.toMatch(/No model moves an arm|no model moves an arm|does not execute|not executed:/);
      expect(ZH_TW[key], key).not.toMatch(/不會有任何模型讓手臂動|不會執行模型要求的動作|不會執行動作|只會顯示，不會執行/);
      expect(EN[key], key).toContain("Execute this action");
      expect(ZH_TW[key], key).toContain("執行這個動作");
    }
    for (const key of ["page.notice", "task.notice"] as const) {
      // an answer's action is executed at the operator's press for it. That nothing runs by itself is no longer
      // said: a task runs on either arm, on a real arm after a confirmation, and the model then moves the arm
      expect(EN[key], key).toMatch(/when you press “Execute this action” for/);
      expect(EN[key], key).not.toContain("Nothing runs by itself");
      expect(EN[key], key).toMatch(/the model moves the arm by itself/);
      expect(ZH_TW[key], key).toMatch(/為它按下「執行這個動作」/);
      expect(ZH_TW[key], key).not.toContain("不會有任何動作自行執行");
      expect(ZH_TW[key], key).toMatch(/自行移動手臂/);
    }
    // beside Start: a task runs on a real arm too, after a confirmation, and Execute stays the operator's own press
    expect(EN["task.startNote"]).not.toContain("not in this version");
    expect(EN["task.startNote"]).toMatch(/on a real arm after a confirmation/);
    expect(EN["task.startNote"]).toContain("Execute this action");
    expect(ZH_TW["task.startNote"]).not.toContain("這個版本還沒有");
    expect(ZH_TW["task.startNote"]).toMatch(/在真實的手臂上要先經過一次確認/);
    expect(ZH_TW["task.startNote"]).toContain("執行這個動作");
    // the note of a real arm's steps: each press moves the real arm at once, and an action needs the camera
    expect(EN["station.real.steps"]).toContain("at once");
    expect(EN["station.real.steps"]).toContain("camera of step 2");
    expect(EN["station.real.steps"]).not.toContain("not offered");
    expect(ZH_TW["station.real.steps"]).toContain("立刻");
    expect(ZH_TW["station.real.steps"]).toContain("步驟 2");
    const all = Object.keys(EN);
    for (const gone of ["ask.need.station", "ask.need.stationReal", "station.real.noJog"]) expect(all).not.toContain(gone);
  });
});
