// The library's one set of Python exceptions (src/python/errors.ts) against Python's own classes and those of PEAR,
// lerobot and the OpenAI SDK, as tests/python/make_reference.py recorded them: each class's name, its bases in
// Python's order and whether it is a ValueError. A module's class that ends up under another base, a second class
// for one Python class or a wrong name fails here.

import { describe, expect, test } from "vitest";

import { PEAR_COMMIT, agent, feetech, protocol, python, so101, station } from "../../src/index";
import { reference, type ReferenceClass } from "./reference";

const { isValueError, motionErrorOf, pythonErrorMessage, pythonErrorName, PythonException } = python;

/** A class of pear.js that stands for a Python exception class: made with a message alone, as these tests do. */
type ErrorClass = abstract new (...arguments_: never[]) => Error;

/** The class pear.js has for each Python exception class of the reference, by the Python class's name. */
const CLASSES: Record<string, ErrorClass> = {
  Exception: python.PythonException,
  ArithmeticError: python.ArithmeticError,
  OverflowError: python.OverflowError,
  ZeroDivisionError: python.ZeroDivisionError,
  AttributeError: python.AttributeError,
  LookupError: python.LookupError,
  IndexError: python.IndexError,
  KeyError: python.KeyError,
  OSError: python.OSError,
  ConnectionError: python.ConnectionError,
  TimeoutError: python.TimeoutError,
  RuntimeError: python.RuntimeError,
  NotImplementedError: python.NotImplementedError,
  RecursionError: python.RecursionError,
  StopIteration: python.StopIteration,
  TypeError: python.PythonTypeError,
  ValueError: python.ValueError,
  UnicodeError: python.UnicodeError,
  UnicodeDecodeError: python.UnicodeDecodeError,
  JSONDecodeError: python.JSONDecodeError,
  OperatorPaused: station.exceptions.OperatorPaused,
  UnreachablePoseError: so101.kinematics.UnreachablePoseError,
  StabilityError: station.joint.StabilityError,
  TrackingError: station.joint.TrackingError,
  ContextLimit: agent.ContextLimit,
  SessionLost: agent.SessionLost,
  ImageCacheMiss: agent.ImageCacheMiss,
  ServoFault: so101.hardware.ServoFault,
  DeviceNotConnectedError: feetech.DeviceNotConnectedError,
  DeviceAlreadyConnectedError: feetech.DeviceAlreadyConnectedError,
  OpenAIError: agent.OpenAIError,
  APIError: agent.APIError,
  APIStatusError: agent.APIStatusError,
  APIConnectionError: agent.APIConnectionError,
  APITimeoutError: agent.APITimeoutError,
  BadRequestError: agent.BadRequestError,
  AuthenticationError: agent.AuthenticationError,
  PermissionDeniedError: agent.PermissionDeniedError,
  NotFoundError: agent.NotFoundError,
  ConflictError: agent.ConflictError,
  UnprocessableEntityError: agent.UnprocessableEntityError,
  RateLimitError: agent.RateLimitError,
  InternalServerError: agent.InternalServerError,
  // no `except Exception` catches it: asyncio's CancelledError is a BaseException
  CancelledError: agent.RequestCancelled,
};

/** The classes whose constructor reads more than a message, each with how these tests make one. */
const MAKERS = new Map<ErrorClass, () => Error>([
  [station.joint.StabilityError, () => new station.joint.StabilityError("The arm moved", {})],
  [station.joint.TrackingError, () => new station.joint.TrackingError({ violations: [] }, so101.LAYOUT)],
]);

/** Returns an error of ``errorClass``, made with a message alone unless the class needs more. */
function instanceOf(errorClass: ErrorClass, message = "m"): Error {
  return MAKERS.get(errorClass)?.() ?? new (errorClass as unknown as new (message: string) => Error)(message);
}

/**
 * Returns the names of the Python classes ``errorClass`` stands for, itself first and then each class it extends,
 * up to Python's Exception: the `.name` of an instance of each class of its chain. A class of pear.js that stands
 * for the same Python class as its parent (lerobot's ConnectionError as FeetechCommError) counts once.
 */
function pythonChain(errorClass: ErrorClass): string[] {
  const names: string[] = [];
  for (let each: unknown = errorClass; typeof each === "function" && each !== Error; each = Object.getPrototypeOf(each)) {
    const name = instanceOf(each as ErrorClass).name;
    if (names[names.length - 1] !== name) {
      names.push(name);
    }
  }

  return names;
}

