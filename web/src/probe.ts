// Not in PEAR: one PING to every servo at once, to learn which ids are on the line when the handshake found
// none of the six, or not all. lerobot has it as FeetechMotorsBus.broadcast_ping, which its motor setup and its
// port scan use; the library does not port it, so the page builds it here from the library's packet functions
// and waits as long as lerobot waits. A PING changes nothing in a servo, and this one passes the read-only guard
// like every other packet of the page.

import { BAUDRATE_TABLE, DEFAULT_BAUDRATE, protocol, type Transport } from "../../src/feetech/index";

/** What came back after one PING to every servo at once. */
export interface PingToAll {
  baudRate: number;
  /** The ids of the status packets that came back whole, in the order they came, each once. */
  ids: number[];
  /** How many bytes came back in all, whole status packets or not. */
  received: number;
  /** The first bytes that came back, for the log. */
  head: number[];
  /** How long the page listened, ms. */
  waitedMs: number;
}

/** How many of the bytes that came back are kept for the log. */
const HEAD_BYTES = 64;
/** How many of them are kept to look for status packets in: far more than 253 servos could send. */
const KEPT_BYTES = 8192;

/** The baud rates an STS3215 can be set to (lerobot's table) without the one PEAR uses, highest first. */
export const OTHER_BAUD_RATES: readonly number[] = Object.keys(BAUDRATE_TABLE)
  .map(Number)
  .filter((baudRate) => baudRate !== DEFAULT_BAUDRATE)
  .sort((a, b) => b - a);

/** Returns how long lerobot's broadcast ping waits for the answers, ms: the time on the line of a status packet
 * from every id there can be, 3 ms for each id and 16 ms. */
export function pingToAllWaitMs(baudRate: number): number {
  const msPerByte = (1000 / baudRate) * 10;

  return 6 * protocol.MAX_ID * msPerByte + 3 * protocol.MAX_ID + 16;
}

/** Returns the ids of the whole status packets in ``bytes`` (FF FF ID LENGTH ERROR ... CHECKSUM with a checksum
 * that holds), in their order and each once; the library's own reader finds them. */
export function statusPacketIds(bytes: readonly number[]): number[] {
  const ids: number[] = [];
  let rest = bytes.slice();
  for (;;) {
    const reader = new protocol.StatusPacketReader();
    reader.push(rest);
    const found = reader.advance();
    if (found === null) break;

    // the reader hands back its buffer: the packet first, then what came after it
    const packet = found.rxpacket;
    const length = (packet[protocol.PKT_LENGTH] as number) + 4;
    if (found.result === protocol.COMM_SUCCESS && length >= 6) {
      const id = packet[protocol.PKT_ID] as number;
      if (!ids.includes(id)) ids.push(id);
      rest = packet.slice(length);
    } else {
      rest = packet.slice(1); // a damaged packet: the search goes on one byte further
    }
  }

  return ids;
}

/**
 * Sends one PING to every servo at once through ``line``, listens for as long as lerobot's broadcast ping does
 * and returns what came back. ``baudRate`` is the rate the line was opened at. Bytes that waited unread from an
 * exchange before are dropped first. ``isStopped`` ends the listening early.
 */
export async function pingToAll(
  line: Transport,
  baudRate: number,
  isStopped: () => boolean = () => false,
): Promise<PingToAll> {
  await line.read(Number.MAX_SAFE_INTEGER, 0);
  await line.write(protocol.pingPacket(protocol.BROADCAST_ID));

  const startedAt = performance.now();
  const waitMs = pingToAllWaitMs(baudRate);
  const heard: number[] = [];
  let received = 0;
  for (;;) {
    const left = waitMs - (performance.now() - startedAt);
    if (left <= 0 || isStopped()) break;
    const bytes = await line.read(1024, left);
    received += bytes.length;
    for (let index = 0; index < bytes.length && heard.length < KEPT_BYTES; index++) heard.push(bytes[index] as number);
  }

  return {
    baudRate,
    ids: statusPacketIds(heard),
    received,
    head: heard.slice(0, HEAD_BYTES),
    waitedMs: performance.now() - startedAt,
  };
}
