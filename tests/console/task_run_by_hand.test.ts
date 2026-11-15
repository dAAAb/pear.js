// Written by hand: this test compares with nothing of PEAR's. Its expectations were typed from a reading of
// pear/deploy/station/gui/console/task_run.py, and its console, its records and its loop are stand-ins of its own.
// It holds one path of TaskRun.run: five actions out of reach give five notices with PEAR's text, and the sixth
// ends the run.

import { describe, expect, it } from "vitest";

import { RuntimeError } from "../../src/python/errors";
import { TaskRun, type TaskConsole, type TaskRecords } from "../../src/console/index";

interface Emitted {
  kind: string;
  data: Record<string, unknown>;
  options: { isSaved?: boolean } | undefined;
}

/** An action that offline IK refused before any motion, as the loop returns it. */
const UNREACHABLE = {
  status: "rejected",
  isSettled: true,
  targetReached: false,
  measuredPosition: null,
  trackingError: null,
  measuredState: null,
  gripperOutcome: null,
  error: { code: "UnreachablePoseError", message: "Pose out of reach" },
} as const;

describe("TaskRun.run, by hand", () => {
  it("asks again five times after an action out of reach, and the sixth ends the run", async () => {
    const emitted: Emitted[] = [];
    const written: Array<[string, string, Record<string, unknown>]> = [];
    let taskRun!: TaskRun;

    const console = {
      SETTLE_TIMEOUT_S: 10,
      robot: {
        waitSettled: () => undefined,
        status: () => ({ status: "READY" }),
        checkFault: () => undefined,
      },
      agentRobot: {},
      model: "model",
      actionFormat: { name: "format" },
      modelTimeoutS: 300,
      performance: null,
      events: [],
      newClient: () => {
        throw new Error("no client is made in this test");
      },
      // as PEAR's console: an event of the running turn carries the turn's fields
      emit: (kind: string, data: Record<string, unknown>, options?: { isSaved?: boolean }) => {
        emitted.push({ kind, data: { ...data }, options });
      },
      setPhase: () => undefined,
      robotStatus: () => "READY",
    } as unknown as TaskConsole;
    const records: TaskRecords = {
      writeJson: (taskId, name, value) => {
        written.push([taskId, name, { ...value }]);
      },
      readFile: () => {
        throw new Error("no file is read in this test");
      },
    };

    let uuids = 0;
    let seconds = 1_700_000_000;
    taskRun = new TaskRun(console, records, {
      uuid: () => `aaaaaaa${++uuids}-bbbb-4ccc-8ddd-eeeeeeeeeeee`,
      wallClock: () => seconds++,
    });
    taskRun.task = { id: "task-1", instruction: "Pick up the cube" };

    // the loop's stand-in: every step observes a turn and returns the refused action
    const session = {
      episodeId: "episode-1",
      lastTurn: null as unknown,
      blockedReason: null,
      step(options: { attemptId: string }) {
        this.lastTurn = { attemptId: options.attemptId, modelOutput: null, stationResult: null, isDispatched: false };

        return Promise.resolve(UNREACHABLE);
      },
    };
    taskRun.session = session as never;

    const failure: unknown = await taskRun.run(new AbortController().signal).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(RuntimeError);
    expect((failure as Error).message).toBe("Pose out of reach");
    expect(taskRun.resumePending).toBe(true);
    expect(taskRun.totalSteps).toBe(0);
    expect(taskRun.turnNumber).toBe(6);

    const attempts = [1, 2, 3, 4, 5, 6].map((turn) => `aaaaaaa${turn}bbbb`);
    expect(emitted.map((event) => event.kind)).toEqual([
      ...[1, 2, 3, 4, 5].flatMap(() => ["turn_started", "execution", "notice"]),
      "turn_started",
      "execution",
      "turn_end",
    ]);

    const notices = emitted.filter((event) => event.kind === "notice");
    expect(notices.map((event) => event.data)).toEqual(
      [1, 2, 3, 4, 5].map((retry) => ({
        attempt: attempts[retry - 1],
        retry,
        message: `IK rejected before motion. Requesting a fresh action (${retry}/5).`,
      })),
    );
    for (const notice of notices) {
      expect(Object.keys(notice.data)).toEqual(["attempt", "retry", "message"]);
      expect(notice.options).toBeUndefined();
    }

    const started = emitted.filter((event) => event.kind === "turn_started");
    expect(started.map((event) => event.data)).toEqual(
      attempts.map((attempt, index) => ({
        attempt,
        turn_number: index + 1,
        started_at: 1_700_000_000 + index,
        episode_id: "episode-1",
        phase: "Observing",
      })),
    );
    expect(Object.keys(started[0]!.data)).toEqual(["attempt", "turn_number", "started_at", "episode_id", "phase"]);

    const executions = emitted.filter((event) => event.kind === "execution");
    expect(executions.map((event) => event.data["attempt"])).toEqual(attempts);
    expect(Object.keys(executions[0]!.data)[0]).toBe("attempt");

    // each turn leaves its result, and no output: the stand-in's model never answered
    expect(written.map(([taskId, name]) => [taskId, name])).toEqual(
      attempts.map((attempt) => ["task-1", `${attempt}-result.json`]),
    );
    expect(Object.keys(written[0]![2]).slice(0, 2)).toEqual(["turn_id", "dispatched"]);
    expect(written[0]![2]["turn_id"]).toBe(attempts[0]);
    expect(written[0]![2]["dispatched"]).toBe(false);

    const last = emitted[emitted.length - 1]!;
    expect(last.data).toEqual({ attempt: attempts[5], phase: "Failed", message: "Pose out of reach" });
    expect(Object.keys(last.data)).toEqual(["attempt", "phase", "message"]);
    expect(last.options).toEqual({ isSaved: false });
    expect(taskRun.activeTurn?.phase).toBe("Failed");
  });
});
