import { describe, expect, test } from "vitest";

import { SO101_DEFAULT_CONFIG } from "../../src/so101/config";
import { ChainKinematics, SO101_CHAIN } from "../../src/so101/kinematics/chain";
import { SO101Kinematics } from "../../src/so101/kinematics/kinematics";
import { poseCases } from "./fixtures";

const cases = poseCases();
const kinematics = new SO101Kinematics(SO101_DEFAULT_CONFIG);

// PEAR's values are stored to nine significant digits: a stored value is within 5e-9 of PEAR's, relative to its size
const STORED = 1e-8;
const near = (ours: number, stored: number): boolean => Math.abs(ours - stored) <= STORED * Math.max(1, Math.abs(stored));

describe("forward kinematics", () => {
  test(`the fingertip's frame equals placo's on ${cases.filter((row) => row.frame).length} joint vectors`, () => {
    const chain = new ChainKinematics(SO101_CHAIN);
    let worst = 0;

    for (const { joints, frame } of cases) {
      if (frame === undefined) {
        continue;
      }
      const state = chain.state(joints);
      const ours = [0, 1, 2].map((row) => [...state.rotation.slice(3 * row, 3 * row + 3), state.position[row]!]);
      ours.forEach((row, rowIndex) =>
        row.forEach((value, columnIndex) => {
          worst = Math.max(worst, Math.abs(value - frame[rowIndex]![columnIndex]!));
        }),
      );
    }

    expect(worst).toBeLessThan(STORED);
  });

  test(`pose equals PEAR's on ${cases.length} joint vectors inside the default limits`, () => {
    expect(cases.length).toBeGreaterThanOrEqual(2000);
    const worst = [0, 0, 0, 0, 0];

    const differing = cases.filter(({ joints, pose }) => {
      const ours = kinematics.pose(joints);
      ours.forEach((value, index) => {
        worst[index] = Math.max(worst[index]!, Math.abs(value - pose[index]!));
      });
      return !ours.every((value, index) => near(value, pose[index]!));
    });

    expect(differing).toEqual([]);
    // the measured distribution, for docs/progress/kinematics.md
    console.info(`pose: largest difference from PEAR's stored x, y, z (cm), pitch, roll (rad): ${worst.map((value) => value.toExponential(1)).join(", ")}`);
  });

  test(`quantities equal PEAR's rounded state on ${cases.length} joint vectors`, () => {
    const differing = cases.flatMap(({ joints, quantities }) => {
      const state = kinematics.quantities(joints);
      const ours = [state.arm.x, state.arm.y, state.arm.z, state.arm.pitch, state.arm.roll, state.gripper.width];
      // Object.is: a rounded zero must be +0, as PEAR's is
      return ours.every((value, index) => Object.is(value, quantities[index])) ? [] : [{ joints, quantities, ours }];
    });

    expect(differing).toEqual([]);
  });

  test("the gripper's width rounds a decimal tie to even and stays within the closed and the open width", () => {
    const widthAt = (opening: number): number | undefined =>
      cases.find(({ joints }) => joints[5] === opening && joints[0] === 0.2)?.quantities[5];

    // the cases PEAR answered at openings 0.375 and 0.875, where the width is exactly 2.25 and 5.25 cm
    expect(widthAt(0.375)).toBe(2.2);
    expect(widthAt(0.875)).toBe(5.2);
    expect(kinematics.quantities([0.2, -0.35, 0.55, 0.4, 0.3, 0.375]).gripper.width).toBe(2.2);
    expect(kinematics.quantities([0.2, -0.35, 0.55, 0.4, 0.3, 0.875]).gripper.width).toBe(5.2);
    expect(kinematics.quantities([0.2, -0.35, 0.55, 0.4, 0.3, 1.03]).gripper.width).toBe(widthAt(1.03));
    expect(kinematics.quantities([0.2, -0.35, 0.55, 0.4, 0.3, -0.02]).gripper.width).toBe(widthAt(-0.02));
  });

  test("the gripper's width follows the station's own fingertip distances", () => {
    const measured = new SO101Kinematics({
      ...SO101_DEFAULT_CONFIG,
      geometry: { ...SO101_DEFAULT_CONFIG.geometry!, gripper_width_cm: [0.4, 13.3] },
    });

    expect(measured.quantities([0, 0, 0, 0, 0, 0]).gripper.width).toBe(0.4);
    expect(measured.quantities([0, 0, 0, 0, 0, 1]).gripper.width).toBe(13.3);
  });
});
