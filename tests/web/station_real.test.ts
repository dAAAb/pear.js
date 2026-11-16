// The station on a real arm's line (the requests "enableReal" and "arm" of web/src/station_host.ts), in Node and
// on simulated ports: the same requests the window sends, answered by the same code the Worker runs, with a
// simulated arm's port in place of the port the page was granted. Every packet such a port is given is recorded
// where the simulated servos take it, beneath the port, the transport and the guard: what the tests say of
// writing is said of what reached the servos.
//
// No test needs real time or asserts a time: the robot, its line, its guard and the timing self-check keep one
// clock of the test's own, on which time passes only while everything waits for it.

import { afterEach, describe, expect, it } from "vitest";

import { getAddress, MODEL_NUMBER_VALUE, type MotorCalibration, type RegisterName } from "../../src/feetech/index";
import { CONTROL_TABLE } from "../../src/feetech/tables";
import { MOTORS, type MotorName } from "../../src/so101/hardware/index";
import type { MonotonicClock } from "../../src/station/joint/clock";
import { SIM_CALIBRATION, SIM_START_POSITIONS, SimArm, type SimScenario, simulatedConfiguredPort, simulatedGrantedPort } from "../../web/src/sim_port";
import { armingBlockers, ENABLE_SETTINGS, GRIPPER_SETTINGS, guardSettings, StationHost } from "../../web/src/station_host";
import type {
  ArmFingerprint,
  DisableResult,
  EnableRealResult,
  FromStation,
  HomeResult,
  PreflightReport,
  StationEvent,
  StationRequest,
  StationStatus,
} from "../../web/src/station_protocol";

/** A clock on which time passes only while everything waits for it: the sleeper whose time comes first is woken,
 * at its time. The station's control loop, its waits and the guard all keep this one clock, so a session takes
 * as long as its periods need to be computed and no longer, on any machine. */
class EventClock implements MonotonicClock {
  private nowS = 100;
  private readonly sleepers: Array<{ at: number; wake: () => void }> = [];
  private isPumping = false;

  monotonic(): number {
    return this.nowS;
  }

  sleep(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      this.sleepers.push({ at: this.nowS + Math.max(seconds, 0), wake: resolve });
      this.pumpLater();
    });
  }

  private pumpLater(): void {
    if (this.isPumping || this.sleepers.length === 0) return;
    this.isPumping = true;
    setImmediate(() => {
      this.isPumping = false;
      let first = 0;
      for (let index = 1; index < this.sleepers.length; index++) {
        if ((this.sleepers[index] as { at: number }).at < (this.sleepers[first] as { at: number }).at) first = index;
      }
      const [sleeper] = this.sleepers.splice(first, 1);
      if (sleeper === undefined) return;
      this.nowS = Math.max(this.nowS, sleeper.at);
      sleeper.wake();
      this.pumpLater();
    });
  }
}

/** The USB ids of the simulated adapter, as the window knows an adapter. */
const USB = { vendorId: 0x1a86, productId: 0x55d3 };

/** The servos as the window would have read them, for the calibration they hold; null: the factory's values. */
const printOf = (calibration: Readonly<Record<MotorName, MotorCalibration>> | null): ArmFingerprint =>
  MOTORS.map((motor) => {
    const { id, homingOffset, rangeMin, rangeMax } = SIM_CALIBRATION[motor];

    return calibration === null
      ? { id, model: MODEL_NUMBER_VALUE, homingOffset: 0, rangeMin: 0, rangeMax: 4095 }
      : { id, model: MODEL_NUMBER_VALUE, homingOffset, rangeMin, rangeMax };
  });

type EnableRealRequest = Extract<StationRequest, { type: "enableReal" }>;

const enableReal = (changes: Partial<EnableRealRequest> = {}): StationRequest => ({
  type: "enableReal",
  source: "granted",
  usb: USB,
  expected: printOf(SIM_CALIBRATION),
  calibrationFile: null,
  isHidden: false,
  ...changes,
});

/** The instructions that only read: PING, READ and SYNC READ. */
const READING = new Set([0x01, 0x02, 0x82]);
const isReading = (packet: Uint8Array): boolean => READING.has(packet[4] as number);

