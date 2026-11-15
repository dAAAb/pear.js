import { describe, expect, test, vi } from "vitest";

import { FeetechMotorsBus } from "../../src/feetech/bus";
import { SimServo, SimServoChain } from "../../src/feetech/sim";
import type { RegisterName } from "../../src/feetech/tables";
import { ManualClock, type Transport } from "../../src/feetech/transport";
import { armFeedback, ServoFault, type SO101ArmState } from "../../src/so101/hardware/arm_state";
import { SO101Hardware } from "../../src/so101/hardware/arms";
import {
  DEFAULT_FOLLOWER_CONFIG,
  parseCalibration,
  serializeCalibration,
  SO101Follower,
} from "../../src/so101/hardware/follower";
import { followerMotors, GRIPPER_INDEX, JOINTS, MOTORS, VECTOR_LENGTH } from "../../src/so101/hardware/motors";
import { simulatedArm } from "../../src/so101/hardware/sim";
import { GRIPPER_LOAD_BITS, servoFaults, STATUS_BITS } from "../../src/so101/hardware/startup";
import {
  calibrationOf,
  expectError,
  expectOutcome,
  fixture,
  type FixtureCalibration,
  type FixtureError,
  fixtureCalibrationOf,
  ReplayTransport,
  type Step,
} from "./helpers";

interface NormalizeFixture {
  joints: string[];
  motors: string[];
  cases: {
    name: string;
    calibration: FixtureCalibration;
    joint_offsets: number[];
    readings: { raw: Record<string, number>; normalized: Record<string, number>; position: number[] }[];
    commands: {
      target: number[];
      goal?: Record<string, number>;
      raw?: Record<string, number>;
      packet?: number[];
      error?: FixtureError;
    }[];
  }[];
  range_m100_100: {
    name: string;
    calibration: FixtureCalibration;
    rows: {
      raw: Record<string, number>;
      normalized: Record<string, number>;
      values: Record<string, number>;
      unnormalized: Record<string, number>;
    }[];
  }[];
  invalid: { calibration: FixtureCalibration; normalize: FixtureError; unnormalize: FixtureError };
}

interface ArmStateFixture {
  position: number[];
  velocity: number[];
  sampled_monotonic_s: number;
  sample_id: number;
  servo_status: Record<string, unknown>;
  feedback?: Record<string, unknown>;
}

interface SO101Fixture {
  port: string;
  motors: Record<string, { id: number; model: string; norm_mode: string }>;
  follower_config: Record<string, unknown>;
  calibration: FixtureCalibration;
  calibration_file: string;
  status_bits: Record<string, string>;
  gripper_load_bits: number;
  servo_faults: Record<string, string[][]>;
  servo_checks: { register: string; values: Record<string, number>; error: FixtureError | null }[];
  constants: Record<string, number>;
  hardware: { joint_offsets: number[]; status_poll_ticks: number; position_p_coefficient: number; state_timeout_s: number };
  monotonic: { start_s: number; step_s: number };
  feedback_delay_s: number;
  feedback_every: number;
  sessions: { name: string; registers: Record<string, number[]>; steps: Step[] }[];
}

const normalization = fixture<NormalizeFixture>("normalize.json");
const reference = fixture<SO101Fixture>("so101.json");

const noTransport: Transport = {
  write: async () => undefined,
  read: async () => new Uint8Array(0),
  close: async () => undefined,
};

const idsOf = (values: Record<string, number>): Map<number, number> =>
  new Map(Object.entries(values).map(([motor, value]) => [followerMotors()[motor as "gripper"].id, value]));

const namesOf = (values: Map<number, number>): Record<string, number> =>
  Object.fromEntries([...values].map(([id, value]) => [MOTORS[id - 1], value]));

