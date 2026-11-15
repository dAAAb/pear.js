// The rig of the joined console: what a replay of tests/fixtures/console/task_commands.json needs. The record is
// PEAR's own Commands running a task from `start` on, on PEAR's Console with its worker thread, PEAR's TaskRun and
// PEAR's real robot (tools/fixtures/console_task_commands_fixtures.py, whose docstring gives the rig, the threads,
// the order the record pins and the file's format).
//
// Here the three ported parts run together: the port's Console, made by its constructor, with its own TaskRun and
// its own worker; the port's Commands, made inside that constructor as PEAR's is (Commands(self)); pear.js's real
// robot on the stepped stand-in arm with the recording clock, as rig.ts makes it. TaskCommandsRig extends rig.ts's
// ConsoleRig, which is what the robot, the traced robot and the scripted model ask their questions of; the
// stand-in console of that rig is not made (`console` stays unset), and `made` is the port's.
//
// What stands in, each recording its calls in PEAR's form and answering what the script's docstring says: the
// recordings, the preview, the camera feed, the uploads, the annotations and the health checks. The watchdog is
// the port's Watchdog made without its constructor, which would start its loop: nothing checks by itself, and a
// step {"op": "watchdog_check"} calls its check once on the main thread, as the script calls PEAR's _check.
//
// The threads. PEAR's three (`main` gives the commands, `worker` is the console's worker, `model` is the thread in
// which the session asks the scripted model) are one thread here; an async context tells them apart, as
// console_rig.ts does: one around what Console.launch starts, one around the scripted model's request.
//
// The hand-over. {"do": "hand_over", "point": name} holds a thread at the named point until the main thread has
// given its commands there: a step whose `until` is a point ends when the thread waits at it, and the next step
// gives its command and then lets it go on. In the scripted model's answer it holds the model's request (the
// worker is idle in the session's watch loop). As a hook with `after_sleeps` it holds the worker inside a sleep of
// the stand-in clock within the robot's execute, that many control periods after the hook's event: the arm moves,
// and the control period of that sleep has been stepped. A command given at a point and recorded at the same
// point (`at` equals `until`) leaves the thread there: a command that is refused. A step with `release` "stopped"
// lets the thread go on inside the command, when Console.stop() has returned and the worker's cancellation is
// set: a command that stops the running operation and waits for its worker itself (Commands' stopBefore).
//
// The order between the threads. The port's Console.stop sets the cancellation at its first line, as PEAR's does.
// The fixture script wrapped PEAR's: stop() runs with a cancellation of the script's own, and the worker's is set
// when stop() has returned. The rig does the same to the port's (see `make`), so that every effect of the command
// comes before the worker's reaction. The worker's cancellation is set inside the worker's context: what an abort
// listener of the worker does at once is the worker's.

import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { EventData, EventHandler, ModelInput, ModelOutput } from "../../src/agent/clients/schemas";
import { sleep as timerSleep } from "../../src/agent/clock";
import { ModelsConfig, OfferedModel } from "../../src/agent/config";
import { SINGLE_ARM_POSE_FORMAT } from "../../src/agent/formats";
import { resultRecord } from "../../src/agent/robot";
import { Commands, type CommandsConsole, type CommandsRobot } from "../../src/console/commands";
import { Console, type ConsoleOptions } from "../../src/console/console";
import { Phase } from "../../src/console/phase";
import { Watchdog } from "../../src/console/watchdog";
import type { ModelState, SingleArmDelta } from "../../src/protocol/types";
import { pythonErrorMessage, pythonErrorName } from "../../src/python/errors";
import { SO101Robot } from "../../src/so101/robot";
import { AgentRobotAdapter } from "../../src/station/robot";
import { frameBytes } from "../agent/stand_ins";
import { stationOf, type Outcome } from "../station-robot/fixtures";
import { StandInCameras, SteppedStandInSO101Robot } from "../station-robot/rig";
import { cleanTags } from "./commands_rig";
import {
  ConsoleClient,
  ConsoleRig,
  STATIONS,
  TracedRobot,
  type FixtureMeta,
  type PublishedEvent,
  type RobotCall,
  type RecordedScenario,
  type ScriptHook,
  type ScriptOperation,
} from "./rig";

/** The longest the rig waits, on the machine's clock, for a point or for the worker's end, ms. */
const WAIT_MS = 20_000;

