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
const LEVEL_LABEL = { quiet: 'QUIET', watch: 'MONITORING', threat: 'THREAT', landfall: 'LANDFALL' }; // "watch" stays the internal name; it is never an official NHC watch
const TYPES = {
  TD: 'Tropical Depression', TS: 'Tropical Storm', HU: 'Hurricane',
  STD: 'Subtropical Depression', STS: 'Subtropical Storm',
  PC: 'Potential Tropical Cyclone', // NHC's JSON codes: PC is a Potential Tropical Cyclone, PTC a Post-tropical Cyclone
};

// ---------- fetching ----------

// Time budget. The whole check must finish inside its five-minute workflow step, with the reading saved and the
// alert sent even when a source stalls. Core sources (NHC outlook, storm feed, forecast advisories, NWS alerts)
// get two bounded attempts each; the optional layers (map, model guidance, Google ensemble) share what is left of
// a fixed budget and are skipped, not waited for, once it runs out.
const START = Date.now();
const CORE_TIMEOUT = 25000; // per attempt
const OPT_DEADLINE = START + 170e3; // optional work stops here, leaving time for delivery and the save
const optBudget = (cap = 20000) => Math.max(3000, Math.min(cap, OPT_DEADLINE - Date.now()));
const optional = (label, p) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`${label} exceeded the time budget`)), optBudget(90000));
  t.unref?.();
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

async function get(name, url, json = false, { timeout = CORE_TIMEOUT, attempts = 2 } = {}) {
  if (FIX) {
    const t = await readFile(`${FIX}/${name}`, 'utf8');
    return json ? JSON.parse(t) : t;
  }
  let err;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: json ? 'application/geo+json, application/json' : 'text/html' },
        signal: AbortSignal.timeout(timeout),
      });
      if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
      return json ? await r.json() : await r.text();
    } catch (e) { err = e; }
  }
  throw err;
}
const getOpt = (name, url, json = false) => get(name, url, json, { timeout: optBudget(20000), attempts: 1 });

async function getBuf(name, url) {
  if (FIX) return readFile(`${FIX}/${name}`);
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(optBudget(40000)) });
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
  // Issuance as a time, so the outlook can be compared with a storm advisory ("800 PM CDT Tue Oct 6 2026").
  const issuedAt = (() => {
    const m = /^(\d{1,2})(\d{2}) (AM|PM) ([A-Z]{3,4}) \w+ (\w{3}) (\d{1,2}) (\d{4})$/m.exec(pre);
    const TZ = { EDT: -4, EST: -5, CDT: -5, CST: -6, ADT: -3, AST: -4 };
    const mon = m ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(m[5]) : -1;
    if (!m || TZ[m[4]] == null || mon < 0) return null;
    return new Date(Date.UTC(+m[7], mon, +m[6], (+m[1] % 12) + (m[3] === 'PM' ? 12 : 0) - TZ[m[4]], +m[2])).toISOString();
  })();
  const pct = (str) => +String(str).replace(/near/i, '').trim(); // "near 0", "near 100", "70"
  let body = pre.replace(/^[\s\S]*?For the North Atlantic[^\n]*\n/i, '')
    // The outlook ends at "&&" (WMO/AWIPS headers, the June 1 season note) or "$$" (signature): nothing after it is a disturbance.
    .replace(/^(?:&&|\$\$)[ \t]*$[\s\S]*/m, '')
    // Formation lines can wrap ("near\n100 percent"); join their continuation lines.
    .replace(/^\* Formation chance[^\n]*(?:\n(?!\*|\s*$)[^\n]*)*/gim, (m) => m.replace(/\s+/g, ' '));
  // One entry per heading line ("Southwestern Gulf of America (AL92):", "1. Central Tropical Atlantic:").
  const entries = [];
  const orphan = []; // text before the first heading (or with no heading at all)
  let cur = null, active = false, sawActive = false;
  for (const line of body.split('\n')) {
    // Storms with advisories are handled from CurrentStorms.json. The whole "Active Systems" block is skipped, up to the
    // next area heading: it can hold several paragraphs, and a Potential Tropical Cyclone's carries formation lines.
    if (/^Active Systems:/i.test(line)) { active = true; sawActive = true; continue; }
    if (/^(?:\d+\.\s*)?[^*\n]{3,78}:\s*$/.test(line)) { active = false; cur = { head: line.trim(), lines: [] }; entries.push(cur); }
    else if (active) continue;
    else if (cur) cur.lines.push(line);
    else orphan.push(line);
  }
  // Since 2025 NHC often writes plain "Gulf" ("Southwestern Gulf (AL98):", "Northern Gulf Coast"). Not the Gulf Stream
  // or another gulf ("Gulf of Honduras").
  const GULF = /\bGulf\b(?!\s+Stream)(?!\s+of\s+(?!Mexico\b|America\b)\w)|Bay of Campeche/i;
  // Every disturbance must have been captured as an entry. Formation odds or Gulf text outside any entry, or a
  // formation-line count that does not match the entries, means the layout changed: unreadable, never "quiet".
  const orphanText = orphan.join(' ');
  // A special outlook opens with one sentence saying why it was issued ("Special Tropical Weather Outlook to update the
  // discussion of the low pressure area in the Gulf of Mexico (AL93)."): it names the Gulf but is not a disturbance.
  const preamble = entries.length > 0 && /\b(?:special|update[sd]?)\b/i.test(orphanText);
  if (/Formation chance/i.test(orphanText) || (GULF.test(orphanText) && !preamble)) throw new Error('outlook has disturbance text outside a recognised heading');
  if (!entries.length && !sawActive && !/formation is not expected|no tropical cyclone formation is expected|not expected during the next/i.test(body)) throw new Error('outlook lists no disturbance and no explicit all-clear');
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
      // Plain prose for the page: the odds lines (already read into numbers) and the signature go.
      text: text.replace(/\* Formation chance through[\s\S]*?percent\./gi, '').replace(/\$\$[\s\S]*$/, '').replace(/\bForecaster [A-Z][\w/]*\s*$/, '').replace(/\s+/g, ' ').trim(),
      formation48: p48, formation7d: p7,
      source: `NHC outlook, ${issued}`,
      issuedAt,
      investHint: inv ? `Invest ${inv[1]}L` : null,
    };
    found.push(d);
  }
  const formationLines = (entries.flatMap((e) => e.lines).join('\n').match(/\* Formation chance through/gi) || []).length;
  if (formationLines !== 2 * entries.length) throw new Error(`outlook has ${formationLines} formation lines for ${entries.length} entries`);
  return found.sort((a, b) => b.formation7d - a.formation7d);
}
export function parseTWO(html) { return parseTWOAll(html)[0] || null; }

// Forecast advisory -> [{t, lat, lonW}] forecast points. null means "unknown" (unreadable, for another storm or
// advisory, or with forecast lines that could not be read); [] means the advisory verifiably carries no track.
export function parseTCM(html, issuanceISO, expect = {}) {
  const pre = preText(html);
  if (!pre || !/FORECAST\/ADVISORY|FORECAST VALID|REMNANTS|DISSIPAT/i.test(pre)) return null; // unreadable: unknown, not "no track"
  // The text must be the advisory the storm feed pointed at: a cached or mislinked page is unknown, never a track.
  const idm = /\b(AL\d{6})\b/i.exec(pre);
  if (expect.id && idm && idm[1].toLowerCase() !== String(expect.id).toLowerCase()) return null;
  const advm = /ADVISORY NUMBER\s+(\d+)/i.exec(pre);
  if (expect.advNum && advm && +advm[1] !== +expect.advNum) return null;
  const base = new Date(issuanceISO);
  if (Number.isNaN(base.getTime())) return null;
  const pts = [];
  const lines = pre.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/\b(?:FORECAST|OUTLOOK) VALID\b/i.test(line)) continue;
    if (/VALID\s+\d{2}\/\d{4}Z\s*\.*\s*(?:DISSIPATED|ABSORBED|REMNANT)/i.test(line)) continue; // the end of the forecast, no position
    const m = /(?:FORECAST|OUTLOOK) VALID (\d{2})\/(\d{2})(\d{2})Z\s+(\d+\.\d)([NS])\s+(\d+\.\d)([EW])/i.exec(line);
    if (!m) return null; // a forecast line without a readable position ("POSITION UNAVAILABLE"): the track is unknown, not shorter
    const day = +m[1], hh = +m[2], mm = +m[3];
    if (day < 1 || day > 31 || hh > 23 || mm > 59) return null;
    let d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), day, hh, mm));
    if (d.getTime() < base.getTime() - 86400000) d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, day, hh, mm));
    if (d.getTime() - base.getTime() > 8 * 86400000) return null; // a 5-day advisory never reaches this far
    const lat = +m[4] * (m[5] === 'S' ? -1 : 1), lonW = m[7] === 'W' ? +m[6] : -+m[6];
    if (Math.abs(lat) > 90 || Math.abs(lonW) > 180) return null;
    const w = /MAX WIND\s+(\d+)\s*KT/i.exec(lines[i + 1] || '');
    pts.push({ t: d.toISOString(), lat, lonW, ...(w ? { wind: +w[1] } : {}) });
  }
  // A header with no readable forecast is only "no track" when the text says the system is ending.
  if (!pts.length && !/REMNANTS|DISSIPAT|POST-TROPICAL|EXTRATROPICAL|LAST (?:PUBLIC )?ADVISORY|NO LONGER A TROPICAL/i.test(pre)) return null;
  return pts;
}

