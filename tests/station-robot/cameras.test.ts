// The cameras when calls overlap: reads at once, a read while a close is pending, a reader replaced while a read is
// under way, a frame reader that reuses its buffer.
//
// PEAR's CameraFeed (control/cameras.py) holds one `threading.Lock` over the whole of each `read`, `read_preview`,
// `set_reader` and `close`: the reader is never read twice at once, it closes and is replaced only between reads,
// and a call that arrives meanwhile blocks until the lock is free and then meets the feed as the call before left
// it. PEAR's WristCamera (robots/so101/hardware/cameras.py) takes the latest frame and its stamp under lerobot's
// frame lock, checks them, and hands on `frame.copy()`: each read's frame is an array of its own. PEAR's robot
// (control/robot.py, `observe`) stops its control loop and raises again when its cameras' read raises.
//
// These are expectations written by hand: no record of PEAR holds calls that overlap. What PEAR does was run on
// PEAR's own CameraFeed and WristCamera, with threads and readers that hold a read or a close until they are let
// go, and the rows below are that run's:
//
//   a  a read and a preview at once            the reader is read once at a time; both get its frames
//   a2 the first of two reads raises           the second gets the reader's frames
//   b  a read and a preview, a close pending   the close returns; both raise RuntimeError: Camera unavailable: no
//                                              camera reader is open; the reader is not read
//   c  a read, a close that raises pending     the close raises; the read gets the reader's frames; the reader stays
//   d  a reader set, a read under way          the feed's reader is the old one until the read ends; the read gets
//                                              the old reader's frames, the next one the new reader's
//   e  a reader set, a close pending           the old reader is closed, and the new one is the feed's reader
//   f  a close, a read under way               the reader closes after the read, which gets its frames
//   g  two closes at once                      the reader is closed once
//   h  no reader                               read and preview raise the RuntimeError of b; close returns
//   w  the wrist camera, its reader's buffer   a read's frame is not the reader's array, and two reads of one frame
//      a 2 x 3 x 3 uint8 array filled with 1   give two arrays (frame number 1 both); after the reader wrote 2 into
//                                              its array the frames read hold 1 and the next read holds 2 (number
//                                              2); 7 written into the first read's frame is in no other array
//
// PEAR's lock promises no order among the calls that wait for it; here they take their turns in the order they
// were made, which is one of PEAR's orders. The rows that say so are marked "the port's order".

import { describe, expect, test } from "vitest";

import { OSError } from "../../src/python/errors";
import { WristCamera, type WristFrameReader } from "../../src/so101/hardware/cameras";
import { CameraFeed, CameraSource, type CameraPreview } from "../../src/station/cameras";
import type { MonotonicClock } from "../../src/station/joint/clock";
import { handRig, turns } from "./by_hand";

const NO_READER = "raised RuntimeError: Camera unavailable: no camera reader is open";

/** What a held call waits for. */
class Gate {
  open!: () => void;
  readonly passed = new Promise<void>((resolve) => {
    this.open = resolve;
  });
}

/** A camera reader whose frame is its name, and whose reads and closes last until a test lets them go. */
class HeldReader extends CameraSource<string> {
  holdRead: Gate | null = null;
  holdClose: Gate | null = null;
  readRaises = false;
  closeRaises = false;
  /** How many reads are under way, and the most there were at once. */
  inside = 0;
  most = 0;

  constructor(
    readonly name: string,
    private readonly log: string[],
  ) {
    super();
  }

  override async readPreview(): Promise<CameraPreview<string>> {
    this.inside += 1;
    this.most = Math.max(this.most, this.inside);
    this.log.push(`${this.name}.read begins`);
    await this.holdRead?.passed;
    this.log.push(`${this.name}.read ends`);
    this.inside -= 1;
    if (this.readRaises) {
      this.readRaises = false;
      throw new OSError("the camera did not read");
    }

    return [{ wrist: { rgb: this.name, received_monotonic_s: 0.0, frame_number: 1 } }, {}];
  }

  override async close(): Promise<void> {
    this.log.push(`${this.name}.close begins`);
    await this.holdClose?.passed;
    this.log.push(`${this.name}.close ends`);
    if (this.closeRaises) {
      throw new OSError("the camera did not close");
    }
  }
}

