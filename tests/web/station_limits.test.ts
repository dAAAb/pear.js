// The station of the page's Worker (web/src/station_host.ts) enabled with a joint at the end of its calibrated
// range, in Node: on a real arm's line over simulated servos ("enableReal", on a clock that does not wait) and on
// the simulated arm ("enable", in real time, so only when PEAR_JS_REAL_TIME=1 is set).
//
// PEAR's position bounds (the limits of src/so101/config.ts) are radians about the middle of a joint's calibrated
// range, and they are the same for every calibration. The first feedback PEAR's control loop reads when the robot
// opens must lie within them, widened by feedback_position_tolerance (0.06 rad, 39 steps): a joint that stands
// further out makes the opening fail with a ValueError, and the Worker answers the Enable with that error. The
// simulated arm's calibration is wider than the bounds for shoulder_pan, shoulder_lift, elbow_flex and wrist_roll,
// so there the ends of the calibrated range are refused; wrist_flex and the gripper are accepted at their ends.
//
// On a real arm's line the Worker finds such a joint by reads alone, before the operator is asked: the arming
// report holds the reason "bounds" with the joint, where it stands and the steps PEAR accepts, the request ends
// "blocked" and nothing is written to a servo. PEAR's own refusal still comes when a joint leaves the bounds
// between that report and the operator's confirmation, for the arm is limp all that while.
import { afterEach, describe, expect, it } from "vitest";

import { MODEL_NUMBER_VALUE } from "../../src/feetech/index";
import { MOTORS, type MotorName } from "../../src/so101/hardware/index";
import type { MonotonicClock } from "../../src/station/joint/clock";
import { SIM_CALIBRATION, SIM_START_POSITIONS, SimArm, simulatedConfiguredPort } from "../../web/src/sim_port";
import { ENABLE_SETTINGS, GRIPPER_SETTINGS, StationHost } from "../../web/src/station_host";
import type {
  ArmFingerprint,
  ArmingBlocker,
  EnableRealResult,
  EnableResult,
  FromStation,
  PortSource,
  PreflightReport,
  StationEvent,
  StationRequest,
  StationStatus,
} from "../../web/src/station_protocol";

const REAL_TIME = process.env["PEAR_JS_REAL_TIME"] === "1";

/** A clock on which time passes only while everything waits for it, as in station_real.test.ts. */
class EventClock implements MonotonicClock {
  private nowS = 100;
  private readonly sleepers: Array<{ at: number; wake: () => void }> = [];
  private isPumping = false;

  monotonic(): number {
    return this.nowS;
  }

  sleep(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      this.sleepers.push({ at: this.nowS + Math.max(seconds, 0), wake: resolve });
      this.pumpLater();
    });
  }

  private pumpLater(): void {
    if (this.isPumping || this.sleepers.length === 0) return;
    this.isPumping = true;
    setImmediate(() => {
      this.isPumping = false;
      let first = 0;
      for (let index = 1; index < this.sleepers.length; index++) {
        if ((this.sleepers[index] as { at: number }).at < (this.sleepers[first] as { at: number }).at) first = index;
      }
      const [sleeper] = this.sleepers.splice(first, 1);
      if (sleeper === undefined) return;
      this.nowS = Math.max(this.nowS, sleeper.at);
      sleeper.wake();
      this.pumpLater();
    });
  }
}

/** The servos as the window would have read them: the calibration the simulated arm holds. */
const PRINT: ArmFingerprint = MOTORS.map((motor) => {
  const { id, homingOffset, rangeMin, rangeMax } = SIM_CALIBRATION[motor];

  return { id, model: MODEL_NUMBER_VALUE, homingOffset, rangeMin, rangeMax };
});

type Status = Extract<StationEvent, { type: "status" }>;
type Arming = Extract<StationEvent, { type: "arming" }>;

/** How an Enable ended: the Worker's error (null: enabled), how long the answer took on the station's clock, and
 * the robot's status after it. */
interface Outcome {
  readonly error: string | null;
  readonly seconds: number;
  readonly robot: string;
}

/** How an Enable of a real arm's line ended: also what the arming report held against it before the operator
 * confirmed, whether the port is closed, which servos have their torque on, and where the servos stand. */
interface RealOutcome extends Outcome {
  /** How the request ended where it had no error, and the kinds of packet the guard had let through by its end. */
  readonly outcome: EnableRealResult["outcome"] | null;
  readonly passed: readonly string[];
  readonly blockers: readonly ArmingBlocker[];
  readonly isPortClosed: boolean;
  readonly withTorque: readonly MotorName[];
  readonly positions: Readonly<Record<MotorName, number>>;
}

