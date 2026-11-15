// Ports the error classes of pear/deploy/station/control/motion/kinematics.py.
//
// PEAR's station reports a refused action with the name of its error's class as the error's code
// (`UnreachablePoseError` selects the model's "out of reach" wording), so each class here carries the Python name.

/** Python's built-in ValueError: a value the station refuses; nothing was commanded. */
export class ValueError extends Error {
  override readonly name: string = "ValueError";
}

/** Thrown when a requested pose fails the offline inverse kinematics; nothing was commanded. */
export class UnreachablePoseError extends ValueError {
  override readonly name: string = "UnreachablePoseError";
}
