// Not in PEAR: runs the scripted station sessions (station_session.json) on pear.js's own SO101Robot over a
// simulated SO-101 servo chain reachable over TCP (the chain is not part of this repository), stepped as the
// stepping rule of docs/progress/station-reference.md says, and returns a StationRunResult of the form the
// reference's runner writes of PEAR's Python robot on the same chain. compare_station.ts compares the two.
//
// The robot is the port's own: SO101Robot with its real driver (SO101Driver.fromConfig on the chain's line), its
// control loop, its motion layer, its gripper operation, its homing and its recovery. What is replaced is what the
// reference replaces in PEAR, as PEAR's tests do and as tests/station-robot/rig.ts does over the stand-in arm:
//   the clock           RecordingClock (PEAR's StandInClock): a number that only a sleep advances, and each sleep
//                       steps the attached control loop once
//   the loop's thread   SteppedSO101ControlLoop: PEAR's loop whose start() starts nothing
//   the camera          StandInCameras (PEAR's drawn stand-in camera); a result keeps of a frame only when it came
// PEAR's callers (its turn loop and its console) do not run: a step of the script is one call they make of the
// robot, under PEAR's name, and `call` below makes the port's.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { MotorCalibration } from "../../src/feetech/bus";
import { pythonErrorMessage, pythonErrorName, RuntimeError } from "../../src/python/errors";
import { SO101_DEFAULT_CONFIG, type SO101Config } from "../../src/so101/config";
import { SINGLE_ARM_POSE_FORMAT } from "../../src/so101/formats";
import { SO101Kinematics, type ArmDelta } from "../../src/so101/kinematics/kinematics";
import { SO101Robot } from "../../src/so101/robot";
import { OperatorPaused } from "../../src/station/exceptions";
import type { JointControlLoop } from "../../src/station/joint/control_loop";
import type { MotionResult, MotionStatus } from "../../src/station/motion/results";
import type { ControlLoopClass, StationConfig } from "../../src/station/robot";
import type { BriefStatus, DetailedStatus, HomePlan, Observation } from "../../src/station/schemas";
import { makeError } from "../station-robot/fixtures";
import { RecordingClock, StandInCameras, SteppedSO101ControlLoop, type DrawnFrame } from "../station-robot/rig";
import type { BridgeControl, BridgeState } from "./bridge_control";
import {
  STATION_RESULT_FORMAT,
  STATION_SESSION_FORMAT,
  type Json,
  type RaisedRecord,
  type Returned,
  type StationRunResult,
  type StationSession,
  type StationSessionDocument,
  type StationSessionResult,
  type StationStep,
  type StationStepRecord,
  type TickEvent,
  type WorldRecord,
} from "./station_result";
import { TcpTransport } from "./tcp_transport";

const FORMAT = SINGLE_ARM_POSE_FORMAT; // the SO-101's one action format
const SESSION_MARK = "session: "; // the label of the mark that starts a session's traffic, before its name
/** The sleeps a step may take before the runner stops it: the script's longest step takes some hundreds. */
const RUNAWAY_SLEEPS = 5000;
/** PEAR's loggers are named by their Python modules; the port's robot names the module's last word. */
const PEAR_LOGGERS: Record<string, string> = {
  robot: "pear.deploy.station.control.robot",
  control_loop: "pear.deploy.station.control.joint.control_loop",
};

