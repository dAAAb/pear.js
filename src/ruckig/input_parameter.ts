// Ports include/ruckig/input_parameter.hpp of Ruckig 0.15.3 (https://github.com/pantor/ruckig), as its Python
// module shows it.
// Copyright (c) 2021 Lars Berscheid, MIT licence (see LICENSE in this folder).

import { RuckigError } from "./error";
import { join, streamDouble, toStringDouble } from "./utils";

export const ControlInterface = {
  /** Position-control: Full control over the entire kinematic state (Default) */
  Position: 0,
  /** Velocity-control: Ignores the current position, target position, and velocity limits */
  Velocity: 1,
} as const;
export type ControlInterface = (typeof ControlInterface)[keyof typeof ControlInterface];

/** The names are the Python module's: the C++'s `None` is `No` there. */
export const Synchronization = {
  /** Always synchronize the DoFs to reach the target at the same time (Default) */
  Time: 0,
  /** Synchronize only when necessary (e.g. for non-zero target velocity or acceleration) */
  TimeIfNecessary: 1,
  /**
   * Phase synchronize the DoFs when this is possible, else fallback to "Time" strategy. Phase synchronization will
   * result a straight-line trajectory
   */
  Phase: 2,
  /** Calculate every DoF independently */
  No: 3,
} as const;
export type Synchronization = (typeof Synchronization)[keyof typeof Synchronization];

export const DurationDiscretization = {
  /** Every trajectory synchronization duration is allowed (Default) */
  Continuous: 0,
  /** The trajectory synchronization duration must be a multiple of the control cycle */
  Discrete: 1,
} as const;
export type DurationDiscretization = (typeof DurationDiscretization)[keyof typeof DurationDiscretization];

function v_at_a_zero(v0: number, a0: number, j: number): number {
  return v0 + (a0 * a0) / (2 * j);
}

/** Whether two vectors are equal as C++'s std::vector compares them: the same length and equal elements. */
function equalVectors<Element>(first: readonly Element[], second: readonly Element[]): boolean {
  if (first.length !== second.length) {
    return false;
  }
  for (let index = 0; index < first.length; index++) {
    if (!(first[index] === second[index])) {
      return false;
    }
  }
  return true;
}

function equalOptionalVectors<Element>(first: readonly Element[] | undefined, second: readonly Element[] | undefined): boolean {
  if (first === undefined || second === undefined) {
    return first === second;
  }
  return equalVectors(first, second);
}

function equalRows(first: readonly (readonly number[])[], second: readonly (readonly number[])[]): boolean {
  if (first.length !== second.length) {
    return false;
  }
  return first.every((row, index) => equalVectors(row, second[index]));
}

function equalOptionalRows(
  first: readonly (readonly number[])[] | undefined,
  second: readonly (readonly number[])[] | undefined,
): boolean {
  if (first === undefined || second === undefined) {
    return first === second;
  }
  return equalRows(first, second);
}

function copyRows(rows: readonly ArrayLike<number>[] | undefined | null): number[][] | undefined {
  return rows === undefined || rows === null ? undefined : rows.map((row) => Array.from(row));
}

function copyOptional<Element>(vector: ArrayLike<Element> | undefined | null): Element[] | undefined {
  return vector === undefined || vector === null ? undefined : Array.from(vector);
}

/**
 * Input of the Ruckig algorithm
 *
 * As in the Python module, a vector is copied when it is set and when it is read: changing an element of what a
 * property returned does not change the input. What the Python module gives as `None` is `undefined` here.
 */
export class InputParameter {
  readonly degreesOfFreedom: number;

  controlInterface: ControlInterface = ControlInterface.Position;
  synchronization: Synchronization = Synchronization.Time;
  durationDiscretization: DurationDiscretization = DurationDiscretization.Continuous;

