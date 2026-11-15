import { describe, expect, test } from "vitest";

import { type ModelState, shownQuantity, shownState, turnText } from "../../src/protocol/index";
import { loadFixture, meta } from "./fixtures";

interface TurnCase {
  state: ModelState;
  feedback: string | null;
  text: string;
}

const cases = loadFixture<{ cases: TurnCase[] }>("turn_text.json").cases;

describe("turnText", () => {
  test.each(cases.map((item, index) => [index, item.text.split("\n")[0], item] as const))(
    "is PEAR's text of turn %i: %s",
    (index, _label, item) => {
      // no report is given as null or left out
      const text = item.feedback === null && index % 2 ? turnText(item.state) : turnText(item.state, item.feedback);

      expect(text).toBe(item.text);
    },
  );

  test("is PEAR's stored text, without and with a report", () => {
    const stored = meta.stored_texts!.observation;
    const state = stored.state as unknown as ModelState;

    expect(turnText(state)).toBe(stored.parts[0]);
    expect(turnText(state, stored.feedback)).toBe(stored.parts[3]);
  });

  test("reads the quantities by name, whatever their order in the state", () => {
    const state = { gripper: { width: 3 }, arm: { roll: -1.66, pitch: 0.69, z: 5, y: -0.04, x: 22.71 } };

    expect(turnText(state).split("\n")[0]).toBe(
      '{"arm": {"x": 22.7, "y": 0.0, "z": 5.0, "pitch": 0.69, "roll": -1.66}, "gripper": {"width": 3.0}}',
    );
  });

  test("refuses a state that is no number, as PEAR's state model does", () => {
    const state = { arm: { x: NaN, y: 0, z: 0, pitch: 0, roll: 0 }, gripper: { width: 0 } };

    expect(() => turnText(state)).toThrow(RangeError);
    expect(() => shownQuantity(Infinity, 1)).toThrow(RangeError);
  });
});

describe("shownState", () => {
  test("rounds each quantity to its decimals and never shows -0", () => {
    const state = { arm: { x: -0.04, y: 0.25, z: 22.96, pitch: 0.125, roll: -0.004 }, gripper: { width: -0 } };

    expect(shownState(state)).toEqual({ arm: { x: 0, y: 0.2, z: 23, pitch: 0.12, roll: 0 }, gripper: { width: 0 } });
  });
});
