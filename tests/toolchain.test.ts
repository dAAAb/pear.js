import { expect, test } from "vitest";

import { PEAR_COMMIT } from "../src/index";

test("the pinned PEAR commit is a full commit hash", () => {
  expect(PEAR_COMMIT).toMatch(/^[0-9a-f]{40}$/);
});
