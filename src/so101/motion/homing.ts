// Ports pear/deploy/station/control/robots/so101/motion/homing.py: SO101Homing.

import type { JointMove } from "../../station/joint/trajectory";
import type { Execution } from "../../station/motion/execution";
import { Homing, type ArmAccuracy } from "../../station/motion/homing";
import type { ControlSnapshot, Observation } from "../../station/schemas";
import type { SO101RobotConfig } from "../config";
import { GripperOutcome } from "../joint/grippers";
import { ARM } from "../layout";
import { SO101Planning, type SO101HomePlan } from "./planning";

/** What the SO-101's Home asks of its robot beside the action level: a planning step bound to an observation. */
export interface SO101HomingRobot extends Execution {
  /**
   * Runs `planningStep` bound to `observation`, whose operation the arm must hold before and after, and returns
   * what it returns.
   */
  runWhileObservationHolds<Planned>(observation: Observation, planningStep: () => Planned): Planned;
}

/**
 * The SO-101's return to Home: the gripper opens, then the arm returns directly; the plan and its recheck run in the
 * caller's thread, bound to the observation they start from.
 */
export class SO101Homing extends Homing<SO101HomingRobot> {
  // the keys of the plan that hold the joint vector once the gripper has opened, at Home, and whether it opens
  override readonly START_TARGETS_KEY = "start_target";
  override readonly GOAL_TARGETS_KEY = "goal_target";
  override readonly OPENING_KEY = "open_gripper";

  declare readonly robotConfig: SO101RobotConfig;

  /**
   * Returns the checked plan of Home from `observation` and its move, while the arm still holds the operation of
   * `observation`.
   */
  override plan(observation: Observation, _deadline: number): [SO101HomePlan, JointMove | null] {
    return this.robot.runWhileObservationHolds(observation, () =>
      SO101Planning.checkedHome(this.controlConfig, this.robotConfig, observation),
    );
  }

  /** Whether the report of the jaw's operation says that it is open. */
  override isOpened(gripperReport: Record<string, unknown>): boolean {
    return gripperReport["outcome"] === GripperOutcome.OPEN;
  }

  /**
   * Throws unless the approved `move` still starts at the held targets and stays within the bounds with the
   * feedback of `observation`.
   */
  override recheck(observation: Observation, move: JointMove, _deadline: number): void {
    this.robot.runWhileObservationHolds(observation, () =>
      SO101Planning.recheckHomeMove(this.robotConfig, observation, move),
    );
  }

  /** Returns Home's tolerance of each coordinate: of each arm joint and of the gripper. */
  override tolerance(): number[] {
    return [...this.robotConfig.home!.joint_tolerance, this.robotConfig.gripper_tolerance];
  }

  /** Returns the arm's error against the targets it is judged against, by Home's own tolerance. */
  override accuracy(snapshot: ControlSnapshot): ArmAccuracy & Record<string, unknown> {
    return this.armAccuracy(snapshot, ARM) as ArmAccuracy & Record<string, unknown>;
  }
}
