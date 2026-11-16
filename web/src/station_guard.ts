// Not in PEAR: the guard between PEAR's station and a real arm's port. It knows exactly what the station writes
// to a servo and lets nothing else through, and it refuses a goal that jumps. It starts in the state "reads",
// where it is the read-only guard of readonly.ts; one method puts it into the state "station", where the writes
// of the table below pass as well. It trusts nothing above it: a packet is let through only when every byte of
// it is accounted for, and a refusal throws before a byte reaches the port.
//
// What a refusal does: the write throws, the control loop faults, and the servos keep the last goal that was let
// through, with torque on. So a refusal stops the arm where it is, and a rule that is too strict is the safe way
// to be wrong.
//
//   1  PING, READ, SYNC READ                                  as in the state "reads"
//   2  SYNC WRITE  Goal_Position 42, 2 bytes each             exactly the servos 1 to 6, each once, and no jump
//   3  WRITE       Torque_Enable 40, 1 byte, servo 1 to 6     0 or 1 (never 128, which re-centres a servo)
//   4  WRITE       Lock 55, 1 byte, servo 1 to 6              0 or 1
//   5  WRITE       Acceleration 41, 1 byte, servo 1 to 6      254
//   6  WRITE       a setting given on entering "station"      exactly the value given for that servo and register
//
// A position is a sign and a magnitude on the wire, with the sign in bit 15: a servo that rests just below its
// zero reads as a small negative position, and PEAR's enable writes that value back as its goal. The guard
// decodes goals and present positions with the library's own decoding and compares the decoded steps. No range is
// set for a goal: it passes by being near where the servo is, or near where it was last told to be.

import { decodeSignMagnitude, encodeSignMagnitude, ENCODING_TABLE, protocol, type Transport } from "../../src/feetech/index";
import { instructionName, instructionsOf, READING_INSTRUCTIONS, ReadOnlyViolation } from "./readonly";

/** The arm's servos: the only ids a write may name. */
export const ARM_IDS: readonly number[] = [1, 2, 3, 4, 5, 6];

/** The registers the guard knows by itself: [address, bytes]. */
export const GOAL_POSITION = [42, 2] as const;
export const TORQUE_ENABLE = [40, 1] as const;
export const LOCK = [55, 1] as const;
export const ACCELERATION = [41, 1] as const;
export const PRESENT_POSITION = [56, 2] as const;

/** The one value PEAR's enable writes to Acceleration. */
export const ACCELERATION_VALUE = 254;
/** The bit that holds the sign of a goal and of a present position on the wire. */
const GOAL_SIGN_BIT = ENCODING_TABLE["Goal_Position"] as number;
const PRESENT_SIGN_BIT = ENCODING_TABLE["Present_Position"] as number;

/** How far a goal may be from the servo's last goal or from its present position, steps (about 3.5 degrees). A
 * trajectory's sample moves at most 1 rad a second, 13 steps in a control period of 20 ms (the gripper 15). */
export const GOAL_STEP_LIMIT = 40;
/** How old a present position may be to count for a goal, ms. */
export const PRESENT_MAX_AGE_MS = 250;
/** How many refusals are kept for the status. */
export const REFUSALS_KEPT = 20;

/** The addresses a setting may have: the registers PEAR's enable writes besides those the guard knows by itself.
 * Return_Delay_Time 7, Max_Torque_Limit 16, P_Coefficient 21, D_Coefficient 22, I_Coefficient 23,
 * Protection_Current 28, Operating_Mode 33, Overload_Torque 36, Maximum_Acceleration 85. */
export const SETTING_ADDRESSES: ReadonlySet<number> = new Set([7, 16, 21, 22, 23, 28, 33, 36, 85]);

/** One register a servo may be written, with the only value that passes: the value PEAR's enable writes to it. */
export interface StationSetting {
  readonly address: number;
  /** How many bytes the register has: 1 or 2. */
  readonly bytes: number;
  readonly value: number;
}

/** The settings each servo may be written, by the servo's id; every one of the six servos has a list. */
export type StationSettings = Readonly<Record<number, readonly StationSetting[]>>;

export type GuardState = "reads" | "station";

