import { describe, expect, test } from "vitest";

import { SO101_DEFAULT_CONFIG, type FeedforwardConfig } from "../../src/so101/config";
import { SO101Driver, type ArmHardware } from "../../src/so101/hardware/driver";
import { Feedforward, GravityModel, SO101FrictionFeedforward } from "../../src/so101/joint/feedforward";
import { GRIPPER_INDEX, VECTOR_LENGTH } from "../../src/so101/layout";
import { FrictionFeedforward } from "../../src/station/joint/feedforward";
import { JointLimits } from "../../src/station/joint/limits";
import { loadFixture, meta, outcomeOf, report, type Outcome } from "./fixtures";

interface FrictionStep {
  op: "update" | "reset";
  /** The planned velocity and the load; an update that leaves one out has the one of the update before. */
  velocity?: number[] | null;
  load?: number[] | null;
  now?: number;
  outcome?: Outcome;
  state?: { level: number[]; direction: number[]; moved_at: number[]; updated_at: number | null };
}

interface FrictionSequence {
  name: string;
  class: "FrictionFeedforward" | "SO101FrictionFeedforward";
  magnitude: number[];
  load_ratio: number[];
  steps: FrictionStep[];
}

interface OffsetStep {
  op: "offset" | "hold_offset";
  target: number[];
  velocity?: number[] | null;
  now?: number;
  outcome: Outcome;
}

const fixture = loadFixture<{
  constructor_cases: { class: FrictionSequence["class"]; magnitude: number[]; load_ratio: number[]; outcome: Outcome }[];
  sequences: FrictionSequence[];
  gravity_cases: { joints: number[]; outcome: Outcome }[];
  offset_sequences: { name: string; feedforward: FeedforwardConfig; steps: OffsetStep[] }[];
}>("feedforward.json");

const CLASSES = { FrictionFeedforward, SO101FrictionFeedforward };

/** The largest difference of a gravity torque from pinocchio's that the tests accept, N*m (see the note below). */
const TORQUE_TOLERANCE = 4e-15;

/** Returns the largest difference between two vectors, and Infinity when they are not the same shape. */
function furthest(ours: readonly number[], theirs: readonly number[]): number {
  if (ours.length !== theirs.length) {
    return Infinity;
  }
  return ours.reduce((largest, value, index) => {
    const expected = theirs[index]!;
    const difference = Number.isNaN(value) && Number.isNaN(expected) ? 0 : Math.abs(value - expected);
    return Math.max(largest, Number.isNaN(difference) ? Infinity : difference);
  }, 0);
}

