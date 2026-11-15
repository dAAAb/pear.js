// Ports one step of the inverse kinematics lerobot's RobotKinematics runs (lerobot/model/kinematics.py,
// `inverse_kinematics`), which PEAR's SO101Kinematics iterates: placo's KinematicsSolver with the floating base
// masked, one frame task whose position and orientation are soft with a weight each, and the joint limits.
//
// placo is not ported as a library; this is the program it builds for that one task, as measured on placo 0.9.15
// (tests/fixtures/so101-kinematics/steps.json holds placo's own steps):
//
//   minimize    wp |Jp dq - ep|^2 + wo |Jo dq - eo|^2 + 1e-8 |dq|^2
//   subject to  lower - q <= dq <= upper - q
//
// with Jp and Jo the tip's Jacobian in the base frame's directions, ep the target's position minus the tip's, and
// eo the rotation vector of target * tip^-1 (pinocchio's log3). The step is taken whole: there is no line search.

import type { ChainKinematics, ChainState } from "./chain";
import { dot, multiply, rotationVector, subtract, transpose, type Matrix3, type Vector3 } from "./linalg";
import { solveBoxQp } from "./qp";

/** placo's `Problem.regularization`: what its program adds to the diagonal of its matrix. */
export const REGULARIZATION = 1e-8;

/** A pose of the tip's frame in the base frame. */
export interface FramePose {
  readonly rotation: Readonly<Matrix3>;
  /** m */
  readonly position: Readonly<Vector3>;
}

export interface StepSettings {
  /** The weight of the position's error, m, in the step. */
  readonly positionWeight: number;
  /** The weight of the orientation's error, rad, in the step. */
  readonly orientationWeight: number;
  /** The joints' position limits, rad. */
  readonly lowerBounds: readonly number[];
  readonly upperBounds: readonly number[];
}

/**
 * Returns the joints after one solver step from `joints` toward `target`. `state` is the chain's pose at `joints`.
 * A joint that starts outside its limits is brought inside them by the step.
 */
export function frameTaskStep(
  chain: ChainKinematics,
  state: ChainState,
  joints: readonly number[],
  target: FramePose,
  settings: StepSettings,
): number[] {
  const { linear, angular } = chain.jacobian(state);
  const positionError = subtract(target.position as Vector3, state.position);
  const orientationError = rotationVector(multiply(target.rotation, transpose(state.rotation)));
  const { positionWeight, orientationWeight } = settings;
  const size = chain.jointCount;

  const hessian: number[][] = [];
  const gradient: number[] = [];
  for (let row = 0; row < size; row++) {
    const hessianRow: number[] = [];
    for (let column = 0; column < size; column++) {
      hessianRow.push(
        positionWeight * dot(linear[row]!, linear[column]!) +
          orientationWeight * dot(angular[row]!, angular[column]!) +
          (row === column ? REGULARIZATION : 0),
      );
    }
    hessian.push(hessianRow);
    gradient.push(
      positionWeight * dot(linear[row]!, positionError) + orientationWeight * dot(angular[row]!, orientationError),
    );
  }

  const change = solveBoxQp(
    hessian,
    gradient,
    joints.slice(0, size).map((joint, index) => settings.lowerBounds[index]! - joint),
    joints.slice(0, size).map((joint, index) => settings.upperBounds[index]! - joint),
  );
  return change.map((value, index) => joints[index]! + value);
}