// Forecast discussion (TCD) -> { number, issued, paragraphs, keyMessages, forecaster }, or null if unreadable or for
// another storm/advisory. Display only: nothing in it drives an alert.
export function parseTCD(html, expect = {}) {
  const pre = preText(html);
  if (!pre || !/Discussion Number/i.test(pre)) return null;
  const idm = /\b(AL\d{6})\b/i.exec(pre);
  if (expect.id && idm && idm[1].toLowerCase() !== String(expect.id).toLowerCase()) return null;
  const num = /Discussion Number\s+(\d+)/i.exec(pre);
  if (expect.advNum && num && +num[1] !== +expect.advNum) return null;
  const issued = (/^\d{3,4} (?:AM|PM) [A-Z]{3,4} \w+ \w+ \d+ \d{4}$/m.exec(pre) || [''])[0];
  const lines = pre.replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => /^\d{3,4} (?:AM|PM) /.test(l)) + 1;
  const keyAt = lines.findIndex((l) => /^\s*Key Messages:/i.test(l));
  const fcstAt = lines.findIndex((l) => /^\s*FORECAST POSITIONS AND MAX WINDS/i.test(l));
  const end = keyAt > 0 ? keyAt : fcstAt > 0 ? fcstAt : lines.length;
  const paras = (txt) => txt.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const paragraphs = start > 0 ? paras(lines.slice(start, end).join('\n')) : [];
  let keyMessages = [];
  if (keyAt > 0) {
    const block = lines.slice(keyAt + 1, fcstAt > keyAt ? fcstAt : lines.length).join('\n');
    keyMessages = block.split(/\n\s*(?=\d+\.\s)/).map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => /^\d+\.\s/.test(p)).map((p) => p.replace(/^\d+\.\s*/, ''));
  }
  if (!paragraphs.length && !keyMessages.length) return null;
  const fc = /Forecaster\s+(.+?)\s*$/im.exec(pre);
  return { number: num ? +num[1] : null, issued, paragraphs, keyMessages, forecaster: fc ? fc[1].trim() : '' };
}

// ---------- geography (deliberately rough boxes) ----------

const inGulf = (p) =>
  (p.lat >= 21.5 && p.lat <= 31 && p.lonW >= 81 && p.lonW <= 98) ||
  (p.lat >= 18 && p.lat < 21.5 && p.lonW >= 90 && p.lonW <= 98); // Bay of Campeche

// Close enough to the Gulf that a storm whose forecast cannot be read might still be headed there (NW Caribbean,
// Yucatan Channel, Straits of Florida, Bahamas).
const nearGulf = (p) => p.lat >= 10 && p.lat <= 33 && p.lonW >= 70 && p.lonW <= 100;

// Checks run at 5 and 35 past the hour, so an advisory NHC posts on the hour is picked up within minutes.
export const nextCheckAt = (now) => new Date((Math.floor((now.getTime() - 300e3) / 1800e3) + 1) * 1800e3 + 300e3).toISOString();
const mph = (kt) => Math.round((+kt || 0) * 1.15078 / 5) * 5; // NHC public advisories round mph to the nearest 5
// Nearest coastal town to a landfall point, for a more specific "near ..." than the state alone.
const TOWNS = [
  ['Galveston, TX', 29.30, 94.80], ['Cameron, LA', 29.80, 93.33], ['Morgan City, LA', 29.70, 91.21], ['Grand Isle, LA', 29.24, 90.00],
  ['Venice, LA', 29.28, 89.35], ['New Orleans, LA', 29.95, 90.07], ['Bay St. Louis, MS', 30.31, 89.33], ['Gulfport, MS', 30.37, 89.09],
  ['Biloxi, MS', 30.40, 88.89], ['Pascagoula, MS', 30.37, 88.56], ['Dauphin Island, AL', 30.25, 88.11], ['Mobile, AL', 30.69, 88.04],
  ['Gulf Shores, AL', 30.25, 87.70], ['Orange Beach, AL', 30.29, 87.57], ['Pensacola, FL', 30.42, 87.22], ['Navarre, FL', 30.40, 86.86],
  ['Destin, FL', 30.39, 86.50], ['Panama City, FL', 30.16, 85.66], ['Port St. Joe, FL', 29.81, 85.30], ['Apalachicola, FL', 29.73, 84.98],
  ['St. Marks, FL', 30.16, 84.21], ['Steinhatchee, FL', 29.67, 83.39], ['Cedar Key, FL', 29.14, 83.04], ['Crystal River, FL', 28.90, 82.59],
  ['Tarpon Springs, FL', 28.15, 82.76], ['Tampa, FL', 27.95, 82.46], ['St. Petersburg, FL', 27.77, 82.64], ['Sarasota, FL', 27.34, 82.53],
  ['Fort Myers, FL', 26.64, 81.87], ['Naples, FL', 26.14, 81.80], ['Marco Island, FL', 25.94, 81.72], ['Key West, FL', 24.56, 81.78],
];
// One coastline for every landfall question (forecast crossing, observed landfall, state): a rough polyline of the
// Louisiana-to-Florida Gulf shore. COAST_N is latitude by longitude along the northern coast; COAST_W is longitude
// by latitude down Florida's west coast. Land is north of COAST_N and east of COAST_W.
const COAST_N = [[94.5, 29.6], [93.5, 29.7], [92.0, 29.6], [91.3, 29.3], [90.5, 29.2], [89.9, 29.1], [89.4, 29.0], [89.1, 30.2], [88.6, 30.3], [88.0, 30.2], [87.5, 30.25], [86.5, 30.35], [85.7, 30.1], [85.3, 29.8], [84.9, 29.7], [84.3, 30.0], [83.6, 29.9], [83.1, 29.2], [82.8, 28.8]];
const COAST_W = [[28.8, 82.8], [28.1, 82.8], [27.6, 82.75], [27.0, 82.45], [26.4, 81.95], [25.9, 81.7], [25.2, 81.1]];
const COAST = [...COAST_N.map(([lonW, lat]) => ({ lonW, lat })), ...COAST_W.slice(1).map(([lat, lonW]) => ({ lonW, lat }))]; // one polyline, west to south
const interp = (table, x) => { for (let i = 1; i < table.length; i++) { const [x0, y0] = table[i - 1], [x1, y1] = table[i]; if ((x <= x0 && x >= x1) || (x >= x0 && x <= x1)) return y0 + (y1 - y0) * (x - x0) / (x1 - x0); } return null; };
const coastLat = (lonW) => interp(COAST_N, lonW);
const coastLonW = (lat) => interp(COAST_W, lat);
// On or inland of that coastline, within the four states (Texas and points far inland are out of scope).
const coastHit = (p) => {
  if (p.lat > 36 || p.lat < 24.3 || p.lonW < 80.8 || p.lonW > 93.9) return false;
  const cl = coastLat(p.lonW);
  if (cl != null && p.lat >= 28.8) return p.lat >= cl; // northern coast
  const cw = coastLonW(p.lat);
  if (cw != null) return p.lonW <= cw; // Florida's west coast
  if (p.lat >= 28.8) return p.lonW < 82.8; // inland Florida / Georgia, east of where the tables meet
  return p.lonW <= 82.0; // the Keys
};
// Observed landfall: the centre is on or inland of the coastline.
const ashore = coastHit;
// State at a coastal point, from the same shoreline: the state lines along the coast, with the Mississippi delta
// (Louisiana) reaching east of the Mississippi shore's longitude.
const coastState = (p) => (p.lonW > 89.6 || (p.lonW > 88.9 && p.lat < 30.05) ? 'LA' : p.lonW > 88.4 ? 'MS' : p.lonW > 87.5 ? 'AL' : 'FL');
// Where a forecast leg (a -> b) meets a coastline segment (c -> d): fraction along the leg, or null.
function legCrossing(a, b, c, d) {
  const r = { x: b.lonW - a.lonW, y: b.lat - a.lat }, s = { x: d.lonW - c.lonW, y: d.lat - c.lat };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-12) return null; // parallel
  const qp = { x: c.lonW - a.lonW, y: c.lat - a.lat };
  const t = (qp.x * s.y - qp.y * s.x) / den, u = (qp.x * r.y - qp.y * r.x) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}
// Where the forecast path meets the coast: the first sea-to-land crossing of the coastline along the path, with
// its time interpolated along that leg; or, if no clean crossing is found, the first point inside the coast.
function landfallPoint(path) {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if (!a.t || !b.t || coastHit(a)) continue; // must start at sea
    let best = null;
    for (let k = 1; k < COAST.length; k++) {
      const f = legCrossing(a, b, COAST[k - 1], COAST[k]);
      if (f != null && (best == null || f < best)) best = f;
    }
    if (best == null) continue;
    const lat = a.lat + (b.lat - a.lat) * best, lonW = a.lonW + (b.lonW - a.lonW) * best;
    const t = new Date(new Date(a.t).getTime() + (new Date(b.t).getTime() - new Date(a.t).getTime()) * best).toISOString();
    // NHC forecasts winds in 5-kt steps; the crossing wind keeps that step, so its mph and its category always agree.
    const wind = a.wind != null && b.wind != null ? Math.round((a.wind + (b.wind - a.wind) * best) / 5) * 5 : b.wind ?? a.wind ?? null;
    if (lonW <= 93.9 && lonW >= 80.8) return { lat, lonW, t, wind, crossing: true };
  }
  // Otherwise: the first forecast point inside the coast (e.g. the path ends in Mobile Bay). Only for a path that starts at
  // sea: once the center is inland its own position is not a forecast landfall.
  const b = path.length && !coastHit(path[0]) ? path.find(coastHit) : null;
  return b ? { lat: b.lat, lonW: b.lonW, t: b.t, wind: b.wind ?? null, crossing: false } : null;
}
// For the location text only: over land, either inside the coastline or north of the northern Gulf coast.
const overLand = (p) => coastHit(p) || (p.lat > 31 && p.lonW >= 82 && p.lonW <= 100);
const nearestTown = (p) => TOWNS.map(([name, lat, lonW]) => [name, Math.hypot(lat - p.lat, (lonW - p.lonW) * Math.cos(p.lat * Math.PI / 180))]).sort((a, b) => a[1] - b[1])[0][0];
const category = (kt) => (kt >= 137 ? 5 : kt >= 113 ? 4 : kt >= 96 ? 3 : kt >= 83 ? 2 : kt >= 64 ? 1 : 0);
const compass = (deg) => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(deg / 22.5) % 16];
// Rounded to the nearest hour: these are estimates, and the page rounds the same way.
const fmtCT = (iso) => new Date(Math.round(new Date(iso).getTime() / 3600e3) * 3600e3).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric' }) + ' CT';

