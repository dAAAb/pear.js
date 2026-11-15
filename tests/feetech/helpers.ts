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

/**
 * The line as the reference saw it: it requires the packets the reference sent, in their order, and answers each
 * with the bytes the reference received. What is wrong is collected in ``problems``, so that a step's own outcome
 * is still compared.
 */
export class ReplayTransport implements Transport {
  readonly problems: string[] = [];
  isClosed = false;
  /** Whose packet timeout is compared with the reference's, once a bus is on the line. */
  portHandler: PortHandler | null = null;
  private exchanges: Exchange[] = [];
  private next = 0;
  private pending: number[] = []; // received and not yet read
  private timeoutToCheck: number | null = null;

  constructor(private readonly clock: ManualClock) {}

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

/** Requires ``error`` to be what stands in pear.js for the exception the reference raised. */
export function expectError(error: unknown, expected: FixtureError): void {
  expect(error).toBeInstanceOf(Error);
  const thrown = error as Error;
  const isStatusError = expected.message.includes("[RxPacketError]");

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
      expect(thrown).toBeInstanceOf(RangeError);
      expect(thrown.message).toBe(expected.message);
      break;
    case "NotImplementedError":
      expect(thrown.message).toBe(expected.message);
      break;
    case "IndexError": // a status packet with fewer bytes than were read
      expect(thrown).toBeInstanceOf(RangeError);
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
