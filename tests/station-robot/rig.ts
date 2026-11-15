// PEAR's stepped rig of its robot, as tools/fixtures/robot_fixtures.py ran it, for pear.js's robot:
//   tests/deploy/station/control_rig.py      StandInClock (each sleep steps the loop once), SteppedControlLoop
//   tests/deploy/station/stand_in_robots.py  SteppedStandInSO101Robot (the SO-101 on its own driver over the
//                                            stand-in arm, its control loop without a thread)
//   tests/deploy/station/stand_in_cameras.py StandInCameras (without the drawing: a frame is its shape)
//   tools/fixtures/robot_fixtures.py         RecordingClock, IoLog, Ids, the recorded kinematics, Session
// The stand-in arm, its driver and the record of the driver's calls are the control loop's tests' (../station-loop).
//
// A session of the fixtures is a script of calls of the robot with what PEAR did at each. `SessionPlayer` makes the
// same calls of pear.js's robot and builds, for every step, the same record: what the call returned or threw, every
// sleep it took with the driver's calls and the loop's state, the clock, the UUIDs drawn, what the kinematics were
// asked, the log, and the robot's status with its snapshot at the step's end.

import { SO101Kinematics, type ArmDelta } from "../../src/so101/kinematics/kinematics";
import { ARM, LAYOUT } from "../../src/so101/layout";
import { SO101ControlLoop } from "../../src/so101/joint/control_loop";
import type { SO101RobotConfig } from "../../src/so101/config";
import { SO101Robot, type SO101RobotOptions } from "../../src/so101/robot";
import { CameraSource, type CameraPreview } from "../../src/station/cameras";
import { ActionGuard } from "../../src/station/joint/action_guard";
import type { MonotonicClock } from "../../src/station/joint/clock";
import type { ControlConfig } from "../../src/station/joint/config";
import type { JointControlLoop } from "../../src/station/joint/control_loop";
import type { JointDriver } from "../../src/station/joint/driver";
import { RuntimeError, type Cancellation } from "../../src/station/joint/errors";
import type { JointMove } from "../../src/station/joint/trajectory";
import type { MotionResult, MotionStatus } from "../../src/station/motion/results";
import type { ActionMode, ControlLoopClass, StationConfig } from "../../src/station/robot";
import type { Camera, CameraFrame, HomePlan, Observation } from "../../src/station/schemas";
import type { SO101Config } from "../../src/so101/config";
import { SINGLE_ARM_POSE_FORMAT } from "../../src/so101/formats";
import { Comparison, plain } from "../station-loop/compare";
import { makeResponse, Probe, replaced, StandInSO101Driver, type StandInClock, type StandInSO101Arm } from "../station-loop/standins";
import { CONFIG_OPTIONS, errorRecord, makeError, stationOf, type ErrorSpec, type Outcome, type RecordedError } from "./fixtures";
import { moveRecord, ScriptedCamera } from "./parts_checks";

const FORMAT_NAME = SINGLE_ARM_POSE_FORMAT.name;
/** The most control periods a step may take beyond what PEAR's took before the player gives up on it. */
const RUNAWAY_TICKS = 3000;

/** What a sleep did, as the fixtures hold it: how long it was, the driver's calls since the sleep before, the
 * loop's state after its step, and what the script did right after it. */
export interface TickRecord {
  d: number;
  io: unknown[];
  s?: string;
  hooks?: Record<string, unknown>[];
}

/** One answer of the kinematics, as the fixtures hold it. */
export interface KinematicsRecord {
  joints: number[];
  delta: number[];
  out: Outcome<number[]>;
}

/** A step of a session as the fixtures hold it: the call, and what PEAR did. */
export interface StepRecord {
  op: string;
  hooks?: HookRecord[];
  out: Outcome;
  ticks: TickRecord[];
  io: unknown[];
  clock: [number, number];
  uuids?: string[];
  ik?: KinematicsRecord[];
  log?: string[][];
  after: Record<string, unknown>;
  [field: string]: unknown;
}

interface HookRecord {
  tick?: number;
  on?: string;
  optional?: boolean;
  do: Record<string, unknown>[];
}

export interface SessionRecord {
  name: string;
  source: string;
  about: string;
  station: string;
  cameras: "none" | "drawn" | "wrist";
  action_mode: ActionMode;
  /** What this session alone changes of the settings of its station's robot. */
  settings?: Record<string, unknown>;
  steps: StepRecord[];
}

