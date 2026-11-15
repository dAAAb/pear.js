import { describe, expect, test } from "vitest";

import { executionFeedback, INTERRUPTED_FEEDBACK, turnText } from "../../src/protocol/index";
import { type FeedbackCase, loadFixture, meta, resultOf } from "./fixtures";

const cases = loadFixture<{ cases: FeedbackCase[] }>("feedback.json").cases;

describe("executionFeedback", () => {
  test.each(cases.map((item, index) => [index, item.label, item] as const))(
    "is PEAR's report of result %i: %s",
    (_index, _label, item) => {
      expect(executionFeedback(resultOf(item.result), { isDispatched: item.is_dispatched })).toBe(item.text);
    },
  );

  test("gives the lines of PEAR's stored text", () => {
    for (const item of meta.stored_texts!.feedback.cases) {
      expect(executionFeedback(resultOf(item.result), { isDispatched: item.is_dispatched })).toBe(item.text);
    }
  });

  test("covers every status and every gripper outcome PEAR has", () => {
    const results = cases.flatMap((item) => (item.result === null ? [] : [item.result]));

    expect(new Set(results.map((result) => result.status))).toEqual(new Set(meta.motion_statuses));
    expect(new Set(results.flatMap((result) => result.gripper_outcome ?? []))).toEqual(new Set(meta.gripper_outcomes));
    expect(cases.some((item) => item.result === null && item.text === INTERRUPTED_FEEDBACK)).toBe(true);
  });

  test("is what the next turn shows after the state", () => {
    const state = { arm: { x: 22.7, y: 0, z: 5, pitch: 0.69, roll: -1.66 }, gripper: { width: 6 } };
    const report = executionFeedback(resultOf(cases[2]!.result), { isDispatched: true });

    expect(turnText(state, report).endsWith(`\n\nPrevious execution: ${report}`)).toBe(true);
  });
});