/** Python's bases of a class as pear.js can have them: up to Exception, which stands for the rest. */
function pythonBases(recorded: ReferenceClass): string[] {
  const end = recorded.mro.indexOf("Exception");

  return end < 0 ? [] : recorded.mro.slice(0, end + 1);
}

const recordedClasses = reference.exceptions.classes;

describe("Python's exceptions", () => {
  test("the reference was made from the PEAR this library pins", () => {
    expect(reference.meta.pear_commit).toBe(PEAR_COMMIT);
    expect(reference.meta.python.startsWith("3.12.")).toBe(true);
  });

  test("pear.js has one class for every class of the reference, and the reference every class listed here", () => {
    expect(Object.keys(CLASSES).sort()).toEqual(recordedClasses.map((recorded) => recorded.name).sort());
    expect(new Set(Object.values(CLASSES)).size).toBe(Object.keys(CLASSES).length);
  });

  test.each(recordedClasses.filter((recorded) => recorded.is_exception).map((recorded) => [recorded.name, recorded] as const))(
    "%s has Python's name and extends what it extends in Python",
    (name, recorded) => {
      const errorClass = CLASSES[name]!;
      const error = instanceOf(errorClass, "refused");

      expect(error.name).toBe(name);
      expect(pythonErrorName(error)).toBe(name);
      expect(pythonErrorMessage(error)).toBe(error.message);
      expect(pythonChain(errorClass)).toEqual(pythonBases(recorded));
      expect(error).toBeInstanceOf(PythonException);
      expect(error).toBeInstanceOf(Error);
      // isinstance(error, base) for every base Python gives it, and for no other class of the library
      for (const [baseName, baseClass] of Object.entries(CLASSES)) {
        expect([baseName, error instanceof baseClass]).toEqual([baseName, recorded.mro.includes(baseName)]);
      }
    },
  );

  test.each(recordedClasses.map((recorded) => [recorded.name, recorded] as const))(
    "%s is a ValueError where Python's is, by instanceof and by isValueError",
    (name, recorded) => {
      const error = instanceOf(CLASSES[name]!);

      expect(error instanceof python.ValueError).toBe(recorded.is_value_error);
      expect(isValueError(error)).toBe(recorded.is_value_error);
    },
  );

  test("a class that keeps a TypeScript name of its own stands for the Python class it extends", () => {
    const recordedByName = new Map(recordedClasses.map((recorded) => [recorded.name, recorded]));
    const comm = new feetech.FeetechCommError("There is no status packet!", -6);
    const status = new feetech.FeetechStatusError("Overload error!", 0x20);

    // lerobot raises ConnectionError for a failed exchange and RuntimeError for an error byte
    expect([comm.name, pythonErrorName(comm), comm.result]).toEqual(["ConnectionError", "ConnectionError", -6]);
    expect(pythonChain(feetech.FeetechCommError)).toEqual(pythonBases(recordedByName.get("ConnectionError")!));
    expect(comm).toBeInstanceOf(python.ConnectionError);
    expect(comm).toBeInstanceOf(python.OSError);
    expect([status.name, pythonErrorName(status), status.error]).toEqual(["RuntimeError", "RuntimeError", 0x20]);
    expect(pythonChain(feetech.FeetechStatusError)).toEqual(pythonBases(recordedByName.get("RuntimeError")!));
    expect(status).toBeInstanceOf(python.RuntimeError);
    expect(status).not.toBeInstanceOf(python.OSError);
    expect([isValueError(comm), isValueError(status)]).toEqual([false, false]);

    // the two are told apart from lerobot's own ConnectionErrors, which PEAR's retry of enabling also catches
    expect(new feetech.DeviceNotConnectedError("not connected")).toBeInstanceOf(python.ConnectionError);
    expect(new feetech.DeviceNotConnectedError("not connected")).not.toBeInstanceOf(feetech.FeetechCommError);
    expect(comm).not.toBeInstanceOf(feetech.DeviceAlreadyConnectedError);
  });

  test("what no `except Exception` catches is no exception of the library", () => {
    const outside = recordedClasses.filter((recorded) => !recorded.is_exception);

    expect(outside.map((recorded) => recorded.name)).toEqual(["CancelledError"]);
    for (const recorded of outside) {
      expect(instanceOf(CLASSES[recorded.name]!)).not.toBeInstanceOf(PythonException);
    }
  });

  test("an error's text is str(error), and a result carries Python's code and message", () => {
    const { texts, motion_errors: motionErrors } = reference.exceptions;

    expect(new python.TimeoutError().message).toBe(texts["TimeoutError()"]);
    expect(new python.ValueError("refused").message).toBe(texts["ValueError('refused')"]);
    // the text of a KeyError is the repr of its key, which the caller gives
    expect(new python.KeyError("'wrist'").message).toBe(texts["KeyError('wrist')"]);

    const errors = [
      new python.ValueError("Rotation increment exceeds the planning bound"),
      new station.exceptions.OperatorPaused("Operation interrupted by the operator"),
      new so101.kinematics.UnreachablePoseError("out of reach"),
      new python.TimeoutError(),
      new python.KeyError("'wrist'"),
    ];
    expect(errors.map(motionErrorOf)).toEqual(motionErrors);
  });
});