/** A packet as the guard counts it: the instruction and, for a write, the register's address. */
function keyOf(packet: Uint8Array): string {
  const instruction = packet[4] as number;
  if (instruction === 0x01) return "PING";
  if (instruction === 0x02) return "READ";
  if (instruction === 0x82) return "SYNC READ";
  if (instruction === 0x03) return `WRITE ${packet[5]}`;
  if (instruction === 0x83) return `SYNC WRITE ${packet[5]}`;

  return `instruction ${instruction}`;
}

/** What the guard lets through of PEAR's station: its rows, as it counts them. */
const ROWS = [
  "PING",
  "READ",
  "SYNC READ",
  "SYNC WRITE 42",
  "WRITE 40",
  "WRITE 55",
  "WRITE 41",
  "WRITE 7",
  "WRITE 85",
  "WRITE 33",
  "WRITE 21",
  "WRITE 22",
  "WRITE 23",
  "WRITE 16",
  "WRITE 28",
  "WRITE 36",
].sort();

/** The registers a servo keeps without power (below address 40) and Maximum_Acceleration. */
const KEPT = (Object.keys(CONTROL_TABLE) as RegisterName[]).filter((name) => getAddress(name)[0] < 40 || name === "Maximum_Acceleration");

/** Every such register of every servo of `arm`. */
const keptOf = (arm: SimArm): Record<string, number> =>
  Object.fromEntries(MOTORS.flatMap((motor) => KEPT.map((name) => [`${motor} ${name}`, arm.servo(motor).get(name)])));

const torqueOf = (arm: SimArm): boolean[] => MOTORS.map((motor) => arm.servo(motor).torqueEnabled);

interface Bench {
  arm: SimArm;
  port: ReturnType<typeof simulatedGrantedPort>;
  /** Every packet the simulated servos were given, in their order. */
  packets: Uint8Array[];
  /** The state of the guard of the line the station opened last; null before a line is opened. */
  guardState: () => string | null;
  events: StationEvent[];
  clock: EventClock;
  ask: <Result>(request: StationRequest) => Promise<Result>;
  /** Waits on the station's clock until `isSo` holds. */
  until: (isSo: () => boolean, what: string) => Promise<void>;
  /** The status as the station tells it now. */
  status: () => Promise<StationStatus>;
  isPortClosed: () => boolean;
  /** Tells the station that the window's camera runs and sends it a frame every 50 ms of the station's clock,
   * until the test ends: PEAR's Home refuses to start without a fresh frame of the wrist camera. */
  startCamera: () => void;
}

/** What the tests send as a frame: the first and the last bytes of a JPEG. The station never decodes a frame. */
const FRAME = [0xff, 0xd8, 0xff, 0xd9];

/** The cameras that run: a test's end stops them, so that no clock is kept going after it. */
const cameras: Array<{ isRunning: boolean }> = [];
afterEach(() => {
  for (const camera of cameras.splice(0)) camera.isRunning = false;
});

/** A station whose one granted port is a simulated arm's: configured as lerobot leaves an arm unless
 * `isConfigured` is false. */
