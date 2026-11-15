// Ports src/ruckig/position_first_step1.cpp and the class PositionFirstOrderStep1 of include/ruckig/position.hpp
// of Ruckig 0.15.3 (https://github.com/pantor/ruckig).
// Copyright (c) 2021 Lars Berscheid, MIT licence (see LICENSE in this folder).

import type { Block } from "./block";
import { ControlSigns, ReachedLimits, type Profile } from "./profile";

/** Mathematical equations for Step 1 in first-order position interface: Extremal profiles */
export class PositionFirstOrderStep1 {
  private readonly _vMax: number;
  private readonly _vMin: number;
  private readonly pd: number; // Pre-calculated expressions

  constructor(p0: number, pf: number, vMax: number, vMin: number) {
    this._vMax = vMax;
    this._vMin = vMin;
    this.pd = pf - p0;
  }

  getProfile(input: Profile, block: Block): boolean {
    const { pd, _vMax, _vMin } = this;

    const p = block.p_min;
    p.setBoundaryFrom(input);

    const vf = (pd > 0) ? _vMax : _vMin;
    p.t[0] = 0;
    p.t[1] = 0;
    p.t[2] = 0;
    p.t[3] = pd / vf;
    p.t[4] = 0;
    p.t[5] = 0;
    p.t[6] = 0;

    if (p.checkForFirstOrder(ControlSigns.UDDU, ReachedLimits.VEL, vf)) {
      block.t_min = p.tSum[6] + p.brake.duration + p.accel.duration;
      return true;
    }
    return false;
  }
}
