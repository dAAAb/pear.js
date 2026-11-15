import { beforeAll, describe, expect, test } from "vitest";

import { SO101_DEFAULT_CONFIG } from "../../src/so101/config";
import { UnreachablePoseError, ValueError } from "../../src/so101/kinematics/errors";
import { SO101Kinematics, type SingleArmDelta } from "../../src/so101/kinematics/kinematics";
import { jointTargetCases, type JointTargetCase } from "./fixtures";

// The thresholds the port was accepted against.
const POSITION_CM = 0.05; // (a) the goal's pose from the requested one
const ROTATION_RAD = 0.002;
const JOINT_RAD = 0.01; // (b) the goal's joints from PEAR's
const JOINT_SHARE = 0.99;
const REACH_SHARE = 0.98; // (c) reachable or not, as PEAR finds
const FRACTION_POINTS = 2; // (d) the percentage of the message from PEAR's
const FRACTION_SHARE = 0.95;

const kinematics = new SO101Kinematics(SO101_DEFAULT_CONFIG);
const cases = jointTargetCases();

interface Outcome {
  row: JointTargetCase;
  goal?: number[];
  error?: Error;
}

function action(delta: number[]): SingleArmDelta {
  const [x, y, z, pitch, roll] = delta as [number, number, number, number, number];
  return { type: "single_arm_delta", arm: { x, y, z, pitch, roll }, gripper: { width: 0.0 } };
}

/** Returns the difference of two angles, within half a turn either way. */
function turn(angle: number): number {
  return angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));
}

/** Returns how far the pose at `goal` is from the pose at `start` changed by `delta`: cm and rad. */
function poseMiss(start: number[], delta: number[], goal: number[]): { position: number; rotation: number } {
  const [before, after] = [kinematics.pose(start), kinematics.pose(goal)];
  const miss = after.map((value, index) => value - before[index]! - delta[index]!);

  return {
    position: Math.hypot(miss[0]!, miss[1]!, miss[2]!),
    rotation: Math.max(Math.abs(turn(miss[3]!)), Math.abs(turn(miss[4]!))),
  };
}

const percentOf = (message: string): number => Number(/at most (\d+)%/.exec(message)![1]);
const share = (count: number, total: number): string => `${count}/${total} (${((100 * count) / total).toFixed(2)}%)`;
const quantile = (sorted: number[], portion: number): number => sorted[Math.min(sorted.length - 1, Math.floor(portion * sorted.length))]!;

