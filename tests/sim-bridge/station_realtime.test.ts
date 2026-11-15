import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { BridgeControl, bridgeAddress } from "./bridge_control";
import { loadStationReference } from "./replayed_chain";
import type { ModelStateRecord, MotionRecord, StationRunResult, StationStepRecord } from "./station_result";
import { loadStationSessions, stationJson, StationRunner, type KinematicsAnswer } from "./station_runner";

// pear.js's whole station in real time: SO101Robot on its real driver with its own control loop, started as the
// port starts it and given no clock (so it runs on realTimeClock(), as a caller of the library gets it), on a
// simulated SO-101 servo chain whose arm runs on the wall clock. The chain is not part of this repository; the
// tests run only when the environment says where one is, and are skipped without it.
//
//   PEAR_JS_SIM_BRIDGE_STATION_REALTIME=host:port          the serial line of a chain started on its real-time clock
//   PEAR_JS_SIM_BRIDGE_STATION_REALTIME_CONTROL=host:port  its controls (default: the same host, the next port)
//   PEAR_JS_STATION_SESSIONS=name;name                     the sessions to run, by their names in
//                                                          station_session.json, or "all" (default: the shortest)
//   PEAR_JS_STATION_REFERENCE=file                         the reference's stepped result that holds these sessions
//                                                          (default: the committed station_reference.result.json.gz)
//   PEAR_JS_STATION_REALTIME_REFERENCE=file;file           results of the reference's own runs in real time, to
//                                                          compare with too (default: none)
//   PEAR_JS_STATION_KINEMATICS=file                        PEAR's kinematics' answers (default: station_kinematics.json)
//   PEAR_JS_STATION_OUT=directory                          where each run's result is written
//
// A run in real time is never twice the same: the loop's steps and the caller's calls fall where the machine lets
// them, and an event of the script (a pause, a fault) lands a few steps earlier or later. So nothing here is
// compared bit for bit. What is asserted is what the reference's own runs in real time keep, between each other
// and beside its stepped run (docs/progress/station-reference.md, "How much is timing": the rows that are 0 in
// every column): which steps raise, and what; of every action's result its status, whether it settled, whether it
// reached, the gripper's outcome and the error; the report the next turn tells the model. Everything else is
// counted and printed, one line "RT {...}" of JSON a session: the turns' texts, the model's states, the measured
// positions, the ticks.
//
// Each session is run with pear.js's own kinematics, and with PEAR's answers in the place of the kinematics'
// (station_kinematics.json: the answers of the reference's stepped run, in the order they were given). An answer
// of that file is PEAR's to another question wherever the arm stood elsewhere than in the stepped run; the line
// says how many questions were other ones (`asked_otherwise`).

const address = bridgeAddress({
  PEAR_JS_SIM_BRIDGE: process.env.PEAR_JS_SIM_BRIDGE_STATION_REALTIME,
  PEAR_JS_SIM_BRIDGE_CONTROL: process.env.PEAR_JS_SIM_BRIDGE_STATION_REALTIME_CONTROL,
});
const SHORTEST = "a short session from the rest pose";
const asked = process.env.PEAR_JS_STATION_SESSIONS || SHORTEST;
const here = (name: string): string => fileURLToPath(new URL(name, import.meta.url));
const referenceFile = process.env.PEAR_JS_STATION_REFERENCE;
const realTimeFiles = (process.env.PEAR_JS_STATION_REALTIME_REFERENCE ?? "").split(";").filter((name) => name !== "");
const kinematicsFile = process.env.PEAR_JS_STATION_KINEMATICS || here("./station_kinematics.json");
const outDirectory = process.env.PEAR_JS_STATION_OUT;

/** The measured position's last coordinate is the gripper's opening; the others are arm joints, rad. */
const COUNTS_PER_RAD = 4096 / (2 * Math.PI);
const LISTED = 6; // differences told in words; all are counted

