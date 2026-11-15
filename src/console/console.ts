// Ports pear/deploy/station/gui/console/console.py: Console, the page's console of one robot.
//
// PEAR's Console makes everything it holds from the station's configuration and two folders. Here it is given
// them (ConsoleOptions): the models, the station's robot and the same robot as the turn loop takes it, the camera
// feed the robot was made with, the records, and the parts of PEAR's console that pear.js does not port, each as
// an interface with exactly what console.py uses of it (ImageUploads, RenderedRecordings, Annotations, Preview;
// Commands and Watchdog, which PEAR makes with the console itself, by a function of the console).
//
// The worker thread. PEAR runs one operation at a time on a thread. Here an operation is an async function that
// launch starts and does not await; a ConsoleWorker stands for the thread: whether the operation still runs
// (is_alive) and a wait for its end up to a time limit (join). The operation begins on a later microtask, after
// whatever its caller still does without awaiting: a thread that has been started, and has not run yet.
//
// The cancellation. PEAR's threading.Event is an AbortController the console holds; an operation is given its
// signal, and stop() aborts it. The Home review's `answered` is carried over the same way (home_review.ts).
//
// The lock. `with self.lock` is nothing: a page has one thread, and nothing is awaited where PEAR holds the lock
// (a comment stands at each place). No call that the port awaits is made under PEAR's lock in this file: the
// robot's stop, its close and the task run's close_session are outside it in PEAR too. What an await lets in is
// said where it is (stop, operate, close).
//
// The robot's status is read without awaiting, as the station's robot gives it, so snapshot, robotStatus,
// recordError and saveControlDiagnostic are synchronous as PEAR's are. stop, close and the worker's body are async.
//
// time.time(), time.monotonic(), time.time_ns() and uuid4() are options, by default the machine's; logger.exception
// goes to the option `log`, as the station's robot's lines do, under the logger "console". The constants are read
// from the class itself.

import type { ModelClient } from "../agent/clients/client";
import { HealthChecks } from "../agent/clients/health_checks";
import type { EventData, ModelHealth } from "../agent/clients/schemas";
import { monotonic, sleep as machineSleep, type Clock, type Sleep } from "../agent/clock";
import type { ModelsConfig, OfferedModel } from "../agent/config";
import type { ActionFormat, AgentRobot, Awaitable } from "../agent/robot";
import { systemPrompt } from "../protocol/system_prompt";
import type { ModelState, SingleArmDelta } from "../protocol/types";
import { isValueError, KeyError, OSError, pythonErrorMessage, pythonErrorName, RuntimeError, ValueError } from "../python/errors";
import { pythonStringRepr, pythonTruth } from "../python/repr";
import type { CameraFeed } from "../station/cameras";
import { OperatorPaused } from "../station/exceptions";
import { HomeFailed } from "../station/motion/homing";
import type { RobotLog } from "../station/robot";
import { RobotStatus, type BriefStatus, type DetailedStatus } from "../station/schemas";
import { HomeReview, HomeStatus, type ReviewPlan } from "./home_review";
import { ControlLease } from "./lease";
import { Phase } from "./phase";
import {
  TaskRun,
  type ActiveTurn,
  type ConsoleEvent,
  type TaskConsole,
  type TaskRecord,
  type TaskRecords,
  type TaskRobot,
  type TaskRunOptions,
} from "./task_run";

/** What Console calls of the station's robot (BaseRobot), beside what its task run calls (TaskRobot). The status
 * is read without awaiting, so that the console's snapshot stays one moment. PEAR's console also calls the robot's
 * profile(), a classmethod, on the object; the port's robot has it as a static method of its class, which an
 * object does not give, so the console is given it apart (ConsoleOptions.robotProfile). */
export interface ConsoleRobot extends TaskRobot {
  /** The identity of the robot's session; null while it has none. */
  readonly sessionId: string | null;
  /** Brakes any operation into a HOLD. */
  stop(): Awaitable<void>;
  /** Returns whether the robot is OFF, READY, BUSY or in FAULT; with ``withSnapshot``, the control snapshot too. */
  status(withSnapshot?: false): BriefStatus;
  status(withSnapshot: true): DetailedStatus | BriefStatus;
  /** Stops, and releases the arms and the planner. */
  close(): Awaitable<void>;
}

