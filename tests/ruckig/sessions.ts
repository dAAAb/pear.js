// Repeats a recorded session of the Python module on the port, operation by operation (see the class Session of
// tools/fixtures/ruckig_fixtures.py for what each operation is).
//
// Whatever a session feeds back into its input is the port's own output, as a caller's would be: so the rule by
// which an update decides to calculate anew is exercised on the port's numbers, not on the reference's.
//
// With the engine's own cube roots and cosines a session can part from the reference's: a number that differs in
// its last digit makes a later calculation choose another valid profile, fail where the reference's did not, or
// (a gripper past its endpoint) be made at all. Such a session is counted as diverged at the step where it parts,
// with the reason, and is not followed further. With the reference's C library values no session may diverge.

import {
  ControlInterface,
  DurationDiscretization,
  InputParameter,
  OutputParameter,
  Result,
  Ruckig,
  RuckigError,
  Synchronization,
  Trajectory,
} from "../../src/ruckig/index";
import { unnamedResult, type Session, type UpdateRow } from "./fixtures";
import { Tally } from "./harness";

const VECTOR_PROPERTIES = {
  current_position: "currentPosition",
  current_velocity: "currentVelocity",
  current_acceleration: "currentAcceleration",
  target_position: "targetPosition",
  target_velocity: "targetVelocity",
  target_acceleration: "targetAcceleration",
  max_velocity: "maxVelocity",
  max_acceleration: "maxAcceleration",
  max_jerk: "maxJerk",
} as const;

function setInput(input: InputParameter, name: string, value: unknown): void {
  if (name in VECTOR_PROPERTIES) {
    input[VECTOR_PROPERTIES[name as keyof typeof VECTOR_PROPERTIES]] = value as number[];
  } else if (name === "control_interface") {
    input.controlInterface = ControlInterface[value as keyof typeof ControlInterface];
  } else if (name === "synchronization") {
    input.synchronization = Synchronization[value as keyof typeof Synchronization];
  } else if (name === "duration_discretization") {
    input.durationDiscretization = DurationDiscretization[value as keyof typeof DurationDiscretization];
  } else if (name === "minimum_duration") {
    input.minimumDuration = value as number;
  } else {
    throw new Error(`a session sets ${name}, which this test does not know`);
  }
}

export const SESSION_TALLIES = ["time", "position", "velocity", "acceleration", "duration", "extrema"] as const;
export type SessionTallyName = (typeof SESSION_TALLIES)[number];

const newTallies = (): Record<SessionTallyName, Tally> =>
  Object.fromEntries(SESSION_TALLIES.map((name) => [name, new Tally()])) as Record<SessionTallyName, Tally>;

/** What repeating sessions found. */
export class SessionReport {
  sessions = 0;
  updates = 0;
  calculations = 0;
  finished = 0;
  refused = 0;
  /** Sessions followed to their end in which every number is the same double as the reference's. */
  identicalSessions = 0;
  /**
   * Calculations with a new trajectory (PEAR's compute_trajectory), and those of them for which the reference's
   * own trajectory is another one when its input's current state is moved by one unit in the last place.
   */
  trajectories = 0;
  unstableTrajectories = 0;
  /** Sessions that parted from the reference's, by the reason. */
  readonly divergences = new Map<string, number>();
  divergedSessions = 0;
  readonly examples: string[] = [];
  readonly tallies = newTallies();

  get different(): number {
    return SESSION_TALLIES.reduce((sum, name) => sum + this.tallies[name].different, 0);
  }

  get maxRelative(): number {
    return Math.max(...SESSION_TALLIES.map((name) => this.tallies[name].maxRelative));
  }

  summary(name: string): string {
    const lines = [
      `${name}: ${this.sessions} sessions; ${this.identicalSessions} identical to the last bit, ${this.divergedSessions} diverged; ` +
        `${this.updates} updates, ${this.calculations} of them calculated anew, ${this.finished} returned Finished, ${this.refused} raised`,
    ];
    for (const key of SESSION_TALLIES) {
      const tally = this.tallies[key];
      if (tally.count > 0) {
        lines.push(`  ${key}: ${tally.toString()}${tally.maxRelative > 1e-10 ? ` (${tally.worst})` : ""}`);
      }
    }
    if (this.trajectories > 0) {
      lines.push(`  ${this.unstableTrajectories} of ${this.trajectories} calculated trajectories are others in the reference itself when its state moves by one unit in the last place`);
    }
    for (const [key, count] of this.divergences) {
      lines.push(`  diverged (${count}): ${key}`);
    }
    for (const example of this.examples.slice(0, 8)) {
      lines.push(`  e.g. ${example.replace(/\n/g, "\\n").slice(0, 420)}`);
    }
    return lines.join("\n");
  }
}

/**
 * The largest position, velocity and acceleration over the rows of a session, for each coordinate; and for a
 * coordinate that hardly moves, not less than a thousandth of the largest among the coordinates.
 */
