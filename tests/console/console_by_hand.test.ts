// Written by hand: this test compares with nothing of PEAR's. Its expectations were typed from a reading of
// pear/deploy/station/gui/console/console.py, and its robot, its records, its recordings and the rest of what a
// console is made with are stand-ins of its own. It holds two paths of Console: an operation that fails is stopped
// and shown as _operate does it (the robot's stop, the event `error`, the phase, the end of the recording), and
// launch refuses a second operation while one runs. And two things of emit that no record of PEAR's holds yet
// (console.test.ts replays the records): the event keeps a copy of the data it was given (data = dict(data)), and
// data without an attempt is taken as the running turn's when that turn's attempt is None
// (data.get("attempt") == active_turn["attempt"]).

import { describe, expect, it } from "vitest";

import {
  Console,
  Phase,
  type ActiveTurn,
  type ConsoleOptions,
  type ConsoleRecordings,
  type ConsoleRecords,
  type ConsoleRobot,
} from "../../src/console/index";
import { RuntimeError, ValueError } from "../../src/python/errors";
import type { BaseRobot } from "../../src/station/robot";
import { RobotStatus } from "../../src/station/schemas";

/** Returns a console over stand-ins, and the list its stand-ins write what is called of them to. */
function makeConsole(): { station: Console; calls: string[] } {
  const calls: string[] = [];
  const robot: ConsoleRobot = {
    sessionId: "session-1",
    stop: () => {
      calls.push("robot.stop");
    },
    status: () => ({ status: RobotStatus.READY }),
    close: () => undefined,
    waitSettled: () => undefined,
    checkFault: () => undefined,
  };
  const recordings: ConsoleRecordings = {
    stop: (reason) => {
      calls.push(`recordings.stop:${reason}`);
    },
    snapshot: () => null,
    onEvent: (kind) => {
      calls.push(`recordings.onEvent:${kind}`);
    },
    close: () => undefined,
  };
  const records: ConsoleRecords = {
    writeJson: () => undefined,
    readFile: () => new Uint8Array(),
    writeRootJson: (name) => {
      calls.push(`records.writeRootJson:${name}`);
    },
    appendEvent: () => {
      calls.push("records.appendEvent");
    },
  };
  const station = new Console({
    modelsConfig: { defaultModel: "model", models: {} } as unknown as ConsoleOptions["modelsConfig"],
    robot,
    agentRobot: {} as ConsoleOptions["agentRobot"],
    cameraFeed: {} as ConsoleOptions["cameraFeed"],
    robotProfile: () => ({}),
    records,
    uploads: {},
    recordings,
    annotations: {},
    preview: { status: () => ({}), close: () => undefined },
    commands: () => ({}),
    watchdog: () => ({ close: () => undefined }),
    wallClock: () => 1000.5,
    clock: () => 7.25,
    log: (logger, level, message) => {
      calls.push(`log:${logger}:${level}:${message}`);
    },
  });

  return { station, calls };
}

describe("Console, by hand", () => {
  it("is given the station's robot without a cast", () => {
    // checked by the type check: the assignment fails to compile if BaseRobot lacks a member of ConsoleRobot
    const fits: BaseRobot extends ConsoleRobot ? true : false = true;

    expect(fits).toBe(true);
  });

  it("stops the robot and shows the failure of an operation", async () => {
    const { station, calls } = makeConsole();

    station.launch(
      () => {
        calls.push("operation");
        throw new RuntimeError("boom");
      },
      { isRecorded: true },
    );
    // the operation is started, and has not run yet
    expect(station.isBusy).toBe(true);
    expect(calls).toEqual([]);

    await station.worker!.ended;

    expect(station.isBusy).toBe(false);
    expect(calls).toEqual([
      "operation",
      "log:console:error:An operation of the console failed",
      "robot.stop",
      "recordings.onEvent:error",
      "recordings.stop:RuntimeError: boom",
    ]);
    expect(station.error).toBe("RuntimeError: boom");
    expect(station.phase).toBe(Phase.STOPPING);
    expect(station.performance).toBeNull();
    expect(station.homeReview.plan).toBeNull();
    expect(station.events).toEqual([
      { id: 1, type: "error", data: { message: "RuntimeError: boom" }, time: 1000.5, monotonic_s: 7.25, task_id: null },
    ]);
    expect(Object.keys(station.events[0]!)).toEqual(["id", "type", "data", "time", "monotonic_s", "task_id"]);
  });

  it("refuses a second operation while one runs", async () => {
    const { station } = makeConsole();
    let finish: () => void = () => undefined;
    const started = new Promise<void>((resolveStarted) => {
      station.launch(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
            resolveStarted();
          }),
      );
    });

    // before the operation has begun, and while it runs
    expect(() => station.launch(() => undefined)).toThrow(ValueError);
    await started;
    expect(() => station.launch(() => undefined)).toThrow("Wait for the current operation to finish stopping.");

    finish();
    await station.worker!.ended;
    expect(station.isBusy).toBe(false);

    // once it has ended, the next one is taken
    station.launch(() => undefined);
    expect(station.isBusy).toBe(true);
    await station.worker!.ended;
    expect(station.isBusy).toBe(false);
  });

  it("gives an event of the running turn the turn's fields, and keeps a copy of the data it was given", () => {
    const { station } = makeConsole();
    station.taskRun.activeTurn = { attempt: "a1", turn_number: 2 } as unknown as ActiveTurn;

    const ofTurn = station.emit("note", { attempt: "a1", message: "of the turn" }, { isSaved: false });
    const ofEarlier = station.emit("note", { attempt: "a0", message: "of an earlier attempt" }, { isSaved: false });
    const without = station.emit("note", { message: "no attempt" }, { isSaved: false });

    expect(ofTurn.data).toEqual({ attempt: "a1", turn_number: 2, message: "of the turn" });
    expect(Object.keys(ofTurn.data)).toEqual(["attempt", "turn_number", "message"]);
    expect(ofEarlier.data).toEqual({ attempt: "a0", message: "of an earlier attempt" });
    expect(without.data).toEqual({ message: "no attempt" });

    // what the caller does to its data afterwards does not reach the event
    const given: Record<string, unknown> = { message: "as it was given" };
    const event = station.emit("note", given, { isSaved: false });
    given["message"] = "changed afterwards";
    given["more"] = 1;

    expect(event.data).not.toBe(given);
    expect(event.data).toEqual({ message: "as it was given" });
    expect(station.events.at(-1)!.data).toEqual({ message: "as it was given" });
  });

  it("takes data without an attempt as the turn's own when the turn's attempt is None", () => {
    // None == None in PEAR's comparison. PEAR's task run gives every turn an attempt id, so only a stand-in's
    // turn shows this
    const { station } = makeConsole();
    station.taskRun.activeTurn = { attempt: null, turn_number: 1 } as unknown as ActiveTurn;

    const without = station.emit("note", { message: "no attempt" }, { isSaved: false });
    const withNone = station.emit("note", { attempt: null }, { isSaved: false });
    const withOther = station.emit("note", { attempt: "a1" }, { isSaved: false });

    expect(without.data).toEqual({ attempt: null, turn_number: 1, message: "no attempt" });
    expect(withNone.data).toEqual({ attempt: null, turn_number: 1 });
    expect(withOther.data).toEqual({ attempt: "a1" });
  });
});
