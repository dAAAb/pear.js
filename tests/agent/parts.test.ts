// The parts of PEAR's client and loop that need no service and no robot, each compared with what PEAR's own code
// gave for the same input (tests/fixtures/agent/parts.json, written by Parts in tools/fixtures/agent_fixtures.py).

import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { StationAgentLoop } from "../../src/agent/agent_loop";
import { ModelClient } from "../../src/agent/clients/client";
import { HealthChecks } from "../../src/agent/clients/health_checks";
import { Performance, pythonSum, TokenRate, type RequestStatus } from "../../src/agent/clients/metrics";
import { SSEDecoder, SSELineDecoder, type ServerSentEvent } from "../../src/agent/clients/openai";
import {
  isPythonPrintable,
  pythonDecodeUtf8,
  pythonJsonDecode,
  pythonRepr,
  pythonStr,
  pythonStringRepr,
} from "../../src/agent/clients/python_repr";
import type { ModelHealth, ModelOutput } from "../../src/agent/clients/schemas";
import { pythonJsonLength, VLLMClient, type VLLMClientOptions } from "../../src/agent/clients/vllm";
import { ModelsConfig, OfferedModel, type ModelClientClass } from "../../src/agent/config";
import { RuntimeError, ValueError } from "../../src/agent/exceptions";
import { SINGLE_ARM_POSE_FORMAT } from "../../src/agent/formats";
import type { AgentRobot } from "../../src/agent/robot";
import { expectOutcome, outcomeOf } from "./client_scenarios";
import { bytesOf, loadFixture, type Meta, type RecordedOutcome } from "./fixtures";

type Special = { $float: "inf" | "-inf" | "nan" };

/** Returns a fixture's value with the numbers JSON has no text for. */
function decoded(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(decoded);
  }
  if (typeof value === "object" && value !== null) {
    if ("$float" in value) {
      return { inf: Infinity, "-inf": -Infinity, nan: NaN }[(value as Special).$float];
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decoded(item)]));
  }

  return value;
}

interface Parts {
  arguments: Array<{ options: Record<string, unknown>; whole_float: boolean; outcome: RecordedOutcome }>;
  service_urls: Array<{ url: string; outcome: RecordedOutcome }>;
  metrics: {
    decode_rates: Array<{ samples: unknown[][]; rate: unknown }>;
    whole_floats: Array<{
      samples: Array<[number, number]>;
      rate: { decode_throughput_tps: null; decode_time_s: null };
    }>;
    token_rates: Array<{ reports: Array<[string, unknown, number]>; rate: number | null }>;
    sums: Array<{ values: unknown[]; sum: unknown }>;
    reports: {
      now: number;
      cases: Array<{
        start_time: number;
        first_output_s: number | null;
        usage: Record<string, unknown>;
        status: RequestStatus;
        report: Record<string, unknown>;
      }>;
    };
  };
  health_checks: {
    max_age_s: number;
    unchecked: ModelHealth;
    operations: Array<{
      op: "get" | "check";
      model: string;
      at?: number;
      takes?: number;
      is_forced?: boolean;
      answer?: { status?: string; message?: string; raises?: string; unbuilt?: string };
      outcome: RecordedOutcome;
      made: number;
      closed: number;
    }>;
  };
  texts: {
    reprs: Array<[string, string]>;
    documents: Array<{ text: string; str: string; repr: string }>;
    broken: Array<{ text: string; outcome: RecordedOutcome }>;
    utf8: Array<{ bytes: string; outcome: RecordedOutcome }>;
    json_lengths: Array<{ value: unknown; length: number }>;
  };
  event_streams: Array<{ pieces: string[]; events: ServerSentEvent[] }>;
  sessions: Array<{ action_mode: string; session_id: string | null; timeout_s: unknown; outcome: RecordedOutcome }>;
  models: {
    robot: { title: string; formats: string[] };
    max_timeout_s: number;
    default_timeout_s: number;
    cases: Array<{
      default_model: string;
      models: Record<
        string,
        {
          label: string;
          client_class: string;
          client: Record<string, unknown>;
          timeout_s?: number;
          action_format?: string;
        }
      >;
      outcome: RecordedOutcome;
    }>;
  };
}

