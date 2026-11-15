// Ports pear/deploy/station/control/joint/control_loop.py.
//
// PEAR's loop is a thread that steps once every control period, and its callers are other threads that take the
// loop's lock. Here there is one thread and the driver is asynchronous, so:
//
// - A method is asynchronous if and only if PEAR's can read or send through the driver, sleep, or wait for the loop:
//   `create`, `open`, `run`, `step`, `stop`, `recover`, `waitForHold`, `shutdown`, `close`, `transferHold`. Every
//   other method does all its work before it returns, as PEAR's does under the lock.
// - PEAR's constructor reads the arms until they are settled and commands the first hold. A constructor cannot
//   wait, so `create` is PEAR's constructor: it makes the loop and takes the hold.
// - `step` advances a motion by one control period whatever the clock says, and `run` never steps several periods
//   in a burst after a stall: PEAR's timing rule, on the clock the loop is given.
// - PEAR's `RLock` is `LoopLock`, which the asynchronous methods take around the blocks PEAR locks. A block starts at
//   once when the lock is free, so a `stop` between two steps takes effect before it returns its promise. A block
//   that arrives while a step is under way waits for the step's end, as a thread waits for PEAR's lock.
// - The synchronous methods cannot wait. Of them only the four that begin an operation change anything, and they
//   need a HOLD. A step in a HOLD awaits the driver twice: at its reading, where nothing of the step has happened
//   yet, so what a caller begins then is begun before the step; and at the renewal of the hold, where the step is
//   over, so what a caller begins then starts with the next period. In every other state they refuse, as PEAR's do
//   whichever side of the step they fall on.
// - A snapshot taken while a step is under way shows the loop as it is then: between the reading and the command of
//   a moving period it holds the new reading with the targets of the period before. PEAR's lock hides that instant;
//   `waitForHold` and `recover` read their snapshots under the lock and never see it.
// - The lock does not know its holder: what runs inside a step (a recovery policy, an operation, a driver) calls the
//   methods PEAR documents as "the caller holds the lock" and never the asynchronous ones above.
// - PEAR holds every arm's targets and readings as tuples and hands them out as they are: to its driver, its
//   operation, its recovery policy and every snapshot. Here a tuple is a frozen array (`tupleOf`), so none of them
//   can write into what the loop holds and commands: the write throws a TypeError, as Python's does.
// - What PEAR logs is told to the `log` option. A loop that is given none prints what PEAR logs at error level with
//   `console.error` (a fault, a fault's hold that could not be commanded, the end of the control thread), and `start`
//   prints the failure that ended `run` whatever the log does, as Python prints the traceback of a thread that died.
// - Once a fault is latched nothing throws before its hold is commanded, whatever was thrown, whatever it carries
//   and whatever the log does (PEAR's `deepcopy` of an error's details copies what a structured clone refuses).

import { pythonFloatRepr } from "../../protocol/python_float";
import { formatTemplate } from "../../so101/kinematics/text";
import {
  ControlState,
  MOVING_CONTROL_STATES,
  MotionEndReason,
  type ArmFeedback,
  type ControlSnapshot,
} from "../schemas";
import { ActionGuard, type GuardedControlLoop } from "./action_guard";
import { ArmState, tupleOf } from "./arm_state";
import { secondsClock, type MonotonicClock } from "./clock";
import type { ControlConfig, RobotConfig } from "./config";
import type { ArmVectors, JointDriver } from "./driver";
import { OperatorPaused, PythonTypeError, RuntimeError, TimeoutError, ValueError, type Cancellation } from "./errors";
import type { JointLayout } from "./layout";
import type { JointLimits, MotionCaps } from "./limits";
import { pythonStrRepr } from "./numeric";
import {
  GripperOperation,
  JointMoveOperation,
  OperationInterrupted,
  SequenceOperation,
  TargetOperation,
  type ArmTargets,
  type Operation,
} from "./operations";
import { allClose, RecoveryRequest, type RecoveryPolicy } from "./recovery";
import { SnapshotCheck, type ObservationReference } from "./snapshot_checks";
import { StabilityWindow, type StabilityCriteria, type StabilityMetrics } from "./stability";
import { Tracking } from "./tracking";
import { JointMove, JointTrajectory, type CommandSample } from "./trajectory";

/** What a controlled STOP brakes with. */
export const Braking = {
  /** The caps of the motion it stops. */
  MOVE_CAPS: "move_caps",
  /** The station's STOP acceleration and jerk. */
  STATION_LIMITS: "station_limits",
} as const;
export type Braking = (typeof Braking)[keyof typeof Braking];

/**
 * The control data of one instant, which the loop's own checks read: a snapshot without its arrival, settling,
 * recovery and motion.
 */
export interface ControlFeedback {
  captured_monotonic_s: number;
  /** The word of a ControlState. */
  status: string;
  fault: string | null;
  fault_details: Record<string, unknown> | null;
  generation: number;
  targets: Record<string, readonly number[]>;
  arms: Record<string, ArmFeedback>;
}

/**
 * The class of a robot's gripper operation: made with the two configurations, the held targets, the arms' states and
 * the gripper request.
 */
export type GripperOperationClass = new (
  controlConfig: ControlConfig,
  // a robot's own settings and request, which the generic loop passes on as they are
  robotConfig: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  targets: ArmTargets,
  states: Readonly<Record<string, ArmState>>,
  gripperRequest: any, // eslint-disable-line @typescript-eslint/no-explicit-any
) => GripperOperation;

/** The class of a robot's recovery policy. */
export type RecoveryPolicyClass = new () => RecoveryPolicy;

/** Told what PEAR logs: a request, an end of motion, a fault. */
export type ControlLog = (level: "info" | "warning" | "error", message: string, error?: unknown) => void;

/**
 * The log of a loop that is given none. What PEAR logs at error level is printed with `console.error`, with what was
 * thrown (PEAR's logger prints its traceback): a fault, a fault's hold that could not be commanded ("a physical stop
 * may be required"), the end of the control thread. The lower levels are dropped: a request, an end of motion, a
 * controlled stop, a failed read in FAULT (PEAR's logger, made at INFO, prints those too).
 */
export const logErrorsToConsole: ControlLog = (level, message, error) => {
  if (level !== "error") {
    return;
  }
  if (error === undefined) {
    console.error(message);
  } else {
    console.error(message, error);
  }
};

