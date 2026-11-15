// Ports src/ruckig/velocity_third_step2.cpp and the class VelocityThirdOrderStep2 of include/ruckig/velocity.hpp
// of Ruckig 0.15.3 (https://github.com/pantor/ruckig).
// Copyright (c) 2021 Lars Berscheid, MIT licence (see LICENSE in this folder).
//
// The arithmetic is the C++'s text: the names of the numbers are the C++'s, and no expression is simplified or
// reordered. Only declarations, the calls of the standard library and the calls of the checks are worded for
// TypeScript.

import { ControlSigns, Profile, ReachedLimits } from "./profile";
import { DBL_EPSILON } from "./roots";

/** Mathematical equations for Step 2 in third-order velocity interface: Time synchronization */
export class VelocityThirdOrderStep2 {
  private readonly a0: number;
  private readonly tf: number;
  private readonly af: number;
  private readonly _aMax: number;
  private readonly _aMin: number;
  private readonly _jMax: number;

  // Pre-calculated expressions
  private readonly vd: number;
  private readonly ad: number;

  constructor(tf: number, v0: number, a0: number, vf: number, af: number, aMax: number, aMin: number, jMax: number) {
    this.a0 = a0;
    this.tf = tf;
    this.af = af;
    this._aMax = aMax;
    this._aMin = aMin;
    this._jMax = jMax;

    this.vd = vf - v0;
    this.ad = af - a0;
  }

  private checkAll(profile: Profile, aMax: number, aMin: number, jMax: number): boolean {
    return this.timeAcc0(profile, aMax, aMin, jMax) || this.timeNone(profile, aMax, aMin, jMax);
  }

  private timeAcc0(profile: Profile, aMax: number, aMin: number, jMax: number): boolean {
    const { a0, tf, af, vd, ad } = this;

    // UD Solution 1/2
    {
      const h1 = Math.sqrt((-ad*ad + 2*jMax*((a0 + af)*tf - 2*vd))/(jMax*jMax) + tf*tf);

      profile.t[0] = ad/(2*jMax) + (tf - h1)/2;
      profile.t[1] = h1;
      profile.t[2] = tf - (profile.t[0] + h1);
      profile.t[3] = 0;
      profile.t[4] = 0;
      profile.t[5] = 0;
      profile.t[6] = 0;

      if (profile.checkForVelocityWithTiming(ControlSigns.UDDU, ReachedLimits.ACC0, tf, jMax, aMax, aMin)) {
        profile.pf = profile.p[7];
        return true;
      }
    }

    // UU Solution
    {
      const h1 = (-ad + jMax*tf);

      profile.t[0] = -ad*ad/(2*jMax*h1) + (vd - a0*tf)/h1;
      profile.t[1] = -ad/jMax + tf;
      profile.t[2] = 0;
      profile.t[3] = 0;
      profile.t[4] = 0;
      profile.t[5] = 0;
      profile.t[6] = tf - (profile.t[0] + profile.t[1]);

      if (profile.checkForVelocityWithTiming(ControlSigns.UDDU, ReachedLimits.ACC0, tf, jMax, aMax, aMin)) {
        profile.pf = profile.p[7];
        return true;
      }
    }

    // UU Solution - 2 step
    {
      profile.t[0] = 0;
      profile.t[1] = -ad/jMax + tf;
      profile.t[2] = 0;
      profile.t[3] = 0;
      profile.t[4] = 0;
      profile.t[5] = 0;
      profile.t[6] = ad/jMax;

      if (profile.checkForVelocityWithTiming(ControlSigns.UDDU, ReachedLimits.ACC0, tf, jMax, aMax, aMin)) {
        profile.pf = profile.p[7];
        return true;
      }
    }

    return false;
  }

  private timeNone(profile: Profile, aMax: number, aMin: number, jMax: number): boolean {
    const { a0, tf, af, vd, ad } = this;

    if (Math.abs(a0) < DBL_EPSILON && Math.abs(af) < DBL_EPSILON && Math.abs(vd) < DBL_EPSILON) {
      profile.t[0] = 0;
      profile.t[1] = tf;
      profile.t[2] = 0;
      profile.t[3] = 0;
      profile.t[4] = 0;
      profile.t[5] = 0;
      profile.t[6] = 0;

      if (profile.checkForVelocityWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, tf, jMax, aMax, aMin)) {
        profile.pf = profile.p[7];
        return true;
      }
    }

    // UD Solution 1/2
    {
      const h1 = 2*(af*tf - vd);

      profile.t[0] = h1/ad;
      profile.t[1] = tf - profile.t[0];
      profile.t[2] = 0;
      profile.t[3] = 0;
      profile.t[4] = 0;
      profile.t[5] = 0;
      profile.t[6] = 0;

      const jf = ad*ad/h1;

      if (Math.abs(jf) < Math.abs(jMax) + 1e-12 && profile.checkForVelocityWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, tf, jf, aMax, aMin)) {
        profile.pf = profile.p[7];
        return true;
      }
    }

    return false;
  }

  getProfile(profile: Profile): boolean {
    const { _aMax, _aMin, _jMax, vd } = this;

    // Test all cases to get ones that match
    // However we should guess which one is correct and try them first...
    if (vd > 0) {
      return this.checkAll(profile, _aMax, _aMin, _jMax) || this.checkAll(profile, _aMin, _aMax, -_jMax);
    }

    return this.checkAll(profile, _aMin, _aMax, -_jMax) || this.checkAll(profile, _aMax, _aMin, _jMax);
  }
}
