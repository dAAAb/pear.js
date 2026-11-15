// Ports src/ruckig/position_third_step2.cpp and the class PositionThirdOrderStep2 of include/ruckig/position.hpp
// of Ruckig 0.15.3 (https://github.com/pantor/ruckig).
// Copyright (c) 2021 Lars Berscheid, MIT licence (see LICENSE in this folder).
//
// The arithmetic is the C++'s text: the names of the numbers are the C++'s, and no expression is simplified or
// reordered, because the last digits of a profile's times decide whether it passes Profile's check. Only
// declarations, the calls of the standard library and the calls of the checks are worded for TypeScript. The lines
// are as long as the C++'s for the same reason: one expression, one line, to be compared side by side.

import { ControlSigns, Profile, ReachedLimits } from "./profile";
import { DBL_EPSILON, PairSet, max, min, polyDerivative, polyEval, polyMonicDerivative, pow2, shrinkInterval, solveCubic, solveQuartMonic, solveQuartMonicOf, tolerance } from "./roots";

/** Mathematical equations for Step 2 in third-order position interface: Time synchronization */
export class PositionThirdOrderStep2 {
  private readonly v0: number;
  private readonly a0: number;
  private readonly tf: number;
  private readonly vf: number;
  private readonly af: number;
  private readonly _vMax: number;
  private readonly _vMin: number;
  private readonly _aMax: number;
  private readonly _aMin: number;
  private readonly _jMax: number;

  // Pre-calculated expressions
  private readonly pd: number;
  private readonly tf_tf: number;
  private readonly tf_p3: number;
  private readonly tf_p4: number;
  private readonly vd: number;
  private readonly vd_vd: number;
  private readonly ad: number;
  private readonly ad_ad: number;
  private readonly v0_v0: number;
  private readonly vf_vf: number;
  private readonly a0_a0: number;
  private readonly a0_p3: number;
  private readonly a0_p4: number;
  private readonly a0_p5: number;
  private readonly a0_p6: number;
  private readonly af_af: number;
  private readonly af_p3: number;
  private readonly af_p4: number;
  private readonly af_p5: number;
  private readonly af_p6: number;
  private readonly jMax_jMax: number;
  private readonly g1: number;
  private readonly g2: number;

  minimize_jerk: boolean = false;

  constructor(tf: number, p0: number, v0: number, a0: number, pf: number, vf: number, af: number, vMax: number, vMin: number, aMax: number, aMin: number, jMax: number) {
    this.v0 = v0;
    this.a0 = a0;
    this.tf = tf;
    this.vf = vf;
    this.af = af;
    this._vMax = vMax;
    this._vMin = vMin;
    this._aMax = aMax;
    this._aMin = aMin;
    this._jMax = jMax;

    this.pd = pf - p0;
    this.tf_tf = tf * tf;
    this.tf_p3 = this.tf_tf * tf;
    this.tf_p4 = this.tf_tf * this.tf_tf;

    this.vd = vf - v0;
    this.vd_vd = this.vd * this.vd;
    this.v0_v0 = v0 * v0;
    this.vf_vf = vf * vf;

    this.ad = af - a0;
    this.ad_ad = this.ad * this.ad;
    this.a0_a0 = a0 * a0;
    this.af_af = af * af;

    this.a0_p3 = a0 * this.a0_a0;
    this.a0_p4 = this.a0_a0 * this.a0_a0;
    this.a0_p5 = this.a0_p3 * this.a0_a0;
    this.a0_p6 = this.a0_p4 * this.a0_a0;
    this.af_p3 = af * this.af_af;
    this.af_p4 = this.af_af * this.af_af;
    this.af_p5 = this.af_p3 * this.af_af;
    this.af_p6 = this.af_p4 * this.af_af;

    // max values needs to be invariant to plus minus sign change
    this.jMax_jMax = jMax * jMax;

    this.g1 = -this.pd + tf*v0;
    this.g2 = -2*this.pd + tf*(v0 + vf);
  }

  private timeAcc0Acc1Vel(profile: Profile, vMax: number, vMin: number, aMax: number, aMin: number, jMax: number): boolean {
    const { a0, tf, vf, af, pd, vd, vd_vd, ad, a0_a0, a0_p3, a0_p4, af_af, af_p3, af_p4, jMax_jMax, g1 } = this;

    // Profile UDDU, Solution 1
    if ((2*(aMax - aMin) + ad)/jMax < tf) {
      const h1 = Math.sqrt((a0_p4 + af_p4 - 4*a0_p3*(2*aMax + aMin)/3 - 4*af_p3*(aMax + 2*aMin)/3 + 2*(a0_a0 - af_af)*aMax*aMax + (4*a0*aMax - 2*a0_a0)*(af_af - 2*af*aMin + (aMin - aMax)*aMin + 2*jMax*(aMin*tf - vd)) + 2*af_af*(aMin*aMin + 2*jMax*(aMax*tf - vd)) + 4*jMax*(2*aMin*(af*vd + jMax*g1) + (aMax*aMax - aMin*aMin)*vd + jMax*vd_vd) + 8*aMax*jMax_jMax*(pd - tf*vf))/(aMax*aMin) + 4*af_af + 2*a0_a0 + (4*af + aMax - aMin)*(aMax - aMin) + 4*jMax*(aMin - aMax + jMax*tf - 2*af)*tf) * Math.abs(jMax)/jMax;

      profile.t[0] = (-a0 + aMax)/jMax;
      profile.t[1] = (-(af_af - a0_a0 + 2*aMax*aMax + aMin*(aMin - 2*ad - 3*aMax) + 2*jMax*(aMin*tf - vd)) + aMin*h1)/(2*(aMax - aMin)*jMax);
      profile.t[2] = aMax/jMax;
      profile.t[3] = (aMin - aMax + h1)/(2*jMax);
      profile.t[4] = -aMin/jMax;
      profile.t[5] = tf - (profile.t[0] + profile.t[1] + profile.t[2] + profile.t[3] + 2*profile.t[4] + af/jMax);
      profile.t[6] = profile.t[4] + af/jMax;

      if (profile.checkWithTiming(ControlSigns.UDDU, ReachedLimits.ACC0_ACC1_VEL, tf, jMax, vMax, vMin, aMax, aMin)) {
        return true;
      }
    }

    // Profile UDUD
    if ((-a0 + 4*aMax - af)/jMax < tf) {
      profile.t[0] = (-a0 + aMax)/jMax;
      profile.t[1] = (3*(a0_p4 + af_p4) - 4*(a0_p3 + af_p3)*aMax - 4*af_p3*aMax + 24*(a0 + af)*aMax*aMax*aMax - 6*(af_af + a0_a0)*(aMax*aMax - 2*jMax*vd) + 6*a0_a0*(af_af - 2*af*aMax - 2*aMax*jMax*tf) - 12*aMax*aMax*(2*aMax*aMax - 2*aMax*jMax*tf + jMax*vd) - 24*af*aMax*jMax*vd + 12*jMax_jMax*(2*aMax*g1 + vd_vd))/(12*aMax*jMax*(a0_a0 + af_af - 2*(a0 + af)*aMax + 2*(aMax*aMax - aMax*jMax*tf + jMax*vd)));
      profile.t[2] = aMax/jMax;
      profile.t[3] = (-a0_a0 - af_af + 2*aMax*(a0 + af - 2*aMax) - 2*jMax*vd)/(2*aMax*jMax) + tf;
      profile.t[4] = profile.t[2];
      profile.t[5] = tf - (profile.t[0] + profile.t[1] + profile.t[2] + profile.t[3] + 2*profile.t[4] - af/jMax);
      profile.t[6] = profile.t[4] - af/jMax;

      if (profile.checkWithTiming(ControlSigns.UDUD, ReachedLimits.ACC0_ACC1_VEL, tf, jMax, vMax, vMin, aMax, aMin)) {
        return true;
      }
    }

    return false;
  }