/** PEAR's ImageUploads, the images an operator gives with a task. console.py calls nothing of it: the console
 * holds it for the page's service. */
export type ConsoleUploads = object;

/** PEAR's Annotations, the one writer of the tasks' tags. console.py calls nothing of it: the console holds it for
 * the page's service. */
export type ConsoleAnnotations = object;

/** PEAR's Commands, the operator's commands. console.py calls nothing of it: the console makes and holds it. */
export type ConsoleCommands = object;

/** What console.py calls of PEAR's RenderedRecordings, the recordings of the tasks. */
export interface ConsoleRecordings {
  /** Ends the running recording for ``reason``; ``stoppedAt`` is when the stop was asked for, on the monotonic
   * clock (stop(reason, stopped_at=...)). */
  stop(reason: string, options?: { stoppedAt?: number }): unknown;
  /** Returns what the page shows of the recording. */
  snapshot(): unknown;
  /** Takes one event of the console, before the console numbers it: its kind and the data as it was emitted. */
  onEvent(kind: string, data: EventData): void;
  close(): Awaitable<void>;
}

/** What console.py calls of PEAR's Preview, the cameras as the page shows them. */
export interface ConsolePreview {
  /** Returns the cameras' state, as the page shows it. */
  status(): unknown;
  close(): Awaitable<void>;
}

/** What console.py calls of PEAR's Watchdog. */
export interface ConsoleWatchdog {
  close(): Awaitable<void>;
}

/** One event of the console, as it is published, kept and saved. */
export interface ConsoleEventRecord extends ConsoleEvent {
  /** The events are numbered from 1. */
  id: number;
  type: string;
  /** A copy of what was emitted; for an event of the running turn, the turn's fields first. */
  data: EventData;
  /** Wall time, s. */
  time: number;
  /** The clock of the recordings' timelines and the cameras' frames, s. */
  monotonic_s: number;
  /** Of the task at that moment; null without one. */
  task_id: string | null;
}

/** What Console uses of PEAR's TaskFiles and TaskEvents: the task run's records, the records beside the tasks'
 * folders and the tasks' event files. No path and no file system: PEAR's JSON text of a record or of an event's
 * line belongs to whoever stores it. */
export interface ConsoleRecords extends TaskRecords {
  /** Keeps ``value`` as the record ``name`` beside the tasks' folders (TaskFiles.write_json(root / name, value)).
   * It returns once the record is kept and throws when it cannot be. */
  writeRootJson(name: string, value: EventData): void;
  /** Adds ``event`` as the next event of the task ``taskId``
   * (TaskEvents(TaskFiles(root / taskId).events_path).append(event)). It throws when it cannot. */
  appendEvent(taskId: string, event: ConsoleEventRecord): void;
}

/** The state the page shows, its keys in PEAR's order. */
export interface ConsoleSnapshot {
  /** The word of a Phase. */
  phase: string;
  profile: Record<string, unknown>;
  model: string;
  models: { id: string; label: string; action_format: string | null }[];
  action_format: string;
  active_turn: ActiveTurn | null;
  robot: DetailedStatus | BriefStatus;
  model_health: ModelHealth;
  supports_reference_images: boolean;
  busy: boolean;
  stop_latched: boolean;
  error: string | null;
  task: TaskRecord | null;
  total_steps: number;
  sequence: number;
  owner: string | null;
  home_plan: ReviewPlan | null;
  home_status: Record<string, unknown> | null;
  performance: EventData | null;
  inference_started_at: number | null;
  recording: unknown;
  cameras: unknown;
}

/** What stop() returns. */
export interface StopReport {
  stop_requested: true;
  /** How long the robot's stop took, s. */
  stop_request_seconds: number;
}

/** One operation of the console: it is given the signal of the cancellation it runs under. */
export type Operation = (cancellation: AbortSignal) => Awaitable<void>;

