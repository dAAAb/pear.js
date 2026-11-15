import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { installOracle, type Oracle } from "../ruckig/oracle";
import { BridgeControl, bridgeAddress } from "./bridge_control";
import { compareStationResults, describeStationComparison, measuredPositionGap, type StationComparison } from "./compare_station";
import type { StationRunResult } from "./station_result";
import { loadStationSessions, stationJson, StationRunner, type KinematicsAnswer } from "./station_runner";

// pear.js's whole station (SO101Robot on its real driver) on a simulated SO-101 servo chain reachable over TCP,
// which is not part of this repository, compared with what PEAR's Python robot did on the same chain with the same
// script (docs/progress/station-reference.md, docs/progress/station-chain.md). The tests run only when the
// environment says where such a chain is; without it they are skipped.
//
//   PEAR_JS_SIM_BRIDGE_STATION=host:port          the serial line of a chain started for a stepped station: the
//                                                 arm ages one control period before each read of the positions
//                                                 and at no other time. (Its own variable: the tests of
//                                                 sim-bridge.test.ts need the chain on another clock, and two
//                                                 files cannot share one line.)
//   PEAR_JS_SIM_BRIDGE_STATION_CONTROL=host:port  its controls (default: the same host, the next port)
//   PEAR_JS_STATION_SESSIONS=name;name            the sessions to run, by their names in station_session.json, or
//                                                 "all" (default: the shortest, "a short session from the rest pose")
//   PEAR_JS_STATION_REFERENCE=file                the reference's result that holds these sessions (default: the
//                                                 committed station_sample.result.json, which holds the shortest)
//   PEAR_JS_STATION_KINEMATICS=file               PEAR's kinematics' answers (default: station_kinematics.json)
//   PEAR_JS_STATION_LIBM=directory                the directory of libm.json (default: this one)
//   PEAR_JS_STATION_OUT=directory                 where each run's result and comparison are written
//
// The sessions are run twice, each time from a reset arm:
//
// 1. With pear.js's own kinematics and the engine's own functions. They answer in other last bits than PEAR's
//    solver (lerobot's, on placo) and the C library the reference's trajectory generator is linked with, so the
//    planned targets differ in their last bits, and rarely a goal by one encoder count. What must be the same is
//    what does not depend on those bits: what every step returns or raises, the reports, the turns' texts, the
//    model's state, the ticks, the waits, the loop's states, the clock, the log, and the instruction packets in
//    their order but for the value of a goal.
// 2. With PEAR's answers in the place of the kinematics' (station_kinematics.json: what SO101Kinematics.joint_target
//    was asked and answered in a run of the reference, {session: [{joints, delta, ok or error}]}) and the
//    reference C library's values in the place of the engine's (libm.json, tests/ruckig/oracle.ts). Then nothing
//    may differ: every packet of both directions and every value of every step, each number in every bit.

const address = bridgeAddress({
  PEAR_JS_SIM_BRIDGE: process.env.PEAR_JS_SIM_BRIDGE_STATION,
  PEAR_JS_SIM_BRIDGE_CONTROL: process.env.PEAR_JS_SIM_BRIDGE_STATION_CONTROL,
});
const SHORTEST = "a short session from the rest pose";
const asked = process.env.PEAR_JS_STATION_SESSIONS || SHORTEST;
const here = (name: string): string => fileURLToPath(new URL(name, import.meta.url));
const referenceFile = process.env.PEAR_JS_STATION_REFERENCE || here("./station_sample.result.json");
const kinematicsFile = process.env.PEAR_JS_STATION_KINEMATICS || here("./station_kinematics.json");
const libmDirectory = process.env.PEAR_JS_STATION_LIBM || here(".");
const outDirectory = process.env.PEAR_JS_STATION_OUT;

function keep(name: string, text: string): void {
  if (outDirectory === undefined || outDirectory === "") return;
  mkdirSync(outDirectory, { recursive: true });
  writeFileSync(join(outDirectory, name), text);
}

/** The start of a sync write of Goal_Position, as hex: the header, the broadcast id, any length, the instruction,
 * the register's address and its length. */
const GOAL_WRITE = /^fffffe..832a02/;

/** Returns the instruction packets of ``candidate`` that differ from the reference's at the same place of the same
 * step otherwise than in the goals of a sync write of Goal_Position: another packet, another length, one missing. */
function otherThanGoals(reference: StationRunResult, candidate: StationRunResult): string[] {
  const found: string[] = [];
  reference.sessions.forEach((session, sessionIndex) => {
    session.steps.forEach((step, stepIndex) => {
      const host = (packets: typeof step.packets): string[] => (packets ?? []).filter(([direction]) => direction === "h").map(([, hex]) => hex);
      const expected = host(step.packets);
      const got = host(candidate.sessions[sessionIndex]?.steps[stepIndex]?.packets);
      for (let index = 0; index < Math.max(expected.length, got.length); index++) {
        const [ours, theirs] = [expected[index], got[index]];
        if (ours === theirs) continue;
        const isGoalAlone =
          ours !== undefined && theirs !== undefined && ours.length === theirs.length && GOAL_WRITE.test(ours) && ours.slice(0, 14) === theirs.slice(0, 14);
        if (!isGoalAlone) {
          found.push(`${session.name} / ${step.id} ${step.op} #${index}: ${ours ?? "(none)"} against ${theirs ?? "(none)"}`);
        }
      }
    });
  });

  return found;
}

