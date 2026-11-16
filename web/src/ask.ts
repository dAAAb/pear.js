// "Ask the model once": the first turn of a task as PEAR's turn loop would send it, and nothing more. The turn is
// made by the library from what the window read (the joints, the model's state, the camera's frame), sent with the
// library's own client, and its answer is shown. The action the format reads of the answer is shown too and is NOT
// executed: this module holds no robot, no station and no bus, so it has nothing to send an action to.
//
// What the loop does around the request (src/agent/agent_loop.ts: observe, askModel) is reproduced for one turn:
// the observation, ObservationMessage.build, the phase "Thinking", client.infer, then the format's parseAction.
// The client is made as PEAR's console makes one (an offered model's class and arguments, prompted with the task's
// system prompt) and closed after the answer, a failure or a cancellation: every ask is a new conversation.
//
// One request more is made in one case: after a plain connection error the service's address is asked, without a
// key, whether something answers there (./model.ts, as step 3's check does). A browser withholds a refusal that
// lacks its headers, and the page can then say so instead of "Connection error" alone.

import {
  APIConnectionError,
  type EventData,
  type ModelClient,
  type ModelClientClass,
  ModelEvent,
  type ModelOutput,
  ModelPhase,
  monotonic,
  type Observation,
  ObservationMessage,
  OfferedModel,
  SINGLE_ARM_POSE_FORMAT,
  uuid4,
  VLLMClient,
} from "../../src/agent/index";
import { ActionParseError, systemPrompt } from "../../src/protocol/index";
import { DECIMALS } from "../../src/protocol/types";
import type { ModelState } from "../../src/so101/kinematics/index";
import { jpegHeader } from "./camera";
import { t } from "./i18n";
import { redact } from "./log";
import { isReachable } from "./model";

/** The action of the model's format. */
export type AskedAction = ReturnType<typeof SINGLE_ARM_POSE_FORMAT.parseAction>;

/** What the page gives an ask: the service as step 3 found it, the instruction, and what the window read. */
export interface AskInput {
  baseUrl: string;
  /** The name the service serves the model under. */
  model: string;
  /** The service's key; empty for a service that asks for none. It goes into the request and nowhere else. */
  apiKey: string;
  instruction: string;
  /** PEAR's joint vector as the window read it. */
  joints: readonly number[];
  /** The state a model is shown for these joints. */
  state: ModelState;
  /** The camera's frame as a turn sends it: JPEG bytes. */
  jpeg: Uint8Array;
  /** When the frame arrived, on the library's monotonic clock, s. */
  frameMonotonicS: number;
}

/** What the client reported of the request so far. */
export interface AskProgress {
  /** PEAR's word for what the model does. */
  phase: string | null;
  reasoning: string;
  answer: string;
  /** The last report of the tokens. */
  usage: EventData | null;
  /** The last report of the request's timings. */
  performance: EventData | null;
  /** What the client says of a request as it goes out. */
  notices: string[];
}

/** An error in PEAR's words: its class and its message. */
export interface AskError {
  name: string;
  message: string;
}

export type AskOutcome =
  /** The answer ends in an action of the format; ``written`` is the json block as the model wrote it. */
  | { kind: "action"; output: ModelOutput; action: AskedAction; written: string }
  /** The model answered, but the format reads no action of the answer. */
  | { kind: "no-action"; output: ModelOutput; error: AskError }
  | { kind: "cancelled"; error: AskError }
  /** ``isWithheld``: the connection failed with nothing to read although something answers at the service's
   * address, so the browser withheld an answer (a refused key, an origin the service does not allow). */
  | { kind: "failed"; error: AskError; isWithheld: boolean };

/** What an ask sent, as sizes; the turn's text is the model's, so it is kept for the page to show. */
export interface AskSent {
  text: string;
  systemCharacters: number;
  imageBytes: number;
  imageSize: string;
  /** The bytes of the request's messages as the client counts them; null when the request was never made. */
  messagesJsonBytes: number | null;
}

