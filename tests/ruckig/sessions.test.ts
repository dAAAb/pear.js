// Sessions of update calls on the port as it ships, with the engine's own functions, against the reference's.
// (exact.test.ts repeats the same sessions with the reference's C library values, to the last bit.)

import { describe, expect, test } from "vitest";

import { load, timeout, type Session } from "./fixtures";
import { SessionReport, replay } from "./sessions";

// A step further than this from the reference's, relative to the size of its quantity in the session, is another
// trajectory: the session has diverged there. See docs/progress/ruckig.md ("Tolerances") for what was measured.
const SAME_TRAJECTORY = 1e-6;
// The share of the sessions of a kind that may part from the reference's by a last digit (measured on 1,800: none
// of the moves, recoveries and generic loops, 2 of 540 grippers, 4 of 180 sequences, 6 of 180 arm sessions).
const DIVERGED_SHARE = 0.06;

const sessions = load<Session>("e_sessions");

describe("update with the engine's own functions: scripted sessions", () => {
  const kinds = [...new Set(sessions.map((session) => session.k))].sort();

  test("the fixture holds PEAR's call patterns and the module's own loop", () => {
    expect(kinds).toEqual(["generic", "pear_arm", "pear_gripper", "pear_move", "pear_recovery", "pear_sequence"]);
  });

  test.each(kinds)("%s: every update gives the reference's result, new_calculation and state", { timeout: timeout() }, (kind) => {
    const report = new SessionReport();
    sessions.forEach((session, index) => {
      if (session.k === kind) {
        replay(report, session, `e_sessions ${index} (${kind})`, SAME_TRAJECTORY);
      }
    });
    console.info(report.summary(kind));

    expect(report.sessions).toBeGreaterThan(0);
    expect(report.updates).toBeGreaterThan(20);
    expect(report.calculations).toBeGreaterThan(0);
    expect(report.divergedSessions, [...report.divergences.keys()].join("; ")).toBeLessThanOrEqual(Math.max(1, Math.floor(report.sessions * DIVERGED_SHARE)));
    // of the sessions followed to their end, every step is the reference's trajectory
    expect(report.maxRelative).toBeLessThanOrEqual(SAME_TRAJECTORY);
  });
});