/** What the model reads of two runs of the same sessions, one beside the other, and what timing moves. */
interface ModelView {
  steps: number;
  /** Steps that raised in one run and returned in the other. */
  raised_on_one_side: number;
  /** Steps that raised in both, and those of them that raised another class or message. */
  raised_on_both: number;
  raised_otherwise: number;
  /** Results of actions (executed, or recorded as failed), and those that differ in each part. */
  results: number;
  status: number;
  settled: number;
  reached: number;
  gripper_outcome: number;
  error: number;
  /** The reports the next turn tells the model. */
  reports_differing: number;
  /** The turns' texts, and the sessions of those that differ. */
  turns: number;
  turn_texts_differing: number;
  turn_texts_by_session: Record<string, number>;
  states_differing: number;
  /** The largest difference of each quantity the model is shown (cm, rad). */
  largest_shown: Record<string, number>;
  /** The measured positions of the results, by whether the action completed. */
  completed: PositionGap;
  not_completed: PositionGap;
  /** The loop's steps, [the reference's, the candidate's]: of all steps but `open`, and of `open`. */
  ticks: [number, number];
  ticks_of_open: [number, number];
  /** The first differences, in words. */
  first: string[];
}

interface PositionGap {
  compared: number;
  identical: number;
  max_joint_rad: number;
  max_joint_counts: number;
  max_opening: number;
}

type ActionReturn = { result: MotionRecord; feedback: string };
type TurnReturn = { state: ModelStateRecord; text: string };

function isAction(returned: unknown): returned is ActionReturn {
  return typeof returned === "object" && returned !== null && "result" in returned;
}

function isTurn(returned: unknown): returned is TurnReturn {
  return typeof returned === "object" && returned !== null && "text" in returned;
}

