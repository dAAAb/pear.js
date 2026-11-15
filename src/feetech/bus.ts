// Ports lerobot 0.6.1's bus for Feetech servos, for a chain of STS3215: lerobot/motors/motors_bus.py
// (SerialMotorsBus) and lerobot/motors/feetech/feetech.py (FeetechMotorsBus), over the SDK's port_handler.py with
// the packet timeout lerobot patches into it (patch_setPacketTimeout) and the SDK's GroupSyncRead and GroupSyncWrite.

import {
  ConnectionError,
  KeyError,
  NotImplementedError,
  OSError,
  OverflowError,
  RuntimeError,
  StopIteration,
  ValueError,
} from "../python/errors";
import {
  COMM_NOT_AVAILABLE,
  COMM_SUCCESS,
  getRxPacketError,
  getTxRxResult,
  makeDword,
  makeWord,
  type PacketPort,
  ping,
  readRx,
  readTxRx,
  RXPACKET_MAX_LEN,
  splitIntoByteChunks,
  syncReadParameters,
  syncReadTx,
  syncWriteParameters,
  syncWriteTxOnly,
  valueOf,
  writeTxRx,
} from "./protocol";
import {
  DEFAULT_BAUDRATE,
  DEFAULT_TIMEOUT_MS,
  decodeSignMagnitude,
  encodeSignMagnitude,
  ENCODING_TABLE,
  FIRMWARE_MAJOR_VERSION,
  FIRMWARE_MINOR_VERSION,
  getAddress,
  MODEL_NUMBER_VALUE,
  NORMALIZED_DATA,
  type RegisterName,
  RESOLUTION,
  TorqueMode,
} from "./tables";
import { type Clock, systemClock, type Transport } from "./transport";

/** How a bus reports a motor's position: lerobot's MotorNormMode. */
export type MotorNormMode = "range_0_100" | "range_m100_100" | "degrees";

/** One STS3215 on the bus. */
export interface Motor {
  id: number;
  normMode: MotorNormMode;
}

/** lerobot's calibration of one motor; positions are the servo's steps. */
export interface MotorCalibration {
  id: number;
  driveMode: number;
  homingOffset: number;
  rangeMin: number;
  rangeMax: number;
}

export type NameOrId = string | number;

export interface AccessOptions {
  /** Whether Goal_Position and Present_Position go through the calibration; true by default. */
  normalize?: boolean;
  /** Further attempts after a failed packet exchange, at once and without clearing the line; 0 by default. */
  numRetry?: number;
}

export interface BusOptions {
  /** The line's baud rate, which the packet timeouts are computed from; the servos' 1 000 000 by default. */
  baudrate?: number;
  clock?: Clock;
  /** The name of the line in messages. */
  port?: string;
}

// The errors of this file are the exceptions lerobot raises at the same places, under Python's names
// (src/python/errors.ts): what a station reports of a failed action is the name of its error's class.

/** A packet exchange failed: nothing or something corrupt came back. lerobot raises Python's ConnectionError, and
 * this is one: its `name` is "ConnectionError". It also keeps the SDK's result. */
export class FeetechCommError extends ConnectionError {
  constructor(
    message: string,
    /** The SDK's result of the exchange, COMM_*. */
    readonly result: number | null = null,
  ) {
    super(message);
  }
}

/** A servo answered with error bits in its status packet. lerobot raises Python's RuntimeError, and this is one:
 * its `name` is "RuntimeError". It also keeps the error byte. */
export class FeetechStatusError extends RuntimeError {
  constructor(
    message: string,
    /** The status packet's error byte. */
    readonly error: number,
  ) {
    super(message);
  }
}

/** lerobot's DeviceAlreadyConnectedError (lerobot/utils/errors.py): a ConnectionError. */
export class DeviceAlreadyConnectedError extends ConnectionError {
  override readonly name: string = "DeviceAlreadyConnectedError";
}

/** lerobot's DeviceNotConnectedError (lerobot/utils/errors.py): a ConnectionError. */
export class DeviceNotConnectedError extends ConnectionError {
  override readonly name: string = "DeviceNotConnectedError";
}

