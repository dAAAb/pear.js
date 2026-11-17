// PEAR's operator console on the page's station: what a Worker's host needs to run a task of a model on the robot
// it holds. The library has the console whole (src/console: Console, Commands, Watchdog, TaskRun) and the agent
// (src/agent: StationAgentLoop, VLLMClient); a page has no task folders, no uploaded images, no tags, no
// recordings and no camera reader of PEAR's kind. TaskHost makes a Console for a robot that is already open, with
// those parts as a page has them:
//
// - the records are kept in memory (TaskMemory), bounded, as plain data a page can show later;
// - the uploads, the tags and the recordings do what PEAR's do when nothing was uploaded, no tag was given and
//   recording is off, and refuse anything else;
// - the preview tells the page's camera: PEAR's console starts and resumes a task only while the cameras give
//   fresh frames, and its watchdog pauses a running task when they stop;
// - the one offered model is the page's model service, through the library's VLLMClient.
//
// A task may be started with the operator's two limits, which are not PEAR's (TaskHostLimits): a count of turns after
// which the task is paused between two turns, and a largest size of one action, above which the action is not
// given to the robot and is answered as PEAR answers an action the arm cannot reach.
//
// The host of the Worker calls run, snapshot, takeEvents and close, and never the console itself. Enable, Disable
// and Home stay the page's own at this stage: the console's commands for them are refused here.
//
// The key of the model service is given to the client alone, as a function, so that no record of the
// configuration holds it; whatever leaves this module (an event, a snapshot, a record, an error's text, the log)
// is copied as plain data with the key's text replaced, should a server have written it into an answer.

import type { EventData } from "../../src/agent/clients/schemas";
import { VLLMClient } from "../../src/agent/clients/vllm";
import type { Clock, Sleep } from "../../src/agent/clock";
import { ModelsConfig, OfferedModel, type ModelClientClass } from "../../src/agent/config";
import type { AgentRobot } from "../../src/agent/robot";
import {
  Commands,
  type AttachedImage,
  type CommandAnswer,
  type CommandData,
  type CommandsAnnotations,
  type CommandsConsole,
  type CommandsPreview,
  type CommandsRecordings,
  type CommandsRecords,
  type CommandsUploads,
} from "../../src/console/commands";
import { Console, type ConsoleEventRecord } from "../../src/console/console";
import { idleFor } from "../../src/console/phase";
import { TaskEventKind } from "../../src/console/task_events";
import type { ActiveTurn, TaskRecord } from "../../src/console/task_run";
import { Watchdog, type WatchdogConsole, type WatchdogRecordings } from "../../src/console/watchdog";
import { MotionStatus, type ModelState, type MotionResult, type SingleArmDelta } from "../../src/protocol/types";
import { UnreachablePoseError } from "../../src/so101/kinematics/errors";
import { isValueError, PythonError, pythonErrorMessage, pythonErrorName, RuntimeError, ValueError } from "../../src/python/errors";
import type { SO101Robot } from "../../src/so101/robot";
import { CameraSource, type CameraFeed } from "../../src/station/cameras";
import type { RobotLog } from "../../src/station/robot";

/** The model service of a page: what its model step holds. */
export interface TaskModelService {
  /** The service's address up to its API version: it ends in "/v1". */
  readonly baseUrl: string;
  /** The name the service serves the model under. */
  readonly model: string;
  /** The service's key; null or empty for a service that asks for none. */
  readonly apiKey: string | null;
}

/** What a page tells of its camera: whether it runs and how old its last frame is, ms (null before the first).
 * The numbers of the station's frame reader (WindowFrames.numbers()) are such a telling. */
export interface TaskCamera {
  readonly isRunning: boolean;
  readonly ageMs: number | null;
}

