// The modules were ported separately; these tests hold them to one definition of what they share.
import { describe, expect, test } from "vitest";

import { PEAR_COMMIT, feetech, protocol, so101 } from "../src/index";

const { SO101Kinematics, UnreachablePoseError } = so101.kinematics;

// inside PEAR's default limits, near the pose PEAR calls Home; the gripper open
const JOINTS = [0.0, -0.8, 0.1, 1.4, -1.6, 1.0];

describe("the modules agree on what they share", () => {
  test("the package's entry gives the three modules and the pinned commit", () => {
    expect(PEAR_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof protocol.turnText).toBe("function");
    expect(typeof feetech.FeetechMotorsBus).toBe("function");
    expect(typeof so101.kinematics.SO101Kinematics).toBe("function");
    expect(typeof so101.hardware.SO101Hardware).toBe("function");
  });

  test("the servo layer's joints are the layout's own", () => {
    expect(so101.hardware.MOTORS).toBe(so101.MOTORS);
    expect(so101.hardware.JOINTS).toBe(so101.JOINTS);
    expect(so101.hardware.GRIPPER_INDEX).toBe(so101.GRIPPER_INDEX);
    expect(Object.keys(so101.hardware.followerMotors())).toEqual([...so101.MOTORS]);
  });

  test("the kinematics read and round the quantities the protocol shows", () => {
    expect(SO101Kinematics.ARM_QUANTITIES).toBe(protocol.ARM_QUANTITIES);
    expect(SO101Kinematics.DECIMALS).toBe(protocol.DECIMALS);

    const state = new SO101Kinematics().quantities(JOINTS);

    // what the kinematics give is already what a turn shows: rounding it again changes nothing
    expect(protocol.shownState(state)).toEqual(state);
    expect(protocol.turnText(state)).toContain(`"gripper": {"width": ${state.gripper.width.toFixed(1)}}`);
  });

  test("a parsed answer is an action the kinematics take, and an unreachable one fails under the protocol's name", () => {
    const kinematics = new SO101Kinematics();
    const answer = (z: number) =>
      "Lower the fingertip.\n\n```json\n" +
      `{"arm": {"x": 0, "y": 0, "z": ${z}, "pitch": 0, "roll": 0}, "gripper": {"width": 0}}` +
      "\n```";

    const goal = kinematics.jointTarget(JOINTS, protocol.parseAction(answer(-2)));
    expect(goal).toHaveLength(so101.VECTOR_LENGTH);
    expect(goal[so101.GRIPPER_INDEX]).toBe(JOINTS[so101.GRIPPER_INDEX]); // the gripper's part moves no joint

    let failure: unknown;
    try {
      kinematics.jointTarget(JOINTS, protocol.parseAction(answer(90)));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(UnreachablePoseError);
    expect((failure as Error).name).toBe(protocol.UNREACHABLE_POSE_ERROR);

    // the message the kinematics give is what the model reads of a rejected action
    const feedback = protocol.executionFeedback(
      {
        status: protocol.MotionStatus.REJECTED,
        isSettled: true,
        targetReached: false,
        measuredPosition: JOINTS,
        trackingError: null,
        measuredState: kinematics.quantities(JOINTS),
        gripperOutcome: null,
        error: { code: (failure as Error).name, message: (failure as Error).message },
      },
      { isDispatched: false },
    );
    expect(feedback).toContain("out_of_reach");
    expect(feedback).toContain((failure as Error).message);
  });
});
