// The rig of the console's task run: what a replay of tests/fixtures/console/task_run.json.gz needs on top of the
// station's rig (tests/station-robot/rig.ts: pear.js's own SO101Robot on the stepped stand-in arm, the recording
// clock). The fixture is PEAR's own TaskRun, run by PEAR's Python through scripted scenarios
// (tools/fixtures/console_fixtures.py, whose docstring gives the record's format).
//
// StandInConsole is a stand-in: PEAR's Console (pear/deploy/station/gui/console/console.py) is not ported. It
// implements the port's TaskConsole with what PEAR's emit, set_phase, stop, robot_status and new_client do, line
// for line, and is to be replaced by the port of console.py when there is one. Its records are kept in memory
// under the names of PEAR's files (MemoryRecords).
//
// One thread. PEAR's console has the run's thread, the model's (one a request) and the operator's; the fixture
// pins one order of them. Here everything awaits on one thread:
//   - a model's operations run inside the client's request and are waited for there, as in the capstone test;
//   - a hook acts inside emit, which TaskRun does not await. What PEAR's thread does there in full, the rig can
//     only start: the robot's stop is called (the control loop takes it when it has its lock), a sleep of the
//     stand-in clock advances the time and starts the control loop's step. What was started is awaited before the
//     next call of the robot begins and when the run has ended (ConsoleRig.settled);
//   - a hook with `after_sleeps` acts inside a sleep of the clock, which is awaited, so it is waited for there.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import type { ModelClient } from "../../src/agent/clients/client";
import { modelOutput, type EventData, type EventHandler, type ModelInput, type ModelOutput } from "../../src/agent/clients/schemas";
import { sleep as timerSleep } from "../../src/agent/clock";
import { ModelsConfig, OfferedModel } from "../../src/agent/config";
import { SINGLE_ARM_POSE_FORMAT } from "../../src/agent/formats";
import { resultRecord, type ActionFormat, type ActionPhase, type AgentRobot, type ControlSnapshot, type Observation } from "../../src/agent/robot";
import { Phase } from "../../src/console/phase";
import { OBSERVATION_RECORD, TaskRun, type TaskConsole, type TaskRecord, type TaskRecords, type TaskRobot } from "../../src/console/task_run";
import { systemPrompt } from "../../src/protocol/index";
import type { ModelState, MotionResult, MotionStatus, SingleArmDelta } from "../../src/protocol/types";
import { isValueError, pythonErrorMessage, pythonErrorName, RuntimeError } from "../../src/python/errors";
import { pythonTruth } from "../../src/python/repr";
import { SO101Robot } from "../../src/so101/robot";
import { AgentRobotAdapter } from "../../src/station/robot";
import type { BriefStatus, DetailedStatus } from "../../src/station/schemas";
import { frameBytes, makeError, ScriptedClient, type ErrorSpec } from "../agent/stand_ins";
import { plain } from "../station-loop/compare";
import { replaced, type StandInSO101Driver } from "../station-loop/standins";
import { loadFixture as loadStationFixture, stationOf, type Outcome } from "../station-robot/fixtures";
import { RecordingClock, StandInCameras, SteppedStandInSO101Robot, type DrawnFrame, type KinematicsRecord, type RigHooks } from "../station-robot/rig";

/** The longest a script waits, on the machine's clock, for the loop (WAIT_S of the fixture script), s. */
const WAIT_S = 20.0;
/** PEAR's configuration by the name the console's fixture gives (ConfigFiles.load("so101"), no overrides) -> the
 * station of tests/fixtures/station-robot that holds it (tools/fixtures/robot_fixtures.py: "so101_station"). */
export const STATIONS: Readonly<Record<string, string>> = { so101: "so101_station" };
/** The file of a task's saved events (TaskFiles.events_path). */
export const EVENTS_NAME = "events.jsonl";

// ---- the fixture ----

/** An event as Console.emit makes it. */
export interface PublishedEvent {
  id: number;
  type: string;
  data: EventData;
  time: number;
  monotonic_s: number;
  task_id: string | null;
}

/** An event of a record: as emit made it, and whether the task's events.jsonl holds it. */
export interface RecordedEvent extends PublishedEvent {
  saved: boolean;
}

/** One operation of a model's turn or of a hook (the docstring of the fixture script). */
export interface ScriptOperation {
  emit?: [string, EventData];
  return?: { answer: string; reasoning: string; reasoning_kind: string; usage: EventData };
  raise?: ErrorSpec;
  do?: string;
  seconds?: number;
  times?: number;
  message?: string;
  /** Of "move_arm": the joint that is pushed, how far (rad) and the velocity its readings show from then on. */
  joint?: number;
  offset?: number;
  velocity?: number;
  then?: ScriptOperation[];
}

/** What acts once, when emit is given the first event of a type. */
export interface ScriptHook extends ScriptOperation {
  on: string;
  phase?: string;
  turn?: number;
  after_sleeps?: number;
}

/** The calls a scenario makes: TaskRun.run, and the others of the fixture script's docstring. */
export type CallOp = "run" | "new_session" | "close_session" | "new_client" | "start_turn" | "on_event";

export interface CallScript {
  op: CallOp;
  /** Of a "run": the model's requests in order (none when the model is not asked) and the hooks. */
  turns?: Array<{ model: ScriptOperation[] }>;
  hooks?: ScriptHook[];
  /** Of a "close_session": what the client's close() raises during the call, in the place of closing. */
  close_raises?: ErrorSpec;
  /** Of an "on_event": the attempt ("active": TaskRun's active one at the call), whether the call's cancellation
   * is set, the event's kind (the value of a ModelEvent or of a TurnEvent) and its data. */
  attempt?: string;
  cancelled?: boolean;
  kind?: string;
  data?: EventData;
}

/** What a new session was given (a "new_session" that did not raise), in the port's terms: PEAR's `directory`
 * has no counterpart (the port's loop is given no folder), and an image's path is the name of its file. */
