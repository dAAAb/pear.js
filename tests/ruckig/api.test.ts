// What the fixtures cannot hold: how the port's objects behave as objects (what the Python module's do), the
// deliberate differences from it, and the rules of this repository for the files under src/ruckig.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  ControlInterface,
  ControlSigns,
  Direction,
  DurationDiscretization,
  ENGINE_LIBM,
  InputParameter,
  OutputParameter,
  Profile,
  ReachedLimits,
  Result,
  Ruckig,
  RuckigError,
  Synchronization,
  Trajectory,
  libm,
  replaceLibm,
} from "../../src/ruckig/index";
import { meta } from "./fixtures";

const SOURCE = fileURLToPath(new URL("../../src/ruckig/", import.meta.url));

/** An input of `dofs` coordinates from rest at 0 to rest at 1, with the SO-101's arm caps. */
function input(dofs: number): InputParameter {
  const result = new InputParameter(dofs);
  result.targetPosition = new Array<number>(dofs).fill(1.0);
  result.maxVelocity = new Array<number>(dofs).fill(1.0);
  result.maxAcceleration = new Array<number>(dofs).fill(2.0);
  result.maxJerk = new Array<number>(dofs).fill(10.0);
  return result;
}

describe("the interface is the Python module's", () => {
  test("the enumerations have Ruckig's numbers", () => {
    expect(Result).toEqual({
      Working: 0,
      Finished: 1,
      Error: -1,
      ErrorInvalidInput: -100,
      ErrorTrajectoryDuration: -101,
      ErrorPositionalLimits: -102,
      ErrorZeroLimits: -104,
      ErrorExecutionTimeCalculation: -110,
      ErrorSynchronizationCalculation: -111,
    });
    expect(ControlInterface).toEqual({ Position: 0, Velocity: 1 });
    expect(Synchronization).toEqual({ Time: 0, TimeIfNecessary: 1, Phase: 2, No: 3 });
    expect(DurationDiscretization).toEqual({ Continuous: 0, Discrete: 1 });
    expect(ReachedLimits).toEqual({ ACC0_ACC1_VEL: 0, VEL: 1, ACC0: 2, ACC1: 3, ACC0_ACC1: 4, ACC0_VEL: 5, ACC1_VEL: 6, NONE: 7 });
    expect(Direction).toEqual({ UP: 0, DOWN: 1 });
    expect(ControlSigns).toEqual({ UDDU: 0, UDUD: 1 });
  });

  test("a new input is at rest at zero, without acceleration or jerk caps, every coordinate enabled", () => {
    const fresh = new InputParameter(3);

    expect(fresh.degreesOfFreedom).toBe(3);
    expect(fresh.currentPosition).toEqual([0, 0, 0]);
    expect(fresh.targetVelocity).toEqual([0, 0, 0]);
    expect(fresh.maxVelocity).toEqual([0, 0, 0]);
    expect(fresh.maxAcceleration).toEqual([Infinity, Infinity, Infinity]);
    expect(fresh.maxJerk).toEqual([Infinity, Infinity, Infinity]);
    expect(fresh.enabled).toEqual([true, true, true]);
    expect(fresh.minVelocity).toBeUndefined();
    expect(fresh.minAcceleration).toBeUndefined();
    expect(fresh.minimumDuration).toBeUndefined();
    expect(fresh.perDofControlInterface).toBeUndefined();
    expect(fresh.perDofSynchronization).toBeUndefined();
    expect(fresh.intermediatePositions).toEqual([]);
    expect(fresh.controlInterface).toBe(ControlInterface.Position);
    expect(fresh.synchronization).toBe(Synchronization.Time);
    expect(fresh.durationDiscretization).toBe(DurationDiscretization.Continuous);
  });

  test("a vector is copied when it is set and when it is read, as the Python module's lists are", () => {
    const given = [0.1, 0.2];
    const parameter = new InputParameter(2);
    parameter.currentPosition = given;
    given[0] = 9;
    expect(parameter.currentPosition).toEqual([0.1, 0.2]);

    const read = parameter.currentPosition;
    read[1] = 9;
    expect(parameter.currentPosition).toEqual([0.1, 0.2]);

    parameter.minVelocity = new Float64Array([-1, -2]);
    expect(parameter.minVelocity).toEqual([-1, -2]);
    parameter.minVelocity = null;
    expect(parameter.minVelocity).toBeUndefined();
  });

  test("a state read from the output is not changed by the next update", () => {
    const generator = new Ruckig(1, 0.02);
    const parameter = input(1);
    const output = new OutputParameter(1);

    expect(generator.update(parameter, output)).toBe(Result.Working);
    const first = output.newPosition;
    const firstValue = first[0];
    output.passToInput(parameter);
    expect(generator.update(parameter, output)).toBe(Result.Working);

    expect(first[0]).toBe(firstValue);
    expect(output.newPosition[0]).toBeGreaterThan(firstValue);
    expect(output.newJerk).toEqual([10]);
  });

  test("a generator has the Python module's attributes", () => {
    const offline = new Ruckig(4);
    const online = new Ruckig(4, 0.02);

    expect([offline.degreesOfFreedom, offline.deltaTime, offline.maxNumberOfWaypoints]).toEqual([4, -1, 0]);
    expect(online.deltaTime).toBe(0.02);
    online.deltaTime = 0.01;
    expect(online.deltaTime).toBe(0.01);
    expect(offline.validateInput(input(4))).toBe(true);
    expect(input(4).validate(true, true)).toBe(true);
  });

  test("a trajectory gives its duration, its state at a time, its extrema and copies of its profiles", () => {
    const trajectory = new Trajectory(2);
    expect(trajectory.degreesOfFreedom).toBe(2);
    expect(trajectory.duration).toBe(0);

    expect(new Ruckig(2).calculate(input(2), trajectory)).toBe(Result.Working);
    const duration = trajectory.duration;
    expect(duration).toBeGreaterThan(1);
    expect(trajectory.intermediateDurations).toEqual([duration]);
    expect(trajectory.independentMinDurations).toEqual([duration, duration]);

    // three vectors, and the section after them when it is asked for: 0 within the trajectory, 1 from its end on
    const state = trajectory.atTime(duration / 2);
    expect(state.map((vector) => vector.length)).toEqual([2, 2, 2]);
    expect(state[0][0]).toBeGreaterThan(0);
    expect(state[0][0]).toBeLessThan(1);
    expect(trajectory.atTime(duration / 2, true)[3]).toBe(0);
    expect(trajectory.atTime(duration + 1, true)[3]).toBe(1);

    const [extremum] = trajectory.positionExtrema;
    expect(Object.keys(extremum).sort()).toEqual(["max", "min", "tMax", "tMin"]);
    expect([extremum.min, extremum.tMin]).toEqual([0, 0]);
    expect(extremum.tMax).toBeGreaterThan(0);

    const profiles = trajectory.profiles;
    expect(profiles.length).toBe(1);
    expect(profiles[0].length).toBe(2);
    expect(profiles[0][0]).toBeInstanceOf(Profile);
    expect(profiles[0][0].toString()).toBe("UP_ACC0_ACC1_VEL_UDDU");
    expect([profiles[0][0].t.length, profiles[0][0].j.length, profiles[0][0].a.length, profiles[0][0].brake.t.length]).toEqual([7, 7, 8, 2]);
    profiles[0][0].t[3] = 100;
    expect(trajectory.profiles[0][0].t[3]).not.toBe(100);

    expect(trajectory.getFirstTimeAtPosition(0, 0.5)).toBeGreaterThan(0);
    expect(trajectory.getFirstTimeAtPosition(0, 5.0)).toBeUndefined();
    expect(trajectory.getFirstTimeAtPosition(7, 0.5)).toBeUndefined();
  });

  test("an update calculates anew after a reset, and not when the output was passed to the input", () => {
    const generator = new Ruckig(1, 0.02);
    const parameter = input(1);
    const output = new OutputParameter(1);

    generator.update(parameter, output);
    expect(output.newCalculation).toBe(true);
    output.passToInput(parameter);
    generator.update(parameter, output);
    expect(output.newCalculation).toBe(false);
    expect(output.time).toBe(0.02 + 0.02);

    generator.reset();
    output.passToInput(parameter);
    generator.update(parameter, output);
    expect(output.newCalculation).toBe(true);
    expect(output.time).toBe(0.02);
  });

});