const NO_BYTES = new Uint8Array(0);

/** The SDK's PortHandler on a transport: the packet layer's port, with the time a status packet is given. */
export class PortHandler implements PacketPort {
  isOpen = false;
  isUsing = false;
  /** How long the status packet in hand may take, ms. */
  packetTimeout = 0;
  /** How long one byte takes on the line, ms: a start bit, eight data bits and a stop bit. */
  readonly txTimePerByte: number;
  /** Whether clearPort() discards what waits in the input. The SDK never does: with false the line is read as the
   * SDK reads it, which a replay of the SDK's own traffic needs. */
  discardsInput = true;
  private packetDeadline = 0; // on the clock, ms

  constructor(
    private readonly transport: Transport,
    readonly baudrate: number,
    private readonly clock: Clock,
  ) {
    this.txTimePerByte = (1000.0 / baudrate) * 10.0;
  }

  async clearPort(): Promise<void> {
    // pyserial's flush() waits for the bytes written to leave; a transport's write() resolves when they have.
    // Not the SDK's, which never empties its input: bytes that wait there when an instruction packet is about to
    // be written answer an earlier one, came too late for it and would be taken for this one's answer, so they
    // are discarded (docs/progress/feetech.md, "Deliberate differences"). A read of no time only looks
    if (!this.discardsInput) return;
    while ((await this.transport.read(RXPACKET_MAX_LEN, 0)).length > 0);
  }

  async closePort(): Promise<void> {
    await this.transport.close();
    this.isOpen = false;
  }

  async writePort(packet: Uint8Array): Promise<number> {
    await this.transport.write(packet);

    return packet.length;
  }

  async readPort(length: number): Promise<ArrayLike<number>> {
    if (length <= 0) return NO_BYTES;

    return this.transport.read(length, Math.max(this.packetDeadline - this.clock.now(), 0));
  }

  /** lerobot's timeout, not the SDK's own: the packet's time on the line, three more bytes' and 50 ms. */
  setPacketTimeout(packetLength: number): void {
    this.setPacketTimeoutMillis(this.txTimePerByte * packetLength + this.txTimePerByte * 3.0 + 50);
  }

  setPacketTimeoutMillis(msec: number): void {
    this.packetTimeout = msec;
    this.packetDeadline = this.clock.now() + msec;
  }

  /** Whether the packet's time is up; once it is, it stays so until a timeout is set again. */
  isPacketTimeout(): boolean {
    // The SDK compares the time since the packet's start with the timeout, and asks for more. Here the clock is
    // compared with the packet's deadline, and reaching it is enough: a wait of exactly the time left then ends,
    // whatever the rounding of the clock's sums
    if (this.clock.now() >= this.packetDeadline) {
      this.packetTimeout = 0;
      return true;
    }

    return false;
  }
}

/** Returns the integer Python's int() makes of ``value``: toward zero, and never a negative zero. Of a NaN
 * int() raises ValueError, of an infinity OverflowError. */
function toInt(value: number): number {
  if (Number.isNaN(value)) throw new ValueError(`cannot convert ${value} to integer`);
  if (!Number.isFinite(value)) throw new OverflowError(`cannot convert ${value} to integer`);

  return Math.trunc(value) + 0;
}

/** Returns a mapping of numbers as Python prints a dict, on one line. */
function formatDict(entries: Iterable<readonly [number, number | string]>): string {
  const items = [...entries].map(([key, value]) => `${key}: ${typeof value === "string" ? `'${value}'` : value}`);

  return `{${items.join(", ")}}`;
}

/**
 * A chain of STS3215 servos on one half-duplex line, as lerobot's FeetechMotorsBus reads and writes it: registers by
 * name, positions in degrees or percent through the calibration, sync reads and sync writes.
 *
 * The transport is given open and closed by disconnect(); connect() only checks the servos. Every packet exchange
 * with its retries waits for the one before, so that two callers never overlap on the line.
 */
