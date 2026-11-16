// The hand-over of a real arm's line to the Worker, reads only (the request "preflight" of
// web/src/station_host.ts), in Node and on simulated ports: the same request the window sends, answered by the
// same code the Worker runs, with the ports a test gives in place of the Worker's `navigator.serial`.
//
// No test of the first groups needs time or asserts one: the timing self-check, which waits 150 control periods,
// is given a clock that does not wait. The last test runs the simulated arm's Enable on real time and asserts its
// verdict, so it runs only when PEAR_JS_REAL_TIME=1 is set, as in station_host.test.ts.

import { describe, expect, it } from "vitest";

import { getAddress, MODEL_NUMBER_VALUE, protocol, type RegisterName, type Transport } from "../../src/feetech/index";
import type { HardwareSection } from "../../src/so101/config";
import { makeFollower, MOTORS, type MotorName, simulatedArm, SO101Hardware } from "../../src/so101/hardware/index";
import { SIM_CALIBRATION, SIM_START_POSITIONS, SimArm, type SimScenario, simulatedGrantedPort } from "../../web/src/sim_port";
import { LIMP_TRANSACTIONS, STATION_CONFIG, StationHost, TIMING_PERIODS } from "../../web/src/station_host";
import type { GrantedPort, SerialSource } from "../../web/src/station_port";
import type {
  ArmFingerprint,
  EnableResult,
  FromStation,
  PreflightReport,
  StationEvent,
  StationRequest,
  TimingCheck,
} from "../../web/src/station_protocol";

const REAL_TIME = process.env["PEAR_JS_REAL_TIME"] === "1";

/** The USB ids of the simulated adapter, as the window knows an adapter. */
const USB = { vendorId: 0x1a86, productId: 0x55d3 };

/** The simulated arm's servos as the window would have read them. */
const SIM_PRINT: ArmFingerprint = MOTORS.map((motor) => {
  const { id, homingOffset, rangeMin, rangeMax } = SIM_CALIBRATION[motor];

  return { id, model: MODEL_NUMBER_VALUE, homingOffset, rangeMin, rangeMax };
});

const preflight = (changes: Partial<Extract<StationRequest, { type: "preflight" }>> = {}): StationRequest => ({
  type: "preflight",
  source: "granted",
  usb: USB,
  expected: SIM_PRINT,
  isHidden: false,
  ...changes,
});

/** A clock that does not wait: a sleep only moves its time on. */
function instantClock(): { monotonic: () => number; sleep: (seconds: number) => Promise<void> } {
  let time = 0;

  return {
    monotonic: () => time,
    sleep: async (seconds) => {
      time += seconds;
    },
  };
}

/** A station with the ports of `serial`, and what it posted: `ask` sends a request and resolves with its reply. */
function station(
  serial: SerialSource | null,
  clock: ReturnType<typeof instantClock> | null = instantClock(),
): { ask: <Result>(request: StationRequest) => Promise<Result>; events: StationEvent[] } {
  const events: StationEvent[] = [];
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  const host = new StationHost(
    (message: FromStation) => {
      if (message.kind === "event") events.push(message.event);
      if (message.kind !== "reply") return;
      const entry = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.isOk) entry?.resolve(message.result);
      else entry?.reject(new Error(`${message.error.name}: ${message.error.message}`));
    },
    serial,
    clock,
  );

  return {
    events,
    ask: <Result>(request: StationRequest) =>
      new Promise<Result>((resolve, reject) => {
        const id = ++nextId;
        waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
        host.handle({ id, request });
      }),
  };
}

/** A simulated arm, its port as a browser grants one, and every run of bytes that port was given. */
function grantedArm(scenario: SimScenario = "normal"): {
  arm: SimArm;
  port: GrantedPort;
  given: Uint8Array[];
  source: SerialSource;
} {
  const arm = new SimArm(scenario);
  const port = simulatedGrantedPort(arm);
  const given: Uint8Array[] = [];
  const write = arm.chain.write.bind(arm.chain);
  arm.chain.write = async (bytes: Uint8Array): Promise<void> => {
    given.push(bytes.slice());
    await write(bytes);
  };

  return { arm, port, given, source: { getPorts: async () => [port] } };
}

/** Whether a port is closed: an open one has its streams. */
const isClosed = (port: GrantedPort): boolean => port.readable === null && port.writable === null;

/** One instruction packet: FF FF ID LENGTH INSTRUCTION PARAMETERS... CHECKSUM. */
interface Packet {
  id: number;
  instruction: number;
  parameters: number[];
}