/** PEAR's threads, as the record names them. */
export type Thread = "main" | "worker" | "model";
export const THREADS: readonly Thread[] = ["main", "worker", "model"];

// ---- the fixture ----

/** The UUIDs by who draws them. */
export interface JoinedIds {
  task_run: string[];
  session: string[];
  robot: string[];
  commands: string[];
}

/** An answer of PEAR's kinematics. */
export interface RecordedAnswer {
  joints: number[];
  delta: number[];
  out: Outcome<number[]>;
}

/** One step of a scenario, a command or a check of the watchdog, and what PEAR's console left after it. */
export interface TaskCommandsStep {
  /** Only in a step that is no command: "watchdog_check". */
  op?: string;
  /** The command and its data; null in a step that is no command. */
  command: string | null;
  data: Record<string, unknown> | null;
  at: string | null;
  until: string;
  /** "stopped": the thread at the point `at` goes on when Console.stop() has returned, inside the command. */
  release?: string;
  script: { turns?: Array<{ model: ScriptOperation[] }>; hooks?: ScriptHook[] };
  returned: Record<string, unknown> | null;
  raised: { type: string; message: string } | null;
  events: Record<string, unknown>[];
  phases: Record<Thread, string[]>;
  console: Record<string, unknown>;
  task: Record<string, unknown> | null;
  task_run: Record<string, unknown>;
  session: Record<string, unknown> | null;
  robot_status: string;
  files: Record<string, unknown>[];
  calls: Record<Thread, Record<string, unknown>[]>;
  model_inputs: Record<string, unknown>[];
  ik: RecordedAnswer[];
  ids: JoinedIds;
  clock: { sleeps: number; monotonic_s: number; wall_readings: number };
}

export interface TaskCommandsScenario {
  name: string;
  pins: unknown;
  robot_session_id: string;
  control_period_s: number;
  model_timeout_s: number;
  ids_before: JoinedIds;
  sleeps_before: number;
  monotonic_s_before: number;
  console_before: Record<string, unknown>;
  robot_status_before: string;
  ik_before: RecordedAnswer[];
  steps: TaskCommandsStep[];
}

export interface TaskCommandsMeta {
  pear_commit: string;
  station: string;
  model: string;
  root: string;
  threads: Thread[];
  start_s: number;
  wall_start_s: number;
  wall_step_s: number;
  constants: Record<string, unknown>;
  counts: Record<string, number>;
}

export interface TaskCommandsFixture {
  meta: TaskCommandsMeta;
  scenarios: TaskCommandsScenario[];
}

/** Returns tests/fixtures/console/task_commands.json. */
export function loadTaskCommandsFixture(): TaskCommandsFixture {
  const path = fileURLToPath(new URL("../fixtures/console/task_commands.json", import.meta.url));

  return JSON.parse(readFileSync(path, "utf8")) as TaskCommandsFixture;
}

/** What a step of the replay made: every part of a step's record but its script and PEAR's kinematics' answers. */
export type StepMade = Omit<TaskCommandsStep, "op" | "command" | "data" | "at" | "until" | "release" | "script" | "ik">;

/** What the rig is before the first step, as the scenario's `..._before` give it. */
export interface MadeBefore {
  console: Record<string, unknown>;
  robot_status: string;
  ids: JoinedIds;
  sleeps: number;
  monotonic_s: number;
}

