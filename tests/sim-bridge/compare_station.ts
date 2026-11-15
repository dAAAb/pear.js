// Not in PEAR: compares two runs of the scripted station sessions (two StationRunResults), the reference's (PEAR's
// Python robot) and a candidate's, both run stepped on the same simulated servo chain. Nothing is tolerated: every
// value of every step is compared, every number in every bit, and every difference is counted under the part of a
// step it lies in and named by its path. What belongs to a run alone is put aside by its key and by nothing else:
// `run`, `wall_s`, `wall_ms` (and `side`, which says who ran).

import type { Json, StationRunResult, StationStepRecord } from "./station_result";

/** The parts of a step under which its differences are counted. */
export const STATION_PARTS = [
  "outcome", // one side returned, the other raised
  "raised", // the class, the message or the details of what a step raised
  "result", // an action's result as PEAR records it
  "feedback", // the report the next turn tells the model
  "text", // the text of a turn
  "state", // what the model reads of the measured joints
  "returned", // anything else a step returned: a snapshot, an observation, a Home report
  "status", // the robot's status with its control snapshot at the step's end
  "requested", // the joint vector the arm heads for
  "ticks", // the steps of the control loop
  "sleeps", // the waits of the caller
  "phases", // the loop's state after each of its steps
  "clock_s", // the station's clock at the step's start and end
  "world", // where the simulated arm truly is
  "log", // the warnings and errors logged
  "hostPackets", // instruction packets, host to servo
  "servoPackets", // status packets, servo to host
  "other", // any other key of a step
] as const;
export type StationPart = (typeof STATION_PARTS)[number];

/** The keys that belong to one run alone. */
const RUN_ONLY: ReadonlySet<string> = new Set(["run", "wall_s", "wall_ms"]);
const LISTED = 8; // differences listed of each part; all are counted

/** One difference: where it is and the two values (as text, shortened). */
export interface Difference {
  path: string;
  reference: string;
  candidate: string;
}

export interface PartComparison {
  /** Steps that differ in this part. */
  steps: number;
  /** Differences in this part, over all steps. */
  differences: number;
  /** The first of them, each with its session and step. */
  listed: string[];
}

export interface PacketCount {
  reference: number;
  candidate: number;
  /** Positions at which the two sides' packets of a step differ, a missing packet included. */
  differing: number;
}

