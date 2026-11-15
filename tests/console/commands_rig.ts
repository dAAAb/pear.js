// The rig of commands.test.ts: what replays a scenario of tests/fixtures/console/commands.json.gz on the port's
// Commands, Watchdog and PeriodicThread. The record is of PEAR's own Commands and Watchdog on PEAR's Console, run by
// tools/fixtures/console_commands_fixtures.py; this file is what that script's Stage adds to the rig of the
// console's own fixtures (console_rig.ts, which it extends), in TypeScript, around the port.
//
// What is added to the core rig's console, as the script adds it to PEAR's:
//
// - `console.commands` is the port's Commands, made with the scenario's scripted clock and UUIDs (the same
//   sequences as the console's) and with the three constants of the robot's class that meta.constants.robot holds.
// - The parts commands.py and watchdog.py use and console.py does not. The robot, the recordings and the preview
//   of the core rig are given the further methods and attributes in place; the camera feed, the uploads and the
//   annotations are replaced (the core rig's record any call under the port's own name). STAND-IN CALLS below says
//   how each call of the port is recorded in PEAR's form. An object PEAR passes and the record keeps by its class
//   alone ({"object": "Event"}, {"object": "TaskFiles"}, {"object": "StandIn"}, {"object": "function"}) is recorded
//   so only when the port passed the matching thing: an AbortSignal, the id of a task whose folder was made and is
//   still there, the console's camera feed, a function. Anything else is recorded under another name and differs.
// - PEAR's Annotations.clean_tags is a classmethod the script does not stand in for, and the port takes it as an
//   interface (CommandsAnnotations.cleanTags): the rig gives a copy of PEAR's (cleanTags below), which is the
//   rig's, not the port's.
// - The records in memory make and remove a task's folder (CommandsRecords.createTask and removeTask).
// - The task run stands in with `run` beside `close_session`: both are recorded calls that return at once.
// - The watchdog is the port's Watchdog made without its constructor (which starts its periodic thread): the step
//   `watchdog_check` calls its check on the main thread, as the script calls PEAR's _check.
//
// The threads. Commands launches the worker itself (start, resume, enable, ...), so `launch` is wrapped on the
// console: it runs inside the async context named "worker", as the core rig's own step `launch` runs it.
//
// console.WORKER_JOIN_S. The script writes it on PEAR's console object; the port reads the class's constant, so
// the step `set` with `worker_join_s` writes Console.WORKER_JOIN_S and `dispose()` puts it back: a test calls
// dispose() when a replay ends. The wait itself is scripted (`wait` below): it records the seconds (`sleeps`) and
// is over after one turn of the event loop, so the time limit of a join passes only for a worker that the script
// holds, as in PEAR's record.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { Commands, type CommandData, type CommandsConsole } from "../../src/console/commands";
import { Console, type Operation } from "../../src/console/console";
import { PeriodicThread } from "../../src/console/periodic_thread";
import { Watchdog, type WatchdogConsole } from "../../src/console/watchdog";
import type { ModelState, SingleArmDelta } from "../../src/protocol/types";
import { pythonErrorMessage, pythonErrorName, RuntimeError, ValueError } from "../../src/python/errors";
import { OperatorPaused } from "../../src/station/exceptions";
import { ConsoleStage, CoreRecords, plain, StandIn, type CoreMeta, type CoreScenario, type StepScript } from "./console_rig";

// ---- the record ----

export interface CommandsMeta extends CoreMeta {
  /** What camera_feed.reader is while the cameras' reader is open. */
  camera_reader: object;
  groups: number[];
}

export interface CommandsScenario extends CoreScenario {
  /** The part of the commands the scenario belongs to, 1 to 5. */
  group: number;
  rig: string;
}

export interface CommandsFixture {
  meta: CommandsMeta;
  scenarios: CommandsScenario[];
}

/** Returns tests/fixtures/console/commands.json; the script packs it (commands.json.gz) once it is too large. */
export function loadCommandsFixture(): CommandsFixture {
  const path = fileURLToPath(new URL("../fixtures/console/commands.json", import.meta.url));
  const text = existsSync(path) ? readFileSync(path, "utf8") : gunzipSync(readFileSync(`${path}.gz`)).toString("utf8");

  return JSON.parse(text) as CommandsFixture;
}

