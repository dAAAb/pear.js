// The port's TaskRun (src/console/task_run.ts) held to PEAR's own: the scenarios of
// tests/fixtures/console/task_run.json.gz, which PEAR's Python ran through PEAR's TaskRun
// (tools/fixtures/console_fixtures.py), replayed here on pear.js's real robot on the stepped stand-in arm, with the
// stand-in console and the scripted model of ./rig.ts.
//
// Compared for every call of a scenario, each exactly (a number is the same double, a dictionary has PEAR's keys
// in PEAR's order): what the call raised (class name and message); every event (id, type, data, time,
// monotonic_s, task_id, saved); the phases set and the phase after; the files of the task's folder; TaskRun's
// fields; the session's; console.performance; the robot's status; the robot's calls with `after_event`; what the
// model was sent; the UUIDs drawn; the clock (sleeps, monotonic_s, the readings of the wall clock). Before the
// first call: the robot's session, what its opening drew and slept. Once: the constants of meta.constants that the
// port has.
//
// A call is TaskRun.run or one of the fixture script's other calls (rig.ts, ConsoleRig.call): newSession (its
// record also holds `session_given`: what the new session was given), closeSession (also `client`: how often the
// client's cancel() and close() were called, and with `close_raises` its close() raises), the private startTurn,
// onEvent by itself, and `new_client`, which is the script's assignment of a client that never started a session.
// A call's record has no part that is not compared (the test fails on a part it does not know).
//
// Two things of these records are the rig's and say nothing of the port, though they are compared:
//   - the phase before any phase is set ("Holding"): the fixture script gave it to PEAR's console, and the stand-in
//     console starts with the same. TaskRun does not read it; in a call that sets no phase, `phase` shows only that
//     none was set, as the empty `phases` does.
//   - `client.cancelled` counts the calls of the client's cancel() from outside the client, as the script counts
//     them: the cancel() that the client's own close() makes (PEAR's ModelClient.close and the port's alike) is
//     left out on both sides. What it holds the port to is PEAR's: a session is closed through the loop's close(),
//     which cancels once and closes once; a client without a session is closed and not cancelled.
//
// Not compared, each with its reason:
//   - a frame's bytes (`size`, `sha256` of a .jpg): the port's loop keeps a frame's bytes in the turn's model
//     input and writes no file, and a stand-in frame is not PEAR's JPEG. A frame is compared by its name.
//   - the folder of a frame's path: an observation's record holds the path of each frame under the console's root
//     in PEAR ("<root>/<task id>/<name>") and the file's name in the port, whose records have no folder. PEAR's
//     path is compared by its last part, and must lie in the task's folder.
//   - of an error a call of the robot raised, what the port's errors do not carry: compared are the class's name,
//     the message, whether it is a ValueError and its details (as tests/station-robot/capstone.test.ts does).
//   - is_holding: the fixture does not record it (how often the loop asks while the model works is the machine's).
//   - `session_given.directory`: PEAR's session is given the task's folder, where it writes the frames; the port's
//     loop is given no folder (it writes no file, the records are TaskRun's). PEAR's value must be the task's folder.
//   - the folder of a reference image's path in `session_given`: PEAR's session is given the path of each image's
//     file, the port's the file's bytes, name and uuid. PEAR's path is compared by its last part with the name, and
//     must lie in the task's folder; the bytes the port's session holds must be those of the task's file. The file
//     itself is compared whole (size and SHA-256), the rig making the stand-in bytes the fixture script made.
//   - a task's image `url`: what Commands._start adds to the task; TaskRun does not read it.
//
// The fixture holds no answers of PEAR's kinematics and no table of the reference's C library for its motions.
// The rig answers a question of the kinematics as PEAR did where the turn loop's fixtures (agent_rig.json.gz) hold
// the same question, and pear.js's own kinematics answer the others, in other last digits: the scenarios that
// meet such an answer are listed in KNOWN with the places that then differ, and are held to everything else.
// Ruckig's five inexact functions answer from the table of the station's fixtures where it holds the argument and
// from the engine where it does not. The line this file prints at its end counts both.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { Phase } from "../../src/console/phase";
import { TaskEventKind } from "../../src/console/task_events";
import { RECORD_URL, TaskRun } from "../../src/console/task_run";
import { installOracle, type Oracle } from "../ruckig/oracle";
import { DIRECTORY } from "../station-robot/fixtures";
import {
  ConsoleRig,
  loadConsoleFixture,
  StandInConsole,
  type CallRecord,
  type RecordedFile,
  type RecordedScenario,
  type RobotCall,
} from "./rig";

