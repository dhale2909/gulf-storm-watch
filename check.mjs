#!/usr/bin/env node
// Gulf Storm Watch: one check of NHC/NWS data for the Gulf system.
// Reads data/status.json (prior state), writes data/status.json + data/log.json,
// and pushes a notification through ntfy only when the picture changes.
//
// Env: NTFY_TOPIC (private push target), PUBLIC_NTFY_TOPIC (public feed: same changes, no play text), PLAYS_JSON (optional {"watch":"...",...} action text
// added to notifications), PAGE_URL (link opened from the notification),
// TEST_NOTIFY=1 (send a test push), FIXTURES=dir + NOW=iso (offline testing).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const UA = 'gulf-storm-watch (github.com/dhale2909/gulf-storm-watch)';
const FIX = process.env.FIXTURES;
const NOW = process.env.NOW ? new Date(process.env.NOW) : new Date();
const STATES = ['AL', 'FL', 'MS', 'LA'];
const LOG_MAX = 150;
const TROPICAL_EVENTS = /^(Tropical Storm|Hurricane|Storm Surge) (Watch|Warning)$/;
const TYPES = {
  TD: 'Tropical Depression', TS: 'Tropical Storm', HU: 'Hurricane',
  STD: 'Subtropical Depression', STS: 'Subtropical Storm', PTC: 'Potential Tropical Cyclone',
};

// ---------- fetching ----------

async function get(name, url, json = false) {
  if (FIX) {
    const t = await readFile(`${FIX}/${name}`, 'utf8');
    return json ? JSON.parse(t) : t;
  }
  let err;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: json ? 'application/geo+json, application/json' : 'text/html' },
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
      return json ? await r.json() : await r.text();
    } catch (e) { err = e; }
  }
  throw err;
}

async function getBuf(name, url) {
  if (FIX) return readFile(`${FIX}/${name}`);
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

const preText = (html) => {
  const m = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(html);
  return m ? m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/[ \t]+\n/g, '\n') : null;
};

// ---------- parsing ----------

// Tropical Weather Outlook -> the Gulf disturbance (highest 7-day odds if several), or null when the outlook
// verifiably has no Gulf entry. Throws when a Gulf entry exists but cannot be read, so a parse problem is treated
// as "data unavailable" (previous reading kept) and never as a quiet Gulf.
export function parseTWOAll(html) {
  const pre = preText(html);
  if (!pre || !/Tropical Weather Outlook/i.test(pre)) throw new Error('TWO text not found');
  const issued = (/^\d{3,4} (?:AM|PM) \w+ \w+ \w+ \d+ \d{4}$/m.exec(pre) || [''])[0];
  const pct = (str) => +String(str).replace(/near/i, '').trim(); // "near 0", "near 100", "70"
  let body = pre.replace(/^[\s\S]*?For the North Atlantic[^\n]*\n/i, '')
    // Storms with advisories are handled from CurrentStorms.json, not from the outlook's "Active Systems" paragraph.
    .replace(/^Active Systems:.*\n(?:.+\n)*\n?/im, '')
    // Formation lines can wrap ("near\n100 percent"); join their continuation lines.
    .replace(/^\* Formation chance[^\n]*(?:\n(?!\*|\s*$)[^\n]*)*/gim, (m) => m.replace(/\s+/g, ' '));
  // One entry per heading line ("Southwestern Gulf of America (AL92):", "1. Central Tropical Atlantic:").
  const entries = [];
  let cur = null;
  for (const line of body.split('\n')) {
    if (/^(?:\d+\.\s*)?[^*\n]{3,78}:\s*$/.test(line)) { cur = { head: line.trim(), lines: [] }; entries.push(cur); }
    else if (cur) cur.lines.push(line);
  }
  const GULF = /Gulf of (America|Mexico)|Bay of Campeche/i;
  const found = [];
  for (const e of entries) {
    const text = e.lines.join(' ').replace(/\s+/g, ' ').trim();
    if (!GULF.test(e.head + ' ' + text)) continue;
    const m48 = /\* Formation chance through 48 hours\.\.\.\w+\.\.\.(near \d+|\d+) percent\./i.exec(text);
    const m7 = /\* Formation chance through 7 days\.\.\.\w+\.\.\.(near \d+|\d+) percent\./i.exec(text);
    const p48 = m48 ? pct(m48[1]) : NaN, p7 = m7 ? pct(m7[1]) : NaN;
    if (!(p48 >= 0 && p48 <= 100 && p7 >= 0 && p7 <= 100)) throw new Error(`outlook entry "${e.head}" could not be read`);
    const inv = /\(AL(\d\d)\)/i.exec(e.head);
    const d = {
      area: e.head.replace(/^\d+\.\s*/, '').replace(/:$/, '').replace(/\s*\([^)]*\)$/, '').trim() || 'Gulf disturbance',
      text: text.replace(/\* Formation chance[^.]*percent\./gi, '').replace(/\s+/g, ' ').trim(),
      formation48: p48, formation7d: p7,
      source: `NHC outlook, ${issued}`,
      investHint: inv ? `Invest ${inv[1]}L` : null,
    };
    found.push(d);
  }
  return found.sort((a, b) => b.formation7d - a.formation7d);
}
export function parseTWO(html) { return parseTWOAll(html)[0] || null; }

// Forecast advisory -> [{t, lat, lonW}] forecast points.
export function parseTCM(html, issuanceISO) {
  const pre = preText(html);
  if (!pre || !/FORECAST\/ADVISORY|FORECAST VALID|REMNANTS|DISSIPAT/i.test(pre)) return null; // unreadable: unknown, not "no track"
  const base = new Date(issuanceISO);
  const pts = [];
  for (const m of pre.matchAll(/(?:FORECAST|OUTLOOK) VALID (\d{2})\/(\d{2})(\d{2})Z\s+(\d+\.\d)N\s+(\d+\.\d)W/g)) {
    let d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), +m[1], +m[2], +m[3]));
    if (d.getTime() < base.getTime() - 86400000) {
      d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, +m[1], +m[2], +m[3]));
    }
    pts.push({ t: d.toISOString(), lat: +m[4], lonW: +m[5] });
  }
  return pts;
}

// ---------- geography (deliberately rough boxes) ----------

const inGulf = (p) =>
  (p.lat >= 21.5 && p.lat <= 31 && p.lonW >= 81 && p.lonW <= 98) ||
  (p.lat >= 18 && p.lat < 21.5 && p.lonW >= 90 && p.lonW <= 98); // Bay of Campeche

