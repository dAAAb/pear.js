// Ports <pear>/pear/deploy/station/control/robots/so101/motion/actions.py.

import type {
  ArmQuantities as ArmQuantitiesType,
  GripperQuantity as GripperQuantityType,
  ModelState as ModelStateType,
  SingleArmDelta as SingleArmDeltaType,
} from "../../protocol/types";
import {
  defineStrictModel,
  GripperQuantity as BaseGripperQuantity,
  JointPositions as BaseJointPositions,
  type JointPositions as JointPositionsType,
} from "../../station/motion/actions";
import { LAYOUT } from "../layout";

export type ArmQuantities = ArmQuantitiesType;
export const ArmQuantities = defineStrictModel<ArmQuantities>({
  name: "ArmQuantities",
  fields: [
    { name: "x", schema: { kind: "float" } },
    { name: "y", schema: { kind: "float" } },
    { name: "z", schema: { kind: "float" } },
    { name: "pitch", schema: { kind: "float" } },
    { name: "roll", schema: { kind: "float" } },
  ],
});

export type GripperQuantity = GripperQuantityType;
export const GripperQuantity = BaseGripperQuantity;

export type ModelState = ModelStateType;
export const ModelState = defineStrictModel<ModelState>({
  name: "ModelState",
  fields: [
    { name: "arm", schema: { kind: "model", model: ArmQuantities } },
    { name: "gripper", schema: { kind: "model", model: GripperQuantity } },
  ],
});

export type SingleArmDelta = SingleArmDeltaType;
export const SingleArmDelta = defineStrictModel<SingleArmDelta>({
  name: "SingleArmDelta",
  tag: "single_arm_delta",
  fields: [
    {
      name: "type",
      schema: { kind: "literal", values: ["single_arm_delta"] },
      defaultValue: "single_arm_delta",
    },
    { name: "arm", schema: { kind: "model", model: ArmQuantities } },
    { name: "gripper", schema: { kind: "model", model: GripperQuantity } },
  ],
});

export interface GripperAction {
  type: "gripper";
  command: "open" | "close";
}

export const GripperAction = defineStrictModel<GripperAction>({
  name: "GripperAction",
  tag: "gripper",
  fields: [
    {
      name: "type",
      schema: { kind: "literal", values: ["gripper"] },
      defaultValue: "gripper",
    },
    { name: "command", schema: { kind: "literal", values: ["open", "close"] } },
  ],
});

export type JointPositions = JointPositionsType;
export const JointPositions = BaseJointPositions.forLayout(LAYOUT);

/**
 * Returns what the model reads of the measured `jointPositions`, as PEAR's kinematics return it: its `quantities`
 * end with `ModelState.model_validate`, which refuses a quantity that is no finite number (a reading that is none).
 * The kinematics of src/so101/kinematics give the quantities as they come, so the callers of this layer validate.
 */
export function modelStateOf(
  kinematics: { quantities(jointPositions: ArrayLike<number>): unknown },
  jointPositions: ArrayLike<number>,
): ModelState {
  return ModelState.modelValidate(kinematics.quantities(jointPositions));
}
