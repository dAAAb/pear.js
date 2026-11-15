// Written by hand: this test compares with nothing of PEAR's. Its expectations were typed from a reading of
// pear/deploy/station/gui/console/commands.py, and its robot, its records, its recordings and the rest of what a
// console is made with are stand-ins of its own. It holds three refusals of Commands.run in PEAR's words (an
// unknown command, a command while an operation runs, a latch-blocked command while STOP MOTION is latched) and
// that STOP has aborted the cancellation and called the robot's stop when run returns its promise.
//
// And it holds what no record of PEAR's reaches yet (commands.test.ts replays the records, in which the robot's
// Home is never called and no home_confirm is given): a Home that is admitted, from the task's end through the
// stages' phases, the plan's review and its file to the report's file, the Home status and the notice
// (_return_home, _report_home_progress, _review_home); the answer home_confirm passes on, which is true for
// `confirm: true` alone (_confirm_home); and the arm and the grippers' choice of a robot whose class has them
// (_home). And four lines the records run without showing what they do: a task whose images cannot be attached
// leaves no folder (the record lists files, and the folder is empty); a draft image that cannot be removed does
// not hold the task back (no record has one); clear forgets the count of steps (it is 0 in every record, where
// no turn runs); a recovery clears a failure shown while it ran (the command has cleared the earlier one). And one
// line no record can show: start counts a new task's steps and turns from the beginning (in every record the
// counts are 0 already, on a new console or after a clear; after `disable` or a Home they are the last task's).

import { describe, expect, it } from "vitest";

import { ModelEvent } from "../../src/agent/clients/schemas";
import {
  Commands,
  Console,
  Phase,
  TaskEventKind,
  type CommandsConsole,
  type CommandsPreview,
  type CommandsRecordings,
  type CommandsRecords,
  type CommandsRobot,
  type CommandsRobotClass,
  type CommandsUploads,
  type ConsoleOptions,
} from "../../src/console/index";
import { recordUrl } from "../../src/console/task_run";
import { RuntimeError, ValueError } from "../../src/python/errors";
import { HomeStage } from "../../src/station/motion/homing";
import type { BaseRobot } from "../../src/station/robot";
import { RobotStatus, type HomePlan, type HomeReport } from "../../src/station/schemas";

/** What the stand-in robot's class gives: one action format, no choice of a Home arm. */
const ROBOT_CLASS = { ACTION_FORMATS: { only: {} }, HOME_ARM_CHOICES: [], HOME_CAN_KEEP_GRIPPERS: false };
/** A Home plan and a Home report of the stand-in robot, and the id the first plan of a console is reviewed under
 * (the console's first UUID without its dashes). */
const PLAN: HomePlan = { operation_seconds_estimate: 4, joints: ["shoulder_lift", "elbow_flex"] };
const REPORT = { plan: PLAN, before: {}, phases: [], after: {}, results: { reached: true } } as unknown as HomeReport;
const PLAN_ID = "00000000000040008000000000000001";
/** The id of the first task of a console that drew no UUID before it. */
const TASK_ID = PLAN_ID;

/** The class of the stand-in model's client: it takes a task's images. */
class StandInClient {
  static supportsReferenceImages(): boolean {
    return true;
  }
}

/** What a test gives in the place of a stand-in's own. */
interface Given {
  /** The robot's Home; by default the robot has none. */
  home?: CommandsRobot["home"];
  /** The constants of the robot's class; by default one action format and no choices. */
  robotClass?: CommandsRobotClass;
  /** The robot's recovery; by default it does nothing. */
  recover?: CommandsRobot["recover"];
  /** The robot's status; by default READY. */
  status?: () => RobotStatus;
  /** The operator's images; by default none is attached. */
  uploads?: CommandsUploads;
}

