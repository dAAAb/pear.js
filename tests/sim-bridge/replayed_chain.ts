// Not in PEAR: a simulated SO-101 servo chain replayed from a result of the reference (a StationRunResult of PEAR's
// own Python station on the chain, docs/progress/station-reference.md), in process: it needs no chain. Such a
// result holds, step by step, every packet that crossed the line in PEAR's run, in order. A ReplayedChain is to
// StationRunner what the chain is, its line (the bus's transport) and its controls, both served from the result.
//
// The line. Every instruction packet the host writes must be the next one of the step's record; the status packets
// that follow it there are handed back. So a host that sends what PEAR sent reads what PEAR read. A packet that is
// not PEAR's ends the run: no chain is here to answer it.
// The controls. A mark moves to the next step's record, by the chain's own rule: it takes effect just before the
// next instruction packet that is not a sync write. The state is the reference's record of the marked step's end.
// A fault and a placed object do nothing: what they caused is in the answers.
//
// What a replay shows, and what it cannot. The servo side is PEAR's recording: the status packets, the simulated
// world, the line's counters, the chain's clock and the calibration in the result of a replayed run are copies of
// the reference's and prove nothing. The host's own are its instruction packets, each one required here, and every
// value its station computes and returns from the answers. Where a host would send something else than PEAR, the
// replay stops at that packet: what a chain would have answered, and all that follows from it, is not known here.
//
// station_reference.result.json.gz is the reference's result of all 8 sessions, as the reference runner wrote it
// but for one entry of its `run` record (the name of the reference's own line, a path on its machine; `run` is
// never compared). It is made of the runner's result file by
//   node -e "const fs=require('fs'),z=require('zlib'),[from,to]=process.argv.slice(1);
//     const text=fs.readFileSync(from,'latin1').replace(/\x22port_name\x22: \x22[^\x22]*\x22, /,'');
//     const file=z.gzipSync(Buffer.from(text,'latin1'),{level:9});file[9]=3;fs.writeFileSync(to,file)" <from> <to>
// (level 9, no time and no file name in the header, the header's system byte that of the repository's other
// fixtures). The packed bytes depend on the zlib at hand; the content does not, and STATION_REFERENCE_SHA256 is its
// SHA-256.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import type { MotorCalibration } from "../../src/feetech/bus";
import type { Transport } from "../../src/feetech/transport";
import { parseCalibration } from "../../src/so101/hardware/follower";
import type { BridgeState, TrafficSegment } from "./bridge_control";
import { STATION_RESULT_FORMAT, type Packet, type StationRunResult, type StationSessionResult, type StationStepRecord } from "./station_result";

/** The SHA-256 of the content of station_reference.result.json.gz. */
export const STATION_REFERENCE_SHA256 = "f243b76509ae98d465bcfd77900aa2ae0512a0a77f29b095ee8e72b18e79c3ba";

const SESSION_MARK = "session: "; // the label of the mark that starts a session's traffic, before its name
const SYNC_WRITE = 0x83; // the instruction no servo answers
/** The start of a sync write of Goal_Position, as hex: the header, the broadcast id, the length, the instruction,
 * the register's address and its length. */
const GOAL_WRITE = /^fffffe..832a02/;
const HEX = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, "0"));

/** The reference's stored result of all the sessions, and the SHA-256 of its content. */
export function loadStationReference(
  path: string = fileURLToPath(new URL("./station_reference.result.json.gz", import.meta.url)),
): { result: StationRunResult; sha256: string } {
  const content = gunzipSync(readFileSync(path));
  const result = JSON.parse(content.toString("utf8")) as StationRunResult;
  if (result.format !== STATION_RESULT_FORMAT) throw new Error(`${path} is not a ${STATION_RESULT_FORMAT}`);

  return { result, sha256: createHash("sha256").update(content).digest("hex") };
}

function hexOf(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += HEX[byte];

  return text;
}

function bytesOf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(hex.slice(2 * index, 2 * index + 2), 16);

  return bytes;
}

function labelOf(step: StationStepRecord): string {
  return `${step.id} ${step.op}`;
}

/** Whether two instruction packets are the same sync write of Goal_Position to the same servos in the same order,
 * with other goals (and so another checksum). */
export function differInGoalsAlone(ours: string, theirs: string): boolean {
  if (ours.length !== theirs.length || !GOAL_WRITE.test(ours) || ours.slice(0, 14) !== theirs.slice(0, 14)) return false;
  // after the register: for each servo its id and the two bytes of its goal; the last byte is the checksum
  for (let at = 14; at + 6 <= ours.length - 2; at += 6) {
    if (ours.slice(at, at + 2) !== theirs.slice(at, at + 2)) return false;
  }

  return true;
}

/** Why a replay ended: the host did something that PEAR's run did not. */
export class ReplayError extends Error {
  override readonly name: string = "ReplayError";
}

