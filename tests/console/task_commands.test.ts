// PEAR's own Commands running a task on PEAR's Console, TaskRun and robot, against the port's three parts together
// (src/console/commands.ts, console.ts with its worker, task_run.ts, on pear.js's real robot on the stepped
// stand-in arm): the scenario of tests/fixtures/console/task_commands.json that
// tools/fixtures/console_task_commands_fixtures.py recorded is replayed step by step on the port
// (task_commands_rig.ts says how the rig is made, how PEAR's three threads are told apart and what the hand-over
// is). The scenario is replayed by its name; the file may hold others.
//
// The order between the threads. PEAR's Console.stop sets the cancellation at its first line, and so does the
// port's. The fixture script wrapped it (stop() runs with a cancellation of the script's own, the worker's is set
// when stop() has returned), and the rig does the same to the port's console. So the order within each thread is
// compared as PEAR's, and the order between the threads (the events' ids, each call's `after_event`, the clock) as
// the script's choice among the orders PEAR allows.
//
// What is compared, with differencesOf (the same double, the same keys in the same order, the same number of
// items): every part of each step (returned, raised, events, phases, console, task, task_run, session,
// robot_status, files, calls, model_inputs, ids, clock), and before the first step (console_before,
// robot_status_before, ids_before, sleeps_before, monotonic_s_before). A frame is compared by its name; a frame's
// path by its last part (the real robot's frames are its own, not PEAR's; the path is machine-specific).

import { describe, expect, test } from "vitest";

import {
  loadTaskCommandsFixture,
  TaskCommandsRig,
  type StepMade,
  type TaskCommandsScenario,
  type TaskCommandsStep,
} from "./task_commands_rig";

const fixture = loadTaskCommandsFixture();
/** The scenario this test replays, by its name. */
const NAME = "start, two turns, pause while the model is asked";
/** The parts of a step's record that are compared. */
const PARTS: ReadonlyArray<keyof StepMade> = [
  "returned",
  "raised",
  "events",
  "phases",
  "console",
  "task",
  "task_run",
  "session",
  "robot_status",
  "files",
  "calls",
  "model_inputs",
  "ids",
  "clock",
];
/** A replay waits on the machine's clock (the hand-over, the worker's end): its own time limit, ms. */
const LIMIT_MS = 60_000;

/** What a difference shows of a value. */
function shown(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);

  return Object.is(value, -0) ? "-0" : text.length > 160 ? `${text.slice(0, 160)}...` : text;
}

function isDictionary(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Adds to ``found`` every place where ``actual`` differs from PEAR's ``expected``: not the same double, not the
 * same keys in the same order, not the same number of items (as commands.test.ts compares). */
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

/** PEAR's record of a step's files as the port's are compared with it (see the head of this file): a frame by its
 * name; a frame's path in an observation's record by its last part, which must lie in the task's folder. */
function expectedFiles(step: TaskCommandsStep, path: string, found: string[]): unknown {
  return step.files.map((file, index) => {
    const name = String(file["name"]);
    if (name.endsWith(".jpg") && Object.hasOwn(file, "sha256")) {
      return { name };
    }
    const json = file["json"];
    if (!isDictionary(json) || !isDictionary(json["images"])) {
      return file;
    }
    const folder = `${fixture.meta.root}/${name.slice(0, name.indexOf("/"))}/`;
    const images: Record<string, unknown> = {};
    for (const [role, framePath] of Object.entries(json["images"])) {
      if (typeof framePath === "string" && framePath.startsWith(folder)) {
        images[role] = framePath.slice(folder.length);
      } else {
        found.push(`${path}.files[${index}].json.images.${role}: PEAR's path ${shown(framePath)} does not lie in the task's folder`);
        images[role] = framePath;
      }
    }

    return { ...file, json: { ...json, images } };
  });
}

/** The scenario of the fixture this test replays. */
function recorded(): TaskCommandsScenario {
  const scenario = fixture.scenarios.find((one) => one.name === NAME);
  if (scenario === undefined) {
    throw new Error(`the fixture holds no scenario "${NAME}"`);
  }

  return scenario;
}

/** Replays the first ``count`` steps of the scenario on a new rig and returns where they differ from PEAR's
 * record. */
async function replay(count: number): Promise<string[]> {
  const scenario = recorded();
  const rig = await TaskCommandsRig.join(fixture.meta, scenario);
  const differences: string[] = [];
  try {
    const before = rig.beforeFirst();
    differencesOf(before.console, scenario.console_before, "console_before", differences);
    differencesOf(before.robot_status, scenario.robot_status_before, "robot_status_before", differences);
    differencesOf(before.ids, scenario.ids_before, "ids_before", differences);
    differencesOf(before.sleeps, scenario.sleeps_before, "sleeps_before", differences);
    differencesOf(before.monotonic_s, scenario.monotonic_s_before, "monotonic_s_before", differences);

    for (const [index, step] of scenario.steps.slice(0, count).entries()) {
      const path = `steps[${index}] (${step.command})`;
      const made = await rig.step(step);
      for (const part of PARTS) {
        const expected = part === "files" ? expectedFiles(step, path, differences) : step[part];
        differencesOf(made[part], expected, `${path}.${part}`, differences);
      }
    }
    // every question of the kinematics was answered by PEAR's recorded answer, and no clock in nanoseconds was read
    differencesOf(rig.unanswered, [], "the kinematics' questions the record does not answer", differences);
    differencesOf(rig.nsReadings, 0, "the readings of time.time_ns()", differences);
  } finally {
    await rig.dispose();
  }

  return differences;
}

describe("PEAR's commands running a task, replayed on the port's Commands, Console and TaskRun together", () => {
  test("the fixture holds the scenario this test was written for: start, then pause at the hand-over", () => {
    const scenario = recorded();

    expect(scenario.steps.map((step) => [step.command, step.at, step.until])).toEqual([
      ["start", null, "turn 3: the model is asked"],
      ["pause", "turn 3: the model is asked", "ended"],
    ]);
    expect(fixture.meta.threads).toEqual(["main", "worker", "model"]);
  });

  test(
    `${NAME}: step 1 (start) until the model's request waits: every part, and what stands before it`,
    async () => {
      const differences = await replay(1);

      expect(differences.slice(0, 12)).toEqual([]);
    },
    LIMIT_MS,
  );

  test(
    `${NAME}: steps 1 and 2 (start, then pause until the worker has ended): every part of each`,
    async () => {
      const differences = await replay(2);

      expect(differences.slice(0, 12)).toEqual([]);
    },
    LIMIT_MS,
  );
});
