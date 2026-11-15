// Ports the packet layer of the Feetech SDK that lerobot 0.6.1 drives its servos with (feetech-servo-sdk 1.0.0,
// package scservo_sdk): scservo_def.py and protocol_packet_handler.py, with the parameter lists of
// group_sync_read.py and group_sync_write.py. Protocol 0, the STS and SMS series': a word's low byte comes first.

export const BROADCAST_ID = 0xfe;
export const MAX_ID = 0xfc;

export const INST_PING = 1;
export const INST_READ = 2;
export const INST_WRITE = 3;
export const INST_REG_WRITE = 4;
export const INST_ACTION = 5;
export const INST_SYNC_READ = 0x82;
export const INST_SYNC_WRITE = 0x83;

// the results of a packet exchange
export const COMM_SUCCESS = 0;
export const COMM_PORT_BUSY = -1;
export const COMM_TX_FAIL = -2;
export const COMM_RX_FAIL = -3;
export const COMM_TX_ERROR = -4;
export const COMM_RX_WAITING = -5;
export const COMM_RX_TIMEOUT = -6;
export const COMM_RX_CORRUPT = -7;
export const COMM_NOT_AVAILABLE = -9;

export const TXPACKET_MAX_LEN = 250;
export const RXPACKET_MAX_LEN = 250;

// where a packet's fields are
export const PKT_HEADER0 = 0;
export const PKT_HEADER1 = 1;
export const PKT_ID = 2;
export const PKT_LENGTH = 3;
export const PKT_INSTRUCTION = 4;
export const PKT_ERROR = 4;
export const PKT_PARAMETER0 = 5;

// the bits of a status packet's error byte
export const ERRBIT_VOLTAGE = 1;
export const ERRBIT_ANGLE = 2;
export const ERRBIT_OVERHEAT = 4;
export const ERRBIT_OVERELE = 8;
export const ERRBIT_OVERLOAD = 32;

const MIN_STATUS_LENGTH = 6; // HEADER0 HEADER1 ID LENGTH ERROR CHKSUM

/** Returns the SDK's text for the result of a packet exchange. */
export function getTxRxResult(result: number): string {
  switch (result) {
    case COMM_SUCCESS:
      return "[TxRxResult] Communication success!";
    case COMM_PORT_BUSY:
      return "[TxRxResult] Port is in use!";
    case COMM_TX_FAIL:
      return "[TxRxResult] Failed transmit instruction packet!";
    case COMM_RX_FAIL:
      return "[TxRxResult] Failed get status packet from device!";
    case COMM_TX_ERROR:
      return "[TxRxResult] Incorrect instruction packet!";
    case COMM_RX_WAITING:
      return "[TxRxResult] Now receiving status packet!";
    case COMM_RX_TIMEOUT:
      return "[TxRxResult] There is no status packet!";
    case COMM_RX_CORRUPT:
      return "[TxRxResult] Incorrect status packet!";
    case COMM_NOT_AVAILABLE:
      return "[TxRxResult] Protocol does not support this function!";
    default:
      return "";
  }
}

/** Returns the SDK's text for a status packet's error byte: its lowest known bit's. */
export function getRxPacketError(error: number): string {
  if (error & ERRBIT_VOLTAGE) return "[RxPacketError] Input voltage error!";
  if (error & ERRBIT_ANGLE) return "[RxPacketError] Angle sen error!";
  if (error & ERRBIT_OVERHEAT) return "[RxPacketError] Overheat error!";
  if (error & ERRBIT_OVERELE) return "[RxPacketError] OverEle error!";
  if (error & ERRBIT_OVERLOAD) return "[RxPacketError] Overload error!";
  return "";
}

export function makeWord(low: number, high: number): number {
  return (low & 0xff) | ((high & 0xff) << 8);
}

export function makeDword(low: number, high: number): number {
  return ((low & 0xffff) | ((high & 0xffff) << 16)) >>> 0;
}

