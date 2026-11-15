import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";

import {
  DeviceAlreadyConnectedError,
  DeviceNotConnectedError,
  FeetechCommError,
  FeetechStatusError,
  type MotorCalibration,
} from "../../src/feetech/bus";
import type { PortHandler } from "../../src/feetech/bus";
import type { ManualClock, Transport } from "../../src/feetech/transport";
import { IndexError, ValueError } from "../../src/python/errors";
import { ServoFault } from "../../src/so101/hardware/arm_state";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "feetech");

/** Returns a fixture written by tools/fixtures/feetech_fixtures.py. */
export function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;
}

/** One packet the reference sent, the bytes that came back and the timeout it set for them. */
export interface Exchange {
  tx: number[];
  rx: number[];
  timeout_ms: number | null;
}

export interface FixtureError {
  type: string;
  message: string;
}

export interface Step {
  op: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: FixtureError;
  exchanges?: Exchange[];
  faults?: string[];
}

export type FixtureCalibration = Record<
  string,
  { id: number; drive_mode: number; homing_offset: number; range_min: number; range_max: number }
>;

export function calibrationOf(entries: FixtureCalibration): Record<string, MotorCalibration> {
  return Object.fromEntries(
    Object.entries(entries).map(([motor, entry]) => [
      motor,
      {
        id: entry.id,
        driveMode: entry.drive_mode,
        homingOffset: entry.homing_offset,
        rangeMin: entry.range_min,
        rangeMax: entry.range_max,
      },
    ]),
  );
}

export function fixtureCalibrationOf(calibration: Record<string, MotorCalibration>): FixtureCalibration {
  return Object.fromEntries(
    Object.entries(calibration).map(([motor, entry]) => [
      motor,
      {
        id: entry.id,
        drive_mode: entry.driveMode,
        homing_offset: entry.homingOffset,
        range_min: entry.rangeMin,
        range_max: entry.rangeMax,
      },
    ]),
  );
}

// With PEAR_JS_REPLAY_DISCARDS=1 every replay runs the bus as it is by itself, late answers discarded, and the
// suite shows where that first departs from the recordings: at one read after an echo (docs/progress/feetech.md,
// "Deliberate differences"; stalled_host.test.ts lists all three places).
const REPLAYS_AS_THE_SDK = process.env.PEAR_JS_REPLAY_DISCARDS !== "1";

/**
 * The line as the reference saw it: it requires the packets the reference sent, in their order, and answers each
 * with the bytes the reference received. What is wrong is collected in ``problems``, so that a step's own outcome
 * is still compared.
 */
export class ReplayTransport implements Transport {
  readonly problems: string[] = [];
  isClosed = false;
  private handler: PortHandler | null = null;
  private exchanges: Exchange[] = [];
  private next = 0;
  private pending: number[] = []; // received and not yet read
  private timeoutToCheck: number | null = null;

  constructor(
    private readonly clock: ManualClock,
    /** Whether the bus on this line reads it as the SDK does, keeping what waits in its input when it writes: the
     * recording holds what the SDK made of a late answer. With false the bus discards it, as it does by itself. */
    private readonly asTheSdk = REPLAYS_AS_THE_SDK,
  ) {}

  /** Whose packet timeout is compared with the reference's, once a bus is on the line. */
  get portHandler(): PortHandler | null {
    return this.handler;
  }

  set portHandler(handler: PortHandler | null) {
    this.handler = handler;
    if (handler !== null && this.asTheSdk) handler.discardsInput = false;
  }

  /** Makes ``exchanges`` what the next step must send and receive. */
  expect(exchanges: Exchange[]): void {
    this.exchanges = exchanges;
    this.next = 0;
  }

  /** Requires that the step sent all it had to, and nothing else. */
  verify(): void {
    if (this.next !== this.exchanges.length) {
      this.problems.push(`${this.exchanges.length - this.next} of ${this.exchanges.length} packets were not sent`);
    }
    expect(this.problems).toEqual([]);
  }

  async write(bytes: Uint8Array): Promise<void> {
    const exchange = this.exchanges[this.next];
    this.next += 1;
    if (exchange === undefined) {
      this.problems.push(`A packet too many: ${Array.from(bytes).join(" ")}`);
      return;
    }
    if (exchange.tx.join(" ") !== Array.from(bytes).join(" ")) {
      this.problems.push(`Packet ${this.next}: sent ${Array.from(bytes).join(" ")}, expected ${exchange.tx.join(" ")}`);
    }
    this.pending.push(...exchange.rx);
    this.timeoutToCheck = exchange.timeout_ms;
  }

  async read(maxLength: number, timeoutMs: number): Promise<Uint8Array> {
    if (this.timeoutToCheck !== null && this.portHandler !== null) {
      if (this.portHandler.packetTimeout !== this.timeoutToCheck) {
        this.problems.push(`Packet ${this.next}: timeout ${this.portHandler.packetTimeout}, expected ${this.timeoutToCheck}`);
      }
      this.timeoutToCheck = null;
    }
    if (this.pending.length === 0 && timeoutMs > 0) await this.clock.sleep(timeoutMs);

    return Uint8Array.from(this.pending.splice(0, maxLength));
  }

  async close(): Promise<void> {
    this.isClosed = true;
  }
}