/** The parts of a step that do not depend on the last bits of a planned target. */
const WHATEVER_THE_PLANNER = ["outcome", "raised", "feedback", "text", "state", "ticks", "sleeps", "phases", "clock_s", "log", "other"] as const;

describe.skipIf(address === null)("pear.js's station on a simulated SO-101 servo chain, beside PEAR's", () => {
  const { host, port, control: controlAddress } = address ?? { host: "", port: 0, control: "" };

  /** Runs the sessions and compares the run with the reference's; ``isExact``: with PEAR's kinematics' answers
   * and the reference C library's values. */
  async function runAndCompare(isExact: boolean): Promise<{
    comparison: StationComparison;
    reference: StationRunResult;
    result: StationRunResult;
    runner: StationRunner;
    oracle: Oracle | null;
    kinematics: Record<string, KinematicsAnswer[]> | undefined;
  }> {
    const sessions = loadStationSessions();
    const every = sessions.document.sessions.map((session) => session.name);
    const names = asked === "all" ? every : asked.split(";").filter((name) => name !== "");
    const ordered = every.filter((name) => names.includes(name));
    expect(ordered).toHaveLength(names.length); // every name is a session's

    const kinematics = isExact ? (JSON.parse(readFileSync(kinematicsFile, "utf8")) as Record<string, KinematicsAnswer[]>) : undefined;
    const oracle = isExact ? installOracle(libmDirectory) : null;
    const runner = new StationRunner({ host, port, control: new BridgeControl(controlAddress), sessions, only: ordered, kinematics });
    let result: StationRunResult;
    try {
      result = await runner.run();
    } finally {
      oracle?.close();
    }
    const tag = isExact ? "exact" : "own";
    keep(`${tag}.result.json`, stationJson(result));
    keep(`${tag}.kinematics.json`, stationJson(runner.asked));

    // the reference's result of the same sessions, in the script's order
    const stored = JSON.parse(readFileSync(referenceFile, "utf8")) as StationRunResult;
    const reference: StationRunResult = {
      ...stored,
      sessions: ordered.map((name) => {
        const session = stored.sessions.find((each) => each.name === name);
        if (session === undefined) throw new Error(`${referenceFile} holds no session '${name}'`);
        return session;
      }),
    };
    const comparison = compareStationResults(reference, result);
    const lines = [
      `reference: ${reference.side}; candidate: ${result.side}; kinematics: ${isExact ? "PEAR's answers" : "pear.js's own"}; ` +
        `C library: ${oracle === null ? "the engine's" : `the reference's table (${oracle.hits()} values taken, ${oracle.missing()} not in it)`}`,
      ...describeStationComparison(comparison),
      `measured positions of the actions: ${JSON.stringify(measuredPositionGap(reference, result))}`,
      ...runner.askedOtherwise.map((line) => `kinematics asked otherwise: ${line}`),
    ];
    keep(`${tag}.comparison.txt`, `${lines.join("\n")}\n`);
    console.log(lines.slice(0, 40).join("\n"));

    // every session ran all its steps, the chain answered every packet, and the robot was closed by the script
    expect(result.sessions.map((session) => session.name)).toEqual(ordered);
    result.sessions.forEach((session, index) => {
      expect(session.steps).toHaveLength(reference.sessions[index].steps.length);
      expect(session.line.unanswered).toEqual({});
      expect(session.line.corrupt_packets).toBe(0);
      expect(session.line.dropped_bytes).toBe(0);
      expect(session.note).toBeUndefined();
    });
    // the same script, the same settings, the same clock of the chain, the same calibration, the same counters
    expect(comparison.top).toEqual([]);
    expect(comparison.steps.compared).toBeGreaterThan(0);
    expect(comparison.hostPackets.reference).toBeGreaterThan(0);

    return { comparison, reference, result, runner, oracle, kinematics };
  }

  test("with its own kinematics and the engine's functions, every step ends as PEAR's and the model reads the same", async () => {
    const { comparison, reference, result } = await runAndCompare(false);

    for (const part of WHATEVER_THE_PLANNER) {
      expect(comparison.parts[part].listed, part).toEqual([]);
    }
    // the same instruction packets in the same order, the value of a goal apart; as many answers
    expect(comparison.hostPackets.candidate).toBe(comparison.hostPackets.reference);
    expect(otherThanGoals(reference, result)).toEqual([]);
    expect(comparison.servoPackets.candidate).toBe(comparison.servoPackets.reference);
  }, 600_000);

  test("with PEAR's kinematics' answers and the reference C library's values, nothing differs", async () => {
    const { comparison, runner, oracle, kinematics } = await runAndCompare(true);

    expect(runner.askedOtherwise).toEqual([]); // the planner asked what PEAR's asked, in every bit
    for (const [name, questions] of Object.entries(runner.asked)) {
      expect(questions.length, name).toBe(kinematics?.[name]?.length); // and as often
    }
    expect(oracle?.missing()).toBe(0); // every value the generator took was the reference's
    expect(comparison.hostPackets.candidate).toBe(comparison.hostPackets.reference);
    expect(comparison.hostPackets.differing).toBe(0);
    expect(comparison.servoPackets.candidate).toBe(comparison.servoPackets.reference);
    expect(comparison.servoPackets.differing).toBe(0);
    expect(comparison.steps.differing).toBe(0);
    expect(comparison.total).toBe(0);
  }, 600_000);
});
