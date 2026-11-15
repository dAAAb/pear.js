import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { SO101_CHAIN } from "../../src/so101/kinematics/chain";
import { SO101Kinematics } from "../../src/so101/kinematics/kinematics";
import { JOINTS } from "../../src/so101/layout";
import { ASSET_README_PATH, meta, URDF_PATH } from "./fixtures";

interface UrdfJoint {
  name: string;
  type: string;
  parent: string;
  child: string;
  xyz: number[];
  rpy: number[];
  axis: number[];
}

/** Reads the joints of the description: each `<joint>` element with its origin, its links and its axis. */
function urdfJoints(text: string): UrdfJoint[] {
  const numbers = (value: string): number[] => value.trim().split(/\s+/).map(Number);
  const attribute = (element: string, tag: string, name: string): string => {
    const match = new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`).exec(element);
    if (match === null) {
      throw new Error(`A joint of the description has no ${tag} ${name}`);
    }
    return match[1]!;
  };

  // a transmission also holds a <joint name="..."> element, without a type: only the robot's own joints have one
  return [...text.matchAll(/<joint\s+name="([^"]+)"\s+type="([^"]+)"\s*>([\s\S]*?)<\/joint>/g)].map((match) => ({
    name: match[1]!,
    type: match[2]!,
    parent: attribute(match[3]!, "parent", "link"),
    child: attribute(match[3]!, "child", "link"),
    xyz: numbers(attribute(match[3]!, "origin", "xyz")),
    rpy: numbers(attribute(match[3]!, "origin", "rpy")),
    axis: numbers(attribute(match[3]!, "axis", "xyz")),
  }));
}

describe("the SO-101's description", () => {
  const bytes = readFileSync(URDF_PATH);
  const joints = urdfJoints(bytes.toString("utf8"));

  test("is PEAR's file: the hash of the copy is the one PEAR's kinematics loaded and the README states", () => {
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    expect(sha256).toBe(meta().urdf.sha256);
    expect(readFileSync(ASSET_README_PATH, "utf8")).toContain(`\`${sha256}\``);
  });

  test("leads from base_link to gripper_frame_link through the joints of the chain constant", () => {
    // walk the file from the tip's frame up to the base
    const walked: UrdfJoint[] = [];
    let link = SO101Kinematics.END_EFFECTOR_FRAME;
    while (link !== "base_link") {
      const joint = joints.find((candidate) => candidate.child === link);
      if (joint === undefined) {
        throw new Error(`The description has no joint above ${link}`);
      }
      walked.unshift(joint);
      link = joint.parent;
    }
    const tip = walked.pop()!;

    expect(walked.map((joint) => joint.name)).toEqual([...JOINTS]);
    expect(walked.every((joint) => joint.type === "revolute")).toBe(true);
    expect(walked.map(({ name, parent, child, xyz, rpy, axis }) => ({ name, parent, child, xyz, rpy, axis }))).toEqual(
      SO101_CHAIN.joints.map(({ name, parent, child, xyz, rpy, axis }) => ({
        name,
        parent,
        child,
        xyz: [...xyz],
        rpy: [...rpy],
        axis: [...axis],
      })),
    );

    expect(tip.type).toBe("fixed");
    expect({ name: tip.name, parent: tip.parent, child: tip.child, xyz: tip.xyz, rpy: tip.rpy }).toEqual({
      ...SO101_CHAIN.endEffector,
      xyz: [...SO101_CHAIN.endEffector.xyz],
      rpy: [...SO101_CHAIN.endEffector.rpy],
    });
  });

  test("has one more moving joint, the jaw's, which is not part of the arm's chain", () => {
    const moving = joints.filter((joint) => joint.type !== "fixed").map((joint) => joint.name);

    expect(moving.sort()).toEqual([...JOINTS, "gripper"].sort());
  });
});
