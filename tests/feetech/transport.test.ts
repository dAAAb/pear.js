import { expect, test } from "vitest";

import { FeetechMotorsBus } from "../../src/feetech";
import { readPacket } from "../../src/feetech/protocol";
import { ManualClock, type SerialPortLike, WebSerialTransport } from "../../src/feetech/transport";
import { followerMotors } from "../../src/so101/hardware";

/** A serial port of the Web Serial API's shape whose far end the test holds: what the page wrote, and a way to
 * make bytes arrive. No browser and no device: only the streams' behaviour. */
function fakeSerialPort(): { port: SerialPortLike; written: number[][]; arrive: (bytes: number[]) => void; state: () => string } {
  const written: number[][] = [];
  let state = "new";
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let readable: ReadableStream<Uint8Array> | null = null;
  let writable: WritableStream<Uint8Array> | null = null;

  const port: SerialPortLike = {
    get readable() {
      return readable;
    },
    get writable() {
      return writable;
    },
    async open(options) {
      state = `open at ${options.baudRate}`;
      readable = new ReadableStream<Uint8Array>({
        start(started) {
          controller = started;
        },
      });
      writable = new WritableStream<Uint8Array>({
        write(chunk) {
          written.push(Array.from(chunk));
        },
      });
    },
    async close() {
      state = "closed";
    },
  };

  return { port, written, arrive: (bytes) => controller?.enqueue(Uint8Array.from(bytes)), state: () => state };
}

test("a Web Serial port carries the bus's packets", async () => {
  const { port, written, arrive, state } = fakeSerialPort();
  const transport = await WebSerialTransport.open(port);
  expect(state()).toBe("open at 1000000");

  // bytes come in the pieces the port gives them in and are read in the pieces the bus asks for
  arrive([1, 2, 3]);
  arrive([4, 5]);
  expect(Array.from(await transport.read(2, 50))).toEqual([1, 2]);
  expect(Array.from(await transport.read(6, 50))).toEqual([3, 4, 5]);
  expect(Array.from(await transport.read(6, 0))).toEqual([]);

  // a read waits for bytes that come later, and gives up when none come
  const waiting = transport.read(6, 1000);
  arrive([9]);
  expect(Array.from(await waiting)).toEqual([9]);
  expect(Array.from(await transport.read(6, 5))).toEqual([]);

  // a register read through the bus: the servo's answer arrives in two pieces
  const bus = new FeetechMotorsBus(transport, followerMotors());
  await bus.connect(false);
  const reading = bus.read("Present_Position", "gripper", { normalize: false });
  await new Promise((resolve) => setTimeout(resolve, 1));
  expect(written).toEqual([Array.from(readPacket(6, 56, 2))]);
  arrive([0xff, 0xff, 6, 4, 0]);
  arrive([0x34, 0x08, 0xb9]);
  expect(await reading).toBe(0x0834);

  await bus.disconnect(false);
  expect(state()).toBe("closed");
});

test("a manual clock moves only when something sleeps on it", async () => {
  const clock = new ManualClock(5);
  await clock.sleep(2.5);
  await clock.sleep(-1);
  expect(clock.now()).toBe(7.5);
});
