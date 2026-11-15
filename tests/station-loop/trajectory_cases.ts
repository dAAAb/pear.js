// Runs the cases of trajectory.json on pear.js's JointMove, JointTrajectory, GripperProfile and operations, as
// tools/fixtures/loop_fixtures.py (TrajectoryCases) ran them on PEAR's, and compares what they give.

import { SO101GripperOperation } from "../../src/so101/joint/grippers";
import type { SO101RobotConfig } from "../../src/so101/config";
import { ARM, GRIPPER_INDEX } from "../../src/so101/layout";
import { ControlInterface } from "../../src/ruckig/index";
import { ArmState } from "../../src/station/joint/arm_state";
import { RuntimeError } from "../../src/station/joint/errors";
import type { MotionCaps } from "../../src/station/joint/limits";
import { pythonMin } from "../../src/station/joint/numeric";
import { GripperEndpointTimeout, SequenceOperation } from "../../src/station/joint/operations";
import { GripperProfile, JointMove, JointTrajectory, type CommandSample } from "../../src/station/joint/trajectory";
import { plain, type Comparison } from "./compare";
import { outcomeOf, stationOf, type Outcome } from "./fixtures";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Case = Record<string, any>;

export interface TrajectoryFixture {
  move_cases: Case[];
  trajectory_sessions: Case[];
  gripper_sessions: Case[];
  sequence_cases: Case[];
  gripper_operation_cases: Case[];
}

const INPUT_NAMES: [string, string][] = [
  ["current_position", "currentPosition"],
  ["current_velocity", "currentVelocity"],
  ["current_acceleration", "currentAcceleration"],
  ["target_position", "targetPosition"],
  ["target_velocity", "targetVelocity"],
  ["target_acceleration", "targetAcceleration"],
  ["max_velocity", "maxVelocity"],
  ["max_acceleration", "maxAcceleration"],
  ["max_jerk", "maxJerk"],
];

/** Returns what a JointTrajectory holds of its Ruckig input, and the duration it computed last. */
function inputRecord(trajectory: JointTrajectory): Record<string, unknown> {
  const trajectoryInput = trajectory.input as unknown as Record<string, unknown>;
  const record: Record<string, unknown> = {};
  for (const [name, property] of INPUT_NAMES) {
    record[name] = trajectoryInput[property];
  }
  record["control_interface"] = Object.entries(ControlInterface).find(
    ([, value]) => value === trajectory.input.controlInterface,
  )?.[0];
  record["duration"] = trajectory.durationS;

  return record;
}

/** A CommandSample as a row: position, velocity, acceleration, whether it is finished, and the target it commits. */
function sampleRow(sample: CommandSample): unknown[] {
  return [sample.position, sample.velocity, sample.acceleration, sample.isFinished, sample.requestedTarget];
}

/**
 * What `JointMove.build` gives for a case: what build itself gave (a refusal is its own, not the move's afterwards),
 * and the refusal or the move's caps, duration and states.
 */
function moveOutcome(item: Case): { built: Outcome; out: Outcome } {
  const { controlConfig, robotConfig, layout } = stationOf(item.station as string);
  const limits = robotConfig.jointLimits();
  const options: { speedScale?: number; caps?: MotionCaps } = {};
  if ("speed_scale" in item) {
    options.speedScale = item.speed_scale as number;
  }
  if ("caps" in item) {
    options.caps = item.caps as MotionCaps;
  }
  const built = outcomeOf(() => {
    JointMove.build(item.start as number[], item.goal as number[], limits, layout, options);
    return null;
  });

  const out = outcomeOf(() => {
    const move = JointMove.build(item.start as number[], item.goal as number[], limits, layout, options);
    const duration = move.durationS;
    // the control periods a JointMoveOperation plays the move in
    let periods = 0;
    for (let elapsed = 0.0; elapsed < duration && periods < 20000; periods++) {
      elapsed = pythonMin(elapsed + controlConfig.controlPeriodS, duration);
    }
    const expected = "ok" in item.out ? (item.out.ok as Case) : { samples: [], refused_times: [] };

    return {
      start: move.start,
      goal: move.goal,
      motion_caps: move.motionCaps,
      duration,
      periods,
      samples: (expected.samples as [number][]).map(([seconds]) => [seconds, ...move.atTime(seconds)]),
      refused_times: (expected.refused_times as [number][]).map(([seconds]) => [
        seconds,
        outcomeOf(() => move.atTime(seconds)),
      ]),
    };
  });

  return { built, out };
}

