// PEAR's console on the page's station (web/src/task_host.ts), running a task on the simulated arm with a stand-in
// model service: the SO-101 of the library over simulated servos, made as the Worker's host makes it for the
// simulated arm (the same settings, calibration, start positions and servo speed), its wrist camera on the frames
// a window would send, and a model service given as `fetch` that answers as the stream of a chat completion.
// Everything keeps one clock of the test's own, on which time passes only while everything waits for it. The
// model client keeps the machine's timers whatever clock it is given (its look for a stop every CANCEL_POLL_S, its
// deadline, the clean-up wait of its close), so the machine's timers are the test's too, and they advance with the
// station's clock: without that the station's ten seconds of clean-up pass in a few real milliseconds, before the
// client has looked once, and a cancelled turn ends as a lost session or not, by chance.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EventData } from "../../src/agent/clients/schemas";
import type { Sleep } from "../../src/agent/clock";
import { Commands } from "../../src/console/commands";
import { Phase } from "../../src/console/phase";
import type { ModelState, SingleArmDelta } from "../../src/protocol/types";
import { WristCamera } from "../../src/so101/hardware/cameras";
import { simulatedArm } from "../../src/so101/hardware/index";
import { SO101Robot } from "../../src/so101/robot";
import { CameraFeed } from "../../src/station/cameras";
import type { MonotonicClock } from "../../src/station/joint/clock";
import { AgentRobotAdapter } from "../../src/station/robot";
import { RobotStatus } from "../../src/station/schemas";
import { SIM_CALIBRATION, SIM_START_POSITIONS } from "../../web/src/sim_port";
import { SIM_SPEED_STEPS_S, STATION_CONFIG, uuid4, WindowFrames } from "../../web/src/station_host";
import { TaskHost, type TaskEvent } from "../../web/src/task_host";

/** A clock on which time passes only while everything waits for it: the sleeper whose time comes first is woken,
 * at its time (the clock of tests/web/station_real.test.ts), and the machine's timers, which are the test's, are
 * advanced by the same time. */
class EventClock implements MonotonicClock {
  private nowS = 100;
  /** How far the machine's timers were advanced, ms since the clock began. */
  private timersMs = 0;
  private isStopped = false;
  private readonly sleepers: Array<{ at: number; wake: () => void }> = [];
  private isPumping = false;

  monotonic(): number {
    return this.nowS;
  }

  sleep(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      this.sleepers.push({ at: this.nowS + Math.max(seconds, 0), wake: resolve });
      this.pumpLater();
    });
  }

  /** Ends the clock: whoever still waits on it waits for ever, and the timers of a later test are left alone. */
  stop(): void {
    this.isStopped = true;
    this.sleepers.length = 0;
  }

  private pumpLater(): void {
    if (this.isStopped || this.isPumping || this.sleepers.length === 0) return;
    this.isPumping = true;
    setImmediate(() => {
      this.isPumping = false;
      if (this.isStopped) return;
      let first = 0;
      for (let index = 1; index < this.sleepers.length; index++) {
        if ((this.sleepers[index] as { at: number }).at < (this.sleepers[first] as { at: number }).at) first = index;
      }
      const [sleeper] = this.sleepers.splice(first, 1);
      if (sleeper === undefined) return;
      this.nowS = Math.max(this.nowS, sleeper.at);
      const elapsedMs = Math.floor((this.nowS - 100) * 1000);
      if (vi.isFakeTimers()) vi.advanceTimersByTime(elapsedMs - this.timersMs);
      this.timersMs = elapsedMs;
      sleeper.wake();
      this.pumpLater();
    });
  }
}

/** The key of the stand-in service: it may be in the client's requests and nowhere else. */
const KEY = "the-stand-in-service-key";
/** A frame of the window's camera: the smallest JPEG, and what a request holds of it. */
const FRAME = [0xff, 0xd8, 0xff, 0xd9];
const FRAME_URL = "data:image/jpeg;base64,/9j/2Q==";

/** Returns an answer of the model that ends in the action `arm`, in PEAR's format. */
const action = (arm: Partial<Record<"x" | "y" | "z" | "pitch" | "roll", number>>, width = 0): string =>
  "I move the arm.\n```json\n" +
  JSON.stringify({ arm: { x: 0, y: 0, z: 0, pitch: 0, roll: 0, ...arm }, gripper: { width } }) +
  "\n```";

