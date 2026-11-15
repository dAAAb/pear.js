// How Python writes a number and a text (src/python: float.ts, format.ts, repr.ts, str.ts), against what Python
// itself wrote in tests/python/reference.json. The library keeps one function for each of these; a module that is
// given another one, or a function that starts to round or to quote differently, fails here.

import { describe, expect, test } from "vitest";

import { python } from "../../src/index";
import { fromBits, isSameFloat, reference, textOf } from "./reference";

const { formatFixed, formatGeneral, isPythonPrintable, pythonFloatRepr, pythonRound, pythonStringRepr, pythonStrRepr } = python;

const floats = reference.floats;
const texts = reference.texts.values.map((recorded) => ({ text: textOf(recorded.code_points), repr: recorded.repr }));

/** Whether the engine shows ``codePoint`` where Python's table escapes it: assigned after Python's Unicode version. */
function isShownByEngineOnly(codePoint: number): boolean {
  const character = String.fromCodePoint(codePoint);

  return !isPythonPrintable(codePoint) && pythonStrRepr(character) === `'${character}'`;
}

describe("a number as Python writes it", () => {
  test("the reference holds doubles of every kind", () => {
    const values = floats.values.map((recorded) => fromBits(recorded.bits));

    expect(values.length).toBeGreaterThanOrEqual(346);
    expect(values.some((value) => Number.isNaN(value))).toBe(true);
    expect(values.some((value) => Object.is(value, -0))).toBe(true);
    expect(values.some((value) => value === Infinity) && values.some((value) => value === -Infinity)).toBe(true);
    expect(values.some((value) => Math.abs(value) > 1e300)).toBe(true);
    expect(values.some((value) => value !== 0 && Math.abs(value) < 1e-300)).toBe(true);
    expect(floats.decimals).toEqual([0, 1, 2, 3, 6, 17]);
  });

  test("repr() of a float", () => {
    const differing = floats.values.filter((recorded) => pythonFloatRepr(fromBits(recorded.bits)) !== recorded.repr);

    expect(differing.map((recorded) => recorded.repr)).toEqual([]);
  });

  test("round(x, n) is Python's float, to the sign of a zero", () => {
    const differing: string[] = [];
    let compared = 0;
    for (const recorded of floats.values) {
      const value = fromBits(recorded.bits);
      floats.decimals.forEach((decimals, index) => {
        compared += 1;
        if (!isSameFloat(pythonRound(value, decimals), recorded.round[index]!)) {
          differing.push(`round(${recorded.repr}, ${decimals}) = ${pythonRound(value, decimals)}`);
        }
      });
      // more decimals than a double has: the value itself (the engine's toFixed refuses more than 100)
      compared += 1;
      if (!isSameFloat(pythonRound(value, floats.many_decimals), recorded.round_many)) {
        differing.push(`round(${recorded.repr}, ${floats.many_decimals})`);
      }
    }

    expect(differing).toEqual([]);
    expect(compared).toBe(floats.values.length * (floats.decimals.length + 1));
  });

  test("round(x, n) is the float of the fixed-point text, and a tie goes to the even digit", () => {
    for (const recorded of floats.values) {
      const value = fromBits(recorded.bits);
      if (!Number.isFinite(value)) {
        continue;
      }
      floats.decimals.forEach((decimals, index) => {
        expect(Object.is(pythonRound(value, decimals), Number(recorded.fixed[index]))).toBe(true);
      });
    }
    expect([pythonRound(0.5, 0), pythonRound(1.5, 0), pythonRound(2.5, 0)]).toEqual([0, 2, 2]);
    expect([pythonRound(2.25, 1), pythonRound(0.125, 2), pythonRound(2.675, 2)]).toEqual([2.2, 0.12, 2.67]);
    expect(Object.is(pythonRound(-0.04, 1), -0)).toBe(true);
    expect(() => pythonRound(1234.5, -1)).toThrow(RangeError);
  });

  test('format(x, ".nf"), "+.nf", "g" and "+g"', () => {
    const differing: string[] = [];
    for (const recorded of floats.values) {
      const value = fromBits(recorded.bits);
      const ours = {
        fixed: floats.decimals.map((decimals) => formatFixed(value, decimals)),
        fixed_plus: floats.plus_decimals.map((decimals) => formatFixed(value, decimals, true)),
        general: formatGeneral(value),
        general_plus: formatGeneral(value, true),
      };
      const theirs = {
        fixed: recorded.fixed,
        fixed_plus: recorded.fixed_plus,
        general: recorded.general,
        general_plus: recorded.general_plus,
      };
      if (JSON.stringify(ours) !== JSON.stringify(theirs)) {
        differing.push(`${recorded.repr}: ${JSON.stringify(ours)} against ${JSON.stringify(theirs)}`);
      }
    }

    expect(differing).toEqual([]);
  });
});

describe("a text as Python's repr() writes it", () => {
  test("the reference holds quotes, escapes, every plane, lone surrogates and code points Python does not know", () => {
    const all = texts.map(({ text }) => text).join("");

    expect(texts.length).toBeGreaterThanOrEqual(201);
    expect(reference.texts.unicode).toBe("15.0.0");
    for (const needed of ["'", '"', "\\", "\n", "\x7f", "\xa0", "\u2028", "\ud800", "\u{1f600}", "\u{10ffff}"]) {
      expect(all.includes(needed)).toBe(true);
    }
    for (const codePoint of reference.texts.later_code_points) {
      expect(all.includes(String.fromCodePoint(codePoint))).toBe(true);
      expect(isPythonPrintable(codePoint)).toBe(false);
    }
  });

  test("pythonStringRepr, which reads Python's own table, is Python's repr() of every text", () => {
    const differing = texts.filter(({ text, repr }) => pythonStringRepr(text) !== repr);

    expect(differing.map(({ repr }) => repr)).toEqual([]);
  });

  test("pythonStrRepr, which asks the engine, differs only where the engine knows a newer Unicode", () => {
    let differing = 0;
    for (const { text, repr } of texts) {
      if (pythonStrRepr(text) !== repr) {
        differing += 1;
        // the only difference there is: a code point Python escapes and this engine shows
        expect(Array.from(text, (character) => character.codePointAt(0)!).some(isShownByEngineOnly)).toBe(true);
        expect(pythonStringRepr(text)).toBe(repr);
      }
    }

    // (0 on an engine of Python's Unicode version; the reference names code points assigned later)
    const later = reference.texts.later_code_points.filter(isShownByEngineOnly).length;
    expect(differing > 0).toBe(later > 0);
  });

  test("over every code point the two differ in one direction only: the engine shows what Python escapes", () => {
    let shownByEngineOnly = 0;
    const others: number[] = [];
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
      const character = String.fromCodePoint(codePoint);
      if (pythonStrRepr(character) === pythonStringRepr(character)) {
        continue;
      }
      if (isShownByEngineOnly(codePoint)) {
        shownByEngineOnly += 1;
      } else {
        others.push(codePoint);
      }
    }

    expect(others).toEqual([]);
    // none on an engine of Python's Unicode version; a newer engine knows some the reference names
    const named = reference.texts.later_code_points.filter(isShownByEngineOnly).length;
    expect(shownByEngineOnly === 0).toBe(named === 0);
  });
});
