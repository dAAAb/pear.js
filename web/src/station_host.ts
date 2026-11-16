// The station as the page's Worker runs it: PEAR's robot (the SO-101 with its 50 Hz control loop and its driver)
// on a simulated arm that this file makes itself. It is never handed a port: there is no way from here to a real
// serial line. station_worker.ts gives it the Worker's messages; a test may give it its own.
//
// A request is started when it arrives and answered when it is done, so that a Stop is taken while an action is
// under way: nothing here waits for an action before it takes the next message.
//
// The robot's wrist camera is the library's own (CameraFeed over WristCamera); its frame reader is fed by the
// window, which has the camera: a Worker cannot open one.

import { pythonErrorMessage, pythonErrorName, isValueError, RuntimeError } from "../../src/python/errors";
import { SO101_DEFAULT_CONFIG, type SO101Config } from "../../src/so101/config";
import { SINGLE_ARM_POSE_FORMAT } from "../../src/so101/formats";
import { WristCamera, type WristFrameReader } from "../../src/so101/hardware/cameras";
import { followerMotors, simulatedArm } from "../../src/so101/hardware/index";
import { SO101ControlLoop } from "../../src/so101/joint/control_loop";
import { ARM } from "../../src/so101/layout";
import { SO101Robot } from "../../src/so101/robot";
import { protocol, type SimServoChain } from "../../src/feetech/index";
import { CameraFeed } from "../../src/station/cameras";
import type { MonotonicClock } from "../../src/station/joint/clock";
import { DEFAULT_CONTROL_SETTINGS } from "../../src/station/joint/config";
import { realTimeClock } from "../../src/station/joint/deadline_clock";
import { MotionStatus, type MotionResult } from "../../src/station/motion/results";
import type { ControlLoopClass, StationConfig } from "../../src/station/robot";
import type { DetailedStatus, HomePlan, Observation } from "../../src/station/schemas";
import { SIM_CALIBRATION } from "./sim_port";
import {
  type ActionReport,
  type CameraNumbers,
  type CameraTelling,
  type ClockNumbers,
  type DisableResult,
  type EnableResult,
  type FromStation,
  type HomeResult,
  type MotorSteps,
  type PeriodsSince,
  STATUS_PERIOD_MS,
  type StationEvent,
  type StationRequest,
  type StationStatus,
  type StepPeriods,
  type TimingCheck,
  type TimingFailure,
  type ToStation,
} from "./station_protocol";

/** How fast a simulated servo goes to its goal, steps a second: an STS3215 without load turns at about 45 turns
 * a minute. It is several times the arm's fastest joint (1 rad/s is 652 steps a second), so the simulated arm
 * follows the loop's motion within its tracking limits, and a motion takes the time the loop gives it. */
export const SIM_SPEED_STEPS_S = 3072;

/** The timing self-check before the torque is switched on: so many control periods of one read and a wait, and
 * the limits beyond which enabling is refused. */
export const TIMING_PERIODS = 150;
export const TIMING_LIMITS = { periodMs: 40, periodsOver25: 3, meanMs: 20.5, readMs: 15 } as const satisfies TimingLimits;

/** The limits of the timing self-check: the longest period and the mean period, ms; how many periods may take
 * over 25 ms; the longest read, ms. */
export interface TimingLimits {
  readonly periodMs: number;
  readonly periodsOver25: number;
  readonly meanMs: number;
  readonly readMs: number;
}

/** What the timing self-check measured: the mean and the longest period, ms; how many periods took over 25 ms;
 * the longest read, ms; how many reads were not answered by every servo. */
export interface TimingNumbers {
  readonly meanMs: number;
  readonly maxMs: number;
  readonly over25: number;
  readonly maxReadMs: number;
  readonly unanswered: number;
}

/** The verdict of the timing self-check: every reason to refuse enabling, in a fixed order; none when it passed.
 * A number at its limit passes; only a number over it fails. A hidden page fails whatever the numbers are. */