/** The keys of the task run a record holds (the script's TASK_RUN_FIELDS), each with the port's name. */
const TASK_RUN_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["task", "task"],
  ["total_steps", "totalSteps"],
  ["turn_number", "turnNumber"],
  ["active_attempt_id", "activeAttemptId"],
  ["active_turn", "activeTurn"],
  ["resume_pending", "resumePending"],
];
/** The keys of a `set` this rig applies, first and in this order (the script's SET_KEYS). */
const SET_KEYS: readonly string[] = [
  "cameras",
  "camera_reader",
  "session",
  "recording_segment",
  "worker_join_s",
  "robot_becomes",
  "attached_images",
  "supports_reference_images",
];
/** The robot's methods the console and the commands call: the port's name -> PEAR's. */
const ROBOT_METHODS: Readonly<Record<string, string>> = {
  stop: "stop",
  status: "status",
  close: "close",
  open: "open",
  waitStationary: "wait_stationary",
  waitSettled: "wait_settled",
  recover: "recover",
  home: "home",
};
/** Of the periodic threads the step `periodic` starts, on the machine's clock, s (the script's PERIOD_S). */
const PERIOD_S = 0.001;
const WAIT_MS = 2000;

type Method = (...given: unknown[]) => unknown;

/** Returns a command's data with every {"repeat": s, "times": n} as the string it stands for. */
function expand(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(expand);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    const record = value as Record<string, unknown>;
    if (entries.length === 2 && Object.hasOwn(record, "repeat") && Object.hasOwn(record, "times")) {
      return (record["repeat"] as string).repeat(record["times"] as number);
    }

    return Object.fromEntries(entries.map(([key, item]) => [key, expand(item)]));
  }

  return value;
}

/** What the record keeps of a value PEAR passes: an object that is no JSON by its class's name. */
function pearValue(value: unknown): unknown {
  if (value instanceof AbortSignal) {
    return { object: "Event" }; // (PEAR: a threading.Event)
  }
  if (typeof value === "function") {
    return { object: "function" };
  }

  return value;
}

/** PEAR's keywords of an options object of the port: the keys the port gave, in PEAR's spelling. */
function pearKeywords(options: object | undefined): Record<string, unknown> {
  const keywords: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options ?? {})) {
    if (value !== undefined) {
      keywords[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)] = pearValue(value);
    }
  }

  return keywords;
}

/** PEAR's Annotations.clean_tags (records/annotations.py), which the port takes as an interface: the tags trimmed,
 * with single spaces and without case-insensitive duplicates, in their first spelling. The rig's own copy: the
 * white space and the case folding are JavaScript's, which are Python's for the tags the scenarios give. */
export function cleanTags(rawTags: unknown): string[] {
  const [maxTags, maxTagLength, maxTagInputs] = [20, 40, 100];
  if (!Array.isArray(rawTags) || rawTags.length > maxTagInputs) {
    throw new ValueError("Tags must be a list of text");
  }
  const tags: string[] = [];
  const seenKeys = new Set<string>();
  for (const rawTag of rawTags) {
    if (typeof rawTag !== "string") {
      throw new ValueError("Tags must be text");
    }
    const tag = rawTag.split(/\s+/).filter((word) => word !== "").join(" ");
    if (tag === "") {
      continue;
    }
    if ([...tag].length > maxTagLength) {
      throw new ValueError(`Tags are limited to ${maxTagLength} characters`);
    }
    if (/[\x00-\x1f\x7f]/.test(tag)) {
      throw new ValueError("Tags cannot contain control characters");
    }
    if (!seenKeys.has(tag.toLowerCase())) {
      seenKeys.add(tag.toLowerCase());
      tags.push(tag);
    }
  }
  if (tags.length > maxTags) {
    throw new ValueError(`A task can have at most ${maxTags} tags`);
  }

  return tags;
}

