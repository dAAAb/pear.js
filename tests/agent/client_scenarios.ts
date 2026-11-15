// Runs a scenario PEAR's VLLMClient was recorded on (tests/fixtures/agent/client.json) on pear.js's client, against
// a recording service that answers from the same script, and compares everything with the record.

import { expect } from "vitest";

import { ContextLimit, ModelClient, SessionLost } from "../../src/agent/clients/client";
import * as openai from "../../src/agent/clients/openai";
import { modelInput, modelOutputRecord, type ModelInput, type ModelOutput } from "../../src/agent/clients/schemas";
import { VLLMClient, type VLLMClientOptions } from "../../src/agent/clients/vllm";
import {
  isValueError,
  OperatorPaused,
  PythonException,
  pythonErrorName,
  RuntimeError,
  TimeoutError,
  ValueError,
} from "../../src/agent/exceptions";
import {
  bytesOf,
  TickClock,
  type ClientScenario,
  type ClientStep,
  type RecordedError,
  type RecordedOutcome,
  type Trigger,
} from "./fixtures";
import type { Service } from "./service";

/** The Python classes pear.js has a class for, by name: an error must be an instance of each one PEAR's is. */
const PYTHON_CLASSES: Record<string, abstract new (...arguments_: never[]) => Error> = {
  Exception: PythonException,
  ValueError,
  RuntimeError,
  TimeoutError,
  OperatorPaused,
  ContextLimit,
  SessionLost,
  OpenAIError: openai.OpenAIError,
  APIError: openai.APIError,
  APIStatusError: openai.APIStatusError,
  APIConnectionError: openai.APIConnectionError,
  APITimeoutError: openai.APITimeoutError,
  BadRequestError: openai.BadRequestError,
  AuthenticationError: openai.AuthenticationError,
  PermissionDeniedError: openai.PermissionDeniedError,
  NotFoundError: openai.NotFoundError,
  ConflictError: openai.ConflictError,
  UnprocessableEntityError: openai.UnprocessableEntityError,
  RateLimitError: openai.RateLimitError,
  InternalServerError: openai.InternalServerError,
};
/** Returns an error as a fixture records one. */
export function recordedError(error: unknown): RecordedError {
  const type = pythonErrorName(error);
  const known = Object.entries(PYTHON_CLASSES)
    .filter(([, constructor]) => error instanceof constructor)
    .map(([name]) => name);

  return {
    type,
    message: error instanceof Error ? error.message : String(error),
    bases: known,
    is_value_error: isValueError(error),
    status_code: (error as { statusCode?: number }).statusCode ?? null,
  };
}

/** Returns what ``call`` returned or threw, as a fixture records an outcome. */
export async function outcomeOf(call: () => unknown): Promise<RecordedOutcome> {
  try {
    const value = await call();
    if (typeof value === "object" && value !== null && "answer" in value) {
      return { returned: modelOutputRecord(value as ModelOutput) };
    }
    return { returned: value ?? null };
  } catch (error) {
    return { raised: recordedError(error) };
  }
}

/** Compares an outcome with PEAR's: what was returned; of an error its class, its message, whether it is a
 * ValueError, its status and every class of PEAR's error that pear.js has. */
export function expectOutcome(actual: RecordedOutcome, expected: RecordedOutcome): void {
  if ("returned" in expected) {
    expect(actual).toEqual(expected);
    return;
  }

  expect(actual).toHaveProperty("raised");
  const error = (actual as { raised: RecordedError }).raised;
  const pear = expected.raised;
  expect({ type: error.type, message: error.message }).toEqual({ type: pear.type, message: pear.message });
  expect(error.is_value_error).toBe(pear.is_value_error);
  expect(error.status_code).toBe(pear.status_code);
  if (pear.type in PYTHON_CLASSES) {
    // (an error of a Python class pear.js has no class for carries the class's name alone)
    const shared = pear.bases.filter((name) => name in PYTHON_CLASSES);
    expect(error.bases.filter((name) => shared.includes(name)).sort()).toEqual([...shared].sort());
  }
}

function clientOptions(scenario: ClientScenario, service: Service, clock: TickClock): VLLMClientOptions {
  const options = scenario.client.options;
  const given = <T>(name: string): T | undefined => (name in options ? (options[name] as T) : undefined);
  const settings: VLLMClientOptions = {
    timeoutS: scenario.client.timeout_s,
    baseUrl: urlOf(scenario.client.base_url, service),
    model: scenario.client.model,
    apiKey: scenario.client.api_key,
    clock: clock.now,
  };
  if (service.fetch !== undefined) {
    settings.fetch = service.fetch;
  }
  // PEAR's argument names, in camelCase
  const names: Array<[string, keyof VLLMClientOptions]> = [
    ["max_output_tokens", "maxOutputTokens"],
    ["context_limit", "contextLimit"],
    ["max_images", "maxImages"],
    ["temperature", "temperature"],
    ["top_p", "topP"],
    ["top_k", "topK"],
    ["repetition_penalty", "repetitionPenalty"],
    ["reasoning_effort", "reasoningEffort"],
  ];
  for (const [pearName, name] of names) {
    if (given(pearName) !== undefined) {
      (settings as unknown as Record<string, unknown>)[name] = given(pearName);
    }
  }

  return settings;
}

