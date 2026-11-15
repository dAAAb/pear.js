import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  afterRequest,
  breakReports,
  CLIENT_LABEL,
  reportsNote,
  runClientScenario,
  wholeCounterparts,
  wholeReference,
} from "./client_scenarios";
import { loadFixture, type ClientScenario, type Meta } from "./fixtures";
import { isBroken, ScriptedFetchService, type FetchReport, type Service } from "./service";
import { SocketService, type SocketServiceOptions } from "./socket_service";

const scenarios = loadFixture<{ scenarios: ClientScenario[] }>("client.json").scenarios;
const meta = loadFixture<Meta>("meta.json");
/** The scenarios in which a script breaks a response: its connection ends before the message is whole. */
const breaking = scenarios.filter((scenario) => scenario.steps.some((step) => (step.responses ?? []).some(isBroken)));

/** A scenario to run on one fetch: the scenario's name with how that fetch reads its broken responses, the
 * scenario, and those readings by step. */
type Run = [name: string, scenario: ClientScenario, reports: Map<number, FetchReport>];

/** Asks the fetch of ``service`` what it reports of the broken responses of each of ``chosen``. */
async function runsOn(service: Service, chosen: ClientScenario[]): Promise<Run[]> {
  const runs: Run[] = [];
  for (const scenario of chosen) {
    const reports = await breakReports(scenario, service);
    runs.push([scenario.name + reportsNote(scenario, reports), scenario, reports]);
  }

  return runs;
}

/** Asks the runtime's fetch, against a service on a socket, what it reports of the broken responses of each of
 * ``chosen``. */
async function runsOnSocket(options: SocketServiceOptions, chosen: ClientScenario[]): Promise<Run[]> {
  const service = await SocketService.start(options);
  try {
    return await runsOn(service, chosen);
  } finally {
    await service.close();
  }
}

// Each fetch is asked before the tests are named, so that a test's name says which of PEAR's records it requires:
// a broken response is a failed connection to PEAR's HTTP client, and to a fetch either that or a body that ends.
const scripted = await runsOn(new ScriptedFetchService(), scenarios);
const lenient = await runsOn(new ScriptedFetchService("ends"), breaking);
const runtime = await runsOnSocket({}, scenarios);
const unannounced = await runsOnSocket({ unannouncedBreaks: true }, breaking);

describe("VLLMClient, with a fetch that answers from the script", () => {
  test.each(scripted)("does what PEAR's client did: %s", async (_name, scenario, reports) => {
    await runClientScenario(scenario, new ScriptedFetchService(), reports);
  });
});

describe("VLLMClient, with a fetch that answers from the script and ends a cut chunked body as if it were whole", () => {
  // (as Node's fetch does before undici 6.26.0 and 7.26.0: so that every runtime's run holds the client to both)
  test.each(lenient)("does what PEAR's client did: %s", async (_name, scenario, reports) => {
    await runClientScenario(scenario, new ScriptedFetchService("ends"), reports);
  });
});

describe("VLLMClient, with the runtime's fetch against a server on 127.0.0.1", () => {
  let service: Service;

  beforeAll(async () => {
    service = await SocketService.start();
  });
  afterAll(async () => {
    await service.close();
  });

  test.each(runtime)("does what PEAR's client did: %s", async (_name, scenario, reports) => {
    await runClientScenario(scenario, service, reports);
  });
});

describe("VLLMClient, with the runtime's fetch against a server that breaks a response without having announced the connection's end", () => {
  // (not the bytes of the recording server, which announced it with every response: the bytes of a server that
  // meant to keep the connection, and breaks)
  let service: Service;

  beforeAll(async () => {
    service = await SocketService.start({ unannouncedBreaks: true });
  });
  afterAll(async () => {
    await service.close();
  });

  test.each(unannounced)("does what PEAR's client did: %s", async (_name, scenario, reports) => {
    await runClientScenario(scenario, service, reports);
  });
});

describe("the client fixtures", () => {
  test("name the client as PEAR does", () => {
    expect(CLIENT_LABEL).toBe(meta.label);
  });

  test("hold no key but the tests' own", () => {
    const requests = scenarios.flatMap((scenario) => scenario.steps.flatMap((step) => step.requests));
    const keys = new Set(requests.map((request) => request.headers.authorization));

    expect([...keys].sort()).toEqual(["Bearer test-key", "Bearer unused"]);
  });

  test("hold, of every response that breaks after its head, PEAR's record of the same response ended whole", () => {
    // what a fetch that ends such a body as if it were whole is held to
    const references = breaking.flatMap((scenario) =>
      scenario.steps.flatMap((step, index) => {
        const [response] = step.responses ?? [];
        const breaksAfterHead = response !== undefined && isBroken(response) && response.head !== "reset";

        return breaksAfterHead ? [wholeReference(scenario, index)] : [];
      }),
    );

    expect(references.length).toBeGreaterThan(0);
  });

  test("show that PEAR's client took `data: [DONE]` as it took the end of a body", () => {
    // the rule by which the whole counterpart of a broken response may end with [DONE]: every two steps recorded
    // on the same request and the same response, whole, one of which ends with [DONE], hold the same record of
    // what the client did of the response
    const pairs = scenarios.flatMap((scenario) =>
      scenario.steps.flatMap((step, index) => {
        const isWhole = (step.responses ?? []).length === 1 && !isBroken(step.responses![0]!);

        return isWhole ? wholeCounterparts(scenario, index).done.map((done) => [scenario, index, done] as const) : [];
      }),
    );

    expect(pairs.length).toBeGreaterThan(0);
    for (const [scenario, plain, done] of pairs) {
      expect(afterRequest(scenario.steps[done]!), `${scenario.name}, steps ${plain} and ${done}`).toEqual(
        afterRequest(scenario.steps[plain]!),
      );
    }
  });
});
