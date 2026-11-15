// Runs fixture cases through the port and measures how far its numbers are from the reference's.
//
// Two tests use this. exact.test.ts runs the port with the reference's own C library values and demands every
// number to be the same double. calculate.test.ts runs it with the engine's own functions, where a cube root may
// differ in its last digit; there a case falls into one of three groups, which this file keeps apart:
//
//   the same outcome and the same kind of profile on every coordinate: its numbers are tallied and bounded;
//   another kind of profile on some coordinate: a last digit made another candidate pass Ruckig's check. Both
//     profiles are valid; their numbers are not compared;
//   another outcome: a calculation that fails in one and succeeds in the other, for the same reason.

import {
  ControlInterface,
  DurationDiscretization,
  InputParameter,
  Ruckig,
  RuckigError,
  Synchronization,
  Trajectory,
  type Profile,
} from "../../src/ruckig/index";
import { unnamedResult, type BrakeRow, type CalculationCase, type Options } from "./fixtures";

const INTERFACES = { Position: ControlInterface.Position, Velocity: ControlInterface.Velocity };
const SYNCHRONIZATIONS = {
  Time: Synchronization.Time,
  TimeIfNecessary: Synchronization.TimeIfNecessary,
  Phase: Synchronization.Phase,
  No: Synchronization.No,
};

/** Returns the port's input of a case: its nine vectors and its other inputs. */
export function buildInput(dofs: number, vectors: number[][], options: Options = {}): InputParameter {
  const input = new InputParameter(dofs);
  [
    input.currentPosition,
    input.currentVelocity,
    input.currentAcceleration,
    input.targetPosition,
    input.targetVelocity,
    input.targetAcceleration,
    input.maxVelocity,
    input.maxAcceleration,
    input.maxJerk,
  ] = vectors as [number[], number[], number[], number[], number[], number[], number[], number[], number[]];
  if (options.vmin !== undefined) {
    input.minVelocity = options.vmin;
  }
  if (options.amin !== undefined) {
    input.minAcceleration = options.amin;
  }
  if (options.ci !== undefined) {
    input.controlInterface = INTERFACES[options.ci];
  }
  if (options.sync !== undefined) {
    input.synchronization = SYNCHRONIZATIONS[options.sync];
  }
  if (options.disc) {
    input.durationDiscretization = DurationDiscretization.Discrete;
  }
  if (options.mind !== undefined) {
    input.minimumDuration = options.mind;
  }
  if (options.enabled !== undefined) {
    input.enabled = options.enabled;
  }
  if (options.pci !== undefined) {
    input.perDofControlInterface = options.pci.map((name) => INTERFACES[name]);
  }
  if (options.psync !== undefined) {
    input.perDofSynchronization = options.psync.map((name) => SYNCHRONIZATIONS[name]);
  }
  if (options.ip !== undefined) {
    input.intermediatePositions = options.ip;
  }

  return input;
}

/** Returns the port's generator of a case: with a control period only where the case names one. */
export function buildGenerator(dofs: number, options: Options = {}): Ruckig {
  return options.dt !== undefined ? new Ruckig(dofs, options.dt) : new Ruckig(dofs);
}

/** Whether two numbers are the same double; a NaN equals a NaN, and +0 is not -0. */
export function identical(expected: number, actual: number): boolean {
  return Object.is(expected, actual);
}

/** The largest deviations of one kind of number over a set. */
export class Tally {
  /** Numbers compared, and those of them that are not the same double as the reference's. */
  count = 0;
  different = 0;
  /** The largest absolute deviation, and the largest relative to the size of the quantity. */
  maxAbsolute = 0;
  maxRelative = 0;
  worst = "";

  /**
   * Compares one number with the reference's. `scale` is the size of the quantity in its trajectory (the largest
   * position, the velocity cap, the duration): a deviation is taken relative to the number itself or to that size,
   * whichever is larger, so that a velocity that should be zero and is 1e-17 is not 100% wrong.
   */
  add(expected: number, actual: number, scale: number, where: string): void {
    this.count++;
    if (identical(expected, actual)) {
      return;
    }
    this.different++;
    let absolute = Math.abs(expected - actual);
    if (Number.isNaN(absolute)) {
      // one of them is not a number, or they are infinities
      absolute = Infinity;
    }
    const size = Math.max(Math.abs(expected), Math.abs(actual), scale);
    const relative = absolute === 0 ? 0 : absolute / size;
    this.maxAbsolute = Math.max(this.maxAbsolute, absolute);
    if (relative > this.maxRelative) {
      this.maxRelative = relative;
      this.worst = `${where}: ${expected} expected, ${actual}`;
    }
  }

