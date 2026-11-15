// The turn loop's adapter where no record of PEAR reaches: the cancellation of a wait, the page's frame encoder, a
// failure's result at a snapshot, an observation the adapter did not issue.
//
// PEAR has no adapter: its turn loop (agent_loop/agent_loop.py) drives PEAR's robot itself, and turns an
// observation's frames into the model's message in `ObservationMessage.build` (agent_loop/messages.py), which saves
// each frame as a JPEG file after the robot has observed. In pear.js the frames are encoded by a function of the
// page, which `AgentRobotAdapter.observe` calls: the encoder is to pear.js what the saving of the JPEG files is to
// PEAR. `StationAgentLoop.step` holds `_observe` in its `try` with no turn yet, so whatever fails there stops the
// robot (`self.robot.stop()`) and is raised out of the step; the task's run (gui/console/task_run.py) ends with it.
//
// These are expectations written by hand: no record of PEAR holds a failing encoder, a wait that is cancelled, a
// result at a snapshot or a copy of an observation. What PEAR does was run on PEAR's own StationAgentLoop over PEAR's
// own robot on its stepped rig (the station "so101_quick" with the drawn cameras, opened and at rest), and the rows
// below are that run's:
//
//   one step of the loop, the message cannot be built
//     a frame that is no uint8 RGB image      raises ValueError: Expected a uint8 RGB image from the wrist camera
//     the JPEG cannot be saved (OSError)      raises that OSError
//     the task's folder cannot be made        raises that NotADirectoryError
//       each: the robot is stopped once (the generation goes up by one, the robot stays READY), it has observed
//       once, no turn is counted or kept, the session is not blocked, and the one event is the phase "Observing"
//   one step, the operator pauses when the phase "Observing" is reported
//     raises OperatorPaused: Operation interrupted by the operator; the robot is stopped once and has not observed;
//     no turn is counted or kept
//   wait_stationary with a cancellation that is set, with no observation or with the robot's own
//     raises OperatorPaused: Operation interrupted by the operator; the generation and the status stay
//   wait_stationary with a cancellation that is not set    returns the snapshot of the HOLD
//   failure_result(RuntimeError("the model did not answer")) after an action of z +0.02 m, with the status taken
//   before the action as its snapshot
//     status failed, settled, not reached, error {code RuntimeError, message}; measured_position [0, 0, 0, 0, 0, 1],
//     tracking_error all 0, measured_state z 22.6; without a snapshot, or with None: measured as now (joint 1 at
//     0.0001 rad, z 22.7)
//   an observation that is a copy of the robot's
//     a copy                                  is_holding True; completed
//     a copy of another session               is_holding raises, and the action is rejected with, ValueError:
//                                             Observation belongs to a different station session
//     a copy of another operation             the same with: Observation invalidated by another operation
//
// pear.js's loop reads a frame as JPEG bytes, so where PEAR refuses a frame that is no uint8 RGB image, it refuses
// one that is no JPEG ("Expected a JPEG image from the wrist camera", src/agent/messages.ts).

import { describe, expect, test } from "vitest";

import { StationAgentLoop } from "../../src/agent/agent_loop";
import { sleep as timerSleep } from "../../src/agent/clock";
import { SINGLE_ARM_POSE_FORMAT } from "../../src/agent/formats";
import type { ModelState, SingleArmDelta } from "../../src/protocol/types";
import { OSError, RuntimeError } from "../../src/python/errors";
import { AgentRobotAdapter, type EncodeFrame } from "../../src/station/robot";
import type { Observation } from "../../src/station/schemas";
import { ScriptedClient } from "../agent/stand_ins";
import { brief, caught, delta, handRig, measured, turns } from "./by_hand";
import type { DrawnFrame } from "./rig";

type Frame = DrawnFrame | Uint8Array;
type Adapter = AgentRobotAdapter<ModelState, SingleArmDelta, Frame>;
type Held = Awaited<ReturnType<Adapter["observe"]>>;

const ACTION = delta(0.02) as unknown as SingleArmDelta;
const PAUSED = "threw OperatorPaused: Operation interrupted by the operator";
const FOREIGN = "Observation belongs to a different station session";
const INVALIDATED = "Observation invalidated by another operation";
const NOT_WRITTEN = "the frame could not be written";
/** The shortest bytes the loop takes for a JPEG. */
const jpeg = (): Uint8Array => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

/** The robot at rest with PEAR's drawn cameras, and the adapter over it with the encoder `encode`. */
async function adapted(encode: EncodeFrame<Frame> = jpeg) {
  const rig = await handRig({ cameras: "drawn" });
  const counts = { stop: 0, observe: 0 };
  const { robot } = rig;
  const stop = robot.stop.bind(robot);
  robot.stop = () => {
    counts.stop += 1;
    return stop();
  };
  const observe = robot.observe.bind(robot);
  robot.observe = () => {
    counts.observe += 1;
    return observe();
  };
  const generation = (): number => robot.controlLoop.snapshot().generation;

  return { ...rig, counts, generation, adapter: new AgentRobotAdapter<ModelState, SingleArmDelta, Frame>(robot, encode) };
}

