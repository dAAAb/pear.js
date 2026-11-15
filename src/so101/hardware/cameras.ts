// Ports pear/deploy/station/control/robots/so101/hardware/cameras.py: WristCamera.
//
// PEAR's WristCamera opens the device through lerobot's OpenCVCamera, whose background reader keeps the latest frame
// and when it arrived. pear.js opens no device: the wrist camera is given its frame reader, which is to it what
// lerobot's camera object is to PEAR's (a page captures the frames, a test scripts them). What is ported is every
// check between that reader and the robot: the role, the reader that stopped, the first frame, the age of a frame,
// the numbering of the frames seen, the preview and the close.

import { AttributeError } from "../../python/errors";
import { CameraSource, type CameraPreview } from "../../station/cameras";
import { secondsClock, type MonotonicClock } from "../../station/joint/clock";
import type { Camera } from "../../station/schemas";
import { WRIST_ROLE, type SO101Config } from "../config";

/** The SO-101's one camera, whose role keys its frames. */
export const WRIST_CAMERA: Camera = Object.freeze({ role: WRIST_ROLE, name: "wrist", label: "Wrist Camera" });

/**
 * What captures the wrist camera's frames: what lerobot's OpenCVCamera is to PEAR's WristCamera, once it is
 * connected and its reader runs.
 */
export interface WristFrameReader<Image = unknown> {
  /** Whether the capture runs (lerobot: the camera's reader thread exists and is alive). */
  readonly isReading: boolean;
  /** The latest frame; null before the first. */
  readonly latestFrame: Image | null;
  /** When the latest frame arrived, s on the clock the wrist camera reads; null before the first. */
  readonly latestTimestamp: number | null;
  readonly isConnected: boolean;
  /** Stops the capture and releases the device. */
  disconnect(): void | Promise<void>;
  /** Returns a copy of `frame` that the next capture does not change; without it a frame is handed on as it is
   * (a typed array is copied). */
  copyFrame?(frame: Image): Image;
}

export interface WristCameraOptions {
  /** The clock a frame's age is read on: the one the reader stamps its frames with; the page's by default. */
  clock?: Pick<MonotonicClock, "monotonic">;
}

/** The wrist camera over its frame reader, read as frames with the times they arrived. */
export class WristCamera<Image = unknown> extends CameraSource<Image> {
  /** The SO-101's one camera, whose role keys its frames. */
  static readonly CAMERA: Camera = WRIST_CAMERA;
  /** The longest wait for the first frame, ms: what a frame reader gives the device when it starts. */
  static readonly START_TIMEOUT_MS: number = 2000;

  /** What its frames are keyed by. */
  readonly role: string;
  readonly camera: WristFrameReader<Image>;
  private readonly clock: Pick<MonotonicClock, "monotonic">;
  /** Of the last frame counted. */
  private lastFrameStamp: number | null = null;
  /** Of the different frames seen. */
  private frameCount = 0;

  constructor(robotConfig: Pick<SO101Config, "camera">, camera: WristFrameReader<Image>, options: WristCameraOptions = {}) {
    super();
    if (robotConfig.camera === null) {
      throw new AttributeError("'NoneType' object has no attribute 'role'");
    }
    this.role = robotConfig.camera.role;
    this.camera = camera;
    this.clock = options.clock ?? secondsClock();
  }

  /** Returns the latest fresh frame and, when there is none, why. */
  override async readPreview(): Promise<CameraPreview<Image>> {
    const { camera, role } = this;
    if (!camera.isReading) {
      return [{}, { [role]: "Camera reader stopped; reconnect the camera" }];
    }

    const frame = camera.latestFrame;
    const stamp = camera.latestTimestamp;
    if (frame === null || stamp === null) {
      return [{}, { [role]: "Waiting for camera frames" }];
    }
    if (this.clock.monotonic() - stamp > WristCamera.MAX_AGE_S) {
      return [{}, { [role]: "Camera frame is stale" }];
    }

    if (stamp !== this.lastFrameStamp) {
      this.lastFrameStamp = stamp;
      this.frameCount += 1;
    }
    // the frame, with its stamp and its number among the frames seen
    return [{ [role]: { rgb: this.copied(frame), received_monotonic_s: stamp, frame_number: this.frameCount } }, {}];
  }

  /** Disconnects the camera. */
  override async close(): Promise<void> {
    if (this.camera.isConnected) {
      await this.camera.disconnect();
    }
  }

  private copied(frame: Image): Image {
    if (this.camera.copyFrame !== undefined) {
      return this.camera.copyFrame(frame);
    }
    if (ArrayBuffer.isView(frame) && !(frame instanceof DataView)) {
      return (frame as unknown as { slice(): Image }).slice();
    }

    return frame;
  }
}