/** What the client was sent at a request, as the record holds it (`inputRecord` of rig.ts). */
function inputRecord(input: ModelInput): Record<string, unknown> {
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

// ---- the scripted model ----

/** rig.ts's scripted model, its request in the context of PEAR's model thread. */
class JoinedClient extends ConsoleClient {
  private readonly joined: TaskCommandsRig;

  constructor(systemPrompt: string, options: { timeoutS: number; rig?: ConsoleRig }) {
    super(systemPrompt, options);
    this.joined = options.rig as unknown as TaskCommandsRig;
  }

  protected override inferAsync(modelInput: ModelInput, onEvent: EventHandler, cancellation: AbortSignal): Promise<ModelOutput> {
    return this.joined.threads.run("model", () => super.inferAsync(modelInput, onEvent, cancellation));
  }
}

// ---- the rig ----

/**
 * One scenario's rig: a new stand-in clock, new UUID sequences, a new robot, and the port's console with its
 * commands, as the fixture script makes PEAR's for every scenario. `join` opens the robot and makes the console;
 * `step` gives one command and returns what it left; `dispose` ends what still runs.
 */
export class TaskCommandsRig extends ConsoleRig {
  /** The port's console, made by its constructor. */
  made!: Console<ModelState, SingleArmDelta>;
  /** The port's commands, made inside the console's constructor. */
  commands!: Commands<ModelState, SingleArmDelta>;
  /** Which of PEAR's threads acts. */
  readonly threads = new AsyncLocalStorage<Thread>();
  /** The ids of the events a task's events.jsonl holds. */
  readonly savedIds = new Set<number>();
  /** The folders Commands made and removed, and the files written under the root itself. */
  readonly tasksCreated: string[] = [];
  readonly tasksRemoved: string[] = [];
  readonly rootFiles = new Map<string, EventData>();
  /** The readings of time.time_ns(): the record's rig has none. */
  nsReadings = 0;
  /** The questions of the kinematics the record holds no answer to. */
  readonly unanswered: string[] = [];

  stepEvents: Record<string, unknown>[] = [];
  stepPhases: Record<Thread, string[]> = { main: [], worker: [], model: [] };
  stepCalls: Record<Thread, Record<string, unknown>[]> = { main: [], worker: [], model: [] };
  stepInputs: ModelInput[] = [];

  private readonly idQueues: JoinedIds = { task_run: [], session: [], robot: [], commands: [] };
  private idsDrawn: JoinedIds = { task_run: [], session: [], robot: [], commands: [] };
  private stepTurns: Array<{ model: ScriptOperation[] }> = [];
  /** The names of the frames the model was sent so far, by the task whose turn sent them (the port's loop writes
   * no frame: a frame is a file of its task by its name), and each file's record at the step before. */
  private readonly frameNames = new Map<string, string[]>();
  private filesBefore = new Map<string, string>();
  private readonly answers = new Map<string, Outcome<number[]>>();
  /** The point at which a thread waits (the model's request, or the worker inside the robot's execute), and what
   * lets it go on. */
  private waiting: { point: string; release: () => void } | null = null;
  /** The point whose thread goes on when Console.stop() has returned (a step's `release` "stopped"). */
  private releaseAtStop: string | null = null;
  /** The port's watchdog, made without its constructor: it checks at a step, never by itself. */
  private watchdog!: Watchdog<ModelState, SingleArmDelta>;

  private constructor(
    private readonly given: TaskCommandsMeta,
    private readonly recorded: TaskCommandsScenario,
  ) {
    super(given as unknown as FixtureMeta, recorded as unknown as RecordedScenario);
  }

  /** Makes the scenario's rig: opens its robot, with the UUIDs PEAR's drew before the first step, and makes the
   * port's console on it. */
  static async join(meta: TaskCommandsMeta, scenario: TaskCommandsScenario): Promise<TaskCommandsRig> {
    const rig = new TaskCommandsRig(meta, scenario);
    const station = stationOf(STATIONS[meta.station] ?? meta.station);
    rig.clock.now = meta.start_s;
    rig.queue(scenario.ids_before);
    for (const answer of [...scenario.ik_before, ...scenario.steps.flatMap((step) => step.ik)]) {
      rig.answers.set(JSON.stringify([answer.joints, answer.delta]), answer.out);
    }

    // the robot, as rig.ts's ConsoleRig.open makes it
    const robot = new SteppedStandInSO101Robot(station.config, {
      cameras: new StandInCameras(SO101Robot.CAMERAS, rig.clock),
      clock: rig.clock,
      uuid4: () => rig.drawId("robot"),
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
    rig.make();

    return rig;
  }

  /** Makes the port's console with its commands, on the opened robot and the stand-ins. */
  private make(): void {
    const meta = this.given;
    const robot = this.robot;
    const traced = this.traced;

    const modelsConfig = new ModelsConfig<ModelState, SingleArmDelta>({
      robotTitle: "SO-101",
      actionFormats: { [SINGLE_ARM_POSE_FORMAT.name]: SINGLE_ARM_POSE_FORMAT },
      defaultModel: meta.model,
      models: {
        [meta.model]: new OfferedModel({
          label: JoinedClient.LABEL,
          clientClass: JoinedClient,
          client: { rig: this },
          timeoutS: this.recorded.model_timeout_s,
        }),
      },
    });

    // The robot's calls by thread: the list the traced robot appends to is the rig's, as the fixture script
    // replaces the list its wrappers append to.
    const route = (entry: RobotCall): void => {
      this.stepCalls[this.thread()].push({ of: "robot", ...entry });
    };
    traced.calls = new (class extends Array<RobotCall> {
      override push(...entries: RobotCall[]): number {
        entries.forEach(route);

        return this.length;
      }
    })();

    // The console's robot: the traced robot (its calls are recorded as the task run's rig records them), but for
    // what the traced robot has not or has otherwise: status() is not awaited by the port's console (TracedRobot's
    // is a promise), and open, close, recover and home are the robot's own.
    const own = robot as unknown as Record<string | symbol, (...given: unknown[]) => unknown>;
    const consoleRobot = new Proxy(traced as unknown as Record<string | symbol, unknown>, {
      get: (target, name) => {
        if (name === "status") {
          // recorded as TracedRobot records its own: when the call has ended, with the status word
          return (withSnapshot = false) => {
            const afterEvent = this.lastEventId();
            const value = own["status"]!.call(robot, withSnapshot) as { status: string };
            route({ call: "status", after_event: afterEvent, with_snapshot: withSnapshot, returned: value.status });

            return value;
          };
        }
        if (name === "open" || name === "close" || name === "recover" || name === "home") {
          return (...given: unknown[]) => own[name]!.call(robot, ...given);
        }
        const value = Reflect.get(target, name);

        return typeof value === "function" ? (value as (...given: unknown[]) => unknown).bind(target) : value;
      },
    }) as unknown as CommandsRobot;

    // ---- STAND-IN CALLS: the port's call, and PEAR's as it is recorded ----
    const cameraFeed = { reader: {} };
    const recordings = {
      isEnabled: true,
      activeSegment: null,
      // PEAR: start(task, camera_feed, robot_status_reader)
      start: (task: unknown, givenFeed: unknown, reader: unknown) => {
        const feed = { object: givenFeed === cameraFeed ? "StandIn" : "not the console's camera feed" };
        this.called("recordings", "start", [structuredClone(task), feed, { object: typeof reader }]);
      },
      // PEAR: stop(reason) and stop(reason, stopped_at=...)
      stop: (reason: string, options?: { stoppedAt?: number }) => {
        this.called("recordings", "stop", [reason], options?.stoppedAt === undefined ? {} : { stopped_at: options.stoppedAt });
      },
      snapshot: () => {
        this.called("recordings", "snapshot", []);

        return null;
      },
      // (not recorded: the events are; it is where a scenario's hooks act)
      onEvent: (kind: string, data: EventData) => this.onEvent(kind, data),
      close: async () => {
        this.called("recordings", "close", []);
      },
    };
    const preview = {
      isEncoding: true,
      errorText: null,
      status: () => {
        this.called("preview", "status", []);

        return null;
      },
      reconnect: async () => {
        this.called("preview", "reconnect", [{ object: "Event" }]);
      },
      close: async () => {
        this.called("preview", "close", []);
      },
    };
    const uploads = {
      // PEAR: attach(image_ids, owner, files) and delete(upload_id, owner)
      attach: (uploadIds: unknown, owner: unknown, taskId: unknown) => {
        this.called("uploads", "attach", [uploadIds, owner, this.taskFiles(taskId)], {}, []);

        return [];
      },
      delete: (uploadId: unknown, owner: unknown) => {
        this.called("uploads", "delete", [uploadId, owner]);
      },
    };
    const annotations = {
      cleanTags, // (PEAR: the classmethod, called on the class: no call of the stand-in)
      // PEAR: update(files, tags=tags)
      update: (taskId: unknown, options: { tags: unknown }) => {
        this.called("annotations", "update", [this.taskFiles(taskId)], { tags: options.tags });

        return null;
      },
    };
    const healthChecks = {
      get: (model: string) => {
        this.called("health_checks", "get", [model]);

        return null;
      },
      check: async (model: string) => {
        this.called("health_checks", "check", [model]);

        return null;
      },
    };
    const memory = this.records;
    const records = {
      writeJson: memory.writeJson.bind(memory),
      readFile: memory.readFile.bind(memory),
      appendEvent: (taskId: string, event: PublishedEvent) => {
        this.savedIds.add(event.id);
        memory.appendEvent(taskId, event);
      },
      writeRootJson: (name: string, value: EventData) => {
        this.rootFiles.set(name, structuredClone(value));
      },
      createTask: (taskId: string) => {
        this.tasksCreated.push(taskId);
      },
      removeTask: (taskId: string) => {
        this.tasksRemoved.push(taskId);
      },
    };

    const console = new Console<ModelState, SingleArmDelta>({
      modelsConfig,
      robot: consoleRobot,
      agentRobot: traced,
      cameraFeed: cameraFeed as unknown as ConsoleOptions["cameraFeed"],
      robotProfile: () => ({}),
      records,
      uploads,
      recordings,
      annotations,
      preview,
      // PEAR: Commands(self)
      commands: (madeConsole) =>
        (this.commands = new Commands<ModelState, SingleArmDelta>(
          madeConsole as unknown as CommandsConsole<ModelState, SingleArmDelta>,
          {
            robotClass: SO101Robot,
            wallClock: () => this.wallClock(),
            timeNs: () => this.timeNs(),
            uuid: () => this.drawId("commands"),
          },
        )),
      watchdog: () => ({ close: async () => undefined }), // (no loop that checks by itself: see `watchdog` below)
      wallClock: () => this.wallClock(),
      clock: () => this.monotonic(),
      timeNs: () => this.timeNs(),
      uuid: () => this.drawId("task_run"),
      loop: {
        uuid: () => this.drawId("session"),
        // as rig.ts gives the task run's loop its clock and its sleeps
        clock: () => this.monotonic(),
        sleep: (seconds, wake) => (wake !== undefined ? timerSleep(seconds, wake) : this.clock.sleep(seconds)),
      },
    });
    (console as unknown as { healthChecks: typeof healthChecks }).healthChecks = healthChecks;
    console.setPhase(Phase.HOLDING); // an enabled robot at rest (the script: console._phase = Phase.HOLDING)

    const emit = console.emit.bind(console); // the port's own, which still run
    const setPhase = console.setPhase.bind(console);
    const launch = console.launch.bind(console);
    const stop = console.stop.bind(console);
    console.emit = (kind, data, options) => {
      const event = emit(kind, data, options);
      this.stepEvents.push({ ...structuredClone(event), thread: this.thread(), saved: this.savedIds.has(event.id) });

      return event;
    };
    console.setPhase = (phase) => {
      this.stepPhases[this.thread()].push(phase);
      setPhase(phase);
    };
    // the worker's body is the worker thread's, whoever launches it
    console.launch = (operation, options) => this.threads.run("worker", () => launch(operation, options));
    // The order between the threads, as the fixture script chose it: stop() runs with a cancellation of the rig's
    // own, and the worker's is set when stop() has returned.
    console.stop = async (options) => {
      const workers = console.cancellation;
      console.cancellation = new AbortController();
      try {
        return await stop(options);
      } finally {
        console.cancellation = workers;
        this.threads.run("worker", () => workers.abort());
        if (this.releaseAtStop !== null) {
          // a command that waits for the worker itself: the thread at the point goes on now, inside the command
          const point = this.releaseAtStop;
          this.releaseAtStop = null;
          this.release(point);
        }
      }
    };

    this.made = console;
    this.taskRun = console.taskRun;

    // PEAR's Watchdog made without its constructor (the script: object.__new__(Watchdog), its console set)
    const watchdog = Object.create(Watchdog.prototype) as Watchdog<ModelState, SingleArmDelta>;
    Object.defineProperty(watchdog, "console", { value: console, enumerable: true });
    this.watchdog = watchdog;
  }

  // ---- what the robot, the traced robot and the scripted model ask of the rig ----

  thread(): Thread {
    return this.threads.getStore() ?? "main";
  }

  override lastEventId(): number {
    return this.made === undefined ? 0 : this.made.lastEventId;
  }

  /** Whether a hook acts on the thread that asks. A call of the robot from the main thread while a hook holds the
   * worker inside the robot's execute is the operator's command, and it is in the record: the script keeps the
   * robot's calls by thread, where the task run's script told a call the robot makes of itself by its one thread. */
  override isHookActing(): boolean {
    return this.thread() !== "main" && super.isHookActing();
  }

  /** PEAR's kinematics' answer to this question, from the record's `ik`; a question the record does not hold is
   * kept, and pear.js's own kinematics answer it. */
  override recordedTarget(joints: number[], delta: number[]): Outcome<number[]> | null {
    const question = JSON.stringify([joints, delta]);
    const answer = this.answers.get(question);
    if (answer === undefined) {
      this.kinematics.own += 1;
      this.unanswered.push(question);

      return null;
    }
    this.kinematics.pears += 1;

    return structuredClone(answer);
  }

  /** The operations of the model's next request; the loop has not looked at the hold since. */
  override nextTurn(modelInput: ModelInput): ScriptOperation[] {
    this.traced.holdCalls = 0;
    this.stepInputs.push(modelInput);
    const taskId = this.made.taskRun.task?.id;
    if (taskId !== undefined) {
      const names = this.frameNames.get(taskId) ?? [];
      this.frameNames.set(taskId, names);
      for (const image of modelInput.images) {
        if (image.name !== undefined && !names.includes(image.name)) {
          names.push(image.name);
        }
      }
    }
    const turn = this.stepTurns.shift();
    if (turn === undefined) {
      throw new Error("the model was asked more often than the steps' scripts have turns");
    }

    return turn.model;
  }

  /** An operation of the model's answer or of a hook: the hand-over holds its thread at the point; any other is
   * rig.ts's. */
  override async act(operation: ScriptOperation): Promise<void> {
    const given = operation as { do?: string; point?: string };
    if (given.do !== "hand_over") {
      await super.act(operation);
      return;
    }
    const point = given.point!;
    await new Promise<void>((resolve) => {
      this.waiting = { point, release: resolve };
    });
  }

  // ---- the steps ----

  /** Does one step on the main thread, as the record's step does (a command, or a check of the watchdog), and
   * returns what it left: when the worker has ended (`until` "ended") or when a thread waits at the point
   * `until`. */
  async step(step: TaskCommandsStep): Promise<StepMade> {
    if (step.op !== undefined && step.op !== "watchdog_check") {
      throw new Error(`the rig does not know the step "${step.op}"`);
    }
    this.queue(step.ids);
    // (absent keys leave what an earlier step set)
    if (step.script.turns !== undefined) {
      this.stepTurns = [...step.script.turns];
    }
    if (step.script.hooks !== undefined) {
      this.hooks = structuredClone(step.script.hooks);
    }
    this.releaseAtStop = step.release === "stopped" ? step.at : null;
    this.stepEvents = [];
    this.stepPhases = { main: [], worker: [], model: [] };
    this.stepCalls = { main: [], worker: [], model: [] };
    this.stepInputs = [];

    let returned: StepMade["returned"] = null;
    let raised: StepMade["raised"] = null;
    try {
      if (step.op === "watchdog_check") {
        await (this.watchdog as unknown as { check(): Promise<void> }).check();
      } else {
        returned = (await this.commands.run(step.command!, step.data)) as unknown as Record<string, unknown>;
      }
    } catch (error) {
      raised = { type: pythonErrorName(error), message: pythonErrorMessage(error) };
    }
    if (this.releaseAtStop !== null) {
      // the command was to stop the running operation and did not call Console.stop(): the thread still waits
      this.releaseAtStop = null;
      throw new Error(`the command ${String(step.command)} did not stop the operation that waits at "${String(step.at)}"`);
    }
    if (step.at !== null && step.until !== step.at && step.release === undefined) {
      this.release(step.at); // the main thread has given its command at the point: the thread there goes on
    }
    if (step.until === "ended") {
      await this.ended();
    } else {
      await this.reached(step.until);
    }

    const taskRun = this.made.taskRun;
    const session = taskRun.session;

    return {
      returned,
      raised,
      events: this.stepEvents,
      phases: this.stepPhases,
      console: this.fields(),
      task: taskRun.task === null ? null : (structuredClone(taskRun.task) as unknown as Record<string, unknown>),
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
      robot_status: this.robot.status().status,
      files: this.files(),
      calls: this.stepCalls,
      model_inputs: this.stepInputs.map(inputRecord),
      ids: this.takeDrawn(),
      clock: { sleeps: this.clock.take().length, monotonic_s: this.clock.now, wall_readings: this.wallReadings },
    };
  }

  /** What the rig is before the first step: the console's fields, the robot's status word, and what the rig
   * drew and slept (the robot's session; its opening). */
  beforeFirst(): MadeBefore {
    return {
      console: this.fields(),
      robot_status: this.robot.status().status,
      ids: this.takeDrawn(),
      sleeps: this.clock.take().length,
      monotonic_s: this.clock.now,
    };
  }

  /** The console's fields, as a step's `console` holds them. */
  private fields(): Record<string, unknown> {
    const console = this.made;

    return {
      phase: console.phase,
      error: console.error,
      is_stop_latched: console.isStopLatched,
      performance: structuredClone(console.performance),
      home_status: structuredClone(console.homeStatus),
      is_busy: console.isBusy,
    };
  }

  /** Every file under the console's root, by its path under the root, sorted, as a step's `files` holds them: a
   * file that is what it was at the step before reads {name, unchanged: true}. */
  private files(): Record<string, unknown>[] {
    const taskIds = this.tasksCreated.filter((taskId) => !this.tasksRemoved.includes(taskId));
    const current = this.made.taskRun.task?.id;
    if (current !== undefined && !taskIds.includes(current)) {
      taskIds.push(current);
    }
    const files = taskIds
      .flatMap((taskId) =>
        this.records.files(taskId, this.frameNames.get(taskId) ?? []).map((file) => ({ ...file, name: `${taskId}/${file.name}` })),
      )
      .sort((one, other) => (one.name < other.name ? -1 : one.name > other.name ? 1 : 0));
    const before = this.filesBefore;
    this.filesBefore = new Map(files.map((file) => [file.name, JSON.stringify(file)]));

    return files.map((file) => (before.get(file.name) === JSON.stringify(file) ? { name: file.name, unchanged: true } : file));
  }

  private takeDrawn(): JoinedIds {
    const drawn = this.idsDrawn;
    this.idsDrawn = { task_run: [], session: [], robot: [], commands: [] };

    return drawn;
  }

  /** Waits, on the machine's clock, until a thread waits at ``point``. */
  private async reached(point: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (this.waiting?.point !== point) {
      const console = this.made;
      if (!console.isBusy) {
        throw new Error(
          `the worker ended before the point "${point}" was reached (phase ${console.phase}, error ${String(console.error)})`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(`the point "${point}" was not reached within ${WAIT_MS / 1000} s`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  /** Lets the thread that waits at ``point`` go on. */
  private release(point: string): void {
    const waiting = this.waiting;
    if (waiting === null || waiting.point !== point) {
      throw new Error(`no thread waits at the point "${point}"`);
    }
    this.waiting = null;
    waiting.release();
  }

  /** Waits, on the machine's clock, for the worker's end (the main thread joins it). */
  private async ended(): Promise<void> {
    const worker = this.made.worker;
    if (worker !== null) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`the worker did not end within ${WAIT_MS / 1000} s`)), WAIT_MS);
      });
      try {
        await Promise.race([worker.ended, limit]);
      } finally {
        clearTimeout(timer);
      }
    }
    await this.settled();
  }

  /** Ends what still runs (a request that waits at a point, the worker) and closes the robot. */
  async dispose(): Promise<void> {
    const console = this.made;
    console.cancellation.abort();
    this.waiting?.release();
    this.waiting = null;
    try {
      await this.ended();
    } finally {
      await this.close();
    }
  }

  // ---- the clocks, the UUIDs and the calls ----

  private timeNs(): bigint {
    this.nsReadings += 1;

    return BigInt(Math.round(this.given.wall_start_s)) * 1_000_000_000n;
  }

  private queue(ids: JoinedIds): void {
    this.idQueues.task_run = [...ids.task_run];
    this.idQueues.session = [...ids.session];
    this.idQueues.robot = [...ids.robot];
    this.idQueues.commands = [...ids.commands];
  }

  private drawId(kind: keyof JoinedIds): string {
    const value = this.idQueues[kind].shift() ?? `a UUID PEAR's ${kind} did not draw (${this.idsDrawn[kind].length + 1})`;
    this.idsDrawn[kind].push(value);

    return value;
  }

  /** PEAR's TaskFiles of a task, as the record writes an object: only for the id of a task whose folder Commands
   * made and has not removed, so that a call with another id shows as a difference. */
  private taskFiles(taskId: unknown): Record<string, unknown> {
    const isMade = typeof taskId === "string" && this.tasksCreated.includes(taskId) && !this.tasksRemoved.includes(taskId);

    return { object: isMade ? "TaskFiles" : `not the folder of a task that was made: ${String(taskId)}` };
  }

  /** Records a call of a stand-in as the fixture script's StandIn does (`returned` is absent where it is None). */
  private called(of: string, call: string, given: unknown[], keywords: Record<string, unknown> = {}, returned?: unknown): void {
    this.stepCalls[this.thread()].push({
      of,
      call,
      arguments: given,
      keywords,
      after_event: this.lastEventId(),
      ...(returned === undefined ? {} : { returned }),
    });
  }
}