export interface ReplayOptions {
  /** Lets a sync write of Goal_Position pass whose goals alone differ from PEAR's: for a host whose planner answers
   * in other last bits. The answers that follow are still those PEAR's arm gave. Off by default. */
  goalsMayDiffer?: boolean;
}

/** The replayed chain's line: what is written is checked against PEAR's run, what PEAR's servos answered is read. */
export class ReplayedLine implements Transport {
  isClosed = false;

  private waiting: Uint8Array[] = []; // handed back and not yet read
  private offset = 0; // how much of the first of them is read

  constructor(private readonly chain: ReplayedChain) {}

  async write(bytes: Uint8Array): Promise<void> {
    if (this.isClosed) throw new Error("The line is closed");
    for (const answer of this.chain.instruction(bytes)) this.waiting.push(answer);
  }

  async read(maxLength: number, timeoutMs: number): Promise<Uint8Array> {
    this.chain.check();
    if (this.waiting.length === 0) {
      if (this.isClosed) throw new Error("The line is closed");
      // nothing comes later on a replayed line: as on a silent one, the read gives up when its time is over
      if (timeoutMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));

      return new Uint8Array(0);
    }

    const taken: number[] = [];
    while (taken.length < maxLength && this.waiting.length > 0) {
      const first = this.waiting[0];
      const count = Math.min(first.length - this.offset, maxLength - taken.length);
      for (let index = 0; index < count; index++) taken.push(first[this.offset + index]);
      this.offset += count;
      if (this.offset === first.length) {
        this.waiting.shift();
        this.offset = 0;
      }
    }

    return Uint8Array.from(taken);
  }

  /** Closes the line; closing it again does nothing. */
  async close(): Promise<void> {
    this.isClosed = true;
  }
}

/** A servo chain replayed from ``reference``: the controls a StationRunner asks of a chain, and its line. */
export class ReplayedChain {
  /** Instruction packets taken from the host and status packets handed back, over all sessions. */
  instructions = 0;
  answers = 0;
  /** The sync writes of Goal_Position that passed with other goals than PEAR's: where, and both packets. */
  readonly otherGoals: string[] = [];

  private failure: ReplayError | null = null; // why the replay ended; every later call fails with it
  private session: StationSessionResult | null = null; // PEAR's record of the session being replayed
  private marked = -1; // the step of the session that was marked last: its world is the chain's state
  private pending: { label: string; step: StationStepRecord | null }[] = []; // marks not yet in effect
  private step: StationStepRecord | null = null; // the step whose segment the traffic is in
  private expected: Packet[] = []; // PEAR's packets of that step
  private position = 0; // how many of them the replay has passed
  private sent = 0; // the instruction packets among those
  private segments: TrafficSegment[] = [{ label: "", packets: [] }]; // what crossed this line since the reset

  constructor(
    private readonly reference: StationRunResult,
    private readonly options: ReplayOptions = {},
  ) {}

  /** Opens the chain's line. */
  async connect(): Promise<ReplayedLine> {
    this.check();

    return new ReplayedLine(this);
  }

  /** Fails if the replay has ended. */
  check(): void {
    if (this.failure !== null) throw this.failure;
  }

  // ---- the controls ----

  /** The chain's state as the reference recorded it: its clock, the world at the end of the marked step, and the
   * line's counters of the session. Before a step is marked the world is empty. */
  async state(): Promise<BridgeState> {
    this.check();
    const world = this.session?.steps[this.marked]?.world;
    const line = this.session?.line;

    return structuredClone({
      ...this.reference.bridge,
      time_s: world?.time_s ?? 0,
      joints_rad: world?.joints_rad ?? {},
      gripper_opening: world?.gripper_opening ?? 0,
      torque_enabled: {}, // a result does not record it
      ...(world?.fingertip_m !== undefined ? { fingertip_m: world.fingertip_m } : {}),
      ...(world?.grasp_m !== undefined ? { grasp_m: world.grasp_m } : {}),
      ...(world?.objects !== undefined ? { objects: world.objects } : {}),
      line: {
        client: null,
        instructions: line?.instructions ?? {},
        unanswered: line?.unanswered ?? {},
        corrupt_packets: line?.corrupt_packets ?? 0,
        dropped_bytes: line?.dropped_bytes ?? 0,
        errors: line?.errors ?? [],
      },
    });
  }

  /** Forgets the session and the traffic: the next mark names the session to replay. */
  async reset(): Promise<BridgeState> {
    this.check();
    this.session = null;
    this.marked = -1;
    this.pending = [];
    this.step = null;
    this.expected = [];
    this.position = 0;
    this.sent = 0;
    this.segments = [{ label: "", packets: [] }];

    return this.state();
  }