describe("deliberate differences from the Python module", () => {
  test("a vector that is too short is refused, where the C++ would read past its end", () => {
    const parameter = input(3);
    parameter.maxVelocity = [1, 1];

    expect(() => parameter.validate()).toThrow(RuckigError);
    expect(() => new Ruckig(3).calculate(parameter, new Trajectory(3))).toThrow("\n[ruckig] mismatch in degrees of freedom (vector size).");
    expect(() => new Ruckig(3).calculate(input(2), new Trajectory(3))).toThrow("mismatch in degrees of freedom");
    expect(() => new Ruckig(3).calculate(input(3), new Trajectory(2))).toThrow("mismatch in degrees of freedom");
    // a vector that is too long is used as far as it is needed, as in the C++ (the fixtures of set f hold cases)
    parameter.maxVelocity = [1, 1, 1, 1];
    expect(parameter.validate()).toBe(true);
  });

  test("a duration above 7,600 s is returned as Ruckig's result, for which the Python module has no name", () => {
    const parameter = input(2);
    parameter.targetPosition = [1e6, 1];
    const output = new OutputParameter(2);

    expect(new Ruckig(2).calculate(parameter, new Trajectory(2))).toBe(Result.ErrorTrajectoryDuration);
    expect(new Ruckig(2, 0.02).update(parameter, output)).toBe(-101);
    expect(output.newCalculation).toBe(false);
    // one coordinate without a minimum or discrete duration is not checked, in the reference either
    const single = input(1);
    single.targetPosition = [1e6];
    expect(new Ruckig(1).calculate(single, new Trajectory(1))).toBe(Result.Working);
  });

  test("an error is a RuckigError whose message begins as the C++'s", () => {
    const parameter = input(1);
    parameter.maxJerk = [-1];
    let caught: unknown;
    try {
      new Ruckig(1).calculate(parameter, new Trajectory(1));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RuckigError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as RuckigError).name).toBe("RuckigError");
    expect((caught as RuckigError).message).toBe("\n[ruckig] maximum jerk limit -1.000000 of DoF 0 should be larger than or equal to zero.");
  });
});

