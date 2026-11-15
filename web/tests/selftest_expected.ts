// Computes the expected selftest counts in Node: how many cases each fixture suite has and how many the library
// gets right (all of them, unless the library has a bug). The browser check compares these with what the page shows.
// Run with: node web/tests/run_node.mjs web/tests/selftest_expected.ts

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { protocol as feetechProtocol } from "../../src/feetech/index";
import { shownQuantity, turnText, DECIMALS, type ModelState } from "../../src/protocol/index";
import {
  ControlInterface,
  DurationDiscretization,
  InputParameter,
  Ruckig,
  RuckigError,
  replaceLibm,
  Synchronization,
  Trajectory,
  type Libm,
  type Profile,
} from "../../src/ruckig/index";
import { SO101Kinematics } from "../../src/so101/kinematics/index";

const FIXTURES = fileURLToPath(new URL("../../tests/fixtures/", import.meta.url));

function identical(a: number, b: number): boolean {
  return Object.is(a, b);
}

function revive(_key: string, value: unknown): unknown {
  if (value === "nan") return NaN;
  if (value === "inf") return Infinity;
  if (value === "-inf") return -Infinity;
  return value;
}

function parseLines<T>(text: string): T[] {
  const cases: T[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith('{"') && !line.startsWith('{"set"') && !line.startsWith('{"cases"')) {
      cases.push(JSON.parse(line.endsWith(",") ? line.slice(0, -1) : line, revive) as T);
    }
  }
  return cases;
}

interface SuiteExpected {
  name: string;
  passed: number;
  failed: number;
  total: number;
}

// Feetech packets
interface PacketInstruction {
  kind: string;
  args: { id: number; address?: number; length?: number; data?: number[]; ids?: number[]; values?: [number, number[]][] };
  result: number;
  packet: number[] | null;
}

class NoopPort implements feetechProtocol.PacketPort {
  isUsing = false;
  readonly written: number[][] = [];
  async clearPort(): Promise<void> {}
  async writePort(packet: Uint8Array): Promise<number> { this.written.push(Array.from(packet)); return packet.length; }
  async readPort(): Promise<number[]> { return []; }
  setPacketTimeout(): void {}
  isPacketTimeout(): boolean { return true; }
}

function buildPacket(kind: string, args: PacketInstruction["args"]): Uint8Array | null {
  const { id = -1, address = -1, length = -1, data = [], ids = [], values = [] } = args;
  switch (kind) {
    case "ping": return id >= feetechProtocol.BROADCAST_ID ? null : feetechProtocol.pingPacket(id);
    case "read": return id >= feetechProtocol.BROADCAST_ID ? null : feetechProtocol.readPacket(id, address, length);
    case "write": return feetechProtocol.writePacket(id, address, data);
    case "sync_read": {
      const parameters = feetechProtocol.syncReadParameters(ids);
      return parameters.length === 0 ? null : feetechProtocol.syncReadPacket(address, length, parameters);
    }
    case "sync_write": {
      const parameters = feetechProtocol.syncWriteParameters(length, values);
      return parameters.length === 0 ? null : feetechProtocol.syncWritePacket(address, length, parameters);
    }
    default: return null;
  }
}

async function countPackets(): Promise<SuiteExpected> {
  const data = JSON.parse(readFileSync(resolve(FIXTURES, "feetech/packets.json"), "utf8"));
  let passed = 0;
  let failed = 0;
  for (const { kind, args, result, packet } of data.instructions as PacketInstruction[]) {
    const built = buildPacket(kind, args);
    const port = new NoopPort();
    const sent = built === null ? feetechProtocol.COMM_NOT_AVAILABLE : await feetechProtocol.txPacket(port, built);
    if (packet === null) {
      if (sent === result && port.written.length === 0) passed++;
      else failed++;
    } else {
      const eq = sent === feetechProtocol.COMM_SUCCESS && port.written.length === 1 &&
        port.written[0].length === packet.length && port.written[0].every((b, i) => b === packet[i]);
      if (eq) passed++;
      else failed++;
    }
  }
  return { name: "feetech/packets", passed, failed, total: data.instructions.length };
}

// Kinematics poses
const KINEMATICS_MAX_CASES = 50;

interface KinematicsPose { joints: number[]; quantities: number[] }

function countKinematics(): SuiteExpected {
  const text = readFileSync(resolve(FIXTURES, "so101-kinematics/poses.json"), "utf8");
  const poses = parseLines<KinematicsPose>(text);
  const kinematics = new SO101Kinematics();
  let passed = 0;
  let failed = 0;
  const count = Math.min(poses.length, KINEMATICS_MAX_CASES);
  for (let i = 0; i < count; i++) {
    const pose = poses[i];
    const state = kinematics.quantities(pose.joints);
    const q = [
      shownQuantity(state.arm.x, DECIMALS.x),
      shownQuantity(state.arm.y, DECIMALS.y),
      shownQuantity(state.arm.z, DECIMALS.z),
      shownQuantity(state.arm.pitch, DECIMALS.pitch),
      shownQuantity(state.arm.roll, DECIMALS.roll),
      shownQuantity(state.gripper.width, DECIMALS.width),
    ];
    let ok = true;
    for (let j = 0; j < 6; j++) if (q[j] !== pose.quantities[j]) { ok = false; break; }
    if (ok) passed++;
    else failed++;
  }
  return { name: "kinematics/poses", passed, failed, total: count };
}

