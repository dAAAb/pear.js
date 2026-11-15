import { createServer, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, test } from "vitest";

import { SO101Hardware } from "../../src/so101/hardware/arms";
import { SO101Follower } from "../../src/so101/hardware/follower";
import { simulatedArm } from "../../src/so101/hardware/sim";
import { calibrationOf, fixture, type FixtureCalibration } from "../feetech/helpers";
import { TcpTransport } from "./tcp_transport";

// These tests need no servo chain outside this repository: the peer is a server of their own on 127.0.0.1.

const HOST = "127.0.0.1";
const servers: Server[] = [];
const connections: Socket[] = [];

/** Starts a server on a free port of this machine and returns the port; ``serve`` is given each connection. */
function listen(serve: (socket: Socket) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      connections.push(socket);
      socket.on("error", () => undefined); // a peer that left is no failure of the test
      serve(socket);
    });
    servers.push(server);
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("no port"));
      else resolve(address.port);
    });
  });
}

afterEach(async () => {
  for (const socket of connections.splice(0)) socket.destroy();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("the TCP transport", () => {
  test("what is written reaches the peer, and what the peer sends is read in order", async () => {
    const received: number[] = [];
    const port = await listen((socket) => {
      socket.on("data", (chunk: Buffer) => {
        received.push(...chunk);
        socket.write(Uint8Array.from([...chunk].map((byte) => byte ^ 0xff)));
      });
    });
    const transport = await TcpTransport.connect(HOST, port);

    await transport.write(Uint8Array.of(0xff, 0xff, 0x01, 0x02, 0x01, 0xfb));
    const answer: number[] = [];
    while (answer.length < 6) answer.push(...(await transport.read(6 - answer.length, 1000)));

    expect(received).toEqual([0xff, 0xff, 0x01, 0x02, 0x01, 0xfb]);
    expect(answer).toEqual([0x00, 0x00, 0xfe, 0xfd, 0xfe, 0x04]);
    expect([transport.bytesWritten, transport.bytesRead]).toEqual([6, 6]);
    await transport.close();
  });

  test("a read takes at most what it asks for and leaves the rest", async () => {
    const port = await listen((socket) => socket.write(Uint8Array.of(1, 2, 3, 4, 5)));
    const transport = await TcpTransport.connect(HOST, port);

    const first = await transport.read(2, 1000);
    const rest: number[] = [];
    while (rest.length < 3) rest.push(...(await transport.read(10, 1000)));

    expect([...first]).toEqual([1, 2]);
    expect(rest).toEqual([3, 4, 5]);
    await transport.close();
  });

  test("a read that gets nothing resolves with nothing when its time is up, not before", async () => {
    const port = await listen(() => undefined);
    const transport = await TcpTransport.connect(HOST, port);

    const started = performance.now();
    const nothing = await transport.read(6, 40);
    const waited = performance.now() - started;

    expect(nothing.length).toBe(0);
    expect(waited).toBeGreaterThanOrEqual(39);
    expect((await transport.read(6, 0)).length).toBe(0); // zero only looks at what is waiting
    await transport.close();
  });

  test("bytes that come while a read waits end the wait at once", async () => {
    let peer: Socket | null = null;
    const port = await listen((socket) => {
      peer = socket;
    });
    const transport = await TcpTransport.connect(HOST, port);

    const started = performance.now();
    const pending = transport.read(6, 5000);
    await new Promise((resolve) => setImmediate(resolve));
    (peer as Socket | null)?.write(Uint8Array.of(7, 8));
    const bytes = await pending;

    expect([...bytes]).toEqual([7, 8]);
    expect(performance.now() - started).toBeLessThan(2500);
    await transport.close();
  });

  test("once the peer has closed, what it sent is still read and then a read throws", async () => {
    const port = await listen((socket) => socket.end(Uint8Array.of(9)));
    const transport = await TcpTransport.connect(HOST, port);

    const last: number[] = [];
    while (last.length < 1) last.push(...(await transport.read(4, 1000)));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(last).toEqual([9]);
    await expect(transport.read(4, 100)).rejects.toThrow("The line was closed");
    await expect(transport.write(Uint8Array.of(1))).rejects.toThrow("The line was closed");
    await transport.close();
    await transport.close(); // closing again does nothing
  });

  test("nothing listening is an error", async () => {
    const port = await listen(() => undefined);
    await new Promise<void>((resolve) => {
      servers[0].close(() => resolve());
    });

    await expect(TcpTransport.connect(HOST, port, 2000)).rejects.toThrow();
  });
});

describe("the hardware layer over a socket", () => {
  test("opens, reads, commands and closes pear.js's own simulated arm behind a TCP server", async () => {
    // the arm's calibration and resting pose are the ones of the feetech fixtures
    const reference = fixture<{ calibration: FixtureCalibration; hardware: { joint_offsets: number[] } }>("so101.json");
    const calibration = calibrationOf(reference.calibration);
    const chain = simulatedArm(calibration, { shoulder_lift: 912, elbow_flex: 3101, gripper: 2060 });
    const port = await listen((socket) => {
      socket.on("data", (chunk: Buffer) => {
        void chain
          .write(chunk)
          .then(() => chain.read(4096, 0))
          .then((answer) => {
            if (answer.length > 0) socket.write(answer);
          });
      });
    });

    const transport = await TcpTransport.connect(HOST, port);
    const follower = new SO101Follower(transport, calibration);
    const hardware = await SO101Hardware.open(follower, {
      jointOffsets: reference.hardware.joint_offsets,
      statusPollTicks: 10,
      stateTimeoutS: 0.2,
    });

    const before = await hardware.read();
    await hardware.send([0.1, -0.8, 0.7, 1.2, -1.5, 1.0]);
    const after = await hardware.read();
    await hardware.close();

    expect(before.position).toHaveLength(6);
    expect(before.servoStatus.torque).toEqual({
      shoulder_pan: 1,
      shoulder_lift: 1,
      elbow_flex: 1,
      wrist_flex: 1,
      wrist_roll: 1,
      gripper: 1,
    });
    // the simulated servos reach a goal at once: the reading is the target within an encoder count
    const count = (2 * Math.PI) / 4096;
    after.position.slice(0, 5).forEach((coordinate, index) => {
      expect(Math.abs(coordinate - [0.1, -0.8, 0.7, 1.2, -1.5][index])).toBeLessThanOrEqual(1.5 * count);
    });
    expect(after.position[5]).toBeGreaterThan(0.99);
    expect([...chain.servos.values()].every((servo) => !servo.torqueEnabled)).toBe(true);
    expect(transport.isClosed).toBe(true);
    expect(chain.received.length).toBeGreaterThan(100);
  });
});
