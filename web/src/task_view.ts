// A task as the page decides and words it, without the DOM: whether Start is offered and why it is not, the
// operator's two limits, what Start's press does on each arm and the row a real arm's Start is confirmed in, which
// controls show for what the console tells of the task, the task's phase in words, why the Worker paused it, the
// list of the task's turns as the console's events tell them, and the lines of the page's log. The page (main.ts)
// draws these and sends the operator's commands to the station; a test holds them to the rules without a browser.
//
// The rules: a task starts and resumes only at the operator's own press; from then on the model is asked, its
// action is executed and the next turn follows without a press, until the operator pauses the task, a turn fails,
// STOP MOTION is pressed or the task's limit of turns is reached. On the simulated arm Start's press starts the
// task. On a real arm it starts nothing: it shows a row that says what the model will do by itself, with the
// limits as they are set, and only the press of that row starts the task, while Start is still offered and the
// instruction and the limits are the ones the row was shown for. PEAR's task has no "done": it ends when the
// operator clears it. While a task is there, running or paused, nothing else moves the arm, and nothing releases
// it unless the station has failed.

import { type ActionParts, actionSentence } from "./execute_view";
import type { Wording } from "./preflight_view";
import { ACTION_LIMIT_CM, ACTION_LIMIT_RAD, type TaskLimits, TURNS_LIMIT_MAX } from "./station_protocol";
import type { TaskEvent, TaskSnapshot } from "./task_host";
import type { TextKey } from "./texts";

// ---------------------------------------------------------------- Start

/** Why Start is not offered, as a text's key. */
export type TaskWhy = Extract<TextKey, `task.why.${string}`>;

/** The longest instruction PEAR takes, in characters ("Enter a task of 1–20000 characters"). */
export const INSTRUCTION_LIMIT = 20000;

/** What Start's offer is decided on. */
export interface StartFacts {
  /** The arm the station holds or, while the station is off, the arm the window reads; null without an arm. */
  readonly arm: "simulated" | "real" | null;
  /** Whether the station is enabled and its Worker answers. */
  readonly isEnabled: boolean;
  /** Whether the enabled station has failed (`isStationFailed`): the robot is in FAULT or OFF, or a real arm's
   * line is lost. */
  readonly isFailed: boolean;
  /** Whether the console has a task, running or paused. */
  readonly hasTask: boolean;
  /** Whether STOP MOTION is latched. */
  readonly isStopLatched: boolean;
  /** Whether an action is under way: a step by hand, Home, an answer's action, or a command of a task. */
  readonly isActionUnderWay: boolean;
  /** Whether the page is visible. */
  readonly isVisible: boolean;
  /** Whether the camera of step 2 runs. */
  readonly isCameraLive: boolean;
  /** Whether the model service was checked: the service "Ask the model once" asks, and the one a task is given. */
  readonly isServiceChecked: boolean;
  /** The instruction as the operator wrote it. */
  readonly instruction: string;
  /** The limit of turns as the operator wrote it. */
  readonly turnsLimit: string;
  /** Whether the limit of an action's size is ticked. */
  readonly isActionLimited: boolean;
}

/** The limit of turns the page sets at first. */
export const TURNS_LIMIT_DEFAULT = 30;

/** Reads the limit of turns as the operator wrote it: a whole number from 0 to TURNS_LIMIT_MAX in plain digits,
 * with or without blanks around it. Anything else (nothing, a sign, a fraction, an exponent, a larger number) is
 * not a limit the page guesses at: null. */
export function turnsLimitOf(written: string): number | null {
  const digits = written.trim();
  if (!/^[0-9]+$/.test(digits)) return null;
  const turns = Number(digits);

  return turns <= TURNS_LIMIT_MAX ? turns : null;
}

/** Returns the limits a task is started with, as the operator set them; null while the limit of turns is not a
 * whole number from 0 to TURNS_LIMIT_MAX. */
