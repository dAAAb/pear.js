// The station on a real arm's line (the requests "enableReal" and "arm" of web/src/station_host.ts), in Node and
// on simulated ports: the same requests the window sends, answered by the same code the Worker runs, with a
// simulated arm's port in place of the port the page was granted. Every packet such a port is given is recorded
// where the simulated servos take it, beneath the port, the transport and the guard: what the tests say of
// writing is said of what reached the servos.
//
// No test needs real time or asserts a time: the robot, its line, its guard and the timing self-check keep one
// clock of the test's own, on which time passes only while everything waits for it.

import { afterEach, describe, expect, it } from "vitest";

import { getAddress, MODEL_NUMBER_VALUE, type MotorCalibration, protocol, type RegisterName } from "../../src/feetech/index";
import { CONTROL_TABLE } from "../../src/feetech/tables";
import { MOTORS, type MotorName } from "../../src/so101/hardware/index";
import type { MonotonicClock } from "../../src/station/joint/clock";
import { SIM_CALIBRATION, SIM_START_POSITIONS, SimArm, type SimScenario, simulatedConfiguredPort, simulatedGrantedPort } from "../../web/src/sim_port";
import { GOAL_STEP_LIMIT, type StationGuardTransport } from "../../web/src/station_guard";
import { armingBlockers, ENABLE_SETTINGS, GRIPPER_SETTINGS, guardSettings, StationHost } from "../../web/src/station_host";
import type {
  ActionReport,
  ArmFingerprint,
  DisableResult,
  EnableRealResult,
  FromStation,
  HomeResult,
  PreflightReport,
  PreflightSetting,
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

/** Where a servo's EEPROM area ends: the registers below this address survive a power cycle. */
const EEPROM_END = 40;

/** Every byte of the control table of every servo of `arm`, by the servo's id. */
const tablesOf = (arm: SimArm): Record<number, number[]> =>
  Object.fromEntries(MOTORS.map((motor) => [arm.servo(motor).id, [...arm.servo(motor).registers]]));

/** The bytes that are not the same in two such readings, each as "<id> <address>", in the order of the servos. */
const changedBetween = (before: Record<number, number[]>, after: Record<number, number[]>): string[] =>
  Object.entries(before).flatMap(([id, bytes]) =>
    bytes.flatMap((byte, address) => (byte === (after[Number(id)] as number[])[address] ? [] : [`${id} ${address}`])),
  );

/** Whether such a byte is in the EEPROM area. */
const isEepromByte = (key: string): boolean => Number(key.split(" ")[1]) < EEPROM_END;

/** The rows of a report that PEAR's enable changes: the servo holds another value than PEAR writes. */
const differingOf = (report: PreflightReport): PreflightSetting[] => (report.settings ?? []).filter(({ held, pear }) => held !== pear);

/** The bytes of a row's register, each as "<id> <address>". */
const bytesOf = ({ id, address, bytes }: PreflightSetting): string[] => Array.from({ length: bytes }, (_, index) => `${id} ${address + index}`);

/** The motor whose servo has the id `id`. */
const motorOf = (id: number): MotorName => MOTORS.find((motor) => SIM_CALIBRATION[motor].id === id) as MotorName;

interface Bench {
  arm: SimArm;
  port: ReturnType<typeof simulatedGrantedPort>;
  /** Every packet the simulated servos were given, in their order. */
  packets: Uint8Array[];
  /** The guard of the line the station opened last, as the station hands it out; null before a line is opened. */
  guard: () => StationGuardTransport | null;
  /** The state of that guard; null before a line is opened. */
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
   * until the test ends or the camera is stopped: PEAR's Home and a single action refuse to start without a fresh
   * frame of the wrist camera. With `hasFrames` false the window says that its camera runs and sends no frame. */
  startCamera: (options?: { hasFrames?: boolean }) => void;
  /** Ends the frames. With `isTold` the window also says that its camera has stopped, as when the operator stops
   * it; without, the window still says that the camera runs, as when its frames stop coming. */
  stopCamera: (isTold: boolean) => void;
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
  let lineGuard: StationGuardTransport | null = null;
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
    { clock, armingLimitMs: options.armingLimitMs ?? 4000, onGuard: (guard) => (lineGuard = guard) },
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
    guard: () => lineGuard,
    guardState: () => lineGuard?.state ?? null,
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
    stopCamera: (isTold) => {
      for (const camera of cameras) camera.isRunning = false;
      if (isTold) host.handle({ kind: "camera", isRunning: false });
    },
    startCamera: (options = {}) => {
      const camera = { isRunning: options.hasFrames !== false };
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

/** One action of the model's format as the page sends it, for a step by hand and for what a model asked: a step
 * of the arm (cm and rad) and a change of the gripper's width (cm), under the name the format's parser gives it. */
const delta = (arm: Partial<Record<"x" | "y" | "z" | "pitch" | "roll", number>> = {}, width = 0): Record<string, unknown> => ({
  type: "single_arm_delta",
  arm: { x: 0, y: 0, z: 0, pitch: 0, roll: 0, ...arm },
  gripper: { width },
});

/** The goals of a SYNC WRITE of Goal_Position, by the servo's id; none for any other packet. A packet is the
 * header, the id of all servos, a length, the instruction, the address and the bytes of one goal; then an id and
 * a word for each servo; then the checksum. */
function goalsIn(packet: Uint8Array): Map<number, number> {
  const goals = new Map<number, number>();
  if (keyOf(packet) !== "SYNC WRITE 42") return goals;
  for (let at = 7; at + 2 < packet.length - 1; at += 3) {
    const word = protocol.makeWord(packet[at + 1] as number, packet[at + 2] as number);
    goals.set(packet[at] as number, (word & 0x8000) === 0 ? word : -(word & 0x7fff));
  }

  return goals;
}

/** The goal each servo was given last in `packets`, by its motor's name. */
function lastGoalsOf(packets: readonly Uint8Array[]): Partial<Record<MotorName, number>> {
  const last: Partial<Record<MotorName, number>> = {};
  for (const packet of packets) for (const [servo, goal] of goalsIn(packet)) last[motorOf(servo)] = goal;

  return last;
}

/** The largest step between two goals that one servo was given one after the other in `packets`, in steps: what
 * the guard's rule against jumps compares with its limit. */
function largestGoalStep(packets: readonly Uint8Array[]): number {
  const last = new Map<number, number>();
  let largest = 0;
  for (const packet of packets) {
    for (const [servo, goal] of goalsIn(packet)) {
      largest = Math.max(largest, Math.abs(goal - (last.get(servo) ?? goal)));
      last.set(servo, goal);
    }
  }

  return largest;
}

/** For every packet of goals in `packets` after the first, the largest step it asks of one servo from the goal
 * before it, in steps: the speed the goals ask for, period by period. */
function goalStepsOf(packets: readonly Uint8Array[]): number[] {
  const steps: number[] = [];
  const last = new Map<number, number>();
  for (const packet of packets) {
    const goals = goalsIn(packet);
    if (goals.size === 0) continue;
    if (last.size > 0) steps.push(Math.max(...[...goals].map(([servo, goal]) => Math.abs(goal - (last.get(servo) ?? goal)))));
    for (const [servo, goal] of goals) last.set(servo, goal);
  }

  return steps;
}

/** How many packets of goals are in `packets`. */
const goalCount = (packets: readonly Uint8Array[]): number => packets.filter((packet) => keyOf(packet) === "SYNC WRITE 42").length;

/** What the servos were given that is no read, as the guard counts it, each kind once. */
const writesOf = (packets: readonly Uint8Array[]): string[] => [...new Set(packets.filter((packet) => !isReading(packet)).map(keyOf))].sort();

/** Where every servo of `arm` stands, in steps. */
const stepsOf = (arm: SimArm): Record<MotorName, number> =>
  Object.fromEntries(MOTORS.map((motor) => [motor, arm.servo(motor).get("Present_Position")])) as Record<MotorName, number>;

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

  it("takes the Worker's own simulated ports: a configured one is enabled, and one lerobot never ran once its list is confirmed", { timeout: 120_000 }, async () => {
    const configured = bench();
    const starting = configured.ask<EnableRealResult>(enableReal({ source: "simulated-configured" }));
    await configured.until(() => armingOf(configured.events) !== undefined, "the event arming");
    expect(armingOf(configured.events)?.blockers).toEqual([]);
    await configured.ask(answerOf(configured, true));
    expect((await starting).outcome).toBe("enabled");
    expect((await configured.status()).arm).toBe("real");
    expect(await configured.ask<DisableResult>({ type: "disable" })).toEqual({ positions: {}, isLineClosed: true });
    expect(configured.packets).toEqual([]); // the port of the test's own was never taken

    // one lerobot never ran is not blocked: its report lists what PEAR's enable changes, in the EEPROM as well,
    // and it is enabled once that list is confirmed
    const plain = bench();
    const waiting = await armed(plain, { source: "simulated" });
    expect(waiting.arming.blockers).toEqual([]);
    expect(differingOf(waiting.arming.report).filter(({ area }) => area === "eeprom").length).toBeGreaterThan(0);
    expect(Object.keys(waiting.arming.report.guard.passed).sort()).toEqual(["PING", "READ", "SYNC READ"]);
    await plain.ask(answerOf(plain, true));
    const result = await waiting.enabling;
    expect(result.outcome).toBe("enabled");
    expect(result.blockers).toEqual([]);
    expect(await plain.status()).toMatchObject({ arm: "real", robot: "READY", line: { refused: 0, refusals: [] } });
    expect(await plain.ask<DisableResult>({ type: "disable" })).toEqual({ positions: {}, isLineClosed: true });
    expect(plain.packets).toEqual([]); // the port of the test's own was never taken

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

  it("does not block servos lerobot never ran: it tells every row PEAR's enable would change, and nothing changes while the operator has not confirmed", async () => {
    const b = bench({ isConfigured: false, armingLimitMs: 60_000 });
    const before = tablesOf(b.arm);
    const { enabling, arming } = await armed(b);
    expect(arming.blockers).toEqual([]);

    // the rows that differ show what each servo holds beside what PEAR writes: the factory's gain in every servo
    const rows = differingOf(arming.report);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(b.arm.servo(motorOf(row.id)).get(row.register as RegisterName)).toBe(row.held);
    expect(rows.filter(({ register }) => register === "P_Coefficient").map(({ id, area, held, pear }) => ({ id, area, held, pear }))).toEqual(
      [1, 2, 3, 4, 5, 6].map((id) => ({ id, area: "eeprom", held: 32, pear: 16 })),
    );
    expect(rows.some(({ id, register, held, pear }) => id === 6 && register === "Max_Torque_Limit" && held === 1000 && pear === 500)).toBe(true);

    // until the answer the port was given reads only, and no register of any servo has changed
    await b.clock.sleep(5);
    expect(b.guardState()).toBe("reads");
    expect(b.guard()?.counts.refused).toBe(0);
    expect(b.packets.length).toBeGreaterThan(200);
    expect(b.packets.filter((packet) => !isReading(packet))).toEqual([]);
    expect(changedBetween(before, tablesOf(b.arm))).toEqual([]);
    expect(torqueOf(b.arm)).toEqual(MOTORS.map(() => false));
    // and none could have: while the answer is not given, the guard refuses PEAR's own value for a listed row
    const pearsWrite = protocol.writePacket(1, 21, [16]);
    await expect((b.guard() as StationGuardTransport).write(pearsWrite)).rejects.toMatchObject({ reason: "reads-only" });
    expect(b.arm.servo("shoulder_pan").get("P_Coefficient")).toBe(32);

    // Cancel: nothing was written, and every register is as before
    await b.ask(answerOf(b, false));
    const result = await enabling;
    expect(result).toMatchObject({ outcome: "refused", blockers: [], openMs: null });
    expect(result.report.isClosed).toBe(true);
    expect(differingOf(result.report)).toEqual(rows);
    expect(b.isPortClosed()).toBe(true);
    expect(b.guardState()).toBe("reads");
    expect(b.packets.filter((packet) => !isReading(packet))).toEqual([]);
    expect(changedBetween(before, tablesOf(b.arm))).toEqual([]);

    // no answer within the limit: the same
    const silent = bench({ isConfigured: false, armingLimitMs: 30 });
    const silentBefore = tablesOf(silent.arm);
    const unanswered = await ended(silent, {}, "refused");
    expect(unanswered.blockers).toEqual([]);
    expect(differingOf(unanswered.report)).toEqual(rows);
    expect(changedBetween(silentBefore, tablesOf(silent.arm))).toEqual([]);
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

  it("gives every blocker of a report, in a fixed order, and the guard's refusals among them (guard); a setting that differs is none", async () => {
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
    expect(all.map(({ code }) => code)).toEqual(["stop", "status", "phase", "guard"]);
    // a setting PEAR's enable would change is no blocker, whatever the servo holds and wherever it keeps it
    expect(armingBlockers({ ...report, settings }, null)).toEqual([]);
    const lost = (report.settings ?? []).map((row) => ({ ...row, held: row.pear + 1 }));
    expect(armingBlockers({ ...report, settings: lost }, null)).toEqual([]);
    // and the guard is given PEAR's value for each one, not the value the servo holds
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

describe("servos that hold other settings than PEAR's: PEAR's enable changes them, and only once the operator has confirmed the list", () => {
  /** Enables the station on an arm lerobot never ran, with the operator's confirmation; gives what the servos held
   * before anything was read, the rows that were told to differ, and how many packets the reads were. */
  async function enabledUnconfigured(): Promise<{
    b: Bench;
    before: Record<number, number[]>;
    rows: PreflightSetting[];
    readsBefore: number;
    result: EnableRealResult;
  }> {
    const b = bench({ isConfigured: false });
    const before = tablesOf(b.arm);
    const { enabling, arming } = await armed(b);
    expect(arming.blockers).toEqual([]);
    const rows = differingOf(arming.report);
    const readsBefore = b.packets.length;
    expect(b.packets.every(isReading)).toBe(true);
    expect(changedBetween(before, tablesOf(b.arm))).toEqual([]);
    await b.ask(answerOf(b, true));

    return { b, before, rows, readsBefore, result: await enabling };
  }

  it("enables such an arm once confirmed: READY, nothing refused, each listed row holds PEAR's value, and no other register of the EEPROM changed", { timeout: 120_000 }, async () => {
    const { b, before, rows, readsBefore, result } = await enabledUnconfigured();
    expect(result.outcome).toBe("enabled");
    expect(result.blockers).toEqual([]);
    expect(b.guardState()).toBe("station");
    expect(b.packets.slice(0, readsBefore).every(isReading)).toBe(true);
    const status = await b.status();
    expect(status).toMatchObject({ arm: "real", robot: "READY" });
    expect(status.line).toMatchObject({ refused: 0, refusals: [], lineErrors: 0, isLost: false });
    expect(torqueOf(b.arm)).toEqual(MOTORS.map(() => true));
    // PEAR's enable ends with every servo's Lock set: its EEPROM is closed again once the settings are written
    expect(MOTORS.map((motor) => b.arm.servo(motor).get("Lock"))).toEqual(MOTORS.map(() => 1));

    // each row that differed holds PEAR's value now, and so does every other row of the report
    expect(rows.filter(({ area }) => area === "eeprom").length).toBeGreaterThan(0);
    for (const { id, register, pear } of result.report.settings ?? []) {
      expect(`${id} ${register}: ${b.arm.servo(motorOf(id)).get(register as RegisterName)}`).toBe(`${id} ${register}: ${pear}`);
    }

    // of the EEPROM area (every address below 40 of every servo) nothing changed but bytes of the listed rows:
    // Return_Delay_Time (7) and P_Coefficient (21) of every servo, and of the gripper's servo Max_Torque_Limit
    // (16 and 17), Protection_Current (28) and Overload_Torque (36)
    const listed = rows.flatMap(bytesOf);
    const changed = changedBetween(before, tablesOf(b.arm)).filter(isEepromByte);
    expect(changed.filter((key) => !listed.includes(key))).toEqual([]);
    expect(changed).toEqual([...[1, 2, 3, 4, 5].flatMap((id) => [`${id} 7`, `${id} 21`]), "6 7", "6 16", "6 17", "6 21", "6 28", "6 36"]);
    // above it, the one register a servo may keep without power is a listed row as well
    expect(rows.filter(({ area }) => area === "factory").map(({ id, address }) => `${id} ${address}`)).toEqual([1, 2, 3, 4, 5, 6].map((id) => `${id} 85`));

    // Disable: the torque off, the port closed, and the EEPROM as the enable left it
    const afterEnable = tablesOf(b.arm);
    expect(await b.ask<DisableResult>({ type: "disable" })).toEqual({ positions: {}, isLineClosed: true });
    expect(b.isPortClosed()).toBe(true);
    expect(b.guardState()).toBe("reads");
    expect(torqueOf(b.arm)).toEqual(MOTORS.map(() => false));
    expect(await b.status()).toMatchObject({ robot: "OFF", arm: null, line: null });
    expect(changedBetween(afterEnable, tablesOf(b.arm)).filter(isEepromByte)).toEqual([]);
    expect([...new Set(b.packets.map(keyOf))].filter((key) => !ROWS.includes(key))).toEqual([]);
    expect(warningsOf(b.events)).toEqual([]);
  });

  it("gives the guard, for every setting of a report, the one value PEAR's enable writes, and no row that is no setting of the station", async () => {
    const b = bench({ isConfigured: false });
    const report = await b.ask<PreflightReport>({ type: "preflight", source: "granted", usb: USB, expected: printOf(SIM_CALIBRATION), isHidden: false });
    const settings = report.settings ?? [];
    expect(differingOf(report).length).toBeGreaterThan(0);
    const allowed = guardSettings(settings);
    expect(Object.keys(allowed)).toEqual(["1", "2", "3", "4", "5", "6"]);
    // Acceleration (41) is a row of the report and no setting: the guard knows that register by itself
    const given = settings.filter(({ address }) => address !== 41);
    expect(given.length).toBe(settings.length - 6);
    for (const id of [1, 2, 3, 4, 5, 6]) {
      expect(allowed[id]).toEqual(given.filter((row) => row.id === id).map(({ address, bytes, pear }) => ({ address, bytes, value: pear })));
    }
    // whatever the servos hold: the values given do not follow `held`
    expect(guardSettings(settings.map((row) => ({ ...row, held: row.pear === 0 ? 1 : 0 })))).toEqual(allowed);
    // a row whose address is no setting of the station gives nothing, in the EEPROM or not
    const foreign: PreflightSetting[] = [
      { id: 3, register: "ID", address: 5, bytes: 1, area: "eeprom", pear: 9, held: 3 },
      { id: 3, register: "Homing_Offset", address: 31, bytes: 2, area: "eeprom", pear: 0, held: 100 },
      { id: 3, register: "Goal_Position", address: 42, bytes: 2, area: "ram", pear: 2048, held: 2048 },
    ];
    expect(guardSettings(foreign)).toEqual({ 3: [] });
    expect(guardSettings([...settings, ...foreign])).toEqual(allowed);
  });

  it("lets no other value through to a setting, and no other register of the EEPROM, while the station holds such an arm", { timeout: 120_000 }, async () => {
    const { b, result } = await enabledUnconfigured();
    expect(result.outcome).toBe("enabled");
    const guard = b.guard() as StationGuardTransport;
    const afterEnable = tablesOf(b.arm);
    const word = (value: number): number[] => protocol.splitIntoByteChunks(value, 2);
    const attempts: Array<[packet: Uint8Array, refusal: string]> = [
      [protocol.writePacket(1, 21, [32]), "value 1 21"], // what the servo held before PEAR's enable
      [protocol.writePacket(1, 21, [17]), "value 1 21"],
      [protocol.writePacket(4, 7, [250]), "value 4 7"],
      [protocol.writePacket(6, 16, word(1000)), "value 6 16"],
      [protocol.writePacket(6, 28, word(500)), "value 6 28"],
      [protocol.writePacket(1, 16, word(500)), "address 1 16"], // the gripper's setting, to another servo
      [protocol.writePacket(2, 5, [9]), "address 2 5"], // the servo's ID
      [protocol.writePacket(2, 31, word(100)), "address 2 31"], // Homing_Offset
    ];
    for (const [packet, refusal] of attempts) await expect(guard.write(packet)).rejects.toMatchObject({ reason: refusal.split(" ")[0] });
    expect(guard.status().refusals.map(({ reason, id, address }) => `${reason} ${id} ${address}`)).toEqual(attempts.map(([, refusal]) => refusal));
    const status = await b.status();
    expect(status.robot).toBe("READY"); // a refusal is told, and the station goes on
    expect(status.line?.refused).toBe(attempts.length);
    expect(status.line?.refusals.length).toBe(5); // the last five, in words

    // none of them reached the servos: the EEPROM is as the enable left it
    const sent = new Set(b.packets.map((packet) => packet.join(" ")));
    expect(attempts.filter(([packet]) => sent.has(packet.join(" ")))).toEqual([]);
    expect(changedBetween(afterEnable, tablesOf(b.arm)).filter(isEepromByte)).toEqual([]);
    expect(await b.ask<DisableResult>({ type: "disable" })).toEqual({ positions: {}, isLineClosed: true });
    expect(b.isPortClosed()).toBe(true);
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

  it("refuses what does not fit its state: a single action too, before the confirmation and after Disable", { timeout: 120_000 }, async () => {
    const b = bench();
    await expect(b.ask(answerOf(b, true))).rejects.toThrow("No enabling of a real arm waits for a confirmation");
    await expect(b.ask({ type: "jog", action: delta({ x: 1 }) })).rejects.toThrow("Open the station first");
    const { enabling } = await armed(b);
    // while it waits for the operator: no other enabling, no preflight, no simulated arm
    await expect(b.ask(enableReal())).rejects.toThrow("Another enabling of a real arm is under way");
    await expect(b.ask({ type: "preflight", source: "granted", usb: USB, expected: printOf(SIM_CALIBRATION), isHidden: false })).rejects.toThrow(
      "The enabling of a real arm is under way",
    );
    await expect(b.ask({ type: "enable", positions: SIM_START_POSITIONS, isHidden: false })).rejects.toThrow("The enabling of a real arm is under way");
    await expect(b.ask({ type: "home" })).rejects.toThrow("Open the station first");
    await expect(b.ask({ type: "jog", action: delta({ x: 1 }) })).rejects.toThrow("Open the station first");
    expect(b.packets.filter((packet) => !isReading(packet))).toEqual([]);
    expect(b.guardState()).toBe("reads");
    await b.ask(answerOf(b, true));
    expect((await enabling).outcome).toBe("enabled");

    // while the real arm is held
    await expect(b.ask(answerOf(b, true))).rejects.toThrow("No enabling of a real arm waits for a confirmation");
    await expect(b.ask(enableReal())).rejects.toThrow("Station already open");
    await expect(b.ask({ type: "preflight", source: "granted", usb: USB, expected: printOf(SIM_CALIBRATION), isHidden: false })).rejects.toThrow("Station already open");
    await expect(b.ask({ type: "enable", positions: SIM_START_POSITIONS, isHidden: false })).rejects.toThrow("Station already open");
    // a single action is taken on a real arm as on the simulated one, and PEAR answers it: here, with no camera,
    // that it was not run; the station has written the goals of its enabling and no other
    const goalsHeld = goalCount(b.packets);
    expect(goalsHeld).toBeGreaterThan(0);
    const blind = await b.ask<ActionReport>({ type: "jog", action: delta({ x: 1 }) });
    expect(blind.record).toMatchObject({
      status: "failed",
      error: { code: "RuntimeError", message: "Camera unavailable: {'wrist': 'Camera reader stopped; reconnect the camera'}" },
    });
    expect((await b.status()).action).toBeNull();
    expect(goalCount(b.packets)).toBe(goalsHeld);

    expect(await b.ask<DisableResult>({ type: "disable" })).toEqual({ positions: {}, isLineClosed: true });
    await expect(b.ask({ type: "disable" })).rejects.toThrow("Open the station first");
    expect(torqueOf(b.arm)).toEqual(MOTORS.map(() => false));
    // after Disable: refused, and nothing is sent on a line that is closed
    const sent = b.packets.length;
    await expect(b.ask({ type: "jog", action: delta({ x: 1 }) })).rejects.toThrow("Open the station first");
    await b.clock.sleep(1);
    expect(b.packets.length).toBe(sent);
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

/** The most a servo's goal may change from one goal to the next in the tests of single actions: half of what the
 * guard lets through. PEAR's full speed comes to 14 steps for a joint of the arm and to 15 for the gripper. */
const FULL_SPEED_STEPS = GOAL_STEP_LIMIT / 2;

/** The format's report of an action that was run to its end, before what it says of the gripper. */
const RUN = '{"status": "completed", "execution_requested": true, "settled": true, "reached": true';
/** What the format's report ends with. */
const OBSERVE = " Use the new measured observation.";
/** The format's report of an action that failed with PEAR's error `message`: `isSettled` says whether the arm was
 * at rest then. */
const failedWith = (message: string, isSettled: boolean): string =>
  `{"status": "failed", "execution_requested": true, "settled": ${isSettled}, "reached": false, "error": {"code": "RuntimeError", "message": "${message}"}}${OBSERVE}`;

/** A new bench whose station holds its arm with the wrist camera running: enabled with the operator's
 * confirmation and, with `isHomed`, brought Home with the plan approved. */
async function holding(options: { isHomed?: boolean } = {}): Promise<Bench> {
  const b = bench();
  expect((await enabled(b)).outcome).toBe("enabled");
  b.startCamera();
  await b.clock.sleep(0.2);
  if (options.isHomed === true) {
    const home = b.ask<HomeResult>({ type: "home" });
    await b.until(() => plansOf(b.events) === 1, "the Home plan");
    await b.ask({ type: "approve", isApproved: true });
    expect((await home).results).toMatchObject({ reached: true, gripper_open: true });
  }

  return b;
}

/** What one single action did on the line of a bench. */
interface Single {
  /** PEAR's report, as the request "jog" answers it. */
  report: ActionReport;
  /** The packets the servos were given while the request ran. */
  packets: Uint8Array[];
  /** What the station told meanwhile. */
  events: StationEvent[];
}

/** Asks the station of `b` for the single action `action` and waits for its answer. */
async function single(b: Bench, action: Record<string, unknown>): Promise<Single> {
  const from = b.packets.length;
  const told = b.events.length;
  const report = await b.ask<ActionReport>({ type: "jog", action });

  return { report, packets: b.packets.slice(from), events: b.events.slice(told) };
}

type Frame = Extract<StationEvent, { type: "frame" }>;
const framesOf = (events: readonly StationEvent[]): Frame[] => events.filter((event): event is Frame => event.type === "frame");
const phasesOf = (events: readonly StationEvent[]): string[] => events.flatMap((event) => (event.type === "phase" ? [event.phase] : []));

/** Holds that the station of `b` holds the arm, once it is at rest: ready, no action, no fault, the torque of
 * every servo on, every servo where its last goal is, nothing refused by the guard and no goal in the whole record
 * far from the goal before it; and that the station writes nothing while it holds. Gives the status at rest. */
async function expectHolding(b: Bench): Promise<StationStatus> {
  let status = await b.status();
  for (let waits = 0; (status.robot !== "READY" || status.control !== "HOLD") && waits < 500; waits++) {
    await b.clock.sleep(0.05);
    status = await b.status();
  }
  expect(status).toMatchObject({ robot: "READY", control: "HOLD", action: null, fault: null, arm: "real" });
  expect(status.line).toMatchObject({ refused: 0, refusals: [], lineErrors: 0, isLost: false });
  expect(torqueOf(b.arm)).toEqual(MOTORS.map(() => true));
  expect(lastGoalsOf(b.packets)).toEqual(stepsOf(b.arm));
  expect(largestGoalStep(b.packets)).toBeLessThanOrEqual(FULL_SPEED_STEPS);
  const from = b.packets.length;
  await b.clock.sleep(1);
  expect(writesOf(b.packets.slice(from))).toEqual([]);

  return status;
}

/** Holds that the arm's point moved between two statuses by `by` and by nothing else, as the model reads its
 * state: centimetres to one decimal and radians to two, so a quantity may differ by one in its last digit. */
function expectMoved(from: StationStatus, to: StationStatus, by: Partial<Record<"x" | "y" | "z", number>>): void {
  for (const name of ["x", "y", "z"] as const) {
    expect(Math.abs((to.state?.arm[name] ?? NaN) - (from.state?.arm[name] ?? NaN) - (by[name] ?? 0)), name).toBeLessThan(0.15);
  }
  for (const name of ["pitch", "roll"] as const) {
    expect(Math.abs((to.state?.arm[name] ?? NaN) - (from.state?.arm[name] ?? NaN)), name).toBeLessThan(0.015);
  }
}

/** Holds that the next turn's text of `report` gives the state the station measures at rest after the action,
 * which the record holds as well, and then the report of the action. */
function expectNextTurn(report: ActionReport, atRest: StationStatus): void {
  expect(report.record["measured_state"]).toEqual(atRest.state);
  expect(JSON.parse((report.turnText ?? "").split("\n")[0] as string)).toEqual(atRest.state);
  expect(report.turnText?.endsWith(`\n\nPrevious execution: ${report.feedback}`)).toBe(true);
}

describe("a single action on a real arm's line: one action of the model's format, started by the operator", () => {
  it("runs a step by hand, closes the gripper and opens it: PEAR's report each time, goals the only writes, nothing refused, and the station holds", { timeout: 120_000 }, async () => {
    const b = await holding();
    const kept = keptOf(b.arm);
    const start = await expectHolding(b);
    const stepsAtStart = stepsOf(b.arm);

    // one centimetre forward: the arm at rest, an observation with the camera's frame, the move, PEAR's report
    const step = await single(b, delta({ x: 1 }));
    expect(step.report.record).toMatchObject({ status: "completed", settled: true, reached: true, gripper_outcome: null, error: null });
    expect(step.report.feedback).toBe(`${RUN}}${OBSERVE}`);
    expect(writesOf(step.packets)).toEqual(["SYNC WRITE 42"]);
    expect(phasesOf(step.events)).toEqual(["Planning", "Executing"]);
    const frames = framesOf(step.events);
    expect(frames).toHaveLength(1);
    expect([...(frames[0] as Frame).jpeg]).toEqual(FRAME);
    expect((frames[0] as Frame).ageMs).toBeLessThanOrEqual(200);
    const stepped = await expectHolding(b);
    expectNextTurn(step.report, stepped);
    expectMoved(start, stepped, { x: 1 });
    expect(stepped.state?.gripper).toEqual(start.state?.gripper);
    const stepsStepped = stepsOf(b.arm);
    expect(MOTORS.filter((motor) => stepsStepped[motor] !== stepsAtStart[motor])).toEqual(["shoulder_lift", "elbow_flex", "wrist_flex"]);

    // the gripper closed: the format takes any narrower width for "close"; no other joint is given another goal
    const closing = await single(b, delta({}, -1));
    expect(closing.report.record).toMatchObject({ status: "completed", settled: true, reached: true, error: null });
    expect(closing.report.feedback).toBe(`${RUN}, "gripper": "closed"}${OBSERVE}`);
    expect(writesOf(closing.packets)).toEqual(["SYNC WRITE 42"]);
    const closed = await expectHolding(b);
    expectNextTurn(closing.report, closed);
    expect(closed.state).toEqual({ arm: stepped.state?.arm, gripper: { width: 0 } });
    const stepsClosed = stepsOf(b.arm);
    expect(stepsClosed.gripper).toBeLessThan(stepsStepped.gripper - 1000);
    expect({ ...stepsClosed, gripper: stepsStepped.gripper }).toEqual(stepsStepped);

    // and opened again: every servo is back where it stood before the gripper closed
    const opening = await single(b, delta({}, 1));
    expect(opening.report.record).toMatchObject({ status: "completed", settled: true, reached: true, error: null });
    expect(opening.report.feedback).toBe(`${RUN}, "gripper": "open"}${OBSERVE}`);
    expect(writesOf(opening.packets)).toEqual(["SYNC WRITE 42"]);
    const opened = await expectHolding(b);
    expectNextTurn(opening.report, opened);
    expect(opened.state).toEqual(stepped.state);
    expect(stepsOf(b.arm)).toEqual(stepsStepped);

    // nothing a servo keeps has changed, the guard's rows were all that reached the servos, and nothing warned
    expect(keptOf(b.arm)).toEqual(kept);
    expect([...new Set(b.packets.map(keyOf))].every((key) => ROWS.includes(key))).toBe(true);
    expect(warningsOf(b.events)).toEqual([]);
  });

  it("leaves a large action to PEAR's own checks: 15 cm down from Home is run, at PEAR's speed and far under the guard's limit for a goal's step; out of reach and out of the format are rejected, and nothing moves", { timeout: 120_000 }, async () => {
    const b = await holding({ isHomed: true });
    const home = await expectHolding(b);

    // PEAR runs it: its checks know reach and bounds, and no limit of a single action's length
    const down = await single(b, delta({ z: -15 }));
    expect(down.report.record).toMatchObject({ status: "completed", settled: true, reached: true, error: null });
    expect(down.report.feedback).toBe(`${RUN}}${OBSERVE}`);
    expect(writesOf(down.packets)).toEqual(["SYNC WRITE 42"]);
    expect(goalCount(down.packets)).toBeGreaterThan(100);
    // at full speed a servo's goal changes by 14 steps from one goal to the next: the guard refuses over 40
    expect(largestGoalStep(down.packets)).toBeGreaterThanOrEqual(10);
    expect(largestGoalStep(down.packets)).toBeLessThanOrEqual(FULL_SPEED_STEPS);
    const low = await expectHolding(b);
    expectNextTurn(down.report, low);
    expectMoved(home, low, { z: -15 });
    const stepsLow = stepsOf(b.arm);

    // out of reach, with the gripper asked to close: rejected by PEAR, nothing written, the gripper still open
    const far = await single(b, delta({ x: 60 }, -1));
    expect(far.report.record["status"]).toBe("rejected");
    expect(far.report.feedback).toContain('{"status": "rejected", "moved": false, "error": {"code": "out_of_reach", "message": "Nothing moved: the whole action was discarded (arm and gripper). The target is out of reach.');
    expect(far.report.turnText?.endsWith(`\n\nPrevious execution: ${far.report.feedback}`)).toBe(true);
    expect(writesOf(far.packets)).toEqual([]);
    expect(stepsOf(b.arm)).toEqual(stepsLow);
    expect((await expectHolding(b)).state).toEqual(low.state);

    // the model's JSON before the format's parser has named it: no action of PEAR's, rejected, nothing written
    const unnamed = await single(b, { arm: { x: 1, y: 0, z: 0, pitch: 0, roll: 0 }, gripper: { width: 0 } });
    expect(unnamed.report.record).toMatchObject({ status: "rejected", error: { code: "ValidationError" } });
    expect(writesOf(unnamed.packets)).toEqual([]);
    expect(stepsOf(b.arm)).toEqual(stepsLow);

    // and up again, as far: the guard refused nothing of either move
    const up = await single(b, delta({ z: 15 }));
    expect(up.report.record).toMatchObject({ status: "completed", settled: true, reached: true, error: null });
    expect(largestGoalStep(up.packets)).toBeLessThanOrEqual(FULL_SPEED_STEPS);
    expectMoved(home, await expectHolding(b), {});

    // several quantities at once, with the gripper closing: every joint is given goals, and nothing but goals
    const every = await single(b, delta({ x: 3, y: 5, z: -5, roll: 1 }, -1));
    expect(every.report.record).toMatchObject({ status: "completed", settled: true, reached: true, error: null });
    expect(every.report.feedback).toBe(`${RUN}, "gripper": "closed"}${OBSERVE}`);
    expect(writesOf(every.packets)).toEqual(["SYNC WRITE 42"]);
    expect(largestGoalStep(every.packets)).toBeLessThanOrEqual(FULL_SPEED_STEPS);
    const stepsAfter = stepsOf(b.arm);
    expect(MOTORS.filter((motor) => stepsAfter[motor] !== stepsLow[motor])).toEqual([...MOTORS]);
    await expectHolding(b);
    expect(warningsOf(b.events)).toEqual([]);
  });

  it("brakes and holds when stopped during a single action: the record says that it was cancelled, the torque stays on, and the next action runs", { timeout: 120_000 }, async () => {
    const b = await holding();
    const start = await expectHolding(b);
    const from = b.packets.length;
    const moving = b.ask<ActionReport>({ type: "jog", action: delta({ z: -15 }) });
    await b.until(() => goalCount(b.packets.slice(from)) >= 30, "the arm moving");
    expect(await b.status()).toMatchObject({ robot: "BUSY", control: "RUNNING", action: "jog" });
    const stepsAtStop = stepsOf(b.arm);
    const sentAtStop = b.packets.length;

    await b.ask({ type: "stop" });
    const stopped = await moving;
    const cancelled = "Action cancelled by stop or another operation";
    expect(stopped.record).toMatchObject({ status: "failed", settled: false, reached: false, error: { code: "RuntimeError", message: cancelled } });
    expect(stopped.feedback).toBe(failedWith(cancelled, false));
    expect(stopped.turnText?.endsWith(`\n\nPrevious execution: ${stopped.feedback}`)).toBe(true);
    expect(await b.status()).toMatchObject({ robot: "BUSY", control: "STOPPING", action: null, fault: null });
    expect(torqueOf(b.arm)).toEqual(MOTORS.map(() => true));

    // while the arm brakes PEAR runs no action: its failed result, and the braking goes on
    const early = await single(b, delta({ z: 1 }));
    expect(early.report.record).toMatchObject({ status: "failed", reached: false, error: { code: "RuntimeError", message: "Station requires valid HOLD: STOPPING: None" } });
    expect(framesOf(early.events)).toEqual([]);

    // the braking ramp: goals and nothing else, no step larger than the one before it, down to none; the arm
    // rests where the last goal is
    const rest = await expectHolding(b);
    expect(writesOf(b.packets.slice(sentAtStop))).toEqual(["SYNC WRITE 42"]);
    const asked = goalStepsOf(b.packets.slice(from));
    const ramp = asked.slice(goalCount(b.packets.slice(from, sentAtStop)) - 1);
    expect(ramp.length).toBeGreaterThan(5);
    expect(ramp[0]).toBeGreaterThan(5);
    expect(ramp.every((step, index) => index === 0 || step <= (ramp[index - 1] as number))).toBe(true);
    expect(ramp[ramp.length - 1]).toBe(0);
    const stepsAtRest = stepsOf(b.arm);
    for (const motor of MOTORS) expect(Math.abs(stepsAtRest[motor] - stepsAtStop[motor]), motor).toBeLessThan(150);
    // 15 cm were asked for: the arm stands a few centimetres below where it began
    expect((rest.state?.arm.z ?? NaN) - (start.state?.arm.z ?? NaN)).toBeLessThan(-1);
    expect((rest.state?.arm.z ?? NaN) - (start.state?.arm.z ?? NaN)).toBeGreaterThan(-8);

    const next = await single(b, delta({ z: 1 }));
    expect(next.report.record).toMatchObject({ status: "completed", settled: true, reached: true, error: null });
    expectMoved(rest, await expectHolding(b), { z: 1 });
    expect(warningsOf(b.events)).toEqual([]);
  });

  it("runs no single action without a fresh frame of the wrist camera: PEAR's failed result, not one write, and the station still holds", { timeout: 120_000 }, async () => {
    const b = bench();
    expect((await enabled(b)).outcome).toBe("enabled");
    const steps = stepsOf(b.arm);
    const blind = async (why: string): Promise<void> => {
      const { report, packets, events } = await single(b, delta({ z: -3 }));
      const message = `Camera unavailable: {'wrist': '${why}'}`;
      expect(report.record).toMatchObject({ status: "failed", settled: true, reached: false, error: { code: "RuntimeError", message } });
      expect(report.feedback).toBe(failedWith(message, true));
      expect(report.turnText?.endsWith(`\n\nPrevious execution: ${report.feedback}`)).toBe(true);
      expect(writesOf(packets)).toEqual([]);
      expect(events.filter((event) => event.type === "frame" || event.type === "phase")).toEqual([]);
      expect(stepsOf(b.arm)).toEqual(steps);
      await expectHolding(b);
    };

    // the window has said nothing of a camera
    await blind("Camera reader stopped; reconnect the camera");
    // it says that its camera runs, and no frame has come
    b.startCamera({ hasFrames: false });
    await b.clock.sleep(0.3);
    await blind("Waiting for camera frames");
    // frames came, and the last is older than PEAR takes for fresh (0.2 s)
    b.startCamera();
    await b.clock.sleep(0.3);
    b.stopCamera(false);
    await b.clock.sleep(0.5);
    await blind("Camera frame is stale");
    // the window says that its camera has stopped
    b.startCamera();
    await b.clock.sleep(0.3);
    b.stopCamera(true);
    await blind("Camera reader stopped; reconnect the camera");

    // with a fresh frame the same action runs, and the station tells the frame its observation held
    b.startCamera();
    await b.clock.sleep(0.3);
    const seen = await single(b, delta({ z: -3 }));
    expect(seen.report.record).toMatchObject({ status: "completed", settled: true, reached: true, error: null });
    const frames = framesOf(seen.events);
    expect(frames).toHaveLength(1);
    expect([...(frames[0] as Frame).jpeg]).toEqual(FRAME);
    expect((frames[0] as Frame).ageMs).toBeLessThanOrEqual(200);
    await expectHolding(b);
    expect(warningsOf(b.events)).toEqual([]);
  });

  it("goes on to its end when the camera stops while the arm moves: the frame is asked for once, before the move", { timeout: 120_000 }, async () => {
    const b = await holding();
    const start = await expectHolding(b);
    const from = b.packets.length;
    const moving = b.ask<ActionReport>({ type: "jog", action: delta({ z: -10 }) });
    await b.until(() => goalCount(b.packets.slice(from)) >= 20, "the arm moving");
    b.stopCamera(true);
    const report = await moving;
    expect(report.record).toMatchObject({ status: "completed", settled: true, reached: true, error: null });
    expectMoved(start, await expectHolding(b), { z: -10 });

    // the next one is not run
    const blind = await single(b, delta({ z: 1 }));
    expect(blind.report.record).toMatchObject({ status: "failed", error: { message: "Camera unavailable: {'wrist': 'Camera reader stopped; reconnect the camera'}" } });
    expect(writesOf(blind.packets)).toEqual([]);
  });

  it("is refused while another single action or a Home is under way, and while the page is hidden: nothing is written for it", { timeout: 120_000 }, async () => {
    const b = await holding();
    const start = await expectHolding(b);
    const under = "Another action is under way";

    // while a single action moves the arm: no second one and no Home, and the first is run to its end
    let from = b.packets.length;
    const moving = b.ask<ActionReport>({ type: "jog", action: delta({ z: -10 }) });
    await b.until(() => goalCount(b.packets.slice(from)) >= 20, "the arm moving");
    await expect(b.ask({ type: "jog", action: delta({ x: 5 }) })).rejects.toThrow(under);
    await expect(b.ask({ type: "home" })).rejects.toThrow(under);
    expect((await b.status()).action).toBe("jog");
    expect((await moving).record).toMatchObject({ status: "completed", settled: true, reached: true, error: null });
    expectMoved(start, await expectHolding(b), { z: -10 });

    // while a Home waits for its plan's approval, and while it moves
    const home = b.ask<HomeResult>({ type: "home" });
    await b.until(() => plansOf(b.events) === 1, "the Home plan");
    from = b.packets.length;
    await expect(b.ask({ type: "jog", action: delta({ x: 5 }) })).rejects.toThrow(under);
    expect((await b.status()).action).toBe("home");
    expect(writesOf(b.packets.slice(from))).toEqual([]);
    await b.ask({ type: "approve", isApproved: true });
    await b.until(() => goalCount(b.packets.slice(from)) >= 20, "the arm going Home");
    await expect(b.ask({ type: "jog", action: delta({ x: 5 }) })).rejects.toThrow(under);
    expect((await home).results).toMatchObject({ reached: true, gripper_open: true });
    expectMoved(start, await expectHolding(b), {});

    // while the page is hidden
    await b.ask({ type: "visibility", isHidden: true });
    from = b.packets.length;
    await expect(b.ask({ type: "jog", action: delta({ x: 5 }) })).rejects.toThrow("The page is hidden: no action is started");
    expect(writesOf(b.packets.slice(from))).toEqual([]);
    expectMoved(start, await expectHolding(b), {});
    expect(warningsOf(b.events)).toEqual([]);
  });
});