export class FeetechMotorsBus {
  static readonly APPLY_DRIVE_MODE = true;

  readonly portHandler: PortHandler;
  readonly port: string;
  /** The calibration positions are normalized with; writeCalibration() replaces it. */
  calibration: Record<string, MotorCalibration>;
  private readonly idToName = new Map<number, string>();
  private lastExchange: Promise<unknown> = Promise.resolve();

  constructor(
    transport: Transport,
    readonly motors: Readonly<Record<string, Motor>>,
    calibration: Record<string, MotorCalibration> | null = null,
    options: BusOptions = {},
  ) {
    this.calibration = calibration ?? {};
    this.port = options.port ?? "serial";
    this.portHandler = new PortHandler(transport, options.baudrate ?? DEFAULT_BAUDRATE, options.clock ?? systemClock);
    for (const [name, motor] of Object.entries(motors)) this.idToName.set(motor.id, name);
    if (this.idToName.size !== Object.keys(motors).length) throw new ValueError("Some motors have the same id!");
  }

  get ids(): number[] {
    return Object.values(this.motors).map((motor) => motor.id);
  }

  get isConnected(): boolean {
    return this.portHandler.isOpen;
  }

  /** Marks the bus connected and, with ``handshake``, pings every motor, checks its model and that all run one
   * firmware. A failed check leaves the bus connected, as lerobot does. */
  async connect(handshake = true): Promise<void> {
    if (this.isConnected) throw new DeviceAlreadyConnectedError("FeetechMotorsBus is already connected.");

    this.portHandler.isOpen = true;
    if (handshake) {
      try {
        await this.assertMotorsExist();
        await this.assertSameFirmware();
      } catch (error) {
        // lerobot: except (FileNotFoundError, OSError, serial.SerialException), which the ConnectionError of a
        // failed exchange is; a motor check that failed (RuntimeError) is not
        if (!(error instanceof OSError)) throw error;
        throw new FeetechCommError(
          `\nCould not connect on port '${this.port}'. Make sure you are using the correct port.` +
            "\nTry running `lerobot-find-port`\n",
          error instanceof FeetechCommError ? error.result : null,
        );
      }
    }
    this.portHandler.setPacketTimeoutMillis(DEFAULT_TIMEOUT_MS);
  }

  /** Closes the transport, after disabling every motor's torque unless ``disableTorque`` is false. */
  async disconnect(disableTorque = true): Promise<void> {
    this.checkConnected();

    if (disableTorque) {
      await this.portHandler.clearPort();
      this.portHandler.isUsing = false;
      await this.disableTorque(null, 5);
    }
    await this.portHandler.closePort();
  }

  /** Returns the model number of the motor that answers a ping, or null when none does or it reports an error;
   * with ``raiseOnError`` those throw. */
  async ping(motor: NameOrId, numRetry = 0, raiseOnError = false): Promise<number | null> {
    const id = this.getMotorId(motor);
    const { modelNumber, result, error } = await this.exchange(numRetry, () => ping(this.portHandler, id));

    if (result !== COMM_SUCCESS) {
      if (raiseOnError) throw new FeetechCommError(getTxRxResult(result), result);
      return null;
    }
    if (error !== 0) {
      if (raiseOnError) throw new FeetechStatusError(getRxPacketError(error), error);
      return null;
    }

    return modelNumber;
  }

  /** Returns the register ``dataName`` of ``motor``: a position in degrees or percent, anything else as stored. */
  async read(dataName: RegisterName, motor: string, options: AccessOptions = {}): Promise<number> {
    this.checkConnected();
    const { normalize = true, numRetry = 0 } = options;
    const id = this.motorOf(motor).id;
    const [address, length] = getAddress(dataName);

    const errMsg = `Failed to read '${dataName}' on id_=${id} after ${numRetry + 1} tries.`;
    const { value } = await this.readRegister(address, length, id, numRetry, true, errMsg);
    const decoded = this.decodeSign(dataName, new Map([[id, value]]));

    const values = normalize && NORMALIZED_DATA.includes(dataName) ? this.normalize(decoded) : decoded;
    return values.get(id) as number;
  }

