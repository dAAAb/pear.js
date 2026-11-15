import { describe, expect, test } from "vitest";

import { JointDriver } from "../../src/station/joint/driver";
import { ArmState } from "../../src/station/joint/arm_state";
import {
  ActionPhase,
  ControlState,
  MOVING_CONTROL_STATES,
  MotionEndReason,
  RecoveryPhase,
  RobotStatus,
  type ActionFormat,
  type ArmFeedback,
  type Arrival,
  type BriefStatus,
  type Camera,
  type CameraFrame,
  type ControlSnapshot,
  type DetailedStatus,
  type HomePlan,
  type HomeReport,
  type Motion,
  type Observation,
  type RecoveryProgress,
  type SnapshotFields,
} from "../../src/station/schemas";
import { meta } from "./fixtures";

// One value of every dictionary of PEAR's schemas, with exactly PEAR's keys in PEAR's order. The compiler holds each
// to its interface (`npm run typecheck`); the tests hold each to the keys of PEAR's own TypedDict.
const arrival = { settled: true, reached: true, signed_error: [0], tolerance: [0.06] } satisfies Arrival;
const motion = { end_reason: "finished", settling: false } satisfies Motion;
const armFeedback = {
  position: [0],
  velocity: [0],
  sampled_monotonic_s: 100,
  sample_id: 1,
  age_seconds: 0,
} satisfies ArmFeedback;
const snapshotFields = {
  captured_monotonic_s: 100,
  fault: null,
  fault_details: null,
  generation: 0,
  targets: { arm: [0] },
  arms: { arm: armFeedback },
  arrival,
  settling: {},
  recovery: null,
  motion,
} satisfies SnapshotFields;
const controlSnapshot = { ...snapshotFields, status: ControlState.HOLD } satisfies ControlSnapshot;
const witnesses: Record<string, object> = {
  CameraFrame: { rgb: null, received_monotonic_s: 100, frame_number: 1 } satisfies CameraFrame,
  ArmFeedback: armFeedback,
  Arrival: arrival,
  Motion: motion,
  RecoveryProgress: { phase: RecoveryPhase.CHECKING_STABILITY, metrics: {} } satisfies RecoveryProgress,
  SnapshotFields: snapshotFields,
  ControlSnapshot: controlSnapshot,
  DetailedStatus: { ...snapshotFields, status: RobotStatus.READY, control_state: ControlState.HOLD } satisfies DetailedStatus,
  BriefStatus: { status: RobotStatus.READY, settled: true, reached: true, fault: null } satisfies BriefStatus,
  Observation: {
    observation_id: "o",
    session_id: "s",
    captured_monotonic_s: 100,
    joint_positions: [0],
    images: {},
    camera_timestamps: {},
    control_snapshot: controlSnapshot,
  } satisfies Observation,
  HomePlan: { operation_seconds_estimate: 1 } satisfies HomePlan,
  HomeReport: {
    plan: { operation_seconds_estimate: 1 },
    before: controlSnapshot,
    phases: [],
    after: controlSnapshot,
    results: {},
  } satisfies HomeReport,
};
const camera = { role: "wrist", name: "wrist", label: "Wrist" } satisfies Camera;
const actionFormat = {
  name: "single_arm_pose",
  schema: { arm: ["x"] },
  cameras: [camera],
  environmentPrompt: "",
  decimals: { x: 1 },
  actionModel: (action: unknown) => action,
  resultFeedback: () => null,
} satisfies ActionFormat;

/** Returns a name of PEAR's as pear.js writes the field of a class: `environment_prompt` as `environmentPrompt`. */
function camelCase(name: string): string {
  return name.replace(/_(\w)/g, (_match, letter: string) => letter.toUpperCase());
}

describe("the schemas of the control", () => {
  test("every enumeration holds PEAR's words under PEAR's names", () => {
    const enumerations = { RobotStatus, ControlState, MotionEndReason, RecoveryPhase, ActionPhase };

    expect(Object.keys(enumerations).sort()).toEqual(Object.keys(meta.schemas.enumerations).sort());
    for (const [name, words] of Object.entries(meta.schemas.enumerations)) {
      expect({ ...enumerations[name as keyof typeof enumerations] }, name).toEqual(words);
      expect(Object.keys(enumerations[name as keyof typeof enumerations]), name).toEqual(Object.keys(words));
    }
    expect([...MOVING_CONTROL_STATES]).toEqual(meta.schemas.moving_control_states);
  });

  test("every dictionary has PEAR's keys", () => {
    expect(Object.keys(witnesses).sort()).toEqual(Object.keys(meta.schemas.dictionaries).sort());
    for (const [name, keys] of Object.entries(meta.schemas.dictionaries)) {
      expect(Object.keys(witnesses[name]!), name).toEqual(keys);
    }
  });

  test("a camera and an action format have PEAR's fields", () => {
    expect(Object.keys(camera)).toEqual(meta.schemas.dataclasses["Camera"]);
    expect(Object.keys(actionFormat)).toEqual(meta.schemas.dataclasses["ActionFormat"]!.map(camelCase));
  });
});

describe("the joint driver", () => {
  // PEAR's JointDriver is an abstract class with two defaults: a driver renews nothing in a hold and adds nothing to
  // a snapshot's motion unless its robot says so.
  class MemoryDriver extends JointDriver {
    position: readonly number[] = [0, 0, 0, 0, 0, 0.5];
    sent: (readonly number[])[] = [];

    async read(): Promise<Record<string, ArmState>> {
      return { arm: new ArmState(this.position, this.position.map(() => 0), 100, this.sent.length) };
    }

    async readForRecovery(): Promise<Record<string, ArmState>> {
      return this.read();
    }

    async send(targets: Readonly<Record<string, readonly number[]>>): Promise<void> {
      this.position = targets["arm"]!;
      this.sent.push(this.position);
    }

    async close(): Promise<void> {}
  }

  test("a driver that says nothing of a hold or of telemetry has PEAR's defaults", async () => {
    const driver = new MemoryDriver();

    await driver.send({ arm: [0.1, 0, 0, 0, 0, 0.5] });
    await expect(driver.refreshHold({ arm: driver.position })).resolves.toBeUndefined();
    expect(driver.telemetry()).toEqual({});
    expect(driver.sent).toHaveLength(1);
    expect((await driver.read())["arm"]!.position[0]).toBe(0.1);
    expect((await driver.readForRecovery())["arm"]!.sampleId).toBe(1);
  });
});