// At or inland of the Louisiana-to-Florida Gulf coast.
const coastHit = (p) =>
  (p.lat >= 28.5 && p.lat <= 36 && p.lonW >= 82 && p.lonW <= 93.9) ||
  (p.lat >= 24.3 && p.lat < 28.5 && p.lonW >= 80.8 && p.lonW <= 83.3); // FL west coast / Keys

const coastState = (p) => (p.lonW > 89.5 ? 'LA' : p.lonW > 88.4 ? 'MS' : p.lonW > 87.5 ? 'AL' : 'FL');
// Observed landfall: the center is at or inland of the coastline (rough per-stretch latitudes; "about").
const ashore = (p) => coastHit(p) && (
  (p.lat >= 28.5 && p.lat >= (p.lonW > 89.5 ? 29.5 : p.lonW > 87.5 ? 30.3 : p.lonW > 84 ? 30.1 : 29.0)) ||
  (p.lat < 28.5 && p.lonW <= 82.0));

const category = (kt) => (kt >= 137 ? 5 : kt >= 113 ? 4 : kt >= 96 ? 3 : kt >= 83 ? 2 : kt >= 64 ? 1 : 0);
const compass = (deg) => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(deg / 22.5) % 16];
const fmtCT = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric' }) + ' CT';

// ---------- gather ----------

export async function gatherStorms(prior) {
  const feed = await get('storms.json', 'https://www.nhc.noaa.gov/CurrentStorms.json', true);
  if (!feed || !Array.isArray(feed.activeStorms)) throw new Error('CurrentStorms.json malformed');
  const prevById = new Map((prior?.storms || []).map((p) => [p.id, p]));
  const priorLandfallFor = (id) => (prior?.landfall && prior.storms?.[0]?.id === id ? prior.landfall : null);
  const out = [];
  for (const s of feed.activeStorms) {
    if (!/^al\d{6}$/i.test(s.id || '')) continue; // Atlantic basin only; never Pacific
    const prev = prevById.get(s.id);
    const lat = +s.latitudeNumeric, lon = +s.longitudeNumeric;
    const posOK = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    if (!posOK && !prev) { console.warn(`storm ${s.id}: no usable position; skipped`); continue; }
    const here = posOK ? { t: s.lastUpdate, lat, lonW: -lon } : null;
    // Forecast track: null means "could not get it this run", distinct from a storm with no coastal threat.
    let track = null;
    try {
      if (s.forecastAdvisory?.url) track = parseTCM(await get(`tcm-${s.id}.html`, s.forecastAdvisory.url), s.forecastAdvisory.issuance || s.lastUpdate);
    } catch (e) { console.warn(`forecast advisory for ${s.id} unavailable: ${e.message}`); }
    const forecastStale = track === null;
    const path = [...(here ? [here] : []), ...(track || [])];
    const relevant = path.some(inGulf) || path.some(coastHit) || (forecastStale && !!prev);
    if (!relevant) continue; // not a Gulf system
    const windsRaw = +s.intensity;
    const winds = Number.isFinite(windsRaw) && windsRaw >= 0 ? windsRaw : (prev?.winds ?? 0);
    const known = s.classification in TYPES;
    const type = known ? TYPES[s.classification] : (/^(PC|EX|LO|DB|WV|SD|SS)$/.test(s.classification || '') ? 'Post-Tropical Cyclone' : 'Tropical Cyclone');
    if (!known && type === 'Tropical Cyclone') console.warn(`storm ${s.id}: unknown classification "${s.classification}"; treated as tropical`);
    const hit = forecastStale ? null : path.find(coastHit) || null;
    const landfall = forecastStale ? priorLandfallFor(s.id) : hit && { state: coastState(hit), eta: hit.t };
    const loc = here ? `${here.lat.toFixed(1)}N ${here.lonW.toFixed(1)}W` + (inGulf(here) ? (here.lat < 22 && here.lonW >= 90 ? ', Bay of Campeche' : ', Gulf') : ', approaching the Gulf') : `${prev?.location || 'position unavailable'} (last known)`;
    out.push({
      id: s.id, bin: s.binNumber, name: `${type} ${s.name}`, type, winds,
      category: s.classification === 'HU' ? category(winds) : 0,
      tropical: known || type === 'Tropical Cyclone',
      location: loc,
      movement: Number.isFinite(+s.movementSpeed) && +s.movementSpeed > 0 ? `${compass(+s.movementDir)} at ${s.movementSpeed} kt` : 'Stationary',
      advisory: s.forecastAdvisory?.advNum ? `NHC advisory ${s.forecastAdvisory.advNum}` : '',
      landfall,
      ashore: here && ashore(here) ? { state: coastState(here), t: here.t } : null,
      pos: here ? { lat: here.lat, lonW: here.lonW } : prev?.pos || null,
      forecastStale,
      gulfRisk: forecastStale
        ? (prev?.gulfRisk ? `${prev.gulfRisk.replace(/ \(latest forecast advisory unavailable\)$/, '')} (latest forecast advisory unavailable)` : 'Forecast advisory unavailable')
        : hit ? `Forecast track reaches the ${coastState(hit)} coast around ${fmtCT(hit.t)} (approximate)`
        : track.length ? 'Forecast track stays off the AL/FL/MS/LA coast through the forecast period' : 'No forecast track in the latest advisory',
    });
  }
  return out.sort((a, b) => (a.landfall ? 0 : 1) - (b.landfall ? 0 : 1) || b.winds - a.winds);
}

export async function gatherAlerts(prior, gulfStorm) {
  const ww = { note: '', unavailable: [] };
  for (const st of STATES) {
    try {
      const j = await get(`alerts-${st}.json`, `https://api.weather.gov/alerts/active?area=${st}`, true);
      if (!j || !Array.isArray(j.features)) throw new Error('alerts feed malformed (no features array)');
      const events = [...new Set(j.features.map((f) => f.properties?.event).filter((e) => TROPICAL_EVENTS.test(e || '')))];
      // Florida also has an Atlantic coast; only count its alerts while a Gulf storm exists.
      if (!events.length || (st === 'FL' && !gulfStorm)) ww[st] = {};
      else ww[st] = { level: events.some((e) => /Warning$/.test(e)) ? 'warning' : 'watch', text: events.sort().join(', ') };
    } catch (e) {
      console.warn(`alerts for ${st} unavailable: ${e.message}`);
      ww[st] = prior?.watchesWarnings?.[st] || {}; // keep what we knew; never clear a warning on a failed read
      ww.unavailable.push(st);
    }
  }
  if (!ww.unavailable.length) delete ww.unavailable;
  return ww;
}

