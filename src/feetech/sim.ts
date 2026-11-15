// Not in PEAR: a chain of simulated STS3215 servos behind the bus's transport, for tests of the bus and of the
// station. A servo is its control table (lerobot's addresses, tables.ts) and a position.
//
// What it does: it answers PING, READ, WRITE, SYNC READ and SYNC WRITE with the protocol's status packets, whose
// error byte is the servo's Status register; with torque on, its position goes to its goal, inside its position
// limits, at once or at a set speed. What a real servo does and this does not: REG WRITE and ACTION, acceleration,
// load, temperature and voltage, protections, the EEPROM lock, any mode but position, a delay before it answers.
// The values a new servo holds are plausible, not read from a real one.

import {
  BROADCAST_ID,
  INST_PING,
  INST_READ,
  INST_SYNC_READ,
  INST_SYNC_WRITE,
  INST_WRITE,
  PKT_ID,
  PKT_INSTRUCTION,
  PKT_LENGTH,
  PKT_PARAMETER0,
} from "./protocol";
import {
  CONTROL_TABLE,
  decodeSignMagnitude,
  encodeSignMagnitude,
  ENCODING_TABLE,
  MODEL_NUMBER_VALUE,
  type RegisterName,
  RESOLUTION,
} from "./tables";
import { type Clock, systemClock, type Transport } from "./transport";

export const REGISTER_BYTES = 128; // of a simulated servo's control table

const POSITION_SIGN_BIT = ENCODING_TABLE.Present_Position;

/** One simulated STS3215. */
export class SimServo {
  readonly registers = new Uint8Array(REGISTER_BYTES);
  /** Where the horn is, steps; between two steps while it moves at a set speed. */
  private exactPosition: number;

  /** A servo as it is switched on: no torque and a goal of 0; ``values`` are registers that differ, as stored. */
  constructor(
    readonly id: number,
    values: Partial<Record<RegisterName, number>> = {},
  ) {
    const defaults: Partial<Record<RegisterName, number>> = {
      Firmware_Major_Version: 3,
      Firmware_Minor_Version: 10,
      Model_Number: MODEL_NUMBER_VALUE,
      ID: id,
      Return_Delay_Time: 250,
      Response_Status_Level: 1,
      Min_Position_Limit: 0,
      Max_Position_Limit: RESOLUTION - 1,
      Max_Torque_Limit: 1000,
      Phase: 12,
      P_Coefficient: 32,
      D_Coefficient: 32,
      Torque_Limit: 1000,
      Present_Position: (RESOLUTION - 1) >> 1,
      Present_Voltage: 120,
      Present_Temperature: 30,
    };
    for (const [name, value] of Object.entries({ ...defaults, ...values })) {
      if (value !== undefined) this.set(name as RegisterName, value);
    }
    this.exactPosition = this.position;
  }

  /** Makes the whole control table ``bytes``, as a servo's memory dump. */
  load(bytes: ArrayLike<number>): void {
    if (bytes.length !== REGISTER_BYTES) throw new RangeError(`A control table has ${REGISTER_BYTES} bytes`);
    this.registers.set(bytes);
    this.exactPosition = this.position;
  }

  /** Returns the register ``name`` as stored: a sign and a magnitude where the servo keeps one. */
  get(name: RegisterName): number {
    const [address, length] = CONTROL_TABLE[name];
    let value = 0;
    for (let index = length - 1; index >= 0; index--) value = value * 256 + this.registers[address + index];

    return value;
  }

  /** Stores ``value`` in the register ``name`` behind the bus's back, as the world or a test does. */
  set(name: RegisterName, value: number): void {
    const [address, length] = CONTROL_TABLE[name];
    if (!Number.isInteger(value) || value < 0 || value >= 256 ** length) {
      throw new RangeError(`${value} does not fit ${name}`);
    }
    for (let index = 0; index < length; index++) this.registers[address + index] = Math.floor(value / 256 ** index) % 256;
    if (name === "Present_Position") this.exactPosition = this.position;
  }

  /** Present_Position, steps. */
  get position(): number {
    return decodeSignMagnitude(this.get("Present_Position"), POSITION_SIGN_BIT);
  }

  /** Puts the horn at ``steps``, as a hand does while the servo has no torque. */
  set position(steps: number) {
    this.set("Present_Position", encodeSignMagnitude(Math.round(steps), POSITION_SIGN_BIT));
    this.exactPosition = steps;
  }

  /** Goal_Position, steps. */
  get goal(): number {
    return decodeSignMagnitude(this.get("Goal_Position"), POSITION_SIGN_BIT);
  }

  get torqueEnabled(): boolean {
    return this.get("Torque_Enable") === 1;
  }

  /** Moves the horn toward the goal by at most ``maxSteps``; a servo without torque stays where it is. */
  move(maxSteps: number): void {
    if (!this.torqueEnabled) {
      this.set("Moving", 0);
      return;
    }

    let target = this.goal;
    const lower = this.get("Min_Position_Limit");
    const upper = this.get("Max_Position_Limit");
    if (lower < upper) target = Math.min(Math.max(target, lower), upper);

    const distance = target - this.exactPosition;
    const exactPosition = Math.abs(distance) <= maxSteps ? target : this.exactPosition + Math.sign(distance) * maxSteps;
    this.position = exactPosition;
    this.set("Moving", exactPosition === target ? 0 : 1);
  }
}

export interface SimChainOptions {
  /** Whose time the servos move in and a read waits in; the system's by default. */
  clock?: Clock;
  /** How fast a servo goes to its goal, steps a second; by default it is there at once. */
  speed?: number;
}

