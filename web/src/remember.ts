// The model service that the person names in the model step (its address, the model's name and the key) can be
// kept on this browser when the person ticks so: one item in the browser's storage for this site, read once when
// the page loads. This module is that logic without the page: what is written, what a load reads, which shape
// counts, and a storage that throws. It writes nothing to the log and sends nothing anywhere.

/** The one name under which the three fields are kept in the browser's storage for this site. */
export const KEPT_NAME = "pearjs.model";

/** The three fields of the model step, as they stand in the page. */
export interface KeptService {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
}

/** What this module uses of the browser's storage. Each of the three may throw in a browser that refuses it. */
export interface KeptStorage {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}

/** Gives the storage. Reading `window.localStorage` can itself throw in a browser that refuses it, so the module
 * is given a function and calls it where a throw is caught. */
export type StorageSource = () => KeptStorage;

/** What a load found: nothing, the three fields, something of another shape (which was removed), or a storage
 * that cannot be used. */
export type Recalled =
  | { readonly kind: "none" }
  | { readonly kind: "kept"; readonly service: KeptService }
  | { readonly kind: "removed" }
  | { readonly kind: "unusable" };

/** The names of the three fields, in the order a sorted list of an item's names must have. */
const FIELD_NAMES = ["apiKey", "baseUrl", "model"] as const;

/** Returns the three fields that ``text`` holds, or null when it is not exactly them: an object with the three
 * names and no other, each a string. */
export function parseKept(text: string): KeptService | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const names = Object.keys(record).sort();
  if (names.length !== FIELD_NAMES.length || names.some((name, index) => name !== FIELD_NAMES[index])) return null;
  const { baseUrl, model, apiKey } = record;
  if (typeof baseUrl !== "string" || typeof model !== "string" || typeof apiKey !== "string") return null;

  return { baseUrl, model, apiKey };
}

/** Returns the text that is kept for ``service``: the three fields as they stand, and nothing else. */
export function formatKept(service: KeptService): string {
  return JSON.stringify({ baseUrl: service.baseUrl, model: service.model, apiKey: service.apiKey });
}

/** Reads what the browser keeps. What is kept in another shape is removed, and the load is told so. */
export function recall(source: StorageSource): Recalled {
  try {
    const storage = source();
    const text = storage.getItem(KEPT_NAME);
    if (text === null) return { kind: "none" };
    const service = parseKept(text);
    if (service !== null) return { kind: "kept", service };
    storage.removeItem(KEPT_NAME);

    return { kind: "removed" };
  } catch {
    return { kind: "unusable" };
  }
}

/** Keeps ``service`` and returns whether the browser took it. After a refusal the item of an earlier keeping is
 * removed, where the browser allows that: what stays must never be older than what the fields hold. */
export function keep(source: StorageSource, service: KeptService): boolean {
  try {
    source().setItem(KEPT_NAME, formatKept(service));

    return true;
  } catch {
    forget(source);

    return false;
  }
}

/** Removes what is kept and returns whether the browser did it. */
export function forget(source: StorageSource): boolean {
  try {
    source().removeItem(KEPT_NAME);

    return true;
  } catch {
    return false;
  }
}
