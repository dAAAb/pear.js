// Ports pear/deploy/station/control/robot.py: ActionMode and BaseRobot.
//
// What is not ported of it: reading a station's YAML with OmegaConf (`load_config`; a robot is made from its settings
// as plain objects, as the joint layer's configurations are) and the command line's use of `open_cameras` through a
// device path. What blocks PEAR's thread is asynchronous here (opening and closing, an observation, an action, Home,
// a recovery, a stop, the waits); what only reads the control loop is not (the status, the checks of an
// observation, the planning). PEAR's two locks: the execution lock, which is never waited for, is a flag; the
// lifecycle lock, which another thread waits for while the session opens or closes, is a queue the asynchronous
// methods take their turn in.

import type {
  AgentRobot,
  ControlSnapshot as HeldSnapshot,
  Observation as HeldObservation,
} from "../agent/robot";
import type { MotionResult as HeldResult } from "../protocol/types";
import { pythonRepr, pythonValueOf } from "../python/repr";
import type { BaseKinematics } from "../so101/kinematics/base";
import type { CameraSource } from "./cameras";
import { ActionGuard } from "./joint/action_guard";
import { secondsClock, type MonotonicClock } from "./joint/clock";
import { ControlConfig, type ControlSettings, type RobotConfig } from "./joint/config";
import type { ControlLoopOptions, JointControlLoop } from "./joint/control_loop";
import type { JointDriver } from "./joint/driver";
import { RuntimeError, ValueError, type Cancellation } from "./joint/errors";
import type { GripperOperation } from "./joint/operations";
import { SnapshotCheck } from "./joint/snapshot_checks";
import { StabilityError, type StabilityMetrics } from "./joint/stability";
import type { ActionAdapter, JointPositions, StrictModelClass } from "./motion/actions";
import { controlLoopOf, Execution } from "./motion/execution";
import type { ApprovePlan, ReportHomeProgress } from "./motion/homing";
import type { PreparedAction } from "./motion/planning";
import { MotionStatus, type MotionResult } from "./motion/results";
import {
  ActionPhase,
  ControlState,
  RobotStatus,
  type ActionFormat,
  type BriefStatus,
  type Camera,
  type ControlSnapshot,
  type DetailedStatus,
  type HomeReport,
  type Observation,
} from "./schemas";

/** Which actions a robot takes. */
export const ActionMode = {
  /** Every action of the robot, as a model's session gives them: the planner is opened. */
  CARTESIAN: "cartesian",
  /** Chunks of joint targets alone, as maintenance gives them: no planner is opened. */
  JOINT: "joint",
} as const;
export type ActionMode = (typeof ActionMode)[keyof typeof ActionMode];

/** A station's configuration as a robot is made from it: the control loop's settings and the robot's own. */
export interface StationConfig<Settings = unknown> {
  readonly control: ControlSettings;
  readonly robot: Settings;
}

/**
 * What a robot tells its log: the PEAR module that logs it there ("robot", "results"; the control loop's own lines
 * as "control_loop"), the level and the message.
 */
export type RobotLog = (logger: string, level: "info" | "warning" | "error", message: string, error?: unknown) => void;

/** What a robot is made with besides its station's configuration. */
export interface RobotOptions<Image = unknown> {
  /** The caller's cameras: every observation reads them, and the robot never closes them. */
  cameras?: CameraSource<Image> | null;
  actionMode?: ActionMode;
  /** The clock of the robot, of its control loop and of every wait; the page's by default. */
  clock?: MonotonicClock;
  log?: RobotLog;
  /** Gives the identity of a session and of an observation (PEAR's `str(uuid4())`); a random UUID by default. */
  uuid4?: () => string;
}

/**
 * What is told the phases of an action. PEAR calls it in the action's thread and goes on when it returns; here it
 * may return a promise, which the action waits for.
 */
export type ReportProgress = (phase: ActionPhase) => void | Promise<void>;

/** What a robot's result is made from: the keywords of PEAR's `result`. */
export interface ResultOptions {
  status?: MotionStatus;
  error?: unknown;
  /** The validated action, if the action got that far. */
  action?: unknown;
  /** The report of the grippers' operation, if the action ran one. */
  gripperReport?: Record<string, unknown> | null;
}

/** What a caller of Home may give. */
export interface HomeOptions {
  cancellation?: Cancellation | null;
  timeoutS?: number;
  /** Receives each stage. */
  reportProgress?: ReportHomeProgress | null;
  /** Approves the plan before anything moves: only `true` does. */
  approvePlan?: ApprovePlan | null;
}

