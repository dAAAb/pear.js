import { describe, expect, test } from "vitest";

import { ArmState } from "../../src/station/joint/arm_state";
import { SteppedClock } from "../../src/station/joint/clock";
import type { ControlSettings } from "../../src/station/joint/config";
import { RuntimeError } from "../../src/station/joint/errors";
import {
  SampleWindow,
  StabilityError,
  StabilityWindow,
  type StabilityCriteria,
  type StabilityFeedback,
  type StabilityMetrics,
  type StabilitySnapshot,
} from "../../src/station/joint/stability";
import type { SampleId } from "../../src/station/schemas";
import { jsonText, loadFixture, meta, outcomeOf, report, stationOf, type Outcome } from "./fixtures";

/** One arm's feedback as a step holds it: a single number stands for that value in every coordinate, and a stamp
 * left out is the step's `now`. */
interface PackedFeedback {
  position: number | number[];
  velocity: number | number[];
  sampled_monotonic_s?: number;
  sample_id?: SampleId;
}

interface Step {
  op: "add" | "check_hold" | "evaluate" | "reset" | "relax" | "stability_error" | "set";
  now?: number;
  /** Each arm's feedback, or under `all` the one feedback every arm has. */
  arms?: Record<string, PackedFeedback>;
  all?: PackedFeedback;
  criteria?: { arms?: string[] | null; duration_s?: number | null; targets?: Record<string, number[]> | null; position_tolerance?: number | number[] | null };
  duration_s?: number;
  reason?: string;
  robot?: Record<string, number>;
  outcome?: Outcome | { type: string; message: string; details: unknown };
  /** The window's span and its sample count after the step, where its whole metrics are not kept. */
  brief?: [number | null, number | null];
  metrics?: StabilityMetrics;
}

interface Scenario {
  name: string;
  station: string;
  control: ControlSettings;
  robot: Record<string, number>;
  window: { duration_s: number; is_strict: boolean; checks_velocity_rms: boolean };
  steps: Step[];
}

interface WindowStep {
  op: "add" | "recent" | "is_complete" | "clear";
  sampled_monotonic_s?: number;
  sample_id?: SampleId;
  value?: number;
  duration_s?: number;
  rate_hz?: number;
  outcome?: boolean;
  stamps?: number[];
  values?: number[];
  last_identity?: number | string | null;
}

const fixture = loadFixture<{
  scenarios: Scenario[];
  window_scenarios: { checks_stamp_order: boolean; history_s: number; state_timeout_s: number; steps: WindowStep[] }[];
  error_cases: { reason: string; metrics: StabilityMetrics; message: string; details: unknown }[];
}>("stability.json");

/** Returns the snapshot a step feeds, each arm's feedback written out. */
function snapshotOf(step: Step, arms: readonly string[], width: number): StabilitySnapshot {
  const whole = (values: number | number[]): number[] =>
    typeof values === "number" ? new Array<number>(width).fill(values) : values;

  return {
    arms: Object.fromEntries(
      arms.map((arm) => {
        const packed = (step.all ?? step.arms![arm])!;
        const feedback: Record<string, unknown> = {
          position: whole(packed.position),
          velocity: whole(packed.velocity),
          sampled_monotonic_s: packed.sampled_monotonic_s ?? step.now!,
        };
        if ("sample_id" in packed) {
          feedback["sample_id"] = packed.sample_id;
        }
        return [arm, feedback as unknown as StabilityFeedback];
      }),
    ),
  };
}

function criteriaOf(step: Step): StabilityCriteria {
  const given = step.criteria!;
  const criteria: Record<string, unknown> = {};
  if ("arms" in given) criteria["arms"] = given.arms;
  if ("duration_s" in given) criteria["durationS"] = given.duration_s;
  if ("targets" in given) criteria["targets"] = given.targets;
  if ("position_tolerance" in given) criteria["positionTolerance"] = given.position_tolerance;

  return criteria as StabilityCriteria;
}