export interface SessionGiven {
  robot_is_the_consoles: boolean;
  client_is_the_task_runs: boolean;
  action_format: string;
  timeout_s: number;
  reference_images: Array<{ path: string; uuid: string }>;
  episode_id: string;
}

/** The UUIDs drawn: by TaskRun (attempt ids), by the session's loop and by the robot. */
export interface Ids {
  task_run: string[];
  session: string[];
  robot: string[];
}

/** A call of the robot as a record keeps it: its name, the last event published when it began, what it was given
 * and what it returned or raised. */
export interface RobotCall {
  call: string;
  after_event: number;
  [field: string]: unknown;
}

export interface RecordedInput {
  text: string;
  images: Array<{ camera_name: string; uuid: string; name: string; is_jpeg: boolean }>;
  reference_images: string[];
}

/** A file of the task's folder after a call. */
export interface RecordedFile {
  name: string;
  json?: unknown;
  event_ids?: number[];
  size?: number;
  sha256?: string;
  unchanged?: true;
}

/** What a call left, as the fixture records it of PEAR and the rig of the port. */
export interface CallRecord {
  raised: { type: string; message: string } | null;
  events: RecordedEvent[];
  phases: string[];
  phase: string;
  files: RecordedFile[];
  task_run: Record<string, unknown>;
  session: Record<string, unknown> | null;
  performance: EventData | null;
  robot_status: string;
  robot: RobotCall[];
  model_inputs: RecordedInput[];
  ids: Ids;
  clock: { sleeps: number; monotonic_s: number; wall_readings: number };
  /** A "new_session" only: null when it raised, else what the new session was given. */
  session_given?: SessionGiven | null;
  /** A "close_session" only: null when TaskRun had no client before the call, else how often the client's
   * cancel() and close() were called during it from outside the client. */
  client?: { cancelled: number; closed: number } | null;
}

export interface RecordedCall extends CallRecord {
  op: CallOp;
  script: CallScript;
}

export interface RecordedScenario {
  name: string;
  pins: string;
  task: TaskRecord;
  robot_session_id: string;
  control_period_s: number;
  model_timeout_s: number;
  ids_before: Ids;
  sleeps_before: number;
  monotonic_s_before: number;
  calls: RecordedCall[];
}

export interface FixtureMeta {
  pear_commit: string;
  station: string;
  model: string;
  root: string;
  start_s: number;
  wall_start_s: number;
  wall_step_s: number;
  constants: Record<string, Record<string, unknown>>;
}

export interface ConsoleFixture {
  meta: FixtureMeta;
  scenarios: RecordedScenario[];
}

/** Returns tests/fixtures/console/task_run.json.gz. */
export function loadConsoleFixture(): ConsoleFixture {
  const path = fileURLToPath(new URL("../fixtures/console/task_run.json.gz", import.meta.url));

  return JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as ConsoleFixture;
}

/**
 * PEAR's kinematics' answers by what they were asked (the joints and the arm's delta, as their JSON text), from
 * the records of the turn loop's tasks (tests/fixtures/station-robot/agent_rig.json.gz). pear.js's kinematics do
 * not give PEAR's doubles, and the console's fixture records no answers: a question PEAR was asked there with
 * the same numbers is answered as PEAR answered it.
 */
const KINEMATICS: ReadonlyMap<string, Outcome<number[]>> = (() => {
  type Piece = { ik?: KinematicsRecord[] };
  const record = loadStationFixture<{ scenarios: Array<{ open: Piece; steps: Piece[]; close: Piece }> }>("agent_rig.json.gz");
  const answers = new Map<string, Outcome<number[]>>();
  for (const scenario of record.scenarios) {
    for (const piece of [scenario.open, ...scenario.steps, scenario.close]) {
      for (const asked of piece.ik ?? []) {
        answers.set(JSON.stringify([asked.joints, asked.delta]), asked.out);
      }
    }
  }

  return answers;
})();

// ---- the records ----

/** A task's records in memory, under the names of PEAR's files: what TaskRun writes (TaskRecords), and the events
 * the console saves. */
export class MemoryRecords implements TaskRecords {
  private readonly folders = new Map<string, Map<string, unknown>>();
  private readonly saved = new Map<string, PublishedEvent[]>();
  /** The files an operator gave with a task (reference images), by task and name. */
  readonly given = new Map<string, Map<string, Uint8Array>>();

  writeJson(taskId: string, name: string, value: EventData): void {
    let folder = this.folders.get(taskId);
    if (folder === undefined) {
      folder = new Map();
      this.folders.set(taskId, folder);
    }
    // (PEAR writes the text now: what is written to the value afterwards is not in the file)
    folder.set(name, structuredClone(value));
  }

  readFile(taskId: string, name: string): Uint8Array {
    const bytes = this.given.get(taskId)?.get(name);
    if (bytes === undefined) {
      throw new RuntimeError(`The task ${taskId} was given no file ${name}`);
    }

    return bytes;
  }

  /** Adds a line to the task's events.jsonl (TaskEvents.append). */
  appendEvent(taskId: string, event: PublishedEvent): void {
    const events = this.saved.get(taskId) ?? [];
    events.push(structuredClone(event));
    this.saved.set(taskId, events);
  }

