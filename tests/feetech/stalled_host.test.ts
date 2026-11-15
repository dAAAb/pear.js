// What the bus does when an answer comes late: docs/progress/station-reference.md, "Found: a stalled control
// thread leaves the Feetech SDK one answer behind". A host that does not run for longer than a packet's timeout
// while it waits finds its time up although the answer has arrived; the SDK then gives up, its retry reads the
// late answer, and the retry's own answer stays in an input the SDK never empties. Here the bus must take the
// answer that is there, and must not keep one that came too late (docs/progress/feetech.md, "Deliberate
// differences").

import { describe, expect, test } from "vitest";

import { FeetechMotorsBus } from "../../src/feetech/bus";
import type { SimServoChain } from "../../src/feetech/sim";
import type { RegisterName } from "../../src/feetech/tables";
import { ManualClock } from "../../src/feetech/transport";
import { SO101Hardware } from "../../src/so101/hardware/arms";
import { SO101Follower } from "../../src/so101/hardware/follower";
import { followerMotors, MOTORS, type MotorName } from "../../src/so101/hardware/motors";
import { simulatedArm } from "../../src/so101/hardware/sim";
import { servoFaults } from "../../src/so101/hardware/startup";
import {
  calibrationOf,
  expectOutcome,
  fixture,
  type FixtureCalibration,
  fixtureCalibrationOf,
  LateAnswerTransport,
  ReplayTransport,
  type Step,
} from "./helpers";

interface ArmFixture {
  calibration: FixtureCalibration;
  hardware: { joint_offsets: number[]; status_poll_ticks: number; state_timeout_s: number };
}

const reference = fixture<ArmFixture>("so101.json");
const CALIBRATION = calibrationOf(reference.calibration);
const PERIOD_MS = 20; // between two reads of the arm, as PEAR's loop has it
const NO_STATUS = Object.fromEntries(MOTORS.map((motor) => [motor, 0]));

// Where the servos stand before the first read, steps. Every read finds each one step further, so that a reading
// tells which read's answer it is.
const START: Record<MotorName, number> = {
  shoulder_pan: 2051,
  shoulder_lift: 912,
  elbow_flex: 3101,
  wrist_flex: 2790,
  wrist_roll: 2040,
  gripper: 2060,
};

function stepsAt(tick: number): Record<string, number> {
  return Object.fromEntries(MOTORS.map((motor) => [motor, START[motor] + tick]));
}

/** Puts the arm where it stands at the read ``tick``. */
function place(chain: SimServoChain, tick: number): void {
  for (const motor of MOTORS) chain.servo(followerMotors()[motor].id).position = START[motor] + tick;
}

/** Returns how many reads old ``matches`` finds a reading taken at the read ``tick``: 0 for the arm as it stands
 * then, 1 for the arm as the read before found it; null for what is no reading of the arm at all. */
function ageAt(tick: number, matches: (earlier: number) => boolean): number | null {
  for (let age = 0; age <= tick; age++) if (matches(tick - age)) return age;

  return null;
}

async function arm(): Promise<{ clock: ManualClock; chain: SimServoChain; line: LateAnswerTransport }> {
  const clock = new ManualClock();
  const chain = simulatedArm(CALIBRATION, START, { clock });

  return { clock, chain, line: new LateAnswerTransport(chain, clock) };
}

