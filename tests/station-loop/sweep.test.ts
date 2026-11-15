// What a caller's call does when it lands anywhere in a control period.
//
// tests/station-loop/interleaving.test.ts puts a call where a period awaits its driver. A period also yields where it
// awaits something that is already done (the end of one of its own asynchronous methods), and a caller whose own
// wait ends just then runs there. This file lands a call at every such turn: the period's first call of the driver
// is let through, and the caller's call is made a number of turns of the microtask queue later, for every number
// until the period is over. The stand-in drivers answer without waiting for anything outside, so a whole period runs
// in one row of microtasks, and counting them reaches every place of it where other code can run.
//
// Required of every landing: what the call gave, the loop's whole state some periods later and every call of the
// driver are what one of PEAR's two orders gives on a loop of its own (the call before the period, or after it);
// and, where the two orders differ, that the landings turn from the first to the second once and never back.
//
// `snapshot` is not among the calls: it shows the loop as it is at its instant, which between a period's reading and
// its command is neither order (interleaving.test.ts has the test of that; docs/progress/loop.md, deliberate
// differences).

import { describe, expect, test } from "vitest";

import { ActionGuard } from "../../src/station/joint/action_guard";
import { SnapshotCheck, type ObservationReference } from "../../src/station/joint/snapshot_checks";
import { JointMove } from "../../src/station/joint/trajectory";
import type { Outcome } from "./fixtures";
import { GatedRig, settle, startCall, type RigOptions, type Started } from "./gated";

/** The state a control period starts in, on a new loop. */
interface Scene {
  name: string;
  rig?: RigOptions;
  /** Brings the loop to that state; may return a call that still waits (a recovery). */
  prepare?: (rig: GatedRig) => Promise<Started | void>;
  /** Arranges the arm for the period (a stale reading). */
  arrange?: (rig: GatedRig) => void;
  /** Puts the arm back after the period. */
  restore?: (rig: GatedRig) => void;
  /** Whether the period itself begins a new generation: it brakes the operation, or it faults. */
  turnsItself?: boolean;
}

/** A caller's call, by the name the test shows. */
type Call = readonly [name: string, call: (rig: GatedRig) => unknown];

/** What a call gave, and what the loop did then. */
interface Landing {
  outcome: Outcome;
  /** Of the call that was waiting when the period began, if there was one. */
  waiting: Outcome | null;
  state: unknown;
  calls: unknown[];
}

/** The most control periods a scene steps while it looks for one. */
const MOST_PERIODS = 2000;
/** The most turns of the microtask queue a control period may take here. */
const MOST_TURNS = 1000;
/** The control periods stepped after the period of the call. */
const PERIODS_AFTER = 3;

/** What a caller keeps from before the period, for each loop: an observation and its action's guard. */
const kept = new WeakMap<GatedRig, { observation: ObservationReference; guard: ActionGuard }>();

/** Makes a new loop in the scene's state, with the period's arrangement made. */
async function make(scene: Scene): Promise<{ rig: GatedRig; waiting: Started | null }> {
  const rig =
    scene.rig?.kind === "so101" ? ((await GatedRig.makeSO101()) as unknown as GatedRig) : await GatedRig.make(scene.rig);
  rig.parkSleeps();
  const waiting = (await scene.prepare?.(rig)) ?? null;
  const snapshot = rig.loop.snapshot();
  kept.set(rig, {
    observation: { joint_positions: SnapshotCheck.stateVector(snapshot), control_snapshot: snapshot },
    guard: new ActionGuard(rig.loop),
  });
  rig.driver.calls.length = 0;
  scene.arrange?.(rig);

  return { rig, waiting };
}

/** Lets the waiting callers go on, steps some periods and returns what the call gave and what the loop did. */
async function finish(rig: GatedRig, started: Started, waiting: Started | null): Promise<Landing> {
  await rig.resumeSleeps();
  const outcome = await started.outcome;
  const waitingOutcome = waiting === null ? null : await waiting.outcome;
  await rig.tick(PERIODS_AFTER);

  return { outcome, waiting: waitingOutcome, state: rig.state(), calls: rig.driver.calls };
}

/** One of PEAR's two orders: the call before the period, or the period before the call. */
async function inOrder(scene: Scene, call: Call[1], order: "before" | "after"): Promise<Landing> {
  const { rig, waiting } = await make(scene);
  rig.clock.now += rig.periodS;
  let started: Started;
  if (order === "before") {
    started = startCall(() => call(rig));
    await rig.loop.step();
    scene.restore?.(rig);
  } else {
    await rig.loop.step();
    scene.restore?.(rig);
    started = startCall(() => call(rig));
  }

  return finish(rig, started, waiting);
}

