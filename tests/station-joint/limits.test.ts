import { describe, expect, test } from "vitest";

import { SO101_DEFAULT_CONFIG } from "../../src/so101/config";
import { LAYOUT } from "../../src/so101/layout";
import { JointLimits, type MotionCaps } from "../../src/station/joint/limits";
import { integerPower } from "../../src/station/joint/numeric";
import {
  jointLimitsRecord,
  loadFixture,
  meta,
  outcomeOf,
  report,
  repositoryFile,
  revived,
  stationOf,
  type Outcome,
  type Station,
} from "./fixtures";

interface LimitCase {
  station: string;
  method: "check_positions" | "check_command" | "bounds" | "check_trajectory" | "motion_caps" | "braking_caps";
  vector?: number[];
  tolerance?: number;
  target?: number[];
  previous_target?: number[];
  start?: number[];
  position_extrema?: { min: number; max: number }[];
  speed_scale?: number;
  /** The speed scale to the powers 1, 2 and 3 as PEAR's Python computed them. */
  powers?: number[];
  caps?: MotionCaps;
  outcome: Outcome;
}

const fixture = loadFixture<{ cases: LimitCase[]; power_cases: number[][] }>("limits.json");
const stationKeys = [...new Set(fixture.cases.map((item) => item.station))];
const stations = new Map<string, Station>(stationKeys.map((key) => [key, stationOf(key)]));

/** Returns what pear.js's limits answer the call a case records. */
function answered(station: Station, limits: JointLimits, item: LimitCase): Outcome {
  const layout = station.layout;

  return outcomeOf(() => {
    switch (item.method) {
      case "check_positions":
        return item.tolerance === undefined
          ? limits.checkPositions(item.vector!, layout)
          : limits.checkPositions(item.vector!, layout, item.tolerance);
      case "check_command":
        return limits.checkCommand(item.target!, item.previous_target!, layout);
      case "bounds":
        return limits.bounds(item.start!);
      case "check_trajectory":
        return limits.checkTrajectory({ positionExtrema: item.position_extrema! }, item.start!);
      case "motion_caps":
        return item.speed_scale === undefined ? limits.motionCaps() : limits.motionCaps(item.speed_scale, item.caps ?? null);
      case "braking_caps":
        return limits.brakingCaps();
    }
  });
}

/** Returns how many units in the last place of `expected` the number `value` is from it. */
function unitsApart(value: number, expected: number): number {
  if (Object.is(value, expected)) {
    return 0;
  }
  const view = new DataView(new ArrayBuffer(16));
  view.setFloat64(0, value);
  view.setFloat64(8, expected);
  const difference = view.getBigInt64(0) - view.getBigInt64(8);

  return Number(difference < 0n ? -difference : difference);
}

