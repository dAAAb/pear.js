// Ports ObservationMessage.build of pear/deploy/station/agent_loop/messages.py beyond its text: which frames a turn
// carries, in what order and under what names, and the check of their times. (The text is the format's turnText,
// in src/protocol; SystemPrompt.render is src/protocol's systemPrompt.)
//
// PEAR saves each frame as "<attempt id>-<camera name>.jpg" in the task's folder, JPEG at quality 90, and a turn
// carries the file. Here a frame is already JPEG bytes and the turn carries them, under the name of PEAR's file.

import { PythonError } from "../protocol/python_json";
import { pythonStringRepr } from "./clients/python_repr";
import { modelInput, type CameraImage, type ModelInput, type ReferenceImage } from "./clients/schemas";
import { ValueError } from "./exceptions";
import type { ActionFormat, Observation } from "./robot";

/** The JPEG quality of every image a model is sent: a turn's camera frames and a task's reference images. Whoever
 * encodes a frame for the loop uses it. */
export const JPEG_QUALITY = 90;

/** Returns a new UUID, as text (str(uuid4())). */
export function uuid4(): string {
  return globalThis.crypto.randomUUID();
}

/** Returns what an observation holds of the camera ``role``; an observation without it raises Python's KeyError,
 * whose text is the role in quotes. */
function roleItem<T>(items: Readonly<Record<string, T>>, role: string): T {
  if (!Object.hasOwn(items, role)) {
    throw new PythonError("KeyError", pythonStringRepr(role), false);
  }

  return items[role]!;
}

/** What the model is shown each turn: the measured state, the last action's result and the camera frames. */
export const ObservationMessage = {
  /**
   * Returns the turn's text and images for the model: one frame of each camera of the format, in the format's
   * order, each under its camera's name and a new UUID from ``uuid``.
   */
  build<State, Action>(
    observation: Observation,
    state: State,
    actionFormat: ActionFormat<State, Action>,
    attemptId: string,
    feedback: string | null,
    referenceImages: readonly ReferenceImage[],
    uuid: () => string = uuid4,
  ): ModelInput {
    const text = actionFormat.turnText(state, feedback);

    const cameraImages: CameraImage[] = [];
    for (const camera of actionFormat.cameras) {
      const bytes = roleItem(observation.images, camera.role);
      // (PEAR's check is of an RGB array: "Expected a uint8 RGB image from the ... camera")
      if (!(bytes instanceof Uint8Array) || bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        throw new ValueError(`Expected a JPEG image from the ${camera.name} camera`);
      }
      const timestamps = roleItem(observation.cameraTimestamps, camera.role);
      if (timestamps.receivedMonotonicS > observation.capturedMonotonicS) {
        throw new ValueError("Image cannot postdate observation capture");
      }
      cameraImages.push({ cameraName: camera.name, bytes, uuid: uuid(), name: `${attemptId}-${camera.name}.jpg` });
    }

    return modelInput(text, cameraImages, referenceImages);
  },
};
