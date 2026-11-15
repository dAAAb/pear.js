// Ports src/ruckig/position_third_step1.cpp and the class PositionThirdOrderStep1 of include/ruckig/position.hpp
// of Ruckig 0.15.3 (https://github.com/pantor/ruckig).
// Copyright (c) 2021 Lars Berscheid, MIT licence (see LICENSE in this folder).
//
// The arithmetic is the C++'s text: the names of the numbers are the C++'s, and no expression is simplified or
// reordered, because the last digits of a profile's times decide whether it passes Profile's check. Only
// declarations, the calls of the standard library and the calls of the checks are worded for TypeScript. The lines
// are as long as the C++'s for the same reason: one expression, one line, to be compared side by side.

import { Block, Interval } from "./block";
import { ControlSigns, Profile, ReachedLimits } from "./profile";
import { DBL_EPSILON, PositiveSet, min, solveQuartMonicOf } from "./roots";

/** Mathematical equations for Step 1 in third-order position interface: Extremal profiles */
export class PositionThirdOrderStep1 {
  private readonly v0: number;
  private readonly a0: number;
  private readonly vf: number;
  private readonly af: number;
  private readonly _vMax: number;
  private readonly _vMin: number;
  private readonly _aMax: number;
  private readonly _aMin: number;
  private readonly _jMax: number;

  // Pre-calculated expressions
  private readonly pd: number;
  private readonly v0_v0: number;
  private readonly vf_vf: number;
  private readonly a0_a0: number;
  private readonly a0_p3: number;
  private readonly a0_p4: number;
  private readonly af_af: number;
  private readonly af_p3: number;
  private readonly af_p4: number;
  private readonly jMax_jMax: number;

  /**
   * The valid profiles found so far, and after them the one being tried. The C++ keeps six (five valid ones and a
   * spare) and an iterator; here the list grows as profiles are found, and `count` is the iterator's position.
   */
  private readonly validProfiles: Profile[] = [new Profile()];
  private count: number = 0;

  constructor(p0: number, v0: number, a0: number, pf: number, vf: number, af: number, vMax: number, vMin: number, aMax: number, aMin: number, jMax: number) {
    this.v0 = v0;
    this.a0 = a0;
    this.vf = vf;
    this.af = af;
    this._vMax = vMax;
    this._vMin = vMin;
    this._aMax = aMax;
    this._aMin = aMin;
    this._jMax = jMax;

    this.pd = pf - p0;

    this.v0_v0 = v0 * v0;
    this.vf_vf = vf * vf;

    this.a0_a0 = a0 * a0;
    this.af_af = af * af;

    this.a0_p3 = a0 * this.a0_a0;
    this.a0_p4 = this.a0_a0 * this.a0_a0;
    this.af_p3 = af * this.af_af;
    this.af_p4 = this.af_af * this.af_af;

    // max values needs to be invariant to plus minus sign change
    this.jMax_jMax = jMax * jMax;
  }

  /** Keeps the profile just tried as valid, and returns the next one to try, with the same boundary. */
  private addProfile(): Profile {
    const prev_profile = this.validProfiles[this.count];
    this.count += 1;
    if (this.count === this.validProfiles.length) {
      this.validProfiles.push(new Profile());
    }
    const profile = this.validProfiles[this.count];
    profile.setBoundaryFrom(prev_profile);
    return profile;
  }

