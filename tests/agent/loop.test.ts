// PEAR's StationAgentLoop ran each task of tests/fixtures/agent/loop.json with its stand-in client on its stand-in
// SO-101 (tools/fixtures/agent_fixtures.py, LoopRun). Here pear.js's loop runs the same tasks on a robot that
// replays PEAR's and a model that follows the same script, and must ask the same of the robot, report the same
// events in the same order, show the model the same input, and return or throw the same.

import { describe, expect, test } from "vitest";

import { StationAgentLoop } from "../../src/agent/agent_loop";
import { modelOutputRecord, type EventData, type ModelInput } from "../../src/agent/clients/schemas";
import { OperatorPaused } from "../../src/agent/exceptions";
import { SINGLE_ARM_POSE_FORMAT } from "../../src/agent/formats";
import { resultRecord } from "../../src/agent/robot";
import type { MotionResult } from "../../src/protocol/types";
import { expectOutcome, outcomeOf } from "./client_scenarios";
import { bytesOf, loadFixture, type RecordedImage, type RecordedOutcome } from "./fixtures";
import {
  frameBytes,
  ReplayRobot,
  ScriptedClient,
  type ErrorSpec,
  type ModelOperation,
  type ResultRecord,
  type RobotCall,
  type TraceEntry,
} from "./stand_ins";

interface Hook {
  on: string;
  phase?: string;
  do: string;
}

interface RecordedInput {
  text: string;
  images: Array<{ camera_name: string; uuid: string; name: string; is_jpeg: boolean }>;
  reference_images: string[];
}

interface LoopStep {
  op: "step" | "record_interruption" | "recover" | "settle" | "close";
  attempt_id?: string;
  model?: ModelOperation[];
  hooks?: Hook[];
  cancelled_before?: boolean;
  outcome?: RecordedOutcome;
  model_inputs?: RecordedInput[];
  nested?: RecordedOutcome[];
  holding?: { checked: boolean; raised: ErrorSpec | null };
  trace: TraceEntry[];
  state: {
    turn_count: number;
    blocked_reason: string | null;
    feedback: string | null;
    previous_result: ResultRecord | null;
    last_turn: {
      attempt_id: string;
      observation_id: string;
      is_dispatched: boolean;
      model_output: EventData | null;
      station_result: ResultRecord | null;
    } | null;
  };
}

interface LoopScenario {
  name: string;
  about: string;
  timeout_s: number;
  reference_images?: RecordedImage[];
  session_id: string;
  action_mode: string;
  control_period_s: number;
  episode_id: string;
  client_label: string;
  steps: LoopStep[];
}

const scenarios = loadFixture<{ scenarios: LoopScenario[] }>("loop.json").scenarios;
/** What PEAR's console records of a pause (pear/deploy/station/gui/console/task_run.py). */
const CONSOLE_PAUSE = "The operator interrupted this turn; remaining motion was cancelled.";

/** Returns a result, or what a step threw, as a fixture records a step's outcome. */
async function resultOutcome(call: () => Promise<MotionResult> | MotionResult): Promise<RecordedOutcome> {
  return outcomeOf(async () => resultRecord(await call()));
}

function inputRecord(input: ModelInput): RecordedInput {
  return {
    text: input.text,
    images: input.images.map((image) => ({
      camera_name: image.cameraName,
      uuid: image.uuid,
      name: image.name!,
      is_jpeg: image.bytes[0] === 0xff && image.bytes[1] === 0xd8,
    })),
    reference_images: input.referenceImages.map((image) => image.uuid),
  };
}