/** What one step of the turn loop over the adapter did, as the run of PEAR's loop printed it. */
interface StepOutcome {
  step: string;
  /** How often the robot was stopped and how often it observed. */
  stops: number;
  observations: number;
  /** By how much the control loop's generation went up. */
  generations: number;
  turnCount: number;
  lastTurn: unknown;
  blockedReason: string | null;
  status: string;
  events: string[];
  /** How often the model was asked. */
  asked: number;
}

/** Runs one step of the turn loop over the adapter with `encode`; `pauseOn` names the event at which the operator
 * pauses. */
async function stepOf(encode: EncodeFrame<Frame>, pauseOn: string | null = null): Promise<StepOutcome> {
  const { robot, clock, counts, generation, adapter } = await adapted(encode);
  const client = new ScriptedClient("system", { timeoutS: 60 });
  let drawn = 0;
  const session = new StationAgentLoop(adapter, client, {
    actionFormat: SINGLE_ARM_POSE_FORMAT,
    timeoutS: 60,
    uuid: () => `loop-uuid-${++drawn}`,
    // PEAR's loop reads the clock the robot reads, and a wait for the arm is a sleep of the station's clock
    clock: () => clock.now,
    sleep: (seconds, wake) => (wake !== undefined ? timerSleep(seconds, wake) : clock.sleep(seconds)),
  });
  const cancellation = new AbortController();
  const events: string[] = [];
  const before = generation();

  const step = await caught(() =>
    session.step({
      cancellation: cancellation.signal,
      attemptId: "attempt-1",
      onEvent: (kind, data) => {
        events.push(`${kind}:${JSON.stringify(data)}`);
        if (kind === pauseOn) {
          cancellation.abort();
        }
      },
    }),
  );
  const outcome: StepOutcome = {
    step,
    stops: counts.stop,
    observations: counts.observe,
    generations: generation() - before,
    turnCount: session.turnCount,
    lastTurn: session.lastTurn,
    blockedReason: session.blockedReason,
    status: String(robot.status().status),
    events,
    asked: client.modelInputs.length,
  };
  await robot.close();

  return outcome;
}

/** PEAR's row of a step whose message could not be built, but for what the step raised. */
const NOT_BUILT: Omit<StepOutcome, "step"> = {
  stops: 1,
  observations: 1,
  generations: 1,
  turnCount: 0,
  lastTurn: null,
  blockedReason: null,
  status: "READY",
  events: ['phase:{"phase":"Observing"}'],
  asked: 0,
};

describe("the turn loop over the adapter when the frames cannot be encoded ends as PEAR's when its message cannot be built (expectations written by hand)", () => {
  const failing: [string, EncodeFrame<Frame>, string][] = [
    [
      "an encoder that throws",
      () => {
        throw new OSError(NOT_WRITTEN);
      },
      `threw OSError: ${NOT_WRITTEN}`,
    ],
    [
      "an encoder that rejects after a while",
      async () => {
        await turns(2);
        throw new OSError(NOT_WRITTEN);
      },
      `threw OSError: ${NOT_WRITTEN}`,
    ],
    ["an encoder that returns a string", () => "data:image/jpeg;base64,/9j/" as never, "threw ValueError: Expected a JPEG image from the wrist camera"],
    ["an encoder that returns the pixels and no JPEG", () => new Uint8Array(2 * 3 * 3), "threw ValueError: Expected a JPEG image from the wrist camera"],
    ["an encoder that returns an array of numbers", () => [0xff, 0xd8, 0xff, 0xd9] as never, "threw ValueError: Expected a JPEG image from the wrist camera"],
    ["an encoder that returns nothing", async () => undefined as never, "threw ValueError: Expected a JPEG image from the wrist camera"],
  ];

  test.each(failing)("%s: the robot is stopped, the step throws, and no turn is counted", async (_name, encode, step) => {
    expect(await stepOf(encode)).toEqual({ ...NOT_BUILT, step });
  });

  test("the operator's pause as the turn begins to observe ends the wait: the robot is stopped and has not observed", async () => {
    let encoded = 0;
    const outcome = await stepOf(() => {
      encoded += 1;
      return jpeg();
    }, "phase");

    expect(outcome).toEqual({ ...NOT_BUILT, step: PAUSED, observations: 0 });
    expect(encoded).toBe(0);
  });
});

