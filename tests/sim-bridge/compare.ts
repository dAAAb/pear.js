// Not in PEAR: compares two results of the scripted sessions, the reference's (PEAR's Python) and a candidate's
// (pear.js), both run on the same simulated servo chain: the packets each put on the wire, what each read, what
// each refused and warned of. Nothing is tolerated here: every difference is counted, and the caller decides.

import type { Reading, RunResult, StepError } from "./session";

const COUNTS_PER_RAD = 4096 / (2 * Math.PI); // of the STS3215's encoder
const GRIPPER_INDEX = 5;
const PORT_PLACEHOLDER = "<port>";
const LISTED = 12; // differences listed of each kind; all are counted

/** A packet that is not the same on both sides: the session, the segment's label, the packet's index among the
 * segment's packets of that direction, and the two packets (null where a side has none). */
export interface PacketDifference {
  session: string;
  segment: string;
  index: number;
  reference: string | null;
  candidate: string | null;
}

export interface PacketComparison {
  reference: number;
  candidate: number;
  /** Positions at which the two sides' packets differ, a missing packet included. */
  differing: number;
  listed: PacketDifference[];
}

export interface ReadingComparison {
  /** Readings both sides returned at the same step. */
  compared: number;
  /** Of those, the ones equal in every bit: position, sample id, servo status. */
  identical: number;
  /** The largest difference of a coordinate, in encoder counts. */
  maxCounts: number;
  /** Readings whose sample id or servo status differ. */
  statusDiffering: number;
}

export interface Comparison {
  sessions: number;
  /** Steps that are not the same kind of outcome on both sides (returned, threw, skipped). */
  steps: { compared: number; differing: string[] };
  /** Instruction packets, host to servo. */
  hostPackets: PacketComparison;
  /** Status packets, servo to host. */
  servoPackets: PacketComparison;
  /** Readings of read and read_for_recovery steps: between commands. */
  readingsBetween: ReadingComparison;
  /** Readings of cycle and burst steps: while a target is commanded. */
  readingsCommanded: ReadingComparison;
  refusals: {
    compared: number;
    sameMessage: number;
    /** The class names are the same string. */
    sameType: number;
    /** The candidate's class is the one pear.js documents for the reference's (jsErrorName). */
    sameMappedType: number;
    differing: string[];
  };
  warnings: { reference: number; candidate: number; differing: string[] };
}

/** Returns the name of the pear.js error class that stands for a Python exception of the reference, as
 * docs/progress/feetech.md lists them: a failed packet exchange, an error byte, a servo's fault, anything else. */
export function jsErrorName(error: StepError): string {
  switch (error.type) {
    case "ConnectionError":
      return "FeetechCommError";
    case "RuntimeError":
      return error.message.includes("[RxPacketError]") ? "FeetechStatusError" : "Error";
    case "ValueError":
    case "IndexError":
      return "RangeError";
    default:
      return error.type;
  }
}

function packetsOf(result: RunResult, sessionIndex: number, direction: "h" | "s"): Map<string, string[]> {
  const bySegment = new Map<string, string[]>();
  result.sessions[sessionIndex].traffic.forEach((segment, index) => {
    bySegment.set(
      `${index}: ${segment.label}`,
      segment.packets.filter(([each]) => each === direction).map(([, hex]) => hex),
    );
  });

  return bySegment;
}

function comparePackets(reference: RunResult, candidate: RunResult, direction: "h" | "s"): PacketComparison {
  const comparison: PacketComparison = { reference: 0, candidate: 0, differing: 0, listed: [] };
  reference.sessions.forEach((session, sessionIndex) => {
    if (sessionIndex >= candidate.sessions.length) return;
    const ours = packetsOf(reference, sessionIndex, direction);
    const theirs = packetsOf(candidate, sessionIndex, direction);
    for (const segment of new Set([...ours.keys(), ...theirs.keys()])) {
      const expected = ours.get(segment) ?? [];
      const found = theirs.get(segment) ?? [];
      comparison.reference += expected.length;
      comparison.candidate += found.length;
      for (let index = 0; index < Math.max(expected.length, found.length); index++) {
        if (expected[index] === found[index]) continue;
        comparison.differing += 1;
        if (comparison.listed.length < LISTED) {
          comparison.listed.push({
            session: session.name,
            segment,
            index,
            reference: expected[index] ?? null,
            candidate: found[index] ?? null,
          });
        }
      }
    }
  });

  return comparison;
}

function compareReading(
  comparison: ReadingComparison,
  expected: Reading,
  found: Reading,
  gripperCounts: number,
): void {
  comparison.compared += 1;
  let isIdentical = expected.position.length === found.position.length;
  expected.position.forEach((coordinate, index) => {
    const difference = Math.abs(coordinate - (found.position[index] ?? Number.NaN));
    const counts = difference * (index === GRIPPER_INDEX ? gripperCounts : COUNTS_PER_RAD);
    if (!(counts <= comparison.maxCounts)) comparison.maxCounts = counts; // a NaN is kept
    if (!Object.is(coordinate, found.position[index])) isIdentical = false;
  });
  const hasSameStatus =
    expected.sample_id === found.sample_id &&
    JSON.stringify(expected.servo_status) === JSON.stringify(found.servo_status);
  if (!hasSameStatus) comparison.statusDiffering += 1;
  if (isIdentical && hasSameStatus) comparison.identical += 1;
}

