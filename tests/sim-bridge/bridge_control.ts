// Not in PEAR: the test interface of a simulated SO-101 servo chain reachable over TCP (not part of this
// repository). Besides its serial line the chain offers controls over HTTP on 127.0.0.1, which a test uses to put
// the simulated arm in a known state and to break it on purpose. docs/progress/sim-bridge.md describes them.

import http from "node:http";

import type { MotorCalibration } from "../../src/feetech/bus";
import { parseCalibration } from "../../src/so101/hardware/follower";

/** What `GET /state` answers, as far as the tests read it. */
export interface BridgeState {
  /** "realtime": the simulated arm ages with the wall clock; "packets": only when the line is used. */
  clock: string;
  steps_per_packet: number | null;
  /** In a chain started for a stepped station: the physics steps the arm ages just before each sync read of
   * Present_Position, and at no other time. */
  steps_per_position_read?: number | null;
  timestep_s: number;
  time_s: number;
  joints_rad: Record<string, number>;
  gripper_opening: number;
  torque_enabled: Record<string, boolean>;
  /** In a chain whose scene holds objects: the fixed fingertip, the middle between the fingers, each object's pose. */
  fingertip_m?: number[];
  grasp_m?: number[];
  objects?: Record<string, { position_m: number[]; quat: number[] }>;
  line: {
    client: string | null;
    instructions: Record<string, number>;
    unanswered: Record<string, number>;
    /** Packets that were part of no valid packet, bytes that were dropped, and what the line reported. */
    corrupt_packets?: number;
    dropped_bytes?: number;
    errors?: string[];
  };
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

  /** Puts an object of the simulated scene at rest at ``position_m``. Like a mark and a fault it takes effect just
   * before the next instruction packet that is not a sync write. */
  async place(object: string, positionM: readonly number[]): Promise<void> {
    await this.request("/place", { object, position_m: positionM });
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

  /** One call of the controls, on a connection of its own. On a connection kept alive (`fetch`'s, or an agent's of
   * `node:http`) every answer of the chain's server comes about 40 ms late, measured on Linux; on a new one it
   * takes under 1 ms. In real time 40 ms are two control periods, which the loop runs between a station's steps. */
  private request<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    const text = body === undefined ? null : JSON.stringify(body);

    return new Promise<T>((resolve, reject) => {
      const request = http.request(
        this.base + path,
        {
          method: text === null ? "GET" : "POST",
          agent: false,
          headers:
            text === null ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            const answer = Buffer.concat(chunks).toString("utf8");
            const status = response.statusCode ?? 0;
            if (status < 200 || status > 299) {
              reject(new Error(`The servo chain's controls refused ${path}: ${status} ${answer}`));
              return;
            }
            try {
              resolve(JSON.parse(answer) as T);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on("error", reject);
      if (text === null) request.end();
      else request.end(text);
    });
  }
}
