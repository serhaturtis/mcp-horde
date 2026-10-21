---
error: true
---

no checks found in the repository, so nothing was started: a task's work is judged by the project's checks, and with none its gate can never pass.
The horde's setup skill (/horde:setup) writes horde.json for this repository: the checks CI runs, what a new worktree needs, the resources checks share.
By hand: horde.json at the repository root, e.g. {"verify": {"checks": {"test": "AUTH_PROVIDER=local go test -race ./...", "web": {"command": "npm test", "cwd": "web"}}}}; each command runs in a shell from the root (or its cwd). Commit it, then horde_do again; verify_detect shows what is found.