/** What a console is made with. */
export interface ConsoleOptions<State = ModelState, Action = SingleArmDelta, Image = unknown> {
  /** The station's models (PEAR: ModelsConfig.from_station_config(config)). */
  modelsConfig: ModelsConfig<State, Action>;
  /** The station's robot (PEAR: made from the configuration's robot_class with the camera feed). */
  robot: ConsoleRobot;
  /** The same robot as the turn loop takes it: behind its AgentRobotAdapter. */
  agentRobot: AgentRobot<State, Action>;
  /** What the robot, the previews and the recordings read the cameras through: the feed the robot was made with. */
  cameraFeed: CameraFeed<Image>;
  /** Returns what the page lays the robot out with: the profile() of the robot's class. */
  robotProfile: () => Record<string, unknown>;
  /** The tasks' records (PEAR: the folder root). */
  records: ConsoleRecords;
  uploads: ConsoleUploads;
  recordings: ConsoleRecordings;
  annotations: ConsoleAnnotations;
  preview: ConsolePreview;
  /** Makes the console's commands; called once the console has its task run and its Home review, before it has
   * its preview and its watchdog (PEAR: Commands(self)). */
  commands: (console: Console<State, Action, Image>) => ConsoleCommands;
  /** Makes the console's watchdog; called last (PEAR: Watchdog(self)). */
  watchdog: (console: Console<State, Action, Image>) => ConsoleWatchdog;
  /** Returns a model's system prompt for a task (PEAR: SystemPrompt.render(instruction, action_format)); by
   * default the protocol's systemPrompt, which takes the instruction alone. */
  renderSystemPrompt?: (instruction: string, actionFormat: ActionFormat<State, Action>) => string;
  /** Returns the URL under which the page reads a file of a task; without it the task run uses PEAR's. Not
   * PEAR's: TaskConsole has it for a page that has no service. */
  recordUrl?: (taskId: string, name: string) => string;
  /** The wall clock, in seconds since the epoch (time.time()); by default the machine's. */
  wallClock?: () => number;
  /** The monotonic clock, s (time.monotonic()); by default the machine's. The lease and the health checks read
   * it too. */
  clock?: Clock;
  /** The wall clock in nanoseconds since the epoch (time.time_ns()); by default the machine's, which advances by
   * a millisecond. */
  timeNs?: () => bigint;
  /** What gives a UUID (uuid4()) to the task run and the Home review; by default a random one. */
  uuid?: () => string;
  /** The wait behind the time limit of a join of the worker; by default the machine's timers. */
  sleep?: Sleep;
  /** Where logger.exception goes; by default nowhere. */
  log?: RobotLog;
  /** What the task run's loop is made with (TaskRunOptions.loop). */
  loop?: TaskRunOptions["loop"];
}

/** Whether ``error`` is PEAR's OperatorPaused, of the station's module or under that name from another one (as
 * the loop and the task run tell it). */
function isOperatorPaused(error: unknown): boolean {
  return error instanceof OperatorPaused || pythonErrorName(error) === "OperatorPaused";
}

/** What stands for the thread of an operation (threading.Thread): whether its body still runs, and its end. */
export class ConsoleWorker {
  /** Whether the body still runs (Thread.is_alive()): from the launch until the body has ended. */
  isAlive = true;
  /** Resolves once the body has ended, however it ended. */
  readonly ended: Promise<void>;

  constructor(
    /** The thread's name. */
    readonly name: string,
    body: () => Promise<void>,
    private readonly sleep: Sleep,
    /** Takes what the body threw (PEAR: the thread's excepthook, which prints it). */
    onFailure: (error: unknown) => void,
  ) {
    this.ended = (async () => {
      // the thread is started and has not run yet: its starter goes on first
      await null;
      try {
        await body();
      } catch (error) {
        onFailure(error);
      } finally {
        this.isAlive = false;
      }
    })();
  }

  /** Waits for the body's end, for ``timeoutS`` at most (Thread.join(timeout)): it returns in either case, and
   * isAlive tells which. */
  async join(timeoutS: number): Promise<void> {
    if (!this.isAlive) {
      return;
    }
    const limit = new AbortController();
    try {
      await Promise.race([this.ended, this.sleep(timeoutS, limit.signal)]);
    } finally {
      limit.abort(); // drops the wait of the time limit
    }
  }
}

/** The page's console of one robot: the robot, its cameras, the recordings and the tasks' records, one operation
 * at a time on its worker, and a STOP that waits for nothing. */
