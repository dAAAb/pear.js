// Ports include/ruckig/error.hpp of Ruckig 0.15.3 (https://github.com/pantor/ruckig).
// Copyright (c) 2021 Lars Berscheid, MIT licence (see LICENSE in this folder).

/**
 * The base class for all exceptions. The Python module raises it (as `ruckig.RuckigError`) for an input it refuses
 * and for a calculation that fails; its message begins with a line break and "[ruckig] ", as the C++'s does.
 */
export class RuckigError extends Error {
  constructor(message: string) {
    super(`\n[ruckig] ${message}`);
    this.name = "RuckigError";
  }
}
