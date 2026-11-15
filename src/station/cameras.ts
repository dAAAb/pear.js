// Ports pear/deploy/station/control/cameras.py: CameraSource and CameraFeed.
//
// A read of a camera is asynchronous here (PEAR's blocks its thread on the reader's lock, and a page may have to
// wait for a frame's pixels), and so is a close. PEAR's CameraFeed holds a threading.Lock over each read so that a
// reader closes only between reads; here the same calls take turns on a queue.

import { pythonRepr, pythonValueOf } from "../python/repr";
import { RuntimeError } from "./joint/errors";
import type { CameraFrame } from "./schemas";

/** A read's frames by camera role, and for each role without a fresh frame, why. */
export type CameraPreview<Image = unknown> = [frames: Record<string, CameraFrame<Image>>, errors: Record<string, string>];

/** A robot's cameras, as the robot observes them and the page previews and records them. */
export abstract class CameraSource<Image = unknown> {
  /** The age past which a frame is stale, s. */
  static readonly MAX_AGE_S: number = 0.2;

  /** Returns one fresh frame of each camera role, and throws when a camera has none. */
  async read(): Promise<Record<string, CameraFrame<Image>>> {
    const [frames, errors] = await this.readPreview();
    if (Object.keys(errors).length > 0) {
      throw new RuntimeError(`Camera unavailable: ${pythonRepr(pythonValueOf(errors))}`);
    }

    return frames;
  }

  /** Returns the latest fresh frames and, for each role without one, why. */
  abstract readPreview(): Promise<CameraPreview<Image>>;

  /** Stops the cameras. */
  abstract close(): Promise<void>;
}

/** The one camera source that the robot, the preview and the recordings read while its reader is replaced. */
export class CameraFeed<Image = unknown> extends CameraSource<Image> {
  /** The camera reader every read goes to; null while closed. */
  reader: CameraSource<Image> | null;
  /** The call that holds the feed, which the next one follows: each read holds it, so a reader closes only between
   * reads (PEAR's lock). */
  private turn: Promise<unknown> = Promise.resolve();

  constructor(reader: CameraSource<Image> | null) {
    super();
    this.reader = reader;
  }

  /** Returns one fresh frame of each camera role, all from the current reader. */
  override read(): Promise<Record<string, CameraFrame<Image>>> {
    return this.locked(() => this.requireReader().read());
  }

  /** Returns the current reader's latest frames and, for each role without one, why. */
  override readPreview(): Promise<CameraPreview<Image>> {
    return this.locked(() => this.requireReader().readPreview());
  }

  /** Reads from `reader` from now on: after the read in progress. */
  setReader(reader: CameraSource<Image>): Promise<void> {
    return this.locked(() => {
      this.reader = reader;
    });
  }

  /** Closes the current reader after the read in progress; one that fails to close is closed again later. */
  override close(): Promise<void> {
    return this.locked(async () => {
      if (this.reader !== null) {
        await this.reader.close();
        this.reader = null;
      }
    });
  }

  /** Returns the current reader, and throws while there is none. */
  private requireReader(): CameraSource<Image> {
    if (this.reader === null) {
      throw new RuntimeError("Camera unavailable: no camera reader is open");
    }

    return this.reader;
  }

  /** Runs `block` once every earlier call of the feed has ended, and returns what it returns. */
  private locked<Result>(block: () => Result | Promise<Result>): Promise<Result> {
    const result = this.turn.then(block);
    this.turn = result.catch(() => undefined);

    return result;
  }
}