describe("the adapter hands a wait its cancellation (expectations written by hand)", () => {
  test("a wait with a cancellation that is set is interrupted, with no observation and with the adapter's own", async () => {
    const { robot, adapter, generation } = await adapted();
    const held = await adapter.observe();
    const before = generation();
    const set = new AbortController();
    set.abort();

    expect(await caught(() => adapter.waitStationary(null, { cancellation: set.signal }))).toBe(PAUSED);
    expect(await caught(() => adapter.waitStationary(held, { cancellation: set.signal }))).toBe(PAUSED);
    expect([generation(), String(robot.status().status)]).toEqual([before, "READY"]);

    const snapshot = await adapter.waitStationary(null, { cancellation: new AbortController().signal });
    expect([snapshot.status, snapshot.generation]).toEqual(["HOLD", before]);
    expect((await adapter.waitStationary(held)).generation).toBe(before);
    await robot.close();
  });
});

describe("the frame encoder is the page's: what the adapter does with what it does (expectations written by hand)", () => {
  test("the encoder is given each frame of the robot's observation with its role, and what it returns is the loop's image", async () => {
    const seen: [Frame, string, Observation<Frame>][] = [];
    const bytes = jpeg();
    const { robot, adapter } = await adapted((frame, role, observation) => {
      seen.push([frame, role, observation]);
      return bytes;
    });

    const held = await adapter.observe();

    expect(Object.keys(held.images)).toEqual(["wrist"]);
    expect(held.images["wrist"]).toBe(bytes);
    expect(seen.length).toBe(1);
    const [frame, role, observation] = seen[0]!;
    expect(role).toBe("wrist");
    expect(frame).toBe(observation.images["wrist"]);
    expect(frame).toEqual({ shape: [480, 640, 3] });
    expect([observation.observation_id, observation.session_id]).toEqual([held.observationId, held.sessionId]);
    await robot.close();
  });

  test("an encoder that answers later is waited for: the loop's image is its bytes", async () => {
    const bytes = jpeg();
    const { robot, adapter } = await adapted(async () => {
      await turns(3);
      return bytes;
    });

    const held = await adapter.observe();

    expect(held.images["wrist"]).toBe(bytes);
    expect(held.images["wrist"]).toBeInstanceOf(Uint8Array);
    await robot.close();
  });

  test("an encoder that takes long: the observation is handed on that much older, and is the robot's while the arm holds", async () => {
    // (PEAR saves the frames after its robot has observed, and checks an observation's session and operation, not
    // its age)
    const rig = await adapted(async () => {
      for (let period = 0; period < 30; period++) {
        await rig.clock.sleep(rig.robot.controlPeriodS);
      }
      return jpeg();
    });
    const { robot, clock, adapter } = rig;
    const before = clock.now;

    const held = await adapter.observe();

    expect(held.capturedMonotonicS).toBe(before);
    expect(clock.now - held.capturedMonotonicS).toBeCloseTo(30 * robot.controlPeriodS, 9);
    expect(adapter.isHolding(held)).toBe(true);
    expect(brief((await adapter.execute(ACTION, { referenceObservation: held })) as never)).toEqual({ status: "completed", error: null });
    expect(measured(robot)[1]).toBe("0.0001");
    await robot.close();
  });

  test("a robot stopped while its frames are encoded: the observation is handed on, and refused as one of another operation", async () => {
    const rig = await adapted(async () => {
      await rig.robot.stop();
      return jpeg();
    });
    const { robot, adapter } = rig;

    const held = await adapter.observe();

    expect(() => adapter.isHolding(held)).toThrow(INVALIDATED);
    expect(await caught(() => adapter.waitStationary(held))).toBe(`threw ValueError: ${INVALIDATED}`);
    expect(brief((await adapter.execute(ACTION, { referenceObservation: held })) as never)).toEqual({
      status: "rejected",
      error: { code: "ValueError", message: INVALIDATED },
    });
    expect(measured(robot)[1]).toBe("0.0000");
    await robot.close();
  });

  const failures: [string, (error: Error) => EncodeFrame<Frame>][] = [
    [
      "throws",
      (error) => () => {
        throw error;
      },
    ],
    [
      "rejects after a while",
      (error) => async () => {
        await turns(2);
        throw error;
      },
    ],
  ];

  test.each(failures)("an encoder that %s: the observation ends with its error, and the adapter itself leaves the arm as it is", async (_name, encoder) => {
    const error = new OSError(NOT_WRITTEN);
    const { robot, adapter, counts, generation } = await adapted(encoder(error));
    const before = generation();

    const ended = await adapter.observe().then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(ended).toBe(error);
    // (the robot has observed; it is the loop's step that stops the robot, as PEAR's does)
    expect([counts.observe, counts.stop, generation()]).toEqual([1, 0, before]);
    await robot.close();
  });

  const values: [string, unknown][] = [
    ["a string", "data:image/jpeg;base64,/9j/"],
    ["an array of numbers", [0xff, 0xd8, 0xff, 0xd9]],
    ["an ArrayBuffer", new ArrayBuffer(4)],
    ["nothing", undefined],
  ];

  test.each(values)("what the encoder returns is handed to the loop as it is, which checks it: %s", async (_name, value) => {
    const { robot, adapter } = await adapted(() => value as never);

    const held = await adapter.observe();

    expect(held.images["wrist"]).toBe(value);
    await robot.close();
  });
});

