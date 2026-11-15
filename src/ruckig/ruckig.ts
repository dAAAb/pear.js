// Ports include/ruckig/ruckig.hpp and include/ruckig/calculator.hpp of Ruckig 0.15.3
// (https://github.com/pantor/ruckig), in the form the Python module is built from (the C++'s `RuckigThrow`): an
// input that is refused and a calculation that fails throw a `RuckigError`.
// Copyright (c) 2021 Lars Berscheid, MIT licence (see LICENSE in this folder).

import { TargetCalculator } from "./calculator_target";
import { RuckigError } from "./error";
import { ControlInterface, DurationDiscretization, InputParameter } from "./input_parameter";
import type { OutputParameter } from "./output_parameter";
import { Result } from "./result";
import type { Trajectory } from "./trajectory";
import { toStringDouble } from "./utils";

/** Main interface for the Ruckig algorithm */
export class Ruckig {
  /** Current input, only for comparison for recalculation */
  private readonly current_input: InputParameter;

  /** Flag that indicates if the current_input was properly initialized */
  private current_input_initialized: boolean = false;

  /** Calculator for new trajectories */
  readonly calculator: TargetCalculator;

  /** Max number of intermediate waypoints: none in the community edition. */
  readonly maxNumberOfWaypoints: number = 0;

  /** Degrees of freedom */
  readonly degreesOfFreedom: number;

  /** Time step between updates (cycle time) in [s]; -1 for a generator that only calculates. */
  deltaTime: number;

  constructor(dofs: number, deltaTime: number = -1.0) {
    this.current_input = new InputParameter(dofs);
    this.calculator = new TargetCalculator(dofs);
    this.degreesOfFreedom = dofs;
    this.deltaTime = deltaTime;
  }

  /** Reset the instance (e.g. to force a new calculation in the next update) */
  reset(): void {
    this.current_input_initialized = false;
  }

  /**
   * Validate the input as well as the Ruckig instance for trajectory calculation: returns true, or raises a
   * `RuckigError` that names the first thing wrong.
   */
  validateInput(input: InputParameter, checkCurrentStateWithinLimits: boolean = false, checkTargetStateWithinLimits: boolean = true): boolean {
    input.validate(checkCurrentStateWithinLimits, checkTargetStateWithinLimits);

    const intermediate_positions = input.intermediatePositions;
    if (intermediate_positions.length !== 0 && input.controlInterface === ControlInterface.Position) {
      if (intermediate_positions.length > this.maxNumberOfWaypoints) {
        throw new RuckigError(`The number of intermediate positions ${intermediate_positions.length} exceeds the maximum number of waypoints ${this.maxNumberOfWaypoints}.`);
      }
    }

    if (this.deltaTime <= 0.0 && input.durationDiscretization !== DurationDiscretization.Continuous) {
      throw new RuckigError(`delta time (control rate) parameter ${toStringDouble(this.deltaTime)} should be larger than zero.`);
    }

    return true;
  }

  /**
   * Calculate a new trajectory for the given input. Returns `Result.Working`, or
   * `Result.ErrorTrajectoryDuration` for several coordinates (or a minimum or discrete duration) and a duration
   * above 7,600 s; an input that is refused and a calculation that fails throw a `RuckigError`.
   */
  calculate(input: InputParameter, trajectory: Trajectory): Result {
    this.check(input, trajectory);

    return this.calculator.calculate(input, trajectory, this.deltaTime);
  }

  /** Raises unless `input` can be calculated into `trajectory`. */
  private check(input: InputParameter, trajectory: Trajectory): void {
    // The C++ reads an input or a trajectory of another size out of its bounds; this port refuses them.
    if (this.degreesOfFreedom !== input.degreesOfFreedom || this.degreesOfFreedom !== trajectory.degreesOfFreedom) {
      throw new RuckigError("mismatch in degrees of freedom (vector size).");
    }

    this.validateInput(input, false, true);
  }

  /**
   * Get the next output state (with step delta_time) along the calculated trajectory for the given input.
   *
   * A new trajectory is calculated when this is the first update, after a `reset`, or when `input` is not equal to
   * the input of the last calculation with its current state replaced by the state the last update returned. So a
   * loop that passes each output to the input continues the trajectory, and any other current state starts anew.
   */
  update(input: InputParameter, output: OutputParameter): Result {
    const start = performance.now();

    if (this.degreesOfFreedom !== input.degreesOfFreedom || this.degreesOfFreedom !== output.degreesOfFreedom) {
      throw new RuckigError("mismatch in degrees of freedom (vector size).");
    }

    output.newCalculation = false;

    let result: Result = Result.Working;
    if (!this.current_input_initialized || input.notEqual(this.current_input)) {
      this.check(input, output.trajectory);
      // the calculator's first statement: reached only with an input that passed the validation
      output.wasCalculationInterrupted = false;
      result = this.calculator.calculate(input, output.trajectory, this.deltaTime);
      if (result !== Result.Working && result !== Result.ErrorPositionalLimits) {
        return result;
      }

      this.current_input.assign(input);
      this.current_input_initialized = true;
      output.time = 0.0;
      output.newCalculation = true;
    }

    const old_section = output.newSection;
    output.time += this.deltaTime;
    output.newSection = output.trajectory._atTimeInto(output.time, output._newPosition, output._newVelocity, output._newAcceleration, output._newJerk);
    output.didSectionChange = (output.newSection > old_section); // Report only forward section changes

    const stop = performance.now();
    output.calculationDuration = (stop - start) * 1000.0;

    output.passToInput(this.current_input);

    if (output.time > output.trajectory.duration) {
      return Result.Finished;
    }

    return result;
  }
}
