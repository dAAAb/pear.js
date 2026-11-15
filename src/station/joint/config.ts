// Ports pear/deploy/station/control/joint/config.py, with the `control` node of pear/configs/station.yaml (the
// control loop's settings every station starts from) and the placeholders that `BaseRobot.make_configs`
// (pear/deploy/station/control/robot.py) puts where a station leaves a value ???.
//
// A section is a class whose constructor takes the settings as a station's file holds them, under PEAR's keys, and
// refuses them as PEAR's dataclass refuses them in `__post_init__`: the same checks in the same order, with PEAR's
// messages. Like a dataclass, a section is checked when it is made and may be changed afterwards.

import { RuntimeError, ValueError } from "./errors";
import { JointLayout } from "./layout";
import { JointLimits, type ArmLimits, type MotionCaps } from "./limits";
import { pythonNumber } from "./numeric";

/** The bounds of `ConfigSection.checkRange`; one left out holds nothing. */
export interface RangeBounds {
  readonly above?: number;
  readonly atLeast?: number;
  readonly below?: number;
  readonly atMost?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof ConfigSection);
}

/** Returns a copy of plain settings: lists and objects copied, sections kept as they are. */
function copied(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(copied);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copied(child)]));
  }
  return value;
}

/** A section of a station's configuration, whose numbers are all finite. */
export abstract class ConfigSection {
  /** The name of PEAR's class of this section, with which its refusals begin. */
  protected abstract get className(): string;

  /** The section's fields in the order of PEAR's dataclass, which is the order they are checked in. */
  protected abstract get fieldNames(): readonly string[];

  /** The fields a station may leave out: PEAR's default for them is None. */
  protected get optionalFieldNames(): readonly string[] {
    return [];
  }

  /**
   * Takes each field from `settings` in PEAR's order and then checks the section. A field left out is null where
   * PEAR's default is None and refused otherwise (in pear.js's words: PEAR leaves that to OmegaConf).
   */
  protected constructor(settings: object) {
    this.take(settings);
    this.postInit();
  }

  /** Sets each field from `settings`, in PEAR's order. */
  private take(settings: object): void {
    const given = settings as Record<string, unknown>;
    const section = this as unknown as Record<string, unknown>;

    for (const name of this.fieldNames) {
      let value = given[name];
      if (value === undefined) {
        if (!this.optionalFieldNames.includes(name)) {
          throw new ValueError(`${this.className}.${name} is missing`);
        }
        value = null;
      }
      section[name] = this.fieldValue(name, copied(value));
    }
  }

  /** Returns the value the field `name` holds for the given `value`: a section's class makes its own sections. */
  protected fieldValue(_name: string, value: unknown): unknown {
    return value;
  }

  /** PEAR's `__post_init__`: throws unless the section's values are valid. */
  protected postInit(): void {
    const section = this as unknown as Record<string, unknown>;
    for (const name of this.fieldNames) {
      this.checkFinite(name, section[name]);
    }
  }

  /**
   * Throws unless every number of the field `name` lies within the bounds given (a field left null holds none). A
   * value that is not a number lies within no bound.
   */
  checkRange(name: string, bounds: RangeBounds): void {
    const value = (this as unknown as Record<string, unknown>)[name];
    const numbers: unknown[] = Array.isArray(value) ? value : value === null ? [] : [value];
    const checks: [string, (number: number, bound: number) => boolean, number | undefined][] = [
      ["greater than", (number, bound) => number > bound, bounds.above],
      ["at least", (number, bound) => number >= bound, bounds.atLeast],
      ["less than", (number, bound) => number < bound, bounds.below],
      ["at most", (number, bound) => number <= bound, bounds.atMost],
    ];

    for (const [words, isWithin, bound] of checks) {
      if (bound !== undefined && !numbers.every((number) => typeof number === "number" && isWithin(number, bound))) {
        // PEAR words the bound as Python prints it: a whole number as an int (every whole bound of PEAR's is one)
        throw new ValueError(`${this.className}.${name} must be ${words} ${pythonNumber(bound)}`);
      }
    }
  }

  /** Throws unless the field `name` holds `length` values (a field left null holds none). */
  checkLength(name: string, length: number): void {
    const value = (this as unknown as Record<string, unknown>)[name];
    if (value !== null && (value as ArrayLike<unknown>).length !== length) {
      const held = (value as ArrayLike<unknown>).length;
      throw new ValueError(`${this.className}.${name} must hold ${length} values, not ${held}`);
    }
  }

