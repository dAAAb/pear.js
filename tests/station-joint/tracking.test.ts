import { describe, expect, test } from "vitest";

import { RuntimeError } from "../../src/station/joint/errors";
import { Tracking, TrackingError } from "../../src/station/joint/tracking";
import { jsonText, loadFixture, meta, outcomeOf, stationOf, type Outcome } from "./fixtures";

interface TrackingCase {
  method: "check" | "arrival";
  measured: number[];
  reference: number[];
  outcome: Outcome;
}

interface TrackingScenario {
  station: string;
  arrival_tolerance: number[];
  fault_bounds: number[];
  cases: TrackingCase[];
}

const scenarios = loadFixture<{ scenarios: TrackingScenario[] }>("tracking.json").scenarios;

describe("tracking of the measured joints", () => {
  for (const scenario of scenarios) {
    const station = stationOf(scenario.station);
    const tracking = new Tracking(station.robotConfig, station.robotConfig.jointLimits(), station.layout);

    test(`${scenario.station}: the arrival tolerance and the fault bounds are PEAR's, a gripper's without bound`, () => {
      expect(tracking.arrivalTolerance).toEqual(scenario.arrival_tolerance);
      expect(tracking.faultBounds).toEqual(scenario.fault_bounds);
      for (const gripperIndex of station.layout.gripperIndices) {
        expect(tracking.faultBounds[gripperIndex]).toBe(Infinity);
      }
    });

    for (const method of ["check", "arrival"] as const) {
      const ofMethod = scenario.cases.filter((item) => item.method === method);
      const refused = ofMethod.filter((item) => "error" in item.outcome).length;

      test(`${scenario.station}: ${method} answers ${ofMethod.length} readings as PEAR's (${refused} raise)`, () => {
        const differing = ofMethod.flatMap((item) => {
          const ours = outcomeOf(() =>
            method === "check" ? tracking.check(item.measured, item.reference) : tracking.arrival(item.measured, item.reference),
          );
          try {
            expect(ours).toEqual(item.outcome);
            // the keys of an arrival are in PEAR's order
            expect(jsonText(ours)).toBe(jsonText(item.outcome));
          } catch {
            return [{ item, ours }];
          }
          return [];
        });

        expect(differing.slice(0, 4)).toEqual([]);
        expect(refused).toBeGreaterThan(0);
        expect(ofMethod.length - refused).toBeGreaterThan(0);
      });
    }
  }

  test("a tracking fault is PEAR's TrackingError, a RuntimeError, worded by the robot's texts", () => {
    const station = stationOf("so101");
    const tracking = new Tracking(station.robotConfig, station.robotConfig.jointLimits(), station.layout);
    const held = [0, 0, 0, 0, 0, 0.5];
    let failure: unknown;
    try {
      tracking.check([0, 0.3, 0, 0, 0, 0.5], held);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(TrackingError);
    expect(failure).toBeInstanceOf(RuntimeError);
    expect((failure as Error).name).toBe("TrackingError");
    expect(meta.errors["TrackingError"]).toEqual(["TrackingError", "RuntimeError", "Exception"]);
    expect((failure as Error).message).toBe("Excessive tracking error: shoulder_lift error=0.300000 > 0.250000 rad");
    // the same message is among PEAR's own
    const messages = scenarios.flatMap((scenario) =>
      scenario.cases.flatMap((item) => ("error" in item.outcome ? [item.outcome.error.message] : [])),
    );
    expect(messages.some((message) => message.startsWith("Excessive tracking error: shoulder_lift error="))).toBe(true);
    expect(messages.some((message) => message.startsWith("Held pose has excessive tracking error: left J1 error="))).toBe(true);
  });
});
