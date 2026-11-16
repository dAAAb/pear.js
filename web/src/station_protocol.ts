// The messages between the window and the Worker that runs the station (station_worker.ts): the robot, its
// control loop, its driver and the arm's line live in the Worker, and the window only asks and is told.
//
// A request carries an id and is answered once, by a reply with that id: a result, or an error with the Python
// class name and the message as the robot gives them. What the Worker tells unasked is an event.
//
// The camera stays in the window (a Worker cannot open one). What the window tells of it carries no id and is
// never answered: whether the camera runs, and its frames, each the JPEG a turn would send.

import type { MotorCalibration } from "../../src/feetech/index";
import type { ModelState } from "../../src/so101/kinematics/index";

/** Where each servo of the simulated arm stands, steps, by the motor's name. */
export type MotorSteps = Readonly<Record<string, number>>;

/** The USB ids of an adapter, as `SerialPort.getInfo()` gives them. */
export interface UsbIds {
  readonly vendorId: number;
  readonly productId: number;
}

/** Where the Worker takes a real arm's port from. "granted": the one port the page was granted, by the Worker's own
 * `navigator.serial`. The other two are the browser check's way through the same code, a simulated port the Worker
 * makes itself in place of a granted one: "simulated" holds the simulated servos' own settings, as an arm that
 * lerobot has never run; "simulated-configured" holds the settings PEAR's enable writes, as an arm lerobot has run. */
export type PortSource = "granted" | "simulated" | "simulated-configured";

/** What tells one arm from another on the line: what one servo holds of the calibration. */
export interface ServoPrint {
  readonly id: number;
  /** Model_Number. */
  readonly model: number;
  /** Homing_Offset, Min_Position_Limit and Max_Position_Limit, as lerobot reads them. */
  readonly homingOffset: number;
  readonly rangeMin: number;
  readonly rangeMax: number;
}

/** The six servos of an arm, in the order of their ids. */
export type ArmFingerprint = readonly ServoPrint[];

export type StationRequest =
  /** Makes the simulated arm at `positions`, checks the timing on its line and opens the robot; `isHidden` is
   * whether the page is hidden then, which the timing self-check refuses. */
  | { readonly type: "enable"; readonly positions: MotorSteps; readonly isHidden: boolean }
  /** The robot's `stop()`: brakes into a hold. Never closes. */
  | { readonly type: "stop" }
  /** The robot's `close()`, which on a real arm switches the torque off. Answers where the simulated arm stands. */
  | { readonly type: "disable" }
  /** One action in the model's format, executed as a turn executes it. */
  | { readonly type: "jog"; readonly action: Readonly<Record<string, unknown>> }
  /** The robot's `home`; its plan comes as an event and waits for an "approve". */
  | { readonly type: "home" }
  /** The person's answer to the Home plan that is shown. */
  | { readonly type: "approve"; readonly isApproved: boolean }
  /** Whether the page is hidden: a hidden page stops and starts no action. */
  | { readonly type: "visibility"; readonly isHidden: boolean }
  /** The hand-over of a real arm's line to the Worker, reads only: the Worker finds the port the page was
   * granted, opens it behind the read-only guard, reads what `PreflightReport` holds and closes it again. Nothing
   * is written to a servo and the robot is not opened. The window must have closed its own use of the port first.
   * `usb` is the adapter as the window knows it (null: the browser gave no ids), `expected` what the window read
   * of the six servos, `isHidden` whether the page is hidden. With `source` "simulated" the Worker takes a
   * simulated port of its own in place of a granted one: the browser check's way through the same code. */
  | {
      readonly type: "preflight";
      readonly source: PortSource;
      readonly usb: UsbIds | null;
      readonly expected: ArmFingerprint;
      readonly isHidden: boolean;
    }
  /** Enables the station on a real arm: the one request after which the page writes to a servo. The Worker takes
   * the line as a preflight does and reads all a preflight reads, behind a guard that lets no write through
   * (station_guard.ts in its state "reads"). It tells what it found as the event "arming". With a reason against
   * enabling among the event's `blockers` it closes the line and answers "blocked". Without one it waits for the
   * request "arm": refused, or not answered within ARMING_LIMIT_MS, it closes the line and answers "refused";
   * confirmed, it lets the station's own writes through the guard and opens the robot, which is PEAR's enable,
   * and answers "enabled". The window must have closed its own use of the port first. `source`, `usb`, `expected`
   * and `isHidden` are a preflight's. `calibrationFile` is the lerobot calibration file the person loaded, when
   * the page found it equal to the registers; null when none is loaded: the robot is then given the calibration
   * the servos hold, with lerobot's drive mode 0 for every motor. */
  | {
      readonly type: "enableReal";
      readonly source: PortSource;
      readonly usb: UsbIds | null;
      readonly expected: ArmFingerprint;
      readonly calibrationFile: Readonly<Record<string, MotorCalibration>> | null;
      readonly isHidden: boolean;
    }
  /** The operator's answer to the event "arming" of the request "enableReal" that waits for it. `requestId` is
   * that event's: an answer that names another request than the one that waits is refused with an error, so that
   * a confirmation shown for an earlier request cannot arm a later one. */
  | { readonly type: "arm"; readonly requestId: number; readonly isConfirmed: boolean };

