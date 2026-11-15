// Replays a scenario of the fixtures on pear.js's control loop: the same rig (a stand-in driver and the stand-in
// clock), the same script of operations, and after every control period and every other operation the same record
// (the driver's calls, the loop's whole snapshot and what else it keeps of its operation). It mirrors the Scenario of
// tools/fixtures/loop_fixtures.py, which ran the script on PEAR's own loop.

import type { SO101RobotConfig } from "../../src/so101/config";
import { SO101ControlLoop } from "../../src/so101/joint/control_loop";
import { SO101GripperOperation } from "../../src/so101/joint/grippers";
import { ControlInterface } from "../../src/ruckig/index";
import { ActionGuard } from "../../src/station/joint/action_guard";
import { ArmState } from "../../src/station/joint/arm_state";
import type { ControlConfig } from "../../src/station/joint/config";
import {
  Braking,
  JointControlLoop,
  type GripperOperationClass,
  type RecoveryPolicyClass,
} from "../../src/station/joint/control_loop";
import { ValueError, type Cancellation } from "../../src/station/joint/errors";
import type { JointLayout } from "../../src/station/joint/layout";
import type { MotionCaps } from "../../src/station/joint/limits";
import { JointMoveOperation, SequenceOperation } from "../../src/station/joint/operations";
import { MeasuredHoldRecovery, RecoveryRequest, ReleaseRecovery } from "../../src/station/joint/recovery";
import { SnapshotCheck, type ObservationReference } from "../../src/station/joint/snapshot_checks";
import type { StabilityWindow } from "../../src/station/joint/stability";
import { JointMove } from "../../src/station/joint/trajectory";
import type { ControlSnapshot, RecoveryPhase } from "../../src/station/schemas";
import { Comparison, plain, undelta } from "./compare";
import { outcomeOf, outcomeOfAsync, stationOf, type Outcome } from "./fixtures";
import {
  makeError,
  makeResponse,
  MemoryDriver,
  Probe,
  replaced,
  StandInClock,
  StandInJointDriver,
  StandInSO101Driver,
  type ProbedMethod,
  type Tamper,
} from "./standins";

/** The most control periods an operation may take, as in PEAR's tests. */
const MOST_TICKS = 2000;

/** The vectors of a trajectory's input a script may set, by the name PEAR's input gives each. */
const INPUT_PROPERTIES: Record<string, "currentPosition" | "currentVelocity" | "currentAcceleration"> = {
  current_position: "currentPosition",
  current_velocity: "currentVelocity",
  current_acceleration: "currentAcceleration",
};

/** One operation of a script, with what PEAR did of it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ScriptOperation = Record<string, any>;

export interface ScenarioRecord {
  name: string;
  source: string;
  rig: {
    kind: "so101" | "two_arm" | "memory";
    station: string;
    start: number[] | null;
    recovery: string;
    braking: string;
    checks_velocity_rms: boolean;
    before: ScriptOperation[];
    sleeps_while_enabling: boolean;
  };
  init: { out: Outcome; rec: { io: unknown[]; s?: unknown } };
  ops: ScriptOperation[];
  end?: Record<string, unknown>;
}

/** One thing a scenario gives, in the order it gives them: what a call returned, a record, a value, the end. */
export interface ScenarioEvent {
  kind: "out" | "rec" | "value" | "end";
  label: string;
  value: unknown;
}

/** A gripper operation the generic loops of the tests never start (the NoGripper of PEAR's tests). */
class NoGripper {}

/** Returns the class of the generic loop with the recovery policy, the braking and the window a rig names. */
export function loopClassOf(recovery: string, braking: string, checksVelocityRms: boolean): typeof JointControlLoop {
  const policies: Record<string, RecoveryPolicyClass> = { MeasuredHoldRecovery, ReleaseRecovery };

  return class StandInControlLoop extends JointControlLoop<ArmState> {
    static override readonly GRIPPER_OPERATION_CLASS = NoGripper as unknown as GripperOperationClass;
    static override readonly RECOVERY_POLICY_CLASS = policies[recovery]!;
    static override readonly BRAKING = braking as Braking;
    static override readonly CHECKS_VELOCITY_RMS = checksVelocityRms;
  } as unknown as typeof JointControlLoop;
}

