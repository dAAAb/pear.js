// Ports pear/deploy/station/agent_loop/config.py: the models of a station's configuration, each with its client,
// the action format it answers in and how long it may take to answer a turn.
//
// PEAR reads them from a station's YAML files and names a client by its class path; here a model entry holds the
// client's class itself, and its arguments under pear.js's names (baseUrl, model, apiKey, ...). The shipped
// pear/configs/station.yaml gives no model; PEAR's example station offers one, a VLLMClient with a base URL and
// the served model's name, every other value the client's default (VLLMClient's static values).

import { ModelClient } from "./clients/client";
import { pythonStringRepr } from "./clients/python_repr";
import { isValueError, pythonErrorMessage, pythonErrorName, ValueError } from "./exceptions";
import type { ActionFormat } from "./robot";

/** A model client's class: made with the system prompt and its arguments, the time-out among them. */
export type ModelClientClass = new (systemPrompt: string, options: never) => ModelClient;

/** One model an operator may choose: what the page calls it, its client, the action format it answers in and how
 * long it may take to answer a turn. */
export class OfferedModel {
  /** The longest a model may be given to answer a turn, s. */
  static readonly MAX_TIMEOUT_S = 1800;

  /** What the page calls the model. */
  readonly label: string;
  /** The model's client: a class of ModelClient. */
  readonly clientClass: ModelClientClass;
  /** What a message calls the client's class (PEAR: its class path); by default the class's name. */
  readonly clientClassName: string;
  /** The client's arguments beside the system prompt and the time-out. */
  readonly client: Readonly<Record<string, unknown>>;
  /** The robot's action format the model answers in; null: the robot's first. */
  readonly actionFormat: string | null;
  /** How long the model may take to answer a turn, s. */
  readonly timeoutS: number;

  constructor(fields: {
    label: string;
    clientClass: ModelClientClass;
    clientClassName?: string;
    client: Readonly<Record<string, unknown>>;
    actionFormat?: string | null;
    timeoutS?: number;
  }) {
    this.label = fields.label;
    this.clientClass = fields.clientClass;
    this.clientClassName = fields.clientClassName ?? String((fields.clientClass as { name?: string } | null)?.name);
    this.client = fields.client;
    this.actionFormat = fields.actionFormat ?? null;
    this.timeoutS = fields.timeoutS ?? 300;
  }

  /** Throws unless the model, which the station calls ``name``, has a label, a time-out within bounds and a
   * client's class. */
  check(name: string): void {
    if (!this.label) {
      throw new ValueError(`Model ${name}: its label is empty`);
    }
    if (!(this.timeoutS > 0 && this.timeoutS <= OfferedModel.MAX_TIMEOUT_S)) {
      throw new ValueError(`Model ${name}: timeout_s must be above 0 and at most ${OfferedModel.MAX_TIMEOUT_S}`);
    }
    const clientClass: unknown = this.clientClass;
    if (!(typeof clientClass === "function" && clientClass.prototype instanceof ModelClient)) {
      throw new ValueError(
        `Model ${name}: client_class names ${this.clientClassName}, which is no model client's class`,
      );
    }
  }

  /** Returns a new client of the model, prompted with ``systemPrompt`` and given the model's time-out. */
  newClient(systemPrompt: string): ModelClient {
    return new this.clientClass(systemPrompt, { timeoutS: this.timeoutS, ...this.client } as never);
  }
}

/** The models of a station's configuration: those an operator chooses from, in the action formats of its robot,
 * and the one a task starts with. */
export class ModelsConfig<State = unknown, Action = unknown> {
  /** What the page calls the station's robot. */
  readonly robotTitle: string;
  /** The robot's action formats by name, the default first. */
  readonly actionFormats: Readonly<Record<string, ActionFormat<State, Action>>>;
  /** The model a task starts with, a key of models. */
  readonly defaultModel: string;
  /** The models an operator chooses from, under the station's own names. */
  readonly models: Readonly<Record<string, OfferedModel>>;

  constructor(fields: {
    robotTitle: string;
    actionFormats: Readonly<Record<string, ActionFormat<State, Action>>>;
    defaultModel: string;
    models: Readonly<Record<string, OfferedModel>>;
  }) {
    this.robotTitle = fields.robotTitle;
    this.actionFormats = fields.actionFormats;
    this.defaultModel = fields.defaultModel;
    this.models = fields.models;

    for (const [name, offeredModel] of Object.entries(this.models)) {
      offeredModel.check(name);
      try {
        // a client checks its own arguments as it is made; neither making nor closing it does any I/O
        void offeredModel.newClient("").close();
      } catch (error) {
        if (isValueError(error) || pythonErrorName(error) === "TypeError") {
          throw new ValueError(`Model ${name}: ${pythonErrorMessage(error)}`, { cause: error });
        }
        throw error;
      }
    }
    this.require(this.defaultModel);

    const formatNames = Object.keys(this.actionFormats);
    for (const [name, offeredModel] of Object.entries(this.models)) {
      if (offeredModel.actionFormat !== null && !formatNames.includes(offeredModel.actionFormat)) {
        throw new ValueError(
          `Model ${name}: ${this.robotTitle} has no format ${pythonStringRepr(offeredModel.actionFormat)}; ` +
            `use one of ${formatNames.join(", ")}`,
        );
      }
    }
  }

  /** Throws unless ``model`` is one of the models. */
  require(model: string): void {
    if (!Object.hasOwn(this.models, model)) {
      throw new ValueError(
        `Unknown or unavailable model ${pythonStringRepr(model)}; choose one of ${Object.keys(this.models).join(", ")}`,
      );
    }
  }

  /** Returns the action format ``model`` answers in: its own, or the robot's first. */
  actionFormat(model: string): ActionFormat<State, Action> {
    const names = Object.keys(this.actionFormats);

    return this.actionFormats[this.models[model]!.actionFormat || names[0]!]!;
  }
}
