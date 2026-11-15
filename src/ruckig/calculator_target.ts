// Ports include/ruckig/calculator_target.hpp of Ruckig 0.15.3 (https://github.com/pantor/ruckig), in the form the
// Python module is built from: an error of the calculation is thrown (the C++'s `throw_error`).
// Copyright (c) 2021 Lars Berscheid, MIT licence (see LICENSE in this folder).
//
// A calculator keeps its blocks from one calculation to the next, as the C++'s does: a few paths (a coordinate that
// is not enabled, a cap of zero) leave parts of them as the last calculation set them.

import { Block } from "./block";
import { RuckigError } from "./error";
import type { InputParameter } from "./input_parameter";
import { ControlInterface, DurationDiscretization, Synchronization } from "./input_parameter";
import { PositionFirstOrderStep1 } from "./position_first_step1";
import { PositionFirstOrderStep2 } from "./position_first_step2";
import { PositionSecondOrderStep1 } from "./position_second_step1";
import { PositionSecondOrderStep2 } from "./position_second_step2";
import { PositionThirdOrderStep1 } from "./position_third_step1";
import { PositionThirdOrderStep2 } from "./position_third_step2";
import { ControlSigns, Direction, ReachedLimits } from "./profile";
import { Result } from "./result";
import { DBL_EPSILON } from "./roots";
import { stdSort } from "./sort";
import type { Trajectory } from "./trajectory";
import { toStringDouble } from "./utils";
import { VelocitySecondOrderStep1 } from "./velocity_second_step1";
import { VelocitySecondOrderStep2 } from "./velocity_second_step2";
import { VelocityThirdOrderStep1 } from "./velocity_third_step1";
import { VelocityThirdOrderStep2 } from "./velocity_third_step2";

const eps = DBL_EPSILON;
const return_error_at_maximal_duration = true;

function isinf(value: number): boolean {
  return value === Infinity || value === -Infinity;
}

/** The vectors of an input, read once for a calculation. */
interface InputVectors {
  current_position: readonly number[];
  current_velocity: readonly number[];
  current_acceleration: readonly number[];
  target_position: readonly number[];
  target_velocity: readonly number[];
  target_acceleration: readonly number[];
  max_velocity: readonly number[];
  max_acceleration: readonly number[];
  max_jerk: readonly number[];
}

/** Calculation class for a state-to-state trajectory. */
export class TargetCalculator {
  readonly degreesOfFreedom: number;

  // For phase synchronization
  private readonly new_phase_control: number[];
  private readonly pd: number[];
  private readonly possible_t_syncs: number[];
  private readonly idx: number[];

  private readonly blocks: Block[];
  private readonly inp_min_velocity: number[];
  private readonly inp_min_acceleration: number[];

  private readonly inp_per_dof_control_interface: ControlInterface[];
  private readonly inp_per_dof_synchronization: Synchronization[];

  /** The DoF that doesn't need step 2 */
  private limiting_dof: number | undefined = undefined;

  constructor(dofs: number) {
    this.degreesOfFreedom = dofs;
    const zeros = (length: number): number[] => new Array<number>(length).fill(0.0);
    this.blocks = Array.from({ length: dofs }, () => new Block());
    this.inp_min_velocity = zeros(dofs);
    this.inp_min_acceleration = zeros(dofs);
    this.inp_per_dof_control_interface = new Array<ControlInterface>(dofs).fill(ControlInterface.Position);
    this.inp_per_dof_synchronization = new Array<Synchronization>(dofs).fill(Synchronization.Time);
    this.new_phase_control = zeros(dofs);
    this.pd = zeros(dofs);
    this.possible_t_syncs = zeros(3*dofs+1);
    this.idx = zeros(3*dofs+1);
  }

