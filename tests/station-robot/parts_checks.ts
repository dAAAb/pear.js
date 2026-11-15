// The cases of parts.json.gz, each run on pear.js's own classes and compared with what PEAR's gave: every field of
// every case, by one comparison (the same double, the sign of a zero, the same text, the same keys in PEAR's
// order), or within a tolerance where a test says so. tools/fixtures/robot_fixtures.py wrote the cases: the class
// named at each group there is the one whose record this file builds in the same shape.

import { KeyError, OSError, RuntimeError, TimeoutError, ValueError } from "../../src/python/errors";
import { SINGLE_ARM_POSE_FORMAT } from "../../src/so101/formats";
import { WristCamera, type WristFrameReader } from "../../src/so101/hardware/cameras";
import { UnreachablePoseError } from "../../src/so101/kinematics/errors";
import { SO101Kinematics, type ArmDelta } from "../../src/so101/kinematics/kinematics";
import { LAYOUT } from "../../src/so101/layout";
import { modelStateOf } from "../../src/so101/motion/actions";
import { SO101Planning, type PlanningKinematics } from "../../src/so101/motion/planning";
import { SO101MotionResult } from "../../src/so101/motion/results";
import { SO101Robot } from "../../src/so101/robot";
import { CameraFeed, type CameraPreview } from "../../src/station/cameras";
import type { MonotonicClock } from "../../src/station/joint/clock";
import { JointMove } from "../../src/station/joint/trajectory";
import { HomePlanning, type PlanningObservation } from "../../src/station/motion/planning";
import { MotionResult, type MotionResultFields, type MotionStatus } from "../../src/station/motion/results";
import type { CameraFrame } from "../../src/station/schemas";
import { Comparison, plain } from "../station-loop/compare";
import {
  errorRecord,
  makeError,
  outcomeOf,
  outcomeOfAsync,
  stationOf,
  type ErrorSpec,
  type Outcome,
  type RecordedError,
  type Station,
} from "./fixtures";

/** One case of the fixtures, run and compared: null when pear.js gave what PEAR gave, else the first difference. */
export interface Check {
  /** The group of cases in parts.json.gz. */
  group: string;
  name: string;
  run(comparison: Comparison): string | null | Promise<string | null>;
}

interface MoveSpec {
  start: number[];
  goal: number[];
  speed_scale?: number;
  caps?: { velocity: number[]; acceleration: number[]; jerk: number[] } | null;
}

interface KinematicsCall {
  joints: number[];
  delta: number[];
  out: Outcome<number[]>;
}

export interface PartsFixture {
  action_cases: { kind: string; station: string; measured: number[]; targets: number[]; action: unknown; out: Outcome; ik: KinematicsCall[] }[];
  delta_base_cases: { station: string; measured: number[]; commanded: number[]; out: string }[];
  action_parts_cases: { action: unknown; out: Outcome }[];
  home_cases: { kind: string; station: string; measured: number[]; targets: number[]; out: Outcome }[];
  bounds_cases: {
    station: string;
    start: number[];
    goal: number[];
    offset: number[];
    move: MoveSpec | null;
    build?: Outcome;
    so101?: Outcome;
    generic?: Outcome;
    home_move: Outcome;
    generic_home_move: Outcome;
  }[];
  recheck_cases: { station: string; move: MoveSpec | null; measured: number[]; targets: number[]; so101: Outcome; generic: Outcome }[];
  estimate_cases: { station: string; move: MoveSpec | null; opening_s: number; has_opening: boolean; out: unknown }[];
  opening_cases: { target: number; measured: number; tolerance: number; out: boolean }[];
  measured_cases: { joints: number[]; out: number[] }[];
  no_home_cases: {
    station: string;
    call: "checked_home" | "home_move" | "time_estimates";
    measured?: number[];
    targets?: number[];
    start?: number[];
    goal?: number[];
    offset?: number[];
    opening_s?: number;
    has_opening?: boolean;
    out: Outcome;
  }[];
  result_snapshots: Record<string, Record<string, unknown>>;
  snapshot_cases: {
    snapshot: string;
    status: MotionStatus;
    error: ErrorSpec | null;
    gripper_outcome: string | null;
    kinematics: string | null;
    out: Outcome;
    log: string[][];
  }[];
  build_cases: {
    snapshot: string;
    status: MotionStatus;
    state_error: string | null;
    is_gripper_reached: boolean;
    out: Outcome;
    log: string[][];
  }[];
  feedback_cases: { result: Record<string, unknown> | null; out: Outcome }[];
  camera_cases: { name: string; steps: Record<string, unknown>[] }[];
}

