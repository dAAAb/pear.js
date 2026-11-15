// Ports pear/deploy/station/gui/console/commands.py: Command and Commands, the operator's commands.
//
// The Python is carried over as console.ts carries console.py over: the worker thread is the console's
// ConsoleWorker, a cancellation is an AbortController whose signal an operation is given, the constants are read
// from the class itself, and PEAR's private methods are private methods under the same names in camelCase.
//
// What Commands is given beside its console (CommandsOptions). PEAR reads three constants of the robot's class
// through the robot object (ACTION_FORMATS, HOME_ARM_CHOICES, HOME_CAN_KEEP_GRIPPERS); the port's robot has them
// as static members of its class, which an object does not give, so the class is given apart, as the console is
// given the robot's profile. time.time(), time.time_ns(), uuid4() and the log are options, by default the
// machine's: the console keeps its own private, so whoever makes both gives both the same functions.
//
// The parts that are not ported. console.ts has an interface for each with what console.py uses. What commands.py
// uses beyond that is in the interfaces of this file (CommandsRobot, CommandsPreview, CommandsUploads,
// CommandsAnnotations, CommandsRecordings, CommandsRecords), each with exactly the members commands.py uses, and
// CommandsConsole is the Console whose parts have them. The calls of the uploads, the annotations, the recordings
// and the records are synchronous, as the task run's records are: `start` awaits nothing.
//
// run. PEAR's run is synchronous and is called on a thread of the page's service; here it is an async function,
// and whatever it throws is its promise's rejection. Nothing is awaited before a handler is called unless the
// command stops the running operation first, so this much has happened when run returns its promise:
//   pause, stop         Console.stop is called: the cancellation is aborted and the robot's stop is called. The
//                       latch, the phase, the recording's stop and the event follow once the robot's stop ended.
//   home_confirm        all of it: the Home review has its answer.
//   reset_stop, model, recording, recover_control, start, resume
//                       all of it; for the last three the operation is launched (it begins on a later microtask).
//   reconnect_cameras   the phase is shown and the operation is launched.
//   enable              the two checks, and the cameras' read is called. The phase ENABLING and the launch come
//                       once the read has ended.
//   clear, disable, home
//                       while no operation runs: all of it, the operation launched. While one runs: Console.stop
//                       is called (as for pause); the wait for the old operation and for the robot to settle, the
//                       checks and the launch come after it.
//
// The lock. `with console.lock` is nothing here: nothing is awaited where PEAR holds it (reset_stop,
// reconnect_cameras, recover_control, the end of the recovery). What an await lets in is said where it is
// (stopBefore, enable). PEAR's page service gives the commands that are not immediate one at a time; run does not
// queue them, so that is the caller's to keep.

import { ModelEvent, type EventData } from "../agent/clients/schemas";
import type { ModelState, SingleArmDelta } from "../protocol/types";
import {
  AttributeError,
  isValueError,
  KeyError,
  pythonErrorMessage,
  pythonErrorName,
  PythonTypeError,
  RuntimeError,
  ValueError,
} from "../python/errors";
import { pythonRepr, pythonStr, pythonStringRepr, pythonTruth, pythonValueOf } from "../python/repr";
import { pythonStrip } from "../python/whitespace";
import type { Awaitable } from "../agent/robot";
import type { CameraFeed } from "../station/cameras";
import { OperatorPaused } from "../station/exceptions";
import { HomeStage } from "../station/motion/homing";
import type { RobotLog } from "../station/robot";
import { RobotStatus, type BriefStatus, type DetailedStatus, type HomePlan, type HomeReport } from "../station/schemas";
import {
  Console,
  type ConsolePreview,
  type ConsoleRecordings,
  type ConsoleRecords,
  type ConsoleRobot,
  type StopReport,
} from "./console";
import { HomeStatus } from "./home_review";
import { idleFor, Phase, STOPPED_STATUSES } from "./phase";
import { TaskEventKind } from "./task_events";
import { recordUrl, type TaskRecord } from "./task_run";

/** The record of a task as it started: id, instruction, model, images (TaskFiles.TASK_NAME). */
export const TASK_NAME = "task.json";

/** What a command is given: the object of the page's request. */
export type CommandData = EventData;

/** What a command answers. */
export type CommandAnswer = EventData;

/** What a handler returns: its answer, or nothing (PEAR: None), which run answers as {"accepted": true}. */
export type CommandHandler = (data: CommandData) => Awaitable<CommandAnswer | null | undefined | void>;

