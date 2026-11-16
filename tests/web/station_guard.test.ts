// The guard between PEAR's station and a real arm's port (web/src/station_guard.ts), in Node: its policy row by
// row, each row with a packet that passes and the nearest packets that do not; the state "reads" beside the
// read-only guard; the rule against a goal that jumps, on a clock of the test's own; the counts and the refusals
// it tells; and PEAR's station itself on the library's simulated arm with the guard as its line, where nothing
// the station sends may be refused.

import { describe, expect, it } from "vitest";

import { encodeSignMagnitude, protocol, type Transport } from "../../src/feetech/index";
import type { Clock } from "../../src/feetech/transport";
import { simulatedArm } from "../../src/so101/hardware/index";
import { SO101Robot } from "../../src/so101/robot";
import type { MonotonicClock } from "../../src/station/joint/clock";
import { SIM_CALIBRATION, SIM_START_POSITIONS } from "../../web/src/sim_port";
import { STATION_CONFIG, uuid4 } from "../../web/src/station_host";
import { guardSelfTest, ReadOnlyTransport, ReadOnlyViolation } from "../../web/src/readonly";
import {
  ARM_IDS,
  GOAL_STEP_LIMIT,
  PRESENT_MAX_AGE_MS,
  REFUSALS_KEPT,
  StationGuardTransport,
  StationGuardViolation,
  stationGuardSelfTest,
  type StationSetting,
  type StationSettings,
} from "../../web/src/station_guard";

const BROADCAST = protocol.BROADCAST_ID;
const READ_POSITIONS = protocol.syncReadPacket(56, 2, ARM_IDS);

/** What PEAR's enable writes to every servo, and to the gripper besides. */
const EVERY: StationSetting[] = [
  { address: 7, bytes: 1, value: 0 },
  { address: 85, bytes: 1, value: 254 },
  { address: 33, bytes: 1, value: 0 },
  { address: 21, bytes: 1, value: 16 },
  { address: 22, bytes: 1, value: 32 },
  { address: 23, bytes: 1, value: 0 },
];
const GRIPPER: StationSetting[] = [
  { address: 16, bytes: 2, value: 500 },
  { address: 28, bytes: 2, value: 250 },
  { address: 36, bytes: 1, value: 25 },
];
const SETTINGS: StationSettings = { 1: EVERY, 2: EVERY, 3: EVERY, 4: EVERY, 5: EVERY, 6: [...EVERY, ...GRIPPER] };

/** A line that leads nowhere: it keeps what was sent, and answers a SYNC READ of Present_Position as six servos
 * at `positions` do. */
class Line implements Transport {
  readonly sent: Uint8Array[] = [];
  positions = [2048, 2048, 2048, 2048, 2048, 2048];
  /** How many bytes each read hands over, in turn; all that wait when there is none. */
  pieces: number[] = [];
  /** Changes the answers before they are handed over. */
  spoil: ((answers: number[]) => void) | null = null;
  /** What the next write fails with. */
  failure: Error | null = null;
  isClosed = false;
  private waiting: number[] = [];
  private turn = 0;

  async write(bytes: Uint8Array): Promise<void> {
    if (this.failure !== null) throw this.failure;
    this.sent.push(bytes.slice());
    this.waiting = [];
    if (bytes[4] !== protocol.INST_SYNC_READ || bytes[5] !== 56 || bytes[6] !== 2) return;
    for (const id of Array.from(bytes.subarray(7, bytes.length - 1))) {
      const word = encodeSignMagnitude(this.positions[id - 1] as number, 15); // on the wire bit 15 is the sign
      const body = [id, 4, 0, word & 0xff, word >> 8];
      this.waiting.push(0xff, 0xff, ...body, ~body.reduce((sum, byte) => sum + byte, 0) & 0xff);
    }
    this.spoil?.(this.waiting);
  }

  async read(maxLength: number): Promise<Uint8Array> {
    const size = this.pieces.length === 0 ? maxLength : Math.min(maxLength, this.pieces[this.turn++ % this.pieces.length] as number);

    return Uint8Array.from(this.waiting.splice(0, size));
  }

  async close(): Promise<void> {
    this.isClosed = true;
  }
}

interface Rig {
  line: Line;
  clock: { ms: number };
  guard: StationGuardTransport;
  refused: StationGuardViolation[];
  /** Reads the servos' positions through the guard, as the bus does; `positions` moves the servos first. */
  see: (positions?: readonly number[]) => Promise<void>;
}

/** A guard on a line that leads nowhere, with the test's clock; in the state "station" unless `settings` is null. */
function rig(settings: StationSettings | null = SETTINGS): Rig {
  const line = new Line();
  const clock = { ms: 0 };
  const refused: StationGuardViolation[] = [];
  const guard = new StationGuardTransport(line, { now: () => clock.ms, onRefused: (violation) => refused.push(violation) });
  if (settings !== null) guard.enterStation(settings);

  return {
    line,
    clock,
    guard,
    refused,
    see: async (positions) => {
      if (positions !== undefined) line.positions = [...positions];
      await guard.write(READ_POSITIONS);
      while ((await guard.read(64, 0)).length > 0);
    },
  };
}

/** Returns "passed" when the guard sent `packet` on unchanged, and the refusal's reason when it sent nothing. */
async function outcome({ guard, line }: Pick<Rig, "guard" | "line">, packet: Uint8Array): Promise<string> {
  const before = line.sent.length;
  try {
    await guard.write(packet);
  } catch (error) {
    if (!(error instanceof StationGuardViolation)) throw error;
    expect(line.sent.length).toBe(before);

    return error.reason;
  }
  expect(line.sent.length).toBe(before + 1);
  expect(Array.from(line.sent[before] as Uint8Array)).toEqual(Array.from(packet));

  return "passed";
}

/** The SYNC WRITE of Goal_Position for the servos 1 to 6: each goal's two bytes as they go over the wire. */
function wordsPacket(words: readonly number[], ids: readonly number[] = ARM_IDS, address = 42): Uint8Array {
  return protocol.syncWritePacket(
    address,
    2,
    ids.flatMap((id, index) => [id, ...protocol.splitIntoByteChunks(words[index] as number, 2)]),
  );
}

