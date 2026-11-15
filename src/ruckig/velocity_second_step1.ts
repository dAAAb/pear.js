// Ports src/ruckig/velocity_second_step1.cpp and the class VelocitySecondOrderStep1 of include/ruckig/velocity.hpp
// of Ruckig 0.15.3 (https://github.com/pantor/ruckig).
// Copyright (c) 2021 Lars Berscheid, MIT licence (see LICENSE in this folder).

import type { Block } from "./block";
import { ControlSigns, ReachedLimits, type Profile } from "./profile";

/** Mathematical equations for Step 1 in second-order velocity interface: Extremal profiles */
export class VelocitySecondOrderStep1 {
  private readonly _aMax: number;
  private readonly _aMin: number;
  private readonly vd: number; // Pre-calculated expressions

  constructor(v0: number, vf: number, aMax: number, aMin: number) {
    this._aMax = aMax;
    this._aMin = aMin;
    this.vd = vf - v0;
  }

  getProfile(input: Profile, block: Block): boolean {
    const { vd, _aMax, _aMin } = this;

    const p = block.p_min;
    p.setBoundaryFrom(input);

    const af = (vd > 0) ? _aMax : _aMin;
    p.t[0] = 0;
    p.t[1] = vd / af;
    p.t[2] = 0;
    p.t[3] = 0;
    p.t[4] = 0;
    p.t[5] = 0;
    p.t[6] = 0;

    if (p.checkForSecondOrderVelocity(ControlSigns.UDDU, ReachedLimits.ACC0, af)) {
      block.t_min = p.tSum[6] + p.brake.duration + p.accel.duration;
      return true;
    }
    return false;
  }
}
