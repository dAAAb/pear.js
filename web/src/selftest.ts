// Replays a sample of the committed test fixtures in the browser and shows the counts: how many cases each suite
// holds and how many the library gets right. The same fixtures are verified in Node by vitest; this page runs the
// same code path in a browser engine so that a difference between the two shows.
//
// The page fetches fixture JSONs from the server that serves it (they are not bundled). A headless Chromium check
// runs a Node script to compute the expected counts from the same fixtures, then compares them with what the page
// shows.

import { protocol as feetechProtocol, type Transport } from "../../src/feetech/index";
import {
  shownQuantity,
  turnText,
  DECIMALS,
  type ModelState,
} from "../../src/protocol/index";
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

// ---------------------------------------------------------------------------
// Fixture types (match tests/fixtures/ JSON)
// ---------------------------------------------------------------------------

interface PacketInstructionArgs {
  id: number;
  address?: number;
  length?: number;
  data?: number[];
  ids?: number[];
  values?: [number, number[]][];
}

interface PacketInstruction {
  kind: string;
  args: PacketInstructionArgs;
  result: number;
  packet: number[] | null;
}

interface KinematicsPose {
  joints: number[];
  pose: number[];
  quantities: number[];
}

interface TurnTextCase {
  state: { arm: { x: number; y: number; z: number; pitch: number; roll: number }; gripper: { width: number } };
  feedback: string | null;
  text: string;
}

type SynchronizationName = "Time" | "TimeIfNecessary" | "Phase" | "No";

interface RuckigOptions {
  vmin?: number[];
  amin?: number[];
  ci?: "Position" | "Velocity";
  sync?: SynchronizationName;
  disc?: boolean;
  dt?: number;
  mind?: number;
  enabled?: boolean[];
  pci?: ("Position" | "Velocity")[];
  psync?: SynchronizationName[];
  ip?: number[][];
}

type BrakeRow = [number, number[], number[], number[], number[], number[]];
type ProfileRow = [number[], number[], number[], number[], number[], number[], string, BrakeRow?, BrakeRow?];

interface RuckigCase {
  k: string;
  n: number;
  i: number[][];
  o?: RuckigOptions;
  r?: number;
  e?: string;
  et?: string;
  d: number;
  m: number[];
  id?: number[];
  p: ProfileRow[];
  x?: number[][];
  s?: [number, number[], number[], number[]][];
  f?: [number, number, number, number | null][];
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function identical(a: number, b: number): boolean {
  return Object.is(a, b);
}

function reviveNumber(_key: string, value: unknown): unknown {
  if (value === "nan") return NaN;
  if (value === "inf") return Infinity;
  if (value === "-inf") return -Infinity;
  return value;
}

function parseFixtureLines<T>(text: string): T[] {
  const cases: T[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith('{"') && !line.startsWith('{"set"') && !line.startsWith('{"cases"')) {
      cases.push(JSON.parse(line.endsWith(",") ? line.slice(0, -1) : line, reviveNumber) as T);
    }
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Suite: Feetech packets
// ---------------------------------------------------------------------------

class NoopPort implements feetechProtocol.PacketPort {
  isUsing = false;
  readonly written: number[][] = [];

  async clearPort(): Promise<void> {}
  async writePort(packet: Uint8Array): Promise<number> {
    this.written.push(Array.from(packet));
    return packet.length;
  }
  async readPort(_length: number): Promise<number[]> { return []; }
  setPacketTimeout(): void {}
  isPacketTimeout(): boolean { return true; }
}

function buildPacket(kind: string, args: PacketInstructionArgs): Uint8Array | null {
  const { id = -1, address = -1, length = -1, data = [], ids = [], values = [] } = args;
  switch (kind) {
    case "ping":
      return id >= feetechProtocol.BROADCAST_ID ? null : feetechProtocol.pingPacket(id);
    case "read":
      return id >= feetechProtocol.BROADCAST_ID ? null : feetechProtocol.readPacket(id, address, length);
    case "write":
      return feetechProtocol.writePacket(id, address, data);
    case "sync_read": {
      const parameters = feetechProtocol.syncReadParameters(ids);
      return parameters.length === 0 ? null : feetechProtocol.syncReadPacket(address, length, parameters);
    }
    case "sync_write": {
      const parameters = feetechProtocol.syncWriteParameters(length, values);
      return parameters.length === 0 ? null : feetechProtocol.syncWritePacket(address, length, parameters);
    }
    default:
      return null;
  }
}

async function runPackets(instructions: PacketInstruction[]): Promise<{ passed: number; failed: number; total: number }> {
  let passed = 0;
  let failed = 0;
  for (const { kind, args, result, packet } of instructions) {
    const built = buildPacket(kind, args);
    const port = new NoopPort();
    const sent = built === null ? feetechProtocol.COMM_NOT_AVAILABLE : await feetechProtocol.txPacket(port, built);

    if (packet === null) {
      if (sent === result && port.written.length === 0) passed++;
      else failed++;
    } else {
      if (sent === feetechProtocol.COMM_SUCCESS && port.written.length === 1 && arraysEqual(port.written[0], packet)) passed++;
      else failed++;
    }
  }
  return { passed, failed, total: instructions.length };
}

function arraysEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Suite: Kinematics poses
// ---------------------------------------------------------------------------

function runKinematics(poses: KinematicsPose[], maxCases: number): { passed: number; failed: number; total: number } {
  const kinematics = new SO101Kinematics();
  let passed = 0;
  let failed = 0;
  const count = Math.min(poses.length, maxCases);
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
    for (let j = 0; j < 6; j++) {
      if (q[j] !== pose.quantities[j]) { ok = false; break; }
    }
    if (ok) passed++;
    else failed++;
  }
  return { passed, failed, total: count };
}

// ---------------------------------------------------------------------------
// Suite: Protocol turn text
// ---------------------------------------------------------------------------

function runTurnText(cases: TurnTextCase[]): { passed: number; failed: number; total: number } {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    const state: ModelState = { arm: c.state.arm, gripper: c.state.gripper };
    const result = turnText(state, c.feedback);
    if (result === c.text) passed++;
    else failed++;
  }
  return { passed, failed, total: cases.length };
}