  private timeAllVel(vMax: number, vMin: number, aMax: number, aMin: number, jMax: number, _unused1: boolean): void {
    const { v0, a0, vf, af, pd, v0_v0, vf_vf, a0_a0, a0_p3, a0_p4, af_af, af_p3, af_p4, jMax_jMax } = this;
    let profile = this.validProfiles[this.count];

    // ACC0_ACC1_VEL
    profile.t[0] = (-a0 + aMax)/jMax;
    profile.t[1] = (a0_a0/2 - aMax*aMax - jMax*(v0 - vMax))/(aMax*jMax);
    profile.t[2] = aMax/jMax;
    profile.t[3] = (3*(a0_p4*aMin - af_p4*aMax) + 8*aMax*aMin*(af_p3 - a0_p3 + 3*jMax*(a0*v0 - af*vf)) + 6*a0_a0*aMin*(aMax*aMax - 2*jMax*v0) - 6*af_af*aMax*(aMin*aMin - 2*jMax*vf) - 12*jMax*(aMax*aMin*(aMax*(v0 + vMax) - aMin*(vf + vMax) - 2*jMax*pd) + (aMin - aMax)*jMax*vMax*vMax + jMax*(aMax*vf_vf - aMin*v0_v0)))/(24*aMax*aMin*jMax_jMax*vMax);
    profile.t[4] = -aMin/jMax;
    profile.t[5] = -(af_af/2 - aMin*aMin - jMax*(vf - vMax))/(aMin*jMax);
    profile.t[6] = profile.t[4] + af/jMax;

    if (profile.check(ControlSigns.UDDU, ReachedLimits.ACC0_ACC1_VEL, jMax, vMax, vMin, aMax, aMin)) {
      profile = this.addProfile();
      return;
    }

    // ACC1_VEL
    const t_acc0 = Math.sqrt(a0_a0/(2*jMax_jMax) + (vMax - v0)/jMax);

    profile.t[0] = t_acc0 - a0/jMax;
    profile.t[1] = 0;
    profile.t[2] = t_acc0;
    profile.t[3] = -(3*af_p4 - 8*aMin*(af_p3 - a0_p3) - 24*aMin*jMax*(a0*v0 - af*vf) + 6*af_af*(aMin*aMin - 2*jMax*vf) - 12*jMax*(2*aMin*jMax*pd + aMin*aMin*(vf + vMax) + jMax*(vMax*vMax - vf_vf) + aMin*t_acc0*(a0_a0 - 2*jMax*(v0 + vMax))))/(24*aMin*jMax_jMax*vMax);
    // profile->t[4] = -aMin/jMax;
    // profile->t[5] = -(af_af/2 - aMin*aMin + jMax*(vMax - vf))/(aMin*jMax);
    // profile->t[6] = profile->t[4] + af/jMax;

    if (profile.check(ControlSigns.UDDU, ReachedLimits.ACC1_VEL, jMax, vMax, vMin, aMax, aMin)) {
      profile = this.addProfile();
      return;
    }

    // ACC0_VEL
    const t_acc1 = Math.sqrt(af_af/(2*jMax_jMax) + (vMax - vf)/jMax);

    profile.t[0] = (-a0 + aMax)/jMax;
    profile.t[1] = (a0_a0/2 - aMax*aMax - jMax*(v0 - vMax))/(aMax*jMax);
    profile.t[2] = aMax/jMax;
    profile.t[3] = (3*a0_p4 + 8*aMax*(af_p3 - a0_p3) + 24*aMax*jMax*(a0*v0 - af*vf) + 6*a0_a0*(aMax*aMax - 2*jMax*v0) - 12*jMax*(-2*aMax*jMax*pd + aMax*aMax*(v0 + vMax) + jMax*(vMax*vMax - v0_v0) + aMax*t_acc1*(-af_af + 2*(vf + vMax)*jMax)))/(24*aMax*jMax_jMax*vMax);
    profile.t[4] = t_acc1;
    profile.t[5] = 0;
    profile.t[6] = t_acc1 + af/jMax;

    if (profile.check(ControlSigns.UDDU, ReachedLimits.ACC0_VEL, jMax, vMax, vMin, aMax, aMin)) {
      profile = this.addProfile();
      return;
    }

    // VEL
    // Solution 3/4
    profile.t[0] = t_acc0 - a0/jMax;
    profile.t[1] = 0;
    profile.t[2] = t_acc0;
    profile.t[3] = (af_p3 - a0_p3)/(3*jMax_jMax*vMax) + (a0*v0 - af*vf + (af_af*t_acc1 + a0_a0*t_acc0)/2)/(jMax*vMax) - (v0/vMax + 1.0)*t_acc0 - (vf/vMax + 1.0)*t_acc1 + pd/vMax;
    // profile->t[4] = t_acc1;
    // profile->t[5] = 0;
    // profile->t[6] = t_acc1 + af/jMax;

    if (profile.check(ControlSigns.UDDU, ReachedLimits.VEL, jMax, vMax, vMin, aMax, aMin)) {
      profile = this.addProfile();
    }
  }