const stations = new Map<string, Station>();
const kinematics = new Map<string, SO101Kinematics>();

function station(key: string): Station {
  let made = stations.get(key);
  if (made === undefined) {
    made = stationOf(key);
    stations.set(key, made);
  }
  return made;
}

function kinematicsOf(key: string): SO101Kinematics {
  let made = kinematics.get(key);
  if (made === undefined) {
    made = new SO101Kinematics(station(key).robotConfig);
    kinematics.set(key, made);
  }
  return made;
}

/** The least of an observation that PEAR's planning reads (`Snapshots.observation` of the fixture script). */
function observationOf(measured: number[], targets: number[]): PlanningObservation {
  return {
    joint_positions: [...measured],
    control_snapshot: { arms: { [LAYOUT.arms[0]!]: { position: [...measured] } }, targets: { [LAYOUT.arms[0]!]: [...targets] } },
  };
}

/** A checked move as a fixture holds it (`Moves.record`). */
export function moveRecord(move: JointMove | null): Record<string, unknown> | null {
  if (move === null) {
    return null;
  }
  return {
    start: [...move.start],
    goal: [...move.goal],
    caps: move.motionCaps.map((caps) => [...caps]),
    duration: move.durationS,
  };
}

/** The move a script names, built as PEAR builds a move (`Moves.build`). */
function buildMove(on: Station, spec: MoveSpec | null): JointMove | null {
  if (spec === null) {
    return null;
  }
  return JointMove.build(spec.start, spec.goal, on.robotConfig.jointLimits(), LAYOUT, {
    speedScale: spec.speed_scale ?? 1.0,
    caps: spec.caps ?? null,
  });
}

/**
 * PEAR's kinematics as the fixtures recorded them: each call must ask what PEAR's planning asked (the same joints
 * and the same delta, in the same order) and is answered with what PEAR's kinematics answered, so that the
 * comparison of the planning is no comparison of two solvers.
 */
export class RecordedKinematics implements PlanningKinematics {
  readonly asked: { joints: number[]; delta: number[] }[] = [];
  private next = 0;

  constructor(private readonly calls: readonly KinematicsCall[]) {}

  jointTarget(jointPositions: ArrayLike<number>, action: ArmDelta): number[] {
    this.asked.push({
      joints: Array.from(jointPositions),
      delta: SO101Kinematics.ARM_QUANTITIES.map((name) => action.arm[name]),
    });
    const call = this.calls[this.next++];
    if (call === undefined) {
      throw new Error(`The planning asked its kinematics a ${this.next}th time; PEAR's asked ${this.calls.length} times`);
    }
    if ("error" in call.out) {
      throw thrownAs(call.out.error);
    }
    return [...call.out.ok];
  }

  /** What the planning asked, and what PEAR's asked: compared by the caller. */
  get expected(): { joints: number[]; delta: number[] }[] {
    return this.calls.map(({ joints, delta }) => ({ joints, delta }));
  }
}

/** Returns the exception PEAR's kinematics raised, as pear.js's kinematics throw it. */
function thrownAs(error: RecordedError): Error {
  if (error.type === "UnreachablePoseError") {
    return new UnreachablePoseError(error.message);
  }
  if (error.type === "ValueError") {
    return new ValueError(error.message);
  }
  return makeError({ type: error.type, message: error.message }, true);
}

