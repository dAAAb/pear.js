// PEAR's own Commands, Watchdog and PeriodicThread against the port's (src/console/commands.ts, watchdog.ts,
// periodic_thread.ts): the 30 scenarios of tests/fixtures/console/commands.json.gz, which
// tools/fixtures/console_commands_fixtures.py recorded from PEAR's classes on PEAR's Console, are replayed step by
// step on the port (commands_rig.ts says what is added to the rig of the console's own fixtures, and how a call of
// the port is recorded in PEAR's form).
//
// What is compared, for every scenario and every step, with differencesOf (the same double, the same keys in the
// same order, the same number of items): the fields before the first step (`initial`); then every part of the
// step's record, as console.test.ts compares them (returned, raised, events, phases, calls, operations, fields,
// files, clock), with what this record adds:
//
//   returned    a command's answer, the keys in PEAR's order (null where the command raised)
//   raised      what a command raised: the class's name and the message
//   fields      also the task run's fields (a key no command has written yet is absent), the model and whether
//               tasks are recorded
//
// and, at a scenario's end, that every UUID of the scenario was drawn; after every step, that the port waited on a
// worker's time limit at most once, for the limit in force (PEAR's WORKER_JOIN_S or the scenario's), and exactly
// once where PEAR found the old operation still stopping. One test holds the constants the record gives
// (meta.constants: the commands' table with all six flags, in PEAR's order; the commands', the watchdog's and the
// periodic thread's constants; the stopped statuses), and a last one counts what the replays made against the
// fixture's own counts (meta.counts).
//
// The threads: as console.test.ts says (the main thread's calls and phases and the worker's are compared apart,
// each in its own order; the order between the two within one step is held only as far as the events' ids, each
// call's `after_event` and the fields show it).
//
// Not compared, each with its reason:
//
// - a step's `script`: it is what the replay is given.
// - `is_daemon` of a step `periodic`: a page's loop is no thread and the port holds no such flag; the test checks
//   that PEAR's record says true and compares the rest of what the step returned.
// - how long a periodic thread waits: the step `periodic` runs on the machine's timers, as PEAR's ran on the
//   machine's clock; the record holds the number of checks made, which is compared.
// - what PEAR logs (logger.warning, logger.exception): the record does not hold it. The rig keeps the port's lines
//   (CommandsStage.logged) and nothing reads them.
// - what the record itself does not pin (the fixture script's docstring and handoff): the robot, the task run, the
//   cameras, the recordings, the uploads and the annotations are scripted stand-ins, so nothing here is the commands
//   on PEAR's robot or on PEAR's TaskRun (no turn runs; `run` and `close_session` return at once); the watchdog's
//   check runs on the main thread, not on its own; PEAR's Annotations.clean_tags ran for the record and the port
//   takes it as an interface, which the rig gives (its own copy of PEAR's).
//
// What the record does not reach, so that a break of the port there passes this test (shown by breaking the port,
// one text at a time): the handler of home_confirm (no scenario gives that command); home past its refusals (the
// plan's review, the stages' phases, the files of the Home report and of the plan); and when a periodic thread
// waits (the wait before the first step, the pacing from a step's start, the time limit of close).

import { describe, expect, test } from "vitest";

import { Commands } from "../../src/console/commands";
import { Console } from "../../src/console/console";
import { PeriodicThread } from "../../src/console/periodic_thread";
import { STOPPED_STATUSES } from "../../src/console/phase";
import { RECORD_URL } from "../../src/console/task_run";
import { SEGMENT_FAILED, Watchdog } from "../../src/console/watchdog";
import { CommandsStage, loadCommandsFixture, type CommandsScenario } from "./commands_rig";
import { THREADS, type CoreStep, type StepMade } from "./console_rig";

const fixture = loadCommandsFixture();

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
/** What a command that stops the running operation first raises when the operation outlives the time limit. */
const STILL_STOPPING = "Old operation is still stopping; no new operation was started";
/** The six flags of a command, in the order of PEAR's dataclass, each with the port's name. */
const COMMAND_FLAGS = [
  ["is_immediate", "isImmediate"],
  ["needs_control", "needsControl"],
  ["is_latch_blocked", "isLatchBlocked"],
  ["stops_first", "stopsFirst"],
  ["clears_error", "clearsError"],
  ["clears_performance", "clearsPerformance"],
] as const;
/** The groups of the commands' scenarios, by their number. */
const GROUPS: Readonly<Record<number, string>> = {
  1: "run: how a command is admitted",
  2: "pause, stop and reset_stop",
  3: "start, resume and clear, on the stand-ins",
  4: "enable, disable, recover_control, reconnect_cameras, model, recording and the refusals of home",
  5: "Watchdog and PeriodicThread",
};

