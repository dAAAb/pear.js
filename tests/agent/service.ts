// The recording model service of the tests, in the two forms a client meets one: a `fetch` that answers from the
// script without a network (here), and a real HTTP/1.1 server on 127.0.0.1 that writes the same bytes to a socket
// as the server tools/fixtures/agent_fixtures.py ran PEAR's client against (./socket_service.ts; the script's
// fields are described at that server's class Service). Also here: the probe that tells what a fetch reports of a
// scripted response. Nothing in this file needs Node.
//
// Why a probe. A response may break: its connection ends before the message is whole. PEAR's HTTP client reports
// each such response as a failed connection. A runtime's fetch need not: Node's (undici) before undici 6.26.0 and
// 7.26.0 ends the body of a chunked response as if it were whole when the response had announced the connection's
// end (`Connection: close`, which the recording server sends with every response), where later versions fail the
// read. PEAR's client does one thing for a connection that fails and another for a body that ends, so a test first
// asks the fetch (reportOf) and then requires what PEAR's client did for that report.

import type { RecordedRequest, ResponseScript } from "./records";

export const REASONS: Record<number, string> = {
  200: "OK",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  418: "I'm a teapot",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  599: "Unscripted",
};
export const UNSCRIPTED: ResponseScript = { status: 599, body: [{ data: "unscripted" }] };
export const HOLD_LIMIT_S = 20;

/** What a service has received since its last begin. */
export interface Taken {
  /** The requests, in order. */
  requests: RecordedRequest[];
  /** How many of the scripted responses no request has used. */
  unused: number;
}

/** A recording service: what a scenario's requests go to. (Each method may answer later: a service a page drives
 * runs outside the page.) */
export interface Service {
  /** The origin a client's base URL starts with. */
  readonly origin: string;
  /** An origin nothing listens on. */
  readonly closedOrigin: string;
  /** Forgets the requests received and queues ``responses`` for the next ones. */
  begin(responses: ResponseScript[]): void | Promise<void>;
  /** What was received since the last begin. */
  taken(): Taken | Promise<Taken>;
  /** What a client is given as its fetch; undefined: the runtime's own. */
  readonly fetch: typeof fetch | undefined;
  close(): Promise<void>;
}

/** Whether ``script`` breaks its response: the connection is reset before any answer, or ends before the body is
 * whole (it closes or is reset before the last chunk, or before the length the head gave is reached). */
export function isBroken(script: ResponseScript): boolean {
  return script.head === "reset" || (script.end ?? "finish") !== "finish" || !!script.missing_bytes;
}

/** Returns how many bytes of its body ``script`` writes. */
export function bodyLength(script: ResponseScript): number {
  return (script.body ?? []).reduce(
    (total, step) => total + ("data" in step ? encode(step.data, script.encoding).length : 0),
    0,
  );
}

/** What a fetch reports of a response: no answer (the fetch rejects), an answer whose body fails while it is read
 * (a read rejects), or an answer whose body ends; with the status and the body's bytes that came before. */
export type FetchReport =
  | { answer: "none"; error: string }
  | { answer: "broken"; status: number; bytes: number; error: string }
  | { answer: "whole"; status: number; bytes: number };

/** Returns what the fetch of ``service`` (its own, or the runtime's) reports of ``script``: asked with a plain
 * request of the kind a client makes, and no client. */
export async function reportOf(service: Service, script: ResponseScript): Promise<FetchReport> {
  await service.begin([script]);
  const ask = service.fetch ?? ((input, init) => globalThis.fetch(input, init));

  let response: Response;
  try {
    response = await ask(`${service.origin}/v1/chat/completions`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: "{}",
    });
  } catch (error) {
    return { answer: "none", error: String(error) };
  }

  const reader = response.body?.getReader();
  let bytes = 0;
  for (;;) {
    let piece: ReadableStreamReadResult<Uint8Array> | undefined;
    try {
      piece = await reader?.read();
    } catch (error) {
      return { answer: "broken", status: response.status, bytes, error: String(error) };
    }
    if (piece === undefined || piece.done) {
      return { answer: "whole", status: response.status, bytes };
    }
    bytes += piece.value.length;
  }
}