/** The same for goals in steps, encoded as the bus encodes them: a sign in bit 15 and a magnitude. */
function goalsPacket(goals: readonly number[], ids: readonly number[] = ARM_IDS, address = 42): Uint8Array {
  return wordsPacket(goals.map((goal) => encodeSignMagnitude(goal, 15)), ids, address);
}

const all = (goal: number): number[] => ARM_IDS.map(() => goal);
/** Every servo at `goal` but the third, which is at `third`. */
const third = (goal: number, other: number): number[] => ARM_IDS.map((id) => (id === 3 ? other : goal));
const regWrite = (id: number, address: number, data: number[]): Uint8Array =>
  protocol.instructionPacket(id, protocol.INST_REG_WRITE, [address, ...data]);

describe("the station guard's policy, row by row", () => {
  it("row 1: a ping and reads of any register pass, alone or joined, as in the state reads", async () => {
    const r = rig();
    const reads = [
      protocol.pingPacket(1),
      protocol.pingPacket(BROADCAST),
      protocol.readPacket(1, 56, 2),
      protocol.readPacket(9, 5, 1),
      READ_POSITIONS,
      protocol.syncReadPacket(0, 4, [1, 2, 3, 9]),
      Uint8Array.from([...protocol.pingPacket(1), ...protocol.readPacket(2, 56, 2)]),
    ];
    for (const packet of reads) expect(await outcome(r, packet)).toBe("passed");
    expect(r.guard.status().passed).toEqual({ PING: 3, READ: 3, "SYNC READ": 2 });

    // the same parameters under the next instruction are a write
    expect(await outcome(r, protocol.instructionPacket(1, protocol.INST_WRITE, [56, 2]))).toBe("address");
    expect(await outcome(r, protocol.instructionPacket(BROADCAST, protocol.INST_SYNC_WRITE, [56, 2, 1, 2, 3, 4, 5, 6]))).toBe("address");
    const corrupt = protocol.readPacket(1, 56, 2);
    corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] as number) ^ 0x01;
    expect(await outcome(r, corrupt)).toBe("not-a-packet");
    expect(await outcome(r, protocol.readPacket(1, 56, 2).subarray(0, 7))).toBe("not-a-packet");
    expect(await outcome(r, new Uint8Array(0))).toBe("not-a-packet");
    // a reading packet with 0xFF inside is refused as the read-only guard refuses it
    expect(await outcome(r, Uint8Array.from([0xff, 0xff, 0x01, 0x04, 0x02, 0xff, 0x02, 0xf7]))).toBe("not-a-packet");
    expect(await outcome(r, Uint8Array.from([...protocol.pingPacket(1), ...protocol.writePacket(1, 40, [1])]))).toBe("not-a-packet");
  });

  it("row 2: only a SYNC WRITE of Goal_Position to exactly the six servos passes, each goal a sign and a magnitude", async () => {
    const r = rig();
    await r.see(all(2048));
    expect(await outcome(r, goalsPacket(all(2048)))).toBe("passed");
    expect(await outcome(r, goalsPacket(all(2049).reverse(), [6, 5, 4, 3, 2, 1]))).toBe("passed");
    expect(r.guard.status().passed["SYNC WRITE 42"]).toBe(2);

    // no range is set for a goal: it passes wherever the servo is, past 4095 and below zero, with a low byte 0xFF
    await r.see(all(4095));
    expect(await outcome(r, goalsPacket(all(4095)))).toBe("passed");
    expect(await outcome(r, goalsPacket(third(4095, 4096)))).toBe("passed");
    await r.see(all(-255));
    expect(await outcome(r, goalsPacket(all(-255)))).toBe("passed");
    await r.see(all(0));
    expect(await outcome(r, goalsPacket(all(0)))).toBe("passed");
    // the two bytes are a sign and a magnitude as the library encodes one: never a zero with its sign set, and
    // never a high byte 0xFF, which after a low byte 0xFF would be a packet's header
    expect(await outcome(r, wordsPacket(third(0, 0x8000)))).toBe("value");
    expect(await outcome(r, wordsPacket(third(0, 0xffff)))).toBe("value");
    expect(await outcome(r, wordsPacket(third(0, 0xff00)))).toBe("value");
    expect(await outcome(r, wordsPacket(third(0, 0xfeff)))).toBe("jump");
    expect(r.guard.status().goals).toEqual(all(0));

    await r.see(all(2048));
    expect(await outcome(r, goalsPacket(all(2048)))).toBe("passed");
    // the servos: one missing, one twice, one more, one that is none of the six
    expect(await outcome(r, goalsPacket(all(2048), [1, 2, 3, 4, 5]))).toBe("servos");
    expect(await outcome(r, goalsPacket(all(2048), [1, 2, 3, 4, 5, 5]))).toBe("servos");
    expect(await outcome(r, goalsPacket([...all(2048), 2048], [1, 2, 3, 4, 5, 6, 1]))).toBe("servos");
    expect(await outcome(r, goalsPacket(all(2048), [0, 2, 3, 4, 5, 6]))).toBe("servos");
    expect(await outcome(r, goalsPacket(all(2048), [1, 2, 3, 4, 5, 7]))).toBe("servos");
    expect(await outcome(r, goalsPacket(all(2048), [1, 2, 3, 4, 5, BROADCAST]))).toBe("servos");
    // the packet's own id, the address and the length
    const one = goalsPacket(all(2048)).slice(5, -1);
    expect(await outcome(r, protocol.instructionPacket(1, protocol.INST_SYNC_WRITE, one))).toBe("id");
    expect(await outcome(r, protocol.instructionPacket(0, protocol.INST_SYNC_WRITE, one))).toBe("id");
    expect(await outcome(r, goalsPacket(all(2048), ARM_IDS, 41))).toBe("address");
    expect(await outcome(r, goalsPacket(all(2048), ARM_IDS, 43))).toBe("address");
    expect(await outcome(r, protocol.syncWritePacket(42, 1, ARM_IDS.flatMap((id) => [id, 0x08])))).toBe("length");
    expect(await outcome(r, protocol.syncWritePacket(42, 3, ARM_IDS.flatMap((id) => [id, 0x00, 0x08, 0x00])))).toBe("length");
    expect(await outcome(r, protocol.instructionPacket(BROADCAST, protocol.INST_SYNC_WRITE, []))).toBe("address");
    // the same register by a WRITE and by a REG WRITE
    expect(await outcome(r, protocol.writePacket(1, 42, [0x00, 0x08]))).toBe("address");
    expect(await outcome(r, protocol.writePacket(BROADCAST, 42, [0x00, 0x08]))).toBe("id");
    expect(await outcome(r, regWrite(1, 42, [0x00, 0x08]))).toBe("instruction");
    expect(r.guard.status().goals).toEqual(all(2048));
  });

  /** A register of one byte that every servo may be written: what passes and the nearest that do not. */
  async function oneByteRow(address: number, values: number[], near: number[]): Promise<void> {
    const r = rig();
    for (const id of ARM_IDS) for (const value of values) expect(await outcome(r, protocol.writePacket(id, address, [value]))).toBe("passed");
    expect(r.guard.status().passed).toEqual({ [`WRITE ${address}`]: ARM_IDS.length * values.length });
    for (const value of near) expect(await outcome(r, protocol.writePacket(1, address, [value]))).toBe("value");
    for (const id of [0, 7, BROADCAST]) expect(await outcome(r, protocol.writePacket(id, address, [values[0] as number]))).toBe("id");
    expect(await outcome(r, protocol.writePacket(1, address, [values[0] as number, 0]))).toBe("length");
    expect(await outcome(r, protocol.instructionPacket(1, protocol.INST_WRITE, [address]))).toBe("length");
    expect(await outcome(r, protocol.syncWritePacket(address, 1, ARM_IDS.flatMap((id) => [id, values[0] as number])))).toBe("address");
    expect(await outcome(r, regWrite(1, address, [values[0] as number]))).toBe("instruction");
    expect(r.line.sent).toHaveLength(ARM_IDS.length * values.length);
  }

  it("row 3: Torque_Enable takes 0 or 1 by a WRITE to one of the six servos, never 128", async () => {
    await oneByteRow(40, [0, 1], [2, 128, 129, 254, 255]);
    const r = rig();
    expect(await outcome(r, protocol.writePacket(1, 39, [1]))).toBe("address");
    expect(await outcome(r, protocol.writePacket(1, 39, [0, 1]))).toBe("address"); // a write that ends on it
    expect(await outcome(r, protocol.writePacket(1, 40, [1, 254]))).toBe("length"); // a write that goes on past it
  });

  it("row 4: Lock takes 0 or 1", async () => {
    await oneByteRow(55, [0, 1], [2, 128, 255]);
    const r = rig();
    expect(await outcome(r, protocol.writePacket(1, 54, [1]))).toBe("address");
    expect(await outcome(r, protocol.writePacket(1, 56, [1]))).toBe("address");
  });

  it("row 5: Acceleration takes 254 only", async () => {
    await oneByteRow(41, [254], [0, 1, 253, 255]);
    const r = rig();
    expect(await outcome(r, protocol.writePacket(1, 40, [254]))).toBe("value");
    expect(await outcome(r, protocol.writePacket(1, 42, [254]))).toBe("address");
  });

  it("row 6: a setting passes only with the value given for that servo and register", async () => {
    const r = rig();
    for (const id of ARM_IDS) {
      for (const { address, bytes, value } of SETTINGS[id] as StationSetting[]) {
        const data = protocol.splitIntoByteChunks(value, bytes);
        expect(await outcome(r, protocol.writePacket(id, address, data))).toBe("passed");
        // the value one off, either way
        for (const other of [value + 1, value - 1].filter((near) => near >= 0 && near !== 255)) {
          expect(await outcome(r, protocol.writePacket(id, address, protocol.splitIntoByteChunks(other, bytes)))).toBe("value");
        }
        // the length one off, either way
        expect(await outcome(r, protocol.writePacket(id, address, [...data, 0]))).toBe("length");
        expect(await outcome(r, protocol.writePacket(id, address, data.slice(1)))).toBe("length");
        for (const other of [0, 7, BROADCAST]) expect(await outcome(r, protocol.writePacket(other, address, data))).toBe("id");
        expect(await outcome(r, protocol.syncWritePacket(address, bytes, ARM_IDS.flatMap((servo) => [servo, ...data])))).toBe("address");
        expect(await outcome(r, regWrite(id, address, data))).toBe("instruction");
      }
    }
    expect(r.guard.status().passed).toEqual({
      "WRITE 7": 6, "WRITE 85": 6, "WRITE 33": 6, "WRITE 21": 6, "WRITE 22": 6, "WRITE 23": 6, "WRITE 16": 1, "WRITE 28": 1, "WRITE 36": 1,
    });

    // a register listed for the gripper only, written to another servo
    for (const { address, bytes, value } of GRIPPER) {
      expect(await outcome(r, protocol.writePacket(5, address, protocol.splitIntoByteChunks(value, bytes)))).toBe("address");
    }
    // the addresses beside the settings, and the registers the station never writes
    for (const address of [6, 8, 15, 17, 20, 24, 27, 29, 32, 34, 35, 37, 84, 86, 5, 9, 11, 18, 31, 44, 46, 48]) {
      expect(await outcome(r, protocol.writePacket(1, address, [0]))).toBe("address");
      expect(await outcome(r, protocol.writePacket(6, address, [0, 0]))).toBe("address");
    }

    // a servo given no setting is written none
    const bare = rig({ 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] });
    expect(await outcome(bare, protocol.writePacket(1, 21, [16]))).toBe("address");
    expect(await outcome(bare, protocol.writePacket(1, 40, [1]))).toBe("passed");
  });

  it("is given only addresses of the settings, for exactly the six servos", () => {
    const { guard } = rig(null);
    const withSetting = (setting: StationSetting): StationSettings => ({ ...SETTINGS, 2: [setting] });
    for (const address of [5, 6, 9, 11, 18, 31, 40, 41, 42, 46, 48, 55, 8, 86]) {
      expect(() => guard.enterStation(withSetting({ address, bytes: 1, value: 0 }))).toThrow(RangeError);
    }
    expect(() => guard.enterStation(withSetting({ address: 21, bytes: 3, value: 0 }))).toThrow(RangeError);
    expect(() => guard.enterStation(withSetting({ address: 21, bytes: 1, value: 256 }))).toThrow(RangeError);
    expect(() => guard.enterStation(withSetting({ address: 21, bytes: 1, value: 255 }))).toThrow(RangeError);
    expect(() => guard.enterStation(withSetting({ address: 21, bytes: 1, value: 1.5 }))).toThrow(RangeError);
    expect(() => guard.enterStation({ ...SETTINGS, 2: [...EVERY, EVERY[0] as StationSetting] })).toThrow(RangeError);
    expect(() => guard.enterStation({ 1: EVERY, 2: EVERY, 3: EVERY, 4: EVERY, 5: EVERY })).toThrow(RangeError);
    expect(() => guard.enterStation({ ...SETTINGS, 7: EVERY })).toThrow(RangeError);
    expect(guard.state).toBe("reads");
    guard.enterStation(SETTINGS);
    expect(guard.state).toBe("station");
  });

  it("refuses REG WRITE, ACTION, RESET and every other instruction in both states", async () => {
    for (const settings of [SETTINGS, null]) {
      const r = rig(settings);
      const reason = settings === null ? "reads-only" : "instruction";
      expect(await outcome(r, regWrite(1, 40, [1]))).toBe(reason);
      expect(await outcome(r, protocol.instructionPacket(BROADCAST, protocol.INST_ACTION, []))).toBe(reason);
      expect(await outcome(r, protocol.instructionPacket(1, 0x06, []))).toBe(reason);
      for (const code of [0x00, 0x07, 0x0a, 0x0b, 0x81, 0x84]) expect(await outcome(r, protocol.instructionPacket(1, code, []))).toBe(reason);
      expect(r.line.sent).toHaveLength(0);
    }
  });
});

