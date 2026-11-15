// The window's side of the station: it starts the Worker that runs the robot (station_worker.ts) and talks to it
// by the messages of station_protocol.ts. The window never steps a control loop.
//
// The Worker's code is a text inside the page's one script; the build's wrapper makes a Blob of it and starts the
// Worker from the Blob's URL, so the page loads nothing more, from a folder as from a host.

import {
  type FromStation,
  REQUEST_LIMIT_MS,
  type StationEvent,
  type StationFailure,
  type StationRequest,
  type StationResults,
} from "./station_protocol";
import StartStationWorker from "./station_worker?worker&inline";

/** How long the Worker may tell nothing while the station is enabled before it is shown as not answering, ms. */
export const SILENT_AFTER_MS = 2000;

/** What the station answered a request with: the robot's own class name and message. */
export class StationError extends Error {
  constructor(readonly failure: StationFailure) {
    super(`${failure.name}: ${failure.message}`);
    this.name = "StationError";
  }
}

/** A request that got no answer: its time was over, or the Worker died. */
export class StationLost extends Error {
  constructor(
    readonly reason: "silent" | "died",
    detail: string,
  ) {
    super(detail);
    this.name = "StationLost";
  }
}

export interface StationHooks {
  onEvent(event: StationEvent): void;
  /** The Worker died ("died") or does not answer ("silent"). */
  onLost(reason: "silent" | "died", detail: string): void;
}

interface Waiting {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class StationClient {
  /** The Worker, once started; a check may end it to see what the page then shows. */
  worker: Worker | null = null;
  /** Whether status events are due: the station is enabled. */
  expectsStatus = false;
  private nextId = 0;
  private lastMessageAt = 0;
  private readonly waiting = new Map<number, Waiting>();
  private watch: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly hooks: StationHooks) {}

  /** Starts the Worker, if it does not run. */
  start(): void {
    if (this.worker !== null) return;
    const worker = new StartStationWorker({ name: "pearjs-station" });
    worker.onmessage = (event: MessageEvent<FromStation>) => this.receive(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      this.lose("died", event.message || "the Worker failed");
    };
    worker.onmessageerror = () => this.lose("died", "a message of the Worker could not be read");
    this.worker = worker;
    this.lastMessageAt = performance.now();
    this.watch = setInterval(() => {
      // a hidden page's timers are slowed down, the Worker's perhaps too: silence is judged on a visible page
      if (!this.expectsStatus || document.hidden) {
        this.lastMessageAt = performance.now();
      } else if (performance.now() - this.lastMessageAt > SILENT_AFTER_MS) {
        this.hooks.onLost("silent", `no message for ${Math.round(performance.now() - this.lastMessageAt)} ms`);
      }
    }, 500);
  }

  /** Sends `request` and returns its result; rejects with the station's error, or when no answer came in
   * `limitMs`. */
  request<Type extends StationRequest["type"]>(
    request: Extract<StationRequest, { type: Type }>,
    limitMs: number = REQUEST_LIMIT_MS[request.type],
  ): Promise<StationResults[Type]> {
    const worker = this.worker;
    if (worker === null) return Promise.reject(new StationLost("died", "the Worker does not run"));
    const id = ++this.nextId;

    return new Promise<StationResults[Type]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        const detail = `no answer to "${request.type}" in ${limitMs} ms`;
        this.hooks.onLost("silent", detail);
        reject(new StationLost("silent", detail));
      }, limitMs);
      this.waiting.set(id, { resolve: resolve as (result: unknown) => void, reject, timer });
      worker.postMessage({ id, request });
    });
  }

  /** Ends the Worker: whatever it ran is gone, and every request that waits is rejected. */
  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.expectsStatus = false;
    if (this.watch !== null) clearInterval(this.watch);
    this.watch = null;
    for (const [id, waiting] of this.waiting) {
      clearTimeout(waiting.timer);
      waiting.reject(new StationLost("died", "the Worker was ended"));
      this.waiting.delete(id);
    }
  }

  private receive(message: FromStation): void {
    this.lastMessageAt = performance.now();
    if (message.kind === "event") {
      this.hooks.onEvent(message.event);
    } else if (message.kind === "reply") {
      const waiting = this.waiting.get(message.id);
      if (waiting === undefined) return; // its time was over
      this.waiting.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.isOk) waiting.resolve(message.result);
      else waiting.reject(new StationError(message.error));
    }
  }

  private lose(reason: "died", detail: string): void {
    this.hooks.onLost(reason, detail);
    for (const [id, waiting] of this.waiting) {
      clearTimeout(waiting.timer);
      waiting.reject(new StationLost(reason, detail));
      this.waiting.delete(id);
    }
  }
}
