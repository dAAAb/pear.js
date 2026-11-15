// The stand-ins of the agent loop's tests: errors made from a fixture's record of PEAR's, a robot that replays what
// PEAR's stand-in robot did, and a model client that follows a scenario's script (what PEAR's StandInScriptedClient
// was given to do in tools/fixtures/agent_fixtures.py).

import { ContextLimit, ModelClient, SessionLost } from "../../src/agent/clients/client";
import {
  modelOutput,
  type EventData,
  type EventHandler,
  type ModelHealth,
  type ModelInput,
  type ModelOutput,
} from "../../src/agent/clients/schemas";
import {
  OperatorPaused,
  pythonErrorMessage,
  pythonErrorName,
  RuntimeError,
  TimeoutError,
  ValueError,
} from "../../src/agent/exceptions";
import type { ActionPhase, AgentRobot, ControlSnapshot, Observation } from "../../src/agent/robot";
import { PythonError } from "../../src/protocol/python_json";
import type { ModelState, MotionResult, MotionStatus, SingleArmDelta } from "../../src/protocol/types";
import type { RecordedError } from "./fixtures";

/** An error a scenario has a stand-in raise, or PEAR raised: its class's name, its message, whether it is a
 * ValueError and what it recorded. */
export type ErrorSpec = Pick<RecordedError, "type" | "message"> & {
  is_value_error?: boolean;
  details?: EventData;
};

/** Returns the error of ``spec``: pear.js's own class where it has one of that name, otherwise an error that
 * carries the Python class's name. */
export function makeError(spec: ErrorSpec): Error {
  const classes: Record<string, new (message: string) => Error> = {
    ContextLimit,
    SessionLost,
    OperatorPaused,
    ValueError,
    RuntimeError,
    TimeoutError,
  };
  const known = classes[spec.type];
  const error = known
    ? new known(spec.message)
    : new PythonError(spec.type, spec.message, spec.is_value_error ?? false);
  if (spec.details !== undefined) {
    (error as Error & { details?: EventData }).details = spec.details;
  }

  return error;
}

/** A result as PEAR's records keep it (MotionResult.to_record). */
export interface ResultRecord {
  status: MotionStatus;
  settled: boolean;
  reached: boolean;
  measured_position: number[] | null;
  tracking_error: number[] | null;
  measured_state: ModelState | null;
  gripper_outcome: MotionResult["gripperOutcome"];
  error: MotionResult["error"];
}

/** Returns the result a record holds. */
export function resultOf(record: ResultRecord): MotionResult {
  return {
    status: record.status,
    isSettled: record.settled,
    targetReached: record.reached,
    measuredPosition: record.measured_position,
    trackingError: record.tracking_error,
    measuredState: record.measured_state,
    gripperOutcome: record.gripper_outcome,
    error: record.error,
  };
}

/** A call of the robot as a fixture's trace records it: its name, what it was given and what it returned or
 * raised. */
export interface RobotCall {
  call: string;
  raised?: ErrorSpec;
  returned?: unknown;
  [field: string]: unknown;
}

/** One entry of a step's trace: an event, or a call of the robot. */
export type TraceEntry = ["event", string, EventData] | ["robot", RobotCall];

/** The bytes a replayed observation carries as a camera's frame: a JPEG's first marker, the observation's id and
 * the role, a JPEG's last marker. */
export function frameBytes(observationId: string, role: string): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, ...Buffer.from(`${observationId}/${role}`), 0xff, 0xd9]);
}

/**
 * A robot that does what PEAR's stand-in robot did in a recorded step: each call the loop makes joins the trace
 * with what the loop gave it, is checked to be the next one PEAR's loop made, and returns or throws what PEAR's
 * robot did.
 */
export class ReplayRobot implements AgentRobot<ModelState, SingleArmDelta> {
  lastErrorDiagnostics: EventData | null = null;
  /** The trace of the step that runs. */
  trace: TraceEntry[] = [];
  /** What is_holding raises from now on; null: the arm holds. */
  holdingError: ErrorSpec | null = null;
  /** Whether the loop asked whether the arm holds. */
  wasHoldChecked = false;
  private expected: RobotCall[] = [];

  constructor(
    readonly actionMode: string,
    readonly sessionId: string | null,
    readonly controlPeriodS: number,
  ) {}

  /** Starts a step: the calls PEAR's loop made of the robot in it, in order. */
  begin(expected: RobotCall[]): void {
    this.trace = [];
    this.expected = [...expected];
    this.holdingError = null;
    this.wasHoldChecked = false;
  }

  /** The calls of the step that the loop has not made. */
  get callsLeft(): string[] {
    return this.expected.map((call) => call.call);
  }

  waitStationary(observation?: Observation | null, options?: { cancellation?: AbortSignal | null }): ControlSnapshot {
    this.replay({
      call: "wait_stationary",
      observation: observation?.observationId ?? null,
      cancellation: (options?.cancellation ?? null) !== null,
    });

    return {};
  }

  observe(): Observation {
    const recorded = this.replay({ call: "observe" }).returned as {
      observation_id: string;
      session_id: string;
      captured_monotonic_s: number;
      joint_positions: number[];
      camera_timestamps: Record<string, { received_monotonic_s: number; frame_number: number }>;
      image_roles: string[];
    };

    return {
      observationId: recorded.observation_id,
      sessionId: recorded.session_id,
      capturedMonotonicS: recorded.captured_monotonic_s,
      jointPositions: recorded.joint_positions,
      images: Object.fromEntries(
        recorded.image_roles.map((role) => [role, frameBytes(recorded.observation_id, role)]),
      ),
      cameraTimestamps: Object.fromEntries(
        Object.entries(recorded.camera_timestamps).map(([role, stamps]) => [
          role,
          { receivedMonotonicS: stamps.received_monotonic_s, frameNumber: stamps.frame_number },
        ]),
      ),
      controlSnapshot: {},
    };
  }