/** One of the operator's commands: its handler, and how the console and the page's service admit it. */
export class Command {
  /** Runs at once, never behind another command or the running operation. */
  readonly isImmediate: boolean;
  /** Only the tab that holds control may give it. */
  readonly needsControl: boolean;
  /** Refused while STOP MOTION is latched. */
  readonly isLatchBlocked: boolean;
  /** Stops the running operation instead of waiting for it. */
  readonly stopsFirst: boolean;
  /** Clears the failure the page shows once it is admitted. */
  readonly clearsError: boolean;
  /** Clears the inference report the page shows once it is admitted. */
  readonly clearsPerformance: boolean;

  constructor(
    /** Takes the command's data; returns its answer. */
    readonly handler: CommandHandler,
    options: {
      isImmediate?: boolean;
      needsControl?: boolean;
      isLatchBlocked?: boolean;
      stopsFirst?: boolean;
      clearsError?: boolean;
      clearsPerformance?: boolean;
    } = {},
  ) {
    this.isImmediate = options.isImmediate ?? false;
    this.needsControl = options.needsControl ?? true;
    this.isLatchBlocked = options.isLatchBlocked ?? false;
    this.stopsFirst = options.stopsFirst ?? false;
    this.clearsError = options.clearsError ?? true;
    this.clearsPerformance = options.clearsPerformance ?? false;
    Object.freeze(this); // (PEAR: a frozen dataclass)
  }
}

/** What the robot's Home is given by the console: PEAR's keywords, and the robot's own ``home_options``. */
export interface CommandsHomeOptions {
  cancellation: AbortSignal;
  /** Receives each stage. */
  reportProgress: (progress: Record<string, unknown>) => Awaitable<void>;
  /** Approves the plan before anything moves: only `true` does. */
  approvePlan: (plan: HomePlan) => Awaitable<boolean>;
  /** The arm Home returns, one of HOME_ARM_CHOICES; given only by a robot that has a choice. */
  side?: unknown;
  /** false: return only the arm joints and keep the current gripper targets; given only by a robot whose Home can
   * keep the grippers (PEAR: opens_grippers). */
  opensGrippers?: boolean;
}

/** What commands.py calls of the station's robot (BaseRobot), beside what console.py calls. */
export interface CommandsRobot extends ConsoleRobot {
  /** Opens the robot's session, which enables the motors. */
  open(): Awaitable<unknown>;
  /** Waits for a settled HOLD. */
  waitStationary(): Awaitable<unknown>;
  /** Reacquires a hold after a fault, without replacing the session or enabling motors. */
  recover(options: { cancellation: AbortSignal }): Awaitable<unknown>;
  /** Returns the arms Home once ``approvePlan`` approves the plan, and returns the Home report. */
  home(options: CommandsHomeOptions): Awaitable<HomeReport>;
}

/** What commands.py reads of the robot's class (PEAR reads them through the robot object). */
export interface CommandsRobotClass {
  /** Its action formats by name, the default first; commands.py counts them. */
  readonly ACTION_FORMATS: Readonly<Record<string, unknown>>;
  /** The arms Home may return, the default first; empty: no choice. */
  readonly HOME_ARM_CHOICES: readonly string[];
  /** Whether Home may leave the grippers as they are. */
  readonly HOME_CAN_KEEP_GRIPPERS: boolean;
}

/** What commands.py uses of PEAR's Preview, beside what console.py calls. */
export interface CommandsPreview extends ConsolePreview {
  /** Whether previews are encoded: the cameras' reader is open. */
  readonly isEncoding: boolean;
  /** The cameras' errors in one sentence; null without one. */
  readonly errorText: string | null;
  /** Replaces the cameras' reader with a new one and encodes previews of it; it never moves the arms. */
  reconnect(cancellation: AbortSignal): Awaitable<void>;
}

/** The description of an image a task took, as PEAR's ImageUploads.attach returns it. */
export interface AttachedImage {
  /** The UUID a model's service knows the image by. */
  readonly id: string;
  /** The upload's file name. */
  readonly name: string;
  /** The image's file in the task's folder. */
  readonly file: string;
  readonly width: number;
  readonly height: number;
}

/** What commands.py calls of PEAR's ImageUploads, the images an operator gives with a task. */
export interface CommandsUploads {
  /** Copies the drafts ``uploadIds`` of ``owner`` into the records of the task ``taskId``, in the given order, and
   * returns their descriptions (attach(upload_ids, owner, files)); it throws a ValueError for anything but up to
   * four distinct ids of drafts the owner holds. */
  attach(uploadIds: unknown, owner: string | null, taskId: string): AttachedImage[];
  /** Removes one draft of ``owner``; it throws a ValueError for a draft the owner does not hold. */
  delete(uploadId: string, owner: string | null): void;
}

