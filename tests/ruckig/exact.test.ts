// The port against the reference with the reference's own C library: every number must be the same double.
//
// The port takes five functions from the engine that no library rounds correctly (src/ruckig/libm.ts). Here they
// answer from libm.json beside the fixtures, a table of what the reference's C library gave for the same arguments
// (see oracle.ts). A difference of the last digit can then no longer come from a cube root or a cosine: whatever
// still differs is an error of the port. Nothing here depends on the engine.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DIRECTORY, load, timeout, type CalculationCase, type Session } from "./fixtures";
import { Report, compareCalculation } from "./harness";
import { installOracle, type Oracle } from "./oracle";
import { SessionReport, replay } from "./sessions";

const MISSING = "the port asked for arguments libm.json does not hold: add them (see oracle.ts) and run again";

describe("with the reference's C library values, the port gives the reference's numbers to the last bit", () => {
  let oracle: Oracle;
  beforeAll(() => {
    oracle = installOracle(DIRECTORY);
  });
  afterAll(() => {
    console.info(`libm.json: ${oracle.size} values; ${oracle.hits()} calls answered from it, ${oracle.missing()} arguments missing`);
    oracle.close();
  });

  test.each(["a_pear", "b_general", "c_velocity", "d_multi", "g_lower"])("calculate: %s", { timeout: timeout() }, (name) => {
    const report = new Report();
    load<CalculationCase>(name).forEach((item, index) => compareCalculation(report, item, `${name} ${index} (${item.k})`));
    console.info(report.summary(name));

    expect(oracle.missing(), MISSING).toBe(0);
    expect(report.cases).toBeGreaterThanOrEqual(40);
    expect([...report.outcomeDifferences.entries()]).toEqual([]);
    expect([...report.profileDifferences.entries()]).toEqual([]);
    expect(report.different).toBe(0);
    expect(report.jerkDifferences).toBe(0);
    expect(report.levelExtrema + report.otherCrossings).toBe(0);
    expect(report.identicalCases).toBe(report.cases);
  });

  test("update: sessions", { timeout: timeout() }, () => {
    const report = new SessionReport();
    // no step may be another trajectory: any difference at all fails below
    load<Session>("e_sessions").forEach((session, index) => replay(report, session, `e_sessions ${index} (${session.k})`, Infinity));
    console.info(report.summary("e_sessions"));

    expect(oracle.missing(), MISSING).toBe(0);
    expect(report.sessions).toBeGreaterThan(20);
    expect([...report.divergences.entries()]).toEqual([]);
    expect(report.different).toBe(0);
    expect(report.identicalSessions).toBe(report.sessions);
  });
});
