import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { SO101Follower } from "../../src/so101/hardware/follower";
import { JOINTS } from "../../src/so101/hardware/motors";
import { BridgeControl, bridgeAddress } from "./bridge_control";
import { compareResults, describeComparison } from "./compare";
import { loadSessions, type RunResult, runSessions } from "./session";
import { TcpTransport } from "./tcp_transport";
import { describeTiming, timingOf } from "./timing";

// Integration tests on a simulated SO-101 servo chain reachable over TCP, which is not part of this repository.
// They run only when the environment says where the chain is; without it they are skipped, so `npm test` needs
// nothing but Node.
//
//   PEAR_JS_SIM_BRIDGE=host:port            the chain's serial line: raw bytes of the Feetech protocol
//   PEAR_JS_SIM_BRIDGE_CONTROL=host:port    its test controls over HTTP (default: the same host, the next port)
//   PEAR_JS_SIM_BRIDGE_REFERENCE=file       the result of the same sessions run by PEAR's Python on the same chain:
//                                           with it the two are compared
//   PEAR_JS_SIM_BRIDGE_OUT=directory        where this run's result, comparison and timing are written
//
// docs/progress/sim-bridge.md says what the chain must offer and what was found.

const address = bridgeAddress();
const referenceFile = process.env.PEAR_JS_SIM_BRIDGE_REFERENCE;
const outDirectory = process.env.PEAR_JS_SIM_BRIDGE_OUT;
const DEGREES_PER_RAD = 180 / Math.PI;
const COUNT_DEG = 360 / 4096; // one step of the STS3215's encoder

function keep(name: string, text: string): void {
  if (outDirectory === undefined || outDirectory === "") return;
  mkdirSync(outDirectory, { recursive: true });
  writeFileSync(join(outDirectory, name), text);
}

describe.skipIf(address === null)("pear.js on a simulated SO-101 servo chain over TCP", () => {
  const { host, port, control: controlAddress } = address ?? { host: "", port: 0, control: "" };
  const control = new BridgeControl(controlAddress);
  let result: RunResult | null = null;

  test("the bus's handshake and calibration check pass, and the positions it reads are the chain's", async () => {
    await control.reset();
    const transport = await TcpTransport.connect(host, port);
    const follower = new SO101Follower(transport, await control.calibration());
    try {
      await follower.bus.connect(true);
      expect(await follower.bus.isCalibrated()).toBe(true);

      const read = await follower.bus.syncRead("Present_Position");
      const state = await control.state();
      // an encoder's rounding, lerobot's division by 4095 and the full-turn joint's middle: within 1.5 counts
      for (const joint of JOINTS) {
        expect(Math.abs(read[joint] - state.joints_rad[joint] * DEGREES_PER_RAD)).toBeLessThanOrEqual(1.5 * COUNT_DEG);
      }
      expect(Math.abs(read.gripper - 100 * state.gripper_opening)).toBeLessThanOrEqual(0.2);
    } finally {
      await follower.bus.disconnect(false);
    }
    expect(transport.isClosed).toBe(true);
  }, 30_000);

  test("the scripted sessions run to their end", async () => {
    const { document } = loadSessions();
    result = await runSessions({ host, port, control });
    keep("pear-js.result.json", JSON.stringify(result));

    expect(result.sessions.map((session) => session.name)).toEqual(document.sessions.map((session) => session.name));
    result.sessions.forEach((session, index) => {
      expect(session.steps).toHaveLength(document.sessions[index].steps.length);
    });
    // the first session is the one without a fault at start-up: the arm opens, and it is closed at the end
    const nominal = result.sessions[0].steps;
    expect(nominal.find((step) => step.op === "open")?.error).toBeUndefined();
    expect(nominal.find((step) => step.op === "close")?.error).toBeUndefined();
    expect(nominal.filter((step) => step.skipped !== undefined)).toEqual([]);

    // nothing is left connected; the chain may take a moment to notice that the last line was closed
    let client = (await control.state()).line.client;
    for (let attempt = 0; attempt < 20 && client !== null; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      client = (await control.state()).line.client;
    }
    expect(client).toBeNull();
  }, 600_000);

  test.skipIf(referenceFile === undefined || referenceFile === "")(
    "pear.js puts the same packets on the wire as PEAR's Python, reads the same and refuses the same",
    () => {
      expect(result).not.toBeNull();
      if (result === null) return;
      const reference = JSON.parse(readFileSync(referenceFile ?? "", "utf8")) as RunResult;
      const comparison = compareResults(reference, result);
      const lines = [
        `reference: ${reference.side} on the ${reference.bridge.clock} clock; ` +
          `candidate: ${result.side} on the ${result.bridge.clock} clock`,
        ...describeComparison(comparison),
      ];
      keep("comparison.txt", `${lines.join("\n")}\n`);
      console.log(lines.join("\n"));

      // whatever the clock: the same steps, the same instruction packets in the same order, the same refusals
      expect(comparison.steps.differing).toEqual([]);
      expect(comparison.hostPackets.reference).toBeGreaterThan(0);
      expect(comparison.hostPackets.candidate).toBe(comparison.hostPackets.reference);
      expect(comparison.hostPackets.differing).toBe(0);
      expect(comparison.refusals.compared).toBeGreaterThan(0);
      expect(comparison.refusals.differing).toEqual([]);
      expect(comparison.refusals.sameMessage).toBe(comparison.refusals.compared);
      expect(comparison.refusals.sameMappedType).toBe(comparison.refusals.compared);
      expect(comparison.warnings.differing).toEqual([]);
      expect(comparison.readingsBetween.statusDiffering + comparison.readingsCommanded.statusDiffering).toBe(0);

      if (reference.bridge.clock === "packets" && result.bridge.clock === "packets") {
        // the simulated arm aged with the packets alone: what the servos answered is the same to the last bit
        expect(comparison.servoPackets.differing).toBe(0);
        expect(comparison.readingsBetween.identical).toBe(comparison.readingsBetween.compared);
        expect(comparison.readingsCommanded.identical).toBe(comparison.readingsCommanded.compared);
      }
    },
  );

  test("the read and send of a control period fit the period", () => {
    expect(result).not.toBeNull();
    if (result === null) return;
    const timing = timingOf(result);
    const lines = describeTiming(timing, result.arm.control_period_s, result.bridge.clock === "realtime");
    keep("timing.txt", `${lines.join("\n")}\n`);
    console.log(lines.join("\n"));

    expect(timing.burst).not.toBeNull();
    expect(timing.burst?.cycle.median ?? Number.NaN).toBeLessThan(result.arm.control_period_s * 1000);
  });
});