/** The scripted sessions, and the SHA-256 of their file, which a result carries. */
export function loadStationSessions(
  path: string = fileURLToPath(new URL("./station_session.json", import.meta.url)),
): { document: StationSessionDocument; sha256: string } {
  const bytes = readFileSync(path);
  const document = JSON.parse(bytes.toString("utf8")) as StationSessionDocument;
  if (document.format !== STATION_SESSION_FORMAT) {
    throw new Error(`${path} is not a ${STATION_SESSION_FORMAT}`);
  }

  return { document, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** One answer of the kinematics' jointTarget (PEAR's SO101Kinematics.joint_target): what was asked, and the joint
 * target returned or the error raised, by its Python class and its whole message. */
export interface KinematicsAnswer {
  joints: number[];
  delta: number[];
  ok?: number[];
  error?: { type: string; message: string };
}

/** pear.js's kinematics, which keep what they were asked and, for the exact comparison, answer what PEAR's
 * answered at the same place of the same session. */
class RecordedKinematics extends SO101Kinematics {
  /** PEAR's answers still to give, in the order PEAR's kinematics were asked; null: pear.js's own answer. */
  answers: KinematicsAnswer[] | null = null;
  /** Told each question with the answer given. */
  onAsked: (asked: KinematicsAnswer, recorded: KinematicsAnswer | null) => void = () => undefined;

  override jointTarget(jointPositions: ArrayLike<number>, action: ArmDelta): number[] {
    const joints = Array.from(jointPositions);
    const delta = SO101Kinematics.ARM_QUANTITIES.map((name) => action.arm[name]);
    if (this.answers !== null) {
      const recorded = this.answers.shift();
      if (recorded === undefined) {
        throw new RuntimeError("PEAR's kinematics were not asked here");
      }
      this.onAsked({ joints, delta, ...(recorded.ok !== undefined ? { ok: [...recorded.ok] } : { error: recorded.error }) }, recorded);
      if (recorded.ok === undefined) {
        throw makeError(recorded.error ?? { type: "RuntimeError", message: "PEAR's answer holds neither a target nor an error" }, true);
      }
      return [...recorded.ok];
    }

    let target: number[];
    try {
      target = super.jointTarget(jointPositions, action);
    } catch (error) {
      this.onAsked({ joints, delta, error: { type: pythonErrorName(error), message: pythonErrorMessage(error) } }, null);
      throw error;
    }
    this.onAsked({ joints, delta, ok: [...target] }, null);

    return target;
  }
}

/** The SO-101 on its own driver, with the control loop that starts no thread: the clock's sleeps step it (as the
 * reference runs PEAR's SO101Robot with PEAR's SteppedSO101ControlLoop). */
class SteppedSO101Robot extends SO101Robot<DrawnFrame> {
  static override readonly CONTROL_LOOP_CLASS: ControlLoopClass = SteppedSO101ControlLoop;
  static override readonly KINEMATICS_CLASS = RecordedKinematics;

  /** What the session's kinematics are given when the planner opens. */
  rigKinematics: (kinematics: RecordedKinematics) => void = () => undefined;

  override openPlanner(): void {
    super.openPlanner();
    this.rigKinematics(this.kinematics as RecordedKinematics);
  }

  /** The open session's control loop, or null while the robot is closed. */
  get openLoop(): JointControlLoop | null {
    return this._controlLoop;
  }
}

/** Returns `value` in JSON's values, as the reference's runner writes PEAR's: no value as null, a list or an
 * object copied with its items so, a number that is not finite as the word that names it. A zero keeps its sign. */
export function jsonOf(value: unknown): Json {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity";
  }
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(jsonOf);
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>, jsonOf);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonOf(item)]));
  }
  throw new TypeError(`A result holds a ${typeof value}, which has no JSON value`);
}

/** Returns a result as JSON text in which a negative zero stays one: JSON.stringify writes it as 0, and the
 * comparison is of every bit. Python writes it so too. */
export function stationJson(value: unknown): string {
  if (typeof value === "number") return Object.is(value, -0) ? "-0.0" : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stationJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const items = Object.entries(value).filter(([, item]) => item !== undefined);
    return `{${items.map(([key, item]) => `${JSON.stringify(key)}:${stationJson(item)}`).join(",")}}`;
  }

  return JSON.stringify(value ?? null);
}

/** What an exception is to a result: its Python class's name, its message and, if it carries them, its details. */
function raisedOf(error: unknown): RaisedRecord {
  const record: RaisedRecord = { type: pythonErrorName(error), message: pythonErrorMessage(error) };
  const details = (error as { details?: unknown } | null)?.details;
  if (details !== undefined && details !== null) record.details = jsonOf(details);

  return record;
}

function labelOf(step: StationStep): string {
  return `${step.id} ${step.op}`;
}