  /** The files PEAR's folder of the task would hold, in the order of their names: a record with its JSON value,
   * events.jsonl with the ids of its lines, and each frame by its name alone. The port's loop writes no frame: a
   * frame's name is what an observation's record, or a turn's model input (``frames``), calls it. */
  files(taskId: string, frames: readonly string[] = []): RecordedFile[] {
    const files: RecordedFile[] = [];
    const names = new Set<string>(frames);
    for (const [name, json] of this.folders.get(taskId) ?? []) {
      files.push({ name, json });
      if (name.endsWith(`-${OBSERVATION_RECORD}.json`)) {
        for (const frame of Object.values((json as { images?: Record<string, string> }).images ?? {})) {
          names.add(frame);
        }
      }
    }
    for (const name of names) {
      // (an image an on_event by itself was given under a folder is its caller's: the loop wrote no such frame)
      if (!name.includes("/")) {
        files.push({ name });
      }
    }
    for (const [name, bytes] of this.given.get(taskId) ?? []) {
      files.push({ name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    const events = this.saved.get(taskId);
    if (events !== undefined) {
      files.push({ name: EVENTS_NAME, event_ids: events.map((event) => event.id) });
    }

    return files.sort((first, second) => (first.name < second.name ? -1 : first.name > second.name ? 1 : 0));
  }
}

// ---- the robot ----

/** What a record keeps of an error a call of the robot raised (`error_record` of tools/fixtures/agent_fixtures.py,
 * as far as the port can give it: the class's name, the message, whether it is a ValueError, what it recorded). */
export function raisedRecord(error: unknown): Record<string, unknown> {
  const record: Record<string, unknown> = {
    type: pythonErrorName(error),
    message: pythonErrorMessage(error),
    is_value_error: isValueError(error),
  };
  const details = (error as { details?: unknown } | null)?.details;
  if (details !== undefined && details !== null && Object.keys(details as object).length > 0) {
    record["details"] = plain(details);
  }

  return record;
}

/** What the traced robot needs of the rig. */
interface CallContext {
  /** The id of the last event the console published. */
  lastEventId(): number;
  /** Whether nothing that a hook started inside an emit is still under way. */
  isSettled(): boolean;
  /** Resolves when what the hooks started has ended. */
  settled(): Promise<void>;
  /** Whether a hook is acting: in PEAR, on the run's thread. */
  isHookActing(): boolean;
}

/**
 * PEAR's one robot object as the port has it, in two faces: what the turn loop drives (the AgentRobotAdapter) and
 * what TaskRun and the console call of the station's robot. Every call from outside joins the record as it ends,
 * with what it was given and what it returned or threw (the wrapper of the fixture script, in LoopRun's format);
 * is_holding is only counted.
 */
export class TracedRobot implements AgentRobot<ModelState, SingleArmDelta>, TaskRobot {
  /** The calls of the running call of the script, in the order they ended. */
  calls: RobotCall[] = [];
  /** How often the loop has asked whether the arm holds since the model was last asked. */
  holdCalls = 0;
  /** The recorded calls under way. */
  private depth = 0;

  constructor(
    private readonly robot: SteppedStandInSO101Robot,
    private readonly adapter: AgentRobotAdapter<ModelState, SingleArmDelta, DrawnFrame | Uint8Array>,
    private readonly context: CallContext,
  ) {}

  get actionMode(): string {
    return this.adapter.actionMode;
  }
  get sessionId(): string | null {
    return this.adapter.sessionId;
  }
  get controlPeriodS(): number {
    return this.adapter.controlPeriodS;
  }
  get lastErrorDiagnostics(): EventData | null {
    return this.adapter.lastErrorDiagnostics as EventData | null;
  }

  private async logged<Value>(
    name: string,
    given: Record<string, unknown>,
    call: () => Value | Promise<Value>,
    returned: (value: Value) => Record<string, unknown>,
  ): Promise<Value> {
    if (this.depth > 0 && this.context.isHookActing()) {
      // the fixture script's wrapper tells a call the robot makes of itself by its thread: a call made on the run's
      // thread while another call of the robot is under way (an operator's stop from a hook that acts inside a
      // sleep of execute) is taken for one and is not in the record
      return call();
    }
    const entry: RobotCall = { call: name, after_event: this.context.lastEventId(), ...given };
    if (!this.context.isSettled()) {
      await this.context.settled(); // (what a hook started inside an emit has ended in PEAR before the next call)
    }
    this.depth += 1;
    try {
      let value: Value;
      try {
        value = await call();
      } catch (error) {
        entry["raised"] = raisedRecord(error);
        throw error;
      }
      Object.assign(entry, returned(value));
      return value;
    } finally {
      this.depth -= 1;
      this.calls.push(entry);
    }
  }

  waitStationary(observation?: Observation | null, options?: { cancellation?: AbortSignal | null }): Promise<ControlSnapshot> {
    const given = { observation: observation?.observationId ?? null, cancellation: (options?.cancellation ?? null) !== null };
    return this.logged("wait_stationary", given, () => this.adapter.waitStationary(observation ?? null, options ?? {}), () => ({}));
  }

  observe(): Promise<Observation> {
    return this.logged("observe", {}, () => this.adapter.observe(), (value) => ({
      returned: {
        observation_id: value.observationId,
        session_id: value.sessionId,
        captured_monotonic_s: value.capturedMonotonicS,
        joint_positions: [...value.jointPositions],
        camera_timestamps: Object.fromEntries(
          Object.entries(value.cameraTimestamps).map(([role, stamps]) => [
            role,
            { received_monotonic_s: stamps.receivedMonotonicS, frame_number: stamps.frameNumber },
          ]),
        ),
        image_roles: Object.keys(value.images).sort(),
      },
    }));
  }

  modelState(jointPositions: readonly number[], formatName: string): Promise<ModelState> {
    const given = { joint_positions: [...jointPositions], format_name: formatName };
    return this.logged("model_state", given, () => this.adapter.modelState(jointPositions, formatName), (value) => ({ returned: plain(value) }));
  }

  isHolding(observation: Observation): boolean {
    this.holdCalls += 1;
    return this.adapter.isHolding(observation);
  }

  stop(): Promise<void> {
    return this.logged("stop", {}, () => this.adapter.stop(), () => ({}));
  }

  execute(
    action: SingleArmDelta,
    options: {
      referenceObservation?: Observation | null;
      cancellation?: AbortSignal | null;
      reportProgress?: ((phase: ActionPhase) => void) | null;
    },
  ): Promise<MotionResult> {
    const progress: string[] = [];
    const given = {
      action: plain(action),
      reference: options.referenceObservation!.observationId,
      cancellation: (options.cancellation ?? null) !== null,
      progress,
    };
    const reportProgress = options.reportProgress!;
    const report = (phase: ActionPhase): void => {
      progress.push(phase);
      return reportProgress(phase); // (what the loop's handler returns goes back to the robot, which waits for it)
    };
    return this.logged(
      "execute",
      given,
      () => this.adapter.execute(action, { ...options, reportProgress: report }),
      (value) => ({ returned: resultRecord(value), diagnostics: plain(this.adapter.lastErrorDiagnostics) }),
    );
  }

  failureResult(
    error: unknown,
    options: { formatName: string; status?: MotionStatus; snapshot?: ControlSnapshot | null },
  ): Promise<MotionResult> {
    const given = {
      error: { type: pythonErrorName(error), message: pythonErrorMessage(error) },
      format_name: options.formatName,
      status: options.status ?? null,
      snapshot: (options.snapshot ?? null) !== null,
    };
    return this.logged("failure_result", given, () => this.adapter.failureResult(error, options), (value) => ({ returned: resultRecord(value) }));
  }

  // what TaskRun and the console call of the station's robot

  waitSettled(timeoutS: number): Promise<unknown> {
    return this.logged("wait_settled", { timeout_s: timeoutS }, () => this.robot.waitSettled(timeoutS), () => ({}));
  }

  status(withSnapshot = false): Promise<DetailedStatus | BriefStatus> {
    return this.logged(
      "status",
      { with_snapshot: withSnapshot },
      () => (withSnapshot ? this.robot.status(true) : this.robot.status()),
      (value) => ({ returned: value.status }),
    );
  }

  checkFault(): Promise<void> {
    return this.logged("check_fault", {}, () => this.robot.checkFault(), () => ({}));
  }
}

// ---- the console ----

/** What the stand-in console needs of the station it is in. */
interface ConsoleStation {
  /** The stand-in clock (time.monotonic). */
  monotonic(): number;
  /** The scripted wall clock (time.time). */
  wallClock(): number;
  /** The recordings' on_event, which emit calls first with every event: where a scenario's hooks act. */
  onEvent(kind: string, data: EventData): void;
  /** Keeps a saved event with the task's events (TaskEvents.append). */
  appendEvent(taskId: string, event: PublishedEvent): void;
}

/**
 * A stand-in for PEAR's Console, as far as TaskRun and an operator's pause use it: emit, set_phase, stop,
 * robot_status and new_client do what PEAR's do (console.py at the pinned commit). Not PEAR's: its worker
 * (launch, _operate), its commands, its recordings and its Home review.
 */
export class StandInConsole implements TaskConsole<ModelState, SingleArmDelta> {
  /** Recent events kept for a browser that reconnects (Console.EVENT_CAPACITY). */
  static readonly EVENT_CAPACITY = 500;
  static readonly PAUSE_REASON = "Paused by operator";
  static readonly STOPPING_EVENT = "stopping";

  readonly SETTLE_TIMEOUT_S = 10.0;
  readonly events: PublishedEvent[] = [];
  lastEventId = 0;
  performance: EventData | null = null;
  /** The phase the page shows (Console._phase). */
  phase: Phase = Phase.HOLDING;
  isStopLatched = false;
  /** The running operation's cancellation: what stop() sets. */
  cancellation = new AbortController();
  taskRun: TaskRun<ModelState, SingleArmDelta> | null = null;
  /** The ids of the events kept with the task's events. */
  readonly savedIds = new Set<number>();

  constructor(
    readonly modelsConfig: ModelsConfig<ModelState, SingleArmDelta>,
    readonly model: string,
    readonly robot: TracedRobot,
    private readonly station: ConsoleStation,
  ) {}

  get agentRobot(): AgentRobot<ModelState, SingleArmDelta> {
    return this.robot;
  }

  get actionFormat(): ActionFormat<ModelState, SingleArmDelta> {
    return this.modelsConfig.actionFormat(this.model);
  }

  get modelTimeoutS(): number {
    return this.modelsConfig.models[this.model]!.timeoutS;
  }

  /** Console.new_client: a new client of ``model``, its system prompt the task ``instruction`` in the model's
   * format (the port's prompt is the SO-101's single_arm_pose format's, the only one it has). */
  newClient(model: string, instruction: string): ModelClient {
    const offeredModel = this.modelsConfig.models[model]!;

    return offeredModel.newClient(systemPrompt(instruction));
  }

  /** Console.emit (console.py 183 to 210). */
  emit(kind: string, data: EventData, options: { isSaved?: boolean } = {}): PublishedEvent {
    const isSaved = options.isSaved ?? true;
    this.station.onEvent(kind, data);

    const activeTurn = this.taskRun?.activeTurn ?? null;
    const taskId = this.taskRun?.task?.id ?? null;
    // an event of the running turn carries the turn's fields
    if (pythonTruth(activeTurn) && activeTurn !== null && (data["attempt"] ?? null) === activeTurn.attempt) {
      data = { ...activeTurn, ...data };
    } else {
      data = { ...data };
    }
    this.lastEventId += 1;
    const event: PublishedEvent = {
      id: this.lastEventId,
      type: String(kind),
      data,
      time: this.station.wallClock(),
      monotonic_s: this.station.monotonic(),
      task_id: taskId,
    };

    if (isSaved && taskId) {
      this.station.appendEvent(taskId, event);
      this.savedIds.add(event.id);
    }
    this.events.push(event);
    if (this.events.length > StandInConsole.EVENT_CAPACITY) {
      this.events.shift(); // (a deque of EVENT_CAPACITY)
    }

    return event;
  }

  /** Console.set_phase. */
  setPhase(phase: Phase): void {
    this.phase = phase;
  }

  /** Console.robot_status: the word of the robot's status. */
  async robotStatus(): Promise<string> {
    return (await this.robot.status()).status;
  }

  /**
   * Console.stop (console.py 109 to 131): cancels the running operation, stops the robot, shows Stopping and
   * publishes the unsaved event "stopping". PEAR's returns when the robot's stop has; one thread cannot wait
   * inside an emit, so the robot's stop is called and returned for the caller to await. A stop that fails is
   * therefore told by that promise, after the phase and the event, where PEAR's raises before the event.
   */
  stop(options: { isLatching?: boolean; reason?: string } = {}): Promise<void> {
    const reason = options.reason ?? StandInConsole.PAUSE_REASON;
    const startedAt = this.station.monotonic();
    this.cancellation.abort();
    const stopped = this.robot.stop();
    const stopRequestSeconds = this.station.monotonic() - startedAt;
    // (home_review.answered.set(): no Home review here)
    // a failed stop request still latches, so no further motion starts until the reset
    if (options.isLatching) {
      this.isStopLatched = true;
    }
    this.setPhase(Phase.STOPPING);
    this.performance = null;
    // (recordings.stop(reason, stopped_at=started_at): the recordings' stand-in records nothing)

    const stopping = { message: reason, stop_request_seconds: stopRequestSeconds };
    this.emit(StandInConsole.STOPPING_EVENT, stopping, { isSaved: false });

    return stopped;
  }
}

// ---- the model ----

/** Resolves once ``signal`` is aborted; throws when it is not within WAIT_S. */
function stopped(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error("the loop did not stop the request")), WAIT_S * 1000);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** The scripted model of the console's fixtures, made by the station's ModelsConfig as PEAR's
 * StandInScriptedClient is: at each request it follows the next turn of the running call's script (`answer` of
 * the fixture script). */
export class ConsoleClient extends ScriptedClient {
  private readonly rig: ConsoleRig | null;

