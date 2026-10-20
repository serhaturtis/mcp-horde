#!/usr/bin/env bash
# Seeds a run's empty workspace with this repository at a fixed commit, so every case starts
# from the same tree whatever has happened on master since. claude plugin eval runs it, as you,
# only with --scaffold. The tree has no node_modules: the cases measure the decision to
# delegate, not the work.
set -euo pipefail
commit=7caae37275c68988fdc6828151307813c1787c6e
repo=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
git clone --quiet "$repo" .
git checkout --quiet -B master "$commit"
git remote remove origin