  /** Writes the register ``dataName`` of ``motor`` and waits for the servo's answer. */
  async write(dataName: RegisterName, motor: string, value: number, options: AccessOptions = {}): Promise<void> {
    this.checkConnected();
    const { normalize = true, numRetry = 0 } = options;
    const id = this.motorOf(motor).id;
    const [address, length] = getAddress(dataName);

    let intValue = toInt(value);
    if (normalize && NORMALIZED_DATA.includes(dataName)) {
      intValue = this.unnormalize(new Map([[id, value]])).get(id) as number;
    }
    intValue = this.encodeSign(dataName, new Map([[id, intValue]])).get(id) as number;

    const errMsg = `Failed to write '${dataName}' on id_=${id} with '${intValue}' after ${numRetry + 1} tries.`;
    await this.writeRegister(address, length, id, intValue, numRetry, true, errMsg);
  }

  /** Returns the register ``dataName`` of several motors, all by default, from one packet they answer in turn.
   * A servo's error byte is not looked at. */
  async syncRead(
    dataName: RegisterName,
    motors: NameOrId | readonly NameOrId[] | null = null,
    options: AccessOptions = {},
  ): Promise<Record<string, number>> {
    this.checkConnected();
    const { normalize = true, numRetry = 0 } = options;
    const ids = this.getMotorsList(motors).map((name) => this.motorOf(name).id);
    if (ids.length === 0) throw new StopIteration("A sync read needs a motor"); // lerobot's next() of no model
    const [address, length] = getAddress(dataName);

    const errMsg = `Failed to sync read '${dataName}' on ids=[${ids.join(", ")}] after ${numRetry + 1} tries.`;
    const raw = await this.syncReadRegisters(address, length, ids, numRetry, true, errMsg);
    const decoded = this.decodeSign(dataName, raw);

    const values = normalize && NORMALIZED_DATA.includes(dataName) ? this.normalize(decoded) : decoded;
    return Object.fromEntries([...values].map(([id, value]) => [this.nameOf(id), value]));
  }

  /** Writes the register ``dataName`` of several motors with one packet, which no servo answers: a servo that
   * missed it is not known. ``values`` is one value for every motor or a value for each named motor. */
  async syncWrite(
    dataName: RegisterName,
    values: number | Readonly<Record<string, number>>,
    options: AccessOptions = {},
  ): Promise<void> {
    this.checkConnected();
    const { normalize = true, numRetry = 0 } = options;
    const rawIdsValues = this.getIdsValues(values);
    if (rawIdsValues.size === 0) throw new StopIteration("A sync write needs a motor"); // lerobot's next() of no model
    const [address, length] = getAddress(dataName);

    let intIdsValues = new Map([...rawIdsValues].map(([id, value]) => [id, toInt(value)]));
    if (normalize && NORMALIZED_DATA.includes(dataName)) intIdsValues = this.unnormalize(rawIdsValues);
    intIdsValues = this.encodeSign(dataName, intIdsValues);

    const errMsg = `Failed to sync write '${dataName}' with ids_values=${formatDict(intIdsValues)} after ${numRetry + 1} tries.`;
    await this.syncWriteRegisters(address, length, intIdsValues, numRetry, true, errMsg);
  }

  async enableTorque(motors: NameOrId | readonly NameOrId[] | null = null, numRetry = 0): Promise<void> {
    for (const motor of this.getMotorsList(motors)) {
      await this.write("Torque_Enable", motor, TorqueMode.ENABLED, { numRetry });
      await this.write("Lock", motor, 1, { numRetry });
    }
  }

  /** Disables the motors' torque and unlocks their EEPROM, one motor after another; it stops at the first that
   * fails. */
  async disableTorque(motors: NameOrId | readonly NameOrId[] | null = null, numRetry = 0): Promise<void> {
    for (const motor of this.getMotorsList(motors)) {
      await this.write("Torque_Enable", motor, TorqueMode.DISABLED, { numRetry });
      await this.write("Lock", motor, 0, { numRetry });
    }
  }

