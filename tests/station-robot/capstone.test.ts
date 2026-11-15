// The capstone: the 19 tasks (60 turns) of tests/fixtures/agent/loop.json, which PEAR's StationAgentLoop ran with its
// stand-in client on its stepped stand-in SO-101 (tools/fixtures/agent_fixtures.py, LoopRun), run here with the real
// thing on both sides of the turn loop: src/agent's loop, a scripted model, and pear.js's own SO101Robot on the
// stand-in arm (tests/agent/loop.test.ts runs them on a robot that only plays PEAR's answers back).
//
// What must be PEAR's: every call the loop makes of the robot with what it returned or threw, every event in
// order, what the model was shown, each turn's result and its report text, the session afterwards; and, from
// agent_rig.json.gz (the same tasks run again by tools/fixtures/robot_fixtures.py with the rig recorded), every
// control period with what the driver was asked, the UUIDs the robot drew, what its kinematics were asked, and its
// status with the snapshot at each step's end. One clock runs through all 19 tasks, as in PEAR's run.
//
// As in sessions.test.ts, the kinematics answer what PEAR's answered and Ruckig's inexact C library functions
// answer from libm.json, so every number must be the same double.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { StationAgentLoop } from "../../src/agent/agent_loop";
import { sleep as timerSleep } from "../../src/agent/clock";
import { modelOutput, modelOutputRecord, type EventData, type EventHandler, type ModelInput, type ModelOutput } from "../../src/agent/clients/schemas";
import { SINGLE_ARM_POSE_FORMAT } from "../../src/agent/formats";
import { resultRecord, type ActionPhase, type AgentRobot, type ControlSnapshot, type Observation } from "../../src/agent/robot";
import { isValueError, pythonErrorMessage, pythonErrorName, RuntimeError } from "../../src/python/errors";
import type { ModelState, MotionResult, MotionStatus, SingleArmDelta } from "../../src/protocol/types";
import { SO101Robot } from "../../src/so101/robot";
import { OperatorPaused } from "../../src/station/exceptions";
import { AgentRobotAdapter } from "../../src/station/robot";
import { expectOutcome, outcomeOf } from "../agent/client_scenarios";
import { bytesOf, loadFixture as loadAgentFixture, type RecordedImage, type RecordedOutcome } from "../agent/fixtures";
import { frameBytes, makeError as makeModelError, ScriptedClient, type ErrorSpec, type ResultRecord, type TraceEntry } from "../agent/stand_ins";
import { installOracle, type Oracle } from "../ruckig/oracle";
import { Comparison, plain } from "../station-loop/compare";
import { Probe, replaced, StandInSO101Driver, type StandInClock } from "../station-loop/standins";
import { DIRECTORY, loadFixture, stationOf, type Outcome } from "./fixtures";
import { RecordingClock, StandInCameras, SteppedStandInSO101Robot, type DrawnFrame, type KinematicsRecord, type RigHooks, type TickRecord } from "./rig";
import { LAYOUT } from "../../src/so101/layout";

const MISSING = "the port asked for arguments libm.json does not hold: add them (see tests/ruckig/oracle.ts) and run again";
/** What PEAR's console records of a pause (pear/deploy/station/gui/console/task_run.py). */
const CONSOLE_PAUSE = "The operator interrupted this turn; remaining motion was cancelled.";
/** The longest the script waits, on the machine's clock, for the loop (LoopRun.WAIT_S). */
const WAIT_S = 20.0;

type ModelOperation =
  | { emit: [string, EventData] }
  | { return: { answer: string; reasoning: string; reasoning_kind: string; usage: EventData } }
  | { raise: ErrorSpec }
  | { do: string; seconds?: number; times?: number; message?: string; joint?: number; offset?: number; velocity?: number };

interface Hook {
  on: string;
  phase?: string;
  do: string;
  message?: string;
}

interface RecordedInput {
  text: string;
  images: Array<{ camera_name: string; uuid: string; name: string; is_jpeg: boolean }>;
  reference_images: string[];
}

interface LoopStep {
  op: "step" | "record_interruption" | "recover" | "settle" | "close";
  attempt_id?: string;
  model?: ModelOperation[];
  hooks?: Hook[];
  arm?: Record<string, unknown>;
  cancelled_before?: boolean;
  outcome?: RecordedOutcome;
  model_inputs?: RecordedInput[];
  nested?: RecordedOutcome[];
  holding?: { checked: boolean; raised: ErrorSpec | null };
  trace: TraceEntry[];
  state: Record<string, unknown>;
}