/** Why a write was refused. */
export type RefusalReason =
  /** The bytes are not whole instruction packets, or a writing packet came joined to another. */
  | "not-a-packet"
  /** A writing instruction in the state "reads". */
  | "reads-only"
  /** An instruction that never passes: REG WRITE, ACTION, RESET or one without a name. */
  | "instruction"
  /** A servo that is not one of the six, the broadcast id for a WRITE, or a SYNC WRITE not sent to all. */
  | "id"
  /** A register the station does not write, or a write that does not start at a register's address. */
  | "address"
  /** The register with another count of bytes. */
  | "length"
  /** A value the register may not be written. */
  | "value"
  /** A SYNC WRITE whose servos are not exactly the six, each once. */
  | "servos"
  /** A goal that is neither near the servo's last goal nor near its present position. */
  | "jump";

/** One refusal, as the status tells it. */
export interface Refusal {
  readonly reason: RefusalReason;
  readonly message: string;
  /** The packet's instruction, id and first address; null where the bytes or the packet have none. */
  readonly instruction: number | null;
  readonly id: number | null;
  readonly address: number | null;
  /** When it was refused, by the guard's clock, ms. */
  readonly atMs: number;
}

/** Thrown for bytes the guard does not let through; nothing of them was sent. */
export class StationGuardViolation extends ReadOnlyViolation {
  override readonly name: string = "StationGuardViolation";

  constructor(
    message: string,
    readonly reason: RefusalReason,
    instruction: number | null,
    readonly id: number | null = null,
    readonly address: number | null = null,
  ) {
    super(message, instruction);
  }
}

/** What the guard has let through and refused, for a status message. */
export interface StationGuardStatus {
  state: GuardState;
  /** What passed: by the instruction's name and, for a write, the register's address ("WRITE 40",
   * "SYNC WRITE 42"). */
  passed: Record<string, number>;
  /** How many writes were refused in all, and by reason. */
  refusedCount: number;
  refusedBy: Partial<Record<RefusalReason, number>>;
  /** The last refusals, the newest last; never more than REFUSALS_KEPT. */
  refusals: Refusal[];
  /** Each servo's last goal that was let through and its present position as the guard saw it last, both in
   * steps with their sign, the position with its reading's age in ms; null where there is none. In the order of
   * ARM_IDS. */
  goals: Array<number | null>;
  present: Array<{ position: number; ageMs: number } | null>;
}

export interface StationGuardOptions {
  /** The guard's clock, ms; the page's when it is not given. */
  now?: () => number;
  /** Told of every refusal, before it is thrown. */
  onRefused?: (violation: StationGuardViolation) => void;
}

/** One whole instruction packet of a write's bytes. */
interface Packet {
  readonly id: number;
  readonly instruction: number;
  readonly parameters: Uint8Array;
}

/** A servo's answer to a SYNC READ of Present_Position: FF FF ID 04 ERROR LOW HIGH CHECKSUM. */
const POSITION_ANSWER_LENGTH = 8;

/** Returns the packets of ``bytes``, which instructionsOf() has found to be whole packets one after another. */
function packetsOf(bytes: Uint8Array): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const total = (bytes[offset + protocol.PKT_LENGTH] as number) + 4;
    packets.push({
      id: bytes[offset + protocol.PKT_ID] as number,
      instruction: bytes[offset + protocol.PKT_INSTRUCTION] as number,
      parameters: bytes.slice(offset + protocol.PKT_PARAMETER0, offset + total - 1),
    });
    offset += total;
  }

  return packets;
}

/** Returns ``bytes`` as the one whole packet they are, its checksum checked; null when they are anything else.
 * Unlike instructionsOf() it does not look for 0xFF inside: the caller says where one may be. */
function onePacket(bytes: Uint8Array): Packet | null {
  if (bytes.length < 6 || bytes[0] !== 0xff || bytes[1] !== 0xff) return null;
  const length = bytes[protocol.PKT_LENGTH] as number;
  if (length < 2 || length + 4 !== bytes.length) return null;
  let sum = 0;
  for (let index = protocol.PKT_ID; index < bytes.length - 1; index++) sum += bytes[index] as number;
  if ((~sum & 0xff) !== bytes[bytes.length - 1]) return null;

  return packetsOf(bytes)[0] as Packet;
}

