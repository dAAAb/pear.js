// PEAR's own Console, HomeReview and ControlLease against the port's (src/console/console.ts, home_review.ts,
// lease.ts): the 20 scenarios of tests/fixtures/console/console.json, which tools/fixtures/console_core_fixtures.py
// recorded from PEAR's classes, are replayed step by step on the port (console_rig.ts says how the port's Console
// is given what the script sets on PEAR's by attributes, and how a stand-in's call is recorded under PEAR's name).
//
// What is compared, for every scenario and every step, with differencesOf (the same double, the same keys in the
// same order, the same number of items): the console's fields before the first step (`initial`); then every part
// of the step's record:
//
//   returned    what the call returned (snapshot() whole, an event of emit, the report of stop, ...)
//   raised      null, or the class's name and the message
//   events      every event as emit made it (id, type, data, time, monotonic_s, task_id), the thread that
//               emitted it and whether the task's events hold it as a line
//   phases      every phase set_phase was given, by thread
//   calls       every call of the robot and of each stand-in, by thread: name, arguments, keywords, the id of the
//               last event when it began, what it returned or raised
//   operations  what each operation of a launch that ended in the step was given and how it ended
//   fields      the console after the step (phase, error, latch, performance, home_status, saved_fault_identity,
//               is_busy, worker, the events kept, the cancellation, the Home review, the lease)
//   files       every file under the console's root
//   clock       how often each clock was read so far, and what the monotonic clock gives next
//
// and, at a scenario's end, that every UUID of the scenario was drawn and that the port never waited on a live
// worker's time limit. One test holds the constants the record gives (meta.constants: the console's, the lease's,
// the members of HomeStatus, Phase and RobotStatus in PEAR's order), and a last one counts what the replays made
// against the fixture's own counts (meta.counts).
//
// The threads. PEAR's record keeps the main thread's calls and phases and the worker thread's apart, each in its
// own order, and so they are compared: `calls.main` with the port's calls outside the worker's body, `calls.worker`
// with those inside it (console_rig.ts: an async context around launch). That leaves open the order between a call
// of the main thread and a call of the worker within one step: PEAR's record does not hold it (`after_event` places
// a call among the events only), so the port's interleaving of the two is held only as far as the events' ids,
// each call's `after_event` and the fields after the step show it. The port's worker begins on a later microtask
// and PEAR's on a thread; where a scenario lets both act in one step (stop while a Home review waits, a confirm
// that is joined), any interleaving that gives the same per-thread lists passes.
//
// Not compared, each with its reason:
//
// - a step's `script`: it is what the replay is given.
// - what PEAR logs (logger.exception in _operate and save_control_diagnostic): the record does not hold it. The rig
//   keeps the port's lines (ConsoleStage.logged) and nothing reads them.
// - what the record itself does not pin (the fixture script's handoff): the robot, the task run and the health
//   checks are scripted stand-ins, so nothing here is the console on PEAR's robot or on PEAR's TaskRun; the system
//   prompt of new_client (the record holds the client's class name alone); supports_reference_images answering
//   false; a model that names an action format of its own; an event whose kind is an enum member; a fault record
//   that cannot be written; HomeReview and ControlLease standing alone.

import { describe, expect, test } from "vitest";

import { Console } from "../../src/console/console";
import { HomeStatus } from "../../src/console/home_review";
import { ControlLease } from "../../src/console/lease";
import { Phase } from "../../src/console/phase";
import { RobotStatus } from "../../src/station/schemas";
import { ConsoleStage, loadCoreFixture, THREADS, type CoreScenario, type StepMade } from "./console_rig";

const fixture = loadCoreFixture();

/** The parts of a step's record, all of them but its script. */
const PARTS: ReadonlyArray<keyof StepMade> = [
  "returned",
  "raised",
  "events",
  "phases",
  "calls",
  "operations",
  "fields",
  "files",
  "clock",
];

/** What a difference shows of a value. */
function shown(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);

  return Object.is(value, -0) ? "-0" : text.length > 160 ? `${text.slice(0, 160)}...` : text;
}