  private timeAcc1Vel(profile: Profile, vMax: number, vMin: number, aMax: number, aMin: number, jMax: number): boolean {
    const { v0, a0, tf, af, pd, vd, vd_vd, ad, a0_a0, a0_p3, a0_p4, af_af, af_p3, af_p4, jMax_jMax, g1 } = this;

    // Profile UDDU
    {
      const ph1 = a0_a0 + af_af - aMin*(a0 + 2*af - aMin) - 2*jMax*(vd - aMin*tf);
      const ph2 = 2*aMin*(jMax*g1 + af*vd) - aMin*aMin*vd + jMax*vd_vd;
      const ph3 = af_af + aMin*(aMin - 2*af) - 2*jMax*(vd - aMin*tf);

      const polynom = new Array<number>(4);
      polynom[0] = (2*(2*a0 - aMin))/jMax;
      polynom[1] = (4*a0_a0 + ph1 - 3*a0*aMin)/jMax_jMax;
      polynom[2] = (2*a0*ph1)/(jMax_jMax*jMax);
      polynom[3] = (3*(a0_p4 + af_p4) - 4*(a0_p3 + 2*af_p3)*aMin + 6*af_af*(aMin*aMin - 2*jMax*vd) + 12*jMax*ph2 + 6*a0_a0*ph3)/(12*jMax_jMax*jMax_jMax);

      const t_min = -a0/jMax;
      const t_max = min((tf + 2*aMin/jMax - (a0 + af)/jMax)/2, (aMax - a0)/jMax);

      const roots = solveQuartMonicOf(polynom);
      for (let t of roots.values()) {
        if (t < t_min || t > t_max) {
          continue;
        }

        // Single Newton step (regarding pd)
        if (Math.abs(a0 + jMax*t) > 16*DBL_EPSILON) {
          const h0 = jMax*t*t;
          const orig = -pd + (3*(a0_p4 + af_p4) - 8*af_p3*aMin - 4*a0_p3*aMin + 6*af_af*(aMin*aMin + 2*jMax*(h0 - vd)) + 6*a0_a0*(af_af - 2*af*aMin + aMin*aMin + 2*aMin*jMax*(-2*t + tf) + 2*jMax*(5*h0 - vd)) + 24*a0*jMax*t*(a0_a0 + af_af - 2*af*aMin + aMin*aMin + 2*jMax*(aMin*(-t + tf) + h0 - vd)) - 24*af*aMin*jMax*(h0 - vd) + 12*jMax*(aMin*aMin*(h0 - vd) + jMax*(h0 - vd)*(h0 - vd)))/(24*aMin*jMax_jMax) + h0*(tf - t) + tf*v0;
          const deriv = (a0 + jMax*t)*((a0_a0 + af_af)/(aMin*jMax) + (aMin - a0 - 2*af)/jMax + (4*a0*t + 2*h0 - 2*vd)/aMin + 2*tf - 3*t);

          t -= orig / deriv;
        }

        const h1 = -((a0_a0 + af_af)/2 + jMax*(-vd + 2*a0*t + jMax*t*t))/aMin;

        profile.t[0] = t;
        profile.t[1] = 0;
        profile.t[2] = a0/jMax + t;
        profile.t[3] = tf - (h1 - aMin + a0 + af)/jMax - 2*t;
        profile.t[4] = -aMin/jMax;
        profile.t[5] = (h1 + aMin)/jMax;
        profile.t[6] = profile.t[4] + af/jMax;

        if (profile.checkWithTiming(ControlSigns.UDDU, ReachedLimits.ACC1_VEL, tf, jMax, vMax, vMin, aMax, aMin)) {
          return true;
        }
      }
    }

    // Profile UDUD
    {
      const ph1 = a0_a0 - af_af + (2*af - a0)*aMax - aMax*aMax - 2*jMax*(vd - aMax*tf);
      const ph2 = aMax*aMax + 2*jMax*vd;
      const ph3 = af_af + ph2 - 2*aMax*(af + jMax*tf);
      const ph4 = 2*aMax*jMax*g1 + aMax*aMax*vd + jMax*vd_vd;

      const polynom = new Array<number>(4);
      polynom[0] = (4*a0 - 2*aMax)/jMax;
      polynom[1] = (4*a0_a0 - 3*a0*aMax + ph1)/jMax_jMax;
      polynom[2] = (2*a0*ph1)/(jMax_jMax*jMax);
      polynom[3] = (3*(a0_p4 + af_p4) - 4*(a0_p3 + 2*af_p3)*aMax - 24*af*aMax*jMax*vd + 12*jMax*ph4 - 6*a0_a0*ph3 + 6*af_af*ph2)/(12*jMax_jMax*jMax_jMax);

      const t_min = -a0/jMax;
      const t_max = min((tf + ad/jMax - 2*aMax/jMax)/2, (aMax - a0)/jMax);

      const roots = solveQuartMonicOf(polynom);
      for (let t of roots.values()) {
        if (t > t_max || t < t_min) {
          continue;
        }

        const h1 = ((a0_a0 - af_af)/2 + jMax_jMax*t*t - jMax*(vd - 2*a0*t))/aMax;

        profile.t[0] = t;
        profile.t[1] = 0;
        profile.t[2] = t + a0/jMax;
        profile.t[3] = tf + (h1 + ad - aMax)/jMax - 2*t;
        profile.t[4] = aMax/jMax;
        profile.t[5] = -(h1 + aMax)/jMax;
        profile.t[6] = profile.t[4] - af/jMax;

        if (profile.checkWithTiming(ControlSigns.UDUD, ReachedLimits.ACC1_VEL, tf, jMax, vMax, vMin, aMax, aMin)) {
          return true;
        }
      }
    }

    return false;
  }

  private timeAcc0Vel(profile: Profile, vMax: number, vMin: number, aMax: number, aMin: number, jMax: number): boolean {
    const { a0, tf, vf, af, pd, vd, vd_vd, ad, a0_a0, a0_p3, a0_p4, af_af, af_p3, af_p4, jMax_jMax } = this;

    if (tf < max((-a0 + aMax)/jMax, 0.0) + max(aMax/jMax, 0.0)) {
      return false;
    }

    const ph1 = 12*jMax*(-aMax*aMax*vd - jMax*vd_vd + 2*aMax*jMax*(-pd + tf*vf));

    // Profile UDDU
    {
      const polynom = new Array<number>(4);
      polynom[0] = (2*aMax)/jMax;
      polynom[1] = (a0_a0 - af_af + 2*ad*aMax + aMax*aMax + 2*jMax*(vd - aMax*tf))/jMax_jMax;
      polynom[2] = 0;
      polynom[3] = -(-3*(a0_p4 + af_p4) + 4*(af_p3 + 2*a0_p3)*aMax - 12*a0*aMax*(af_af - 2*jMax*vd) + 6*a0_a0*(af_af - aMax*aMax - 2*jMax*vd) + 6*af_af*(aMax*aMax - 2*aMax*jMax*tf + 2*jMax*vd) + ph1)/(12*jMax_jMax*jMax_jMax);

      const t_min = -af/jMax;
      const t_max = min(tf - (2*aMax - a0)/jMax, -aMin/jMax);

      const roots = solveQuartMonicOf(polynom);
      for (let t of roots.values()) {
        if (t < t_min || t > t_max) {
          continue;
        }

        // Single Newton step (regarding pd)
        if (t > DBL_EPSILON) {
          let h1 = jMax*t*t + vd;
          let orig = (-3*(a0_p4 + af_p4) + 4*(af_p3 + 2*a0_p3)*aMax - 24*af*aMax*jMax_jMax*t*t - 12*a0*aMax*(af_af - 2*jMax*h1) + 6*a0_a0*(af_af - aMax*aMax - 2*jMax*h1) + 6*af_af*(aMax*aMax - 2*aMax*jMax*tf + 2*jMax*h1) - 12*jMax*(aMax*aMax*h1 + jMax*h1*h1 + 2*aMax*jMax*(pd + jMax*t*t*(t - tf) - tf*vf)))/(24*aMax*jMax_jMax);
          let deriv = -t*(a0_a0 - af_af + 2*aMax*(ad - jMax*tf) + aMax*aMax + 3*aMax*jMax*t + 2*jMax*h1)/aMax;

          t -= orig / deriv;
        }

        const h1 = ((a0_a0 - af_af)/2 + jMax*(jMax*t*t + vd))/aMax;

        profile.t[0] = (-a0 + aMax)/jMax;
        profile.t[1] = (h1 - aMax)/jMax;
        profile.t[2] = aMax/jMax;
        profile.t[3] = tf - (h1 + ad + aMax)/jMax - 2*t;
        profile.t[4] = t;
        profile.t[5] = 0;
        profile.t[6] = af/jMax + t;

        if (profile.checkWithTiming(ControlSigns.UDDU, ReachedLimits.ACC0_VEL, tf, jMax, vMax, vMin, aMax, aMin)) {
          return true;
        }
      }
    }

    // Profile UDUD
    {
      const polynom = new Array<number>(4);
      polynom[0] = (-2*aMax)/jMax;
      polynom[1] = -(a0_a0 + af_af - 2*(a0 + af)*aMax + aMax*aMax + 2*jMax*(vd - aMax*tf))/jMax_jMax;
      polynom[2] = 0;
      polynom[3] = (3*(a0_p4 + af_p4) - 4*(af_p3 + 2*a0_p3)*aMax + 6*a0_a0*(af_af + aMax*aMax + 2*jMax*vd) - 12*a0*aMax*(af_af + 2*jMax*vd) + 6*af_af*(aMax*aMax - 2*aMax*jMax*tf + 2*jMax*vd) - ph1)/(12*jMax_jMax*jMax_jMax);

      const t_min = af/jMax;
      const t_max = min(tf - aMax/jMax, aMax/jMax);

      const roots = solveQuartMonicOf(polynom);
      for (let t of roots.values()) {
        if (t < t_min || t > t_max) {
          continue;
        }

        // Single Newton step (regarding pd)
        {
          let h1 = jMax*t*t - vd;
          let orig = -(3*(a0_p4 + af_p4) - 4*(2*a0_p3 + af_p3)*aMax + 24*af*aMax*jMax_jMax*t*t - 12*a0*aMax*(af_af - 2*jMax*h1) + 6*a0_a0*(af_af + aMax*aMax - 2*jMax*h1) + 6*af_af*(aMax*aMax - 2*jMax*(tf*aMax + h1)) + 12*jMax*(-aMax*aMax*h1 + jMax*h1*h1 - 2*aMax*jMax*(-pd + jMax*t*t*(t - tf) + tf*vf)))/(24*aMax*jMax_jMax);
          let deriv = t*(a0_a0 + af_af - 2*jMax*h1 - 2*(a0 + af + jMax*tf)*aMax + aMax*aMax + 3*aMax*jMax*t)/aMax;

          t -= orig / deriv;
        }

        const h1 = ((a0_a0 + af_af)/2 + jMax*(vd - jMax*t*t))/aMax;

        profile.t[0] = (-a0 + aMax)/jMax;
        profile.t[1] = (h1 - aMax)/jMax;
        profile.t[2] = aMax/jMax;
        profile.t[3] = tf - (h1 - a0 - af + aMax)/jMax - 2*t;
        profile.t[4] = t;
        profile.t[5] = 0;
        profile.t[6] = -(af/jMax) + t;

        if (profile.checkWithTiming(ControlSigns.UDUD, ReachedLimits.ACC0_VEL, tf, jMax, vMax, vMin, aMax, aMin)) {
          return true;
        }
      }
    }

    return false;
  }