const parts = loadFixture<Parts>("parts.json");
const meta = loadFixture<Meta>("meta.json");

/** PEAR's names of the client's arguments, and pear.js's. */
const ARGUMENT_NAMES: Record<string, keyof VLLMClientOptions> = {
  base_url: "baseUrl",
  model: "model",
  max_output_tokens: "maxOutputTokens",
  context_limit: "contextLimit",
  max_images: "maxImages",
  temperature: "temperature",
  top_p: "topP",
  top_k: "topK",
  repetition_penalty: "repetitionPenalty",
  reasoning_effort: "reasoningEffort",
};

/** Returns a client's arguments under pear.js's names. */
function namedArguments(options: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(decoded(options) as Record<string, unknown>).map(([name, value]) => [ARGUMENT_NAMES[name]!, value]),
  );
}

function clientOptions(options: Record<string, unknown>): VLLMClientOptions {
  return { timeoutS: 300, ...namedArguments(options) } as unknown as VLLMClientOptions;
}

describe("VLLMClient's arguments", () => {
  const typed = parts.arguments.filter((item) => !item.whole_float);

  test.each(typed.map((item) => [JSON.stringify(item.options), item] as const))(
    "are taken or refused as PEAR does: %s",
    async (_label, item) => {
      expectOutcome(await outcomeOf(() => new VLLMClient("system", clientOptions(item.options)).baseUrl), item.outcome);
    },
  );

  test("a float that is a whole number is a count here, where PEAR refuses it", () => {
    const cases = parts.arguments.filter((item) => item.whole_float);

    expect(cases.length).toBeGreaterThan(0);
    for (const item of cases) {
      expect((item.outcome as { raised: { message: string } }).raised.message).toMatch(/must be a whole number/);
      expect(new VLLMClient("system", clientOptions(item.options)).baseUrl).toBe("http://server/v1");
    }
  });

  test("the defaults are PEAR's own", () => {
    const client = new VLLMClient("system", { timeoutS: 300, baseUrl: "http://server/v1", model: meta.model });

    expect([client.maxOutputTokens, client.contextLimit, client.maxImages]).toEqual([null, 260096, 1016]);
    expect({ ...client.sampling, ...client.extraBody }).toEqual({
      temperature: 1,
      top_p: 0.95,
      top_k: -1,
      repetition_penalty: 1,
    });
    expect(client.reasoningEffort).toBe("xhigh");
  });
});

describe("ModelClient.serviceUrl", () => {
  test.each(parts.service_urls.map((item) => [JSON.stringify(item.url), item] as const))(
    "reads %s as PEAR does",
    async (_label, item) => {
      expectOutcome(await outcomeOf(() => ModelClient.serviceUrl(item.url)), item.outcome);
    },
  );
});

describe("the metrics", () => {
  test.each(parts.metrics.decode_rates.map((item, index) => [index, JSON.stringify(item.samples), item] as const))(
    "decode rate %i of %s is PEAR's",
    (_index, _label, item) => {
      const samples = decoded(item.samples) as Array<[unknown, unknown]>;

      expect(Performance.decodeRate(samples)).toEqual(item.rate);
    },
  );

  test("a count of tokens that is a float is taken here, where PEAR leaves it out", () => {
    expect(parts.metrics.whole_floats.length).toBeGreaterThan(0);
    for (const item of parts.metrics.whole_floats) {
      expect(item.rate).toEqual({ decode_throughput_tps: null, decode_time_s: null });
      expect(Performance.decodeRate(item.samples).decode_throughput_tps).toBeGreaterThan(0);
    }
  });

  test.each(parts.metrics.token_rates.map((item, index) => [index, item] as const))(
    "token rate %i is PEAR's",
    (_index, item) => {
      const rate = new TokenRate();
      for (const [requestId, count, receivedAt] of item.reports) {
        rate.add(requestId, count, receivedAt);
      }

      expect(rate.tokensPerSecond()).toBe(item.rate);
    },
  );

  test.each(parts.metrics.sums.map((item) => [JSON.stringify(item.values), item] as const))(
    "Python's sum of %s",
    (_label, item) => {
      expect(pythonSum(decoded(item.values) as number[])).toBe(decoded(item.sum));
    },
  );

  test.each(parts.metrics.reports.cases.map((item, index) => [index, item] as const))(
    "performance report %i is PEAR's",
    (_index, item) => {
      const report = Performance.report("vllm", item.start_time, item.first_output_s, item.usage, {
        status: item.status,
        clock: () => parts.metrics.reports.now,
      });

      expect(report).toEqual(item.report);
    },
  );
});