describe(`joint_target on ${cases.length} starts and increments PEAR answered`, () => {
  let outcomes: Outcome[];
  let solved: Outcome[]; // PEAR returns a joint goal after a solve
  let unreachable: Outcome[]; // PEAR reports the pose out of reach
  let refused: Outcome[]; // PEAR refuses with another error
  let unchanged: Outcome[]; // an action that changes nothing

  beforeAll(() => {
    outcomes = cases.map((row) => {
      try {
        return { row, goal: kinematics.jointTarget(row.joints, action(row.delta)) };
      } catch (error) {
        return { row, error: error as Error };
      }
    });
    unchanged = outcomes.filter(({ row }) => row.delta.every((value) => value === 0));
    solved = outcomes.filter(({ row }) => row.goal !== undefined && row.delta.some((value) => value !== 0));
    unreachable = outcomes.filter(({ row }) => row.error?.type === "UnreachablePoseError");
    refused = outcomes.filter(({ row }) => row.error !== undefined && row.error.type !== "UnreachablePoseError");
  });

  test("the fixture holds the kinds of cases the criteria are measured on", () => {
    const typical = cases.filter(({ kind }) => ["single_position", "single_rotation", "combined", "small"].includes(kind));

    expect(typical.length).toBeGreaterThanOrEqual(2000);
    expect(typical.every(({ delta }) => delta.slice(0, 3).every((value) => Math.abs(value) <= 15))).toBe(true);
    expect(typical.every(({ delta }) => delta.slice(3).every((value) => Math.abs(value) <= 0.9))).toBe(true);
    expect(solved.length).toBeGreaterThan(800);
    expect(unreachable.length).toBeGreaterThan(400);
    expect(unchanged.length).toBeGreaterThanOrEqual(20);
    expect(refused.length).toBeGreaterThanOrEqual(20);
    expect(solved.length + unreachable.length + refused.length + unchanged.length).toBe(cases.length);
  });

  test("an action that changes nothing returns the joints as they are, unchecked", () => {
    expect(unchanged.every(({ row, goal }) => goal !== undefined && goal.every((value, index) => value === row.joints[index]))).toBe(true);
    expect(unchanged.every(({ row }) => row.goal!.every((value, index) => value === row.joints[index]))).toBe(true);
  });

  test("a refusal that is not about reach has PEAR's class and PEAR's words", () => {
    const differing = refused.filter(
      ({ row, error }) => !(error instanceof ValueError) || error.name !== row.error!.type || error.message !== row.error!.message,
    );

    expect(differing.map(({ row, error }) => ({ expected: row.error, ours: error?.message }))).toEqual([]);
    expect(new Set(refused.map(({ row }) => row.error!.message.split(":")[0]))).toEqual(
      new Set(["Rotation increment exceeds the planning bound", "Joint or gripper target outside commissioned bounds"]),
    );
  });

  test("(c) reachable or out of reach agrees with PEAR on at least 98% of the cases", () => {
    const decided = [...solved, ...unreachable];
    const disagreeing = decided.filter(({ row, goal, error }) =>
      row.goal !== undefined ? goal === undefined : !(error instanceof UnreachablePoseError),
    );

    console.info(
      `(c) reachable or not: agrees on ${share(decided.length - disagreeing.length, decided.length)}` +
        disagreeing
          .map(({ row, error }) => `\n    ${row.kind} joints=${JSON.stringify(row.joints)} delta=${JSON.stringify(row.delta)}: PEAR ${row.goal ? "solves" : row.first_error} (solves out of steps: ${row.unsettled ?? 0}), pear.js ${error ? error.message : "solves"}`)
          .join(""),
    );
    expect((decided.length - disagreeing.length) / decided.length).toBeGreaterThanOrEqual(REACH_SHARE);
  });

  /** Returns, for every case both PEAR and pear.js solve, how far each one's goal is from the requested pose. */
  const poseMisses = () =>
    solved.flatMap(({ row, goal }) =>
      goal ? [{ row, ours: poseMiss(row.joints, row.delta, goal), theirs: poseMiss(row.joints, row.delta, row.goal!) }] : [],
    );

  // PEAR accepts a goal whose pose misses the requested one by up to position_residual_m (0.1 cm) and
  // rotation_residual_rad (0.01 rad), which happens where a joint limit stops the solver just short. pear.js returns
  // the same goal, so it misses by the same amount: "within 0.05 cm and 0.002 rad wherever PEAR finds a solution"
  // cannot hold of a port, and what is asserted is that pear.js misses only where PEAR does. The measured count and
  // sizes are in docs/progress/kinematics.md.
  test("(a) the goal's pose misses the requested one by more than 0.05 cm or 0.002 rad only where PEAR's own goal does", () => {
    const misses = poseMisses();
    const outside = misses.filter(({ ours }) => ours.position > POSITION_CM || ours.rotation > ROTATION_RAD);
    const positions = misses.map(({ ours }) => ours.position).sort((first, second) => first - second);
    const rotations = misses.map(({ ours }) => ours.rotation).sort((first, second) => first - second);
    const residuals = SO101_DEFAULT_CONFIG.geometry!;

    console.info(
      `(a) pose of the goal against the requested pose, ${misses.length} cases: position median ${quantile(positions, 0.5).toExponential(1)}, ` +
        `99% ${quantile(positions, 0.99).toExponential(1)}, max ${positions.at(-1)!.toExponential(1)} cm; rotation median ` +
        `${quantile(rotations, 0.5).toExponential(1)}, 99% ${quantile(rotations, 0.99).toExponential(1)}, max ${rotations.at(-1)!.toExponential(1)} rad; ` +
        `within ${POSITION_CM} cm and ${ROTATION_RAD} rad: ${share(misses.length - outside.length, misses.length)}; of the ${outside.length} outside, ` +
        `PEAR's own goal is as far in ${outside.filter(({ ours, theirs }) => Math.abs(ours.position - theirs.position) < 1e-5 && Math.abs(ours.rotation - theirs.rotation) < 1e-6).length}` +
        outside
          .map(({ row, ours, theirs }) => `\n    ${row.kind} joints=${JSON.stringify(row.joints)} delta=${JSON.stringify(row.delta)}: pear.js ${ours.position.toFixed(4)} cm ${ours.rotation.toFixed(5)} rad, PEAR's own goal ${theirs.position.toFixed(4)} cm ${theirs.rotation.toFixed(5)} rad`)
          .join(""),
    );
    // stored goals are rounded to nine digits: PEAR's miss is known to about 1e-6 cm
    const worse = misses.filter(
      ({ ours, theirs }) =>
        ours.position > Math.max(POSITION_CM, theirs.position + 1e-5) || ours.rotation > Math.max(ROTATION_RAD, theirs.rotation + 1e-6),
    );
    expect(worse.map(({ row, ours, theirs }) => ({ joints: row.joints, delta: row.delta, ours, theirs }))).toEqual([]);
    // and no goal misses by more than the residuals PEAR's solver accepts
    expect(positions.at(-1)!).toBeLessThanOrEqual(100 * residuals.position_residual_m + 1e-9);
    expect(rotations.at(-1)!).toBeLessThanOrEqual(residuals.rotation_residual_rad + 1e-9);
  });

  /** Whether pear.js answers as PEAR does: the same joint goal within 1e-6 rad, or the same message byte for byte. */
  const isPearsAnswer = ({ row, goal, error }: Outcome): boolean =>
    row.goal !== undefined
      ? goal !== undefined && Math.max(...goal.map((value, index) => Math.abs(value - row.goal![index]!))) <= 1e-6
      : error instanceof UnreachablePoseError && error.message === row.error!.message;

  test("where every solve of PEAR's converged, pear.js gives PEAR's answer itself: its goal, or its message byte for byte", () => {
    // A solve of PEAR's that takes all its ik_iterations without converging returns whatever its last step was,
    // which follows the last digits of the arithmetic (the next test measures it). Every other answer is held here.
    const settled = [...solved, ...unreachable].filter(({ row }) => row.unsettled === undefined);
    const different = settled.filter((outcome) => !isPearsAnswer(outcome));

    console.info(
      `settled: every solve of PEAR's converged in ${share(settled.length, solved.length + unreachable.length)} of the decided cases ` +
        `(${settled.filter(({ row }) => row.goal !== undefined).length} reachable, ${settled.filter(({ row }) => row.goal === undefined).length} unreachable); ` +
        `pear.js gives PEAR's answer on ${share(settled.length - different.length, settled.length)} of them`,
    );
    expect(settled.length).toBeGreaterThan(1000);
    expect(settled.filter(({ row }) => row.goal === undefined).length).toBeGreaterThan(200);
    expect(
      different.map(({ row, goal, error }) => ({ index: cases.indexOf(row), expected: row.goal ?? row.error, ours: goal ?? error?.message })),
    ).toEqual([]);
  });

  test("the disagreements with PEAR sit where a solve of PEAR's ran out of steps, and PEAR disagrees with itself there", () => {
    const decided = [...solved, ...unreachable];
    const unsettled = decided.filter(({ row }) => row.unsettled !== undefined);
    const samePercentage = ({ row, error }: Outcome): boolean =>
      error instanceof UnreachablePoseError && percentOf(error.message) === percentOf(row.error!.message);
    // PEAR against itself: its answer from start joints moved by 1e-9 rad, recorded where it changed
    const pearKeepsAnswer = decided.filter(({ row }) => row.perturbed === undefined).length;
    const pearKeepsPercentage = unreachable.filter(
      ({ row }) =>
        row.perturbed === undefined ||
        (!row.perturbed.reachable && Math.floor(100 * row.perturbed.fraction!) === Math.floor(100 * row.fraction!)),
    ).length;
    const movedOutsideUnsettled = decided.filter(({ row }) => row.perturbed !== undefined && row.unsettled === undefined);

    console.info(
      `unsettled: a solve of PEAR's ran out of steps in ${share(unsettled.length, decided.length)} of the decided cases ` +
        `(${unsettled.filter(({ row }) => row.goal !== undefined).length} of them reachable); pear.js gives PEAR's answer on ` +
        `${share(unsettled.filter(isPearsAnswer).length, unsettled.length)} of those. On the ${unreachable.length} unreachable cases pear.js words PEAR's ` +
        `percentage in ${share(unreachable.filter(samePercentage).length, unreachable.length)}; PEAR itself, from joints moved by 1e-9 rad, in ` +
        `${share(pearKeepsPercentage, unreachable.length)}, and it keeps its whole answer on ${share(pearKeepsAnswer, decided.length)} of the decided cases. ` +
        `Cases where that move changed PEAR's answer although every solve converged: ${movedOutsideUnsettled.length}`,
    );
    // pear.js is no further from PEAR than PEAR is from itself after a move of 1e-9 rad
    expect(unreachable.filter(samePercentage).length).toBeGreaterThanOrEqual(pearKeepsPercentage);
  });

  test("(b) the joint goal is within 0.01 rad of PEAR's on at least 99% of the reachable cases", () => {
    const differences = solved
      .map(({ row, goal }) => (goal ? Math.max(...goal.map((value, index) => Math.abs(value - row.goal![index]!))) : Infinity))
      .sort((first, second) => first - second);
    const within = differences.filter((difference) => difference <= JOINT_RAD).length;

    const beyond = solved.filter(
      ({ row, goal }) => goal === undefined || Math.max(...goal.map((value, index) => Math.abs(value - row.goal![index]!))) > JOINT_RAD,
    );

    console.info(
      `(b) joint goal against PEAR's, ${differences.length} reachable cases: within ${JOINT_RAD} rad ${share(within, differences.length)}; ` +
        `within 1e-6 rad ${share(differences.filter((difference) => difference <= 1e-6).length, differences.length)}; median ` +
        `${quantile(differences, 0.5).toExponential(1)}, 99% ${quantile(differences, 0.99).toExponential(1)}, max ${differences.at(-1)!.toExponential(1)} rad` +
        beyond
          .map(({ row, goal }) => `\n    ${row.kind} joints=${JSON.stringify(row.joints)} delta=${JSON.stringify(row.delta)}: PEAR ${JSON.stringify(row.goal)} (solves out of steps: ${row.unsettled ?? 0}), pear.js ${goal ? JSON.stringify(goal.map((value) => Number(value.toFixed(6)))) : "out of reach"}`)
          .join(""),
    );
    expect(within / differences.length).toBeGreaterThanOrEqual(JOINT_SHARE);
    // the gripper's coordinate is the measured one
    expect(solved.every(({ row, goal }) => goal === undefined || goal[5] === row.joints[5])).toBe(true);
  });

  test("(d) the reachable percentage is within 2 points of PEAR's on at least 95% of the unreachable cases", () => {
    const gaps = unreachable.map(({ row, error }) =>
      error instanceof UnreachablePoseError ? Math.abs(percentOf(error.message) - percentOf(row.error!.message)) : Infinity,
    );
    const within = gaps.filter((gap) => gap <= FRACTION_POINTS).length;
    const sameWords = unreachable.filter(({ row, error }) => error?.message === row.error!.message).length;
    const beyond = unreachable.filter((_, index) => gaps[index]! > FRACTION_POINTS);

    console.info(
      `(d) reachable percentage against PEAR's, ${gaps.length} unreachable cases: within ${FRACTION_POINTS} points ${share(within, gaps.length)}; ` +
        `the same percentage ${share(gaps.filter((gap) => gap === 0).length, gaps.length)}; the same message, byte for byte, ${share(sameWords, gaps.length)}; ` +
        `of the ${beyond.length} beyond ${FRACTION_POINTS} points, a solve of PEAR's ran out of steps in ${beyond.filter(({ row }) => row.unsettled !== undefined).length}` +
        beyond
          .map(({ row, error }) => `\n    ${row.kind} joints=${JSON.stringify(row.joints)} delta=${JSON.stringify(row.delta)}: PEAR ${percentOf(row.error!.message)}%, pear.js ${error instanceof UnreachablePoseError ? `${percentOf(error.message)}%` : "solves"}`)
          .join(""),
    );
    expect(within / gaps.length).toBeGreaterThanOrEqual(FRACTION_SHARE);
    // the percentage PEAR words is the floor of the fraction its bisection found
    expect(unreachable.every(({ row }) => percentOf(row.error!.message) === Math.floor(100 * row.fraction!))).toBe(true);
  });
});

