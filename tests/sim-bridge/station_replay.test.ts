import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { installOracle } from "../ruckig/oracle";
import { compareStationResults, STATION_PARTS, type StationComparison, type StationPart } from "./compare_station";
import { differInGoalsAlone, loadStationReference, ReplayedChain, ReplayError, STATION_REFERENCE_SHA256 } from "./replayed_chain";
import type { Packet, StationRunResult, StationStepRecord } from "./station_result";
import { loadStationSessions, stationJson, StationRunner, type KinematicsAnswer } from "./station_runner";

// pear.js's whole station (SO101Robot on its real driver, the Feetech bus) run through the 8 scripted sessions on
// the line of PEAR's own run, replayed (replayed_chain.ts): for each instruction packet pear.js sends, the line
// requires that it is the next one PEAR's Python station sent on the simulated servo chain and hands back what
// PEAR's servos answered then. It needs no chain, so it runs wherever the tests run. station_chain.test.ts is the
// same run on the chain itself, where a chain is.
//
// What a replayed run can show. The servo side is PEAR's recording, so in the run's result these are copies of the
// reference's and are compared for nothing:
//   the status packets, the simulated world of each step, the line's counters of each session, the chain's clock,
//   the calibration
// These are pear.js's own, and each is compared with PEAR's in every bit:
//   the instruction packets, in their order (the line refuses the first that is not PEAR's)
//   of each step: whether it returned or raised and what it raised, an action's result, the report, the turn's
//   text, the model's state, whatever else it returned, the robot's status with its control snapshot, the joint
//   vector the arm heads for, the ticks, the waits, the loop's states, the clock, the log
// (A step's id, op, turn and about are the script's words, which both runners copy.)
// A replay cannot go on where pear.js would send something else than PEAR: nothing here answers such a packet.

const here = (name: string): string => fileURLToPath(new URL(name, import.meta.url));
const SHORTEST = "a short session from the rest pose";

/** The parts of a step that are a copy of the reference's in a replayed run. */
const COPIED: readonly StationPart[] = ["world", "servoPackets"];
/** The parts that are pear.js's own. */
const OWN: readonly StationPart[] = STATION_PARTS.filter((part) => !COPIED.includes(part));
/** Of those, the parts that do not depend on the last bits of a planned target (as in station_chain.test.ts). */
const WHATEVER_THE_PLANNER = ["outcome", "raised", "feedback", "text", "state", "ticks", "sleeps", "phases", "clock_s", "log", "other"] as const;

const stored = loadStationReference();
const reference = stored.result;
const sessions = loadStationSessions();
const kinematics = JSON.parse(readFileSync(here("./station_kinematics.json"), "utf8")) as Record<string, KinematicsAnswer[]>;

interface Replayed {
  result: StationRunResult;
  comparison: StationComparison;
  chain: ReplayedChain;
  runner: StationRunner;
  /** Of an exact run: the values taken from the C library's table, and the arguments it lacked. */
  libm: { taken: number; missing: number } | null;
}

/** Runs pear.js's station on ``recording`` replayed and compares its result with it. ``isExact``: with PEAR's
 * kinematics' answers and the reference C library's values; otherwise with pear.js's own kinematics and the
 * engine's functions, on a line that lets the goals of a goal write differ. ``libmDirectory``: where the table of
 * the C library's values is read (and where the arguments it lacks are written). */
async function replay(
  recording: StationRunResult,
  isExact: boolean,
  only: readonly string[] = [],
  libmDirectory: string = here("."),
): Promise<Replayed> {
  const chain = new ReplayedChain(recording, { goalsMayDiffer: !isExact });
  const runner = new StationRunner({
    host: "replayed",
    port: 0,
    control: chain,
    line: () => chain.connect(),
    sessions,
    only,
    kinematics: isExact ? kinematics : undefined,
  });
  const oracle = isExact ? installOracle(libmDirectory) : null;
  let result: StationRunResult;
  try {
    result = await runner.run();
  } finally {
    oracle?.close();
  }

  return {
    result,
    comparison: compareStationResults(recording, result),
    chain,
    runner,
    libm: oracle === null ? null : { taken: oracle.hits(), missing: oracle.missing() },
  };
}

/** The differences of each part that is pear.js's own. */
function ownDifferences(comparison: StationComparison): Partial<Record<StationPart, number>> {
  return Object.fromEntries(OWN.map((part) => [part, comparison.parts[part].differences]).filter(([, count]) => count !== 0));
}

function count(recording: StationRunResult, direction: "h" | "s"): number {
  let packets = 0;
  for (const session of recording.sessions) {
    for (const step of session.steps) packets += (step.packets ?? []).filter(([each]) => each === direction).length;
  }

  return packets;
}

describe("the reference's stored result", () => {
  test("is the stored content, packed with nothing of a run in its header", () => {
    expect(stored.sha256).toBe(STATION_REFERENCE_SHA256);
    // gzip, deflate, no flags (so no file name), no time, best compression, the system byte of the other fixtures
    const header = readFileSync(here("./station_reference.result.json.gz")).subarray(0, 10);
    expect([...header]).toEqual([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 3]);
    expect(JSON.stringify(reference.run)).not.toMatch(/[\\/]/); // and its run record names no file of a machine
  });

  test("holds PEAR's run of the 8 sessions of the committed script, the first of them the committed sample", () => {
    expect(reference.side).toBe("pear-python");
    expect(reference.session_sha256).toBe(sessions.sha256);
    expect(reference.sessions.map((session) => session.name)).toEqual(sessions.document.sessions.map((session) => session.name));
    expect(reference.sessions.reduce((steps, session) => steps + session.steps.length, 0)).toBe(652);
    expect(count(reference, "h")).toBe(25_502);
    expect(count(reference, "s")).toBe(87_210);

    const sample = JSON.parse(readFileSync(here("./station_sample.result.json"), "utf8")) as StationRunResult;
    expect(reference.sessions[0].name).toBe(SHORTEST);
    expect(stationJson(reference.sessions[0]) === stationJson(sample.sessions[0])).toBe(true); // every key, every bit
    for (const key of ["format", "side", "clock", "session_sha256", "station", "bridge", "calibration"] as const) {
      expect(stationJson(reference[key]), key).toBe(stationJson(sample[key]));
    }
  });
});

describe("pear.js's station on the replayed line of PEAR's run", () => {
  test("with PEAR's kinematics' answers and the reference C library's values, it sends PEAR's packets and computes PEAR's values", async () => {
    const { result, comparison, chain, runner, libm } = await replay(reference, true);

    // every instruction packet was the next one of PEAR's run, and none of PEAR's run is left
    expect(chain.instructions).toBe(25_502);
    expect(chain.otherGoals).toEqual([]);
    expect(comparison.hostPackets).toEqual({ reference: 25_502, candidate: 25_502, differing: 0 });
    // the planner asked what PEAR's was asked, in every bit and as often; every value the generator took was the
    // C library's
    expect(runner.askedOtherwise).toEqual([]);
    for (const session of reference.sessions) {
      expect(runner.asked[session.name]?.length ?? 0, session.name).toBe(kinematics[session.name]?.length ?? 0);
    }
    expect(libm?.missing).toBe(0);
    // every session ran all its steps and closed its robot, and no value that is pear.js's differs
    expect(result.sessions.every((session) => session.note === undefined)).toBe(true);
    expect(comparison.steps).toEqual({ compared: 652, differing: 0 });
    expect(ownDifferences(comparison)).toEqual({});
    // the same script and settings; and the copies are copies
    expect(comparison.top).toEqual([]);
    expect(chain.answers).toBe(87_210);
    expect(comparison.servoPackets).toEqual({ reference: 87_210, candidate: 87_210, differing: 0 });
    expect(comparison.total).toBe(0);
  });

  test("with its own kinematics and the engine's functions, every step ends as PEAR's and the model reads the same", async () => {
    const { result, comparison, chain } = await replay(reference, false);

    expect(result.sessions.map((session) => session.steps.length)).toEqual(reference.sessions.map((session) => session.steps.length));
    expect(result.sessions.every((session) => session.note === undefined)).toBe(true);
    expect(comparison.top).toEqual([]);
    for (const part of WHATEVER_THE_PLANNER) {
      expect(comparison.parts[part].listed, part).toEqual([]);
    }
    // the same instruction packets in the same order, the value of a goal apart: the line let nothing else pass
    expect(comparison.hostPackets.candidate).toBe(comparison.hostPackets.reference);
    expect(comparison.hostPackets.differing).toBe(chain.otherGoals.length);
    expect(chain.instructions).toBe(25_502);
  });
});

describe("the replayed chain by itself", () => {
  const PING = "ffff010201fb"; // of servo 1
  const ANSWER = "ffff010200fc"; // its status packet
  const GOALS = "fffffe07832a0201000842"; // a sync write of servo 1's goal
  const bytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
  const world = (time_s: number) => ({ time_s, joints_rad: {}, gripper_opening: 0 });
  /** A run of two steps: a ping and a goal write, then a ping. */
  const tiny = (): StationRunResult => ({
    ...reference,
    sessions: [
      {
        name: "tiny",
        steps: [
          { id: "000", op: "reset" },
          { id: "001", op: "open", packets: [["h", PING], ["s", ANSWER], ["h", GOALS]], world: world(1) },
          { id: "002", op: "idle", packets: [["h", PING], ["s", ANSWER]], world: world(2) },
        ],
        line: { instructions: { PING: 2, SYNC_WRITE: 1 }, unanswered: {}, corrupt_packets: 0, dropped_bytes: 0, errors: [] },
      },
    ],
  });

  test("hands back PEAR's answers, cuts the traffic by the chain's rule of a mark, and ends at what PEAR's run does not hold", async () => {
    const chain = new ReplayedChain(tiny());
    const line = await chain.connect();
    await chain.reset();
    await chain.mark("session: tiny");
    await chain.mark("001 open");
    await line.write(bytes(PING));
    expect(Buffer.from(await line.read(64, 0)).toString("hex")).toBe(ANSWER);
    expect(await line.read(64, 1)).toHaveLength(0); // nothing more comes, however long the read waits
    expect((await chain.state()).time_s).toBe(1);

    // a mark waits for the next packet that is not a sync write: the goal write sent after it is still the step's
    // before, as on the chain, where a sync write may still be on its way when the mark is made
    await chain.mark("002 idle");
    expect((await chain.state()).time_s).toBe(2); // the state is the marked step's at once
    await line.write(bytes(GOALS));
    await line.write(bytes(PING));
    expect(await chain.traffic()).toEqual([
      { label: "", packets: [] },
      { label: "session: tiny", packets: [] },
      { label: "001 open", packets: [["h", PING], ["s", ANSWER], ["h", GOALS]] },
      { label: "002 idle", packets: [["h", PING], ["s", ANSWER]] },
    ]);
    expect((await chain.state()).line.instructions).toEqual({ PING: 2, SYNC_WRITE: 1 }); // the reference's counters
    expect([chain.instructions, chain.answers]).toEqual([3, 2]);

    // a step PEAR's run does not have ends the replay, and every later call fails with the same error
    await expect(chain.mark("003 close")).rejects.toThrow("tiny: '003 close' is marked where PEAR's run has ended");
    await expect(line.write(bytes(PING))).rejects.toBeInstanceOf(ReplayError);
    await expect(line.read(64, 0)).rejects.toThrow("'003 close' is marked");
    await expect(chain.traffic()).rejects.toThrow("'003 close' is marked");
  });

  test("refuses a session, a step out of its order and a packet that PEAR's run does not hold there", async () => {
    await expect(new ReplayedChain(tiny()).mark("session: another")).rejects.toThrow("PEAR's run holds no session 'another'");

    const skipping = new ReplayedChain(tiny());
    await skipping.mark("session: tiny");
    await expect(skipping.mark("002 idle")).rejects.toThrow("tiny: '002 idle' is marked where PEAR's run goes on with '001 open'");

    const chain = new ReplayedChain(tiny());
    const line = await chain.connect();
    await chain.mark("session: tiny");
    await chain.mark("001 open");
    await line.write(bytes(PING));
    await expect(line.write(bytes(PING))).rejects.toThrow(
      `tiny / 001 open: instruction packet #1: pear.js sent ${PING} where PEAR's run sent ${GOALS}`,
    );
  });
});

// ---- the test of the test: one thing changed in a copy of the reference ----

/** A copy of the reference's shortest session alone. */
function shortest(): { recording: StationRunResult; steps: StationStepRecord[] } {
  const recording = structuredClone({ ...reference, sessions: [reference.sessions[0]] });

  return { recording, steps: recording.sessions[0].steps };
}

function stepOf(steps: StationStepRecord[], label: string): StationStepRecord & { packets: Packet[] } {
  const step = steps.find((each) => `${each.id} ${each.op}` === label);
  if (step === undefined || step.packets === undefined) throw new Error(`The session has no step '${label}' with packets`);

  return step as StationStepRecord & { packets: Packet[] };
}

/** Returns the packet ``hex`` with the lowest bit of its byte ``index`` turned, and the checksum that makes it a
 * valid packet again. */
function turned(hex: string, index: number): string {
  const bytes = Array.from({ length: hex.length / 2 }, (_, at) => Number.parseInt(hex.slice(2 * at, 2 * at + 2), 16));
  bytes[index] ^= 1;
  bytes[bytes.length - 1] = ~bytes.slice(2, -1).reduce((sum, byte) => sum + byte, 0) & 0xff;

  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The number of an instruction packet among its step's, as the line and the comparison count them. */
function instructionNumber(packets: Packet[], index: number): number {
  return packets.slice(0, index).filter(([direction]) => direction === "h").length;
}

/** Runs ``recording`` exactly, the table of the C library's values read from a copy outside the repository: a run
 * that leaves PEAR's path may ask for values the table lacks, and their list is not this repository's. */
async function replayChanged(recording: StationRunResult): Promise<Replayed | unknown> {
  const directory = mkdtempSync(join(tmpdir(), "pear-js-replay-"));
  try {
    cpSync(here("./libm.json"), join(directory, "libm.json"));
    return await replay(recording, true, [SHORTEST], directory).catch((error: unknown) => error);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const GOAL_WRITE = /^fffffe..832a02/;
const POSITION_READ = /^fffffe..823802/;

describe("the replay can fail", () => {
  test("the unchanged copy of the shortest session passes", async () => {
    const replayed = (await replayChanged(shortest().recording)) as Replayed;

    expect(replayed.comparison.total).toBe(0);
    expect(replayed.comparison.steps).toEqual({ compared: 15, differing: 0 });
    expect(replayed.chain.instructions).toBe(324);
    expect(replayed.libm?.missing).toBe(0);
  });

  test("a servo's answer that holds another position: pear.js reads it, and its values are no longer PEAR's", async () => {
    const { recording, steps } = shortest();
    // the last read of the positions while the arm holds, in the first servo's answer: one encoder count
    const { packets } = stepOf(steps, "009 hold");
    const read = packets.map(([direction, hex]) => direction === "h" && POSITION_READ.test(hex)).lastIndexOf(true);
    const answer = packets[read + 1];
    expect(answer[0]).toBe("s");
    expect(answer[1]).toMatch(/^ffff010400/); // servo 1, two bytes, no error
    answer[1] = turned(answer[1], 5);

    const replayed = (await replayChanged(recording)) as Replayed;

    // the packets pear.js sends do not depend on it, so the run goes on; the measured position at the step's end does
    expect(replayed).not.toBeInstanceOf(Error);
    expect(replayed.comparison.steps.differing).toBe(1);
    expect(Object.keys(ownDifferences(replayed.comparison))).toEqual(["status"]);
    expect(replayed.comparison.parts.status.listed[0]).toMatch(/^a short session from the rest pose \/ 009 hold: status\./);
    expect(replayed.comparison.hostPackets.differing).toBe(0);
  });

  test("an instruction packet that is not the one pear.js sends: the line refuses pear.js's and the run ends there", async () => {
    const { recording, steps } = shortest();
    const { packets } = stepOf(steps, "010 execute");
    const index = packets.findIndex(([direction, hex]) => direction === "h" && GOAL_WRITE.test(hex));
    const [sent, changed] = [packets[index][1], turned(packets[index][1], 8)]; // the first servo's goal, one count
    packets[index][1] = changed;

    const error = await replayChanged(recording);

    expect(error).toBeInstanceOf(ReplayError);
    expect((error as Error).message).toBe(
      `${SHORTEST} / 010 execute: instruction packet #${instructionNumber(packets, index)}: ` +
        `pear.js sent ${sent} where PEAR's run sent ${changed}`,
    );

    // a goal alone differs: the line of a run with pear.js's own kinematics lets it pass, and the comparison finds it
    const tolerant = await replay(recording, false, [SHORTEST]);
    expect(tolerant.chain.otherGoals).toEqual([
      `${SHORTEST} / 010 execute: instruction packet #${instructionNumber(packets, index)}: ${changed} against ${sent}`,
    ]);
    expect(tolerant.comparison.hostPackets.differing).toBe(1);
    expect(tolerant.comparison.parts.hostPackets.listed[0]).toContain("010 execute");
  });

  test("an instruction packet more in PEAR's run of a step: the next step's mark finds it", async () => {
    const { recording, steps } = shortest();
    const { packets } = stepOf(steps, "009 hold");
    const instructions = packets.filter(([direction]) => direction === "h").length;
    packets.push(["h", "ffff010201fb"]); // a ping of servo 1

    const error = await replayChanged(recording);

    expect(error).toBeInstanceOf(ReplayError);
    expect((error as Error).message).toBe(
      `${SHORTEST} / 009 hold: the step ended after ${instructions} of the ${instructions + 1} instruction packets of ` +
        "PEAR's run, which went on with ffff010201fb",
    );
  });

  test("a step's result that is not the one pear.js computes: the comparison finds it, there and nowhere else", async () => {
    const { recording, steps } = shortest();
    const record = stepOf(steps, "010 execute").returned as { result: { measured_position: number[] } };
    const measured = record.result.measured_position[1];
    record.result.measured_position[1] = measured + 2 ** -52; // one of its last bits
    expect(Object.is(record.result.measured_position[1], measured)).toBe(false);

    const replayed = (await replayChanged(recording)) as Replayed;

    expect(replayed).not.toBeInstanceOf(Error);
    expect(replayed.comparison.total).toBe(1);
    expect(ownDifferences(replayed.comparison)).toEqual({ result: 1 });
    expect(replayed.comparison.parts.result.listed[0]).toContain("010 execute: returned.result.measured_position[1]");
  });

  test("the line lets pass a goal write whose goals alone differ, and nothing else", () => {
    const goals = "fffffe0a832a0201000802ff07" + "00"; // two servos' goals; the checksum is not looked at
    expect(differInGoalsAlone(goals, "fffffe0a832a0201010802fe0700")).toBe(true); // other goals
    expect(differInGoalsAlone(goals, "fffffe0a832a0201000803ff0700")).toBe(false); // another servo
    expect(differInGoalsAlone(goals, "fffffe0a832c0201010802fe0700")).toBe(false); // another register
    expect(differInGoalsAlone(goals, "fffffe0d832a0201000802ff0703000800")).toBe(false); // one servo more
    expect(differInGoalsAlone("fffffe0a82380201020304050600", "fffffe0a82380201020304050700")).toBe(false); // a sync read
  });
});
