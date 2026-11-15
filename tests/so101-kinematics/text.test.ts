import { describe, expect, test } from "vitest";

import { BaseKinematics } from "../../src/so101/kinematics/base";
import { ValueError } from "../../src/so101/kinematics/errors";
import { SO101Kinematics } from "../../src/so101/kinematics/kinematics";
import { JointLimits } from "../../src/so101/kinematics/limits";
import { formatFixed, formatGeneral, formatTemplate, pythonRound } from "../../src/so101/kinematics/text";
import { LAYOUT } from "../../src/so101/layout";
import { meta, texts } from "./fixtures";

const fixture = texts();

describe("the texts PEAR words from numbers", () => {
  test(`truncated_text equals PEAR's on ${fixture.truncated_cases.length} values`, () => {
    const differing = fixture.truncated_cases.filter(
      ({ value, decimals, text }) => BaseKinematics.truncatedText(value, decimals) !== text,
    );

    expect(differing).toEqual([]);
  });

  test(`unreachable_message equals PEAR's on ${fixture.message_cases.length} increments`, () => {
    const differing = fixture.message_cases
      .map(({ delta, fraction, text }) => ({ text, ours: SO101Kinematics.unreachableMessage(delta, fraction) }))
      .filter(({ text, ours }) => ours !== text);

    expect(differing).toEqual([]);
  });

  test(`the bounds check refuses what PEAR's refuses, in its words, on ${fixture.bounds_cases.length} vectors`, () => {
    const { lower_bounds: lower, upper_bounds: upper, feedback_tolerance: tolerance } = meta().limits;
    const limits = new JointLimits(lower, upper, tolerance);
    const named: Record<string, number> = { nan: NaN, inf: Infinity, "-inf": -Infinity };

    const differing = fixture.bounds_cases.flatMap((bounds) => {
      const vector = bounds.vector.map((value) => (typeof value === "string" ? named[value]! : value));
      let message: string | null = null;
      try {
        limits.checkPositions(vector, LAYOUT, bounds.tolerance);
      } catch (error) {
        expect(error).toBeInstanceOf(ValueError);
        message = (error as Error).message;
      }
      return message === bounds.message ? [] : [{ vector, expected: bounds.message, ours: message }];
    });

    expect(differing).toEqual([]);
    expect(fixture.bounds_cases.some((bounds) => bounds.message === null)).toBe(true);
    expect(fixture.bounds_cases.filter((bounds) => bounds.message !== null).length).toBeGreaterThan(50);
  });
});

describe("Python's number formats", () => {
  // The expected texts are PEAR's, in the fixtures. These tests check that the fixtures hold the cases on which
  // JavaScript's own formats differ from Python's, so that the comparisons above cover them.
  test("the fixture's increments exercise the general format: exponents, a carry and ties to the even digit", () => {
    const worded = (value: number): string | undefined =>
      fixture.message_cases.find(({ delta }) => delta.filter((other) => other !== 0).length === 1 && delta.includes(value))?.text;

    for (const value of [1234565, 100000.5, 999999.5, 1234567, 0.00001, 0.0001, 1e16, 1.5e-7, 0.000123456789, 1 / 3]) {
      const text = worded(value);
      expect(text, `no message for ${value}`).toBeDefined();
      expect(text).toContain(` of ${formatGeneral(value, true)})`);
    }
    // 1234565 and 100000.5 are exact ties at six digits, which toPrecision rounds upward and Python to the even digit
    expect((1234565).toPrecision(6)).not.toBe(formatGeneral(1234565).replace("e+06", "e+6"));
    expect((100000.5).toPrecision(6)).not.toBe(formatGeneral(100000.5));
  });

  test("the fixture's bounds exercise a tie of the fixed format, which toFixed rounds upward", () => {
    const tie = fixture.bounds_cases.find(({ vector }) => vector[0] === 2.0078125);

    expect(tie?.message).toContain(`shoulder_pan=${formatFixed(2.0078125, 6)} rad`);
    expect(tie?.message).toContain(`gripper=${formatFixed(1.5078125, 6)} opening`);
    expect((2.0078125).toFixed(6)).not.toBe(formatFixed(2.0078125, 6));
    expect(pythonRound(2.0078125, 6)).toBe(Number(formatFixed(2.0078125, 6)));
  });

  test("a value that is not finite is worded as Python words it", () => {
    // PEAR's models refuse such a number before any text is made of it: this is what Python's formats would say
    expect(formatGeneral(Infinity, true)).toBe("+inf");
    expect(formatGeneral(-Infinity)).toBe("-inf");
    expect(formatGeneral(NaN)).toBe("nan");
    expect(formatFixed(NaN, 1, true)).toBe("+nan");
    expect(Number.isNaN(pythonRound(NaN, 1))).toBe(true);
  });

  test("a template takes texts and fixed-point numbers, and nothing it would word differently from Python", () => {
    expect(formatTemplate("{axis}={value:.6f} {unit}", { axis: "gripper", value: 1.08, unit: "opening", extra: 1 })).toBe(
      "gripper=1.080000 opening",
    );
    expect(() => formatTemplate("{value}", { value: 1.5 })).toThrow(TypeError);
    expect(() => formatTemplate("{value:.2f}", { value: "1.5" })).toThrow(TypeError);
  });
});