export interface StationComparison {
  sessions: number;
  steps: { compared: number; differing: number };
  /** Differences outside the steps: the session file, the station's settings, the chain's clock, the sessions'
   * names and steps, the line's counters. */
  top: string[];
  parts: Record<StationPart, PartComparison>;
  hostPackets: PacketCount;
  servoPackets: PacketCount;
  /** Every difference counted, of the steps and outside them. */
  total: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function short(value: unknown): string {
  const text = value === undefined ? "(absent)" : JSON.stringify(value);

  return text.length <= 90 ? text : `${text.slice(0, 87)}...`;
}

/** Appends to ``found`` every place where two JSON values differ. Numbers are compared bit for bit (Object.is: 0
 * is not -0); a key or an item one side lacks is a difference. */
export function differences(reference: unknown, candidate: unknown, path: string, found: Difference[]): void {
  if (Array.isArray(reference) && Array.isArray(candidate)) {
    if (reference.length !== candidate.length) {
      found.push({ path: `${path} (length)`, reference: String(reference.length), candidate: String(candidate.length) });
    }
    for (let index = 0; index < Math.min(reference.length, candidate.length); index++) {
      differences(reference[index], candidate[index], `${path}[${index}]`, found);
    }
  } else if (isObject(reference) && isObject(candidate)) {
    for (const key of [...new Set([...Object.keys(reference), ...Object.keys(candidate)])].sort()) {
      if (RUN_ONLY.has(key)) continue;
      if (!(key in reference) || !(key in candidate)) {
        found.push({ path: `${path}.${key}`, reference: short(reference[key]), candidate: short(candidate[key]) });
      } else {
        differences(reference[key], candidate[key], `${path}.${key}`, found);
      }
    }
  } else if (!Object.is(reference, candidate)) {
    found.push({ path, reference: short(reference), candidate: short(candidate) });
  }
}

/** Returns the part of a step that the path of a difference lies in. */
function partOf(path: string): StationPart {
  const prefixes: [string, StationPart][] = [
    [".returned.result", "result"],
    [".returned.feedback", "feedback"],
    [".returned.text", "text"],
    [".returned.state", "state"],
    [".returned", "returned"],
    [".raised", "raised"],
    [".status", "status"],
    [".requested", "requested"],
    [".ticks", "ticks"],
    [".sleeps", "sleeps"],
    [".phases", "phases"],
    [".clock_s", "clock_s"],
    [".world", "world"],
    [".log", "log"],
  ];
  for (const [prefix, part] of prefixes) {
    if (path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`) || path.startsWith(`${prefix} `)) {
      return part;
    }
  }

  return "other";
}

function outcomeOf(step: StationStepRecord): string {
  return "raised" in step ? "raised" : "returned" in step ? "returned" : "nothing";
}

function packetsOf(step: StationStepRecord, direction: "h" | "s"): string[] {
  return (step.packets ?? []).filter(([each]) => each === direction).map(([, hex]) => hex);
}

/** Compares ``candidate`` with ``reference``, session by session and step by step. */
export function compareStationResults(reference: StationRunResult, candidate: StationRunResult): StationComparison {
  const parts = Object.fromEntries(
    STATION_PARTS.map((part) => [part, { steps: 0, differences: 0, listed: [] }]),
  ) as unknown as Record<StationPart, PartComparison>;
  const comparison: StationComparison = {
    sessions: reference.sessions.length,
    steps: { compared: 0, differing: 0 },
    top: [],
    parts,
    hostPackets: { reference: 0, candidate: 0, differing: 0 },
    servoPackets: { reference: 0, candidate: 0, differing: 0 },
    total: 0,
  };
  const top = (line: string): void => {
    comparison.top.push(line);
    comparison.total += 1;
  };

  // what the two runs must share before a step is looked at
  const shared: Difference[] = [];
  const ours = reference as unknown as Record<string, unknown>;
  const theirs = candidate as unknown as Record<string, unknown>;
  for (const key of [...new Set([...Object.keys(ours), ...Object.keys(theirs)])].sort()) {
    if (RUN_ONLY.has(key) || key === "sessions" || key === "side") continue;
    differences(ours[key], theirs[key], key, shared);
  }
  for (const each of shared) top(`${each.path}: ${each.reference} against ${each.candidate}`);
  if (reference.sessions.length !== candidate.sessions.length) {
    top(`${reference.sessions.length} sessions against ${candidate.sessions.length}`);
  }

  reference.sessions.forEach((session, sessionIndex) => {
    const other = candidate.sessions[sessionIndex];
    if (other === undefined) return;
    if (other.name !== session.name) {
      top(`session ${sessionIndex}: '${session.name}' against '${other.name}'`);
      return;
    }
    const counters: Difference[] = [];
    differences(session.line, other.line, "line", counters);
    differences(session.note, other.note, "note", counters);
    for (const each of counters) top(`${session.name}: ${each.path}: ${each.reference} against ${each.candidate}`);
    if (session.steps.length !== other.steps.length) {
      top(`${session.name}: ${session.steps.length} steps against ${other.steps.length}`);
    }

    session.steps.forEach((step, stepIndex) => {
      const found = other.steps[stepIndex];
      if (found === undefined) return;
      const where = `${session.name} / ${step.id} ${step.op}`;
      comparison.steps.compared += 1;
      const inParts = new Map<StationPart, number>();
      const note = (part: StationPart, line: string): void => {
        inParts.set(part, (inParts.get(part) ?? 0) + 1);
        if (parts[part].listed.length < LISTED) parts[part].listed.push(`${where}: ${line}`);
      };

      if (outcomeOf(step) !== outcomeOf(found)) note("outcome", `${outcomeOf(step)} against ${outcomeOf(found)}`);

      const stepDifferences: Difference[] = [];
      const first = step as unknown as Record<string, unknown>;
      const second = found as unknown as Record<string, unknown>;
      for (const key of [...new Set([...Object.keys(first), ...Object.keys(second)])].sort()) {
        if (RUN_ONLY.has(key) || key === "packets") continue;
        if (!(key in first) || !(key in second)) {
          stepDifferences.push({ path: `.${key}`, reference: short(first[key]), candidate: short(second[key]) });
        } else {
          differences(first[key], second[key], `.${key}`, stepDifferences);
        }
      }
      for (const each of stepDifferences) {
        note(partOf(each.path), `${each.path.slice(1)}: ${each.reference} against ${each.candidate}`);
      }

      for (const [direction, part] of [["h", "hostPackets"], ["s", "servoPackets"]] as const) {
        const expected = packetsOf(step, direction);
        const got = packetsOf(found, direction);
        comparison[part].reference += expected.length;
        comparison[part].candidate += got.length;
        for (let index = 0; index < Math.max(expected.length, got.length); index++) {
          if (expected[index] === got[index]) continue;
          comparison[part].differing += 1;
          note(part, `#${index}: ${expected[index] ?? "(none)"} against ${got[index] ?? "(none)"}`);
        }
      }

      if (inParts.size > 0) comparison.steps.differing += 1;
      for (const [part, count] of inParts) {
        parts[part].steps += 1;
        parts[part].differences += count;
        comparison.total += count;
      }
    });
  });

  return comparison;
}

