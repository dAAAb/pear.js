// Ports pear/deploy/station/control/robots/so101/joint/grippers.py.

import type { ArmState } from "../../station/joint/arm_state";
import type { ControlConfig } from "../../station/joint/config";
import { maximum, minimum, clip } from "../../station/joint/numeric";
import {
  GripperEndpointTimeout,
  GripperOperation,
  type ArmStates,
  type ArmTargets,
} from "../../station/joint/operations";
import { SampleWindow } from "../../station/joint/stability";
import { CommandSample, type GripperProfile } from "../../station/joint/trajectory";
import type { SO101RobotConfig } from "../config";
import { ARM, GRIPPER_INDEX, VECTOR_LENGTH } from "../layout";

/** How the jaw's operation ended, by the word its report and an action's result carry. */
export const GripperOutcome = {
  OPEN: "open",
  CLOSED: "closed",
  /** It came to rest on an object: blocked, never a confirmed grasp. */
  STOPPED_BEFORE_CLOSED: "stopped_before_closed",
} as const;
export type GripperOutcome = (typeof GripperOutcome)[keyof typeof GripperOutcome];

/** What the jaw's operation reports once it has ended, as Home's records keep it. */
export interface SO101GripperReport {
  /** The opening at the start and the latest one. */
  gripper: Record<string, number>;
  outcome: GripperOutcome;
  /** The command samples sent. */
  updates_sent: number;
}

/** Moves the jaw to its open or its closed endpoint while the arm's targets stay held. */
export class SO101GripperOperation extends GripperOperation {
  declare readonly robotConfig: SO101RobotConfig;

  readonly initialOpening: number;
  outcome: GripperOutcome | null = null;
  /** The opening at the start and the latest one. */
  openingReport: Record<string, number> = {};
  /** Of the command samples sent. */
  sampleCount = 0;
  /** When the jaw's trajectory reached its endpoint. */
  finishedAt: number | null = null;
  /** The latest openings; a gap starts the window over, a reading stamped out of order does not. */
  readonly restWindow: SampleWindow<number>;
  readonly profile: GripperProfile;

  constructor(
    controlConfig: ControlConfig,
    robotConfig: SO101RobotConfig,
    targets: ArmTargets,
    states: ArmStates,
    opensGripper: boolean,
  ) {
    super(controlConfig, robotConfig, { [ARM]: opensGripper });
    this.initialOpening = Number(states[ARM]!.position[GRIPPER_INDEX]);

    this.restWindow = new SampleWindow<number>(controlConfig, controlConfig.settle_window_s, false);
    this.profile = this.newProfile(ARM, clip(targets[ARM]![GRIPPER_INDEX] as number, 0, 1));
  }

  /**
   * Returns the next command sample, with the jaw's next opening until it reached its endpoint or stopped on an
   * object.
   */
  advance(now: number, states: ArmStates, targets: ArmTargets): CommandSample {
    const state = states[ARM] as ArmState;
    const position = Array.from(targets[ARM] as readonly number[], Number);
    const velocity = new Array<number>(VECTOR_LENGTH).fill(0.0);
    const acceleration = new Array<number>(VECTOR_LENGTH).fill(0.0);
    const measuredOpening = Number(state.position[GRIPPER_INDEX]);
    this.openingReport = { initial_opening: this.initialOpening, final_opening: measuredOpening };

    if (this.outcome === null) {
      const [nextOpening, gripperVelocity, gripperAcceleration, isFinished] = this.profile.advance();
      let candidateOpening = nextOpening;
      velocity[GRIPPER_INDEX] = gripperVelocity;
      acceleration[GRIPPER_INDEX] = gripperAcceleration;
      if (isFinished) {
        candidateOpening = this.profile.endpoint;
        if (this.finishedAt === null) {
          this.finishedAt = now;
        }
      }
      position[GRIPPER_INDEX] = candidateOpening;
      this.profile.accept(candidateOpening);
      if (this.finishedAt !== null) {
        this.judgeEndpoint(now, state, measuredOpening);
      }
    }

    this.sampleCount += 1;
    return new CommandSample(position, velocity, acceleration, this.outcome !== null, position);
  }

  /** Returns the jaw's openings, its outcome and the command samples sent, as Home's records keep them. */
  report(): Record<string, unknown> & SO101GripperReport {
    if (this.outcome === null) {
      // Python reads the word of an outcome that is None
      throw new TypeError("'NoneType' object has no attribute 'value'");
    }

    return { gripper: this.openingReport, outcome: this.outcome, updates_sent: this.sampleCount };
  }

  /**
   * Sets the outcome once the jaw is at its endpoint or, closing, at rest on an object, and throws once it is
   * neither past the settle timeout.
   */
  private judgeEndpoint(now: number, state: ArmState, measuredOpening: number): void {
    const isOpening = this.opensByArm[ARM] as boolean;

    if (Math.abs(measuredOpening - this.profile.endpoint) <= this.robotConfig.gripper_tolerance) {
      this.outcome = isOpening ? GripperOutcome.OPEN : GripperOutcome.CLOSED;
    } else if (!isOpening && this.isAtRest(state)) {
      // without force sensing, a jaw closing on an object ends once still; its command stays closed, so the servo
      // keeps squeezing within its torque limit
      this.outcome = GripperOutcome.STOPPED_BEFORE_CLOSED;
      this.blockedGripperOpenings = { [ARM]: measuredOpening };
    } else if (now - (this.finishedAt as number) > this.controlConfig.settle_timeout_s) {
      const direction = isOpening ? "opening" : "closing";
      throw new GripperEndpointTimeout(`Gripper ${direction} endpoint was not reached`);
    }
  }

  /** Whether the jaw has stayed still for a whole settle window of fresh readings. */
  private isAtRest(state: ArmState): boolean {
    const window = this.restWindow;
    const durationS = this.controlConfig.settle_window_s;
    window.add(state.sampledMonotonicS, state.sampleId, Number(state.position[GRIPPER_INDEX]));

    const samples = window.samples;
    if (!SampleWindow.isComplete(samples, durationS, this.controlConfig.rate_hz)) {
      return false;
    }

    const openings = samples.map((sample) => sample.value);
    const span = openings.reduce(maximum) - openings.reduce(minimum);

    return span <= this.robotConfig.gripper_tolerance;
  }
}