/**
 * A line on which a test makes an answer come late. It stands between the bus and ``line``, which answers at once
 * (the simulated servos do), and keeps back the answer to the instruction packet a test names. The read that waits
 * for that answer returns with nothing once the packet's time has passed on the test's clock, and the answer comes
 *
 * - after stallNextAnswer(): as soon as that wait has ended. The host did not run for ``pauseMs`` while it waited,
 *   as a page that is busy or a thread that is held does: the answer was on time, and is there for the next look;
 * - after delayNextAnswer(): only when the next instruction packet has been written, before that packet's own
 *   answer: the line itself was slow, and a look made when the wait has ended finds nothing.
 */
export class LateAnswerTransport implements Transport {
  /** The instruction packets written, for a test to count. */
  readonly written: number[][] = [];
  private waiting: number[] = []; // arrived and not yet read
  private lateness: "stalled" | "slow" | null = null; // of the next instruction packet's answer
  private held: { answer: number[]; lateness: "stalled" | "slow" } | null = null; // an answer kept back

  constructor(
    private readonly line: Transport,
    private readonly clock: ManualClock,
    /** How long the host does not run while it waits for a stalled answer, ms. */
    private readonly pauseMs = 100,
  ) {}

  stallNextAnswer(): void {
    this.lateness = "stalled";
  }

  delayNextAnswer(): void {
    this.lateness = "slow";
  }

  /** How many bytes have arrived and were not read. */
  get waitingLength(): number {
    return this.waiting.length;
  }

  async write(bytes: Uint8Array): Promise<void> {
    this.written.push(Array.from(bytes));
    await this.line.write(bytes);
    const answer = Array.from(await this.line.read(Number.MAX_SAFE_INTEGER, 0));

    if (this.held !== null) {
      this.waiting.push(...this.held.answer); // the slow answer comes now, before this packet's own
      this.held = null;
    }
    if (this.lateness === null) {
      this.waiting.push(...answer);
    } else {
      this.held = { answer, lateness: this.lateness };
      this.lateness = null;
    }
  }

  async read(maxLength: number, timeoutMs: number): Promise<Uint8Array> {
    if (this.waiting.length === 0 && timeoutMs > 0) {
      // nothing will come within the time: what is not kept back is there when its instruction is written
      const isStalled = this.held?.lateness === "stalled";
      await this.clock.sleep(isStalled ? Math.max(timeoutMs, this.pauseMs) : timeoutMs);
      if (this.held !== null && isStalled) {
        this.waiting.push(...this.held.answer);
        this.held = null;
      }

      return new Uint8Array(0); // this wait has ended with nothing; what is there now is for the next look
    }

    return Uint8Array.from(this.waiting.splice(0, Math.max(maxLength, 0)));
  }

  async close(): Promise<void> {
    await this.line.close();
  }
}

/** Requires ``error`` to be the exception the reference raised: an error that carries the name of its Python
 * class, with its message. */
export function expectError(error: unknown, expected: FixtureError): void {
  expect(error).toBeInstanceOf(Error);
  const thrown = error as Error;
  const isStatusError = expected.message.includes("[RxPacketError]");

  // type(error).__name__ of the reference, whatever the class is called in pear.js
  expect(thrown.name).toBe(expected.type);

  switch (expected.type) {
    case "ConnectionError":
      expect(thrown).toBeInstanceOf(FeetechCommError);
      expect(thrown.message).toBe(expected.message);
      break;
    case "RuntimeError":
      expect(thrown).not.toBeInstanceOf(FeetechCommError);
      expect(thrown instanceof FeetechStatusError).toBe(isStatusError);
      if (expected.message.startsWith("FeetechMotorsBus(")) {
        // the reference prints the whole bus here
        expect(expected.message.endsWith(" has no calibration registered.")).toBe(true);
        expect(thrown.message).toBe("FeetechMotorsBus has no calibration registered.");
      } else {
        expect(thrown.message).toBe(expected.message);
      }
      break;
    case "ValueError":
      expect(thrown).toBeInstanceOf(ValueError);
      expect(thrown.message).toBe(expected.message);
      break;
    case "NotImplementedError":
      expect(thrown.message).toBe(expected.message);
      break;
    case "IndexError": // a status packet with fewer bytes than were read
      expect(thrown).toBeInstanceOf(IndexError);
      break;
    case "StopIteration": // a sync read or write of no motor
      expect(thrown).not.toBeInstanceOf(FeetechCommError);
      break;
    case "DeviceAlreadyConnectedError":
      expect(thrown).toBeInstanceOf(DeviceAlreadyConnectedError);
      expect(thrown.message).toBe(expected.message);
      break;
    case "DeviceNotConnectedError":
      expect(thrown).toBeInstanceOf(DeviceNotConnectedError);
      expect(thrown.message).toBe(expected.message);
      break;
    case "ServoFault":
      expect(thrown).toBeInstanceOf(ServoFault);
      expect(thrown.message).toBe(expected.message);
      break;
    default:
      throw new Error(`The fixture holds an exception this test does not know: ${expected.type}`);
  }
}

/** Runs ``run`` and requires the outcome the reference had for ``step``: its result or its exception. */
export async function expectOutcome(step: Step, run: () => Promise<unknown>): Promise<void> {
  let result: unknown;
  let thrown: unknown;
  try {
    result = await run();
  } catch (error) {
    thrown = error;
  }

  if (step.error !== undefined) {
    if (thrown === undefined) throw new Error(`${step.op} returned; the reference raised ${step.error.type}: ${step.error.message}`);
    expectError(thrown, step.error);
  } else {
    if (thrown !== undefined) throw thrown;
    expect(result ?? null).toEqual(step.result ?? null);
  }
}
