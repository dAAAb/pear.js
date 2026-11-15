// Ports pear/deploy/station/gui/console/task_run.py: TaskRun, the console's task, and RECORD_URL. Of
// pear/deploy/station/records/task_files.py it gives the names TaskRun writes its records under (SESSION_NAME, the
// three records of a turn, turn_record_path).
//
// PEAR's TaskRun holds its Console and reaches everything through it. Here it works over two interfaces:
// TaskConsole, exactly what TaskRun uses of the Console, and TaskRecords, what it uses of TaskFiles. A page has no
// folder: a record is handed to TaskRecords under the name of PEAR's file, and PEAR's JSON text of it (indent 2,
// ASCII escapes, no NaN, a newline at the end) belongs to whoever stores it.
//
// PEAR's console has one robot object, which the loop takes and of which TaskRun calls wait_settled, status and
// check_fault. In pear.js the loop takes an AgentRobot (the station's robot behind its AgentRobotAdapter), so the
// console gives both; TaskRun makes no hardware and no adapter.
//
// PEAR's run blocks the console's worker thread; here run is an async function, as the loop's step is. The
// operator's pause is an AbortSignal (PEAR: a threading.Event), functools.partial is a closure, time.time() and
// uuid4() are options, and `with console.lock` is nothing: a page has one thread, and nothing is awaited where PEAR
// holds the lock.

import { StationAgentLoop, type Turn } from "../agent/agent_loop";
import { ContextLimit, type ModelClient } from "../agent/clients/client";
import { ModelEvent, modelOutputRecord, type EventData, type ReferenceImage } from "../agent/clients/schemas";
import type { Clock, Sleep } from "../agent/clock";
import { uuid4 } from "../agent/messages";
import { resultRecord, type ActionFormat, type AgentRobot, type Awaitable } from "../agent/robot";
import { TurnEvent } from "../agent/schemas";
import { MotionStatus, type ModelState, type MotionResult, type SingleArmDelta } from "../protocol/types";
import {
  AttributeError,
  KeyError,
  pythonErrorMessage,
  pythonErrorName,
  PythonTypeError,
  RuntimeError,
} from "../python/errors";
import { formatTemplate } from "../python/format";
import { pythonTruth } from "../python/repr";
import { pythonStr } from "../python/str";
import { UnreachablePoseError } from "../so101/kinematics/errors";
import { OperatorPaused } from "../station/exceptions";
import { RobotStatus, type BriefStatus, type DetailedStatus } from "../station/schemas";
import { Phase, phaseOf } from "./phase";
import { TaskEventKind } from "./task_events";

/** Where PEAR's page service serves a file of a task's folder. */
export const RECORD_URL = "/api/records/{task_id}/{name}";

/** The record of a task's model session: episode, model, action format, system prompt (TaskFiles.SESSION_NAME). */
export const SESSION_NAME = "session.json";
// what a turn leaves, each as <attempt id>-<word>.json: what the model was shown, what it answered and what its
// action did (TaskFiles.OBSERVATION_RECORD, OUTPUT_RECORD, RESULT_RECORD)
export const OBSERVATION_RECORD = "observation";
export const OUTPUT_RECORD = "output";
export const RESULT_RECORD = "result";

/** Returns the name of one record of the turn ``attemptId``: its OBSERVATION_RECORD, OUTPUT_RECORD or
 * RESULT_RECORD (the file's name of TaskFiles.turn_record_path). */
export function turnRecordName(attemptId: string | null, record: string): string {
  return `${pythonStr(attemptId)}-${record}.json`;
}

/** Returns PEAR's URL of the file ``name`` of the task ``taskId``'s folder (RECORD_URL.format). */
export function recordUrl(taskId: string, name: string): string {
  return formatTemplate(RECORD_URL, { task_id: taskId, name });
}

/** A task's record, as PEAR's task.json holds it: id, instruction, model, images. */
export interface TaskRecord {
  id: string;
  instruction: string;
  /** The reference images the operator gave with the task: each one's file in the task's folder and the UUID a
   * model's service knows it by. */
  images?: ReadonlyArray<{ readonly file: string; readonly id: string }>;
  [key: string]: unknown;
}

/** What the page shows of the running or the last turn; an event of that turn carries these fields. */
export type ActiveTurn = {
  attempt: string;
  turn_number: number;
  /** Wall time, s. */
  started_at: number;
  episode_id: string;
  /** The word of a Phase. */
  phase: string;
};