/** Returns the bytes of the unsigned ``value`` in a register of ``length`` bytes (1, 2 or 4), lowest first. */
export function splitIntoByteChunks(value: number, length: number): number[] {
  if (length === 1) return [value];
  if (length === 2) return [value & 0xff, (value >>> 8) & 0xff];
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/** Returns the sum of a packet's bytes after its header and before its last, inverted: its checksum. */
function checksumOf(packet: ArrayLike<number>, length: number): number {
  let sum = 0;
  for (let index = PKT_ID; index < length - 1; index++) sum += packet[index];

  return ~sum & 0xff;
}

/** Returns the instruction packet FF FF ID LENGTH INSTRUCTION PARAMETERS... CHECKSUM. */
export function instructionPacket(id: number, instruction: number, parameters: ArrayLike<number>): Uint8Array {
  const packet = new Uint8Array(parameters.length + 6);
  const fields = [id, instruction, ...Array.from(parameters)];
  if (fields.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 0xff)) {
    throw new RangeError(`Not bytes: ${fields.join(", ")}`);
  }

  packet[PKT_HEADER0] = 0xff;
  packet[PKT_HEADER1] = 0xff;
  packet[PKT_ID] = id;
  // a packet whose length does not fit is never sent: txPacket() refuses anything above TXPACKET_MAX_LEN
  packet[PKT_LENGTH] = (parameters.length + 2) & 0xff;
  packet[PKT_INSTRUCTION] = instruction;
  packet.set(parameters, PKT_PARAMETER0);
  packet[packet.length - 1] = checksumOf(packet, packet.length);

  return packet;
}

export function pingPacket(id: number): Uint8Array {
  return instructionPacket(id, INST_PING, []);
}

export function readPacket(id: number, address: number, length: number): Uint8Array {
  return instructionPacket(id, INST_READ, [address, length]);
}

export function writePacket(id: number, address: number, data: ArrayLike<number>): Uint8Array {
  return instructionPacket(id, INST_WRITE, [address, ...Array.from(data)]);
}

/** Returns the parameters that name the servos of a sync read: an id given twice is asked once. */
export function syncReadParameters(ids: Iterable<number>): number[] {
  return [...new Set(ids)];
}

/** Returns the parameters of a sync write, each servo's id then its data: an id given twice keeps its first data,
 * and data longer than ``dataLength`` is left out. */
export function syncWriteParameters(dataLength: number, values: Iterable<readonly [number, ArrayLike<number>]>): number[] {
  const seen = new Set<number>();
  const parameters: number[] = [];
  for (const [id, data] of values) {
    if (seen.has(id) || data.length > dataLength) continue;
    if (data.length !== dataLength) throw new RangeError(`Servo ${id}: ${data.length} bytes for a ${dataLength}-byte register`);
    seen.add(id);
    parameters.push(id, ...Array.from(data));
  }

  return parameters;
}

/** Returns the broadcast packet that asks the servos ``ids`` for ``dataLength`` bytes at ``startAddress``; they
 * answer one after another, in that order. */
export function syncReadPacket(startAddress: number, dataLength: number, ids: ArrayLike<number>): Uint8Array {
  return instructionPacket(BROADCAST_ID, INST_SYNC_READ, [startAddress, dataLength, ...Array.from(ids)]);
}

/** Returns the broadcast packet that writes ``dataLength`` bytes at ``startAddress`` of several servos;
 * ``parameters`` are syncWriteParameters(). No servo answers it. */
export function syncWritePacket(startAddress: number, dataLength: number, parameters: ArrayLike<number>): Uint8Array {
  return instructionPacket(BROADCAST_ID, INST_SYNC_WRITE, [startAddress, dataLength, ...Array.from(parameters)]);
}

/** The bytes one call of rxPacket() consumed and what they were: COMM_SUCCESS for a status packet whose checksum
 * holds, then ``rxpacket`` is FF FF ID LENGTH ERROR PARAMETERS... CHECKSUM. */
export interface RxPacket {
  rxpacket: number[];
  result: number;
}

/**
 * Finds one status packet in a stream of bytes, as the SDK's rxPacket() does: it is given the bytes as they come,
 * in any pieces, and asks for no more than the packet in hand needs, so that what follows stays in the port.
 *
 * What it tolerates is what the SDK tolerates. Bytes before a header are dropped. A header whose id is above 0xFD,
 * whose length is above 250 or whose error byte is above 0x7F is not a status packet: its first byte is dropped
 * and the search goes on, which is how the echo of a broadcast instruction (id 0xFE) is skipped. The echo of an
 * instruction to one servo is not told from a status packet: it has the same form and its checksum holds.
 */
export class StatusPacketReader {
  private readonly rxpacket: number[] = [];
  private waitLength = MIN_STATUS_LENGTH;