  addAll(expected: readonly number[], actual: readonly number[], scale: number, where: string): void {
    if (expected.length !== actual.length) {
      this.count++;
      this.different++;
      this.maxAbsolute = this.maxRelative = Infinity;
      this.worst = `${where}: ${expected.length} numbers expected, ${actual.length}`;
      return;
    }
    expected.forEach((value, index) => this.add(value, actual[index], scale, `${where}[${index}]`));
  }

  merge(other: Tally): void {
    this.count += other.count;
    this.different += other.different;
    this.maxAbsolute = Math.max(this.maxAbsolute, other.maxAbsolute);
    if (other.maxRelative > this.maxRelative) {
      this.maxRelative = other.maxRelative;
      this.worst = other.worst;
    }
  }

  toString(): string {
    return `${this.different} of ${this.count} differ, abs ${this.maxAbsolute.toExponential(1)}, rel ${this.maxRelative.toExponential(1)}`;
  }
}

export const TALLIES = [
  "duration",
  "independentMinDurations",
  "times",
  "jerks",
  "states",
  "brake",
  "extrema",
  "extremaTimes",
  "samples",
  "firstTimes",
] as const;
export type TallyName = (typeof TALLIES)[number];

const newTallies = (): Record<TallyName, Tally> =>
  Object.fromEntries(TALLIES.map((name) => [name, new Tally()])) as Record<TallyName, Tally>;

/** What comparing a set with the reference found. */
export class Report {
  cases = 0;
  /** Cases in which the outcome, every kind of profile and every number are the reference's, to the last bit. */
  identicalCases = 0;
  /** Cases with the reference's outcome and kinds of profile, whose numbers are tallied below. */
  comparedCases = 0;
  /** Cases with another outcome than the reference's, by kind of case and the two outcomes. */
  readonly outcomeDifferences = new Map<string, number>();
  outcomeDifferenceCount = 0;
  /** Cases with another kind of profile on some coordinate, by kind of case and the two profiles. */
  readonly profileDifferences = new Map<string, number>();
  profileDifferenceCount = 0;
  /** Where the first differences of each of the two kinds are. */
  readonly examples: string[] = [];
  /** Phases whose jerk is not the reference's, in the compared cases. */
  jerkDifferences = 0;
  /**
   * Times that are elsewhere in the trajectory than the reference's: of an extremum where two extrema are level
   * (a last digit decides which is named), and of the first passing of a position that is passed, or only
   * touched, more than once. They are not tallied.
   */
  levelExtrema = 0;
  otherCrossings = 0;
  readonly tallies = newTallies();

  get different(): number {
    return TALLIES.reduce((sum, name) => sum + this.tallies[name].different, 0);
  }

  /** The tallies whose largest relative deviation is above its bound in `tolerances`. */
  exceeding(tolerances: Record<TallyName, number>): string[] {
    return TALLIES.filter((name) => !(this.tallies[name].maxRelative <= tolerances[name])).map(
      (name) => `${name}: ${this.tallies[name].maxRelative.toExponential(2)} > ${tolerances[name]} (${this.tallies[name].worst})`,
    );
  }

  summary(name: string): string {
    const lines = [
      `${name}: ${this.cases} cases; ${this.identicalCases} identical to the last bit, ${this.comparedCases} with the reference's outcome and profiles, ` +
        `${this.profileDifferenceCount} with another profile, ${this.outcomeDifferenceCount} with another outcome`,
    ];
    for (const key of TALLIES) {
      const tally = this.tallies[key];
      if (tally.count > 0) {
        lines.push(`  ${key}: ${tally.toString()}${tally.maxRelative > 1e-10 ? ` (${tally.worst})` : ""}`);
      }
    }
    if (this.jerkDifferences > 0) {
      lines.push(`  jerk of a phase differs: ${this.jerkDifferences}`);
    }
    if (this.levelExtrema > 0 || this.otherCrossings > 0) {
      lines.push(`  times elsewhere in the trajectory: ${this.levelExtrema} of level extrema, ${this.otherCrossings} of a position passed more than once`);
    }
    for (const [key, count] of this.profileDifferences) {
      lines.push(`  another profile (${count}): ${key}`);
    }
    for (const [key, count] of this.outcomeDifferences) {
      lines.push(`  another outcome (${count}): ${key}`);
    }
    for (const example of this.examples.slice(0, 8)) {
      lines.push(`  e.g. ${example}`);
    }
    return lines.join("\n");
  }
}

