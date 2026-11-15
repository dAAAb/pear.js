// The recording model service of the tests, in the two forms a client meets one: a `fetch` that answers from the
// script without a network, and a real HTTP/1.1 server on 127.0.0.1 that writes the same bytes to a socket as the
// server tools/fixtures/agent_fixtures.py ran PEAR's client against (its class Service: the script's fields are
// described there).

import { createServer, type Server, type Socket } from "node:net";

import type { RecordedRequest, ResponseScript } from "./fixtures";

const REASONS: Record<number, string> = {
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
const UNSCRIPTED: ResponseScript = { status: 599, body: [{ data: "unscripted" }] };
const HOLD_LIMIT_S = 20;

/** A recording service: what a scenario's requests go to. */
export interface Service {
  /** The origin a client's base URL starts with. */
  readonly origin: string;
  /** An origin nothing listens on. */
  readonly closedOrigin: string;
  /** The requests received since the last begin. */
  requests: RecordedRequest[];
  /** The scripted responses not yet used. */
  responses: ResponseScript[];
  /** Forgets the requests received and queues ``responses`` for the next ones. */
  begin(responses: ResponseScript[]): void;
  /** What a client is given as its fetch; undefined: the runtime's own. */
  readonly fetch: typeof fetch | undefined;
  close(): Promise<void>;
}

function encode(text: string, encoding: "utf-8" | "latin-1" | undefined): Uint8Array {
  return encoding === "latin-1" ? Uint8Array.from(text, (character) => character.charCodeAt(0)) : Buffer.from(text);
}

function wait(seconds: number, signal?: AbortSignal): Promise<void> {
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

/** A service without a network: its fetch answers from the script as a runtime's fetch would answer of the same
 * bytes on a connection (a connection that fails rejects the fetch, or the read of the body, with a TypeError). */
export class ScriptedFetchService implements Service {
  readonly origin = "http://127.0.0.1:18000";
  readonly closedOrigin = "http://127.0.0.1:18001";
  requests: RecordedRequest[] = [];
  responses: ResponseScript[] = [];

  begin(responses: ResponseScript[]): void {
    this.requests = [];
    this.responses = [...responses];
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
              controller.error(new TypeError("terminated"));
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
          controller.error(new TypeError("terminated"));
        } else {
          controller.close();
        }
      },
    });

    return new Response(body, { status: script.status ?? 200, headers: script.headers ?? [] });
  };

  async close(): Promise<void> {}
}

/** A service on a socket of this machine: one request a connection, answered with the script's bytes. Clients
 * reach it with the runtime's own fetch. */
export class SocketService implements Service {
  readonly fetch = undefined;
  requests: RecordedRequest[] = [];
  responses: ResponseScript[] = [];
  private readonly sockets = new Set<Socket>();

  private constructor(
    private readonly server: Server,
    readonly origin: string,
    readonly closedOrigin: string,
  ) {}

  /** Starts a service on a free port of 127.0.0.1. */
  static async start(): Promise<SocketService> {
    // a port nothing listens on: one that was free a moment ago
    const unused = createServer();
    await new Promise<void>((resolve) => unused.listen(0, "127.0.0.1", resolve));
    const closedOrigin = `http://127.0.0.1:${(unused.address() as { port: number }).port}`;
    await new Promise((resolve) => unused.close(resolve));

    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const service = new SocketService(server, origin, closedOrigin);
    server.on("connection", (socket) => service.serve(socket));

    return service;
  }

  begin(responses: ResponseScript[]): void {
    this.requests = [];
    this.responses = [...responses];
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => this.server.close(resolve));
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => undefined); // the client left

    let received = Buffer.alloc(0);
    let isAnswering = false;
    socket.on("data", (piece: Buffer) => {
      if (isAnswering) {
        return;
      }
      received = Buffer.concat([received, piece]);
      const headEnd = received.indexOf("\r\n\r\n");
      if (headEnd < 0) {
        return;
      }
      const lines = received.subarray(0, headEnd).toString("latin1").split("\r\n");
      const [method, path] = lines[0]!.split(" ") as [string, string];
      const headers = new Map<string, string>();
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(":");
        headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
      }
      const body = received.subarray(headEnd + 4);
      if (body.length < Number(headers.get("content-length") ?? "0")) {
        return;
      }

      isAnswering = true;
      this.requests.push({
        method,
        path,
        headers: {
          authorization: headers.get("authorization") ?? null,
          "content-type": headers.get("content-type") ?? null,
          accept: headers.get("accept") ?? null,
        },
        body: body.length > 0 ? JSON.parse(body.toString("utf8")) : null,
      });
      void this.play(socket, this.responses.shift() ?? UNSCRIPTED);
    });
  }

  private async play(socket: Socket, script: ResponseScript): Promise<void> {
    const left = new AbortController(); // aborted once the client has left
    socket.on("close", () => left.abort());
    const write = (bytes: Uint8Array | string): void => {
      if (!socket.destroyed) {
        socket.write(bytes);
      }
    };

    if (script.delay_s) {
      await wait(script.delay_s, left.signal);
    }
    if (script.head === "reset") {
      socket.resetAndDestroy();
      return;
    }
    if (script.head === "hold") {
      await wait(HOLD_LIMIT_S, left.signal);
      socket.destroy();
      return;
    }

    const status = script.status ?? 200;
    const framing = script.framing ?? "chunked";
    const steps = script.body ?? [];
    const lines = [`HTTP/1.1 ${status} ${REASONS[status]}`];
    for (const [name, value] of script.headers ?? []) {
      lines.push(`${name}: ${value}`);
    }
    if (framing === "chunked") {
      lines.push("Transfer-Encoding: chunked");
    } else if (framing === "length") {
      const sizes = steps.map((step) => ("data" in step ? encode(step.data, script.encoding).length : 0));
      const written = sizes.reduce((total, size) => total + size, 0);
      lines.push(`Content-Length: ${written + (script.missing_bytes ?? 0)}`);
    }
    lines.push("Connection: close");
    write(`${lines.join("\r\n")}\r\n\r\n`);

    for (const step of steps) {
      if (left.signal.aborted) {
        return;
      }
      if ("sleep_s" in step) {
        await wait(step.sleep_s, left.signal);
      } else if ("hold_s" in step) {
        await wait(step.hold_s, left.signal);
        socket.destroy();
        return;
      } else {
        const payload = encode(step.data, script.encoding);
        if (framing === "chunked") {
          write(`${payload.length.toString(16)}\r\n`);
          write(payload);
          write("\r\n");
        } else {
          write(payload);
        }
        await wait(0.005, left.signal); // each write is a piece of its own
      }
    }

    const end = script.end ?? "finish";
    if (end === "finish" && framing === "chunked") {
      write("0\r\n\r\n");
    }
    if (end === "reset") {
      socket.resetAndDestroy();
    } else {
      socket.end();
    }
  }
}
