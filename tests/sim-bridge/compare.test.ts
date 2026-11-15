import { describe, expect, test } from "vitest";

import { FeetechCommError, FeetechStatusError } from "../../src/feetech/bus";
import { RuntimeError, ValueError } from "../../src/python/errors";
import { ServoFault } from "../../src/so101/hardware/arm_state";
import { compareResults, describeComparison } from "./compare";
import type { RunResult } from "./session";

// The comparison must be able to fail: these tests give it two results that are the same, then change one thing
// in a copy and require the change to be found, counted and located. They need no servo chain.

const COUNT_RAD = (2 * Math.PI) / 4096;

function sample(): RunResult {
  return {
    format: "pear.js-sim-bridge-result/1",
    side: "pear-python",
    implementation: {},
    port_name: "serial-A",
    bridge: { clock: "packets", steps_per_packet: 2, timestep_s: 0.005 },
    session_sha256: "0".repeat(64),
    arm: {
      joint_offsets: [0, 0, 0, 0, 0],
      status_poll_ticks: 10,
      state_timeout_s: 0.1,
      position_p_coefficient: 16,
      control_period_s: 0.02,
      lower_bounds: [-1, -1, -1, -1, -1, 0],
      upper_bounds: [1, 1, 1, 1, 1, 1],
    },
    calibration: { gripper: { id: 6, drive_mode: 0, homing_offset: 0, range_min: 2000, range_max: 3000 } },
    sessions: [
      {
        name: "a session",
        steps: [
          { op: "mark", label: "start-up", ms: 1 },
          {
            op: "open",
            ms: 1,
            error: { type: "ConnectionError", message: "\nCould not connect on port 'serial-A'." },
            warnings: ["Enable attempt 1 failed, retrying: nothing on 'serial-A'"],
          },
          {
            op: "read",
            ms: 1,
            result: {
              position: [0.1, -0.2, 0.3, -0.4, 0.5, 0.25],
              velocity: [0, 0, 0, 0, 0, 0],
              sample_id: 1,
              servo_status: { torque: { gripper: 1 }, status: { gripper: 0 } },
            },
          },
          {
            op: "cycle",
            ms: 1,
            result: {
              position: [0, 0, 0, 0, 0, 0],
              velocity: [0, 0, 0, 0, 0, 0],
              sample_id: 2,
              servo_status: { torque: {}, status: {} },
            },
          },
          { op: "read", ms: 1, error: { type: "ServoFault", message: "Servo error: elbow_flex: overload" } },
          {
            op: "close",
            ms: 1,
            error: {
              type: "RuntimeError",
              message: "Failed to write 'Torque_Enable' on id_=3 with '0' after 6 tries. [RxPacketError] Overload error!",
            },
          },
        ],
        traffic: [
          { label: "", packets: [] },
          {
            label: "start-up",
            packets: [
              ["h", "ffff010201fb"],
              ["s", "ffff010200fc"],
              ["h", "fffffe048238020102"],
              ["s", "ffff01040008000f2"],
            ],
          },
        ],
      },
    ],
  };
}

/** The same run as pear.js reports it: its own name for the line; its errors carry the names of Python's
 * classes. */
function candidate(): RunResult {
  const result = structuredClone(sample());
  result.side = "pear.js";
  result.port_name = "tcp://127.0.0.1:1";
  const steps = result.sessions[0].steps;
  steps[1].error = { type: "ConnectionError", message: "\nCould not connect on port 'tcp://127.0.0.1:1'." };
  steps[1].warnings = ["Enable attempt 1 failed, retrying: nothing on 'tcp://127.0.0.1:1'"];
  steps[5].error = { type: "RuntimeError", message: steps[5].error?.message ?? "" };

  return result;
}