/** What a difference shows of a value. */
function shown(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);

  return Object.is(value, -0) ? "-0" : text.length > 160 ? `${text.slice(0, 160)}...` : text;
}

function isDictionary(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Adds to ``found`` every place where ``actual`` differs from PEAR's ``expected``: not the same double, not the
 * same keys in the same order, not the same number of items (as console.test.ts compares). */
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

/** PEAR's record of ``part`` of ``step`` as the replay is compared with it: all of it, but `is_daemon` of what a
 * step `periodic` returned (see the head of this file), which must be true in the record. */
function expectedOf(step: CoreStep, part: keyof StepMade, path: string, found: string[]): unknown {
  if (part !== "returned" || step.script.op !== "periodic" || !isDictionary(step.returned)) {
    return step[part];
  }
  if (step.returned["is_daemon"] !== true) {
    found.push(`${path}: PEAR's record does not say that the thread is a daemon`);
  }

  return Object.fromEntries(Object.entries(step.returned).filter(([key]) => key !== "is_daemon"));
}

/** What a replay of a scenario made, and where it differs from PEAR's record. */
interface Replay {
  steps: StepMade[];
  differences: string[];
}

/** Replays ``scenario`` on a new console of the port, with the port's commands, and compares every part of every
 * step. */
async function replay(scenario: CommandsScenario): Promise<Replay> {
  const stage = new CommandsStage(fixture.meta, scenario);
  const differences: string[] = [];
  const steps: StepMade[] = [];
  let joinS = fixture.meta.constants["console"]?.["WORKER_JOIN_S"] as number;
  try {
    differencesOf(stage.fields(), scenario.initial, "initial", differences);

    for (const [index, step] of scenario.steps.entries()) {
      const script = step.script;
      const path = `steps[${index}] (${script.op === "command" ? `command ${String(script["name"])}` : script.op})`;
      if (script.op === "set" && Object.hasOwn(script, "worker_join_s")) {
        joinS = script["worker_join_s"] as number;
      }
      const waitedBefore = stage.sleeps.length;
      const made = await stage.step(script);
      steps.push(made);
      for (const part of PARTS) {
        differencesOf(made[part], expectedOf(step, part, `${path}.${part}`, differences), `${path}.${part}`, differences);
      }
      // the time limit of a join: of the limit in force, once at most, and once where PEAR's join ran out
      const waited = stage.sleeps.slice(waitedBefore);
      const ranOut = step.raised !== null && step.raised.message === STILL_STOPPING;
      if (waited.length > 1 || waited.some((seconds) => !Object.is(seconds, joinS)) || (ranOut && waited.length !== 1)) {
        differences.push(`${path}: the time limits waited on are ${shown(waited)}, the limit in force ${joinS} s`);
      }
    }
    differencesOf(stage.drawn, scenario.uuids.length, "the UUIDs drawn", differences);
  } finally {
    stage.dispose();
  }

  return { steps, differences };
}

describe("PEAR's Commands, Watchdog and PeriodicThread, replayed on the port", () => {
  test("the fixture holds the scenarios this test was written for", () => {
    expect(fixture.scenarios.map((scenario) => `${scenario.group} ${scenario.name}`)).toEqual([
      "1 run_unknown_command",
      "1 run_data_none",
      "1 run_while_an_operation_runs",
      "1 run_latch_blocked",
      "1 run_clears",
      "2 pause_and_stop",
      "2 stop_while_an_operation_ends_by_it",
      "2 stop_robot_stop_raises",
      "2 reset_stop",
      "2 reset_stop_while_an_operation_runs",
      "3 start_refusals_on_stand_ins",
      "3 start_resume_clear_on_stand_ins",
      "3 start_attach_fails_on_stand_ins",
      "3 resume_refusals_on_stand_ins",
      "3 clear_stops_the_operation_on_stand_ins",
      "3 clear_robot_off_does_not_settle_on_stand_ins",
      "3 clear_old_operation_still_stopping_on_stand_ins",
      "4 enable_and_disable",
      "4 enable_refused_by_the_cameras",
      "4 disable_cleanup_fails",
      "4 recover_control",
      "4 reconnect_cameras",
      "4 model_and_recording",
      "4 home_refusals",
      "5 watchdog_stopping_to_idle",
      "5 watchdog_fault",
      "5 watchdog_recording_failed",
      "5 watchdog_camera_unavailable",
      "5 watchdog_lost_browser",
      "5 periodic_thread_and_a_check_that_raises",
    ]);
    expect(fixture.scenarios.every((scenario) => scenario.rig === "stand_ins")).toBe(true);
  });

  test("the constants are PEAR's, the commands' table with its six flags in PEAR's order", () => {
    const constants = fixture.meta.constants;
    const stage = new CommandsStage(fixture.meta, fixture.scenarios[0]!);
    stage.dispose();
    const table: Record<string, Record<string, boolean>> = {};
    for (const [name, command] of stage.commands.table) {
      table[name] = Object.fromEntries(COMMAND_FLAGS.map(([flag, own]) => [flag, command[own]]));
    }
    // the console's, by the names the record holds: one the port has not is undefined here
    const ofConsole: Record<string, unknown> = {};
    for (const name of Object.keys(constants["console"] ?? {})) {
      ofConsole[name] = (Console as unknown as Record<string, unknown>)[name];
    }
    const differences: string[] = [];
    differencesOf(ofConsole, constants["console"], "console", differences);
    differencesOf(
      {
        MAX_INSTRUCTION_CHARS: Commands.MAX_INSTRUCTION_CHARS,
        HOME_STAGE_PHASES: { ...Commands.HOME_STAGE_PHASES },
        table,
        RECORD_URL, // (of task_run.py; commands.py makes the URL of a task's image with it)
      },
      constants["commands"],
      "commands",
      differences,
    );
    differencesOf(
      { PERIOD_S: Watchdog.PERIOD_S, THREAD_NAME: Watchdog.THREAD_NAME, PHASES_WITHOUT_CAMERAS: [...Watchdog.PHASES_WITHOUT_CAMERAS] },
      constants["watchdog"],
      "watchdog",
      differences,
    );
    differencesOf(
      { MIN_WAIT_S: PeriodicThread.MIN_WAIT_S, JOIN_S: PeriodicThread.JOIN_S },
      constants["periodic_thread"],
      "periodic_thread",
      differences,
    );
    differencesOf([...STOPPED_STATUSES], constants["stopped_statuses"], "stopped_statuses", differences);
    // of PEAR's SegmentStatus the port holds the one member the watchdog reads
    differencesOf(SEGMENT_FAILED, constants["segment_status"]?.["FAILED"], "segment_status.FAILED", differences);

    expect(differences).toEqual([]);
  });

  for (const [group, title] of Object.entries(GROUPS)) {
    describe(`group ${group}: ${title}`, () => {
      for (const scenario of fixture.scenarios.filter((one) => one.group === Number(group))) {
        test(`${scenario.name}: ${scenario.steps.length} steps, every part of each`, async () => {
          const { differences } = await replay(scenario);

          expect(differences.slice(0, 12)).toEqual([]);
        });
      }
    });
  }

  test("the replays make as many steps, commands, events, calls and operations as the fixture counts", async () => {
    const counts = {
      scenarios: 0,
      steps: 0,
      commands: 0,
      commands_that_raised: 0,
      events: 0,
      events_saved: 0,
      calls_of_stand_ins: 0,
      operations: 0,
    };
    for (const scenario of fixture.scenarios) {
      const { steps } = await replay(scenario);
      counts.scenarios += 1;
      for (const [index, step] of steps.entries()) {
        const isCommand = scenario.steps[index]!.script.op === "command";
        counts.steps += 1;
        counts.commands += isCommand ? 1 : 0;
        counts.commands_that_raised += isCommand && step.raised !== null ? 1 : 0;
        counts.events += step.events.length;
        counts.events_saved += step.events.filter((event) => event["saved"] === true).length;
        counts.calls_of_stand_ins += THREADS.reduce((sum, thread) => sum + step.calls[thread].length, 0);
        counts.operations += step.operations.length;
      }
    }

    expect(counts).toEqual(fixture.meta.counts);
    expect(counts.steps).toBe(258);
  });
});
