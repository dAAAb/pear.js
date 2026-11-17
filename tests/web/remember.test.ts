// The model step can keep its three fields on this browser when the person ticks so. This test holds the logic
// (web/src/remember.ts) to its rules without a browser: one item under one name with the three fields as they
// stand, a load that takes only that shape and removes any other, removal, and a storage that throws.

import { describe, expect, it } from "vitest";

import {
  forget,
  formatKept,
  keep,
  KEPT_NAME,
  type KeptService,
  type KeptStorage,
  parseKept,
  recall,
} from "../../web/src/remember";

const SERVICE: KeptService = { baseUrl: " http://service.example/v1 ", model: "pear", apiKey: "a key, as typed " };

/** A storage that works, with what it holds open to the test. */
function memory(items: Record<string, string> = {}): { storage: KeptStorage; items: Map<string, string> } {
  const held = new Map(Object.entries(items));
  return {
    items: held,
    storage: {
      getItem: (name) => held.get(name) ?? null,
      setItem: (name, value) => void held.set(name, value),
      removeItem: (name) => void held.delete(name),
    },
  };
}

/** A storage of which the named operations throw, as a browser that refuses storage does. */
function refusing(operations: readonly (keyof KeptStorage)[], items: Record<string, string> = {}) {
  const inner = memory(items);
  const refuse = (): never => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };
  const storage: KeptStorage = {
    getItem: operations.includes("getItem") ? refuse : inner.storage.getItem,
    setItem: operations.includes("setItem") ? refuse : inner.storage.setItem,
    removeItem: operations.includes("removeItem") ? refuse : inner.storage.removeItem,
  };
  return { storage, items: inner.items };
}

describe("what is kept", () => {
  it("is one item under the one name, with the three fields as they stand", () => {
    const { storage, items } = memory({ other: "untouched" });
    expect(keep(() => storage, SERVICE)).toBe(true);
    expect([...items.keys()].sort()).toEqual(["other", KEPT_NAME].sort());
    expect(KEPT_NAME).toBe("pearjs.model");
    expect(JSON.parse(items.get(KEPT_NAME) ?? "")).toEqual(SERVICE);
  });

  it("is kept again over what was kept before", () => {
    const { storage, items } = memory();
    keep(() => storage, SERVICE);
    keep(() => storage, { ...SERVICE, model: "another" });
    expect(items.size).toBe(1);
    expect(JSON.parse(items.get(KEPT_NAME) ?? "")).toEqual({ ...SERVICE, model: "another" });
  });

  it("holds nothing that is not one of the three fields", () => {
    const more = { ...SERVICE, note: "not a field" } as KeptService;
    expect(JSON.parse(formatKept(more))).toEqual(SERVICE);
  });

  it("is removed by forgetting, and other items stay", () => {
    const { storage, items } = memory({ other: "untouched" });
    keep(() => storage, SERVICE);
    expect(forget(() => storage)).toBe(true);
    expect([...items.entries()]).toEqual([["other", "untouched"]]);
    expect(forget(() => storage)).toBe(true);
  });
});

describe("what a load reads", () => {
  it("is nothing when nothing is kept", () => {
    expect(recall(() => memory().storage)).toEqual({ kind: "none" });
  });

  it("is the three fields when they are kept, also empty ones", () => {
    const { storage, items } = memory();
    keep(() => storage, SERVICE);
    expect(recall(() => storage)).toEqual({ kind: "kept", service: SERVICE });
    expect(items.has(KEPT_NAME)).toBe(true);
    const empty = { baseUrl: "", model: "", apiKey: "" };
    keep(() => storage, empty);
    expect(recall(() => storage)).toEqual({ kind: "kept", service: empty });
  });

  it.each([
    ["not JSON", "{"],
    ["an empty text", ""],
    ["null", "null"],
    ["a text", JSON.stringify("http://service.example/v1")],
    ["a list", JSON.stringify(["a", "b", "c"])],
    ["a field missing", JSON.stringify({ baseUrl: "a", model: "b" })],
    ["a field that is no text", JSON.stringify({ baseUrl: "a", model: "b", apiKey: 3 })],
    ["a field that is null", JSON.stringify({ baseUrl: "a", model: null, apiKey: "c" })],
    ["one field more", JSON.stringify({ baseUrl: "a", model: "b", apiKey: "c", more: "d" })],
    ["another field's name", JSON.stringify({ baseUrl: "a", model: "b", key: "c" })],
  ])("removes and ignores what is kept in another shape: %s", (_, text) => {
    expect(parseKept(text)).toBeNull();
    const { storage, items } = memory({ [KEPT_NAME]: text, other: "untouched" });
    expect(recall(() => storage)).toEqual({ kind: "removed" });
    expect([...items.entries()]).toEqual([["other", "untouched"]]);
    expect(recall(() => storage)).toEqual({ kind: "none" });
  });
});

describe("a storage that throws", () => {
  const unreachable = (): KeptStorage => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };

  it("keeps nothing, removes nothing and reads nothing when the storage itself cannot be reached", () => {
    expect(keep(unreachable, SERVICE)).toBe(false);
    expect(forget(unreachable)).toBe(false);
    expect(recall(unreachable)).toEqual({ kind: "unusable" });
  });

  it("says that nothing was kept when writing throws, and leaves no older item behind", () => {
    const { storage, items } = refusing(["setItem"], { [KEPT_NAME]: formatKept({ ...SERVICE, apiKey: "an older key" }) });
    expect(keep(() => storage, SERVICE)).toBe(false);
    expect(items.has(KEPT_NAME)).toBe(false);
  });

  it("says so when writing and removing both throw", () => {
    const { storage } = refusing(["setItem", "removeItem"]);
    expect(keep(() => storage, SERVICE)).toBe(false);
    expect(forget(() => storage)).toBe(false);
  });

  it("reads nothing when reading throws", () => {
    const { storage } = refusing(["getItem"], { [KEPT_NAME]: formatKept(SERVICE) });
    expect(recall(() => storage)).toEqual({ kind: "unusable" });
  });

  it("cannot be used when what is kept has another shape and removing it throws", () => {
    const { storage, items } = refusing(["removeItem"], { [KEPT_NAME]: "{" });
    expect(recall(() => storage)).toEqual({ kind: "unusable" });
    expect(items.has(KEPT_NAME)).toBe(true);
  });
});
