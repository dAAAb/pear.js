// Ports pear/deploy/station/agent_loop/clients/health_checks.py: the last connection check of each model, which
// answers later polls until it is too old. (PEAR also writes a failed check to its log; nothing is logged here.)

import { monotonic, type Clock } from "../clock";
import { pythonErrorMessage } from "../exceptions";
import type { ModelClient } from "./client";
import { HealthStatus, type ModelHealth } from "./schemas";

/** The last connection check of each model, which answers later polls until it is too old. */
export class HealthChecks {
  /** A check answers the automatic polls for this long before a new client checks again, s. */
  static readonly MAX_AGE_S = 30.0;
  /** The result shown for a model no check has reached yet. */
  static readonly UNCHECKED_HEALTH: ModelHealth = { status: HealthStatus.UNCHECKED, message: "Connection not checked" };

  /** model id -> [when it was checked, result] */
  readonly results = new Map<string, [number, ModelHealth]>();
  private running: Promise<unknown> = Promise.resolve(); // settles once the one check that runs has ended
  private readonly clock: Clock;

  constructor(
    /** model id -> a client built only to check its connection */
    private readonly newClient: (model: string) => ModelClient,
    options: { clock?: Clock } = {},
  ) {
    this.clock = options.clock ?? monotonic;
  }

  /** Returns the last check of ``model``. */
  get(model: string): ModelHealth {
    return this.results.get(model)?.[1] ?? HealthChecks.UNCHECKED_HEALTH;
  }

  /** Checks ``model`` with a new client unless a recent check answers; a forced one reuses only a later check. */
  check(model: string, options: { isForced?: boolean } = {}): Promise<ModelHealth> {
    const askedAt = this.clock();
    // one check at a time, in the order they were asked for
    const result = this.running.then(() => this.checkNow(model, askedAt, options.isForced ?? false));
    this.running = result.catch(() => undefined);

    return result;
  }

  private async checkNow(model: string, askedAt: number, isForced: boolean): Promise<ModelHealth> {
    const lastCheck = this.results.get(model);
    if (lastCheck && (lastCheck[0] >= askedAt || (!isForced && askedAt - lastCheck[0] < HealthChecks.MAX_AGE_S))) {
      return lastCheck[1];
    }

    let client: ModelClient | null = null;
    let result: ModelHealth;
    try {
      try {
        client = this.newClient(model);
        result = await client.check();
      } catch (error) {
        result = { status: HealthStatus.OFFLINE, message: pythonErrorMessage(error) };
      }
    } finally {
      if (client) {
        await client.close();
      }
    }
    this.results.set(model, [this.clock(), result]);

    return result;
  }
}