  modelState(jointPositions: readonly number[], formatName: string): ModelState {
    return this.replay({ call: "model_state", joint_positions: [...jointPositions], format_name: formatName })
      .returned as ModelState;
  }

  isHolding(_observation: Observation): boolean {
    this.wasHoldChecked = true;
    if (this.holdingError !== null) {
      throw makeError(this.holdingError);
    }

    return true;
  }

  stop(): void {
    this.replay({ call: "stop" });
  }

  execute(
    action: SingleArmDelta,
    options: {
      referenceObservation?: Observation | null;
      cancellation?: AbortSignal | null;
      reportProgress?: ((phase: ActionPhase) => void) | null;
    },
  ): MotionResult {
    this.lastErrorDiagnostics = null;
    const recorded = this.replay(
      {
        call: "execute",
        action,
        reference: options.referenceObservation?.observationId ?? null,
        cancellation: (options.cancellation ?? null) !== null,
        progress: [],
      },
      (entry, expected) => {
        // the robot reports its progress before the call ends
        for (const phase of expected.progress as ActionPhase[]) {
          (entry.progress as string[]).push(phase);
          options.reportProgress?.(phase);
        }
        if (expected.returned !== undefined) {
          entry.diagnostics = expected.diagnostics;
        }
      },
    );
    this.lastErrorDiagnostics = (recorded.diagnostics as EventData | null) ?? null;

    return resultOf(recorded.returned as ResultRecord);
  }

  failureResult(
    error: unknown,
    options: { formatName: string; status?: MotionStatus; snapshot?: ControlSnapshot | null },
  ): MotionResult {
    const recorded = this.replay({
      call: "failure_result",
      error: { type: pythonErrorName(error), message: pythonErrorMessage(error) },
      format_name: options.formatName,
      status: options.status ?? null,
      snapshot: (options.snapshot ?? null) !== null,
    });

    return resultOf(recorded.returned as ResultRecord);
  }

  /** Takes the next call PEAR's loop made, which must be this one; the call joins the trace as it ends, with what
   * PEAR's robot returned or raised, which this returns or throws. */
  private replay(entry: RobotCall, during?: (entry: RobotCall, expected: RobotCall) => void): RobotCall {
    const expected = this.expected.shift();
    if (expected === undefined || expected.call !== entry.call) {
      this.trace.push(["robot", entry]);
      throw new Error(`The loop called ${entry.call} of the robot where PEAR's called ${expected?.call ?? "nothing"}`);
    }

    try {
      during?.(entry, expected);
    } finally {
      if (expected.raised !== undefined) {
        entry.raised = expected.raised;
      } else if (expected.returned !== undefined) {
        entry.returned = expected.returned;
      }
      this.trace.push(["robot", entry]);
    }
    if (expected.raised !== undefined) {
      throw makeError(expected.raised);
    }

    return expected;
  }
}

/** One operation of a model's script (see LoopRun in tools/fixtures/agent_fixtures.py). */
export type ModelOperation =
  | { emit: [string, EventData] }
  | { return: { answer: string; reasoning: string; reasoning_kind: string; usage: EventData } }
  | { raise: ErrorSpec }
  | { do: string; seconds?: number; times?: number };

/** What a scripted model's operations act on. */
export interface ScriptContext {
  /** Resolves once the loop watches the request: it has looked at the robot's hold. */
  watched(): Promise<void>;
  /** Sets the operator's cancellation. */
  pause(): void;
  /** Lets ``seconds`` pass on the loop's clock. */
  advanceClock(seconds: number): void;
  /** Has the robot do, from now on, what PEAR's did after the script changed it. */
  changeRobot(): void;
}

/** A stand-in model that follows the script of the step that runs, and keeps every input it was given. */
export class ScriptedClient extends ModelClient {
  static override readonly LABEL: string = "Stand-in";
  /** The longest the script waits for the loop to stop its request, s. */
  static readonly WAIT_S = 20;

  readonly modelInputs: ModelInput[] = [];
  script: ModelOperation[] = [];
  context: ScriptContext | null = null;

  async check(): Promise<ModelHealth> {
    return { status: "ok", message: "Stand-in model: no connection to check" };
  }

  protected async inferAsync(
    modelInput: ModelInput,
    onEvent: EventHandler,
    cancellation: AbortSignal,
  ): Promise<ModelOutput> {
    this.modelInputs.push(modelInput);
    const context = this.context!;

    for (const operation of this.script) {
      if ("emit" in operation) {
        onEvent(operation.emit[0] as Parameters<EventHandler>[0], structuredClone(operation.emit[1]));
      } else if ("return" in operation) {
        const output = operation.return;
        return modelOutput(output.answer, output.reasoning, output.reasoning_kind, output.usage);
      } else if ("raise" in operation) {
        throw makeError(operation.raise);
      } else if (operation.do === "pause") {
        context.pause();
      } else if (operation.do === "advance_clock") {
        context.advanceClock(operation.seconds! * operation.times!);
      } else if (operation.do === "wait_stop") {
        await stopped(cancellation, ScriptedClient.WAIT_S);
      } else if (operation.do === "wait_watch") {
        await context.watched();
      } else {
        context.changeRobot();
      }
      await Promise.resolve(); // (the model works in a thread of its own: what it reports is heard at once)
    }

    throw new Error("A model's script ends with what it returns or raises");
  }
}

/** Resolves once ``signal`` is aborted; throws when it is not within ``seconds``. */
function stopped(signal: AbortSignal, seconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error("The loop did not stop the request")), seconds * 1000);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