export interface StationRunOptions {
  /** The chain's serial line. */
  host: string;
  port: number;
  /** The chain's controls. */
  control: BridgeControl;
  /** The script; by default the committed station_session.json. */
  sessions?: { document: StationSessionDocument; sha256: string };
  /** The names of the sessions to run; by default all. */
  only?: readonly string[];
  /** For the exact comparison: PEAR's kinematics' answers of each session, by the session's name, in the order
   * they were given. A session without an entry takes pear.js's own kinematics. */
  kinematics?: Readonly<Record<string, readonly KinematicsAnswer[]>>;
}

/** pear.js's robot running the sessions of the script. */
export class StationRunner {
  readonly document: StationSessionDocument;
  readonly clock = new RecordingClock();
  readonly periodS: number;
  /** What the kinematics were asked in each session, with the answers given. */
  readonly asked: Record<string, KinematicsAnswer[]> = {};
  /** Where the kinematics were asked something else than PEAR's were at the same place: the session, the number of
   * the question, and what differs. */
  readonly askedOtherwise: string[] = [];

  private readonly control: BridgeControl;
  private readonly config: StationConfig<SO101Config>;
  private readonly sha256: string;

  // what a session holds between its steps
  private sessionName = "";
  private robot: SteppedSO101Robot | null = null;
  private transport: TcpTransport | null = null;
  private calibration: Record<string, MotorCalibration> | null = null;
  private observation: Observation<DrawnFrame> | null = null; // the last one: the reference of what follows
  private feedback: string | null = null; // what the next turn tells the model of the last result
  private cancellation = { aborted: false }; // the operator's pause of the running operation
  private lastStatus: BriefStatus | DetailedStatus | null = null; // what the last status step returned
  private lastError: unknown = null; // what the last step that raised did raise
  // of the running step
  private stepTicks = 0;
  private events: TickEvent[] = [];
  private phases: [name: string, count: number][] = [];
  private log: [level: string, logger: string, message: string][] = [];

  constructor(private readonly options: StationRunOptions) {
    const sessions = options.sessions ?? loadStationSessions();
    this.document = sessions.document;
    this.sha256 = sessions.sha256;
    this.control = options.control;

    // the station's settings of the session file, with what is a machine's own: the line's name (the settings'
    // port), the calibration (the chain serves it) and the camera's device (the camera is a stand-in)
    const { control, robot } = this.document.station;
    this.config = {
      control,
      robot: {
        ...robot,
        hardware: {
          port: `${options.host}:${options.port}`,
          calibration_id: SO101_DEFAULT_CONFIG.hardware?.calibration_id ?? "",
          calibration_dir: SO101_DEFAULT_CONFIG.hardware?.calibration_dir ?? "",
          ...robot.hardware,
        },
        camera: { ...(SO101_DEFAULT_CONFIG.camera as NonNullable<SO101Config["camera"]>), path: "stand-in" },
      } as SO101Config,
    };
    this.periodS = this.makeRobot(null).controlPeriodS; // opens nothing: the settings are checked

    this.clock.afterTick = async () => {
      await this.afterTick();
      return null;
    };
  }

  /** Runs the sessions and returns the run's result. */
  async run(): Promise<StationRunResult> {
    const started = performance.now();
    const startedUnixS = Date.now() / 1000;
    const only = [...(this.options.only ?? [])];
    const names = this.document.sessions.map((session) => session.name);
    const unknown = only.filter((name) => !names.includes(name));
    if (unknown.length > 0) throw new Error(`No session is named ${JSON.stringify(unknown)}`);

    const state = await this.control.state();
    this.checkBridge(state);
    const calibrationFile = await this.control.calibrationFile();
    this.calibration = await this.control.calibration();

    const sessions: StationSessionResult[] = [];
    for (const session of this.document.sessions) {
      if (only.length === 0 || only.includes(session.name)) sessions.push(await this.runSession(session));
    }

    return {
      format: STATION_RESULT_FORMAT,
      side: "pear.js",
      clock: "stepped",
      session_sha256: this.sha256,
      station: this.document.station,
      bridge: {
        clock: state.clock,
        steps_per_packet: state.steps_per_packet ?? null,
        steps_per_position_read: state.steps_per_position_read ?? null,
        timestep_s: state.timestep_s,
      },
      calibration: calibrationFile,
      sessions,
      // what belongs to this run alone and is never compared
      run: {
        implementation: { node: process.version, line: "TCP to the chain's line" },
        kinematics: Object.fromEntries(
          sessions.map((session) => [session.name, this.options.kinematics?.[session.name] === undefined ? "own" : "recorded"]),
        ),
        asked_otherwise: this.askedOtherwise,
        only,
        started_unix_s: Math.round(startedUnixS * 1000) / 1000,
        wall_s: Math.round(performance.now() - started) / 1000,
      },
    };
  }