// ---------------------------------------------------------------------------
// Suite: Ruckig exact (with libm oracle)
// ---------------------------------------------------------------------------

interface LibmData {
  cbrt: string;
  atan: string;
  acos: string;
  sincos: string;
}

function installBrowserOracle(data: LibmData): { restore: () => void; hits: number; missing: number } {
  const tables: Record<keyof Libm, Map<bigint, number>> = {
    cbrt: new Map(), sin: new Map(), cos: new Map(), atan: new Map(), acos: new Map(),
  };

  const decode = (b64: string): DataView => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new DataView(bytes.buffer);
  };

  for (const name of ["cbrt", "atan", "acos"] as const) {
    const view = decode(data[name]);
    for (let offset = 0; offset < view.byteLength; offset += 16) {
      tables[name].set(view.getBigUint64(offset), view.getFloat64(offset + 8));
    }
  }
  const view = decode(data.sincos);
  for (let offset = 0; offset < view.byteLength; offset += 24) {
    tables.sin.set(view.getBigUint64(offset), view.getFloat64(offset + 8));
    tables.cos.set(view.getBigUint64(offset), view.getFloat64(offset + 16));
  }

  const state = { hits: 0, missing: 0 };
  const bits = new DataView(new ArrayBuffer(8));
  const bitsOf = (value: number): bigint => { bits.setFloat64(0, value); return bits.getBigUint64(0); };

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

const INTERFACES: Record<string, ControlInterface> = { Position: ControlInterface.Position, Velocity: ControlInterface.Velocity };
const SYNCHRONIZATIONS: Record<string, Synchronization> = {
  Time: Synchronization.Time, TimeIfNecessary: Synchronization.TimeIfNecessary,
  Phase: Synchronization.Phase, No: Synchronization.No,
};

function buildInput(dofs: number, vectors: number[][], options: RuckigOptions = {}): InputParameter {
  const input = new InputParameter(dofs);
  [
    input.currentPosition, input.currentVelocity, input.currentAcceleration,
    input.targetPosition, input.targetVelocity, input.targetAcceleration,
    input.maxVelocity, input.maxAcceleration, input.maxJerk,
  ] = vectors as [number[], number[], number[], number[], number[], number[], number[], number[], number[]];
  if (options.vmin !== undefined) input.minVelocity = options.vmin;
  if (options.amin !== undefined) input.minAcceleration = options.amin;
  if (options.ci !== undefined) input.controlInterface = INTERFACES[options.ci];
  if (options.sync !== undefined) input.synchronization = SYNCHRONIZATIONS[options.sync];
  if (options.disc) input.durationDiscretization = DurationDiscretization.Discrete;
  if (options.mind !== undefined) input.minimumDuration = options.mind;
  if (options.enabled !== undefined) input.enabled = options.enabled;
  if (options.pci !== undefined) input.perDofControlInterface = options.pci.map((n) => INTERFACES[n]);
  if (options.psync !== undefined) input.perDofSynchronization = options.psync.map((n) => SYNCHRONIZATIONS[n]);
  if (options.ip !== undefined) input.intermediatePositions = options.ip;
  return input;
}

function unnamedResult(answer: { e?: string; et?: string }): number | undefined {
  const match = answer.et === "ValueError" ? /^(-\d+) is not a valid Result\.$/.exec(answer.e ?? "") : null;
  return match === null ? undefined : Number(match[1]);
}