export function timingVerdict(numbers: TimingNumbers, limits: TimingLimits, isHidden: boolean): TimingFailure[] {
  const reasons: TimingFailure[] = [];
  if (numbers.maxMs > limits.periodMs) reasons.push({ code: "period", value: numbers.maxMs, limit: limits.periodMs });
  if (numbers.over25 > limits.periodsOver25) reasons.push({ code: "over25", value: numbers.over25, limit: limits.periodsOver25 });
  if (numbers.meanMs > limits.meanMs) reasons.push({ code: "mean", value: numbers.meanMs, limit: limits.meanMs });
  if (numbers.maxReadMs > limits.readMs) reasons.push({ code: "read", value: numbers.maxReadMs, limit: limits.readMs });
  if (numbers.unanswered > 0) reasons.push({ code: "unanswered", value: numbers.unanswered, limit: 0 });
  if (isHidden) reasons.push({ code: "hidden", value: null, limit: null });

  return reasons;
}

/** Returns a reason of the verdict as the Worker's error says it (English; the page has its own sentences). */
export function timingFailureText(reason: TimingFailure): string {
  switch (reason.code) {
    case "period":
      return `a period took ${reason.value} ms (limit ${reason.limit} ms)`;
    case "over25":
      return `${reason.value} periods took over 25 ms (limit ${reason.limit})`;
    case "mean":
      return `the mean period was ${reason.value} ms (limit ${reason.limit} ms)`;
    case "read":
      return `a read took ${reason.value} ms (limit ${reason.limit} ms)`;
    case "unanswered":
      return `${reason.value} reads were not answered by every servo`;
    case "hidden":
      return "the page is not visible";
  }
}

/** The register every period of the self-check reads from all servos: Present_Position, its address and length. */
const PRESENT_POSITION = [56, 2] as const;

/** Returns the SYNC READ packet that asks the servos `ids` for `length` bytes at `address`. */
export function syncReadPacket(ids: readonly number[], address: number, length: number): Uint8Array {
  const body = [protocol.BROADCAST_ID, ids.length + 4, protocol.INST_SYNC_READ, address, length, ...ids];
  const sum = body.reduce((total, byte) => total + byte, 0);

  return Uint8Array.from([0xff, 0xff, ...body, ~sum & 0xff]);
}

/** How long a Home plan waits for the person's answer before it counts as refused, ms: an approval that never
 * settles would keep the robot taken for good. */
export const APPROVAL_LIMIT_MS = 120_000;

/** The station's settings: PEAR's defaults, with the names a machine gives (the line, the camera) filled in. */
export const STATION_CONFIG: StationConfig<SO101Config> = {
  control: DEFAULT_CONTROL_SETTINGS,
  robot: {
    ...SO101_DEFAULT_CONFIG,
    hardware: { ...SO101_DEFAULT_CONFIG.hardware, port: "simulated" },
    camera: { ...SO101_DEFAULT_CONFIG.camera, path: "none" },
  } as SO101Config,
};

/** When each control period began, by the page's clock, ms: the station's loop tells it here. */
const stepStamps: number[] = [];
let stepCount = 0;

/** The control periods since the station was enabled: how many, their sum and their longest, ms, and how many
 * took over 25 ms and over 40 ms. `lastStamp` is when the last step began; null before the first. */
const since = { count: 0, sumMs: 0, maxMs: 0, over25: 0, over40: 0 };
let lastStamp: number | null = null;

/** Forgets the steps and the periods counted: the station is enabled anew. */
function resetSteps(): void {
  stepStamps.length = 0;
  stepCount = 0;
  since.count = 0;
  since.sumMs = 0;
  since.maxMs = 0;
  since.over25 = 0;
  since.over40 = 0;
  lastStamp = null;
}

/** Counts a control step that begins at `now`, ms. */
function noteStep(now: number): void {
  if (lastStamp !== null) {
    const period = now - lastStamp;
    since.count += 1;
    since.sumMs += period;
    since.maxMs = Math.max(since.maxMs, period);
    if (period > 25) since.over25 += 1;
    if (period > 40) since.over40 += 1;
  }
  lastStamp = now;
  stepStamps.push(now);
  stepCount += 1;
}

/** Returns the control periods since the station was enabled. */
function periodsSince(): PeriodsSince {
  const round = (value: number): number => Math.round(value * 100) / 100;

  return {
    count: since.count,
    meanMs: since.count === 0 ? 0 : round(since.sumMs / since.count),
    maxMs: round(since.maxMs),
    over25: since.over25,
    over40: since.over40,
  };
}