export type StationRequestType = StationRequest["type"];

/** The control periods the loop began in the last second. */
export interface StepPeriods {
  /** How many periods. */
  readonly count: number;
  readonly meanMs: number;
  readonly maxMs: number;
  /** How many were longer than 25 ms. */
  readonly over25: number;
}

/** The control periods since the station was enabled. */
export interface PeriodsSince {
  /** How many periods: one fewer than the steps. */
  readonly count: number;
  readonly meanMs: number;
  readonly maxMs: number;
  /** How many were longer than 25 ms, and how many longer than 40 ms. */
  readonly over25: number;
  readonly over40: number;
}

/** What the Worker's clock has done since the station was enabled: `realTimeClock().stats()` of
 * src/station/joint/deadline_clock.ts, the times rounded to 0.001 ms. The timing self-check's sleeps are not in
 * it. */
export interface ClockNumbers {
  /** Sleeps that have ended. */
  readonly sleeps: number;
  /** Timers started: each one a sleep waited for. */
  readonly timers: number;
  /** Turns of the event loop taken in the rest of a wait. */
  readonly yields: number;
  /** Time spent in busy waits, ms. */
  readonly spinMs: number;
  /** How long after its hour a sleep ended, ms: the mean and the largest. */
  readonly lateMeanMs: number;
  readonly lateMaxMs: number;
  /** How long after its own hour a timer fired, ms: the largest (negative: every timer fired early); null when
   * no timer has fired. */
  readonly timerLateMaxMs: number | null;
  /** The clock's margin now, ms. */
  readonly marginMs: number;
}

/** The names of the clock's numbers, in the order the page shows them. */
export const CLOCK_NUMBERS = [
  "sleeps",
  "timers",
  "yields",
  "spinMs",
  "lateMeanMs",
  "lateMaxMs",
  "timerLateMaxMs",
  "marginMs",
] as const satisfies ReadonlyArray<keyof ClockNumbers>;

/** The wrist camera as the station sees it: the frames the window sent, by the Worker's clock. */
export interface CameraNumbers {
  /** Whether the window says its camera runs. */
  readonly isRunning: boolean;
  /** How many frames arrived in the last second. */
  readonly perSecond: number;
  /** How many frames arrived since the station was enabled. */
  readonly frames: number;
  /** How old the last frame was when this status was told, ms; null before the first. */
  readonly ageMs: number | null;
  /** The longest time between two frames' arrivals since the station was enabled, ms, counted only between frames
   * of one spell in which the window said that its camera runs; null before the second such frame. */
  readonly maxGapMs: number | null;
  /** How many of those times were over 200 ms: PEAR takes a frame for fresh up to 0.2 s after it arrived. */
  readonly gapsOver200: number;
}

/** What the station is and where the arm is, about ten times a second. */
export interface StationStatus {
  /** The robot's status: OFF, READY, BUSY or FAULT. */
  readonly robot: string;
  /** The control loop's state; null while the robot is off. */
  readonly control: string | null;
  readonly fault: string | null;
  readonly isSettled: boolean | null;
  readonly isReached: boolean | null;
  /** The measured joints, rad; null while the robot is off. */
  readonly joints: readonly number[] | null;
  /** What the loop holds or heads for, rad. */
  readonly targets: readonly number[] | null;
  /** What the model reads of the measured joints. */
  readonly state: ModelState | null;
  /** The text of the turn the model would be given now, with the report of the last action. */
  readonly turnText: string | null;
  readonly periods: StepPeriods;
  /** How many control periods the loop has begun since it was enabled. */
  readonly steps: number;
  /** The control periods since the station was enabled. */
  readonly since: PeriodsSince;
  /** What the Worker's clock has done since the station was enabled. */
  readonly clock: ClockNumbers;
  /** The wrist camera as the station sees it. No frame is in a status. */
  readonly camera: CameraNumbers;
  /** What is under way: "jog", "home" or nothing. */
  readonly action: "jog" | "home" | null;
  /** Whether the page is hidden: actions are refused. */
  readonly isHidden: boolean;
  /** Which arm the robot holds: the Worker's simulated one or a real one on its line; null while the robot is
   * off. */
  readonly arm: "simulated" | "real" | null;
  /** A real arm's line; null on the simulated arm and while the robot is off. */
  readonly line: RealLineStatus | null;
}

