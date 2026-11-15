// What the agent loop reads of an error, whichever module of pear.js threw it: the name of the Python class PEAR
// raises there, and whether that class is a ValueError (a turn that ends with one is rejected, any other failed).

import { describe, expect, test } from "vitest";

import { StationAgentLoop } from "../../src/agent/agent_loop";
import { ContextLimit, SessionLost } from "../../src/agent/clients/client";
import { APIConnectionError, BadRequestError, statusError } from "../../src/agent/clients/openai";
import {
  isValueError,
  motionErrorOf,
  OperatorPaused,
  pythonErrorName,
  RuntimeError,
  TimeoutError,
  ValueError,
} from "../../src/agent/exceptions";
import { SINGLE_ARM_POSE_FORMAT } from "../../src/agent/formats";
import { ActionMode, type AgentRobot, type Observation } from "../../src/agent/robot";
import { ActionParseError, parseAction } from "../../src/protocol/action_parser";
import { PythonError } from "../../src/protocol/python_json";
import { MotionStatus, UNREACHABLE_POSE_ERROR, type MotionResult } from "../../src/protocol/types";
import * as kinematics from "../../src/so101/kinematics/errors";
import { frameBytes, ScriptedClient } from "./stand_ins";

function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error("Nothing was thrown");
}

describe("an error's Python class", () => {
  test("the classes of this module carry PEAR's names and extend one another as PEAR's do", () => {
    const cases: Array<[Error, string, boolean]> = [
      [new ValueError("v"), "ValueError", true],
      [new RuntimeError("r"), "RuntimeError", false],
      [new TimeoutError(), "TimeoutError", false],
      [new OperatorPaused("p"), "OperatorPaused", false],
      [new ContextLimit("c"), "ContextLimit", true],
      [new SessionLost("s"), "SessionLost", false],
      [new APIConnectionError(), "APIConnectionError", false],
      [statusError(400, '{"error": "no"}'), "BadRequestError", false],
    ];

    for (const [error, name, valueError] of cases) {
      expect(pythonErrorName(error)).toBe(name);
      expect(isValueError(error)).toBe(valueError);
    }
    expect(new OperatorPaused("p")).toBeInstanceOf(RuntimeError);
    expect(new SessionLost("s")).toBeInstanceOf(RuntimeError);
    expect(new ContextLimit("c")).toBeInstanceOf(ValueError);
    expect(statusError(400, "")).toBeInstanceOf(BadRequestError);
    expect(new TimeoutError().message).toBe("");
    expect(motionErrorOf(new ContextLimit("full"))).toEqual({ code: "ContextLimit", message: "full" });
  });

  test("an answer without an action is the protocol's error, under the name of what PEAR raises", () => {
    const refused = thrownBy(() => parseAction("no block"));
    const huge = `{"x": 1${"0".repeat(400)}, "y": 0, "z": 0, "pitch": 0, "roll": 0}`;
    const overflow = thrownBy(() => parseAction(`\`\`\`json\n{"arm": ${huge}, "gripper": {"width": 0}}\n\`\`\``));

    expect(refused).toBeInstanceOf(ActionParseError);
    expect([pythonErrorName(refused), isValueError(refused)]).toEqual(["ValueError", true]);
    expect([pythonErrorName(overflow), isValueError(overflow)]).toEqual(["OverflowError", false]);
    expect(pythonErrorName(new PythonError("JSONDecodeError", "m", true))).toBe("JSONDecodeError");
    expect(isValueError(new PythonError("KeyError", "m", false))).toBe(false);
  });

  test("the kinematics' errors, of classes of their own, are known by their names", () => {
    const unreachable = new kinematics.UnreachablePoseError("The target is out of reach.");

    expect(pythonErrorName(unreachable)).toBe(UNREACHABLE_POSE_ERROR);
    expect(isValueError(unreachable)).toBe(true);
    expect(isValueError(new kinematics.ValueError("refused"))).toBe(true);
    expect(motionErrorOf(unreachable)).toEqual({ code: UNREACHABLE_POSE_ERROR, message: unreachable.message });
  });

  test("what is no Python error is no ValueError", () => {
    expect([isValueError(new TypeError("t")), pythonErrorName(new TypeError("t"))]).toEqual([false, "TypeError"]);
    expect([isValueError("text"), pythonErrorName("text")]).toEqual([false, "Exception"]);
    expect(isValueError(null)).toBe(false);
    expect(isValueError({ isValueError: true })).toBe(true);
  });
});

describe("a pause that another module raises", () => {
  /** An OperatorPaused of a class this module does not know, as the station module may define its own. */
  class OperatorPausedElsewhere extends Error {
    override readonly name = "OperatorPaused";
  }

  test("ends the turn as PEAR's pause does: the failure is recorded and the pause thrown on", async () => {
    const observation: Observation = {
      observationId: "observation-1",
      sessionId: "session",
      capturedMonotonicS: 2,
      jointPositions: [0, 0, 0, 0, 0, 1],
      images: { wrist: frameBytes("observation-1", "wrist") },
      cameraTimestamps: { wrist: { receivedMonotonicS: 1 } },
      controlSnapshot: {},
    };
    const failures: unknown[] = [];
    const failed: MotionResult = {
      status: MotionStatus.FAILED,
      isSettled: true,
      targetReached: false,
      measuredPosition: null,
      trackingError: null,
      measuredState: null,
      gripperOutcome: null,
      error: { code: "OperatorPaused", message: "Stopped during dispatch" },
    };
    let stops = 0;
    const robot: AgentRobot = {
      actionMode: ActionMode.CARTESIAN,
      sessionId: "session",
      controlPeriodS: 0.005,
      lastErrorDiagnostics: null,
      waitStationary: () => ({}),
      observe: () => observation,
      modelState: () => ({ arm: { x: 20, y: 0, z: 10, pitch: 0.7, roll: 0 }, gripper: { width: 6 } }),
      isHolding: () => true,
      stop: () => {
        stops += 1;
      },
      execute: () => {
        throw new OperatorPausedElsewhere("Stopped during dispatch");
      },
      failureResult: (error) => {
        failures.push(error);
        return failed;
      },
    };
    const client = new ScriptedClient("system", { timeoutS: 60 });
    client.script = [
      {
        return: {
          answer: '```json\n{"arm": {"x": 0, "y": 0, "z": 1, "pitch": 0, "roll": 0}, "gripper": {"width": 0}}\n```',
          reasoning: "",
          reasoning_kind: "none",
          usage: {},
        },
      },
    ];
    const nothing = (): void => undefined;
    client.context = { watched: async () => undefined, pause: nothing, advanceClock: nothing, changeRobot: nothing };
    const session = new StationAgentLoop(robot, client, { actionFormat: SINGLE_ARM_POSE_FORMAT, timeoutS: 60 });

    const step = session.step({ cancellation: new AbortController().signal, onEvent: () => undefined, attemptId: "a" });

    await expect(step).rejects.toBeInstanceOf(OperatorPausedElsewhere);
    expect(failures.length).toBe(1);
    expect(failures[0]).toBeInstanceOf(OperatorPausedElsewhere);
    expect(stops).toBe(1);
    expect(session.previousResult).toBe(failed);
    expect(session.lastTurn!.isDispatched).toBe(true);
    expect(session.blockedReason).toBeNull();
  });
});
