// Ports pear/deploy/station/agent_loop/agent_loop.py: Turn, ModelCall and StationAgentLoop, a task's model session
// on a robot. Each step observes, asks the model, reads the action of its answer and has the robot execute it; the
// conversation itself is the client's.
//
// PEAR's step blocks its thread and runs the model's request in a worker thread, which the caller's thread watches;
// here a step is an async function and the request a promise, watched in the same order: the same calls of the
// robot, the same events, the same results and errors. The operator's pause is an AbortSignal.

import { PythonError } from "../protocol/python_json";
import { MotionStatus, type ModelState, type MotionResult, type SingleArmDelta } from "../protocol/types";
import { ContextLimit, ModelClient, SessionLost } from "./clients/client";
import {
  ModelEvent,
  ModelPhase,
  modelOutputRecord,
  type ModelInput,
  type ModelOutput,
  type ReferenceImage,
} from "./clients/schemas";
import { monotonic, sleep, type Clock, type Sleep } from "./clock";
import {
  isValueError,
  OperatorPaused,
  pythonErrorName,
  RuntimeError,
  TimeoutError,
  ValueError,
} from "./exceptions";
import { ObservationMessage, uuid4 } from "./messages";
import {
  ActionMode,
  resultRecord,
  type ActionFormat,
  type AgentRobot,
  type ControlSnapshot,
  type Observation,
} from "./robot";
import { TurnEvent, TurnPhase, type TurnEventHandler } from "./schemas";

/** One turn: the robot's observation, what the model was shown, its answer, the robot's result of its action and
 * whether the action went to the robot. */
export interface Turn {
  /** What the turn's events and files are known by. */
  readonly attemptId: string;
  /** The robot's observation the turn's input was made from. */
  readonly observation: Observation;
  readonly modelInput: ModelInput;
  /** Null until the model has answered. */
  modelOutput: ModelOutput | null;
  /** The robot's result of the turn's action; null until it has one. */
  stationResult: MotionResult | null;
  /** Whether the action went to the robot. */
  isDispatched: boolean;
}

/** What the robot of a model call must do: the part of AgentRobot the call uses. */
export type HoldingRobot = Pick<AgentRobot<never, never>, "controlPeriodS" | "waitStationary" | "isHolding" | "stop">;

/** Whether ``error`` is PEAR's OperatorPaused, of this module or under that name from another one. */
function isOperatorPaused(error: unknown): boolean {
  return error instanceof OperatorPaused || pythonErrorName(error) === "OperatorPaused";
}

/**
 * A model request, watched until its answer arrives while the arms hold the observed pose, settled; the operator's
 * pause, its deadline and arms that leave the pose stop it.
 */
export class ModelCall {
  // what the request ended with, once it has: the answer, or the error that ended it
  private queuedResult: { hasAnswer: true; answer: ModelOutput } | { hasAnswer: false; error: unknown } | null = null;
  // the result once the watch has taken it
  private receivedResult: ModelCall["queuedResult"] = null;
  private readonly timeoutS: number;
  private readonly cancellation: AbortSignal;
  private readonly abort: () => void;
  private readonly clock: Clock;
  private readonly sleep: Sleep;

  constructor(
    private readonly robot: HoldingRobot,
    /** The arms hold its pose, settled, while the model works. */
    private readonly referenceObservation: Observation,
    /** Makes the request and returns the model's answer. */
    private readonly call: () => Promise<ModelOutput>,
    options: {
      /** How long the model may take, s. */
      timeoutS: number;
      /** The operator's pause. */
      cancellation: AbortSignal;
      /** Stops the request. */
      abort: () => void;
      clock?: Clock | undefined;
      sleep?: Sleep | undefined;
    },
  ) {
    this.timeoutS = options.timeoutS;
    this.cancellation = options.cancellation;
    this.abort = options.abort;
    this.clock = options.clock ?? monotonic;
    this.sleep = options.sleep ?? sleep;
  }

  /** Returns the model's answer once it has arrived while the arms still hold the reference pose, settled. */
  async run(): Promise<ModelOutput> {
    OperatorPaused.checkCancelled(this.cancellation);
    await this.robot.waitStationary(this.referenceObservation, { cancellation: this.cancellation });
    const worker = this.work();

    try {
      return await this.monitor(worker);
    } catch (error) {
      await this.stop(worker, error);
      throw error;
    }
  }

