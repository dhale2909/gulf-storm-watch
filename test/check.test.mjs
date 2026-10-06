// Regression tests for the hourly check. Run: npm test
// Network is mocked; nothing is sent. Each test names the review finding it guards (B1 ... B9).
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.NOW = '2026-10-08T15:00:00Z';
delete process.env.FIXTURES;
for (const k of ['NTFY_TOPIC', 'PUBLIC_NTFY_TOPIC', 'PLAYS_JSON', 'PUSH_API', 'PUSH_ADMIN_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'TEST_PUSH', 'TEST_NOTIFY']) delete process.env[k];

let responses = {}, calls = [];
globalThis.fetch = async (url) => {
  url = String(url); calls.push(url);
  const r = responses[url];
  if (r instanceof Error) throw r;
  if (r === undefined) throw new Error('unmocked network: ' + url);
  if (r && r.__http) return { ok: false, status: r.__http, json: async () => ({}), text: async () => '' };
  return { ok: true, status: 200, json: async () => r, text: async () => r };
};
const m = await import('../check.mjs');

const ww = () => Object.fromEntries(['AL', 'FL', 'MS', 'LA'].map((s) => [s, {}]));
const state = (o = {}) => ({ alertLevel: 'watch', updatedAt: '2026-10-08T06:00:00.000Z', gulf: { area: 'Gulf of Mexico', formation7d: 70, formation48: 50 }, storms: [], watchesWarnings: ww(), landfall: null, internal: { baseline7d: 70, baseline48: 50, failCount: 0 }, ...o });
const pre = (s) => '<pre>Tropical Weather Outlook\nFor the North Atlantic...\n\n' + s + '</pre>';
const chances = '* Formation chance through 48 hours...high...70 percent.\n* Formation chance through 7 days...high...90 percent.';
const FEED = 'https://www.nhc.noaa.gov/CurrentStorms.json', TWO = 'https://www.nhc.noaa.gov/text/MIATWOAT.shtml';
const alertsURL = (s) => `https://api.weather.gov/alerts/active?area=${s}`;
const storm = (extra = {}) => ({ id: 'al012026', name: 'Test', classification: 'TS', intensity: '50', latitudeNumeric: 20, longitudeNumeric: -85, movementDir: 20, movementSpeed: 8, lastUpdate: '2026-10-08T15:00:00Z', forecastAdvisory: { url: 'https://fixture.invalid/tcm', issuance: '2026-10-08T15:00:00Z', advNum: '3' }, ...extra });
const TCM = '<pre>FORECAST VALID 09/1200Z 25.0N 88.0W\nFORECAST VALID 10/1200Z 30.0N 88.0W</pre>';

beforeEach(() => { responses = {}; calls = []; });

// ---- B3: outlook parser ----
test('B3: wrapped "near\\n100 percent" and a Gulf mention in the body are read, not treated as quiet', () => {
  const d = m.parseTWO(pre('Western Caribbean Sea:\nThis system will enter the Gulf of Mexico.\n' + chances.replace('90 percent', 'near\n100 percent')));
  assert.equal(d.formation7d, 100); assert.equal(d.formation48, 70);
});
test('B3: an unreadable second Gulf entry is a failure, not a partial low-risk answer', () => {
  const two = pre('Western Gulf of Mexico:\nLow odds.\n' + chances.replace('70 percent', '10 percent').replace('90 percent', '20 percent') + '\n\nEastern Gulf of Mexico:\nHigh odds.\n* Formation chance through 48 hours...high...?? percent.');
  assert.throws(() => m.parseTWO(two), /could not be read/);
});
test('B3: multi-paragraph entry with (AL92) heading and near 100 percent', () => {
  const d = m.parseTWO(pre('Southwestern Gulf of America (AL92):\nOne paragraph.\n\nAnother paragraph about the northern Gulf Coast.\n' + chances.replace('70 percent', 'near 100 percent').replace('90 percent', 'near 100 percent')));
  assert.equal(d.formation48, 100); assert.equal(d.investHint, 'Invest 92L'); assert.equal(d.area, 'Southwestern Gulf of America');
});
test('B3: a verified no-development outlook is a valid empty result', () => {
  assert.equal(m.parseTWO(pre('Tropical cyclone formation is not expected during the next 7 days.')), null);
});
test('B3: the Active Systems paragraph does not count as a Gulf disturbance', () => {
  const d = m.parseTWO(pre('Active Systems:\nThe National Hurricane Center is issuing advisories on Tropical\nStorm Sally, located over the Gulf of America.\n\n1. Central Tropical Atlantic:\nA wave.\n' + chances));
  assert.equal(d, null);
});

// ---- B1 / B8: storms ----
test('B1: an unavailable forecast advisory does not remove a tracked storm or its landfall', async () => {
  responses[FEED] = { activeStorms: [storm()] }; responses['https://fixture.invalid/tcm'] = TCM;
  const good = await m.gatherStorms(state());
  assert.equal(good.length, 1); assert.equal(good[0].landfall.state, 'AL'); assert.equal(good[0].forecastStale, false);
  const prior = state({ alertLevel: 'threat', storms: good.map(({ landfall, tropical, bin, ...s }) => s), landfall: good[0].landfall });
  responses['https://fixture.invalid/tcm'] = new Error('fixture timeout');
  const bad = await m.gatherStorms(prior);
  assert.equal(bad.length, 1, 'storm kept'); assert.equal(bad[0].forecastStale, true);
  assert.deepEqual(bad[0].landfall, good[0].landfall, 'last known landfall carried');
  const cur = m.build(prior, null, bad, ww());
  assert.equal(cur.alertLevel, 'threat');
  assert.deepEqual(m.diff(prior, cur), [], 'no "threat gone" announcement from missing data');
});
test('B1: an unreadable advisory page is unknown, an advisory with no forecast lines is an empty track', () => {
  assert.equal(m.parseTCM('<html>temporarily unavailable</html>', '2026-10-08T15:00:00Z'), null);
  assert.deepEqual(m.parseTCM('<pre>REMNANTS OF TEST ... DISSIPATED</pre>', '2026-10-08T15:00:00Z'), []);
});
test('B8: a storm record without coordinates is not silently dropped when it was tracked before', async () => {
  responses[FEED] = { activeStorms: [storm({ latitudeNumeric: undefined, longitudeNumeric: undefined, intensity: 'n/a' })] }; responses['https://fixture.invalid/tcm'] = TCM;
  const prior = state({ storms: [{ id: 'al012026', name: 'Tropical Storm Test', type: 'Tropical Storm', winds: 50, location: '20.0N 85.0W', gulfRisk: 'x' }] });
  const out = await m.gatherStorms(prior);
  assert.equal(out.length, 1); assert.equal(out[0].winds, 50, 'bad intensity falls back to last known'); assert.match(out[0].location, /last known/);
});

// ---- B4 / B5: coastal alerts ----
test('B4: a malformed NWS response keeps the existing warning instead of clearing it', async () => {
  for (const s of ['AL', 'FL', 'MS', 'LA']) responses[alertsURL(s)] = { error: 'upstream malformed' };
  const prior = state(); prior.watchesWarnings.LA = { level: 'warning', text: 'Hurricane Warning' };
  const a = await m.gatherAlerts(prior, true);
  assert.deepEqual(a.LA, { level: 'warning', text: 'Hurricane Warning' }); assert.deepEqual(a.unavailable, ['AL', 'FL', 'MS', 'LA']);
});
test('B4: a valid empty alert list does clear a warning', async () => {
  for (const s of ['AL', 'FL', 'MS', 'LA']) responses[alertsURL(s)] = { features: [] };
  const prior = state(); prior.watchesWarnings.LA = { level: 'warning', text: 'Hurricane Warning' };
  assert.deepEqual((await m.gatherAlerts(prior, true)).LA, {});
});
test('B5: a new warning added beside an existing one is a change', () => {
  const a = state(), b = state();
  a.watchesWarnings.FL = { level: 'warning', text: 'Tropical Storm Warning' };
  b.watchesWarnings.FL = { level: 'warning', text: 'Hurricane Warning, Tropical Storm Warning' };
  assert.match(m.diff(a, b).join(' | '), /FL: alerts now Hurricane Warning, Tropical Storm Warning/);
});

// ---- B2 / B6: main() with mocked network ----
async function runMain(prior, { twoFails = false, feedFails = false, ntfy = 200 } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gsw-')); process.chdir(dir); calls = [];
  await import('node:fs/promises').then((fs) => fs.mkdir('data', { recursive: true }));
  if (prior) await writeFile('data/status.json', JSON.stringify(prior));
  // Defaults only where a test has not set its own response.
  if (twoFails) responses[TWO] = new Error('fixture outage'); else if (responses[TWO] === undefined) responses[TWO] = pre('Gulf of Mexico:\nDevelopment is possible.\n* Formation chance through 48 hours...medium...50 percent.\n* Formation chance through 7 days...medium...50 percent.');
  if (feedFails) responses[FEED] = new Error('fixture outage'); else if (responses[FEED] === undefined) responses[FEED] = { activeStorms: [] };
  for (const s of ['AL', 'FL', 'MS', 'LA']) responses[alertsURL(s)] = { features: [] };
  responses['https://ntfy.sh/'] = ntfy === 200 ? { id: 'x' } : { __http: ntfy };
  await m.main();
  return JSON.parse(await readFile('data/status.json', 'utf8'));
}
test('B2: a full NHC outage keeps the last successful timestamp and records the attempt', async () => {
  const d = await runMain(state(), { twoFails: true, feedFails: true });
  assert.equal(d.updatedAt, '2026-10-08T06:00:00.000Z'); assert.equal(d.lastAttemptAt, '2026-10-08T15:00:00.000Z');
  assert.equal(d.internal.failCount, 1); assert.equal(d.alertLevel, 'watch');
});
test('B2: an outlook outage alone still reads the storm feed and alerts, carrying the old outlook flagged', async () => {
  const d = await runMain(state(), { twoFails: true });
  assert.equal(d.gulf.formation7d, 70); assert.equal(d.gulf.stale, true); assert.equal(d.sources.outlook, 'unavailable'); assert.equal(d.sources.storms, 'ok');
  assert.ok(calls.some((u) => u.includes('api.weather.gov')), 'NWS alerts were still checked');
});
test('B6: a failed private push is retried on the next run instead of being consumed', async () => {
  process.env.NTFY_TOPIC = 'fixture-private';
  const prior = state({ alertLevel: 'quiet', gulf: { formation7d: null, formation48: null } });
  let d = await runMain(prior, { ntfy: 503 });
  assert.equal(d.alertLevel, 'watch'); assert.deepEqual(d.internal.pending.failed, ['private']);
  const sends = calls.filter((u) => u === 'https://ntfy.sh/').length; assert.equal(sends, 1);
  d = await runMain(d, { ntfy: 200 });
  assert.equal(calls.filter((u) => u === 'https://ntfy.sh/').length, 1, 'retried once on the quiet follow-up run');
  assert.equal(d.internal.pending, null);
  delete process.env.NTFY_TOPIC;
});
test('B6: a private-channel exception does not stop the public send or the save', async () => {
  process.env.NTFY_TOPIC = 'fixture-private'; process.env.PUBLIC_NTFY_TOPIC = 'fixture-public';
  const prior = state({ alertLevel: 'quiet', gulf: { formation7d: null, formation48: null } });
  let n = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => { if (String(url) === 'https://ntfy.sh/' && n++ === 0) throw new Error('fixture timeout'); return realFetch(url, o); };
  const d = await runMain(prior, { ntfy: 200 });
  globalThis.fetch = realFetch;
  assert.equal(d.alertLevel, 'watch', 'state saved'); assert.equal(calls.filter((u) => u === 'https://ntfy.sh/').length, 1, 'public still sent (the private attempt threw before reaching the network)');
  assert.deepEqual(d.internal.pending.failed, ['private']);
  delete process.env.NTFY_TOPIC; delete process.env.PUBLIC_NTFY_TOPIC;
});

// ---- P1 (approved): hold a disappearance for one check; landfall expected vs occurred ----
test('P1: a tracked system missing from both NHC feeds is held for one check, then accepted', async () => {
  const prior = state();
  const dir = await mkdtemp(path.join(tmpdir(), 'gsw-')); process.chdir(dir); calls = [];
  await import('node:fs/promises').then((fs) => fs.mkdir('data', { recursive: true }));
  await writeFile('data/status.json', JSON.stringify(prior));
  const quietTWO = pre('Tropical cyclone formation is not expected during the next 7 days.');
  responses[TWO] = quietTWO; responses[FEED] = { activeStorms: [] };
  for (const s of ['AL', 'FL', 'MS', 'LA']) responses[alertsURL(s)] = { features: [] };
  responses['https://ntfy.sh/'] = { id: 'x' };
  await m.main();
  let d = JSON.parse(await readFile('data/status.json', 'utf8'));
  assert.equal(d.alertLevel, 'watch', 'first disappearance is held'); assert.equal(d.internal.vanishedChecks, 1); assert.equal(d.gulf.stale, true);
  responses[TWO] = quietTWO; responses[FEED] = { activeStorms: [] };
  await m.main();
  d = JSON.parse(await readFile('data/status.json', 'utf8'));
  assert.equal(d.alertLevel, 'quiet', 'second consecutive disappearance is accepted'); assert.equal(d.internal.vanishedChecks, 0);
});
test('P1: landfall expected (forecast within 24 h) is not a 48-hour hold; an observed landfall is', () => {
  const prior = state({ alertLevel: 'threat' });
  const expected = [{ id: 'al012026', name: 'Tropical Storm Test', type: 'Tropical Storm', winds: 50, tropical: true, location: 'x', movement: 'x', gulfRisk: 'x', landfall: { state: 'LA', eta: '2026-10-09T06:00:00Z' }, ashore: null }];
  let d = m.build(prior, null, expected, ww());
  assert.equal(d.alertLevel, 'landfall'); assert.equal(d.landfallOccurred, null); assert.equal(d.internal.landfallHoldUntil, null, 'no hold from an expectation');
  // forecast shifts away before landfall: back to threat, nothing held
  const shifted = [{ ...expected[0], landfall: { state: 'LA', eta: '2026-10-11T06:00:00Z' } }];
  d = m.build(d, null, shifted, ww());
  assert.equal(d.alertLevel, 'threat');
  // center observed ashore in Louisiana: occurred, hold for 48 h, and it is a change
  const ashore = [{ ...expected[0], landfall: null, ashore: { state: 'LA', t: '2026-10-08T15:00:00Z' } }];
  const e = m.build(d, null, ashore, ww());
  assert.equal(e.alertLevel, 'landfall'); assert.equal(e.landfallOccurred.state, 'LA'); assert.equal(e.internal.landfallHoldUntil, '2026-10-10T15:00:00.000Z');
  assert.match(m.diff(d, e).join(' | '), /Landfall in LA/);
  // storm gone from the feed afterwards: the hold keeps the level and the headline says it made landfall
  const f = m.build(e, null, [], ww());
  assert.equal(f.alertLevel, 'landfall'); assert.match(f.headline, /Made landfall in LA/);
});

// ---- P3 (approved): one tracked system; others are noted and announced once when they become a threat ----
test('P3: the tracked Invest is followed into the nearest new storm; a second storm is "another system"', async () => {
  const prior = state({ tracked: { invest: 'Invest 92L', stormId: null, name: 'Invest 92L', lastPos: { lat: 22, lonW: 96 } } });
  const dir = await mkdtemp(path.join(tmpdir(), 'gsw-')); process.chdir(dir); calls = [];
  await import('node:fs/promises').then((fs) => fs.mkdir('data', { recursive: true }));
  await writeFile('data/status.json', JSON.stringify(prior));
  responses[TWO] = pre('Tropical cyclone formation is not expected during the next 7 days.');
  // Storm A: far east with a coastal forecast. Storm B: right where the Invest was, no coastal forecast yet.
  responses[FEED] = { activeStorms: [storm({ id: 'al012026', name: 'Far', latitudeNumeric: 25, longitudeNumeric: -84 }), storm({ id: 'al022026', name: 'Near', latitudeNumeric: 22.4, longitudeNumeric: -95.5, forecastAdvisory: { url: 'https://fixture.invalid/tcm2', issuance: '2026-10-08T15:00:00Z', advNum: '1' } })] };
  responses['https://fixture.invalid/tcm'] = TCM; responses['https://fixture.invalid/tcm2'] = '<pre>FORECAST VALID 09/1200Z 23.0N 94.0W\nFORECAST VALID 10/1200Z 24.0N 93.0W</pre>';
  for (const s of ['AL', 'FL', 'MS', 'LA']) responses[alertsURL(s)] = { features: [] };
  responses['https://ntfy.sh/'] = { id: 'x' };
  await m.main();
  const d = JSON.parse(await readFile('data/status.json', 'utf8'));
  assert.equal(d.tracked.stormId, 'al022026', 'nearest storm adopted as the tracked system'); assert.equal(d.tracked.invest, 'Invest 92L');
  assert.equal(d.storms[0].id, 'al022026'); assert.equal(d.others.length, 1); assert.equal(d.others[0].threat, true);
  const log = JSON.parse(await readFile('data/log.json', 'utf8'));
  assert.match(log[0].summary, /Another Gulf system: Tropical Storm Far is forecast to reach the AL coast/);
  assert.match(d.headline, /Also in the Gulf: Tropical Storm Far/);
  // next check: the other system is not announced again
  await writeFile('data/status.json', JSON.stringify(d));
  await m.main();
  const log2 = JSON.parse(await readFile('data/log.json', 'utf8'));
  assert.doesNotMatch(log2[0].summary, /Another Gulf system/);
});
test('P3: a tracked storm keeps the page even when another storm sorts first by landfall', async () => {
  const prior = state({ tracked: { invest: null, stormId: 'al022026', name: 'Tropical Storm Near', lastPos: { lat: 22, lonW: 95 } }, storms: [{ id: 'al022026', name: 'Tropical Storm Near', type: 'Tropical Storm', winds: 40 }] });
  responses[FEED] = { activeStorms: [storm({ id: 'al012026', name: 'Far', latitudeNumeric: 25, longitudeNumeric: -84 }), storm({ id: 'al022026', name: 'Near', latitudeNumeric: 22.4, longitudeNumeric: -95.5, forecastAdvisory: { url: 'https://fixture.invalid/tcm2', issuance: '2026-10-08T15:00:00Z', advNum: '1' } })] };
  responses['https://fixture.invalid/tcm'] = TCM; responses['https://fixture.invalid/tcm2'] = '<pre>FORECAST VALID 09/1200Z 23.0N 94.0W\nFORECAST VALID 10/1200Z 24.0N 93.0W</pre>';
  const got = await m.gatherStorms(prior);
  assert.equal(got[0].id, 'al012026', 'raw feed order puts the coastal-threat storm first');
  const d = await runMain(prior, {});
  assert.equal(d.storms[0].id, 'al022026', 'but the tracked storm stays primary');
});
