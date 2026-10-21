---
name: remove
description: Remove the horde from a repository, the reverse of /horde:setup. Deletes its horde.json and delegation line, and everything the horde keeps for it (task board, worktrees, horde/* branches, check logs). Use when the user asks to remove, uninstall, deinit or reset the horde for a repository.
---

# Removing the horde from a repository

The horde keeps two kinds of things for a repository: what `/horde:setup` wrote into it (`horde.json`, perhaps a delegation line in `CLAUDE.md`), and its own state outside it (the task board, worktrees, `horde/*` branches, check logs and locks). This removes both, after the user confirms once. The plugin stays installed for other repositories.

The horde CLI is `servers/cli.js` in the plugin, two directories above this skill's base directory (shown above as "Base directory for this skill"). Run it with `node` from the repository's root. (A copy of this skill outside the plugin: use `plugins/horde/servers/cli.js` in the mcp-horde clone.)

1. **See what is there.** `node <plugin>/servers/cli.js remove` lists the horde's state for this repository and removes nothing. Also check for `horde.json` at the root and a line in `CLAUDE.md` that hands work to the horde.
2. **Ask once.** Show the user the list in a few lines. Name every `horde/*` branch that has commits not on the current branch: that work never landed and is lost with the branch. If the user wants it, land it or keep the branch before going on.
3. **Remove the state.** The same command with `--yes`.
4. **Remove the configuration.** `git rm horde.json`, delete the delegation line from `CLAUDE.md`, and commit them together ("Remove the horde from this repository"). If the user is resetting to run `/horde:setup` again, ask whether to keep `horde.json` as its starting point.
5. **Report** what was removed, in one short list.