  constructor(systemPrompt: string, options: { timeoutS: number; rig?: ConsoleRig }) {
    super(systemPrompt, { timeoutS: options.timeoutS });
    this.rig = options.rig ?? null;
  }

  protected override async inferAsync(modelInput: ModelInput, onEvent: EventHandler, cancellation: AbortSignal): Promise<ModelOutput> {
    const rig = this.rig!;
    this.modelInputs.push(modelInput);

    for (const operation of rig.nextTurn(modelInput)) {
      if (operation.emit !== undefined) {
        onEvent(operation.emit[0] as Parameters<EventHandler>[0], structuredClone(operation.emit[1]));
      } else if (operation.return !== undefined) {
        const output = operation.return;
        return modelOutput(output.answer, output.reasoning, output.reasoning_kind, output.usage);
      } else if (operation.raise !== undefined) {
        throw makeError(operation.raise);
      } else if (operation.do === "wait_stop") {
        await stopped(cancellation);
      } else if (operation.do === "wait_watch") {
        await rig.watched();
      } else {
        await rig.act(operation);
      }
      await Promise.resolve(); // (the model works in a thread of its own: what it reports is heard at once)
    }

    throw new Error("a model's script ends with what it returns or raises");
  }
}

/** What ``call`` raised, as a record holds it; null when it returned (`raised_by` of the fixture script). */
async function raisedBy(call: () => unknown): Promise<CallRecord["raised"]> {
  try {
    await call();
  } catch (error) {
    return { type: pythonErrorName(error), message: pythonErrorMessage(error) };
  }

  return null;
}

function inputRecord(input: ModelInput): RecordedInput {
  return {
    text: input.text,
    images: input.images.map((image) => ({
      camera_name: image.cameraName,
      uuid: image.uuid,
      name: image.name!,
      is_jpeg: image.bytes[0] === 0xff && image.bytes[1] === 0xd8,
    })),
    reference_images: input.referenceImages.map((image) => image.uuid),
  };
}

// ---- the rig ----

/**
 * One scenario's rig: a new stand-in clock, new UUID sequences, a new robot, console and task run, as the fixture
 * script makes them for every scenario. `open` opens the robot; `run` is one call of TaskRun.run with its script
 * and returns what the call left.
 */
export class ConsoleRig implements RigHooks, CallContext, ConsoleStation {
  readonly clock = new RecordingClock();
  readonly records = new MemoryRecords();
  robot!: SteppedStandInSO101Robot;
  traced!: TracedRobot;
  console!: StandInConsole;
  taskRun!: TaskRun<ModelState, SingleArmDelta>;