  /** How many bytes to read from the port next; none when it is zero or less. */
  get wanted(): number {
    return this.waitLength - this.rxpacket.length;
  }

  push(bytes: ArrayLike<number>): void {
    for (let index = 0; index < bytes.length; index++) this.rxpacket.push(bytes[index]);
  }

  /** Returns the packet once the bytes pushed hold one, good or corrupt; null while more are wanted. */
  advance(): RxPacket | null {
    const rxpacket = this.rxpacket;
    while (rxpacket.length >= this.waitLength) {
      // find the header; a search that finds none stops at the last two bytes, which are kept
      const lastPair = rxpacket.length - 2;
      let idx = 0;
      while (idx < lastPair && !(rxpacket[idx] === 0xff && rxpacket[idx + 1] === 0xff)) idx++;

      if (idx !== 0) {
        rxpacket.splice(0, idx);
        continue;
      }
      if (rxpacket[PKT_ID] > 0xfd || rxpacket[PKT_LENGTH] > RXPACKET_MAX_LEN || rxpacket[PKT_ERROR] > 0x7f) {
        rxpacket.shift();
        continue;
      }
      if (this.waitLength !== rxpacket[PKT_LENGTH] + PKT_LENGTH + 1) {
        this.waitLength = rxpacket[PKT_LENGTH] + PKT_LENGTH + 1;
        continue;
      }

      const isIntact = rxpacket[this.waitLength - 1] === checksumOf(rxpacket, this.waitLength);
      return { rxpacket, result: isIntact ? COMM_SUCCESS : COMM_RX_CORRUPT };
    }

    return null;
  }

  /** Returns what the bytes pushed are when the packet's time is up: nothing at all, or a corrupt packet. */
  expire(): RxPacket {
    return { rxpacket: this.rxpacket, result: this.rxpacket.length === 0 ? COMM_RX_TIMEOUT : COMM_RX_CORRUPT };
  }
}

/** What the packet layer needs of a port: the SDK's PortHandler. */
export interface PacketPort {
  /** Whether a packet exchange is in flight. */
  isUsing: boolean;
  /** Waits until what was written has left the host. It does not discard received bytes: the SDK never does. */
  clearPort(): Promise<void>;
  /** Writes ``packet`` and resolves with the number of bytes written. */
  writePort(packet: Uint8Array): Promise<number>;
  /** Resolves with at most ``length`` received bytes; with none if none came before the packet's time was up. */
  readPort(length: number): Promise<ArrayLike<number>>;
  /** Starts the time allowed for a status packet of ``packetLength`` bytes. */
  setPacketTimeout(packetLength: number): void;
  isPacketTimeout(): boolean;
}

export async function txPacket(port: PacketPort, txpacket: Uint8Array): Promise<number> {
  if (port.isUsing) return COMM_PORT_BUSY;
  port.isUsing = true;

  if (txpacket.length > TXPACKET_MAX_LEN) {
    port.isUsing = false;
    return COMM_TX_ERROR;
  }

  try {
    await port.clearPort();
    if ((await port.writePort(txpacket)) !== txpacket.length) {
      port.isUsing = false;
      return COMM_TX_FAIL;
    }
  } catch (error) {
    port.isUsing = false; // the SDK would leave the port busy for good
    throw error;
  }

  return COMM_SUCCESS;
}

/** Reads one status packet from the port, within the time setPacketTimeout() started. */
export async function rxPacket(port: PacketPort): Promise<RxPacket> {
  const reader = new StatusPacketReader();
  try {
    for (;;) {
      reader.push(await port.readPort(reader.wanted));
      if (reader.wanted <= 0) {
        const received = reader.advance();
        if (received !== null) return received;
      } else if (port.isPacketTimeout()) {
        return reader.expire();
      }
    }
  } finally {
    port.isUsing = false;
  }
}

export interface TxRxResult {
  rxpacket: number[] | null;
  result: number;
  /** The status packet's error byte: the servo's Status. */
  error: number;
}

/** Sends an instruction packet and reads status packets until the one of the servo it went to; a broadcast
 * packet gets no answer here. */