export function limitsOf(facts: Pick<StartFacts, "turnsLimit" | "isActionLimited">): TaskLimits | null {
  const turns = turnsLimitOf(facts.turnsLimit);

  return turns === null ? null : { turns, isActionLimited: facts.isActionLimited };
}

/** Returns the label of the tick that limits an action's size, with the protocol's numbers. */
export function actionLimitLabel(wording: Wording): string {
  return wording.t("task.limit.action", { cm: wording.count(ACTION_LIMIT_CM), rad: wording.count(ACTION_LIMIT_RAD) });
}

export interface StartOffer {
  readonly isOffered: boolean;
  /** Why Start is not offered; null while it is offered. */
  readonly why: TaskWhy | null;
}

/** Decides whether a task may be started now, on either arm: by the enabled station that has not failed, with no
 * task there, STOP MOTION not latched, no action under way, the page visible, the camera running, the model
 * service checked, an instruction written and a limit of turns that is a whole number from 0 to TURNS_LIMIT_MAX.
 * The first thing that is missing is the one that is said. On a real arm the offer is not yet the start: see
 * `startPress`. */
export function startOffer(facts: StartFacts): StartOffer {
  const length = [...facts.instruction.trim()].length;
  const why: TaskWhy | null =
    !facts.isEnabled || facts.arm === null
      ? "task.why.disabled"
      : facts.isFailed
        ? "task.why.failed"
        : facts.hasTask
          ? "task.why.task"
          : facts.isStopLatched
            ? "task.why.stopLatched"
            : facts.isActionUnderWay
              ? "task.why.busy"
              : !facts.isVisible
                ? "task.why.hidden"
                : !facts.isCameraLive
                  ? "task.why.camera"
                  : !facts.isServiceChecked
                    ? "task.why.model"
                    : length === 0
                      ? "task.why.instruction"
                      : length > INSTRUCTION_LIMIT
                        ? "task.why.long"
                        : turnsLimitOf(facts.turnsLimit) === null
                          ? "task.why.limit"
                          : null;

  return { isOffered: why === null, why };
}

// ---------------------------------------------------------------- Start's press, and the row of a real arm

/** What the operator's own press of Start does: nothing while Start is not offered; on the simulated arm it
 * starts the task; on a real arm it starts nothing and only asks, in the row that then shows. */
export type StartPress = "nothing" | "start" | "ask";

/** Returns what the operator's own press of Start does now. */
export function startPress(facts: StartFacts): StartPress {
  if (!startOffer(facts).isOffered) return "nothing";

  return facts.arm === "real" ? "ask" : "start";
}

/** What the row of a real arm's Start was shown for: the instruction, and the limits its sentence names. */
export interface StartAsked {
  readonly instruction: string;
  readonly limits: TaskLimits;
}

/** Returns what the row is shown for when Start is pressed on a real arm; null when that press shows no row. */
export function startAsked(facts: StartFacts): StartAsked | null {
  const limits = limitsOf(facts);

  return startPress(facts) !== "ask" || limits === null ? null : { instruction: facts.instruction, limits };
}

/** Whether the row of a real arm's Start still stands, and so whether the operator's own press of "Start on the
 * arm" starts the task: the row was shown, the arm is a real one, Start is still offered at this moment, and the
 * instruction and both limits are the ones the row was shown for. Anything else takes the row away, and a press
 * of it starts nothing. */
export function isStartStanding(asked: StartAsked | null, facts: StartFacts): boolean {
  if (asked === null || facts.arm !== "real" || !startOffer(facts).isOffered) return false;
  const limits = limitsOf(facts);

  return (
    limits !== null &&
    facts.instruction === asked.instruction &&
    limits.turns === asked.limits.turns &&
    limits.isActionLimited === asked.limits.isActionLimited
  );
}

/** The row of a real arm's Start. */
export interface StartRow {
  /** The sentence: that the model will move the real arm by itself, what ends it, how large an action can be,
   * that nothing looks for the table or an obstacle, and what to keep in reach. */
  readonly ask: string;
  /** The plain warning that both limits are off; null while one of them is on. */
  readonly warning: string | null;
}