/** One of the console's recent events, as far as TaskRun reads it. */
export interface ConsoleEvent {
  readonly type: string;
  readonly data: EventData;
}

/** What TaskRun calls of the station's robot (BaseRobot). A call may return its value or a promise of it. */
export interface TaskRobot {
  /** Waits for a stop or an action to end in a settled HOLD. */
  waitSettled(timeoutS: number): Awaitable<unknown>;
  /** Returns the robot's status with its control snapshot (status(with_snapshot=True)). */
  status(withSnapshot: true): Awaitable<DetailedStatus | BriefStatus>;
  /** Throws the fault the control loop has latched, with its diagnostics, if it has one. */
  checkFault(): Awaitable<void>;
}

/** What TaskRun uses of PEAR's Console, and no more. */
export interface TaskConsole<State = ModelState, Action = SingleArmDelta> {
  /** For a stopped or interrupted motion to settle, s (Console.SETTLE_TIMEOUT_S: 10.0). */
  readonly SETTLE_TIMEOUT_S: number;
  /** The station's robot. */
  readonly robot: TaskRobot;
  /** The same robot as the turn loop takes it: behind its AgentRobotAdapter. */
  readonly agentRobot: AgentRobot<State, Action>;
  /** The selected model, a name of the station's models. */
  readonly model: string;
  /** The action format the selected model answers in. */
  readonly actionFormat: ActionFormat<State, Action>;
  /** How long the selected model may take to answer a turn, s (models_config.models[model].timeout_s). */
  readonly modelTimeoutS: number;
  /** The latest timings of the running turn's request; TaskRun writes it, null at a turn's start. */
  performance: EventData | null;
  /** The recent events, kept for a browser that reconnects. */
  readonly events: Iterable<ConsoleEvent>;

  /** Returns a new client of ``model``, its system prompt the task ``instruction`` in the model's format. */
  newClient(model: string, instruction: string): ModelClient;
  /** Publishes one event and, when ``isSaved`` (by default true) and there is a task, keeps it with the task's
   * events. An event of the running turn carries the turn's fields: {...taskRun.activeTurn, ...data}. The console
   * keeps a copy of ``data``, as PEAR's does: a turn's first event is given the task run's own activeTurn, which
   * the run writes to afterwards. */
  emit(kind: string, data: EventData, options?: { isSaved?: boolean }): unknown;
  /** Shows ``phase``. */
  setPhase(phase: Phase): void;
  /** Returns the robot's status, the word of a RobotStatus such as OFF, READY or FAULT. */
  robotStatus(): Awaitable<string>;
  /** Returns the URL under which the page reads the file ``name`` of the task ``taskId``; without it, PEAR's
   * (recordUrl). */
  recordUrl?(taskId: string, name: string): string;
}

/** What TaskRun uses of PEAR's TaskFiles: the records of the tasks, each under the name of PEAR's file. */
export interface TaskRecords {
  /** Keeps ``value`` as the record ``name`` of the task ``taskId``, in place of an earlier one of that name
   * (TaskFiles.write_json(root / taskId / name, value)). It returns once the record is kept and throws when it
   * cannot be: PEAR writes the file before the event that names it. */
  writeJson(taskId: string, name: string, value: EventData): void;
  /** Returns the bytes of the file ``name`` of the task ``taskId``: a reference image the operator gave with the
   * task (PEAR: the path root / taskId / name, which a client reads). */
  readFile(taskId: string, name: string): Uint8Array;
}

/** What a task run is made with, beside its console and its records. */
export interface TaskRunOptions {
  /** The wall clock, in seconds since the epoch (time.time()); by default the machine's. */
  wallClock?: () => number;
  /** What gives the UUID an attempt id is made of (uuid4()); by default a random UUID. */
  uuid?: () => string;
  /** What a session's loop is made with beside PEAR's arguments: its UUIDs, its monotonic clock and its waits; by
   * default the loop's own. */
  loop?: { uuid?: () => string; clock?: Clock; sleep?: Sleep };
}

/** The code of a result's error when offline IK refused the action: the name of the Python class
 * (UnreachablePoseError.__name__), read from the port's class. */
const UNREACHABLE_CODE = pythonErrorName(new UnreachablePoseError(""));

/** Whether ``error`` is PEAR's OperatorPaused, of the station's module or under that name from another one (as the
 * loop tells it). */
function isOperatorPaused(error: unknown): boolean {
  return error instanceof OperatorPaused || pythonErrorName(error) === "OperatorPaused";
}