  /** Makes the request and keeps its answer, or the error that ended it; resolves once it has ended. */
  private async work(): Promise<void> {
    try {
      this.queuedResult = { hasAnswer: true, answer: await this.call() };
    } catch (error) {
      this.queuedResult = { hasAnswer: false, error };
    }
  }

  /** Returns the answer once it has arrived and the arms hold the reference pose, settled; throws the request's
   * error, and throws at the operator's pause, at the deadline and once the arms no longer hold the pose. */
  private async monitor(worker: Promise<void>): Promise<ModelOutput> {
    const controlPeriodS = this.robot.controlPeriodS;
    const deadline = this.clock() + this.timeoutS;

    for (;;) {
      OperatorPaused.checkCancelled(this.cancellation);
      const isHolding = await this.robot.isHolding(this.referenceObservation);
      const remainingS = deadline - this.clock();
      if (remainingS <= 0) {
        throw new TimeoutError("Model request timed out; no action will execute");
      }

      if (this.receivedResult !== null) {
        if (!this.receivedResult.hasAnswer) {
          throw this.receivedResult.error;
        }
        if (isHolding) {
          return this.receivedResult.answer;
        }
        await this.sleep(Math.min(controlPeriodS, remainingS));
        continue;
      }

      await this.waitEnded(worker, Math.min(controlPeriodS, remainingS));
      this.receivedResult = this.queuedResult;
    }
  }

  /** Waits until the request has ended, at most ``seconds``, and returns whether it has. */
  private async waitEnded(worker: Promise<void>, seconds: number): Promise<boolean> {
    if (this.queuedResult === null) {
      const wake = new AbortController();
      await Promise.race([worker, this.sleep(seconds, wake.signal)]);
      wake.abort();
    }

    return this.queuedResult !== null;
  }

  /** Stops the arms and the request and waits for the request to end; throws SessionLost when it does not end or
   * when it lost the model's conversation. */
  private async stop(worker: Promise<void>, error: unknown): Promise<void> {
    await this.robot.stop();
    this.abort();
    if (!(await this.waitEnded(worker, ModelClient.CLEANUP_TIMEOUT_S))) {
      throw new SessionLost("Model worker did not stop; clear the task before continuing", { cause: error });
    }

    // a pause must not hide that the request lost the model's conversation
    if (this.receivedResult === null) {
      this.receivedResult = this.queuedResult;
    }
    if (
      this.receivedResult !== null &&
      !this.receivedResult.hasAnswer &&
      this.receivedResult.error instanceof SessionLost
    ) {
      throw this.receivedResult.error;
    }
  }
}

/** What a model session is made with, beside its robot and its client. */
export interface StationAgentLoopOptions<State, Action> {
  actionFormat: ActionFormat<State, Action>;
  /** How long the model may take to answer a turn, s. */
  timeoutS: number;
  /** The task's images, in every turn's input; a client sends them once. */
  referenceImages?: readonly ReferenceImage[];
  /** What gives the session's identity and each frame's UUID; by default a random UUID. */
  uuid?: () => string;
  /** The loop's monotonic clock, in seconds; by default the machine's. */
  clock?: Clock;
  /** The loop's waits; by default the machine's timers. */
  sleep?: Sleep;
}

/**
 * A task's model session on a robot: each step observes, asks the model, reads the action of its answer and has
 * the robot execute it; the conversation itself is the client's.
 */
export class StationAgentLoop<State = ModelState, Action = SingleArmDelta> {
  readonly actionFormat: ActionFormat<State, Action>;
  /** How long the model may take to answer a turn, s. */
  readonly timeoutS: number;
  /** The task's images, in every turn's input; a client sends them once. */
  readonly referenceImages: readonly ReferenceImage[];
  /** The session's identity, which its records carry. */
  readonly episodeId: string;
  /** The turns observed so far. */
  turnCount = 0;
  lastTurn: Turn | null = null;
  /** The result of the last turn, told to the model in the next. */
  previousResult: MotionResult | null = null;
  /** Why the session takes no further turn; null while it does. */
  blockedReason: string | null = null;

