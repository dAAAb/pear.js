// Ports pear/deploy/station/control/joint/operations.py.

import { MotionEndReason } from "../schemas";
import { ArmState } from "./arm_state";
import type { ControlConfig, RobotConfig } from "./config";
import { RuntimeError, TimeoutError, ValueError } from "./errors";
import { JointLayout } from "./layout";
import { clip, pythonMin } from "./numeric";
import { CommandSample, GripperProfile, type JointMove, type JointTrajectory } from "./trajectory";

/** Every arm's reading, by the arm's name. */
export type ArmStates<State extends ArmState = ArmState> = Readonly<Record<string, State>>;

/** Every arm's held target, by the arm's name. */
export type ArmTargets = Readonly<Record<string, readonly number[]>>;

/** Thrown by a bounded operation to request a controlled stop, which is no hardware fault. */
export class OperationInterrupted extends RuntimeError {
  override readonly name: string = "OperationInterrupted";

  constructor(
    /** How the motion ends. */
    readonly reason: MotionEndReason,
  ) {
    super(reason);
  }
}

/** Thrown when a gripper did not reach the endpoint it was sent to before the deadline. */
export class GripperEndpointTimeout extends TimeoutError {
  override readonly name: string = "GripperEndpointTimeout";
}

/** What a control loop asks once every control period for the next command. */
export abstract class Operation {
  /** Whether a stop brakes from standstill instead of the commanded motion. */
  readonly stopsFromStandstill: boolean = false;

  /** Returns the next command sample. */
  abstract advance(now: number, states: ArmStates, targets: ArmTargets): CommandSample;

  /** Returns the targets to hold after `error` faulted this operation (by default the targets held). */
  faultTargets(_error: unknown, _now: number, _states: ArmStates, targets: ArmTargets): ArmTargets {
    return targets;
  }
}

/** Advances the shared online trajectory; also the control loop's controlled stop. */
export class TargetOperation extends Operation {
  constructor(readonly trajectory: JointTrajectory) {
    super();
  }

  /** Returns the next command sample of the trajectory. */
  advance(_now: number, _states: ArmStates, _targets: ArmTargets): CommandSample {
    return this.trajectory.advance();
  }
}

/** Plays a checked JointMove at the control rate. */
export class JointMoveOperation extends TargetOperation {
  /** How far into the move the last sample was, s. */
  elapsedS = 0.0;

  constructor(
    trajectory: JointTrajectory,
    readonly move: JointMove,
  ) {
    super(trajectory);
  }

  /** Returns the move's command sample one control period on. */
  override advance(_now: number, _states: ArmStates, _targets: ArmTargets): CommandSample {
    const controlPeriodS = this.trajectory.controlConfig.controlPeriodS;
    this.elapsedS = pythonMin(this.elapsedS + controlPeriodS, this.move.durationS);
    const [position, velocity, acceleration] = this.move.atTime(this.elapsedS);

    return new CommandSample(position, velocity, acceleration, this.elapsedS >= this.move.durationS);
  }
}

/** Streams a finite chunk of absolute targets at its own rate, interrupting when it falls behind. */
export class SequenceOperation extends TargetOperation {
  /** Targets in one chunk. */
  static readonly MAX_ROWS = 1000;
  /** Rounding slack of the phase of a row. */
  static readonly PHASE_EPSILON = 1e-10;

  /** The chunk's own copy of the targets, which nothing changes afterwards. */
  readonly positions: readonly (readonly number[])[];
  readonly rateHz: number;
  /** Of the next row to hand to the trajectory. */
  index = 0;
  /** The share of a row's time that has passed since the last row, 1 when the next is due. */
  rowPhase = 0.0;
  /** When the first row was handed over. */
  startTime: number | null = null;

