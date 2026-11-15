// End to end, in TypeScript only: the agent loop with the real client against an HTTP server on 127.0.0.1 that
// speaks Chat Completions with a stream, through a task of three turns on a robot that moves as it is told. No
// fixture of PEAR here: what is checked is that the parts, each compared with PEAR elsewhere, work as one.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { StationAgentLoop } from "../../src/agent/agent_loop";
import type { EventData } from "../../src/agent/clients/schemas";
import { VLLMClient } from "../../src/agent/clients/vllm";
import { SINGLE_ARM_POSE_FORMAT } from "../../src/agent/formats";
import { ActionMode, ActionPhase, type AgentRobot, type Observation } from "../../src/agent/robot";
import { executionFeedback } from "../../src/protocol/feedback";
import { systemPrompt } from "../../src/protocol/system_prompt";
import { turnText } from "../../src/protocol/turn_text";
import {
  GripperOutcome,
  MotionStatus,
  type ModelState,
  type MotionResult,
  type SingleArmDelta,
} from "../../src/protocol/types";
import { frameBytes } from "./stand_ins";

const MODEL = "qwen3_8_27b";
const INSTRUCTION = "Pick up the red cube.";

interface ChatRequest {
  authorization: string | undefined;
  body: {
    model: string;
    stream: boolean;
    max_tokens: number | null;
    messages: Array<{
      role: string;
      content: string | Array<{ type: string; text?: string; image_url?: { url: string } | null; uuid?: string }>;
      reasoning?: string;
    }>;
  };
}

/** What the server's model answers, a turn after the other. */
const ANSWERS: Array<{ reasoning: string[]; action: SingleArmDelta }> = [
  {
    reasoning: ["The cube is ahead ", "and below the gripper."],
    action: { type: "single_arm_delta", arm: { x: 2, y: 0, z: -1.5, pitch: 0, roll: 0 }, gripper: { width: 1 } },
  },
  {
    reasoning: ["The jaw is around the cube."],
    action: { type: "single_arm_delta", arm: { x: 0, y: 0, z: 0, pitch: 0, roll: 0 }, gripper: { width: -1 } },
  },
  {
    reasoning: ["Holding it: ", "lift."],
    action: { type: "single_arm_delta", arm: { x: 0, y: 0, z: 4, pitch: 0, roll: 0 }, gripper: { width: 0 } },
  },
];

function answerText(action: SingleArmDelta): string {
  return `Next.\n\`\`\`json\n${JSON.stringify({ arm: action.arm, gripper: action.gripper })}\n\`\`\``;
}

/** A model server of the test: it streams the next scripted answer, and for the third turn first says that its
 * image cache lost the earlier frames. */
class ChatServer {
  readonly requests: ChatRequest[] = [];
  private answered = 0;
  private hasMissed = false;
  private readonly server: Server;

  constructor() {
    this.server = createServer((request, response) => void this.handle(request, response));
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));

    return `http://127.0.0.1:${(this.server.address() as { port: number }).port}/v1`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model" }] }));
      return;
    }

    const pieces: Buffer[] = [];
    for await (const piece of request) {
      pieces.push(piece as Buffer);
    }
    const body = JSON.parse(Buffer.concat(pieces).toString("utf8")) as ChatRequest["body"];
    this.requests.push({ authorization: request.headers.authorization, body });

    if (this.answered === 2 && !this.hasMissed) {
      this.hasMissed = true;
      const refusal = { error: { message: "Cache miss for image 1 and data is not provided", code: 400 } };
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify(refusal));
      return;
    }

    const answer = ANSWERS[this.answered]!;
    this.answered += 1;
    let completion = 0;
    const chunk = (delta: Record<string, string>, finish: string | null = null): string => {
      completion += 1;
      const value = {
        id: "chatcmpl-e2e",
        object: "chat.completion.chunk",
        created: 1763000000,
        model: MODEL,
        choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
        usage: { prompt_tokens: 900, completion_tokens: completion, total_tokens: 900 + completion },
      };
      return `data: ${JSON.stringify(value)}\n\n`;
    };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(chunk({ role: "assistant", content: "" }));
    for (const piece of answer.reasoning) {
      response.write(chunk({ reasoning: piece }));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const text = answerText(answer.action);
    response.write(chunk({ content: text.slice(0, 20) }));
    response.write(chunk({ content: text.slice(20) }));
    response.write(chunk({ content: "" }, "stop"));
    const final = {
      id: "chatcmpl-e2e",
      object: "chat.completion.chunk",
      created: 1763000000,
      model: MODEL,
      choices: [],
      usage: { prompt_tokens: 900, completion_tokens: completion, total_tokens: 900 + completion },
      metrics: { generation_time_ms: 40 },
    };
    response.end(`data: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`);
  }
}

