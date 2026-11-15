// The constants of the control loop's classes against PEAR's own.
//
// tools/fixtures/loop_fixtures.py reads them of PEAR's classes into meta.json. Most of them decide something a
// scenario of the fixtures shows; some are only kept for the layer above (how long a maintenance command waits for
// a HOLD), or would take a scenario of minutes (the wait of a shutdown): here each is compared by itself.

import { describe, expect, test } from "vitest";

import { SO101ControlLoop } from "../../src/so101/joint/control_loop";
import { GripperOutcome, SO101GripperOperation } from "../../src/so101/joint/grippers";
import { ArmState } from "../../src/station/joint/arm_state";
import { Braking, JointControlLoop } from "../../src/station/joint/control_loop";
import { SequenceOperation } from "../../src/station/joint/operations";
import { MeasuredHoldRecovery, ReleaseRecovery } from "../../src/station/joint/recovery";
import { GripperProfile, JointMove, JointTrajectory } from "../../src/station/joint/trajectory";
import { meta } from "./fixtures";
import { StandInClock } from "./standins";

const constants = meta.constants;

describe("the constants of the control loop's classes are PEAR's", () => {
  test.each([
    "RECOVERY_WINDOW_FLOOR_S",
    "START_EPSILON",
    "STATIONARY_EPSILON",
    "MOVE_MARGIN_S",
    "SEQUENCE_MARGIN_S",
    "GRIPPER_TIMEOUT_S",
    "HOLD_WAIT_S",
    "SHUTDOWN_WAIT_S",
    "THREAD_JOIN_S",
  ] as const)("JointControlLoop.%s", (name) => {
    expect(typeof constants[name]).toBe("number");
    expect(JointControlLoop[name]).toBe(constants[name]);
    // a robot's loop that gives none of its own has the same
    expect(SO101ControlLoop[name]).toBe(constants[name]);
  });

  test("the control thread's name and the slack of a reading's stamp", () => {
    expect(JointControlLoop.THREAD_NAME).toBe(constants["THREAD_NAME"]);
    expect(SO101ControlLoop.THREAD_NAME).toBe(constants["THREAD_NAME"]);
    expect(typeof constants["CLOCK_SLACK_S"]).toBe("number");
    expect(ArmState.CLOCK_SLACK_S).toBe(constants["CLOCK_SLACK_S"]);
  });

  test("the trajectory classes and the operations", () => {
    expect(JointMove.MAX_DURATION_S).toBe(constants["MAX_DURATION_S"]);
    expect(SequenceOperation.MAX_ROWS).toBe(constants["MAX_ROWS"]);
    expect(SequenceOperation.PHASE_EPSILON).toBe(constants["PHASE_EPSILON"]);
    expect(GripperProfile.OPEN_ENDPOINT).toBe(constants["OPEN_ENDPOINT"]);
    expect(GripperProfile.CLOSED_ENDPOINT).toBe(constants["CLOSED_ENDPOINT"]);
    // Ruckig's three inputs of the motion caps, in PEAR's order
    expect(JointTrajectory.CAP_INPUTS).toEqual(["maxVelocity", "maxAcceleration", "maxJerk"]);
  });

  test("the recovery policies", () => {
    expect(MeasuredHoldRecovery.TIMEOUT_SETTLE_COUNT).toBe(constants["TIMEOUT_SETTLE_COUNT"]);
    expect(ReleaseRecovery.MIN_TIMEOUT_S).toBe(constants["MIN_TIMEOUT_S"]);
    expect([...ReleaseRecovery.RELEASE_CAPS]).toEqual(constants["RELEASE_CAPS"]);
    expect(ReleaseRecovery.RELEASE_MARGIN_S).toBe(constants["RELEASE_MARGIN_S"]);
    expect(ReleaseRecovery.START_EPSILON).toBe(constants["RELEASE_START_EPSILON"]);
  });

  test("what a controlled stop brakes with", () => {
    expect({ ...Braking }).toEqual(constants["braking"]);
  });

  test("the SO-101's loop names its jaw's operation, the measured hold, the station's braking and no velocity RMS", () => {
    expect(SO101ControlLoop.GRIPPER_OPERATION_CLASS).toBe(SO101GripperOperation);
    expect(SO101ControlLoop.RECOVERY_POLICY_CLASS).toBe(MeasuredHoldRecovery);
    expect(SO101ControlLoop.BRAKING).toBe(Braking.STATION_LIMITS);
    expect(SO101ControlLoop.CHECKS_VELOCITY_RMS).toBe(false);
    expect({ ...GripperOutcome }).toEqual({ OPEN: "open", CLOSED: "closed", STOPPED_BEFORE_CLOSED: "stopped_before_closed" });
  });

  test("the stand-in clock of the tests starts where PEAR's does", () => {
    expect(StandInClock.START_S).toBe(constants["start_s"]);
  });
});
