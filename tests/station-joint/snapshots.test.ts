import { describe, expect, test } from "vitest";

import { ActionGuard, type GuardedControlLoop } from "../../src/station/joint/action_guard";
import { ArmState } from "../../src/station/joint/arm_state";
import { SteppedClock } from "../../src/station/joint/clock";
import { OperatorPaused, RuntimeError, TimeoutError, ValueError, type Cancellation } from "../../src/station/joint/errors";
import { SnapshotCheck, type FaultSnapshot, type FeedbackSnapshot, type VectorSnapshot } from "../../src/station/joint/snapshot_checks";
import { StabilityError } from "../../src/station/joint/stability";
import type { ControlSnapshot, Observation, SampleId } from "../../src/station/schemas";
import { jsonText, layoutOf, loadFixture, meta, outcomeOf, outcomeOfAsync, type Outcome } from "./fixtures";

interface ArmStateCase {
  layout: string;
  position: number[];
  velocity: number[];
  sampled_monotonic_s: number;
  sample_id: SampleId;
  now: number;
  feedback: unknown;
  check: Outcome;
}

interface PollCase {
  timeout_s: number | null;
  control_period_s: number;
  /** Each attempt: how long it takes, whether it is done, and its result. */
  attempts: [number, boolean, unknown][];
  outcome: Outcome;
  attempts_made: number;
  sleeps: number[];
  end_s: number;
}

interface WaitCase {
  timeout_s: number;
  /** Each reading: the status, whether the arrival is settled, and whether the caller accepts it. */
  reads: [string, boolean, boolean][];
  accepts: boolean;
  guard_fails_at: number | null;
  outcome: Outcome;
  counts: { checks: number; reads: number; accepted: number };
  sleeps: number[];
}

interface GuardStep {
  op: "check" | "cancel" | "loop" | "submit";
  change?: { status?: string; fault?: string | null; fault_details?: Record<string, unknown> | null; generation?: number };
  effect?: { advance: number; status?: string; fault?: string; returns?: unknown; raises?: string };
  arguments?: unknown[];
  outcome?: Outcome;
  guard: { generation: number; has_dispatched: boolean };
  loop: { generation: number; attached: boolean[] };
}

const fixture = loadFixture<{
  fault_cases: { snapshot: FaultSnapshot; outcome: Outcome }[];
  validate_cases: { snapshot: FeedbackSnapshot; state_timeout_s: number; requires_hold: boolean; outcome: Outcome }[];
  vector_cases: { snapshot: VectorSnapshot; state_vector: number[]; target_vector: number[] }[];
  reference_cases: {
    snapshot: VectorSnapshot & Pick<ControlSnapshot, "generation">;
    observation: (Pick<Observation, "joint_positions"> & { control_snapshot: Pick<ControlSnapshot, "generation"> }) | null;
    outcome: Outcome;
  }[];
  timeout_cases: { timeout_s: number; subject: string; outcome: Outcome }[];
  arm_state_cases: ArmStateCase[];
  fresh_cases: { age_s: number; timeout_s: number; slack_s: number | null; outcome: boolean }[];
  poll_cases: PollCase[];
  wait_cases: WaitCase[];
  guard_cases: { start_generation: number; has_cancellation: boolean; steps: GuardStep[] }[];
}>("snapshots.json");

function differing<Case extends { outcome: Outcome }>(cases: readonly Case[], answer: (item: Case) => Outcome) {
  return cases.flatMap((item) => {
    const ours = answer(item);
    try {
      expect(ours).toEqual(item.outcome);
    } catch {
      return [{ item, ours }];
    }
    return [];
  });
}

describe("the checks of a snapshot", () => {
  test(`raise_for_fault: ${fixture.fault_cases.length} snapshots pass or raise as in PEAR`, () => {
    expect(differing(fixture.fault_cases, (item) => outcomeOf(() => SnapshotCheck.raiseForFault(item.snapshot)))).toEqual([]);

    const types = new Set(fixture.fault_cases.flatMap((item) => ("error" in item.outcome ? [item.outcome.error.type] : [])));
    expect(types).toEqual(new Set(["RuntimeError", "StabilityError"]));
  });

  test("a stability fault read from a snapshot is the error the window raised", () => {
    const item = fixture.fault_cases.find(
      (candidate) => candidate.snapshot.status === "FAULT" && candidate.snapshot.fault_details?.["code"] === "StabilityError",
    )!;
    let failure: unknown;
    try {
      SnapshotCheck.raiseForFault(item.snapshot);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(StabilityError);
    expect((failure as StabilityError).message).toBe(item.snapshot.fault);
    expect((failure as StabilityError).details).toEqual(item.snapshot.fault_details);
  });

  test(`validate_snapshot: ${fixture.validate_cases.length} snapshots are given back or refused as in PEAR`, () => {
    const answer = (item: (typeof fixture.validate_cases)[number]) =>
      outcomeOf(
        () => SnapshotCheck.validateSnapshot(item.snapshot, { state_timeout_s: item.state_timeout_s }, item.requires_hold) === item.snapshot,
      );

    expect(differing(fixture.validate_cases, answer)).toEqual([]);
    const messages = new Set(fixture.validate_cases.flatMap((item) => ("error" in item.outcome ? [item.outcome.error.message] : [])));
    expect(messages).toContain("Stale station feedback");
    // a fault that is no text reads None, an empty one reads as nothing
    expect(messages).toContain("Station requires valid HOLD: STOPPING: None");
    expect(messages).toContain("Station requires valid HOLD: RUNNING: ");
    expect(messages).toContain("Station requires valid feedback: ODD: None");
  });

  test("validate_snapshot asks for any moving state unless it is told to ask for a HOLD", () => {
    const running = { status: "RUNNING", fault: null, arms: { arm: { age_seconds: 0.0 } } };

    expect(SnapshotCheck.validateSnapshot(running, { state_timeout_s: 0.1 })).toBe(running);
    expect(() => SnapshotCheck.validateSnapshot(running, { state_timeout_s: 0.1 }, true)).toThrow(RuntimeError);
  });

  test(`validate_reference: ${fixture.reference_cases.length} observations pass or are refused as in PEAR`, () => {
    const answer = (item: (typeof fixture.reference_cases)[number]) =>
      outcomeOf(() => SnapshotCheck.validateReference(item.snapshot, item.observation));

    expect(differing(fixture.reference_cases, answer)).toEqual([]);
  });

  test(`check_timeout: ${fixture.timeout_cases.length} timeouts pass or are refused as in PEAR`, () => {
    const answer = (item: (typeof fixture.timeout_cases)[number]) =>
      outcomeOf(() => SnapshotCheck.checkTimeout(item.timeout_s, item.subject));

    expect(differing(fixture.timeout_cases, answer)).toEqual([]);
  });

  test("the vectors of a snapshot follow its measured arms' order, the targets too", () => {
    for (const item of fixture.vector_cases) {
      expect(SnapshotCheck.stateVector(item.snapshot)).toEqual(item.state_vector);
      expect(SnapshotCheck.targetVector(item.snapshot)).toEqual(item.target_vector);
    }
    expect(fixture.vector_cases.some((item) => Object.keys(item.snapshot.arms).join() !== Object.keys(item.snapshot.targets).join())).toBe(true);
  });
});

describe("an arm's reading", () => {
  test(`${fixture.arm_state_cases.length} readings give PEAR's feedback and pass PEAR's check`, () => {
    for (const item of fixture.arm_state_cases) {
      const state =
        item.sample_id === null
          ? new ArmState(item.position, item.velocity, item.sampled_monotonic_s)
          : new ArmState(item.position, item.velocity, item.sampled_monotonic_s, item.sample_id);
      const feedback = state.feedback(item.now);

      expect(feedback).toEqual(item.feedback);
      expect(jsonText(feedback)).toBe(jsonText(item.feedback));
      expect(outcomeOf(() => state.check(layoutOf(item.layout)))).toEqual(item.check);
    }
    expect(fixture.arm_state_cases.some((item) => "error" in item.check)).toBe(true);
  });

  test(`is_fresh answers ${fixture.fresh_cases.length} ages as PEAR's`, () => {
    const wrong = fixture.fresh_cases.filter(
      (item) =>
        (item.slack_s === null ? ArmState.isFresh(item.age_s, item.timeout_s) : ArmState.isFresh(item.age_s, item.timeout_s, item.slack_s)) !==
        item.outcome,
    );

    expect(wrong).toEqual([]);
    expect(new Set(fixture.fresh_cases.map((item) => item.outcome))).toEqual(new Set([true, false]));
  });
});

describe("the waits", () => {
  test(`poll: ${fixture.poll_cases.length} scripted waits end as in PEAR, after the same attempts and sleeps`, async () => {
    for (const item of fixture.poll_cases) {
      const clock = new SteppedClock();
      const sleeps: number[] = [];
      clock.onSleep = (seconds) => {
        sleeps.push(seconds);
      };
      const attempts = item.attempts[Symbol.iterator]();
      let made = 0;
      const attempt = (): [boolean, unknown] => {
        const next = attempts.next();
        const [takes, isDone, result] = next.done ? [0.0, true, "the script ended"] : next.value;
        clock.now += takes as number;
        made += 1;
        return [isDone as boolean, result];
      };
      const timedOut = (result: unknown) => new TimeoutError(`gave up after ${String(result)}`);

      const ours = await outcomeOfAsync(() =>
        item.timeout_s === null
          ? SnapshotCheck.poll(attempt, item.control_period_s, undefined, undefined, clock)
          : SnapshotCheck.poll(attempt, item.control_period_s, item.timeout_s, timedOut, clock),
      );

      expect(ours, JSON.stringify(item)).toEqual(item.outcome);
      expect(made).toBe(item.attempts_made);
      expect(sleeps).toEqual(item.sleeps);
      expect(clock.now).toBe(item.end_s);
    }
    expect(fixture.poll_cases.some((item) => "error" in item.outcome && item.outcome.error.type === "TimeoutError")).toBe(true);
    expect(fixture.poll_cases.some((item) => "ok" in item.outcome && item.sleeps.length > 2)).toBe(true);
  });

  test(`wait_ready: ${fixture.wait_cases.length} scripted waits end as in PEAR, after the same checks and readings`, async () => {
    for (const item of fixture.wait_cases) {
      const clock = new SteppedClock();
      const sleeps: number[] = [];
      clock.onSleep = (seconds) => {
        sleeps.push(seconds);
      };
      const reads = item.reads[Symbol.iterator]();
      const counts = { checks: 0, reads: 0, accepted: 0 };
      const accepted: boolean[] = [];
      const guard = {
        check(): void {
          counts.checks += 1;
          if (counts.checks - 1 === item.guard_fails_at) {
            throw new RuntimeError("Action cancelled by stop or another operation");
          }
        },
      };
      const readSnapshot = () => {
        const next = reads.next();
        const [status, isSettled, isAccepted] = next.done ? ["HOLD", true, true] : next.value;
        counts.reads += 1;
        accepted.push(isAccepted as boolean);
        return { status: status as string, arrival: { settled: isSettled as boolean }, number: counts.reads };
      };
      type Read = ReturnType<typeof readSnapshot>;

      const ours = await outcomeOfAsync(() =>
        SnapshotCheck.waitReady(readSnapshot as () => Read & Pick<ControlSnapshot, "arrival">, {
          timeoutS: item.timeout_s,
          controlPeriodS: 0.02,
          guard,
          makeTimeoutError: (snapshot) => new TimeoutError(`Motion did not settle before timeout: ${snapshot.number}`),
          accepts: item.accepts
            ? () => {
                counts.accepted += 1;
                return accepted[accepted.length - 1]!;
              }
            : null,
          clock,
        }),
      );

      expect(ours, JSON.stringify(item)).toEqual(item.outcome);
      expect(counts).toEqual(item.counts);
      expect(sleeps).toEqual(item.sleeps);
    }
    const types = new Set(fixture.wait_cases.flatMap((item) => ("error" in item.outcome ? [item.outcome.error.type] : [])));
    expect(types).toEqual(new Set(["TimeoutError", "RuntimeError", "ValueError"]));
  });

  test("the errors of a wait are Python's by name", () => {
    expect(new TimeoutError("late").name).toBe("TimeoutError");
    expect(meta.errors["TimeoutError"]).toEqual(["TimeoutError", "OSError", "Exception"]);
    expect(new TimeoutError("late")).not.toBeInstanceOf(RuntimeError);
    expect(new ValueError("bad")).not.toBeInstanceOf(RuntimeError);
    expect(meta.errors["ValueError"]).toEqual(["ValueError", "Exception"]);
  });
});

/** What PEAR's ActionGuard reads and asks of a control loop, and nothing else: the stand-in of the fixture script. */
class StandInLoop implements GuardedControlLoop {
  generation = 0;
  status = "HOLD";
  fault: string | null = null;
  fault_details: Record<string, unknown> | null = null;
  /** Of every cancellation attached: whether it was one. */
  attached: boolean[] = [];

  snapshot(): FaultSnapshot {
    return { status: this.status, fault: this.fault, fault_details: this.fault_details };
  }

  attachCancellation(cancellation: Cancellation | null): void {
    this.attached.push(cancellation !== null);
  }
}

describe("the action guard", () => {
  test(`${fixture.guard_cases.length} actions on a stand-in control loop are checked, dispatched and ended as in PEAR`, () => {
    let steps = 0;
    for (const item of fixture.guard_cases) {
      const loop = new StandInLoop();
      loop.generation = item.start_generation;
      const cancellation = item.has_cancellation ? { aborted: false } : null;
      const guard = new ActionGuard(loop, cancellation);

      item.steps.forEach((step, index) => {
        const where = `${JSON.stringify(item.steps.slice(0, index + 1).map((done) => done.op))}`;
        if (step.op === "check") {
          expect(outcomeOf(() => guard.check()), where).toEqual(step.outcome);
        } else if (step.op === "cancel") {
          if (cancellation !== null) {
            cancellation.aborted = true;
          }
        } else if (step.op === "loop") {
          const { generation, ...fields } = step.change!;
          loop.generation += generation ?? 0;
          Object.assign(loop, fields);
        } else {
          const effect = step.effect!;
          const method = (...methodArguments: unknown[]) => {
            loop.generation += effect.advance;
            if (effect.status !== undefined) loop.status = effect.status;
            if (effect.fault !== undefined) loop.fault = effect.fault;
            if (effect.raises !== undefined) throw new ValueError(effect.raises);
            return { arguments: methodArguments, returns: effect.returns };
          };
          expect(outcomeOf(() => guard.submit(method, ...(step.arguments ?? []))), where).toEqual(step.outcome);
        }
        expect({ generation: guard.generation, has_dispatched: guard.hasDispatched }, where).toEqual(step.guard);
        expect({ generation: loop.generation, attached: loop.attached }, where).toEqual(step.loop);
        steps += 1;
      });
    }

    const errors = fixture.guard_cases.flatMap((item) =>
      item.steps.flatMap((step) => (step.outcome && "error" in step.outcome ? [`${step.outcome.error.type}: ${step.outcome.error.message}`] : [])),
    );
    expect(steps).toBeGreaterThan(150);
    for (const expected of [
      `OperatorPaused: ${meta.constants.operator_paused}`,
      "RuntimeError: Action cancelled by stop or another operation",
      "RuntimeError: Action interrupted: CLOSED: None",
      "RuntimeError: Action interrupted: CLOSED: Station closed during recovery",
      "RuntimeError: Station fault: FAULT: Servo error: gripper: overload",
    ]) {
      expect(errors, expected).toContain(expected);
    }
    expect(errors.some((error) => error.startsWith("StabilityError: "))).toBe(true);
  });

  test("the operator's pause is PEAR's OperatorPaused, a RuntimeError, and an AbortSignal is a cancellation", () => {
    const controller = new AbortController();
    const guard = new ActionGuard(new StandInLoop(), controller.signal);

    expect(() => guard.check()).not.toThrow();
    controller.abort();
    expect(() => guard.check()).toThrow(OperatorPaused);
    expect(outcomeOf(() => guard.check())).toEqual({ error: { type: "OperatorPaused", message: meta.constants.operator_paused } });
    expect(meta.errors["OperatorPaused"]).toEqual(["OperatorPaused", "RuntimeError", "Exception"]);
    expect(new OperatorPaused("x")).toBeInstanceOf(RuntimeError);
    expect(() => OperatorPaused.checkCancelled(null)).not.toThrow();
  });

  // Not in PEAR, whose control loop's methods return at once: in pear.js a method that reaches the arm is
  // asynchronous, and the guard adopts what it started when it has resolved.
  test("a submitted method that returns a promise is adopted when it resolves, and not when it rejects", async () => {
    const loop = new StandInLoop();
    const guard = new ActionGuard(loop, { aborted: false });

    const started = guard.submit(async (goal: number) => {
      await Promise.resolve();
      loop.generation += 1;
      loop.status = "RUNNING";
      return goal * 2;
    }, 21);
    expect(guard.hasDispatched).toBe(false);
    expect(await started).toBe(42);
    expect(guard.hasDispatched).toBe(true);
    expect(guard.generation).toBe(1);
    expect(loop.attached).toEqual([true]);

    const failed = guard.submit(async () => {
      loop.generation += 1;
      throw new RuntimeError("Cannot start a move in RUNNING");
    });
    await expect(failed).rejects.toThrow("Cannot start a move in RUNNING");
    expect(guard.generation).toBe(1);
    expect(() => guard.check()).toThrow("Action cancelled by stop or another operation");
  });
});