/** What a record reads of the loop besides its snapshot. */
interface LoopInternals {
  isSettled: boolean;
  operationDeadline: number | null;
  settleSince: number | null;
  faultHoldError: string | null;
  blockedGripperOpenings: Record<string, number> | null;
  recoveryRequest: RecoveryRequest | null;
}

/** Python's `max(abs(value) for value in values)`: the first of the largest. */
function largestMagnitude(values: readonly number[]): number {
  return values.map(Math.abs).reduce((largest, value) => (value > largest ? value : largest));
}

function gripperProgress(operation: SO101GripperOperation): Record<string, unknown> {
  return {
    outcome: operation.outcome,
    samples: operation.sampleCount,
    finished_at: operation.finishedAt,
    report: operation.openingReport,
    blocked: operation.blockedGripperOpenings,
    window: operation.restWindow.samples.length,
  };
}

/**
 * Returns what a record holds of a loop's state: its whole snapshot, and what else the loop keeps of its operation
 * (the `state` of the Scenario of tools/fixtures/loop_fixtures.py).
 */
export function stateOf(loop: JointControlLoop<ArmState>): unknown {
  const internals = loop as unknown as LoopInternals;
  const trajectoryInput = loop.trajectory.input;
  const operation = loop.operation;
  const interfaceName = Object.entries(ControlInterface).find(
    ([, value]) => value === trajectoryInput.controlInterface,
  )?.[0];
  let progress: Record<string, unknown> | null = null;
  if (operation instanceof JointMoveOperation) {
    progress = { elapsed: operation.elapsedS };
  } else if (operation instanceof SequenceOperation) {
    progress = { index: operation.index, phase: operation.rowPhase, start: operation.startTime };
  } else if (operation instanceof SO101GripperOperation) {
    progress = gripperProgress(operation);
  }

  return plain({
    snapshot: loop.snapshot(),
    loop: {
      operation: operation === null ? null : operation.constructor.name,
      settled: internals.isSettled,
      deadline: internals.operationDeadline,
      settle_since: internals.settleSince,
      duration: loop.trajectory.durationS,
      target: trajectoryInput.targetPosition,
      interface: interfaceName,
      speed: largestMagnitude(trajectoryInput.currentVelocity),
      acceleration: largestMagnitude(trajectoryInput.currentAcceleration),
      hold_error: internals.faultHoldError,
      blocked: internals.blockedGripperOpenings,
      cancellation: loop.operationCancellation !== null,
      // until when the recovery that is under way may take, which a release moves: null without one
      recovery_deadline: internals.recoveryRequest === null ? null : internals.recoveryRequest.deadline,
      progress,
    },
  });
}