  private timeVel(profile: Profile, vMax: number, vMin: number, aMax: number, aMin: number, jMax: number): boolean {
    const { v0, a0, tf, vf, af, pd, tf_tf, vd, vd_vd, ad, a0_a0, a0_p3, a0_p4, a0_p5, a0_p6, af_af, af_p3, af_p4, af_p6, jMax_jMax, g1 } = this;

    const tz_min = max(0.0, -a0/jMax);
    const tz_max = min((tf - a0/jMax)/2, (aMax - a0)/jMax);

    // Profile UDDU
    if (Math.abs(v0) < DBL_EPSILON && Math.abs(a0) < DBL_EPSILON && Math.abs(vf) < DBL_EPSILON && Math.abs(af) < DBL_EPSILON) {
      const polynom = new Array<number>(4);
      polynom[0] = 1;
      polynom[1] = -tf/2;
      polynom[2] = 0;
      polynom[3] = pd/(2*jMax);

      const roots = solveCubic(polynom[0], polynom[1], polynom[2], polynom[3]);
      for (let t of roots.values()) {
        if (t > tf/4) {
          continue;
        }

        // Single Newton step (regarding pd)
        if (t > DBL_EPSILON) {
          const orig = -pd + jMax*t*t*(tf - 2*t);
          const deriv = 2*jMax*t*(tf - 3*t);
          t -= orig / deriv;
        }

        profile.t[0] = t;
        profile.t[1] = 0;
        profile.t[2] = t;
        profile.t[3] = tf - 4*t;
        profile.t[4] = t;
        profile.t[5] = 0;
        profile.t[6] = t;

        if (profile.checkWithTiming(ControlSigns.UDDU, ReachedLimits.VEL, tf, jMax, vMax, vMin, aMax, aMin)) {
          return true;
        }
      }

    } else {
      const p1 = af_af - 2*jMax*(-2*af*tf + jMax*tf_tf + 3*vd);
      const ph1 = af_p3 - 3*jMax_jMax*g1 - 3*af*jMax*vd;
      const ph2 = af_p4 + 8*af_p3*jMax*tf + 12*jMax*(3*jMax*vd_vd - af_af*vd + 2*af*jMax*(g1 - tf*vd) - 2*jMax_jMax*tf*g1);
      const ph3 = a0*(af - jMax*tf);
      const ph4 = jMax*(-ad + jMax*tf);

      // Find root of 5th order polynom
      const polynom = new Array<number>(6);
      polynom[0] = 1.0;
      polynom[1] = (15*a0_a0 + af_af + 4*af*jMax*tf - 16*ph3 - 2*jMax*(jMax*tf_tf + 3*vd))/(4*ph4);
      polynom[2] = (29*a0_p3 - 2*af_p3 - 33*a0*ph3 + 6*jMax_jMax*g1 + 6*af*jMax*vd + 6*a0*p1)/(6*jMax*ph4);
      polynom[3] = (61*a0_p4 - 76*a0_a0*ph3 - 16*a0*ph1 + 30*a0_a0*p1 + ph2)/(24*jMax_jMax*ph4);
      polynom[4] = (a0*(7*a0_p4 - 10*a0_a0*ph3 - 4*a0*ph1 + 6*a0_a0*p1 + ph2))/(12*jMax_jMax*jMax*ph4);
      polynom[5] = (7*a0_p6 + af_p6 - 12*a0_p4*ph3 + 48*af_p3*jMax_jMax*g1 - 8*a0_p3*ph1 - 72*jMax_jMax*jMax*(jMax*g1*g1 + vd_vd*vd + 2*af*g1*vd) - 6*af_p4*jMax*vd + 36*af_af*jMax_jMax*vd_vd + 9*a0_p4*p1 + 3*a0_a0*ph2)/(144*jMax_jMax*jMax_jMax*ph4);

      const deriv = polyMonicDerivative(polynom);
      const dderiv = polyDerivative(deriv);

      // Solve 4th order derivative analytically
      const d_extremas = solveQuartMonic(deriv[1], deriv[2], deriv[3], deriv[4]);

      let tz_current = tz_min;

      const check_root = (t: number): boolean => {
        // Single Newton step (regarding pd)
        {
          const h1 = Math.sqrt((a0_a0 + af_af)/(2*jMax_jMax) + (2*a0*t + jMax*t*t - vd)/jMax);
          const orig = -pd - (2*a0_p3 + 4*af_p3 + 24*a0*jMax*t*(af + jMax*(h1 + t - tf)) + 6*a0_a0*(af + jMax*(2*t - tf)) + 6*(a0_a0 + af_af)*jMax*h1 + 12*af*jMax*(jMax*t*t - vd) + 12*jMax_jMax*(jMax*t*t*(h1 + t - tf) - tf*v0 - h1*vd))/(12*jMax_jMax);
          const deriv_newton = -(a0 + jMax*t)*(3*(h1 + t) - 2*tf + (a0 + 2*af)/jMax);
          if (!Number.isNaN(orig) && !Number.isNaN(deriv_newton) && Math.abs(deriv_newton) > DBL_EPSILON) {
            t -= orig / deriv_newton;
          }
        }

        if (t > tf || Number.isNaN(t)) {
          return false;
        }

        const h1 = Math.sqrt((a0_a0 + af_af)/(2*jMax_jMax) + (t*(2*a0 + jMax*t) - vd)/jMax);

        profile.t[0] = t;
        profile.t[1] = 0;
        profile.t[2] = t + a0/jMax;
        profile.t[3] = tf - 2*(t + h1) - (a0 + af)/jMax;
        profile.t[4] = h1;
        profile.t[5] = 0;
        profile.t[6] = h1 + af/jMax;

        return profile.checkWithTiming(ControlSigns.UDDU, ReachedLimits.VEL, tf, jMax, vMax, vMin, aMax, aMin);
      };

      for (let tz of d_extremas.values()) {
        if (tz >= tz_max) {
          continue;
        }

        const orig = polyEval(deriv, tz);
        if (Math.abs(orig) > tolerance) {
          tz -= orig / polyEval(dderiv, tz);
        }

        const val_new = polyEval(polynom, tz);
        if (Math.abs(val_new) < 64 * Math.abs(polyEval(dderiv, tz)) * tolerance) {
          if (check_root(tz)) {
            return true;
          }
        } else if (polyEval(polynom, tz_current) * val_new < 0) {
          if (check_root(shrinkInterval(polynom, tz_current, tz))) {
            return true;
          }
        }
        tz_current = tz;
      }
      const val_max = polyEval(polynom, tz_max);
      if (polyEval(polynom, tz_current) * val_max < 0) {
        if (check_root(shrinkInterval(polynom, tz_current, tz_max))) {
          return true;
        }
      } else if (Math.abs(val_max) < 8 * DBL_EPSILON) {
        if (check_root(tz_max)) {
          return true;
        }
      }
    }

    // Profile UDUD
    {
      const ph1 = af_af - 2*jMax*(2*af*tf + jMax*tf_tf - 3*vd);
      const ph2 = af_p3 - 3*jMax_jMax*g1 + 3*af*jMax*vd;
      const ph3 = 2*jMax*tf*g1 + 3*vd_vd;
      const ph4 = af_p4 - 8*af_p3*jMax*tf + 12*jMax*(jMax*ph3 + af_af*vd + 2*af*jMax*(g1 - tf*vd));
      const ph5 = af + jMax*tf;

      // Find root of 6th order polynom
      const polynom = new Array<number>(7);
      polynom[0] = 1.0;
      polynom[1] = (5*a0 - ph5)/jMax;
      polynom[2] = (39*a0_a0 - ph1 - 16*a0*ph5)/(4*jMax_jMax);
      polynom[3] = (55*a0_p3 - 33*a0_a0*ph5 - 6*a0*ph1 + 2*ph2)/(6*jMax_jMax*jMax);
      polynom[4] = (101*a0_p4 + ph4 - 76*a0_p3*ph5 - 30*a0_a0*ph1 + 16*a0*ph2)/(24*jMax_jMax*jMax_jMax);
      polynom[5] = (a0*(11*a0_p4 + ph4 - 10*a0_p3*ph5 - 6*a0_a0*ph1 + 4*a0*ph2))/(12*jMax_jMax*jMax_jMax*jMax);
      polynom[6] = (11*a0_p6 - af_p6 - 12*a0_p5*ph5 - 48*af_p3*jMax_jMax*g1 - 9*a0_p4*ph1 + 72*jMax_jMax*jMax*(jMax*g1*g1 - vd_vd*vd - 2*af*g1*vd) - 6*af_p4*jMax*vd - 36*af_af*jMax_jMax*vd_vd + 8*a0_p3*ph2 + 3*a0_a0*ph4)/(144*jMax_jMax*jMax_jMax*jMax_jMax);

      const deriv = polyMonicDerivative(polynom);
      const dderiv = polyMonicDerivative(deriv);

      let dd_tz_current = tz_min;
      const dd_tz_intervals = new PairSet();

      const dd_extremas = solveQuartMonic(dderiv[1], dderiv[2], dderiv[3], dderiv[4]);
      for (let tz of dd_extremas.values()) {
        if (tz >= tz_max) {
          continue;
        }

        const orig = polyEval(dderiv, tz);
        if (Math.abs(orig) > tolerance) {
          tz -= orig / polyEval(polyDerivative(dderiv), tz);
        }

        if (polyEval(deriv, dd_tz_current) * polyEval(deriv, tz) < 0) {
          dd_tz_intervals.insert({ first: dd_tz_current, second: tz });
        }
        dd_tz_current = tz;
      }
      if (polyEval(deriv, dd_tz_current) * polyEval(deriv, tz_max) < 0) {
        dd_tz_intervals.insert({ first: dd_tz_current, second: tz_max });
      }

      let tz_current = tz_min;

      const check_root = (t: number): boolean => {
        // Double Newton step (regarding pd)
        {
          let h1 = Math.sqrt((af_af - a0_a0)/(2*jMax_jMax) - ((2*a0 + jMax*t)*t - vd)/jMax);
          let orig = -pd + (af_p3 - a0_p3 + 3*a0_a0*jMax*(tf - 2*t))/(6*jMax_jMax) + (2*a0 + jMax*t)*t*(tf - t) + (jMax*h1 - af)*h1*h1 + tf*v0;
          let deriv_newton = (a0 + jMax*t)*(2*(af + jMax*tf) - 3*jMax*(h1 + t) - a0)/jMax;

          t -= orig / deriv_newton;

          h1 = Math.sqrt((af_af - a0_a0)/(2*jMax_jMax) - ((2*a0 + jMax*t)*t - vd)/jMax);
          orig = -pd + (af_p3 - a0_p3 + 3*a0_a0*jMax*(tf - 2*t))/(6*jMax_jMax) + (2*a0 + jMax*t)*t*(tf - t) + (jMax*h1 - af)*h1*h1 + tf*v0;
          if (Math.abs(orig) > 1e-9) {
            deriv_newton = (a0 + jMax*t)*(2*(af + jMax*tf) - 3*jMax*(h1 + t) - a0)/jMax;

            t -= orig / deriv_newton;
          }
        }

        const h1 = Math.sqrt((af_af - a0_a0)/(2*jMax_jMax) - ((2*a0 + jMax*t)*t - vd)/jMax);

        profile.t[0] = t;
        profile.t[1] = 0;
        profile.t[2] = t + a0/jMax;
        profile.t[3] = tf - 2*(t + h1) + ad/jMax;
        profile.t[4] = h1;
        profile.t[5] = 0;
        profile.t[6] = h1 - af/jMax;

        return profile.checkWithTiming(ControlSigns.UDUD, ReachedLimits.VEL, tf, jMax, vMax, vMin, aMax, aMin);
      };

      for (const interval of dd_tz_intervals.values()) {
        const tz = shrinkInterval(deriv, interval.first, interval.second);

        if (tz >= tz_max) {
          continue;
        }

        const p_val = polyEval(polynom, tz);
        if (Math.abs(p_val) < 64 * Math.abs(polyEval(dderiv, tz)) * tolerance) {
          if (check_root(tz)) {
            return true;
          }

        } else if (polyEval(polynom, tz_current) * p_val < 0) {
          if (check_root(shrinkInterval(polynom, tz_current, tz))) {
            return true;
          }
        }
        tz_current = tz;
      }
      if (polyEval(polynom, tz_current) * polyEval(polynom, tz_max) < 0) {
        if (check_root(shrinkInterval(polynom, tz_current, tz_max))) {
          return true;
        }
      }
    }

    return false;
  }

