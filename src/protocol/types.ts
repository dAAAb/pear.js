// Ports the SO-101's models of state, action and result:
//   pear/deploy/station/control/robots/so101/motion/actions.py (ArmQuantities, ModelState, SingleArmDelta)
//   pear/deploy/station/control/motion/actions.py (GripperQuantity)
//   pear/deploy/station/control/motion/results.py (MotionStatus, MotionResult)
//   pear/deploy/station/control/robots/so101/joint/grippers.py (GripperOutcome)
//   pear/deploy/station/control/robots/so101/formats.py (SINGLE_ARM_POSE_FORMAT: its name, schema, decimals, camera)

/** What the model reads and changes of the arm, in the order it reads them (SO101Kinematics.ARM_QUANTITIES). */
export const ARM_QUANTITIES = ["x", "y", "z", "pitch", "roll"] as const;

/** The SO-101's one action format. */
export const FORMAT_NAME = "single_arm_pose";

/** The parts and the quantities an action sets, in the order the model reads them. */
export const SCHEMA = { arm: ARM_QUANTITIES, gripper: ["width"] } as const;

/** Decimal places of each quantity in an observation (SO101Kinematics.DECIMALS): 0.1 cm, 0.01 rad. */
export const DECIMALS = { x: 1, y: 1, z: 1, pitch: 2, roll: 2, width: 1 } as const;

/** What the model and saved files call the cameras whose frames a turn shows, in order (WristCamera.CAMERA). */
export const CAMERA_NAMES = ["wrist"] as const;

/** The arm's pose: the fixed fingertip's position in cm, the pitch below horizontal and the roll about the
 * pointing axis in rad. In an action, the change of each. */
export interface ArmQuantities {
  x: number;
  y: number;
  z: number;
  pitch: number;
  roll: number;
}

/** The gripper's one quantity. In a state, the width PEAR's kinematics give the measured opening; in an action,
 * only its sign counts: positive opens fully, negative closes, zero holds. */
export interface GripperQuantity {
  width: number;
}

/** What the model reads of the measured joints. */
export interface ModelState {
  arm: ArmQuantities;
  gripper: GripperQuantity;
}

/** One model turn's action: the arm's changes (all zero keeps the arm held) and what the gripper does. */
export interface SingleArmDelta {
  type: "single_arm_delta";
  arm: ArmQuantities;
  gripper: GripperQuantity;
}

/** How an action ended, by the word its result carries. */
export const MotionStatus = {
  COMPLETED: "completed",
  /** Refused before anything was sent to the arm. */
  REJECTED: "rejected",
  FAILED: "failed",
} as const;
export type MotionStatus = (typeof MotionStatus)[keyof typeof MotionStatus];

/** How the jaw's operation ended. */
export const GripperOutcome = {
  OPEN: "open",
  CLOSED: "closed",
  /** It came to rest on an object: blocked, never a confirmed grasp. */
  STOPPED_BEFORE_CLOSED: "stopped_before_closed",
} as const;
export type GripperOutcome = (typeof GripperOutcome)[keyof typeof GripperOutcome];

/** What ended an action: in PEAR the class name of the Python exception and its message. */
export interface MotionError {
  code: string;
  message: string;
}

/** The code of a pose the offline inverse kinematics refused (PEAR's UnreachablePoseError): nothing was commanded.
 * Its message comes from the kinematics (SO101Kinematics.unreachable_message). */
export const UNREACHABLE_POSE_ERROR = "UnreachablePoseError";

/** The outcome of an action. */
export interface MotionResult {
  status: MotionStatus;
  isSettled: boolean;
  /** The action completed, the arm arrived and the jaw was not stopped before it closed. */
  targetReached: boolean;
  /** The measured joint vector (rad, the gripper's opening last); null of a robot that is closed. */
  measuredPosition: number[] | null;
  /** The measured joints' signed errors against what the action requested. */
  trackingError: number[] | null;
  /** What the model reads of the measured joints. */
  measuredState: ModelState | null;
  /** How the jaw ended, when the action moved it. */
  gripperOutcome: GripperOutcome | null;
  error: MotionError | null;
}