describe("the state reads", () => {
  /** The packets of guardSelfTest() of readonly.ts: three that read and twelve that do not. */
  function selfTestPackets(): Array<[string, Uint8Array]> {
    const ping = protocol.pingPacket(1);
    const torqueOn = protocol.writePacket(1, 40, [1]);
    const corrupt = protocol.writePacket(1, 40, [1]);
    corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] as number) ^ 0xff;

    return [
      ["PING", ping],
      ["READ Present_Position", protocol.readPacket(1, 56, 2)],
      ["SYNC READ Present_Position", READ_POSITIONS],
      ["WRITE Torque_Enable", torqueOn],
      ["WRITE Goal_Position", protocol.writePacket(1, 42, [0x00, 0x08])],
      ["REG WRITE", regWrite(1, 42, [0x00, 0x08])],
      ["ACTION", protocol.instructionPacket(BROADCAST, protocol.INST_ACTION, [])],
      ["SYNC WRITE Goal_Position", goalsPacket(all(2048))],
      ["RESET", protocol.instructionPacket(1, 0x06, [])],
      ["an unknown instruction", protocol.instructionPacket(1, 0x0b, [])],
      ["a ping followed by a write", Uint8Array.from([...ping, ...torqueOn])],
      ["a write with a wrong checksum", corrupt],
      ["half a packet", ping.subarray(0, 4)],
      ["bytes that are no packet", Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06])],
      ["no bytes", new Uint8Array(0)],
    ];
  }

  it("gives the packets of the read-only guard's self-test the same outcome as the read-only guard", async () => {
    expect(await guardSelfTest()).toMatchObject({ readingPassed: 3, readingTried: 3, writingRefused: 12, writingTried: 12, failures: [] });
    const plainLine = new Line();
    const plain = new ReadOnlyTransport(plainLine);
    const r = rig(null);
    const through = async (transport: Transport, packet: Uint8Array): Promise<string> => {
      try {
        await transport.write(packet);
      } catch (error) {
        if (!(error instanceof ReadOnlyViolation)) throw error;

        return `refused ${String(error.instruction)}: ${error.message.replace(/;.*$/, "")}`;
      }

      return "passed";
    };
    const run = async (): Promise<string[]> => {
      const outcomes: string[] = [];
      for (const [label, packet] of selfTestPackets()) {
        const expected = await through(plain, packet);
        expect(`${label}: ${await through(r.guard, packet)}`).toBe(`${label}: ${expected}`);
        outcomes.push(expected.slice(0, 6));
      }
      expect(r.line.sent.map((bytes) => Array.from(bytes))).toEqual(plainLine.sent.map((bytes) => Array.from(bytes)));

      return outcomes;
    };
    expect(await run()).toEqual([..."ppp"].map(() => "passed").concat(Array.from({ length: 12 }, () => "refuse")));
    expect(r.guard.status().passed).toEqual(plain.counts.passed);
    expect(r.guard.status().refusedCount).toBe(12);

    // and again once the guard has been in the state station and is back
    r.guard.enterStation(SETTINGS);
    await r.see();
    expect(await outcome(r, protocol.writePacket(1, 40, [1]))).toBe("passed");
    expect(await outcome(r, goalsPacket(all(2048)))).toBe("passed");
    r.guard.backToReads();
    expect(r.guard.state).toBe("reads");
    plainLine.sent.length = 0;
    r.line.sent.length = 0;
    await run();
    expect(await outcome(r, goalsPacket(all(2048)))).toBe("reads-only");
    expect(await outcome(r, protocol.writePacket(1, 40, [0]))).toBe("reads-only");
  });

  it("closes the line it guards", async () => {
    const r = rig();
    await r.guard.close();
    expect(r.line.isClosed).toBe(true);
  });
});