/**
 * Makes the call `turns` turns of the microtask queue after the period's first call of the driver was let through,
 * and returns what it gave; null if the period was over by then.
 */
async function landed(scene: Scene, call: Call[1], turns: number): Promise<Landing | null> {
  const { rig, waiting } = await make(scene);
  const step = rig.begin();
  await settle();
  const gate = rig.driver.waiting.shift();
  if (gate === undefined) {
    throw new Error("The period makes no call of its driver");
  }
  // (the rest of the period is not held up: it runs through in microtasks, among which the call lands)
  rig.driver.isGated = false;
  let isOver = false;
  const ended = step.then(() => {
    isOver = true;
  });
  let started: Started | null = null;
  let wasInPeriod = false;
  const hop = (left: number): void => {
    if (left > 0) {
      queueMicrotask(() => hop(left - 1));
      return;
    }
    wasInPeriod = !isOver;
    started = startCall(() => call(rig));
  };

  gate.open();
  hop(turns);
  await ended;
  for (let waits = 0; started === null; waits++) {
    if (waits > MOST_TURNS) {
      throw new Error("The call was never made");
    }
    await settle();
  }
  if (!wasInPeriod) {
    return null;
  }
  scene.restore?.(rig);

  return finish(rig, started, waiting);
}

/** What a sweep found: how many turns the period had, and at which the landings turned from "before" to "after". */
interface Sweep {
  turns: number;
  /** Whether PEAR's two orders give different things. */
  differ: boolean;
  /** The first turn whose landing is what "after" gives and not what "before" gives; null: none. */
  turnedAt: number | null;
  /** The turns whose landing is neither order's, each with what it gave. */
  neither: { turn: number; landing: Landing }[];
  before: Landing;
  after: Landing;
}

const same = (first: Landing, second: Landing): boolean => JSON.stringify(first) === JSON.stringify(second);

/** Lands the call at every turn of the period and sorts the landings by the order they are like. */
async function sweep(scene: Scene, call: Call[1]): Promise<Sweep> {
  const before = await inOrder(scene, call, "before");
  const after = await inOrder(scene, call, "after");
  const found: Sweep = { turns: 0, differ: !same(before, after), turnedAt: null, neither: [], before, after };

  for (let turn = 0; ; turn++) {
    if (turn > MOST_TURNS) {
      throw new Error(`The period is not over after ${MOST_TURNS} turns`);
    }
    const landing = await landed(scene, call, turn);
    if (landing === null) {
      found.turns = turn;
      return found;
    }

    const isBefore = same(landing, before);
    const isAfter = same(landing, after);
    if (!isBefore && !isAfter) {
      found.neither.push({ turn, landing });
    } else if (found.differ) {
      if (isAfter && found.turnedAt === null) {
        found.turnedAt = turn;
      }
      if (isBefore && found.turnedAt !== null) {
        throw new Error(`Turn ${turn} is like "before" again, after turn ${found.turnedAt} was like "after"`);
      }
    }
  }
}

/** Requires every landing of the call in the scene to be what one of PEAR's two orders gives. */
async function expectOneOfTheOrders(scene: Scene, call: Call[1]): Promise<Sweep> {
  const found = await sweep(scene, call);
  if (found.neither.length > 0) {
    const first = found.neither[0]!;
    // (shown as vitest shows a difference: the landing against the order it is nearer to)
    const nearer = same({ ...first.landing, outcome: found.after.outcome }, found.after) ? found.after : found.before;
    expect(first.landing, `turn ${first.turn} of ${found.turns}; turns that are neither order: ${found.neither.map(({ turn }) => turn).join(", ")}`).toEqual(nearer);
  }
  // the period was swept: it has turns, and every one of them was a landing
  expect(found.turns).toBeGreaterThan(3);

  return found;
}

/**
 * The one call of the sweep that is not one of PEAR's two orders, where a period turns the generation itself.
 *
 * PEAR's guard checks, calls the loop's method and adopts the generation it began under one lock. `stop` waits for a
 * period that is under way, so the guard's check and its stop are apart here: while such a period still reads, the
 * check passes on the loop as it was before the period, the stop follows the period, finds its operation braked or
 * faulted already and does nothing, and the guard adopts the generation of the loop's own stop or fault. What the
 * call gives is what PEAR's gives before the period; what the loop then does is what PEAR's does after it. The
 * guard's next check throws a fault; of a stop for the operator's cancellation or for the operation's time it does
 * not learn. In PEAR only a maintenance command of the two-arm robot stops through a guard.
 */
const GUARDED_STOP = "a stop through the action's guard";

/** Requires the stop through a guard to be as described above, at the period's first turns and at no later one. */
async function expectStopOfGuardToFollowThePeriod(scene: Scene, call: Call[1]): Promise<void> {
  const found = await sweep(scene, call);

  // before the period the check passes and the stop takes effect; after it the check throws
  expect(found.differ).toBe(true);
  expect("ok" in found.before.outcome).toBe(true);
  expect("error" in found.after.outcome).toBe(true);
  expect(found.neither.length).toBeGreaterThan(0);
  for (const { landing } of found.neither) {
    expect(landing.outcome).toEqual(found.before.outcome);
    expect({ ...landing, outcome: found.after.outcome }).toEqual(found.after);
  }
  // they are the period's first turns, while it reads: once it has braked or faulted, the guard's check throws
  expect(found.neither.map(({ turn }) => turn)).toEqual(found.neither.map((_, index) => index));
  expect(found.neither.length).toBeLessThan(found.turns);
}

// -- the scenes

/** Starts a move of the first joint and steps `periods` control periods of it. */
async function moving(rig: GatedRig, periods = 4, delta = 0.3): Promise<void> {
  rig.loop.move(rig.jogged(delta));
  await rig.tick(periods);
}

/** Steps until `isThere`, and returns the control periods it took. */
async function periodsUntil(rig: GatedRig, isThere: () => boolean): Promise<number> {
  let periods = 0;
  while (!isThere()) {
    if (periods >= MOST_PERIODS) {
      throw new Error(`Not there after ${MOST_PERIODS} control periods (the loop is ${rig.loop.status})`);
    }
    await rig.tick();
    periods += 1;
  }

  return periods;
}

const counted = new Map<string, Promise<number[]>>();

/** Returns the period counts a scene needs, measured once for each key on a loop of its own. */
function counts(key: string, measure: () => Promise<number[]>): Promise<number[]> {
  let measured = counted.get(key);
  if (measured === undefined) {
    measured = measure();
    counted.set(key, measured);
  }

  return measured;
}

/** Faults the loop and starts a recovery whose caller sleeps; with `displacement`, a load holds the arm off its targets. */
async function recovery(rig: GatedRig, displacement: number | null): Promise<Started> {
  await rig.faultByStaleFeedback();
  if (displacement !== null) {
    const arm = rig.layout.arms[0] as string;
    const position = [...(rig.driver.inner.positions[arm] as readonly number[])];
    position[0]! += displacement;
    rig.driver.inner.positions = { ...rig.driver.inner.positions, [arm]: position };
    rig.driver.inner.isFollowing = false;
  }
  const started = startCall(() => rig.loop.recover({ timeoutS: 30.0 }));
  await settle();

  return started;
}

/**
 * Returns, for a recovery on the scene's rig, the control periods until its phase is no longer the first, until it
 * is the last, and until the loop holds again.
 */
function recoveryPeriods(rig: RigOptions, displacement: number | null): Promise<number[]> {
  return counts(`recovery ${JSON.stringify(rig)} ${displacement}`, async () => {
    const probe = await GatedRig.make(rig);
    probe.parkSleeps();
    const started = await recovery(probe, displacement);
    const phase = (): string | undefined => probe.loop.snapshot().recovery?.phase;
    const checked = await periodsUntil(probe, () => phase() !== "Checking stability");
    const verifying = checked + (await periodsUntil(probe, () => phase() !== "Releasing old target"));
    const held = verifying + (await periodsUntil(probe, () => probe.loop.status !== "FAULT"));
    await probe.resumeSleeps();
    const outcome = await started.outcome;
    if (!("ok" in outcome)) {
      throw new Error(`The recovery of the probe failed: ${JSON.stringify(outcome)}`);
    }

    return [checked, verifying, held];
  });
}