/** Returns the settings as the guard keeps them, by servo and address; throws for anything it may not be given. */
function checkedSettings(settings: StationSettings): Map<number, Map<number, StationSetting>> {
  const given = Object.keys(settings).map(Number).sort((a, b) => a - b);
  if (given.length !== ARM_IDS.length || given.some((id, index) => id !== ARM_IDS[index])) {
    throw new RangeError(`The settings must name exactly the servos ${ARM_IDS.join(", ")}: ${given.join(", ")}`);
  }

  const checked = new Map<number, Map<number, StationSetting>>();
  for (const id of ARM_IDS) {
    const byAddress = new Map<number, StationSetting>();
    for (const { address, bytes, value } of settings[id] as readonly StationSetting[]) {
      if (!SETTING_ADDRESSES.has(address)) throw new RangeError(`Servo ${id}: address ${address} is no setting of the station`);
      if (bytes !== 1 && bytes !== 2) throw new RangeError(`Servo ${id}, address ${address}: ${bytes} bytes`);
      if (!Number.isInteger(value) || value < 0 || value >= 256 ** bytes) {
        throw new RangeError(`Servo ${id}, address ${address}: ${value} is no value of ${bytes} bytes`);
      }
      // a byte 0xFF is refused inside every packet but a goal's (see write()), so such a value could never pass
      if (protocol.splitIntoByteChunks(value, bytes).includes(0xff)) {
        throw new RangeError(`Servo ${id}, address ${address}: ${value} holds the byte 0xFF`);
      }
      if (byAddress.has(address)) throw new RangeError(`Servo ${id}: address ${address} is given twice`);
      byAddress.set(address, { address, bytes, value });
    }
    checked.set(id, byAddress);
  }

  return checked;
}

/**
 * A transport that lets through what PEAR's station writes to a real arm and nothing else. In the state "reads"
 * write() sends ``bytes`` on only if every packet in them is a PING, a READ or a SYNC READ, exactly as
 * ReadOnlyTransport does; in the state "station" the writes of this file's table pass as well. Everything else
 * throws StationGuardViolation, with nothing sent. Reading passes through; in "station" the guard also looks at
 * what is read, for the servos' present positions.
 */
export class StationGuardTransport implements Transport {
  private current: GuardState = "reads";
  private settings = new Map<number, Map<number, StationSetting>>();
  private readonly passed: Record<string, number> = {};
  private refusedCount = 0;
  private readonly refusedBy: Partial<Record<RefusalReason, number>> = {};
  private readonly refusals: Refusal[] = [];
  /** Each servo's last goal that was let through, by id. */
  private readonly goals = new Map<number, number>();
  /** Each servo's present position as the guard saw it last, by id, and when. */
  private readonly present = new Map<number, { position: number; atMs: number }>();
  /** The servos asked by the SYNC READ of Present_Position that was the last packet written; null after any other
   * packet. ``heard`` holds what came since and is not parsed yet. */
  private asked: ReadonlySet<number> | null = null;
  private heard: number[] = [];
  private readonly now: () => number;
  /** Why the line itself stopped working (the port was lost or closed), as the read-only guard tells it; null
   * while it works. A refusal is no failure of the line, and neither is a servo that does not answer. */
  failure: unknown = null;
  /** The transport that is guarded: a private name of the language itself, so that no code outside this class
   * can reach it at run time and write past the guard. */
  readonly #inner: Transport;

  constructor(
    inner: Transport,
    private readonly options: StationGuardOptions = {},
  ) {
    this.#inner = inner;
    this.now = options.now ?? (() => performance.now());
  }

  /** What passed, by the keys of `status().passed`, and how many packets were refused: what a report of the
   * line's reading tells of its guard. */
  get counts(): { passed: Record<string, number>; refused: number } {
    return { passed: { ...this.passed }, refused: this.refusedCount };
  }

  get state(): GuardState {
    return this.current;
  }

  /**
   * Puts the guard into the state "station". ``settings`` gives, for each of the six servos, the registers PEAR's
   * enable may write besides torque, lock and acceleration, each with the one value that passes: the value PEAR's
   * enable writes, whatever the servo holds. Nothing is carried over from before: no goal has been let through and
   * no present position has been seen. Throws, and changes nothing, for an address that is no setting of the station.
   */
  enterStation(settings: StationSettings): void {
    const checked = checkedSettings(settings);
    this.forget();
    this.settings = checked;
    this.current = "station";
  }

  /** Puts the guard back into the state "reads": from now on a write is refused as in the beginning. */
  backToReads(): void {
    this.forget();
    this.current = "reads";
  }

  /** Returns what passed and what was refused, as plain data for a status message. */
  status(): StationGuardStatus {
    const now = this.now();

    return {
      state: this.current,
      passed: { ...this.passed },
      refusedCount: this.refusedCount,
      refusedBy: { ...this.refusedBy },
      refusals: this.refusals.map((refusal) => ({ ...refusal })),
      goals: ARM_IDS.map((id) => this.goals.get(id) ?? null),
      present: ARM_IDS.map((id) => {
        const seen = this.present.get(id);

        return seen === undefined ? null : { position: seen.position, ageMs: now - seen.atMs };
      }),
    };
  }

  async write(bytes: Uint8Array): Promise<void> {
    let packets: Packet[];
    let goals: Map<number, number> | null = null;
    try {
      const reading = this.readingPackets(bytes);
      if (reading !== null) {
        packets = reading;
      } else {
        const packet = this.writingPacket(bytes);
        if (packet.instruction === protocol.INST_SYNC_WRITE) goals = this.checkedGoals(packet);
        else this.checkWrite(packet);
        packets = [packet];
      }
    } catch (error) {
      if (error instanceof StationGuardViolation) this.noteRefusal(error);
      throw error;
    }

    for (const packet of packets) {
      const isRead = READING_INSTRUCTIONS.has(packet.instruction);
      const key = isRead ? instructionName(packet.instruction) : `${instructionName(packet.instruction)} ${packet.parameters[0]}`;
      this.passed[key] = (this.passed[key] ?? 0) + 1;
    }
    // only the answers to a SYNC READ of Present_Position that was written last are taken for positions
    const last = packets[packets.length - 1] as Packet;
    const isPositionRead =
      this.current === "station" &&
      last.instruction === protocol.INST_SYNC_READ &&
      last.parameters[0] === PRESENT_POSITION[0] &&
      last.parameters[1] === PRESENT_POSITION[1];
    this.asked = isPositionRead ? new Set(Array.from(last.parameters.subarray(2))) : null;
    this.heard = [];
    if (goals !== null) for (const [id, goal] of goals) this.goals.set(id, goal);

    try {
      await this.#inner.write(bytes);
    } catch (error) {
      // What the servos hold after a write the line failed is not known: no last goal is assumed, so that the
      // next goal passes only as a measured pose
      if (goals !== null) this.goals.clear();
      this.failure ??= error;
      throw error;
    }
  }

  async read(maxLength: number, timeoutMs: number): Promise<Uint8Array> {
    let received: Uint8Array;
    try {
      received = await this.#inner.read(maxLength, timeoutMs);
    } catch (error) {
      this.failure ??= error;
      throw error;
    }
    if (this.asked !== null && received.length > 0) {
      for (let index = 0; index < received.length; index++) this.heard.push(received[index] as number);
      this.takePositions(this.asked);
    }

    return received;
  }

  async close(): Promise<void> {
    await this.#inner.close();
  }

  /** Forgets the settings, the goals and the positions; the counts and the refusals stay. */
  private forget(): void {
    this.settings = new Map();
    this.goals.clear();
    this.present.clear();
    this.asked = null;
    this.heard = [];
  }

  private noteRefusal(violation: StationGuardViolation): void {
    this.refusedCount += 1;
    this.refusedBy[violation.reason] = (this.refusedBy[violation.reason] ?? 0) + 1;
    this.refusals.push({
      reason: violation.reason,
      message: violation.message,
      instruction: violation.instruction,
      id: violation.id,
      address: violation.address,
      atMs: this.now(),
    });
    if (this.refusals.length > REFUSALS_KEPT) this.refusals.splice(0, this.refusals.length - REFUSALS_KEPT);
    this.options.onRefused?.(violation);
  }