/** Runs a script on a JointTrajectory of a station: each operation with what it gave, and the input after it. */
function trajectorySession(session: Case): unknown[] {
  const { controlConfig, robotConfig, layout } = stationOf(session.station as string);
  const trajectory = new JointTrajectory(robotConfig.jointLimits(), layout, controlConfig);
  const operations: unknown[] = [];

  for (const scripted of session.ops as Case[]) {
    const name = scripted.op as string;
    const scriptArguments = scripted.args as unknown[];
    const operation: Case = { op: name, args: scriptArguments };
    if (name === "hold") {
      operation.out = outcomeOf(() => trajectory.hold(scriptArguments[0] as number[]));
    } else if (name === "head_for") {
      operation.out = outcomeOf(() =>
        trajectory.headFor(scriptArguments[0] as number[], scriptArguments[1] as number[][] | null),
      );
    } else if (name === "set_target") {
      operation.out = outcomeOf(() => trajectory.setTarget(scriptArguments[0] as number[]));
    } else if (name === "stop") {
      operation.out = outcomeOf(() =>
        trajectory.stop({
          fromStandstill: scriptArguments[0] as boolean,
          brakingCaps: scriptArguments[1] as [number[], number[]] | null,
        }),
      );
    } else if (name === "compute") {
      operation.out = outcomeOf(() => trajectory.computeTrajectory());
    } else if (name === "set_input") {
      const property = INPUT_NAMES.find(([python]) => python === scriptArguments[0])![1];
      (trajectory.input as unknown as Record<string, unknown>)[property] = scriptArguments[1];
    } else if (name === "advance") {
      // a row a control period: the sample, which is then accepted
      const rows: unknown[] = [];
      for (let index = 0; index < (scriptArguments[0] as number); index++) {
        const advanced = outcomeOf(() => trajectory.advance());
        if ("error" in advanced) {
          rows.push(advanced);
          break;
        }
        const sample = advanced.ok as CommandSample;
        trajectory.accept(sample);
        rows.push(sampleRow(sample).slice(0, 4));
      }
      operation.rows = rows;
    } else if (name === "finish") {
      // advances until a sample is finished, and some periods more
      const rows: unknown[] = [];
      let remaining: number | null = null;
      for (let index = 0; index < 2000; index++) {
        const sample = trajectory.advance();
        trajectory.accept(sample);
        rows.push(sampleRow(sample).slice(0, 4));
        if (remaining === null && sample.isFinished) {
          remaining = scriptArguments[0] as number;
        }
        if (remaining !== null) {
          if (remaining === 0) {
            break;
          }
          remaining -= 1;
        }
      }
      operation.rows = rows;
    } else {
      throw new Error(`No operation ${name}`);
    }
    operation.input = inputRecord(trajectory);
    operations.push(operation);
  }

  return operations;
}

/** Runs one gripper's profile as the fixture did: as many control periods as PEAR's record holds. */
function gripperSession(session: Case): { duration: Outcome; out: Outcome } {
  const caps = session.caps as number[];
  const limits = { velocity: [caps[0]!], acceleration: [caps[1]!], jerk: [caps[2]!] };
  const start = session.start as number;
  const opens = session.opens as boolean;
  const periods = "ok" in session.out ? (session.out.ok.rows as unknown[]).length : 1;

  return {
    duration: outcomeOf(() => GripperProfile.durationS(start, opens, limits)),
    out: outcomeOf(() => {
      const profile =
        "start_velocity" in session
          ? new GripperProfile(start, opens, limits, session.period_s as number, session.start_velocity as number)
          : new GripperProfile(start, opens, limits, session.period_s as number);
      const rows: unknown[] = [];
      for (let index = 0; index < periods; index++) {
        const [position, velocity, acceleration, isFinished] = profile.advance();
        // the endpoint is commanded once the profile is finished, as a gripper operation does
        profile.accept(isFinished ? profile.endpoint : position);
        rows.push([position, velocity, acceleration, isFinished]);
      }
      return { endpoint: profile.endpoint, rows };
    }),
  };
}

/** Makes a SequenceOperation on a trajectory at rest in the middle of the bounds, and advances it at each `now`. */
function sequenceCase(item: Case): { out: Outcome; steps?: unknown[] } {
  const station = stationOf(item.station as string);
  const trajectory = new JointTrajectory(station.robotConfig.jointLimits(), station.layout, station.controlConfig);
  trajectory.hold(station.record.rest);
  const made = outcomeOf(() => new SequenceOperation(trajectory, item.positions as number[][], item.rate_hz as number));
  if ("error" in made) {
    return { out: made };
  }

  const operation = made.ok as SequenceOperation;
  const out = {
    ok: {
      rows: operation.positions.length,
      rate_hz: operation.rateHz,
      writeable: !Object.isFrozen(operation.positions) || operation.positions.some((row) => !Object.isFrozen(row)),
    },
  };
  const steps: unknown[] = [];
  for (const now of item.nows as number[]) {
    const advanced = outcomeOf(() => operation.advance(now, {}, {}));
    const state = [operation.index, operation.rowPhase, operation.startTime, operation.isComplete];
    if ("error" in advanced) {
      steps.push({ out: advanced, state, target: trajectory.input.targetPosition });
      break;
    }
    const sample = advanced.ok as CommandSample;
    trajectory.accept(sample);
    steps.push({ row: sampleRow(sample).slice(0, 4), state, target: trajectory.input.targetPosition });
  }

  return { out, steps };
}

