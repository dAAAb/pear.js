// PEAR's operator console (pear/deploy/station/gui/console), as far as it is ported: the task run, which runs a
// task's turns one after another around the turn loop's step, with the phases it shows and the kinds of a task's
// events (pear/deploy/station/records/task_events.py). A page gives a TaskRun its console (TaskConsole) and the
// place its records go (TaskRecords), sets its task and calls run(). The rest of the console is not ported
// (docs/progress/console.md).

export { idleFor, Phase, phaseOf, STOPPED_STATUSES } from "./phase";
export { TaskEventKind } from "./task_events";
export {
  OBSERVATION_RECORD,
  OUTPUT_RECORD,
  RECORD_URL,
  recordUrl,
  RESULT_RECORD,
  SESSION_NAME,
  TaskRun,
  turnRecordName,
} from "./task_run";
export type {
  ActiveTurn,
  ConsoleEvent,
  TaskConsole,
  TaskRecord,
  TaskRecords,
  TaskRobot,
  TaskRunOptions,
} from "./task_run";
