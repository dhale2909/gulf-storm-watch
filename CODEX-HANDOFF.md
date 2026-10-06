# Daniel's Storm Page — handoff for review

Live site: https://dhale2909.github.io/gulf-storm-watch/  (repo: https://github.com/dhale2909/gulf-storm-watch)
Owner: Daniel Hale. Purpose: track ONE Gulf of Mexico tropical system (currently Invest 92L, Oct 2026) for the
AL/FL/MS/LA coast, publish a public page + share card, and push alerts only when the picture changes.
Built over two days with Claude Code; this file is the map of what exists so you can review it cold.

## What to do
1. Review for bugs and fragility, especially anything that could produce a FALSE "quiet" / missed alert.
   Two real incidents already happened: NHC changed its outlook wording ("near 100 percent", multi-paragraph
   entries) and the parser silently reported "no disturbance". A safety net now throws instead; look for
   other places where unexpected upstream formats could be misread as "nothing there".
2. Check the untested path: the hand-off from Invest stage to advisory stage (a storm appears in
   CurrentStorms.json, forecast advisory parsing, landfall logic, watches/warnings). It has only been exercised
   with hand-made fixtures, never on a live storm. The storm is expected to be upgraded within a day.
3. Design recommendations: page layout, map readability, the share card, the invite flow. Keep it dark, phone-first.
4. Ideas, but flag cost/complexity honestly. Do NOT change alert rules, thresholds, or notification channels
   without listing them as proposals; the owner decides those.

## Architecture (all static + two small services)
- `check.mjs` (Node 22, one dependency: web-push) — the hourly check. Fetches NHC outlook text, CurrentStorms.json,
  forecast advisory text (TCM), NWS alerts API, NOAA ArcGIS map layers, NHC ATCF model guidance (a-deck) and best
  track (b-deck), Google Weather Lab ensemble CSV. Computes alertLevel + changes vs prior `data/status.json`,
  writes `data/status.json`, `data/log.json`, `data/map.json`, sends alerts. Exports a few parsers for testing.
- `ecmwf_tracks.py` (Python, eccodes) — reads ECMWF open-data cyclone track BUFR (ENS + AIFS-ENS), picks the
  system by where tracks start (in the Gulf), writes `data/ecmwf.json` (member lines, median "typical path",
  25%/50% swath rectangles, per-state coast counts).
- `card_shot.py` (Playwright) — screenshots `index.html?card=1` to `card.png` (1200x900 share preview).
- `index.html` — the whole page (Leaflet map, layers, satellite panel, Get alerts dialog, card mode, share).
  Data is fetched from raw.githubusercontent.com first (fresh within ~5 min), falling back to the Pages copy.
- `sw.js`, `manifest.json`, icons — home-screen app + Web Push.
- `push/worker.js` — Cloudflare Worker + KV: stores push subscriptions; `/subscriptions` and `/prune` need the
  admin key (header `x-key`). The check fetches the list and sends with web-push (VAPID).
- `join/` — invite link with its own Open Graph card; redirects to `../?alerts=1` which auto-opens the dialog.
- `.github/workflows/watch.yml` — the check in GitHub Actions. Triggered hourly by an external timer
  (cron-job.org -> workflow_dispatch) because GitHub's own `schedule` proved unreliable. A `publish` job deploys
  Pages after each check. `pages.yml` deploys on code pushes.
- A Mac backup (not in repo): launchd runs the same check at :30 every hour and at :08 if the :00 check is late.
  Commits from it carry `[skip ci]`.

## Alert rules (owner-approved; do not change silently)
Levels: quiet / watch / threat / landfall (see `build()` in check.mjs). Alert on: level change; 7-day or 48-hour
formation odds crossing 40 or 60, or moving 20+ points since the last alert; a Gulf storm forming/entering/
dissipating; type or category change; tropical watch/warning posted or dropped for AL/FL/MS/LA; forecast landfall
state change or timing shift >= 12 h; Invest designation; NHC unreachable twice in a row. Smaller moves are logged
as "update". Channels: private ntfy topic (with business "play" text from a secret), public ntfy topic, browser push.

## Known weak points / open questions
- Geography is rough boxes (`inGulf`, `coastHit`, `coastState`); Florida west coast vs panhandle is crude.
- Landfall timing uses forecast points 12 h apart; "landfall within 24 h" and the 48 h hold are approximate.
- The "typical path" for Euro ensembles holds finished members at their last point; sanity-check the method.
- Google Weather Lab data use is under Google's experimental-data terms: only aggregate summaries are published.
- Pages publishing and GitHub runners stalled for hours once; the Mac backup exists for that reason.
- Everything in `data/` is regenerated hourly; `card.png` and `index.html` (og:image stamp) are committed hourly too.

## Running locally
    npm ci && node check.mjs            # needs env: NTFY_TOPIC, PUBLIC_NTFY_TOPIC, PLAYS_JSON, PAGE_URL,
                                        # PUSH_API, PUSH_ADMIN_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (all optional;
                                        # without them it just prints what it would send)
    FIXTURES=dir NOW=2026-10-08T15:00:00Z node check.mjs   # offline: reads two.html, storms.json, tcm-<id>.html,
                                        # alerts-<ST>.json, map-*.json, adeck-*, btk-*, google.csv from dir
    pip install eccodes && python ecmwf_tracks.py
    pip install playwright && playwright install chromium && python card_shot.py
Secrets are not in the repo (.env, .ntfy-topic are gitignored). Do not commit any.

## Update, Oct 6 evening (after the first review)
- All P1 findings from `STORM-REVIEW.md` were fixed; regression tests live in `test/check.test.mjs` (`npm test`, no network).
  Proposals P1, P3, P5, P7 were approved and built; P2 (coastline geometry) is deferred until after this storm; P4 declined; P6 wording only.
- The system was upgraded to Tropical Depression Nine (al092026) at 21:00Z. The Invest -> advisory hand-off ran live:
  alert delivered on all channels, identity carried (`status.tracked`), tiles switched to storm mode. NOAA's map layers
  lagged the first advisory by several minutes; `gatherMap` now falls back to the text advisory's track meanwhile.
- New since the review: stage-aware tiles, coastal alerts panel above the map, "Monitoring" label, mph wording,
  per-device "Send me a test" (Worker-sent push), one-tracked-system logic, landfall expected vs occurred.
- Please review now against a live storm: `data/status.json`, `data/map.json`, the card (`card.png`), and the page as
  rendered in advisory stage. Design opinions on the storm-stage layout and map are welcome; the owner wants to keep
  the share card as it is (default layers), and alert rules are unchanged.
