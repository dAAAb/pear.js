// Ports the stand-ins of PEAR's tests of the control loop, on which the fixtures were recorded:
// tests/deploy/station/control_rig.py (StandInClock), tests/deploy/station/stand_in_joint_driver.py
// (StandInJointDriver with YAM's reading, StandInSO101Arm, StandInSO101Driver) and the MemoryDriver of
// tests/deploy/station/test_joint_control_in_station.py; with the Probe of tools/fixtures/loop_fixtures.py, which
// records the loop's calls of its driver and makes the driver misbehave as a scenario scripts it.
//
// PEAR's StandInSO101Driver is its real SO101Driver over the stand-in arm, without the feedforward; so is the one
// here: src/so101/hardware's SO101Driver (the glitch it tolerates, the offset it does not send again) over the
// stand-in arm, whose readings are the hardware layer's SO101ArmState and whose servo fault is its ServoFault.

import { OSError } from "../../src/python/errors";
import type { SO101RobotConfig } from "../../src/so101/config";
import { ServoFault, SO101ArmState, type ServoStatus } from "../../src/so101/hardware/arm_state";
import { SO101Driver, type ArmHardware } from "../../src/so101/hardware/driver";
import { GRIPPER_INDEX, VECTOR_LENGTH } from "../../src/so101/layout";
import { ArmState } from "../../src/station/joint/arm_state";
import type { MonotonicClock } from "../../src/station/joint/clock";
import { JointDriver, type ArmVectors } from "../../src/station/joint/driver";
import { RuntimeError, TimeoutError, ValueError } from "../../src/station/joint/errors";
import type { JointLayout } from "../../src/station/joint/layout";
import type { ArmFeedback, SampleId } from "../../src/station/schemas";

/** The age of a stale reading of a stand-in's arm, s. */
export const STALE_S = 1.0;
/** The most recent targets a stand-in keeps for a test to inspect. */
export const SENT_KEPT = 5000;

/**
 * Python's KeyboardInterrupt, which a scenario raises in a wait: a BaseException, for which the library of Python's
 * exceptions (src/python/errors.ts) has no class, since no code of PEAR's raises it.
 */
export class KeyboardInterrupt extends Error {
  override readonly name: string = "KeyboardInterrupt";
}

/** Returns the exception a script names by its class and its message. */
export function makeError(spec: { type: string; message?: string }): Error {
  const classes: Record<string, new (message: string) => Error> = {
    RuntimeError,
    ValueError,
    TimeoutError,
    OSError,
    KeyboardInterrupt,
    ServoFault,
  };
  const errorClass = classes[spec.type];
  if (errorClass === undefined) {
    throw new Error(`No error class ${spec.type}`);
  }

  return new errorClass(spec.message ?? "");
}

/**
 * The monotonic clock and the sleep of the station's code during a test: time stands still until the test or a sleep
 * advances it (PEAR's StandInClock). While a test hands over the sleep (`onSleep`), the test's handler is the whole
 * sleep, as a test of PEAR's that puts its own function in the place of `time.sleep`.
 */
export class StandInClock implements MonotonicClock {
  /** The clock's first reading. */
  static readonly START_S = 100.0;

  now = StandInClock.START_S;
  /** Whether a sleep advances the clock (PEAR's test of enabling has none do so). */
  advancesOnSleep = true;
  /** The whole sleep while it is set. */
  onSleep: ((seconds: number) => Promise<void>) | null = null;

  monotonic(): number {
    return this.now;
  }

  async sleep(seconds: number): Promise<void> {
    if (this.onSleep !== null) {
      await this.onSleep(seconds);
    } else if (this.advancesOnSleep) {
      this.now += seconds;
    }
  }
}

/** What a reading may be made anew with. */
export interface StateChanges {
  position?: readonly number[];
  velocity?: readonly number[];
  sampledMonotonicS?: number;
  sampleId?: SampleId;
  servoStatus?: ServoStatus;
}