/** Returns `settings` with the entries of `changes` written over them, section by section. */
function withChanges<Settings>(settings: Settings, changes: Record<string, unknown>): Settings {
  const changed: Record<string, unknown> = { ...(settings as Record<string, unknown>) };
  for (const [key, value] of Object.entries(changes)) {
    const held = changed[key];
    const isSection = (entry: unknown): boolean => typeof entry === "object" && entry !== null && !Array.isArray(entry);
    changed[key] = isSection(value) && isSection(held) ? withChanges(held, value as Record<string, unknown>) : value;
  }

  return changed as Settings;
}

/** The SO-101's control loop without its thread: the stepped clock's sleeps step it (PEAR's SteppedSO101ControlLoop). */
export class SteppedSO101ControlLoop extends SO101ControlLoop {
  /** Starts no thread. */
  override start(): void {}
}

/**
 * PEAR's stand-in clock, which also keeps what every sleep did (the RecordingClock of the fixture script): time
 * stands still until a sleep advances it, and each sleep steps the attached control loop once.
 */
export class RecordingClock implements MonotonicClock {
  static readonly START_S = 100.0;

  now = RecordingClock.START_S;
  /** What each sleep steps once; null: a sleep only advances. */
  controlLoop: JointControlLoop | null = null;
  ticks: TickRecord[] = [];
  /** What a script does right after a control period, by the number of the sleep in its step. */
  afterTick: ((count: number) => Promise<Record<string, unknown>[] | null>) | null = null;
  /** Takes the driver's calls since the last time. */
  takeIo: () => unknown[] = () => [];
  /** The sleeps a step may take before the player stops it. */
  ticksLeft = Infinity;

  monotonic(): number {
    return this.now;
  }

  async sleep(durationS: number): Promise<void> {
    if (--this.ticksLeft < 0) {
      throw new Error("The step takes far more control periods than PEAR's took: stopped");
    }
    this.now += durationS;
    const controlLoop = this.controlLoop;
    if (controlLoop !== null) {
      await controlLoop.step();
    }
    const tick: TickRecord = { d: durationS, io: this.takeIo() };
    if (controlLoop !== null) {
      tick.s = controlLoop.status;
    }
    this.ticks.push(tick);
    if (this.afterTick !== null) {
      const hooked = await this.afterTick(this.ticks.length);
      if (hooked !== null && hooked.length > 0) {
        tick.hooks = hooked;
      }
    }
  }

  take(): TickRecord[] {
    const ticks = this.ticks;
    this.ticks = [];
    return ticks;
  }
}

/** A frame of the drawn cameras: PEAR's is a picture of 480 rows of 640 pixels; here only its shape is kept. */
export interface DrawnFrame {
  shape: [number, number, number];
}

/**
 * A robot's cameras that give, at every read, a fresh frame of each camera (PEAR's StandInCameras, which draw a
 * scene; the fixtures keep a drawn frame's shape and not its pixels).
 */
export class StandInCameras extends CameraSource<DrawnFrame> {
  static readonly FRAME_SIZE = [640, 480] as const;
  /** Frames per second the frame numbers count, as a camera's would. */
  static readonly FRAME_RATE = 30;

  readonly roles: string[];
  /** From when the frames are numbered, on the monotonic clock. */
  readonly startTime: number;
  isClosed = false;

  constructor(
    cameras: readonly Camera[],
    private readonly clock: Pick<MonotonicClock, "monotonic">,
  ) {
    super();
    this.roles = cameras.map((camera) => camera.role);
    this.startTime = clock.monotonic();
  }

  override async readPreview(): Promise<CameraPreview<DrawnFrame>> {
    if (this.isClosed) {
      throw new RuntimeError("Stand-in cameras stopped");
    }

    const now = this.clock.monotonic();
    const frameNumber = Math.trunc((now - this.startTime) * StandInCameras.FRAME_RATE);
    const frames: Record<string, CameraFrame<DrawnFrame>> = {};
    for (const role of this.roles) {
      const [width, height] = StandInCameras.FRAME_SIZE;
      frames[role] = { rgb: { shape: [height, width, 3] }, received_monotonic_s: now, frame_number: frameNumber };
    }

    return [frames, {}];
  }

  override async close(): Promise<void> {
    this.isClosed = true;
  }
}

type Frame = DrawnFrame | Uint8Array;

