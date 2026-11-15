// Ports pear/deploy/station/control/joint/trajectory.py.
//
// PEAR's code tests the number that Ruckig's `calculate` and `update` return (`if result < 0`). The Python module
// never returns a negative number: it raises `RuckigError` for an input it refuses and for a calculation that fails,
// and `ValueError: -101 is not a valid Result.` for the one result its `Result` has no member for (a duration above
// 7,600 s). So what PEAR's callers see is those two errors, and they are what is thrown here: the `RuckigError` of
// src/ruckig passes through, and a returned -101 becomes the Python module's `ValueError`.

import {
  ControlInterface,
  InputParameter,
  OutputParameter,
  Result,
  Ruckig,
  Synchronization,
  Trajectory,
} from "../../ruckig/index";
import { formatGeneral } from "../../so101/kinematics/text";
import type { ControlConfig, MotionLimitSettings } from "./config";
import { RuntimeError, ValueError } from "./errors";
import { JointLayout } from "./layout";
import type { JointLimits, MotionCaps } from "./limits";
import { clip } from "./numeric";

/** The results of Ruckig that the Python module's `Result` has no member for. */
const UNNAMED_RESULTS: readonly number[] = [Result.ErrorTrajectoryDuration, Result.ErrorZeroLimits];

/**
 * Throws what PEAR's caller sees of a negative `result` of Ruckig: the Python module's own `ValueError` for a result
 * it cannot name, and the error PEAR makes for any other (which the module never returns: it raises instead).
 */
function raiseForResult(result: Result, makeError: (resultText: string) => Error): void {
  if (UNNAMED_RESULTS.includes(result)) {
    throw new ValueError(`${result} is not a valid Result.`);
  }
  if (result < 0) {
    const name = Object.entries(Result).find(([, value]) => value === result)?.[0];
    throw makeError(`Result.${name ?? result}`);
  }
}

function zeros(length: number): number[] {
  return new Array<number>(length).fill(0.0);
}

/** One control period's commanded joint vector and its derivatives. */
export class CommandSample {
  constructor(
    public position: number[],
    public velocity: number[],
    public acceleration: number[],
    public isFinished: boolean,
    /** A new held target the sample commits, if any. */
    public requestedTarget: number[] | null = null,
  ) {}
}

/** The acceleration and jerk caps a controlled stop brakes with. */
export type BrakingCaps = readonly [ArrayLike<number>, ArrayLike<number>];

/** The online Ruckig state that finite sequences, holds and controlled stops share. */
export class JointTrajectory {
  /** Ruckig's inputs of the three motion caps. */
  static readonly CAP_INPUTS = ["maxVelocity", "maxAcceleration", "maxJerk"] as const;

  readonly generator: Ruckig;
  readonly input: InputParameter;
  readonly output: OutputParameter;
  /** Of the trajectory last computed, s. */
  durationS = 0.0;

  constructor(
    readonly limits: JointLimits,
    readonly layout: JointLayout,
    readonly controlConfig: ControlConfig,
  ) {
    this.generator = new Ruckig(layout.vectorLength, controlConfig.controlPeriodS);
    this.input = new InputParameter(layout.vectorLength);
    this.output = new OutputParameter(layout.vectorLength);
  }

  /** Rests at `position` with zero derivatives, within the station's limits. */
  hold(position: ArrayLike<number>): void {
    const held = this.layout.vector(position);

    this.headFor(held);
    this.input.currentPosition = held;
    this.input.currentVelocity = zeros(this.layout.vectorLength);
    this.input.currentAcceleration = zeros(this.layout.vectorLength);
  }

  /** Heads for rest at `target` in position mode, within `motionCaps` (by default the station's limits). */
  headFor(target: ArrayLike<number>, motionCaps: readonly ArrayLike<number>[] | null = null): void {
    const caps = motionCaps === null ? this.limits.motionCaps() : motionCaps;
    JointTrajectory.CAP_INPUTS.slice(0, caps.length).forEach((name, index) => {
      this.input[name] = Array.from(caps[index] as ArrayLike<number>);
    });

    this.input.controlInterface = ControlInterface.Position;
    this.input.targetPosition = Array.from(target, Number);
    this.input.targetVelocity = zeros(this.layout.vectorLength);
    this.input.targetAcceleration = zeros(this.layout.vectorLength);
  }

  /** Heads for a new checked target at the station's limits, keeping the old input if the target is rejected. */
  setTarget(target: ArrayLike<number>): void {
    this.limits.checkPositions(target, this.layout);
    const input = this.input;
    const previousTarget = input.targetPosition;
    const previousInterface = input.controlInterface;
    const previousCaps = JointTrajectory.CAP_INPUTS.map((name) => input[name]);

    try {
      this.headFor(this.layout.vector(target));
      this.computeTrajectory();
    } catch (error) {
      input.targetPosition = previousTarget;
      input.controlInterface = previousInterface;
      JointTrajectory.CAP_INPUTS.forEach((name, index) => {
        input[name] = previousCaps[index] as number[];
      });
      throw error;
    }
  }