describe("the bus when an answer comes late", () => {
  const steps = { normalize: false };
  const stepsWithARetry = { normalize: false, numRetry: SO101Hardware.RUN_RETRIES };

  async function connected(): Promise<{ clock: ManualClock; chain: SimServoChain; line: LateAnswerTransport; bus: FeetechMotorsBus }> {
    const { clock, chain, line } = await arm();
    const bus = new FeetechMotorsBus(line, followerMotors(), CALIBRATION, { clock });
    await bus.connect();

    return { clock, chain, line, bus };
  }

  /** Reads the arm's positions at the reads 1 to 9, the answer to read 3 made late by ``makeLate``, then the
   * servos' Status and the positions once more; returns what a station would have seen. */
  async function nineReadsAndAPoll(makeLate: (line: LateAnswerTransport) => void): Promise<Record<string, unknown>> {
    const { clock, chain, line, bus } = await connected();
    const packetsBefore = line.written.length;

    const ages: (number | null)[] = [];
    for (let tick = 1; tick <= 9; tick++) {
      place(chain, tick);
      if (tick === 3) makeLate(line);
      const read = await bus.syncRead("Present_Position", null, stepsWithARetry);
      ages.push(ageAt(tick, (earlier) => MOTORS.every((motor) => read[motor] === START[motor] + earlier)));
      await clock.sleep(PERIOD_MS);
    }
    const status = await bus.syncRead("Status", null, stepsWithARetry);
    place(chain, 10);
    const last = await bus.syncRead("Present_Position", null, stepsWithARetry);

    return {
      ages,
      status,
      faults: servoFaults(status),
      last,
      packets: line.written.length - packetsBefore,
      waiting: line.waitingLength,
    };
  }

  test("an answer that came while the host was stalled is taken, without a retry", async () => {
    const { clock, chain, line, bus } = await connected();
    const packetsBefore = line.written.length;

    // six servos through one packet: the six answers are given 50.51 ms together, the host is away for 100
    place(chain, 1);
    line.stallNextAnswer();
    const before = clock.now();
    expect(await bus.syncRead("Present_Position", null, steps)).toEqual(stepsAt(1));
    expect(clock.now() - before).toBe(100);

    // one servo by itself, and a write, whose answer says only that it was taken
    place(chain, 2);
    line.stallNextAnswer();
    expect(await bus.read("Present_Position", "gripper", steps)).toBe(START.gripper + 2);
    line.stallNextAnswer();
    await bus.write("Goal_Position", "gripper", START.gripper, steps);
    expect(await bus.read("Goal_Position", "gripper", steps)).toBe(START.gripper);

    expect(line.written.length - packetsBefore).toBe(4); // nothing was asked twice
    expect(line.waitingLength).toBe(0);
  });

  test("after a stalled read every reading is the arm's own, and no servo reports a fault it does not have", async () => {
    expect(await nineReadsAndAPoll((line) => line.stallNextAnswer())).toEqual({
      ages: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      status: NO_STATUS,
      faults: [],
      last: stepsAt(10),
      packets: 11, // nine reads, the poll and the last read: none asked twice
      waiting: 0,
    });
  });

  test("an answer that comes after the bus has given up on it is not kept for the next read", async () => {
    // the look made when the time was up found nothing, so the read was tried again: the retry took the slow
    // answer, which holds the arm as it still stands, and the retry's own answer is the one that is dropped
    expect(await nineReadsAndAPoll((line) => line.delayNextAnswer())).toEqual({
      ages: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      status: NO_STATUS,
      faults: [],
      last: stepsAt(10),
      packets: 12, // one retry
      waiting: 0,
    });
  });

  test("a slow answer to a read that is not tried again is taken once for the next read's, and nothing stays behind", async () => {
    // no look and no emptying can know of bytes that arrive after the next instruction packet has left, and a
    // status packet does not say which instruction it answers: this much of the SDK's behaviour remains
    const { clock, chain, line, bus } = await connected();
    const ages: (number | string | null)[] = [];
    for (let tick = 1; tick <= 6; tick++) {
      place(chain, tick);
      if (tick === 3) line.delayNextAnswer();
      const read = await bus.syncRead("Present_Position", null, steps).catch((error: Error) => error.message);
      ages.push(
        typeof read === "string" ? read : ageAt(tick, (earlier) => MOTORS.every((motor) => read[motor] === START[motor] + earlier)),
      );
      await clock.sleep(PERIOD_MS);
    }

    expect(ages).toEqual([
      0,
      0,
      "Failed to sync read 'Present_Position' on ids=[1, 2, 3, 4, 5, 6] after 1 tries. [TxRxResult] There is no status packet!",
      1,
      0,
      0,
    ]);
    expect(await bus.syncRead("Status", null, steps)).toEqual(NO_STATUS);
    expect(line.waitingLength).toBe(0);
  });
});

