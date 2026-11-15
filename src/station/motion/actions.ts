// Ports <pear>/pear/deploy/station/control/motion/actions.py.

import { ValueError } from "../../python/errors";
import { pythonFloatRepr } from "../../python/float";
import { pythonRepr, pythonStringRepr, pythonTypeName, pythonValueOf } from "../../python/repr";
import { SequenceOperation } from "../joint/operations";
import type { JointLayout } from "../joint/layout";

/** pydantic_core.ValidationError: a ValueError whose message is pydantic's str(error). */
export class ValidationError extends ValueError {
  override readonly name = "ValidationError";
}

/** What a PEAR strict model class exposes to its callers. */
export interface StrictModelClass<Model> {
  readonly name: string;
  modelValidate(value: unknown): Model;
  isInstance(value: unknown): value is Model;
}

/** A float, literal, nested strict model, or bounded list in a strict model's field description. */
export type StrictFieldSchema =
  | { readonly kind: "float"; readonly greaterThan?: number }
  | { readonly kind: "literal"; readonly values: readonly (string | number | boolean | null)[] }
  | { readonly kind: "model"; readonly model: StrictModelClass<unknown> }
  | {
      readonly kind: "list";
      readonly item: StrictFieldSchema;
      readonly minLength?: number;
      readonly maxLength?: number;
    };

/** One field, in the order pydantic validates and dumps it. */
export interface StrictModelField {
  readonly name: string;
  readonly schema: StrictFieldSchema;
  readonly defaultValue?: unknown;
}

/** The small part of a pydantic model schema used by PEAR's action models. */
export interface StrictModelDefinition<Model> {
  readonly name: string;
  readonly fields: readonly StrictModelField[];
  readonly tag?: string;
  readonly adapterName?: string;
  readonly after?: (value: Model) => string | undefined;
}

type LocationPart = string | number;

interface ErrorDetail {
  readonly location: readonly LocationPart[];
  readonly type: string;
  readonly message: string;
  readonly input: unknown;
}

interface ValidationResult<Model> {
  readonly value?: Model;
  readonly errors: ErrorDetail[];
}

const definitions = new WeakMap<object, StrictModelDefinition<unknown>>();

