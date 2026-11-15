// Runs a scenario PEAR's VLLMClient was recorded on (tests/fixtures/agent/client.json) on pear.js's client, against
// a recording service that answers from the same script, and compares everything with the record.
//
// Where a script breaks a response (its connection ends before the message is whole), which record applies
// depends on what the fetch at hand reports of those bytes (./service.ts says why): a failed connection, and
// PEAR's record of the step applies, since PEAR's HTTP client reported one; or a body that ends, and what applies
// is PEAR's record of the same body ended whole, which the fixture holds as another step (wholeReference). The
// fetch is asked first (breakReports), with a plain request and no client. On a given fetch exactly one record is
// right. Nothing in this file needs Node.

import { expect } from "vitest";

import { ContextLimit, ModelClient, SessionLost } from "../../src/agent/clients/client";
import * as openai from "../../src/agent/clients/openai";
import {
  ModelEvent,
  modelInput,
  modelOutputRecord,
  type ModelInput,
  type ModelOutput,
} from "../../src/agent/clients/schemas";
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
  type BodyStep,
  type ClientScenario,
  type ClientStep,
  type RecordedError,
  type RecordedOutcome,
  type ResponseScript,
  type Trigger,
} from "./records";
import { bodyLength, isBroken, reportOf, type FetchReport, type Service } from "./service";

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
 * ValueError, its status and every class of PEAR's error that pear.js has. ``where`` names the place in a failed
 * comparison's message. */
export function expectOutcome(actual: RecordedOutcome, expected: RecordedOutcome, where?: string): void {
  const say = (what: string): string | undefined => (where ? `${where}: ${what}` : undefined);
  if ("returned" in expected) {
    expect(actual, say("outcome")).toEqual(expected);
    return;
  }

  expect(actual, say("outcome")).toHaveProperty("raised");
  const error = (actual as { raised: RecordedError }).raised;
  const pear = expected.raised;
  expect({ type: error.type, message: error.message }, say("error")).toEqual({
    type: pear.type,
    message: pear.message,
  });
  expect(error.is_value_error, say("whether the error is a ValueError")).toBe(pear.is_value_error);
  expect(error.status_code, say("the error's status")).toBe(pear.status_code);
  if (pear.type in PYTHON_CLASSES) {
    // (an error of a Python class pear.js has no class for carries the class's name alone)
    const shared = pear.bases.filter((name) => name in PYTHON_CLASSES);
    expect(error.bases.filter((name) => shared.includes(name)).sort(), say("the error's classes")).toEqual(
      [...shared].sort(),
    );
  }
}

/** Whether two values of a fixture are equal (they are JSON, their keys in one order). */
function same(first: unknown, second: unknown): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

/** The event that ends a stream of the API. */
const DONE: BodyStep = { data: "data: [DONE]\n\n" };

/** Returns the roles of the conversation a scenario's client holds before step ``index``. */
function historyBefore(scenario: ClientScenario, index: number): string[] {
  return index === 0 ? ["system"] : scenario.steps[index - 1]!.history; // (a conversation starts with its prompt)
}

/** Whether PEAR's client made the same request in two steps of ``scenario``, but for the identities of its
 * frames, and nothing but the request happened in either. */
function isSameRequest(scenario: ClientScenario, first: number, second: number): boolean {
  const [one, other] = [scenario.steps[first]!, scenario.steps[second]!];
  const shape = (step: ClientStep): unknown => [
    step.op,
    step.base_url ?? null,
    step.input?.text ?? null,
    (step.input?.images ?? []).map((image) => image.camera_name),
    (step.input?.reference_images ?? []).length,
  ];
  const isPlain = (step: ClientStep): boolean => !step.cancelled_before && (step.triggers ?? []).length === 0;

  return (
    isPlain(one) &&
    isPlain(other) &&
    same(shape(one), shape(other)) &&
    same(historyBefore(scenario, first), historyBefore(scenario, second))
  );
}

/** How ``whole`` ends the body of ``script``, if it is the same response but whole: "body" where its body is the
 * same and ends as its framing has it, "done" where `data: [DONE]` follows the same body; null for any other. */
function wholeEnding(script: ResponseScript, whole: ResponseScript): "body" | "done" | null {
  const head = (response: ResponseScript): unknown => [
    response.head ?? "send",
    response.status ?? 200,
    response.headers ?? [],
    response.encoding ?? "utf-8",
    response.delay_s ?? 0,
  ];
  // (a response without a head, held or reset before it, has no body to end)
  if (isBroken(whole) || (whole.head ?? "send") !== "send" || !same(head(script), head(whole))) {
    return null;
  }
  if (same(whole.body ?? [], script.body ?? [])) {
    return "body";
  }

  return same(whole.body ?? [], [...(script.body ?? []), DONE]) ? "done" : null;
}

/**
 * Returns the steps of ``scenario`` in which PEAR's client made the request of step ``index`` (but for its frames)
 * and was answered with the same response, whole: ``body`` those whose body is the same and ends as its framing
 * has it, ``done`` those whose body is the same with `data: [DONE]` after it.
 */
export function wholeCounterparts(scenario: ClientScenario, index: number): { body: number[]; done: number[] } {
  const found: { body: number[]; done: number[] } = { body: [], done: [] };
  const responses = scenario.steps[index]!.responses ?? [];
  if (responses.length !== 1) {
    return found;
  }

  scenario.steps.forEach((step, other) => {
    const answers = step.responses ?? [];
    if (other === index || answers.length !== 1 || !isSameRequest(scenario, index, other)) {
      return;
    }
    const ending = wholeEnding(responses[0]!, answers[0]!);
    if (ending !== null) {
      found[ending].push(other);
    }
  });

  return found;
}

/**
 * Returns the step of ``scenario`` on which PEAR's client was recorded with the response of step ``index`` whole:
 * one whose body ends as its framing has it or, where the record holds none, one whose body ends with
 * `data: [DONE]`, which PEAR's client took as it took the end of a body (its record shows that: a test of the
 * fixtures compares every pair of steps that differ in nothing else). Throws where the record holds neither.
 */
export function wholeReference(scenario: ClientScenario, index: number): number {
  const { body, done } = wholeCounterparts(scenario, index);
  const reference = body[0] ?? done[0];
  if (reference === undefined) {
    throw new Error(`${scenario.name}, step ${index}: PEAR's client was not recorded on this response ended whole`);
  }

  return reference;
}

/** Returns what PEAR's client did in ``step`` once its request was sent: what a response decides. (The request,
 * and the first event, which measures the conversation sent, are decided before.) */
export function afterRequest(step: ClientStep): unknown {
  return {
    outcome: step.outcome,
    events: step.events?.slice(1),
    clock_reads: step.clock_reads,
    history: step.history,
    unused_responses: step.unused_responses,
    trigger_outcomes: step.trigger_outcomes,
  };
}

/** Returns what the fetch of ``service`` reports of each response of ``scenario`` that its script breaks, by the
 * index of the response's step. */
export async function breakReports(scenario: ClientScenario, service: Service): Promise<Map<number, FetchReport>> {
  const reports = new Map<number, FetchReport>();
  for (const [index, step] of scenario.steps.entries()) {
    const responses = step.responses ?? [];
    if (!responses.some(isBroken)) {
      continue;
    }
    if (responses.length !== 1) {
      throw new Error(`${scenario.name}, step ${index}: no rule yet for a response that breaks among several`);
    }
    reports.set(index, await reportOf(service, responses[0]!));
  }

  return reports;
}

/** Returns, for a test's name, how a fetch read the broken responses of ``scenario``: nothing for a scenario
 * without one. */
export function reportsNote(scenario: ClientScenario, reports: Map<number, FetchReport>): string {
  if (reports.size === 0) {
    return "";
  }

  const whole = [...reports]
    .filter(([, report]) => report.answer === "whole")
    .map(([index]) => scenario.steps[index]!.label ?? `step ${index}`);
  const failed = reports.size - whole.length;
  const asWhole = whole.length > 0 ? ` and ${whole.length} as whole: ${whole.join(", ")}` : "";

  return ` [of its ${reports.size} broken responses this fetch reports ${failed} as failed connections${asWhole}]`;
}

/**
 * Returns PEAR's record that step ``index`` of ``scenario`` is held to, given what the fetch at hand reports of
 * the step's response (``report``; undefined for a response that does not break), and words for a failed
 * comparison's message that say which record it is.
 */
