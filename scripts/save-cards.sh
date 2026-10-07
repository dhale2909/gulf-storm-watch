#!/bin/bash
# Publish the share images (card.png, card-x.png) on their own branch, "cards": a single commit, replaced each time,
# so the images never pile up in the repository's history. index.html's og:image and twitter:image point there.
# Usage: scripts/save-cards.sh   (FORCE=1 publishes images older than the latest reading, e.g. to seed the branch)
set -e
for f in card.png card-x.png; do
  [ -s "$f" ] || { echo "cards: $f missing; not published"; exit 1; }
  [ -n "$FORCE" ] || [ "$f" -nt data/status.json ] || { echo "cards: $f is older than the latest reading; not published"; exit 1; }
done
tree=$(printf '100644 blob %s\tcard.png\n100644 blob %s\tcard-x.png\n' "$(git hash-object -w card.png)" "$(git hash-object -w card-x.png)" | git mktree)
commit=$(git -c user.name=gulf-storm-watch -c user.email=actions@users.noreply.github.com commit-tree "$tree" -m "share images $(date -u +%Y-%m-%dT%H:%MZ)")
for attempt in 1 2 3; do
  git push -q -f origin "$commit:refs/heads/cards" && { echo "cards: published"; exit 0; }
  sleep 5
done
echo "cards: could not publish to GitHub"
exit 1