/** The share of a trajectory's duration beyond which a time is taken to be elsewhere in the trajectory. */
const ELSEWHERE = 1e-3;

const largest = (values: readonly number[]): number =>
  values.reduce((most, value) => (Number.isFinite(value) ? Math.max(most, Math.abs(value)) : most), 0);

function compareBrake(tally: Tally, expected: BrakeRow | undefined, actual: Profile["brake"], scales: number[], duration: number, where: string): void {
  const row: BrakeRow = expected ?? [0, [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]];
  tally.add(row[0], actual.duration, duration, `${where}.duration`);
  tally.addAll(row[1], actual.t, duration, `${where}.t`);
  for (let phase = 0; phase < 2; phase++) {
    tally.add(row[2][phase] * row[1][phase], actual.j[phase] * actual.t[phase], scales[2], `${where}.j*t[${phase}]`);
  }
  tally.addAll(row[3], actual.a, scales[2], `${where}.a`);
  tally.addAll(row[4], actual.v, scales[1], `${where}.v`);
  tally.addAll(row[5], actual.p, scales[0], `${where}.p`);
}

/**
 * The sizes of each coordinate's position, velocity and acceleration in the reference's trajectory: the largest
 * value of its profile, and not less than its cap (velocity, acceleration) or the distance the velocity scale
 * covers in the trajectory's duration (position).
 */
function caseScales(item: CalculationCase): number[][] {
  const duration = Number.isFinite(item.d) ? Math.abs(item.d) : 0;
  return item.p.map((row, dof) => {
    const cap = (vector: number[]): number => (Number.isFinite(vector[dof]) ? Math.abs(vector[dof]) : 0);
    const velocity = Math.max(largest([...row[3], row[5][1]]), cap(item.i[6]));
    const acceleration = Math.max(largest([...row[2], row[5][2]]), cap(item.i[7]));
    const position = Math.max(largest([...row[4], row[5][0]]), velocity * duration);
    return [position, velocity, acceleration];
  });
}

/** What a calculation came to, in a few words: its result, or the beginning of the error it raised. */
function outcome(result: number | undefined, message: string | undefined): string {
  if (message === undefined) {
    return `the result ${result}`;
  }
  const words = /^\n\[ruckig\] ([A-Za-z ]+)/.exec(message);
  return `"${(words === null ? message : words[1]).trim()}"`;
}