/** A robot of the test: its state is the pose it was told to take, and an action always completes. */
class MovingRobot implements AgentRobot {
  readonly actionMode = ActionMode.CARTESIAN;
  readonly sessionId = "session-e2e";
  readonly controlPeriodS = 0.005;
  readonly lastErrorDiagnostics = null;
  readonly state: ModelState = { arm: { x: 20, y: 0.5, z: 12, pitch: 0.7, roll: 0 }, gripper: { width: 6 } };
  readonly executed: SingleArmDelta[] = [];
  private observations = 0;

  waitStationary(): Record<string, never> {
    return {};
  }

  observe(): Observation {
    this.observations += 1;
    const observationId = `observation-${this.observations}`;

    return {
      observationId,
      sessionId: this.sessionId,
      capturedMonotonicS: this.observations,
      jointPositions: [0, 0, 0, 0, 0, this.state.gripper.width / 6],
      images: { wrist: frameBytes(observationId, "wrist") },
      cameraTimestamps: { wrist: { receivedMonotonicS: this.observations - 0.01, frameNumber: this.observations } },
      controlSnapshot: {},
    };
  }

  modelState(): ModelState {
    return structuredClone(this.state);
  }

  isHolding(): boolean {
    return true;
  }

  stop(): void {}

  execute(action: SingleArmDelta, options: { reportProgress?: ((phase: ActionPhase) => void) | null }): MotionResult {
    options.reportProgress?.(ActionPhase.PLANNING);
    options.reportProgress?.(ActionPhase.EXECUTING);
    this.executed.push(action);
    for (const name of ["x", "y", "z", "pitch", "roll"] as const) {
      this.state.arm[name] += action.arm[name];
    }
    let gripperOutcome: GripperOutcome | null = null;
    if (action.gripper.width !== 0) {
      this.state.gripper.width = action.gripper.width > 0 ? 6 : 0;
      gripperOutcome = action.gripper.width > 0 ? GripperOutcome.OPEN : GripperOutcome.CLOSED;
    }

    return {
      status: MotionStatus.COMPLETED,
      isSettled: true,
      targetReached: true,
      measuredPosition: [0, 0, 0, 0, 0, this.state.gripper.width / 6],
      trackingError: [0, 0, 0, 0, 0, 0],
      measuredState: structuredClone(this.state),
      gripperOutcome,
      error: null,
    };
  }

  failureResult(): MotionResult {
    throw new Error("No turn of this task fails");
  }
}

