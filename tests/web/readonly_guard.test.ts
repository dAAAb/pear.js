// The page's promise is that it only reads. This test holds the guard every byte of the page passes through
// (web/src/readonly.ts) to that promise without a browser: every instruction code, packets joined in one write,
// bytes that are no packet, and packets a servo could frame differently than the guard does.

import { describe, expect, it } from "vitest";

import { protocol, type Transport } from "../../src/feetech/index";
import { READING_INSTRUCTIONS, ReadOnlyTransport, ReadOnlyViolation } from "../../web/src/readonly";

/** A line that leads nowhere and keeps what reached it. */
function sinkAndGuard(): { sent: Uint8Array[]; guard: ReadOnlyTransport; refusals: ReadOnlyViolation[] } {
  const sent: Uint8Array[] = [];
  const refusals: ReadOnlyViolation[] = [];
  const sink: Transport = {
    write: async (bytes) => {
      sent.push(bytes.slice());
    },
    read: async () => new Uint8Array(0),
    close: async () => undefined,
  };

  return { sent, refusals, guard: new ReadOnlyTransport(sink, { onRefused: (violation) => refusals.push(violation) }) };
}

/** Returns FF FF id length instruction parameters checksum, built here and not by the library. */
function packet(id: number, instruction: number, parameters: number[] = []): Uint8Array {
  const body = [id, parameters.length + 2, instruction, ...parameters];
  const checksum = ~body.reduce((sum, byte) => sum + byte, 0) & 0xff;

  return Uint8Array.from([0xff, 0xff, ...body, checksum]);
}

function joined(...parts: Uint8Array[]): Uint8Array {
  const whole = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    whole.set(part, offset);
    offset += part.length;
  }

  return whole;
}

async function refused(bytes: Uint8Array): Promise<ReadOnlyViolation> {
  const { sent, guard, refusals } = sinkAndGuard();
  let thrown: unknown = null;
  try {
    await guard.write(bytes);
  } catch (error) {
    thrown = error;
  }

  expect(thrown, "the guard let the bytes through").toBeInstanceOf(ReadOnlyViolation);
  expect(sent, "bytes reached the line although they were refused").toHaveLength(0);
  expect(refusals).toHaveLength(1);

  return thrown as ReadOnlyViolation;
}

async function passed(bytes: Uint8Array): Promise<void> {
  const { sent, guard, refusals } = sinkAndGuard();
  await guard.write(bytes);

  expect(refusals).toHaveLength(0);
  expect(sent).toHaveLength(1);
  expect(Array.from(sent[0] as Uint8Array)).toEqual(Array.from(bytes));
}