/** What the stand-ins of one console kept. */
interface Made {
  station: Console;
  commands: Commands;
  /** What was called of the stand-ins. */
  calls: string[];
  /** Every phase the console was given, in order. */
  phases: string[];
  /** Every file written under the console's root: its name and its value. */
  files: [string, unknown][];
}

/** Returns a console over stand-ins with its commands. */
function makeCommands(given: Given = {}): Made {
  const calls: string[] = [];
  const phases: string[] = [];
  const files: [string, unknown][] = [];
  let drawn = 0;
  let ns = 1_700_000_000_000_000_000n;
  const uuid = (): string => `00000000-0000-4000-8000-${String((drawn += 1)).padStart(12, "0")}`;
  const robot: CommandsRobot = {
    sessionId: "session-1",
    stop: () => {
      calls.push("robot.stop");
    },
    status: () => ({ status: given.status?.() ?? RobotStatus.READY }),
    close: () => undefined,
    waitSettled: () => undefined,
    checkFault: () => undefined,
    open: () => undefined,
    waitStationary: () => undefined,
    recover: given.recover ?? (() => undefined),
    home:
      given.home ??
      (() => {
        throw new Error("the stand-in robot has no Home");
      }),
  };
  const recordings: CommandsRecordings = {
    isEnabled: true,
    start: () => {
      calls.push("recordings.start");
    },
    stop: (reason) => {
      calls.push(`recordings.stop:${reason}`);
    },
    snapshot: () => null,
    onEvent: (kind) => {
      calls.push(`recordings.onEvent:${kind}`);
    },
    close: () => undefined,
  };
  const records: CommandsRecords = {
    writeJson: (taskId, name) => {
      calls.push(`records.writeJson:${taskId}:${name}`);
    },
    readFile: () => new Uint8Array(),
    writeRootJson: (name, value) => {
      files.push([name, value]);
    },
    appendEvent: () => undefined,
    createTask: (taskId) => {
      calls.push(`records.createTask:${taskId}`);
    },
    removeTask: (taskId) => {
      calls.push(`records.removeTask:${taskId}`);
    },
  };
  const preview: CommandsPreview = {
    status: () => ({}),
    close: () => undefined,
    isEncoding: true,
    errorText: null,
    reconnect: () => undefined,
  };
  const made: { commands?: Commands } = {};
  const station = new Console({
    modelsConfig: {
      defaultModel: "model",
      models: { model: { label: "Model", clientClass: StandInClient } },
    } as unknown as ConsoleOptions["modelsConfig"],
    robot,
    agentRobot: {} as ConsoleOptions["agentRobot"],
    cameraFeed: {} as ConsoleOptions["cameraFeed"],
    robotProfile: () => ({}),
    records,
    uploads: given.uploads ?? { attach: () => [], delete: () => undefined },
    recordings,
    annotations: { cleanTags: () => [], update: () => undefined },
    preview,
    // the console's parts are typed by console.ts, which knows only what console.py uses of them: the one cast
    commands: (console) =>
      (made.commands = new Commands(console as CommandsConsole, {
        robotClass: given.robotClass ?? ROBOT_CLASS,
        wallClock: () => 1000.5,
        timeNs: () => (ns += 1n),
        uuid,
        log: (logger, level, message) => {
          calls.push(`log:${logger}:${level}:${message}`);
        },
      })),
    watchdog: () => ({ close: () => undefined }),
    wallClock: () => 1000.5,
    clock: () => 7.25,
    uuid,
  });
  const show = station.setPhase.bind(station);
  station.setPhase = (phase) => {
    phases.push(phase);
    show(phase);
  };

  return { station, commands: made.commands!, calls, phases, files };
}

/** Lets the console's worker go on until ``isReached``, for a bounded number of turns of the event loop. */
async function until(isReached: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !isReached(); turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(isReached()).toBe(true);
}

