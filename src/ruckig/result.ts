// Ports include/ruckig/result.hpp of Ruckig 0.15.3 (https://github.com/pantor/ruckig).
// Copyright (c) 2021 Lars Berscheid, MIT licence (see LICENSE in this folder).

/**
 * Result type of Ruckig's update function, with the C++'s numbers: a negative result is an error.
 *
 * The Python module names neither `ErrorTrajectoryDuration` nor `ErrorZeroLimits`. The second it never returns (it
 * raises `RuckigError` instead, and so does this port); for the first it raises `ValueError: -101 is not a valid
 * Result.`, where this port returns the number.
 */
export const Result = {
  /** The trajectory is calculated normally */
  Working: 0,
  /** The trajectory has reached its final position */
  Finished: 1,
  /** Unclassified error */
  Error: -1,
  /** Error in the input parameter */
  ErrorInvalidInput: -100,
  /** The trajectory duration exceeds its numerical limits */
  ErrorTrajectoryDuration: -101,
  /** The trajectory exceeds the given positional limits (only in Ruckig Pro) */
  ErrorPositionalLimits: -102,
  /** The trajectory is not valid due to a conflict with zero limits */
  ErrorZeroLimits: -104,
  /** Error during the extremel time calculation (Step 1) */
  ErrorExecutionTimeCalculation: -110,
  /** Error during the synchronization calculation (Step 2) */
  ErrorSynchronizationCalculation: -111,
} as const;
export type Result = (typeof Result)[keyof typeof Result];
