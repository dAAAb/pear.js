// Reads the fixtures tools/fixtures/robot_fixtures.py wrote of PEAR's own motion layer and robot, and makes the
// stations they name.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import {
  isValueError,
  KeyError,
  OSError,
  PythonException,
  pythonErrorMessage,
  pythonErrorName,
  RuntimeError,
  TimeoutError,
  ValueError,
} from "../../src/python/errors";
import { pythonStringRepr } from "../../src/python/repr";
import { SO101RobotConfig, type SO101Config } from "../../src/so101/config";
import { ServoFault } from "../../src/so101/hardware/arm_state";
import { UnreachablePoseError } from "../../src/so101/kinematics/errors";
import { OperatorPaused } from "../../src/station/exceptions";
import { ControlConfig, type ControlSettings } from "../../src/station/joint/config";
import { GripperEndpointTimeout } from "../../src/station/joint/operations";
import { StabilityError, type StabilityMetrics } from "../../src/station/joint/stability";
import { HomeFailed } from "../../src/station/motion/homing";
import { HomePlanningError } from "../../src/station/motion/planning";
import { plain } from "../station-loop/compare";

/** Where the fixtures are: the committed ones, or the directory PEAR_JS_ROBOT_FIXTURES names (a larger set). */
export const DIRECTORY =
  process.env.PEAR_JS_ROBOT_FIXTURES ?? fileURLToPath(new URL("../fixtures/station-robot", import.meta.url));

/** Whether the fixtures are a larger set than the committed one. */
export const IS_LARGER_SET = process.env.PEAR_JS_ROBOT_FIXTURES !== undefined;

/**
 * Returns a value of a fixture as the script that wrote it held it: `{"$": "nan"}` as the number it stands for
 * (JSON has none for NaN and the infinities), `{"$rows": [count, row]}` as `count` copies of `row`.
 */
export function revived<Value>(value: Value): Value {
  if (Array.isArray(value)) {
    return value.map(revived) as Value;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 1 && entries[0]![0] === "$") {
      return { nan: NaN, inf: Infinity, "-inf": -Infinity }[entries[0]![1] as string] as Value;
    }
    if (entries.length === 1 && entries[0]![0] === "$rows") {
      const [count, row] = entries[0]![1] as [number, unknown];
      return Array.from({ length: count }, () => revived(row)) as Value;
    }
    return Object.fromEntries(entries.map(([key, child]) => [key, revived(child)])) as Value;
  }
  return value;
}

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

/** What a fixture keeps of an exception PEAR raised. */
export interface RecordedError {
  type: string;
  message: string;
  is_value_error: boolean;
  details?: unknown;
  cause?: { type: string; message: string };
}

/** What PEAR's call returned, or what it raised. */
export type Outcome<Value = unknown> = { ok: Value } | { error: RecordedError };

/**
 * Returns what a fixture keeps of an exception, of what was thrown here: its class (the Python class's name), its
 * message, whether PEAR's callers reject for it (a ValueError) or fail, what it recorded and what caused it
 * (`error_record` of tools/fixtures/robot_fixtures.py).
 */
export function errorRecord(error: unknown): RecordedError {
  const record: RecordedError = {
    type: pythonErrorName(error),
    message: pythonErrorMessage(error),
    is_value_error: isValueError(error),
  };
  const details = (error as { details?: unknown } | null)?.details;
  if (details !== undefined && details !== null) {
    record.details = plain(details);
  }
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause !== undefined && cause !== null) {
    record.cause = { type: pythonErrorName(cause), message: pythonErrorMessage(cause) };
  }

  return record;
}

/** Returns what `call` returned, under `ok` and as `shown` gives it, or what it threw, under `error`. */
export function outcomeOf<Value>(call: () => Value, shown: (value: Value) => unknown = plain): Outcome {
  let value: Value;
  try {
    value = call();
  } catch (error) {
    return { error: errorRecord(error) };
  }

  return { ok: shown(value) };
}

/** The same of a call that is asynchronous here. */
export async function outcomeOfAsync<Value>(
  call: () => Value | Promise<Value>,
  shown: (value: Value) => unknown = plain,
): Promise<Outcome> {
  let value: Value;
  try {
    value = await call();
  } catch (error) {
    return { error: errorRecord(error) };
  }

  return { ok: shown(value) };
}

/** An exception a script names: its class, its message, and what a StabilityError or a HomeFailed records. */
export interface ErrorSpec {
  type: string;
  message: string;
  metrics?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

const ERROR_CLASSES: Record<string, new (message: string) => Error> = {
  Exception: PythonException,
  RuntimeError,
  ValueError,
  TimeoutError,
  OSError,
  KeyError,
  OperatorPaused,
  UnreachablePoseError,
  ServoFault,
  GripperEndpointTimeout,
  HomePlanningError,
};

/**
 * Returns the exception a script names by its class and its message (`make_error` of the fixture script). With
 * `isWholeMessage`, the message is the exception's whole text as Python prints it (a KeyError's key in quotes, a
 * StabilityError's reason with what it measured); else it is what the exception was made with.
 */
export function makeError(spec: ErrorSpec, isWholeMessage = false): Error {
  if (spec.type === "StabilityError") {
    const reason = isWholeMessage ? spec.message.slice(0, spec.message.indexOf(": ")) : spec.message;
    return new StabilityError(reason, structuredClone(spec.metrics) as StabilityMetrics);
  }
  if (spec.type === "HomeFailed") {
    return new HomeFailed(spec.message, structuredClone(spec.details) as Record<string, unknown>);
  }
  const errorClass = ERROR_CLASSES[spec.type];
  if (errorClass === undefined) {
    throw new Error(`No error class ${spec.type}`);
  }
  // Python prints a KeyError as its key in quotes; the library's KeyError is given that text
  const message = spec.type === "KeyError" && !isWholeMessage ? pythonStringRepr(spec.message) : spec.message;

  return new errorClass(message);
}

export interface StationRecord {
  control: ControlSettings;
  control_period_s: number;
  settings: SO101Config;
}

export interface Meta {
  scale: number;
  pear_commit: string;
  versions: Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constants: Record<string, any>;
  counts: Record<string, unknown>;
  stations: Record<string, StationRecord>;
}

export const meta = loadFixture<Meta>("meta.json");

/** One station of the fixtures as pear.js makes it. */
export interface Station {
  key: string;
  record: StationRecord;
  /** The station's configuration as a robot is made from it. */
  config: { control: ControlSettings; robot: SO101Config };
  controlConfig: ControlConfig;
  robotConfig: SO101RobotConfig;
}

/** How the settings of the fixtures' stations learn of the arm's calibration: the calibration of PEAR's tests is
 * beside their station's file, so it exists. */
export const CONFIG_OPTIONS = { calibrationExists: () => true };

/** Returns the station the fixtures call `key`, made anew: PEAR's two configurations of it. */
export function stationOf(key: string): Station {
  const record = meta.stations[key];
  if (record === undefined) {
    throw new Error(`The fixtures hold no station ${key}`);
  }

  return {
    key,
    record,
    config: { control: record.control, robot: record.settings },
    controlConfig: new ControlConfig(record.control),
    robotConfig: new SO101RobotConfig(record.settings, CONFIG_OPTIONS),
  };
}