/** PEAR's words for a joint outside its bounds, as the Worker's error holds them. */
const outside = (joint: string, rad: string, bound: string): string =>
  `ValueError: Joint or gripper target outside commissioned bounds: ${joint}=${rad} rad, bounds=[-${bound}, ${bound}], allowance=0.060000`;

/** What the tests send as a frame: the first and the last bytes of a JPEG. The station never decodes a frame. */
const FRAME = [0xff, 0xd8, 0xff, 0xd9];

/** The stations that were enabled: a test's end disables them, so that no loop runs on after it. */
const open: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const disable of open.splice(0)) await disable().catch(() => undefined);
});

/** Enables a station on a real arm's line whose servos stand at SIM_START_POSITIONS but for `moved`, with the
 * operator's confirmation, and tells how it ended. `later` is where joints are moved by hand after the Worker has
 * told what it read and before the operator confirms. */
async function enableRealAt(
  moved: Partial<Record<MotorName, number>>,
  later: Partial<Record<MotorName, number>> = {},
): Promise<RealOutcome> {
  const clock = new EventClock();
  const arm = new SimArm("normal");
  for (const [motor, steps] of Object.entries(moved)) arm.setPosition(motor as MotorName, steps);
  const port = simulatedConfiguredPort(ENABLE_SETTINGS, GRIPPER_SETTINGS, arm);
  const events: StationEvent[] = [];
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  const host = new StationHost(
    (message: FromStation) => {
      if (message.kind === "event") events.push(message.event);
      if (message.kind !== "reply") return;
      const entry = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.isOk) entry?.resolve(message.result);
      else entry?.reject(new Error(`${message.error.name}: ${message.error.message}`));
    },
    { getPorts: async () => [port] },
    clock,
    { clock, armingLimitMs: 4000 },
  );
  const ask = <Result>(request: StationRequest): Promise<Result> =>
    new Promise<Result>((resolve, reject) => {
      nextId += 1;
      waiting.set(nextId, { resolve: resolve as (value: unknown) => void, reject });
      host.handle({ id: nextId, request });
    });
  open.push(() => ask({ type: "disable" }));
  host.handle({ kind: "camera", isRunning: true });
  host.handle({ kind: "frame", jpeg: Uint8Array.from(FRAME).buffer });

  const ended: { result: EnableRealResult | null } = { result: null };
  const began = clock.monotonic();
  const enabling = ask<EnableRealResult>({
    type: "enableReal",
    source: "granted",
    usb: { vendorId: 0x1a86, productId: 0x55d3 },
    expected: PRINT,
    calibrationFile: null,
    isHidden: false,
  }).then(
    (result) => {
      ended.result = result;

      return null;
    },
    (error: Error) => error.message,
  );
  const arming = (): Arming | undefined => events.find((event): event is Arming => event.type === "arming");
  for (let waits = 0; arming() === undefined; waits++) {
    if (waits > 20_000) throw new Error("Never happened: the event arming");
    await clock.sleep(0.02);
  }
  const blockers = (arming() as Arming).blockers;
  for (const [motor, steps] of Object.entries(later)) arm.setPosition(motor as MotorName, steps);
  if (blockers.length === 0) await ask({ type: "arm", requestId: (arming() as Arming).requestId, isConfirmed: true });
  const error = await enabling;
  const seconds = clock.monotonic() - began;
  await ask({ type: "visibility", isHidden: false }); // tells the status at once
  const told = events.filter((event): event is Status => event.type === "status");
  const status: StationStatus | undefined = told[told.length - 1]?.status;

  return {
    error,
    seconds,
    robot: status?.robot ?? "(no status)",
    outcome: ended.result?.outcome ?? null,
    passed: Object.keys(ended.result?.report.guard.passed ?? {}).sort(),
    blockers,
    isPortClosed: port.readable === null && port.writable === null,
    withTorque: MOTORS.filter((motor) => arm.servo(motor).torqueEnabled),
    positions: Object.fromEntries(MOTORS.map((motor) => [motor, arm.servo(motor).position])) as Record<MotorName, number>,
  };
}

/** Enables the station on its simulated arm whose servos stand at SIM_START_POSITIONS but for `moved`, and tells
 * how it ended. The timing self-check keeps a clock that does not wait; PEAR's robot runs in real time. */