  /** Runs ``run`` with the motors' torque disabled and enables it again whatever ``run`` did. */
  async torqueDisabled<T>(run: () => Promise<T>, motors: NameOrId | readonly NameOrId[] | null = null): Promise<T> {
    await this.disableTorque(motors);
    try {
      return await run();
    } finally {
      await this.enableTorque(motors);
    }
  }

  /** Writes lerobot's settings to every motor: no delay before a servo answers, the highest acceleration, and
   * the STS3215's position readings kept inside one turn. */
  async configureMotors(returnDelayTime = 0, maximumAcceleration = 254, acceleration = 254): Promise<void> {
    for (const motor of Object.keys(this.motors)) {
      // a servo waits 500 us before it answers by default (250); 0 is the shortest
      await this.write("Return_Delay_Time", motor, returnDelayTime);
      await this.write("Maximum_Acceleration", motor, maximumAcceleration);
      await this.write("Acceleration", motor, acceleration);

      // bit 4 of Phase clear: the position is read in [0, resolution - 1], never negative or past one turn
      const phase = await this.read("Phase", motor, { normalize: false });
      if (phase & 0x10) await this.write("Phase", motor, phase & ~0x10);
    }
  }

  /** Whether the motors' position limits and homing offsets are those of ``calibration``. */
  async isCalibrated(): Promise<boolean> {
    const motorsCalibration = await this.readCalibration();
    const motors = Object.keys(motorsCalibration);
    const calibrated = Object.keys(this.calibration);
    if (motors.length !== calibrated.length || !motors.every((motor) => Object.hasOwn(this.calibration, motor))) {
      return false;
    }

    return Object.entries(motorsCalibration).every(
      ([motor, read]) =>
        this.calibration[motor].rangeMin === read.rangeMin &&
        this.calibration[motor].rangeMax === read.rangeMax &&
        this.calibration[motor].homingOffset === read.homingOffset,
    );
  }

  /** Returns the calibration the motors' registers hold; a drive mode is no register, so it reads 0. */
  async readCalibration(): Promise<Record<string, MotorCalibration>> {
    const calibration: Record<string, MotorCalibration> = {};
    for (const [motor, { id }] of Object.entries(this.motors)) {
      const rangeMin = await this.read("Min_Position_Limit", motor, { normalize: false });
      const rangeMax = await this.read("Max_Position_Limit", motor, { normalize: false });
      const homingOffset = await this.read("Homing_Offset", motor, { normalize: false });
      calibration[motor] = { id, driveMode: 0, homingOffset, rangeMin, rangeMax };
    }

    return calibration;
  }

  /** Writes ``calibration`` to the motors' registers and, with ``cache``, makes it the bus's own. */
  async writeCalibration(calibration: Record<string, MotorCalibration>, cache = true): Promise<void> {
    for (const [motor, entry] of Object.entries(calibration)) {
      await this.write("Homing_Offset", motor, entry.homingOffset);
      await this.write("Min_Position_Limit", motor, entry.rangeMin);
      await this.write("Max_Position_Limit", motor, entry.rangeMax);
    }

    if (cache) this.calibration = calibration;
  }

  /** Returns the motors' steps as lerobot's degrees (about the middle of the calibrated range, not clamped) or
   * percent of the calibrated range (clamped to it), by motor id. */
  normalize(idsValues: ReadonlyMap<number, number>): Map<number, number> {
    this.checkCalibration();

    const normalized = new Map<number, number>();
    for (const [id, value] of idsValues) {
      const motor = this.nameOf(id);
      const { rangeMin, rangeMax, driveMode } = this.calibrationOf(motor);
      const isInverted = FeetechMotorsBus.APPLY_DRIVE_MODE && driveMode !== 0;
      if (rangeMax === rangeMin) {
        throw new ValueError(`Invalid calibration for motor '${motor}': min and max are equal.`);
      }

      const bounded = Math.min(rangeMax, Math.max(rangeMin, value));
      switch (this.motors[motor].normMode) {
        case "range_m100_100": {
          const norm = ((bounded - rangeMin) / (rangeMax - rangeMin)) * 200 - 100;
          normalized.set(id, isInverted ? -norm : norm);
          break;
        }
        case "range_0_100": {
          const norm = ((bounded - rangeMin) / (rangeMax - rangeMin)) * 100;
          normalized.set(id, isInverted ? 100 - norm : norm);
          break;
        }
        case "degrees": {
          const mid = (rangeMin + rangeMax) / 2;
          normalized.set(id, ((value - mid) * 360) / (RESOLUTION - 1));
          break;
        }
      }
    }

    return normalized;
  }