function isDictionary(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

// Fixture numbers that are safe whole numbers stand for Python ints. An unsafe whole Number came from a float in
// PEAR's JSON fixtures: unlike pythonValueOf, this also preserves -0.0 and those large floats in refusal text.
function isPythonInt(value: number): boolean {
  return Number.isSafeInteger(value) && !Object.is(value, -0);
}

function actionPythonRepr(value: unknown): string {
  if (typeof value === "number") {
    return isPythonInt(value) ? pythonRepr(pythonValueOf(value)) : pythonFloatRepr(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(actionPythonRepr).join(", ")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const fields = Object.entries(value).map(
      ([key, child]) => `${pythonStringRepr(key)}: ${actionPythonRepr(child)}`,
    );
    return `{${fields.join(", ")}}`;
  }

  return pythonRepr(pythonValueOf(value));
}

function actionPythonTypeName(value: unknown): string {
  if (typeof value === "number") {
    return isPythonInt(value) ? "int" : "float";
  }

  return pythonTypeName(value);
}

// The bytes UTF-8 writes a character in.
function utf8Length(character: string): number {
  const codePoint = character.codePointAt(0) as number;
  if (codePoint < 0x80) {
    return 1;
  }
  if (codePoint < 0x800) {
    return 2;
  }

  return codePoint < 0x10000 ? 3 : 4;
}

// pydantic-core measures the repr in UTF-8 bytes and shows one of at most 50 whole. Of a longer one it shows the
// first 25 bytes and the last 24 around "...", each less the bytes of a character that its cut would split.
function shownInput(value: unknown): string {
  const characters = Array.from(actionPythonRepr(value));
  const sizes = characters.map(utf8Length);
  if (sizes.reduce((total, size) => total + size, 0) <= 50) {
    return characters.join("");
  }

  let front = 0;
  for (let bytes = sizes[0] as number; bytes <= 25; bytes += sizes[front] as number) {
    front += 1;
  }
  let back = characters.length;
  for (let bytes = sizes[back - 1] as number; bytes <= 24; bytes += sizes[back - 1] as number) {
    back -= 1;
  }

  return `${characters.slice(0, front).join("")}...${characters.slice(back).join("")}`;
}

function error(
  location: readonly LocationPart[],
  type: string,
  message: string,
  input: unknown,
): ErrorDetail {
  return { location, type, message, input };
}

function expectedLiterals(values: readonly (string | number | boolean | null)[]): string {
  const shown = values.map(actionPythonRepr);
  if (shown.length < 2) {
    return shown[0] as string;
  }

  return `${shown.slice(0, -1).join(", ")} or ${shown[shown.length - 1]}`;
}

function definitionOf(model: StrictModelClass<unknown>): StrictModelDefinition<unknown> {
  const definition = definitions.get(model as object);
  if (definition === undefined) {
    throw new Error(`No strict-model definition is registered for ${model.name}`);
  }

  return definition;
}

function validateSchema(
  schema: StrictFieldSchema,
  input: unknown,
  location: readonly LocationPart[],
): ValidationResult<unknown> {
  switch (schema.kind) {
    case "float":
      if (typeof input !== "number") {
        return {
          errors: [error(location, "float_type", "Input should be a valid number", input)],
        };
      }
      if (!Number.isFinite(input)) {
        return {
          errors: [error(location, "finite_number", "Input should be a finite number", input)],
        };
      }
      if (schema.greaterThan !== undefined && !(input > schema.greaterThan)) {
        return {
          errors: [
            error(location, "greater_than", `Input should be greater than ${schema.greaterThan}`, input),
          ],
        };
      }
      return { value: input, errors: [] };

    case "literal":
      if (!schema.values.some((value) => Object.is(value, input))) {
        return {
          errors: [
            error(
              location,
              "literal_error",
              `Input should be ${expectedLiterals(schema.values)}`,
              input,
            ),
          ],
        };
      }
      return { value: input, errors: [] };

    case "model":
      return validateDefinition(definitionOf(schema.model), input, location);

    case "list": {
      if (!Array.isArray(input)) {
        return {
          errors: [error(location, "list_type", "Input should be a valid list", input)],
        };
      }

      // pydantic-core validates the items in order and counts each one once it is validated, valid or not. The first
      // one past the maximum ends the list's validation: the length error alone is reported, in place of the errors
      // of the items before it, and names the length of the whole list.
      const values: unknown[] = [];
      const errors: ErrorDetail[] = [];
      for (let index = 0; index < input.length; index += 1) {
        const result = validateSchema(schema.item, input[index], [...location, index]);
        if (schema.maxLength !== undefined && index >= schema.maxLength) {
          const noun = schema.maxLength === 1 ? "item" : "items";
          return {
            errors: [
              error(
                location,
                "too_long",
                `List should have at most ${schema.maxLength} ${noun} after validation, not ${input.length}`,
                input,
              ),
            ],
          };
        }
        errors.push(...result.errors);
        if (result.errors.length === 0) {
          values.push(result.value);
        }
      }
      // The minimum is checked of the validated items: a list with an item that failed reports no length error.
      if (errors.length !== 0) {
        return { errors };
      }
      if (schema.minLength !== undefined && input.length < schema.minLength) {
        const noun = schema.minLength === 1 ? "item" : "items";
        return {
          errors: [
            error(
              location,
              "too_short",
              `List should have at least ${schema.minLength} ${noun} after validation, not ${input.length}`,
              input,
            ),
          ],
        };
      }

      return { value: values, errors: [] };
    }
  }
}

function validateDefinition<Model>(
  definition: StrictModelDefinition<Model>,
  input: unknown,
  location: readonly LocationPart[] = [],
): ValidationResult<Model> {
  if (!isDictionary(input)) {
    return {
      errors: [
        error(
          location,
          "model_type",
          `Input should be a valid dictionary or instance of ${definition.name}`,
          input,
        ),
      ],
    };
  }

  const output: Record<string, unknown> = {};
  const errors: ErrorDetail[] = [];
  const fieldNames = new Set(definition.fields.map((field) => field.name));
  for (const field of definition.fields) {
    if (!hasOwn(input, field.name)) {
      if (hasOwn(field, "defaultValue")) {
        output[field.name] = field.defaultValue;
      } else {
        errors.push(error([...location, field.name], "missing", "Field required", input));
      }
      continue;
    }

    const result = validateSchema(field.schema, input[field.name], [...location, field.name]);
    errors.push(...result.errors);
    if (result.errors.length === 0) {
      output[field.name] = result.value;
    }
  }
  for (const [name, value] of Object.entries(input)) {
    if (!fieldNames.has(name)) {
      errors.push(error([...location, name], "extra_forbidden", "Extra inputs are not permitted", value));
    }
  }
  if (errors.length !== 0) {
    return { errors };
  }

  const model = output as Model;
  const afterMessage = definition.after?.(model);
  if (afterMessage !== undefined) {
    return {
      errors: [error(location, "value_error", `Value error, ${afterMessage}`, input)],
    };
  }

  return { value: model, errors: [] };
}

function renderError(title: string, details: readonly ErrorDetail[]): string {
  const count = details.length;
  const heading = `${count} validation error${count === 1 ? "" : "s"} for ${title}`;
  const blocks = details.map((detail) => {
    const location = detail.location.length === 0 ? "" : `${detail.location.join(".")}\n`;
    return (
      `${location}  ${detail.message} [type=${detail.type}, input_value=${shownInput(detail.input)}, ` +
      `input_type=${actionPythonTypeName(detail.input)}]\n` +
      `    For further information visit https://errors.pydantic.dev/2.13/v/${detail.type}`
    );
  });

  return [heading, ...blocks].join("\n");
}

/** Defines one of PEAR's strict pydantic models from its ordered fields. */
export function defineStrictModel<Model>(
  definition: StrictModelDefinition<Model>,
): StrictModelClass<Model> {
  const model: StrictModelClass<Model> = {
    name: definition.name,
    modelValidate(value: unknown): Model {
      const result = validateDefinition(definition, value);
      if (result.errors.length !== 0) {
        throw new ValidationError(renderError(definition.name, result.errors));
      }

      return result.value as Model;
    },
    isInstance(value: unknown): value is Model {
      if (!isDictionary(value)) {
        return false;
      }
      if (definition.tag !== undefined) {
        return value.type === definition.tag;
      }

      const keys = Object.keys(value);
      return (
        keys.length === definition.fields.length &&
        definition.fields.every((field) => hasOwn(value, field.name))
      );
    },
  };
  definitions.set(model as object, definition as StrictModelDefinition<unknown>);

  return model;
}

/** The one quantity of a gripper. */
export interface GripperQuantity {
  width: number;
}

export const GripperQuantity = defineStrictModel<GripperQuantity>({
  name: "GripperQuantity",
  fields: [{ name: "width", schema: { kind: "float" } }],
});

/** A finite chunk of absolute joint targets. */
export interface JointPositions {
  type: "joint_positions";
  positions: number[][];
  rate_hz: number;
}

export const JointPositions = {
  forLayout(
    layout: JointLayout,
  ): StrictModelClass<JointPositions> & { readonly LAYOUT: JointLayout } {
    const row: StrictFieldSchema = {
      kind: "list",
      item: { kind: "float" },
      minLength: layout.vectorLength,
      maxLength: layout.vectorLength,
    };
    const model = defineStrictModel<JointPositions>({
      name: "JointPositions",
      tag: "joint_positions",
      adapterName: "function-after[check_gripper_range(), JointPositions]",
      fields: [
        {
          name: "type",
          schema: { kind: "literal", values: ["joint_positions"] },
          defaultValue: "joint_positions",
        },
        {
          name: "positions",
          schema: {
            kind: "list",
            item: row,
            minLength: 1,
            maxLength: SequenceOperation.MAX_ROWS,
          },
        },
        { name: "rate_hz", schema: { kind: "float", greaterThan: 0 } },
      ],
      after: (value) => {
        const outside = value.positions.some((rowValues) =>
          layout.gripperIndices.some((index) => {
            const target = rowValues[index] as number;
            return !(0 <= target && target <= 1);
          }),
        );
        return outside ? "Gripper targets must be within [0, 1]" : undefined;
      },
    }) as StrictModelClass<JointPositions> & { LAYOUT: JointLayout };
    Object.defineProperty(model, "LAYOUT", {
      value: layout,
      enumerable: true,
      writable: false,
      configurable: false,
    });

    return model;
  },
};

/** Validates a value through a pydantic discriminated union of action models. */
export class ActionAdapter<Action> {
  private readonly actionModels: readonly {
    model: StrictModelClass<unknown>;
    definition: StrictModelDefinition<unknown>;
  }[];
  private readonly title: string;

  constructor(...actionModels: StrictModelClass<unknown>[]) {
    this.actionModels = actionModels.map((model) => ({ model, definition: definitionOf(model) }));
    for (const { model, definition } of this.actionModels) {
      if (definition.tag === undefined) {
        throw new Error(`${model.name} has no type tag`);
      }
    }
    this.title = `tagged-union[${this.actionModels
      .map(({ definition }) => definition.adapterName ?? definition.name)
      .join(",")}]`;
  }

  validate(action: unknown): Action {
    if (!isDictionary(action)) {
      const details = [
        error(
          [],
          "model_attributes_type",
          "Input should be a valid dictionary or object to extract fields from",
          action,
        ),
      ];
      throw new ValidationError(renderError(this.title, details));
    }
    if (!hasOwn(action, "type")) {
      const details = [
        error([], "union_tag_not_found", "Unable to extract tag using discriminator 'type'", action),
      ];
      throw new ValidationError(renderError(this.title, details));
    }

    const tag = action.type;
    const selected = this.actionModels.find(({ definition }) => definition.tag === tag);
    if (selected === undefined) {
      const expected = this.actionModels.map(({ definition }) => `'${definition.tag}'`).join(", ");
      const shownTag = typeof tag === "string" ? tag : actionPythonRepr(tag);
      const message =
        `Input tag '${shownTag}' found using 'type' does not match any of the expected tags: ${expected}`;
      throw new ValidationError(
        renderError(this.title, [error([], "union_tag_invalid", message, action)]),
      );
    }

    const result = validateDefinition(selected.definition, action, [selected.definition.tag as string]);
    if (result.errors.length !== 0) {
      throw new ValidationError(renderError(this.title, result.errors));
    }

    return result.value as Action;
  }
}
