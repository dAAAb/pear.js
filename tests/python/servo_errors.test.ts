// The servo layer (src/feetech, src/so101/hardware) throws, at each place, an error with the name of the class
// lerobot or PEAR raises there. The fixtures of tests/feetech hold 81 such errors; these are the places they have no
// case for, with what the reference's own functions raised (tests/python/make_reference.py, ServoErrors): the same
// call is made here and the error's name, its Python bases and its text are compared.

import { describe, expect, test } from "vitest";

import { feetech, python, so101 } from "../../src/index";
import { reference } from "./reference";

const { FeetechMotorsBus, ManualClock } = feetech;
const { connectChecked, simulatedArm, SO101Follower, SO101Hardware } = so101.hardware;

/** A line nothing is written to and nothing comes from. */
const silent: feetech.Transport = {
  write: async () => undefined,
  read: async () => new Uint8Array(0),
  close: async () => undefined,
};

// the reference's bus: two motors, and a calibration of the first alone
const MOTORS = { pan: { id: 1, normMode: "degrees" }, lift: { id: 2, normMode: "degrees" } } as const;
const CALIBRATION = { pan: { id: 1, driveMode: 0, homingOffset: 0, rangeMin: 1000, rangeMax: 3000 } };

/** A whole arm's calibration, every servo with the same range. */
function armCalibration(rangeMax = 3000): Record<string, feetech.MotorCalibration> {
  return Object.fromEntries(
    Object.entries(so101.hardware.followerMotors()).map(([motor, { id }]) => [
      motor,
      { id, driveMode: 0, homingOffset: 0, rangeMin: 1000, rangeMax },
    ]),
  );
}

/** Returns an arm that was opened on a simulated servo chain and closed again. */
async function closedArm(): Promise<so101.hardware.SO101Hardware> {
  const clock = new ManualClock();
  const chain = simulatedArm(armCalibration(), {}, { clock });
  const follower = new SO101Follower(chain, armCalibration(), {}, { clock });
  const hardware = await SO101Hardware.open(follower, {
    jointOffsets: [0, 0, 0, 0, 0],
    statusPollTicks: 10,
    stateTimeoutS: 0.2,
  });
  await hardware.close();

  return hardware;
}

/** The call of pear.js for each place of the reference, by the reference's description of it. */
const SITES: Record<string, () => unknown> = {
  "two motors with one id": () =>
    new FeetechMotorsBus(silent, { pan: { id: 1, normMode: "degrees" }, lift: { id: 1, normMode: "degrees" } }),
  "a motor's name the bus does not have": () => new FeetechMotorsBus(silent, MOTORS, CALIBRATION).ping("wrist"),
  "a motor's id the bus does not have": () => new FeetechMotorsBus(silent, MOTORS, CALIBRATION).normalize(new Map([[9, 2000]])),
  "a motor without a calibration": () => new FeetechMotorsBus(silent, MOTORS, CALIBRATION).normalize(new Map([[2, 2000]])),
  "a register of three bytes": () =>
    // (lerobot's _read: the bus's own reading of a register, which no public call gives three bytes)
    (
      new FeetechMotorsBus(silent, MOTORS, CALIBRATION) as unknown as {
        readRegister(address: number, length: number, motorId: number): Promise<unknown>;
      }
    ).readRegister(0, 3, 1),
  "a position that is NaN": () => new FeetechMotorsBus(silent, MOTORS, CALIBRATION).unnormalize(new Map([[1, Number.NaN]])),
  "a position that is infinite": () => new FeetechMotorsBus(silent, MOTORS, CALIBRATION).unnormalize(new Map([[1, Infinity]])),
  "a register the servo does not have": () => feetech.getAddress("Present_Speed"),
  "a read of an arm that is closed": async () => (await closedArm()).read(),
  "a command to an arm that is closed": async () => (await closedArm()).send([0, 0, 0, 0, 0, 0.5]),
  "an arm without a calibration": () => connectChecked(new SO101Follower(silent, null)),
  "a calibration that the servos do not hold": () => {
    const clock = new ManualClock();
    const chain = simulatedArm(armCalibration(), {}, { clock });

    return connectChecked(new SO101Follower(chain, armCalibration(2999), {}, { clock }));
  },
};

/**
 * Where pear.js words an error itself: its text for each such place. lerobot's text there is the bare key of a
 * dictionary, Python's own sentence of int(), or names a file and a command a page does not have; none of these
 * places is reached by a station that runs (docs/progress/common.md).
 */
