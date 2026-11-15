// The parts of the motion layer that need no control loop, against PEAR's own (parts.json.gz): SO101Planning and
// HomePlanning, MotionResult and the format's report of a result, the wrist camera's checks and the camera feed.
// Every field of every case is compared, and every number must be the same double.
//
// A checked move is computed by Ruckig, which takes five functions from the engine that no library rounds correctly
// (src/ruckig/libm.ts). Here they answer from libm.json beside the fixtures, the table of what the reference's C
// library gave for the same arguments (tests/ruckig/oracle.ts; the table is made by
// tools/fixtures/ruckig_fixtures.py --libm <the fixtures' directory>, in rounds). engine.test.ts runs the same cases
// on the engine's own functions and measures what then differs. The action models' refusals are in actions.test.ts.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { SINGLE_ARM_POSE_FORMAT } from "../../src/so101/formats";
import { WristCamera } from "../../src/so101/hardware/cameras";
import { JOINTS } from "../../src/so101/layout";
import { SingleArmDelta } from "../../src/so101/motion/actions";
import { SO101Planning } from "../../src/so101/motion/planning";
import { SO101Robot } from "../../src/so101/robot";
import { CameraSource } from "../../src/station/cameras";
import { SequenceOperation } from "../../src/station/joint/operations";
import { GripperProfile } from "../../src/station/joint/trajectory";
import { HomeStage, Homing } from "../../src/station/motion/homing";
import { HomePlanning } from "../../src/station/motion/planning";
import { MotionStatus } from "../../src/station/motion/results";
import { ActionMode, BaseRobot } from "../../src/station/robot";
import { ActionPhase, ControlState, MotionEndReason, RobotStatus } from "../../src/station/schemas";
import { installOracle, type Oracle } from "../ruckig/oracle";
import { Comparison } from "../station-loop/compare";
import { CONFIG_OPTIONS, DIRECTORY, IS_LARGER_SET, loadFixture, meta, outcomeOf, stationOf } from "./fixtures";
import { partsChecks, type PartsFixture } from "./parts_checks";

const MISSING = "the port asked for arguments libm.json does not hold: add them (see tests/ruckig/oracle.ts) and run again";

const fixture = loadFixture<PartsFixture>("parts.json.gz");
const checks = partsChecks(fixture);
// the cases each group must hold at least: the committed set's
const GROUPS: Record<string, number> = {
  action_cases: 208,
  delta_base_cases: 108,
  action_parts_cases: 42,
  home_cases: 261,
  bounds_cases: 162,
  recheck_cases: 56,
  estimate_cases: 24,
  opening_cases: 96,
  measured_cases: 7,
  no_home_cases: 4,
  snapshot_cases: 522,
  build_cases: 8,
  feedback_cases: 145,
  camera_cases: 13,
};

describe("with the reference's C library values, the parts give what PEAR's give, to the last bit", () => {
  let oracle: Oracle;
  const comparison = new Comparison(true);
  const differing: string[] = [];
  const ran = new Map<string, number>();

  beforeAll(() => {
    oracle = installOracle(DIRECTORY);
  });
  afterAll(() => {
    console.info(`libm.json: ${oracle.size} values; ${oracle.hits()} calls answered from it, ${oracle.missing()} arguments missing`);
    oracle.close();
  });

  for (const group of Object.keys(GROUPS)) {
    describe(group, () => {
      for (const check of checks.filter((candidate) => candidate.group === group)) {
        test(check.name, async () => {
          const difference = await check.run(comparison);
          ran.set(group, (ran.get(group) ?? 0) + 1);
          if (difference !== null) {
            differing.push(`${check.name}: ${difference}`);
          }
          expect(difference).toBeNull();
        });
      }
    });
  }

  test("every case of every group ran, and every number is the same double", () => {
    const counts = Object.keys(GROUPS).map((group) => `${group} ${ran.get(group) ?? 0}`);
    console.info(`parts: ${checks.length} cases (${counts.join(", ")}), ${differing.length} differ; ${comparison.summary()}`);

    for (const [group, least] of Object.entries(GROUPS)) {
      const held = (fixture as unknown as Record<string, unknown[]>)[group]!.length;
      expect(held, group).toBeGreaterThanOrEqual(IS_LARGER_SET ? least : least);
      expect(ran.get(group) ?? 0, group).toBe(held);
    }
    expect(differing).toEqual([]);
    expect(comparison.identical).toBe(comparison.numbers);
  });

  test("the table of the reference's C library values held every argument the port asked for", () => {
    expect(oracle.missing(), MISSING).toBe(0);
  });
});