/** Python's truth of a dict that may be None: whether there is one and it holds a key. */
function isFilled<Value extends object>(value: Value | null | undefined): value is Value {
  return pythonTruth(value);
}

/** Returns the last part of ``path`` (pathlib's Path(path).name on PEAR's Linux). */
function fileName(path: string): string {
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");

  return parts[parts.length - 1] ?? "";
}

/**
 * The console's task: its record, its model session and its turns, which run one after another, each with its
 * records and events.
 */
export class TaskRun<State = ModelState, Action = SingleArmDelta> {
  /** Consecutive pre-dispatch IK rejections retried with a fresh observation before pausing. */
  static readonly UNREACHABLE_RETRIES = 5;
  /** Shown when an unreachable action is asked for again. */
  static readonly RETRY_NOTICE = "IK rejected before motion. Requesting a fresh action ({retry}/{retries}).";
  /** Hex characters of an attempt id, unique within a task. */
  static readonly ATTEMPT_ID_CHARS = 12;
  /** Events whose final value outlives a cancelled turn. */
  static readonly STATISTICS_EVENTS: readonly string[] = [ModelEvent.USAGE, ModelEvent.PERFORMANCE];
  /** A result's status -> the phase its turn ends in. */
  static readonly OUTCOME_PHASES: Readonly<Record<MotionStatus, Phase>> = {
    [MotionStatus.COMPLETED]: Phase.COMPLETED,
    [MotionStatus.REJECTED]: Phase.REJECTED,
    [MotionStatus.FAILED]: Phase.FAILED,
  };
  /** The event of a run that continues after an action did not complete. */
  static readonly RESUME_CONTEXT_EVENT = "resume_context";
  /** The event of a turn that the operator paused after its model request. */
  static readonly INTERRUPTED_EVENT = "interrupted";

  /** The task's record (id, instruction, model, images); null without a task. */
  task: TaskRecord | null = null;
  /** The model session's client; null before it is made. */
  modelClient: ModelClient | null = null;
  /** The model session; null before it starts and once it ended. */
  session: StationAgentLoop<State, Action> | null = null;
  /** The actions that completed and settled. */
  totalSteps = 0;
  /** Of the latest turn. */
  turnNumber = 0;
  /** Of the running or the last turn. */
  activeAttemptId: string | null = null;
  /** What the page shows of that turn. */
  activeTurn: ActiveTurn | null = null;
  /** Whether an action did not complete, so the next run reports what happened. */
  resumePending = false;
  /** Wall time at which the model began on the latest turn. */
  inferenceStartedAt: number | null = null;

  private readonly wallClock: () => number;
  private readonly uuid: () => string;
  private readonly loopOptions: { uuid?: () => string; clock?: Clock; sleep?: Sleep };

  constructor(
    readonly console: TaskConsole<State, Action>,
    /** The tasks' records (PEAR: the folders under console.root). */
    readonly records: TaskRecords,
    options: TaskRunOptions = {},
  ) {
    this.wallClock = options.wallClock ?? (() => Date.now() / 1000);
    this.uuid = options.uuid ?? uuid4;
    const loop = options.loop ?? {};
    this.loopOptions = {
      ...(loop.uuid !== undefined ? { uuid: loop.uuid } : {}),
      ...(loop.clock !== undefined ? { clock: loop.clock } : {}),
      ...(loop.sleep !== undefined ? { sleep: loop.sleep } : {}),
    };
  }

