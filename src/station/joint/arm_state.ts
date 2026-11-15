// Ports pear/deploy/station/control/joint/arm_state.py.

import type { ArmFeedback, SampleId } from "../schemas";
import type { JointLayout } from "./layout";

/**
 * Returns `vector` as PEAR holds an arm's vector: a tuple, here a frozen array. Whoever is handed it (a snapshot's
 * reader, a driver, an operation, a recovery policy) cannot change it for the one that holds it: a write throws a
 * TypeError in a module, as Python's does, and changes nothing in a script that is not strict. A vector that is
 * frozen already is returned as it is; any other is copied, so the caller's own array is neither frozen under it nor
 * shared.
 */
export function tupleOf(vector: ArrayLike<number>): readonly number[] {
  if (Array.isArray(vector) && Object.isFrozen(vector)) {
    return vector as readonly number[];
  }

  return Object.freeze(Array.from(vector));
}

/** One arm's measured coordinates; a robot may extend it to carry its own telemetry. */
export class ArmState {
  /** How far a reading's stamp may run ahead of the local clock, s. */
  static readonly CLOCK_SLACK_S = 0.001;

  /** The arm's coordinates and their rates: tuples (`tupleOf`), which a control loop hands out as they are. */
  readonly position: readonly number[];
  readonly velocity: readonly number[];

  constructor(
    position: readonly number[],
    velocity: readonly number[],
    /** Local monotonic time of the reading, s, not of the caller's read. */
    readonly sampledMonotonicS: number,
    /** Tells a repeated reading from a new one at the same time. */
    readonly sampleId: SampleId = null,
  ) {
    this.position = tupleOf(position);
    this.velocity = tupleOf(velocity);
  }

  /** Throws if this reading is not one finite arm vector of `layout`. */
  check(layout: JointLayout): void {
    layout.armVector(this.position);
    layout.armVector(this.velocity);
  }

  /** Returns this reading as a snapshot's feedback at the monotonic time `now`, s. */
  feedback(now: number): ArmFeedback {
    return {
      position: this.position,
      velocity: this.velocity,
      sampled_monotonic_s: this.sampledMonotonicS,
      sample_id: this.sampleId,
      age_seconds: now - this.sampledMonotonicS,
    };
  }

  /** Whether a reading `ageS` old is recent: at most `timeoutS` old and `slackS` ahead of the clock. */
  static isFresh(ageS: number, timeoutS: number, slackS = 0.0): boolean {
    return -slackS <= ageS && ageS <= timeoutS;
  }
}