/** Runs the SO-101's gripper operation by hand with the readings a case scripts. */
function gripperOperationCase(item: Case): { made: unknown; steps: unknown[] } {
  const { controlConfig, robotConfig } = stationOf(item.station as string);
  const home = item.home as number[];
  let targets: Record<string, number[]> = { [ARM]: home };
  const reading = (step: Case): ArmState =>
    new ArmState(
      [...home.slice(0, GRIPPER_INDEX), step.opening as number],
      new Array<number>(home.length).fill(0.0),
      step.stamp as number,
      (step.sample_id as number | undefined) ?? null,
    );

  const first = reading({ opening: item.start_opening, stamp: 100.0, sample_id: 0 });
  const operation = new SO101GripperOperation(
    controlConfig,
    robotConfig as SO101RobotConfig,
    targets,
    { [ARM]: first },
    item.opens as boolean,
  );
  const made = {
    initial_opening: operation.initialOpening,
    endpoint: operation.profile.endpoint,
    opens: operation.opensByArm,
  };

  const steps = (item.steps as Case[]).map((step) => {
    const entry: Case = {};
    for (const [key, value] of Object.entries(step)) {
      if (!["out", "row", "progress"].includes(key)) {
        entry[key] = value;
      }
    }
    const state = reading(step);
    if ("fault" in step) {
      // the targets to hold after a fault of this kind
      const error = step.fault === "GripperEndpointTimeout" ? new GripperEndpointTimeout("late") : new RuntimeError("other");
      entry.out = outcomeOf(() => operation.faultTargets(error, step.now as number, { [ARM]: state }, targets));
    } else if ("report" in step) {
      entry.out = outcomeOf(() => operation.report());
    } else {
      const advanced = outcomeOf(() => operation.advance(step.now as number, { [ARM]: state }, targets));
      if ("error" in advanced) {
        entry.out = advanced;
      } else {
        const sample = advanced.ok as CommandSample;
        entry.row = sampleRow(sample);
        targets = { [ARM]: sample.position.map(Number) };
      }
    }
    entry.progress = {
      outcome: operation.outcome,
      samples: operation.sampleCount,
      finished_at: operation.finishedAt,
      report: operation.openingReport,
      blocked: operation.blockedGripperOpenings,
      window: operation.restWindow.samples.length,
    };

    return entry;
  });

  return { made, steps };
}

export interface TrajectoryResult {
  cases: number;
  differences: string[];
  summary: string;
}

/** One case of the fixture: its group, its name, and the comparison of what pear.js gives with what PEAR gave. */
export interface TrajectoryCheck {
  group: string;
  name: string;
  /** Returns null when pear.js gives what PEAR gave, else where they first differ and how. */
  difference(comparison: Comparison): string | null;
}

/** Returns every case of the fixture as a check, in the fixture's order. */
export function trajectoryChecks(fixture: TrajectoryFixture): TrajectoryCheck[] {
  const checks: TrajectoryCheck[] = [];

  const each = (group: string, items: Case[], actualOf: (item: Case) => unknown, expectedOf: (item: Case) => unknown): void => {
    items.forEach((item, index) => {
      const name = `${group} ${index} (${item.k as string})`;
      checks.push({
        group,
        name,
        difference(comparison: Comparison): string | null {
          try {
            return comparison.difference(plain(actualOf(item)), expectedOf(item), name);
          } catch (error) {
            return `${name}: the case stopped: ${(error as Error).name}: ${(error as Error).message}`;
          }
        },
      });
    });
  };

  each(
    "move_cases",
    fixture.move_cases,
    (item) => {
      if ("station" in item) {
        return moveOutcome(item);
      }
      // a move made without build
      const move = new JointMove(item.start as number[], item.goal as number[], item.motion_caps as number[][]);
      return { out: outcomeOf(() => move.durationS), again: outcomeOf(() => move.durationS) };
    },
    (item) => ("station" in item ? { built: item.built, out: item.out } : { out: item.out, again: item.again }),
  );
  each("trajectory_sessions", fixture.trajectory_sessions, trajectorySession, (item) => item.ops);
  each("gripper_sessions", fixture.gripper_sessions, gripperSession, (item) => ({ duration: item.duration, out: item.out }));
  each("sequence_cases", fixture.sequence_cases, sequenceCase, (item) =>
    "steps" in item ? { out: item.out, steps: item.steps } : { out: item.out },
  );
  each("gripper_operation_cases", fixture.gripper_operation_cases, gripperOperationCase, (item) => ({
    made: item.made,
    steps: item.steps,
  }));

  return checks;
}

/** Runs every case of the fixture on pear.js and compares what it gives with what PEAR gave. */
export function compareTrajectoryFixture(fixture: TrajectoryFixture, comparison: Comparison): TrajectoryResult {
  const differences: string[] = [];
  const groups = new Map<string, { cases: number; differing: number }>();
  const checks = trajectoryChecks(fixture);

  for (const check of checks) {
    const group = groups.get(check.group) ?? { cases: 0, differing: 0 };
    groups.set(check.group, group);
    group.cases += 1;
    const difference = check.difference(comparison);
    if (difference !== null) {
      group.differing += 1;
      differences.push(difference);
    }
  }
  const counts = [...groups].map(([name, group]) => `${group.cases} ${name} (${group.differing} differ)`);

  return { cases: checks.length, differences, summary: counts.join(", ") };
}