const fixture = loadConsoleFixture();

/** Scenarios that are not replayed, by number, each with its reason (see docs/progress/console.md). */
const SKIPPED: Record<number, string> = {};

/** The five arm joints of a measured position or of the joint positions the robot reports, wherever a record
 * carries them: what a joint target of pear.js's own kinematics moves in its last digits. */
const ARM_JOINTS = /(measured_position|joint_positions)\[[0-4]\]$/;
/** The farthest a joint of ARM_JOINTS may be from PEAR's, rad. */
const KINEMATICS_APART = 1e-12;

/**
 * Scenarios in which the replay differs from PEAR's record for a reason that is not TaskRun's, by number: the
 * reason, and the places that differ. Such a scenario is still replayed and compared in full: its test fails when
 * any other place differs, when one of these places is farther than KINEMATICS_APART from PEAR's, and when none
 * of them differs any more.
 */
const KNOWN: Record<number, { reason: string; places: RegExp }> = {
  1: { reason: "no answer of PEAR's kinematics to its second action is recorded; pear.js's own gives other last digits", places: ARM_JOINTS },
  3: {
    reason: "no answer of PEAR's kinematics to its second call's action is recorded; pear.js's own gives other last digits",
    places: /(measured_position|joint_positions|tracking_error)\[[0-4]\]$/, // (there the arm is also that far from its target)
  },
};

/** What a difference shows of a value. */
function shown(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);

  return Object.is(value, -0) ? "-0" : text.length > 160 ? `${text.slice(0, 160)}...` : text;
}

function isDictionary(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A place where the port differs from PEAR: its path in the record, and what is there. */
interface Difference {
  path: string;
  text: string;
  /** Of two numbers, how far they are apart. */
  apart?: number;
}

/** Adds to ``found`` every place where ``actual`` differs from PEAR's ``expected``: not the same double, not the
 * same keys in the same order, not the same number of items. Nothing is added when they are the same. */
function differencesOf(actual: unknown, expected: unknown, path: string, found: Difference[]): void {
  if (Array.isArray(actual) && Array.isArray(expected)) {
    for (let index = 0; index < Math.min(actual.length, expected.length); index++) {
      differencesOf(actual[index], expected[index], `${path}[${index}]`, found);
    }
    if (actual.length !== expected.length) {
      const extra = actual.length > expected.length ? actual[expected.length] : expected[actual.length];
      found.push({ path, text: `${actual.length} items where PEAR's has ${expected.length}; the first one more is ${shown(extra)}` });
    }
  } else if (isDictionary(actual) && isDictionary(expected)) {
    const keys = Object.keys(actual);
    const expectedKeys = Object.keys(expected);
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
      found.push({ path, text: `the keys ${keys.join(",")} where PEAR's are ${expectedKeys.join(",")}` });
      return;
    }
    for (const key of keys) {
      differencesOf(actual[key], expected[key], `${path}.${key}`, found);
    }
  } else if (!Object.is(actual, expected)) {
    const difference: Difference = { path, text: `${shown(actual)} where PEAR's is ${shown(expected)}` };
    if (typeof actual === "number" && typeof expected === "number") {
      difference.apart = Math.abs(actual - expected);
    }
    found.push(difference);
  }
}

/** Returns the first place where ``actual`` differs from PEAR's ``expected``, or null when they are the same. */
function difference(actual: unknown, expected: unknown, path: string): string | null {
  const found: Difference[] = [];
  differencesOf(actual, expected, path, found);

  return found.length === 0 ? null : `${found[0]!.path}: ${found[0]!.text}`;
}

/** PEAR's files of a call as the port can hold them: a file `unchanged` since the call before as it was then, a
 * frame by its name, and a frame's path in an observation's record by its last part. */
