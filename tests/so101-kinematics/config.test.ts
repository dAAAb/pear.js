import { describe, expect, test } from "vitest";

import { MISSING, SO101_DEFAULT_CONFIG } from "../../src/so101/config";
import { BaseKinematics } from "../../src/so101/kinematics/base";
import { SO101Kinematics } from "../../src/so101/kinematics/kinematics";
import { JointLimits } from "../../src/so101/kinematics/limits";
import { ARM, GRIPPER_INDEX, JOINTS, JointLayout, LAYOUT, MOTORS, VECTOR_LENGTH } from "../../src/so101/layout";
import { meta } from "./fixtures";

const fixture = meta();

describe("the SO-101's settings and layout", () => {
  test("the default settings are the robot node of PEAR's config.yaml", () => {
    // the readonly constant as plain data, the way PEAR's file was stored
    expect(JSON.parse(JSON.stringify(SO101_DEFAULT_CONFIG))).toEqual(fixture.config.robot);
    expect(SO101_DEFAULT_CONFIG.hardware?.port).toBe(MISSING);
    expect(Object.isFrozen(SO101_DEFAULT_CONFIG.limits.lower_bounds)).toBe(true);
  });

  test("the joint vector is PEAR's: its names, its order, its units and the texts of its refusals", () => {
    expect([...JOINTS]).toEqual(fixture.layout.joints);
    expect([...MOTORS]).toEqual(fixture.layout.motors);
    expect([...LAYOUT.arms]).toEqual(fixture.layout.arms);
    expect(ARM).toBe(fixture.layout.arms[0]);
    expect(VECTOR_LENGTH).toBe(fixture.layout.vector_length);
    expect(GRIPPER_INDEX).toBe(fixture.layout.gripper_index);
    expect(JointLayout.JOINT_UNIT).toBe(fixture.layout.joint_unit);
    expect(JointLayout.GRIPPER_UNIT).toBe(fixture.layout.gripper_unit);
    expect(JSON.parse(JSON.stringify(LAYOUT.texts))).toEqual(fixture.layout.texts);
  });

  test("the constants of the kinematics and of the limits are PEAR's", () => {
    expect([...SO101Kinematics.ARM_QUANTITIES]).toEqual(fixture.kinematics.arm_quantities);
    expect({ ...SO101Kinematics.DECIMALS }).toEqual(fixture.kinematics.decimals);
    expect(SO101Kinematics.END_EFFECTOR_FRAME).toBe(fixture.kinematics.end_effector_frame);
    expect(SO101Kinematics.SHOULDER_FRAME).toBe(fixture.kinematics.shoulder_frame);
    expect(SO101Kinematics.CONVERGENCE_RAD).toBe(fixture.kinematics.convergence_rad);
    expect(SO101Kinematics.IK_WEIGHT).toBe(fixture.kinematics.ik_weight);
    expect(BaseKinematics.REACH_BISECTIONS).toBe(fixture.kinematics.reach_bisections);
    expect(JointLimits.EPSILON).toBe(fixture.limits.epsilon);

    const limits = JointLimits.fromConfig(SO101_DEFAULT_CONFIG);
    expect(limits.lowerBounds).toEqual(fixture.limits.lower_bounds);
    expect(limits.upperBounds).toEqual(fixture.limits.upper_bounds);
    expect(limits.feedbackTolerance).toBe(fixture.limits.feedback_tolerance);
  });
});
