import { describe, expect, test } from "vitest";

import { FeetechCommError, FeetechMotorsBus, FeetechStatusError, type Motor } from "../../src/feetech/bus";
import { COMM_RX_TIMEOUT } from "../../src/feetech/protocol";
import { SimServo, SimServoChain } from "../../src/feetech/sim";
import type { RegisterName } from "../../src/feetech/tables";
import { ManualClock } from "../../src/feetech/transport";
import { followerMotors } from "../../src/so101/hardware/motors";
import {
  calibrationOf,
  expectOutcome,
  fixture,
  type FixtureCalibration,
  fixtureCalibrationOf,
  ReplayTransport,
  type Step,
} from "./helpers";

interface BusFixture {
  port: string;
  calibration: FixtureCalibration;
  scenarios: { name: string; steps: Step[] }[];
}

const reference = fixture<BusFixture>("bus.json");

/** Runs on ``bus`` the operation of lerobot's bus that the fixture names, with its arguments. */
async function operate(bus: FeetechMotorsBus, op: string, args: Record<string, unknown>): Promise<unknown> {
  const dataName = args.data_name as RegisterName;
  const motors = (args.motors ?? null) as string | string[] | null;
  const access = { normalize: args.normalize as boolean | undefined, numRetry: args.num_retry as number | undefined };

  switch (op) {
    case "connect":
      return bus.connect(args.handshake as boolean | undefined);
    case "disconnect":
      return bus.disconnect(args.disable_torque as boolean | undefined);
    case "ping":
      return bus.ping(args.motor as string | number, access.numRetry, args.raise_on_error as boolean | undefined);
    case "read":
      return bus.read(dataName, args.motor as string, access);
    case "write":
      return bus.write(dataName, args.motor as string, args.value as number, access);
    case "sync_read":
      return bus.syncRead(dataName, motors, access);
    case "sync_write":
      return bus.syncWrite(dataName, args.values as number | Record<string, number>, access);
    case "enable_torque":
      return bus.enableTorque(motors, access.numRetry);
    case "disable_torque":
      return bus.disableTorque(motors, access.numRetry);
    case "configure_motors":
      return bus.configureMotors();
    case "read_calibration":
      return fixtureCalibrationOf(await bus.readCalibration());
    case "write_calibration":
      return bus.writeCalibration(calibrationOf(args.calibration as FixtureCalibration), args.cache as boolean | undefined);
    case "is_calibrated":
      return bus.isCalibrated();
    default:
      throw new Error(`The fixture holds an operation this test does not know: ${op}`);
  }
}

describe("the bus sends what lerobot's sends and makes the same of what comes back", () => {
  for (const scenario of reference.scenarios) {
    const operations = scenario.steps.filter(({ op }) => op !== "poke");
    const packets = operations.reduce((count, step) => count + (step.exchanges?.length ?? 0), 0);

    test(`${scenario.name}: ${operations.length} operations, ${packets} packets`, async () => {
      const clock = new ManualClock();
      const transport = new ReplayTransport(clock);
      const calibration = scenario.name === "no calibration" ? null : calibrationOf(reference.calibration);
      const bus = new FeetechMotorsBus(transport, followerMotors(), calibration, { port: reference.port, clock });
      transport.portHandler = bus.portHandler;

      for (const [index, step] of operations.entries()) {
        transport.expect(step.exchanges ?? []);
        try {
          await expectOutcome(step, () => operate(bus, step.op, step.args));
          transport.verify();
        } catch (error) {
          throw new Error(`Step ${index} (${step.op} ${JSON.stringify(step.args)}): ${(error as Error).message}`, { cause: error });
        }
      }
      expect(operations.length).toBeGreaterThan(0);
    });
  }

  test("the scenarios hold every kind of failure the reference has", () => {
    const steps = reference.scenarios.flatMap((scenario) => scenario.steps);
    const failures = new Set(steps.flatMap((step) => (step.error === undefined ? [] : [step.error.type])));
    expect([...failures].sort()).toEqual([
      "ConnectionError",
      "DeviceAlreadyConnectedError",
      "DeviceNotConnectedError",
      "IndexError",
      "RuntimeError",
      "StopIteration",
      "ValueError",
    ]);
    const faults = new Set(steps.flatMap((step) => step.faults ?? []));
    expect([...faults].sort()).toEqual(["absent", "corrupt", "drop", "echo", "noise", "truncate"]);
  });
});