  /** Throws unless every number of `value`, the value of the field `name`, is finite. */
  checkFinite(name: string, value: unknown): void {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new ValueError(`${this.className}.${name} must be finite`);
    }

    const children = Array.isArray(value) ? value : isPlainObject(value) ? Object.values(value) : [];
    for (const child of children) {
      this.checkFinite(name, child);
    }
  }

  /** Returns the section as plain settings under PEAR's keys, its sections as plain settings too (`asdict`). */
  asDict(): Record<string, unknown> {
    const plain = (value: unknown): unknown => {
      if (value instanceof ConfigSection) {
        return value.asDict();
      }
      if (Array.isArray(value)) {
        return value.map(plain);
      }
      if (isPlainObject(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]));
      }
      return value;
    };
    const section = this as unknown as Record<string, unknown>;

    return Object.fromEntries(this.fieldNames.map((name) => [name, plain(section[name])]));
  }
}

/** The settings of the joints' control loop: the `control` node of a station's configuration. */
export interface ControlSettings {
  /** Control periods a second. */
  readonly rate_hz: number;
  /** The age past which a reading of the joints is stale, s. */
  readonly state_timeout_s: number;
  /** How late a sequence of targets may run, s; no limit of the gap between two control periods. */
  readonly deadline_tolerance_s: number;
  /** The longest wait for the arms to come to rest, s. */
  readonly settle_timeout_s: number;
  /** The readings a judgement of rest looks back over, s. */
  readonly settle_window_s: number;
  /** The longest gap between two targets of a sequence, s. */
  readonly action_timeout_s: number;
}

/** What every station of PEAR starts from: the `control` node of pear/configs/station.yaml. */
export const DEFAULT_CONTROL_SETTINGS: ControlSettings = Object.freeze({
  rate_hz: 50,
  state_timeout_s: 0.1,
  deadline_tolerance_s: 0.05,
  settle_timeout_s: 3,
  settle_window_s: 0.5,
  action_timeout_s: 0.5,
});

/** The settings of the joints' control loop, checked. */
export class ControlConfig extends ConfigSection implements ControlSettings {
  declare rate_hz: number;
  declare state_timeout_s: number;
  declare deadline_tolerance_s: number;
  declare settle_timeout_s: number;
  declare settle_window_s: number;
  declare action_timeout_s: number;

  constructor(settings: ControlSettings = DEFAULT_CONTROL_SETTINGS) {
    super(settings);
  }

  protected get className(): string {
    return "ControlConfig";
  }

  protected get fieldNames(): readonly string[] {
    return [
      "rate_hz",
      "state_timeout_s",
      "deadline_tolerance_s",
      "settle_timeout_s",
      "settle_window_s",
      "action_timeout_s",
    ];
  }

  protected override postInit(): void {
    super.postInit();

    this.checkRange("rate_hz", { above: 0, atMost: 100 });
    this.checkRange("state_timeout_s", { above: 0, atMost: 1 });
    this.checkRange("deadline_tolerance_s", { above: 0, atMost: 1 });
    this.checkRange("settle_timeout_s", { above: 0 });
    this.checkRange("settle_window_s", { above: 0 });
    this.checkRange("action_timeout_s", { above: 0, atMost: 5 });
    if (!(this.settle_window_s < this.settle_timeout_s)) {
      throw new ValueError("settle_timeout_s must exceed settle_window_s");
    }
  }

  /** The length of one control period, s. */
  get controlPeriodS(): number {
    return 1 / this.rate_hz;
  }
}

/** The velocity, acceleration and jerk caps of one arm's coordinates, as a station's file holds them. */
export interface MotionLimitSettings {
  readonly velocity: readonly number[];
  readonly acceleration: readonly number[];
  readonly jerk: readonly number[];
}

/** The velocity, acceleration and jerk caps of one arm's coordinates. */
export class MotionLimits extends ConfigSection implements MotionLimitSettings, MotionCaps {
  declare velocity: number[];
  declare acceleration: number[];
  declare jerk: number[];

  constructor(settings: MotionLimitSettings) {
    super(settings);
  }

  protected get className(): string {
    return "MotionLimits";
  }

  protected get fieldNames(): readonly string[] {
    return ["velocity", "acceleration", "jerk"];
  }

  protected override postInit(): void {
    super.postInit();

    if ([this.velocity, this.acceleration, this.jerk].some((caps) => caps.some((cap) => !(cap > 0)))) {
      throw new ValueError("Motion limits must be positive");
    }
  }

