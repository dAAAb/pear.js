// Ports include/ruckig/profile.hpp of Ruckig 0.15.3 (https://github.com/pantor/ruckig).
// Copyright (c) 2021 Lars Berscheid, MIT licence (see LICENSE in this folder).
//
// The names of the numbers are the C++'s, and every expression keeps the C++'s order of operations. What the C++
// passes as a template argument (the control signs, the reached limits, whether to set the limits) is an ordinary
// argument here.

import { BrakeProfile } from "./brake";
import { DBL_EPSILON, solveCubic } from "./roots";
import { integrate } from "./utils";

/** Information about the position extrema */
export interface Bound {
  /** The extreme position */
  min: number;
  max: number;
  /** Time when the positions are reached */
  tMin: number;
  tMax: number;
}

/** Which caps a profile reaches; the numbers are those of the C++ enumeration. */
export const ReachedLimits = {
  ACC0_ACC1_VEL: 0,
  VEL: 1,
  ACC0: 2,
  ACC1: 3,
  ACC0_ACC1: 4,
  ACC0_VEL: 5,
  ACC1_VEL: 6,
  NONE: 7,
} as const;
export type ReachedLimits = (typeof ReachedLimits)[keyof typeof ReachedLimits];

export const Direction = { UP: 0, DOWN: 1 } as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

/** The signs of the jerk over a profile's phases: up-down-down-up or up-down-up-down. */
export const ControlSigns = { UDDU: 0, UDUD: 1 } as const;
export type ControlSigns = (typeof ControlSigns)[keyof typeof ControlSigns];

const REACHED_LIMITS_NAMES = ["ACC0_ACC1_VEL", "VEL", "ACC0", "ACC1", "ACC0_ACC1", "ACC0_VEL", "ACC1_VEL", "NONE"];

const v_eps = 1e-12;
const a_eps = 1e-12;
const j_eps = 1e-12;

const p_precision = 1e-8;
const v_precision = 1e-8;
const a_precision = 1e-10;

const t_max = 1e12;

function check_position_extremum(t_ext: number, t_sum: number, t: number, p: number, v: number, a: number, j: number, ext: Bound): void {
  if (0 < t_ext && t_ext < t) {
    const [p_ext, , a_ext] = integrate(t_ext, p, v, a, j);
    if (a_ext > 0 && p_ext < ext.min) {
      ext.min = p_ext;
      ext.tMin = t_sum + t_ext;
    } else if (a_ext < 0 && p_ext > ext.max) {
      ext.max = p_ext;
      ext.tMax = t_sum + t_ext;
    }
  }
}

function check_step_for_position_extremum(t_sum: number, t: number, p: number, v: number, a: number, j: number, ext: Bound): void {
  if (p < ext.min) {
    ext.min = p;
    ext.tMin = t_sum;
  }
  if (p > ext.max) {
    ext.max = p;
    ext.tMax = t_sum;
  }

  if (j !== 0) {
    const D = a * a - 2 * j * v;
    if (Math.abs(D) < DBL_EPSILON) {
      check_position_extremum(-a / j, t_sum, t, p, v, a, j, ext);

    } else if (D > 0.0) {
      const D_sqrt = Math.sqrt(D);
      check_position_extremum((-a - D_sqrt) / j, t_sum, t, p, v, a, j, ext);
      check_position_extremum((-a + D_sqrt) / j, t_sum, t, p, v, a, j, ext);
    }
  }
}

/**
 * A single-dof kinematic profile with position, velocity, acceleration and jerk
 *
 * Seven phases of constant jerk: `t` their durations, `j` their jerks, and `a`, `v`, `p` the state at the start of
 * each phase and at the end of the last.
 */