describe("the names and the numbers of PEAR's classes", () => {
  const constants = meta.constants;

  test("the enumerations hold PEAR's words", () => {
    expect({ ...ActionMode }).toEqual(constants["action_mode"]);
    expect({ ...MotionStatus }).toEqual(constants["motion_status"]);
    expect({ ...HomeStage }).toEqual(constants["home_stage"]);
    expect({ ...ActionPhase }).toEqual(constants["action_phase"]);
    expect({ ...RobotStatus }).toEqual(constants["robot_status"]);
    expect({ ...ControlState }).toEqual(constants["control_state"]);
    expect({ ...MotionEndReason }).toEqual(constants["motion_end_reason"]);
  });

  test("the robot's facts and its profile", () => {
    expect({
      PLANNING_TIMEOUT_S: BaseRobot.PLANNING_TIMEOUT_S,
      HOME_TIMEOUT_S: BaseRobot.HOME_TIMEOUT_S,
      FOREIGN_OBSERVATION: BaseRobot.FOREIGN_OBSERVATION,
      HOME_ARM_CHOICES: [...SO101Robot.HOME_ARM_CHOICES],
      HOME_CAN_KEEP_GRIPPERS: SO101Robot.HOME_CAN_KEEP_GRIPPERS,
      profile: SO101Robot.profile(),
      // a robot made with an action mode that is none
      bad_action_mode: outcomeOf(
        () => new SO101Robot(stationOf("so101_station").config, { actionMode: "sideways" as ActionMode, configOptions: CONFIG_OPTIONS }),
        (robot) => robot.constructor.name,
      ),
    }).toEqual(constants["robot"]);
    expect(JSON.stringify(SO101Robot.profile())).toBe(JSON.stringify(constants["robot"]["profile"]));
  });

  test("Home's numbers and refusals", () => {
    expect({
      WAIT_MARGIN_S: Homing.WAIT_MARGIN_S,
      TARGET_TOLERANCE: HomePlanning.TARGET_TOLERANCE,
      MOVE_TOLERANCE: HomePlanning.MOVE_TOLERANCE,
      TARGETS_CHANGED: HomePlanning.TARGETS_CHANGED,
      SO101_TARGETS_CHANGED: SO101Planning.TARGETS_CHANGED,
      BOUND_TOLERANCE: SO101Planning.BOUND_TOLERANCE,
      OPEN_ENDPOINT: GripperProfile.OPEN_ENDPOINT,
    }).toEqual(constants["homing"]);
  });

  test("the cameras and the format", () => {
    const idle = { isReading: false, latestFrame: null, latestTimestamp: null, isConnected: false, disconnect: () => undefined };
    expect({
      MAX_AGE_S: CameraSource.MAX_AGE_S,
      START_TIMEOUT_MS: WristCamera.START_TIMEOUT_MS,
      CAMERA: { ...WristCamera.CAMERA },
      // the wrist camera of a station whose settings have no camera
      without_settings: outcomeOf(
        () => new WristCamera(stationOf("so101_no_camera").robotConfig, idle),
        (camera) => camera.constructor.name,
      ),
    }).toEqual(constants["cameras"]);

    const format = SINGLE_ARM_POSE_FORMAT;
    expect({
      name: format.name,
      schema: Object.fromEntries(Object.entries(format.schema).map(([part, names]) => [part, [...names]])),
      cameras: format.cameras.map((camera) => ({ ...camera })),
      environment_prompt: format.environmentPrompt,
      decimals: { ...format.decimals },
      action_model: SingleArmDelta.name,
    }).toEqual(constants["format"]);
    expect(Object.keys(format.schema)).toEqual(Object.keys(constants["format"]["schema"]));
    expect(Object.keys(format.decimals)).toEqual(Object.keys(constants["format"]["decimals"]));
    expect(Object.keys(SO101Robot.ACTION_FORMATS)).toEqual([format.name]);
  });

  test("the joints, a sequence's longest chunk and the stand-in clock's first reading", () => {
    expect([...JOINTS]).toEqual(constants["joints"]);
    expect(SequenceOperation.MAX_ROWS).toBe(constants["max_rows"]);
    expect(constants["start_s"]).toBe(100.0);
  });
});
