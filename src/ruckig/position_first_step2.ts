// Ports src/ruckig/position_first_step2.cpp and the class PositionFirstOrderStep2 of include/ruckig/position.hpp
// of Ruckig 0.15.3 (https://github.com/pantor/ruckig).
// Copyright (c) 2021 Lars Berscheid, MIT licence (see LICENSE in this folder).

import { ControlSigns, ReachedLimits, type Profile } from "./profile";

/** Mathematical equations for Step 2 in first-order position interface: Time synchronization */
export class PositionFirstOrderStep2 {
  private readonly tf: number;
  private readonly _vMax: number;
  private readonly _vMin: number;
  private readonly pd: number; // Pre-calculated expressions

  constructor(tf: number, p0: number, pf: number, vMax: number, vMin: number) {
    this.tf = tf;
    this._vMax = vMax;
    this._vMin = vMin;
    this.pd = pf - p0;
  }

  getProfile(profile: Profile): boolean {
    const { tf, pd, _vMax, _vMin } = this;

    const vf = pd / tf;

    profile.t[0] = 0;
    profile.t[1] = 0;
    profile.t[2] = 0;
    profile.t[3] = tf;
    profile.t[4] = 0;
    profile.t[5] = 0;
    profile.t[6] = 0;

    return profile.checkForFirstOrderWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, tf, vf, _vMax, _vMin);
  }
}