// Protocol turn text
interface TurnTextCase {
  state: { arm: { x: number; y: number; z: number; pitch: number; roll: number }; gripper: { width: number } };
  feedback: string | null;
  text: string;
}

function countTurnText(): SuiteExpected {
  const data = JSON.parse(readFileSync(resolve(FIXTURES, "protocol/turn_text.json"), "utf8"));
  let passed = 0;
  let failed = 0;
  for (const c of data.cases as TurnTextCase[]) {
    const state: ModelState = { arm: c.state.arm, gripper: c.state.gripper };
    const result = turnText(state, c.feedback);
    if (result === c.text) passed++;
    else failed++;
  }
  return { name: "protocol/turn_text", passed, failed, total: data.cases.length };
}

// Ruckig exact (with libm oracle)
type BrakeRow = [number, number[], number[], number[], number[], number[]];
type ProfileRow = [number[], number[], number[], number[], number[], number[], string, BrakeRow?, BrakeRow?];
interface RuckigCase {
  k: string; n: number; i: number[][]; o?: Record<string, unknown>;
  r?: number; e?: string; et?: string; d: number; m: number[]; id?: number[];
  p: ProfileRow[]; x?: number[][]; s?: [number, number[], number[], number[]][];
  f?: [number, number, number, number | null][];
}

const CI: Record<string, ControlInterface> = { Position: ControlInterface.Position, Velocity: ControlInterface.Velocity };
const SY: Record<string, Synchronization> = {
  Time: Synchronization.Time, TimeIfNecessary: Synchronization.TimeIfNecessary,
  Phase: Synchronization.Phase, No: Synchronization.No,
};

function buildInput(n: number, vectors: number[][], o: Record<string, unknown> = {}): InputParameter {
  const input = new InputParameter(n);
  [input.currentPosition, input.currentVelocity, input.currentAcceleration,
   input.targetPosition, input.targetVelocity, input.targetAcceleration,
   input.maxVelocity, input.maxAcceleration, input.maxJerk] =
    vectors as [number[], number[], number[], number[], number[], number[], number[], number[], number[]];
  if (o.vmin) input.minVelocity = o.vmin as number[];
  if (o.amin) input.minAcceleration = o.amin as number[];
  if (o.ci) input.controlInterface = CI[o.ci as string];
  if (o.sync) input.synchronization = SY[o.sync as string];
  if (o.disc) input.durationDiscretization = DurationDiscretization.Discrete;
  if (o.mind !== undefined) input.minimumDuration = o.mind as number;
  if (o.enabled) input.enabled = o.enabled as boolean[];
  if (o.pci) input.perDofControlInterface = (o.pci as string[]).map((n) => CI[n]);
  if (o.psync) input.perDofSynchronization = (o.psync as string[]).map((n) => SY[n]);
  if (o.ip) input.intermediatePositions = o.ip as number[][];
  return input;
}

function unnamedResult(answer: { e?: string; et?: string }): number | undefined {
  const match = answer.et === "ValueError" ? /^(-\d+) is not a valid Result\.$/.exec(answer.e ?? "") : null;
  return match === null ? undefined : Number(match[1]);
}

