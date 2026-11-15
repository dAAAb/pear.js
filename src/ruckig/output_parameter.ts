// Ports include/ruckig/output_parameter.hpp of Ruckig 0.15.3 (https://github.com/pantor/ruckig), as its Python
// module shows it.
// Copyright (c) 2021 Lars Berscheid, MIT licence (see LICENSE in this folder).

import type { InputParameter } from "./input_parameter";
import { Trajectory } from "./trajectory";
import { join, streamDouble } from "./utils";

/**
 * Output of the Ruckig algorithm
 *
 * As in the Python module, reading a vector gives a copy: a state kept from one update is not changed by the next.
 */
export class OutputParameter {
  readonly degreesOfFreedom: number;

  /** Current trajectory */
  readonly trajectory: Trajectory;

  /**
   * Current kinematic state: the generator writes into these.
   * @internal
   */
  readonly _newPosition: number[];
  /** @internal */
  readonly _newVelocity: number[];
  /** @internal */
  readonly _newAcceleration: number[];
  /** @internal */
  readonly _newJerk: number[];

  /** Current time on trajectory */
  time: number = 0.0;

  /** Index of the current section between two (possibly filtered) intermediate positions (only relevant in Ruckig Pro) */
  newSection: number = 0;

  /** Was a new section reached in the last cycle? (only relevant in Ruckig Pro) */
  didSectionChange: boolean = false;

  /** Was a new trajectory calculation performed in the last cycle? */
  newCalculation: boolean = false;

  /** Was the trajectory calculation interrupted? (only in Ruckig Pro) */
  wasCalculationInterrupted: boolean = false;

  /** Computational duration of the last update call [µs] */
  calculationDuration: number = 0.0;

  constructor(dofs: number) {
    this.degreesOfFreedom = dofs;
    this.trajectory = new Trajectory(dofs);
    const zeros = (): number[] => new Array<number>(dofs).fill(0.0);
    this._newPosition = zeros();
    this._newVelocity = zeros();
    this._newAcceleration = zeros();
    this._newJerk = zeros();
  }

  get newPosition(): number[] {
    return this._newPosition.slice();
  }

  get newVelocity(): number[] {
    return this._newVelocity.slice();
  }

  get newAcceleration(): number[] {
    return this._newAcceleration.slice();
  }

  /** The jerk of every coordinate, which the C++ has and the Python module does not show. */
  get newJerk(): number[] {
    return this._newJerk.slice();
  }

  /** Makes the new state the current state of `input`. */
  passToInput(input: InputParameter): void {
    input.currentPosition = this._newPosition;
    input.currentVelocity = this._newVelocity;
    input.currentAcceleration = this._newAcceleration;

    // Remove first intermediate waypoint if section did change
    if (this.didSectionChange && input.intermediatePositions.length !== 0) {
      input.eraseFirstIntermediatePosition();
    }
  }

  /** The output as the Python module's `repr` writes it. */
  toString(): string {
    let ss = `\nout.new_position = [${join(this._newPosition, true)}]\n`;
    ss += `out.new_velocity = [${join(this._newVelocity, true)}]\n`;
    ss += `out.new_acceleration = [${join(this._newAcceleration, true)}]\n`;
    ss += `out.new_jerk = [${join(this._newJerk, true)}]\n`;
    ss += `out.time = [${streamDouble(this.time, 16)}]\n`;
    ss += `out.calculation_duration = [${streamDouble(this.calculationDuration, 16)}]\n`;
    return ss;
  }
}
