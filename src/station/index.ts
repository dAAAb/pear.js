// PEAR's station, the part that is the same for every robot (pear/deploy/station/control).
//
//   joint       the joint layer: configuration, limits, safety monitors, friction feedforward, the driver's interface
//   motion      the motion layer: the action models, the results, Home's planning, the action level and Home's flow
//   schemas     what the layers hand each other: snapshots, observations, statuses, an action format
//   exceptions  the station's own exception: the operator's pause (pear/deploy/station/exceptions.py)
//
// and, by name: the cameras a robot observes (cameras.py), the base of a robot's class and its action modes
// (robot.py).

export { CameraFeed, CameraSource, type CameraPreview } from "./cameras";
export * as exceptions from "./exceptions";
export * as joint from "./joint/index";
export * as motion from "./motion/index";
export {
  ActionMode,
  BaseRobot,
  type ControlLoopClass,
  type HomeOptions,
  type ResultOptions,
  type RobotLog,
  type RobotOptions,
  type RunHomeOptions,
  type StationConfig,
} from "./robot";
export * as schemas from "./schemas";
