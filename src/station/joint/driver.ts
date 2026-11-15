// Ports pear/deploy/station/control/joint/driver.py.
//
// The calls are asynchronous, as every call that reaches the arm is in pear.js; PEAR's block.

import type { ArmState } from "./arm_state";

/** One target or one planned velocity for each arm, by the arm's name. */
export type ArmVectors = Readonly<Record<string, readonly number[]>>;

/** The joint hardware a control loop reads and commands: one state and one target for each arm. */
export abstract class JointDriver<State extends ArmState = ArmState> {
  /** Returns the latest reading of every arm. */
  abstract read(): Promise<Record<string, State>>;

  /** Returns a reading of every arm, after verifying that the hardware is healthy enough to hold again. */
  abstract readForRecovery(): Promise<Record<string, State>>;

  /** Commands every arm's target with its planned velocity; without velocities the targets are held. */
  abstract send(targets: ArmVectors, velocities?: ArmVectors | null): Promise<void>;

  /**
   * Renews what the driver adds to the held targets, once every control period of a HOLD (by default nothing).
   */
  async refreshHold(_targets: ArmVectors): Promise<void> {}

  /** Returns what the driver adds to the motion of a snapshot (by default nothing). */
  telemetry(): Record<string, unknown> {
    return {};
  }

  /** Releases the hardware. */
  abstract close(): Promise<void>;
}