function expectedFiles(files: RecordedFile[], before: RecordedFile[], scenario: RecordedScenario): RecordedFile[] {
  const folder = `${fixture.meta.root}/${scenario.task.id}/`;

  return files.map((file) => {
    if (file.unchanged) {
      const earlier = before.find((candidate) => candidate.name === file.name);
      expect(earlier, `${file.name} is unchanged since a call that did not have it`).toBeDefined();
      return earlier!;
    }
    if (file.sha256 !== undefined) {
      // (a file the task was given, a reference image, is compared whole: the rig holds its bytes; a frame by name)
      return (scenario.task.images ?? []).some((image) => image.file === file.name) ? file : { name: file.name };
    }
    const images = (file.json as { images?: Record<string, string> } | undefined)?.images;
    if (file.name.endsWith("-observation.json") && images !== undefined) {
      const names = Object.fromEntries(
        Object.entries(images).map(([camera, path]) => {
          if (!path.startsWith(`${fixture.meta.root}/`)) {
            return [camera, path]; // (what an on_event by itself was given, not a file of the console's: as it is)
          }
          expect(path.startsWith(folder), `${file.name}: ${path} is in the task's folder`).toBe(true);
          return [camera, path.slice(folder.length)];
        }),
      );
      return { name: file.name, json: { ...(file.json as object), images: names } };
    }
    return file;
  });
}

/** PEAR's record of a call of the robot, an error it raised reduced to what the port's errors carry. */
function expectedCall(call: RobotCall): RobotCall {
  const raised = call["raised"] as Record<string, unknown> | undefined;
  if (raised === undefined) {
    return call;
  }
  const record: Record<string, unknown> = { type: raised["type"], message: raised["message"], is_value_error: raised["is_value_error"] };
  if (raised["details"] !== undefined) {
    record["details"] = raised["details"];
  }

  return { ...call, raised: record };
}

/** PEAR's record of what a new session was given, as the port can hold it: without `directory`, which must be the
 * task's folder, and each reference image's path by its last part, which must lie in that folder. */
function expectedSessionGiven(given: unknown, scenario: RecordedScenario): CallRecord["session_given"] {
  if (given === null) {
    return null;
  }
  const folder = `${fixture.meta.root}/${scenario.task.id}`;
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(given as Record<string, unknown>)) {
    if (key === "directory") {
      expect(value, "the folder PEAR's session is given is the task's").toBe(folder);
    } else if (key === "reference_images") {
      record[key] = (value as Array<{ path: string; uuid: string }>).map((image) => {
        expect(image.path.startsWith(`${folder}/`), `${image.path} is in the task's folder`).toBe(true);
        return { ...image, path: image.path.slice(folder.length + 1) };
      });
    } else {
      record[key] = value;
    }
  }

  return record as unknown as CallRecord["session_given"];
}

const PARTS: ReadonlyArray<keyof CallRecord> = [
  "raised",
  "events",
  "phases",
  "phase",
  "files",
  "task_run",
  "session",
  "performance",
  "robot_status",
  "robot",
  "model_inputs",
  "ids",
  "clock",
  "session_given", // (a "new_session" only: no such key in the record of another call, and none in the replay's)
  "client", // (a "close_session" only)
];

/** The questions of the robot's kinematics over all scenarios: answered by PEAR's recorded answer, and by pear.js's
 * own kinematics. */
const kinematics = { pears: 0, own: 0 };

/** Replays every call of ``scenario`` and returns where the port differs from PEAR, a line for each part. */
async function replay(scenario: RecordedScenario): Promise<Difference[]> {
  const differences: Difference[] = [];
  const check = (where: string, actual: unknown, expected: unknown): void => {
    differencesOf(actual, expected, where, differences);
  };

  const rig = await ConsoleRig.open(fixture.meta, scenario);
  try {
    check("before the first call", rig.before(), {
      ids: scenario.ids_before,
      sleeps: scenario.sleeps_before,
      monotonic_s: scenario.monotonic_s_before,
    });
    check(
      "the robot and the model",
      { robot_session_id: rig.robot.sessionId, control_period_s: rig.robot.controlPeriodS, model_timeout_s: rig.console.modelTimeoutS },
      { robot_session_id: scenario.robot_session_id, control_period_s: scenario.control_period_s, model_timeout_s: scenario.model_timeout_s },
    );

    let filesBefore: RecordedFile[] = [];
    for (const [index, call] of scenario.calls.entries()) {
      const replayed = await rig.run(call.script, call.ids);
      const expected: CallRecord = {
        ...call,
        files: expectedFiles(call.files, filesBefore, scenario),
        robot: call.robot.map(expectedCall),
      };
      if (call.session_given !== undefined) {
        expected.session_given = expectedSessionGiven(call.session_given, scenario);
      }
      filesBefore = expected.files;
      for (const part of PARTS) {
        check(`call ${index}: ${part}`, replayed[part], expected[part]);
      }
      // (a part that a later version of the fixture adds is not left out without a word)
      const uncompared = Object.keys(call).filter((key) => key !== "op" && key !== "script" && !PARTS.includes(key as keyof CallRecord));
      check(`call ${index}: the parts of PEAR's record that are not compared`, uncompared, []);
      check(`call ${index}: what a hook started and failed`, rig.failures.map(String), []);
    }
  } finally {
    kinematics.pears += rig.kinematics.pears;
    kinematics.own += rig.kinematics.own;
    await rig.close();
  }

  return differences;
}