/** The operator's limits of one task; neither is PEAR's. */
export interface TaskHostLimits {
  /** The task is paused between two turns once this many turns have ended since it was started or last resumed;
   * 0: never. */
  readonly turns: number;
  /** The largest change one action may ask for: `cm` along x, y or z, `rad` of pitch or roll, either way. An
   * action that asks for more is not given to the robot. null: an action is executed as large as it is asked. */
  readonly action: { readonly cm: number; readonly rad: number } | null;
}

/** What a task host is made with. */
export interface TaskHostOptions<Image = unknown> {
  /** The station's robot, open: the host never opens or closes it. */
  robot: SO101Robot<Image>;
  /** The same robot as the turn loop takes it (AgentRobotAdapter of src/station/robot.ts). */
  agentRobot: AgentRobot<ModelState, SingleArmDelta>;
  /** The camera feed the robot was made with. */
  cameraFeed: CameraFeed<Image>;
  /** Tells the page's camera at this moment. */
  camera: () => TaskCamera;
  service: TaskModelService;
  /** The monotonic clock, s, of the console, the watchdog, the turn loop and the client; the machine's by default. */
  clock?: Clock;
  /** The waits of the console, the watchdog and the turn loop; the machine's timers by default. */
  sleep?: Sleep;
  /** The wall clock, s since the epoch; the machine's by default. */
  wallClock?: () => number;
  /** The wall clock, ns since the epoch; the machine's by default. */
  timeNs?: () => bigint;
  /** What gives a UUID to a task, a turn, a session and a frame; a random one by default. */
  uuid?: () => string;
  /** What makes the client's requests; the runtime's fetch by default. */
  fetch?: typeof fetch;
  /** Where the console's log goes; nowhere by default. */
  log?: RobotLog;
}

/** One event of the console as a page receives it: plain data. */
export interface TaskEvent {
  /** The events are numbered from 1; a gap tells that events were dropped before they were taken. */
  readonly id: number;
  readonly type: string;
  readonly data: EventData;
  /** Wall time, s. */
  readonly time: number;
  /** The station's clock, s. */
  readonly monotonic_s: number;
  /** Of the task at that moment; null without one. */
  readonly task_id: string | null;
}

/** What a page shows of the console; the robot, the cameras and the model's health are in the station's status. */
export interface TaskSnapshot {
  /** The word of a Phase (src/console/phase.ts). */
  readonly phase: string;
  /** Whether an operation of the console runs: a task's turns, or the clearing of a task. */
  readonly isBusy: boolean;
  /** Whether STOP MOTION holds every motion until it is reset. */
  readonly isStopLatched: boolean;
  /** The failure the page shows; null without one. */
  readonly error: string | null;
  /** The task's record; null without a task. */
  readonly task: TaskRecord | null;
  /** The running or the last turn of the task; null before the first. */
  readonly activeTurn: ActiveTurn | null;
  /** The actions of the task that completed. */
  readonly totalSteps: number;
  /** The inference report of the latest turn; null without one. */
  readonly performance: EventData | null;
  /** The id of the console's latest event. */
  readonly sequence: number;
}

/** What is kept of one task: its records by name and its events, oldest first. */
export interface KeptTask {
  readonly id: string;
  readonly records: Record<string, EventData>;
  readonly events: TaskEvent[];
}

/** Returns PEAR's error for a file that is not there (FileNotFoundError of an open). */
function missingFile(path: string): PythonError {
  return new PythonError("FileNotFoundError", `[Errno 2] No such file or directory: '${path}'`, false);
}

/**
 * The records of the tasks, in memory: what PEAR keeps in a task's folder (task.json, session.json, each turn's
 * observation, output and result, the events) and beside the folders (a fault's diagnostic).
 *
 * Bounded: the last TASKS tasks; of a task its last RECORDS records and its last EVENTS events, the oldest dropped
 * first (never the task's own record or its session's); the last ROOT_RECORDS records beside the tasks. Every
 * value is a plain copy made through `copy`, which the host gives to keep the key out.
 */