/** What commands.py calls of PEAR's Annotations, the one writer of the tasks' tags. */
export interface CommandsAnnotations {
  /** Returns the tags trimmed, with single spaces and without case-insensitive duplicates, in their first
   * spelling; throws a ValueError for what is no list of tags (PEAR: the classmethod Annotations.clean_tags,
   * called on the class). */
  cleanTags(rawTags: unknown): string[];
  /** Replaces the tags of the task ``taskId`` (update(files, tags=tags)). */
  update(taskId: string, options: { tags: unknown }): unknown;
}

/** What commands.py uses of PEAR's RenderedRecordings, beside what console.py calls. */
export interface CommandsRecordings<Image = unknown> extends ConsoleRecordings {
  /** Whether a task that starts or resumes is recorded. */
  isEnabled: boolean;
  /** Starts the next segment of ``task``, unless recording is off; ``robotStatusReader`` returns the robot's
   * status with its control snapshot. */
  start(task: TaskRecord, cameraFeed: CameraFeed<Image>, robotStatusReader: () => DetailedStatus | BriefStatus): void;
}

/** What commands.py does with a task's folder, beside the console's records. */
export interface CommandsRecords extends ConsoleRecords {
  /** Makes the place of the records of the new task ``taskId`` (TaskFiles(root / taskId).directory.mkdir()); it
   * throws when there is one already or it cannot be made. */
  createTask(taskId: string): void;
  /** Removes everything kept of the task ``taskId`` (shutil.rmtree(files.directory)): a task whose images or tags
   * could not be kept leaves nothing. */
  removeTask(taskId: string): void;
}

/** The Console as Commands uses it: its parts with what commands.py uses of them. */
export type CommandsConsole<State = ModelState, Action = SingleArmDelta, Image = unknown> = Console<
  State,
  Action,
  Image
> & {
  readonly robot: CommandsRobot;
  readonly preview: CommandsPreview;
  readonly uploads: CommandsUploads;
  readonly annotations: CommandsAnnotations;
  readonly recordings: CommandsRecordings<Image>;
  readonly records: CommandsRecords;
};

/** What Commands is made with, beside its console. */
export interface CommandsOptions {
  /** The class of the console's robot: the three constants commands.py reads through the robot object. */
  robotClass: CommandsRobotClass;
  /** The wall clock, in seconds since the epoch (time.time()); by default the machine's. */
  wallClock?: () => number;
  /** The wall clock in nanoseconds since the epoch (time.time_ns()); by default the machine's, which advances by
   * a millisecond. */
  timeNs?: () => bigint;
  /** What gives a UUID (uuid4()), of which a task's id is made; by default a random one. */
  uuid?: () => string;
  /** Where logger.warning and logger.exception go; by default nowhere. */
  log?: RobotLog;
}

/** Whether ``error`` is PEAR's OperatorPaused, of the station's module or under that name from another one (as
 * the console tells it). */
function isOperatorPaused(error: unknown): boolean {
  return error instanceof OperatorPaused || pythonErrorName(error) === "OperatorPaused";
}

/** data.get(key, fallback): what ``data`` holds under ``key``, or ``fallback`` (by default null, Python's None)
 * when it has no such key. */
function get(data: CommandData, key: string, fallback: unknown = null): unknown {
  return Object.hasOwn(data, key) && data[key] !== undefined ? data[key] : fallback;
}

/** The operator's commands: each is admitted on the caller's side, and a long one then runs on the console's
 * worker. */
export class Commands<State = ModelState, Action = SingleArmDelta, Image = unknown> {
  /** Longest task instruction accepted, in characters. */
  static readonly MAX_INSTRUCTION_CHARS = 20000;
  /** The stage a robot's Home reports -> the phase shown. */
  static readonly HOME_STAGE_PHASES: Readonly<Record<HomeStage, Phase>> = {
    [HomeStage.OPENING]: Phase.OPENING_GRIPPERS,
    [HomeStage.CHECKING]: Phase.CHECKING_DIRECT_HOME,
    [HomeStage.HOMING]: Phase.HOMING,
    [HomeStage.COMPLETED]: Phase.HOME_COMPLETE,
  };

  /** The commands, by the name the page sends, in PEAR's order. */
  readonly table: ReadonlyMap<string, Command>;

  private readonly robotClass: CommandsRobotClass;
  private readonly wallClock: () => number;
  private readonly timeNs: () => bigint;
  private readonly uuid: () => string;
  private readonly log: RobotLog;