// Map layers from NOAA's tropical map service, as one GeoJSON collection tagged by role.
// Storm stage: cone, forecast track and points, past track, coastal watch/warning lines.
// Disturbance stage: NHC's 7-day development area, current location, and motion arrow.
const MAPSRV = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';

async function layer(id, name) {
  const j = await get(`map-${name}.json`, `${MAPSRV}/${id}/query?where=1%3D1&outFields=*&f=geojson&geometryPrecision=2`, true);
  if (!j || !Array.isArray(j.features)) throw new Error(`map layer ${name} malformed`);
  return j.features.filter((f) => f.geometry);
}

const flat = (c) => (typeof c[0] === 'number' ? [c] : c.flatMap(flat));
const touchesGulf = (f) => flat(f.geometry.coordinates).some(([lon, lat]) => inGulf({ lat, lonW: -lon }));
const feat = (f, role, props = {}) => ({ type: 'Feature', geometry: f.geometry, properties: { role, ...props } });

async function gatherMap(gulf, storm) {
  const features = [];
  if (storm && /^AT[1-5]$/.test(storm.bin || '')) {
    const base = 4 + 26 * (+storm.bin[2] - 1);
    const [pts, track, cone, ww, past] = await Promise.all([
      layer(base + 2, 'points'), layer(base + 3, 'track'), layer(base + 4, 'cone'), layer(base + 5, 'ww'), layer(base + 8, 'past'),
    ]);
    const adv = pts[0]?.properties.advisnum;
    past.forEach((f) => features.push(feat(f, 'past')));
    cone.forEach((f) => features.push(feat(f, 'cone')));
    track.forEach((f) => features.push(feat(f, 'track')));
    ww.filter((f) => f.properties.advisnum === adv).forEach((f) => features.push(feat(f, 'ww', { kind: f.properties.tcww })));
    pts.forEach((f) => features.push(feat(f, 'point', {
      label: `${f.properties.datelbl} ${f.properties.timezone || ''}`.trim(), wind: f.properties.maxwind,
      type: f.properties.tcdvlp, cat: f.properties.ssnum, now: f.properties.tau === 0,
    })));
    return { kind: 'storm', name: storm.name, source: `NHC advisory ${adv ?? ''}`.trim(), features };
  }
  if (gulf) {
    const [areas, pts, motion] = await Promise.all([layer(3, 'areas'), layer(2, 'origins'), layer(398, 'motion')]);
    const atl = (f) => /atl/i.test(f.properties.basin || '') && touchesGulf(f); // never Pacific areas
    areas.filter(atl).forEach((f) => features.push(feat(f, 'area', { prob7: f.properties.prob7day, risk: f.properties.risk7day })));
    motion.filter(atl).forEach((f) => features.push(feat(f, 'motion')));
    pts.filter(atl).forEach((f) => features.push(feat(f, 'origin', { prob7: f.properties.prob7day, prob2: f.properties.prob2day })));
    return { kind: 'outlook', name: gulf.area, source: gulf.source, features };
  }
  return { kind: 'none', name: '', source: '', features };
}

// Model guidance ("spaghetti") from NHC's public ATCF aid files. These are raw model runs,
// not a forecast: they are drawn under the official track and never drive alerts.
const ADECK = 'https://ftp.nhc.noaa.gov/atcf/aid_public/';
// Not track models: the official forecast (drawn separately), climatology/extrapolation, intensity-only aids.
const SKIP_TECH = /^(CARQ|WRNG|OFC.|XTRP|CLP5|DRCL|TCLP|TAB[DMS]|BAM[DMS]|NNI.|ICON|(DS|SH|LG|IV|RV|OC|RI|KS|KL|KD|KO).*)$/;
const MODEL_NAMES = [
  [/^AVN/, 'GFS (American)'], [/^GDM/, 'Google DeepMind AI'], [/^A[PC]\d\d$/, 'GEFS ensemble member'], [/^AEM/, 'GEFS ensemble mean'],
  [/^HFSA|^HFA/, 'HAFS-A hurricane model'], [/^HFSB|^HFB/, 'HAFS-B hurricane model'], [/^HWRF|^HWF/, 'HWRF hurricane model'], [/^HMON|^HMN/, 'HMON hurricane model'],
  [/^CMC/, 'Canadian'], [/^CEM/, 'Canadian ensemble mean'], [/^UK|^EGR/, 'UKMET (British)'], [/^NVG|^NGX/, 'NAVGEM (US Navy)'],
  [/^CTC/, 'COAMPS-TC (US Navy)'], [/^EMX|^ECM/, 'ECMWF (European)'], [/^EEM|^EMN/, 'European ensemble mean'],
  [/^TVC/, 'TVCN consensus'], [/^HCCA/, 'HCCA consensus'], [/^GFEX/, 'GFS/European consensus'],
];
const modelGroup = (t) => (/^GDM/.test(t) ? 'google' : /^A[PC]\d\d$/.test(t) ? 'ens' : /^(TVC.|HCCA|GFEX|AEM.|CEM.|EEM.|EMN.)$/.test(t) ? 'consensus' : 'model');
const cycleMs = (d) => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(8, 10));

export function parseAdeck(text) {
  const runs = new Map(); // tech -> Map(date -> Map(tau -> [lon, lat]))
  let origin = null, originDate = '';
  for (const line of text.split('\n')) {
    const c = line.split(',').map((x) => x.trim());
    if (c.length < 8 || !/^\d{10}$/.test(c[2])) continue;
    const [date, tech, tau] = [c[2], c[4], +c[5]];
    const la = /^(\d+)([NS])$/.exec(c[6]), lo = /^(\d+)([EW])$/.exec(c[7]);
    if (!la || !lo || (+la[1] === 0 && +lo[1] === 0)) continue;
    const lat = (+la[1] / 10) * (la[2] === 'S' ? -1 : 1), lon = (+lo[1] / 10) * (lo[2] === 'W' ? -1 : 1);
    if (tech === 'CARQ') { if (tau === 0 && date >= originDate) { originDate = date; origin = { lat, lonW: -lon }; } continue; }
    if (SKIP_TECH.test(tech) || tau < 0 || tau > 168) continue;
    if (!runs.has(tech)) runs.set(tech, new Map());
    const byDate = runs.get(tech);
    if (!byDate.has(date)) byDate.set(date, new Map());
    byDate.get(date).set(tau, [lon, lat]);
  }
  if (!runs.size) return null;
  // Per model: the newest run that has at least 3 points (a run can be filed with only its first point for a while).
  const latest = new Map();
  for (const [tech, byDate] of runs) {
    const date = [...byDate.keys()].filter((d) => byDate.get(d).size >= 3).sort().pop();
    if (date) latest.set(tech, { date, pts: byDate.get(date) });
  }
  if (!latest.size) return null;
  const init = [...latest.values()].map((t) => t.date).sort().pop();
  const tracks = [];
  for (const [tech, t] of latest) {
    if (cycleMs(init) - cycleMs(t.date) > 12 * 3600e3) continue; // stale run
    tracks.push({ tech, group: modelGroup(tech), name: (MODEL_NAMES.find(([re]) => re.test(tech)) || [0, tech])[1],
      coords: [...t.pts.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p) });
  }
  return { init, origin, tracks };
}

