// Ports pear/deploy/station/agent_loop/clients/schemas.py: what a model client is given, what it returns and what
// it reports while a request runs.
//
// An event's data and a usage report keep PEAR's own keys (snake_case): they are what PEAR's page and a task's
// records read. An image is its JPEG bytes here, where PEAR's is the path of a JPEG file.

/** What a client reports of a running request, each by the name its event has on the page and in a task's events. */
export const ModelEvent = {
  /** What a turn does now: the model's ModelPhase, or a phase the agent loop names itself. */
  PHASE: "phase",
  /** The next text of the reasoning, with its ReasoningKind. */
  REASONING_DELTA: "reasoning_delta",
  /** The next text of the answer. */
  ANSWER_DELTA: "answer_delta",
  /** A message for the operator. */
  NOTICE: "notice",
  /** The token counts so far: a Usage. */
  USAGE: "usage",
  /** The timings so far. */
  PERFORMANCE: "performance",
  /** The size of the conversation as it was sent. */
  REQUEST_METRICS: "request_metrics",
} as const;
export type ModelEvent = (typeof ModelEvent)[keyof typeof ModelEvent];

/** What a model does while its request runs, each by the word the page shows. */
export const ModelPhase = {
  /** It works on its answer. */
  THINKING: "Thinking",
  /** Its service shortens the conversation to fit the context. */
  COMPACTING: "Compacting",
} as const;
export type ModelPhase = (typeof ModelPhase)[keyof typeof ModelPhase];

/** How much of a model's reasoning a client passes on. */
export const ReasoningKind = {
  /** All of its text. */
  FULL: "full",
  /** A summary its service writes. */
  SUMMARY: "summary",
  /** Nothing. */
  NONE: "none",
} as const;
export type ReasoningKind = (typeof ReasoningKind)[keyof typeof ReasoningKind];

/** What a check of a model's connection found. */
export const HealthStatus = {
  /** The model answers. */
  OK: "ok",
  /** The check failed. */
  OFFLINE: "offline",
  /** No check has reached the model yet. */
  UNCHECKED: "unchecked",
} as const;
export type HealthStatus = (typeof HealthStatus)[keyof typeof HealthStatus];

/** What a client's check reports, as the page reads it. */
export interface ModelHealth {
  /** A word of HealthStatus. */
  status: string;
  /** A sentence for the operator. */
  message: string;
  /** Whether the service takes a task's reference images, where a check tells. */
  reference_images?: boolean;
}

/** The tokens of a conversation's context, where a service measures them apart from a request's input. */
export interface ContextTokens {
  /** The tokens the context holds; null while the measurement is pending. */
  input?: number | null;
  /** The tokens the context can hold. */
  context_limit?: number;
  /** Pending or measured. */
  status?: string;
}

/** The compactions of a conversation's context that a service reports. */
export interface Compaction {
  /** The service's word for the turn's compaction; none without one. */
  status?: string;
  /** The compactions of the turn. */
  count?: number;
  /** The compactions of the episode, the turn's among them. */
  episode_count?: number;
}

/** One of the requests a service makes for a turn. */
export interface RequestUsage {
  id?: string;
  /** The tokens it has generated. */
  output?: number | null;
  /** How long it decoded, on the server's clock. */
  generation_time_ms?: number;
  /** Whether it has ended. */
  complete?: boolean;
}

/** The token counts of a turn's request, as its usage events report them while it runs and at its end. The counts
 * are the server's own values, passed on as they are (a server that reports none gives null). */
export interface Usage {
  /** The tokens of the request's prompt. */
  input?: number | null;
  /** The tokens generated. */
  output?: number | null;
  /** The prompt's tokens the server took from its cache. */
  cached_input?: number;
  /** The tokens the model's context can hold. */
  context_limit?: number;
  /** Whether no later report of the request follows. */
  final?: boolean;
  /** Whether the counts are lower bounds: the request ended before a service had counted all of it. */
  partial?: boolean;
  context?: ContextTokens;
  compaction?: Compaction;
  requests?: RequestUsage[];
}