/** Simulated servos on one line: the transport of a bus. What a test may break is public. */
export class SimServoChain implements Transport {
  readonly servos = new Map<number, SimServo>();
  /** Servos that are not there: they answer nothing and keep nothing. */
  readonly absent = new Set<number>();
  /** How many of the next status packets are lost. */
  dropReplies = 0;
  /** How many of the next status packets arrive with a wrong checksum. */
  corruptReplies = 0;
  /** Whether the line hands the host its own packets back before any answer, as an echoing adapter does. */
  echo = false;
  /** The instruction packets received, a test may count or read them. */
  readonly received: Uint8Array[] = [];
  isClosed = false;

  private readonly clock: Clock;
  private readonly speed: number;
  private incoming: number[] = []; // from the host, not yet a whole packet
  private outgoing: number[] = []; // to the host, not yet read
  private movedAt: number;

  constructor(servos: Iterable<SimServo>, options: SimChainOptions = {}) {
    for (const servo of servos) {
      if (this.servos.has(servo.id)) throw new RangeError(`Two servos have the id ${servo.id}`);
      this.servos.set(servo.id, servo);
    }
    this.clock = options.clock ?? systemClock;
    this.speed = options.speed ?? Infinity;
    this.movedAt = this.clock.now();
  }

  servo(id: number): SimServo {
    const servo = this.servos.get(id);
    if (servo === undefined) throw new Error(`No servo with the id ${id}`);

    return servo;
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.isClosed) throw new Error("The simulated line is closed");

    this.incoming.push(...bytes);
    for (;;) {
      // a packet starts at a header; what comes before one is dropped
      while (this.incoming.length >= 2 && !(this.incoming[0] === 0xff && this.incoming[1] === 0xff)) this.incoming.shift();
      if (this.incoming.length <= PKT_LENGTH) return;
      const length = this.incoming[PKT_LENGTH] + 4;
      if (this.incoming.length < length) return;

      const packet = this.incoming.splice(0, length);
      let sum = 0;
      for (let index = PKT_ID; index < length - 1; index++) sum += packet[index];
      if ((~sum & 0xff) === packet[length - 1]) this.handle(packet); // a servo ignores a corrupt packet
    }
  }

  async read(maxLength: number, timeoutMs: number): Promise<Uint8Array> {
    if (this.isClosed) throw new Error("The simulated line is closed");
    // every answer is ready when its instruction is written: what is not there will not come
    if (this.outgoing.length === 0 && timeoutMs > 0) await this.clock.sleep(timeoutMs);

    return Uint8Array.from(this.outgoing.splice(0, Math.max(maxLength, 0)));
  }

  async close(): Promise<void> {
    this.isClosed = true;
  }

  /** Brings every servo's position up to the clock. */
  advance(): void {
    const now = this.clock.now();
    const maxSteps = this.speed === Infinity ? Infinity : (this.speed * Math.max(now - this.movedAt, 0)) / 1000;
    this.movedAt = now;
    if (maxSteps === Infinity) return; // without a speed a servo moves when it is written, not as time passes
    for (const servo of this.servos.values()) servo.move(maxSteps);
  }

  private handle(packet: readonly number[]): void {
    this.received.push(Uint8Array.from(packet));
    if (this.echo) this.outgoing.push(...packet);
    this.advance();

    const id = packet[PKT_ID];
    const instruction = packet[PKT_INSTRUCTION];
    const parameters = packet.slice(PKT_PARAMETER0, -1);
    if (instruction === INST_PING) {
      const servo = this.present(id);
      if (servo !== null) this.reply(servo, []);
    } else if (instruction === INST_READ) {
      const servo = this.present(id);
      const [address, length] = parameters;
      if (servo !== null && address + length <= REGISTER_BYTES) {
        this.reply(servo, servo.registers.subarray(address, address + length));
      }
    } else if (instruction === INST_WRITE) {
      const servo = this.present(id);
      if (servo !== null) {
        this.store(servo, parameters[0], parameters.slice(1));
        this.reply(servo, []);
      }
    } else if (instruction === INST_SYNC_READ && id === BROADCAST_ID) {
      const [address, length, ...ids] = parameters;
      for (const each of ids) {
        const servo = this.present(each);
        if (servo !== null && address + length <= REGISTER_BYTES) {
          this.reply(servo, servo.registers.subarray(address, address + length));
        }
      }
    } else if (instruction === INST_SYNC_WRITE && id === BROADCAST_ID) {
      const [address, length] = parameters;
      for (let start = 2; start + length < parameters.length; start += length + 1) {
        const servo = this.present(parameters[start]);
        if (servo !== null) this.store(servo, address, parameters.slice(start + 1, start + 1 + length));
      }
    }
  }

  private present(id: number): SimServo | null {
    return this.absent.has(id) ? null : (this.servos.get(id) ?? null);
  }

  private store(servo: SimServo, address: number, data: readonly number[]): void {
    if (address + data.length > REGISTER_BYTES) return;
    servo.registers.set(data, address);
    if (this.speed === Infinity) servo.move(Infinity);
  }

  private reply(servo: SimServo, parameters: ArrayLike<number>): void {
    if (this.dropReplies > 0) {
      this.dropReplies -= 1;
      return;
    }

    // a servo reports its Status register in the error byte of every status packet
    const body = [servo.id, parameters.length + 2, servo.get("Status"), ...Array.from(parameters)];
    let checksum = ~body.reduce((sum, byte) => sum + byte, 0) & 0xff;
    if (this.corruptReplies > 0) {
      this.corruptReplies -= 1;
      checksum ^= 0xff;
    }
    this.outgoing.push(0xff, 0xff, ...body, checksum);
  }
}
