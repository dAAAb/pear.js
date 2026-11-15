// Reads the fixtures tools/fixtures/protocol_fixtures.py wrote of PEAR's own output.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { MotionResult } from "../../src/protocol/index";

/** Returns the bytes of a file of this repository, by its path from the repository's root. */
export function repositoryFile(path: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)));
}

/** Returns a fixture file of the protocol module: the committed one, or the one of the same name in the directory
 * PEAR_JS_PROTOCOL_FIXTURES names (a larger set, see tools/fixtures/protocol_fixtures.py). */
export function loadFixture<T>(name: string): T {
  const directory = process.env.PEAR_JS_PROTOCOL_FIXTURES;
  const bytes = directory ? readFileSync(join(directory, name)) : repositoryFile(`tests/fixtures/protocol/${name}`);

  return JSON.parse(bytes.toString("utf8")) as T;
}

/** A result as the fixtures record it: the fields PEAR's feedback reads, under PEAR's names. */
export interface RecordedResult {
  status: MotionResult["status"];
  is_settled: boolean;
  target_reached: boolean;
  gripper_outcome: MotionResult["gripperOutcome"];
  error: MotionResult["error"];
}

export interface FeedbackCase {
  label: string;
  result: RecordedResult | null;
  is_dispatched: boolean;
  text: string;
}

/** Returns the result a fixture records. */
export function resultOf(recorded: RecordedResult | null): MotionResult | null {
  if (recorded === null) {
    return null;
  }

  return {
    status: recorded.status,
    isSettled: recorded.is_settled,
    targetReached: recorded.target_reached,
    measuredPosition: null,
    trackingError: null,
    measuredState: null,
    gripperOutcome: recorded.gripper_outcome,
    error: recorded.error,
  };
}

export interface Meta {
  pear_commit: string | null;
  python: string;
  format: string;
  schema: Record<string, string[]>;
  decimals: Record<string, number>;
  cameras: string[];
  think_start: string;
  unreachable_code: string;
  motion_statuses: string[];
  gripper_outcomes: string[];
  whitespace: number[];
  prompts: Record<string, { pear_path: string; sha256: string }>;
  stored_texts: {
    prompt: { instruction: string; text: string };
    observation: {
      state: { arm: Record<string, number>; gripper: { width: number } };
      feedback: string;
      parts: string[];
    };
    parse: { answers: Record<string, string>; lines: string[] };
    feedback: { cases: FeedbackCase[] };
  } | null;
}

export const meta = loadFixture<Meta>("meta.json");
