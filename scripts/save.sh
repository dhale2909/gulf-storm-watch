#!/bin/bash
# Commit and push generated files from a check. Used by the GitHub workflow and the Mac backup.
# Usage: scripts/save.sh <paths...>   (env: SAVE_SUFFIX appended to the commit message)
# If another check saved a newer status while this one ran, this run's files are discarded rather than
# pushed over the newer state (both runners read the same sources; the later save would only be older data).
# Prints what it did ("save: saved", "save: nothing new", ...), so a caller's log never claims a save that did not happen.
set -e
git config user.name >/dev/null 2>&1 || { git config user.name "gulf-storm-watch"; git config user.email "actions@users.noreply.github.com"; }
# Stage each path on its own: one missing or ignored path must not leave the others unstaged.
for p in "$@"; do git add -- "$p" 2>/dev/null || echo "save: nothing to stage for $p"; done
git diff --cached --quiet && { echo "save: nothing new"; exit 0; }
msg="check $(date -u +%Y-%m-%dT%H:%MZ)${SAVE_SUFFIX:-}"
# GitHub unreachable: keep the reading as a local commit. The Mac's next pull --rebase replays it, instead of throwing
# away a reading whose alert may already have gone out (and then sending that alert again).
if ! git fetch -q origin main; then
  git commit -q -m "$msg"
  echo "save: GitHub unreachable; reading kept as a local commit"
  exit 1
fi
# Compare with where this checkout last matched GitHub (not HEAD: a reading kept locally earlier is this runner's own).
if ! git diff --quiet "$(git merge-base HEAD origin/main)" origin/main -- data/status.json; then
  echo "save: a newer check was saved while this one ran; discarding this run's files"
  git reset -q HEAD -- . && git checkout -q -- "$@" 2>/dev/null || true
  exit 0
fi
git commit -q -m "$msg"
for attempt in 1 2 3; do
  git push -q origin HEAD:main && { echo "save: saved"; exit 0; }
  git pull -q --rebase origin main || { git rebase --abort; sleep 5; }
done
echo "save: could not save to GitHub"
exit 1
