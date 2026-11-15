// What a reader of the control loop can change: nothing the loop holds.
//
// PEAR holds every arm's targets and every reading's position and velocity as tuples, so a snapshot, a driver, an
// operation and a recovery policy are handed the loop's own vectors and none of them can write into one
// (`TypeError: 'tuple' object does not support item assignment`). Here a tuple is a frozen array
// (`tupleOf`, src/station/joint/arm_state.ts): a write throws a TypeError too, and the loop holds what it held.
//
// These are expectations written by hand, not records of PEAR: PEAR's own script cannot write into a tuple, so no
// record holds what such a write would do (tools/fixtures/loop_fixtures.py, `mutate_snapshot`, changes the two parts
// of a snapshot that both sides copy).

import { describe, expect, test } from "vitest";

import { ArmState, tupleOf } from "../../src/station/joint/arm_state";
import type { ControlFeedback, JointControlLoop } from "../../src/station/joint/control_loop";
import type { ArmVectors } from "../../src/station/joint/driver";
import type { ArmStates, ArmTargets } from "../../src/station/joint/operations";
import { ControlState } from "../../src/station/schemas";
import { GatedRig } from "./gated";

/** Writes into `vector` as a reader does that the compiler's `readonly` does not stop (a page's script, a cast). */
function write(vector: readonly number[], index = 0, delta = 0.03): void {
  (vector as number[])[index]! += delta;
}

/** The first arm's name. */
function armOf(rig: { layout: { arms: readonly string[] } }): string {
  return rig.layout.arms[0] as string;
}

/** Every vector the loop hands out without a copy: its targets and readings, directly and through a snapshot. */
function vectorsOf(loop: JointControlLoop<ArmState>): Record<string, readonly number[]> {
  const snapshot = loop.snapshot();
  const vectors: Record<string, readonly number[]> = {};
  for (const arm of loop.layout.arms) {
    vectors[`loop.targets.${arm}`] = loop.targets[arm] as readonly number[];
    vectors[`loop.states.${arm}.position`] = loop.states[arm]!.position;
    vectors[`loop.states.${arm}.velocity`] = loop.states[arm]!.velocity;
    vectors[`snapshot.targets.${arm}`] = snapshot.targets[arm] as readonly number[];
    vectors[`snapshot.arms.${arm}.position`] = snapshot.arms[arm]!.position;
    vectors[`snapshot.arms.${arm}.velocity`] = snapshot.arms[arm]!.velocity;
  }

  return vectors;
}

/** The names of the vectors of `vectorsOf` that a reader could write into. */
function writable(loop: JointControlLoop<ArmState>): string[] {
  return Object.entries(vectorsOf(loop))
    .filter(([, vector]) => !Object.isFrozen(vector))
    .map(([name]) => name);
}

/** Records, for every command the driver of `rig` is handed from now on, whether a vector of it could be written. */
function watchDriver(rig: GatedRig): { commands: number; writable: string[] } {
  const seen = { commands: 0, writable: [] as string[] };
  const inner = rig.driver.inner;
  const send = inner.send.bind(inner);
  const refreshHold = inner.refreshHold.bind(inner);
  const look = (method: string, targets: ArmVectors): void => {
    seen.commands += 1;
    for (const [arm, vector] of Object.entries(targets)) {
      if (!Object.isFrozen(vector)) {
        seen.writable.push(`${method} ${arm} at command ${seen.commands}`);
      }
    }
  };
  inner.send = async (targets, velocities = null) => {
    look("send", targets);
    await send(targets, velocities);
  };
  inner.refreshHold = async (targets) => {
    look("refreshHold", targets);
    await refreshHold(targets);
  };

  return seen;
}