/** What `SO101Planning.checked_action` gave, in the fixture's shape. */
function preparedRecord(prepared: { gripperRequest: unknown; move: JointMove | null }): Record<string, unknown> {
  return { gripper_request: prepared.gripperRequest, move: moveRecord(prepared.move) };
}

function feedbackOf(result: MotionResultFields | null): Record<string, string> {
  return {
    dispatched: SINGLE_ARM_POSE_FORMAT.resultFeedback(result, { isDispatched: true }),
    not_dispatched: SINGLE_ARM_POSE_FORMAT.resultFeedback(result, { isDispatched: false }),
  };
}

function resultShown(result: MotionResult): Record<string, unknown> {
  return { record: plain(result.toRecord()), feedback: feedbackOf(result) };
}

/** The wrist camera's frame reader that a script feeds (`ScriptedCamera` of the fixture script). */
export class ScriptedCamera implements WristFrameReader<Uint8Array> {
  /** null: no reader thread at all. */
  reading: boolean | null = true;
  disconnects = 0;
  failsToClose = false;
  latestFrame: Uint8Array | null = null;
  latestTimestamp: number | null = null;
  isConnected = true;
  readonly source: WristCamera<Uint8Array>;

  /** What a script has the camera do once, before its next read (as another thread would during it). */
  onRead: (() => Promise<void>) | null = null;
  /** The error a read raises in the place of reading (a camera source may raise anything); null: it reads. */
  readRaises: ErrorSpec | null = null;

  constructor(
    private readonly clock: Pick<MonotonicClock, "monotonic">,
    role = "wrist",
  ) {
    this.source = new WristCamera({ camera: { role } as never }, this, { clock });
    const readPreview = this.source.readPreview.bind(this.source);
    this.source.readPreview = async () => {
      const onRead = this.onRead;
      this.onRead = null;
      if (onRead !== null) {
        await onRead();
      }
      if (this.readRaises !== null) {
        throw makeError(this.readRaises);
      }
      return readPreview();
    };
  }

  get isReading(): boolean {
    return this.reading === true;
  }

  disconnect(): void {
    if (this.failsToClose) {
      throw new OSError("the camera did not close");
    }
    this.disconnects += 1;
    this.isConnected = false;
  }

  /** Does what a script says of the camera: a new frame (its number fills every pixel) with its age, the reader
   * thread's state, or a failing close. */
  apply(operation: Record<string, unknown>): void {
    if ("frame" in operation) {
      const frame = operation["frame"] as number | null;
      this.latestFrame = frame === null ? null : new Uint8Array(2 * 3 * 3).fill(frame);
      const ageS = "age_s" in operation ? (operation["age_s"] as number | null) : 0.0;
      this.latestTimestamp = ageS === null ? null : this.clock.monotonic() - ageS;
    }
    if ("reading" in operation) {
      this.reading = operation["reading"] as boolean | null;
    }
    if ("fails_to_close" in operation) {
      this.failsToClose = operation["fails_to_close"] as boolean;
    }
    if ("read_raises" in operation) {
      this.readRaises = operation["read_raises"] as ErrorSpec | null;
    }
  }

  /** A read's frames as a fixture holds them: the number that fills the frame in the place of its pixels. */
  static frames(frames: Record<string, CameraFrame<Uint8Array>>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(frames).map(([role, frame]) => [
        role,
        { frame: frame.rgb[0], received_monotonic_s: frame.received_monotonic_s, frame_number: frame.frame_number },
      ]),
    );
  }
}

function previewShown(preview: CameraPreview<Uint8Array>): Record<string, unknown> {
  return { frames: ScriptedCamera.frames(preview[0]), errors: preview[1] };
}

