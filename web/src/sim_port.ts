// Not in PEAR: a simulated arm behind an object with the shape of a Web Serial port, so that the page's own
// path (the port's streams, WebSerialTransport, the guard, the bus) runs without hardware. The servos are the
// library's simulated chain (src/feetech/sim.ts); this file only gives it the port's streams, the faults a person
// may want to see before meeting them on a real arm, and a cable to pull.
//
// The port behaves as Chrome's does as far as the page uses one: the streams exist while the port is open, a
// stream that was cancelled or closed is replaced by a new one, close() refuses while a stream is locked, and a
// lost device errors both streams and leaves the port closed.

import {
  DEFAULT_BAUDRATE,
  encodeSignMagnitude,
  ENCODING_TABLE,
  type MotorCalibration,
  protocol,
  type SerialPortLike,
  SimServo,
  SimServoChain,
} from "../../src/feetech/index";
import { followerMotors, MOTORS, type MotorName, simulatedArm } from "../../src/so101/hardware/index";

/** What the simulated arm is, besides healthy. */
export const SIM_SCENARIOS = ["normal", "missing", "error", "factory", "silent", "ids", "baud", "echo"] as const;
export type SimScenario = (typeof SIM_SCENARIOS)[number];

/** The servo that is absent in the scenario "missing", and the one that reports an error in "error". */
export const SIM_MISSING_MOTOR: MotorName = "elbow_flex";
export const SIM_ERROR_MOTOR: MotorName = "wrist_flex";
/** The Status bit the scenario "error" sets: overload. */
export const SIM_ERROR_STATUS = 0x20;
/** The ids the six servos have in the scenario "ids": none of PEAR's 1 to 6. */
export const SIM_OTHER_IDS: readonly number[] = [11, 12, 13, 14, 15, 16];
/** The baud rate the servos are set to in the scenario "baud". */
export const SIM_OTHER_BAUD_RATE = 115_200;

/** A calibration as lerobot leaves an SO-101: plausible values, not read from a real arm. */
export const SIM_CALIBRATION: Readonly<Record<MotorName, MotorCalibration>> = {
  shoulder_pan: { id: 1, driveMode: 0, homingOffset: -1470, rangeMin: 758, rangeMax: 3292 },
  shoulder_lift: { id: 2, driveMode: 0, homingOffset: 97, rangeMin: 857, rangeMax: 3284 },
  elbow_flex: { id: 3, driveMode: 0, homingOffset: 1238, rangeMin: 836, rangeMax: 3069 },
  wrist_flex: { id: 4, driveMode: 0, homingOffset: -1028, rangeMin: 838, rangeMax: 3138 },
  wrist_roll: { id: 5, driveMode: 0, homingOffset: -233, rangeMin: 0, rangeMax: 4095 },
  gripper: { id: 6, driveMode: 0, homingOffset: 1269, rangeMin: 2037, rangeMax: 3499 },
};

/** Where the simulated arm's servos stand at first, steps: near PEAR's Home pose under SIM_CALIBRATION. */
export const SIM_START_POSITIONS: Readonly<Record<MotorName, number>> = {
  shoulder_pan: 2025,
  shoulder_lift: 1540,
  elbow_flex: 2003,
  wrist_flex: 2915,
  wrist_roll: 996,
  gripper: 3499,
};

function lostDevice(): DOMException {
  return new DOMException("The device has been lost.", "NetworkError");
}

/** The packet that asks every servo on the line to say that it is there. */
const PING_TO_ALL = protocol.pingPacket(protocol.BROADCAST_ID);

function isPingToAll(bytes: Uint8Array): boolean {
  return bytes.length === PING_TO_ALL.length && PING_TO_ALL.every((byte, index) => bytes[index] === byte);
}

/** The simulated arm: its servos, what is wrong with it, and whether its cable is in. */
export class SimArm {
  readonly chain: SimServoChain;
  scenario: SimScenario = "normal";
  /** The port a page gets for it; one arm has one cable. */
  readonly port: SimSerialPort;

  constructor(scenario: SimScenario = "normal") {
    this.chain = simulatedArm(SIM_CALIBRATION, SIM_START_POSITIONS);
    this.port = new SimSerialPort(this.chain);
    this.setScenario(scenario);
  }