async function runScenario(scenario: LoopScenario): Promise<void> {
  const robot = new ReplayRobot(scenario.action_mode, scenario.session_id, scenario.control_period_s);
  const client = new ScriptedClient("system", { timeoutS: 60 });
  // the session's identity, then the UUID of each frame a turn was given, as PEAR drew them
  const uuids = [
    scenario.episode_id,
    ...scenario.steps.flatMap((step) =>
      step.trace.flatMap((entry) =>
        entry[0] === "event" && entry[1] === "observation" ? Object.values(entry[2].image_uuids as object) : [],
      ),
    ),
  ] as string[];
  const clock = { now: 500 };
  const references = scenario.reference_images ?? [];
  const session = new StationAgentLoop(robot, client, {
    actionFormat: SINGLE_ARM_POSE_FORMAT,
    timeoutS: scenario.timeout_s,
    referenceImages: references.map((image) => ({ bytes: bytesOf(image.data), uuid: image.uuid })),
    uuid: () => uuids.shift() ?? "no UUID left",
    clock: () => clock.now,
  });
  expect(session.episodeId).toBe(scenario.episode_id);
  expect(ScriptedClient.LABEL).toBe(scenario.client_label);

  for (const [index, step] of scenario.steps.entries()) {
    const where = `step ${index} (${step.op})`;
    robot.begin(step.trace.flatMap((entry) => (entry[0] === "robot" ? [entry[1] as RobotCall] : [])));
    const inputsBefore = client.modelInputs.length;
    let outcome: RecordedOutcome | undefined;
    const nested: Array<Promise<RecordedOutcome>> = [];

    if (step.op === "step") {
      const cancellation = new AbortController();
      if (step.cancelled_before) {
        cancellation.abort();
      }
      client.script = step.model!;
      client.context = {
        watched: async () => {
          const deadline = Date.now() + ScriptedClient.WAIT_S * 1000;
          while (!robot.wasHoldChecked) {
            if (Date.now() > deadline) {
              throw new Error("The loop did not watch the request");
            }
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        },
        pause: () => cancellation.abort(),
        advanceClock: (seconds) => {
          clock.now += seconds;
        },
        changeRobot: () => {
          robot.holdingError = step.holding!.raised;
        },
      };
      const onEvent = (kind: string, data: EventData): void => {
        robot.trace.push(["event", kind, structuredClone(data)]);
        for (const hook of step.hooks ?? []) {
          if (hook.on !== kind || (hook.phase !== undefined && data.phase !== hook.phase)) {
            continue;
          }
          if (hook.do === "pause") {
            cancellation.abort();
          } else if (hook.do === "step") {
            nested.push(
              resultOutcome(() =>
                session.step({
                  cancellation: new AbortController().signal,
                  onEvent: () => undefined,
                  attemptId: "nested",
                }),
              ),
            );
          }
          // (what a hook does to PEAR's robot is in what the replayed robot does next)
        }
      };
      outcome = await resultOutcome(() =>
        session.step({ cancellation: cancellation.signal, onEvent, attemptId: step.attempt_id! }),
      );
    } else if (step.op === "record_interruption") {
      outcome = await resultOutcome(async () =>
        session.record(await session.failureResult(new OperatorPaused(CONSOLE_PAUSE))),
      );
    } else if (step.op === "close") {
      outcome = await outcomeOf(() => session.close());
    }

    if (step.outcome !== undefined) {
      expectOutcome(outcome!, step.outcome);
    }
    expect(robot.trace, `${where}: what the loop asked of the robot and reported`).toEqual(step.trace);
    expect(robot.callsLeft, `${where}: calls of the robot the loop did not make`).toEqual([]);
    if (step.op === "step") {
      const inputs = client.modelInputs.slice(inputsBefore);
      expect(inputs.map(inputRecord), `${where}: what the model was shown`).toEqual(step.model_inputs);
      for (const input of inputs) {
        // a turn carries the observation's own frame
        const observationId = step.state.last_turn!.observation_id;
        expect(input.images.map((image) => image.bytes)).toEqual(
          input.images.map((image) => frameBytes(observationId, image.cameraName)),
        );
      }
      expect(robot.wasHoldChecked, `${where}: whether the hold was checked`).toBe(step.holding!.checked);
      const nestedOutcomes = await Promise.all(nested);
      (step.nested ?? []).forEach((expected, position) => expectOutcome(nestedOutcomes[position]!, expected));
      expect(nestedOutcomes.length).toBe((step.nested ?? []).length);
    }

    const turn = session.lastTurn;
    expect(
      {
        turn_count: session.turnCount,
        blocked_reason: session.blockedReason,
        feedback: (session as unknown as { feedback: string | null }).feedback,
        previous_result: session.previousResult ? resultRecord(session.previousResult) : null,
        last_turn:
          turn === null
            ? null
            : {
                attempt_id: turn.attemptId,
                observation_id: turn.observation.observationId,
                is_dispatched: turn.isDispatched,
                model_output: turn.modelOutput ? modelOutputRecord(turn.modelOutput) : null,
                station_result: turn.stationResult ? resultRecord(turn.stationResult) : null,
              },
      },
      `${where}: the session afterwards`,
    ).toEqual(step.state);
  }
  expect(uuids, "UUIDs PEAR drew that the loop did not").toEqual([]);
}

describe("StationAgentLoop", () => {
  test.each(scenarios.map((scenario) => [scenario.name, scenario] as const))(
    "does what PEAR's loop did: %s",
    async (_name, scenario) => {
      await runScenario(scenario);
    },
  );

  test("the tasks cover every way a turn ends", () => {
    const steps = scenarios.flatMap((scenario) => scenario.steps.filter((step) => step.op === "step"));
    const outcomes = steps.map((step) => step.outcome!);
    const returned = outcomes.flatMap((outcome) => ("returned" in outcome ? [outcome.returned as ResultRecord] : []));
    const raised = outcomes.flatMap((outcome) => ("raised" in outcome ? [outcome.raised.type] : []));
    const events = steps.flatMap((step) => step.trace.flatMap((entry) => (entry[0] === "event" ? [entry[1]] : [])));

    expect(new Set(returned.map((result) => result.status))).toEqual(new Set(["completed", "rejected", "failed"]));
    expect(new Set(returned.flatMap((result) => result.gripper_outcome ?? []))).toEqual(
      new Set(["open", "closed", "stopped_before_closed"]),
    );
    expect(new Set(raised)).toEqual(new Set(["OperatorPaused", "SessionLost", "ContextLimit", "RuntimeError"]));
    expect(returned.some((result) => result.measured_position === null)).toBe(true);
    expect(events).toContain("diagnostic");
  });
});
