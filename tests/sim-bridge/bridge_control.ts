// Not in PEAR: the test interface of a simulated SO-101 servo chain reachable over TCP (not part of this
// repository). Besides its serial line the chain offers controls over HTTP on 127.0.0.1, which a test uses to put
// the simulated arm in a known state and to break it on purpose. docs/progress/sim-bridge.md describes them.

import type { MotorCalibration } from "../../src/feetech/bus";
import { parseCalibration } from "../../src/so101/hardware/follower";

/** What `GET /state` answers, as far as the tests read it. */
export interface BridgeState {
  /** "realtime": the simulated arm ages with the wall clock; "packets": only when the line is used. */
  clock: string;
  steps_per_packet: number | null;
  timestep_s: number;
  time_s: number;
  joints_rad: Record<string, number>;
  gripper_opening: number;
  torque_enabled: Record<string, boolean>;
  line: { client: string | null; instructions: Record<string, number>; unanswered: Record<string, number> };
}

/** One segment of the recorded traffic: the packets between two marks, in the order they crossed the line.
 * ["h", hex] is an instruction packet of the host, ["s", hex] a status packet of a servo. */
export interface TrafficSegment {
  label: string;
  packets: [direction: "h" | "s", hex: string][];
}

/** Returns where the controls and the line are, from the environment: PEAR_JS_SIM_BRIDGE=host:port is the line,
 * PEAR_JS_SIM_BRIDGE_CONTROL=host:port the controls (by default the line's host and the next port). */
export function bridgeAddress(env: Record<string, string | undefined> = process.env): {
  host: string;
  port: number;
  control: string;
} | null {
  const line = env.PEAR_JS_SIM_BRIDGE;
  if (line === undefined || line === "") return null;

  const separator = line.lastIndexOf(":");
  const host = line.slice(0, separator);
  const port = Number(line.slice(separator + 1));
  if (separator <= 0 || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PEAR_JS_SIM_BRIDGE must be host:port, not '${line}'`);
  }

  return { host, port, control: env.PEAR_JS_SIM_BRIDGE_CONTROL || `${host}:${port + 1}` };
}

/** The controls of the simulated servo chain. */
export class BridgeControl {
  private readonly base: string;

  /** ``control`` is host:port. */
  constructor(control: string) {
    this.base = `http://${control}`;
  }

  state(): Promise<BridgeState> {
    return this.request<BridgeState>("/state");
  }

  /** The arm as after power-up: at rest, torque off, no fault set, no traffic recorded. */
  reset(): Promise<BridgeState> {
    return this.request<BridgeState>("/reset", {});
  }

  /** Starts a new segment of the recorded traffic. */
  async mark(label: string): Promise<void> {
    await this.request("/mark", { label });
  }

  /** Resolves once the simulated arm is ``seconds`` older. */
  async wait(seconds: number): Promise<void> {
    await this.request("/wait", { seconds });
  }

  /** Sets faults on the chain: a servo's Status bits, registers changed behind the bus's back, absent servos, lost
   * answers, a silent line; ``{clear: true}`` removes them. */
  async inject(faults: Record<string, unknown>): Promise<void> {
    await this.request("/inject", faults);
  }

  /** The packets of both directions since the last reset. */
  traffic(): Promise<TrafficSegment[]> {
    return this.request<TrafficSegment[]>("/traffic");
  }

  /** The arm's calibration, which the chain serves in the format of lerobot's calibration file. */
  async calibration(): Promise<Record<string, MotorCalibration>> {
    return parseCalibration(JSON.stringify(await this.request("/calibration")));
  }

  /** The calibration as the chain serves it, for a result file. */
  calibrationFile(): Promise<Record<string, Record<string, number>>> {
    return this.request("/calibration");
  }

  private async request<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    const response = await fetch(
      this.base + path,
      body === undefined
        ? undefined
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
    const text = await response.text();
    if (!response.ok) throw new Error(`The servo chain's controls refused ${path}: ${response.status} ${text}`);

    return JSON.parse(text) as T;
  }
}
