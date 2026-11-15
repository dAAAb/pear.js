import { describe, expect, test } from "vitest";

import {
  ActionParseError,
  executionFeedback,
  type MotionError,
  type MotionResult,
  parseAction,
  type SingleArmDelta,
} from "../../src/protocol/index";
import { pythonJsonDumps, type PythonJsonInput } from "../../src/protocol/python_json";
import { loadFixture, meta } from "./fixtures";

interface ParseCase {
  label: string;
  answer?: string;
  generated?: { kind: string; count: number }; // an answer too long to store
  action?: SingleArmDelta;
  error?: MotionError & { status: "rejected" | "failed" };
  feedback?: string; // what PEAR tells the model in the next turn of an answer it refused
}

const cases = loadFixture<{ cases: ParseCase[] }>("parse.json").cases;

/** Builds the answer of a specification, as Parsing.generated of tools/fixtures/protocol_fixtures.py does. */
function generated({ kind, count }: { kind: string; count: number }): string {
  switch (kind) {
    case "nested_objects":
      return `\`\`\`json\n${'{"a":'.repeat(count)}1${"}".repeat(count)}\n\`\`\``;
    case "nested_arrays":
      return `\`\`\`json\n{"a":${"[".repeat(count)}${"]".repeat(count)}}\n\`\`\``;
    case "arrays_then_object":
      return `\`\`\`json\n{"a":${"[".repeat(count)}{}${"]".repeat(count)}}\n\`\`\``;
    case "digits":
      return (
        `\`\`\`json\n{"arm": {"x": ${"9".repeat(count)}, "y": 0, "z": 0, "pitch": 0, "roll": 0}, ` +
        '"gripper": {"width": 0}}\n```'
      );
    default:
      throw new Error(`Unknown kind of generated answer: ${kind}`);
  }
}

/** What parseAction makes of an answer: its action or the error it throws. */
function outcome(answer: string): { action: SingleArmDelta } | { error: ActionParseError } {
  try {
    return { action: parseAction(answer) };
  } catch (error) {
    if (!(error instanceof ActionParseError)) {
      throw error;
    }
    return { error };
  }
}

/** The result PEAR's agent loop records of a turn whose answer gave no action, the arm at rest. */
function refusedTurn(error: ActionParseError): MotionResult {
  return {
    status: error.status,
    isSettled: true,
    targetReached: false,
    measuredPosition: null,
    trackingError: null,
    measuredState: null,
    gripperOutcome: null,
    error: error.error,
  };
}

/** Python's json.dumps(action, sort_keys=True). */
function dumpsSorted(action: SingleArmDelta): string {
  const sorted = (value: PythonJsonInput): PythonJsonInput =>
    value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sorted(value[key]!)]),
        )
      : value;

  return pythonJsonDumps(sorted({ type: action.type, arm: { ...action.arm }, gripper: { ...action.gripper } }));
}

describe("parseAction", () => {
  test.each(cases.map((item, index) => [index, item.label, item] as const))(
    "does as PEAR with answer %i: %s",
    (_index, _label, item) => {
      const found = outcome(item.answer ?? generated(item.generated!));

      if (item.action !== undefined) {
        expect(found).toEqual({ action: item.action }); // (-0 is not 0 here)
        expect(JSON.stringify(found)).toBe(JSON.stringify({ action: item.action })); // the fields' order too
        return;
      }
      if (!("error" in found)) {
        throw new Error(`Parsed an answer PEAR refuses with ${item.error!.code}: ${item.error!.message}`);
      }
      expect({ ...found.error.error, status: found.error.status }).toEqual(item.error);
      if (item.feedback !== undefined) {
        expect(executionFeedback(refusedTurn(found.error), { isDispatched: false })).toBe(item.feedback);
      }
    },
  );

  test("gives the lines of PEAR's stored text", () => {
    const stored = meta.stored_texts!.parse;
    const lines = Object.entries(stored.answers).map(([label, answer]) => {
      const found = outcome(answer);
      return "action" in found
        ? `${label}: ${dumpsSorted(found.action)}`
        : `${label}: ${found.error.code}: ${found.error.message}`;
    });

    expect(lines).toEqual(stored.lines);
  });

  test("parses the action example of the system prompt's environment", () => {
    const example = '{"arm": {"x": 0, "y": 0, "z": 0, "pitch": 0, "roll": 0}, "gripper": {"width": 0}}';

    expect(parseAction(`\`\`\`json\n${example}\n\`\`\``)).toEqual({
      type: "single_arm_delta",
      arm: { x: 0, y: 0, z: 0, pitch: 0, roll: 0 },
      gripper: { width: 0 },
    });
  });

  test("keeps no state between answers", () => {
    const answer = '```json\n{"arm": {"x": 1, "y": 0, "z": 0, "pitch": 0, "roll": 0}, "gripper": {"width": 0}}\n```';

    expect(parseAction(answer)).toEqual(parseAction(answer));
    expect(() => parseAction("no block")).toThrow(ActionParseError);
    expect(parseAction(answer).arm.x).toBe(1);
  });
});
