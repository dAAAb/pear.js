// Ports pear/deploy/station/agent_loop/clients/vllm.py: the client of a vLLM server's Chat Completions (any server
// that speaks the OpenAI-compatible API to a PEAR model), which keeps the conversation itself and names the images
// the server already has by their UUIDs.
//
// PEAR sends its requests through the OpenAI Python SDK; here they go through `fetch`, and ./openai.ts holds what
// the SDK adds to them and makes of the answers. The request's JSON body has the SDK's fields and values (a server
// parses it, so the order of its keys and its spacing reach no model); the errors carry the SDK's class names and
// messages. The key is given when the client is made or read from a function at each request, and is sent as a
// bearer token; nothing here stores or logs it.

import { PythonError } from "../../protocol/python_json";
import { pythonStrip } from "../../protocol/python_text";
import type { Clock } from "../clock";
import { OperatorPaused, pythonErrorMessage, ValueError } from "../exceptions";
import { checkScope, ContextLimit, ModelClient, RequestCancelled, TurnProgress } from "./client";
import { isPythonInt, Performance, RequestStatus } from "./metrics";
import {
  APIConnectionError,
  APITimeoutError,
  attribute,
  attributeOrNone,
  decodeJson,
  isMapping,
  iterate,
  MISSING_CREDENTIALS,
  OpenAIError,
  requestHeaders,
  statusError,
  streamedChunks,
} from "./openai";
import { pythonStr, pythonTruth, pythonTypeName, pythonValueOf, type JsonValue } from "./python_repr";
import {
  base64Of,
  HealthStatus,
  ModelEvent,
  modelOutput,
  ReasoningKind,
  type CameraImage,
  type EventHandler,
  type ModelHealth,
  type ModelInput,
  type ModelOutput,
  type ReferenceImage,
  type Usage,
} from "./schemas";

/** Raised for a conversation the server refuses before any output because its cache lost an image that was sent by
 * its UUID alone. */
export class ImageCacheMiss extends Error {
  override readonly name: string = "ImageCacheMiss";
}

/** One turn of the conversation while its request streams: the answer so far and what the server reports of the
 * request. */
export class VLLMProgress extends TurnProgress {
  /** The answer's text streamed since the conversation was last sent. */
  answer = "";
  /** The reasoning's text streamed since then. */
  reasoning = "";
  /** Why the server ended the answer; null until it says. */
  finishReason: JsonValue = null;
  /** Whether any text streamed since the conversation was last sent. */
  hasVisibleOutput = false;
  /** When the token counts were last reported; null before the first report. */
  lastUsageTime: number | null = null;
  /** The server's own measurements of the request, from the last chunk that held them. */
  serverMetrics: JsonValue = null;
}

/** One message of the conversation the client keeps: the system prompt, a turn's input or the model's answer to
 * it, with its reasoning. */
export type HistoryMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: ModelInput }
  | { role: "assistant"; content: string; reasoning: string };

/** A client's arguments beside the system prompt (PEAR's names in camelCase). */
export interface VLLMClientOptions {
  /** How long the model may take to answer a turn, s. */
  timeoutS: number;
  /** The server's address up to its API version: "http://<host>:8000/v1". */
  baseUrl: string;
  /** The name the server serves the model under. */
  model: string;
  /** The server's API key, or what returns it at each request; absent for a server that asks for none. (PEAR
   * reads it from a file at each request.) */
  apiKey?: string | (() => string) | null;
  /** The most tokens of one answer; null: no limit of its own, the context left bounds it. */
  maxOutputTokens?: number | null;
  /** The tokens the model's context holds. */
  contextLimit?: number;
  /** The most images a conversation holds. */
  maxImages?: number;
  /** The sampling temperature. */
  temperature?: number;
  /** The probability mass the sampling keeps. */
  topP?: number;
  /** The tokens the sampling keeps; -1: all of them. */
  topK?: number;
  /** The penalty on repeated tokens; 1: none. */
  repetitionPenalty?: number;
  /** The reasoning effort the chat template is given. */
  reasoningEffort?: string;
  /** What makes the requests; by default the runtime's own fetch. */
  fetch?: typeof fetch;
  /** The client's monotonic clock, in seconds; by default the machine's. */
  clock?: Clock;
}