  private timeAcc0Acc1(vMax: number, vMin: number, aMax: number, aMin: number, jMax: number, return_after_found: boolean): void {
    const { v0, a0, vf, af, pd, v0_v0, vf_vf, a0_a0, a0_p3, a0_p4, af_af, af_p3, af_p4, jMax_jMax } = this;
    let profile = this.validProfiles[this.count];

    let h1 = (3*(af_p4*aMax - a0_p4*aMin) + aMax*aMin*(8*(a0_p3 - af_p3) + 3*aMax*aMin*(aMax - aMin) + 6*aMin*af_af - 6*aMax*a0_a0) + 12*jMax*(aMax*aMin*((aMax - 2*a0)*v0 - (aMin - 2*af)*vf) + aMin*a0_a0*v0 - aMax*af_af*vf))/(3*(aMax - aMin)*jMax_jMax) + 4*(aMax*vf_vf - aMin*v0_v0 - 2*aMin*aMax*pd)/(aMax - aMin);

    if (h1 >= 0) {
      h1 = Math.sqrt(h1) / 2;
      const h2 = a0_a0/(2*aMax*jMax) + (aMin - 2*aMax)/(2*jMax) - v0/aMax;
      const h3 = -af_af/(2*aMin*jMax) - (aMax - 2*aMin)/(2*jMax) + vf/aMin;

      // UDDU: Solution 2
      if (h2 > h1/aMax && h3 > -h1/aMin) {
        profile.t[0] = (-a0 + aMax)/jMax;
        profile.t[1] = h2 - h1/aMax;
        profile.t[2] = aMax/jMax;
        profile.t[3] = 0;
        profile.t[4] = -aMin/jMax;
        profile.t[5] = h3 + h1/aMin;
        profile.t[6] = profile.t[4] + af/jMax;

        if (profile.check(ControlSigns.UDDU, ReachedLimits.ACC0_ACC1, jMax, vMax, vMin, aMax, aMin, true)) {
          profile = this.addProfile();
          if (return_after_found) {
            return;
          }
        }
      }

      // UDDU: Solution 1
      if (h2 > -h1/aMax && h3 > h1/aMin) {
        profile.t[0] = (-a0 + aMax)/jMax;
        profile.t[1] = h2 + h1/aMax;
        profile.t[2] = aMax/jMax;
        profile.t[3] = 0;
        profile.t[4] = -aMin/jMax;
        profile.t[5] = h3 - h1/aMin;
        profile.t[6] = profile.t[4] + af/jMax;

        if (profile.check(ControlSigns.UDDU, ReachedLimits.ACC0_ACC1, jMax, vMax, vMin, aMax, aMin, true)) {
          profile = this.addProfile();
        }
      }
    }
  }