function bench(options: { scenario?: SimScenario; isConfigured?: boolean; armingLimitMs?: number } = {}): Bench {
  const clock = new EventClock();
  const arm = new SimArm(options.scenario ?? "normal");
  const packets: Uint8Array[] = [];
  const write = arm.chain.write.bind(arm.chain);
  arm.chain.write = async (bytes: Uint8Array): Promise<void> => {
    packets.push(bytes.slice());
    await write(bytes);
  };
  const port = options.isConfigured === false ? simulatedGrantedPort(arm) : simulatedConfiguredPort(ENABLE_SETTINGS, GRIPPER_SETTINGS, arm);
  const events: StationEvent[] = [];
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let guardState: (() => string) | null = null;
  const host = new StationHost(
    (message: FromStation) => {
      if (message.kind === "event") events.push(message.event);
      if (message.kind !== "reply") return;
      const entry = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.isOk) entry?.resolve(message.result);
      else entry?.reject(new Error(`${message.error.name}: ${message.error.message}`));
    },
    { getPorts: async () => [port] },
    clock,
    // A request that waits for the operator by mistake ends within four seconds, not within two minutes
    { clock, armingLimitMs: options.armingLimitMs ?? 4000, onGuard: (guard) => (guardState = () => guard.state) },
  );
  const ask = <Result>(request: StationRequest): Promise<Result> =>
    new Promise<Result>((resolve, reject) => {
      nextId += 1;
      waiting.set(nextId, { resolve: resolve as (value: unknown) => void, reject });
      host.handle({ id: nextId, request });
    });

  return {
    arm,
    port,
    packets,
    guardState: () => guardState?.() ?? null,
    events,
    clock,
    ask,
    until: async (isSo, what) => {
      for (let waits = 0; !isSo(); waits++) {
        if (waits > 20_000) throw new Error(`Never happened: ${what}`);
        await clock.sleep(0.02);
      }
    },
    status: async () => {
      await ask({ type: "visibility", isHidden: false }); // tells the status at once
      const told = events.filter((event) => event.type === "status");

      return (told[told.length - 1] as Extract<StationEvent, { type: "status" }>).status;
    },
    isPortClosed: () => port.readable === null && port.writable === null,
    startCamera: () => {
      const camera = { isRunning: true };
      cameras.push(camera);
      host.handle({ kind: "camera", isRunning: true });
      void (async () => {
        while (camera.isRunning) {
          host.handle({ kind: "frame", jpeg: Uint8Array.from(FRAME).buffer });
          await clock.sleep(0.05);
        }
      })();
    },
  };
}

type Arming = Extract<StationEvent, { type: "arming" }>;
const armingOf = (events: readonly StationEvent[]): Arming | undefined => events.find((event): event is Arming => event.type === "arming");
/** The operator's answer to the arming report told last; with none told it names a request that never was. */
const answerOf = (bench: Bench, isConfirmed: boolean): StationRequest => ({
  type: "arm",
  requestId: [...bench.events].reverse().find((event): event is Arming => event.type === "arming")?.requestId ?? 0,
  isConfirmed,
});
const plansOf = (events: readonly StationEvent[]): number => events.filter((event) => event.type === "plan").length;
const warningsOf = (events: readonly StationEvent[]): string[] =>
  events.flatMap((event) => (event.type === "log" && event.logger === "station" ? [event.message] : []));

/** Starts an "enableReal" on `b` and waits until it has told what it read. */
async function armed(b: Bench, changes: Partial<EnableRealRequest> = {}): Promise<{ enabling: Promise<EnableRealResult>; arming: Arming }> {
  const enabling = b.ask<EnableRealResult>(enableReal(changes));
  enabling.catch(() => undefined); // a test that expects the error awaits it later
  await b.until(() => armingOf(b.events) !== undefined, "the event arming");

  return { enabling, arming: armingOf(b.events) as Arming };
}

/** Enables the station on the arm of `b`, with the operator's confirmation. */
async function enabled(b: Bench): Promise<EnableRealResult> {
  const { enabling, arming } = await armed(b);
  expect(arming.blockers).toEqual([]);
  await b.ask(answerOf(b, true));

  return enabling;
}

/** The arm far from PEAR's Home pose, the gripper closed: Home opens the gripper, then moves every joint. */
const FAR: Readonly<Record<MotorName, number>> = {
  shoulder_pan: 2600,
  shoulder_lift: 2100,
  elbow_flex: 1500,
  wrist_flex: 2400,
  wrist_roll: 1600,
  gripper: 2200,
};