/** Compares what the model reads of ``candidate`` with what it reads of ``reference``. */
function modelView(reference: StationRunResult, candidate: StationRunResult): ModelView {
  const gap = (): PositionGap => ({ compared: 0, identical: 0, max_joint_rad: 0, max_joint_counts: 0, max_opening: 0 });
  const view: ModelView = {
    steps: 0,
    raised_on_one_side: 0,
    raised_on_both: 0,
    raised_otherwise: 0,
    results: 0,
    status: 0,
    settled: 0,
    reached: 0,
    gripper_outcome: 0,
    error: 0,
    reports_differing: 0,
    turns: 0,
    turn_texts_differing: 0,
    turn_texts_by_session: {},
    states_differing: 0,
    largest_shown: {},
    completed: gap(),
    not_completed: gap(),
    ticks: [0, 0],
    ticks_of_open: [0, 0],
    first: [],
  };
  const say = (line: string): void => {
    if (view.first.length < LISTED) view.first.push(line);
  };

  reference.sessions.forEach((session, sessionIndex) => {
    session.steps.forEach((step: StationStepRecord, stepIndex) => {
      const found = candidate.sessions[sessionIndex]?.steps[stepIndex];
      if (found === undefined) return;
      const where = `${session.name} / ${step.id} ${step.op}`;
      view.steps += 1;
      if ((step.raised === undefined) !== (found.raised === undefined)) {
        view.raised_on_one_side += 1;
        say(`${where}: ${step.raised === undefined ? "returned" : "raised"} against ${found.raised === undefined ? "returned" : `raised ${found.raised.type}: ${found.raised.message}`}`);
      }
      if (step.raised !== undefined && found.raised !== undefined) {
        view.raised_on_both += 1;
        if (step.raised.type !== found.raised.type || step.raised.message !== found.raised.message) {
          view.raised_otherwise += 1;
          say(`${where}: raised ${step.raised.type}: ${step.raised.message} against ${found.raised.type}: ${found.raised.message}`);
        }
      }
      if (step.ticks !== undefined && found.ticks !== undefined && step.op !== "reset") {
        const ticks = step.op === "open" ? view.ticks_of_open : view.ticks;
        ticks[0] += step.ticks;
        ticks[1] += found.ticks;
      }

      const [ours, theirs] = [step.returned, found.returned];
      if (isAction(ours) && isAction(theirs)) {
        view.results += 1;
        const [a, b] = [ours.result, theirs.result];
        for (const key of ["status", "settled", "reached", "gripper_outcome"] as const) {
          if (a[key] !== b[key]) {
            view[key] += 1;
            say(`${where}: result.${key} ${String(a[key])} against ${String(b[key])}`);
          }
        }
        if (a.error?.code !== b.error?.code || a.error?.message !== b.error?.message) {
          view.error += 1;
          say(`${where}: result.error ${JSON.stringify(a.error)} against ${JSON.stringify(b.error)}`);
        }
        if (ours.feedback !== theirs.feedback) {
          view.reports_differing += 1;
          say(`${where}: report ${JSON.stringify(ours.feedback)} against ${JSON.stringify(theirs.feedback)}`);
        }
        const [first, second] = [a.measured_position, b.measured_position];
        if (first !== null && second !== null) {
          const positions = a.status === "completed" ? view.completed : view.not_completed;
          positions.compared += 1;
          if (first.length === second.length && first.every((value, index) => Object.is(value, second[index]))) positions.identical += 1;
          first.forEach((value, index) => {
            const difference = Math.abs(value - (second[index] ?? Number.NaN));
            const key = index === first.length - 1 ? "max_opening" : "max_joint_rad";
            if (!(difference <= positions[key])) positions[key] = difference; // a NaN is kept
          });
          positions.max_joint_counts = Math.round(positions.max_joint_rad * COUNTS_PER_RAD * 100) / 100;
        }
      }
      if (isTurn(ours) && isTurn(theirs)) {
        view.turns += 1;
        if (ours.text !== theirs.text) {
          view.turn_texts_differing += 1;
          view.turn_texts_by_session[session.name] = (view.turn_texts_by_session[session.name] ?? 0) + 1;
        }
        let isSame = true;
        for (const [part, quantities] of Object.entries(ours.state)) {
          for (const [name, value] of Object.entries(quantities as Record<string, number>)) {
            const other = (theirs.state as unknown as Record<string, Record<string, number>>)[part]?.[name] ?? Number.NaN;
            const difference = Math.abs(value - other);
            if (!(difference <= (view.largest_shown[name] ?? 0))) view.largest_shown[name] = Math.round(difference * 1e6) / 1e6;
            isSame = isSame && difference === 0;
          }
        }
        if (!isSame) view.states_differing += 1;
      }
    });
  });

  return view;
}

/** ``stored`` with only the sessions named, in their order. */
function sessionsOf(stored: StationRunResult, names: readonly string[], file: string): StationRunResult {
  return {
    ...stored,
    sessions: names.map((name) => {
      const session = stored.sessions.find((each) => each.name === name);
      if (session === undefined) throw new Error(`${file} holds no session '${name}'`);
      return session;
    }),
  };
}