describe("the friction feedforward", () => {
  test("the constants are PEAR's, and the SO-101's class has them too", () => {
    const constants = meta.constants.friction_feedforward;

    for (const feedforwardClass of [FrictionFeedforward, SO101FrictionFeedforward]) {
      expect(feedforwardClass.MIN_MOVING_SPEED).toBe(constants["min_moving_speed"]);
      expect(feedforwardClass.LATCH_S).toBe(constants["latch_s"]);
      expect(feedforwardClass.FADE_S).toBe(constants["fade_s"]);
      expect(feedforwardClass.ENGAGE_S).toBe(constants["engage_s"]);
      expect(feedforwardClass.MAX_STEP_S).toBe(constants["max_step_s"]);
    }
  });

  test(`${fixture.constructor_cases.length} pairs of magnitudes and load ratios are taken or refused as in PEAR`, () => {
    const wrong = fixture.constructor_cases.flatMap((item) => {
      const ours = outcomeOf(() => {
        const feedforward = new CLASSES[item.class](item.magnitude, item.load_ratio);
        return { magnitude: feedforward.magnitude, load_ratio: feedforward.loadRatio };
      });
      try {
        expect(ours).toEqual(item.outcome);
      } catch {
        return [{ item, ours }];
      }
      return [];
    });

    expect(wrong).toEqual([]);
    const messages = new Set(fixture.constructor_cases.flatMap((item) => ("error" in item.outcome ? [item.outcome.error.message] : [])));
    expect(messages).toEqual(
      new Set([
        "Friction torques must be finite and non-negative",
        "Friction load ratios must be finite, non-negative, one per joint",
        "Expected one friction offset and load ratio per joint",
        "Friction offsets and load ratios must be non-negative",
      ]),
    );
  });

  let updates = 0;
  for (const sequence of fixture.sequences) {
    test(`${sequence.class}: ${sequence.name} (${sequence.steps.length} steps, to the last bit)`, () => {
      const feedforward = new CLASSES[sequence.class](sequence.magnitude, sequence.load_ratio);
      let velocity: number[] | null = null;
      let load: number[] | null = null;

      sequence.steps.forEach((step, index) => {
        const where = `step ${index}`;
        if (step.op === "reset") {
          feedforward.reset();
        } else {
          if ("velocity" in step) velocity = step.velocity!;
          if ("load" in step) load = step.load!;
          // every number of an answer is PEAR's bit for bit: the same additions in the same order
          expect(outcomeOf(() => feedforward.update(velocity, step.now!, load)), where).toEqual(step.outcome);
          updates += 1;
        }
        if (step.state !== undefined) {
          expect(
            { level: feedforward.level, direction: feedforward.direction, moved_at: feedforward.movedAt, updated_at: feedforward.updatedAt },
            where,
          ).toEqual(step.state);
        }
      });
    });
  }

  test("the sequences hold the refusals of a load that is none or of another length, and both classes", () => {
    const errors = new Set(
      fixture.sequences.flatMap((sequence) =>
        sequence.steps.flatMap((step) => (step.outcome && "error" in step.outcome ? [step.outcome.error.type] : [])),
      ),
    );

    report(`friction: ${fixture.sequences.length} sequences, ${updates} updates compared bit for bit`);
    expect(errors).toEqual(new Set(["TypeError", "ValueError"]));
    expect(new Set(fixture.sequences.map((sequence) => sequence.class))).toEqual(new Set(Object.keys(CLASSES)));
    // the eight scenarios of PEAR's own tests, and one of every malformed input for each class
    expect(fixture.sequences.filter((sequence) => !sequence.name.startsWith("generated")).length).toBe(10);
  });
});

describe("the SO-101's gravity model", () => {
  const model = new GravityModel();

  test(`the torque of ${fixture.gravity_cases.length} joint vectors is pinocchio's within ${TORQUE_TOLERANCE} N*m`, () => {
    let largest = 0;
    let largestTorque = 0;
    let identical = 0;
    let compared = 0;
    for (const item of fixture.gravity_cases) {
      const ours = outcomeOf(() => model.torque(item.joints));
      if ("error" in item.outcome || "error" in ours) {
        expect(ours, JSON.stringify(item.joints)).toEqual(item.outcome);
        continue;
      }
      const theirs = item.outcome.ok as number[];
      const torque = ours.ok as number[];
      const difference = furthest(torque, theirs);
      expect(difference, JSON.stringify(item.joints)).toBeLessThanOrEqual(TORQUE_TOLERANCE);
      largest = Math.max(largest, difference);
      largestTorque = Math.max(largestTorque, ...theirs.filter(Number.isFinite).map(Math.abs));
      torque.forEach((value, index) => {
        compared += 1;
        identical += Object.is(value, theirs[index]) ? 1 : 0;
      });
    }

    report(
      `gravity: ${fixture.gravity_cases.length} vectors, ${compared} torques, ${identical} identical, largest difference ` +
        `${largest.toExponential(2)} N*m; largest torque ${largestTorque.toFixed(3)} N*m`,
    );
    expect(fixture.gravity_cases.some((item) => "error" in item.outcome)).toBe(true);
    // the tolerance is not a loose one: it is a few units in the last place of the largest torque
    expect(TORQUE_TOLERANCE).toBeLessThan(40 * Number.EPSILON * largestTorque);
  });

  test("the torque at Home is the one PEAR's own test names", () => {
    // tests/deploy/station/test_so101_joint_in_station.py: "matches placo's generalized_gravity at the real Home"
    const torque = model.torque([0.0, -0.814, 0.077, 1.423, -1.613]);
    const named = [0.0, -0.0974, -0.3308, -0.0906, 0.0018];

    torque.forEach((value, index) => expect(Math.abs(value - named[index]!)).toBeLessThan(1e-3));
  });

  test("the gravity is the one pinocchio gives a model", () => {
    expect(meta.gravity.vector).toEqual([0, 0, -GravityModel.GRAVITY]);
    expect(meta.gravity.joints).toEqual(model.chain.joints.map((joint) => joint.name));
  });
});

