// Ports include/ruckig/brake.hpp and src/ruckig/brake.cpp of Ruckig 0.15.3 (https://github.com/pantor/ruckig).
// Copyright (c) 2021 Lars Berscheid, MIT licence (see LICENSE in this folder).
//
// The names of the numbers are the C++'s, and every expression keeps the C++'s order of operations.

import { max, min } from "./roots";
import { integrate } from "./utils";

function v_at_t(v0: number, a0: number, j: number, t: number): number {
  return v0 + t * (a0 + j * t / 2);
}

function v_at_a_zero(v0: number, a0: number, j: number): number {
  return v0 + (a0 * a0) / (2 * j);
}

/** Calculates (pre- or post-) profile to get current or final state below the limits */
export class BrakeProfile {
  static readonly eps: number = 2.2e-14;

  /** Overall duration */
  duration: number = 0.0;

  /** Profile information for a two-step profile */
  t: number[] = [0.0, 0.0];
  j: number[] = [0.0, 0.0];
  a: number[] = [0.0, 0.0];
  v: number[] = [0.0, 0.0];
  p: number[] = [0.0, 0.0];

  /** Makes this profile a copy of `other`: the C++'s assignment. */
  assign(other: BrakeProfile): void {
    this.duration = other.duration;
    for (let i = 0; i < 2; ++i) {
      this.t[i] = other.t[i];
      this.j[i] = other.j[i];
      this.a[i] = other.a[i];
      this.v[i] = other.v[i];
      this.p[i] = other.p[i];
    }
  }

  private accelerationBrake(v0: number, a0: number, vMax: number, vMin: number, aMax: number, aMin: number, jMax: number): void {
    const { t, j } = this;
    const eps = BrakeProfile.eps;

    j[0] = -jMax;

    const t_to_a_max = (a0 - aMax) / jMax;
    const t_to_a_zero = a0 / jMax;

    const v_at_a_max = v_at_t(v0, a0, -jMax, t_to_a_max);
    const v_at_a_zero = v_at_t(v0, a0, -jMax, t_to_a_zero);

    if ((v_at_a_zero > vMax && jMax > 0) || (v_at_a_zero < vMax && jMax < 0)) {
      this.velocityBrake(v0, a0, vMax, vMin, aMax, aMin, jMax);

    } else if ((v_at_a_max < vMin && jMax > 0) || (v_at_a_max > vMin && jMax < 0)) {
      const t_to_v_min = -(v_at_a_max - vMin)/aMax;
      const t_to_v_max = -aMax/(2*jMax) - (v_at_a_max - vMax)/aMax;

      t[0] = t_to_a_max + eps;
      t[1] = max(min(t_to_v_min, t_to_v_max - eps), 0.0);

    } else {
      t[0] = t_to_a_max + eps;
    }
  }

  private velocityBrake(v0: number, a0: number, vMax: number, vMin: number, _aMax: number, aMin: number, jMax: number): void {
    const { t, j } = this;
    const eps = BrakeProfile.eps;

    j[0] = -jMax;
    const t_to_a_min = (a0 - aMin)/jMax;
    const t_to_v_max = a0/jMax + Math.sqrt(a0*a0 + 2 * jMax * (v0 - vMax)) / Math.abs(jMax);
    const t_to_v_min = a0/jMax + Math.sqrt(a0*a0 / 2 + jMax * (v0 - vMin)) / Math.abs(jMax);
    const t_min_to_v_max = min(t_to_v_max, t_to_v_min);

    if (t_to_a_min < t_min_to_v_max) {
      const v_at_a_min = v_at_t(v0, a0, -jMax, t_to_a_min);
      const t_to_v_max_with_constant = -(v_at_a_min - vMax)/aMin;
      const t_to_v_min_with_constant = aMin/(2*jMax) - (v_at_a_min - vMin)/aMin;

      t[0] = max(t_to_a_min - eps, 0.0);
      t[1] = max(min(t_to_v_max_with_constant, t_to_v_min_with_constant), 0.0);

    } else {
      t[0] = max(t_min_to_v_max - eps, 0.0);
    }
  }