type MessagePart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } | null; uuid: string };
type Message =
  | { role: "system"; content: string }
  | { role: "assistant"; content: string; reasoning: string }
  | { role: "user"; content: MessagePart[] };

/** A client of a vLLM server's Chat Completions, which keeps the conversation itself and names the images the
 * server already has by their UUIDs. */
export class VLLMClient extends ModelClient {
  /** Names the client in its messages. */
  static override readonly LABEL: string = "vLLM";
  /** Names the client in its performance reports. */
  static readonly PROVIDER = "vllm";
  /** Of the model-list request that checks the endpoint, s. */
  static readonly CHECK_TIMEOUT_S = 3;
  /** Between two reports of a streaming request's token counts, s. */
  static readonly USAGE_INTERVAL_S = 0.25;
  /** What is sent for a server that asks for no key. */
  static readonly UNUSED_API_KEY = "unused";
  /** The one request of a turn, as its token rate knows it. */
  static readonly REQUEST_ID = "request";
  /** The finish reason of an answer the model ended itself. */
  static readonly STOP_FINISH_REASON = "stop";
  /** The finish reason of an answer the server cut at a token limit. */
  static readonly LENGTH_FINISH_REASON = "length";
  /** The operator reads it. */
  static readonly CONTEXT_FULL = "vLLM context is full. History is preserved; clear the task to restart.";
  /** What a JPEG's base64 follows in the URL that carries the image. */
  static readonly IMAGE_URL_PREFIX = "data:image/jpeg;base64,";
  /** What a server's refusal says, all of it, when its cache lost an image that was sent by its UUID alone. */
  static readonly CACHE_MISS_PHRASES = ["cache miss for image", "data is not provided"] as const;
  /** What a server's refusal says, one of them, of a conversation past the model's context length. */
  static readonly CONTEXT_OVERFLOW_MARKERS = ["maximum context length", "max_model_len", "context length exceeded"];
  /** The highest sampling temperature the API takes. */
  static readonly TEMPERATURE_LIMIT = 2;

  // the served model's own values, which a station's configuration may replace
  static readonly MAX_OUTPUT_TOKENS = null;
  static readonly CONTEXT_LIMIT = 260096;
  static readonly MAX_IMAGES = 1016;
  static readonly TEMPERATURE = 1;
  static readonly TOP_P = 0.95;
  static readonly TOP_K = -1;
  static readonly REPETITION_PENALTY = 1;
  /** The reasoning effort the chat template is given, the one a station may ask for. */
  static readonly REASONING_EFFORT = "xhigh";

  /** The server's address, without a slash at its end. */
  baseUrl: string;
  readonly model: string;
  readonly maxOutputTokens: number | null;
  readonly reasoningEffort: string;
  readonly sampling: { temperature: number; top_p: number };
  readonly extraBody: { top_k: number; repetition_penalty: number };
  readonly contextLimit: number;
  readonly maxImages: number;
  /** The conversation: the system prompt, then each turn's input and the model's answer to it. */
  readonly history: HistoryMessage[];

  private readonly apiKey: string | (() => string) | null;
  private readonly fetch: typeof fetch;

