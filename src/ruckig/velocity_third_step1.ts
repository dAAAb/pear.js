// Ports src/ruckig/velocity_third_step1.cpp and the class VelocityThirdOrderStep1 of include/ruckig/velocity.hpp
// of Ruckig 0.15.3 (https://github.com/pantor/ruckig).
// Copyright (c) 2021 Lars Berscheid, MIT licence (see LICENSE in this folder).
//
// The arithmetic is the C++'s text: the names of the numbers are the C++'s, and no expression is simplified or
// reordered. Only declarations, the calls of the standard library and the calls of the checks are worded for
// TypeScript.

import { Block, Interval } from "./block";
import { ControlSigns, Profile, ReachedLimits } from "./profile";
import { DBL_EPSILON } from "./roots";

/** Mathematical equations for Step 1 in third-order velocity interface: Extremal profiles */
export class VelocityThirdOrderStep1 {
  private readonly a0: number;
  private readonly af: number;
  private readonly _aMax: number;
  private readonly _aMin: number;
  private readonly _jMax: number;

  // Pre-calculated expressions
  private readonly vd: number;

  /**
   * The valid profiles found so far, and after them the one being tried. The C++ keeps three and an iterator; here
   * the list grows as profiles are found, and `count` is the iterator's position.
   */
  private readonly validProfiles: Profile[] = [new Profile()];
  private count: number = 0;

  constructor(v0: number, a0: number, vf: number, af: number, aMax: number, aMin: number, jMax: number) {
    this.a0 = a0;
    this.af = af;
    this._aMax = aMax;
    this._aMin = aMin;
    this._jMax = jMax;

    this.vd = vf - v0;
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

  private timeAcc0(aMax: number, aMin: number, jMax: number, _unused1: boolean): void {
    const { a0, af, vd } = this;
    let profile = this.validProfiles[this.count];

    profile.t[0] = (-a0 + aMax)/jMax;
    profile.t[1] = (a0*a0 + af*af)/(2*aMax*jMax) - aMax/jMax + vd/aMax;
    profile.t[2] = (-af + aMax)/jMax;
    profile.t[3] = 0;
    profile.t[4] = 0;
    profile.t[5] = 0;
    profile.t[6] = 0;

    if (profile.checkForVelocity(ControlSigns.UDDU, ReachedLimits.ACC0, jMax, aMax, aMin)) {
      profile = this.addProfile();
    }
  }

  private timeNone(aMax: number, aMin: number, jMax: number, return_after_found: boolean): void {
    const { a0, af, vd } = this;
    let profile = this.validProfiles[this.count];

    let h1 = (a0*a0 + af*af)/2 + jMax*vd;
    if (h1 >= 0.0) {
      h1 = Math.sqrt(h1);

      // Solution 1
      {
        profile.t[0] = -(a0 + h1)/jMax;
        profile.t[1] = 0;
        profile.t[2] = -(af + h1)/jMax;
        profile.t[3] = 0;
        profile.t[4] = 0;
        profile.t[5] = 0;
        profile.t[6] = 0;

        if (profile.checkForVelocity(ControlSigns.UDDU, ReachedLimits.NONE, jMax, aMax, aMin)) {
          profile = this.addProfile();
          if (return_after_found) {
            return;
          }
        }
      }

      // Solution 2
      {
        profile.t[0] = (-a0 + h1)/jMax;
        profile.t[1] = 0;
        profile.t[2] = (-af + h1)/jMax;
        profile.t[3] = 0;
        profile.t[4] = 0;
        profile.t[5] = 0;
        profile.t[6] = 0;

        if (profile.checkForVelocity(ControlSigns.UDDU, ReachedLimits.NONE, jMax, aMax, aMin)) {
          profile = this.addProfile();
        }
      }
    }
  }

  private timeAllSingleStep(profile: Profile, aMax: number, aMin: number, jMax: number): boolean {
    const { a0, af, vd } = this;

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
      profile.t[3] = vd / a0;
      if (profile.checkForVelocity(ControlSigns.UDDU, ReachedLimits.NONE, 0.0, aMax, aMin)) {
        return true;
      }

    } else if (Math.abs(vd) < DBL_EPSILON) {
      if (profile.checkForVelocity(ControlSigns.UDDU, ReachedLimits.NONE, 0.0, aMax, aMin)) {
        return true;
      }
    }

    return false;
  }

  getProfile(input: Profile, block: Block): boolean {
    const { a0, af, vd, _aMax, _aMin, _jMax } = this;

    // Zero-limits special case
    if (_jMax === 0.0) {
      const p = block.p_min;
      p.setBoundaryFrom(input);

      if (this.timeAllSingleStep(p, _aMax, _aMin, _jMax)) {
        block.t_min = p.tSum[6] + p.brake.duration + p.accel.duration;
        if (Math.abs(a0) > DBL_EPSILON) {
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
      if (Math.abs(af) < DBL_EPSILON) {
        // There is no blocked interval when af==0, so return after first found profile
        const aMax = (vd >= 0) ? _aMax : _aMin;
        const aMin = (vd >= 0) ? _aMin : _aMax;
        const jMax = (vd >= 0) ? _jMax : -_jMax;

        this.timeNone(aMax, aMin, jMax, true);
        if (this.count > 0) { break return_block; }
        this.timeAcc0(aMax, aMin, jMax, true);
        if (this.count > 0) { break return_block; }

        this.timeNone(aMin, aMax, -jMax, true);
        if (this.count > 0) { break return_block; }
        this.timeAcc0(aMin, aMax, -jMax, true);

      } else {
        this.timeNone(_aMax, _aMin, _jMax, false);
        this.timeNone(_aMin, _aMax, -_jMax, false);
        this.timeAcc0(_aMax, _aMin, _jMax, false);
        this.timeAcc0(_aMin, _aMax, -_jMax, false);
      }
    }

    return Block.calculateBlock(block, this.validProfiles, this.count);
  }
}