describe("HealthChecks", () => {
  test("answers, checks again and counts its clients as PEAR's", async () => {
    const clock = { now: 0 };
    let made = 0;
    let closed = 0;
    let current = parts.health_checks.operations[0]!;

    class CheckedClient extends ModelClient {
      static override readonly LABEL: string = "Checked";

      async check(): Promise<ModelHealth> {
        clock.now += current.takes!;
        if (current.answer!.raises !== undefined) {
          throw new RuntimeError(current.answer!.raises);
        }
        return { ...current.answer } as ModelHealth;
      }

      override async close(): Promise<void> {
        closed += 1;
        await super.close();
      }

      protected inferAsync(): Promise<ModelOutput> {
        throw new Error("a client that checks a connection takes no request");
      }
    }

    const checks = new HealthChecks(
      () => {
        if (current.answer!.unbuilt !== undefined) {
          throw new ValueError(current.answer!.unbuilt);
        }
        made += 1;
        return new CheckedClient("", { timeoutS: 1 });
      },
      { clock: () => clock.now },
    );

    expect(HealthChecks.MAX_AGE_S).toBe(parts.health_checks.max_age_s);
    expect(HealthChecks.UNCHECKED_HEALTH).toEqual(parts.health_checks.unchecked);
    for (const [index, operation] of parts.health_checks.operations.entries()) {
      current = operation;
      let outcome: RecordedOutcome;
      if (operation.op === "get") {
        outcome = { returned: checks.get(operation.model) };
      } else {
        clock.now = operation.at!;
        outcome = await outcomeOf(() => checks.check(operation.model, { isForced: operation.is_forced ?? false }));
      }

      expectOutcome(outcome, operation.outcome);
      expect([made, closed], `operation ${index}: clients made and closed`).toEqual([operation.made, operation.closed]);
    }
  });
});

describe("Python's texts", () => {
  test("str.isprintable is Python's over every code point", () => {
    const flags = new Uint8Array(0x110000);
    let notPrintable = 0;
    for (let codePoint = 0; codePoint < flags.length; codePoint++) {
      flags[codePoint] = isPythonPrintable(codePoint) ? 0 : 1;
      notPrintable += flags[codePoint]!;
    }

    expect(notPrintable).toBe(meta.printable.not_printable);
    expect(createHash("sha256").update(flags).digest("hex")).toBe(meta.printable.sha256);
  });

  test.each(parts.texts.reprs.map(([text, repr], index) => [index, text, repr] as const))(
    "repr() of string %i",
    (_index, text, repr) => {
      expect(pythonStringRepr(text)).toBe(repr);
    },
  );

  test.each(parts.texts.documents.map((item) => [item.text, item] as const))(
    "str() and repr() of %s",
    (_text, item) => {
      const value = pythonJsonDecode(item.text);

      expect(pythonStr(value)).toBe(item.str);
      expect(pythonRepr(value)).toBe(item.repr);
    },
  );

  test.each(parts.texts.broken.map((item) => [JSON.stringify(item.text), item] as const))(
    "json.loads refuses %s as Python does",
    async (_label, item) => {
      expectOutcome(await outcomeOf(() => pythonJsonDecode(item.text)), item.outcome);
    },
  );

  test.each(parts.texts.utf8.map((item, index) => [index, item] as const))(
    "bytes.decode of byte string %i",
    async (_index, item) => {
      expectOutcome(await outcomeOf(() => pythonDecodeUtf8(bytesOf(item.bytes))), item.outcome);
    },
  );

  test.each(parts.texts.json_lengths.map((item, index) => [index, item] as const))(
    "the size of compact JSON %i",
    (_index, item) => {
      expect(pythonJsonLength(item.value)).toBe(item.length);
    },
  );
});