interface LoopScenario {
  name: string;
  about: string;
  timeout_s: number;
  reference_images?: RecordedImage[];
  session_id: string;
  action_mode: string;
  control_period_s: number;
  episode_id: string;
  client_label: string;
  steps: LoopStep[];
}

/** What tools/fixtures/robot_fixtures.py recorded of the rig between two points of a task. */
interface RigPiece {
  ticks: TickRecord[];
  io: unknown[];
  uuids?: string[];
  ik?: KinematicsRecord[];
  after?: { status: unknown; requested: number[] | null };
}

interface RigScenario {
  name: string;
  open: RigPiece;
  steps: RigPiece[];
  close: RigPiece;
}

const scenarios = loadAgentFixture<{ scenarios: LoopScenario[] }>("loop.json").scenarios;
const rigRecord = loadFixture<{ station: string; start_s: number; scenarios: RigScenario[] }>("agent_rig.json.gz");

/** The rig under the robot of one task: PEAR's recorded UUIDs and kinematics answers, and the driver's calls. */
class TaskRig implements RigHooks {
  probe: Probe | null = null;
  uuidQueue: string[] = [];
  uuids: string[] = [];
  answers: KinematicsRecord[] = [];
  asks: KinematicsRecord[] = [];

  constructor(
    readonly clock: RecordingClock,
    readonly periodS: number,
  ) {
    clock.takeIo = () => this.probe?.take() ?? [];
  }

  attach(driver: StandInSO101Driver): void {
    this.probe = new Probe(driver, LAYOUT, this.clock as unknown as StandInClock, "so101", this.periodS);
  }

  recordedTarget(): Outcome<number[]> | null {
    const answer = this.answers.shift();
    if (answer === undefined) {
      return { error: { type: "RuntimeError", message: "PEAR's kinematics were not asked here", is_value_error: false } };
    }
    return answer.out;
  }

  asked(record: KinematicsRecord): void {
    this.asks.push(record);
  }

  nextUuid(): string {
    const value = this.uuidQueue.shift() ?? `a UUID PEAR's robot did not draw (${this.uuids.length + 1})`;
    this.uuids.push(value);
    return value;
  }

  /** Has the robot draw the UUIDs and its kinematics give the answers of the piece that begins. */
  begin(piece: RigPiece): void {
    this.uuidQueue = [...(piece.uuids ?? [])];
    this.answers = [...(piece.ik ?? [])];
  }

  /** What happened on the rig since the last time (`cut` of the fixture script). */
  cut(): RigPiece {
    const piece: RigPiece = { ticks: this.clock.take(), io: this.probe?.take() ?? [] };
    if (this.uuids.length > 0) {
      piece.uuids = this.uuids;
    }
    if (this.asks.length > 0) {
      piece.ik = this.asks;
    }
    this.uuids = [];
    this.asks = [];
    return piece;
  }
}

/** What a fixture's trace keeps of an error a call of the robot raised (compared: its class, its message, whether
 * it is a ValueError, and what it recorded). */