/** Returns the row of a real arm's Start for the limits as they are set: the limit of turns with its number, or
 * "until you pause it" when it is 0; the limit of an action's size with the protocol's numbers, or "as large as
 * the model asks" when it is off. */
export function startRow(limits: TaskLimits, wording: Wording): StartRow {
  const { t, count } = wording;
  const ends = limits.turns === 0 ? t("task.confirm.ends.none") : t("task.confirm.ends.limit", { turns: count(limits.turns) });
  const size = limits.isActionLimited
    ? t("task.confirm.size.limit", { cm: count(ACTION_LIMIT_CM), rad: count(ACTION_LIMIT_RAD) })
    : t("task.confirm.size.none");
  const isUnlimited = limits.turns === 0 && !limits.isActionLimited;

  return { ask: t("task.confirm.ask", { ends, size }), warning: isUnlimited ? t("task.confirm.unlimited") : null };
}

// ---------------------------------------------------------------- the limits a task runs with, and Resume's row

/** A task without limits: no pause after a count of turns, and an action as large as the model asks. */
export const NO_TASK_LIMITS: TaskLimits = { turns: 0, isActionLimited: false };

/** Returns the limits the page says of the task that is there: the ones the Worker's status tells
 * (StationStatus.taskLimits), never the ones the page sent. A status that tells none for a task says that the
 * task runs without limits. */
export function limitsHeld(told: TaskLimits | null | undefined): TaskLimits {
  return told ?? NO_TASK_LIMITS;
}

/** What Resume is decided on. */
export interface ResumeFacts {
  /** The arm the station holds; null without one. */
  readonly arm: "simulated" | "real" | null;
  /** Whether a resume is offered at this moment: Resume shows (`taskControls`), the station is on and its Worker
   * answers, and no command of a task waits for its answer. */
  readonly isOffered: boolean;
  /** The limits the status tells of the task that is there; null when it tells none. */
  readonly limits: TaskLimits | null | undefined;
}

/** What the operator's own press of Resume does: nothing while no resume is offered; on the simulated arm it
 * resumes the task; on a real arm it resumes nothing and only asks, in the row that then shows, as Start does. */
export type ResumePress = "nothing" | "resume" | "ask";

/** Returns what the operator's own press of Resume does now. */
export function resumePress(facts: ResumeFacts): ResumePress {
  if (!facts.isOffered || facts.arm === null) return "nothing";

  return facts.arm === "real" ? "ask" : "resume";
}

/** What the row of a real arm's Resume was shown for: the limits its sentence names. */
export interface ResumeAsked {
  readonly limits: TaskLimits;
  /** Whether the status told these limits; false when it told none and the row says so. */
  readonly isTold: boolean;
}

/** Returns what the row is shown for when Resume is pressed on a real arm; null when that press shows no row. */
export function resumeAsked(facts: ResumeFacts): ResumeAsked | null {
  return resumePress(facts) !== "ask" ? null : { limits: limitsHeld(facts.limits), isTold: facts.limits != null };
}

/** Whether the row of a real arm's Resume still stands, and so whether the operator's own press of "Resume on the
 * arm" resumes the task: the row was shown, the arm is a real one, a resume is still offered at this moment, and
 * the limits the status tells are the ones the row was shown for. Anything else takes the row away, and a press
 * of it resumes nothing. */
export function isResumeStanding(asked: ResumeAsked | null, facts: ResumeFacts): boolean {
  if (asked === null || facts.arm !== "real" || !facts.isOffered) return false;
  const limits = limitsHeld(facts.limits);

  return (
    (facts.limits != null) === asked.isTold &&
    limits.turns === asked.limits.turns &&
    limits.isActionLimited === asked.limits.isActionLimited
  );
}

/** Returns the row of a real arm's Resume, in the parts of Start's row: that the model will move the real arm
 * again by itself, what ends it and how large an action can be with the limits the task holds, that nothing
 * looks for the table or an obstacle, and what to keep in reach. Its warning says that both limits are off, or
 * that the station told no limits for the task, which then runs without any. */
