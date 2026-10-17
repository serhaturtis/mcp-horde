/**
 * Turn raw check output into a short, exact account of what failed, without a
 * model. One extractor per runner format; the runner is guessed from the
 * command and confirmed from the output. Counts are only reported when the
 * runner printed them, so they are always exact.
 */

export type Runner =
  | "tap"
  | "node-spec"
  | "jest"
  | "vitest"
  | "pytest"
  | "cargo-test"
  | "rustc"
  | "go"
  | "tsc"
  | "biome"
  | "eslint"
  | "ruff"
  | "mypy"
  | "generic"

export interface Failure {
  /** Test name, or the rule / error code for compilers and linters. */
  test?: string
  file?: string
  line?: number
  /** What went wrong, a few lines at most. */
  message: string
  /** First stack frame inside the project, when the runner printed a stack. */
  frame?: string
}

export interface Counts {
  failed: number
  passed?: number
  skipped?: number
}

export interface Extracted {
  runner: Runner
  failures: Failure[]
  counts?: Counts
}

const MESSAGE_LINES = 8
const MESSAGE_CHARS = 600

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "")
}

/** Frames from runtimes, test harnesses and dependencies, never the project's own code. */
const FOREIGN_FRAME = [
  /node_modules[\\/]/,
  /\bnode:/,
  /\(native\)|<anonymous>$/,
  /[\\/]rustc[\\/][0-9a-f]{8,}[\\/]/,
  /[\\/]library[\\/](std|core|alloc)[\\/]/,
  /[\\/]\.cargo[\\/]registry[\\/]/,
  /[\\/]src[\\/](runtime|testing|reflect)[\\/][^\\/]+\.go/,
  /[\\/]go[0-9.]*[\\/]src[\\/]/,
  /[\\/](site|dist)-packages[\\/]/,
  /[\\/]lib[\\/]python[0-9.]+[\\/]/,
]

function isProjectFrame(line: string) {
  return /[\\/][^\s:]+\.\w+:\d+/.test(line) || /^\.{0,2}[\w.-]+[\\/][^\s:]+:\d+/.test(line.trim()) || /\(\S+\.\w+:\d+:\d+\)/.test(line)
    ? !FOREIGN_FRAME.some((r) => r.test(line))
    : false
}