  /** The readings of the wall clock so far in the scenario. */
  wallReadings = 0;
  /** How many questions of the robot's kinematics PEAR's recorded answer answered, and how many pear.js's own. */
  readonly kinematics = { pears: 0, own: 0 };
  /** What a hook started inside an emit and that then failed (in PEAR it would have raised out of the emit). */
  readonly failures: unknown[] = [];

  private readonly queues: Ids = { task_run: [], session: [], robot: [] };
  private drawn: Ids = { task_run: [], session: [], robot: [] };
  private pending: Array<Promise<void>> = [];
  private turns: Array<{ model: ScriptOperation[] }> = [];
  protected hooks: ScriptHook[] = [];
  private phases: string[] = [];
  private modelInputs: ModelInput[] = [];
  private firstEventId = 1;
  private hookActing = 0;
  /** The clock's reading once the sleeps a hook started inside an emit are slept; null when none is under way. */
  private ahead: number | null = null;
  private readonly frames: string[] = [];

  protected constructor(
    private readonly meta: FixtureMeta,
    private readonly scenario: RecordedScenario,
  ) {}

  /** Makes the scenario's rig and opens its robot, with the UUIDs PEAR's drew before the first call. */
  static async open(meta: FixtureMeta, scenario: RecordedScenario): Promise<ConsoleRig> {
    const rig = new ConsoleRig(meta, scenario);
    const station = stationOf(STATIONS[meta.station] ?? meta.station);
    rig.clock.now = meta.start_s;
    rig.script(scenario.ids_before);

    const robot = new SteppedStandInSO101Robot(station.config, {
      cameras: new StandInCameras(SO101Robot.CAMERAS, rig.clock),
      clock: rig.clock,
      uuid4: () => rig.draw("robot"),
    });
    robot.rig = rig;
    await robot.open();
    rig.clock.controlLoop = robot.controlLoop;
    rig.robot = robot;
    rig.traced = new TracedRobot(
      robot,
      new AgentRobotAdapter(robot, (_frame, role, observation) => frameBytes(observation.observation_id, role)),
      rig,
    );

    const modelsConfig = new ModelsConfig<ModelState, SingleArmDelta>({
      robotTitle: "SO-101",
      actionFormats: { [SINGLE_ARM_POSE_FORMAT.name]: SINGLE_ARM_POSE_FORMAT },
      defaultModel: meta.model,
      models: {
        [meta.model]: new OfferedModel({
          label: ConsoleClient.LABEL,
          clientClass: ConsoleClient,
          client: { rig },
          timeoutS: scenario.model_timeout_s,
        }),
      },
    });
    const console = new StandInConsole(modelsConfig, meta.model, rig.traced, rig);
    // the phases a call sets, in order (the fixture script wraps set_phase on the instance)
    const setPhase = console.setPhase.bind(console);
    console.setPhase = (phase) => {
      rig.phases.push(phase);
      setPhase(phase);
    };
    rig.console = console;
    rig.taskRun = new TaskRun(console, rig.records, {
      wallClock: () => rig.wallClock(),
      uuid: () => rig.draw("task_run"),
      loop: {
        uuid: () => rig.draw("session"),
        // PEAR's loop reads the clock the robot reads; a wait that only looks whether the model has answered is on
        // the machine's timers (PEAR: a queue's timeout), a wait for the arm is a sleep of the station's clock
        clock: () => rig.monotonic(),
        sleep: (seconds, wake) => (wake !== undefined ? timerSleep(seconds, wake) : rig.clock.sleep(seconds)),
      },
    });
    console.taskRun = rig.taskRun;
    // (Commands._start is not run: the task is the scenario's, without task.json and the TASK event)
    rig.taskRun.task = structuredClone(scenario.task);
    // (the fixture script puts each of the task's images into the task's folder before the first call: a stand-in
    // of a few bytes, the image's id between a JPEG's first two bytes and its last two)
    const given = new Map<string, Uint8Array>();
    for (const image of scenario.task.images ?? []) {
      given.set(image.file, Uint8Array.from([0xff, 0xd8, ...new TextEncoder().encode(image.id), 0xff, 0xd9]));
    }
    if (given.size > 0) {
      rig.records.given.set(scenario.task.id, given);
    }

    return rig;
  }

