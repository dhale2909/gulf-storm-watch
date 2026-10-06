#!/bin/bash
# Commit and push generated files from a check. Used by the GitHub workflow and the Mac backup.
# Usage: scripts/save.sh <paths...>   (env: SAVE_SUFFIX appended to the commit message)
# If another check saved a newer status while this one ran, this run's files are discarded rather than
# pushed over the newer state (both runners read the same sources; the later save would only be older data).
set -e
git config user.name >/dev/null 2>&1 || { git config user.name "gulf-storm-watch"; git config user.email "actions@users.noreply.github.com"; }
git add "$@" 2>/dev/null || true
git diff --cached --quiet && exit 0
git fetch -q origin main
if ! git diff --quiet HEAD origin/main -- data/status.json; then
  echo "a newer check was saved while this one ran; discarding this run's files"
  git reset -q HEAD -- . && git checkout -q -- "$@" 2>/dev/null || true
  exit 0
fi
git commit -q -m "check $(date -u +%Y-%m-%dT%H:%MZ)${SAVE_SUFFIX:-}"
for attempt in 1 2 3; do
  git push -q origin HEAD:main && exit 0
  git pull -q --rebase origin main || { git rebase --abort; sleep 5; }
done
echo "could not save to GitHub"
exit 1