describe("the station on a real arm's line: a whole session", () => {
  it("reads only until the operator confirms; then enables, stops a Home, goes Home, disables: nothing refused, no kept setting changed", { timeout: 120_000 }, async () => {
    const b = bench();
    for (const motor of MOTORS) b.arm.setPosition(motor, FAR[motor]);
    const before = keptOf(b.arm);

    // until the confirmation: the reads of a preflight, and nothing else reaches the servos
    const { enabling, arming } = await armed(b);
    expect(arming.blockers).toEqual([]);
    expect(arming.report.stop).toBeNull();
    expect(arming.report.isClosed).toBe(false);
    expect(arming.report.guard.refused).toBe(0);
    await b.clock.sleep(5); // the station waits, and writes nothing while it waits
    expect(b.guardState()).toBe("reads"); // and could not: its guard lets no write through yet
    const readsBefore = b.packets.length;
    expect(readsBefore).toBeGreaterThan(200);
    expect(b.packets.filter((packet) => !isReading(packet))).toEqual([]);
    expect(torqueOf(b.arm)).toEqual(MOTORS.map(() => false));
    expect((await b.status()).robot).toBe("OFF");
    expect(b.packets.length).toBe(readsBefore);

    // confirmed: PEAR's enable
    await b.ask(answerOf(b, true));
    const result = await enabling;
    expect(result.outcome).toBe("enabled");
    expect(result.blockers).toEqual([]);
    expect(result.report.isClosed).toBe(false);
    expect(result.openMs).not.toBeNull();
    expect(b.guardState()).toBe("station");
    expect(torqueOf(b.arm)).toEqual(MOTORS.map(() => true));
    expect(b.packets.slice(0, readsBefore).every(isReading)).toBe(true);
    expect(b.packets.slice(readsBefore).some((packet) => !isReading(packet))).toBe(true);
    const afterEnable = await b.status();
    expect(afterEnable.arm).toBe("real");
    expect(afterEnable.robot).toBe("READY");
    expect(afterEnable.line).toMatchObject({ refused: 0, refusals: [], lineErrors: 0, isLost: false });

    // Home with the plan approved, stopped while the arm moves
    b.startCamera();
    await b.clock.sleep(0.2);
    const first = b.ask<HomeResult>({ type: "home" }).then(
      (report) => `ended: ${JSON.stringify(report.results)}`,
      (error: unknown) => `failed: ${String(error)}`,
    );
    let firstEnd: string | null = null;
    void first.then((end) => (firstEnd = end));
    await b.until(() => plansOf(b.events) === 1 || firstEnd !== null, "the first Home plan");
    expect(firstEnd).toBeNull(); // the Home waits for its plan's approval
    await b.ask({ type: "approve", isApproved: true });
    const goalsAtApproval = (await b.status()).line?.passed["SYNC WRITE 42"] ?? 0;
    await b.clock.sleep(3.5);
    const goalsAtStop = (await b.status()).line?.passed["SYNC WRITE 42"] ?? 0;
    await b.ask({ type: "stop" });
    const stopped = await first;
    expect(stopped).not.toContain('"reached":true');
    expect(goalsAtStop - goalsAtApproval).toBeGreaterThan(50); // the arm was moving when it was stopped

    // Home again, to its end, once the braking ramp has brought the arm to rest
    await b.clock.sleep(2);
    const second = b.ask<HomeResult>({ type: "home" });
    await b.until(() => plansOf(b.events) === 2, "the second Home plan");
    await b.ask({ type: "approve", isApproved: true });
    const home = await second;
    expect(home.results).toMatchObject({ reached: true, gripper_open: true });
    const afterHome = await b.status();
    expect(afterHome.line).toMatchObject({ refused: 0, refusals: [], isLost: false });
    expect(Object.keys(afterHome.line?.passed ?? {}).every((key) => ROWS.includes(key))).toBe(true);
    expect((afterHome.line?.passed["SYNC WRITE 42"] ?? 0) - goalsAtStop).toBeGreaterThan(50);

    // disable: torque off, the port closed, and said so
    const disabled = await b.ask<DisableResult>({ type: "disable" });
    expect(disabled).toEqual({ positions: {}, isLineClosed: true });
    expect(b.isPortClosed()).toBe(true);
    expect(b.guardState()).toBe("reads");
    expect(torqueOf(b.arm)).toEqual(MOTORS.map(() => false));
    const off = await b.status();
    expect(off).toMatchObject({ robot: "OFF", arm: null, line: null });

    // what reached the servos is the guard's rows and nothing else, and no setting a servo keeps has changed
    expect([...new Set(b.packets.map(keyOf))].sort()).toEqual(ROWS);
    expect(keptOf(b.arm)).toEqual(before);
    expect(warningsOf(b.events)).toEqual([]);
    const sent = b.packets.length;
    await b.clock.sleep(1);
    expect(b.packets.length).toBe(sent); // nothing is sent after the line is closed
  });

  it("takes the Worker's own simulated ports: a configured one is enabled, one lerobot never ran is blocked", { timeout: 120_000 }, async () => {
    const configured = bench();
    const starting = configured.ask<EnableRealResult>(enableReal({ source: "simulated-configured" }));
    await configured.until(() => armingOf(configured.events) !== undefined, "the event arming");
    expect(armingOf(configured.events)?.blockers).toEqual([]);
    await configured.ask(answerOf(configured, true));
    expect((await starting).outcome).toBe("enabled");
    expect((await configured.status()).arm).toBe("real");
    expect(await configured.ask<DisableResult>({ type: "disable" })).toEqual({ positions: {}, isLineClosed: true });
    expect(configured.packets).toEqual([]); // the port of the test's own was never taken

    const plain = bench();
    const result = await plain.ask<EnableRealResult>(enableReal({ source: "simulated" }));
    expect(result.outcome).toBe("blocked");
    expect(result.blockers.map(({ code }) => code)).toEqual(["settings"]);
    expect(result.report.isClosed).toBe(true);
    expect(Object.keys(result.report.guard.passed).sort()).toEqual(["PING", "READ", "SYNC READ"]);

    // a preflight takes the three sources as well, and tells the configured one's settings as PEAR's
    const report = await plain.ask<PreflightReport>({ type: "preflight", source: "simulated-configured", usb: USB, expected: printOf(SIM_CALIBRATION), isHidden: false });
    expect(report.stop).toBeNull();
    expect((report.settings ?? []).filter(({ area, held, pear }) => area === "eeprom" && held !== pear)).toEqual([]);
    expect(armingBlockers(report, null)).toEqual([]);
  });
});

