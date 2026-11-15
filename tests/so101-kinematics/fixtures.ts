// Loads the fixtures tools/fixtures/kinematics_fixtures.py wrote from PEAR's own Python.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIRECTORY = new URL("../fixtures/so101-kinematics/", import.meta.url);

export const URDF_PATH = fileURLToPath(new URL("../../assets/pear/so101/so101_new_calib.urdf", import.meta.url));
export const ASSET_README_PATH = fileURLToPath(new URL("../../assets/pear/so101/README.md", import.meta.url));

function load<Content>(name: string): Content {
  return JSON.parse(readFileSync(fileURLToPath(new URL(name, DIRECTORY)), "utf8")) as Content;
}

export interface Meta {
  versions: Record<string, string>;
  urdf: { name: string; sha256: string };
  config: { robot: unknown };
  layout: {
    joints: string[];
    motors: string[];
    arms: string[];
    vector_length: number;
    gripper_index: number;
    joint_unit: string;
    gripper_unit: string;
    texts: Record<string, unknown>;
  };
  kinematics: {
    arm_quantities: string[];
    decimals: Record<string, number>;
    end_effector_frame: string;
    shoulder_frame: string;
    convergence_rad: number;
    ik_weight: number;
    reach_bisections: number;
    plane_axis: number[];
  };
  limits: { epsilon: number; feedback_tolerance: number; lower_bounds: number[]; upper_bounds: number[] };
}

export interface PoseCase {
  joints: number[];
  /** x, y, z in cm, pitch and roll in rad, unrounded by PEAR and stored to nine significant digits. */
  pose: number[];
  /** x, y, z, pitch, roll as the model reads them, then the gripper's width. */
  quantities: number[];
  /** The first three rows of the fingertip's frame, for the first cases. */
  frame?: number[][];
}

export interface StepCase {
  kind: "far" | "near" | "half_turn";
  joints: number[];
  rotation: number[];
  position: number[];
  next: number[];
}

export interface JointTargetCase {
  kind: string;
  joints: number[];
  /** x, y, z in cm, pitch and roll in rad. */
  delta: number[];
  goal?: number[];
  error?: { type: string; message: string };
  /** Of an unreachable pose: the fraction PEAR's bisection found and the error of its first solve. */
  fraction?: number;
  first_error?: string;
  /**
   * Present where solves of PEAR's behind this answer took every step they may (`ik_iterations`) without
   * converging: how many did. Such a solve returns whatever its last step was.
   */
  unsettled?: number;
  /**
   * Present where PEAR's own answer changed when the start joints were moved by 1e-9 rad: what it answered then.
   * The solver's loop does not settle on such a case, and its answer follows the last digits of its input.
   */
  perturbed?: { reachable: boolean; fraction: number | null };
}

export interface Texts {
  truncated_cases: { value: number; decimals: number; text: string }[];
  message_cases: { delta: number[]; fraction: number; text: string }[];
  bounds_cases: { vector: (number | string)[]; tolerance: number; message: string | null }[];
}

export const meta = (): Meta => load<Meta>("meta.json");
export const poseCases = (): PoseCase[] => load<{ cases: PoseCase[] }>("poses.json").cases;
export const stepCases = (): StepCase[] => load<{ cases: StepCase[] }>("steps.json").cases;
export const jointTargetCases = (): JointTargetCase[] => load<{ cases: JointTargetCase[] }>("joint_targets.json").cases;
export const texts = (): Texts => load<Texts>("texts.json");