/** Returns what ``promise`` rejects with; fails when it resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the promise resolved");
}

describe("Commands, by hand", () => {
  it("is given the station's robot without a cast, and a console only with one", () => {
    // checked by the type check: the assignment fails to compile if BaseRobot lacks a member of CommandsRobot
    const fits: BaseRobot extends CommandsRobot ? true : false = true;
    expect(fits).toBe(true);

    const { station } = makeCommands();
    // @ts-expect-error a Console's parts are typed by console.ts: without the cast it is no CommandsConsole
    const uncast = new Commands(station, { robotClass: ROBOT_CLASS });
    expect(uncast.table.size).toBe(14);
  });

  it("has PEAR's commands in PEAR's order", () => {
    const { commands } = makeCommands();

    expect([...commands.table.keys()]).toEqual([
      "pause",
      "stop",
      "home_confirm",
      "reset_stop",
      "reconnect_cameras",
      "enable",
      "recover_control",
      "start",
      "resume",
      "clear",
      "disable",
      "home",
      "model",
      "recording",
    ]);
  });

  it("refuses an unknown command", async () => {
    const { commands } = makeCommands();

    const error = await rejectionOf(commands.run("fly", null));

    expect(error).toBeInstanceOf(ValueError);
    expect((error as Error).message).toBe("Unknown command");
  });

  it("refuses a command while an operation runs", async () => {
    const { station, commands } = makeCommands();
    let end: () => void = () => undefined;
    station.launch(
      () =>
        new Promise<void>((resolve) => {
          end = resolve;
        }),
    );
    station.error = "an earlier failure";

    const error = await rejectionOf(commands.run("model", { model: "model" }));

    expect(error).toBeInstanceOf(ValueError);
    expect((error as Error).message).toBe("Wait for the current operation or pause it first");
    expect(station.error).toBe("an earlier failure"); // a command that is refused clears nothing
    end();
    await station.worker!.ended;
    expect(station.isBusy).toBe(false);
  });

  it("has stopped the robot when STOP returns its promise, and refuses a latch-blocked command after it", async () => {
    const { station, commands, calls } = makeCommands();
    const cancellation = station.cancellation;

    const stopping = commands.run("stop", {});

    expect(cancellation.signal.aborted).toBe(true);
    expect(calls).toEqual(["robot.stop"]);
    expect(await stopping).toEqual({ stop_requested: true, stop_request_seconds: 0 });
    expect(station.isStopLatched).toBe(true);
    expect(calls).toContain("recordings.stop:STOP MOTION activated");

    const error = await rejectionOf(commands.run("enable", {}));

    expect(error).toBeInstanceOf(ValueError);
    expect((error as Error).message).toBe("Reset STOP MOTION before continuing");

    // the reset is not latch-blocked: the stand-in robot is READY, so the latch is released
    expect(await commands.run("reset_stop", {})).toEqual({ reset: true });
    expect(station.isStopLatched).toBe(false);
  });

  it("returns the arms Home once the operator approves the plan", async () => {
    const seen: { keys?: string[]; atStart?: unknown; approved?: unknown } = {};
    const { station, commands, phases, files } = makeCommands({
      home: async (options) => {
        seen.keys = Object.keys(options);
        // what the console shows when the robot's Home is called: the task is ended, the Home is being checked
        seen.atStart = { status: station.homeStatus, phase: station.phase, task: station.taskRun.task };
        await options.reportProgress({ stage: HomeStage.CHECKING, joints: 6 });
        seen.approved = await options.approvePlan(PLAN);
        await options.reportProgress({ stage: HomeStage.HOMING });

        return REPORT;
      },
    });
    station.taskRun.task = { id: "task-1" } as unknown as typeof station.taskRun.task;

    expect(await commands.run("home", {})).toEqual({ accepted: true });
    await until(() => station.homeReview.plan !== null);

    // the plan waits for the operator: nothing has moved, and the plan is kept as a file
    expect(station.phase).toBe(Phase.CONFIRM_HOME);
    expect(station.homeReview.plan).toEqual({ ...PLAN, plan_id: PLAN_ID });
    expect(station.homeStatus).toEqual({ stage: "checking", joints: 6, status: "running" });
    expect(Object.keys(station.homeStatus!)).toEqual(["stage", "joints", "status"]);
    expect(files).toEqual([["home-plan-1700000000000000001.json", { ...PLAN, plan_id: PLAN_ID }]]);
    expect(seen).toEqual({
      keys: ["cancellation", "reportProgress", "approvePlan"],
      atStart: { status: { stage: "checking", status: "running" }, phase: Phase.CHECKING_HOME, task: null },
    });

    // an answer to another plan is refused, and the review goes on
    const refused = await rejectionOf(commands.run("home_confirm", { plan_id: "another", confirm: true }));
    expect(refused).toBeInstanceOf(ValueError);
    expect((refused as Error).message).toBe("This home plan is no longer current");
    expect(station.isBusy).toBe(true);

    expect(await commands.run("home_confirm", { plan_id: PLAN_ID, confirm: true })).toEqual({ accepted: true });
    await station.worker!.ended;

    expect(seen.approved).toBe(true);
    expect(phases).toEqual([
      Phase.CHECKING_HOME,
      Phase.CHECKING_DIRECT_HOME,
      Phase.CONFIRM_HOME,
      Phase.HOMING,
      Phase.HOME_COMPLETE,
    ]);
    expect(files).toEqual([
      ["home-plan-1700000000000000001.json", { ...PLAN, plan_id: PLAN_ID }],
      ["home-1700000000000000002.json", REPORT],
    ]);
    expect(station.homeStatus).toEqual({ stage: "completed", status: "completed", results: { reached: true } });
    expect(Object.keys(station.homeStatus!)).toEqual(["stage", "status", "results"]);
    expect(station.taskRun.task).toBeNull();
    expect(station.homeReview.plan).toBeNull();
    expect(station.error).toBeNull();
    expect(station.isBusy).toBe(false);
    expect(station.events.map((event) => [event.type, event.data])).toEqual([
      [TaskEventKind.TASK_END, { message: "Task ended for home." }],
      [ModelEvent.NOTICE, { message: "Checking direct Home", home: { stage: "checking", joints: 6, status: "running" } }],
      [ModelEvent.NOTICE, { message: "Homing", home: { stage: "homing", status: "running" } }],
      [ModelEvent.NOTICE, { message: "Grippers opened and Home reached. Start a new task when ready." }],
    ]);
  });

  it("answers the review with false for anything but confirm: true", async () => {
    const answers: unknown[] = [];
    for (const confirm of [false, "yes", 1, undefined]) {
      const { station, commands } = makeCommands({
        home: async (options) => {
          answers.push(await options.approvePlan(PLAN));
          throw new RuntimeError("the stand-in robot does not go Home without an approval");
        },
      });
      await commands.run("home", {});
      await until(() => station.homeReview.plan !== null);

      const data = confirm === undefined ? { plan_id: PLAN_ID } : { plan_id: PLAN_ID, confirm };
      expect(await commands.run("home_confirm", data)).toEqual({ accepted: true });
      await station.worker!.ended;

      // what the stand-in robot threw is shown as any failed operation is
      expect(station.error).toBe("RuntimeError: the stand-in robot does not go Home without an approval");
      expect(station.phase).toBe(Phase.STOPPING);
      expect(station.homeReview.plan).toBeNull();
    }

    expect(answers).toEqual([false, false, false, false]);
  });

  it("gives the robot's Home the arm and the grippers' choice of a robot whose class has them", async () => {
    const given: Record<string, unknown>[] = [];
    const robotClass = { ACTION_FORMATS: { only: {} }, HOME_ARM_CHOICES: ["left", "right"], HOME_CAN_KEEP_GRIPPERS: true };
    const home: CommandsRobot["home"] = (options) => {
      given.push({ keys: Object.keys(options), side: options.side, opensGrippers: options.opensGrippers });

      return REPORT;
    };

    // no choice named: the first arm, and the grippers are opened
    const first = makeCommands({ home, robotClass });
    await first.commands.run("home", {});
    await first.station.worker!.ended;
    // the other arm, and the grippers kept
    const second = makeCommands({ home, robotClass });
    await second.commands.run("home", { side: "right", open_grippers: false });
    await second.station.worker!.ended;

    const keys = ["cancellation", "reportProgress", "approvePlan", "side", "opensGrippers"];
    expect(given).toEqual([
      { keys, side: "left", opensGrippers: true },
      { keys, side: "right", opensGrippers: false },
    ]);
    expect(first.station.events.at(-1)!.data).toEqual({
      message: "Grippers opened and Home reached. Start a new task when ready.",
    });
    expect(second.station.events.at(-1)!.data).toEqual({
      message: "Arms reached Home; grippers unchanged. Start a new task when ready.",
    });
    expect(second.phases).toEqual([Phase.CHECKING_HOME, Phase.HOME_COMPLETE]);

    // an arm the robot has not, and a choice that is no boolean: refused before anything is launched
    const third = makeCommands({ home, robotClass });
    const side = await rejectionOf(third.commands.run("home", { side: "middle" }));
    expect(side).toBeInstanceOf(ValueError);
    expect((side as Error).message).toBe("Invalid home side");
    const grippers = await rejectionOf(third.commands.run("home", { open_grippers: "no" }));
    expect(grippers).toBeInstanceOf(ValueError);
    expect((grippers as Error).message).toBe("Invalid home gripper choice");
    expect(third.station.isBusy).toBe(false);
    expect(given).toHaveLength(2);
  });

  it("starts a task although a draft image cannot be removed", async () => {
    const made = makeCommands({
      uploads: {
        attach: (uploadIds) =>
          (uploadIds as string[]).map((id) => ({ id, name: `${id}.png`, file: `${id}.jpg`, width: 4, height: 3 })),
        delete: (uploadId) => {
          made.calls.push(`uploads.delete:${uploadId}`);
          if (uploadId === "u1") {
            throw new ValueError("Unknown upload");
          }
        },
      },
    });
    const { station, commands, calls } = made;
    station.taskRun.run = () => Promise.resolve(); // no turn is run here

    const answer = await commands.run("start", { instruction: "  Stack the cubes \n", image_ids: ["u1", "u2"] });
    await station.worker!.ended;

    expect(answer).toEqual({ accepted: true });
    expect(station.taskRun.task).toEqual({
      id: TASK_ID,
      instruction: "Stack the cubes",
      created: 1000.5,
      model: "model",
      model_label: "Model",
      images: [
        { id: "u1", name: "u1.png", file: "u1.jpg", width: 4, height: 3, url: recordUrl(TASK_ID, "u1.jpg") },
        { id: "u2", name: "u2.png", file: "u2.jpg", width: 4, height: 3, url: recordUrl(TASK_ID, "u2.jpg") },
      ],
    });
    expect(Object.keys(station.taskRun.task!)).toEqual(["id", "instruction", "created", "model", "model_label", "images"]);
    // the draft that stays is logged, the next one is still removed, and the task's turns are started
    expect(calls).toEqual([
      `records.createTask:${TASK_ID}`,
      `records.writeJson:${TASK_ID}:task.json`,
      "uploads.delete:u1",
      "log:commands:warning:Draft image u1 was not removed: Unknown upload",
      "uploads.delete:u2",
      "recordings.onEvent:task",
      "recordings.start",
      "recordings.stop:Task paused",
    ]);
  });

  it("counts a new task's steps and turns from the beginning, whatever the last task left", async () => {
    // `disable` and a Home end a task without `clear`: the task run then still holds the last task's counts
    const { station, commands } = makeCommands();
    const taskRun = station.taskRun;
    taskRun.totalSteps = 5;
    taskRun.turnNumber = 7;
    taskRun.activeAttemptId = "attempt-7";
    taskRun.activeTurn = { attempt: "attempt-7", turn_number: 7 } as unknown as typeof taskRun.activeTurn;
    taskRun.run = () => Promise.resolve(); // no turn is run here

    expect(await commands.run("start", { instruction: "Stack the cubes" })).toEqual({ accepted: true });
    await station.worker!.ended;

    expect(taskRun.totalSteps).toBe(0);
    expect(taskRun.turnNumber).toBe(0);
    expect(taskRun.activeAttemptId).toBeNull();
    expect(taskRun.activeTurn).toBeNull();
    // the task's event is not of the last task's turn: it carries none of that turn's fields
    expect(Object.keys(station.events[0]!.data)).toEqual(["id", "instruction", "created", "model", "model_label", "images"]);
  });

  it("leaves nothing of a task whose images cannot be attached", async () => {
    const { station, commands, calls } = makeCommands({
      uploads: {
        attach: () => {
          throw new ValueError("Unknown upload");
        },
        delete: () => undefined,
      },
    });

    const error = await rejectionOf(commands.run("start", { instruction: "Stack the cubes" }));

    expect(error).toBeInstanceOf(ValueError);
    expect((error as Error).message).toBe("Unknown upload");
    expect(calls).toEqual([`records.createTask:${TASK_ID}`, `records.removeTask:${TASK_ID}`]);
    expect(station.taskRun.task).toBeNull();
    expect(station.isBusy).toBe(false);
  });

  it("forgets the task's count of steps and its turn at clear", async () => {
    const { station, commands } = makeCommands();
    const taskRun = station.taskRun;
    taskRun.task = { id: "task-1" } as unknown as typeof taskRun.task;
    taskRun.totalSteps = 7;
    taskRun.activeAttemptId = "attempt-3";
    taskRun.activeTurn = { attempt: "attempt-3", turn_number: 3 } as unknown as typeof taskRun.activeTurn;

    expect(await commands.run("clear", {})).toEqual({ accepted: true });
    await station.worker!.ended;

    expect(taskRun.task).toBeNull();
    expect(taskRun.totalSteps).toBe(0);
    expect(taskRun.activeAttemptId).toBeNull();
    expect(taskRun.activeTurn).toBeNull();
    expect(station.phase).toBe(Phase.HOLDING); // the stand-in robot is READY, and nothing is latched
    // the event is not of the turn (its data names no attempt), so it carries none of the turn's fields
    expect(station.events.map((event) => [event.type, event.data, event.task_id])).toEqual([
      [TaskEventKind.TASK_END, { message: "Task cleared; history saved." }, "task-1"],
    ]);
  });

  it("clears a failure that was shown during a recovery once the robot holds again", async () => {
    let status: RobotStatus = RobotStatus.FAULT;
    let finish: (() => void) | null = null;
    const { station, commands } = makeCommands({
      status: () => status,
      // a recovery that lasts until the test ends it
      recover: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    station.error = "an earlier failure";

    expect(await commands.run("recover_control", {})).toEqual({ accepted: true });
    await until(() => finish !== null);
    expect(station.error).toBeNull(); // the command cleared the earlier one
    expect(station.phase).toBe(Phase.RECOVERING_CONTROL);
    expect(station.isBusy).toBe(true);

    station.error = "Robot fault"; // what the watchdog shows of the fault while the recovery runs
    status = RobotStatus.READY;
    finish!();
    await station.worker!.ended;

    expect(station.error).toBeNull();
    expect(station.phase).toBe(Phase.HOLDING);
    expect(station.events.at(-1)!.data).toEqual({
      message: "Control recovered at the current pose. Motors remain enabled. Choose Resume or Home.",
    });
  });
});