export interface AskResult {
  outcome: AskOutcome;
  sent: AskSent | null;
  seconds: number;
  /** The client's last report of the request's timings; null when it made none. */
  performance: EventData | null;
  /** Whether the client was closed afterwards. */
  isClosed: boolean;
}

/** Returns the json block that ends ``answer`` as the model wrote it; the format has read an action of it. */
function writtenAction(answer: string): string {
  const start = answer.lastIndexOf("```json");
  const end = answer.lastIndexOf("```");

  return start < 0 || end <= start ? "" : answer.slice(start + "```json".length, end).trim();
}

function describe(error: unknown): AskError {
  return error instanceof Error ? { name: error.name, message: error.message } : { name: typeof error, message: String(error) };
}

/** One ask: a new client, one turn, one answer; then the client is closed. */
export class Ask {
  readonly progress: AskProgress = { phase: null, reasoning: "", answer: "", usage: null, performance: null, notices: [] };
  sent: AskSent | null = null;

  private readonly cancellation = new AbortController();
  private client: ModelClient | null = null;

  /**
   * ``onChange`` is called when the progress changed; ``log`` gets what happened and never what was said: no key,
   * no address, no instruction, no answer, no image.
   */
  constructor(
    private readonly input: AskInput,
    private readonly onChange: () => void,
    private readonly log: (message: string) => void,
  ) {}

  /** Stops the request, as an operator's stop does in PEAR: the turn's cancellation and the client's. */
  cancel(): void {
    this.cancellation.abort();
    this.client?.cancel();
  }

  async run(): Promise<AskResult> {
    const { input } = this;
    const format = SINGLE_ARM_POSE_FORMAT;
    const started = performance.now();
    const seconds = (): number => (performance.now() - started) / 1000;
    let outcome: AskOutcome;
    let isClosed = false;

    try {
      const offered = new OfferedModel({
        label: input.model,
        clientClass: VLLMClient as unknown as ModelClientClass,
        client: { baseUrl: input.baseUrl, model: input.model, apiKey: input.apiKey === "" ? null : input.apiKey },
      });
      offered.check(input.model);
      const prompt = systemPrompt(input.instruction);
      const client = offered.newClient(prompt);
      this.client = client;

      // the observation the loop would hold: what the window read, and when
      const observation: Observation = {
        observationId: uuid4(),
        sessionId: uuid4(),
        capturedMonotonicS: Math.max(monotonic(), input.frameMonotonicS),
        jointPositions: input.joints,
        images: Object.fromEntries(format.cameras.map((camera) => [camera.role, input.jpeg])),
        cameraTimestamps: Object.fromEntries(
          format.cameras.map((camera) => [camera.role, { receivedMonotonicS: input.frameMonotonicS }]),
        ),
        controlSnapshot: {},
      };
      // a task's first turn: no feedback of an earlier action, no reference images
      const modelInput = ObservationMessage.build(observation, input.state, format, uuid4(), null, []);
      const header = jpegHeader(input.jpeg);
      this.sent = {
        text: modelInput.text,
        systemCharacters: prompt.length,
        imageBytes: input.jpeg.length,
        imageSize: header === null ? "?" : `${header.width}x${header.height}`,
        messagesJsonBytes: null,
      };
      this.log(
        `Ask the model once: asked. System prompt ${prompt.length} characters, turn text ${modelInput.text.length} ` +
          `characters, ${modelInput.images.length} image (JPEG ${this.sent.imageSize}, ${input.jpeg.length} bytes).`,
      );

      this.report(ModelEvent.PHASE, { phase: ModelPhase.THINKING });
      const output = await client.infer(modelInput, {
        onEvent: (kind, data) => this.report(kind, data),
        cancellation: this.cancellation.signal,
      });
      this.progress.reasoning = output.reasoning;
      this.progress.answer = output.answer;
      const sizes = `${output.answer.length} characters of answer, ${output.reasoning.length} of reasoning`;
      try {
        const action = format.parseAction(output.answer);
        outcome = { kind: "action", output, action, written: writtenAction(output.answer) };
        this.log(
          `Ask the model once: answered after ${seconds().toFixed(1)} s, ${sizes}; the answer ends in an action, ` +
            "which was not executed: nothing was sent to the arm.",
        );
      } catch (error) {
        if (!(error instanceof ActionParseError)) throw error;
        outcome = { kind: "no-action", output, error: { name: error.code, message: error.message } };
        this.log(`Ask the model once: answered after ${seconds().toFixed(1)} s, ${sizes}; no action (${error.code}).`);
      }
    } catch (error) {
      const said = describe(error);
      const shown = { name: said.name, message: redact(said.message, input.apiKey) };
      if (this.cancellation.signal.aborted) {
        outcome = { kind: "cancelled", error: shown };
      } else {
        // a connection error tells a page nothing; whether something answers at the address does, as step 3's
        // check asks it (./model.ts): a request without a key whose answer the page cannot read. Only the plain
        // connection error is asked about, not a request that ran out of time.
        const isWithheld =
          error instanceof APIConnectionError &&
          error.constructor === APIConnectionError &&
          (await isReachable(`${input.baseUrl.replace(/\/+$/, "")}/models`));
        outcome = { kind: "failed", error: shown, isWithheld };
      }
      this.log(
        `Ask the model once: ${outcome.kind} after ${seconds().toFixed(1)} s (${said.name}). Nothing was sent to the arm.` +
          (outcome.kind === "failed" && outcome.isWithheld
            ? " Something answers at the service's address: the browser withheld its answer from this page."
            : ""),
      );
    }

    if (this.client !== null) {
      try {
        await this.client.close();
        isClosed = true;
        this.log("Ask the model once: the client is closed.");
      } catch (error) {
        this.log(`Ask the model once: the client did not close (${describe(error).name}).`);
      }
    }

    return { outcome, sent: this.sent, seconds: seconds(), performance: this.progress.performance, isClosed };
  }