  private timeAllNoneAcc0Acc1(vMax: number, vMin: number, aMax: number, aMin: number, jMax: number, return_after_found: boolean): void {
    const { v0, a0, vf, af, pd, v0_v0, vf_vf, a0_a0, a0_p3, a0_p4, af_af, af_p3, af_p4, jMax_jMax } = this;
    let profile = this.validProfiles[this.count];

    // NONE UDDU / UDUD Strategy: t7 == 0 (equals UDDU), this one is in particular prone to numerical issues
    const h2_none = (a0_a0 - af_af)/(2*jMax) + (vf - v0);
    const h2_h2 = h2_none*h2_none;
    const t_min_none = (a0 - af)/jMax;
    const t_max_none = (aMax - aMin)/jMax;

    const polynom_none = new Array<number>(4);
    polynom_none[0] = 0;
    polynom_none[1] = -2*(a0_a0 + af_af - 2*jMax*(v0 + vf))/jMax_jMax;
    polynom_none[2] = 4*(a0_p3 - af_p3 + 3*jMax*(af*vf - a0*v0))/(3*jMax*jMax_jMax) - 4*pd/jMax;
    polynom_none[3] = -h2_h2/jMax_jMax;


    // ACC0
    const h3_acc0 = (a0_a0 - af_af)/(2*aMax*jMax) + (vf - v0)/aMax;
    const t_min_acc0 = (aMax - af)/jMax;
    const t_max_acc0 = (aMax - aMin)/jMax;

    const h0_acc0 = 3*(af_p4 - a0_p4) + 8*(a0_p3 - af_p3)*aMax + 24*aMax*jMax*(af*vf - a0*v0) - 6*a0_a0*(aMax*aMax - 2*jMax*v0) + 6*af_af*(aMax*aMax - 2*jMax*vf) + 12*jMax*(jMax*(vf_vf - v0_v0 - 2*aMax*pd) - aMax*aMax*(vf - v0));
    const h2_acc0 = -af_af + aMax*aMax + 2*jMax*vf;

    const polynom_acc0 = new Array<number>(4);
    polynom_acc0[0] = -2*aMax/jMax;
    polynom_acc0[1] = h2_acc0/jMax_jMax;
    polynom_acc0[2] = 0;
    polynom_acc0[3] = h0_acc0/(12*jMax_jMax*jMax_jMax);


    // ACC1
    const h3_acc1 = -(a0_a0 + af_af)/(2*jMax*aMin) + aMin/jMax + (vf - v0)/aMin;
    const t_min_acc1 = (aMin - a0)/jMax;
    const t_max_acc1 = (aMax - a0)/jMax;

    const h0_acc1 = (a0_p4 - af_p4)/4 + 2*(af_p3 - a0_p3)*aMin/3 + (a0_a0 - af_af)*aMin*aMin/2 + jMax*(af_af*vf + a0_a0*v0 + 2*aMin*(jMax*pd - a0*v0 - af*vf) + aMin*aMin*(v0 + vf) + jMax*(v0_v0 - vf_vf));
    const h2_acc1 = a0_a0 - a0*aMin + 2*jMax*v0;

    const polynom_acc1 = new Array<number>(4);
    polynom_acc1[0] = 2*(2*a0 - aMin)/jMax;
    polynom_acc1[1] = (5*a0_a0 + aMin*(aMin - 6*a0) + 2*jMax*v0)/jMax_jMax;
    polynom_acc1[2] = 2*(a0 - aMin)*h2_acc1/(jMax_jMax*jMax);
    polynom_acc1[3] = h0_acc1/(jMax_jMax*jMax_jMax);


    // Limits
    // const double t_min_pd = std::abs(pd / vMax) - 1e-12;
    // t_min_none = std::max(t_min_none, (t_min_pd - (af - a0)/jMax)/2);

    // Budan's theorem
    // std::array<double, 4> polynom_none_min = polynom_none;
    // polynom_none_min[0] += 4 * t_min_none;
    // polynom_none_min[1] += (3 * polynom_none[0] + 6 * t_min_none) * t_min_none;
    // polynom_none_min[2] += (2 * polynom_none[1] + (3 * polynom_none[0] + 4 * t_min_none) * t_min_none) * t_min_none;
    // polynom_none_min[3] += (polynom_none[2] + (polynom_none[1] + (polynom_none[0] + t_min_none) * t_min_none) * t_min_none) * t_min_none;

    const polynom_acc0_min = polynom_acc0.slice();
    polynom_acc0_min[0] += 4 * t_min_acc0;
    polynom_acc0_min[1] += (3 * polynom_acc0[0] + 6 * t_min_acc0) * t_min_acc0;
    polynom_acc0_min[2] += (2 * polynom_acc0[1] + (3 * polynom_acc0[0] + 4 * t_min_acc0) * t_min_acc0) * t_min_acc0;
    polynom_acc0_min[3] += (polynom_acc0[2] + (polynom_acc0[1] + (polynom_acc0[0] + t_min_acc0) * t_min_acc0) * t_min_acc0) * t_min_acc0;

    // const bool polynom_none_has_solution = (polynom_none_min[0] < 0.0) || (polynom_none_min[1] < 0.0) || (polynom_none_min[2] < 0.0) || (polynom_none_min[3] <= 0.0);
    const polynom_acc0_has_solution = (polynom_acc0_min[0] < 0.0) || (polynom_acc0_min[1] < 0.0) || (polynom_acc0_min[2] < 0.0) || (polynom_acc0_min[3] <= 0.0);
    const polynom_acc1_has_solution = (polynom_acc1[0] < 0.0) || (polynom_acc1[1] < 0.0) || (polynom_acc1[2] < 0.0) || (polynom_acc1[3] <= 0.0);

    const roots_none = solveQuartMonicOf(polynom_none);
    const roots_acc0 = polynom_acc0_has_solution ? solveQuartMonicOf(polynom_acc0) : new PositiveSet();
    const roots_acc1 = polynom_acc1_has_solution ? solveQuartMonicOf(polynom_acc1) : new PositiveSet();


    for (let t of roots_none.values()) {
      if (t < t_min_none || t > t_max_none) {
        continue;
      }

      // Single Newton-step (regarding pd)
      if (t > DBL_EPSILON) {
        const h1 = jMax*t*t;
        const orig = -h2_h2/(4*jMax*t) + h2_none*(af/jMax + t) + (4*a0_p3 + 2*af_p3 - 6*a0_a0*(af + 2*jMax*t) + 12*(af - a0)*jMax*v0 + 3*jMax_jMax*(-4*pd + (h1 + 8*v0)*t))/(12*jMax_jMax);
        const deriv = h2_none + 2*v0 - a0_a0/jMax + h2_h2/(4*h1) + (3*h1)/4;

        t -= orig / deriv;
      }

      const h0 = h2_none/(2*jMax*t);
      profile.t[0] = h0 + t/2 - a0/jMax;
      profile.t[1] = 0;
      profile.t[2] = t;
      profile.t[3] = 0;
      profile.t[4] = 0;
      profile.t[5] = 0;
      profile.t[6] = -h0 + t/2 + af/jMax;

      if (profile.check(ControlSigns.UDDU, ReachedLimits.NONE, jMax, vMax, vMin, aMax, aMin)) {
        profile = this.addProfile();
        if (return_after_found) {
          return;
        }
      }
    }

    for (let t of roots_acc0.values()) {
      if (t < t_min_acc0 || t > t_max_acc0) {
        continue;
      }

      // Single Newton step (regarding pd)
      if (t > DBL_EPSILON) {
        const h1 = jMax*t;
        const orig = h0_acc0/(12*jMax_jMax*t) + t*(h2_acc0 + h1*(h1 - 2*aMax));
        const deriv = 2*(h2_acc0 + h1*(2*h1 - 3*aMax));

        t -= orig / deriv;
      }

      profile.t[0] = (-a0 + aMax)/jMax;
      profile.t[1] = h3_acc0 - 2*t + jMax/aMax*t*t;
      profile.t[2] = t;
      profile.t[3] = 0;
      profile.t[4] = 0;
      profile.t[5] = 0;
      profile.t[6] = (af - aMax)/jMax + t;

      if (profile.check(ControlSigns.UDDU, ReachedLimits.ACC0, jMax, vMax, vMin, aMax, aMin)) {
        profile = this.addProfile();
        if (return_after_found) {
          return;
        }
      }
    }

    for (let t of roots_acc1.values()) {
      if (t < t_min_acc1 || t > t_max_acc1) {
        continue;
      }

      // Double Newton step (regarding pd)
      if (t > DBL_EPSILON) {
        const h5 = a0_p3 + 2*jMax*a0*v0;
        let h1 = jMax*t;
        let orig = -(h0_acc1/2 + h1*(h5 + a0*(aMin - 2*h1)*(aMin - h1) + a0_a0*(5*h1/2 - 2*aMin) + aMin*aMin*h1/2 + jMax*(h1/2 - aMin)*(h1*t + 2*v0)))/jMax;
        let deriv = (aMin - a0 - h1)*(h2_acc1 + h1*(4*a0 - aMin + 2*h1));
        t -= min(orig / deriv, t);

        h1 = jMax*t;
        orig = -(h0_acc1/2 + h1*(h5 + a0*(aMin - 2*h1)*(aMin - h1) + a0_a0*(5*h1/2 - 2*aMin) + aMin*aMin*h1/2 + jMax*(h1/2 - aMin)*(h1*t + 2*v0)))/jMax;

        if (Math.abs(orig) > 1e-9) {
          deriv = (aMin - a0 - h1)*(h2_acc1 + h1*(4*a0 - aMin + 2*h1));
          t -= orig / deriv;

          h1 = jMax*t;
          orig = -(h0_acc1/2 + h1*(h5 + a0*(aMin - 2*h1)*(aMin - h1) + a0_a0*(5*h1/2 - 2*aMin) + aMin*aMin*h1/2 + jMax*(h1/2 - aMin)*(h1*t + 2*v0)))/jMax;

          if (Math.abs(orig) > 1e-9) {
            deriv = (aMin - a0 - h1)*(h2_acc1 + h1*(4*a0 - aMin + 2*h1));
            t -= orig / deriv;
          }
        }
      }

      profile.t[0] = t;
      profile.t[1] = 0;
      profile.t[2] = (a0 - aMin)/jMax + t;
      profile.t[3] = 0;
      profile.t[4] = 0;
      profile.t[5] = h3_acc1 - (2*a0 + jMax*t)*t/aMin;
      profile.t[6] = (af - aMin)/jMax;

      if (profile.check(ControlSigns.UDDU, ReachedLimits.ACC1, jMax, vMax, vMin, aMax, aMin, true)) {
        profile = this.addProfile();
        if (return_after_found) {
          return;
        }
      }
    }
  }

