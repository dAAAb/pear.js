// What the library's WebSerialTransport does on a port that behaves as the Web Serial specification says, where
// that differs from a port that only ever works: an error of the line that the port survives, and a device that
// is lost. Run in Node by web/tests/run_node.mjs; web/tests/browser_check.py records the result and checks the
// page's own port (web/src/serial_port.ts) against the same events.
//
// The port is the page's simulated one (web/src/sim_port.ts): real streams, simulated servos. It is a model of
// the specification, not a measurement of a browser's port.

import { FeetechMotorsBus, WebSerialTransport } from "../../src/feetech/index";
import { followerMotors } from "../../src/so101/hardware/index";
import { ResilientPort } from "../src/serial_port";
import { SIM_CALIBRATION, SimArm } from "../src/sim_port";

type Outcome = "read" | { error: string };

async function attempt(bus: FeetechMotorsBus): Promise<Outcome> {
  try {
    const values = await bus.syncRead("Present_Position", null, { normalize: false });
    return Object.keys(values).length === 6 ? "read" : { error: "fewer than six values" };
  } catch (error) {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

async function closing(transport: WebSerialTransport): Promise<Outcome | "closed"> {
  try {
    await transport.close();
    return "closed";
  } catch (error) {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

export interface ProbeResult {
  /** The library's transport on the port itself, around an error of the line the port survives. */
  bare: { before: Outcome; after: Outcome; later: Outcome; portOffersANewStream: boolean; close: Outcome | "closed" };
  /** The same through the page's port. */
  resilient: { before: Outcome; after: Outcome; later: Outcome; lineErrors: number; close: Outcome | "closed" };
  /** The library's transport when the device is lost: the next read, and close(). */
  lost: { before: Outcome; after: Outcome; close: Outcome | "closed" };
}

export async function main(): Promise<ProbeResult> {
  const motors = followerMotors();

  const first = new SimArm();
  const bareTransport = await WebSerialTransport.open(first.port);
  const bareBus = new FeetechMotorsBus(bareTransport, motors, { ...SIM_CALIBRATION });
  await bareBus.connect(false);
  const bareBefore = await attempt(bareBus);
  first.port.glitch("FramingError");
  const bareAfter = await attempt(bareBus);
  const bareLater = await attempt(bareBus);
  const offers = first.port.readable !== null && !first.port.readable.locked;
  const bareClose = await closing(bareTransport);

  const second = new SimArm();
  const line = new ResilientPort(second.port);
  const resilientTransport = await WebSerialTransport.open(line);
  const resilientBus = new FeetechMotorsBus(resilientTransport, motors, { ...SIM_CALIBRATION });
  await resilientBus.connect(false);
  const resilientBefore = await attempt(resilientBus);
  second.port.glitch("FramingError");
  // the read in flight when the line failed may be lost; the bus's retry is what a caller has
  const resilientAfter = await attempt(resilientBus);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const resilientLater = await attempt(resilientBus);
  const resilientClose = await closing(resilientTransport);

  const third = new SimArm();
  const lostTransport = await WebSerialTransport.open(third.port);
  const lostBus = new FeetechMotorsBus(lostTransport, motors, { ...SIM_CALIBRATION });
  await lostBus.connect(false);
  const lostBefore = await attempt(lostBus);
  third.port.unplug();
  const lostAfter = await attempt(lostBus);
  const lostClose = await closing(lostTransport);

  return {
    bare: { before: bareBefore, after: bareAfter, later: bareLater, portOffersANewStream: offers, close: bareClose },
    resilient: {
      before: resilientBefore,
      after: resilientAfter,
      later: resilientLater,
      lineErrors: line.lineErrors.count,
      close: resilientClose,
    },
    lost: { before: lostBefore, after: lostAfter, close: lostClose },
  };
}
