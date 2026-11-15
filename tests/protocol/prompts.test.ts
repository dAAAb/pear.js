import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { PEAR_COMMIT } from "../../src/index";
import {
  ARM_QUANTITIES,
  CAMERA_NAMES,
  DECIMALS,
  FORMAT_NAME,
  GripperOutcome,
  MotionStatus,
  SCHEMA,
  SINGLE_ARM_POSE_ENVIRONMENT,
  SYSTEM_PROMPT_TEMPLATE,
  systemPrompt,
  THINK_START,
  UNREACHABLE_POSE_ERROR,
} from "../../src/protocol/index";
import { loadFixture, meta, repositoryFile } from "./fixtures";

const cases = loadFixture<{ cases: Array<{ instruction: string; prompt: string }> }>("system_prompt.json").cases;

describe("PEAR's prompt files", () => {
  const readme = repositoryFile("assets/pear/prompts/README.md").toString("utf8");

  test.each([
    ["system_prompt.md", SYSTEM_PROMPT_TEMPLATE],
    ["single_arm_pose.md", SINGLE_ARM_POSE_ENVIRONMENT],
  ])("%s is embedded byte for byte and is the file the fixtures were made with", (name, embedded) => {
    const asset = repositoryFile(`assets/pear/prompts/${name}`);
    const recorded = meta.prompts[name]!;

    expect(Buffer.from(embedded, "utf8").equals(asset)).toBe(true);
    expect(asset.includes("\r")).toBe(false);
    expect(createHash("sha256").update(asset).digest("hex")).toBe(recorded.sha256);
    expect(readme).toContain(`\`${recorded.pear_path}\` | \`${recorded.sha256}\``);
  });

  test("the fixtures were made with PEAR at the pinned commit", () => {
    expect(meta.pear_commit).toBe(PEAR_COMMIT);
    expect(readme).toContain(PEAR_COMMIT);
  });
});

describe("the format's constants", () => {
  test("are PEAR's", () => {
    expect(FORMAT_NAME).toBe(meta.format);
    expect(JSON.stringify(SCHEMA)).toBe(JSON.stringify(meta.schema));
    expect([...ARM_QUANTITIES]).toEqual(meta.schema.arm);
    expect(JSON.stringify(DECIMALS)).toBe(JSON.stringify(meta.decimals));
    expect([...CAMERA_NAMES]).toEqual(meta.cameras);
    expect(THINK_START).toBe(meta.think_start);
    expect(UNREACHABLE_POSE_ERROR).toBe(meta.unreachable_code);
    expect(Object.values(MotionStatus)).toEqual(meta.motion_statuses);
    expect(Object.values(GripperOutcome)).toEqual(meta.gripper_outcomes);
  });
});

describe("systemPrompt", () => {
  test.each(cases.map((item, index) => [index, JSON.stringify(item.instruction).slice(0, 60), item] as const))(
    "is PEAR's prompt of instruction %i: %s",
    (_index, _label, item) => {
      expect(systemPrompt(item.instruction)).toBe(item.prompt);
    },
  );

  test("is PEAR's stored text", () => {
    const stored = meta.stored_texts!.prompt;

    expect(systemPrompt(stored.instruction)).toBe(stored.text);
  });
});