/** Feeds a scenario to a window of pear.js and compares every step with what PEAR's window answered. */
function replay(scenario: Scenario): { steps: number; metricsCompared: number } {
  const station = stationOf(scenario.station, scenario.control);
  const robotConfig = station.robotConfig as unknown as Record<string, number>;
  Object.assign(robotConfig, scenario.robot);
  const clock = new SteppedClock();
  const window = new StabilityWindow(
    station.controlConfig,
    station.robotConfig,
    {
      durationS: scenario.window.duration_s,
      isStrict: scenario.window.is_strict,
      checksVelocityRms: scenario.window.checks_velocity_rms,
    },
    clock,
  );
  const { arms, coordinateCount } = station.layout;
  let metricsCompared = 0;

  scenario.steps.forEach((step, index) => {
    const where = `${scenario.name}, step ${index} (${step.op})`;
    if (step.now !== undefined) {
      clock.now = step.now;
    }
    switch (step.op) {
      case "add":
      case "check_hold": {
        const snapshot = snapshotOf(step, arms, coordinateCount);
        const ours = outcomeOf(() => (step.op === "add" ? window.add(snapshot) : window.checkHold(snapshot)));
        expect(ours, where).toEqual(step.outcome);
        if (step.metrics !== undefined) {
          expect(window.metrics, where).toEqual(step.metrics);
          expect(jsonText(window.metrics), where).toBe(jsonText(step.metrics));
          metricsCompared += 1;
        } else {
          expect([window.metrics.window_seconds ?? null, window.metrics.samples ?? null], where).toEqual(step.brief);
        }
        break;
      }
      case "evaluate": {
        const ours = outcomeOf(() => window.evaluate(criteriaOf(step)));
        expect(ours, where).toEqual(step.outcome);
        expect(jsonText(ours), where).toBe(jsonText(step.outcome));
        metricsCompared += 1;
        break;
      }
      case "reset":
        window.reset();
        expect(window.metrics, where).toEqual(step.metrics);
        break;
      case "relax":
        window.relax(step.duration_s!);
        break;
      case "stability_error": {
        const error = window.stabilityError(step.reason!);
        const ours = { type: error.name, message: error.message, details: error.details };
        expect(ours, where).toEqual(step.outcome);
        expect(jsonText(ours), where).toBe(jsonText(step.outcome));
        break;
      }
      case "set":
        Object.assign(robotConfig, step.robot);
        break;
    }
  });

  return { steps: scenario.steps.length, metricsCompared };
}

describe("the stability window", () => {
  let steps = 0;
  let metricsCompared = 0;

  for (const scenario of fixture.scenarios) {
    test(`${scenario.station}: ${scenario.name} (${scenario.steps.length} steps)`, () => {
      const replayed = replay(scenario);
      steps += replayed.steps;
      metricsCompared += replayed.metricsCompared;
    });
  }

  test("the scenarios hold every answer a window gives", () => {
    const outcomes = fixture.scenarios.flatMap((scenario) => scenario.steps.map((step) => jsonText(step.outcome ?? null)));
    const messages = new Set(
      fixture.scenarios.flatMap((scenario) =>
        scenario.steps.flatMap((step) => (step.outcome && "error" in step.outcome ? [step.outcome.error.message.split(":")[0]!] : [])),
      ),
    );

    report(`stability: ${fixture.scenarios.length} scenarios, ${steps} steps, metrics compared after ${metricsCompared}`);
    expect(outcomes).toContain('{"ok":true}');
    expect(outcomes).toContain('{"ok":false}');
    for (const message of [
      "Stale/invalid stability feedback",
      "Invalid settling feedback",
      "Invalid stability window selection",
      "Persistent motion during HOLD",
    ]) {
      expect([...messages], message).toContain(message);
    }
    // numpy's refusals of a tolerance that is missing or too short, which PEAR lets through
    expect([...messages].some((message) => message.startsWith("'>' not supported"))).toBe(true);
    expect([...messages].some((message) => message.startsWith("operands could not be broadcast"))).toBe(true);
    expect(new Set(fixture.scenarios.map((scenario) => scenario.station))).toEqual(
      new Set(["so101_station", "so101_quick", "two_arm", "two_arm_station"]),
    );
  });

  test("the constants are PEAR's", () => {
    const constants = meta.constants.stability_window;

    expect(StabilityWindow.VELOCITY_MEAN).toBe(constants["velocity_mean"]);
    expect(StabilityWindow.VELOCITY_RMS).toBe(constants["velocity_rms"]);
    expect(StabilityWindow.POSITION_SPAN).toBe(constants["position_span"]);
    expect(StabilityWindow.TARGET_ERROR_MAX).toBe(constants["target_error_max"]);
    expect(StabilityWindow.RATE_SUFFIX).toBe(constants["rate_suffix"]);
    expect(SampleWindow.MIN_SAMPLES).toBe(meta.constants.sample_window.min_samples);
    expect(SampleWindow.FRESH_FRACTION).toBe(meta.constants.sample_window.fresh_fraction);
    expect(ArmState.CLOCK_SLACK_S).toBe(meta.constants.arm_state.clock_slack_s);
  });
});