/** What the stand-in service answers a request with: an answer's text, an HTTP error, or nothing until the
 * request is cancelled. */
type Answer = string | { status: number; body: unknown } | "hold";

/** One request the service received. */
interface Received {
  url: string;
  authorization: string | null;
  body: { model?: string; stream?: boolean; messages: Array<{ role: string; content: unknown }> };
}

/** A model service as `fetch`: it answers a chat completion as vLLM streams one, in the order of `answers`. */
class StandInService {
  readonly answers: Answer[] = [];
  readonly received: Received[] = [];
  /** How many requests are held open, and how many of them were cancelled by their caller. */
  held = 0;
  cancelled = 0;

  readonly fetch: typeof fetch = (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (!url.endsWith("/chat/completions")) {
      return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "stand-in" }] }), { status: 200 }));
    }
    this.received.push({
      url,
      authorization: headers.get("authorization"),
      body: JSON.parse(String(init?.body)) as Received["body"],
    });
    const answer = this.answers.shift() ?? "hold";
    if (answer === "hold") {
      this.held += 1;

      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          this.cancelled += 1;
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }
    if (typeof answer !== "string") {
      const body = JSON.stringify(answer.body);

      return Promise.resolve(new Response(body, { status: answer.status, headers: { "content-type": "application/json" } }));
    }
    const usage = { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240 };
    const chunk = (content: string, finish: string | null): string =>
      `data: ${JSON.stringify({ id: "c", model: "stand-in", choices: [{ index: 0, delta: { content }, finish_reason: finish }], usage })}\n\n`;
    const text = chunk(answer, null) + chunk("", "stop") + "data: [DONE]\n\n";

    return Promise.resolve(new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } }));
  };
}

/** One station with its task host. */
interface Rig {
  clock: EventClock;
  robot: SO101Robot<Uint8Array>;
  frames: WindowFrames;
  host: TaskHost<Uint8Array>;
  service: StandInService;
  /** What the console logged: the logger, the level, the message and the error's text. */
  logs: string[];
  /** Every event taken so far. */
  events: TaskEvent[];
  /** Takes the new events, and returns all of the kind `type`. */
  eventsOf(type: string): TaskEvent[];
  /** Waits on the station's clock until `isSo` holds. */
  until(isSo: () => boolean, what: string): Promise<void>;
  startCamera(): void;
  stopCamera(): void;
  /** Ends the host, the robot and the camera, so that no clock is kept going. */
  end(): Promise<void>;
}

const rigs: Rig[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});
afterEach(async () => {
  for (const made of rigs.splice(0)) await made.end();
  vi.useRealTimers();
});

/** Returns a station on the simulated arm with its task host: the robot open and the camera running, unless told
 * otherwise. */
