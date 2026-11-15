// Not in PEAR: what the page does with an arm in this first version, which only reads. It opens the port, runs
// the bus's handshake, tells which servo is missing or reports an error when the handshake fails, reads the
// calibration the servos hold, compares it with a calibration file as PEAR's start-up does, and then reads the
// joints about ten times a second.
//
// Everything that reaches the servos is the library's (src/feetech, src/so101/hardware) behind the read-only
// guard (readonly.ts); the joint values, their limits and the state a model would be shown are the library's too
// (SO101Hardware.busPosition, JointLimits, SO101Kinematics). PEAR's own start-up (SO101Hardware.open) is not
// called: after its checks it writes the goal positions, the servos' settings and Torque_Enable.
//
// For a report from someone who is alone with the arm, the log gets what a first contact needs: what the port
// says of itself and the baud rate at every connection, and, when the handshake or a read fails, the bytes that
// went over the line with their times (trace.ts). When not all six servos answer, the page also asks every
// servo at once which ids are there (probe.ts) and, when nothing answers that either, asks again at the other
// baud rates a servo can be set to. All of these are pings, behind the guard.

import { SINGLE_ARM_POSE_FORMAT } from "../../src/agent/index";
import {
  DEFAULT_BAUDRATE,
  FeetechCommError,
  type FeetechMotorsBus,
  FeetechStatusError,
  MODEL_NUMBER_VALUE,
  type MotorCalibration,
  protocol,
  type RegisterName,
  RESOLUTION,
  type SerialPortLike,
  type Transport,
  WebSerialTransport,
} from "../../src/feetech/index";
import {
  JOINTS,
  MOTORS,
  type MotorName,
  parseCalibration,
  servoFaults,
  SO101Follower,
  SO101Hardware,
} from "../../src/so101/hardware/index";
import { type ModelState, SO101Kinematics } from "../../src/so101/kinematics/index";
import { LAYOUT } from "../../src/so101/layout";
import { OTHER_BAUD_RATES, type PingToAll, pingToAll } from "./probe";
import { type GuardCounts, ReadOnlyTransport, type ReadOnlyViolation } from "./readonly";
import { type LineErrors, ResilientPort } from "./serial_port";
import { hexOf, LineTrace, TracedTransport } from "./trace";

/** Between two reads of the joints, ms: about ten a second. */
export const READ_PERIOD_MS = 100;
/** Between two reads while the servos do not answer, ms. */
export const STALLED_PERIOD_MS = 500;
/** The reads between two polls of the servos' Status, torque, voltage and temperature: once a second. */
export const HEALTH_EVERY_READS = 10;
/** The failed reads in a row after which the page says the servos stopped answering. */
export const STALL_AFTER_FAILURES = 3;
/** PEAR's software zero correction of the five joints, rad: a station measures its own; PEAR's default is none. */
export const JOINT_OFFSETS: readonly number[] = JOINTS.map(() => 0);

/** How a servo answered the handshake or, when that failed, a ping of its own. */
export type ServoAnswer = "ok" | "silent" | "garbled" | "error";

export interface ServoInfo {
  motor: MotorName;
  id: number;
  answer: ServoAnswer;
  /** The error byte of the servo's answer when it reports an error; else null. */
  errorByte: number | null;
  /** Model_Number as read; null when it was not read. */
  model: number | null;
  /** The servo's firmware, "major.minor"; null when it was not read. */
  firmware: string | null;
}

/** What the low-rate poll read of one servo; null where nothing was read yet. */
export interface ServoHealth {
  status: number | null;
  torque: number | null;
  /** The supply voltage the servo measures, V. */
  voltage: number | null;
  /** °C */
  temperature: number | null;
}

/** Whether a joint is inside PEAR's position bounds, outside them by no more than the feedback tolerance (PEAR
 * accepts such a reading and lets the joint move only inward), or further outside (PEAR refuses to plan). */
export type BoundsMark = "inside" | "tolerated" | "outside";

export interface LiveReading {
  /** Present_Position of each servo, steps. */
  raw: Record<MotorName, number>;
  /** PEAR's joint vector: the five joints in rad, then the gripper's opening; null when it cannot be computed. */
  joints: number[] | null;
  marks: BoundsMark[] | null;
  /** PEAR's own refusal of the reading, when a joint is outside its bounds by more than the tolerance. */
  boundsMessage: string | null;
  /** The state a model would be shown; null when the joints are not known. */
  state: ModelState | null;
  /** The text of the turn a model would be sent for this state. */
  turnText: string | null;
  /** Why the joints could not be computed; null when they were. */
  problem: string | null;
  /** How many readings there were, this one included. */
  count: number;
}

export type FileVerdict = "equal" | "different" | "unchecked";

