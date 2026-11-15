// Ports pear/deploy/station/control/joint/stability.py.
//
// The sums are numpy's: a mean over the samples of a window adds them in their order, so the metrics are PEAR's to
// the last bit and a value at a tolerance falls on PEAR's side of it.

import { formatFixed } from "../../so101/kinematics/text";
import type { SampleId } from "../schemas";
import { ArmState } from "./arm_state";
import type { MonotonicClock } from "./clock";
import type { ControlSettings } from "./config";
import { realTimeClock } from "./deadline_clock";
import { IndexError, PythonTypeError, RuntimeError, ValueError } from "./errors";
import { JointLayout } from "./layout";
import { broadcastTo, maximum, minimum, pythonMin, pythonStr } from "./numeric";

/** One coordinate beyond a limit of a stability window: its arm when the robot has several, itself, and the measure. */
export interface StabilityViolation {
  side?: string;
  joint: string;
  /** The metric's key in the window's metrics. */
  metric: string;
  value: number;
  limit: number;
  units: string;
}

/** What a stability window measured, under PEAR's keys; empty before the first reading and after a reset. */
export interface StabilityMetrics {
  /** The span of the samples judged, s. */
  window_seconds?: number;
  samples?: number;
  stable?: boolean;
  /** Of every coordinate of the arms judged, arm after arm; present once the window is complete. */
  position_span?: number[];
  velocity_mean?: number[];
  velocity_rms?: number[];
  violations?: StabilityViolation[];
  /** Per arm, each coordinate's largest distance from its target over the window; present when targets were given. */
  target_error_max?: Record<string, number[]>;
}

/** What a fault records about a failed settling. */
export interface StabilityDetails {
  code: string;
  reason: string;
  message: string;
  metrics: StabilityMetrics;
}

/** Raised when measured settling failed; it carries the stability window's metrics. */
export class StabilityError extends RuntimeError {
  override readonly name: string = "StabilityError";

  readonly reason: string;
  readonly metrics: StabilityMetrics;

  constructor(reason: string, metrics: StabilityMetrics) {
    const violationText =
      (metrics.violations ?? [])
        .map(
          (violation) =>
            `${JointLayout.axisName(violation as unknown as Record<string, unknown>)} ${violation.metric}=` +
            `${formatFixed(violation.value, 6)} > ${formatFixed(violation.limit, 6)} ${violation.units}`,
        )
        .join("; ") || "insufficient fresh samples for a complete stability window";
    super(
      `${reason}: ${violationText} (window=${formatFixed(metrics.window_seconds ?? 0, 3)}s, ` +
        `samples=${pythonStr(metrics.samples ?? 0)})`,
    );

    this.reason = reason;
    this.metrics = structuredClone(metrics);
  }

  /** What a fault records about this failure. */
  get details(): StabilityDetails {
    return {
      code: this.name,
      reason: this.reason,
      message: this.message,
      metrics: structuredClone(this.metrics),
    };
  }
}

/** One reading of a sample window. */
export interface WindowSample<Value> {
  /** The local monotonic time of the reading, s. */
  readonly sampledMonotonicS: number;
  /** What the window's user keeps of the reading. */
  readonly value: Value;
}

/** What a stability window keeps of one reading of an arm. */
export interface ArmReading {
  readonly position: readonly number[];
  readonly velocity: readonly number[];
}

/**
 * The recent readings of one arm that are new and unbroken: a repeated reading adds nothing, and a gap between two
 * starts the window over.
 */
export class SampleWindow<Value = unknown> {
  /** The fewest samples a complete window holds. */
  static readonly MIN_SAMPLES = 3;
  /** Of a window's control periods that must bring a new sample. */
  static readonly FRESH_FRACTION = 0.8;

  /** The samples kept, the oldest first. */
  readonly samples: WindowSample<Value>[] = [];
  /** Of the reading added last: its sample id, or its stamp when it has none. */
  lastIdentity: number | string | null = null;

  /**
   * `historyS` is how far back of the latest sample the window keeps samples; with `checksStampOrder` a reading
   * stamped no later than the last one also starts the window over, as a gap does.
   */
  constructor(
    readonly controlConfig: Pick<ControlSettings, "state_timeout_s">,
    readonly historyS: number,
    readonly checksStampOrder = true,
  ) {}