/** Returns the instruction packets the runs of bytes are; throws when a run is anything else. */
function packetsOf(runs: readonly Uint8Array[]): Packet[] {
  const packets: Packet[] = [];
  for (const bytes of runs) {
    if (bytes.length === 0) throw new Error("no bytes");
    let offset = 0;
    while (offset < bytes.length) {
      const length = bytes[offset + 3] as number;
      const end = offset + 4 + length;
      if (bytes[offset] !== 0xff || bytes[offset + 1] !== 0xff || !(length >= 2) || end > bytes.length) {
        throw new Error("bytes that are no whole instruction packet");
      }
      const body = Array.from(bytes.subarray(offset + 2, end - 1));
      if ((~body.reduce((sum, byte) => sum + byte, 0) & 0xff) !== bytes[end - 1]) throw new Error("a wrong checksum");
      packets.push({ id: body[0] as number, instruction: body[2] as number, parameters: body.slice(3) });
      offset = end;
    }
  }

  return packets;
}

const READING: readonly number[] = [protocol.INST_PING, protocol.INST_READ, protocol.INST_SYNC_READ];
const PRESENT_POSITION = 56;

/** Returns how many packets of each reading instruction there are, by the names the guard counts them under. */
function countsOf(packets: readonly Packet[]): Record<string, number> {
  const names = new Map([
    [protocol.INST_PING, "PING"],
    [protocol.INST_READ, "READ"],
    [protocol.INST_SYNC_READ, "SYNC READ"],
  ]);
  const counts: Record<string, number> = {};
  for (const { instruction } of packets) {
    const name = names.get(instruction) ?? `0x${instruction.toString(16)}`;
    counts[name] = (counts[name] ?? 0) + 1;
  }

  return counts;
}

const motorOf = (id: number): MotorName => MOTORS.find((motor) => SIM_CALIBRATION[motor].id === id) as MotorName;