  private timeAcc1VelTwoStep(vMax: number, vMin: number, aMax: number, aMin: number, jMax: number): void {
    const { v0, a0, vf, af, pd, vf_vf, a0_a0, a0_p3, af_af, af_p3, af_p4, jMax_jMax } = this;
    let profile = this.validProfiles[this.count];

    profile.t[0] = 0;
    profile.t[1] = 0;
    profile.t[2] = a0/jMax;
    profile.t[3] = -(3*af_p4 - 8*aMin*(af_p3 - a0_p3) - 24*aMin*jMax*(a0*v0 - af*vf) + 6*af_af*(aMin*aMin - 2*jMax*vf) - 12*jMax*(2*aMin*jMax*pd + aMin*aMin*(vf + vMax) + jMax*(vMax*vMax - vf_vf) + aMin*a0*(a0_a0 - 2*jMax*(v0 + vMax))/jMax))/(24*aMin*jMax_jMax*vMax);
    profile.t[4] = -aMin/jMax;
    profile.t[5] = -(af_af/2 - aMin*aMin + jMax*(vMax - vf))/(aMin*jMax);
    profile.t[6] = profile.t[4] + af/jMax;

    if (profile.check(ControlSigns.UDDU, ReachedLimits.ACC1_VEL, jMax, vMax, vMin, aMax, aMin)) {
      profile = this.addProfile();
    }
  }

