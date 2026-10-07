#!/bin/bash
# Gulf Storm Watch: backup check from this Mac. Install with: cp scripts/mac-run.sh ~/.gulf-storm-watch/run.sh
# launchd runs it at :35 and :13 every hour.
#   :35  always runs the check, so there is a check every half hour (GitHub runs at :05).
#   :13  runs it only if GitHub's :05 check has not landed (last check attempt 20+ minutes old).
# Remove with: launchctl bootout gui/$(id -u)/com.dhale.gulf-storm-watch && rm ~/Library/LaunchAgents/com.dhale.gulf-storm-watch.plist
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
DIR="${GSW_DIR:-$HOME/.gulf-storm-watch}"
cd "$DIR/repo" || exit 1
[ -f "$DIR/backup.log" ] && tail -n 400 "$DIR/backup.log" > "$DIR/backup.log.tmp" && mv "$DIR/backup.log.tmp" "$DIR/backup.log"
exec >>"$DIR/backup.log" 2>&1
echo "== $(date -u +%FT%TZ)"
# Every step has a time limit (macOS has no `timeout`): while one run is stuck, launchd skips this job's later slots.
limit() { local s=$1; shift; perl -e 'alarm shift; exec @ARGV or die "cannot run $ARGV[0]: $!\n"' "$s" "$@"; }

# Runner commits carry the runner's identity, never the owner's.
git config user.name gulf-storm-watch && git config user.email actions@users.noreply.github.com

# This clone is only written by this script. A reading kept locally while GitHub was unreachable is replayed on top of
# GitHub's copy; if it cannot replay cleanly (another runner saved since), GitHub's copy wins.
limit 90 git pull -q --rebase --autostash || { git rebase --abort 2>/dev/null; limit 60 git fetch -q && git reset -q --hard origin/main; } || { echo "cannot reach GitHub"; }

# GitHub's freshness is its last check attempt: updatedAt stays on the last fully fresh reading during an outage or hold.
age=$(node -e 'const s=require("./data/status.json");console.log(Math.round((Date.now()-new Date(s.lastAttemptAt||s.updatedAt))/60000))')
minute=$((10#$(date +%M)))
if [ -n "$FORCE" ] || { [ "$minute" -ge 33 ] && [ "$minute" -le 50 ]; }; then :
elif [ "${age:-999}" -lt 20 ]; then echo "last check ${age} min ago; GitHub is keeping up, nothing to do"; exit 0; fi
echo "last check ${age} min ago; running the check here"

set -a; . "$DIR/env"; set +a
[ -d node_modules ] || limit 300 npm ci --omit=dev --silent --no-audit --no-fund || echo "npm install failed; browser notifications may be skipped"
limit 300 node check.mjs || { echo "check failed or ran out of time"; exit 1; }
# Save the core reading first; the optional layers follow and are saved separately. save.sh reports what it did.
SAVE_SUFFIX=" (Mac backup) [skip ci]" bash scripts/save.sh data
limit 240 "$DIR/venv/bin/python" ecmwf_tracks.py || echo "European layer skipped"
# Redraw the share images too, so a new share is current even while GitHub is down.
{ limit 240 "$DIR/venv/bin/python" card_shot.py && bash scripts/save-cards.sh; } || echo "share images not published"
SAVE_SUFFIX=" (Mac backup) [skip ci]" bash scripts/save.sh data