function countRuckig(setName: string, restore: () => void): SuiteExpected {
  const text = readFileSync(resolve(FIXTURES, `ruckig/${setName}.json`), "utf8");
  const cases = parseLines<RuckigCase>(text);
  let identicalCases = 0;

  for (const item of cases) {
    const trajectory = new Trajectory(item.n);
    let result: number | undefined;
    let message: string | undefined;
    try {
      const gen = (item.o?.dt !== undefined) ? new Ruckig(item.n, item.o.dt as number) : new Ruckig(item.n);
      result = gen.calculate(buildInput(item.n, item.i, item.o ?? {}), trajectory);
    } catch (error) {
      if (!(error instanceof RuckigError)) throw error;
      message = error.message;
    }

    const expectedResult = item.e === undefined ? item.r : unnamedResult(item);
    const isSameOutcome = expectedResult !== undefined
      ? message === undefined && result === expectedResult
      : message === item.e;
    if (!isSameOutcome) continue;

    const profiles = trajectory.profiles[0];
    if (item.p.some((row, dof) => profiles[dof].toString() !== row[6])) continue;

    let caseDifferent = 0;
    const check = (a: number, b: number): void => { if (!identical(a, b)) caseDifferent++; };
    const checkAll = (a: readonly number[], b: readonly number[]): void => {
      if (a.length !== b.length) { caseDifferent++; return; }
      a.forEach((v, i) => check(v, b[i]));
    };

    check(item.d, trajectory.duration);
    checkAll(item.m, trajectory.independentMinDurations);
    if (item.id !== undefined || item.e === undefined) checkAll(item.id ?? [item.d], trajectory.intermediateDurations);

    item.p.forEach((row, dof) => {
      const profile = profiles[dof];
      checkAll(row[0], profile.t);
      for (let phase = 0; phase < 7; phase++) check(row[1][phase] * row[0][phase], profile.j[phase] * profile.t[phase]);
      checkAll(row[2], profile.a);
      checkAll(row[3], profile.v);
      checkAll(row[4], profile.p);
      check(row[5][0], profile.pf);
      check(row[5][1], profile.vf);
      check(row[5][2], profile.af);
      const compareBrake = (expected: BrakeRow | undefined, actual: Profile["brake"]): void => {
        const r: BrakeRow = expected ?? [0, [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]];
        check(r[0], actual.duration); checkAll(r[1], actual.t);
        for (let p = 0; p < 2; p++) check(r[2][p] * r[1][p], actual.j[p] * actual.t[p]);
        checkAll(r[3], actual.a); checkAll(r[4], actual.v); checkAll(r[5], actual.p);
      };
      compareBrake(row[7], profile.brake);
      compareBrake(row[8], profile.accel);
    });

    if (item.x !== undefined) {
      const extrema = trajectory.positionExtrema;
      item.x.forEach((row, dof) => {
        check(row[0], extrema[dof].min); check(row[1], extrema[dof].max);
        check(row[2], extrema[dof].tMin); check(row[3], extrema[dof].tMax);
      });
    }

    for (const [time, position, velocity, acceleration] of item.s ?? []) {
      const [newP, newV, newA] = trajectory.atTime(time);
      for (let dof = 0; dof < item.n; dof++) {
        check(position[dof], newP[dof]); check(velocity[dof], newV[dof]); check(acceleration[dof], newA[dof]);
      }
    }

    for (const [dof, position, timeAfter, expected] of item.f ?? []) {
      const actual = trajectory.getFirstTimeAtPosition(dof, position, timeAfter);
      if (expected === null && actual === undefined) { /* ok */ }
      else if (expected !== null && actual !== undefined) check(expected, actual);
      else caseDifferent++;
    }

    if (caseDifferent === 0) identicalCases++;
  }

  return { name: `ruckig/${setName}`, passed: identicalCases, failed: cases.length - identicalCases, total: cases.length };
}

function installNodeOracle(): { restore: () => void; hits: number; missing: number } {
  const tables: Record<keyof Libm, Map<bigint, number>> = {
    cbrt: new Map(), sin: new Map(), cos: new Map(), atan: new Map(), acos: new Map(),
  };
  const stored = JSON.parse(readFileSync(resolve(FIXTURES, "ruckig/libm.json"), "utf8")) as Record<string, string>;
  const words = (name: string): DataView => {
    const bytes = Buffer.from(stored[name], "base64");
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  };
  for (const name of ["cbrt", "atan", "acos"] as const) {
    const view = words(name);
    for (let offset = 0; offset < view.byteLength; offset += 16)
      tables[name].set(view.getBigUint64(offset), view.getFloat64(offset + 8));
  }
  const view = words("sincos");
  for (let offset = 0; offset < view.byteLength; offset += 24) {
    tables.sin.set(view.getBigUint64(offset), view.getFloat64(offset + 8));
    tables.cos.set(view.getBigUint64(offset), view.getFloat64(offset + 16));
  }

  const bits = new DataView(new ArrayBuffer(8));
  const bitsOf = (value: number): bigint => { bits.setFloat64(0, value); return bits.getBigUint64(0); };
  const state = { hits: 0, missing: 0 };

  const lookup = (name: keyof Libm) => (value: number): number => {
    const argument = bitsOf(value);
    const answer = tables[name].get(argument);
    if (answer !== undefined) { state.hits++; return answer; }
    state.missing++;
    return Math[name === "cbrt" ? "cbrt" : name === "sin" ? "sin" : name === "cos" ? "cos" : name === "atan" ? "atan" : "acos"](value);
  };

  const restore = replaceLibm({
    cbrt: lookup("cbrt"), sin: lookup("sin"), cos: lookup("cos"), atan: lookup("atan"), acos: lookup("acos"),
  });

  return { restore, get hits() { return state.hits; }, get missing() { return state.missing; } };
}

export async function main(): Promise<SuiteExpected[]> {
  const suites: SuiteExpected[] = [];

  suites.push(await countPackets());
  suites.push(countKinematics());
  suites.push(countTurnText());

  const oracle = installNodeOracle();
  try {
    for (const setName of ["a_pear"]) {
      suites.push(countRuckig(setName, oracle.restore));
    }
  } finally {
    oracle.restore();
  }
  suites.push({
    name: "ruckig/libm",
    passed: oracle.missing === 0 ? 1 : 0,
    failed: oracle.missing > 0 ? 1 : 0,
    total: 1,
  });

  return suites;
}
