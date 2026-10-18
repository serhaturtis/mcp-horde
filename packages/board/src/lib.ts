/** Library entry point: what other horde packages use (opencode: trusted commands, task-bound spawns). */
export {
  type Attempt,
  Board,
  current,
  defaultStateRoot,
  LEASE_MS,
  type Lock,
  type Note,
  overlaps,
  type PlanInput,
  projectOf,
  type Report,
  type ReportCheck,
  type Status,
  type Task,
} from "./board.js"
export { cliArgv, isTrustedCommand, shellWords, WORKER_COMMANDS, workerCommand } from "./command.js"
export { renderBrief, renderNotes, renderSummary, renderTask } from "./render.js"