/** Returns what the Worker's clock has done since the station was enabled, the times rounded to 0.001 ms. */
function clockNumbers(): ClockNumbers {
  const stats = realTimeClock().stats();
  const round = (value: number): number => Math.round(value * 1000) / 1000;

  return {
    sleeps: stats.sleeps,
    timers: stats.timers,
    yields: stats.yields,
    spinMs: round(stats.spinMs),
    lateMeanMs: round(stats.lateMeanMs),
    lateMaxMs: round(stats.lateMaxMs),
    timerLateMaxMs: Number.isFinite(stats.timerLateMaxMs) ? round(stats.timerLateMaxMs) : null,
    marginMs: round(stats.marginMs),
  };
}

/** The SO-101's control loop, which notes when each of its periods begins. */
class StampedControlLoop extends SO101ControlLoop {
  override async step(): Promise<void> {
    noteStep(performance.now());
    if (stepStamps.length > 200) stepStamps.splice(0, stepStamps.length - 100);

    return super.step();
  }
}

/** The SO-101 on the loop above; a frame of its wrist camera is a JPEG's bytes. */
class StationRobot extends SO101Robot<Uint8Array> {
  static override readonly CONTROL_LOOP_CLASS: ControlLoopClass = StampedControlLoop;
}

/**
 * The wrist camera's frames as the window sends them: the frame reader of the library's WristCamera, which is to
 * it what lerobot's camera object is to PEAR's. A frame is stamped when it arrives here, on the clock the wrist
 * camera reads; the window's clock is another one, and its times are never used for a frame's age.
 */
export class WindowFrames implements WristFrameReader<Uint8Array> {
  /** Whether the window says its camera runs. */
  isReading = false;
  /** The last JPEG that arrived; null before the first. */
  latestFrame: Uint8Array | null = null;
  /** When it arrived, s; null before the first. */
  latestTimestamp: number | null = null;
  /** The camera is the window's: there is nothing here to connect or to release. */
  readonly isConnected = true;
  /** How many frames arrived. */
  private count = 0;
  /** When the frames of about the last second arrived, s. */
  private arrivals: number[] = [];
  /** When the last frame arrived since the window last said that its camera runs, s; null before one. */
  private lastWhileRunning: number | null = null;
  /** The longest time between two such frames, s; null before the second. */
  private maxGap: number | null = null;
  /** How many of those times were longer than a frame stays fresh. */
  private gapsOver = 0;

  constructor(private readonly clock: Pick<MonotonicClock, "monotonic"> = realTimeClock()) {}

  /** Takes what the window tells of its camera: whether it runs, or one frame. */
  take(telling: CameraTelling): void {
    if (telling.kind === "camera") {
      this.isReading = telling.isRunning;
      this.lastWhileRunning = null; // the time a camera stood still is not the time between two of its frames

      return;
    }
    const now = this.clock.monotonic();
    this.latestFrame = new Uint8Array(telling.jpeg);
    this.latestTimestamp = now;
    this.count += 1;
    if (this.isReading) {
      if (this.lastWhileRunning !== null) {
        const gap = now - this.lastWhileRunning;
        if (this.maxGap === null || gap > this.maxGap) this.maxGap = gap;
        if (gap > WristCamera.MAX_AGE_S) this.gapsOver += 1;
      }
      this.lastWhileRunning = now;
    }
    this.arrivals.push(now);
    if (this.arrivals.length > 200) this.arrivals.splice(0, this.arrivals.length - 100);
  }

  /** What the status tells of the camera: no frame is in it. */
  numbers(): CameraNumbers {
    const now = this.clock.monotonic();

    return {
      isRunning: this.isReading,
      perSecond: this.arrivals.filter((arrival) => arrival > now - 1).length,
      frames: this.count,
      ageMs: this.latestTimestamp === null ? null : Math.round((now - this.latestTimestamp) * 1000),
      maxGapMs: this.maxGap === null ? null : Math.round(this.maxGap * 10000) / 10,
      gapsOver200: this.gapsOver,
    };
  }

  disconnect(): void {}
}

/** Returns a random UUID as Python's `str(uuid4())` writes one; unlike `crypto.randomUUID` it is there on a page
 * that is not a secure context too. */
