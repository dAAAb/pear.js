// Executing the one action a model asked for, as the page decides and words it, without the DOM: whether "Execute
// this action" is offered and why it is not, the action in words, and the warning of a large action. The page
// (main.ts) draws these and sends the action to the station; a test holds them to the rules without a browser.
//
// The rules: an action is executed only at the operator's press for that action, and only on the arm as the model
// saw it. So the answer must have been asked from the state of the station that still holds the arm, and no action
// (a step by hand, Home, the answer's own action) may have started since the ask read that state.

import { DECIMALS } from "../../src/protocol/types";
import type { Wording } from "./preflight_view";
import type { TextKey } from "./texts";

/** What this view reads of an action of the model's format: centimetres, radians, and the gripper's command. */
export interface ActionParts {
  readonly arm: { readonly x: number; readonly y: number; readonly z: number; readonly pitch: number; readonly roll: number };
  readonly gripper: { readonly width: number };
}

/** A translation along one axis is large above this, cm. */
export const LARGE_CM = 5;
/** A rotation is large above this, rad. */
export const LARGE_RAD = 0.5;

/** One part of an action that is large. */
export interface LargePart {
  readonly name: "x" | "y" | "z" | "pitch" | "roll";
  readonly value: number;
  readonly unit: "cm" | "rad";
}

const TRANSLATIONS = ["x", "y", "z"] as const;
const ROTATIONS = ["pitch", "roll"] as const;

/** Returns the parts of ``action`` that are large, in the order the model writes them: x, y or z over 5 cm, pitch
 * or roll over 0.5 rad, either way. A part that is no number at all counts as large. */
export function largeParts(action: ActionParts): LargePart[] {
  const parts: LargePart[] = [];
  for (const name of TRANSLATIONS) {
    if (!(Math.abs(action.arm[name]) <= LARGE_CM)) parts.push({ name, value: action.arm[name], unit: "cm" });
  }
  for (const name of ROTATIONS) {
    if (!(Math.abs(action.arm[name]) <= LARGE_RAD)) parts.push({ name, value: action.arm[name], unit: "rad" });
  }

  return parts;
}

/** A number with its sign, to the decimals the format writes. */
export function signed(value: number, decimals: number): string {
  return `${value < 0 ? "−" : "+"}${Math.abs(value).toFixed(decimals)}`;
}

/** Returns the action in words, as the panel of the ask says it under the answer. */
export function actionSentence(action: ActionParts, wording: Wording): string {
  const width = action.gripper.width;

  return wording.t("ask.sentence", {
    x: signed(action.arm.x, DECIMALS.x),
    y: signed(action.arm.y, DECIMALS.y),
    z: signed(action.arm.z, DECIMALS.z),
    pitch: signed(action.arm.pitch, DECIMALS.pitch),
    roll: signed(action.arm.roll, DECIMALS.roll),
    // PEAR's prompt: "gripper.width commands: +1=open, -1=close, 0=hold; magnitude sets neither gap nor force"
    gripper: wording.t(width > 0 ? "ask.gripper.open" : width < 0 ? "ask.gripper.close" : "ask.gripper.hold"),
    width: signed(width, DECIMALS.width),
  });
}

/** Returns the warning of a large action: which parts are large, and what PEAR checks and what it does not; null
 * when no part is large. */
export function largeWarning(action: ActionParts, wording: Wording): string | null {
  const parts = largeParts(action);
  if (parts.length === 0) return null;

  return wording.t("execute.large", {
    parts: wording.listed(
      parts.map((part) =>
        wording.t(part.unit === "cm" ? "execute.large.cm" : "execute.large.rad", {
          name: part.name,
          value: signed(part.value, DECIMALS[part.name]),
        }),
      ),
    ),
    cm: LARGE_CM,
    rad: LARGE_RAD,
  });
}

/** The row a first press shows on a real arm: the action in words once more, and the warning of a large one. */
export interface ExecuteRow {
  readonly ask: string;
  readonly warning: string | null;
}

export function executeRow(action: ActionParts, wording: Wording): ExecuteRow {
  return {
    ask: wording.t("execute.real.ask", { action: actionSentence(action, wording) }),
    warning: largeWarning(action, wording),
  };
}

/** Why "Execute this action" is not offered, as a text's key. */
export type ExecuteWhy = Extract<TextKey, `execute.why.${string}`>;

/** What the offer is decided on. */
export interface ExecuteFacts {
  /** Whether the last ask's answer ends in an action of the format. */
  readonly hasAction: boolean;
  /** Where that ask read the arm's state: this window's reading, or the station that held the arm. */
  readonly source: "window" | "station";
  /** Whether the station is enabled now. */
  readonly isEnabled: boolean;
  /** Whether the station has held the arm without a break since the ask read its state. */
  readonly isSameHold: boolean;
  /** Whether an action (a step by hand, Home, the answer's own action) has started since the ask read the state. */
  readonly isSpent: boolean;
  /** Whether the station can take an action now: none under way, the Worker answers, the page is visible, and a
   * real arm's line is there. */
  readonly isIdle: boolean;
}

export interface ExecuteOffer {
  /** Whether the control is shown at all: only under an answer that ends in an action. */
  readonly isShown: boolean;
  readonly isOffered: boolean;
  /** Why it is not offered; null while it is offered, and while it is not shown. */
  readonly why: ExecuteWhy | null;
}

/** Decides whether the answer's action may be executed now: only by the station that held the arm when the model
 * was asked, enabled and idle, and with no action started since. */
export function executeOffer(facts: ExecuteFacts): ExecuteOffer {
  if (!facts.hasAction) return { isShown: false, isOffered: false, why: null };
  const why: ExecuteWhy | null =
    facts.source === "window"
      ? "execute.why.window"
      : !facts.isEnabled || !facts.isSameHold
        ? "execute.why.released"
        : facts.isSpent
          ? "execute.why.spent"
          : !facts.isIdle
            ? "execute.why.busy"
            : null;

  return { isShown: true, isOffered: why === null, why };
}
