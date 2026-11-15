// What a caller can write into an observation it holds, and what the robot then checks.
//
// PEAR's observation is a plain dictionary (schemas.py: a TypedDict). Its `joint_positions` is a new, writable numpy
// array of its own (snapshot_checks.py, `state_vector`), its frames are the cameras' arrays, and of everything under
// it only three vectors of the control snapshot are tuples, which refuse a write (`TypeError: 'tuple' object does
// not support item assignment`): an arm's targets and a reading's position and velocity. PEAR's robot reads the
// dictionary it is handed at every check, so what was written into a held observation is what the next check sees.
//
// These are expectations written by hand: no record of PEAR holds a write into an observation. What PEAR does with
// each was run on PEAR's own robot on its stepped rig (the station "so101_quick", opened and at rest, then an action
// of z +0.02 m from the observation), and the rows below are that run's:
//
//   the observation as it is, or a copy of it         completed; joint 1 at 0.0001 rad
//   session_id changed in place                       rejected: Observation belongs to a different station session
//   control_snapshot.generation changed in place      rejected: Observation invalidated by another operation
//   control_snapshot replaced, another generation     rejected: Observation invalidated by another operation
//   a copy with joint 1 changed by 0.3 rad            completed; joint 1 at 0.2995 rad
//   joint_positions[1] changed in place by 0.3 rad    completed; joint 1 at 0.2995 rad
//   joint_positions[1] = nan in place                 rejected: Invalid observation reference
//   joint_positions replaced by a list of five        rejected: Invalid observation reference
//   written when the action reports "Executing":
//     joint_positions replaced by a list of five      rejected: Invalid observation reference
//     joint_positions[1] = nan in place               rejected: Invalid observation reference
//     control_snapshot.generation changed in place    rejected: Observation invalidated by another operation
//     control_snapshot replaced, another generation   rejected: Observation invalidated by another operation
//     session_id changed in place                     completed; joint 1 at 0.0001 rad (the dispatch asks no session)
//
// So an observation is not protected from its holder in PEAR, and is not here: the robot plans from the joints it
// is handed. The turn loop of src/agent holds an observation in its own form; `AgentRobotAdapter` hands the robot
// the values that object holds at each check, so every row holds through it too.

import { describe, expect, test } from "vitest";

import { ARM } from "../../src/so101/layout";
import { SO101Robot } from "../../src/so101/robot";
import type { CameraPreview } from "../../src/station/cameras";
import { AgentRobotAdapter } from "../../src/station/robot";
import type { CameraFrame, Observation } from "../../src/station/schemas";
import { brief, delta, handRig, measured } from "./by_hand";
import { StandInCameras, type DrawnFrame } from "./rig";

type Held = Awaited<ReturnType<AgentRobotAdapter["observe"]>>;
/** An observation as a holder writes into it, past the compiler's `readonly`. */
type Written = { -readonly [Key in keyof Held]: Held[Key] };

const ACTION = delta(0.02);
const VALUE_ERROR = (message: string) => ({ code: "ValueError", message });
const FOREIGN = VALUE_ERROR("Observation belongs to a different station session");
const INVALIDATED = VALUE_ERROR("Observation invalidated by another operation");
const INVALID = VALUE_ERROR("Invalid observation reference");

/** What PEAR's run gave for one way of writing into an observation: the result, and where joint 1 was measured. */
interface Row {
  name: string;
  /** Writes into the robot's observation, or returns another one to hand back. */
  station: (observation: Observation) => Observation | void;
  /** The same of the turn loop's observation. */
  held: (observation: Written) => Held | void;
  status: string;
  error: { code: string; message: string } | null;
  joint1: string;
}

