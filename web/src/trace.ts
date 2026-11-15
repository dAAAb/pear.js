// Not in PEAR: a record of the bytes that went over the serial line and when, so that the page's log can show
// them when a handshake or a read fails. One copied log should let someone who was not there tell a wrong port
// from servos without power, from another baud rate, from servos with other ids.
//
// What is sent is recorded where the bus's transport hands it to the port, below the read-only guard, which
// has let it through by then. What is received is recorded as the port delivers it (serial_port.ts), not as the
// bus consumes it, so that an answer that came late shows when it came.

import type { Transport } from "../../src/feetech/index";

export type TraceKind = "tx" | "rx" | "error";

export interface TraceEvent {
  /** ms since the port was opened. */
  atMs: number;
  kind: TraceKind;
  /** The bytes sent or received; none for an error of the line. */
  bytes: Uint8Array;
  /** The name of the line's error as the browser gives it (FramingError, BreakError, ...); empty otherwise. */
  note: string;
}

/** How many bytes of each direction a report shows. */
export const TRACE_BYTES = 64;
/** How many events are kept: the periodic read of a healthy arm makes about twenty a second. */
const KEPT_EVENTS = 600;
/** Received pieces that follow one another this closely are shown as one, ms. */
const JOIN_MS = 2;
/** How many errors of the line a report shows one by one. */
const ERROR_LINES = 8;

/** Returns ``bytes`` as the log shows them: two hexadecimal digits each, lower case, a space between. */
export function hexOf(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

/** What went over one opened port, in the order it happened. */
export class LineTrace {
  private readonly events: TraceEvent[] = [];
  private recorded = 0; // how many events there ever were
  private openedAt = performance.now();

  /** Makes now the trace's zero: the port has just been opened. */
  opened(): void {
    this.openedAt = performance.now();
  }

  sent(bytes: Uint8Array): void {
    this.record("tx", bytes.slice(), "");
  }

  received(bytes: Uint8Array): void {
    this.record("rx", bytes.slice(), "");
  }

  lineError(name: string): void {
    this.record("error", new Uint8Array(0), name);
  }

  /** Returns a mark of this moment: what is recorded from now on comes after it. */
  mark(): number {
    return this.recorded;
  }

  /** Returns the events recorded since ``mark`` that are still kept. */
  since(mark: number): TraceEvent[] {
    const oldest = this.recorded - this.events.length;

    return this.events.slice(Math.max(mark - oldest, 0));
  }

  /**
   * Returns lines for the log: what was sent and received since ``mark``, in hexadecimal, at most ``limit``
   * bytes of each direction, each piece with its time in ms after the port was opened. ``what`` names the
   * exchange in the first line, which also holds the totals.
   */
  report(what: string, mark: number, limit = TRACE_BYTES): string[] {
    const events = this.since(mark);
    const isIncomplete = mark < this.recorded - this.events.length;
    const total = { tx: 0, rx: 0 };
    let packets = 0;
    let errors = 0;
    for (const event of events) {
      if (event.kind === "error") errors += 1;
      else {
        total[event.kind] += event.bytes.length;
        if (event.kind === "tx") packets += 1;
      }
    }

    const lines: string[] = [];
    const left = { tx: limit, rx: limit };
    let errorLines = 0;
    let piece: { kind: "tx" | "rx"; startMs: number; lastMs: number; bytes: number[]; isCut: boolean } | null = null;
    const stamp = (atMs: number): string => `+${atMs.toFixed(1)} ms`;
    const flush = (): void => {
      if (piece !== null) {
        // "..." where the limit cut a piece short
        const hex = `${hexOf(piece.bytes)}${piece.isCut ? " ..." : ""}`;
        lines.push(`  ${stamp(piece.startMs)} ${piece.kind === "tx" ? "TX" : "RX"} ${hex}`);
      }
      piece = null;
    };
    for (const event of events) {
      if (event.kind === "error") {
        flush();
        errorLines += 1;
        if (errorLines <= ERROR_LINES) lines.push(`  ${stamp(event.atMs)} line error ${event.note}`);
        continue;
      }
      if (left[event.kind] === 0) continue;

      const shown = Array.from(event.bytes.subarray(0, left[event.kind]));
      const isCut = shown.length < event.bytes.length;
      left[event.kind] -= shown.length;
      if (piece !== null && piece.kind === "rx" && event.kind === "rx" && event.atMs - piece.lastMs <= JOIN_MS) {
        piece.bytes.push(...shown);
        piece.lastMs = event.atMs;
        piece.isCut = isCut;
      } else {
        flush();
        piece = { kind: event.kind, startMs: event.atMs, lastMs: event.atMs, bytes: shown, isCut };
      }
    }
    flush();

    const head =
      `Line trace, ${what}: sent ${total.tx} bytes in ${packets} packets, received ${total.rx} bytes` +
      `${errors > 0 ? `, ${errors} line errors` : ""}${isIncomplete ? " (the oldest are no longer kept)" : ""}`;

    return lines.length === 0
      ? [`${head}.`]
      : [`${head}. The first ${limit} bytes each way, with the ms after the port was opened:`, ...lines];
  }

  private record(kind: TraceKind, bytes: Uint8Array, note: string): void {
    this.events.push({ atMs: performance.now() - this.openedAt, kind, bytes, note });
    this.recorded += 1;
    if (this.events.length > KEPT_EVENTS) this.events.splice(0, this.events.length - KEPT_EVENTS);
  }
}

/** A transport that records in ``trace`` what it is given to send, and is ``inner`` in everything else. */
export class TracedTransport implements Transport {
  constructor(
    private readonly inner: Transport,
    private readonly trace: LineTrace,
  ) {}

  async write(bytes: Uint8Array): Promise<void> {
    this.trace.sent(bytes);
    await this.inner.write(bytes);
  }

  read(maxLength: number, timeoutMs: number): Promise<Uint8Array> {
    return this.inner.read(maxLength, timeoutMs);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