/** Returns what PEAR gave of a scenario, in order: every record as the whole state it stands for. */
export function expectedEvents(scenario: ScenarioRecord): ScenarioEvent[] {
  const events: ScenarioEvent[] = [];
  let state: unknown = null;

  const record = (entry: { io: unknown[]; log?: unknown; s?: unknown }, label: string): void => {
    // (the keys in the order PEAR's record has them: the driver's calls, what the loop logged, the state)
    const value: Record<string, unknown> = { io: entry.io };
    if ("log" in entry) {
      value["log"] = entry.log;
    }
    if ("s" in entry) {
      state = undelta(state, entry.s);
      value["s"] = state;
    }
    events.push({ kind: "rec", label, value });
  };
  const walk = (operation: ScriptOperation, label: string, records: boolean): void => {
    if (operation.op === "tick" || operation.op === "tick_at") {
      (operation.rec as { io: unknown[] }[]).forEach((entry, index) => record(entry, `${label} period ${index + 1}`));
    } else if (operation.op === "wait") {
      (operation.sleeps as { hooks: ScriptOperation[]; rec: { io: unknown[] } }[]).forEach((sleep, index) => {
        sleep.hooks.forEach((hook) => walk(hook, `${label} sleep ${index + 1} hook ${hook.op}`, false));
        record(sleep.rec, `${label} sleep ${index + 1}`);
      });
      events.push({ kind: "out", label, value: operation.out });
      record(operation.rec[0], label);
    } else {
      if ("out" in operation) {
        events.push({ kind: "out", label, value: operation.out });
      }
      for (const name of ["phase", "dispatched", "deadline"]) {
        if (name in operation) {
          events.push({ kind: "value", label: `${label} ${name}`, value: operation[name] });
        }
      }
      if (records) {
        record(operation.rec[0], label);
      }
    }
  };

  // what PEAR's loop class names: its recovery policy, what its STOP brakes with, what its recovery window bounds
  const { recovery, braking, checks_velocity_rms } = scenario.rig;
  events.push({ kind: "value", label: "the loop's class", value: { recovery, braking, checks_velocity_rms } });
  events.push({ kind: "out", label: "the rig", value: scenario.init.out });
  record(scenario.init.rec, "the rig");
  scenario.ops.forEach((operation, index) => walk(operation, `operation ${index + 1} (${operation.op})`, true));
  if (scenario.end !== undefined) {
    events.push({ kind: "end", label: "the end", value: scenario.end });
  }

  return events;
}

/** Runs one scenario's script on pear.js's control loop and keeps what it gives. */
export class Player {
  readonly events: ScenarioEvent[] = [];
  readonly clock = new StandInClock();
  loop: JointControlLoop<ArmState> | null = null;
  driver!: MemoryDriver | StandInJointDriver | StandInSO101Driver;
  probe!: Probe;
  layout!: JointLayout;
  controlConfig!: ControlConfig;

  private readonly cancellations: Record<string, { aborted: boolean }> = {};
  private readonly observations: Record<string, ObservationReference> = {};
  private readonly guards: Record<string, ActionGuard> = {};
  private gripperOperation: SO101GripperOperation | null = null;
  private tickCount = 0;
  /** What the loop logged since the last record: each line's level and message. */
  private readonly logged: [string, string][] = [];

  constructor(readonly scenario: ScenarioRecord) {}

  /** Plays the whole scenario and returns what it gave, in order. */
  async play(): Promise<ScenarioEvent[]> {
    await this.makeRig();
    for (const [index, operation] of this.scenario.ops.entries()) {
      await this.execute(operation, `operation ${index + 1} (${operation.op as string})`, true);
    }
    if (this.loop !== null) {
      this.events.push({ kind: "end", label: "the end", value: plain(this.end()) });
    }

    return this.events;
  }

  private async makeRig(): Promise<void> {
    const rig = this.scenario.rig;
    const station = stationOf(rig.station);
    this.layout = station.layout;
    this.controlConfig = station.controlConfig;
    if (rig.kind === "so101") {
      this.driver = new StandInSO101Driver(station.robotConfig as SO101RobotConfig, this.clock);
    } else if (rig.kind === "two_arm") {
      this.driver = new StandInJointDriver(this.layout, this.clock);
    } else {
      this.driver = new MemoryDriver(this.layout, rig.start as number[], this.clock);
    }
    this.probe = new Probe(this.driver, this.layout, this.clock, rig.kind, this.controlConfig.controlPeriodS);
    for (const operation of rig.before) {
      await this.execute(operation, "before the loop", false);
    }

    const loopClass =
      rig.kind === "so101"
        ? (SO101ControlLoop as unknown as typeof JointControlLoop)
        : loopClassOf(rig.recovery, rig.braking, rig.checks_velocity_rms);
    // (of the SO-101 it is pear.js's own class that names them; the generic loops of the tests are made of the names)
    this.events.push({
      kind: "value",
      label: "the loop's class",
      value: {
        recovery: loopClass.RECOVERY_POLICY_CLASS.name,
        braking: loopClass.BRAKING,
        checks_velocity_rms: loopClass.CHECKS_VELOCITY_RMS,
      },
    });
    this.clock.advancesOnSleep = rig.sleeps_while_enabling;
    const made = await outcomeOfAsync(() =>
      loopClass.create(this.driver, this.controlConfig, station.robotConfig, {
        clock: this.clock,
        log: (level, message) => {
          this.logged.push([level, message]);
        },
      }),
    );
    this.clock.advancesOnSleep = true;
    if ("error" in made) {
      this.events.push({ kind: "out", label: "the rig", value: made });
      this.record("the rig");
      return;
    }

    this.loop = made.ok as JointControlLoop<ArmState>;
    this.events.push({ kind: "out", label: "the rig", value: { ok: null } });
    this.record("the rig");
  }

