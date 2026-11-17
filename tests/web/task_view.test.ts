// A task is the one thing of this page that moves the arm without a press for each action. This test holds the
// page's view of a task (web/src/task_view.ts) to the rules without a browser: when Start is offered and the
// sentence of each thing that is missing, the operator's two limits (how the limit of turns is read, what is
// sent), that Start's press starts a task on the simulated arm and only asks on a real arm, the row a real arm's
// Start is confirmed in (its sentence for each setting of the limits, and what takes it away), why the Worker
// paused the task, when Disable is offered while a task is there, which controls show for what
// the console tells (running, stopping, paused, stopped by STOP MOTION, cleared), the phase and the status in
// words in both languages, the list of the turns as the console's events make it (a whole turn, a pause while the
// model thinks, an answer without an action, a STOP MOTION and its reset, a clear), its bound, the gaps in the
// events' ids, and the lines of the page's log.

import { describe, expect, it } from "vitest";

import { actionSentence } from "../../web/src/execute_view";
import type { Wording } from "../../web/src/preflight_view";
import { ACTION_LIMIT_CM, ACTION_LIMIT_RAD, type TaskLimits, TURNS_LIMIT_MAX } from "../../web/src/station_protocol";
import type { TaskEvent, TaskSnapshot } from "../../web/src/task_host";
import {
  actionLimitLabel,
  actionWords,
  eventLogLine,
  gapWords,
  hasTask,
  INSTRUCTION_LIMIT,
  isDisableOffered,
  isStartStanding,
  isStationFailed,
  limitsOf,
  LOGGED_INSTRUCTION,
  noTurns,
  pausedByWords,
  performanceWords,
  phaseWords,
  resultWords,
  type StartAsked,
  startAsked,
  type StartFacts,
  startLogLine,
  startOffer,
  startPress,
  startRow,
  takeEvent,
  taskControls,
  taskError,
  taskStatus,
  type TaskTurns,
  TURNS_KEPT,
  TURNS_LIMIT_DEFAULT,
  isEndedWhenLost,
  isResumeStanding,
  limitsHeld,
  NO_TASK_LIMITS,
  type ResumeFacts,
  resumeAsked,
  resumeLogLine,
  resumePress,
  resumeRow,
  turnLine,
  turnsLimitOf,
  turnsNote,
} from "../../web/src/task_view";
import { EN, type TextKey, ZH_TW } from "../../web/src/texts";

type Language = "en" | "zh-TW";
const LANGUAGES: readonly Language[] = ["en", "zh-TW"];
const TEXTS: Record<Language, Record<TextKey, string>> = { en: EN, "zh-TW": ZH_TW };

/** The page's wording over one language, as i18n.ts gives it. */
function wordingOf(language: Language): Wording {
  return {
    t: (key, values = {}) =>
      TEXTS[language][key].replace(/\{(\w+)\}/g, (whole, name: string) =>
        Object.hasOwn(values, name) ? String(values[name]) : whole,
      ),
    count: (value) => value.toLocaleString(language === "zh-TW" ? "zh-TW" : "en-US"),
    listed: (names) => names.join(language === "zh-TW" ? "、" : ", "),
  };
}

const EN_WORDS = wordingOf("en");

/** Everything Start asks for. */
const READY: StartFacts = {
  arm: "simulated",
  isEnabled: true,
  isFailed: false,
  hasTask: false,
  isStopLatched: false,
  isActionUnderWay: false,
  isVisible: true,
  isCameraLive: true,
  isServiceChecked: true,
  instruction: "Put the red block into the box.",
  turnsLimit: "30",
  isActionLimited: true,
};

/** The same on a real arm's line. */
const REAL: StartFacts = { ...READY, arm: "real" };

/** The limits as they are at first. */
const LIMITS: TaskLimits = { turns: 30, isActionLimited: true };

/** Each single thing that takes Start's offer away. */
const MISSING: ReadonlyArray<Partial<StartFacts>> = [
  { isEnabled: false },
  { isFailed: true },
  { hasTask: true },
  { isStopLatched: true },
  { isActionUnderWay: true },
  { isVisible: false },
  { isCameraLive: false },
  { isServiceChecked: false },
  { instruction: "" },
  { turnsLimit: "1001" },
];

const TASK = { id: "task-1", instruction: "Put the red block into the box." };

/** The fields every event of a running turn carries. */
function turnFields(number: number, phase: string): Record<string, unknown> {
  return { attempt: `attempt-${number}`, turn_number: number, started_at: 1700000000 + number, episode_id: "episode-1", phase };
}

function snapshot(over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    phase: "Holding",
    isBusy: false,
    isStopLatched: false,
    error: null,
    task: null,
    activeTurn: null,
    totalSteps: 0,
    performance: null,
    sequence: 0,
    ...over,
  };
}

/** A console whose task runs its turn `number` in `phase`. */
function running(phase: string, number = 1, steps = 0): TaskSnapshot {
  return snapshot({
    phase,
    isBusy: true,
    task: TASK,
    activeTurn: turnFields(number, phase) as unknown as TaskSnapshot["activeTurn"],
    totalSteps: steps,
  });
}

/** A console whose task is paused after its turn `number`. */
function paused(over: Partial<TaskSnapshot> = {}, number = 1): TaskSnapshot {
  return snapshot({
    phase: "Paused",
    task: TASK,
    activeTurn: turnFields(number, "Interrupted") as unknown as TaskSnapshot["activeTurn"],
    ...over,
  });
}

type Told = readonly [type: string, data: Record<string, unknown>];

/** Numbers what the console tells, from `firstId`, as TaskHost.takeEvents gives it. */
function numbered(told: readonly Told[], firstId = 1): TaskEvent[] {
  return told.map(([type, data], index) => ({
    id: firstId + index,
    type,
    data,
    time: 1700000000 + index,
    monotonic_s: index / 10,
    task_id: TASK.id,
  }));
}

function taken(events: readonly TaskEvent[], from: TaskTurns = noTurns()): TaskTurns {
  return events.reduce(takeEvent, from);
}

const ACTION = { type: "single_arm_delta", arm: { x: 1, y: 0, z: -0.5, pitch: 0, roll: 0.05 }, gripper: { width: 1 } };
const NO_ACTION = "Final answer must end with a fenced json action";

const STARTED: Told = ["task", { ...TASK, created: 1700000000, model: "page", model_label: "page", reasoning_effort: null, images: [] }];

/** A turn up to its request: turn_started > phase(Observing) > observation > phase(Thinking) > request_metrics. */
function asked(number: number): Told[] {
  return [
    ["turn_started", turnFields(number, "Observing")],
    ["phase", turnFields(number, "Observing")],
    ["observation", { ...turnFields(number, "Observing"), turn_id: `turn-${number}`, text: "The arm is at rest.", images: [] }],
    ["phase", turnFields(number, "Thinking")],
    ["request_metrics", { ...turnFields(number, "Thinking"), image_uploads: 1, history_images: 0, messages_json_bytes: 2048 }],
  ];
}