// ---------- gather ----------

export async function gatherStorms(prior) {
  const feed = await get('storms.json', 'https://www.nhc.noaa.gov/CurrentStorms.json', true);
  if (!feed || !Array.isArray(feed.activeStorms)) throw new Error('CurrentStorms.json malformed');
  const prevById = new Map((prior?.storms || []).map((p) => [p.id, p]));
  const priorLandfallFor = (id) => (prior?.landfall && prior.storms?.[0]?.id === id ? prior.landfall : null);
  // Strict numbers: null, "" and "n/a" are missing values, never zero (a 0N 0W fix or 0 kt would be invented data).
  const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  const out = [];
  const incomplete = []; // Atlantic records we could not read or judge: the feed is then "incomplete", not authoritative
  const atlantic = feed.activeStorms.filter((s) => /^al\d{6}$/i.test(s.id || '')); // Atlantic basin only; never Pacific
  const whenOf = (s) => (s.lastUpdate && !Number.isNaN(Date.parse(s.lastUpdate)) ? s.lastUpdate : s.forecastAdvisory?.issuance || null);
  // Forecast tracks, all fetched at once: a stalled advisory page costs its own two attempts, not the sum over every storm.
  // null means "could not get it this run", distinct from a storm with no coastal threat.
  const tracks = new Map(await Promise.all(atlantic.map(async (s) => {
    let track = null;
    try {
      if (s.forecastAdvisory?.url) track = parseTCM(await get(`tcm-${s.id}.html`, s.forecastAdvisory.url), s.forecastAdvisory.issuance || whenOf(s), { id: s.id, advNum: s.forecastAdvisory.advNum });
      if (s.forecastAdvisory?.url && track === null) console.warn(`forecast advisory for ${s.id} could not be read (wrong storm/advisory or unreadable positions)`);
    } catch (e) { console.warn(`forecast advisory for ${s.id} unavailable: ${e.message}`); }
    return [s, track];
  })));
  for (const s of atlantic) {
    const prev = prevById.get(s.id);
    const lat = num(s.latitudeNumeric), lon = num(s.longitudeNumeric);
    const posOK = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    if (!posOK && !prev) { console.warn(`storm ${s.id}: no usable position; record skipped`); incomplete.push(s.id); continue; }
    const when = whenOf(s);
    const here = posOK ? { t: when || NOW.toISOString(), lat, lonW: -lon, ...(Number.isFinite(num(s.intensity)) ? { wind: num(s.intensity) } : {}) } : null;
    const track = tracks.get(s);
    const forecastStale = track === null;
    const path = [...(here ? [here] : []), ...(track || [])];
    const relevant = path.some(inGulf) || path.some(coastHit) || (forecastStale && !!prev);
    if (!relevant) {
      // A new storm near the Gulf whose forecast could not be read cannot be judged from its position alone: its
      // relevance is unknown (the feed is incomplete), not "not a Gulf system".
      if (forecastStale && here && nearGulf(here)) { console.warn(`storm ${s.id}: forecast unreadable near the Gulf; relevance unknown`); incomplete.push(s.id); }
      continue; // not a Gulf system
    }
    const windsRaw = num(s.intensity);
    const winds = Number.isFinite(windsRaw) && windsRaw >= 0 ? windsRaw : (prev?.winds ?? 0);
    const known = s.classification in TYPES;
    const type = known ? TYPES[s.classification] : (/^(PTC|EX|LO|DB|WV|SD|SS)$/.test(s.classification || '') ? 'Post-Tropical Cyclone' : 'Tropical Cyclone');
    if (!known && type === 'Tropical Cyclone') console.warn(`storm ${s.id}: unknown classification "${s.classification}"; treated as tropical`);
    // Once the center is ashore there is no forecast landfall to report (the observed landfall record carries the story),
    // unless the forecast takes it back over water and across the coast again.
    const inland = !!here && ashore(here);
    const hit = forecastStale ? null : landfallPoint(path);
    const landfall = forecastStale ? (inland ? null : priorLandfallFor(s.id)) : hit && { state: coastState(hit), eta: hit.t, near: nearestTown(hit), windKt: hit.wind ?? null };
    const loc = here ? `${here.lat.toFixed(1)}N ${here.lonW.toFixed(1)}W` + (overLand(here) ? ', inland' : inGulf(here) ? (here.lat < 22 && here.lonW >= 90 ? ', Bay of Campeche' : ', Gulf') : ', approaching the Gulf') : `${prev?.location || 'position unavailable'} (last known)`;
    out.push({
      id: s.id, bin: s.binNumber, name: `${type} ${s.name}`, type, winds,
      category: s.classification === 'HU' ? category(winds) : 0,
      tropical: known || type === 'Tropical Cyclone',
      location: loc,
      movement: Number.isFinite(num(s.movementSpeed)) && num(s.movementSpeed) > 0 && Number.isFinite(num(s.movementDir)) ? `${compass(num(s.movementDir))} at ${Math.round(num(s.movementSpeed) * 1.15078)} mph`
        : Number.isFinite(num(s.movementSpeed)) ? 'Stationary' : (prev?.movement || 'Motion unavailable'),
      advisory: s.forecastAdvisory?.advNum ? `NHC advisory ${String(s.forecastAdvisory.advNum).replace(/^0+(?=\d)/, '')}` : '', // "002" -> "2", as NHC's map service writes it
      advisoryAt: s.forecastAdvisory?.issuance || when || null,
      landfall,
      ashore: here && ashore(here) ? { state: coastState(here), t: here.t } : null,
      pos: here ? { lat: here.lat, lonW: here.lonW } : prev?.pos || null,
      posAt: here ? here.t : prev?.posAt || null, // time of that fix (intermediate advisories move it between forecast advisories)
      forecast: track === null ? prev?.forecast || [] : track, // [] is a verified "no track", never replaced by an old one
      forecastStale,
      gulfRisk: forecastStale
        ? (prev?.gulfRisk ? `${prev.gulfRisk.replace(/ \(latest forecast advisory unavailable\)$/, '')} (latest forecast advisory unavailable)` : 'Forecast advisory unavailable')
        : hit ? `Forecast track reaches the coast near ${nearestTown(hit)} around ${fmtCT(hit.t)} (approximate)`
        : inland ? 'The center is over land'
        : track.length ? 'Forecast track stays off the AL/FL/MS/LA coast through the forecast period' : 'No forecast track in the latest advisory',
    });
  }
  const discussions = Object.fromEntries(feed.activeStorms.filter((s) => s.forecastDiscussion?.url).map((s) => [s.id, s.forecastDiscussion]));
  return Object.assign(out.sort((a, b) => (a.landfall ? 0 : 1) - (b.landfall ? 0 : 1) || b.winds - a.winds), { incomplete, discussions });
}

export async function gatherAlerts(prior, gulfStorm) {
  const ww = { note: '', unavailable: [] };
  await Promise.all(STATES.map(async (st) => {
    try {
      const j = await get(`alerts-${st}.json`, `https://api.weather.gov/alerts/active?area=${st}`, true);
      if (!j || !Array.isArray(j.features)) throw new Error('alerts feed malformed (no features array)');
      // Only real alerts: the active feed also carries Test, Exercise and Draft messages, and cancellations.
      const actual = j.features.filter((f) => (f.properties?.status ?? 'Actual') === 'Actual' && f.properties?.messageType !== 'Cancel');
      const events = [...new Set(actual.map((f) => f.properties?.event).filter((e) => TROPICAL_EVENTS.test(e || '')))];
      // Florida also has an Atlantic coast; only count its alerts while a Gulf storm exists.
      if (!events.length || (st === 'FL' && !gulfStorm)) ww[st] = {};
      else ww[st] = { level: events.some((e) => /Warning$/.test(e)) ? 'warning' : 'watch', text: events.sort().join(', ') };
    } catch (e) {
      console.warn(`alerts for ${st} unavailable: ${e.message}`);
      ww[st] = prior?.watchesWarnings?.[st] || {}; // keep what we knew; never clear a warning on a failed read
      ww.unavailable.push(st);
    }
  }));
  ww.unavailable = STATES.filter((s) => ww.unavailable.includes(s)); // fixed order
  if (!ww.unavailable.length) delete ww.unavailable;
  return ww;
}

// Map layers from NOAA's tropical map service, as one GeoJSON collection tagged by role.
// Storm stage: forecast track and points, past track, coastal watch/warning lines (no cone; see the page).
// Disturbance stage: NHC's 7-day development area, current location, and motion arrow.
const MAPSRV = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';

async function layer(id, name) {
  const j = await getOpt(`map-${name}.json`, `${MAPSRV}/${id}/query?where=1%3D1&outFields=*&f=geojson&geometryPrecision=2`, true);
  if (!j || !Array.isArray(j.features)) throw new Error(`map layer ${name} malformed`);
  return j.features.filter((f) => f.geometry);
}
// Each layer on its own: one failing layer yields an empty list and a note, not a failed map.
async function layers(specs) {
  const res = await Promise.allSettled(specs.map(([id, name]) => layer(id, name)));
  const failed = specs.filter((_, i) => res[i].status === 'rejected').map(([, name]) => name);
  res.forEach((r, i) => { if (r.status === 'rejected') console.warn(`map layer ${specs[i][1]} unavailable: ${r.reason?.message || r.reason}`); });
  return { lists: res.map((r) => (r.status === 'fulfilled' ? r.value : [])), failed };
}