/** What `runHome` is given. */
export interface RunHomeOptions {
  deadline: number;
  reportProgress: ReportHomeProgress | null;
  approvePlan: ApprovePlan | null;
}

/** The class of a robot's control loop: PEAR's `CONTROL_LOOP_CLASS`, of which `open` is used. */
export interface ControlLoopClass {
  open(
    driver: JointDriver<any>, // eslint-disable-line @typescript-eslint/no-explicit-any
    controlConfig: ControlConfig,
    robotConfig: any, // eslint-disable-line @typescript-eslint/no-explicit-any
    options?: ControlLoopOptions,
  ): Promise<JointControlLoop<any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Python's `copy.deepcopy` of a configuration: an object of a class made anew of the same class. */
function deepCopy<Value>(value: Value): Value {
  if (Array.isArray(value)) {
    return value.map(deepCopy) as Value;
  }
  if (typeof value === "object" && value !== null) {
    const copy = Object.create(Object.getPrototypeOf(value) as object | null) as Record<string, unknown>;
    for (const [key, child] of Object.entries(value)) {
      copy[key] = deepCopy(child);
    }
    return copy as Value;
  }
  return value;
}

/** PEAR's lifecycle lock for the methods that wait here: each takes its turn after the ones before it. */
class TurnLock {
  private turn: Promise<unknown> = Promise.resolve();