/** What the rig gives the robot it runs: PEAR's own UUIDs and, when asked, PEAR's kinematics' answers. */
export interface RigHooks {
  /** Told of the driver a session opens, on which the driver's calls are recorded. */
  attach(driver: StandInSO101Driver): void;
  /** Answers `jointTarget` in the place of pear.js's kinematics, or returns null to let them answer. */
  recordedTarget(joints: number[], delta: number[]): Outcome<number[]> | null;
  /** Told what the kinematics were asked and what was answered. */
  asked(record: KinematicsRecord): void;
}

/** pear.js's kinematics, whose answers the rig records and, in the exact comparison, PEAR's replace. */
class RiggedKinematics extends SO101Kinematics {
  rig: RigHooks | null = null;

  override jointTarget(jointPositions: ArrayLike<number>, action: ArmDelta): number[] {
    const joints = Array.from(jointPositions);
    const delta = SO101Kinematics.ARM_QUANTITIES.map((name) => action.arm[name]);
    const recorded = this.rig?.recordedTarget(joints, delta) ?? null;
    if (recorded !== null) {
      this.rig?.asked({ joints, delta, out: recorded });
      if ("error" in recorded) {
        throw makeError({ type: recorded.error.type, message: recorded.error.message }, true);
      }
      return [...recorded.ok];
    }

    let goal: number[];
    try {
      goal = super.jointTarget(jointPositions, action);
    } catch (error) {
      this.rig?.asked({ joints, delta, out: { error: errorRecord(error) } });
      throw error;
    }
    this.rig?.asked({ joints, delta, out: { ok: [...goal] } });

    return goal;
  }
}

/**
 * The stand-in SO-101 whose control loop the test steps (PEAR's SteppedStandInSO101Robot): the SO-101's own robot,
 * control loop and driver over the stand-in arm.
 */
export class SteppedStandInSO101Robot extends SO101Robot<Frame> {
  static override readonly CONTROL_LOOP_CLASS: ControlLoopClass = SteppedSO101ControlLoop;
  static override readonly KINEMATICS_CLASS: new (robotConfig: SO101RobotConfig) => SO101Kinematics = RiggedKinematics;

  rig: RigHooks | null = null;

  constructor(config: StationConfig<SO101Config>, options: SO101RobotOptions<Frame> = {}) {
    super(config, { configOptions: CONFIG_OPTIONS, ...options });
  }

  protected override makeDriver(_controlConfig: ControlConfig, robotConfig: SO101RobotConfig): JointDriver<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const driver = new StandInSO101Driver(robotConfig, this.clock);
    this.rig?.attach(driver);

    return driver;
  }

  override openPlanner(): void {
    super.openPlanner();
    (this.kinematics as RiggedKinematics).rig = this.rig;
  }

  /** The open session's control loop, or null while the robot is closed. */
  get openLoop(): JointControlLoop | null {
    return this._controlLoop;
  }

  /** The stand-in arm under the open session's driver. */
  get arm(): StandInSO101Arm {
    return (this.controlLoop.driver as unknown as StandInSO101Driver).hardware;
  }
}

/** What an observation is to a fixture (`observation_record` of the fixture script). */
function observationRecord(observation: Observation<Frame>): Record<string, unknown> {
  return {
    observation_id: observation.observation_id,
    session_id: observation.session_id,
    captured_monotonic_s: observation.captured_monotonic_s,
    joint_positions: plain(observation.joint_positions),
    camera_timestamps: plain(observation.camera_timestamps),
    images: Object.fromEntries(
      Object.entries(observation.images).map(([role, image]) => [role, image instanceof Uint8Array ? image[0] : [...image.shape]]),
    ),
    control_snapshot: plain(observation.control_snapshot),
  };
}

export interface PlayerOptions {
  /** Whether the kinematics answer what PEAR's answered (the exact comparison) or are pear.js's own. */
  kinematics: "recorded" | "own";
}