const BEFORE: Row[] = [
  { name: "as it is", station: () => undefined, held: () => undefined, status: "completed", error: null, joint1: "0.0001" },
  {
    name: "a copy of it",
    station: (observation) => ({ ...observation }),
    held: (observation) => ({ ...observation }),
    status: "completed",
    error: null,
    joint1: "0.0001",
  },
  {
    name: "its session changed in place",
    station: (observation) => void (observation.session_id = "another"),
    held: (observation) => void (observation.sessionId = "another"),
    status: "rejected",
    error: FOREIGN,
    joint1: "0.0000",
  },
  {
    name: "its control snapshot's generation changed in place",
    station: (observation) => void (observation.control_snapshot.generation += 1),
    held: (observation) => void ((observation.controlSnapshot as unknown as { generation: number }).generation += 1),
    status: "rejected",
    error: INVALIDATED,
    joint1: "0.0000",
  },
  {
    name: "its control snapshot replaced by a copy of another generation",
    station: (observation) => void (observation.control_snapshot = { ...observation.control_snapshot, generation: observation.control_snapshot.generation + 1 }),
    held: (observation) =>
      void (observation.controlSnapshot = { ...observation.controlSnapshot, generation: (observation.controlSnapshot as unknown as { generation: number }).generation + 1 } as never),
    status: "rejected",
    error: INVALIDATED,
    joint1: "0.0000",
  },
  {
    name: "a copy with joint 1 changed by 0.3 rad",
    station: (observation) => ({ ...observation, joint_positions: observation.joint_positions.map((value, index) => value + (index === 1 ? 0.3 : 0)) }),
    held: (observation) => ({ ...observation, jointPositions: observation.jointPositions.map((value, index) => value + (index === 1 ? 0.3 : 0)) }),
    status: "completed",
    error: null,
    joint1: "0.2995",
  },
  {
    name: "joint 1 changed in place by 0.3 rad",
    station: (observation) => void ((observation.joint_positions as number[])[1]! += 0.3),
    held: (observation) => void ((observation.jointPositions as number[])[1]! += 0.3),
    status: "completed",
    error: null,
    joint1: "0.2995",
  },
  {
    name: "joint 1 made NaN in place",
    station: (observation) => void ((observation.joint_positions as number[])[1] = Number.NaN),
    held: (observation) => void ((observation.jointPositions as number[])[1] = Number.NaN),
    status: "rejected",
    error: INVALID,
    joint1: "0.0000",
  },
  {
    name: "its joints replaced by a vector of five",
    station: (observation) => void (observation.joint_positions = observation.joint_positions.slice(0, 5)),
    held: (observation) => void (observation.jointPositions = observation.jointPositions.slice(0, 5)),
    status: "rejected",
    error: INVALID,
    joint1: "0.0000",
  },
];

/** The rows of a write made while the action is under way: when it reports that it executes. */
const DURING: Row[] = [
  BEFORE[8]!,
  BEFORE[7]!,
  BEFORE[3]!,
  BEFORE[4]!,
  { ...BEFORE[2]!, status: "completed", error: null, joint1: "0.0001" },
];

/** The drawn cameras, which keep the frames of their last read. */
class WatchedCameras extends StandInCameras {
  last: Record<string, CameraFrame<DrawnFrame>> = {};

  override async readPreview(): Promise<CameraPreview<DrawnFrame>> {
    const preview = await super.readPreview();
    this.last = preview[0];

    return preview;
  }
}

/** Every container under `value` by its path, in PEAR's kinds: a frozen array is a tuple, another array a list or
 * a numpy array, an object a dictionary (`frozen`: one that could not be written, which PEAR has none of). */
function containersOf(
  value: unknown,
  path = "",
  found: Record<"tuple" | "array" | "dict" | "frozen", string[]> = { tuple: [], array: [], dict: [], frozen: [] },
): Record<"tuple" | "array" | "dict" | "frozen", string[]> {
  if (Array.isArray(value)) {
    (Object.isFrozen(value) ? found.tuple : found.array).push(path);
    value.forEach((item, index) => containersOf(item, `${path}[${index}]`, found));
  } else if (value !== null && typeof value === "object") {
    (Object.isFrozen(value) ? found.frozen : found.dict).push(path === "" ? "." : path);
    for (const [key, item] of Object.entries(value)) {
      containersOf(item, `${path}.${key}`, found);
    }
  }

  return found;
}

