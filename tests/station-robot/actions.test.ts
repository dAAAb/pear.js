import { afterAll, describe, expect, test } from "vitest";

import { ValueError } from "../../src/python/errors";
import { ActionAdapter, ValidationError } from "../../src/station/motion/actions";
import type { StrictModelClass } from "../../src/station/motion/actions";
import {
  ArmQuantities,
  GripperAction,
  GripperQuantity,
  JointPositions,
  ModelState,
  SingleArmDelta,
} from "../../src/so101/motion/actions";
import { SINGLE_ARM_POSE_FORMAT } from "../../src/so101/formats";
import { loadFixture, type Outcome } from "./fixtures";

interface ModelFields {
  class: "SingleArmDelta" | "GripperAction" | "JointPositions" | "ModelState" | "ArmQuantities" | "GripperQuantity";
  fields: Record<string, unknown>;
}

interface ActionCase {
  kind: string;
  via: "adapter" | keyof typeof MODELS;
  input: unknown;
  out: Outcome<ModelFields>;
  as_ints?: Outcome<ModelFields>;
}

interface InstanceCase {
  class: keyof typeof MODELS;
  fields: Record<string, unknown>;
  instance_of: Record<keyof typeof MODELS, boolean>;
}

interface ActionFixture {
  adapter_cases: ActionCase[];
  model_cases: ActionCase[];
  whole_float_cases: ActionCase[];
  instance_cases: InstanceCase[];
}

const fixture = loadFixture<ActionFixture>("parts.json.gz");
const MODELS = {
  SingleArmDelta,
  GripperAction,
  JointPositions,
  ModelState,
  ArmQuantities,
  GripperQuantity,
} as const;
const ACTION_MODELS = [JointPositions, SingleArmDelta, GripperAction] as const;
const adapter = new ActionAdapter(JointPositions, SingleArmDelta, GripperAction);
const expectedRefusals = [
  ...fixture.adapter_cases.map((record) => record.out),
  ...fixture.model_cases.map((record) => record.out),
  ...fixture.whole_float_cases.map((record) => record.as_ints as Outcome<ModelFields>),
].filter((outcome) => "error" in outcome).length;
let comparedRefusals = 0;

function expectKeyOrder(actual: unknown, expected: unknown): void {
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual)).toBe(true);
    expected.forEach((child, index) => expectKeyOrder((actual as unknown[])[index], child));
    return;
  }
  if (typeof expected === "object" && expected !== null) {
    expect(typeof actual).toBe("object");
    expect(actual).not.toBeNull();
    expect(Object.keys(actual as object)).toEqual(Object.keys(expected));
    for (const key of Object.keys(expected)) {
      expectKeyOrder(
        (actual as Record<string, unknown>)[key],
        (expected as Record<string, unknown>)[key],
      );
    }
  }
}

function casesOf(kind: string): ActionCase[] {
  return fixture.adapter_cases.filter((record) => record.kind === kind);
}

function refusalOf(record: ActionCase): string {
  return "error" in record.out ? record.out.error.message : "";
}

function validate(record: ActionCase): unknown {
  if (record.via === "adapter") {
    return adapter.validate(record.input);
  }

  return MODELS[record.via].modelValidate(record.input);
}

function expectCase(record: ActionCase, expected: Outcome<ModelFields>): void {
  if ("ok" in expected) {
    const actual = validate(record);
    const model = MODELS[expected.ok.class] as StrictModelClass<unknown>;
    expect(model.name).toBe(expected.ok.class);
    expect(model.isInstance(actual)).toBe(true);
    expect(actual).toEqual(expected.ok.fields);
    expectKeyOrder(actual, expected.ok.fields);
    return;
  }

  try {
    validate(record);
    expect.unreachable("PEAR refused this input");
  } catch (caught) {
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught).toBeInstanceOf(ValueError);
    expect((caught as Error).constructor.name).toBe(expected.error.type);
    expect((caught as Error).name).toBe(expected.error.type);
    expect((caught as Error).message).toBe(expected.error.message);
    comparedRefusals += 1;
  }
}