describe.skipIf(address === null)("pear.js's station in real time on a simulated SO-101 servo chain, beside PEAR's", () => {
  const { host, port, control: controlAddress } = address ?? { host: "", port: 0, control: "" };

  /** Runs the sessions once in real time, prints a line a session and asserts what PEAR's own runs in real time
   * keep; ``isRecorded``: with PEAR's kinematics' answers. */
  async function runAndCompare(isRecorded: boolean): Promise<void> {
    const sessions = loadStationSessions();
    const every = sessions.document.sessions.map((session) => session.name);
    const names = asked === "all" ? every : asked.split(";").filter((name) => name !== "");
    const ordered = every.filter((name) => names.includes(name));
    expect(ordered).toHaveLength(names.length); // every name is a session's

    const kinematics = isRecorded ? (JSON.parse(readFileSync(kinematicsFile, "utf8")) as Record<string, KinematicsAnswer[]>) : undefined;
    const runner = new StationRunner({ host, port, control: new BridgeControl(controlAddress), clock: "realtime", sessions, only: ordered, kinematics });
    const result = await runner.run();
    const tag = isRecorded ? "recorded" : "own";
    if (outDirectory !== undefined && outDirectory !== "") {
      mkdirSync(outDirectory, { recursive: true });
      writeFileSync(join(outDirectory, `realtime.${tag}.result.json`), stationJson(result));
    }

    const stepped =
      referenceFile === undefined || referenceFile === ""
        ? loadStationReference().result
        : (JSON.parse(readFileSync(referenceFile, "utf8")) as StationRunResult);
    expect(stepped.clock).toBe("stepped");
    const references: [name: string, result: StationRunResult][] = [["stepped", sessionsOf(stepped, ordered, "the stepped reference")]];
    realTimeFiles.forEach((file, index) => {
      const stored = JSON.parse(readFileSync(file, "utf8")) as StationRunResult;
      expect(stored.clock, file).toBe("realtime");
      references.push([`realtime ${index + 1}`, sessionsOf(stored, ordered, file)]);
    });

    expect(result.clock).toBe("realtime");
    expect(result.sessions.map((session) => session.name)).toEqual(ordered);
    result.sessions.forEach((session, index) => {
      const only = (run: StationRunResult): StationRunResult => ({ ...run, sessions: [run.sessions[index]] });
      const views = Object.fromEntries(references.map(([name, reference]) => [name, modelView(only(reference), only(result))]));
      const otherwise = runner.askedOtherwise.filter((line) => line.startsWith(`${session.name}: `)).length;
      console.log(
        `RT ${JSON.stringify({
          session: session.name,
          kinematics: tag,
          engine: `${process.version} ${process.platform}`,
          wall_s: session.wall_s,
          line: { unanswered: session.line.unanswered, corrupt_packets: session.line.corrupt_packets, dropped_bytes: session.line.dropped_bytes },
          asked: runner.asked[session.name]?.length ?? 0,
          asked_otherwise: otherwise,
          event_errors: runner.eventErrors.length,
          note: session.note ?? null,
          against: views,
          clock: result.run.real_time_clock,
        })}`,
      );

      // every session ran all its steps, the chain answered every packet, the script closed the robot, and every
      // event of the script was done
      expect(session.steps).toHaveLength(references[0][1].sessions[index].steps.length);
      expect(session.line.unanswered, session.name).toEqual({});
      expect(session.line.corrupt_packets, session.name).toBe(0);
      expect(session.line.dropped_bytes, session.name).toBe(0);
      expect(session.note, session.name).toBeUndefined();
      // what PEAR's own runs in real time keep, beside its stepped run and beside each other
      for (const [name, view] of Object.entries(views)) {
        const kept = {
          raised_on_one_side: view.raised_on_one_side,
          raised_otherwise: view.raised_otherwise,
          status: view.status,
          settled: view.settled,
          reached: view.reached,
          gripper_outcome: view.gripper_outcome,
          error: view.error,
          reports_differing: view.reports_differing,
        };
        expect({ kept, first: view.first }, `${session.name}, beside ${name}`).toEqual({
          kept: { raised_on_one_side: 0, raised_otherwise: 0, status: 0, settled: 0, reached: 0, gripper_outcome: 0, error: 0, reports_differing: 0 },
          first: view.first,
        });
        expect(view.steps, `${session.name}, beside ${name}`).toBe(session.steps.length);
        expect(view.results + view.turns, `${session.name}, beside ${name}`).toBeGreaterThan(0);
      }
    });
    expect(runner.eventErrors).toEqual([]);
  }

  test("with its own kinematics, every step ends as PEAR's and every action's result and report are PEAR's", async () => {
    await runAndCompare(false);
  }, 600_000);

  test("with PEAR's kinematics' answers, every step ends as PEAR's and every action's result and report are PEAR's", async () => {
    await runAndCompare(true);
  }, 600_000);
});