/** Forward slashes, and no file:// prefix (file:///D:/x on Windows becomes D:/x). */
function slashes(p: string): string {
  return p
    .replace(/file:\/\/\/(?=[A-Za-z]:)/g, "")
    .replace(/file:\/\//g, "")
    .replace(/\\/g, "/")
}

function clean(frame: string, cwd?: string): string {
  let f = slashes(frame.trim().replace(/^at\s+/, ""))
  if (cwd) f = f.split(`${slashes(cwd).replace(/\/+$/, "")}/`).join("")
  return f
}

function firstProjectFrame(lines: string[], cwd?: string): string | undefined {
  const hit = lines.find(isProjectFrame)
  return hit ? clean(hit, cwd) : undefined
}

function relative(file: string, cwd?: string) {
  const f = slashes(file)
  if (!cwd) return f
  const base = `${slashes(cwd).replace(/\/+$/, "")}/`
  // Windows paths compare case-insensitively.
  const starts = /^[A-Za-z]:/.test(base) ? f.toLowerCase().startsWith(base.toLowerCase()) : f.startsWith(base)
  return starts ? f.slice(base.length) : f
}

/** Collapse a message to a few meaningful lines. */
function message(lines: string[]): string {
  const kept: string[] = []
  for (const raw of lines) {
    const l = raw.trimEnd()
    if (!l.trim()) {
      if (kept.length && kept[kept.length - 1] !== "") kept.push("")
      continue
    }
    kept.push(l)
    if (kept.filter((x) => x).length >= MESSAGE_LINES) break
  }
  while (kept.length && !kept[kept.length - 1]) kept.pop()
  const text = dedent(kept).join("\n")
  return text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS - 1)}…` : text
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length)
  const min = indents.length ? Math.min(...indents) : 0
  return lines.map((l) => l.slice(min))
}

function num(s: string | undefined): number | undefined {
  return s === undefined ? undefined : Number(s)
}

// ------------------------------------------------------------------ guessing

/** The runner, from the command when it is explicit, else from the output's own markers. */
export function guessRunner(command: string, output: string): Runner {
  const c = command.toLowerCase()
  const o = output
  if (/\bvitest\b/.test(c) || (/ FAIL {1,2}\S.* > /.test(o) && /Test Files\s+\d/.test(o))) return "vitest"
  if (/\bjest\b/.test(c) || /^Tests:\s+\d+/m.test(o)) return "jest"
  if (/\bpytest\b|python[\d.]* -m pytest/.test(c) || /= (FAILURES|ERRORS) =|short test summary info/.test(o)) return "pytest"
  if (/\bcargo\s+(test|nextest)\b/.test(c) || /^test result: (ok|FAILED)\./m.test(o)) return "cargo-test"
  if (/\bgo\s+test\b/.test(c) || /^--- FAIL: /m.test(o)) return "go"
  if (/^TAP version \d+/m.test(o)) return "tap"
  if (/^ℹ (tests|pass|fail) \d+/m.test(o) || /^✖ failing tests:/m.test(o)) return "node-spec"
  if (/\bmypy\b/.test(c) || /^\S+:\d+:(\d+:)? error: .*\[[\w-]+\]$/m.test(o)) return "mypy"
  if (/\bruff\b/.test(c) || /^\s*--> \S+:\d+:\d+$/m.test(o)) return /^error\[E\d+\]/m.test(o) ? "rustc" : "ruff"
  if (/\b(cargo\s+(build|check|clippy)|rustc)\b/.test(c) || /^error(\[E\d+\])?: /m.test(o)) return "rustc"
  if (/\btsc\b/.test(c) || /error TS\d+:/.test(o)) return "tsc"
  if (/\bbiome\b/.test(c) || /^\S+:\d+:\d+ (lint|format|assist|parse)[/\s]/m.test(o)) return "biome"
  if (/\beslint\b/.test(c) || /^\s+\d+:\d+\s+(error|warning)\s+/m.test(o)) return "eslint"
  return "generic"
}

export function extract(output: string, command = "", cwd?: string): Extracted {
  const text = stripAnsi(output).replace(/\r\n/g, "\n")
  const runner = guessRunner(command, text)
  const r = EXTRACTORS[runner](text, cwd)
  // A runner-specific extractor that found nothing still gets the generic view.
  if (!r.failures.length && runner !== "generic" && !(r.counts && r.counts.failed === 0)) {
    return { runner, failures: generic(text, cwd).failures, counts: r.counts }
  }
  return { runner, ...r }
}

type Extractor = (text: string, cwd?: string) => Omit<Extracted, "runner">

// ------------------------------------------------------------------ TAP (node --test, tape, …)

function tap(text: string, cwd?: string): Omit<Extracted, "runner"> {
  const lines = text.split("\n")
  const failures: Failure[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^(\s*)not ok \d+ - (.*?)(\s+# (TODO|SKIP).*)?$/)
    if (!m || m[3]) continue
    const indent = m[1]!.length
    // YAML diagnostics block: "---" … "..." indented two more than the test line.
    const yaml: string[] = []
    if (lines[i + 1]?.trim() === "---") {
      for (let j = i + 2; j < lines.length && lines[j]!.trim() !== "..."; j++) yaml.push(lines[j]!.slice(indent + 2))
    }
    const field = (name: string): string | undefined => {
      const k = yaml.findIndex((l) => l.startsWith(`${name}:`))
      if (k < 0) return undefined
      const v = yaml[k]!.slice(name.length + 1).trim()
      if (v === "|-" || v === "|" || v === ">-") {
        const body: string[] = []
        for (let j = k + 1; j < yaml.length && (yaml[j]!.startsWith("  ") || !yaml[j]!.trim()); j++) body.push(yaml[j]!.slice(2))
        return body.join("\n")
      }
      return v.replace(/^'(.*)'$/s, "$1").replace(/''/g, "'")
    }
    if (field("type") === "suite" || field("failureType") === "subtestsFailed") continue
    const location = field("location")
    const loc = location?.match(/^(.*):(\d+):\d+$/)
    let error = field("error") ?? field("message") ?? "failed"
    let stack = (field("stack") ?? "").split("\n")
    // A test file that crashed before running (syntax error, bad import) only says
    // "test failed"; the real error is in the "#" comment lines just before it.
    if (error === "test failed" && field("exitCode") !== undefined) {
      const comments: string[] = []
      for (let j = i - 1; j >= 0 && /^\s*#/.test(lines[j]!); j--) {
        if (!/^\s*# Subtest:/.test(lines[j]!)) comments.unshift(lines[j]!.replace(/^\s*# ?/, ""))
      }
      const start = comments.findIndex((c) => /^(\w+(Error|Exception)\b|Error:|SyntaxError|TypeError)/.test(c.trim()))
      if (start >= 0) {
        const rest = comments.slice(start)
        const stackAt = rest.findIndex((c) => /^\s+at /.test(c))
        error = (stackAt >= 0 ? rest.slice(0, stackAt) : rest.slice(0, 3)).join("\n")
        stack = rest
      } else if (comments.length)
        error = comments
          .filter((c) => !/^Node\.js v/.test(c))
          .slice(-6)
          .join("\n")
    }
    const expected = field("expected")
    const actual = field("actual")
    const extra = expected !== undefined && actual !== undefined && !error.includes(String(actual)) ? [`expected: ${expected}`, `actual: ${actual}`] : []
    failures.push({
      test: m[2],
      file: loc ? relative(loc[1]!, cwd) : undefined,
      line: loc ? Number(loc[2]) : undefined,
      message: message([...error.split("\n"), ...extra]),
      frame: firstProjectFrame(stack, cwd),
    })
  }
  // Several TAP streams (e.g. one per workspace) each end with their own totals.
  const sum = (key: string) => {
    const all = [...text.matchAll(new RegExp(`^# ${key} (\\d+)$`, "gm"))].map((x) => Number(x[1]))
    return all.length ? all.reduce((a, b) => a + b, 0) : undefined
  }
  const failed = sum("fail")
  return { failures, counts: failed === undefined ? undefined : { failed, passed: sum("pass"), skipped: sum("skipped") } }
}