  /** Is the trajectory (in principle) phase synchronizable? */
  private isInputCollinear(inp: InputVectors, limiting_direction: Direction, limiting_dof: number): boolean {
    const { degreesOfFreedom, pd, new_phase_control, inp_per_dof_control_interface, inp_per_dof_synchronization } = this;

    // Check that vectors pd, v0, a0, vf, af are collinear
    for (let dof = 0; dof < degreesOfFreedom; ++dof) {
      pd[dof] = inp.target_position[dof] - inp.current_position[dof];
    }

    let scale_vector: readonly number[] | undefined = undefined;
    let scale_dof: number | undefined = undefined; // Need to find a scale DOF because limiting DOF might not be phase synchronized
    for (let dof = 0; dof < degreesOfFreedom; ++dof) {
      if (inp_per_dof_synchronization[dof] !== Synchronization.Phase) {
        continue;
      }

      if (inp_per_dof_control_interface[dof] === ControlInterface.Position && Math.abs(pd[dof]) > eps) {
        scale_vector = pd;
        scale_dof = dof;
        break;

      } else if (Math.abs(inp.current_velocity[dof]) > eps) {
        scale_vector = inp.current_velocity;
        scale_dof = dof;
        break;

      } else if (Math.abs(inp.current_acceleration[dof]) > eps) {
        scale_vector = inp.current_acceleration;
        scale_dof = dof;
        break;

      } else if (Math.abs(inp.target_velocity[dof]) > eps) {
        scale_vector = inp.target_velocity;
        scale_dof = dof;
        break;

      } else if (Math.abs(inp.target_acceleration[dof]) > eps) {
        scale_vector = inp.target_acceleration;
        scale_dof = dof;
        break;
      }
    }

    if (scale_dof === undefined || scale_vector === undefined) {
      return false; // Zero everywhere is in theory collinear, but that trivial case is better handled elsewhere
    }

    const scale = scale_vector[scale_dof];
    const pd_scale = pd[scale_dof] / scale;
    const v0_scale = inp.current_velocity[scale_dof] / scale;
    const vf_scale = inp.target_velocity[scale_dof] / scale;
    const a0_scale = inp.current_acceleration[scale_dof] / scale;
    const af_scale = inp.target_acceleration[scale_dof] / scale;

    const scale_limiting = scale_vector[limiting_dof];
    let control_limiting = (limiting_direction === Direction.UP) ? inp.max_jerk[limiting_dof] : -inp.max_jerk[limiting_dof];
    if (isinf(inp.max_jerk[limiting_dof])) {
      control_limiting = (limiting_direction === Direction.UP) ? inp.max_acceleration[limiting_dof] : this.inp_min_acceleration[limiting_dof];
    }

    for (let dof = 0; dof < degreesOfFreedom; ++dof) {
      if (inp_per_dof_synchronization[dof] !== Synchronization.Phase) {
        continue;
      }

      const current_scale = scale_vector[dof];
      if (
        (inp_per_dof_control_interface[dof] === ControlInterface.Position && Math.abs(pd[dof] - pd_scale * current_scale) > eps)
        || Math.abs(inp.current_velocity[dof] - v0_scale * current_scale) > eps
        || Math.abs(inp.current_acceleration[dof] - a0_scale * current_scale) > eps
        || Math.abs(inp.target_velocity[dof] - vf_scale * current_scale) > eps
        || Math.abs(inp.target_acceleration[dof] - af_scale * current_scale) > eps
      ) {
        return false;
      }

      new_phase_control[dof] = control_limiting * current_scale / scale_limiting;
    }

    return true;
  }