describe("PEAR's task runs, replayed on the port's TaskRun", () => {
  let oracle: Oracle;
  let replayed = 0;

  beforeAll(() => {
    oracle = installOracle(DIRECTORY);
  });
  afterAll(() => {
    console.info(
      `console: ${replayed} of ${fixture.scenarios.length} scenarios replayed; libm.json: ${oracle.hits()} calls answered ` +
        `from it, ${oracle.missing()} arguments missing; kinematics: ${kinematics.pears} questions answered as PEAR ` +
        `answered them, ${kinematics.own} by pear.js's own`,
    );
  });

  test("the constants are PEAR's", () => {
    const constants = fixture.meta.constants;
    expect(
      difference(
        {
          UNREACHABLE_RETRIES: TaskRun.UNREACHABLE_RETRIES,
          RETRY_NOTICE: TaskRun.RETRY_NOTICE,
          ATTEMPT_ID_CHARS: TaskRun.ATTEMPT_ID_CHARS,
          STATISTICS_EVENTS: [...TaskRun.STATISTICS_EVENTS],
          OUTCOME_PHASES: { ...TaskRun.OUTCOME_PHASES },
          RESUME_CONTEXT_EVENT: TaskRun.RESUME_CONTEXT_EVENT,
          INTERRUPTED_EVENT: TaskRun.INTERRUPTED_EVENT,
          RECORD_URL,
        },
        constants["task_run"],
        "task_run",
      ),
    ).toBeNull();
    expect(difference({ ...Phase }, constants["phase"], "phase")).toBeNull();
    expect(difference({ ...TaskEventKind }, constants["task_event_kind"], "task_event_kind")).toBeNull();
    // the stand-in console's own, which PEAR's Console gives
    const console = constants["console"]!;
    expect({
      SETTLE_TIMEOUT_S: 10.0,
      EVENT_CAPACITY: StandInConsole.EVENT_CAPACITY,
      PAUSE_REASON: StandInConsole.PAUSE_REASON,
      STOPPING_EVENT: StandInConsole.STOPPING_EVENT,
    }).toEqual({
      SETTLE_TIMEOUT_S: console["SETTLE_TIMEOUT_S"],
      EVENT_CAPACITY: console["EVENT_CAPACITY"],
      PAUSE_REASON: console["PAUSE_REASON"],
      STOPPING_EVENT: console["STOPPING_EVENT"],
    });
  });

  fixture.scenarios.forEach((scenario, index) => {
    const reason = SKIPPED[index + 1];
    if (reason !== undefined) {
      test.skip(`scenario ${index + 1}: ${scenario.name} (not replayed: ${reason})`, () => undefined);
      return;
    }
    const known = KNOWN[index + 1];
    const title = `scenario ${index + 1}: ${scenario.name}` + (known === undefined ? "" : ` (differs from PEAR's record: ${known.reason})`);
    test(title, { timeout: 120_000 }, async () => {
      const differences = await replay(scenario);
      replayed += 1;
      if (process.env.PEAR_JS_CONSOLE_REPORT) {
        console.info(differences.map((found) => `#${index + 1} ${found.path}: ${found.text}`.slice(0, 300)).join("\n"));
      }
      // every place that differs is a known one and within its bound; a scenario with known places has some
      const isKnown = (found: Difference): boolean =>
        known !== undefined && known.places.test(found.path) && found.apart !== undefined && found.apart <= KINEMATICS_APART;
      const unknown = differences.filter((found) => !isKnown(found));
      expect(unknown.slice(0, 12).map((found) => `${found.path}: ${found.text}`.slice(0, 500)), `${unknown.length} places differ from PEAR's`).toEqual([]);
      expect(differences.length > 0, "whether the scenario differs in its known places").toBe(known !== undefined);
    });
  });
});