describe("the arm's servos are lerobot's follower's", () => {
  test("names, ids, units and settings", () => {
    expect(JOINTS).toEqual(normalization.joints);
    expect(MOTORS).toEqual(normalization.motors);
    expect(VECTOR_LENGTH).toBe(reference.constants.vector_length);
    expect(GRIPPER_INDEX).toBe(reference.constants.gripper_index);

    const motors = Object.fromEntries(
      Object.entries(followerMotors()).map(([motor, { id, normMode }]) => [motor, { id, model: "sts3215", norm_mode: normMode }]),
    );
    expect(motors).toEqual(reference.motors);
    expect(Object.keys(motors)).toEqual(Object.keys(reference.motors));
    expect({
      use_degrees: DEFAULT_FOLLOWER_CONFIG.useDegrees,
      position_p_coefficient: DEFAULT_FOLLOWER_CONFIG.positionPCoefficient,
      position_i_coefficient: DEFAULT_FOLLOWER_CONFIG.positionICoefficient,
      position_d_coefficient: DEFAULT_FOLLOWER_CONFIG.positionDCoefficient,
      disable_torque_on_disconnect: DEFAULT_FOLLOWER_CONFIG.disableTorqueOnDisconnect,
    }).toEqual(Object.fromEntries(Object.entries(reference.follower_config).filter(([name]) => name !== "num_read_retries")));
    expect(followerMotors(false).elbow_flex.normMode).toBe("range_m100_100");

    expect(SO101Hardware.ENABLE_ATTEMPTS).toBe(reference.constants.enable_attempts);
    expect(SO101Hardware.BUS_RETRIES).toBe(reference.constants.bus_retries);
    expect(SO101Hardware.RUN_RETRIES).toBe(reference.constants.run_retries);
  });

  test("lerobot's calibration file is read and written", () => {
    const calibration = parseCalibration(reference.calibration_file);
    expect(fixtureCalibrationOf(calibration)).toEqual(reference.calibration);
    expect(Object.keys(calibration)).toEqual(Object.keys(reference.calibration));
    expect(serializeCalibration(calibration)).toBe(reference.calibration_file);

    expect(() => parseCalibration("[]")).toThrow(TypeError);
    expect(() => parseCalibration('{"gripper": {"id": 6, "drive_mode": 0, "homing_offset": 1.5, "range_min": 0, "range_max": 1}}')).toThrow(
      "homing_offset is not an integer",
    );
    expect(() => parseCalibration('{"gripper": {"id": 6, "drive_mode": 0, "range_min": 0, "range_max": 1}}')).toThrow(TypeError);
  });
});

describe("positions are lerobot's degrees and percent and PEAR's joint vector", () => {
  for (const { name, calibration, joint_offsets, readings, commands } of normalization.cases) {
    test(`${name}: ${readings.length} readings`, () => {
      const bus = new FeetechMotorsBus(noTransport, followerMotors(), calibrationOf(calibration));
      for (const { raw, normalized, position } of readings) {
        const values = namesOf(bus.normalize(idsOf(raw)));
        expect([raw, values]).toEqual([raw, normalized]);
        expect([raw, SO101Hardware.busPosition(values, joint_offsets)]).toEqual([raw, position]);
      }
    });

    test(`${name}: ${commands.length} commands`, async () => {
      const clock = new ManualClock();
      const chain = simulatedArm(calibrationOf(calibration), {}, { clock });
      const follower = new SO101Follower(chain, calibrationOf(calibration), {}, { clock });
      const hardware = await SO101Hardware.open(follower, { jointOffsets: joint_offsets, statusPollTicks: 10, stateTimeoutS: 0.2 });
      const syncWrite = vi.spyOn(follower.bus, "syncWrite");

      let sent = 0;
      for (const { target, goal, raw, packet, error } of commands) {
        if (error !== undefined) {
          expectError(await hardware.send(target).catch((thrown: unknown) => thrown), error);
          continue;
        }
        await hardware.send(target);
        sent += 1;
        expect(syncWrite).toHaveBeenCalledTimes(sent);
        expect([target, syncWrite.mock.lastCall?.[1]]).toEqual([target, goal]); // degrees and percent
        expect([target, namesOf(follower.bus.unnormalize(idsOf(goal as Record<string, number>)))]).toEqual([target, raw]);
        expect([target, Array.from(chain.received.at(-1) as Uint8Array)]).toEqual([target, packet]);
      }
      expect(sent).toBe(16);
      await expect(hardware.send([0, 0, 0, 0, Number.NaN, 0])).rejects.toThrow("Expected a finite 6D target");
    });
  }

  test("the joints from -100 to 100, lerobot's other unit", () => {
    let rowCount = 0;
    for (const { name, calibration, rows } of normalization.range_m100_100) {
      const bus = new FeetechMotorsBus(noTransport, followerMotors(false), calibrationOf(calibration));
      for (const { raw, normalized, values, unnormalized } of rows) {
        expect([name, raw, namesOf(bus.normalize(idsOf(raw)))]).toEqual([name, raw, normalized]);
        expect([name, values, namesOf(bus.unnormalize(idsOf(values)))]).toEqual([name, values, unnormalized]);
        rowCount += 1;
      }
    }
    expect(rowCount).toBe(40);
  });

  test("a range of no width is refused", () => {
    const { calibration, normalize, unnormalize } = normalization.invalid;
    const bus = new FeetechMotorsBus(noTransport, followerMotors(), calibrationOf(calibration));
    expect(() => bus.normalize(new Map([[6, 2000]]))).toThrow(new RangeError(normalize.message));
    expect(() => bus.unnormalize(new Map([[6, 2000]]))).toThrow(new RangeError(unnormalize.message));
  });
});