/** The answer as it streams and ends: performance, usage, the pieces, model_output. */
function answered(number: number, answer: readonly string[]): Told[] {
  const turn = turnFields(number, "Thinking");

  return [
    ["performance", { ...turn, backend: "page", first_visible_output_s: 0.412, elapsed_s: 0.5, output_tokens: 3, final: false }],
    ["usage", { ...turn, input: 900, output: 3, context_limit: 32768, final: false }],
    ["reasoning_delta", { ...turn, text: "The block is ", reasoning_kind: "reasoning" }],
    ["reasoning_delta", { ...turn, text: "ahead.", reasoning_kind: "reasoning" }],
    ...answer.map((text): Told => ["answer_delta", { ...turn, text }]),
    ["performance", { ...turn, backend: "page", first_visible_output_s: 0.412, elapsed_s: 2.25, output_tokens: 64, output_throughput_tps: 34.816, final: true }],
    ["model_output", { ...turn, answer: answer.join(""), reasoning: "The block is ahead.", reasoning_kind: "reasoning", usage: {} }],
  ];
}

/** One whole turn, as the station tells it: ... model_output > action > phase(Planning) > phase(Executing) >
 * execution. */
function wholeTurn(number: number): Told[] {
  return [
    ...asked(number),
    ...answered(number, ["Move ", "forward."]),
    ["action", { ...turnFields(number, "Thinking"), ...ACTION }],
    ["phase", turnFields(number, "Planning")],
    ["phase", turnFields(number, "Executing")],
    ["execution", { ...turnFields(number, "Completed"), status: "completed", settled: true, reached: true, error: null }],
  ];
}

describe("Start", () => {
  it("is offered when the station is enabled and nothing is missing, on the simulated arm and on a real arm", () => {
    expect(startOffer(READY)).toEqual({ isOffered: true, why: null });
    expect(startOffer(REAL)).toEqual({ isOffered: true, why: null });
  });

  it("says each missing thing in its own sentence", () => {
    const missing: ReadonlyArray<readonly [Partial<StartFacts>, TextKey]> = [
      [{ isEnabled: false }, "task.why.disabled"],
      [{ arm: "real", isEnabled: false }, "task.why.disabled"],
      [{ isFailed: true }, "task.why.failed"],
      [{ turnsLimit: "" }, "task.why.limit"],
      [{ turnsLimit: "1001" }, "task.why.limit"],
      [{ turnsLimit: "2.5" }, "task.why.limit"],
      [{ arm: null, isEnabled: false }, "task.why.disabled"],
      [{ hasTask: true }, "task.why.task"],
      [{ isStopLatched: true }, "task.why.stopLatched"],
      [{ isActionUnderWay: true }, "task.why.busy"],
      [{ isVisible: false }, "task.why.hidden"],
      [{ isCameraLive: false }, "task.why.camera"],
      [{ isServiceChecked: false }, "task.why.model"],
      [{ instruction: "" }, "task.why.instruction"],
      [{ instruction: " \n\t " }, "task.why.instruction"],
      [{ instruction: "x".repeat(INSTRUCTION_LIMIT + 1) }, "task.why.long"],
    ];
    for (const [change, why] of missing) {
      expect(startOffer({ ...READY, ...change }), JSON.stringify(change).slice(0, 60)).toEqual({ isOffered: false, why });
    }
    // every sentence of Start is one of these, and each is its own text in both languages
    const said = new Set(missing.map(([, why]) => why));
    const keys = (Object.keys(EN) as TextKey[]).filter((key) => key.startsWith("task.why."));
    expect([...said].sort()).toEqual([...keys].sort());
    for (const language of LANGUAGES) {
      expect(new Set(keys.map((key) => TEXTS[language][key])).size, language).toBe(keys.length);
    }
  });

  it("takes an instruction of exactly PEAR's limit, counted in characters", () => {
    expect(startOffer({ ...READY, instruction: "塊".repeat(INSTRUCTION_LIMIT) }).isOffered).toBe(true);
    expect(startOffer({ ...READY, instruction: "😀".repeat(INSTRUCTION_LIMIT) }).isOffered).toBe(true);
  });

  it("has the same reasons on a real arm as on the simulated one, and no longer one of the real arm's own", () => {
    for (const change of MISSING) {
      const label = JSON.stringify(change);
      expect(startOffer({ ...REAL, ...change }), label).toEqual(startOffer({ ...READY, ...change }));
      expect(startOffer({ ...REAL, ...change }).isOffered, label).toBe(false);
    }
    expect(Object.keys(EN)).not.toContain("task.why.real");
    // the sentence of a station that is not enabled no longer names the simulated arm alone
    expect(EN["task.why.disabled"]).toMatch(/on the simulated arm or on a real arm/);
    expect(ZH_TW["task.why.disabled"]).toMatch(/模擬手臂或真實的手臂/);
  });

  it("says the first missing thing: the task before the stop, the stop before the rest", () => {
    const nothing: StartFacts = {
      arm: "simulated",
      isEnabled: true,
      isFailed: true,
      hasTask: true,
      isStopLatched: true,
      isActionUnderWay: true,
      isVisible: false,
      isCameraLive: false,
      isServiceChecked: false,
      instruction: "",
      turnsLimit: "many",
      isActionLimited: false,
    };
    const order: Array<[keyof StartFacts, TextKey]> = [
      ["isFailed", "task.why.failed"],
      ["hasTask", "task.why.task"],
      ["isStopLatched", "task.why.stopLatched"],
      ["isActionUnderWay", "task.why.busy"],
      ["isVisible", "task.why.hidden"],
      ["isCameraLive", "task.why.camera"],
      ["isServiceChecked", "task.why.model"],
    ];
    let facts = nothing;
    for (const [name, why] of order) {
      expect(startOffer(facts).why, name).toBe(why);
      facts = { ...facts, [name]: !facts[name] };
    }
    expect(startOffer(facts).why).toBe("task.why.instruction");
    // the limit of turns is said last: everything else is mended first
    facts = { ...facts, instruction: "Open the gripper." };
    expect(startOffer(facts).why).toBe("task.why.limit");
    expect(startOffer({ ...facts, turnsLimit: "0" })).toEqual({ isOffered: true, why: null });
  });
});

describe("the operator's two limits", () => {
  it("are 30 turns and a limited action at first, within the protocol's bound of turns", () => {
    expect(TURNS_LIMIT_DEFAULT).toBe(30);
    expect(TURNS_LIMIT_MAX).toBe(1000);
    expect(limitsOf(READY)).toEqual(LIMITS);
  });

  it("reads the limit of turns as a whole number from 0 to 1000 in plain digits, and as nothing else", () => {
    const read: ReadonlyArray<readonly [string, number | null]> = [
      ["0", 0],
      ["1", 1],
      ["30", 30],
      ["1000", 1000],
      [" 30 ", 30],
      ["030", 30],
      ["", null],
      [" ", null],
      ["1001", null],
      ["-1", null],
      ["+5", null],
      ["2.5", null],
      ["30.0", null],
      ["1e2", null],
      ["0x10", null],
      ["3 0", null],
      ["thirty", null],
      ["３０", null],
      ["NaN", null],
      ["Infinity", null],
      ["99999999999999999999999", null],
    ];
    for (const [written, turns] of read) expect(turnsLimitOf(written), JSON.stringify(written)).toBe(turns);
  });

  it("are a reason why Start is not offered while the limit of turns is no such number, with its sentence", () => {
    for (const written of ["", "1001", "-1", "2.5", "many"]) {
      expect(startOffer({ ...READY, turnsLimit: written }), written).toEqual({ isOffered: false, why: "task.why.limit" });
      expect(limitsOf({ ...READY, turnsLimit: written }), written).toBeNull();
    }
    expect(startOffer({ ...READY, turnsLimit: "0" }).isOffered).toBe(true);
    expect(startOffer({ ...READY, turnsLimit: "1000", isActionLimited: false }).isOffered).toBe(true);
    expect(EN["task.why.limit"]).toMatch(/whole number from 0 to 1,000/);
    expect(ZH_TW["task.why.limit"]).toMatch(/0 到 1,000 的整數/);
  });

  it("are sent as they are set: 0 turns is no limit, an unticked action is as PEAR has it", () => {
    expect(limitsOf({ turnsLimit: "0", isActionLimited: false })).toEqual({ turns: 0, isActionLimited: false });
    expect(limitsOf({ turnsLimit: "1000", isActionLimited: true })).toEqual({ turns: 1000, isActionLimited: true });
    expect(limitsOf({ turnsLimit: " 7 ", isActionLimited: false })).toEqual({ turns: 7, isActionLimited: false });
  });

  it("are labelled with the protocol's numbers and with what Resume does, in both languages", () => {
    expect(actionLimitLabel(EN_WORDS)).toContain(`more than ${ACTION_LIMIT_CM} cm along an axis or ${ACTION_LIMIT_RAD} rad of a rotation`);
    expect(actionLimitLabel(EN_WORDS)).toMatch(/as large as the model asks, as PEAR has it/);
    expect(actionLimitLabel(wordingOf("zh-TW"))).toContain(`超過 ${ACTION_LIMIT_CM} 公分`);
    expect(actionLimitLabel(wordingOf("zh-TW"))).toContain(`超過 ${ACTION_LIMIT_RAD} 弧度`);
    for (const language of LANGUAGES) expect(actionLimitLabel(wordingOf(language)), language).not.toMatch(/\{\w+\}/);
    expect(EN["task.limit.turns"]).toMatch(/after this many turns.*0: no limit.*“Resume” then runs as many again/);
    expect(ZH_TW["task.limit.turns"]).toMatch(/回合之後暫停.*0 代表不設上限.*「繼續」會再執行同樣多/);
  });
});