  /** Throws unless every vector holds one value for each of an arm's `coordinateCount` coordinates. */
  checkLengths(coordinateCount: number): void {
    for (const name of this.fieldNames) {
      this.checkLength(name, coordinateCount);
    }
  }
}

/** One arm's limits, as a station's file holds them. */
export interface LimitSettings extends MotionLimitSettings {
  readonly lower_bounds: readonly number[];
  readonly upper_bounds: readonly number[];
  readonly tracking_error: readonly number[];
}

/** One arm's limits: its motion caps, its position bounds and how far a joint may be from its target. */
export class Limits extends MotionLimits implements LimitSettings, ArmLimits {
  declare lower_bounds: number[];
  declare upper_bounds: number[];
  declare tracking_error: number[];

  constructor(settings: LimitSettings) {
    super(settings);
  }

  protected override get className(): string {
    return "Limits";
  }

  protected override get fieldNames(): readonly string[] {
    return ["velocity", "acceleration", "jerk", "lower_bounds", "upper_bounds", "tracking_error"];
  }

  protected override postInit(): void {
    super.postInit();

    const paired = Math.min(this.lower_bounds.length, this.upper_bounds.length);
    for (let index = 0; index < paired; index++) {
      if (!(this.lower_bounds[index]! < this.upper_bounds[index]!)) {
        throw new ValueError("Every lower limit must be below its upper limit");
      }
    }
    if (this.tracking_error.some((trackingBound) => !(trackingBound > 0))) {
      throw new ValueError("Tracking bounds must be positive");
    }
  }

  /** Returns the acceleration and jerk caps a controlled STOP brakes with (by default a move's). */
  brakingCaps(): [readonly number[], readonly number[]] {
    return [this.acceleration, this.jerk];
  }
}

/** What every robot's Home holds besides its pose, as a station's file holds it. */
export interface HomeSettings {
  /** The share of the move caps a return to Home uses. */
  readonly speed_scale: number;
  /** The caps of a return, one arm's for every arm; null or absent: the move caps. */
  readonly limits?: MotionLimitSettings | null;
  /** The readings Home's own judgement of arrival looks back over, s. */
  readonly settle_window_s: number;
  /** The longest wait after the move for the arms to arrive at Home, s. */
  readonly arrival_timeout_s: number;
}

/** What every robot's Home holds besides its pose: how fast the arms return and when they have arrived. */
export class HomeConfig extends ConfigSection implements HomeSettings {
  declare speed_scale: number;
  declare limits: MotionLimits | null;
  declare settle_window_s: number;
  declare arrival_timeout_s: number;

  constructor(settings: HomeSettings) {
    super(settings);
  }

  protected get className(): string {
    return "HomeConfig";
  }

  protected get fieldNames(): readonly string[] {
    return ["speed_scale", "limits", "settle_window_s", "arrival_timeout_s"];
  }

  protected override get optionalFieldNames(): readonly string[] {
    return ["limits"];
  }

  protected override fieldValue(name: string, value: unknown): unknown {
    if (name === "limits" && value !== null && !(value instanceof MotionLimits)) {
      return new MotionLimits(value as MotionLimitSettings);
    }
    return value;
  }

  protected override postInit(): void {
    super.postInit();

    this.checkRange("speed_scale", { above: 0, atMost: 1 });
    this.checkRange("settle_window_s", { above: 0 });
    this.checkRange("arrival_timeout_s", { above: 0 });
  }
}

/** What the settings of every robot hold for its joints' control, as a station's file holds them. */
export interface RobotSettings {
  /** How close an arm joint is to its target at an arrival, rad. */
  readonly position_tolerance: number;
  /** How close a gripper's opening is to its target at an arrival. */
  readonly gripper_tolerance: number;
  /** How far measured feedback may rest outside the position bounds. */
  readonly feedback_position_tolerance: number;
  /** The mean speed below which a coordinate is at rest. */
  readonly velocity_tolerance: number;
  /** The Home pose and how the arms return to it; null or absent: the robot has none. */
  readonly home?: HomeSettings | null;
}

/**
 * What the settings of every robot hold for its joints' control: its tolerances, its Home and its arms' limits. A
 * robot's own class adds its sections, names its layout and its arms' limits, and says what keeps its arms from
 * moving.
 */
export abstract class RobotConfig extends ConfigSection {
  /** What OmegaConf's marker of a value a station must give reads as in a file: `???`. */
  static readonly MISSING = "???";
  /** What a value the station leaves ??? reads as: a template's placeholder, which the motion blockers name. */
  static readonly PLACEHOLDER = "<{key}>";

