// Ports src/ruckig/velocity_second_step2.cpp and the class VelocitySecondOrderStep2 of include/ruckig/velocity.hpp
// of Ruckig 0.15.3 (https://github.com/pantor/ruckig).
// Copyright (c) 2021 Lars Berscheid, MIT licence (see LICENSE in this folder).

import { ControlSigns, ReachedLimits, type Profile } from "./profile";

/** Mathematical equations for Step 2 in second-order velocity interface: Time synchronization */
export class VelocitySecondOrderStep2 {
  private readonly tf: number;
  private readonly _aMax: number;
  private readonly _aMin: number;
  private readonly vd: number; // Pre-calculated expressions

  constructor(tf: number, v0: number, vf: number, aMax: number, aMin: number) {
    this.tf = tf;
    this._aMax = aMax;
    this._aMin = aMin;
    this.vd = vf - v0;
  }

  getProfile(profile: Profile): boolean {
    const { tf, vd, _aMax, _aMin } = this;

    const af = vd / tf;

    profile.t[0] = 0;
    profile.t[1] = tf;
    profile.t[2] = 0;
    profile.t[3] = 0;
    profile.t[4] = 0;
    profile.t[5] = 0;
    profile.t[6] = 0;

    if (profile.checkForSecondOrderVelocityWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, tf, af, _aMax, _aMin)) {
      profile.pf = profile.p[7];
      return true;
    }

    return false;
  }
}
