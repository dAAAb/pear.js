// Ports pear/deploy/station/control/joint/recovery.py.
//
// A policy's `step` is asynchronous: it commands the new hold through the driver (`transferHold`). The control loop
// awaits it inside its own step, so nothing of the loop runs between the policy's checks and its command.

import { formatFixed } from "../../so101/kinematics/text";
import { RecoveryPhase } from "../schemas";
import { secondsClock, type MonotonicClock } from "./clock";
import type { ControlConfig } from "./config";
import type { ControlFeedback, JointControlLoop } from "./control_loop";
import { OperatorPaused, RuntimeError, type Cancellation } from "./errors";
import { JointLayout } from "./layout";
import { broadcastPair, clip, minimum } from "./numeric";
import type { ArmTargets } from "./operations";
import type { StabilityWindow } from "./stability";
import type { JointTrajectory } from "./trajectory";

/** What a recovery request is made with besides its window and its deadline. */
export interface RecoveryRequestOptions {
  /** Set by the operator to pause the recovery. */
  readonly cancellation?: Cancellation | null;
  /** Whether the policy chose the timeout. */
  readonly hasAutomaticTimeout?: boolean;
  /** The clock the deadline is read on (by default the page's). */
  readonly clock?: MonotonicClock;
}

/** One caller's request to reacquire a hold after a fault; the control loop's step advances it. */
export class RecoveryRequest {
  readonly cancellation: Cancellation | null;
  isDone = false;
  error: unknown = null;
  phase: RecoveryPhase = RecoveryPhase.CHECKING_STABILITY;
  /** The release from the old targets to the new hold. */
  trajectory: JointTrajectory | null = null;
  /** The measured pose the new hold was taken from. */
  anchorPose: Record<string, readonly number[]> | null = null;
  /** Whether the policy chose the timeout. */
  hasAutomaticTimeout: boolean;

  private readonly clock: MonotonicClock;

  constructor(
    readonly window: StabilityWindow,
    /** On the monotonic clock, s; a release moves it. */
    public deadline: number,
    options: RecoveryRequestOptions = {},
  ) {
    this.cancellation = options.cancellation ?? null;
    this.hasAutomaticTimeout = options.hasAutomaticTimeout ?? false;
    this.clock = options.clock ?? secondsClock();
  }

  /** Throws the window's stability error once the request's deadline has passed. */
  checkDeadline(): void {
    if (this.clock.monotonic() >= this.deadline) {
      throw this.window.stabilityError("Recovery requires fresh stable feedback");
    }
  }
}

/** How a robot's control loop holds its arms at a fault and reacquires a settled hold afterwards. */
export abstract class RecoveryPolicy {
  /** Returns how long a recovery may take when its caller gives no timeout, s. */
  abstract defaultTimeoutS(controlConfig: ControlConfig): number;

  /** Returns the targets to hold after a fault. */
  abstract faultTargets(controlLoop: JointControlLoop): ArmTargets;

  /** Advances `request` by one control period with the window's verdict on `feedback`. */
  abstract step(
    controlLoop: JointControlLoop,
    request: RecoveryRequest,
    feedback: ControlFeedback,
    isStable: boolean,
  ): Promise<void>;
}

/** Returns each arm's measured joints with its gripper's command as the targets. */
function measuredTargets(controlLoop: JointControlLoop): Record<string, number[]> {
  return Object.fromEntries(
    controlLoop.layout.arms.map((arm) => [
      arm,
      JointLayout.withGripper(
        controlLoop.states[arm]!.position,
        JointLayout.gripperValue(controlLoop.targets[arm] as readonly number[]),
      ),
    ]),
  );
}

/**
 * A fault holds the arms where they are measured, and a recovery takes the still arms' pose as the hold: for stiff
 * position servos, which keep pushing toward an old target.
 */
export class MeasuredHoldRecovery extends RecoveryPolicy {
  /** Settle timeouts a recovery may take by default. */
  static readonly TIMEOUT_SETTLE_COUNT = 2;

  defaultTimeoutS(controlConfig: ControlConfig): number {
    return MeasuredHoldRecovery.TIMEOUT_SETTLE_COUNT * controlConfig.settle_timeout_s;
  }