  // -- what a record holds

  private state(): unknown {
    return stateOf(this.loop as JointControlLoop<ArmState>);
  }

  private record(label: string): void {
    const value: Record<string, unknown> = { io: plain(this.probe.take()) };
    const log = this.logged.splice(0);
    if (log.length > 0) {
      value["log"] = log;
    }
    if (this.loop !== null) {
      value["s"] = this.state();
    }
    this.events.push({ kind: "rec", label, value });
  }

  private end(): Record<string, unknown> {
    const loop = this.loop as JointControlLoop<ArmState>;
    const trajectoryInput = loop.trajectory.input;

    return {
      current_position: trajectoryInput.currentPosition,
      current_velocity: trajectoryInput.currentVelocity,
      current_acceleration: trajectoryInput.currentAcceleration,
      target_position: trajectoryInput.targetPosition,
      target_velocity: trajectoryInput.targetVelocity,
      target_acceleration: trajectoryInput.targetAcceleration,
      max_velocity: trajectoryInput.maxVelocity,
      max_acceleration: trajectoryInput.maxAcceleration,
      max_jerk: trajectoryInput.maxJerk,
      control_interface: Object.entries(ControlInterface).find(
        ([, value]) => value === trajectoryInput.controlInterface,
      )?.[0],
      generation: loop.generation,
      status: loop.status,
      ticks: this.tickCount,
    };
  }

  // -- the interpreter of an operation

  private async tick(periodS: number | null, label: string): Promise<void> {
    const loop = this.loop as JointControlLoop<ArmState>;
    this.clock.now += periodS === null ? loop.controlConfig.controlPeriodS : periodS;
    await loop.step();
    this.tickCount += 1;
    this.record(label);
  }