  constructor(trajectory: JointTrajectory, positions: ArrayLike<ArrayLike<number>>, rateHz: number) {
    super(trajectory);
    const layout = trajectory.layout;
    const controlConfig = trajectory.controlConfig;
    const maxRows = (this.constructor as typeof SequenceOperation).MAX_ROWS;

    const rows = Array.from(positions, (row) => Array.from(row, Number));
    if (rows.some((row) => row.length !== (rows[0] as number[]).length)) {
      // numpy's refusal to make one array of rows of unequal lengths
      throw new ValueError(
        "setting an array element with a sequence. The requested array has an inhomogeneous shape after 1 " +
          `dimensions. The detected shape was (${rows.length},) + inhomogeneous part.`,
      );
    }
    if (rows.length < 1 || rows.length > maxRows || (rows[0] as number[]).length !== layout.vectorLength) {
      throw new ValueError(`Expected 1..${maxRows} finite ${layout.vectorLength}D targets`);
    }
    if (!Number.isFinite(rateHz) || !(1 / controlConfig.action_timeout_s < rateHz && rateHz <= controlConfig.rate_hz)) {
      throw new ValueError("Action rate must exceed timeout rate and not exceed controller rate");
    }
    for (const row of rows) {
      trajectory.limits.checkPositions(row, layout);
    }

    this.positions = Object.freeze(rows.map((row) => Object.freeze(row)));
    this.rateHz = Number(rateHz);
  }

  /** Whether every target was handed to the trajectory. */
  get isComplete(): boolean {
    return this.index === this.positions.length;
  }

  /** Returns the next command sample, heading for the next row once its time has come. */
  override advance(now: number, _states: ArmStates, _targets: ArmTargets): CommandSample {
    const controlConfig = this.trajectory.controlConfig;
    if (!this.isComplete) {
      if (this.startTime === null) {
        this.startTime = now;
        this.rowPhase = 1.0;
      } else {
        this.rowPhase += this.rateHz * controlConfig.controlPeriodS;
      }
      if (this.rowPhase >= 1 - SequenceOperation.PHASE_EPSILON) {
        const latenessS = now - (this.startTime + this.index / this.rateHz);
        if (latenessS > controlConfig.controlPeriodS + controlConfig.deadline_tolerance_s) {
          throw new OperationInterrupted(MotionEndReason.SEQUENCE_DEADLINE);
        }
        this.trajectory.setTarget(this.positions[this.index] as readonly number[]);
        this.rowPhase -= 1;
        this.index += 1;
      }
    }

    const sample = this.trajectory.advance();
    sample.isFinished = sample.isFinished && this.isComplete;

    return sample;
  }
}

/**
 * The base of a robot's gripper operation, which moves grippers to an endpoint of their opening while every arm
 * target stays held.
 */
export abstract class GripperOperation extends Operation {
  /** A stop brakes from standstill, not from the grippers' own profiles. */
  override readonly stopsFromStandstill: boolean = true;

  /** Per arm, the measured opening a gripper stopped at on an object, at which its arrival is then judged. */
  blockedGripperOpenings: Record<string, number> | null = null;

  constructor(
    readonly controlConfig: ControlConfig,
    readonly robotConfig: RobotConfig,
    /** Whether the gripper of each arm the operation moves opens or closes. */
    readonly opensByArm: Readonly<Record<string, boolean>>,
  ) {
    super();
  }

  /** Returns the trajectory of `arm`'s gripper from the opening `start` to its endpoint, within the arm's caps. */
  newProfile(arm: string, start: number, startVelocity = 0.0): GripperProfile {
    const limits = this.robotConfig.armLimits()[arm]!;

    return new GripperProfile(
      start,
      this.opensByArm[arm] as boolean,
      limits,
      this.controlConfig.controlPeriodS,
      startVelocity,
    );
  }

  /**
   * Returns the targets to hold after `error`: a gripper whose opening was obstructed is released to its measured
   * opening, if that is fresh.
   */
  override faultTargets(error: unknown, now: number, states: ArmStates, targets: ArmTargets): ArmTargets {
    const held: Record<string, readonly number[]> = { ...targets };
    if (error instanceof GripperEndpointTimeout) {
      for (const [arm, opens] of Object.entries(this.opensByArm)) {
        const state = states[arm] as ArmState;
        const ageS = now - state.sampledMonotonicS;
        if (opens && ArmState.isFresh(ageS, this.controlConfig.state_timeout_s)) {
          const measuredOpening = clip(JointLayout.gripperValue(state.position), 0, 1);
          held[arm] = JointLayout.withGripper(held[arm] as readonly number[], measuredOpening);
        }
      }
    }

    return held;
  }

  /** Returns what the robot's reports keep of the operation once it has ended, under the robot's own keys. */
  abstract report(): Record<string, unknown>;
}