function runRuckig(cases: RuckigCase[]): { identicalCases: number; comparedCases: number; differentNumbers: number; total: number; outcomeDiffs: number; profileDiffs: number } {
  let identicalCases = 0;
  let comparedCases = 0;
  let differentNumbers = 0;
  let outcomeDiffs = 0;
  let profileDiffs = 0;

  for (const item of cases) {
    const trajectory = new Trajectory(item.n);
    let result: number | undefined;
    let message: string | undefined;
    try {
      const gen = item.o?.dt !== undefined ? new Ruckig(item.n, item.o.dt) : new Ruckig(item.n);
      result = gen.calculate(buildInput(item.n, item.i, item.o), trajectory);
    } catch (error) {
      if (!(error instanceof RuckigError)) throw error;
      message = error.message;
    }

    const expectedResult = item.e === undefined ? item.r : unnamedResult(item);
    const isSameOutcome = expectedResult !== undefined
      ? message === undefined && result === expectedResult
      : message === item.e;

    if (!isSameOutcome) { outcomeDiffs++; continue; }

    const profiles = trajectory.profiles[0];
    const otherKinds = item.p.flatMap((row, dof) =>
      profiles[dof].toString() === row[6] ? [] : [true],
    );
    if (otherKinds.length > 0) { profileDiffs++; continue; }

    comparedCases++;
    let caseDifferent = 0;

    const check = (expected: number, actual: number): void => {
      if (!identical(expected, actual)) caseDifferent++;
    };
    const checkAll = (expected: readonly number[], actual: readonly number[]): void => {
      if (expected.length !== actual.length) { caseDifferent++; return; }
      expected.forEach((v, i) => check(v, actual[i]));
    };

    check(item.d, trajectory.duration);
    checkAll(item.m, trajectory.independentMinDurations);
    if (item.id !== undefined || item.e === undefined) {
      checkAll(item.id ?? [item.d], trajectory.intermediateDurations);
    }

    item.p.forEach((row, dof) => {
      const profile = profiles[dof];
      checkAll(row[0], profile.t);
      for (let phase = 0; phase < 7; phase++) {
        check(row[1][phase] * row[0][phase], profile.j[phase] * profile.t[phase]);
      }
      checkAll(row[2], profile.a);
      checkAll(row[3], profile.v);
      checkAll(row[4], profile.p);
      check(row[5][0], profile.pf);
      check(row[5][1], profile.vf);
      check(row[5][2], profile.af);

      const compareBrake = (expected: BrakeRow | undefined, actual: Profile["brake"]): void => {
        const r: BrakeRow = expected ?? [0, [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]];
        check(r[0], actual.duration);
        checkAll(r[1], actual.t);
        for (let p = 0; p < 2; p++) check(r[2][p] * r[1][p], actual.j[p] * actual.t[p]);
        checkAll(r[3], actual.a);
        checkAll(r[4], actual.v);
        checkAll(r[5], actual.p);
      };
      compareBrake(row[7], profile.brake);
      compareBrake(row[8], profile.accel);
    });

    if (item.x !== undefined) {
      const extrema = trajectory.positionExtrema;
      item.x.forEach((row, dof) => {
        check(row[0], extrema[dof].min);
        check(row[1], extrema[dof].max);
        check(row[2], extrema[dof].tMin);
        check(row[3], extrema[dof].tMax);
      });
    }

    for (const [time, position, velocity, acceleration] of item.s ?? []) {
      const [newP, newV, newA] = trajectory.atTime(time);
      for (let dof = 0; dof < item.n; dof++) {
        check(position[dof], newP[dof]);
        check(velocity[dof], newV[dof]);
        check(acceleration[dof], newA[dof]);
      }
    }

    for (const [dof, position, timeAfter, expected] of item.f ?? []) {
      const actual = trajectory.getFirstTimeAtPosition(dof, position, timeAfter);
      if (expected === null && actual === undefined) { /* ok */ }
      else if (expected !== null && actual !== undefined) check(expected, actual);
      else caseDifferent++;
    }

    if (caseDifferent === 0) identicalCases++;
    differentNumbers += caseDifferent;
  }

  return { identicalCases, comparedCases, differentNumbers, total: cases.length, outcomeDiffs, profileDiffs };
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchJSON<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Failed to fetch ${path}: ${response.status}`);
  return response.json() as Promise<T>;
}

async function fetchText(path: string): Promise<string> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Failed to fetch ${path}: ${response.status}`);
  return response.text();
}

// ---------------------------------------------------------------------------
// Result type exposed to the check
// ---------------------------------------------------------------------------

export interface SuiteResult {
  name: string;
  passed: number;
  failed: number;
  total: number;
  detail?: string;
}

