import { describe, expect, test } from "vitest";

import {
  ARM_JOINT_LENGTH,
  CameraSection,
  FeedforwardSection,
  HardwareSection,
  KinematicsSection,
  MISSING,
  SO101_DEFAULT_CONFIG,
  SO101HomeSection,
  SO101LimitsSection,
  SO101RobotConfig,
  WRIST_ROLE,
  type SO101Config,
} from "../../src/so101/config";
import { GRIPPER_INDEX, VECTOR_LENGTH } from "../../src/so101/layout";
import {
  ConfigSection,
  ControlConfig,
  DEFAULT_CONTROL_SETTINGS,
  HomeConfig,
  Limits,
  MotionLimits,
  RobotConfig,
} from "../../src/station/joint/config";
import { RuntimeError, ValueError } from "../../src/station/joint/errors";
import { pythonNumber, pythonStrRepr } from "../../src/station/joint/numeric";
import {
  jointLimitsRecord,
  jsonText,
  loadFixture,
  meta,
  outcomeOf,
  stationOf,
  TwoArmConfig,
  type JointLimitsRecord,
  type Outcome,
  type TwoArmSettings,
} from "./fixtures";

interface SectionCase {
  section: string;
  changes: Record<string, unknown>;
  outcome: Outcome<{ fields?: string[]; control_period_s?: number; braking_caps?: [number[], number[]] }>;
}

interface RobotCase {
  patch: Record<string, unknown>;
  has_calibration: boolean;
  outcome: Outcome<{
    motion_blockers: string[];
    first_placeholder: string | null;
    require_commissioned: Outcome;
    joint_limits: JointLimitsRecord;
    arm_limits: string[];
    settings?: Record<string, unknown>;
  }>;
}

const fixture = loadFixture<{
  sections: Record<string, Record<string, unknown>>;
  section_cases: SectionCase[];
  robot_cases: RobotCase[];
  placeholder_cases: { value: unknown; key: string; outcome: Outcome }[];
  repr_cases: ({ text: string; repr: string } | { number: number; str: string })[];
}>("config.json");

// PEAR's dataclass of each section, by its name in PEAR
const SECTION_CLASSES: Record<string, new (settings: never) => ConfigSection> = {
  ControlConfig,
  MotionLimits,
  Limits,
  HomeConfig,
  SO101Limits: SO101LimitsSection,
  HardwareConfig: HardwareSection,
  CameraConfig: CameraSection,
  KinematicsConfig: KinematicsSection,
  SO101HomeConfig: SO101HomeSection,
  FeedforwardConfig: FeedforwardSection,
};

/** Returns what pear.js answers when it makes the section a case records. */
function sectionAnswer(item: SectionCase): Outcome {
  const SectionClass = SECTION_CLASSES[item.section]!;
  const settings = { ...structuredClone(fixture.sections[item.section]!), ...item.changes };

  return outcomeOf(() => {
    const section = new SectionClass(settings as never);
    const described: Record<string, unknown> = {};
    const theirs = "ok" in item.outcome ? item.outcome.ok : {};
    if (theirs.fields !== undefined) {
      described["fields"] = Object.keys(section.asDict());
    }
    if (section instanceof ControlConfig) {
      described["control_period_s"] = section.controlPeriodS;
    }
    if (section instanceof Limits && theirs.braking_caps !== undefined) {
      described["braking_caps"] = section.brakingCaps();
    }
    return described;
  });
}

/** Returns the SO-101's shipped settings with a station's own values over them: `patch` holds dotted keys. */
function patched(patch: Record<string, unknown>): SO101Config {
  const settings = structuredClone(meta.so101_defaults) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    const names = key.split(".");
    let node = settings;
    for (const name of names.slice(0, -1)) {
      node = node[name] as Record<string, unknown>;
    }
    node[names[names.length - 1]!] = structuredClone(value);
  }

  return settings as unknown as SO101Config;
}

/**
 * Returns what stands for the station's files in a case: the one calibration PEAR's script wrote, or not, where the
 * shipped defaults look for it.
 */
