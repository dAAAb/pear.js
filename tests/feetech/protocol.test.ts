import { describe, expect, test } from "vitest";

import { FeetechMotorsBus, PortHandler } from "../../src/feetech/bus";
import * as protocol from "../../src/feetech/protocol";
import * as tables from "../../src/feetech/tables";
import { ManualClock, type Transport } from "../../src/feetech/transport";
import { IndexError } from "../../src/python/errors";
import { expectError, fixture, type FixtureError } from "./helpers";

interface Tables {
  model: string;
  control_table: Record<string, [number, number]>;
  encoding_table: Record<string, number>;
  baudrate_table: Record<string, number>;
  resolution: number;
  model_number: number;
  protocol: number;
  firmware_major_version: [number, number];
  firmware_minor_version: [number, number];
  model_number_register: [number, number];
  scan_baudrates: number[];
  default_baudrate: number;
  default_timeout_ms: number;
  normalized_data: string[];
  operating_mode: Record<string, number>;
  torque_mode: Record<string, number>;
  drive_mode: Record<string, number>;
  sdk: Record<string, number>;
  tx_rx_result: [number, string][];
  rx_packet_error: string[];
  packet_timeout_ms: [number, number][];
}

interface InstructionArguments {
  id?: number;
  address?: number;
  length?: number;
  data?: number[];
  ids?: number[];
  values?: [number, number[]][];
}

interface Packets {
  instructions: { kind: string; args: InstructionArguments; result: number; packet: number[] | null }[];
  serialized: { value: number; length: number; bytes?: number[]; error?: FixtureError }[];
  sign_encoded: { value: number; sign_bit: number; encoded?: number; error?: FixtureError }[];
  sign_decoded: { encoded: number; sign_bit: number; value: number }[];
}

interface Streams {
  streams: { name: string; stream: number[]; results: { packet: number[]; result: number }[] }[];
}

const reference = fixture<Tables>("tables.json");
const packets = fixture<Packets>("packets.json");
const { streams } = fixture<Streams>("status.json");

/** A port that keeps what is written and gives ``stream`` back, at most ``chunk`` bytes at a time; its packet's
 * time is up when a read finds nothing, as in the fixture script. */
class StreamPort implements protocol.PacketPort {
  isUsing = false;
  readonly written: number[][] = [];
  private isEmpty = false;

  constructor(
    private readonly stream: number[] = [],
    private readonly chunk: () => number = () => Infinity,
  ) {}

  async clearPort(): Promise<void> {}

  async writePort(packet: Uint8Array): Promise<number> {
    this.written.push(Array.from(packet));
    return packet.length;
  }

  async readPort(length: number): Promise<number[]> {
    const bytes = this.stream.splice(0, Math.max(Math.min(length, this.chunk()), 0));
    this.isEmpty = length > 0 && bytes.length === 0;
    return bytes;
  }

  setPacketTimeout(): void {}

  isPacketTimeout(): boolean {
    return this.isEmpty;
  }
}

const noTransport: Transport = {
  write: async () => undefined,
  read: async () => new Uint8Array(0),
  close: async () => undefined,
};

describe("the tables are lerobot's", () => {
  test("the STS3215's control table", () => {
    expect(tables.MODEL).toBe(reference.model);
    expect(tables.CONTROL_TABLE).toEqual(reference.control_table);
    expect(Object.keys(tables.CONTROL_TABLE)).toEqual(Object.keys(reference.control_table));
    for (const [name, entry] of Object.entries(reference.control_table)) expect(tables.getAddress(name)).toEqual(entry);
    expect(() => tables.getAddress("Present_Speed")).toThrow("Address for 'Present_Speed' not found in sts3215 control table.");
    expect(() => tables.getAddress("constructor")).toThrow();
  });

  test("the sign bits, the baud rates and the model's numbers", () => {
    expect(tables.ENCODING_TABLE).toEqual(reference.encoding_table);
    expect(Object.fromEntries(Object.entries(tables.BAUDRATE_TABLE))).toEqual(reference.baudrate_table);
    expect(tables.SCAN_BAUDRATES).toEqual(reference.scan_baudrates);
    expect(tables.RESOLUTION).toBe(reference.resolution);
    expect(tables.MODEL_NUMBER_VALUE).toBe(reference.model_number);
    expect(tables.PROTOCOL_VERSION).toBe(reference.protocol);
    expect([...tables.FIRMWARE_MAJOR_VERSION]).toEqual(reference.firmware_major_version);
    expect([...tables.FIRMWARE_MINOR_VERSION]).toEqual(reference.firmware_minor_version);
    expect([...tables.MODEL_NUMBER]).toEqual(reference.model_number_register);
    expect(tables.DEFAULT_BAUDRATE).toBe(reference.default_baudrate);
    expect(tables.DEFAULT_TIMEOUT_MS).toBe(reference.default_timeout_ms);
    expect(tables.NORMALIZED_DATA).toEqual(reference.normalized_data);
    expect(tables.OperatingMode).toEqual(reference.operating_mode);
    expect(tables.TorqueMode).toEqual(reference.torque_mode);
    expect(tables.DriveMode).toEqual(reference.drive_mode);
  });

  test("the SDK's constants and texts", () => {
    const constants = protocol as unknown as Record<string, unknown>;
    expect(Object.keys(reference.sdk).length).toBe(32);
    for (const [name, value] of Object.entries(reference.sdk)) expect([name, constants[name]]).toEqual([name, value]);
    for (const [result, text] of reference.tx_rx_result) expect(protocol.getTxRxResult(result)).toBe(text);
    reference.rx_packet_error.forEach((text, error) => expect(protocol.getRxPacketError(error)).toBe(text));
  });

  test("lerobot's packet timeout", () => {
    const port = new PortHandler(noTransport, reference.default_baudrate, new ManualClock());
    for (const [packetLength, timeout] of reference.packet_timeout_ms) {
      port.setPacketTimeout(packetLength);
      expect(port.packetTimeout).toBe(timeout);
    }
  });
});