/** One robot on the stepped rig and the script that drives it: a session of the fixtures, replayed. */
export class SessionPlayer implements RigHooks {
  readonly clock = new RecordingClock();
  readonly robot: SteppedStandInSO101Robot;
  readonly periodS: number;
  private readonly observations = new Map<string, Observation<Frame>>();
  private readonly cancellations = new Map<string, { aborted: boolean }>();
  private readonly wrist: ScriptedCamera | null = null;
  private probe: Probe | null = null;
  /** What the step that runs keeps beside what it returns. */
  private side: Record<string, unknown> = {};
  private uuids: string[] = [];
  private uuidQueue: string[] = [];
  private asks: KinematicsRecord[] = [];
  private answers: KinematicsRecord[] = [];
  private log: string[][] = [];
  /** The hooks at the dispatch of a move, which run to their first wait at once and are recorded when they end. */
  private dispatching: Promise<Record<string, unknown>>[] = [];
  /** Each stand-in arm's own read, while a script has it show a velocity. */
  private readonly armReads = new Map<StandInSO101Arm, StandInSO101Arm["read"]>();

  constructor(
    readonly session: SessionRecord,
    private readonly options: PlayerOptions = { kinematics: "recorded" },
  ) {
    let cameras: CameraSource<Frame> | null = null;
    if (session.cameras === "drawn") {
      cameras = new StandInCameras(SO101Robot.CAMERAS, this.clock) as CameraSource<Frame>;
    } else if (session.cameras === "wrist") {
      this.wrist = new ScriptedCamera(this.clock);
      cameras = this.wrist.source as CameraSource<Frame>;
    }
    const station = stationOf(session.station).config;
    const config =
      session.settings === undefined ? station : { control: station.control, robot: withChanges(station.robot, session.settings) };
    this.robot = new SteppedStandInSO101Robot(config, {
      cameras,
      actionMode: session.action_mode,
      clock: this.clock,
      uuid4: () => this.nextUuid(),
      log: (logger, level, message) => {
        if (logger === "robot" || logger === "results") {
          this.log.push([logger, level, message]);
        }
      },
    });
    this.robot.rig = this;
    this.periodS = this.robot.controlPeriodS;
    this.clock.takeIo = () => this.probe?.take() ?? [];
  }

  // -- what the rig gives the robot

  attach(driver: StandInSO101Driver): void {
    const calls = this.probe?.take() ?? [];
    this.probe = new Probe(driver, LAYOUT, this.clock as unknown as StandInClock, "so101", this.periodS);
    this.probe.calls = calls;
  }

  recordedTarget(): Outcome<number[]> | null {
    if (this.options.kinematics !== "recorded") {
      return null;
    }
    const answer = this.answers.shift();
    if (answer === undefined) {
      // PEAR's planning did not ask here: let the comparison of what was asked show it
      return { error: { type: "RuntimeError", message: "PEAR's kinematics were not asked here", is_value_error: false } };
    }
    return answer.out;
  }

  asked(record: KinematicsRecord): void {
    this.asks.push(record);
  }

  private nextUuid(): string {
    const value = this.uuidQueue.shift() ?? `a UUID PEAR's robot did not draw (${this.uuids.length + 1})`;
    this.uuids.push(value);
    return value;
  }

  // -- a step

  /** Runs the step `expected` names and returns its record, built as the fixture script builds PEAR's. */
  async play(expected: StepRecord): Promise<StepRecord> {
    const { robot, clock } = this;
    const hooks = expected.hooks ?? [];
    this.side = {};
    this.uuids = [];
    this.uuidQueue = [...(expected.uuids ?? [])];
    this.asks = [];
    this.answers = [...(expected.ik ?? [])];
    this.log = [];
    this.dispatching = [];
    const clockBefore = clock.now;
    const pending = new Map<number, Record<string, unknown>[]>();
    for (const hook of hooks) {
      if (hook.tick !== undefined) {
        pending.set(hook.tick, hook.do);
      }
    }
    const onDispatch = hooks.filter((hook) => hook.on === "dispatch").map((hook) => hook.do);

    clock.ticksLeft = expected.ticks.length + RUNAWAY_TICKS;
    clock.afterTick = async (count) => {
      const operations = pending.get(count);
      if (operations === undefined) {
        return null;
      }
      pending.delete(count);
      const records: Record<string, unknown>[] = [];
      for (const operation of operations) {
        records.push(await this.hooked(operation));
      }
      return records;
    };
    const restoreDispatch = onDispatch.length > 0 ? this.interceptDispatch(onDispatch[0]!) : null;

    let out: Outcome;
    try {
      out = await this.outcome(() => this.call(expected.op, expected, expected));
    } finally {
      clock.afterTick = null;
      restoreDispatch?.();
    }
    if (this.dispatching.length > 0) {
      this.side["dispatch_hooks"] = await Promise.all(this.dispatching);
    }

    const fields: Record<string, unknown> = { ...this.arguments(expected), out, ...this.side };
    fields["ticks"] = clock.take();
    fields["io"] = this.probe?.take() ?? [];
    fields["clock"] = [clockBefore, clock.now];
    if (this.uuids.length > 0) {
      fields["uuids"] = this.uuids;
    }
    if (this.asks.length > 0) {
      fields["ik"] = this.asks;
    }
    if (this.log.length > 0) {
      fields["log"] = this.log;
    }
    const controlLoop = robot.openLoop;
    fields["after"] = {
      status: plain(robot.status(true)),
      requested: controlLoop === null ? null : plain(controlLoop.requestedPosition()),
      session_id: robot.sessionId,
      diagnostics: plain(robot.lastErrorDiagnostics),
    };

    // in the order of the fixture's step: the order is the fixture script's, the content is what is compared
    const step: Record<string, unknown> = {};
    for (const key of Object.keys(expected)) {
      if (key in fields) {
        step[key] = fields[key];
      }
    }
    for (const key of Object.keys(fields)) {
      if (!(key in step)) {
        step[key] = fields[key];
      }
    }

    return step as StepRecord;
  }