  /** Calculate brake trajectory for third-order position interface */
  getPositionBrakeTrajectory(v0: number, a0: number, vMax: number, vMin: number, aMax: number, aMin: number, jMax: number): void {
    const { t, j } = this;

    t[0] = 0.0;
    t[1] = 0.0;
    j[0] = 0.0;
    j[1] = 0.0;

    if (jMax === 0.0 || aMax === 0.0 || aMin === 0.0) {
      return; // Ignore braking for zero-limits
    }

    if (a0 > aMax) {
      this.accelerationBrake(v0, a0, vMax, vMin, aMax, aMin, jMax);

    } else if (a0 < aMin) {
      this.accelerationBrake(v0, a0, vMin, vMax, aMin, aMax, -jMax);

    } else if ((v0 > vMax && v_at_a_zero(v0, a0, -jMax) > vMin) || (a0 > 0 && v_at_a_zero(v0, a0, jMax) > vMax)) {
      this.velocityBrake(v0, a0, vMax, vMin, aMax, aMin, jMax);

    } else if ((v0 < vMin && v_at_a_zero(v0, a0, jMax) < vMax) || (a0 < 0 && v_at_a_zero(v0, a0, -jMax) < vMin)) {
      this.velocityBrake(v0, a0, vMin, vMax, aMin, aMax, -jMax);
    }
  }

  /** Calculate brake trajectory for second-order position interface */
  getSecondOrderPositionBrakeTrajectory(v0: number, vMax: number, vMin: number, aMax: number, aMin: number): void {
    const { t, j, a } = this;
    const eps = BrakeProfile.eps;

    t[0] = 0.0;
    t[1] = 0.0;
    j[0] = 0.0;
    j[1] = 0.0;
    a[0] = 0.0;
    a[1] = 0.0;

    if (aMax === 0.0 || aMin === 0.0) {
      return; // Ignore braking for zero-limits
    }

    if (v0 > vMax) {
      a[0] = aMin;
      t[0] = (vMax - v0)/aMin + eps;

    } else if (v0 < vMin) {
      a[0] = aMax;
      t[0] = (vMin - v0)/aMax + eps;
    }
  }

  /** Calculate brake trajectory for third-order velocity interface */
  getVelocityBrakeTrajectory(a0: number, aMax: number, aMin: number, jMax: number): void {
    const { t, j } = this;
    const eps = BrakeProfile.eps;

    t[0] = 0.0;
    t[1] = 0.0;
    j[0] = 0.0;
    j[1] = 0.0;

    if (jMax === 0.0) {
      return; // Ignore braking for zero-limits
    }

    if (a0 > aMax) {
      j[0] = -jMax;
      t[0] = (a0 - aMax)/jMax + eps;

    } else if (a0 < aMin) {
      j[0] = jMax;
      t[0] = -(a0 - aMin)/jMax + eps;
    }
  }

  /** Calculate brake trajectory for second-order velocity interface */
  getSecondOrderVelocityBrakeTrajectory(): void {
    const { t, j } = this;

    t[0] = 0.0;
    t[1] = 0.0;
    j[0] = 0.0;
    j[1] = 0.0;
  }

  /**
   * Finalize third-order braking by integrating along kinematic state. The C++ takes the position, the velocity and
   * the acceleration by reference; here they are the first elements of the arrays `ps`, `vs` and `as`.
   */
  finalize(ps: number[], vs: number[], as: number[]): void {
    const { t, j, a, v, p } = this;

    if (t[0] <= 0.0 && t[1] <= 0.0) {
      this.duration = 0.0;
      return;
    }

    this.duration = t[0];
    p[0] = ps[0];
    v[0] = vs[0];
    a[0] = as[0];
    [ps[0], vs[0], as[0]] = integrate(t[0], ps[0], vs[0], as[0], j[0]);

    if (t[1] > 0.0) {
      this.duration += t[1];
      p[1] = ps[0];
      v[1] = vs[0];
      a[1] = as[0];
      [ps[0], vs[0], as[0]] = integrate(t[1], ps[0], vs[0], as[0], j[1]);
    }
  }

  /** Finalize second-order braking by integrating along kinematic state (by reference, as `finalize`). */
  finalizeSecondOrder(ps: number[], vs: number[], as: number[]): void {
    const { t, a, v, p } = this;

    if (t[0] <= 0.0) {
      this.duration = 0.0;
      return;
    }

    this.duration = t[0];
    p[0] = ps[0];
    v[0] = vs[0];
    [ps[0], vs[0], as[0]] = integrate(t[0], ps[0], vs[0], a[0], 0.0);
  }
}