export function resumeRow(asked: ResumeAsked, wording: Wording): StartRow {
  const { t, count } = wording;
  const { limits } = asked;
  const ends = limits.turns === 0 ? t("task.confirm.ends.none") : t("task.confirm.ends.limit", { turns: count(limits.turns) });
  const size = limits.isActionLimited
    ? t("task.confirm.size.limit", { cm: count(ACTION_LIMIT_CM), rad: count(ACTION_LIMIT_RAD) })
    : t("task.confirm.size.none");
  const isUnlimited = limits.turns === 0 && !limits.isActionLimited;
  const warning = !asked.isTold ? t("task.limits.none") : isUnlimited ? t("task.confirm.unlimited") : null;

  return { ask: t("task.resume.ask", { ends, size }), warning };
}

// ---------------------------------------------------------------- a station that is lost during a task

/** Whether the page ends the Worker at once when it finds the station lost: while a task is there or the console
 * is busy, on either arm. A Worker that does not answer may still run: its task would go on asking the model and
 * moving an arm that the page can no longer stop. Without a task the page only says that the station is lost. */
export function isEndedWhenLost(
  status: { readonly task: TaskSnapshot | null; readonly action: string | null } | null | undefined,
): boolean {
  return status != null && (hasTask(status.task) || status.task?.isBusy === true || status.action === "task");
}

// ---------------------------------------------------------------- a station that has failed, and Disable

/** Whether the enabled station has failed, so that nothing of a task goes on: the robot is in FAULT or OFF, or a
 * real arm's line is lost. */
export function isStationFailed(robot: string | null | undefined, isLineLost: boolean): boolean {
  return robot === "FAULT" || robot === "OFF" || isLineLost;
}

/** Whether Disable is offered by the enabled station: not while a task is there, which is cleared first, except
 * when the station has failed: the Worker then ends the task with the station, and Disable is the way out. */
export function isDisableOffered(facts: { readonly isOn: boolean; readonly hasTask: boolean; readonly isFailed: boolean }): boolean {
  return facts.isOn && (!facts.hasTask || facts.isFailed);
}

// ---------------------------------------------------------------- the controls

/** Whether the console has a task, running or paused: while it has, the steps by hand, Home, "Ask the model
 * once" and "Execute this action" are not offered, and Disable only when the station has failed
 * (`isDisableOffered`). */
export function hasTask(snapshot: TaskSnapshot | null | undefined): boolean {
  return snapshot != null && snapshot.task !== null;
}

/** Which controls of a task show for what the console tells. */
export interface TaskControls {
  /** Start: while there is no task. Whether it is offered then is `startOffer`'s to say. */
  readonly start: boolean;
  /** Pause: while the task runs and no stop was asked yet. */
  readonly pause: boolean;
  /** Resume: while the task is paused and STOP MOTION is not latched (PEAR: "Reset STOP MOTION before
   * continuing"). */
  readonly resume: boolean;
  /** Clear the task: while the task is paused, also by a latched STOP MOTION, which PEAR's "clear" does not wait
   * for. */
  readonly clear: boolean;
  /** Reset STOP MOTION: while it is latched, with a task or without one. */
  readonly resetStop: boolean;
}

/** Returns the controls that show. A task runs while an operation of the console runs (its turns, or its
 * clearing), and is paused otherwise: by the operator, by a turn that failed, or by STOP MOTION. */
export function taskControls(snapshot: TaskSnapshot | null | undefined): TaskControls {
  const isThere = hasTask(snapshot);
  const isBusy = snapshot?.isBusy === true;
  const isLatched = snapshot?.isStopLatched === true;

  return {
    start: !isThere,
    pause: isThere && isBusy && snapshot?.phase !== "Stopping",
    resume: isThere && !isBusy && !isLatched,
    clear: isThere && !isBusy,
    resetStop: isLatched,
  };
}

// ---------------------------------------------------------------- the phase and the status, in words

