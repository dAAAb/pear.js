// Ports pear/deploy/station/control/robots/so101/hardware/arms.py.

import { FeetechCommError } from "../../feetech/bus";
import { type ServoStatus, ServoFault, type SO101ArmState } from "./arm_state";
import type { SO101Follower } from "./follower";
import { GRIPPER_INDEX, JOINTS, MOTORS, VECTOR_LENGTH } from "./motors";
import { connectChecked, servoFaults } from "./startup";

const RAD_PER_DEGREE = Math.PI / 180; // numpy's radians() multiplies by this
const DEGREES_PER_RAD = 180 / Math.PI; // and its degrees() by this

/** What PEAR's settings give the arm (HardwareConfig, ControlConfig) and what stands for its process's clock. */
export interface SO101HardwareOptions {
  /** A software zero correction on top of lerobot's calibration, rad for each of the five joints: a joint's
   * angle is lerobot's reading plus it. */
  jointOffsets: readonly number[];
  /** The reads between two polls of the servos' Status, and of their Torque_Enable half a cycle apart. */
  statusPollTicks: number;
  /** The age past which a reading of the joints is stale, s: a velocity is not taken over a longer gap. */
  stateTimeoutS: number;
  /** A monotonic clock, s; the page's by default. */
  monotonic?: () => number;
  /** Told when enabling the arm is tried again. */
  onWarning?: (message: string) => void;
}

/** Returns a mapping of servo values as Python prints a dict. */
function formatValues(values: Readonly<Record<string, number>>): string {
  return `{${Object.entries(values)
    .map(([motor, value]) => `'${motor}': ${value}`)
    .join(", ")}}`;
}

/** The SO-101 follower arm through the Feetech bus, read and commanded in rad and as the gripper's opening. */
export class SO101Hardware {
  static readonly ENABLE_ATTEMPTS = 3; // how many times enabling the arm is tried
  static readonly BUS_RETRIES = 2; // per register access while enabling and checking
  static readonly RUN_RETRIES = 1; // per bus access while running

  isClosed = false;
  private readonly jointOffsets: readonly number[];
  private readonly statusPollTicks: number;
  private readonly stateTimeoutS: number;
  private readonly monotonic: () => number;
  private readonly onWarning: (message: string) => void;
  private readCount = 0;
  private previousRead: { time: number; position: number[] } | null = null; // the last read
  private servoStatus: ServoStatus = {}; // the servos' torque and Status as last polled

  private constructor(
    readonly follower: SO101Follower,
    options: SO101HardwareOptions,
  ) {
    if (options.jointOffsets.length !== JOINTS.length) throw new RangeError(`Expected ${JOINTS.length} joint offsets`);
    this.jointOffsets = [...options.jointOffsets];
    this.statusPollTicks = options.statusPollTicks;
    this.stateTimeoutS = options.stateTimeoutS;
    this.monotonic = options.monotonic ?? (() => performance.now() / 1000);
    this.onWarning = options.onWarning ?? (() => undefined);
  }

  /** Connects the arm with its calibration checked, holds its current pose with torque on and checks its servos.
   * If enabling or the check fails, torque is disabled and the bus closed. */
  static async open(follower: SO101Follower, options: SO101HardwareOptions): Promise<SO101Hardware> {
    const hardware = new SO101Hardware(follower, options);
    try {
      await connectChecked(follower);
      try {
        await hardware.enable();
        await hardware.checkServos();
      } catch (error) {
        await follower.bus.disconnect(true);
        throw error;
      }
    } catch (error) {
      // Python drops the follower here, and lerobot's Robot.__del__ disconnects one that is still connected (a
      // failed handshake or a failed disconnect leaves it so), whatever that raises: torque off as far as the bus
      // allows. If that fails too the transport stays open, for its owner to close.
      if (follower.isConnected) await follower.disconnect().catch(() => undefined);
      throw error;
    }

    return hardware;
  }

  /** Returns the arm's reading, polling the servos' status at a low rate. */
  async read(): Promise<SO101ArmState> {
    if (this.isClosed) throw new Error("Hardware is closed");

    const values = await this.follower.bus.syncRead("Present_Position", null, { numRetry: SO101Hardware.RUN_RETRIES });
    const now = this.monotonic();
    const position = SO101Hardware.busPosition(values, this.jointOffsets);

    let velocity: number[] = new Array<number>(VECTOR_LENGTH).fill(0);
    if (this.previousRead !== null) {
      const previous = this.previousRead.position;
      const elapsedS = now - this.previousRead.time;
      if (0 < elapsedS && elapsedS <= this.stateTimeoutS) {
        velocity = position.map((coordinate, index) => (coordinate - previous[index]) / elapsedS);
      }
    }
    this.previousRead = { time: now, position };

    this.readCount += 1;
    await this.poll();
    return {
      position: [...position],
      velocity,
      sampledMonotonicS: now,
      sampleId: this.readCount,
      servoStatus: { ...this.servoStatus },
    };
  }

  /** Returns the arm's reading after checking that every servo is healthy and still holds torque. */
  async readForRecovery(): Promise<SO101ArmState> {
    await this.checkServos();

    return this.read();
  }