  /**
   * Finds the shortest duration no coordinate is blocked at, not below `t_min`: writes it to the trajectory, sets
   * the limiting coordinate and its profile, and returns whether there is one.
   */
  private synchronize(t_min: number | undefined, traj: Trajectory, discrete_duration: boolean, delta_time: number): boolean {
    const { degreesOfFreedom, possible_t_syncs, idx, blocks, inp_per_dof_synchronization } = this;
    const profiles = traj._profiles[0];

    // Possible t_syncs are the start times of the intervals and optional t_min
    let any_interval = false;
    for (let dof = 0; dof < degreesOfFreedom; ++dof) {
      // Ignore DoFs without synchronization here
      if (inp_per_dof_synchronization[dof] === Synchronization.No) {
        possible_t_syncs[dof] = 0.0;
        possible_t_syncs[degreesOfFreedom + dof] = Infinity;
        possible_t_syncs[2 * degreesOfFreedom + dof] = Infinity;
        continue;
      }

      const { a, b } = blocks[dof];
      possible_t_syncs[dof] = blocks[dof].t_min;
      possible_t_syncs[degreesOfFreedom + dof] = a !== undefined ? a.right : Infinity;
      possible_t_syncs[2 * degreesOfFreedom + dof] = b !== undefined ? b.right : Infinity;
      any_interval = any_interval || a !== undefined || b !== undefined;
    }
    possible_t_syncs[3 * degreesOfFreedom] = t_min !== undefined ? t_min : Infinity;
    any_interval = any_interval || t_min !== undefined;

    if (discrete_duration) {
      for (let i = 0; i < possible_t_syncs.length; ++i) {
        if (isinf(possible_t_syncs[i])) {
          continue;
        }

        const remainder = possible_t_syncs[i] % delta_time; // in [0, delta_time)
        if (remainder > eps) {
          possible_t_syncs[i] += delta_time - remainder;
        }
      }
    }

    // Test them in sorted order
    const idx_end = any_interval ? idx.length : degreesOfFreedom;
    for (let i = 0; i < idx_end; ++i) {
      idx[i] = i;
    }
    stdSort(idx, (i, j) => possible_t_syncs[i] < possible_t_syncs[j], 0, idx_end);

    // Start at last tmin (or worse)
    for (let i = degreesOfFreedom - 1; i !== idx_end; ++i) {
      const possible_t_sync = possible_t_syncs[idx[i]];
      let is_blocked = false;
      for (let dof = 0; dof < degreesOfFreedom; ++dof) {
        if (inp_per_dof_synchronization[dof] === Synchronization.No) {
          continue; // inner dof loop
        }
        if (blocks[dof].isBlocked(possible_t_sync)) {
          is_blocked = true;
          break; // inner dof loop
        }
      }
      if (is_blocked || possible_t_sync < (t_min !== undefined ? t_min : 0.0) || isinf(possible_t_sync)) {
        continue;
      }

      traj._duration = possible_t_sync;
      if (idx[i] === 3*degreesOfFreedom) { // Optional t_min
        this.limiting_dof = undefined;
        return true;
      }

      const quot = Math.trunc(idx[i] / degreesOfFreedom);
      const rem = idx[i] % degreesOfFreedom;
      this.limiting_dof = rem;
      switch (quot) {
        case 0: {
          profiles[rem].assign(blocks[rem].p_min);
        } break;
        case 1: {
          const { a } = blocks[rem];
          if (a !== undefined) {
            profiles[rem].assign(a.profile);
          }
        } break;
        case 2: {
          const { b } = blocks[rem];
          if (b !== undefined) {
            profiles[rem].assign(b.profile);
          }
        } break;
      }
      return true;
    }

    return false;
  }