  /** Refuses a chain whose clock is not a stepped station's: the arm must age one control period at each read of
   * the positions, and at no other time. */
  private checkBridge(state: BridgeState): void {
    const steps = state.steps_per_position_read;
    if (state.clock !== "packets" || state.steps_per_packet !== 0 || steps === undefined || steps === null || steps === 0) {
      throw new Error("A stepped station needs the chain on packets, 0 steps a packet and N steps a position read");
    }
    if (Math.abs(steps * state.timestep_s - this.periodS) > 1e-12) {
      throw new Error(
        `The arm must age one control period (${this.periodS} s) at a position read, not ${steps} steps of ${state.timestep_s} s`,
      );
    }
  }

  /** Returns a robot of the station on ``transport``; without one it can be asked its settings and not opened. */
  private makeRobot(transport: TcpTransport | null): SteppedSO101Robot {
    const robot = new SteppedSO101Robot(this.config, {
      cameras: new StandInCameras(SO101Robot.CAMERAS, this.clock),
      clock: this.clock,
      // PEAR's warnings and errors, as the reference keeps them: the level, the logger, the message
      log: (logger, level, message) => {
        if (level !== "info") this.log.push([level.toUpperCase(), PEAR_LOGGERS[logger] ?? logger, message]);
      },
      line:
        transport === null
          ? null
          : {
              transport,
              calibration: this.calibration,
              onWarning: (message) => this.log.push(["WARNING", "so101.hardware", message]),
            },
      configOptions: { calibrationExists: () => true }, // the chain serves the arm's calibration
    });
    robot.rigKinematics = (kinematics) => {
      const name = this.sessionName;
      const recorded = this.options.kinematics?.[name];
      kinematics.answers = recorded === undefined ? null : recorded.map((answer) => ({ ...answer }));
      const asked = (this.asked[name] ??= []);
      kinematics.onAsked = (question, answer) => {
        asked.push(question);
        if (answer === null) return;
        const same = (ours: number[], theirs: number[]): boolean =>
          ours.length === theirs.length && ours.every((value, index) => Object.is(value, theirs[index]));
        if (!same(question.joints, answer.joints) || !same(question.delta, answer.delta)) {
          this.askedOtherwise.push(
            `${name}: question ${asked.length}: asked ${JSON.stringify([question.joints, question.delta])}, ` +
              `PEAR's were asked ${JSON.stringify([answer.joints, answer.delta])}`,
          );
        }
      };
    };

    return robot;
  }