async function enableSimAt(moved: Partial<Record<MotorName, number>>): Promise<Outcome> {
  const events: StationEvent[] = [];
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  const host = new StationHost(
    (message: FromStation) => {
      if (message.kind === "event") events.push(message.event);
      if (message.kind !== "reply") return;
      const entry = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.isOk) entry?.resolve(message.result);
      else entry?.reject(new Error(`${message.error.name}: ${message.error.message}`));
    },
    null,
    new EventClock(),
  );
  const ask = <Result>(request: StationRequest): Promise<Result> =>
    new Promise<Result>((resolve, reject) => {
      nextId += 1;
      waiting.set(nextId, { resolve: resolve as (value: unknown) => void, reject });
      host.handle({ id: nextId, request });
    });
  open.push(() => ask({ type: "disable" }));
  const robot = (): string => {
    const told = events.filter((event): event is Status => event.type === "status");

    return told[told.length - 1]?.status.robot ?? "(no status)";
  };

  const began = performance.now();
  const error = await ask<EnableResult>({ type: "enable", positions: { ...SIM_START_POSITIONS, ...moved }, isHidden: false }).then(
    () => null,
    (failure: Error) => failure.message,
  );
  const seconds = (performance.now() - began) / 1000;
  for (let waits = 0; error === null && robot() !== "READY" && waits < 250; waits++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await ask({ type: "visibility", isHidden: false }); // tells the status at once

  return { error, seconds, robot: robot() };
}

/** Where a joint is accepted and where it is refused, steps: with the servos as ACCEPTED places them the station
 * is enabled; as REFUSED places them the Worker answers with PEAR's words, which give the reading in radians. */
const ACCEPTED: ReadonlyArray<Partial<Record<MotorName, number>>> = [
  {},
  { shoulder_pan: 838 }, // the last step within the bound and its tolerance: 80 steps inside the range's lower end
  { shoulder_pan: 3212 },
  { shoulder_lift: 887 }, // 30 steps inside its range's ends
  { shoulder_lift: 3254 },
  { elbow_flex: 838 }, // two steps inside its range's ends
  { elbow_flex: 3067 },
  { wrist_roll: 303 }, // its range is the whole turn, its bound 150 degrees
  { wrist_roll: 3792 },
  { wrist_flex: 838 }, // both ends of its range lie within the tolerance
  { wrist_flex: 3138 },
  { wrist_flex: 3139 }, // one step beyond the range: the servo's own limit pulls it to the end when it gets torque
  { gripper: 2037 }, // the gripper is a share of its range and is never outside
  { gripper: 2036 },
  { gripper: 3499 },
];
const REFUSED: ReadonlyArray<readonly [Partial<Record<MotorName, number>>, string]> = [
  [{ shoulder_pan: 758 }, outside("shoulder_pan", "-1.944028", "1.762300")], // the lower end of its range
  [{ shoulder_pan: 757 }, outside("shoulder_pan", "-1.944028", "1.762300")], // one step beyond: read at the end
  [{ shoulder_pan: 759 }, outside("shoulder_pan", "-1.942494", "1.762300")], // one step inside
  [{ shoulder_pan: 837 }, outside("shoulder_pan", "-1.822814", "1.762300")], // the first step beyond the tolerance
  [{ shoulder_pan: 3213 }, outside("shoulder_pan", "1.822814", "1.762300")], // and the first one at the other end
  [{ elbow_flex: 3069 }, outside("elbow_flex", "1.713108", "1.650300")], // the upper end of its range
  [{ elbow_flex: 3070 }, outside("elbow_flex", "1.713108", "1.650300")],
  [{ elbow_flex: 3068 }, outside("elbow_flex", "1.711573", "1.650300")],
  [{ elbow_flex: 837 }, outside("elbow_flex", "-1.711573", "1.650300")],
  [{ shoulder_lift: 886 }, outside("shoulder_lift", "-1.817444", "1.756900")],
  [{ shoulder_lift: 3255 }, outside("shoulder_lift", "1.817444", "1.756900")],
  [{ wrist_roll: 302 }, outside("wrist_roll", "-2.678217", "2.618000")],
  [{ wrist_roll: 3793 }, outside("wrist_roll", "2.678217", "2.618000")],
];

/** The first and the last step PEAR accepts of each joint of REFUSED, with the simulated arm's calibration: one
 * step inside them is the last one of ACCEPTED, one step outside the first one of REFUSED. */
