// Ports pear/deploy/station/control/motion/homing.py: HomeFailed, HomeStage, Homing.

import type { ActionGuard } from "../joint/action_guard";
import type { ControlConfig, RobotConfig } from "../joint/config";
import { OperatorPaused, RuntimeError, TimeoutError, ValueError } from "../joint/errors";
import { JointLayout } from "../joint/layout";
import type { StabilityMetrics } from "../joint/stability";
import { GripperProfile, type JointMove } from "../joint/trajectory";
import { MotionEndReason, type ControlSnapshot, type HomePlan, type HomeReport, type Observation } from "../schemas";
import { controlLoopOf, type Execution } from "./execution";

/** Raised when Home stopped before it finished; the error that stopped it is its cause. */
export class HomeFailed extends RuntimeError {
  override readonly name: string = "HomeFailed";

  constructor(
    message: string,
    /** The stage, the error, the completed stages and each joint's accuracy at the failure. */
    readonly details: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** The stages of a return to Home, by the words its progress reports and its records carry. */
export const HomeStage = {
  CHECKING: "checking",
  OPENING: "opening",
  HOMING: "homing",
  COMPLETED: "completed",
} as const;
export type HomeStage = (typeof HomeStage)[keyof typeof HomeStage];

/** What approves a Home plan: only `true` does. It may take as long as an operator's review. */
export type ApprovePlan = (plan: HomePlan) => unknown;

/** What is told each stage of Home: the stage's word and what the stage reports with it. */
export type ReportHomeProgress = (progress: Record<string, unknown>) => void | Promise<void>;

/** How close one arm is to the targets it is judged against, as a robot's reports keep it. */
export interface ArmAccuracy {
  reached: boolean;
  gripper_open: boolean;
  error: number[];
  /** A gripper that is not judged has no tolerance: null. */
  tolerance: (number | null)[];
  violations: Record<string, unknown>[];
}

/** Python's `copy.deepcopy` of a plan: lists and dictionaries copied, the values as they are. */
function deepCopy<Value>(value: Value): Value {
  if (Array.isArray(value)) {
    return value.map(deepCopy) as Value;
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, deepCopy(child)])) as Value;
  }
  return value;
}

/**
 * One return to Home of a robot under the action's guard: the check, the plan and its approval, the grippers'
 * opening, the recheck, the move and its accuracy; a robot gives its own plan, recheck and accuracy.
 */
export abstract class Homing<Robot extends Execution = Execution> {
  /** Past the move and Home's arrival timeout before the last wait gives up, s. */
  static readonly WAIT_MARGIN_S: number = 5.0;

  // where a robot's plan holds what the flow reads of it
  /** The joint vector the arms hold once the grippers have opened. */
  abstract readonly START_TARGETS_KEY: string;
  /** The joint vector at Home. */
  abstract readonly GOAL_TARGETS_KEY: string;
  /** What the grippers that open first are asked for; false: none opens. */
  abstract readonly OPENING_KEY: string;

  readonly controlConfig: ControlConfig;
  readonly robotConfig: RobotConfig;
  stage: HomeStage = HomeStage.CHECKING;
  /** Each with its stage and what it left. */
  readonly completedStages: Record<string, unknown>[] = [];
  /** The arms Home returns; a robot's plan may narrow them. */
  arms: readonly string[];
  /** The joint vector the arms are judged against; null until a plan is approved. */
  targets: number[] | null = null;

  constructor(
    readonly robot: Robot,
    readonly guard: ActionGuard,
    readonly reportProgress: ReportHomeProgress | null,
  ) {
    const controlLoop = controlLoopOf(guard);
    this.controlConfig = controlLoop.controlConfig;
    this.robotConfig = controlLoop.robotConfig;
    this.arms = this.robotConfig.LAYOUT.arms;
  }

  /**
   * Plans Home, has `approvePlan` approve the plan, opens the grippers, returns the arms and verifies them, all by
   * `deadline`, and returns the report; a failure throws HomeFailed, an operator's pause as it is.
   */
  async run(options: { approvePlan: ApprovePlan | null; deadline: number }): Promise<HomeReport> {
    const { approvePlan, deadline } = options;
    const { robot, guard } = this;

    try {
      await this.reportStage(HomeStage.CHECKING);
      await robot.waitForSettledHold(null, { guard, deadline });
      let observation = await robot.observe();
      const snapshotBefore = observation.control_snapshot;
      const [plan, move] = await this.plan(observation, deadline);

      guard.check();
      if (approvePlan !== null && (await approvePlan(deepCopy(plan))) !== true) {
        throw new ValueError("Home cancelled before execution");
      }
      guard.check();
      this.checkTime(plan, deadline);

      this.targets = plan[this.START_TARGETS_KEY] as number[];
      await this.openGrippers(plan, observation, deadline);
      if (move !== null) {
        await this.reportStage(HomeStage.CHECKING);
        observation = await robot.observe();
        await this.recheck(observation, move, deadline);
      }

      this.targets = plan[this.GOAL_TARGETS_KEY] as number[];
      const snapshotAfter = await this.returnArms(move, observation, deadline);

      guard.check();
      const results = this.accuracy(snapshotAfter);
      await this.reportStage(HomeStage.COMPLETED, { results });

      return {
        plan,
        before: snapshotBefore,
        phases: this.completedStages,
        after: snapshotAfter,
        results,
      };
    } catch (error) {
      if (error instanceof OperatorPaused) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      const details = {
        stage: this.stage,
        error: message,
        completed_stages: this.completedStages,
        results: this.targets === null ? {} : this.accuracy(controlLoopOf(guard).snapshot()),
      };
      throw new HomeFailed(message, details, { cause: error });
    }
  }