describe("an arm that is not enabled: only reads reach the servos, and the port is closed", () => {
  /** Runs an "enableReal" that must end by itself, and holds what every such end has in common. */
  async function ended(b: Bench, changes: Partial<EnableRealRequest>, outcome: "blocked" | "refused"): Promise<EnableRealResult> {
    const before = keptOf(b.arm);
    const result = await b.ask<EnableRealResult>(enableReal(changes));
    expect(result.outcome).toBe(outcome);
    expect(result.openMs).toBeNull();
    expect(result.report.isClosed).toBe(true);
    expect(b.isPortClosed()).toBe(true);
    expect(b.guardState()).toBe("reads");
    expect(b.packets.filter((packet) => !isReading(packet))).toEqual([]);
    expect(torqueOf(b.arm)).toEqual(MOTORS.map(() => false));
    expect(keptOf(b.arm)).toEqual(before);
    expect(armingOf(b.events)?.blockers).toEqual(result.blockers);
    expect((await b.status()).robot).toBe("OFF");
    // nothing waits for an answer any more
    await expect(b.ask(answerOf(b, true))).rejects.toThrow("No enabling of a real arm waits for a confirmation");
    expect(b.packets.filter((packet) => !isReading(packet))).toEqual([]);

    return result;
  }

  it("blocks servos lerobot never ran, naming every EEPROM row PEAR's enable would change", async () => {
    const b = bench({ isConfigured: false });
    const result = await ended(b, {}, "blocked");
    expect(result.blockers.map(({ code }) => code)).toEqual(["settings"]);
    const blocker = result.blockers[0] as Extract<EnableRealResult["blockers"][number], { code: "settings" }>;
    expect(blocker.rows.length).toBeGreaterThan(0);
    expect(blocker.rows.every(({ area, held, pear }) => area === "eeprom" && held !== pear)).toBe(true);
    expect(blocker.rows).toEqual((result.report.settings ?? []).filter(({ area, held, pear }) => area === "eeprom" && held !== pear));
    expect(b.packets.length).toBeGreaterThan(200);
  });

  it("blocks an arm that is not the one the window read (stop)", async () => {
    const other = printOf(SIM_CALIBRATION).map((servo) => (servo.id === 3 ? { ...servo, homingOffset: servo.homingOffset + 1 } : servo));
    const result = await ended(bench(), { expected: other }, "blocked");
    expect(result.blockers).toEqual([{ code: "stop", stop: "other-arm" }]);
  });

  it("blocks a hidden page (timing)", async () => {
    const result = await ended(bench(), { isHidden: true }, "blocked");
    expect(result.blockers).toEqual([{ code: "timing" }]);
    expect(result.report.timing?.failures.length).toBeGreaterThan(0);
  });

  it("blocks a servo that answers with an error: the handshake does not pass (stop)", async () => {
    // The simulated servo whose Status is not 0 says so in every answer, and the handshake stops at it. The
    // blocker `status`, for a Status that is read without it, is held on a report in the test of every blocker
    const b = bench({ scenario: "error" });
    const result = await ended(b, {}, "blocked");
    expect(result.blockers).toEqual([{ code: "stop", stop: "handshake-failed" }]);
  });

  it("blocks a servo whose Phase PEAR's enable would rewrite (phase)", async () => {
    const b = bench();
    const servo = b.arm.servo("elbow_flex");
    servo.set("Phase", servo.get("Phase") | 0x10);
    const result = await ended(b, {}, "blocked");
    expect(result.blockers).toEqual([{ code: "phase", ids: [SIM_CALIBRATION.elbow_flex.id] }]);
  });

  it("blocks servos that hold the factory's values in place of a calibration (uncalibrated)", async () => {
    const b = bench({ scenario: "factory" });
    const result = await ended(b, { expected: printOf(null) }, "blocked");
    expect(result.blockers).toEqual([{ code: "uncalibrated", ids: [1, 2, 3, 4, 5, 6] }]);
  });

  it("blocks a calibration file that is not what the servos hold, as the library's own check compares them (calibration)", async () => {
    const file = { ...SIM_CALIBRATION, elbow_flex: { ...SIM_CALIBRATION.elbow_flex, homingOffset: 1239, rangeMax: 3000 } };
    const result = await ended(bench(), { calibrationFile: file }, "blocked");
    expect(result.blockers).toEqual([
      { code: "calibration", detail: "elbow_flex Max_Position_Limit: file 3000, servo 3069; elbow_flex Homing_Offset: file 1239, servo 1238" },
    ]);

    // a motor too few or too many differs as well; a drive mode and an id are not compared, as in the library
    const { gripper: _, ...five } = SIM_CALIBRATION;
    const missing = await ended(bench(), { calibrationFile: five as Record<string, MotorCalibration> }, "blocked");
    expect(missing.blockers).toEqual([{ code: "calibration", detail: "gripper: not in the file" }]);
    const extra = await ended(bench(), { calibrationFile: { ...SIM_CALIBRATION, thumb: SIM_CALIBRATION.gripper } }, "blocked");
    expect(extra.blockers).toEqual([{ code: "calibration", detail: "thumb: in the file, not among the servos" }]);
  });

  it("gives every blocker of a report, in a fixed order, and the guard's refusals among them (guard)", async () => {
    const b = bench();
    const report = await b.ask<PreflightReport>({ type: "preflight", source: "granted", usb: USB, expected: printOf(SIM_CALIBRATION), isHidden: false });
    expect(armingBlockers(report, null)).toEqual([]);
    expect(armingBlockers(report, SIM_CALIBRATION)).toEqual([]);
    expect(armingBlockers({ ...report, guard: { passed: report.guard.passed, refused: 2 } }, null)).toEqual([{ code: "guard", refused: 2 }]);
    const faulty = (report.servos ?? []).map((servo) => (servo.id === 4 ? { ...servo, status: 0x20 } : servo));
    expect(armingBlockers({ ...report, servos: faulty }, null)).toEqual([{ code: "status", ids: [4] }]);
    const servos = (report.servos ?? []).map((servo) => (servo.id === 2 ? { ...servo, status: 1, phase: 0x1c } : servo));
    const settings = (report.settings ?? []).map((row) => (row.id === 6 && row.address === 16 ? { ...row, held: 1000 } : row));
    const all = armingBlockers({ ...report, stop: "line-lost", servos, settings, guard: { passed: {}, refused: 1 } }, null);
    expect(all.map(({ code }) => code)).toEqual(["stop", "settings", "status", "phase", "guard"]);
    // Maximum_Acceleration is no blocker whatever the servo holds, and the guard is given PEAR's value for it
    const lost = (report.settings ?? []).map((row) => (row.address === 85 ? { ...row, held: 0 } : row));
    expect(armingBlockers({ ...report, settings: lost }, null)).toEqual([]);
    const allowed = guardSettings(lost);
    expect(Object.keys(allowed)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(allowed[1]?.find(({ address }) => address === 85)?.value).toBe(254);
    expect(allowed[1]?.map(({ address }) => address).sort((a, b) => a - b)).toEqual([7, 21, 22, 23, 33, 85]);
    expect(allowed[6]?.map(({ address }) => address).sort((a, b) => a - b)).toEqual([7, 16, 21, 22, 23, 28, 33, 36, 85]);
  });

  it("takes an answer only when it names the request that waits", async () => {
    const naming = bench();
    const { enabling } = await armed(naming);
    const told = armingOf(naming.events) as Arming;
    await expect(naming.ask({ type: "arm", requestId: told.requestId + 1, isConfirmed: true })).rejects.toThrow(
      "This answer names another enabling of a real arm than the one that waits",
    );
    await naming.clock.sleep(1);
    expect(naming.guardState()).toBe("reads"); // the answer to another request armed nothing
    expect(naming.packets.filter((packet) => !isReading(packet))).toEqual([]);
    await naming.ask({ type: "arm", requestId: told.requestId, isConfirmed: false });
    expect((await enabling).outcome).toBe("refused");
    expect(naming.isPortClosed()).toBe(true);
  });

  it("is refused by the operator: the answer no, a stop, a hidden page, and no answer within the limit", async () => {
    const refusing = bench();
    const { enabling } = await armed(refusing);
    await refusing.clock.sleep(1);
    expect(refusing.guardState()).toBe("reads"); // while the operator has not answered
    await refusing.ask(answerOf(refusing, false));
    expect((await enabling).outcome).toBe("refused");
    expect((await enabling).report.isClosed).toBe(true);
    expect(refusing.isPortClosed()).toBe(true);
    expect(refusing.packets.filter((packet) => !isReading(packet))).toEqual([]);

    for (const request of [{ type: "stop" }, { type: "visibility", isHidden: true }] as StationRequest[]) {
      // the limit is a minute away, so that it cannot be what refuses: the request must end within a second
      const b = bench({ armingLimitMs: 60_000 });
      const waiting = await armed(b);
      expect(b.guardState()).toBe("reads");
      await b.ask(request);
      const result = await Promise.race([
        waiting.enabling,
        new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), 1000)),
      ]);
      if (result === "still waiting") throw new Error(`The enabling still waits for an answer after ${request.type}`);
      expect(result).toMatchObject({ outcome: "refused", blockers: [], openMs: null });
      expect(result.report.isClosed).toBe(true);
      expect(b.isPortClosed()).toBe(true);
      expect(b.packets.filter((packet) => !isReading(packet))).toEqual([]);
    }

    // the request "arm" is never sent: the limit refuses
    const silent = bench({ armingLimitMs: 30 });
    const result = await ended(silent, {}, "refused");
    expect(result.blockers).toEqual([]);
  });
});