  constructor(
    readonly console: CommandsConsole<State, Action, Image>,
    options: CommandsOptions,
  ) {
    this.robotClass = options.robotClass;
    this.wallClock = options.wallClock ?? (() => Date.now() / 1000);
    this.timeNs = options.timeNs ?? (() => BigInt(Date.now()) * 1_000_000n);
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
    this.log = options.log ?? (() => undefined);

    this.table = new Map<string, Command>([
      ["pause", new Command((data) => this.pause(data), { isImmediate: true })],
      ["stop", new Command((data) => this.stop(data), { isImmediate: true, needsControl: false })],
      ["home_confirm", new Command((data) => this.confirmHome(data), { isImmediate: true })],
      ["reset_stop", new Command((data) => this.resetStop(data), { clearsError: false })],
      ["reconnect_cameras", new Command((data) => this.reconnectCameras(data))],
      ["enable", new Command((data) => this.enable(data), { isLatchBlocked: true })],
      ["recover_control", new Command((data) => this.recoverControl(data))],
      ["start", new Command((data) => this.start(data), { isLatchBlocked: true, clearsPerformance: true })],
      ["resume", new Command((data) => this.resume(data), { isLatchBlocked: true, clearsPerformance: true })],
      ["clear", new Command((data) => this.clear(data), { stopsFirst: true, clearsPerformance: true })],
      ["disable", new Command((data) => this.disable(data), { stopsFirst: true, clearsPerformance: true })],
      [
        "home",
        new Command((data) => this.home(data), { isLatchBlocked: true, stopsFirst: true, clearsPerformance: true }),
      ],
      ["model", new Command((data) => this.selectModel(data), { clearsPerformance: true })],
      ["recording", new Command((data) => this.setRecording(data))],
    ]);
  }

  /**
   * Admits the command ``name`` with ``data`` and returns its answer; STOP and pause never wait for anything.
   *
   * Nothing is awaited before the handler is called, unless the command stops the running operation first: an
   * immediate command's handler has been called when this returns its promise (see the head of this file).
   */
  async run(name: string, data?: CommandData | null): Promise<CommandAnswer> {
    const console = this.console;
    const commandData = data ?? {}; // (PEAR: data or {}; an empty object stays one)
    const command = this.table.get(name);
    if (command === undefined) {
      throw new ValueError("Unknown command");
    }
    if (command.isImmediate) {
      // (PEAR returns the handler's answer as it is; the three immediate handlers always give one)
      return (await command.handler(commandData)) as CommandAnswer;
    }

    if (command.stopsFirst && console.isBusy) {
      await this.stopBefore(name);
    }
    if (console.isBusy) {
      throw new ValueError("Wait for the current operation or pause it first");
    }
    if (command.isLatchBlocked && console.isStopLatched) {
      throw new ValueError("Reset STOP MOTION before continuing");
    }

    if (command.clearsError) {
      console.error = null;
    }
    if (command.clearsPerformance) {
      console.performance = null;
    }
    const answer = await command.handler(commandData);

    return answer === null || answer === undefined ? { accepted: true } : answer;
  }

  /**
   * Stops the running operation and waits for it to end and for the robot to settle.
   *
   * Console.stop is called before the first await. PEAR blocks its caller's thread through the stop, the join and
   * the settling, while the other threads go on; here the three are awaited, and what PEAR's other threads do
   * comes between them as it does there: a STOP or a pause, the watchdog's check, the old operation's end. run
   * looks again whether an operation runs once this has returned, as PEAR's does.
   */
  private async stopBefore(name: string): Promise<void> {
    const console = this.console;
    const previousWorker = console.worker;
    await console.stop({ reason: "Stopping before " + name });

    if (previousWorker === null) {
      throw new AttributeError("'NoneType' object has no attribute 'join'");
    }
    await previousWorker.join(Console.WORKER_JOIN_S);
    if (previousWorker.isAlive) {
      throw new ValueError("Old operation is still stopping; no new operation was started");
    }
    const robotStatus = console.robotStatus();
    if (robotStatus !== RobotStatus.OFF && robotStatus !== RobotStatus.FAULT) {
      await console.robot.waitSettled(Console.SETTLE_TIMEOUT_S);
    }
  }

  /** Pauses the running operation and stops the robot. */
  private async pause(_data: CommandData): Promise<CommandAnswer> {
    // Console.stop is called before this awaits: the cancellation is aborted and the robot's stop is called
    const report: StopReport = await this.console.stop();

    return { ...report };
  }