  /** Runs one session's steps and returns what each did, each with the packets the chain saw meanwhile. */
  private async runSession(session: StationSession): Promise<StationSessionResult> {
    const started = performance.now();
    this.sessionName = session.name;
    this.robot = null;
    this.observation = null;
    this.feedback = null;
    this.cancellation = { aborted: false };
    this.lastStatus = null;
    this.lastError = null;

    const records: StationStepRecord[] = [];
    let note: string | null = null;
    try {
      for (const step of session.steps) records.push(await this.runStep(session, step));
      if (this.robot !== null && (this.robot as SteppedSO101Robot).sessionId !== null) {
        // a session of the script closes its robot; one that did not is closed here, which the result says
        note = "the runner closed the robot the session left open";
        try {
          await (this.robot as SteppedSO101Robot).close();
        } catch (error) {
          note += `: ${pythonErrorName(error)}: ${pythonErrorMessage(error)}`;
        }
        this.detach();
      }
    } finally {
      // the line is the runner's: a robot that closed has closed it, a start-up that failed may have left it open
      if (this.transport !== null && !this.transport.isClosed) await this.transport.close();
      this.transport = null;
      this.detach();
    }

    // every mark still waiting starts its segment now: the session's steps and the segments are one to one
    const traffic = await this.control.traffic();
    const labels = traffic.map((segment) => segment.label);
    const expected = ["", SESSION_MARK + session.name, ...session.steps.slice(1).map(labelOf)];
    if (JSON.stringify(labels) !== JSON.stringify(expected)) {
      throw new Error(
        `${session.name}: the chain's segments ${JSON.stringify(labels.slice(0, 6))}... are not the session's steps ` +
          `${JSON.stringify(expected.slice(0, 6))}...`,
      );
    }
    if (traffic[0].packets.length > 0 || traffic[1].packets.length > 0) {
      throw new Error(`${session.name}: packets crossed the line before the session's first step`);
    }
    records.slice(1).forEach((record, index) => {
      record.packets = traffic[index + 2].packets;
    });

    const line = (await this.control.state()).line;
    const result: StationSessionResult = {
      name: session.name,
      steps: records,
      line: {
        instructions: line.instructions,
        unanswered: line.unanswered,
        corrupt_packets: line.corrupt_packets ?? 0,
        dropped_bytes: line.dropped_bytes ?? 0,
        errors: line.errors ?? [],
      },
      wall_s: Math.round(performance.now() - started) / 1000,
    };
    if (note !== null) result.note = note;

    return result;
  }

  /** Runs one step and returns its record. */
  private async runStep(session: StationSession, step: StationStep): Promise<StationStepRecord> {
    const record: StationStepRecord = { id: step.id, op: step.op };
    if (step.turn !== undefined) record.turn = step.turn; // the script's own words on the step, copied
    if (step.about !== undefined) record.about = step.about;
    const { clock } = this;

    if (step.op === "reset") {
      await this.control.reset();
      await this.control.mark(SESSION_MARK + session.name);
      // every session starts at the clock's first reading, whatever ran before it
      clock.controlLoop = null;
      clock.now = RecordingClock.START_S;
      clock.take();
      this.log = [];
      return record;
    }

    await this.control.mark(labelOf(step));
    clock.take();
    clock.ticksLeft = RUNAWAY_SLEEPS;
    const nowBefore = clock.monotonic();
    this.stepTicks = 0;
    this.phases = [];
    this.events = [...(step.at_tick ?? [])];
    const started = performance.now();

    try {
      record.returned = (await this.call(step)) as Returned;
    } catch (error) {
      // every refusal is a result
      record.raised = raisedOf(error);
      this.lastError = error;
    } finally {
      this.events = [];
    }

    record.wall_ms = Math.round((performance.now() - started) * 1000) / 1000; // never compared
    record.clock_s = [nowBefore, clock.monotonic()];
    record.ticks = this.stepTicks;
    record.sleeps = clock.take().length;
    record.phases = this.phases;
    // the robot's status with its control snapshot, as PEAR's page reads it; OFF while the robot is closed
    const robot = this.robot;
    record.status = robot === null ? null : jsonOf(robot.status(true));
    const loop = robot === null ? null : robot.openLoop; // read only: what the arm heads for
    record.requested = loop === null ? null : (jsonOf(loop.requestedPosition()) as number[]);
    const world = await this.control.state();
    const where: WorldRecord = { time_s: world.time_s, joints_rad: world.joints_rad, gripper_opening: world.gripper_opening };
    if (session.objects === true) {
      // where the fixed fingertip, the middle between the fingers and the objects truly are
      where.fingertip_m = world.fingertip_m;
      where.grasp_m = world.grasp_m;
      where.objects = world.objects;
    }
    record.world = where;
    record.log = this.log;
    this.log = [];

    return record;
  }

  // ---- the steps ----