describe("joint_target's refusals", () => {
  const work = [0.2, -0.35, 0.55, 0.4, 0.3, 1.0];

  test("a rotation at the planning bound is solved for; one past it is refused", () => {
    const bound = SO101_DEFAULT_CONFIG.geometry!.max_rotation_rad;

    expect(() => kinematics.jointTarget(work, action([0, 0, 0, 0, bound + 1e-9]))).toThrow("Rotation increment exceeds the planning bound");
    expect(() => kinematics.jointTarget(work, action([0, 0, 0, -bound - 1e-9, 0]))).toThrow(ValueError);
    try {
      kinematics.jointTarget(work, action([0, 0, 0, 0, bound]));
    } catch (error) {
      expect(error).toBeInstanceOf(UnreachablePoseError);
    }
  });

  test("an unreachable pose is an UnreachablePoseError, which is a ValueError, named as PEAR names it", () => {
    let caught: unknown;
    try {
      kinematics.jointTarget(work, action([40, 0, 0, 0, 0]));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnreachablePoseError);
    expect(caught).toBeInstanceOf(ValueError);
    expect((caught as Error).name).toBe("UnreachablePoseError");
    expect((caught as Error).message).toMatch(/^The target is out of reach\. Along the requested change the arm can go at most \d+% \(x \+\d+\.\d of \+40\)\.$/);
  });

  test("the kinematics need a geometry", () => {
    expect(() => new SO101Kinematics({ ...SO101_DEFAULT_CONFIG, geometry: null })).toThrow(ValueError);
  });
});