function isDictionary(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Adds to ``found`` every place where ``actual`` differs from PEAR's ``expected``: not the same double, not the
 * same keys in the same order, not the same number of items (as task_run.test.ts compares). */
function differencesOf(actual: unknown, expected: unknown, path: string, found: string[]): void {
  if (Array.isArray(actual) && Array.isArray(expected)) {
    for (let index = 0; index < Math.min(actual.length, expected.length); index++) {
      differencesOf(actual[index], expected[index], `${path}[${index}]`, found);
    }
    if (actual.length !== expected.length) {
      const extra = actual.length > expected.length ? actual[expected.length] : expected[actual.length];
      found.push(`${path}: ${actual.length} items where PEAR's has ${expected.length}; the first one more is ${shown(extra)}`);
    }
  } else if (isDictionary(actual) && isDictionary(expected)) {
    const keys = Object.keys(actual);
    const expectedKeys = Object.keys(expected);
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
      found.push(`${path}: the keys ${keys.join(",")} where PEAR's are ${expectedKeys.join(",")}`);
      return;
    }
    for (const key of keys) {
      differencesOf(actual[key], expected[key], `${path}.${key}`, found);
    }
  } else if (!Object.is(actual, expected)) {
    found.push(`${path}: ${shown(actual)} where PEAR's is ${shown(expected)}`);
  }
}

/** What a replay of a scenario made, and where it differs from PEAR's record. */
interface Replay {
  steps: StepMade[];
  differences: string[];
}

/** Replays ``scenario`` on a new console of the port and compares every part of every step. */
async function replay(scenario: CoreScenario): Promise<Replay> {
  const stage = new ConsoleStage(fixture.meta, scenario);
  const differences: string[] = [];
  const steps: StepMade[] = [];
  differencesOf(stage.fields(), scenario.initial, "initial", differences);

  for (const [index, step] of scenario.steps.entries()) {
    const made = await stage.step(step.script);
    steps.push(made);
    for (const part of PARTS) {
      differencesOf(made[part], step[part], `steps[${index}] (${step.script.op}).${part}`, differences);
    }
  }
  differencesOf(stage.drawn, scenario.uuids.length, "the UUIDs drawn", differences);
  differencesOf(stage.sleeps, [], "the time limits waited on", differences);

  return { steps, differences };
}

describe("PEAR's Console, HomeReview and ControlLease, replayed on the port", () => {
  test("the fixture holds the scenarios this test was written for", () => {
    expect(fixture.scenarios.map((scenario) => scenario.name)).toEqual([
      "emit_without_task",
      "emit_with_task",
      "emit_in_a_turn",
      "emit_over_capacity",
      "stop_plain",
      "stop_latching",
      "stop_while_home_review_waits",
      "stop_robot_raises",
      "launch_returns",
      "launch_operator_paused",
      "launch_error_robot_ready",
      "launch_error_robot_fault",
      "launch_home_failed",
      "launch_while_busy_and_cancelled",
      "launch_withdraws_home_plan",
      "snapshot_states",
      "close",
      "home_review",
      "control_lease",
      "small_things",
    ]);
  });

  test("the constants are PEAR's, the members of an enumeration in PEAR's order", () => {
    const constants = fixture.meta.constants;
    // the console's, by the names the record holds: one the port has not is undefined here
    const ofConsole: Record<string, unknown> = {};
    for (const name of Object.keys(constants["console"] ?? {})) {
      ofConsole[name] = (Console as unknown as Record<string, unknown>)[name];
    }
    const differences: string[] = [];
    differencesOf(ofConsole, constants["console"], "console", differences);
    differencesOf({ LEASE_S: ControlLease.LEASE_S }, constants["lease"], "lease", differences);
    differencesOf({ ...HomeStatus }, constants["home_status"], "home_status", differences);
    differencesOf({ ...Phase }, constants["phase"], "phase", differences);
    differencesOf({ ...RobotStatus }, constants["robot_status"], "robot_status", differences);

    expect(differences).toEqual([]);
  });

  for (const scenario of fixture.scenarios) {
    test(`${scenario.name}: ${scenario.steps.length} steps, every part of each`, async () => {
      const { differences } = await replay(scenario);

      expect(differences.slice(0, 12)).toEqual([]);
    });
  }

  test("the replays make as many steps, events, calls and operations as the fixture counts", async () => {
    const counts = { scenarios: 0, steps: 0, steps_that_raised: 0, events: 0, events_saved: 0, calls_of_stand_ins: 0, operations: 0 };
    for (const scenario of fixture.scenarios) {
      const { steps } = await replay(scenario);
      counts.scenarios += 1;
      for (const step of steps) {
        counts.steps += 1;
        counts.steps_that_raised += step.raised === null ? 0 : 1;
        counts.events += step.events.length;
        counts.events_saved += step.events.filter((event) => event["saved"] === true).length;
        counts.calls_of_stand_ins += THREADS.reduce((sum, thread) => sum + step.calls[thread].length, 0);
        counts.operations += step.operations.length;
      }
    }

    expect(counts).toEqual(fixture.meta.counts);
    expect(counts.steps).toBe(174);
  });
});
