// Runs, in Node, a TypeScript entry of web/tests that uses the library: reads JSON from standard input (if there
// is any), calls the entry's `main` with it and prints what it returns as JSON. The library is TypeScript with
// imports a plain Node cannot resolve, so Vite loads it; no server listens and nothing is written.
//
//   node web/tests/run_node.mjs web/tests/expected_entry.ts < input.json        (from the repository's root)
//   node web/tests/run_node.mjs web/tests/transport_probe_entry.ts
//
// Node must be the one this repository's node_modules were installed for.

import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../..", import.meta.url));
const entry = process.argv[2];
if (entry === undefined) {
  console.error("usage: node web/tests/run_node.mjs <entry.ts>");
  process.exit(2);
}

async function standardInput() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);

  return Buffer.concat(chunks).toString("utf8");
}

const server = await createServer({
  root,
  configFile: false,
  logLevel: "error",
  appType: "custom",
  server: { middlewareMode: true, ws: false, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});
let exitCode = 0;
try {
  const { main } = await server.ssrLoadModule(`/${entry.replace(/\\/g, "/").replace(/^\.?\//, "")}`);
  const text = (await standardInput()).trim();
  process.stdout.write(JSON.stringify(await main(text === "" ? undefined : JSON.parse(text))));
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  exitCode = 1;
} finally {
  await server.close();
}
process.exit(exitCode);