function urlOf(template: string, service: Service): string {
  return template.replace("{service}", service.origin).replace("{closed}", service.closedOrigin);
}

function inputOf(step: ClientStep): ModelInput {
  const input = step.input!;

  return modelInput(
    input.text,
    input.images.map((image) => ({ cameraName: image.camera_name!, bytes: bytesOf(image.data), uuid: image.uuid })),
    input.reference_images.map((image) => ({ bytes: bytesOf(image.data), uuid: image.uuid })),
  );
}

/** Runs one request of a scenario, with what the scenario does while it runs, and returns what it recorded. */
async function infer(
  client: VLLMClient,
  step: ClientStep,
): Promise<Pick<ClientStep, "outcome" | "events" | "trigger_outcomes">> {
  const cancellation = new AbortController();
  if (step.cancelled_before) {
    cancellation.abort();
  }
  const events: Array<[string, Record<string, unknown>]> = [];
  const counts = new Map<string, number>();
  const triggers = step.triggers ?? [];
  const pending = new Map<number, Promise<RecordedOutcome>>();
  const input = inputOf(step);

  const fire = (index: number, trigger: Trigger): void => {
    if (trigger.do === "set_cancellation") {
      cancellation.abort();
    } else if (trigger.do === "client_cancel") {
      client.cancel();
    } else if (trigger.do === "infer") {
      // a second request, made from the handler of the first one's event
      const second = new AbortController();
      pending.set(
        index,
        outcomeOf(() => client.infer(input, { onEvent: () => undefined, cancellation: second.signal })),
      );
    } else {
      pending.set(
        index,
        outcomeOf(() => client.close()),
      );
    }
  };

  const onEvent = (kind: string, data: Record<string, unknown>): void => {
    events.push([kind, structuredClone(data)]);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    triggers.forEach((trigger, index) => {
      if (trigger.on !== kind) {
        return;
      }
      if (trigger.count !== undefined && counts.get(kind) !== trigger.count) {
        return;
      }
      if (trigger.final !== undefined && data.final !== trigger.final) {
        return;
      }
      fire(index, trigger);
    });
  };

  const timers = triggers.flatMap((trigger, index) =>
    trigger.after_s === undefined ? [] : [setTimeout(() => fire(index, trigger), trigger.after_s * 1000)],
  );
  let outcome: RecordedOutcome;
  try {
    outcome = await outcomeOf(() => client.infer(input, { onEvent, cancellation: cancellation.signal }));
  } finally {
    timers.forEach((timer) => clearTimeout(timer));
  }

  const recorded: Pick<ClientStep, "outcome" | "events" | "trigger_outcomes"> = { outcome, events };
  if (pending.size > 0) {
    recorded.trigger_outcomes = {};
    for (const [index, result] of [...pending].sort(([first], [second]) => first - second)) {
      recorded.trigger_outcomes[String(index)] = await result;
    }
  }

  return recorded;
}

/** Runs ``scenario`` on pear.js's client against ``service`` and expects, at every step, what PEAR's client did. */
export async function runClientScenario(scenario: ClientScenario, service: Service): Promise<void> {
  const clock = new TickClock(scenario.clock.start, scenario.clock.step);
  const client = new VLLMClient(scenario.client.system_prompt, clientOptions(scenario, service, clock));

  try {
    for (const [index, step] of scenario.steps.entries()) {
      const where = `step ${index} (${step.op}${step.label ? `: ${step.label}` : ""})`;
      const reads = clock.reads;
      const savedUrl = client.baseUrl;
      if (step.base_url !== undefined) {
        client.baseUrl = urlOf(step.base_url, service);
      }
      service.begin(step.responses ?? []);

      let recorded: Pick<ClientStep, "outcome" | "events" | "trigger_outcomes">;
      try {
        if (step.op === "infer") {
          recorded = await infer(client, step);
        } else if (step.op === "check") {
          recorded = { outcome: await outcomeOf(() => client.check()) };
        } else if (step.op === "close") {
          recorded = { outcome: await outcomeOf(() => client.close()) };
        } else {
          recorded = { outcome: await outcomeOf(() => client.cancel()) };
        }
      } finally {
        client.baseUrl = savedUrl;
      }

      expectOutcome(recorded.outcome, step.outcome);
      expect(recorded.events, `${where}: events`).toEqual(step.events);
      expect(service.requests, `${where}: requests`).toEqual(step.requests);
      expect(service.responses.length, `${where}: responses left`).toBe(step.unused_responses);
      expect(clock.reads - reads, `${where}: readings of the clock`).toBe(step.clock_reads);
      expect(
        client.history.map((message) => message.role),
        `${where}: history`,
      ).toEqual(step.history);
      for (const [trigger, expected] of Object.entries(step.trigger_outcomes ?? {})) {
        expectOutcome(recorded.trigger_outcomes![trigger]!, expected);
      }
      expect(Object.keys(recorded.trigger_outcomes ?? {})).toEqual(Object.keys(step.trigger_outcomes ?? {}));
    }
  } finally {
    await client.close();
  }
}

/** The label PEAR's client names itself with in its messages. */
export const CLIENT_LABEL = (VLLMClient as typeof ModelClient).LABEL;
