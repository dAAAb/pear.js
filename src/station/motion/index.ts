// The motion layer every robot's station shares: PEAR's pear/deploy/station/control/motion, without its kinematics
// (motion/kinematics.py is ported with the SO-101's, in src/so101/kinematics).

export {
  ActionAdapter,
  defineStrictModel,
  GripperQuantity,
  JointPositions,
  ValidationError,
  type StrictFieldSchema,
  type StrictModelClass,
  type StrictModelDefinition,
  type StrictModelField,
} from "./actions";
export { controlLoopOf, Execution } from "./execution";
export { HomeFailed, HomeStage, Homing, type ApprovePlan, type ArmAccuracy, type ReportHomeProgress } from "./homing";
export { HomePlanning, HomePlanningError, PreparedAction, type PlanningObservation } from "./planning";
export {
  MotionResult,
  MotionStatus,
  resultRecord,
  type MotionError,
  type MotionResultBuildOptions,
  type MotionResultFields,
  type MotionResultInit,
  type ResultLog,
} from "./results";