  /** Stops the robot and latches STOP MOTION until it is reset. */
  private async stop(_data: CommandData): Promise<CommandAnswer> {
    // Console.stop is called before this awaits: the cancellation is aborted and the robot's stop is called
    const report: StopReport = await this.console.stop({ isLatching: true, reason: "STOP MOTION activated" });

    return { ...report };
  }

  /** Answers the Home plan under review. */
  private confirmHome(data: CommandData): CommandAnswer {
    this.console.homeReview.confirm(get(data, "plan_id"), get(data, "confirm") === true);

    return { accepted: true };
  }

  /** Releases the STOP MOTION latch of a stopped, stable robot without moving it. */
  private resetStop(_data: CommandData): CommandAnswer {
    const console = this.console;

    // under the lock a STOP that arrives meanwhile latches after this reset, never before it
    // (PEAR: with console.lock; nothing is awaited here)
    const robotStatus = console.robotStatus();
    if (!(STOPPED_STATUSES as readonly string[]).includes(robotStatus)) {
      throw new ValueError("Robot must be stopped and stable before reset");
    }
    console.isStopLatched = false;
    console.setPhase(idleFor(robotStatus, { isLatched: false, hasTask: console.taskRun.task !== null }));

    return { reset: true };
  }

  /** Replaces the cameras' reader between operations; the motors, the task and its model session stay. */
  private reconnectCameras(_data: CommandData): void {
    const console = this.console;
    // (PEAR: with console.lock; nothing is awaited here)
    const previousPhase = console.phase; // shown again once the cameras are back
    console.setPhase(Phase.RECONNECTING_CAMERAS);

    console.launch((cancellation) => this.replaceCameras(cancellation, previousPhase));
  }

  /** Reconnects the cameras, then shows ``previousPhase`` again; it never moves the arms. */
  private async replaceCameras(cancellation: AbortSignal, previousPhase: Phase): Promise<void> {
    const console = this.console;
    await console.preview.reconnect(cancellation);

    console.emit(ModelEvent.NOTICE, { message: "Camera reconnect started. Motors and the task are unchanged." });
    console.setPhase(previousPhase);
    // a STOP or a fault during the reconnect still ends it as a stopped operation
    OperatorPaused.checkCancelled(cancellation);
  }

  /**
   * Enables the motors, holding where the arms are, once every camera delivers frames.
   *
   * The two checks are made and the cameras' read is called before the first await. PEAR's read blocks the
   * caller's thread; here it is awaited, and what comes meanwhile is not held back: a STOP (which latches: the
   * launch below still starts, as it would in PEAR for a STOP that arrives during the read, and its operation is
   * cancelled by nothing, since launch makes a new cancellation), or another command that launches an operation
   * (the launch below then throws "Wait for the current operation to finish stopping." with the phase ENABLING
   * shown). PEAR's page service gives one such command at a time.
   */
  private async enable(_data: CommandData): Promise<void> {
    const console = this.console;
    if (console.robotStatus() !== RobotStatus.OFF) {
      throw new ValueError("Motors are already enabled");
    }
    if (console.cameraFeed.reader === null || (console.preview.isEncoding && pythonTruth(console.preview.errorText))) {
      throw new ValueError("Cameras are unavailable. Reconnect cameras first.");
    }
    await console.cameraFeed.read(); // reconnecting, partial or stale cameras never enable the motors
    console.setPhase(Phase.ENABLING);

    console.launch((cancellation) => this.openRobot(cancellation));
  }

  /** Opens the robot's session, which enables the motors, and waits until the arms hold still. */
  private async openRobot(cancellation: AbortSignal): Promise<void> {
    const console = this.console;
    OperatorPaused.checkCancelled(cancellation);
    await console.robot.open();
    OperatorPaused.checkCancelled(cancellation);
    await console.robot.waitStationary();
    console.setPhase(Phase.HOLDING);
  }

  /** Recovers a faulted robot's control at its current pose, keeping the task paused. */
  private recoverControl(_data: CommandData): void {
    const console = this.console;

    // (PEAR: with console.lock; nothing is awaited here)
    if (console.robotStatus() !== RobotStatus.FAULT) {
      throw new ValueError("Control recovery requires a faulted robot");
    }
    console.saveControlDiagnostic();
    // the old request's cancellation stays set, for its late model events too
    console.cancellation.abort();
    const cancellation = (console.cancellation = new AbortController());
    console.setPhase(Phase.RECOVERING_CONTROL);

    console.launch((signal) => this.recover(signal), { cancellation });
  }