describe("an error whose class does not tell its Python class", () => {
  test("a PythonError carries the name it is given and says whether it is a ValueError", () => {
    const timeout = new python.PythonError("GripperEndpointTimeout", "the jaw did not arrive", false);
    const planning = new python.PythonError("HomePlanningError", "no plan", true);

    expect([timeout.name, pythonErrorName(timeout), isValueError(timeout)]).toEqual([
      "GripperEndpointTimeout",
      "GripperEndpointTimeout",
      false,
    ]);
    expect([planning.name, pythonErrorName(planning), isValueError(planning)]).toEqual([
      "HomePlanningError",
      "HomePlanningError",
      true,
    ]);
    expect(timeout).toBeInstanceOf(PythonException);
    expect(planning).not.toBeInstanceOf(python.ValueError); // it declares it; its class cannot
    expect(motionErrorOf(timeout)).toEqual({ code: "GripperEndpointTimeout", message: "the jaw did not arrive" });
  });

  test("the protocol's ActionParseError answers for the exception PEAR raises", () => {
    const thrown = (answer: string): unknown => {
      try {
        protocol.parseAction(answer);
      } catch (error) {
        return error;
      }
      throw new Error("The answer was taken");
    };
    const block = (json: string): string => "```json\n" + json + "\n```";
    const arm = (x: string): string => `{"arm": {"x": ${x}, "y": 0, "z": 0, "pitch": 0, "roll": 0}, "gripper": {"width": 0}}`;
    // what PEAR raises for each: ValueError, json.JSONDecodeError, OverflowError, RecursionError
    const cases: Array<[string, string, boolean]> = [
      ["no block", "ValueError", true],
      [block('{"arm": }'), "JSONDecodeError", true],
      [block(arm(`1${"0".repeat(400)}`)), "OverflowError", false],
      [block(`{"arm": ${"[".repeat(10_000)}${"]".repeat(10_000)}}`), "RecursionError", false],
    ];

    for (const [answer, name, rejects] of cases) {
      const error = thrown(answer);

      expect(error).toBeInstanceOf(protocol.ActionParseError);
      expect(error).toBeInstanceOf(PythonException);
      expect([pythonErrorName(error), isValueError(error)]).toEqual([name, rejects]);
      expect(motionErrorOf(error)).toEqual((error as InstanceType<typeof protocol.ActionParseError>).error);
      // the class the code names is one of the library's, and it is a ValueError exactly when the turn is rejected
      expect(instanceOf(CLASSES[name]!) instanceof python.ValueError).toBe(rejects);
    }
  });

  test("an error that is not the library's is read by its name, and by what it declares", () => {
    class ValueError extends Error {} // a caller's own class, or another copy of the library's
    class Refused extends ValueError {}
    class OperatorPaused extends Error {
      override readonly name = "OperatorPaused";
    }

    expect(isValueError(new ValueError("v"))).toBe(true);
    expect(isValueError(new Refused("v"))).toBe(true);
    expect(new Refused("v")).not.toBeInstanceOf(python.ValueError);
    expect(pythonErrorName(new OperatorPaused("p"))).toBe("OperatorPaused");
    expect([pythonErrorName(new TypeError("t")), isValueError(new TypeError("t"))]).toEqual(["TypeError", false]);
    expect([pythonErrorName(new RangeError("r")), isValueError(new RangeError("r"))]).toEqual(["RangeError", false]);
    expect([pythonErrorName("text"), pythonErrorMessage("text"), isValueError("text")]).toEqual(["Exception", "text", false]);
    expect([pythonErrorName(undefined), isValueError(undefined), isValueError(null)]).toEqual(["Exception", false, false]);
    expect(isValueError({ isValueError: true })).toBe(true);
    expect(isValueError({ isValueError: "yes" })).toBe(false);
    expect(pythonErrorName(Object.assign(new Error("m"), { pythonType: "HomeFailed" }))).toBe("HomeFailed");
    // a class of the library is never guessed at: a RuntimeError that claims nothing is none
    expect(isValueError(new python.RuntimeError("r"))).toBe(false);
  });
});