/** The scenes of a generic loop on the driver in memory, at a station of the fixtures. */
function scenesOf(station: string): Scene[] {
  const rig: RigOptions = { station };
  const releasing: RigOptions = { station, recovery: "ReleaseRecovery" };
  const stale: Pick<Scene, "arrange" | "restore"> = {
    arrange: (r) => r.setStale(true),
    restore: (r) => r.setStale(false),
  };
  /** A recovery stepped to the period before the one a scene is about. */
  const recovering =
    (options: RigOptions, displacement: number | null, at: (periods: number[]) => number) =>
    async (r: GatedRig): Promise<Started> => {
      const periods = await recoveryPeriods(options, displacement);
      const started = await recovery(r, displacement);
      await r.tick(at(periods) - 1);

      return started;
    };

  return [
    { name: "a HOLD", rig },
    {
      name: "a HOLD whose reading unsettles it",
      rig,
      arrange: (r) => {
        r.driver.inner.velocity = 5.0;
      },
      restore: (r) => {
        r.driver.inner.velocity = 0.0;
      },
    },
    { name: "a HOLD whose reading is stale: the period faults", rig, ...stale, turnsItself: true },
    { name: "a move under way", rig, prepare: (r) => moving(r) },
    {
      name: "the period that ends a move",
      rig,
      prepare: async (r) => {
        const [periods] = await counts(`move ${station}`, async () => {
          const probe = await GatedRig.make(rig);
          probe.loop.move(probe.jogged(0.02));
          return [await periodsUntil(probe, () => probe.loop.status === "HOLD")];
        });
        r.loop.move(r.jogged(0.02));
        await r.tick(periods! - 1);
      },
    },
    {
      name: "the period that brakes for a cancellation",
      rig,
      prepare: async (r) => {
        await moving(r);
        r.loop.attachCancellation({ aborted: true });
      },
      turnsItself: true,
    },
    {
      name: "the period in which a move's time is up",
      rig,
      prepare: (r) => moving(r),
      arrange: (r) => {
        r.clock.now += 1000.0;
      },
      turnsItself: true,
    },
    {
      name: "a controlled stop under way",
      rig,
      prepare: async (r) => {
        await moving(r);
        await r.loop.stop();
        await r.tick(2);
      },
    },
    { name: "a move whose period's reading is stale: the period faults", rig, prepare: (r) => moving(r), ...stale, turnsItself: true },
    { name: "a FAULT", rig, prepare: (r) => r.faultByStaleFeedback() },
    { name: "a recovery that checks stability", rig, prepare: recovering(rig, null, () => 3) },
    { name: "the period of a recovery that commands the measured pose as the hold", rig, prepare: recovering(rig, null, ([checked]) => checked!) },
    { name: "a recovery that verifies its hold", rig, prepare: recovering(rig, null, ([checked]) => checked! + 2) },
    { name: "the period that ends a recovery in a HOLD", rig, prepare: recovering(rig, null, ([, , held]) => held!) },
    { name: "the period of a release that plans it and commands its first sample", rig: releasing, prepare: recovering(releasing, 0.01, ([checked]) => checked!) },
    { name: "a release under way", rig: releasing, prepare: recovering(releasing, 0.01, ([checked]) => checked! + 2) },
    { name: "the last period of a release", rig: releasing, prepare: recovering(releasing, 0.01, ([, verifying]) => verifying!) },
    { name: "the period that ends a release's recovery in a HOLD", rig: releasing, prepare: recovering(releasing, 0.01, ([, , held]) => held!) },
  ];
}

/** The scenes of the SO-101's own loop on its own driver over the stand-in arm. */
function scenesOfTheSO101(): Scene[] {
  const rig: RigOptions = { kind: "so101" };
  const closing = async (r: GatedRig, periods: number): Promise<void> => {
    r.loop.beginGrippers(false);
    await r.tick(periods);
  };

  return [
    { name: "a HOLD", rig },
    { name: "a jaw that closes", rig, prepare: (r) => closing(r, 3) },
    {
      name: "the period that ends the jaw's operation",
      rig,
      prepare: async (r) => {
        const [periods] = await counts("jaw", async () => {
          const probe = (await GatedRig.makeSO101()) as unknown as GatedRig;
          probe.loop.beginGrippers(false);
          return [await periodsUntil(probe, () => probe.loop.status === "HOLD")];
        });
        await closing(r, periods! - 1);
      },
    },
    {
      name: "a HOLD whose reading is stale: the period faults",
      rig,
      arrange: (r) => r.setStale(true),
      restore: (r) => r.setStale(false),
      turnsItself: true,
    },
  ];
}

// -- the calls

const CALLS: Call[] = [
  ["a move", (r) => r.loop.move(r.jogged(0.05))],
  [
    "a checked move bound to an observation, through the action's guard",
    (r) => {
      const { observation, guard } = kept.get(r)!;
      const start = r.loop.trajectory.input.currentPosition;
      const goal = start.map((value, index) => (index === 0 ? value + 0.1 : value));
      const move = JointMove.build(start, goal, r.loop.limits, r.loop.layout);
      const isStarted = guard.submit(() => r.loop.dispatchJointMove(move, observation));

      return [isStarted, guard.hasDispatched, guard.generation === r.loop.generation];
    },
  ],
  [
    "a sequence bound to an observation",
    (r) => {
      const held = r.layout.join(r.loop.targets);
      const rows = [0.01, 0.02, 0.03].map((delta) => held.map((value, index) => (index === 0 ? value + delta : value)));

      return r.loop.startSequence(rows, { rateHz: 25.0, observation: kept.get(r)!.observation });
    },
  ],
  ["a cancellation that is set, attached", (r) => r.loop.attachCancellation({ aborted: true })],
  ["a check of the guard of an action that began before the period", (r) => kept.get(r)!.guard.check()],
  ["the stability history", (r) => r.loop.stability()],
  ["a check of an observation's reference", (r) => r.loop.verifyReference(kept.get(r)!.observation)],
  ["the requested position", (r) => r.loop.requestedPosition()],
  ["a stop", (r) => r.loop.stop()],
  [GUARDED_STOP, (r) => kept.get(r)!.guard.submit(() => r.loop.stop())],
  ["a recovery", (r) => r.loop.recover()],
  ["a wait for the hold, of no time", (r) => r.loop.waitForHold(0)],
  ["a close", (r) => r.loop.close()],
  ["a shutdown", (r) => r.loop.shutdown()],
];

const GRIPPER_CALLS: Call[] = [
  ["a gripper operation", (r) => r.loop.beginGrippers(false).constructor.name],
  [
    "a gripper operation through the action's guard",
    (r) => {
      const { guard } = kept.get(r)!;
      const operation = guard.submit((opens: boolean) => r.loop.beginGrippers(opens), true);

      return [operation.constructor.name, guard.hasDispatched, guard.generation === r.loop.generation];
    },
  ],
];

describe.each(["so101_station", "two_arm"])("a call that lands at any turn of a control period (%s)", (station) => {
  describe.each(scenesOf(station))("$name", (scene) => {
    test.each(CALLS)("%s", async (name, call) => {
      if (scene.turnsItself && name === GUARDED_STOP) {
        await expectStopOfGuardToFollowThePeriod(scene, call);
      } else {
        await expectOneOfTheOrders(scene, call);
      }
    });
  });
});

describe("a call that lands at any turn of a control period (the SO-101's loop on its own driver)", () => {
  describe.each(scenesOfTheSO101())("$name", (scene) => {
    test.each([...GRIPPER_CALLS, ...CALLS])("%s", async (name, call) => {
      if (scene.turnsItself && name === GUARDED_STOP) {
        await expectStopOfGuardToFollowThePeriod(scene, call);
      } else {
        await expectOneOfTheOrders(scene, call);
      }
    });
  });
});

describe("the sweep itself", () => {
  const hold: Scene = { name: "a HOLD", rig: { station: "so101_station" } };

  test("a move that lands while a period of a HOLD is under way is begun before it at first and after it at last", async () => {
    const found = await sweep(hold, (r) => r.loop.move(r.jogged(0.05)));

    expect(found.differ).toBe(true);
    expect(found.neither).toEqual([]);
    // the landings turn once: the first ones are like "before" (turn 0 is the period's reading), the last "after"
    expect(found.turnedAt).toBeGreaterThan(0);
    expect(found.turnedAt).toBeLessThan(found.turns);
  });

  test("a snapshot is neither order's between a moving period's reading and its command", async () => {
    // what the sweep finds of a call that PEAR's lock makes atomic and pear.js does not: the deliberate difference
    const scene: Scene = { name: "a move under way", rig: { station: "so101_station" }, prepare: (r) => moving(r) };
    const found = await sweep(scene, (r) => {
      const { status, generation, targets, arms } = r.loop.snapshot();
      const arm = r.layout.arms[0] as string;
      return { status, generation, targets, sample: arms[arm]!.sample_id };
    });

    expect(found.differ).toBe(true);
    expect(found.neither.length).toBeGreaterThan(0);
    for (const { landing } of found.neither) {
      // the reading is the period's, as after it; the targets are still the ones of before it
      const shown = (landing.outcome as { ok: { targets: unknown; sample: number } }).ok;
      expect(shown.sample).toBe((found.after.outcome as { ok: { sample: number } }).ok.sample);
      expect(shown.targets).toEqual((found.before.outcome as { ok: { targets: unknown } }).ok.targets);
    }
  });
});