  /** What the script gave of a step: everything of its record that PEAR did not write. */
  private arguments(step: Record<string, unknown>): Record<string, unknown> {
    const written = [
      ...["out", "io", "clock", "uuids", "ik", "log", "after", "progress", "plans", "stages", "held", "dispatch_hooks", "read_hooks"],
      "stage_hooks",
    ];
    const given: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(step)) {
      // (a hold's and an idle's number of sleeps was written over by the sleeps themselves)
      if (!written.includes(key) && key !== "ticks") {
        given[key] = value;
      }
    }
    return given;
  }

  private async outcome(call: () => unknown): Promise<Outcome> {
    let value: unknown;
    try {
      value = await call();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("The step takes far more")) {
        throw error;
      }
      return { error: errorRecord(error) };
    }
    return { ok: plain(value) };
  }

  /** Runs what a script does right after a control period, inside the caller's sleep. */
  private async hooked(operation: Record<string, unknown>): Promise<Record<string, unknown>> {
    const record: Record<string, unknown> = { ...operation };
    delete record["out"];
    record["out"] = await this.outcome(() => this.call(operation["op"] as string, record, null));
    return record;
  }

  /**
   * Has the script act right after the action's move is dispatched, before any control period, as PEAR's
   * test_an_interrupted_execution_is_not_reported_as_completed does. What a hook does before its first wait happens
   * inside the dispatch, as in PEAR; its record is taken when it has ended.
   */
  private interceptDispatch(operations: Record<string, unknown>[]): () => void {
    const controlLoop = this.robot.controlLoop;
    const dispatch = controlLoop.dispatchJointMove.bind(controlLoop);
    controlLoop.dispatchJointMove = (move, observation) => {
      const value = dispatch(move, observation);
      if (value) {
        for (const operation of operations) {
          this.dispatching.push(this.hooked(operation));
        }
      }
      return value;
    };

    return () => {
      delete (controlLoop as { dispatchJointMove?: unknown }).dispatchJointMove;
    };
  }

  // -- the calls

  private observation(name: unknown): Observation<Frame> | null {
    if (name === null || name === undefined) {
      return null;
    }
    const observation = this.observations.get(name as string);
    if (observation === undefined) {
      throw new Error(`The script names an observation ${String(name)} that it has not taken`);
    }
    return observation;
  }

  private cancellation(a: Record<string, unknown>): Cancellation | null {
    return "cancellation" in a ? this.cancellations.get(a["cancellation"] as string)! : null;
  }

  private resultRecord(result: MotionResult): Record<string, unknown> {
    return {
      record: plain(result.toRecord()),
      feedback: {
        dispatched: SINGLE_ARM_POSE_FORMAT.resultFeedback(result, { isDispatched: true }),
        not_dispatched: SINGLE_ARM_POSE_FORMAT.resultFeedback(result, { isDispatched: false }),
      },
      diagnostics: plain(this.robot.lastErrorDiagnostics),
    };
  }

  private sideList<Item>(name: string): Item[] {
    if (!(name in this.side)) {
      this.side[name] = [];
    }
    return this.side[name] as Item[];
  }

  /**
   * Makes the call a step names of the robot and returns what a fixture keeps of what it returned. `expected` is
   * PEAR's record of a step of the script itself (null for a hook's operation), which tells how many sleeps a hold
   * or an idle was asked for.
   */
  private async call(op: string, a: Record<string, unknown>, expected: StepRecord | null): Promise<unknown> {
    const { robot, clock } = this;
    switch (op) {
      case "open":
        await robot.open();
        clock.controlLoop = robot.controlLoop;
        return { session_id: robot.sessionId, control_period_s: robot.controlPeriodS, action_mode: robot.actionMode };
      case "close":
        try {
          return await robot.close();
        } finally {
          if (robot.openLoop === null) {
            clock.controlLoop = null;
          }
        }
      case "status":
        return a["with_snapshot"] === true ? robot.status(true) : robot.status();
      case "wait_stationary":
        return robot.waitStationary(
          this.observation(a["observation"]),
          "cancellation" in a ? { cancellation: this.cancellation(a) } : {},
        );
      case "observe": {
        const observation = await robot.observe();
        this.observations.set(a["as"] as string, observation);
        return observationRecord(observation);
      }
      case "model_state": {
        const joints = "observation" in a ? this.observation(a["observation"])!.joint_positions : (a["joints"] as number[]);
        return robot.modelState(joints, (a["format"] as string | undefined) ?? FORMAT_NAME);
      }
      case "execute": {
        const options: Parameters<SteppedStandInSO101Robot["execute"]>[1] = {};
        if ("reference" in a) {
          options.referenceObservation = this.observation(a["reference"]);
        }
        if ("timeout_s" in a) {
          options.timeoutS = a["timeout_s"] as number;
        }
        if ("cancellation" in a) {
          options.cancellation = this.cancellation(a);
        }
        const progress = this.sideList<string>("progress");
        options.reportProgress = (phase) => {
          progress.push(phase);
        };
        return this.resultRecord(await robot.execute(a["action"], options));
      }
      case "home":
        return this.home(a);
      case "stop":
        return robot.stop();
      case "recover": {
        const options: { timeoutS?: number; cancellation?: Cancellation | null } = {};
        if ("timeout_s" in a) {
          options.timeoutS = a["timeout_s"] as number;
        }
        if ("cancellation" in a) {
          options.cancellation = this.cancellation(a);
        }
        return robot.recover(options);
      }
      case "check_fault":
        return robot.checkFault();
      case "failure_result": {
        const options: Parameters<SteppedStandInSO101Robot["failureResult"]>[1] = {
          formatName: (a["format"] as string | undefined) ?? FORMAT_NAME,
        };
        if ("status" in a) {
          options.status = a["status"] as MotionStatus;
        }
        const snapshot = a["snapshot"];
        if (snapshot === "status") {
          options.snapshot = robot.status(true);
        } else if (snapshot === "brief") {
          options.snapshot = robot.status();
        } else if (snapshot !== undefined && snapshot !== null) {
          options.snapshot = this.observation(snapshot)!.control_snapshot;
        }
        return this.resultRecord(robot.failureResult(makeError(a["error"] as ErrorSpec), options));
      }
      case "is_holding":
        return robot.isHolding(this.observation(a["observation"])!);
      case "wait_settled":
        return robot.waitSettled(a["timeout_s"] as number);
      case "hold": {
        // what PEAR's turn loop does while the model works: once a control period, whether the arm still holds the
        // observed pose
        const held = this.sideList<boolean>("held");
        for (let index = 0; index < this.sleepsAsked(a, expected); index++) {
          held.push(robot.isHolding(this.observation(a["observation"])!));
          await clock.sleep(this.periodS);
        }
        return null;
      }
      case "idle":
        for (let index = 0; index < this.sleepsAsked(a, expected); index++) {
          await clock.sleep(this.periodS);
        }
        return null;
      case "idle_until": {
        // control periods until the robot's status is one of some
        const most = (a["most"] as number | undefined) ?? 500;
        for (let count = 0; count < most; count++) {
          if ((a["statuses"] as string[]).includes(robot.status().status)) {
            return count;
          }
          await clock.sleep(this.periodS);
        }
        throw new Error(`${this.session.name}: still ${robot.status().status} after ${most} control periods`);
      }
      case "stall":
        // the station is held up: one sleep of that long, after which the control loop steps once
        await clock.sleep(a["seconds"] as number);
        return null;
      case "arm": {
        // the stand-in arm changed, as a test changes it
        const arm = robot.arm as unknown as Record<string, unknown>;
        const fields: Record<string, string> = {
          failure: "failure",
          response: "response",
          position: "position",
          is_stale: "isStale",
          is_closed: "isClosed",
          blocked_gripper_opening: "blockedGripperOpening",
        };
        for (const [name, given] of Object.entries(a["set"] as Record<string, unknown>)) {
          if (name === "velocity") {
            // every reading shows this velocity from now on (null: the arm's own readings again), as the pushed
            // arm of the agent's tasks: the stand-in arm itself always reads at rest
            const standIn = robot.arm;
            let read = this.armReads.get(standIn);
            if (read === undefined) {
              read = standIn.read.bind(standIn);
              this.armReads.set(standIn, read);
            }
            const ownRead = read;
            const velocity = given as number[] | null;
            standIn.read = velocity === null ? ownRead : async () => replaced(await ownRead(), { velocity });
            continue;
          }
          let value = given;
          if (name === "failure") {
            value = given === null ? null : makeError(given as ErrorSpec);
          } else if (name === "response") {
            value = makeResponse(given as Parameters<typeof makeResponse>[0]);
          } else if (name === "position") {
            value = (given as number[]).map(Number);
          }
          const field = fields[name];
          if (field === undefined) {
            throw new Error(`The script sets ${name} of the stand-in arm, which the player does not know`);
          }
          arm[field] = value;
        }
        return null;
      }
      case "arm_shift": {
        // the arm rests elsewhere than its command put it
        const position = [...robot.arm.position];
        position[a["index"] as number]! += a["delta"] as number;
        robot.arm.position = position;
        return null;
      }
      case "new_cancellation":
        this.cancellations.set(a["name"] as string, { aborted: false });
        return null;
      case "cancel":
        this.cancellations.get(a["name"] as string)!.aborted = true;
        return null;
      case "advance_generation":
        // another operation took the arm (as the control loop's own stop in a HOLD does)
        robot.controlLoop.generation += 1;
        return null;
      case "change_session":
        robot.sessionId = a["session_id"] as string;
        return null;
      case "loop_move": {
        // the control loop moved by hand, as PEAR's tests put the arm somewhere
        const targets = [...robot.controlLoop.targets[ARM]!];
        for (const [index, value] of Object.entries((a["set"] as Record<string, number> | undefined) ?? {})) {
          targets[Number(index)] = value;
        }
        for (const [index, value] of Object.entries((a["add"] as Record<string, number> | undefined) ?? {})) {
          targets[Number(index)]! += value;
        }
        return robot.controlLoop.move({ [ARM]: targets });
      }
      case "loop_wait_for_hold":
        return robot.controlLoop.waitForHold(a["timeout_s"] as number);
      case "loop_recover":
        // the control loop recovered by hand, as a maintenance command does: the robot's own record of the last
        // failed action stays
        return robot.controlLoop.recover();
      case "plan": {
        const action = SO101Robot.ACTION_ADAPTER.validate(a["action"]);
        const deadlineIn = (a["deadline_in"] as number | null | undefined) ?? null;
        const deadline = deadlineIn === null ? null : clock.monotonic() + deadlineIn;
        const prepared = robot.plan(this.observation(a["observation"])!, action, { deadline });
        return { gripper_request: prepared.gripperRequest, move: moveRecord(prepared.move as JointMove | null) };
      }
      case "operate_grippers": {
        const deadlineIn = (a["deadline_in"] as number | null | undefined) ?? null;
        const deadline = deadlineIn === null ? null : clock.monotonic() + deadlineIn;
        return robot.operateGrippers(a["request"], {
          observation: this.observation(a["observation"])!,
          guard: new ActionGuard(robot.controlLoop),
          deadline,
        });
      }
      case "hold_snapshot":
        return robot.holdSnapshot(this.observation(a["observation"]));
      case "verify_observation":
        return robot.verifyObservation(this.observation(a["observation"])!);
      case "camera":
        this.wrist!.apply(a);
        if ("on_read" in a) {
          // what the script does once, during the camera's next read (kept with the step that reads)
          const operations = a["on_read"] as Record<string, unknown>[];
          this.wrist!.onRead = async () => {
            const records = this.sideList<Record<string, unknown>>("read_hooks");
            for (const operation of operations) {
              records.push(await this.hooked(operation));
            }
          };
        }
        return null;
      case "facts":
        return {
          session_id: robot.sessionId,
          control_period_s: robot.controlPeriodS,
          action_mode: robot.actionMode,
          has_kinematics: robot.kinematics !== null,
          last_error_diagnostics: plain(robot.lastErrorDiagnostics),
          rate_hz: robot.controlConfig.rate_hz,
          position_tolerance: robot.robotConfig.position_tolerance,
        };
      default:
        throw new Error(`unknown step ${op}`);
    }
  }

  /**
   * How many sleeps a hold or an idle was asked for. The fixture wrote the sleeps a step took over that number, so:
   * as many as PEAR's step took when it returned, and without an end when it raised (it raises here too, or the
   * comparison shows that it did not).
   */
  private sleepsAsked(a: Record<string, unknown>, expected: StepRecord | null): number {
    if (expected === null) {
      return a["ticks"] as number;
    }
    return "ok" in expected.out ? expected.ticks.length : expected.ticks.length + 1;
  }

  private async home(a: Record<string, unknown>): Promise<unknown> {
    const { robot, clock } = this;
    const plans = this.sideList<unknown>("plans");
    const stages = this.sideList<unknown>("stages");
    const approve = "approve" in a ? a["approve"] : true;
    const started = clock.monotonic();

    const approvePlan = async (plan: HomePlan): Promise<unknown> => {
      plans.push(plain(plan));
      if (approve === "late") {
        // the operator answers once only half of the plan's estimated time is left
        const left = plan.operation_seconds_estimate / 2;
        await clock.sleep(Math.max(0.0, started + (a["timeout_s"] as number) - left - clock.monotonic()));
        return true;
      }
      if (approve === "raises") {
        throw new RuntimeError("the review failed");
      }
      if (typeof approve === "object" && approve !== null) {
        const review = approve as { review_ticks?: number; writes?: Record<string, unknown>; answer: unknown };
        for (let index = 0; index < (review.review_ticks ?? 0); index++) {
          await clock.sleep(this.periodS); // the operator reads the plan for some control periods
        }
        Object.assign(plan, structuredClone(review.writes ?? {})); // a caller that writes into the plan it was handed
        return review.answer;
      }
      return approve;
    };

    const onStage = a["on_stage"] as Record<string, Record<string, unknown>[]> | undefined;
    const options: NonNullable<Parameters<SteppedStandInSO101Robot["home"]>[0]> = {
      reportProgress:
        onStage === undefined
          ? (progress) => {
              stages.push(plain(progress));
            }
          : async (progress) => {
              stages.push(plain(progress));
              // what the script does during the report of a stage; its first operation runs at once, as in PEAR,
              // where the caller's handler runs in Home's thread
              for (const operation of onStage[String((progress as { stage?: unknown }).stage)] ?? []) {
                this.sideList<Record<string, unknown>>("stage_hooks").push(await this.hooked(operation));
              }
            },
    };
    if (approve !== "unasked") {
      options.approvePlan = approvePlan;
    }
    if ("timeout_s" in a) {
      options.timeoutS = a["timeout_s"] as number;
    }
    if ("cancellation" in a) {
      options.cancellation = this.cancellation(a);
    }
    return robot.home(options);
  }
}