const flat = (c) => (typeof c[0] === 'number' ? [c] : c.flatMap(flat));
const touchesGulf = (f) => flat(f.geometry.coordinates).some(([lon, lat]) => inGulf({ lat, lonW: -lon }));
const feat = (f, role, props = {}) => ({ type: 'Feature', geometry: f.geometry, properties: { role, ...props } });

export async function gatherMap(gulf, storm) {
  const features = [];
  if (storm && /^AT[1-5]$/.test(storm.bin || '')) {
    const base = 4 + 26 * (+storm.bin[2] - 1);
    // The cone is not fetched: the page draws the spread of model tracks as the uncertainty instead.
    const { lists: [pts, track, ww, past], failed } = await layers([[base + 2, 'points'], [base + 3, 'track'], [base + 5, 'ww'], [base + 8, 'past']]);
    // With every layer down the text advisory still gives the current track (below); only without one is there no map.
    if (failed.length === 4 && (storm.forecastStale || !storm.forecast?.length || !storm.pos)) throw new Error('all storm map layers unavailable');
    const adv = pts[0]?.properties.advisnum;
    // The watch/warning lines belong to the newest advisory in their own layer when the points layer is missing.
    const wwAdv = adv ?? ww.map((f) => f.properties.advisnum).filter((a) => a != null).sort((a, b) => parseInt(b, 10) - parseInt(a, 10))[0];
    past.forEach((f) => features.push(feat(f, 'past')));
    track.forEach((f) => features.push(feat(f, 'track')));
    ww.filter((f) => f.properties.advisnum === wwAdv).forEach((f) => features.push(feat(f, 'ww', { kind: f.properties.tcww })));
    pts.forEach((f) => features.push(feat(f, 'point', {
      label: `${f.properties.datelbl} ${f.properties.timezone || ''}`.trim(), wind: f.properties.maxwind,
      type: f.properties.tcdvlp, cat: f.properties.ssnum, now: f.properties.tau === 0,
    })));
    let source = `NHC advisory ${adv ?? ''}`.trim();
    if (!track.length && storm.forecast?.length && storm.pos) {
      // The map service has not caught up with the advisory yet (or its track layer failed): draw the track from the text advisory itself.
      const line = [[-storm.pos.lonW, storm.pos.lat], ...storm.forecast.map((q) => [-q.lonW, q.lat])];
      features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: { role: 'track' } });
      if (!pts.length) {
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: line[0] }, properties: { role: 'point', label: 'now', wind: storm.winds, now: true } });
        storm.forecast.forEach((q) => features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [-q.lonW, q.lat] }, properties: { role: 'point', label: new Date(q.t).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric' }), wind: q.wind ?? null, now: false } }));
      }
      source = `${storm.advisory || 'NHC advisory'} (track from the text advisory; ${failed.length === 4 ? 'map layers unavailable' : failed.length ? 'some map layers unavailable' : 'cone not yet published'})`;
    } else if (failed.length) source += ` (${failed.join(', ')} layer${failed.length > 1 ? 's' : ''} unavailable)`;
    // Identity, so a reader (or the page) can tell which storm and advisory this map belongs to.
    return { kind: 'storm', name: storm.name, storm: storm.id, advisory: adv != null ? String(adv) : (storm.advisory || '').replace(/^NHC advisory\s*/, '') || null, advisoryAt: storm.advisoryAt || null, source, features, ...(failed.length ? { unavailable: failed } : {}) };
  }
  if (gulf) {
    const { lists: [areas, pts, motion], failed } = await layers([[3, 'areas'], [2, 'origins'], [398, 'motion']]);
    if (failed.length === 3) throw new Error('all outlook map layers unavailable');
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
    const pts = [...t.pts.entries()].sort((a, b) => a[0] - b[0]);
    tracks.push({ tech, group: modelGroup(tech), name: (MODEL_NAMES.find(([re]) => re.test(tech)) || [0, tech])[1], init: t.date,
      coords: pts.map(([, p]) => p), times: pts.map(([tau]) => new Date(cycleMs(t.date) + tau * 3600e3).toISOString()) });
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

async function gatherModels(gulf, storm, invest) {
  let files = [];
  if (storm) files = [`a${storm.id}.dat.gz`];
  else if (gulf) {
    // Before a storm is named, guidance is filed under an "Invest" number (AL90-AL99). The Invest NHC named for
    // this system comes first; otherwise find a fresh one in the Gulf.
    const named = /^Invest (9\d)L$/.exec(invest || '');
    if (named) files.push(...investYears().map((y) => `aal${named[1]}${y}.dat.gz`));
    try {
      const list = await getOpt('adeck-list.html', ADECK);
      const re = new RegExp(`href="(aal9\\d(?:${investYears().join('|')})\\.dat\\.gz)">[^<]*</a>\\s+(\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d)`, 'g');
      files.push(...[...list.matchAll(re)].filter((m) => NOW - new Date(m[2].replace(' ', 'T') + 'Z') < 36 * 3600e3).map((m) => m[1]).filter((f) => !files.includes(f)));
    } catch (e) { if (!files.length) throw e; }
  }
  let lastErr = null, readOne = false; // one unreadable file (e.g. last year's name for this Invest) does not end the search
  for (const f of files) {
    if (Date.now() > OPT_DEADLINE) throw new Error('model guidance skipped: time budget used up');
    let d;
    try { d = parseAdeck(gunzipSync(await getBuf(`adeck-${f}`, ADECK + f)).toString('latin1')); readOne = true; } catch (e) { lastErr = e; continue; }
    if (!d || !d.tracks.length || NOW - cycleMs(d.init) > 24 * 3600e3) continue;
    if (!storm && !(d.origin && inGulf(d.origin))) continue;
    const invest = storm ? null : `Invest ${f.slice(3, 5)}L`;
    // NHC's own past-track layer takes over once advisories start; before that, draw it from the best-track file.
    const history = await gatherHistory(f).catch((e) => { console.warn(`past track unavailable: ${e.message}`); return { features: [], winds: null }; });
    const run = new Date(cycleMs(d.init)).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric' }) + ' CT';
    return {
      invest, winds: history.winds, history: history.features, label: `${d.tracks.length} model tracks, latest run ${run}`,
      features: d.tracks.map((t) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: t.coords }, properties: { role: 'model', tech: t.tech, name: t.name, group: t.group, init: t.init, times: t.times } })),
    };
  }
  if (lastErr && !readOne) throw lastErr; // nothing could be read at all: "unavailable", not "no guidance"
  return null;
}
// Invest file names carry the year it was designated: in January, an Invest from December keeps last year's.
export const investYears = (now = NOW) => (now.getUTCMonth() === 0 ? [now.getUTCFullYear(), now.getUTCFullYear() - 1] : [now.getUTCFullYear()]);

// "Daniel's Average": one line averaging the map's default tracks (NHC official, each consensus / ensemble-mean family
// once, Google DeepMind, and the two Euro typical paths) at matching valid times. Each track is first shifted to start
// at the storm's current position, the shift fading out over 48 hours (as NHC's interpolated aids do), so the line
// starts on the storm. It runs while at least 60% of the tracks (and 3 or more) still have a position. Display only.
const AVG_FAMILIES = [[/^TVC/, 'TVCN consensus'], [/^HCCA$/, 'HCCA consensus'], [/^GFEX$/, 'GFS/European consensus'], [/^AEM/, 'GEFS ensemble mean'], [/^CEM/, 'Canadian ensemble mean'], [/^(EEM|EMN)/, 'European ensemble mean (NHC file)'], [/^GDM/, 'Google DeepMind AI']];
export function danielsAverage({ start, official = [], models = [], euro = [] }) {
  if (!start || !Number.isFinite(Date.parse(start.t))) return null;
  const t0 = Date.parse(start.t);
  const trim = (pts) => { const a = pts.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.lat) && Number.isFinite(p.lonW)).sort((x, y) => x.t - y.t);
    while (a.length > 1 && a[a.length - 1].lat === a[a.length - 2].lat && a[a.length - 1].lonW === a[a.length - 2].lonW) a.pop(); // a track held at its end point
    return a; };
  const tracks = [];
  if (official.length) tracks.push({ name: 'NHC official', pts: trim([{ t: t0, lat: start.lat, lonW: start.lonW }, ...official.map((q) => ({ t: Date.parse(q.t), lat: q.lat, lonW: q.lonW }))]) });
  for (const [re, name] of AVG_FAMILIES) {
    const fam = models.filter((f) => re.test(f.tech || '') && Array.isArray(f.times) && f.times.length === f.coords.length)
      .sort((a, b) => (b.init || '').localeCompare(a.init || '') || (/[N]$|^HCCA$|^GFEX$/.test(b.tech) ? 1 : 0) - (/[N]$|^HCCA$|^GFEX$/.test(a.tech) ? 1 : 0));
    if (fam[0]) tracks.push({ name, pts: trim(fam[0].coords.map(([lon, lat], i) => ({ t: Date.parse(fam[0].times[i]), lat, lonW: -lon }))) });
  }
  for (const e of euro) tracks.push({ name: e.name, pts: trim(e.coords.map(([lon, lat], i) => ({ t: Date.parse(e.run) + e.hours[i] * 3600e3, lat, lonW: -lon }))) });
  // A run that starts a few hours after the storm's fix (NHC files the next cycle's early aids before the advisory that
  // uses them, and the a-deck keeps only the newest run) is anchored at the storm: it runs from the fix to its own start.
  for (const k of tracks) if (k.pts.length && k.pts[0].t > t0 && k.pts[0].t - t0 <= 6 * 3600e3) k.pts.unshift({ t: t0, lat: start.lat, lonW: start.lonW });
  const at = (pts, t) => { if (!pts.length || t < pts[0].t || t > pts[pts.length - 1].t) return null;
    for (let i = 1; i < pts.length; i++) if (t <= pts[i].t) { const a = pts[i - 1], b = pts[i], f = (t - a.t) / (b.t - a.t || 1); return { lat: a.lat + (b.lat - a.lat) * f, lonW: a.lonW + (b.lonW - a.lonW) * f }; }
    return pts.length === 1 && pts[0].t === t ? pts[0] : null; };
  const usable = tracks.filter((k) => k.pts.length >= 2 && at(k.pts, t0));
  if (usable.length < 3) return null;
  for (const k of usable) { const p = at(k.pts, t0); k.dLat = start.lat - p.lat; k.dLon = start.lonW - p.lonW; }
  const need = Math.max(3, Math.ceil(0.6 * usable.length));
  const path = [{ t: new Date(t0).toISOString(), lat: start.lat, lonW: start.lonW, n: usable.length }];
  for (let h = 6; h <= 168; h += 6) {
    const t = t0 + h * 3600e3, fade = Math.max(0, 1 - h / 48);
    const ps = usable.map((k) => { const p = at(k.pts, t); return p && { lat: p.lat + k.dLat * fade, lonW: p.lonW + k.dLon * fade }; }).filter(Boolean);
    if (ps.length < need) break;
    path.push({ t: new Date(t).toISOString(), lat: +(ps.reduce((a, p) => a + p.lat, 0) / ps.length).toFixed(2), lonW: +(ps.reduce((a, p) => a + p.lonW, 0) / ps.length).toFixed(2), n: ps.length });
  }
  if (path.length < 3) return null;
  const hit = landfallPoint(path);
  return { path, members: usable.map((k) => k.name), landfall: hit ? { state: coastState(hit), near: nearestTown(hit), eta: hit.t, lat: +hit.lat.toFixed(2), lonW: +hit.lonW.toFixed(2) } : null };
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
      ` ${hurricane} of ${n} reach hurricane strength${major ? ` (${major} major)` : ''}; typical peak ${mph(median(peaks))} mph.`,
  };
}