  /** Reacquires the robot's hold at its current pose, then shows the console idle. */
  private async recover(cancellation: AbortSignal): Promise<void> {
    const console = this.console;
    try {
      await console.robot.recover({ cancellation });
    } catch (error) {
      if (isOperatorPaused(error)) {
        throw error;
      }
      throw new RuntimeError(`Control recovery failed: ${pythonErrorMessage(error)}`, { cause: error });
    }

    // (PEAR: with console.lock; nothing is awaited here)
    OperatorPaused.checkCancelled(cancellation);
    const robotStatus = console.robotStatus();
    if (robotStatus !== RobotStatus.READY) {
      throw new RuntimeError("Robot is no longer stable after recovery");
    }
    console.error = null;
    const idlePhase = idleFor(robotStatus, {
      isLatched: console.isStopLatched,
      hasTask: console.taskRun.task !== null,
    });
    console.setPhase(idlePhase);
    const message = "Control recovered at the current pose. Motors remain enabled. Choose Resume or Home.";
    console.emit(ModelEvent.NOTICE, { message });
  }

  /** Creates the record of a task from its instruction, tags and images, and runs its turns. Nothing is awaited. */
  private start(data: CommandData): void {
    const console = this.console;
    const taskRun = console.taskRun;
    if (pythonTruth(taskRun.task)) {
      throw new ValueError("Clear the current task before starting a new one");
    }
    // (str(data.get("instruction", "")).strip(): what is no text is taken as Python writes it)
    const instruction = pythonStrip(pythonStr(pythonValueOf(get(data, "instruction", ""))));
    // (len(instruction): Python counts code points, a JavaScript string's length UTF-16 units)
    const instructionChars = [...instruction].length;
    if (!(1 <= instructionChars && instructionChars <= Commands.MAX_INSTRUCTION_CHARS)) {
      // (the dash of PEAR's text is an en dash, U+2013)
      throw new ValueError(`Enter a task of 1–${Commands.MAX_INSTRUCTION_CHARS} characters`);
    }
    const tags = console.annotations.cleanTags(get(data, "tags", []));
    const imageIds = get(data, "image_ids", []);
    if (pythonTruth(imageIds) && !console.supportsReferenceImages()) {
      throw new ValueError("This model service does not yet support task images");
    }
    if (!console.preview.isEncoding || pythonTruth(console.preview.errorText)) {
      throw new ValueError("Restore live camera feeds before starting a task");
    }
    if (console.robotStatus() !== RobotStatus.READY) {
      throw new ValueError("Enable motors and wait for stable holding first");
    }

    const models = console.modelsConfig.models;
    if (!Object.hasOwn(models, console.model)) {
      throw new KeyError(pythonStringRepr(console.model)); // (models_config.models[console.model])
    }
    const offeredModel = models[console.model]!;
    const task: TaskRecord = {
      id: this.uuid().replace(/-/g, ""), // (uuid4().hex)
      instruction,
      created: this.wallClock(),
      model: console.model,
      model_label: offeredModel.label,
    };
    if (Object.keys(this.robotClass.ACTION_FORMATS).length > 1) {
      task["action_format"] = console.actionFormat.name;
    }
    // a client that names one (getattr(offered_model.client_type, "REASONING_EFFORT", None))
    const reasoningEffort = (offeredModel.clientClass as { REASONING_EFFORT?: unknown }).REASONING_EFFORT ?? null;
    if (pythonTruth(reasoningEffort)) {
      task["reasoning_effort"] = reasoningEffort; // shown beside the model's name in the styled task video
    }

    const records = console.records;
    records.createTask(task.id);
    try {
      const attachedImages = console.uploads.attach(imageIds, console.lease.owner, task.id);
      // the page fetches each image where the page's service serves the task's files
      task.images = attachedImages.map((image) => ({ ...image, url: this.recordUrl(task.id, image.file) }));
      if (pythonTruth(tags)) {
        console.annotations.update(task.id, { tags });
      }
    } catch (error) {
      records.removeTask(task.id);
      throw error;
    }

    taskRun.task = task;
    records.writeJson(task.id, TASK_NAME, task);
    for (const uploadId of imageIds as string[]) {
      try {
        console.uploads.delete(uploadId, console.lease.owner);
      } catch (error) {
        if (!isValueError(error)) {
          throw error;
        }
        // the task's copies are made: a draft that stays cannot hold the task back
        this.log("commands", "warning", `Draft image ${uploadId} was not removed: ${pythonErrorMessage(error)}`);
      }
    }

    taskRun.totalSteps = taskRun.turnNumber = 0;
    taskRun.activeAttemptId = taskRun.activeTurn = null;
    console.emit(TaskEventKind.TASK, task);
    this.startRecordedLoop();
  }