  constructor(systemPrompt: string, options: VLLMClientOptions) {
    const {
      model,
      maxOutputTokens = VLLMClient.MAX_OUTPUT_TOKENS,
      contextLimit = VLLMClient.CONTEXT_LIMIT,
      maxImages = VLLMClient.MAX_IMAGES,
      temperature = VLLMClient.TEMPERATURE,
      topP = VLLMClient.TOP_P,
      topK = VLLMClient.TOP_K,
      repetitionPenalty = VLLMClient.REPETITION_PENALTY,
      reasoningEffort = VLLMClient.REASONING_EFFORT,
    } = options;
    // the messages name the arguments as PEAR's configuration does
    if (typeof model !== "string" || !model) {
      throw new ValueError("model must be the name the server serves the model under, a non-empty string");
    }
    const positiveCounts: Array<[string, unknown]> = [
      ["context_limit", contextLimit],
      ["max_images", maxImages],
    ];
    if (maxOutputTokens !== null) {
      positiveCounts.push(["max_output_tokens", maxOutputTokens]);
    }
    for (const [name, count] of positiveCounts) {
      if (!isPythonInt(count) || count <= 0) {
        throw new ValueError(`${name} must be a whole number above 0`);
      }
    }
    if (typeof temperature !== "number" || !(temperature >= 0 && temperature <= VLLMClient.TEMPERATURE_LIMIT)) {
      throw new ValueError(`temperature must be a number from 0 to ${VLLMClient.TEMPERATURE_LIMIT}`);
    }
    if (typeof topP !== "number" || !(topP > 0 && topP <= 1)) {
      throw new ValueError("top_p must be a number above 0 and at most 1");
    }
    if (!isPythonInt(topK)) {
      throw new ValueError("top_k must be a whole number");
    }
    if (typeof repetitionPenalty !== "number" || !(repetitionPenalty > 0 && repetitionPenalty < Infinity)) {
      throw new ValueError("repetition_penalty must be a finite number above 0");
    }
    if (reasoningEffort !== VLLMClient.REASONING_EFFORT) {
      throw new ValueError(`reasoning_effort must be ${VLLMClient.REASONING_EFFORT}`);
    }

    super(systemPrompt, { timeoutS: options.timeoutS, clock: options.clock });
    this.baseUrl = ModelClient.serviceUrl(options.baseUrl);
    this.model = model;
    this.apiKey = options.apiKey ?? null;
    this.maxOutputTokens = maxOutputTokens;
    this.reasoningEffort = reasoningEffort;
    this.sampling = { temperature, top_p: topP };
    this.extraBody = { top_k: topK, repetition_penalty: repetitionPenalty };
    this.contextLimit = contextLimit;
    this.maxImages = maxImages;
    // (the runtime's fetch is looked up at each request, and called as a function of no object)
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

    this.history = [{ role: "system", content: systemPrompt }];
  }

  /** Returns the health of a server that lists the model; throws when the server does not answer or does not serve
   * the model. */
  async check(): Promise<ModelHealth> {
    const models = await this.getPage("/models", VLLMClient.CHECK_TIMEOUT_S);
    const served = iterate(attribute(models, "data")).map((servedModel) => {
      const id = attribute(servedModel, "id");
      if (typeof id === "object" && id !== null) {
        throw new PythonError("TypeError", `unhashable type: '${pythonTypeName(id)}'`, false); // the ids make a set
      }
      return id;
    });
    if (!served.includes(this.model)) {
      throw new ValueError(`vLLM model is not served: ${this.model}`);
    }

    return { status: HealthStatus.OK, message: "vLLM model endpoint connected" };
  }

  /** Returns the model's answer to the conversation with ``modelInput``, both of which then join the history. */
  protected async inferAsync(
    modelInput: ModelInput,
    onEvent: EventHandler,
    cancellation: AbortSignal,
  ): Promise<ModelOutput> {
    // the task's images went out with the first input the history holds
    if (this.history.some((message) => message.role === "user")) {
      modelInput = { ...modelInput, referenceImages: [] };
    }

    const apiKey = this.currentApiKey();
    const sentInput = modelInput;
    const output = await this.race(
      (scope) => this.generate(apiKey, sentInput, onEvent, cancellation, scope),
      cancellation,
      { timeoutS: this.timeoutS },
    );

    // a complete answer belongs to the history even if its motion is cancelled later
    this.history.push(
      { role: "user", content: modelInput },
      { role: "assistant", content: output.answer, reasoning: output.reasoning },
    );

    return output;
  }