  /** Makes the arm what ``scenario`` says; the servos keep their positions. */
  setScenario(scenario: SimScenario): void {
    this.scenario = scenario;
    const motors = followerMotors();
    this.chain.absent.clear();
    this.chain.echo = scenario === "echo";
    // servos with other ids are not there under PEAR's: they show only when every servo is asked at once
    this.port.strangers = scenario === "ids" ? SIM_OTHER_IDS : [];
    this.port.servoBaudRate = scenario === "baud" ? SIM_OTHER_BAUD_RATE : DEFAULT_BAUDRATE;
    for (const motor of MOTORS) {
      const servo = this.servo(motor);
      const calibration = scenario === "factory" ? null : SIM_CALIBRATION[motor];
      // a servo that was never calibrated holds what it left the factory with: no offset, the whole turn
      servo.set("Min_Position_Limit", calibration?.rangeMin ?? 0);
      servo.set("Max_Position_Limit", calibration?.rangeMax ?? 4095);
      servo.set("Homing_Offset", encodeSignMagnitude(calibration?.homingOffset ?? 0, ENCODING_TABLE.Homing_Offset as number));
      servo.set("Status", scenario === "error" && motor === SIM_ERROR_MOTOR ? SIM_ERROR_STATUS : 0);
      if (scenario === "silent" || scenario === "ids" || (scenario === "missing" && motor === SIM_MISSING_MOTOR)) {
        this.chain.absent.add(motors[motor].id);
      }
    }
  }

  servo(motor: MotorName): SimServo {
    return this.chain.servo(followerMotors()[motor].id);
  }

  /** Puts a servo's horn at ``steps``, as a hand does: behind the bus's back. */
  setPosition(motor: MotorName, steps: number): void {
    this.servo(motor).position = steps;
  }

  position(motor: MotorName): number {
    return this.servo(motor).position;
  }
}

/** The USB ids the simulated adapter says of itself: those of the CH343 an SO-101's control board carries. */
export const SIM_USB_IDS = { usbVendorId: 0x1a86, usbProductId: 0x55d3 } as const;

/** A simulated arm's port as a browser hands a granted one to a Worker: with a `getInfo()` that tells the
 * adapter's USB ids. The station's Worker takes such a port in place of a granted one, so that its hand-over of a
 * real arm's line runs without hardware; the port the window shows for its simulated arm tells no ids, as before. */
export function simulatedGrantedPort(
  arm: SimArm = new SimArm(),
): SimSerialPort & { getInfo(): { usbVendorId: number; usbProductId: number } } {
  return Object.assign(arm.port, { getInfo: () => ({ ...SIM_USB_IDS }) });
}

/** A Web Serial port's shape on the simulated chain. */
export class SimSerialPort implements SerialPortLike {
  /** The options of the last open(), for whoever wants to see what the page asked for. */
  openedWith: { baudRate: number } | null = null;
  /** The baud rate of every open() so far, in their order. */
  readonly baudRates: number[] = [];
  /** The baud rate the servos are set to: a port opened at another reaches none of them. */
  servoBaudRate: number = DEFAULT_BAUDRATE;
  /** The ids of servos on the line that are none of the chain's: they answer a PING to every servo, and
   * nothing else is ever asked of them. */
  strangers: readonly number[] = [];
  private isOpen = false;
  private isUnplugged = false;
  private readableStream: ReadableStream<Uint8Array> | null = null;
  private writableStream: WritableStream<Uint8Array> | null = null;
  private readController: ReadableStreamDefaultController<Uint8Array> | null = null;
  private writeController: WritableStreamDefaultController | null = null;
  private hasFailed = false; // a lost device: no new streams

  constructor(private readonly chain: SimServoChain) {}

  get isPlugged(): boolean {
    return !this.isUnplugged;
  }

