// The modules were ported separately; these tests hold them to one definition of what they share.
import { describe, expect, test } from "vitest";

import * as agentPrintable from "../src/agent/clients/python_printable";
import * as agentRepr from "../src/agent/clients/python_repr";
import * as agentExceptions from "../src/agent/exceptions";
import * as agentRobot from "../src/agent/robot";
import { PEAR_COMMIT, agent, feetech, protocol, python, ruckig, so101, station } from "../src/index";
import * as protocolFloat from "../src/protocol/python_float";
import * as protocolJson from "../src/protocol/python_json";
import * as protocolText from "../src/protocol/python_text";
import * as pythonRepr from "../src/python/repr";
import * as kinematicsErrors from "../src/so101/kinematics/errors";
import * as kinematicsText from "../src/so101/kinematics/text";
import * as jointErrors from "../src/station/joint/errors";
import * as jointNumeric from "../src/station/joint/numeric";
import { calibrationOf, expectOutcome, fixture, ReplayTransport, type FixtureCalibration, type Step } from "./feetech/helpers";
import { meta as jointMeta } from "./station-joint/fixtures";

const { SO101Kinematics, UnreachablePoseError } = so101.kinematics;

// inside PEAR's default limits, near the pose PEAR calls Home; the gripper open
const JOINTS = [0.0, -0.8, 0.1, 1.4, -1.6, 1.0];

