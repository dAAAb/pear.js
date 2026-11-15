// The station of the page's Worker (web/src/station_host.ts) on its simulated arm, in Node: the same requests the
// window sends, answered by the same code the Worker runs. The page's own check (web/tests/browser_check.py, part
// "station") runs it in a real Worker of a browser.
//
// The first tests always run and need no time: what the station refuses before it is enabled, the UUIDs, the
// count of the periods, and the verdict of the timing self-check. The last run the station on real time (the
// self-check alone is three seconds) and assert times, so they run only when PEAR_JS_REAL_TIME=1 is set, as
// tests/station-loop/default_clock.test.ts does: a slow machine must not fail `npm test`.

import { describe, expect, it } from "vitest";

import { SIM_START_POSITIONS } from "../../web/src/sim_port";
import {
  StationHost,
  stepPeriods,
  TIMING_LIMITS,
  timingFailureText,
  timingVerdict,
  type TimingNumbers,
  uuid4,
} from "../../web/src/station_host";
import type {
  ActionReport,
  DisableResult,
  EnableResult,
  FromStation,
  HomeResult,
  StationEvent,
  StationRequest,
  StationStatus,
} from "../../web/src/station_protocol";
import { EN, ZH_TW } from "../../web/src/texts";

const REAL_TIME = process.env["PEAR_JS_REAL_TIME"] === "1";

