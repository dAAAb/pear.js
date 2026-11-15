// The frames of a turn: PEAR's ObservationMessage.build gave, for each case of tests/fixtures/agent/messages.json,
// the frames a turn carries, their order, their names and the UUIDs it drew, or the error of a frame that is missing
// or newer than its observation (tools/fixtures/agent_fixtures.py, Parts.frames).

import { describe, expect, test } from "vitest";

import { SINGLE_ARM_POSE_FORMAT, WRIST_CAMERA } from "../../src/agent/formats";
import { JPEG_QUALITY, ObservationMessage } from "../../src/agent/messages";
import type { ActionFormat, Camera, Observation } from "../../src/agent/robot";
import { CAMERA_NAMES } from "../../src/protocol/types";
import { expectOutcome, outcomeOf } from "./client_scenarios";
import { loadFixture, type RecordedOutcome } from "./fixtures";
import { frameBytes } from "./stand_ins";

interface Messages {
  jpeg_quality: number;
  cameras: Record<string, Camera[]>;
  cases: Array<{
    format: string;
    roles: string[];
    captured: number;
    received: Record<string, number>;
    attempt_id: string;
    references?: number;
    uuids: string[];
    outcome: RecordedOutcome;
  }>;
}

const messages = loadFixture<Messages>("messages.json");
const state = { arm: { x: 22.7, y: 0.8, z: 20.8, pitch: 0.69, roll: -1.66 }, gripper: { width: 6.0 } };

/** Returns the format of a case: the SO-101's own, or one with another robot's cameras and no text of its own. */
function formatOf(name: string): ActionFormat {
  return name === SINGLE_ARM_POSE_FORMAT.name
    ? SINGLE_ARM_POSE_FORMAT
    : { ...SINGLE_ARM_POSE_FORMAT, name, cameras: messages.cameras[name]!, turnText: () => "state" };
}

describe("ObservationMessage.build", () => {
  test("the SO-101's camera and the JPEG quality are PEAR's", () => {
    expect(SINGLE_ARM_POSE_FORMAT.cameras).toEqual(messages.cameras[SINGLE_ARM_POSE_FORMAT.name]);
    expect(SINGLE_ARM_POSE_FORMAT.cameras.map((camera) => camera.name)).toEqual([...CAMERA_NAMES]);
    expect(SINGLE_ARM_POSE_FORMAT.cameras).toEqual([WRIST_CAMERA]);
    expect(JPEG_QUALITY).toBe(messages.jpeg_quality);
  });

  test.each(messages.cases.map((item, index) => [index, item.format, item] as const))(
    "case %i (%s): the frames of the turn are PEAR's",
    async (_index, _format, item) => {
      const observation = {
        observationId: "observation",
        sessionId: "session",
        capturedMonotonicS: item.captured,
        jointPositions: [],
        images: Object.fromEntries(item.roles.map((role) => [role, frameBytes("observation", role)])),
        cameraTimestamps: Object.fromEntries(
          Object.entries(item.received).map(([role, time]) => [role, { receivedMonotonicS: time, frameNumber: 3 }]),
        ),
        controlSnapshot: {},
      } satisfies Observation;
      const references = Array.from({ length: item.references ?? 0 }, (_unused, index) => ({
        bytes: frameBytes("goal", String(index)),
        uuid: `reference-${index}`,
      }));
      const uuids = [...item.uuids];
      let drawn = 0;

      const draw = (): string => {
        drawn += 1;
        return uuids.shift() ?? "no UUID left";
      };

      const outcome = await outcomeOf(() => {
        const format = formatOf(item.format);
        const input = ObservationMessage.build(observation, state, format, item.attempt_id, null, references, draw);

        // every frame is the observation's own, under its camera's role
        const cameras = formatOf(item.format).cameras;
        expect(input.images.map((image) => image.bytes)).toEqual(
          cameras.map((camera) => observation.images[camera.role]),
        );

        return {
          images: input.images.map((image) => ({
            camera_name: image.cameraName,
            uuid: image.uuid,
            name: image.name,
            is_jpeg: image.bytes[0] === 0xff && image.bytes[1] === 0xd8,
          })),
          reference_images: input.referenceImages.map((image) => image.uuid),
        };
      });

      expectOutcome(outcome, item.outcome);
      expect(drawn, "UUIDs drawn").toBe(item.uuids.length);
    },
  );

  test("a frame that is no JPEG is refused", () => {
    const observation: Observation = {
      observationId: "observation",
      sessionId: "session",
      capturedMonotonicS: 1,
      jointPositions: [],
      images: { wrist: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]) },
      cameraTimestamps: { wrist: { receivedMonotonicS: 0 } },
      controlSnapshot: {},
    };

    expect(() => ObservationMessage.build(observation, state, SINGLE_ARM_POSE_FORMAT, "turn", null, [])).toThrow(
      "Expected a JPEG image from the wrist camera",
    );
  });
});