describe("the modules agree on what they share", () => {
  test("the package's entry gives the modules and the pinned commit", () => {
    expect(PEAR_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof protocol.turnText).toBe("function");
    expect(typeof feetech.FeetechMotorsBus).toBe("function");
    expect(typeof so101.kinematics.SO101Kinematics).toBe("function");
    expect(typeof so101.hardware.SO101Hardware).toBe("function");
    expect(typeof so101.joint.SO101FrictionFeedforward).toBe("function");
    expect(typeof ruckig.Ruckig).toBe("function");
    expect(typeof station.joint.StabilityWindow).toBe("function");
    expect(typeof station.schemas).toBe("object");
    expect(typeof agent.StationAgentLoop).toBe("function");
    expect(typeof agent.VLLMClient).toBe("function");
  });

  test("the kinematics' joint limits are the joint layer's", () => {
    expect(so101.kinematics.JointLimits).toBe(station.joint.JointLimits);
  });

  test("the servo layer's joints are the layout's own", () => {
    expect(so101.hardware.MOTORS).toBe(so101.MOTORS);
    expect(so101.hardware.JOINTS).toBe(so101.JOINTS);
    expect(so101.hardware.GRIPPER_INDEX).toBe(so101.GRIPPER_INDEX);
    expect(Object.keys(so101.hardware.followerMotors())).toEqual([...so101.MOTORS]);
  });

  test("the kinematics read and round the quantities the protocol shows", () => {
    expect(SO101Kinematics.ARM_QUANTITIES).toBe(protocol.ARM_QUANTITIES);
    expect(SO101Kinematics.DECIMALS).toBe(protocol.DECIMALS);

    const state = new SO101Kinematics().quantities(JOINTS);

    // what the kinematics give is already what a turn shows: rounding it again changes nothing
    expect(protocol.shownState(state)).toEqual(state);
    expect(protocol.turnText(state)).toContain(`"gripper": {"width": ${state.gripper.width.toFixed(1)}}`);
  });

  test("a parsed answer is an action the kinematics take, and an unreachable one fails under the protocol's name", () => {
    const kinematics = new SO101Kinematics();
    const answer = (z: number) =>
      "Lower the fingertip.\n\n```json\n" +
      `{"arm": {"x": 0, "y": 0, "z": ${z}, "pitch": 0, "roll": 0}, "gripper": {"width": 0}}` +
      "\n```";

    const goal = kinematics.jointTarget(JOINTS, protocol.parseAction(answer(-2)));
    expect(goal).toHaveLength(so101.VECTOR_LENGTH);
    expect(goal[so101.GRIPPER_INDEX]).toBe(JOINTS[so101.GRIPPER_INDEX]); // the gripper's part moves no joint

    let failure: unknown;
    try {
      kinematics.jointTarget(JOINTS, protocol.parseAction(answer(90)));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(UnreachablePoseError);
    expect((failure as Error).name).toBe(protocol.UNREACHABLE_POSE_ERROR);

    // the message the kinematics give is what the model reads of a rejected action
    const feedback = protocol.executionFeedback(
      {
        status: protocol.MotionStatus.REJECTED,
        isSettled: true,
        targetReached: false,
        measuredPosition: JOINTS,
        trackingError: null,
        measuredState: kinematics.quantities(JOINTS),
        gripperOutcome: null,
        error: { code: (failure as Error).name, message: (failure as Error).message },
      },
      { isDispatched: false },
    );
    expect(feedback).toContain("out_of_reach");
    expect(feedback).toContain((failure as Error).message);
  });
});

/** Every value the package's entry gives, with the path that leads to it: a namespace is walked into. */
function exportedValues(namespace: object, path: string, found: Array<[string, unknown]> = []): Array<[string, unknown]> {
  for (const [name, value] of Object.entries(namespace)) {
    found.push([`${path}.${name}`, value]);
    if (typeof value === "object" && value !== null && Object.prototype.toString.call(value) === "[object Module]") {
      exportedValues(value, `${path}.${name}`, found);
    }
  }

  return found;
}

describe("the modules share one set of Python exceptions", () => {
  const library = { agent, feetech, protocol, python, ruckig, so101, station };

  test("a built-in exception is one class, whichever module gives it", () => {
    // by the module's entry
    expect(agent.ValueError).toBe(python.ValueError);
    expect(so101.kinematics.ValueError).toBe(python.ValueError);
    expect(station.joint.ValueError).toBe(python.ValueError);
    expect(agent.RuntimeError).toBe(python.RuntimeError);
    expect(station.joint.RuntimeError).toBe(python.RuntimeError);
    expect(agent.TimeoutError).toBe(python.TimeoutError);
    expect(station.joint.TimeoutError).toBe(python.TimeoutError);
    expect(station.joint.PythonTypeError).toBe(python.PythonTypeError);
    expect(station.joint.ZeroDivisionError).toBe(python.ZeroDivisionError);
    expect(station.joint.IndexError).toBe(python.IndexError);
    expect(agent.PythonException).toBe(python.PythonException);
    // by the file each module kept for it
    expect(agentExceptions.ValueError).toBe(python.ValueError);
    expect(agentExceptions.RuntimeError).toBe(python.RuntimeError);
    expect(agentExceptions.TimeoutError).toBe(python.TimeoutError);
    expect(agentExceptions.PythonException).toBe(python.PythonException);
    expect(jointErrors.ValueError).toBe(python.ValueError);
    expect(jointErrors.RuntimeError).toBe(python.RuntimeError);
    expect(jointErrors.TimeoutError).toBe(python.TimeoutError);
    expect(jointErrors.PythonTypeError).toBe(python.PythonTypeError);
    expect(jointErrors.ZeroDivisionError).toBe(python.ZeroDivisionError);
    expect(jointErrors.IndexError).toBe(python.IndexError);
    expect(kinematicsErrors.ValueError).toBe(python.ValueError);
    expect(protocolJson.PythonError).toBe(python.PythonError);
  });

  test("PEAR's OperatorPaused is one class, the station's", () => {
    const { OperatorPaused } = station.exceptions;

    expect(agent.OperatorPaused).toBe(OperatorPaused);
    expect(station.joint.OperatorPaused).toBe(OperatorPaused);
    expect(agentExceptions.OperatorPaused).toBe(OperatorPaused);
    expect(jointErrors.OperatorPaused).toBe(OperatorPaused);
    expect(new OperatorPaused("paused")).toBeInstanceOf(python.RuntimeError);

    // a signal that was aborted is the operator's pause, for the agent's loop and for the joint layer alike
    const stop = new AbortController();
    expect(() => OperatorPaused.checkCancelled(stop.signal)).not.toThrow();
    expect(() => OperatorPaused.checkCancelled(null)).not.toThrow();
    stop.abort();
    expect(() => OperatorPaused.checkCancelled(stop.signal)).toThrow(agent.OperatorPaused);
    expect(() => OperatorPaused.checkCancelled({ aborted: true })).toThrow("Operation interrupted by the operator");
  });

  test("the helpers that read an error are the same functions everywhere", () => {
    expect(agent.isValueError).toBe(python.isValueError);
    expect(agent.pythonErrorName).toBe(python.pythonErrorName);
    expect(agent.pythonErrorMessage).toBe(python.pythonErrorMessage);
    expect(agent.motionErrorOf).toBe(python.motionErrorOf);
  });

  test("no module gives a class of its own under a Python exception's name", () => {
    const builtIns = new Map<string, unknown>(
      Object.entries(python).filter(([, value]) => typeof value === "function" && value.prototype instanceof Error),
    );
    expect(builtIns.size).toBeGreaterThan(20);

    const strangers = exportedValues(library, "pear")
      .filter(([, value]) => typeof value === "function" && (value as { prototype?: unknown }).prototype instanceof Error)
      .filter(([, value]) => builtIns.has((value as { name: string }).name))
      .filter(([, value]) => builtIns.get((value as { name: string }).name) !== value)
      .map(([path]) => path);
    expect(strangers).toEqual([]);
  });

  test("an error thrown in one module is the class another module asks for", () => {
    // the kinematics refuse a pose: the agent's loop sees a ValueError and rejects the turn
    let unreachable: unknown;
    try {
      new SO101Kinematics().jointTarget(JOINTS, { arm: { x: 0, y: 0, z: 90, pitch: 0, roll: 0 } });
    } catch (error) {
      unreachable = error;
    }
    expect(unreachable).toBeInstanceOf(UnreachablePoseError);
    expect(unreachable).toBeInstanceOf(agent.ValueError);
    expect(unreachable).toBeInstanceOf(station.joint.ValueError);
    expect(agent.isValueError(unreachable)).toBe(true);
    expect(agent.motionErrorOf(unreachable)).toEqual({
      code: protocol.UNREACHABLE_POSE_ERROR,
      message: (unreachable as Error).message,
    });

    // the layout refuses a vector with the joint layer's ValueError, which is the kinematics' and the agent's
    let refused: unknown;
    try {
      so101.LAYOUT.armVector([0, 0, 0]);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(so101.kinematics.ValueError);
    expect(refused).toBeInstanceOf(agent.ValueError);

    // the joint layer's own errors are RuntimeErrors for the agent too, and no ValueErrors
    const stability = new station.joint.StabilityError("The arm moved", {});
    expect(stability).toBeInstanceOf(agent.RuntimeError);
    expect(agent.isValueError(stability)).toBe(false);
    expect(agent.pythonErrorName(stability)).toBe("StabilityError");

    // the client's errors are the same classes for the joint layer
    expect(new agent.ContextLimit("full")).toBeInstanceOf(station.joint.ValueError);
    expect(new agent.SessionLost("lost")).toBeInstanceOf(station.joint.RuntimeError);
    expect(new agent.TimeoutError()).not.toBeInstanceOf(station.joint.RuntimeError);
  });
});

describe("the modules write a value as Python does with one set of functions", () => {
  test("Python's round is one function: the protocol's, the kinematics' and the library's", () => {
    expect(protocolFloat.pythonRound).toBe(python.pythonRound);
    expect(kinematicsText.pythonRound).toBe(python.pythonRound);
    expect(so101.kinematics.pythonRound).toBe(python.pythonRound);

    // what a turn shows and what the kinematics give are rounded by it: a tie goes to the even digit
    expect(protocol.shownQuantity(2.25, 1)).toBe(2.2);
    expect(protocol.shownQuantity(-0.04, 1)).toBe(0);
    expect(new SO101Kinematics().quantities(JOINTS)).toEqual(protocol.shownState(new SO101Kinematics().quantities(JOINTS)));
  });

  test("each of the other reproductions is one function, under its old path and under the library's", () => {
    expect(protocolFloat.pythonFloatRepr).toBe(python.pythonFloatRepr);
    expect(protocolJson.pythonJsonDumps).toBe(python.pythonJsonDumps);
    expect(protocolJson.pythonJsonLoads).toBe(python.pythonJsonLoads);
    expect(protocolText.pythonStrip).toBe(python.pythonStrip);
    expect(protocolText.isPythonBlank).toBe(python.isPythonBlank);
    expect(protocolText.PYTHON_WHITESPACE_CLASS).toBe(python.PYTHON_WHITESPACE_CLASS);
    expect(protocol.pythonStrip).toBe(python.pythonStrip);
    expect(kinematicsText.formatFixed).toBe(python.formatFixed);
    expect(kinematicsText.formatGeneral).toBe(python.formatGeneral);
    expect(kinematicsText.formatTemplate).toBe(python.formatTemplate);
    expect(so101.kinematics.formatFixed).toBe(python.formatFixed);
    expect(so101.kinematics.formatGeneral).toBe(python.formatGeneral);
    expect(so101.kinematics.formatTemplate).toBe(python.formatTemplate);
    expect(jointNumeric.pythonStr).toBe(python.pythonStr);
    expect(jointNumeric.pythonNumber).toBe(python.pythonNumber);
    expect(jointNumeric.pythonStrRepr).toBe(python.pythonStrRepr);
    expect(station.joint.pythonStr).toBe(python.pythonStr);
    expect(station.joint.pythonStrRepr).toBe(python.pythonStrRepr);
    expect(agentRepr.pythonStringRepr).toBe(python.pythonStringRepr);
    expect(agentRepr.pythonRepr).toBe(python.pythonRepr);
    expect(agentRepr.pythonValueOf).toBe(python.pythonValueOf);
    expect(agentRepr.pythonJsonDecode).toBe(python.pythonJsonDecode);
    expect(agentRepr.pythonDecodeUtf8).toBe(python.pythonDecodeUtf8);
    expect(agentRepr.pythonTruth).toBe(python.pythonTruth);
    expect(agentRepr.pythonTypeName).toBe(python.pythonTypeName);
    expect(agentRepr.plainOf).toBe(python.plainOf);
    expect(agentRepr.isPythonPrintable).toBe(python.isPythonPrintable);
    expect(agentPrintable.NOT_PRINTABLE_RUNS).toBe(python.NOT_PRINTABLE_RUNS);
  });

  test("str() exists twice on purpose: of a JavaScript value, and of a decoded JSON value", () => {
    // the joint layer's, of a value in a message: a whole number is one of PEAR's counts, an int
    expect(python.pythonStr(null)).toBe("None");
    expect(python.pythonStr(5)).toBe("5");
    expect(python.pythonStr(0.5)).toBe("0.5");
    // the client's, of what json.loads returned: Python knows the float 5.0 from the int 5
    expect(agentRepr.pythonStr).toBe(pythonRepr.pythonStr);
    expect(python.pythonValueStr).toBe(pythonRepr.pythonStr);
    expect(python.pythonValueStr({ type: "float", value: 5 })).toBe("5.0");
    expect(python.pythonValueStr({ type: "int", literal: "5" })).toBe("5");
    expect(python.pythonValueStr(python.pythonValueOf({ code: 400, message: "it's" }))).toBe(`{'code': 400, 'message': "it's"}`);
  });

  test("one function reads a float back the way every text of the library writes it", () => {
    const value = 0.1 + 0.2;

    expect(python.pythonFloatRepr(value)).toBe("0.30000000000000004");
    expect(python.pythonJsonDumps({ x: value })).toBe('{"x": 0.30000000000000004}');
    expect(python.pythonValueStr({ type: "float", value })).toBe("0.30000000000000004");
    expect(python.pythonStr(value)).toBe("0.30000000000000004");
    expect(python.pythonNumber(value)).toBe("0.30000000000000004");
    expect(python.formatFixed(value, 2)).toBe("0.30");
    expect(python.pythonRound(value, 2)).toBe(0.3);
  });
});

// ---- the SO-101's servo layer under the joint layer ----

const { SO101ArmState, SO101Driver, SO101Hardware, simulatedArm } = so101.hardware;

/** What these tests read of tests/fixtures/feetech/so101.json: PEAR's SO101Hardware, recorded on a scripted line. */
interface HardwareFixture {
  port: string;
  calibration: FixtureCalibration;
  hardware: { joint_offsets: number[]; status_poll_ticks: number; position_p_coefficient: number; state_timeout_s: number };
  monotonic: { start_s: number; step_s: number };
  feedback_delay_s: number;
  feedback_every: number;
  sessions: { name: string; steps: Step[] }[];
}

const recorded = fixture<HardwareFixture>("so101.json");
const ZEROS = [0, 0, 0, 0, 0, 0];

/** The settings of the recorded arm, as a station's file gives them over PEAR's defaults; it has no camera. */
function stationSettings(hardware: Partial<so101.HardwareConfig> | null = {}): so101.SO101Config {
  return {
    ...so101.SO101_DEFAULT_CONFIG,
    camera: null,
    hardware:
      hardware === null
        ? null
        : {
            ...so101.SO101_DEFAULT_CONFIG.hardware!,
            port: recorded.port,
            joint_offsets: recorded.hardware.joint_offsets,
            status_poll_ticks: recorded.hardware.status_poll_ticks,
            position_p_coefficient: recorded.hardware.position_p_coefficient,
            ...hardware,
          },
  };
}

/** The settings, checked, of a station that has the arm's calibration. */
function commissioned(settings: so101.SO101Config = stationSettings()): so101.SO101RobotConfig {
  return new so101.SO101RobotConfig(settings, { calibrationExists: () => true });
}

function controlConfig(): InstanceType<typeof station.joint.ControlConfig> {
  return new station.joint.ControlConfig({
    ...station.joint.DEFAULT_CONTROL_SETTINGS,
    state_timeout_s: recorded.hardware.state_timeout_s,
  });
}

/** An arm under the driver that hands its readings as plain data, and keeps what it was sent. */
function plainArm(): so101.hardware.ArmHardware & { sent: number[][]; isClosed: boolean } {
  const reading = () => ({
    position: [0.1, -0.2, 0.3, -0.4, 0.5, 0.5],
    velocity: [...ZEROS],
    sampledMonotonicS: 100,
    sampleId: 1,
    servoStatus: { torque: { gripper: 1 } },
  });
  const arm = {
    sent: [] as number[][],
    isClosed: false,
    read: async () => reading(),
    readForRecovery: async () => reading(),
    send: async (target: readonly number[]) => {
      arm.sent.push([...target]);
    },
    close: async () => {
      arm.isClosed = true;
    },
  };

  return arm;
}

describe("the SO-101's servo layer fits the joint layer", () => {
  test("an arm's reading is the joint layer's ArmState, with the servos' status", async () => {
    const clock = new feetech.ManualClock();
    const calibration = calibrationOf(recorded.calibration);
    const hardware = await SO101Hardware.fromConfig(controlConfig(), commissioned(), {
      transport: simulatedArm(calibration, {}, { clock }),
      calibration,
      busOptions: { clock },
      clock: { monotonic: () => 250 },
    });
    const state = await hardware.read();
    await hardware.close();

    expect(state).toBeInstanceOf(SO101ArmState);
    expect(state).toBeInstanceOf(station.joint.ArmState);
    expect(() => state.check(so101.LAYOUT)).not.toThrow();
    expect([state.position.length, state.sampledMonotonicS, state.sampleId]).toEqual([so101.VECTOR_LENGTH, 250, 1]);
    expect(Object.keys(state.servoStatus)).toEqual(["torque", "status", "polled_monotonic_s"]);

    // its feedback is the joint layer's, under PEAR's keys in PEAR's order, and the servos' status after them
    const feedback = state.feedback(250.5);
    const jointFeedback: station.schemas.ArmFeedback = feedback;
    expect(Object.keys(jointFeedback)).toEqual([...Object.keys(new station.joint.ArmState([0], [0], 0).feedback(0)), "servo"]);
    expect(feedback).toEqual({
      position: state.position,
      velocity: state.velocity,
      sampled_monotonic_s: 250,
      sample_id: 1,
      age_seconds: 0.5,
      servo: state.servoStatus,
    });
    expect(feedback.servo).not.toBe(state.servoStatus); // a copy: a snapshot keeps what was polled then
    expect(so101.hardware.armFeedback(state, 250.5)).toEqual(feedback);
    expect(station.joint.ArmState.isFresh(feedback.age_seconds, controlConfig().state_timeout_s)).toBe(false);

    // a reading that is no arm vector is refused by the joint layer's check, in the layout's words
    const broken = new SO101ArmState([0, 0, Number.NaN, 0, 0, 0.5], [...ZEROS], 1);
    expect(() => broken.check(so101.LAYOUT)).toThrow(python.ValueError);
    expect(() => broken.check(so101.LAYOUT)).toThrow("Expected 5 finite joint radians and 1 finite gripper opening");
  });

  test("a reading handed as plain data becomes a state, and a state stays the object it is", () => {
    const plain = { position: [0, 0, 0, 0, 0, 0.5], velocity: [...ZEROS], sampledMonotonicS: 3, sampleId: 7, servoStatus: {} };
    const adopted = SO101ArmState.of(plain);

    expect(adopted).toBeInstanceOf(station.joint.ArmState);
    expect(adopted).toEqual(plain);
    expect(() => adopted.check(so101.LAYOUT)).not.toThrow();
    expect(adopted.feedback(4)).toEqual({
      position: plain.position,
      velocity: plain.velocity,
      sampled_monotonic_s: 3,
      sample_id: 7,
      age_seconds: 1,
      servo: {},
    });
    expect(so101.hardware.armFeedback(plain, 4)).toEqual(adopted.feedback(4));

    const state = new SO101ArmState([0, 0, 0, 0, 0, 0.5], [...ZEROS], 3, 7, { status: { gripper: 0 } });
    expect(SO101ArmState.of(state)).toBe(state);
    // a state of another class of the joint layer's is taken as it is
    class OtherState extends station.joint.ArmState {}
    const other = new OtherState([0, 0, 0, 0, 0, 0.5], [...ZEROS], 3);
    expect(SO101ArmState.of(other as never)).toBe(other);
  });

  test("the SO-101's driver is the joint layer's JointDriver, on its limits and its clock", async () => {
    const arm = plainArm();
    const asked: number[] = [];
    const feedforward: so101.hardware.Feedforward = {
      holdOffset: () => [...ZEROS],
      offset: (_target, _velocity, nowS) => {
        asked.push(nowS);
        return [0, 0, 0, 0, 0, 0.25];
      },
    };
    const limits = commissioned().jointLimits();
    const clock = new station.joint.SteppedClock(100);
    const driver: InstanceType<typeof station.joint.JointDriver> = new SO101Driver(arm, limits, feedforward, { clock });

    expect(driver).toBeInstanceOf(station.joint.JointDriver);
    expect(limits).toBeInstanceOf(station.joint.JointLimits);

    // what it reads is the joint layer's state of each arm, also of an arm that hands plain data
    const states = await driver.read();
    expect(Object.keys(states)).toEqual([so101.ARM]);
    expect(states[so101.ARM]).toBeInstanceOf(station.joint.ArmState);
    expect(() => states[so101.ARM]!.check(so101.LAYOUT)).not.toThrow();
    expect(states[so101.ARM]!.feedback(101)).toEqual({
      position: [0.1, -0.2, 0.3, -0.4, 0.5, 0.5],
      velocity: ZEROS,
      sampled_monotonic_s: 100,
      sample_id: 1,
      age_seconds: 1,
      servo: { torque: { gripper: 1 } },
    });
    expect((await driver.readForRecovery())[so101.ARM]).toBeInstanceOf(station.joint.ArmState);

    // a goal is the target plus the feedforward's offset, never past a bound of the joint layer's limits
    await driver.send({ [so101.ARM]: [0, 0, 0, 0, 0, 0.9] }, { [so101.ARM]: ZEROS });
    expect(arm.sent).toEqual([[0, 0, 0, 0, 0, limits.upperBounds[so101.GRIPPER_INDEX]]]);
    expect(driver.telemetry()).toEqual({ feedforward: [0, 0, 0, 0, 0] });

    // the feedforward's time is read on the joint layer's clock; a reading given alone goes before it
    clock.now = 103.5;
    await driver.refreshHold({ [so101.ARM]: [0, 0, 0, 0, 0, 0.9] });
    expect(asked).toEqual([100, 103.5]);
    expect(arm.sent).toHaveLength(1); // the offset is the one sent: nothing is sent again
    const other = new SO101Driver(arm, limits, feedforward, { clock, monotonic: () => 7 });
    await other.send({ [so101.ARM]: [0, 0, 0, 0, 0, 0.9] }, { [so101.ARM]: ZEROS });
    expect(asked).toEqual([100, 103.5, 7]);

    await driver.close();
    expect(arm.isClosed).toBe(true);
  });

  test("the arm's name is the layout's", () => {
    expect(so101.hardware.ARM).toBe(so101.ARM);
    expect(so101.LAYOUT.arms).toEqual([so101.hardware.ARM]);
    expect(Object.keys(commissioned().armLimits())).toEqual([so101.hardware.ARM]);
  });

  for (const { name, steps } of recorded.sessions) {
    const operations = steps.filter(({ op }) => op !== "poke");
    const packets = operations.reduce((count, step) => count + (step.exchanges?.length ?? 0), 0);

    test(`made from the station's checked settings, the arm does what PEAR's did: ${name} (${packets} packets)`, async () => {
      const clock = new feetech.ManualClock();
      const transport = new ReplayTransport(clock);
      let monotonicCalls = 0;
      // the fixture script's clock: every call is a fixed step later
      const monotonic = (): number => recorded.monotonic.start_s + recorded.monotonic.step_s * monotonicCalls++;
      let hardware: so101.hardware.SO101Hardware | null = null;

      const readingOf = (state: so101.hardware.SO101ArmState): Record<string, unknown> => {
        const reading: Record<string, unknown> = {
          position: state.position,
          velocity: state.velocity,
          sampled_monotonic_s: state.sampledMonotonicS,
          sample_id: state.sampleId,
          servo_status: state.servoStatus,
        };
        // the fixture holds PEAR's SO101ArmState.feedback of one reading in a few
        if ((state.sampleId as number) % recorded.feedback_every === 1) {
          reading.feedback = state.feedback(state.sampledMonotonicS + recorded.feedback_delay_s);
        }

        return reading;
      };
      const run = async (step: Step): Promise<unknown> => {
        if (step.op === "open") {
          hardware = await SO101Hardware.fromConfig(controlConfig(), commissioned(), {
            transport,
            calibration: calibrationOf(recorded.calibration),
            busOptions: { clock },
            clock: { monotonic },
          });
          transport.portHandler = hardware.follower.bus.portHandler; // from here on the packets' timeouts are compared too
          return null;
        }
        if (hardware === null) throw new Error(`${step.op} before the arm is open`);
        if (step.op === "read") return readingOf(await hardware.read());
        if (step.op === "read_for_recovery") return readingOf(await hardware.readForRecovery());
        if (step.op === "send") return hardware.send(step.args.target as number[]);
        if (step.op === "close") return hardware.close();
        throw new Error(`The fixture holds an operation this test does not know: ${step.op}`);
      };

      for (const [index, step] of operations.entries()) {
        transport.expect(step.exchanges ?? []);
        try {
          await expectOutcome(step, () => run(step));
          transport.verify();
        } catch (error) {
          throw new Error(`Step ${index} (${step.op}): ${(error as Error).message}`, { cause: error });
        }
      }
      expect(operations.length).toBeGreaterThan(0);
    });
  }

  test("settings PEAR's HardwareConfig refuses, or under which the arm must not move, never reach the line", async () => {
    let written = 0;
    const line = {
      transport: {
        write: async () => {
          written += 1;
        },
        read: async () => new Uint8Array(0),
        close: async () => undefined,
      },
      calibration: calibrationOf(recorded.calibration),
    };

    // refused when the settings are checked, in PEAR's words
    const refused: Array<[Partial<so101.HardwareConfig>, string]> = [
      [{ joint_offsets: [0, 0, 0.25, 0, 0] }, "HardwareConfig.joint_offsets must be at most 0.2"],
      [{ joint_offsets: [0, 0, 0, 0] }, "HardwareConfig.joint_offsets must hold 5 values, not 4"],
      [{ status_poll_ticks: 1 }, "HardwareConfig.status_poll_ticks must be at least 2"],
      [{ position_p_coefficient: 100 }, "HardwareConfig.position_p_coefficient must be at most 64"],
    ];
    for (const [hardware, message] of refused) {
      expect(() => commissioned(stationSettings(hardware))).toThrow(new python.ValueError(message));
    }

    // refused by PEAR's require_commissioned, which the arm asks first
    const blocked: Array<[so101.SO101RobotConfig, string]> = [
      [
        commissioned(stationSettings({ port: so101.MISSING })),
        "hardware.port is a placeholder; see the so101 setup in README.md",
      ],
      [commissioned(stationSettings(null)), "missing hardware section"],
      [new so101.SO101RobotConfig(stationSettings()), "missing calibration file for id 'so101_follower'"],
    ];
    for (const [robotConfig, blocker] of blocked) {
      const expected = new python.RuntimeError(`Real motion is not commissioned:\n${blocker}`);
      await expect(SO101Hardware.fromConfig(controlConfig(), robotConfig, line)).rejects.toThrow(expected);
      await expect(SO101Driver.fromConfig(controlConfig(), robotConfig, line)).rejects.toThrow(expected);
    }
    expect(written).toBe(0);
  });

  test("the driver made from the settings is PEAR's: their limits, their feedforward, and an arm it releases", async () => {
    const calibration = calibrationOf(recorded.calibration);
    const clock = new feetech.ManualClock();
    const chain = simulatedArm(calibration, {}, { clock });
    const section = {
      gravity_compliance: [0, 0.08, 0.1, 0.05, 0],
      friction_offset_rad: [0, 0, 0, 0, 0],
      friction_load_ratio: [0, 0, 0, 0, 0],
    };
    const robotConfig = commissioned({ ...stationSettings(), feedforward: section });
    const warnings: string[] = [];
    const driver = await SO101Driver.fromConfig(controlConfig(), robotConfig, {
      transport: chain,
      calibration,
      busOptions: { clock },
      clock: new station.joint.SteppedClock(100),
      onWarning: (message) => warnings.push(message),
    });

    expect(driver).toBeInstanceOf(station.joint.JointDriver);
    expect((driver.hardware as so101.hardware.SO101Hardware).follower.config.positionPCoefficient).toBe(
      recorded.hardware.position_p_coefficient,
    );
    expect((driver.hardware as so101.hardware.SO101Hardware).follower.bus.port).toBe(recorded.port);
    const state = (await driver.read())[so101.ARM]!;
    expect(state).toBeInstanceOf(SO101ArmState);
    expect(state.sampledMonotonicS).toBe(100);

    // a held target carries the settings' gravity offset: what the SO-101's feedforward gives for it
    const target = [0.1, -0.5, 0.6, 0.4, 0.2, 0.5];
    await driver.send({ [so101.ARM]: target });
    const gravity = new so101.joint.Feedforward(section).holdOffset(target);
    expect(driver.telemetry().feedforward).toEqual(gravity.slice(0, so101.GRIPPER_INDEX));
    expect(gravity.some((offset) => offset !== 0)).toBe(true);
    await driver.close();
    expect([...chain.servos.values()].every((servo) => !servo.torqueEnabled)).toBe(true);
    expect(warnings).toEqual([]);

    // a feedforward that cannot be built releases the arm that was enabled for it
    const again = simulatedArm(calibration, {}, { clock });
    const broken = commissioned(stationSettings());
    (broken as { feedforward: unknown }).feedforward = { ...section, friction_offset_rad: [0] };
    const failure = SO101Driver.fromConfig(controlConfig(), broken, { transport: again, calibration, busOptions: { clock } });
    await expect(failure).rejects.toThrow(new python.ValueError("Expected one friction offset and load ratio per joint"));
    expect(again.received.length).toBeGreaterThan(50); // the arm was connected, enabled and checked
    expect([...again.servos.values()].every((servo) => !servo.torqueEnabled)).toBe(true);
    expect(again.isClosed).toBe(true);
  });
});

// ---- PEAR's control/schemas.py: ported once, in src/station/schemas.ts; the agent's loop holds views of it ----

/** Whether two types are the same type; a line that assigns `true` to it compiles only if they are. */
type Same<First, Second> =
  (<Probe>() => Probe extends First ? 1 : 2) extends <Probe>() => Probe extends Second ? 1 : 2 ? true : false;

/** Returns a key of one of PEAR's dictionaries as pear.js names the field of an object. */
function camelCase(name: string): string {
  return name.replace(/_(\w)/g, (_match, letter: string) => letter.toUpperCase());
}

describe("the agent's loop and the station share one port of PEAR's schemas", () => {
  const frame = Uint8Array.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const snapshot: station.schemas.ControlSnapshot = {
    captured_monotonic_s: 12,
    fault: null,
    fault_details: null,
    generation: 3,
    targets: { arm: JOINTS },
    arms: { arm: { position: JOINTS, velocity: ZEROS, sampled_monotonic_s: 12, sample_id: 9, age_seconds: 0 } },
    arrival: { settled: true, reached: true, signed_error: ZEROS, tolerance: ZEROS },
    settling: {},
    recovery: null,
    motion: { end_reason: station.schemas.MotionEndReason.FINISHED, settling: false },
    status: station.schemas.ControlState.HOLD,
  };
  // PEAR's Observation as the station holds it: PEAR's keys, a JPEG's bytes for each camera
  const stationObservation: station.schemas.Observation<Uint8Array> = {
    observation_id: "observation-1",
    session_id: "session",
    captured_monotonic_s: 12,
    joint_positions: JOINTS,
    images: { wrist: frame },
    camera_timestamps: { wrist: { received_monotonic_s: 11.5, frame_number: 4 } },
    control_snapshot: snapshot,
  };
  // the same observation as the agent's loop holds it: each field of the station's, under its camelCase name
  const heldObservation: agent.Observation = {
    observationId: stationObservation.observation_id,
    sessionId: stationObservation.session_id,
    capturedMonotonicS: stationObservation.captured_monotonic_s,
    jointPositions: stationObservation.joint_positions,
    images: stationObservation.images,
    cameraTimestamps: { wrist: { receivedMonotonicS: 11.5, frameNumber: 4 } },
    controlSnapshot: stationObservation.control_snapshot,
  };

  test("the phases of an action are the station's enumeration, not a copy of it", () => {
    expect(agent.ActionPhase).toBe(station.schemas.ActionPhase);
    expect(agentRobot.ActionPhase).toBe(station.schemas.ActionPhase);
    expect({ ...agent.ActionPhase }).toEqual(jointMeta.schemas.enumerations["ActionPhase"]);

    const samePhase: Same<agent.ActionPhase, station.schemas.ActionPhase> = true;
    expect(samePhase).toBe(true);
  });

  test("a camera is the station's Camera, with the fields of PEAR's", () => {
    const sameCamera: Same<agent.Camera, station.schemas.Camera> = true;
    const camera: station.schemas.Camera = agent.WRIST_CAMERA;

    expect(sameCamera).toBe(true);
    expect(Object.keys(camera)).toEqual(jointMeta.schemas.dataclasses["Camera"]);
  });

  test("an observation is PEAR's dictionary, which the loop holds under camelCase names", () => {
    const pearKeys = jointMeta.schemas.dictionaries["Observation"]!;
    const frameKeys = jointMeta.schemas.dictionaries["CameraFrame"]!.filter((key) => key !== "rgb");

    // the station's keys are PEAR's, and the loop's fields are those keys in camelCase, one for one
    expect(Object.keys(stationObservation)).toEqual(pearKeys);
    expect(Object.keys(heldObservation)).toEqual(pearKeys.map(camelCase));
    expect(Object.keys(stationObservation.camera_timestamps["wrist"]!)).toEqual(frameKeys);
    expect(Object.keys(heldObservation.cameraTimestamps["wrist"]!)).toEqual(frameKeys.map(camelCase));
    const sameKeys: Same<
      keyof agent.Observation,
      "observationId" | "sessionId" | "capturedMonotonicS" | "jointPositions" | "images" | "cameraTimestamps" | "controlSnapshot"
    > = true;
    const sameJoints: Same<agent.Observation["jointPositions"], station.schemas.Observation["joint_positions"]> = true;
    const sameImages: Same<agent.Observation["images"], Readonly<station.schemas.Observation<Uint8Array>["images"]>> = true;
    expect([sameKeys, sameJoints, sameImages]).toEqual([true, true, true]);

    // the loop's own reading of an observation takes it: the frame, the stamp against the capture, the name
    const state = new SO101Kinematics().quantities(JOINTS);
    const input = agent.ObservationMessage.build(heldObservation, state, agent.SINGLE_ARM_POSE_FORMAT, "turn-1", null, [], () => "uuid");
    expect(input.images).toEqual([{ cameraName: "wrist", bytes: frame, uuid: "uuid", name: "turn-1-wrist.jpg" }]);
    expect(input.text).toBe(protocol.turnText(state));
    const late = { ...heldObservation, cameraTimestamps: { wrist: { receivedMonotonicS: 12.5 } } };
    expect(() => agent.ObservationMessage.build(late, state, agent.SINGLE_ARM_POSE_FORMAT, "turn-1", null, [])).toThrow(
      new python.ValueError("Image cannot postdate observation capture"),
    );
  });

  test("a snapshot or a status of the station's is what the loop passes on, whole or in part", () => {
    const whole: agent.ControlSnapshot = snapshot;
    const status: agent.ControlSnapshot = { ...snapshot, status: station.schemas.RobotStatus.READY, control_state: "HOLD" };
    const brief: agent.ControlSnapshot = { status: station.schemas.RobotStatus.OFF };
    const none: agent.ControlSnapshot = {};

    expect(Object.keys(whole)).toEqual(jointMeta.schemas.dictionaries["ControlSnapshot"]);
    expect(Object.keys(status)).toEqual(jointMeta.schemas.dictionaries["DetailedStatus"]);
    expect([Object.keys(brief), Object.keys(none)]).toEqual([["status"], []]);
    // every key the loop's type knows is a key of one of PEAR's three dictionaries, and the other way round
    const sameKeys: Same<
      keyof agent.ControlSnapshot,
      keyof station.schemas.ControlSnapshot | keyof station.schemas.DetailedStatus | keyof station.schemas.BriefStatus
    > = true;
    expect(sameKeys).toBe(true);
  });

  test("a format the loop uses has the station's name, cameras and result feedback", () => {
    const format = agent.SINGLE_ARM_POSE_FORMAT;
    // the station's format of the SO-101, made of what the protocol module holds of PEAR's
    const stationFormat: station.schemas.ActionFormat<protocol.SingleArmDelta, protocol.MotionResult> = {
      name: format.name,
      schema: protocol.SCHEMA,
      cameras: format.cameras,
      environmentPrompt: protocol.ENVIRONMENT_PROMPT,
      decimals: protocol.DECIMALS,
      actionModel: (action) => action as protocol.SingleArmDelta,
      resultFeedback: format.resultFeedback,
    };

    expect(Object.keys(stationFormat)).toEqual(jointMeta.schemas.dataclasses["ActionFormat"]!.map(camelCase));
    const shared: Pick<typeof format, "name" | "cameras" | "resultFeedback"> = stationFormat;
    expect(shared.name).toBe(protocol.FORMAT_NAME);
    expect(shared.cameras).toEqual([agent.WRIST_CAMERA]);
    expect(shared.resultFeedback(null, { isDispatched: false })).toBe(format.resultFeedback(null, { isDispatched: false }));
    const sameName: Same<agent.ActionFormat["name"], station.schemas.ActionFormat["name"]> = true;
    const sameCameras: Same<agent.ActionFormat["cameras"], station.schemas.ActionFormat["cameras"]> = true;
    expect([sameName, sameCameras]).toEqual([true, true]);
  });
});
