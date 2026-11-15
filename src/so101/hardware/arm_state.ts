// Ports pear/deploy/station/control/robots/so101/hardware/arm_state.py, with the fields and the feedback of the
// ArmState it extends (pear/deploy/station/control/joint/arm_state.py).

/** The latest low-rate poll of the servos, with PEAR's keys: it goes into a snapshot as it is. */
export interface ServoStatus {
  /** Torque_Enable of each servo. */
  torque?: Record<string, number>;
  /** The Status register of each servo. */
  status?: Record<string, number>;
  polled_monotonic_s?: number;
}

/** The SO-101 arm's reading, whose velocity is a finite difference of consecutive reads, with its servos' status. */
export interface SO101ArmState {
  /** The joint vector: the five joints in rad, then the gripper's opening. */
  position: number[];
  /** Its rate of change, per second. */
  velocity: number[];
  /** Local monotonic time of the reading, s. */
  sampledMonotonicS: number;
  /** Tells a repeated reading from a new one at the same time. */
  sampleId: number | null;
  servoStatus: ServoStatus;
}

/** A reading as a snapshot's feedback, with PEAR's keys. */
export interface ArmFeedback {
  position: number[];
  velocity: number[];
  sampled_monotonic_s: number;
  sample_id: number | null;
  age_seconds: number;
  servo: ServoStatus;
}

/** Returns ``state`` as a snapshot's feedback at the monotonic time ``now``, with the servos' status. */
export function armFeedback(state: SO101ArmState, now: number): ArmFeedback {
  return {
    position: state.position,
    velocity: state.velocity,
    sampled_monotonic_s: state.sampledMonotonicS,
    sample_id: state.sampleId,
    age_seconds: now - state.sampledMonotonicS,
    servo: structuredClone(state.servoStatus),
  };
}

/** Thrown when a servo reported an error or lost torque. */
export class ServoFault extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServoFault";
  }
}