  /** Returns the sample of the next control period. */
  advance(): CommandSample {
    const result = this.generator.update(this.input, this.output);
    raiseForResult(result, (resultText) => new RuntimeError(`Trajectory update failed: ${resultText}`));

    return new CommandSample(
      this.output.newPosition,
      this.output.newVelocity,
      this.output.newAcceleration,
      result === Result.Finished,
    );
  }

  /** Continues from `sample`, which was sent. */
  accept(sample: CommandSample): void {
    this.input.currentPosition = sample.position;
    this.input.currentVelocity = sample.velocity;
    this.input.currentAcceleration = sample.acceleration;
    if (sample.requestedTarget !== null) {
      this.input.targetPosition = sample.requestedTarget;
    }
  }

  /**
   * Brakes to rest, from standstill if `fromStandstill`, with the acceleration and jerk caps `brakingCaps` if given.
   */
  stop(options: { fromStandstill: boolean; brakingCaps: BrakingCaps | null }): void {
    const length = this.layout.vectorLength;
    if (options.fromStandstill) {
      this.input.currentVelocity = zeros(length);
      this.input.currentAcceleration = zeros(length);
    }
    if (options.brakingCaps !== null) {
      const [acceleration, jerk] = options.brakingCaps;
      this.input.maxAcceleration = Array.from(acceleration);
      this.input.maxJerk = Array.from(jerk);
    }
    this.input.controlInterface = ControlInterface.Velocity;
    this.input.targetVelocity = zeros(length);
    this.input.targetAcceleration = zeros(length);

    this.computeTrajectory();
  }

  /** Computes the trajectory to the input's target, and throws if Ruckig rejects it or it leaves the bounds. */
  computeTrajectory(): void {
    const trajectory = new Trajectory(this.layout.vectorLength);
    raiseForResult(this.generator.calculate(this.input, trajectory), () => new ValueError("Trajectory rejected"));
    this.limits.checkTrajectory(trajectory, this.input.currentPosition);

    this.durationS = trajectory.duration;
  }
}

/** One gripper's trajectory to an endpoint of its opening, advanced one control period at a time. */
export class GripperProfile {
  /** The opening of an open gripper. */
  static readonly OPEN_ENDPOINT = 1.0;
  /** The opening of a closed gripper. */
  static readonly CLOSED_ENDPOINT = 0.0;

  readonly generator: Ruckig;
  readonly input: InputParameter;
  readonly output: OutputParameter;
  /** The opening the gripper heads for. */
  readonly endpoint: number;

  constructor(start: number, opens: boolean, limits: MotionLimitSettings, controlPeriodS: number, startVelocity = 0.0) {
    this.generator = new Ruckig(1, controlPeriodS);
    this.input = GripperProfile.ruckigInput(start, opens, limits);
    this.input.currentVelocity = [startVelocity];
    this.output = new OutputParameter(1);
    this.endpoint = this.input.targetPosition[0] as number;
  }

  /** Returns the gripper's next position, velocity and acceleration, and whether the trajectory has finished. */
  advance(): [number, number, number, boolean] {
    const result = this.generator.update(this.input, this.output);
    raiseForResult(result, (resultText) => new RuntimeError(`Gripper trajectory update failed: ${resultText}`));

    return [
      this.output.newPosition[0] as number,
      this.output.newVelocity[0] as number,
      this.output.newAcceleration[0] as number,
      result === Result.Finished,
    ];
  }

  /** Continues from the sample last returned, at the `position` that was commanded for it. */
  accept(position: number): void {
    this.output.passToInput(this.input);
    this.input.currentPosition = [position];
  }

  /** Returns how long a gripper takes from rest at the opening `start` to its endpoint, s. */
  static durationS(start: number, opens: boolean, limits: MotionLimitSettings): number {
    const trajectory = new Trajectory(1);
    raiseForResult(
      new Ruckig(1).calculate(GripperProfile.ruckigInput(start, opens, limits), trajectory),
      () => new ValueError("Ruckig rejected the gripper endpoint"),
    );

    return trajectory.duration;
  }

  /**
   * Returns Ruckig's input of the trajectory from rest at the opening `start` to the open or the closed endpoint,
   * within the gripper's caps of its arm's `limits`.
   */
  static ruckigInput(start: number, opens: boolean, limits: MotionLimitSettings): InputParameter {
    const ruckigInput = new InputParameter(1);
    ruckigInput.currentPosition = [Number(start)];
    ruckigInput.currentVelocity = [0.0];
    ruckigInput.currentAcceleration = [0.0];
    ruckigInput.targetPosition = [opens ? GripperProfile.OPEN_ENDPOINT : GripperProfile.CLOSED_ENDPOINT];
    ruckigInput.targetVelocity = [0.0];
    ruckigInput.targetAcceleration = [0.0];
    ruckigInput.maxVelocity = [JointLayout.gripperValue(limits.velocity)];
    ruckigInput.maxAcceleration = [JointLayout.gripperValue(limits.acceleration)];
    ruckigInput.maxJerk = [JointLayout.gripperValue(limits.jerk)];

    return ruckigInput;
  }
}