/** The sentences of the phases a console with a task goes through; PEAR's word of the phase names each. */
const PHASE_KEYS: Readonly<Record<string, TextKey>> = {
  Holding: "task.phase.holding",
  Observing: "task.phase.observing",
  Thinking: "task.phase.thinking",
  Planning: "task.phase.planning",
  Executing: "task.phase.executing",
  Settling: "task.phase.settling",
  Compacting: "task.phase.compacting",
  Stopping: "task.phase.stopping",
  Paused: "task.phase.paused",
  Stopped: "task.phase.stopped",
};

/** Returns the console's phase in words. A phase this page has no sentence for is said in PEAR's own word. */
export function phaseWords(phase: string, wording: Wording): string {
  const key = Object.hasOwn(PHASE_KEYS, phase) ? PHASE_KEYS[phase] : undefined;

  return key === undefined ? wording.t("task.phase.other", { phase }) : wording.t(key);
}

/** The line of the task's state. */
export interface TaskStatusLine {
  /** PEAR's word of the console's phase, for `data-phase`; empty while no console is there. */
  readonly phase: string;
  readonly text: string;
}

/** Returns the line of the task's state: the phase in words, the number of the running or the last turn, and the
 * count of the actions that completed. Without a task it says so, and whether STOP MOTION is latched. */
export function taskStatus(snapshot: TaskSnapshot | null | undefined, wording: Wording): TaskStatusLine {
  if (snapshot == null) return { phase: "", text: wording.t("task.status.none") };
  if (snapshot.task === null) {
    return { phase: snapshot.phase, text: wording.t(snapshot.isStopLatched ? "task.status.latched" : "task.status.none") };
  }
  const words = phaseWords(snapshot.phase, wording);
  const steps = wording.count(snapshot.totalSteps);
  const turn = snapshot.activeTurn;

  return {
    phase: snapshot.phase,
    text:
      turn === null
        ? wording.t("task.status.noTurn", { phase: words, steps })
        : wording.t("task.status.turn", { phase: words, turn: wording.count(turn.turn_number), steps }),
  };
}

/** Returns the failure the console shows, with what can be done about it: reset STOP MOTION, resume or clear the
 * paused task, or start again when no task is there; null without a failure. */
export function taskError(snapshot: TaskSnapshot | null | undefined, wording: Wording): string | null {
  if (snapshot == null || snapshot.error === null) return null;
  const controls = taskControls(snapshot);
  const key: TextKey = controls.resetStop
    ? "task.error.reset"
    : controls.resume
      ? "task.error.resume"
      : controls.start
        ? "task.error.noTask"
        : "task.error.running";

  return wording.t(key, { error: snapshot.error });
}

/** Returns why the Worker itself paused the task, in a sentence: its limit of turns was reached (with the limit
 * the task was started with, and that Resume runs as many again), or the page was hidden; null when the Worker
 * did not pause it. `limits` is what the Worker's status tells of the task (StationStatus.taskLimits), not what
 * the page sent; when the status tells none, or no limit of turns, the limit is said without its number. */
export function pausedByWords(
  pausedBy: "limit" | "hidden" | null | undefined,
  limits: TaskLimits | null,
  wording: Wording,
): string | null {
  if (pausedBy === "hidden") return wording.t("task.pausedBy.hidden");
  if (pausedBy !== "limit") return null;

  return limits === null || limits.turns === 0
    ? wording.t("task.pausedBy.limitUnknown")
    : wording.t("task.pausedBy.limit", { turns: wording.count(limits.turns) });
}

/** The inference numbers the page shows of a `performance` report, under PEAR's own names. */
const PERFORMANCE_FIELDS = [
  "first_visible_output_s",
  "elapsed_s",
  "output_tokens",
  "output_throughput_tps",
  "decode_throughput_tps",
] as const;