/** Calculates one case with the port, compares everything the fixture holds, and returns the trajectory. */
export function compareCalculation(report: Report, item: CalculationCase, label: string): Trajectory {
  report.cases++;

  const trajectory = new Trajectory(item.n);
  let result: number | undefined;
  let message: string | undefined;
  try {
    result = buildGenerator(item.n, item.o).calculate(buildInput(item.n, item.i, item.o), trajectory);
  } catch (error) {
    if (!(error instanceof RuckigError)) {
      throw error;
    }
    message = error.message;
  }

  // the outcome: the same result, or the same error word for word. The Python module has no name for the result
  // -101 and raises a ValueError that says so; the port returns the number.
  const expectedResult = item.e === undefined ? item.r : unnamedResult(item);
  const isSameOutcome = expectedResult !== undefined ? message === undefined && result === expectedResult : message === item.e;
  if (!isSameOutcome) {
    const key = `${item.k}: ${outcome(expectedResult, expectedResult === undefined ? item.e : undefined)} in the reference, ${outcome(result, message)} here`;
    report.outcomeDifferences.set(key, (report.outcomeDifferences.get(key) ?? 0) + 1);
    report.outcomeDifferenceCount++;
    report.examples.push(`${label}: expected ${JSON.stringify(item.e ?? item.r)}, got ${JSON.stringify(message ?? result)}`.slice(0, 600));
    return trajectory;
  }

  // the kinds of profile
  const profiles = trajectory.profiles[0];
  const otherKinds = item.p.flatMap((row, dof) => (profiles[dof].toString() === row[6] ? [] : [`${row[6]} in the reference, ${profiles[dof].toString()} here`]));
  if (otherKinds.length > 0) {
    for (const kinds of new Set(otherKinds)) {
      const key = `${item.k}: ${kinds}`;
      report.profileDifferences.set(key, (report.profileDifferences.get(key) ?? 0) + 1);
    }
    report.profileDifferenceCount++;
    report.examples.push(`${label}: ${otherKinds[0]}; duration ${item.d} in the reference, ${trajectory.duration} here`);
    return trajectory;
  }

  // the numbers; a refused calculation leaves the trajectory as far as it came, which is compared too
  report.comparedCases++;
  const tallies = newTallies();
  const durationScale = Number.isFinite(item.d) ? Math.abs(item.d) : 0;
  const scales = caseScales(item);
  tallies.duration.add(item.d, trajectory.duration, 0, `${label} duration`);
  tallies.independentMinDurations.addAll(item.m, trajectory.independentMinDurations, durationScale, `${label} independent_min_durations`);
  if (item.id !== undefined || item.e === undefined) {
    tallies.duration.addAll(item.id ?? [item.d], trajectory.intermediateDurations, 0, `${label} intermediate_durations`);
  }

  item.p.forEach((row, dof) => {
    const profile = profiles[dof];
    const where = `${label} profile ${dof}`;
    tallies.times.addAll(row[0], profile.t, durationScale, `${where}.t`);
    for (let phase = 0; phase < 7; phase++) {
      // A phase has its jerk only if it lasts at all, and whether a phase of 1e-17 s lasts hangs on the last digit
      // of a root. What is compared is what the jerk does: the change of acceleration over the phase.
      tallies.jerks.add(row[1][phase] * row[0][phase], profile.j[phase] * profile.t[phase], scales[dof][2], `${where}.j*t[${phase}]`);
      if (!identical(row[1][phase], profile.j[phase])) {
        report.jerkDifferences++;
      }
    }
    tallies.states.addAll(row[2], profile.a, scales[dof][2], `${where}.a`);
    tallies.states.addAll(row[3], profile.v, scales[dof][1], `${where}.v`);
    tallies.states.addAll(row[4], profile.p, scales[dof][0], `${where}.p`);
    tallies.states.add(row[5][0], profile.pf, scales[dof][0], `${where}.pf`);
    tallies.states.add(row[5][1], profile.vf, scales[dof][1], `${where}.vf`);
    tallies.states.add(row[5][2], profile.af, scales[dof][2], `${where}.af`);
    compareBrake(tallies.brake, row[7], profile.brake, scales[dof], durationScale, `${where}.brake`);
    compareBrake(tallies.brake, row[8], profile.accel, scales[dof], durationScale, `${where}.accel`);
  });

  if (item.x !== undefined) {
    const extrema = trajectory.positionExtrema;
    item.x.forEach((row, dof) => {
      const where = `${label} position_extrema ${dof}`;
      tallies.extrema.add(row[0], extrema[dof].min, scales[dof][0], `${where}.min`);
      tallies.extrema.add(row[1], extrema[dof].max, scales[dof][0], `${where}.max`);
      for (const [expected, actual, side] of [[row[2], extrema[dof].tMin, "t_min"], [row[3], extrema[dof].tMax, "t_max"]] as const) {
        if (Math.abs(expected - actual) > ELSEWHERE * durationScale) {
          report.levelExtrema++;
        } else {
          tallies.extremaTimes.add(expected, actual, durationScale, `${where}.${side}`);
        }
      }
    });
  }

  for (const [time, position, velocity, acceleration] of item.s ?? []) {
    const [newPosition, newVelocity, newAcceleration] = trajectory.atTime(time);
    for (let dof = 0; dof < item.n; dof++) {
      const where = `${label} at_time(${time}) ${dof}`;
      tallies.samples.add(position[dof], newPosition[dof], scales[dof][0], `${where} position`);
      tallies.samples.add(velocity[dof], newVelocity[dof], scales[dof][1], `${where} velocity`);
      tallies.samples.add(acceleration[dof], newAcceleration[dof], scales[dof][2], `${where} acceleration`);
    }
  }

  for (const [dof, position, timeAfter, expected] of item.f ?? []) {
    const actual = trajectory.getFirstTimeAtPosition(dof, position, timeAfter);
    const where = `${label} get_first_time_at_position(${dof}, ${position}, ${timeAfter})`;
    if (expected === null && actual === undefined) {
      tallies.firstTimes.add(0, 0, 0, where);
    } else if (expected === null || actual === undefined || Math.abs(expected - actual) > ELSEWHERE * durationScale) {
      report.otherCrossings++;
    } else {
      tallies.firstTimes.add(expected, actual, durationScale, where);
    }
  }

  if (TALLIES.every((name) => tallies[name].different === 0)) {
    report.identicalCases++;
  }
  TALLIES.forEach((name) => report.tallies[name].merge(tallies[name]));

  return trajectory;
}