  /** Runs the paused task's turns again, in its model session unless that session ended. Nothing is awaited. */
  private resume(_data: CommandData): void {
    const console = this.console;
    const taskRun = console.taskRun;
    if (!pythonTruth(taskRun.task) || console.robotStatus() !== RobotStatus.READY) {
      throw new ValueError("A paused task and stable enabled robot are required");
    }
    if (!console.preview.isEncoding || pythonTruth(console.preview.errorText)) {
      throw new ValueError("Restore live camera feeds before resuming");
    }
    if (taskRun.session !== null && pythonTruth(taskRun.session.blockedReason)) {
      throw new ValueError(taskRun.session.blockedReason + "; clear the task to restart");
    }

    this.startRecordedLoop();
  }

  /** Ends the task and its model session; its records stay in the history. */
  private clear(_data: CommandData): void {
    this.console.launch((cancellation) => this.clearTask(cancellation));
  }

  /** Closes the task's model session, then ends the task. */
  private async clearTask(_cancellation: AbortSignal): Promise<void> {
    const console = this.console;
    const taskRun = console.taskRun;
    await taskRun.closeSession();

    console.emit(TaskEventKind.TASK_END, { message: "Task cleared; history saved." });
    taskRun.task = null;
    taskRun.totalSteps = 0;
    taskRun.activeAttemptId = taskRun.activeTurn = null;
    console.setPhase(idleFor(console.robotStatus(), { isLatched: false, hasTask: false }));
  }

  /** Disables the motors once the operator confirms the arms are supported, even when the model's cleanup
   * fails. */
  private disable(data: CommandData): void {
    if (get(data, "confirm") !== true) {
      throw new ValueError("Confirm arms and objects are supported before disabling");
    }

    this.console.launch((cancellation) => this.closeRobot(cancellation));
  }

  /** Closes the task's model session and the robot's session, which disables the motors. */
  private async closeRobot(_cancellation: AbortSignal): Promise<void> {
    const console = this.console;
    const taskRun = console.taskRun;
    let cleanupError: unknown = null;
    let hasCleanupError = false;
    try {
      await taskRun.closeSession();
    } catch (error) {
      this.log("commands", "error", "The model session did not close", error);
      cleanupError = error;
      hasCleanupError = true;
    }

    // an explicit disable of the motors must not depend on a reachable model server
    await console.robot.close();
    if (!hasCleanupError) {
      taskRun.session = taskRun.modelClient = taskRun.task = null;
      taskRun.activeTurn = taskRun.activeAttemptId = null;
    }
    console.setPhase(Phase.DISABLED);
    if (hasCleanupError) {
      const message = "Motors disabled; model session cleanup failed: " + pythonErrorMessage(cleanupError);
      console.recordError(new RuntimeError(message));
    }
  }

  /** Ends the task and returns the arms Home once the operator approves the plan. Nothing is awaited. */
  private home(data: CommandData): void {
    const console = this.console;
    const robotClass = this.robotClass;
    if (console.robotStatus() !== RobotStatus.READY) {
      throw new ValueError("Home requires stable enabled motors");
    }

    const homeOptions: { side?: unknown; opensGrippers?: boolean } = {};
    if (robotClass.HOME_ARM_CHOICES.length > 0) {
      homeOptions.side = get(data, "side", robotClass.HOME_ARM_CHOICES[0]);
      if (!(robotClass.HOME_ARM_CHOICES as readonly unknown[]).includes(homeOptions.side)) {
        throw new ValueError("Invalid home side");
      }
    }
    // false: return only the arm joints and keep the current gripper targets
    const opensGrippers = get(data, "open_grippers", true);
    if (typeof opensGrippers !== "boolean" || (!opensGrippers && !robotClass.HOME_CAN_KEEP_GRIPPERS)) {
      throw new ValueError("Invalid home gripper choice");
    }
    if (robotClass.HOME_CAN_KEEP_GRIPPERS) {
      homeOptions.opensGrippers = opensGrippers;
    }

    console.launch((cancellation) => this.returnHome(cancellation, homeOptions, opensGrippers));
  }