export class Profile {
  t: number[] = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
  /** The time at the end of each phase, without the brake's. */
  tSum: number[] = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
  j: number[] = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
  a: number[] = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
  v: number[] = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
  p: number[] = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];

  /** Brake sub-profiles */
  brake: BrakeProfile = new BrakeProfile();
  accel: BrakeProfile = new BrakeProfile();

  /** Target (final) kinematic state */
  pf: number = 0.0;
  vf: number = 0.0;
  af: number = 0.0;

  limits: ReachedLimits = ReachedLimits.ACC0_ACC1_VEL;
  direction: Direction = Direction.UP;
  controlSigns: ControlSigns = ControlSigns.UDDU;

  /** Makes this profile a copy of `other`: the C++'s assignment. */
  assign(other: Profile): void {
    for (let i = 0; i < 7; ++i) {
      this.t[i] = other.t[i];
      this.tSum[i] = other.tSum[i];
      this.j[i] = other.j[i];
    }
    for (let i = 0; i < 8; ++i) {
      this.a[i] = other.a[i];
      this.v[i] = other.v[i];
      this.p[i] = other.p[i];
    }
    this.brake.assign(other.brake);
    this.accel.assign(other.accel);
    this.pf = other.pf;
    this.vf = other.vf;
    this.af = other.af;
    this.limits = other.limits;
    this.direction = other.direction;
    this.controlSigns = other.controlSigns;
  }

  /** Returns a copy of this profile. */
  clone(): Profile {
    const copy = new Profile();
    copy.assign(this);
    return copy;
  }

  // For third-order velocity interface
  checkForVelocity(control_signs: ControlSigns, limits: ReachedLimits, jf: number, aMax: number, aMin: number): boolean {
    const { t, j, a, v, p, vf, af } = this;
    const t_sum = this.tSum;

    if (t[0] < 0) {
      return false;
    }

    t_sum[0] = t[0];
    for (let i = 0; i < 6; ++i) {
      if (t[i+1] < 0) {
        return false;
      }

      t_sum[i+1] = t_sum[i] + t[i+1];
    }

    if (limits === ReachedLimits.ACC0) {
      if (t[1] < DBL_EPSILON) {
        return false;
      }
    }

    if (t_sum[6] > t_max) { // For numerical reasons, is that needed?
      return false;
    }

    if (control_signs === ControlSigns.UDDU) {
      j[0] = (t[0] > 0 ? jf : 0); j[1] = 0; j[2] = (t[2] > 0 ? -jf : 0); j[3] = 0; j[4] = (t[4] > 0 ? -jf : 0); j[5] = 0; j[6] = (t[6] > 0 ? jf : 0);
    } else {
      j[0] = (t[0] > 0 ? jf : 0); j[1] = 0; j[2] = (t[2] > 0 ? -jf : 0); j[3] = 0; j[4] = (t[4] > 0 ? jf : 0); j[5] = 0; j[6] = (t[6] > 0 ? -jf : 0);
    }

    for (let i = 0; i < 7; ++i) {
      a[i+1] = a[i] + t[i] * j[i];
      v[i+1] = v[i] + t[i] * (a[i] + t[i] * j[i] / 2);
      p[i+1] = p[i] + t[i] * (v[i] + t[i] * (a[i] / 2 + t[i] * j[i] / 6));
    }

    this.controlSigns = control_signs;
    this.limits = limits;

    this.direction = (aMax > 0) ? Direction.UP : Direction.DOWN;
    const aUppLim = (this.direction === Direction.UP ? aMax : aMin) + a_eps;
    const aLowLim = (this.direction === Direction.UP ? aMin : aMax) - a_eps;

    // Velocity limit can be broken in the beginning if both initial velocity and acceleration are too high
    return Math.abs(v[7] - vf) < v_precision && Math.abs(a[7] - af) < a_precision
      && a[1] >= aLowLim && a[3] >= aLowLim && a[5] >= aLowLim
      && a[1] <= aUppLim && a[3] <= aUppLim && a[5] <= aUppLim;
  }

  /**
   * The C++ has two functions of this name: without `jMax`, and with it, where the jerk `jf` must also lie within
   * the cap.
   */
  checkForVelocityWithTiming(control_signs: ControlSigns, limits: ReachedLimits, _tf: number, jf: number, aMax: number, aMin: number, jMax?: number): boolean {
    if (jMax !== undefined) {
      return (Math.abs(jf) < Math.abs(jMax) + j_eps) && this.checkForVelocity(control_signs, limits, jf, aMax, aMin);
    }
    // Time doesn't need to be checked as every profile has a: tf - ... equation
    return this.checkForVelocity(control_signs, limits, jf, aMax, aMin); // && (std::abs(t_sum.back() - tf) < t_precision);
  }

  setBoundaryForVelocity(p0_new: number, v0_new: number, a0_new: number, vf_new: number, af_new: number): void {
    this.a[0] = a0_new;
    this.v[0] = v0_new;
    this.p[0] = p0_new;
    this.af = af_new;
    this.vf = vf_new;
  }

  // For second-order velocity interface
  checkForSecondOrderVelocity(control_signs: ControlSigns, limits: ReachedLimits, aUp: number): boolean {
    const { t, j, a, v, p, vf, af } = this;
    const t_sum = this.tSum;

    // ReachedLimits::ACC0
    if (t[1] < 0.0) {
      return false;
    }

    t_sum[0] = 0; t_sum[1] = t[1]; t_sum[2] = t[1]; t_sum[3] = t[1]; t_sum[4] = t[1]; t_sum[5] = t[1]; t_sum[6] = t[1];
    if (t_sum[6] > t_max) { // For numerical reasons, is that needed?
      return false;
    }

    j[0] = 0; j[1] = 0; j[2] = 0; j[3] = 0; j[4] = 0; j[5] = 0; j[6] = 0;
    a[0] = 0; a[1] = (t[1] > 0) ? aUp : 0; a[2] = 0; a[3] = 0; a[4] = 0; a[5] = 0; a[6] = 0; a[7] = af;
    for (let i = 0; i < 7; ++i) {
      v[i+1] = v[i] + t[i] * a[i];
      p[i+1] = p[i] + t[i] * (v[i] + t[i] * a[i] / 2);
    }

    this.controlSigns = control_signs;
    this.limits = limits;

    this.direction = (aUp > 0) ? Direction.UP : Direction.DOWN;

    // Velocity limit can be broken in the beginning if both initial velocity and acceleration are too high
    return Math.abs(v[7] - vf) < v_precision;
  }

  /** Two functions in the C++: without the caps, and with them, where `aUp` must also lie within the caps. */
  checkForSecondOrderVelocityWithTiming(control_signs: ControlSigns, limits: ReachedLimits, _tf: number, aUp: number, aMax?: number, aMin?: number): boolean {
    if (aMax !== undefined && aMin !== undefined) {
      return (aMin - a_eps < aUp) && (aUp < aMax + a_eps) && this.checkForSecondOrderVelocity(control_signs, limits, aUp);
    }
    // Time doesn't need to be checked as every profile has a: tf - ... equation
    return this.checkForSecondOrderVelocity(control_signs, limits, aUp); // && (std::abs(t_sum.back() - tf) < t_precision);
  }

  // For third-order position interface
  check(control_signs: ControlSigns, limits: ReachedLimits, jf: number, vMax: number, vMin: number, aMax: number, aMin: number, set_limits: boolean = false): boolean {
    const { t, j, a, v, p, pf, vf, af } = this;
    const t_sum = this.tSum;

    if (t[0] < 0) {
      return false;
    }

    t_sum[0] = t[0];
    for (let i = 0; i < 6; ++i) {
      if (t[i+1] < 0) {
        return false;
      }

      t_sum[i+1] = t_sum[i] + t[i+1];
    }

    if (limits === ReachedLimits.ACC0_ACC1_VEL || limits === ReachedLimits.ACC0_VEL || limits === ReachedLimits.ACC1_VEL || limits === ReachedLimits.VEL) {
      if (t[3] < DBL_EPSILON) {
        return false;
      }
    }

    if (limits === ReachedLimits.ACC0 || limits === ReachedLimits.ACC0_ACC1) {
      if (t[1] < DBL_EPSILON) {
        return false;
      }
    }

    if (limits === ReachedLimits.ACC1 || limits === ReachedLimits.ACC0_ACC1) {
      if (t[5] < DBL_EPSILON) {
        return false;
      }
    }

    if (t_sum[6] > t_max) { // For numerical reasons, is that needed?
      return false;
    }

    if (control_signs === ControlSigns.UDDU) {
      j[0] = (t[0] > 0 ? jf : 0); j[1] = 0; j[2] = (t[2] > 0 ? -jf : 0); j[3] = 0; j[4] = (t[4] > 0 ? -jf : 0); j[5] = 0; j[6] = (t[6] > 0 ? jf : 0);
    } else {
      j[0] = (t[0] > 0 ? jf : 0); j[1] = 0; j[2] = (t[2] > 0 ? -jf : 0); j[3] = 0; j[4] = (t[4] > 0 ? jf : 0); j[5] = 0; j[6] = (t[6] > 0 ? -jf : 0);
    }

    this.direction = (vMax > 0) ? Direction.UP : Direction.DOWN;
    const vUppLim = (this.direction === Direction.UP ? vMax : vMin) + v_eps;
    const vLowLim = (this.direction === Direction.UP ? vMin : vMax) - v_eps;

    for (let i = 0; i < 7; ++i) {
      a[i+1] = a[i] + t[i] * j[i];
      v[i+1] = v[i] + t[i] * (a[i] + t[i] * j[i] / 2);
      p[i+1] = p[i] + t[i] * (v[i] + t[i] * (a[i] / 2 + t[i] * j[i] / 6));

      if (limits === ReachedLimits.ACC0_ACC1_VEL || limits === ReachedLimits.ACC0_ACC1 || limits === ReachedLimits.ACC0_VEL || limits === ReachedLimits.ACC1_VEL || limits === ReachedLimits.VEL) {
        if (i === 2) {
          a[3] = 0.0;
        }
      }

      if (set_limits) {
        if (limits === ReachedLimits.ACC1) {
          if (i === 2) {
            a[3] = aMin;
          }
        }

        if (limits === ReachedLimits.ACC0_ACC1) {
          if (i === 0) {
            a[1] = aMax;
          }

          if (i === 4) {
            a[5] = aMin;
          }
        }
      }

      if (i > 1 && a[i+1] * a[i] < -DBL_EPSILON) {
        const v_a_zero = v[i] - (a[i] * a[i]) / (2 * j[i]);
        if (v_a_zero > vUppLim || v_a_zero < vLowLim) {
          return false;
        }
      }
    }

    this.controlSigns = control_signs;
    this.limits = limits;

    const aUppLim = (this.direction === Direction.UP ? aMax : aMin) + a_eps;
    const aLowLim = (this.direction === Direction.UP ? aMin : aMax) - a_eps;

    // Velocity limit can be broken in the beginning if both initial velocity and acceleration are too high
    return Math.abs(p[7] - pf) < p_precision && Math.abs(v[7] - vf) < v_precision && Math.abs(a[7] - af) < a_precision
      && a[1] >= aLowLim && a[3] >= aLowLim && a[5] >= aLowLim
      && a[1] <= aUppLim && a[3] <= aUppLim && a[5] <= aUppLim
      && v[3] <= vUppLim && v[4] <= vUppLim && v[5] <= vUppLim && v[6] <= vUppLim
      && v[3] >= vLowLim && v[4] >= vLowLim && v[5] >= vLowLim && v[6] >= vLowLim;
  }

  /**
   * The C++ has two functions of this name: without `jMax`, and with it, where the jerk `jf` must also lie within
   * the cap.
   */
  checkWithTiming(control_signs: ControlSigns, limits: ReachedLimits, _tf: number, jf: number, vMax: number, vMin: number, aMax: number, aMin: number, jMax?: number): boolean {
    if (jMax !== undefined) {
      return (Math.abs(jf) < Math.abs(jMax) + j_eps) && this.check(control_signs, limits, jf, vMax, vMin, aMax, aMin);
    }
    // Time doesn't need to be checked as every profile has a: tf - ... equation
    return this.check(control_signs, limits, jf, vMax, vMin, aMax, aMin); // && (std::abs(t_sum.back() - tf) < t_precision);
  }

  /** Takes the start, the target and the brake profiles of `profile`. */
  setBoundaryFrom(profile: Profile): void {
    this.a[0] = profile.a[0];
    this.v[0] = profile.v[0];
    this.p[0] = profile.p[0];
    this.af = profile.af;
    this.vf = profile.vf;
    this.pf = profile.pf;
    this.brake.assign(profile.brake);
    this.accel.assign(profile.accel);
  }

  setBoundary(p0_new: number, v0_new: number, a0_new: number, pf_new: number, vf_new: number, af_new: number): void {
    this.a[0] = a0_new;
    this.v[0] = v0_new;
    this.p[0] = p0_new;
    this.af = af_new;
    this.vf = vf_new;
    this.pf = pf_new;
  }

  // For second-order position interface
  checkForSecondOrder(control_signs: ControlSigns, limits: ReachedLimits, aUp: number, aDown: number, vMax: number, vMin: number): boolean {
    const { t, j, a, v, p, pf, vf, af } = this;
    const t_sum = this.tSum;

    if (t[0] < 0) {
      return false;
    }

    t_sum[0] = t[0];
    for (let i = 0; i < 6; ++i) {
      if (t[i+1] < 0) {
        return false;
      }

      t_sum[i+1] = t_sum[i] + t[i+1];
    }

    if (t_sum[6] > t_max) { // For numerical reasons, is that needed?
      return false;
    }

    j[0] = 0; j[1] = 0; j[2] = 0; j[3] = 0; j[4] = 0; j[5] = 0; j[6] = 0;
    if (control_signs === ControlSigns.UDDU) {
      a[0] = (t[0] > 0 ? aUp : 0); a[1] = 0; a[2] = (t[2] > 0 ? aDown : 0); a[3] = 0; a[4] = (t[4] > 0 ? aDown : 0); a[5] = 0; a[6] = (t[6] > 0 ? aUp : 0); a[7] = af;
    } else {
      a[0] = (t[0] > 0 ? aUp : 0); a[1] = 0; a[2] = (t[2] > 0 ? aDown : 0); a[3] = 0; a[4] = (t[4] > 0 ? aUp : 0); a[5] = 0; a[6] = (t[6] > 0 ? aDown : 0); a[7] = af;
    }

    this.direction = (vMax > 0) ? Direction.UP : Direction.DOWN;
    const vUppLim = (this.direction === Direction.UP ? vMax : vMin) + v_eps;
    const vLowLim = (this.direction === Direction.UP ? vMin : vMax) - v_eps;

    for (let i = 0; i < 7; ++i) {
      v[i+1] = v[i] + t[i] * a[i];
      p[i+1] = p[i] + t[i] * (v[i] + t[i] * a[i] / 2);
    }

    this.controlSigns = control_signs;
    this.limits = limits;

    // Velocity limit can be broken in the beginning if both initial velocity and acceleration are too high
    return Math.abs(p[7] - pf) < p_precision && Math.abs(v[7] - vf) < v_precision
      && v[2] <= vUppLim && v[3] <= vUppLim && v[4] <= vUppLim && v[5] <= vUppLim && v[6] <= vUppLim
      && v[2] >= vLowLim && v[3] >= vLowLim && v[4] >= vLowLim && v[5] >= vLowLim && v[6] >= vLowLim;
  }

  /** Two functions in the C++: without the acceleration caps, and with them, where both accelerations must lie within. */
  checkForSecondOrderWithTiming(control_signs: ControlSigns, limits: ReachedLimits, _tf: number, aUp: number, aDown: number, vMax: number, vMin: number, aMax?: number, aMin?: number): boolean {
    if (aMax !== undefined && aMin !== undefined) {
      return (aMin - a_eps < aUp) && (aUp < aMax + a_eps) && (aMin - a_eps < aDown) && (aDown < aMax + a_eps) && this.checkForSecondOrder(control_signs, limits, aUp, aDown, vMax, vMin);
    }
    // Time doesn't need to be checked as every profile has a: tf - ... equation
    return this.checkForSecondOrder(control_signs, limits, aUp, aDown, vMax, vMin); // && (std::abs(t_sum.back() - tf) < t_precision);
  }

  // For first-order position interface
  checkForFirstOrder(control_signs: ControlSigns, limits: ReachedLimits, vUp: number): boolean {
    const { t, j, a, v, p, pf, vf, af } = this;
    const t_sum = this.tSum;

    // ReachedLimits::VEL
    if (t[3] < 0.0) {
      return false;
    }

    t_sum[0] = 0; t_sum[1] = 0; t_sum[2] = 0; t_sum[3] = t[3]; t_sum[4] = t[3]; t_sum[5] = t[3]; t_sum[6] = t[3];
    if (t_sum[6] > t_max) { // For numerical reasons, is that needed?
      return false;
    }

    j[0] = 0; j[1] = 0; j[2] = 0; j[3] = 0; j[4] = 0; j[5] = 0; j[6] = 0;
    a[0] = 0; a[1] = 0; a[2] = 0; a[3] = 0; a[4] = 0; a[5] = 0; a[6] = 0; a[7] = af;
    v[0] = 0; v[1] = 0; v[2] = 0; v[3] = t[3] > 0 ? vUp : 0; v[4] = 0; v[5] = 0; v[6] = 0; v[7] = vf;
    for (let i = 0; i < 7; ++i) {
      p[i+1] = p[i] + t[i] * (v[i] + t[i] * a[i] / 2);
    }

    this.controlSigns = control_signs;
    this.limits = limits;

    this.direction = (vUp > 0) ? Direction.UP : Direction.DOWN;

    return Math.abs(p[7] - pf) < p_precision;
  }

  /** Two functions in the C++: without the velocity caps, and with them, where `vUp` must lie within. */
  checkForFirstOrderWithTiming(control_signs: ControlSigns, limits: ReachedLimits, _tf: number, vUp: number, vMax?: number, vMin?: number): boolean {
    if (vMax !== undefined && vMin !== undefined) {
      return (vMin - v_eps < vUp) && (vUp < vMax + v_eps) && this.checkForFirstOrder(control_signs, limits, vUp);
    }
    // Time doesn't need to be checked as every profile has a: tf - ... equation
    return this.checkForFirstOrder(control_signs, limits, vUp); // && (std::abs(t_sum.back() - tf) < t_precision);
  }

  // Secondary features
  getPositionExtrema(): Bound {
    const { t, j, a, v, p, pf, brake } = this;
    const t_sum = this.tSum;

    const extrema: Bound = { min: Infinity, max: -Infinity, tMin: 0.0, tMax: 0.0 };

    if (brake.duration > 0.0) {
      if (brake.t[0] > 0.0) {
        check_step_for_position_extremum(0.0, brake.t[0], brake.p[0], brake.v[0], brake.a[0], brake.j[0], extrema);

        if (brake.t[1] > 0.0) {
          check_step_for_position_extremum(brake.t[0], brake.t[1], brake.p[1], brake.v[1], brake.a[1], brake.j[1], extrema);
        }
      }
    }

    let t_current_sum = 0.0;
    for (let i = 0; i < 7; ++i) {
      if (i > 0) {
        t_current_sum = t_sum[i - 1];
      }
      check_step_for_position_extremum(t_current_sum + brake.duration, t[i], p[i], v[i], a[i], j[i], extrema);
    }

    if (pf < extrema.min) {
      extrema.min = pf;
      extrema.tMin = t_sum[6] + brake.duration;
    }
    if (pf > extrema.max) {
      extrema.max = pf;
      extrema.tMax = t_sum[6] + brake.duration;
    }

    return extrema;
  }

  /** Returns the first time, not before `time_after`, at which the profile is at the position `pt`, if it ever is. */
  getFirstStateAtPosition(pt: number, time_after: number = 0.0): number | undefined {
    const { t, j, a, v, p, pf } = this;
    const t_sum = this.tSum;

    let t_cum = 0.0;

    for (let i = 0; i < 7; ++i) {
      if (t[i] === 0.0) {
        continue;
      }

      if (Math.abs(p[i] - pt) < DBL_EPSILON && t_cum >= time_after) {
        return t_cum;
      }

      for (const _t of solveCubic(j[i]/6, a[i]/2, v[i], p[i] - pt).values()) {
        if (0 < _t && time_after - t_cum <= _t && _t <= t[i]) {
          return _t + t_cum;
        }
      }

      t_cum += t[i];
    }

    if ((t[6] > 0.0 || t_sum[6] === 0.0) && Math.abs(pf - pt) < 1e-9 && t_sum[6] >= time_after) {
      return t_sum[6];
    }

    return undefined;
  }

  /** The direction, the reached limits and the control signs as the C++ and the Python module word them. */
  toString(): string {
    let result = "";
    switch (this.direction) {
      case Direction.UP: result += "UP_"; break;
      case Direction.DOWN: result += "DOWN_"; break;
    }
    result += REACHED_LIMITS_NAMES[this.limits];
    switch (this.controlSigns) {
      case ControlSigns.UDDU: result += "_UDDU"; break;
      case ControlSigns.UDUD: result += "_UDUD"; break;
    }
    return result;
  }
}
