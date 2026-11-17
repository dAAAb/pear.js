// A task through the Worker's host (web/src/station_host.ts), as the window asks for it: the request "task" on the
// simulated arm and on a real arm's path (simulated servos behind a granted port, beneath the line's guard), with
// PEAR's console (web/src/task_host.ts) joined to the station, and the operator's two limits. The tests send the host's
// requests and read what it posts, and nothing else: the replies, the events and the statuses.
//
// The model service is a stand-in given to the host as `fetch`. The station, its console and the model client's
// own timers all run on one clock, on which time passes only while everything waits for it (the clock and the
// stand-in of tests/web/task_host.test.ts): a session of some seconds takes a few milliseconds.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MODEL_NUMBER_VALUE } from "../../src/feetech/index";
import { MOTORS } from "../../src/so101/hardware/index";
import type { MonotonicClock } from "../../src/station/joint/clock";
import { SIM_CALIBRATION, SIM_START_POSITIONS, SimArm, simulatedConfiguredPort } from "../../web/src/sim_port";
import type { StationGuardTransport } from "../../web/src/station_guard";
import { ENABLE_SETTINGS, GRIPPER_SETTINGS, StationHost } from "../../web/src/station_host";
import type {
  ActionReport,
  ArmFingerprint,
  DisableResult,
  EnableRealResult,
  FromStation,
  HomeResult,
  StationEvent,
  StationRequest,
  StationStatus,
  TaskAnswer,
  TaskCommand,
  TaskLimits,
  TaskService,
} from "../../web/src/station_protocol";
import { ACTION_LIMIT_CM, ACTION_LIMIT_RAD } from "../../web/src/station_protocol";
import type { TaskEvent } from "../../web/src/task_host";

/** A clock on which time passes only while everything waits for it: the sleeper whose time comes first is woken,
 * at its time, and the machine's timers, which are the test's, are advanced by the same time. */
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
/** The model service the page would give, and another one: reserved test names, no real service. */
const SERVICE: TaskService = { baseUrl: "http://model.test/v1", model: "stand-in", apiKey: KEY };
const OTHER: TaskService = { baseUrl: "http://other.test/v1", model: "other-model", apiKey: "the-other-service-key" };
/** What the tests send as a frame: the first and the last bytes of a JPEG. The station never decodes a frame. */
const FRAME = [0xff, 0xd8, 0xff, 0xd9];

/** An action in the model's format. */
const delta = (arm: Partial<Record<"x" | "y" | "z" | "pitch" | "roll", number>>, width = 0): Record<string, unknown> => ({
  arm: { x: 0, y: 0, z: 0, pitch: 0, roll: 0, ...arm },
  gripper: { width },
});

/** Returns an answer of the model that ends in the action `arm`, in PEAR's format. */
const action = (arm: Partial<Record<"x" | "y" | "z" | "pitch" | "roll", number>>): string =>
  "I move the arm.\n```json\n" + JSON.stringify(delta(arm)) + "\n```";

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
  /** How long the service waits between two pieces of an answer, ms of the machine's time; 0: the answer comes
   * in one piece. */
  pieceMs = 0;

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
    if (this.pieceMs > 0) {
      // the answer four characters at a time, as a service streams its tokens
      const pieces = answer.match(/[\s\S]{1,4}/g) ?? [];
      const encoder = new TextEncoder();
      const pieceMs = this.pieceMs;
      const body = new ReadableStream<Uint8Array>({
        start: async (controller) => {
          for (const piece of pieces) {
            controller.enqueue(encoder.encode(chunk(piece, null)));
            await new Promise((resolve) => setTimeout(resolve, pieceMs));
          }
          controller.enqueue(encoder.encode(chunk("", "stop") + "data: [DONE]\n\n"));
          controller.close();
        },
      });

      return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    }

    return Promise.resolve(new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } }));
  };
}

/** A station's host as the window has it: what it is asked and everything it posts. */
interface Station {
  clock: EventClock;
  service: StandInService;
  /** Every message the host posted, in its order. */
  messages: FromStation[];
  ask: <Result>(request: StationRequest) => Promise<Result>;
  /** Waits on the station's clock until `isSo` holds. */
  until: (isSo: () => boolean, what: string) => Promise<void>;
  /** The status the host told last. */
  status: () => StationStatus;
  /** Every event of the console the host posted so far, in its order. */
  taskEvents: () => TaskEvent[];
  /** Tells the host that the window's camera runs and sends it a frame every 50 ms of the station's clock. */
  startCamera: () => void;
  /** Every packet a real arm's servos were given; empty on the simulated arm. */
  packets: Uint8Array[];
  /** The guard of the real arm's line; null on the simulated arm. */
  guard: () => StationGuardTransport | null;
  /** The simulated servos behind the real arm's port; null on the simulated arm. */
  arm: SimArm | null;
  /** Pulls the cable of the real arm's port. */
  unplug: () => void;
  /** Clears the task, disables the station and ends the clock, so that nothing is kept going. */
  end: () => Promise<void>;
}

const stations: Station[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});
afterEach(async () => {
  for (const made of stations.splice(0)) await made.end();
  vi.useRealTimers();
});

/** Returns a host that nothing was asked of yet: with the simulated arm to enable, or, with `isReal`, with one
 * granted port that is a simulated arm's, configured as lerobot leaves an arm (the bench of station_real.test.ts). */
