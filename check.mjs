#!/usr/bin/env node
// Gulf Storm Watch: one check of NHC/NWS data for the Gulf system.
// Reads data/status.json (prior state), writes data/status.json + data/log.json,
// and pushes a notification through ntfy only when the picture changes.
//
// Env: NTFY_TOPIC (push target), PLAYS_JSON (optional {"watch":"...",...} action text
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

// Tropical Weather Outlook -> the Gulf disturbance (highest 7-day odds if several), or null.
function parseTWO(html) {
  const pre = preText(html);
  if (!pre || !/Tropical Weather Outlook/i.test(pre)) throw new Error('TWO text not found');
  const issued = (/^\d{3,4} (?:AM|PM) \w+ \w+ \w+ \d+ \d{4}$/m.exec(pre) || [''])[0];
  const pct = (s) => (/near 0/i.test(s) ? 0 : +s);
  const re = /\* Formation chance through 48 hours\.\.\.\w+\.\.\.(near 0|\d+) percent\.\s*\* Formation chance through 7 days\.\.\.\w+\.\.\.(near 0|\d+) percent\./gi;
  let best = null, last = 0, m;
  while ((m = re.exec(pre))) {
    const para = pre.slice(last, m.index).trim().split(/\n\s*\n/).pop().trim();
    last = re.lastIndex;
    if (!/Gulf of (America|Mexico)|Bay of Campeche/i.test(para)) continue;
    const lines = para.split('\n');
    const hasHead = /:$/.test(lines[0]);
    const d = {
      area: hasHead ? lines[0].replace(/^\d+\.\s*/, '').replace(/:$/, '').replace(/\s*\([^)]*\)$/, '') : 'Gulf disturbance',
      text: lines.slice(hasHead ? 1 : 0).join(' ').replace(/\s+/g, ' ').trim(),
      formation48: pct(m[1]), formation7d: pct(m[2]),
      source: `NHC outlook, ${issued}`,
    };
    if (!best || d.formation7d > best.formation7d) best = d;
  }
  return best;
}

// Forecast advisory -> [{t, lat, lonW}] forecast points.
function parseTCM(html, issuanceISO) {
  const pre = preText(html);
  if (!pre) return [];
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

const category = (kt) => (kt >= 137 ? 5 : kt >= 113 ? 4 : kt >= 96 ? 3 : kt >= 83 ? 2 : kt >= 64 ? 1 : 0);
const compass = (deg) => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(deg / 22.5) % 16];
const fmtCT = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric' }) + ' CT';

// ---------- gather ----------

async function gatherStorms() {
  const feed = await get('storms.json', 'https://www.nhc.noaa.gov/CurrentStorms.json', true);
  if (!feed || !Array.isArray(feed.activeStorms)) throw new Error('CurrentStorms.json malformed');
  const out = [];
  for (const s of feed.activeStorms) {
    if (!/^al/i.test(s.id || '')) continue; // Atlantic basin only; never Pacific
    const here = { t: s.lastUpdate, lat: +s.latitudeNumeric, lonW: -s.longitudeNumeric };
    let track = [];
    try {
      if (s.forecastAdvisory?.url) {
        track = parseTCM(await get(`tcm-${s.id}.html`, s.forecastAdvisory.url), s.forecastAdvisory.issuance || s.lastUpdate);
      }
    } catch (e) { console.warn(`forecast advisory for ${s.id} unavailable: ${e.message}`); }
    const path = [here, ...track];
    if (!path.some(inGulf) && !path.some(coastHit)) continue; // not a Gulf system
    const winds = +s.intensity || 0;
    const type = TYPES[s.classification] || 'Post-Tropical Cyclone';
    const hit = path.find(coastHit) || null;
    out.push({
      id: s.id, bin: s.binNumber, name: `${type} ${s.name}`, type, winds,
      category: s.classification === 'HU' ? category(winds) : 0,
      tropical: s.classification in TYPES,
      location: `${here.lat.toFixed(1)}N ${here.lonW.toFixed(1)}W` + (inGulf(here) ? (here.lat < 22 && here.lonW >= 90 ? ', Bay of Campeche' : ', Gulf') : ', approaching the Gulf'),
      movement: s.movementSpeed ? `${compass(+s.movementDir)} at ${s.movementSpeed} kt` : 'Stationary',
      landfall: hit && { state: coastState(hit), eta: hit.t },
      gulfRisk: hit
        ? `Forecast track reaches the ${coastState(hit)} coast around ${fmtCT(hit.t)} (approximate)`
        : track.length ? 'Forecast track stays off the AL/FL/MS/LA coast through the forecast period' : 'No forecast track available',
    });
  }
  return out.sort((a, b) => (a.landfall ? 0 : 1) - (b.landfall ? 0 : 1) || b.winds - a.winds);
}

