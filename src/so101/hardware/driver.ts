// Ports pear/deploy/station/control/robots/so101/hardware/driver.py. The feedforward it adds to a target
// (pear/deploy/station/control/robots/so101/joint/feedforward.py) is given to it, not built here.

import { ServoFault, type SO101ArmState } from "./arm_state";
import { GRIPPER_INDEX, VECTOR_LENGTH } from "./motors";

/** The one arm, which names its targets and its readings (PEAR's layout). */
export const ARM = "arm";

/** The arm the driver reads and commands: SO101Hardware. */
export interface ArmHardware {
  read(): Promise<SO101ArmState>;
  readForRecovery(): Promise<SO101ArmState>;
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

/** The position bounds of the joint vector, which an offset never pushes a target past. */
export interface PositionBounds {
  lowerBounds: readonly number[];
  upperBounds: readonly number[];
}

export interface SO101DriverOptions {
  /** A monotonic clock, s; the page's by default. */
  monotonic?: () => number;
  /** Told when a read failed and the last reading is kept, and when a hold goes without its gravity offset. */
  onWarning?: (message: string, error: unknown) => void;
}

/** The SO-101's servos as the control loop's driver: a target carries the feedforward's goal offset, and a bus
 * glitch keeps the last reading. */
export class SO101Driver {
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
    this.monotonic = options.monotonic ?? (() => performance.now() / 1000);
    this.onWarning = options.onWarning ?? (() => undefined);
  }

  /** Returns the arm's reading; after a bus glitch, the previous one. */
  async read(): Promise<Record<string, SO101ArmState | null>> {
    try {
      this.state = await this.hardware.read();
    } catch (error) {
      // a servo's fault is never a glitch, nor is a failed read before the first command, while enabling settles;
      // a glitch's reading ages until the control loop finds it stale
      if (error instanceof ServoFault || !this.hasCommanded) throw error;
      this.onWarning(`feedback read failed: ${error instanceof Error ? error.message : String(error)}`, error);
    }

    return { [ARM]: this.state };
  }

  /** Returns the arm's reading after checking that every servo is healthy and still holds torque. */
  async readForRecovery(): Promise<Record<string, SO101ArmState | null>> {
    this.state = await this.hardware.readForRecovery();

    return { [ARM]: this.state };
  }

  /** Commands the arm's target with the feedforward of its planned velocity; without velocities it is held. */
  async send(
    targets: Readonly<Record<string, readonly number[]>>,
    velocities: Readonly<Record<string, readonly number[]>> | null = null,
  ): Promise<void> {
    const target = targets[ARM];
    if (velocities === null) {
      await this.hold(target);
    } else {
      await this.move(target, velocities[ARM]);
    }

    this.hasCommanded = true;
  }

  /** Sends the held target again while the friction offset of the last move fades. */
  async refreshHold(targets: Readonly<Record<string, readonly number[]>>): Promise<void> {
    await this.move(targets[ARM], null, true);
  }

  /** Returns the arm joints' current feedforward offsets, rad. */
  telemetry(): { feedforward: number[] } {
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