  /** Returns lerobot's degrees or percent as the motors' steps, by motor id; the reverse of normalize(). */
  unnormalize(idsValues: ReadonlyMap<number, number>): Map<number, number> {
    this.checkCalibration();

    const unnormalized = new Map<number, number>();
    for (const [id, value] of idsValues) {
      const motor = this.nameOf(id);
      const { rangeMin, rangeMax, driveMode } = this.calibrationOf(motor);
      const isInverted = FeetechMotorsBus.APPLY_DRIVE_MODE && driveMode !== 0;
      if (rangeMax === rangeMin) {
        throw new ValueError(`Invalid calibration for motor '${motor}': min and max are equal.`);
      }

      switch (this.motors[motor].normMode) {
        case "range_m100_100": {
          const bounded = Math.min(100.0, Math.max(-100.0, isInverted ? -value : value));
          unnormalized.set(id, toInt(((bounded + 100) / 200) * (rangeMax - rangeMin) + rangeMin));
          break;
        }
        case "range_0_100": {
          const bounded = Math.min(100.0, Math.max(0.0, isInverted ? 100 - value : value));
          unnormalized.set(id, toInt((bounded / 100) * (rangeMax - rangeMin) + rangeMin));
          break;
        }
        case "degrees": {
          const mid = (rangeMin + rangeMax) / 2;
          unnormalized.set(id, toInt((value * (RESOLUTION - 1)) / 360 + mid));
          break;
        }
      }
    }

    return unnormalized;
  }

  /** Returns the bytes of ``value`` for a register of ``length`` bytes; a value that does not fit throws. */
  serializeData(value: number, length: number): number[] {
    if (value < 0) throw new ValueError(`Negative values are not allowed: ${value}`);

    const maxValue = length === 1 ? 0xff : length === 2 ? 0xffff : length === 4 ? 0xffffffff : null;
    if (maxValue === null) throw new NotImplementedError(`Unsupported byte size: ${length}. Expected [1, 2, 4].`);
    if (value > maxValue) {
      throw new ValueError(`Value ${value} exceeds the maximum for ${length} bytes (${maxValue}).`);
    }

    return splitIntoByteChunks(value, length);
  }

  private checkConnected(): void {
    if (!this.isConnected) {
      throw new DeviceNotConnectedError("FeetechMotorsBus is not connected. Run `.connect()` first.");
    }
  }

  private checkCalibration(): void {
    if (Object.keys(this.calibration).length === 0) {
      throw new RuntimeError("FeetechMotorsBus has no calibration registered.");
    }
  }

  private motorOf(motor: string): Motor {
    if (!Object.hasOwn(this.motors, motor)) throw new KeyError(`Unknown motor '${motor}'`); // self.motors[motor]

    return this.motors[motor];
  }

  private calibrationOf(motor: string): MotorCalibration {
    if (!Object.hasOwn(this.calibration, motor)) throw new KeyError(`No calibration for motor '${motor}'`);

    return this.calibration[motor];
  }

  private nameOf(id: number): string {
    const name = this.idToName.get(id);
    if (name === undefined) throw new KeyError(`Unknown motor id ${id}`); // self._id_to_name_dict[id]

    return name;
  }

  private getMotorId(motor: NameOrId): number {
    return typeof motor === "string" ? this.motorOf(motor).id : motor;
  }