/** A call of the feed that was made and has not been awaited: how it ends, and whether it has ended. */
interface Call {
  ended: Promise<string>;
  isOver: boolean;
}

/** Makes `call` now. It ends as the run of PEAR's feed printed it: whose frames it got, or what it raised. */
function start(call: () => Promise<unknown>): Call {
  const made: Call = { isOver: false, ended: Promise.resolve("") };
  made.ended = (async () => {
    try {
      const value = await call();
      if (Array.isArray(value)) {
        return `preview of ${(value as CameraPreview<string>)[0]["wrist"]!.rgb}`;
      }
      return value === undefined ? "returned" : `frames of ${(value as Record<string, { rgb: string }>)["wrist"]!.rgb}`;
    } catch (error) {
      return `raised ${(error as Error).name}: ${(error as Error).message}`;
    } finally {
      made.isOver = true;
    }
  })();

  return made;
}

const nameOf = (reader: CameraSource<string> | null): string | null => (reader as HeldReader | null)?.name ?? null;

describe("the camera feed when calls overlap, as PEAR's lock has them (expectations written by hand)", () => {
  test("a: a read and a preview at once read the reader one after the other", async () => {
    const log: string[] = [];
    const a = new HeldReader("A", log);
    a.holdRead = new Gate();
    const feed = new CameraFeed(a);

    const first = start(() => feed.read());
    const second = start(() => feed.readPreview());
    await turns(3);
    expect([log, a.most, first.isOver, second.isOver]).toEqual([["A.read begins"], 1, false, false]);

    a.holdRead.open();
    expect([await first.ended, await second.ended]).toEqual(["frames of A", "preview of A"]);
    expect(log).toEqual(["A.read begins", "A.read ends", "A.read begins", "A.read ends"]);
    expect(a.most).toBe(1);
  });

  test("a: three reads at once never read the reader twice at once", async () => {
    const log: string[] = [];
    const a = new HeldReader("A", log);
    a.holdRead = new Gate();
    const feed = new CameraFeed(a);

    const reads = [start(() => feed.read()), start(() => feed.read()), start(() => feed.read())];
    await turns(3);
    expect([log.length, a.most]).toEqual([1, 1]);
    a.holdRead.open();
    expect(await Promise.all(reads.map((read) => read.ended))).toEqual(["frames of A", "frames of A", "frames of A"]);
    expect([log.length, a.most]).toEqual([6, 1]);
  });

  test("a2: a read that raises does not fail the read that waited for it", async () => {
    const log: string[] = [];
    const a = new HeldReader("A", log);
    a.holdRead = new Gate();
    a.readRaises = true;
    const feed = new CameraFeed(a);

    const first = start(() => feed.read());
    const second = start(() => feed.read());
    a.holdRead.open();
    expect([await first.ended, await second.ended, a.most]).toEqual([
      "raised OSError: the camera did not read",
      "frames of A",
      1,
    ]);
  });

  test("b: a read and a preview made while a close is pending find no reader, and the reader is not read", async () => {
    const log: string[] = [];
    const a = new HeldReader("A", log);
    a.holdClose = new Gate();
    const feed = new CameraFeed(a);

    const close = start(() => feed.close());
    const read = start(() => feed.read());
    const preview = start(() => feed.readPreview());
    await turns(3);
    expect([log, nameOf(feed.reader), read.isOver, preview.isOver]).toEqual([["A.close begins"], "A", false, false]);

    a.holdClose.open();
    expect([await close.ended, await read.ended, await preview.ended]).toEqual(["returned", NO_READER, NO_READER]);
    expect([log, feed.reader]).toEqual([["A.close begins", "A.close ends"], null]);
  });

  test("c: a read made while a close that raises is pending reads the reader, which stays", async () => {
    const log: string[] = [];
    const a = new HeldReader("A", log);
    a.holdClose = new Gate();
    a.closeRaises = true;
    const feed = new CameraFeed(a);

    const close = start(() => feed.close());
    const read = start(() => feed.read());
    await turns(3);
    expect([log, read.isOver]).toEqual([["A.close begins"], false]);

    a.holdClose.open();
    expect([await close.ended, await read.ended]).toEqual(["raised OSError: the camera did not close", "frames of A"]);
    expect([log, nameOf(feed.reader)]).toEqual([["A.close begins", "A.close ends", "A.read begins", "A.read ends"], "A"]);
  });

  test("d: a reader set while a read is under way is the feed's reader once the read has ended", async () => {
    const log: string[] = [];
    const a = new HeldReader("A", log);
    const b = new HeldReader("B", log);
    a.holdRead = new Gate();
    const feed = new CameraFeed(a);

    const read = start(() => feed.read());
    const set = start(() => feed.setReader(b));
    await turns(3);
    expect([nameOf(feed.reader), set.isOver, read.isOver]).toEqual(["A", false, false]);

    a.holdRead.open();
    expect([await read.ended, await set.ended, nameOf(feed.reader)]).toEqual(["frames of A", "returned", "B"]);
    expect(await start(() => feed.read()).ended).toBe("frames of B");
    expect(log).toEqual(["A.read begins", "A.read ends", "B.read begins", "B.read ends"]);
  });

  test("e: a reader set while a close is pending is the feed's reader after the close", async () => {
    const log: string[] = [];
    const a = new HeldReader("A", log);
    const b = new HeldReader("B", log);
    a.holdClose = new Gate();
    const feed = new CameraFeed(a);

    const close = start(() => feed.close());
    const set = start(() => feed.setReader(b));
    await turns(3);
    expect([nameOf(feed.reader), set.isOver]).toEqual(["A", false]);

    a.holdClose.open();
    expect([await close.ended, await set.ended, nameOf(feed.reader)]).toEqual(["returned", "returned", "B"]);
    expect(await start(() => feed.read()).ended).toBe("frames of B");
    expect(log).toEqual(["A.close begins", "A.close ends", "B.read begins", "B.read ends"]);
  });

  test("f: a close made while a read is under way closes the reader after the read", async () => {
    const log: string[] = [];
    const a = new HeldReader("A", log);
    a.holdRead = new Gate();
    const feed = new CameraFeed(a);

    const read = start(() => feed.read());
    const close = start(() => feed.close());
    await turns(3);
    expect([log, nameOf(feed.reader), close.isOver]).toEqual([["A.read begins"], "A", false]);

    a.holdRead.open();
    expect([await read.ended, await close.ended, feed.reader]).toEqual(["frames of A", "returned", null]);
    expect(log).toEqual(["A.read begins", "A.read ends", "A.close begins", "A.close ends"]);
  });

  test("g: two closes at once close the reader once", async () => {
    const log: string[] = [];
    const a = new HeldReader("A", log);
    a.holdClose = new Gate();
    const feed = new CameraFeed(a);

    const closes = [start(() => feed.close()), start(() => feed.close())];
    await turns(3);
    a.holdClose.open();
    expect(await Promise.all(closes.map((close) => close.ended))).toEqual(["returned", "returned"]);
    expect([log, feed.reader]).toEqual([["A.close begins", "A.close ends"], null]);
  });

  test("h: without a reader a read and a preview are refused when their turn comes, and a close returns", async () => {
    const feed = new CameraFeed<string>(null);
    // (the refusal is the call's outcome: a page that awaits the read gets it, and the call itself does not throw)
    const calls: Promise<unknown>[] = [];
    expect(() => calls.push(feed.read(), feed.readPreview())).not.toThrow();
    expect(await Promise.all(calls.map((call) => start(() => call).ended))).toEqual([NO_READER, NO_READER]);
    expect(await start(() => feed.close()).ended).toBe("returned");
  });

  test("the port's order: reads, a new reader and a close made at once take their turns as they were made", async () => {
    const log: string[] = [];
    const a = new HeldReader("A", log);
    const b = new HeldReader("B", log);
    a.holdRead = new Gate();
    const feed = new CameraFeed(a);

    const calls = [
      start(() => feed.read()),
      start(() => feed.read()),
      start(() => feed.setReader(b)),
      start(() => feed.readPreview()),
      start(() => feed.close()),
      start(() => feed.read()),
    ];
    await turns(3);
    expect([log, nameOf(feed.reader)]).toEqual([["A.read begins"], "A"]);

    a.holdRead.open();
    expect(await Promise.all(calls.map((call) => call.ended))).toEqual([
      "frames of A",
      "frames of A",
      "returned",
      "preview of B",
      "returned",
      NO_READER,
    ]);
    expect(log).toEqual([
      "A.read begins",
      "A.read ends",
      "A.read begins",
      "A.read ends",
      "B.read begins",
      "B.read ends",
      "B.close begins",
      "B.close ends",
    ]);
    expect(feed.reader).toBe(null);
  });
});

