import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, test } from "node:test"
import { extract, guessRunner, stripAnsi } from "../src/extract.js"

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8")
const CWD = "/work/proj"

describe("extract: test runners (real output)", () => {
  test("node --test TAP: failing tests only, suites skipped, exact counts", () => {
    const r = extract(fixture("node-tap.txt"), "node --test", CWD)
    assert.equal(r.runner, "tap")
    assert.deepEqual(r.counts, { failed: 2, passed: 1, skipped: 1 })
    assert.equal(r.failures.length, 2)
    const [a, b] = r.failures
    assert.equal(a!.test, "adds numbers")
    assert.equal(a!.file, "math.test.mjs")
    assert.equal(a!.line, 3)
    assert.match(a!.message, /Expected values to be strictly equal:\n\n2 !== 3/)
    assert.equal(a!.frame, "TestContext.<anonymous> (math.test.mjs:3:37)")
    assert.equal(b!.test, "throws on bad input")
    assert.match(b!.message, /bad input: expected string/)
  })

  test("TAP suite-level failures are not double counted", () => {
    const nested = [
      "TAP version 13",
      "# Subtest: suite",
      "    # Subtest: inner",
      "    not ok 1 - inner",
      "      ---",
      "      type: 'test'",
      "      error: 'boom'",
      "      ...",
      "not ok 1 - suite",
      "  ---",
      "  type: 'suite'",
      "  failureType: 'subtestsFailed'",
      "  error: '1 subtest failed'",
      "  ...",
      "# pass 4",
      "# fail 1",
    ].join("\n")
    const r = extract(nested)
    assert.deepEqual(
      r.failures.map((f) => f.test),
      ["inner"],
    )
    assert.equal(r.counts?.failed, 1)
  })

  test("TAP: a test file that crashes on load reports the real error, not 'test failed'", () => {
    const r = extract(fixture("node-tap-load-error.txt"), "npm test", CWD)
    assert.equal(r.runner, "tap")
    assert.equal(r.counts?.failed, 1)
    assert.equal(r.failures[0]!.message, "Error: Cannot find module '/work/proj/test'")
  })

  test("node --test spec reporter", () => {
    const r = extract(fixture("node-spec.txt"), "node --test", CWD)
    assert.equal(r.runner, "node-spec")
    assert.deepEqual(r.counts, { failed: 2, passed: 1, skipped: 1 })
    assert.deepEqual(
      r.failures.map((f) => [f.test, f.file, f.line]),
      [
        ["adds numbers", "math.test.mjs", 3],
        ["throws on bad input", "math.test.mjs", 5],
      ],
    )
    assert.match(r.failures[0]!.message, /AssertionError \[ERR_ASSERTION\]: Expected values to be strictly equal:[\s\S]*2 !== 3/)
    assert.doesNotMatch(r.failures[0]!.message, /at TestContext/, "the stack is not part of the message")
    assert.equal(r.failures[1]!.frame, "TestContext.<anonymous> (math.test.mjs:5:43)")
  })

  test("jest", () => {
    const r = extract(fixture("jest.txt"), "npx jest", CWD)
    assert.equal(r.runner, "jest")
    assert.deepEqual(r.counts, { failed: 2, passed: 1, skipped: 1 })
    assert.deepEqual(
      r.failures.map((f) => [f.test, f.file, f.line]),
      [
        ["adds numbers", "math.test.js", 2],
        ["throws on bad input", "math.test.js", 4],
      ],
    )
    assert.match(r.failures[0]!.message, /expect\(received\)\.toBe\(expected\)[\s\S]*Expected: 3\nReceived: 2/)
    assert.doesNotMatch(r.failures[0]!.message, /\| test\(/, "the code frame is not part of the message")
  })

  test("vitest", () => {
    const r = extract(fixture("vitest.txt"), "npx vitest run", CWD)
    assert.equal(r.runner, "vitest")
    assert.deepEqual(r.counts, { failed: 2, passed: 1, skipped: 1 })
    assert.deepEqual(
      r.failures.map((f) => [f.test, f.file, f.line]),
      [
        ["adds numbers", "math.spec.mjs", 2],
        ["throws on bad input", "math.spec.mjs", 4],
      ],
    )
    assert.match(r.failures[0]!.message, /AssertionError: expected 2 to be 3/)
  })

  test("pytest, verbose and quiet", () => {
    for (const name of ["pytest.txt", "pytest-verbose.txt"]) {
      const r = extract(fixture(name), "pytest", CWD)
      assert.equal(r.runner, "pytest", name)
      assert.deepEqual(r.counts, { failed: 2, passed: 1, skipped: 1 }, name)
      assert.deepEqual(
        r.failures.map((f) => [f.test, f.file, f.line]),
        [
          ["test_add", "test_calc.py", 3],
          ["test_raises", "test_calc.py", 5],
        ],
        name,
      )
      assert.equal(r.failures[0]!.message, "assert 2 == 3\n +  where 2 = add(1, 1)")
      assert.equal(r.failures[1]!.message, "ValueError: boom: bad value")
    }
  })

  test("cargo test: panics with locations, totals across binaries", () => {
    const r = extract(fixture("cargo.txt"), "cargo test", CWD)
    assert.equal(r.runner, "cargo-test")
    assert.deepEqual(r.counts, { failed: 2, passed: 1, skipped: 1 })
    assert.deepEqual(
      r.failures.map((f) => [f.test, f.file, f.line]),
      [
        ["tests::adds", "src/lib.rs", 5],
        ["tests::panics", "src/lib.rs", 7],
      ],
    )
    assert.equal(r.failures[0]!.message, "assertion `left == right` failed\n  left: 2\n right: 3")
    assert.equal(r.failures[1]!.message, "boom: bad state")
  })

  test("cargo build: compiler errors with their labels", () => {
    const r = extract(fixture("cargo-build.txt"), "cargo build", CWD)
    assert.equal(r.runner, "rustc")
    assert.equal(r.failures.length, 1, "'could not compile' is not an extra error")
    assert.deepEqual([r.failures[0]!.test, r.failures[0]!.file, r.failures[0]!.line], ["E0308", "src/lib.rs", 10])
    assert.match(r.failures[0]!.message, /^mismatched types\nexpected `i32`, found `&str`/)
  })

  test("go test: assertion failures and panics, project frame past the runtime", () => {
    const r = extract(fixture("go.txt"), "go test ./...", CWD)
    assert.equal(r.runner, "go")
    assert.equal(r.counts?.failed, 2)
    const [add, panic] = r.failures
    assert.deepEqual([add!.test, add!.file, add!.line, add!.message], ["TestAdd", "calc_test.go", 3, "Add(1, 1) = 2, want 3"])
    assert.equal(panic!.test, "TestPanic")
    assert.equal(panic!.message, "panic: assignment to entry in nil map")
    assert.equal(panic!.file, "calc_test.go")
    assert.equal(panic!.line, 5)
  })
})

describe("extract: compilers and linters (real output)", () => {
  test("tsc", () => {
    const r = extract(fixture("tsc.txt"), "tsc --noEmit", CWD)
    assert.equal(r.runner, "tsc")
    assert.deepEqual(r.counts, { failed: 3 })
    assert.deepEqual(r.failures[1], { test: "TS2339", file: "a.ts", line: 1, message: "Property 'nope' does not exist on type 'string'." })
  })

  test("biome: errors only", () => {
    const r = extract(fixture("biome.txt"), "biome check .", CWD)
    assert.equal(r.runner, "biome")
    assert.deepEqual(
      r.failures.map((f) => [f.test, f.file, f.line, f.message]),
      [
        ["lint/suspicious/noDoubleEquals", "x.js", 1, "Using == may be unsafe if you are relying on type coercion."],
        ["lint/suspicious/noDebugger", "x.js", 1, "This is an unexpected use of the debugger statement."],
      ],
    )
  })

  test("eslint", () => {
    const r = extract(fixture("eslint.txt"), "eslint .", CWD)
    assert.equal(r.runner, "eslint")
    assert.deepEqual(r.failures, [{ test: "no-debugger", file: "x.js", line: 1, message: "Unexpected 'debugger' statement" }])
  })

  test("ruff, including colour it should not have printed", () => {
    const raw = fixture("ruff.txt")
    assert.notEqual(stripAnsi(raw), raw, "the fixture really contains ANSI codes")
    const r = extract(raw, "ruff check .", CWD)
    assert.equal(r.runner, "ruff")
    assert.equal(r.counts?.failed, 3)
    assert.deepEqual(
      r.failures.map((f) => [f.test, f.line]),
      [
        ["I001", 1],
        ["F401", 1],
        ["F841", 3],
      ],
    )
    assert.equal(r.failures[1]!.message, "`os` imported but unused")
  })

  test("mypy", () => {
    const r = extract(fixture("mypy.txt"), "mypy .", CWD)
    assert.equal(r.runner, "mypy")
    assert.deepEqual(r.failures, [{ test: "return-value", file: "typed.py", line: 2, message: 'Incompatible return value type (got "int", expected "str")' }])
    assert.equal(r.counts?.failed, 1)
  })
})

describe("extract: Windows paths", () => {
  test("backslashes and file:///D:/ URLs are made relative like POSIX paths", () => {
    const tapOut = [
      "TAP version 13",
      "not ok 1 - adds",
      "  ---",
      "  type: 'test'",
      "  location: 'D:\\a\\proj\\test\\math.test.mjs:3:1'",
      "  error: 'nope'",
      "  stack: |-",
      "    TestContext.<anonymous> (file:///D:/a/proj/test/math.test.mjs:3:37)",
      "  ...",
      "# pass 0",
      "# fail 1",
    ].join("\n")
    const r = extract(tapOut, "node --test", "D:\\a\\proj")
    assert.equal(r.failures[0]!.file, "test/math.test.mjs")
    assert.equal(r.failures[0]!.frame, "TestContext.<anonymous> (test/math.test.mjs:3:37)")
  })
})

describe("extract: guessing and fallback", () => {
  test("the command decides when it is explicit, the output otherwise", () => {
    assert.equal(guessRunner("npm test", fixture("node-tap.txt")), "tap")
    assert.equal(guessRunner("npm test", fixture("jest.txt")), "jest")
    assert.equal(guessRunner("make check", fixture("pytest.txt")), "pytest")
    assert.equal(guessRunner("./run-tests.sh", "all good"), "generic")
  })

  test("unknown tools still get a useful excerpt", () => {
    const out = ["building…", "step 1 ok", "Error: config file missing: app.toml", "    at load (/work/proj/src/config.js:10:5)", "done"].join("\n")
    const r = extract(out, "./build.sh", CWD)
    assert.equal(r.runner, "generic")
    assert.match(r.failures[0]!.message, /^Error: config file missing: app\.toml/)
    assert.equal(r.failures[0]!.frame, "load (src/config.js:10:5)")
    const silent = extract("line 1\nline 2\nexit 1", "./x.sh")
    assert.match(silent.failures[0]!.message, /line 2\nexit 1$/, "falls back to the tail")
  })
})