  private feedback: string | null = null; // what the next turn tells the model of the last result; null: nothing
  private requestCancellation = new AbortController(); // stops the running model request: a new one each step
  private runningStep: Promise<void> | null = null; // settles once the one step that runs has ended
  private readonly uuid: () => string;
  private readonly clock: Clock;
  private readonly sleep: Sleep;

  constructor(
    readonly robot: AgentRobot<State, Action>,
    readonly client: ModelClient,
    options: StationAgentLoopOptions<State, Action>,
  ) {
    if (!Number.isFinite(options.timeoutS) || options.timeoutS <= 0) {
      throw new ValueError("Model timeout must be finite and positive");
    }
    if (robot.actionMode !== ActionMode.CARTESIAN) {
      throw new ValueError(`A model session needs a Cartesian Station, not one in ${robot.actionMode} mode`);
    }
    if (robot.sessionId === null || robot.sessionId === undefined) {
      throw new ValueError("Open a Cartesian Station before creating a model session");
    }

    this.actionFormat = options.actionFormat;
    this.timeoutS = options.timeoutS;
    this.referenceImages = [...(options.referenceImages ?? [])];
    this.uuid = options.uuid ?? uuid4;
    this.clock = options.clock ?? monotonic;
    this.sleep = options.sleep ?? sleep;
    this.episodeId = this.uuid();
  }

  /**
   * Observes, asks the model, reads the action of its answer and has the robot execute it; returns the robot's
   * result, which an action that did not complete has too.
   */
  async step(options: {
    cancellation: AbortSignal;
    onEvent: TurnEventHandler;
    attemptId: string;
  }): Promise<MotionResult> {
    const { cancellation, onEvent, attemptId } = options;
    if (this.runningStep !== null) {
      throw new RuntimeError("A model step is already running");
    }
    let release!: () => void;
    this.runningStep = new Promise((resolve) => {
      release = resolve;
    });
    let turn: Turn | null = null;
    this.requestCancellation = new AbortController();

    try {
      OperatorPaused.checkCancelled(cancellation);
      if (this.blockedReason) {
        throw new ContextLimit(this.blockedReason);
      }
      const [observation, state, modelInput] = await this.observe(attemptId, cancellation, onEvent);
      turn = this.lastTurn = {
        attemptId,
        observation,
        modelInput,
        modelOutput: null,
        stationResult: null,
        isDispatched: false,
      };
      this.turnCount += 1;

      const action = await this.askModel(turn, observation, state, cancellation, onEvent);

      return await this.dispatch(turn, action, observation, cancellation, onEvent);
    } catch (error) {
      if (error instanceof ContextLimit || error instanceof SessionLost) {
        this.blockedReason = error.message;
        await this.robot.stop();
        throw error;
      }
      if (isOperatorPaused(error)) {
        await this.robot.stop();
        if (turn !== null) {
          this.record(await this.failureResult(error));
        }
        throw error;
      }

      await this.robot.stop();
      const details = (error as { details?: unknown } | null)?.details;
      if (isRecord(details) && Object.keys(details).length > 0) {
        onEvent(TurnEvent.DIAGNOSTIC, details);
      }
      if (turn === null) {
        throw error;
      }
      const status = isValueError(error) ? MotionStatus.REJECTED : MotionStatus.FAILED;

      return this.record(await this.failureResult(error, { status }));
    } finally {
      this.runningStep = null;
      release();
    }
  }

  /** Returns the result of the turn's action that did not complete, measured at ``snapshot`` (by default now). */
  async failureResult(
    error: unknown,
    options: { status?: MotionStatus; snapshot?: ControlSnapshot | null } = {},
  ): Promise<MotionResult> {
    return await this.robot.failureResult(error, {
      formatName: this.actionFormat.name,
      status: options.status ?? MotionStatus.FAILED,
      snapshot: options.snapshot ?? null,
    });
  }

  /** Keeps ``result`` as the last turn's, which the next turn tells the model of, and returns it. */
  record(result: MotionResult): MotionResult {
    const lastTurn = this.lastTurn;
    if (lastTurn === null) {
      // (what Python raises of a session that has observed no turn yet)
      throw new PythonError("AttributeError", "'NoneType' object has no attribute 'station_result'", false);
    }
    lastTurn.stationResult = result;
    this.previousResult = result;
    this.feedback = this.actionFormat.resultFeedback(result, { isDispatched: lastTurn.isDispatched });

    return result;
  }