export interface SelftestResult {
  suites: SuiteResult[];
  totalPassed: number;
  totalFailed: number;
  totalCases: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Main: run all suites, update DOM, expose result
// ---------------------------------------------------------------------------

const KINEMATICS_MAX_CASES = 50;
const RUCKIG_SETS = ["a_pear"];

export async function runSelftest(fixtureBase: string): Promise<SelftestResult> {
  const suites: SuiteResult[] = [];
  const errors: string[] = [];

  const status = document.getElementById("selftest-status");
  const show = (text: string): void => { if (status) status.textContent = text; };

  // 1. Feetech packets
  show("Running: feetech packets...");
  try {
    const data = await fetchJSON<{ instructions: PacketInstruction[] }>(`${fixtureBase}/feetech/packets.json`);
    const result = await runPackets(data.instructions);
    suites.push({ name: "feetech/packets", ...result });
  } catch (e) {
    errors.push(`feetech/packets: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2. Kinematics poses
  show("Running: kinematics poses...");
  try {
    const text = await fetchText(`${fixtureBase}/so101-kinematics/poses.json`);
    const poses = parseFixtureLines<KinematicsPose>(text);
    const result = runKinematics(poses, KINEMATICS_MAX_CASES);
    suites.push({ name: "kinematics/poses", ...result });
  } catch (e) {
    errors.push(`kinematics/poses: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 3. Protocol turn text
  show("Running: protocol turn text...");
  try {
    const data = await fetchJSON<{ cases: TurnTextCase[] }>(`${fixtureBase}/protocol/turn_text.json`);
    const result = runTurnText(data.cases);
    suites.push({ name: "protocol/turn_text", ...result });
  } catch (e) {
    errors.push(`protocol/turn_text: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 4. Ruckig exact (with libm oracle)
  show("Running: ruckig (loading libm oracle)...");
  try {
    const libmData = await fetchJSON<LibmData>(`${fixtureBase}/ruckig/libm.json`);
    const oracle = installBrowserOracle(libmData);
    try {
      for (const setName of RUCKIG_SETS) {
        show(`Running: ruckig/${setName}...`);
        const text = await fetchText(`${fixtureBase}/ruckig/${setName}.json`);
        const cases = parseFixtureLines<RuckigCase>(text);
        const result = runRuckig(cases);
        suites.push({
          name: `ruckig/${setName}`,
          passed: result.identicalCases,
          failed: result.total - result.identicalCases,
          total: result.total,
          detail: `identical=${result.identicalCases} compared=${result.comparedCases} differentNumbers=${result.differentNumbers} outcomeDiffs=${result.outcomeDiffs} profileDiffs=${result.profileDiffs}`,
        });
      }
    } finally {
      oracle.restore();
    }
    suites.push({
      name: "ruckig/libm",
      passed: oracle.missing === 0 ? 1 : 0,
      failed: oracle.missing > 0 ? 1 : 0,
      total: 1,
      detail: `hits=${oracle.hits} missing=${oracle.missing}`,
    });
  } catch (e) {
    errors.push(`ruckig: ${e instanceof Error ? e.message : String(e)}`);
  }

  const totalPassed = suites.reduce((s, r) => s + r.passed, 0);
  const totalFailed = suites.reduce((s, r) => s + r.failed, 0);
  const totalCases = suites.reduce((s, r) => s + r.total, 0);
  const result: SelftestResult = { suites, totalPassed, totalFailed, totalCases, errors };

  show(totalFailed === 0 && errors.length === 0
    ? `All passed: ${totalPassed} of ${totalCases}`
    : `${totalFailed} of ${totalCases} failed, ${errors.length} errors`);
  renderResults(result);

  return result;
}

function renderResults(result: SelftestResult): void {
  const container = document.getElementById("selftest-results");
  if (!container) return;
  container.innerHTML = "";

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const text of ["Suite", "Passed", "Failed", "Total", "Detail"]) {
    const th = document.createElement("th");
    th.textContent = text;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const suite of result.suites) {
    const row = document.createElement("tr");
    row.className = suite.failed > 0 ? "fail" : "pass";
    row.dataset.suite = suite.name;
    for (const text of [suite.name, String(suite.passed), String(suite.failed), String(suite.total), suite.detail ?? ""]) {
      const td = document.createElement("td");
      td.textContent = text;
      row.appendChild(td);
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  container.appendChild(table);

  for (const error of result.errors) {
    const p = document.createElement("p");
    p.className = "error";
    p.textContent = error;
    container.appendChild(p);
  }
}

// Auto-run on load; ?fixtures=URL overrides the base path for fixture JSONs.
function fixtureBaseFromUrl(): string {
  const params = new URLSearchParams(location.search);
  return params.get("fixtures") ?? "./fixtures";
}

const promise = runSelftest(fixtureBaseFromUrl());
(window as unknown as Record<string, unknown>).selftestResult = promise;
