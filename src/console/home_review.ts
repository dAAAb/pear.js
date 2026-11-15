// Ports pear/deploy/station/gui/console/home_review.py: HomeStatus and HomeReview.
//
// PEAR's HomeReview is made with the console's lock, under which the console's snapshot reads the plan. Here there
// is none: a page has one thread, and nothing is awaited where PEAR holds the lock. `answered`, PEAR's
// threading.Event, is an AbortController, as the console's cancellation is: set() is abort(), wait() waits for the
// signal, and clear(), which an AbortController has not, puts a new controller in the place of an aborted one. So
// whoever sets it takes `homeReview.answered` at that moment and keeps no reference to it. wait_for_decision blocks
// the console's worker thread; here it is an async function. uuid4() is the option `uuid`, by default a random
// UUID; .hex removes its dashes, as the task run's attempt id does.

import { uuid4 } from "../agent/messages";
import { KeyError, ValueError } from "../python/errors";
import { pythonTruth } from "../python/repr";
import { OperatorPaused, type Cancellation } from "../station/exceptions";
import type { HomePlan } from "../station/schemas";

/** How a Home stands, as the page receives it beside the Home's stage. */
export const HomeStatus = {
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;
export type HomeStatus = (typeof HomeStatus)[keyof typeof HomeStatus];

/** A Home plan as it is reviewed: the plan's fields, then its plan_id. */
export type ReviewPlan = Record<string, unknown>;

/** Resolves once ``signal`` is aborted, at once if it already is (threading.Event.wait()). */
function wokenBy(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** A Home plan waiting for the operator's confirmation, and the operator's answer to it. */
export class HomeReview {
  /** The plan under review, with its plan_id; null while none waits. */
  plan: ReviewPlan | null = null;
  /** The operator's answer to the plan; null until it arrives. */
  decision: boolean | null = null;
  /** Set (aborted) by the operator's answer, or by a STOP; replaced by a new one where PEAR clears its event. */
  answered = new AbortController();

  private readonly uuid: () => string;

  constructor(options: { uuid?: () => string } = {}) {
    this.uuid = options.uuid ?? uuid4;
  }

  /** Returns ``plan`` under a new plan_id, with no answer and no wake left from before; the plan is published
   * only after this, so that a fast answer is never erased. */
  prepare(plan: HomePlan): ReviewPlan {
    const reviewPlan: ReviewPlan = { ...plan, plan_id: this.uuid().replace(/-/g, "") };
    this.decision = null;
    this.clearAnswered();

    return reviewPlan;
  }

  /** Publishes ``reviewPlan`` and returns the operator's answer to it; a STOP ends the wait, and the end of the
   * console's operation withdraws the plan. */
  async waitForDecision(reviewPlan: ReviewPlan, cancellation: Cancellation): Promise<boolean> {
    // (PEAR: with self.lock; nothing is awaited here)
    this.plan = reviewPlan;

    // a wake without an answer is a STOP, seen as the cancellation, or one left from an earlier STOP
    while (this.decision === null) {
      OperatorPaused.checkCancelled(cancellation);
      await wokenBy(this.answered.signal);
      this.clearAnswered();
    }
    OperatorPaused.checkCancelled(cancellation);

    // the answer is taken as the plan is withdrawn: a later answer finds no plan
    // (PEAR: with self.lock; nothing is awaited here)
    const decision: boolean = this.decision;
    this.plan = null;

    return decision;
  }

  /** Answers the plan under review, and refuses an answer to a plan that is no longer current. */
  confirm(planId: unknown, isConfirmed: boolean): void {
    // under the lock the plan stays current until the answer is recorded
    // (PEAR: with self.lock; nothing is awaited here)
    const plan = this.plan;
    if (plan === null || !pythonTruth(plan)) {
      throw new ValueError("This home plan is no longer current");
    }
    if (!Object.hasOwn(plan, "plan_id")) {
      throw new KeyError("'plan_id'");
    }
    if (planId !== plan["plan_id"]) {
      throw new ValueError("This home plan is no longer current");
    }
    this.decision = isConfirmed;
    this.answered.abort();
  }

  /** threading.Event.clear(): an event that is not set stays as it is, so that whoever waits for it is still
   * woken. */
  private clearAnswered(): void {
    if (this.answered.signal.aborted) {
      this.answered = new AbortController();
    }
  }
}