describe("a servo's Status is read as PEAR reads it", () => {
  test("the bits that stop the arm, for an arm joint and for the gripper", () => {
    expect(Object.fromEntries([...STATUS_BITS].map(([bit, name]) => [String(bit), name]))).toEqual(reference.status_bits);
    expect(GRIPPER_LOAD_BITS).toBe(reference.gripper_load_bits);
    for (const [motor, faults] of Object.entries(reference.servo_faults)) {
      expect(faults.length).toBe(256);
      faults.forEach((expected, value) => expect([motor, value, servoFaults({ [motor]: value })]).toEqual([motor, value, expected]));
    }
  });

  test("the faults of the whole arm", () => {
    for (const { register, values, error } of reference.servo_checks) {
      const check = register === "status" ? SO101Hardware.checkStatus : SO101Hardware.checkTorque;
      if (error === null) {
        expect(() => check(values)).not.toThrow();
      } else {
        expect(() => check(values)).toThrow(new ServoFault(error.message));
      }
    }
    expect(reference.servo_checks.filter(({ error }) => error !== null).length).toBeGreaterThan(4);
  });
});

/** What a session's steps run on: the arm, once it is open, and the clock PEAR's process would read. */
class Session {
  hardware: SO101Hardware | null = null;
  private monotonicCalls = 0;

  constructor(
    readonly transport: Transport,
    readonly clock: ManualClock,
  ) {}

  /** The fixture script's clock: every call is a fixed step later. */
  readonly monotonic = (): number => reference.monotonic.start_s + reference.monotonic.step_s * this.monotonicCalls++;

  async run(step: Step): Promise<unknown> {
    if (step.op === "open") {
      const follower = new SO101Follower(
        this.transport,
        calibrationOf(reference.calibration),
        { positionPCoefficient: reference.hardware.position_p_coefficient },
        { port: reference.port, clock: this.clock },
      );
      if (this.transport instanceof ReplayTransport) this.transport.portHandler = follower.bus.portHandler;
      this.hardware = await SO101Hardware.open(follower, {
        jointOffsets: reference.hardware.joint_offsets,
        statusPollTicks: reference.hardware.status_poll_ticks,
        stateTimeoutS: reference.hardware.state_timeout_s,
        monotonic: this.monotonic,
      });
      return null;
    }

    const hardware = this.hardware;
    if (hardware === null) throw new Error(`${step.op} before the arm is open`);
    switch (step.op) {
      case "read":
        return stateOf(await hardware.read());
      case "read_for_recovery":
        return stateOf(await hardware.readForRecovery());
      case "send":
        return hardware.send(step.args.target as number[]);
      case "close":
        return hardware.close();
      default:
        throw new Error(`The fixture holds an operation this test does not know: ${step.op}`);
    }
  }
}