export function uuid4(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Returns the periods between the control steps that began in the second before `now`. */
export function stepPeriods(stamps: readonly number[], now: number): StepPeriods {
  const recent = stamps.filter((stamp) => stamp >= now - 1000);
  const periods = recent.slice(1).map((stamp, index) => stamp - (recent[index] as number));
  if (periods.length === 0) return { count: 0, meanMs: 0, maxMs: 0, over25: 0 };
  const round = (value: number): number => Math.round(value * 100) / 100;

  return {
    count: periods.length,
    meanMs: round(periods.reduce((sum, period) => sum + period, 0) / periods.length),
    maxMs: round(Math.max(...periods)),
    over25: periods.filter((period) => period > 25).length,
  };
}

/** The station of one Worker. `post` sends a message to the window. */
export class StationHost {
  private robot: StationRobot | null = null;
  private chain: SimServoChain | null = null;
  private action: { type: "jog" | "home"; requestId: number } | null = null;
  private approval: ((isApproved: boolean) => void) | null = null;
  private feedback: string | null = null;
  private isHidden = false;
  private isEnabling = false;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  /** The frames of the window's camera: what the wrist camera of the robot that is open reads. A station that
   * is enabled anew has been told nothing of the camera yet. */
  private frames = new WindowFrames();

  constructor(private readonly post: (message: FromStation) => void) {}

  /** Starts the request of `message`; its reply is posted when it is done. What the window tells of its camera
   * is taken at once and never answered. */
  handle(message: ToStation): void {
    if ("kind" in message) {
      this.frames.take(message);

      return;
    }
    void this.run(message.id, message.request).then(
      (result) => this.post({ kind: "reply", id: message.id, isOk: true, result }),
      (error: unknown) =>
        this.post({
          kind: "reply",
          id: message.id,
          isOk: false,
          error: { name: pythonErrorName(error), message: pythonErrorMessage(error) },
        }),
    );
  }

  private run(id: number, request: StationRequest): Promise<unknown> {
    switch (request.type) {
      case "enable":
        return this.enable(request.positions, request.isHidden);
      case "stop":
        return this.stop();
      case "disable":
        return this.disable();
      case "jog":
        return this.jog(id, request.action);
      case "home":
        return this.home(id);
      case "approve":
        return this.approve(request.isApproved);
      case "visibility":
        return this.setHidden(request.isHidden);
    }
  }

  private event(event: StationEvent): void {
    this.post({ kind: "event", event });
  }

  private log(level: "info" | "warning" | "error", logger: string, message: string, error?: unknown): void {
    if (level === "info") return;
    const cause = error === undefined || error === null ? "" : ` (${pythonErrorName(error)}: ${pythonErrorMessage(error)})`;
    this.event({ type: "log", level, logger, message: `${message}${cause}` });
  }

  /** The robot that is open; as the robot itself says when there is none. */
  private get open(): StationRobot {
    if (this.robot === null) throw new RuntimeError("Open the station first");

    return this.robot;
  }

  // ---------------------------------------------------------------- enabling and disabling

  private async enable(positions: MotorSteps, isHidden: boolean): Promise<EnableResult> {
    if (this.robot !== null || this.isEnabling) throw new RuntimeError("Station already open");
    this.isHidden = isHidden;
    this.isEnabling = true;
    try {
      return await this.enableOn(positions);
    } finally {
      this.isEnabling = false;
    }
  }

  private async enableOn(positions: MotorSteps): Promise<EnableResult> {
    const chain = simulatedArm(SIM_CALIBRATION, positions, { speed: SIM_SPEED_STEPS_S });
    const timing = await this.timingCheck(chain);
    this.event({ type: "timing", timing });
    if (timing.failures.length > 0) {
      throw new RuntimeError(`The timing self-check failed: ${timing.failures.join("; ")}`);
    }

    // the wrist camera on the frames the window sends: every observation holds the frame a turn would send, and
    // without a fresh one it fails as PEAR's does
    const frames = new WindowFrames();
    this.frames = frames;
    const robot = new StationRobot(STATION_CONFIG, {
      cameras: new CameraFeed(new WristCamera(STATION_CONFIG.robot, frames, { clock: realTimeClock() })),
      line: {
        transport: chain,
        calibration: SIM_CALIBRATION,
        onWarning: (message, error) => this.log("warning", "so101.hardware", message, error),
      },
      log: (logger, level, message, error) => this.log(level, logger, message, error),
      uuid4,
      configOptions: { calibrationExists: () => true }, // the simulated servos hold the arm's calibration
    });
    resetSteps();
    realTimeClock().resetStats(); // the clock's numbers are told since enabling, without the self-check's sleeps
    const began = performance.now();
    await robot.open();
    this.robot = robot;
    this.chain = chain;
    this.feedback = null;
    this.statusTimer = setInterval(() => this.tellStatus(), STATUS_PERIOD_MS);
    this.tellStatus();

    return { timing, openMs: Math.round(performance.now() - began) };
  }

  /** The timing self-check on the line before the torque is switched on, reads only: TIMING_PERIODS control
   * periods of one read of every servo's position and a wait for the period's end, on the clock the loop keeps
   * its periods with. Enabling is refused when the periods or the reads are too slow, or the page is hidden. */
  private async timingCheck(chain: SimServoChain): Promise<TimingCheck> {
    const clock = realTimeClock();
    const periodS = 1 / STATION_CONFIG.control.rate_hz;
    const ids = Object.values(followerMotors()).map(({ id }) => id);
    const packet = syncReadPacket(ids, PRESENT_POSITION[0], PRESENT_POSITION[1]);
    const answerLength = ids.length * (6 + PRESENT_POSITION[1]);
    const began: number[] = [];
    let maxReadMs = 0;
    let unanswered = 0;
    let due = clock.monotonic();
    for (let index = 0; index <= TIMING_PERIODS; index++) {
      const start = performance.now();
      began.push(start);
      await chain.write(packet);
      const answer = await chain.read(answerLength, 0);
      if (answer.length !== answerLength) unanswered += 1;
      maxReadMs = Math.max(maxReadMs, performance.now() - start);
      due += periodS;
      await clock.sleep(Math.max(due - clock.monotonic(), 0));
    }
    const periods = began.slice(1).map((start, index) => start - (began[index] as number));
    const round = (value: number): number => Math.round(value * 100) / 100;
    const meanMs = round(periods.reduce((sum, period) => sum + period, 0) / periods.length);
    const maxMs = round(Math.max(...periods));
    const over25 = periods.filter((period) => period > 25).length;
    const reasons = timingVerdict({ meanMs, maxMs, over25, maxReadMs: round(maxReadMs), unanswered }, TIMING_LIMITS, this.isHidden);

    return {
      periods: periods.length,
      meanMs,
      maxMs,
      over25,
      maxReadMs: round(maxReadMs),
      failures: reasons.map(timingFailureText),
      reasons,
    };
  }

  private async disable(): Promise<DisableResult> {
    const robot = this.open;
    this.approval?.(false);
    try {
      await robot.close();
    } catch (error) {
      // a close that arrives while an action is under way can reject and has closed the arm all the same
      if (robot.status().status !== "OFF") throw error;
    }
    const chain = this.chain as SimServoChain;
    chain.advance();
    const positions = Object.fromEntries(
      Object.entries(followerMotors()).map(([motor, { id }]) => [motor, Math.round(chain.servo(id).position)]),
    );
    if (this.statusTimer !== null) clearInterval(this.statusTimer);
    this.statusTimer = null;
    this.robot = null;
    this.chain = null;
    this.tellStatus();

    return { positions };
  }

  // ---------------------------------------------------------------- stopping

  private async stop(): Promise<null> {
    this.approval?.(false);
    await this.robot?.stop();

    return null;
  }

  private async setHidden(isHidden: boolean): Promise<null> {
    this.isHidden = isHidden;
    if (isHidden) await this.stop();
    this.tellStatus();

    return null;
  }

  // ---------------------------------------------------------------- actions

  /** Runs `body` as the one action under way. */
  private async asAction<Result>(type: "jog" | "home", requestId: number, body: (robot: StationRobot) => Promise<Result>): Promise<Result> {
    const robot = this.open;
    if (this.isHidden) throw new RuntimeError("The page is hidden: no action is started");
    if (this.action !== null) throw new RuntimeError("Another action is under way");
    this.action = { type, requestId };
    try {
      return await body(robot);
    } finally {
      this.action = null;
      this.tellStatus();
    }
  }

  /** One action in the model's format, as a turn of PEAR's agent loop runs it: the arm at rest, an observation,
   * the action with that observation as its reference; then the report the next turn would give the model. */
  private jog(requestId: number, action: Readonly<Record<string, unknown>>): Promise<ActionReport> {
    return this.asAction("jog", requestId, async (robot) => {
      const format = SINGLE_ARM_POSE_FORMAT;
      let result: MotionResult;
      try {
        await robot.waitStationary(null);
        const observation = await robot.observe();
        this.tellFrame(requestId, observation);
        result = await robot.execute(action, {
          referenceObservation: observation,
          reportProgress: (phase) => this.event({ type: "phase", requestId, phase }),
        });
      } catch (error) {
        // what the agent loop does with a turn that failed before the robot gave a result
        await robot.stop();
        if (robot.status().status === "OFF") throw error;
        result = robot.failureResult(error, {
          formatName: format.name,
          status: isValueError(error) ? MotionStatus.REJECTED : MotionStatus.FAILED,
        });
      }
      const feedback = format.resultFeedback(result as never, { isDispatched: true });
      this.feedback = feedback;

      return { record: result.toRecord(), feedback, turnText: this.turnText(robot, feedback) };
    });
  }

  /** Tells the window the frame `observation` held, once: the JPEG's bytes as the observation holds them (the
   * message takes a copy), its number among the frames the wrist camera has seen, and how old it was then. */
  private tellFrame(requestId: number, observation: Observation<Uint8Array>): void {
    for (const [role, jpeg] of Object.entries(observation.images)) {
      const stamps = observation.camera_timestamps[role] ?? {};
      const ageS = observation.captured_monotonic_s - Number(stamps["received_monotonic_s"]);
      this.event({ type: "frame", requestId, jpeg, number: Number(stamps["frame_number"]), ageMs: Math.round(ageS * 1000) });
    }
  }

  private home(requestId: number): Promise<HomeResult> {
    return this.asAction("home", requestId, async (robot) => {
      const report = await robot.home({
        reportProgress: (progress) => this.event({ type: "phase", requestId, phase: String(progress["stage"] ?? JSON.stringify(progress)) }),
        approvePlan: (plan: HomePlan) =>
          new Promise<boolean>((resolve) => {
            const limit = setTimeout(() => this.approval?.(false), APPROVAL_LIMIT_MS);
            this.approval = (isApproved) => {
              clearTimeout(limit);
              this.approval = null;
              resolve(isApproved);
            };
            this.event({ type: "plan", requestId, plan: { ...plan } });
          }),
      });

      return {
        plan: { ...report.plan },
        stages: report.phases.map((phase) => String(phase["stage"] ?? "")),
        results: { ...report.results },
      };
    });
  }

  private async approve(isApproved: boolean): Promise<null> {
    if (this.approval === null) throw new RuntimeError("No Home plan waits for an answer");
    this.approval(isApproved);

    return null;
  }

  // ---------------------------------------------------------------- the status

  /** The text of the turn the model would be given now, with the report `feedback` of the last action. */
  private turnText(robot: StationRobot, feedback: string | null): string | null {
    const status = robot.status(true);
    if (!("arms" in status)) return null;
    try {
      const state = robot.modelState(status.arms[ARM]!.position, SINGLE_ARM_POSE_FORMAT.name);

      return SINGLE_ARM_POSE_FORMAT.turnText(state, feedback);
    } catch {
      return null;
    }
  }

  private status(): StationStatus {
    const periods = stepPeriods(stepStamps, performance.now());
    const off: StationStatus = {
      robot: "OFF",
      control: null,
      fault: null,
      isSettled: null,
      isReached: null,
      joints: null,
      targets: null,
      state: null,
      turnText: null,
      periods,
      steps: stepCount,
      since: periodsSince(),
      clock: clockNumbers(),
      camera: this.frames.numbers(),
      action: null,
      isHidden: this.isHidden,
    };
    const robot = this.robot;
    if (robot === null) return off;
    const status = robot.status(true);
    if (!("arms" in status)) return { ...off, robot: status.status };
    const detailed = status as DetailedStatus;
    const joints = [...detailed.arms[ARM]!.position];
    let state: StationStatus["state"] = null;
    let turnText: string | null = null;
    try {
      state = robot.modelState(joints, SINGLE_ARM_POSE_FORMAT.name);
      turnText = SINGLE_ARM_POSE_FORMAT.turnText(state, this.feedback);
    } catch {
      // a state that cannot be computed is shown as none
    }

    return {
      robot: detailed.status,
      control: detailed.control_state,
      fault: detailed.fault,
      isSettled: detailed.arrival.settled,
      isReached: detailed.arrival.reached,
      joints,
      targets: [...(detailed.targets[ARM] ?? [])],
      state,
      turnText,
      periods,
      steps: stepCount,
      since: off.since,
      clock: off.clock,
      camera: off.camera,
      action: this.action?.type ?? null,
      isHidden: this.isHidden,
    };
  }

  private tellStatus(): void {
    try {
      this.event({ type: "status", status: this.status() });
    } catch (error) {
      this.log("error", "station", "The status could not be told", error);
    }
  }
}