// ------------------------------------------------------------------ node --test spec reporter

function nodeSpec(text: string, cwd?: string): Omit<Extracted, "runner"> {
  const failures: Failure[] = []
  const start = text.indexOf("✖ failing tests:")
  const body = start >= 0 ? text.slice(start) : ""
  for (const block of body.split(/\n(?=test at )/).slice(1)) {
    const lines = block.split("\n")
    const at = lines[0]!.match(/^test at (.*):(\d+):\d+$/)
    const name = lines[1]?.match(/^✖ (.*?)(?: \([\d.]+m?s\))?$/)?.[1]
    const rest = lines.slice(2)
    const stackAt = rest.findIndex((l) => /^\s+at /.test(l))
    failures.push({
      test: name,
      file: at ? relative(at[1]!, cwd) : undefined,
      line: at ? Number(at[2]) : undefined,
      message: message(stackAt >= 0 ? rest.slice(0, stackAt) : rest),
      frame: firstProjectFrame(rest, cwd),
    })
  }
  const count = (k: string) => num(text.match(new RegExp(`^ℹ ${k} (\\d+)$`, "m"))?.[1])
  const failed = count("fail")
  return { failures, counts: failed === undefined ? undefined : { failed, passed: count("pass"), skipped: count("skipped") } }
}

// ------------------------------------------------------------------ jest

function jest(text: string, cwd?: string): Omit<Extracted, "runner"> {
  const failures: Failure[] = []
  const blocks = text.split(/\n(?= {2}● )/).slice(1)
  for (const block of blocks) {
    const lines = block.split("\n")
    const name = lines[0]!.replace(/^ {2}● /, "").trim()
    const rest = lines.slice(1)
    // The message ends where the code frame (" > 2 | …" / "   1 | …") or the stack begins.
    const end = rest.findIndex((l) => /^\s+(>\s*)?\d+ \|/.test(l) || /^\s+at /.test(l))
    const frameLine = rest.find((l) => /^\s+at /.test(l) && isProjectFrame(l))
    const loc = frameLine?.match(/\(?([^\s()]+):(\d+):\d+\)?\s*$/)
    failures.push({
      test: name.replace(/ › /g, " > "),
      file: loc ? relative(loc[1]!, cwd) : undefined,
      line: loc ? Number(loc[2]) : undefined,
      message: message(end >= 0 ? rest.slice(0, end) : rest.slice(0, MESSAGE_LINES)),
      frame: frameLine ? clean(frameLine, cwd) : undefined,
    })
  }
  const tests = text.match(/^Tests:\s+(.*)$/m)?.[1] ?? ""
  const part = (k: string) => num(tests.match(new RegExp(`(\\d+) ${k}`))?.[1])
  return { failures, counts: tests ? { failed: part("failed") ?? 0, passed: part("passed"), skipped: part("skipped") } : undefined }
}