async function rig(options: { isOpen?: boolean; hasCamera?: boolean } = {}): Promise<Rig> {
  const clock = new EventClock();
  const chain = simulatedArm(SIM_CALIBRATION, SIM_START_POSITIONS, {
    speed: SIM_SPEED_STEPS_S,
    clock: { now: () => clock.monotonic() * 1000, sleep: (ms) => clock.sleep(ms / 1000) },
  });
  const frames = new WindowFrames(clock);
  const cameraFeed = new CameraFeed(new WristCamera(STATION_CONFIG.robot, frames, { clock }));
  const robot = new SO101Robot<Uint8Array>(STATION_CONFIG, {
    clock,
    cameras: cameraFeed,
    line: { transport: chain, calibration: SIM_CALIBRATION, clock },
    uuid4,
    configOptions: { calibrationExists: () => true },
  });
  const camera = { isRunning: false };
  const startCamera = (): void => {
    camera.isRunning = true;
    frames.take({ kind: "camera", isRunning: true });
    void (async () => {
      while (camera.isRunning) {
        frames.take({ kind: "frame", jpeg: Uint8Array.from(FRAME).buffer });
        await clock.sleep(0.05);
      }
    })();
  };
  if (options.hasCamera !== false) startCamera();
  if (options.isOpen !== false) await robot.open();

  const service = new StandInService();
  const logs: string[] = [];
  const events: TaskEvent[] = [];
  let drawn = 0;
  const sleep: Sleep = (seconds, wake) =>
    new Promise((resolve) => {
      void clock.sleep(seconds).then(resolve);
      wake?.addEventListener("abort", () => resolve(), { once: true });
    });
  const host = new TaskHost<Uint8Array>({
    robot,
    agentRobot: new AgentRobotAdapter<ModelState, SingleArmDelta, Uint8Array>(robot, (frame) => frame),
    cameraFeed,
    camera: () => frames.numbers(),
    service: { baseUrl: "http://model.test/v1", model: "stand-in", apiKey: KEY },
    clock: () => clock.monotonic(),
    sleep,
    wallClock: () => 1_700_000_000 + clock.monotonic(),
    // counted in its first digits: a turn's attempt id is the first twelve of a UUID's
    uuid: () => `${String((drawn += 1)).padStart(8, "0")}-0000-4000-8000-000000000000`,
    fetch: service.fetch,
    log: (logger, level, message, error) => logs.push(`${logger} ${level} ${message} ${error === undefined ? "" : String(error)}`),
  });
  let isEnded = false;
  const made: Rig = {
    clock,
    robot,
    frames,
    host,
    service,
    logs,
    events,
    eventsOf: (type) => {
      events.push(...host.takeEvents());

      return events.filter((event) => event.type === type);
    },
    until: async (isSo, what) => {
      for (let waits = 0; !isSo(); waits++) {
        if (waits > 3000) {
          events.push(...host.takeEvents());
          const kinds = events.map((event) => event.type).filter((type) => !type.endsWith("_delta"));
          throw new Error(`Never happened: ${what}; ${JSON.stringify(host.snapshot())}; ${kinds.join(" ")}`);
        }
        await clock.sleep(0.02);
      }
    },
    startCamera,
    stopCamera: () => {
      camera.isRunning = false;
      frames.take({ kind: "camera", isRunning: false });
    },
    end: async () => {
      if (isEnded) return;
      isEnded = true;
      await host.close();
      if (robot.status().status !== RobotStatus.OFF) await robot.close();
      camera.isRunning = false;
      clock.stop();
    },
  };
  rigs.push(made);

  return made;
}

/** Returns the state the model was shown in each observation so far, in order. */
const statesOf = (made: Rig): ModelState[] => made.eventsOf("observation").map((event) => event.data["state"] as ModelState);

/** Returns the text of what `promise` rejects with. */
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
  throw new Error("the command was accepted");
}

/** Everything a rig let out, as one text: its events, its snapshot, its records and its log. */
const everythingOf = (made: Rig): string =>
  JSON.stringify([made.eventsOf(""), made.events, made.host.snapshot(), made.host.records.keptTasks(), made.host.records.keptRootRecords(), made.logs]);

