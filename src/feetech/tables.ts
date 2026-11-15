// Ports lerobot 0.6.1's lerobot/motors/feetech/tables.py for the STS3215 (the STS and SMS series' tables), the
// constants and enumerations of lerobot/motors/feetech/feetech.py, and the sign-magnitude encoding of
// lerobot/motors/encoding_utils.py.

export const MODEL = "sts3215";

export const FIRMWARE_MAJOR_VERSION = [0, 1] as const;
export const FIRMWARE_MINOR_VERSION = [1, 1] as const;
export const MODEL_NUMBER = [3, 2] as const;

/** The servo's registers by lerobot's names: address, then size in bytes. */
export const CONTROL_TABLE = {
  // EPROM
  Firmware_Major_Version: FIRMWARE_MAJOR_VERSION, // read-only
  Firmware_Minor_Version: FIRMWARE_MINOR_VERSION, // read-only
  Model_Number: MODEL_NUMBER, // read-only
  ID: [5, 1],
  Baud_Rate: [6, 1],
  Return_Delay_Time: [7, 1],
  Response_Status_Level: [8, 1],
  Min_Position_Limit: [9, 2],
  Max_Position_Limit: [11, 2],
  Max_Temperature_Limit: [13, 1],
  Max_Voltage_Limit: [14, 1],
  Min_Voltage_Limit: [15, 1],
  Max_Torque_Limit: [16, 2],
  Phase: [18, 1],
  Unloading_Condition: [19, 1],
  LED_Alarm_Condition: [20, 1],
  P_Coefficient: [21, 1],
  D_Coefficient: [22, 1],
  I_Coefficient: [23, 1],
  Minimum_Startup_Force: [24, 2],
  CW_Dead_Zone: [26, 1],
  CCW_Dead_Zone: [27, 1],
  Protection_Current: [28, 2],
  Angular_Resolution: [30, 1],
  Homing_Offset: [31, 2],
  Operating_Mode: [33, 1],
  Protective_Torque: [34, 1],
  Protection_Time: [35, 1],
  Overload_Torque: [36, 1],
  Velocity_closed_loop_P_proportional_coefficient: [37, 1],
  Over_Current_Protection_Time: [38, 1],
  Velocity_closed_loop_I_integral_coefficient: [39, 1],
  // SRAM
  Torque_Enable: [40, 1],
  Acceleration: [41, 1],
  Goal_Position: [42, 2],
  Goal_Time: [44, 2],
  Goal_Velocity: [46, 2],
  Torque_Limit: [48, 2],
  Lock: [55, 1],
  Present_Position: [56, 2], // read-only
  Present_Velocity: [58, 2], // read-only
  Present_Load: [60, 2], // read-only
  Present_Voltage: [62, 1], // read-only
  Present_Temperature: [63, 1], // read-only
  Status: [65, 1], // read-only
  Moving: [66, 1], // read-only
  Present_Current: [69, 2], // read-only
  Goal_Position_2: [71, 2], // read-only
  // Factory
  Moving_Velocity: [80, 1],
  Moving_Velocity_Threshold: [80, 1],
  DTs: [81, 1], // ms
  Velocity_Unit_factor: [82, 1],
  Hts: [83, 1], // ns, for firmware 2.54 and later; others keep 0
  Maximum_Velocity_Limit: [84, 1],
  Maximum_Acceleration: [85, 1],
  "Acceleration_Multiplier ": [86, 1], // the name ends with a space in lerobot's table; in effect when Acceleration is 0
} as const satisfies Record<string, readonly [number, number]>;

export type RegisterName = keyof typeof CONTROL_TABLE;

/** The registers whose value is a sign and a magnitude, with the bit that holds the sign. */
export const ENCODING_TABLE: Readonly<Record<string, number>> = {
  Present_Load: 10,
  Homing_Offset: 11,
  Goal_Position: 15,
  Goal_Velocity: 15,
  Goal_Speed: 15,
  Present_Position: 15,
  Present_Velocity: 15,
  Present_Speed: 15,
};

/** The value of Baud_Rate for each baud rate. */
export const BAUDRATE_TABLE: Readonly<Record<number, number>> = {
  1_000_000: 0,
  500_000: 1,
  250_000: 2,
  128_000: 3,
  115_200: 4,
  57_600: 5,
  38_400: 6,
  19_200: 7,
};

export const SCAN_BAUDRATES = [4_800, 9_600, 14_400, 19_200, 38_400, 57_600, 115_200, 128_000, 250_000, 500_000, 1_000_000];

export const RESOLUTION = 4096; // positions in one turn
export const MODEL_NUMBER_VALUE = 777; // what an STS3215 reads at Model_Number
export const PROTOCOL_VERSION = 0;

export const DEFAULT_BAUDRATE = 1_000_000;
export const DEFAULT_TIMEOUT_MS = 1000;

/** The registers a bus reads and writes in degrees or percent through the calibration. */
export const NORMALIZED_DATA: readonly string[] = ["Goal_Position", "Present_Position"];

export const OperatingMode = { POSITION: 0, VELOCITY: 1, PWM: 2, STEP: 3 } as const;
export const DriveMode = { NON_INVERTED: 0, INVERTED: 1 } as const;
export const TorqueMode = { ENABLED: 1, DISABLED: 0 } as const;

/** Returns the address and the size of the register ``dataName``. */
export function getAddress(dataName: string): readonly [number, number] {
  const entry = (CONTROL_TABLE as Record<string, readonly [number, number]>)[dataName];
  if (entry === undefined || !Object.hasOwn(CONTROL_TABLE, dataName)) {
    throw new Error(`Address for '${dataName}' not found in ${MODEL} control table.`);
  }

  return entry;
}

/** Returns ``value`` as a magnitude with its sign in the bit ``signBitIndex``. */
export function encodeSignMagnitude(value: number, signBitIndex: number): number {
  const maxMagnitude = (1 << signBitIndex) - 1;
  const magnitude = Math.abs(value);
  if (magnitude > maxMagnitude) {
    throw new RangeError(`Magnitude ${magnitude} exceeds ${maxMagnitude} (max for sign_bit_index=${signBitIndex})`);
  }

  const directionBit = value < 0 ? 1 : 0;
  return (directionBit << signBitIndex) | magnitude;
}

/** Returns the signed value of a magnitude with its sign in the bit ``signBitIndex``. */
export function decodeSignMagnitude(encodedValue: number, signBitIndex: number): number {
  const directionBit = (encodedValue >> signBitIndex) & 1;
  const magnitude = encodedValue & ((1 << signBitIndex) - 1);

  return directionBit && magnitude !== 0 ? -magnitude : magnitude; // never a negative zero

}