  /** Returns the model's answer to the conversation with ``modelInput``; saved images the server's cache lost are
   * sent once more. */
  private async generate(
    apiKey: string,
    modelInput: ModelInput,
    onEvent: EventHandler,
    cancellation: AbortSignal,
    scope: AbortSignal,
  ): Promise<ModelOutput> {
    const turn = new VLLMProgress({ onEvent, cancellation, startTime: this.clock(), clock: this.clock });

    try {
      return await this.stream(apiKey, turn, modelInput, false, scope);
    } catch (error) {
      if (!(error instanceof ImageCacheMiss)) {
        throw error;
      }
      turn.onEvent(ModelEvent.NOTICE, { message: "Image cache missed; resending saved images once." });
    }

    return await this.stream(apiKey, turn, modelInput, true, scope);
  }

  /** Sends the conversation with ``modelInput`` once and returns the answer the server streams. */
  private async stream(
    apiKey: string,
    turn: VLLMProgress,
    modelInput: ModelInput,
    resendsImages: boolean,
    scope: AbortSignal,
  ): Promise<ModelOutput> {
    OperatorPaused.checkCancelled(turn.cancellation);
    OperatorPaused.checkCancelled(this.abortSignal);
    turn.hasVisibleOutput = false;
    turn.answer = "";
    turn.reasoning = "";
    turn.finishReason = null;
    const [messages, uploadCount, imageCount] = this.messages(modelInput, resendsImages);
    turn.onEvent(ModelEvent.REQUEST_METRICS, {
      image_uploads: uploadCount,
      history_images: imageCount,
      cache_recovery: resendsImages,
      messages_json_bytes: pythonJsonLength(messages),
    });

    try {
      // the SDK waits before it sends anything: a stop seen at the first look ends the request unsent
      await Promise.resolve();
      checkScope(scope);
      const response = await this.post(
        "/chat/completions",
        apiKey,
        {
          model: this.model,
          messages,
          stream: true,
          stream_options: { include_usage: true, continuous_usage_stats: true },
          max_tokens: this.maxOutputTokens,
          ...this.sampling,
          ...this.extraBody,
          chat_template_kwargs: {
            enable_thinking: true,
            preserve_thinking: true,
            reasoning_effort: this.reasoningEffort,
          },
        },
        scope,
      );
      for await (const chunk of streamedChunks(response, scope)) {
        this.receive(turn, chunk);
      }

      return this.output(turn);
    } catch (error) {
      if (error instanceof RequestCancelled) {
        throw error;
      }
      OperatorPaused.checkCancelled(turn.cancellation);
      OperatorPaused.checkCancelled(this.abortSignal);
      if (!resendsImages && !turn.hasVisibleOutput && VLLMClient.isCacheMiss(error)) {
        throw new ImageCacheMiss(pythonErrorMessage(error), { cause: error });
      }
      if (VLLMClient.isContextOverflow(error)) {
        throw new ContextLimit(VLLMClient.CONTEXT_FULL, { cause: error });
      }
      throw error;
    }
  }

  /** Returns the conversation up to ``pendingInput`` as the API takes it, with how many of its images carry their
   * data and how many images it holds. */
  private messages(pendingInput: ModelInput, resendsImages: boolean): [Message[], number, number] {
    const messages: Message[] = [];
    let uploadCount = 0;
    let imageCount = 0;

    const conversation: HistoryMessage[] = [...this.history, { role: "user", content: pendingInput }];
    conversation.forEach((message, index) => {
      if (message.role !== "user") {
        messages.push({ ...message });
        return;
      }

      const content = message.content;
      const sendsData = resendsImages || index === conversation.length - 1;
      const parts: MessagePart[] = [];
      for (const image of content.referenceImages) {
        imageCount += 1;
        uploadCount += sendsData ? 1 : 0;
        parts.push(VLLMClient.imagePart(image, sendsData));
      }
      parts.push({ type: "text", text: content.text });
      for (const image of content.images) {
        imageCount += 1;
        uploadCount += sendsData ? 1 : 0;
        parts.push({ type: "text", text: `[${image.cameraName}]` });
        parts.push(VLLMClient.imagePart(image, sendsData));
      }
      messages.push({ role: "user", content: parts });
    });

    if (imageCount > this.maxImages) {
      throw new ContextLimit("Image capacity reached. Clear the task to start a new context.");
    }

    return [messages, uploadCount, imageCount];
  }