  private timeAcc0TwoStep(vMax: number, vMin: number, aMax: number, aMin: number, jMax: number): void {
    const { v0, a0, vf, af, pd, v0_v0, vf_vf, a0_a0, a0_p3, a0_p4, af_af, af_p3, af_p4, jMax_jMax } = this;
    let profile = this.validProfiles[this.count];

    // Two step
    {
      profile.t[0] = 0;
      profile.t[1] = (af_af - a0_a0 + 2*jMax*(vf - v0))/(2*a0*jMax);
      profile.t[2] = (a0 - af)/jMax;
      profile.t[3] = 0;
      profile.t[4] = 0;
      profile.t[5] = 0;
      profile.t[6] = 0;

      if (profile.check(ControlSigns.UDDU, ReachedLimits.ACC0, jMax, vMax, vMin, aMax, aMin)) {
        profile = this.addProfile();
        return;
      }
    }

    // Three step - Removed pf
    {
      profile.t[0] = (-a0 + aMax)/jMax;
      profile.t[1] = (a0_a0 + af_af - 2*aMax*aMax + 2*jMax*(vf - v0))/(2*aMax*jMax);
      profile.t[2] = (-af + aMax)/jMax;
      profile.t[3] = 0;
      profile.t[4] = 0;
      profile.t[5] = 0;
      profile.t[6] = 0;

      if (profile.check(ControlSigns.UDDU, ReachedLimits.ACC0, jMax, vMax, vMin, aMax, aMin)) {
        profile = this.addProfile();
        return;
      }
    }

    // Three step - Removed aMax
    {
      const h0 = 3*(af_af - a0_a0 + 2*jMax*(v0 + vf));
      const h2 = a0_p3 + 2*af_p3 + 6*jMax_jMax*pd + 6*(af - a0)*jMax*vf - 3*a0*af_af;
      const h1 = Math.sqrt(2*(2*h2*h2 + h0*(a0_p4 - 6*a0_a0*(af_af + 2*jMax*vf) + 8*a0*(af_p3 + 3*jMax_jMax*pd + 3*af*jMax*vf) - 3*(af_p4 + 4*af_af*jMax*vf + 4*jMax_jMax*(vf_vf - v0_v0))))) * Math.abs(jMax) / jMax;
      profile.t[0] = (4*af_p3 + 2*a0_p3 - 6*a0*af_af + 12*jMax_jMax*pd + 12*(af - a0)*jMax*vf + h1)/(2*jMax*h0);
      profile.t[1] = -h1/(jMax*h0);
      profile.t[2] = (-4*a0_p3 - 2*af_p3 + 6*a0_a0*af + 12*jMax_jMax*pd - 12*(af - a0)*jMax*v0 + h1)/(2*jMax*h0);
      profile.t[3] = 0;
      profile.t[4] = 0;
      profile.t[5] = 0;
      profile.t[6] = 0;

      if (profile.check(ControlSigns.UDDU, ReachedLimits.ACC0, jMax, vMax, vMin, aMax, aMin)) {
        profile = this.addProfile();
        return;
      }
    }

    // Three step - t=(aMax - aMin)/jMax
    {
      const t = (aMax - aMin)/jMax;

      profile.t[0] = (-a0 + aMax)/jMax;
      profile.t[1] = (a0_a0 - af_af)/(2*aMax*jMax) + (vf - v0 + jMax*t*t)/aMax - 2*t;
      profile.t[2] = t;
      profile.t[3] = 0;
      profile.t[4] = 0;
      profile.t[5] = 0;
      profile.t[6] = (af - aMin)/jMax;

      if (profile.check(ControlSigns.UDDU, ReachedLimits.ACC0, jMax, vMax, vMin, aMax, aMin)) {
        profile = this.addProfile();
        return;
      }
    }
  }