  /**
   * Returns the packets of ``bytes`` when they are reading packets and nothing else, by the read-only guard's own
   * parsing; null when the state "station" has to look at them as a write. In the state "reads" it throws what
   * the read-only guard throws.
   */
  private readingPackets(bytes: Uint8Array): Packet[] | null {
    let instructions: number[];
    try {
      instructions = instructionsOf(bytes);
    } catch (error) {
      if (this.current === "station") return null;
      throw new StationGuardViolation(error instanceof Error ? error.message : String(error), "not-a-packet", null);
    }
    const refused = instructions.find((code) => !READING_INSTRUCTIONS.has(code));
    if (refused === undefined) return packetsOf(bytes);
    if (this.current === "station") return null;

    const packet = packetsOf(bytes).find(({ instruction }) => instruction === refused) as Packet;
    throw new StationGuardViolation(
      `Refused: ${instructionName(refused)} is not a ping or a read; the guard lets no write through yet`,
      "reads-only",
      refused,
      packet.id,
      packet.instruction === protocol.INST_SYNC_WRITE || packet.parameters.length === 0 ? null : (packet.parameters[0] as number),
    );
  }

  /** Returns ``bytes`` as the one writing packet they are, in the state "station"; throws for bytes that are no
   * whole packet, for a packet joined to another, and for an instruction that never passes. */
  private writingPacket(bytes: Uint8Array): Packet {
    if (this.current !== "station") {
      throw new StationGuardViolation("Refused: the guard lets no write through yet", "reads-only", null);
    }
    const packet = onePacket(bytes);
    if (packet === null) {
      throw new StationGuardViolation("Refused: the bytes are not one whole instruction packet", "not-a-packet", null);
    }
    const { id, instruction, parameters } = packet;
    if (READING_INSTRUCTIONS.has(instruction)) {
      // a reading packet comes here only when the read-only parsing refused it
      throw new StationGuardViolation("Refused: 0xFF inside an instruction packet", "not-a-packet", instruction, id);
    }
    if (instruction !== protocol.INST_WRITE && instruction !== protocol.INST_SYNC_WRITE) {
      throw new StationGuardViolation(
        `Refused: ${instructionName(instruction)} is no instruction of the station`,
        "instruction",
        instruction,
        id,
        parameters.length > 0 && instruction === protocol.INST_REG_WRITE ? (parameters[0] as number) : null,
      );
    }

    return packet;
  }

  /** Checks a SYNC WRITE against row 2 and returns its goals by servo; throws when it does not pass. */
  private checkedGoals({ id, instruction, parameters }: Packet): Map<number, number> {
    const address = parameters.length > 0 ? (parameters[0] as number) : null;
    const refuse = (reason: RefusalReason, message: string): never => {
      throw new StationGuardViolation(`Refused: SYNC WRITE, ${message}`, reason, instruction, id, address);
    };
    if (id !== protocol.BROADCAST_ID) refuse("id", `sent to the servo ${id} and not to all`);
    if (address !== GOAL_POSITION[0]) refuse("address", `address ${address} is not Goal_Position`);
    if (parameters[1] !== GOAL_POSITION[1]) refuse("length", `${parameters[1]} bytes each for Goal_Position`);
    const each = 1 + GOAL_POSITION[1];
    if (parameters.length !== 2 + ARM_IDS.length * each) refuse("servos", "not exactly the six servos");

    const goals = new Map<number, number>();
    for (let offset = 2; offset < parameters.length; offset += each) {
      const servo = parameters[offset] as number;
      if (!ARM_IDS.includes(servo)) refuse("servos", `the servo ${servo} is not one of the six`);
      if (goals.has(servo)) refuse("servos", `the servo ${servo} is named twice`);
      // The low byte of a goal is the one place a byte 0xFF passes: its neighbours are a servo's id and a high
      // byte that is not 0xFF, so it can not form the header of a packet
      const high = parameters[offset + 2] as number;
      if (high === 0xff) refuse("value", `0xFF is the high byte of the goal of the servo ${servo}`);
      // A goal is a sign and a magnitude. The one word the library's encoding never gives is a zero with its sign
      // set; every other word is the encoding of the steps it decodes to
      const word = protocol.makeWord(parameters[offset + 1] as number, high);
      const goal = decodeSignMagnitude(word, GOAL_SIGN_BIT);
      if (encodeSignMagnitude(goal, GOAL_SIGN_BIT) !== word) {
        refuse("value", `the goal of the servo ${servo} is a zero with its sign set`);
      }
      goals.set(servo, goal);
    }

    const now = this.now();
    for (const [servo, goal] of goals) {
      const lastGoal = this.goals.get(servo);
      const seen = this.present.get(servo);
      const isNearGoal = lastGoal !== undefined && Math.abs(goal - lastGoal) <= GOAL_STEP_LIMIT;
      const isNearPresent =
        seen !== undefined && now - seen.atMs <= PRESENT_MAX_AGE_MS && Math.abs(goal - seen.position) <= GOAL_STEP_LIMIT;
      if (!isNearGoal && !isNearPresent) {
        const from = lastGoal === undefined ? "no goal before it" : `the last goal ${lastGoal}`;
        const at = seen === undefined ? "no position seen" : `the position ${seen.position} seen ${Math.round(now - seen.atMs)} ms ago`;
        refuse("jump", `the goal ${goal} of the servo ${servo} jumps: ${from}, ${at}`);
      }
    }

    return goals;
  }