// ------------------------------------------------------------------ vitest

function vitest(text: string, cwd?: string): Omit<Extracted, "runner"> {
  const failures: Failure[] = []
  const blocks = text.split(/\n(?= FAIL {1,2}\S)/).slice(1)
  for (const block of blocks) {
    const lines = block.split("\n")
    const head = lines[0]!.replace(/^ FAIL {1,2}/, "").trim()
    const [file, ...names] = head.split(" > ")
    const rest = lines.slice(1)
    const frameAt = rest.findIndex((l) => /^\s*❯ \S+:\d+:\d+/.test(l))
    const until = rest.findIndex((l) => /^⎯/.test(l))
    const msgLines = rest.slice(0, frameAt >= 0 ? frameAt : until >= 0 ? until : MESSAGE_LINES)
    const frame = frameAt >= 0 ? rest[frameAt]!.trim().replace(/^❯\s*/, "") : undefined
    const loc = frame?.match(/^(.*):(\d+):\d+$/)
    failures.push({
      test: names.join(" > ") || head,
      file: loc ? relative(loc[1]!, cwd) : file,
      line: loc ? Number(loc[2]) : undefined,
      message: message(msgLines),
      frame,
    })
  }
  const tests = text.match(/^\s+Tests\s+(.*)$/m)?.[1] ?? ""
  const part = (k: string) => num(tests.match(new RegExp(`(\\d+) ${k}`))?.[1])
  return { failures, counts: tests ? { failed: part("failed") ?? 0, passed: part("passed"), skipped: part("skipped") } : undefined }
}

// ------------------------------------------------------------------ pytest

function pytest(text: string, cwd?: string): Omit<Extracted, "runner"> {
  const failures: Failure[] = []
  const section = text.match(/=+ (?:FAILURES|ERRORS) =+\n([\s\S]*?)(?:\n=+ (?:short test summary info|warnings summary|\d+ (?:failed|passed|error))|$)/)
  if (section) {
    for (const block of section[1]!.split(/\n(?=_{3,} .+ _{3,}\n)/)) {
      const name = block.match(/^_{3,} (.+?) _{3,}/)?.[1]
      if (!name) continue
      const lines = block.split("\n")
      const errorLines = lines.filter((l) => /^E\s/.test(l)).map((l) => l.replace(/^E\s{1,3}/, ""))
      const loc = [...block.matchAll(/^(\S+\.py):(\d+): (\w+)$/gm)].pop()
      failures.push({
        test: name,
        file: loc ? relative(loc[1]!, cwd) : undefined,
        line: loc ? Number(loc[2]) : undefined,
        message: message(errorLines.length ? errorLines : lines.slice(1, MESSAGE_LINES)),
        frame: loc ? `${relative(loc[1]!, cwd)}:${loc[2]}` : undefined,
      })
    }
  }
  if (!failures.length) {
    // -q / -rf without the long section: the short summary is all there is.
    for (const m of text.matchAll(/^(FAILED|ERROR) (\S+?)(?:::(\S+))?(?: - (.*))?$/gm)) {
      failures.push({ test: m[3] ?? m[2], file: m[2]!.split("::")[0], message: m[4] ?? m[1]!.toLowerCase() })
    }
  }
  const summary = [...text.matchAll(/^=*\s*((?:\d+ (?:failed|passed|skipped|errors?|xfailed|xpassed|deselected|warnings?)(?:, )?)+) in [\d.]+s/gm)].pop()?.[1]
  const part = (k: string) => num(summary?.match(new RegExp(`(\\d+) ${k}`))?.[1])
  return {
    failures,
    counts: summary ? { failed: (part("failed") ?? 0) + (part("errors?") ?? 0), passed: part("passed"), skipped: part("skipped") } : undefined,
  }
}

// ------------------------------------------------------------------ cargo test / rustc

function cargoTest(text: string, cwd?: string): Omit<Extracted, "runner"> {
  const failures: Failure[] = []
  for (const m of text.matchAll(/^---- (\S+) stdout ----\n([\s\S]*?)(?=\n---- \S+ stdout ----|\nfailures:\n|(?![\s\S]))/gm)) {
    const lines = m[2]!.split("\n")
    const at = lines.findIndex((l) => /panicked at /.test(l))
    const loc = at >= 0 ? lines[at]!.match(/panicked at (\S+?):(\d+):\d+:?/) : null
    const after = at >= 0 ? lines.slice(at + 1) : lines
    const stop = after.findIndex((l) => /^(stack backtrace:|note: )/.test(l))
    failures.push({
      test: m[1],
      file: loc ? relative(loc[1]!, cwd) : undefined,
      line: loc ? Number(loc[2]) : undefined,
      message: message(stop >= 0 ? after.slice(0, stop) : after),
      frame: loc ? `${relative(loc[1]!, cwd)}:${loc[2]}` : undefined,
    })
  }
  // A compile error stops the run before any test: report it like a build.
  if (!failures.length && /^error(\[E\d+\])?: /m.test(text)) return rustc(text, cwd)
  const results = [...text.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/gm)]
  const total = (i: number) => results.reduce((a, r) => a + Number(r[i]), 0)
  return { failures, counts: results.length ? { failed: total(2), passed: total(1), skipped: total(3) } : undefined }
}

function rustc(text: string, cwd?: string): Omit<Extracted, "runner"> {
  const failures: Failure[] = []
  const lines = text.split("\n")
  lines.forEach((l, i) => {
    const m = l.match(/^error(?:\[(E\d+)\])?: (.*)$/)
    if (!m || /^(could not compile|aborting due to|test failed)/.test(m[2]!)) return
    const loc = lines.slice(i + 1, i + 4).find((x) => /^\s*--> /.test(x))
    const lm = loc?.match(/--> (\S+?):(\d+):\d+/)
    // The labelled source excerpt under the error says what was expected and found.
    const notes = lines
      .slice(i + 1, i + 12)
      .filter((x) => /^\s*(\||\d+ \|).*[-^]{2,}\s+\S/.test(x))
      .map((x) => x.replace(/^[\s\d|]*(?:[-^]{2,}\s+)+/, ""))
    failures.push({
      test: m[1],
      file: lm ? relative(lm[1]!, cwd) : undefined,
      line: lm ? Number(lm[2]) : undefined,
      message: message([m[2]!, ...notes]),
    })
  })
  return { failures, counts: { failed: failures.length } }
}

// ------------------------------------------------------------------ go test

function goTest(text: string, cwd?: string): Omit<Extracted, "runner"> {
  const failures: Failure[] = []
  const lines = text.split("\n")
  lines.forEach((l, i) => {
    const m = l.match(/^\s*--- FAIL: (\S+) \(/)
    if (!m) return
    const body: string[] = []
    for (let j = i + 1; j < lines.length && !/^\s*(--- (FAIL|PASS|SKIP)|=== RUN|FAIL\s|ok\s|PASS$|FAIL$)/.test(lines[j]!); j++) body.push(lines[j]!)
    const panic = body.findIndex((b) => /^panic: /.test(b))
    if (panic >= 0) {
      const frame = firstProjectFrame(body.slice(panic), cwd)?.replace(/ \+0x[0-9a-f]+$/, "")
      const loc = frame?.match(/(\S+\.go):(\d+)/)
      failures.push({
        test: m[1],
        file: loc ? relative(loc[1]!, cwd) : undefined,
        line: loc ? Number(loc[2]) : undefined,
        message: message([body[panic]!.replace(/ \[recovered\]$/, "")]),
        frame,
      })
      return
    }
    const loc = body.map((b) => b.match(/^\s+(\S+\.go):(\d+): (.*)$/)).find(Boolean)
    failures.push({
      test: m[1],
      file: loc?.[1],
      line: loc ? Number(loc[2]) : undefined,
      message: message(body.map((b) => b.replace(/^\s+\S+\.go:\d+: /, ""))),
    })
  })
  // Build failures print compiler diagnostics instead of test results.
  if (!failures.length) {
    for (const m of text.matchAll(/^(\S+\.go):(\d+):\d+: (.+)$/gm)) failures.push({ file: relative(m[1]!, cwd), line: Number(m[2]), message: m[3]! })
  }
  return { failures, counts: failures.length || /^ok\s/m.test(text) ? { failed: failures.length } : undefined }
}

// ------------------------------------------------------------------ type checkers and linters

function tsc(text: string, cwd?: string): Omit<Extracted, "runner"> {
  const failures: Failure[] = []
  // Plain: "a.ts(1,7): error TS2322: …"; pretty: "a.ts:1:7 - error TS2322: …"
  for (const m of text.matchAll(/^(.+?)(?:\((\d+),\d+\):|:(\d+):\d+ -) error (TS\d+): (.+)$/gm)) {
    failures.push({ test: m[4], file: relative(m[1]!, cwd), line: Number(m[2] ?? m[3]), message: m[5]! })
  }
  return { failures, counts: { failed: failures.length } }
}

function biome(text: string, cwd?: string): Omit<Extracted, "runner"> {
  const failures: Failure[] = []
  const lines = text.split("\n")
  lines.forEach((l, i) => {
    const m = l.match(/^(\S+):(\d+):\d+ ((?:lint|format|assist|parse)\S*)/)
    if (!m) return
    // "×" marks an error, "!" a warning, "i" information.
    const msg = lines.slice(i + 1, i + 4).find((x) => /^\s+[×✖!]\s/.test(x))
    if (!msg || /^\s+!\s/.test(msg)) return
    failures.push({ test: m[3], file: relative(m[1]!, cwd), line: Number(m[2]), message: msg.replace(/^\s+[×✖]\s+/, "") })
  })
  return { failures, counts: { failed: failures.length } }
}

function eslint(text: string, cwd?: string): Omit<Extracted, "runner"> {
  const failures: Failure[] = []
  let file: string | undefined
  for (const l of text.split("\n")) {
    if (/^\S/.test(l) && !/^✖/.test(l)) file = l.trim()
    const m = l.match(/^\s+(\d+):\d+\s+error\s+(.+?)\s{2,}(\S+)$/)
    if (m) failures.push({ test: m[3], file: file ? relative(file, cwd) : undefined, line: Number(m[1]), message: m[2]! })
  }
  return { failures, counts: { failed: failures.length } }
}

function ruff(text: string, cwd?: string): Omit<Extracted, "runner"> {
  const failures: Failure[] = []
  const lines = text.split("\n")
  // Concise format: "path:1:8: F401 [*] `os` imported but unused"
  for (const m of text.matchAll(/^(\S+?):(\d+):\d+: ([A-Z]+\d+) (?:\[\*\] )?(.+)$/gm)) {
    failures.push({ test: m[3], file: relative(m[1]!, cwd), line: Number(m[2]), message: m[4]! })
  }
  // Full format: "F401 [*] `os` imported but unused" then " --> path:1:8"
  lines.forEach((l, i) => {
    const m = l.match(/^([A-Z]+\d+)(?: \[\*\])? (.+)$/)
    const loc = lines[i + 1]?.match(/^\s*--> (\S+?):(\d+):\d+$/)
    if (m && loc) failures.push({ test: m[1], file: relative(loc[1]!, cwd), line: Number(loc[2]), message: m[2]! })
  })
  const found = num(text.match(/^Found (\d+) errors?\./m)?.[1])
  return { failures, counts: { failed: found ?? failures.length } }
}

function mypy(text: string, cwd?: string): Omit<Extracted, "runner"> {
  const failures: Failure[] = []
  for (const m of text.matchAll(/^(\S+?):(\d+):(?:\d+:)? error: (.+?)(?:\s+\[([\w-]+)\])?$/gm)) {
    failures.push({ test: m[4], file: relative(m[1]!, cwd), line: Number(m[2]), message: m[3]! })
  }
  const found = num(text.match(/^Found (\d+) errors? in/m)?.[1])
  return { failures, counts: { failed: found ?? failures.length } }
}

// ------------------------------------------------------------------ anything else

const GENERIC_MARKERS = /(\b(Error|Exception|FAIL(ED|URE)?|panic(ked)?|Traceback|fatal|Assertion\w*)\b|✖|×)/

function generic(text: string, cwd?: string): Omit<Extracted, "runner"> {
  const lines = text.split("\n")
  const failures: Failure[] = []
  for (let i = 0; i < lines.length && failures.length < 10; i++) {
    if (!GENERIC_MARKERS.test(lines[i]!)) continue
    const block = lines.slice(i, i + 6)
    failures.push({ message: message(block), frame: firstProjectFrame(lines.slice(i, i + 30), cwd) })
    i += 5
  }
  if (!failures.length) {
    const tail = lines.filter((l) => l.trim()).slice(-40)
    if (tail.length) failures.push({ message: tail.join("\n").slice(-MESSAGE_CHARS * 2) })
  }
  return { failures }
}

const EXTRACTORS: Record<Runner, Extractor> = {
  tap,
  "node-spec": nodeSpec,
  jest,
  vitest,
  pytest,
  "cargo-test": cargoTest,
  rustc,
  go: goTest,
  tsc,
  biome,
  eslint,
  ruff,
  mypy,
  generic,
}
