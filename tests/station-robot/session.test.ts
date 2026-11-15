// The session's edges that no record of PEAR holds: a control loop closed under the robot, an open that fails, the
// station's configuration changed between two opens, a joint vector that gives no state, a stop while Home observes.
//
// PEAR's robot (control/robot.py): `status` reads OFF of a control loop that is CLOSED, which it holds between the
// control loop's close and its own forgetting of it; `open` makes the two configurations again from the station's
// configuration and, when anything after that fails, closes what was opened (`except BaseException: self.close()`);
// `model_state` returns the kinematics' quantities, which end in `ModelState.model_validate`. PEAR's SO-101 plans
// Home and rechecks its move bound to the observation (robots/so101/motion/homing.py: `run_while_observation_holds`),
// so an observation that no longer holds is refused there, before the action's guard sees the stop.
//
// These are expectations written by hand. What PEAR does was run on PEAR's own robot on its stepped rig (the station
// "so101_quick"; Home on "so101_quick_home" with the drawn cameras after an action of z +0.05 m), and the rows below
// are that run's:
//
//   the control loop shut down under the robot
//     status()                        {status OFF, settled false, reached true, fault None}
//     status(True)                    status OFF, control_state CLOSED, the generation two higher
//     observe()                       raises RuntimeError: Station requires valid feedback: CLOSED: None
//     close()                         returns; then status() is {status OFF} and the session has no identity
//   an open that fails: the session's identity cannot be drawn (RuntimeError), the driver cannot be made (OSError)
//     open raises that error; status() {status OFF}; no identity, no control loop, no kinematics: model_state
//     raises RuntimeError: Open a Cartesian Station first; a later open gives a session
//   the station's configuration: control.settle_timeout_s 1.0, robot.gripper_tolerance 0.02
//     changed to 7.5 and 0.05, not open           the robot's configurations still read 1.0 and 0.02
//     open                                        7.5 and 0.05
//     changed to 9.5 while open, then closed      7.5
//     open again                                  9.5
//     changed to -1.0, open                       raises ValueError: ControlConfig.settle_timeout_s must be greater
//                                                 than 0; the configurations still read 9.5 and 0.05; OFF, no kinematics
//     changed to 2.5, open                        2.5
//   model_state of joints [0, 0, 0, 0, 0, 1]      arm x 39.1 y 0 z 22.6 pitch 0 roll -0.05, gripper width 6
//     the gripper inf                             the same (the width is bounded)
//     seven joints, all 0                         the same with width 0
//     joint 1 nan, or joint 0 inf                 raises pydantic's ValidationError (a ValueError): 5 validation
//                                                 errors for ModelState, arm.x to arm.roll, each "Input should be
//                                                 a finite number"
//     the gripper nan                             1 validation error, gripper.width
//     all nan                                     6 validation errors
//   Home, the robot stopped while Home's first observation reads the cameras
//     raises HomeFailed: Observation invalidated by another operation (its cause the ValueError); the cameras were
//     read once, the plan was not put to approval, the one stage reported is "checking"; the robot is READY
//   Home, the robot stopped while the observation before the recheck reads the cameras
//     the same error; the cameras were read twice, the plan was approved once, "checking" was reported twice

import { describe, expect, test } from "vitest";

import { isValueError, OSError, RuntimeError } from "../../src/python/errors";
import { SO101Robot } from "../../src/so101/robot";
import { brief, caught, delta, handRig } from "./by_hand";
import { stationOf } from "./fixtures";
import { RecordingClock, StandInCameras, SteppedStandInSO101Robot } from "./rig";

const FORMAT = Object.keys(SO101Robot.ACTION_FORMATS)[0]!;
const AT_REST = { arm: { x: 39.1, y: 0, z: 22.6, pitch: 0, roll: -0.05 }, gripper: { width: 6 } };
const NOT_OPEN = "threw RuntimeError: Open a Cartesian Station first";

/** A robot of the station "so101_quick" on the stepped rig that is not open yet, and what opens it on the rig. */
function closedRobot(options: { config?: unknown; uuid4?: () => string; attach?: () => void } = {}) {
  const clock = new RecordingClock();
  let drawn = 0;
  const robot = new SteppedStandInSO101Robot((options.config ?? stationOf("so101_quick").config) as never, {
    cameras: null,
    clock,
    uuid4: options.uuid4 ?? (() => `uuid-${++drawn}`),
  });
  robot.rig = { attach: options.attach ?? (() => undefined), recordedTarget: () => null, asked: () => undefined };

  return {
    robot,
    clock,
    /** Opens the robot, or returns what its open threw; the rig's clock steps the control loop of an open session. */
    async open(): Promise<string> {
      clock.controlLoop = null;
      const outcome = await caught(async () => void (await robot.open()));
      clock.controlLoop = robot.openLoop;
      return outcome;
    },
    async close(): Promise<void> {
      await robot.close();
      clock.controlLoop = null;
    },
  };
}