  /** Adds a reading unless it repeats the one added last, and returns whether it was new. */
  add(sampledMonotonicS: number, sampleId: SampleId | undefined, value: Value): boolean {
    const identity = sampleId == null ? sampledMonotonicS : sampleId;
    if (identity === this.lastIdentity) {
      return false;
    }

    const samples = this.samples;
    if (samples.length > 0) {
      const lastStamp = samples[samples.length - 1]!.sampledMonotonicS;
      if (
        (this.checksStampOrder && sampledMonotonicS <= lastStamp) ||
        sampledMonotonicS - lastStamp > this.controlConfig.state_timeout_s
      ) {
        samples.length = 0;
      }
    }
    this.lastIdentity = identity;
    samples.push({ sampledMonotonicS, value });
    while (samples.length > 1 && samples[1]!.sampledMonotonicS <= sampledMonotonicS - this.historyS) {
      samples.shift();
    }

    return true;
  }

  /** Forgets every reading. */
  clear(): void {
    this.samples.length = 0;
    this.lastIdentity = null;
  }

  /** Returns the samples of the last `durationS`, with the one before them that starts that span. */
  recent(durationS: number): WindowSample<Value>[] {
    const samples = this.samples.slice();
    let startIndex = 0;
    while (
      startIndex + 1 < samples.length &&
      samples[startIndex + 1]!.sampledMonotonicS <= samples[samples.length - 1]!.sampledMonotonicS - durationS
    ) {
      startIndex += 1;
    }

    return samples.slice(startIndex);
  }

  /** Whether `samples` span `durationS` with enough new samples for a control loop of `rateHz`. */
  static isComplete(samples: readonly WindowSample<unknown>[], durationS: number, rateHz: number): boolean {
    if (samples.length === 0) {
      throw new IndexError("list index out of range");
    }
    const elapsedS = samples[samples.length - 1]!.sampledMonotonicS - samples[0]!.sampledMonotonicS;
    const minSampleN = Math.max(SampleWindow.MIN_SAMPLES, Math.ceil(durationS * rateHz * SampleWindow.FRESH_FRACTION));

    return elapsedS >= durationS && samples.length >= minSampleN;
  }
}

/** What a stability window reads of the control loop's settings. */
export type StabilityControlSettings = Pick<
  ControlSettings,
  "rate_hz" | "state_timeout_s" | "settle_timeout_s" | "settle_window_s"
>;

/** What a stability window reads of a robot's settings (a RobotConfig is one). */
export interface StabilityRobotSettings {
  readonly LAYOUT: JointLayout;
  readonly velocity_tolerance: number;
  readonly position_tolerance: number;
  readonly home?: { readonly settle_window_s: number } | null;
}

/** What a stability window reads of one arm's feedback in a snapshot. */
export interface StabilityFeedback {
  readonly position: ArrayLike<number>;
  readonly velocity: ArrayLike<number>;
  readonly sampled_monotonic_s: number;
  readonly sample_id?: SampleId;
}

/** What a stability window reads of a snapshot: every arm's feedback. */
export interface StabilitySnapshot {
  readonly arms: Readonly<Record<string, StabilityFeedback>>;
}

export interface StabilityWindowOptions {
  /** The readings a judgement looks back over, s. */
  readonly durationS: number;
  /** Whether the position span (and, with `checksVelocityRms`, the velocity RMS) is bounded too. */
  readonly isStrict: boolean;
  readonly checksVelocityRms: boolean;
}

/** Which window of the kept history `evaluate` judges; a value left out or null is the window's own. */
export interface StabilityCriteria {
  readonly arms?: readonly string[] | null;
  readonly durationS?: number | null;
  /** Per arm, the position each coordinate is judged against, as Home gives it. */
  readonly targets?: Readonly<Record<string, ArrayLike<number>>> | null;
  /** How far a coordinate may be from its target: one value, or one for each coordinate of an arm. */
  readonly positionTolerance?: number | ArrayLike<number> | null;
}

/** Measured settling: the mean signed velocity of each arm over its fresh feedback. */
export class StabilityWindow {
  // the metrics, each by its key in the window's metrics and by the metric a violation names
  static readonly VELOCITY_MEAN = "velocity_mean";
  static readonly VELOCITY_RMS = "velocity_rms";
  static readonly POSITION_SPAN = "position_span";
  static readonly TARGET_ERROR_MAX = "target_error_max";
  /** After the unit of a coordinate, the unit of its velocity. */
  static readonly RATE_SUFFIX = "/s";

  readonly layout: JointLayout;
  durationS: number;
  isStrict: boolean;
  /** Whether a strict window also bounds the velocity RMS. */
  readonly checksVelocityRms: boolean;
  metrics: StabilityMetrics = {};

  /** The history kept: enough for every window read from it, Home's own among them. */
  private readonly historyS: number;
  /** Arms report apart, so each keeps its own samples. */
  private readonly sampleWindows: Record<string, SampleWindow<ArmReading>>;
  private holdUnstableSince: number | null = null;