  /** Ends the task and its model session, then returns the arms Home with ``homeOptions`` once the operator
   * approves the plan. */
  private async returnHome(
    cancellation: AbortSignal,
    homeOptions: { side?: unknown; opensGrippers?: boolean },
    opensGrippers: boolean,
  ): Promise<void> {
    const console = this.console;
    const taskRun = console.taskRun;
    console.homeStatus = { stage: HomeStage.CHECKING, status: HomeStatus.RUNNING };
    await taskRun.closeSession();
    if (pythonTruth(taskRun.task)) {
      console.emit(TaskEventKind.TASK_END, { message: "Task ended for home." });
    }
    taskRun.task = null;
    console.setPhase(Phase.CHECKING_HOME);

    const homeReport = await console.robot.home({
      cancellation,
      reportProgress: (progress) => this.reportHomeProgress(progress, cancellation),
      approvePlan: (plan) => this.reviewHome(plan, cancellation),
      ...homeOptions,
    });
    console.records.writeRootJson(`home-${this.timeNs()}.json`, { ...homeReport });

    console.homeStatus = {
      stage: HomeStage.COMPLETED,
      status: HomeStatus.COMPLETED,
      results: homeReport.results,
    };
    console.setPhase(Phase.HOME_COMPLETE);
    const reachedMessage = opensGrippers
      ? "Grippers opened and Home reached"
      : "Arms reached Home; grippers unchanged";
    console.emit(ModelEvent.NOTICE, { message: `${reachedMessage}. Start a new task when ready.` });
  }

  /** Shows one stage of the Home. */
  private reportHomeProgress(progress: Record<string, unknown>, cancellation: AbortSignal): void {
    const console = this.console;
    OperatorPaused.checkCancelled(cancellation);
    if (!Object.hasOwn(progress, "stage")) {
      throw new KeyError("'stage'"); // (progress["stage"])
    }
    const stage = progress["stage"];
    if (typeof stage !== "string" || !Object.hasOwn(Commands.HOME_STAGE_PHASES, stage)) {
      throw new KeyError(pythonRepr(pythonValueOf(stage))); // (HOME_STAGE_PHASES[stage])
    }
    const phase = Commands.HOME_STAGE_PHASES[stage as HomeStage];

    console.homeStatus = { ...progress, status: HomeStatus.RUNNING };
    console.setPhase(phase);
    console.emit(ModelEvent.NOTICE, { message: phase, home: console.homeStatus });
  }

  /** Records a Home plan, publishes it and returns the operator's answer; a STOP ends the wait. */
  private reviewHome(plan: HomePlan, cancellation: AbortSignal): Promise<boolean> {
    const console = this.console;
    const reviewPlan = console.homeReview.prepare(plan);
    console.records.writeRootJson(`home-plan-${this.timeNs()}.json`, reviewPlan);
    console.setPhase(Phase.CONFIRM_HOME);

    return console.homeReview.waitForDecision(reviewPlan, cancellation);
  }

  /** Chooses the model of the next task. */
  private selectModel(data: CommandData): void {
    const console = this.console;
    const model = get(data, "model");
    if (typeof model !== "string") {
      // (models_config.require(model): what is no text names no model; a list or an object cannot be looked up)
      if (model !== null && typeof model === "object") {
        throw new PythonTypeError(`unhashable type: '${Array.isArray(model) ? "list" : "dict"}'`);
      }
      const names = Object.keys(console.modelsConfig.models).join(", ");
      throw new ValueError(
        `Unknown or unavailable model ${pythonRepr(pythonValueOf(model))}; choose one of ${names}`,
      );
    }
    console.modelsConfig.require(model);
    if (pythonTruth(console.taskRun.task) || console.taskRun.session !== null) {
      throw new ValueError("Clear the current task before changing models");
    }

    console.model = model;
  }

  /** Turns the recording of tasks on or off. */
  private setRecording(data: CommandData): void {
    const isEnabled = get(data, "enabled");
    if (typeof isEnabled !== "boolean") {
      throw new ValueError("Recording enabled must be a boolean");
    }

    this.console.recordings.isEnabled = isEnabled;
  }

  /** Starts recording the task and runs its turns on the worker. */
  private startRecordedLoop(): void {
    const console = this.console;
    const taskRun = console.taskRun;
    // replaced before the recording starts: a STOP while it starts sets the cancellation the worker is given
    const cancellation = (console.cancellation = new AbortController());

    try {
      if (taskRun.task === null) {
        throw new PythonTypeError("'NoneType' object is not iterable"); // (dict(task_run.task))
      }
      console.recordings.start({ ...taskRun.task }, console.cameraFeed, () => console.robot.status(true));
      console.launch((signal) => taskRun.run(signal), { cancellation, isRecorded: true });
    } catch (error) {
      console.recordings.stop("Task did not start");
      throw error;
    }
  }

  /** Returns the URL under which the page reads the file ``name`` of the task ``taskId``: the console's, if it
   * was given one, else PEAR's (RECORD_URL.format), as the task run does. */
  private recordUrl(taskId: string, name: string): string {
    const console = this.console;

    return console.recordUrl ? console.recordUrl(taskId, name) : recordUrl(taskId, name);
  }
}