describe("the station on a real arm's line: what fails, and the rules of state", () => {
  it("rejects with the robot's error when PEAR's enable fails: torque off, the port closed, and a warning says so", { timeout: 120_000 }, async () => {
    const b = bench();
    // the wrist's roll, whose calibrated range begins at zero, stands five steps below it: outside PEAR's bounds
    for (const motor of MOTORS) b.arm.setPosition(motor, motor === "wrist_roll" ? -5 : SIM_START_POSITIONS[motor]);
    const before = keptOf(b.arm);
    const { enabling, arming } = await armed(b);
    expect(arming.blockers).toEqual([]);
    await b.ask(answerOf(b, true));
    await expect(enabling).rejects.toThrow("outside commissioned bounds: wrist_roll=");
    expect(b.guardState()).toBe("reads");
    expect(torqueOf(b.arm)).toEqual(MOTORS.map(() => false));
    expect(b.isPortClosed()).toBe(true);
    expect(warningsOf(b.events).filter((message) => message.includes("The robot did not open on the real arm; its port is closed"))).toHaveLength(1);
    expect(keptOf(b.arm)).toEqual(before);
    expect([...new Set(b.packets.map(keyOf))].every((key) => ROWS.includes(key))).toBe(true);
    expect((await b.status()).robot).toBe("OFF");

    // the station is free again: the same arm, put into its range, is enabled
    b.arm.setPosition("wrist_roll", SIM_START_POSITIONS.wrist_roll);
    b.events.length = 0;
    expect((await enabled(b)).outcome).toBe("enabled");
    expect(await b.ask<DisableResult>({ type: "disable" })).toEqual({ positions: {}, isLineClosed: true });
  });

  it("refuses what does not fit its state, and offers no single action on a real arm", { timeout: 120_000 }, async () => {
    const b = bench();
    await expect(b.ask(answerOf(b, true))).rejects.toThrow("No enabling of a real arm waits for a confirmation");
    const { enabling } = await armed(b);
    // while it waits for the operator: no other enabling, no preflight, no simulated arm
    await expect(b.ask(enableReal())).rejects.toThrow("Another enabling of a real arm is under way");
    await expect(b.ask({ type: "preflight", source: "granted", usb: USB, expected: printOf(SIM_CALIBRATION), isHidden: false })).rejects.toThrow(
      "The enabling of a real arm is under way",
    );
    await expect(b.ask({ type: "enable", positions: SIM_START_POSITIONS, isHidden: false })).rejects.toThrow("The enabling of a real arm is under way");
    await expect(b.ask({ type: "home" })).rejects.toThrow("Open the station first");
    expect(b.packets.filter((packet) => !isReading(packet))).toEqual([]);
    expect(b.guardState()).toBe("reads");
    await b.ask(answerOf(b, true));
    expect((await enabling).outcome).toBe("enabled");

    // while the real arm is held
    await expect(b.ask(answerOf(b, true))).rejects.toThrow("No enabling of a real arm waits for a confirmation");
    await expect(b.ask(enableReal())).rejects.toThrow("Station already open");
    await expect(b.ask({ type: "preflight", source: "granted", usb: USB, expected: printOf(SIM_CALIBRATION), isHidden: false })).rejects.toThrow("Station already open");
    await expect(b.ask({ type: "enable", positions: SIM_START_POSITIONS, isHidden: false })).rejects.toThrow("Station already open");
    const goals = (): number => b.packets.filter((packet) => keyOf(packet) === "SYNC WRITE 42").length;
    const action = { type: "single_arm_delta", arm: { x: 0.01, y: 0, z: 0, pitch: 0, roll: 0 }, gripper: { width: 0 } };
    await expect(b.ask({ type: "jog", action })).rejects.toThrow("Single actions are not offered on a real arm in this version");
    expect((await b.status()).action).toBeNull();
    expect(goals()).toBeGreaterThan(0);

    expect(await b.ask<DisableResult>({ type: "disable" })).toEqual({ positions: {}, isLineClosed: true });
    await expect(b.ask({ type: "disable" })).rejects.toThrow("Open the station first");
    expect(torqueOf(b.arm)).toEqual(MOTORS.map(() => false));
  });

  it("faults by itself when the cable is pulled, says the line is lost, and still disables", { timeout: 120_000 }, async () => {
    const b = bench();
    expect((await enabled(b)).outcome).toBe("enabled");
    expect((await b.status()).line?.isLost).toBe(false);
    b.port.unplug();
    let status = await b.status();
    for (let waits = 0; status.robot !== "FAULT" && waits < 500; waits++) {
      await b.clock.sleep(0.05);
      status = await b.status();
    }
    expect(status.robot).toBe("FAULT");
    expect(status.arm).toBe("real");
    expect(status.line?.isLost).toBe(true);

    const disabled = await b.ask<DisableResult>({ type: "disable" });
    expect(disabled.positions).toEqual({});
    expect(disabled.isLineClosed).toBe(b.isPortClosed());
    expect(await b.status()).toMatchObject({ robot: "OFF", arm: null, line: null });
    await expect(b.ask({ type: "home" })).rejects.toThrow("Open the station first");
    // the servos could not be told: they keep their torque, which the status has said by `isLost`
    expect(torqueOf(b.arm)).toEqual(MOTORS.map(() => true));
  });
});