/** A real arm's line as the station has it: what its guard let through and refused, and whether it is there. */
export interface RealLineStatus {
  /** What the guard let through since the line was opened, counted by the instruction and, for a write, the
   * register's address: "PING", "READ", "SYNC READ", "WRITE 40", "SYNC WRITE 42". */
  readonly passed: Readonly<Record<string, number>>;
  /** How many packets the guard refused. A refused write was not sent: the control loop faults and the servos
   * keep the last goal that passed. Any number above 0 is a defect of the page or a servo that jumped. */
  readonly refused: number;
  /** The last refusals in words (English, as an error says them), the newest last; five at most. */
  readonly refusals: readonly string[];
  /** The line's errors since it was opened. */
  readonly lineErrors: number;
  /** Whether the port is lost (the cable, the adapter, the servos' supply to the adapter): the station cannot
   * reach the servos then, which keep their torque and hold their last goal until their power is cut. */
  readonly isLost: boolean;
}

/** One reason the timing self-check refuses to enable: which limit, what was measured, and the limit. */
export interface TimingFailure {
  readonly code: "period" | "over25" | "mean" | "read" | "unanswered" | "hidden";
  /** What was measured, ms or a count; null for a hidden page, which has no number. */
  readonly value: number | null;
  /** The limit the value is over; null for a hidden page. */
  readonly limit: number | null;
}

/** The timing self-check on the line before the torque is switched on: reads only. */
export interface TimingCheck {
  readonly periods: number;
  readonly meanMs: number;
  readonly maxMs: number;
  readonly over25: number;
  readonly maxReadMs: number;
  /** Why enabling is refused, as the Worker's error says it (English); empty when the check passed. */
  readonly failures: readonly string[];
  /** The same reasons with their numbers, for the page's sentence in the person's language. */
  readonly reasons: readonly TimingFailure[];
}

/** Where a preflight stopped before it had read everything. */
export type PreflightStop =
  /** The Worker's `navigator` has no `serial`. */
  | "no-serial"
  /** `getPorts()` gave no port (of the adapter's ids, when they are known). */
  | "no-port"
  /** It gave more than one such port: the API cannot tell them apart. */
  | "several-ports"
  /** The port did not open. */
  | "open-failed"
  /** Not six servos of the one model and one firmware. */
  | "handshake-failed"
  /** The six servos do not hold what the window read: another arm. */
  | "other-arm"
  /** The port was lost while it was read. */
  | "line-lost";

/** One servo as the preflight read it. Raw register values, as the servo gives them. */
export interface PreflightServo extends ServoPrint {
  /** The motor's name in PEAR's layout. */
  readonly name: string;
  /** The firmware as "major.minor". */
  readonly firmware: string;
  /** Present_Position (56) and Goal_Position (42), steps. */
  readonly position: number;
  readonly goal: number;
  /** Torque_Enable (40) and Lock (55). */
  readonly torque: number;
  readonly lock: number;
  /** Status (65): 0 is no error. */
  readonly status: number;
  /** Present_Voltage (62), tenths of a volt, and Present_Temperature (63), degrees Celsius. */
  readonly voltage: number;
  readonly temperature: number;
  /** Goal_Velocity (46) and Torque_Limit (48): RAM registers PEAR's enable never writes, so what another program
   * left in them stays. */
  readonly goalVelocity: number;
  readonly torqueLimit: number;
  /** Phase (18): PEAR's enable rewrites it when bit 0x10 is set. */
  readonly phase: number;
}