export interface CalibrationFile {
  name: string;
  calibration: Record<string, MotorCalibration>;
  /** PEAR's start-up check of the file against the registers; null before the arm is read. */
  verdict: FileVerdict | null;
  /** Why the check could not run, when it could not. */
  problem: string | null;
}

export type ArmFailure =
  /** port.open() failed. */
  | { kind: "open"; errorName: string; message: string }
  /** Nothing answered: no servo by itself, none when all were asked at once, and, where ``wasScanned``, none at
   * any other baud rate either. ``isUsbAdapter`` is what the port says of itself; null when it says nothing. */
  | { kind: "silent"; isUsbAdapter: boolean | null; wasScanned: boolean }
  /** Some servos answered and some did not; ``others`` are ids on the line that are none of the six. */
  | { kind: "partial"; missing: MotorName[]; answering: MotorName[]; others: number[] }
  /** Answers came, but damaged. */
  | { kind: "garbled" }
  /** None of the six ids answered by itself, yet these ids answered when all servos were asked at once. */
  | { kind: "ids"; found: number[] }
  /** Nothing answered at PEAR's baud rate, but these ids answer at another. */
  | { kind: "baud"; baudRate: number; found: number[] }
  /** The line hands the page its own bytes back. */
  | { kind: "echo" }
  /** A servo that answers is not an STS3215. */
  | { kind: "model"; wrong: Array<{ motor: MotorName; model: number }> }
  /** The port stopped working while it was in use: the cable was pulled, or the port was closed. */
  | { kind: "lost"; message: string }
  | { kind: "unexpected"; message: string };

/** "probing": the handshake found not all six servos, and the page looks for what else is on the line. */
export type ArmPhase = "idle" | "opening" | "handshake" | "probing" | "registers" | "reading" | "failed";

/** What a port says of itself. */
export interface PortIdentity {
  /** For the log. */
  text: string;
  /** Whether it is a USB adapter; null when the port says nothing of itself (the simulated one does not). */
  isUsbAdapter: boolean | null;
}

/** Returns what ``port`` says of itself through Web Serial's getInfo(): the USB ids of its adapter, or that it
 * has none, which the arm's adapter never does. */
export function identifyPort(port: SerialPortLike, isSimulated: boolean): PortIdentity {
  if (isSimulated) return { text: "no USB device (simulated)", isUsbAdapter: null };

  const info = (
    port as SerialPortLike & { getInfo?: () => { usbVendorId?: number; usbProductId?: number } | undefined }
  ).getInfo?.();
  if (info === undefined || info === null) return { text: "the port says nothing of itself", isUsbAdapter: null };
  if (info.usbVendorId === undefined) {
    return { text: "no USB vendor id: not a USB adapter (a Bluetooth or built-in serial port)", isUsbAdapter: false };
  }
  const hex = (value: number | undefined): string => (value === undefined ? "?" : value.toString(16).padStart(4, "0"));

  return { text: `USB vendor ${hex(info.usbVendorId)}, product ${hex(info.usbProductId)}`, isUsbAdapter: true };
}

/** How many failed reads of a connection the log shows with their bytes: the first of each run of failures. A
 * line that fails now and then would otherwise fill the log. */
const READ_FAILURES_TRACED = 12;
/** Beyond those, every so many failed reads the log says how many there were. */
const READ_FAILURES_COUNTED_EVERY = 50;

/** A port that is open: the guard everything is sent through, the trace of its line and the line's errors. */
interface OpenLine {
  guard: ReadOnlyTransport;
  trace: LineTrace;
  lineErrors: LineErrors;
}

/** Everything the page shows of the arm. */
export interface ArmView {
  phase: ArmPhase;
  /** Whether the arm is the simulated one. */
  isSimulated: boolean;
  failure: ArmFailure | null;
  /** The bus's handshake: whether it passed, and the library's own message when it did not. */
  handshake: { passed: boolean; message: string | null } | null;
  servos: ServoInfo[];
  health: Record<MotorName, ServoHealth>;
  /** PEAR's servo_faults of the last Status poll: the servos whose Status must stop the arm. */
  faults: string[];
  /** Whether all the servos that answer run one firmware; null before it is read. */
  sameFirmware: boolean | null;
  /** The calibration the servos' registers hold; null before it is read. */
  registers: Record<MotorName, MotorCalibration> | null;
  /** The servos whose registers hold what a servo leaves the factory with. */
  factoryMotors: MotorName[];
  /** Whether no servo holds a calibration: the arm was never calibrated. */
  isUncalibrated: boolean;
  file: CalibrationFile | null;
  live: LiveReading | null;
  /** Whether the servos have stopped answering while the port still works. */
  isStalled: boolean;
  /** The errors of the line that the port survived; null before a port is open. */
  lineErrors: LineErrors | null;
  guard: GuardCounts | null;
}

export interface ArmHooks {
  /** Called after every change of the view. */
  onChange: () => void;
  /** A line for the page's log. */
  log: (message: string) => void;
}