  /** Runs turns until the operator pauses, an action does not complete, or the model session ends. */
  async run(cancellation: AbortSignal): Promise<void> {
    const console = this.console;
    let retries = 0; // of consecutive actions offline IK rejected
    let isUnfinished = false;
    let turnBeforeStep: Turn | null = null;

    try {
      if (this.session !== null && this.resumePending) {
        await this.resumeFailedTurn();
      }
      if (this.session === null) {
        this.newSession();
      }

      for (;;) {
        OperatorPaused.checkCancelled(cancellation);
        const attemptId = this.startTurn();
        isUnfinished = true;
        turnBeforeStep = this.requireSession("last_turn").lastTurn;

        const result = await this.requireSession("step").step({
          cancellation,
          onEvent: (kind, data) => this.onEvent(cancellation, attemptId, kind, data),
          attemptId,
        });
        OperatorPaused.checkCancelled(cancellation);

        this.saveExecutionResult(result);
        isUnfinished = false;

        if (TaskRun.isUnreachable(result) && retries < TaskRun.UNREACHABLE_RETRIES) {
          retries += 1;
          const message = formatTemplate(TaskRun.RETRY_NOTICE, {
            retry: pythonStr(retries),
            retries: pythonStr(TaskRun.UNREACHABLE_RETRIES),
          });
          console.emit(ModelEvent.NOTICE, { attempt: attemptId, retry: retries, message });
          continue;
        }

        if (result.status !== MotionStatus.COMPLETED || !result.isSettled) {
          // a local motion or planning failure keeps the model's history: the actual result is reported after a
          // manual resume
          this.resumePending = true;
          throw new RuntimeError(
            isFilled(result.error)
              ? pythonStr((result.error as { message?: string | null }).message ?? null)
              : "Action did not complete and settle",
          );
        }

        retries = 0;
        this.totalSteps += 1;
      }
    } catch (error) {
      const failure = isUnfinished ? await this.reconcileFault(error, turnBeforeStep) : error;
      await this.endTurn(failure, isUnfinished);
      // (raise failure from None)
      throw failure;
    }
  }

  /** Starts the task's model session with a new client, and records it; refused while a session exists. */
  newSession(): void {
    const console = this.console;
    if (this.session !== null) {
      throw new RuntimeError("Clear the existing episode before creating another");
    }

    const task = this.requireTask();
    this.modelClient = console.newClient(console.model, task.instruction);
    const session = new StationAgentLoop(console.agentRobot, this.modelClient, {
      actionFormat: console.actionFormat,
      timeoutS: console.modelTimeoutS,
      // (in PEAR, the path of each image's file in the task's folder; here the file's bytes)
      referenceImages: (task.images ?? []).map(
        (image): ReferenceImage => ({
          bytes: this.records.readFile(task.id, image.file),
          uuid: image.id,
          name: image.file,
        }),
      ),
      ...this.loopOptions,
    });
    this.session = session;
    this.resumePending = false;

    const sessionRecord = {
      episode_id: session.episodeId,
      model: console.model,
      action_format: console.actionFormat.name,
      system_prompt: this.modelClient.systemPrompt,
    };
    this.writeRecord(SESSION_NAME, sessionRecord);
    const sessionStarted = { episode_id: session.episodeId, message: "Model session started" };
    console.emit(TaskEventKind.SESSION, sessionStarted);
  }

  /** Publishes one event of the turn ``attemptId`` while it is the active turn; a cancelled turn publishes only
   * its final statistics. */
  onEvent(cancellation: AbortSignal, attemptId: string, kind: ModelEvent | TurnEvent, data: EventData): void {
    const console = this.console;
    if (attemptId !== this.activeAttemptId) {
      return;
    }
    if (cancellation.aborted && !(TaskRun.STATISTICS_EVENTS.includes(kind) && data["final"] === true)) {
      return;
    }

    if (kind === ModelEvent.PERFORMANCE) {
      console.performance = { ...data, attempt: attemptId, received_at: this.wallClock() };
      console.emit(kind, { ...data, attempt: attemptId }, { isSaved: pythonTruth(data["final"]) });
      return;
    }
    if (kind === ModelEvent.USAGE) {
      // (data.get("final", True): a report that does not say whether it is final is saved)
      const isSaved = "final" in data ? pythonTruth(data["final"]) : true;
      console.emit(kind, { ...data, attempt: attemptId }, { isSaved });
      return;
    }

    if (kind === ModelEvent.PHASE) {
      if (!("phase" in data)) {
        throw new KeyError("'phase'");
      }
      const phase = phaseOf(data["phase"]);
      console.setPhase(phase);
      if (phase === Phase.THINKING && this.inferenceStartedAt === null) {
        this.inferenceStartedAt = this.wallClock();
      }
      if (isFilled(this.activeTurn)) {
        this.activeTurn.phase = phase;
      }
    } else if (kind === TurnEvent.OBSERVATION) {
      const taskId = this.requireTask().id;
      const observationName = turnRecordName(attemptId, OBSERVATION_RECORD);
      this.writeRecord(observationName, data);
      const urlOf = (name: string): string =>
        console.recordUrl ? console.recordUrl(taskId, name) : recordUrl(taskId, name);
      const detailsUrl = urlOf(observationName);
      if (!("images" in data)) {
        throw new KeyError("'images'");
      }
      // (in PEAR an image is the path of the frame's file; the port's loop gives the file's name)
      const imageUrls = Object.fromEntries(
        Object.entries(data["images"] as Record<string, unknown>).map(([cameraName, path]) => [
          cameraName,
          urlOf(fileName(String(path))),
        ]),
      );
      data = { ...data, details_url: detailsUrl, images: imageUrls };
    } else if (kind === TurnEvent.MODEL_OUTPUT) {
      this.writeRecord(turnRecordName(attemptId, OUTPUT_RECORD), data);
    }
    console.emit(kind, { ...data, attempt: attemptId });
  }