describe("PEAR's console on the page's station: a task on the simulated arm", () => {
  it("1: asks the model, moves the arm by its action and observes the new pose, turn after turn; an answer without an action fails the turn and pauses the task", async () => {
    const r = await rig();
    expect(r.host.snapshot()).toMatchObject({ phase: Phase.HOLDING, isBusy: false, task: null, activeTurn: null, totalSteps: 0 });
    r.service.answers.push(action({ z: 1 }), action({ z: 1 }), action({ x: 1 }), "The cube is in the bowl: the task is done.");

    expect(await r.host.run("start", { instruction: "Put the cube into the bowl" })).toEqual({ accepted: true });
    await r.until(() => !r.host.snapshot().isBusy && r.host.snapshot().phase === Phase.PAUSED, "the fourth turn's end");

    // the first request: the system prompt with the instruction, then the observation with the camera's frame
    const first = r.service.received[0]!;
    expect(first.url).toBe("http://model.test/v1/chat/completions");
    expect(first.body.model).toBe("stand-in");
    expect(first.body.stream).toBe(true);
    expect(first.body.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(first.body.messages[0]!.content).toContain("Put the cube into the bowl");
    const parts = first.body.messages[1]!.content as Array<{ type: string; text?: string; image_url?: { url: string } | null }>;
    expect(parts.find((part) => part.type === "image_url")?.image_url?.url).toBe(FRAME_URL);
    expect(parts.find((part) => part.type === "text")?.text).toContain("z");

    // three actions moved the arm, and each next turn observed the pose the action before it left
    const states = statesOf(r);
    expect(states).toHaveLength(4);
    expect(states[1]!.arm.z - states[0]!.arm.z).toBeCloseTo(1, 0);
    expect(states[2]!.arm.z - states[1]!.arm.z).toBeCloseTo(1, 0);
    expect(states[3]!.arm.x - states[2]!.arm.x).toBeCloseTo(1, 0);
    expect(r.eventsOf("execution").slice(0, 3).map((event) => event.data["status"])).toEqual(["completed", "completed", "completed"]);
    expect(r.service.received).toHaveLength(4);
    // the conversation is the client's: the fourth request holds the three turns before it
    expect(r.service.received[3]!.body.messages.map((message) => message.role)).toEqual(
      ["system", "user", "assistant", "user", "assistant", "user", "assistant", "user"],
    );

    // every turn left its three records beside the task's and the session's
    const kept = r.host.records.keptTasks();
    expect(kept).toHaveLength(1);
    const attempts = r.eventsOf("turn_started").map((event) => event.data["attempt"] as string);
    expect(new Set(attempts).size).toBe(4);
    expect(Object.keys(kept[0]!.records)).toEqual([
      "task.json",
      "session.json",
      ...attempts.flatMap((attempt) => [`${attempt}-observation.json`, `${attempt}-output.json`, `${attempt}-result.json`]),
    ]);
    expect(kept[0]!.events.map((event) => event.type)).toEqual(expect.arrayContaining(["task", "session", "observation", "model_output", "execution"]));

    // PEAR has no word for "done": an answer without an action is a rejected turn, which ends the run with the
    // failure shown and leaves the task paused, its session kept, until the operator resumes or clears it
    const last = r.eventsOf("execution")[3]!;
    expect(last.data["status"]).toBe("rejected");
    expect((last.data["error"] as { code: string }).code).toBe("ValueError");
    expect(r.eventsOf("turn_end").map((event) => [event.data["phase"], typeof event.data["message"]])).toEqual([[Phase.FAILED, "string"]]);
    expect(r.eventsOf("error")).toHaveLength(1);
    const snapshot = r.host.snapshot();
    expect(snapshot.error).toMatch(/^RuntimeError: /);
    expect(snapshot.error).toBe(r.eventsOf("error")[0]!.data["message"]);
    expect(snapshot).toMatchObject({ phase: Phase.PAUSED, isBusy: false, isStopLatched: false, totalSteps: 3 });
    expect(snapshot.task).toMatchObject({ instruction: "Put the cube into the bowl", model: TaskHost.MODEL, model_label: "stand-in" });
    expect(snapshot.activeTurn).toMatchObject({ turn_number: 4, phase: Phase.FAILED });
    expect(r.robot.status().status).toBe(RobotStatus.READY);

    // a resume goes on in the same session, and tells the model what became of its answer
    r.service.answers.push(action({ z: -1 }));
    expect(await r.host.run("resume")).toEqual({ accepted: true });
    await r.until(() => r.service.held === 1, "the turn after the resumed one");
    expect(r.eventsOf("session")).toHaveLength(1);
    expect(r.host.snapshot().error).toBeNull();
    expect(JSON.stringify(r.service.received[4]!.body.messages.at(-1))).toContain("ValueError");
    expect(r.host.snapshot().totalSteps).toBe(4);
  });

  it("2: a pause while the model answers cancels the request, moves nothing and shows Paused; a resume goes on in the same session", async () => {
    const r = await rig();
    r.service.answers.push(action({ z: 1 }));
    await r.host.run("start", { instruction: "Lift the arm" });
    await r.until(() => r.service.held === 1, "the second turn's request");
    expect(r.host.snapshot()).toMatchObject({ phase: Phase.THINKING, isBusy: true, totalSteps: 1 });

    const report = await r.host.run("pause");
    expect(report["stop_requested"]).toBe(true);
    await r.until(() => r.host.snapshot().phase === Phase.PAUSED, "the pause");
    expect(r.service.cancelled).toBe(1);
    expect(r.host.snapshot()).toMatchObject({ isBusy: false, isStopLatched: false, error: null, totalSteps: 1 });
    expect(r.host.snapshot().activeTurn).toMatchObject({ turn_number: 2, phase: Phase.INTERRUPTED });
    expect(r.eventsOf("stopping").map((event) => event.data["message"])).toEqual(["Paused by operator"]);
    expect(r.eventsOf("turn_end").map((event) => event.data["phase"])).toEqual([Phase.INTERRUPTED]);
    expect(r.eventsOf("action")).toHaveLength(1); // the first turn's: the cancelled turn gave none

    r.service.answers.push(action({ z: 1 }));
    expect(await r.host.run("resume")).toEqual({ accepted: true });
    await r.until(() => r.service.held === 2, "the turn after the resumed one");
    // one session: the request after the pause holds the first turn's conversation
    expect(r.eventsOf("session")).toHaveLength(1);
    expect(new Set(r.eventsOf("turn_started").map((event) => event.data["episode_id"])).size).toBe(1);
    expect(r.service.received[2]!.body.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    // nothing moved between the pause and the resume: the resumed turn observed the pose of the cancelled one
    const states = statesOf(r);
    expect(states[2]!.arm).toEqual(states[1]!.arm);
    expect(r.host.snapshot().totalSteps).toBe(2);
  });

  it("3: STOP MOTION while the arm moves brakes it into a hold and latches; start and resume are refused until reset_stop", async () => {
    const r = await rig();
    r.service.answers.push(action({ z: -6 }));
    await r.host.run("start", { instruction: "Lower the arm" });
    await r.until(() => r.host.snapshot().phase === Phase.EXECUTING, "the motion");
    await r.clock.sleep(0.3);

    const report = await r.host.run("stop");
    expect(report["stop_requested"]).toBe(true);
    await r.until(() => r.host.snapshot().phase === Phase.STOPPED, "the stop");
    expect(r.host.snapshot()).toMatchObject({ isBusy: false, isStopLatched: true });
    expect(r.robot.status().status).toBe(RobotStatus.READY); // it holds, with torque
    expect(r.eventsOf("stopping").map((event) => event.data["message"])).toEqual(["STOP MOTION activated"]);

    expect(await refusal(r.host.run("start", { instruction: "Again" }))).toBe("ValueError: Reset STOP MOTION before continuing");
    expect(await refusal(r.host.run("resume"))).toBe("ValueError: Reset STOP MOTION before continuing");
    expect(r.service.received).toHaveLength(1);

    expect(await r.host.run("reset_stop")).toEqual({ reset: true });
    expect(r.host.snapshot()).toMatchObject({ phase: Phase.PAUSED, isStopLatched: false });
    expect(await r.host.run("resume")).toEqual({ accepted: true });
    await r.until(() => r.service.held === 1, "the turn after the reset");
    // the arm stopped on its way: it is below where it began and above where the action would have left it
    const states = statesOf(r);
    expect(states[1]!.arm.z).toBeLessThan(states[0]!.arm.z - 0.05);
    expect(states[1]!.arm.z).toBeGreaterThan(states[0]!.arm.z - 5.5);
  });

  it("4: clear closes the session and ends the task; a new start works in a new session", async () => {
    const r = await rig();
    await r.host.run("start", { instruction: "First task" });
    await r.until(() => r.service.held === 1, "the first request");
    expect(await refusal(r.host.run("start", { instruction: "Second task" }))).toBe("ValueError: Wait for the current operation or pause it first");
    await r.host.run("pause");
    await r.until(() => r.host.snapshot().phase === Phase.PAUSED, "the pause");
    expect(await refusal(r.host.run("start", { instruction: "Second task" }))).toBe("ValueError: Clear the current task before starting a new one");
    const firstTask = r.host.snapshot().task!.id;

    expect(await r.host.run("clear")).toEqual({ accepted: true });
    await r.until(() => r.host.snapshot().task === null && !r.host.snapshot().isBusy, "the clearing");
    expect(r.host.snapshot()).toMatchObject({ phase: Phase.HOLDING, activeTurn: null, totalSteps: 0, error: null });
    expect(r.eventsOf("task_end").map((event) => event.data["message"])).toEqual(["Task cleared; history saved."]);

    await r.host.run("start", { instruction: "Second task" });
    await r.until(() => r.service.held === 2, "the second task's request");
    expect(r.host.snapshot().task!.id).not.toBe(firstTask);
    const sessions = r.eventsOf("session").map((event) => event.data["episode_id"]);
    expect(new Set(sessions).size).toBe(2);
    // the new session's conversation begins again
    expect(r.service.received[1]!.body.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(r.service.received[1]!.body.messages[0]!.content).toContain("Second task");
    // a clear of a task that runs stops it first, as PEAR's does
    expect(await r.host.run("clear")).toEqual({ accepted: true });
    await r.until(() => r.host.snapshot().task === null && !r.host.snapshot().isBusy, "the clearing of a running task");
    expect(r.service.cancelled).toBe(2);
    // the records of both tasks are kept
    expect(r.host.records.keptTasks().map((task) => Object.keys(task.records).slice(0, 2))).toEqual([
      ["task.json", "session.json"],
      ["task.json", "session.json"],
    ]);
  });

  it("5: start is refused without a running camera, and a camera that stops during a task pauses it", async () => {
    const r = await rig({ hasCamera: false });
    expect(await refusal(r.host.run("start", { instruction: "Look" }))).toBe("ValueError: Restore live camera feeds before starting a task");
    expect(r.host.snapshot().task).toBeNull();
    // a camera that does not run is no live feed, however fresh its last frame
    r.frames.take({ kind: "frame", jpeg: Uint8Array.from(FRAME).buffer });
    expect(await refusal(r.host.run("start", { instruction: "Look" }))).toBe("ValueError: Restore live camera feeds before starting a task");

    r.startCamera();
    await r.clock.sleep(0.1);
    await r.until(() => r.robot.status().status === RobotStatus.READY, "the arm at rest");
    await r.host.run("start", { instruction: "Look" });
    await r.until(() => r.service.held === 1, "the first request");
    r.stopCamera();
    await r.until(() => r.host.snapshot().phase === Phase.PAUSED, "the watchdog's pause");
    expect(r.eventsOf("stopping").map((event) => event.data["message"])).toEqual(["Camera unavailable; restore the feed before resuming."]);
    expect(r.service.cancelled).toBe(1);
    expect(await refusal(r.host.run("resume"))).toBe("ValueError: Restore live camera feeds before resuming");

    // a frame older than PEAR's limit is no live feed either
    r.frames.take({ kind: "camera", isRunning: true });
    await r.clock.sleep(TaskHost.FRAME_MAX_AGE_S + 0.1);
    expect(await refusal(r.host.run("resume"))).toBe("ValueError: Restore live camera feeds before resuming");
    r.startCamera();
    await r.clock.sleep(0.1);
    expect(await r.host.run("resume")).toEqual({ accepted: true });
  });

  it("6: start is refused while the robot is not READY", async () => {
    const r = await rig({ isOpen: false });
    expect(r.host.snapshot().phase).toBe(Phase.DISABLED);
    expect(await refusal(r.host.run("start", { instruction: "Move" }))).toBe("ValueError: Enable motors and wait for stable holding first");
    expect(await refusal(r.host.run("resume"))).toBe("ValueError: A paused task and stable enabled robot are required");
    expect(r.service.received).toHaveLength(0);
  });

  it("refuses the commands that stay the page's own, an unknown command, an image and a tag", async () => {
    const r = await rig();
    for (const name of TaskHost.REFUSED) {
      expect(await refusal(r.host.run(name, {}))).toContain(`The command ${name} is not given to the console at this stage`);
    }
    expect(await refusal(r.host.run("dance"))).toBe("ValueError: Unknown command");
    expect(await refusal(r.host.run("start", { instruction: "" }))).toBe(`ValueError: Enter a task of 1–${Commands.MAX_INSTRUCTION_CHARS} characters`);
    expect(await refusal(r.host.run("start", { instruction: "Go", image_ids: ["a"] }))).toMatch(/^ValueError: /);
    expect(await refusal(r.host.run("start", { instruction: "Go", tags: "red" }))).toBe("ValueError: Tags must be a list of text");
    expect(await refusal(r.host.run("start", { instruction: "Go", tags: ["red"] }))).toMatch(/^ValueError: /);
    expect(r.host.snapshot().task).toBeNull();
    expect(r.host.records.keptTasks()).toEqual([]);
  });

  it("7: the key is in the client's requests and in no event, snapshot, record, error or log", async () => {
    const r = await rig();
    // a service that writes the key it was given into its refusal
    r.service.answers.push(action({ z: 1 }), { status: 401, body: { error: { message: `Incorrect API key provided: ${KEY}`, type: "invalid_request_error" } } });
    await r.host.run("start", { instruction: `Move up; ${KEY}` });
    await r.until(() => !r.host.snapshot().isBusy && r.host.snapshot().phase === Phase.PAUSED, "the refused request");

    expect(r.service.received.map((request) => request.authorization)).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`]);
    expect(r.host.snapshot().error).toContain("401");
    expect(r.host.snapshot().error).toContain(TaskHost.KEY_MARK);
    const refused = await refusal(r.host.run("start", { instruction: KEY }));
    expect(refused).not.toContain(KEY);
    expect(r.logs.length).toBeGreaterThan(0);
    const everything = everythingOf(r);
    expect(everything).toContain("Incorrect API key provided");
    expect(everything).not.toContain(KEY);
    expect(JSON.stringify(structuredClone([r.events, r.host.snapshot(), r.host.records.keptTasks()]))).not.toContain(KEY);
  });

  it("8: close pauses a running task, ends its session and the watchdog, and leaves the robot open and holding", async () => {
    const r = await rig();
    r.service.answers.push(action({ z: 1 }));
    await r.host.run("start", { instruction: "Lift the arm" });
    await r.until(() => r.service.held === 1, "the second turn's request");

    await r.host.close();
    expect(r.service.cancelled).toBe(1);
    expect(r.eventsOf("stopping").map((event) => event.data["message"])).toEqual([TaskHost.CLOSE_REASON]);
    expect(r.eventsOf("turn_end").map((event) => [event.data["phase"], event.data["message"]])).toEqual([[Phase.INTERRUPTED, undefined]]);
    // the watchdog is gone, so the phase stays where the stop left it; the task and its records stay
    expect(r.host.snapshot()).toMatchObject({ phase: Phase.STOPPING, isBusy: false, isStopLatched: false, totalSteps: 1 });
    expect(r.host.snapshot().task).toMatchObject({ instruction: "Lift the arm" });
    expect(Object.keys(r.host.records.keptTasks()[0]!.records)).toContain("task.json");
    expect(r.robot.status().status).toBe(RobotStatus.READY);
    expect(await refusal(r.host.run("resume"))).toBe("RuntimeError: The task host is closed");
    await r.host.close(); // a second close does nothing
    await r.clock.sleep(1);
    expect(r.service.received).toHaveLength(2);
    expect(r.host.takeEvents()).toEqual([]);
  });

  it("9: a limit of turns pauses between two turns, and pausedBy tells it until the task runs again; pauseFor tells its cause only while the turns run", async () => {
    const r = await rig();
    const isPaused = (): boolean => !r.host.isBusy && r.host.snapshot().phase === "Paused";
    r.service.answers.push(action({ z: 1 }), action({ z: 1 }), action({ z: 1 }));
    await r.host.run("start", { instruction: "Lift the arm" }, { turns: 1, action: null });
    expect(r.host.pausedBy).toBeNull();
    await r.until(isPaused, "the pause at the limit");

    // the turn that reached the limit ended with its result, and nothing of a next turn was begun
    expect(r.host.pausedBy).toBe("limit");
    expect(r.eventsOf("turn_started")).toHaveLength(1);
    const kinds = r.events.map((event) => event.type).filter((type) => !type.endsWith("_delta"));
    expect(kinds.slice(kinds.lastIndexOf("execution") + 1)).toEqual(["stopping"]);
    expect(kinds).not.toContain("interrupted");
    expect([r.service.received.length, r.service.held, r.service.cancelled]).toEqual([1, 0, 0]);
    expect(r.host.snapshot()).toMatchObject({ totalSteps: 1, error: null, isStopLatched: false });

    // a start that PEAR refuses changes no limit; a resume counts from zero again
    expect(await refusal(r.host.run("start", { instruction: "Another" }, { turns: 0, action: null }))).toContain("Clear the current task");
    await r.host.run("resume");
    expect(r.host.pausedBy).toBeNull();
    await r.until(isPaused, "the second pause at the limit");
    expect(r.host.pausedBy).toBe("limit");
    expect(r.eventsOf("turn_started")).toHaveLength(2);
    expect(r.service.received).toHaveLength(2);
    await r.host.run("resume");
    await r.until(isPaused, "the third pause at the limit");

    // the operator's own pause is no pause of the host's
    await r.host.run("resume");
    await r.until(() => r.service.held === 1, "the request that is held open");
    await r.host.run("pause");
    await r.until(isPaused, "the operator's pause");
    expect(r.host.pausedBy).toBeNull();
    // a pause for a hidden page tells its cause when it paused the turns, until a clear
    await r.host.run("resume");
    await r.until(() => r.service.held === 2, "the next request that is held open");
    await r.host.pauseFor("hidden");
    expect(r.host.pausedBy).toBe("hidden");
    await r.until(isPaused, "the hidden page's pause");
    expect(r.host.pausedBy).toBe("hidden");
    await r.host.run("clear");
    expect(r.host.pausedBy).toBeNull();
  });

  it("10: under a limit of an action's size every part over it is named and nothing of the action is executed; an action at the limit is", async () => {
    const r = await rig();
    // x and roll at the limit, z and pitch over it, the gripper opened; then exactly the limit in z
    r.service.answers.push(action({ x: 5, z: -5.5, pitch: 0.8, roll: -0.5 }, 1), action({ z: -5 }));
    await r.host.run("start", { instruction: "Lower the arm" }, { turns: 0, action: { cm: 5, rad: 0.5 } });
    await r.until(() => r.service.held === 1 && statesOf(r).length === 3, "the third turn's request");

    const executions = r.eventsOf("execution");
    expect(executions[0]!.data).toMatchObject({
      status: "rejected",
      error: {
        code: "UnreachablePoseError",
        message:
          "The operator's limit for one action is 5 cm in x, y and z and 0.5 rad in pitch and roll, either way. " +
          "This action is over it: z -5.5 cm is 0.5 cm over, pitch 0.8 rad is 0.3 rad over.",
      },
    });
    expect(r.eventsOf("notice")).toHaveLength(1); // PEAR's own notice of a rejection it retries
    const states = statesOf(r);
    expect(states[1]!.arm.x).toBeCloseTo(states[0]!.arm.x, 1);
    expect(states[1]!.arm.z).toBeCloseTo(states[0]!.arm.z, 1);
    expect(states[1]!.gripper.width).toBeCloseTo(states[0]!.gripper.width, 1);
    expect(r.logs.filter((line) => line.includes("An action was not given to the robot"))).toHaveLength(1);
    expect(executions[1]!.data).toMatchObject({ status: "completed" });
    expect(states[2]!.arm.z - states[1]!.arm.z).toBeCloseTo(-5, 0);
    expect(r.host.snapshot()).toMatchObject({ totalSteps: 1, error: null });
  });

  it("keeps a bounded number of events between two takes, and numbers them without a gap otherwise", async () => {
    const r = await rig();
    r.service.answers.push(action({ z: 1 }));
    await r.host.run("start", { instruction: "Lift the arm" });
    await r.until(() => r.service.held === 1, "the second turn's request");
    const taken = r.host.takeEvents();
    expect(taken.map((event) => event.id)).toEqual(taken.map((_event, index) => index + 1));
    expect(taken.length).toBeLessThanOrEqual(TaskHost.EVENTS_TAKEN);
    expect(r.host.takeEvents()).toEqual([]);
    expect(r.host.snapshot().sequence).toBe(taken.length);
    expect(taken[0]).toMatchObject({ type: "task", task_id: r.host.snapshot().task!.id });
    const kinds = [...new Set(taken.map((event) => event.type))];
    expect(kinds).toEqual(expect.arrayContaining(["task", "session", "turn_started", "observation", "model_output", "action", "execution"]));
  });
});

/** The data of an event, for a reader of a failure. */
export type { EventData };
