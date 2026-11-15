// PEAR's operator console (pear/deploy/station/gui/console), as far as it is ported: the console itself (the state
// the page shows, the events, the operator's stop, the one operation that runs at a time), the review of a Home
// plan, the lease of the one tab that commands the robot, and the task run, which runs a task's turns one after
// another around the turn loop's step, with the phases it shows and the kinds of a task's events
// (pear/deploy/station/records/task_events.py). A page makes a Console with the station's robot, its records and
// the parts that are not ported (ConsoleOptions), and launches console.taskRun.run on it. The operator's commands,
// the watchdog and the camera preview are not here yet (docs/progress/console.md).

export { Console, ConsoleWorker } from "./console";
export type {
  ConsoleAnnotations,
  ConsoleCommands,
  ConsoleEventRecord,
  ConsoleOptions,
  ConsolePreview,
  ConsoleRecordings,
  ConsoleRecords,
  ConsoleRobot,
  ConsoleSnapshot,
  ConsoleUploads,
  ConsoleWatchdog,
  Operation,
  StopReport,
} from "./console";
export { HomeReview, HomeStatus } from "./home_review";
export type { ReviewPlan } from "./home_review";
export { ControlLease } from "./lease";
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