  /** Ends the model session, or closes a client that never started one; a cleanup that fails blocks the
   * session. */
  async closeSession(): Promise<void> {
    const session = this.session;
    if (session !== null) {
      try {
        await session.close();
      } catch (error) {
        session.blockedReason = "Model cleanup incomplete: " + pythonErrorMessage(error);
        throw error;
      }
    } else if (this.modelClient !== null) {
      await this.modelClient.close();
    }

    this.session = this.modelClient = null;
  }

  /** Continues a session whose last action did not complete, with a fresh observation of what happened. */
  private async resumeFailedTurn(): Promise<void> {
    const console = this.console;
    await console.robot.waitSettled(console.SETTLE_TIMEOUT_S);
    const session = this.requireSession("blocked_reason");
    if (session.blockedReason) {
      throw new ContextLimit(session.blockedReason);
    }

    this.resumePending = false;
    const resumeContext = {
      episode_id: session.episodeId,
      message: "Continuing with a fresh observation and actual execution feedback",
    };
    console.emit(TaskRun.RESUME_CONTEXT_EVENT, resumeContext);
  }

  /** Opens the next turn under a new attempt id, which the turn's events carry, and returns the id. */
  private startTurn(): string {
    const console = this.console;
    // (uuid4().hex: the UUID without its dashes)
    const attemptId = this.uuid().replace(/-/g, "").slice(0, TaskRun.ATTEMPT_ID_CHARS);
    this.activeAttemptId = attemptId;
    console.performance = null;
    this.inferenceStartedAt = null;
    this.turnNumber += 1;

    const startedAt = this.wallClock();
    this.activeTurn = {
      attempt: attemptId,
      turn_number: this.turnNumber,
      started_at: startedAt,
      episode_id: this.requireSession("episode_id").episodeId,
      phase: Phase.OBSERVING,
    };
    console.emit(TaskEventKind.TURN_STARTED, this.activeTurn);

    return attemptId;
  }

  /** Records what the active turn's action did, beside the model's output that asked for it. */
  private saveExecutionResult(result: MotionResult): void {
    const attemptId = this.activeAttemptId;
    const lastTurn = this.requireSession("last_turn").lastTurn;
    if (lastTurn === null) {
      // (what Python raises of a session that has observed no turn yet)
      throw new AttributeError("'NoneType' object has no attribute 'model_output'");
    }
    if (lastTurn.modelOutput !== null) {
      this.writeRecord(turnRecordName(attemptId, OUTPUT_RECORD), modelOutputRecord(lastTurn.modelOutput));
    }

    const record = resultRecord(result);
    this.writeRecord(turnRecordName(attemptId, RESULT_RECORD), {
      turn_id: attemptId,
      dispatched: lastTurn.isDispatched,
      ...record,
    });
    this.setTurnPhase(TaskRun.OUTCOME_PHASES[result.status]);
    this.console.emit(TaskEventKind.EXECUTION, { attempt: attemptId, ...record });
  }

  /** Records a robot fault that ended an unfinished turn; the fault replaces ``error`` as the turn's failure,
   * which this returns. */
  private async reconcileFault(error: unknown, turnBeforeStep: Turn | null): Promise<unknown> {
    const console = this.console;
    const robotState = await console.robot.status(true);
    if (!isFilled(this.activeTurn) || robotState.status !== RobotStatus.FAULT) {
      return error;
    }

    // the watchdog's cancellation still blocks inference and dispatch; the latched fault is reconciled here,
    // without a cancellable event callback or a wait for HOLD, which a faulted control loop never reaches
    let failure = error;
    try {
      await console.robot.checkFault();
    } catch (fault) {
      failure = fault;
    }
    const session = this.requireSession("last_turn");
    const lastTurn = session.lastTurn;
    if (lastTurn !== null && lastTurn !== turnBeforeStep) {
      const result = session.record(await session.failureResult(failure, { snapshot: robotState }));
      this.saveExecutionResult(result);
      this.resumePending = true;
    }

    // (getattr(failure, "details", None))
    const details = (failure as { details?: unknown } | null | undefined)?.details ?? null;
    // a diagnostic the turn already published, found among the events kept for browsers, is not sent again
    // (PEAR holds the console's lock over the look and the event; a page has one thread, and nothing is awaited
    // between them)
    if (isRecord(details) && pythonTruth(details) && !this.isPublished(details)) {
      console.emit(TurnEvent.DIAGNOSTIC, { ...details, attempt: this.activeAttemptId });
    }

    return failure;
  }