  constructor(
    readonly controlConfig: StabilityControlSettings,
    readonly robotConfig: StabilityRobotSettings,
    options: StabilityWindowOptions,
    private readonly clock: MonotonicClock = realTimeClock(),
  ) {
    this.layout = robotConfig.LAYOUT;
    this.durationS = options.durationS;
    this.isStrict = options.isStrict;
    this.checksVelocityRms = options.checksVelocityRms;
    const home = robotConfig.home;
    this.historyS = Math.max(options.durationS, controlConfig.settle_window_s, home ? home.settle_window_s : 0);
    this.sampleWindows = Object.fromEntries(
      this.layout.arms.map((arm) => [arm, new SampleWindow<ArmReading>(controlConfig, this.historyS)]),
    );
  }

  /**
   * Adds `snapshot` during a HOLD and returns whether the window is stable; throws once the arms stay unstable past
   * the settle timeout.
   */
  checkHold(snapshot: StabilitySnapshot): boolean {
    const isStable = this.add(snapshot);
    const now = this.clock.monotonic();

    if (isStable) {
      this.holdUnstableSince = null;
    } else if (this.holdUnstableSince === null) {
      this.holdUnstableSince = now;
    } else if (now - this.holdUnstableSince > this.controlConfig.settle_timeout_s) {
      throw this.stabilityError("Persistent motion during HOLD");
    }

    return isStable;
  }

  /** Adds each arm's new sample of `snapshot` and returns whether the window is now stable. */
  add(snapshot: StabilitySnapshot): boolean {
    const now = this.clock.monotonic();
    const armFeedback = snapshot.arms;
    const arms = this.layout.arms;
    const sampleTimes = arms.map((arm) => (armFeedback[arm] as StabilityFeedback).sampled_monotonic_s);
    const stateTimeoutS = this.controlConfig.state_timeout_s;
    if (
      sampleTimes.some(
        (sampleTime) =>
          !Number.isFinite(sampleTime) || sampleTime > now + ArmState.CLOCK_SLACK_S || now - sampleTime > stateTimeoutS,
      )
    ) {
      this.reset();
      throw new RuntimeError("Stale/invalid stability feedback");
    }

    // arms report independently: a repeated sample of one must neither count again nor hide another's new one
    const coordinateCount = this.layout.coordinateCount;
    arms.forEach((arm, armIndex) => {
      const feedback = armFeedback[arm] as StabilityFeedback;
      const position = Array.from(feedback.position);
      const velocity = Array.from(feedback.velocity);
      if (
        position.length !== coordinateCount ||
        velocity.length !== coordinateCount ||
        !position.every(Number.isFinite) ||
        !velocity.every(Number.isFinite)
      ) {
        throw new ValueError("Invalid settling feedback");
      }
      this.sampleWindows[arm]!.add(sampleTimes[armIndex]!, feedback.sample_id, { position, velocity });
    });

    this.metrics = this.evaluate();

    return this.metrics.stable as boolean;
  }