// Where the system has been: NHC's "best track" file, which starts when the Invest is designated
// (usually back-dated a day or so) and gains a position every 6 hours.
export function parseBestTrack(text) {
  const seen = new Map();
  for (const line of text.split('\n')) {
    const c = line.split(',').map((x) => x.trim());
    const la = /^(\d+)([NS])$/.exec(c[6] || ''), lo = /^(\d+)([EW])$/.exec(c[7] || '');
    if (!/^\d{10}$/.test(c[2] || '') || !la || !lo) continue;
    seen.set(c[2], { t: new Date(cycleMs(c[2])).toISOString(), lat: (+la[1] / 10) * (la[2] === 'S' ? -1 : 1), lon: (+lo[1] / 10) * (lo[2] === 'W' ? -1 : 1), wind: +c[8] || 0 });
  }
  return [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, p]) => p);
}

async function gatherHistory(file) {
  const pts = parseBestTrack(await get(`btk-${file}`, `https://ftp.nhc.noaa.gov/atcf/btk/b${file.slice(1).replace('.gz', '')}`));
  const features = pts.map((p, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { role: 'pastpt', t: p.t, wind: p.wind, now: i === pts.length - 1 } }));
  if (pts.length > 1) features.unshift({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts.map((p) => [p.lon, p.lat]) }, properties: { role: 'past' } });
  return { features, winds: pts.length ? pts[pts.length - 1].wind : null };
}

async function gatherModels(gulf, storm) {
  let files = [];
  if (storm) files = [`a${storm.id}.dat.gz`];
  else if (gulf) {
    // Before a storm is named, guidance is filed under an "Invest" number (AL90-AL99). Find a fresh one in the Gulf.
    const list = await get('adeck-list.html', ADECK);
    const re = new RegExp(`href="(aal9\\d${NOW.getUTCFullYear()}\\.dat\\.gz)">[^<]*</a>\\s+(\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d)`, 'g');
    files = [...list.matchAll(re)].filter((m) => NOW - new Date(m[2].replace(' ', 'T') + 'Z') < 36 * 3600e3).map((m) => m[1]);
  }
  for (const f of files) {
    const d = parseAdeck(gunzipSync(await getBuf(`adeck-${f}`, ADECK + f)).toString('latin1'));
    if (!d || !d.tracks.length || NOW - cycleMs(d.init) > 24 * 3600e3) continue;
    if (!storm && !(d.origin && inGulf(d.origin))) continue;
    const invest = storm ? null : `Invest ${f.slice(3, 5)}L`;
    // NHC's own past-track layer takes over once advisories start; before that, draw it from the best-track file.
    const history = storm ? { features: [], winds: null } : await gatherHistory(f).catch((e) => { console.warn(`past track unavailable: ${e.message}`); return { features: [], winds: null }; });
    const run = new Date(cycleMs(d.init)).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric' }) + ' CT';
    return {
      invest, winds: history.winds, history: history.features, label: `${d.tracks.length} model tracks, latest run ${run}`,
      features: d.tracks.map((t) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: t.coords }, properties: { role: 'model', tech: t.tech, name: t.name, group: t.group } })),
    };
  }
  return null;
}

// Google DeepMind Weather Lab 50-member ensemble. Used under Google's Real-Time Weather Forecasting
// Experimental Data Terms of Use (accepted by the owner): the raw tracks stay inside this run and only
// an aggregate summary (member counts, typical timing) is saved or published, with Google's citation.
const WEATHERLAB = 'https://deepmind.google.com/science/weatherlab/download/cyclones/FNV3/ensemble/paired/csv/';

export function summarizeGoogle(csv, ids, initISO) {
  const lines = csv.split('\n').filter((l) => l && !l.startsWith('#'));
  const head = lines.shift().split(',');
  const col = Object.fromEntries(['track_id', 'sample', 'valid_time', 'lat', 'lon', 'maximum_sustained_wind_speed_knots'].map((k) => [k, head.indexOf(k)]));
  if (Object.values(col).some((i) => i < 0)) throw new Error('Weather Lab CSV columns changed');
  const members = new Map();
  for (const l of lines) {
    const c = l.split(',');
    if (!ids.includes(c[col.track_id])) continue;
    let lon = +c[col.lon]; if (lon > 180) lon -= 360;
    const t = new Date(c[col.valid_time].replace(' ', 'T') + 'Z');
    if (!members.has(c[col.sample])) members.set(c[col.sample], []);
    members.get(c[col.sample]).push({ t, lat: +c[col.lat], lonW: -lon, wind: +c[col.maximum_sustained_wind_speed_knots] || 0 });
  }
  // Google's file can list a system with only its current position and no forecast (seen at the Invest stage).
  // A summary needs real forecast tracks: at least a day of points from most members.
  const total = members.size;
  for (const [k, pts] of members) if (pts.length < 5) members.delete(k);
  if (members.size < 10) return null;
  const coast = { LA: 0, MS: 0, AL: 0, FL: 0 }, etas = [], peaks = [];
  for (const pts of members.values()) {
    pts.sort((a, b) => a.t - b.t);
    const ahead = pts.filter((p) => p.t >= NOW.getTime() - 6 * 3600e3);
    const i = ahead.findIndex(coastHit);
    if (i >= 0) { coast[coastState(ahead[i])]++; etas.push(ahead[i].t.getTime()); }
    peaks.push(Math.max(0, ...(i >= 0 ? ahead.slice(0, i + 1) : ahead).map((p) => p.wind)));
  }
  const n = members.size, hits = etas.length;
  const median = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const hurricane = peaks.filter((w) => w >= 64).length, major = peaks.filter((w) => w >= 96).length;
  const eta = hits ? new Date(median(etas)).toISOString() : null;
  const byState = STATES.filter((s) => coast[s]).sort((a, b) => coast[b] - coast[a]).map((s) => `${s} ${coast[s]}`).join(', ');
  return {
    run: initISO, members: n, total, hits, coast, eta, hurricane, major, peakMedianKt: Math.round(median(peaks)),
    text: (n < total ? `${n} of ${total} ensemble members forecast a track so far. ` : '') +
      (hits ? `${hits} of ${n} bring the center to the Louisiana-to-Florida coast (${byState}), typically around ${fmtCT(eta)}.` : `None of the ${n} bring the center to the Louisiana-to-Florida coast.`) +
      ` ${hurricane} of ${n} reach hurricane strength${major ? ` (${major} major)` : ''}; typical peak ${Math.round(median(peaks))} kt.`,
  };
}

