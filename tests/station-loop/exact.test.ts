// The control loop against PEAR's own with the reference's own C library: every number must be the same double.
//
// Ruckig takes five functions from the engine that no library rounds correctly (src/ruckig/libm.ts). Here they answer
// from libm.json beside the fixtures, a table of what the reference's C library gave for the same arguments (see
// tests/ruckig/oracle.ts; the table is made by tools/fixtures/ruckig_fixtures.py --libm <the fixtures' directory>,
// in a few rounds). Whatever still differs from PEAR's record is an error of the port: nothing here depends on the
// engine. One file holds every exact comparison of this directory, because the table has one list of what it lacks.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { installOracle, type Oracle } from "../ruckig/oracle";
import { Comparison } from "./compare";
import { DIRECTORY, IS_LARGER_SET, loadFixture } from "./fixtures";
import { playAndCompare, type ScenarioRecord } from "./player";
import { trajectoryChecks, type TrajectoryFixture } from "./trajectory_cases";

const MISSING = "the port asked for arguments libm.json does not hold: add them (see tests/ruckig/oracle.ts) and run again";
const TIMEOUT_MS = IS_LARGER_SET ? 1_800_000 : 120_000;

const checks = trajectoryChecks(loadFixture<TrajectoryFixture>("trajectory.json.gz"));
const scenarios = loadFixture<{ scenarios: ScenarioRecord[] }>("loops.json.gz").scenarios;

/** Prints every difference, when PEAR_JS_LOOP_REPORT asks for them (a failing test shows only the first). */
function report(differences: string[]): void {
  if (process.env.PEAR_JS_LOOP_REPORT) {
    console.info(differences.map((difference) => `  ${difference.slice(0, 700)}`).join("\n"));
  }
}

describe("with the reference's C library values, pear.js gives PEAR's numbers to the last bit", () => {
  let oracle: Oracle;
  beforeAll(() => {
    oracle = installOracle(DIRECTORY);
  });
  afterAll(() => {
    console.info(`libm.json: ${oracle.size} values; ${oracle.hits()} calls answered from it, ${oracle.missing()} arguments missing`);
    oracle.close();
  });

  // one test a case and a scenario, so that a difference names what it breaks and a run counts what differs
  describe("JointMove, JointTrajectory, GripperProfile and the operations", () => {
    const comparison = new Comparison(true);
    const differences: string[] = [];
    for (const check of checks) {
      test(check.name, { timeout: TIMEOUT_MS }, () => {
        const difference = check.difference(comparison);
        if (difference !== null) {
          differences.push(difference);
        }
        expect(difference).toBeNull();
      });
    }

    test("every case, and every number the same double", () => {
      console.info(`trajectory: ${checks.length} cases, ${differences.length} differ; ${comparison.summary()}`);
      report(differences);

      expect(differences.length).toBe(0);
      expect(checks.length).toBeGreaterThanOrEqual(IS_LARGER_SET ? 600 : 250);
      expect(comparison.numbers).toBeGreaterThanOrEqual(150_000);
      expect(comparison.identical).toBe(comparison.numbers);
    });
  });

  describe("the control loop, period by period", () => {
    const comparison = new Comparison(true);
    const differences: string[] = [];
    let events = 0;
    for (const scenario of scenarios) {
      test(scenario.name, { timeout: TIMEOUT_MS }, async () => {
        const verdict = await playAndCompare(scenario, comparison);
        events += verdict.events;
        if (verdict.difference !== null) {
          differences.push(`${scenario.name}: ${verdict.difference}`);
        }
        expect(verdict.difference).toBeNull();
      });
    }

    test("every scenario, and every number the same double", () => {
      console.info(
        `loops: ${scenarios.length} scenarios, ${events} records and results, ${differences.length} scenarios differ; ` +
          comparison.summary(),
      );
      report(differences);

      expect(differences.length).toBe(0);
      expect(scenarios.length).toBeGreaterThanOrEqual(IS_LARGER_SET ? 500 : 286);
      expect(events).toBeGreaterThanOrEqual(20_000);
      expect(comparison.numbers).toBeGreaterThanOrEqual(2_000_000);
      expect(comparison.identical).toBe(comparison.numbers);
    });
  });

  test("the table of the reference's C library values held every argument the port asked for", () => {
    expect(oracle.missing(), MISSING).toBe(0);
  });
});