describe("the limits of the joint vector", () => {
  for (const key of Object.keys(meta.stations)) {
    test(`the limits of the station ${key} are what PEAR derives of its settings`, () => {
      const station = stationOf(key);
      const limits = station.robotConfig.jointLimits();

      expect(jointLimitsRecord(limits)).toEqual(station.record.joint_limits);
      expect(limits.brakingCaps()).toEqual(station.record.braking_caps);
      expect(limits.motionCaps()).toEqual(station.record.motion_caps);
      expect(Object.isFrozen(limits.lowerBounds)).toBe(true);
    });
  }

  test("the constants are PEAR's", () => {
    expect(JointLimits.EPSILON).toBe(meta.constants.joint_limits.epsilon);
    expect([...JointLimits.CAP_NAMES]).toEqual(meta.constants.joint_limits.cap_names);
  });

  for (const key of stationKeys) {
    const ofStation = fixture.cases.filter((item) => item.station === key);
    for (const method of ["check_positions", "check_command", "bounds", "check_trajectory", "braking_caps"] as const) {
      const ofMethod = ofStation.filter((item) => item.method === method);
      const refused = ofMethod.filter((item) => "error" in item.outcome).length;

      test(`${method} on ${key}: ${ofMethod.length} calls answered as PEAR answers them (${refused} refused)`, () => {
        const station = stations.get(key)!;
        const limits = station.robotConfig.jointLimits();
        const differing = ofMethod.flatMap((item) => {
          const ours = answered(station, limits, item);
          try {
            expect(ours).toEqual(item.outcome);
          } catch {
            return [{ item, ours }];
          }
          return [];
        });

        expect(differing.slice(0, 5)).toEqual([]);
        expect(ofMethod.length).toBeGreaterThan(0);
      });
    }

    const capCases = ofStation.filter((item) => item.method === "motion_caps");
    test(`motion_caps on ${key}: ${capCases.length} calls; the caps are PEAR's wherever its power is the exact one`, () => {
      const station = stations.get(key)!;
      const limits = station.robotConfig.jointLimits();
      let exact = 0;
      let off = 0;
      let furthest = 0;

      for (const item of capCases) {
        const ours = answered(station, limits, item);
        if ("error" in item.outcome || "error" in ours || item.powers === undefined) {
          expect(ours, JSON.stringify(item)).toEqual(item.outcome);
          continue;
        }
        const theirs = item.outcome.ok as number[][];
        const caps = ours.ok as number[][];
        expect(caps.map((list) => list.length)).toEqual(theirs.map((list) => list.length));
        caps.forEach((list, order) => {
          // PEAR's power of the speed scale is its C library's; where that is the exact power, the cap is PEAR's
          const samePower = Object.is(integerPower(item.speed_scale!, order + 1), item.powers![order]);
          list.forEach((cap, index) => {
            const apart = unitsApart(cap, theirs[order]![index]!);
            if (samePower) {
              expect(apart, `${JSON.stringify(item)} order ${order + 1} index ${index}`).toBe(0);
              exact += 1;
            } else {
              // one unit of the power, and at most one more from the product's own rounding
              expect(apart, `${JSON.stringify(item)} order ${order + 1} index ${index}`).toBeLessThanOrEqual(2);
              off += apart > 0 ? 1 : 0;
              furthest = Math.max(furthest, apart);
            }
          });
        });
      }

      report(`motion_caps ${key}: ${capCases.length} calls, ${exact} caps identical, ${off} off (furthest ${furthest} ulp)`);
      expect(exact).toBeGreaterThan(off * 50);
    });
  }

  test(`the powers of ${fixture.power_cases.length} speed scales are the exact ones, which Python's are almost always`, () => {
    let squaresOff = 0;
    let cubesOff = 0;
    for (const [scale, square, cube, exactSquare, exactCube] of fixture.power_cases as [number, number, number, number, number][]) {
      expect(Object.is(integerPower(scale, 1), scale)).toBe(true);
      expect(Object.is(integerPower(scale, 2), exactSquare), `${scale} squared`).toBe(true);
      expect(Object.is(integerPower(scale, 3), exactCube), `${scale} cubed`).toBe(true);
      expect(Object.is(scale * scale, exactSquare), `${scale} times itself`).toBe(true);
      // Python's pow is at most one unit in the last place from the exact power
      expect(unitsApart(square, exactSquare)).toBeLessThanOrEqual(1);
      expect(unitsApart(cube, exactCube)).toBeLessThanOrEqual(1);
      squaresOff += Object.is(square, exactSquare) ? 0 : 1;
      cubesOff += Object.is(cube, exactCube) ? 0 : 1;
    }

    report(
      `powers: ${fixture.power_cases.length} scales; Python's square is not the exact one for ${squaresOff}, its cube for ${cubesOff}`,
    );
    // the C library rounds a power wrongly for well under one scale in a hundred
    expect(squaresOff + cubesOff).toBeLessThan(fixture.power_cases.length / 50);
  });

  test("a power is refused unless its order is a whole number of at least 1, and passes what is not finite", () => {
    expect(() => integerPower(0.5, 0)).toThrow(RangeError);
    expect(() => integerPower(0.5, 1.5)).toThrow(RangeError);
    expect(Number.isNaN(integerPower(NaN, 3))).toBe(true);
    expect(integerPower(-Infinity, 3)).toBe(-Infinity);
    expect(Object.is(integerPower(-0, 3), -0)).toBe(true);
    expect(integerPower(-0.5, 3)).toBe(-0.125);
    expect(integerPower(3, 4)).toBe(81);
  });
});

describe("the one JointLimits for the kinematics too", () => {
  // src/so101/kinematics/limits.ts is the first stage's copy of check_positions. These tests run the joint layer's
  // class the way the kinematics and their tests use that copy, on the kinematics' own fixtures.
  interface BoundsCase {
    vector: (number | string)[];
    tolerance: number;
    message: string | null;
  }
  const kinematicsMeta = JSON.parse(repositoryFile("tests/fixtures/so101-kinematics/meta.json").toString("utf8")) as {
    limits: { epsilon: number; feedback_tolerance: number; lower_bounds: number[]; upper_bounds: number[] };
  };
  const boundsCases = (
    JSON.parse(repositoryFile("tests/fixtures/so101-kinematics/texts.json").toString("utf8")) as { bounds_cases: BoundsCase[] }
  ).bounds_cases;

  test("made from the bounds alone, it refuses the kinematics' vectors in PEAR's words", () => {
    const { lower_bounds: lower, upper_bounds: upper, feedback_tolerance: tolerance } = kinematicsMeta.limits;
    const limits = new JointLimits(lower, upper, tolerance);
    const named: Record<string, number> = { nan: NaN, inf: Infinity, "-inf": -Infinity };

    const differing = boundsCases.flatMap((bounds) => {
      const vector = bounds.vector.map((value) => (typeof value === "string" ? named[value]! : value));
      const ours = outcomeOf(() => limits.checkPositions(vector, LAYOUT, bounds.tolerance));
      const message = "error" in ours ? ours.error.message : null;
      return message === bounds.message && (message === null || ("error" in ours && ours.error.type === "ValueError"))
        ? []
        : [{ vector, expected: bounds.message, ours }];
    });

    expect(differing).toEqual([]);
    expect(boundsCases.length).toBeGreaterThan(100);
    expect(limits.motionCaps()).toEqual([[], [], []]);
    expect(limits.brakingCaps()).toEqual([[], []]);
  });

  test("made from the SO-101's settings as the kinematics make it, it holds the limits PEAR derives", () => {
    const limits = JointLimits.fromConfig(SO101_DEFAULT_CONFIG);

    expect(JointLimits.EPSILON).toBe(kinematicsMeta.limits.epsilon);
    expect(limits.lowerBounds).toEqual(kinematicsMeta.limits.lower_bounds);
    expect(limits.upperBounds).toEqual(kinematicsMeta.limits.upper_bounds);
    expect(limits.feedbackTolerance).toBe(kinematicsMeta.limits.feedback_tolerance);
    expect(jointLimitsRecord(limits)).toEqual(revived(meta.stations["so101"]!.joint_limits));
  });
});
