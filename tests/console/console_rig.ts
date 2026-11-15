// The rig of console.test.ts: what replays a scenario of tests/fixtures/console/console.json on the port's Console.
// The record is of PEAR's own Console, HomeReview and ControlLease, run by tools/fixtures/console_core_fixtures.py;
// this file is that script's rig (its classes Clock, StandIn and Stage) in TypeScript, around the port.
//
// How the port's Console is given what the script sets on PEAR's by attributes. The script makes PEAR's console
// without its constructor and sets every attribute. The port's Console is made by its constructor, with the
// stand-ins as its options (robot, recordings, preview, uploads, annotations, camera feed, commands, watchdog, the
// records, the scripted clocks and ids); the two parts the constructor makes itself and the script replaces,
// `task_run` and `health_checks`, are written over the made console's `taskRun` and `healthChecks` (read-only for
// the type alone). `emit` and `setPhase` are wrapped on the instance, as the script wraps PEAR's. The constructor
// must call nothing of a stand-in (PEAR's record has no such call): the stage throws if it does.
//
// A stand-in's call is recorded under PEAR's name with PEAR's arguments and keywords, from what the port's call was
// given (STAND-IN CALLS below): an options object is PEAR's keywords, each key in PEAR's spelling, and only the keys
// the port gave; the one positional argument of the robot's status is PEAR's keyword `with_snapshot`. PEAR calls
// profile() of the robot; the port's console is given it apart (ConsoleOptions.robotProfile), and the rig records
// that call as the robot's. A part of which console.py calls nothing (uploads, annotations, commands, the camera
// feed, and the robot as the turn loop takes it) records any call under the port's own name, which no record holds.
//
// The threads. PEAR's worker is a thread; the port's is an async function that launch starts. The rig calls launch
// inside an async context named "worker" (AsyncLocalStorage): what the worker's body does, after any await, is the
// worker's, everything else the main thread's. Where the script waits for a thread (the worker's end, an operation
// that blocks, a Home review that waits), the rig awaits the worker's end, the operation's own signal, or one turn
// of the event loop, after which everything that can run without the script has run.

import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { EventData } from "../../src/agent/clients/schemas";
import { ModelsConfig, OfferedModel } from "../../src/agent/config";
import { SINGLE_ARM_POSE_FORMAT } from "../../src/agent/formats";
import type { AgentRobot } from "../../src/agent/robot";
import { Console, type ConsoleEventRecord, type ConsoleRecords, type ConsoleRobot, type Operation } from "../../src/console/console";
import { Phase } from "../../src/console/phase";
import type { ModelState, SingleArmDelta } from "../../src/protocol/types";
import { pythonErrorMessage, pythonErrorName, RuntimeError } from "../../src/python/errors";
import type { CameraFeed } from "../../src/station/cameras";
import { OperatorPaused } from "../../src/station/exceptions";
import { HomeFailed } from "../../src/station/motion/homing";
import type { HomePlan } from "../../src/station/schemas";
import { ScriptedClient } from "../agent/stand_ins";

// ---- the record ----

export type Thread = "main" | "worker";
export const THREADS: readonly Thread[] = ["main", "worker"];

/** What a record keeps of an error: the class's name and str() of it. */
export interface Raised {
  type: string;
  message: string;
}

/** One call of the robot or of a stand-in, as the script records it. */
export interface CallEntry {
  of: string;
  call: string;
  arguments: unknown[];
  keywords: Record<string, unknown>;
  /** console.last_event_id when the call began. */
  after_event: number;
  returned?: unknown;
  raised?: Raised;
}

/** A step as a scenario scripts it. */
export interface StepScript {
  op: string;
  [key: string]: unknown;
}

/** What a step's record holds beside its script; the replay makes the same. */
export interface StepMade {
  returned: unknown;
  raised: Raised | null;
  events: Record<string, unknown>[];
  phases: Record<Thread, string[]>;
  calls: Record<Thread, CallEntry[]>;
  operations: Record<string, unknown>[];
  fields: Record<string, unknown>;
  files: Record<string, unknown>[];
  clock: Record<string, number>;
}