/** Returns the inference numbers of a report as "name value" pairs, in PEAR's names; null when it holds none. */
export function performanceWords(performance: Readonly<Record<string, unknown>> | null | undefined): string | null {
  if (performance == null) return null;
  const pairs: string[] = [];
  for (const name of PERFORMANCE_FIELDS) {
    const value = performance[name];
    if (typeof value === "number" && Number.isFinite(value)) {
      pairs.push(`${name} ${Number.isInteger(value) ? String(value) : value.toFixed(2)}`);
    }
  }

  return pairs.length === 0 ? null : pairs.join(" · ");
}

// ---------------------------------------------------------------- the turns, from the console's events

/** How many turns the list keeps: the newest ones. Older turns are counted, not listed. */
export const TURNS_KEPT = 30;

/** One turn of the task, as the list shows it. */
export interface TaskTurn {
  /** The turn's number in the task, from 1. */
  readonly number: number;
  /** PEAR's id of the turn's attempt; empty when the events did not tell it. */
  readonly attempt: string;
  /** The action the model answered with; null before the answer, and for an answer without an action. */
  readonly action: ActionParts | null;
  /** The turn's result, of the event `execution`: PEAR's status ("completed", "rejected", "failed", ...) and the
   * error's message; null while the turn has none. */
  readonly result: { readonly status: string; readonly error: string | null } | null;
  /** How a turn ended that did not complete, of the events `turn_end` and `interrupted`: PEAR's word
   * ("Interrupted", "Failed", "Context limit") and its message. */
  readonly end: { readonly phase: string; readonly message: string | null } | null;
}

/** What the page keeps of a task's events. */
export interface TaskTurns {
  /** The id of the task the turns are of; null before the first task. */
  readonly taskId: string | null;
  /** The turns, the newest first; at most TURNS_KEPT. */
  readonly turns: readonly TaskTurn[];
  /** How many older turns the list has let go. */
  readonly forgotten: number;
  /** The reasoning and the answer of the newest turn, as they streamed. */
  readonly reasoning: string;
  readonly answer: string;
  /** The inference report of the newest turn; null before the first. */
  readonly performance: Readonly<Record<string, unknown>> | null;
  /** The message of the last stop that was asked; null once a turn begins after it. */
  readonly stop: string | null;
  /** Whether the task was cleared. Its turns stay listed until the next task starts. */
  readonly isCleared: boolean;
  /** The id of the last event taken; 0 before the first. */
  readonly lastId: number;
  /** How many events of this task did not reach the page: the gaps in the events' ids. */
  readonly missed: number;
}