/** The records in memory, with a task's folder as commands.py makes and removes it. */
export class CommandsRecords extends CoreRecords {
  private readonly folders = new Set<string>();

  /** TaskFiles(root / taskId).directory.mkdir(): a folder that exists already is an error. */
  createTask(taskId: string): void {
    const names = [...this.json.keys(), ...this.lines.keys()];
    if (this.folders.has(taskId) || names.some((name) => name.startsWith(`${taskId}/`))) {
      throw new RuntimeError(`[Errno 17] File exists: '${taskId}'`); // (PEAR: FileExistsError)
    }
    this.folders.add(taskId);
  }

  /** shutil.rmtree(files.directory): the folder and every file in it. */
  removeTask(taskId: string): void {
    this.folders.delete(taskId);
    for (const files of [this.json, this.lines]) {
      for (const name of [...files.keys()]) {
        if (name.startsWith(`${taskId}/`)) {
          files.delete(name);
        }
      }
    }
  }

  /** Whether the folder of the task ``taskId`` was made and is still there. */
  hasTask(taskId: unknown): boolean {
    return typeof taskId === "string" && this.folders.has(taskId);
  }
}

/** The preview as the commands and the watchdog use it, beside what the core rig's records. */
interface PreviewPart {
  isEncoding: boolean;
  errorText: string | null;
}

/** The recordings as the commands and the watchdog use them, beside what the core rig's records. */
interface RecordingsPart {
  isEnabled: boolean;
  activeSegment: { snapshot(): Record<string, unknown> } | null;
}

// ---- the stage ----

/** One scenario's rig (the script's Stage): the core rig's, with the port's Commands and Watchdog on it. */
export class CommandsStage extends ConsoleStage {
  readonly commands: Commands<ModelState, SingleArmDelta>;
  readonly watchdog: Watchdog<ModelState, SingleArmDelta>;

  private readonly uploads: StandIn;
  private readonly previewPart: PreviewPart;
  private readonly recordingsPart: RecordingsPart;
  private readonly reader: object;
  private readonly segmentStatus: Record<string, unknown>;
  /** camera_feed.reader: a marker, or null while the cameras' reader is closed. */
  private cameraReader: object | null;
  /** The scenario's `robot_becomes`: the status the robot returns once the call of `after` is recorded. */
  private becomes: { after: string; robot: unknown } | null = null;
  /** Console.WORKER_JOIN_S as it was before a scenario wrote it. */
  private readonly workerJoinS = Console.WORKER_JOIN_S;