  /** Returns the targets to hold after a fault: the measured arm joints if fresh, with each gripper's command. */
  faultTargets(controlLoop: JointControlLoop): ArmTargets {
    try {
      controlLoop.checkFresh(controlLoop.states);
    } catch (error) {
      if (error instanceof RuntimeError) {
        return controlLoop.targets;
      }
      throw error;
    }

    return measuredTargets(controlLoop);
  }

  async step(
    controlLoop: JointControlLoop,
    request: RecoveryRequest,
    feedback: ControlFeedback,
    isStable: boolean,
  ): Promise<void> {
    if (request.phase === RecoveryPhase.CHECKING_STABILITY) {
      if (!isStable) {
        return;
      }

      // the arms are still: their measured pose becomes the hold, and a held object is not released; the pose may
      // rest past a limit, as an arm folded onto its stop, only within the feedback tolerance
      const targets = measuredTargets(controlLoop);
      const { limits, layout } = controlLoop;
      limits.checkPositions(layout.join(targets), layout, limits.feedbackTolerance);
      OperatorPaused.checkCancelled(request.cancellation);
      await controlLoop.transferHold(targets);
      request.phase = RecoveryPhase.VERIFYING_HOLD;
      request.window.reset();
      return;
    }

    controlLoop.checkTracking(feedback);
    if (isStable) {
      controlLoop.completeRecovery(request);
    }
  }
}

/** numpy's `allclose(first, second, atol=tolerance, rtol=0)` of two vectors of finite numbers. */
export function allClose(first: ArrayLike<number>, second: ArrayLike<number>, tolerance: number): boolean {
  const [left, right] = broadcastPair(first, second);

  return left.every((value, index) => value === right[index] || Math.abs(value - right[index]!) <= tolerance);
}

/** numpy's `argmax`: the index of the first largest value, of the first NaN if there is one. */
function indexOfLargest(values: readonly number[]): number {
  let largest = 0;
  for (let index = 0; index < values.length; index++) {
    if (Number.isNaN(values[index])) {
      return index;
    }
    if (values[index]! > values[largest]!) {
      largest = index;
    }
  }

  return largest;
}

/**
 * A fault keeps the old targets, and a recovery releases them slowly toward the measured pose: for arms that comply
 * with an old target.
 */
export class ReleaseRecovery extends RecoveryPolicy {
  /** The shortest default recovery, s. */
  static readonly MIN_TIMEOUT_S = 1.0;
  /** Velocity, acceleration and jerk caps of the release, per coordinate. */
  static readonly RELEASE_CAPS = [0.1, 0.2, 1.0] as const;
  /** Past the release and its settling before an automatic timeout, s. */
  static readonly RELEASE_MARGIN_S = 1.0;
  /** Targets this close to the measured pose need no release. */
  static readonly START_EPSILON = 1e-9;

  /** Returns how long a recovery may take when its caller gives no timeout; a release extends it. */
  defaultTimeoutS(controlConfig: ControlConfig): number {
    return Math.max(ReleaseRecovery.MIN_TIMEOUT_S, controlConfig.settle_timeout_s);
  }

  /** Returns the targets to hold after a fault: the old ones. */
  faultTargets(controlLoop: JointControlLoop): ArmTargets {
    return controlLoop.targets;
  }

  async step(
    controlLoop: JointControlLoop,
    request: RecoveryRequest,
    feedback: ControlFeedback,
    isStable: boolean,
  ): Promise<void> {
    if (request.phase === RecoveryPhase.CHECKING_STABILITY) {
      if (!isStable) {
        return;
      }
      this.planRelease(controlLoop, request);
    }

    this.checkDrift(controlLoop, request);
    if (request.phase === RecoveryPhase.RELEASING_TARGET) {
      await this.release(controlLoop, request, isStable);
    } else {
      this.verifyHold(controlLoop, request, feedback, isStable);
    }
  }

