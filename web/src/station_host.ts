// The station as the page's Worker runs it: PEAR's robot (the SO-101 with its 50 Hz control loop and its driver)
// on a simulated arm that this file makes itself, or on a real arm's serial line. Two requests lead from here to
// a real line. "preflight" takes the port the page was granted behind the read-only guard (station_port.ts),
// reads what its report holds and closes the port again: it can write nothing. "enableReal" takes the port behind
// the station's guard (station_guard.ts), reads the same while that guard lets no write through, tells what it
// read and waits for the operator's confirmation (the request "arm"); only then it lets the station's own writes
// through the guard and opens PEAR's robot on that line, which is PEAR's enable: the first write to a real servo.
// The robot is given the guard and nothing beneath it. PEAR's enable writes its settings whatever the servos
// hold; the report told before the confirmation shows every setting it will change, and the guard lets PEAR's
// values through and no others. station_worker.ts gives this file the Worker's messages and the Worker's serial
// ports; a test may give it its own.
//
// A request is started when it arrives and answered when it is done, so that a Stop is taken while an action is
// under way: nothing here waits for an action before it takes the next message.
//
// The robot's wrist camera is the library's own (CameraFeed over WristCamera); its frame reader is fed by the
// window, which has the camera: a Worker cannot open one.

import { pythonErrorMessage, pythonErrorName, isValueError, RuntimeError } from "../../src/python/errors";
import { type HardwareSection, SO101_DEFAULT_CONFIG, type SO101Config } from "../../src/so101/config";
import { SINGLE_ARM_POSE_FORMAT } from "../../src/so101/formats";
import { WristCamera, type WristFrameReader } from "../../src/so101/hardware/cameras";
import {
  DEFAULT_FOLLOWER_CONFIG,
  followerMotors,
  simulatedArm,
  SO101Follower,
  SO101Hardware,
} from "../../src/so101/hardware/index";
import { SO101ControlLoop } from "../../src/so101/joint/control_loop";
import { ARM } from "../../src/so101/layout";
import { SO101Robot } from "../../src/so101/robot";
import {
  encodeSignMagnitude,
  ENCODING_TABLE,
  getAddress,
  OperatingMode,
  protocol,
  type MotorCalibration,
  type RegisterName,
  type SimServoChain,
  type Transport,
} from "../../src/feetech/index";
import { CameraFeed } from "../../src/station/cameras";
import type { MonotonicClock } from "../../src/station/joint/clock";
import { DEFAULT_CONTROL_SETTINGS } from "../../src/station/joint/config";
import { realTimeClock } from "../../src/station/joint/deadline_clock";
import { MotionStatus, type MotionResult } from "../../src/station/motion/results";
import type { ControlLoopClass, StationConfig } from "../../src/station/robot";
import type { DetailedStatus, HomePlan, Observation } from "../../src/station/schemas";
import { SIM_CALIBRATION, simulatedConfiguredPort, simulatedGrantedPort } from "./sim_port";
import { SETTING_ADDRESSES, type StationSetting } from "./station_guard";
import {
  type GrantedPort,
  grantedPorts,
  openReadOnly,
  openStation,
  type ReadOnlyLine,
  type SerialSource,
  type StationLine,
  usbIdsOf,
} from "./station_port";
import {
  type ActionReport,
  type ArmFingerprint,
  ARMING_LIMIT_MS,
  type ArmingBlocker,
  type CameraNumbers,
  type CameraTelling,
  type ClockNumbers,
  type DisableResult,
  type EnableRealResult,
  type EnableResult,
  type FromStation,
  type HomeResult,
  type MotorSteps,
  type PeriodsSince,
  type PreflightReport,
  type PreflightServo,
  type PreflightSetting,
  type PreflightStop,
  type RealLineStatus,
  type ServoPrint,
  STATUS_PERIOD_MS,
  type StationEvent,
  type StationRequest,
  type StationStatus,
  type StepPeriods,
  type TimingCheck,
  type TimingFailure,
  type ToStation,
  type UsbIds,
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

/** The station's settings on a real arm: the same, with the line named as what it is, the port the page was
 * granted. PEAR's own check of them (requireCommissioned) asks for a calibration: the Worker answers it as for
 * the simulated arm, because it opens the robot only with the calibration file the page found equal to the
 * registers or with what the servos hold, and never on servos that hold the factory's values. */
export const REAL_STATION_CONFIG: StationConfig<SO101Config> = {
  control: DEFAULT_CONTROL_SETTINGS,
  robot: {
    ...SO101_DEFAULT_CONFIG,
    hardware: { ...SO101_DEFAULT_CONFIG.hardware, port: "granted" },
    camera: { ...SO101_DEFAULT_CONFIG.camera, path: "none" },
  } as SO101Config,
};

/** The registers PEAR's enable writes to every servo besides Goal_Position, Torque_Enable and Lock, in the order
 * it writes them, each with the value it writes: lerobot's configure_motors() and the follower's configure(). The
 * gains are the library's own; the other numbers are not exported there, and a test holds them to what the
 * library's enable writes. */
export const ENABLE_SETTINGS: readonly (readonly [RegisterName, number])[] = [
  ["Return_Delay_Time", 0],
  ["Maximum_Acceleration", 254],
  ["Acceleration", 254],
  ["Operating_Mode", OperatingMode.POSITION],
  ["P_Coefficient", (STATION_CONFIG.robot.hardware as HardwareSection).position_p_coefficient],
  ["I_Coefficient", DEFAULT_FOLLOWER_CONFIG.positionICoefficient],
  ["D_Coefficient", DEFAULT_FOLLOWER_CONFIG.positionDCoefficient],
];

/** What it writes to the gripper's servo besides: half the torque, half the current, a quarter once overloaded. */
export const GRIPPER_SETTINGS: readonly (readonly [RegisterName, number])[] = [
  ["Max_Torque_Limit", 500],
  ["Protection_Current", 250],
  ["Overload_Torque", 25],
];

/** The motor PEAR's enable gives the settings of its own. */
const GRIPPER = "gripper";

/** How many transactions PEAR's enable makes while a servo is without torque: so many single READs a preflight
 * makes and times. */
export const LIMP_TRANSACTIONS = 63;

/** What a servo holds of the calibration, with the registers' names as a difference is told. */
const PRINT_FIELDS = [
  ["model", "Model_Number"],
  ["homingOffset", "Homing_Offset"],
  ["rangeMin", "Min_Position_Limit"],
  ["rangeMax", "Max_Position_Limit"],
] as const;

/** Returns how the servos `read` differ from `expected`, each difference in words; none when it is the same arm. */
export function fingerprintDifferences(read: readonly ServoPrint[], expected: ArmFingerprint): string[] {
  const differences: string[] = [];
  if (expected.length !== read.length) differences.push(`${expected.length} servos expected, ${read.length} read`);
  for (const servo of read) {
    const other = expected.find(({ id }) => id === servo.id);
    if (other === undefined) {
      differences.push(`servo ${servo.id} is not among the expected`);
      continue;
    }
    for (const [field, register] of PRINT_FIELDS) {
      if (servo[field] !== other[field]) {
        differences.push(`servo ${servo.id} ${register}: read ${servo[field]}, expected ${other[field]}`);
      }
    }
  }

  return differences;
}

/** Returns where a servo keeps the register at `address`, by lerobot's table: the EPROM, the SRAM, or the block
 * it calls Factory. */
function areaOf(address: number): PreflightSetting["area"] {
  if (address < 40) return "eeprom";

  return address < 80 ? "ram" : "factory";
}

/** Returns USB ids as they are written: vendor and product, four hexadecimal digits each. */
function usbText(usb: UsbIds): string {
  return [usb.vendorId, usb.productId].map((id) => id.toString(16).padStart(4, "0")).join(":");
}

/** What a preflight has found so far; its report is this and what the line says of itself at the end. */
interface PreflightFindings {
  ports: (UsbIds | null)[] | null;
  stop: PreflightStop | null;
  detail: string;
  servos: PreflightServo[] | null;
  settings: PreflightSetting[] | null;
  singleReads: PreflightReport["singleReads"];
  timing: TimingCheck | null;
}

type PreflightRequest = Extract<StationRequest, { type: "preflight" }>;
type EnableRealRequest = Extract<StationRequest, { type: "enableReal" }>;

/** What reading an arm needs of its line: the guard as a transport, and why the line failed, if it did. Both
 * the read-only line and the station's line are one. */
interface ReadableLine {
  readonly guard: Transport & { readonly failure: unknown };
}

/** The bit of Phase (18) that PEAR's enable clears by rewriting the register, which is in the EEPROM. */
const PHASE_REWRITTEN_BIT = 0x10;

/**
 * Returns the reasons against enabling the station on the arm of `report`, from the report alone, in a fixed
 * order; none for an arm that was read to its end and is as PEAR's enable needs it. A setting that PEAR's enable
 * would change is no reason: PEAR writes its settings at every enable whatever the servos hold, the report shows
 * each one that differs, and the operator's confirmation is given to that list. `calibrationFile` is the
 * calibration the person loaded, or null: it must hold what the servos hold, as the library's own check compares
 * them (the same motors; each one's limits and homing offset).
 */
export function armingBlockers(
  report: PreflightReport,
  calibrationFile: Readonly<Record<string, MotorCalibration>> | null,
): ArmingBlocker[] {
  const blockers: ArmingBlocker[] = [];
  if (report.stop !== null) blockers.push({ code: "stop", stop: report.stop });
  if (report.timing !== null && report.timing.failures.length > 0) blockers.push({ code: "timing" });
  const servos = report.servos ?? [];
  const idsWhere = (isSo: (servo: PreflightServo) => boolean): number[] => servos.filter(isSo).map(({ id }) => id);
  const faulty = idsWhere(({ status }) => status !== 0);
  if (faulty.length > 0) blockers.push({ code: "status", ids: faulty });
  const rewritten = idsWhere(({ phase }) => (phase & PHASE_REWRITTEN_BIT) !== 0);
  if (rewritten.length > 0) blockers.push({ code: "phase", ids: rewritten });
  const uncalibrated = idsWhere(({ homingOffset, rangeMin, rangeMax }) => homingOffset === 0 && rangeMin === 0 && rangeMax === 4095);
  if (uncalibrated.length > 0) blockers.push({ code: "uncalibrated", ids: uncalibrated });
  if (calibrationFile !== null && report.servos !== null) {
    const differences: string[] = [];
    const names = servos.map(({ name }) => name);
    for (const name of Object.keys(calibrationFile)) {
      if (!names.includes(name)) differences.push(`${name}: in the file, not among the servos`);
    }
    for (const servo of servos) {
      if (!Object.hasOwn(calibrationFile, servo.name)) {
        differences.push(`${servo.name}: not in the file`);
        continue;
      }
      const file = calibrationFile[servo.name] as MotorCalibration;
      for (const [field, register] of CALIBRATION_FIELDS) {
        if (file[field] !== servo[field]) differences.push(`${servo.name} ${register}: file ${file[field]}, servo ${servo[field]}`);
      }
    }
    if (differences.length > 0) blockers.push({ code: "calibration", detail: differences.join("; ") });
  }
  if (report.guard.refused > 0) blockers.push({ code: "guard", refused: report.guard.refused });

  return blockers;
}

/** What a calibration and a servo's registers are compared by, with the registers' names as a difference is told. */
const CALIBRATION_FIELDS = [
  ["rangeMin", "Min_Position_Limit"],
  ["rangeMax", "Max_Position_Limit"],
  ["homingOffset", "Homing_Offset"],
] as const;

/**
 * Returns what the station's guard lets PEAR's enable write to each servo of `settings` besides torque, lock and
 * acceleration: each register of the report with the one value PEAR's enable writes to it, and no other value.
 * Where a servo holds another value, this write changes it, in the EEPROM for good: the report the operator
 * confirmed shows every such row.
 */
export function guardSettings(settings: readonly PreflightSetting[]): Record<number, StationSetting[]> {
  const allowed: Record<number, StationSetting[]> = {};
  for (const { id, address, bytes, pear } of settings) {
    const list = (allowed[id] ??= []);
    if (SETTING_ADDRESSES.has(address)) list.push({ address, bytes, value: pear });
  }

  return allowed;
}

/** Returns the calibration the servos of `servos` hold, as the library's readCalibration() gives it: a drive mode
 * is no register, so it is 0 for every motor. */
export function heldCalibration(servos: readonly PreflightServo[]): Record<string, MotorCalibration> {
  return Object.fromEntries(
    servos.map(({ name, id, homingOffset, rangeMin, rangeMax }) => [name, { id, driveMode: 0, homingOffset, rangeMin, rangeMax }]),
  );
}

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
  /** Whether a preflight has a real arm's line, or is about to take it. */
  private isPreflighting = false;
  /** Whether an "enableReal" runs: from its arrival until it is answered. */
  private isArming = false;
  /** Whether a stop or a hidden page came while that "enableReal" ran: it then counts as refused. */
  private isArmingStopped = false;
  /** Settles the wait of the "enableReal" for the operator's answer; null while none waits. */
  private arming: ((isConfirmed: boolean) => void) | null = null;
  /** The id of the "enableReal" that waits for it: the only request an answer may name. */
  private armingId: number | null = null;
  /** The real arm's line while the robot holds it; null on the simulated arm and while the robot is off. */
  private line: StationLine | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  /** The frames of the window's camera: what the wrist camera of the robot that is open reads. A station that
   * is enabled anew has been told nothing of the camera yet. */
  private frames = new WindowFrames();

  /** `serial` is where a preflight finds the port the page was granted (station_port.ts); null when the Worker
   * has no serial ports to give. `timingClock` is the clock the timing self-check keeps its periods with: the
   * loop's own unless a test gives one that does not wait. `real` is what a test may give for a real arm: the
   * clock its robot, its line and its guard keep (the page's own without one), how long the operator's answer
   * is awaited, ms (ARMING_LIMIT_MS without one), and who is shown the line's guard when the line is opened,
   * to see the guard's state: the guard is all of the line that is ever given out. */
  constructor(
    private readonly post: (message: FromStation) => void,
    private readonly serial: SerialSource | null = null,
    private readonly timingClock: Pick<MonotonicClock, "monotonic" | "sleep"> | null = null,
    private readonly real: {
      readonly clock?: MonotonicClock;
      readonly armingLimitMs?: number;
      readonly onGuard?: (guard: StationLine["guard"]) => void;
    } = {},
  ) {}

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
      case "preflight":
        return this.preflight(request);
      case "enableReal":
        return this.enableReal(id, request);
      case "arm":
        return this.arm(request.requestId, request.isConfirmed);
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
    if (this.isPreflighting) throw new RuntimeError("A preflight of a real arm is under way");
    if (this.isArming) throw new RuntimeError("The enabling of a real arm is under way");
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
    const timing = await this.timingCheck(chain, 0);
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

  /** The timing self-check on a line before the torque is switched on, reads only: TIMING_PERIODS control
   * periods of one read of every servo's position and a wait for the period's end, on the clock the loop keeps
   * its periods with. Enabling is refused when the periods or the reads are too slow, or the page is hidden.
   * The answer to a read is awaited for `answerLimitMs` at most: zero on the simulated chain, which has answered
   * by the time the packet is written; a control period on a serial line, where the answer comes in pieces. */
  private async timingCheck(line: Transport, answerLimitMs: number): Promise<TimingCheck> {
    const clock = this.timingClock ?? realTimeClock();
    const periodS = 1 / STATION_CONFIG.control.rate_hz;
    const ids = Object.values(followerMotors()).map(({ id }) => id);
    const packet = syncReadPacket(ids, PRESENT_POSITION[0], PRESENT_POSITION[1]);
    const answerLength = ids.length * (6 + PRESENT_POSITION[1]);
    const began: number[] = [];
    let maxReadMs = 0;
    let unanswered = 0;
    let due = clock.monotonic();
    let isLeftOver = false;
    for (let index = 0; index <= TIMING_PERIODS; index++) {
      // what came late or in part of the answer before is not this read's answer
      if (isLeftOver) await line.read(Number.MAX_SAFE_INTEGER, 0);
      const start = performance.now();
      began.push(start);
      await line.write(packet);
      let received = 0;
      for (;;) {
        const left = start + answerLimitMs - performance.now();
        received += (await line.read(answerLength - received, Math.max(left, 0))).length;
        if (received >= answerLength || left <= 0) break;
      }
      isLeftOver = received !== answerLength;
      if (isLeftOver) unanswered += 1;
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

  // ---------------------------------------------------------------- the hand-over of a real arm's line, reads only

  /** The request "preflight": refused while the robot is open or being opened, and while another preflight has
   * the line. */
  private async preflight(request: PreflightRequest): Promise<PreflightReport> {
    if (this.robot !== null || this.isEnabling) {
      throw new RuntimeError("Station already open: a preflight of a real arm needs the station disabled");
    }
    if (this.isPreflighting) throw new RuntimeError("Another preflight of a real arm is under way");
    if (this.isArming) throw new RuntimeError("The enabling of a real arm is under way: it has the line");
    this.isPreflighting = true;
    this.isHidden = request.isHidden;
    try {
      return await this.preflightOn(request);
    } finally {
      this.isPreflighting = false;
    }
  }

  /** Takes the port, reads the arm behind the read-only guard and closes the port again, whatever happened in
   * between: after it the Worker holds no port. The robot is never given this line. */
  private async preflightOn(request: PreflightRequest): Promise<PreflightReport> {
    const began = performance.now();
    const found: PreflightFindings = {
      ports: null,
      stop: null,
      detail: "",
      servos: null,
      settings: null,
      singleReads: null,
      timing: null,
    };
    let line = null as ReadOnlyLine | null;
    let isClosed = true; // no port was taken
    try {
      const port = await this.preflightPort(request, found);
      if (port !== null) {
        try {
          line = await openReadOnly(port);
        } catch (error) {
          found.stop = "open-failed";
          found.detail = `The port did not open: ${pythonErrorName(error)}: ${pythonErrorMessage(error)}`;
        }
      }
      if (line !== null) await this.readArm(line, request.expected, found);
    } catch (error) {
      // an error of the line itself is a stop; any other is the request's error, after the port is closed
      if (line === null || line.guard.failure === null) throw error;
      found.stop = "line-lost";
      found.detail = `The port was lost while it was read: ${pythonErrorName(error)}: ${pythonErrorMessage(error)}`;
    } finally {
      if (line !== null) isClosed = await line.close();
    }
    const counts = line?.guard.counts ?? { passed: {}, refused: {} };

    return {
      ...found,
      guard: {
        passed: { ...counts.passed },
        refused: Object.values(counts.refused).reduce((sum, count) => sum + count, 0),
      },
      lineErrors: line?.lineErrors() ?? 0,
      isClosed,
      tookMs: Math.round(performance.now() - began),
    };
  }

  /** Returns the one port a preflight reads: the simulated port of the Worker's own, or the one port the page
   * was granted (of the adapter `usb`, when the window knows it). Null with the stop in `found` when there is no
   * such port or more than one. */
  private async preflightPort(
    request: Pick<PreflightRequest, "source" | "usb">,
    found: PreflightFindings,
  ): Promise<GrantedPort | null> {
    let ports: GrantedPort[];
    if (request.source === "simulated") {
      ports = [simulatedGrantedPort()];
    } else if (request.source === "simulated-configured") {
      ports = [simulatedConfiguredPort(ENABLE_SETTINGS, GRIPPER_SETTINGS)];
    } else if (this.serial === null) {
      found.stop = "no-serial";
      found.detail = "The Worker's navigator has no serial: this browser gives a Worker no serial ports";

      return null;
    } else {
      ports = await grantedPorts(this.serial);
    }
    found.ports = ports.map(usbIdsOf);
    const usb = request.usb;
    const candidates =
      usb === null
        ? ports
        : ports.filter((_, index) => {
            const ids = (found.ports as (UsbIds | null)[])[index] as UsbIds | null;

            return ids !== null && ids.vendorId === usb.vendorId && ids.productId === usb.productId;
          });
    const which = usb === null ? "" : ` with the USB ids ${usbText(usb)}`;
    if (candidates.length === 0) {
      found.stop = "no-port";
      found.detail = `The Worker was given no granted port${which} (${ports.length} granted in all)`;

      return null;
    }
    if (candidates.length > 1) {
      found.stop = "several-ports";
      found.detail = `The Worker was given ${candidates.length} granted ports${which}: they cannot be told apart`;

      return null;
    }

    return candidates[0] as GrantedPort;
  }

  /** Reads the arm on `line`, which is a guard that lets no write through and nothing else (the read-only guard,
   * or the station's guard in its state "reads"): the handshake, whether it is the arm the window read, what each
   * servo holds, how long the single reads of a limp servo's time take, and the timing self-check. A stop is told
   * in `found`; an error of the line is thrown. */
  private async readArm(line: ReadableLine, expected: ArmFingerprint, found: PreflightFindings): Promise<void> {
    // lerobot's follower as the window's read-only session makes it: without a calibration, never configured, and
    // with a disconnect that would write nothing. It is given the guard, and the guard is all it can reach
    const follower = new SO101Follower(line.guard, null, { disableTorqueOnDisconnect: false }, { port: "worker" });
    const bus = follower.bus;
    try {
      await bus.connect(true); // pings ids 1 to 6, requires the STS3215's model number and one firmware for all
    } catch (error) {
      if (line.guard.failure !== null) throw error;
      found.stop = "handshake-failed";
      found.detail = `The handshake failed: ${pythonErrorMessage(error).trim().replace(/\s*\n\s*/g, " | ")}`;

      return;
    }

    const access = { normalize: false, numRetry: SO101Hardware.BUS_RETRIES };
    const motors = Object.entries(followerMotors())
      .map(([name, { id }]) => ({ name, id }))
      .sort((a, b) => a.id - b.id);
    /** Returns a register of all servos, or of `names`, as lerobot reads it. */
    const read = (register: RegisterName, names: readonly string[] | null = null): Promise<Record<string, number>> =>
      bus.syncRead(register, names, access);
    /** Returns it as the servos give it: where the bus takes a sign out of the value, it is put back. */
    const raw = async (register: RegisterName, names: readonly string[] | null = null): Promise<Record<string, number>> => {
      const values = await read(register, names);
      if (!Object.hasOwn(ENCODING_TABLE, register)) return values;
      const signBit = ENCODING_TABLE[register] as number;

      return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, encodeSignMagnitude(value, signBit)]));
    };

    // the same arm? What tells one arm from another, before anything else is read
    const model = await read("Model_Number");
    const homingOffset = await read("Homing_Offset");
    const rangeMin = await read("Min_Position_Limit");
    const rangeMax = await read("Max_Position_Limit");
    const prints: ServoPrint[] = motors.map(({ name, id }) => ({
      id,
      model: model[name] as number,
      homingOffset: homingOffset[name] as number,
      rangeMin: rangeMin[name] as number,
      rangeMax: rangeMax[name] as number,
    }));
    const differences = fingerprintDifferences(prints, expected);
    if (differences.length > 0) {
      found.stop = "other-arm";
      found.detail = `Not the arm the window read: ${differences.join("; ")}`;

      return;
    }

    // the servos, and beside each register PEAR's enable would write what the servo holds now
    const major = await read("Firmware_Major_Version");
    const minor = await read("Firmware_Minor_Version");
    const position = await raw("Present_Position");
    const goal = await raw("Goal_Position");
    const torque = await raw("Torque_Enable");
    const lock = await raw("Lock");
    const status = await raw("Status");
    const voltage = await raw("Present_Voltage");
    const temperature = await raw("Present_Temperature");
    const goalVelocity = await raw("Goal_Velocity");
    const torqueLimit = await raw("Torque_Limit");
    const phase = await raw("Phase");
    const held = new Map<RegisterName, Record<string, number>>();
    for (const [register] of ENABLE_SETTINGS) held.set(register, await raw(register));
    for (const [register] of GRIPPER_SETTINGS) held.set(register, await raw(register, [GRIPPER]));
    found.servos = motors.map(({ name }, index) => ({
      ...(prints[index] as ServoPrint),
      name,
      firmware: `${major[name]}.${minor[name]}`,
      position: position[name] as number,
      goal: goal[name] as number,
      torque: torque[name] as number,
      lock: lock[name] as number,
      status: status[name] as number,
      voltage: voltage[name] as number,
      temperature: temperature[name] as number,
      goalVelocity: goalVelocity[name] as number,
      torqueLimit: torqueLimit[name] as number,
      phase: phase[name] as number,
    }));
    found.settings = motors.flatMap(({ name, id }) =>
      [...ENABLE_SETTINGS, ...(name === GRIPPER ? GRIPPER_SETTINGS : [])].map(([register, pear]) => {
        const [address, bytes] = getAddress(register);

        return {
          id,
          register,
          address,
          bytes: bytes as 1 | 2,
          area: areaOf(address),
          pear,
          held: (held.get(register) as Record<string, number>)[name] as number,
        };
      }),
    );

    // the limp time: as many single READs, the servos in turn, as PEAR's enable has transactions while a servo is
    // without torque
    const round = (value: number): number => Math.round(value * 100) / 100;
    const readsBegan = performance.now();
    let maxMs = 0;
    for (let index = 0; index < LIMP_TRANSACTIONS; index++) {
      const start = performance.now();
      await bus.read("Present_Position", (motors[index % motors.length] as { name: string }).name, { normalize: false });
      maxMs = Math.max(maxMs, performance.now() - start);
    }
    found.singleReads = { count: LIMP_TRANSACTIONS, totalMs: round(performance.now() - readsBegan), maxMs: round(maxMs) };

    // the timing self-check on this line: an answer is awaited until its control period is over
    found.timing = await this.timingCheck(line.guard, 1000 / STATION_CONFIG.control.rate_hz);
  }

  // ---------------------------------------------------------------- enabling the station on a real arm

  /** The request "enableReal": refused while the robot is open or being opened, and while a preflight or another
   * "enableReal" has the line. */
  private async enableReal(requestId: number, request: EnableRealRequest): Promise<EnableRealResult> {
    if (this.robot !== null || this.isEnabling) {
      throw new RuntimeError("Station already open: enabling a real arm needs the station disabled");
    }
    if (this.isPreflighting) throw new RuntimeError("A preflight of a real arm is under way");
    if (this.isArming) throw new RuntimeError("Another enabling of a real arm is under way");
    this.isArming = true;
    this.isArmingStopped = false;
    this.isHidden = request.isHidden;
    try {
      return await this.enableRealOn(requestId, request);
    } finally {
      this.isArming = false;
      this.arming = null;
      this.armingId = null;
    }
  }

  /** Takes the port behind the station's guard, reads the arm as a preflight does while the guard lets no write
   * through, tells what it read, and opens the robot on the line only without a blocker and with the operator's
   * confirmation. However it ends without the robot open, the line is closed, or a warning says that it is not. */
  private async enableRealOn(requestId: number, request: EnableRealRequest): Promise<EnableRealResult> {
    const began = performance.now();
    const found: PreflightFindings = {
      ports: null,
      stop: null,
      detail: "",
      servos: null,
      settings: null,
      singleReads: null,
      timing: null,
    };
    const clock = this.real.clock;
    let line = null as StationLine | null;
    /** Returns the report as it stands, with whether the Worker holds no port. */
    const report = (isClosed: boolean): PreflightReport => {
      const counts = line?.guard.counts ?? { passed: {}, refused: 0 };

      return {
        ...found,
        guard: { passed: counts.passed, refused: counts.refused },
        lineErrors: line?.lineErrors() ?? 0,
        isClosed,
        tookMs: Math.round(performance.now() - began),
      };
    };
    /** Lets no write through any more and closes the port; resolves with whether the Worker holds no port then. */
    const closeLine = async (): Promise<boolean> => {
      if (line === null) return true;
      line.guard.backToReads();

      return line.close();
    };
    let isOpening = false;
    try {
      // reads only: the guard is in its state "reads" until the operator has confirmed
      try {
        const port = await this.preflightPort(request, found);
        if (port !== null) {
          try {
            line = await openStation(port, clock === undefined ? {} : { now: () => clock.monotonic() * 1000 });
          } catch (error) {
            found.stop = "open-failed";
            found.detail = `The port did not open: ${pythonErrorName(error)}: ${pythonErrorMessage(error)}`;
          }
        }
        if (line !== null) {
          this.real.onGuard?.(line.guard);
          await this.readArm(line, request.expected, found);
        }
      } catch (error) {
        // an error of the line itself is a stop; any other is the request's error, after the port is closed
        if (line === null || line.guard.failure === null) throw error;
        found.stop = "line-lost";
        found.detail = `The port was lost while it was read: ${pythonErrorName(error)}: ${pythonErrorMessage(error)}`;
      }
      const read = report(line === null);
      const blockers = armingBlockers(read, request.calibrationFile);
      const { servos, settings } = found;
      const held = line;
      if (blockers.length === 0 && (held === null || servos === null || settings === null || found.timing === null)) {
        throw new RuntimeError("The arm was not read to its end");
      }
      this.event({ type: "arming", requestId, report: read, blockers });
      if (blockers.length > 0 || held === null || servos === null || settings === null) {
        return { outcome: "blocked", report: report(await closeLine()), blockers, openMs: null };
      }

      // the operator's answer; a stop or a hidden page since the request came counts as a refusal
      const isConfirmed = !this.isArmingStopped && !this.isHidden && (await this.confirmation(requestId));
      if (!isConfirmed) return { outcome: "refused", report: report(await closeLine()), blockers, openMs: null };

      // confirmed: from here on the guard lets the station's own writes through, and nothing else
      held.guard.enterStation(guardSettings(settings));
      isOpening = true;
      const frames = clock === undefined ? new WindowFrames() : new WindowFrames(clock);
      this.frames = frames;
      const robot = new StationRobot(REAL_STATION_CONFIG, {
        ...(clock === undefined ? {} : { clock }),
        cameras: new CameraFeed(new WristCamera(REAL_STATION_CONFIG.robot, frames, { clock: clock ?? realTimeClock() })),
        line: {
          transport: held.guard,
          calibration: request.calibrationFile ?? heldCalibration(servos),
          onWarning: (message, error) => this.log("warning", "so101.hardware", message, error),
          ...(clock === undefined ? {} : { clock }),
        },
        log: (logger, level, message, error) => this.log(level, logger, message, error),
        uuid4,
        // the calibration is the file the page found equal to the registers, or what the servos hold
        configOptions: { calibrationExists: () => true },
      });
      resetSteps();
      realTimeClock().resetStats();
      const opening = performance.now();
      await robot.open(); // PEAR's enable: the first write to the servos
      this.robot = robot;
      this.line = held;
      this.chain = null;
      this.feedback = null;
      isOpening = false;
      this.statusTimer = setInterval(() => this.tellStatus(), STATUS_PERIOD_MS);
      this.tellStatus();

      return { outcome: "enabled", report: report(false), blockers, openMs: Math.round(performance.now() - opening) };
    } catch (error) {
      // Whatever failed, the Worker does not keep the port. When the robot did not open, PEAR's own failure path
      // has switched the torque off where it could. The reply is the error and cannot say whether the port
      // closed: a warning says it
      const isClosed = await closeLine();
      if (isOpening) {
        this.log("warning", "station", `The robot did not open on the real arm; its port ${isClosed ? "is closed" : "did not close"}`, error);
      } else if (!isClosed) {
        this.log("warning", "station", "The enabling of a real arm failed and its port did not close", error);
      }
      throw error;
    }
  }

  /** Waits for the operator's answer to the event "arming": the request "arm"; a stop or a hidden page, which
   * refuse; or the limit, after which no answer counts as a refusal. */
  private confirmation(requestId: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const limit = setTimeout(() => this.arming?.(false), this.real.armingLimitMs ?? ARMING_LIMIT_MS);
      this.armingId = requestId;
      this.arming = (isConfirmed) => {
        clearTimeout(limit);
        this.arming = null;
        this.armingId = null;
        resolve(isConfirmed);
      };
    });
  }

  /** The operator's answer. It is taken only when it names the "enableReal" that waits: an answer to an earlier
   * report, whose request has ended, must not confirm this one. */
  private async arm(requestId: number, isConfirmed: boolean): Promise<null> {
    if (this.arming === null) throw new RuntimeError("No enabling of a real arm waits for a confirmation");
    if (requestId !== this.armingId) {
      throw new RuntimeError("This answer names another enabling of a real arm than the one that waits");
    }
    this.arming(isConfirmed);

    return null;
  }

  /** Disables the station on a real arm: the robot's close() switches the torque off, then the guard lets no
   * write through again and the port is closed. Whatever fails, the robot is gone from the host at the end: on a
   * lost line the torque-off writes fail and the servos keep holding, which the status has told (`isLost`). */
  private async disableReal(robot: StationRobot, line: StationLine): Promise<DisableResult> {
    try {
      await robot.close();
    } catch (error) {
      this.log("warning", "station", "The robot did not close as it should on the real arm: its servos may still hold", error);
    }
    line.guard.backToReads();
    const isLineClosed = await line.close();
    if (this.statusTimer !== null) clearInterval(this.statusTimer);
    this.statusTimer = null;
    this.robot = null;
    this.line = null;
    this.tellStatus();

    return { positions: {}, isLineClosed };
  }

  private async disable(): Promise<DisableResult> {
    const robot = this.open;
    this.approval?.(false);
    if (this.line !== null) return this.disableReal(robot, this.line);
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

    return { positions, isLineClosed: true };
  }

  // ---------------------------------------------------------------- stopping

  private async stop(): Promise<null> {
    this.approval?.(false);
    // an enabling of a real arm that has not been confirmed yet is refused by a stop
    if (this.isArming) this.isArmingStopped = true;
    this.arming?.(false);
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

  /** One action in the model's format, on the simulated arm or on a real arm's line, as a turn of PEAR's agent
   * loop runs it: the arm at rest, an observation,
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
      arm: null,
      line: null,
    };
    const robot = this.robot;
    if (robot === null) return off;
    const arm = this.line === null ? "simulated" : "real";
    const line = this.lineStatus();
    const status = robot.status(true);
    if (!("arms" in status)) return { ...off, robot: status.status, arm, line };
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
      arm,
      line,
    };
  }

  /** Returns the real arm's line as the status tells it; null on the simulated arm. */
  private lineStatus(): RealLineStatus | null {
    const line = this.line;
    if (line === null) return null;
    const guard = line.guard.status();

    return {
      passed: guard.passed,
      refused: guard.refusedCount,
      refusals: guard.refusals.slice(-5).map(({ message }) => message),
      lineErrors: line.lineErrors(),
      isLost: line.isLost(),
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