/** One register PEAR's enable writes to one servo, beside what that servo holds now. */
export interface PreflightSetting {
  readonly id: number;
  /** The register's name in lerobot's table, its address and its length. */
  readonly register: string;
  readonly address: number;
  readonly bytes: 1 | 2;
  /** Where the servo keeps it: "eeprom" survives a power cycle; "factory" is lerobot's name for the block of
   * Maximum_Acceleration, of which that is not known. */
  readonly area: "eeprom" | "ram" | "factory";
  /** The value PEAR's enable writes, and the value read. */
  readonly pear: number;
  readonly held: number;
}

/** What the Worker found on a real arm's line, by reads alone. */
export interface PreflightReport {
  /** What the Worker's `navigator.serial.getPorts()` gave, each port's USB ids (null: none given); null when the
   * Worker has no `navigator.serial`. */
  readonly ports: readonly (UsbIds | null)[] | null;
  /** Where it stopped; null: everything below was read. */
  readonly stop: PreflightStop | null;
  /** The stop in a sentence, English, as an error would say it; "" without a stop. */
  readonly detail: string;
  /** The six servos in the order of their ids; null when the handshake did not pass. */
  readonly servos: readonly PreflightServo[] | null;
  /** Every register PEAR's enable writes besides Goal_Position, Torque_Enable and Lock, for every servo it writes
   * it to; null with `servos`. */
  readonly settings: readonly PreflightSetting[] | null;
  /** As many single READs one after another as PEAR's enable has transactions while a servo is without torque:
   * how many, how long they took together and the longest one, ms; null when they were not made. */
  readonly singleReads: { readonly count: number; readonly totalMs: number; readonly maxMs: number } | null;
  /** The timing self-check on this line: 150 control periods, each one SYNC READ of the positions; null when it
   * was not run. Its `failures` say whether this line keeps the loop's time; a hidden page is one of them. */
  readonly timing: TimingCheck | null;
  /** What the read-only guard let through, counted by instruction, and how many packets it refused: 0, or the
   * preflight has a defect. */
  readonly guard: { readonly passed: Readonly<Record<string, number>>; readonly refused: number };
  /** The line's errors while the Worker had it open. */
  readonly lineErrors: number;
  /** Whether the Worker closed the port again: only then may the window read it. */
  readonly isClosed: boolean;
  /** How long the whole took, ms. */
  readonly tookMs: number;
}

/** A reason the station is not enabled on a real arm, found by reads before anything was written. A setting that
 * PEAR's enable would change is none: PEAR writes its settings at every enable whatever the servos hold. The
 * report's `settings` whose `held` is not `pear` are what it will change, those of the area "eeprom" for good; the
 * page lists them in the confirmation, and the operator's answer is given to that list. */
export type ArmingBlocker =
  /** The line was not read to its end: the report's `stop` and `detail` say where and why. */
  | { readonly code: "stop"; readonly stop: PreflightStop }
  /** The timing self-check failed on this line: the report's `timing.failures` say why. */
  | { readonly code: "timing" }
  /** Servos whose Status is not 0. */
  | { readonly code: "status"; readonly ids: readonly number[] }
  /** Servos whose Phase has the bit 0x10 set: PEAR's enable would rewrite that register, which is in the EEPROM. */
  | { readonly code: "phase"; readonly ids: readonly number[] }
  /** Servos that hold the factory's values (offset 0, range 0 to 4095) in place of a calibration. */
  | { readonly code: "uncalibrated"; readonly ids: readonly number[] }
  /** The loaded calibration file is not equal to what the Worker read of the servos: `detail` names the
   * differences. */
  | { readonly code: "calibration"; readonly detail: string }
  /** The guard refused packets while the line was only read: a defect of the page. */
  | { readonly code: "guard"; readonly refused: number };

/** How the request "enableReal" ended. */
export interface EnableRealResult {
  /** "enabled": the robot is open and holds the arm. "blocked": a reason among `blockers`; nothing was written.
   * "refused": the operator refused or did not answer; nothing was written. */
  readonly outcome: "enabled" | "blocked" | "refused";
  /** What was read before anything was written. Its `isClosed` says whether the Worker closed the port again:
   * false while the station holds the arm ("enabled"); after "blocked" and "refused" only true lets the window
   * read the port. */
  readonly report: PreflightReport;
  readonly blockers: readonly ArmingBlocker[];
  /** How long the robot took to open, ms: PEAR's enable, in which each servo is without torque for a moment;
   * null when it was not opened. */
  readonly openMs: number | null;
}

export interface EnableResult {
  readonly timing: TimingCheck;
  /** How long the robot took to open, ms. */
  readonly openMs: number;
}