describe("a snapshot's reader", () => {
  test("a write into a snapshot's targets throws, and the loop holds and renews what it held", async () => {
    // (the audit's first scratch test: before the targets were tuples the write moved the hold by 0.03 rad, and the
    // next control period handed the moved target to the driver, in a HOLD and without a fault)
    const rig = await GatedRig.make();
    const arm = armOf(rig);
    const held = [...(rig.loop.targets[arm] as readonly number[])];
    let renewed: number[] | null = null;
    rig.driver.inner.refreshHold = async (targets) => {
      renewed = [...(targets[arm] as readonly number[])];
    };

    const snapshot = rig.loop.snapshot();
    expect(() => write(snapshot.targets[arm] as readonly number[])).toThrow(TypeError);
    expect(snapshot.targets[arm]).toEqual(held);
    expect(rig.loop.targets[arm]).toEqual(held);

    await rig.tick();
    expect(renewed).toEqual(held);
    expect(rig.loop.status).toBe(ControlState.HOLD);
    expect(rig.loop.fault).toBeNull();
    expect(rig.loop.snapshot().targets[arm]).toEqual(held);
  });

  test("a write into a snapshot's reading throws, and the loop's reading is what it was", async () => {
    const rig = await GatedRig.make();
    const arm = armOf(rig);
    const position = [...rig.loop.states[arm]!.position];
    const velocity = [...rig.loop.states[arm]!.velocity];

    const snapshot = rig.loop.snapshot();
    expect(() => write(snapshot.arms[arm]!.position, 1, 1.0)).toThrow(TypeError);
    expect(() => write(snapshot.arms[arm]!.velocity, 0, 1.0)).toThrow(TypeError);
    expect(rig.loop.states[arm]!.position).toEqual(position);
    expect(rig.loop.states[arm]!.velocity).toEqual(velocity);
    expect(rig.loop.snapshot().arms[arm]!.position).toEqual(position);
    expect(rig.loop.snapshot().arms[arm]!.velocity).toEqual(velocity);
  });

  test("a snapshot's own record of targets is the reader's: replacing an arm's entry changes no other snapshot", async () => {
    // (PEAR's snapshot holds a new dict of the loop's tuples: the dict is the reader's, the tuples are not)
    const rig = await GatedRig.make();
    const arm = armOf(rig);
    const held = [...(rig.loop.targets[arm] as readonly number[])];

    const snapshot = rig.loop.snapshot();
    (snapshot.targets as Record<string, readonly number[]>)[arm] = held.map((value) => value + 1);
    expect(rig.loop.targets[arm]).toEqual(held);
    expect(rig.loop.snapshot().targets[arm]).toEqual(held);
  });

  test("the joint vector an operation heads for is a new one at every call", async () => {
    const rig = await GatedRig.make();
    const requested = rig.loop.requestedPosition();
    const before = [...requested];
    requested[0]! += 0.5;

    expect(rig.loop.requestedPosition()).toEqual(before);
    expect(rig.loop.trajectory.input.targetPosition).toEqual(before);
    expect(rig.loop.snapshot().arrival.signed_error.every((error) => error === 0)).toBe(true);
  });
});