  private timeAcc0Acc1(profile: Profile, vMax: number, vMin: number, aMax: number, aMin: number, jMax: number): boolean {
    const { v0, a0, tf, vf, af, pd, tf_tf, vd, vd_vd, ad, a0_a0, a0_p3, af_af, af_p3, g1, g2 } = this;

    if (Math.abs(a0) < DBL_EPSILON && Math.abs(af) < DBL_EPSILON) {
      const h1 = 2*aMin*g1 + vd_vd + aMax*(2*pd + aMin*tf_tf - 2*tf*vf);
      const h2 = ((aMax - aMin)*(-aMin*vd + aMax*(aMin*tf - vd)));

      const jf = h2/h1;
      profile.t[0] = aMax/jf;
      profile.t[1] = (-2*aMax*h1 + aMin*aMin*g2)/h2;
      profile.t[2] = profile.t[0];
      profile.t[3] = 0;
      profile.t[4] = -aMin/jf;
      profile.t[5] = tf - (2*profile.t[0] + profile.t[1] + 2*profile.t[4]);
      profile.t[6] = profile.t[4];

      return profile.checkWithTiming(ControlSigns.UDDU, ReachedLimits.ACC0_ACC1, tf, jf, vMax, vMin, aMax, aMin, jMax);
    }

    // Profile UDDU, Solution 1
    // {
    //     profile.t[0] = (-a0 + aMax)/jMax;
    //     profile.t[1] = -((af_af - a0_a0)/2 + aMax*aMax + aMin*aMin - ad*aMin - 2*aMax*aMin + jMax*(aMin*tf - vd))/((aMax - aMin)*jMax);
    //     profile.t[2] = aMax/jMax;
    //     profile.t[3] = 0;
    //     profile.t[4] = -aMin/jMax;
    //     profile.t[5] = tf - (profile.t[0] + profile.t[1] + profile.t[2] + profile.t[3] + 2*profile.t[4] + af/jMax);
    //     profile.t[6] = profile.t[4] + af/jMax;

    //     if (profile.check_with_timing<ControlSigns::UDDU, ReachedLimits::ACC0_ACC1>(tf, jMax, vMax, vMin, aMax, aMin)) {
    //         std::cout << "f2" << std::endl;
    //         return true;
    //     }
    // }

    // UDDU
    {
      const h1 = Math.sqrt(144*pow2((aMax - aMin)*(-aMin*vd + aMax*(aMin*tf - vd)) - af_af*(aMax*tf - vd) + 2*af*aMin*(aMax*tf - vd) + a0_a0*(aMin*tf + v0 - vf) - 2*a0*aMax*(aMin*tf - vd)) + 48*ad*(3*a0_p3 - 3*af_p3 + 12*aMax*aMin*(-aMax + aMin) + 4*af_af*(aMax + 2*aMin) + a0*(-3*af_af + 8*af*(aMin - aMax) + 6*(aMax*aMax + 2*aMax*aMin - aMin*aMin)) + 6*af*(aMax*aMax - 2*aMax*aMin - aMin*aMin) + a0_a0*(3*af - 4*(2*aMax + aMin)))*(2*aMin*g1 + vd*vd + aMax*(2*pd + aMin*tf*tf - 2*tf*vf)));

      const jf = -(3*af_af*aMax*tf - 3*a0_a0*aMin*tf - 6*ad*aMax*aMin*tf + 3*aMax*aMin*(aMin - aMax)*tf + 3*(a0_a0 - af_af)*vd + 6*vd*(af*aMin - a0*aMax) + 3*(aMax*aMax - aMin*aMin)*vd + h1/4)/(6*(2*aMin*g1 + vd*vd + aMax*(2*pd + aMin*tf_tf - 2*tf*vf)));
      profile.t[0] = (aMax - a0)/jf;
      profile.t[1] = (a0_a0 - af_af + 2*ad*aMin - 2*(aMax*aMax - 2*aMax*aMin + aMin*aMin + aMin*jf*tf - jf*vd))/(2*(aMax - aMin)*jf);
      profile.t[2] = aMax/jf;
      profile.t[3] = 0;
      profile.t[4] = -aMin/jf;
      profile.t[5] = tf - (profile.t[0] + profile.t[1] + profile.t[2] + 2*profile.t[4] + af/jf);
      profile.t[6] = profile.t[4] + af/jf;

      if (profile.checkWithTiming(ControlSigns.UDDU, ReachedLimits.ACC0_ACC1, tf, jf, vMax, vMin, aMax, aMin, jMax)) {
        return true;
      }
    }

    return false;
  }

  private timeAcc1(profile: Profile, vMax: number, vMin: number, aMax: number, aMin: number, jMax: number): boolean {
    const { a0, tf, vf, af, pd, tf_tf, vd, vd_vd, ad, a0_a0, a0_p3, a0_p4, af_af, af_p3, af_p4, jMax_jMax, g1, g2 } = this;

    // a3 != 0
    // Case UDDU
    {
      const h0 = Math.sqrt(jMax_jMax*(a0_p4 + af_p4 - 4*af_p3*jMax*tf + 6*af_af*jMax_jMax*tf_tf - 4*a0_p3*(af - jMax*tf) + 6*a0_a0*(af - jMax*tf)*(af - jMax*tf) + 24*af*jMax_jMax*g1 - 4*a0*(af_p3 - 3*af_af*jMax*tf + 6*jMax_jMax*(-pd + tf*vf)) - 12*jMax_jMax*(-vd_vd + jMax*tf*g2))/3)/jMax;
      const h1 = Math.sqrt((a0_a0 + af_af - 2*a0*af - 2*ad*jMax*tf + 2*h0)/jMax_jMax + tf_tf);

      profile.t[0] = -(a0_a0 + af_af + 2*a0*(jMax*tf - af) - 2*jMax*vd + h0)/(2*jMax*(-ad + jMax*tf));
      profile.t[1] = 0;
      profile.t[2] = (tf - h1)/2 - ad/(2*jMax);
      profile.t[3] = 0;
      profile.t[4] = 0;
      profile.t[5] = h1;
      profile.t[6] = tf - (profile.t[0] + profile.t[2] + profile.t[5]);

      if (profile.checkWithTiming(ControlSigns.UDDU, ReachedLimits.ACC1, tf, jMax, vMax, vMin, aMax, aMin)) {
        return true;
      }
    }

    // Case UDUD
    {
      const h0 = Math.sqrt(jMax_jMax*(a0_p4 + af_p4 + 4*(af_p3 - a0_p3)*jMax*tf + 6*af_af*jMax_jMax*tf_tf + 6*a0_a0*(af + jMax*tf)*(af + jMax*tf) + 24*af*jMax_jMax*g1 - 4*a0*(a0_a0*af + af_p3 + 3*af_af*jMax*tf + 6*jMax_jMax*(-pd + tf*vf)) + 12*jMax_jMax*(vd_vd + jMax*tf*g2))/3)/jMax;
      const h1 = Math.sqrt((a0_a0 + af_af - 2*a0*af + 2*ad*jMax*tf + 2*h0)/jMax_jMax + tf_tf);

      profile.t[0] = 0;
      profile.t[1] = 0;
      profile.t[2] = -(a0_a0 + af_af - 2*a0*af + 2*jMax*(vd - a0*tf) + h0)/(2*jMax*(ad + jMax*tf));
      profile.t[3] = 0;
      profile.t[4] = ad/(2*jMax) + (tf - h1)/2;
      profile.t[5] = h1;
      profile.t[6] = tf - (profile.t[5] + profile.t[4] + profile.t[2]);

      if (profile.checkWithTiming(ControlSigns.UDUD, ReachedLimits.ACC1, tf, jMax, vMax, vMin, aMax, aMin)) {
        return true;
      }
    }

    // Case UDDU, Solution 2
    {
      const h0a = a0_p3 - af_p3 - 3*a0_a0*aMin + 3*aMin*aMin*(a0 + jMax*tf) + 3*af*aMin*(-aMin - 2*jMax*tf) - 3*af_af*(-aMin - jMax*tf) - 3*jMax_jMax*(-2*pd - aMin*tf_tf + 2*tf*vf);
      const h0b = a0_a0 + af_af - 2*(a0 + af)*aMin + 2*(aMin*aMin - jMax*(-aMin*tf + vd));
      const h0c = a0_p4 + 3*af_p4 - 4*(a0_p3 + 2*af_p3)*aMin + 6*a0_a0*aMin*aMin + 6*af_af*(aMin*aMin - 2*jMax*vd) + 12*jMax*(2*aMin*jMax*g1 - aMin*aMin*vd + jMax*vd_vd) + 24*af*aMin*jMax*vd - 4*a0*(af_p3 - 3*af*aMin*(-aMin - 2*jMax*tf) + 3*af_af*(-aMin - jMax*tf) + 3*jMax*(-aMin*aMin*tf + jMax*(-2*pd - aMin*tf_tf + 2*tf*vf)));
      const h1 = Math.abs(jMax)/jMax * Math.sqrt(4*h0a*h0a - 6*h0b*h0c);
      const h2 = 6*jMax*h0b;

      profile.t[0] = 0;
      profile.t[1] = 0;
      profile.t[2] = (2*h0a + h1)/h2;
      profile.t[3] = -(a0_a0 + af_af - 2*(a0 + af)*aMin + 2*(aMin*aMin + aMin*jMax*tf - jMax*vd))/(2*jMax*(a0 - aMin - jMax*profile.t[2]));
      profile.t[4] = (a0 - aMin)/jMax - profile.t[2];
      profile.t[5] = tf - (profile.t[2] + profile.t[3] + profile.t[4] + (af - aMin)/jMax);
      profile.t[6] = (af - aMin)/jMax;

      if (profile.checkWithTiming(ControlSigns.UDDU, ReachedLimits.ACC1, tf, jMax, vMax, vMin, aMax, aMin)) {
        return true;
      }
    }

    // Case UDUD, Solution 1
    {
      const h0a = -a0_p3 + af_p3 + 3*(a0_a0 - af_af)*aMax - 3*ad*aMax*aMax - 6*af*aMax*jMax*tf + 3*af_af*jMax*tf + 3*jMax*(aMax*aMax*tf + jMax*(-2*pd - aMax*tf_tf + 2*tf*vf));
      const h0b = a0_a0 - af_af + 2*ad*aMax + 2*jMax*(aMax*tf - vd);
      const h0c = a0_p4 + 3*af_p4 - 4*(a0_p3 + 2*af_p3)*aMax + 6*a0_a0*aMax*aMax - 24*af*aMax*jMax*vd + 12*jMax*(2*aMax*jMax*g1 + jMax*vd_vd + aMax*aMax*vd) + 6*af_af*(aMax*aMax + 2*jMax*vd) - 4*a0*(af_p3 + 3*af*aMax*(aMax - 2*jMax*tf) - 3*af_af*(aMax - jMax*tf) + 3*jMax*(aMax*aMax*tf + jMax*(-2*pd - aMax*tf_tf + 2*tf*vf)));
      const h1 = Math.abs(jMax)/jMax * Math.sqrt(4*h0a*h0a - 6*h0b*h0c);
      const h2 = 6*jMax*h0b;

      profile.t[0] = 0;
      profile.t[1] = 0;
      profile.t[2] = -(2*h0a + h1)/h2;
      profile.t[3] = 2*h1/h2;
      profile.t[4] = (aMax - a0)/jMax + profile.t[2];
      profile.t[5] = tf - (profile.t[2] + profile.t[3] + profile.t[4] + (-af + aMax)/jMax);
      profile.t[6] = (-af + aMax)/jMax;

      if (profile.checkWithTiming(ControlSigns.UDUD, ReachedLimits.ACC1, tf, jMax, vMax, vMin, aMax, aMin)) {
        return true;
      }
    }
    return false;
  }