  /** Commands the joint vector ``target``. */
  async send(target: readonly number[]): Promise<void> {
    if (this.isClosed) throw new Error("Hardware is closed");

    if (target.length !== VECTOR_LENGTH || !target.every((coordinate) => Number.isFinite(coordinate))) {
      throw new RangeError("Expected a finite 6D target");
    }
    const goal: Record<string, number> = {};
    JOINTS.forEach((joint, index) => {
      goal[joint] = (target[index] - this.jointOffsets[index]) * DEGREES_PER_RAD;
    });
    goal.gripper = target[GRIPPER_INDEX] * 100; // the bus takes the gripper's opening in percent

    await this.follower.bus.syncWrite("Goal_Position", goal, { numRetry: SO101Hardware.RUN_RETRIES });
  }

  /** Disables torque and releases the bus, so that the arm goes limp. */
  async close(): Promise<void> {
    if (this.isClosed) return;

    this.isClosed = true;
    await this.follower.disconnect();
  }

  /** Returns the joint vector of the bus's position readings: the joints in rad with their offsets, then the
   * gripper's opening. */
  static busPosition(values: Readonly<Record<string, number>>, jointOffsets: readonly number[]): number[] {
    const position = JOINTS.map((joint, index) => values[joint] * RAD_PER_DEGREE + jointOffsets[index]);
    position.push(values.gripper / 100); // the bus reports the gripper's opening in percent

    return position;
  }

  /** Holds the current pose, the goal verified before torque goes on. */
  private async enable(): Promise<void> {
    // after power-up the goal registers read 0 and enabling torque does not set them; a sync write gets no reply,
    // so the goal is read back: a servo that missed it would jump to 0. A retry may briefly release torque, as
    // configure() does
    const bus = this.follower.bus;
    const access = { normalize: false, numRetry: SO101Hardware.BUS_RETRIES };

    for (let attempt = 1; ; attempt++) {
      try {
        const presentPositions = await bus.syncRead("Present_Position", null, access);
        await bus.syncWrite("Goal_Position", presentPositions, access);
        const goalPositions = await bus.syncRead("Goal_Position", null, access);
        if (MOTORS.some((motor) => goalPositions[motor] !== presentPositions[motor])) {
          throw new FeetechCommError(
            `Goal_Position read back ${formatValues(goalPositions)}, wrote ${formatValues(presentPositions)}`,
          );
        }
        await this.follower.configure(); // the servos' settings; it ends by enabling torque
        return;
      } catch (error) {
        if (!(error instanceof FeetechCommError) || attempt === SO101Hardware.ENABLE_ATTEMPTS) throw error;
        this.onWarning(`Enable attempt ${attempt} failed, retrying: ${error.message}`);
      }
    }
  }

  /** Polls the servos' torque and Status, and throws ServoFault unless every servo holds torque and reports no
   * error. */
  private async checkServos(): Promise<void> {
    const bus = this.follower.bus;
    const access = { normalize: false, numRetry: SO101Hardware.BUS_RETRIES };
    const torqueEnabled = await bus.syncRead("Torque_Enable", null, access);
    const status = await bus.syncRead("Status", null, access);
    this.servoStatus = { torque: torqueEnabled, status, polled_monotonic_s: this.monotonic() };

    SO101Hardware.checkTorque(torqueEnabled);
    SO101Hardware.checkStatus(status);
  }

  /** Polls the servos' Status or their torque when it is their turn, interleaved with the position reads. */
  private async poll(): Promise<void> {
    const phase = this.readCount % this.statusPollTicks;
    const bus = this.follower.bus;
    const access = { normalize: false, numRetry: SO101Hardware.RUN_RETRIES };

    if (phase === 0) {
      const status = await bus.syncRead("Status", null, access);
      this.servoStatus = { ...this.servoStatus, status, polled_monotonic_s: this.monotonic() };
      SO101Hardware.checkStatus(status);
    } else if (phase === Math.floor(this.statusPollTicks / 2)) {
      // half a poll cycle after the Status
      const torqueEnabled = await bus.syncRead("Torque_Enable", null, access);
      this.servoStatus = { ...this.servoStatus, torque: torqueEnabled, polled_monotonic_s: this.monotonic() };
      SO101Hardware.checkTorque(torqueEnabled);
    }
  }

  /** Throws ServoFault unless every servo holds torque. */
  static checkTorque(torqueEnabled: Readonly<Record<string, number>>): void {
    const motorsWithoutTorque = MOTORS.filter((motor) => torqueEnabled[motor] !== 1);
    if (motorsWithoutTorque.length > 0) {
      throw new ServoFault(`Servo torque is off: ${motorsWithoutTorque.join(", ")}`);
    }
  }

  /** Throws ServoFault if a servo's Status reports an error that must stop the arm. */
  static checkStatus(status: Readonly<Record<string, number>>): void {
    const faults = servoFaults(status);
    if (faults.length > 0) throw new ServoFault("Servo error: " + faults.join("; "));
  }
}