describe("the comparison of two runs", () => {
  test("finds nothing between a run and the same run in pear.js's names", () => {
    const comparison = compareResults(sample(), candidate());

    expect(comparison.steps).toEqual({ compared: 6, differing: [] });
    expect(comparison.hostPackets).toEqual({ reference: 2, candidate: 2, differing: 0, listed: [] });
    expect(comparison.servoPackets).toEqual({ reference: 2, candidate: 2, differing: 0, listed: [] });
    expect(comparison.readingsBetween).toEqual({ compared: 1, identical: 1, maxCounts: 0, statusDiffering: 0 });
    expect(comparison.readingsCommanded).toEqual({ compared: 1, identical: 1, maxCounts: 0, statusDiffering: 0 });
    // the class names are Python's on both sides, and are compared as they are
    expect(comparison.refusals).toEqual({ compared: 3, sameMessage: 3, sameType: 3, sameMappedType: 3, differing: [] });
    expect(comparison.warnings).toEqual({ reference: 1, candidate: 1, differing: [] });
  });

  test("finds one changed byte of one packet, and says where", () => {
    const changed = candidate();
    changed.sessions[0].traffic[1].packets[2][1] = "fffffe048238020103";
    const comparison = compareResults(sample(), changed);

    expect(comparison.hostPackets.differing).toBe(1);
    expect(comparison.hostPackets.listed).toEqual([
      { session: "a session", segment: "1: start-up", index: 1, reference: "fffffe048238020102", candidate: "fffffe048238020103" },
    ]);
    expect(comparison.servoPackets.differing).toBe(0);
    expect(describeComparison(comparison).join("\n")).toContain("host to servo packets: reference 2, candidate 2, differing 1");
  });

  test("finds a packet too many, a packet missing and a packet out of order", () => {
    const more = candidate();
    more.sessions[0].traffic[1].packets.push(["h", "ffff020201fa"]);
    expect(compareResults(sample(), more).hostPackets).toMatchObject({ reference: 2, candidate: 3, differing: 1 });

    const fewer = candidate();
    fewer.sessions[0].traffic[1].packets.splice(2, 1);
    expect(compareResults(sample(), fewer).hostPackets).toMatchObject({ reference: 2, candidate: 1, differing: 1 });

    const swapped = candidate();
    const packets = swapped.sessions[0].traffic[1].packets;
    [packets[0], packets[2]] = [packets[2], packets[0]];
    expect(compareResults(sample(), swapped).hostPackets.differing).toBe(2);
  });

  test("finds a status packet that differs", () => {
    const changed = candidate();
    changed.sessions[0].traffic[1].packets[3][1] = "ffff01040009000f1";
    expect(compareResults(sample(), changed).servoPackets.differing).toBe(1);
  });

  test("measures a reading that differs in encoder counts, joints and gripper", () => {
    const changed = candidate();
    const position = changed.sessions[0].steps[2].result?.position ?? [];
    position[1] += 2 * COUNT_RAD;
    let comparison = compareResults(sample(), changed);
    expect(comparison.readingsBetween.identical).toBe(0);
    expect(comparison.readingsBetween.maxCounts).toBeCloseTo(2, 9);

    position[1] -= 2 * COUNT_RAD;
    position[5] += 0.003; // 3 of the gripper's 1000 counts
    comparison = compareResults(sample(), changed);
    expect(comparison.readingsBetween.maxCounts).toBeCloseTo(3, 9);
    expect(comparison.readingsCommanded.maxCounts).toBe(0);
  });

  test("finds a sample id or a servo status that differs", () => {
    const changed = candidate();
    const result = changed.sessions[0].steps[2].result;
    if (result != null) result.servo_status.status.gripper = 0x20;
    expect(compareResults(sample(), changed).readingsBetween).toMatchObject({ identical: 0, statusDiffering: 1, maxCounts: 0 });
  });

  test("finds a refusal with another message or another class, and a missing one", () => {
    const worded = candidate();
    worded.sessions[0].steps[4].error = { type: "ServoFault", message: "Servo error: elbow_flex: overheat" };
    expect(compareResults(sample(), worded).refusals).toMatchObject({ compared: 3, sameMessage: 2, sameMappedType: 3 });

    const classed = candidate();
    classed.sessions[0].steps[4].error = { type: "Error", message: "Servo error: elbow_flex: overload" };
    const refusals = compareResults(sample(), classed).refusals;
    expect(refusals).toMatchObject({ compared: 3, sameMessage: 3, sameType: 2, sameMappedType: 2 });
    expect(refusals.differing).toEqual(["a session, step 4 (read): class ServoFault against Error"]);

    const silent = candidate();
    delete silent.sessions[0].steps[4].error;
    const comparison = compareResults(sample(), silent);
    expect(comparison.refusals.compared).toBe(2);
    expect(comparison.steps.differing).toEqual(["a session, step 4 (read): read||||threw against read||||returned"]);
  });

  test("finds a warning that differs and a step that was skipped on one side", () => {
    const changed = candidate();
    changed.sessions[0].steps[1].warnings = [];
    changed.sessions[0].steps[3] = { op: "cycle", ms: 1, skipped: "the arm is not open" };
    const comparison = compareResults(sample(), changed);

    expect(comparison.warnings).toMatchObject({ reference: 1, candidate: 0 });
    expect(comparison.warnings.differing).toHaveLength(1);
    expect(comparison.steps.differing).toHaveLength(2); // the kind of outcome, and a reading on one side only
  });

  test("takes a class for the same only under Python's name, which each error of the hardware layer carries", () => {
    // what the hardware layer throws for each Python exception of the reference, by the name it reports
    expect(new FeetechCommError("x").name).toBe("ConnectionError");
    expect(new FeetechStatusError("x [RxPacketError] Overload error!", 0x20).name).toBe("RuntimeError");
    expect(new RuntimeError("Servo calibration registers differ").name).toBe("RuntimeError");
    expect(new ServoFault("x").name).toBe("ServoFault");
    expect(new ValueError("x").name).toBe("ValueError");

    // the names pear.js's classes had before they carried Python's: each is a difference now, found and named
    const former: Array<[string, string, string]> = [
      ["ConnectionError", "x", "FeetechCommError"],
      ["RuntimeError", "x [RxPacketError] Overload error!", "FeetechStatusError"],
      ["RuntimeError", "Servo calibration registers differ", "Error"],
      ["ServoFault", "x", "Error"],
      ["ValueError", "x", "RangeError"],
    ];
    for (const [pythonName, message, formerName] of former) {
      const reference = sample();
      reference.sessions[0].steps[4].error = { type: pythonName, message };

      const same = candidate();
      same.sessions[0].steps[4].error = { type: pythonName, message };
      expect(compareResults(reference, same).refusals).toEqual({
        compared: 3,
        sameMessage: 3,
        sameType: 3,
        sameMappedType: 3,
        differing: [],
      });

      const renamed = candidate();
      renamed.sessions[0].steps[4].error = { type: formerName, message };
      expect(compareResults(reference, renamed).refusals).toEqual({
        compared: 3,
        sameMessage: 3,
        sameType: 2,
        sameMappedType: 2,
        differing: [`a session, step 4 (read): class ${pythonName} against ${formerName}`],
      });
    }
  });
});