  private timeAcc0(profile: Profile, vMax: number, vMin: number, aMax: number, aMin: number, jMax: number): boolean {
    const { v0, a0, tf, af, pd, tf_tf, vd, ad, ad_ad, a0_a0, a0_p3, af_af, af_p3, jMax_jMax, g1, g2 } = this;

    // UDUD
    {
      const h1 = Math.sqrt(ad_ad/(2*jMax_jMax) - ad*(aMax - a0)/(jMax_jMax) + (aMax*tf - vd)/jMax);

      profile.t[0] = (aMax - a0)/jMax;
      profile.t[1] = tf - ad/jMax - 2*h1;
      profile.t[2] = h1;
      profile.t[3] = 0;
      profile.t[4] = (af - aMax)/jMax + h1;
      profile.t[5] = 0;
      profile.t[6] = 0;

      if (profile.checkWithTiming(ControlSigns.UDUD, ReachedLimits.NONE, tf, jMax, vMax, vMin, aMax, aMin)) {
        return true;
      }
    }

    // UDUD
    {
      const h0a = -a0_a0 + af_af - 2*ad*aMax + 2*jMax*(aMax*tf - vd);
      const h0b = a0_p3 + 2*af_p3 - 6*af_af*aMax - 3*a0_a0*(af - jMax*tf) - 3*a0*aMax*(aMax - 2*af + 2*jMax*tf) - 3*jMax*(jMax*(-2*pd + aMax*tf_tf + 2*tf*v0) + aMax*(aMax*tf - 2*vd)) + 3*af*(aMax*aMax + 2*aMax*jMax*tf - 2*jMax*vd);
      const h0 = Math.abs(jMax) * Math.sqrt(4*h0b*h0b - 18*h0a*h0a*h0a);
      const h1 = 3*jMax*h0a;

      profile.t[0] = (-a0 + aMax)/jMax;
      profile.t[1] = (-a0_p3 + af_p3 + af_af*(-6*aMax + 3*jMax*tf) + a0_a0*(-3*af + 6*aMax + 3*jMax*tf) + 6*af*(aMax*aMax - jMax*vd) + 3*a0*(af_af - 2*(aMax*aMax + jMax*vd)) - 6*jMax*(aMax*(aMax*tf - 2*vd) + jMax*g2))/h1;
      profile.t[2] = -(ad + h0/h1)/(2*jMax) + tf/2 - profile.t[1]/2;
      profile.t[3] = h0/(jMax*h1);
      profile.t[4] = 0;
      profile.t[5] = 0;
      profile.t[6] = tf - (profile.t[0] + profile.t[1] + profile.t[2] + profile.t[3]);

      if (profile.checkWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, tf, jMax, vMax, vMin, aMax, aMin)) {
        return true;
      }
    }

    // a3 != 0

    // UDDU Solution 1
    {
      const h0a = a0_p3 + 2*af_p3 - 6*(af_af + aMax*aMax)*aMax - 6*(a0 + af)*aMax*jMax*tf + 9*aMax*aMax*(af + jMax*tf) + 3*a0*aMax*(-2*af + 3*aMax) + 3*a0_a0*(af - 2*aMax + jMax*tf) - 6*jMax_jMax*g1 + 6*(af - aMax)*jMax*vd - 3*aMax*jMax_jMax*tf_tf;
      const h0b = a0_a0 + af_af + 2*(aMax*aMax - (a0 + af)*aMax + jMax*(vd - aMax*tf));
      const h1 = Math.abs(jMax)/jMax * Math.sqrt(4*h0a*h0a - 18*h0b*h0b*h0b);
      const h2 = 6*jMax*h0b;

      profile.t[0] = (-a0 + aMax)/jMax;
      profile.t[1] = ad/jMax - 2 * profile.t[0] - (2*h0a - h1)/h2 + tf;
      profile.t[2] = -(2*h0a + h1)/h2;
      profile.t[3] = (2*h0a - h1)/h2;
      profile.t[4] = tf - (profile.t[0] + profile.t[1] + profile.t[2] + profile.t[3]);
      profile.t[5] = 0;
      profile.t[6] = 0;

      if (profile.checkWithTiming(ControlSigns.UDDU, ReachedLimits.ACC0, tf, jMax, vMax, vMin, aMax, aMin)) {
        return true;
      }
    }