  /** Takes one report of the client, as PEAR's console would. */
  private report(kind: ModelEvent, data: EventData): void {
    const progress = this.progress;
    if (kind === ModelEvent.PHASE) {
      progress.phase = String(data.phase);
    } else if (kind === ModelEvent.REASONING_DELTA) {
      progress.reasoning += String(data.text);
    } else if (kind === ModelEvent.ANSWER_DELTA) {
      progress.answer += String(data.text);
    } else if (kind === ModelEvent.USAGE) {
      progress.usage = data;
    } else if (kind === ModelEvent.PERFORMANCE) {
      progress.performance = data;
    } else if (kind === ModelEvent.NOTICE) {
      progress.notices.push(String(data.message));
    } else if (kind === ModelEvent.REQUEST_METRICS && this.sent !== null) {
      const bytes = data.messages_json_bytes;
      this.sent.messagesJsonBytes = typeof bytes === "number" ? bytes : null;
      this.log(`Ask the model once: the request's messages are ${String(bytes)} bytes of JSON.`);
    }
    this.onChange();
  }
}

// ---------------------------------------------------------------- what the page shows of an ask

function node<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function show(id: string, text: string | null): void {
  const target = node(id);
  target.hidden = text === null;
  if (target.textContent !== (text ?? "")) target.textContent = text ?? "";
}

/** A report of the client as a line: its fields under PEAR's names. */
function fields(record: EventData | null): string | null {
  if (record === null) return null;

  return Object.entries(record)
    .filter(([, value]) => value !== null && typeof value !== "object")
    .map(([name, value]) => `${name} ${typeof value === "number" && !Number.isInteger(value) ? value.toFixed(3) : String(value)}`)
    .join(", ");
}

function signed(value: number, decimals: number): string {
  return `${value < 0 ? "−" : "+"}${Math.abs(value).toFixed(decimals)}`;
}

