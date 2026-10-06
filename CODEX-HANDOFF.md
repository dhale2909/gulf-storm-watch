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

## Update, Oct 6 night: second review (STORM-REVIEW-2.md) applied

Codex's follow-up review was verified against the code and acted on. Its 20 added tests are in `test/check.test.mjs`;
17 now pass as ordinary regression tests, 3 stay marked TODO (the coastline-geometry proposals, R7/R8, below).
Four fixtures were adjusted to the fixes they test: the R6 outlook now carries an issuance line (the rule compares it
with the storm advisory), and the R10 worker fixtures use a push-service endpoint with 65/16-byte keys (the worker now
rejects anything else). The forced-interleaving cooldown test became a slow-read test, because the serialised worker
can no longer interleave two reads.

Fixed (no alert rule, threshold, channel or Google handling changed):
- R1: an undelivered alert is kept as public facts only (level, change lines, headline, Google summary text). The
  private body is rebuilt at send time; `PLAYS_JSON` text never reaches a file.
- R2: browser delivery reports per device; a failed device is retried, delivered devices are not re-sent, a retry only
  touches the channels that failed. Three attempts in all, then it gives up and the log says so. A new alert supersedes
  an undelivered one and the log records that (`superseded`).
- R3: an outlook with disturbance text outside a recognised heading, a formation-line count that does not match its
  entries, or no entries and no explicit all-clear is "unavailable", never quiet. A forecast advisory for another storm
  or advisory number, with an unreadable forecast line, or with no forecast lines and no ending wording is "unknown"
  (previous forecast carried), never an empty track.
- R4: NWS alerts are read, and pending retries run, even when both NHC sources fail; the full-outage path now goes
  through the normal build/diff/deliver flow with the NHC parts carried. Forecast-advisory health is its own source
  (`sources.forecast`), shown on the page.
- R5: null/blank/"n/a" numbers are missing, never zero; a storm record that cannot be read marks the storm list
  `incomplete (...)` instead of silently dropping the storm.
- R6 (the part that is not a proposal): an Invest listed in an outlook issued after a storm's advisory is still an
  Invest, so that storm is "another system"; an older outlook is just stale and the upgrade proceeds as before.
  When a different storm takes over from the tracked one, its Invest link, Google summary and landfall record are
  reset. Guidance files are chosen by the Invest NHC named, first.
- R7 (not the geography): the landfall occurrence is a record bound to the storm that made it, timestamped from the
  observation; the 48-hour hold runs from that and is never restarted by the same storm sitting inland.
- R9: one failed NOAA map layer no longer fails the map; the text-advisory track fallback runs for failed as well as
  empty layers; `bin` and forecast points are persisted so the map can be rebuilt during a storm-list outage; a map
  built while sources are down never replaces a storm map with "nothing to map"; maps carry storm/advisory identity;
  the page distinguishes "map could not be loaded" from "no system"; unknown-wind points are neutral.
- R10: the worker only registers real push-service endpoints (Apple, FCM, Mozilla, Windows) with correctly sized keys,
  caps request bodies, never follows redirects, times out sends, checks configuration before using the cooldown, and
  serialises test requests per device within an isolate. Test pushes use their own notification tag.
- R11: core sources get two bounded attempts; map, model guidance and Google share a fixed budget and are skipped when
  it runs out; the four NWS reads and the two NHC reads run in parallel.
- R12 (partial): right before sending, the check asks the repository whether another runner saved a newer reading
  while this one ran, and if so sends and saves nothing. This closes most of the double-send window; it is not a
  shared claim.

Page (storm stage): source names in the health banner; a one-line note that THREAT / "Landfall expected" is this
page's reading of the NHC track and not an official warning; the Landfall tile says "center estimated to cross the
coast about <hour>, read from the NHC track"; the eyebrow names the tracked system; one compact row when no state has
a watch or warning; an outlook entry shown during the storm stage is labelled "Earlier outlook, before advisories
began" and its odds lines and signature are stripped. The share card is unchanged.

Open, for the owner (not implemented):
- R7/R8 coastline geometry: observed landfall still uses the old rough boxes while the forecast crossing uses the
  COAST_N/COAST_W polyline; crossings interpolate toward an endpoint-specific coast value rather than intersecting
  segments; state comes from longitude bands while the town comes from a list (the Louisiana delta can read "MS, near
  Venice, LA"). One consistent geometry for all three is a change to alert inputs.
- R6 ambiguity: when the Invest is not tagged in the outlook and several new storms appear, the nearest is adopted
  with no distance limit.
- R12 full version: a shared pre-send claim between the GitHub and Mac runners.
- Design items not done: shorter hero, official/model map view split, map keeps zoom + Recenter, legend of visible
  layers only.