async function gatherGoogle(storm, invest) {
  const ids = [storm && storm.id.toUpperCase(), ...(invest ? investYears().map((y) => `AL${invest.replace(/\D/g, '')}${y}`) : [])].filter(Boolean);
  if (!ids.length) return null;
  // Runs start every 6 hours and are posted several hours later; take the newest one available.
  for (let k = 0; k < 5; k++) {
    if (Date.now() > OPT_DEADLINE) throw new Error('Google ensemble skipped: time budget used up');
    const init = new Date(Math.floor(NOW.getTime() / (6 * 3600e3) - k) * 6 * 3600e3);
    const stamp = init.toISOString().slice(0, 13).replace(/-/g, '_') + '_00';
    let csv;
    try { csv = await getOpt('google.csv', `${WEATHERLAB}FNV3_${stamp}_paired.csv`); } catch (e) { if (FIX) throw e; continue; }
    return summarizeGoogle(csv, ids, init.toISOString());
  }
  return null;
}

// ---------- decide ----------

const lcFirst = (t) => String(t || '').replace(/^./, (c) => c.toLowerCase()); // mid-sentence, keeping town names and times as written

export function build(prior, gulf, storms, ww) {
  const storm = storms[0] || null;
  const anyAlert = STATES.some((s) => ww[s].level);
  const landfall = storm?.landfall || null;
  // Expected: the forecast puts the center on the coast within 24 hours. Occurred: the center has been observed
  // on or past the coastline; that starts the 48-hour "landfall" hold (an expectation alone does not).
  const imminent = !!(landfall && new Date(landfall.eta).getTime() - NOW.getTime() <= 24 * 3600e3);
  // The occurrence is a durable record bound to the storm that made it: the 48-hour hold runs from its observed
  // time and is never restarted by the same storm sitting inland after the hold expires. A different storm, or a
  // storm with no record yet, can create a new one; a record from another storm does not apply.
  const pi = prior?.internal || {};
  let rec = pi.landfallAt ? { state: pi.landfallState, at: pi.landfallAt, stormId: pi.landfallStormId || null } : null;
  const forThisStorm = !!rec && (!storm || !rec.stormId || rec.stormId === storm.id);
  if (storm?.ashore && !forThisStorm) {
    const t = storm.ashore.t && !Number.isNaN(Date.parse(storm.ashore.t)) ? storm.ashore.t : NOW.toISOString();
    rec = { state: storm.ashore.state, at: t, stormId: storm.id };
  }
  const applies = !!rec && (!storm || !rec.stormId || rec.stormId === storm.id);
  const heldNow = applies && NOW.getTime() - new Date(rec.at).getTime() < 48 * 3600e3;
  // Reported while the hold runs, and for as long as the storm that made it is still being tracked.
  const occurred = applies && (heldNow || storm) ? { state: rec.state, at: rec.at } : null;
  const held = !!occurred && heldNow;

  let alertLevel = 'quiet';
  if (gulf || storm) alertLevel = 'watch';
  if ((storm?.tropical && landfall) || anyAlert) alertLevel = 'threat';
  if (imminent || held) alertLevel = 'landfall';

  let headline;
  if (storm) {
    headline = (occurred ? `${storm.name} made landfall in ${occurred.state} around ${fmtCT(occurred.at)}. ` : '') +
      `${storm.name}: ${mph(storm.winds)} mph${storm.category ? ` (Category ${storm.category})` : ''}, ${storm.location}, moving ${storm.movement}. ${storm.gulfRisk}.`;
  } else if (occurred) {
    headline = `Made landfall in ${occurred.state} around ${fmtCT(occurred.at)}; the system is no longer an active NHC storm.`;
  } else if (gulf) {
    headline = `NHC gives the ${gulf.area} disturbance a ${gulf.formation7d}% chance of forming within 7 days (${gulf.formation48}% within 48 hours). No advisories or forecast track yet.`;
  } else {
    headline = 'No Gulf disturbance in the NHC outlook and no Gulf storm.';
  }
  if (anyAlert) headline += ` Tropical alerts in effect: ${STATES.filter((s) => ww[s].level).map((s) => `${s} (${ww[s].text})`).join('; ')}.`;
  const others = storms.slice(1).filter((o) => !o.other || true);
  if (others.length) headline += ` Also in the Gulf: ${others.map((o) => `${o.name} (${mph(o.winds)} mph; ${lcFirst(o.gulfRisk)})`).join('; ')}.`;

  return {
    updatedAt: NOW.toISOString(), // time of the last successful reading (an outage keeps the old value; see lastAttemptAt)
    lastAttemptAt: NOW.toISOString(),
    nextCheck: nextCheckAt(NOW), // GitHub checks at :05, the Mac backup at :35
    alertLevel, headline,
    gulf: gulf || { area: '', formation48: null, formation7d: null, source: 'NHC outlook', text: storm ? 'NHC is issuing advisories on this system; see the storm panel.' : '' },
    // forecastStale and pos stay so the page and diff can see them; bin and the forecast points stay so the map can be
    // rebuilt for the same storm while the storm feed is down.
    storms: storms.map(({ landfall: _l, tropical: _t, ashore: _a, ...s }) => s),
    watchesWarnings: ww,
    landfall, // forecast landfall (expected)
    landfallOccurred: occurred,
    internal: {
      failCount: 0,
      // The baseline is the reading at the last alert. When the odds series (re)starts (no odds in the previous reading),
      // the first reading is the baseline: a number left over from an earlier system never is.
      baseline7d: prior?.gulf?.formation7d == null ? gulf?.formation7d ?? null : prior?.internal?.baseline7d ?? gulf?.formation7d ?? null,
      baseline48: prior?.gulf?.formation48 == null ? gulf?.formation48 ?? null : prior?.internal?.baseline48 ?? gulf?.formation48 ?? null,
      landfallAt: rec?.at || null,
      landfallStormId: rec?.stormId || null,
      landfallHoldUntil: held ? new Date(new Date(occurred.at).getTime() + 48 * 3600e3).toISOString() : null,
      landfallState: rec?.state || (imminent ? landfall.state : null),
    },
  };
}