  /** Does what the step asks and returns what it returned, in JSON's values. */
  private async call(step: StationStep): Promise<unknown> {
    const { clock, control } = this;
    switch (step.op) {
      case "inject":
        await control.inject(step.faults ?? {});
        return null;
      case "place":
        await control.place(step.object ?? "", step.position_m ?? []);
        return null;
      case "new_cancellation": // as the console makes one for every operation it launches
        this.cancellation = { aborted: false };
        return null;
      case "idle":
        await this.idle(step.ticks ?? 0);
        return null;
      case "parse": // an answer that is no action: the format's own parser refuses it
        return jsonOf(FORMAT.parseAction(step.answer ?? ""));
      case "open": {
        // as the console makes its robot and its enable command opens it; the cameras are the drawn ones
        this.transport = await TcpTransport.connect(this.options.host, this.options.port);
        this.robot = this.makeRobot(this.transport);
        await this.robot.open();
        clock.controlLoop = this.robot.controlLoop; // each sleep steps it from here on
        return null;
      }
      default:
    }

    const robot = this.robot;
    if (robot === null) throw new RuntimeError("The session has made no robot yet");
    switch (step.op) {
      case "close":
        try {
          await robot.close();
        } finally {
          if (robot.sessionId === null) this.detach();
        }
        return null;
      case "wait_stationary":
        return jsonOf(
          await robot.waitStationary(step.observation === true ? this.observation : null, { cancellation: this.cancellation }),
        );
      case "observe": {
        const observation = await robot.observe();
        this.observation = observation;
        // without its two random ids and its frames; of a frame, only when it arrived: its number is the camera's
        // own count, which a drawn camera makes up
        return {
          captured_monotonic_s: observation.captured_monotonic_s,
          joint_positions: jsonOf(observation.joint_positions),
          images: Object.keys(observation.images).sort(),
          camera_timestamps: Object.fromEntries(
            Object.entries(observation.camera_timestamps).map(([role, stamps]) => [
              role,
              { received_monotonic_s: stamps["received_monotonic_s"] as number },
            ]),
          ),
          control_snapshot: jsonOf(observation.control_snapshot),
        };
      }
      case "model_state": {
        const state = robot.modelState(this.held().joint_positions, FORMAT.name);
        // the turn's text as PEAR's message builder writes it: the format's, with the report of the last result
        return { state: jsonOf(state), text: FORMAT.turnText(state, this.feedback) };
      }
      case "hold": {
        // what PEAR's turn loop does while the model works: every control period it gives way to the operator's
        // pause and asks whether the arm still holds the observed pose, settled; the answer arrives after the
        // script's ticks and is taken after the same two checks
        const holding: boolean[] = [];
        for (let index = 0; index < (step.ticks ?? 0); index++) {
          OperatorPaused.checkCancelled(this.cancellation);
          holding.push(robot.isHolding(this.held()));
          await clock.sleep(this.periodS);
        }
        OperatorPaused.checkCancelled(this.cancellation);
        holding.push(robot.isHolding(this.held()));
        return { holding };
      }
      case "execute": {
        let action: unknown = step.action; // with its type: an action of the robot outside the model's format
        if (step.answer !== undefined) action = FORMAT.parseAction(step.answer); // a model's final answer
        const progress: string[] = [];
        const result = await robot.execute(action, {
          referenceObservation: (step.observation ?? true) ? this.observation : null,
          cancellation: this.cancellation,
          reportProgress: (phase) => {
            progress.push(phase);
          },
        });
        return { ...this.recorded(result, true), progress, diagnostics: jsonOf(robot.lastErrorDiagnostics) };
      }
      case "failure_result": {
        const result = robot.failureResult(this.errorOf(step), {
          formatName: FORMAT.name,
          status: (step.status ?? "failed") as MotionStatus,
          // measured at the status the script read before
          ...(step.snapshot === "status" ? { snapshot: this.lastStatus } : {}),
        });
        return this.recorded(result, step.dispatched ?? true);
      }
      case "status":
        this.lastStatus = step.with_snapshot === true ? robot.status(true) : robot.status();
        return jsonOf(this.lastStatus);
      case "check_fault":
        robot.checkFault();
        return null;
      case "stop":
        await robot.stop();
        return null;
      case "pause":
        await this.pause();
        return null;
      case "wait_settled":
        return jsonOf(await robot.waitSettled(step.timeout_s as number));
      case "recover":
        return jsonOf(await robot.recover({ cancellation: this.cancellation }));
      case "home": {
        const progress: Json[] = [];
        const reviewed: Json[] = [];
        const report = await robot.home({
          cancellation: this.cancellation,
          reportProgress: (stage) => {
            progress.push(jsonOf(stage));
          },
          // the operator's review: the plan is kept, the script's ticks pass, the script's answer is given
          approvePlan: async (plan: HomePlan) => {
            reviewed.push(jsonOf(plan));
            await this.idle(step.review_ticks ?? 0);
            return step.approve ?? true;
          },
        });
        return { report: jsonOf(report), progress, reviewed };
      }
      default:
        throw new Error(`unknown step '${step.op}'`);
    }
  }