export interface DisableResult {
  /** Where the simulated arm stands at the end, steps; empty for a real arm, which the window reads again. */
  readonly positions: MotorSteps;
  /** Whether the Worker holds no port now: true for the simulated arm; for a real arm whether its port closed.
   * Only then can the window read the port. */
  readonly isLineClosed: boolean;
}

/** What an action did: PEAR's record of its result and what the next turn would tell the model of it. */
export interface ActionReport {
  readonly record: Readonly<Record<string, unknown>>;
  /** The report of the result as the model reads it. */
  readonly feedback: string;
  /** The next turn's text: the state measured at the result, the reminder and the report. */
  readonly turnText: string | null;
}

export interface HomeResult {
  /** PEAR's Home report without its snapshots: the plan, the stages' names and the per-joint results. */
  readonly plan: Readonly<Record<string, unknown>>;
  readonly stages: readonly string[];
  readonly results: Readonly<Record<string, unknown>>;
}

export interface StationResults {
  enable: EnableResult;
  stop: null;
  disable: DisableResult;
  jog: ActionReport;
  home: HomeResult;
  approve: null;
  visibility: null;
  preflight: PreflightReport;
  enableReal: EnableRealResult;
  arm: null;
}

export type StationEvent =
  | { readonly type: "status"; readonly status: StationStatus }
  /** What the robot, its loop and its driver log as a warning or an error. */
  | { readonly type: "log"; readonly level: "warning" | "error"; readonly logger: string; readonly message: string }
  /** A phase of the action of the request `requestId`. */
  | { readonly type: "phase"; readonly requestId: number; readonly phase: string }
  /** The Home plan of the request `requestId`, which waits for the person's answer. */
  | { readonly type: "plan"; readonly requestId: number; readonly plan: Readonly<Record<string, unknown>> }
  /** The timing self-check's numbers, when it has run. */
  | { readonly type: "timing"; readonly timing: TimingCheck }
  /** What the Worker read of a real arm for the request `requestId` ("enableReal"), before anything is written:
   * a preflight's report, whose `isClosed` is false because the line is still open, and the reasons against
   * enabling. With no reason the Worker now waits for the request "arm"; with one it does not wait. */
  | {
      readonly type: "arming";
      readonly requestId: number;
      readonly report: PreflightReport;
      readonly blockers: readonly ArmingBlocker[];
    }
  /** The frame the observation of the request `requestId` held, told once: the JPEG's bytes as the observation
   * holds them, the frame's number among those the wrist camera has seen, and how old it was then, ms. */
  | { readonly type: "frame"; readonly requestId: number; readonly jpeg: Uint8Array; readonly number: number; readonly ageMs: number };

/** A request of the window, which the Worker answers once. */
export interface StationAsk {
  readonly id: number;
  readonly request: StationRequest;
}

/** What the window tells of its camera, unasked and unanswered. */
export type CameraTelling =
  /** The camera of the page runs, or it stopped. */
  | { readonly kind: "camera"; readonly isRunning: boolean }
  /** One frame as the JPEG a turn would send; its bytes are transferred to the Worker, not copied. */
  | { readonly kind: "frame"; readonly jpeg: ArrayBuffer };

/** What the window posts to the Worker. */
export type ToStation = StationAsk | CameraTelling;

/** What the Worker posts to the window. */
export type FromStation =
  | { readonly kind: "ready" }
  | { readonly kind: "reply"; readonly id: number; readonly isOk: true; readonly result: unknown }
  | { readonly kind: "reply"; readonly id: number; readonly isOk: false; readonly error: StationFailure }
  | { readonly kind: "event"; readonly event: StationEvent };

/** An error as the robot gives it: the Python class name and the message. */
export interface StationFailure {
  readonly name: string;
  readonly message: string;
}

/** How long the window waits for the answer to a request, ms. */
export const REQUEST_LIMIT_MS: Readonly<Record<StationRequestType, number>> = {
  enable: 25_000,
  stop: 3_000,
  disable: 8_000,
  jog: 60_000,
  home: 180_000,
  approve: 3_000,
  visibility: 3_000,
  preflight: 30_000,
  // the reads of a preflight, the operator's answer (ARMING_LIMIT_MS) and the robot's opening
  enableReal: 180_000,
  arm: 3_000,
};

/** How long the Worker waits for the operator's answer to the event "arming", ms; no answer counts as refused. */
export const ARMING_LIMIT_MS = 120_000;

/** How often the Worker tells its status, ms. */
export const STATUS_PERIOD_MS = 100;