  /** Checks a WRITE against rows 3 to 6; throws when it does not pass. */
  private checkWrite({ id, instruction, parameters }: Packet): void {
    const address = parameters.length > 0 ? (parameters[0] as number) : null;
    const refuse = (reason: RefusalReason, message: string): never => {
      throw new StationGuardViolation(`Refused: WRITE to the servo ${id}, ${message}`, reason, instruction, id, address);
    };
    if (!ARM_IDS.includes(id)) refuse("id", "which is not one of the six");
    if (address === null) refuse("address", "without an address");
    // the id, the length and the address of a packet that came this far are below 0xFF; its data must be as well
    if (parameters.includes(0xff)) refuse("value", "0xFF inside the packet");

    const data = parameters.subarray(1);
    const value = data.length === 1 ? (data[0] as number) : data.length === 2 ? protocol.makeWord(data[0] as number, data[1] as number) : null;
    let bytes: number;
    let isAllowed: (value: number) => boolean;
    const setting = this.settings.get(id)?.get(address as number);
    if (address === TORQUE_ENABLE[0] || address === LOCK[0]) {
      bytes = 1;
      isAllowed = (written) => written === 0 || written === 1;
    } else if (address === ACCELERATION[0]) {
      bytes = ACCELERATION[1];
      isAllowed = (written) => written === ACCELERATION_VALUE;
    } else if (setting !== undefined) {
      bytes = setting.bytes;
      isAllowed = (written) => written === setting.value;
    } else {
      return refuse("address", `address ${address} is no register the station writes to this servo`);
    }
    if (data.length !== bytes || value === null) refuse("length", `${data.length} bytes at address ${address}, a register of ${bytes}`);
    if (!isAllowed(value as number)) refuse("value", `the value ${value} at address ${address}`);
  }

  /** Takes the servos' positions out of what was heard since a SYNC READ of Present_Position: whole status
   * packets of the servos ``asked``, with a checksum that holds and no error told. Bytes that are no such packet
   * are dropped one at a time; the beginning of one is kept for the bytes that follow. */
  private takePositions(asked: ReadonlySet<number>): void {
    const heard = this.heard;
    let start = 0;
    while (heard.length - start >= POSITION_ANSWER_LENGTH) {
      const id = heard[start + protocol.PKT_ID] as number;
      const isAnswer =
        heard[start] === 0xff && heard[start + 1] === 0xff && asked.has(id) && heard[start + protocol.PKT_LENGTH] === PRESENT_POSITION[1] + 2;
      if (!isAnswer) {
        start += 1;
        continue;
      }
      let sum = 0;
      for (let index = start + protocol.PKT_ID; index < start + POSITION_ANSWER_LENGTH - 1; index++) sum += heard[index] as number;
      if ((~sum & 0xff) !== heard[start + POSITION_ANSWER_LENGTH - 1]) {
        start += 1;
        continue;
      }
      const word = protocol.makeWord(heard[start + protocol.PKT_PARAMETER0] as number, heard[start + protocol.PKT_PARAMETER0 + 1] as number);
      if (heard[start + protocol.PKT_ERROR] === 0 && ARM_IDS.includes(id)) {
        this.present.set(id, { position: decodeSignMagnitude(word, PRESENT_SIGN_BIT), atMs: this.now() });
      }
      start += POSITION_ANSWER_LENGTH;
    }
    heard.splice(0, start);
  }
}