describe("the loop's own properties", () => {
  test("a write into the loop's targets or into a reading of its states throws", async () => {
    const rig = await GatedRig.make();
    const arm = armOf(rig);
    const held = [...(rig.loop.targets[arm] as readonly number[])];
    const position = [...rig.loop.states[arm]!.position];
    const velocity = [...rig.loop.states[arm]!.velocity];

    expect(() => write(rig.loop.targets[arm] as readonly number[])).toThrow(TypeError);
    expect(() => write(rig.loop.states[arm]!.position)).toThrow(TypeError);
    expect(() => write(rig.loop.states[arm]!.velocity)).toThrow(TypeError);
    expect(rig.loop.targets[arm]).toEqual(held);
    expect(rig.loop.states[arm]!.position).toEqual(position);
    expect(rig.loop.states[arm]!.velocity).toEqual(velocity);
  });

  for (const recovery of ["MeasuredHoldRecovery", "ReleaseRecovery"] as const) {
    test(`through a move, a stop, a fault and a recovery every vector handed out is a tuple (${recovery})`, async () => {
      // the targets are made anew in four places: at the first hold, at every sample of a motion, at a fault (the
      // operation's and the policy's) and at a recovery's new hold
      const rig = await GatedRig.make({ recovery });
      const arm = armOf(rig);
      const driver = watchDriver(rig);
      const seen: string[] = [];
      const look = (when: string): void => {
        seen.push(...writable(rig.loop).map((name) => `${when}: ${name}`));
      };

      look("first hold");
      await rig.tick(2);
      look("hold");

      rig.loop.move(rig.jogged(0.2));
      for (let period = 0; period < 5; period++) {
        await rig.tick();
        look(`moving ${period}`);
      }
      expect(rig.loop.status).toBe(ControlState.RUNNING);
      await rig.loop.stop();
      await rig.tick();
      look("stopping");
      await rig.until(ControlState.HOLD);
      look("hold after the stop");

      // a load holds the arm off its targets, then a command fails: the fault's hold is the policy's
      rig.loop.move(rig.jogged(0.2));
      await rig.tick(3);
      rig.driver.inner.isFollowing = false;
      rig.driver.failures.send = new Error("bus write failed");
      await rig.tick();
      expect(rig.loop.status).toBe(ControlState.FAULT);
      look("fault");
      await rig.tick(2);
      look("in fault");

      await rig.resumeSleeps();
      const recovered = await rig.loop.recover();
      expect(recovered.status).toBe(ControlState.HOLD);
      look("recovered");
      expect(Object.isFrozen(recovered.targets[arm])).toBe(true);
      await rig.tick(2);
      look("hold after the recovery");

      expect(seen).toEqual([]);
      expect(driver.commands).toBeGreaterThan(20);
      expect(driver.writable).toEqual([]);
    });
  }

  test("the SO-101's loop, its driver and a jaw's operation: every vector handed out is a tuple", async () => {
    const rig = await GatedRig.makeSO101();
    const seen: string[] = [];
    const look = (when: string): void => {
      seen.push(...writable(rig.loop).map((name) => `${when}: ${name}`));
    };

    look("first hold");
    for (const opens of [true, false]) {
      rig.loop.beginGrippers(opens);
      for (let period = 0; rig.loop.status !== ControlState.HOLD; period++) {
        expect(period).toBeLessThan(2000);
        await rig.tick();
        look(`jaw ${opens ? "opening" : "closing"} ${period}`);
      }
    }
    rig.loop.move(rig.jogged(0.1));
    await rig.until(ControlState.HOLD);
    look("after a move");
    await rig.faultByStaleFeedback();
    look("fault");

    expect(seen).toEqual([]);
  });
});