function station(options: { isReal?: boolean; isRealTime?: boolean } = {}): Station {
  const clock = new EventClock();
  /** Waits on the station's clock; with `isRealTime` that is the machine's. */
  const wait = (seconds: number): Promise<void> =>
    options.isRealTime === true ? new Promise((resolve) => setTimeout(resolve, seconds * 1000)) : clock.sleep(seconds);
  const service = new StandInService();
  const messages: FromStation[] = [];
  const packets: Uint8Array[] = [];
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const post = (message: FromStation): void => {
    messages.push(message);
    if (message.kind !== "reply") return;
    const entry = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.isOk) entry?.resolve(message.result);
    else entry?.reject(new Error(`${message.error.name}: ${message.error.message}`));
  };
  let lineGuard: StationGuardTransport | null = null;
  let host: StationHost;
  let servos: SimArm | null = null;
  let unplug = (): void => undefined;
  if (options.isReal === true) {
    const arm = new SimArm("normal");
    servos = arm;
    const write = arm.chain.write.bind(arm.chain);
    arm.chain.write = async (bytes: Uint8Array): Promise<void> => {
      packets.push(bytes.slice());
      await write(bytes);
    };
    const port = simulatedConfiguredPort(ENABLE_SETTINGS, GRIPPER_SETTINGS, arm);
    unplug = () => port.unplug();
    host = new StationHost(
      post,
      { getPorts: async () => [port] },
      clock,
      { clock, armingLimitMs: 4000, onGuard: (guard) => (lineGuard = guard), fetch: service.fetch },
      { clock },
    );
  } else if (options.isRealTime === true) {
    // the page's own clocks and timers: only the model service is the stand-in
    host = new StationHost(post, null, null, {}, { fetch: service.fetch });
  } else {
    host = new StationHost(post, null, clock, {}, { clock, fetch: service.fetch });
  }
  let nextId = 0;
  const ask = <Result>(request: StationRequest): Promise<Result> =>
    new Promise<Result>((resolve, reject) => {
      nextId += 1;
      waiting.set(nextId, { resolve: resolve as (value: unknown) => void, reject });
      host.handle({ id: nextId, request });
    });
  const statuses = (): StationStatus[] =>
    messages.flatMap((message) => (message.kind === "event" && message.event.type === "status" ? [message.event.status] : []));
  const taskEvents = (): TaskEvent[] =>
    messages.flatMap((message) => (message.kind === "event" && message.event.type === "task" ? [...message.event.events] : []));
  /** The cameras that were started: one runs at most. */
  const cameras: Array<{ isRunning: boolean }> = [];
  let isEnded = false;
  const made: Station = {
    clock,
    service,
    messages,
    ask,
    until: async (isSo, what) => {
      for (let waits = 0; !isSo(); waits++) {
        if (waits > 3000) {
          const kinds = taskEvents().map((event) => event.type).filter((type) => !type.endsWith("_delta"));
          throw new Error(`Never happened: ${what}; ${JSON.stringify(made.status().task)}; ${kinds.join(" ")}`);
        }
        await wait(0.02);
      }
    },
    status: () => {
      const told = statuses();
      if (told.length === 0) throw new Error("No status was told yet");

      return told[told.length - 1] as StationStatus;
    },
    taskEvents,
    startCamera: () => {
      for (const earlier of cameras) earlier.isRunning = false; // the frames for a station that was disabled end here
      const running = { isRunning: true };
      cameras.push(running);
      host.handle({ kind: "camera", isRunning: true });
      void (async () => {
        while (running.isRunning && !isEnded) {
          host.handle({ kind: "frame", jpeg: Uint8Array.from(FRAME).buffer });
          await wait(0.05);
        }
      })();
    },
    packets,
    guard: () => lineGuard,
    arm: servos,
    unplug,
    end: async () => {
      if (isEnded) return;
      await ask({ type: "task", command: "clear" }).catch(() => undefined);
      await ask({ type: "disable" }).catch(() => undefined);
      isEnded = true;
      for (const running of cameras) running.isRunning = false;
      clock.stop();
    },
  };
  stations.push(made);

  return made;
}

/** Waits until the robot holds and the window's camera has a fresh frame: what a task's start asks for. */
const untilReady = (made: Station): Promise<void> =>
  made.until(() => {
    const { robot, camera } = made.status();

    return robot === "READY" && camera.isRunning && camera.ageMs !== null && camera.ageMs < 150;
  }, "a holding robot and a fresh frame");

/** Returns a station enabled on the simulated arm, its camera running. */
async function enabledStation(): Promise<Station> {
  const made = station();
  await made.ask({ type: "enable", positions: SIM_START_POSITIONS, isHidden: false });
  made.startCamera();
  await untilReady(made);

  return made;
}

const start = (instruction: string, service: TaskService = SERVICE, limits?: TaskLimits): StationRequest => ({
  type: "task",
  command: "start",
  instruction,
  service,
  ...(limits === undefined ? {} : { limits }),
});
const task = (command: TaskCommand): StationRequest => ({ type: "task", command });
/** A single action of the page's own, in the model's format. */
const jog = (arm: Partial<Record<"x" | "y" | "z", number>>): StationRequest => ({ type: "jog", action: { type: "single_arm_delta", ...delta(arm) } });
const COMMANDS: readonly TaskCommand[] = ["start", "pause", "resume", "clear", "stop", "reset_stop"];
/** Every command of a task as the window would send it. */
const everyCommand = (): StationRequest[] => COMMANDS.map((command) => (command === "start" ? start("Move the arm") : task(command)));

/** The events of the console of the kind `type`. */
const eventsOf = (made: Station, type: string): TaskEvent[] => made.taskEvents().filter((event) => event.type === type);
/** The pose the model was shown in each observation so far, in order. */
const posesOf = (made: Station): Array<Record<"x" | "y" | "z", number>> =>
  eventsOf(made, "observation").map((event) => (event.data["state"] as { arm: Record<"x" | "y" | "z", number> }).arm);
/** Whether no operation of the console runs and its phase is `phase`, by the status told last. */
const isIdleIn = (made: Station, phase: string): boolean => {
  const told = made.status().task;

  return told !== null && !told.isBusy && told.phase === phase;
};

/**
 * Holds what the host posted against the rule of the events: they come oldest first with ids that follow each
 * other, a new console counts from 1 again after a status that told of no console, and no status and no answer
 * tells of an event that has not been posted. Returns how many events it saw.
 */
function expectEventsBeforeStatus(messages: readonly FromStation[]): number {
  let last = 0;
  let count = 0;
  for (const message of messages) {
    if (message.kind === "event" && message.event.type === "task") {
      expect(message.event.events.length).toBeGreaterThan(0);
      for (const event of message.event.events) {
        expect(event.id).toBe(last + 1);
        last = event.id;
        count += 1;
      }
    } else if (message.kind === "event" && message.event.type === "status") {
      const told = message.event.status.task;
      if (told === null) last = 0;
      else expect(told.sequence).toBeLessThanOrEqual(last);
    } else if (message.kind === "reply" && message.isOk) {
      const result = message.result as Partial<TaskAnswer> | null;
      if (result !== null && typeof result === "object" && result.task !== undefined && result.answer !== undefined) {
        expect(result.task.sequence).toBeLessThanOrEqual(last);
      }
    }
  }

  return count;
}

const HELD = "RuntimeError: Clear the task first: a task holds the arm";
const HELD_DISABLE = "RuntimeError: Clear the task before the station is disabled";
const HIDDEN = "RuntimeError: The page is hidden: no action is started";
const LIMITS = "RuntimeError: A task's limits are a whole number of turns from 0 to 1000 and whether an action's size is limited";
/** What the model is told of an action of z -15 cm under the limit of an action's size, word for word. */
const OVER_15 =
  "The operator's limit for one action is 5 cm in x, y and z and 0.5 rad in pitch and roll, either way. " +
  "This action is over it: z -15 cm is 10 cm over.";
/** The statuses the host told before it posted the event of the console that is the `nth` of its kind. */
const statusesBefore = (made: Station, type: string, nth: number): StationStatus[] => {
  const told: StationStatus[] = [];
  let seen = 0;
  for (const message of made.messages) {
    if (message.kind !== "event") continue;
    if (message.event.type === "status") told.push(message.event.status);
    if (message.event.type === "task") {
      seen += message.event.events.filter((event) => event.type === type).length;
      if (seen >= nth) return told;
    }
  }
  throw new Error(`The event ${type} was not posted ${nth} times`);
};
/** An answer of the model that ends in an action of the arm and the gripper. */
const actionWith = (arm: Partial<Record<"x" | "y" | "z" | "pitch" | "roll", number>>, width: number): string =>
  "I move the arm.\n```json\n" + JSON.stringify(delta(arm, width)) + "\n```";
