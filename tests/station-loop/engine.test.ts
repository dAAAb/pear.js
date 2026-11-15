// The control loop against PEAR's own with the engine's own C library functions: what a browser runs.
//
// exact.test.ts answers Ruckig's five inexact functions (cube root, sine, cosine, arc tangent, arc cosine) from a
// table of the reference's values, and then every number is PEAR's to the last bit. Here they are the engine's, as
// in a page, and the same scenarios must take the same course: every text, state and count as PEAR's, every number
// within a tolerance. The largest deviation is measured and printed; docs/progress/loop.md records it.
//
// The tolerances are relative to the larger of 1 and PEAR's number. For the loop it is 1e-8: the largest deviation
// measured on Node 24 is 1.7e-9, in the duration (6.8e-10 s in PEAR) of a stop that is planned from a planned
// velocity of about 1e-9 rad/s, a cube root away from nothing; everything else is within 1e-11.

import { describe, expect, test } from "vitest";

import { Comparison } from "./compare";
import { IS_LARGER_SET, loadFixture } from "./fixtures";
import { playAndCompare, type ScenarioRecord } from "./player";
import { compareTrajectoryFixture, type TrajectoryFixture } from "./trajectory_cases";

const TIMEOUT_MS = IS_LARGER_SET ? 1_800_000 : 120_000;
/** For the trajectory classes by themselves. */
const TRAJECTORY_TOLERANCE = 1e-11;
/** For the control loop, which plans stops and retargets from states that differ in their last digits. */
const LOOP_TOLERANCE = 1e-8;

describe("with the engine's own C library functions, pear.js follows PEAR within a tolerance", () => {
  test("JointMove, JointTrajectory, GripperProfile and the operations", { timeout: TIMEOUT_MS }, () => {
    const comparison = new Comparison(false, TRAJECTORY_TOLERANCE);
    const result = compareTrajectoryFixture(loadFixture<TrajectoryFixture>("trajectory.json.gz"), comparison);
    console.info(`engine, trajectory: ${result.summary}; ${comparison.summary()}`);

    expect(result.differences.slice(0, 8)).toEqual([]);
    expect(result.cases).toBeGreaterThanOrEqual(250);
    expect(comparison.largest).toBeLessThanOrEqual(TRAJECTORY_TOLERANCE);
    // the engine's functions are the reference's for most arguments: a comparison that found no number apart
    // would not be this one
    expect(comparison.identical).toBeLessThan(comparison.numbers);
  });

  test("the control loop, period by period", { timeout: TIMEOUT_MS }, async () => {
    const scenarios = loadFixture<{ scenarios: ScenarioRecord[] }>("loops.json.gz").scenarios;
    const comparison = new Comparison(false, LOOP_TOLERANCE);
    const differences: string[] = [];
    let events = 0;
    for (const scenario of scenarios) {
      const verdict = await playAndCompare(scenario, comparison);
      events += verdict.events;
      if (verdict.difference !== null) {
        differences.push(`${scenario.name}: ${verdict.difference}`);
      }
    }
    console.info(
      `engine, loops: ${scenarios.length} scenarios, ${events} records and results, ${differences.length} scenarios ` +
        `differ; ${comparison.summary()}`,
    );

    expect(differences.slice(0, 8)).toEqual([]);
    expect(scenarios.length).toBeGreaterThanOrEqual(286);
    expect(comparison.largest).toBeLessThanOrEqual(LOOP_TOLERANCE);
    expect(comparison.identical).toBeLessThan(comparison.numbers);
  });
});