/** What a control loop is given besides its driver and its two configurations. */
export interface ControlLoopOptions {
  /** The monotonic clock and the sleep of the loop and of every part it makes (by default the page's). */
  readonly clock?: MonotonicClock;
  /**
   * Told what PEAR logs (by default `logErrorsToConsole`: the error level alone, to `console.error`). A page that
   * gives its own is the only one told of a fault, of a hold that could not be commanded and of the loop's end.
   */
  readonly log?: ControlLog;
}

/** What `waitForHold` takes besides its timeout. */
export interface WaitForHoldOptions {
  /** Whether a settled HOLD is the one waited for; it may annotate the snapshot but never commands. */
  readonly accepts?: ((snapshot: ControlSnapshot) => boolean) | null;
  /** The guard of the caller's action; without one the wait is bound to the operation seen on entry. */
  readonly guard?: ActionGuard | null;
  /** What the timeout's message calls what did not settle. */
  readonly label?: string;
}

/**
 * PEAR's lock for the blocks that hold an await: a block starts at once when the lock is free, and otherwise after
 * the blocks that came before it.
 */
export class LoopLock {
  private held = false;
  private readonly waiters: (() => void)[] = [];

  /** Whether a block holds the lock now: a control period that is under way, or a caller's block. */
  get isHeld(): boolean {
    return this.held;
  }

  /** Runs `block` with the lock held and returns what it returns. */
  async run<Result>(block: () => Result | Promise<Result>): Promise<Result> {
    if (this.held) {
      // the lock is handed over still held, so nothing that arrives later runs first
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.held = true;
    }

    try {
      return await block();
    } finally {
      const next = this.waiters.shift();
      if (next !== undefined) {
        next();
      } else {
        this.held = false;
      }
    }
  }
}

/** PEAR's exit event of the control thread: set once, and a wait on it ends when it is set or its time has passed. */
class ExitEvent {
  private isSetNow = false;
  private readonly wakes = new Set<() => void>();

  get isSet(): boolean {
    return this.isSetNow;
  }

  set(): void {
    this.isSetNow = true;
    for (const wake of this.wakes) {
      wake();
    }
    this.wakes.clear();
  }

  /** Resolves once the event is set or `seconds` have passed on `clock`. */
  async wait(seconds: number, clock: MonotonicClock): Promise<void> {
    if (this.isSetNow) {
      return;
    }

    let wake!: () => void;
    const woken = new Promise<void>((resolve) => {
      wake = resolve;
    });
    this.wakes.add(wake);
    try {
      await Promise.race([clock.sleep(seconds), woken]);
    } finally {
      this.wakes.delete(wake);
    }
  }
}

/** What stands for PEAR's control thread: the `run` that `start` began. */
interface ControlThread {
  isAlive: boolean;
  /** Resolves when `run` has ended, however it ended. */
  ended: Promise<void>;
}

/**
 * Returns Python's `str()` of what was thrown: an error's message. It does not throw, whatever was thrown (`fail`
 * calls it between latching a fault and commanding its hold): what has no text, as an object without a prototype,
 * is named by its kind.
 */
function errorText(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return textOf(error);
  }
}

/** Returns a text for `value` that no value can refuse: for what is thrown or carried without being data. */
function textOf(value: unknown): string {
  try {
    if (typeof value === "function") {
      return `<function ${value.name}>`;
    }
    return typeof value === "symbol" ? value.toString() : (Object.prototype.toString.call(value) as string);
  } catch {
    return "<unprintable>";
  }
}

/**
 * Returns a fault's details: Python's `copy.deepcopy` of what `error` carries as `details`, or null. It does not
 * throw, whatever the error carries (`fail` calls it between latching the fault and commanding its hold). PEAR's own
 * errors carry plain data, which the structured clone copies as `deepcopy` does. Of anything else, the parts the
 * clone refuses (a function, a symbol) are kept as their text, so that the details stay data a snapshot can copy;
 * details that cannot be read at all are dropped.
 */
function faultDetailsOf(error: unknown): Record<string, unknown> | null {
  try {
    const details = (error as { details?: unknown } | null | undefined)?.details ?? null;

    return clonedOrText(details, []) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

/** Returns the structured clone of `value`, or, where the clone refuses a part of it, that part as its text. */
function clonedOrText(value: unknown, parents: object[]): unknown {
  try {
    return structuredClone(value);
  } catch {
    // (the clone refuses a part of `value`: its parts are copied one by one)
  }
  if (typeof value !== "object" || value === null || parents.includes(value)) {
    return textOf(value);
  }

  const inside = [...parents, value];
  if (Array.isArray(value)) {
    return value.map((item) => clonedOrText(item, inside));
  }

  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clonedOrText(child, inside)]));
}

/**
 * Returns Python's `copy.deepcopy` of a configuration: lists and plain objects copied, an object of a class made anew
 * of the same class with its own values copied, a function kept.
 */
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

/**
 * Returns `targets` as PEAR holds them, each arm's vector a tuple (`tupleOf`): the loop hands its targets to its
 * driver, its operation, its recovery policy and every snapshot as they are, and none of them can write into what
 * the loop holds and commands. Targets whose vectors are tuples already are returned as they are. It never throws
 * (`fail` calls it before the fault is latched): what is no vector is left as it is, for the driver to refuse.
 */
function tupleTargets(targets: ArmTargets): ArmTargets {
  if (typeof targets !== "object" || targets === null) {
    return targets;
  }

  let isChanged = false;
  const tuples: Record<string, readonly number[]> = {};
  for (const [arm, vector] of Object.entries(targets)) {
    tuples[arm] = Array.isArray(vector) || ArrayBuffer.isView(vector) ? tupleOf(vector) : vector;
    isChanged ||= tuples[arm] !== vector;
  }

  return isChanged ? tuples : targets;
}

// the numbers of a snapshot that Python holds as an int, by their key; every other number is a float
const INTEGER_KEYS: readonly string[] = ["generation", "samples", "sample_id"];
// the vectors of a snapshot that Python holds as a tuple, by their key (an arm's reading) or by their parent's
const TUPLE_KEYS: readonly string[] = ["position", "velocity"];
const TUPLE_PARENT = "targets";