describe("Start's press", () => {
  it("starts the task on the simulated arm, and on a real arm starts nothing: it only asks", () => {
    expect(startPress(READY)).toBe("start");
    expect(startPress(REAL)).toBe("ask");
    expect(startAsked(READY)).toBeNull();
    expect(startAsked(REAL)).toEqual({ instruction: READY.instruction, limits: LIMITS });
    expect(startAsked({ ...REAL, turnsLimit: "0", isActionLimited: false })?.limits).toEqual({ turns: 0, isActionLimited: false });
  });

  it("does nothing on either arm while Start is not offered", () => {
    for (const arm of ["simulated", "real"] as const) {
      for (const change of MISSING) {
        const label = `${arm} ${JSON.stringify(change)}`;
        expect(startPress({ ...READY, arm, ...change }), label).toBe("nothing");
        expect(startAsked({ ...READY, arm, ...change }), label).toBeNull();
      }
    }
    expect(startPress({ ...READY, arm: null })).toBe("nothing");
  });

  it("never starts a task on a real arm, of all the facts can be, and asks in one case only", () => {
    const flags = [
      "isEnabled",
      "isFailed",
      "hasTask",
      "isStopLatched",
      "isActionUnderWay",
      "isVisible",
      "isCameraLive",
      "isServiceChecked",
      "isActionLimited",
    ] as const;
    let asks = 0;
    for (let bits = 0; bits < 1 << flags.length; bits += 1) {
      const set = Object.fromEntries(flags.map((name, index) => [name, (bits & (1 << index)) !== 0]));
      const press = startPress({ ...REAL, ...set });
      expect(press, JSON.stringify(set)).not.toBe("start");
      if (press === "ask") asks += 1;
    }
    // everything there and nothing in the way, with the action's limit ticked or not
    expect(asks).toBe(2);
  });
});