export function encode(text: string, encoding: "utf-8" | "latin-1" | undefined): Uint8Array {
  return encoding === "latin-1"
    ? Uint8Array.from(text, (character) => character.charCodeAt(0))
    : new TextEncoder().encode(text);
}

export function wait(seconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, seconds * 1000);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function aborted(): DOMException {
  return new DOMException("This operation was aborted", "AbortError");
}

/** How a fetch reads a chunked body that its connection ends before the last chunk, on a response that had
 * announced the connection's end (every scripted response has): "fails", as HTTP has it and as PEAR's HTTP client
 * and undici from 6.26.0 and 7.26.0 do; "ends", as undici before those versions does (lib/dispatcher/client-h1.js:
 * at the socket's end or reset it called the parser's onMessageComplete where it now asks the parser with
 * finish(); undici's pull requests 5307 and 5308). No browser was asked. */
export type CutChunkedBody = "fails" | "ends";

/** A service without a network: its fetch answers from the script as a runtime's fetch would answer of the same
 * bytes on a connection (a connection that fails rejects the fetch, or the read of the body, with a TypeError). */
export class ScriptedFetchService implements Service {
  readonly origin = "http://127.0.0.1:18000";
  readonly closedOrigin = "http://127.0.0.1:18001";
  /** The requests received since the last begin. */
  requests: RecordedRequest[] = [];
  /** The scripted responses not yet used. */
  responses: ResponseScript[] = [];

  constructor(private readonly cutChunkedBody: CutChunkedBody = "fails") {}

  begin(responses: ResponseScript[]): void {
    this.requests = [];
    this.responses = [...responses];
  }

  taken(): Taken {
    return { requests: this.requests, unused: this.responses.length };
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const signal = init?.signal ?? undefined;
    await wait(0);
    if (signal?.aborted) {
      throw aborted();
    }
    if (url.origin === this.closedOrigin) {
      throw new TypeError("fetch failed");
    }

    const headers = new Headers(init?.headers);
    this.requests.push({
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      headers: {
        authorization: headers.get("authorization"),
        "content-type": headers.get("content-type"),
        accept: headers.get("accept"),
      },
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const script = this.responses.shift() ?? UNSCRIPTED;

    if (script.delay_s) {
      await wait(script.delay_s, signal);
    }
    if (signal?.aborted) {
      throw aborted();
    }
    if (script.head === "reset") {
      throw new TypeError("fetch failed");
    }
    if (script.head === "hold") {
      await wait(HOLD_LIMIT_S, signal);
      throw signal?.aborted ? aborted() : new TypeError("fetch failed");
    }

    const steps = script.body ?? [];
    const isCut = (script.end ?? "finish") !== "finish" || (script.framing === "length" && !!script.missing_bytes);
    // what the read of a body does where its connection ends before the body is whole
    const endCutBody = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
      if ((script.framing ?? "chunked") === "chunked" && this.cutChunkedBody === "ends") {
        controller.close();
      } else {
        controller.error(new TypeError("terminated"));
      }
    };
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        signal?.addEventListener("abort", () => {
          try {
            controller.error(aborted());
          } catch {
            // the body has ended
          }
        });
        for (const step of steps) {
          if (signal?.aborted) {
            return;
          }
          if ("sleep_s" in step) {
            await wait(step.sleep_s, signal);
          } else if ("hold_s" in step) {
            await wait(step.hold_s, signal);
            if (!signal?.aborted) {
              endCutBody(controller);
            }
            return;
          } else {
            controller.enqueue(encode(step.data, script.encoding));
            await wait(0); // each write is a piece of its own
          }
        }
        if (signal?.aborted) {
          return;
        }
        if (isCut) {
          endCutBody(controller);
        } else {
          controller.close();
        }
      },
    });

    return new Response(body, { status: script.status ?? 200, headers: script.headers ?? [] });
  };

  async close(): Promise<void> {}
}
