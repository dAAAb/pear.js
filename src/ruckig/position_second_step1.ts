// Ports src/ruckig/position_second_step1.cpp and the class PositionSecondOrderStep1 of include/ruckig/position.hpp
// of Ruckig 0.15.3 (https://github.com/pantor/ruckig).
// Copyright (c) 2021 Lars Berscheid, MIT licence (see LICENSE in this folder).
//
// The arithmetic is the C++'s text: the names of the numbers are the C++'s, and no expression is simplified or
// reordered. Only declarations, the calls of the standard library and the calls of the checks are worded for
// TypeScript.

import { Block, Interval } from "./block";
import { ControlSigns, Profile, ReachedLimits } from "./profile";
import { DBL_EPSILON } from "./roots";

/** Mathematical equations for Step 1 in second-order position interface: Extremal profiles */
export class PositionSecondOrderStep1 {
  private readonly v0: number;
  private readonly vf: number;
  private readonly _vMax: number;
  private readonly _vMin: number;
  private readonly _aMax: number;
  private readonly _aMin: number;

  // Pre-calculated expressions
  private readonly pd: number;

  /**
   * The valid profiles found so far, and after them the one being tried. The C++ keeps three and an iterator; here
   * the list grows as profiles are found, and `count` is the iterator's position.
   */
  private readonly validProfiles: Profile[] = [new Profile()];
  private count: number = 0;

  constructor(p0: number, v0: number, pf: number, vf: number, vMax: number, vMin: number, aMax: number, aMin: number) {
    this.v0 = v0;
    this.vf = vf;
    this._vMax = vMax;
    this._vMin = vMin;
    this._aMax = aMax;
    this._aMin = aMin;

    this.pd = pf - p0;
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

  private timeAcc0(vMax: number, vMin: number, aMax: number, aMin: number, _unused1: boolean): void {
    const { v0, vf, pd } = this;
    let profile = this.validProfiles[this.count];

    profile.t[0] = (-v0 + vMax)/aMax;
    profile.t[1] = (aMin*v0*v0 - aMax*vf*vf)/(2*aMax*aMin*vMax) + vMax*(aMax - aMin)/(2*aMax*aMin) + pd/vMax;
    profile.t[2] = (vf - vMax)/aMin;
    profile.t[3] = 0;
    profile.t[4] = 0;
    profile.t[5] = 0;
    profile.t[6] = 0;

    if (profile.checkForSecondOrder(ControlSigns.UDDU, ReachedLimits.ACC0, aMax, aMin, vMax, vMin)) {
      profile = this.addProfile();
    }
  }

  private timeNone(vMax: number, vMin: number, aMax: number, aMin: number, return_after_found: boolean): void {
    const { v0, vf, pd } = this;
    let profile = this.validProfiles[this.count];

    let h1 = (aMax*vf*vf - aMin*v0*v0 - 2*aMax*aMin*pd)/(aMax - aMin);
    if (h1 >= 0.0) {
      h1 = Math.sqrt(h1);

      // Solution 1
      {
        profile.t[0] = -(v0 + h1)/aMax;
        profile.t[1] = 0;
        profile.t[2] = (vf + h1)/aMin;
        profile.t[3] = 0;
        profile.t[4] = 0;
        profile.t[5] = 0;
        profile.t[6] = 0;

        if (profile.checkForSecondOrder(ControlSigns.UDDU, ReachedLimits.NONE, aMax, aMin, vMax, vMin)) {
          profile = this.addProfile();
          if (return_after_found) {
            return;
          }
        }
      }

      // Solution 2
      {
        profile.t[0] = (-v0 + h1)/aMax;
        profile.t[1] = 0;
        profile.t[2] = (vf - h1)/aMin;
        profile.t[3] = 0;
        profile.t[4] = 0;
        profile.t[5] = 0;
        profile.t[6] = 0;

        if (profile.checkForSecondOrder(ControlSigns.UDDU, ReachedLimits.NONE, aMax, aMin, vMax, vMin)) {
          profile = this.addProfile();
        }
      }
    }
  }

  private timeAllSingleStep(profile: Profile, vMax: number, vMin: number, aMax: number, aMin: number): boolean {
    const { v0, vf, pd } = this;

    if (Math.abs(vf - v0) > DBL_EPSILON) {
      return false;
    }

    profile.t[0] = 0;
    profile.t[1] = 0;
    profile.t[2] = 0;
    profile.t[3] = 0;
    profile.t[4] = 0;
    profile.t[5] = 0;
    profile.t[6] = 0;

    if (Math.abs(v0) > DBL_EPSILON) {
      profile.t[3] = pd / v0;
      if (profile.checkForSecondOrder(ControlSigns.UDDU, ReachedLimits.NONE, 0.0, 0.0, vMax, vMin)) {
        return true;
      }

    } else if (Math.abs(pd) < DBL_EPSILON) {
      if (profile.checkForSecondOrder(ControlSigns.UDDU, ReachedLimits.NONE, 0.0, 0.0, vMax, vMin)) {
        return true;
      }
    }

    return false;
  }

  getProfile(input: Profile, block: Block): boolean {
    const { v0, vf, pd, _vMax, _vMin, _aMax, _aMin } = this;

    // Zero-limits special case
    if (_vMax === 0.0 && _vMin === 0.0) {
      const p = block.p_min;
      p.setBoundaryFrom(input);

      if (this.timeAllSingleStep(p, _vMax, _vMin, _aMax, _aMin)) {
        block.t_min = p.tSum[6] + p.brake.duration + p.accel.duration;
        if (Math.abs(v0) > DBL_EPSILON) {
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
      if (Math.abs(vf) < DBL_EPSILON) {
        // There is no blocked interval when vf==0, so return after first found profile
        const vMax = (pd >= 0) ? _vMax : _vMin;
        const vMin = (pd >= 0) ? _vMin : _vMax;
        const aMax = (pd >= 0) ? _aMax : _aMin;
        const aMin = (pd >= 0) ? _aMin : _aMax;

        this.timeNone(vMax, vMin, aMax, aMin, true);
        if (this.count > 0) { break return_block; }
        this.timeAcc0(vMax, vMin, aMax, aMin, true);
        if (this.count > 0) { break return_block; }

        this.timeNone(vMin, vMax, aMin, aMax, true);
        if (this.count > 0) { break return_block; }
        this.timeAcc0(vMin, vMax, aMin, aMax, true);

      } else {
        this.timeNone(_vMax, _vMin, _aMax, _aMin, false);
        this.timeNone(_vMin, _vMax, _aMin, _aMax, false);
        this.timeAcc0(_vMax, _vMin, _aMax, _aMin, false);
        this.timeAcc0(_vMin, _vMax, _aMin, _aMax, false);
      }
    }

    return Block.calculateBlock(block, this.validProfiles, this.count);
  }
}