describe("the event stream decoder", () => {
  test.each(parts.event_streams.map((item, index) => [index, item.pieces.length, item] as const))(
    "stream %i in %i pieces gives the SDK's events",
    (_index, _pieces, item) => {
      const lines = new SSELineDecoder();
      const decoder = new SSEDecoder();
      const events: ServerSentEvent[] = [];
      const take = (line: Uint8Array): void => {
        const event = decoder.decode(pythonDecodeUtf8(line));
        if (event !== null) {
          events.push(event);
        }
      };
      for (const piece of item.pieces) {
        lines.feed(bytesOf(piece)).forEach(take);
      }
      lines.finish().forEach(take);

      expect(events).toEqual(item.events);
    },
  );
});

describe("a model session", () => {
  test.each(parts.sessions.map((item) => [JSON.stringify(item), item] as const))(
    "is made or refused as PEAR's: %s",
    async (_label, item) => {
      const robot = { actionMode: item.action_mode, sessionId: item.session_id } as AgentRobot;
      const outcome = await outcomeOf(
        () =>
          new StationAgentLoop(robot, null as unknown as ModelClient, {
            actionFormat: SINGLE_ARM_POSE_FORMAT,
            timeoutS: decoded(item.timeout_s) as number,
          }).turnCount,
      );

      expectOutcome(outcome, item.outcome);
    },
  );
});

describe("the models of a station's configuration", () => {
  const { robot, cases } = parts.models;

  test("PEAR's bounds", () => {
    expect(OfferedModel.MAX_TIMEOUT_S).toBe(parts.models.max_timeout_s);
    expect(new OfferedModel({ label: "x", clientClass: VLLMClient as ModelClientClass, client: {} }).timeoutS).toBe(
      parts.models.default_timeout_s,
    );
    expect(Object.keys({ [SINGLE_ARM_POSE_FORMAT.name]: 0 })).toEqual(robot.formats);
  });

  test.each(cases.map((item, index) => [index, item] as const))("configuration %i is PEAR's", async (_index, item) => {
    const outcome = await outcomeOf(() => {
      const models = Object.fromEntries(
        Object.entries(item.models).map(([name, fields]) => {
          const isClient = fields.client_class.endsWith(".VLLMClient");
          return [
            name,
            new OfferedModel({
              label: fields.label,
              clientClass: (isClient ? VLLMClient : Object) as ModelClientClass,
              clientClassName: fields.client_class,
              client: namedArguments(fields.client),
              actionFormat: fields.action_format ?? null,
              ...(fields.timeout_s === undefined ? {} : { timeoutS: fields.timeout_s }),
            }),
          ];
        }),
      );
      const config = new ModelsConfig({
        robotTitle: robot.title,
        actionFormats: { [SINGLE_ARM_POSE_FORMAT.name]: SINGLE_ARM_POSE_FORMAT },
        defaultModel: item.default_model,
        models,
      });
      const names = Object.keys(config.models);
      let unknown: RecordedOutcome;
      try {
        config.require("nope");
        unknown = { returned: null };
      } catch (error) {
        unknown = { raised: { type: (error as Error).name, message: (error as Error).message } as never };
      }

      const clientName = (name: string): string => config.models[name]!.newClient("prompt").constructor.name;

      return {
        formats: Object.fromEntries(names.map((name) => [name, config.actionFormat(name).name])),
        timeouts: Object.fromEntries(names.map((name) => [name, config.models[name]!.timeoutS])),
        clients: Object.fromEntries(names.map((name) => [name, clientName(name)])),
        require_unknown: unknown,
      };
    });

    if ("raised" in item.outcome) {
      expectOutcome(outcome, item.outcome);
      return;
    }
    const expected = item.outcome.returned as { require_unknown: { raised: { type: string; message: string } } };
    const actual = (outcome as { returned: typeof expected }).returned;
    expect({ ...actual, require_unknown: null }).toEqual({ ...expected, require_unknown: null });
    expect(actual.require_unknown.raised).toEqual({
      type: expected.require_unknown.raised.type,
      message: expected.require_unknown.raised.message,
    });
  });
});