function emptyHealth(): Record<MotorName, ServoHealth> {
  return Object.fromEntries(
    MOTORS.map((motor) => [motor, { status: null, torque: null, voltage: null, temperature: null }]),
  ) as Record<MotorName, ServoHealth>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Adds what the guard of another line let through and refused to ``total``. */
function addCounts(total: GuardCounts, more: GuardCounts): void {
  for (const kind of ["passed", "refused"] as const) {
    for (const [name, count] of Object.entries(more[kind])) total[kind][name] = (total[kind][name] ?? 0) + count;
  }
}

/** Returns whether a servo's registers hold what an STS3215 leaves the factory with: no offset, the whole turn. */
export function isFactoryCalibration(calibration: MotorCalibration): boolean {
  return calibration.homingOffset === 0 && calibration.rangeMin === 0 && calibration.rangeMax === RESOLUTION - 1;
}

/** The page's one arm: a port, the guard, lerobot's follower on it, and the view of what was read. */
export class ArmSession {
  readonly view: ArmView;
  readonly kinematics = new SO101Kinematics();
  /** The port of the last connection, kept so that it can be tried again without choosing it anew. */
  lastPort: SerialPortLike | null = null;

  private follower: SO101Follower | null = null;
  private guard: ReadOnlyTransport | null = null; // of the line that is open; without a follower while probing
  private trace: LineTrace | null = null; // of the connection at PEAR's baud rate
  private traceMark = 0; // where in the trace the exchange in hand began
  private identity: PortIdentity = { text: "", isUsbAdapter: null };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> = Promise.resolve(); // settles when the read in flight has ended
  private pauses = 0; // above zero while something else has the bus for itself
  private failedReads = 0; // in a row
  private readFailures = 0; // of the connection
  private tracedFailures = 0; // of them, those the log shows with their bytes
  private readCount = 0;
  private generation = 0; // tells a connection from the one before

  constructor(private readonly hooks: ArmHooks) {
    this.view = ArmSession.emptyView();
  }

  private static emptyView(): ArmView {
    return {
      phase: "idle",
      isSimulated: false,
      failure: null,
      handshake: null,
      servos: [],
      health: emptyHealth(),
      faults: [],
      sameFirmware: null,
      registers: null,
      factoryMotors: [],
      isUncalibrated: false,
      file: null,
      live: null,
      isStalled: false,
      lineErrors: null,
      guard: null,
    };
  }

  /** The bus of the connection, for a caller that wants to try something on it: every byte still passes the
   * guard. Null while no arm is connected. */
  get bus(): FeetechMotorsBus | null {
    return this.follower?.bus ?? null;
  }

  get isConnected(): boolean {
    return this.follower !== null;
  }

  /** Opens ``port`` at the servos' baud rate and reads the arm until it is disconnected or lost. */
  async connect(port: SerialPortLike, options: { isSimulated: boolean; label: string }): Promise<void> {
    await this.disconnect();

    const generation = ++this.generation;
    const file = this.view.file;
    Object.assign(this.view, ArmSession.emptyView(), { phase: "opening", isSimulated: options.isSimulated });
    this.view.file = file === null ? null : { ...file, verdict: null, problem: null };
    this.lastPort = port;
    this.identity = identifyPort(port, options.isSimulated);
    this.trace = null;
    this.readFailures = 0;
    this.tracedFailures = 0;
    this.hooks.log(`Port chosen (${options.label}): ${this.identity.text}`);
    this.changed();

    let line: OpenLine;
    try {
      line = await this.openLine(port, DEFAULT_BAUDRATE);
    } catch (error) {
      this.hooks.log(`The port could not be opened: ${nameOf(error)}: ${messageOf(error)}`);
      this.fail({ kind: "open", errorName: nameOf(error), message: messageOf(error) });
      return;
    }
    this.view.lineErrors = line.lineErrors;
    this.hooks.log(`Port open at ${DEFAULT_BAUDRATE} baud, 8 data bits, no parity, 1 stop bit (${options.label})`);

    // lerobot's follower as PEAR makes it (joints in degrees), without a calibration yet and never configured:
    // configure() writes. Its disconnect() would write Torque_Enable; the page closes the bus without it.
    const follower = new SO101Follower(line.guard, null, { disableTorqueOnDisconnect: false }, { port: options.label });
    this.guard = line.guard;
    this.trace = line.trace;
    this.traceMark = line.trace.mark();
    this.follower = follower;
    this.view.guard = line.guard.counts;

    try {
      await this.start(follower, line.guard, port, generation);
    } catch (error) {
      if (generation !== this.generation) return;
      await this.giveUp(error);
    }
  }

  /** Opens ``port`` at ``baudRate`` as the servos speak (8 data bits, no parity, one stop bit), behind the
   * read-only guard and with a trace of what goes over the line. Throws what the port's open() throws. */
  private async openLine(port: SerialPortLike, baudRate: number): Promise<OpenLine> {
    // a port this page left open (a failed close) would refuse to open again
    if (port.readable !== null || port.writable !== null) await port.close().catch(() => undefined);

    const trace = new LineTrace();
    // the transport reads through a port that survives an error of the line (serial_port.ts)
    const line: ResilientPort = new ResilientPort(
      port,
      (error) => {
        trace.lineError(nameOf(error));
        const errors = line.lineErrors;
        if (errors.count <= 5 || errors.count % 50 === 0) {
          this.hooks.log(`Serial line error ${errors.count}, reading goes on: ${nameOf(error)}: ${messageOf(error)}`);
        }
      },
      (bytes) => trace.received(bytes),
    );
    const serial = await WebSerialTransport.open(line, baudRate);
    trace.opened();
    // the guard is the outermost: what the trace below it records as sent has passed it
    const guard = new ReadOnlyTransport(new TracedTransport(serial, trace), {
      onRefused: (violation: ReadOnlyViolation) => this.hooks.log(`Read-only guard: ${violation.message}`),
    });

    return { guard, trace, lineErrors: line.lineErrors };
  }

  /** Remembers that the exchange in hand begins here, for the bytes the log shows if it fails. */
  private markTrace(): void {
    this.traceMark = this.trace?.mark() ?? 0;
  }

  /** Writes to the log the bytes that went over the line since the exchange in hand began. */
  private logTrace(what: string): void {
    if (this.trace === null) return;
    for (const line of this.trace.report(what, this.traceMark)) this.hooks.log(line);
  }

  /** Closes the port, torque left as found, and forgets the arm; the view keeps the calibration file. */
  async disconnect(): Promise<void> {
    this.generation += 1;
    await this.release();
    const file = this.view.file;
    Object.assign(this.view, ArmSession.emptyView());
    this.view.file = file === null ? null : { ...file, verdict: null, problem: null };
    this.changed();
  }

  /** Takes the text of a lerobot calibration file and, when an arm is being read, compares it with the servos'
   * registers as PEAR's start-up does. Throws what parseCalibration throws for a text that is no calibration. */
  async loadCalibrationFile(name: string, text: string): Promise<void> {
    const calibration = parseCalibration(text);
    this.view.file = { name, calibration, verdict: null, problem: null };
    this.hooks.log(`Calibration file loaded: ${Object.keys(calibration).length} motors`);
    if (this.view.phase === "reading") {
      try {
        await this.exclusively(() => this.compareFile());
      } catch (error) {
        await this.giveUp(error);
        return;
      }
    }
    this.changed();
  }

  /** Forgets the calibration file; the joints are computed with the registers' values again. */
  async dropCalibrationFile(): Promise<void> {
    this.view.file = null;
    if (this.follower !== null && this.view.registers !== null) this.follower.bus.calibration = { ...this.view.registers };
    this.changed();
  }

  /** Returns how long each of ``count`` reads of the six positions took, ms, one after another without a pause;
   * the periodic read waits meanwhile. */
  async measureReads(count: number): Promise<number[]> {
    const bus = this.requireBus();

    return this.exclusively(async () => {
      const durations: number[] = [];
      for (let index = 0; index < count; index++) {
        const startedAt = performance.now();
        await bus.syncRead("Present_Position", null, { normalize: false });
        durations.push(performance.now() - startedAt);
      }

      return durations;
    });
  }

  /** Runs ``run`` with the periodic read stopped, and starts it again; one such run may hold another. */
  async exclusively<T>(run: () => Promise<T>): Promise<T> {
    this.pauses += 1;
    await this.running;
    try {
      return await run();
    } finally {
      this.pauses -= 1;
    }
  }

  private requireBus(): FeetechMotorsBus {
    if (this.follower === null) throw new Error("No arm is connected");

    return this.follower.bus;
  }

  private changed(): void {
    this.hooks.onChange();
  }

  /** The steps of a connection after the port is open: handshake, diagnosis, registers, then the periodic read. */
  private async start(
    follower: SO101Follower,
    guard: ReadOnlyTransport,
    port: SerialPortLike,
    generation: number,
  ): Promise<void> {
    const bus = follower.bus;
    const view = this.view;

    view.phase = "handshake";
    this.changed();
    let handshakeError: unknown = null;
    try {
      await bus.connect(true); // pings ids 1 to 6, requires the STS3215's model number and one firmware for all
    } catch (error) {
      if (guard.failure !== null) throw error;
      handshakeError = error;
    }
    view.handshake = { passed: handshakeError === null, message: handshakeError === null ? null : messageOf(handshakeError) };

    if (handshakeError === null) {
      this.hooks.log("Handshake passed: six servos answer, model and firmware as lerobot requires");
      view.servos = MOTORS.map((motor) => ({
        motor,
        id: bus.motors[motor].id,
        answer: "ok",
        errorByte: null,
        model: null,
        firmware: null,
      }));
    } else {
      this.hooks.log(`Handshake failed: ${messageOf(handshakeError).replace(/\s*\n\s*/g, " | ")}`);
      view.servos = await this.diagnose(bus, guard);
      this.changed();
      this.logTrace("the handshake and the ping of each servo");
      if (await this.stopsHere(bus, guard, port, generation)) return;
    }

    view.phase = "registers";
    this.changed();
    this.markTrace();
    await this.readIdentity(bus);
    await this.pollHealth(bus);
    await this.readRegisters(bus);
    if (view.file !== null) await this.compareFile();
    this.changed();

    view.phase = "reading";
    this.failedReads = 0;
    this.readCount = 0;
    await this.readOnce();
    this.schedule(READ_PERIOD_MS);
  }

  /** Asks each servo by itself, to tell the ones that are silent from the ones that answer with an error. */
  private async diagnose(bus: FeetechMotorsBus, guard: ReadOnlyTransport): Promise<ServoInfo[]> {
    const servos: ServoInfo[] = [];
    for (const motor of MOTORS) {
      const id = bus.motors[motor].id;
      const info: ServoInfo = { motor, id, answer: "ok", errorByte: null, model: null, firmware: null };
      try {
        info.model = await bus.ping(id, 1, true);
      } catch (error) {
        if (guard.failure !== null) throw error;
        if (error instanceof FeetechStatusError) {
          info.answer = "error";
          info.errorByte = error.error;
        } else if (error instanceof FeetechCommError && error.result === protocol.COMM_RX_CORRUPT) {
          info.answer = "garbled";
        } else {
          info.answer = "silent";
        }
      }
      servos.push(info);
    }
    this.hooks.log(`Servos: ${servos.map((servo) => `${servo.id} ${servo.answer}`).join(", ")}`);

    return servos;
  }

  /** Decides, after a failed handshake, whether the arm can be read at all; if not, closes the port, says why
   * and returns true. */
  private async stopsHere(
    bus: FeetechMotorsBus,
    guard: ReadOnlyTransport,
    port: SerialPortLike,
    generation: number,
  ): Promise<boolean> {
    const servos = this.view.servos;
    const answering = servos.filter((servo) => servo.answer === "ok" || servo.answer === "error");
    const wrong = servos.flatMap((servo) =>
      servo.answer === "ok" && servo.model !== null && servo.model !== MODEL_NUMBER_VALUE
        ? [{ motor: servo.motor, model: servo.model }]
        : [],
    );

    // a broadcast packet is no servo's answer: if it comes back, the line echoes
    await bus.syncRead("Present_Position", null, { normalize: false }).catch(() => undefined);
    if (guard.failure !== null) throw guard.failure;

    let failure: ArmFailure | null = null;
    if (guard.echoSeen) {
      failure = { kind: "echo" };
    } else if (answering.length < servos.length) {
      failure = await this.lookFurther(guard, port, generation);
      if (failure === null) return true; // another connection, or a disconnection, has taken over
    } else if (wrong.length > 0) {
      failure = { kind: "model", wrong };
    }
    if (failure === null) return false;

    await this.release();
    this.fail(failure);

    return true;
  }

  /**
   * Looks for what is on the line when not all six servos answered a ping of their own: asks every servo at
   * once, which the servos with any id answer; and, when nothing whole comes back, closes the port and asks
   * again at each other baud rate a servo can be set to. Returns what was found, or null when the connection
   * was ended meanwhile. A port that is no USB adapter is not tried at other baud rates: it is not the arm's.
   */
  private async lookFurther(
    guard: ReadOnlyTransport,
    port: SerialPortLike,
    generation: number,
  ): Promise<ArmFailure | null> {
    const view = this.view;
    const servos = view.servos;
    const answering = servos.filter((servo) => servo.answer === "ok" || servo.answer === "error");
    const isEnded = (): boolean => generation !== this.generation;
    view.phase = "probing";
    this.changed();

    const expected = servos.map((servo) => servo.id);
    const here = await this.pingAll(guard, DEFAULT_BAUDRATE, isEnded);
    if (guard.failure !== null) throw guard.failure;
    if (isEnded()) return null;
    if (answering.length > 0) {
      return {
        kind: "partial",
        missing: servos.filter((servo) => !answering.includes(servo)).map((servo) => servo.motor),
        answering: answering.map((servo) => servo.motor),
        others: here.ids.filter((id) => !expected.includes(id)),
      };
    }
    if (here.ids.length > 0) return { kind: "ids", found: here.ids };

    // nothing whole came back at PEAR's baud rate
    const wasHeard = here.received > 0 || servos.some((servo) => servo.answer === "garbled");
    if (this.identity.isUsbAdapter === false) {
      this.hooks.log("The other baud rates are not tried: the port is not a USB adapter");
      return wasHeard ? { kind: "garbled" } : { kind: "silent", isUsbAdapter: false, wasScanned: false };
    }

    await this.release();
    if (isEnded()) return null;
    this.hooks.log(`Trying the other baud rates a servo can be set to: ${OTHER_BAUD_RATES.join(", ")}`);
    for (const baudRate of OTHER_BAUD_RATES) {
      let line: OpenLine;
      try {
        line = await this.openLine(port, baudRate);
      } catch (error) {
        if (isEnded()) return null;
        this.hooks.log(`At ${baudRate} baud the port could not be opened: ${nameOf(error)}: ${messageOf(error)}`);
        continue;
      }
      if (isEnded()) {
        await line.guard.close().catch(() => undefined);
        return null;
      }

      // while it is the session's line, a disconnection closes it
      this.guard = line.guard;
      let there: PingToAll | null = null;
      try {
        there = await this.pingAll(line.guard, baudRate, isEnded);
      } catch (error) {
        if (!isEnded()) this.hooks.log(`At ${baudRate} baud: ${nameOf(error)}: ${messageOf(error)}`);
      } finally {
        if (view.guard !== null) addCounts(view.guard, line.guard.counts);
        if (this.guard === line.guard) {
          this.guard = null;
          await line.guard.close().catch(() => undefined);
        }
      }
      if (isEnded()) return null;
      if (there !== null && there.ids.length > 0) return { kind: "baud", baudRate, found: there.ids };
    }
    this.hooks.log("No servo answered at any baud rate");

    return wasHeard
      ? { kind: "garbled" }
      : { kind: "silent", isUsbAdapter: this.identity.isUsbAdapter, wasScanned: true };
  }

  /** Asks every servo on ``line`` at once whether it is there, and writes what came back to the log. */
  private async pingAll(line: Transport, baudRate: number, isStopped: () => boolean): Promise<PingToAll> {
    const heard = await pingToAll(line, baudRate, isStopped);
    const waited = `${Math.round(heard.waitedMs)} ms`;
    const what = `Ping to every servo at once, ${baudRate} baud`;
    this.hooks.log(
      heard.ids.length > 0
        ? `${what}: answered by the ids ${heard.ids.join(", ")} (${heard.received} bytes in ${waited}: ${hexOf(heard.head)})`
        : heard.received > 0
          ? `${what}: ${heard.received} bytes came back in ${waited} that are no whole answer: ${hexOf(heard.head)}`
          : `${what}: nothing came back in ${waited}`,
    );

    return heard;
  }

  /** Reads each answering servo's model number and firmware version. */
  private async readIdentity(bus: FeetechMotorsBus): Promise<void> {
    const access = { normalize: false, numRetry: SO101Hardware.BUS_RETRIES };
    const models = await bus.syncRead("Model_Number", null, access);
    const majors = await bus.syncRead("Firmware_Major_Version", null, access);
    const minors = await bus.syncRead("Firmware_Minor_Version", null, access);
    for (const servo of this.view.servos) {
      servo.model = models[servo.motor] ?? null;
      servo.firmware = `${majors[servo.motor]}.${minors[servo.motor]}`;
    }
    this.view.sameFirmware = new Set(this.view.servos.map((servo) => servo.firmware)).size === 1;
    this.hooks.log(
      `Model ${[...new Set(this.view.servos.map((servo) => servo.model))].join("/")}, firmware ` +
        `${[...new Set(this.view.servos.map((servo) => servo.firmware))].join("/")}`,
    );
  }

  /** Reads what PEAR's preflight reads of every servo besides its position: Status, torque, voltage, temperature. */
  private async pollHealth(bus: FeetechMotorsBus): Promise<void> {
    const access = { normalize: false, numRetry: SO101Hardware.RUN_RETRIES };
    const status = await bus.syncRead("Status", null, access);
    const torque = await bus.syncRead("Torque_Enable", null, access);
    const voltage = await bus.syncRead("Present_Voltage", null, access);
    const temperature = await bus.syncRead("Present_Temperature", null, access);

    for (const motor of MOTORS) {
      this.view.health[motor] = {
        status: status[motor] ?? null,
        torque: torque[motor] ?? null,
        voltage: voltage[motor] === undefined ? null : voltage[motor] / 10, // the servos report tenths of a volt
        temperature: temperature[motor] ?? null,
      };
    }
    const faults = servoFaults(status);
    if (faults.join("; ") !== this.view.faults.join("; ")) {
      this.hooks.log(faults.length > 0 ? `Servo error: ${faults.join("; ")}` : "No servo reports an error");
    }
    this.view.faults = faults;
  }

  /** Reads the calibration the servos hold and makes it the one the bus computes the joints with. */
  private async readRegisters(bus: FeetechMotorsBus): Promise<void> {
    const view = this.view;
    let registers: Record<string, MotorCalibration>;
    if (view.servos.every((servo) => servo.answer === "ok")) {
      registers = await bus.readCalibration();
    } else {
      // a read of one servo throws on its error byte; a sync read does not look at it
      const access = { normalize: false, numRetry: SO101Hardware.BUS_RETRIES };
      const read = (name: RegisterName): Promise<Record<string, number>> => bus.syncRead(name, null, access);
      const [minimum, maximum, offset] = [
        await read("Min_Position_Limit"),
        await read("Max_Position_Limit"),
        await read("Homing_Offset"),
      ];
      registers = Object.fromEntries(
        MOTORS.map((motor) => [
          motor,
          {
            id: bus.motors[motor].id,
            driveMode: 0,
            homingOffset: offset[motor] as number,
            rangeMin: minimum[motor] as number,
            rangeMax: maximum[motor] as number,
          },
        ]),
      );
    }

    view.registers = registers as Record<MotorName, MotorCalibration>;
    view.factoryMotors = MOTORS.filter((motor) => isFactoryCalibration(view.registers![motor]));
    view.isUncalibrated = view.factoryMotors.length === MOTORS.length;
    bus.calibration = { ...registers };
    this.hooks.log(
      `Calibration registers (id: offset, min..max): ${MOTORS.map((motor) => {
        const entry = view.registers![motor];
        return `${entry.id}: ${entry.homingOffset}, ${entry.rangeMin}..${entry.rangeMax}`;
      }).join("; ")}${view.isUncalibrated ? " (factory values: never calibrated)" : ""}`,
    );
  }

  /** PEAR's start-up check of the calibration file against the servos' registers (the bus's isCalibrated). When
   * they are equal the bus computes the joints with the file, as PEAR does; else with the registers. */
  private async compareFile(): Promise<void> {
    const file = this.view.file;
    const follower = this.follower;
    if (file === null || follower === null || this.view.registers === null) return;

    const bus = follower.bus;
    bus.calibration = file.calibration;
    this.markTrace();
    try {
      file.verdict = (await bus.isCalibrated()) ? "equal" : "different";
      file.problem = null;
    } catch (error) {
      if (this.guard?.failure != null) throw error;
      file.verdict = "unchecked";
      file.problem = messageOf(error);
      this.logTrace("the read of the calibration registers");
    }
    if (file.verdict !== "equal") bus.calibration = { ...this.view.registers };
    this.hooks.log(
      file.verdict === "equal"
        ? "Calibration file: equal to the servos' registers"
        : file.verdict === "different"
          ? "Calibration file: differs from the servos' registers (PEAR: Servo calibration registers differ from the calibration file)"
          : `Calibration file: not compared: ${file.problem}`,
    );
  }

  private schedule(delayMs: number): void {
    if (this.follower === null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const generation = this.generation;
      const startedAt = performance.now();
      this.running = (this.pauses > 0 ? Promise.resolve() : this.readOnce())
        .catch((error: unknown) => this.hooks.log(`Unexpected: ${nameOf(error)}: ${messageOf(error)}`))
        .then(() => {
          if (generation !== this.generation || this.follower === null) return;
          const period = this.view.isStalled ? STALLED_PERIOD_MS : READ_PERIOD_MS;
          this.schedule(Math.max(period - (performance.now() - startedAt), 0));
        });
    }, delayMs);
  }

  /** One periodic read: the six positions, and every tenth time the servos' health. */
  private async readOnce(): Promise<void> {
    const follower = this.follower;
    const guard = this.guard;
    if (follower === null || guard === null) return;

    const bus = follower.bus;
    const view = this.view;
    this.markTrace();
    try {
      // one packet for the six servos, as PEAR's read(); with one retry, as PEAR's
      const raw = await bus.syncRead("Present_Position", null, {
        normalize: false,
        numRetry: SO101Hardware.RUN_RETRIES,
      });
      const wasStalled = view.isStalled;
      this.failedReads = 0;
      view.isStalled = false;
      this.readCount += 1;
      view.live = this.reading(bus, raw);
      if (wasStalled) this.hooks.log("The servos answer again");
      if (wasStalled || this.readCount % HEALTH_EVERY_READS === 0) await this.pollHealth(bus);
    } catch (error) {
      if (this.follower !== follower) return;
      if (guard.failure !== null || !(error instanceof FeetechCommError)) {
        await this.giveUp(error);
        return;
      }
      this.failedReads += 1;
      this.readFailures += 1;
      if (this.failedReads === 1 && this.tracedFailures < READ_FAILURES_TRACED) {
        this.tracedFailures += 1;
        this.hooks.log(`Read failed (${this.readFailures} of this connection): ${messageOf(error)}`);
        this.logTrace("the failed read");
        if (this.tracedFailures === READ_FAILURES_TRACED) {
          this.hooks.log("Further failed reads are counted and no longer shown with their bytes");
        }
      } else if (this.readFailures % READ_FAILURES_COUNTED_EVERY === 0) {
        this.hooks.log(`Read failed (${this.readFailures} of this connection, ${this.failedReads} in a row)`);
      }
      if (this.failedReads === STALL_AFTER_FAILURES) {
        view.isStalled = true;
        this.hooks.log(`The servos stopped answering: ${messageOf(error)}`);
      }
    }
    this.changed();
  }

  /** Returns what the page shows of the positions ``raw``: PEAR's joint vector, its bounds, the model's state. */
  private reading(bus: FeetechMotorsBus, raw: Readonly<Record<string, number>>): LiveReading {
    const reading: LiveReading = {
      raw: Object.fromEntries(MOTORS.map((motor) => [motor, raw[motor]])) as Record<MotorName, number>,
      joints: null,
      marks: null,
      boundsMessage: null,
      state: null,
      turnText: null,
      problem: null,
      count: this.readCount,
    };
    if (this.view.isUncalibrated) return reading; // without a calibration the steps have no zero

    try {
      // what the bus's sync read does with the steps when it normalizes: lerobot's degrees and percent
      const normalized = bus.normalize(new Map(MOTORS.map((motor) => [bus.motors[motor].id, raw[motor] as number])));
      const values = Object.fromEntries(MOTORS.map((motor) => [motor, normalized.get(bus.motors[motor].id) as number]));
      const joints = SO101Hardware.busPosition(values, JOINT_OFFSETS);
      const limits = this.kinematics.limits;
      reading.joints = joints;
      reading.marks = joints.map((value, index) => this.mark(index, value));
      try {
        limits.checkPositions(joints, LAYOUT, limits.feedbackTolerance);
      } catch (error) {
        reading.boundsMessage = messageOf(error);
      }
      reading.state = this.kinematics.quantities(joints);
      reading.turnText = SINGLE_ARM_POSE_FORMAT.turnText(reading.state, null);
    } catch (error) {
      reading.problem = messageOf(error);
    }

    return reading;
  }

  /** Returns where the coordinate ``index`` stands against PEAR's bounds, by PEAR's own check of a vector that
   * is inside every other bound. */
  private mark(index: number, value: number): BoundsMark {
    const limits = this.kinematics.limits;
    const probe = limits.lowerBounds.map((lower, each) => (lower + (limits.upperBounds[each] as number)) / 2);
    probe[index] = value;
    try {
      limits.checkPositions(probe, LAYOUT);
      return "inside";
    } catch {
      // outside the bounds: by how much?
    }
    try {
      limits.checkPositions(probe, LAYOUT, limits.feedbackTolerance);
      return "tolerated";
    } catch {
      return "outside";
    }
  }

  /** Ends a connection that cannot go on: the port is released and the view says why. */
  private async giveUp(error: unknown): Promise<void> {
    const lineFailure = this.guard?.failure ?? null;
    const failure: ArmFailure =
      lineFailure !== null
        ? { kind: "lost", message: `${nameOf(lineFailure)}: ${messageOf(lineFailure)}` }
        : { kind: "unexpected", message: `${nameOf(error)}: ${messageOf(error)}` };
    this.hooks.log(
      failure.kind === "lost" ? `The port stopped working: ${failure.message}` : `Unexpected: ${failure.message}`,
    );
    this.logTrace("what went before");
    this.generation += 1;
    await this.release(false); // this may be the periodic read itself: it must not wait for its own end
    this.fail(failure);
  }

  private fail(failure: ArmFailure): void {
    // the page's own conclusion in one line, for whoever reads the log without the page
    this.hooks.log(`Not connected: ${JSON.stringify(failure)}`);
    this.view.phase = "failed";
    this.view.failure = failure;
    this.view.live = null;
    this.view.isStalled = false;
    this.changed();
  }

  /** Stops the periodic read and closes the bus without touching torque; a port that is already gone refuses to
   * close, which is ignored. With ``waitsForRead`` the read in flight ends first. */
  private async release(waitsForRead = true): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const follower = this.follower;
    const guard = this.guard;
    this.follower = null;
    this.guard = null;
    if (waitsForRead) await this.running.catch(() => undefined);
    if (follower === null && guard === null) return;

    try {
      // while the page looks at the other baud rates the open line has no bus: its guard closes it
      if (follower !== null) await follower.bus.disconnect(false);
      else await guard?.close();
      this.hooks.log("Port closed");
    } catch (error) {
      this.hooks.log(`Closing the port: ${nameOf(error)}: ${messageOf(error)}`);
    }
  }
}