describe("instruction packets are the SDK's", () => {
  const build = (kind: string, args: InstructionArguments): Uint8Array | null => {
    const { id = -1, address = -1, length = -1, data = [], ids = [], values = [] } = args;
    switch (kind) {
      case "ping":
        return id >= protocol.BROADCAST_ID ? null : protocol.pingPacket(id);
      case "read":
        return id >= protocol.BROADCAST_ID ? null : protocol.readPacket(id, address, length);
      case "write":
        return protocol.writePacket(id, address, data);
      case "sync_read": {
        const parameters = protocol.syncReadParameters(ids);
        return parameters.length === 0 ? null : protocol.syncReadPacket(address, length, parameters);
      }
      case "sync_write": {
        const parameters = protocol.syncWriteParameters(length, values);
        return parameters.length === 0 ? null : protocol.syncWritePacket(address, length, parameters);
      }
      default:
        throw new Error(kind);
    }
  };

  test(`${packets.instructions.length} packets`, async () => {
    const kinds = new Set<string>();
    for (const { kind, args, result, packet } of packets.instructions) {
      kinds.add(kind);
      const built = build(kind, args);
      const port = new StreamPort();
      const sent = built === null ? protocol.COMM_NOT_AVAILABLE : await protocol.txPacket(port, built);

      if (packet === null) {
        // nothing was sent: no servo to address, or a packet too long for the protocol
        expect([kind, args, sent]).toEqual([kind, args, result]);
        expect(port.written).toEqual([]);
      } else {
        expect(sent).toBe(protocol.COMM_SUCCESS);
        expect([kind, args, port.written]).toEqual([kind, args, [packet]]);
      }
    }
    expect([...kinds].sort()).toEqual(["ping", "read", "sync_read", "sync_write", "write"]);
  });

  test("an id past the last servo's is refused before anything is sent", async () => {
    const port = new StreamPort();
    expect((await protocol.ping(port, 254)).result).toBe(protocol.COMM_NOT_AVAILABLE);
    expect((await protocol.readTxRx(port, 255, 56, 2)).result).toBe(protocol.COMM_NOT_AVAILABLE);
    expect(port.written).toEqual([]);
  });

  test("a second packet while one is in flight is refused", async () => {
    const port = new StreamPort();
    expect(await protocol.txPacket(port, protocol.readPacket(1, 56, 2))).toBe(protocol.COMM_SUCCESS);
    expect(await protocol.txPacket(port, protocol.readPacket(2, 56, 2))).toBe(protocol.COMM_PORT_BUSY);
    expect(port.written.length).toBe(1);
  });

  test("what is not a byte is refused", () => {
    expect(() => protocol.writePacket(1, 42, [256])).toThrow(RangeError);
    expect(() => protocol.readPacket(-1, 42, 2)).toThrow(RangeError);
    expect(() => protocol.writePacket(1, 42, [1.5])).toThrow(RangeError);
  });
});