describe("the SO-101's goal offsets", () => {
  let largest = 0;
  let steps = 0;

  for (const sequence of fixture.offset_sequences) {
    test(`${sequence.name}: ${sequence.steps.length} moves and holds give PEAR's offsets within ${TORQUE_TOLERANCE} rad`, () => {
      const feedforward = new Feedforward(sequence.feedforward);

      sequence.steps.forEach((step, index) => {
        const ours = outcomeOf(() =>
          step.op === "hold_offset" ? feedforward.holdOffset(step.target) : feedforward.offset(step.target, step.velocity ?? null, step.now!),
        );
        if ("error" in step.outcome || "error" in ours) {
          expect(ours, `step ${index}`).toEqual(step.outcome);
          return;
        }
        const offset = ours.ok as number[];
        const difference = furthest(offset, step.outcome.ok as number[]);
        // an offset is at most 0.3 rad a N*m of the torque plus the friction's, which follows the torque too
        expect(difference, `step ${index}`).toBeLessThanOrEqual(TORQUE_TOLERANCE);
        expect(offset).toHaveLength(VECTOR_LENGTH);
        expect(Object.is(offset[GRIPPER_INDEX], 0)).toBe(true);
        largest = Math.max(largest, difference);
        steps += 1;
      });
    });
  }

  test("the offsets were compared", () => {
    report(`offsets: ${fixture.offset_sequences.length} sequences, ${steps} offsets, largest difference ${largest.toExponential(2)} rad`);
    expect(steps).toBeGreaterThan(100);
  });

  test("it is the feedforward the SO-101's driver takes", async () => {
    const sent: number[][] = [];
    const hardware: ArmHardware = {
      read: async () => ({ position: [], velocity: [], sampledMonotonicS: 0, sampleId: 0, servoStatus: {} }),
      readForRecovery: async () => ({ position: [], velocity: [], sampledMonotonicS: 0, sampleId: 0, servoStatus: {} }),
      send: async (target) => {
        sent.push([...target]);
      },
      close: async () => undefined,
    };
    const section: FeedforwardConfig = {
      gravity_compliance: [0.0, 0.08, 0.1, 0.05, 0.0],
      friction_offset_rad: [0.006, 0.016, 0.016, 0.008, 0.006],
      friction_load_ratio: [0.0, 0.0, 0.0, 0.0, 0.0],
    };
    const feedforward = new Feedforward(section);
    let now = 100.0;
    const driver = new SO101Driver(hardware, JointLimits.fromConfig(SO101_DEFAULT_CONFIG), feedforward, { monotonic: () => now });
    const target = [0.1, -0.5, 0.6, 0.4, 0.2, 0.5];

    await driver.send({ arm: target });
    const gravity = new Feedforward(section).holdOffset(target);
    expect(sent[0]).toEqual(target.map((value, index) => value + gravity[index]!));
    expect(driver.telemetry().feedforward).toEqual(gravity.slice(0, GRIPPER_INDEX));

    // a move adds the friction's offset along the planned velocity, which ramps in over the engage time
    for (let tick = 0; tick < 6; tick++) {
      now += 0.02;
      await driver.send({ arm: target }, { arm: [0.3, 0.3, -0.3, 0.0, 0.0, 0.0] });
    }
    const moving = sent[sent.length - 1]!;
    expect(moving[1]! - target[1]! - gravity[1]!).toBeCloseTo(0.016, 12);
    expect(moving[2]! - target[2]! - gravity[2]!).toBeCloseTo(-0.016, 12);
    expect(moving[GRIPPER_INDEX]).toBe(target[GRIPPER_INDEX]);
  });
});