/**
 * Returns Python's `repr()` of a snapshot or of a part of it, as the message of a wait that timed out shows it: a
 * float as Python prints it, a whole number of `generation`, `samples`, `sample_id` and of the servos' status as an
 * int, an arm's position, velocity and target as a tuple, any other list as a list.
 */
function pythonRepr(value: unknown, key = "", parent = "", isServoStatus = false): string {
  if (value === null || value === undefined) {
    return "None";
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (typeof value === "number") {
    const isInteger = Number.isInteger(value) && (INTEGER_KEYS.includes(key) || (isServoStatus && !key.endsWith("_s")));
    return isInteger ? String(value) : pythonFloatRepr(value);
  }
  if (typeof value === "string") {
    return pythonStrRepr(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => pythonRepr(item, key, parent, isServoStatus));
    if (TUPLE_KEYS.includes(key) || parent === TUPLE_PARENT) {
      return items.length === 1 ? `(${items[0]},)` : `(${items.join(", ")})`;
    }
    return `[${items.join(", ")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).map(
    ([childKey, child]) =>
      `${pythonStrRepr(childKey)}: ${pythonRepr(child, childKey, key, isServoStatus || key === "servo")}`,
  );

  return `{${entries.join(", ")}}`;
}

/** One owner and one bounded trajectory for every arm of a joint-streaming robot, stepped at its control rate. */
export class JointControlLoop<State extends ArmState = ArmState> implements GuardedControlLoop {
  /** Of the control thread: what the report of a `run` that `start` began and that failed names. */
  static readonly THREAD_NAME: string = "station-control";
  /** A recovery's stability window is never shorter, s. */
  static readonly RECOVERY_WINDOW_FLOOR_S: number = 0.5;
  /** How closely a move must start at the held command. */
  static readonly START_EPSILON: number = 1e-9;
  /** Planned speed below which the commanded state counts as at rest. */
  static readonly STATIONARY_EPSILON: number = 1e-8;
  /** Past a move's duration and settle timeout before the move times out, s. */
  static readonly MOVE_MARGIN_S: number = 5.0;
  /** Past a sequence's duration before it times out, s. */
  static readonly SEQUENCE_MARGIN_S: number = 30.0;
  /** For a gripper operation, s. */
  static readonly GRIPPER_TIMEOUT_S: number = 45.0;
  /** For a HOLD, where a maintenance command waits for one, s. */
  static readonly HOLD_WAIT_S: number = 30.0;
  /** For the stop that precedes a shutdown, s. */
  static readonly SHUTDOWN_WAIT_S: number = 10.0;
  /** For the `run` that `start` began to end, s. */
  static readonly THREAD_JOIN_S: number = 2.0;

  // What a robot's control loop names: its gripper operation, how it recovers from a fault, what its STOP brakes
  // with, and whether a recovery's stability window also bounds the velocity RMS.
  static readonly GRIPPER_OPERATION_CLASS: GripperOperationClass;
  static readonly RECOVERY_POLICY_CLASS: RecoveryPolicyClass;
  static readonly BRAKING: Braking;
  static readonly CHECKS_VELOCITY_RMS: boolean;

  /** The loop's own copies, which it and its parts run with: a caller's later change to its objects is not seen. */
  readonly _controlConfig: ControlConfig;
  readonly _robotConfig: RobotConfig;
  readonly layout: JointLayout;
  readonly limits: JointLimits;
  readonly tracking: Tracking;
  readonly recoveryPolicy: RecoveryPolicy;
  readonly clock: MonotonicClock;

  /** Guards the blocks that await the driver; the robot takes it for its own (`lock.run`). */
  readonly lock = new LoopLock();
  /** Advances with every operation, stop and fault. */
  generation = 0;
  trajectory: JointTrajectory;
  operation: Operation | null = null;
  /** Set by the operator to stop the running operation: its ActionGuard attaches it. */
  operationCancellation: Cancellation | null = null;
  /** The word of a ControlState. */
  status: ControlState = ControlState.HOLD;
  fault: string | null = null;
  faultDetails: Record<string, unknown> | null = null;
  /** Every arm's last checked reading; set once `create` has taken the first hold. */
  states!: Record<string, State>;
  /** Every arm's held target; set once `create` has taken the first hold. */
  targets!: ArmTargets;

  protected stopOperation: TargetOperation;
  protected operationDeadline: number | null = null;
  /** How the last operation ended: a MotionEndReason, or the word a robot stopped with; null while one runs. */
  protected motionEndReason: string | null = MotionEndReason.INITIAL_HOLD;
  protected readonly exitEvent = new ExitEvent();
  protected thread: ControlThread | null = null;
  protected settleSince: number | null = null;
  protected settlingWindow: StabilityWindow;
  protected isSettled = false;
  protected recoveryRequest: RecoveryRequest | null = null;
  protected faultHoldError: string | null = null;
  /** Of the last failed read in FAULT, which is logged once. */
  protected faultReadError: string | null = null;
  /** Per arm, the opening a gripper stopped at on an object. */
  protected blockedGripperOpenings: Record<string, number> | null = null;
  protected readonly log: ControlLog;

  /**
   * Makes the loop's parts. The loop holds nothing yet: `create` (PEAR's constructor) or `open` makes a loop that
   * holds the arms.
   */
  constructor(
    readonly driver: JointDriver<State>,
    controlConfig: ControlConfig,
    robotConfig: RobotConfig,
    options: ControlLoopOptions = {},
  ) {
    this.clock = options.clock ?? secondsClock();
    const log = options.log ?? logErrorsToConsole;
    this.log = (level, message, error) => {
      try {
        log(level, message, error);
      } catch (logError) {
        // Python's logging does not raise what a handler raised, it prints it: a log that throws breaks neither a
        // control period nor a caller's call, and in `fail` the hold is commanded after it
        try {
          console.error("--- Logging error ---", logError);
        } catch {
          // (nobody is left to tell)
        }
      }
    };
    this._controlConfig = deepCopy(controlConfig);
    this._robotConfig = deepCopy(robotConfig);
    this.layout = this._robotConfig.LAYOUT;
    this.limits = this._robotConfig.jointLimits();
    this.tracking = new Tracking(this._robotConfig, this.limits, this.layout);
    this.recoveryPolicy = new this.loopClass.RECOVERY_POLICY_CLASS();

    this.trajectory = this.newTrajectory();
    this.stopOperation = new TargetOperation(this.trajectory);
    this.settlingWindow = this.newWindow(this._controlConfig.settle_window_s, false);
  }

  /**
   * Returns a control loop that holds the arms of `driver` where they are: PEAR's constructor. It waits until their
   * feedback has settled and commands that hold; it starts nothing (`start`, or `step` by hand).
   */
  static async create<Loop extends JointControlLoop<any>>( // eslint-disable-line @typescript-eslint/no-explicit-any
    this: new (
      driver: any, // eslint-disable-line @typescript-eslint/no-explicit-any
      controlConfig: ControlConfig,
      robotConfig: any, // eslint-disable-line @typescript-eslint/no-explicit-any
      options?: ControlLoopOptions,
    ) => Loop,
    driver: Loop["driver"],
    controlConfig: ControlConfig,
    robotConfig: Loop["_robotConfig"],
    options: ControlLoopOptions = {},
  ): Promise<Loop> {
    const controlLoop = new this(driver, controlConfig, robotConfig, options);
    await controlLoop.takeHold();

    return controlLoop;
  }

  /** Returns a started control loop on `driver`, which is closed if the start fails. */
  static async open<Loop extends JointControlLoop<any>>( // eslint-disable-line @typescript-eslint/no-explicit-any
    this: new (
      driver: any, // eslint-disable-line @typescript-eslint/no-explicit-any
      controlConfig: ControlConfig,
      robotConfig: any, // eslint-disable-line @typescript-eslint/no-explicit-any
      options?: ControlLoopOptions,
    ) => Loop,
    driver: Loop["driver"],
    controlConfig: ControlConfig,
    robotConfig: Loop["_robotConfig"],
    options: ControlLoopOptions = {},
  ): Promise<Loop> {
    try {
      const controlLoop = new this(driver, controlConfig, robotConfig, options);
      await controlLoop.takeHold();
      controlLoop.start();

      return controlLoop;
    } catch (error) {
      await driver.close();
      throw error;
    }
  }

  /** A copy of the configuration the control loop runs with. */
  get controlConfig(): ControlConfig {
    return deepCopy(this._controlConfig);
  }

  /** A copy of the robot's settings the control loop runs with. */
  get robotConfig(): RobotConfig {
    return deepCopy(this._robotConfig);
  }

  /** The class of this loop, whose constants and names a robot's loop may give its own. */
  protected get loopClass(): typeof JointControlLoop {
    return this.constructor as typeof JointControlLoop;
  }

  /** Starts the loop that steps once every control period: `run`, which PEAR runs in a thread. */
  start(): void {
    if (this.thread !== null) {
      throw new RuntimeError("Runtime already started");
    }

    const thread: ControlThread = { isAlive: true, ended: Promise.resolve() };
    thread.ended = this.run().then(
      () => {
        thread.isAlive = false;
      },
      (error: unknown) => {
        // the loop keeps the state it had, and nothing steps it any more: the hold is not renewed and tracking is
        // not checked. `run` has told the log; Python also prints the traceback of a thread that died, whatever the
        // logger does, so the failure is printed here too, also for a caller whose `log` drops it
        thread.isAlive = false;
        try {
          console.error(`Exception in thread ${this.loopClass.THREAD_NAME}:`, error);
        } catch {
          // (a console that throws must not make `ended` reject, which `close` awaits)
        }
      },
    );
    this.thread = thread;
  }

  /**
   * Starts a maintenance move from the held targets to the absolute joint `targets`, one for each arm, within
   * `caps`.
   */
  move(targets: ArmTargets, options: { speedScale?: number; caps?: MotionCaps | null } = {}): void {
    const arms = this.layout.arms;
    const named = Object.keys(targets);
    if (named.length !== arms.length || !arms.every((arm) => named.includes(arm))) {
      throw new ValueError(`An atomic station target must include ${arms.join(" and ")}`);
    }

    const move = JointMove.build(
      this.trajectory.input.currentPosition,
      this.layout.join(targets),
      this.limits,
      this.layout,
      { speedScale: options.speedScale ?? 1.0, caps: options.caps ?? null },
    );
    this.dispatchJointMove(move);
    // (Python writes the targets as they were given; PEAR's own commands give each arm's as a tuple)
    this.log("info", `move requested: ${pythonRepr(targets, TUPLE_PARENT)}`);
  }

  /**
   * Checks and starts a checked joint move, and returns whether it started: not while the HOLD of `observation` is
   * unsettled.
   */
  dispatchJointMove(move: JointMove, observation: ObservationReference | null = null): boolean {
    this.verifyReference(observation);
    if (observation !== null && (!this.isSettled || this.status !== ControlState.HOLD)) {
      return false;
    }
    if (this.status !== ControlState.HOLD) {
      throw new RuntimeError(`Cannot start a move in ${this.status}`);
    }
    if (!(move instanceof JointMove)) {
      throw new PythonTypeError("Expected a checked JointMove");
    }
    const trajectoryInput = this.trajectory.input;
    if (!allClose(move.start, trajectoryInput.currentPosition, this.loopClass.START_EPSILON)) {
      throw new ValueError("Trajectory start no longer matches held commands");
    }
    const plannedSpeed = trajectoryInput.currentVelocity
      .map(Math.abs)
      .reduce((fastest, speed) => (speed > fastest ? speed : fastest));
    if (plannedSpeed > this.loopClass.STATIONARY_EPSILON) {
      throw new RuntimeError("Joint move requires stationary planned state");
    }

    this.trajectory.headFor(move.goal, move.motionCaps);
    this.begin(
      new JointMoveOperation(this.trajectory, move),
      move.durationS + this._controlConfig.settle_timeout_s + this.loopClass.MOVE_MARGIN_S,
    );

    return true;
  }

  /**
   * Starts streaming the absolute joint vectors `positions` at `rateHz`, and returns whether it started: not while
   * the HOLD of `observation` is unsettled.
   */
  startSequence(
    positions: ArrayLike<ArrayLike<number>>,
    options: { rateHz: number; observation?: ObservationReference | null },
  ): boolean {
    const operation = new SequenceOperation(this.trajectory, positions, options.rateHz);
    const observation = options.observation ?? null;

    this.verifyReference(observation);
    if (this.status !== ControlState.HOLD) {
      throw new RuntimeError("A finite sequence requires HOLD");
    }
    if (observation !== null && !this.isSettled) {
      return false;
    }

    this.begin(operation, operation.positions.length / operation.rateHz + this.loopClass.SEQUENCE_MARGIN_S);

    return true;
  }

  /**
   * Starts the robot's gripper operation for `gripperRequest` and returns it; the held arm targets stay unchanged.
   */
  beginGrippers(gripperRequest: unknown): GripperOperation {
    if (this.status !== ControlState.HOLD) {
      throw new RuntimeError("Another operation owns the targets");
    }
    this.checkFresh(this.states);

    const operation = new this.loopClass.GRIPPER_OPERATION_CLASS(
      this._controlConfig,
      this._robotConfig,
      this.targets,
      this.states,
      gripperRequest,
    );
    // grippers advance their own profiles: only the shared command state and the caps a stop uses are synchronized,
    // rather than planning a move that changes nothing
    this.trajectory.headFor(this.layout.join(this.targets));
    this.blockedGripperOpenings = null;
    this.begin(operation, this.loopClass.GRIPPER_TIMEOUT_S);

    return operation;
  }

  /** Throws unless the feedback is fresh and `observation` belongs to the current operation. */
  verifyReference(observation: ObservationReference | null): void {
    this.checkFresh(this.states);
    SnapshotCheck.validateReference(this.feedbackSnapshot(), observation);
  }

  /**
   * Brakes the current operation into a HOLD, with `reason` as how the motion ended; in a HOLD, invalidates pending
   * observations. It takes effect before it returns unless a step is under way, which it then follows.
   */
  async stop(options: { reason?: string } = {}): Promise<void> {
    await this.lock.run(() => this.stopLocked(options.reason ?? MotionEndReason.STOPPED));
  }

  /**
   * Reacquires a stable hold after a fault, without enabling motors or replaying an action, and returns the snapshot
   * then.
   */
  async recover(options: { cancellation?: Cancellation | null; timeoutS?: number | null } = {}): Promise<ControlSnapshot> {
    const cancellation = options.cancellation ?? null;
    const hasAutomaticTimeout = options.timeoutS == null;
    const timeoutS = options.timeoutS ?? this.recoveryPolicy.defaultTimeoutS(this._controlConfig);
    SnapshotCheck.checkTimeout(timeoutS, "Recovery timeout");
    OperatorPaused.checkCancelled(cancellation);

    const request = await this.lock.run(() => {
      if (this.status !== ControlState.FAULT) {
        throw new RuntimeError("Control recovery requires FAULT");
      }
      if (this.recoveryRequest !== null) {
        throw new RuntimeError("Control recovery is already running");
      }
      if (this.faultHoldError !== null) {
        throw new RuntimeError(this.layout.texts.failed_hold + this.faultHoldError);
      }
      if (this.exitEvent.isSet || (this.thread !== null && !this.thread.isAlive)) {
        throw new RuntimeError("Recovery blocked: control thread is not running");
      }

      // a recovery always needs a new window, even if the fault's telemetry looks stable
      const durationS = Math.max(this.loopClass.RECOVERY_WINDOW_FLOOR_S, this._controlConfig.settle_window_s);
      const made = new RecoveryRequest(this.newWindow(durationS, true), this.clock.monotonic() + timeoutS, {
        cancellation,
        hasAutomaticTimeout,
        clock: this.clock,
      });
      this.recoveryRequest = made;

      return made;
    });

    try {
      // the request's own deadline, which a release moves, ends the wait
      const snapshot = await SnapshotCheck.poll(
        () => this.recoveryOutcome(request),
        this._controlConfig.controlPeriodS,
        Infinity,
        null,
        this.clock,
      );

      return snapshot as ControlSnapshot;
    } finally {
      await this.lock.run(() => {
        if (this.recoveryRequest === request) {
          this.recoveryRequest = null;
        }
      });
    }
  }

  /** Runs one control period: reads, checks, and advances the operation or the recovery. */
  async step(): Promise<void> {
    await this.lock.run(() => this.stepLocked());
  }

  /** Returns the control loop's state, feedback, arrival, settling, recovery and motion, measured now. */
  snapshot(): ControlSnapshot {
    const feedback = this.feedbackSnapshot();
    const captureTime = feedback.captured_monotonic_s;
    const stateTimeoutS = this._controlConfig.state_timeout_s;
    const isFresh = Object.values(this.states).every((state) =>
      ArmState.isFresh(captureTime - state.sampledMonotonicS, stateTimeoutS),
    );
    const recoveryRequest = this.recoveryRequest;
    const endReason = this.motionEndReason;

    return {
      ...feedback,
      fault_details: structuredClone(feedback.fault_details),
      arrival: {
        ...this.tracking.arrival(SnapshotCheck.stateVector(feedback), this.requestedPosition()),
        settled: this.status === ControlState.HOLD && this.isSettled && isFresh,
      },
      settling: structuredClone(this.settlingWindow.metrics) as Record<string, unknown>,
      recovery:
        recoveryRequest !== null
          ? {
              phase: recoveryRequest.phase,
              metrics: structuredClone(recoveryRequest.window.metrics) as Record<string, unknown>,
            }
          : null,
      motion: {
        ...this.driver.telemetry(),
        // the plain word, also of a stop that a robot gave a word of its own
        end_reason: endReason === null ? null : String(endReason),
        settling: MOVING_CONTROL_STATES.includes(this.status) && this.settleSince !== null,
      },
    };
  }

  /**
   * Returns the joint vector the current operation heads for, a gripper stopped on an object where it stopped.
   */
  requestedPosition(): number[] {
    const requestedPosition = this.trajectory.input.targetPosition;
    for (const [arm, opening] of Object.entries(this.blockedGripperOpenings ?? {})) {
      requestedPosition[this.layout.gripperIndices[this.layout.arms.indexOf(arm)] as number] = opening;
    }

    return requestedPosition;
  }

  /** Returns the control loop's stability history evaluated with `criteria`, without sampling again. */
  stability(criteria: StabilityCriteria = {}): StabilityMetrics {
    return this.settlingWindow.evaluate(criteria);
  }

  /** Waits for a settled HOLD that `accepts` accepts and returns its snapshot; any failure stops the arms. */
  async waitForHold(timeoutS: number, options: WaitForHoldOptions = {}): Promise<ControlSnapshot> {
    // accepts may annotate the snapshot but never commands; even an unguarded caller is bound to the operation seen
    // on entry. PEAR's guard reads that operation's generation under the lock, so after a control period that is
    // under way: here too, and at once when none is
    const guard =
      options.guard ?? (this.lock.isHeld ? await this.lock.run(() => new ActionGuard(this)) : new ActionGuard(this));
    const label = options.label ?? "Motion";

    const readSnapshot = (): Promise<ControlSnapshot> =>
      this.lock.run(() => {
        guard.check();
        return SnapshotCheck.validateSnapshot(this.snapshot(), this._controlConfig);
      });

    try {
      return await SnapshotCheck.waitReady(readSnapshot, {
        timeoutS,
        controlPeriodS: this._controlConfig.controlPeriodS,
        guard,
        makeTimeoutError: (snapshot) =>
          new TimeoutError(`${label} did not settle before timeout: ${pythonRepr(snapshot)}`),
        accepts: options.accepts ?? null,
        clock: this.clock,
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  /** Stops, waits for the HOLD if possible, and always releases the hardware. */
  async shutdown(): Promise<void> {
    try {
      await this.stop();
      if (this.status !== ControlState.FAULT && this.status !== ControlState.CLOSED) {
        await this.waitForHold(this.loopClass.SHUTDOWN_WAIT_S, { label: "Stop" });
      }
    } finally {
      await this.close();
    }
  }

  /** Releases the hardware without waiting for motion; a live owner calls `shutdown`. */
  async close(): Promise<void> {
    this.exitEvent.set();
    const thread = this.thread;
    if (thread !== null) {
      // PEAR joins its thread for this long
      await Promise.race([thread.ended, this.clock.sleep(this.loopClass.THREAD_JOIN_S)]);
      if (thread.isAlive) {
        throw new RuntimeError("Control thread did not stop; hardware not closed concurrently");
      }
    }

    await this.lock.run(async () => {
      this.finishRecovery(new RuntimeError("Station closed during recovery"));
      if (this.status !== ControlState.CLOSED) {
        try {
          await this.driver.close();
        } finally {
          this.status = ControlState.CLOSED;
          this.generation += 1;
        }
      }
    });
  }

  /** Has the operation that runs, if one does, stop once `cancellation` is set. */
  attachCancellation(cancellation: Cancellation | null): void {
    if (this.status === ControlState.RUNNING) {
      this.operationCancellation = cancellation;
    }
  }

  /** Returns a trajectory at this control loop's limits, layout and rate. */
  newTrajectory(): JointTrajectory {
    return new JointTrajectory(this.limits, this.layout, this._controlConfig);
  }

  /** Throws unless every arm's reading is recent and finite. */
  checkFresh(states: Readonly<Record<string, ArmState>>): void {
    const now = this.clock.monotonic();

    for (const arm of this.layout.arms) {
      const ageS = now - states[arm]!.sampledMonotonicS;
      if (!ArmState.isFresh(ageS, this._controlConfig.state_timeout_s, ArmState.CLOCK_SLACK_S)) {
        throw new RuntimeError(formatTemplate(this.layout.texts.stale_feedback, { arm, age: ageS }));
      }
    }
  }

  /** Throws unless `states` is a complete, finite and fresh reading within the feedback bounds. */
  checkStates(states: Readonly<Record<string, ArmState>>): void {
    const arms = this.layout.arms;
    const read = Object.keys(states);
    if (read.length !== arms.length || !arms.every((arm) => read.includes(arm))) {
      throw new RuntimeError("Missing arm feedback");
    }
    for (const state of Object.values(states)) {
      state.check(this.layout);
    }
    this.checkFresh(states);

    // encoder quantization and resting against a mechanical stop can put measured feedback slightly beyond a bound;
    // commands still use the exact bounds
    const positions = this.layout.join(
      Object.fromEntries(Object.entries(states).map(([arm, state]) => [arm, state.position])),
    );
    this.limits.checkPositions(positions, this.layout, this.limits.feedbackTolerance);
  }

  /** Throws a TrackingError if a measured joint of `feedback` is too far from its held target. */
  checkTracking(feedback: ControlFeedback): void {
    this.tracking.check(SnapshotCheck.stateVector(feedback), SnapshotCheck.targetVector(feedback));
  }

  /**
   * Returns the planned velocity of `sample` for each arm that is fed it, zero for the rest, null if none is.
   */
  plannedVelocities(sample: CommandSample): Record<string, number[]> | null {
    const fedArms = this.layout.arms.filter((arm) => this._robotConfig.feedsVelocity(arm));
    if (fedArms.length === 0) {
      return null;
    }

    const velocities = this.layout.split(sample.velocity);

    return Object.fromEntries(
      this.layout.arms.map((arm) => [
        arm,
        fedArms.includes(arm) ? velocities[arm]! : new Array<number>(this.layout.coordinateCount).fill(0.0),
      ]),
    );
  }

  /**
   * Commands `targets` as the new hold during a recovery; a failed write blocks later ones. A recovery policy calls
   * it inside the loop's step.
   */
  async transferHold(targets: ArmTargets, velocities: ArmVectors | null = null): Promise<void> {
    // (PEAR's policies hand tuples; here the driver and the loop get tuples of what the policy handed)
    const held = tupleTargets(targets);
    try {
      await this.driver.send(held, velocities);
    } catch (error) {
      this.faultHoldError = errorText(error);
      throw new RuntimeError(`Recovery hold write failed: ${errorText(error)}`, { cause: error });
    }

    this.targets = held;
  }

  /**
   * Ends `request` in a HOLD at the current targets, with a new operation generation. A recovery policy calls it
   * inside the loop's step.
   */
  completeRecovery(request: RecoveryRequest): void {
    OperatorPaused.checkCancelled(request.cancellation);

    // later actions start at the acknowledged hold, with zero derivatives
    this.trajectory = this.newTrajectory();
    this.trajectory.hold(this.layout.join(this.targets));
    this.stopOperation = new TargetOperation(this.trajectory);
    this.operation = null;
    this.operationCancellation = null;
    this.operationDeadline = null;
    this.settleSince = null;
    request.window.relax(this._controlConfig.settle_window_s);
    this.settlingWindow = request.window;
    this.isSettled = true;
    this.generation += 1;
    this.status = ControlState.HOLD;
    this.fault = null;
    this.faultDetails = null;
    this.motionEndReason = MotionEndReason.RECOVERED;
    this.finishRecovery();
  }

  /**
   * Steps the control loop once every control period until it is closed or a step fails: what PEAR's control thread
   * runs. `start` begins it; a caller that wants its end awaits it instead.
   */
  async run(): Promise<void> {
    const controlPeriodS = this._controlConfig.controlPeriodS;

    try {
      let deadline = this.clock.monotonic();
      while (!this.exitEvent.isSet) {
        await this.step();

        deadline += controlPeriodS;
        const now = this.clock.monotonic();
        if (deadline < now) {
          // never several control periods in a burst after a stall
          deadline = now + controlPeriodS;
        }
        await this.exitEvent.wait(Math.max(0, deadline - now), this.clock);
      }
    } catch (error) {
      // the loop ends with the state as it was; the failure is logged before it propagates
      this.log("error", "The control thread failed", error);
      throw error;
    }
  }

  /**
   * PEAR's constructor from its first reading on: waits for settled feedback, takes the measured pose as the hold
   * and commands it.
   */
  protected async takeHold(): Promise<void> {
    this.states = await this.awaitSettledFeedback();
    this.isSettled = Boolean(this.settlingWindow.metrics.stable ?? false);
    // the hold is exactly where the arms are: feedback may rest just past a limit against a mechanical stop, and
    // clipping it into the bounds would jump the arm at enable
    this.targets = Object.fromEntries(
      this.layout.arms.map((arm) => [arm, Object.freeze(this.states[arm]!.position.map(Number))]),
    );
    this.trajectory.hold(this.layout.join(this.targets));
    await this.driver.send(this.targets);
  }

  /** PEAR's `step` under its lock. */
  protected async stepLocked(): Promise<void> {
    if (this.status === ControlState.CLOSED) {
      return;
    }
    if (this.status === ControlState.FAULT) {
      await this.stepFault();
      return;
    }

    try {
      const now = this.clock.monotonic();
      const states = await this.read();
      // only a checked reading is published: a malformed one must not break status or STOP after a fault
      this.states = states;
      const feedback = this.feedbackSnapshot();
      this.checkTracking(feedback);
      // (the status is read after the await: what a caller began during the reading was begun before this step)
      if (this.status === ControlState.HOLD) {
        this.isSettled = this.settlingWindow.checkHold(feedback);
        const generation = this.generation;
        await this.driver.refreshHold(this.targets);
        if (this.generation !== generation) {
          // a caller began an operation during the renewal: in PEAR nothing between the renewal and the step's end
          // leaves a HOLD, so the step is over here, and the operation starts with the next period
          return;
        }
      }
      if (this.operationCancellation !== null && this.operationCancellation.aborted) {
        await this.stopLocked(MotionEndReason.CANCELLED);
      }
      if (MOVING_CONTROL_STATES.includes(this.status)) {
        await this.advance(now, feedback);
      }
    } catch (error) {
      await this.fail(error);
    }
  }

  /** PEAR's `stop` under its lock. */
  protected async stopLocked(reason: string): Promise<void> {
    this.finishRecovery(new OperatorPaused("Control recovery interrupted by the operator"));
    if (this.status !== ControlState.RUNNING) {
      if (this.status === ControlState.HOLD) {
        this.generation += 1;
      }
      return;
    }

    this.motionEndReason = reason;
    const stopsFromStandstill = (this.operation as Operation).stopsFromStandstill;
    this.operation = null;
    this.operationCancellation = null;
    this.generation += 1;
    const brakingCaps = this.loopClass.BRAKING === Braking.STATION_LIMITS ? this.limits.brakingCaps() : null;
    try {
      this.trajectory.stop({ fromStandstill: stopsFromStandstill, brakingCaps });
    } catch (error) {
      await this.fail(error);
      return;
    }

    const marginS = this._controlConfig.settle_timeout_s + this.loopClass.MOVE_MARGIN_S;
    this.operationDeadline = this.clock.monotonic() + this.trajectory.durationS + marginS;
    this.settleSince = null;
    this.settlingWindow.reset();
    this.isSettled = false;
    this.status = ControlState.STOPPING;
    this.log("info", "controlled stop requested");
  }

  /** Returns the arms' reading once the transient of enabling has settled; the hardware may engage its own hold first. */
  protected async awaitSettledFeedback(): Promise<Record<string, State>> {
    const readSettling = async (): Promise<[boolean, Record<string, State>]> => {
      const states = await this.read();
      const isSettled = this.settlingWindow.add({ arms: this.armFeedback(states, this.clock.monotonic()) });

      return [isSettled, states];
    };

    return SnapshotCheck.poll(
      readSettling,
      this._controlConfig.controlPeriodS,
      this._controlConfig.settle_timeout_s,
      () => new RuntimeError(this.layout.texts.unsettled_start),
      this.clock,
    );
  }

  /** Makes `operation` the running one, which times out after `timeoutS`. */
  protected begin(operation: Operation, timeoutS: number): void {
    this.operation = operation;
    this.operationCancellation = null;
    this.operationDeadline = this.clock.monotonic() + timeoutS;
    this.settleSince = null;
    this.settlingWindow.reset();
    this.isSettled = false;
    this.generation += 1;
    this.status = ControlState.RUNNING;
    this.motionEndReason = null;
  }

  /**
   * Returns whether `request` is done, with the snapshot then; throws its error, the operator's pause or its
   * timeout.
   */
  protected recoveryOutcome(request: RecoveryRequest): Promise<[boolean, ControlSnapshot | null]> {
    return this.lock.run((): [boolean, ControlSnapshot | null] => {
      if (request.isDone) {
        if (request.error !== null) {
          throw request.error;
        }
        return [true, this.snapshot()];
      }

      OperatorPaused.checkCancelled(request.cancellation);
      request.checkDeadline();

      return [false, null];
    });
  }

  /** Reads the arms in FAULT and, if a recovery was requested, advances it. */
  protected async stepFault(): Promise<void> {
    // only an explicit recovery request may change the hold target in FAULT; a failed read keeps the last reading,
    // whose age then shows it is stale
    const request = this.recoveryRequest;
    try {
      this.states = await this.read(request !== null);
      if (request !== null) {
        await this.checkRecovery(request);
      }
      this.faultReadError = null;
    } catch (error) {
      if (request === null && errorText(error) !== this.faultReadError) {
        this.log("warning", `feedback read failed in FAULT: ${errorText(error)}`, error);
        this.faultReadError = errorText(error);
      }
      this.finishRecovery(error);
    }
  }

  /** Advances `request` by one control period with the recovery policy. */
  protected async checkRecovery(request: RecoveryRequest): Promise<void> {
    OperatorPaused.checkCancelled(request.cancellation);
    request.checkDeadline();

    const feedback = this.feedbackSnapshot();
    await this.recoveryPolicy.step(this, request, feedback, request.window.add(feedback));
  }

  /**
   * Sends the next sample of the running or stopping operation, and enters HOLD once it has finished and settled.
   */
  protected async advance(now: number, feedback: ControlFeedback): Promise<void> {
    if (now > (this.operationDeadline as number)) {
      if (this.status === ControlState.STOPPING) {
        throw new TimeoutError("Controlled stop exceeded its deadline");
      }
      await this.stopLocked(MotionEndReason.ACTION_TIMEOUT);
      if (this.status === ControlState.FAULT) {
        return;
      }
    }

    const operation = this.operation ?? this.stopOperation;
    let sample: CommandSample;
    try {
      sample = operation.advance(now, this.states, this.targets);
    } catch (error) {
      if (!(error instanceof OperationInterrupted)) {
        throw error;
      }
      await this.stopLocked(error.reason);
      if (this.status === ControlState.FAULT) {
        return;
      }
      sample = this.stopOperation.advance(now, this.states, this.targets);
    }

    this.limits.checkCommand(sample.position, this.layout.join(this.targets), this.layout);
    const targets = Object.fromEntries(
      Object.entries(this.layout.split(sample.position)).map(([arm, positions]) => [
        arm,
        Object.freeze(positions.map(Number)),
      ]),
    );
    await this.driver.send(targets, this.plannedVelocities(sample));
    this.targets = targets;
    this.trajectory.accept(sample);
    if (!sample.isFinished) {
      return;
    }

    if (this.settleSince === null) {
      this.settleSince = now;
      this.settlingWindow.reset();
    }
    if (this.settlingWindow.add(feedback)) {
      if (this.operation instanceof GripperOperation) {
        this.blockedGripperOpenings = this.operation.blockedGripperOpenings;
      }
      this.operation = null;
      this.operationCancellation = null;
      this.operationDeadline = null;
      this.isSettled = true;
      if (this.status === ControlState.RUNNING) {
        this.motionEndReason = MotionEndReason.FINISHED;
      }
      this.status = ControlState.HOLD;
      this.log("info", `motion finished at ${pythonRepr(this.targets, TUPLE_PARENT)}`);
    } else if (now - this.settleSince > this._controlConfig.settle_timeout_s) {
      throw this.settlingWindow.stabilityError("Motion remained unstable before timeout");
    }
  }

  /** Latches `error` as the fault and commands the targets the operation and the recovery policy hold then. */
  protected async fail(error: unknown): Promise<void> {
    this.finishRecovery(error);
    if (this.operation !== null) {
      this.targets = tupleTargets(
        this.operation.faultTargets(error, this.clock.monotonic(), this.states, this.targets),
      );
    }
    this.targets = tupleTargets(this.recoveryPolicy.faultTargets(this));

    this.operation = null;
    this.generation += 1;
    this.status = ControlState.FAULT;
    // from here to the hold's command nothing throws, whatever `error` is, whatever it carries and whatever the log
    // does: an arm whose fault is latched is always commanded to hold
    this.fault = errorText(error);
    this.faultDetails = faultDetailsOf(error);
    this.isSettled = false;
    this.settlingWindow.reset();
    this.motionEndReason = MotionEndReason.FAULT;
    this.faultReadError = null;
    this.log("error", `station fault: ${errorText(error)}`, error);

    try {
      await this.driver.send(this.targets);
      this.faultHoldError = null;
    } catch (holdError) {
      this.faultHoldError = errorText(holdError);
      this.log("error", "Could not command a hold; a physical stop may be required", holdError);
    }
  }

  /** Ends the recovery request, if there is one, with `error` or without one. */
  protected finishRecovery(error: unknown = null): void {
    if (this.recoveryRequest !== null) {
      this.recoveryRequest.error = error;
      this.recoveryRequest.isDone = true;
      this.recoveryRequest = null;
    }
  }

  /** Returns a checked reading of every arm; for a recovery, only after the hardware was found healthy. */
  protected async read(isForRecovery = false): Promise<Record<string, State>> {
    const states = isForRecovery ? await this.driver.readForRecovery() : await this.driver.read();
    this.checkStates(states);

    return states;
  }

  /** Returns a new stability window of `durationS` over this control loop's arms. */
  protected newWindow(durationS: number, isStrict: boolean): StabilityWindow {
    return new StabilityWindow(
      this._controlConfig,
      this._robotConfig,
      { durationS, isStrict, checksVelocityRms: this.loopClass.CHECKS_VELOCITY_RMS },
      this.clock,
    );
  }

  /** Returns the current control data, fresh on every call. */
  protected feedbackSnapshot(): ControlFeedback {
    const captureTime = this.clock.monotonic();

    return {
      captured_monotonic_s: captureTime,
      status: this.status,
      fault: this.fault,
      fault_details: this.faultDetails,
      generation: this.generation,
      targets: Object.fromEntries(this.layout.arms.map((arm) => [arm, this.targets[arm] as readonly number[]])),
      arms: this.armFeedback(this.states, captureTime),
    };
  }

  /** Returns each arm's reading as a snapshot's feedback at the monotonic time `now`. */
  protected armFeedback(states: Readonly<Record<string, ArmState>>, now: number): Record<string, ArmFeedback> {
    return Object.fromEntries(this.layout.arms.map((arm) => [arm, states[arm]!.feedback(now)]));
  }
}