describe("what the loop hands on", () => {
  test("a driver that writes into the targets it is handed faults the period, and the hold is what it was", async () => {
    // (in PEAR the driver's write raises the TypeError inside the step, which latches it as the fault)
    const rig = await GatedRig.make();
    const arm = armOf(rig);
    const held = [...(rig.loop.targets[arm] as readonly number[])];
    rig.driver.inner.refreshHold = async (targets) => {
      write(targets[arm] as readonly number[]);
    };

    await rig.tick();
    expect(rig.loop.status).toBe(ControlState.FAULT);
    expect(rig.loop.targets[arm]).toEqual(held);
    // the fault's hold was commanded, with the targets as they were
    const last = rig.driver.inner.sent.at(-1) as [ArmVectors, ArmVectors | null];
    expect(last[0][arm]).toEqual(held);
    expect(last[1]).toBeNull();
  });

  test("an operation and a recovery policy are handed tuples", async () => {
    const rig = await GatedRig.make();
    const arm = armOf(rig);
    const handed: boolean[] = [];

    rig.loop.move(rig.jogged(0.2));
    const operation = rig.loop.operation!;
    const advance = operation.advance.bind(operation);
    operation.advance = (now: number, states: ArmStates, targets: ArmTargets) => {
      handed.push(
        Object.isFrozen(targets[arm]),
        Object.isFrozen(states[arm]!.position),
        Object.isFrozen(states[arm]!.velocity),
      );
      return advance(now, states, targets);
    };
    await rig.tick(3);
    expect(handed).toHaveLength(9);

    await rig.faultByStaleFeedback();
    const policy = rig.loop.recoveryPolicy;
    const step = policy.step.bind(policy);
    policy.step = async (controlLoop, request, feedback: ControlFeedback, isStable) => {
      handed.push(
        Object.isFrozen(feedback.targets[arm]),
        Object.isFrozen(feedback.arms[arm]!.position),
        Object.isFrozen(feedback.arms[arm]!.velocity),
      );
      await step(controlLoop, request, feedback, isStable);
    };
    await rig.resumeSleeps();
    await rig.loop.recover();
    expect(handed.length).toBeGreaterThan(12);
    expect(handed.every((isFrozen) => isFrozen)).toBe(true);
  });

  test("an operation's fault targets that are plain arrays become the loop's own tuples", async () => {
    // (ReleaseRecovery keeps the targets the operation gave: the loop holds a copy, and the operation's array stays
    // the operation's)
    const rig = await GatedRig.make({ recovery: "ReleaseRecovery" });
    const arm = armOf(rig);
    rig.loop.move(rig.jogged(0.2));
    await rig.tick(2);
    const own = [...(rig.loop.targets[arm] as readonly number[])];
    rig.loop.operation!.faultTargets = () => ({ [arm]: own });
    // the policy is asked next, with the loop holding the operation's targets: tuples then already
    const policy = rig.loop.recoveryPolicy;
    const faultTargets = policy.faultTargets.bind(policy);
    let policySawTuples: boolean | null = null;
    policy.faultTargets = (controlLoop) => {
      policySawTuples = Object.isFrozen(controlLoop.targets[arm]) && controlLoop.targets[arm] !== own;
      return faultTargets(controlLoop);
    };

    await rig.faultByStaleFeedback();
    expect(rig.loop.status).toBe(ControlState.FAULT);
    expect(policySawTuples).toBe(true);
    expect(rig.loop.targets[arm]).toEqual(own);
    expect(rig.loop.targets[arm]).not.toBe(own);
    expect(Object.isFrozen(rig.loop.targets[arm])).toBe(true);
    expect(Object.isFrozen(own)).toBe(false);
    const held = [...own];
    own[0]! += 0.03;
    expect(rig.loop.targets[arm]).toEqual(held);
  });

  test("a hold transferred from a caller's own array is a copy; tuples are taken as they are", async () => {
    const rig = await GatedRig.make();
    const arm = armOf(rig);
    const own = [...(rig.loop.targets[arm] as readonly number[])];

    await rig.loop.transferHold({ [arm]: own });
    expect(rig.loop.targets[arm]).toEqual(own);
    expect(rig.loop.targets[arm]).not.toBe(own);
    expect(Object.isFrozen(own)).toBe(false);
    const sent = (rig.driver.inner.sent.at(-1) as [ArmVectors, ArmVectors | null])[0];
    expect(sent[arm]).toBe(rig.loop.targets[arm]);
    const held = [...own];
    own[0]! += 0.03;
    expect(rig.loop.targets[arm]).toEqual(held);

    const tuples = { [arm]: tupleOf(held) };
    await rig.loop.transferHold(tuples);
    expect(rig.loop.targets).toBe(tuples);
    expect(rig.loop.targets[arm]).toBe(tuples[arm]);
  });
});

describe("a reading", () => {
  test("holds copies of the arrays it was made with, which no write reaches", () => {
    const position = [0.1, 0.2, 0.3];
    const velocity = [0.0, 0.0, 0.5];
    const state = new ArmState(position, velocity, 100.0, 7);

    position[0] = 9;
    velocity[2] = 9;
    expect(state.position).toEqual([0.1, 0.2, 0.3]);
    expect(state.velocity).toEqual([0.0, 0.0, 0.5]);
    expect(Object.isFrozen(position)).toBe(false);
    expect(() => write(state.position)).toThrow(TypeError);
    expect(() => write(state.velocity)).toThrow(TypeError);
    expect(() => (state.position as number[]).push(1)).toThrow(TypeError);
    const feedback = state.feedback(100.5);
    expect(feedback.position).toBe(state.position);
    expect(feedback.velocity).toBe(state.velocity);
  });

  test("takes a tuple as it is, and an array of doubles as plain numbers", () => {
    const tuple = tupleOf([0.1, 0.2]);
    expect(tupleOf(tuple)).toBe(tuple);
    expect(new ArmState(tuple, tuple, 100.0).position).toBe(tuple);

    const doubles = new Float64Array([0.25, 0.5]);
    const state = new ArmState(doubles as unknown as number[], doubles as unknown as number[], 100.0);
    expect(Array.isArray(state.position)).toBe(true);
    expect(state.position).toEqual([0.25, 0.5]);
    expect(Object.isFrozen(state.position)).toBe(true);
  });
});
