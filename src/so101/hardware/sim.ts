// Not in PEAR: a simulated SO-101 on the bus's transport, calibrated as lerobot leaves an arm.

import type { MotorCalibration } from "../../feetech/bus";
import { type SimChainOptions, SimServo, SimServoChain } from "../../feetech/sim";
import { encodeSignMagnitude, ENCODING_TABLE } from "../../feetech/tables";
import { followerMotors, type MotorName } from "./motors";

/** Returns the six servos of a simulated arm, switched on and without torque, their registers holding
 * ``calibration`` as lerobot's calibration writes it; ``positions`` are Present_Position where it is not the
 * middle of a turn. */
export function simulatedArm(
  calibration: Readonly<Record<string, MotorCalibration>>,
  positions: Partial<Record<MotorName, number>> = {},
  options: SimChainOptions = {},
): SimServoChain {
  const servos = Object.entries(followerMotors()).map(([motor, { id }]) => {
    const { rangeMin, rangeMax, homingOffset } = calibration[motor];
    const servo = new SimServo(id, {
      Min_Position_Limit: rangeMin,
      Max_Position_Limit: rangeMax,
      Homing_Offset: encodeSignMagnitude(homingOffset, ENCODING_TABLE.Homing_Offset),
    });
    const position = positions[motor as MotorName];
    if (position !== undefined) servo.position = position;

    return servo;
  });

  return new SimServoChain(servos, options);
}
