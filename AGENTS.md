# Working in mcp-horde

- `plugins/horde/servers/*.js` are generated bundles. Never edit them and never run `npm run bundle` in a task: they are rebuilt from `packages/*` after your work lands, and a task that changes them fails its scope check. A push that changes them needs a new version in `plugins/horde/.claude-plugin/plugin.json` and `packages/opencode/package.json` (kept equal), since `claude plugin update` compares only that string; the bundle check in ci refuses otherwise.
- Checks: `npm run typecheck`, `npm run lint` (Biome; `npm run format` fixes formatting), `npm test`. `./ci.sh` runs everything, including the bundle check.
- Match the surrounding code: its naming, its comment density (short comments on what is not obvious), no new dependencies without a reason.
- Commit messages are one plain sentence: no body, no trailers, no prefixes such as `feat:` or `verify:`.
