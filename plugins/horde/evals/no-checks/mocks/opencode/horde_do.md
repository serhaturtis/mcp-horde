---
error: true
---

no checks found in the repository, so nothing was started: a task's work is judged by the project's checks, and with none its gate can never pass.
Add them to horde.json at the repository root, e.g. {"verify": {"checks": {"test": "AUTH_PROVIDER=local go test -race ./...", "web": {"command": "npm test", "cwd": "web"}}}}.
Each command runs in a shell from the repository root (or its cwd), so environment prefixes work. Then horde_do again; verify_detect shows what is found.
