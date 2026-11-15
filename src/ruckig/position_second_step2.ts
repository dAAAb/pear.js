// Ports src/ruckig/position_second_step2.cpp and the class PositionSecondOrderStep2 of include/ruckig/position.hpp
// of Ruckig 0.15.3 (https://github.com/pantor/ruckig).
// Copyright (c) 2021 Lars Berscheid, MIT licence (see LICENSE in this folder).
//
// The arithmetic is the C++'s text: the names of the numbers are the C++'s, and no expression is simplified or
// reordered. Only declarations, the calls of the standard library and the calls of the checks are worded for
// TypeScript.

import { ControlSigns, Profile, ReachedLimits } from "./profile";
import { DBL_EPSILON } from "./roots";

/** Mathematical equations for Step 2 in second-order position interface: Time synchronization */
export class PositionSecondOrderStep2 {
  private readonly v0: number;
  private readonly tf: number;
  private readonly vf: number;
  private readonly _vMax: number;
  private readonly _vMin: number;
  private readonly _aMax: number;
  private readonly _aMin: number;

  // Pre-calculated expressions
  private readonly pd: number;
  private readonly vd: number;

  constructor(tf: number, p0: number, v0: number, pf: number, vf: number, vMax: number, vMin: number, aMax: number, aMin: number) {
    this.v0 = v0;
    this.tf = tf;
    this.vf = vf;
    this._vMax = vMax;
    this._vMin = vMin;
    this._aMax = aMax;
    this._aMin = aMin;

    this.pd = pf - p0;
    this.vd = vf - v0;
  }

  private checkAll(profile: Profile, vMax: number, vMin: number, aMax: number, aMin: number): boolean {
    return this.timeAcc0(profile, vMax, vMin, aMax, aMin) || this.timeNone(profile, vMax, vMin, aMax, aMin);
  }

  private timeAcc0(profile: Profile, vMax: number, vMin: number, aMax: number, aMin: number): boolean {
    const { v0, tf, vf, pd, vd } = this;

    // UD Solution 1/2
    {
      const h1 = Math.sqrt((2*aMax*(pd - tf*vf) - 2*aMin*(pd - tf*v0) + vd*vd)/(aMax*aMin) + tf*tf);

      profile.t[0] = (aMax*vd - aMax*aMin*(tf - h1))/(aMax*(aMax - aMin));
      profile.t[1] = h1;
      profile.t[2] = tf - (profile.t[0] + h1);
      profile.t[3] = 0;
      profile.t[4] = 0;
      profile.t[5] = 0;
      profile.t[6] = 0;

      if (profile.checkForSecondOrderWithTiming(ControlSigns.UDDU, ReachedLimits.ACC0, tf, aMax, aMin, vMax, vMin)) {
        profile.pf = profile.p[7];
        return true;
      }
    }

    // UU Solution
    {
      const h1 = (-vd + aMax*tf);

      profile.t[0] = -vd*vd/(2*aMax*h1) + (pd - v0*tf)/h1;
      profile.t[1] = -vd/aMax + tf;
      profile.t[2] = 0;
      profile.t[3] = 0;
      profile.t[4] = 0;
      profile.t[5] = 0;
      profile.t[6] = tf - (profile.t[0] + profile.t[1]);

      if (profile.checkForSecondOrderWithTiming(ControlSigns.UDDU, ReachedLimits.ACC0, tf, aMax, aMin, vMax, vMin)) {
        profile.pf = profile.p[7];
        return true;
      }
    }

    // UU Solution - 2 step
    {
      profile.t[0] = 0;
      profile.t[1] = -vd/aMax + tf;
      profile.t[2] = 0;
      profile.t[3] = 0;
      profile.t[4] = 0;
      profile.t[5] = 0;
      profile.t[6] = vd/aMax;

      if (profile.checkForSecondOrderWithTiming(ControlSigns.UDDU, ReachedLimits.ACC0, tf, aMax, aMin, vMax, vMin)) {
        profile.pf = profile.p[7];
        return true;
      }
    }

    return false;
  }

  private timeNone(profile: Profile, vMax: number, vMin: number, aMax: number, aMin: number): boolean {
    const { v0, tf, vf, pd, vd } = this;

    if (Math.abs(v0) < DBL_EPSILON && Math.abs(vf) < DBL_EPSILON && Math.abs(pd) < DBL_EPSILON) {
      profile.t[0] = 0;
      profile.t[1] = tf;
      profile.t[2] = 0;
      profile.t[3] = 0;
      profile.t[4] = 0;
      profile.t[5] = 0;
      profile.t[6] = 0;

      if (profile.checkForSecondOrderWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, tf, aMax, aMin, vMax, vMin)) {
        profile.pf = profile.p[7];
        return true;
      }
    }

    // UD Solution 1/2
    {
      const h1 = 2*(vf*tf - pd);

      profile.t[0] = h1/vd;
      profile.t[1] = tf - profile.t[0];
      profile.t[2] = 0;
      profile.t[3] = 0;
      profile.t[4] = 0;
      profile.t[5] = 0;
      profile.t[6] = 0;

      const af = vd*vd/h1;

      if ((aMin - 1e-12 < af) && (af < aMax + 1e-12) && profile.checkForSecondOrderWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, tf, af, -af, vMax, vMin)) {
        profile.pf = profile.p[7];
        return true;
      }
    }

    return false;
  }

  getProfile(profile: Profile): boolean {
    const { _vMax, _vMin, _aMax, _aMin, pd } = this;

    // Test all cases to get ones that match
    // However we should guess which one is correct and try them first...
    if (pd > 0) {
      return this.checkAll(profile, _vMax, _vMin, _aMax, _aMin) || this.checkAll(profile, _vMin, _vMax, _aMin, _aMax);
    }

    return this.checkAll(profile, _vMin, _vMax, _aMin, _aMax) || this.checkAll(profile, _vMax, _vMin, _aMax, _aMin);
  }
}