export interface CoreStep extends StepMade {
  script: StepScript;
}

export interface CoreScenario {
  name: string;
  pins: unknown;
  monotonic_step_s: number;
  initial: Record<string, unknown>;
  uuids: string[];
  steps: CoreStep[];
}

export interface CoreMeta {
  models: Record<string, string>;
  model: string;
  robot_profile: Record<string, unknown>;
  robot_session_id: string;
  recording: unknown;
  cameras: unknown;
  wall_start_s: number;
  wall_step_s: number;
  monotonic_start_s: number;
  ns_start: number;
  ns_step: number;
  constants: Record<string, Record<string, unknown>>;
  counts: Record<string, number>;
}

export interface CoreFixture {
  meta: CoreMeta;
  scenarios: CoreScenario[];
}

/** Returns tests/fixtures/console/console.json; the script packs it (console.json.gz) once it is too large. */
export function loadCoreFixture(): CoreFixture {
  const path = fileURLToPath(new URL("../fixtures/console/console.json", import.meta.url));
  const text = existsSync(path) ? readFileSync(path, "utf8") : gunzipSync(readFileSync(`${path}.gz`)).toString("utf8");

  return JSON.parse(text) as CoreFixture;
}

/** Returns ``value`` as JSON reads it back (the script's plain()): a copy; None for what is not there. */
export function plain<T>(value: T): T {
  return value === undefined ? (null as T) : (JSON.parse(JSON.stringify(value)) as T);
}

/** Whether two JSON values are the same, as Python's == tells it of what json.loads returns: a dictionary's keys in
 * any order. */
function sameJson(first: unknown, second: unknown): boolean {
  if (Array.isArray(first) || Array.isArray(second)) {
    return (
      Array.isArray(first) &&
      Array.isArray(second) &&
      first.length === second.length &&
      first.every((item, index) => sameJson(item, second[index]))
    );
  }
  if (typeof first === "object" && first !== null && typeof second === "object" && second !== null) {
    const keys = Object.keys(first);
    const other = second as Record<string, unknown>;

    const own = first as Record<string, unknown>;

    return (
      keys.length === Object.keys(other).length &&
      keys.every((key) => Object.hasOwn(other, key) && sameJson(own[key], other[key]))
    );
  }

  return first === second;
}

// ---- the clocks and the ids ----

/** The scripted clocks of one scenario (the script's Clock): each reading is counted. */
export class ScriptedClock {
  advancedS = 0;
  wallReadings = 0;
  monotonicReadings = 0;
  nsReadings = 0;

  constructor(
    private readonly meta: CoreMeta,
    private readonly monotonicStepS: number,
  ) {}

  /** time.time() */
  readonly time = (): number => {
    this.wallReadings += 1;

    return this.meta.wall_start_s + (this.wallReadings - 1) * this.meta.wall_step_s;
  };

  nextMonotonic(): number {
    return this.meta.monotonic_start_s + this.advancedS + this.monotonicReadings * this.monotonicStepS;
  }

  /** time.monotonic() */
  readonly monotonic = (): number => {
    const value = this.nextMonotonic();
    this.monotonicReadings += 1;

    return value;
  };

  /** time.time_ns() */
  readonly timeNs = (): bigint => {
    this.nsReadings += 1;

    return BigInt(this.meta.ns_start) + BigInt(this.nsReadings - 1) * BigInt(this.meta.ns_step);
  };

  record(): Record<string, number> {
    return {
      wall_readings: this.wallReadings,
      monotonic_readings: this.monotonicReadings,
      ns_readings: this.nsReadings,
      monotonic_s: this.nextMonotonic(),
    };
  }
}

// ---- the records ----

/** The console's root in memory, under the names of PEAR's files: the records beside the tasks' folders and each
 * task's events.jsonl. */