// What counts as a change worth a push. Wording-only outlook edits do not.
export function diff(prior, cur) {
  const ch = [];
  if (!prior) return ch;
  if (prior.alertLevel !== cur.alertLevel) ch.push(`Alert level ${LEVEL_LABEL[prior.alertLevel] || prior.alertLevel} -> ${LEVEL_LABEL[cur.alertLevel] || cur.alertLevel}`);

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

  // Announced once: an Invest number already known for the tracked system is not a new designation.
  if (cur.gulf?.invest && cur.gulf.invest !== prior.gulf?.invest && cur.gulf.invest !== prior.tracked?.invest) ch.push(`NHC designated the system ${cur.gulf.invest}`);

  // Another system announced below as a coastal threat is not also announced as a new Gulf system.
  const othersNew = (cur.others || []).filter((o) => o.threat && !(prior.internal?.othersAlerted || []).includes(o.id));
  const ps = new Map((prior.storms || []).map((s) => [s.id, s]));
  const cs = new Map(cur.storms.map((s) => [s.id, s]));
  for (const [id, s] of cs) {
    const p = ps.get(id);
    if (!p) { if (!othersNew.some((o) => o.id === id)) ch.push(`${s.name} is now a Gulf system (${mph(s.winds)} mph)`); }
    else if (p.type !== s.type) ch.push(`${p.name} is now ${s.name}`);
    else if ((p.category || 0) !== (s.category || 0)) ch.push(`${s.name} is now Category ${s.category} (${mph(s.winds)} mph)`);
  }
  for (const [id, p] of ps) if (!cs.has(id)) ch.push(`${p.name} is no longer an active Gulf storm`);

  for (const st of STATES) {
    const px = prior.watchesWarnings?.[st] || {}, cx = cur.watchesWarnings[st] || {};
    const x = px.level || null, y = cx.level || null;
    if (x !== y) ch.push(y ? `${st}: tropical ${y} posted (${cx.text})` : `${st}: tropical ${x} dropped`);
    else if (y && (px.text || '') !== (cx.text || '')) ch.push(`${st}: alerts now ${cx.text} (was ${px.text})`);
  }

  for (const o of othersNew) ch.push(`Another Gulf system: ${o.name} ${o.detail}`);

  // Announced when the record is made; a record restored for a storm that returns to the feed later is not news.
  if (cur.landfallOccurred && !prior.landfallOccurred && cur.internal?.landfallAt !== prior.internal?.landfallAt) ch.push(`Landfall in ${cur.landfallOccurred.state} around ${fmtCT(cur.landfallOccurred.at)}`);

  // Forecast landfalls are compared only for the same storm: a storm that takes over starts its own story.
  const pl = sameStorm(prior, cur) ? prior.landfall : null, cl = cur.landfall;
  if (cl && !pl) ch.push(`Forecast track now reaches the coast near ${cl.near || cl.state} around ${fmtCT(cl.eta)}`);
  // Once the center is ashore the forecast landfall ends because it happened, not because the track moved away.
  else if (pl && !cl && cur.storms.length && !cur.storms[0].forecastStale && !cur.landfallOccurred) ch.push('Forecast track no longer reaches the AL/FL/MS/LA coast');
  else if (pl && cl) {
    if (pl.state !== cl.state) ch.push(`Forecast landfall shifted ${pl.state} -> ${cl.state}, near ${cl.near || cl.state} (${fmtCT(cl.eta)})`);
    else if (Math.abs(new Date(pl.eta) - new Date(cl.eta)) >= 12 * 3600e3) ch.push(`Forecast ${cl.state} landfall (near ${cl.near || cl.state}) timing moved to ${fmtCT(cl.eta)}`);
  }
  return ch;
}

const sameStorm = (a, b) => (a?.storms?.[0]?.id || null) === (b?.storms?.[0]?.id || null);

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
    if (p && p.advisory && s.advisory && p.advisory !== s.advisory) notes.push(`${s.advisory} issued`);
    if (p && p.type === s.type && (p.category || 0) === (s.category || 0) && p.winds !== s.winds) notes.push(`${s.name} winds ${mph(p.winds)} -> ${mph(s.winds)} mph`);
  }
  const pl = sameStorm(prior, cur) ? prior.landfall : null, cl = cur.landfall;
  if (pl && cl && pl.state === cl.state && pl.eta !== cl.eta && Math.abs(new Date(pl.eta) - new Date(cl.eta)) >= 3600e3) notes.push(`forecast landfall near ${cl.near || cl.state} now ${fmtCT(cl.eta)} (was ${fmtCT(pl.eta)})`);
  if (pl && cl && pl.near && cl.near && pl.near !== cl.near && pl.state === cl.state) notes.push(`forecast landfall now near ${cl.near} (was ${pl.near})`);
  return notes;
}

// ---------- output ----------