function raisedRecord(error: unknown): Record<string, unknown> {
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

/** PEAR's record of a raised error, reduced to what `raisedRecord` holds. */
function comparable(raised: Record<string, unknown>): Record<string, unknown> {
  const record: Record<string, unknown> = { type: raised["type"], message: raised["message"], is_value_error: raised["is_value_error"] };
  if (raised["details"] !== undefined) {
    record["details"] = raised["details"];
  }
  return record;
}

/** The fields of an observation as the turn loop holds it, in the order of PEAR's dictionary. */
const HELD_OBSERVATION_FIELDS = [
  "observationId",
  "sessionId",
  "capturedMonotonicS",
  "jointPositions",
  "images",
  "cameraTimestamps",
  "controlSnapshot",
];

/**
 * The robot the loop drives, with every call it makes joining the trace of the step that runs with what it
 * returned or threw (`LoopRun.logged` of tools/fixtures/agent_fixtures.py); the checks of the hold while the model
 * works are counted apart.
 */
class TracedRobot implements AgentRobot<ModelState, SingleArmDelta> {
  trace: unknown[] = [];
  holdCalls = 0;
  holdRaised: Record<string, unknown> | null = null;

  constructor(private readonly robot: AgentRobotAdapter<ModelState, SingleArmDelta, DrawnFrame | Uint8Array>) {}

  get actionMode(): string {
    return this.robot.actionMode;
  }
  get sessionId(): string | null {
    return this.robot.sessionId;
  }
  get controlPeriodS(): number {
    return this.robot.controlPeriodS;
  }
  get lastErrorDiagnostics(): EventData | null {
    return this.robot.lastErrorDiagnostics as EventData | null;
  }

  begin(): void {
    this.trace = [];
    this.holdCalls = 0;
    this.holdRaised = null;
  }

  private async logged<Value>(
    entry: Record<string, unknown>,
    call: () => Value | Promise<Value>,
    returned: (value: Value) => Record<string, unknown>,
  ): Promise<Value> {
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
      this.trace.push(["robot", entry]);
    }
  }

  waitStationary(observation?: Observation | null, options?: { cancellation?: AbortSignal | null }): Promise<ControlSnapshot> {
    const entry = {
      call: "wait_stationary",
      observation: observation?.observationId ?? null,
      cancellation: (options?.cancellation ?? null) !== null,
    };
    return this.logged(entry, () => this.robot.waitStationary(observation ?? null, options ?? {}), () => ({}));
  }

  observe(): Promise<Observation> {
    return this.logged({ call: "observe" }, () => this.robot.observe(), (value) => {
      // the observation is the loop's: exactly its seven fields, a frame's stamps under the names the loop reads
      expect(Object.keys(value)).toEqual(HELD_OBSERVATION_FIELDS);
      for (const stamps of Object.values(value.cameraTimestamps)) {
        expect(Object.keys(stamps)).toEqual(["receivedMonotonicS", "frameNumber"]);
      }
      return {
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
      };
    });
  }

  modelState(jointPositions: readonly number[], formatName: string): Promise<ModelState> {
    const entry = { call: "model_state", joint_positions: [...jointPositions], format_name: formatName };
    return this.logged(entry, () => this.robot.modelState(jointPositions, formatName), (value) => ({ returned: plain(value) }));
  }

  isHolding(observation: Observation): boolean {
    this.holdCalls += 1;
    try {
      return this.robot.isHolding(observation);
    } catch (error) {
      this.holdRaised = raisedRecord(error);
      throw error;
    }
  }

  stop(): Promise<void> {
    return this.logged({ call: "stop" }, () => this.robot.stop(), () => ({}));
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
    const entry = {
      call: "execute",
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
      entry,
      () => this.robot.execute(action, { ...options, reportProgress: report }),
      (value) => ({ returned: resultRecord(value), diagnostics: plain(this.robot.lastErrorDiagnostics) }),
    );
  }

  failureResult(
    error: unknown,
    options: { formatName: string; status?: MotionStatus; snapshot?: ControlSnapshot | null },
  ): Promise<MotionResult> {
    const entry = {
      call: "failure_result",
      error: { type: pythonErrorName(error), message: pythonErrorMessage(error) },
      format_name: options.formatName,
      status: options.status ?? null,
      snapshot: (options.snapshot ?? null) !== null,
    };
    return this.logged(entry, () => this.robot.failureResult(error, options), (value) => ({ returned: resultRecord(value) }));
  }
}

/** What a scripted model's operations act on, each waited for (PEAR's model works in a thread, which they block). */
interface TaskContext {
  act(operation: { do: string; [field: string]: unknown }): Promise<void> | void;
}

/** The stand-in model of the agent's tests, whose script acts on the real rig. */
class RiggedClient extends ScriptedClient {
  task: TaskContext | null = null;

