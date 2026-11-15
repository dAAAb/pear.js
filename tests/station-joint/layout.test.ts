import { describe, expect, test } from "vitest";

import { JointLayout as StationJointLayout } from "../../src/station/joint/layout";
import { JointLayout, LAYOUT } from "../../src/so101/layout";
import { jsonText, layoutOf, loadFixture, meta, outcomeOf, type Outcome } from "./fixtures";

interface LayoutCase {
  layout: string;
  method: string;
  vector?: number[];
  arm_values?: Record<string, number[]> | number[];
  arm?: string;
  index?: number;
  labels?: Record<string, unknown>;
  values?: number[];
  gripper_value?: number;
  outcome: Outcome;
}

const cases = loadFixture<{ cases: LayoutCase[] }>("layout.json").cases;

/** Returns what pear.js's layout answers the call a case records. */
function answered(layout: JointLayout, item: LayoutCase): Outcome {
  return outcomeOf(() => {
    switch (item.method) {
      case "split":
        return layout.split(item.vector!);
      case "join":
        return layout.join(item.arm_values as Record<string, number[]>);
      case "arm_axis_labels":
        return layout.armAxisLabels(item.arm!, item.index!);
      case "axis_name":
        return JointLayout.axisName(item.labels!);
      case "axis_unit":
        return layout.axisUnit(item.index!);
      case "vector":
        return layout.vector(item.values!);
      case "arm_vector":
        return layout.armVector(item.values!);
      case "joint_values":
        return JointLayout.jointValues(item.arm_values as number[]);
      case "gripper_value":
        return JointLayout.gripperValue(item.arm_values as number[]);
      case "with_gripper":
        return JointLayout.withGripper(item.arm_values as number[], item.gripper_value!);
      default:
        throw new Error(`The fixture names a method this test does not know: ${item.method}`);
    }
  });
}

describe("the joint layout", () => {
  test("the SO-101's layout is PEAR's, and the joint layer's class is the one class", () => {
    const record = meta.layouts["so101"]!;

    expect(StationJointLayout).toBe(JointLayout);
    expect([...LAYOUT.arms]).toEqual(record.arms);
    expect([...LAYOUT.coordinates]).toEqual(record.coordinates);
    expect(JSON.parse(jsonText(LAYOUT.texts))).toEqual(record.texts);
    expect(JointLayout.ARM_LABEL).toBe(meta.constants.joint_layout.arm_label);
    expect(JointLayout.COORDINATE_LABEL).toBe(meta.constants.joint_layout.coordinate_label);
    expect(JointLayout.JOINT_UNIT).toBe(meta.constants.joint_layout.joint_unit);
    expect(JointLayout.GRIPPER_UNIT).toBe(meta.constants.joint_layout.gripper_unit);
  });

  for (const [name, record] of Object.entries(meta.layouts)) {
    test(`the counts and the grippers' places of the layout ${name} are PEAR's`, () => {
      const layout = layoutOf(name);

      expect(layout.coordinateCount).toBe(record.coordinate_count);
      expect(layout.jointCount).toBe(record.joint_count);
      expect(layout.vectorLength).toBe(record.vector_length);
      expect(layout.gripperIndices).toEqual(record.gripper_indices);
    });

    const ofLayout = cases.filter((item) => item.layout === name);
    const methods = [...new Set(ofLayout.map((item) => item.method))];
    for (const method of methods) {
      const ofMethod = ofLayout.filter((item) => item.method === method);
      test(`${method} of the layout ${name} answers ${ofMethod.length} calls as PEAR's`, () => {
        const layout = layoutOf(name);
        const differing = ofMethod.flatMap((item) => {
          const ours = answered(layout, item);
          // the order of an answer's keys is PEAR's too: the arms of a split, the labels of a coordinate
          const same = jsonText(ours) === jsonText(item.outcome);
          try {
            expect(ours).toEqual(item.outcome);
          } catch {
            return [{ item, ours }];
          }
          return same ? [] : [{ item, ours }];
        });

        expect(differing).toEqual([]);
      });
    }
  }

  test("the fixture holds refusals and both layouts", () => {
    expect(cases.some((item) => "error" in item.outcome)).toBe(true);
    expect(new Set(cases.map((item) => item.layout))).toEqual(new Set(["so101", "two_arm"]));
    expect(cases.length).toBeGreaterThan(150);
  });
});