/** Runs one script of the wrist camera and the camera feed, and returns its steps as the fixture holds them. */
async function cameraSteps(script: readonly Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const clock = { now: 100.0, monotonic: (): number => clock.now };
  const camera = new ScriptedCamera(clock);
  const other = new ScriptedCamera(clock);
  let feed: CameraFeed<Uint8Array> | null = null;
  const steps: Record<string, unknown>[] = [];

  for (const recorded of script) {
    // what the script gave of the step: everything but what PEAR did
    const step: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(recorded)) {
      if (!["out", "disconnects", "has_reader", "clock"].includes(key)) {
        step[key] = value;
      }
    }
    const op = recorded["op"] as string;
    const target = recorded["camera"] === "other" ? other : camera;
    const readers: Record<string, WristCamera<Uint8Array>> = { camera: camera.source, other: other.source };
    if (op === "set") {
      target.apply(recorded);
    } else if (op === "advance") {
      clock.now += recorded["seconds"] as number;
    } else if (op === "clock") {
      clock.now = recorded["now"] as number; // (a reading at which an age is an exact difference)
    } else if (op === "read_preview") {
      step["out"] = await outcomeOfAsync(() => target.source.readPreview(), previewShown);
    } else if (op === "read") {
      step["out"] = await outcomeOfAsync(() => target.source.read(), ScriptedCamera.frames);
    } else if (op === "close") {
      step["out"] = await outcomeOfAsync(() => target.source.close());
      step["disconnects"] = target.disconnects;
    } else if (op === "feed") {
      const reader = recorded["reader"] as string | null;
      feed = new CameraFeed(reader === null ? null : readers[reader]!);
    } else if (op === "feed_set_reader") {
      await feed!.setReader(readers[recorded["reader"] as string]!);
    } else if (op === "feed_read_preview") {
      step["out"] = await outcomeOfAsync(() => feed!.readPreview(), previewShown);
    } else if (op === "feed_read") {
      step["out"] = await outcomeOfAsync(() => feed!.read(), ScriptedCamera.frames);
    } else if (op === "feed_close") {
      step["out"] = await outcomeOfAsync(() => feed!.close());
      step["disconnects"] = [camera.disconnects, other.disconnects];
      step["has_reader"] = feed!.reader !== null;
    } else {
      throw new Error(`unknown camera operation ${op}`);
    }
    step["clock"] = clock.now;
    steps.push(step);
  }

  return steps;
}

/**
 * Returns every case of `fixture` as a check. With `kinematics` "recorded" the planning's kinematics answer what
 * PEAR's answered; with "own" they are pear.js's own solver, whose goals differ from PEAR's solver's in their last
 * digits, so that a caller compares those cases within a tolerance.
 */
