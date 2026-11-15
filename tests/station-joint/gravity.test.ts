import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { GravityModel, SO101_MASSES } from "../../src/so101/joint/feedforward";
import { SO101_CHAIN } from "../../src/so101/kinematics/chain";
import { ValueError } from "../../src/station/joint/errors";
import { meta, repositoryFile } from "./fixtures";

const bytes = repositoryFile("assets/pear/so101/so101_new_calib.urdf");
const text = bytes.toString("utf8");
const numbers = (value: string): number[] => value.trim().split(/\s+/).map(Number);

/** Returns the attribute `name` of the first element `tag` in `element`. */
function attribute(element: string, tag: string, name: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`).exec(element);
  if (match === null) {
    throw new Error(`The description has no ${tag} ${name} here`);
  }
  return match[1]!;
}

/** The description's links: each with its mass and where its `<inertial>` puts its centre. */
const links = new Map(
  [...text.matchAll(/<link name="([^"]+)">([\s\S]*?)<\/link>/g)].map((match) => {
    const inertial = /<inertial>([\s\S]*?)<\/inertial>/.exec(match[2]!)![1]!;
    return [
      match[1]!,
      {
        mass: Number(attribute(inertial, "mass", "value")),
        centre: numbers(attribute(inertial, "origin", "xyz")),
        turned: numbers(attribute(inertial, "origin", "rpy")),
      },
    ];
  }),
);

/** The description's joints (a transmission's `<joint>` has no type and is none of them). */
const joints = [...text.matchAll(/<joint\s+name="([^"]+)"\s+type="([^"]+)"\s*>([\s\S]*?)<\/joint>/g)].map((match) => ({
  name: match[1]!,
  type: match[2]!,
  parent: attribute(match[3]!, "parent", "link"),
  child: attribute(match[3]!, "child", "link"),
  xyz: numbers(attribute(match[3]!, "origin", "xyz")),
  rpy: numbers(attribute(match[3]!, "origin", "rpy")),
}));

describe("the masses of the SO-101's gravity model", () => {
  test("the description is the file PEAR's gravity model loaded", () => {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(meta.urdf.sha256);
  });

  test("each arm joint's link has the mass and the centre the description gives it", () => {
    expect(SO101_MASSES.links.map(({ link }) => link)).toEqual(SO101_CHAIN.joints.map((joint) => joint.child));
    for (const { link, mass, centre } of SO101_MASSES.links) {
      expect(mass, link).toBe(links.get(link)!.mass);
      expect([...centre], link).toEqual(links.get(link)!.centre);
    }
  });

  test("what hangs on the last link is the description's: the fingertip's frame and the jaw, each at its joint", () => {
    const lastLink = SO101_CHAIN.joints[SO101_CHAIN.joints.length - 1]!.child;
    const hanging = joints.filter((joint) => joint.parent === lastLink);

    expect(SO101_MASSES.attached.map(({ joint }) => joint).sort()).toEqual(hanging.map((joint) => joint.name).sort());
    for (const attached of SO101_MASSES.attached) {
      const joint = hanging.find((candidate) => candidate.name === attached.joint)!;
      expect(attached.link).toBe(joint.child);
      expect([...attached.xyz], attached.joint).toEqual(joint.xyz);
      expect([...attached.rpy], attached.joint).toEqual(joint.rpy);
      expect(attached.mass, attached.link).toBe(links.get(attached.link)!.mass);
      expect([...attached.centre], attached.link).toEqual(links.get(attached.link)!.centre);
    }
    // the fingertip's frame is the chain's tip: one origin for the kinematics and for the masses
    const tip = SO101_MASSES.attached.find(({ joint }) => joint === SO101_CHAIN.endEffector.name)!;
    expect([...tip.xyz]).toEqual([...SO101_CHAIN.endEffector.xyz]);
    expect([...tip.rpy]).toEqual([...SO101_CHAIN.endEffector.rpy]);
  });

  test("no link that a joint carries is left out, and no centre is given in a turned frame", () => {
    const carried = [...SO101_MASSES.links, ...SO101_MASSES.attached].map(({ link }) => link).sort();
    const described = [...links.keys()].filter((name) => name !== SO101_CHAIN.joints[0]!.parent).sort();

    expect(carried).toEqual(described);
    expect(described).toHaveLength(7);
    expect([...links.values()].every(({ turned }) => turned.every((angle) => angle === 0))).toBe(true);
    // nothing hangs anywhere but on the last link: every other joint of the file is one of the chain's
    const others = joints.filter((joint) => !SO101_MASSES.attached.some(({ joint: name }) => name === joint.name));
    expect(others.map((joint) => joint.name).sort()).toEqual(SO101_CHAIN.joints.map((joint) => joint.name).sort());
  });

  test("a gravity model refuses masses that are not of the chain's links", () => {
    const fewer = { ...SO101_MASSES, links: SO101_MASSES.links.slice(1) };
    const swapped = { ...SO101_MASSES, links: [...SO101_MASSES.links].reverse() };

    expect(() => new GravityModel(SO101_CHAIN, fewer)).toThrow(ValueError);
    expect(() => new GravityModel(SO101_CHAIN, swapped)).toThrow(ValueError);
    expect(() => new GravityModel()).not.toThrow();
  });

  test("the jaw's mass counts: without it the torque at the wrist changes", () => {
    const whole = new GravityModel().torque([0.3, -0.6, 0.4, 0.9, 0.2]);
    const withoutJaw = new GravityModel(SO101_CHAIN, { ...SO101_MASSES, attached: SO101_MASSES.attached.slice(0, 1) }).torque([
      0.3, -0.6, 0.4, 0.9, 0.2,
    ]);

    expect(Math.abs(whole[3]! - withoutJaw[3]!)).toBeGreaterThan(1e-3);
  });
});