describe("the bus on simulated servos", () => {
  const motors: Record<string, Motor> = { pan: { id: 1, normMode: "degrees" }, jaw: { id: 2, normMode: "range_0_100" } };
  const calibration = {
    pan: { id: 1, driveMode: 0, homingOffset: 0, rangeMin: 1000, rangeMax: 3000 },
    jaw: { id: 2, driveMode: 0, homingOffset: 0, rangeMin: 2000, rangeMax: 3000 },
  };
  const connected = async (speed?: number) => {
    const clock = new ManualClock();
    const chain = new SimServoChain(
      [
        new SimServo(1, { Min_Position_Limit: 1000, Max_Position_Limit: 3000 }),
        new SimServo(2, { Min_Position_Limit: 2000, Max_Position_Limit: 3000, Present_Position: 2500 }),
      ],
      { clock, speed },
    );
    const bus = new FeetechMotorsBus(chain, motors, calibration, { clock });
    await bus.connect();

    return { clock, chain, bus };
  };

  test("a goal is reached at once, inside the servo's limits", async () => {
    const { chain, bus } = await connected();
    expect(await bus.isCalibrated()).toBe(true);
    expect(await bus.syncRead("Present_Position")).toEqual({ pan: ((2047 - 2000) * 360) / 4095, jaw: 50 });

    await bus.syncWrite("Goal_Position", { pan: 0, jaw: 100 });
    expect(chain.servo(1).position).toBe(2047); // no torque yet: the goal is kept, the horn stays
    await bus.enableTorque();
    expect(chain.servo(1).position).toBe(2000);
    expect(await bus.syncRead("Present_Position")).toEqual({ pan: 0, jaw: 100 });

    await bus.write("Goal_Position", "pan", 4000, { normalize: false });
    expect(await bus.read("Present_Position", "pan", { normalize: false })).toBe(3000);
    expect(await bus.read("Lock", "jaw")).toBe(1);
  });

  test("a goal is reached at a set speed", async () => {
    const { clock, chain, bus } = await connected(1000); // steps a second
    await bus.syncWrite("Goal_Position", { pan: 2047, jaw: 2500 }, { normalize: false });
    await bus.enableTorque();
    expect(await bus.read("Moving", "pan")).toBe(0);
    await bus.write("Goal_Position", "pan", 2547, { normalize: false });
    expect(await bus.read("Present_Position", "pan", { normalize: false })).toBe(2047); // no time has passed
    expect(await bus.read("Moving", "pan")).toBe(1);

    await clock.sleep(100);
    expect(await bus.read("Present_Position", "pan", { normalize: false })).toBe(2147);
    expect(await bus.read("Moving", "pan")).toBe(1);
    await clock.sleep(1000);
    expect(await bus.syncRead("Present_Position", null, { normalize: false })).toEqual({ pan: 2547, jaw: 2500 });
    expect(await bus.read("Moving", "pan")).toBe(0);

    chain.servo(2).position = 2600; // a hand cannot move a servo that holds torque for long
    await clock.sleep(1000);
    expect(await bus.read("Present_Position", "jaw", { normalize: false })).toBe(2500);
  });

  test("lost and corrupt answers are retried, a missing servo is not found", async () => {
    const { clock, chain, bus } = await connected();
    chain.dropReplies = 1;
    await expect(bus.read("Present_Position", "pan")).rejects.toBeInstanceOf(FeetechCommError);
    chain.dropReplies = 1;
    const before = clock.now();
    expect(await bus.read("Present_Position", "jaw", { normalize: false, numRetry: 1 })).toBe(2500);
    expect(clock.now() - before).toBeCloseTo(50.11, 6); // one timeout of an 8-byte status packet at 1 Mbaud

    chain.corruptReplies = 2;
    expect(await bus.syncRead("Present_Position", null, { normalize: false, numRetry: 2 })).toEqual({ pan: 2047, jaw: 2500 });

    chain.absent.add(2);
    expect(await bus.ping("jaw")).toBeNull();
    expect(await bus.ping("pan")).toBe(777);
    const failure = await bus.syncRead("Present_Position", null, { numRetry: 1 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FeetechCommError);
    expect((failure as FeetechCommError).result).toBe(COMM_RX_TIMEOUT);
    expect((failure as Error).message).toBe(
      "Failed to sync read 'Present_Position' on ids=[1, 2] after 2 tries. [TxRxResult] There is no status packet!",
    );
  });

  test("a servo's Status comes back with every answer", async () => {
    const { chain, bus } = await connected();
    chain.servo(1).set("Status", 0x20);
    const failure = await bus.read("Present_Position", "pan").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FeetechStatusError);
    expect((failure as FeetechStatusError).error).toBe(0x20);
    expect(await bus.syncRead("Status", null, { normalize: false })).toEqual({ pan: 0x20, jaw: 0 });
  });

  test("calls made at once take their turn on the line", async () => {
    const { chain, bus } = await connected();
    const outcomes = await Promise.all([
      bus.syncRead("Present_Position", null, { normalize: false }),
      bus.write("Goal_Position", "jaw", 2400, { normalize: false }),
      bus.read("Goal_Position", "jaw", { normalize: false }),
      bus.ping("pan"),
    ]);
    expect(outcomes).toEqual([{ pan: 2047, jaw: 2500 }, undefined, 2400, 777]);
    // each packet's answer was read before the next packet left
    const instructions = chain.received.slice(-5).map((packet) => packet[4]);
    expect(instructions).toEqual([0x82, 3, 2, 1, 2]);
  });

  test("the line is closed by disconnect, with torque off", async () => {
    const { chain, bus } = await connected();
    await bus.enableTorque();
    await bus.disconnect();
    expect(chain.isClosed).toBe(true);
    expect(bus.isConnected).toBe(false);
    expect([chain.servo(1).torqueEnabled, chain.servo(2).torqueEnabled]).toEqual([false, false]);
  });
});