export function partsChecks(fixture: PartsFixture, options: { kinematics: "recorded" | "own" } = { kinematics: "recorded" }): Check[] {
  const checks: Check[] = [];
  const add = (group: string, index: number, label: string, run: Check["run"]): void => {
    checks.push({ group, name: `${group} ${index}${label ? `: ${label}` : ""}`, run });
  };

  fixture.action_cases.forEach((item, index) => {
    add("action_cases", index, item.kind, (comparison) => {
      const on = station(item.station);
      const recorded = new RecordedKinematics(item.ik);
      const solver: PlanningKinematics = options.kinematics === "recorded" ? recorded : kinematicsOf(item.station);
      const out = outcomeOf(
        () =>
          SO101Planning.checkedAction(
            on.robotConfig,
            solver,
            observationOf(item.measured, item.targets),
            SO101Robot.ACTION_ADAPTER.validate(item.action),
          ),
        preparedRecord,
      );
      const asked = options.kinematics === "recorded" ? comparison.difference(recorded.asked, recorded.expected, "ik") : null;

      return comparison.difference(out, item.out, "out") ?? asked;
    });
  });

  fixture.delta_base_cases.forEach((item, index) => {
    add("delta_base_cases", index, "", (comparison) => {
      const measured = [...item.measured];
      const commanded = [...item.commanded];
      const base = SO101Planning.deltaBase(station(item.station).robotConfig, measured, commanded);
      // which of the two vectors it is, as PEAR returns one of them
      const out = base === commanded ? "commanded" : base === measured ? "measured" : "another vector";

      return comparison.difference(out, item.out, "out");
    });
  });

  fixture.action_parts_cases.forEach((item, index) => {
    add("action_parts_cases", index, "", (comparison) => {
      const model = SO101Robot.ACTION_ADAPTER.validate(item.action);
      const out = outcomeOf(
        () => SO101Planning.actionParts(model),
        (parts) => ({ moves_arm: parts[0] !== null, opens_gripper: parts[1] }),
      );

      return comparison.difference(out, item.out, "out");
    });
  });

  fixture.home_cases.forEach((item, index) => {
    add("home_cases", index, `${item.kind} (${item.station})`, (comparison) => {
      const on = station(item.station);
      const out = outcomeOf(
        () => SO101Planning.checkedHome(on.controlConfig, on.robotConfig, observationOf(item.measured, item.targets)),
        (planned) => ({ plan: plain(planned[0]), move: moveRecord(planned[1]) }),
      );

      return comparison.difference(out, item.out, "out");
    });
  });

  fixture.bounds_cases.forEach((item, index) => {
    add("bounds_cases", index, item.station, (comparison) => {
      const on = station(item.station);
      const built = outcomeOf(
        () => buildMove(on, item.move),
        (move) => move,
      );
      const actual: Record<string, unknown> = {};
      if ("error" in built) {
        actual["build"] = built;
      } else {
        const move = built.ok as JointMove | null;
        actual["so101"] = outcomeOf(() => SO101Planning.checkHomeBounds(on.robotConfig, move, item.start, item.offset));
        actual["generic"] = outcomeOf(() => HomePlanning.checkHomeBounds(on.robotConfig, move, item.start, item.offset));
      }
      actual["home_move"] = outcomeOf(() => SO101Planning.homeMove(on.robotConfig, item.start, item.goal, item.offset), moveRecord);
      actual["generic_home_move"] = outcomeOf(
        () => HomePlanning.homeMove(on.robotConfig, item.start, item.goal, item.offset),
        moveRecord,
      );
      const expected: Record<string, unknown> = {};
      for (const key of ["build", "so101", "generic", "home_move", "generic_home_move"] as const) {
        if (item[key] !== undefined) {
          expected[key] = item[key];
        }
      }

      return comparison.difference(actual, expected, "");
    });
  });

  fixture.recheck_cases.forEach((item, index) => {
    add("recheck_cases", index, item.station, (comparison) => {
      const on = station(item.station);
      const move = buildMove(on, item.move);
      const observation = observationOf(item.measured, item.targets);
      const actual = {
        so101: outcomeOf(() => SO101Planning.recheckHomeMove(on.robotConfig, observation, move)),
        generic: outcomeOf(() => HomePlanning.recheckHomeMove(on.robotConfig, observation, move)),
      };

      return comparison.difference(actual, { so101: item.so101, generic: item.generic }, "");
    });
  });

  fixture.estimate_cases.forEach((item, index) => {
    add("estimate_cases", index, item.station, (comparison) => {
      const on = station(item.station);
      const out = HomePlanning.timeEstimates(
        on.controlConfig,
        on.robotConfig,
        buildMove(on, item.move),
        item.opening_s,
        item.has_opening,
      );

      return comparison.difference(plain(out), item.out, "out");
    });
  });

  fixture.opening_cases.forEach((item, index) => {
    add("opening_cases", index, "", (comparison) =>
      comparison.difference(HomePlanning.needsOpening(item.target, item.measured, item.tolerance), item.out, "out"),
    );
  });

  fixture.measured_cases.forEach((item, index) => {
    add("measured_cases", index, "", (comparison) =>
      comparison.difference(HomePlanning.measuredPositions({ joint_positions: item.joints }, LAYOUT), item.out, "out"),
    );
  });

  fixture.no_home_cases.forEach((item, index) => {
    add("no_home_cases", index, item.call, (comparison) => {
      const on = station(item.station);
      let out: Outcome;
      if (item.call === "checked_home") {
        out = outcomeOf(
          () => SO101Planning.checkedHome(on.controlConfig, on.robotConfig, observationOf(item.measured!, item.targets!)),
          (planned) => [plain(planned[0]), moveRecord(planned[1])],
        );
      } else if (item.call === "home_move") {
        out = outcomeOf(() => SO101Planning.homeMove(on.robotConfig, item.start!, item.goal!, item.offset!), moveRecord);
      } else {
        out = outcomeOf(() =>
          HomePlanning.timeEstimates(on.controlConfig, on.robotConfig, null, item.opening_s!, item.has_opening!),
        );
      }

      return comparison.difference(out, item.out, "out");
    });
  });

  fixture.snapshot_cases.forEach((item, index) => {
    add("snapshot_cases", index, `${item.snapshot}, ${item.status}`, (comparison) => {
      const log: string[][] = [];
      const error = item.error === null ? null : makeError(item.error, true);
      // the exception as pear.js makes it must read as PEAR's does
      const made = error === null ? null : comparison.difference(error.message, item.error!.message, "error.message");
      const out = outcomeOf(
        () =>
          SO101MotionResult.fromSnapshot(fixture.result_snapshots[item.snapshot]!, {
            status: item.status,
            error,
            kinematics: item.kinematics === null ? null : kinematicsOf(item.kinematics),
            gripperOutcome: item.gripper_outcome,
            log: (level, message) => log.push(["results", level, message]),
          }),
        resultShown,
      );

      return made ?? comparison.difference({ out, log }, { out: item.out, log: item.log }, "");
    });
  });

  fixture.build_cases.forEach((item, index) => {
    add("build_cases", index, `${item.state_error ?? "a state"}, ${item.status}`, (comparison) => {
      const raising: Record<string, Error> = {
        ValueError: new ValueError("no state"),
        RuntimeError: new RuntimeError("no state"),
        UnreachablePoseError: new UnreachablePoseError("no state"),
        KeyError: new KeyError("'no state'"),
        TimeoutError: new TimeoutError("no state"),
      };
      const log: string[][] = [];
      const out = outcomeOf(
        () =>
          MotionResult.build(fixture.result_snapshots[item.snapshot]!, {
            status: item.status,
            error: null,
            toModelState: (position: number[]) => {
              if (item.state_error !== null) {
                throw raising[item.state_error]!;
              }
              return modelStateOf(kinematicsOf("so101_station"), position);
            },
            isGripperReached: item.is_gripper_reached,
            gripperOutcome: "closed",
            log: (level, message) => log.push(["results", level, message]),
          }),
        resultShown,
      );

      return comparison.difference({ out, log }, { out: item.out, log: item.log }, "");
    });
  });

  fixture.feedback_cases.forEach((item, index) => {
    add("feedback_cases", index, "", (comparison) => {
      const fields = item.result;
      const out = outcomeOf(() =>
        feedbackOf(
          fields === null
            ? null
            : new SO101MotionResult({
                status: fields["status"] as MotionStatus,
                isSettled: fields["is_settled"] as boolean,
                targetReached: fields["target_reached"] as boolean,
                measuredPosition: fields["measured_position"] as number[] | null,
                trackingError: fields["tracking_error"] as number[] | null,
                gripperOutcome: fields["gripper_outcome"] as string | null,
                error: fields["error"] as { code: string; message: string } | null,
              }),
        ),
      );

      return comparison.difference(out, item.out, "out");
    });
  });

  fixture.camera_cases.forEach((item, index) => {
    add("camera_cases", index, item.name, async (comparison) =>
      comparison.difference(await cameraSteps(item.steps), item.steps, "steps"),
    );
  });

  return checks;
}

export { errorRecord };
