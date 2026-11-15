// Loads the fixtures tools/fixtures/ruckig_fixtures.py wrote from the ruckig Python module.
//
// The committed set is read from tests/fixtures/ruckig. A larger set written with --scale (not committed) is read
// instead when the environment variable RUCKIG_FIXTURES names its directory.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMMITTED = fileURLToPath(new URL("../fixtures/ruckig/", import.meta.url));
export const DIRECTORY = process.env.RUCKIG_FIXTURES ? resolve(process.env.RUCKIG_FIXTURES) : COMMITTED;
export const IS_COMMITTED_SET = DIRECTORY === COMMITTED;

/** The other inputs of a case, by the short names of the fixture script. */
export interface Options {
  vmin?: number[];
  amin?: number[];
  ci?: "Position" | "Velocity";
  sync?: SynchronizationName;
  disc?: boolean;
  dt?: number;
  mind?: number;
  enabled?: boolean[];
  pci?: ("Position" | "Velocity")[];
  psync?: SynchronizationName[];
  ip?: number[][];
}

export type SynchronizationName = "Time" | "TimeIfNecessary" | "Phase" | "No";

/** [duration, t, j, a, v, p] of a brake profile. */
export type BrakeRow = [number, number[], number[], number[], number[], number[]];

/** [t, j, a, v, p, [pf, vf, af], text, brake?, accel?] of one coordinate's profile. */
export type ProfileRow = [number[], number[], number[], number[], number[], number[], string, BrakeRow?, BrakeRow?];

/** A case of the sets a, b, c, d and g: one calculation. */
export interface CalculationCase {
  k: string;
  n: number;
  /** current position, velocity, acceleration; target position, velocity, acceleration; max velocity, acceleration, jerk */
  i: number[][];
  o?: Options;
  /** What calculate returned, */
  r?: number;
  /** or the message of what it raised, and the class of that unless it is RuckigError. */
  e?: string;
  et?: string;
  d: number;
  m: number[];
  id?: number[];
  p: ProfileRow[];
  x?: number[][];
  s?: [number, number[], number[], number[]][];
  f?: [number, number, number, number | null][];
}

/** One update of a session: [result, time, new_calculation, position, velocity, acceleration], or what it raised. */
export type UpdateRow = [number, number, number, number[], number[], number[]] | { e: string; et?: string };

export type Operation =
  | ["set", string, unknown]
  | ["update", UpdateRow[]]
  | ["advance", UpdateRow[]]
  | ["gripper", number, UpdateRow[]]
  | ["pass"]
  | ["calculate", { r?: number; e?: string; et?: string; d?: number; x?: number[][]; u?: number }]
  | ["reset"]
  | ["time", number]
  | ["move", number[], number[][], { r?: number; e?: string; et?: string; d?: number }]
  | ["play", [number, number[], number[], number[], number][]];

export interface Session {
  k: string;
  n: number;
  dt?: number;
  ops: Operation[];
}

/** A case of the set f: one call and what it returned or raised. */
export interface RefusedCase {
  k: string;
  n: number;
  i: number[][];
  o?: Options;
  call: "validate" | "validate_input" | "calculate" | "update" | "repr" | "repr_output";
  args?: boolean[];
  gen?: number;
  out?: number;
  returns?: boolean | number | string;
  e?: string;
  et?: string;
  d?: number;
}

export interface Meta {
  versions: { ruckig: string; python: string; machine: string };
  scale: number;
  pear: Record<string, number | number[]>;
  sets: Record<string, { cases: number; bytes: number; kinds: Record<string, number> }>;
}

/**
 * The Python module has no name for the C++'s result -101 (a duration above 7,600 s) and raises a ValueError that
 * says so, where the port returns the number. Returns that number for what the module raised, or undefined if it
 * raised something else.
 */
export function unnamedResult(answer: { e?: string; et?: string }): number | undefined {
  const match = answer.et === "ValueError" ? /^(-\d+) is not a valid Result\.$/.exec(answer.e ?? "") : null;
  return match === null ? undefined : Number(match[1]);
}

/** A number that is not finite is written as its name. */
function revive(_key: string, value: unknown): unknown {
  if (value === "nan") {
    return NaN;
  }
  if (value === "inf") {
    return Infinity;
  }
  if (value === "-inf") {
    return -Infinity;
  }
  return value;
}

/** Returns the cases of one set. A set's file holds one case a line, so that a large one need not be parsed whole. */
export function load<Case>(name: string): Case[] {
  const lines = readFileSync(resolve(DIRECTORY, `${name}.json`), "utf8").split("\n");
  const cases: Case[] = [];
  for (const line of lines) {
    if (line.startsWith("{") && !line.startsWith('{"set"')) {
      cases.push(JSON.parse(line.endsWith(",") ? line.slice(0, -1) : line, revive) as Case);
    }
  }
  return cases;
}

export const meta = (): Meta => JSON.parse(readFileSync(resolve(DIRECTORY, "meta.json"), "utf8")) as Meta;

/** How long a test over a whole set may take: the committed set's share, times the scale of a larger one. */
export const timeout = (): number => 60_000 * Math.max(1, meta().scale);
