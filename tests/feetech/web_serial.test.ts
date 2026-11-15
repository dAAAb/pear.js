// The Web Serial transport where a port does not simply work: a page that does not run while a read waits, a
// port that is closed, unplugged or fails, a line that has errors the port survives, and closing a transport on
// a port that is already gone. No browser and no device: the streams' behaviour, on Node's event loop.

import { describe, expect, test } from "vitest";

import { FeetechCommError, FeetechMotorsBus } from "../../src/feetech/bus";
import { readPacket } from "../../src/feetech/protocol";
import { SerialException, type SerialPortLike, WebSerialTransport } from "../../src/feetech/transport";
import { ConnectionError, OSError, pythonErrorName } from "../../src/python/errors";
import { followerMotors } from "../../src/so101/hardware/motors";

/** A serial port of the Web Serial API's shape whose far end the test holds: what the page wrote, a way to make
 * bytes arrive, and the ways a port stops working. */
function fakeSerialPort(): {
  port: SerialPortLike;
  written: number[][];
  arrive: (bytes: number[]) => void;
  end: () => void;
  fail: (error: unknown) => void;
  refuseWrites: (error: unknown) => void;
} {
  const written: number[][] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let readable: ReadableStream<Uint8Array> | null = null;
  let writable: WritableStream<Uint8Array> | null = null;
  let writeFailure: unknown = null;

  const port: SerialPortLike = {
    get readable() {
      return readable;
    },
    get writable() {
      return writable;
    },
    async open() {
      readable = new ReadableStream<Uint8Array>({
        start(started) {
          controller = started;
        },
      });
      writable = new WritableStream<Uint8Array>({
        write(chunk) {
          if (writeFailure !== null) throw writeFailure;
          written.push(Array.from(chunk));
        },
      });
    },
    async close() {},
  };

  return {
    port,
    written,
    arrive: (bytes) => controller?.enqueue(Uint8Array.from(bytes)),
    end: () => controller?.close(), // the stream ends, as when the port is closed under the page
    fail: (error) => controller?.error(error), // the stream fails, as when the device is unplugged
    refuseWrites: (error) => {
      writeFailure = error;
    },
  };
}

/** Keeps the thread busy for ``ms``: nothing of the event loop runs, as in a page that is busy. */
function stall(ms: number): void {
  const resumeAt = performance.now() + ms;
  while (performance.now() < resumeAt);
}

const turn = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// When the page runs again after a pause, the timer of a read that waits and the bytes the port received
// meanwhile are both due, and the timer can be the first of the two. Node runs the timers that are due in the
// order of their times: the port's delivery is given the later time, so that the read's timer runs first and the
// bytes come right behind it, in the same turn of the event loop.
describe("a page that does not run while a read waits", () => {
  test("the bytes that are due with the read's timer are read", async () => {
    const { port, arrive } = fakeSerialPort();
    const transport = await WebSerialTransport.open(port);

    const reading = transport.read(6, 20);
    setTimeout(() => arrive([1, 2, 3]), 30);
    stall(80);
    expect(Array.from(await reading)).toEqual([1, 2, 3]);

    // a read that gets nothing still ends, and one that only looks takes no turn of the event loop
    expect(Array.from(await transport.read(6, 5))).toEqual([]);
    let hasTurned = false;
    setTimeout(() => {
      hasTurned = true;
    }, 0);
    expect(Array.from(await transport.read(6, 0))).toEqual([]);
    expect(hasTurned).toBe(false);
    await transport.close();
  });

  test("the bus takes the answer that came during the pause, and asks once", async () => {
    const { port, written, arrive } = fakeSerialPort();
    const transport = await WebSerialTransport.open(port);
    const bus = new FeetechMotorsBus(transport, followerMotors());
    await bus.connect(false);

    const reading = bus.read("Present_Position", "gripper", { normalize: false }); // 50.11 ms for its answer
    await turn(1);
    expect(written).toEqual([Array.from(readPacket(6, 56, 2))]);
    setTimeout(() => arrive([0xff, 0xff, 6, 4, 0, 0x34, 0x08, 0xb9]), 70);
    stall(150);
    expect(await reading).toBe(0x0834);
    expect(written.length).toBe(1);

    await bus.disconnect(false);
  });
});

