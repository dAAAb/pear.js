// Not in PEAR: the page's guarantee that it only reads. Every byte the page sends to the servos passes through
// this wrapper of the bus's transport, which lets a packet through only when it is, provably, a PING, a READ or a
// SYNC READ, and refuses everything else before a byte of it reaches the port: WRITE, REG WRITE, ACTION,
// SYNC WRITE, any other instruction, and bytes that are not whole instruction packets.

import { protocol, type Transport } from "../../src/feetech/index";

/** The instructions that change nothing in a servo, with the names the page shows. */
export const READING_INSTRUCTIONS: ReadonlyMap<number, string> = new Map([
  [protocol.INST_PING, "PING"],
  [protocol.INST_READ, "READ"],
  [protocol.INST_SYNC_READ, "SYNC READ"],
]);

/** The names of the instructions the guard refuses, where the protocol has one; any other reads as its number. */
const REFUSED_NAMES: ReadonlyMap<number, string> = new Map([
  [protocol.INST_WRITE, "WRITE"],
  [protocol.INST_REG_WRITE, "REG WRITE"],
  [protocol.INST_ACTION, "ACTION"],
  [protocol.INST_SYNC_WRITE, "SYNC WRITE"],
  [0x06, "RESET"],
]);

/** Returns the name of the instruction ``code``. */
export function instructionName(code: number): string {
  return READING_INSTRUCTIONS.get(code) ?? REFUSED_NAMES.get(code) ?? `0x${code.toString(16).padStart(2, "0")}`;
}

/** Thrown for bytes that are not provably a read; nothing of them was sent. */
export class ReadOnlyViolation extends Error {
  override readonly name: string = "ReadOnlyViolation";

  constructor(
    message: string,
    /** The instruction that was refused; null for bytes that are no whole instruction packets. */
    readonly instruction: number | null,
  ) {
    super(message);
  }
}

/** What the guard has let through and what it has refused, by the instruction's name. */
export interface GuardCounts {
  passed: Record<string, number>;
  refused: Record<string, number>;
}

export interface GuardHooks {
  /** Told of every refusal, before it is thrown. */
  onRefused?: (violation: ReadOnlyViolation) => void;
}

/** Returns the instructions of the packets ``bytes`` are made of; throws unless they are whole instruction
 * packets, one after another, each with its checksum. */
export function instructionsOf(bytes: Uint8Array): number[] {
  const instructions: number[] = [];
  let offset = 0;
  if (bytes.length === 0) throw new ReadOnlyViolation("Refused: no bytes are no instruction packet", null);

  while (offset < bytes.length) {
    const left = bytes.length - offset;
    // FF FF ID LENGTH INSTRUCTION PARAMETERS... CHECKSUM, where LENGTH counts from the instruction to the checksum
    if (left < 6 || bytes[offset] !== 0xff || bytes[offset + 1] !== 0xff) {
      throw new ReadOnlyViolation("Refused: the bytes are not a whole instruction packet", null);
    }
    const length = bytes[offset + protocol.PKT_LENGTH] as number;
    const total = length + 4;
    if (length < 2 || total > left) {
      throw new ReadOnlyViolation("Refused: the bytes are not a whole instruction packet", null);
    }
    let sum = 0;
    for (let index = offset + protocol.PKT_ID; index < offset + total - 1; index++) {
      // Between its header and its checksum no packet of this page holds 0xFF: ids are 1 to 253 and 0xFE, and
      // addresses, lengths and the three instructions are smaller. With one there, a servo could take the packet's
      // start for one byte later (FF FF FF ..) and read the bytes that follow as another id, length and instruction.
      if (bytes[index] === 0xff) {
        throw new ReadOnlyViolation("Refused: 0xFF inside an instruction packet", null);
      }
      sum += bytes[index] as number;
    }
    if ((~sum & 0xff) !== bytes[offset + total - 1]) {
      throw new ReadOnlyViolation("Refused: an instruction packet with a wrong checksum", null);
    }

    instructions.push(bytes[offset + protocol.PKT_INSTRUCTION] as number);
    offset += total;
  }

  return instructions;
}

/**
 * A transport that only reads: write() sends ``bytes`` on only if every packet in them is a PING, a READ or a
 * SYNC READ, and throws ReadOnlyViolation otherwise, with nothing sent. Reading and closing pass through.
 */
export class ReadOnlyTransport implements Transport {
  readonly counts: GuardCounts = { passed: {}, refused: {} };
  /** Whether the line handed the page its own bytes back: the adapter echoes, which the bus does not handle. */
  echoSeen = false;
  /** Why the line itself stopped working (the port was lost or closed); null while it works. A servo that does
   * not answer is no failure of the line: the transport then reads nothing, and does not throw. */
  failure: unknown = null;
  // the broadcast packet sent last and what came in since: no servo's answer holds a broadcast packet's bytes
  private watched: Uint8Array | null = null;
  private heard: number[] = [];
  /** The transport that is guarded: a private name of the language itself, so that no code outside this class
   * can reach it at run time and write past the guard. */
  readonly #inner: Transport;

  constructor(
    inner: Transport,
    private readonly hooks: GuardHooks = {},
  ) {
    this.#inner = inner;
  }