export class TaskMemory implements CommandsRecords {
  /** The tasks kept. */
  static readonly TASKS = 3;
  /** The records kept of one task: three a turn. */
  static readonly RECORDS = 600;
  /** The saved events kept of one task. */
  static readonly EVENTS = 2000;
  /** The records kept beside the tasks. */
  static readonly ROOT_RECORDS = 20;
  /** The records of a task that are never dropped. */
  static readonly LASTING: readonly string[] = ["task.json", "session.json"];

  private readonly tasks = new Map<string, { records: Map<string, EventData>; events: TaskEvent[] }>();
  private readonly root = new Map<string, EventData>();

  constructor(private readonly copy: <Value>(value: Value) => Value = (value) => structuredClone(value)) {}

  /** Makes the place of a new task's records; a task that has one already is PEAR's FileExistsError. */
  createTask(taskId: string): void {
    if (this.tasks.has(taskId)) {
      throw new PythonError("FileExistsError", `[Errno 17] File exists: '${taskId}'`, false);
    }
    this.tasks.set(taskId, { records: new Map(), events: [] });
    while (this.tasks.size > TaskMemory.TASKS) {
      this.tasks.delete(this.tasks.keys().next().value as string);
    }
  }

  removeTask(taskId: string): void {
    this.tasks.delete(taskId);
  }

  writeJson(taskId: string, name: string, value: EventData): void {
    const records = this.kept(taskId, name).records;
    records.delete(name); // a record written again is the newest
    records.set(name, this.copy(value));
    for (const old of records.keys()) {
      if (records.size <= TaskMemory.RECORDS) break;
      if (!TaskMemory.LASTING.includes(old)) records.delete(old);
    }
  }

  /** There are no files: a page gives no image with a task, so nothing is ever read. */
  readFile(taskId: string, name: string): Uint8Array {
    throw missingFile(`${taskId}/${name}`);
  }

  writeRootJson(name: string, value: EventData): void {
    this.root.set(name, this.copy(value));
    while (this.root.size > TaskMemory.ROOT_RECORDS) {
      this.root.delete(this.root.keys().next().value as string);
    }
  }

  appendEvent(taskId: string, event: ConsoleEventRecord): void {
    const events = this.kept(taskId, "events.jsonl").events;
    events.push(this.copy({ ...event }));
    if (events.length > TaskMemory.EVENTS) events.splice(0, events.length - TaskMemory.EVENTS);
  }

  /** Returns what is kept of every task, the oldest task first, as plain data. */
  keptTasks(): KeptTask[] {
    return [...this.tasks].map(([id, { records, events }]) => ({
      id,
      records: Object.fromEntries([...records].map(([name, value]) => [name, this.copy(value)])),
      events: events.map((event) => this.copy(event)),
    }));
  }

  /** Returns the records kept beside the tasks, by name. */
  keptRootRecords(): Record<string, EventData> {
    return Object.fromEntries([...this.root].map(([name, value]) => [name, this.copy(value)]));
  }

  private kept(taskId: string, name: string): { records: Map<string, EventData>; events: TaskEvent[] } {
    const task = this.tasks.get(taskId);
    if (task === undefined) {
      throw missingFile(`${taskId}/${name}`); // (PEAR: the task's folder is gone)
    }

    return task;
  }
}

/** PEAR's console on a robot the page's station holds: its commands for a task, what a page shows of it, its
 * events. */