describe("the arm when an answer comes late", () => {
  /** Opens PEAR's arm on the line and reads it twelve times, the answer to the position read 7 made late by
   * ``makeLate``: read 10 polls the servos' Status. Returns each read's age, or the error it ended with. */
  async function twelveReads(makeLate: (line: LateAnswerTransport) => void): Promise<(number | string | null)[]> {
    const { clock, chain, line } = await arm();
    const follower = new SO101Follower(line, CALIBRATION, {}, { clock });
    const offsets = reference.hardware.joint_offsets;
    const hardware = await SO101Hardware.open(follower, {
      jointOffsets: offsets,
      statusPollTicks: reference.hardware.status_poll_ticks,
      stateTimeoutS: reference.hardware.state_timeout_s,
      monotonic: () => clock.now() / 1000,
    });
    const jointsAt = (tick: number): number[] => {
      const degrees = follower.bus.normalize(new Map(MOTORS.map((motor) => [followerMotors()[motor].id, START[motor] + tick])));

      return SO101Hardware.busPosition(
        Object.fromEntries(MOTORS.map((motor) => [motor, degrees.get(followerMotors()[motor].id) as number])),
        offsets,
      );
    };

    const seen: (number | string | null)[] = [];
    for (let tick = 1; tick <= 12; tick++) {
      place(chain, tick);
      if (tick === 7) makeLate(line);
      try {
        const { position, servoStatus } = await hardware.read();
        const age = ageAt(tick, (earlier) => jointsAt(earlier).every((joint, index) => joint === position[index]));
        seen.push(tick === 10 && JSON.stringify(servoStatus.status) !== JSON.stringify(NO_STATUS) ? "a Status that no servo has" : age);
      } catch (error) {
        seen.push(`${(error as Error).name}: ${(error as Error).message}`);
      }
      await clock.sleep(PERIOD_MS);
    }
    expect(reference.hardware.status_poll_ticks).toBe(10);

    return seen;
  }

  test("a stalled read leaves the arm's readings and its servos' Status as they are", async () => {
    expect(await twelveReads((line) => line.stallNextAnswer())).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test("so does an answer that comes after the read was tried again", async () => {
    expect(await twelveReads((line) => line.delayNextAnswer())).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

interface BusFixture {
  port: string;
  calibration: FixtureCalibration;
  scenarios: { name: string; steps: Step[] }[];
}

/** Runs on ``bus`` the operation of lerobot's bus that a recording names, as tests/feetech/bus.test.ts does. */
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
      throw new Error(`The recording holds an operation this test does not know: ${op}`);
  }
}

// tests/feetech/bus.test.ts replays lerobot's bus on the SDK with the SDK's way of reading the line, in which a
// late answer waits for the next read. Here the same recordings meet the bus as it is by itself.
describe("the SDK's recordings, with what waits in the input discarded", () => {
  test("every packet sent is the SDK's; three outcomes are not, where the SDK answers with an answer that came late", async () => {
    const recorded = fixture<BusFixture>("bus.json");
    const differences: string[] = [];
    let operations = 0;
    let packets = 0;

    for (const scenario of recorded.scenarios) {
      const clock = new ManualClock();
      const transport = new ReplayTransport(clock, false);
      const calibration = scenario.name === "no calibration" ? null : calibrationOf(recorded.calibration);
      const bus = new FeetechMotorsBus(transport, followerMotors(), calibration, { port: recorded.port, clock });
      transport.portHandler = bus.portHandler;
      expect(bus.portHandler.discardsInput).toBe(true);

      for (const [index, step] of scenario.steps.filter(({ op }) => op !== "poke").entries()) {
        transport.expect(step.exchanges ?? []);
        operations += 1;
        packets += step.exchanges?.length ?? 0;

        let result: unknown;
        let thrown: unknown;
        try {
          result = await operate(bus, step.op, step.args);
        } catch (error) {
          thrown = error;
        }
        try {
          await expectOutcome(step, async () => {
            if (thrown !== undefined) throw thrown;
            return result;
          });
        } catch {
          const here = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : JSON.stringify(result);
          const there = step.error === undefined ? JSON.stringify(step.result) : `${step.error.type}: ${step.error.message}`;
          differences.push(`${scenario.name}, step ${index}, ${step.op}: the SDK ${there}; here ${here}`);
        }
        try {
          transport.verify();
        } catch {
          differences.push(`${scenario.name}, step ${index}, ${step.op}: ${transport.problems.join("; ")}`);
          transport.problems.length = 0;
        }
      }
    }

    // The recording has two echoes (steps 74 and 96), each taken for an answer, which leaves the servo's own
    // answer in the input. The SDK answers what follows one answer late: a read with the value read before, where
    // the servo now reports an error (77); a read with the write's answer, which holds no value (97); a write
    // with the read's answer, where the servo reports an error (98). Here each gets the answer to its own packet
    expect(differences).toEqual([
      "operations, step 77, read: the SDK 2040; here RuntimeError: Failed to read 'Present_Position' on id_=5 after 1 tries. [RxPacketError] Input voltage error!",
      "operations, step 97, read: the SDK IndexError: list index out of range; here 2000",
      "operations, step 98, write: the SDK null; here RuntimeError: Failed to write 'Goal_Position' on id_=5 with '2000' after 1 tries. [RxPacketError] OverEle error!",
    ]);
    expect([recorded.scenarios.length, operations, packets]).toEqual([8, 176, 533]);
  });
});