describe("an observation of the robot can be written where PEAR's can", () => {
  test("its containers are PEAR's: three tuples, and everything else writable", async () => {
    const { robot } = await handRig({ cameras: "drawn" });
    await robot.execute(ACTION);
    const observation = await robot.observe();

    // PEAR's, of the same observation (the frames aside: PEAR's is a numpy array, the rig's a shape)
    const found = containersOf({ ...observation, images: {} });
    expect(found.tuple.sort()).toEqual(
      [`.control_snapshot.targets.${ARM}`, `.control_snapshot.arms.${ARM}.position`, `.control_snapshot.arms.${ARM}.velocity`].sort(),
    );
    expect(found.array.sort()).toEqual(
      [
        ".joint_positions",
        ".control_snapshot.arrival.signed_error",
        ".control_snapshot.arrival.tolerance",
        ".control_snapshot.settling.position_span",
        ".control_snapshot.settling.velocity_mean",
        ".control_snapshot.settling.velocity_rms",
        ".control_snapshot.settling.violations",
        ".control_snapshot.motion.feedforward",
      ].sort(),
    );
    expect(found.dict.sort()).toEqual(
      [
        ".",
        ".images",
        ".camera_timestamps",
        ".camera_timestamps.wrist",
        ".control_snapshot",
        ".control_snapshot.targets",
        ".control_snapshot.arms",
        `.control_snapshot.arms.${ARM}`,
        `.control_snapshot.arms.${ARM}.servo`,
        ".control_snapshot.arrival",
        ".control_snapshot.settling",
        ".control_snapshot.motion",
      ].sort(),
    );
    expect(found.frozen).toEqual([]);
    expect(Object.isFrozen(observation)).toBe(false);
    await robot.close();
  });

  test("a write into one of the three tuples throws a TypeError and changes nothing", async () => {
    const { robot } = await handRig();
    const observation = await robot.observe();
    const snapshot = observation.control_snapshot;
    const tuples = [snapshot.targets[ARM], snapshot.arms[ARM]!.position, snapshot.arms[ARM]!.velocity] as number[][];

    for (const tuple of tuples) {
      const before = [...tuple];
      expect(() => {
        tuple[0] = 1;
      }).toThrow(TypeError);
      expect(() => tuple.push(1)).toThrow(TypeError);
      expect(tuple).toEqual(before);
    }
    await robot.close();
  });

  test("the joint vector is the observation's own: a write changes no other observation and no reading", async () => {
    const { robot } = await handRig();
    const first = await robot.observe();
    const second = await robot.observe();
    const [joints, readings] = [[...first.joint_positions], measured(robot)];
    expect(second.joint_positions).not.toBe(first.joint_positions);
    expect(second.control_snapshot).not.toBe(first.control_snapshot);

    (first.joint_positions as number[])[1]! += 0.25;

    expect(first.joint_positions[1]).toBe(joints[1]! + 0.25);
    expect(second.joint_positions).toEqual(joints);
    expect((await robot.observe()).joint_positions).toEqual(joints);
    expect(measured(robot)).toEqual(readings);
    await robot.close();
  });

  test("the frames are the cameras' own, not copies", async () => {
    let cameras: WatchedCameras | null = null;
    const { robot } = await handRig({ cameras: (clock) => (cameras = new WatchedCameras(SO101Robot.CAMERAS, clock)) });
    const observation = await robot.observe();

    expect(Object.keys(observation.images)).toEqual(["wrist"]);
    expect(observation.images["wrist"]).toBe((cameras as WatchedCameras | null)!.last["wrist"]!.rgb);
    await robot.close();
  });
});

describe("the robot checks and plans from the observation as it is handed back (PEAR's run)", () => {
  test.each(BEFORE)("$name", async (row) => {
    const { robot } = await handRig();
    const observation = await robot.observe();
    const reference = row.station(observation) ?? observation;

    // what the robot refuses of an observation it does not hold or wait for either, with the same words
    const holding = whether(() => robot.isHolding(reference));
    const waited = await robot.waitStationary(reference).then(
      () => "true",
      (error: Error) => `${error.name}: ${error.message}`,
    );
    const result = await robot.execute(ACTION, { referenceObservation: reference });

    expect(holding).toBe(refusalOf(row));
    expect(waited).toBe(refusalOf(row));
    expect(brief(result)).toEqual({ status: row.status, error: row.error });
    expect(measured(robot)[1]).toBe(row.joint1);
    await robot.close();
  });

  test.each(DURING)("written while the action is under way: $name", async (row) => {
    const { robot } = await handRig();
    const observation = await robot.observe();

    const result = await robot.execute(ACTION, {
      referenceObservation: observation,
      reportProgress: (phase) => {
        if (phase === "Executing") {
          row.station(observation);
        }
      },
    });

    expect(brief(result)).toEqual({ status: row.status, error: row.error });
    expect(measured(robot)[1]).toBe(row.joint1);
    await robot.close();
  });
});