  /** Returns an image as a part of a message: its UUID alone for an image the server's cache holds, with its data
   * when the server may not hold it. */
  private static imagePart(image: CameraImage | ReferenceImage, sendsData: boolean): MessagePart {
    const imageUrl = sendsData ? { url: VLLMClient.IMAGE_URL_PREFIX + base64Of(image.bytes) } : null;

    return { type: "image_url", image_url: imageUrl, uuid: image.uuid };
  }

  /** Takes one chunk of the stream: what the server reports of the request, and the next text of the answer. */
  private receive(turn: VLLMProgress, chunk: JsonValue): void {
    const chunkError = attributeOrNone(chunk, "error");
    if (pythonTruth(chunkError)) {
      throw new ValueError(pythonStr(pythonValueOf(chunkError)));
    }
    const metrics = attributeOrNone(chunk, "metrics");
    if (metrics !== null) {
      turn.serverMetrics = metrics;
    }
    const chunkUsage = attribute(chunk, "usage");
    if (chunkUsage !== null) {
      turn.usage = this.usage(chunkUsage);
      turn.tokenRate.add(VLLMClient.REQUEST_ID, turn.usage.output, this.clock());
    }

    for (const choice of iterate(attribute(chunk, "choices"))) {
      const delta = attribute(choice, "delta");
      const reasoning = attributeOrNone(delta, "reasoning");
      const reasoningContent = attributeOrNone(delta, "reasoning_content");
      const reasoningText = pythonTruth(reasoning) ? reasoning : pythonTruth(reasoningContent) ? reasoningContent : "";
      const content = attribute(delta, "content");
      const text = pythonTruth(content) ? content : "";
      const hasText = pythonTruth(reasoningText) || pythonTruth(text);
      if (hasText && turn.noteOutput()) {
        this.emitPerformance(turn, RequestStatus.STREAMING);
      }
      turn.hasVisibleOutput = turn.hasVisibleOutput || hasText;
      turn.reasoning = concatenated(turn.reasoning, reasoningText);
      turn.answer = concatenated(turn.answer, text);
      if (pythonTruth(reasoningText)) {
        turn.onEvent(ModelEvent.REASONING_DELTA, { text: reasoningText, reasoning_kind: ReasoningKind.FULL });
      }
      if (pythonTruth(text)) {
        turn.onEvent(ModelEvent.ANSWER_DELTA, { text });
      }
      const finishReason = attribute(choice, "finish_reason");
      if (finishReason !== null) {
        turn.finishReason = finishReason;
      }
    }

    // the server's counts are cumulative and hold the reasoning's tokens: they are reported at intervals, and no
    // count is estimated from the text or the chunks
    const now = this.clock();
    if (
      chunkUsage !== null &&
      (turn.lastUsageTime === null || now - turn.lastUsageTime >= VLLMClient.USAGE_INTERVAL_S)
    ) {
      turn.onEvent(ModelEvent.USAGE, { ...turn.usage, final: false });
      this.emitPerformance(turn, RequestStatus.STREAMING);
      turn.lastUsageTime = now;
    }
  }

  /** Returns the token counts a chunk reports, with the model's context length. */
  private usage(chunkUsage: JsonValue): Usage {
    // (the server's values as they are: a server that follows the API sends whole numbers)
    const usage: Usage = {
      input: attribute(chunkUsage, "prompt_tokens") as number | null,
      output: attribute(chunkUsage, "completion_tokens") as number | null,
      context_limit: this.contextLimit,
    };
    const cachedTokens = attributeOrNone(attributeOrNone(chunkUsage, "prompt_tokens_details"), "cached_tokens");
    if (cachedTokens !== null) {
      usage.cached_input = cachedTokens as number;
    }

    return usage;
  }

