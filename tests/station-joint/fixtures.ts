// Reads the fixtures tools/fixtures/joint_fixtures.py wrote of PEAR's own output, and makes the stations they name.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SO101RobotConfig, type SO101Config } from "../../src/so101/config";
import { JointLayout, LAYOUT, type ControlTexts } from "../../src/so101/layout";
import {
  ControlConfig,
  Limits,
  RobotConfig,
  type ControlSettings,
  type HomeSettings,
  type LimitSettings,
} from "../../src/station/joint/config";

/** Returns the bytes of a file of this repository, by its path from the repository's root. */
export function repositoryFile(path: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)));
}

/** Returns `value` with every `{"$": "nan"}` that the fixtures hold in a number's place as that number. */
export function revived<Value>(value: Value): Value {
  if (Array.isArray(value)) {
    return value.map(revived) as Value;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 1 && entries[0]![0] === "$") {
      return { nan: NaN, inf: Infinity, "-inf": -Infinity }[entries[0]![1] as string] as Value;
    }
    return Object.fromEntries(entries.map(([key, child]) => [key, revived(child)])) as Value;
  }
  return value;
}

/**
 * Returns a fixture file of the joint layer: the committed one, or the one of the same name in the directory
 * PEAR_JS_JOINT_FIXTURES names (a larger set, see tools/fixtures/joint_fixtures.py).
 */
export function loadFixture<Content>(name: string): Content {
  const directory = process.env.PEAR_JS_JOINT_FIXTURES;
  const bytes = directory ? readFileSync(join(directory, name)) : repositoryFile(`tests/fixtures/station-joint/${name}`);

  return revived(JSON.parse(bytes.toString("utf8")) as Content);
}

/** What PEAR's call returned, or the class and the message of what it raised. */
export type Outcome<Value = unknown> = { ok: Value } | { error: { type: string; message: string } };

/** Returns what `call` returned or threw, in the form the fixtures record PEAR's: no value reads as null. */
export function outcomeOf(call: () => unknown): Outcome {
  try {
    const value = call();
    return { ok: value === undefined ? null : value };
  } catch (error) {
    return { error: { type: (error as Error).name, message: (error as Error).message } };
  }
}

/** The same for a call that is asynchronous here. */
export async function outcomeOfAsync(call: () => Promise<unknown>): Promise<Outcome> {
  try {
    const value = await call();
    return { ok: value === undefined ? null : value };
  } catch (error) {
    return { error: { type: (error as Error).name, message: (error as Error).message } };
  }
}

/** Returns `value` as the text of its JSON, which also tells the order of an object's keys. */
export function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

export interface LayoutRecord {
  arms: string[];
  coordinates: string[];
  texts: ControlTexts;
  coordinate_count: number;
  joint_count: number;
  vector_length: number;
  gripper_indices: number[];
}

/** The nine fields of PEAR's JointLimits. */
export interface JointLimitsRecord {
  lower_bounds: number[];
  upper_bounds: number[];
  velocity: number[];
  acceleration: number[];
  jerk: number[];
  tracking_error: number[];
  stop_acceleration: number[];
  stop_jerk: number[];
  feedback_tolerance: number;
}

/** What every robot's settings hold, of the two YAM arms of PEAR's tests. */
export interface TwoArmSettings {
  position_tolerance: number;
  gripper_tolerance: number;
  feedback_position_tolerance: number;
  velocity_tolerance: number;
  home: HomeSettings | null;
  arm_limits: Record<string, LimitSettings>;
}

export interface StationRecord {
  layout: "so101" | "two_arm";
  control: ControlSettings;
  control_period_s: number;
  settings: SO101Config | TwoArmSettings;
  joint_limits: JointLimitsRecord;
  braking_caps: [number[], number[]];
  motion_caps: number[][];
  feeds_velocity: Record<string, boolean>;
}

export interface Meta {
  scale: number;
  pear_commit: string;
  versions: Record<string, string>;
  urdf: { name: string; sha256: string };
  gravity: { vector: number[]; joints: string[] };
  constants: {
    joint_limits: { epsilon: number; cap_names: string[] };
    joint_layout: { arm_label: string; coordinate_label: string; joint_unit: string; gripper_unit: string };
    arm_state: { clock_slack_s: number };
    sample_window: { min_samples: number; fresh_fraction: number };
    stability_window: Record<string, string>;
    friction_feedforward: Record<string, number>;
    robot_config: { placeholder: string };
    so101: { arm_joint_length: number; wrist_role: string; vector_length: number; gripper_index: number };
    operator_paused: string;
  };
  errors: Record<string, string[]>;
  schemas: {
    enumerations: Record<string, Record<string, string>>;
    moving_control_states: string[];
    dictionaries: Record<string, string[]>;
    dataclasses: Record<string, string[]>;
  };
  station_control: ControlSettings;
  so101_defaults: SO101Config;
  layouts: Record<string, LayoutRecord>;
  stations: Record<string, StationRecord>;
}

