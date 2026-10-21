#!/usr/bin/env bash
# A small repository with nothing the checks could be detected from (no package.json,
# pyproject.toml, go.mod, Cargo.toml or Makefile): horde_do refuses to start there.
set -euo pipefail
mkdir -p bin docs
cat > bin/greet.sh <<'SH'
#!/usr/bin/env bash
# greet.sh NAME: prints a greeting.
echo "Hello, ${1:-world}!"
SH
cat > bin/count.sh <<'SH'
#!/usr/bin/env bash
# count.sh FILE: prints the number of lines, words and characters in FILE.
wc -lwm < "$1" | awk '{ print "lines " $1 ", words " $2 ", chars " $3 }'
SH
cat > docs/usage.md <<'MD'
# Usage

- `bin/greet.sh NAME` prints a greeting.
- `bin/count.sh FILE` prints the line, word and character counts of FILE.
MD
chmod +x bin/*.sh
git init -q -b master
git add -A
git -c user.email=eval@example.com -c user.name=eval commit -qm "Two small scripts"
