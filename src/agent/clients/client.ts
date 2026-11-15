// Ports pear/deploy/station/agent_loop/clients/client.py: the base of a model service's client, with the two errors
// that end a conversation and the progress of a running request.
//
// PEAR's infer() blocks its thread and runs the request in an event loop of its own; here it is an async function.
// A threading.Event that stops a request is an AbortSignal; the client still looks at it every CANCEL_POLL_S, as
// PEAR does, so that a request which ends before the next look keeps its outcome.

import { monotonic, startTimer, type Clock, type Timer } from "../clock";
import { OperatorPaused, RuntimeError, TimeoutError, ValueError } from "../exceptions";
import { TokenRate } from "./metrics";
import type { EventHandler, ModelHealth, ModelInput, ModelOutput, Usage } from "./schemas";

/** Raised when a conversation's context cannot continue safely. */
export class ContextLimit extends ValueError {
  override readonly name: string = "ContextLimit";
}

/** Raised when a model's conversation cannot be continued safely. */
export class SessionLost extends RuntimeError {
  override readonly name: string = "SessionLost";
}

/** One request of a client while it runs: who hears of it, what stops it and what has streamed of it so far. */
export class TurnProgress {
  /** Takes what the request reports. */
  readonly onEvent: EventHandler;
  /** Aborted to stop the request. */
  readonly cancellation: AbortSignal;
  /** When the request began, on the client's clock. */
  readonly startTime: number;
  /** From the start to the first streamed text. */
  firstOutputS: number | null = null;
  /** The latest report of the token counts. */
  usage: Usage = {};
  /** The generated tokens a second, on the client's clock. */
  readonly tokenRate = new TokenRate();
  protected readonly clock: Clock;

  constructor(fields: { onEvent: EventHandler; cancellation: AbortSignal; startTime: number; clock?: Clock }) {
    this.onEvent = fields.onEvent;
    this.cancellation = fields.cancellation;
    this.startTime = fields.startTime;
    this.clock = fields.clock ?? monotonic;
  }

  /** Notes that text streamed and returns whether it is the request's first. */
  noteOutput(): boolean {
    if (this.firstOutputS !== null) {
      return false;
    }

    this.firstOutputS = this.clock() - this.startTime;

    return true;
  }
}

/** What ends a request from outside: thrown where the request's own signal was aborted. It stands for Python's
 * asyncio.CancelledError, which no `except Exception` of a client catches. */
export class RequestCancelled extends Error {
  override readonly name: string = "RequestCancelled";
}

/** Throws RequestCancelled once ``scope``, the signal of a running request, was aborted. */
export function checkScope(scope: AbortSignal): void {
  if (scope.aborted) {
    throw new RequestCancelled("The request was cancelled");
  }
}

/** A request as the client's race runs it: it is given the signal that ends it from outside, and once that signal
 * is aborted it throws RequestCancelled at its next step, without reporting anything more. */
export type Request<T> = (scope: AbortSignal) => Promise<T>;

/**
 * The base of a model service's client, which takes a turn's text and images and returns the model's answer: one
 * request at a time, which a stop ends early, until the client is closed.
 */
export abstract class ModelClient {
  /** Names the client in its messages. */
  static readonly LABEL: string = "Model";
  /** How often a running request looks for a stop, s. */
  static readonly CANCEL_POLL_S = 0.02;
  /** How long close waits for a running request to end, s. */
  static readonly CLEANUP_TIMEOUT_S = 10.0;

  readonly systemPrompt: string;
  /** How long the model may take to answer a turn, s. */
  readonly timeoutS: number;
  /** The client's monotonic clock, in seconds. */
  protected readonly clock: Clock;

  private abortEvent = new AbortController(); // aborted by cancel: stops the running request
  private activeRequest: Promise<void> | null = null; // settles once the one request that runs has ended
  private isClosed = false;
  private lostReason: string | null = null; // why the model's conversation cannot go on; null while it can

  constructor(systemPrompt: string, options: { timeoutS: number; clock?: Clock | undefined }) {
    this.systemPrompt = systemPrompt;
    this.timeoutS = options.timeoutS;
    this.clock = options.clock ?? monotonic;
  }