/** What a run of the guard on packets of every kind found, for each of its states. */
export interface StationGuardSelfTest {
  /** How many packets passed of those that must, and how many were refused with nothing sent of those that must. */
  reads: { passed: number; mustPass: number; refused: number; mustRefuse: number };
  station: { passed: number; mustPass: number; refused: number; mustRefuse: number };
  /** What went wrong; empty when the guard holds. */
  failures: string[];
}

/**
 * Runs the guard on a line that leads nowhere, in both of its states: the packets that must pass and the packets
 * that must be refused, built by the library's own packet functions. The line answers a read of the positions
 * with every servo at 2048, so that the rule against jumps is tried as well. The page shows the result, so that
 * a broken guard is seen before any arm is connected.
 */
export async function stationGuardSelfTest(): Promise<StationGuardSelfTest> {
  const sent: Uint8Array[] = [];
  let waiting: number[] = [];
  const positions = protocol.syncReadPacket(PRESENT_POSITION[0], PRESENT_POSITION[1], ARM_IDS);
  const sink: Transport = {
    write: async (bytes) => {
      sent.push(bytes.slice());
      const isPositionRead = bytes.length === positions.length && bytes.every((byte, index) => byte === positions[index]);
      // each servo's answer: no error, the position 2048
      waiting = isPositionRead ? ARM_IDS.flatMap((id) => [0xff, 0xff, id, 4, 0, 0x00, 0x08, ~(id + 4 + 0x08) & 0xff]) : [];
    },
    read: async (maxLength) => Uint8Array.from(waiting.splice(0, maxLength)),
    close: async () => undefined,
  };
  const guard = new StationGuardTransport(sink, { now: () => 0 });
  const goalsPacket = (goals: readonly number[]): Uint8Array =>
    protocol.syncWritePacket(
      GOAL_POSITION[0],
      GOAL_POSITION[1],
      ARM_IDS.flatMap((id, index) => [id, ...protocol.splitIntoByteChunks(goals[index] as number, 2)]),
    );
  const at = (goal: number, first = goal): number[] => [first, goal, goal, goal, goal, goal];
  const settings: StationSettings = { 1: [{ address: 21, bytes: 1, value: 16 }], 2: [], 3: [], 4: [], 5: [], 6: [{ address: 16, bytes: 2, value: 500 }] };
  const ping = protocol.pingPacket(1);
  const torqueOn = protocol.writePacket(1, TORQUE_ENABLE[0], [1]);
  const corrupt = protocol.writePacket(1, TORQUE_ENABLE[0], [1]);
  corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] as number) ^ 0xff;

  const reading: Array<[string, Uint8Array]> = [
    ["PING", ping],
    ["READ Present_Position", protocol.readPacket(1, PRESENT_POSITION[0], PRESENT_POSITION[1])],
    ["SYNC READ Present_Position", positions],
  ];
  const never: Array<[string, Uint8Array]> = [
    ["WRITE Goal_Position", protocol.writePacket(1, GOAL_POSITION[0], [0x00, 0x08])],
    ["WRITE Torque_Enable 128", protocol.writePacket(1, TORQUE_ENABLE[0], [128])],
    ["WRITE Torque_Enable to all", protocol.writePacket(protocol.BROADCAST_ID, TORQUE_ENABLE[0], [0])],
    ["WRITE Torque_Enable to the servo 7", protocol.writePacket(7, TORQUE_ENABLE[0], [0])],
    ["WRITE Acceleration 0", protocol.writePacket(1, ACCELERATION[0], [0])],
    ["WRITE Phase", protocol.writePacket(1, 18, [0])],
    ["WRITE ID", protocol.writePacket(1, 5, [2])],
    ["WRITE Homing_Offset", protocol.writePacket(1, 31, [0, 0])],
    ["WRITE a setting with another value", protocol.writePacket(1, 21, [17])],
    ["WRITE a setting of another servo", protocol.writePacket(2, 21, [16])],
    ["REG WRITE", protocol.instructionPacket(1, protocol.INST_REG_WRITE, [GOAL_POSITION[0], 0x00, 0x08])],
    ["ACTION", protocol.instructionPacket(protocol.BROADCAST_ID, protocol.INST_ACTION, [])],
    ["RESET", protocol.instructionPacket(1, 0x06, [])],
    ["an unknown instruction", protocol.instructionPacket(1, 0x0b, [])],
    ["SYNC WRITE Torque_Enable", protocol.syncWritePacket(TORQUE_ENABLE[0], 1, ARM_IDS.flatMap((id) => [id, 1]))],
    ["SYNC WRITE Goal_Position of five servos", protocol.syncWritePacket(42, 2, [1, 0, 8, 2, 0, 8, 3, 0, 8, 4, 0, 8, 5, 0, 8])],
    ["SYNC WRITE Goal_Position with a jump", goalsPacket(at(2048, 2048 + 2 * GOAL_STEP_LIMIT + 1))],
    ["SYNC WRITE Goal_Position with its sign set by mistake", goalsPacket(at(2048, 0x8000 + 2048))],
    ["SYNC WRITE Goal_Position of a zero with its sign set", goalsPacket(at(2048, 0x8000))],
    ["a ping followed by a write", Uint8Array.from([...ping, ...torqueOn])],
    ["a write with a wrong checksum", corrupt],
    ["half a packet", ping.subarray(0, 4)],
    ["no bytes", new Uint8Array(0)],
  ];
  const writing: Array<[string, Uint8Array]> = [
    ["SYNC WRITE Goal_Position at the positions", goalsPacket(at(2048))],
    ["SYNC WRITE Goal_Position one step on", goalsPacket(at(2048, 2048 + GOAL_STEP_LIMIT))],
    ["WRITE Torque_Enable 1", torqueOn],
    ["WRITE Torque_Enable 0", protocol.writePacket(6, TORQUE_ENABLE[0], [0])],
    ["WRITE Lock 1", protocol.writePacket(1, LOCK[0], [1])],
    ["WRITE Acceleration 254", protocol.writePacket(1, ACCELERATION[0], [ACCELERATION_VALUE])],
    ["WRITE a setting of one byte", protocol.writePacket(1, 21, [16])],
    ["WRITE a setting of two bytes", protocol.writePacket(6, 16, protocol.splitIntoByteChunks(500, 2))],
  ];

  const result: StationGuardSelfTest = {
    reads: { passed: 0, mustPass: reading.length, refused: 0, mustRefuse: writing.length + never.length },
    station: { passed: 0, mustPass: reading.length + writing.length, refused: 0, mustRefuse: never.length },
    failures: [],
  };
  const tryAll = async (state: GuardState, packets: Array<[string, Uint8Array]>, mustPass: boolean): Promise<void> => {
    for (const [label, packet] of packets) {
      const before = sent.length;
      try {
        await guard.write(packet);
        if (!mustPass) result.failures.push(`${state}, ${label}: was let through`);
        else if (sent.length !== before + 1) result.failures.push(`${state}, ${label}: passed, but was not sent`);
        else result[state].passed += 1;
        while ((await guard.read(64, 0)).length > 0); // the guard hears the answers
      } catch (error) {
        if (mustPass) result.failures.push(`${state}, ${label}: refused, though the station sends it`);
        else if (!(error instanceof StationGuardViolation)) result.failures.push(`${state}, ${label}: failed otherwise: ${String(error)}`);
        else if (sent.length !== before) result.failures.push(`${state}, ${label}: refused, but bytes were sent`);
        else result[state].refused += 1;
      }
    }
  };

  await tryAll("reads", reading, true);
  await tryAll("reads", [...writing, ...never], false);
  guard.enterStation(settings);
  await tryAll("station", reading, true); // its last packet reads the positions
  await tryAll("station", writing, true);
  await tryAll("station", never, false);
  guard.backToReads();
  if (guard.state !== "reads") result.failures.push("the guard did not go back to the state reads");

  return result;
}