describe("PEAR action fixtures", () => {
  test("fixture sections have the required coverage", () => {
    expect(fixture.adapter_cases.length).toBeGreaterThanOrEqual(939);
    expect(fixture.model_cases.length).toBeGreaterThanOrEqual(297);
    expect(fixture.whole_float_cases.length).toBeGreaterThanOrEqual(22);
    expect(fixture.instance_cases.length).toBe(6);
  });

  test("the fixtures hold a list past its maximum with a bad item, at each level", () => {
    // PEAR counts an item once it is validated, valid or not: the length error alone stands for the list
    const rows = casesOf("too long: a row with a bad item");
    expect(rows.length).toBeGreaterThanOrEqual(26);
    for (const record of rows) {
      expect(JSON.stringify(record.input)).toMatch(/"x"|null|true|\{"a":1\.5\}|\[1\.5\]|""/); // (NaN is null here)
      expect(refusalOf(record)).toMatch(
        /^1 validation error for [^\n]+\njoint_positions\.positions\.0\n {2}List should have at most 6 items after validation, not \d+ \[type=too_long, /,
      );
    }
    const chunks = casesOf("too long: the rows");
    expect(chunks.length).toBeGreaterThanOrEqual(8);
    for (const record of chunks) {
      const positions = (record.input as { positions: unknown[] }).positions;
      expect(positions.length).toBeGreaterThan(1000);
      expect(positions.some((row) => !Array.isArray(row) || row.length !== 6 || row.includes("x"))).toBe(true);
      expect(refusalOf(record)).toMatch(
        /\njoint_positions\.positions\n {2}List should have at most 1000 items after validation, not \d+ \[type=too_long, /,
      );
      expect(refusalOf(record)).not.toMatch(/positions\.\d/);
    }
    // a row that is too long is one error of the rows, which go on: each of these holds another row's error too
    const among = casesOf("too long: a row among others").map(refusalOf);
    expect(among.filter((text) => /^2 validation errors /.test(text)).length).toBeGreaterThanOrEqual(5);
    expect(among.filter((text) => /^3 validation errors /.test(text)).length).toBeGreaterThanOrEqual(1);
  });

  test("the fixtures hold shown inputs that PEAR cuts within its 50 bytes, between characters", () => {
    const shown = fixture.adapter_cases
      .filter((record) => record.kind.startsWith("shown input: "))
      .flatMap((record) => [...refusalOf(record).matchAll(/input_value=(.*), input_type=[a-z]+\]\n/g)])
      .map((match) => match[1] as string);
    const bytes = (text: string): number => new TextEncoder().encode(text).length;
    const cut = shown.filter((text) => text.includes("...")).map((text) => text.split("..."));
    const fronts = new Set(cut.map((halves) => bytes(halves[0] as string)));
    const backs = new Set(cut.map((halves) => bytes(halves[halves.length - 1] as string)));
    // the front is the 25 bytes less up to 3 of a character that is split, the back the 24 less up to 3
    expect([...fronts].sort()).toEqual([22, 23, 24, 25]);
    expect([...backs].sort()).toEqual([21, 22, 23, 24]);
    // and inputs of exactly 50 bytes are shown whole, in fewer than 50 characters
    const whole = shown.filter((text) => !text.includes("...") && bytes(text) === 50);
    expect(whole.filter((text) => text.length < 50).length).toBeGreaterThanOrEqual(6);
    expect(cut.filter((halves) => halves.join("").length < 49).length).toBeGreaterThanOrEqual(100);
  });

  test("the fixtures hold a gripper's target at each end of its range and just outside", () => {
    for (const cases of [fixture.adapter_cases, fixture.model_cases]) {
      const targets = cases
        .filter((record) => record.kind === "chunk grippers: at the bounds")
        .map((record) => {
          const openings = (record.input as { positions: number[][] }).positions.map((row) => row[5] as number);
          const target = openings.find((opening) => opening !== 0.25) as number;
          // PEAR takes a target within [0, 1], the float -0.0 among them, and refuses the nearest float outside
          expect("ok" in record.out).toBe(0 <= target && target <= 1);
          return target;
        });
      for (const target of [0, -0, 1, 5e-324, 1 - 2 ** -53, -5e-324, 1 + 2 ** -52]) {
        expect(targets.filter((value) => Object.is(value, target)).length).toBeGreaterThanOrEqual(3);
      }
    }
  });

  test("the fixtures hold a chunk with a gripper outside its range and a key that is none of its fields", () => {
    // PEAR checks the grippers' range last, of a chunk whose fields and keys it has taken: with a key that is no
    // field it refuses the key, and the range is not checked
    for (const cases of [fixture.adapter_cases, fixture.model_cases]) {
      const alone = cases.filter((record) => record.kind === "chunk grippers: outside their range");
      const withKey = cases.filter(
        (record) => record.kind === "chunk grippers: outside their range, with an extra key",
      );
      expect(alone.length).toBeGreaterThanOrEqual(5);
      expect(withKey.length).toBe(alone.length);
      alone.forEach((record, index) => {
        expect(refusalOf(record)).toMatch(
          /^1 validation error for [^\n]+\n(joint_positions\n)? {2}Value error, Gripper targets must be within \[0, 1\] \[type=value_error, /,
        );
        // the same chunk with the key, or the two: each key is refused and nothing else is
        const other = withKey[index] as ActionCase;
        const chunk = record.input as Record<string, unknown>;
        const fields = { ...(other.input as Record<string, unknown>) };
        const keys = Object.keys(fields).filter((key) => !(key in chunk));
        expect(keys.length).toBeGreaterThanOrEqual(1);
        for (const key of keys) {
          delete fields[key];
        }
        expect(fields).toEqual(chunk);
        expect(refusalOf(other)).not.toContain("Gripper targets");
        expect(refusalOf(other).match(/\[type=[a-z_]+, /g)).toEqual(keys.map(() => "[type=extra_forbidden, "));
      });
    }
  });

  describe("ActionAdapter", () => {
    test.each(fixture.adapter_cases.map((record, index) => [index, record] as const))(
      "case %i",
      (_index, record) => {
        expectCase(record, record.out);
      },
    );
  });

  describe("modelValidate", () => {
    test.each(fixture.model_cases.map((record, index) => [index, record] as const))(
      "case %i",
      (_index, record) => {
        expectCase(record, record.out);
      },
    );
  });

  describe("whole floats become JavaScript's integer-valued numbers", () => {
    test.each(fixture.whole_float_cases.map((record, index) => [index, record] as const))(
      "case %i",
      (_index, record) => {
        expectCase(record, record.as_ints as Outcome<ModelFields>);
      },
    );
  });
});

test("the format's action model is SingleArmDelta: it takes and refuses what PEAR's model does, in PEAR's words", () => {
  // PEAR: SINGLE_ARM_POSE_FORMAT.action_model is the class SingleArmDelta, which a caller validates an action with
  const cases = fixture.model_cases.filter((record) => record.via === "SingleArmDelta");
  let refused = 0;
  for (const record of cases) {
    if ("ok" in record.out) {
      expect(SINGLE_ARM_POSE_FORMAT.actionModel(record.input)).toEqual(record.out.ok.fields);
    } else {
      refused += 1;
      expect(() => SINGLE_ARM_POSE_FORMAT.actionModel(record.input)).toThrowError(
        expect.objectContaining({ name: record.out.error.type, message: record.out.error.message }),
      );
    }
  }
  expect(cases.length).toBeGreaterThanOrEqual(80);
  expect(refused).toBeGreaterThanOrEqual(60);
});

test("isInstance tells the three action models apart", () => {
  const actions = [
    JointPositions.modelValidate({ positions: [[0, 0, 0, 0, 0, 0.5]], rate_hz: 10 }),
    SingleArmDelta.modelValidate({
      arm: { x: 0, y: 0, z: 0, pitch: 0, roll: 0 },
      gripper: { width: 0 },
    }),
    GripperAction.modelValidate({ command: "open" }),
  ];

  expect(actions.map((action) => ACTION_MODELS.map((model) => model.isInstance(action)))).toEqual([
    [true, false, false],
    [false, true, false],
    [false, false, true],
  ]);
});

test("isInstance takes a value for its own model alone, as PEAR's isinstance does", () => {
  // PEAR's classes are apart: an action of the single-arm format holds a ModelState's fields and is none
  expect(fixture.instance_cases.map((record) => record.class).sort()).toEqual(Object.keys(MODELS).sort());
  for (const record of fixture.instance_cases) {
    const value = MODELS[record.class].modelValidate(record.fields);
    const instanceOf = Object.fromEntries(
      Object.entries(MODELS).map(([name, model]) => [name, (model as StrictModelClass<unknown>).isInstance(value)]),
    );
    expect({ class: record.class, instanceOf }).toEqual({ class: record.class, instanceOf: record.instance_of });
    expect(Object.values(record.instance_of).filter(Boolean)).toEqual([true]);
  }
});

test("ActionAdapter builds its title and expected tags from the models it receives", () => {
  const otherAdapter = new ActionAdapter(GripperAction, SingleArmDelta);
  expect(() => otherAdapter.validate({ type: "none" })).toThrowError(
    "1 validation error for tagged-union[GripperAction,SingleArmDelta]\n" +
      "  Input tag 'none' found using 'type' does not match any of the expected tags: 'gripper', " +
      "'single_arm_delta' [type=union_tag_invalid, input_value={'type': 'none'}, input_type=dict]\n" +
      "    For further information visit https://errors.pydantic.dev/2.13/v/union_tag_invalid",
  );
});

afterAll(() => {
  expect(comparedRefusals).toBeGreaterThanOrEqual(400);
  expect(comparedRefusals).toBe(expectedRefusals);
});
