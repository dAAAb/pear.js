import { describe, expect, test } from "vitest";

import { FeetechCommError } from "../../src/feetech/bus";
import { ServoFault, type SO101ArmState } from "../../src/so101/hardware/arm_state";
import { ARM, type ArmHardware, type Feedforward, SO101Driver } from "../../src/so101/hardware/driver";
import { fixture, type FixtureError } from "./helpers";

interface DriverStep {
  op: string;
  args: { reading?: number | string; target?: number[]; velocity?: number[]; offset?: number[] | null };
  result?: unknown;
  error?: FixtureError;
  sent: number[][];
  asked?: unknown[][];
  is_closed: boolean;
}

interface DriverFixture {
  arm: string;
  offset_epsilon: number;
  lower_bounds: number[];
  upper_bounds: number[];
  monotonic: { start_s: number; step_s: number };
  drivers: { name: string; has_feedforward: boolean; steps: DriverStep[] }[];
}

const reference = fixture<DriverFixture>("driver.json");

/** The arm under the driver, as in the fixture script: its readings and failures as a script, and what it was
 * sent. */
class StubHardware implements ArmHardware {
  script: (SO101ArmState | Error)[] = [];
  sent: number[][] = [];
  isClosed = false;

  async read(): Promise<SO101ArmState> {
    const item = this.script.shift();
    if (item === undefined) throw new Error("The script has no reading left");
    if (item instanceof Error) throw item;
    return item;
  }

  readForRecovery(): Promise<SO101ArmState> {
    return this.read();
  }

  async send(target: readonly number[]): Promise<void> {
    this.sent.push([...target]);
  }

  async close(): Promise<void> {
    this.isClosed = true;
  }
}

/** Goal offsets as a script, in place of the gravity and friction model; it notes what it was asked. */
class StubFeedforward implements Feedforward {
  script: (number[] | Error)[] = [];
  calls: unknown[][] = [];

  holdOffset(target: readonly number[]): number[] {
    this.calls.push(["hold_offset", [...target]]);
    const item = this.script.shift() as number[] | Error;
    if (item instanceof Error) throw item;
    return item;
  }

  offset(target: readonly number[], plannedVelocity: readonly number[] | null, nowS: number): number[] {
    this.calls.push(["offset", [...target], plannedVelocity === null ? null : [...plannedVelocity], nowS]);
    return this.script.shift() as number[];
  }
}

const failures: Record<string, () => Error> = {
  ConnectionError: () => new FeetechCommError("no status packet"),
  ServoFault: () => new ServoFault("Servo error: elbow_flex: overload"),
};

describe("the driver does what PEAR's SO101Driver does", () => {
  test("its names and its tolerance", () => {
    expect(ARM).toBe(reference.arm);
    expect(SO101Driver.OFFSET_EPSILON).toBe(reference.offset_epsilon);
  });

  for (const { name, has_feedforward, steps } of reference.drivers) {
    test(`${name}: ${steps.length} steps`, async () => {
      const hardware = new StubHardware();
      const feedforward = has_feedforward ? new StubFeedforward() : null;
      let monotonicCalls = 0;
      const warnings: string[] = [];
      const driver = new SO101Driver(
        hardware,
        { lowerBounds: reference.lower_bounds, upperBounds: reference.upper_bounds },
        feedforward,
        {
          monotonic: () => reference.monotonic.start_s + reference.monotonic.step_s * monotonicCalls++,
          onWarning: (message) => warnings.push(message),
        },
      );

      for (const [index, step] of steps.entries()) {
        const { reading, target, velocity, offset } = step.args;
        if (reading !== undefined) {
          hardware.script.push(typeof reading === "string" ? failures[reading]() : ({ reading } as unknown as SO101ArmState));
        }
        if (offset !== undefined) feedforward?.script.push(offset === null ? new Error("no gravity model") : offset);
        const targets: Record<string, number[]> = target === undefined ? {} : { [ARM]: target };
        const velocities: Record<string, number[]> | null = velocity === undefined ? null : { [ARM]: velocity };

        let result: unknown;
        let thrown: unknown;
        try {
          if (step.op === "send") result = await driver.send(targets, velocities);
          else if (step.op === "refresh_hold") result = await driver.refreshHold(targets);
          else if (step.op === "read") result = await driver.read();
          else if (step.op === "read_for_recovery") result = await driver.readForRecovery();
          else if (step.op === "telemetry") result = driver.telemetry();
          else if (step.op === "close") result = await driver.close();
          else throw new Error(`The fixture holds an operation this test does not know: ${step.op}`);
        } catch (error) {
          thrown = error;
        }

        const label = `step ${index} (${step.op})`;
        if (step.error === undefined) {
          if (thrown !== undefined) throw thrown;
          expect([label, result ?? null]).toEqual([label, step.result ?? null]);
        } else {
          expect([label, (thrown as Error | undefined)?.message]).toEqual([label, step.error.message]);
          expect(thrown instanceof ServoFault).toBe(step.error.type === "ServoFault");
        }
        expect([label, hardware.sent]).toEqual([label, step.sent]);
        hardware.sent = [];
        if (feedforward !== null) {
          expect([label, feedforward.calls]).toEqual([label, step.asked]);
          feedforward.calls = [];
        }
        expect([label, hardware.isClosed]).toEqual([label, step.is_closed]);
      }

      expect(steps.some((step) => step.error !== undefined) || has_feedforward).toBe(true);
      expect(warnings.length).toBeGreaterThan(0); // a kept reading, or a hold without its gravity offset
    });
  }
});
