// Ports pear/deploy/station/control/joint/arm_state.py.

import type { ArmFeedback, SampleId } from "../schemas";
import type { JointLayout } from "./layout";

/** One arm's measured coordinates; a robot may extend it to carry its own telemetry. */
export class ArmState {
  /** How far a reading's stamp may run ahead of the local clock, s. */
  static readonly CLOCK_SLACK_S = 0.001;

  constructor(
    readonly position: readonly number[],
    readonly velocity: readonly number[],
    /** Local monotonic time of the reading, s, not of the caller's read. */
    readonly sampledMonotonicS: number,
    /** Tells a repeated reading from a new one at the same time. */
    readonly sampleId: SampleId = null,
  ) {}

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