describe("the files under src/ruckig", () => {
  const files = readdirSync(SOURCE).filter((name) => name.endsWith(".ts"));
  const text = (name: string): string => readFileSync(`${SOURCE}${name}`, "utf8");

  test("use nothing a browser lacks and no other module", () => {
    expect(files.length).toBeGreaterThan(20);
    for (const name of files) {
      const source = text(name);
      const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
      expect(imports.filter((path) => !/^\.\/[a-z_0-9]+$/.test(path)), name).toEqual([]);
      expect(source, name).not.toMatch(/\b(require\(|process\.|Buffer\b|__dirname|globalThis\.process)/);
    }
  });

  test("name what they port and whose it is, and the licence is upstream's file", () => {
    for (const name of files.filter((file) => !["index.ts", "libm.ts", "sort.ts"].includes(file))) {
      const head = text(name).split("\n").slice(0, 6).join("\n");
      expect(head, name).toMatch(/Ports (include|src)\/ruckig\/[a-z_0-9]+\.(hpp|cpp)/);
      expect(head, name).toContain("Ruckig 0.15.3");
      expect(head, name).toContain("Copyright (c) 2021 Lars Berscheid");
    }
    // the file of the tag v0.15.3, byte for byte
    const licence = readFileSync(`${SOURCE}LICENSE`);
    expect(createHash("sha256").update(licence).digest("hex")).toBe("f0880ac5e5026c92e12c9e2859a7b338c593aaca1a435f29498bd96cbb64d7d3");
  });

  test("were compared with the module of the version they port", () => {
    expect(meta().versions.ruckig).toBe("0.15.3");
  });

  test("reach the C library's inexact functions only through libm.ts", () => {
    for (const name of files.filter((file) => file !== "libm.ts")) {
      expect(text(name), name).not.toMatch(/Math\.(cbrt|sin|cos|tan|atan|atan2|acos|asin|exp|log|pow|hypot)\b/);
    }
    const restore = replaceLibm({ cbrt: () => 7 });
    expect(libm.cbrt(8)).toBe(7);
    restore();
    expect(libm.cbrt(8)).toBe(2);
    expect(libm.cbrt).toBe(ENGINE_LIBM.cbrt);
  });
});