async function gatherAlerts(prior, gulfStorm) {
  const ww = { note: '' };
  for (const st of STATES) {
    try {
      const j = await get(`alerts-${st}.json`, `https://api.weather.gov/alerts/active?area=${st}`, true);
      const events = [...new Set((j.features || []).map((f) => f.properties?.event).filter((e) => TROPICAL_EVENTS.test(e || '')))];
      // Florida also has an Atlantic coast; only count its alerts while a Gulf storm exists.
      if (!events.length || (st === 'FL' && !gulfStorm)) ww[st] = {};
      else ww[st] = { level: events.some((e) => /Warning$/.test(e)) ? 'warning' : 'watch', text: events.sort().join(', ') };
    } catch (e) {
      console.warn(`alerts for ${st} unavailable: ${e.message}`);
      ww[st] = prior?.watchesWarnings?.[st] || {};
    }
  }
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
  const latest = new Map(); // tech -> { date, pts: Map(tau -> [lon, lat]) }
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
    let t = latest.get(tech);
    if (!t || date > t.date) latest.set(tech, (t = { date, pts: new Map() }));
    if (date === t.date) t.pts.set(tau, [lon, lat]);
  }
  if (!latest.size) return null;
  const init = [...latest.values()].map((t) => t.date).sort().pop();
  const tracks = [];
  for (const [tech, t] of latest) {
    if (cycleMs(init) - cycleMs(t.date) > 12 * 3600e3 || t.pts.size < 3) continue; // stale run or too short to draw
    tracks.push({ tech, group: modelGroup(tech), name: (MODEL_NAMES.find(([re]) => re.test(tech)) || [0, tech])[1],
      coords: [...t.pts.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p) });
  }
  return { init, origin, tracks };
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
    const run = new Date(cycleMs(d.init)).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric' }) + ' CT';
    return {
      invest, label: `${d.tracks.length} model tracks, latest run ${run}`,
      features: d.tracks.map((t) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: t.coords }, properties: { role: 'model', tech: t.tech, name: t.name, group: t.group } })),
    };
  }
  return null;
}

// ---------- decide ----------

function build(prior, gulf, storms, ww) {
  const storm = storms[0] || null;
  const anyAlert = STATES.some((s) => ww[s].level);
  const landfall = storm?.landfall || null;
  const hold = prior?.internal?.landfallHoldUntil;
  const imminent = landfall && new Date(landfall.eta).getTime() - NOW.getTime() <= 24 * 3600e3;
  const held = hold && new Date(hold) > NOW;

  let alertLevel = 'quiet';
  if (gulf || storm) alertLevel = 'watch';
  if ((storm?.tropical && landfall) || anyAlert) alertLevel = 'threat';
  if (imminent || held) alertLevel = 'landfall';

  let headline;
  if (storm) {
    headline = `${storm.name}: ${storm.winds} kt${storm.category ? ` (Category ${storm.category})` : ''}, ${storm.location}, moving ${storm.movement}. ${storm.gulfRisk}.`;
  } else if (held) {
    headline = `Landfall on the ${prior.internal.landfallState || 'Gulf'} coast within the last 48 hours; the system is no longer an active NHC storm.`;
  } else if (gulf) {
    headline = `NHC gives the ${gulf.area} disturbance a ${gulf.formation7d}% chance of forming within 7 days (${gulf.formation48}% within 48 hours). No advisories or forecast track yet.`;
  } else {
    headline = 'No Gulf disturbance in the NHC outlook and no Gulf storm.';
  }
  if (anyAlert) headline += ` Tropical alerts in effect: ${STATES.filter((s) => ww[s].level).map((s) => `${s} (${ww[s].text})`).join('; ')}.`;

  return {
    updatedAt: NOW.toISOString(),
    nextCheck: new Date(Math.ceil((NOW.getTime() + 60e3) / (3 * 3600e3)) * 3 * 3600e3).toISOString(),
    alertLevel, headline,
    gulf: gulf || { area: '', formation48: null, formation7d: null, source: 'NHC outlook', text: storm ? 'NHC is issuing advisories on this system; see the storm panel.' : '' },
    storms: storms.map(({ landfall: _l, tropical: _t, bin: _b, ...s }) => s),
    watchesWarnings: ww,
    landfall,
    internal: {
      failCount: 0,
      baseline7d: prior?.internal?.baseline7d ?? gulf?.formation7d ?? null,
      landfallHoldUntil: imminent ? new Date(Math.max(new Date(landfall.eta), NOW) + 48 * 3600e3).toISOString() : held ? hold : null,
      landfallState: imminent ? landfall.state : held ? prior.internal.landfallState : null,
    },
  };
}

// What counts as a change worth a push. Wording-only outlook edits do not.
function diff(prior, cur) {
  const ch = [];
  if (!prior) return ch;
  if (prior.alertLevel !== cur.alertLevel) ch.push(`Alert level ${prior.alertLevel.toUpperCase()} -> ${cur.alertLevel.toUpperCase()}`);

  const a = prior.gulf?.formation7d, b = cur.gulf?.formation7d, base = prior.internal?.baseline7d;
  if (a != null && b != null) {
    const crossed = (a < 40) !== (b < 40) || (a < 60) !== (b < 60);
    if (crossed || (base != null && Math.abs(b - base) >= 20)) ch.push(`7-day formation odds ${base != null && !crossed ? base : a}% -> ${b}%`);
  }

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
    const x = prior.watchesWarnings?.[st]?.level || null, y = cur.watchesWarnings[st].level || null;
    if (x !== y) ch.push(y ? `${st}: tropical ${y} posted (${cur.watchesWarnings[st].text})` : `${st}: tropical ${x} dropped`);
  }

  const pl = prior.landfall, cl = cur.landfall;
  if (cl && !pl) ch.push(`Forecast track now reaches the ${cl.state} coast around ${fmtCT(cl.eta)}`);
  else if (pl && !cl && cur.storms.length) ch.push('Forecast track no longer reaches the AL/FL/MS/LA coast');
  else if (pl && cl) {
    if (pl.state !== cl.state) ch.push(`Forecast landfall shifted ${pl.state} -> ${cl.state} (${fmtCT(cl.eta)})`);
    else if (Math.abs(new Date(pl.eta) - new Date(cl.eta)) >= 12 * 3600e3) ch.push(`Forecast ${cl.state} landfall timing moved to ${fmtCT(cl.eta)}`);
  }
  return ch;
}

// ---------- output ----------

async function notify(title, message, level) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) { console.log(`[no NTFY_TOPIC, would push] ${title}: ${message}`); return false; }
  const r = await fetch('https://ntfy.sh/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic, title, message,
      priority: { landfall: 5, threat: 4 }[level] || 3,
      tags: [{ landfall: 'rotating_light', threat: 'warning', watch: 'cyclone' }[level] || 'white_check_mark'],
      ...(process.env.PAGE_URL ? { click: process.env.PAGE_URL } : {}),
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) console.warn(`ntfy push failed: HTTP ${r.status}`);
  return r.ok;
}

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
  if (process.env.TEST_NOTIFY) {
    const ok = await notify('Gulf Storm Watch: test', 'Test notification. If you can read this, storm alerts will reach this device.', 'watch');
    console.log(ok ? 'test push sent' : 'test push NOT sent');
    return;
  }

  const prior = await readJSON('data/status.json', null);
  let gulf, storms;
  try {
    [gulf, storms] = [parseTWO(await get('two.html', 'https://www.nhc.noaa.gov/text/MIATWOAT.shtml')), await gatherStorms()];
  } catch (e) {
    // Keep the prior picture, advance "last check", and only speak up on the second miss in a row.
    console.warn(`NHC fetch failed: ${e.message}`);
    const failCount = (prior?.internal?.failCount || 0) + 1;
    const status = { ...(prior || { alertLevel: 'quiet', headline: 'No data yet.', gulf: {}, storms: [], watchesWarnings: {} }), updatedAt: NOW.toISOString(), internal: { ...(prior?.internal || {}), failCount } };
    const pushed = failCount === 2 && (await notify('Gulf Storm Watch: data outage', 'NHC data has been unreachable for two checks in a row. The dashboard is showing the last good reading.', 'watch'));
    await save(status, { ts: NOW.toISOString(), changed: false, pushed: !!pushed, alertLevel: status.alertLevel, formation7d: status.gulf?.formation7d ?? null, summary: 'NHC fetch failed' });
    return;
  }

  const ww = await gatherAlerts(prior, storms.length > 0);
  // The map is a nice-to-have: if its service is down, keep the last map and carry on.
  const map = await gatherMap(gulf, storms[0]).catch((e) => { console.warn(`map layers unavailable: ${e.message}`); return null; });
  const models = await gatherModels(gulf, storms[0]).catch((e) => { console.warn(`model guidance unavailable: ${e.message}`); return null; });
  if (map && models) { map.features = [...models.features, ...map.features]; map.models = models.label; }
  if (gulf && models?.invest) gulf.invest = models.invest;
  const status = build(prior, gulf, storms, ww);
  const changes = diff(prior, status);
  const changed = changes.length > 0;
  if (changed) status.internal.baseline7d = status.gulf.formation7d;

  let pushed = false;
  if (changed) {
    const plays = (() => { try { return JSON.parse(process.env.PLAYS_JSON || '{}'); } catch { return {}; } })();
    const play = plays[status.alertLevel] ? `\n\nPlay: ${plays[status.alertLevel]}` : '';
    pushed = await notify(`Gulf Storm Watch: ${status.alertLevel.toUpperCase()}`, `${changes.join('. ')}.\n\n${status.headline}${play}`, status.alertLevel);
  }

  const summary = changed ? changes.join('. ') + '.' : prior ? 'No change. ' + status.headline : 'Watch opened. ' + status.headline;
  await save(status, { ts: NOW.toISOString(), changed, pushed, alertLevel: status.alertLevel, formation7d: status.gulf.formation7d, summary }, map);
  console.log(`${status.alertLevel.toUpperCase()} | changed=${changed} pushed=${pushed} | ${summary}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });
