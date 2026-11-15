// PEAR's ModelCall, the wait for the model's answer, ran each scenario of tests/fixtures/agent/model_call.json on a
// scripted robot and a clock that only its waits advance (tools/fixtures/agent_fixtures.py, CallRig). Here pear.js's
// ModelCall runs them on the same rig: it must ask the same of the robot, wait the same times in the same order,
// and return or throw the same.

import { describe, expect, test } from "vitest";

import { ModelCall, type HoldingRobot } from "../../src/agent/agent_loop";
import type { ModelOutput } from "../../src/agent/clients/schemas";
import type { Observation } from "../../src/agent/robot";
import { expectOutcome, recordedError } from "./client_scenarios";
import { loadFixture, type RecordedOutcome } from "./fixtures";
import { makeError, type ErrorSpec } from "./stand_ins";

type Ending = { delay_s: number; returns?: unknown; raises?: ErrorSpec } | { never: true };
type Holding = boolean | { raises: ErrorSpec } | { value: boolean; pause: true };

interface CallScenario {
  name: string;
  timeout_s: number;
  cancelled_before?: boolean;
  wait_stationary?: { raises: ErrorSpec };
  holding: Holding[];
  call: Ending;
  after_abort?: Ending;
  log: unknown[][];
  outcome: RecordedOutcome;
  elapsed_s: number;
}

const fixture = loadFixture<{ control_period_s: number; cleanup_timeout_s: number; scenarios: CallScenario[] }>(
  "model_call.json",
);
const START_S = 100;

/** The rig of one scenario: the robot, the clock, the waits and the request. */
class CallRig implements HoldingRobot {
  readonly controlPeriodS = fixture.control_period_s;
  now = START_S;
  readonly log: unknown[][] = [];
  readonly cancellation = new AbortController();
  private holdingCalls = 0;
  // the request once it is made: when it ends on the rig's clock (null: never) and what it ends with
  private request: {
    availableAt: number | null;
    ending: Ending;
    hasEnded: boolean;
    end: () => void;
    /** Resolves once the one who waits for the request has heard of its end. */
    heard: Promise<void>;
    isHeard: boolean;
  } | null = null;

  constructor(private readonly scenario: CallScenario) {}

  readonly clock = (): number => this.now;

  /** Waits ``seconds`` on the rig's clock, less when the request ends before: time passes at once. */
  readonly sleep = async (seconds: number): Promise<void> => {
    if (this.log.length > 10_000) {
      throw new Error("The rig's clock does not advance");
    }
    const request = this.request;
    if (request !== null && request.hasEnded && !request.isHeard) {
      await request.heard; // the request has just ended: the one who waits for it hears before any time passes
      return;
    }
    const before = this.now;
    const endsAt = request !== null && !request.hasEnded ? request.availableAt : null;
    const endsInTime = request !== null && endsAt !== null && endsAt <= this.now + seconds;
    this.now = endsInTime ? Math.max(this.now, endsAt) : this.now + seconds;
    this.log.push(["pause", seconds, this.now - before]);
    if (endsInTime) {
      request.end();
      await request.heard;
    }
  };

  waitStationary(
    observation?: Observation | null,
    options?: { cancellation?: AbortSignal | null },
  ): Record<string, never> {
    this.log.push(["wait_stationary", observation!.observationId, options?.cancellation === this.cancellation.signal]);
    if (this.scenario.wait_stationary) {
      throw makeError(this.scenario.wait_stationary.raises);
    }

    return {};
  }

  isHolding(): boolean {
    const behaviours = this.scenario.holding;
    let behaviour = behaviours[Math.min(this.holdingCalls, behaviours.length - 1)]!;
    this.holdingCalls += 1;
    if (typeof behaviour === "object") {
      if ("pause" in behaviour) {
        this.cancellation.abort();
      }
      if ("raises" in behaviour) {
        this.log.push(["is_holding", "raises"]);
        throw makeError(behaviour.raises);
      }
      behaviour = behaviour.value;
    }
    this.log.push(["is_holding", behaviour]);

    return behaviour;
  }

  stop(): void {
    this.log.push(["stop"]);
  }

  /** Makes the request: a promise that settles when the rig's clock reaches the request's end. */
  readonly call = (): Promise<ModelOutput> => {
    this.log.push(["call"]);
    let settle!: () => void;
    const promise = new Promise<ModelOutput>((resolve, reject) => {
      settle = () => {
        const ending = this.request!.ending as { returns?: unknown; raises?: ErrorSpec };
        if (ending.raises) {
          reject(makeError(ending.raises));
        } else {
          resolve(ending.returns as ModelOutput);
        }
      };
    });
    const request = {
      availableAt: null as number | null,
      ending: this.scenario.call,
      hasEnded: false,
      end: () => {
        request.hasEnded = true;
        settle();
      },
      heard: Promise.resolve(),
      isHeard: false,
    };
    // the caller's own wait for the request is attached after this one, and so hears right after it: by the time
    // `heard` has resolved for someone who awaits it, the caller has heard
    const mark = (): void => {
      request.isHeard = true;
    };
    request.heard = promise.then(mark, mark);
    this.request = request;
    this.endWith(this.scenario.call);

    return promise;
  };

  /** Sets when the request ends and what with; a request that ends now ends at once. */
  private endWith(ending: Ending): void {
    const request = this.request!;
    request.ending = ending;
    request.availableAt = "never" in ending ? null : this.now + ending.delay_s;
    if (request.availableAt !== null && request.availableAt <= this.now) {
      request.end();
    }
  }

  readonly abort = (): void => {
    this.log.push(["abort"]);
    if (this.scenario.after_abort && this.request !== null && !this.request.hasEnded) {
      this.endWith(this.scenario.after_abort);
    }
  };
}

describe("ModelCall", () => {
  test.each(fixture.scenarios.map((scenario) => [scenario.name, scenario] as const))(
    "does what PEAR's did: %s",
    async (_name, scenario) => {
      const rig = new CallRig(scenario);
      if (scenario.cancelled_before) {
        rig.cancellation.abort();
      }
      const reference = { observationId: "reference" } as Observation;

      let outcome: RecordedOutcome;
      try {
        const answer = await new ModelCall(rig, reference, rig.call, {
          timeoutS: scenario.timeout_s,
          cancellation: rig.cancellation.signal,
          abort: rig.abort,
          clock: rig.clock,
          sleep: rig.sleep,
        }).run();
        outcome = { returned: answer };
      } catch (error) {
        outcome = { raised: recordedError(error) };
      }

      expectOutcome(outcome, scenario.outcome);
      expect(rig.log).toEqual(scenario.log);
      expect(rig.now - START_S).toBe(scenario.elapsed_s);
    },
  );

  test("the scenarios end in every way a call ends", () => {
    const raised = fixture.scenarios.flatMap((scenario) =>
      "raised" in scenario.outcome ? [scenario.outcome.raised.type] : [],
    );

    expect(new Set(raised)).toEqual(
      new Set(["TimeoutError", "SessionLost", "OperatorPaused", "ConnectionError", "ValueError", "RuntimeError"]),
    );
    expect(fixture.scenarios.some((scenario) => "returned" in scenario.outcome)).toBe(true);
    expect(fixture.cleanup_timeout_s).toBe(10);
  });
});
