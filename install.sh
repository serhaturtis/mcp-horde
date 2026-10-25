#!/usr/bin/env bash
# Installs the horde Claude Code plugin for every project (user scope). ./install.sh --help for the options.
set -euo pipefail

usage() {
  cat <<'EOF'
usage: ./install.sh [--github] [--default-model provider/model] [--dry-run]

Installs the horde plugin for Claude Code in every project (user scope).

  (no option)                     from this checkout: Claude Code reads the plugin in place, so a git pull updates it
  --github                        from github.com/serhaturtis/mcp-horde, no checkout needed:
                                  curl -fsSL https://raw.githubusercontent.com/serhaturtis/mcp-horde/master/install.sh | bash -s -- --github
                                  (later: claude plugin marketplace update mcp-horde && claude plugin update horde@mcp-horde, then restart Claude Code)
  --default-model provider/model  make that model the default worker in every repository, e.g. deepseek/deepseek-flash
                                  (written to $XDG_CONFIG_HOME/mcp-horde/horde.json, only if that file does not exist;
                                  a repository's own horde.json still wins)
  --dry-run                       print what would be done, change nothing

Running it again is safe: what is already in place is left as it is.
EOF
}

source= model= dry=
while (($#)); do
  case $1 in
    --github) source=serhaturtis/mcp-horde ;;
    --default-model)
      model=${2:-}
      shift
      ;;
    --dry-run) dry=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
run() {
  say "+ $*"
  [[ $dry ]] || "$@"
}
# The first JSON entry on stdin for which the JS expression `test(x)` holds, printed as `print(x)`.
json_find() { node -e 'const [t, p] = process.argv.slice(1); const x = JSON.parse(require("fs").readFileSync(0, "utf8")).find(new Function("x", `return ${t}`)); if (x) console.log(new Function("x", `return ${p}`)(x))' "$1" "$2"; }

# This checkout, unless --github or the script runs without one (curl | bash).
if [[ -z $source ]]; then
  here=$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" && pwd)
  [[ -f $here/.claude-plugin/marketplace.json ]] || fail "not in a checkout of mcp-horde: pass --github"
  source=$here
fi
[[ -z $model || $model =~ ^[^/[:space:]]+/[^[:space:]]+$ ]] || fail "--default-model needs provider/model, e.g. deepseek/deepseek-flash"

command -v claude > /dev/null || fail "Claude Code is not on PATH (https://claude.com/claude-code)"
command -v node > /dev/null && node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' ||
  fail "the horde's servers need Node.js 20 or later on PATH"
opencode=${HORDE_OPENCODE_BIN:-opencode}
if ! version=$("$opencode" --version 2> /dev/null) || [[ ! $version =~ (^|[^0-9.])v?2\. ]]; then
  say "warning: OpenCode 2 is not on PATH (${version:-not found}). Workers need it:"
  say "  npm i -g @opencode/cli@2.1.1    or    curl -fsSL https://opencode.ai/v2/install | bash"
  say "then give it a provider: opencode auth login"
fi

existing=$(claude plugin marketplace list --json | json_find 'x.name === "mcp-horde"' 'x.path ?? x.repo ?? x.url ?? "?"')
if [[ -z $existing ]]; then
  run claude plugin marketplace add "$source"
elif [[ $existing != "$source" ]]; then
  say "the mcp-horde marketplace already points at $existing; keeping it (claude plugin marketplace remove mcp-horde, then run this again, to switch)"
fi

if [[ -n $(claude plugin list --json | json_find 'x.id === "horde@mcp-horde" && x.scope === "user"' 'x.id') ]]; then
  say "horde@mcp-horde is already installed for every project"
else
  run claude plugin install horde@mcp-horde --scope user
fi
local=$(claude plugin list --json | json_find 'x.id === "horde@mcp-horde" && x.scope === "local"' 'x.projectPath ?? ""')
[[ -z $local ]] || say "note: $local also has a project-local install, which the user-scope one covers; claude plugin uninstall horde@mcp-horde --scope local there removes it"

if [[ $model ]]; then
  config=${XDG_CONFIG_HOME:-$HOME/.config}/mcp-horde/horde.json
  if [[ -e $config ]]; then
    say "kept $config as it is (its \"tiers\" are your default models)"
  else
    run mkdir -p "$(dirname "$config")"
    say "+ write $config: {\"tiers\": [\"$model\"]}"
    [[ $dry ]] || printf '{ "tiers": ["%s"] }\n' "$model" > "$config"
  fi
fi

say ""
say "Done${dry:+ (dry run: nothing changed)}. New Claude Code sessions have the horde; in a running one, /reload-plugins."