describe("a failure's result is measured at the snapshot it is given (expectations written by hand)", () => {
  test("with the status taken before an action, without a snapshot, and with none", async () => {
    const { robot, adapter } = await adapted();
    const old = robot.status(true);
    expect(brief((await adapter.execute(ACTION, {})) as never)).toEqual({ status: "completed", error: null });
    const error = new RuntimeError("the model did not answer");
    const record = (options: { snapshot?: unknown }): Record<string, unknown> =>
      (
        adapter.failureResult(error, { formatName: SINGLE_ARM_POSE_FORMAT.name, ...(options as object) }) as unknown as {
          toRecord(): Record<string, unknown>;
        }
      ).toRecord();
    const rounded = (values: unknown): string[] => (values as number[]).map((value) => value.toFixed(4));

    const atSnapshot = record({ snapshot: old });
    const now = record({});
    const withNone = record({ snapshot: null });

    expect(atSnapshot).toEqual({
      status: "failed",
      settled: true,
      reached: false,
      measured_position: [0, 0, 0, 0, 0, 1],
      tracking_error: [0, 0, 0, 0, 0, 0],
      measured_state: { arm: { x: 39.1, y: 0, z: 22.6, pitch: 0, roll: -0.05 }, gripper: { width: 6 } },
      gripper_outcome: null,
      error: { code: "RuntimeError", message: "the model did not answer" },
    });
    expect(rounded(now["measured_position"])).toEqual(["0.0001", "0.0001", "-0.0016", "0.0015", "-0.0000", "1.0000"]);
    expect(now["measured_state"]).toEqual({ arm: { x: 39.1, y: 0, z: 22.7, pitch: 0, roll: -0.05 }, gripper: { width: 6 } });
    expect({ ...now, measured_position: null, tracking_error: null, measured_state: null }).toEqual({
      ...atSnapshot,
      measured_position: null,
      tracking_error: null,
      measured_state: null,
    });
    expect(withNone).toEqual(now);
    await robot.close();
  });
});

describe("an observation the adapter did not issue is checked by the values it holds, as PEAR's dictionary is (expectations written by hand)", () => {
  const copies: [string, (held: Held) => Held, string | null][] = [
    ["a copy", (held) => ({ ...held }), null],
    ["a copy of another session", (held) => ({ ...held, sessionId: "another" }), FOREIGN],
    [
      "a copy of another operation",
      (held) => ({
        ...held,
        controlSnapshot: { ...held.controlSnapshot, generation: (held.controlSnapshot as unknown as { generation: number }).generation + 1 } as never,
      }),
      INVALIDATED,
    ],
  ];

  test.each(copies)("%s", async (_name, copyOf, refusal) => {
    const { robot, adapter } = await adapted();
    const copy = copyOf(await adapter.observe());

    const holding = await caught(() => adapter.isHolding(copy));
    const waited = await caught(async () => typeof (await adapter.waitStationary(copy)));
    const result = await adapter.execute(ACTION, { referenceObservation: copy });

    expect(holding).toBe(refusal === null ? "returned true" : `threw ValueError: ${refusal}`);
    expect(waited).toBe(refusal === null ? 'returned "object"' : `threw ValueError: ${refusal}`);
    expect(brief(result as never)).toEqual(
      refusal === null ? { status: "completed", error: null } : { status: "rejected", error: { code: "ValueError", message: refusal } },
    );
    expect(measured(robot)[1]).toBe(refusal === null ? "0.0001" : "0.0000");
    await robot.close();
  });

  test("an observation of the session before is refused in the next one, as a copy of it is", async () => {
    const { robot, clock, adapter } = await adapted();
    const held = await adapter.observe();
    await robot.close();
    await robot.open();
    clock.controlLoop = robot.controlLoop;
    await robot.waitStationary();
    expect(robot.sessionId).not.toBe(held.sessionId);

    for (const observation of [held, { ...held }]) {
      expect(await caught(() => adapter.isHolding(observation))).toBe(`threw ValueError: ${FOREIGN}`);
      expect(brief((await adapter.execute(ACTION, { referenceObservation: observation })) as never)).toEqual({
        status: "rejected",
        error: { code: "ValueError", message: FOREIGN },
      });
    }
    await robot.close();
  });
});