  private getMotorsList(motors: NameOrId | readonly NameOrId[] | null): string[] {
    if (motors === null) return Object.keys(this.motors);
    const list = typeof motors === "string" || typeof motors === "number" ? [motors] : motors;

    return list.map((motor) => (typeof motor === "string" ? motor : this.nameOf(motor)));
  }

  private getIdsValues(values: number | Readonly<Record<string, number>>): Map<number, number> {
    if (typeof values === "number") return new Map(this.ids.map((id) => [id, values]));

    return new Map(Object.entries(values).map(([motor, value]) => [this.motorOf(motor).id, value]));
  }

  private encodeSign(dataName: string, idsValues: ReadonlyMap<number, number>): Map<number, number> {
    const signBit = Object.hasOwn(ENCODING_TABLE, dataName) ? ENCODING_TABLE[dataName] : null;

    return new Map(
      [...idsValues].map(([id, value]) => [id, signBit === null ? value : encodeSignMagnitude(value, signBit)]),
    );
  }

  private decodeSign(dataName: string, idsValues: ReadonlyMap<number, number>): Map<number, number> {
    const signBit = Object.hasOwn(ENCODING_TABLE, dataName) ? ENCODING_TABLE[dataName] : null;

    return new Map(
      [...idsValues].map(([id, value]) => [id, signBit === null ? value : decodeSignMagnitude(value, signBit)]),
    );
  }

  /** Runs one packet exchange after the exchanges already asked for, and again at once, up to ``numRetry`` times,
   * while it fails. Python's calls block; these do not, and the SDK would refuse the second of two at once. */
  private exchange<T extends { result: number }>(numRetry: number, attempt: () => Promise<T>): Promise<T> {
    const outcome = this.lastExchange.then(async () => {
      let attempted = await attempt();
      for (let nTry = 1; nTry <= numRetry && attempted.result !== COMM_SUCCESS; nTry++) attempted = await attempt();

      return attempted;
    });
    this.lastExchange = outcome.catch(() => undefined);

    return outcome;
  }

  private async readRegister(
    address: number,
    length: number,
    motorId: number,
    numRetry = 0,
    raiseOnError = true,
    errMsg = "",
  ): Promise<{ value: number; result: number; error: number }> {
    if (length !== 1 && length !== 2 && length !== 4) throw new ValueError(String(length));

    const read = await this.exchange(numRetry, async () => {
      const { data, result, error } = await readTxRx(this.portHandler, motorId, address, length);
      return { value: result === COMM_SUCCESS ? valueOf(data, length) : 0, result, error };
    });

    if (read.result !== COMM_SUCCESS && raiseOnError) {
      throw new FeetechCommError(`${errMsg} ${getTxRxResult(read.result)}`, read.result);
    } else if (read.error !== 0 && raiseOnError) {
      throw new FeetechStatusError(`${errMsg} ${getRxPacketError(read.error)}`, read.error);
    }

    return read;
  }

  private async writeRegister(
    address: number,
    length: number,
    motorId: number,
    value: number,
    numRetry = 0,
    raiseOnError = true,
    errMsg = "",
  ): Promise<{ result: number; error: number }> {
    const data = this.serializeData(value, length);
    const written = await this.exchange(numRetry, () => writeTxRx(this.portHandler, motorId, address, data));

    if (written.result !== COMM_SUCCESS && raiseOnError) {
      throw new FeetechCommError(`${errMsg} ${getTxRxResult(written.result)}`, written.result);
    } else if (written.error !== 0 && raiseOnError) {
      throw new FeetechStatusError(`${errMsg} ${getRxPacketError(written.error)}`, written.error);
    }

    return written;
  }