/** One YAM arm's reading as PEAR's stand-in joints give it: the SDK's fields of the force-limited gripper, unset. */
export class TwoArmState extends ArmState {
  override feedback(now: number): ArmFeedback {
    return {
      ...super.feedback(now),
      sdk_gripper_force_limited: null,
      sdk_gripper_target: null,
      sdk_gripper_force_limit_n: null,
      sdk_gripper_target_effort_nm: null,
    } as ArmFeedback;
  }
}

/**
 * Returns a reading of the same class as `state` with some of its fields changed (Python's `dataclasses.replace`):
 * the joint layer's ArmState, the two arms' reading, or the SO-101's with its servos' status, which no other
 * reading takes (Python refuses the field with a TypeError).
 */
export function replaced<State extends ArmState>(state: State, changes: StateChanges): State {
  const position = [...(changes.position ?? state.position)];
  const velocity = [...(changes.velocity ?? state.velocity)];
  const sampledMonotonicS = changes.sampledMonotonicS ?? state.sampledMonotonicS;
  const sampleId = changes.sampleId !== undefined ? changes.sampleId : state.sampleId;

  if (state instanceof SO101ArmState) {
    const servoStatus = changes.servoStatus ?? state.servoStatus;
    const state101 = new SO101ArmState(position, velocity, sampledMonotonicS, sampleId as number | null, servoStatus);
    return state101 as ArmState as State;
  }
  if (changes.servoStatus !== undefined) {
    throw new TypeError("__init__() got an unexpected keyword argument 'servo_status'");
  }
  if (state instanceof TwoArmState) {
    return new TwoArmState(position, velocity, sampledMonotonicS, sampleId) as State;
  }

  return new ArmState(position, velocity, sampledMonotonicS, sampleId) as State;
}

function zeros(length: number): number[] {
  return new Array<number>(length).fill(0.0);
}

/**
 * A joint driver in memory: every arm reaches its command at once; a test makes its readings stale, holds its arms
 * where they are or gives its first joints a velocity (the MemoryDriver of PEAR's tests).
 */
export class MemoryDriver extends JointDriver<ArmState> {
  static readonly STALE_S = 1.0;

  /** Each arm's reading, by the arm's name. */
  positions: Record<string, readonly number[]>;
  isStale = false;
  /** Whether the arms move to each command; false: held in place by contact. */
  isFollowing = true;
  /** Every arm's first-joint velocity reading, rad/s. */
  velocity = 0.0;
  /** Whether that velocity flips sign on every reading. */
  isOscillating = false;
  /** Each command, with its planned velocities, the latest last. */
  readonly sent: [ArmVectors, ArmVectors | null][] = [];
  /** How often a hold was renewed. */
  refreshes = 0;
  /** The readings so far, which number them. */
  reads = 0;

  constructor(
    layout: JointLayout,
    start: readonly number[],
    private readonly clock: MonotonicClock,
  ) {
    super();
    this.positions = layout.split(start);
  }

  async read(): Promise<Record<string, ArmState>> {
    this.reads += 1;
    const sampledMonotonicS = this.clock.monotonic() - (this.isStale ? MemoryDriver.STALE_S : 0.0);
    const velocity = this.isOscillating ? this.velocity * (this.reads % 2 === 0 ? 1 : -1) : this.velocity;

    return Object.fromEntries(
      Object.entries(this.positions).map(([arm, position]) => [
        arm,
        new ArmState(position, [velocity, ...zeros(position.length - 1)], sampledMonotonicS, this.reads),
      ]),
    );
  }

  async readForRecovery(): Promise<Record<string, ArmState>> {
    return this.read();
  }

  async send(targets: ArmVectors, velocities: ArmVectors | null = null): Promise<void> {
    this.sent.push([{ ...targets }, velocities]);
    if (this.isFollowing) {
      this.positions = Object.fromEntries(Object.entries(targets).map(([arm, target]) => [arm, [...target]]));
    }
  }

  override async refreshHold(_targets: ArmVectors): Promise<void> {
    this.refreshes += 1;
  }

  async close(): Promise<void> {}
}

/**
 * A robot's joints without a device: every arm reaches each command at once, and a test makes the readings stale,
 * makes an arm's bus fail and reads back what was sent (PEAR's StandInYAMDriver).
 */
