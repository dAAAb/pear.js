// Not in PEAR: runs the scripted sessions of session.json with pear.js's hardware layer (src/so101/hardware) on a
// simulated SO-101 servo chain reachable over TCP, and records what every step returned or threw and the packets
// the chain saw. A reference runner outside this repository runs the same file with PEAR's own SO101Driver on the
// same chain and writes a result of the same form; compare.ts compares the two.
//
// make_session.py says what a step is.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SO101ArmState } from "../../src/so101/hardware/arm_state";
import { SO101Hardware } from "../../src/so101/hardware/arms";
import { ARM, SO101Driver } from "../../src/so101/hardware/driver";
import { SO101Follower } from "../../src/so101/hardware/follower";
import type { BridgeControl, TrafficSegment } from "./bridge_control";
import { TcpTransport } from "./tcp_transport";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SESSION_FILE = join(HERE, "session.json");
export const RESULT_FORMAT = "pear.js-sim-bridge-result/1";

/** The arm's settings, which both runners use. */
export interface ArmSettings {
  joint_offsets: number[];
  status_poll_ticks: number;
  state_timeout_s: number;
  position_p_coefficient: number;
  control_period_s: number;
  lower_bounds: number[];
  upper_bounds: number[];
}

export interface Step {
  op: string;
  label?: string;
  seconds?: number;
  faults?: Record<string, unknown>;
  target?: number[];
  velocity?: number[] | null;
  count?: number;
}

export interface SessionDocument {
  format: string;
  arm: ArmSettings;
  sessions: { name: string; steps: Step[] }[];
}

/** A reading of the arm with the reference's keys. */
export interface Reading {
  position: number[];
  velocity: number[];
  sample_id: number | null;
  servo_status: { torque: Record<string, number>; status: Record<string, number> };
}

export interface StepError {
  /** The error's class: Python's on the reference side, the JavaScript class's name here. */
  type: string;
  message: string;
}

/** What one step did. */
export interface StepRecord {
  op: string;
  label?: string;
  /** Why the step did nothing: the arm was not open. */
  skipped?: string;
  released?: string;
  result?: Reading | null;
  error?: StepError;
  /** What the hardware layer warned of meanwhile: a retried enable, a kept reading. */
  warnings?: string[];
  /** How long the step took, ms; of a cycle its read and its send, of a burst those of each of its cycles. */
  ms: number;
  read_ms?: number | number[];
  send_ms?: number | number[];
  tick_started_ms?: number;
}

export interface SessionResult {
  name: string;
  steps: StepRecord[];
  traffic: TrafficSegment[];
}

export interface RunResult {
  format: string;
  side: string;
  implementation: Record<string, string>;
  /** The name of the line in messages, which each side chooses. */
  port_name: string;
  bridge: { clock: string; steps_per_packet: number | null; timestep_s: number };
  session_sha256: string;
  arm: ArmSettings;
  calibration: Record<string, Record<string, number>>;
  sessions: SessionResult[];
}

export interface RunOptions {
  host: string;
  port: number;
  control: BridgeControl;
  /** The sessions to run, by name; all by default. */
  only?: readonly string[];
}