/** A station and what it posted: `ask` sends a request and resolves with its reply. */
function station(): {
  ask: <Result>(request: StationRequest) => Promise<Result>;
  events: StationEvent[];
  lastStatus: () => StationStatus;
  waitFor: (isThere: () => boolean, limitMs?: number) => Promise<void>;
} {
  const events: StationEvent[] = [];
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  const host = new StationHost((message: FromStation) => {
    if (message.kind === "event") events.push(message.event);
    if (message.kind !== "reply") return;
    const entry = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.isOk) entry?.resolve(message.result);
    else entry?.reject(new Error(`${message.error.name}: ${message.error.message}`));
  });

  return {
    events,
    ask: <Result>(request: StationRequest) =>
      new Promise<Result>((resolve, reject) => {
        const id = ++nextId;
        waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
        host.handle({ id, request });
      }),
    lastStatus: () => {
      const statuses = events.filter((event) => event.type === "status");

      return (statuses[statuses.length - 1] as Extract<StationEvent, { type: "status" }>).status;
    },
    waitFor: async (isThere, limitMs = 10_000) => {
      const began = performance.now();
      while (!isThere()) {
        if (performance.now() - began > limitMs) throw new Error("waited too long");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
}

const delta = (arm: Partial<Record<"x" | "y" | "z" | "pitch" | "roll", number>>, width = 0): Record<string, unknown> => ({
  type: "single_arm_delta",
  arm: { x: 0, y: 0, z: 0, pitch: 0, roll: 0, ...arm },
  gripper: { width },
});

describe("the station of the page's Worker, without time", () => {
  it("makes UUIDs as Python writes them and counts the periods of the last second", () => {
    expect(uuid4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stepPeriods([0, 20, 40, 70, 90], 100)).toEqual({ count: 4, meanMs: 22.5, maxMs: 30, over25: 1 });
    expect(stepPeriods([0, 20], 2000)).toEqual({ count: 0, meanMs: 0, maxMs: 0, over25: 0 });
  });

  it("refuses everything but Enable before it is enabled, in the robot's words", async () => {
    const { ask, events } = station();
    await expect(ask({ type: "jog", action: delta({ z: 1 }) })).rejects.toThrow("RuntimeError: Open the station first");
    await expect(ask({ type: "home" })).rejects.toThrow("RuntimeError: Open the station first");
    await expect(ask({ type: "disable" })).rejects.toThrow("RuntimeError: Open the station first");
    await expect(ask({ type: "approve", isApproved: true })).rejects.toThrow("RuntimeError: No Home plan waits for an answer");
    await expect(ask({ type: "stop" })).resolves.toBeNull();
    // nothing was started: no phase, no plan, no timing self-check
    expect(events.filter((event) => event.type !== "status")).toEqual([]);
  });

  describe("the verdict of the timing self-check", () => {
    /** Numbers that pass: every one at its limit, which is not over it. */
    const atLimits: TimingNumbers = {
      meanMs: TIMING_LIMITS.meanMs,
      maxMs: TIMING_LIMITS.periodMs,
      over25: TIMING_LIMITS.periodsOver25,
      maxReadMs: TIMING_LIMITS.readMs,
      unanswered: 0,
    };

    it("passes numbers at their limits and the numbers of a good run", () => {
      expect(timingVerdict(atLimits, TIMING_LIMITS, false)).toEqual([]);
      expect(timingVerdict({ meanMs: 20, maxMs: 21.4, over25: 0, maxReadMs: 0.1, unanswered: 0 }, TIMING_LIMITS, false)).toEqual([]);
    });

    it.each([
      ["period", { maxMs: 40.01 }, { code: "period", value: 40.01, limit: 40 }, "a period took 40.01 ms (limit 40 ms)"],
      ["over25", { over25: 4 }, { code: "over25", value: 4, limit: 3 }, "4 periods took over 25 ms (limit 3)"],
      ["mean", { meanMs: 20.51 }, { code: "mean", value: 20.51, limit: 20.5 }, "the mean period was 20.51 ms (limit 20.5 ms)"],
      ["read", { maxReadMs: 15.01 }, { code: "read", value: 15.01, limit: 15 }, "a read took 15.01 ms (limit 15 ms)"],
      ["unanswered", { unanswered: 1 }, { code: "unanswered", value: 1, limit: 0 }, "1 reads were not answered by every servo"],
    ] as const)("fails the limit %s alone, with what was measured", (_code, over, reason, text) => {
      const reasons = timingVerdict({ ...atLimits, ...over }, TIMING_LIMITS, false);
      expect(reasons).toEqual([reason]);
      expect(reasons.map(timingFailureText)).toEqual([text]);
    });

    it("fails a hidden page whatever the numbers are", () => {
      const reasons = timingVerdict(atLimits, TIMING_LIMITS, true);
      expect(reasons).toEqual([{ code: "hidden", value: null, limit: null }]);
      expect(reasons.map(timingFailureText)).toEqual(["the page is not visible"]);
    });

    it("gives every reason, in a fixed order, and takes the limits it is given", () => {
      const bad: TimingNumbers = { meanMs: 30, maxMs: 90, over25: 60, maxReadMs: 22, unanswered: 7 };
      expect(timingVerdict(bad, TIMING_LIMITS, true).map(({ code }) => code)).toEqual([
        "period",
        "over25",
        "mean",
        "read",
        "unanswered",
        "hidden",
      ]);
      // other limits, other verdict: the limits are not read from anywhere else
      expect(timingVerdict(bad, { periodMs: 100, periodsOver25: 60, meanMs: 30, readMs: 22 }, false)).toEqual([
        { code: "unanswered", value: 7, limit: 0 },
      ]);
    });

    it("has the page's sentence for every reason in both languages; the English one is the Worker's", () => {
      const reasons = timingVerdict({ meanMs: 30.25, maxMs: 90.5, over25: 61, maxReadMs: 22.75, unanswered: 7 }, TIMING_LIMITS, true);
      expect(reasons).toHaveLength(6);
      for (const reason of reasons) {
        const key = `station.timing.fail.${reason.code}` as const;
        const filled = (text: string): string =>
          text.replace("{value}", String(reason.value ?? "")).replace("{limit}", String(reason.limit ?? ""));
        expect(filled(EN[key])).toBe(timingFailureText(reason));
        const chinese = filled(ZH_TW[key]);
        expect(chinese).toMatch(/[一-鿿]/);
        expect(chinese).not.toMatch(/[{}]/);
        if (reason.value !== null) expect(chinese).toContain(String(reason.value));
        if (reason.limit !== null && reason.code !== "unanswered") expect(chinese).toContain(String(reason.limit));
      }
    });
  });
});

describe.skipIf(!REAL_TIME)("the station of the page's Worker, on its simulated arm in real time", () => {
  it("enables, moves by one action, stops a move, goes Home with an approval and disables", async () => {
    const { ask, events, lastStatus, waitFor } = station();
    // a hidden page fails the timing self-check, which refuses to enable
    await expect(ask({ type: "enable", positions: SIM_START_POSITIONS, isHidden: true })).rejects.toThrow(
      "RuntimeError: The timing self-check failed: the page is not visible",
    );
    expect(events.filter((event) => event.type === "timing")).toHaveLength(1);
    const enabled = await ask<EnableResult>({ type: "enable", positions: SIM_START_POSITIONS, isHidden: false });
    console.log(`station_host in real time: opened in ${enabled.openMs} ms; self-check ${JSON.stringify(enabled.timing)}`);
    expect(enabled.openMs).toBeLessThan(3000);
    expect(enabled.timing).toMatchObject({ periods: 150, failures: [], reasons: [] });
    expect(enabled.timing.maxReadMs).toBeLessThan(15);
    await expect(ask({ type: "enable", positions: SIM_START_POSITIONS, isHidden: false })).rejects.toThrow("RuntimeError: Station already open");
    await waitFor(() => lastStatus().robot === "READY");
    const before = lastStatus();
    expect(before.control).toBe("HOLD");
    expect(before.joints).toHaveLength(6);
    expect(before.turnText).toContain('"arm"');

    // one action of the model's format (centimetres and radians): 1 cm up
    const report = await ask<ActionReport>({ type: "jog", action: delta({ z: 1 }) });
    expect(report.record["status"]).toBe("completed");
    expect(JSON.parse(report.feedback.replace(" Use the new measured observation.", ""))).toMatchObject({
      status: "completed",
      execution_requested: true,
      settled: true,
      reached: true,
    });
    expect(report.turnText).toContain(`Previous execution: ${report.feedback}`);
    await waitFor(() => lastStatus().robot === "READY");
    expect((lastStatus().state?.arm.z ?? 0) - (before.state?.arm.z ?? 0)).toBeCloseTo(1, 0);
    expect(events.filter((event) => event.type === "phase").map((event) => (event as { phase: string }).phase)).toEqual([
      "Planning",
      "Executing",
    ]);

    // out of reach: rejected with the format's own text, and nothing moved
    const far = await ask<ActionReport>({ type: "jog", action: delta({ x: 60 }) });
    expect(far.record["status"]).toBe("rejected");
    expect(far.feedback).toContain('"code": "out_of_reach"');
    expect(far.feedback).toContain("Nothing moved: the whole action was discarded (arm and gripper).");

    // Stop while a move is under way: the action ends, not completed, and the arm holds
    const moving = ask<ActionReport>({ type: "jog", action: delta({ z: -6 }) });
    await waitFor(() => lastStatus().control !== "HOLD");
    await ask({ type: "stop" });
    const stopped = await moving;
    expect(stopped.record["status"]).not.toBe("completed");
    await waitFor(() => lastStatus().robot === "READY");
    expect(lastStatus().control).toBe("HOLD");

    // Home: the plan is shown and waits; refused, then approved
    const refused = ask<HomeResult>({ type: "home" });
    await waitFor(() => events.some((event) => event.type === "plan"));
    await ask({ type: "approve", isApproved: false });
    await expect(refused).rejects.toThrow();
    events.length = 0;
    const home = ask<HomeResult>({ type: "home" });
    await waitFor(() => events.some((event) => event.type === "plan"));
    await ask({ type: "approve", isApproved: true });
    const homed = await home;
    expect(homed.plan["operation_seconds_estimate"]).toBeGreaterThan(0);
    expect(homed.stages.length).toBeGreaterThan(0);

    const periods = lastStatus().periods;
    console.log(`station_host in real time: the periods of the last second ${JSON.stringify(periods)}`);
    expect(periods.count).toBeGreaterThan(40);

    const disabled = await ask<DisableResult>({ type: "disable" });
    expect(Object.keys(disabled.positions)).toHaveLength(6);
    expect(lastStatus().robot).toBe("OFF");
    await expect(ask({ type: "stop" })).resolves.toBeNull();
  }, 120_000);
});