  /** What the rig drew and slept before the first call, as a call's `ids` and `clock` give them. */
  before(): { ids: Ids; sleeps: number; monotonic_s: number } {
    return { ids: this.takeIds(), sleeps: this.clock.take().length, monotonic_s: this.clock.now };
  }

  /** One call of TaskRun.run with a new cancellation, which is also the console's, under ``script``, drawing the
   * UUIDs ``ids`` (PEAR's of that call). */
  async run(script: CallScript, ids: Ids): Promise<CallRecord> {
    const console = this.console;
    const taskRun = this.taskRun;
    this.script(ids);
    this.turns = [...(script.turns ?? [])];
    this.hooks = [...(script.hooks ?? [])];
    this.phases = [];
    this.modelInputs = [];
    this.traced.calls = [];
    this.firstEventId = console.lastEventId + 1;
    const extra: Pick<CallRecord, "session_given" | "client"> = {};

    let raised: CallRecord["raised"];
    if (script.op === "run") {
      const cancellation = new AbortController(); // as Console.launch gives an operation
      console.cancellation = cancellation;
      raised = await raisedBy(() => taskRun.run(cancellation.signal));
    } else {
      raised = await this.call(script, extra);
    }
    await this.settled();
    this.clock.afterTick = null;

    const session = taskRun.session;
    const lastInput = (session?.lastTurn as { modelInput?: ModelInput | null } | null | undefined)?.modelInput ?? null;
    for (const image of [...this.modelInputs, ...(lastInput === null ? [] : [lastInput])].flatMap((input) => input.images)) {
      if (image.name !== undefined && !this.frames.includes(image.name)) {
        this.frames.push(image.name);
      }
    }

    return {
      raised,
      events: console.events
        .filter((event) => event.id >= this.firstEventId)
        .map((event) => ({ ...structuredClone(event), saved: console.savedIds.has(event.id) })),
      phases: this.phases,
      phase: console.phase,
      files: this.records.files(taskRun.task!.id, this.frames),
      task_run: {
        total_steps: taskRun.totalSteps,
        turn_number: taskRun.turnNumber,
        active_attempt_id: taskRun.activeAttemptId,
        active_turn: taskRun.activeTurn === null ? null : { ...taskRun.activeTurn },
        resume_pending: taskRun.resumePending,
        inference_started_at: taskRun.inferenceStartedAt,
        has_session: taskRun.session !== null,
        has_client: taskRun.modelClient !== null,
      },
      session:
        session === null
          ? null
          : {
              turn_count: session.turnCount,
              blocked_reason: session.blockedReason,
              previous_result: session.previousResult ? resultRecord(session.previousResult) : null,
            },
      performance: structuredClone(console.performance),
      robot_status: this.robot.status().status,
      robot: this.traced.calls,
      model_inputs: this.modelInputs.map(inputRecord),
      ids: this.takeIds(),
      clock: { sleeps: this.clock.take().length, monotonic_s: this.clock.now, wall_readings: this.wallReadings },
      ...extra,
    };
  }