describe("register values are lerobot's bytes", () => {
  const bus = new FeetechMotorsBus(noTransport, {});

  test(`${packets.serialized.length} values in 1, 2 and 4 bytes`, () => {
    for (const { value, length, bytes, error } of packets.serialized) {
      if (error === undefined) {
        expect([value, length, bus.serializeData(value, length)]).toEqual([value, length, bytes]);
      } else {
        let thrown: unknown;
        try {
          bus.serializeData(value, length);
        } catch (caught) {
          thrown = caught;
        }
        expectError(thrown, error);
      }
    }
  });

  test(`${packets.sign_encoded.length} values to sign and magnitude, ${packets.sign_decoded.length} back`, () => {
    for (const { value, sign_bit, encoded, error } of packets.sign_encoded) {
      if (error === undefined) {
        expect([value, sign_bit, tables.encodeSignMagnitude(value, sign_bit)]).toEqual([value, sign_bit, encoded]);
      } else {
        expect(() => tables.encodeSignMagnitude(value, sign_bit)).toThrow(error.message);
      }
    }
    for (const { encoded, sign_bit, value } of packets.sign_decoded) {
      expect([encoded, sign_bit, tables.decodeSignMagnitude(encoded, sign_bit)]).toEqual([encoded, sign_bit, value]);
    }
  });

  test("words and double words", () => {
    expect(protocol.makeWord(0x34, 0x12)).toBe(0x1234);
    expect(protocol.makeDword(0x5678, 0xfedc)).toBe(0xfedc5678);
    expect(protocol.splitIntoByteChunks(0xfedc5678, 4)).toEqual([0x78, 0x56, 0xdc, 0xfe]);
    expect(protocol.valueOf([0x78, 0x56, 0xdc, 0xfe], 4)).toBe(0xfedc5678);
    expect(() => protocol.valueOf([0x78], 2)).toThrow(IndexError);
  });
});

describe("status packets are found as the SDK finds them", () => {
  /** Returns what each call of rxPacket() makes of ``stream``, until one finds nothing. */
  const read = async (stream: number[], chunk: () => number): Promise<{ packet: number[]; result: number }[]> => {
    const port = new StreamPort([...stream], chunk);
    const results = [];
    for (;;) {
      port.isUsing = true;
      const { rxpacket, result } = await protocol.rxPacket(port);
      expect(port.isUsing).toBe(false);
      results.push({ packet: rxpacket, result });
      if (result === protocol.COMM_RX_TIMEOUT) return results;
      if (results.length > stream.length + 1) throw new Error("rxPacket() does not consume the stream");
    }
  };

  // a generator of chunk sizes that needs no seed: the fractional parts of the multiples of the golden ratio
  const uneven = (): (() => number) => {
    let index = 0;
    return () => 1 + Math.floor(((++index * 0.6180339887498949) % 1) * 5);
  };

  for (const [pieces, chunk] of [
    ["whole", () => () => Infinity],
    ["one byte at a time", () => () => 1],
    ["in uneven pieces", uneven],
  ] as const) {
    test(`${streams.length} streams, ${pieces}`, async () => {
      let found = 0;
      for (const { name, stream, results } of streams) {
        expect([name, await read(stream, chunk())]).toEqual([name, results]);
        found += results.filter(({ result }) => result === protocol.COMM_SUCCESS).length;
      }
      expect(found).toBeGreaterThan(200); // the streams are not all noise
    });
  }

  test("the echo of an instruction to one servo passes for its status packet", async () => {
    // the SDK does not handle an echoing adapter: a read's echo is a well-formed packet of the servo's id
    const port = new StreamPort([...protocol.readPacket(3, 56, 2), 0xff, 0xff, 3, 4, 0, 0x34, 0x08, 0xbc]);
    const { data, result, error } = await protocol.readTxRx(port, 3, 56, 2);
    expect(result).toBe(protocol.COMM_SUCCESS);
    expect(error).toBe(protocol.INST_READ);
    expect(data).toEqual([56, 2]);
  });

  test("the reader is given bytes and asked for packets", () => {
    const reader = new protocol.StatusPacketReader();
    expect(reader.wanted).toBe(6);
    reader.push([0x00, 0xff, 0xff, 0x01]);
    expect(reader.advance()).toBeNull();
    reader.push([0x04, 0x00]);
    expect(reader.advance()).toBeNull(); // the noise is dropped, the header kept
    expect(reader.wanted).toBe(1);
    reader.push([0x34]);
    expect(reader.advance()).toBeNull(); // the length says two bytes more
    expect(reader.wanted).toBe(2);
    reader.push([0x08, 0xbe]);
    expect(reader.advance()).toEqual({ rxpacket: [0xff, 0xff, 0x01, 0x04, 0x00, 0x34, 0x08, 0xbe], result: protocol.COMM_SUCCESS });
    expect(new protocol.StatusPacketReader().expire().result).toBe(protocol.COMM_RX_TIMEOUT);
  });
});