async function gatherGoogle(storm, invest) {
  const yr = NOW.getUTCFullYear();
  const ids = [storm && storm.id.toUpperCase(), invest && `AL${invest.replace(/\D/g, '')}${yr}`].filter(Boolean);
  if (!ids.length) return null;
  // Runs start every 6 hours and are posted several hours later; take the newest one available.
  for (let k = 0; k < 5; k++) {
    const init = new Date(Math.floor(NOW.getTime() / (6 * 3600e3) - k) * 6 * 3600e3);
    const stamp = init.toISOString().slice(0, 13).replace(/-/g, '_') + '_00';
    let csv;
    try { csv = await get('google.csv', `${WEATHERLAB}FNV3_${stamp}_paired.csv`); } catch (e) { if (FIX) throw e; continue; }
    return summarizeGoogle(csv, ids, init.toISOString());
  }
  return null;
}

// ---------- decide ----------

export function build(prior, gulf, storms, ww) {
  const storm = storms[0] || null;
  const anyAlert = STATES.some((s) => ww[s].level);
  const landfall = storm?.landfall || null;
  // Expected: the forecast puts the center on the coast within 24 hours. Occurred: the center has been observed
  // on or past the coastline; that starts the 48-hour "landfall" hold (an expectation alone does not).
  const imminent = !!(landfall && new Date(landfall.eta).getTime() - NOW.getTime() <= 24 * 3600e3);
  const priorOcc = prior?.internal?.landfallAt && NOW.getTime() - new Date(prior.internal.landfallAt).getTime() < 48 * 3600e3
    ? { state: prior.internal.landfallState, at: prior.internal.landfallAt } : null;
  const occurred = priorOcc || (storm?.ashore ? { state: storm.ashore.state, at: NOW.toISOString() } : null);
  const held = !!occurred;

  let alertLevel = 'quiet';
  if (gulf || storm) alertLevel = 'watch';
  if ((storm?.tropical && landfall) || anyAlert) alertLevel = 'threat';
  if (imminent || held) alertLevel = 'landfall';

  let headline;
  if (storm) {
    headline = (occurred ? `${storm.name} made landfall in ${occurred.state} around ${fmtCT(occurred.at)}. ` : '') +
      `${storm.name}: ${storm.winds} kt${storm.category ? ` (Category ${storm.category})` : ''}, ${storm.location}, moving ${storm.movement}. ${storm.gulfRisk}.`;
  } else if (held) {
    headline = `Made landfall in ${occurred.state} around ${fmtCT(occurred.at)}; the system is no longer an active NHC storm.`;
  } else if (gulf) {
    headline = `NHC gives the ${gulf.area} disturbance a ${gulf.formation7d}% chance of forming within 7 days (${gulf.formation48}% within 48 hours). No advisories or forecast track yet.`;
  } else {
    headline = 'No Gulf disturbance in the NHC outlook and no Gulf storm.';
  }
  if (anyAlert) headline += ` Tropical alerts in effect: ${STATES.filter((s) => ww[s].level).map((s) => `${s} (${ww[s].text})`).join('; ')}.`;
  const others = storms.slice(1).filter((o) => !o.other || true);
  if (others.length) headline += ` Also in the Gulf: ${others.map((o) => `${o.name} (${o.winds} kt; ${o.gulfRisk.toLowerCase()})`).join('; ')}.`;

  return {
    updatedAt: NOW.toISOString(), // time of the last successful reading (an outage keeps the old value; see lastAttemptAt)
    lastAttemptAt: NOW.toISOString(),
    nextCheck: new Date((Math.floor(NOW.getTime() / 1800e3) + 1) * 1800e3).toISOString(), // GitHub checks on the hour, the Mac backup on the half hour
    alertLevel, headline,
    gulf: gulf || { area: '', formation48: null, formation7d: null, source: 'NHC outlook', text: storm ? 'NHC is issuing advisories on this system; see the storm panel.' : '' },
    storms: storms.map(({ landfall: _l, tropical: _t, bin: _b, ashore: _a, ...s }) => s), // forecastStale and pos stay, so the page and diff can see it
    watchesWarnings: ww,
    landfall, // forecast landfall (expected)
    landfallOccurred: occurred,
    internal: {
      failCount: 0,
      baseline7d: prior?.internal?.baseline7d ?? gulf?.formation7d ?? null,
      baseline48: prior?.internal?.baseline48 ?? gulf?.formation48 ?? null,
      landfallAt: occurred?.at || null,
      landfallHoldUntil: occurred ? new Date(new Date(occurred.at).getTime() + 48 * 3600e3).toISOString() : null,
      landfallState: occurred?.state || (imminent ? landfall.state : null),
    },
  };
}

