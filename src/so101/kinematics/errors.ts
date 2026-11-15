// Ports the error classes of pear/deploy/station/control/motion/kinematics.py.
//
// PEAR's station reports a refused action with the name of its error's class as the error's code
// (`UnreachablePoseError` selects the model's "out of reach" wording), so each class here carries the Python name.
// Python's built-in ValueError is the library's one class of that name (src/python/errors.ts), given here too
// because the kinematics raise it.

import { ValueError } from "../../python/errors";

export { ValueError };

/** Thrown when a requested pose fails the offline inverse kinematics; nothing was commanded. */
export class UnreachablePoseError extends ValueError {
  override readonly name: string = "UnreachablePoseError";
}