  /**
   * Returns the metrics of a window of the kept history, without sampling again: of `arms` over `durationS` (by
   * default every arm over the window's own), against `targets` too when Home gives them.
   */
  evaluate(criteria: StabilityCriteria = {}): StabilityMetrics {
    const arms = criteria.arms == null ? this.layout.arms : [...criteria.arms];
    const durationS = criteria.durationS == null ? this.durationS : criteria.durationS;
    const targets = criteria.targets ?? null;
    if (
      arms.length === 0 ||
      arms.some((arm) => !this.layout.arms.includes(arm)) ||
      !(0 < durationS && durationS <= this.historyS)
    ) {
      throw new ValueError("Invalid stability window selection");
    }

    const windows = arms.map((arm) => this.sampleWindows[arm]!.recent(durationS));
    if (!windows.every((window) => window.length > 0)) {
      return { window_seconds: 0.0, samples: 0, stable: false };
    }

    const elapsedS = windows
      .map((window) => window[window.length - 1]!.sampledMonotonicS - window[0]!.sampledMonotonicS)
      .reduce(pythonMin);
    const sampleCount = Math.min(...windows.map((window) => window.length));
    const metrics: StabilityMetrics = { window_seconds: elapsedS, samples: sampleCount, stable: false };
    const controlConfig = this.controlConfig;
    if (
      !windows.every((window) => SampleWindow.isComplete(window, durationS, controlConfig.rate_hz)) ||
      windows.some(
        (window) =>
          !ArmState.isFresh(
            this.clock.monotonic() - window[window.length - 1]!.sampledMonotonicS,
            controlConfig.state_timeout_s,
            ArmState.CLOCK_SLACK_S,
          ),
      )
    ) {
      return metrics;
    }

    // each coordinate's values over a window's samples, reduced in the samples' order as numpy reduces them
    const coordinateCount = this.layout.coordinateCount;
    const positionSpan: number[] = [];
    const velocityMean: number[] = [];
    const velocityRms: number[] = [];
    for (const window of windows) {
      for (let coordinate = 0; coordinate < coordinateCount; coordinate++) {
        const first = window[0]!.value;
        let highest = first.position[coordinate]!;
        let lowest = highest;
        let sum = first.velocity[coordinate]!;
        let squares = sum * sum;
        for (let sample = 1; sample < window.length; sample++) {
          const { position, velocity } = window[sample]!.value;
          highest = maximum(highest, position[coordinate]!);
          lowest = minimum(lowest, position[coordinate]!);
          sum += velocity[coordinate]!;
          squares += velocity[coordinate]! * velocity[coordinate]!;
        }
        positionSpan.push(highest - lowest);
        velocityMean.push(Math.abs(sum / window.length));
        velocityRms.push(Math.sqrt(squares / window.length));
      }
    }

    const velocityTolerance = this.robotConfig.velocity_tolerance;
    const rateSuffix = StabilityWindow.RATE_SUFFIX;
    const violations = this.violations(
      arms,
      StabilityWindow.VELOCITY_MEAN,
      velocityMean,
      velocityTolerance,
      rateSuffix,
    );
    if (this.isStrict) {
      // position span and velocity RMS count only here: a recovery must not mistake alternating motion for a
      // stationary arm
      if (this.checksVelocityRms) {
        violations.push(
          ...this.violations(arms, StabilityWindow.VELOCITY_RMS, velocityRms, velocityTolerance, rateSuffix),
        );
      }
      violations.push(
        ...this.violations(arms, StabilityWindow.POSITION_SPAN, positionSpan, this.robotConfig.position_tolerance, ""),
      );
    }

    const targetErrorMaxima: Record<string, number[]> = {};
    if (targets !== null) {
      const positionTolerance = criteria.positionTolerance ?? null;
      const tolerance = positionTolerance === null ? null : broadcastTo(positionTolerance, coordinateCount);
      arms.forEach((arm, armIndex) => {
        const window = windows[armIndex]!;
        const target = targets[arm] as ArrayLike<number>;
        if (target.length !== coordinateCount && target.length !== 1) {
          const shape = `(${window.length},${coordinateCount})`;
          throw new ValueError(`operands could not be broadcast together with shapes ${shape} (${target.length},) `);
        }
        const targetErrors: number[] = [];
        for (let coordinate = 0; coordinate < coordinateCount; coordinate++) {
          const targetValue = target[target.length === 1 ? 0 : coordinate]!;
          targetErrors.push(
            window
              .map((sample) => Math.abs(sample.value.position[coordinate]! - targetValue))
              .reduce((largest, error) => maximum(largest, error)),
          );
        }
        targetErrorMaxima[arm] = targetErrors;
        if (tolerance === null) {
          // numpy compares each error with None
          throw new PythonTypeError("'>' not supported between instances of 'float' and 'NoneType'");
        }
        violations.push(...this.violations([arm], StabilityWindow.TARGET_ERROR_MAX, targetErrors, tolerance, ""));
      });
    }

    metrics.position_span = positionSpan;
    metrics.velocity_mean = velocityMean;
    metrics.velocity_rms = velocityRms;
    metrics.violations = violations;
    if (targets !== null) {
      metrics.target_error_max = targetErrorMaxima;
    }
    metrics.stable = violations.length === 0;

    return metrics;
  }

  /** Requires a new complete window, after the caller's readiness condition failed. */
  reset(): void {
    for (const sampleWindow of Object.values(this.sampleWindows)) {
      sampleWindow.clear();
    }
    this.metrics = {};
    this.holdUnstableSince = null;
  }

  /** Makes a strict window a plain one of `durationS`, with the history it has. */
  relax(durationS: number): void {
    this.durationS = durationS;
    this.isStrict = false;
  }

  /** Returns a StabilityError of `reason` that carries this window's metrics. */
  stabilityError(reason: string): StabilityError {
    return new StabilityError(reason, { ...this.metrics });
  }

  /**
   * Returns one violation for each value of the selected `arms` beyond its limit; `unitSuffix` follows the
   * coordinate's unit.
   */
  private violations(
    arms: readonly string[],
    metric: string,
    values: readonly number[],
    limit: number | readonly number[],
    unitSuffix: string,
  ): StabilityViolation[] {
    const coordinateCount = this.layout.coordinateCount;
    const limits = broadcastTo(limit, values.length);

    return values.flatMap((value, index) =>
      value > limits[index]!
        ? [
            {
              ...this.layout.armAxisLabels(arms[Math.floor(index / coordinateCount)]!, index % coordinateCount),
              metric,
              value,
              limit: limits[index]!,
              units: this.layout.axisUnit(index) + unitSuffix,
            } as StabilityViolation,
          ]
        : [],
    );
  }
}