describe("a control loop that is closed while the robot still holds it reads OFF (expectations written by hand)", () => {
  test("the control loop shut down under the robot: the status, an observation, then the robot's close", async () => {
    const { robot, clock } = await handRig();
    const controlLoop = robot.controlLoop;
    const [session, generation] = [robot.sessionId, controlLoop.snapshot().generation];

    await controlLoop.shutdown();

    expect([String(controlLoop.status), robot.openLoop === controlLoop, robot.sessionId]).toEqual(["CLOSED", true, session]);
    expect(robot.status()).toEqual({ status: "OFF", settled: false, reached: true, fault: null });
    const detailed = robot.status(true) as unknown as Record<string, unknown>;
    expect([detailed["status"], detailed["control_state"], detailed["generation"]]).toEqual(["OFF", "CLOSED", generation + 2]);
    expect(await caught(() => robot.observe())).toBe("threw RuntimeError: Station requires valid feedback: CLOSED: None");

    clock.controlLoop = null;
    expect(await caught(() => robot.close())).toBe("returned undefined");
    expect([robot.status(), robot.sessionId, robot.openLoop]).toEqual([{ status: "OFF" }, null, null]);
  });
});

describe("an open that fails closes what it opened (expectations written by hand)", () => {
  test.each([
    ["the session's identity cannot be drawn", "threw RuntimeError: no identity"],
    ["the driver cannot be made", "threw OSError: no port"],
  ])("%s", async (name, raised) => {
    let fails = true;
    let drawn = 0;
    const rig = closedRobot(
      name === "the driver cannot be made"
        ? {
            attach: () => {
              if (fails) {
                throw new OSError("no port");
              }
            },
          }
        : {
            uuid4: () => {
              if (fails) {
                throw new RuntimeError("no identity");
              }
              return `uuid-${++drawn}`;
            },
          },
    );
    const { robot } = rig;

    expect(await rig.open()).toBe(raised);

    expect([robot.status(), robot.sessionId, robot.openLoop, robot.kinematics]).toEqual([{ status: "OFF" }, null, null, null]);
    expect(await caught(() => robot.modelState([0, 0, 0, 0, 0, 0], FORMAT))).toBe(NOT_OPEN);

    fails = false;
    expect(await rig.open()).toBe("returned undefined");
    expect([typeof robot.sessionId, String(robot.status().status)]).toEqual(["string", "READY"]);
    expect(robot.modelState([0, 0, 0, 0, 0, 0], FORMAT)).toEqual({ ...AT_REST, gripper: { width: 0 } });
    await rig.close();
  });
});

describe("every open makes the robot's configurations again from the station's (expectations written by hand)", () => {
  test("the station's configuration changed before an open, while open, and to one that is refused", async () => {
    const station = stationOf("so101_quick").config;
    // (a configuration of its own: the fixtures' is shared)
    const config = { control: { ...station.control }, robot: { ...station.robot } } as unknown as {
      control: { settle_timeout_s: number };
      robot: { gripper_tolerance: number };
    };
    const rig = closedRobot({ config });
    const { robot } = rig;
    const configured = (): unknown[] => [robot.controlConfig.settle_timeout_s, robot.robotConfig.gripper_tolerance, String(robot.status().status)];

    expect(configured()).toEqual([1.0, 0.02, "OFF"]);
    config.control.settle_timeout_s = 7.5;
    config.robot.gripper_tolerance = 0.05;
    expect(configured()).toEqual([1.0, 0.02, "OFF"]);
    expect(await rig.open()).toBe("returned undefined");
    expect(configured()).toEqual([7.5, 0.05, "READY"]);

    config.control.settle_timeout_s = 9.5;
    expect(configured()).toEqual([7.5, 0.05, "READY"]);
    await rig.close();
    expect(configured()).toEqual([7.5, 0.05, "OFF"]);
    expect(await rig.open()).toBe("returned undefined");
    expect(configured()).toEqual([9.5, 0.05, "READY"]);
    await rig.close();

    config.control.settle_timeout_s = -1.0;
    expect(await rig.open()).toBe("threw ValueError: ControlConfig.settle_timeout_s must be greater than 0");
    expect(configured()).toEqual([9.5, 0.05, "OFF"]);
    expect(robot.kinematics).toBe(null);

    config.control.settle_timeout_s = 2.5;
    expect(await rig.open()).toBe("returned undefined");
    expect(configured()).toEqual([2.5, 0.05, "READY"]);
    await rig.close();
  });
});