// What counts as a change worth a push. Wording-only outlook edits do not.
export function diff(prior, cur) {
  const ch = [];
  if (!prior) return ch;
  if (prior.alertLevel !== cur.alertLevel) ch.push(`Alert level ${prior.alertLevel.toUpperCase()} -> ${cur.alertLevel.toUpperCase()}`);

  const a = prior.gulf?.formation7d, b = cur.gulf?.formation7d, base = prior.internal?.baseline7d;
  if (a != null && b != null) {
    const crossed = (a < 40) !== (b < 40) || (a < 60) !== (b < 60);
    if (crossed || (base != null && Math.abs(b - base) >= 20)) ch.push(`7-day formation odds ${base != null && !crossed ? base : a}% -> ${b}%`);
  }

  // Same rule for the 48-hour number: crossing 40 or 60, or 20+ points since the last alert.
  const a8 = prior.gulf?.formation48, b8 = cur.gulf?.formation48, base8 = prior.internal?.baseline48;
  if (a8 != null && b8 != null) {
    const crossed = (a8 < 40) !== (b8 < 40) || (a8 < 60) !== (b8 < 60);
    if (crossed || (base8 != null && Math.abs(b8 - base8) >= 20)) ch.push(`48-hour formation odds ${base8 != null && !crossed ? base8 : a8}% -> ${b8}%`);
  }

  if (cur.gulf?.invest && cur.gulf.invest !== prior.gulf?.invest) ch.push(`NHC designated the system ${cur.gulf.invest}`);

  const ps = new Map((prior.storms || []).map((s) => [s.id, s]));
  const cs = new Map(cur.storms.map((s) => [s.id, s]));
  for (const [id, s] of cs) {
    const p = ps.get(id);
    if (!p) ch.push(`${s.name} is now a Gulf system (${s.winds} kt)`);
    else if (p.type !== s.type) ch.push(`${p.name} is now ${s.name}`);
    else if ((p.category || 0) !== (s.category || 0)) ch.push(`${s.name} is now Category ${s.category} (${s.winds} kt)`);
  }
  for (const [id, p] of ps) if (!cs.has(id)) ch.push(`${p.name} is no longer an active Gulf storm`);

  for (const st of STATES) {
    const px = prior.watchesWarnings?.[st] || {}, cx = cur.watchesWarnings[st] || {};
    const x = px.level || null, y = cx.level || null;
    if (x !== y) ch.push(y ? `${st}: tropical ${y} posted (${cx.text})` : `${st}: tropical ${x} dropped`);
    else if (y && (px.text || '') !== (cx.text || '')) ch.push(`${st}: alerts now ${cx.text} (was ${px.text})`);
  }

  for (const o of (cur.others || [])) {
    if (o.threat && !(prior.internal?.othersAlerted || []).includes(o.id)) ch.push(`Another Gulf system: ${o.name} ${o.detail}`);
  }

  if (cur.landfallOccurred && !prior.landfallOccurred) ch.push(`Landfall in ${cur.landfallOccurred.state} around ${fmtCT(cur.landfallOccurred.at)}`);

  const pl = prior.landfall, cl = cur.landfall;
  if (cl && !pl) ch.push(`Forecast track now reaches the ${cl.state} coast around ${fmtCT(cl.eta)}`);
  else if (pl && !cl && cur.storms.length && !cur.storms[0].forecastStale) ch.push('Forecast track no longer reaches the AL/FL/MS/LA coast');
  else if (pl && cl) {
    if (pl.state !== cl.state) ch.push(`Forecast landfall shifted ${pl.state} -> ${cl.state} (${fmtCT(cl.eta)})`);
    else if (Math.abs(new Date(pl.eta) - new Date(cl.eta)) >= 12 * 3600e3) ch.push(`Forecast ${cl.state} landfall timing moved to ${fmtCT(cl.eta)}`);
  }
  return ch;
}

// Smaller movements that are worth a line in the log but not a push.
function minorDiff(prior, cur) {
  const notes = [];
  if (!prior) return notes;
  const pg = prior.gulf || {}, cg = cur.gulf || {};
  if (pg.formation7d != null && cg.formation7d != null && pg.formation7d !== cg.formation7d) notes.push(`7-day odds ${pg.formation7d}% -> ${cg.formation7d}%`);
  if (pg.formation48 != null && cg.formation48 != null && pg.formation48 !== cg.formation48) notes.push(`48-hour odds ${pg.formation48}% -> ${cg.formation48}%`);
  const ps = new Map((prior.storms || []).map((s) => [s.id, s]));
  for (const s of cur.storms) {
    const p = ps.get(s.id);
    if (p && p.type === s.type && (p.category || 0) === (s.category || 0) && p.winds !== s.winds) notes.push(`${s.name} winds ${p.winds} -> ${s.winds} kt`);
  }
  return notes;
}

// ---------- output ----------

async function notify(title, message, level, topic = process.env.NTFY_TOPIC) {
  if (!title) return true; // nothing to send on this channel
  if (!topic) { console.log(`[no NTFY_TOPIC, would push] ${title}: ${message}`); return false; }
  const r = await fetch('https://ntfy.sh/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic, title, message,
      priority: level === 'landfall' ? 5 : 4, // high priority throughout: default-priority pushes were not reliably announced on iPhone
      tags: [{ landfall: 'rotating_light', threat: 'warning', watch: 'cyclone' }[level] || 'white_check_mark'],
      ...(process.env.PAGE_URL ? { click: process.env.PAGE_URL } : {}),
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) console.warn(`ntfy push failed: HTTP ${r.status}`);
  return r.ok;
}

// Browser notifications: devices register with the Cloudflare worker (push/worker.js); we send to them here.
async function pushBrowsers(title, body) {
  const { PUSH_API, PUSH_ADMIN_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, PAGE_URL } = process.env;
  if (!PUSH_API || !PUSH_ADMIN_KEY || !VAPID_PRIVATE_KEY) return 0;
  const webpush = (await import('web-push').catch(() => null))?.default;
  if (!webpush) { console.warn('web-push not installed; browser notifications skipped'); return 0; }
  webpush.setVapidDetails(PAGE_URL || 'https://dhale2909.github.io/gulf-storm-watch/', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  const subs = await (await fetch(`${PUSH_API}/subscriptions`, { headers: { 'x-key': PUSH_ADMIN_KEY }, signal: AbortSignal.timeout(30000) })).json();
  const dead = [];
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try { await webpush.sendNotification(s, JSON.stringify({ title, body, url: PAGE_URL }), { TTL: 6 * 3600, urgency: 'high' }); sent++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) dead.push(s.endpoint); else console.warn(`browser push failed: ${e.statusCode || e.message}`); }
  }));
  if (dead.length) await fetch(`${PUSH_API}/prune`, { method: 'POST', headers: { 'x-key': PUSH_ADMIN_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ endpoints: dead }) }).catch(() => {});
  console.log(`browser notifications: ${sent} sent, ${dead.length} expired removed`);
  return sent;
}

// Send one alert on every configured channel. Each transport is isolated: one failing never stops the
// others or the save. Returns which channels got through; failures are kept in status.internal.pending
// and retried on the next runs (bounded), so a transient outage does not swallow an alert.
export async function deliver(msg) {
  const r = { private: null, public: null, browser: null };
  try { r.private = await notify(msg.privateTitle, msg.privateBody, msg.level); } catch (e) { r.private = false; console.warn(`private push failed: ${e.message}`); }
  try { r.browser = (await pushBrowsers(msg.publicTitle, msg.publicBody)) >= 0; } catch (e) { r.browser = false; console.warn(`browser push failed: ${e.message}`); }
  if (process.env.PUBLIC_NTFY_TOPIC) { try { r.public = await notify(msg.publicTitle, msg.publicBody, msg.level, process.env.PUBLIC_NTFY_TOPIC); } catch (e) { r.public = false; console.warn(`public push failed: ${e.message}`); } }
  return r;
}
const PENDING_ATTEMPTS = 3;