export class TaskHost<Image = unknown> {
  /** The commands of PEAR's console that a page gives at this stage. */
  static readonly COMMANDS: readonly string[] = ["start", "pause", "resume", "clear", "stop", "reset_stop"];
  /** The commands of PEAR's console that stay the page's own at this stage, or that a page has nothing for. */
  static readonly REFUSED: readonly string[] = [
    "enable",
    "disable",
    "home",
    "home_confirm",
    "recover_control",
    "model",
    "recording",
    "reconnect_cameras",
  ];
  /** What the console calls its one model. */
  static readonly MODEL = "page";
  /** How old a frame may be for PEAR, s: the limit of every camera source (CameraSource.MAX_AGE_S), which the
   * robot's own observation refuses a frame by. */
  static readonly FRAME_MAX_AGE_S = CameraSource.MAX_AGE_S;
  /** The most events one takeEvents returns: what the console keeps (Console.EVENT_CAPACITY). */
  static readonly EVENTS_TAKEN = Console.EVENT_CAPACITY;
  /** What replaces the key's text wherever a copy leaves this module. */
  static readonly KEY_MARK = "[key]";
  /** The reason of the stop that close gives a running task: PEAR's, of its console's close. */
  static readonly CLOSE_REASON = "GUI shutdown";
  /** The reason of the pause at the limit of turns, as the event "stopping" tells it. */
  static readonly LIMIT_REASON = "Paused at the operator's limit of turns";
  /** A task without limits: PEAR's way. */
  static readonly NO_LIMITS: TaskHostLimits = { turns: 0, action: null };
  /** The quantities of an action's arm part that the limit of an action's size measures, with their units. */
  private static readonly MEASURED: readonly (readonly [string, "cm" | "rad"])[] = [
    ["x", "cm"],
    ["y", "cm"],
    ["z", "cm"],
    ["pitch", "rad"],
    ["roll", "rad"],
  ];

  /** The records kept of the tasks. */
  readonly records: TaskMemory;
  private readonly console: Console<ModelState, SingleArmDelta, Image>;
  private readonly commands: Commands<ModelState, SingleArmDelta, Image>;
  private readonly watchdog: Watchdog<ModelState, SingleArmDelta, Image>;
  private readonly camera: () => TaskCamera;
  private readonly key: string;
  private lastTakenId = 0;
  private isClosed = false;
  private readonly log: RobotLog;
  /** The limits of the task that is there. */
  private limits: TaskHostLimits = TaskHost.NO_LIMITS;
  /** The limits a "start" that is under way was given; null while none is. */
  private startLimits: TaskHostLimits | null = null;
  /** The task `limits` are of. */
  private limitedTaskId: string | null = null;
  /** Whether the task's turns run: from an accepted "start" or "resume" until a stop is asked or the run ends. */
  private isLoopRunning = false;
  /** The turns that have ended since the task's turns last began to run. */
  private turnsEnded = 0;
  private cause: "limit" | "hidden" | null = null;
  /** Whether the last action of the loop was over the limit of its size, and so not given to the robot. */
  private isLastActionLimited = false;