export function loadSessions(): { document: SessionDocument; sha256: string } {
  const bytes = readFileSync(SESSION_FILE);

  return {
    document: JSON.parse(bytes.toString("utf8")) as SessionDocument,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function reading(state: SO101ArmState | null): Reading | null {
  if (state === null) return null;

  return {
    position: state.position,
    velocity: state.velocity,
    sample_id: state.sampleId,
    servo_status: { torque: state.servoStatus.torque ?? {}, status: state.servoStatus.status ?? {} },
  };
}

function errorOf(error: unknown): StepError {
  return error instanceof Error ? { type: error.name, message: error.message } : { type: typeof error, message: String(error) };
}

/** What a session holds open between its steps. */
interface Held {
  transport: TcpTransport | null;
  follower: SO101Follower | null;
  driver: SO101Driver | null;
}

/** Closes the line if it is open, which sends nothing, and forgets the arm. */
async function letGo(held: Held): Promise<void> {
  if (held.transport !== null) await held.transport.close().catch(() => undefined);
  held.transport = null;
  held.follower = null;
  held.driver = null;
}

/** Resolves at ``deadlineMs`` on performance.now()'s clock. A timer may be late by many milliseconds (on some
 * systems it is no finer than 16 ms), so it only covers what is far off; the rest is turns of the event loop. */
async function sleepUntil(deadlineMs: number): Promise<void> {
  const coarseMs = deadlineMs - performance.now() - 40;
  if (coarseMs > 0) await new Promise((resolve) => setTimeout(resolve, coarseMs));
  while (performance.now() < deadlineMs) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Runs the sessions of session.json with pear.js's hardware layer and returns what happened. */
export async function runSessions(options: RunOptions): Promise<RunResult> {
  const { document, sha256 } = loadSessions();
  const { control } = options;
  const arm = document.arm;
  const state = await control.state();
  const calibration = await control.calibration();
  const portName = `tcp://${options.host}:${options.port}`;
  const isPaced = state.clock === "realtime";
  const periodMs = arm.control_period_s * 1000;

  const sessions: SessionResult[] = [];
  for (const session of document.sessions) {
    if (options.only !== undefined && options.only.length > 0 && !options.only.includes(session.name)) continue;

    const held: Held = { transport: null, follower: null, driver: null };
    let nextTickMs = 0;
    const warnings: string[] = [];
    const records: StepRecord[] = [];

    for (const step of session.steps) {
      const record: StepRecord = { op: step.op, ms: 0 };
      const warningsBefore = warnings.length;
      const started = performance.now();
      const driver = held.driver; // the arm the step uses, if one is open
      try {
        if (step.op === "reset") {
          await control.reset();
        } else if (step.op === "mark") {
          record.label = step.label ?? "";
          await control.mark(record.label);
        } else if (step.op === "wait") {
          await control.wait(step.seconds ?? 0);
        } else if (step.op === "inject") {
          await control.inject(step.faults ?? {});
        } else if (step.op === "open") {
          // PEAR's driver makes its arm itself; here the arm is opened and the driver given it
          held.transport = await TcpTransport.connect(options.host, options.port);
          held.follower = new SO101Follower(
            held.transport,
            calibration,
            { positionPCoefficient: arm.position_p_coefficient },
            { port: portName },
          );
          const hardware = await SO101Hardware.open(held.follower, {
            jointOffsets: arm.joint_offsets,
            statusPollTicks: arm.status_poll_ticks,
            stateTimeoutS: arm.state_timeout_s,
            onWarning: (message) => warnings.push(message),
          });
          held.driver = new SO101Driver(
            hardware,
            { lowerBounds: arm.lower_bounds, upperBounds: arm.upper_bounds },
            null,
            { onWarning: (message) => warnings.push(message) },
          );
        } else if (step.op === "release") {
          if (held.driver !== null && held.follower !== null && held.follower.isConnected) {
            // a close that failed left the bus connected: the reference's runner closes its port here too
            record.released = "the runner closed the port";
          }
          await letGo(held);
        } else if (driver === null) {
          record.skipped = "the arm is not open";
        } else if (step.op === "read") {
          record.result = reading((await driver.read())[ARM]);
        } else if (step.op === "read_for_recovery") {
          record.result = reading((await driver.readForRecovery())[ARM]);
        } else if (step.op === "send") {
          const velocity = step.velocity ?? null;
          await driver.send({ [ARM]: step.target ?? [] }, velocity === null ? null : { [ARM]: velocity });
        } else if (step.op === "refresh_hold") {
          await driver.refreshHold({ [ARM]: step.target ?? [] });
        } else if (step.op === "cycle") {
          if (isPaced) await sleepUntil(nextTickMs);
          const tickStarted = performance.now();
          nextTickMs = tickStarted + periodMs;
          const armState = (await driver.read())[ARM];
          const readDone = performance.now();
          await driver.send({ [ARM]: step.target ?? [] }, { [ARM]: step.velocity ?? [] });
          const sendDone = performance.now();
          record.result = reading(armState);
          record.read_ms = readDone - tickStarted;
          record.send_ms = sendDone - readDone;
          record.tick_started_ms = tickStarted;
        } else if (step.op === "burst") {
          const readMs: number[] = [];
          const sendMs: number[] = [];
          let armState: SO101ArmState | null = null;
          for (let index = 0; index < (step.count ?? 0); index++) {
            const cycleStarted = performance.now();
            armState = (await driver.read())[ARM];
            const readDone = performance.now();
            await driver.send({ [ARM]: step.target ?? [] });
            readMs.push(readDone - cycleStarted);
            sendMs.push(performance.now() - readDone);
          }
          record.result = reading(armState);
          record.read_ms = readMs;
          record.send_ms = sendMs;
        } else if (step.op === "close") {
          await driver.close();
        } else {
          throw new Error(`unknown step '${step.op}'`);
        }
      } catch (error) {
        record.error = errorOf(error);
        // the arm did not open: whatever the failed start-up left open is closed, which sends nothing
        if (step.op === "open") await letGo(held);
      }
      record.ms = performance.now() - started;
      if (warnings.length > warningsBefore) record.warnings = warnings.slice(warningsBefore);
      records.push(record);
    }

    await letGo(held);
    sessions.push({ name: session.name, steps: records, traffic: await control.traffic() });
  }

  return {
    format: RESULT_FORMAT,
    side: "pear.js",
    implementation: {
      node: process.version,
      platform: process.platform,
      line: "TCP socket (node:net)",
    },
    port_name: portName,
    bridge: { clock: state.clock, steps_per_packet: state.steps_per_packet, timestep_s: state.timestep_s },
    session_sha256: sha256,
    arm,
    calibration: await control.calibrationFile(),
    sessions,
  };
}