  /** Makes a call of TaskRun other than run() (`call` of the fixture script): returns what it raised, and puts
   * into ``extra`` what the call's record holds besides. */
  private async call(script: CallScript, extra: Pick<CallRecord, "session_given" | "client">): Promise<CallRecord["raised"]> {
    const console = this.console;
    const taskRun = this.taskRun;
    const task = taskRun.task!;

    if (script.op === "new_session") {
      const raised = await raisedBy(() => taskRun.newSession());
      const session = taskRun.session;
      const files = this.records.given.get(task.id);
      extra.session_given =
        raised !== null || session === null
          ? null
          : {
              robot_is_the_consoles: session.robot === console.agentRobot,
              client_is_the_task_runs: session.client === taskRun.modelClient,
              action_format: session.actionFormat.name,
              timeout_s: session.timeoutS,
              // (PEAR's session is given each image's path; the port's the file's bytes, its name and its uuid)
              reference_images: session.referenceImages.map((image) => {
                const bytes = files?.get(String(image.name));
                const isTheFile = bytes !== undefined && bytes.length === image.bytes.length && bytes.every((byte, index) => byte === image.bytes[index]);
                return { path: isTheFile ? String(image.name) : `${image.name} (not the bytes of the task's file)`, uuid: image.uuid };
              }),
              episode_id: session.episodeId,
            };
      return raised;
    }
    if (script.op === "new_client") {
      // (the script's) a client that never started a session, as newSession's first statement leaves one
      taskRun.modelClient = console.newClient(console.model, task.instruction);
      return null;
    }
    if (script.op === "start_turn") {
      // (TaskRun._start_turn, private in the port too: run() calls it when a turn opens)
      return raisedBy(() => (taskRun as unknown as { startTurn(): string }).startTurn());
    }
    if (script.op === "on_event") {
      const cancellation = new AbortController();
      if (script.cancelled) {
        cancellation.abort();
      }
      const attemptId = script.attempt === "active" ? taskRun.activeAttemptId : script.attempt;
      const kind = script.kind as Parameters<TaskRun<ModelState, SingleArmDelta>["onEvent"]>[2];
      const data = structuredClone(script.data!);
      return raisedBy(() => taskRun.onEvent(cancellation.signal, attemptId as string, kind, data));
    }
    if (script.op === "close_session") {
      const client = taskRun.modelClient;
      if (client === null) {
        extra.client = null;
        return raisedBy(() => taskRun.closeSession());
      }
      // how often the client's cancel() and close() are called from outside it; with `close_raises` its close()
      // raises in the place of closing (its cancel() runs as it is)
      const counts = { cancelled: 0, closed: 0 };
      const cancel = client.cancel.bind(client);
      const close = client.close.bind(client);
      let closing = 0; // not 0 while the client's own close() runs
      client.cancel = () => {
        if (closing === 0) {
          counts.cancelled += 1; // (a cancel() the client's close() makes of itself is not counted)
        }
        cancel();
      };
      client.close = async () => {
        counts.closed += 1;
        if (script.close_raises !== undefined) {
          throw makeError(script.close_raises);
        }
        closing += 1;
        try {
          await close();
        } finally {
          closing -= 1;
        }
      };
      extra.client = counts;
      try {
        return await raisedBy(() => taskRun.closeSession());
      } finally {
        Reflect.deleteProperty(client, "cancel"); // the client's own again
        Reflect.deleteProperty(client, "close");
      }
    }

    throw new Error(`unknown operation ${String(script.op)}`);
  }

  /** Closes the robot. */
  async close(): Promise<void> {
    this.clock.afterTick = null;
    this.clock.controlLoop = null;
    await this.robot.close();
  }

  // ---- the clocks and the UUIDs ----

  /** The stand-in clock as the console and the loop read it: while the sleeps that a hook started inside an emit
   * are under way, the time they end at. PEAR's thread sleeps them inside the emit, so the event the hook acted on
   * and what follows it are stamped after them. */
  monotonic(): number {
    return this.ahead ?? this.clock.now;
  }

  /** time.time() of console.py and task_run.py: meta.wall_start_s + n * meta.wall_step_s at the n-th reading of
   * the scenario. */
  wallClock(): number {
    return this.meta.wall_start_s + this.wallReadings++ * this.meta.wall_step_s;
  }

  private script(ids: Ids): void {
    this.queues.task_run = [...ids.task_run];
    this.queues.session = [...ids.session];
    this.queues.robot = [...ids.robot];
  }

  private draw(kind: keyof Ids): string {
    const value = this.queues[kind].shift() ?? `a UUID PEAR's ${kind} did not draw (${this.drawn[kind].length + 1})`;
    this.drawn[kind].push(value);

    return value;
  }

  private takeIds(): Ids {
    const drawn = this.drawn;
    this.drawn = { task_run: [], session: [], robot: [] };

    return drawn;
  }

  // ---- what the robot and the console ask of the rig ----

  attach(_driver: StandInSO101Driver): void {}

  /** PEAR's kinematics' answer where the station's fixtures hold one to this question; otherwise pear.js's own
   * kinematics answer (null), and the question is counted. */
  recordedTarget(joints: number[], delta: number[]): Outcome<number[]> | null {
    const answer = KINEMATICS.get(JSON.stringify([joints, delta])) ?? null;
    if (answer === null) {
      this.kinematics.own += 1;
    } else {
      this.kinematics.pears += 1;
    }

    return answer;
  }

  asked(_record: KinematicsRecord): void {}

  lastEventId(): number {
    return this.console.lastEventId;
  }

  isSettled(): boolean {
    return this.pending.length === 0;
  }

  isHookActing(): boolean {
    return this.hookActing > 0;
  }