/** Returns the comparison as lines of text, every number of it. */
export function describeStationComparison(comparison: StationComparison): string[] {
  const { hostPackets, servoPackets, steps } = comparison;
  const lines = [
    `sessions ${comparison.sessions}, steps compared ${steps.compared}, steps with a difference ${steps.differing}, ` +
      `differences ${comparison.total}`,
    ...comparison.top.slice(0, LISTED).map((line) => `  ${line}`),
    `host to servo packets: reference ${hostPackets.reference}, candidate ${hostPackets.candidate}, differing ${hostPackets.differing}`,
    `servo to host packets: reference ${servoPackets.reference}, candidate ${servoPackets.candidate}, differing ${servoPackets.differing}`,
  ];
  for (const part of STATION_PARTS) {
    const each = comparison.parts[part];
    if (each.differences === 0) continue;
    lines.push(`${part}: ${each.differences} differences in ${each.steps} steps`);
    lines.push(...each.listed.map((line) => `  ${line}`));
  }

  return lines;
}

/** How far apart two results are in what the model reads, for a look at a comparison that failed: the largest
 * difference of a measured joint (rad) and of the gripper's opening over the results of both runs' actions. It
 * tolerates nothing and decides nothing. */
export function measuredPositionGap(reference: StationRunResult, candidate: StationRunResult): {
  compared: number;
  identical: number;
  maxJointRad: number;
  maxOpening: number;
} {
  const gap = { compared: 0, identical: 0, maxJointRad: 0, maxOpening: 0 };
  reference.sessions.forEach((session, sessionIndex) => {
    session.steps.forEach((step, stepIndex) => {
      const ours = positionOf(step);
      const theirs = positionOf(candidate.sessions[sessionIndex]?.steps[stepIndex]);
      if (ours === null || theirs === null) return;
      gap.compared += 1;
      let isIdentical = ours.length === theirs.length;
      ours.forEach((coordinate, index) => {
        const other = theirs[index] ?? Number.NaN;
        const difference = Math.abs(coordinate - other);
        const key = index === ours.length - 1 ? "maxOpening" : "maxJointRad";
        if (!(difference <= gap[key])) gap[key] = difference; // a NaN is kept
        if (!Object.is(coordinate, other)) isIdentical = false;
      });
      if (isIdentical) gap.identical += 1;
    });
  });

  return gap;
}

function positionOf(step: StationStepRecord | undefined): number[] | null {
  const returned = step?.returned as { result?: { measured_position?: Json } } | null | undefined;
  const position = returned?.result?.measured_position;

  return Array.isArray(position) ? (position as number[]) : null;
}