  /** Returns the answer of a stream the model ended itself, after the request's last reports; throws for a stream
   * that ended any other way. */
  private output(turn: VLLMProgress): ModelOutput {
    if (turn.finishReason === VLLMClient.LENGTH_FINISH_REASON && this.maxOutputTokens === null) {
      // with no limit of the client's own, the server cuts an answer only where the context ends
      throw new ContextLimit(VLLMClient.CONTEXT_FULL);
    }
    if (turn.finishReason !== VLLMClient.STOP_FINISH_REASON) {
      const reason = pythonTruth(turn.finishReason) ? pythonStr(pythonValueOf(turn.finishReason)) : "disconnected";
      throw new ValueError(`vLLM output did not finish normally: ${reason}`);
    }
    if (Object.keys(turn.usage).length > 0) {
      turn.onEvent(ModelEvent.USAGE, { ...turn.usage, final: true });
    }
    this.emitPerformance(turn, RequestStatus.COMPLETED);

    const reasoningKind = turn.reasoning ? ReasoningKind.FULL : ReasoningKind.NONE;

    return modelOutput(turn.answer, turn.reasoning, reasoningKind, turn.usage);
  }

  /** Reports the request's timings; those of a completed request hold its decode rate on the server's clock. */
  private emitPerformance(turn: VLLMProgress, status: RequestStatus): void {
    const report = {
      ...Performance.report(VLLMClient.PROVIDER, turn.startTime, turn.firstOutputS, turn.usage, {
        status,
        clock: this.clock,
      }),
      client_decode_throughput_tps: turn.tokenRate.tokensPerSecond(),
    };
    if (status === RequestStatus.COMPLETED) {
      // the server's own interval is the only decode time: no time on the client's clock stands in for it
      const generationMs = isMapping(turn.serverMetrics)
        ? attributeOrNone(turn.serverMetrics, "generation_time_ms")
        : null;
      Object.assign(report, Performance.decodeRate([[turn.usage.output ?? null, generationMs]]));
    }

    turn.onEvent(ModelEvent.PERFORMANCE, report);
  }

  /** Forgets the conversation. */
  protected override release(): void {
    this.history.length = 0;
  }

  /** Returns the server's API key, a word in its place for a server that asks for none. */
  private currentApiKey(): string {
    const given = typeof this.apiKey === "function" ? this.apiKey() : this.apiKey;
    if (given === null || given === undefined) {
      return VLLMClient.UNUSED_API_KEY;
    }

    const key = pythonStrip(given);
    if (!key) {
      throw new OpenAIError(MISSING_CREDENTIALS);
    }

    return key;
  }

  /** Returns whether the server refused a conversation because its cache lost an image sent by its UUID alone. */
  static isCacheMiss(error: unknown): boolean {
    const refusalText = VLLMClient.refusalText(error);

    return VLLMClient.CACHE_MISS_PHRASES.every((phrase) => refusalText.includes(phrase));
  }

  /** Returns whether the server refused a conversation because it is past the model's context length. */
  static isContextOverflow(error: unknown): boolean {
    const refusalText = VLLMClient.refusalText(error);

    return VLLMClient.CONTEXT_OVERFLOW_MARKERS.some((marker) => refusalText.includes(marker));
  }

  /** Returns the lower-case text of an error the server refused a conversation with (a bad request, or an error of
   * the stream, which has no status), empty for any other error. */
  private static refusalText(error: unknown): string {
    const statusCode = (error as { statusCode?: unknown } | null)?.statusCode ?? 400;

    return statusCode === 400 ? pythonErrorMessage(error).toLowerCase() : "";
  }