  /** Calculate the time-optimal waypoint-based trajectory */
  calculate(inp: InputParameter, traj: Trajectory, delta_time: number): Result {
    const { degreesOfFreedom, blocks, inp_min_velocity, inp_min_acceleration, inp_per_dof_control_interface, inp_per_dof_synchronization, new_phase_control } = this;
    const profiles = traj._profiles[0];

    const vectors: InputVectors = {
      current_position: inp.currentPosition,
      current_velocity: inp.currentVelocity,
      current_acceleration: inp.currentAcceleration,
      target_position: inp.targetPosition,
      target_velocity: inp.targetVelocity,
      target_acceleration: inp.targetAcceleration,
      max_velocity: inp.maxVelocity,
      max_acceleration: inp.maxAcceleration,
      max_jerk: inp.maxJerk,
    };
    const { current_position, current_velocity, current_acceleration, target_position, target_velocity, target_acceleration, max_velocity, max_acceleration, max_jerk } = vectors;
    const min_velocity = inp.minVelocity;
    const min_acceleration = inp.minAcceleration;
    const per_dof_control_interface = inp.perDofControlInterface;
    const per_dof_synchronization = inp.perDofSynchronization;
    const enabled = inp.enabled;

    for (let dof = 0; dof < degreesOfFreedom; ++dof) {
      const p = profiles[dof];

      inp_min_velocity[dof] = min_velocity !== undefined ? min_velocity[dof] : -max_velocity[dof];
      inp_min_acceleration[dof] = min_acceleration !== undefined ? min_acceleration[dof] : -max_acceleration[dof];
      inp_per_dof_control_interface[dof] = per_dof_control_interface !== undefined ? per_dof_control_interface[dof] : inp.controlInterface;
      inp_per_dof_synchronization[dof] = per_dof_synchronization !== undefined ? per_dof_synchronization[dof] : inp.synchronization;

      if (!enabled[dof]) {
        p.p[7] = current_position[dof];
        p.v[7] = current_velocity[dof];
        p.a[7] = current_acceleration[dof];
        p.tSum[6] = 0.0;
        blocks[dof].t_min = 0.0;
        blocks[dof].a = undefined;
        blocks[dof].b = undefined;
        continue;
      }

      // Calculate brake (if input exceeds or will exceed limits)
      switch (inp_per_dof_control_interface[dof]) {
        case ControlInterface.Position: {
          if (!isinf(max_jerk[dof])) {
            p.brake.getPositionBrakeTrajectory(current_velocity[dof], current_acceleration[dof], max_velocity[dof], inp_min_velocity[dof], max_acceleration[dof], inp_min_acceleration[dof], max_jerk[dof]);
          } else if (!isinf(max_acceleration[dof])) {
            p.brake.getSecondOrderPositionBrakeTrajectory(current_velocity[dof], max_velocity[dof], inp_min_velocity[dof], max_acceleration[dof], inp_min_acceleration[dof]);
          }
          p.setBoundary(current_position[dof], current_velocity[dof], current_acceleration[dof], target_position[dof], target_velocity[dof], target_acceleration[dof]);
        } break;
        case ControlInterface.Velocity: {
          if (!isinf(max_jerk[dof])) {
            p.brake.getVelocityBrakeTrajectory(current_acceleration[dof], max_acceleration[dof], inp_min_acceleration[dof], max_jerk[dof]);
          } else {
            p.brake.getSecondOrderVelocityBrakeTrajectory();
          }
          p.setBoundaryForVelocity(current_position[dof], current_velocity[dof], current_acceleration[dof], target_velocity[dof], target_acceleration[dof]);
        } break;
      }

      // Finalize pre & post-trajectories
      if (!isinf(max_jerk[dof])) {
        p.brake.finalize(p.p, p.v, p.a);
      } else if (!isinf(max_acceleration[dof])) {
        p.brake.finalizeSecondOrder(p.p, p.v, p.a);
      }

      let found_profile = false;
      switch (inp_per_dof_control_interface[dof]) {
        case ControlInterface.Position: {
          if (!isinf(max_jerk[dof])) {
            const step1 = new PositionThirdOrderStep1(p.p[0], p.v[0], p.a[0], p.pf, p.vf, p.af, max_velocity[dof], inp_min_velocity[dof], max_acceleration[dof], inp_min_acceleration[dof], max_jerk[dof]);
            found_profile = step1.getProfile(p, blocks[dof]);
          } else if (!isinf(max_acceleration[dof])) {
            const step1 = new PositionSecondOrderStep1(p.p[0], p.v[0], p.pf, p.vf, max_velocity[dof], inp_min_velocity[dof], max_acceleration[dof], inp_min_acceleration[dof]);
            found_profile = step1.getProfile(p, blocks[dof]);
          } else {
            const step1 = new PositionFirstOrderStep1(p.p[0], p.pf, max_velocity[dof], inp_min_velocity[dof]);
            found_profile = step1.getProfile(p, blocks[dof]);
          }
        } break;
        case ControlInterface.Velocity: {
          if (!isinf(max_jerk[dof])) {
            const step1 = new VelocityThirdOrderStep1(p.v[0], p.a[0], p.vf, p.af, max_acceleration[dof], inp_min_acceleration[dof], max_jerk[dof]);
            found_profile = step1.getProfile(p, blocks[dof]);
          } else {
            const step1 = new VelocitySecondOrderStep1(p.v[0], p.vf, max_acceleration[dof], inp_min_acceleration[dof]);
            found_profile = step1.getProfile(p, blocks[dof]);
          }
        } break;
      }

      if (!found_profile) {
        const has_zero_limits = (max_acceleration[dof] === 0.0 || inp_min_acceleration[dof] === 0.0 || max_jerk[dof] === 0.0);
        if (has_zero_limits) {
          throw new RuckigError(`zero limits conflict in step 1, dof: ${dof} input: ${inp.toString()}`);

        } else {
          throw new RuckigError(`error in step 1, dof: ${dof} input: ${inp.toString()}`);
        }
      }

      traj._independentMinDurations[dof] = blocks[dof].t_min;
    }

    const discrete_duration = (inp.durationDiscretization === DurationDiscretization.Discrete);
    if (degreesOfFreedom === 1 && inp.minimumDuration === undefined && !discrete_duration) {
      traj._duration = blocks[0].t_min;
      profiles[0].assign(blocks[0].p_min);
      traj._cumulativeTimes[0] = traj._duration;
      return Result.Working;
    }

    this.limiting_dof = undefined;
    const found_synchronization = this.synchronize(inp.minimumDuration, traj, discrete_duration, delta_time);
    if (!found_synchronization) {
      let has_zero_limits = false;
      for (let dof = 0; dof < degreesOfFreedom; ++dof) {
        if (max_acceleration[dof] === 0.0 || inp_min_acceleration[dof] === 0.0 || max_jerk[dof] === 0.0) {
          has_zero_limits = true;
          break;
        }
      }

      if (has_zero_limits) {
        throw new RuckigError(`zero limits conflict with other degrees of freedom in time synchronization ${toStringDouble(traj._duration)}`);

      } else {
        throw new RuckigError(`error in time synchronization: ${toStringDouble(traj._duration)}`);
      }
    }

    // None Synchronization
    for (let dof = 0; dof < degreesOfFreedom; ++dof) {
      if (enabled[dof] && inp_per_dof_synchronization[dof] === Synchronization.No) {
        profiles[dof].assign(blocks[dof].p_min);
        if (blocks[dof].t_min > traj._duration) {
          traj._duration = blocks[dof].t_min;
          this.limiting_dof = dof;
        }
      }
    }
    traj._cumulativeTimes[0] = traj._duration;

    if (return_error_at_maximal_duration) {
      if (traj._duration > 7.6e3) {
        return Result.ErrorTrajectoryDuration;
      }
    }

    if (traj._duration === 0.0) {
      // Copy all profiles for end state
      for (let dof = 0; dof < degreesOfFreedom; ++dof) {
        profiles[dof].assign(blocks[dof].p_min);
      }
      return Result.Working;
    }

    if (!discrete_duration && inp_per_dof_synchronization.every((s) => s === Synchronization.No)) {
      return Result.Working;
    }

    // Phase Synchronization
    const limiting_dof = this.limiting_dof;
    if (limiting_dof !== undefined && inp_per_dof_synchronization.some((s) => s === Synchronization.Phase)) {
      const p_limiting = profiles[limiting_dof];
      if (this.isInputCollinear(vectors, p_limiting.direction, limiting_dof)) {
        let found_time_synchronization = true;
        for (let dof = 0; dof < degreesOfFreedom; ++dof) {
          if (!enabled[dof] || dof === limiting_dof || inp_per_dof_synchronization[dof] !== Synchronization.Phase) {
            continue;
          }

          const p = profiles[dof];
          const t_profile = traj._duration - p.brake.duration - p.accel.duration;

          for (let i = 0; i < 7; ++i) {
            p.t[i] = p_limiting.t[i]; // Copy timing information from limiting DoF
          }
          p.controlSigns = p_limiting.controlSigns;

          // Profile::ReachedLimits::NONE is a small hack, as there is no specialization for that in the check function
          // (the C++ combines the checks with &=, which makes every check whatever the ones before returned)
          let checked = true;
          switch (inp_per_dof_control_interface[dof]) {
            case ControlInterface.Position: {
              switch (p.controlSigns) {
                case ControlSigns.UDDU: {
                  if (!isinf(max_jerk[dof])) {
                    checked = p.checkWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, t_profile, new_phase_control[dof], max_velocity[dof], inp_min_velocity[dof], max_acceleration[dof], inp_min_acceleration[dof], max_jerk[dof]);
                  } else if (!isinf(max_acceleration[dof])) {
                    checked = p.checkForSecondOrderWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, t_profile, new_phase_control[dof], -new_phase_control[dof], max_velocity[dof], inp_min_velocity[dof], max_acceleration[dof], inp_min_acceleration[dof]);
                  } else {
                    checked = p.checkForFirstOrderWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, t_profile, new_phase_control[dof], max_velocity[dof], inp_min_velocity[dof]);
                  }
                } break;
                case ControlSigns.UDUD: {
                  if (!isinf(max_jerk[dof])) {
                    checked = p.checkWithTiming(ControlSigns.UDUD, ReachedLimits.NONE, t_profile, new_phase_control[dof], max_velocity[dof], inp_min_velocity[dof], max_acceleration[dof], inp_min_acceleration[dof], max_jerk[dof]);
                  } else {
                    checked = p.checkForSecondOrderWithTiming(ControlSigns.UDUD, ReachedLimits.NONE, t_profile, new_phase_control[dof], -new_phase_control[dof], max_velocity[dof], inp_min_velocity[dof], max_acceleration[dof], inp_min_acceleration[dof]);
                  }
                } break;
              }
            } break;
            case ControlInterface.Velocity: {
              switch (p.controlSigns) {
                case ControlSigns.UDDU: {
                  if (!isinf(max_jerk[dof])) {
                    checked = p.checkForVelocityWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, t_profile, new_phase_control[dof], max_acceleration[dof], inp_min_acceleration[dof], max_jerk[dof]);
                  } else {
                    checked = p.checkForSecondOrderVelocityWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, t_profile, new_phase_control[dof], max_acceleration[dof], inp_min_acceleration[dof]);
                  }
                } break;
                case ControlSigns.UDUD: {
                  if (!isinf(max_jerk[dof])) {
                    checked = p.checkForVelocityWithTiming(ControlSigns.UDUD, ReachedLimits.NONE, t_profile, new_phase_control[dof], max_acceleration[dof], inp_min_acceleration[dof], max_jerk[dof]);
                  } else {
                    checked = p.checkForSecondOrderVelocityWithTiming(ControlSigns.UDUD, ReachedLimits.NONE, t_profile, new_phase_control[dof], max_acceleration[dof], inp_min_acceleration[dof]);
                  }
                } break;
              }
            } break;
          }
          found_time_synchronization = found_time_synchronization && checked;

          p.limits = p_limiting.limits; // After check method call to set correct limits
        }

        if (found_time_synchronization && inp_per_dof_synchronization.every((s) => s === Synchronization.Phase || s === Synchronization.No)) {
          return Result.Working;
        }
      }
    }

    // Time Synchronization
    for (let dof = 0; dof < degreesOfFreedom; ++dof) {
      const skip_synchronization = (dof === limiting_dof || inp_per_dof_synchronization[dof] === Synchronization.No) && !discrete_duration;
      if (!enabled[dof] || skip_synchronization) {
        continue;
      }

      const p = profiles[dof];
      const t_profile = traj._duration - p.brake.duration - p.accel.duration;

      if (inp_per_dof_synchronization[dof] === Synchronization.TimeIfNecessary && Math.abs(target_velocity[dof]) < eps && Math.abs(target_acceleration[dof]) < eps) {
        p.assign(blocks[dof].p_min);
        continue;
      }

      // Check if the final time corresponds to an extremal profile calculated in step 1
      // Use 2*eps because of numerical robustness in duration discretization
      const { a, b } = blocks[dof];
      if (Math.abs(t_profile - blocks[dof].t_min) < 2*eps) {
        p.assign(blocks[dof].p_min);
        continue;
      } else if (a !== undefined && Math.abs(t_profile - a.right) < 2*eps) {
        p.assign(a.profile);
        continue;
      } else if (b !== undefined && Math.abs(t_profile - b.right) < 2*eps) {
        p.assign(b.profile);
        continue;
      }

      let found_time_synchronization = false;
      switch (inp_per_dof_control_interface[dof]) {
        case ControlInterface.Position: {
          if (!isinf(max_jerk[dof])) {
            const step2 = new PositionThirdOrderStep2(t_profile, p.p[0], p.v[0], p.a[0], p.pf, p.vf, p.af, max_velocity[dof], inp_min_velocity[dof], max_acceleration[dof], inp_min_acceleration[dof], max_jerk[dof]);
            found_time_synchronization = step2.getProfile(p);
          } else if (!isinf(max_acceleration[dof])) {
            const step2 = new PositionSecondOrderStep2(t_profile, p.p[0], p.v[0], p.pf, p.vf, max_velocity[dof], inp_min_velocity[dof], max_acceleration[dof], inp_min_acceleration[dof]);
            found_time_synchronization = step2.getProfile(p);
          } else {
            const step2 = new PositionFirstOrderStep2(t_profile, p.p[0], p.pf, max_velocity[dof], inp_min_velocity[dof]);
            found_time_synchronization = step2.getProfile(p);
          }
        } break;
        case ControlInterface.Velocity: {
          if (!isinf(max_jerk[dof])) {
            const step2 = new VelocityThirdOrderStep2(t_profile, p.v[0], p.a[0], p.vf, p.af, max_acceleration[dof], inp_min_acceleration[dof], max_jerk[dof]);
            found_time_synchronization = step2.getProfile(p);
          } else {
            const step2 = new VelocitySecondOrderStep2(t_profile, p.v[0], p.vf, max_acceleration[dof], inp_min_acceleration[dof]);
            found_time_synchronization = step2.getProfile(p);
          }
        } break;
      }
      if (!found_time_synchronization) {
        throw new RuckigError(`error in step 2 in dof: ${dof} for t sync: ${toStringDouble(traj._duration)} input: ${inp.toString()}`);
      }
    }

    return Result.Working;
  }
}
