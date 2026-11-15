import { describe, expect, test } from "vitest";

import { OutputParameter, Result, Ruckig, RuckigError, Trajectory } from "../../src/ruckig/index";
import { load, type RefusedCase } from "./fixtures";
import { buildInput } from "./harness";

const cases = load<RefusedCase>("f_refused");

/** Makes the call a case names on the port, and returns what it returned or the message of what it raised. */
function call(item: RefusedCase): { returns?: boolean | number | string; error?: string; duration?: number } {
  const input = buildInput(item.n, item.i, item.o);
  const generatorDofs = item.gen ?? item.n;
  const generator = item.o?.dt !== undefined ? new Ruckig(generatorDofs, item.o.dt) : new Ruckig(generatorDofs);
  const flags = (item.args ?? []) as [boolean?, boolean?];
  try {
    switch (item.call) {
      case "validate":
        return { returns: input.validate(...flags) };
      case "validate_input":
        return { returns: generator.validateInput(input, ...flags) };
      case "calculate": {
        const trajectory = new Trajectory(item.n);
        return { returns: generator.calculate(input, trajectory), duration: trajectory.duration };
      }
      case "update":
        return { returns: generator.update(input, new OutputParameter(item.out ?? item.n)) };
      case "repr":
        return { returns: input.toString() };
      case "repr_output": {
        // an output after one update, without its last line: the time the calculation took
        const output = new OutputParameter(item.n);
        generator.update(input, output);
        return { returns: output.toString().split("\n").slice(0, 6).join("\n") };
      }
    }
  } catch (error) {
    if (!(error instanceof RuckigError)) {
      throw error;
    }
    return { error: error.message };
  }
}

describe("refused inputs", () => {
  test("the fixture covers every check of the validation and every failure of a calculation", () => {
    const messages = cases.map((item) => item.e ?? "").join("\n");
    for (const part of [
      "maximum jerk limit",
      "maximum acceleration limit",
      "minimum acceleration limit",
      "current acceleration nan",
      "target acceleration nan",
      "exceeds its maximum acceleration limit",
      "undercuts its minimum acceleration limit",
      "current velocity nan",
      "target velocity nan",
      "current position nan",
      "target position nan",
      "maximum velocity limit",
      "minimum velocity limit",
      "exceeds its maximum velocity limit",
      "undercuts its minimum velocity limit",
      "will inevitably reach a velocity",
      "will inevitably have reached a velocity",
      "Intermediate position can not be used",
      "Intermediate positions can only be used",
      "infinite jerk limit",
      "exceeds the maximum number of waypoints",
      "delta time (control rate) parameter",
      "mismatch in degrees of freedom",
      "error in step 1",
      "zero limits conflict in step 1",
      "is not a valid Result",
    ]) {
      expect(messages).toContain(part);
    }
  });

  const raised = cases.filter((item) => item.e !== undefined && item.et === undefined);
  test(`raises the reference's RuckigError, word for word (${raised.length} cases)`, () => {
    expect(raised.length).toBeGreaterThan(60);
    for (const item of raised) {
      expect(call(item), `${item.k} ${item.call}`).toEqual({ error: item.e });
    }
  });

  const returned = cases.filter((item) => item.e === undefined && !item.call.startsWith("repr"));
  test(`returns what the reference returns (${returned.length} cases)`, () => {
    expect(returned.length).toBeGreaterThan(20);
    for (const item of returned) {
      const answer = call(item);
      expect(answer.error, `${item.k} ${item.call}`).toBeUndefined();
      expect(answer.returns, `${item.k} ${item.call}`).toBe(item.returns);
      if (item.d !== undefined) {
        expect(answer.duration, `${item.k} ${item.call}`).toBe(item.d);
      }
    }
  });

  const texts = cases.filter((item) => item.call.startsWith("repr"));
  test(`writes an input and an output as the reference does (${texts.length} cases)`, () => {
    expect(texts.length).toBeGreaterThan(15);
    expect(texts.filter((item) => item.call === "repr_output").length).toBeGreaterThanOrEqual(3);
    for (const item of texts) {
      expect(call(item).returns).toBe(item.returns);
    }
  });

  // The Python module has no name for the C++'s result -101 (a duration above 7,600 s) and raises a ValueError
  // that says so. The port returns the number: the deliberate difference this test pins.
  const unnamed = cases.filter((item) => item.et !== undefined);
  test(`returns the result the Python module cannot name (${unnamed.length} cases)`, () => {
    expect(unnamed.length).toBeGreaterThan(2);
    for (const item of unnamed) {
      expect(item.et).toBe("ValueError");
      expect(item.e).toBe("-101 is not a valid Result.");
      expect(call(item).returns).toBe(Result.ErrorTrajectoryDuration);
    }
  });
});
