// Not in PEAR: what the Feetech bus needs of a serial line, so that Web Serial, a simulated chain of servos and,
// later, a bridge over a socket can each stand behind it. It takes the place of pyserial in the SDK's port_handler.py.

/** A half-duplex serial line to a chain of servos, open for as long as the object is used. */
export interface Transport {
  /** Sends ``bytes``; resolves once they are handed to the device. */
  write(bytes: Uint8Array): Promise<void>;
  /**
   * Resolves with received bytes, at most ``maxLength`` of them and in the order they came: at once when some are
   * waiting, otherwise as soon as some come, and with none when none came within ``timeoutMs``. Zero only looks at
   * what is waiting. Bytes it does not return stay for the next call.
   */
  read(maxLength: number, timeoutMs: number): Promise<Uint8Array>;
  /** Releases the device. */
  close(): Promise<void>;
}

/** Time in ms for the bus's packet timeouts and for a simulated line; a test's own never waits. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A clock that moves only when something sleeps on it. */
export class ManualClock implements Clock {
  constructor(private time = 0) {}

  now(): number {
    return this.time;
  }

  async sleep(ms: number): Promise<void> {
    this.time += Math.max(ms, 0);
  }
}

/** The part of the Web Serial API's SerialPort the transport uses; TypeScript's DOM library does not declare it. */
export interface SerialPortLike {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number; dataBits?: number; stopBits?: number; parity?: "none" | "even" | "odd"; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
}

/**
 * A serial port of the Web Serial API (Chromium) as the bus's line: 8 data bits, no parity, one stop bit, as the
 * SDK opens it.
 *
 * The adapter is expected to switch the line's direction itself and not to hand the host its own bytes back; the
 * bus, like the SDK, takes an echoed instruction for a servo's answer.
 */
export class WebSerialTransport implements Transport {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly pumping: Promise<void>;
  private chunks: Uint8Array[] = []; // received and not yet read
  private wake: (() => void) | null = null; // resolves the read that waits for bytes
  private failure: unknown = null; // why the port stopped giving bytes

  private constructor(private readonly port: SerialPortLike) {
    if (port.readable === null || port.writable === null) throw new Error("The serial port is not open");
    this.reader = port.readable.getReader();
    this.writer = port.writable.getWriter();
    this.pumping = this.pump();
  }

  /** Opens ``port`` (from navigator.serial.requestPort(), which needs a user's gesture) at the servos' baud rate. */
  static async open(port: SerialPortLike, baudRate = 1_000_000): Promise<WebSerialTransport> {
    await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: "none" });

    return new WebSerialTransport(port);
  }

  async write(bytes: Uint8Array): Promise<void> {
    await this.writer.write(bytes);
  }

  async read(maxLength: number, timeoutMs: number): Promise<Uint8Array> {
    if (this.chunks.length === 0 && timeoutMs > 0 && this.failure === null) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        timer = setTimeout(resolve, timeoutMs);
      });
      clearTimeout(timer);
      this.wake = null;
    }
    if (this.chunks.length === 0 && this.failure !== null) throw this.failure;

    const taken: number[] = [];
    while (taken.length < maxLength && this.chunks.length > 0) {
      const chunk = this.chunks[0];
      const count = Math.min(chunk.length, maxLength - taken.length);
      for (let index = 0; index < count; index++) taken.push(chunk[index]);
      if (count === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(count);
    }

    return Uint8Array.from(taken);
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
    await this.pumping;
    this.reader.releaseLock();
    await this.writer.close().catch(() => undefined);
    await this.port.close();
  }

  /** Moves what the port receives into ``chunks`` until the port ends or fails. */
  private async pump(): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value.length > 0) this.chunks.push(value);
        this.wake?.();
      }
      this.failure = new Error("The serial port was closed");
    } catch (error) {
      this.failure = error;
    }
    this.wake?.();
  }
}