function stateOf(state: SO101ArmState): ArmStateFixture {
  const reading: ArmStateFixture = {
    position: state.position,
    velocity: state.velocity,
    sampled_monotonic_s: state.sampledMonotonicS,
    sample_id: state.sampleId as number,
    servo_status: state.servoStatus as Record<string, unknown>,
  };
  // the fixture holds the feedback of one reading in a few
  if ((state.sampleId as number) % reference.feedback_every === 1) {
    const feedback = armFeedback(state, state.sampledMonotonicS + reference.feedback_delay_s);
    reading.feedback = feedback as unknown as Record<string, unknown>;
  }

  return reading;
}

describe("the arm does on the bus what PEAR's SO101Hardware does", () => {
  for (const { name, steps } of reference.sessions) {
    const operations = steps.filter(({ op }) => op !== "poke");
    const packets = operations.reduce((count, step) => count + (step.exchanges?.length ?? 0), 0);

    test(`${name}: ${operations.length} operations, ${packets} packets`, async () => {
      const clock = new ManualClock();
      const transport = new ReplayTransport(clock);
      const session = new Session(transport, clock);

      for (const [index, step] of operations.entries()) {
        transport.expect(step.exchanges ?? []);
        try {
          await expectOutcome(step, () => session.run(step));
          transport.verify();
        } catch (error) {
          throw new Error(`Step ${index} (${step.op}): ${(error as Error).message}`, { cause: error });
        }
      }
    });
  }

  test("the sessions hold the faults an arm meets", () => {
    const messages = reference.sessions.flatMap(({ steps }) => steps.flatMap((step) => (step.error === undefined ? [] : [step.error.message])));
    for (const expected of [
      "Servo error: elbow_flex: overload",
      "Servo torque is off: wrist_roll",
      "Hardware is closed",
      "Servo calibration registers differ from the calibration file",
    ]) {
      expect(messages).toContain(expected);
    }
    expect(messages.some((message) => message.startsWith("Failed to sync read 'Present_Position'"))).toBe(true);
    expect(messages.some((message) => message.startsWith("Failed to write 'Torque_Enable' on id_=3"))).toBe(true);
  });
});

describe("the simulated servos answer PEAR's traffic as the fixture script's do", () => {
  // the two are written apart, in Python and in TypeScript, to the same few rules; the reference's own packets
  // go through both
  const sessions = reference.sessions.filter(({ steps }) => steps.every((step) => step.faults === undefined));

  test(`${sessions.length} sessions without a broken line`, async () => {
    let packets = 0;
    for (const { name, registers, steps } of sessions) {
      const chain = new SimServoChain(
        Object.entries(registers).map(([id, bytes]) => {
          const servo = new SimServo(Number(id));
          servo.load(bytes);
          return servo;
        }),
        { clock: new ManualClock() },
      );

      for (const [index, step] of steps.entries()) {
        if (step.op === "poke") {
          const { id, register, value } = step.args as { id: number; register: RegisterName; value: number };
          chain.servo(id).set(register, value);
        }
        for (const { tx, rx } of step.exchanges ?? []) {
          await chain.write(Uint8Array.from(tx));
          expect([name, index, tx, Array.from(await chain.read(4096, 0))]).toEqual([name, index, tx, rx]);
          packets += 1;
        }
      }
    }
    expect(sessions.length).toBeGreaterThan(3);
    expect(packets).toBeGreaterThan(300);
  });

  test("the arm runs a whole session on them", async () => {
    const [{ registers, steps }] = reference.sessions;
    const clock = new ManualClock();
    const chain = new SimServoChain(
      Object.entries(registers).map(([id, bytes]) => {
        const servo = new SimServo(Number(id));
        servo.load(bytes);
        return servo;
      }),
      { clock },
    );
    const session = new Session(chain, clock);

    for (const [index, step] of steps.entries()) {
      if (step.op === "poke") {
        const { id, register, value } = step.args as { id: number; register: RegisterName; value: number };
        chain.servo(id).set(register, value);
        continue;
      }
      try {
        await expectOutcome(step, () => session.run(step));
      } catch (error) {
        throw new Error(`Step ${index} (${step.op}): ${(error as Error).message}`, { cause: error });
      }
    }
    expect(chain.isClosed).toBe(true);
    expect([...chain.servos.values()].map((servo) => servo.torqueEnabled)).toEqual(MOTORS.map(() => false));
  });
});
