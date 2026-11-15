// Ports pear/deploy/station/exceptions.py.

import { RuntimeError } from "../python/errors";

/**
 * What the operator sets to pause an action: PEAR's `threading.Event`. An `AbortSignal` is one, so a page hands the
 * signal of its stop control's `AbortController`.
 */
export interface Cancellation {
  /** Whether the operator has paused: `threading.Event.is_set()`. */
  readonly aborted: boolean;
}

/** Raised when the operator revoked the running operation, which is then never a success that was executed. */
export class OperatorPaused extends RuntimeError {
  override readonly name: string = "OperatorPaused";

  /** Throws OperatorPaused once the operator has set `cancellation`. */
  static checkCancelled(cancellation: Cancellation | null | undefined): void {
    if (cancellation != null && cancellation.aborted) {
      throw new OperatorPaused("Operation interrupted by the operator");
    }
  }
}