  protected override async inferAsync(modelInput: ModelInput, onEvent: EventHandler, cancellation: AbortSignal): Promise<ModelOutput> {
    this.modelInputs.push(modelInput);

    for (const operation of this.script as ModelOperation[]) {
      if ("emit" in operation) {
        onEvent(operation.emit[0] as Parameters<EventHandler>[0], structuredClone(operation.emit[1]));
      } else if ("return" in operation) {
        const output = operation.return;
        return modelOutput(output.answer, output.reasoning, output.reasoning_kind, output.usage);
      } else if ("raise" in operation) {
        throw makeModelError(operation.raise);
      } else if (operation.do === "wait_stop") {
        await new Promise<void>((resolve, reject) => {
          if (cancellation.aborted) {
            resolve();
            return;
          }
          const timer = setTimeout(() => reject(new Error("the loop did not stop the request")), WAIT_S * 1000);
          cancellation.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      } else {
        await this.task!.act(operation);
      }
      await Promise.resolve(); // (the model works in a thread of its own: what it reports is heard at once)
    }

    throw new Error("a model's script ends with what it returns or raises");
  }
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

async function resultOutcome(call: () => Promise<MotionResult> | MotionResult): Promise<RecordedOutcome> {
  return outcomeOf(async () => resultRecord(await call()));
}

/** What the comparison of the rig counts over all tasks. */
interface Tally {
  pieces: number;
  ticks: number;
  differing: string[];
}

async function runScenario(
  scenario: LoopScenario,
  recorded: RigScenario,
  clock: RecordingClock,
  comparison: Comparison,
  tally: Tally,
): Promise<void> {
  const station = stationOf(rigRecord.station);
  const rig = new TaskRig(clock, station.controlConfig.controlPeriodS);
  const compare = (piece: RigPiece, expected: RigPiece, where: string): void => {
    tally.pieces += 1;
    tally.ticks += piece.ticks.length;
    const difference = comparison.difference(piece, expected, "");
    if (difference !== null) {
      tally.differing.push(`${scenario.name}, ${where}: ${difference}`);
    }
    expect(difference, `${where}: the rig`).toBeNull();
  };

  rig.begin(recorded.open);
  const robot = new SteppedStandInSO101Robot(station.config, {
    cameras: new StandInCameras(SO101Robot.CAMERAS, clock),
    clock,
    uuid4: () => rig.nextUuid(),
  });
  robot.rig = rig;
  await robot.open();
  clock.controlLoop = robot.controlLoop;
  const arm = robot.arm;

  try {
    const traced = new TracedRobot(
      new AgentRobotAdapter(robot, (_frame, role, observation) => frameBytes(observation.observation_id, role)),
    );
    const client = new RiggedClient("system", { timeoutS: 60 });
    // the session's identity, then the UUID of each frame a turn was given, as PEAR drew them
    const uuids = [
      scenario.episode_id,
      ...scenario.steps.flatMap((step) =>
        step.trace.flatMap((entry) =>
          entry[0] === "event" && entry[1] === "observation" ? Object.values(entry[2].image_uuids as object) : [],
        ),
      ),
    ] as string[];
    const references = scenario.reference_images ?? [];
    const session = new StationAgentLoop(traced, client, {
      actionFormat: SINGLE_ARM_POSE_FORMAT,
      timeoutS: scenario.timeout_s,
      referenceImages: references.map((image) => ({ bytes: bytesOf(image.data), uuid: image.uuid })),
      uuid: () => uuids.shift() ?? "no UUID left",
      // PEAR's loop reads the clock the robot reads; a wait that only looks whether the model has answered is on
      // the machine's timers (PEAR: a queue's timeout), a wait for the arm is a sleep of the station's clock
      clock: () => clock.now,
      sleep: (seconds, wake) => (wake !== undefined ? timerSleep(seconds, wake) : clock.sleep(seconds)),
    });
    expect(session.episodeId).toBe(scenario.episode_id);
    expect({ session_id: robot.sessionId, action_mode: robot.actionMode, control_period_s: robot.controlPeriodS }).toEqual({
      session_id: scenario.session_id,
      action_mode: scenario.action_mode,
      control_period_s: scenario.control_period_s,
    });
    compare(rig.cut(), recorded.open, "open");

    for (const [index, step] of scenario.steps.entries()) {
      const where = `step ${index} (${step.op})`;
      rig.begin(recorded.steps[index]!);
      traced.begin();
      const inputsBefore = client.modelInputs.length;
      let outcome: RecordedOutcome | undefined;
      const nested: Array<Promise<RecordedOutcome>> = [];
      const cancellation = new AbortController();

      // what a script or a hook does to the rig (`act` of LoopRun.run)
      const act = (operation: { do: string; [field: string]: unknown }): Promise<void> | void => {
        const action = operation.do;
        if (action === "pause") {
          cancellation.abort();
        } else if (action === "advance_clock") {
          return (async () => {
            for (let count = 0; count < (operation["times"] as number); count++) {
              await clock.sleep(operation["seconds"] as number); // time passes and the control loop steps
            }
          })();
        } else if (action === "wait_watch") {
          // until the loop has looked at the hold once: it watches the request from then on
          return (async () => {
            const deadline = Date.now() + WAIT_S * 1000;
            while (traced.holdCalls === 0) {
              if (Date.now() > deadline) {
                throw new Error("the loop did not watch the request");
              }
              await new Promise((resolve) => setTimeout(resolve, 1));
            }
          })();
        } else if (action === "change_session") {
          robot.sessionId = "another-session";
        } else if (action === "advance_generation") {
          robot.controlLoop.generation += 1;
        } else if (action === "close_robot") {
          return robot.close();
        } else if (action === "arm_failure") {
          arm.failure = new RuntimeError(operation["message"] as string);
        } else if (action === "move_arm") {
          // the arm is pushed: its reading moves and shows a velocity, at every reading from now on
          const joint = operation["joint"] as number;
          const position = [...arm.position];
          position[joint]! += operation["offset"] as number;
          arm.position = position;
          const read = arm.read.bind(arm);
          arm.read = async () => {
            const state = await read();
            const velocity = state.velocity.map(() => 0.0);
            velocity[joint] = operation["velocity"] as number;
            return replaced(state, { velocity });
          };
        } else if (action === "step") {
          nested.push(
            resultOutcome(() =>
              session.step({ cancellation: new AbortController().signal, onEvent: () => undefined, attemptId: "nested" }),
            ),
          );
        } else {
          throw new Error(`unknown action ${action}`);
        }
      };

      if (step.op === "step") {
        const settings: Record<string, string> = { blocked_gripper_opening: "blockedGripperOpening", is_stale: "isStale" };
        for (const [setting, value] of Object.entries(step.arm ?? {})) {
          (arm as unknown as Record<string, unknown>)[settings[setting]!] = value;
        }
        if (step.cancelled_before) {
          cancellation.abort();
        }
        client.script = step.model as never;
        client.task = { act };
        const onEvent = (kind: string, data: EventData): void => {
          traced.trace.push(["event", kind, structuredClone(data)]);
          let acting: Promise<void> | void = undefined;
          for (const hook of step.hooks ?? []) {
            if (hook.on === kind && (hook.phase === undefined || data.phase === hook.phase)) {
              acting = act(hook as unknown as { do: string; [field: string]: unknown });
            }
          }
          // (a hook that takes time is waited for by the robot that reported the phase, as PEAR's thread is held)
          return acting as void;
        };
        outcome = await resultOutcome(() =>
          session.step({ cancellation: cancellation.signal, onEvent, attemptId: step.attempt_id! }),
        );
      } else if (step.op === "record_interruption") {
        // as PEAR's console records an operator's pause of a turn whose model request was made
        await robot.waitSettled(WAIT_S);
        outcome = await resultOutcome(async () =>
          session.record(await session.failureResult(new OperatorPaused(CONSOLE_PAUSE))),
        );
      } else if (step.op === "recover") {
        // as the operator recovers a robot from a fault, before the task goes on
        arm.failure = null;
        await robot.recover();
        await robot.waitSettled(WAIT_S);
      } else if (step.op === "settle") {
        await robot.waitSettled(WAIT_S);
      } else if (step.op === "close") {
        outcome = await outcomeOf(() => session.close());
      }

      if (step.outcome !== undefined) {
        expectOutcome(outcome!, step.outcome, where);
      }
      // what the loop asked of the robot and reported: every entry PEAR's, an error by what the loop reads of it
      const expectedTrace = step.trace.map((entry) =>
        entry[0] === "robot" && entry[1].raised !== undefined
          ? ["robot", { ...entry[1], raised: comparable(entry[1].raised as unknown as Record<string, unknown>) }]
          : entry,
      );
      expect(traced.trace, `${where}: what the loop asked of the robot and reported`).toEqual(expectedTrace);
      if (step.op === "step") {
        const inputs = client.modelInputs.slice(inputsBefore);
        expect(inputs.map(inputRecord), `${where}: what the model was shown`).toEqual(step.model_inputs);
        for (const input of inputs) {
          // a turn carries the observation's own frame
          const observationId = (step.state["last_turn"] as { observation_id: string }).observation_id;
          expect(input.images.map((image) => image.bytes)).toEqual(
            input.images.map((image) => frameBytes(observationId, image.cameraName)),
          );
        }
        expect(traced.holdCalls > 0, `${where}: whether the hold was checked`).toBe(step.holding!.checked);
        const raised = step.holding!.raised === null ? null : comparable(step.holding!.raised as unknown as Record<string, unknown>);
        expect(traced.holdRaised, `${where}: what the check of the hold raised`).toEqual(raised);
        const nestedOutcomes = await Promise.all(nested);
        (step.nested ?? []).forEach((expected, position) => expectOutcome(nestedOutcomes[position]!, expected, where));
        expect(nestedOutcomes.length).toBe((step.nested ?? []).length);
      }

      const turn = session.lastTurn;
      expect(
        {
          turn_count: session.turnCount,
          blocked_reason: session.blockedReason,
          feedback: (session as unknown as { feedback: string | null }).feedback,
          previous_result: session.previousResult ? resultRecord(session.previousResult) : null,
          last_turn:
            turn === null
              ? null
              : {
                  attempt_id: turn.attemptId,
                  observation_id: turn.observation.observationId,
                  is_dispatched: turn.isDispatched,
                  model_output: turn.modelOutput ? modelOutputRecord(turn.modelOutput) : null,
                  station_result: turn.stationResult ? resultRecord(turn.stationResult) : null,
                },
        },
        `${where}: the session afterwards`,
      ).toEqual(step.state);

      const piece = rig.cut();
      const controlLoop = robot.openLoop;
      piece.after = {
        status: plain(robot.status(true)),
        requested: controlLoop === null ? null : (plain(controlLoop.requestedPosition()) as number[]),
      };
      compare(piece, recorded.steps[index]!, where);
    }
    expect(uuids, "UUIDs PEAR drew that the loop did not").toEqual([]);
  } finally {
    rig.begin(recorded.close);
    clock.afterTick = null;
    clock.controlLoop = null;
    await robot.close();
  }
  compare(rig.cut(), recorded.close, "close");
}

describe("the 19 tasks with pear.js's own robot under the turn loop", () => {
  let oracle: Oracle;
  const comparison = new Comparison(true);
  const clock = new RecordingClock();
  const tally: Tally = { pieces: 0, ticks: 0, differing: [] };
  let turns = 0;

  beforeAll(() => {
    oracle = installOracle(DIRECTORY);
    clock.now = rigRecord.start_s;
  });
  afterAll(() => {
    console.info(`libm.json: ${oracle.size} values; ${oracle.hits()} calls answered from it, ${oracle.missing()} arguments missing`);
    oracle.close();
  });

  // in PEAR's order: one clock runs through every task and is never set back
  scenarios.forEach((scenario, index) => {
    test(`task ${index + 1}: ${scenario.name}`, { timeout: 120_000 }, async () => {
      const recorded = rigRecord.scenarios[index]!;
      expect(recorded.name).toBe(scenario.name);
      expect(recorded.steps.length).toBe(scenario.steps.length);
      turns += scenario.steps.filter((step) => step.op === "step").length;
      await runScenario(scenario, recorded, clock, comparison, tally);
    });
  });

  test("every task, every control period, and every number of the rig the same double", () => {
    const expectedPieces = rigRecord.scenarios.reduce((sum, scenario) => sum + scenario.steps.length + 2, 0);
    const expectedTicks = rigRecord.scenarios.reduce(
      (sum, scenario) => sum + [scenario.open, ...scenario.steps, scenario.close].reduce((inner, piece) => inner + piece.ticks.length, 0),
      0,
    );
    console.info(
      `capstone: ${scenarios.length} tasks, ${turns} turns, ${tally.pieces} of ${expectedPieces} pieces of the rig, ` +
        `${tally.ticks} of ${expectedTicks} control periods, ${tally.differing.length} differ; ${comparison.summary()}`,
    );
    if (process.env.PEAR_JS_ROBOT_REPORT) {
      console.info(tally.differing.map((difference) => `  ${difference.slice(0, 900)}`).join("\n"));
    }

    expect(scenarios.length).toBe(19);
    expect(turns).toBe(60);
    expect(tally.differing).toEqual([]);
    expect(tally.pieces).toBe(expectedPieces);
    expect(tally.ticks).toBe(expectedTicks);
    expect(comparison.identical).toBe(comparison.numbers);
  });

  test("the table of the reference's C library values held every argument the port asked for", () => {
    expect(oracle.missing(), MISSING).toBe(0);
  });
});