describe("a task of three turns, end to end", () => {
  const server = new ChatServer();
  let baseUrl: string;

  beforeAll(async () => {
    baseUrl = await server.listen();
  });
  afterAll(async () => {
    await server.close();
  });

  test("the loop, the client and a server over HTTP", async () => {
    const client = new VLLMClient(systemPrompt(INSTRUCTION), {
      timeoutS: 30,
      baseUrl,
      model: MODEL,
      apiKey: () => "test-key\n",
    });
    expect(await client.check()).toEqual({ status: "ok", message: "vLLM model endpoint connected" });

    const robot = new MovingRobot();
    const session = new StationAgentLoop(robot, client, { actionFormat: SINGLE_ARM_POSE_FORMAT, timeoutS: 30 });
    const turns: Array<{ events: Array<[string, EventData]>; result: MotionResult; text: string }> = [];
    const shown: ModelState[] = [];

    for (let turn = 0; turn < 3; turn++) {
      const events: Array<[string, EventData]> = [];
      shown.push(structuredClone(robot.state));
      const result = await session.step({
        cancellation: new AbortController().signal,
        onEvent: (kind, data) => events.push([kind, data]),
        attemptId: `attempt${turn}`,
      });
      turns.push({ events, result, text: session.lastTurn!.modelInput.text });
    }
    await session.close();

    // every turn completed, and the robot did what the answers said
    expect(turns.map((turn) => turn.result.status)).toEqual(["completed", "completed", "completed"]);
    expect(robot.executed).toEqual(ANSWERS.map((answer) => answer.action));
    expect(robot.state).toEqual({ arm: { x: 22, y: 0.5, z: 14.5, pitch: 0.7, roll: 0 }, gripper: { width: 0 } });
    expect(session.turnCount).toBe(3);

    // each turn showed the state and the report of the turn before, as src/protocol writes them
    expect(turns[0]!.text).toBe(turnText(shown[0]!));
    for (const turn of [1, 2]) {
      const report = executionFeedback(turns[turn - 1]!.result, { isDispatched: true });
      expect(turns[turn]!.text).toBe(turnText(shown[turn]!, report));
    }

    // the events of a turn, in order
    const kinds = turns[0]!.events.map(([kind, data]) => (kind === "phase" ? `phase:${data.phase as string}` : kind));
    expect(kinds.filter((kind) => !["usage", "performance"].includes(kind))).toEqual([
      "phase:Observing",
      "observation",
      "phase:Thinking",
      "request_metrics",
      "reasoning_delta",
      "reasoning_delta",
      "answer_delta",
      "answer_delta",
      "model_output",
      "action",
      "phase:Planning",
      "phase:Executing",
    ]);
    const output = turns[0]!.events.find(([kind]) => kind === "model_output")![1];
    expect(output).toMatchObject({
      answer: answerText(ANSWERS[0]!.action),
      reasoning: ANSWERS[0]!.reasoning.join(""),
      reasoning_kind: "full",
      usage: { input: 900, output: 6, context_limit: 260096 },
    });
    const lastPerformance = turns[0]!.events.filter(([kind]) => kind === "performance").at(-1)![1];
    expect(lastPerformance).toMatchObject({ final: true, status: "completed", output_tokens: 6, decode_time_s: 0.04 });

    // four requests: one a turn, and the third turn's again after the server's cache miss
    expect(server.requests.length).toBe(4);
    expect(new Set(server.requests.map((request) => request.authorization))).toEqual(new Set(["Bearer test-key"]));
    const [first, second, missed, resent] = server.requests.map((request) => request.body);
    expect(first!.messages[0]).toEqual({ role: "system", content: systemPrompt(INSTRUCTION) });
    expect(first!.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(second!.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(second!.messages[2]).toEqual({
      role: "assistant",
      content: answerText(ANSWERS[0]!.action),
      reasoning: ANSWERS[0]!.reasoning.join(""),
    });
    const images = (body: ChatRequest["body"]): Array<{ url: string | null; uuid: string }> =>
      body.messages.flatMap((message) =>
        typeof message.content === "string"
          ? []
          : message.content
              .filter((part) => part.type === "image_url")
              .map((part) => ({ url: part.image_url?.url ?? null, uuid: part.uuid! })),
      );
    const frame = (turn: number): string =>
      `data:image/jpeg;base64,${Buffer.from(frameBytes(`observation-${turn}`, "wrist")).toString("base64")}`;
    expect(images(first!).map((image) => image.url)).toEqual([frame(1)]);
    // an earlier frame goes by its UUID alone, the new one with its data
    expect(images(second!).map((image) => image.url)).toEqual([null, frame(2)]);
    expect(images(second!)[0]!.uuid).toBe(images(first!)[0]!.uuid);
    expect(images(missed!).map((image) => image.url)).toEqual([null, null, frame(3)]);
    // after the cache miss every frame goes with its data again, under the same UUIDs
    expect(images(resent!).map((image) => image.url)).toEqual([frame(1), frame(2), frame(3)]);
    expect(images(resent!).map((image) => image.uuid)).toEqual(images(missed!).map((image) => image.uuid));
    expect(turns[2]!.events.filter(([kind]) => kind === "notice").map(([, data]) => data.message)).toEqual([
      "Image cache missed; resending saved images once.",
    ]);
    const userTexts = resent!.messages
      .filter((message) => message.role === "user")
      .map((message) => (message.content as Array<{ type: string; text?: string }>)[0]!.text);
    expect(userTexts).toEqual(turns.map((turn) => turn.text));
    expect(first!.max_tokens).toBeNull();
    expect(first!.stream).toBe(true);
  });
});