/** Compares ``candidate`` with ``reference``, session by session and step by step. */
export function compareResults(reference: RunResult, candidate: RunResult): Comparison {
  const emptyReadings = (): ReadingComparison => ({ compared: 0, identical: 0, maxCounts: 0, statusDiffering: 0 });
  const comparison: Comparison = {
    sessions: reference.sessions.length,
    steps: { compared: 0, differing: [] },
    hostPackets: comparePackets(reference, candidate, "h"),
    servoPackets: comparePackets(reference, candidate, "s"),
    readingsBetween: emptyReadings(),
    readingsCommanded: emptyReadings(),
    refusals: { compared: 0, sameMessage: 0, sameType: 0, sameMappedType: 0, differing: [] },
    warnings: { reference: 0, candidate: 0, differing: [] },
  };
  if (reference.session_sha256 !== candidate.session_sha256) {
    comparison.steps.differing.push("the two sides ran different session files");
  }
  if (reference.sessions.length !== candidate.sessions.length) {
    comparison.steps.differing.push(`${reference.sessions.length} sessions against ${candidate.sessions.length}`);
  }

  // the gripper's opening is a share of its calibrated range of encoder counts
  const gripper = reference.calibration.gripper;
  const gripperCounts = gripper === undefined ? Number.NaN : gripper.range_max - gripper.range_min;
  // each side names its line in some messages; the name is the only thing put aside
  const messageOf = (result: RunResult, text: string): string => text.split(result.port_name).join(PORT_PLACEHOLDER);

  reference.sessions.forEach((session, sessionIndex) => {
    const other = candidate.sessions[sessionIndex];
    if (other === undefined) return;
    if (other.name !== session.name || other.steps.length !== session.steps.length) {
      comparison.steps.differing.push(`${session.name}: the candidate ran '${other.name}' with ${other.steps.length} steps`);
      return;
    }

    session.steps.forEach((step, index) => {
      const found = other.steps[index];
      const where = `${session.name}, step ${index} (${step.op})`;
      comparison.steps.compared += 1;

      const kindOf = (each: typeof step): string =>
        [each.op, each.label ?? "", each.skipped ?? "", each.released ?? "", each.error === undefined ? "returned" : "threw"].join("|");
      if (kindOf(step) !== kindOf(found)) comparison.steps.differing.push(`${where}: ${kindOf(step)} against ${kindOf(found)}`);

      if (step.result != null && found.result != null) {
        const readings = step.op === "cycle" || step.op === "burst" ? comparison.readingsCommanded : comparison.readingsBetween;
        compareReading(readings, step.result, found.result, gripperCounts);
      } else if ((step.result != null) !== (found.result != null)) {
        comparison.steps.differing.push(`${where}: only one side returned a reading`);
      }

      if (step.error !== undefined && found.error !== undefined) {
        const refusals = comparison.refusals;
        refusals.compared += 1;
        const expectedMessage = messageOf(reference, step.error.message);
        const foundMessage = messageOf(candidate, found.error.message);
        if (expectedMessage === foundMessage) {
          refusals.sameMessage += 1;
        } else {
          refusals.differing.push(
            `${where}: message ${JSON.stringify(expectedMessage)} against ${JSON.stringify(foundMessage)}`,
          );
        }
        if (step.error.type === found.error.type) refusals.sameType += 1;
        const documented = jsErrorName(step.error);
        if (documented === found.error.type) {
          refusals.sameMappedType += 1;
        } else {
          refusals.differing.push(
            `${where}: class ${step.error.type} (pear.js: ${documented}) against ${found.error.type}`,
          );
        }
      }

      const expectedWarnings = (step.warnings ?? []).map((text) => messageOf(reference, text));
      const foundWarnings = (found.warnings ?? []).map((text) => messageOf(candidate, text));
      comparison.warnings.reference += expectedWarnings.length;
      comparison.warnings.candidate += foundWarnings.length;
      if (JSON.stringify(expectedWarnings) !== JSON.stringify(foundWarnings)) {
        comparison.warnings.differing.push(
          `${where}: ${JSON.stringify(expectedWarnings)} against ${JSON.stringify(foundWarnings)}`,
        );
      }
    });
  });

  return comparison;
}

/** Returns the comparison as lines of text, every number of it. */
export function describeComparison(comparison: Comparison): string[] {
  const packets = (name: string, each: PacketComparison): string[] => [
    `${name}: reference ${each.reference}, candidate ${each.candidate}, differing ${each.differing}`,
    ...each.listed.map(
      (difference) =>
        `  ${difference.session} / ${difference.segment} / #${difference.index}: ${difference.reference} against ${difference.candidate}`,
    ),
  ];
  const readings = (name: string, each: ReadingComparison): string =>
    `${name}: compared ${each.compared}, identical in every bit ${each.identical}, largest difference ` +
    `${each.maxCounts.toFixed(3)} encoder counts, sample id or servo status differing ${each.statusDiffering}`;
  const { refusals, steps, warnings } = comparison;

  return [
    `sessions ${comparison.sessions}, steps compared ${steps.compared}, differing in kind ${steps.differing.length}`,
    ...comparison.steps.differing.slice(0, LISTED).map((line) => `  ${line}`),
    ...packets("host to servo packets", comparison.hostPackets),
    ...packets("servo to host packets", comparison.servoPackets),
    readings("readings between commands", comparison.readingsBetween),
    readings("readings while commanded", comparison.readingsCommanded),
    `refusals: compared ${refusals.compared}, same message ${refusals.sameMessage}, same class name ${refusals.sameType}, ` +
      `the class pear.js documents for the reference's ${refusals.sameMappedType}`,
    ...refusals.differing.slice(0, LISTED).map((line) => `  ${line}`),
    `warnings: reference ${warnings.reference}, candidate ${warnings.candidate}, differing ${warnings.differing.length}`,
    ...warnings.differing.slice(0, LISTED).map((line) => `  ${line}`),
  ];
}