  private async execute(operation: ScriptOperation, label: string, records: boolean): Promise<void> {
    const loop = this.loop as JointControlLoop<ArmState>;
    const op = operation.op as string;
    const out = (value: unknown): void => {
      this.events.push({ kind: "out", label, value: plain(value) });
    };

    if (op === "tick") {
      for (let index = 0; index < operation.n; index++) {
        await this.tick(operation.period_s as number | null, `${label} period ${index + 1}`);
      }
      return;
    }
    if (op === "until") {
      // steps until the loop's status is one of some
      const statuses = operation.statuses as string[];
      for (let index = 0; !statuses.includes(loop.status); index++) {
        if (index >= MOST_TICKS) {
          throw new Error(`Still ${loop.status} after ${MOST_TICKS} steps`);
        }
        await this.tick(null, `${label} period ${index + 1}`);
      }
      return;
    }
    if (op === "tick_at") {
      for (const [index, now] of (operation.times as number[]).entries()) {
        this.clock.now = now;
        await loop.step();
        this.tickCount += 1;
        this.record(`${label} period ${index + 1}`);
      }
      return;
    }
    if (op === "wait") {
      await this.executeWait(operation, label);
      return;
    }

    if (op === "step") {
      await loop.step();
    } else if (op === "jog") {
      // the held targets with some coordinates moved
      const targets = Object.fromEntries(Object.entries(loop.targets).map(([arm, target]) => [arm, [...target]]));
      for (const arm of operation.arm === null ? Object.keys(targets) : [operation.arm as string]) {
        const target = targets[arm]!;
        for (const index of operation.index === null ? target.keys() : [operation.index as number]) {
          target[index]! += operation.delta as number;
        }
      }
      const options = "speed_scale" in operation ? { speedScale: operation.speed_scale as number } : {};
      const guard = this.guards[operation.guard as string];
      if (guard !== undefined) {
        out(outcomeOf(() => guard.submit((moved: typeof targets) => loop.move(moved, options), targets)));
      } else {
        out(outcomeOf(() => loop.move(targets, options)));
      }
    } else if (op === "shift") {
      // the stand-in holds an arm (every arm without a name) elsewhere by a step
      for (const arm of operation.arm === null ? this.layout.arms : [operation.arm as string]) {
        const position = [...this.probe.position(arm)];
        position[operation.index as number]! += operation.delta as number;
        this.probe.setPosition(arm, position);
      }
    } else if (op === "submit") {
      // a method of the loop through an action's guard, which adopts what it starts
      const guard = this.guards[operation.guard as string] as ActionGuard;
      if (operation.method === "begin_grippers") {
        out(
          outcomeOf(() => guard.submit((request: unknown) => loop.beginGrippers(request), operation.request).constructor.name),
        );
      } else {
        out(await outcomeOfAsync(() => guard.submit(() => loop.stop())));
      }
      this.events.push({ kind: "value", label: `${label} dispatched`, value: guard.hasDispatched });
    } else if (op === "clock") {
      if (operation.to === "recovery_deadline") {
        // onto the deadline of the recovery that is under way
        const request = (loop as unknown as LoopInternals).recoveryRequest as RecoveryRequest;
        this.clock.now = request.deadline;
      } else if ("set" in operation) {
        this.clock.now = operation.set as number;
      } else {
        this.clock.now += operation.add as number;
      }
    } else if (op === "set") {
      this.setAttribute(operation);
    } else if (op === "position") {
      this.probe.setPosition(operation.arm as string, operation.values as number[]);
    } else if (op === "tamper") {
      const tamper = { ...structuredClone(operation.spec), seen: 0, count: 0 } as Tamper;
      this.probe.tampers[operation.method as ProbedMethod].push(tamper);
    } else if (op === "untamper") {
      for (const method of Object.keys(this.probe.tampers) as ProbedMethod[]) {
        if (operation.method == null || operation.method === method) {
          this.probe.tampers[method].length = 0;
        }
      }
    } else if (op === "event") {
      this.cancellations[operation.name as string] = { aborted: false };
    } else if (op === "cancel") {
      this.cancellations[operation.name as string]!.aborted = true;
    } else if (op === "attach") {
      // as PEAR's tests attach a cancellation: straight into the loop
      loop.operationCancellation = this.cancellations[operation.name as string] as Cancellation;
    } else if (op === "observe") {
      const snapshot = loop.snapshot();
      let positions = operation.positions as number[] | string;
      if (positions === "state") {
        positions = SnapshotCheck.stateVector(snapshot);
      } else if (positions === "target") {
        positions = SnapshotCheck.targetVector(snapshot);
      }
      this.observations[operation.name as string] = {
        joint_positions: positions as number[],
        control_snapshot: snapshot,
      };
    } else if (op === "guard") {
      const cancellation = this.cancellations[operation.cancellation as string] ?? null;
      this.guards[operation.name as string] = new ActionGuard(loop, cancellation);
    } else if (op === "guard_check") {
      out(outcomeOf(() => this.guards[operation.name as string]!.check()));
    } else if (op === "break_stop") {
      // no stop trajectory can be planned any more
      loop.trajectory.computeTrajectory = () => {
        throw new ValueError(operation.message as string);
      };
    } else if (op === "mutate_snapshot") {
      // a reader changes the snapshot it was given
      const snapshot = loop.snapshot();
      (snapshot.fault_details as Record<string, unknown>)["reason"] = "changed by a reader";
      snapshot.settling["samples"] = -1;
    } else if (op === "set_state") {
      // a reading handed straight to the loop, past its own check
      const state = loop.states[operation.arm as string] as ArmState;
      const position = [...state.position];
      position[operation.index as number] = operation.value as number;
      loop.states = { ...loop.states, [operation.arm as string]: replaced(state, { position }) };
    } else if (op === "policy_step") {
      // one step of the recovery policy on a request of its own, past the loop's checks
      const window = { reset: () => undefined } as unknown as StabilityWindow;
      const request = new RecoveryRequest(window, this.clock.now + (operation.timeout_s as number), {
        clock: this.clock,
        // (the operator paused it before the step)
        cancellation: operation.cancelled ? { aborted: true } : null,
      });
      if ("from_phase" in operation) {
        // the request is that far already
        request.phase = operation.from_phase as RecoveryPhase;
      }
      out(
        await outcomeOfAsync(() =>
          loop.recoveryPolicy.step(loop as unknown as JointControlLoop, request, loop.snapshot(), operation.is_stable as boolean),
        ),
      );
      this.events.push({ kind: "value", label: `${label} phase`, value: request.phase });
      this.events.push({ kind: "value", label: `${label} deadline`, value: request.deadline });
    } else if (op === "raise") {
      throw makeError(operation as { type: string; message?: string });
    } else if (op === "set_exit") {
      // the control thread's exit event, set while the loop is open: its thread is gone
      (loop as unknown as { exitEvent: { set(): void } }).exitEvent.set();
    } else if (op === "set_input") {
      // the planned state, changed behind the loop's back
      const property = INPUT_PROPERTIES[operation.name as string];
      if (property === undefined) {
        throw new Error(`No input ${operation.name as string}`);
      }
      loop.trajectory.input[property] = operation.values as number[];
    } else if (op === "call") {
      out(await this.executeCall(operation.method as string, operation.args as Record<string, unknown>));
    } else {
      throw new Error(`No operation ${op}`);
    }

    if (records) {
      this.record(label);
    }
  }