  /** Plans the release from the failed targets to the measured arm pose, clipped into the bounds. */
  private planRelease(controlLoop: JointControlLoop, request: RecoveryRequest): void {
    const { layout, limits } = controlLoop;
    const lowerBounds = layout.split(limits.lowerBounds);
    const upperBounds = layout.split(limits.upperBounds);
    // each gripper keeps its command, so a force-limited grasp holds
    const targets = Object.fromEntries(
      layout.arms.map((arm) => [
        arm,
        JointLayout.withGripper(
          controlLoop.states[arm]!.position.map((coordinate, index) =>
            clip(coordinate, lowerBounds[arm]![index]!, upperBounds[arm]![index]!),
          ),
          JointLayout.gripperValue(controlLoop.targets[arm] as readonly number[]),
        ),
      ]),
    );
    const start = layout.join(controlLoop.targets);
    const goal = layout.join(targets);
    // targets held since enabling may rest past a limit; the release may only move them inward
    limits.checkPositions(start, layout, limits.feedbackTolerance);
    limits.checkCommand(goal, start, layout);

    const trajectory = controlLoop.newTrajectory();
    trajectory.hold(start);
    // these caps bound how fast the target changes, not the contact forces
    const releaseCaps = limits
      .motionCaps()
      .slice(0, ReleaseRecovery.RELEASE_CAPS.length)
      .map((caps, index) => caps.map((cap) => minimum(cap, ReleaseRecovery.RELEASE_CAPS[index]!)));
    trajectory.headFor(goal, releaseCaps);
    trajectory.computeTrajectory();
    request.trajectory = trajectory;
    request.anchorPose = Object.fromEntries(layout.arms.map((arm) => [arm, controlLoop.states[arm]!.position]));

    if (allClose(start, goal, ReleaseRecovery.START_EPSILON)) {
      request.phase = RecoveryPhase.VERIFYING_HOLD;
      return;
    }
    request.phase = RecoveryPhase.RELEASING_TARGET;
    if (request.hasAutomaticTimeout) {
      const settlingS = controlLoop._controlConfig.settle_timeout_s + ReleaseRecovery.RELEASE_MARGIN_S;
      request.deadline = controlLoop.clock.monotonic() + trajectory.durationS + settlingS;
    }
  }

  /**
   * Throws if an arm joint moved away from the pose the hold was taken from: a release never chases a drifting arm.
   */
  private checkDrift(controlLoop: JointControlLoop, request: RecoveryRequest): void {
    const layout = controlLoop.layout;
    // the loop's own settings, not a copy: this runs every control period of a recovery
    const tolerance = controlLoop._robotConfig.position_tolerance;

    for (const arm of layout.arms) {
      const measuredJoints = JointLayout.jointValues(controlLoop.states[arm]!.position);
      const anchorJoints = JointLayout.jointValues(request.anchorPose![arm] as readonly number[]);
      const drift = measuredJoints.map((joint, index) => Math.abs(joint - anchorJoints[index]!));
      if (drift.some((distance) => distance > tolerance)) {
        const index = indexOfLargest(drift);
        const name = JointLayout.axisName(layout.armAxisLabels(arm, index));
        throw new RuntimeError(
          `Recovery blocked: ${name} moved ${formatFixed(drift[index]!, 6)} rad during hold transfer`,
        );
      }
    }
  }

  /** Moves the hold one control period along the release, and verifies the new hold once the release ends. */
  private async release(controlLoop: JointControlLoop, request: RecoveryRequest, isStable: boolean): Promise<void> {
    if (!isStable) {
      throw request.window.stabilityError("Recovery blocked: motion during hold transfer");
    }

    const layout = controlLoop.layout;
    const trajectory = request.trajectory as JointTrajectory;
    const sample = trajectory.advance();
    controlLoop.limits.checkCommand(sample.position, layout.join(controlLoop.targets), layout);
    OperatorPaused.checkCancelled(request.cancellation);
    await controlLoop.transferHold(layout.split(sample.position), controlLoop.plannedVelocities(sample));
    trajectory.accept(sample);

    if (sample.isFinished) {
      request.phase = RecoveryPhase.VERIFYING_HOLD;
      request.window.reset();
    }
  }

  /** Completes the recovery once the arms track the new hold and are stable. */
  private verifyHold(
    controlLoop: JointControlLoop,
    request: RecoveryRequest,
    feedback: ControlFeedback,
    isStable: boolean,
  ): void {
    controlLoop.checkTracking(feedback);
    if (isStable) {
      controlLoop.completeRecovery(request);
    }
  }
}