describe("the preflight of a real arm's line, on a simulated port", () => {
  it("reads everything its report holds, sends only pings and reads, and closes the port", async () => {
    const { arm, port, given, source } = grantedArm();
    // what another program may have left in the servos: a negative Goal_Velocity, a torque limit, a lock, a gain
    arm.servo("gripper").set("Goal_Velocity", 0x8000 | 300);
    arm.servo("elbow_flex").set("Torque_Limit", 777);
    arm.servo("wrist_roll").set("Lock", 1);
    arm.servo("shoulder_pan").set("P_Coefficient", 32);
    arm.servo("gripper").set("Max_Torque_Limit", 1000);

    const report = await station(source).ask<PreflightReport>(preflight());

    expect(report.stop).toBeNull();
    expect(report.detail).toBe("");
    expect(report.ports).toEqual([USB]);
    expect(report.servos).toEqual(
      MOTORS.map((motor) => {
        const servo = arm.servo(motor);
        const { id, homingOffset, rangeMin, rangeMax } = SIM_CALIBRATION[motor];

        return {
          id,
          model: MODEL_NUMBER_VALUE,
          homingOffset,
          rangeMin,
          rangeMax,
          name: motor,
          firmware: `${servo.get("Firmware_Major_Version")}.${servo.get("Firmware_Minor_Version")}`,
          position: SIM_START_POSITIONS[motor],
          goal: servo.get("Goal_Position"),
          torque: servo.get("Torque_Enable"),
          lock: motor === "wrist_roll" ? 1 : 0,
          status: 0,
          voltage: servo.get("Present_Voltage"),
          temperature: servo.get("Present_Temperature"),
          goalVelocity: motor === "gripper" ? 0x8000 | 300 : 0,
          torqueLimit: motor === "elbow_flex" ? 777 : servo.get("Torque_Limit"),
          phase: servo.get("Phase"),
        };
      }),
    );
    expect(report.servos?.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(report.servos?.every(({ firmware }) => /^\d+\.\d+$/.test(firmware))).toBe(true);

    // every register of the settings, for the servos it is written to, beside what the servo holds
    const settings = report.settings ?? [];
    expect(settings).toHaveLength(6 * 7 + 3);
    for (const row of settings) {
      expect(row.held).toBe(arm.servo(motorOf(row.id)).get(row.register as RegisterName));
      expect([row.address, row.bytes]).toEqual([...getAddress(row.register)]);
      expect(row.area).toBe(row.address === 85 ? "factory" : row.address === 41 ? "ram" : "eeprom");
    }
    expect(settings.filter(({ id }) => id === 6)).toHaveLength(10);
    expect(settings.find(({ id, register }) => id === 1 && register === "P_Coefficient")?.held).toBe(32);
    expect(settings.find(({ id, register }) => id === 6 && register === "Max_Torque_Limit")).toMatchObject({
      address: 16,
      bytes: 2,
      held: 1000,
    });

    // the limp time's single reads, and the timing self-check on this line
    expect(report.singleReads?.count).toBe(LIMP_TRANSACTIONS);
    expect(report.singleReads?.totalMs).toBeGreaterThanOrEqual(report.singleReads?.maxMs ?? Number.NaN);
    expect(report.singleReads?.maxMs).toBeGreaterThanOrEqual(0);
    const timing = report.timing as TimingCheck;
    expect(timing.periods).toBe(TIMING_PERIODS);
    expect(timing.reasons.map(({ code }) => code)).not.toContain("unanswered");
    expect(timing.failures).toHaveLength(timing.reasons.length);

    // what the port was given: whole instruction packets, every one a PING, a READ or a SYNC READ
    const packets = packetsOf(given);
    expect(packets.filter(({ instruction }) => !READING.includes(instruction))).toEqual([]);
    const singles = packets.filter(({ instruction, parameters }) => instruction === protocol.INST_READ && parameters[0] === PRESENT_POSITION);
    expect(singles.map(({ id }) => id)).toEqual(Array.from({ length: LIMP_TRANSACTIONS }, (_, index) => (index % 6) + 1));
    const positionReads = packets.filter(
      ({ instruction, parameters }) => instruction === protocol.INST_SYNC_READ && parameters[0] === PRESENT_POSITION,
    );
    expect(positionReads).toHaveLength(TIMING_PERIODS + 2); // one more period than counted, and the servos' own

    // the guard was the outermost: it counted every packet the port was given, and refused none
    expect(report.guard.refused).toBe(0);
    expect(report.guard.passed).toEqual(countsOf(packets));
    expect(report.lineErrors).toBe(0);
    expect(report.isClosed).toBe(true);
    expect(isClosed(port)).toBe(true);
    expect(report.tookMs).toBeGreaterThanOrEqual(0);
  });

  it("takes a simulated port of its own when asked to, with the adapter's USB ids", async () => {
    const report = await station(null).ask<PreflightReport>(preflight({ source: "simulated" }));

    expect(report.ports).toEqual([USB]);
    expect(report.stop).toBeNull();
    expect(report.servos?.map(({ position }) => position)).toEqual(MOTORS.map((motor) => SIM_START_POSITIONS[motor]));
    expect(report.guard.refused).toBe(0);
    expect(report.isClosed).toBe(true);
  });

  it("says that a hidden page fails the timing self-check, as Enable does", async () => {
    const report = await station(grantedArm().source).ask<PreflightReport>(preflight({ isHidden: true }));

    expect(report.stop).toBeNull();
    expect(report.timing?.reasons.map(({ code }) => code)).toContain("hidden");
    expect(report.timing?.failures).toContain("the page is not visible");
  });

  it("names in its settings what the library's enable writes, register by register and value by value", async () => {
    const chain = simulatedArm(SIM_CALIBRATION, SIM_START_POSITIONS);
    const written: Uint8Array[] = [];
    const recording: Transport = {
      write: async (bytes) => {
        written.push(bytes.slice());
        await chain.write(bytes);
      },
      read: (maxLength, timeoutMs) => chain.read(maxLength, timeoutMs),
      close: () => chain.close(),
    };
    const hardwareConfig = STATION_CONFIG.robot.hardware as HardwareSection;
    const hardware = await SO101Hardware.open(makeFollower(hardwareConfig, recording, SIM_CALIBRATION), {
      jointOffsets: hardwareConfig.joint_offsets,
      statusPollTicks: hardwareConfig.status_poll_ticks,
      stateTimeoutS: STATION_CONFIG.control.state_timeout_s,
    });
    const enabling = packetsOf(written); // what the library's enable sent, before anything else is sent
    await hardware.close();

    // the last value the enable wrote to each register of each servo, by a WRITE or a SYNC WRITE
    const writes = new Map<string, number>();
    const valueOf = (data: readonly number[]): number => data.reduce((value, byte, index) => value | (byte << (8 * index)), 0);
    for (const { id, instruction, parameters } of enabling) {
      if (instruction === protocol.INST_WRITE) {
        writes.set(`${id}:${parameters[0]}`, valueOf(parameters.slice(1)));
      } else if (instruction === protocol.INST_SYNC_WRITE) {
        const [address, length, ...rest] = parameters as [number, number, ...number[]];
        for (let offset = 0; offset < rest.length; offset += length + 1) {
          writes.set(`${rest[offset]}:${address}`, valueOf(rest.slice(offset + 1, offset + 1 + length)));
        }
      } else {
        expect(READING).toContain(instruction);
      }
    }
    // Goal_Position, Torque_Enable and Lock are no settings; Phase is written only when its bit 0x10 is set, and
    // the report tells it with the servo
    const others = [getAddress("Goal_Position")[0], getAddress("Torque_Enable")[0], getAddress("Lock")[0], getAddress("Phase")[0]];
    const library = [...writes]
      .filter(([key]) => !others.includes(Number(key.split(":")[1])))
      .map(([key, value]) => `${key}=${value}`)
      .sort();
    expect(library).toHaveLength(6 * 7 + 3);

    const report = await station(grantedArm().source).ask<PreflightReport>(preflight());
    expect((report.settings ?? []).map(({ id, address, pear }) => `${id}:${address}=${pear}`).sort()).toEqual(library);
  });
});

describe("where a preflight stops", () => {
  /** What every stop before the servos are read leaves of the report. */
  const nothingRead = { servos: null, settings: null, singleReads: null, timing: null };

  it("stops without a serial in the Worker's navigator", async () => {
    const report = await station(null).ask<PreflightReport>(preflight());

    expect(report).toMatchObject({ ...nothingRead, stop: "no-serial", ports: null, isClosed: true, lineErrors: 0 });
    expect(report.guard).toEqual({ passed: {}, refused: 0 });
    expect(report.detail).not.toBe("");
  });

  it("stops when no port is granted, or none of the adapter's ids", async () => {
    const none = await station({ getPorts: async () => [] }).ask<PreflightReport>(preflight());
    expect(none).toMatchObject({ ...nothingRead, stop: "no-port", ports: [], isClosed: true });

    const { port, given, source } = grantedArm();
    const other = await station(source).ask<PreflightReport>(preflight({ usb: { vendorId: 0x0403, productId: 0x6001 } }));
    expect(other).toMatchObject({ ...nothingRead, stop: "no-port", ports: [USB], isClosed: true });
    expect(other.detail).toContain("0403:6001");
    expect(given).toEqual([]);
    expect(isClosed(port)).toBe(true);

    // a port that tells no ids is the one port when the window knows none either
    const bare = new SimArm().port;
    const unknown = await station({ getPorts: async () => [bare] }).ask<PreflightReport>(preflight({ usb: null }));
    expect(unknown).toMatchObject({ stop: null, ports: [null], isClosed: true });
  });

  it("stops when several ports are granted: they cannot be told apart", async () => {
    const first = grantedArm();
    const second = grantedArm();
    const source: SerialSource = { getPorts: async () => [first.port, second.port] };
    for (const usb of [USB, null]) {
      const report = await station(source).ask<PreflightReport>(preflight({ usb }));
      expect(report).toMatchObject({ ...nothingRead, stop: "several-ports", ports: [USB, USB], isClosed: true });
    }
    expect([...first.given, ...second.given]).toEqual([]);
  });

  it("stops when the port does not open", async () => {
    const { arm, port, given, source } = grantedArm();
    arm.port.unplug();
    const report = await station(source).ask<PreflightReport>(preflight());

    expect(report).toMatchObject({ ...nothingRead, stop: "open-failed", ports: [USB], isClosed: true });
    expect(report.detail).toContain("Failed to open serial port");
    expect(report.guard).toEqual({ passed: {}, refused: 0 });
    expect(given).toEqual([]);
    expect(isClosed(port)).toBe(true);
  });

  it("stops when a servo is missing, having sent only pings and reads, and closes the port", async () => {
    const { port, given, source } = grantedArm("missing");
    const report = await station(source).ask<PreflightReport>(preflight());

    expect(report).toMatchObject({ ...nothingRead, stop: "handshake-failed", isClosed: true });
    expect(report.detail).toContain("The handshake failed");
    const packets = packetsOf(given);
    expect(packets.filter(({ instruction }) => !READING.includes(instruction))).toEqual([]);
    expect(report.guard).toEqual({ passed: countsOf(packets), refused: 0 });
    expect(isClosed(port)).toBe(true);
  });

  it("stops at another arm, tells the differences and reads nothing after the comparison", async () => {
    const { port, given, source } = grantedArm();
    const expected = SIM_PRINT.map((servo) => (servo.id === 3 ? { ...servo, homingOffset: servo.homingOffset + 1 } : servo));
    const report = await station(source).ask<PreflightReport>(preflight({ expected }));

    expect(report).toMatchObject({ ...nothingRead, stop: "other-arm", isClosed: true });
    expect(report.detail).toContain("servo 3 Homing_Offset: read 1238, expected 1239");
    expect(report.detail).not.toContain("servo 2");

    // the last thing sent is the comparison's last read, and nothing but the handshake and the comparison was read
    const packets = packetsOf(given);
    const compared = ["Model_Number", "Homing_Offset", "Min_Position_Limit", "Max_Position_Limit"].map((name) => getAddress(name)[0]);
    expect(packets.slice(-compared.length).map(({ instruction, parameters }) => [instruction, parameters[0]])).toEqual(
      compared.map((address) => [protocol.INST_SYNC_READ, address]),
    );
    const handshake = ["Model_Number", "Firmware_Major_Version", "Firmware_Minor_Version"].map((name) => getAddress(name)[0]);
    const read = packets.filter(({ instruction }) => instruction !== protocol.INST_PING).map(({ parameters }) => parameters[0]);
    expect(read.filter((address) => !compared.includes(address as number) && !handshake.includes(address as number))).toEqual([]);
    expect(packets.filter(({ instruction }) => !READING.includes(instruction))).toEqual([]);
    expect(report.guard).toEqual({ passed: countsOf(packets), refused: 0 });
    expect(isClosed(port)).toBe(true);
  });

  it("stops when the port is unplugged on the way, and holds no port after", async () => {
    const { arm, port, source } = grantedArm();
    const write = arm.chain.write;
    let singles = 0;
    arm.chain.write = async (bytes: Uint8Array): Promise<void> => {
      // the cable is pulled at the fifth of the limp time's single reads
      if (bytes[4] === protocol.INST_READ && bytes[5] === PRESENT_POSITION && ++singles === 5) arm.port.unplug();
      await write(bytes);
    };
    const report = await station(source).ask<PreflightReport>(preflight());

    expect(report).toMatchObject({ stop: "line-lost", singleReads: null, timing: null, isClosed: true });
    expect(report.detail).toContain("The port was lost while it was read");
    expect(report.servos).toHaveLength(6); // what was read before the loss is told
    expect(report.guard.refused).toBe(0);
    expect(isClosed(port)).toBe(true);
  });
});

describe("a preflight and the station", () => {
  it("refuses a second preflight and Enable while one runs, and a preflight while the station is opened", async () => {
    const { port } = grantedArm();
    let release: (ports: GrantedPort[]) => void = () => undefined;
    const gate = new Promise<GrantedPort[]>((resolve) => {
      release = resolve;
    });
    const { ask, events } = station({ getPorts: () => gate });

    const first = ask<PreflightReport>(preflight());
    await expect(ask(preflight())).rejects.toThrow(/Another preflight of a real arm is under way/);
    await expect(ask({ type: "enable", positions: SIM_START_POSITIONS, isHidden: false })).rejects.toThrow(
      /A preflight of a real arm is under way/,
    );
    release([port]);
    const report = await first;
    expect(report).toMatchObject({ stop: null, isClosed: true });
    expect(isClosed(port)).toBe(true); // after the reply the Worker holds no port

    // the station takes Enable again, and refuses a preflight from the moment it is being opened
    const enabling = ask<EnableResult>({ type: "enable", positions: SIM_START_POSITIONS, isHidden: false }).then(
      () => true,
      () => false,
    );
    await expect(ask(preflight())).rejects.toThrow(/Station already open/);
    const isEnabled = await enabling;

    // the simulated arm's Enable reads its timing self-check as before: every read answered at once
    const timing = events.find((event) => event.type === "timing") as Extract<StationEvent, { type: "timing" }>;
    expect(timing.timing.periods).toBe(TIMING_PERIODS);
    expect(timing.timing.reasons.map(({ code }) => code)).not.toContain("unanswered");
    if (isEnabled) {
      await expect(ask(preflight())).rejects.toThrow(/Station already open/);
      await ask({ type: "disable" });
    }
    expect(isClosed(port)).toBe(true); // the robot was never given the port
  });
});

describe.skipIf(!REAL_TIME)("the simulated arm's Enable, in real time", () => {
  it("still passes its timing self-check, and a preflight is refused while the station is open", async () => {
    const { ask } = station(grantedArm().source, null);
    const enabled = await ask<EnableResult>({ type: "enable", positions: SIM_START_POSITIONS, isHidden: false });

    expect(enabled.timing.periods).toBe(TIMING_PERIODS);
    expect(enabled.timing.failures).toEqual([]);
    expect(enabled.timing.meanMs).toBeGreaterThan(19);
    await expect(ask(preflight())).rejects.toThrow(/Station already open/);
    await ask({ type: "disable" });
  }, 30_000);
});
