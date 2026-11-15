// The recording model service of the tests as a real HTTP/1.1 server on 127.0.0.1 (Node's): it writes the same
// bytes to a socket as the server tools/fixtures/agent_fixtures.py ran PEAR's client against (its class Service:
// the script's fields are described there). ./service.ts holds what a service is and the form without a network.
//
// One end differs from that server's, on purpose: where a script resets the connection, the Python server's
// connection sent a FIN and then an RST (Python's socketserver shuts a connection down before it closes it), which
// a client reads as it reads a connection that closes; here the reset is an RST alone, so that a runtime's reading
// of a reset is met too. PEAR's client was run on that end as well, outside the fixtures: it raises the same error.

import { createServer, type Server, type Socket } from "node:net";

import type { RecordedRequest, ResponseScript } from "./records";
import { encode, HOLD_LIMIT_S, isBroken, REASONS, UNSCRIPTED, wait, type Service, type Taken } from "./service";

/** How a service on a socket departs from the recording server. */
export interface SocketServiceOptions {
  /** A response that its script breaks does not announce the connection's end: its head has no `Connection:
   * close`, as the head of a server that meant to keep the connection has none. (The recording server announced
   * the end with every response. PEAR's client, run on such heads outside the fixtures, raises the same errors.) */
  unannouncedBreaks?: boolean;
}

/** A service on a socket of this machine: one request a connection, answered with the script's bytes. Clients
 * reach it with the runtime's own fetch. */
export class SocketService implements Service {
  readonly fetch = undefined;
  /** The requests received since the last begin. */
  requests: RecordedRequest[] = [];
  /** The scripted responses not yet used. */
  responses: ResponseScript[] = [];
  private readonly sockets = new Set<Socket>();

  private constructor(
    private readonly server: Server,
    readonly origin: string,
    readonly closedOrigin: string,
    private readonly options: SocketServiceOptions,
  ) {}

  /** Starts a service on a free port of 127.0.0.1. */
  static async start(options: SocketServiceOptions = {}): Promise<SocketService> {
    // a port nothing listens on: one that was free a moment ago
    const unused = createServer();
    await new Promise<void>((resolve) => unused.listen(0, "127.0.0.1", resolve));
    const closedOrigin = `http://127.0.0.1:${(unused.address() as { port: number }).port}`;
    await new Promise((resolve) => unused.close(resolve));

    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const service = new SocketService(server, origin, closedOrigin, options);
    server.on("connection", (socket) => service.serve(socket));

    return service;
  }

  begin(responses: ResponseScript[]): void {
    this.requests = [];
    this.responses = [...responses];
  }

  taken(): Taken {
    return { requests: this.requests, unused: this.responses.length };
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
    if (!(this.options.unannouncedBreaks && isBroken(script))) {
      lines.push("Connection: close");
    }
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