export class StandInJointDriver extends JointDriver<TwoArmState> {
  /** Each gripper's opening before the first command, with every joint at zero. */
  static readonly START_GRIPPER_OPENING = 0.5;

  positions: Record<string, readonly number[]>;
  isClosed = false;
  /** Whether every reading is STALE_S old. */
  isStale = false;
  /** The arm whose bus fails every read; null: no bus fails. */
  failedArm: string | null = null;
  /** The targets commanded, the latest last. */
  readonly sentTargets: Record<string, readonly number[]>[] = [];
  /** The planned velocities of the last command, by arm; null: it held its targets. */
  velocities: Record<string, readonly number[]> | null = null;

  constructor(
    layout: JointLayout,
    private readonly clock: MonotonicClock,
  ) {
    super();
    const startPosition = [...zeros(layout.jointCount), StandInJointDriver.START_GRIPPER_OPENING];
    this.positions = Object.fromEntries(layout.arms.map((arm) => [arm, startPosition]));
  }

  async read(): Promise<Record<string, TwoArmState>> {
    if (this.isClosed) {
      throw new RuntimeError("Hardware is closed");
    }
    if (this.failedArm) {
      throw new RuntimeError(`${this.failedArm}: stand-in bus failure`);
    }

    const sampledMonotonicS = this.clock.monotonic() - (this.isStale ? STALE_S : 0);

    return Object.fromEntries(
      Object.entries(this.positions).map(([arm, position]) => [
        arm,
        new TwoArmState(position, zeros(position.length), sampledMonotonicS),
      ]),
    );
  }

  async readForRecovery(): Promise<Record<string, TwoArmState>> {
    return this.read();
  }

  async send(targets: ArmVectors, velocities: ArmVectors | null = null): Promise<void> {
    if (this.isClosed) {
      throw new RuntimeError("Hardware is closed");
    }

    this.velocities =
      velocities === null
        ? null
        : Object.fromEntries(Object.entries(velocities).map(([arm, value]) => [arm, [...value]]));
    this.positions = Object.fromEntries(Object.entries(targets).map(([arm, target]) => [arm, [...target]]));
    this.sentTargets.push({ ...this.positions });
    if (this.sentTargets.length > SENT_KEPT) {
      this.sentTargets.shift();
    }
  }

  async close(): Promise<void> {
    this.isClosed = true;
  }
}

/** What the stand-in arm reaches for a commanded target from its position. */
export type ArmResponse = (goal: readonly number[], position: readonly number[]) => readonly number[];

/**
 * The SO-101's arm without its bus: it reaches every command at once, and a test makes its readings stale, its
 * reads fail, its jaw stop on an object or the arm answer a command its own way (PEAR's StandInSO101Arm).
 */
export class StandInSO101Arm implements ArmHardware {
  /** The arm's reading: Home, until a command. */
  position: readonly number[];
  isClosed = false;
  isStale = false;
  /** What every read throws while it is set. */
  failure: Error | null = null;
  /** Where the jaw stops while it closes; null: nowhere. */
  blockedGripperOpening: number | null = null;
  response: ArmResponse | null = null;
  readonly sentTargets: (readonly number[])[] = [];
  /** The reads so far, which number the readings. */
  readCount = 0;

  constructor(
    robotConfig: SO101RobotConfig,
    private readonly clock: MonotonicClock,
  ) {
    const home = robotConfig.home;
    this.position = (home !== null ? home.position : zeros(VECTOR_LENGTH)).map(Number);
  }

  async read(): Promise<SO101ArmState> {
    if (this.isClosed) {
      throw new RuntimeError("Hardware is closed");
    }
    if (this.failure !== null) {
      throw this.failure;
    }

    this.readCount += 1;

    return new SO101ArmState(
      [...this.position],
      zeros(VECTOR_LENGTH),
      this.clock.monotonic() - (this.isStale ? STALE_S : 0),
      this.readCount,
    );
  }

  async readForRecovery(): Promise<SO101ArmState> {
    return this.read();
  }

