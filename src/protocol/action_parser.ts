// Ports pear/deploy/station/agent_loop/action_parser.py (ActionParser), with JSON_BLOCK_PATTERN of
// pear/agent_loop/protocol.py and the action model SingleArmDelta of
// pear/deploy/station/control/robots/so101/motion/actions.py, for the SO-101's single_arm_pose format.

import { PythonError, pythonJsonLoads, type PythonJsonValue } from "./python_json";
import { isPythonBlank, PYTHON_WHITESPACE_CLASS } from "./python_text";
import { MotionStatus, SCHEMA, type MotionError, type SingleArmDelta } from "./types";

/** What opens a model's thinking: an answer that holds it is refused. */
export const THINK_START = "<think>";

// JsonBlockProtocol.JSON_BLOCK_PATTERN, ```json\s*(\{.*?\})\s*``` with re.DOTALL: a fenced json block and its
// object. Python's \s is spelled out, since JavaScript's differs.
const JSON_BLOCK_SOURCE =
  "```json[" + PYTHON_WHITESPACE_CLASS + "]*(\\{[\\s\\S]*?\\})[" + PYTHON_WHITESPACE_CLASS + "]*```";

/**
 * An answer that gives no action. PEAR's agent loop records such a turn as a result that carries the Python
 * exception's class name and message, which the next turn's report shows the model: both are reproduced here.
 */
export class ActionParseError extends Error {
  /** The class name of the exception PEAR raises: "ValueError", "JSONDecodeError", "OverflowError", ... */
  readonly code: string;
  /** How StationAgentLoop.step records the turn: rejected for a ValueError, failed for any other exception. */
  readonly status: typeof MotionStatus.REJECTED | typeof MotionStatus.FAILED;

  constructor(code: string, message: string, status: typeof MotionStatus.REJECTED | typeof MotionStatus.FAILED) {
    super(message);
    this.name = "ActionParseError";
    this.code = code;
    this.status = status;
  }

  /** The error as the turn's result carries it. */
  get error(): MotionError {
    return { code: this.code, message: this.message };
  }
}

/**
 * Returns the action of the json block that ends ``answer``, the model's complete final answer; throws
 * ActionParseError for an answer that holds a thinking block, ends otherwise or gives no action of the format.
 *
 * The block's object must map exactly the parts arm and gripper to exactly their quantities, each a finite number.
 * No bound is checked here: PEAR bounds an increment when it plans the motion.
 */
export function parseAction(answer: string): SingleArmDelta {
  try {
    return parse(answer);
  } catch (error) {
    if (error instanceof PythonError) {
      const status = error.isValueError ? MotionStatus.REJECTED : MotionStatus.FAILED;
      throw new ActionParseError(error.pythonType, error.message, status);
    }
    throw error;
  }
}

function parse(answer: string): SingleArmDelta {
  if (answer.includes(THINK_START)) {
    throw valueError("Final answer unexpectedly contains a thinking block");
  }
  const pattern = new RegExp(JSON_BLOCK_SOURCE, "g");
  let lastBlock: RegExpExecArray | null = null;
  for (let block = pattern.exec(answer); block !== null; block = pattern.exec(answer)) {
    lastBlock = block;
  }
  if (lastBlock === null || !isPythonBlank(answer.slice(lastBlock.index + lastBlock[0].length))) {
    throw valueError("Final answer must end with a fenced json action");
  }

  const fields = pythonJsonLoads(lastBlock[1]!, uniqueObject);
  const parts = Object.keys(SCHEMA) as Array<keyof typeof SCHEMA>;
  if (fields.type !== "dict" || !hasExactly(fields.items, parts)) {
    throw valueError(`Expected exactly the parts ${parts.join(", ")}`);
  }
  const numbers = new Map<string, number>();
  for (const part of parts) {
    const quantities = fields.items.get(part)!;
    if (quantities.type !== "dict" || !hasExactly(quantities.items, SCHEMA[part])) {
      throw valueError(`Invalid quantities for ${part}`);
    }
    // in the answer's order: the first quantity that is no finite number decides the error
    for (const [name, quantity] of quantities.items) {
      numbers.set(`${part}.${name}`, finiteNumber(quantity));
    }
  }

  const number = (name: string): number => numbers.get(name)!;
  return {
    type: "single_arm_delta",
    arm: {
      x: number("arm.x"),
      y: number("arm.y"),
      z: number("arm.z"),
      pitch: number("arm.pitch"),
      roll: number("arm.roll"),
    },
    gripper: { width: number("gripper.width") },
  };
}

/** ActionParser._unique_object: the JSON object of ``pairs``, refused for a name it holds twice. */
function uniqueObject(pairs: Array<[string, PythonJsonValue]>): PythonJsonValue {
  const items = new Map<string, PythonJsonValue>();
  for (const [key, item] of pairs) {
    if (items.has(key)) {
      throw valueError(`Duplicate action field: ${key}`);
    }
    items.set(key, item);
  }

  return { type: "dict", items };
}

/** Whether the names of ``items`` are exactly ``names``. */
function hasExactly(items: Map<string, PythonJsonValue>, names: readonly string[]): boolean {
  return items.size === names.length && names.every((name) => items.has(name));
}

/** The float of a quantity, as the action's model takes it; refused unless it is a finite int or float. */
function finiteNumber(quantity: PythonJsonValue): number {
  if (quantity.type === "int") {
    const value = Number(quantity.literal);
    if (!Number.isFinite(value)) {
      // math.isfinite of an int past every float; no ValueError, so PEAR fails the turn instead of rejecting it
      throw new PythonError("OverflowError", "int too large to convert to float", false);
    }
    return value + 0; // the int -0 is 0, where the float -0.0 keeps its sign
  }
  if (quantity.type !== "float" || !Number.isFinite(quantity.value)) {
    throw valueError("Action quantities must be finite numbers, not booleans");
  }

  return quantity.value;
}

function valueError(message: string): PythonError {
  return new PythonError("ValueError", message, true);
}
