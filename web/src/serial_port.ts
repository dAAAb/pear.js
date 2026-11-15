// Not in PEAR: a serial port that goes on reading after an error of the line.
//
// A Web Serial port reports a framing error, a parity error, a break or a buffer overrun by failing the stream
// it is read through; the port stays open and offers a new stream (the Web Serial specification's readable
// attribute: only a lost device ends reading for good). The library's WebSerialTransport reads one stream and
// takes its first error for the end of the port. On a half-duplex servo line such errors are to be expected when
// the servos' power is switched or a plug moves, so the page gives the transport this port instead: one stream
// that never fails for an error the port survives.

import type { SerialPortLike } from "../../src/feetech/index";

/** What the port has reported of its line since it was opened. */
export interface LineErrors {
  /** How many errors the port survived. */
  count: number;
  /** The name of the last one, as the browser gives it (BreakError, FramingError, ...). */
  lastName: string;
  /** When the last one came, on performance.now(). */
  lastAt: number;
}

/** After an error the next stream is taken only after a pause, ms for each error in a row, so that a line that
 * fails without end does not keep the page busy. */
const PAUSE_STEP_MS = 20;
const PAUSE_LIMIT_MS = 500;

export class ResilientPort implements SerialPortLike {
  readable: ReadableStream<Uint8Array> | null = null;
  readonly lineErrors: LineErrors = { count: 0, lastName: "", lastAt: 0 };

  private isStopped = false;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private pumping: Promise<void> = Promise.resolve();

  constructor(
    private readonly port: SerialPortLike,
    /** Told of every error the port survived. */
    private readonly onLineError: (error: unknown) => void = () => undefined,
    /** Told of the bytes the port delivers, as they come and before the transport takes them. */
    private readonly onReceived: (bytes: Uint8Array) => void = () => undefined,
  ) {}

  get writable(): WritableStream<Uint8Array> | null {
    return this.port.writable;
  }

  async open(options: Parameters<SerialPortLike["open"]>[0]): Promise<void> {
    await this.port.open(options);
    this.isStopped = false;
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.pumping = this.pump(controller);
      },
      cancel: async () => {
        this.isStopped = true;
        await this.reader?.cancel().catch(() => undefined);
        await this.pumping;
      },
    });
  }

  async close(): Promise<void> {
    this.isStopped = true;
    await this.reader?.cancel().catch(() => undefined);
    await this.pumping;
    this.readable = null;
    await this.port.close();
  }

  /** Hands on what the port receives, from one stream of the port after another, until reading is stopped or
   * the port has no stream left. */
  private async pump(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    let errorsInARow = 0;
    while (!this.isStopped) {
      const source = this.port.readable;
      if (source === null) {
        // the device is gone, or the port was closed under the page
        controller.error(new DOMException("The serial port has no readable stream", "NetworkError"));
        return;
      }

      const reader = source.getReader();
      this.reader = reader;
      let failure: unknown = null;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          errorsInARow = 0;
          this.onReceived(value);
          controller.enqueue(value);
        }
      } catch (error) {
        failure = error ?? new Error("The serial port failed");
      } finally {
        this.reader = null;
        reader.releaseLock();
      }
      if (this.isStopped) break;
      if (failure === null) continue; // the stream ended without an error: the port offers another, or none

      if (this.port.readable === null) {
        controller.error(failure); // an error the port does not survive: the device was lost
        return;
      }
      errorsInARow += 1;
      this.lineErrors.count += 1;
      this.lineErrors.lastName = failure instanceof Error ? failure.name : "Error";
      this.lineErrors.lastAt = performance.now();
      this.onLineError(failure);
      await new Promise((resolve) => setTimeout(resolve, Math.min(errorsInARow * PAUSE_STEP_MS, PAUSE_LIMIT_MS)));
    }

    try {
      controller.close();
    } catch {
      // the stream was cancelled: it is closed already
    }
  }
}