  async send(target: readonly number[]): Promise<void> {
    if (this.isClosed) {
      throw new RuntimeError("Hardware is closed");
    }

    let position = target.map(Number);
    if (this.response !== null) {
      position = this.response(position, this.position).map(Number);
    }
    if (this.blockedGripperOpening !== null) {
      const last = position.length - 1;
      // Python's max of the two: the commanded opening unless the object's is larger
      position[last] = this.blockedGripperOpening > position[last]! ? this.blockedGripperOpening : position[last]!;
    }
    this.position = position;

    this.sentTargets.push(target.map(Number));
    if (this.sentTargets.length > SENT_KEPT) {
      this.sentTargets.shift();
    }
  }

  async close(): Promise<void> {
    this.isClosed = true;
  }
}

/**
 * PEAR's StandInSO101Driver: the SO-101's own driver (src/so101/hardware/driver.ts) over the stand-in arm, without
 * the feedforward, which pushes an arm that reaches every command exactly off its target. PEAR's driver takes its
 * position bounds from the settings' limits section; the hardware layer's takes a robot's joint limits, which hold
 * the same bounds.
 */
export class StandInSO101Driver extends SO101Driver {
  declare readonly hardware: StandInSO101Arm;

  constructor(robotConfig: SO101RobotConfig, clock: MonotonicClock) {
    super(new StandInSO101Arm(robotConfig, clock), robotConfig.jointLimits(), null, { clock });
  }
}

/** What a scenario makes a method of the driver do: see the Probe of tools/fixtures/loop_fixtures.py. */
export interface Tamper {
  kind: string;
  skip?: number;
  times?: number | null;
  seen: number;
  count: number;
  [field: string]: unknown;
}

export type ProbedMethod = "read" | "read_for_recovery" | "send" | "refresh_hold" | "close";

type AnyState = ArmState;
export type AnyDriver = MemoryDriver | StandInJointDriver | StandInSO101Driver;

const METHODS: Record<ProbedMethod, { code: string; name: "read" | "readForRecovery" | "send" | "refreshHold" | "close" }> = {
  read: { code: "r", name: "read" },
  read_for_recovery: { code: "R", name: "readForRecovery" },
  send: { code: "s", name: "send" },
  refresh_hold: { code: "h", name: "refreshHold" },
  close: { code: "c", name: "close" },
};

/**
 * Stands between a control loop and its driver: it records every call the loop makes of the driver, in order, and
 * makes the driver misbehave as a scenario scripts it. A call is recorded as "r" (read), "R" (readForRecovery), "h"
 * (refreshHold), "c" (close) or ["s", targets, velocities]; a call that threw as [code + "!", ..., class, message].
 */
export class Probe {
  /** The calls since the last record. */
  calls: unknown[] = [];
  sendCount = 0;
  readonly tampers: Record<ProbedMethod, Tamper[]> = {
    read: [],
    read_for_recovery: [],
    send: [],
    refresh_hold: [],
    close: [],
  };

  private readonly real: Record<ProbedMethod, (...methodArguments: any[]) => Promise<unknown>>; // eslint-disable-line @typescript-eslint/no-explicit-any

  constructor(
    readonly driver: AnyDriver,
    private readonly layout: JointLayout,
    private readonly clock: StandInClock,
    private readonly kind: "so101" | "two_arm" | "memory",
    private readonly periodS: number,
  ) {
    const methods = Object.keys(METHODS) as ProbedMethod[];
    const target = driver as unknown as Record<string, (...methodArguments: unknown[]) => Promise<unknown>>;
    this.real = Object.fromEntries(
      methods.map((method) => [method, target[METHODS[method].name]!.bind(driver)]),
    ) as Probe["real"];
    // on the driver itself, as the fixture script's: the driver's own calls of its methods pass through too
    for (const method of methods) {
      target[METHODS[method].name] = (...methodArguments: unknown[]) => this.call(method, methodArguments);
    }
  }

  /** Returns the calls since the last time, and forgets them. */
  take(): unknown[] {
    const calls = this.calls;
    this.calls = [];

    return calls;
  }

  /** Where the stand-in holds `arm`. */
  position(arm: string): readonly number[] {
    if (this.driver instanceof StandInSO101Driver) {
      return this.driver.hardware.position;
    }
    return this.driver.positions[arm] as readonly number[];
  }