describe("no goal that jumps", () => {
  it("lets a ramp of 13 steps a period through for 100 periods, up and down", async () => {
    const r = rig();
    await r.see(all(1000));
    expect(await outcome(r, goalsPacket(all(1000)))).toBe("passed");
    for (let period = 1; period <= 100; period++) {
      r.clock.ms += 20;
      expect(await outcome(r, goalsPacket(all(1000 + 13 * period)))).toBe("passed");
    }
    for (let period = 99; period >= 0; period--) {
      r.clock.ms += 20;
      expect(await outcome(r, goalsPacket(third(1000 + 13 * period, 2300)))).toBe("passed");
    }
    expect(r.guard.status()).toMatchObject({ refusedCount: 0, goals: third(1000, 2300) });
    expect(r.guard.status().passed["SYNC WRITE 42"]).toBe(201);
  });

  it(`refuses a goal ${GOAL_STEP_LIMIT + 1} steps from the last goal and from the position, and lets one at ${GOAL_STEP_LIMIT} through`, async () => {
    for (const sign of [1, -1]) {
      const r = rig();
      await r.see(all(2000));
      expect(await outcome(r, goalsPacket(all(2000)))).toBe("passed");
      expect(await outcome(r, goalsPacket(third(2000, 2000 + sign * (GOAL_STEP_LIMIT + 1))))).toBe("jump");
      // after the refusal the last goal is unchanged
      expect(r.guard.status().goals).toEqual(all(2000));
      expect(r.refused.map(({ reason, instruction, id, address }) => [reason, instruction, id, address])).toEqual([["jump", 0x83, BROADCAST, 42]]);
      expect(await outcome(r, goalsPacket(third(2000, 2000 + sign * GOAL_STEP_LIMIT)))).toBe("passed");
      expect(r.guard.status().goals).toEqual(third(2000, 2000 + sign * GOAL_STEP_LIMIT));
      // from there, what the refused goal would have reached is still out of reach
      expect(await outcome(r, goalsPacket(third(2000, 2000 + sign * (2 * GOAL_STEP_LIMIT + 1))))).toBe("jump");
      expect(await outcome(r, goalsPacket(third(2000, 2000 + sign * 2 * GOAL_STEP_LIMIT)))).toBe("passed");
    }
  });

  it("lets a far goal through when it is the present position, and not before that position is seen", async () => {
    const r = rig();
    await r.see(all(2000));
    expect(await outcome(r, goalsPacket(all(2000)))).toBe("passed");
    r.line.positions = all(3000); // the arm was moved
    r.clock.ms += 20;
    expect(await outcome(r, goalsPacket(all(3000)))).toBe("jump");
    await r.see();
    expect(await outcome(r, goalsPacket(all(3000 + GOAL_STEP_LIMIT + 1)))).toBe("jump");
    expect(await outcome(r, goalsPacket(all(3000)))).toBe("passed");
    expect(r.guard.status().goals).toEqual(all(3000));
  });

  it("passes nothing before a position is seen, and carries nothing over on entering the state station", async () => {
    const r = rig(null);
    await r.see(all(2048)); // seen in the state reads
    r.guard.enterStation(SETTINGS);
    expect(await outcome(r, goalsPacket(all(2048)))).toBe("jump");
    await r.see();
    expect(await outcome(r, goalsPacket(all(2048)))).toBe("passed");

    r.guard.enterStation(SETTINGS);
    expect(r.guard.status()).toMatchObject({ goals: all(0).map(() => null), present: all(0).map(() => null) });
    expect(await outcome(r, goalsPacket(all(2048)))).toBe("jump");
    r.guard.backToReads();
    r.guard.enterStation(SETTINGS);
    expect(await outcome(r, goalsPacket(all(2048)))).toBe("jump");
  });

  it(`does not count a present position ${PRESENT_MAX_AGE_MS + 1} ms old`, async () => {
    const r = rig();
    await r.see(all(2048));
    r.clock.ms = PRESENT_MAX_AGE_MS + 1;
    expect(await outcome(r, goalsPacket(all(2048)))).toBe("jump");
    expect(r.guard.status().present[0]).toEqual({ position: 2048, ageMs: PRESENT_MAX_AGE_MS + 1 });
    r.clock.ms = PRESENT_MAX_AGE_MS;
    expect(await outcome(r, goalsPacket(all(2048)))).toBe("passed");
    // a position is taken only from the answers to the read of the positions that was written last
    r.clock.ms = 1000;
    r.line.positions = all(3000);
    await r.guard.write(protocol.syncReadPacket(56, 2, [1, 2, 3]));
    while ((await r.guard.read(64, 0)).length > 0);
    expect(r.guard.status().present.map((seen) => seen?.position)).toEqual([3000, 3000, 3000, 2048, 2048, 2048]);
    expect(await outcome(r, goalsPacket(all(3000)))).toBe("jump");
  });

  it("parses answers that arrive in pieces of 1, 3 and 11 bytes", async () => {
    for (const pieces of [[1], [3], [11], [1, 3, 11]]) {
      const r = rig();
      r.line.pieces = pieces;
      const positions = [100, 255, -5, 2048, 4095, -0x1ff];
      await r.see(positions);
      expect(r.guard.status().present.map((seen) => seen?.position)).toEqual(positions);
      expect(await outcome(r, goalsPacket(positions))).toBe("passed");
    }
  });

  it("does not use an answer with a wrong checksum or with the servo's error byte set", async () => {
    const r = rig();
    r.line.spoil = (answers) => {
      answers[2 * 8 + 7] = (answers[2 * 8 + 7] as number) ^ 0x01; // the third servo's checksum
      answers[4 * 8 + 4] = 0x20; // the fifth servo tells an overload, its checksum made right
      answers[4 * 8 + 7] = (answers[4 * 8 + 7] as number) - 0x20;
    };
    await r.see(all(2048));
    expect(r.guard.status().present.map((seen) => seen?.position)).toEqual([2048, 2048, undefined, 2048, undefined, 2048]);
    expect(await outcome(r, goalsPacket(all(2048)))).toBe("jump");
    r.line.spoil = null;
    await r.see();
    expect(await outcome(r, goalsPacket(all(2048)))).toBe("passed");
  });

  it("takes a position as a sign and a magnitude: a servo that rests just below zero is held where it is", async () => {
    // on the wire bit 15 is the sign: -5 is 0x8005
    expect(Array.from(goalsPacket(all(-5)))).toEqual(Array.from(wordsPacket(all(0x8005))));
    const r = rig();
    await r.see(all(-5));
    expect(r.guard.status().present.map((seen) => seen?.position)).toEqual(all(-5));
    // PEAR's enable writes the position it read back as the goal
    expect(await outcome(r, wordsPacket(all(0x8005)))).toBe("passed");
    expect(r.guard.status().goals).toEqual(all(-5));

    // across zero the distance is counted in steps: from -5 to +5 it is 10
    const across = rig();
    await across.see(all(-5));
    expect(await outcome(across, wordsPacket(all(5)))).toBe("passed");
    expect(across.guard.status().goals).toEqual(all(5));
    // and from the last goal as well, once the position is too old to count
    across.clock.ms = 1000;
    expect(await outcome(across, goalsPacket(all(5 - GOAL_STEP_LIMIT)))).toBe("passed");
    expect(await outcome(across, goalsPacket(all(5 - 2 * GOAL_STEP_LIMIT - 1)))).toBe("jump");
    expect(await outcome(across, goalsPacket(all(5 - 2 * GOAL_STEP_LIMIT)))).toBe("passed");

    // the limit holds across zero
    const edge = rig();
    await edge.see(all(-20));
    expect(await outcome(edge, goalsPacket(third(-20, -20 + GOAL_STEP_LIMIT + 1)))).toBe("jump");
    expect(await outcome(edge, goalsPacket(third(-20, -20 + GOAL_STEP_LIMIT)))).toBe("passed");
  });

  it("refuses a goal whose sign bit is set by mistake as a jump", async () => {
    const r = rig();
    await r.see(all(2000));
    expect(await outcome(r, wordsPacket(third(2000, 32768 + 2000)))).toBe("jump");
    expect(r.refused[0]?.message).toContain("the goal -2000 of the servo 3 jumps");
    expect(await outcome(r, goalsPacket(all(2000)))).toBe("passed");
    expect(await outcome(r, wordsPacket(third(2000, 32768 + 2000)))).toBe("jump");
    expect(r.guard.status().goals).toEqual(all(2000));

    // and the other way: a servo that stands at -2000 is not sent to +2000
    const below = rig();
    await below.see(third(2000, -2000));
    expect(await outcome(below, goalsPacket(all(2000)))).toBe("jump");
    expect(await outcome(below, goalsPacket(third(2000, -2000)))).toBe("passed");
  });

  it("assumes no last goal after a write the line failed", async () => {
    const r = rig();
    await r.see(all(2048));
    expect(await outcome(r, goalsPacket(all(2048)))).toBe("passed");
    r.clock.ms = 1000;
    r.line.failure = new Error("the port was lost");
    await expect(r.guard.write(goalsPacket(all(2050)))).rejects.toThrow("the port was lost");
    r.line.failure = null;
    expect(r.guard.status().goals).toEqual(all(0).map(() => null));
    expect(await outcome(r, goalsPacket(all(2050)))).toBe("jump");
  });
});