  private timeVelTwoStep(vMax: number, vMin: number, aMax: number, aMin: number, jMax: number): void {
    const { v0, a0, vf, af, pd, a0_p3, af_af, af_p3, jMax_jMax } = this;
    let profile = this.validProfiles[this.count];

    const h1 = Math.sqrt(af_af/(2*jMax_jMax) + (vMax - vf)/jMax);

    // Four step
    {
      // Solution 3/4
      profile.t[0] = -a0/jMax;
      profile.t[1] = 0;
      profile.t[2] = 0;
      profile.t[3] = (af_p3 - a0_p3)/(3*jMax_jMax*vMax) + (a0*v0 - af*vf + (af_af*h1)/2)/(jMax*vMax) - (vf/vMax + 1.0)*h1 + pd/vMax;
      profile.t[4] = h1;
      profile.t[5] = 0;
      profile.t[6] = h1 + af/jMax;

      if (profile.check(ControlSigns.UDDU, ReachedLimits.VEL, jMax, vMax, vMin, aMax, aMin)) {
        profile = this.addProfile();
        return;
      }
    }


    // Four step
    {
      profile.t[0] = 0;
      profile.t[1] = 0;
      profile.t[2] = a0/jMax;
      profile.t[3] = (af_p3 - a0_p3)/(3*jMax_jMax*vMax) + (a0*v0 - af*vf + (af_af*h1 + a0_p3/jMax)/2)/(jMax*vMax) - (v0/vMax + 1.0)*a0/jMax - (vf/vMax + 1.0)*h1 + pd/vMax;
      profile.t[4] = h1;
      profile.t[5] = 0;
      profile.t[6] = h1 + af/jMax;

      if (profile.check(ControlSigns.UDDU, ReachedLimits.VEL, jMax, vMax, vMin, aMax, aMin)) {
        profile = this.addProfile();
        return;
      }
    }
  }

  private timeNoneTwoStep(vMax: number, vMin: number, aMax: number, aMin: number, jMax: number): void {
    const { v0, a0, vf, af, a0_a0, af_af } = this;
    let profile = this.validProfiles[this.count];

    // Two step
    {
      const h0 = Math.sqrt((a0_a0 + af_af)/2 + jMax*(vf - v0)) * Math.abs(jMax) / jMax;
      profile.t[0] = (h0 - a0)/jMax;
      profile.t[1] = 0;
      profile.t[2] = (h0 - af)/jMax;
      profile.t[3] = 0;
      profile.t[4] = 0;
      profile.t[5] = 0;
      profile.t[6] = 0;

      if (profile.check(ControlSigns.UDDU, ReachedLimits.NONE, jMax, vMax, vMin, aMax, aMin)) {
        profile = this.addProfile();
        return;
      }
    }

    // Single step
    {
      profile.t[0] = (af - a0)/jMax;
      profile.t[1] = 0;
      profile.t[2] = 0;
      profile.t[3] = 0;
      profile.t[4] = 0;
      profile.t[5] = 0;
      profile.t[6] = 0;

      if (profile.check(ControlSigns.UDDU, ReachedLimits.NONE, jMax, vMax, vMin, aMax, aMin)) {
        profile = this.addProfile();
        return;
      }
    }
  }

  private timeAllSingleStep(profile: Profile, vMax: number, vMin: number, aMax: number, aMin: number, jMax: number): boolean {
    const { v0, a0, af, pd, v0_v0 } = this;

    if (Math.abs(af - a0) > DBL_EPSILON) {
      return false;
    }

    profile.t[0] = 0;
    profile.t[1] = 0;
    profile.t[2] = 0;
    profile.t[3] = 0;
    profile.t[4] = 0;
    profile.t[5] = 0;
    profile.t[6] = 0;

    if (Math.abs(a0) > DBL_EPSILON) {
      const q = Math.sqrt(2*a0*pd + v0_v0);

      // Solution 1
      profile.t[3] = (-v0 + q) / a0;
      if (profile.t[3] >= 0.0 && profile.check(ControlSigns.UDDU, ReachedLimits.NONE, 0.0, vMax, vMin, aMax, aMin)) {
        return true;
      }

      // Solution 2
      profile.t[3] = -(v0 + q) / a0;
      if (profile.t[3] >= 0.0 && profile.check(ControlSigns.UDDU, ReachedLimits.NONE, 0.0, vMax, vMin, aMax, aMin)) {
        return true;
      }

    } else if (Math.abs(v0) > DBL_EPSILON) {
      profile.t[3] = pd / v0;
      if (profile.check(ControlSigns.UDDU, ReachedLimits.NONE, 0.0, vMax, vMin, aMax, aMin)) {
        return true;
      }

    } else if (Math.abs(pd) < DBL_EPSILON) {
      if (profile.check(ControlSigns.UDDU, ReachedLimits.NONE, 0.0, vMax, vMin, aMax, aMin)) {
        return true;
      }
    }

    return false;
  }