/** Returns what the page keeps before any event. */
export function noTurns(): TaskTurns {
  return {
    taskId: null,
    turns: [],
    forgotten: 0,
    reasoning: "",
    answer: "",
    performance: null,
    stop: null,
    isCleared: false,
    lastId: 0,
    missed: 0,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

const ARM_PARTS = ["x", "y", "z", "pitch", "roll"] as const;

/** Reads the action of an event `action`; null when it is not an action of the model's format. */
function actionOf(data: Readonly<Record<string, unknown>>): ActionParts | null {
  const arm = data["arm"];
  const gripper = data["gripper"];
  if (!isRecord(arm) || !isRecord(gripper)) return null;
  const width = gripper["width"];
  if (typeof width !== "number" || !ARM_PARTS.every((name) => typeof arm[name] === "number")) return null;
  const part = (name: (typeof ARM_PARTS)[number]): number => arm[name] as number;

  return { arm: { x: part("x"), y: part("y"), z: part("z"), pitch: part("pitch"), roll: part("roll") }, gripper: { width } };
}

/** Returns the state with the turn an event names changed by `change`. An event of a turn carries the turn's
 * fields; a turn that is not listed yet is added as the newest (its beginning was dropped, or this event is its
 * beginning), and the stream of the turn before it is let go. An event without the turn's fields is of the newest
 * turn. */
function withTurn(state: TaskTurns, data: Readonly<Record<string, unknown>>, change: (turn: TaskTurn) => TaskTurn): TaskTurns {
  const number = data["turn_number"];
  if (typeof number !== "number") {
    const [newest, ...older] = state.turns;

    return newest === undefined ? state : { ...state, turns: [change(newest), ...older] };
  }
  const attempt = textOf(data["attempt"]) ?? "";
  const at = state.turns.findIndex((turn) => turn.number === number && turn.attempt === attempt);
  if (at >= 0) return { ...state, turns: state.turns.map((turn, index) => (index === at ? change(turn) : turn)) };
  const turns = [change({ number, attempt, action: null, result: null, end: null }), ...state.turns];
  const over = Math.max(0, turns.length - TURNS_KEPT);

  return {
    ...state,
    turns: turns.slice(0, TURNS_KEPT),
    forgotten: state.forgotten + over,
    reasoning: "",
    answer: "",
    performance: null,
    stop: null,
  };
}

/** Takes one event of the console and returns what the page keeps after it. The events' ids count up by one: a
 * gap tells that events were dropped before they reached the page, and is counted. An id that is not above the
 * last one is the first of a new console, whose events are numbered from 1 again. */
export function takeEvent(state: TaskTurns, event: TaskEvent): TaskTurns {
  const expected = state.lastId + 1;
  const missed = event.id >= expected ? event.id - expected : Math.max(0, event.id - 1);
  const told: TaskTurns = { ...state, lastId: event.id, missed: state.missed + missed };
  const data = event.data;
  const keep = (turn: TaskTurn): TaskTurn => turn;

  switch (event.type) {
    case "task":
      // a new task: the list begins again; what was dropped before it was of the task before
      return { ...noTurns(), taskId: textOf(data["id"]) ?? event.task_id, lastId: event.id };
    case "turn_started":
      return withTurn(told, data, keep);
    case "reasoning_delta": {
      const next = withTurn(told, data, keep);

      return { ...next, reasoning: next.reasoning + (textOf(data["text"]) ?? "") };
    }
    case "answer_delta": {
      const next = withTurn(told, data, keep);

      return { ...next, answer: next.answer + (textOf(data["text"]) ?? "") };
    }
    case "model_output": {
      // the whole answer, which also mends a stream that lost a piece
      const next = withTurn(told, data, keep);

      return {
        ...next,
        reasoning: textOf(data["reasoning"]) ?? next.reasoning,
        answer: textOf(data["answer"]) ?? next.answer,
      };
    }
    case "performance": {
      const next = withTurn(told, data, keep);

      return { ...next, performance: data };
    }
    case "action":
      return withTurn(told, data, (turn) => ({ ...turn, action: actionOf(data) }));
    case "execution": {
      const error = data["error"];
      const message = isRecord(error) ? (textOf(error["message"]) ?? JSON.stringify(error)) : textOf(error);

      return withTurn(told, data, (turn) => ({ ...turn, result: { status: String(data["status"]), error: message } }));
    }
    case "turn_end":
      return withTurn(told, data, (turn) => ({
        ...turn,
        end: { phase: textOf(data["phase"]) ?? "", message: textOf(data["message"]) ?? turn.end?.message ?? null },
      }));
    case "interrupted":
      return withTurn(told, data, (turn) => ({
        ...turn,
        end: { phase: turn.end?.phase ?? "Interrupted", message: textOf(data["message"]) ?? turn.end?.message ?? null },
      }));
    case "stopping":
      return { ...told, stop: textOf(data["message"]) };
    case "task_end":
      return { ...told, isCleared: true };
    default:
      return told;
  }
}

/** Returns a turn's result in words: PEAR's status and the error's message; for a turn without a result, how it
 * ended; for a turn that still runs, that it runs. PEAR's words stay PEAR's. */
export function resultWords(turn: TaskTurn, wording: Wording): string {
  if (turn.result !== null) {
    return turn.result.error === null
      ? wording.t("task.turn.result", { status: turn.result.status })
      : wording.t("task.turn.resultError", { status: turn.result.status, error: turn.result.error });
  }
  if (turn.end !== null) {
    return turn.end.message === null
      ? wording.t("task.turn.ended", { phase: turn.end.phase })
      : wording.t("task.turn.endedMessage", { phase: turn.end.phase, message: turn.end.message });
  }

  return wording.t("task.turn.running");
}

/** Returns a turn's action in words, as the panel of the ask says an action; for a turn without one, whether the
 * answer held none or is not there yet. */
export function actionWords(turn: TaskTurn, wording: Wording): string {
  if (turn.action !== null) return actionSentence(turn.action, wording);

  return wording.t(turn.result !== null || turn.end !== null ? "task.turn.noAction" : "task.turn.noActionYet");
}

/** Returns one line of the turns' list: the turn's number, its action in words, and its result. */
export function turnLine(turn: TaskTurn, wording: Wording): string {
  return wording.t("task.turn.line", {
    turn: wording.count(turn.number),
    action: actionWords(turn, wording),
    result: resultWords(turn, wording),
  });
}

/** Returns the note of the turns' list: its order and its bound, and how many older turns it has let go. */
export function turnsNote(state: TaskTurns, wording: Wording): string {
  const note = wording.t("task.turns.note", { kept: wording.count(TURNS_KEPT) });

  return state.forgotten === 0 ? note : `${note} ${wording.t("task.turns.forgotten", { count: wording.count(state.forgotten) })}`;
}

/** Returns the warning of events that did not reach the page; null while every event did. */
export function gapWords(state: TaskTurns, wording: Wording): string | null {
  return state.missed === 0 ? null : wording.t("task.gap", { count: wording.count(state.missed) });
}

// ---------------------------------------------------------------- the page's log

/** How many characters of the instruction the log's line of Start holds. */
export const LOGGED_INSTRUCTION = 80;

/** Returns the log's line for a task's start: the arm, the two limits it is started with, the instruction's
 * length and its first 80 characters. Nothing of the model service is in it. */
export function startLogLine(instruction: string, limits: TaskLimits, arm: "simulated" | "real"): string {
  const characters = [...instruction];
  const turns = limits.turns === 0 ? "none" : String(limits.turns);
  const action = limits.isActionLimited ? `${ACTION_LIMIT_CM} cm, ${ACTION_LIMIT_RAD} rad` : "none";

  return (
    `Task: start on the ${arm} arm (turns limit: ${turns}; action limit: ${action}), ` +
    `instruction of ${characters.length} characters: ${JSON.stringify(characters.slice(0, LOGGED_INSTRUCTION).join(""))}`
  );
}

/** Returns the log's line for a task's resume on a real arm, written at the press of "Resume on the arm": the
 * limits the station told of the task, or that it told none. */
export function resumeLogLine(asked: ResumeAsked): string {
  const turns = asked.limits.turns === 0 ? "none" : String(asked.limits.turns);
  const action = asked.limits.isActionLimited ? `${ACTION_LIMIT_CM} cm, ${ACTION_LIMIT_RAD} rad` : "none";

  return asked.isTold
    ? `Task: resume on the real arm (turns limit: ${turns}; action limit: ${action})`
    : "Task: resume on the real arm (the station told no limits: the task runs without limits)";
}

/** Returns the log's line for one event of the console, or null for an event the log does not hold: a turn's
 * action, its result (PEAR's status and error), the message of a stop or of a failure, and the clearing of the
 * task. A streamed piece is never logged. */
export function eventLogLine(event: TaskEvent): string | null {
  const data = event.data;
  const turn = typeof data["turn_number"] === "number" ? String(data["turn_number"]) : "?";
  switch (event.type) {
    case "action":
      return `Task: turn ${turn} action ${JSON.stringify({ type: data["type"], arm: data["arm"], gripper: data["gripper"] })}`;
    case "execution":
      return `Task: turn ${turn} result ${JSON.stringify({ status: data["status"], error: data["error"] ?? null })}`;
    case "stopping":
    case "error":
      return `Task: ${textOf(data["message"]) ?? JSON.stringify(data)}`;
    case "task_end":
      return "Task: cleared";
    default:
      return null;
  }
}