async function notify(title, message, level, topic = process.env.NTFY_TOPIC) {
  if (!title) return true; // nothing to send on this channel
  // Not configured: nothing to retry. The body can carry the owner's private text, so it is never printed (Actions logs are public).
  if (!topic) { console.log(`[no ntfy topic configured; not sent] ${title}`); return null; }
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

// Device identity for retry bookkeeping: the same SHA-256 of the endpoint the worker keys on. Only these hashes
// are ever written to the public status file, never endpoints or keys.
async function deviceKey(endpoint) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Browser notifications: devices register with the Cloudflare worker (push/worker.js); we send to them here.
// Returns per-device outcomes: configured (env present), total devices, sent, failed (device keys with a
// transient failure, to retry), dead (expired registrations, pruned). `only` limits a retry to the devices that missed.
async function pushBrowsers(title, body, only = null) {
  const { PUSH_API, PUSH_ADMIN_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, PAGE_URL } = process.env;
  const out = { configured: false, total: 0, sent: 0, failed: [], dead: 0 };
  if (!PUSH_API || !PUSH_ADMIN_KEY || !VAPID_PRIVATE_KEY) return out;
  out.configured = true;
  const webpush = (await import('web-push').catch(() => null))?.default;
  if (!webpush) throw new Error('web-push not installed; browser notifications skipped');
  webpush.setVapidDetails(PAGE_URL || 'https://dhale2909.github.io/gulf-storm-watch/', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  const r = await fetch(`${PUSH_API}/subscriptions`, { headers: { 'x-key': PUSH_ADMIN_KEY }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`subscriber list -> HTTP ${r.status}`);
  let subs = await r.json();
  if (!Array.isArray(subs)) throw new Error('subscriber list malformed');
  const keyed = await Promise.all(subs.map(async (s) => [await deviceKey(String(s.endpoint || '')), s]));
  const targets = only ? keyed.filter(([k]) => only.includes(k)) : keyed;
  out.total = targets.length;
  const dead = [], settled = new Set();
  let done = false;
  // No title: a payload-free push, which the page's service worker shows as its test notification (never as an alert).
  const payload = title ? JSON.stringify({ title, body, url: PAGE_URL }) : null;
  const sends = Promise.all(targets.map(async ([k, s]) => {
    try { await webpush.sendNotification(s, payload, { TTL: 6 * 3600, urgency: 'high', timeout: 20000 }); if (!done) out.sent++; }
    catch (e) {
      if (done) return;
      // Gone for good: the service says so (404/410), or the device's keys can never be encrypted to (no status; never a
      // network error). Any other status, our own VAPID key problems included, stays a retryable failure.
      if (e.statusCode === 404 || e.statusCode === 410 || (!e.statusCode && /p256dh|\bauth\b|public key|curve/i.test(e.message || ''))) dead.push(s.endpoint);
      else { out.failed.push(k); console.warn(`browser push failed for one device: ${e.statusCode || e.message}`); }
    } finally { settled.add(k); }
  }));
  // One stalled push service must not hold up the public feed or the save: a device still pending at the deadline counts
  // as failed, and the next check retries it.
  let timer;
  await Promise.race([sends, new Promise((r) => { timer = setTimeout(r, Number(process.env.PUSH_DEADLINE_MS) || 60000); timer.unref?.(); })]);
  clearTimeout(timer); done = true;
  for (const [k] of targets) if (!settled.has(k)) { out.failed.push(k); console.warn('browser push timed out for one device'); }
  out.failed = [...out.failed];
  out.dead = dead.length;
  if (dead.length) await fetch(`${PUSH_API}/prune`, { method: 'POST', headers: { 'x-key': PUSH_ADMIN_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ endpoints: dead }), signal: AbortSignal.timeout(30000) }).catch(() => {});
  console.log(`browser notifications: ${out.sent} of ${out.total} sent, ${out.failed.length} failed, ${dead.length} expired removed`);
  return out;
}

// The alert text is built from public weather facts (the same ones the page shows). The private channel adds
// the owner's action text from PLAYS_JSON at send time only, so it is never written to a file.
const CHANNELS = ['private', 'browser', 'public'];
export function composeMessage(ev) {
  const plays = (() => { try { return JSON.parse(process.env.PLAYS_JSON || '{}'); } catch { return {}; } })();
  const play = plays[ev.level] ? `\n\nPlay: ${plays[ev.level]}` : '';
  const goog = ev.google ? `\n\nGoogle AI ensemble (experimental, not a forecast): ${ev.google}` : '';
  const body = `${ev.changes.join('. ')}.\n\n${ev.headline}`;
  return {
    level: ev.level,
    privateTitle: `Gulf Storm Watch: ${LEVEL_LABEL[ev.level]}`, privateBody: `${body}${goog}${play}`,
    // Public subscribers get the same change, weather facts only: browser notifications and the public ntfy feed.
    publicTitle: `Daniel's Storm Page: ${LEVEL_LABEL[ev.level]}`, publicBody: body,
  };
}

// Send one alert on the named channels (all configured ones by default). Each transport is isolated: one
// failing never stops the others or the save. Returns per channel: true (delivered), false (failed, retry),
// null (not configured / nobody to send to); browserFailed lists the devices a retry should target.
export async function deliver(msg, { channels = CHANNELS, browserOnly = null } = {}) {
  const r = { private: null, public: null, browser: null, browserFailed: [] };
  if (channels.includes('private')) { try { r.private = await notify(msg.privateTitle, msg.privateBody, msg.level); } catch (e) { r.private = false; console.warn(`private push failed: ${e.message}`); } }
  if (channels.includes('browser')) {
    try {
      const b = await pushBrowsers(msg.publicTitle, msg.publicBody, browserOnly);
      r.browser = !b.configured || !b.total ? null : b.failed.length === 0 ? true : false;
      r.browserFailed = b.failed;
    } catch (e) { r.browser = false; r.browserFailed = browserOnly || null; console.warn(`browser push failed: ${e.message}`); } // null: retry every device
  }
  if (channels.includes('public') && process.env.PUBLIC_NTFY_TOPIC) { try { r.public = await notify(msg.publicTitle, msg.publicBody, msg.level, process.env.PUBLIC_NTFY_TOPIC); } catch (e) { r.public = false; console.warn(`public push failed: ${e.message}`); } }
  return r;
}
const PENDING_ATTEMPTS = 3;

// Both runners (GitHub and the Mac backup) push to the same repository. If another check saved a newer reading
// while this one ran, sending from here would duplicate its alert: ask the repository right before sending.
async function remoteIsNewer(prior) {
  if (!prior?.lastAttemptAt && !prior?.updatedAt) return false;
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore', timeout: 5000 });
    execFileSync('git', ['fetch', '-q', 'origin', 'main'], { stdio: 'ignore', timeout: 20000 });
    const remote = JSON.parse(execFileSync('git', ['show', 'origin/main:data/status.json'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }));
    const mine = prior.lastAttemptAt || prior.updatedAt, theirs = remote.lastAttemptAt || remote.updatedAt;
    return !!theirs && theirs > mine;
  } catch { return false; } // not a git checkout (tests), or GitHub unreachable: carry on as the only runner
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
  if (process.env.TEST_PUSH) {
    const n = await pushBrowsers(null, null); // payload-free: shown as a test, never under the alert tag
    console.log(`test browser push: ${n.sent} of ${n.total} device(s)`);
    return;
  }
  if (process.env.TEST_NOTIFY) {
    const ok = await notify('Gulf Storm Watch: test', 'Test notification. If you can read this, storm alerts will reach this device.', 'watch');
    console.log(ok ? 'test push sent' : 'test push NOT sent');
    return;
  }

  const prior = await readJSON('data/status.json', null);
  // Gather the two NHC sources independently (and at the same time): an outlook outage must not hide a storm feed
  // that is fine, and vice versa.
  let gulf = null, storms = [], outlookOK = true, stormsOK = true, entries = [], stormsIncomplete = [];
  const [twoRes, feedRes] = await Promise.allSettled([
    get('two.html', 'https://www.nhc.noaa.gov/text/MIATWOAT.shtml').then(parseTWOAll),
    gatherStorms(prior),
  ]);
  if (twoRes.status === 'fulfilled') entries = twoRes.value; else { outlookOK = false; console.warn(`NHC outlook unavailable: ${twoRes.reason?.message || twoRes.reason}`); }
  if (feedRes.status === 'fulfilled') { storms = feedRes.value; stormsIncomplete = storms.incomplete || []; } else { stormsOK = false; console.warn(`NHC storm feed unavailable: ${feedRes.reason?.message || feedRes.reason}`); }
  const outage = !outlookOK && !stormsOK;
  const failCount = outage ? (prior?.internal?.failCount || 0) + 1 : 0;

  // ---- one tracked system (P3): keep following the same Invest / storm; anything else is "another system" ----
  const prevTracked = prior?.tracked || (prior?.gulf?.invest ? { invest: prior.gulf.invest, stormId: null } : prior?.storms?.[0] ? { invest: null, stormId: prior.storms[0].id } : null);
  const lastPos = prior?.tracked?.lastPos || prior?.storms?.[0]?.pos || null;
  const dist = (a, b) => (a && b ? Math.hypot(a.lat - b.lat, a.lonW - b.lonW) : Infinity);
  if (outlookOK) {
    // The outlook entry for our Invest by its (ALnn) tag; otherwise the strongest Gulf entry.
    gulf = (prevTracked?.invest && entries.find((e) => e.investHint === prevTracked.invest)) || entries[0] || null;
  }
  let otherEntries = outlookOK ? entries.filter((e) => e !== gulf) : [];
  // While NHC still lists our Invest in the outlook (by its tag) in an outlook issued after the storm's advisory,
  // it has not become a storm: a storm that appears elsewhere is another system, not ours. An outlook older than
  // the advisory is simply stale (the upgrade happened between outlooks), so the storm is adopted as before.
  const investEntry = prevTracked?.invest && outlookOK ? entries.find((e) => e.investHint === prevTracked.invest) : null;
  const investStillListed = !!(investEntry?.issuedAt && stormsOK && storms.every((s) => !s.advisoryAt || Date.parse(s.advisoryAt) < Date.parse(investEntry.issuedAt)));
  let replaced = false; // a different storm took over from the one we tracked: identity-bound state is reset
  let sideStorms = []; // Gulf storms that are not the tracked one
  if (stormsOK && storms.length) {
    let primary = prevTracked?.stormId ? storms.find((x) => x.id === prevTracked.stormId) : null;
    // Our Invest became a storm: adopt the Gulf storm closest to where the Invest was (or the only one).
    if (!primary && !prevTracked?.stormId && !investStillListed) primary = storms.length === 1 ? storms[0] : storms.slice().sort((a, b) => dist(a.pos, lastPos) - dist(b.pos, lastPos))[0];
    if (!primary && prevTracked?.stormId) { primary = storms[0]; replaced = true; } // previously tracked storm is gone; the remaining system takes over
    if (primary) storms = [primary, ...storms.filter((x) => x !== primary)];
    else { sideStorms = storms; storms = []; }
  }
  const carriedStorms = () => (prior?.storms || []).map((p, k) => ({ ...p, forecastStale: true, landfall: k === 0 ? prior.landfall : null, tropical: !/Post-Tropical/.test(p.type) }));
  // A failed source carries that part of the previous reading forward, flagged, rather than treating it as absent.
  if (!outlookOK) gulf = prior?.gulf?.area ? { ...prior.gulf, stale: true } : null;
  if (!stormsOK) storms = carriedStorms();

  // A tracked system that vanishes from both NHC feeds at once is more often a publication gap (outlook dropped
  // before the first advisory appears, or the reverse) than a real all-clear. Hold the previous reading for one
  // check; accept the disappearance only if it is still missing on the next one.
  const tracked = !!(prior && (prior.gulf?.area || prior.storms?.length));
  const nowEmpty = !gulf && storms.length === 0;
  const vanishedBefore = prior?.internal?.vanishedChecks || 0;
  // An Atlantic storm that could not be judged (no position, or an unreadable forecast near the Gulf) may be the tracked
  // system under its new name: hold while that lasts, up to three hours. The storm feed decides whether a storm is gone;
  // an unreadable outlook does not cancel the hold.
  const unresolved = stormsOK && stormsIncomplete.length > 0;
  const holding = tracked && nowEmpty && stormsOK && vanishedBefore < (unresolved ? 6 : 1);
  if (holding) {
    console.warn(unresolved ? 'a storm near the Gulf could not be read; holding the previous reading' : 'system missing from NHC feeds; holding the previous reading for one check to confirm');
    gulf = prior.gulf?.area ? { ...prior.gulf, stale: true } : null;
    storms = carriedStorms();
  }
  const carrying = !outlookOK || !stormsOK || holding; // some of the picture is the previous reading

  // Coastal watches and warnings come from NWS, a different service: read them whatever NHC did.
  const ww = await gatherAlerts(prior, storms.length > 0 || sideStorms.length > 0); // any Gulf storm, tracked or not

  const primary0 = () => storms[0] || null;
  // Optional layers, each bounded by the time budget: if a service is slow or down, keep the last map and carry on.
  const explicitInvest = gulf?.investHint || (!replaced && prevTracked?.invest) || null;
  let map = await optional('map layers', gatherMap(gulf, storms[0])).catch((e) => { console.warn(`map layers unavailable: ${e.message}`); return null; });
  const models = await optional('model guidance', gatherModels(gulf, storms[0], explicitInvest)).catch((e) => { console.warn(`model guidance unavailable: ${e.message}`); return undefined; });
  if (map && map.kind === 'none' && carrying) map = null; // never replace a storm map with "nothing to map" while the feeds are down
  if (map && models) {
    // One "now" position: once the best track exists, its latest fix replaces the outlook's X.
    const base = models.history?.length ? map.features.filter((f) => f.properties.role !== 'origin') : map.features;
    // Storm stage: NOAA's own past-track layer wins; the best-track file fills in until that layer is published.
    const hasPast = map.features.some((f) => f.properties.role === 'past');
    const hist = (models.history || [])
      .filter((f) => !(map.kind === 'storm' && hasPast && f.properties.role === 'past')) // NOAA's trail line replaces ours; the dots stay
      .map((f) => (map.kind === 'storm' && f.properties.role === 'pastpt' ? { ...f, properties: { ...f.properties, now: false } } : f));
    map.features = [...models.features, ...base, ...hist];
    map.models = models.label;
  }
  // Daniel's Average (storm stage): official track + default model tracks + the Euro typical paths from the last Euro run.
  if (map && map.kind === 'storm' && primary0()?.pos && primary0()?.advisoryAt) {
    const s0 = primary0();
    const ec = await readJSON('data/ecmwf.json', { ensembles: [] });
    const euro = (ec.ensembles || []).filter((e) => NOW - Date.parse(e.run) < 24 * 3600e3).flatMap((e) => e.features.filter((f) => f.properties.role === 'ecmean' && Array.isArray(f.properties.hours))
      .map((f) => ({ name: e.key === 'ecaie' ? 'Euro AI ensemble typical path' : 'Euro ensemble typical path', run: e.run, hours: f.properties.hours, coords: f.geometry.coordinates })));
    const models = map.features.filter((f) => f.properties.role === 'model').map((f) => ({ tech: f.properties.tech, init: f.properties.init, times: f.properties.times, coords: f.geometry.coordinates }));
    const avg = danielsAverage({ start: { t: s0.posAt || s0.advisoryAt, lat: s0.pos.lat, lonW: s0.pos.lonW } /* the fix, at its own time */, official: s0.forecastStale ? [] : s0.forecast || [], models, euro });
    if (avg) map.features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: avg.path.map((p) => [-p.lonW, p.lat]) }, properties: { role: 'daniel', members: avg.members, landfall: avg.landfall, times: avg.path.map((p) => p.t) } });
  }
  if (gulf && gulf.investHint) gulf.invest = gulf.investHint; // NHC names the Invest in the outlook heading: that is the identity
  else if (gulf && models?.invest) { gulf.invest = models.invest; }
  else if (gulf && prior?.gulf?.invest) gulf.invest = prior.gulf.invest; // guidance named no Invest this check (failed, stale or empty): keep the known one
  if (gulf && models?.winds && (!gulf.invest || gulf.invest === models.invest)) gulf.winds = models.winds;
  if (gulf) delete gulf.investHint;
  // A replacement resets what belonged to the old storm (its Invest link and landfall record); the diff still runs against the real prior.
  const priorForBuild = replaced && prior ? { ...prior, internal: { ...(prior.internal || {}), landfallAt: null, landfallState: null, landfallStormId: null } } : prior;
  const status = build(priorForBuild, gulf, storms, ww);
  if (outage && !prior) status.headline = 'No data yet: NHC could not be reached.';
  const primary = storms[0] || null;
  status.tracked = primary ? { invest: replaced ? null : prevTracked?.invest || null, stormId: primary.id, name: primary.name, lastPos: primary.pos || lastPos }
    : gulf ? { invest: gulf.invest || prevTracked?.invest || null, stormId: null, name: gulf.invest || gulf.area, lastPos: models?.history?.length ? (() => { const c = models.history[models.history.length - 1].geometry.coordinates; return { lat: c[1], lonW: -c[0] }; })() : lastPos }
    : null;
  // Other Gulf systems: listed, and announced once if they become a coastal threat. They never replace the tracked one.
  status.others = [
    ...[...storms.slice(1), ...sideStorms].map((o) => ({ id: o.id, name: o.name, threat: !!(o.tropical && o.landfall), detail: o.landfall ? `is forecast to reach the coast near ${o.landfall.near || o.landfall.state} around ${fmtCT(o.landfall.eta)}` : `is in the Gulf (${mph(o.winds)} mph)` })),
    ...otherEntries.map((e) => ({ id: e.investHint || e.area, name: e.investHint ? `${e.investHint} (${e.area})` : e.area, threat: false, detail: `${e.formation7d}% chance of forming within 7 days` })),
  ];
  if (sideStorms.length) status.headline += ` Also in the Gulf: ${sideStorms.map((o) => `${o.name} (${mph(o.winds)} mph; ${lcFirst(o.gulfRisk)})`).join('; ')}.`;
  status.internal.othersAlerted = [...new Set([...(prior?.internal?.othersAlerted || []), ...status.others.filter((o) => o.threat).map((o) => o.id)])];
  status.internal.failCount = failCount;
  status.internal.vanishedChecks = holding ? vanishedBefore + 1 : 0;
  // Source health, each part on its own: the forecast advisory is tracked separately from the storm list it came from.
  status.sources = {
    outlook: outlookOK ? 'ok' : 'unavailable',
    storms: stormsOK ? (stormsIncomplete.length ? `incomplete (${stormsIncomplete.join(', ')} unreadable)` : 'ok') : 'unavailable',
    forecast: !primary ? (stormsIncomplete.length ? 'unavailable' : 'n/a') : primary.forecastStale ? 'unavailable' : 'ok',
    alerts: ww.unavailable ? `unavailable for ${ww.unavailable.join(', ')}` : 'ok',
    map: map ? 'ok' : 'unavailable',
  };
  // The reading is stale only when the source that defines it was carried: the storm feed while a storm is tracked, the
  // outlook while only a disturbance is (or the hold, or a full outage). An unreadable outlook during the storm stage
  // leaves a fresh storm reading fresh. Schedulers (the Mac's catch-up) use lastAttemptAt, which always advances.
  const readingCarried = holding || (!outlookOK && !stormsOK) || (storms.length ? !stormsOK : !outlookOK);
  if (readingCarried) status.updatedAt = prior?.updatedAt || status.updatedAt;
  // The Google summary is tied to the system it was computed for; a carried-over summary is kept only for the same system.
  const systemKey = status.tracked?.invest || status.tracked?.stormId || null; // stable across the Invest -> storm upgrade
  const carryGoogle = () => (prior?.google && prior.google.system === systemKey && NOW.getTime() - new Date(prior.google.computedAt || prior.google.run).getTime() < 12 * 3600e3 ? prior.google : null);
  status.google = await optional('Google ensemble', gatherGoogle(storms[0], status.tracked?.invest || explicitInvest))
    .then((g) => (g ? { ...g, system: systemKey, computedAt: NOW.toISOString() } : carryGoogle())) // no fresh file this check: keep a recent summary for the same system
    .catch((e) => { console.warn(`Google ensemble unavailable: ${e.message}`); return carryGoogle(); });
  // NHC's forecast discussion and Key Messages for the tracked storm (page only; never an alert input).
  status.discussion = null;
  const dsc = feedRes.status === 'fulfilled' && primary ? (feedRes.value.discussions || {})[primary.id] : null;
  if (dsc?.url) {
    status.discussion = await optional('NHC discussion', getOpt(`tcd-${primary.id}.html`, dsc.url).then((h) => parseTCD(h, { id: primary.id, advNum: dsc.advNum })))
      .then((d) => (d ? { storm: primary.id, url: dsc.url, issuedAt: dsc.issuance || null, ...d } : null))
      .catch((e) => { console.warn(`NHC discussion unavailable: ${e.message}`); return null; });
  }
  if (!status.discussion && primary && prior?.discussion?.storm === primary.id) status.discussion = { ...prior.discussion, stale: true };
  const changes = diff(prior, status);
  const changed = changes.length > 0;
  if (changed) { status.internal.baseline7d = status.gulf.formation7d; status.internal.baseline48 = status.gulf.formation48; }

  // Changed picture: send, and keep a public-safe record of any channel that failed so the next runs can retry it.
  // Undelivered alert from before with nothing new: retry only the channels (and devices) that missed, up to three
  // attempts in all. A new alert supersedes an undelivered older one, which is noted in the log.
  let pushed = false, delivery = null, retry = null, superseded = null, outagePush = false;
  const pend = prior?.internal?.pending || null;
  const stamp = { ts: NOW.toISOString(), changed, alertLevel: status.alertLevel, formation7d: status.gulf.formation7d };
  if (changed && await remoteIsNewer(prior)) {
    console.log(`${status.alertLevel.toUpperCase()} | another runner saved a newer reading while this check ran; nothing sent or saved from here`);
    return;
  }
  if (changed) {
    const ev = { level: status.alertLevel, changes, headline: status.headline, google: status.google?.text || null };
    delivery = await deliver(composeMessage(ev));
    pushed = delivery.private === true;
    const failed = CHANNELS.filter((k) => delivery[k] === false);
    status.internal.pending = failed.length ? { ...ev, ts: NOW.toISOString(), failed, browserPending: failed.includes('browser') ? delivery.browserFailed : null, attempts: 1 } : null;
    if (pend) { superseded = { ts: pend.ts, failed: pend.failed, attempts: pend.attempts }; console.warn(`an earlier alert (${pend.ts}) was still undelivered on ${pend.failed.join(', ')}; superseded by this one`); }
  } else if (pend && Array.isArray(pend.changes) && pend.attempts < PENDING_ATTEMPTS) {
    const r = await deliver(composeMessage(pend), { channels: pend.failed, browserOnly: pend.browserPending || null });
    const stillFailed = pend.failed.filter((k) => r[k] === false);
    const attempts = pend.attempts + 1;
    const gaveUp = stillFailed.length > 0 && attempts >= PENDING_ATTEMPTS;
    status.internal.pending = stillFailed.length && !gaveUp ? { ...pend, failed: stillFailed, browserPending: stillFailed.includes('browser') ? r.browserFailed : null, attempts } : null;
    retry = { of: pend.ts, channels: pend.failed, delivered: pend.failed.filter((k) => !stillFailed.includes(k)), stillFailed, attempts, gaveUp };
    console.log(`retried alert delivery (${pend.failed.join(', ')}): ${stillFailed.length ? 'still failing: ' + stillFailed.join(', ') + (gaveUp ? '; giving up' : '') : 'delivered'}`);
  } else if (pend && !Array.isArray(pend.changes)) {
    status.internal.pending = null; console.warn('discarded an undelivered alert kept in an old format');
  } else status.internal.pending = pend;
  // NHC unreachable twice in a row: tell the owner (private channel only; the public feeds stay weather-only).
  if (outage && failCount === 2) { try { outagePush = await notify('Gulf Storm Watch: data outage', 'NHC data has been unreachable for two checks in a row. The dashboard is showing the last good reading.', 'watch'); } catch (e) { console.warn(`outage push failed: ${e.message}`); } }

  const minor = changed ? [] : minorDiff(prior, status);
  const summary = changed ? changes.join('. ') + '.'
    : minor.length ? `Update, below the alert threshold: ${minor.join('. ')}.`
    : prior ? 'No change. ' + status.headline : 'Watch opened. ' + status.headline;
  const prefix = outage ? `(NHC unreachable, ${failCount} in a row; previous reading carried) `
    : holding ? (unresolved ? '(a storm near the Gulf could not be read; holding the previous reading) ' : '(system missing from NHC feeds; holding the previous reading for one check to confirm) ')
    : !outlookOK || !stormsOK ? `(${!outlookOK ? 'outlook' : 'storm feed'} unavailable; previous values carried) ` : '';
  await save(status, { ...stamp, pushed, delivery, ...(retry ? { retry } : {}), ...(superseded ? { superseded } : {}), ...(outagePush ? { outagePush } : {}), updated: minor.length > 0, summary: prefix + summary }, map);
  console.log(`${status.alertLevel.toUpperCase()} | changed=${changed} pushed=${pushed} | ${prefix}${summary}`);
}

export { main };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });
