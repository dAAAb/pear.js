// Not in PEAR: the page's check of the model service. The check itself is the library's (HealthChecks on a
// VLLMClient, src/agent): one GET of <base URL>/models with the key as a bearer token, 3 s to answer, and the
// model's name looked for in the list. What this file adds is what a page must tell a person and a Python
// process need not: a browser hides why a request to another origin failed, so the page watches the client's
// own request (through the client's `fetch` option) and, when it failed without an answer, asks the address
// once more in a way that needs no permission of the service, to tell an address that is not there from an
// answer the browser withheld.
//
// A page that came from the internet over https meets two more things a Python process never does, and says so
// instead of a bare network error. A browser refuses a request from an https page to a plain http address on
// another machine before it is sent (mixed content); this computer's own addresses are exempt, and Chromium
// also lets through an address of a local network written as numbers. And Chromium asks its user before such
// a page may reach this computer or the local network at all; the page reads the state of that permission.
//
// The key is given to the client when the check runs and is kept nowhere else: not in storage, not in the URL,
// not in the log.

import { HealthChecks, HealthStatus, type ModelHealth, VLLMClient } from "../../src/agent/index";

/** How long the model may take to answer a turn, s: PEAR's station default. A check never waits that long. */
const TURN_TIMEOUT_S = 300;
/** How long the page waits for the address to show that it is there, ms. */
const PROBE_TIMEOUT_MS = 3000;
/** The name the check runs under when the person gave none: no service serves it, and the list it answers with
 * tells the names it does serve. */
const NO_MODEL_NAME = "(no model name given)";

export interface ModelCheckInput {
  baseUrl: string;
  /** The name the service serves the model under; empty to take the one name the service lists. */
  model: string;
  /** The service's key; empty for a service that asks for none. */
  apiKey: string;
}

export type ModelOutcome =
  /** The service answers, takes the key and serves the model. */
  | { kind: "ok"; model: string; wasFound: boolean }
  /** The service answers and takes the key, but serves other names. */
  | { kind: "not-served"; model: string; served: string[] }
  /** No name was given and the service serves several, or none. */
  | { kind: "choose"; served: string[] }
  /** The service answered that the key is missing or wrong (401, 403). */
  | { kind: "key"; status: number }
  /** The address answers, but has no model list there (404): the base URL is not the API's. */
  | { kind: "not-found" }
  /** Another refusal. */
  | { kind: "http"; status: number }
  /** No answer in time. */
  | { kind: "timeout" }
  /** The request failed without an answer the page may read, yet the address is there: the service does not
   * allow this page's origin, or it refused the key in a way a browser hides. */
  | { kind: "blocked" }
  /** Nothing is reachable at the address, or the browser does not let this page go there. */
  | { kind: "unreachable" }
  /** This page is on https and the address is plain http on another machine: a browser refuses such a request
   * before it is sent. With ``isLocalAddress`` the address is one of a local network written as numbers, which
   * Chromium lets through once its user allows the page to reach the local network. */
  | { kind: "mixed"; isLocalAddress: boolean }
  /** The address or the key was refused before any request was made. */
  | { kind: "refused" }
  /** The address answered, but not with a model list. */
  | { kind: "not-a-service" };

/** What the browser says of this page's permission to reach this computer and the local network. */
export type NetworkPermission = "granted" | "denied" | "prompt";

export interface ModelCheck {
  outcome: ModelOutcome;
  /** The library's own sentence for the check, as PEAR's page would show it. */
  message: string;
  /** The address asked, as the log may hold it. */
  where: string;
  /** The permission to reach the local network, where the check got no answer and the page came from the
   * internet; null where it plays no part or the browser has no such permission. */
  localNetwork: NetworkPermission | null;
}

interface ObservedRequest {
  status: number | null;
  errorName: string | null;
  /** The names in the model list of a successful answer; null when there was none to read. */
  served: string[] | null;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || /^127\./.test(hostname) || hostname === "[::1]";
}

/** Returns whether ``hostname`` is an address of a local network written as numbers. */
function isPrivateAddress(hostname: string): boolean {
  return /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname) || /^\[(f[cd]|fe[89ab])/i.test(hostname);
}

/**
 * Returns what stands between a page loaded over ``pageProtocol`` and the address ``url`` because the page is
 * secure and the address is not: "refused" where a browser blocks the request as mixed content before it is
 * sent, "local" for an address of a local network written as numbers or a .local name, which Chromium lets
 * through to its question about the local network, and null where nothing does (a page that is not on https, an
 * https address, this computer's own addresses).
 */
export function mixedContent(pageProtocol: string, url: string): "refused" | "local" | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (pageProtocol !== "https:" || parsed.protocol !== "http:" || isLoopback(parsed.hostname)) return null;

  return isPrivateAddress(parsed.hostname) || parsed.hostname.endsWith(".local") ? "local" : "refused";
}

/** Returns whether this page came from the internet over https: Chromium then asks its user before the page may
 * reach this computer or the local network. A page from this computer itself, or from a folder, is not asked. */
function isPublicPage(): boolean {
  return location.protocol === "https:" && !isLoopback(location.hostname);
}

/** Returns what the browser says of this page's permission to reach this computer and the local network, with
 * the names and states for the log; null for a page that needs none and in a browser that has no such
 * permission. Chromium has had it under one name and then under two. */
async function localNetworkPermission(): Promise<{ state: NetworkPermission; detail: string } | null> {
  if (!isPublicPage() || navigator.permissions === undefined) return null;

  const states: Array<[string, string]> = [];
  for (const name of ["loopback-network", "local-network", "local-network-access"]) {
    try {
      states.push([name, (await navigator.permissions.query({ name: name as PermissionName })).state]);
    } catch {
      // a name this browser does not know
    }
  }
  if (states.length === 0) return null;

  const all = states.map(([, state]) => state);
  const state: NetworkPermission = all.includes("denied") ? "denied" : all.includes("prompt") ? "prompt" : "granted";

  return { state, detail: states.map(([name, each]) => `${name}=${each}`).join(", ") };
}

/** Returns ``url`` as the page's log may hold it: its scheme, port and path, with the host only when it is this
 * computer. A log is pasted into bug reports: it must not carry an address, a user name or a query string. */
export function describeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "<an address the browser cannot read>";
  }

  const host = parsed.hostname;
  let shown = "<host>";
  if (isLoopback(host)) shown = host;
  else if (isPrivateAddress(host)) shown = "<private address>";
  else if (/^[\d.]+$/.test(host) || host.startsWith("[")) shown = "<address>";

  return `${parsed.protocol}//${shown}${parsed.port === "" ? "" : `:${parsed.port}`}${parsed.pathname}`;
}

/** Returns whether something answers at ``url``: a request that needs no permission of the service, carries no
 * key and whose answer the page cannot read. */
async function isReachable(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch(url, { mode: "no-cors", cache: "no-store", credentials: "omit", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Runs the client's health check for the service ``input`` names and says what it found. */
export async function checkModel(input: ModelCheckInput, log: (message: string) => void): Promise<ModelCheck> {
  const observed: ObservedRequest[] = [];
  let lastUrl = "";
  // the client's own requests, watched: the answer is handed on untouched
  const watchingFetch: typeof fetch = async (target, init) => {
    lastUrl = typeof target === "string" ? target : target instanceof URL ? target.href : target.url;
    const entry: ObservedRequest = { status: null, errorName: null, served: null };
    observed.push(entry);
    try {
      const response = await globalThis.fetch(target, init);
      entry.status = response.status;
      if (response.ok) {
        try {
          const list: unknown = await response.clone().json();
          const data = (list as { data?: unknown } | null)?.data;
          if (Array.isArray(data)) {
            entry.served = data.flatMap((item) => {
              const id = (item as { id?: unknown } | null)?.id;
              return typeof id === "string" ? [id] : [];
            });
          }
        } catch {
          // not JSON: the client says so itself
        }
      }

      return response;
    } catch (error) {
      entry.errorName = error instanceof Error ? error.name : "Error";
      throw error;
    }
  };

  const key = input.apiKey.trim();
  const run = (model: string): Promise<ModelHealth> =>
    new HealthChecks(
      (name) =>
        new VLLMClient("", {
          timeoutS: TURN_TIMEOUT_S,
          baseUrl: input.baseUrl.trim(),
          model: name,
          apiKey: key === "" ? null : key,
          fetch: watchingFetch,
        }),
    ).check(model, { isForced: true });

  let model = input.model.trim();
  let wasFound = false;
  let health = await run(model === "" ? NO_MODEL_NAME : model);
  let request = observed.at(-1) ?? null;
  if (model === "" && request?.served?.length === 1) {
    // the service serves one model: that is the one
    model = request.served[0] as string;
    wasFound = true;
    health = await run(model);
    request = observed.at(-1) ?? null;
  }

  const where = lastUrl === "" ? "" : describeUrl(lastUrl);
  let outcome: ModelOutcome;
  if (health.status === HealthStatus.OK) outcome = { kind: "ok", model, wasFound };
  else if (request === null) outcome = { kind: "refused" };
  else if (request.errorName === "AbortError") outcome = { kind: "timeout" };
  else if (request.errorName !== null) {
    const mixed = mixedContent(location.protocol, lastUrl);
    // a request the browser refuses as mixed content is not asked a second time: that would be refused too
    if (mixed === "refused") outcome = { kind: "mixed", isLocalAddress: false };
    else if (await isReachable(lastUrl)) outcome = { kind: "blocked" };
    else outcome = mixed === "local" ? { kind: "mixed", isLocalAddress: true } : { kind: "unreachable" };
  } else if (request.status === 401 || request.status === 403) outcome = { kind: "key", status: request.status };
  else if (request.status === 404) outcome = { kind: "not-found" };
  else if (request.status !== null && request.status >= 400) outcome = { kind: "http", status: request.status };
  else if (request.served === null) outcome = { kind: "not-a-service" };
  else if (model === "") outcome = { kind: "choose", served: request.served };
  else outcome = { kind: "not-served", model, served: request.served };

  const answer =
    request === null
      ? "no request was made"
      : request.errorName !== null
        ? `failed (${request.errorName})`
        : `${request.status}${request.served === null ? "" : `, ${request.served.length} model(s) listed`}`;
  // where no answer came and the page came from the internet, the browser's question about the local network
  // may be what stands in the way
  const hadNoAnswer = outcome.kind === "timeout" || outcome.kind === "unreachable" || outcome.kind === "mixed";
  const permission = hadNoAnswer ? await localNetworkPermission() : null;
  log(
    `Model check: GET ${where === "" ? "<no address>" : where} -> ${answer}; ${outcome.kind}` +
      `${outcome.kind === "mixed" ? ` (this page is on https, the address is plain http${outcome.isLocalAddress ? " on a local network" : ""})` : ""}` +
      `${permission === null ? "" : `; permission to reach the local network: ${permission.detail}`}`,
  );

  return { outcome, message: health.message, where, localNetwork: permission?.state ?? null };
}