  /** Sends one JSON request and returns the response whose body streams; throws the error of a refusal, and a
   * connection error for a server that cannot be reached. */
  private async post(path: string, apiKey: string, body: unknown, scope: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: requestHeaders(apiKey, { hasBody: true }),
        body: JSON.stringify(body),
        signal: scope,
      });
    } catch {
      checkScope(scope);
      throw new APIConnectionError();
    }
    checkScope(scope);
    if (response.ok) {
      return response;
    }

    let text: string;
    try {
      text = await readText(response);
    } catch {
      checkScope(scope);
      throw new APIConnectionError();
    }
    checkScope(scope);

    throw statusError(response.status, text);
  }

  /** Returns what a GET of ``path`` answers as the SDK reads it: the decoded JSON, or the text of an answer that
   * is neither called JSON nor is JSON; throws past ``timeoutS`` without an answer or without the next bytes. */
  private async getPage(path: string, timeoutS: number): Promise<JsonValue> {
    const apiKey = this.currentApiKey();
    const controller = new AbortController();
    let hasTimedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const restartTimer = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        hasTimedOut = true;
        controller.abort();
      }, timeoutS * 1000);
    };

    restartTimer();
    try {
      let response: Response;
      let text: string;
      try {
        response = await this.fetch(`${this.baseUrl}${path}`, {
          method: "GET",
          headers: requestHeaders(apiKey, { hasBody: false }),
          signal: controller.signal,
        });
        restartTimer();
        text = await readText(response, restartTimer);
      } catch {
        throw hasTimedOut ? new APITimeoutError() : new APIConnectionError();
      }
      if (!response.ok) {
        throw statusError(response.status, text);
      }

      const page = VLLMClient.decodedBody(response, text);
      attribute(page, "_set_private_attributes"); // the SDK calls it of the page: a page that is no object has none

      return page;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Returns the body of an answer as the SDK reads it for a model: JSON where the answer is called JSON, and
   * where it is not, JSON if it reads as JSON and its text otherwise. */
  private static decodedBody(response: Response, text: string): JsonValue {
    const contentType = (response.headers.get("content-type") ?? "*").split(";")[0]!;
    if (contentType.endsWith("json")) {
      return decodeJson(text);
    }

    try {
      return decodeJson(text);
    } catch (error) {
      if (!(error instanceof PythonError)) {
        throw error;
      }
      return text;
    }
  }
}

/** Python's `text += more` of two strings; raises TypeError for a ``more`` that is no string. */
function concatenated(text: string, more: JsonValue): string {
  if (typeof more !== "string") {
    throw new PythonError("TypeError", `can only concatenate str (not "${pythonTypeName(more)}") to str`, false);
  }

  return text + more;
}

/** Reads the whole body of ``response`` as text (UTF-8, a byte order mark kept, as httpx reads it); ``onBytes`` is
 * called as each piece arrives. */
async function readText(response: Response, onBytes?: () => void): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return "";
  }

  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let text = "";
  for (;;) {
    const piece = await reader.read();
    onBytes?.();
    if (piece.done) {
      return text + decoder.decode();
    }
    text += decoder.decode(piece.value, { stream: true });
  }
}

const PLAIN_JSON_TEXT = /^[ !#-[\]-~]*$/; // printable ASCII but the quote and the backslash
const SHORT_JSON_ESCAPES = '"\\\b\f\n\r\t';

/**
 * Returns len(json.dumps(value, separators=(",", ":")).encode()): the bytes of Python's compact JSON of a
 * conversation, in which everything but printable ASCII is escaped (\uXXXX for each UTF-16 unit).
 */
export function pythonJsonLength(value: unknown): number {
  if (value === null) {
    return 4;
  }
  if (typeof value === "string") {
    return jsonStringLength(value);
  }
  if (typeof value === "boolean") {
    return value ? 4 : 5;
  }
  if (typeof value !== "object") {
    throw new TypeError("A conversation holds text, images and nothing else"); // (no number is ever part of one)
  }
  if (Array.isArray(value)) {
    // the brackets, a comma between two items
    return value.reduce((length: number, item) => length + pythonJsonLength(item), 2 + Math.max(0, value.length - 1));
  }

  const entries = Object.entries(value as object);
  // the braces, a comma between two entries, a colon in each
  return entries.reduce(
    (length, [key, item]) => length + jsonStringLength(key) + 1 + pythonJsonLength(item),
    2 + Math.max(0, entries.length - 1),
  );
}

function jsonStringLength(text: string): number {
  if (PLAIN_JSON_TEXT.test(text)) {
    return text.length + 2;
  }

  let length = 2;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (SHORT_JSON_ESCAPES.includes(text[index]!)) {
      length += 2;
    } else {
      length += unit >= 0x20 && unit <= 0x7e ? 1 : 6;
    }
  }

  return length;
}