describe("through the turn loop's adapter the robot reads what the loop's observation holds then", () => {
  const encode = (): Uint8Array => new Uint8Array([255, 216, 255, 217]);

  test.each(BEFORE)("$name", async (row) => {
    const { robot } = await handRig({ cameras: "drawn" });
    const adapter = new AgentRobotAdapter(robot, encode);
    const held = await adapter.observe();
    const reference = row.held(held) ?? held;

    const holding = whether(() => adapter.isHolding(reference));
    const waited = await adapter.waitStationary(reference).then(
      () => "true",
      (error: Error) => `${error.name}: ${error.message}`,
    );
    const result = await adapter.execute(ACTION, { referenceObservation: reference });

    expect(holding).toBe(refusalOf(row));
    expect(waited).toBe(refusalOf(row));
    expect(brief(result as never)).toEqual({ status: row.status, error: row.error });
    expect(measured(robot)[1]).toBe(row.joint1);
    await robot.close();
  });

  test.each(DURING)("written while the action is under way: $name", async (row) => {
    const { robot } = await handRig({ cameras: "drawn" });
    const adapter = new AgentRobotAdapter(robot, encode);
    const held = await adapter.observe();

    const result = await adapter.execute(ACTION, {
      referenceObservation: held,
      reportProgress: (phase) => {
        if (phase === "Executing") {
          row.held(held);
        }
      },
    });

    expect(brief(result as never)).toEqual({ status: row.status, error: row.error });
    expect(measured(robot)[1]).toBe(row.joint1);
    await robot.close();
  });

  test("the loop's observation can be written as PEAR's dictionary can, and holds the robot's own joint vector", async () => {
    const { robot } = await handRig({ cameras: "drawn" });
    const seen: Observation[] = [];
    const observe = robot.observe.bind(robot);
    robot.observe = async () => {
      seen.push(await observe());
      return seen.at(-1) as never;
    };
    const held = await new AgentRobotAdapter(robot, encode).observe();

    expect(Object.isFrozen(held)).toBe(false);
    expect(Object.isFrozen(held.jointPositions)).toBe(false);
    expect(held.jointPositions).toBe(seen[0]!.joint_positions);
    expect(held.controlSnapshot).toBe(seen[0]!.control_snapshot);
    expect(() => {
      ((held.controlSnapshot as unknown as Observation["control_snapshot"]).arms[ARM]!.position as number[])[0] = 1;
    }).toThrow(TypeError);
    await robot.close();
  });

  test("the robot is handed its own frames and their stamps back, and the loop's values of everything else", async () => {
    const { robot } = await handRig({ cameras: "drawn" });
    const issued: Observation[] = [];
    const handed: Observation[] = [];
    const observe = robot.observe.bind(robot);
    robot.observe = async () => {
      issued.push(await observe());
      return issued.at(-1) as never;
    };
    const verify = robot.verifyObservation.bind(robot);
    robot.verifyObservation = (observation) => {
      handed.push(observation);
      return verify(observation);
    };
    const adapter = new AgentRobotAdapter(robot, encode);
    const held = await adapter.observe();

    const result = await adapter.execute(ACTION, { referenceObservation: held });

    expect(brief(result as never)).toEqual({ status: "completed", error: null });
    const [own, back] = [issued[0]!, handed[0]!];
    expect(back.images["wrist"]).toBe(own.images["wrist"]);
    expect(back.images["wrist"]).not.toBe(held.images["wrist"]);
    expect(back.camera_timestamps).toBe(own.camera_timestamps);
    expect({ ...back, images: null, camera_timestamps: null }).toEqual({ ...own, images: null, camera_timestamps: null });
    expect(back.joint_positions).toBe(held.jointPositions);
    expect(back.control_snapshot).toBe(held.controlSnapshot);

    // a copy the loop made has no frames of the robot: PEAR's dictionary of the copy's own values
    const copy = { ...held };
    await adapter.execute(ACTION, { referenceObservation: copy });
    const ofCopy = handed.at(-1)!;
    expect(ofCopy.images["wrist"]).toBe(held.images["wrist"]);
    expect(ofCopy.camera_timestamps).toEqual(own.camera_timestamps);
    expect(ofCopy.session_id).toBe(held.sessionId);
    await robot.close();
  });
});

/** What PEAR's `is_holding` and `wait_stationary` do with the observation of `row`: "true" when they return, or the error they raise. */
function refusalOf(row: Row): string {
  return row.error === null ? "true" : `${row.error.code}: ${row.error.message}`;
}

/** What `isHolding` answers, or the error it throws. */
function whether(isHolding: () => boolean): string {
  try {
    return String(isHolding());
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}