describe("what the station guard tells", () => {
  it(`counts what passed and keeps the last ${REFUSALS_KEPT} refusals`, async () => {
    const r = rig();
    await r.see();
    await outcome(r, goalsPacket(all(2048)));
    await outcome(r, protocol.writePacket(2, 40, [1]));
    for (let count = 0; count < REFUSALS_KEPT + 5; count++) await outcome(r, protocol.writePacket(1, 40, [100 + count]));
    await outcome(r, protocol.writePacket(BROADCAST, 31, [0, 0]));
    const status = r.guard.status();
    expect(status.state).toBe("station");
    expect(status.passed).toEqual({ "SYNC READ": 1, "SYNC WRITE 42": 1, "WRITE 40": 1 });
    expect(status.refusedCount).toBe(REFUSALS_KEPT + 6);
    expect(status.refusedBy).toEqual({ value: REFUSALS_KEPT + 5, id: 1 });
    expect(status.refusals).toHaveLength(REFUSALS_KEPT);
    expect(status.refusals[REFUSALS_KEPT - 1]).toMatchObject({ reason: "id", instruction: 3, id: BROADCAST, address: 31 });
    expect(status.refusals[0]).toMatchObject({ reason: "value", instruction: 3, id: 1, address: 40 });
    expect(status.refusals[0]?.message).toContain("the value 106 at address 40");
    expect(r.refused).toHaveLength(REFUSALS_KEPT + 6);
    expect(structuredClone(status)).toEqual(status);
  });

  it("passes its own self-test in both states", async () => {
    const result = await stationGuardSelfTest();
    expect(result.failures).toEqual([]);
    expect(result.reads).toEqual({ passed: 3, mustPass: 3, refused: 31, mustRefuse: 31 });
    expect(result.station).toEqual({ passed: 11, mustPass: 11, refused: 23, mustRefuse: 23 });
  });
});