export class CoreRecords implements ConsoleRecords {
  protected readonly json = new Map<string, unknown>();
  protected readonly lines = new Map<string, unknown[]>();

  writeJson(taskId: string, name: string, value: EventData): void {
    this.json.set(`${taskId}/${name}`, plain(value));
  }

  readFile(taskId: string, name: string): Uint8Array {
    throw new RuntimeError(`The task ${taskId} was given no file ${name}`);
  }

  writeRootJson(name: string, value: EventData): void {
    // (PEAR writes the text now: what is written to the value afterwards is not in the file)
    this.json.set(name, plain(value));
  }

  appendEvent(taskId: string, event: ConsoleEventRecord): void {
    const name = `${taskId}/events.jsonl`;
    const lines = this.lines.get(name) ?? [];
    lines.push(plain(event));
    this.lines.set(name, lines);
  }

  /** Whether the event file of the task ``taskId`` holds ``event`` as one of its lines. */
  holds(taskId: string, event: unknown): boolean {
    return (this.lines.get(`${taskId}/events.jsonl`) ?? []).some((line) => sameJson(line, event));
  }

  /** Every file under the root, as the script lists them: sorted as Python sorts paths, by their parts. */
  files(): Record<string, unknown>[] {
    const rows: Record<string, unknown>[] = [];
    for (const [name, lines] of this.lines) {
      rows.push({ name, event_ids: lines.map((line) => (line as { id: number }).id) });
    }
    for (const [name, json] of this.json) {
      rows.push({ name, json: plain(json) });
    }
    const parts = (row: Record<string, unknown>): string[] => (row["name"] as string).split("/");

    return rows.sort((first, second) => {
      const [a, b] = [parts(first), parts(second)];
      for (let index = 0; index < Math.min(a.length, b.length); index++) {
        if (a[index] !== b[index]) {
          return a[index]! < b[index]! ? -1 : 1;
        }
      }

      return a.length - b.length;
    });
  }
}

// ---- the stand-ins ----

/** PEAR's keywords of an options object of the port: the keys the port gave, in PEAR's spelling. */
function keywordsOf(options: object | undefined): Record<string, unknown> {
  const keywords: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options ?? {})) {
    if (value !== undefined) {
      keywords[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)] = value;
    }
  }

  return keywords;
}

/** What stands in for a part of the console (the script's StandIn): it records every call made of it, raises where
 * the scenario scripts it, and returns a copy of the scripted value, None without one. */
export class StandIn {
  readonly returns: Record<string, unknown> = {};

  constructor(
    private readonly stage: ConsoleStage,
    readonly name: string,
  ) {}

  call(method: string, given: unknown[] = [], keywords: Record<string, unknown> = {}): unknown {
    const stage = this.stage;
    const entry: CallEntry = {
      of: this.name,
      call: method,
      arguments: plain(given),
      keywords: plain(keywords),
      after_event: stage.lastEventId(),
    };
    const raises = stage.raises;
    try {
      if (raises !== null && raises.of === this.name && raises.call === method) {
        entry.raised = { type: "RuntimeError", message: raises.message };
        throw new RuntimeError(raises.message);
      }
      const value = plain(this.returns[method]);
      if (value !== null) {
        entry.returned = structuredClone(value);
      }

      return value;
    } finally {
      stage.calls[stage.thread()].push(entry);
    }
  }