function calibrationsOf(item: RobotCase): (calibrationDir: string, calibrationId: string) => boolean {
  const { calibration_dir: directory, calibration_id: id } = meta.so101_defaults.hardware!;

  return (calibrationDir, calibrationId) => item.has_calibration && calibrationDir === directory && calibrationId === id;
}

/** Returns what pear.js answers when it makes the SO-101's settings a case records. */
function robotAnswer(item: RobotCase): Outcome {
  return outcomeOf(() => {
    const config = new SO101RobotConfig(patched(item.patch), { calibrationExists: calibrationsOf(item) });
    const described: Record<string, unknown> = {
      motion_blockers: config.motionBlockers(),
      first_placeholder: config.firstPlaceholder(),
      require_commissioned: outcomeOf(() => config.requireCommissioned()),
      joint_limits: jointLimitsRecord(config.jointLimits()),
      arm_limits: Object.keys(config.armLimits()),
    };
    if ("ok" in item.outcome && item.outcome.ok.settings !== undefined) {
      described["settings"] = config.asDict();
    }
    return described;
  });
}

/** Returns PEAR's answer to a section case, without the one field pear.js's section does not have. */
function sectionExpected(item: SectionCase): Outcome {
  if ("ok" in item.outcome && item.outcome.ok.fields !== undefined) {
    // PEAR's KinematicsConfig begins with the path of the arm's description, which pear.js never reads
    return { ok: { ...item.outcome.ok, fields: item.outcome.ok.fields.filter((name) => name !== "urdf") } };
  }
  return item.outcome;
}

function differing<Case>(cases: readonly Case[], answer: (item: Case) => Outcome, expected: (item: Case) => Outcome) {
  return cases.flatMap((item) => {
    const ours = answer(item);
    try {
      expect(ours).toEqual(expected(item));
    } catch {
      return [{ item, ours }];
    }
    return [];
  });
}

describe("the sections of a station's configuration", () => {
  for (const name of Object.keys(fixture.sections)) {
    const ofSection = fixture.section_cases.filter((item) => item.section === name);
    const refused = ofSection.filter((item) => "error" in item.outcome).length;

    test(`${name}: ${ofSection.length} settings accepted or refused as PEAR's dataclass (${refused} refused)`, () => {
      expect(differing(ofSection, sectionAnswer, sectionExpected).slice(0, 5)).toEqual([]);
      expect(refused).toBeGreaterThan(0);
      expect(ofSection.length - refused).toBeGreaterThan(0);
    });
  }

  test("a refusal is Python's ValueError, and a missing value is refused in pear.js's own words", () => {
    const failure = outcomeOf(() => new ControlConfig({ ...DEFAULT_CONTROL_SETTINGS, rate_hz: 0 }));
    expect(failure).toEqual({ error: { type: "ValueError", message: "ControlConfig.rate_hz must be greater than 0" } });
    expect(() => new ControlConfig({ ...DEFAULT_CONTROL_SETTINGS, rate_hz: 0 })).toThrow(ValueError);

    // PEAR leaves a value that is missing or of the wrong kind to OmegaConf, which is not ported
    const partial = { rate_hz: 50 } as never;
    expect(outcomeOf(() => new ControlConfig(partial))).toEqual({
      error: { type: "ValueError", message: "ControlConfig.state_timeout_s is missing" },
    });
    const worded = { ...DEFAULT_CONTROL_SETTINGS, rate_hz: "50" } as never;
    expect(outcomeOf(() => new ControlConfig(worded))).toEqual({
      error: { type: "ValueError", message: "ControlConfig.rate_hz must be greater than 0" },
    });
  });

  test("a section is a copy of its settings and may be changed afterwards, like a dataclass", () => {
    const control = new ControlConfig();
    control.rate_hz = 25;
    expect(control.controlPeriodS).toBe(0.04);
    expect(DEFAULT_CONTROL_SETTINGS.rate_hz).toBe(50);

    const limits = new SO101LimitsSection(SO101_DEFAULT_CONFIG.limits);
    limits.velocity[0] = 0.25;
    expect(SO101_DEFAULT_CONFIG.limits.velocity[0]).toBe(1.0);
    expect(limits.asDict()["velocity"]).toEqual([0.25, 1.0, 1.0, 1.0, 1.0, 0.5]);
  });
});