describe("the row of a real arm's Start", () => {
  const ASKED: StartAsked = { instruction: READY.instruction, limits: LIMITS };

  it("stands while Start is still offered on the real arm, for the instruction and the limits it was shown for", () => {
    expect(isStartStanding(ASKED, REAL)).toBe(true);
    expect(isStartStanding(startAsked(REAL), REAL)).toBe(true);
    // the same number written another way is the same limit
    expect(isStartStanding(ASKED, { ...REAL, turnsLimit: " 030 " })).toBe(true);
  });

  it("does not stand without Start's press, nor on the simulated arm", () => {
    expect(isStartStanding(null, REAL)).toBe(false);
    expect(isStartStanding(ASKED, READY)).toBe(false);
    expect(isStartStanding(ASKED, { ...REAL, arm: null })).toBe(false);
  });

  it("is taken away by a change of the instruction or of a limit", () => {
    expect(isStartStanding(ASKED, { ...REAL, instruction: `${READY.instruction} ` })).toBe(false);
    expect(isStartStanding(ASKED, { ...REAL, instruction: "Open the gripper." })).toBe(false);
    expect(isStartStanding(ASKED, { ...REAL, turnsLimit: "31" })).toBe(false);
    expect(isStartStanding(ASKED, { ...REAL, turnsLimit: "0" })).toBe(false);
    expect(isStartStanding(ASKED, { ...REAL, turnsLimit: "" })).toBe(false);
    expect(isStartStanding(ASKED, { ...REAL, isActionLimited: false })).toBe(false);
  });

  it("is taken away by anything that takes Start's offer away", () => {
    for (const change of MISSING) expect(isStartStanding(ASKED, { ...REAL, ...change }), JSON.stringify(change)).toBe(false);
  });

  it("says the whole sentence for the limits as they are at first", () => {
    const row = startRow(LIMITS, EN_WORDS);
    expect(row.warning).toBeNull();
    expect(row.ask).toBe(
      "Start this task on the real arm? From your press of “Start on the arm” the model moves the real arm by itself, " +
        "one action after another, without a press of yours between them. It goes on until you press “Pause” or the " +
        "stop bar, or until its limit of turns is reached, which is set to 30: then the task is paused, and “Resume” " +
        "runs 30 more. An action of more than 5 cm along an axis or 0.5 rad of a rotation is not executed: the model " +
        "is told so and asks again. Nothing looks for the table or for an obstacle in the arm's way. Keep the stop " +
        "bar and the servos' power switch within your reach.",
    );
    expect(EN["task.confirm.go"]).toBe("Start on the arm");
    expect(EN["task.confirm.keep"]).toBe("Don't");
    expect(ZH_TW["task.confirm.go"]).toBe("在手臂上開始");
    expect(ZH_TW["task.confirm.keep"]).toBe("不要");
  });

  it("says what the model will do by itself for each setting of the limits, with their numbers, in both languages", () => {
    for (const language of LANGUAGES) {
      const words = wordingOf(language);
      const zh = language === "zh-TW";
      for (const turns of [0, 1, 30, 1000]) {
        for (const isActionLimited of [true, false]) {
          const row = startRow({ turns, isActionLimited }, words);
          const label = `${language} ${turns} ${isActionLimited}`;
          expect(row.ask, label).not.toMatch(/\{\w+\}/);
          // the model moves the real arm by itself, with no press between the actions
          expect(row.ask, label).toMatch(zh ? /模型會自行移動真實的手臂/ : /the model moves the real arm by itself/);
          expect(row.ask, label).toMatch(zh ? /中間不需要你再按/ : /without a press of yours between them/);
          // what ends it: Pause, the stop bar, and the limit of turns as it is set
          expect(row.ask, label).toMatch(zh ? /「暫停」或停止列/ : /“Pause” or the stop bar/);
          if (turns === 0) {
            expect(row.ask, label).toMatch(zh ? /直到你暫停為止/ : /until you pause it/);
            expect(row.ask, label).toMatch(zh ? /沒有設定回合數上限/ : /no limit of turns is set/);
          } else {
            const number = words.count(turns);
            expect(row.ask, label).toContain(zh ? `跑完 ${number} 個回合` : `which is set to ${number}:`);
            expect(row.ask, label).toContain(zh ? `再執行 ${number} 個回合` : `runs ${number} more`);
            expect(row.ask, label).not.toMatch(zh ? /直到你暫停為止/ : /until you pause it/);
          }
          // how large an action can be: the protocol's numbers, or as large as the model asks
          if (isActionLimited) {
            expect(row.ask, label).toContain(zh ? `超過 ${ACTION_LIMIT_CM} 公分` : `more than ${ACTION_LIMIT_CM} cm along an axis`);
            expect(row.ask, label).toContain(zh ? `超過 ${ACTION_LIMIT_RAD} 弧度` : `or ${ACTION_LIMIT_RAD} rad of a rotation`);
            expect(row.ask, label).not.toMatch(zh ? /就是模型要求的大小/ : /as large as the model asks/);
          } else {
            expect(row.ask, label).toMatch(zh ? /就是模型要求的大小/ : /as large as the model asks/);
            expect(row.ask, label).not.toMatch(zh ? /公分|弧度/ : / cm | rad /);
          }
          // that nothing looks for the table or an obstacle, and what to keep in reach
          expect(row.ask, label).toMatch(zh ? /不會有任何東西偵測桌面/ : /Nothing looks for the table/);
          expect(row.ask, label).toMatch(zh ? /障礙物/ : /obstacle/);
          expect(row.ask, label).toMatch(zh ? /停止列和伺服馬達電源的開關/ : /the stop bar and the servos' power switch within your reach/);
          // with both limits off the row is a warning that says so plainly; otherwise it has none
          const isUnlimited = turns === 0 && !isActionLimited;
          expect(row.warning === null, label).toBe(!isUnlimited);
          if (isUnlimited) expect(row.warning, label).toMatch(zh ? /兩個限制都已經關閉/ : /Both limits are switched off/);
        }
      }
    }
  });
});

describe("why the Worker paused the task", () => {
  it("says the limit of turns with its number and that Resume runs as many again, in both languages", () => {
    expect(pausedByWords("limit", LIMITS, EN_WORDS)).toBe(
      "The task is paused: its limit of turns, set to 30, was reached. “Resume” runs 30 more.",
    );
    expect(pausedByWords("limit", LIMITS, wordingOf("zh-TW"))).toBe(
      "任務已暫停：已經達到 30 個回合的上限。按「繼續」會再執行 30 個回合。",
    );
    expect(pausedByWords("limit", { turns: 1000, isActionLimited: false }, EN_WORDS)).toMatch(/set to 1,000, .*runs 1,000 more/);
  });

  it("says the limit without a number when the page does not hold the limits the task was started with", () => {
    for (const limits of [null, { turns: 0, isActionLimited: true }]) {
      expect(pausedByWords("limit", limits, EN_WORDS)).toBe(EN["task.pausedBy.limitUnknown"]);
      expect(pausedByWords("limit", limits, wordingOf("zh-TW"))).toBe(ZH_TW["task.pausedBy.limitUnknown"]);
    }
    expect(EN["task.pausedBy.limitUnknown"]).toMatch(/limit of turns was reached.*“Resume” runs as many again/);
  });

  it("says that the page was hidden and that the task does not go on by itself", () => {
    expect(pausedByWords("hidden", LIMITS, EN_WORDS)).toMatch(/this page was hidden.*does not go on by itself.*press “Resume”/);
    expect(pausedByWords("hidden", null, EN_WORDS)).toBe(EN["task.pausedBy.hidden"]);
    expect(pausedByWords("hidden", LIMITS, wordingOf("zh-TW"))).toMatch(/頁面剛才被隱藏.*不會自己繼續.*「繼續」/);
  });

  it("says nothing when the Worker did not pause the task", () => {
    expect(pausedByWords(null, LIMITS, EN_WORDS)).toBeNull();
    expect(pausedByWords(undefined, LIMITS, EN_WORDS)).toBeNull();
  });
});

describe("Disable while a task is there", () => {
  it("is not offered while the station holds the arm: the task is cleared first", () => {
    expect(isDisableOffered({ isOn: true, hasTask: true, isFailed: false })).toBe(false);
  });

  it("is offered once the station has failed: the robot in FAULT or OFF, or a real arm's line lost", () => {
    expect(isStationFailed("FAULT", false)).toBe(true);
    expect(isStationFailed("OFF", false)).toBe(true);
    expect(isStationFailed("READY", true)).toBe(true);
    for (const robot of ["READY", "BUSY", "fault", "", null, undefined]) {
      expect(isStationFailed(robot, false), String(robot)).toBe(false);
    }
    expect(isDisableOffered({ isOn: true, hasTask: true, isFailed: true })).toBe(true);
  });

  it("is offered without a task as before, and never by a station that is not on", () => {
    expect(isDisableOffered({ isOn: true, hasTask: false, isFailed: false })).toBe(true);
    expect(isDisableOffered({ isOn: true, hasTask: false, isFailed: true })).toBe(true);
    for (const hasTaskThere of [true, false]) {
      for (const isFailed of [true, false]) {
        expect(isDisableOffered({ isOn: false, hasTask: hasTaskThere, isFailed })).toBe(false);
      }
    }
  });
});

describe("the controls of a task", () => {
  it("shows Start alone while no console is there or the console has no task", () => {
    for (const told of [null, undefined, snapshot()]) {
      expect(hasTask(told)).toBe(false);
      expect(taskControls(told)).toEqual({ start: true, pause: false, resume: false, clear: false, resetStop: false });
    }
  });

  it("shows Pause alone while the task runs, in every phase of a turn", () => {
    for (const phase of ["Observing", "Thinking", "Planning", "Executing", "Settling", "Compacting"]) {
      const told = running(phase);
      expect(hasTask(told), phase).toBe(true);
      expect(taskControls(told), phase).toEqual({ start: false, pause: true, resume: false, clear: false, resetStop: false });
    }
  });

  it("shows nothing while a stop that was asked is under way", () => {
    expect(taskControls(running("Stopping"))).toEqual({ start: false, pause: false, resume: false, clear: false, resetStop: false });
  });

  it("shows Resume and Clear while the task is paused, by the operator or by a turn that failed", () => {
    const shown = { start: false, pause: false, resume: true, clear: true, resetStop: false };
    expect(taskControls(paused())).toEqual(shown);
    expect(taskControls(paused({ error: `RuntimeError: ${NO_ACTION}` }))).toEqual(shown);
    expect(hasTask(paused())).toBe(true);
  });

  it("shows Reset STOP MOTION while it is latched: no Resume before the reset, Clear all the same", () => {
    const stopped = paused({ phase: "Stopped", isStopLatched: true });
    expect(taskControls(stopped)).toEqual({ start: false, pause: false, resume: false, clear: true, resetStop: true });
    // "reset_stop" makes the phase Paused: the task can be resumed again
    expect(taskControls(paused())).toEqual({ start: false, pause: false, resume: true, clear: true, resetStop: false });
    // latched without a task: Start shows, is not offered, and says why
    const idle = snapshot({ phase: "Stopped", isStopLatched: true });
    expect(taskControls(idle)).toEqual({ start: true, pause: false, resume: false, clear: false, resetStop: true });
    expect(startOffer({ ...READY, isStopLatched: true }).why).toBe("task.why.stopLatched");
  });

  it("shows Start again once the task is cleared", () => {
    expect(taskControls(snapshot({ phase: "Holding", totalSteps: 0 })).start).toBe(true);
    expect(hasTask(snapshot({ phase: "Holding" }))).toBe(false);
  });
});

describe("the task's state in words", () => {
  const PHASES = ["Holding", "Observing", "Thinking", "Planning", "Executing", "Settling", "Compacting", "Stopping", "Paused", "Stopped"];

  it("has a sentence of its own for each phase of a console with a task, in both languages", () => {
    for (const language of LANGUAGES) {
      const words = PHASES.map((phase) => phaseWords(phase, wordingOf(language)));
      expect(new Set(words).size, language).toBe(PHASES.length);
      for (const sentence of words) expect(sentence, language).not.toMatch(/[{}]/);
    }
    expect(phaseWords("Thinking", EN_WORDS)).toBe(EN["task.phase.thinking"]);
    expect(phaseWords("Stopped", wordingOf("zh-TW"))).toBe(ZH_TW["task.phase.stopped"]);
  });

  it("says a phase it has no sentence for in PEAR's own word", () => {
    expect(phaseWords("Recovering control", EN_WORDS)).toBe("PEAR's phase: Recovering control.");
    expect(phaseWords("toString", EN_WORDS)).toBe("PEAR's phase: toString.");
  });

  it("tells the phase, the turn's number and the count of completed actions", () => {
    expect(taskStatus(null, EN_WORDS)).toEqual({ phase: "", text: "No task." });
    expect(taskStatus(snapshot(), EN_WORDS)).toEqual({ phase: "Holding", text: "No task." });
    expect(taskStatus(snapshot({ phase: "Stopped", isStopLatched: true }), EN_WORDS)).toEqual({
      phase: "Stopped",
      text: EN["task.status.latched"],
    });
    expect(taskStatus(running("Thinking", 3, 2), EN_WORDS)).toEqual({
      phase: "Thinking",
      text: "Thinking: the model is asked and answers. Turn 3. Actions completed: 2.",
    });
    const first = snapshot({ phase: "Observing", isBusy: true, task: TASK });
    expect(taskStatus(first, EN_WORDS).text).toBe(`${EN["task.phase.observing"]} No turn has begun yet. Actions completed: 0.`);
    expect(taskStatus(running("Executing", 12, 11), wordingOf("zh-TW")).text).toBe(
      `${ZH_TW["task.phase.executing"]}第 12 回合。已完成的動作：11。`,
    );
  });

  it("tells the console's failure with what can be done about it", () => {
    const error = `RuntimeError: ${NO_ACTION}`;
    expect(taskError(paused(), EN_WORDS)).toBeNull();
    expect(taskError(null, EN_WORDS)).toBeNull();
    for (const language of LANGUAGES) {
      const texts = TEXTS[language];
      const words = wordingOf(language);
      const cases: ReadonlyArray<readonly [TaskSnapshot, TextKey]> = [
        [paused({ error }), "task.error.resume"],
        [paused({ error, phase: "Stopped", isStopLatched: true }), "task.error.reset"],
        [snapshot({ error }), "task.error.noTask"],
        [{ ...running("Thinking"), error }, "task.error.running"],
      ];
      for (const [told, key] of cases) {
        expect(taskError(told, words), `${language} ${key}`).toBe(texts[key].replace("{error}", error));
        expect(texts[key], key).toContain("{error}");
      }
      // what can be done is named by the controls' own labels
      expect(texts["task.error.resume"]).toContain(texts["task.resume"]);
      expect(texts["task.error.resume"]).toContain(texts["task.clear"]);
      expect(texts["task.error.reset"]).toContain(texts["task.resetStop"]);
      expect(texts["task.error.noTask"]).toContain(texts["task.start"]);
    }
  });

  it("gives the inference numbers under PEAR's names", () => {
    expect(performanceWords(null)).toBeNull();
    expect(performanceWords({ backend: "page", final: false })).toBeNull();
    expect(performanceWords({ first_visible_output_s: 0.412, elapsed_s: 2.25, output_tokens: 64, output_throughput_tps: 34.816 })).toBe(
      "first_visible_output_s 0.41 · elapsed_s 2.25 · output_tokens 64 · output_throughput_tps 34.82",
    );
  });
});

describe("the turns, from the console's events", () => {
  it("makes one turn of a whole turn: its number, the action in words, the result, the answer as it streamed", () => {
    const events = numbered([STARTED, ["session", { episode_id: "episode-1", message: "New model session" }], ...wholeTurn(1)]);
    const state = taken(events);
    expect(state.taskId).toBe("task-1");
    expect(state.missed).toBe(0);
    expect(state.lastId).toBe(events.length);
    expect(state.turns).toEqual([
      {
        number: 1,
        attempt: "attempt-1",
        action: { arm: ACTION.arm, gripper: ACTION.gripper },
        result: { status: "completed", error: null },
        end: null,
      },
    ]);
    expect(state.reasoning).toBe("The block is ahead.");
    expect(state.answer).toBe("Move forward.");
    expect(performanceWords(state.performance)).toBe(
      "first_visible_output_s 0.41 · elapsed_s 2.25 · output_tokens 64 · output_throughput_tps 34.82",
    );
    for (const language of LANGUAGES) {
      const words = wordingOf(language);
      const turn = state.turns[0]!;
      expect(actionWords(turn, words)).toBe(actionSentence(ACTION, words));
      expect(resultWords(turn, words)).toBe(TEXTS[language]["task.turn.result"].replace("{status}", "completed"));
      expect(turnLine(turn, words)).toContain(actionSentence(ACTION, words));
      expect(turnLine(turn, words)).toContain("completed");
      expect(turnLine(turn, words)).not.toMatch(/[{}]/);
    }
    expect(turnLine(state.turns[0]!, EN_WORDS)).toMatch(/^Turn 1\. In words: .* Result: completed\.$/);
  });

  it("shows the reasoning and the answer piece by piece, and the turn as running until its result", () => {
    const events = numbered([STARTED, ...wholeTurn(1)]);
    const pieces = events.filter((event) => event.type.endsWith("_delta")).length;
    expect(pieces).toBe(4);
    let state = noTurns();
    const seen: string[] = [];
    for (const event of events) {
      state = takeEvent(state, event);
      if (event.type.endsWith("_delta")) seen.push(`${state.reasoning}|${state.answer}`);
      if (event.type === "request_metrics") {
        expect(resultWords(state.turns[0]!, EN_WORDS)).toBe(EN["task.turn.running"]);
        expect(actionWords(state.turns[0]!, EN_WORDS)).toBe(EN["task.turn.noActionYet"]);
      }
    }
    expect(seen).toEqual(["The block is |", "The block is ahead.|", "The block is ahead.|Move ", "The block is ahead.|Move forward."]);
  });

  it("lists the newest turn first and begins the stream again with each turn", () => {
    const first = taken(numbered([STARTED, ...wholeTurn(1)]));
    const second = taken(numbered([...asked(2)], first.lastId + 1), first);
    expect(second.turns.map((turn) => turn.number)).toEqual([2, 1]);
    expect(second.turns[1]!.result).toEqual({ status: "completed", error: null });
    expect(second.turns[0]).toEqual({ number: 2, attempt: "attempt-2", action: null, result: null, end: null });
    expect([second.reasoning, second.answer, second.performance]).toEqual(["", "", null]);
    expect(second.missed).toBe(0);
  });

  it("tells a pause while the model thinks: the stop's message, and a turn that ended without an action", () => {
    const turn = turnFields(1, "Thinking");
    const events = numbered([
      STARTED,
      ...asked(1),
      ["stopping", { ...turn, message: "Paused by operator", stop_request_seconds: 12.5 }],
      ["turn_end", { ...turnFields(1, "Interrupted") }],
      ["execution", { ...turnFields(1, "Interrupted"), status: "interrupted", settled: null, reached: null, error: null }],
      ["interrupted", { ...turnFields(1, "Interrupted"), message: "Turn interrupted; the session is kept.", session_retained: true }],
    ]);
    const state = taken(events);
    expect(state.stop).toBe("Paused by operator");
    expect(state.turns).toEqual([
      {
        number: 1,
        attempt: "attempt-1",
        action: null,
        result: { status: "interrupted", error: null },
        end: { phase: "Interrupted", message: "Turn interrupted; the session is kept." },
      },
    ]);
    expect(actionWords(state.turns[0]!, EN_WORDS)).toBe(EN["task.turn.noAction"]);
    expect(resultWords(state.turns[0]!, EN_WORDS)).toBe("Result: interrupted.");
    // before the result came, the turn's end is what is said
    const ended = taken(events.slice(0, -2));
    expect(resultWords(ended.turns[0]!, EN_WORDS)).toBe("The turn ended without a result: Interrupted.");
    // the next turn, after Resume, lets the stop's message go
    const resumed = taken(numbered([["resume_context", { episode_id: "episode-1", message: "Resumed" }], ...asked(2)], state.lastId + 1), state);
    expect(resumed.stop).toBeNull();
    expect(resumed.turns.map((item) => item.number)).toEqual([2, 1]);
  });

  it("shows a refused action's message whole in the newest turn: it is the sentence the model reads", () => {
    const message =
      `The operator's limit of an action is ${ACTION_LIMIT_CM} cm along an axis and ${ACTION_LIMIT_RAD} rad of a rotation: ` +
      `x asks for 12.5 cm. ${"Nothing moved. ".repeat(40)}Ask for a smaller action.\nIts second line.`;
    const state = taken(
      numbered([
        STARTED,
        ...asked(1),
        ["action", { ...turnFields(1, "Executing"), ...ACTION }],
        ["execution", { ...turnFields(1, "Executing"), status: "rejected", error: { code: "ValueError", message } }],
      ]),
    );
    const newest = state.turns[0];
    expect(newest?.result).toEqual({ status: "rejected", error: message });
    expect(message.length).toBeGreaterThan(600);
    for (const language of LANGUAGES) {
      expect(newest === undefined ? "" : resultWords(newest, wordingOf(language)), language).toContain(message);
    }
    expect(newest === undefined ? "" : turnLine(newest, EN_WORDS)).toContain(message);
  });

  it("tells an answer without an action as a rejected turn, in PEAR's words", () => {
    const failed = turnFields(1, "Failed");
    const events = numbered([
      STARTED,
      ...asked(1),
      ...answered(1, ["The task is done."]),
      ["execution", { ...turnFields(1, "Rejected"), status: "rejected", error: { code: "ValueError", message: NO_ACTION } }],
      ["turn_end", { ...failed, message: `RuntimeError: ${NO_ACTION}` }],
      ["error", { message: `RuntimeError: ${NO_ACTION}` }],
    ]);
    const state = taken(events);
    expect(state.turns).toEqual([
      {
        number: 1,
        attempt: "attempt-1",
        action: null,
        result: { status: "rejected", error: NO_ACTION },
        end: { phase: "Failed", message: `RuntimeError: ${NO_ACTION}` },
      },
    ]);
    expect(state.answer).toBe("The task is done.");
    for (const language of LANGUAGES) {
      const line = turnLine(state.turns[0]!, wordingOf(language));
      expect(line).toContain(TEXTS[language]["task.turn.noAction"]);
      expect(line).toContain("rejected");
      expect(line).toContain(NO_ACTION);
    }
    // the task stays, paused, with the failure and what can be done about it
    const told = paused({ error: `RuntimeError: ${NO_ACTION}` });
    expect(taskControls(told)).toMatchObject({ resume: true, clear: true });
    expect(taskError(told, EN_WORDS)).toContain(`RuntimeError: ${NO_ACTION}`);
  });

  it("tells a STOP MOTION and its reset", () => {
    const events = numbered([
      STARTED,
      ...asked(1),
      ["stopping", { ...turnFields(1, "Thinking"), message: "STOP MOTION activated", stop_request_seconds: 3.25 }],
      ["turn_end", turnFields(1, "Interrupted")],
    ]);
    const state = taken(events);
    expect(state.stop).toBe("STOP MOTION activated");
    expect(eventLogLine(events[events.length - 2]!)).toBe("Task: STOP MOTION activated");
    const stopped = paused({ phase: "Stopped", isStopLatched: true });
    expect(taskControls(stopped)).toMatchObject({ pause: false, resume: false, resetStop: true });
    expect(taskStatus(stopped, EN_WORDS).text).toContain(EN["task.phase.stopped"]);
    expect(taskControls(paused())).toMatchObject({ resume: true, clear: true, resetStop: false });
  });

  it("keeps a cleared task's turns until the next task starts", () => {
    const first = numbered([STARTED, ...wholeTurn(1), ["task_end", { message: "Task cleared; history saved." }]]);
    const cleared = taken(first);
    expect(cleared.isCleared).toBe(true);
    expect(cleared.turns).toHaveLength(1);
    expect(eventLogLine(first[first.length - 1]!)).toBe("Task: cleared");
    const again = taken(numbered([["task", { ...TASK, id: "task-2" }]], cleared.lastId + 1), cleared);
    expect(again).toEqual({ ...noTurns(), taskId: "task-2", lastId: cleared.lastId + 1 });
  });

  it(`keeps the newest ${TURNS_KEPT} turns and counts the older ones`, () => {
    const told: Told[] = [STARTED];
    for (let number = 1; number <= TURNS_KEPT + 5; number += 1) told.push(...wholeTurn(number));
    const state = taken(numbered(told));
    expect(state.turns).toHaveLength(TURNS_KEPT);
    expect(state.turns[0]!.number).toBe(TURNS_KEPT + 5);
    expect(state.turns[TURNS_KEPT - 1]!.number).toBe(6);
    expect(state.forgotten).toBe(5);
    expect(turnsNote(state, EN_WORDS)).toBe(
      `The newest turn first; the list keeps the newest ${TURNS_KEPT} turns. 5 older turns are no longer listed.`,
    );
    expect(turnsNote(taken(numbered([STARTED, ...wholeTurn(1)])), EN_WORDS)).toBe(
      `The newest turn first; the list keeps the newest ${TURNS_KEPT} turns.`,
    );
    for (const language of LANGUAGES) expect(turnsNote(state, wordingOf(language))).not.toMatch(/[{}]/);
  });

  it("notices a gap in the events' ids and says how many events did not arrive", () => {
    const events = numbered([STARTED, ...wholeTurn(1)]);
    const whole = taken(events);
    expect(gapWords(whole, EN_WORDS)).toBeNull();
    // the action and the two phases after it are dropped: the turn is listed with its result and without its action
    const at = events.findIndex((event) => event.type === "action");
    const state = taken([...events.slice(0, at), ...events.slice(at + 3)]);
    expect(state.missed).toBe(3);
    expect(state.turns[0]).toMatchObject({ number: 1, action: null, result: { status: "completed" } });
    expect(gapWords(state, EN_WORDS)).toBe(EN["task.gap"].replace("{count}", "3"));
    expect(gapWords(state, wordingOf("zh-TW"))).toContain("3");
    // a turn whose beginning was dropped is listed from its first event that arrives
    const late = taken(events.filter((event) => event.type === "task" || event.type === "execution"));
    expect(late.missed).toBe(events.length - 2);
    expect(late.turns.map((turn) => turn.number)).toEqual([1]);
    // a new console numbers its events from 1 again: that is no gap
    const fresh = taken(numbered([STARTED, ...asked(1)]), whole);
    expect(fresh.missed).toBe(0);
    expect(fresh.turns).toHaveLength(1);
  });

  it("takes an event it does not know, and an action that is not of the format, without failing", () => {
    const events = numbered([
      STARTED,
      ["turn_started", turnFields(1, "Observing")],
      ["diagnostic", { message: "anything" }],
      ["action", { ...turnFields(1, "Thinking"), type: "single_arm_delta", arm: { x: "far" }, gripper: {} }],
      ["execution", { status: "failed", error: "plain words" }],
    ]);
    const state = taken(events);
    expect(state.turns).toEqual([
      { number: 1, attempt: "attempt-1", action: null, result: { status: "failed", error: "plain words" }, end: null },
    ]);
    expect(taken(numbered([["execution", { status: "failed", error: null }]])).turns).toEqual([]);
  });
});

describe("the page's log of a task", () => {
  it("logs a start with the arm, the two limits, the instruction's length and its first 80 characters", () => {
    expect(startLogLine("Put the red block into the box.", LIMITS, "simulated")).toBe(
      'Task: start on the simulated arm (turns limit: 30; action limit: 5 cm, 0.5 rad), instruction of 31 characters: "Put the red block into the box."',
    );
    expect(startLogLine("Put the red block into the box.", { turns: 0, isActionLimited: false }, "real")).toBe(
      'Task: start on the real arm (turns limit: none; action limit: none), instruction of 31 characters: "Put the red block into the box."',
    );
    expect(startLogLine("Go.", { turns: 1000, isActionLimited: true }, "real")).toBe(
      `Task: start on the real arm (turns limit: 1000; action limit: ${ACTION_LIMIT_CM} cm, ${ACTION_LIMIT_RAD} rad), instruction of 3 characters: "Go."`,
    );
    const long = `${"a".repeat(LOGGED_INSTRUCTION)}SECRET-TAIL`;
    const line = startLogLine(long, LIMITS, "simulated");
    expect(line).toBe(
      `Task: start on the simulated arm (turns limit: 30; action limit: 5 cm, 0.5 rad), instruction of ${long.length} characters: "${"a".repeat(80)}"`,
    );
    expect(line).not.toContain("SECRET-TAIL");
    expect(startLogLine('say "hi"\nnow', LIMITS, "simulated")).toMatch(/, instruction of 12 characters: "say \\"hi\\"\\nnow"$/);
  });

  it("logs a turn's action and result, a stop's and a failure's message and the clearing, and no streamed piece", () => {
    const events = numbered([
      STARTED,
      ...wholeTurn(2),
      ["stopping", { message: "Paused by operator", stop_request_seconds: 1 }],
      ["error", { message: `RuntimeError: ${NO_ACTION}` }],
      ["execution", { ...turnFields(3, "Rejected"), status: "rejected", error: { code: "ValueError", message: NO_ACTION } }],
      ["task_end", { message: "Task cleared; history saved." }],
    ]);
    const lines = events.map(eventLogLine).filter((line): line is string => line !== null);
    expect(lines).toEqual([
      `Task: turn 2 action ${JSON.stringify(ACTION)}`,
      'Task: turn 2 result {"status":"completed","error":null}',
      "Task: Paused by operator",
      `Task: RuntimeError: ${NO_ACTION}`,
      `Task: turn 3 result {"status":"rejected","error":{"code":"ValueError","message":"${NO_ACTION}"}}`,
      "Task: cleared",
    ]);
    for (const event of events) {
      if (event.type.endsWith("_delta") || event.type === "model_output") expect(eventLogLine(event), event.type).toBeNull();
    }
  });
});

describe("the texts of a task", () => {
  it("are there in both languages with the same values to fill in", () => {
    const keys = (Object.keys(EN) as TextKey[]).filter((key) => key.startsWith("task."));
    expect(keys.length).toBeGreaterThan(50);
    const values = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
    for (const key of keys) {
      expect(ZH_TW[key], key).toBeTruthy();
      expect(values(ZH_TW[key]), key).toEqual(values(EN[key]));
    }
  });

  it("say what is true now: a task runs on a real arm too, after a confirmation, and the model then moves the arm by itself", () => {
    for (const key of ["page.notice", "task.notice", "task.startNote"] as const) {
      expect(EN[key], key).toMatch(/simulated arm/);
      expect(EN[key], key).toMatch(/on a real arm[^.]*confirm|confirmation[^.]*on a real arm/);
      expect(EN[key], key).toMatch(/the model moves the arm by itself/);
      expect(EN[key], key).toMatch(/until it is paused/);
      expect(EN[key], key).toMatch(/limit of turns you set/);
      expect(ZH_TW[key], key).toMatch(/模擬手臂/);
      expect(ZH_TW[key], key).toMatch(/在真實的手臂上[^。]*確認/);
      expect(ZH_TW[key], key).toMatch(/模型(會)?(一回合接一回合地)?自行移動手臂/);
      expect(ZH_TW[key], key).toMatch(/直到任務被暫停/);
      expect(ZH_TW[key], key).toMatch(/回合數上限/);
      // what is still the operator's own press each time
      expect(EN[key], key).toMatch(/your own press/);
      expect(EN[key], key).toContain("Execute this action");
      expect(ZH_TW[key], key).toMatch(/要你自己按/);
      expect(ZH_TW[key], key).toContain("執行這個動作");
      // and no longer what was true before a task ran on a real arm
      expect(EN[key], key).not.toMatch(/Nothing runs by itself|not in this version|simulated arm only|until you pause it\./);
      expect(ZH_TW[key], key).not.toMatch(/不會有任何動作自行執行|這個版本還沒有|直到你暫停為止/);
    }
    for (const key of ["task.notice", "task.startNote"] as const) {
      // Enable, Home, a step by hand and Execute are named
      expect(EN[key], key).toMatch(/Enable, Home, a step by hand and (Execute|“Execute this action”)/);
      expect(ZH_TW[key], key).toMatch(/啟用、Home、單步動作/);
    }
    // beside Start: at once on the simulated arm, after a confirmation on a real arm, and what pauses it
    expect(EN["task.startNote"]).toMatch(/on the simulated arm at once and on a real arm after a confirmation/);
    expect(EN["task.startNote"]).toMatch(/“Pause”, by the stop bar, by a hidden page or by a turn that fails/);
    expect(ZH_TW["task.startNote"]).toMatch(/在模擬手臂上一按就開始，在真實的手臂上要先經過一次確認/);
  });
});

describe("Resume on a real arm, the limits the station tells of a task, and a station lost during a task", () => {
  const LIMITS: TaskLimits = { turns: 12, isActionLimited: true };
  const OFFERED: ResumeFacts = { arm: "real", isOffered: true, limits: LIMITS };

  it("resumes at one press on the simulated arm, and only asks on a real arm", () => {
    expect(resumePress({ ...OFFERED, arm: "simulated" })).toBe("resume");
    expect(resumeAsked({ ...OFFERED, arm: "simulated" })).toBeNull();
    expect(resumePress(OFFERED)).toBe("ask");
    expect(resumeAsked(OFFERED)).toEqual({ limits: LIMITS, isTold: true });
    for (const arm of ["simulated", "real", null] as const) {
      expect(resumePress({ arm, isOffered: false, limits: LIMITS })).toBe("nothing");
      expect(resumeAsked({ arm, isOffered: false, limits: LIMITS })).toBeNull();
    }
    expect(resumePress({ ...OFFERED, arm: null })).toBe("nothing");
  });

  it("keeps the row only while a resume is offered on a real arm with the limits it was shown for", () => {
    const asked = resumeAsked(OFFERED);
    expect(isResumeStanding(asked, OFFERED)).toBe(true);
    expect(isResumeStanding(asked, { ...OFFERED, limits: { ...LIMITS } })).toBe(true);
    expect(isResumeStanding(null, OFFERED)).toBe(false);
    expect(isResumeStanding(asked, { ...OFFERED, isOffered: false })).toBe(false);
    expect(isResumeStanding(asked, { ...OFFERED, arm: "simulated" })).toBe(false);
    expect(isResumeStanding(asked, { ...OFFERED, arm: null })).toBe(false);
    expect(isResumeStanding(asked, { ...OFFERED, limits: { turns: 13, isActionLimited: true } })).toBe(false);
    expect(isResumeStanding(asked, { ...OFFERED, limits: { turns: 12, isActionLimited: false } })).toBe(false);
    expect(isResumeStanding(asked, { ...OFFERED, limits: null })).toBe(false);
    // a row that was shown for a task without told limits stands only while none are told
    const untold = resumeAsked({ ...OFFERED, limits: null });
    expect(untold).toEqual({ limits: NO_TASK_LIMITS, isTold: false });
    expect(isResumeStanding(untold, { ...OFFERED, limits: undefined })).toBe(true);
    expect(isResumeStanding(untold, { ...OFFERED, limits: NO_TASK_LIMITS })).toBe(false);
  });

  it("says a resume's sentence with the limits the status tells, in both languages", () => {
    const asked = resumeAsked(OFFERED)!;
    const en = resumeRow(asked, wordingOf("en"));
    expect(en.ask).toMatch(/^Resume this task on the real arm\? From your press of “Resume on the arm” the model moves the real arm again by itself/);
    expect(en.ask).toContain("which is set to 12");
    expect(en.ask).toContain("“Resume” runs 12 more");
    expect(en.ask).toContain("more than 5 cm along an axis or 0.5 rad of a rotation is not executed");
    expect(en.ask).toContain("Nothing looks for the table or for an obstacle in the arm's way.");
    expect(en.ask).toMatch(/Keep the stop bar and the servos' power switch within your reach\.$/);
    expect(en.ask).not.toContain("{");
    expect(en.warning).toBeNull();
    const zh = resumeRow(asked, wordingOf("zh-TW"));
    expect(zh.ask).toMatch(/^要在真實的手臂上繼續這個任務嗎？從你按下「在手臂上繼續」起，模型會再次自行移動真實的手臂/);
    expect(zh.ask).toContain("12 個回合");
    expect(zh.ask).toContain("5 公分");
    expect(zh.ask).not.toContain("{");
    expect(zh.warning).toBeNull();
    expect(EN["task.resume.go"]).toBe("Resume on the arm");
    expect(ZH_TW["task.resume.go"]).toBe("在手臂上繼續");

    // both limits off, as the status tells them: the plain warning of Start's row
    const off = resumeRow(resumeAsked({ ...OFFERED, limits: NO_TASK_LIMITS })!, wordingOf("en"));
    expect(off.ask).toContain("no limit of turns is set");
    expect(off.ask).toContain("as large as the model asks");
    expect(off.warning).toBe(EN["task.confirm.unlimited"]);

    // a status that tells no limits for the task: the task runs without limits, and the row says so
    for (const limits of [null, undefined]) {
      const none = resumeRow(resumeAsked({ ...OFFERED, limits })!, wordingOf("en"));
      expect(none.ask).toContain("no limit of turns is set");
      expect(none.ask).toContain("as large as the model asks");
      expect(none.warning).toMatch(/^The station tells no limits for this task: it runs without limits\./);
    }
    expect(resumeRow(resumeAsked({ ...OFFERED, limits: null })!, wordingOf("zh-TW")).warning).toMatch(/^工作站沒有回報這個任務的限制/);
  });

  it("takes a task's limits from the status, and a task without told limits as running without limits", () => {
    expect(limitsHeld(LIMITS)).toBe(LIMITS);
    expect(limitsHeld(null)).toEqual({ turns: 0, isActionLimited: false });
    expect(limitsHeld(undefined)).toEqual({ turns: 0, isActionLimited: false });
    // the pause's sentence names the limit the status tells
    expect(pausedByWords("limit", LIMITS, wordingOf("en"))).toContain("set to 12");
    expect(pausedByWords("limit", limitsHeld(null), wordingOf("en"))).toBe(EN["task.pausedBy.limitUnknown"]);
    expect(pausedByWords("limit", null, wordingOf("en"))).toBe(EN["task.pausedBy.limitUnknown"]);
    // the log's line of a real arm's resume
    expect(resumeLogLine({ limits: LIMITS, isTold: true })).toBe(
      "Task: resume on the real arm (turns limit: 12; action limit: 5 cm, 0.5 rad)",
    );
    expect(resumeLogLine({ limits: NO_TASK_LIMITS, isTold: true })).toBe(
      "Task: resume on the real arm (turns limit: none; action limit: none)",
    );
    expect(resumeLogLine({ limits: NO_TASK_LIMITS, isTold: false })).toBe(
      "Task: resume on the real arm (the station told no limits: the task runs without limits)",
    );
  });

  it("ends the Worker of a lost station while a task is there or the console is busy, and not without a task", () => {
    expect(isEndedWhenLost({ task: running("Thinking"), action: "task" })).toBe(true);
    expect(isEndedWhenLost({ task: paused(), action: null })).toBe(true);
    expect(isEndedWhenLost({ task: snapshot({ isBusy: true }), action: null })).toBe(true);
    expect(isEndedWhenLost({ task: snapshot(), action: "task" })).toBe(true);
    expect(isEndedWhenLost({ task: snapshot(), action: null })).toBe(false);
    expect(isEndedWhenLost({ task: null, action: null })).toBe(false);
    expect(isEndedWhenLost({ task: null, action: "jog" })).toBe(false);
    expect(isEndedWhenLost(null)).toBe(false);
    expect(isEndedWhenLost(undefined)).toBe(false);
    // what the page says of it: the task is gone with the Worker; on a real arm the servos hold
    expect(EN["task.ended.lost"]).toMatch(/The task was ended with the Worker and cannot be resumed\. Reload the page to start again\.$/);
    expect(EN["task.ended.lost"]).not.toContain("servos");
    expect(EN["task.ended.lostReal"]).toMatch(
      /cannot be resumed\. The servos hear nothing now: they keep their torque and hold their last goal until their power is switched off\. Reload the page to start again\.$/,
    );
    expect(ZH_TW["task.ended.lost"]).toMatch(/任務已經隨著 Worker 一起結束，無法繼續。請重新載入頁面再開始。$/);
    expect(ZH_TW["task.ended.lostReal"]).toMatch(/它們會維持扭力，停在最後的目標位置，直到電源被關掉。請重新載入頁面再開始。$/);
  });
});