export class Console<State = ModelState, Action = SingleArmDelta, Image = unknown>
  implements TaskConsole<State, Action>
{
  /** For a stopped operation to end, s. */
  static readonly WORKER_JOIN_S = 15.0;
  /** For a stopped or interrupted motion to settle, s. */
  static readonly SETTLE_TIMEOUT_S = 10.0;
  /** The task of a client made only to check its connection. */
  static readonly CHECK_INSTRUCTION = "Connection check";
  /** Recent events a reconnecting browser can catch up on. */
  static readonly EVENT_CAPACITY = 500;
  /** Of the thread that runs the operations, one at a time. */
  static readonly WORKER_THREAD_NAME = "gui-operation";
  /** Why the robot stopped when the operator paused it. */
  static readonly PAUSE_REASON = "Paused by operator";
  /** The event of a stop request. */
  static readonly STOPPING_EVENT = "stopping";
  /** The event of an operation's failure. */
  static readonly ERROR_EVENT = "error";

  /** For a stopped or interrupted motion to settle, s: the class's, as the task run reads it of its console. */
  readonly SETTLE_TIMEOUT_S = Console.SETTLE_TIMEOUT_S;

  /** The tasks' records (PEAR: root, the folder of the tasks' folders). */
  readonly records: ConsoleRecords;
  readonly modelsConfig: ModelsConfig<State, Action>;
  /** What the robot, the previews and the recordings read the cameras through. */
  readonly cameraFeed: CameraFeed<Image>;
  readonly robot: ConsoleRobot;
  /** The same robot as the turn loop takes it (not PEAR's: its console has one robot object). */
  readonly agentRobot: AgentRobot<State, Action>;
  readonly uploads: ConsoleUploads;
  readonly recordings: ConsoleRecordings;
  /** The one writer of the tasks' tags, which the page's service shares. */
  readonly annotations: ConsoleAnnotations;

  /** The recent events, the oldest first: at most EVENT_CAPACITY, the oldest dropped for a new one. */
  readonly events: ConsoleEventRecord[] = [];
  /** Of the latest event: the events are numbered from 1. */
  lastEventId = 0;
  readonly lease: ControlLease;
  /** The model of the next task. */
  model: string;
  readonly healthChecks: HealthChecks;

  /** The worker of the running or the last operation. */
  worker: ConsoleWorker | null = null;
  /** Aborted to cancel the running operation. */
  cancellation = new AbortController();
  private _phase: Phase = Phase.DISABLED;
  /** The failure the page shows; null without one. */
  error: string | null = null;
  /** Whether STOP MOTION holds every motion until it is reset. */
  isStopLatched = false;
  /** The inference report of the operation's latest turn. */
  performance: EventData | null = null;
  /** The Home's stage and status, as the page receives them. */
  homeStatus: Record<string, unknown> | null = null;
  /** (the robot's session, the fault's generation) of the last fault saved. */
  savedFaultIdentity: readonly [string | null, number | null] | null = null;
  /** The task, its model session and its turns. */
  readonly taskRun: TaskRun<State, Action>;
  readonly homeReview: HomeReview;
  readonly commands: ConsoleCommands;
  readonly preview: ConsolePreview;
  readonly watchdog: ConsoleWatchdog;

  /** Returns the URL under which the page reads a file of a task, if the console was given one. */
  readonly recordUrl?: (taskId: string, name: string) => string;

  private readonly robotProfile: () => Record<string, unknown>;
  private readonly renderSystemPrompt: (instruction: string, actionFormat: ActionFormat<State, Action>) => string;
  private readonly wallClock: () => number;
  private readonly clock: Clock;
  private readonly timeNs: () => bigint;
  private readonly sleep: Sleep;
  private readonly log: RobotLog;

  constructor(options: ConsoleOptions<State, Action, Image>) {
    this.wallClock = options.wallClock ?? (() => Date.now() / 1000);
    this.clock = options.clock ?? monotonic;
    this.timeNs = options.timeNs ?? (() => BigInt(Date.now()) * 1_000_000n);
    this.sleep = options.sleep ?? machineSleep;
    this.log = options.log ?? (() => undefined);
    this.renderSystemPrompt = options.renderSystemPrompt ?? ((instruction) => systemPrompt(instruction));
    if (options.recordUrl !== undefined) {
      this.recordUrl = options.recordUrl;
    }

    this.records = options.records;
    this.modelsConfig = options.modelsConfig;
    this.cameraFeed = options.cameraFeed;
    this.robot = options.robot;
    this.agentRobot = options.agentRobot;
    this.robotProfile = options.robotProfile;
    this.uploads = options.uploads;
    this.recordings = options.recordings;
    this.annotations = options.annotations;

    this.lease = new ControlLease(() => this.isBusy, { clock: this.clock });
    this.model = this.modelsConfig.defaultModel;
    this.healthChecks = new HealthChecks((model) => this.newClient(model, Console.CHECK_INSTRUCTION), {
      clock: this.clock,
    });

    this.taskRun = new TaskRun<State, Action>(this, this.records, {
      wallClock: this.wallClock,
      ...(options.uuid !== undefined ? { uuid: options.uuid } : {}),
      ...(options.loop !== undefined ? { loop: options.loop } : {}),
    });
    this.homeReview = new HomeReview(options.uuid !== undefined ? { uuid: options.uuid } : {});
    this.commands = options.commands(this);
    this.preview = options.preview;
    this.watchdog = options.watchdog(this);
  }

  /** What the console is doing, as the page shows it. */
  get phase(): Phase {
    return this._phase;
  }

  /** Whether an operation runs on the console's worker. */
  get isBusy(): boolean {
    return this.worker !== null && this.worker.isAlive;
  }

  /** The action format the selected model answers in. */
  get actionFormat(): ActionFormat<State, Action> {
    return this.modelsConfig.actionFormat(this.model);
  }

  /** How long the selected model may take to answer a turn, s (not PEAR's: its task run reads
   * models_config.models[model].timeout_s through the console). */
  get modelTimeoutS(): number {
    return this.offeredModel(this.model).timeoutS;
  }

  /** Shows ``phase``; the one writer of the phase. */
  setPhase(phase: Phase): void {
    // (PEAR: with self.lock; nothing is awaited here)
    this._phase = phase;
  }

  /**
   * Cancels the running operation, stops the robot and returns how long the stop request took.
   *
   * The cancellation is aborted and the robot's stop is called before this returns its promise; what follows the
   * robot's stop comes once that has ended, and the operation, which sees the cancellation, may end before it.
   */
  async stop(options: { isLatching?: boolean; reason?: string } = {}): Promise<StopReport> {
    const isLatching = options.isLatching ?? false;
    const reason = options.reason ?? Console.PAUSE_REASON;
    // no inference, event file, network, lifecycle or console lock before the stop itself
    const startedAt = this.clock();
    this.cancellation.abort();
    let stopRequestSeconds: number;
    try {
      await this.robot.stop();
      stopRequestSeconds = this.clock() - startedAt;
    } finally {
      this.homeReview.answered.abort(); // a Home review that waits for the operator sees the cancellation
      // (PEAR: with self.lock; nothing is awaited here)
      // a failed stop request still latches, so no further motion starts until the reset
      if (isLatching) {
        this.isStopLatched = true;
      }
      this.setPhase(Phase.STOPPING);
      this.performance = null;
      this.recordings.stop(reason, { stoppedAt: startedAt });
    }

    const stopping = { message: reason, stop_request_seconds: stopRequestSeconds };
    this.emit(Console.STOPPING_EVENT, stopping, { isSaved: false });

    return { stop_requested: true, stop_request_seconds: stopRequestSeconds };
  }

  /** Returns the state the page shows; nothing is awaited, so all of it is one moment. */
  snapshot(): ConsoleSnapshot {
    const robotState = this.robot.status(true);
    const cameraStatus = this.preview.status();
    const recording = this.recordings.snapshot();

    // (PEAR: with self.lock; nothing is awaited here)
    const taskRun = this.taskRun;
    const session = taskRun.session;
    const activeTurn = taskRun.activeTurn;
    let phase: Phase = this._phase;
    const motion = (robotState as Partial<DetailedStatus>).motion;
    if (phase === Phase.EXECUTING && pythonTruth(motion === undefined ? null : motion.settling)) {
      phase = Phase.SETTLING;
    }

    return {
      phase,
      profile: this.robotProfile(),
      model: this.model,
      models: Object.entries(this.modelsConfig.models).map(([name, offeredModel]) => ({
        id: name,
        label: offeredModel.label,
        action_format: offeredModel.actionFormat,
      })),
      action_format: this.actionFormat.name,
      active_turn: activeTurn !== null && pythonTruth(activeTurn) ? { ...activeTurn } : null,
      robot: robotState,
      model_health: this.healthChecks.get(this.model),
      supports_reference_images: this.supportsReferenceImages(),
      busy: this.isBusy,
      stop_latched: this.isStopLatched,
      error: this.error,
      task: taskRun.task,
      total_steps: taskRun.totalSteps,
      sequence: session ? session.turnCount : 0,
      owner: this.lease.owner,
      home_plan: this.homeReview.plan,
      home_status: this.homeStatus,
      performance: this.performance,
      inference_started_at: taskRun.inferenceStartedAt,
      recording,
      cameras: cameraStatus,
    };
  }

  /** Returns the selected model's connection: from a recent check unless ``isForced``, else from a client made
   * for it. */
  checkModel(options: { isForced?: boolean } = {}): Promise<ModelHealth> {
    return this.healthChecks.check(this.model, { isForced: options.isForced ?? false });
  }

  /** Whether the selected model accepts a task's images, as its last connection check tells. */
  supportsReferenceImages(): boolean {
    // the port's type of a client's class gives its constructor alone, not the static method PEAR calls here
    const clientType = this.offeredModel(this.model).clientClass as unknown as Pick<
      typeof ModelClient,
      "supportsReferenceImages"
    >;

    return clientType.supportsReferenceImages(this.healthChecks.get(this.model));
  }

  /** Publishes one event to the recording and the browsers and, when ``isSaved`` (by default true) and there is a
   * task, to the task's events; returns the event. */
  emit(kind: string, data: EventData, options: { isSaved?: boolean } = {}): ConsoleEventRecord {
    const isSaved = options.isSaved ?? true;
    this.recordings.onEvent(kind, data);

    // (PEAR: with self.lock; nothing is awaited here)
    const activeTurn = this.taskRun.activeTurn;
    const taskId = this.taskRun.task?.id ?? null;
    // an event of the running turn carries the turn's fields
    let eventData: EventData;
    // (PEAR: data.get("attempt") == active_turn["attempt"]; data without an attempt gives None there)
    if (activeTurn !== null && pythonTruth(activeTurn) && (data["attempt"] ?? null) === activeTurn.attempt) {
      eventData = { ...activeTurn, ...data };
    } else {
      eventData = { ...data };
    }
    this.lastEventId += 1;
    const event: ConsoleEventRecord = {
      id: this.lastEventId,
      type: String(kind),
      data: eventData,
      time: this.wallClock(),
      monotonic_s: this.clock(), // the clock of the recordings' timelines and the cameras' frames
      task_id: taskId,
    };

    if (isSaved && taskId !== null && pythonTruth(taskId)) {
      this.records.appendEvent(taskId, event);
    }
    this.events.push(event);
    while (this.events.length > Console.EVENT_CAPACITY) {
      this.events.shift(); // (PEAR: a deque of that maximum length)
    }

    return event;
  }

  /** Runs ``operation(cancellation)`` on the console's worker; a failure stops the robot and is shown to the
   * operator. It returns once the operation is started, without awaiting it; ``cancellation`` is the controller
   * the operation is cancelled by, a new one by default. */
  launch(operation: Operation, options: { cancellation?: AbortController | null; isRecorded?: boolean } = {}): void {
    // (PEAR: with self.lock; nothing is awaited here)
    if (this.isBusy) {
      throw new ValueError("Wait for the current operation to finish stopping.");
    }
    const cancellation = (this.cancellation = options.cancellation ?? new AbortController());
    OperatorPaused.checkCancelled(cancellation.signal);

    const isRecorded = options.isRecorded ?? false;
    this.worker = new ConsoleWorker(
      Console.WORKER_THREAD_NAME,
      () => this.operate(operation, cancellation.signal, isRecorded),
      this.sleep,
      // what leaves the worker's body ends the thread; Python prints it, here it goes to the log
      (error) => this.log("console", "error", `Exception in thread ${Console.WORKER_THREAD_NAME}`, error),
    );
  }

  /** The worker's body: one operation, then its failure handling, the end of its recording and the withdrawal of
   * a Home plan under review (PEAR: _operate). */
  private async operate(operation: Operation, cancellation: AbortSignal, isRecorded: boolean): Promise<void> {
    try {
      try {
        await operation(cancellation);
      } catch (error) {
        if (isOperatorPaused(error)) {
          this.setPhase(Phase.STOPPING);
        } else {
          this.log("console", "error", "An operation of the console failed", error);
          await this.robot.stop();
          this.recordError(error);
          this.performance = null;

          if (error instanceof HomeFailed) {
            this.homeStatus = { ...error.details, status: HomeStatus.FAILED };
            this.records.writeRootJson(`home-failed-${this.timeNs()}.json`, this.homeStatus);
          }
          if (this.robotStatus() === RobotStatus.FAULT) {
            this.setPhase(Phase.FAULT);
          } else {
            this.setPhase(error instanceof HomeFailed ? Phase.HOME_FAILED : Phase.STOPPING);
          }
        }
      }
    } finally {
      if (isRecorded) {
        this.recordings.stop(this.error !== null && pythonTruth(this.error) ? this.error : "Task paused");
      }
      // (PEAR: with self.lock; nothing is awaited here)
      this.homeReview.plan = null;
    }
  }

  /** Stops the robot and releases it, the cameras and the model session; the motors must be disabled first. */
  async close(): Promise<void> {
    await this.stop({ reason: "GUI shutdown" });
    if (this.worker !== null) {
      await this.worker.join(Console.WORKER_JOIN_S);
    }
    // the robot is shut down only once its motors are explicitly disabled
    if (this.robotStatus() !== RobotStatus.OFF) {
      throw new RuntimeError("Disable motors before shutting down the GUI service");
    }

    await this.watchdog.close();
    await this.recordings.close();
    try {
      await this.taskRun.closeSession();
    } finally {
      await this.robot.close();
      await this.preview.close();
    }
  }

  /** Returns a new client of ``model``, its system prompt the task ``instruction`` in the model's format. */
  newClient(model: string, instruction: string): ModelClient {
    const offeredModel = this.offeredModel(model);

    return offeredModel.newClient(this.renderSystemPrompt(instruction, this.modelsConfig.actionFormat(model)));
  }

  /** Shows an operation's failure to the operator and saves the robot's fault, if it has one. */
  recordError(error: unknown): void {
    this.error = `${pythonErrorName(error)}: ${pythonErrorMessage(error)}`;
    this.emit(Console.ERROR_EVENT, { message: this.error }, { isSaved: false });
    this.saveControlDiagnostic();
  }

  /** Saves the robot's current fault, once for each generation of a fault. */
  saveControlDiagnostic(): void {
    const robotState = this.robot.status(true);
    const generation = (robotState as Partial<DetailedStatus>).generation ?? null;
    const faultIdentity = [this.robot.sessionId, generation] as const;
    // claimed under the lock: the watchdog and the worker may both find the same fault unsaved
    // (PEAR: with self.lock; nothing is awaited here)
    const saved = this.savedFaultIdentity;
    if (
      !pythonTruth(robotState.fault) ||
      (saved !== null && saved[0] === faultIdentity[0] && saved[1] === faultIdentity[1])
    ) {
      return;
    }
    this.savedFaultIdentity = faultIdentity;

    try {
      if (!("fault_details" in robotState)) {
        throw new KeyError("'fault_details'");
      }
      const faultRecord = { fault: robotState.fault, details: robotState.fault_details };
      this.records.writeRootJson(`control-fault-${this.timeNs()}.json`, faultRecord);
    } catch (error) {
      if (!(error instanceof OSError || isValueError(error))) {
        throw error;
      }
      this.log("console", "error", "Could not persist control fault record", error);
    }
  }

  /** Returns the robot's status, the word of a RobotStatus such as OFF, READY or FAULT. */
  robotStatus(): string {
    return this.robot.status().status;
  }

  /** Returns the offered model ``model`` (models_config.models[model]); throws Python's KeyError for a name the
   * station does not offer. */
  private offeredModel(model: string): OfferedModel {
    const models = this.modelsConfig.models;
    if (!Object.hasOwn(models, model)) {
      throw new KeyError(pythonStringRepr(model));
    }

    return models[model]!;
  }
}
