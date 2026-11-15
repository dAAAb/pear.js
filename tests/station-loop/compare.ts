// Compares what pear.js gave with what PEAR gave, value by value: exactly (the same double, the sign of a zero
// included; the same text; the same keys in the same order), or within a tolerance for the numbers, with the largest
// deviation kept.

/** How two values are compared, and what the comparison measured. */
export class Comparison {
  /** The numbers compared and those that were the same double. */
  numbers = 0;
  identical = 0;
  /** The largest difference of two numbers, relative to the larger of 1 and the expected number, and where. */
  largest = 0;
  largestAt = "";
  /** The texts that were equal only once their numbers were rounded. */
  textsApart = 0;

  constructor(
    /** Whether a number must be the same double. */
    readonly isExact: boolean,
    /** For numbers that need not be: how far apart, relative to the larger of 1 and the expected number. */
    readonly tolerance = 1e-9,
  ) {}

  /** Returns null when `actual` is `expected`, else where they first differ and how. */
  difference(actual: unknown, expected: unknown, path = ""): string | null {
    if (typeof expected === "number") {
      if (typeof actual !== "number") {
        return `${path}: ${shown(actual)} is no number (PEAR: ${shown(expected)})`;
      }
      this.numbers += 1;
      if (Object.is(actual, expected)) {
        this.identical += 1;
        return null;
      }
      if (this.isExact || !Number.isFinite(actual) || !Number.isFinite(expected)) {
        return `${path}: ${shown(actual)} (PEAR: ${shown(expected)}; apart by ${Math.abs(actual - expected)})`;
      }
      const apart = Math.abs(actual - expected) / Math.max(1, Math.abs(expected));
      if (apart > this.largest) {
        this.largest = apart;
        this.largestAt = path;
      }
      return apart <= this.tolerance ? null : `${path}: ${shown(actual)} (PEAR: ${shown(expected)}; apart by ${apart})`;
    }
    if (typeof expected === "string") {
      if (actual === expected) {
        return null;
      }
      if (!this.isExact && typeof actual === "string" && rounded(actual) === rounded(expected)) {
        this.textsApart += 1;
        return null;
      }
      return `${path}: ${shown(actual)} (PEAR: ${shown(expected)})`;
    }
    if (expected === null || typeof expected === "boolean") {
      return actual === expected ? null : `${path}: ${shown(actual)} (PEAR: ${shown(expected)})`;
    }
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual)) {
        return `${path}: ${shown(actual)} is no list (PEAR: ${shown(expected)})`;
      }
      if (actual.length !== expected.length) {
        return `${path}: ${actual.length} items (PEAR: ${expected.length}): ${shown(actual)} (PEAR: ${shown(expected)})`;
      }
      for (let index = 0; index < expected.length; index++) {
        const found = this.difference(actual[index], expected[index], `${path}[${index}]`);
        if (found !== null) {
          return found;
        }
      }
      return null;
    }

    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
      return `${path}: ${shown(actual)} is no object (PEAR: ${shown(expected)})`;
    }
    const expectedKeys = Object.keys(expected as object);
    const actualKeys = Object.keys(actual);
    if (expectedKeys.length !== actualKeys.length || expectedKeys.some((key, index) => key !== actualKeys[index])) {
      return `${path}: keys ${actualKeys.join(",")} (PEAR: ${expectedKeys.join(",")})`;
    }
    for (const key of expectedKeys) {
      const found = this.difference(
        (actual as Record<string, unknown>)[key],
        (expected as Record<string, unknown>)[key],
        path ? `${path}.${key}` : key,
      );
      if (found !== null) {
        return found;
      }
    }
    return null;
  }

  summary(): string {
    const share = this.numbers === 0 ? "" : ` (${((100 * this.identical) / this.numbers).toFixed(3)} %)`;
    return (
      `${this.numbers} numbers, ${this.identical} the same double${share}; largest deviation ` +
      `${this.largest.toExponential(2)}${this.largestAt ? ` at ${this.largestAt}` : ""}; ` +
      `${this.textsApart} texts equal once their numbers are rounded`
    );
  }
}

/** Returns a text with every number in it rounded to nine significant digits. */
function rounded(text: string): string {
  return text.replace(/-?\d+\.\d+(?:e[-+]?\d+)?/g, (digits) => Number(digits).toPrecision(9));
}

function shown(value: unknown): string {
  if (typeof value === "number") {
    return Object.is(value, -0) ? "-0" : String(value);
  }
  const text = JSON.stringify(value) ?? String(value);

  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

/**
 * Returns a value as the fixtures hold PEAR's: no value as null, a list or an object copied with its items so, a
 * number as it is (JSON would lose the sign of a zero and a number that is not finite).
 */
export function plain(value: unknown): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(plain);
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]));
  }
  return value;
}

/**
 * Returns the state that a record of the fixtures stands for: `change` itself, or `previous` with what
 * `{"~": {key: change}}` says changed of it (the `delta` of tools/fixtures/loop_fixtures.py).
 */
export function undelta(previous: unknown, change: unknown): unknown {
  if (typeof change === "object" && change !== null && !Array.isArray(change)) {
    const keys = Object.keys(change);
    if (keys.length === 1 && keys[0] === "~") {
      const changes = (change as Record<string, Record<string, unknown>>)["~"]!;
      const state: Record<string, unknown> = { ...(previous as Record<string, unknown>) };
      for (const [key, child] of Object.entries(changes)) {
        state[key] = undelta(state[key], child);
      }
      return state;
    }
  }
  return change;
}
