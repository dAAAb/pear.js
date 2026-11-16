// The entry of the page's Worker: the station (station_host.ts) on the Worker's messages and, for the hand-over
// of a real arm's line, on the Worker's serial ports (station_port.ts). The build puts this
// file's bundle into the page's one script as a text, and the window starts it from a Blob URL
// (station_client.ts), so that the built folder stays one page, one script and one style sheet.

import { StationHost } from "./station_host";
import { workerSerial } from "./station_port";
import type { FromStation, ToStation } from "./station_protocol";

const scope = self as unknown as {
  postMessage(message: FromStation): void;
  onmessage: ((event: MessageEvent<ToStation>) => void) | null;
};

const host = new StationHost((message) => scope.postMessage(message), workerSerial());
scope.onmessage = (event) => host.handle(event.data);
scope.postMessage({ kind: "ready" });