  constructor(meta: CommandsMeta, scenario: CommandsScenario) {
    super(meta, scenario);
    const console = this.console;
    const parts = console as unknown as Record<string, unknown>;
    const constants = meta.constants;
    this.segmentStatus = constants["segment_status"] ?? {};
    this.reader = this.cameraReader = meta.camera_reader;

    // ---- STAND-IN CALLS: the port's call, and PEAR's as it is recorded ----
    const robot = this.robot;
    const robotPart = console.robot as unknown as Record<string, Method>;
    Object.assign(robotPart, {
      open: () => robot.awaited("open"),
      waitStationary: () => robot.awaited("wait_stationary"),
      // PEAR: wait_settled(Console.SETTLE_TIMEOUT_S)
      waitSettled: (timeoutS: number) => robot.awaited("wait_settled", [timeoutS]),
      // PEAR: recover(cancellation=...) and home(cancellation=..., report_progress=..., approve_plan=..., ...)
      recover: (options: object) => robot.awaited("recover", [], pearKeywords(options)),
      home: (options: object) => robot.awaited("home", [], pearKeywords(options)),
    });
    for (const [name, pearName] of Object.entries(ROBOT_METHODS)) {
      const call = robotPart[name]!;
      robotPart[name] = (...given: unknown[]) => {
        const returned = call(...given);
        this.became(pearName);

        return returned;
      };
    }

    const feed = new StandIn(this, "camera_feed").anything() as Record<string, unknown>;
    // camera_feed.reader is an attribute; read() and anything else is a recorded call
    const cameraFeed = new Proxy(
      {},
      { get: (_target, name) => (name === "reader" ? this.cameraReader : feed[name as string]) },
    );
    parts["cameraFeed"] = cameraFeed;

    const preview = new StandIn(this, "preview");
    this.previewPart = console.preview as unknown as PreviewPart;
    Object.assign(this.previewPart, {
      isEncoding: true,
      errorText: null,
      // PEAR: reconnect(cancellation)
      reconnect: (cancellation: unknown) => preview.awaited("reconnect", [pearValue(cancellation)]).then(() => undefined),
    });

    const recordings = new StandIn(this, "recordings");
    this.recordingsPart = console.recordings as unknown as RecordingsPart;
    Object.assign(this.recordingsPart, {
      isEnabled: true,
      activeSegment: null,
      // PEAR: start(task, camera_feed, robot_status_reader)
      start: (task: unknown, givenFeed: unknown, robotStatusReader: unknown) => {
        const feedGiven = givenFeed === cameraFeed ? { object: "StandIn" } : { object: "not the console's camera feed" };
        recordings.call("start", [task, feedGiven, pearValue(robotStatusReader)]);
      },
    });

    const uploads = (this.uploads = new StandIn(this, "uploads"));
    uploads.returns["attach"] = [];
    parts["uploads"] = {
      // PEAR: attach(upload_ids, owner, files) and delete(upload_id, owner)
      attach: (uploadIds: unknown, owner: unknown, taskId: unknown) =>
        uploads.call("attach", [uploadIds, owner, this.taskFiles(taskId)]),
      delete: (uploadId: unknown, owner: unknown) => {
        uploads.call("delete", [uploadId, owner]);
      },
    };

    const annotations = new StandIn(this, "annotations");
    parts["annotations"] = {
      cleanTags, // (PEAR: the classmethod, called on the class: no call of the stand-in)
      // PEAR: update(files, tags=tags)
      update: (taskId: unknown, options: object) => annotations.call("update", [this.taskFiles(taskId)], pearKeywords(options)),
    };

    const taskRun = new StandIn(this, "task_run");
    // PEAR: run(cancellation)
    Object.assign(this.taskRun, { run: (cancellation: unknown) => taskRun.awaited("run", [pearValue(cancellation)]) });

    // the worker's body is the worker thread's, whoever launches it
    const launch = console.launch.bind(console);
    console.launch = (operation, options) => this.threads.run("worker", () => launch(operation, options));

    // what commands.py reads of the robot's class, as the record's robot class has it
    const robotClass = (constants["robot"] ?? {}) as {
      action_formats: number;
      HOME_ARM_CHOICES: string[];
      HOME_CAN_KEEP_GRIPPERS: boolean;
    };
    const uuids = scenario.uuids;
    this.commands = new Commands<ModelState, SingleArmDelta>(console as unknown as CommandsConsole<ModelState, SingleArmDelta>, {
      robotClass: {
        ACTION_FORMATS: Object.fromEntries(Array.from({ length: robotClass.action_formats }, (_, index) => [`format_${index}`, {}])),
        HOME_ARM_CHOICES: robotClass.HOME_ARM_CHOICES,
        HOME_CAN_KEEP_GRIPPERS: robotClass.HOME_CAN_KEEP_GRIPPERS,
      },
      wallClock: this.clock.time,
      timeNs: this.clock.timeNs,
      uuid: () => {
        if (this.drawn >= uuids.length) {
          throw new Error(`the port drew a UUID more than the scenario's ${uuids.length}`);
        }

        return uuids[this.drawn++]!;
      },
      log: (...line: unknown[]) => {
        this.logged.push(line);
      },
    });
    parts["commands"] = this.commands;

    const watchdog = Object.create(Watchdog.prototype) as Watchdog<ModelState, SingleArmDelta>;
    Object.defineProperty(watchdog, "console", { value: console, enumerable: true });
    this.watchdog = watchdog;
  }

  protected override newRecords(): CoreRecords {
    return new CommandsRecords();
  }