  /** Stops the running model request, waits for the step to end and closes the client. */
  async close(): Promise<void> {
    this.client.cancel();
    if (this.runningStep !== null) {
      const wake = new AbortController();
      await Promise.race([this.runningStep, this.sleep(ModelClient.CLEANUP_TIMEOUT_S, wake.signal)]);
      wake.abort();
      if (this.runningStep !== null) {
        throw new RuntimeError("Model step still running; cleanup incomplete");
      }
    }

    await this.client.close();
  }

  /** Returns the observation of the arms at rest, the state the model reads of it and the turn's input for the
   * model. */
  private async observe(
    attemptId: string,
    cancellation: AbortSignal,
    onEvent: TurnEventHandler,
  ): Promise<[Observation, State, ModelInput]> {
    onEvent(ModelEvent.PHASE, { phase: TurnPhase.OBSERVING });
    await this.robot.waitStationary(null, { cancellation });
    const observation = await this.robot.observe();
    const state = await this.robot.modelState(observation.jointPositions, this.actionFormat.name);
    const modelInput = ObservationMessage.build(
      observation,
      state,
      this.actionFormat,
      attemptId,
      this.feedback,
      this.referenceImages,
      this.uuid,
    );

    return [observation, state, modelInput];
  }

  /** Reports what the model is shown, asks the model and returns the action of its answer. */
  private async askModel(
    turn: Turn,
    observation: Observation,
    state: State,
    cancellation: AbortSignal,
    onEvent: TurnEventHandler,
  ): Promise<Action> {
    OperatorPaused.checkCancelled(cancellation);
    onEvent(TurnEvent.OBSERVATION, {
      turn_id: turn.attemptId,
      observation_id: observation.observationId,
      captured_monotonic_s: observation.capturedMonotonicS,
      state,
      text: turn.modelInput.text,
      // (in PEAR, the path of each frame's file; here its name)
      images: Object.fromEntries(turn.modelInput.images.map((image) => [image.cameraName, image.name])),
      image_uuids: Object.fromEntries(turn.modelInput.images.map((image) => [image.cameraName, image.uuid])),
      previous_result: this.previousResult ? resultRecord(this.previousResult) : null,
    });
    onEvent(ModelEvent.PHASE, { phase: ModelPhase.THINKING });

    const modelOutput = await new ModelCall(this.robot, observation, () => this.infer(turn, onEvent), {
      timeoutS: this.timeoutS,
      cancellation,
      abort: () => this.abort(),
      clock: this.clock,
      sleep: this.sleep,
    }).run();
    onEvent(TurnEvent.MODEL_OUTPUT, modelOutputRecord(modelOutput));
    OperatorPaused.checkCancelled(cancellation);

    return this.actionFormat.parseAction(modelOutput.answer);
  }

  /** Returns the model's answer to the turn's input, which the turn keeps even when the operator stops it before
   * its action goes to the robot. */
  private async infer(turn: Turn, onEvent: TurnEventHandler): Promise<ModelOutput> {
    turn.modelOutput = await this.client.infer(turn.modelInput, {
      onEvent,
      cancellation: this.requestCancellation.signal,
    });

    return turn.modelOutput;
  }

  /** Stops the running model request: its own cancellation and the client's. */
  private abort(): void {
    this.requestCancellation.abort();
    this.client.cancel();
  }

  /** Has the robot execute ``action`` from the observed pose and returns its result, which the session keeps. */
  private async dispatch(
    turn: Turn,
    action: Action,
    observation: Observation,
    cancellation: AbortSignal,
    onEvent: TurnEventHandler,
  ): Promise<MotionResult> {
    OperatorPaused.checkCancelled(cancellation);
    onEvent(TurnEvent.ACTION, action as Record<string, unknown>);
    OperatorPaused.checkCancelled(cancellation);
    turn.isDispatched = true;
    const result = await this.robot.execute(action, {
      referenceObservation: observation,
      cancellation,
      reportProgress: (phase) => onEvent(ModelEvent.PHASE, { phase }),
    });
    OperatorPaused.checkCancelled(cancellation);
    const diagnostics = this.robot.lastErrorDiagnostics;
    if (diagnostics && Object.keys(diagnostics).length > 0) {
      onEvent(TurnEvent.DIAGNOSTIC, diagnostics);
    }

    return this.record(result);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