describe("the sample window", () => {
  fixture.window_scenarios.forEach((scenario, number) => {
    test(`sequence ${number}: ${scenario.steps.length} steps, ${scenario.checks_stamp_order ? "stamps in order" : "stamps in any order"}`, () => {
      const window = new SampleWindow<number>(
        { state_timeout_s: scenario.state_timeout_s },
        scenario.history_s,
        scenario.checks_stamp_order,
      );

      scenario.steps.forEach((step, index) => {
        const where = `step ${index} (${step.op})`;
        switch (step.op) {
          case "add":
            expect(window.add(step.sampled_monotonic_s!, step.sample_id, step.value!), where).toBe(step.outcome);
            expect(window.samples.map((sample) => sample.sampledMonotonicS), where).toEqual(step.stamps);
            expect(window.samples.map((sample) => sample.value), where).toEqual(step.values);
            expect(window.lastIdentity, where).toEqual(step.last_identity);
            break;
          case "recent":
            expect(window.recent(step.duration_s!).map((sample) => sample.sampledMonotonicS), where).toEqual(step.stamps);
            break;
          case "is_complete":
            expect(SampleWindow.isComplete(window.samples, step.duration_s!, step.rate_hz!), where).toBe(step.outcome);
            break;
          case "clear":
            window.clear();
            expect(window.samples).toEqual([]);
            expect(window.lastIdentity).toBeNull();
            break;
        }
      });
    });
  });

  test("the sequences hold repeated readings, gaps and both answers of a complete window", () => {
    const steps = fixture.window_scenarios.flatMap((scenario) => scenario.steps);

    expect(steps.some((step) => step.op === "add" && step.outcome === false)).toBe(true);
    expect(steps.some((step) => step.op === "add" && step.outcome === true && step.stamps!.length === 1)).toBe(true);
    expect(steps.some((step) => step.op === "is_complete" && step.outcome === true)).toBe(true);
    expect(steps.some((step) => step.op === "is_complete" && step.outcome === false)).toBe(true);
  });
});

describe("the stability error", () => {
  test(`${fixture.error_cases.length} errors made from a fault's details word themselves as PEAR's`, () => {
    for (const item of fixture.error_cases) {
      const error = new StabilityError(item.reason, item.metrics);

      expect(error.message).toBe(item.message);
      expect(error.details).toEqual(item.details);
      expect(jsonText(error.details)).toBe(jsonText(item.details));
    }
  });

  test("it is PEAR's StabilityError, a RuntimeError, and keeps its own copy of the metrics", () => {
    const metrics: StabilityMetrics = { window_seconds: 0.5, samples: 26, violations: [] };
    const error = new StabilityError("Unstable", metrics);
    metrics.samples = 1;

    expect(error.name).toBe("StabilityError");
    expect(meta.errors["StabilityError"]).toEqual(["StabilityError", "RuntimeError", "Exception"]);
    expect(error).toBeInstanceOf(RuntimeError);
    expect(error).toBeInstanceOf(Error);
    expect(error.metrics.samples).toBe(26);
    expect(error.reason).toBe("Unstable");
    error.details.metrics.samples = 2;
    expect(error.metrics.samples).toBe(26);
  });
});
