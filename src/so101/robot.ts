// Ports pear/deploy/station/control/robots/so101/robot.py: SO101Robot.
//
// PEAR's robot makes its driver and its camera from its settings alone (a serial device and a camera device by
// their paths). A page cannot: the robot here is given the open line to the servos with the arm's calibration
// (`line`, what SO101Driver.fromConfig takes) and, for `openCameras`, the wrist camera's frame reader.

import { RuntimeError, ValueError } from "../python/errors";
import type { ActionGuard } from "../station/joint/action_guard";
import type { ControlConfig } from "../station/joint/config";
import type { JointDriver } from "../station/joint/driver";
import { ActionAdapter } from "../station/motion/actions";
import type { PreparedAction } from "../station/motion/planning";
import { MotionStatus } from "../station/motion/results";
import {
  ActionMode,
  BaseRobot,
  type ControlLoopClass,
  type HomeOptions,
  type ResultOptions,
  type RobotOptions,
  type RunHomeOptions,
  type StationConfig,
} from "../station/robot";
import type { BriefStatus, ControlSnapshot, DetailedStatus, HomeReport, Observation } from "../station/schemas";
import { SO101RobotConfig, type SO101Config, type SO101ConfigOptions } from "./config";
import { SINGLE_ARM_POSE_FORMAT } from "./formats";
import type { SO101Line } from "./hardware/arms";
import { WristCamera, type WristFrameReader } from "./hardware/cameras";
import { SO101Driver } from "./hardware/driver";
import { SO101ControlLoop } from "./joint/control_loop";
import { SO101Kinematics } from "./kinematics/kinematics";
import { JOINTS } from "./layout";
import { GripperAction, JointPositions, modelStateOf, SingleArmDelta, type ModelState } from "./motion/actions";
import { SO101Homing, type SO101HomingRobot } from "./motion/homing";
import { SO101Planning } from "./motion/planning";
import { SO101MotionResult } from "./motion/results";

/** What an SO-101 is made with besides its station's configuration. */
export interface SO101RobotOptions<Image = unknown> extends RobotOptions<Image> {
  /** The line to the servos, already open, and the arm's calibration: what the driver is made on at `open`. */
  line?: SO101Line | null;
  /** The wrist camera's frame reader, which `openCameras` makes its source on. */
  wristFrames?: WristFrameReader<Image> | null;
  /** How the settings learn whether the arm's calibration exists (PEAR looks for its file). */
  configOptions?: SO101ConfigOptions;
}

/**
 * The SO-101: one follower arm on its Feetech servos with a wrist camera, whose kinematics and planning run in the
 * caller's thread.
 */