describe("the control loop's settings", () => {
  test("the defaults are the control node of PEAR's station.yaml", () => {
    expect({ ...DEFAULT_CONTROL_SETTINGS }).toEqual(meta.station_control);
    expect(Object.keys(DEFAULT_CONTROL_SETTINGS)).toEqual(Object.keys(meta.station_control));
    expect(Object.isFrozen(DEFAULT_CONTROL_SETTINGS)).toBe(true);
  });

  test("the control period of every station is PEAR's", () => {
    for (const [key, record] of Object.entries(meta.stations)) {
      expect(new ControlConfig(record.control).controlPeriodS, key).toBe(record.control_period_s);
      expect(new ControlConfig(record.control).asDict()).toEqual(record.control);
    }
    expect(new ControlConfig().asDict()).toEqual(meta.stations["so101"]!.control);
  });
});

describe("the SO-101's settings", () => {
  const refused = fixture.robot_cases.filter((item) => "error" in item.outcome).length;

  test(`${fixture.robot_cases.length} stations' settings over the shipped defaults: PEAR's refusal, or what PEAR derives (${refused} refused)`, () => {
    const wrong = differing(fixture.robot_cases, robotAnswer, (item) => item.outcome);
    expect(wrong.slice(0, 2).map(({ item, ours }) => ({ patch: item.patch, theirs: item.outcome, ours }))).toEqual([]);
    expect(refused).toBeGreaterThan(40);
    expect(fixture.robot_cases.length - refused).toBeGreaterThan(40);
  });

  test("the settings read back in the order of PEAR's dataclasses", () => {
    const whole = fixture.robot_cases.filter((item) => "ok" in item.outcome && item.outcome.ok.settings !== undefined);

    for (const item of whole) {
      const config = new SO101RobotConfig(patched(item.patch), { calibrationExists: calibrationsOf(item) });
      const theirs = "ok" in item.outcome ? item.outcome.ok.settings : undefined;
      expect(jsonText(config.asDict()), JSON.stringify(item.patch)).toBe(jsonText(theirs));
    }
    expect(whole.length).toBeGreaterThanOrEqual(8);
  });

  test("with no settings it is PEAR's defaults, whose placeholders keep the arm from moving", () => {
    const config = new SO101RobotConfig();
    const shipped = fixture.robot_cases.find((item) => Object.keys(item.patch).length === 0 && !item.has_calibration)!;
    const theirs = "ok" in shipped.outcome ? shipped.outcome.ok : undefined;

    expect(JSON.parse(jsonText(SO101_DEFAULT_CONFIG))).toEqual(meta.so101_defaults);
    expect(SO101_DEFAULT_CONFIG.hardware?.port).toBe(MISSING);
    expect(config.hardware?.port).toBe("<hardware.port>");
    expect(config.camera?.path).toBe("<camera.path>");
    expect(config.motionBlockers()).toEqual(theirs?.motion_blockers);
    expect(theirs?.motion_blockers.length).toBe(2);
    expect(() => config.requireCommissioned()).toThrow(RuntimeError);
    expect(jointLimitsRecord(config.jointLimits())).toEqual(meta.stations["so101"]!.joint_limits);
    expect(config.asDict()).toEqual(meta.stations["so101"]!.settings);
    expect(config.feedsVelocity("arm")).toBe(meta.stations["so101"]!.feeds_velocity["arm"]);
  });

  test("the constants are PEAR's", () => {
    expect(ARM_JOINT_LENGTH).toBe(meta.constants.so101.arm_joint_length);
    expect(WRIST_ROLE).toBe(meta.constants.so101.wrist_role);
    expect(VECTOR_LENGTH).toBe(meta.constants.so101.vector_length);
    expect(GRIPPER_INDEX).toBe(meta.constants.so101.gripper_index);
    expect(RobotConfig.PLACEHOLDER).toBe(meta.constants.robot_config.placeholder);
    expect(RobotConfig.MISSING).toBe(MISSING);
  });

  test("a checked configuration is still the settings the kinematics and the servo layer read", () => {
    const config: SO101Config = new SO101RobotConfig();

    expect(config.limits.lower_bounds).toEqual(SO101_DEFAULT_CONFIG.limits.lower_bounds);
    expect(config.geometry?.gripper_width_cm).toEqual([0.0, 6.0]);
  });
});