  /** Names the session to replay (`session: <name>`) or its next step (`<id> <op>`); the traffic's new segment
   * starts just before the next instruction packet that is not a sync write. */
  async mark(label: string): Promise<void> {
    this.check();
    if (label.startsWith(SESSION_MARK)) {
      const name = label.slice(SESSION_MARK.length);
      const session = this.reference.sessions.find((each) => each.name === name);
      if (session === undefined) this.fail(`PEAR's run holds no session '${name}'`);
      this.session = session;
      this.marked = 0; // the session's reset
      this.pending.push({ label, step: null });
      return;
    }

    const session = this.session;
    if (session === null) this.fail(`'${label}' is marked before a session`);
    const next = session.steps[this.marked + 1];
    if (next === undefined || labelOf(next) !== label) {
      this.fail(`${session.name}: '${label}' is marked where PEAR's run ${next === undefined ? "has ended" : `goes on with '${labelOf(next)}'`}`);
    }
    this.marked += 1;
    this.pending.push({ label, step: next });
  }

  /** Does nothing: what a fault caused is in the answers of PEAR's run. */
  async inject(_faults: Record<string, unknown>): Promise<void> {
    this.check();
  }

  /** Does nothing: where the object was is in the answers of PEAR's run. */
  async place(_object: string, _positionM: readonly number[]): Promise<void> {
    this.check();
  }

  /** What crossed the replayed line since the reset, by the marks: the host's own packets and the answers handed
   * back. Asked at a session's end: every mark takes effect, and PEAR's run may hold nothing more of the last step. */
  async traffic(): Promise<TrafficSegment[]> {
    this.check();
    this.takeMarks();
    this.requireStepDone();

    return this.segments.map((segment) => ({ label: segment.label, packets: [...segment.packets] }));
  }

  /** The arm's calibration, the reference's. */
  async calibration(): Promise<Record<string, MotorCalibration>> {
    return parseCalibration(JSON.stringify(this.reference.calibration));
  }

  async calibrationFile(): Promise<Record<string, Record<string, number>>> {
    return structuredClone(this.reference.calibration);
  }

  // ---- the line ----

  /** Takes an instruction packet of the host and returns the status packets PEAR's servos answered it with. */
  instruction(bytes: Uint8Array): Uint8Array[] {
    this.check();
    const hex = hexOf(bytes);
    if (bytes[4] !== SYNC_WRITE) this.takeMarks();

    const theirs = this.expected[this.position];
    const where = `${this.where()}: instruction packet #${this.sent}`;
    if (theirs === undefined) this.fail(`${where}: pear.js sent ${hex} where PEAR's run sent nothing more in this step`);
    if (theirs[0] !== "h") this.fail(`${where}: PEAR's record goes on with a status packet (${theirs[1]}) that follows no instruction`);
    if (theirs[1] !== hex) {
      if (this.options.goalsMayDiffer !== true || !differInGoalsAlone(theirs[1], hex)) {
        this.fail(`${where}: pear.js sent ${hex} where PEAR's run sent ${theirs[1]}`);
      }
      this.otherGoals.push(`${where}: ${theirs[1]} against ${hex}`);
    }

    const crossed = this.segments[this.segments.length - 1].packets;
    crossed.push(["h", hex]);
    this.position += 1;
    this.sent += 1;
    this.instructions += 1;
    const answers: Uint8Array[] = [];
    for (let next = this.expected[this.position]; next !== undefined && next[0] === "s"; next = this.expected[this.position]) {
      crossed.push(["s", next[1]]);
      answers.push(bytesOf(next[1]));
      this.position += 1;
      this.answers += 1;
    }

    return answers;
  }

  /** Puts every waiting mark in effect, each a new segment of the traffic and the next step's record. */
  private takeMarks(): void {
    for (const mark of this.pending) {
      this.requireStepDone();
      this.step = mark.step;
      this.expected = mark.step?.packets ?? [];
      this.position = 0;
      this.sent = 0;
      this.segments.push({ label: mark.label, packets: [] });
    }
    this.pending = [];
  }

  /** Fails if PEAR's run still holds packets of the step the traffic is in. */
  private requireStepDone(): void {
    const left = this.expected[this.position];
    if (left === undefined) return;
    const packets = this.expected.filter(([direction]) => direction === "h").length;
    this.fail(
      `${this.where()}: the step ended after ${this.sent} of the ${packets} instruction packets of PEAR's run, ` +
        `which went on with ${left[1]}`,
    );
  }

  private where(): string {
    return `${this.session?.name ?? "(no session)"} / ${this.step === null ? "(before the first step)" : labelOf(this.step)}`;
  }

  /** Ends the replay: this call and every later one of the chain and its lines fails with the same error. */
  private fail(message: string): never {
    this.failure ??= new ReplayError(message);
    throw this.failure;
  }
}
