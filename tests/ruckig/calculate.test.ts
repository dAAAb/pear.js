// The port as it ships, with the engine's own cube roots, sines, cosines, arc tangents and arc cosines, against the
// reference. (exact.test.ts compares the same cases to the last bit with the reference's C library values.)

import { describe, expect, test } from "vitest";

import { load, timeout, type CalculationCase } from "./fixtures";
import { Report, compareCalculation, type TallyName } from "./harness";

// How far a number may be from the reference's, relative to the size of its quantity in its trajectory, in a case
// with the reference's outcome and kinds of profile. docs/progress/ruckig.md ("Tolerances") has what was measured
// on 108,375 cases and the reason for each bound.
const GENERAL = 1e-9;
const TOLERANCES: Record<TallyName, number> = {
  duration: GENERAL,
  independentMinDurations: GENERAL,
  times: GENERAL,
  jerks: GENERAL,
  states: GENERAL,
  brake: GENERAL,
  extrema: GENERAL,
  samples: GENERAL,
  // the time of an extremum is a root of the velocity, often a double one: known to the square root of the rounding
  extremaTimes: 1e-5,
  // a position approached at rest is reached at a triple root: known to the cube root of the rounding
  firstTimes: 1e-4,
};

// The share of the cases in which a last digit may give another valid profile, or another outcome (measured: 6 and
// 1 in 108,375), and of those in which it may put an extremum or a first passing elsewhere in the trajectory.
const OTHER_SOLUTION_SHARE = 0.001;
const ELSEWHERE_SHARE = 0.005;

function run(name: string): Report {
  const report = new Report();
  load<CalculationCase>(name).forEach((item, index) => compareCalculation(report, item, `${name} ${index} (${item.k})`));
  console.info(report.summary(name));
  return report;
}

describe.each([
  ["a_pear", "one coordinate in PEAR's regime"],
  ["b_general", "one coordinate, any state"],
  ["c_velocity", "one coordinate, velocity interface"],
  ["d_multi", "several coordinates"],
  ["g_lower", "infinite jerk or acceleration caps"],
])("calculate with the engine's own functions: %s (%s)", (name) => {
  test("gives the reference's outcome and profiles, and its numbers within the tolerances", { timeout: timeout() }, () => {
    const report = run(name);
    const allowed = (share: number): number => Math.max(1, Math.floor(report.cases * share));

    expect(report.cases).toBeGreaterThanOrEqual(40);
    expect(report.outcomeDifferenceCount, [...report.outcomeDifferences.keys()].join("; ")).toBeLessThanOrEqual(allowed(OTHER_SOLUTION_SHARE));
    expect(report.profileDifferenceCount, [...report.profileDifferences.keys()].join("; ")).toBeLessThanOrEqual(allowed(OTHER_SOLUTION_SHARE));
    expect(report.levelExtrema + report.otherCrossings).toBeLessThanOrEqual(allowed(ELSEWHERE_SHARE));
    expect(report.exceeding(TOLERANCES)).toEqual([]);
    // most cases need no cube root at all, or one that the engine rounds as the reference's library does
    expect(report.identicalCases).toBeGreaterThan(report.cases * 0.75);
  });
});