describe("a robot of two arms", () => {
  test("its limits are each arm's, arm after arm, as PEAR derives them", () => {
    for (const key of ["two_arm", "two_arm_station"]) {
      const station = stationOf(key);
      const settings = station.record.settings as TwoArmSettings;

      expect(jointLimitsRecord(station.robotConfig.jointLimits())).toEqual(station.record.joint_limits);
      expect(Object.keys(station.robotConfig.armLimits())).toEqual(station.layout.arms);
      expect(station.robotConfig.home?.limits?.asDict() ?? null).toEqual(settings.home?.limits ?? null);
      expect(station.robotConfig.firstPlaceholder()).toBeNull();
      expect(() => station.robotConfig.requireCommissioned()).not.toThrow();
    }
  });

  test("the checks every robot's settings share speak for it too", () => {
    const settings = meta.stations["two_arm"]!.settings as TwoArmSettings;
    const refusal = (changed: TwoArmSettings) => outcomeOf(() => new TwoArmConfig(changed));
    const left = settings.arm_limits["left"]!;

    // PEAR words these with the name of the robot's class, YAMConfig; the checks are the generic RobotConfig's
    expect(refusal({ ...settings, gripper_tolerance: 0.3 })).toEqual({
      error: { type: "ValueError", message: "YAMConfig.gripper_tolerance must be at most 0.2" },
    });
    expect(
      refusal({ ...settings, arm_limits: { ...settings.arm_limits, left: { ...left, velocity: left.velocity.slice(1) } } }),
    ).toEqual({ error: { type: "ValueError", message: "Limits.velocity must hold 7 values, not 6" } });
    expect(
      refusal({
        ...settings,
        arm_limits: { ...settings.arm_limits, right: { ...left, upper_bounds: [...left.upper_bounds.slice(0, -1), 1.5] } },
      }),
    ).toEqual({ error: { type: "ValueError", message: "Gripper limits must lie within [0, 1]" } });
  });
});

describe("placeholders and Python's wording", () => {
  test(`placeholder_key finds the first placeholder of ${fixture.placeholder_cases.length} values as PEAR finds it`, () => {
    const found = (item: { value: unknown; key: string }) => outcomeOf(() => RobotConfig.placeholderKey(item.value, item.key));

    expect(differing(fixture.placeholder_cases, found, (item) => item.outcome)).toEqual([]);
  });

  test("with_placeholders names what a station left ???, and nothing else", () => {
    const filled = RobotConfig.withPlaceholders({ a: "???", b: { c: "???", d: ["x", "???"], e: 1 }, f: null, g: "?" });

    expect(filled).toEqual({ a: "<a>", b: { c: "<b.c>", d: ["x", "<b.d[1]>"], e: 1 }, f: null, g: "?" });
    expect(RobotConfig.withPlaceholders(meta.so101_defaults)).toEqual({
      ...meta.so101_defaults,
      hardware: { ...meta.so101_defaults.hardware, port: "<hardware.port>" },
      camera: { ...meta.so101_defaults.camera, path: "<camera.path>" },
    });
  });

  test(`a text and a bound read as Python words them (${fixture.repr_cases.length} values)`, () => {
    const wrong = fixture.repr_cases.flatMap((item) => {
      const [ours, theirs] = "text" in item ? [pythonStrRepr(item.text), item.repr] : [pythonNumber(item.number), item.str];
      return ours === theirs ? [] : [{ item, ours }];
    });

    expect(wrong).toEqual([]);
  });
});
