// What the fixtures tools/fixtures/agent_fixtures.py wrote of PEAR's own client hold, as types, with what reads
// their values. Nothing here needs Node, so that a page may run the client's scenarios: ./fixtures.ts, which reads
// the files, is Node's.

/** An exception PEAR raised, as a fixture records it. */
export interface RecordedError {
  type: string;
  message: string;
  /** The classes it is an instance of, nearest first. */
  bases: string[];
  is_value_error: boolean;
  status_code: number | null;
}

/** What a call of PEAR returned or raised. */
export type RecordedOutcome = { returned: unknown } | { raised: RecordedError };

/** One step of a scripted response's body. */
export type BodyStep = { data: string } | { sleep_s: number } | { hold_s: number };

/** A scripted response of the recording server (see Service in tools/fixtures/agent_fixtures.py). */
export interface ResponseScript {
  status?: number;
  headers?: Array<[string, string]>;
  framing?: "chunked" | "length" | "close";
  head?: "send" | "reset" | "hold";
  delay_s?: number;
  body?: BodyStep[];
  encoding?: "utf-8" | "latin-1";
  missing_bytes?: number;
  end?: "finish" | "cut" | "reset";
}

/** A request the recording server received. */
export interface RecordedRequest {
  method: string;
  path: string;
  headers: { authorization: string | null; "content-type": string | null; accept: string | null };
  body: unknown;
}

export interface RecordedImage {
  camera_name?: string;
  uuid: string;
  /** The image's bytes, as base64. */
  data: string;
}

export interface Trigger {
  on?: string;
  count?: number;
  final?: boolean;
  after_s?: number;
  do: "set_cancellation" | "client_cancel" | "infer" | "close";
}

export interface ClientStep {
  op: "infer" | "check" | "close" | "cancel";
  label?: string;
  input?: { text: string; images: RecordedImage[]; reference_images: RecordedImage[] };
  responses?: ResponseScript[];
  base_url?: string;
  cancelled_before?: boolean;
  triggers?: Trigger[];
  outcome: RecordedOutcome;
  events?: Array<[string, Record<string, unknown>]>;
  trigger_outcomes?: Record<string, RecordedOutcome>;
  requests: RecordedRequest[];
  unused_responses: number;
  clock_reads: number;
  history: string[];
}

export interface ClientScenario {
  name: string;
  about: string;
  client: {
    system_prompt: string;
    timeout_s: number;
    base_url: string;
    model: string;
    api_key: string | null;
    options: Record<string, unknown>;
  };
  clock: { start: number; step: number };
  steps: ClientStep[];
}

export interface Meta {
  pear_commit: string | null;
  python: string;
  openai: string;
  model: string;
  request_header_names: string[];
  printable: { runs: number; not_printable: number; sha256: string };
  label: string;
  cancel_poll_s: number;
  cleanup_timeout_s: number;
}

/** A clock that is one step later at every reading, as the one PEAR's client ran on for the fixtures. */
export class TickClock {
  reads = 0;

  constructor(
    private readonly start: number,
    private readonly step: number,
  ) {}

  readonly now = (): number => {
    const value = this.start + this.reads * this.step;
    this.reads += 1;

    return value;
  };
}

/** Returns the bytes a fixture holds as base64. */
export function bytesOf(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}