function sessionScales(session: Session): number[][] {
  const scales = [0, 1, 2].map(() => new Array<number>(session.n).fill(0));
  const widen = (states: number[][]): void => {
    states.forEach((state, quantity) => {
      state.forEach((value, dof) => {
        scales[quantity][dof] = Math.max(scales[quantity][dof], Math.abs(value));
      });
    });
  };
  for (const operation of session.ops) {
    if (operation[0] === "play") {
      operation[1].forEach((row) => widen([row[1], row[2], row[3]]));
    } else if (operation[0] === "update" || operation[0] === "advance" || operation[0] === "gripper") {
      for (const row of operation[0] === "gripper" ? operation[2] : operation[1]) {
        if (Array.isArray(row)) {
          widen([row[3], row[4], row[5]]);
        }
      }
    }
  }
  return scales.map((quantity) => {
    const floor = Math.max(...quantity) * 1e-3;
    return quantity.map((value) => Math.max(value, floor));
  });
}

/** Signals that a session parted from the reference's. */
class Divergence extends Error {}

/**
 * Repeats one session. `sameTrajectory` is the relative deviation above which a step's numbers are taken for
 * another trajectory, so that the session has diverged, rather than for the same one with other last digits.
 */
export function replay(report: SessionReport, session: Session, label: string, sameTrajectory: number): void {
  report.sessions++;
  const tallies = newTallies();
  const scales = sessionScales(session);

  const dofs = session.n;
  const generator = session.dt !== undefined ? new Ruckig(dofs, session.dt) : new Ruckig(dofs);
  const input = new InputParameter(dofs);
  const output = new OutputParameter(dofs);
  let lastResult: number | undefined;
  let move: Trajectory | undefined;
  let elapsed = 0.0;
  let step = 0;

  const diverge = (reason: string, detail: string): never => {
    report.divergences.set(reason, (report.divergences.get(reason) ?? 0) + 1);
    report.divergedSessions++;
    report.examples.push(`${label} step ${step}: ${detail}`);
    throw new Divergence();
  };

  /** Adds the numbers of one step to the session's tallies, unless they are those of another trajectory. */
  const tallyStep = (compare: (stepTallies: Record<SessionTallyName, Tally>) => void): void => {
    const stepTallies = newTallies();
    compare(stepTallies);
    const worst = SESSION_TALLIES.map((name) => stepTallies[name]).reduce((most, tally) => (tally.maxRelative > most.maxRelative ? tally : most));
    if (worst.maxRelative > sameTrajectory) {
      diverge("another trajectory", worst.worst);
    }
    SESSION_TALLIES.forEach((name) => tallies[name].merge(stepTallies[name]));
  };

  const compareStates = (
    stepTallies: Record<SessionTallyName, Tally>,
    expected: [number[], number[], number[]],
    actual: [number[], number[], number[]],
    where: string,
  ): void => {
    for (let dof = 0; dof < dofs; dof++) {
      stepTallies.position.add(expected[0][dof], actual[0][dof], scales[0][dof], `${where} position ${dof}`);
      stepTallies.velocity.add(expected[1][dof], actual[1][dof], scales[1][dof], `${where} velocity ${dof}`);
      stepTallies.acceleration.add(expected[2][dof], actual[2][dof], scales[2][dof], `${where} acceleration ${dof}`);
    }
  };

  const outcome = (result: number | undefined, message: string | undefined): string =>
    message === undefined ? `the result ${result}` : JSON.stringify((/^\n\[ruckig\] ([A-Za-z ]+)/.exec(message)?.[1] ?? message).trim());

  const update = (row: UpdateRow): void => {
    step++;
    report.updates++;
    const where = `${label} update ${step}`;
    let result: number | undefined;
    let message: string | undefined;
    try {
      result = generator.update(input, output);
    } catch (error) {
      if (!(error instanceof RuckigError)) {
        throw error;
      }
      message = error.message;
    }
    lastResult = result;

    if (!Array.isArray(row)) {
      // the reference raised: a RuckigError, or for the result it has no name for a ValueError
      report.refused++;
      const unnamed = unnamedResult(row);
      if (unnamed !== undefined ? result !== unnamed : message !== row.e) {
        diverge(`${outcome(unnamed, unnamed === undefined ? row.e : undefined)} in the reference, ${outcome(result, message)} here`, `expected ${JSON.stringify(row.e)}, got ${JSON.stringify(message ?? result)}`);
      }
      return;
    }
    const [expectedResult, time, newCalculation, position, velocity, acceleration] = row;
    if (result !== expectedResult) {
      diverge(`the result ${expectedResult} in the reference, ${outcome(result, message)} here`, `expected the result ${expectedResult}, got ${JSON.stringify(message ?? result)}`);
    }
    if (output.newCalculation !== (newCalculation === 1)) {
      diverge(`new_calculation ${newCalculation === 1} in the reference, ${output.newCalculation} here`, `expected new_calculation ${newCalculation === 1}`);
    }
    report.calculations += newCalculation;
    report.finished += result === Result.Finished ? 1 : 0;
    tallyStep((stepTallies) => {
      stepTallies.time.add(time, output.time, Math.abs(time), `${where} time`);
      compareStates(stepTallies, [position, velocity, acceleration], [output.newPosition, output.newVelocity, output.newAcceleration], where);
    });
  };

  // PEAR's JointTrajectory.accept of the sample an advance returned
  const accept = (): void => {
    input.currentPosition = output.newPosition;
    input.currentVelocity = output.newVelocity;
    input.currentAcceleration = output.newAcceleration;
  };

  try {
    for (const operation of session.ops) {
      switch (operation[0]) {
        case "set":
          setInput(input, operation[1], operation[2]);
          break;
        case "update":
          operation[1].forEach(update);
          break;
        case "advance":
          for (const row of operation[1]) {
            update(row);
            accept();
          }
          break;
        case "gripper":
          for (const row of operation[2]) {
            update(row);
            // PEAR's GripperProfile.accept of the opening it commands: the endpoint once the profile has finished
            const position = lastResult === Result.Finished ? operation[1] : output.newPosition[0];
            output.passToInput(input);
            input.currentPosition = [position];
          }
          break;
        case "pass":
          output.passToInput(input);
          break;
        case "reset":
          generator.reset();
          break;
        case "time":
          output.time = operation[1];
          break;
        case "calculate":
        case "move": {
          // "calculate": PEAR's compute_trajectory, with the session's generator and input and a new trajectory.
          // "move": PEAR's JointMove, from the input's current position to a goal, at rest at both ends, phase
          // synchronized, with a generator of its own.
          const expected = operation[0] === "calculate" ? operation[1] : operation[3];
          if (operation[0] === "calculate" && operation[1].d !== undefined) {
            report.trajectories++;
            report.unstableTrajectories += operation[1].u !== undefined ? 1 : 0;
          }
          const where = `${label} ${operation[0]} after step ${step}`;
          const trajectory = new Trajectory(dofs);
          let result: number | undefined;
          let message: string | undefined;
          try {
            if (operation[0] === "calculate") {
              result = generator.calculate(input, trajectory);
            } else {
              const moveInput = new InputParameter(dofs);
              moveInput.currentPosition = input.currentPosition;
              moveInput.targetPosition = operation[1];
              [moveInput.maxVelocity, moveInput.maxAcceleration, moveInput.maxJerk] = operation[2] as [number[], number[], number[]];
              moveInput.synchronization = Synchronization.Phase;
              move = trajectory;
              elapsed = 0.0;
              result = new Ruckig(dofs).calculate(moveInput, trajectory);
            }
          } catch (error) {
            if (!(error instanceof RuckigError)) {
              throw error;
            }
            message = error.message;
          }
          const expectedResult = expected.e === undefined ? expected.r : unnamedResult(expected);
          if (expectedResult !== undefined ? result !== expectedResult : message !== expected.e) {
            diverge(
              `${operation[0]}: ${outcome(expectedResult, expectedResult === undefined ? expected.e : undefined)} in the reference, ${outcome(result, message)} here`,
              `expected ${JSON.stringify(expected.e ?? expected.r)}, got ${JSON.stringify(message ?? result)}`,
            );
          }
          if (expected.d !== undefined) {
            const duration = expected.d;
            const bounds: number[][] = operation[0] === "calculate" ? operation[1].x ?? [] : [];
            tallyStep((stepTallies) => {
              stepTallies.duration.add(duration, trajectory.duration, 0, `${where} duration`);
              const extrema = trajectory.positionExtrema;
              bounds.forEach((bound, dof) => {
                stepTallies.extrema.add(bound[0], extrema[dof].min, scales[0][dof], `${where} min ${dof}`);
                stepTallies.extrema.add(bound[1], extrema[dof].max, scales[0][dof], `${where} max ${dof}`);
              });
            });
          }
          break;
        }
        case "play":
          for (const [time, position, velocity, acceleration, isFinished] of operation[1]) {
            step++;
            if (move === undefined || session.dt === undefined) {
              throw new Error(`${label}: a move is played before it is built`);
            }
            const where = `${label} play ${step}`;
            // PEAR's JointMoveOperation.advance, then JointTrajectory.accept of its sample
            elapsed = Math.min(elapsed + session.dt, move.duration);
            const state = move.atTime(elapsed);
            [input.currentPosition, input.currentVelocity, input.currentAcceleration] = state;
            if ((elapsed >= move.duration) !== (isFinished === 1)) {
              diverge("a move finished at another step", `expected the move ${isFinished === 1 ? "finished" : "under way"}`);
            }
            tallyStep((stepTallies) => {
              stepTallies.time.add(time, elapsed, Math.abs(time), `${where} time`);
              compareStates(stepTallies, [position, velocity, acceleration], state, where);
            });
          }
          break;
      }
    }
  } catch (error) {
    if (!(error instanceof Divergence)) {
      throw error;
    }
    return;
  }

  if (SESSION_TALLIES.every((name) => tallies[name].different === 0)) {
    report.identicalSessions++;
  }
  SESSION_TALLIES.forEach((name) => report.tallies[name].merge(tallies[name]));
}