export function pearRecord(
  scenario: ClientScenario,
  index: number,
  report: FetchReport | undefined,
): { record: ClientStep; basis: string } {
  const step = scenario.steps[index]!;
  if (report === undefined) {
    return { record: step, basis: "" };
  }
  // PEAR's HTTP client reported the broken response as a connection that failed: the step is its record of that
  if (report.answer === "none") {
    return { record: step, basis: ` [this fetch rejects (${report.error}): PEAR's record of the step]` };
  }

  const sent = bodyLength(step.responses![0]!);
  if (report.bytes !== sent) {
    throw new Error(
      `${scenario.name}, step ${index}: this fetch passed on ${report.bytes} of the ${sent} bytes of the body ` +
        "that came before the response broke; PEAR's client was recorded with all of them",
    );
  }
  if (report.answer === "broken") {
    return {
      record: step,
      basis: ` [this fetch fails the read of the body (${report.error}): PEAR's record of the step]`,
    };
  }

  // the body ended as if it were whole: what PEAR's client did before any answer is the step's own record, what
  // it did of the answer is its record of the same response, whole
  const reference = wholeReference(scenario, index);
  const whole = scenario.steps[reference]!;
  let events = whole.events;
  if (step.events !== undefined || whole.events !== undefined) {
    const [measured] = step.events ?? [];
    const [, ...answered] = whole.events ?? [];
    if (measured?.[0] !== ModelEvent.REQUEST_METRICS || whole.events?.[0]?.[0] !== ModelEvent.REQUEST_METRICS) {
      throw new Error(`${scenario.name}, steps ${index} and ${reference}: no rule for events that begin otherwise`);
    }
    events = [measured, ...answered];
  }

  return {
    record: {
      ...step,
      outcome: whole.outcome,
      events,
      clock_reads: whole.clock_reads,
      history: whole.history,
      unused_responses: whole.unused_responses,
      trigger_outcomes: whole.trigger_outcomes,
    },
    basis:
      " [this fetch ends the body as if it were whole: PEAR's record of step " +
      `${reference} (${whole.label ?? whole.op}), the same response ended whole]`,
  };
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

/**
 * Runs ``scenario`` on pear.js's client against ``service`` and expects, at every step, what PEAR's client did.
 * ``reports`` is what the service's fetch reports of the responses the scenario breaks (breakReports), asked here
 * when it is not given: a step with such a response is held to PEAR's record for that report (pearRecord).
 */
export async function runClientScenario(
  scenario: ClientScenario,
  service: Service,
  reports?: Map<number, FetchReport>,
): Promise<void> {
  const reported = reports ?? (await breakReports(scenario, service));
  const clock = new TickClock(scenario.clock.start, scenario.clock.step);
  const client = new VLLMClient(scenario.client.system_prompt, clientOptions(scenario, service, clock));

  try {
    for (const [index, performed] of scenario.steps.entries()) {
      const { record: step, basis } = pearRecord(scenario, index, reported.get(index));
      const where = `step ${index} (${step.op}${step.label ? `: ${step.label}` : ""})${basis}`;
      const reads = clock.reads;
      const savedUrl = client.baseUrl;
      if (performed.base_url !== undefined) {
        client.baseUrl = urlOf(performed.base_url, service);
      }
      await service.begin(performed.responses ?? []);

      let recorded: Pick<ClientStep, "outcome" | "events" | "trigger_outcomes">;
      try {
        if (performed.op === "infer") {
          recorded = await infer(client, performed);
        } else if (performed.op === "check") {
          recorded = { outcome: await outcomeOf(() => client.check()) };
        } else if (performed.op === "close") {
          recorded = { outcome: await outcomeOf(() => client.close()) };
        } else {
          recorded = { outcome: await outcomeOf(() => client.cancel()) };
        }
      } finally {
        client.baseUrl = savedUrl;
      }
      const taken = await service.taken();

      expectOutcome(recorded.outcome, step.outcome, where);
      expect(recorded.events, `${where}: events`).toEqual(step.events);
      expect(taken.requests, `${where}: requests`).toEqual(step.requests);
      expect(taken.unused, `${where}: responses left`).toBe(step.unused_responses);
      expect(clock.reads - reads, `${where}: readings of the clock`).toBe(step.clock_reads);
      expect(
        client.history.map((message) => message.role),
        `${where}: history`,
      ).toEqual(step.history);
      for (const [trigger, expected] of Object.entries(step.trigger_outcomes ?? {})) {
        expectOutcome(recorded.trigger_outcomes![trigger]!, expected, `${where}: trigger ${trigger}`);
      }
      expect(Object.keys(recorded.trigger_outcomes ?? {}), `${where}: triggers`).toEqual(
        Object.keys(step.trigger_outcomes ?? {}),
      );
    }
  } finally {
    await client.close();
  }
}

/** The label PEAR's client names itself with in its messages. */
export const CLIENT_LABEL = (VLLMClient as typeof ModelClient).LABEL;
