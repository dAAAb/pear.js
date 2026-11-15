// Ports pear/deploy/station/control/robots/so101/hardware/driver.py: the SO-101's driver of the joint layer
// (pear/deploy/station/control/joint/driver.py, src/station/joint/driver.ts). The feedforward it adds to a target
// (pear/deploy/station/control/robots/so101/joint/feedforward.py) is given to it, or built by fromConfig as PEAR's
// constructor builds it.

import { secondsClock, type MonotonicClock } from "../../station/joint/clock";
import type { ControlConfig } from "../../station/joint/config";
import { JointDriver, type ArmVectors } from "../../station/joint/driver";
import type { JointLimitValues } from "../../station/joint/limits";
import type { SO101RobotConfig } from "../config";
import { Feedforward as SO101Feedforward } from "../joint/feedforward";
import { ARM } from "../layout";
import { ServoFault, SO101ArmState, type SO101ArmReading } from "./arm_state";
import { SO101Hardware, type SO101Line } from "./arms";
import { GRIPPER_INDEX, VECTOR_LENGTH } from "./motors";

// The one arm, which names its targets and its readings: the layout's (src/so101/layout.ts, PEAR's layout.py).
export { ARM };

/** The arm the driver reads and commands: SO101Hardware. Its readings are SO101ArmState's fields; SO101Hardware
 * hands the class. */
export interface ArmHardware {
  read(): Promise<SO101ArmReading>;
  readForRecovery(): Promise<SO101ArmReading>;
  send(target: readonly number[]): Promise<void>;
  close(): Promise<void>;
}

/** The goal offsets of the servos' P-only loop, rad for each coordinate of the joint vector. */
export interface Feedforward {
  /** The offset that holds ``target`` against gravity. */
  holdOffset(target: readonly number[]): number[];
  /** The offset for ``target`` at the planned velocity (null while held) at the monotonic time ``nowS``. */
  offset(target: readonly number[], plannedVelocity: readonly number[] | null, nowS: number): number[];
}

/** The position bounds of the joint vector, which an offset never pushes a target past: those of the joint
 * layer's JointLimits, so that a robot's `jointLimits()` is given as it is. */
export type PositionBounds = Pick<JointLimitValues, "lowerBounds" | "upperBounds">;

export interface SO101DriverOptions {
  /** The clock the feedforward's time is read on: the joint layer's, in seconds; the page's by default. */
  clock?: Pick<MonotonicClock, "monotonic">;
  /** A reading of that clock alone, MonotonicClock's `monotonic`, where no clock is at hand; it goes before
   * `clock`. */
  monotonic?: MonotonicClock["monotonic"];
  /** Told when a read failed and the last reading is kept, and when a hold goes without its gravity offset. */
  onWarning?: (message: string, error: unknown) => void;
}

/** The SO-101's servos as the control loop's driver: a target carries the feedforward's goal offset, and a bus
 * glitch keeps the last reading. */
export class SO101Driver extends JointDriver<SO101ArmState> {
  static readonly OFFSET_EPSILON = 1e-6; // a held target's offset this close to the one sent needs no new command

  private offset: number[] = new Array<number>(VECTOR_LENGTH).fill(0); // the goal offset last sent
  private state: SO101ArmState | null = null; // the last reading returned
  private hasCommanded = false; // whether a target was sent, after which a bus glitch is tolerated
  private readonly monotonic: () => number;
  private readonly onWarning: (message: string, error: unknown) => void;

  /** ``hardware`` is the arm, enabled; ``feedforward`` is null when the servos get no goal offsets. */
  constructor(
    readonly hardware: ArmHardware,
    private readonly limits: PositionBounds,
    private readonly feedforward: Feedforward | null = null,
    options: SO101DriverOptions = {},
  ) {
    super();
    const clock = options.clock ?? secondsClock();
    this.monotonic = options.monotonic ?? (() => clock.monotonic());
    this.onWarning = options.onWarning ?? (() => undefined);
  }

