// Ruckig 0.15.3 (community edition, https://github.com/pantor/ruckig, MIT licence: see LICENSE in this folder) in
// TypeScript: jerk-limited trajectories from any state to a target state, calculated at once or one control period
// at a time.
//
// The interface is the Python module's with the names in camelCase:
//
//   const generator = new Ruckig(6, 0.02);          // degrees of freedom, control period in s
//   const input = new InputParameter(6);
//   const output = new OutputParameter(6);
//   input.currentPosition = [...];  input.targetPosition = [...];
//   input.maxVelocity = [...];  input.maxAcceleration = [...];  input.maxJerk = [...];
//   while (generator.update(input, output) === Result.Working) {
//     send(output.newPosition);
//     output.passToInput(input);
//   }
//
// and for a whole trajectory: `new Ruckig(6).calculate(input, trajectory)`, then `trajectory.duration`,
// `trajectory.atTime(t)`, `trajectory.positionExtrema`.

export { Block, Interval } from "./block";
export { BrakeProfile } from "./brake";
export { TargetCalculator } from "./calculator_target";
export { RuckigError } from "./error";
export { ControlInterface, DurationDiscretization, InputParameter, Synchronization } from "./input_parameter";
export { ENGINE_LIBM, libm, replaceLibm, type Libm } from "./libm";
export { OutputParameter } from "./output_parameter";
export { ControlSigns, Direction, Profile, ReachedLimits, type Bound } from "./profile";
export { Result } from "./result";
export { Ruckig } from "./ruckig";
export { Trajectory } from "./trajectory";