  /** The last observation, which the steps of a turn refer to. */
  private held(): Observation<DrawnFrame> {
    if (this.observation === null) throw new RuntimeError("The session has observed nothing yet");
    return this.observation;
  }

  /** Keeps the report of ``result`` for the next turn, as PEAR's turn loop does, and returns the result as PEAR
   * records it with the report. */
  private recorded(result: MotionResult, isDispatched: boolean): { result: Json; feedback: string } {
    this.feedback = FORMAT.resultFeedback(result, { isDispatched });

    return { result: jsonOf(result.toRecord()), feedback: this.feedback };
  }

  /** Returns the error a failure_result step names: one PEAR's turn loop or console makes, or the one the last
   * step that raised did raise. */
  private errorOf(step: StationStep): unknown {
    const description = step.error;
    if (description === undefined) throw new Error(`step ${step.id} names no error`);
    if ("from" in description) {
      if (this.lastError === null) throw new RuntimeError("No step of the session raised before this one");
      return this.lastError;
    }

    return makeError({ type: description.type, message: description.message });
  }

  /** Lets ``ticks`` control periods pass while nobody asks anything of the robot. */
  private async idle(ticks: number): Promise<void> {
    for (let index = 0; index < ticks; index++) await this.clock.sleep(this.periodS);
  }

  /** What PEAR's console does at the operator's pause: it sets the running operation's cancellation and stops the
   * robot. */
  private async pause(): Promise<void> {
    this.cancellation.aborted = true;
    if (this.robot !== null) await this.robot.stop();
  }

  /** Stops the clock from stepping a control loop that is closed. */
  private detach(): void {
    this.clock.controlLoop = null;
  }

  // ---- between two steps of the loop ----

  /** Counts a step of the loop, notes the loop's state after it and does what the script asks for then: where
   * another thread of a station would act. A sleep without a loop is no tick. */
  private async afterTick(): Promise<void> {
    const loop = this.clock.controlLoop;
    if (loop === null) return;

    this.stepTicks += 1;
    const name = this.phaseName(loop);
    const last = this.phases[this.phases.length - 1];
    if (last !== undefined && last[0] === name) last[1] += 1;
    else this.phases.push([name, 1]);
    for (const event of this.events) {
      if (event.tick === this.stepTicks) await this.fire(event);
    }
  }

  /** Returns the control loop's state in a few words, from its own snapshot. */
  private phaseName(loop: JointControlLoop): string {
    const snapshot = loop.snapshot();
    const status = snapshot.status;
    if (status === "HOLD") return snapshot.arrival.settled ? "HOLD" : "HOLD unsettled";
    if (status === "FAULT") return snapshot.recovery === null ? "FAULT" : `FAULT: ${snapshot.recovery.phase}`;
    if ((status === "RUNNING" || status === "STOPPING") && snapshot.motion !== null && snapshot.motion.settling) {
      return `${status} settling`;
    }
    return status;
  }

  /** Does what the script asks for after a tick of a step: the operator's pause, or a control of the chain. */
  private async fire(event: TickEvent): Promise<void> {
    if (event.do === "pause") await this.pause();
    else if (event.do === "inject") await this.control.inject(event.faults ?? {});
    else throw new Error(`unknown event '${String(event.do)}'`);
  }
}

/** Runs the scripted station sessions on pear.js's robot over the chain and returns the run's result. */
export function runStationSessions(options: StationRunOptions): Promise<StationRunResult> {
  return new StationRunner(options).run();
}