  /** The same for a call the port awaits: recorded as it is made; what it raises is the promise's rejection. */
  awaited(method: string, given: unknown[] = [], keywords: Record<string, unknown> = {}): Promise<unknown> {
    try {
      return Promise.resolve(this.call(method, given, keywords));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** An object of which every method is recorded under the name it was called by: for a part console.py calls
   * nothing of. */
  anything(): object {
    return new Proxy(
      {},
      {
        get: (_target, method) =>
          typeof method !== "string" || method === "then" || method.startsWith("_")
            ? undefined
            : (...given: unknown[]) => this.call(method, given),
      },
    );
  }
}

/** PEAR's stand-in scripted client, under the name the record holds; no scenario asks it anything. */
export class StandInScriptedClient extends ScriptedClient {}

/** The task run as the script stands in for it: the fields the console reads, and close_session(). */
export interface StandInTaskRun {
  task: Record<string, unknown> | null;
  activeTurn: Record<string, unknown> | null;
  session: { turnCount: number } | null;
  totalSteps: number;
  inferenceStartedAt: number | null;
  closeSession(): Promise<unknown>;
}

/** An operation of a launch as a scenario scripts it. */
interface OperationScript {
  do: "return" | "raise" | "block" | "home_review";
  error?: { type: string; message: string; details?: Record<string, unknown> };
  then?: OperationScript;
  plan?: Record<string, unknown>;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

/** PEAR's names of the lease's methods, and the port's. */
const LEASE_METHODS: Record<string, "lostOwner" | "isExpired" | "heartbeat" | "require" | "claim" | "release"> = {
  lost_owner: "lostOwner",
  is_expired: "isExpired",
  heartbeat: "heartbeat",
  require: "require",
  claim: "claim",
  release: "release",
};

/** The longest the rig waits for the worker, ms: the port's worker needs no time, so this ends a wait that would
 * never end. */
const WAIT_MS = 2000;

/** One scenario's rig (the script's Stage): new clocks, the scenario's UUIDs, the port's console and what stands
 * in around it. */
export class ConsoleStage {
  readonly clock: ScriptedClock;
  readonly records: CoreRecords = this.newRecords();
  readonly console: Console<ModelState, SingleArmDelta>;
  readonly taskRun: StandInTaskRun;

  events: Record<string, unknown>[] = [];
  phases: Record<Thread, string[]> = { main: [], worker: [] };
  calls: Record<Thread, CallEntry[]> = { main: [], worker: [] };
  operations: Record<string, unknown>[] = [];
  /** The call of a stand-in that raises from now on: the scenario's `failing`. */
  raises: { of: string; call: string; message: string } | null = null;
  /** How many of the scenario's UUIDs were drawn. */
  drawn = 0;
  /** The time limits the port waited on (Thread.join(timeout) of a live worker): no record has one. */
  readonly sleeps: number[] = [];
  /** What the port logged (logger.exception); the record does not hold PEAR's. */
  readonly logged: unknown[][] = [];

  protected readonly threads = new AsyncLocalStorage<Thread>();
  protected readonly robot: StandIn;
  private readonly robotSession: { id: string | null };
  private readonly healthChecks: StandIn;
  private made: Console<ModelState, SingleArmDelta> | null = null;
  /** Lets the operation that runs go on, while it blocks. */
  private release: () => void = () => undefined;
  /** What the last prepare() of a step returned. */
  private reviewPlan: Record<string, unknown> | null = null;

  constructor(meta: CoreMeta, scenario: CoreScenario) {
    this.clock = new ScriptedClock(meta, scenario.monotonic_step_s);
    const clock = this.clock;

    const robot = (this.robot = new StandIn(this, "robot"));
    robot.returns["status"] = ConsoleStage.robotState("OFF");
    robot.returns["profile"] = meta.robot_profile;
    const session = (this.robotSession = { id: meta.robot_session_id });
    const recordings = new StandIn(this, "recordings");
    recordings.returns["snapshot"] = meta.recording;
    const preview = new StandIn(this, "preview");
    preview.returns["status"] = meta.cameras;
    const watchdog = new StandIn(this, "watchdog");
    const healthChecks = (this.healthChecks = new StandIn(this, "health_checks"));
    const taskRun = new StandIn(this, "task_run");

    // ---- STAND-IN CALLS: the port's call, and PEAR's as it is recorded ----
    const consoleRobot = {
      get sessionId(): string | null {
        return session.id; // (an attribute in PEAR: not a call)
      },
      stop: () => robot.awaited("stop"),
      // PEAR: status() and status(with_snapshot=True)
      status: (...given: unknown[]) => robot.call("status", [], given.length === 0 ? {} : { with_snapshot: given[0] }),
      close: () => robot.awaited("close"),
    };
    const consoleRecordings = {
      // PEAR: stop(reason) and stop(reason, stopped_at=...)
      stop: (reason: string, options?: { stoppedAt?: number }) => recordings.call("stop", [reason], keywordsOf(options)),
      snapshot: () => recordings.call("snapshot"),
      onEvent: (kind: string, data: EventData) => {
        recordings.call("on_event", [kind, data]);
      },
      close: () => recordings.awaited("close").then(() => undefined),
    };
    const consolePreview = {
      status: () => preview.call("status"),
      close: () => preview.awaited("close").then(() => undefined),
    };
    const consoleWatchdog = { close: () => watchdog.awaited("close").then(() => undefined) };
    const consoleHealthChecks = {
      get: (model: string) => healthChecks.call("get", [model]),
      // PEAR: check(model, is_forced=...)
      check: (model: string, options?: { isForced?: boolean }) => healthChecks.awaited("check", [model], keywordsOf(options)),
    };
    this.taskRun = {
      task: null,
      activeTurn: null,
      session: null,
      totalSteps: 0,
      inferenceStartedAt: null,
      closeSession: () => taskRun.awaited("close_session"),
    };

    const models: Record<string, OfferedModel> = {};
    for (const [name, label] of Object.entries(meta.models)) {
      models[name] = new OfferedModel({ label, clientClass: StandInScriptedClient, client: {}, timeoutS: 60.0 });
    }
    const modelsConfig = new ModelsConfig<ModelState, SingleArmDelta>({
      robotTitle: "SO-101",
      actionFormats: { [SINGLE_ARM_POSE_FORMAT.name]: SINGLE_ARM_POSE_FORMAT },
      defaultModel: meta.model,
      models,
    });

    const uuids = scenario.uuids;
    const console = new Console<ModelState, SingleArmDelta>({
      modelsConfig,
      robot: consoleRobot as unknown as ConsoleRobot,
      agentRobot: robot.anything() as AgentRobot<ModelState, SingleArmDelta>,
      cameraFeed: new StandIn(this, "camera_feed").anything() as CameraFeed<unknown>,
      robotProfile: () => robot.call("profile") as Record<string, unknown>,
      records: this.records,
      uploads: new StandIn(this, "uploads").anything(),
      recordings: consoleRecordings,
      annotations: new StandIn(this, "annotations").anything(),
      preview: consolePreview,
      commands: () => new StandIn(this, "commands").anything(),
      watchdog: () => consoleWatchdog,
      wallClock: clock.time,
      clock: clock.monotonic,
      timeNs: clock.timeNs,
      uuid: () => {
        if (this.drawn >= uuids.length) {
          throw new Error(`the port drew a UUID more than the scenario's ${uuids.length}`);
        }

        return uuids[this.drawn++]!;
      },
      sleep: (seconds) => this.wait(seconds),
      log: (...line: unknown[]) => {
        this.logged.push(line);
      },
    });
    const called = THREADS.flatMap((thread) => this.calls[thread]);
    if (called.length > 0 || clock.wallReadings + clock.monotonicReadings + clock.nsReadings + this.drawn > 0) {
      throw new Error(`the port's constructor called a stand-in or read a clock: ${JSON.stringify(called).slice(0, 300)}`);
    }
    // the two parts the script sets on PEAR's console and the port's constructor makes itself
    const given = console as unknown as { taskRun: StandInTaskRun; healthChecks: typeof consoleHealthChecks };
    given.taskRun = this.taskRun;
    given.healthChecks = consoleHealthChecks;

    const emit = console.emit.bind(console); // the port's own, which still run
    const setPhase = console.setPhase.bind(console);
    console.emit = (kind, data, options) => {
      const event = emit(kind, data, options);
      this.events.push({ ...plain(event), thread: this.thread() });

      return event;
    };
    console.setPhase = (phase) => {
      this.phases[this.thread()].push(plain(phase));
      setPhase(phase);
    };
    this.console = this.made = console;
  }

  /** The console's wait on a time limit: recorded, and over at once (a stage of a larger rig lets the worker end
   * first: commands_rig.ts). */
  protected wait(seconds: number): Promise<void> {
    this.sleeps.push(seconds);

    return Promise.resolve();
  }

  /** Makes the records in memory (a stage of a larger rig gives its own: commands_rig.ts). */
  protected newRecords(): CoreRecords {
    return new CoreRecords();
  }

  /** A scripted status of the robot: the keys the console reads. */
  static robotState(status: string): Record<string, unknown> {
    return { status, generation: 0, fault: null, fault_details: null, motion: { settling: false } };
  }

  /** Which of PEAR's threads acts. */
  thread(): Thread {
    return this.threads.getStore() ?? "main";
  }

  /** console.last_event_id; 0 while the console is being made. */
  lastEventId(): number {
    return this.made === null ? 0 : this.made.lastEventId;
  }

  // ---- the worker ----

  private async within(promise: Promise<unknown>, what: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`the script waited too long: ${what}`)), WAIT_MS);
    });
    try {
      await Promise.race([promise, limit]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Lets everything run that can run without the script: one turn of the event loop. */
  private settle(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  /** Waits for the worker's end. */
  async join(): Promise<void> {
    const worker = this.console.worker;
    if (worker === null) {
      throw new Error("no worker to wait for");
    }
    await this.within(worker.ended, "the worker did not end");
  }

  /** Returns the operation ``script`` scripts, which records what it was given and how it ended. */
  private operationOf(script: OperationScript): { operation: Operation; reached: Deferred; release: Deferred } {
    const review = this.console.homeReview;
    const [reached, release] = [deferred(), deferred()]; // this operation's own, while it blocks

    const run = async (spec: OperationScript, cancellation: AbortSignal): Promise<unknown> => {
      if (spec.do === "return") {
        return null;
      }
      if (spec.do === "raise") {
        const error = spec.error!;
        if (error.type === "HomeFailed") {
          throw new HomeFailed(error.message, structuredClone(error.details!));
        }
        if (error.type === "OperatorPaused") {
          throw new OperatorPaused(error.message);
        }
        if (error.type === "RuntimeError") {
          throw new RuntimeError(error.message);
        }
        throw new Error(`the rig knows no error ${error.type}`);
      }
      if (spec.do === "block") {
        reached.resolve();
        await this.within(release.promise, "the blocked operation was never released");

        return run(spec.then ?? { do: "return" }, cancellation);
      }
      if (spec.do === "home_review") {
        return review.waitForDecision(review.prepare(structuredClone(spec.plan!) as unknown as HomePlan), cancellation);
      }
      throw new Error(`the rig knows no operation ${String(spec.do)}`);
    };

    const operation: Operation = async (cancellation) => {
      const entry: Record<string, unknown> = {
        cancellation_is_the_consoles: cancellation === this.console.cancellation.signal,
        cancellation_was_set: cancellation.aborted,
      };
      try {
        entry["returned"] = plain(await run(script, cancellation));
      } catch (error) {
        entry["raised"] = { type: pythonErrorName(error), message: pythonErrorMessage(error) };
        throw error;
      } finally {
        this.operations.push(entry);
      }
    };

    return { operation, reached, release };
  }

  // ---- a step ----

  /** The script's own step `set`: writes the keys given, in their order. */
  private set(spec: StepScript): void {
    const console = this.console;
    for (const [key, given] of Object.entries(spec)) {
      const value = structuredClone(given);
      if (key === "op") {
        continue;
      } else if (key === "task") {
        this.taskRun.task = value as Record<string, unknown> | null; // (its folder holds no file yet)
      } else if (key === "active_turn") {
        this.taskRun.activeTurn = value as Record<string, unknown> | null;
      } else if (key === "total_steps") {
        this.taskRun.totalSteps = value as number;
      } else if (key === "inference_started_at") {
        this.taskRun.inferenceStartedAt = value as number | null;
      } else if (key === "session_turn_count") {
        this.taskRun.session = value === null ? null : { turnCount: value as number };
      } else if (key === "robot") {
        this.robot.returns["status"] = value;
      } else if (key === "robot_session_id") {
        this.robotSession.id = value as string | null;
      } else if (key === "model_health") {
        this.healthChecks.returns["get"] = value;
        this.healthChecks.returns["check"] = value;
      } else if (key === "model") {
        console.model = value as string;
      } else if (key === "performance") {
        console.performance = value as EventData | null;
      } else if (key === "home_status") {
        console.homeStatus = value as Record<string, unknown> | null;
      } else if (key === "error") {
        console.error = value as string | null;
      } else if (key === "home_plan") {
        console.homeReview.plan = value as Record<string, unknown> | null;
      } else if (key === "failing") {
        this.raises = value as ConsoleStage["raises"];
      } else {
        throw new Error(`the rig knows no key ${key} of a set`);
      }
    }
  }

  /** Returns the call of the port that the step ``spec`` scripts, or null after a step of the script's own. */
  protected async callOf(spec: StepScript): Promise<(() => unknown) | null> {
    const console = this.console;
    const review = console.homeReview;
    const has = (key: string): boolean => Object.hasOwn(spec, key);

    switch (spec.op) {
      case "set":
        this.set(spec);
        return null;
      case "advance":
        this.clock.advancedS += spec["seconds"] as number;
        return null;
      case "release_operation":
        this.release();
        await this.join();
        return null;
      case "wake":
        review.answered.abort();
        await this.settle();
        if (review.answered.signal.aborted || !console.isBusy) {
          throw new Error("the waiting operation did not clear the wake and wait again");
        }
        return null;
      case "emit": {
        const options = has("is_saved") ? { isSaved: spec["is_saved"] as boolean } : {};
        const data = spec["data"] as EventData;
        const count = spec["repeat"] as number | undefined;

        return () => {
          if (count === undefined) {
            return console.emit(spec["kind"] as string, structuredClone(data), options);
          }
          let event: unknown = undefined;
          for (let index = 0; index < count; index++) {
            event = console.emit(spec["kind"] as string, { ...structuredClone(data), n: index }, options);
          }

          return event;
        };
      }
      case "stop":
        return () =>
          console.stop({
            ...(has("is_latching") ? { isLatching: spec["is_latching"] as boolean } : {}),
            ...(has("reason") ? { reason: spec["reason"] as string } : {}),
          });
      case "launch": {
        const script = spec["operation"] as OperationScript;
        const options: { cancellation?: AbortController; isRecorded?: boolean } = {};
        if (has("is_recorded")) {
          options.isRecorded = spec["is_recorded"] as boolean;
        }
        if (has("cancellation")) {
          options.cancellation = new AbortController();
          if (spec["cancellation"] === "set") {
            options.cancellation.abort();
          }
        }
        const { operation, reached, release } = this.operationOf(script);

        return async () => {
          this.threads.run("worker", () => console.launch(operation, options));
          this.release = release.resolve; // of the operation that runs
          if (script.do === "block") {
            await this.within(reached.promise, "the operation did not begin");
          } else if (script.do === "home_review") {
            await this.settle();
            if (review.plan === null || !console.isBusy) {
              throw new Error("the operation does not wait for the operator's answer");
            }
          } else {
            await this.join();
          }

          return null;
        };
      }
      case "snapshot":
        return () => console.snapshot();
      case "close":
        return () => console.close();
      case "confirm": {
        const planId = spec["plan_id"] === "current" ? review.plan!["plan_id"] : spec["plan_id"];

        return () => review.confirm(planId, spec["is_confirmed"] as boolean);
      }
      case "home_review": {
        if (spec["method"] === "prepare") {
          return () => (this.reviewPlan = review.prepare(structuredClone(spec["plan"]) as unknown as HomePlan));
        }
        const cancellation = new AbortController();
        if (spec["cancelled"] === true) {
          cancellation.abort();
        }
        if (has("decision")) {
          review.decision = spec["decision"] as boolean | null;
        }

        return () => review.waitForDecision(this.reviewPlan!, cancellation.signal);
      }
      case "lease": {
        const method = LEASE_METHODS[spec["method"] as string]!;
        const given = has("client_id") ? [spec["client_id"] as string] : [];

        return () => (console.lease[method] as (...clientId: string[]) => unknown)(...given);
      }
      case "robot_status":
        return () => console.robotStatus();
      case "phase":
        return () => console.phase;
      case "is_busy":
        return () => console.isBusy;
      case "supports_reference_images":
        return () => console.supportsReferenceImages();
      case "action_format":
        return () => ({ name: console.actionFormat.name });
      case "set_phase":
        return () => console.setPhase(Phase[spec["phase"] as keyof typeof Phase]);
      case "check_model":
        return () => console.checkModel(has("is_forced") ? { isForced: spec["is_forced"] as boolean } : {});
      case "new_client":
        return () => ({ class: console.newClient(spec["model"] as string, spec["instruction"] as string).constructor.name });
      default:
        throw new Error(`the rig knows no step ${spec.op}`);
    }
  }

  /** Runs one step and returns what its record holds (the script's Stage.step). */
  async step(spec: StepScript): Promise<StepMade> {
    const call = await this.callOf(spec);
    let returned: unknown = null;
    let raised: Raised | null = null;
    if (call !== null) {
      try {
        returned = await call();
      } catch (error) {
        raised = { type: pythonErrorName(error), message: pythonErrorMessage(error) };
      }
    }
    if (spec["join"] === true) {
      await this.join();
    }

    const events = [...this.events].sort((first, second) => (first["id"] as number) - (second["id"] as number));
    const [phases, calls, operations] = [this.phases, this.calls, this.operations];
    this.events = [];
    this.operations = [];
    this.phases = { main: [], worker: [] };
    this.calls = { main: [], worker: [] };

    return {
      returned: plain(returned),
      raised,
      events: events.map((event) => ({ ...event, saved: this.isSaved(event) })),
      phases,
      calls,
      operations,
      fields: this.fields(),
      files: this.records.files(),
      clock: this.clock.record(),
    };
  }

  /** Whether the event file of the event's task holds the event as one of its lines. */
  private isSaved(event: Record<string, unknown>): boolean {
    const taskId = event["task_id"];
    if (typeof taskId !== "string" || taskId === "") {
      return false;
    }
    const made = Object.fromEntries(Object.entries(event).filter(([key]) => key !== "thread"));

    return this.records.holds(taskId, made);
  }

  /** The console's fields as a record holds them. */
  fields(): Record<string, unknown> {
    const console = this.console;
    const [review, lease, worker] = [console.homeReview, console.lease, console.worker];
    const ids = console.events.map((event) => event.id);
    const identity = console.savedFaultIdentity;

    return plain({
      phase: console.phase,
      error: console.error,
      is_stop_latched: console.isStopLatched,
      performance: console.performance,
      home_status: console.homeStatus,
      saved_fault_identity: identity === null ? null : [...identity],
      is_busy: console.isBusy,
      worker: worker === null ? "none" : worker.isAlive ? "running" : "ended",
      last_event_id: console.lastEventId,
      events_kept: ids.length,
      first_kept_event_id: ids.length > 0 ? ids[0] : null,
      last_kept_event_id: ids.length > 0 ? ids[ids.length - 1] : null,
      cancellation_is_set: console.cancellation.signal.aborted,
      home_review: { plan: review.plan, decision: review.decision, answered: review.answered.signal.aborted },
      lease: { owner: lease.owner, heartbeat_at: lease.heartbeatAt },
    });
  }
}