export class SO101Robot<Image = unknown>
  extends BaseRobot<SO101RobotConfig, SO101Config, Image>
  implements SO101HomingRobot
{
  static override readonly NAME: string = "so101";
  static override readonly TITLE: string = "SO-101";
  static override readonly SUBTITLE: string = "SINGLE-ARM ROBOTICS";
  static override readonly ARMS_TEXT: string = "One arm";
  static override readonly CAMERAS = [WristCamera.CAMERA];
  static override readonly ACTION_FORMATS = { [SINGLE_ARM_POSE_FORMAT.name]: SINGLE_ARM_POSE_FORMAT };
  /** Shoulder pan, Shoulder lift, ... */
  static override readonly JOINT_NAMES: readonly string[] = JOINTS.map((joint) => {
    const words = joint.replaceAll("_", " ");
    return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
  });

  static override readonly CONTROL_LOOP_CLASS: ControlLoopClass = SO101ControlLoop;
  /** The model of the arm that Cartesian actions are solved on. */
  static readonly KINEMATICS_CLASS: new (robotConfig: SO101RobotConfig) => SO101Kinematics = SO101Kinematics;
  static override readonly ACTION_ADAPTER: ActionAdapter<unknown> = new ActionAdapter(
    JointPositions,
    SingleArmDelta,
    GripperAction,
  );
  static override readonly JOINT_ACTION_CLASS = JointPositions;

  declare kinematics: SO101Kinematics | null;
  declare protected readonly options: SO101RobotOptions<Image>;

  // PEAR's constructor loads a Cartesian robot's kinematics, before the page connects, because their first load
  // takes seconds; the kinematics of pear.js load nothing, so they are made when the session opens
  constructor(config: StationConfig<SO101Config>, options: SO101RobotOptions<Image> = {}) {
    super(config, options);
  }

  /** The class of this robot, for what an SO-101's class holds beyond every robot's. */
  protected get so101Class(): typeof SO101Robot {
    return this.constructor as typeof SO101Robot;
  }

  protected override makeRobotConfig(settings: SO101Config): SO101RobotConfig {
    return new SO101RobotConfig(settings, this.options.configOptions ?? {});
  }

  /** Returns the SO-101's own driver on the line the robot was given. */
  protected override makeDriver(
    controlConfig: ControlConfig,
    robotConfig: SO101RobotConfig,
  ): JointDriver<any> | Promise<JointDriver<any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const line = this.options.line ?? null;
    if (line === null) {
      throw new RuntimeError("The SO-101 was given no line to its servos");
    }

    return SO101Driver.fromConfig(controlConfig, robotConfig, { clock: this.clock, ...line });
  }

  /** Returns a new source of the robot's camera, which the caller closes. */
  openCameras(): WristCamera<Image> {
    const frames = this.options.wristFrames ?? null;
    if (frames === null) {
      throw new RuntimeError("The SO-101 was given no wrist camera");
    }

    return new WristCamera(this.robotConfig, frames, { clock: this.clock });
  }

  /** Opens the gripper and returns the arm directly Home; an SO-101 Home takes no options. */
  override home(options: HomeOptions = {}): Promise<HomeReport> {
    return super.home(options);
  }

  /** Makes the kinematics the session's, before the motors are enabled. */
  override openPlanner(): void {
    if (this._robotConfig.geometry === null) {
      throw new ValueError("Cartesian motion requires geometry");
    }

    this.kinematics = new this.so101Class.KINEMATICS_CLASS(this.robotConfig);
  }

  /** Forgets the session's kinematics. */
  override closePlanner(): void {
    this.kinematics = null;
  }

  /** Returns what the model reads of the measured `jointPositions` in the action format `formatName`. */
  override modelState(jointPositions: ArrayLike<number>, formatName: string): ModelState {
    this.checkFormat(formatName);
    if (this.kinematics === null) {
      throw new RuntimeError("Open a Cartesian Station first");
    }

    return modelStateOf(this.kinematics, jointPositions);
  }

  /**
   * Returns the arm move and the gripper request of `action` from `observation`, which the arm must still hold
   * before and after; refused once `deadline` has passed.
   */
  override plan(observation: Observation, action: unknown, options: { deadline: number | null }): PreparedAction<boolean> {
    this.remainingS(options.deadline, this.robotClass.PLANNING_TIMEOUT_S); // planning runs in this thread: refused once late

    return this.runWhileObservationHolds(observation, () =>
      // (a robot without kinematics, in joint mode, fails as PEAR's does: at the kinematics' first use)
      SO101Planning.checkedAction(this._robotConfig, this.kinematics as SO101Kinematics, observation, action),
    );
  }

  /**
   * Runs `planningStep` bound to `observation`, whose operation the arm must hold before and after, and returns
   * what it returns.
   */
  runWhileObservationHolds<Planned>(observation: Observation, planningStep: () => Planned): Planned {
    this.verifyObservation(observation);
    const planned = planningStep();
    this.verifyObservation(observation);

    return planned;
  }

  /**
   * Returns the result of `action` from a control snapshot or the robot's status; a pose delta's carries the model's
   * state of the measured joints.
   */
  override result(
    snapshot: ControlSnapshot | DetailedStatus | BriefStatus,
    options: ResultOptions = {},
  ): SO101MotionResult {
    const gripperReport = options.gripperReport ?? null;

    return SO101MotionResult.fromSnapshot(snapshot, {
      status: options.status ?? MotionStatus.COMPLETED,
      error: options.error ?? null,
      kinematics: SingleArmDelta.isInstance(options.action) ? this.kinematics : null,
      gripperOutcome: gripperReport === null ? null : (gripperReport["outcome"] as string),
      log: this.resultLog,
    });
  }

  /**
   * Returns the result of an action of the format `formatName` that did not complete, measured at `snapshot` (by
   * default now), with the model's state of the measured joints.
   */
  override failureResult(
    error: unknown,
    options: {
      formatName: string;
      status?: MotionStatus;
      snapshot?: ControlSnapshot | DetailedStatus | BriefStatus | null;
    },
  ): SO101MotionResult {
    this.checkFormat(options.formatName);

    return SO101MotionResult.fromSnapshot(options.snapshot ?? this.status(true), {
      status: options.status ?? MotionStatus.FAILED,
      error,
      kinematics: this.kinematics,
      log: this.resultLog,
    });
  }

  /**
   * Plans Home, has `approvePlan` approve the plan and runs it under `guard` by `deadline`, and returns the Home
   * report.
   */
  override runHome(guard: ActionGuard, options: RunHomeOptions): Promise<HomeReport> {
    return new SO101Homing(this, guard, options.reportProgress).run({
      approvePlan: options.approvePlan,
      deadline: options.deadline,
    });
  }

  /** What the results tell the robot's log, under their own logger's name. */
  private get resultLog(): (level: "error", message: string, error?: unknown) => void {
    return (level, message, error) => this.log("results", level, message, error);
  }
}

export { ActionMode };
