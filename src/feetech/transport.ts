// Not in PEAR: what the Feetech bus needs of a serial line, so that Web Serial, a simulated chain of servos and,
// later, a bridge over a socket can each stand behind it. It takes the place of pyserial in the SDK's port_handler.py.

import { OSError } from "../python/errors";

/**
 * pyserial's SerialException (pyserial 3.5, serial/serialutil.py), an OSError: what the serial library raises in
 * PEAR when a port fails, is closed or is unplugged, and what lerobot's connect() turns into ConnectionError as it
 * does any OSError. A port of the Web Serial API fails with the browser's own error instead: the transport throws
 * this with the browser's message, and the browser's error as its `cause`.
 */
export class SerialException extends OSError {
  override readonly name: string = "SerialException";
}

/** Returns what a port failed with as the SerialException pyserial raises in its place. */
function serialException(error: unknown): SerialException {
  if (error instanceof SerialException) return error;

  return new SerialException(error instanceof Error ? error.message : String(error), { cause: error });
}

/** What the port has reported of its line since it was opened. */
export interface LineErrors {
  count: number;
  lastName: string;
  lastAt: number;
}

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
 *
 * A port that was closed, was unplugged or failed makes read() and write() throw SerialException; what was
 * received before is still read first.
 *
 * The Web Serial specification reports a framing error, a parity error, a break and a buffer overrun by failing
 * the port's readable stream and offering a new one (the readable attribute returns null, then a fresh stream);
 * only a lost device ends reading (readable stays null). The transport reads on from the new stream, counts such
 * errors in ``lineErrors``, and ends only when the port offers no stream any more.
 */
export class WebSerialTransport implements Transport {
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly pumping: Promise<void>;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private chunks: Uint8Array[] = []; // received and not yet read
  private wake: (() => void) | null = null; // resolves the read that waits for bytes
  private failure: SerialException | null = null; // why the port stopped giving bytes
  private closing = false;

  /** Errors the port survived since it was opened: a framing error, a parity error, a break or a buffer overrun
   * that failed the stream, after which the port offered a new one. Not seen on a real adapter: the specification
   * says a port offers a new stream, and this transport takes it; whether Chrome does this is not verified. */
  readonly lineErrors: LineErrors = { count: 0, lastName: "", lastAt: 0 };

  private constructor(private readonly port: SerialPortLike) {
    const readable = port.readable;
    if (readable === null || port.writable === null) throw new Error("The serial port is not open");
    this.writer = port.writable.getWriter();
    this.pumping = this.pump(readable);
  }

  /** Opens ``port`` (from navigator.serial.requestPort(), which needs a user's gesture) at the servos' baud rate. */
  static async open(port: SerialPortLike, baudRate = 1_000_000): Promise<WebSerialTransport> {
    await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: "none" });

    return new WebSerialTransport(port);
  }

  async write(bytes: Uint8Array): Promise<void> {
    try {
      await this.writer.write(bytes);
    } catch (error) {
      throw serialException(error); // pyserial: SerialException, "write failed"
    }
  }

  async read(maxLength: number, timeoutMs: number): Promise<Uint8Array> {
    if (this.chunks.length === 0 && timeoutMs > 0 && this.failure === null) {
      await this.arrival(timeoutMs);
      // The wait may have ended by its timer although bytes have come: when the page did not run for a while, the
      // timer and the port's bytes are due in the same turn of the event loop, and the timer can be the first of
      // the two. One more turn lets the port hand over what it has before the read says that nothing came
      if (this.chunks.length === 0 && this.failure === null) await this.arrival(0);
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
    if (this.closing) return;
    this.closing = true;
    this.failure ??= new SerialException("The serial port was closed");
    this.wake?.();
    await this.reader?.cancel().catch(() => undefined);
    await this.pumping;
    this.writer.releaseLock();
    await this.port.close().catch(() => undefined);
  }

  /** Resolves when the port has handed over bytes or has failed, and after ``timeoutMs`` at the latest. */
  private async arrival(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve) => {
      this.wake = resolve;
      timer = setTimeout(resolve, timeoutMs);
    });
    clearTimeout(timer);
    this.wake = null;
  }

  /** Moves what the port receives into ``chunks``, reading on from a new stream when the port survives an error,
   * until the port ends for good or ``close()`` is called. The Web Serial specification (§4.6 readable) says a
   * recoverable error (framing, parity, break, buffer overrun) fails the stream and sets the port's readable to
   * null, so the getter creates a new stream; a lost device sets a fatal flag and the getter returns null. This
   * transport tells the two apart by whether the port offers a new stream (port.readable is not null and not the
   * same object that just failed). Not verified on a real adapter. */
  private async pump(firstStream: ReadableStream<Uint8Array>): Promise<void> {
    let lastStream: ReadableStream<Uint8Array> = firstStream;
    let errorsInARow = 0;

    for (;;) {
      const reader = lastStream.getReader();
      this.reader = reader;
      let failure: unknown = null;

      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value.length > 0) this.chunks.push(value);
          errorsInARow = 0;
          this.wake?.();
        }
      } catch (error) {
        failure = error ?? new Error("The serial port failed");
      }

      reader.releaseLock();
      this.reader = null;

      if (this.closing) return;

      if (failure === null) {
        this.failure = new SerialException("The serial port was closed");
        this.wake?.();
        return;
      }

      const next = this.port.readable;
      if (next === null || next === lastStream) {
        this.failure = serialException(failure);
        this.wake?.();
        return;
      }

      errorsInARow += 1;
      this.lineErrors.count += 1;
      this.lineErrors.lastName = failure instanceof Error ? failure.name : "Error";
      this.lineErrors.lastAt = performance.now();
      const pause = Math.min(errorsInARow * 20, 500);
      if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
      if (this.closing) return;
      lastStream = next;
    }
  }
}
