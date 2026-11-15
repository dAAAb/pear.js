// Ports pear/deploy/station/gui/console/lease.py: ControlLease.
//
// time.monotonic() is the option `clock`, by default the machine's. `with self.lock` is nothing: a page has one
// thread, and no method here awaits. LEASE_S is read from the class itself.

import { monotonic, type Clock } from "../agent/clock";
import { ValueError } from "../python/errors";

/** The one browser tab that may command the robot, held for as long as its heartbeats arrive. */
export class ControlLease {
  /** A holder silent for longer loses control, and its running operation is paused, s. */
  static readonly LEASE_S = 3.0;

  /** The id of the tab that holds control; null while no tab does. */
  owner: string | null = null;
  /** When the holder's last heartbeat arrived, on the monotonic clock. */
  heartbeatAt = 0.0;

  private readonly clock: Clock;

  constructor(
    /** Whether an operation runs; then only the watchdog ends an expired lease. */
    readonly isBusy: () => boolean,
    options: { clock?: Clock } = {},
  ) {
    this.clock = options.clock ?? monotonic;
  }

  /** Gives control to ``clientId`` when nobody holds it or an idle holder went silent; returns whether
   * ``clientId`` holds it. */
  claim(clientId: string): boolean {
    // (PEAR: with self.lock; nothing is awaited here)
    if (this.owner === null || (this.isExpired() && !this.isBusy())) {
      this.owner = clientId;
      this.heartbeatAt = this.clock();
    }

    return this.heartbeat(clientId);
  }

  /** Renews the lease of ``clientId``; returns whether it holds control and its operation has not lost it. */
  heartbeat(clientId: string): boolean {
    // (PEAR: with self.lock; nothing is awaited here)
    if (this.owner !== clientId || (this.isExpired() && this.isBusy())) {
      return false;
    }
    this.heartbeatAt = this.clock();

    return true;
  }

  /** Refuses a command from a tab that does not hold control. */
  require(clientId: string): void {
    if (this.owner !== clientId || this.isExpired()) {
      throw new ValueError("This tab does not hold control. Reconnect to claim the idle workspace.");
    }
  }

  /** Returns the holder that went silent while an operation runs, whose operation is paused before control moves;
   * null while there is none. */
  lostOwner(): string | null {
    // (PEAR: with self.lock; nothing is awaited here)
    return this.owner !== null && this.isExpired() && this.isBusy() ? this.owner : null;
  }

  /** Frees the control ``clientId`` holds for the next tab that claims it. */
  release(clientId: string): void {
    // (PEAR: with self.lock; nothing is awaited here)
    if (this.owner === clientId) {
      this.owner = null;
    }
  }

  /** Whether the holder has been silent for longer than the lease. */
  isExpired(): boolean {
    return this.clock() - this.heartbeatAt > ControlLease.LEASE_S;
  }
}