const ACCEPTED_STEPS: Partial<Record<MotorName, readonly [number, number]>> = {
  shoulder_pan: [838, 3212],
  shoulder_lift: [887, 3254],
  elbow_flex: [838, 3067],
  wrist_roll: [303, 3792],
};

describe("an Enable of a real arm's line with a joint at the end of its range", () => {
  it("enables where every joint stands within PEAR's bounds and their tolerance", async () => {
    for (const moved of ACCEPTED) {
      const outcome = await enableRealAt(moved);
      expect({ moved, error: outcome.error, robot: outcome.robot }).toEqual({ moved, error: null, robot: "READY" });
      expect(outcome.blockers).toEqual([]);
      expect(outcome.withTorque).toEqual(MOTORS);
    }
  });

  it("is blocked before the operator is asked when a joint stands further out: the report names the joint and the steps PEAR accepts, nothing is written and the port is closed", async () => {
    for (const [moved] of REFUSED) {
      const [motor, position] = Object.entries(moved)[0] as [MotorName, number];
      const [firstAccepted, lastAccepted] = ACCEPTED_STEPS[motor] as readonly [number, number];
      const outcome = await enableRealAt(moved);
      expect({ moved, blockers: outcome.blockers }).toEqual({
        moved,
        blockers: [{ code: "bounds", joints: [{ id: SIM_CALIBRATION[motor].id, name: motor, position, firstAccepted, lastAccepted }] }],
      });
      expect({ error: outcome.error, outcome: outcome.outcome, robot: outcome.robot }).toEqual({ error: null, outcome: "blocked", robot: "OFF" });
      // the guard let reads through and nothing else: no servo was written to, so none had torque and none moved
      expect(outcome.passed).toEqual(["PING", "READ", "SYNC READ"]);
      expect(outcome.withTorque).toEqual([]);
      expect(outcome.positions[motor]).toBe(position);
      expect(outcome.isPortClosed).toBe(true);
    }
  });

  it("names every joint that stands outside, in the servos' order", async () => {
    const outcome = await enableRealAt({ elbow_flex: 837, shoulder_pan: 3213 });
    expect(outcome.blockers).toEqual([
      {
        code: "bounds",
        joints: [
          { id: 1, name: "shoulder_pan", position: 3213, firstAccepted: 838, lastAccepted: 3212 },
          { id: 3, name: "elbow_flex", position: 837, firstAccepted: 838, lastAccepted: 3067 },
        ],
      },
    ]);
    expect(outcome.outcome).toBe("blocked");
  });

  it("still answers with PEAR's error, soon, when a joint leaves the bounds after the report was told, and leaves the arm limp and its port closed", async () => {
    for (const [later, words] of REFUSED) {
      const outcome = await enableRealAt({}, later);
      expect({ later, error: outcome.error }).toEqual({ later, error: words });
      // the self-check's three seconds and two control periods on the station's clock: the request does not hang
      expect(outcome.seconds).toBeLessThan(4);
      expect(outcome.robot).toBe("OFF");
      expect(outcome.isPortClosed).toBe(true);
      expect(outcome.withTorque).toEqual([]);
      // The arming report had nothing against the pose it read: the operator was asked and confirmed, PEAR wrote
      // its settings and switched the torque on, and its first feedback was refused.
      expect(outcome.blockers).toEqual([]);
    }
  });

  it("has had the torque on before PEAR refuses: a servo moved beyond its own limit after the report was pulled to it", async () => {
    const outcome = await enableRealAt({}, { shoulder_pan: 757 });
    expect(outcome.error).toBe(outside("shoulder_pan", "-1.944028", "1.762300"));
    expect(outcome.positions.shoulder_pan).toBe(SIM_CALIBRATION.shoulder_pan.rangeMin);
    expect(outcome.withTorque).toEqual([]);
  });
});

/** How a request with a pose ended: the Worker's error (null: it answered), what it answered, what the arming
 * report held against enabling (null: no report was told), the robot's status after it, and how often the Worker
 * asked for the granted ports. */
interface PosedOutcome<Result> {
  readonly error: string | null;
  readonly result: Result | null;
  readonly blockers: readonly ArmingBlocker[] | null;
  readonly robot: string;
  readonly portsAsked: number;
}

/** Sends the request "preflight" or "enableReal" with `source` and `pose` to a station that is given no port of
 * its own: with a simulated source the Worker makes the port itself, whose servos stand where the pose says. An
 * arming report without a reason against enabling is confirmed, as the operator does. */