/** A wrist camera's frame reader that writes every frame into one array, as a capture that reuses its buffer. */
class ReusingReader<Pixels extends Uint8Array | Uint8ClampedArray> implements WristFrameReader<Pixels> {
  readonly isReading = true;
  readonly isConnected = true;
  latestFrame: Pixels | null = null;
  latestTimestamp: number | null = null;

  constructor(
    readonly buffer: Pixels,
    private readonly clock: Pick<MonotonicClock, "monotonic">,
  ) {}

  /** The next frame arrives: `value` in every pixel of the one array. */
  capture(value: number): void {
    this.buffer.fill(value);
    this.latestFrame = this.buffer;
    this.latestTimestamp = this.clock.monotonic();
  }

  disconnect(): void {}
}

const CAMERA_CONFIG = { camera: { role: "wrist" } as never };

describe("the wrist camera over a frame reader that reuses its buffer (expectations written by hand)", () => {
  test("w: a frame read is an array of its own, which neither the next frame nor a holder's write changes", async () => {
    const clock = { now: 100.0, monotonic: (): number => clock.now };
    const reader = new ReusingReader(new Uint8Array(2 * 3 * 3), clock);
    const wrist = new WristCamera<Uint8Array>(CAMERA_CONFIG, reader, { clock });

    reader.capture(1);
    const first = (await wrist.readPreview())[0]["wrist"]!;
    const again = (await wrist.readPreview())[0]["wrist"]!;
    expect(first.rgb).not.toBe(reader.buffer);
    expect(again.rgb).not.toBe(first.rgb);
    expect([first.frame_number, again.frame_number]).toEqual([1, 1]);
    expect(first.rgb).toEqual(new Uint8Array(18).fill(1));
    expect(first.rgb).toBeInstanceOf(Uint8Array);

    clock.now += 0.05;
    reader.capture(2);
    const second = (await wrist.readPreview())[0]["wrist"]!;
    expect([first.rgb[0], again.rgb[0], second.rgb[0], second.frame_number]).toEqual([1, 1, 2, 2]);
    expect([...first.rgb]).toEqual(new Array(18).fill(1));

    first.rgb.fill(7);
    expect([reader.buffer[0], again.rgb[0], second.rgb[0]]).toEqual([2, 1, 2]);
  });

  test("w: `read` hands on the same copy as the preview", async () => {
    const clock = { now: 100.0, monotonic: (): number => clock.now };
    const reader = new ReusingReader(new Uint8Array(2 * 3 * 3), clock);
    const wrist = new WristCamera<Uint8Array>(CAMERA_CONFIG, reader, { clock });

    reader.capture(1);
    const frame = (await wrist.read())["wrist"]!;
    reader.capture(2);
    expect([frame.rgb === reader.buffer, frame.rgb[0], frame.rgb[17], reader.buffer[0]]).toEqual([false, 1, 1, 2]);
  });

  test("the copy is of the frame's own kind and holds the frame's own pixels (a page's pixels are clamped bytes)", async () => {
    const clock = { now: 100.0, monotonic: (): number => clock.now };
    // a frame that is a part of a larger buffer, as a capture into a pool gives
    const pool = new Uint8ClampedArray(40).fill(9);
    const reader = new ReusingReader(pool.subarray(4, 22), clock);
    const wrist = new WristCamera<Uint8ClampedArray>(CAMERA_CONFIG, reader, { clock });

    reader.capture(3);
    const frame = (await wrist.readPreview())[0]["wrist"]!;
    expect(frame.rgb).toBeInstanceOf(Uint8ClampedArray);
    expect([frame.rgb.length, frame.rgb.byteLength, frame.rgb.buffer === pool.buffer]).toEqual([18, 18, false]);
    pool.fill(5);
    expect([...frame.rgb]).toEqual(new Array(18).fill(3));
  });

  test("a reader that copies its frames itself is asked for each read's copy, and a frame that is no array of bytes is handed on as it is", async () => {
    const clock = { now: 100.0, monotonic: (): number => clock.now };
    // (a page's frame may be an object of the browser's that only the page can copy)
    interface Picture {
      pixels: number[];
    }
    const picture: Picture = { pixels: [1, 1] };
    const copies: Picture[] = [];
    const base = { isReading: true, isConnected: true, latestFrame: picture, latestTimestamp: 100.0, disconnect: (): void => undefined };
    const copying: WristFrameReader<Picture> = {
      ...base,
      copyFrame(frame: Picture): Picture {
        copies.push(frame);
        return { pixels: [...frame.pixels] };
      },
    };

    const copied = (await new WristCamera<Picture>(CAMERA_CONFIG, copying, { clock }).readPreview())[0]["wrist"]!;
    expect([copies.length, copies[0] === picture, copied.rgb === picture, copied.rgb]).toEqual([1, true, false, { pixels: [1, 1] }]);
    picture.pixels[0] = 2;
    expect(copied.rgb.pixels).toEqual([1, 1]);

    const asItIs = (await new WristCamera<Picture>(CAMERA_CONFIG, base, { clock }).readPreview())[0]["wrist"]!;
    expect(asItIs.rgb).toBe(picture);
  });
});