  /** The client's label: the LABEL of its class. */
  get label(): string {
    return (this.constructor as typeof ModelClient).LABEL;
  }

  /** Returns what a check of the model's connection found; throws when the model cannot be reached. */
  abstract check(): Promise<ModelHealth>;

  /**
   * Returns the model's answer to ``modelInput`` and reports the request's progress to ``onEvent``; aborting
   * ``cancellation`` or calling ``cancel`` stops the request.
   */
  async infer(
    modelInput: ModelInput,
    options: { onEvent: EventHandler; cancellation: AbortSignal },
  ): Promise<ModelOutput> {
    if (this.activeRequest !== null) {
      throw new RuntimeError(`A ${this.label} request is already active`);
    }

    let release!: () => void;
    this.activeRequest = new Promise((resolve) => {
      release = resolve;
    });
    try {
      if (this.isClosed) {
        throw new SessionLost(`${this.label} client is closed`);
      }
      if (this.lostReason) {
        throw new SessionLost(this.lostReason);
      }
      this.checkUsable();
      OperatorPaused.checkCancelled(options.cancellation);
      this.abortEvent = new AbortController();

      return await this.inferAsync(modelInput, options.onEvent, options.cancellation);
    } finally {
      this.activeRequest = null;
      release();
    }
  }

  /** Stops the request that runs, if one does. */
  cancel(): void {
    this.abortEvent.abort();
  }

  /**
   * Stops the request that runs, waits for it to end and frees what the client holds; throws SessionLost when the
   * request does not end in time.
   */
  async close(): Promise<void> {
    this.cancel();
    const timer = startTimer(ModelClient.CLEANUP_TIMEOUT_S);
    try {
      // (a request that begins while this waits is waited for too, as a lock's next holder would be)
      while (this.activeRequest !== null) {
        const hasEnded = await Promise.race([this.activeRequest.then(() => true), timer.due.then(() => false)]);
        if (!hasEnded) {
          throw new SessionLost(`${this.label} request did not finish cancellation`);
        }
      }
    } finally {
      timer.cancel();
    }

    if (!this.isClosed) {
      this.release();
      this.isClosed = true;
    }
  }

  /** Returns whether a model of this client takes a task's reference images, given its last connection check. */
  static supportsReferenceImages(_health: ModelHealth): boolean {
    return true;
  }

  /** Throws when the client can take no request (by default it takes every one). */
  protected checkUsable(): void {}

  /** Returns the model's answer to ``modelInput``, as ``infer`` does. */
  protected abstract inferAsync(
    modelInput: ModelInput,
    onEvent: EventHandler,
    cancellation: AbortSignal,
  ): Promise<ModelOutput>;

  /**
   * Returns what ``request`` returns; a stop ends it first and is refused with OperatorPaused, and past
   * ``timeoutS`` it ends with TimeoutError (null: no time-out). A request that has ended when the stop is seen
   * keeps its outcome: a complete answer is kept, and the agent loop still looks for a stop.
   */
  protected async race<T>(
    request: Request<T>,
    cancellation: AbortSignal,
    options: { timeoutS: number | null },
  ): Promise<T> {
    const scope = new AbortController();
    type Outcome = { kind: "returned"; value: T } | { kind: "raised"; error: unknown };
    const interrupted = (): OperatorPaused =>
      new OperatorPaused(`${this.label} inference interrupted; no partial action is valid`);

    // the request runs up to its first wait before the first look for a stop
    const outcome: Promise<Outcome> = request(scope.signal).then(
      (value) => ({ kind: "returned", value }),
      (error: unknown) => ({ kind: "raised", error }),
    );
    const unwrap = (ended: Outcome): T => {
      if (ended.kind === "raised") {
        throw ended.error;
      }
      return ended.value;
    };

    if (this.isStopped(cancellation)) {
      // a request that ended before it ever waited keeps its outcome; any other is ended here
      scope.abort();
      const ended = await outcome;
      if (ended.kind === "raised" && ended.error instanceof RequestCancelled) {
        throw interrupted();
      }
      return unwrap(ended);
    }

    let poll: ReturnType<typeof setInterval> | undefined;
    const stopped = new Promise<"stopped">((resolve) => {
      poll = setInterval(() => {
        if (this.isStopped(cancellation)) {
          resolve("stopped");
        }
      }, ModelClient.CANCEL_POLL_S * 1000);
    });
    const deadline: Timer | null = options.timeoutS === null ? null : startTimer(options.timeoutS);

    try {
      const first = await Promise.race([
        outcome,
        stopped,
        ...(deadline === null ? [] : [deadline.due.then(() => "timeout" as const)]),
      ]);
      if (first === "timeout") {
        throw new TimeoutError();
      }
      if (first === "stopped") {
        throw interrupted();
      }
      return unwrap(first);
    } finally {
      clearInterval(poll);
      deadline?.cancel();
      // the request is ended and waited for: nothing of it happens after this returns
      scope.abort();
      await outcome;
    }
  }