  constructor(options: TaskHostOptions<Image>) {
    const { robot, service } = options;
    this.camera = options.camera;
    this.key = service.apiKey ?? "";
    const key = this.key;
    // PEAR reads the constants of the robot's class and its profile through the robot object
    const robotClass = robot.constructor as typeof SO101Robot;
    const log: RobotLog = (logger, level, message, error) =>
      options.log?.(logger, level, this.withoutKey(message), error === undefined ? undefined : this.safeError(error));
    this.log = log;
    const timing = {
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    };
    const stamps = {
      ...(options.wallClock !== undefined ? { wallClock: options.wallClock } : {}),
      ...(options.timeNs !== undefined ? { timeNs: options.timeNs } : {}),
      ...(options.uuid !== undefined ? { uuid: options.uuid } : {}),
    };

    this.records = new TaskMemory((value) => this.plain(value));
    const made: { commands?: Commands<ModelState, SingleArmDelta, Image>; watchdog?: Watchdog<ModelState, SingleArmDelta, Image> } = {};
    this.console = new Console<ModelState, SingleArmDelta, Image>({
      modelsConfig: new ModelsConfig<ModelState, SingleArmDelta>({
        robotTitle: robotClass.TITLE,
        actionFormats: robotClass.ACTION_FORMATS,
        defaultModel: TaskHost.MODEL,
        models: {
          [TaskHost.MODEL]: new OfferedModel({
            label: service.model,
            clientClass: VLLMClient as unknown as ModelClientClass,
            clientClassName: "VLLMClient",
            client: {
              baseUrl: service.baseUrl,
              model: service.model,
              // a function: the configuration's record holds no key, only the client's requests do
              ...(key !== "" ? { apiKey: () => key } : {}),
              ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
              ...(options.clock !== undefined ? { clock: options.clock } : {}),
            },
          }),
        },
      }),
      robot,
      agentRobot: this.limited(options.agentRobot),
      cameraFeed: options.cameraFeed,
      robotProfile: () => robotClass.profile(),
      records: this.records,
      uploads: this.uploads(),
      recordings: this.recordings(),
      annotations: this.annotations(),
      preview: this.preview(),
      // the console's parts are typed by console.ts, which knows only what console.py uses of them: one cast each
      commands: (console) =>
        (made.commands = new Commands(console as CommandsConsole<ModelState, SingleArmDelta, Image>, {
          robotClass,
          ...stamps,
          log,
        })),
      watchdog: (console) =>
        (made.watchdog = new Watchdog(console as WatchdogConsole<ModelState, SingleArmDelta, Image>, { ...timing, log })),
      ...timing,
      ...stamps,
      log,
      loop: { ...timing, ...(options.uuid !== undefined ? { uuid: options.uuid } : {}) },
    });
    this.commands = made.commands as Commands<ModelState, SingleArmDelta, Image>;
    this.watchdog = made.watchdog as Watchdog<ModelState, SingleArmDelta, Image>;
    // PEAR's console shows the motors' phase after its own enable; here the page has enabled the robot already
    this.console.setPhase(idleFor(this.console.robotStatus(), { isLatched: false, hasTask: false }));
  }

  /** Whether an operation of the console runs; the host refuses the page's own motions meanwhile. */
  get isBusy(): boolean {
    return this.console.isBusy;
  }

  /**
   * Runs one command of PEAR's console: start (data: { instruction }), pause, resume, clear, stop, reset_stop.
   * It answers as PEAR's does ({ accepted: true }, a stop's report, { reset: true }) and throws PEAR's error, in
   * PEAR's words, for a command the console refuses. The commands that stay the page's own are refused here.
   * `limits` are the operator's for the task a "start" makes (none: PEAR's way); they hold for that task's whole
   * life, and a "start" that PEAR refuses changes no task's limits.
   */
  async run(name: string, data?: CommandData | null, limits?: TaskHostLimits): Promise<CommandAnswer> {
    if (this.isClosed) {
      throw new RuntimeError("The task host is closed");
    }
    if (name === "start" && this.startLimits !== null) {
      // one "start" at a time: the task that is made takes the limits of the "start" that made it
      throw new ValueError("Wait for the current operation or pause it first"); // (PEAR's words)
    }
    if (TaskHost.REFUSED.includes(name)) {
      throw new ValueError(`The command ${name} is not given to the console at this stage: the page has its own`);
    }
    if (!TaskHost.COMMANDS.includes(name)) {
      throw new ValueError("Unknown command"); // (PEAR's words)
    }
    if (name === "start") {
      this.startLimits = limits ?? TaskHost.NO_LIMITS;
    }
    try {
      const answer = this.plain(await this.commands.run(name, data));
      if (name === "clear") {
        this.cause = null;
      }

      return answer;
    } catch (error) {
      throw this.safeError(error);
    } finally {
      if (name === "start") {
        this.startLimits = null;
      }
    }
  }

  /** Why the host itself paused the task: "limit", the task's limit of turns was reached; "hidden", pauseFor
   * was called while the task's turns ran. null otherwise, and again once the next "start" or "resume" has its
   * turns running or a "clear" is accepted. */
  get pausedBy(): "limit" | "hidden" | null {
    return this.cause;
  }

  /** Pauses as the operator's "pause" does, for a page that is hidden: when the task's turns run, `pausedBy`
   * tells of it from now on. */
  async pauseFor(cause: "hidden"): Promise<CommandAnswer> {
    if (this.isLoopRunning && !this.console.cancellation.signal.aborted) {
      this.cause = cause;
    }

    return this.run("pause");
  }