  #currentPosition: number[];
  #currentVelocity: number[];
  #currentAcceleration: number[];
  #targetPosition: number[];
  #targetVelocity: number[];
  #targetAcceleration: number[];
  #maxVelocity: number[];
  #maxAcceleration: number[];
  #maxJerk: number[];
  #minVelocity: number[] | undefined = undefined;
  #minAcceleration: number[] | undefined = undefined;
  #intermediatePositions: number[][] = [];
  #perSectionMaxVelocity: number[][] | undefined = undefined;
  #perSectionMaxAcceleration: number[][] | undefined = undefined;
  #perSectionMaxJerk: number[][] | undefined = undefined;
  #perSectionMinVelocity: number[][] | undefined = undefined;
  #perSectionMinAcceleration: number[][] | undefined = undefined;
  #perSectionMaxPosition: number[][] | undefined = undefined;
  #perSectionMinPosition: number[][] | undefined = undefined;
  #maxPosition: number[] | undefined = undefined;
  #minPosition: number[] | undefined = undefined;
  #enabled: boolean[];
  #perDofControlInterface: ControlInterface[] | undefined = undefined;
  #perDofSynchronization: Synchronization[] | undefined = undefined;
  #perSectionMinimumDuration: number[] | undefined = undefined;

  /** Optional minimum trajectory duration */
  minimumDuration: number | undefined = undefined;

  /** Optional duration [µs] after which the trajectory calculation is (softly) interrupted (only in Ruckig Pro) */
  interruptCalculationDuration: number | undefined = undefined;

  constructor(dofs: number) {
    this.degreesOfFreedom = dofs;
    const zeros = (): number[] => new Array<number>(dofs).fill(0.0);
    this.#currentPosition = zeros();
    this.#currentVelocity = zeros();
    this.#currentAcceleration = zeros();
    this.#targetPosition = zeros();
    this.#targetVelocity = zeros();
    this.#targetAcceleration = zeros();
    this.#maxVelocity = zeros();
    this.#maxAcceleration = new Array<number>(dofs).fill(Infinity);
    this.#maxJerk = new Array<number>(dofs).fill(Infinity);
    this.#enabled = new Array<boolean>(dofs).fill(true);
  }

  /** Current state */
  get currentPosition(): number[] {
    return this.#currentPosition.slice();
  }
  set currentPosition(value: ArrayLike<number>) {
    this.#currentPosition = Array.from(value);
  }
  get currentVelocity(): number[] {
    return this.#currentVelocity.slice();
  }
  set currentVelocity(value: ArrayLike<number>) {
    this.#currentVelocity = Array.from(value);
  }
  get currentAcceleration(): number[] {
    return this.#currentAcceleration.slice();
  }
  set currentAcceleration(value: ArrayLike<number>) {
    this.#currentAcceleration = Array.from(value);
  }

  /** Target state */
  get targetPosition(): number[] {
    return this.#targetPosition.slice();
  }
  set targetPosition(value: ArrayLike<number>) {
    this.#targetPosition = Array.from(value);
  }
  get targetVelocity(): number[] {
    return this.#targetVelocity.slice();
  }
  set targetVelocity(value: ArrayLike<number>) {
    this.#targetVelocity = Array.from(value);
  }
  get targetAcceleration(): number[] {
    return this.#targetAcceleration.slice();
  }
  set targetAcceleration(value: ArrayLike<number>) {
    this.#targetAcceleration = Array.from(value);
  }

  /** Kinematic constraints */
  get maxVelocity(): number[] {
    return this.#maxVelocity.slice();
  }
  set maxVelocity(value: ArrayLike<number>) {
    this.#maxVelocity = Array.from(value);
  }
  get maxAcceleration(): number[] {
    return this.#maxAcceleration.slice();
  }
  set maxAcceleration(value: ArrayLike<number>) {
    this.#maxAcceleration = Array.from(value);
  }
  get maxJerk(): number[] {
    return this.#maxJerk.slice();
  }
  set maxJerk(value: ArrayLike<number>) {
    this.#maxJerk = Array.from(value);
  }
  get minVelocity(): number[] | undefined {
    return this.#minVelocity?.slice();
  }
  set minVelocity(value: ArrayLike<number> | undefined | null) {
    this.#minVelocity = copyOptional(value);
  }
  get minAcceleration(): number[] | undefined {
    return this.#minAcceleration?.slice();
  }
  set minAcceleration(value: ArrayLike<number> | undefined | null) {
    this.#minAcceleration = copyOptional(value);
  }