  /** Closes the active turn after ``failure`` ended the run. */
  private async endTurn(failure: unknown, isUnfinished: boolean): Promise<void> {
    const console = this.console;
    if (isOperatorPaused(failure)) {
      if (isUnfinished && isFilled(this.activeTurn)) {
        this.activeTurn.phase = Phase.INTERRUPTED;
        const turnEndData = { attempt: this.activeAttemptId, phase: Phase.INTERRUPTED };
        console.emit(TaskEventKind.TURN_END, turnEndData);
        await this.recordInterruption();
      }
    } else if (isFilled(this.activeTurn)) {
      const phase = failure instanceof ContextLimit ? Phase.CONTEXT_LIMIT : Phase.FAILED;
      this.activeTurn.phase = phase;
      const turnEndData = { attempt: this.activeAttemptId, phase, message: pythonErrorMessage(failure) };
      console.emit(TaskEventKind.TURN_END, turnEndData, { isSaved: false });
    }
  }

  /** Records an operator's pause of a turn whose model request was made, as the turn's failed result. */
  private async recordInterruption(): Promise<void> {
    const console = this.console;
    const session = this.session;
    if (session === null || session.lastTurn === null || session.lastTurn.attemptId !== this.activeAttemptId) {
      return;
    }

    if ((await console.robotStatus()) !== RobotStatus.FAULT) {
      await console.robot.waitSettled(console.SETTLE_TIMEOUT_S);
    }
    const interruptedResult = await session.failureResult(
      new OperatorPaused("The operator interrupted this turn; remaining motion was cancelled."),
    );
    this.saveExecutionResult(session.record(interruptedResult));

    this.setTurnPhase(Phase.INTERRUPTED);
    const interrupted = {
      message: "Step interrupted; remaining action will not execute.",
      attempt: this.activeAttemptId,
      session_retained: !session.blockedReason,
    };
    console.emit(TaskRun.INTERRUPTED_EVENT, interrupted);
  }

  /** Whether offline IK rejected the action before any motion. */
  private static isUnreachable(result: MotionResult): boolean {
    return (
      result.status === MotionStatus.REJECTED &&
      result.isSettled &&
      isFilled(result.error) &&
      ((result.error as { code?: unknown }).code ?? null) === UNREACHABLE_CODE
    );
  }

  /** Whether the active turn has published a diagnostic of the code of ``details``, by the console's recent
   * events. */
  private isPublished(details: Record<string, unknown>): boolean {
    for (const event of this.console.events) {
      if (event.type === TurnEvent.DIAGNOSTIC && (event.data["attempt"] ?? null) === this.activeAttemptId) {
        if (!("code" in details)) {
          throw new KeyError("'code'");
        }
        if ((event.data["code"] ?? null) === details["code"]) {
          return true;
        }
      }
    }

    return false;
  }

  /** Keeps ``value`` as the record ``name`` of the task (TaskFiles.write_json(self.files...)). */
  private writeRecord(name: string, value: EventData): void {
    this.records.writeJson(this.requireTask().id, name, value);
  }

  /** Sets the phase the page shows of the active turn (self.active_turn["phase"] = ...). */
  private setTurnPhase(phase: Phase): void {
    if (this.activeTurn === null) {
      throw new PythonTypeError("'NoneType' object does not support item assignment");
    }
    this.activeTurn.phase = phase;
  }

  /** Returns the task's record; throws what Python raises of ``self.task[...]`` without a task. */
  private requireTask(): TaskRecord {
    if (this.task === null) {
      throw new PythonTypeError("'NoneType' object is not subscriptable");
    }

    return this.task;
  }

  /** Returns the session; throws what Python raises of ``self.session.<attribute>`` without a session. */
  private requireSession(attribute: string): StationAgentLoop<State, Action> {
    if (this.session === null) {
      throw new AttributeError(`'NoneType' object has no attribute '${attribute}'`);
    }

    return this.session;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
