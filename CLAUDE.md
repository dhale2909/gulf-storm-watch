# Daniel's Storm Page

A Gulf storm tracker for the Alabama / Florida / Mississippi / Louisiana coast. It checks NHC and NWS data every
30 minutes, publishes a page (https://dhale2909.github.io/gulf-storm-watch/) and sends alerts only when the picture
changes. This repository is public: never commit secrets, the private ntfy topic, or the owner's private alert text.

## How it runs

- `check.mjs`: one check. Core sources (NHC outlook, CurrentStorms.json, forecast advisory, forecast discussion, NWS
  alerts) get bounded retries; optional layers (NOAA map layers, ATCF model guidance, Google Weather Lab ensemble)
  share a time budget and are skipped, never waited for. Writes `data/status.json`, `data/map.json`, `data/log.json`.
- `ecmwf_tracks.py`: Euro ensemble (ECENS) and Euro AI ensemble (AIFS) tracks from ECMWF open data -> `data/ecmwf.json`.
  Runs after the check, so the check reads the previous Euro file.
- `card_shot.py`: screenshots `index.html?card=1` (card.png, 1200x900, Messages) and `?card=x` (card-x.png, 1200x628, X).
  `scripts/save-cards.sh` publishes both on the `cards` branch (one commit, replaced each run, so the images never pile
  up in main's history); og:image and twitter:image point there. The images are not tracked on main.
- `index.html`: the whole page (no build step). `sw.js`: push notifications. `push/worker.js`: Cloudflare Worker that
  stores browser-push subscriptions (deploy with `npx wrangler deploy` from `push/`).
- Runners: GitHub workflow `watch.yml`, started at :05 past each hour by cron-job.org; Mac backup (launchd
  `com.dhale.gulf-storm-watch` -> `~/.gulf-storm-watch/run.sh`, a copy of `scripts/mac-run.sh`) at :35, plus a :13
  catch-up if GitHub's last check attempt (`lastAttemptAt`) is 20+ minutes old. Mac commits are `[skip ci]`.
  `scripts/save.sh` commits data, discards a run if another runner saved newer data, and keeps a reading as a local
  commit when GitHub is unreachable (the next pull replays it). `updatedAt` is the last fully fresh reading.
- `pages.yml` runs `npm test` and deploys the site on every push to main.

## Commands

```bash
npm test                                   # regression suites (node:test + Python unittest, network mocked)
npm run stats                              # alert sign-ups and taps by day (reads .env)
FORCE=1 bash ~/.gulf-storm-watch/run.sh    # run a full check now from the Mac
cp scripts/mac-run.sh ~/.gulf-storm-watch/run.sh   # install the Mac runner after changing it
gh workflow run watch.yml --repo dhale2909/gulf-storm-watch   # run a check on GitHub (also redraws the card)
git fetch -q && git show origin/main:data/status.json          # what was actually saved
```

raw.githubusercontent.com caches files up to 5 minutes and ignores query strings, so check saved data with git, not
the raw URL. The page reads both the raw copy and the site copy and shows the newer one.

## Rules the owner has set

- **Alert rules, thresholds, notification channels, Google ensemble handling and coastline geometry are proposals.**
  Explain the change and get approval before implementing. Fix confirmed defects directly, with a regression test.
- Alert triggers (keep as is): level change; 7-day or 48-hour odds crossing 40/60 or moving 20+ points since the last
  alert; Invest designation; storm forms / enters / dissipates; type or category change; AL/FL/MS/LA tropical watch or
  warning posted, dropped or changed; forecast landfall state change or timing shift of 12+ hours; observed landfall;
  NHC unreachable twice (private channel only). Wind changes within a class and model-track changes never alert.
- Google Weather Lab data: only aggregate summaries are saved or published, with Google's citation (terms accepted
  by the owner). Raw member tracks never leave the run.
- NHC Key Messages, the forecaster's discussion and Daniel's Average are display only, never alert inputs.

## Design (settled; change only when asked)

- Share card: storm name once top left; current wind as a big block top right ("35" with "MPH" centered beneath);
  bold landfall line ("Landfall near X · about Day Time") with arrival strength beneath; small NHC advisory label
  bottom right. Keep the 4:3 card for Messages. Daniel's Average stays on the card.
- Map: no cone. Forecast points are wind-only pills in mph: black below hurricane strength, then Cat 1 deep yellow,
  Cat 2 orange, Cat 3 red, Cat 4 dark red, Cat 5 purple. Euro shading and individual member lines are off by default.
  Tropical storm and hurricane watches/warnings are faint county shading with thin borders (the counties the NWS alerts
  name, outlines from `geo/gulf-counties.json`); NHC's coastal line stays only, as a soft band, where no county is
  listed. Storm surge areas are not drawn.
  Layer choices are remembered per device.
- Daniel's Average: dashed aqua line (#2ee6d6) averaging NHC official, one track per consensus / ensemble-mean family,
  Google DeepMind and the two Euro typical paths, matched by valid time (see `danielsAverage` in check.mjs). Keep the
  time-matched method.
- Page order: header and tiles, storm map, coastal watches, NHC key messages, satellite, Gulf outlook, the storm,
  Google AI ensemble, check log, footer with the "Built by cmd" credit.
- Wording: winds in mph; landfall times rounded to the hour and called estimates; THREAT is the page's own reading,
  not an official warning.

## Working on it

- Before calling any visual change done, preview it and look at a screenshot of the page (phone width too) and of
  `?card=1`. A local preview server is in `.claude/serve.mjs` (launch config "storm-page"). To preview new data,
  dry-run `check.mjs` in a scratch copy of the folder, never in the repo's `data/`.
- After a page change that affects the card, run the workflow so the share image is redrawn.
- Keep dependencies minimal (web-push is the only npm dependency). Run `npm test` before pushing.
- `CODEX-HANDOFF.md` and the Codex review notes hold the history of past fixes and open proposals.