  /**
   * Returns the robot's checked plan of Home from `observation`, which the operator reviews, and its arm move, null
   * when the arms are at Home already.
   */
  abstract plan(
    observation: Observation,
    deadline: number,
  ): [HomePlan, JointMove | null] | Promise<[HomePlan, JointMove | null]>;

  /** Whether the report of the grippers' operation says that every gripper it moved is open. */
  abstract isOpened(gripperReport: Record<string, unknown>): boolean;

  /**
   * Throws unless the approved `move` is still valid with the feedback of `observation`, taken once the grippers
   * have opened.
   */
  abstract recheck(observation: Observation, move: JointMove, deadline: number): void | Promise<void>;

  /** Returns Home's tolerance of each coordinate of an arm. */
  abstract tolerance(): number[];

  /**
   * Returns how close the arms of `snapshot` are to the targets they are judged against, as the robot's reports keep
   * it.
   */
  abstract accuracy(snapshot: ControlSnapshot): Record<string, unknown>;

  /**
   * Enters `stage` and tells the caller's progress of it with `data`, checking the guard around the report.
   */
  async reportStage(stage: HomeStage, data: Record<string, unknown> = {}): Promise<void> {
    this.stage = stage;

    this.guard.check();
    if (this.reportProgress !== null) {
      await this.reportProgress({ stage, ...data });
    }
    this.guard.check();
  }

  /**
   * Waits until the control loop's own history shows the arms settled at their targets within Home's tolerance, and
   * returns the snapshot then.
   */
  async wait(timeoutS: number): Promise<ControlSnapshot> {
    const controlLoop = controlLoopOf(this.guard);
    const home = this.robotConfig.home!;
    const targets = this.robotConfig.LAYOUT.split(this.targets!);

    // whether the loop's history shows the arms stable at their targets; the snapshot receives the window's
    // measurements
    const isHomeWindowStable = (snapshot: ControlSnapshot): boolean => {
      const metrics: StabilityMetrics = controlLoop.stability({
        arms: this.arms,
        durationS: home.settle_window_s,
        targets,
        positionTolerance: this.tolerance(),
      });
      (snapshot as unknown as Record<string, unknown>)["home_accuracy_window"] = metrics;

      return metrics.stable as boolean;
    };

    return controlLoop.waitForHold(timeoutS, { accepts: isHomeWindowStable, guard: this.guard, label: "Home feedback" });
  }

  /** Returns the error of `arm` in `snapshot` against its targets, judged by Home's own tolerance. */
  armAccuracy(snapshot: ControlSnapshot, arm: string): ArmAccuracy {
    const layout = this.robotConfig.LAYOUT;
    const tolerance = this.tolerance();
    const position = Array.from(snapshot.arms[arm]!.position);
    const target = layout.split(this.targets!)[arm]!;
    const error = position.map((value, index) => value - target[index]!);
    const openError = Math.abs(JointLayout.gripperValue(position) - GripperProfile.OPEN_ENDPOINT);

    return {
      reached: error.every((value, index) => Math.abs(value) <= tolerance[index]!),
      gripper_open: openError <= this.robotConfig.gripper_tolerance,
      error,
      // a JSON record refuses infinity: a gripper that is not judged has no tolerance
      tolerance: tolerance.map((bound) => (Number.isFinite(bound) ? bound : null)),
      violations: error.flatMap((value, coordinateIndex) =>
        Math.abs(value) > tolerance[coordinateIndex]!
          ? [
              {
                [JointLayout.COORDINATE_LABEL]: layout.coordinates[coordinateIndex],
                error: value,
                limit: tolerance[coordinateIndex],
              },
            ]
          : [],
      ),
    };
  }

  /** Opens the grippers that the plan asks to open first, and throws unless every one of them opened. */
  private async openGrippers(plan: HomePlan, observation: Observation, deadline: number): Promise<void> {
    const gripperRequest = plan[this.OPENING_KEY];
    if (!gripperRequest) {
      return;
    }

    await this.reportStage(HomeStage.OPENING);
    const openingReport = await this.robot.operateGrippers(gripperRequest, { observation, guard: this.guard, deadline });
    if (!this.isOpened(openingReport)) {
      throw new RuntimeError("Home opening did not complete; no arm move dispatched");
    }
    this.completedStages.push({ stage: HomeStage.OPENING, ...openingReport });
  }

  /**
   * Starts `move`, if there is one, from the hold of `observation`, waits until the arms have arrived at Home and
   * returns the snapshot then.
   */
  private async returnArms(move: JointMove | null, observation: Observation, deadline: number): Promise<ControlSnapshot> {
    const { robot, guard } = this;
    let moveS = 0.0;
    if (move !== null) {
      moveS = move.durationS;
      await this.reportStage(HomeStage.HOMING, { duration_seconds: moveS });
      const controlLoop = controlLoopOf(guard);
      await robot.submitWhenSettled(guard, () => controlLoop.dispatchJointMove(move, observation), { deadline });
    }

    const waitS = moveS + this.robotConfig.home!.arrival_timeout_s + (this.constructor as typeof Homing).WAIT_MARGIN_S;
    const snapshotAfter = await this.wait(robot.remainingS(deadline, waitS));
    if (move !== null) {
      if (snapshotAfter.motion.end_reason !== MotionEndReason.FINISHED) {
        throw new RuntimeError("Home move was interrupted");
      }
      this.completedStages.push({ stage: HomeStage.HOMING, after: snapshotAfter });
    }

    return snapshotAfter;
  }

  /** Throws unless the approved `plan` still has the time it estimates before `deadline`. */
  checkTime(plan: HomePlan, deadline: number): void {
    if (this.robot.clock.monotonic() + plan.operation_seconds_estimate >= deadline) {
      throw new TimeoutError("Home approved too late to finish before its timeout; nothing sent, confirm again");
    }
  }
}