async function askPosed<Result>(
  type: "preflight" | "enableReal",
  source: PortSource,
  pose: Readonly<Record<string, number>> | null,
): Promise<PosedOutcome<Result>> {
  const clock = new EventClock();
  const events: StationEvent[] = [];
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let portsAsked = 0;
  const host = new StationHost(
    (message: FromStation) => {
      if (message.kind === "event") events.push(message.event);
      if (message.kind !== "reply") return;
      const entry = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.isOk) entry?.resolve(message.result);
      else entry?.reject(new Error(`${message.error.name}: ${message.error.message}`));
    },
    {
      getPorts: async () => {
        portsAsked += 1;

        return [];
      },
    },
    clock,
    { clock, armingLimitMs: 4000 },
  );
  const ask = <Answer>(request: StationRequest): Promise<Answer> =>
    new Promise<Answer>((resolve, reject) => {
      nextId += 1;
      waiting.set(nextId, { resolve: resolve as (value: unknown) => void, reject });
      host.handle({ id: nextId, request });
    });
  open.push(() => ask({ type: "disable" }));
  host.handle({ kind: "camera", isRunning: true });
  host.handle({ kind: "frame", jpeg: Uint8Array.from(FRAME).buffer });

  const common = {
    source,
    usb: { vendorId: 0x1a86, productId: 0x55d3 },
    expected: PRINT,
    isHidden: false,
    ...(pose === null ? {} : { pose }),
  };
  const ended: { isOver: boolean; error: string | null; result: Result | null } = { isOver: false, error: null, result: null };
  const asking = ask<Result>(type === "preflight" ? { type, ...common } : { type, ...common, calibrationFile: null }).then(
    (result) => {
      ended.result = result;
      ended.isOver = true;
    },
    (error: Error) => {
      ended.error = error.message;
      ended.isOver = true;
    },
  );
  const arming = (): Arming | undefined => events.find((event): event is Arming => event.type === "arming");
  for (let waits = 0; arming() === undefined && !ended.isOver; waits++) {
    if (waits > 20_000) throw new Error("Never happened: the event arming or the request's end");
    await clock.sleep(0.02);
  }
  const told = arming();
  if (told !== undefined && told.blockers.length === 0) await ask({ type: "arm", requestId: told.requestId, isConfirmed: true });
  await asking;
  await ask({ type: "visibility", isHidden: false }); // tells the status at once
  const statuses = events.filter((event): event is Status => event.type === "status");

  return {
    error: ended.error,
    result: ended.result,
    blockers: told?.blockers ?? null,
    robot: statuses[statuses.length - 1]?.status.robot ?? "(no status)",
    portsAsked,
  };
}

