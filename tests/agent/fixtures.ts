// Reads the fixtures tools/fixtures/agent_fixtures.py wrote of PEAR's own client and agent loop. What they hold
// (the types of their records, their clock, their bytes) is in ./records.ts, which needs no Node.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export * from "./records";

/** Returns the bytes of a file of this repository, by its path from the repository's root. */
export function repositoryFile(path: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)));
}

/** Returns a fixture file of the agent module: the committed one, or the one of the same name in the directory
 * PEAR_JS_AGENT_FIXTURES names (see tools/fixtures/agent_fixtures.py --output). */
export function loadFixture<T>(name: string): T {
  const directory = process.env.PEAR_JS_AGENT_FIXTURES;
  const bytes = directory ? readFileSync(join(directory, name)) : repositoryFile(`tests/fixtures/agent/${name}`);

  return JSON.parse(bytes.toString("utf8")) as T;
}