/** A clock on which time passes only while everything waits for it: the sleeper whose time comes first is woken,
 * at its time. The station's control loop, its waits and the simulated servos all keep this one clock, so a
 * session takes as long as its periods need to be computed and no longer, on any machine. */
class EventClock implements MonotonicClock {
  private nowS = 100;
  private readonly sleepers: Array<{ at: number; wake: () => void }> = [];
  private isPumping = false;

  monotonic(): number {
    return this.nowS;
  }

  sleep(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      this.sleepers.push({ at: this.nowS + Math.max(seconds, 0), wake: resolve });
      this.pumpLater();
    });
  }

  private pumpLater(): void {
    if (this.isPumping || this.sleepers.length === 0) return;
    this.isPumping = true;
    setImmediate(() => {
      this.isPumping = false;
      let first = 0;
      for (let index = 1; index < this.sleepers.length; index++) {
        if ((this.sleepers[index] as { at: number }).at < (this.sleepers[first] as { at: number }).at) first = index;
      }
      const [sleeper] = this.sleepers.splice(first, 1);
      if (sleeper === undefined) return;
      this.nowS = Math.max(this.nowS, sleeper.at);
      sleeper.wake();
      this.pumpLater();
    });
  }
}

describe("PEAR's station through the guard, on the library's simulated arm", () => {
  /** Returns what the servo `id` holds at `address`, read over the line as the bus reads it. */
  async function held(line: Transport, id: number, address: number, bytes: number): Promise<number> {
    await line.write(protocol.readPacket(id, address, bytes));
    const answer = await line.read(64, 100);
    expect(Array.from(answer.subarray(0, 5))).toEqual([0xff, 0xff, id, bytes + 2, 0]);

    return bytes === 1 ? (answer[5] as number) : protocol.makeWord(answer[5] as number, answer[6] as number);
  }

  it("enables, goes Home, stops a move, goes Home to its end and disables: nothing is refused", { timeout: 120_000 }, async () => {
    const clock = new EventClock();
    const lineClock: Clock = { now: () => clock.monotonic() * 1000, sleep: (ms) => clock.sleep(ms / 1000) };
    // an STS3215 without load turns at about 45 turns a minute: 3072 steps a second
    // the arm stands far from PEAR's Home pose, the gripper closed: Home opens the gripper, then moves every joint
    const start = { shoulder_pan: 2600, shoulder_lift: 2100, elbow_flex: 1500, wrist_flex: 2400, wrist_roll: 1600, gripper: 2200 };
    expect(Object.keys(start)).toEqual(Object.keys(SIM_START_POSITIONS));
    const chain = simulatedArm(SIM_CALIBRATION, start, { speed: 3072, clock: lineClock });
    const guard = new StationGuardTransport(chain, { now: lineClock.now });

    // The settings are read from the servos first, through the guard in its state "reads", as the page will read
    // them from a real arm. A simulated servo that does not hold PEAR's value is written it before the run
    const differing: string[] = [];
    const settings: Record<number, StationSetting[]> = {};
    for (const id of ARM_IDS) {
      settings[id] = [];
      for (const { address, bytes, value } of SETTINGS[id] as StationSetting[]) {
        const before = await held(guard, id, address, bytes);
        if (before !== value) {
          differing.push(`servo ${id} address ${address}: ${before}, PEAR writes ${value}`);
          await chain.write(protocol.writePacket(id, address, protocol.splitIntoByteChunks(value, bytes)));
          await chain.read(64, 0);
        }
        (settings[id] as StationSetting[]).push({ address, bytes, value: await held(guard, id, address, bytes) });
      }
    }
    console.log(`completeness: settings the simulated servos did not hold: ${differing.length === 0 ? "none" : differing.join("; ")}`);
    expect(settings).toEqual(SETTINGS);
    expect(guard.status().refusedCount).toBe(0);
    guard.enterStation(settings);

    const robot = new SO101Robot(STATION_CONFIG, {
      clock,
      cameras: null,
      line: { transport: guard, calibration: SIM_CALIBRATION, clock },
      log: () => undefined,
      uuid4,
      configOptions: { calibrationExists: () => true },
    });
    let plans = 0;
    const approvePlan = async (): Promise<boolean> => {
      plans += 1;

      return true;
    };
    await robot.open();
    const afterEnable = guard.status();

    // Home with the plan approved, stopped while the arm moves
    const first = robot.home({ approvePlan }).then(
      (report) => `ended: ${JSON.stringify(report.results)}`,
      (error: unknown) => `failed: ${String(error)}`,
    );
    while (plans === 0) await clock.sleep(0.02);
    const goalsAtApproval = guard.status().passed["SYNC WRITE 42"] ?? 0;
    await clock.sleep(3.5);
    const goalsAtStop = guard.status().passed["SYNC WRITE 42"] ?? 0;
    await robot.stop();
    const stopped = await first;

    // Home again, to its end, once the braking ramp (about 0.15 s) has brought the arm to rest; then disable
    await clock.sleep(1);
    await robot.waitStationary(null);
    const report = await robot.home({ approvePlan });
    const afterHome = guard.status();
    expect(stopped).not.toContain('"reached":true'); // the first Home did not come to its end
    expect(report.results).toMatchObject({ reached: true, gripper_open: true });
    expect((afterHome.passed["SYNC WRITE 42"] ?? 0) - goalsAtStop).toBeGreaterThan(50); // the second Home moved the arm
    await robot.close();
    const status = guard.status();
    console.log(
      `completeness: after enable ${JSON.stringify(afterEnable.passed)}; goals at approval ${goalsAtApproval}, at stop ${goalsAtStop}; ` +
        `the stopped Home ${stopped}; the second Home ${JSON.stringify(report.results)}, stages ${report.phases.length}; ` +
        `after Home ${afterHome.passed["SYNC WRITE 42"]} goals; in all ${JSON.stringify(status.passed)}; ` +
        `refused ${status.refusedCount} ${JSON.stringify(status.refusals.slice(0, 3))}; ${Math.round(clock.monotonic() - 100)} s of the station's time`,
    );

    expect(status.refusals).toEqual([]);
    expect(status.refusedCount).toBe(0);
    expect(plans).toBe(2);
    expect(goalsAtStop - goalsAtApproval).toBeGreaterThan(50); // the arm was moving when it was stopped
    expect(Object.keys(status.passed).sort()).toEqual(
      ["PING", "READ", "SYNC READ", "SYNC WRITE 42", "WRITE 40", "WRITE 55", "WRITE 41", "WRITE 7", "WRITE 85", "WRITE 33", "WRITE 21", "WRITE 22", "WRITE 23", "WRITE 16", "WRITE 28", "WRITE 36"].sort(),
    );
  });

  it("lets through the goal PEAR's enable writes for a servo that rests just below zero: its negative position", { timeout: 120_000 }, async () => {
    const clock = new EventClock();
    const lineClock: Clock = { now: () => clock.monotonic() * 1000, sleep: (ms) => clock.sleep(ms / 1000) };
    // the wrist's roll, whose calibrated range begins at zero, stands five steps below it
    const chain = simulatedArm(SIM_CALIBRATION, { ...SIM_START_POSITIONS, wrist_roll: -5 }, { speed: 3072, clock: lineClock });
    for (const id of ARM_IDS) {
      for (const { address, bytes, value } of SETTINGS[id] as StationSetting[]) {
        await chain.write(protocol.writePacket(id, address, protocol.splitIntoByteChunks(value, bytes)));
        await chain.read(64, 0);
      }
    }
    // what reaches the port: the servos and goals of each SYNC WRITE, as its bytes
    const written: number[][] = [];
    const port: Transport = {
      write: async (bytes) => {
        if (bytes[4] === protocol.INST_SYNC_WRITE) written.push(Array.from(bytes.subarray(7, bytes.length - 1)));
        await chain.write(bytes);
      },
      read: (maxLength, timeoutMs) => chain.read(maxLength, timeoutMs),
      close: () => chain.close(),
    };
    const guard = new StationGuardTransport(port, { now: lineClock.now });
    guard.enterStation(SETTINGS);
    const robot = new SO101Robot(STATION_CONFIG, {
      clock,
      cameras: null,
      line: { transport: guard, calibration: SIM_CALIBRATION, clock },
      log: () => undefined,
      uuid4,
      configOptions: { calibrationExists: () => true },
    });
    // Under this calibration the zero of the wrist's roll is at -180 degrees, outside the bounds PEAR commissions
    // for the joint, so PEAR's enable ends by refusing the pose itself. Before that it has written the position
    // it read back as the goal, which is what the guard must let through
    const outcomeOfOpen = await robot.open().then(
      () => "opened",
      (error: unknown) => String(error),
    );
    if (outcomeOfOpen === "opened") await robot.close();

    const status = guard.status();
    console.log(
      `below zero: open ${outcomeOfOpen}; the fifth servo's goals written ${JSON.stringify(written.map((goals) => goals.slice(12, 15)))}; ` +
        `passed ${JSON.stringify(status.passed)}; refused ${status.refusedCount}`,
    );
    expect(outcomeOfOpen).toContain("outside commissioned bounds: wrist_roll=");
    expect(status.refusals).toEqual([]);
    expect(status.refusedCount).toBe(0);
    expect(written.length).toBeGreaterThanOrEqual(1);
    // the first goal of the fifth servo is the position it was read at: -5, which is 05 80 on the wire
    expect(written[0]?.slice(12, 15)).toEqual([5, 0x05, 0x80]);
  });
});

