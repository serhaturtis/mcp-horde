// How many test files to run at once: the opencode suite starts a real `opencode serve` per file,
// so on a machine already busy with other work five at a time starve each other's startup and
// trip the fixed request deadlines. Spare cores decide: (cores - 1-minute load) / 2, at least 1,
// at most 5, or HORDE_TEST_CONCURRENCY when set. Printed as a bare number for --test-concurrency.
import os from "node:os"

const forced = Number(process.env.HORDE_TEST_CONCURRENCY)
if (Number.isInteger(forced) && forced > 0) {
  console.log(forced)
} else {
  const spare = os.cpus().length - os.loadavg()[0]
  console.log(Math.max(1, Math.min(5, Math.floor(spare / 2))))
}
