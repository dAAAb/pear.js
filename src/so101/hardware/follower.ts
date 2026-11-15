// Ports what PEAR uses of lerobot 0.6.1's SO-101 follower: lerobot/robots/so_follower/so_follower.py and
// config_so_follower.py (the servos, configure(), disconnect()), and the calibration file that
// lerobot/robots/robot.py reads and writes.

import { type BusOptions, FeetechMotorsBus, type MotorCalibration } from "../../feetech/bus";
import { OperatingMode } from "../../feetech/tables";
import type { Transport } from "../../feetech/transport";
import { followerMotors } from "./motors";

/** lerobot's settings of the follower, with its defaults. */
export interface FollowerConfig {
  /** Whether the joints are read in degrees; PEAR's station needs true. */
  useDegrees: boolean;
  // the position loop's gains, written to every servo by configure()
  positionPCoefficient: number;
  positionICoefficient: number;
  positionDCoefficient: number;
  disableTorqueOnDisconnect: boolean;
}

export const DEFAULT_FOLLOWER_CONFIG: FollowerConfig = {
  useDegrees: true,
  positionPCoefficient: 16,
  positionICoefficient: 0,
  positionDCoefficient: 32,
  disableTorqueOnDisconnect: true,
};

/** The SO-101 follower arm's bus with lerobot's settings of its servos; it has no cameras. */
export class SO101Follower {
  readonly bus: FeetechMotorsBus;
  readonly config: FollowerConfig;

  /** ``calibration`` is the arm's calibration file, parseCalibration(); null when there is none. */
  constructor(
    transport: Transport,
    readonly calibration: Record<string, MotorCalibration> | null,
    config: Partial<FollowerConfig> = {},
    busOptions: BusOptions = {},
  ) {
    this.config = { ...DEFAULT_FOLLOWER_CONFIG, ...config };
    this.bus = new FeetechMotorsBus(transport, followerMotors(this.config.useDegrees), calibration, busOptions);
  }

  get isConnected(): boolean {
    return this.bus.isConnected;
  }

  /** Writes the servos' settings with torque off, and ends with torque on. */
  async configure(): Promise<void> {
    const bus = this.bus;
    await bus.torqueDisabled(async () => {
      await bus.configureMotors();
      for (const motor of Object.keys(bus.motors)) {
        await bus.write("Operating_Mode", motor, OperatingMode.POSITION);
        await bus.write("P_Coefficient", motor, this.config.positionPCoefficient);
        await bus.write("I_Coefficient", motor, this.config.positionICoefficient);
        await bus.write("D_Coefficient", motor, this.config.positionDCoefficient);

        if (motor === "gripper") {
          await bus.write("Max_Torque_Limit", motor, 500); // half the torque, so that the jaw's servo does not burn
          await bus.write("Protection_Current", motor, 250); // half the current
          await bus.write("Overload_Torque", motor, 25); // a quarter of the torque once overloaded
        }
      }
    });
  }

  async disconnect(): Promise<void> {
    await this.bus.disconnect(this.config.disableTorqueOnDisconnect);
  }
}

const CALIBRATION_FIELDS = [
  ["id", "id"],
  ["drive_mode", "driveMode"],
  ["homing_offset", "homingOffset"],
  ["range_min", "rangeMin"],
  ["range_max", "rangeMax"],
] as const;

/** Returns the calibration in the text of one of lerobot's calibration files: a JSON object with, for each motor,
 * the integers id, drive_mode, homing_offset, range_min and range_max. */
export function parseCalibration(text: string): Record<string, MotorCalibration> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("A calibration file holds one JSON object");
  }

  const calibration: Record<string, MotorCalibration> = {};
  for (const [motor, entry] of Object.entries(parsed)) {
    if (typeof entry !== "object" || entry === null) throw new TypeError(`Calibration of '${motor}' is not an object`);
    const fields = entry as Record<string, unknown>;
    const values = CALIBRATION_FIELDS.map(([key]) => {
      const value = fields[key];
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new TypeError(`Calibration of '${motor}': ${key} is not an integer`);
      }
      return value;
    });
    calibration[motor] = {
      id: values[0],
      driveMode: values[1],
      homingOffset: values[2],
      rangeMin: values[3],
      rangeMax: values[4],
    };
  }

  return calibration;
}

/** Returns ``calibration`` as the text of one of lerobot's calibration files. */
export function serializeCalibration(calibration: Readonly<Record<string, MotorCalibration>>): string {
  const entries = Object.entries(calibration).map(([motor, entry]) => [
    motor,
    Object.fromEntries(CALIBRATION_FIELDS.map(([key, field]) => [key, entry[field]])),
  ]);

  return JSON.stringify(Object.fromEntries(entries), null, 4);
}