describe("what the guards keep to themselves and tell of the line", () => {
  /** A line whose write or read fails on demand. */
  function failingLine(): { line: Transport; fail: { write: Error | null; read: Error | null }; sent: number } {
    const state = {
      fail: { write: null as Error | null, read: null as Error | null },
      sent: 0,
      line: {
        write: async () => {
          if (state.fail.write !== null) throw state.fail.write;
          state.sent += 1;
        },
        read: async () => {
          if (state.fail.read !== null) throw state.fail.read;

          return new Uint8Array(0);
        },
        close: async () => undefined,
      } as Transport,
    };

    return state;
  }

  it("gives no way to the transport they guard: it is no property of either guard at run time", () => {
    const { line } = failingLine();
    for (const guard of [new StationGuardTransport(line), new ReadOnlyTransport(line)]) {
      const open = guard as unknown as Record<string, unknown>;
      expect(open["inner"]).toBeUndefined();
      expect(Object.getOwnPropertyNames(guard)).not.toContain("inner");
      // nothing a program can list of the guard, on it or on its class, is the line or holds it
      const reachable = [...Object.getOwnPropertyNames(guard), ...Object.getOwnPropertySymbols(guard)].map(
        (key) => (guard as unknown as Record<string | symbol, unknown>)[key],
      );
      expect(reachable).not.toContain(line);
      expect(JSON.stringify(guard)).not.toContain("inner");
    }
  });

  it("tells the error with which the line itself failed, the first one; a refusal is none", async () => {
    const state = failingLine();
    const guard = new StationGuardTransport(state.line);
    expect(guard.failure).toBeNull();
    await expect(guard.write(protocol.writePacket(1, 40, [1]))).rejects.toBeInstanceOf(StationGuardViolation);
    expect(guard.failure).toBeNull(); // refused, and nothing was sent: the line did not fail
    await guard.write(protocol.pingPacket(1));
    await guard.read(8, 0);
    expect(guard.failure).toBeNull();

    const lost = new Error("The device has been lost.");
    state.fail.read = lost;
    await expect(guard.read(8, 0)).rejects.toBe(lost);
    expect(guard.failure).toBe(lost);
    state.fail.write = new Error("The port is closed.");
    await expect(guard.write(protocol.pingPacket(1))).rejects.toThrow("The port is closed.");
    expect(guard.failure).toBe(lost); // the first failure is kept

    const other = failingLine();
    const writing = new StationGuardTransport(other.line);
    other.fail.write = lost;
    await expect(writing.write(protocol.pingPacket(1))).rejects.toBe(lost);
    expect(writing.failure).toBe(lost);
  });

  it("counts what passed and how many packets it refused, as a report of the line's reading tells them", async () => {
    const state = failingLine();
    const guard = new StationGuardTransport(state.line);
    expect(guard.counts).toEqual({ passed: {}, refused: 0 });
    await guard.write(protocol.pingPacket(1));
    await guard.write(protocol.readPacket(1, 56, 2));
    await guard.write(protocol.readPacket(2, 56, 2));
    await guard.write(READ_POSITIONS);
    await expect(guard.write(protocol.writePacket(1, 40, [1]))).rejects.toBeInstanceOf(StationGuardViolation);
    await expect(guard.write(Uint8Array.from([1, 2, 3]))).rejects.toBeInstanceOf(StationGuardViolation);
    expect(guard.counts).toEqual({ passed: { PING: 1, READ: 2, "SYNC READ": 1 }, refused: 2 });
    expect(state.sent).toBe(4);
    // the counts are a copy: changing them changes nothing of the guard's
    guard.counts.passed["PING"] = 99;
    expect(guard.counts.passed["PING"]).toBe(1);
    expect(guard.status().passed).toEqual(guard.counts.passed);
  });
});