/** Shows the ask that runs, or what the last one came to; hides the result while there was none. */
export function renderAsk(running: Ask | null, result: AskResult | null): void {
  const box = node("ask-result");
  const progress = running?.progress ?? null;
  const outcome = result?.outcome ?? null;
  box.hidden = running === null && result === null;
  box.dataset.outcome = running !== null ? "asking" : (outcome?.kind ?? "");
  box.dataset.closed = result === null ? "" : String(result.isClosed);
  // (with nothing to show every part below is emptied: a hidden result keeps nothing of the ask before)

  const seconds = { seconds: (result?.seconds ?? 0).toFixed(1) };
  show(
    "ask-status",
    running !== null
      ? t("ask.status.asking")
      : outcome?.kind === "action"
        ? t("ask.status.action", seconds)
        : outcome?.kind === "no-action"
          ? t("ask.status.noAction", seconds)
          : outcome?.kind === "cancelled"
            ? t("ask.status.cancelled", seconds)
            : t("ask.status.failed", seconds),
  );
  const sent = running?.sent ?? result?.sent ?? null;
  show("ask-sent-text", sent?.text ?? null);
  show(
    "ask-sent-sizes",
    sent === null
      ? null
      : t("ask.sent.sizes", {
          system: sent.systemCharacters,
          text: sent.text.length,
          size: sent.imageSize,
          bytes: sent.imageBytes,
        }),
  );
  node("ask-sent").hidden = sent === null;

  const output = outcome !== null && "output" in outcome ? outcome.output : null;
  show("ask-phase", progress?.phase ?? null);
  node("ask-phase-part").hidden = node("ask-phase").hidden;
  show("ask-performance", fields(progress?.performance ?? result?.performance ?? null));
  node("ask-performance-part").hidden = node("ask-performance").hidden;
  const reasoning = output?.reasoning ?? progress?.reasoning ?? "";
  node("ask-reasoning-part").hidden = reasoning === "";
  show("ask-reasoning", reasoning);
  const answer = output?.answer ?? progress?.answer ?? "";
  node("ask-answer-part").hidden = answer === "";
  show("ask-answer", answer);
  show("ask-usage", fields(output?.usage !== undefined ? (output.usage as unknown as EventData) : (progress?.usage ?? null)));
  node("ask-usage-part").hidden = node("ask-usage").hidden;

  const action = outcome?.kind === "action" ? outcome.action : null;
  node("ask-action").hidden = action === null;
  node("ask-action").dataset.action = action === null ? "" : JSON.stringify(action);
  show("ask-action-json", outcome?.kind === "action" ? outcome.written : null);
  show(
    "ask-action-sentence",
    action === null
      ? null
      : t("ask.sentence", {
          x: signed(action.arm.x, DECIMALS.x),
          y: signed(action.arm.y, DECIMALS.y),
          z: signed(action.arm.z, DECIMALS.z),
          pitch: signed(action.arm.pitch, DECIMALS.pitch),
          roll: signed(action.arm.roll, DECIMALS.roll),
          // PEAR's prompt: "gripper.width commands: +1=open, -1=close, 0=hold; magnitude sets neither gap nor force"
          gripper: t(action.gripper.width > 0 ? "ask.gripper.open" : action.gripper.width < 0 ? "ask.gripper.close" : "ask.gripper.hold"),
          width: signed(action.gripper.width, DECIMALS.width),
        }),
  );

  const error = outcome !== null && outcome.kind !== "action" ? outcome.error : null;
  show(
    "ask-explain",
    outcome === null || outcome.kind === "action"
      ? null
      : outcome.kind === "failed" && outcome.isWithheld
        ? // a page opened from a folder names itself "null" to a service, as step 3's check says it
          t("ask.explain.withheld", { origin: location.protocol === "file:" ? "null" : location.origin })
        : t(outcome.kind === "no-action" ? "ask.explain.noAction" : outcome.kind === "cancelled" ? "ask.explain.cancelled" : "ask.explain.failed"),
  );
  box.dataset.withheld = outcome?.kind === "failed" ? String(outcome.isWithheld) : "";
  show("ask-pear", error === null ? null : `${error.name}: ${error.message}`);
  show("ask-not-sent", result === null ? null : t("ask.notSent"));
}
