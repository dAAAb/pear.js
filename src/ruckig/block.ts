// Ports include/ruckig/block.hpp of Ruckig 0.15.3 (https://github.com/pantor/ruckig).
// Copyright (c) 2021 Lars Berscheid, MIT licence (see LICENSE in this folder).

import { Profile } from "./profile";
import { DBL_EPSILON } from "./roots";

/** A blocked interval of durations: a coordinate cannot take any duration strictly between `left` and `right`. */
export class Interval {
  left: number; // [s]
  right: number; // [s]
  /** Profile corresponding to right (end) time */
  profile: Profile = new Profile();

  constructor(left: number, right: number) {
    this.left = left;
    this.right = right;
  }

  /** The interval between the durations of two profiles; it keeps the longer one. */
  static between(profile_left: Profile, profile_right: Profile): Interval {
    const left_duration = profile_left.tSum[6] + profile_left.brake.duration + profile_left.accel.duration;
    const right_duration = profile_right.tSum[6] + profile_right.brake.duration + profile_right.accel.duration;
    if (left_duration < right_duration) {
      const interval = new Interval(left_duration, right_duration);
      interval.profile.assign(profile_right);
      return interval;
    }
    const interval = new Interval(right_duration, left_duration);
    interval.profile.assign(profile_left);
    return interval;
  }

  clone(): Interval {
    const copy = new Interval(this.left, this.right);
    copy.profile.assign(this.profile);
    return copy;
  }
}

/** Which times are possible for synchronization? */
export class Block {
  /** Save min profile so that it doesn't need to be recalculated in Step2 */
  readonly p_min: Profile = new Profile();
  t_min: number = 0.0; // [s]

  /** Max. 2 intervals can be blocked: called a and b with corresponding profiles, order does not matter */
  a: Interval | undefined = undefined;
  b: Interval | undefined = undefined;

  setMinProfile(profile: Profile): void {
    this.p_min.assign(profile);
    this.t_min = this.p_min.tSum[6] + this.p_min.brake.duration + this.p_min.accel.duration;
    this.a = undefined;
    this.b = undefined;
  }

  private static removeProfile(valid_profiles: Profile[], valid_profile_counter: number, index: number): number {
    for (let i = index; i < valid_profile_counter - 1; ++i) {
      valid_profiles[i].assign(valid_profiles[i + 1]);
    }
    return valid_profile_counter - 1;
  }

  /**
   * Sets `block` from the first `valid_profile_counter` of `valid_profiles`, the extremal profiles of a coordinate,
   * and returns whether their number makes sense: one, or an odd number with blocked intervals between them.
   */
  static calculateBlock(block: Block, valid_profiles: Profile[], valid_profile_counter: number, numerical_robust: boolean = true): boolean {
    if (valid_profile_counter === 1) {
      block.setMinProfile(valid_profiles[0]);
      return true;

    } else if (valid_profile_counter === 2) {
      if (Math.abs(valid_profiles[0].tSum[6] - valid_profiles[1].tSum[6]) < 8 * DBL_EPSILON) {
        block.setMinProfile(valid_profiles[0]);
        return true;
      }

      if (numerical_robust) {
        const idx_min = (valid_profiles[0].tSum[6] < valid_profiles[1].tSum[6]) ? 0 : 1;
        const idx_else_1 = (idx_min + 1) % 2;

        block.setMinProfile(valid_profiles[idx_min]);
        block.a = Interval.between(valid_profiles[idx_min], valid_profiles[idx_else_1]);
        return true;
      }

    // Only happens due to numerical issues
    } else if (valid_profile_counter === 4) {
      // Find "identical" profiles
      if (Math.abs(valid_profiles[0].tSum[6] - valid_profiles[1].tSum[6]) < 32 * DBL_EPSILON && valid_profiles[0].direction !== valid_profiles[1].direction) {
        valid_profile_counter = Block.removeProfile(valid_profiles, valid_profile_counter, 1);
      } else if (Math.abs(valid_profiles[2].tSum[6] - valid_profiles[3].tSum[6]) < 256 * DBL_EPSILON && valid_profiles[2].direction !== valid_profiles[3].direction) {
        valid_profile_counter = Block.removeProfile(valid_profiles, valid_profile_counter, 3);
      } else if (Math.abs(valid_profiles[0].tSum[6] - valid_profiles[3].tSum[6]) < 256 * DBL_EPSILON && valid_profiles[0].direction !== valid_profiles[3].direction) {
        valid_profile_counter = Block.removeProfile(valid_profiles, valid_profile_counter, 3);
      } else {
        return false;
      }

    } else if (valid_profile_counter % 2 === 0) {
      return false;
    }

    // Find index of fastest profile
    let idx_min = 0;
    for (let i = 1; i < valid_profile_counter; ++i) {
      if (valid_profiles[i].tSum[6] < valid_profiles[idx_min].tSum[6]) {
        idx_min = i;
      }
    }

    block.setMinProfile(valid_profiles[idx_min]);

    if (valid_profile_counter === 3) {
      const idx_else_1 = (idx_min + 1) % 3;
      const idx_else_2 = (idx_min + 2) % 3;

      block.a = Interval.between(valid_profiles[idx_else_1], valid_profiles[idx_else_2]);
      return true;

    } else if (valid_profile_counter === 5) {
      const idx_else_1 = (idx_min + 1) % 5;
      const idx_else_2 = (idx_min + 2) % 5;
      const idx_else_3 = (idx_min + 3) % 5;
      const idx_else_4 = (idx_min + 4) % 5;

      if (valid_profiles[idx_else_1].direction === valid_profiles[idx_else_2].direction) {
        block.a = Interval.between(valid_profiles[idx_else_1], valid_profiles[idx_else_2]);
        block.b = Interval.between(valid_profiles[idx_else_3], valid_profiles[idx_else_4]);
      } else {
        block.a = Interval.between(valid_profiles[idx_else_1], valid_profiles[idx_else_4]);
        block.b = Interval.between(valid_profiles[idx_else_2], valid_profiles[idx_else_3]);
      }
      return true;
    }

    return false;
  }

  isBlocked(t: number): boolean {
    const { a, b } = this;
    return (t < this.t_min) || (a !== undefined && a.left < t && t < a.right) || (b !== undefined && b.left < t && t < b.right);
  }

  getProfile(t: number): Profile {
    const { a, b } = this;
    if (b !== undefined && t >= b.right) {
      return b.profile;
    }
    if (a !== undefined && t >= a.right) {
      return a.profile;
    }
    return this.p_min;
  }
}
