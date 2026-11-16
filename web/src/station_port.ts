// Not in PEAR: the Worker's way to a serial port, and the only place in the Worker's code that names
// `navigator.serial` or `getPorts`. A port is opened here as the window opens one (arm.ts, openLine): the port in
// a ResilientPort, the library's WebSerialTransport on it, and the read-only guard (readonly.ts) as the outermost
// transport. Only the guard is given out: whoever has the line this file returns can ping and read the servos
// and nothing else, because the transport beneath the guard never leaves the function that made it.

import { DEFAULT_BAUDRATE, type SerialPortLike, WebSerialTransport } from "../../src/feetech/index";
import { ReadOnlyTransport } from "./readonly";
import { ResilientPort } from "./serial_port";
import type { UsbIds } from "./station_protocol";

/** A port as `getPorts()` gives it: a serial port that may say what its adapter is. */
export interface GrantedPort extends SerialPortLike {
  getInfo?(): { usbVendorId?: number; usbProductId?: number } | undefined;
}

/** Where ports come from: what the Worker uses of a navigator's `serial`. */
export interface SerialSource {
  getPorts(): Promise<readonly GrantedPort[]>;
}

/** Returns the Worker's `navigator.serial`; null when its navigator has none. */
export function workerSerial(): SerialSource | null {
  const serial = (globalThis as { navigator?: { serial?: SerialSource } }).navigator?.serial;

  return serial ?? null;
}

/** Returns the ports the page was granted, as `source` gives them. */
export async function grantedPorts(source: SerialSource): Promise<GrantedPort[]> {
  return [...(await source.getPorts())];
}

/** Returns the USB ids `port` says of its adapter; null when it gives none. */
export function usbIdsOf(port: GrantedPort): UsbIds | null {
  const info = port.getInfo?.();
  if (info?.usbVendorId === undefined || info.usbProductId === undefined) return null;

  return { vendorId: info.usbVendorId, productId: info.usbProductId };
}

/** A port's line, open for reading only. */
export interface ReadOnlyLine {
  /** The line as a bus gets it: the read-only guard. What it let through and refused is in its `counts`, and
   * why the line stopped working, if it did, in its `failure`. */
  readonly guard: ReadOnlyTransport;
  /** How many errors the line has survived since it was opened. */
  lineErrors(): number;
  /** Closes the port; resolves with whether the port is closed then, and never throws. */
  close(): Promise<boolean>;
}

/** Whether `port` is closed: an open port has its streams. */
function isPortClosed(port: SerialPortLike): boolean {
  return port.readable === null && port.writable === null;
}

/**
 * Opens `port` as the servos speak (1 000 000 baud, 8 data bits, no parity, one stop bit) behind the read-only
 * guard. Throws what the port's open() throws, with the port left closed.
 */
export async function openReadOnly(port: SerialPortLike): Promise<ReadOnlyLine> {
  // a port this Worker left open (a failed close) would refuse to open again
  if (!isPortClosed(port)) await port.close().catch(() => undefined);

  // the transport reads through a port that survives an error of the line (serial_port.ts)
  const line = new ResilientPort(port);
  let guard: ReadOnlyTransport;
  try {
    // the guard is the outermost, and the transport it guards has no other name than this expression
    guard = new ReadOnlyTransport(await WebSerialTransport.open(line, DEFAULT_BAUDRATE));
  } catch (error) {
    // an open that failed after the port was taken must not leave it taken
    if (!isPortClosed(port)) await line.close().catch(() => undefined);
    throw error;
  }
  let closing: Promise<boolean> | null = null;

  return {
    guard,
    lineErrors: () => line.lineErrors.count,
    close: () => {
      closing ??= guard
        .close()
        .catch(() => undefined) // the port's own state says whether it is closed
        .then(() => isPortClosed(port));

      return closing;
    },
  };
}