describe("the robot's observations over the feed (expectations written by hand)", () => {
  test("w: an observation's frame is not changed by the frames the reader captures after it", async () => {
    let reader!: ReusingReader<Uint8Array>;
    const rig = await handRig({
      cameras: (clock) => {
        reader = new ReusingReader(new Uint8Array(2 * 3 * 3), clock);
        return new CameraFeed(new WristCamera<Uint8Array>(CAMERA_CONFIG, reader, { clock }));
      },
    });

    reader.capture(1);
    const first = await rig.robot.observe();
    rig.clock.now += 0.05; // (a frame is counted by its stamp)
    reader.capture(2);
    const second = await rig.robot.observe();
    const pixels = (observation: typeof first): number[] => [...(observation.images["wrist"] as Uint8Array)];
    expect(pixels(first)).toEqual(new Array(18).fill(1));
    expect(pixels(second)).toEqual(new Array(18).fill(2));
    expect([first.camera_timestamps["wrist"]!["frame_number"], second.camera_timestamps["wrist"]!["frame_number"]]).toEqual([1, 2]);
    await rig.robot.close();
  });

  test("b: an observation made while the feed's close is pending is refused, and the robot is stopped (PEAR's `observe`)", async () => {
    const log: string[] = [];
    const a = new HeldReader("A", log);
    a.holdClose = new Gate();
    const feed = new CameraFeed(a);
    const rig = await handRig({ cameras: () => feed });
    const generation = rig.robot.controlLoop.snapshot().generation;

    const close = start(() => feed.close());
    const observation = start(() => rig.robot.observe());
    await turns(3);
    expect([log, observation.isOver]).toEqual([["A.close begins"], false]);

    a.holdClose.open();
    expect([await close.ended, await observation.ended]).toEqual(["returned", NO_READER]);
    expect(log).toEqual(["A.close begins", "A.close ends"]);
    // PEAR's robot stops its control loop when the cameras' read raises: from a hold, the stop ends the generation
    expect(rig.robot.controlLoop.snapshot().generation).toBe(generation + 1);
    await rig.robot.close();
  });

  test("d: an observation under way when the reader is replaced holds the old reader's frame, the next one the new reader's", async () => {
    const log: string[] = [];
    const a = new HeldReader("A", log);
    const b = new HeldReader("B", log);
    a.holdRead = new Gate();
    const feed = new CameraFeed(a);
    const rig = await handRig({ cameras: () => feed });

    const under = rig.robot.observe();
    await turns(3);
    const set = start(() => feed.setReader(b));
    await turns(3);
    expect([log, nameOf(feed.reader), set.isOver]).toEqual([["A.read begins"], "A", false]);

    a.holdRead.open();
    expect((await under).images).toEqual({ wrist: "A" });
    expect(await set.ended).toBe("returned");
    expect((await rig.robot.observe()).images).toEqual({ wrist: "B" });
    await rig.robot.close();
  });
});
