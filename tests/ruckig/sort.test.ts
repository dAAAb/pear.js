// The order of a sort. Ruckig sorts the candidate durations of a synchronization through their indices with
// std::sort, which keeps no order among equal candidates; which index comes first decides which coordinate is taken
// as the limiting one. The fixture holds what the C++ standard library the reference was built with does.

import { describe, expect, test } from "vitest";

import { PairSet, PositiveSet, max, min } from "../../src/ruckig/roots";
import { stdSort } from "../../src/ruckig/sort";
import { load } from "./fixtures";

interface SortCase {
  k: "insertion" | "partitioned" | "minmax";
  keys: number[];
  order: number[];
}

const cases = load<SortCase>("h_sort");

describe("the order of a sort", () => {
  test.each(["insertion", "partitioned"] as const)("is the C++ standard library's: %s", (kind) => {
    const selected = cases.filter((item) => item.k === kind);
    expect(selected.length).toBeGreaterThan(15);
    // the lengths Ruckig sorts with intervals: 19 for six coordinates, 22 for seven, 43 for fourteen
    if (kind === "partitioned") {
      expect(new Set(selected.map((item) => item.keys.length))).toEqual(new Set([17, 18, 19, 20, 21, 22, 23, 24, 25, 31, 37, 43, 64, 100]));
    }

    let withTies = 0;
    for (const { keys, order } of selected) {
      const indices = keys.map((_, index) => index);
      stdSort(indices, (first, second) => keys[first] < keys[second]);
      expect(indices, `keys ${keys.join(" ")}`).toEqual(order);
      withTies += new Set(keys).size < keys.length ? 1 : 0;
    }
    expect(withTies).toBeGreaterThan(selected.length / 2);
  });

  // Ruckig takes minima and maxima of numbers that may be NaN, with std::min and std::max: each gives its first
  // argument unless the comparison says otherwise, where Math.min and Math.max give NaN for a NaN in either place.
  test("the minimum and the maximum of two numbers are the C++ standard library's", () => {
    const pairs = cases.filter((item) => item.k === "minmax");
    expect(pairs.length).toBe(49);
    expect(pairs.filter((item) => item.keys.some(Number.isNaN)).length).toBe(13);
    for (const { keys, order } of pairs) {
      expect(Object.is(min(keys[0], keys[1]), order[0]), `min(${keys[0]}, ${keys[1]})`).toBe(true);
      expect(Object.is(max(keys[0], keys[1]), order[1]), `max(${keys[0]}, ${keys[1]})`).toBe(true);
    }
  });

  test("sorts only the range it is given", () => {
    const values = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
    stdSort(values, (first, second) => first < second, 2, 7);
    expect(values).toEqual([9, 8, 3, 4, 5, 6, 7, 2, 1, 0]);
  });

  test("the sets of roots keep what is not negative and give it in ascending order", () => {
    const roots = new PositiveSet();
    [3, -1, 0.5, -0, 2, Number.NaN].forEach((value) => roots.insert(value));
    expect(roots.values()).toEqual([-0, 0.5, 2, 3]);

    const pairs = new PairSet();
    pairs.insert({ first: 2, second: 1 });
    pairs.insert({ first: 1, second: 5 });
    pairs.insert({ first: 1, second: 3 });
    expect(pairs.values()).toEqual([
      { first: 1, second: 3 },
      { first: 1, second: 5 },
      { first: 2, second: 1 },
    ]);
  });
});