describe("a request for a simulated port of the Worker's own with a pose", () => {
  it("is blocked where the pose puts a joint outside PEAR's bounds: the report names that joint where the pose says, and nothing is written", async () => {
    const outcome = await askPosed<EnableRealResult>("enableReal", "simulated-configured", { shoulder_pan: 758 });
    expect(outcome.blockers).toEqual([
      { code: "bounds", joints: [{ id: 1, name: "shoulder_pan", position: 758, firstAccepted: 838, lastAccepted: 3212 }] },
    ]);
    expect({ error: outcome.error, outcome: outcome.result?.outcome, robot: outcome.robot }).toEqual({ error: null, outcome: "blocked", robot: "OFF" });
    expect(Object.keys(outcome.result?.report.guard.passed ?? {}).sort()).toEqual(["PING", "READ", "SYNC READ"]);
    expect(outcome.portsAsked).toBe(0);
  });

  it("names every joint the pose puts outside, in the servos' order", async () => {
    const outcome = await askPosed<EnableRealResult>("enableReal", "simulated-configured", { elbow_flex: 837, shoulder_pan: 3213 });
    expect(outcome.blockers).toEqual([
      {
        code: "bounds",
        joints: [
          { id: 1, name: "shoulder_pan", position: 3213, firstAccepted: 838, lastAccepted: 3212 },
          { id: 3, name: "elbow_flex", position: 837, firstAccepted: 838, lastAccepted: 3067 },
        ],
      },
    ]);
    expect(outcome.result?.outcome).toBe("blocked");
  });

  it("is enabled where the pose puts a joint at the first step PEAR accepts, and without a pose", async () => {
    for (const pose of [{ shoulder_pan: 838 }, null]) {
      const outcome = await askPosed<EnableRealResult>("enableReal", "simulated-configured", pose);
      expect({ pose, blockers: outcome.blockers }).toEqual({ pose, blockers: [] });
      expect({ error: outcome.error, outcome: outcome.result?.outcome, robot: outcome.robot }).toEqual({ error: null, outcome: "enabled", robot: "READY" });
    }
  });

  it("is read by a preflight where the pose says, on both simulated ports, and at the start pose for the rest", async () => {
    for (const source of ["simulated", "simulated-configured"] as const) {
      const outcome = await askPosed<PreflightReport>("preflight", source, { shoulder_pan: 758, gripper: 2100 });
      expect({ source, error: outcome.error, stop: outcome.result?.stop }).toEqual({ source, error: null, stop: null });
      expect(Object.fromEntries((outcome.result?.servos ?? []).map(({ name, position }) => [name, position]))).toEqual({
        ...SIM_START_POSITIONS,
        shoulder_pan: 758,
        gripper: 2100,
      });
    }
  });

  it("is refused with the source granted, before the Worker asks for a port: nothing of a pose reaches a real arm", async () => {
    for (const type of ["preflight", "enableReal"] as const) {
      const outcome = await askPosed<unknown>(type, "granted", { shoulder_pan: 758 });
      expect({ type, ...outcome }).toEqual({
        type,
        error: "RuntimeError: A pose is taken only with a simulated port: this request is for the granted port",
        result: null,
        blockers: null,
        robot: "OFF",
        portsAsked: 0,
      });
    }
    // without a pose the same request is taken, and the Worker asks for the granted ports
    const plain = await askPosed<PreflightReport>("preflight", "granted", null);
    expect({ error: plain.error, stop: plain.result?.stop, portsAsked: plain.portsAsked }).toEqual({ error: null, stop: "no-port", portsAsked: 1 });
  });

  it("is refused where the pose names what is no motor, or steps that are no whole number from 0 to 4095", async () => {
    const refused: Array<[Readonly<Record<string, number>>, string]> = [
      [{ shoulder: 758 }, 'RuntimeError: The pose names "shoulder", which is no motor of the arm: ' + MOTORS.join(", ")],
      [{ shoulder_pan: 758.5 }, "RuntimeError: The pose puts shoulder_pan at 758.5, which is no whole number of steps from 0 to 4095"],
      [{ shoulder_pan: -1 }, "RuntimeError: The pose puts shoulder_pan at -1, which is no whole number of steps from 0 to 4095"],
      [{ shoulder_pan: 4096 }, "RuntimeError: The pose puts shoulder_pan at 4096, which is no whole number of steps from 0 to 4095"],
      [{ elbow_flex: Number.NaN }, "RuntimeError: The pose puts elbow_flex at NaN, which is no whole number of steps from 0 to 4095"],
    ];
    for (const [pose, error] of refused) {
      for (const type of ["preflight", "enableReal"] as const) {
        const outcome = await askPosed<unknown>(type, "simulated-configured", pose);
        expect({ type, pose, error: outcome.error, blockers: outcome.blockers, robot: outcome.robot }).toEqual({ type, pose, error, blockers: null, robot: "OFF" });
      }
    }
  });
});

describe.skipIf(!REAL_TIME)("an Enable of the simulated arm with a joint at the end of its range, in real time", () => {
  it("enables where every joint stands within PEAR's bounds and their tolerance", async () => {
    for (const moved of ACCEPTED) {
      const outcome = await enableSimAt(moved);
      expect({ moved, error: outcome.error, robot: outcome.robot }).toEqual({ moved, error: null, robot: "READY" });
      await open.pop()?.();
    }
  }, 60_000);

  it("answers with PEAR's error at once when a joint stands further out, and the station stays off", async () => {
    for (const [moved, words] of REFUSED) {
      const outcome = await enableSimAt(moved);
      // a servo beyond its own limit is on its way to it in real time when PEAR reads it: its reading is the one
      // step or the other, and only the joint's name is sure
      const isBeyond = Object.entries(moved).some(([motor, steps]) => {
        const { rangeMin, rangeMax } = SIM_CALIBRATION[motor as MotorName];

        return steps < rangeMin || steps > rangeMax;
      });
      if (isBeyond) expect(outcome.error).toContain(words.slice(0, words.indexOf("=") + 1));
      else expect({ moved, error: outcome.error }).toEqual({ moved, error: words });
      expect(outcome.robot).toBe("OFF");
      expect(outcome.seconds).toBeLessThan(2); // after a self-check that does not wait here; three seconds more on the page
    }
  }, 60_000);
});