const OWN_WORDS: Record<string, string> = {
  "a motor's name the bus does not have": "Unknown motor 'wrist'",
  "a motor's id the bus does not have": "Unknown motor id 9",
  "a motor without a calibration": "No calibration for motor 'lift'",
  "a position that is NaN": "cannot convert NaN to integer",
  "a position that is infinite": "cannot convert Infinity to integer",
  "a register the servo does not have": "Address for 'Present_Speed' not found in sts3215 control table.",
  "an arm without a calibration": "No calibration: calibrate the arm with lerobot and give its calibration file",
};

/** The library's class for each Python class the reference raised at these places. */
const CLASSES: Record<string, abstract new (...arguments_: never[]) => Error> = {
  ValueError: python.ValueError,
  KeyError: python.KeyError,
  OverflowError: python.OverflowError,
  RuntimeError: python.RuntimeError,
};
const BASES: Record<string, abstract new (...arguments_: never[]) => Error> = {
  ...CLASSES,
  LookupError: python.LookupError,
  ArithmeticError: python.ArithmeticError,
  Exception: python.PythonException,
};

async function thrownBy(call: () => unknown): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }
  throw new Error("Nothing was thrown");
}

describe("the servo layer's errors are the reference's classes", () => {
  test("every place of the reference has its call here, and the other way round", () => {
    expect(Object.keys(SITES).sort()).toEqual(Object.keys(reference.servo_errors).sort());
    expect(Object.keys(reference.servo_errors).length).toBe(12);
    expect(new Set(Object.values(reference.servo_errors).map((raised) => raised.type))).toEqual(new Set(Object.keys(CLASSES)));
  });

  test.each(Object.entries(reference.servo_errors))("%s", async (site, raised) => {
    const error = await thrownBy(SITES[site]!);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe(raised.type);
    expect(python.pythonErrorName(error)).toBe(raised.type);
    expect(error).toBeInstanceOf(CLASSES[raised.type]!);
    // isinstance of every base the reference's error has, and of no other of these classes
    for (const [name, base] of Object.entries(BASES)) {
      expect([name, error instanceof base]).toEqual([name, raised.bases.includes(name)]);
    }
    expect(python.isValueError(error)).toBe(raised.bases.includes("ValueError"));

    if (site in OWN_WORDS) {
      expect((error as Error).message).toBe(OWN_WORDS[site]);
      expect((error as Error).message).not.toBe(raised.message);
    } else {
      expect((error as Error).message).toBe(raised.message);
    }
  });

  test("a failed exchange and a servo's error byte are told by their names too", async () => {
    const clock = new ManualClock();
    const chain = simulatedArm(armCalibration(), {}, { clock });
    const follower = new SO101Follower(chain, armCalibration(), {}, { clock });
    await follower.bus.connect(true);

    // a servo that does not answer: lerobot's ConnectionError, with the SDK's result
    chain.absent.add(3);
    const lost = await thrownBy(() => follower.bus.read("Present_Position", "elbow_flex"));
    expect((lost as Error).name).toBe("ConnectionError");
    expect(lost).toBeInstanceOf(feetech.FeetechCommError);
    expect(lost).toBeInstanceOf(python.OSError);
    chain.absent.delete(3);

    // a servo that reports an error: lerobot's RuntimeError, with the error byte
    chain.servo(3).set("Status", 0x20);
    const faulty = await thrownBy(() => follower.bus.read("Present_Position", "elbow_flex"));
    expect((faulty as Error).name).toBe("RuntimeError");
    expect(faulty).toBeInstanceOf(feetech.FeetechStatusError);
    expect(faulty).not.toBeInstanceOf(python.OSError);
    expect(python.motionErrorOf(faulty)).toEqual({
      code: "RuntimeError",
      message: "Failed to read 'Present_Position' on id_=3 after 1 tries. [RxPacketError] Overload error!",
    });

    // a bus that was never connected, and one connected twice: lerobot's own two classes, ConnectionErrors both
    const idle = new SO101Follower(silent, armCalibration());
    const notConnected = await thrownBy(() => idle.bus.read("Present_Position", "gripper"));
    expect((notConnected as Error).name).toBe("DeviceNotConnectedError");
    expect(notConnected).toBeInstanceOf(python.ConnectionError);
    const twice = await thrownBy(() => follower.bus.connect(false));
    expect((twice as Error).name).toBe("DeviceAlreadyConnectedError");
    expect(twice).toBeInstanceOf(python.ConnectionError);

    // a servo's fault is PEAR's ServoFault, a RuntimeError
    const fault = await thrownBy(() => SO101Hardware.checkStatus({ elbow_flex: 0x20 }));
    expect((fault as Error).name).toBe("ServoFault");
    expect(fault).toBeInstanceOf(python.RuntimeError);
    expect(python.motionErrorOf(fault)).toEqual({ code: "ServoFault", message: "Servo error: elbow_flex: overload" });
  });
});