  setPosition(arm: string, position: readonly number[]): void {
    if (this.driver instanceof StandInSO101Driver) {
      this.driver.hardware.position = [...position];
    } else {
      this.driver.positions = { ...this.driver.positions, [arm]: [...position] };
    }
  }

  private async call(method: ProbedMethod, methodArguments: unknown[]): Promise<unknown> {
    let entry: unknown = METHODS[method].code;
    if (method === "send") {
      this.sendCount += 1;
      const velocities = (methodArguments[1] ?? null) as ArmVectors | null;
      entry = ["s", this.vector(methodArguments[0] as ArmVectors), velocities === null ? null : this.vector(velocities)];
    }
    try {
      const result = await this.apply(method, methodArguments);
      this.calls.push(entry);
      return result;
    } catch (error) {
      const failed = Array.isArray(entry) ? entry : [entry];
      const thrown = error as Error;
      this.calls.push([`${failed[0] as string}!`, ...failed.slice(1), thrown.name, thrown.message]);
      throw error;
    }
  }

  private vector(armValues: ArmVectors): unknown {
    const named = Object.keys(armValues);
    if (named.length === this.layout.arms.length && named.every((arm, index) => arm === this.layout.arms[index])) {
      return this.layout.join(armValues);
    }
    return Object.fromEntries(Object.entries(armValues).map(([arm, values]) => [arm, [...values]]));
  }

  /** Returns the tampers that apply to this call of `method`, each counted. */
  private active(method: ProbedMethod): Tamper[] {
    const applying: Tamper[] = [];
    for (const tamper of this.tampers[method]) {
      tamper.seen += 1;
      const afterSkip = tamper.seen - (tamper.skip ?? 0);
      if (afterSkip >= 1 && (tamper.times == null || afterSkip <= tamper.times)) {
        tamper.count += 1;
        applying.push(tamper);
      }
    }

    return applying;
  }

  private async apply(method: ProbedMethod, methodArguments: unknown[]): Promise<unknown> {
    const tampers = this.active(method);
    for (const tamper of tampers) {
      if (tamper.kind === "advance_clock") {
        this.clock.now += tamper["seconds"] as number;
      }
    }
    if (method === "send") {
      return this.send(tampers, methodArguments);
    }
    for (const tamper of tampers) {
      if (tamper.kind === "raise") {
        throw makeError(tamper as unknown as { type: string; message?: string });
      }
    }
    let result = await this.real[method](...methodArguments);
    if (method === "read" || method === "read_for_recovery") {
      for (const tamper of tampers) {
        result = this.tampered(tamper, result as Record<string, AnyState>);
      }
    }

    return result;
  }

  private async send(tampers: Tamper[], methodArguments: unknown[]): Promise<void> {
    const targets = methodArguments[0] as ArmVectors;
    for (const tamper of tampers) {
      if (tamper.kind === "partial") {
        // one arm takes its target, then the write fails
        this.setPosition(tamper["arm"] as string, targets[tamper["arm"] as string] as readonly number[]);
        throw makeError(tamper as unknown as { type: string; message?: string });
      }
      if (tamper.kind === "raise") {
        throw makeError(tamper as unknown as { type: string; message?: string });
      }
    }
    if (!tampers.some((tamper) => tamper.kind === "ignore")) {
      await this.real.send(...methodArguments);
    }
    for (const tamper of tampers) {
      if (tamper.kind === "bias") {
        // the arm rests off its target
        const position = [...this.position(tamper["arm"] as string)];
        position[tamper["index"] as number]! += tamper["delta"] as number;
        this.setPosition(tamper["arm"] as string, position);
      }
    }
  }