// pyserial 3.5: SerialException's classes are SerialException, OSError, Exception, BaseException, object
describe("a port that is closed, unplugged or fails", () => {
  test("a port that was closed: what came before is read, then pyserial's SerialException, an OSError", async () => {
    const { port, arrive, end } = fakeSerialPort();
    const transport = await WebSerialTransport.open(port);
    arrive([7, 8]);
    end();
    expect(Array.from(await transport.read(6, 50))).toEqual([7, 8]);

    const failure: unknown = await transport.read(6, 50).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SerialException);
    expect(failure).toBeInstanceOf(OSError);
    expect(failure).not.toBeInstanceOf(ConnectionError);
    expect([(failure as Error).name, pythonErrorName(failure), (failure as Error).message]).toEqual([
      "SerialException",
      "SerialException",
      "The serial port was closed",
    ]);
    await expect(transport.read(6, 0)).rejects.toBe(failure); // a read that only looks finds it too
  });

  test("a device that is lost while a read waits: the browser's message, and its error as the cause", async () => {
    const { port, fail } = fakeSerialPort();
    const transport = await WebSerialTransport.open(port);
    const lost = new DOMException("The device has been lost.", "NetworkError");

    const waiting = transport.read(6, 1000);
    fail(lost);
    const failure: unknown = await waiting.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SerialException);
    expect([(failure as Error).name, (failure as Error).message]).toEqual(["SerialException", "The device has been lost."]);
    expect((failure as Error).cause).toBe(lost);
  });

  test("a write the port refuses", async () => {
    const { port, refuseWrites } = fakeSerialPort();
    const transport = await WebSerialTransport.open(port);
    const lost = new DOMException("The device has been lost.", "NetworkError");
    refuseWrites(lost);

    const failure: unknown = await transport.write(Uint8Array.from([1])).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SerialException);
    expect([(failure as Error).message, (failure as Error).cause]).toEqual(["The device has been lost.", lost]);
  });

  test("lerobot's connect makes a ConnectionError of it, and a read passes it on", async () => {
    const { port, fail } = fakeSerialPort();
    const transport = await WebSerialTransport.open(port);
    const bus = new FeetechMotorsBus(transport, followerMotors(), null, { port: "the port" });
    fail(new DOMException("The device has been lost.", "NetworkError"));

    // lerobot: except (FileNotFoundError, OSError, serial.SerialException) ... raise ConnectionError
    const refused: unknown = await bus.connect().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(FeetechCommError);
    expect([(refused as Error).name, (refused as Error).message]).toEqual([
      "ConnectionError",
      "\nCould not connect on port 'the port'. Make sure you are using the correct port.\nTry running `lerobot-find-port`\n",
    ]);

    const failure: unknown = await bus.read("Present_Position", "gripper", { normalize: false }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SerialException);
    expect((failure as Error).message).toBe("The device has been lost.");
  });
});

// --- A port of the Web Serial specification's shape: recoverable errors replace the readable stream ---

/** A port that behaves as the Web Serial specification (§4.6 readable) says: a framing error, a parity error, a
 * break or a buffer overrun fails the readable stream and the port offers a new one; a lost device sets a fatal
 * flag and the getter returns null. Modelled on web/src/sim_port.ts (the page's simulated port), without
 * importing from web/. */
function specPort(): {
  port: SerialPortLike;
  written: number[][];
  arrive: (bytes: number[]) => void;
  glitch: (name?: string) => void;
  unplug: () => void;
} {
  const written: number[][] = [];
  let isOpen = false;
  let hasFailed = false;
  let readableStream: ReadableStream<Uint8Array> | null = null;
  let writableStream: WritableStream<Uint8Array> | null = null;
  let readController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let writeFailure: unknown = null;

  const port: SerialPortLike = {
    get readable(): ReadableStream<Uint8Array> | null {
      if (readableStream === null && isOpen && !hasFailed) {
        readableStream = new ReadableStream<Uint8Array>({
          start(controller) {
            readController = controller;
          },
          cancel() {
            readableStream = null;
            readController = null;
          },
        });
      }
      return readableStream;
    },
    get writable(): WritableStream<Uint8Array> | null {
      if (writableStream === null && isOpen && !hasFailed) {
        writableStream = new WritableStream<Uint8Array>({
          write(chunk) {
            if (writeFailure !== null) throw writeFailure;
            written.push(Array.from(chunk));
          },
          abort() {
            writableStream = null;
          },
        });
      }
      return writableStream;
    },
    async open() {
      isOpen = true;
      hasFailed = false;
    },
    async close() {
      if (!isOpen) throw new DOMException("The port is already closed.", "InvalidStateError");
      isOpen = false;
      const r = readableStream;
      const w = writableStream;
      readableStream = null;
      writableStream = null;
      readController = null;
      await r?.cancel().catch(() => undefined);
      await w?.abort(undefined).catch(() => undefined);
    },
  };

  return {
    port,
    written,
    arrive: (bytes) => readController?.enqueue(Uint8Array.from(bytes)),
    glitch: (name = "BreakError") => {
      if (!isOpen) return;
      try {
        readController?.error(new DOMException("The line reported an error.", name));
      } catch {
        // stream already closed
      }
      readableStream = null;
      readController = null;
    },
    unplug: () => {
      if (!isOpen) return;
      isOpen = false;
      hasFailed = true;
      const lost = new DOMException("The device has been lost.", "NetworkError");
      try {
        readController?.error(lost);
      } catch {
        // stream already closed
      }
      writeFailure = lost;
      readableStream = null;
      readController = null;
    },
  };
}

