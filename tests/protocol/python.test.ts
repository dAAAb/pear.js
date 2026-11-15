import { describe, expect, test } from "vitest";

import { pythonFloatRepr, pythonRound } from "../../src/protocol/python_float";
import { pythonJsonDumps } from "../../src/protocol/python_json";
import { isPythonBlank, pythonStrip } from "../../src/protocol/python_text";
import { loadFixture, meta } from "./fixtures";

// each case: a float, Python's repr of it, and the repr of round(value, digits) + 0.0 for digits 0 to 3
const fixture = loadFixture<{ strings: Array<[string, string]>; cases: Array<[number, string, string[]]> }>(
  "python.json",
);

describe("pythonFloatRepr", () => {
  test.each(fixture.cases.map(([value, repr]) => [repr, value] as const))("gives %s", (repr, value) => {
    expect(Object.is(Number(repr), value)).toBe(true); // the fixture's float arrived whole
    expect(pythonFloatRepr(value)).toBe(repr);
  });

  test("names what is no number as Python does", () => {
    expect([NaN, Infinity, -Infinity].map(pythonFloatRepr)).toEqual(["nan", "inf", "-inf"]);
  });
});

describe("pythonRound", () => {
  test.each(fixture.cases.map(([value, repr, rounded]) => [repr, value, rounded] as const))(
    "rounds %s to 0, 1, 2 and 3 places as Python does",
    (_repr, value, rounded) => {
      expect([0, 1, 2, 3].map((digits) => pythonFloatRepr(pythonRound(value, digits) + 0))).toEqual(rounded);
    },
  );

  test("keeps the sign of a value it rounds to zero, and what is no number", () => {
    expect(Object.is(pythonRound(-0.04, 1), -0)).toBe(true);
    expect(Object.is(pythonRound(-0, 1), -0)).toBe(true);
    expect(pythonRound(NaN, 1)).toBeNaN();
    expect(pythonRound(-Infinity, 2)).toBe(-Infinity);
  });
});

describe("pythonJsonDumps", () => {
  test.each(fixture.strings)("escapes string %#", (text, dumped) => {
    expect(pythonJsonDumps(text)).toBe(dumped);
  });

  test("writes Python's constants", () => {
    expect(pythonJsonDumps({ a: null, b: true, c: false, d: NaN, e: Infinity, f: -Infinity, g: {} })).toBe(
      '{"a": null, "b": true, "c": false, "d": NaN, "e": Infinity, "f": -Infinity, "g": {}}',
    );
  });
});

describe("Python's whitespace", () => {
  test("is the set str.isspace gives", () => {
    const expected = new Set(meta.whitespace);
    const found: number[] = [];
    for (let code = 0; code <= 0x10ffff; code++) {
      if (isPythonBlank(String.fromCodePoint(code))) {
        found.push(code);
      }
    }

    expect(found).toEqual([...expected]);
  });

  test("is what pythonStrip removes, at the ends alone", () => {
    const all = String.fromCodePoint(...meta.whitespace);

    expect(pythonStrip(`${all}a${all}b﻿${all}`)).toBe(`a${all}b﻿`);
    expect(pythonStrip(all)).toBe("");
    expect(pythonStrip("﻿a​")).toBe("﻿a​");
  });
});