  run<Result>(block: () => Result | Promise<Result>): Promise<Result> {
    const result = this.turn.then(block);
    this.turn = result.catch(() => undefined);

    return result;
  }
}

/**
 * The base of a robot's class: one robot's session over its control loop, with its lifetime, its observations, its
 * blocking actions and Home; a robot's class sets its facts and its classes and implements its own steps.
 */
export abstract class BaseRobot<
  Config extends RobotConfig = RobotConfig,
  Settings = unknown,
  Image = unknown,
> extends Execution {
  // the robot's facts
  /** What the command line and the page's service call the robot: the name of its package. */
  static readonly NAME: string;
  /** What the page calls the robot. */
  static readonly TITLE: string;
  /** The line under the title that the page receives with the robot's profile. */
  static readonly SUBTITLE: string;
  /** What the robot moves, in words, as the page receives it with the profile: "Both arms". */
  static readonly ARMS_TEXT: string;
  /** Its cameras, in the order the page shows them. */
  static readonly CAMERAS: readonly Camera[];
  /** Its action formats by name, the default first. */
  static readonly ACTION_FORMATS: Readonly<Record<string, ActionFormat<any, any>>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** The arms Home may return, the default first; empty: no choice. */
  static readonly HOME_ARM_CHOICES: readonly string[] = [];
  /** Whether Home may leave the grippers as they are. */
  static readonly HOME_CAN_KEEP_GRIPPERS: boolean = false;
  /** One arm's joints as the page names them; empty: the page shows no joints. */
  static readonly JOINT_NAMES: readonly string[] = [];

  // the classes the robot is built from (its settings and its driver are made by makeRobotConfig and makeDriver)
  static readonly CONTROL_LOOP_CLASS: ControlLoopClass;
  /** Reads an action as one of its action models. */
  static readonly ACTION_ADAPTER: ActionAdapter<unknown>;
  /** Its chunk of joint targets, the one action joint mode takes. */
  static readonly JOINT_ACTION_CLASS: StrictModelClass<JointPositions>;

  /** For planning one action or Home, s. */
  static readonly PLANNING_TIMEOUT_S: number = 30.0;
  /** For a whole Home, the operator's review included, s. */
  static readonly HOME_TIMEOUT_S: number = 420.0;
  /** The refusal of another session's observation. */
  static readonly FOREIGN_OBSERVATION: string = "Observation belongs to a different station session";

  readonly clock: MonotonicClock;
  readonly actionMode: ActionMode;
  /** The identity of the open session; null while closed. */
  sessionId: string | null = null;
  /** Of the open session; null while closed and in joint mode. */
  kinematics: BaseKinematics | null = null;
  /** What the last failed action's error recorded. */
  lastErrorDiagnostics: Record<string, unknown> | null = null;

  /** What the robot was made with: a robot's class reads its own part of it. */
  protected readonly options: RobotOptions<Image>;
  /** What the two configurations are made from, again at every open. */
  protected readonly stationConfig: StationConfig<Settings>;
  /** Of the open or the next session. */
  protected _controlConfig: ControlConfig;
  protected _robotConfig: Config;
  /** The caller's: every observation reads them, and the robot never closes them. */
  protected readonly _cameras: CameraSource<Image> | null;
  /** null while closed: making a robot opens no device. */
  protected _controlLoop: JointControlLoop | null = null;
  protected readonly log: RobotLog;
  protected readonly uuid4: () => string;
  /** Whether the one action or recovery that may run is running (PEAR's execution lock). */
  private isExecuting = false;
  /** Held while the session opens or closes (PEAR's lifecycle lock). */
  private readonly lifecycle = new TurnLock();

  constructor(config: StationConfig<Settings>, options: RobotOptions<Image> = {}) {
    super();
    const actionMode = options.actionMode ?? ActionMode.CARTESIAN;
    if (!(Object.values(ActionMode) as string[]).includes(actionMode)) {
      throw new ValueError("Expected joint/cartesian mode");
    }
    this.options = options;
    this.clock = options.clock ?? secondsClock();
    this.log = options.log ?? (() => undefined);
    this.uuid4 = options.uuid4 ?? (() => globalThis.crypto.randomUUID());

    this.stationConfig = config;
    [this._controlConfig, this._robotConfig] = this.makeConfigs();

    this.actionMode = actionMode;
    this._cameras = options.cameras ?? null;
  }

  /** The class of this robot, which holds its facts and its classes. */
  protected get robotClass(): typeof BaseRobot {
    return this.constructor as typeof BaseRobot;
  }

  /**
   * Returns the control loop's configuration and the robot's settings, made from the station's configuration; a
   * value the station leaves ??? reads as a template's placeholder, which the robot's motion blockers name.
   */
  makeConfigs(): [ControlConfig, Config] {
    return [new ControlConfig(this.stationConfig.control), this.makeRobotConfig(this.stationConfig.robot)];
  }

  /** Returns the robot's settings made from the robot node of the station's configuration, checked. */
  protected abstract makeRobotConfig(settings: Settings): Config;

  /** Returns the robot's driver, made with the two configurations: it connects the arms and enables them. */
  protected abstract makeDriver(controlConfig: ControlConfig, robotConfig: Config): JointDriver<any> | Promise<JointDriver<any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

  /** A copy of the control loop's configuration of the open or the next session. */
  get controlConfig(): ControlConfig {
    return deepCopy(this._controlConfig);
  }

  /** A copy of the robot's settings of the open or the next session. */
  get robotConfig(): Config {
    return deepCopy(this._robotConfig);
  }

  /** The control period of the open or the next session, s. */
  get controlPeriodS(): number {
    return this._controlConfig.controlPeriodS;
  }

  /** Returns what the page lays the robot out with. */
  static profile(): Record<string, unknown> {
    return {
      name: this.NAME,
      title: this.TITLE,
      subtitle: this.SUBTITLE,
      arms: this.ARMS_TEXT,
      cameras: this.CAMERAS.map((camera) => ({ role: camera.role, label: camera.label })),
      home_sides: [...this.HOME_ARM_CHOICES],
      home_keep_grippers: this.HOME_CAN_KEEP_GRIPPERS,
      joints: [...this.JOINT_NAMES],
      formats: Object.keys(this.ACTION_FORMATS),
    };
  }

  /**
   * The control loop of the open session, for the robot's own motion code and commands; throws while the robot is
   * closed.
   */
  get controlLoop(): JointControlLoop {
    const controlLoop = this._controlLoop;
    if (controlLoop === null) {
      throw new RuntimeError("Open the station first");
    }

    return controlLoop;
  }

  /**
   * Makes the two configurations again, opens the planner and the control loop, which enables the arms, and returns
   * the robot; a failure closes what was opened.
   */
  open(): Promise<this> {
    return this.lifecycle.run(async () => {
      if (this._controlLoop !== null) {
        throw new RuntimeError("Station already open");
      }
      [this._controlConfig, this._robotConfig] = this.makeConfigs();

      try {
        if (this.actionMode === ActionMode.CARTESIAN) {
          await this.openPlanner();
        }
        const controlConfig = this.controlConfig;
        const robotConfig = this.robotConfig;
        const driver = await this.makeDriver(controlConfig, robotConfig);
        this._controlLoop = await this.robotClass.CONTROL_LOOP_CLASS.open(driver, controlConfig, robotConfig, {
          clock: this.clock,
          log: (level, message, error) => this.log("control_loop", level, message, error),
        });
        this.sessionId = this.uuid4();

        return this;
      } catch (error) {
        await this.closeSession();
        throw error;
      }
    });
  }

  /** Stops, and releases the arms and the planner; a later `open` starts a new session. */
  close(): Promise<void> {
    return this.lifecycle.run(() => this.closeSession());
  }

  /** The body of `close`, which `open` runs too when it fails (PEAR's lock is reentrant). */
  private async closeSession(): Promise<void> {
    try {
      const controlLoop = this._controlLoop;
      if (controlLoop !== null) {
        try {
          await controlLoop.shutdown();
        } finally {
          if (controlLoop.status === ControlState.CLOSED) {
            this._controlLoop = null;
            this.sessionId = null;
          }
        }
      }
    } finally {
      await this.closePlanner();
    }
  }

  /**
   * Makes planning ready for the robot's action mode, or replaces a planner that failed; the caller holds the
   * lifecycle lock.
   */
  abstract openPlanner(): void | Promise<void>;

  /** Releases what `openPlanner` made ready. */
  abstract closePlanner(): void | Promise<void>;

  /**
   * Returns whether the robot is OFF, READY (a settled HOLD), BUSY or in FAULT; with `withSnapshot`, the whole
   * control snapshot too.
   */
  status(withSnapshot?: false): BriefStatus;
  status(withSnapshot: true): DetailedStatus | BriefStatus;
  status(withSnapshot = false): BriefStatus | DetailedStatus {
    const controlLoop = this._controlLoop;
    if (controlLoop === null) {
      return { status: RobotStatus.OFF };
    }

    const snapshot = controlLoop.snapshot();
    const controlState = snapshot.status;
    let robotStatus: RobotStatus;
    if (controlState === ControlState.CLOSED) {
      robotStatus = RobotStatus.OFF;
    } else if (controlState === ControlState.FAULT) {
      robotStatus = RobotStatus.FAULT;
    } else if (controlState === ControlState.HOLD && snapshot.arrival.settled) {
      robotStatus = RobotStatus.READY;
    } else {
      robotStatus = RobotStatus.BUSY;
    }

    if (withSnapshot) {
      return { ...snapshot, status: robotStatus, control_state: controlState };
    }
    return {
      status: robotStatus,
      settled: snapshot.arrival.settled,
      reached: snapshot.arrival.reached,
      fault: snapshot.fault,
    };
  }

  /**
   * Returns the measured joints, the cameras' frames and the control snapshot as one observation of the session.
   */
  override async observe(): Promise<Observation<Image>> {
    const [controlLoop, cameras, sessionId, snapshot] = await this.lifecycle.run(
      () => [this._controlLoop!, this._cameras, this.sessionId, this.controlLoop.snapshot()] as const,
    );
    SnapshotCheck.validateSnapshot(snapshot, this._controlConfig);

    let frames: Awaited<ReturnType<CameraSource<Image>["read"]>>;
    try {
      frames = cameras !== null ? await cameras.read() : {};
    } catch (error) {
      await controlLoop.stop();
      throw error;
    }
    if (sessionId !== this.sessionId) {
      throw new RuntimeError("Station session changed during observation");
    }

    return {
      observation_id: this.uuid4(),
      session_id: sessionId as string,
      captured_monotonic_s: this.clock.monotonic(),
      joint_positions: SnapshotCheck.stateVector(snapshot),
      images: Object.fromEntries(Object.entries(frames).map(([role, frame]) => [role, frame.rgb])),
      camera_timestamps: Object.fromEntries(
        Object.entries(frames).map(([role, frame]) => [
          role,
          Object.fromEntries(Object.entries(frame).filter(([key]) => key !== "rgb")),
        ]),
      ),
      control_snapshot: snapshot,
    };
  }

  /**
   * Runs one action from a settled HOLD at `referenceObservation` (by default a new observation), within `timeoutS`
   * if one is given, and returns its result, which an action that did not complete has too.
   */
  async execute(
    action: unknown,
    options: {
      referenceObservation?: Observation | null;
      timeoutS?: number | null;
      cancellation?: Cancellation | null;
      reportProgress?: ReportProgress | null;
    } = {},
  ): Promise<MotionResult> {
    const referenceObservation = options.referenceObservation ?? null;
    const timeoutS = options.timeoutS ?? null;
    const reportProgress = options.reportProgress ?? null;
    if (timeoutS !== null) {
      SnapshotCheck.checkTimeout(timeoutS, "Timeout");
    }

    return this.withActionGuard(options.cancellation ?? null, async (guard) => {
      const controlLoop = controlLoopOf(guard);
      const deadline = timeoutS === null ? null : this.clock.monotonic() + timeoutS;
      this.lastErrorDiagnostics = null;
      let parsedAction: unknown = null;

      try {
        parsedAction = this.robotClass.ACTION_ADAPTER.validate(action);
        const isJointAction = this.robotClass.JOINT_ACTION_CLASS.isInstance(parsedAction);
        if (this.actionMode === ActionMode.JOINT && !isJointAction) {
          throw new ValueError("Joint mode only accepts joint_positions");
        }
        await this.waitForSettledHold(null, { deadline, guard });
        const observation = referenceObservation === null ? await this.observe() : referenceObservation;
        this.verifyObservation(observation);

        let gripperReport: Record<string, unknown> | null = null;
        let snapshot: ControlSnapshot;
        if (isJointAction) {
          snapshot = await this.runSequence(parsedAction as JointPositions, observation, { guard, deadline });
        } else {
          guard.check();
          if (reportProgress !== null) {
            await reportProgress(ActionPhase.PLANNING);
          }
          const preparedAction = await this.plan(observation, parsedAction, { deadline });
          guard.check();
          if (reportProgress !== null) {
            await reportProgress(ActionPhase.EXECUTING);
          }
          gripperReport = await this.runPrepared(observation, preparedAction, { guard, deadline });
          snapshot = controlLoop.snapshot();
        }
        guard.check();

        return this.result(snapshot, { action: parsedAction, gripperReport });
      } catch (error) {
        this.log("robot", "error", "An action did not complete", error);
        const details = (error as { details?: unknown } | null)?.details;
        this.lastErrorDiagnostics = (details ?? null) as Record<string, unknown> | null;
        await controlLoop.stop();
        const isRejected = error instanceof ValueError && !guard.hasDispatched;

        return this.result(controlLoop.snapshot(), {
          status: isRejected ? MotionStatus.REJECTED : MotionStatus.FAILED,
          error,
          action: parsedAction,
        });
      }
    });
  }

  /**
   * Returns the arm move and the gripper request of the validated `action` from `observation`, planned by
   * `deadline` (null: the action has no deadline).
   */
  abstract plan(
    observation: Observation,
    action: unknown,
    options: { deadline: number | null },
  ): PreparedAction | Promise<PreparedAction>;

  /**
   * Returns the robot's result of `action` from a control snapshot or the robot's status; `gripperReport` is the
   * report of the grippers' operation, if the action ran one.
   */
  abstract result(snapshot: ControlSnapshot | DetailedStatus | BriefStatus, options?: ResultOptions): MotionResult;

  /**
   * Returns the arms Home once `approvePlan` approves the plan, all within `timeoutS`, and returns the Home report;
   * `reportProgress` receives each stage.
   */
  async home(options: HomeOptions = {}): Promise<HomeReport> {
    const timeoutS = options.timeoutS ?? this.robotClass.HOME_TIMEOUT_S;
    SnapshotCheck.checkTimeout(timeoutS, "Timeout");
    const deadline = this.clock.monotonic() + timeoutS;
    this.controlLoop.snapshot(); // a closed robot is refused before a missing Home is
    if (this._robotConfig.home === null) {
      throw new ValueError("No home pose configured");
    }

    return this.withActionGuard(options.cancellation ?? null, (guard) =>
      this.runHome(guard, {
        deadline,
        reportProgress: options.reportProgress ?? null,
        approvePlan: options.approvePlan ?? null,
      }),
    );
  }

  /**
   * Plans Home, has `approvePlan` approve the plan and runs it under `guard` by `deadline`, and returns the Home
   * report.
   */
  abstract runHome(guard: ActionGuard, options: RunHomeOptions): Promise<HomeReport>;

  /**
   * Reacquires a hold after a fault, within `timeoutS` (by default the control loop's own), without replacing the
   * session or enabling motors, and returns the snapshot then.
   */
  async recover(options: { cancellation?: Cancellation | null; timeoutS?: number | null } = {}): Promise<ControlSnapshot> {
    const controlLoop = await this.lifecycle.run(() => this.claimExecution());

    try {
      const snapshot = await controlLoop.recover({
        cancellation: options.cancellation ?? null,
        timeoutS: options.timeoutS ?? null,
      });
      this.lastErrorDiagnostics = null;

      return snapshot;
    } finally {
      this.isExecuting = false;
    }
  }

  /** Brakes any operation into a HOLD. */
  async stop(): Promise<void> {
    const controlLoop = this._controlLoop;
    if (controlLoop !== null) {
      await controlLoop.stop();
    }
  }

  /** Throws the fault the control loop has latched, with its diagnostics, if it has one. */
  checkFault(): void {
    const controlLoop = this._controlLoop;
    if (controlLoop !== null) {
      SnapshotCheck.raiseForFault(controlLoop.snapshot());
    }
  }

  /**
   * Waits, outside an action, for a settled HOLD, of the operation of `observation` if one is given, and returns
   * its snapshot; a stop, a fault or another operation ends the wait with an error.
   */
  async waitStationary(
    observation: Observation | null = null,
    options: { cancellation?: Cancellation | null } = {},
  ): Promise<ControlSnapshot> {
    const guard = await this.newGuard(this.controlLoop, options.cancellation ?? null);

    return this.waitForSettledHold(observation, { guard });
  }

  /**
   * Whether the arms still hold the operation of `observation` and have settled; throws once they no longer hold
   * it.
   */
  isHolding(observation: Observation): boolean {
    return this.holdSnapshot(observation).arrival.settled;
  }

  /** Waits for a stop or an action to end in a settled HOLD and returns its snapshot. */
  waitSettled(timeoutS: number): Promise<ControlSnapshot> {
    return this.controlLoop.waitForHold(timeoutS);
  }

  /** Returns what the model reads of the measured `jointPositions` in the action format `formatName`. */
  modelState(jointPositions: ArrayLike<number>, formatName: string): unknown {
    this.checkFormat(formatName);
    if (this.kinematics === null) {
      throw new RuntimeError("Open a Cartesian Station first");
    }

    return this.kinematics.quantities(jointPositions);
  }

  /**
   * Returns the result of an action of the format `formatName` that did not complete, measured at `snapshot` (by
   * default now).
   */
  failureResult(
    error: unknown,
    options: {
      formatName: string;
      status?: MotionStatus;
      snapshot?: ControlSnapshot | DetailedStatus | BriefStatus | null;
    },
  ): MotionResult {
    this.checkFormat(options.formatName);

    return this.result(options.snapshot ?? this.status(true), {
      status: options.status ?? MotionStatus.FAILED,
      error,
    });
  }

  /**
   * Runs `block`, one action, alone on the open session, under the guard it is given; any failure stops the arms
   * (PEAR's context manager `action_guard`).
   */
  protected async withActionGuard<Result>(
    cancellation: Cancellation | null,
    block: (guard: ActionGuard) => Promise<Result>,
  ): Promise<Result> {
    const controlLoop = await this.lifecycle.run(() => {
      this.controlLoop.snapshot(); // a read of the open session: a closed robot is refused before the claim
      return this.claimExecution();
    });

    try {
      const guard = await this.newGuard(controlLoop, cancellation);
      return await block(guard);
    } catch (error) {
      await controlLoop.stop();
      throw error;
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Returns a guard bound to the operation `controlLoop` runs now. PEAR's guard reads that operation under the
   * loop's lock, so after a control period that is under way: here too, and at once when none is.
   */
  protected async newGuard(controlLoop: JointControlLoop, cancellation: Cancellation | null): Promise<ActionGuard> {
    if (controlLoop.lock.isHeld) {
      return controlLoop.lock.run(() => new ActionGuard(controlLoop, cancellation));
    }

    return new ActionGuard(controlLoop, cancellation);
  }

  /**
   * Waits under `guard`, until `deadline`, for a settled HOLD, of the operation of `observation` if one is given,
   * and returns its snapshot.
   */
  override waitForSettledHold(
    observation: Observation | null,
    options: { deadline?: number | null; guard: ActionGuard },
  ): Promise<ControlSnapshot> {
    return SnapshotCheck.waitReady(() => this.holdSnapshot(observation), {
      timeoutS: this.remainingS(options.deadline ?? null, this._controlConfig.settle_timeout_s),
      controlPeriodS: this._controlConfig.controlPeriodS,
      guard: options.guard,
      makeTimeoutError: (snapshot) =>
        new StabilityError(
          "Station did not pass the continuous stability window",
          snapshot.settling as unknown as StabilityMetrics,
        ),
      clock: this.clock,
    });
  }

  /**
   * Returns the fresh snapshot of the HOLD when the open session still holds the operation of `observation`, and
   * throws otherwise.
   */
  verifyObservation(observation: Observation): ControlSnapshot {
    const controlLoop = this._controlLoop;
    if (controlLoop === null) {
      throw new ValueError(this.robotClass.FOREIGN_OBSERVATION);
    }

    const snapshot = this.holdSnapshot(observation);
    if (controlLoop !== this._controlLoop) {
      throw new ValueError("Station session changed during validation");
    }

    return snapshot;
  }

  /**
   * Starts the gripper operation for `gripperRequest` under `guard` while the arms hold `observation`, settled, and
   * returns it.
   */
  override submitGrippers(guard: ActionGuard, observation: Observation, gripperRequest: unknown): GripperOperation {
    const controlLoop = controlLoopOf(guard);

    if (!this.verifyObservation(observation).arrival.settled) {
      throw new RuntimeError("Gripper reference is no longer stable");
    }

    return guard.submit(() => controlLoop.beginGrippers(gripperRequest));
  }

  /**
   * Returns the fresh feedback of a HOLD, of the session and the operation of `observation` if one is given, and
   * throws when the arms do not hold it.
   */
  holdSnapshot(observation: Observation | null = null): ControlSnapshot {
    const snapshot = SnapshotCheck.validateSnapshot(this.controlLoop.snapshot(), this._controlConfig, true);
    if (observation !== null) {
      // (PEAR's observation.get: an observation without a session is no session's)
      if ((observation.session_id ?? null) !== this.sessionId) {
        throw new ValueError(this.robotClass.FOREIGN_OBSERVATION);
      }
      SnapshotCheck.validateReference(snapshot, observation);
    }

    return snapshot;
  }

  /**
   * Returns the control loop of the open session with the one place of a running action or recovery taken, and
   * throws while the robot is closed or another one runs; the caller gives the place back.
   */
  private claimExecution(): JointControlLoop {
    const controlLoop = this.controlLoop;
    if (this.isExecuting) {
      throw new RuntimeError("A station action is already running");
    }
    this.isExecuting = true;

    return controlLoop;
  }

  /** Throws unless `formatName` names an action format of the robot. */
  protected checkFormat(formatName: string): void {
    if (!Object.prototype.hasOwnProperty.call(this.robotClass.ACTION_FORMATS, formatName)) {
      throw new ValueError(`${this.robotClass.TITLE} has no action format ${pythonRepr(pythonValueOf(formatName))}`);
    }
  }
}

// ---- not in PEAR: the robot as the turn loop of src/agent drives it ----

/** What turns a camera frame of the station into the JPEG bytes the turn loop holds (a page: at quality 90). */
export type EncodeFrame<Image> = (
  frame: Image,
  role: string,
  observation: Observation<Image>,
) => Uint8Array | Promise<Uint8Array>;

/** `received_monotonic_s` as `receivedMonotonicS`. */
function camelCase(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

/**
 * A robot of the station as the turn loop's robot (`AgentRobot` of src/agent/robot.ts). PEAR's loop drives its
 * robot itself and reads PEAR's dictionaries; pear.js's loop holds an observation under camelCase names with each
 * frame as JPEG bytes. This is the whole difference: every call goes to the robot's method of the same name, an
 * observation the robot returns is handed on in the loop's form, and one the loop hands back goes to the robot as
 * PEAR's dictionary again.
 *
 * PEAR's observation is a plain dictionary and its joint vector a writable array of its own, so what PEAR's loop
 * hands back is checked and planned from as it reads then, whatever was written into it meanwhile. The same holds
 * here: the loop's object and its joint vector can be written as PEAR's can, and the robot reads the session, the
 * control snapshot and the joints that the object holds at each check, never values kept aside. Only the tuples of
 * the control snapshot refuse a write, in both.
 */
export class AgentRobotAdapter<State = unknown, Action = unknown, Image = unknown> implements AgentRobot<State, Action> {
  /** The robot's observation behind each one the loop holds: its frames and their stamps, which the loop's lacks. */
  private readonly observations = new WeakMap<object, Observation<Image>>();

  constructor(
    readonly robot: BaseRobot<any, any, Image>, // eslint-disable-line @typescript-eslint/no-explicit-any
    private readonly encodeFrame: EncodeFrame<Image>,
  ) {}

  get actionMode(): string {
    return this.robot.actionMode;
  }

  get sessionId(): string | null {
    return this.robot.sessionId;
  }

  get controlPeriodS(): number {
    return this.robot.controlPeriodS;
  }

  get lastErrorDiagnostics(): Record<string, unknown> | null {
    return this.robot.lastErrorDiagnostics;
  }

  waitStationary(
    observation: HeldObservation | null = null,
    options: { cancellation?: Cancellation | null } = {},
  ): Promise<ControlSnapshot> {
    return this.robot.waitStationary(this.stationObservation(observation), options);
  }

  async observe(): Promise<HeldObservation> {
    const observation = await this.robot.observe();
    const images: Record<string, Uint8Array> = {};
    for (const [role, frame] of Object.entries(observation.images)) {
      images[role] = await this.encodeFrame(frame, role, observation);
    }
    const held: HeldObservation = {
      observationId: observation.observation_id,
      sessionId: observation.session_id,
      capturedMonotonicS: observation.captured_monotonic_s,
      jointPositions: observation.joint_positions,
      images,
      cameraTimestamps: Object.fromEntries(
        Object.entries(observation.camera_timestamps).map(([role, stamps]) => [
          role,
          Object.fromEntries(Object.entries(stamps).map(([key, value]) => [camelCase(key), value])),
        ]),
      ) as HeldObservation["cameraTimestamps"],
      controlSnapshot: observation.control_snapshot,
    };
    this.observations.set(held, observation);

    return held;
  }

  modelState(jointPositions: readonly number[], formatName: string): State {
    return this.robot.modelState(jointPositions, formatName) as State;
  }

  isHolding(observation: HeldObservation): boolean {
    return this.robot.isHolding(this.stationObservation(observation)!);
  }

  stop(): Promise<void> {
    return this.robot.stop();
  }

  async execute(
    action: Action,
    options: {
      referenceObservation?: HeldObservation | null;
      cancellation?: Cancellation | null;
      reportProgress?: ReportProgress | null;
    },
  ): Promise<HeldResult> {
    const result = await this.robot.execute(action, {
      referenceObservation: this.stationObservation(options.referenceObservation ?? null),
      cancellation: options.cancellation ?? null,
      reportProgress: options.reportProgress ?? null,
    });

    return result as HeldResult;
  }

  failureResult(
    error: unknown,
    options: { formatName: string; status?: MotionStatus; snapshot?: HeldSnapshot | null },
  ): HeldResult {
    return this.robot.failureResult(error, {
      formatName: options.formatName,
      ...(options.status === undefined ? {} : { status: options.status }),
      snapshot: (options.snapshot ?? null) as ControlSnapshot | DetailedStatus | BriefStatus | null,
    }) as HeldResult;
  }

  /**
   * Returns the observation the loop hands back as PEAR's dictionary, read from the loop's object at every use: the
   * robot checks the session, the control snapshot and the joints the object holds then, as PEAR's robot reads the
   * dictionary it was handed. The frames and their stamps are the robot's own when this adapter issued the
   * observation (the loop holds the encoded ones), and the loop's otherwise.
   */
  private stationObservation(observation: HeldObservation | null): Observation<Image> | null {
    if (observation === null) {
      return null;
    }
    const own = this.observations.get(observation);

    return {
      get observation_id(): string {
        return observation.observationId;
      },
      get session_id(): string {
        return observation.sessionId;
      },
      get captured_monotonic_s(): number {
        return observation.capturedMonotonicS;
      },
      get joint_positions(): readonly number[] {
        return observation.jointPositions;
      },
      get images(): Record<string, Image> {
        return own !== undefined ? own.images : (observation.images as Record<string, Image>);
      },
      get camera_timestamps(): Record<string, Record<string, unknown>> {
        if (own !== undefined) {
          return own.camera_timestamps;
        }

        return Object.fromEntries(
          Object.entries(observation.cameraTimestamps).map(([role, stamps]) => [
            role,
            { received_monotonic_s: stamps.receivedMonotonicS, frame_number: stamps.frameNumber },
          ]),
        );
      },
      get control_snapshot(): ControlSnapshot {
        return observation.controlSnapshot as ControlSnapshot;
      },
    };
  }
}
