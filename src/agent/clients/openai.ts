// Ports what pear/deploy/station/agent_loop/clients/vllm.py runs of the OpenAI Python SDK (openai 3.35.1, the
// version of PEAR's station environment): PEAR's client makes its requests through AsyncOpenAI and OpenAI, so the
// errors a model service causes carry the SDK's class names and messages, and PEAR's agent loop shows both to the
// model after a turn that failed. Ported here, with `fetch` in the place of the SDK's HTTP client:
//   openai/_exceptions.py                        the error classes
//   openai/_base_client.py, openai/_client.py    the request's headers, the error of a refused request
//   openai/_streaming.py                         the decoding of a server-sent event stream
//   openai/_models.py                            what a decoded chunk reads as (a model built without validation)

import { AttributeError, PythonException, PythonTypeError } from "../../python/errors";
import { pythonStrip } from "../../python/whitespace";
import { checkScope } from "./client";
import {
  plainOf,
  pythonDecodeUtf8,
  pythonJsonDecode,
  pythonStr,
  pythonTruth,
  pythonTypeName,
  type JsonValue,
} from "./python_repr";

/** The base of the SDK's errors. */
export class OpenAIError extends PythonException {
  override readonly name: string = "OpenAIError";
}

/** An error of the API: one the stream itself reports carries no status. */
export class APIError extends OpenAIError {
  override readonly name: string = "APIError";
}

/** A response with a status that is no success. */
export class APIStatusError extends APIError {
  override readonly name: string = "APIStatusError";
  /** The response's status (PEAR reads it as status_code). */
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** The service could not be reached, or the connection failed while the answer came. */
export class APIConnectionError extends APIError {
  override readonly name: string = "APIConnectionError";

  constructor(message = "Connection error.") {
    super(message);
  }
}

/** The service did not answer in time. */
export class APITimeoutError extends APIConnectionError {
  override readonly name: string = "APITimeoutError";

