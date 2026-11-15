// Not in PEAR: the bus's line over a TCP socket, for tests that talk to a simulated SO-101 servo chain reachable
// over TCP (the chain is not part of this repository). It uses Node's net module, so it lives under tests/: nothing
// under src/ may need Node.

import { connect, type Socket } from "node:net";

import type { Transport } from "../../src/feetech/transport";

/** A TCP connection as the bus's transport: what is written goes to the peer as it is, what the peer sends is read. */
export class TcpTransport implements Transport {
  /** The bytes written and read so far, for a test to count. */
  bytesWritten = 0;
  bytesRead = 0;
  isClosed = false;

  private chunks: Buffer[] = []; // received and not yet read
  private wake: (() => void) | null = null; // resolves the read that waits for bytes
  private failure: Error | null = null; // why the connection stopped giving bytes

  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      if (chunk.length > 0) this.chunks.push(chunk);
      this.wake?.();
    });
    socket.on("error", (error: Error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("The line was closed")));
  }

  /** Connects to ``host``:``port``; rejects if nothing accepts within ``timeoutMs``. */
  static connect(host: string, port: number, timeoutMs = 5000): Promise<TcpTransport> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`No connection to ${host}:${port} within ${timeoutMs} ms`));
      }, timeoutMs);
      socket.once("error", (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeAllListeners("error");
        socket.setNoDelay(true); // a packet leaves when it is written, not when the next one is
        resolve(new TcpTransport(socket));
      });
    });
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.failure !== null) throw this.failure;

    await new Promise<void>((resolve, reject) => {
      this.socket.write(bytes, (error) => (error ? reject(error) : resolve()));
    });
    this.bytesWritten += bytes.length;
  }

  async read(maxLength: number, timeoutMs: number): Promise<Uint8Array> {
    if (this.chunks.length === 0 && timeoutMs > 0 && this.failure === null) {
      if (this.wake !== null) throw new Error("A read is already waiting on this line");

      // a timer is no finer than a millisecond and may be much coarser: bytes that come wake the read at once,
      // only a read that gets none waits for the timer
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
    this.bytesRead += taken.length;

    return Uint8Array.from(taken);
  }

  /** Closes the connection; closing it again does nothing. */
  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;

    await new Promise<void>((resolve) => {
      if (this.socket.destroyed) {
        resolve();
        return;
      }
      this.socket.once("close", () => resolve());
      this.socket.end();
      // a peer that never closes its side is not waited for
      setTimeout(() => this.socket.destroy(), 500).unref();
    });
  }

  private fail(error: Error): void {
    if (this.failure === null) this.failure = this.isClosed ? new Error("The line is closed") : error;
    this.wake?.();
  }
}
