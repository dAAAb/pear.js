// The messages between the window and the Worker that runs the station (station_worker.ts): the robot, its
// control loop, its driver and the arm's line live in the Worker, and the window only asks and is told.
//
// A request carries an id and is answered once, by a reply with that id: a result, or an error with the Python
// class name and the message as the robot gives them. What the Worker tells unasked is an event.

import type { ModelState } from "../../src/so101/kinematics/index";

/** Where each servo of the simulated arm stands, steps, by the motor's name. */
export type MotorSteps = Readonly<Record<string, number>>;

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
  | { readonly type: "visibility"; readonly isHidden: boolean };

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
  /** What is under way: "jog", "home" or nothing. */
  readonly action: "jog" | "home" | null;
  /** Whether the page is hidden: actions are refused. */
  readonly isHidden: boolean;
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

export interface EnableResult {
  readonly timing: TimingCheck;
  /** How long the robot took to open, ms. */
  readonly openMs: number;
}

export interface DisableResult {
  /** Where the simulated arm stands at the end, steps. */
  readonly positions: MotorSteps;
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
  | { readonly type: "timing"; readonly timing: TimingCheck };

/** What the window posts to the Worker. */
export interface ToStation {
  readonly id: number;
  readonly request: StationRequest;
}

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
};

/** How often the Worker tells its status, ms. */
export const STATUS_PERIOD_MS = 100;