  constructor() {
    super("Request timed out.");
  }
}

export class BadRequestError extends APIStatusError {
  override readonly name: string = "BadRequestError";
}

export class AuthenticationError extends APIStatusError {
  override readonly name: string = "AuthenticationError";
}

export class PermissionDeniedError extends APIStatusError {
  override readonly name: string = "PermissionDeniedError";
}

export class NotFoundError extends APIStatusError {
  override readonly name: string = "NotFoundError";
}

export class ConflictError extends APIStatusError {
  override readonly name: string = "ConflictError";
}

export class UnprocessableEntityError extends APIStatusError {
  override readonly name: string = "UnprocessableEntityError";
}

export class RateLimitError extends APIStatusError {
  override readonly name: string = "RateLimitError";
}

export class InternalServerError extends APIStatusError {
  override readonly name: string = "InternalServerError";
}

/** What the SDK raises for a key that is empty. */
export const MISSING_CREDENTIALS =
  "Missing credentials. Please pass an `api_key`, `workload_identity`, `admin_api_key`, or set the " +
  "`OPENAI_API_KEY` or `OPENAI_ADMIN_KEY` environment variable.";

/**
 * Returns the error of a response whose status is no success and whose body's text is ``text``
 * (BaseClient._make_status_error_from_response, OpenAI._make_status_error): the class follows the status, and the
 * message is the status with Python's text of the decoded body, or the body's own text when it is no JSON.
 */
export function statusError(status: number, text: string): APIStatusError {
  const errorText = pythonStrip(text);
  let message: string;
  try {
    message = `Error code: ${status} - ${pythonStr(pythonJsonDecode(errorText))}`;
  } catch (error) {
    if (!(error instanceof PythonException)) {
      throw error;
    }
    message = errorText || `Error code: ${status}`;
  }

  switch (status) {
    case 400:
      return new BadRequestError(message, status);
    case 401:
      return new AuthenticationError(message, status);
    case 403:
      return new PermissionDeniedError(message, status);
    case 404:
      return new NotFoundError(message, status);
    case 409:
      return new ConflictError(message, status);
    case 422:
      return new UnprocessableEntityError(message, status);
    case 429:
      return new RateLimitError(message, status);
    default:
      return status >= 500 ? new InternalServerError(message, status) : new APIStatusError(message, status);
  }
}

/** The headers of a request that reach the service's answer: the key as a bearer token, and JSON both ways. (The
 * SDK also names itself, its platform and its time-out in headers of its own, which a model service does not
 * read; a page cannot set a User-Agent.) */
export function requestHeaders(apiKey: string, options: { hasBody: boolean }): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${apiKey}` };
  if (options.hasBody) {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

/** One event of a server-sent event stream. */
export interface ServerSentEvent {
  event: string | null;
  data: string;
  id: string | null;
  retry: number | null;
}

const CARRIAGE_RETURN = 13;
const LINE_FEED = 10;

/** Splits a stream's bytes into lines at CR, LF and CRLF, whatever the pieces they arrive in (_SSELineDecoder). */
export class SSELineDecoder {
  private pieces: Uint8Array[] = [];
  private skipLineFeed = false;

  /** Takes the next bytes and returns the lines they end. */
  feed(chunk: Uint8Array): Uint8Array[] {
    const lines: Uint8Array[] = [];
    let start = 0;
    for (let end = 0; end < chunk.length; end++) {
      const byte = chunk[end]!;
      if (byte !== CARRIAGE_RETURN && byte !== LINE_FEED) {
        continue;
      }
      if (this.skipLineFeed && end === start && byte === LINE_FEED) {
        this.skipLineFeed = false;
        start = end + 1;
        continue;
      }
      this.skipLineFeed = false;
      this.pieces.push(chunk.subarray(start, end));
      lines.push(this.takeLine());
      this.skipLineFeed = byte === CARRIAGE_RETURN;
      start = end + 1;
    }
    if (start < chunk.length) {
      this.skipLineFeed = false;
      this.pieces.push(chunk.slice(start));
    }

    return lines;
  }

  /** Returns what is left as the last line, if anything is. */
  finish(): Uint8Array[] {
    return this.pieces.some((piece) => piece.length > 0) ? [this.takeLine()] : [];
  }

  private takeLine(): Uint8Array {
    const length = this.pieces.reduce((total, piece) => total + piece.length, 0);
    const line = new Uint8Array(length);
    let offset = 0;
    for (const piece of this.pieces) {
      line.set(piece, offset);
      offset += piece.length;
    }
    this.pieces = [];

    return line;
  }
}

// Python's int(text) of a retry field: optional sign, decimal digits of any script, single underscores between
// digits, whitespace around; the value itself is never used
const PYTHON_INTEGER = /^[+-]?\p{Nd}+(?:_\p{Nd}+)*$/u;

/** Builds the events of a stream from its lines (SSEDecoder.decode). */
export class SSEDecoder {
  private event: string | null = null;
  private data: string[] = [];
  private lastEventId: string | null = null;
  private retry: number | null = null;

  /** Takes one line, without its line end, and returns the event it completes, if it completes one. */
  decode(line: string): ServerSentEvent | null {
    if (!line) {
      if (!this.event && this.data.length === 0 && !this.lastEventId && this.retry === null) {
        return null;
      }

      const sse = { event: this.event || null, data: this.data.join("\n"), id: this.lastEventId, retry: this.retry };
      // as the SSE specification has it, the last event id stays
      this.event = null;
      this.data = [];
      this.retry = null;

      return sse;
    }
    if (line.startsWith(":")) {
      return null;
    }

    const colon = line.indexOf(":");
    const fieldName = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (fieldName === "event") {
      this.event = value;
    } else if (fieldName === "data") {
      this.data.push(value);
    } else if (fieldName === "id") {
      if (!value.includes("\0")) {
        this.lastEventId = value;
      }
    } else if (fieldName === "retry") {
      const digits = pythonStrip(value);
      // (Python refuses to read an integer of more than 4300 digits)
      if (PYTHON_INTEGER.test(digits) && digits.replace(/[+_-]/g, "").length <= 4300) {
        // only that a retry was read counts: nothing reads its value (no number for digits of another script)
        this.retry = Number(digits.replace(/_/g, ""));
      }
    }

    return null;
  }
}

/**
 * Yields the events of ``response``'s body as a server-sent event stream (AsyncStream._iter_events), up to the end
 * of the body; a connection that fails while the body comes is an APIConnectionError, as it is before the answer.
 */
export async function* serverSentEvents(response: Response, scope: AbortSignal): AsyncGenerator<ServerSentEvent> {
  const lines = new SSELineDecoder();
  const decoder = new SSEDecoder();
  const reader = response.body?.getReader();

  try {
    while (reader !== undefined) {
      let piece: ReadableStreamReadResult<Uint8Array>;
      try {
        piece = await reader.read();
      } catch {
        checkScope(scope);
        throw new APIConnectionError();
      }
      checkScope(scope);
      if (piece.done) {
        break;
      }
      for (const line of lines.feed(piece.value)) {
        const sse = decoder.decode(pythonDecodeUtf8(line));
        if (sse !== null) {
          yield sse;
        }
      }
    }
    for (const line of lines.finish()) {
      const sse = decoder.decode(pythonDecodeUtf8(line));
      if (sse !== null) {
        yield sse;
      }
    }
  } finally {
    // the response is closed whether its body was read to the end or not
    await reader?.cancel().catch(() => undefined);
  }
}

/**
 * Yields the chunks of a streamed answer (AsyncStream.__stream__): the JSON of each event up to [DONE], read as
 * Python's json.loads reads it; an event that carries an error ends the stream with an APIError.
 */
export async function* streamedChunks(response: Response, scope: AbortSignal): AsyncGenerator<JsonValue> {
  for await (const sse of serverSentEvents(response, scope)) {
    if (sse.data.startsWith("[DONE]")) {
      break;
    }

    const data = decodeJson(sse.data);
    if (isMapping(data) && pythonTruth(attributeOrNone(data, "error"))) {
      const error = data.error;
      let message = isMapping(error) ? error.message : null;
      if (typeof message !== "string" || !message) {
        message = "An error occurred during streaming";
      }
      throw new APIError(message);
    }

    yield data;
  }
}

/** Python's json.loads(text) as a JavaScript value; throws JSONDecodeError, a ValueError, with Python's message. */
export function decodeJson(text: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    // what JSON.parse refuses, Python refuses with a message of its own or takes (NaN, Infinity)
    return plainOf(pythonJsonDecode(text));
  }
}

/** Whether ``value`` is a JSON object: a dict in Python, and a model once the SDK has built one of it. */
export function isMapping(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns ``value.name`` as Python reads it of what the SDK builds from a decoded response: a JSON object is a model
 * whose missing fields are None; anything else has no such attribute and raises AttributeError.
 */
export function attribute(value: unknown, name: string): JsonValue {
  if (!isMapping(value)) {
    throw new AttributeError(`'${pythonTypeName(value)}' object has no attribute '${name}'`);
  }

  return Object.hasOwn(value, name) ? value[name]! : null;
}

/** Returns getattr(value, name, None): the field of a model, None of anything else. */
export function attributeOrNone(value: unknown, name: string): JsonValue {
  return isMapping(value) && Object.hasOwn(value, name) ? value[name]! : null;
}

/** Returns what `for item in value` iterates in Python: a list's items, a string's characters, an object's names;
 * raises TypeError for a value that is not iterable. */
export function iterate(value: unknown): JsonValue[] {
  if (Array.isArray(value)) {
    return value as JsonValue[];
  }
  if (typeof value === "string") {
    return Array.from(value);
  }
  if (isMapping(value)) {
    return Object.keys(value);
  }

  throw new PythonTypeError(`'${pythonTypeName(value)}' object is not iterable`);
}