/** What playing a session found: the steps played, and the first step that differs from PEAR's, if one does. */
export interface SessionVerdict {
  steps: number;
  ticks: number;
  difference: string | null;
}

/**
 * Plays `session` on pear.js's robot and compares every step's whole record with PEAR's; it stops at the first
 * step that differs, since what follows it differs for that.
 */
export async function playAndCompare(
  session: SessionRecord,
  comparison: Comparison,
  options: PlayerOptions = { kinematics: "recorded" },
): Promise<SessionVerdict> {
  const player = new SessionPlayer(session, options);
  let ticks = 0;
  let played = 0;
  let difference: string | null = null;

  try {
    for (const [index, expected] of session.steps.entries()) {
      const step = await player.play(expected);
      played += 1;
      ticks += step.ticks.length;
      const found = comparison.difference(step, expected, "");
      if (found !== null) {
        difference = `step ${index} (${expected.op}): ${found}`;
        break;
      }
    }
  } finally {
    // a session that was cut short still releases its robot
    if (player.robot.openLoop !== null) {
      player.clock.afterTick = null;
      player.clock.ticksLeft = RUNAWAY_TICKS;
      await player.robot.close().catch(() => undefined);
    }
  }

  return { steps: played, ticks, difference };
}

export type { RecordedError };