  private async syncReadRegisters(
    address: number,
    length: number,
    motorIds: readonly number[],
    numRetry = 0,
    raiseOnError = true,
    errMsg = "",
  ): Promise<Map<number, number>> {
    const ids = syncReadParameters(motorIds);
    const dataOf = new Map<number, number[]>(ids.map((id) => [id, []]));

    // the SDK's GroupSyncRead: one packet out, then every servo's answer in the order asked, all within one timeout
    const { result } = await this.exchange(numRetry, async () => {
      if (ids.length === 0) return { result: COMM_NOT_AVAILABLE };
      let received = await syncReadTx(this.portHandler, address, length, ids);
      for (let index = 0; index < ids.length && received === COMM_SUCCESS; index++) {
        const read = await readRx(this.portHandler, ids[index], length);
        dataOf.set(ids[index], read.data);
        received = read.result;
      }

      return { result: received };
    });

    if (result !== COMM_SUCCESS && raiseOnError) {
      throw new FeetechCommError(`${errMsg} ${getTxRxResult(result)}`, result);
    }

    return new Map(
      motorIds.map((id) => {
        const data = dataOf.get(id) ?? [];
        // an answer with fewer bytes than were asked reads as 0
        if (data.length < length) return [id, 0];
        if (length === 1) return [id, data[0]];
        if (length === 2) return [id, makeWord(data[0], data[1])];
        if (length === 4) return [id, makeDword(makeWord(data[0], data[1]), makeWord(data[2], data[3]))];
        return [id, 0];
      }),
    );
  }

  private async syncWriteRegisters(
    address: number,
    length: number,
    idsValues: ReadonlyMap<number, number>,
    numRetry = 0,
    raiseOnError = true,
    errMsg = "",
  ): Promise<number> {
    const parameters = syncWriteParameters(
      length,
      [...idsValues].map(([id, value]) => [id, this.serializeData(value, length)] as const),
    );

    const { result } = await this.exchange(numRetry, async () => ({
      result:
        parameters.length === 0
          ? COMM_NOT_AVAILABLE
          : await syncWriteTxOnly(this.portHandler, address, length, parameters),
    }));

    if (result !== COMM_SUCCESS && raiseOnError) {
      throw new FeetechCommError(`${errMsg} ${getTxRxResult(result)}`, result);
    }

    return result;
  }

  private async assertMotorsExist(): Promise<void> {
    const expectedModels = new Map(this.ids.map((id) => [id, MODEL_NUMBER_VALUE]));

    const foundModels = new Map<number, number>();
    for (const id of this.ids) {
      const modelNumber = await this.ping(id);
      if (modelNumber !== null) foundModels.set(id, modelNumber);
    }

    const missingIds = this.ids.filter((id) => !foundModels.has(id));
    const wrongModels = [...foundModels].filter(([id, found]) => expectedModels.get(id) !== found);
    if (missingIds.length === 0 && wrongModels.length === 0) return;

    const lines = [`FeetechMotorsBus motor check failed on port '${this.port}':`];
    if (missingIds.length > 0) {
      lines.push("\nMissing motor IDs:");
      lines.push(...missingIds.map((id) => `  - ${id} (expected model: ${expectedModels.get(id)})`));
    }
    if (wrongModels.length > 0) {
      lines.push("\nMotors with incorrect model numbers:");
      lines.push(
        ...wrongModels.map(
          ([id, found]) => `  - ${id} (${this.nameOf(id)}): expected ${expectedModels.get(id)}, found ${found}`,
        ),
      );
    }
    lines.push("\nFull expected motor list (id: model_number):", formatDict(expectedModels));
    lines.push("\nFull found motor list (id: model_number):", formatDict(foundModels));

    throw new RuntimeError(lines.join("\n"));
  }

  private async assertSameFirmware(): Promise<void> {
    const firmwareVersions = new Map<number, string>();
    for (const id of this.ids) {
      const major = await this.readRegister(...FIRMWARE_MAJOR_VERSION, id);
      const minor = await this.readRegister(...FIRMWARE_MINOR_VERSION, id);
      firmwareVersions.set(id, `${major.value}.${minor.value}`);
    }

    if (new Set(firmwareVersions.values()).size !== 1) {
      throw new RuntimeError(
        "Some Motors use different firmware versions:" +
          `\n${formatDict(firmwareVersions)}\n` +
          "Update their firmware first using Feetech's software. " +
          "Visit https://www.feetechrc.com/software.",
      );
    }
  }
}
