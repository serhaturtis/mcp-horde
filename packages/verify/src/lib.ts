/** Library entry point: what other horde packages (opencode's gates) use. */
export { type AuditOptions, type AuditResult, audit, type Finding, globMatcher, isTestPath } from "./audit.js"
export { AUDIT_CATEGORIES, type AuditCategory, type Check, type CheckKind, detectChecks, loadSettings, type VerifySettings } from "./detect.js"
export { type Counts, type Extracted, extract, type Failure, guessRunner, type Runner, stripAnsi } from "./extract.js"
export { defaultStateDir, type GateOptions, gate, render, type Verdict } from "./gate.js"
export { type CheckResult, logDirFor, logFileFor, runChecks } from "./run.js"
