// Gives the browser check the commit of PEAR the library is pinned to (PEAR_COMMIT of src/index.ts), which the
// page must show in its footer and in the first line of its log.
//
//   node web/tests/run_node.mjs web/tests/stamp_entry.ts

import { PEAR_COMMIT } from "../../src/index";

export async function main(): Promise<{ pearCommit: string }> {
  return { pearCommit: PEAR_COMMIT };
}