  /**
   * Returns the driver PEAR's SO101Driver(control_config, robot_config) is: the arm made and enabled from the
   * station's checked settings (SO101Hardware.fromConfig), the position bounds of its limits, and the feedforward of
   * its settings, built with the arm enabled; if that fails the arm is released.
   */
  static async fromConfig(controlConfig: ControlConfig, robotConfig: SO101RobotConfig, line: SO101Line): Promise<SO101Driver> {
    const limits = robotConfig.jointLimits(); // whose position bounds an offset never pushes a target past
    const hardware = await SO101Hardware.fromConfig(controlConfig, robotConfig, line);

    let feedforward: Feedforward | null;
    try {
      feedforward = robotConfig.feedforward === null ? null : new SO101Feedforward(robotConfig.feedforward);
    } catch (error) {
      await hardware.close();
      throw error;
    }

    return new SO101Driver(hardware, limits, feedforward, { clock: line.clock, onWarning: line.onWarning });
  }

  /** Returns the arm's reading; after a bus glitch, the previous one. */
  async read(): Promise<Record<string, SO101ArmState>> {
    try {
      this.state = SO101ArmState.of(await this.hardware.read());
    } catch (error) {
      // a servo's fault is never a glitch, nor is a failed read before the first command, while enabling settles;
      // a glitch's reading ages until the control loop finds it stale
      if (error instanceof ServoFault || !this.hasCommanded) throw error;
      this.onWarning(`feedback read failed: ${error instanceof Error ? error.message : String(error)}`, error);
    }

    // (as PEAR's: there is no reading yet only when a command went before the first read and that read failed,
    // which a control loop, reading first, never does)
    return { [ARM]: this.state as SO101ArmState };
  }

  /** Returns the arm's reading after checking that every servo is healthy and still holds torque. */
  async readForRecovery(): Promise<Record<string, SO101ArmState>> {
    this.state = SO101ArmState.of(await this.hardware.readForRecovery());

    return { [ARM]: this.state };
  }

  /** Commands the arm's target with the feedforward of its planned velocity; without velocities it is held. */
  async send(targets: ArmVectors, velocities: ArmVectors | null = null): Promise<void> {
    const target = targets[ARM];
    if (velocities === null) {
      await this.hold(target);
    } else {
      await this.move(target, velocities[ARM]);
    }

    this.hasCommanded = true;
  }

  /** Sends the held target again while the friction offset of the last move fades. */
  override async refreshHold(targets: ArmVectors): Promise<void> {
    await this.move(targets[ARM], null, true);
  }

  /** Returns the arm joints' current feedforward offsets, rad. */
  override telemetry(): { feedforward: number[] } {
    return { feedforward: this.offset.slice(0, GRIPPER_INDEX) };
  }

  /** Releases the arm, which disables its torque. */
  async close(): Promise<void> {
    await this.hardware.close();
  }

  /** Holds ``target`` with the gravity offset alone. */
  private async hold(target: readonly number[]): Promise<void> {
    let offset = new Array<number>(VECTOR_LENGTH).fill(0);
    if (this.feedforward !== null) {
      // a fault's hold never depends on the gravity model
      try {
        offset = this.feedforward.holdOffset(target);
      } catch (error) {
        this.onWarning("Gravity feedforward failed; holding without it", error);
      }
    }

    await this.hardware.send(this.goal(target, offset));
    this.offset = offset;
  }

  /** Commands ``target`` with the feedforward of ``plannedVelocity``, unless ``skipsUnchanged`` and its offset is
   * the one sent. */
  private async move(target: readonly number[], plannedVelocity: readonly number[] | null, skipsUnchanged = false): Promise<void> {
    let offset = new Array<number>(VECTOR_LENGTH).fill(0);
    if (this.feedforward !== null) offset = this.feedforward.offset(target, plannedVelocity, this.monotonic());
    const isUnchanged = offset.every((value, index) => Math.abs(value - this.offset[index]) <= SO101Driver.OFFSET_EPSILON);
    if (skipsUnchanged && isUnchanged) return;

    await this.hardware.send(this.goal(target, offset));
    this.offset = offset;
  }

  /** Returns ``target`` plus ``offset``, never further past a bound than ``target`` itself. */
  private goal(target: readonly number[], offset: readonly number[]): number[] {
    return target.map((coordinate, index) => {
      const lowerBound = Math.min(this.limits.lowerBounds[index], coordinate);
      const upperBound = Math.max(this.limits.upperBounds[index], coordinate);

      return Math.min(Math.max(coordinate + offset[index], lowerBound), upperBound);
    });
  }
}
