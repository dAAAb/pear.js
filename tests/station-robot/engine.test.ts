// The parts and the sessions once more, as a page runs them: on pear.js's own inverse kinematics (the exact
// comparisons answer the planning with PEAR's solver's recorded goals) and on the engine's own cube root, sine,
// cosine, arc tangent and arc cosine (the exact comparisons take the reference's C library values from libm.json).
// Nothing is then the same double by construction, so what differs is measured:
//
//   - a number may differ from PEAR's by the tolerance, relative to the larger of 1 and PEAR's number;
//   - a text that shows numbers (a snapshot in a timeout's message) may differ in those numbers by the same;
//   - the text of a pose out of reach may give another percentage ("at most 31% (x +12.5 of +40)"): how far the
//     arm can go is found by bisection on a solver that ran out of steps, where pear.js's solver and PEAR's stop at
//     different poses (docs/progress/kinematics.md measures it on 1,025 unreachable requests). The percentages
//     are compared and counted here; everything else of such a text must be PEAR's.
//
// Every other text, every class of an error, every count of control periods and every call of the driver must be
// PEAR's.

import { describe, expect, test } from "vitest";

import { Comparison } from "../station-loop/compare";
import { IS_LARGER_SET, loadFixture } from "./fixtures";
import { partsChecks, type PartsFixture } from "./parts_checks";
import { playAndCompare, type SessionRecord } from "./rig";

/** How far a number may be from PEAR's, relative to the larger of 1 and PEAR's number. */
const TOLERANCE = 1e-9;
/** How many points the percentage of an out-of-reach text may be from PEAR's. */
const REACH_POINTS = 3;
const TIMEOUT_MS = IS_LARGER_SET ? 600_000 : 60_000;

const NUMBER = /-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g;
const REACH = /at most (\d+)% \([^)]*\)/;

/** A comparison within a tolerance that also measures the texts that show numbers. */
class MeasuredComparison extends Comparison {
  /** The out-of-reach texts compared, those with another percentage than PEAR's, and the largest difference. */
  reachTexts = 0;
  reachTextsApart = 0;
  largestReachPoints = 0;
  /** The texts that differed from PEAR's in the numbers they show, within the tolerance. */
  numberTexts = 0;

  constructor() {
    super(false, TOLERANCE);
  }

  override difference(actual: unknown, expected: unknown, path = ""): string | null {
    if (typeof expected !== "string" || typeof actual !== "string") {
      return super.difference(actual, expected, path);
    }
    const isReach = expected.includes("The target is out of reach.");
    if (isReach) {
      this.reachTexts += 1;
    }
    if (actual === expected) {
      return null;
    }

    const told = `${path}: ${JSON.stringify(actual).slice(0, 300)} (PEAR: ${JSON.stringify(expected).slice(0, 300)})`;
    if (isReach) {
      const ours = REACH.exec(actual);
      const pears = REACH.exec(expected);
      if (ours === null || pears === null || actual.replace(REACH, "") !== expected.replace(REACH, "")) {
        return told;
      }
      const points = Math.abs(Number(ours[1]) - Number(pears[1]));
      this.reachTextsApart += 1;
      this.largestReachPoints = Math.max(this.largestReachPoints, points);
      return points <= REACH_POINTS ? null : `${told}: ${points} points apart`;
    }

    // the same text around the same count of numbers, each within the tolerance of PEAR's
    const ourNumbers = actual.match(NUMBER) ?? [];
    const pearNumbers = expected.match(NUMBER) ?? [];
    if (ourNumbers.length !== pearNumbers.length || actual.replace(NUMBER, "#") !== expected.replace(NUMBER, "#")) {
      return told;
    }
    for (const [index, digits] of pearNumbers.entries()) {
      const pear = Number(digits);
      if (Math.abs(Number(ourNumbers[index]) - pear) > TOLERANCE * Math.max(1, Math.abs(pear))) {
        return `${told}: ${ourNumbers[index]} for ${digits}`;
      }
    }
    this.numberTexts += 1;
    return null;
  }

  override summary(): string {
    return (
      `${super.summary()}; ${this.reachTexts} out-of-reach texts, ${this.reachTextsApart} with another percentage ` +
      `(at most ${this.largestReachPoints} points apart); ${this.numberTexts} other texts whose numbers differ within the tolerance`
    );
  }
}

const fixture = loadFixture<PartsFixture>("parts.json.gz");
const sessions = loadFixture<{ sessions: SessionRecord[] }>("sessions.json.gz").sessions;

describe("on pear.js's own kinematics and the engine's own functions, within a tolerance", () => {
  describe("the parts", () => {
    const comparison = new MeasuredComparison();
    const checks = partsChecks(fixture, { kinematics: "own" });
    const differing: string[] = [];

    for (const check of checks) {
      test(check.name, async () => {
        const difference = await check.run(comparison);
        if (difference !== null) {
          differing.push(`${check.name}: ${difference}`);
        }
        expect(difference).toBeNull();
      });
    }

    test("every case, and how far the numbers are from PEAR's", () => {
      console.info(`engine, parts: ${checks.length} cases, ${differing.length} differ; ${comparison.summary()}`);
      expect(differing).toEqual([]);
      expect(comparison.largest).toBeLessThanOrEqual(TOLERANCE);
    });
  });

  describe("the sessions", () => {
    const comparison = new MeasuredComparison();
    const differing: string[] = [];
    let steps = 0;
    let ticks = 0;

    sessions.forEach((session, index) => {
      test(`session ${index + 1}: ${session.name} (${session.station})`, { timeout: TIMEOUT_MS }, async () => {
        const verdict = await playAndCompare(session, comparison, { kinematics: "own" });
        steps += verdict.steps;
        ticks += verdict.ticks;
        if (verdict.difference !== null) {
          differing.push(`${session.name}: ${verdict.difference}`);
        }
        expect(verdict.difference).toBeNull();
        expect(verdict.steps).toBe(session.steps.length);
      });
    });

    test("every session, and how far the numbers are from PEAR's", () => {
      console.info(
        `engine, sessions: ${sessions.length} sessions, ${steps} steps, ${ticks} control periods, ${differing.length} ` +
          `sessions differ; ${comparison.summary()}`,
      );
      if (process.env.PEAR_JS_ROBOT_REPORT) {
        console.info(differing.map((difference) => `  ${difference.slice(0, 900)}`).join("\n"));
      }
      expect(differing).toEqual([]);
      expect(comparison.largest).toBeLessThanOrEqual(TOLERANCE);
    });
  });
});