  getProfile(input: Profile, block: Block): boolean {
    const { v0, a0, vf, af, pd, _vMax, _vMin, _aMax, _aMin, _jMax } = this;

    // Zero-limits special case
    if (_jMax === 0.0 || _aMax === 0.0 || _aMin === 0.0) {
      const p = block.p_min;
      p.setBoundaryFrom(input);

      if (this.timeAllSingleStep(p, _vMax, _vMin, _aMax, _aMin, _jMax)) {
        block.t_min = p.tSum[6] + p.brake.duration + p.accel.duration;
        if (Math.abs(v0) > DBL_EPSILON || Math.abs(a0) > DBL_EPSILON) {
          block.a = new Interval(block.t_min, Infinity);
        }
        return true;
      }
      return false;
    }

    this.count = 0;
    this.validProfiles[0].setBoundaryFrom(input);

    // the C++ leaves this block with a goto as soon as a profile is found
    return_block: {
      if (Math.abs(vf) < DBL_EPSILON && Math.abs(af) < DBL_EPSILON) {
        const vMax = (pd >= 0) ? _vMax : _vMin;
        const vMin = (pd >= 0) ? _vMin : _vMax;
        const aMax = (pd >= 0) ? _aMax : _aMin;
        const aMin = (pd >= 0) ? _aMin : _aMax;
        const jMax = (pd >= 0) ? _jMax : -_jMax;

        if (Math.abs(v0) < DBL_EPSILON && Math.abs(a0) < DBL_EPSILON && Math.abs(pd) < DBL_EPSILON) {
          this.timeAllNoneAcc0Acc1(vMax, vMin, aMax, aMin, jMax, true);

        } else {
          // There is no blocked interval when vf==0 && af==0, so return after first found profile
          this.timeAllVel(vMax, vMin, aMax, aMin, jMax, true);
          if (this.count > 0) { break return_block; }
          this.timeAllNoneAcc0Acc1(vMax, vMin, aMax, aMin, jMax, true);
          if (this.count > 0) { break return_block; }
          this.timeAcc0Acc1(vMax, vMin, aMax, aMin, jMax, true);
          if (this.count > 0) { break return_block; }

          this.timeAllVel(vMin, vMax, aMin, aMax, -jMax, true);
          if (this.count > 0) { break return_block; }
          this.timeAllNoneAcc0Acc1(vMin, vMax, aMin, aMax, -jMax, true);
          if (this.count > 0) { break return_block; }
          this.timeAcc0Acc1(vMin, vMax, aMin, aMax, -jMax, true);
        }

      } else {
        this.timeAllNoneAcc0Acc1(_vMax, _vMin, _aMax, _aMin, _jMax, false);
        this.timeAllNoneAcc0Acc1(_vMin, _vMax, _aMin, _aMax, -_jMax, false);
        this.timeAcc0Acc1(_vMax, _vMin, _aMax, _aMin, _jMax, false);
        this.timeAcc0Acc1(_vMin, _vMax, _aMin, _aMax, -_jMax, false);
        this.timeAllVel(_vMax, _vMin, _aMax, _aMin, _jMax, false);
        this.timeAllVel(_vMin, _vMax, _aMin, _aMax, -_jMax, false);
      }

      if (this.count === 0) {
        this.timeNoneTwoStep(_vMax, _vMin, _aMax, _aMin, _jMax);
        if (this.count > 0) { break return_block; }
        this.timeNoneTwoStep(_vMin, _vMax, _aMin, _aMax, -_jMax);
        if (this.count > 0) { break return_block; }
        this.timeAcc0TwoStep(_vMax, _vMin, _aMax, _aMin, _jMax);
        if (this.count > 0) { break return_block; }
        this.timeAcc0TwoStep(_vMin, _vMax, _aMin, _aMax, -_jMax);
        if (this.count > 0) { break return_block; }
        this.timeVelTwoStep(_vMax, _vMin, _aMax, _aMin, _jMax);
        if (this.count > 0) { break return_block; }
        this.timeVelTwoStep(_vMin, _vMax, _aMin, _aMax, -_jMax);
        if (this.count > 0) { break return_block; }
        this.timeAcc1VelTwoStep(_vMax, _vMin, _aMax, _aMin, _jMax);
        if (this.count > 0) { break return_block; }
        this.timeAcc1VelTwoStep(_vMin, _vMax, _aMin, _aMax, -_jMax);
      }
    }

    return Block.calculateBlock(block, this.validProfiles, this.count);
  }
}