  async settled(): Promise<void> {
    while (this.pending.length > 0) {
      await Promise.all(this.pending.splice(0));
    }
    if (this.ahead !== null) {
      if (this.ahead !== this.clock.now) {
        this.failures.push(new Error(`a hook's sleeps were stamped ${this.ahead} s and ended at ${this.clock.now} s`));
      }
      this.ahead = null;
    }
  }

  appendEvent(taskId: string, event: PublishedEvent): void {
    this.records.appendEvent(taskId, event);
  }

  /** Acts for every hook of the running call that waits for this event (`hooked` of the fixture script). */
  onEvent(kind: string, data: EventData): void {
    for (const hook of [...this.hooks]) {
      if (hook.on !== kind || (hook.phase !== undefined && (data["phase"] ?? null) !== hook.phase)) {
        continue;
      }
      if (hook.turn !== undefined && this.taskRun.turnNumber !== hook.turn) {
        continue;
      }
      this.hooks.splice(this.hooks.indexOf(hook), 1);
      if (hook.after_sleeps === undefined) {
        this.hookActing += 1;
        try {
          this.actInEmit(hook);
        } finally {
          this.hookActing -= 1;
        }
        continue;
      }
      const clock = this.clock;
      const due = clock.ticks.length + hook.after_sleeps;
      clock.afterTick = async (count) => {
        if (count >= due) {
          clock.afterTick = null;
          this.hookActing += 1;
          try {
            await this.act(hook);
          } finally {
            this.hookActing -= 1;
          }
        }
        return null;
      };
    }
  }

  // ---- the model and the operator ----

  /** The operations of the model's next turn; the loop has not looked at the hold since. */
  nextTurn(modelInput: ModelInput): ScriptOperation[] {
    this.traced.holdCalls = 0;
    this.modelInputs.push(modelInput);
    const turn = this.turns.shift();
    if (turn === undefined) {
      throw new Error("the model was asked more often than the call's script has turns");
    }

    return turn.model;
  }

  /** Resolves once the loop has looked at the robot's hold: it watches the request from then on. */
  async watched(): Promise<void> {
    const deadline = Date.now() + WAIT_S * 1000;
    while (this.traced.holdCalls === 0) {
      if (Date.now() > deadline) {
        throw new Error("the loop did not watch the request");
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  /** Does what an operation asks of the rig and what follows it at once (`act` of the fixture script), each
   * waited for, as PEAR's thread is held. */
  async act(operation: ScriptOperation): Promise<void> {
    if (operation.do === "pause") {
      await this.pause();
    } else if (operation.do === "arm_failure") {
      this.robot.arm.failure = new RuntimeError(operation.message!);
    } else if (operation.do === "move_arm") {
      this.moveArm(operation);
    } else if (operation.do === "advance_clock") {
      for (let count = 0; count < operation.times!; count++) {
        await this.clock.sleep(operation.seconds!); // time passes and the control loop steps
      }
    } else {
      throw new Error(`unknown action ${operation.do}`);
    }
    for (const following of operation.then ?? []) {
      await this.act(following);
    }
  }

  /** The same inside an emit, where nothing can be waited for: what an operation starts is kept, and awaited
   * before the robot's next call begins and when the run has ended. A sleep's time passes at once; the control
   * loop's step of it is started. */
  private actInEmit(operation: ScriptOperation): void {
    if (operation.do === "pause") {
      this.pauseInEmit();
    } else if (operation.do === "arm_failure") {
      this.robot.arm.failure = new RuntimeError(operation.message!);
    } else if (operation.do === "move_arm") {
      this.moveArm(operation);
    } else if (operation.do === "advance_clock") {
      // (the time of all its sleeps passes now for who reads the clock, added as the clock adds it)
      let ahead = this.monotonic();
      for (let count = 0; count < operation.times!; count++) {
        ahead += operation.seconds!;
      }
      this.ahead = ahead;
      this.started(
        (async () => {
          for (let count = 0; count < operation.times!; count++) {
            await this.clock.sleep(operation.seconds!);
          }
        })(),
      );
    } else {
      throw new Error(`unknown action ${operation.do}`);
    }
    for (const following of operation.then ?? []) {
      this.actInEmit(following);
    }
  }

  /** The arm is pushed, as tools/fixtures/agent_fixtures.py does: the stand-in arm's position of that joint moves
   * by `offset`, and every reading from then on shows that joint with the velocity `velocity`. */
  private moveArm(operation: ScriptOperation): void {
    const arm = this.robot.arm;
    const joint = operation.joint!;
    const position = [...arm.position];
    position[joint]! += operation.offset!;
    arm.position = position;
    const read = arm.read.bind(arm);
    arm.read = async () => {
      const state = await read();
      const velocity = state.velocity.map(() => 0.0);
      velocity[joint] = operation.velocity!;

      return replaced(state, { velocity });
    };
  }

  /**
   * The operator's pause as the fixture script makes it: PEAR's Console.stop(), and the run's cancellation set
   * once it has returned, not at its first line (stop() sets a placeholder in its place). Here the robot's stop
   * that stop() started is waited for first, as PEAR's stop() returns when the robot's has.
   */
  private async pause(): Promise<void> {
    const console = this.console;
    const cancellation = console.cancellation;
    console.cancellation = new AbortController(); // what stop() sets, in the place of the run's until it returns
    try {
      await console.stop();
    } finally {
      console.cancellation = cancellation;
      cancellation.abort();
    }
  }

  /** The same pause inside an emit, all of it before the emit goes on: the robot's stop is called and kept for
   * the rig to await, and the run's cancellation is set at once. */
  private pauseInEmit(): void {
    const console = this.console;
    const cancellation = console.cancellation;
    console.cancellation = new AbortController();
    try {
      this.started(console.stop());
    } finally {
      console.cancellation = cancellation;
      cancellation.abort();
    }
  }

  private started(work: Promise<void>): void {
    this.pending.push(
      work.catch((error: unknown) => {
        this.failures.push(error);
      }),
    );
  }
}