// The Web Serial specification (§4.6 readable, "Handling closing the readable stream"): a recoverable error
// errors the stream and sets [[readable]] to null; the getter creates a new one. A lost device sets
// [[readFatal]] and the getter returns null. The transport tells them apart: port.readable not null and not the
// same stream object → recoverable; null or same → fatal.
describe("a line error the port survives (Web Serial §4.6)", () => {
  test("the transport reads on from the new stream after a glitch, and counts it", async () => {
    const { port, arrive, glitch } = specPort();
    const transport = await WebSerialTransport.open(port);

    arrive([1, 2]);
    expect(Array.from(await transport.read(6, 50))).toEqual([1, 2]);
    expect(transport.lineErrors.count).toBe(0);

    glitch("FramingError");
    await turn(50); // the pump picks up the new stream after its pause

    arrive([3, 4]);
    expect(Array.from(await transport.read(6, 50))).toEqual([3, 4]);
    expect(transport.lineErrors.count).toBe(1);
    expect(transport.lineErrors.lastName).toBe("FramingError");

    await transport.close();
  });

  test("two glitches in a row, then bytes arrive again", async () => {
    const { port, arrive, glitch } = specPort();
    const transport = await WebSerialTransport.open(port);

    arrive([10]);
    expect(Array.from(await transport.read(6, 50))).toEqual([10]);

    glitch("ParityError");
    await turn(50);
    glitch("BreakError");
    await turn(80); // the second pause is longer (errorsInARow = 2 → 40 ms)

    arrive([20, 30]);
    expect(Array.from(await transport.read(6, 50))).toEqual([20, 30]);
    expect(transport.lineErrors.count).toBe(2);

    await transport.close();
  });

  test("a glitch during a read that waits: the read times out, the next read gets the new stream", async () => {
    const { port, arrive, glitch } = specPort();
    const transport = await WebSerialTransport.open(port);

    const waiting = transport.read(6, 30);
    glitch("FramingError");
    expect(Array.from(await waiting)).toEqual([]); // nothing came before the glitch

    await turn(50);
    arrive([5, 6]);
    expect(Array.from(await transport.read(6, 50))).toEqual([5, 6]);
    expect(transport.lineErrors.count).toBe(1);

    await transport.close();
  });

  test("a glitch followed by unplug: the device is lost", async () => {
    const { port, arrive, glitch, unplug } = specPort();
    const transport = await WebSerialTransport.open(port);

    arrive([1]);
    expect(Array.from(await transport.read(6, 50))).toEqual([1]);

    glitch("FramingError");
    await turn(50);
    arrive([2]);
    expect(Array.from(await transport.read(6, 50))).toEqual([2]);

    unplug();
    const failure: unknown = await transport.read(6, 100).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SerialException);
    expect((failure as Error).message).toBe("The device has been lost.");
    expect(transport.lineErrors.count).toBe(1);
  });
});

describe("close() on a port that is already gone", () => {
  test("close() resolves on a lost port (port.close() would throw InvalidStateError)", async () => {
    const { port, unplug } = specPort();
    const transport = await WebSerialTransport.open(port);
    unplug();
    await turn(10);

    // port.close() throws InvalidStateError because the port is no longer open;
    // transport.close() must resolve anyway
    await transport.close(); // must not throw
  });

  test("the bus can disconnect(false) on a lost port", async () => {
    const { port, unplug } = specPort();
    const transport = await WebSerialTransport.open(port);
    const bus = new FeetechMotorsBus(transport, followerMotors());
    await bus.connect(false);

    unplug();
    await turn(10);

    // the page does bus.disconnect(false): no torque write, just close
    await bus.disconnect(false); // must not throw
  });

  test("close() on a port the transport itself closed (double close)", async () => {
    const { port, arrive } = specPort();
    const transport = await WebSerialTransport.open(port);
    arrive([1]);
    expect(Array.from(await transport.read(6, 50))).toEqual([1]);

    await transport.close();
    // a second close must not throw
    await transport.close();
  });
});