  /** The console's wait on a time limit (Thread.join(timeout) of a live worker): recorded, and over once
   * everything that can run without the script has run, one turn of the event loop. A worker that ends because of
   * the stop has ended by then, as PEAR's ends within its 15 s; one the script holds has not. */
  protected override wait(seconds: number): Promise<void> {
    this.sleeps.push(seconds);

    return new Promise((resolve) => setImmediate(resolve));
  }

  /** Puts back what a scenario wrote outside its own console (Console.WORKER_JOIN_S). */
  dispose(): void {
    (Console as unknown as { WORKER_JOIN_S: number }).WORKER_JOIN_S = this.workerJoinS;
  }

  /** What the record keeps of PEAR's TaskFiles of a task: so only for the id of a task whose folder is there. */
  private taskFiles(taskId: unknown): Record<string, unknown> {
    return (this.records as CommandsRecords).hasTask(taskId)
      ? { object: "TaskFiles" }
      : { object: `no folder of a task: ${String(taskId)}` };
  }

  /** After a call of the robot's ``method`` that was recorded and did not raise: the scenario's `robot_becomes`. */
  private became(method: string): void {
    const becomes = this.becomes;
    const calls = this.calls[this.thread()];
    const last = calls[calls.length - 1];
    if (
      becomes !== null &&
      becomes.after === method &&
      last !== undefined &&
      last.of === "robot" &&
      last.call === method &&
      last.raised === undefined
    ) {
      this.robot.returns["status"] = structuredClone(becomes.robot);
    }
  }

  // ---- the operations and the threads of this script ----

  /** Waits for ``promise``, for the script's time limit at most; returns whether it settled in time. */
  private async inTime(promise: Promise<unknown>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), WAIT_MS);
    });
    try {
      return await Promise.race([promise.then(() => true), limit]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Launches an operation that waits for its cancellation and then ends as PEAR's operations do; returns once it
   * has begun. The step that stops it records it in `operations`. */
  private async launchUntilStopped(): Promise<null> {
    const console = this.console;
    let begin: () => void = () => undefined;
    const began = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const operation: Operation = async (cancellation) => {
      const entry: Record<string, unknown> = {
        cancellation_is_the_consoles: cancellation === console.cancellation.signal,
        cancellation_was_set: cancellation.aborted,
      };
      begin();
      try {
        const stopped = new Promise<void>((resolve) => {
          if (cancellation.aborted) {
            resolve();
          } else {
            cancellation.addEventListener("abort", () => resolve(), { once: true });
          }
        });
        if (!(await this.inTime(stopped))) {
          throw new Error("the operation was never stopped");
        }
        OperatorPaused.checkCancelled(cancellation);
      } catch (error) {
        entry["raised"] = { type: pythonErrorName(error), message: pythonErrorMessage(error) };
        throw error;
      } finally {
        this.operations.push(entry);
      }
    };
    console.launch(operation);
    if (!(await this.inTime(began))) {
      throw new Error("the operation did not begin");
    }

    return null;
  }

  /** The step `periodic`: a Watchdog as its constructor makes it, or a PeriodicThread, around a scripted check on
   * the machine's clock; what the record holds of it but `is_daemon`, which a page's loop has not. */
  private async periodic(spec: StepScript): Promise<Record<string, unknown>> {
    const raisesAt = spec["raises_at"] as number[];
    const log = (...line: unknown[]): void => {
      this.logged.push(line);
    };
    let checks = 0;
    let thread: PeriodicThread | null = null;
    const check = (): void => {
      checks += 1;
      if (checks === spec["closes_at"]) {
        thread!.exitEvent.abort();
      }
      if (raisesAt.includes(checks)) {
        throw new RuntimeError(`check ${checks} failed`);
      }
    };

    let closing: { close(): Promise<void> };
    if (spec["as"] === "watchdog") {
      const constants = Watchdog as unknown as { PERIOD_S: number };
      const periodS = constants.PERIOD_S;
      constants.PERIOD_S = PERIOD_S;
      try {
        const watchdog = new Watchdog(this.console as unknown as WatchdogConsole<ModelState, SingleArmDelta>, { log });
        // in the place of the watchdog's check, before its first step
        Object.defineProperty(watchdog, "check", { value: check });
        closing = watchdog;
        thread = watchdog.periodicThread;
      } finally {
        constants.PERIOD_S = periodS;
      }
    } else {
      closing = thread = new PeriodicThread(check, PERIOD_S, "scripted", {
        isWaitingFirst: spec["is_waiting_first"] as boolean,
        isEndedByFailure: spec["is_ended_by_failure"] as boolean,
        log,
      });
    }
    await this.inTime(thread.thread.ended);
    const returned = {
      checks,
      thread_is_alive: thread.thread.isAlive,
      thread_name: thread.thread.name,
      exit_event_is_set: thread.exitEvent.signal.aborted,
      is_waiting_first: thread.isWaitingFirst,
      is_paced_from_start: thread.isPacedFromStart,
      is_ended_by_failure: thread.isEndedByFailure,
    };
    await closing.close();

    return { ...returned, exit_event_is_set_after_close: thread.exitEvent.signal.aborted };
  }

  // ---- a step ----

  /** What this script's `set` writes beside the core rig's keys, in the script's order. */
  private setMore(spec: StepScript): void {
    const console = this.console;
    for (const key of SET_KEYS) {
      if (!Object.hasOwn(spec, key)) {
        continue;
      }
      const value: unknown = structuredClone(spec[key]);
      if (key === "cameras") {
        const cameras = value as { is_encoding: boolean; error_text: string | null };
        this.previewPart.isEncoding = cameras.is_encoding;
        this.previewPart.errorText = cameras.error_text;
      } else if (key === "camera_reader") {
        this.cameraReader = value === true ? this.reader : null;
      } else if (key === "session") {
        const session = value as { turn_count: number; blocked_reason: string | null } | null;
        const given = session === null ? null : { turnCount: session.turn_count, blockedReason: session.blocked_reason };
        (this.taskRun as { session: unknown }).session = given;
      } else if (key === "recording_segment") {
        const segment = value as { status: string; error: unknown } | null;
        this.recordingsPart.activeSegment =
          segment === null ? null : { snapshot: () => ({ status: this.segmentStatus[segment.status], error: segment.error }) };
      } else if (key === "worker_join_s") {
        (Console as unknown as { WORKER_JOIN_S: number }).WORKER_JOIN_S = value as number;
      } else if (key === "robot_becomes") {
        this.becomes = value as CommandsStage["becomes"];
      } else if (key === "attached_images") {
        this.uploads.returns["attach"] = value;
      } else {
        console.supportsReferenceImages = () => value as boolean;
      }
    }
  }

  protected override async callOf(spec: StepScript): Promise<(() => unknown) | null> {
    switch (spec.op) {
      case "command":
        return () => this.commands.run(spec["name"] as string, expand(structuredClone(spec["data"])) as CommandData | null);
      case "watchdog_check":
        return () => (this.watchdog as unknown as { check(): Promise<void> }).check();
      case "launch_until_stopped":
        return () => this.launchUntilStopped();
      case "periodic":
        return () => this.periodic(spec);
      case "set":
        this.setMore(spec);

        return super.callOf(Object.fromEntries(Object.entries(spec).filter(([key]) => !SET_KEYS.includes(key))) as StepScript);
      default:
        return super.callOf(spec);
    }
  }

  /** The console's fields as a record holds them, with the task run's, the model and whether tasks are recorded. */
  override fields(): Record<string, unknown> {
    const fields = super.fields();
    const values = this.taskRun as unknown as Record<string, unknown>;
    const taskRun: Record<string, unknown> = {};
    for (const [key, own] of TASK_RUN_FIELDS) {
      if (Object.hasOwn(values, own)) {
        taskRun[key] = values[own];
      }
    }
    taskRun["has_session"] = values["session"] !== null && values["session"] !== undefined;
    fields["task_run"] = plain(taskRun);
    fields["model"] = this.console.model;
    fields["recording_is_enabled"] = this.recordingsPart.isEnabled;

    return fields;
  }
}