  /** Returns whether the request is stopped: its cancellation was aborted or the client was cancelled. */
  protected isStopped(cancellation: AbortSignal): boolean {
    return cancellation.aborted || this.abortEvent.signal.aborted;
  }

  /** The signal of the client's own stop (cancel), for the request that runs. */
  protected get abortSignal(): AbortSignal {
    return this.abortEvent.signal;
  }

  /** Frees what the client holds, once no request runs (by default nothing). */
  protected release(): void {}

  /** Remembers that the model's conversation is lost for ``reason`` and returns the error that says so. */
  protected lostSession(reason: string): SessionLost {
    this.lostReason = reason;

    return new SessionLost(reason);
  }

  /**
   * Returns a model service's ``baseUrl`` without a slash at its end; throws for one that is no plain HTTP(S) URL
   * (read as Python's urllib.parse.urlparse reads it).
   */
  static serviceUrl(baseUrl: string): string {
    const parsed = urlParts(baseUrl);
    if (
      (parsed.scheme !== "http" && parsed.scheme !== "https") ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      throw new ValueError("Model base_url must be HTTP(S) without embedded credentials");
    }

    return baseUrl.replace(/\/+$/, "");
  }
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/;

/**
 * The parts of a URL that the check of a service's address reads, as urllib.parse.urlparse of Python 3.12 gives
 * them: the scheme in lower case, and of the network location the host name in lower case, the user name and the
 * password (each undefined where the URL has none).
 */
export function urlParts(url: string): {
  scheme: string;
  hostname: string | undefined;
  username: string | undefined;
  password: string | undefined;
} {
  // urlsplit drops leading control characters and spaces, and every tab and line break
  let rest = url.replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, "");
  let scheme = "";
  const colon = rest.indexOf(":");
  if (colon > 0 && SCHEME.test(rest.slice(0, colon))) {
    scheme = rest.slice(0, colon).toLowerCase();
    rest = rest.slice(colon + 1);
  }

  let netloc = "";
  if (rest.startsWith("//")) {
    const end = rest.slice(2).search(/[/?#]/);
    netloc = end < 0 ? rest.slice(2) : rest.slice(2, 2 + end);
    if (netloc.includes("[") !== netloc.includes("]")) {
      throw new ValueError("Invalid IPv6 URL");
    }
  }

  const at = netloc.lastIndexOf("@");
  let username: string | undefined;
  let password: string | undefined;
  if (at >= 0) {
    const userInfo = netloc.slice(0, at);
    const separator = userInfo.indexOf(":");
    username = separator < 0 ? userInfo : userInfo.slice(0, separator);
    password = separator < 0 ? undefined : userInfo.slice(separator + 1);
  }

  const hostInfo = netloc.slice(at + 1);
  const open = hostInfo.indexOf("[");
  let hostname: string;
  if (open >= 0) {
    const bracketed = hostInfo.slice(open + 1);
    const close = bracketed.indexOf("]");
    hostname = close < 0 ? bracketed : bracketed.slice(0, close);
  } else {
    const port = hostInfo.indexOf(":");
    hostname = port < 0 ? hostInfo : hostInfo.slice(0, port);
  }
  // (the zone of a scoped IPv6 address, after %, keeps its case)
  const percent = hostname.indexOf("%");
  const zone = percent < 0 ? "" : hostname.slice(percent);
  const lowered = hostname.slice(0, hostname.length - zone.length).toLowerCase() + zone;

  return { scheme, hostname: hostname ? lowered : undefined, username, password };
}