  /** Returns the reading `states` changed as `tamper` says. */
  private tampered(tamper: Tamper, states: Record<string, AnyState>): Record<string, AnyState> {
    const kind = tamper.kind;
    const arms = tamper["arm"] != null ? [tamper["arm"] as string] : Object.keys(states);

    const changed = (field: "position" | "velocity", index: number | null, value: number | readonly number[]): void => {
      for (const arm of arms) {
        const state = states[arm] as AnyState;
        let values: number[];
        if (index === null) {
          values = [...(value as readonly number[])];
        } else {
          values = [...state[field]];
          values[index] = value as number;
        }
        states[arm] = replaced(state, { [field]: values });
      }
    };

    if (kind === "drop") {
      delete states[tamper["arm"] as string];
    } else if (kind === "position" || kind === "velocity") {
      const whole = "values" in tamper;
      changed(kind, whole ? null : (tamper["index"] as number), (whole ? tamper["values"] : tamper["value"]) as number);
    } else if (kind === "sample_id") {
      for (const arm of arms) {
        states[arm] = replaced(states[arm] as AnyState, { sampleId: tamper["value"] as SampleId });
      }
    } else if (kind === "alternate") {
      const magnitude = tamper["magnitude"] as number;
      let value: number;
      if (tamper["by"] === "clock") {
        // as PEAR's tests: by the parity of the control period
        const isOdd = Math.round((this.clock.now - StandInClock.START_S) / this.periodS) % 2 !== 0;
        value = isOdd ? magnitude : -magnitude;
      } else {
        value = magnitude * (tamper.count % 2 === 0 ? 1 : -1);
      }
      changed(tamper["field"] as "position" | "velocity", tamper["index"] as number, value);
    } else if (kind === "drift") {
      const value = (this.clock.now - (tamper["since"] as number)) * (tamper["rate"] as number);
      changed("position", tamper["index"] as number, value);
    } else if (kind === "sequence") {
      // the n-th reading takes the n-th value, a later one the last
      const values = tamper["values"] as number[];
      const value = values[Math.min(tamper.count, values.length) - 1] as number;
      changed(tamper["field"] as "position" | "velocity", tamper["index"] as number, value);
    } else if (kind === "reverse") {
      return Object.fromEntries(Object.entries(states).reverse());
    } else if (kind === "stamp") {
      for (const arm of arms) {
        const state = states[arm] as AnyState;
        states[arm] = replaced(state, { sampledMonotonicS: state.sampledMonotonicS + (tamper["offset"] as number) });
      }
    } else if (kind === "servo") {
      for (const arm of arms) {
        const status = structuredClone(tamper["status"]) as ServoStatus;
        states[arm] = replaced(states[arm] as AnyState, { servoStatus: status });
      }
    } else if (kind !== "advance_clock") {
      throw new Error(`No tamper ${kind}`);
    }

    return states;
  }
}

/** Returns what a stand-in SO-101 arm reaches for a commanded goal from its position, by the name a script gives. */
export function makeResponse(spec: { kind: string; [field: string]: unknown } | null): ArmResponse | null {
  if (spec === null) {
    return null;
  }

  if (spec.kind === "min_gripper") {
    // the jaw opens no further than a limit
    const limit = spec["limit"] as number;
    return (goal) => {
      const opening = goal[GRIPPER_INDEX]!;
      // Python's min of the two: the goal's unless the limit is smaller
      return [...goal.slice(0, GRIPPER_INDEX), limit < opening ? limit : opening];
    };
  }
  if (spec.kind === "sag") {
    // a P-only servo: it rests `sag` below its goal, anywhere within +-`friction` of that, and moves only when
    // pushed out of that band
    const sag = spec["sag"] as number[];
    const friction = spec["friction"] as number[];
    return (goal, position) => {
      const reached = [...goal];
      for (let index = 0; index < GRIPPER_INDEX; index++) {
        const centre = goal[index]! - sag[index]!;
        const low = centre - friction[index]!;
        const high = centre + friction[index]!;
        // Python's min(max(position, low), high)
        const raised = low > position[index]! ? low : position[index]!;
        reached[index] = high < raised ? high : raised;
      }
      return reached;
    };
  }
  if (spec.kind === "lag") {
    // each joint covers a share of what separates it from its goal
    const gain = spec["gain"] as number;
    return (goal, position) => {
      const reached = [...goal];
      for (let index = 0; index < GRIPPER_INDEX; index++) {
        reached[index] = position[index]! + gain * (goal[index]! - position[index]!);
      }
      return reached;
    };
  }
  throw new Error(`No response ${spec.kind}`);
}