  /** Sets an attribute of the stand-in driver, or of the SO-101's stand-in arm. */
  private setAttribute(operation: ScriptOperation): void {
    const names: Record<string, string> = {
      is_stale: "isStale",
      is_following: "isFollowing",
      velocity: "velocity",
      is_oscillating: "isOscillating",
      failed_arm: "failedArm",
      failure: "failure",
      blocked_gripper_opening: "blockedGripperOpening",
      response: "response",
    };
    const target = (
      operation.target === "arm" ? (this.driver as StandInSO101Driver).hardware : this.driver
    ) as unknown as Record<string, unknown>;
    let value = operation.value as unknown;
    if (operation.name === "failure") {
      value = value === null ? null : makeError(value as { type: string; message?: string });
    } else if (operation.name === "response") {
      value = makeResponse(value as { kind: string } | null);
    }
    const name = names[operation.name as string];
    if (name === undefined || !(name in target)) {
      throw new Error(`The stand-in has no ${operation.name as string}`);
    }
    target[name] = value;
  }

  private async executeCall(method: string, callArguments: Record<string, unknown>): Promise<Outcome> {
    const loop = this.loop as JointControlLoop<ArmState>;
    const observation = this.observations[callArguments["observation"] as string] ?? null;

    if (method === "move") {
      const options: { speedScale?: number; caps?: MotionCaps | null } = {};
      if ("speed_scale" in callArguments) {
        options.speedScale = callArguments["speed_scale"] as number;
      }
      if ("caps" in callArguments) {
        options.caps = callArguments["caps"] as MotionCaps | null;
      }
      return outcomeOf(() => loop.move(callArguments["targets"] as Record<string, number[]>, options));
    }
    if (method === "dispatch_joint_move") {
      const spec = callArguments["move"] as Record<string, unknown> | null;
      if (spec === null) {
        // what is no checked move
        return outcomeOf(() => loop.dispatchJointMove({ goal: [] } as unknown as JointMove, observation));
      }
      const built = outcomeOf(() =>
        JointMove.build(spec["start"] as number[], spec["goal"] as number[], loop.limits, loop.layout, {
          speedScale: (spec["speed_scale"] as number | undefined) ?? 1.0,
          caps: (spec["caps"] as MotionCaps | undefined) ?? null,
        }),
      );
      if ("error" in built) {
        return { build: built } as unknown as Outcome;
      }
      return outcomeOf(() => loop.dispatchJointMove(built.ok as JointMove, observation));
    }
    if (method === "start_sequence") {
      return outcomeOf(() =>
        loop.startSequence(callArguments["positions"] as number[][], {
          rateHz: callArguments["rate_hz"] as number,
          observation,
        }),
      );
    }
    if (method === "begin_grippers") {
      return outcomeOf(() => {
        const operation = loop.beginGrippers(callArguments["request"]) as SO101GripperOperation;
        this.gripperOperation = operation;
        return {
          class: operation.constructor.name,
          initial_opening: operation.initialOpening,
          opens: operation.opensByArm,
          endpoint: operation.profile.endpoint,
          stops_from_standstill: operation.stopsFromStandstill,
        };
      });
    }
    if (method === "stop") {
      const options = "reason" in callArguments ? { reason: callArguments["reason"] as string } : {};
      return outcomeOfAsync(() => loop.stop(options));
    }
    if (method === "verify_reference") {
      return outcomeOf(() => loop.verifyReference(observation));
    }
    if (method === "stability") {
      return outcomeOf(() =>
        loop.stability({
          arms: callArguments["arms"] as string[] | undefined,
          durationS: callArguments["duration_s"] as number | undefined,
          targets: callArguments["targets"] as Record<string, number[]> | undefined,
          positionTolerance: callArguments["position_tolerance"] as number | undefined,
        }),
      );
    }
    if (method === "report") {
      const operation = this.gripperOperation as SO101GripperOperation;
      return outcomeOf(() => ({ ...operation.report(), progress: gripperProgress(operation) }));
    }
    if (method === "check_states") {
      const given = callArguments["states"] as Record<string, Record<string, unknown>>;
      const states = Object.fromEntries(
        Object.entries(given).map(([arm, state]) => [
          arm,
          new ArmState(
            state["position"] as number[],
            state["velocity"] as number[],
            this.clock.now - ((state["age_s"] as number | undefined) ?? 0.0),
            (state["sample_id"] as number | undefined) ?? null,
          ),
        ]),
      );
      return outcomeOf(() => loop.checkStates(states));
    }
    if (method === "recover") {
      // (one that is refused at once: a recovery that waits is a "wait")
      return outcomeOfAsync(() => loop.recover(this.recoveryOptions(callArguments)));
    }
    if (method === "transfer_hold") {
      return outcomeOfAsync(() => loop.transferHold(callArguments["targets"] as Record<string, number[]>));
    }
    if (method === "snapshot") {
      return outcomeOf(() => loop.snapshot());
    }
    if (method === "requested_position") {
      return outcomeOf(() => loop.requestedPosition());
    }
    if (method === "close") {
      return outcomeOfAsync(() => loop.close());
    }
    throw new Error(`No call ${method}`);
  }

