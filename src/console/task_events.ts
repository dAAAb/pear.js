// Ports pear/deploy/station/records/task_events.py: TaskEventKind.
//
// TaskEvents, a task's event file, is not ported: it reads and writes a file, and a page has none.

/** The events of a task besides the agent loop's and the model clients', each by the name it has in the task's
 * events. */
export const TaskEventKind = {
  /** A task started: its record. */
  TASK: "task",
  /** The task ended. */
  TASK_END: "task_end",
  /** A model session of the task started. */
  SESSION: "session",
  /** A turn started: its attempt id, number and episode. */
  TURN_STARTED: "turn_started",
  /** The tokens of a request's context before its answer: no client reports it, a stored task's events may hold
   * it. */
  CAPACITY: "capacity",
  /** What the action did: its result. */
  EXECUTION: "execution",
  /** The turn ended without a result: the phase it ended in. */
  TURN_END: "turn_end",
} as const;
export type TaskEventKind = (typeof TaskEventKind)[keyof typeof TaskEventKind];