/** What `JointMove.build` takes besides the two poses and the limits. */
export interface JointMoveOptions {
  /** The share of the caps the move uses, in (0, 1]. */
  readonly speedScale?: number;
  /** One arm's caps, which bound the move's own for every arm; null: the station's alone. */
  readonly caps?: MotionCaps | null;
}

/** An immutable rest-to-rest move, checked against the station's limits when built. */
export class JointMove {
  /** Longer moves are rejected rather than run, s. */
  static readonly MAX_DURATION_S = 120.0;

  readonly start: readonly number[];
  readonly goal: readonly number[];
  /** The velocity, acceleration and jerk caps of the move. */
  readonly motionCaps: readonly (readonly number[])[];

  /** The Ruckig trajectory once it was computed: each move computes it once. */
  private computedTrajectory: Trajectory | null = null;

  constructor(start: ArrayLike<number>, goal: ArrayLike<number>, motionCaps: readonly ArrayLike<number>[]) {
    this.start = Object.freeze(Array.from(start));
    this.goal = Object.freeze(Array.from(goal));
    this.motionCaps = Object.freeze(motionCaps.map((caps) => Object.freeze(Array.from(caps))));
  }

  /**
   * Returns a checked move from the held command `start`, which may rest just outside a limit, to `goal`.
   */
  static build(
    start: ArrayLike<number>,
    goal: ArrayLike<number>,
    limits: JointLimits,
    layout: JointLayout,
    options: JointMoveOptions = {},
  ): JointMove {
    const startVector = Array.from(start, Number);
    const goalVector = Array.from(goal, Number);
    const length = layout.vectorLength;
    if (
      startVector.length !== length ||
      goalVector.length !== length ||
      !startVector.every(Number.isFinite) ||
      !goalVector.every(Number.isFinite)
    ) {
      throw new ValueError(`Expected finite ${length}D start and goal`);
    }
    limits.checkPositions(startVector, layout, limits.feedbackTolerance);
    limits.checkCommand(goalVector, startVector, layout);

    const motionCaps = limits.motionCaps(options.speedScale ?? 1.0, options.caps ?? null);
    const move = new JointMove(startVector, goalVector, motionCaps);
    limits.checkTrajectory(move.trajectory, startVector);

    return move;
  }

  /** The Ruckig trajectory of this move. */
  get trajectory(): Trajectory {
    if (this.computedTrajectory !== null) {
      return this.computedTrajectory;
    }

    const vectorLength = this.start.length;
    const ruckigInput = new InputParameter(vectorLength);
    ruckigInput.currentPosition = this.start;
    ruckigInput.targetPosition = this.goal;
    if (this.motionCaps.length !== 3) {
      // Python's refusal to unpack the caps into the three inputs
      throw new ValueError(
        this.motionCaps.length > 3
          ? "too many values to unpack (expected 3)"
          : `not enough values to unpack (expected 3, got ${this.motionCaps.length})`,
      );
    }
    const [maxVelocity, maxAcceleration, maxJerk] = this.motionCaps as [number[], number[], number[]];
    ruckigInput.maxVelocity = maxVelocity;
    ruckigInput.maxAcceleration = maxAcceleration;
    ruckigInput.maxJerk = maxJerk;
    // rest-to-rest phase synchronization keeps the joint-space path straight, for several arms at once too
    ruckigInput.synchronization = Synchronization.Phase;

    const trajectory = new Trajectory(vectorLength);
    raiseForResult(
      new Ruckig(vectorLength).calculate(ruckigInput, trajectory),
      () => new ValueError("Ruckig rejected the joint target"),
    );
    const maxDurationS = (this.constructor as typeof JointMove).MAX_DURATION_S;
    if (!Number.isFinite(trajectory.duration) || trajectory.duration > maxDurationS) {
      throw new ValueError(`Joint trajectory exceeds ${formatGeneral(maxDurationS)} seconds`);
    }
    this.computedTrajectory = trajectory;

    return trajectory;
  }

  /** The move's duration, s. */
  get durationS(): number {
    return this.trajectory.duration;
  }

  /** Returns the position, velocity and acceleration `seconds` into the move. */
  atTime(seconds: number): [number[], number[], number[]] {
    if (!Number.isFinite(seconds)) {
      throw new ValueError("Trajectory time must be finite");
    }

    return this.trajectory.atTime(clip(seconds, 0, this.durationS));
  }
}