  private recoveryOptions(callArguments: Record<string, unknown>): { timeoutS?: number; cancellation?: Cancellation } {
    const options: { timeoutS?: number; cancellation?: Cancellation } = {};
    if ("timeout_s" in callArguments) {
      options.timeoutS = callArguments["timeout_s"] as number;
    }
    if ("cancellation" in callArguments) {
      options.cancellation = this.cancellations[callArguments["cancellation"] as string] as Cancellation;
    }

    return options;
  }

  /**
   * Calls a method of the loop that waits: every sleep of the wait advances the clock and steps the loop, with the
   * scenario's hooks run before or after the step.
   */
  private async executeWait(operation: ScriptOperation, label: string): Promise<void> {
    const loop = this.loop as JointControlLoop<ArmState>;
    const method = operation.method as string;
    const callArguments = operation.args as Record<string, unknown>;
    const hooks = operation.hooks as ScriptOperation[];
    const fired = new Set<number>();
    const sendsBefore = this.probe.sendCount;
    let sleeps = 0;

    const runHooks = async (at: string): Promise<void> => {
      for (const [index, hook] of hooks.entries()) {
        if (hook.at !== at || ((hook.once ?? true) && fired.has(index))) {
          continue;
        }
        const when = hook.when as Record<string, unknown>;
        if ("phase" in when) {
          const recovery = loop.snapshot().recovery;
          if (recovery === null || recovery.phase !== when["phase"]) {
            continue;
          }
        }
        if ("sleep" in when && sleeps !== when["sleep"]) {
          continue;
        }
        if ("sent_over" in when && this.probe.sendCount <= sendsBefore + (when["sent_over"] as number)) {
          continue;
        }
        fired.add(index);
        for (const action of hook.do as ScriptOperation[]) {
          await this.execute(structuredClone(action), `${label} sleep ${sleeps} hook ${action.op as string}`, false);
        }
      }
    };

    this.clock.onSleep = async (seconds) => {
      this.clock.now += seconds;
      sleeps += 1;
      if (sleeps > MOST_TICKS) {
        // (every wait of PEAR's record ends; one that would not end here fails instead of stepping for ever)
        throw new Error(`The wait still sleeps after ${MOST_TICKS} control periods`);
      }
      try {
        await runHooks("before");
        await loop.step();
        this.tickCount += 1;
        await runHooks("after");
      } finally {
        this.record(`${label} sleep ${sleeps}`);
      }
    };

    let result: Outcome;
    try {
      if (method === "recover") {
        result = await outcomeOfAsync(() => loop.recover(this.recoveryOptions(callArguments)));
      } else if (method === "wait_for_hold") {
        const accepts =
          callArguments["accepts"] === "reached"
            ? (snapshot: ControlSnapshot) => snapshot.arrival.reached
            : callArguments["accepts"] === "never"
              ? () => false
              : null;
        result = await outcomeOfAsync(() =>
          loop.waitForHold(callArguments["timeout_s"] as number, {
            accepts,
            guard: this.guards[callArguments["guard"] as string] ?? null,
            ...("label" in callArguments ? { label: callArguments["label"] as string } : {}),
          }),
        );
      } else if (method === "shutdown") {
        result = await outcomeOfAsync(() => loop.shutdown());
      } else {
        throw new Error(`No wait ${method}`);
      }
    } finally {
      this.clock.onSleep = null;
    }
    this.events.push({ kind: "out", label, value: plain(result) });
    this.record(label);
  }
}