export const meta = loadFixture<Meta>("meta.json");

/** Returns the layout the fixtures call `name`: the SO-101's own, or one made of what PEAR's two-arm layout holds. */
export function layoutOf(name: string): JointLayout {
  if (name === "so101") {
    return LAYOUT;
  }
  const record = meta.layouts[name]!;

  return new JointLayout(record.arms, record.coordinates, record.texts);
}

const TWO_ARM_LAYOUT = layoutOf("two_arm");

/**
 * The settings of a robot with several arms, as the joint layer reads them: what PEAR's YAMConfig holds of what
 * every robot's settings hold. The YAM robot is not ported; this class exists so that the generic joint layer runs
 * on PEAR's layout of two arms, as PEAR's own tests run it.
 */
export class TwoArmConfig extends RobotConfig {
  declare arm_limits: Record<string, Limits>;

  constructor(settings: TwoArmSettings) {
    super(settings);
  }

  get LAYOUT(): JointLayout {
    return TWO_ARM_LAYOUT;
  }

  protected get className(): string {
    return "YAMConfig";
  }

  protected get fieldNames(): readonly string[] {
    return ["position_tolerance", "gripper_tolerance", "feedback_position_tolerance", "velocity_tolerance", "home", "arm_limits"];
  }

  protected override fieldValue(name: string, value: unknown): unknown {
    if (name === "arm_limits") {
      return Object.fromEntries(
        Object.entries(value as Record<string, LimitSettings>).map(([arm, limits]) => [arm, new Limits(limits)]),
      );
    }
    return super.fieldValue(name, value);
  }

  armLimits(): Record<string, Limits> {
    return this.arm_limits;
  }

  motionBlockers(): string[] {
    return [];
  }
}

/** One station of the fixtures as pear.js makes it. */
export interface Station {
  key: string;
  record: StationRecord;
  layout: JointLayout;
  controlConfig: ControlConfig;
  robotConfig: RobotConfig;
}

/**
 * Returns the station the fixtures call `key`, made anew: the SO-101's from its settings, the two arms' from what
 * every robot's settings hold; with `control`, the control loop's settings of a scenario.
 */
export function stationOf(key: string, control?: ControlSettings): Station {
  const record = meta.stations[key]!;
  const layout = layoutOf(record.layout);
  const robotConfig =
    record.layout === "so101"
      ? new SO101RobotConfig(record.settings as SO101Config, { calibrationExists: () => true })
      : new TwoArmConfig(record.settings as TwoArmSettings);

  return { key, record, layout, controlConfig: new ControlConfig(control ?? record.control), robotConfig };
}

/** Returns PEAR's nine fields of a JointLimits of pear.js. */
export function jointLimitsRecord(limits: {
  lowerBounds: readonly number[];
  upperBounds: readonly number[];
  velocity: readonly number[];
  acceleration: readonly number[];
  jerk: readonly number[];
  trackingError: readonly number[];
  stopAcceleration: readonly number[];
  stopJerk: readonly number[];
  feedbackTolerance: number;
}): JointLimitsRecord {
  return {
    lower_bounds: [...limits.lowerBounds],
    upper_bounds: [...limits.upperBounds],
    velocity: [...limits.velocity],
    acceleration: [...limits.acceleration],
    jerk: [...limits.jerk],
    tracking_error: [...limits.trackingError],
    stop_acceleration: [...limits.stopAcceleration],
    stop_jerk: [...limits.stopJerk],
    feedback_tolerance: limits.feedbackTolerance,
  };
}

/** Whether `PEAR_JS_JOINT_REPORT` asks the tests to print what they measured (for docs/progress/joint.md). */
export const REPORTS = Boolean(process.env.PEAR_JS_JOINT_REPORT);

/** Prints one line of what a test measured, when asked. */
export function report(line: string): void {
  if (REPORTS) {
    console.log(`[joint] ${line}`);
  }
}