describe("the state the model reads is validated as PEAR's ModelState is (expectations written by hand)", () => {
  const ARM_FIELDS = ["arm.x", "arm.y", "arm.z", "arm.pitch", "arm.roll"];
  /** pydantic's text of quantities that are no finite numbers. */
  const notFinite = (fields: string[]): string =>
    `${fields.length} validation error${fields.length === 1 ? "" : "s"} for ModelState\n` +
    fields
      .map(
        (field) =>
          `${field}\n  Input should be a finite number [type=finite_number, input_value=nan, input_type=float]\n` +
          "    For further information visit https://errors.pydantic.dev/2.13/v/finite_number",
      )
      .join("\n");

  test.each([
    ["at rest", [0, 0, 0, 0, 0, 1], AT_REST],
    ["the gripper infinite", [0, 0, 0, 0, 0, Infinity], AT_REST],
    ["seven joints", [0, 0, 0, 0, 0, 0, 0], { ...AT_REST, gripper: { width: 0 } }],
  ])("%s: a state", async (_name, joints, state) => {
    const { robot } = await handRig();

    expect(robot.modelState(joints, FORMAT)).toEqual(state);
    await robot.close();
  });

  test.each([
    ["joint 1 NaN", [0, Number.NaN, 0, 0, 0, 1], ARM_FIELDS],
    ["joint 0 infinite", [Infinity, 0, 0, 0, 0, 1], ARM_FIELDS],
    ["the gripper NaN", [0, 0, 0, 0, 0, Number.NaN], ["gripper.width"]],
    ["all NaN", new Array<number>(6).fill(Number.NaN), [...ARM_FIELDS, "gripper.width"]],
  ])("%s: refused with pydantic's text", async (_name, joints, fields) => {
    const { robot } = await handRig();
    let thrown: unknown = null;

    try {
      robot.modelState(joints, FORMAT);
    } catch (error) {
      thrown = error;
    }

    expect(`${(thrown as Error | null)?.name}: ${(thrown as Error | null)?.message}`).toBe(`ValidationError: ${notFinite(fields)}`);
    expect(isValueError(thrown)).toBe(true);
    await robot.close();
  });
});

describe("Home's plan and its recheck are bound to the observation they start from (expectations written by hand)", () => {
  test.each([
    { read: 1, when: "Home's first observation", approvals: 0, stages: ["checking"] },
    { read: 2, when: "the observation before the recheck", approvals: 1, stages: ["checking", "checking"] },
  ])("the robot stopped while $when reads the cameras: the observation is refused as one of another operation", async ({ read, approvals, stages }) => {
    const seen = { reads: 0, approvals: 0, stages: [] as string[] };
    let stopAt = 0;
    const rig = await handRig({
      station: "so101_quick_home",
      cameras: (clock) => {
        const cameras = new StandInCameras(SO101Robot.CAMERAS, clock);
        const own = cameras.read.bind(cameras);
        cameras.read = async () => {
          seen.reads += 1;
          if (seen.reads === stopAt) {
            await rig.robot.stop(); // (as another thread would during the read)
          }
          return own();
        };
        return cameras;
      },
    });
    const { robot } = rig;
    // away from Home, so that Home has a move to make
    expect(brief(await robot.execute(delta(0.05)))).toEqual({ status: "completed", error: null });
    seen.reads = 0;
    stopAt = read;

    const failure = await robot
      .home({
        approvePlan: () => {
          seen.approvals += 1;
          return true;
        },
        reportProgress: (update) => void seen.stages.push(String((update as { stage?: unknown }).stage)),
      })
      .then(
        () => null,
        (error: Error & { cause?: Error; details?: Record<string, unknown> }) => error,
      );

    expect(`${failure?.name}: ${failure?.message}`).toBe("HomeFailed: Observation invalidated by another operation");
    expect(`${failure?.cause?.name}: ${failure?.cause?.message}`).toBe("ValueError: Observation invalidated by another operation");
    expect(Object.keys(failure?.details ?? {}).sort()).toEqual(["completed_stages", "error", "results", "stage"]);
    expect(seen).toEqual({ reads: read, approvals, stages });
    expect(String(robot.status().status)).toBe("READY");
    await robot.close();
  });
});
