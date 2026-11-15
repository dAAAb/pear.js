// Puts the reference's own C library in the place of the engine's for the five functions that no library rounds
// correctly (see src/ruckig/libm.ts), from a table of the values that library gave: libm.json beside the fixtures.
//
// With the table, the port's numbers no longer depend on the engine: every cube root, sine, cosine, arc tangent
// and arc cosine it takes is the reference's. The table holds the arguments the port asks for over its set of
// fixtures. It is built in rounds, because a value of the table changes later arguments:
//
//   npx vitest run tests/ruckig/exact.test.ts          fails, and writes missing.txt beside the fixtures
//   <work dir>/envs/station/bin/python tools/fixtures/ruckig_fixtures.py --libm tests/fixtures/ruckig
//
// until a round asks for nothing new (three or four rounds). For a larger set, RUCKIG_FIXTURES names the directory
// in both places.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { ENGINE_LIBM, replaceLibm, type Libm } from "../../src/ruckig/index";

const bits = new DataView(new ArrayBuffer(8));

function bitsOf(value: number): bigint {
  bits.setFloat64(0, value);
  return bits.getBigUint64(0);
}

export interface Oracle {
  /** The values in the table, the calls answered from it, and the distinct arguments that were not in it. */
  readonly size: number;
  readonly hits: () => number;
  readonly missing: () => number;
  /** Puts the engine's functions back, and writes the missing arguments for the next round. */
  readonly close: () => void;
}

export function installOracle(directory: string): Oracle {
  const tables: Record<keyof Libm, Map<bigint, number>> = {
    cbrt: new Map(),
    sin: new Map(),
    cos: new Map(),
    atan: new Map(),
    acos: new Map(),
  };
  const path = resolve(directory, "libm.json");
  if (existsSync(path)) {
    const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    const words = (name: string): DataView => {
      const bytes = Buffer.from(stored[name], "base64");
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    };
    for (const name of ["cbrt", "atan", "acos"] as const) {
      const view = words(name);
      for (let offset = 0; offset < view.byteLength; offset += 16) {
        tables[name].set(view.getBigUint64(offset), view.getFloat64(offset + 8));
      }
    }
    const view = words("sincos");
    for (let offset = 0; offset < view.byteLength; offset += 24) {
      tables.sin.set(view.getBigUint64(offset), view.getFloat64(offset + 8));
      tables.cos.set(view.getBigUint64(offset), view.getFloat64(offset + 16));
    }
  }

  const missing = new Set<string>();
  let hits = 0;
  const lookup = (name: keyof Libm, listed: string) => (value: number): number => {
    const argument = bitsOf(value);
    const answer = tables[name].get(argument);
    if (answer === undefined) {
      missing.add(`${listed} ${argument.toString(16).padStart(16, "0")}`);
      return ENGINE_LIBM[name](value);
    }
    hits++;
    return answer;
  };
  const restore = replaceLibm({
    cbrt: lookup("cbrt", "cbrt"),
    sin: lookup("sin", "sincos"),
    cos: lookup("cos", "sincos"),
    atan: lookup("atan", "atan"),
    acos: lookup("acos", "acos"),
  });

  return {
    size: tables.cbrt.size + tables.sin.size + tables.atan.size + tables.acos.size,
    hits: () => hits,
    missing: () => missing.size,
    close: () => {
      restore();
      const list = resolve(directory, "missing.txt");
      if (missing.size > 0) {
        writeFileSync(list, `${[...missing].sort().join("\n")}\n`);
      } else if (existsSync(list)) {
        rmSync(list);
      }
    },
  };
}
