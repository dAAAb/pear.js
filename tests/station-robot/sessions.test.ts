// pear.js's SO-101 robot on PEAR's stepped rig, against PEAR's own on the same rig (sessions.json.gz): 66 sessions,
// every scenario of PEAR's four test files of the SO-101's robot among them. Each step is one call of the robot;
// its whole record must be PEAR's: what it returned or threw (class and message), the result's record and its
// report text, the model's state, every control period it took with what the driver was asked, the clock, the
// UUIDs, what the kinematics were asked, the log, and the status with its snapshot at the end. Every number must
// be the same double.
//
// The kinematics answer what PEAR's answered (the fixtures hold each answer), so that this is no comparison of two
// solvers; Ruckig's five inexact C library functions answer from libm.json beside the fixtures (see parts.test.ts).
// engine.test.ts runs the same sessions on pear.js's own kinematics and the engine's own functions, and measures.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { installOracle, type Oracle } from "../ruckig/oracle";
import { Comparison } from "../station-loop/compare";
import { DIRECTORY, IS_LARGER_SET, loadFixture } from "./fixtures";
import { playAndCompare, type SessionRecord } from "./rig";

const MISSING = "the port asked for arguments libm.json does not hold: add them (see tests/ruckig/oracle.ts) and run again";
const TIMEOUT_MS = IS_LARGER_SET ? 600_000 : 60_000;

const sessions = loadFixture<{ sessions: SessionRecord[] }>("sessions.json.gz").sessions;

describe("with the reference's C library values and PEAR's kinematics' answers, the robot does what PEAR's does, to the last bit", () => {
  let oracle: Oracle;
  const comparison = new Comparison(true);
  const differing: string[] = [];
  let steps = 0;
  let ticks = 0;

  beforeAll(() => {
    oracle = installOracle(DIRECTORY);
  });
  afterAll(() => {
    console.info(`libm.json: ${oracle.size} values; ${oracle.hits()} calls answered from it, ${oracle.missing()} arguments missing`);
    oracle.close();
  });

  sessions.forEach((session, index) => {
    test(`session ${index + 1}: ${session.name} (${session.station})`, { timeout: TIMEOUT_MS }, async () => {
      const verdict = await playAndCompare(session, comparison);
      steps += verdict.steps;
      ticks += verdict.ticks;
      if (verdict.difference !== null) {
        differing.push(`${session.name}: ${verdict.difference}`);
      }
      expect(verdict.difference).toBeNull();
      expect(verdict.steps).toBe(session.steps.length);
    });
  });

  test("every session, every step, and every number the same double", () => {
    const expectedSteps = sessions.reduce((sum, session) => sum + session.steps.length, 0);
    const expectedTicks = sessions.reduce(
      (sum, session) => sum + session.steps.reduce((inner, step) => inner + step.ticks.length, 0),
      0,
    );
    console.info(
      `sessions: ${sessions.length} sessions, ${steps} of ${expectedSteps} steps, ${ticks} of ${expectedTicks} control ` +
        `periods, ${differing.length} sessions differ; ${comparison.summary()}`,
    );
    if (process.env.PEAR_JS_ROBOT_REPORT) {
      console.info(differing.map((difference) => `  ${difference.slice(0, 900)}`).join("\n"));
    }

    expect(differing).toEqual([]);
    expect(sessions.length).toBeGreaterThanOrEqual(73);
    expect(steps).toBe(expectedSteps);
    expect(ticks).toBe(expectedTicks);
    expect(comparison.identical).toBe(comparison.numbers);
  });

  test("the table of the reference's C library values held every argument the port asked for", () => {
    expect(oracle.missing(), MISSING).toBe(0);
  });
});