export async function txRxPacket(port: PacketPort, txpacket: Uint8Array): Promise<TxRxResult> {
  let result = await txPacket(port, txpacket);
  if (result !== COMM_SUCCESS) return { rxpacket: null, result, error: 0 };

  if (txpacket[PKT_ID] === BROADCAST_ID) {
    port.isUsing = false;
    return { rxpacket: null, result, error: 0 };
  }

  port.setPacketTimeout(txpacket[PKT_INSTRUCTION] === INST_READ ? txpacket[PKT_PARAMETER0 + 1] + 6 : 6);

  let rxpacket: number[];
  do {
    ({ rxpacket, result } = await rxPacket(port));
  } while (result === COMM_SUCCESS && txpacket[PKT_ID] !== rxpacket[PKT_ID]);

  return { rxpacket, result, error: result === COMM_SUCCESS ? rxpacket[PKT_ERROR] : 0 };
}

export interface ReadResult {
  /** The status packet's bytes from its first parameter on, at most as many as were asked. */
  data: number[];
  result: number;
  error: number;
}

/** Reads ``length`` bytes at ``address`` of the servo ``id``. */
export async function readTxRx(port: PacketPort, id: number, address: number, length: number): Promise<ReadResult> {
  if (id >= BROADCAST_ID) return { data: [], result: COMM_NOT_AVAILABLE, error: 0 };

  const { rxpacket, result, error } = await txRxPacket(port, readPacket(id, address, length));
  const data = result === COMM_SUCCESS && rxpacket !== null ? rxpacket.slice(PKT_PARAMETER0, PKT_PARAMETER0 + length) : [];

  return { data, result, error };
}

/** Reads status packets until the one of the servo ``id``, and returns the ``length`` bytes it carries. */
export async function readRx(port: PacketPort, id: number, length: number): Promise<ReadResult> {
  let rxpacket: number[];
  let result: number;
  do {
    ({ rxpacket, result } = await rxPacket(port));
  } while (result === COMM_SUCCESS && rxpacket[PKT_ID] !== id);

  if (result !== COMM_SUCCESS) return { data: [], result, error: 0 };

  return { data: rxpacket.slice(PKT_PARAMETER0, PKT_PARAMETER0 + length), result, error: rxpacket[PKT_ERROR] };
}

/** Returns the unsigned value of the ``length`` bytes (1, 2 or 4) a read gave. A status packet with fewer
 * parameters than were asked has passed for the answer: the SDK fails on it with an IndexError. */
export function valueOf(data: readonly number[], length: number): number {
  if (data.length < length) throw new RangeError(`A status packet carries ${data.length} of the ${length} bytes read`);
  if (length === 1) return data[0];
  if (length === 2) return makeWord(data[0], data[1]);

  return makeDword(makeWord(data[0], data[1]), makeWord(data[2], data[3]));
}

/** Writes ``data`` at ``address`` of the servo ``id`` and waits for its status packet. */
export async function writeTxRx(
  port: PacketPort,
  id: number,
  address: number,
  data: ArrayLike<number>,
): Promise<{ result: number; error: number }> {
  const { result, error } = await txRxPacket(port, writePacket(id, address, data));

  return { result, error };
}

/** Pings the servo ``id`` and, when it answers, reads its model number. */
export async function ping(port: PacketPort, id: number): Promise<{ modelNumber: number; result: number; error: number }> {
  if (id >= BROADCAST_ID) return { modelNumber: 0, result: COMM_NOT_AVAILABLE, error: 0 };

  let { result, error } = await txRxPacket(port, pingPacket(id));
  let modelNumber = 0;
  if (result === COMM_SUCCESS) {
    const read = await readTxRx(port, id, 3, 2); // address 3: the model number
    ({ result, error } = read);
    if (result === COMM_SUCCESS) modelNumber = valueOf(read.data, 2);
  }

  return { modelNumber, result, error };
}

/** Sends a sync read to the servos ``ids`` and starts the time allowed for all their answers together. */
export async function syncReadTx(port: PacketPort, startAddress: number, dataLength: number, ids: readonly number[]): Promise<number> {
  const result = await txPacket(port, syncReadPacket(startAddress, dataLength, ids));
  if (result === COMM_SUCCESS) port.setPacketTimeout((6 + dataLength) * ids.length);

  return result;
}

/** Sends a sync write; ``parameters`` are syncWriteParameters(). */
export async function syncWriteTxOnly(
  port: PacketPort,
  startAddress: number,
  dataLength: number,
  parameters: readonly number[],
): Promise<number> {
  return (await txRxPacket(port, syncWritePacket(startAddress, dataLength, parameters))).result;
}
