// What a caller's call does when it arrives while a control period is under way.
//
// PEAR's loop steps under a lock, and a caller's thread waits for it: every call falls either before a period or
// after it. In pear.js a call can arrive while a period awaits its driver. Each test here puts a call at one such
// await ("during") and requires what the loop then does (what the call gave, the loop's whole state some periods
// later, every call of the driver in order) to be what one of PEAR's two orders gives on a loop of its own: the call
// "before" the period, or "after" it. Where the two orders differ, the test also requires that they do, so that it
// cannot pass by comparing two things that are always the same.
//
// The asynchronous methods (stop, recover, waitForHold, shutdown, close, step) take the loop's lock, so they follow
// the period. The synchronous ones that begin an operation (move, dispatchJointMove, startSequence, beginGrippers)
// take effect at once: before the period when it has only read, and after it when its work is done.

import { describe, expect, test } from "vitest";

import { ActionGuard } from "../../src/station/joint/action_guard";
import { LoopLock } from "../../src/station/joint/control_loop";
import { OSError } from "../../src/python/errors";
import { SnapshotCheck, type ObservationReference } from "../../src/station/joint/snapshot_checks";
import { JointMove } from "../../src/station/joint/trajectory";
import type { ControlSnapshot } from "../../src/station/schemas";
import type { Outcome } from "./fixtures";
import { GatedRig, settle, startCall, type RigOptions, type Started } from "./gated";
import type { ProbedMethod } from "./standins";

type Order = "during" | "before" | "after";

interface Trial {
  rig?: RigOptions;
  /** Brings the loop to the state the period starts in; may return a call that still waits (a recovery). */
  prepare?: (rig: GatedRig) => Promise<Started | void>;
  /** Arranges the arm for the period (a stale reading, a call that will throw). */
  arrange?: (rig: GatedRig) => void;
  /** Puts the arm back after the period. */
  restore?: (rig: GatedRig) => void;
  /** The driver call of the period at which the caller's call arrives, and which one of them. */
  during: ProbedMethod;
  occurrence?: number;
  /** The caller's call. */
  call: (rig: GatedRig) => unknown;
  /** The control periods stepped afterwards. */
  after?: number;
}

interface TrialResult {
  outcome: Outcome;
  /** Of the call that was waiting when the period began, if there was one. */
  waiting: Outcome | null;
  state: unknown;
  calls: unknown[];
}

/** The most control periods a test steps while it looks for one (a loop that never gets there fails the test). */
const MOST_PERIODS = 2000;

/** Runs a trial on a new loop, with the caller's call at an await of the period, before the period or after it. */
async function run(trial: Trial, order: Order): Promise<TrialResult> {
  // (the SO-101's rig differs in the driver behind the gate, which only the trials of the driver in memory touch)
  const rig =
    trial.rig?.kind === "so101" ? ((await GatedRig.makeSO101()) as unknown as GatedRig) : await GatedRig.make(trial.rig);
  rig.parkSleeps();
  const waiting = (await trial.prepare?.(rig)) ?? null;
  rig.driver.calls.length = 0;
  trial.arrange?.(rig);

  let started: Started;
  if (order === "during") {
    const step = rig.begin();
    await rig.at(trial.during, trial.occurrence);
    started = startCall(() => trial.call(rig));
    await rig.drain(step);
    trial.restore?.(rig);
  } else if (order === "before") {
    rig.clock.now += rig.periodS;
    started = startCall(() => trial.call(rig));
    await rig.loop.step();
    trial.restore?.(rig);
  } else {
    rig.clock.now += rig.periodS;
    await rig.loop.step();
    trial.restore?.(rig);
    started = startCall(() => trial.call(rig));
  }
  await rig.resumeSleeps();
  const outcome = await started.outcome;
  const waitingOutcome = waiting === null ? null : await waiting.outcome;
  await rig.tick(trial.after ?? 3);

  return { outcome, waiting: waitingOutcome, state: rig.state(), calls: rig.driver.calls };
}

/** Requires the call during the period to give what `order` gives, and the two orders to differ if `differs`. */
async function expectAs(trial: Trial, order: "before" | "after", differs: boolean): Promise<TrialResult> {
  const during = await run(trial, "during");
  const expected = await run(trial, order);
  expect(during).toEqual(expected);

  const other = await run(trial, order === "before" ? "after" : "before");
  if (differs) {
    expect(other).not.toEqual(expected);
  } else {
    expect(other).toEqual(expected);
  }

  return during;
}

const STATIONS = ["so101_station", "two_arm"] as const;

/** Starts a move of the first joint and steps `periods` control periods of it. */
async function moving(rig: GatedRig, periods = 4, delta = 0.3): Promise<void> {
  rig.loop.move(rig.jogged(delta));
  await rig.tick(periods);
}

/** Returns how many control periods a move of the first joint by `delta` takes until its HOLD. */
async function periodsOfMove(options: RigOptions, delta: number): Promise<number> {
  const rig = await GatedRig.make(options);
  rig.loop.move(rig.jogged(delta));
  let periods = 0;
  while (rig.loop.status !== "HOLD") {
    if (periods >= MOST_PERIODS) {
      throw new Error(`The move is still ${rig.loop.status} after ${MOST_PERIODS} control periods`);
    }
    await rig.tick();
    periods += 1;
  }

  return periods;
}

/** What a caller keeps from before the period (taken in a trial's `prepare`, used by its `call`), for each loop. */
const kept = new WeakMap<GatedRig, { observation?: ObservationReference; guard?: ActionGuard }>();

/** An observation of the loop as it is now: its measured joints and the generation of its snapshot. */
function observed(rig: GatedRig): ObservationReference {
  const snapshot = rig.loop.snapshot();

  return { joint_positions: SnapshotCheck.stateVector(snapshot), control_snapshot: snapshot };
}

/** The first letter of a driver's call as the rig keeps it: "r", "R", "h", "s", "c", and with "!" if it threw. */
function code(call: unknown): unknown {
  return Array.isArray(call) ? call[0] : call;
}

describe("PEAR's lock for the blocks that hold an await", () => {
  test("a block starts at once when the lock is free, and blocks that arrive meanwhile run in their order", async () => {
    const lock = new LoopLock();
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = lock.run(async () => {
      order.push("first begins");
      await held;
      order.push("first ends");
      return 1;
    });
    // the first block ran up to its await inside the call itself
    expect(order).toEqual(["first begins"]);
    const second = lock.run(() => {
      order.push("second");
      return 2;
    });
    const third = lock.run(async () => {
      order.push("third");
      return 3;
    });
    await settle();
    expect(order).toEqual(["first begins"]);

    release();
    expect(await Promise.all([first, second, third])).toEqual([1, 2, 3]);
    expect(order).toEqual(["first begins", "first ends", "second", "third"]);
  });

  test("a block that throws or rejects frees the lock for the next, and its caller gets the error", async () => {
    const lock = new LoopLock();
    const thrown = lock.run(() => {
      throw new OSError("thrown");
    });
    const rejected = lock.run(async () => {
      await settle();
      throw new OSError("rejected");
    });
    const next = lock.run(() => "next");

    await expect(thrown).rejects.toThrow("thrown");
    await expect(rejected).rejects.toThrow("rejected");
    expect(await next).toBe("next");
    // and the lock is free again: a block runs inside the call
    let ran = false;
    void lock.run(() => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test("a block that arrives while the lock is handed over still runs after the block it was handed to", async () => {
    const lock = new LoopLock();
    const order: string[] = [];
    const first = lock.run(async () => {
      await settle();
      order.push("first");
    });
    const second = lock.run(async () => {
      order.push("second begins");
      await settle();
      order.push("second ends");
    });
    await first;
    // the lock was handed to the second block, which has not run yet: a block that arrives now must not go first
    const third = lock.run(() => {
      order.push("third");
    });
    await Promise.all([second, third]);

    expect(order).toEqual(["first", "second begins", "second ends", "third"]);
  });
});

describe.each(STATIONS)("a call that arrives during a control period in a HOLD (%s)", (station) => {
  const rig = { station };

  test("a move while the period reads is begun before the period, which sends its first sample", async () => {
    const result = await expectAs({ rig, during: "read", call: (r) => r.loop.move(r.jogged(0.1)) }, "before", true);

    expect(result.outcome).toEqual({ ok: null });
    // the period itself sent the first sample: a read, then a send with planned velocities, and no renewal of the hold
    expect(result.calls[0]).toBe("r");
    expect((result.calls[1] as unknown[])[0]).toBe("s");
    expect((result.calls[1] as unknown[])[2]).not.toBeNull();
  });

  test("a move while the period renews the hold is begun after the period, and starts with the next", async () => {
    const result = await expectAs(
      { rig, during: "refresh_hold", call: (r) => r.loop.move(r.jogged(0.1)) },
      "after",
      true,
    );

    expect(result.outcome).toEqual({ ok: null });
    // the period ended with the renewal; the first sample goes out in the next period
    expect(result.calls.slice(0, 3).map((call) => (Array.isArray(call) ? call[0] : call))).toEqual(["r", "h", "r"]);
  });

  test.each(["read", "refresh_hold"] as const)("a sequence while the period awaits %s", async (during) => {
    const call = (r: GatedRig): unknown => {
      const held = r.layout.join(r.loop.targets);
      const rows = [0.01, 0.02, 0.03].map((delta) => held.map((value, index) => (index === 0 ? value + delta : value)));
      return r.loop.startSequence(rows, { rateHz: 25.0 });
    };
    const result = await expectAs({ rig, during, call, after: 6 }, during === "read" ? "before" : "after", true);

    expect(result.outcome).toEqual({ ok: true });
  });

  test.each(["read", "refresh_hold"] as const)("a checked move through an action's guard while the period awaits %s", async (during) => {
    const cancellation = { aborted: false };
    const call = (r: GatedRig): unknown => {
      const start = r.loop.trajectory.input.currentPosition;
      const goal = start.map((value, index) => (index === 0 ? value + 0.1 : value));
      const move = JointMove.build(start, goal, r.loop.limits, r.loop.layout);
      const guard = new ActionGuard(r.loop, cancellation);
      const isStarted = guard.submit(() => r.loop.dispatchJointMove(move));

      return [isStarted, guard.hasDispatched, guard.generation === r.loop.generation, r.loop.operationCancellation === cancellation];
    };
    const result = await expectAs({ rig, during, call }, during === "read" ? "before" : "after", true);

    expect(result.outcome).toEqual({ ok: [true, true, true, true] });
  });

  test.each(["read", "refresh_hold"] as const)("a stop while the period awaits %s follows the period", async (during) => {
    // (in a HOLD a stop only advances the generation, on either side of a period)
    const result = await expectAs({ rig, during, call: (r) => r.loop.stop() }, "after", false);

    expect(result.outcome).toEqual({ ok: null });
    expect(result.calls.slice(0, 2)).toEqual(["r", "h"]);
  });

  test.each(["read", "refresh_hold"] as const)("a close while the period awaits %s follows the period", async (during) => {
    const result = await expectAs({ rig, during, call: (r) => r.loop.close() }, "after", true);

    expect(result.outcome).toEqual({ ok: null });
    // the period's own calls, then the close, and nothing after it
    expect(result.calls).toEqual(["r", "h", "c"]);
  });

  test("a move that was begun during the renewal of the hold, which then fails, is faulted with the hold", async () => {
    // PEAR's lock has no such instant: there the move waits for the period and is refused in FAULT. Here the move
    // was accepted when the renewal failed. What must hold: the fault latches, the operation is dropped, the hold is
    // commanded, and the caller's action learns of the fault at its next check.
    const during = await run(
      {
        rig,
        arrange: (r) => {
          r.driver.failures.refresh_hold = new OSError("bus write failed");
        },
        during: "refresh_hold",
        call: (r) => {
          const guard = new ActionGuard(r.loop);
          guard.submit(() => r.loop.move(r.jogged(0.1)));
          return guard;
        },
        after: 0,
      },
      "during",
    );
    const state = during.state as { snapshot: ControlSnapshot; loop: Record<string, unknown> };

    expect(state.snapshot.status).toBe("FAULT");
    expect(state.snapshot.fault).toBe("bus write failed");
    expect(state.loop["operation"]).toBeNull();
    expect(state.snapshot.motion.end_reason).toBe("fault");
    // the read, the renewal that threw, the fault's hold without velocities; no sample of the move was sent
    expect(during.calls.map((call) => (Array.isArray(call) ? call[0] : call))).toEqual(["r", "h!", "s"]);
    expect((during.calls[2] as unknown[])[2]).toBeNull();
  });

  test("a wait whose loop is closed before its reading learns it from its guard, under the lock", async () => {
    // PEAR's wait checks its guard and reads its snapshot under one lock. Here a close and then a wait arrive while
    // a period reads: the wait's own first check passes on the open loop, and its reading queues behind the close.
    // What tells the wait that the loop is closed is the guard's check inside the locked block, in PEAR's words
    const subject = await GatedRig.make(rig);
    subject.driver.calls.length = 0;
    const guard = new ActionGuard(subject.loop);
    const step = subject.begin();
    await subject.at("read");
    const closed = subject.loop.close();
    const waited = startCall(() => subject.loop.waitForHold(1.0, { guard }));
    await subject.drain(step, closed);

    expect(await waited.outcome).toEqual({
      error: { type: "RuntimeError", message: "Action interrupted: CLOSED: None" },
    });
    expect(subject.driver.calls).toEqual(["r", "h", "c"]);
  });

  test("two steps asked for at once run one after the other", async () => {
    const together = await GatedRig.make(rig);
    together.driver.calls.length = 0;
    together.clock.now += together.periodS;
    together.driver.isGated = true;
    const first = together.loop.step();
    const second = together.loop.step();
    await together.at("read");
    // only the first step has reached the driver
    expect(together.driver.waiting.length).toBe(1);
    await together.drain(first, second);

    const serial = await GatedRig.make(rig);
    serial.driver.calls.length = 0;
    serial.clock.now += serial.periodS;
    await serial.loop.step();
    await serial.loop.step();

    expect(together.driver.calls).toEqual(["r", "h", "r", "h"]);
    expect(together.driver.calls).toEqual(serial.driver.calls);
    expect(together.state()).toEqual(serial.state());
  });
});

describe.each(STATIONS)("a call that arrives during a control period of a move (%s)", (station) => {
  const rig = { station };
  const prepare = (r: GatedRig): Promise<void> => moving(r);

  test.each(["read", "send"] as const)("a stop while the period awaits %s follows the period's sample", async (during) => {
    const result = await expectAs({ rig, prepare, during, call: (r) => r.loop.stop(), after: 2 }, "after", true);

    expect(result.outcome).toEqual({ ok: null });
    expect((result.state as { snapshot: ControlSnapshot }).snapshot.status).toBe("STOPPING");
  });

  test.each(["read", "send"] as const)("a second move while the period awaits %s is refused as before it", async (during) => {
    // (a refused move changes nothing, on either side of a period that does not end the motion)
    const result = await expectAs({ rig, prepare, during, call: (r) => r.loop.move(r.jogged(0.05)) }, "before", false);

    expect(result.outcome).toEqual({ error: { type: "RuntimeError", message: "Cannot start a move in RUNNING" } });
  });

  test("a move while the period that ends the motion sends its last sample is refused, as before the period", async () => {
    const delta = 0.02;
    const periods = await periodsOfMove(rig, delta);
    const trial: Trial = {
      rig,
      prepare: async (r) => {
        r.loop.move(r.jogged(delta));
        await r.tick(periods - 1);
      },
      during: "send",
      call: (r) => r.loop.move(r.jogged(0.05)),
      after: 2,
    };
    const result = await expectAs(trial, "before", true);

    expect(result.outcome).toEqual({ error: { type: "RuntimeError", message: "Cannot start a move in RUNNING" } });
    expect((result.state as { snapshot: ControlSnapshot }).snapshot.status).toBe("HOLD");
    // after that period PEAR's caller, and pear.js's, starts the move
    expect((await run(trial, "after")).outcome).toEqual({ ok: null });
  });

  test.each(["read", "send"] as const)("a cancellation that is set, attached while the period awaits %s", async (during) => {
    // a period looks at the cancellation after its reading and before its command: attached while the period reads,
    // it brakes the move in that period, as before the period; attached while the period sends, in the next one
    const cancellation = { aborted: true };
    const result = await expectAs(
      { rig, prepare, during, call: (r) => r.loop.attachCancellation(cancellation), after: 2 },
      during === "read" ? "before" : "after",
      true,
    );

    expect((result.state as { snapshot: ControlSnapshot }).snapshot.motion.end_reason).toBe("cancelled");
  });

  test.each(["read", "send"] as const)("a close while the period awaits %s follows the period's sample", async (during) => {
    const result = await expectAs({ rig, prepare, during, call: (r) => r.loop.close() }, "after", true);

    expect(result.outcome).toEqual({ ok: null });
    expect(result.calls.map((call) => (Array.isArray(call) ? call[0] : call))).toEqual(["r", "s", "c"]);
  });

  test.each(["read", "send"] as const)("a wait for the hold that arrives while the period awaits %s reads the finished period", async (during) => {
    // a wait of no time makes one reading, whose whole snapshot is the text of its timeout
    const result = await expectAs(
      { rig, prepare, during, call: (r) => r.loop.waitForHold(0), after: 2 },
      "after",
      true,
    );

    expect("error" in result.outcome && result.outcome.error.type).toBe("TimeoutError");
    expect("error" in result.outcome && result.outcome.error.message).toMatch(/^Motion did not settle before timeout: \{/);
  });

  test.each(["read", "send"] as const)("a shutdown while the period awaits %s stops after it, waits and closes", async (during) => {
    const result = await expectAs({ rig, prepare, during, call: (r) => r.loop.shutdown(), after: 1 }, "after", true);

    expect(result.outcome).toEqual({ ok: null });
    expect((result.state as { snapshot: ControlSnapshot }).snapshot.status).toBe("CLOSED");
    expect(result.calls.at(-1)).toBe("c");
  });

  describe("the period that brakes for a cancellation", () => {
    // the cancellation is set and attached before the period, which brakes after its reading: while it sends the
    // first sample of the stop the loop is STOPPING under a new generation, as after the period
    const braking = async (r: GatedRig): Promise<void> => {
      const guard = new ActionGuard(r.loop);
      guard.submit(() => r.loop.move(r.jogged(0.3)));
      await r.tick(4);
      kept.set(r, { guard });
      r.loop.attachCancellation({ aborted: true });
    };

    test("a move while it sends is refused in STOPPING, as after the period", async () => {
      const result = await expectAs(
        { rig, prepare: braking, during: "send", call: (r) => r.loop.move(r.jogged(0.05)), after: 2 },
        "after",
        true,
      );

      expect(result.outcome).toEqual({ error: { type: "RuntimeError", message: "Cannot start a move in STOPPING" } });
      expect((result.state as { snapshot: ControlSnapshot }).snapshot.motion.end_reason).toBe("cancelled");
    });

    test("the guard of the move's action, checked while it sends, learns of the stop, as after the period", async () => {
      const result = await expectAs(
        { rig, prepare: braking, during: "send", call: (r) => kept.get(r)!.guard!.check(), after: 2 },
        "after",
        true,
      );

      expect(result.outcome).toEqual({
        error: { type: "RuntimeError", message: "Action cancelled by stop or another operation" },
      });
    });

    test("while it reads nothing of it has happened: the move is refused in RUNNING and the guard passes", async () => {
      const refused = await expectAs(
        { rig, prepare: braking, during: "read", call: (r) => r.loop.move(r.jogged(0.05)), after: 2 },
        "before",
        true,
      );
      const checked = await expectAs(
        { rig, prepare: braking, during: "read", call: (r) => kept.get(r)!.guard!.check(), after: 2 },
        "before",
        true,
      );

      expect(refused.outcome).toEqual({ error: { type: "RuntimeError", message: "Cannot start a move in RUNNING" } });
      expect(checked.outcome).toEqual({ ok: null });
    });
  });

  test("a snapshot taken while the period sends shows the new reading with the targets of the period before", async () => {
    // PEAR's lock hides this instant; a snapshot is synchronous here and shows the loop as it is then
    const subject = await GatedRig.make(rig);
    await moving(subject);
    const before = subject.loop.snapshot();
    const step = subject.begin();
    await subject.at("send");
    const during = subject.loop.snapshot();
    await subject.drain(step);
    const after = subject.loop.snapshot();
    const arm = subject.layout.arms[0] as string;

    expect(during.status).toBe("RUNNING");
    expect(during.generation).toBe(before.generation);
    // the reading is this period's, the targets are still the last period's, and the command follows
    expect(during.arms[arm]!.sampled_monotonic_s).toBe(subject.clock.now);
    expect(during.arms[arm]!.sampled_monotonic_s).toBeGreaterThan(before.arms[arm]!.sampled_monotonic_s);
    expect(during.targets).toEqual(before.targets);
    expect(after.targets).not.toEqual(before.targets);
    expect(after.arms).toEqual(during.arms);
  });
});

describe.each(STATIONS)("a call that arrives during a control period in a FAULT (%s)", (station) => {
  const rig = { station };
  const faulted = (r: GatedRig): Promise<void> => r.faultByStaleFeedback();

  test("a recovery asked for while the period reads begins after the period", async () => {
    const result = await expectAs(
      { rig, prepare: faulted, during: "read", call: (r) => r.loop.recover(), after: 2 },
      "after",
      true,
    );

    expect("ok" in result.outcome && (result.outcome.ok as ControlSnapshot).status).toBe("HOLD");
    expect("ok" in result.outcome && (result.outcome.ok as ControlSnapshot).motion.end_reason).toBe("recovered");
  });

  test("a move while the period reads is refused", async () => {
    const result = await expectAs(
      { rig, prepare: faulted, during: "read", call: (r) => r.loop.move(r.jogged(0.05)) },
      "before",
      false,
    );

    expect(result.outcome).toEqual({ error: { type: "RuntimeError", message: "Cannot start a move in FAULT" } });
  });

  /** Starts a recovery whose caller sleeps, and steps it `periods` control periods. */
  const recovering =
    (periods: number) =>
    async (r: GatedRig): Promise<Started> => {
      await r.faultByStaleFeedback();
      const recovery = startCall(() => r.loop.recover({ timeoutS: 5.0 }));
      await settle();
      await r.tick(periods);

      return recovery;
    };

  test.each(["stop", "close"] as const)("a %s while a recovery's period reads ends the recovery after the period", async (name) => {
    const result = await expectAs(
      {
        rig,
        prepare: recovering(3),
        during: "read_for_recovery",
        call: (r) => (name === "stop" ? r.loop.stop() : r.loop.close()),
        after: 2,
      },
      "after",
      // (before the period the call ends the recovery first, and the period reads as a fault without one does)
      true,
    );

    expect(result.outcome).toEqual({ ok: null });
    expect(result.waiting).toEqual({
      error:
        name === "stop"
          ? { type: "OperatorPaused", message: "Control recovery interrupted by the operator" }
          : { type: "RuntimeError", message: "Station closed during recovery" },
    });
  });

  test.each(["stop", "close", "recover"] as const)("a %s while a recovery's period commands the new hold follows that command", async (name) => {
    // the period in which the measured pose becomes the hold: find it, then arrive while it sends
    const probe = await GatedRig.make(rig);
    probe.parkSleeps();
    const probed = await recovering(0)(probe);
    let periods = 0;
    while (probe.loop.snapshot().recovery?.phase === "Checking stability") {
      if (periods >= MOST_PERIODS) {
        throw new Error(`The recovery still checks stability after ${MOST_PERIODS} control periods`);
      }
      await probe.tick();
      periods += 1;
    }
    await probe.resumeSleeps();
    await probed.outcome;
    expect(periods).toBeGreaterThan(3);

    const result = await expectAs(
      {
        rig,
        prepare: recovering(periods - 1),
        during: "send",
        call: (r) => (name === "stop" ? r.loop.stop() : name === "close" ? r.loop.close() : r.loop.recover()),
        after: 2,
      },
      "after",
      name !== "recover",
    );

    if (name === "recover") {
      expect(result.outcome).toEqual({ error: { type: "RuntimeError", message: "Control recovery is already running" } });
      expect("ok" in result.waiting! && (result.waiting.ok as ControlSnapshot).status).toBe("HOLD");
    } else {
      expect(result.outcome).toEqual({ ok: null });
      expect("error" in result.waiting!).toBe(true);
      // the hold that was being commanded when the call arrived was commanded: the period's calls end with it
      const period = result.calls.slice(0, 2).map((call) => (Array.isArray(call) ? call[0] : call));
      expect(period).toEqual(["R", "s"]);
    }
  });
});

describe.each(STATIONS)("a call that arrives while a period faults and commands its hold (%s)", (station) => {
  const rig = { station };
  const stale: Pick<Trial, "arrange" | "restore"> = {
    arrange: (r) => {
      r.driver.inner.isStale = true;
    },
    restore: (r) => {
      r.driver.inner.isStale = false;
    },
  };

  test("a move is refused, as after the period", async () => {
    const result = await expectAs(
      { rig, ...stale, during: "send", call: (r) => r.loop.move(r.jogged(0.05)) },
      "after",
      true,
    );

    expect(result.outcome).toEqual({ error: { type: "RuntimeError", message: "Cannot start a move in FAULT" } });
  });

  test("a move while that period still reads is begun, and faulted with the period, as before it", async () => {
    // (nothing of the period has happened while it reads: the move starts on the last good reading, and the stale
    // one then faults the loop with the move as its operation)
    const result = await expectAs(
      { rig, ...stale, during: "read", call: (r) => r.loop.move(r.jogged(0.05)) },
      "before",
      true,
    );
    const state = result.state as { snapshot: ControlSnapshot; loop: Record<string, unknown> };

    expect(result.outcome).toEqual({ ok: null });
    expect(state.snapshot.status).toBe("FAULT");
    expect(state.loop["operation"]).toBeNull();
    // the reading that was refused, then the fault's hold: no sample of the move
    expect(result.calls.slice(0, 2).map(code)).toEqual(["r", "s"]);
    expect((result.calls[1] as unknown[])[2]).toBeNull();
  });

  test("a stop follows the period", async () => {
    const result = await expectAs(
      { rig, prepare: (r) => moving(r), ...stale, during: "send", call: (r) => r.loop.stop() },
      "after",
      true,
    );

    expect(result.outcome).toEqual({ ok: null });
    expect((result.state as { snapshot: ControlSnapshot }).snapshot.status).toBe("FAULT");
  });

  test("a recovery asked for then is refused with the error of the hold that failed in this very period", async () => {
    const result = await expectAs(
      {
        rig,
        ...stale,
        arrange: (r) => {
          r.driver.inner.isStale = true;
          r.driver.failures.send = new OSError("bus write failed");
        },
        during: "send",
        call: (r) => r.loop.recover(),
      },
      "after",
      true,
    );

    expect("error" in result.outcome && result.outcome.error.type).toBe("RuntimeError");
    expect("error" in result.outcome && result.outcome.error.message).toMatch(/^Recovery blocked: .*: bus write failed$/);
  });

  test("a recovery asked for then, whose hold was commanded, recovers after the period", async () => {
    const result = await expectAs(
      { rig, ...stale, during: "send", call: (r) => r.loop.recover(), after: 2 },
      "after",
      true,
    );

    expect("ok" in result.outcome && (result.outcome.ok as ControlSnapshot).status).toBe("HOLD");
  });
});

describe.each(STATIONS)("a start bound to an observation, during a control period in a HOLD (%s)", (station) => {
  // PEAR's dispatch checks, under one lock, that the observation is of the current operation, that the feedback is
  // fresh and that the HOLD is settled, and then starts. A period publishes its reading and its verdict on the HOLD
  // before it awaits the renewal: a start that arrives while it reads sees the loop as before the period, and one
  // that arrives while it renews the hold sees it as after the period.
  const rig = { station };
  const observe = async (r: GatedRig): Promise<void> => {
    kept.set(r, { observation: observed(r) });
  };
  const sequence = (r: GatedRig): unknown => {
    const held = r.layout.join(r.loop.targets);
    const rows = [0.01, 0.02, 0.03].map((delta) => held.map((value, index) => (index === 0 ? value + delta : value)));

    return r.loop.startSequence(rows, { rateHz: 25.0, observation: kept.get(r)!.observation });
  };
  const checkedMove = (r: GatedRig): unknown => {
    const start = r.loop.trajectory.input.currentPosition;
    const goal = start.map((value, index) => (index === 0 ? value + 0.1 : value));
    const move = JointMove.build(start, goal, r.loop.limits, r.loop.layout);

    return r.loop.dispatchJointMove(move, kept.get(r)!.observation);
  };
  const starts = [
    ["a sequence", sequence],
    ["a checked move", checkedMove],
  ] as const;
  // one reading with this velocity lifts the mean of the whole window over the tolerance: the period that takes
  // it finds its HOLD unsettled
  const unsettling: Pick<Trial, "arrange" | "restore"> = {
    arrange: (r) => {
      r.driver.inner.velocity = 5.0;
    },
    restore: (r) => {
      r.driver.inner.velocity = 0.0;
    },
  };

  test.each(starts)("%s while the period reads is started before the period", async (_name, call) => {
    const result = await expectAs({ rig, prepare: observe, during: "read", call, after: 6 }, "before", true);

    expect(result.outcome).toEqual({ ok: true });
    expect(result.calls.slice(0, 2).map(code)).toEqual(["r", "s"]);
  });

  test.each(starts)("%s while the period renews the hold is started after the period", async (_name, call) => {
    const result = await expectAs({ rig, prepare: observe, during: "refresh_hold", call, after: 6 }, "after", true);

    expect(result.outcome).toEqual({ ok: true });
    expect(result.calls.slice(0, 3).map(code)).toEqual(["r", "h", "r"]);
  });

  test.each(starts)("%s while a period that will find the HOLD unsettled reads is started, as before it", async (_name, call) => {
    const result = await expectAs(
      { rig, prepare: observe, ...unsettling, during: "read", call, after: 6 },
      "before",
      true,
    );

    expect(result.outcome).toEqual({ ok: true });
  });

  test.each(starts)("%s while that period renews the hold is not started, as after it", async (_name, call) => {
    const trial: Trial = { rig, prepare: observe, ...unsettling, during: "refresh_hold", call, after: 6 };
    const result = await expectAs(trial, "after", true);

    // the period's own verdict on the HOLD, published before its renewal, is what the start was refused on
    expect(result.outcome).toEqual({ ok: false });
    expect((await run(trial, "before")).outcome).toEqual({ ok: true });
  });

  test("an observation of an earlier operation is refused on either side of a period and at each of its awaits", async () => {
    const stale = async (r: GatedRig): Promise<void> => {
      kept.set(r, { observation: observed(r) });
      // a stop in a HOLD invalidates pending observations
      await r.loop.stop();
    };
    for (const during of ["read", "refresh_hold"] as const) {
      const result = await expectAs({ rig, prepare: stale, during, call: sequence }, "before", false);

      expect(result.outcome).toEqual({
        error: { type: "ValueError", message: "Observation invalidated by another operation" },
      });
    }
  });
});

describe.each(STATIONS)("the stability history read during a control period (%s)", (station) => {
  // `stability` evaluates the history the loop keeps, without sampling: PEAR reads it under the lock, pear.js
  // wherever the call falls. The history changes at one place of a period, with nothing awaited in between, so a
  // reading is always the history of before the period or of after it. The period's reading differs from the still
  // ones before it, so that the two differ.
  const rig = { station };
  const moved: Pick<Trial, "arrange" | "restore"> = {
    arrange: (r) => {
      r.driver.inner.velocity = 5.0;
    },
    restore: (r) => {
      r.driver.inner.velocity = 0.0;
    },
  };
  const call = (r: GatedRig): unknown => r.loop.stability();

  test("while a period of a HOLD reads: the history of before the period", async () => {
    const result = await expectAs({ rig, ...moved, during: "read", call }, "before", true);

    expect("ok" in result.outcome && (result.outcome.ok as { stable: boolean }).stable).toBe(true);
  });

  test("while a period of a HOLD renews the hold: the history with the period's reading", async () => {
    const result = await expectAs({ rig, ...moved, during: "refresh_hold", call }, "after", true);

    expect("ok" in result.outcome && (result.outcome.ok as { stable: boolean }).stable).toBe(false);
  });

  test.each(["read", "send"] as const)("while a period that settles a finished move awaits %s: the history of before the period", async (during) => {
    // (a moving period adds its reading to the history after its command)
    const settling = async (r: GatedRig): Promise<void> => {
      r.loop.move(r.jogged(0.02));
      for (let periods = 0; !r.loop.snapshot().motion.settling; periods++) {
        if (periods >= MOST_PERIODS) {
          throw new Error(`The move does not settle after ${MOST_PERIODS} control periods`);
        }
        await r.tick();
      }
      await r.tick(3);
    };
    const result = await expectAs({ rig, prepare: settling, during, call }, "before", true);
    const before = result.outcome as { ok: { samples: number } };
    const after = (await run({ rig, prepare: settling, during, call }, "after")).outcome as { ok: { samples: number } };

    expect(after.ok.samples).toBe(before.ok.samples + 1);
  });
});

describe("a gripper operation begun during a control period in a HOLD (the SO-101's loop on its own driver)", () => {
  // PEAR's robot starts the jaw's operation under the loop's lock. Here the start is synchronous: while the period
  // reads it is begun before the period, which then sends the jaw's first sample; while the period renews the hold
  // the period is over, and the operation starts with the next one.
  const rig: RigOptions = { kind: "so101" };
  const jaws = [
    ["opening", true],
    ["closing", false],
  ] as const;

  test.each(jaws)("%s the jaw while the period reads is begun before the period, which sends its first sample", async (_name, opens) => {
    const result = await expectAs(
      { rig, during: "read", call: (r) => r.loop.beginGrippers(opens).constructor.name, after: 8 },
      "before",
      true,
    );

    expect(result.outcome).toEqual({ ok: "SO101GripperOperation" });
    expect(result.calls.slice(0, 2).map(code)).toEqual(["r", "s"]);
  });

  test.each(jaws)("%s the jaw while the period renews the hold is begun after the period, and starts with the next", async (_name, opens) => {
    const result = await expectAs(
      { rig, during: "refresh_hold", call: (r) => r.loop.beginGrippers(opens).constructor.name, after: 8 },
      "after",
      true,
    );

    expect(result.outcome).toEqual({ ok: "SO101GripperOperation" });
    expect(result.calls.slice(0, 4).map(code)).toEqual(["r", "h", "r", "s"]);
  });

  test.each(["read", "refresh_hold"] as const)("through an action's guard while the period awaits %s: the guard adopts the operation and attaches its cancellation", async (during) => {
    const cancellation = { aborted: false };
    const call = (r: GatedRig): unknown => {
      const guard = new ActionGuard(r.loop, cancellation);
      const operation = guard.submit((opens: boolean) => r.loop.beginGrippers(opens), false);

      return [
        operation.constructor.name,
        guard.hasDispatched,
        guard.generation === r.loop.generation,
        r.loop.operationCancellation === cancellation,
      ];
    };
    const result = await expectAs({ rig, during, call, after: 8 }, during === "read" ? "before" : "after", true);

    expect(result.outcome).toEqual({ ok: ["SO101GripperOperation", true, true, true] });
  });

  test("a second gripper operation while the first one's period sends is refused, as before the period", async () => {
    const closing = async (r: GatedRig): Promise<void> => {
      r.loop.beginGrippers(false);
      await r.tick(3);
    };
    const result = await expectAs(
      { rig, prepare: closing, during: "send", call: (r) => r.loop.beginGrippers(true), after: 4 },
      "before",
      false,
    );

    expect(result.outcome).toEqual({ error: { type: "RuntimeError", message: "Another operation owns the targets" } });
  });

  test("a gripper operation while a period that faults commands its hold is refused, as after the period", async () => {
    const result = await expectAs(
      {
        rig,
        arrange: (r) => r.setStale(true),
        restore: (r) => r.setStale(false),
        during: "send",
        call: (r) => r.loop.beginGrippers(false),
      },
      "after",
      true,
    );

    expect(result.outcome).toEqual({ error: { type: "RuntimeError", message: "Another operation owns the targets" } });
  });
});
