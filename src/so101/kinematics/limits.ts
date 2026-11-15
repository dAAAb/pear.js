// PEAR's `JointLimits` (pear/deploy/station/control/joint/limits.py) is ported whole in the station's joint layer.
// The kinematics use its position bounds (`check_positions`) and `RobotConfig.joint_limits` for the SO-101's one arm.

export { JointLimits } from "../../station/joint/limits";