  async write(bytes: Uint8Array): Promise<void> {
    let instructions: number[];
    try {
      instructions = instructionsOf(bytes);
      const refused = instructions.find((code) => !READING_INSTRUCTIONS.has(code));
      if (refused !== undefined) {
        throw new ReadOnlyViolation(
          `Refused: ${instructionName(refused)} is not a ping or a read; this page never writes to a servo`,
          refused,
        );
      }
    } catch (error) {
      if (error instanceof ReadOnlyViolation) {
        const name = error.instruction === null ? "not a packet" : instructionName(error.instruction);
        this.counts.refused[name] = (this.counts.refused[name] ?? 0) + 1;
        this.hooks.onRefused?.(error);
      }
      throw error;
    }

    for (const code of instructions) {
      const name = instructionName(code);
      this.counts.passed[name] = (this.counts.passed[name] ?? 0) + 1;
    }
    this.watched = bytes[protocol.PKT_ID] === protocol.BROADCAST_ID ? bytes.slice() : null;
    this.heard = [];
    try {
      await this.#inner.write(bytes);
    } catch (error) {
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
    const watched = this.watched;
    if (received.length > 0 && watched !== null) {
      for (let index = 0; index < received.length; index++) this.heard.push(received[index] as number);
      const lastStart = this.heard.length - watched.length;
      for (let start = 0; start <= lastStart && this.watched !== null; start++) {
        if (watched.every((byte, index) => this.heard[start + index] === byte)) {
          this.echoSeen = true;
          this.watched = null;
        }
      }
      if (this.watched !== null && lastStart > 0) this.heard.splice(0, lastStart); // keep what may still begin one
    }

    return received;
  }

  async close(): Promise<void> {
    await this.#inner.close();
  }
}

/** What a run of the guard on packets of every kind found. */
export interface GuardSelfTest {
  /** How many reading packets passed, of ``readingTried``. */
  readingPassed: number;
  readingTried: number;
  /** How many writing, unknown or malformed inputs were refused with nothing sent, of ``writingTried``. */
  writingRefused: number;
  writingTried: number;
  /** What went wrong; empty when the guard holds. */
  failures: string[];
}

/**
 * Runs the guard on a line that leads nowhere: packets of every reading and writing instruction, built by the
 * library's own packet functions, and bytes that are no packets. The page shows the result, so that a broken
 * guard is seen before any arm is connected.
 */
export async function guardSelfTest(): Promise<GuardSelfTest> {
  const sent: Uint8Array[] = [];
  const sink: Transport = {
    write: async (bytes) => {
      sent.push(bytes.slice());
    },
    read: async () => new Uint8Array(0),
    close: async () => undefined,
  };
  const guard = new ReadOnlyTransport(sink);
  const ids = [1, 2, 3, 4, 5, 6];
  const goal = protocol.syncWriteParameters(
    2,
    ids.map((id) => [id, [0x00, 0x08]] as const),
  );

  const reading: Array<[string, Uint8Array]> = [
    ["PING", protocol.pingPacket(1)],
    ["READ Present_Position", protocol.readPacket(1, 56, 2)],
    ["SYNC READ Present_Position", protocol.syncReadPacket(56, 2, ids)],
  ];
  const ping = protocol.pingPacket(1);
  const torqueOn = protocol.writePacket(1, 40, [1]);
  const corrupt = protocol.writePacket(1, 40, [1]);
  corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] as number) ^ 0xff;
  const joined = new Uint8Array(ping.length + torqueOn.length);
  joined.set(ping, 0);
  joined.set(torqueOn, ping.length);
  const writing: Array<[string, Uint8Array]> = [
    ["WRITE Torque_Enable", torqueOn],
    ["WRITE Goal_Position", protocol.writePacket(1, 42, [0x00, 0x08])],
    ["REG WRITE", protocol.instructionPacket(1, protocol.INST_REG_WRITE, [42, 0x00, 0x08])],
    ["ACTION", protocol.instructionPacket(protocol.BROADCAST_ID, protocol.INST_ACTION, [])],
    ["SYNC WRITE Goal_Position", protocol.syncWritePacket(42, 2, goal)],
    ["RESET", protocol.instructionPacket(1, 0x06, [])],
    ["an unknown instruction", protocol.instructionPacket(1, 0x0b, [])],
    ["a ping followed by a write", joined],
    ["a write with a wrong checksum", corrupt],
    ["half a packet", ping.subarray(0, 4)],
    ["bytes that are no packet", Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06])],
    ["no bytes", new Uint8Array(0)],
  ];

  const result: GuardSelfTest = {
    readingPassed: 0,
    readingTried: reading.length,
    writingRefused: 0,
    writingTried: writing.length,
    failures: [],
  };
  for (const [label, packet] of reading) {
    const before = sent.length;
    try {
      await guard.write(packet);
      if (sent.length === before + 1) result.readingPassed += 1;
      else result.failures.push(`${label}: passed, but was not sent`);
    } catch {
      result.failures.push(`${label}: refused, though it only reads`);
    }
  }
  for (const [label, packet] of writing) {
    const before = sent.length;
    try {
      await guard.write(packet);
      result.failures.push(`${label}: was let through`);
    } catch (error) {
      if (!(error instanceof ReadOnlyViolation)) result.failures.push(`${label}: failed otherwise: ${String(error)}`);
      else if (sent.length !== before) result.failures.push(`${label}: refused, but bytes were sent`);
      else result.writingRefused += 1;
    }
  }

  return result;
}