  /** Intermediate waypoints (only in Ruckig Pro) */
  get intermediatePositions(): number[][] {
    return this.#intermediatePositions.map((row) => row.slice());
  }
  set intermediatePositions(value: readonly ArrayLike<number>[]) {
    this.#intermediatePositions = value.map((row) => Array.from(row));
  }

  /** Kinematic constraints for intermediate sections (between waypoints) (only in Ruckig Pro) */
  get perSectionMaxVelocity(): number[][] | undefined {
    return copyRows(this.#perSectionMaxVelocity);
  }
  set perSectionMaxVelocity(value: readonly ArrayLike<number>[] | undefined | null) {
    this.#perSectionMaxVelocity = copyRows(value);
  }
  get perSectionMaxAcceleration(): number[][] | undefined {
    return copyRows(this.#perSectionMaxAcceleration);
  }
  set perSectionMaxAcceleration(value: readonly ArrayLike<number>[] | undefined | null) {
    this.#perSectionMaxAcceleration = copyRows(value);
  }
  get perSectionMaxJerk(): number[][] | undefined {
    return copyRows(this.#perSectionMaxJerk);
  }
  set perSectionMaxJerk(value: readonly ArrayLike<number>[] | undefined | null) {
    this.#perSectionMaxJerk = copyRows(value);
  }
  get perSectionMinVelocity(): number[][] | undefined {
    return copyRows(this.#perSectionMinVelocity);
  }
  set perSectionMinVelocity(value: readonly ArrayLike<number>[] | undefined | null) {
    this.#perSectionMinVelocity = copyRows(value);
  }
  get perSectionMinAcceleration(): number[][] | undefined {
    return copyRows(this.#perSectionMinAcceleration);
  }
  set perSectionMinAcceleration(value: readonly ArrayLike<number>[] | undefined | null) {
    this.#perSectionMinAcceleration = copyRows(value);
  }
  get perSectionMaxPosition(): number[][] | undefined {
    return copyRows(this.#perSectionMaxPosition);
  }
  set perSectionMaxPosition(value: readonly ArrayLike<number>[] | undefined | null) {
    this.#perSectionMaxPosition = copyRows(value);
  }
  get perSectionMinPosition(): number[][] | undefined {
    return copyRows(this.#perSectionMinPosition);
  }
  set perSectionMinPosition(value: readonly ArrayLike<number>[] | undefined | null) {
    this.#perSectionMinPosition = copyRows(value);
  }

  /** Positional constraints (only in Ruckig Pro) */
  get maxPosition(): number[] | undefined {
    return this.#maxPosition?.slice();
  }
  set maxPosition(value: ArrayLike<number> | undefined | null) {
    this.#maxPosition = copyOptional(value);
  }
  get minPosition(): number[] | undefined {
    return this.#minPosition?.slice();
  }
  set minPosition(value: ArrayLike<number> | undefined | null) {
    this.#minPosition = copyOptional(value);
  }

  /** Is the DoF considered for calculation? */
  get enabled(): boolean[] {
    return this.#enabled.slice();
  }
  set enabled(value: ArrayLike<boolean>) {
    this.#enabled = Array.from(value);
  }

  /** Per-DoF control_interface (overwrites global control_interface) */
  get perDofControlInterface(): ControlInterface[] | undefined {
    return this.#perDofControlInterface?.slice();
  }
  set perDofControlInterface(value: ArrayLike<ControlInterface> | undefined | null) {
    this.#perDofControlInterface = copyOptional(value);
  }

  /** Per-DoF synchronization (overwrites global synchronization) */
  get perDofSynchronization(): Synchronization[] | undefined {
    return this.#perDofSynchronization?.slice();
  }
  set perDofSynchronization(value: ArrayLike<Synchronization> | undefined | null) {
    this.#perDofSynchronization = copyOptional(value);
  }

  /** Optional minimum trajectory duration for each intermediate sections (only in Ruckig Pro) */
  get perSectionMinimumDuration(): number[] | undefined {
    return this.#perSectionMinimumDuration?.slice();
  }
  set perSectionMinimumDuration(value: ArrayLike<number> | undefined | null) {
    this.#perSectionMinimumDuration = copyOptional(value);
  }

  /**
   * Raises if a vector has fewer elements than there are degrees of freedom. The C++ does not look, and reads past
   * the end of such a vector; this port refuses the input, with the message the C++ has for a mismatch of the
   * degrees of freedom. A longer vector is accepted as the C++ accepts it: its first elements are used.
   */
  private checkSizes(): void {
    const dofs = this.degreesOfFreedom;
    const vectors: (readonly unknown[] | undefined)[] = [
      this.#currentPosition,
      this.#currentVelocity,
      this.#currentAcceleration,
      this.#targetPosition,
      this.#targetVelocity,
      this.#targetAcceleration,
      this.#maxVelocity,
      this.#maxAcceleration,
      this.#maxJerk,
      this.#minVelocity,
      this.#minAcceleration,
      this.#enabled,
      this.#perDofControlInterface,
      this.#perDofSynchronization,
    ];
    if (vectors.some((vector) => vector !== undefined && vector.length < dofs)) {
      throw new RuckigError("mismatch in degrees of freedom (vector size).");
    }
  }

  /**
   * Validate the input for trajectory calculation: returns true, or raises a `RuckigError` that names the first
   * thing wrong, as the Python module's `validate` does.
   */
  validate(check_current_state_within_limits: boolean = false, check_target_state_within_limits: boolean = true): boolean {
    this.checkSizes();
    const fail = (message: string): never => {
      throw new RuckigError(message);
    };
    const text = toStringDouble;

    for (let dof = 0; dof < this.degreesOfFreedom; ++dof) {
      const jMax = this.#maxJerk[dof];
      if (Number.isNaN(jMax) || jMax < 0.0) {
        fail(`maximum jerk limit ${text(jMax)} of DoF ${dof} should be larger than or equal to zero.`);
      }

      const aMax = this.#maxAcceleration[dof];
      if (Number.isNaN(aMax) || aMax < 0.0) {
        fail(`maximum acceleration limit ${text(aMax)} of DoF ${dof} should be larger than or equal to zero.`);
      }

      const aMin = this.#minAcceleration !== undefined ? this.#minAcceleration[dof] : -this.#maxAcceleration[dof];
      if (Number.isNaN(aMin) || aMin > 0.0) {
        fail(`minimum acceleration limit ${text(aMin)} of DoF ${dof} should be smaller than or equal to zero.`);
      }

      const a0 = this.#currentAcceleration[dof];
      if (Number.isNaN(a0)) {
        fail(`current acceleration ${text(a0)} of DoF ${dof} should be a valid number.`);
      }
      const af = this.#targetAcceleration[dof];
      if (Number.isNaN(af)) {
        fail(`target acceleration ${text(af)} of DoF ${dof} should be a valid number.`);
      }

      if (check_current_state_within_limits) {
        if (a0 > aMax) {
          fail(`current acceleration ${text(a0)} of DoF ${dof} exceeds its maximum acceleration limit ${text(aMax)}.`);
        }
        if (a0 < aMin) {
          fail(`current acceleration ${text(a0)} of DoF ${dof} undercuts its minimum acceleration limit ${text(aMin)}.`);
        }
      }
      if (check_target_state_within_limits) {
        if (af > aMax) {
          fail(`target acceleration ${text(af)} of DoF ${dof} exceeds its maximum acceleration limit ${text(aMax)}.`);
        }
        if (af < aMin) {
          fail(`target acceleration ${text(af)} of DoF ${dof} undercuts its minimum acceleration limit ${text(aMin)}.`);
        }
      }

      const v0 = this.#currentVelocity[dof];
      if (Number.isNaN(v0)) {
        fail(`current velocity ${text(v0)} of DoF ${dof} should be a valid number.`);
      }
      const vf = this.#targetVelocity[dof];
      if (Number.isNaN(vf)) {
        fail(`target velocity ${text(vf)} of DoF ${dof} should be a valid number.`);
      }

      const control_interface_ = this.#perDofControlInterface !== undefined ? this.#perDofControlInterface[dof] : this.controlInterface;
      if (control_interface_ === ControlInterface.Position) {
        const p0 = this.#currentPosition[dof];
        if (Number.isNaN(p0)) {
          fail(`current position ${text(p0)} of DoF ${dof} should be a valid number.`);
        }
        const pf = this.#targetPosition[dof];
        if (Number.isNaN(pf)) {
          fail(`target position ${text(pf)} of DoF ${dof} should be a valid number.`);
        }

        const vMax = this.#maxVelocity[dof];
        if (Number.isNaN(vMax) || vMax < 0.0) {
          fail(`maximum velocity limit ${text(vMax)} of DoF ${dof} should be larger than or equal to zero.`);
        }

        const vMin = this.#minVelocity !== undefined ? this.#minVelocity[dof] : -this.#maxVelocity[dof];
        if (Number.isNaN(vMin) || vMin > 0.0) {
          fail(`minimum velocity limit ${text(vMin)} of DoF ${dof} should be smaller than or equal to zero.`);
        }

        if (check_current_state_within_limits) {
          if (v0 > vMax) {
            fail(`current velocity ${text(v0)} of DoF ${dof} exceeds its maximum velocity limit ${text(vMax)}.`);
          }
          if (v0 < vMin) {
            fail(`current velocity ${text(v0)} of DoF ${dof} undercuts its minimum velocity limit ${text(vMin)}.`);
          }
        }
        if (check_target_state_within_limits) {
          if (vf > vMax) {
            fail(`target velocity ${text(vf)} of DoF ${dof} exceeds its maximum velocity limit ${text(vMax)}.`);
          }
          if (vf < vMin) {
            fail(`target velocity ${text(vf)} of DoF ${dof} undercuts its minimum velocity limit ${text(vMin)}.`);
          }
        }

        if (check_current_state_within_limits) {
          if (a0 > 0 && jMax > 0 && v_at_a_zero(v0, a0, jMax) > vMax) {
            fail(`DoF ${dof} will inevitably reach a velocity ${text(v_at_a_zero(v0, a0, jMax))} from the current kinematic state that will exceed its maximum velocity limit ${text(vMax)}.`);
          }
          if (a0 < 0 && jMax > 0 && v_at_a_zero(v0, a0, -jMax) < vMin) {
            fail(`DoF ${dof} will inevitably reach a velocity ${text(v_at_a_zero(v0, a0, -jMax))} from the current kinematic state that will undercut its minimum velocity limit ${text(vMin)}.`);
          }
        }
        if (check_target_state_within_limits) {
          if (af < 0 && jMax > 0 && v_at_a_zero(vf, af, jMax) > vMax) {
            fail(`DoF ${dof} will inevitably have reached a velocity ${text(v_at_a_zero(vf, af, jMax))} from the target kinematic state that will exceed its maximum velocity limit ${text(vMax)}.`);
          }
          if (af > 0 && jMax > 0 && v_at_a_zero(vf, af, -jMax) < vMin) {
            fail(`DoF ${dof} will inevitably have reached a velocity ${text(v_at_a_zero(vf, af, -jMax))} from the target kinematic state that will undercut its minimum velocity limit ${text(vMin)}.`);
          }
        }
      }
    }

    if (this.#intermediatePositions.length !== 0 && this.controlInterface === ControlInterface.Position) {
      if (this.minimumDuration !== undefined || this.durationDiscretization !== DurationDiscretization.Continuous) {
        fail("Intermediate position can not be used together with a global minimum or discrete duration.");
      }

      if (this.#perDofControlInterface !== undefined || this.#perDofSynchronization !== undefined) {
        fail("Intermediate positions can only be used together with the position control interface and a global synchronization.");
      }

      for (let dof = 0; dof < this.degreesOfFreedom; ++dof) {
        const jMax = this.#maxJerk[dof];
        if (!Number.isFinite(jMax) && !Number.isNaN(jMax)) {
          fail(`infinite jerk limit of DoF ${dof} is currently not supported with intermediate positions.`);
        }
      }
    }

    return true;
  }

  /** The C++'s `operator!=`: whether an update with this input must calculate anew after one with `rhs`. */
  notEqual(rhs: InputParameter): boolean {
    return !(
      equalVectors(this.#currentPosition, rhs.#currentPosition)
      && equalVectors(this.#currentVelocity, rhs.#currentVelocity)
      && equalVectors(this.#currentAcceleration, rhs.#currentAcceleration)
      && equalVectors(this.#targetPosition, rhs.#targetPosition)
      && equalVectors(this.#targetVelocity, rhs.#targetVelocity)
      && equalVectors(this.#targetAcceleration, rhs.#targetAcceleration)
      && equalVectors(this.#maxVelocity, rhs.#maxVelocity)
      && equalVectors(this.#maxAcceleration, rhs.#maxAcceleration)
      && equalVectors(this.#maxJerk, rhs.#maxJerk)
      && equalRows(this.#intermediatePositions, rhs.#intermediatePositions)
      && equalOptionalRows(this.#perSectionMaxVelocity, rhs.#perSectionMaxVelocity)
      && equalOptionalRows(this.#perSectionMaxAcceleration, rhs.#perSectionMaxAcceleration)
      && equalOptionalRows(this.#perSectionMaxJerk, rhs.#perSectionMaxJerk)
      && equalOptionalRows(this.#perSectionMinVelocity, rhs.#perSectionMinVelocity)
      && equalOptionalRows(this.#perSectionMinAcceleration, rhs.#perSectionMinAcceleration)
      && equalOptionalRows(this.#perSectionMaxPosition, rhs.#perSectionMaxPosition)
      && equalOptionalRows(this.#perSectionMinPosition, rhs.#perSectionMinPosition)
      && equalOptionalVectors(this.#maxPosition, rhs.#maxPosition)
      && equalOptionalVectors(this.#minPosition, rhs.#minPosition)
      && equalVectors(this.#enabled, rhs.#enabled)
      && this.minimumDuration === rhs.minimumDuration
      && equalOptionalVectors(this.#perSectionMinimumDuration, rhs.#perSectionMinimumDuration)
      && equalOptionalVectors(this.#minVelocity, rhs.#minVelocity)
      && equalOptionalVectors(this.#minAcceleration, rhs.#minAcceleration)
      && this.controlInterface === rhs.controlInterface
      && this.synchronization === rhs.synchronization
      && this.durationDiscretization === rhs.durationDiscretization
      && equalOptionalVectors(this.#perDofControlInterface, rhs.#perDofControlInterface)
      && equalOptionalVectors(this.#perDofSynchronization, rhs.#perDofSynchronization)
    );
  }

  /** Makes this input a copy of `rhs`: the C++'s assignment. */
  assign(rhs: InputParameter): void {
    this.controlInterface = rhs.controlInterface;
    this.synchronization = rhs.synchronization;
    this.durationDiscretization = rhs.durationDiscretization;
    this.#currentPosition = rhs.#currentPosition.slice();
    this.#currentVelocity = rhs.#currentVelocity.slice();
    this.#currentAcceleration = rhs.#currentAcceleration.slice();
    this.#targetPosition = rhs.#targetPosition.slice();
    this.#targetVelocity = rhs.#targetVelocity.slice();
    this.#targetAcceleration = rhs.#targetAcceleration.slice();
    this.#maxVelocity = rhs.#maxVelocity.slice();
    this.#maxAcceleration = rhs.#maxAcceleration.slice();
    this.#maxJerk = rhs.#maxJerk.slice();
    this.#minVelocity = rhs.#minVelocity?.slice();
    this.#minAcceleration = rhs.#minAcceleration?.slice();
    this.#intermediatePositions = rhs.#intermediatePositions.map((row) => row.slice());
    this.#perSectionMaxVelocity = copyRows(rhs.#perSectionMaxVelocity);
    this.#perSectionMaxAcceleration = copyRows(rhs.#perSectionMaxAcceleration);
    this.#perSectionMaxJerk = copyRows(rhs.#perSectionMaxJerk);
    this.#perSectionMinVelocity = copyRows(rhs.#perSectionMinVelocity);
    this.#perSectionMinAcceleration = copyRows(rhs.#perSectionMinAcceleration);
    this.#perSectionMaxPosition = copyRows(rhs.#perSectionMaxPosition);
    this.#perSectionMinPosition = copyRows(rhs.#perSectionMinPosition);
    this.#maxPosition = rhs.#maxPosition?.slice();
    this.#minPosition = rhs.#minPosition?.slice();
    this.#enabled = rhs.#enabled.slice();
    this.#perDofControlInterface = rhs.#perDofControlInterface?.slice();
    this.#perDofSynchronization = rhs.#perDofSynchronization?.slice();
    this.#perSectionMinimumDuration = rhs.#perSectionMinimumDuration?.slice();
    this.minimumDuration = rhs.minimumDuration;
    this.interruptCalculationDuration = rhs.interruptCalculationDuration;
  }

  /** Removes the first intermediate position, as passing an output to this input does after a change of section. */
  eraseFirstIntermediatePosition(): void {
    this.#intermediatePositions.shift();
  }

  /** The input as the C++ writes it into the message of a failed calculation, and as the Python module's `repr`. */
  toString(): string {
    let ss = "\n";
    if (this.controlInterface === ControlInterface.Velocity) {
      ss += "inp.control_interface = ControlInterface.Velocity\n";
    }
    if (this.synchronization === Synchronization.Phase) {
      ss += "inp.synchronization = Synchronization.Phase\n";
    } else if (this.synchronization === Synchronization.No) {
      ss += "inp.synchronization = Synchronization.No\n";
    }
    if (this.durationDiscretization === DurationDiscretization.Discrete) {
      ss += "inp.duration_discretization = DurationDiscretization.Discrete\n";
    }

    ss += `inp.current_position = [${join(this.#currentPosition, true)}]\n`;
    ss += `inp.current_velocity = [${join(this.#currentVelocity, true)}]\n`;
    ss += `inp.current_acceleration = [${join(this.#currentAcceleration, true)}]\n`;
    ss += `inp.target_position = [${join(this.#targetPosition, true)}]\n`;
    ss += `inp.target_velocity = [${join(this.#targetVelocity, true)}]\n`;
    ss += `inp.target_acceleration = [${join(this.#targetAcceleration, true)}]\n`;
    ss += `inp.max_velocity = [${join(this.#maxVelocity, true)}]\n`;
    ss += `inp.max_acceleration = [${join(this.#maxAcceleration, true)}]\n`;
    ss += `inp.max_jerk = [${join(this.#maxJerk, true)}]\n`;
    if (this.#minVelocity !== undefined) {
      ss += `inp.min_velocity = [${join(this.#minVelocity, true)}]\n`;
    }
    if (this.#minAcceleration !== undefined) {
      ss += `inp.min_acceleration = [${join(this.#minAcceleration, true)}]\n`;
    }
    if (this.minimumDuration !== undefined) {
      ss += `inp.minimum_duration = ${streamDouble(this.minimumDuration)}\n`;
    }

    if (this.#intermediatePositions.length !== 0) {
      ss += "inp.intermediate_positions = [\n";
      for (const p of this.#intermediatePositions) {
        ss += `    [${join(p, true)}],\n`;
      }
      ss += "]\n";
    }
    if (this.#minPosition !== undefined) {
      ss += `inp.min_position = [${join(this.#minPosition, true)}]\n`;
    }
    if (this.#maxPosition !== undefined) {
      ss += `inp.max_position = [${join(this.#maxPosition, true)}]\n`;
    }
    return ss;
  }
}