describe("the page's read-only guard", () => {
  it("knows exactly three instructions that only read", () => {
    expect([...READING_INSTRUCTIONS.keys()].sort((a, b) => a - b)).toEqual([0x01, 0x02, 0x82]);
    expect(protocol.INST_PING).toBe(0x01);
    expect(protocol.INST_READ).toBe(0x02);
    expect(protocol.INST_SYNC_READ).toBe(0x82);
  });

  it("lets PING, READ and SYNC READ through and refuses each of the other 253 instruction codes", async () => {
    const through: number[] = [];
    for (let code = 0; code <= 0xff; code++) {
      const { sent, guard } = sinkAndGuard();
      const bytes = packet(1, code, code === 0xff ? [] : [56, 2]);
      try {
        await guard.write(bytes);
        expect(sent).toHaveLength(1);
        through.push(code);
      } catch (error) {
        expect(error, `instruction ${code}`).toBeInstanceOf(ReadOnlyViolation);
        expect(sent, `instruction ${code}: refused, but bytes were sent`).toHaveLength(0);
      }
    }

    expect(through).toEqual([0x01, 0x02, 0x82]);
  });

  it("passes the library's own reading packets unchanged", async () => {
    await passed(protocol.pingPacket(1));
    await passed(protocol.pingPacket(protocol.BROADCAST_ID));
    await passed(protocol.readPacket(6, 56, 2));
    await passed(protocol.syncReadPacket(56, 2, [1, 2, 3, 4, 5, 6]));
    await passed(joined(protocol.readPacket(1, 56, 2), protocol.readPacket(2, 56, 2)));
  });

  it("refuses the library's own writing packets, to one servo and to all", async () => {
    const goal = protocol.syncWriteParameters(2, [[1, [0x00, 0x08]] as const]);
    const writing: Uint8Array[] = [
      protocol.writePacket(1, 40, [1]), // Torque_Enable
      protocol.writePacket(1, 42, [0x00, 0x08]), // Goal_Position
      protocol.writePacket(protocol.BROADCAST_ID, 40, [1]),
      protocol.syncWritePacket(42, 2, goal),
      protocol.instructionPacket(1, protocol.INST_REG_WRITE, [42, 0x00, 0x08]),
      protocol.instructionPacket(protocol.BROADCAST_ID, protocol.INST_ACTION, []),
      protocol.instructionPacket(1, 0x06, []),
    ];
    for (const bytes of writing) {
      const violation = await refused(bytes);
      expect(violation.instruction).not.toBeNull();
    }
  });

  it("refuses a write hidden behind or between reads in one call", async () => {
    const ping = protocol.pingPacket(1);
    const read = protocol.readPacket(1, 56, 2);
    const write = protocol.writePacket(1, 40, [1]);

    expect((await refused(joined(ping, write))).instruction).toBe(protocol.INST_WRITE);
    expect((await refused(joined(write, ping))).instruction).toBe(protocol.INST_WRITE);
    expect((await refused(joined(read, write, read))).instruction).toBe(protocol.INST_WRITE);
  });

  it("refuses bytes that are not whole packets with their checksums", async () => {
    const ping = protocol.pingPacket(1);
    const wrongSum = ping.slice();
    wrongSum[wrongSum.length - 1] = (wrongSum[wrongSum.length - 1] as number) ^ 0x01;
    const noHeader = ping.slice();
    noHeader[1] = 0xfe;
    const longer = ping.slice();
    longer[protocol.PKT_LENGTH] = 9; // says more bytes than there are
    const shorter = packet(1, 0x02, [56, 2]);
    shorter[protocol.PKT_LENGTH] = 2; // says fewer bytes than there are: its checksum is then another byte

    for (const bytes of [
      new Uint8Array(0),
      ping.subarray(0, 3),
      ping.subarray(0, ping.length - 1),
      wrongSum,
      noHeader,
      longer,
      shorter,
      joined(ping, Uint8Array.from([0x00])),
      joined(Uint8Array.from([0x00]), ping),
      joined(ping, ping.subarray(0, 4)),
      Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
    ]) {
      expect((await refused(bytes)).instruction).toBeNull();
    }
  });

  it("refuses a packet a servo could frame one byte later", async () => {
    // To the guard: a READ for id 0xFF with the parameters 06 F3. To a servo that takes the second and third FF
    // for the header: id 4, length 2, instruction 0x06, checksum F3, which is a whole packet.
    const outer = packet(0xff, 0x02, [0x06, 0xf3]);
    expect(Array.from(outer.subarray(1, 7))).toEqual([0xff, 0xff, 0x04, 0x02, 0x06, 0xf3]);
    const inner = outer.subarray(1, 7);
    expect(~((inner[2] as number) + (inner[3] as number) + (inner[4] as number)) & 0xff).toBe(inner[5]);
    await refused(outer);

    await refused(packet(0xff, 0x01));
    await refused(packet(1, 0x02, [0xff, 2]));
    await refused(packet(protocol.BROADCAST_ID, 0x82, [56, 2, 1, 0xff, 3]));
    // a whole WRITE inside the parameters of a SYNC READ
    await refused(packet(protocol.BROADCAST_ID, 0x82, [56, 2, ...protocol.writePacket(1, 40, [1])]));
  });

  it("counts what it let through and what it refused", async () => {
    const { guard } = sinkAndGuard();
    await guard.write(protocol.pingPacket(1));
    await guard.write(protocol.syncReadPacket(56, 2, [1, 2]));
    await guard.write(protocol.syncReadPacket(56, 2, [1, 2]));
    await expect(guard.write(protocol.writePacket(1, 40, [1]))).rejects.toBeInstanceOf(ReadOnlyViolation);
    await expect(guard.write(Uint8Array.from([1, 2, 3]))).rejects.toBeInstanceOf(ReadOnlyViolation);

    expect(guard.counts.passed).toEqual({ PING: 1, "SYNC READ": 2 });
    expect(guard.counts.refused).toEqual({ WRITE: 1, "not a packet": 1 });
  });
});