    return false;
  }

  private timeNone(profile: Profile, vMax: number, vMin: number, aMax: number, aMin: number, jMax: number): boolean {
    const { v0, a0, tf, vf, af, pd, tf_tf, tf_p3, tf_p4, vd, vd_vd, ad, ad_ad, vf_vf, a0_a0, a0_p3, a0_p4, a0_p5, a0_p6, af_af, af_p3, af_p4, af_p5, af_p6, jMax_jMax, g1, g2 } = this;

    if (Math.abs(v0) < DBL_EPSILON && Math.abs(a0) < DBL_EPSILON && Math.abs(af) < DBL_EPSILON) {
      const h1 = Math.sqrt(tf_tf*vf_vf + pow2(4*pd - tf*vf));
      const jf = 4*(4*pd - 2*tf*vf + h1)/tf_p3;

      profile.t[0] = tf/4;
      profile.t[1] = 0;
      profile.t[2] = 2*profile.t[0];
      profile.t[3] = 0;
      profile.t[4] = 0;
      profile.t[5] = 0;
      profile.t[6] = profile.t[0];

      if (profile.checkWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, tf, jf, vMax, vMin, aMax, aMin, jMax)) {
        return true;
      }
    }

    if (Math.abs(a0) < DBL_EPSILON && Math.abs(af) < DBL_EPSILON) {
      // Solution 1
      // {
      //     const double h1 = std::sqrt(16*pd*(pd - tf*(v0 + vf)) + tf_tf*(5*v0_v0 + 6*v0*vf + 5*vf_vf));
      //     const double jf = 4*(4*pd - 2*tf*(v0 + vf) - h1)/tf_p3;

      //     profile.t[0] = (tf*(v0 + 3*vf) - 4*pd)/(4*vd);
      //     profile.t[1] = 0;
      //     profile.t[2] = tf/2;
      //     profile.t[3] = 0;
      //     profile.t[4] = 0;
      //     profile.t[5] = 0;
      //     profile.t[6] = profile.t[4];

      //     if (profile.check_with_timing<ControlSigns::UDDU, ReachedLimits::NONE>(tf, jf, vMax, vMin, aMax, aMin, jMax)) {
      //         std::cout << "i2" << std::endl;
      //         return true;
      //     }
      // }

      // Is that really needed?
      // Profiles with a3 != 0, Solution UDDU
      {
        // First acc, then constant
        {
          const polynom = new Array<number>(4);
          polynom[0] = -2*tf;
          polynom[1] = 2*vd/jMax + tf_tf;
          polynom[2] = 4*(pd - tf*vf)/jMax;
          polynom[3] = (vd_vd + jMax*tf*g2)/(jMax_jMax);

          const roots = solveQuartMonicOf(polynom);
          for (let t of roots.values()) {
            if (t > tf/2 || t > (aMax - a0)/jMax) {
              continue;
            }

            // Single Newton step (regarding pd)
            {
              const h1 = (jMax*t*(t - tf) + vd)/(jMax*(2*t - tf));
              const h2 = (2*jMax*t*(t - tf) + jMax*tf_tf - 2*vd)/(jMax*(2*t - tf)*(2*t - tf));
              const orig = (-2*pd + 2*tf*v0 + h1*h1*jMax*(tf - 2*t) + jMax*tf*(2*h1*t - t*t - (h1 - t)*tf))/2;
              const deriv = (jMax*tf*(2*t - tf)*(h2 - 1))/2 + h1*jMax*(tf - (2*t - tf)*h2 - h1);

              t -= orig / deriv;
            }

            profile.t[0] = t;
            profile.t[1] = 0;
            profile.t[2] = (jMax*t*(t - tf) + vd)/(jMax*(2*t - tf));
            profile.t[3] = tf - 2*t;
            profile.t[4] = t - profile.t[2];
            profile.t[5] = 0;
            profile.t[6] = 0;

            if (profile.checkWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, tf, jMax, vMax, vMin, aMax, aMin)) {
              return true;
            }
          }
        }
      }
    }

    // UDUD T 0246
    {
      const h0 = Math.sqrt(2*jMax_jMax*(2*pow2(a0_p3 - af_p3 - 3*af_af*jMax*tf + 9*af*jMax_jMax*tf_tf - 3*a0_a0*(af + jMax*tf) + 3*a0*pow2(af + jMax*tf) + 3*jMax_jMax*(8*pd + jMax*tf_tf*tf - 8*tf*vf)) - 3*(a0_a0 + af_af - 2*af*jMax*tf - 2*a0*(af + jMax*tf) - jMax*(jMax*tf_tf + 4*v0 - 4*vf))*(a0_p4 + af_p4 + 4*af_p3*jMax*tf + 6*af_af*jMax_jMax*tf_tf - 3*jMax_jMax*jMax_jMax*tf_tf*tf_tf - 4*a0_p3*(af + jMax*tf) + 6*a0_a0*pow2(af + jMax*tf) - 12*af*jMax_jMax*(8*pd + jMax*tf_tf*tf - 8*tf*v0) + 48*jMax_jMax*vd_vd + 48*jMax_jMax*jMax*tf*g2 - 4*a0*(af_p3 + 3*af_af*jMax*tf - 9*af*jMax_jMax*tf_tf - 3*jMax_jMax*(8*pd + jMax*tf_tf*tf - 8*tf*vf)))))/jMax;
      const h1 = 12*jMax*(-a0_a0 - af_af + 2*af*jMax*tf + 2*a0*(af + jMax*tf) + jMax*(jMax*tf_tf + 4*v0 - 4*vf));
      const h2 = -4*a0_p3 + 4*af_p3 + 12*a0_a0*af - 12*a0*af_af + 48*jMax_jMax*pd + 12*(a0_a0 - af_af)*jMax*tf - 24*jMax_jMax*tf*(v0 + vf) + 24*ad*jMax*vd;
      const h3 = 2*a0_p3 - 2*af_p3 - 6*a0_a0*af + 6*a0*af_af;

      profile.t[0] = (h3 - 48*jMax_jMax*(tf*vf - pd) - 6*(a0_a0 + af_af)*jMax*tf + 12*a0*af*jMax*tf + 6*(a0 + 3*af + jMax*tf)*tf_tf*jMax_jMax - h0)/h1;
      profile.t[1] = 0;
      profile.t[2] = (h2 + h0)/h1;
      profile.t[3] = 0;
      profile.t[4] = (-h2 + h0)/h1;
      profile.t[5] = 0;
      profile.t[6] = (-h3 + 48*jMax_jMax*(tf*v0 - pd) - 6*(a0_a0 + af_af)*jMax*tf + 12*a0*af*jMax*tf + 6*(af + 3*a0 + jMax*tf)*tf_tf*jMax_jMax - h0)/h1;

      if (profile.checkWithTiming(ControlSigns.UDUD, ReachedLimits.NONE, tf, jMax, vMax, vMin, aMax, aMin)) {
        return true;
      }
    }

    // Profiles with a3 != 0, Solution UDDU
    {
      // T 0234
      {
        const ph1 = af + jMax*tf;

        const polynom = new Array<number>(4);
        polynom[0] = -2*(ad + jMax*tf)/jMax;
        polynom[1] = 2*(a0_a0 + af_af + jMax*(af*tf + vd) - 2*a0*ph1)/jMax_jMax + tf_tf;
        polynom[2] = 2*(a0_p3 - af_p3 - 3*af_af*jMax*tf + 3*a0*ph1*(ph1 - a0) - 6*jMax_jMax*(-pd + tf*vf))/(3*jMax_jMax*jMax);
        polynom[3] = (a0_p4 + af_p4 + 4*af_p3*jMax*tf - 4*a0_p3*ph1 + 6*a0_a0*ph1*ph1 + 24*jMax_jMax*af*g1 - 4*a0*(af_p3 + 3*af_af*jMax*tf + 6*jMax_jMax*(-pd + tf*vf)) + 6*jMax_jMax*af_af*tf_tf + 12*jMax_jMax*(vd_vd + jMax*tf*g2))/(12*jMax_jMax*jMax_jMax);

        const t_min = ad/jMax;
        const t_max = min((aMax - a0)/jMax, (ad/jMax + tf) / 2);

        const roots = solveQuartMonicOf(polynom);
        for (let t of roots.values()) {
          if (t < t_min || t > t_max) {
            continue;
          }

          // Single Newton step (regarding pd)
          {
            const h0 = jMax*(2*t - tf) - ad;
            const h1 = (ad_ad - 2*af*jMax*t + 2*a0*jMax*(t - tf) + 2*jMax*(jMax*t*(t - tf) + vd))/(2*jMax*h0);
            const h2 = (-ad_ad + 2*jMax_jMax*(tf_tf + t*(t - tf)) + (a0 + af)*jMax*tf - ad*h0 - 2*jMax*vd)/(h0*h0);
            const orig = (-a0_p3 + af_p3 + 3*ad_ad*jMax*(h1 - t) + 3*ad*jMax_jMax*(h1 - t)*(h1 - t) - 3*a0*af*ad + 3*jMax_jMax*(a0*tf_tf - 2*pd + 2*tf*v0 + h1*h1*jMax*(tf - 2*t) + jMax*tf*(2*h1*t - t*t - (h1 - t)*tf)))/(6*jMax_jMax);
            const deriv = (h0*(-ad + jMax*tf)*(h2 - 1))/(2*jMax) + h1*(-ad + jMax*(tf - h1) - h0*h2);

            t -= orig / deriv;
          }

          profile.t[0] = t;
          profile.t[1] = 0;
          profile.t[2] = (ad_ad + 2*jMax*(-a0*tf - ad*t + jMax*t*(t - tf) + vd))/(2*jMax*(-ad + jMax*(2*t - tf)));
          profile.t[3] = ad/jMax + tf - 2*t;
          profile.t[4] = tf - (t + profile.t[2] + profile.t[3]);
          profile.t[5] = 0;
          profile.t[6] = 0;

          if (profile.checkWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, tf, jMax, vMax, vMin, aMax, aMin)) {
            return true;
          }
        }
      }

      // T 3456
      {
        const h1 = 3*jMax*(ad_ad + 2*jMax*(a0*tf - vd));
        const h2 = ad_ad + 2*jMax*(a0*tf - vd);
        const h0 = Math.sqrt(4*pow2(2*(a0_p3 - af_p3) - 6*a0_a0*(af - jMax*tf) + 6*jMax_jMax*g1 + 3*a0*(2*af_af - 2*jMax*af*tf + jMax_jMax*tf_tf) + 6*ad*jMax*vd) - 18*h2*h2*h2)/h1 * Math.abs(jMax)/jMax;

        profile.t[0] = 0;
        profile.t[1] = 0;
        profile.t[2] = 0;
        profile.t[3] = (af_p3 - a0_p3 + 3*(af_af - a0_a0)*jMax*tf - 3*ad*(a0*af + 2*jMax*vd) - 6*jMax_jMax*g2)/h1;
        profile.t[4] = (tf - profile.t[3] - h0)/2 - ad/(2*jMax);
        profile.t[5] = h0;
        profile.t[6] = (tf - profile.t[3] + ad/jMax - h0)/2;

        if (profile.checkWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, tf, jMax, vMax, vMin, aMax, aMin)) {
          return true;
        }
      }

      // T 2346
      {
        const ph1 = ad_ad + 2*(af + a0)*jMax*tf - jMax*(jMax*tf_tf + 4*vd);
        const ph2 = jMax*tf_tf*g1 - vd*(-2*pd - tf*v0 + 3*tf*vf);
        const ph3 = 5*af_af - 8*af*jMax*tf + 2*jMax*(2*jMax*tf_tf - vd);
        const ph4 = jMax_jMax*tf_p4 - 2*vd_vd + 8*jMax*tf*(-pd + tf*vf);
        const ph5 = (5*af_p4 - 8*af_p3*jMax*tf - 12*af_af*jMax*(jMax*tf_tf + vd) + 24*af*jMax_jMax*(-2*pd + jMax*tf_p3 + 2*tf*vf) - 6*jMax_jMax*ph4);
        const ph6 = -vd_vd + jMax*tf*(-2*pd + 3*tf*v0 - tf*vf) - af*g2;

        const polynom = new Array<number>(4);
        polynom[0] = -(4*(a0_p3 - af_p3) - 12*a0_a0*(af - jMax*tf) + 6*a0*(2*af_af - 2*af*jMax*tf + jMax*(jMax*tf_tf - 2*vd)) + 6*af*jMax*(3*jMax*tf_tf + 2*vd) - 6*jMax_jMax*(-4*pd + jMax*tf_p3 - 2*tf*v0 + 6*tf*vf))/(3*jMax*ph1);
        polynom[1] = -(-a0_p4 - af_p4 + 4*a0_p3*(af - jMax*tf) + a0_a0*(-6*af_af + 8*af*jMax*tf - 4*jMax*(jMax*tf_tf - vd)) + 2*af_af*jMax*(jMax*tf_tf + 2*vd) - 4*af*jMax_jMax*(-3*pd + jMax*tf_p3 + 2*tf*v0 + tf*vf) + jMax_jMax*(jMax_jMax*tf_p4 - 8*vd_vd + 4*jMax*tf*(-3*pd + tf*v0 + 2*tf*vf)) + 2*a0*(2*af_p3 - 2*af_af*jMax*tf + af*jMax*(-3*jMax*tf_tf - 4*vd) + jMax_jMax*(-6*pd + jMax*tf_p3 - 4*tf*v0 + 10*tf*vf)))/(jMax_jMax*ph1);
        polynom[2] = -(a0_p5 - af_p5 + af_p4*jMax*tf - 5*a0_p4*(af - jMax*tf) + 2*a0_p3*ph3 + 4*af_p3*jMax*(jMax*tf_tf + vd) + 12*jMax_jMax*af*ph6 - 2*a0_a0*(5*af_p3 - 9*af_af*jMax*tf - 6*af*jMax*vd + 6*jMax_jMax*(-2*pd - tf*v0 + 3*tf*vf)) - 12*jMax_jMax*jMax*ph2 + a0*ph5)/(3*jMax_jMax*jMax*ph1);
        polynom[3] = -(-a0_p6 - af_p6 + 6*a0_p5*(af - jMax*tf) - 48*af_p3*jMax_jMax*g1 + 72*jMax_jMax*jMax*(jMax*g1*g1 + vd_vd*vd + 2*af*g1*vd) - 3*a0_p4*ph3 - 36*af_af*jMax_jMax*vd_vd + 6*af_p4*jMax*vd + 4*a0_p3*(5*af_p3 - 9*af_af*jMax*tf - 6*af*jMax*vd + 6*jMax_jMax*(-2*pd - tf*v0 + 3*tf*vf)) - 3*a0_a0*ph5 + 6*a0*(af_p5 - af_p4*jMax*tf - 4*af_p3*jMax*(jMax*tf_tf + vd) + 12*jMax_jMax*(-af*ph6 + jMax*ph2)))/(18*jMax_jMax*jMax_jMax*ph1);

        const t_max = (a0 - aMin)/jMax;

        const roots = solveQuartMonicOf(polynom);
        for (let t of roots.values()) {
          if (t > t_max) {
            continue;
          }

          // Single Newton step (regarding pd)
          {
            const h1 = ad_ad/2 + jMax*(af*t + (jMax*t - a0)*(t - tf) - vd);
            const h2 = -ad + jMax*(tf - 2*t);
            const h3 = Math.sqrt(h1);
            const orig = (af_p3 - a0_p3 + 3*af*jMax*t*(af + jMax*t) + 3*a0_a0*(af + jMax*t) - 3*a0*(af_af + 2*af*jMax*t + jMax_jMax*(t*t - tf_tf)) + 3*jMax_jMax*(-2*pd + jMax*t*(t - tf)*tf + 2*tf*v0))/(6*jMax_jMax) - h3*h3*h3/(jMax*Math.abs(jMax)) + ((-ad - jMax*t)*h1)/(jMax_jMax);
            const deriv = (6*jMax*h2*h3/Math.abs(jMax) + 2*(-ad - jMax*tf)*h2 - 2*(3*ad_ad + af*jMax*(8*t - 2*tf) + 4*a0*jMax*(-2*t + tf) + 2*jMax*(jMax*t*(3*t - 2*tf) - vd)))/(4*jMax);

            t -= orig / deriv;
          }

          const h1 = Math.sqrt(2*ad_ad + 4*jMax*(ad*t + a0*tf + jMax*t*(t - tf) - vd))/Math.abs(jMax);

          // Solution 2 with aPlat
          profile.t[0] = 0;
          profile.t[1] = 0;
          profile.t[2] = t;
          profile.t[3] = tf - 2*t - ad/jMax - h1;
          profile.t[4] = h1/2;
          profile.t[5] = 0;
          profile.t[6] = tf - (t + profile.t[3] + profile.t[4]);

          if (profile.checkWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, tf, jMax, vMax, vMin, aMax, aMin)) {
            return true;
          }
        }
      }
    }

    // Profiles with a3 != 0, Solution UDUD
    {
      // T 0124
      {
        const ph0 = -2*pd - tf*v0 + 3*tf*vf;
        const ph1 = -ad + jMax*tf;
        const ph2 = jMax*tf_tf*g1 - vd*ph0;
        const ph3 = 5*af_af + 2*jMax*(2*jMax*tf_tf - vd - 4*af*tf);
        const ph4 = jMax_jMax*tf_p4 - 2*vd_vd + 8*jMax*tf*(-pd + tf*vf);
        const ph5 = (5*af_p4 - 8*af_p3*jMax*tf - 12*af_af*jMax*(jMax*tf_tf + vd) + 24*af*jMax_jMax*(-2*pd + jMax*tf_p3 + 2*tf*vf) - 6*jMax_jMax*ph4);
        const ph6 = -vd_vd + jMax*tf*(-2*pd + 3*tf*v0 - tf*vf);
        const ph7 = 3*jMax_jMax*ph1*ph1;

        const polynom = new Array<number>(4);
        polynom[0] = (4*af*tf - 2*jMax*tf_tf - 4*vd)/ph1;
        polynom[1] = (-2*(a0_p4 + af_p4) + 8*af_p3*jMax*tf + 6*af_af*jMax_jMax*tf_tf + 8*a0_p3*(af - jMax*tf) - 12*a0_a0*(af - jMax*tf)*(af - jMax*tf) - 12*af*jMax_jMax*(-pd + jMax*tf_p3 - 2*tf*v0 + 3*tf*vf) + 2*a0*(4*af_p3 - 12*af_af*jMax*tf + 9*af*jMax_jMax*tf_tf - 3*jMax_jMax*(2*pd + jMax*tf_p3 - 2*tf*vf)) + 3*jMax_jMax*(jMax_jMax*tf_p4 + 4*vd_vd - 4*jMax*tf*(pd + tf*v0 - 2*tf*vf)))/ph7;
        polynom[2] = (-a0_p5 + af_p5 - af_p4*jMax*tf + 5*a0_p4*(af - jMax*tf) - 2*a0_p3*ph3 - 4*af_p3*jMax*(jMax*tf_tf + vd) + 12*af_af*jMax_jMax*g2 - 12*af*jMax_jMax*ph6 + 2*a0_a0*(5*af_p3 - 9*af_af*jMax*tf - 6*af*jMax*vd + 6*jMax_jMax*ph0) + 12*jMax_jMax*jMax*ph2 + a0*(-5*af_p4 + 8*af_p3*jMax*tf + 12*af_af*jMax*(jMax*tf_tf + vd) - 24*af*jMax_jMax*(-2*pd + jMax*tf_p3 + 2*tf*vf) + 6*jMax_jMax*ph4))/(jMax*ph7);
        polynom[3] = -(a0_p6 + af_p6 - 6*a0_p5*(af - jMax*tf) + 48*af_p3*jMax_jMax*g1 - 72*jMax_jMax*jMax*(jMax*g1*g1 + vd_vd*vd + 2*af*g1*vd) + 3*a0_p4*ph3 - 6*af_p4*jMax*vd + 36*af_af*jMax_jMax*vd_vd - 4*a0_p3*(5*af_p3 - 9*af_af*jMax*tf - 6*af*jMax*vd + 6*jMax_jMax*ph0) + 3*a0_a0*ph5 - 6*a0*(af_p5 - af_p4*jMax*tf - 4*af_p3*jMax*(jMax*tf_tf + vd) + 12*jMax_jMax*(af_af*g2 - af*ph6 + jMax*ph2)))/(6*jMax_jMax*ph7);

        const roots = solveQuartMonicOf(polynom);
        for (let t of roots.values()) {
          if (t > tf || t > (aMax - a0)/jMax) {
            continue;
          }

          const h1 = Math.sqrt(ad_ad/(2*jMax_jMax) + (a0*(t + tf) - af*t + jMax*t*tf - vd)/jMax);

          profile.t[0] = t;
          profile.t[1] = tf - ad/jMax - 2*h1;
          profile.t[2] = h1;
          profile.t[3] = 0;
          profile.t[4] = ad/jMax + h1 - t;
          profile.t[5] = 0;
          profile.t[6] = 0;

          if (profile.checkWithTiming(ControlSigns.UDUD, ReachedLimits.NONE, tf, jMax, vMax, vMin, aMax, aMin)) {
            return true;
          }
        }
      }
    }

    // 3 step profile (ak. UZD), sometimes missed because of numerical errors T 012
    {
      const h1 = Math.sqrt(-ad_ad + jMax*(2*(a0 + af)*tf - 4*vd + jMax*tf_tf)) / Math.abs(jMax);

      profile.t[0] = (tf - h1 + ad/jMax)/2;
      profile.t[1] = h1;
      profile.t[2] = (tf - h1 - ad/jMax)/2;
      profile.t[3] = 0;
      profile.t[4] = 0;
      profile.t[5] = 0;
      profile.t[6] = 0;

      if (profile.checkWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, tf, jMax, vMax, vMin, aMax, aMin)) {
        return true;
      }
    }

    // 3 step profile (ak. UZU), sometimes missed because of numerical errors
    {
      const polynom = new Array<number>(4);
      polynom[0] = ad_ad;
      polynom[1] = ad_ad*tf;
      polynom[2] = (a0_a0 + af_af + 10*a0*af)*tf_tf + 24*(tf*(af*v0 - a0*vf) - pd*ad) + 12*vd_vd;
      polynom[3] = -3*tf*((a0_a0 + af_af + 2*a0*af)*tf_tf - 4*vd*(a0 + af)*tf + 4*vd_vd);

      const roots = solveCubic(polynom[0], polynom[1], polynom[2], polynom[3]);
      for (let t of roots.values()) {
        if (t > tf) {
          continue;
        }

        const jf = ad/(tf - t);

        profile.t[0] = (2*(vd - a0*tf) + ad*(t - tf))/(2*jf*t);
        profile.t[1] = t;
        profile.t[2] = 0;
        profile.t[3] = 0;
        profile.t[4] = 0;
        profile.t[5] = 0;
        profile.t[6] = tf - (profile.t[0] + profile.t[1]);

        if (profile.checkWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, tf, jf, vMax, vMin, aMax, aMin, jMax)) {
          return true;
        }
      }
    }

    // 3 step profile (ak. UDU), sometimes missed because of numerical errors
    {
      profile.t[0] = (ad_ad/jMax + 2*(a0 + af)*tf - jMax*tf_tf - 4*vd)/(4*(ad - jMax*tf));
      profile.t[1] = 0;
      profile.t[2] = -ad/(2*jMax) + tf/2;
      profile.t[3] = 0;
      profile.t[4] = 0;
      profile.t[5] = 0;
      profile.t[6] = tf - (profile.t[0] + profile.t[2]);

      if (profile.checkWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, tf, jMax, vMax, vMin, aMax, aMin)) {
        return true;
      }
    }

    return false;
  }

  private timeNoneSmooth(profile: Profile, vMax: number, vMin: number, aMax: number, aMin: number, jMax: number): boolean {
    const { v0, a0, tf, vf, af, pd, tf_tf, vd, vd_vd, ad, ad_ad, a0_a0, a0_p3, a0_p4, af_af, af_p3, af_p4, jMax_jMax } = this;

    {
      const h0 = ad_ad + 2*jMax*(a0*tf - vd);
      const h1a = 2*(a0_p3 - af_p3) - 6*a0_a0*(af - jMax*tf) + 6*jMax_jMax*(-pd + tf*v0) + 6*a0*af_af + 3*a0*jMax*(jMax*tf_tf - 2*vd) + 6*af*jMax*(vd - tf*a0);
      const h1 = Math.sqrt(4*h1a*h1a - 18*h0*h0*h0) * Math.abs(jMax) / jMax;

      profile.t[0] = 0;
      profile.t[1] = (-a0_p3 + af_p3 + 3*(af_af - a0_a0)*jMax*tf - 3*a0*af*ad - 6*jMax*ad*vd - 6*jMax_jMax*(-2*pd + tf*(v0 + vf)))/(3*jMax*h0);
      profile.t[2] = (4*(a0_p3 - af_p3) + 6*jMax_jMax*a0*tf_tf + 12*a0*af*ad + 12*jMax*(jMax*(tf*v0 - pd) + ad*(vd - a0*tf)) - h1)/(6*jMax*h0);
      profile.t[3] = h1/(3*jMax*h0);
      profile.t[4] = 0;
      profile.t[5] = 0;
      profile.t[6] = tf - (profile.t[1] + profile.t[2] + profile.t[3]);

      if (profile.checkWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, tf, jMax, vMax, vMin, aMax, aMin)) {
        return true;
      }
    }

    {
      const h0 = ad_ad + 2*jMax*(vd - af*tf);
      const h0b = af_p3 - 3*jMax_jMax*(af*tf_tf + 2*(pd - tf*vf));
      const h1a = a0_p3 + 3*a0*af*ad - h0b;
      const h1 = Math.sqrt(4*h1a*h1a - 6*h0*(a0_p4 + af_p4 - 4*a0_p3*af + 6*a0_a0*af_af + 12*jMax_jMax*(vd_vd - 2*af*(pd - tf*v0)) - 4*a0*h0b)) * Math.abs(jMax) / jMax;

      profile.t[0] = -(2*h1a + h1)/(6*jMax*h0);
      profile.t[1] = h1/(3*jMax*h0);
      profile.t[2] = profile.t[0] - (af - a0)/jMax;
      profile.t[3] = 0;
      profile.t[4] = 0;
      profile.t[5] = tf - (profile.t[0] + profile.t[1] + profile.t[2]);
      profile.t[6] = 0;

      if (profile.checkWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, tf, jMax, vMax, vMin, aMax, aMin)) {
        return true;
      }
    }

    // Solution 3
    {
      const h0 = Math.sqrt(3*(a0_p4 + af_p4 - 4*af_p3*jMax*tf + 6*af_af*jMax_jMax*tf_tf - 4*a0_p3*(af - jMax*tf) + 6*a0_a0*(af - jMax*tf)*(af - jMax*tf) + 24*af*jMax_jMax*(-pd + tf*v0) - 4*a0*(af_p3 - 3*af_af*jMax*tf + 6*jMax_jMax*(-pd + tf*vf)) - 12*jMax_jMax*(-vd_vd + jMax*tf*(-2*pd + tf*(v0 + vf))))) * Math.abs(jMax) / jMax;
      const h1 = Math.sqrt(3*(3*a0_a0 + 3*af_af - 6*a0*af - 6*ad*jMax*tf + 3*jMax_jMax*tf_tf - 2*h0)) * Math.abs(jMax) / jMax;

      profile.t[0] = (-3*(a0_a0 + af_af) + 6*a0*af + 6*jMax*(vd - a0*tf) + h0)/(6*jMax*(-ad + jMax*tf));
      profile.t[1] = 0;
      profile.t[2] = (3*jMax*tf - 3*ad - h1)/(6*jMax);
      profile.t[3] = h1/(3*jMax);
      profile.t[4] = 0;
      profile.t[5] = 0;
      profile.t[6] = tf - (profile.t[0] + profile.t[2] + profile.t[3]);

      if (profile.checkWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, tf, jMax, vMax, vMin, aMax, aMin)) {
        return true;
      }
    }

    // Solution 2
    {
      const h0 = 6*(ad_ad + 2*af*jMax*tf - 2*jMax*vd);
      const h1a = 2*(a0_p3 - af_p3 + 3*a0*af*ad + 6*jMax_jMax*(pd - tf*vf) + 3*jMax_jMax*af*tf_tf);
      const h1 = Math.sqrt(h1a*h1a - h0*(a0_p4 - 4*a0_p3*af + 6*a0_a0*af_af + af_p4 + 24*af*jMax_jMax*(-pd + tf*v0) + 12*jMax_jMax*vd_vd - 4*a0*(af_p3 - 3*af*jMax_jMax*tf_tf + 6*jMax_jMax*(-pd + tf*vf)))) * Math.abs(jMax) / jMax;
      const h2 = 4*a0_p3 - 4*af_p3 + 12*a0*af*ad - 12*jMax_jMax*(pd - tf*vf) - 6*jMax_jMax*af*tf_tf + 12*ad*jMax*(vd - af*tf);
      const h3 = jMax*h0;

      profile.t[0] = 0;
      profile.t[1] = 0;
      profile.t[2] = (h1a + h1)/h3;
      profile.t[3] = -(h2 + h1)/h3;
      profile.t[4] = (h2 - h1)/h3;
      profile.t[5] = tf - (profile.t[2] + profile.t[3] + profile.t[4]);
      profile.t[6] = 0;

      if (profile.checkWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, tf, jMax, vMax, vMin, aMax, aMin)) {
        return true;
      }
    }

    // Solution 1
    {
      const h0 = Math.sqrt((a0_p4 + af_p4 - 4*af_p3*jMax*tf + 6*af_af*jMax_jMax*tf_tf - 4*a0_p3*(af - jMax*tf) + 6*a0_a0*(af - jMax*tf)*(af - jMax*tf) + 24*af*jMax_jMax*(-pd + tf*v0) - 4*a0*(af_p3 - 3*af_af*jMax*tf + 6*jMax_jMax*(-pd + tf*vf)) - 12*jMax_jMax*(-vd_vd + jMax*tf*(-2*pd + tf*(v0 + vf)))) / 3) * Math.abs(jMax) / jMax;
      const h1 = Math.sqrt(ad_ad - 2*ad*jMax*tf + jMax_jMax*tf_tf + 2*h0) * Math.abs(jMax) / jMax;

      profile.t[0] = -(ad_ad + 2*jMax*(a0*tf - vd) + h0)/(2*jMax*(-ad + jMax*tf));
      profile.t[1] = 0;
      profile.t[2] = 0;
      profile.t[3] = 0;
      profile.t[4] = (-ad + jMax*tf - h1)/(2*jMax);
      profile.t[5] = h1/jMax;
      profile.t[6] = tf - (profile.t[0] + profile.t[4] + profile.t[5]);

      if (profile.checkWithTiming(ControlSigns.UDDU, ReachedLimits.NONE, tf, jMax, vMax, vMin, aMax, aMin)) {
        return true;
      }
    }

    return false;
  }

  getProfile(profile: Profile): boolean {
    const { v0, tf, _vMax, _vMin, _aMax, _aMin, _jMax, pd, minimize_jerk } = this;

    // Test all cases to get ones that match
    // However we should guess which one is correct and try them first...
    const up_first = (pd > tf * v0);
    const vMax = up_first ? _vMax : _vMin;
    const vMin = up_first ? _vMin : _vMax;
    const aMax = up_first ? _aMax : _aMin;
    const aMin = up_first ? _aMin : _aMax;
    const jMax = up_first ? _jMax : -_jMax;

    if (minimize_jerk && (
      this.timeNoneSmooth(profile, vMax, vMin, aMax, aMin, jMax)
      || this.timeNoneSmooth(profile, vMin, vMax, aMin, aMax, -jMax)
    )) {
      return true;
    }

    return this.timeAcc0Acc1Vel(profile, vMax, vMin, aMax, aMin, jMax)
      || this.timeVel(profile, vMax, vMin, aMax, aMin, jMax)
      || this.timeAcc0Vel(profile, vMax, vMin, aMax, aMin, jMax)
      || this.timeAcc1Vel(profile, vMax, vMin, aMax, aMin, jMax)
      || this.timeAcc0Acc1Vel(profile, vMin, vMax, aMin, aMax, -jMax)
      || this.timeVel(profile, vMin, vMax, aMin, aMax, -jMax)
      || this.timeAcc0Vel(profile, vMin, vMax, aMin, aMax, -jMax)
      || this.timeAcc1Vel(profile, vMin, vMax, aMin, aMax, -jMax)
      || this.timeAcc0Acc1(profile, vMax, vMin, aMax, aMin, jMax)
      || this.timeAcc0(profile, vMax, vMin, aMax, aMin, jMax)
      || this.timeAcc1(profile, vMax, vMin, aMax, aMin, jMax)
      || this.timeNone(profile, vMax, vMin, aMax, aMin, jMax)
      || this.timeAcc0Acc1(profile, vMin, vMax, aMin, aMax, -jMax)
      || this.timeAcc0(profile, vMin, vMax, aMin, aMax, -jMax)
      || this.timeAcc1(profile, vMin, vMax, aMin, aMax, -jMax)
      || this.timeNone(profile, vMin, vMax, aMin, aMax, -jMax);
  }
}