/** The kinds of the console's events so far, without the pieces of the model's answer. */
const kindsOf = (made: Station): string[] => made.taskEvents().map((event) => event.type).filter((type) => !type.endsWith("_delta"));

describe("a task through the Worker's host, on the simulated arm", () => {
  it("a: a start runs three turns by itself; the events come in order and before the status that tells of them", async () => {
    const s = await enabledStation();
    expect(s.status()).toMatchObject({ task: null, action: null, arm: "simulated" });
    s.service.answers.push(action({ z: 1 }), action({ z: 1 }), action({ x: 1 }));

    const started = await s.ask<TaskAnswer>(start("Lift the arm, then reach forward"));
    expect(started.answer).toEqual({ accepted: true });
    expect(started.task.task).toMatchObject({ instruction: "Lift the arm, then reach forward" });
    // the fourth request is held open by the stand-in: three turns are done and the fourth thinks
    await s.until(() => s.service.held === 1 && s.status().task?.phase === "Thinking", "the fourth turn's request");

    // the arm moved by each action, and each next turn observed the pose the action before it left
    const poses = posesOf(s);
    expect(poses).toHaveLength(4);
    expect(poses[1]!.z - poses[0]!.z).toBeCloseTo(1, 0);
    expect(poses[2]!.z - poses[1]!.z).toBeCloseTo(1, 0);
    expect(poses[3]!.x - poses[2]!.x).toBeCloseTo(1, 0);
    expect(eventsOf(s, "execution").map((event) => event.data["status"])).toEqual(["completed", "completed", "completed"]);
    expect(s.service.received).toHaveLength(4);
    expect(s.service.received[0]!.url).toBe("http://model.test/v1/chat/completions");

    // the events: oldest first, without a gap, each before the status and the answer that tell of it
    const events = s.taskEvents();
    expect(expectEventsBeforeStatus(s.messages)).toBe(events.length);
    expect(events[0]).toMatchObject({ id: 1, type: "task" });
    expect(events.filter((event) => event.type === "turn_started")).toHaveLength(4);

    // the status: the console's phases, and the action "task" while an operation of the console runs
    const told = s.messages.flatMap((message) => (message.kind === "event" && message.event.type === "status" ? [message.event.status] : []));
    const phases = new Set(told.flatMap((status) => (status.task === null ? [] : [status.task.phase])));
    expect([...phases]).toEqual(expect.arrayContaining(["Thinking", "Executing"]));
    const during = told.filter((status) => status.task !== null && status.task.isBusy);
    expect(during.length).toBeGreaterThan(10);
    expect(during.every((status) => status.action === "task")).toBe(true);
    expect(told.filter((status) => status.task === null || !status.task.isBusy).every((status) => status.action === null)).toBe(true);
    expect(s.status().task).toMatchObject({ totalSteps: 3, isStopLatched: false, error: null });
  });

  it("b: jog, home and disable are refused while the task is there; after a clear they work, and a disable leaves no console", async () => {
    const s = await enabledStation();
    await s.ask(start("Wait for the answer"));
    await s.until(() => s.service.held === 1, "the request");
    // while the task runs
    await expect(s.ask(jog({ z: 1 }))).rejects.toThrow(HELD);
    await expect(s.ask({ type: "home" })).rejects.toThrow(HELD);
    await expect(s.ask({ type: "disable" })).rejects.toThrow(HELD_DISABLE);
    // and while it is paused
    expect((await s.ask<TaskAnswer>(task("pause"))).answer).toMatchObject({ stop_requested: true });
    await s.until(() => isIdleIn(s, "Paused"), "the pause");
    await expect(s.ask(jog({ z: 1 }))).rejects.toThrow(HELD);
    await expect(s.ask({ type: "home" })).rejects.toThrow(HELD);
    await expect(s.ask({ type: "disable" })).rejects.toThrow(HELD_DISABLE);
    expect(s.status().robot).toBe("READY");

    expect((await s.ask<TaskAnswer>(task("clear"))).answer).toEqual({ accepted: true });
    await s.until(() => isIdleIn(s, "Holding") && s.status().task?.task === null, "the clearing");
    const jogged = await s.ask<ActionReport>(jog({ z: 1 }));
    expect(jogged.record["status"]).toBe("completed");
    const homing = s.ask<HomeResult>({ type: "home" });
    await s.until(() => s.messages.some((message) => message.kind === "event" && message.event.type === "plan"), "the Home plan");
    await s.ask({ type: "approve", isApproved: true });
    expect((await homing).stages.length).toBeGreaterThan(0);

    // the disable closes the console before the robot: the status tells of none, and nothing more comes of it
    const disabled = await s.ask<DisableResult>({ type: "disable" });
    expect(disabled.isLineClosed).toBe(true);
    expect(s.status()).toMatchObject({ robot: "OFF", task: null, action: null });
    const before = s.taskEvents().length;
    await expect(s.ask(task("pause"))).rejects.toThrow("RuntimeError: Open the station first");

    // a new enabling and a new start work, on a new console that counts its events from 1
    await s.ask({ type: "enable", positions: disabled.positions, isHidden: false });
    s.startCamera();
    await untilReady(s);
    expect(s.status().task).toBeNull();
    s.service.answers.push(action({ z: 1 }));
    expect((await s.ask<TaskAnswer>(start("Lift the arm"))).answer).toEqual({ accepted: true });
    await s.until(() => s.service.held === 2, "the second turn's request");
    expect(s.taskEvents()[before]).toMatchObject({ id: 1, type: "task" });
    expect(s.status().task).toMatchObject({ totalSteps: 1 });
    expectEventsBeforeStatus(s.messages);
  });

  it("c: the stop bar during a task is PEAR's STOP MOTION: it latches, resume is refused until reset_stop, then the task runs again", async () => {
    const s = await enabledStation();
    s.service.answers.push(action({ z: -6 }));
    await s.ask(start("Lower the arm"));
    await s.until(() => s.status().task?.phase === "Executing", "the motion");
    await s.clock.sleep(0.3);

    expect(await s.ask({ type: "stop" })).toBeNull();
    await s.until(() => isIdleIn(s, "Stopped"), "the stop");
    expect(s.status().task).toMatchObject({ isStopLatched: true });
    expect(s.status().robot).toBe("READY"); // it holds, with torque
    expect(eventsOf(s, "stopping").map((event) => event.data["message"])).toEqual(["STOP MOTION activated"]);

    await expect(s.ask(task("resume"))).rejects.toThrow("ValueError: Reset STOP MOTION before continuing");
    await expect(s.ask(start("Again"))).rejects.toThrow("ValueError: Reset STOP MOTION before continuing");
    expect(s.service.received).toHaveLength(1);

    const reset = await s.ask<TaskAnswer>(task("reset_stop"));
    expect(reset.answer).toEqual({ reset: true });
    expect(reset.task).toMatchObject({ phase: "Paused", isStopLatched: false });
    expect((await s.ask<TaskAnswer>(task("resume"))).answer).toEqual({ accepted: true });
    await s.until(() => s.service.held === 1 && posesOf(s).length === 2, "the turn after the reset");
    // the arm stopped on its way: below where it began and above where the action would have left it
    const poses = posesOf(s);
    expect(poses[1]!.z).toBeLessThan(poses[0]!.z - 0.05);
    expect(poses[1]!.z).toBeGreaterThan(poses[0]!.z - 5.5);

    // the command "stop" of the request "task" is the same STOP MOTION
    const stopped = await s.ask<TaskAnswer>(task("stop"));
    expect(stopped.answer).toMatchObject({ stop_requested: true });
    await s.until(() => isIdleIn(s, "Stopped"), "the second stop");
    expect(s.status().task).toMatchObject({ isStopLatched: true });
    expect(s.service.cancelled).toBe(1);
    await s.ask(task("reset_stop"));
    expectEventsBeforeStatus(s.messages);
  });

  it("d: a hidden page pauses the running task; start and resume are refused while it is hidden", async () => {
    const s = await enabledStation();
    await s.ask(start("Wait for the answer"));
    await s.until(() => s.service.held === 1, "the request");

    await s.ask({ type: "visibility", isHidden: true });
    await s.until(() => isIdleIn(s, "Paused"), "the pause");
    expect(s.service.cancelled).toBe(1);
    expect(s.status()).toMatchObject({ isHidden: true, action: null, robot: "READY" });
    expect(s.status().task).toMatchObject({ isStopLatched: false });
    expect(eventsOf(s, "stopping").map((event) => event.data["message"])).toEqual(["Paused by operator"]);
    // the status tells that it was the hidden page, until the task runs again
    expect(s.status().taskPausedBy).toBe("hidden");

    await expect(s.ask(task("resume"))).rejects.toThrow(HIDDEN);
    await expect(s.ask(start("Again"))).rejects.toThrow(HIDDEN);
    expect(s.service.received).toHaveLength(1);

    await s.ask({ type: "visibility", isHidden: false });
    expect(s.status().taskPausedBy).toBe("hidden");
    expect((await s.ask<TaskAnswer>(task("resume"))).answer).toEqual({ accepted: true });
    expect(s.status().taskPausedBy).toBeNull();
    await s.until(() => s.service.held === 2, "the turn after the page is shown again");
    expectEventsBeforeStatus(s.messages);
  });

  it("i: a limit of two turns pauses the task between two turns; a resume runs two more; without a limit the task goes on", async () => {
    const s = await enabledStation();
    s.service.answers.push(action({ z: 1 }), action({ z: 1 }), action({ x: 1 }), action({ x: 1 }));
    const started = await s.ask<TaskAnswer>(start("Lift the arm, then reach forward", SERVICE, { turns: 2, isActionLimited: false }));
    expect(started.answer).toEqual({ accepted: true });
    expect(s.status().taskPausedBy).toBeNull();
    await s.until(() => isIdleIn(s, "Paused"), "the pause at the limit of turns");

    // exactly two turns ended, each with its result, and after the second's result no turn started
    expect(s.status()).toMatchObject({ taskPausedBy: "limit", robot: "READY", action: null });
    expect(s.status().task).toMatchObject({ totalSteps: 2, isStopLatched: false, error: null });
    expect(eventsOf(s, "execution").map((event) => event.data["status"])).toEqual(["completed", "completed"]);
    expect(eventsOf(s, "turn_started")).toHaveLength(2);
    const kinds = kindsOf(s);
    expect(kinds.slice(kinds.lastIndexOf("execution") + 1)).toEqual(["stopping"]);
    expect(eventsOf(s, "stopping").map((event) => event.data["message"])).toEqual(["Paused at the operator's limit of turns"]);
    // no turn was interrupted, and no request to the model was made and cancelled
    expect(kinds).not.toContain("interrupted");
    expect(kinds).not.toContain("turn_end");
    expect(s.service.received).toHaveLength(2);
    expect([s.service.held, s.service.cancelled]).toEqual([0, 0]);
    // the pause holds: nothing starts by itself
    await s.clock.sleep(2);
    expect(eventsOf(s, "turn_started")).toHaveLength(2);
    expect(s.status().taskPausedBy).toBe("limit");

    // a resume runs the same number of turns again, and the model's history holds no interrupted turn
    expect((await s.ask<TaskAnswer>(task("resume"))).answer).toEqual({ accepted: true });
    expect(s.status().taskPausedBy).toBeNull();
    await s.until(() => isIdleIn(s, "Paused"), "the second pause at the limit of turns");
    expect(s.status().taskPausedBy).toBe("limit");
    expect(eventsOf(s, "turn_started")).toHaveLength(4);
    expect(eventsOf(s, "execution").map((event) => event.data["status"])).toEqual(["completed", "completed", "completed", "completed"]);
    expect(s.status().task).toMatchObject({ totalSteps: 4, error: null });
    expect(s.service.received).toHaveLength(4);
    expect([s.service.held, s.service.cancelled]).toEqual([0, 0]);
    const told = JSON.stringify(s.service.received.map((request) => request.body.messages));
    expect(told).not.toContain("was interrupted");
    expect(told).not.toContain("interrupted this turn");
    expect(kindsOf(s)).not.toContain("interrupted");

    // a clear ends the telling; a task started with no limit of turns goes on by itself
    await s.ask(task("clear"));
    await s.until(() => isIdleIn(s, "Holding"), "the clear");
    expect(s.status().taskPausedBy).toBeNull();
    s.service.answers.push(action({ z: -1 }), action({ z: -1 }), action({ x: -1 }));
    await s.ask(start("Go back", SERVICE, { turns: 0, isActionLimited: false }));
    await s.until(() => s.service.held === 1 && s.status().task?.phase === "Thinking", "the fourth turn's request");
    expect(eventsOf(s, "turn_started")).toHaveLength(8);
    expect(s.status()).toMatchObject({ taskPausedBy: null, action: "task" });
    expectEventsBeforeStatus(s.messages);
  });

  it("j: under the limit of an action's size an action over it is not given to the robot; the model is told why and the task goes on", async () => {
    const s = await enabledStation();
    const targets = JSON.stringify(s.status().targets);
    // 15 cm down and the gripper closed, then 1 cm down
    s.service.answers.push(actionWith({ z: -15 }, -1), action({ z: -1 }));
    await s.ask(start("Lower the arm", SERVICE, { turns: 0, isActionLimited: true }));
    await s.until(() => s.service.held === 1 && posesOf(s).length === 3, "the third turn's request");

    // the first action is answered as an action the arm cannot reach, with the limit's own message
    const executions = eventsOf(s, "execution");
    expect(executions.map((event) => event.data["status"])).toEqual(["rejected", "completed"]);
    expect(executions[0]!.data).toMatchObject({ status: "rejected", error: { code: "UnreachablePoseError", message: OVER_15 } });
    expect(OVER_15).toContain(`${ACTION_LIMIT_CM} cm`);
    expect(OVER_15).toContain(`${ACTION_LIMIT_RAD} rad`);
    // nothing was written for it: the targets of the arm and the gripper never changed before its result
    const before = statusesBefore(s, "execution", 1);
    expect(before.length).toBeGreaterThan(5);
    expect(before.filter((status) => JSON.stringify(status.targets) !== targets)).toEqual([]);
    const poses = posesOf(s);
    expect(poses[1]!.z).toBeCloseTo(poses[0]!.z, 1);
    // the next turn's request tells the model that message, and its action within the limit is executed
    const second = JSON.stringify(s.service.received[1]!.body.messages);
    expect(second).toContain(`Nothing moved: the whole action was discarded (arm and gripper). ${OVER_15}`);
    expect(poses[2]!.z - poses[1]!.z).toBeCloseTo(-1, 0);
    expect(s.status().task).toMatchObject({ totalSteps: 1, error: null });
    expect(s.status().taskPausedBy).toBeNull();

    // PEAR's own count of such answers in a row pauses the task, with the message as its failure
    await s.ask(task("clear"));
    await s.until(() => isIdleIn(s, "Holding"), "the clear");
    for (let count = 0; count < 6; count++) s.service.answers.push(action({ z: -15 }));
    await s.ask(start("Lower the arm far", SERVICE, { turns: 0, isActionLimited: true }));
    await s.until(() => isIdleIn(s, "Paused"), "PEAR's pause after its count of rejections in a row");
    // (the third execution is the record of the turn that the clear interrupted)
    expect(eventsOf(s, "execution").slice(3).map((event) => event.data["status"])).toEqual(Array.from({ length: 6 }, () => "rejected"));
    expect(s.status().task?.error).toContain(OVER_15);
    expect(s.status().taskPausedBy).toBeNull();
    expect(s.service.received).toHaveLength(9);
    // none of the six moved the arm or the gripper: the targets are those the second action left
    expect(JSON.stringify(s.status().targets)).toBe(JSON.stringify(statusesBefore(s, "execution", 4).pop()!.targets));

    // without the limit the same action is executed whole
    await s.ask(task("clear"));
    await s.until(() => isIdleIn(s, "Holding"), "the second clear");
    s.service.answers.push(action({ z: -15 }));
    const from = posesOf(s).length;
    await s.ask(start("Lower the arm far", SERVICE, { turns: 0, isActionLimited: false }));
    await s.until(() => s.service.held === 2 && posesOf(s).length === from + 2, "the turn after the large action");
    const last = posesOf(s);
    expect(last[from + 1]!.z - last[from]!.z).toBeCloseTo(-15, 0);
    expect(eventsOf(s, "execution").pop()!.data).toMatchObject({ status: "completed" });
    expectEventsBeforeStatus(s.messages);
  });

  it("k: a start whose limits are not a task's limits is refused before a console is made; the bounds are taken", async () => {
    const s = await enabledStation();
    const refused: unknown[] = [
      null,
      {},
      5,
      [2, true],
      { turns: 2 },
      { isActionLimited: true },
      { turns: -1, isActionLimited: false },
      { turns: 1.5, isActionLimited: false },
      { turns: 1001, isActionLimited: false },
      { turns: Number.NaN, isActionLimited: false },
      { turns: "2", isActionLimited: false },
      { turns: 2, isActionLimited: "yes" },
      { turns: 2, isActionLimited: null },
    ];
    for (const limits of refused) {
      await expect(s.ask({ ...start("Move the arm"), limits } as unknown as StationRequest)).rejects.toThrow(LIMITS);
    }
    await s.ask({ type: "visibility", isHidden: false }); // tells the status at once
    expect(s.status()).toMatchObject({ task: null, taskPausedBy: null, action: null });
    expect(s.taskEvents()).toHaveLength(0);
    expect(s.service.received).toHaveLength(0);

    // the largest limit of turns is taken, and so is none
    const started = await s.ask<TaskAnswer>(start("Wait for the answer", SERVICE, { turns: 1000, isActionLimited: true }));
    expect(started.answer).toEqual({ accepted: true });
    await s.ask(task("clear"));
    await s.until(() => isIdleIn(s, "Holding"), "the clear");
    expect((await s.ask<TaskAnswer>(start("Wait for the answer", SERVICE, { turns: 0, isActionLimited: false }))).answer).toEqual({ accepted: true });
  });

  it("f: without an enabled station every command is refused, and no console is made", async () => {
    const s = station();
    for (const request of everyCommand()) {
      await expect(s.ask(request)).rejects.toThrow("RuntimeError: Open the station first");
    }
    expect(s.messages.every((message) => message.kind === "reply" && !message.isOk)).toBe(true);
    expect(s.service.received).toHaveLength(0);
  });

  it("f: on an enabled station every command but start is refused until a task was started, and start without its service or instruction", async () => {
    const s = await enabledStation();
    for (const request of everyCommand().slice(1)) {
      await expect(s.ask(request)).rejects.toThrow("RuntimeError: No task was started since the station was enabled");
    }
    await expect(s.ask({ type: "task", command: "start", instruction: "Move" })).rejects.toThrow(
      "RuntimeError: A task is started with its instruction and the model service",
    );
    await expect(s.ask({ type: "task", command: "start", service: SERVICE })).rejects.toThrow(
      "RuntimeError: A task is started with its instruction and the model service",
    );
    expect(s.status().task).toBeNull();
    // PEAR's own refusal passes as it is, and the console that refused is there
    await expect(s.ask(start(""))).rejects.toThrow("ValueError: Enter a task of 1–20000 characters");
    await s.ask({ type: "visibility", isHidden: false });
    expect(s.status().task).toMatchObject({ phase: "Holding", task: null, isBusy: false });
    // a start while a jog is under way is refused
    const jogging = s.ask<ActionReport>(jog({ z: 2 }));
    await s.until(() => s.status().action === "jog", "the jog");
    await expect(s.ask(start("Move"))).rejects.toThrow("RuntimeError: Another action is under way");
    expect((await jogging).record["status"]).toBe("completed");
    expect(s.service.received).toHaveLength(0);
  });

  it("g: the key is in the service's requests and in no message the host posts", async () => {
    const s = await enabledStation();
    // a service that writes the key it was given into its refusal
    s.service.answers.push(action({ z: 1 }), { status: 401, body: { error: { message: `Incorrect API key provided: ${KEY}`, type: "invalid_request_error" } } });
    await s.ask(start(`Move up; ${KEY}`));
    await s.until(() => isIdleIn(s, "Paused"), "the refused request");
    expect(s.service.received.map((request) => request.authorization)).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`]);
    expect(s.status().task?.error).toContain("401");

    await expect(s.ask(start(KEY))).rejects.toThrow("Clear the current task before starting a new one");
    await expect(s.ask(jog({ z: 1 }))).rejects.toThrow(HELD);
    await s.ask(task("resume"));
    await s.until(() => s.service.held === 1, "the turn after the resume");
    await s.ask({ type: "stop" });
    await s.until(() => isIdleIn(s, "Stopped"), "the stop");
    await s.ask(task("reset_stop"));
    await s.ask(task("clear"));
    await s.until(() => isIdleIn(s, "Holding"), "the clearing");
    await s.ask({ type: "disable" });

    // every message of the whole run, as the window would receive it
    const everything = JSON.stringify(structuredClone(s.messages));
    expect(everything).toContain("Incorrect API key provided");
    expect(everything).toContain("Move up");
    expect(everything).not.toContain(KEY);
    expect(s.messages.length).toBeGreaterThan(30);
  });

  it("h: a start with another service after a clear asks the new service, on a new console", async () => {
    const s = await enabledStation();
    await s.ask(start("First"));
    await s.until(() => s.service.held === 1, "the first service's request");
    expect(s.service.received[0]).toMatchObject({ url: "http://model.test/v1/chat/completions", authorization: `Bearer ${KEY}` });

    // while the task is there the console stays, and PEAR refuses the start
    await expect(s.ask(start("Second", OTHER))).rejects.toThrow("Wait for the current operation or pause it first");
    await s.ask(task("clear"));
    await s.until(() => isIdleIn(s, "Holding") && s.status().task?.task === null, "the clearing");
    const before = s.taskEvents().length;

    expect((await s.ask<TaskAnswer>(start("Second", OTHER))).answer).toEqual({ accepted: true });
    await s.until(() => s.service.held === 2, "the other service's request");
    expect(s.service.received).toHaveLength(2);
    expect(s.service.received[1]).toMatchObject({
      url: "http://other.test/v1/chat/completions",
      authorization: `Bearer ${OTHER.apiKey}`,
      body: { model: "other-model" },
    });
    expect(s.taskEvents()[before]).toMatchObject({ id: 1, type: "task" });
    expectEventsBeforeStatus(s.messages);
    expect(JSON.stringify(s.messages)).not.toContain(OTHER.apiKey);
  });
});

/** The tests in the machine's time take seconds and tell times: they run only when PEAR_JS_REAL_TIME=1 is set, as
 * in station_host.test.ts. */
const REAL_TIME = process.env["PEAR_JS_REAL_TIME"] === "1";

describe.skipIf(!REAL_TIME)("a task through the Worker's host, on the simulated arm in real time", () => {
  it("three turns run while the 50 Hz loop keeps its periods: the console and the loop share one thread", async () => {
    vi.useRealTimers();
    const s = station({ isRealTime: true });
    s.service.pieceMs = 10;
    await s.ask({ type: "enable", positions: SIM_START_POSITIONS, isHidden: false });
    s.startCamera();
    await untilReady(s);
    const before = s.status().since;
    s.service.answers.push(action({ z: 1 }), action({ z: 1 }), action({ x: 1 }));
    await s.ask(start("Lift the arm, then reach forward"));
    await s.until(() => s.service.held === 1 && s.status().task?.phase === "Thinking", "the fourth turn's request");

    expect(eventsOf(s, "execution").map((event) => event.data["status"])).toEqual(["completed", "completed", "completed"]);
    expect(eventsOf(s, "answer_delta").length).toBeGreaterThan(30); // the answers came in pieces
    expectEventsBeforeStatus(s.messages);
    const after = s.status().since;
    // the control periods since enabling, before the task and after its third turn: none as long as the timing
    // self-check refuses, and at most one in twenty over 25 ms
    expect(after.count - before.count).toBeGreaterThan(100);
    expect(after.over40 - before.over40).toBe(0);
    expect(after.over25 - before.over25).toBeLessThanOrEqual(Math.ceil((after.count - before.count) / 20));
  }, 60_000);
});

describe("a task through the Worker's host, on a real arm's line", () => {
  /** The servos as the window would have read them, for the calibration they hold. */
  const print: ArmFingerprint = MOTORS.map((motor) => {
    const { id, homingOffset, rangeMin, rangeMax } = SIM_CALIBRATION[motor];

    return { id, model: MODEL_NUMBER_VALUE, homingOffset, rangeMin, rangeMax };
  });
  type Arming = Extract<StationEvent, { type: "arming" }>;
  const armingOf = (made: Station): Arming | undefined =>
    made.messages.flatMap((message) => (message.kind === "event" && message.event.type === "arming" ? [message.event] : []))[0];

  /** Returns a station enabled on the real arm's path, confirmed by its operator, its camera running. */
  async function enabledReal(): Promise<Station> {
    const s = station({ isReal: true });
    const enabling = s.ask<EnableRealResult>({
      type: "enableReal",
      source: "granted",
      usb: { vendorId: 0x1a86, productId: 0x55d3 },
      expected: print,
      calibrationFile: null,
      isHidden: false,
    });
    await s.until(() => armingOf(s) !== undefined, "the event arming");
    expect(armingOf(s)!.blockers).toEqual([]);
    await s.ask({ type: "arm", requestId: armingOf(s)!.requestId, isConfirmed: true });
    expect((await enabling).outcome).toBe("enabled");
    s.startCamera();
    await untilReady(s);
    expect(s.status()).toMatchObject({ arm: "real", task: null, taskPausedBy: null });

    return s;
  }

  /** What the guard let through that is no read, counted by its kind. */
  const writesOf = (made: Station): Record<string, number> =>
    Object.fromEntries(Object.entries(made.guard()!.status().passed).filter(([kind]) => kind.includes("WRITE")));
  /** The guard's name of a write of the servos' goals. */
  const GOALS = "SYNC WRITE 42";
  /** Whether each servo behind the port has its torque on. */
  const torqueOf = (made: Station): boolean[] => MOTORS.map((motor) => made.arm!.servo(motor).torqueEnabled);
  /** Where each servo behind the port stands, steps. */
  const stepsOf = (made: Station): number[] => MOTORS.map((motor) => made.arm!.servo(motor).get("Present_Position"));

  it("e: a start runs the task's turns on the real arm's path: the arm moves by each action, and only goals pass the guard", async () => {
    const s = await enabledReal();
    const atRest = writesOf(s);
    await s.clock.sleep(1);
    expect(writesOf(s)).toEqual(atRest); // the station writes nothing while it holds

    s.service.answers.push(action({ z: 1 }), action({ x: 1 }));
    const started = await s.ask<TaskAnswer>(start("Lift the arm, then reach forward"));
    expect(started.answer).toEqual({ accepted: true });
    await s.until(() => s.service.held === 1 && s.status().task?.phase === "Thinking", "the third turn's request");

    // the servos beneath the guard moved by each action: each next turn observed the pose the action before it left
    const poses = posesOf(s);
    expect(poses).toHaveLength(3);
    expect(poses[1]!.z - poses[0]!.z).toBeCloseTo(1, 0);
    expect(poses[2]!.x - poses[1]!.x).toBeCloseTo(1, 0);
    expect(eventsOf(s, "execution").map((event) => event.data["status"])).toEqual(["completed", "completed"]);
    expect(s.service.received).toHaveLength(3);

    // the guard refused nothing, and what it let through for the task were goals and nothing else
    const during = writesOf(s);
    expect(during[GOALS]).toBeGreaterThan(atRest[GOALS] ?? 0);
    expect({ ...during, [GOALS]: 0 }).toEqual({ ...atRest, [GOALS]: 0 });
    expect(s.guard()!.status().refusedCount).toBe(0);
    // while the third turn thinks the arm holds, and nothing is written
    await s.clock.sleep(1);
    expect(writesOf(s)).toEqual(during);

    // the status tells a real arm, its line and the task
    expect(s.status()).toMatchObject({ arm: "real", action: "task", taskPausedBy: null });
    expect(s.status().line).toMatchObject({ refused: 0, refusals: [], lineErrors: 0, isLost: false });
    expect(s.status().task).toMatchObject({ totalSteps: 2, isStopLatched: false, error: null });
    expect(torqueOf(s)).toEqual(MOTORS.map(() => true));
    expectEventsBeforeStatus(s.messages);

    // disable is refused while the task holds the arm; after a clear the station disables and closes its line
    await expect(s.ask({ type: "disable" })).rejects.toThrow(HELD_DISABLE);
    await s.ask(task("clear"));
    await s.until(() => isIdleIn(s, "Holding"), "the clear");
    expect((await s.ask<DisableResult>({ type: "disable" })).isLineClosed).toBe(true);
    expect(s.status()).toMatchObject({ robot: "OFF", arm: null, line: null, task: null });
    expect(torqueOf(s)).toEqual(MOTORS.map(() => false));
  });

  it("e: on the real arm's path an action over the limit of its size writes nothing, and neither does the pause at the limit of turns", async () => {
    const s = await enabledReal();
    const atRest = writesOf(s);
    s.service.answers.push(actionWith({ z: -15 }, -1), action({ z: 1 }));
    await s.ask(start("Lower the arm", SERVICE, { turns: 1, isActionLimited: true }));
    await s.until(() => isIdleIn(s, "Paused"), "the pause at the limit of turns");
    expect(s.status()).toMatchObject({ taskPausedBy: "limit", robot: "READY", arm: "real", action: null });
    expect(eventsOf(s, "execution").map((event) => event.data)).toMatchObject([
      { status: "rejected", error: { code: "UnreachablePoseError", message: OVER_15 } },
    ]);
    // the rejected turn and the pause after it gave the servos nothing but reads
    expect(writesOf(s)).toEqual(atRest);
    expect(s.guard()!.status().refusedCount).toBe(0);
    expect(torqueOf(s)).toEqual(MOTORS.map(() => true));

    // a resume runs one more turn, whose action within the limit moves the arm; then the limit pauses again
    await s.ask(task("resume"));
    await s.until(() => isIdleIn(s, "Paused") && eventsOf(s, "execution").length === 2, "the second pause");
    expect(eventsOf(s, "execution")[1]!.data).toMatchObject({ status: "completed" });
    expect(writesOf(s)[GOALS]).toBeGreaterThan(atRest[GOALS] ?? 0);
    expect(s.status()).toMatchObject({ taskPausedBy: "limit", robot: "READY" });
    expect(s.status().line).toMatchObject({ refused: 0, refusals: [], isLost: false });
    expect(s.service.received).toHaveLength(2);
    expect([s.service.held, s.service.cancelled]).toEqual([0, 0]);
  });

  it("e: the stop bar during a task on the real arm's path is STOP MOTION: the arm brakes and holds with its torque on", async () => {
    const s = await enabledReal();
    s.service.answers.push(action({ z: -6 }));
    await s.ask(start("Lower the arm"));
    await s.until(() => s.status().task?.phase === "Executing", "the motion");
    await s.clock.sleep(0.3);

    expect(await s.ask({ type: "stop" })).toBeNull();
    await s.until(() => isIdleIn(s, "Stopped") && s.status().control === "HOLD", "the stop");
    expect(s.status().task).toMatchObject({ isStopLatched: true });
    expect(s.status()).toMatchObject({ robot: "READY", control: "HOLD", fault: null, arm: "real", action: null, taskPausedBy: null });
    expect(s.status().line).toMatchObject({ refused: 0, refusals: [], isLost: false });
    expect(eventsOf(s, "stopping").map((event) => event.data["message"])).toEqual(["STOP MOTION activated"]);
    expect(torqueOf(s)).toEqual(MOTORS.map(() => true));
    // it stays where it stopped: nothing is written while it holds, and no servo moves
    await s.clock.sleep(1);
    const held = writesOf(s);
    const steps = stepsOf(s);
    await s.clock.sleep(1);
    expect(writesOf(s)).toEqual(held);
    expect(stepsOf(s)).toEqual(steps);
    expect(torqueOf(s)).toEqual(MOTORS.map(() => true));

    // latched: nothing starts until the reset; then the task runs again from where the arm stopped, on its way
    await expect(s.ask(task("resume"))).rejects.toThrow("ValueError: Reset STOP MOTION before continuing");
    expect(s.service.received).toHaveLength(1);
    await s.ask(task("reset_stop"));
    expect((await s.ask<TaskAnswer>(task("resume"))).answer).toEqual({ accepted: true });
    await s.until(() => s.service.held === 1 && posesOf(s).length === 2, "the turn after the reset");
    const poses = posesOf(s);
    expect(poses[1]!.z).toBeLessThan(poses[0]!.z - 0.05);
    expect(poses[1]!.z).toBeGreaterThan(poses[0]!.z - 5.5);
    expect(s.guard()!.status().refusedCount).toBe(0);
  });

  it("e: a line lost during a task: the robot faults and the task ends; nothing more is asked of the model or written; clear and disable work", async () => {
    const s = await enabledReal();
    s.service.answers.push(action({ z: 1 }));
    await s.ask(start("Lift the arm"));
    await s.until(() => s.service.held === 1 && s.status().task?.phase === "Thinking", "the second turn's request");
    s.unplug();
    await s.until(() => s.status().robot === "FAULT" && s.status().task?.isBusy === false, "the fault");

    // what the console tells: the fault as the task's failure, the turn failed, the model's request cancelled
    const told = s.status();
    expect(told).toMatchObject({ robot: "FAULT", arm: "real", action: null, taskPausedBy: null });
    expect(told.line).toMatchObject({ isLost: true, refused: 0 });
    expect(told.task).toMatchObject({ phase: "Fault", isBusy: false, isStopLatched: false, totalSteps: 1 });
    expect(told.task!.error).toContain("RuntimeError: Station fault: FAULT");
    expect(told.task!.activeTurn).toMatchObject({ turn_number: 2, phase: "Failed" });
    expect(kindsOf(s).slice(-3)).toEqual(["execution", "turn_end", "error"]);
    expect(eventsOf(s, "execution").pop()!.data).toMatchObject({ status: "failed" });
    expect(s.service.cancelled).toBe(1);

    // nothing more is asked of the model, and the station tries no write; the servos keep their torque
    const asked = s.service.received.length;
    const written = JSON.stringify([writesOf(s), s.packets.length]);
    await s.clock.sleep(3);
    expect(s.service.received).toHaveLength(asked);
    expect(JSON.stringify([writesOf(s), s.packets.length])).toBe(written);
    expect(eventsOf(s, "turn_started")).toHaveLength(2);
    expect(torqueOf(s)).toEqual(MOTORS.map(() => true));
    await expect(s.ask(task("resume"))).rejects.toThrow("ValueError: A paused task and stable enabled robot are required");
    await expect(s.ask({ type: "home" })).rejects.toThrow(HELD);

    // "clear" is accepted while the robot is in FAULT and ends the task; then the station disables
    expect((await s.ask<TaskAnswer>(task("clear"))).answer).toEqual({ accepted: true });
    await s.until(() => s.status().task?.task === null && s.status().task?.isBusy === false, "the clear");
    expect(s.status().task).toMatchObject({ phase: "Fault", task: null });
    expect(s.status().robot).toBe("FAULT");
    const disabled = await s.ask<DisableResult>({ type: "disable" });
    expect(disabled.positions).toEqual({});
    expect(s.status()).toMatchObject({ robot: "OFF", arm: null, line: null, task: null, taskPausedBy: null });
    expect(s.service.received).toHaveLength(asked);
  });

  it("e: with the robot in FAULT a disable is taken while the task is there, and the console goes with it", async () => {
    const s = await enabledReal();
    await s.ask(start("Wait for the answer"));
    await s.until(() => s.service.held === 1, "the request");
    // the arm holds and the task is there: refused
    await expect(s.ask({ type: "disable" })).rejects.toThrow(HELD_DISABLE);
    s.unplug();
    await s.until(() => s.status().robot === "FAULT", "the fault");
    expect(s.status().task?.task).toMatchObject({ instruction: "Wait for the answer" });

    const disabled = await s.ask<DisableResult>({ type: "disable" });
    expect(disabled.positions).toEqual({});
    expect(s.status()).toMatchObject({ robot: "OFF", arm: null, line: null, task: null, taskPausedBy: null });
    expect(s.service.cancelled).toBe(1);
    const asked = s.service.received.length;
    await s.clock.sleep(2);
    expect(s.service.received).toHaveLength(asked);
    await expect(s.ask(task("resume"))).rejects.toThrow("RuntimeError: Open the station first");
  });

  it("tells the limits a task runs with on a real arm's path too, through a start, a pause, a resume and a clear", async () => {
    const s = await enabledReal();
    expect(s.status().taskLimits).toBeNull();
    s.service.answers.push(action({ z: 1 }), action({ z: 1 }));
    const limits = { turns: 1, isActionLimited: true };
    expect((await s.ask<TaskAnswer>(start("Lift the arm", SERVICE, limits))).answer).toEqual({ accepted: true });
    expect(s.status()).toMatchObject({ arm: "real", taskLimits: limits });
    await s.until(() => isIdleIn(s, "Paused"), "the pause at the limit of turns");
    expect(s.status()).toMatchObject({ arm: "real", taskPausedBy: "limit", taskLimits: limits });
    expect((await s.ask<TaskAnswer>(task("resume"))).answer).toEqual({ accepted: true });
    expect(s.status().taskLimits).toEqual(limits);
    await s.until(() => isIdleIn(s, "Paused"), "the second pause at the limit of turns");
    expect(s.status().taskLimits).toEqual(limits);
    await s.ask(task("clear"));
    await s.until(() => s.status().task?.task == null, "the end of the clearing");
    expect(s.status()).toMatchObject({ arm: "real", taskLimits: null });
  });
});

describe("the limits the status tells of the task that is there (status.taskLimits)", () => {
  /** Every status the station has told so far. */
  const statusesOf = (made: Station): StationStatus[] =>
    made.messages.flatMap((message) => (message.kind === "event" && message.event.type === "status" ? [message.event.status] : []));

  it("tells the limits a start was taken with while its task is there: through the start, a pause, a resume and the clear", async () => {
    const s = await enabledStation();
    expect(s.status().taskLimits).toBeNull();
    s.service.answers.push(action({ z: 1 }), action({ z: 1 }), action({ x: 1 }), action({ x: 1 }));
    const limits = { turns: 2, isActionLimited: true };
    expect((await s.ask<TaskAnswer>(start("Lift the arm, then reach forward", SERVICE, limits))).answer).toEqual({ accepted: true });
    expect(s.status().taskLimits).toEqual(limits);
    await s.until(() => isIdleIn(s, "Paused"), "the pause at the limit of turns");
    expect(s.status()).toMatchObject({ taskPausedBy: "limit", taskLimits: limits });
    expect((await s.ask<TaskAnswer>(task("resume"))).answer).toEqual({ accepted: true });
    expect(s.status().taskLimits).toEqual(limits);
    await s.until(() => isIdleIn(s, "Paused"), "the second pause at the limit of turns");
    expect(s.status().taskLimits).toEqual(limits);
    // no status told a task without its limits, or limits without a task
    const told = statusesOf(s);
    expect(told.filter((status) => status.task?.task != null).length).toBeGreaterThan(0);
    for (const status of told) {
      expect(status.taskLimits).toEqual(status.task?.task != null ? limits : null);
    }
    // the task is there until its clearing has ended, and its limits with it
    await s.ask(task("clear"));
    await s.until(() => s.status().task?.task == null, "the end of the clearing");
    expect(s.status().task).toMatchObject({ task: null });
    expect(s.status().taskLimits).toBeNull();
  });

  it("tells a task that was started without limits as one without limits, and the next task's own limits", async () => {
    const s = await enabledStation();
    s.service.answers.push(action({ z: 1 }));
    expect((await s.ask<TaskAnswer>(start("Lift the arm"))).answer).toEqual({ accepted: true });
    expect(s.status().taskLimits).toEqual({ turns: 0, isActionLimited: false });
    // a "start" that is refused for its limits changes nothing of the task that is there
    await expect(s.ask(start("Again", SERVICE, { turns: -1, isActionLimited: true }))).rejects.toThrow(LIMITS);
    expect(s.status().taskLimits).toEqual({ turns: 0, isActionLimited: false });
    await s.ask(task("pause"));
    await s.until(() => s.status().task?.isBusy === false, "the pause");
    expect(s.status().taskLimits).toEqual({ turns: 0, isActionLimited: false });
    await s.ask(task("clear"));
    await s.until(() => s.status().task?.task == null, "the end of the clearing");
    expect(s.status().taskLimits).toBeNull();
    // the next task runs with its own limits, not with the ones of the task before it
    const limits = { turns: 1, isActionLimited: true };
    s.service.answers.push(action({ x: 1 }));
    expect((await s.ask<TaskAnswer>(start("Reach forward", SERVICE, limits))).answer).toEqual({ accepted: true });
    expect(s.status().taskLimits).toEqual(limits);
    await s.until(() => isIdleIn(s, "Paused"), "the pause at the limit of one turn");
    expect(s.status()).toMatchObject({ taskPausedBy: "limit", taskLimits: limits });
  });
});
