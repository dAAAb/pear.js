import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { CLIENT_LABEL, runClientScenario } from "./client_scenarios";
import { loadFixture, type ClientScenario, type Meta } from "./fixtures";
import { ScriptedFetchService, SocketService, type Service } from "./service";

const scenarios = loadFixture<{ scenarios: ClientScenario[] }>("client.json").scenarios;
const meta = loadFixture<Meta>("meta.json");

describe("VLLMClient, with a fetch that answers from the script", () => {
  test.each(scenarios.map((scenario) => [scenario.name, scenario] as const))(
    "does what PEAR's client did: %s",
    async (_name, scenario) => {
      await runClientScenario(scenario, new ScriptedFetchService());
    },
  );
});

describe("VLLMClient, with the runtime's fetch against a server on 127.0.0.1", () => {
  let service: Service;

  beforeAll(async () => {
    service = await SocketService.start();
  });
  afterAll(async () => {
    await service.close();
  });

  test.each(scenarios.map((scenario) => [scenario.name, scenario] as const))(
    "does what PEAR's client did: %s",
    async (_name, scenario) => {
      await runClientScenario(scenario, service);
    },
  );
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
});
