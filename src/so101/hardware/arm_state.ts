// Ports pear/deploy/station/control/robots/so101/hardware/arm_state.py: the SO-101's reading, which extends the
// joint layer's ArmState (pear/deploy/station/control/joint/arm_state.py, src/station/joint/arm_state.ts) by its
// servos' status, and the fault of a servo.

import { RuntimeError } from "../../python/errors";
import { ArmState } from "../../station/joint/arm_state";
import type { ArmFeedback as JointArmFeedback } from "../../station/schemas";

/** The latest low-rate poll of the servos, with PEAR's keys: it goes into a snapshot as it is. */
export interface ServoStatus {
  /** Torque_Enable of each servo. */
  torque?: Record<string, number>;
  /** The Status register of each servo. */
  status?: Record<string, number>;
  polled_monotonic_s?: number;
}

/**
 * A reading as a snapshot's feedback, with PEAR's keys: the joint layer's ArmFeedback (src/station/schemas.ts), to
 * which the SO-101 adds its servos' status.
 */
export interface ArmFeedback extends JointArmFeedback {
  position: number[];
  velocity: number[];
  sample_id: number | null;
  servo: ServoStatus;
}

/** The fields of a reading of the SO-101 arm, without the class: what an arm under the driver may hand as plain
 * data (SO101Hardware hands the class itself). */
export type SO101ArmReading = Pick<
  SO101ArmState,
  "position" | "velocity" | "sampledMonotonicS" | "sampleId" | "servoStatus"
>;

/** The SO-101 arm's reading, whose velocity is a finite difference of consecutive reads, with its servos' status. */
export class SO101ArmState extends ArmState {
  /** The joint vector: the five joints in rad, then the gripper's opening. */
  declare readonly position: number[];
  /** Its rate of change, per second. */
  declare readonly velocity: number[];
  /** Tells a repeated reading from a new one at the same time: the arm's count of its reads. */
  declare readonly sampleId: number | null;

  constructor(
    position: number[],
    velocity: number[],
    /** Local monotonic time of the reading, s. */
    sampledMonotonicS: number,
    sampleId: number | null = null,
    /** The latest low-rate poll of the servos' status. */
    readonly servoStatus: ServoStatus = {},
  ) {
    super(position, velocity, sampledMonotonicS, sampleId);
  }

  /** Returns this reading as a snapshot's feedback at the monotonic time `now`, with the servos' status. */
  override feedback(now: number): ArmFeedback {
    return { ...(super.feedback(now) as ArmFeedback), servo: structuredClone(this.servoStatus) };
  }

  /**
   * Returns `reading` as an arm's state of the joint layer: itself when it is one (SO101Hardware's is the class),
   * and otherwise a state that holds the reading's own fields. An arm that stands under the driver in a test may
   * hand its readings as plain data; the control loop asks a state to check itself and for its feedback.
   */
  static of(reading: SO101ArmReading): SO101ArmState {
    if (reading instanceof ArmState) {
      return reading as SO101ArmState;
    }

    return Object.assign(Object.create(SO101ArmState.prototype) as SO101ArmState, reading);
  }
}

/** Returns ``state`` as a snapshot's feedback at the monotonic time ``now``, with the servos' status: what
 * SO101ArmState.feedback returns, also of a reading that is plain data. */
export function armFeedback(state: SO101ArmReading, now: number): ArmFeedback {
  return SO101ArmState.of(state).feedback(now);
}

/** Thrown when a servo reported an error or lost torque. */
export class ServoFault extends RuntimeError {
  override readonly name: string = "ServoFault";
}