const readJSON = async (p, fallback) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; } };

async function save(status, entry, map) {
  await mkdir('data', { recursive: true });
  const log = await readJSON('data/log.json', []);
  log.unshift(entry);
  await writeFile('data/status.json', JSON.stringify(status, null, 2) + '\n');
  if (map) await writeFile('data/map.json', JSON.stringify({ updatedAt: status.updatedAt, ...map }) + '\n');
  await writeFile('data/log.json', JSON.stringify(log.slice(0, LOG_MAX), null, 2) + '\n');
}

async function main() {
  if (process.env.TEST_PUSH) {
    const n = await pushBrowsers("Daniel's Storm Page: test", 'Test notification. Storm alerts will reach this device.');
    console.log(`test browser push: ${n} device(s)`);
    return;
  }
  if (process.env.TEST_NOTIFY) {
    const ok = await notify('Gulf Storm Watch: test', 'Test notification. If you can read this, storm alerts will reach this device.', 'watch');
    console.log(ok ? 'test push sent' : 'test push NOT sent');
    return;
  }

  const prior = await readJSON('data/status.json', null);
  // Gather the two NHC sources independently: an outlook outage must not hide a storm feed that is fine, and vice versa.
  let gulf = null, storms = null, outlookOK = true, stormsOK = true, entries = [];
  try { entries = parseTWOAll(await get('two.html', 'https://www.nhc.noaa.gov/text/MIATWOAT.shtml')); } catch (e) { outlookOK = false; console.warn(`NHC outlook unavailable: ${e.message}`); }
  try { storms = await gatherStorms(prior); } catch (e) { stormsOK = false; console.warn(`NHC storm feed unavailable: ${e.message}`); }

  // ---- one tracked system (P3): keep following the same Invest / storm; anything else is "another system" ----
  const prevTracked = prior?.tracked || (prior?.gulf?.invest ? { invest: prior.gulf.invest, stormId: null } : prior?.storms?.[0] ? { invest: null, stormId: prior.storms[0].id } : null);
  const lastPos = prior?.tracked?.lastPos || prior?.storms?.[0]?.pos || null;
  const dist = (a, b) => (a && b ? Math.hypot(a.lat - b.lat, a.lonW - b.lonW) : Infinity);
  if (outlookOK) {
    // The outlook entry for our Invest by its (ALnn) tag; otherwise the strongest Gulf entry.
    gulf = (prevTracked?.invest && entries.find((e) => e.investHint === prevTracked.invest)) || entries[0] || null;
  }
  let otherEntries = outlookOK ? entries.filter((e) => e !== gulf) : [];
  if (stormsOK && storms.length) {
    let primary = prevTracked?.stormId ? storms.find((x) => x.id === prevTracked.stormId) : null;
    // Our Invest became a storm: adopt the Gulf storm closest to where the Invest was (or the only one).
    if (!primary && !prevTracked?.stormId) primary = storms.length === 1 ? storms[0] : storms.slice().sort((a, b) => dist(a.pos, lastPos) - dist(b.pos, lastPos))[0];
    if (!primary) primary = storms[0]; // previously tracked storm is gone; the remaining system takes over
    storms = [primary, ...storms.filter((x) => x !== primary)];
  }
  const failCount = outlookOK && stormsOK ? 0 : (prior?.internal?.failCount || 0) + 1;
  if (!outlookOK && !stormsOK) {
    // Keep the prior picture and its timestamp, record the attempt, and only speak up on the second miss in a row.
    const base = prior || { alertLevel: 'quiet', headline: 'No data yet: NHC could not be reached.', gulf: {}, storms: [], watchesWarnings: {} };
    const status = { ...base, lastAttemptAt: NOW.toISOString(), nextCheck: new Date((Math.floor(NOW.getTime() / 1800e3) + 1) * 1800e3).toISOString(), sources: { outlook: 'unavailable', storms: 'unavailable' }, internal: { ...(prior?.internal || {}), failCount } };
    let pushed = false;
    if (failCount === 2) { try { pushed = await notify('Gulf Storm Watch: data outage', 'NHC data has been unreachable for two checks in a row. The dashboard is showing the last good reading.', 'watch'); } catch (e) { console.warn(`outage push failed: ${e.message}`); } }
    await save(status, { ts: NOW.toISOString(), changed: false, pushed, alertLevel: status.alertLevel, formation7d: status.gulf?.formation7d ?? null, summary: 'NHC fetch failed' });
    console.log(`${String(status.alertLevel).toUpperCase()} | NHC unreachable (${failCount} in a row); previous reading kept`);
    return;
  }
  // One source failed: carry that part of the previous reading forward, flagged, rather than treating it as absent.
  if (!outlookOK) gulf = prior?.gulf?.area ? { ...prior.gulf, stale: true } : null;
  if (!stormsOK) storms = (prior?.storms || []).map((p, k) => ({ ...p, forecastStale: true, landfall: k === 0 ? prior.landfall : null, tropical: !/Post-Tropical/.test(p.type) }));

  // A tracked system that vanishes from both NHC feeds at once is more often a publication gap (outlook dropped
  // before the first advisory appears, or the reverse) than a real all-clear. Hold the previous reading for one
  // check; accept the disappearance only if it is still missing on the next one.
  const tracked = !!(prior && (prior.gulf?.area || prior.storms?.length));
  const nowEmpty = !gulf && storms.length === 0;
  const vanishedBefore = prior?.internal?.vanishedChecks || 0;
  const holding = tracked && nowEmpty && outlookOK && stormsOK && vanishedBefore < 1;
  if (holding) {
    console.warn('system missing from NHC feeds; holding the previous reading for one check to confirm');
    gulf = prior.gulf?.area ? { ...prior.gulf, stale: true } : null;
    storms = (prior.storms || []).map((p, k) => ({ ...p, forecastStale: true, landfall: k === 0 ? prior.landfall : null, tropical: !/Post-Tropical/.test(p.type) }));
  }

  const ww = await gatherAlerts(prior, storms.length > 0);
  // The map is a nice-to-have: if its service is down, keep the last map and carry on.
  const map = await gatherMap(gulf, storms[0]).catch((e) => { console.warn(`map layers unavailable: ${e.message}`); return null; });
  const models = await gatherModels(gulf, storms[0]).catch((e) => { console.warn(`model guidance unavailable: ${e.message}`); return undefined; });
  if (map && models) {
    // One "now" position: once the best track exists, its latest fix replaces the outlook's X.
    const base = models.history?.length ? map.features.filter((f) => f.properties.role !== 'origin') : map.features;
    map.features = [...models.features, ...base, ...(models.history || [])];
    map.models = models.label;
  }
  if (gulf && models?.invest) { gulf.invest = models.invest; if (models.winds) gulf.winds = models.winds; }
  else if (gulf && models === undefined && prior?.gulf?.invest) gulf.invest = prior.gulf.invest; // guidance fetch failed: keep the known Invest number
  else if (gulf && gulf.investHint) gulf.invest = gulf.investHint; // NHC names the Invest in the outlook heading
  if (gulf) delete gulf.investHint;
  const status = build(prior, gulf, storms, ww);
  const primary = storms[0] || null;
  status.tracked = primary ? { invest: prevTracked?.invest || gulf?.investHint || null, stormId: primary.id, name: primary.name, lastPos: primary.pos || lastPos }
    : gulf ? { invest: gulf.investHint || gulf.invest || prevTracked?.invest || null, stormId: null, name: gulf.investHint || gulf.invest || gulf.area, lastPos: models?.history?.length ? (() => { const c = models.history[models.history.length - 1].geometry.coordinates; return { lat: c[1], lonW: -c[0] }; })() : lastPos }
    : null;
  // Other Gulf systems: listed, and announced once if they become a coastal threat. They never replace the tracked one.
  status.others = [
    ...storms.slice(1).map((o) => ({ id: o.id, name: o.name, threat: !!(o.tropical && o.landfall), detail: o.landfall ? `is forecast to reach the ${o.landfall.state} coast around ${fmtCT(o.landfall.eta)}` : `is in the Gulf (${o.winds} kt)` })),
    ...otherEntries.map((e) => ({ id: e.investHint || e.area, name: e.investHint ? `${e.investHint} (${e.area})` : e.area, threat: false, detail: `${e.formation7d}% chance of forming within 7 days` })),
  ];
  status.internal.othersAlerted = [...new Set([...(prior?.internal?.othersAlerted || []), ...status.others.filter((o) => o.threat).map((o) => o.id)])];
  status.internal.failCount = failCount;
  status.internal.vanishedChecks = holding ? vanishedBefore + 1 : 0;
  status.sources = { outlook: outlookOK ? 'ok' : 'unavailable', storms: stormsOK ? 'ok' : 'unavailable', alerts: ww.unavailable ? `unavailable for ${ww.unavailable.join(', ')}` : 'ok', map: map ? 'ok' : 'unavailable' };
  if (!outlookOK || !stormsOK) { status.updatedAt = prior?.updatedAt || status.updatedAt; } // not a fully fresh reading
  status.google = await gatherGoogle(storms[0], models?.invest).catch((e) => { console.warn(`Google ensemble unavailable: ${e.message}`); return prior?.google ?? null; });
  const changes = diff(prior, status);
  const changed = changes.length > 0;
  if (changed) { status.internal.baseline7d = status.gulf.formation7d; status.internal.baseline48 = status.gulf.formation48; }

  let pushed = false, delivery = null;
  if (changed) {
    const plays = (() => { try { return JSON.parse(process.env.PLAYS_JSON || '{}'); } catch { return {}; } })();
    const play = plays[status.alertLevel] ? `\n\nPlay: ${plays[status.alertLevel]}` : '';
    const goog = status.google ? `\n\nGoogle AI ensemble (experimental, not a forecast): ${status.google.text}` : '';
    const msg = {
      level: status.alertLevel,
      privateTitle: `Gulf Storm Watch: ${status.alertLevel.toUpperCase()}`, privateBody: `${changes.join('. ')}.\n\n${status.headline}${goog}${play}`,
      // Public subscribers get the same change, weather facts only: browser notifications and the public ntfy feed.
      publicTitle: `Daniel's Storm Page: ${status.alertLevel.toUpperCase()}`, publicBody: `${changes.join('. ')}.\n\n${status.headline}`,
    };
    delivery = await deliver(msg);
    pushed = delivery.private === true;
    const failed = Object.keys(delivery).filter((k) => delivery[k] === false);
    status.internal.pending = failed.length ? { ...msg, failed, attempts: 1, ts: NOW.toISOString() } : null;
  } else if (prior?.internal?.pending && prior.internal.pending.attempts < PENDING_ATTEMPTS) {
    // Nothing new, but a previous alert did not get through everywhere: try those channels again.
    const pend = prior.internal.pending;
    const topicSave = process.env.PUBLIC_NTFY_TOPIC;
    if (!pend.failed.includes('public')) process.env.PUBLIC_NTFY_TOPIC = '';
    const retry = await deliver({ ...pend, privateTitle: pend.failed.includes('private') ? pend.privateTitle : '', privateBody: pend.privateBody });
    process.env.PUBLIC_NTFY_TOPIC = topicSave;
    const stillFailed = pend.failed.filter((k) => retry[k] === false);
    status.internal.pending = stillFailed.length ? { ...pend, failed: stillFailed, attempts: pend.attempts + 1 } : null;
    console.log(`retried alert delivery (${pend.failed.join(', ')}): ${stillFailed.length ? 'still failing: ' + stillFailed.join(', ') : 'delivered'}`);
  } else status.internal.pending = prior?.internal?.pending || null;

  const minor = changed ? [] : minorDiff(prior, status);
  const summary = changed ? changes.join('. ') + '.'
    : minor.length ? `Update, below the alert threshold: ${minor.join('. ')}.`
    : prior ? 'No change. ' + status.headline : 'Watch opened. ' + status.headline;
  await save(status, { ts: NOW.toISOString(), changed, pushed, delivery, updated: minor.length > 0, alertLevel: status.alertLevel, formation7d: status.gulf.formation7d, summary: (holding ? '(system missing from NHC feeds; holding the previous reading for one check to confirm) ' : outlookOK && stormsOK ? '' : `(${!outlookOK ? 'outlook' : 'storm feed'} unavailable; previous values carried) `) + summary }, map);
  console.log(`${status.alertLevel.toUpperCase()} | changed=${changed} pushed=${pushed} | ${summary}`);
}

export { main };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });
