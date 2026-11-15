import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { compareStationResults, describeStationComparison, measuredPositionGap } from "./compare_station";
import {
  STATION_RESULT_FORMAT,
  STATION_SESSION_FORMAT,
  type ExecutedRecord,
  type Json,
  type StationRunResult,
  type StationSessionDocument,
  type StationStepRecord,
  type TurnRecord,
} from "./station_result";

// The comparison of two station runs must be able to fail. These tests take a real reference result (the short
// session of station_session.json, run by PEAR's own Python robot on a simulated servo chain, kept beside the
// tests), change one thing at a time in a copy and require the change to be found, counted and named. They need
// no servo chain.

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_FILE = join(HERE, "station_sample.result.json");
const SESSION_FILE = join(HERE, "station_session.json");

function sample(): StationRunResult {
  return JSON.parse(readFileSync(SAMPLE_FILE, "utf8")) as StationRunResult;
}

/** The same run as another runner would write it: its own name, its own versions and wall times. */
function candidate(): StationRunResult {
  const result = sample();
  result.side = "pear.js";
  result.run = { implementation: { node: "v0" }, wall_s: 1 };
  for (const session of result.sessions) {
    session.wall_s = 123;
    for (const step of session.steps) if (step.wall_ms !== undefined) step.wall_ms += 5;
  }

  return result;
}

/** The first step with the op ``op`` in the result's one session. */
function stepOf(result: StationRunResult, op: string): StationStepRecord {
  const step = result.sessions[0].steps.find((each) => each.op === op);
  if (step === undefined) throw new Error(`the sample has no ${op} step`);

  return step;
}

function executed(result: StationRunResult): ExecutedRecord {
  return stepOf(result, "execute").returned as ExecutedRecord;
}

/** The double next to ``value``: one unit in its last place. */
function nextDouble(value: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) + 1n);

  return view.getFloat64(0);
}

describe("the reference result kept beside the tests", () => {
  test("is a stepped run of the short session of station_session.json as it is now", () => {
    const result = sample();
    const bytes = readFileSync(SESSION_FILE);
    const document = JSON.parse(bytes.toString("utf8")) as StationSessionDocument;

    expect(result.format).toBe(STATION_RESULT_FORMAT);
    expect(document.format).toBe(STATION_SESSION_FORMAT);
    expect(result.side).toBe("pear-python");
    expect(result.clock).toBe("stepped");
    expect(result.bridge).toEqual({ clock: "packets", steps_per_packet: 0, steps_per_position_read: 4, timestep_s: 0.005 });
    // made again whenever make_station_session.py changes the sessions
    expect(result.session_sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.station).toEqual(document.station);

    expect(result.sessions).toHaveLength(1);
    const script = document.sessions.find((session) => session.name === result.sessions[0].name);
    expect(script).toBeDefined();
    expect(result.sessions[0].steps.map((step) => `${step.id} ${step.op}`)).toEqual(
      script?.steps.map((step) => `${step.id} ${step.op}`),
    );
  });

  test("holds what a step of each kind returns, and no path of a machine", () => {
    const result = sample();
    const action = executed(result);
    expect(action.result.status).toBe("completed");
    expect(action.result.measured_position).toHaveLength(6);
    expect(action.feedback).toBe(
      '{"status": "completed", "execution_requested": true, "settled": true, "reached": true} Use the new measured observation.',
    );
    expect(action.progress).toEqual(["Planning", "Executing"]);

    const turn = stepOf(result, "model_state").returned as TurnRecord;
    expect(turn.text.startsWith(`{"arm": {"x": ${turn.state.arm.x}, `)).toBe(true);
    expect(turn.text).toContain("End your response with one json block containing the next action.");

    const move = stepOf(result, "execute");
    expect(move.ticks).toBeGreaterThan(0);
    expect(move.sleeps).toBe(move.ticks);
    expect((move.phases ?? []).reduce((sum, [, count]) => sum + count, 0)).toBe(move.ticks);
    // every step of the loop reads the positions once: one sync read of Present_Position a tick
    const reads = (move.packets ?? []).filter(([direction, hex]) => direction === "h" && hex.slice(8, 14) === "823802");
    expect(reads).toHaveLength(move.ticks ?? -1);
    // a start-up waits for the arm to settle before there is a loop to step
    const start = stepOf(result, "open");
    expect(start.ticks).toBe(0);
    expect(start.sleeps).toBeGreaterThan(0);

    expect(readFileSync(SAMPLE_FILE, "utf8")).not.toMatch(/\/(tmp|mnt|opt|home|Users)\/|[A-Za-z]:\\\\/);
  });
});

describe("the comparison of two station runs", () => {
  test("finds nothing between a run and the same run written by another runner", () => {
    const comparison = compareStationResults(sample(), candidate());

    expect(comparison.total).toBe(0);
    expect(comparison.top).toEqual([]);
    expect(comparison.steps.compared).toBe(sample().sessions[0].steps.length);
    expect(comparison.steps.differing).toBe(0);
    expect(comparison.hostPackets.differing).toBe(0);
    expect(comparison.servoPackets.differing).toBe(0);
    expect(comparison.hostPackets.reference).toBe(comparison.hostPackets.candidate);
    expect(comparison.hostPackets.reference).toBeGreaterThan(100);
    expect(comparison.servoPackets.reference).toBeGreaterThan(comparison.hostPackets.reference);
    expect(measuredPositionGap(sample(), candidate())).toEqual({ compared: 1, identical: 1, maxJointRad: 0, maxOpening: 0 });
  });

  test("finds a result's status that differs", () => {
    const changed = candidate();
    executed(changed).result.status = "failed";
    const comparison = compareStationResults(sample(), changed);

    expect(comparison.total).toBe(1);
    expect(comparison.parts.result).toMatchObject({ steps: 1, differences: 1 });
    expect(comparison.parts.result.listed[0]).toContain('010 execute: returned.result.status: "completed" against "failed"');
    expect(comparison.steps.differing).toBe(1);
  });

  test("finds a number of the measured position that differs in its last digit", () => {
    const changed = candidate();
    const position = executed(changed).result.measured_position ?? [];
    const before = position[2];
    position[2] = nextDouble(before);
    let comparison = compareStationResults(sample(), changed);

    expect(position[2]).not.toBe(before);
    expect(Math.abs(position[2] - before)).toBeLessThan(1e-15);
    expect(comparison.total).toBe(1);
    expect(comparison.parts.result).toMatchObject({ steps: 1, differences: 1 });
    expect(comparison.parts.result.listed[0]).toContain("returned.result.measured_position[2]");
    const gap = measuredPositionGap(sample(), changed);
    expect(gap).toMatchObject({ compared: 1, identical: 0, maxOpening: 0 });
    expect(gap.maxJointRad).toBeGreaterThan(0);
    expect(gap.maxJointRad).toBeLessThan(1e-15);

    // the last digit as the number is printed, and a zero that is the other zero
    position[2] = Number(String(before).replace(/\d$/, (digit) => String((Number(digit) + 1) % 10)));
    comparison = compareStationResults(sample(), changed);
    expect(comparison.parts.result.differences).toBe(1);
    position[2] = before;
    const error = executed(changed).result.tracking_error ?? [];
    error[5] = -0;
    const reference = sample();
    (executed(reference).result.tracking_error ?? [])[5] = 0;
    expect(compareStationResults(reference, changed).parts.result.differences).toBe(1);
  });

  test("finds a report text and a turn's text that differ", () => {
    const changed = candidate();
    executed(changed).feedback = executed(changed).feedback.replace('"reached": true', '"reached": false');
    let comparison = compareStationResults(sample(), changed);
    expect(comparison.total).toBe(1);
    expect(comparison.parts.feedback).toMatchObject({ steps: 1, differences: 1 });

    const worded = candidate();
    const turn = stepOf(worded, "model_state").returned as TurnRecord;
    turn.text = turn.text.replace("frame follows", "frames follow");
    turn.state.arm.z += 0.1;
    comparison = compareStationResults(sample(), worded);
    expect(comparison.parts.text).toMatchObject({ steps: 1, differences: 1 });
    expect(comparison.parts.state).toMatchObject({ steps: 1, differences: 1 });
    expect(comparison.total).toBe(2);
  });

  test("finds a field of a control snapshot that differs, and one that is missing", () => {
    const changed = candidate();
    const status = stepOf(changed, "execute").status as { arrival: { settled: boolean }; generation: number };
    status.arrival.settled = !status.arrival.settled;
    status.generation += 1;
    let comparison = compareStationResults(sample(), changed);
    expect(comparison.total).toBe(2);
    expect(comparison.parts.status).toMatchObject({ steps: 1, differences: 2 });
    expect(comparison.parts.status.listed.join("\n")).toContain("status.arrival.settled: true against false");

    const missing = candidate();
    delete (stepOf(missing, "wait_stationary").returned as Record<string, Json>).settling;
    delete stepOf(missing, "execute").requested;
    comparison = compareStationResults(sample(), missing);
    expect(comparison.parts.returned).toMatchObject({ steps: 1, differences: 1 });
    expect(comparison.parts.requested).toMatchObject({ steps: 1, differences: 1 });
    expect(comparison.parts.returned.listed[0]).toContain("(absent)");
  });

  test("finds a tick count, a state of the loop and a reading of the clock that differ", () => {
    const changed = candidate();
    const move = stepOf(changed, "execute");
    move.ticks = (move.ticks ?? 0) + 1;
    let comparison = compareStationResults(sample(), changed);
    expect(comparison.total).toBe(1);
    expect(comparison.parts.ticks).toMatchObject({ steps: 1, differences: 1 });

    const phased = candidate();
    const phases = stepOf(phased, "execute").phases ?? [];
    phases[0][1] -= 1;
    phases[1][1] += 1;
    (stepOf(phased, "hold").clock_s ?? [0, 0])[1] += 0.02;
    comparison = compareStationResults(sample(), phased);
    expect(comparison.parts.phases).toMatchObject({ steps: 1, differences: 2 });
    expect(comparison.parts.clock_s).toMatchObject({ steps: 1, differences: 1 });
  });

  test("finds one changed packet, a packet too many, a packet missing and two exchanged", () => {
    const hostIndexes = (step: StationStepRecord): number[] =>
      (step.packets ?? []).flatMap(([direction], index) => (direction === "h" ? [index] : []));

    const changed = candidate();
    const packets = stepOf(changed, "execute").packets ?? [];
    const at = hostIndexes(stepOf(changed, "execute"))[7];
    const before = packets[at][1];
    packets[at][1] = before.slice(0, -4) + (before.at(-4) === "0" ? "1" : "0") + before.slice(-3);
    let comparison = compareStationResults(sample(), changed);
    expect(comparison.hostPackets.differing).toBe(1);
    expect(comparison.servoPackets.differing).toBe(0);
    expect(comparison.total).toBe(1);
    expect(comparison.parts.hostPackets.listed[0]).toContain(`010 execute: #7: ${before} against ${packets[at][1]}`);
    expect(describeStationComparison(comparison).join("\n")).toMatch(/host to servo packets: reference (\d+), candidate \1, differing 1/);

    const more = candidate();
    (stepOf(more, "hold").packets ?? []).push(["h", "ffff010201fb"]);
    comparison = compareStationResults(sample(), more);
    expect(comparison.hostPackets.candidate).toBe(comparison.hostPackets.reference + 1);
    expect(comparison.hostPackets.differing).toBe(1);

    const fewer = candidate();
    const held = stepOf(fewer, "hold").packets ?? [];
    held.splice(hostIndexes(stepOf(fewer, "hold"))[0], 1);
    comparison = compareStationResults(sample(), fewer);
    expect(comparison.hostPackets.candidate).toBe(comparison.hostPackets.reference - 1);
    expect(comparison.hostPackets.differing).toBeGreaterThanOrEqual(1);

    const swapped = candidate();
    const moved = stepOf(swapped, "execute").packets ?? [];
    const [first, second] = hostIndexes(stepOf(swapped, "execute"));
    [moved[first], moved[second]] = [moved[second], moved[first]];
    expect(compareStationResults(sample(), swapped).hostPackets.differing).toBe(2);

    const answered = candidate();
    const servo = (stepOf(answered, "execute").packets ?? []).find(([direction]) => direction === "s");
    if (servo !== undefined) servo[1] = servo[1].slice(0, -1) + (servo[1].endsWith("0") ? "1" : "0");
    comparison = compareStationResults(sample(), answered);
    expect(comparison.servoPackets.differing).toBe(1);
    expect(comparison.hostPackets.differing).toBe(0);
  });

  test("finds a step that raised on one side, another class and another message", () => {
    const changed = candidate();
    const step = stepOf(changed, "execute");
    delete step.returned;
    step.raised = { type: "RuntimeError", message: "Station fault: FAULT: Servo error: elbow_flex: overload" };
    let comparison = compareStationResults(sample(), changed);
    expect(comparison.parts.outcome).toMatchObject({ steps: 1, differences: 1 });
    expect(comparison.parts.outcome.listed[0]).toContain("returned against raised");
    expect(comparison.parts.raised.differences).toBe(1);
    expect(comparison.parts.returned.differences).toBe(1);

    const reference = sample();
    stepOf(reference, "execute").raised = { type: "ServoFault", message: "Servo error: elbow_flex: overload" };
    delete stepOf(reference, "execute").returned;
    comparison = compareStationResults(reference, changed);
    expect(comparison.parts.outcome.differences).toBe(0);
    expect(comparison.parts.raised).toMatchObject({ steps: 1, differences: 2 }); // the class and the message
  });

  test("finds a warning, the world's state and the line's counters that differ", () => {
    const changed = candidate();
    (stepOf(changed, "execute").log ?? []).push(["WARNING", "a.logger", "feedback read failed: nothing answered"]);
    const world = stepOf(changed, "execute").world;
    if (world !== undefined) world.time_s += 0.005;
    changed.sessions[0].line.instructions.SYNC_WRITE += 1;
    const comparison = compareStationResults(sample(), changed);

    expect(comparison.parts.log).toMatchObject({ steps: 1, differences: 1 });
    expect(comparison.parts.world).toMatchObject({ steps: 1, differences: 1 });
    expect(comparison.top).toHaveLength(1);
    expect(comparison.top[0]).toContain("line.instructions.SYNC_WRITE");
    expect(comparison.total).toBe(3);
  });

  test("compares what two runs must share, and never what belongs to one run", () => {
    const changed = candidate();
    changed.station.control.settle_window_s = 0.4;
    changed.session_sha256 = "0".repeat(64);
    changed.clock = "realtime";
    let comparison = compareStationResults(sample(), changed);
    expect(comparison.top).toHaveLength(3);
    expect(comparison.total).toBe(3);
    expect(comparison.steps.differing).toBe(0);

    const shorter = candidate();
    shorter.sessions[0].steps.pop();
    comparison = compareStationResults(sample(), shorter);
    expect(comparison.top.join("\n")).toMatch(/\d+ steps against \d+/);

    const renamed = candidate();
    renamed.sessions[0].name = "another session";
    expect(compareStationResults(sample(), renamed).top).toHaveLength(1);
    expect(compareStationResults(sample(), { ...candidate(), sessions: [] }).top).toEqual(["1 sessions against 0"]);
  });
});