  declare position_tolerance: number;
  declare gripper_tolerance: number;
  declare feedback_position_tolerance: number;
  declare velocity_tolerance: number;
  declare home: HomeConfig | null;

  /** The robot's joint vector, which the vectors of its settings follow. */
  abstract get LAYOUT(): JointLayout;

  /** Returns the limits of each arm the settings name, by the arm's name. */
  abstract armLimits(): Record<string, Limits>;

  /** Returns the reasons the real arms must not move under these settings. */
  abstract motionBlockers(): string[];

  protected override get optionalFieldNames(): readonly string[] {
    return ["home"];
  }

  protected override fieldValue(name: string, value: unknown): unknown {
    if (name === "home" && value !== null && !(value instanceof HomeConfig)) {
      return new HomeConfig(value as HomeSettings);
    }
    return value;
  }

  protected override postInit(): void {
    super.postInit();

    this.checkRange("position_tolerance", { above: 0 });
    this.checkRange("gripper_tolerance", { above: 0, atMost: 0.2 });
    this.checkRange("feedback_position_tolerance", { above: 0 });
    this.checkRange("velocity_tolerance", { above: 0 });

    const layout = this.LAYOUT;
    for (const limits of Object.values(this.armLimits())) {
      limits.checkLengths(layout.coordinateCount);
      const lowestOpening = JointLayout.gripperValue(limits.lower_bounds);
      const highestOpening = JointLayout.gripperValue(limits.upper_bounds);
      if (!(lowestOpening >= 0) || !(highestOpening <= 1)) {
        throw new ValueError("Gripper limits must lie within [0, 1]");
      }
    }
    if (this.home !== null && this.home.limits !== null) {
      this.home.limits.checkLengths(layout.coordinateCount);
    }
  }

  /** Refuses real motion while the settings still list a reason against it. */
  requireCommissioned(): void {
    const blockers = this.motionBlockers();
    if (blockers.length > 0) {
      throw new RuntimeError(`Real motion is not commissioned:\n${blockers.join("\n")}`);
    }
  }

  /**
   * Returns the dotted key of the first value that is still a template's placeholder, in the order of the settings;
   * null when there is none.
   */
  firstPlaceholder(): string | null {
    return RobotConfig.placeholderKey(this.asDict(), "");
  }

  /** Returns the arms' limits as the limits of the joint vector, arm after arm. */
  jointLimits(): JointLimits {
    const armLimits = this.armLimits();

    return JointLimits.fromArms(
      this.LAYOUT.arms.map((arm) => armLimits[arm] as Limits),
      this.feedback_position_tolerance,
    );
  }

  /** Whether `arm` receives the planned joint velocity with each moving command (by default every arm). */
  feedsVelocity(_arm: string): boolean {
    return true;
  }

  /**
   * Returns the dotted key, under `key`, of the first text in `value` that is a placeholder, <...>; null when there
   * is none.
   */
  static placeholderKey(value: unknown, key: string): string | null {
    if (typeof value === "string") {
      return value.startsWith("<") && value.endsWith(">") ? key : null;
    }

    let children: [string, unknown][];
    if (Array.isArray(value)) {
      children = value.map((child, index) => [key ? `${key}.${index}` : String(index), child]);
    } else if (typeof value === "object" && value !== null) {
      children = Object.entries(value).map(([childKey, child]) => [key ? `${key}.${childKey}` : childKey, child]);
    } else {
      return null;
    }

    for (const [childKey, child] of children) {
      const childPlaceholderKey = RobotConfig.placeholderKey(child, childKey);
      if (childPlaceholderKey) {
        return childPlaceholderKey;
      }
    }

    return null;
  }

  /**
   * Returns a copy of the plain `settings` in which every value a station left ??? is the placeholder of its dotted
   * key, as `BaseRobot.make_configs` makes a robot's settings: `<hardware.port>`. A robot's class takes its settings
   * through this, so that its motion blockers name what the station has not given.
   */
  static withPlaceholders<Settings>(settings: Settings): Settings {
    const filled = (value: unknown, key: string): unknown => {
      if (value === RobotConfig.MISSING) {
        return RobotConfig.PLACEHOLDER.replace("{key}", key);
      }
      if (Array.isArray(value)) {
        return value.map((child, index) => filled(child, `${key}[${index}]`));
      }
      if (isPlainObject(value)) {
        return Object.fromEntries(
          Object.entries(value).map(([childKey, child]) => [
            childKey,
            filled(child, key ? `${key}.${childKey}` : childKey),
          ]),
        );
      }
      return value;
    };

    return filled(settings, "") as Settings;
  }
}