  /** Returns what a page shows of the console at this moment, as plain data. */
  snapshot(): TaskSnapshot {
    const console = this.console;
    const taskRun = console.taskRun;

    return this.plain({
      phase: console.phase,
      isBusy: console.isBusy,
      isStopLatched: console.isStopLatched,
      error: console.error,
      task: taskRun.task,
      activeTurn: taskRun.activeTurn,
      totalSteps: taskRun.totalSteps,
      performance: console.performance,
      sequence: console.lastEventId,
    });
  }

  /**
   * Returns the console's events since the last call, the oldest first, as plain data. Bounded by what the
   * console keeps: at most EVENTS_TAKEN events; when more came between two calls the oldest are lost, and the
   * first id returned is then more than one above the last id of the call before.
   */
  takeEvents(): TaskEvent[] {
    const events = this.console.events.filter((event) => event.id > this.lastTakenId);
    this.lastTakenId = this.console.lastEventId;

    return events.map((event) => this.plain({ ...event }));
  }

  /**
   * Ends the watchdog and the task's model session, and leaves the robot open as it is. A task that runs is
   * paused first, as the operator's pause does it: the model's request is cancelled, the arm is braked into a
   * hold, and the turn's end is awaited; a task that does not run costs no motion. The task's records stay in
   * `records`; no command is taken after it.
   */
  async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    const console = this.console;
    try {
      if (console.isBusy) {
        await console.stop({ reason: TaskHost.CLOSE_REASON });
        await console.worker?.join(Console.WORKER_JOIN_S);
      }
    } finally {
      try {
        await this.watchdog.close();
      } finally {
        await console.taskRun.closeSession();
      }
    }
  }

  // ---------------------------------------------------------------- the parts a page does not have

  /** PEAR's ImageUploads with nothing uploaded: no image is attached, and any id is the id of no draft. */
  private uploads(): CommandsUploads {
    return {
      attach: (uploadIds): AttachedImage[] => {
        if (Array.isArray(uploadIds) && uploadIds.length === 0) {
          return [];
        }
        throw new ValueError("Task images are not offered on this page"); // (the page's own words)
      },
      delete: () => undefined,
    };
  }

  /** PEAR's Annotations for a task without tags: the empty list passes; what is no list of text is refused in
   * PEAR's words, a tag in the page's own. */
  private annotations(): CommandsAnnotations {
    return {
      cleanTags: (rawTags): string[] => {
        if (!Array.isArray(rawTags)) {
          throw new ValueError("Tags must be a list of text");
        }
        for (const tag of rawTags) {
          if (typeof tag !== "string") {
            throw new ValueError("Tags must be text");
          }
          if (tag.trim() !== "") {
            throw new ValueError("Task tags are not offered on this page"); // (the page's own words)
          }
        }

        return [];
      },
      update: () => undefined,
    };
  }

  /** PEAR's recordings with recording off: nothing starts, nothing is recorded. */
  private recordings(): CommandsRecordings<Image> & WatchdogRecordings {
    return {
      isEnabled: false,
      activeSegment: null,
      start: (task) => this.onLoopStart((task as { id?: unknown } | null)?.id),
      stop: () => {
        this.isLoopRunning = false;
      },
      snapshot: () => null,
      onEvent: (kind, data) => this.onEvent(kind, data),
      close: () => undefined,
    };
  }

  /** The console starts the recording of a task right before it launches the task's turns, for a "start" and for
   * a "resume" alike: the turns that have ended are counted from here, and the task a "start" has just made
   * takes that start's limits. */
  private onLoopStart(taskId: unknown): void {
    const id = typeof taskId === "string" ? taskId : null;
    // (a task whose id cannot be read takes the limits too: a "start" never runs on an earlier task's limits)
    if (this.startLimits !== null && (id === null || id !== this.limitedTaskId)) {
      this.limits = this.startLimits;
      this.limitedTaskId = id;
    }
    this.turnsEnded = 0;
    this.cause = null;
    this.isLoopRunning = true;
  }

  /**
   * The limit of turns. The console calls this, without awaiting anything, for every event before it publishes
   * it; the task's run publishes a turn's result ("execution") and then, without awaiting anything either, looks
   * for a pause at the top of its loop, before the next turn starts. Console.stop aborts the run's cancellation
   * before it first awaits, so a stop asked here ends the run between the two turns: the turn has its result, no
   * turn after it starts, no request is made to the model, and the model's history gets no interrupted turn.
   *
   * A turn counts when its action completed or was rejected. A result that failed is the record of a fault, of
   * an interruption or of a motion that did not complete: the run ends by itself with it.
   */
  private onEvent(kind: string, data: EventData): void {
    const turns = this.limits.turns;
    if (kind !== TaskEventKind.EXECUTION || turns === 0) {
      return;
    }
    if (!this.isLoopRunning || this.console.cancellation.signal.aborted) {
      return; // a pause is under way already: this is the record of the turn it interrupted
    }
    const status = data["status"];
    if (status !== MotionStatus.COMPLETED && status !== MotionStatus.REJECTED) {
      return;
    }
    this.turnsEnded += 1;
    if (this.turnsEnded < turns) {
      return;
    }

    this.cause = "limit";
    this.console.stop({ reason: TaskHost.LIMIT_REASON }).catch((error: unknown) => {
      this.log("task", "warning", "The robot's stop failed at the pause of the limit of turns", error);
    });
  }

  /**
   * Returns `robot` as the turn loop takes it under the limit of an action's size: an action that is over the
   * task's limit is not given to the robot, so nothing is written for it, for the arm or for the gripper. Its
   * result is made as the robot makes its own for a pose the arm cannot reach: rejected, measured now, with
   * PEAR's code of an unreachable pose, so that the task's run asks the model for another action and pauses after
   * its own count of such answers in a row. The message tells the model what is true: whose limit it is, its
   * numbers and the parts of the action that are over it. Everything else is the robot's own, unchanged.
   */
  private limited(robot: AgentRobot<ModelState, SingleArmDelta>): AgentRobot<ModelState, SingleArmDelta> {
    const isLimited = (): boolean => this.isLastActionLimited;

    return {
      get actionMode(): string {
        return robot.actionMode;
      },
      get sessionId(): string | null {
        return robot.sessionId;
      },
      get controlPeriodS(): number {
        return robot.controlPeriodS;
      },
      get lastErrorDiagnostics(): EventData | null {
        // an action that was not given to the robot left no diagnostics there: the robot's are of an earlier one
        return isLimited() ? null : robot.lastErrorDiagnostics;
      },
      waitStationary: (observation, options) => robot.waitStationary(observation, options),
      observe: () => robot.observe(),
      modelState: (jointPositions, formatName) => robot.modelState(jointPositions, formatName),
      isHolding: (observation) => robot.isHolding(observation),
      stop: () => robot.stop(),
      failureResult: (error, options) => robot.failureResult(error, options),
      execute: async (action, options): Promise<MotionResult> => {
        const limit = this.limits.action;
        const over = limit === null ? [] : TaskHost.overLimit(action, limit);
        this.isLastActionLimited = over.length > 0;
        if (limit === null || over.length === 0) {
          return robot.execute(action, options);
        }
        const message =
          `The operator's limit for one action is ${TaskHost.number(limit.cm)} cm in x, y and z and ` +
          `${TaskHost.number(limit.rad)} rad in pitch and roll, either way. This action is over it: ${over.join(", ")}.`;
        this.log("task", "warning", `An action was not given to the robot. ${message}`);

        return robot.failureResult(new UnreachablePoseError(message), {
          formatName: this.console.actionFormat.name,
          status: MotionStatus.REJECTED,
        });
      },
    };
  }

  /** Returns the parts of `action` that are over `limit`, each as the model is told it; none within the limit.
   * A part that is no number cannot be measured and is over it. */
  private static overLimit(action: unknown, limit: { readonly cm: number; readonly rad: number }): string[] {
    const arm = (action as { arm?: unknown } | null)?.arm;
    if (typeof arm !== "object" || arm === null) {
      return ["it holds no change of the arm's pose that the limit can measure"];
    }
    const over: string[] = [];
    for (const [name, unit] of TaskHost.MEASURED) {
      const value = (arm as Record<string, unknown>)[name];
      const most = unit === "cm" ? limit.cm : limit.rad;
      if (typeof value !== "number" || Number.isNaN(value)) {
        over.push(`${name} is not a number`);
      } else if (Math.abs(value) > most) {
        over.push(`${name} ${TaskHost.number(value)} ${unit} is ${TaskHost.number(Math.abs(value) - most)} ${unit} over`);
      }
    }

    return over;
  }

  /** Returns `value` as a message tells it: at most three decimal places, none that is not needed. */
  private static number(value: number): string {
    return String(Number(value.toFixed(3)));
  }

  /**
   * PEAR's preview, as far as the console reads it. The reader of the page's frames is there as long as the
   * host is, so previews are "encoded" until close; the cameras' error is the wrist camera's own sentence for a
   * camera that does not run, has given no frame, or whose last frame is older than FRAME_MAX_AGE_S. With an
   * error, start and resume are refused, and the watchdog pauses a running task.
   */
  private preview(): CommandsPreview {
    const camera = (): string | null => this.cameraError();
    const isOpen = (): boolean => !this.isClosed;

    return {
      get isEncoding(): boolean {
        return isOpen();
      },
      get errorText(): string | null {
        return camera();
      },
      status: () => ({ is_encoding: isOpen(), error_text: camera() }),
      close: () => undefined,
      reconnect: () => {
        throw new ValueError("The camera is the page's: restart it there");
      },
    };
  }

  /** Returns why the page's camera gives no fresh frame, in the wrist camera's words; null while it gives one. */
  private cameraError(): string | null {
    const { isRunning, ageMs } = this.camera();
    if (!isRunning) {
      return "Camera reader stopped; reconnect the camera";
    }
    if (ageMs === null) {
      return "Waiting for camera frames";
    }

    return ageMs > TaskHost.FRAME_MAX_AGE_S * 1000 ? "Camera frame is stale" : null;
  }

  // ---------------------------------------------------------------- nothing leaves with the key

  /** Returns `text` with the key's text replaced. */
  private withoutKey(text: string): string {
    return this.key === "" ? text : text.split(this.key).join(TaskHost.KEY_MARK);
  }

  /** Returns `error`, or, when its text holds the key, an error of the same Python name without it. */
  private safeError(error: unknown): unknown {
    const message = pythonErrorMessage(error);
    if (this.key === "" || !`${message}${String(error)}`.includes(this.key)) {
      return error;
    }

    return new PythonError(pythonErrorName(error), this.withoutKey(message), isValueError(error));
  }

  /** Returns a copy of `value` as plain data that can be posted to a window: records, lists, numbers, booleans,
   * null and texts, each text without the key; what is none of these is left out. */
  private plain<Value>(value: Value): Value {
    return this.plainOf(value) as Value;
  }

  private plainOf(value: unknown): unknown {
    if (typeof value === "string") {
      return this.withoutKey(value);
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.plainOf(item) ?? null);
    }
    if (ArrayBuffer.isView(value)) {
      return Array.from(value as unknown as ArrayLike<number>);
    }
    if (typeof value === "object") {
      const record: Record<string, unknown> = {};
      for (const [name, item] of Object.entries(value)) {
        const copied = this.plainOf(item);
        if (copied !== undefined) {
          record[this.withoutKey(name)] = copied;
        }
      }

      return record;
    }

    return undefined;
  }
}
