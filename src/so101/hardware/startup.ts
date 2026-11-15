// Ports pear/deploy/station/control/robots/so101/hardware/startup.py: the checks of the bus and of the servos that
// precede any motion. Not ported: preflight() and inventory(), which serve the command line, and lock_bus(), whose
// lock file keeps two processes off one serial device.

import type { BusOptions, MotorCalibration } from "../../feetech/bus";
import type { Transport } from "../../feetech/transport";
import { RuntimeError } from "../../python/errors";
import type { HardwareSection } from "../config";
import { SO101Follower } from "./follower";

/** The bits of the Feetech STS servos' Status register. */
export const STATUS_BITS: ReadonlyMap<number, string> = new Map([
  [0x01, "voltage"],
  [0x02, "encoder"],
  [0x04, "temperature"],
  [0x08, "current"],
  [0x20, "overload"],
]);
/** A jaw squeezing an object at its torque limit may legitimately report these. */
export const GRIPPER_LOAD_BITS = 0x08 | 0x20;

/**
 * Returns lerobot's SO-101 follower without cameras for the arm of ``hardwareConfig``, the hardware section of a
 * station's checked settings; it opens nothing yet. PEAR's finds the serial device and the calibration file through
 * the section; here the line is handed open and the calibration parsed, and the section names the line.
 */
export function makeFollower(
  hardwareConfig: HardwareSection,
  transport: Transport,
  calibration: Record<string, MotorCalibration> | null,
  busOptions: Omit<BusOptions, "port"> = {},
): SO101Follower {
  return new SO101Follower(
    transport,
    calibration,
    { useDegrees: true, positionPCoefficient: hardwareConfig.position_p_coefficient },
    { ...busOptions, port: hardwareConfig.port },
  );
}

/** Opens the bus, pings every servo and requires the arm's calibration to match the servos' registers; a mismatch
 * closes the bus with torque left as found. */
export async function connectChecked(follower: SO101Follower): Promise<void> {
  if (follower.calibration === null || Object.keys(follower.calibration).length === 0) {
    // PEAR names the missing file and its own calibrate command here
    throw new RuntimeError("No calibration: calibrate the arm with lerobot and give its calibration file");
  }

  await follower.bus.connect(true);
  let isCalibrated: boolean;
  try {
    isCalibrated = await follower.bus.isCalibrated();
  } catch (error) {
    await follower.bus.disconnect(false);
    throw error;
  }
  if (!isCalibrated) {
    await follower.bus.disconnect(false);
    throw new RuntimeError("Servo calibration registers differ from the calibration file");
  }
}

/** Returns a description of each servo whose Status bits must stop the arm. */
export function servoFaults(status: Readonly<Record<string, number>>): string[] {
  const faults: string[] = [];
  for (const [motor, value] of Object.entries(status)) {
    const mask = motor === "gripper" ? value & ~GRIPPER_LOAD_BITS : value;
    let names = [...STATUS_BITS].filter(([bit]) => mask & bit).map(([, name]) => name);
    if (mask && names.length === 0) names = [`0x${mask.toString(16).padStart(2, "0")}`];
    if (names.length > 0) faults.push(`${motor}: ${names.join(", ")}`);
  }

  return faults;
}