  get readable(): ReadableStream<Uint8Array> | null {
    if (this.readableStream === null && this.isOpen && !this.hasFailed) {
      this.readableStream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.readController = controller;
        },
        cancel: () => {
          this.readableStream = null;
          this.readController = null;
        },
      });
    }

    return this.readableStream;
  }

  get writable(): WritableStream<Uint8Array> | null {
    if (this.writableStream === null && this.isOpen && !this.hasFailed) {
      this.writableStream = new WritableStream<Uint8Array>({
        start: (controller) => {
          this.writeController = controller;
        },
        write: async (bytes) => {
          // servos set to another baud rate than the port's hear noise: they take in nothing and answer nothing
          if (this.openedWith?.baudRate !== this.servoBaudRate) return;
          // a simulated arm that is read for hours should not keep every packet it ever got
          if (this.chain.received.length > 20_000) this.chain.received.splice(0, 10_000);
          await this.chain.write(bytes);
          const answers = Array.from(await this.chain.read(Number.MAX_SAFE_INTEGER, 0));
          if (isPingToAll(bytes)) answers.push(...this.answersToAll());
          this.deliver(Uint8Array.from(answers));
        },
        close: () => {
          this.writableStream = null;
          this.writeController = null;
        },
        abort: () => {
          this.writableStream = null;
          this.writeController = null;
        },
      });
    }

    return this.writableStream;
  }

  async open(options: { baudRate: number }): Promise<void> {
    if (this.isOpen) throw new DOMException("The port is already open.", "InvalidStateError");
    if (this.isUnplugged) throw new DOMException("Failed to open serial port.", "NetworkError");

    this.openedWith = { baudRate: options.baudRate };
    this.baudRates.push(options.baudRate);
    this.isOpen = true;
    this.hasFailed = false;
    this.chain.isClosed = false;
    await this.chain.read(Number.MAX_SAFE_INTEGER, 0); // what the last session left unread is gone
  }

  async close(): Promise<void> {
    if (!this.isOpen) throw new DOMException("The port is already closed.", "InvalidStateError");
    if (this.readableStream?.locked) throw new TypeError("Cannot cancel a locked stream");
    if (this.writableStream?.locked) throw new TypeError("Cannot abort a locked stream");

    const readable = this.readableStream;
    const writable = this.writableStream;
    this.isOpen = false;
    this.readableStream = null;
    this.writableStream = null;
    await readable?.cancel().catch(() => undefined);
    await writable?.abort().catch(() => undefined);
    this.readController = null;
    this.writeController = null;
  }

  /** Pulls the cable: both streams fail and the port is closed, as when a USB adapter disappears. */
  unplug(): void {
    this.isUnplugged = true;
    if (!this.isOpen) return;

    this.isOpen = false;
    this.hasFailed = true;
    try {
      this.readController?.error(lostDevice());
    } catch {
      // the stream was closed already
    }
    try {
      this.writeController?.error(lostDevice());
    } catch {
      // the stream was closed already
    }
    this.readableStream = null;
    this.writableStream = null;
    this.readController = null;
    this.writeController = null;
  }

  /** Disturbs the line: the stream the page reads fails with an error the port survives (a break, a framing
   * error), and the port offers a new stream, as the Web Serial specification has it. */
  glitch(name = "BreakError"): void {
    if (!this.isOpen) return;

    try {
      this.readController?.error(new DOMException("The line reported an error.", name));
    } catch {
      // the stream was closed already
    }
    this.readableStream = null;
    this.readController = null;
  }

  /** Puts the cable back; the port must be opened again. */
  plug(): void {
    this.isUnplugged = false;
  }

  /** Returns what the servos on the line answer to a PING sent to all of them: each its status packet, one after
   * another by id. A real STS3215 does this (lerobot's broadcast ping relies on it); the library's simulated
   * chain answers a PING only to one servo, so the port adds these answers. */
  private answersToAll(): number[] {
    const present = [...this.chain.servos.values()].filter((servo) => !this.chain.absent.has(servo.id));
    const answers = [
      ...present.map((servo) => [servo.id, servo.get("Status")] as const),
      ...this.strangers.map((id) => [id, 0] as const),
    ].sort((a, b) => a[0] - b[0]);

    // a status packet is laid out as an instruction packet without parameters, its error byte where the
    // instruction is: FF FF ID 02 ERROR CHECKSUM
    return answers.flatMap(([id, status]) => Array.from(protocol.instructionPacket(id, status, [])));
  }

  /** Hands the page what the servos answered, in uneven pieces, as a serial driver delivers bytes. */
  private deliver(bytes: Uint8Array): void {
    const controller = this.readController;
    if (controller === null || bytes.length === 0) return;

    const pieces = [5, 3, 11, 2, 16];
    let offset = 0;
    for (let index = 0; offset < bytes.length; index++) {
      const size = pieces[index % pieces.length] as number;
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    }
  }
}
