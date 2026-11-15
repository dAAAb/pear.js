// Reads the fixtures tools/fixtures/loop_fixtures.py wrote of PEAR's own control loop, and makes the stations they
// name.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { SO101RobotConfig, type SO101Config } from "../../src/so101/config";
import type { JointLayout } from "../../src/so101/layout";
import { ControlConfig, type ControlSettings, type RobotConfig } from "../../src/station/joint/config";
import { revived, TwoArmConfig, type JointLimitsRecord, type TwoArmSettings } from "../station-joint/fixtures";

/** Where the fixtures are: the committed ones, or the directory PEAR_JS_LOOP_FIXTURES names (a larger set). */
export const DIRECTORY =
  process.env.PEAR_JS_LOOP_FIXTURES ?? fileURLToPath(new URL("../fixtures/station-loop", import.meta.url));

/** Whether the fixtures are a larger set than the committed one. */
export const IS_LARGER_SET = process.env.PEAR_JS_LOOP_FIXTURES !== undefined;

/** Returns a fixture file: plain JSON, or the gzip of it when the name ends in .gz. */
export function loadFixture<Content>(name: string): Content {
  const bytes = readFileSync(join(DIRECTORY, name));
  const text = (name.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8");

  return revived(JSON.parse(text) as Content);
}

/** Whether the table of the reference's C library values is beside the fixtures (see tests/ruckig/oracle.ts). */
export function hasLibmTable(): boolean {
  return existsSync(join(DIRECTORY, "libm.json"));
}

/** What PEAR's call returned, or the class and the message of what it raised. */
export type Outcome<Value = unknown> = { ok: Value } | { error: { type: string; message: string } };

/** Returns what was thrown in the form the fixtures record what PEAR raised. */
export function errorOutcome(error: unknown): Outcome {
  if (error instanceof Error) {
    return { error: { type: error.name, message: error.message } };
  }
  return { error: { type: typeof error, message: String(error) } };
}

/** Returns what `call` returned or threw, in the form the fixtures record PEAR's: no value reads as null. */
export function outcomeOf(call: () => unknown): Outcome {
  try {
    const value = call();
    return { ok: value === undefined ? null : value };
  } catch (error) {
    return errorOutcome(error);
  }
}

/** The same for a call that is asynchronous here. */
export async function outcomeOfAsync(call: () => unknown): Promise<Outcome> {
  try {
    const value = await call();
    return { ok: value === undefined ? null : value };
  } catch (error) {
    return errorOutcome(error);
  }
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
  rest: number[];
}

export interface Meta {
  scale: number;
  pear_commit: string;
  versions: Record<string, string>;
  constants: Record<string, unknown>;
  counts: Record<string, unknown>;
  stations: Record<string, StationRecord>;
}

export const meta = loadFixture<Meta>("meta.json");

/**
 * The settings of PEAR's two YAM arms as the joint layer reads them, with which arm is fed the planned velocity.
 * The YAM robot is not ported: the generic control loop runs on its layout, as PEAR's own tests run it.
 */
export class LoopTwoArmConfig extends TwoArmConfig {
  feedsVelocityByArm: Record<string, boolean> = {};

  override feedsVelocity(arm: string): boolean {
    return this.feedsVelocityByArm[arm] ?? true;
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

/** Returns the station the fixtures call `key`, made anew. */
export function stationOf(key: string): Station {
  const record = meta.stations[key];
  if (record === undefined) {
    throw new Error(`The fixtures hold no station ${key}`);
  }
  let robotConfig: RobotConfig;
  if (record.layout === "so101") {
    robotConfig = new SO101RobotConfig(record.settings as SO101Config, { calibrationExists: () => true });
  } else {
    const twoArms = new LoopTwoArmConfig(record.settings as TwoArmSettings);
    twoArms.feedsVelocityByArm = { ...record.feeds_velocity };
    robotConfig = twoArms;
  }

  return { key, record, layout: robotConfig.LAYOUT, controlConfig: new ControlConfig(record.control), robotConfig };
}