/** What playing a scenario against PEAR's record gave. */
export interface ScenarioVerdict {
  name: string;
  events: number;
  /** Where pear.js first differs from PEAR, and how; null: nowhere. */
  difference: string | null;
}

/** Plays `scenario` on pear.js's loop and compares what it gives with what PEAR gave. */
export async function playAndCompare(scenario: ScenarioRecord, comparison: Comparison): Promise<ScenarioVerdict> {
  const expected = expectedEvents(scenario);
  const player = new Player(scenario);
  let failure: string | null = null;
  try {
    await player.play();
  } catch (error) {
    failure = `the script stopped: ${(error as Error).name}: ${(error as Error).message}`;
  }
  const actual = player.events;

  for (let index = 0; index < expected.length; index++) {
    const wanted = expected[index] as ScenarioEvent;
    const got = actual[index];
    if (got === undefined) {
      return { name: scenario.name, events: index, difference: `${wanted.label}: nothing given${failure ? ` (${failure})` : ""}` };
    }
    if (got.kind !== wanted.kind) {
      return { name: scenario.name, events: index, difference: `${wanted.label}: a ${got.kind} of ${got.label} (PEAR: a ${wanted.kind})` };
    }
    const difference = comparison.difference(got.value, wanted.value, `${wanted.label} ${wanted.kind}`);
    if (difference !== null) {
      return { name: scenario.name, events: index, difference };
    }
  }
  if (failure !== null || actual.length !== expected.length) {
    const extra = failure ?? `${actual.length - expected.length} more than PEAR gave`;
    return { name: scenario.name, events: expected.length, difference: extra };
  }

  return { name: scenario.name, events: expected.length, difference: null };
}