/** One event's data: a JSON object under PEAR's keys. */
export type EventData = Record<string, unknown>;

/** Takes one event of a running request: its kind and its data. */
export type EventHandler = (kind: ModelEvent, data: EventData) => void;

/** One camera frame of a turn, under the camera's name as the model reads it. */
export interface CameraImage {
  readonly cameraName: string;
  /** The frame's JPEG bytes (in PEAR, the path of the frame's JPEG file). */
  readonly bytes: Uint8Array;
  /** What a server's image cache knows the frame by. */
  readonly uuid: string;
  /** The name PEAR saves the frame's file under: "<attempt id>-<camera name>.jpg". */
  readonly name?: string;
}

/** A task's reference image, which a model is sent once, at the start of its episode. */
export interface ReferenceImage {
  /** The image's JPEG bytes (in PEAR, the path of its JPEG file). */
  readonly bytes: Uint8Array;
  /** What a server's image cache knows the image by. */
  readonly uuid: string;
  /** The name of the image's file in a task's folder. */
  readonly name?: string;
}

/** One turn's text and images. */
export interface ModelInput {
  readonly text: string;
  readonly images: readonly CameraImage[];
  readonly referenceImages: readonly ReferenceImage[];
}

/** One turn's answer with its reasoning and token usage. */
export interface ModelOutput {
  answer: string;
  reasoning: string;
  /** A word of ReasoningKind, or the one a service gave. */
  reasoningKind: string;
  usage: Usage;
}

/** Returns a turn's input; the reference images are none unless given. */
export function modelInput(
  text: string,
  images: readonly CameraImage[],
  referenceImages: readonly ReferenceImage[] = [],
): ModelInput {
  return { text, images, referenceImages };
}

/** Returns a turn's answer, by default without reasoning and without usage. */
export function modelOutput(
  answer: string,
  reasoning = "",
  reasoningKind: string = ReasoningKind.NONE,
  usage: Usage = {},
): ModelOutput {
  return { answer, reasoning, reasoningKind, usage };
}

/** Returns an answer as a task's events and records keep it: dataclasses.asdict of PEAR's ModelOutput. */
export function modelOutputRecord(output: ModelOutput): EventData {
  return {
    answer: output.answer,
    reasoning: output.reasoning,
    reasoning_kind: output.reasoningKind,
    usage: output.usage,
  };
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
// an image is encoded once, however often a conversation carries it
const encodedImages = new WeakMap<Uint8Array, string>();

/** Returns ``bytes`` as ASCII base64 (ImageFile.base64: standard alphabet, padded, no line breaks). */
export function base64Of(bytes: Uint8Array): string {
  const known = encodedImages.get(bytes);
  if (known !== undefined) {
    return known;
  }

  const pieces: string[] = [];
  let piece = "";
  const whole = bytes.length - (bytes.length % 3);
  for (let index = 0; index < whole; index += 3) {
    const triple = (bytes[index]! << 16) | (bytes[index + 1]! << 8) | bytes[index + 2]!;
    piece +=
      BASE64_ALPHABET[triple >> 18]! +
      BASE64_ALPHABET[(triple >> 12) & 63]! +
      BASE64_ALPHABET[(triple >> 6) & 63]! +
      BASE64_ALPHABET[triple & 63]!;
    if (piece.length >= 8192) {
      pieces.push(piece);
      piece = "";
    }
  }
  if (bytes.length - whole === 1) {
    const last = bytes[whole]!;
    piece += `${BASE64_ALPHABET[last >> 2]!}${BASE64_ALPHABET[(last & 3) << 4]!}==`;
  } else if (bytes.length - whole === 2) {
    const pair = (bytes[whole]! << 8) | bytes[whole + 1]!;
    piece +=
      BASE64_ALPHABET[pair >> 10]! + BASE64_ALPHABET[(pair >> 4) & 63]! + BASE64_ALPHABET[(pair & 15) << 2]! + "=";
  }
  pieces.push(piece);
  const encoded = pieces.join("");
  encodedImages.set(bytes, encoded);

  return encoded;
}
