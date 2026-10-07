// Regression tests for the hourly check. Run: npm test
// Network is mocked; nothing is sent. Each test names the review finding it guards (B1 ... B9).
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.NOW = '2026-10-08T15:00:00Z';
delete process.env.FIXTURES;
for (const k of ['NTFY_TOPIC', 'PUBLIC_NTFY_TOPIC', 'NTFY_TOKEN', 'PUBLIC_NTFY_TOKEN', 'PLAYS_JSON', 'PUSH_API', 'PUSH_ADMIN_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'TEST_PUSH', 'TEST_NOTIFY']) delete process.env[k];

let responses = {}, calls = [];
globalThis.fetch = async (url) => {
  url = String(url); calls.push(url);
  const r = responses[url];
  if (r instanceof Error) throw r;
  if (r === undefined) throw new Error('unmocked network: ' + url);
  if (r && r.__http) return { ok: false, status: r.__http, json: async () => ({}), text: async () => '' };
  return { ok: true, status: 200, json: async () => r, text: async () => r, arrayBuffer: async () => (Buffer.isBuffer(r) ? r : Buffer.from(String(r))) };
};
const m = await import('../check.mjs');

const ww = () => Object.fromEntries(['AL', 'FL', 'MS', 'LA'].map((s) => [s, {}]));
const state = (o = {}) => ({ alertLevel: 'watch', updatedAt: '2026-10-08T06:00:00.000Z', gulf: { area: 'Gulf of Mexico', formation7d: 70, formation48: 50 }, storms: [], watchesWarnings: ww(), landfall: null, internal: { baseline7d: 70, baseline48: 50, failCount: 0 }, ...o });
const pre = (s) => '<pre>Tropical Weather Outlook\nFor the North Atlantic...\n\n' + s + '</pre>';
const chances = '* Formation chance through 48 hours...high...70 percent.\n* Formation chance through 7 days...high...90 percent.';
const FEED = 'https://www.nhc.noaa.gov/CurrentStorms.json', TWO = 'https://www.nhc.noaa.gov/text/MIATWOAT.shtml';
const alertsURL = (s) => `https://api.weather.gov/alerts/active?area=${s}`;
const storm = (extra = {}) => ({ id: 'al012026', name: 'Test', classification: 'TS', intensity: '50', latitudeNumeric: 20, longitudeNumeric: -85, movementDir: 20, movementSpeed: 8, lastUpdate: '2026-10-08T15:00:00Z', forecastAdvisory: { url: 'https://fixture.invalid/tcm', issuance: '2026-10-08T15:00:00Z', advNum: '3' }, ...extra });
const TCM = '<pre>FORECAST VALID 09/1200Z 25.0N 88.0W\nFORECAST VALID 10/1200Z 31.0N 88.0W</pre>'; // ends inland of the Alabama coast (30.2N at 88W)

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
  for (const s of ['AL', 'FL', 'MS', 'LA']) if (responses[alertsURL(s)] === undefined) responses[alertsURL(s)] = { features: [] };
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
test('B6: a private-channel exception does not stop the save, and the retired public ntfy feed is never sent', async () => {
  process.env.NTFY_TOPIC = 'fixture-private'; process.env.PUBLIC_NTFY_TOPIC = 'fixture-public'; // a leftover setting must do nothing
  const prior = state({ alertLevel: 'quiet', gulf: { formation7d: null, formation48: null } });
  let n = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => { if (String(url) === 'https://ntfy.sh/' && n++ === 0) throw new Error('fixture timeout'); return realFetch(url, o); };
  const d = await runMain(prior, { ntfy: 200 });
  globalThis.fetch = realFetch;
  assert.equal(d.alertLevel, 'watch', 'state saved'); assert.equal(calls.filter((u) => u === 'https://ntfy.sh/').length, 0, 'nothing went to the public topic (the private attempt threw before reaching the network)');
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
  assert.match(log[0].summary, /Another Gulf system: Tropical Storm Far is forecast to reach the coast near /);
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

// ---- P7 (approved): a carried-over Google summary must belong to the same tracked system ----
test('P7: a stale Google summary is dropped when the tracked system changed', async () => {
  // The previously tracked storm (al02) is gone from the feed; a different storm (al03) takes over.
  const prior = state({ tracked: { invest: null, stormId: 'al022026', name: 'Tropical Storm Old', lastPos: { lat: 22, lonW: 96 } }, storms: [{ id: 'al022026', name: 'Tropical Storm Old', type: 'Tropical Storm', winds: 40 }], google: { system: 'al022026', computedAt: '2026-10-08T12:00:00Z', text: 'old', members: 11, hits: 9, coast: { LA: 0, MS: 0, AL: 0, FL: 9 }, run: '2026-10-08T06:00:00Z', total: 50, hurricane: 9, major: 7, peakMedianKt: 99 } });
  responses[TWO] = pre('Tropical cyclone formation is not expected during the next 7 days.');
  responses[FEED] = { activeStorms: [storm({ id: 'al032026', name: 'New', latitudeNumeric: 26, longitudeNumeric: -86 })] };
  responses['https://fixture.invalid/tcm'] = TCM;
  const d = await runMain(prior, {}); // Google download is unmocked, so the fetch fails and the carry-over rule applies
  assert.equal(d.tracked.stormId, 'al032026'); assert.equal(d.google, null, 'summary for al022026 not reused for storm al032026');
});
test('P7: the Google summary survives the Invest -> storm upgrade of the same system', async () => {
  const prior = state({ tracked: { invest: 'Invest 92L', stormId: null, name: 'Invest 92L', lastPos: { lat: 22, lonW: 96 } }, google: { system: 'Invest 92L', computedAt: '2026-10-08T12:00:00Z', text: 'kept', members: 11, hits: 9, coast: { LA: 9, MS: 0, AL: 0, FL: 0 }, run: '2026-10-08T06:00:00Z', total: 50, hurricane: 9, major: 7, peakMedianKt: 99 } });
  responses[TWO] = pre('Tropical cyclone formation is not expected during the next 7 days.');
  responses[FEED] = { activeStorms: [storm({ id: 'al192026', name: 'Nineteen', classification: 'TD', intensity: '30', latitudeNumeric: 22.3, longitudeNumeric: -95.6 })] };
  responses['https://fixture.invalid/tcm'] = TCM;
  const d = await runMain(prior, {});
  assert.equal(d.tracked.stormId, 'al192026'); assert.equal(d.tracked.invest, 'Invest 92L'); assert.equal(d.google && d.google.text, 'kept');
});

// ---- storm stage: the map must not be empty while NOAA's layers lag the first advisory ----
test('storm map falls back to the text advisory track when the map service has nothing yet', async () => {
  responses[FEED] = { activeStorms: [storm()] }; responses['https://fixture.invalid/tcm'] = TCM;
  const [st] = await m.gatherStorms(state());
  assert.equal(st.forecast.length, 2);
  const MAPSRV = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';
  for (const id of [6, 7, 9, 12]) responses[`${MAPSRV}/${id}/query?where=1%3D1&outFields=*&f=geojson&geometryPrecision=2`] = { features: [] };
  const map = await m.gatherMap(null, { ...st, bin: 'AT1' });
  const roles = map.features.map((f) => f.properties.role);
  assert.ok(roles.includes('track') && roles.filter((r) => r === 'point').length === 3, 'track line plus now + 2 forecast points');
  assert.match(map.source, /text advisory/);
});

// ---- landfall point: the coast crossing, with interpolated timing and the nearest town ----
test('landfall uses the coast crossing: nearest town and interpolated time, not the first point past the coast', async () => {
  // 25N 88W at 09/1200Z -> 31N 88W at 10/1200Z: crosses the Mississippi/Alabama coast (about 30.2N) 87% of the way
  // along that 24-hour leg, so around 10/0900Z, near Dauphin Island.
  responses[FEED] = { activeStorms: [storm()] }; responses['https://fixture.invalid/tcm'] = '<pre>FORECAST VALID 09/1200Z 25.0N 88.0W\nFORECAST VALID 10/1200Z 31.0N 88.0W</pre>';
  const [st] = await m.gatherStorms(state());
  assert.equal(st.landfall.state, 'AL'); assert.equal(st.landfall.near, 'Dauphin Island, AL');
  assert.equal(st.landfall.eta.slice(0, 13), '2026-10-10T08');
});

// ---- Follow-up review (Oct 6 evening) ----
// These assert desired behavior. Known failures are TODOs rather than skipped tests:
// they execute on every npm test run and document defects pending owner/implementer fixes.
// No production code, live requests, credentials, or alert policies are changed here.
// Every follow-up finding is fixed (the coastline geometry on the owner's decision, Oct 6 night); these are regression tests.
const fixed = (id, name, fn) => test(`${id}: ${name}`, fn);
const quietOutlook = () => pre('Tropical cyclone formation is not expected during the next 7 days.');
const forecastStorm = (extra = {}) => ({ id: 'al012026', name: 'Tropical Storm Test', type: 'Tropical Storm', winds: 50, tropical: true, location: 'Gulf', movement: 'N at 5 mph', gulfRisk: 'Forecast', ...extra });

fixed('R1', 'public status must never persist private Play text in a retry record', async () => {
  process.env.NTFY_TOPIC = 'fixture-private';
  process.env.PLAYS_JSON = JSON.stringify({ watch: 'PRIVATE_TEST_SENTINEL_NOT_A_SECRET' });
  try {
    const d = await runMain(state({ alertLevel: 'quiet', gulf: {} }), { ntfy: 503 });
    assert.equal(JSON.stringify(d).includes('PRIVATE_TEST_SENTINEL_NOT_A_SECRET'), false);
  } finally { delete process.env.NTFY_TOPIC; delete process.env.PLAYS_JSON; }
});

fixed('R2', 'browser transient delivery failures must report failure, not success', async () => {
  const webpush = (await import('web-push')).default;
  const oldSend = webpush.sendNotification, oldVapid = webpush.setVapidDetails;
  process.env.PUSH_API = 'https://fixture.invalid'; process.env.PUSH_ADMIN_KEY = 'fixture'; process.env.VAPID_PRIVATE_KEY = 'fixture';
  webpush.setVapidDetails = () => {};
  webpush.sendNotification = async () => { throw Object.assign(new Error('fixture 503'), { statusCode: 503 }); };
  responses['https://fixture.invalid/subscriptions'] = [{ endpoint: 'https://fixture.invalid/device', keys: {} }];
  try {
    const d = await m.deliver({ privateTitle: '', publicTitle: 'Fixture', publicBody: 'Fixture', level: 'watch' });
    assert.equal(d.browser, false);
  } finally {
    webpush.sendNotification = oldSend; webpush.setVapidDetails = oldVapid;
    for (const k of ['PUSH_API', 'PUSH_ADMIN_KEY', 'VAPID_PRIVATE_KEY']) delete process.env[k];
  }
});

fixed('R2', 'retrying only private ntfy must not send another browser notification', async () => {
  const webpush = (await import('web-push')).default;
  const oldSend = webpush.sendNotification, oldVapid = webpush.setVapidDetails;
  let sent = 0;
  process.env.NTFY_TOPIC = 'fixture-private'; process.env.PUSH_API = 'https://fixture.invalid'; process.env.PUSH_ADMIN_KEY = 'fixture'; process.env.VAPID_PRIVATE_KEY = 'fixture';
  webpush.setVapidDetails = () => {}; webpush.sendNotification = async () => { sent++; };
  responses['https://fixture.invalid/subscriptions'] = [{ endpoint: 'https://fixture.invalid/device', keys: {} }];
  // A pending record in the current format (with its changes), so main() really runs the retry path (F84).
  const p = state({ gulf: { area: 'Gulf of Mexico', formation7d: 50, formation48: 50 }, internal: { baseline7d: 50, baseline48: 50, pending: { level: 'watch', changes: ['Fixture change'], headline: 'Fixture', google: null, ts: '2026-10-08T14:30:00Z', failed: ['private'], browserPending: null, attempts: 1 } } });
  try {
    const d = await runMain(p);
    assert.equal(sent, 0, 'no browser push'); assert.equal(calls.filter((u) => u === 'https://ntfy.sh/').length, 1, 'the private channel was retried');
    assert.equal(d.internal.pending, null);
  }
  finally {
    webpush.sendNotification = oldSend; webpush.setVapidDetails = oldVapid;
    for (const k of ['NTFY_TOPIC', 'PUSH_API', 'PUSH_ADMIN_KEY', 'VAPID_PRIVATE_KEY', 'PUBLIC_NTFY_TOPIC']) delete process.env[k];
  }
});

fixed('R3', 'a TCM header with malformed forecast positions is unavailable, not terminal', () => {
  assert.equal(m.parseTCM('<pre>TROPICAL STORM TEST FORECAST/ADVISORY NUMBER 3\nFORECAST VALID 09/1200Z POSITION UNAVAILABLE</pre>', '2026-10-08T15:00:00Z'), null);
});

fixed('R3', 'a TWO with Gulf content but no recognized heading is not a verified quiet outlook', () => {
  assert.throws(() => m.parseTWO(pre('Gulf of Mexico\nA tropical disturbance is developing.\n' + chances)));
});

fixed('R4', 'NWS must still be checked when both NHC sources fail', async () => {
  await runMain(state(), { twoFails: true, feedFails: true });
  assert.ok(calls.some((u) => u.includes('api.weather.gov/alerts/active')));
});

fixed('R5', 'null position and intensity do not become a zero fix and zero winds', async () => {
  responses[FEED] = { activeStorms: [storm({ latitudeNumeric: null, longitudeNumeric: null, intensity: null })] };
  responses['https://fixture.invalid/tcm'] = TCM;
  const p = state({ storms: [forecastStorm({ pos: { lat: 25, lonW: 88 } })] });
  const out = await m.gatherStorms(p);
  assert.equal(out[0].winds, 50); assert.deepEqual(out[0].pos, { lat: 25, lonW: 88 });
});

fixed('R6', 'an unrelated sole storm must not replace an Invest still explicitly in the outlook', async () => {
  const p = state({ tracked: { invest: 'Invest 92L', stormId: null, lastPos: { lat: 22, lonW: 96 } } });
  // Outlook issued at 10 AM CDT (15:00Z), after the unrelated storm's 12:00Z advisory: NHC knowingly lists both.
  responses[TWO] = '<pre>Tropical Weather Outlook\n1000 AM CDT Thu Oct 8 2026\n\nFor the North Atlantic...\n\nGulf of Mexico (AL92):\nThe tracked disturbance remains.\n' + chances + '</pre>';
  responses[FEED] = { activeStorms: [storm({ id: 'al032026', name: 'Unrelated', latitudeNumeric: 27, longitudeNumeric: -83, forecastAdvisory: { url: 'https://fixture.invalid/tcm', issuance: '2026-10-08T12:00:00Z', advNum: '3' } })] };
  responses['https://fixture.invalid/tcm'] = TCM;
  const d = await runMain(p);
  assert.equal(d.tracked.stormId, null); assert.equal(d.tracked.invest, 'Invest 92L');
});

fixed('R6', 'a different primary storm must not inherit the old Invest identity or Google summary', async () => {
  const p = state({ tracked: { invest: 'Invest 92L', stormId: 'al012026', lastPos: { lat: 22, lonW: 96 } }, storms: [forecastStorm()], google: { system: 'Invest 92L', computedAt: '2026-10-08T12:00:00Z', text: 'old-system aggregate' } });
  responses[TWO] = quietOutlook(); responses[FEED] = { activeStorms: [storm({ id: 'al032026', name: 'Different' })] }; responses['https://fixture.invalid/tcm'] = TCM;
  const d = await runMain(p);
  assert.equal(d.tracked.stormId, 'al032026'); assert.equal(d.google, null); assert.equal(d.tracked.invest, null);
});

fixed('R7', 'an offshore position south of the configured coastline is not observed landfall', async () => {
  // COAST_N explicitly puts the coast at 29.6N at 92W; 29.55N is seaward of that line.
  responses[FEED] = { activeStorms: [storm({ latitudeNumeric: 29.55, longitudeNumeric: -92 })] };
  responses['https://fixture.invalid/tcm'] = '<pre>FORECAST VALID 09/1200Z 30.5N 92.0W</pre>';
  assert.equal((await m.gatherStorms(state()))[0].ashore, null);
});

fixed('R7', 'a 48-hour-old observed landfall does not restart while the center remains inland', () => {
  const p = state({ internal: { landfallAt: '2026-10-06T12:00:00Z', landfallState: 'LA' }, landfallOccurred: { at: '2026-10-06T12:00:00Z', state: 'LA' } });
  const d = m.build(p, null, [forecastStorm({ ashore: { state: 'LA', t: '2026-10-08T15:00:00Z' }, landfall: null })], ww());
  assert.equal(d.alertLevel, 'watch'); assert.notEqual(d.internal.landfallAt, '2026-10-08T15:00:00.000Z');
});

fixed('R7', 'landfall occurrence uses observation time, not the polling time', () => {
  const d = m.build(state(), null, [forecastStorm({ ashore: { state: 'LA', t: '2026-10-08T12:00:00Z' } })], ww());
  assert.equal(d.landfallOccurred.at, '2026-10-08T12:00:00Z');
});

fixed('R8', 'oblique crossing solves the path against coastline segments, not the endpoint latitude', async () => {
  responses[FEED] = { activeStorms: [storm({ latitudeNumeric: 28, longitudeNumeric: -92, lastUpdate: '2026-10-08T12:00:00Z' })] };
  responses['https://fixture.invalid/tcm'] = '<pre>FORECAST VALID 09/1200Z 31.0N 84.0W</pre>';
  // At the intersection: lonW=92-8f, lat=28+3f. COAST_N segment
  // (86.5,30.35)->(85.7,30.1) has lat=30.35 + .3125*(lonW-86.5).
  const f = 4.06875 / 5.5;
  const expected = Date.parse('2026-10-08T12:00:00Z') + f * 86400000;
  const got = Date.parse((await m.gatherStorms(state()))[0].landfall.eta);
  assert.ok(Math.abs(got - expected) < 1000, `crossing differs by ${Math.round((got - expected) / 60000)} min`);
});

fixed('R8', 'nearest-town state and announced landfall state agree at the Louisiana delta', async () => {
  responses[FEED] = { activeStorms: [storm({ latitudeNumeric: 28, longitudeNumeric: -89.35 })] };
  responses['https://fixture.invalid/tcm'] = '<pre>FORECAST VALID 09/1200Z 29.5N 89.3W</pre>';
  const lf = (await m.gatherStorms(state()))[0].landfall;
  assert.equal(lf.state, lf.near.split(', ')[1]);
});

fixed('R9', 'text-advisory fallback survives a failing map layer, not only an empty layer', async () => {
  const MAP = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';
  for (const id of [6,7,9,12]) responses[`${MAP}/${id}/query?where=1%3D1&outFields=*&f=geojson&geometryPrecision=2`] = { features: [] };
  responses[`${MAP}/7/query?where=1%3D1&outFields=*&f=geojson&geometryPrecision=2`] = new Error('fixture track layer unavailable');
  const map = await m.gatherMap(null, forecastStorm({ bin: 'AT1', pos: { lat: 25, lonW: 88 }, forecast: [{t:'2026-10-09T12:00:00Z', lat:30, lonW:88}] }));
  assert.ok(map.features.some((f) => f.properties.role === 'track'));
});

fixed('R9', 'storm-feed outage does not overwrite the prior storm map with kind none', async () => {
  const p = state({ gulf: {}, storms: [forecastStorm({ pos: { lat:25, lonW:88 } })], tracked: { stormId:'al012026' } });
  responses[TWO] = quietOutlook();
  await runMain(p, { feedFails:true });
  let map = null; try { map=JSON.parse(await readFile('data/map.json','utf8')); } catch {}
  assert.notEqual(map?.kind, 'none', 'retain last map or report unavailable; never publish a verified empty map');
});

// Worker tests use an in-memory KV and ephemeral in-memory VAPID keys. No keys are saved.
// Worker is bundled as ESM by Wrangler; import its unchanged source as ESM for Node.
const workerSource = await readFile(new URL('../push/worker.js', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(workerSource).toString('base64'))).default;
const memKV = () => { const a=new Map(); return { get:async k=>a.get(k)?.value??null, getWithMetadata:async k=>a.get(k)??null, put:async(k,value,o={})=>{a.set(k,{value,metadata:o.metadata})}, delete:async k=>{a.delete(k)} }; };
const workerReq = (route, body) => new Request('https://fixture.invalid'+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const PUSH_EP = 'https://fcm.googleapis.com/fcm/send/fixture-device'; // a push-service endpoint shape the worker accepts
// A real P-256 public key: the worker rejects keys that are not points on the curve (F45).
const PUSH_ECDH = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const PUSH_KEYS = { p256dh: Buffer.from(await crypto.subtle.exportKey('raw', PUSH_ECDH.publicKey)).toString('base64url'), auth: Buffer.alloc(16, 9).toString('base64url') };

fixed('R10', 'test-push registration rejects arbitrary non-push HTTPS endpoints', async () => {
  const r=await worker.fetch(workerReq('/subscribe',{endpoint:'https://arbitrary-target.invalid/path',keys:{p256dh:'invalid',auth:'invalid'}}),{SUBS:memKV()});
  assert.equal(r.status,400);
});

fixed('R10', 'concurrent test requests enforce one send per device within the cooldown', async () => {
  const webpush=(await import('web-push')).default;
  const keys=webpush.generateVAPIDKeys();
  const env={SUBS:memKV(),VAPID_PUBLIC_KEY:keys.publicKey,VAPID_PRIVATE_KEY:keys.privateKey,PAGE_URL:'https://fixture.invalid/'};
  const endpoint=PUSH_EP;
  await worker.fetch(workerReq('/subscribe',{endpoint,keys:PUSH_KEYS}),env);
  // A slow cooldown read: without serialisation both requests read "no recent test" before either writes.
  const originalGet=env.SUBS.get;
  env.SUBS.get=async k=>{if(k.startsWith('test:')) await new Promise(r=>setTimeout(r,20)); return originalGet(k)};
  const oldFetch=globalThis.fetch; let sent=0;
  globalThis.fetch=async()=>{sent++;return {status:201}};
  try {
    const rs=await Promise.all([worker.fetch(workerReq('/test',{endpoint}),env),worker.fetch(workerReq('/test',{endpoint}),env)]);
    assert.equal(sent,1); assert.ok(rs.some(r=>r.status===429));
  } finally {globalThis.fetch=oldFetch;}
});

test('R10 control: an unregistered device cannot request a test push', async () => {
  const r=await worker.fetch(workerReq('/test',{endpoint:PUSH_EP.replace('fixture-device','unregistered')}),{SUBS:memKV()});
  assert.equal(r.status,404);
});

test('R10 control: a registered device test sends one payload-free request with a verifiable VAPID token', async () => {
  const webpush=(await import('web-push')).default, keys=webpush.generateVAPIDKeys();
  const env={SUBS:memKV(),VAPID_PUBLIC_KEY:keys.publicKey,VAPID_PRIVATE_KEY:keys.privateKey,PAGE_URL:'https://fixture.invalid/'};
  const endpoint=PUSH_EP;
  await worker.fetch(workerReq('/subscribe',{endpoint,keys:PUSH_KEYS}),env);
  const oldFetch=globalThis.fetch; let sent=[];
  globalThis.fetch=async(url,options)=>{sent.push({url,options});return {status:201}};
  try {
    assert.equal((await worker.fetch(workerReq('/test',{endpoint}),env)).status,200);
    assert.equal((await worker.fetch(workerReq('/test',{endpoint}),env)).status,429);
    assert.equal(sent.length,1); assert.equal(sent[0].url,endpoint); assert.equal(sent[0].options.body,undefined);
    const auth=sent[0].options.headers.Authorization;
    const token=auth.match(/^vapid t=([^,]+), k=/)[1]; const [h,p,s]=token.split('.');
    const payload=JSON.parse(Buffer.from(p,'base64url')); assert.equal(payload.aud,new URL(endpoint).origin); assert.equal(payload.sub,env.PAGE_URL);
    const pub=await crypto.subtle.importKey('raw',Buffer.from(keys.publicKey,'base64url'),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
    assert.equal(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},pub,Buffer.from(s,'base64url'),Buffer.from(h+'.'+p)),true);
  } finally {globalThis.fetch=oldFetch;}
});

// ---- landfall wind: the forecast wind at the crossing, read from the advisory's MAX WIND lines ----
test('landfall carries the forecast wind at the crossing, interpolated between the bracketing points', async () => {
  responses[FEED] = { activeStorms: [storm()] };
  responses['https://fixture.invalid/tcm'] = '<pre>FORECAST VALID 09/1200Z 25.0N 88.0W\nMAX WIND  60 KT...GUSTS  75 KT.\nFORECAST VALID 10/1200Z 31.0N 88.0W\nMAX WIND  80 KT...GUSTS 100 KT.</pre>';
  const [st] = await m.gatherStorms(state());
  assert.deepEqual(st.forecast.map((q) => q.wind), [60, 80]);
  // About 87% of the way from 60 to 80 kt is 77 kt, kept on NHC's 5-kt steps so its mph and category agree (F35).
  assert.equal(st.landfall.windKt, 75);
  assert.equal(m.parseTCM('<pre>FORECAST VALID 09/1200Z 25.0N 88.0W</pre>', '2026-10-08T15:00:00Z')[0].wind, undefined, 'no wind line: no wind, still a valid point');
});

// ---- schedule and discussion ----
test('checks are due at 5 and 35 past the hour', () => {
  assert.equal(m.nextCheckAt(new Date('2026-10-07T03:00:30Z')), '2026-10-07T03:05:00.000Z');
  assert.equal(m.nextCheckAt(new Date('2026-10-07T03:05:00Z')), '2026-10-07T03:35:00.000Z');
  assert.equal(m.nextCheckAt(new Date('2026-10-07T03:20:00Z')), '2026-10-07T03:35:00.000Z');
  assert.equal(m.nextCheckAt(new Date('2026-10-07T03:50:00Z')), '2026-10-07T04:05:00.000Z');
});
test('the NHC discussion yields its reasoning and numbered Key Messages, and rejects another advisory', () => {
  const tcd = '<pre>Tropical Depression Nine Discussion Number   2\nNWS National Hurricane Center Miami FL       AL092026\n1000 PM CDT Tue Oct 06 2026\n \nFirst paragraph\nwraps here.\n\nSecond paragraph.\n\n \nKey Messages:\n \n1. Risk of dangerous wind and\nsurge.\n \n2. Heavy rain.\n \n \nFORECAST POSITIONS AND MAX WINDS\n\nINIT  07/0300Z 22.1N  95.0W   30 KT  35 MPH\n\n$$\nForecaster Reinhart</pre>';
  const d = m.parseTCD(tcd, { id: 'al092026', advNum: '002' });
  assert.equal(d.number, 2); assert.deepEqual(d.paragraphs, ['First paragraph wraps here.', 'Second paragraph.']);
  assert.deepEqual(d.keyMessages, ['Risk of dangerous wind and surge.', 'Heavy rain.']); assert.equal(d.forecaster, 'Reinhart');
  assert.equal(m.parseTCD(tcd, { id: 'al092026', advNum: '003' }), null, 'a discussion for another advisory is not this one');
  assert.equal(m.parseTCD('<html>busy</html>'), null);
});

// ---- Daniel's Average ----
test("Daniel's Average starts on the storm, matches tracks by valid time and stops when too few remain", () => {
  const t = (h) => new Date(Date.parse('2026-10-08T00:00:00Z') + h * 3600e3).toISOString();
  const line = (lon0, n, init) => ({ coords: Array.from({ length: n }, (_, i) => [-(lon0 - i * 0.5), 22 + i]), times: Array.from({ length: n }, (_, i) => t(init + i * 12)), init: '2026100800' });
  const avg = m.danielsAverage({
    start: { t: t(0), lat: 22, lonW: 95 },
    official: [{ t: t(24), lat: 24, lonW: 94 }, { t: t(48), lat: 26, lonW: 93 }],
    models: [{ tech: 'TVCN', ...line(95, 6, 0) }, { tech: 'HCCA', ...line(95.4, 6, 0) }, { tech: 'GDMN', ...line(94.6, 4, 0) },
      { tech: 'AEMN', ...line(95, 6, -6), init: '2026100718' }, { tech: 'AEMI', ...line(99, 6, 0), init: '2026100718' }],
    euro: [{ name: 'Euro ensemble typical path', run: t(-6), hours: [0, 12, 24, 36, 48, 60], coords: line(95, 6, -6).coords }],
  });
  assert.equal(avg.path[0].lat, 22); assert.equal(avg.path[0].lonW, 95, 'starts on the storm');
  assert.deepEqual(avg.members, ['NHC official', 'TVCN consensus', 'HCCA consensus', 'GEFS ensemble mean', 'Google DeepMind AI', 'Euro ensemble typical path'], 'one track per family: AEMN, not AEMI');
  assert.ok(avg.path.length >= 5 && avg.path.length <= 11, 'stops when fewer than 60% of tracks remain');
  assert.equal(m.danielsAverage({ start: { t: t(0), lat: 22, lonW: 95 }, official: [], models: [], euro: [] }), null, 'needs at least three tracks');
});

// ---- Full review, Oct 7 2026: each test names the finding it guards (F-numbers, listed in CODEX-HANDOFF.md) ----
const { gzipSync } = await import('node:zlib');
const nhc = async (id) => '<pre>' + await readFile(new URL(`./fixtures/nhc/TWOAT.${id}.txt`, import.meta.url), 'utf8') + '</pre>';
const MAPQ = (id) => `https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer/${id}/query?where=1%3D1&outFields=*&f=geojson&geometryPrecision=2`;
const ISO = '2026-10-08T15:00:00Z';

fixed('F1', 'outlooks that say plain "Gulf" (NHC wording since 2025) are read as Gulf disturbances', async () => {
  const short = m.parseTWOAll(await nhc('202508151144'));
  assert.equal(short.length, 1); assert.equal(short[0].area, 'Southwestern Gulf'); assert.equal(short[0].formation7d, 50); assert.equal(short[0].investHint, 'Invest 98L');
  assert.equal(m.parseTWOAll(await nhc('202507171134'))[0].area, 'Northern Gulf Coast');
  assert.equal(m.parseTWOAll(await nhc('202507151140'))[0].formation7d, 40);
  // Not every gulf is the Gulf.
  assert.equal(m.parseTWO(pre('Off the Southeast U.S. Coast:\nA low along the Gulf Stream.\n' + chances)), null);
  assert.equal(m.parseTWO(pre('Western Caribbean Sea:\nShowers near the Gulf of Honduras.\n' + chances)), null);
});
fixed('F2', 'a Potential Tropical Cyclone in the Active Systems block does not make the outlook unreadable', async () => {
  assert.deepEqual(m.parseTWOAll(await nhc('202411032346')), [], 'PTC paragraph after another storm, then two non-Gulf areas');
  assert.deepEqual(m.parseTWOAll(await nhc('202408112336')), [], 'a PTC is the only system');
});
fixed('F3', 'a special outlook that names the Gulf in its opening sentence is read, not rejected', async () => {
  const d = m.parseTWOAll(await nhc('202406222101'));
  assert.equal(d.length, 1); assert.equal(d[0].investHint, 'Invest 93L'); assert.equal(d[0].formation48, 40);
});
fixed('F4', 'the outlook ends at "&&": no WMO headers in the Gulf text, and the June 1 season note is not an entry', async () => {
  const d = m.parseTWO(pre('Southwestern Gulf of America (AL92):\nA low.\n' + chances + '\n\n&&\nPublic Advisories on Tropical Depression Nine are issued\nunder WMO header WTNT34 KNHC and under AWIPS header MIATCPAT4.\n\n$$\nForecaster Test'));
  assert.equal(d.formation7d, 90); assert.doesNotMatch(d.text, /&&|WMO|AWIPS/);
  assert.deepEqual(m.parseTWOAll(await nhc('202606010502')), []);
});
fixed('F105', "NHC's PC code is a Potential Tropical Cyclone (tropical); PTC is post-tropical", async () => {
  responses[FEED] = { activeStorms: [storm({ id: 'al102026', name: 'Ten', classification: 'PC', latitudeNumeric: 27, longitudeNumeric: -90 }),
    storm({ id: 'al112026', name: 'Eleven', classification: 'PTC', latitudeNumeric: 26, longitudeNumeric: -86, forecastAdvisory: { url: 'https://fixture.invalid/tcm2', issuance: ISO, advNum: '5' } })] };
  responses['https://fixture.invalid/tcm'] = TCM; responses['https://fixture.invalid/tcm2'] = TCM;
  const out = await m.gatherStorms(state());
  const pc = out.find((s) => s.id === 'al102026'), ptc = out.find((s) => s.id === 'al112026');
  assert.equal(pc.type, 'Potential Tropical Cyclone'); assert.equal(pc.tropical, true);
  assert.equal(ptc.type, 'Post-Tropical Cyclone'); assert.equal(ptc.tropical, false);
});
fixed('F90', 'a forecast advisory for another storm or another advisory number is unknown, not a track', () => {
  const tcm = '<pre>TROPICAL STORM TEST FORECAST/ADVISORY NUMBER   3\nNWS NATIONAL HURRICANE CENTER MIAMI FL       AL012026\nFORECAST VALID 09/1200Z 25.0N 88.0W</pre>';
  assert.equal(m.parseTCM(tcm, ISO, { id: 'al012026', advNum: '003' }).length, 1);
  assert.equal(m.parseTCM(tcm, ISO, { id: 'al022026', advNum: '3' }), null);
  assert.equal(m.parseTCM(tcm, ISO, { id: 'al012026', advNum: '4' }), null);
});
fixed('F94', 'Pacific storms and far-off Atlantic storms are not Gulf systems', async () => {
  responses[FEED] = { activeStorms: [storm({ id: 'ep152026', name: 'Pacific', latitudeNumeric: 18, longitudeNumeric: -100 }),
    storm({ id: 'al082026', name: 'Far', latitudeNumeric: 15, longitudeNumeric: -40, forecastAdvisory: { url: 'https://fixture.invalid/far', issuance: ISO, advNum: '1' } })] };
  responses['https://fixture.invalid/far'] = '<pre>FORECAST VALID 09/1200Z 16.0N 45.0W</pre>';
  const out = await m.gatherStorms(state());
  assert.equal(out.length, 0); assert.deepEqual(out.incomplete, []);
  assert.ok(!calls.includes('https://fixture.invalid/tcm'), 'the Pacific storm\'s advisory is never fetched');
});
fixed('F12', 'forecast advisories are fetched together, so one stalled page does not hold up the others', async () => {
  let inflight = 0, peak = 0;
  const mock = globalThis.fetch;
  globalThis.fetch = async (url, o) => { if (/fixture\.invalid\/t[12]$/.test(String(url))) { inflight++; peak = Math.max(peak, inflight); await new Promise((r) => setTimeout(r, 20)); inflight--; } return mock(url, o); };
  responses[FEED] = { activeStorms: [storm({ latitudeNumeric: 26, longitudeNumeric: -88, forecastAdvisory: { url: 'https://fixture.invalid/t1', issuance: ISO, advNum: '3' } }),
    storm({ id: 'al022026', name: 'Two', latitudeNumeric: 25, longitudeNumeric: -90, forecastAdvisory: { url: 'https://fixture.invalid/t2', issuance: ISO, advNum: '1' } })] };
  responses['https://fixture.invalid/t1'] = TCM; responses['https://fixture.invalid/t2'] = TCM;
  try { await m.gatherStorms(state()); } finally { globalThis.fetch = mock; }
  assert.equal(peak, 2);
});
fixed('F6', 'a new storm near the Gulf whose forecast cannot be read holds the tracked Invest instead of going quiet', async () => {
  const prior = state({ gulf: { area: 'Northwestern Caribbean Sea', formation7d: 90, formation48: 70, invest: 'Invest 92L', source: 'x' }, internal: { baseline7d: 90, baseline48: 70, failCount: 0 },
    tracked: { invest: 'Invest 92L', stormId: null, name: 'Invest 92L', lastPos: { lat: 19, lonW: 86 } } });
  responses[TWO] = quietOutlook(); // NHC has moved the system to "Active Systems"
  responses[FEED] = { activeStorms: [storm({ id: 'al092026', name: 'Nine', classification: 'TD', latitudeNumeric: 19.5, longitudeNumeric: -86 })] };
  responses['https://fixture.invalid/tcm'] = { __http: 503 };
  let d = await runMain(prior);
  assert.equal(d.alertLevel, 'watch'); assert.match(d.sources.storms, /incomplete \(al092026/); assert.equal(d.sources.forecast, 'unavailable');
  d = await runMain(d);
  assert.equal(d.alertLevel, 'watch', 'still held on the second check'); assert.equal(d.tracked.invest, 'Invest 92L');
});
fixed('F101', 'an unreadable outlook does not cancel the one-check hold for a storm missing from the feed', async () => {
  const prior = state({ alertLevel: 'threat', gulf: { area: '', formation7d: null, formation48: null }, storms: [forecastStorm({ pos: { lat: 25, lonW: 88 } })], tracked: { stormId: 'al012026' }, landfall: { state: 'AL', eta: '2026-10-10T08:00:00Z', near: 'Mobile, AL' } });
  responses[FEED] = { activeStorms: [] };
  const d = await runMain(prior, { twoFails: true });
  assert.equal(d.alertLevel, 'threat'); assert.equal(d.internal.vanishedChecks, 1);
});
fixed('F16', 'an unreadable outlook does not make a fresh storm reading look old; a carried storm reading does', async () => {
  const prior = state({ alertLevel: 'threat', gulf: { area: '', formation7d: null, formation48: null }, storms: [forecastStorm({ pos: { lat: 25, lonW: 88 } })], tracked: { stormId: 'al012026' } });
  responses[FEED] = { activeStorms: [storm({ latitudeNumeric: 27, longitudeNumeric: -88 })] }; responses['https://fixture.invalid/tcm'] = TCM;
  let d = await runMain(prior, { twoFails: true });
  assert.equal(d.updatedAt, '2026-10-08T15:00:00.000Z', 'storm feed fresh: reading fresh');
  d = await runMain(prior, { feedFails: true });
  assert.equal(d.updatedAt, '2026-10-08T06:00:00.000Z', 'storm feed carried: reading not fresh'); assert.equal(d.lastAttemptAt, '2026-10-08T15:00:00.000Z');
});
fixed('F28', 'an inland center is not a moving forecast landfall, and reaching land is not "no longer reaches the coast"', async () => {
  responses[FEED] = { activeStorms: [storm({ latitudeNumeric: 31.6, longitudeNumeric: -88.6 })] };
  responses['https://fixture.invalid/tcm'] = '<pre>FORECAST VALID 09/1200Z 33.0N 88.0W\nFORECAST VALID 10/1200Z 35.0N 87.0W</pre>';
  const [st] = await m.gatherStorms(state());
  assert.equal(st.landfall, null); assert.equal(st.ashore.state, 'MS'); assert.equal(st.gulfRisk, 'The center is over land');
  const prior = m.build(state(), null, [forecastStorm({ landfall: { state: 'MS', eta: '2026-10-08T14:00:00Z', near: 'Pascagoula, MS' }, ashore: null })], ww());
  const cur = m.build(prior, null, [{ ...st, tropical: true }], ww());
  const ch = m.diff(prior, cur).join(' | ');
  assert.match(ch, /Landfall in MS/); assert.doesNotMatch(ch, /no longer reaches|shifted|timing moved/);
});
fixed('F33', 'an inland center is described as inland, not "approaching the Gulf"', async () => {
  responses[FEED] = { activeStorms: [storm({ latitudeNumeric: 32.5, longitudeNumeric: -88.6 })] };
  responses['https://fixture.invalid/tcm'] = '<pre>FORECAST VALID 09/1200Z 34.0N 88.0W</pre>';
  const prior = state({ storms: [forecastStorm({ pos: { lat: 31, lonW: 88.6 } })] });
  const [st] = await m.gatherStorms(prior);
  assert.match(st.location, /32\.5N 88\.6W, inland$/);
});
fixed('F5', 'a final advisory with no track publishes no track, not the previous one', async () => {
  responses[FEED] = { activeStorms: [storm({ latitudeNumeric: 27, longitudeNumeric: -88 })] };
  responses['https://fixture.invalid/tcm'] = '<pre>REMNANTS OF TEST ... DISSIPATED</pre>';
  const [st] = await m.gatherStorms(state({ storms: [forecastStorm({ forecast: [{ t: '2026-10-09T12:00:00Z', lat: 30, lonW: 88 }] })] }));
  assert.deepEqual(st.forecast, []); assert.equal(st.forecastStale, false);
});
fixed('F110', 'the advisory number is written one way everywhere ("2", as NHC\'s map service writes it)', async () => {
  responses[FEED] = { activeStorms: [storm({ latitudeNumeric: 27, longitudeNumeric: -88, forecastAdvisory: { url: 'https://fixture.invalid/tcm', issuance: ISO, advNum: '002' } })] };
  responses['https://fixture.invalid/tcm'] = TCM;
  const [st] = await m.gatherStorms(state());
  assert.equal(st.advisory, 'NHC advisory 2');
  for (const id of [6, 7, 9, 12]) responses[MAPQ(id)] = { features: [] };
  assert.equal((await m.gatherMap(null, { ...st, bin: 'AT1' })).advisory, '2');
});
fixed('F100', 'the storm keeps the time of its position fix, apart from the forecast advisory time', async () => {
  responses[FEED] = { activeStorms: [storm({ latitudeNumeric: 27, longitudeNumeric: -88, lastUpdate: '2026-10-08T18:00:00Z' })] };
  responses['https://fixture.invalid/tcm'] = TCM;
  const [st] = await m.gatherStorms(state());
  assert.equal(st.posAt, '2026-10-08T18:00:00Z'); assert.equal(st.advisoryAt, '2026-10-08T15:00:00Z');
});
fixed('F104', 'an NWS test or exercise warning, or a cancellation, is not a real warning', async () => {
  responses[alertsURL('MS')] = { features: [{ properties: { event: 'Hurricane Warning', status: 'Test', messageType: 'Alert' } }, { properties: { event: 'Tropical Storm Watch', status: 'Actual', messageType: 'Cancel' } }] };
  for (const s of ['AL', 'FL', 'LA']) responses[alertsURL(s)] = { features: [] };
  assert.deepEqual((await m.gatherAlerts(state(), true)).MS, {});
  responses[alertsURL('MS')] = { features: [{ properties: { event: 'Hurricane Warning', status: 'Actual', messageType: 'Alert' } }] };
  assert.equal((await m.gatherAlerts(state(), true)).MS.level, 'warning');
});
fixed('F21', 'Florida warnings count while the only Gulf storm is not the tracked system', async () => {
  const p = state({ tracked: { invest: 'Invest 92L', stormId: null, lastPos: { lat: 22, lonW: 96 } } });
  responses[TWO] = '<pre>Tropical Weather Outlook\n1000 AM CDT Thu Oct 8 2026\n\nFor the North Atlantic...\n\nGulf of Mexico (AL92):\nThe tracked disturbance remains.\n' + chances + '</pre>';
  responses[FEED] = { activeStorms: [storm({ id: 'al032026', name: 'Unrelated', latitudeNumeric: 27, longitudeNumeric: -83, forecastAdvisory: { url: 'https://fixture.invalid/tcm', issuance: '2026-10-08T12:00:00Z', advNum: '3' } })] };
  responses['https://fixture.invalid/tcm'] = TCM;
  responses[alertsURL('FL')] = { features: [{ properties: { event: 'Hurricane Warning', status: 'Actual' } }] };
  const d = await runMain(p);
  assert.equal(d.tracked.stormId, null, 'the storm stays another system'); assert.equal(d.watchesWarnings.FL.level, 'warning'); assert.equal(d.alertLevel, 'threat');
});
fixed('F17', 'with every storm map layer down, the map is drawn from the text advisory', async () => {
  for (const id of [6, 7, 9, 12]) responses[MAPQ(id)] = new Error('fixture outage');
  const map = await m.gatherMap(null, forecastStorm({ bin: 'AT1', advisory: 'NHC advisory 3', pos: { lat: 25, lonW: 88 }, forecast: [{ t: '2026-10-09T12:00:00Z', lat: 30, lonW: 88 }] }));
  assert.ok(map.features.some((f) => f.properties.role === 'track')); assert.match(map.source, /map layers unavailable/);
  await assert.rejects(m.gatherMap(null, forecastStorm({ bin: 'AT1', pos: { lat: 25, lonW: 88 }, forecast: [] })), /all storm map layers unavailable/);
});
fixed('F34', 'coastal watch lines are kept when the forecast-points layer fails', async () => {
  responses[MAPQ(6)] = new Error('points layer down'); responses[MAPQ(7)] = { features: [] }; responses[MAPQ(12)] = { features: [] };
  responses[MAPQ(9)] = { features: [{ geometry: { type: 'LineString', coordinates: [[-88, 30], [-87, 30.2]] }, properties: { advisnum: '3', tcww: 'TWR' } }] };
  const map = await m.gatherMap(null, forecastStorm({ bin: 'AT1', pos: { lat: 25, lonW: 88 }, forecast: [{ t: '2026-10-09T12:00:00Z', lat: 30, lonW: 88 }] }));
  assert.equal(map.features.filter((f) => f.properties.role === 'ww').length, 1);
});
fixed('F98', 'an Invest designated in December keeps its year in January', () => {
  assert.deepEqual(m.investYears(new Date('2027-01-02T00:00:00Z')), [2027, 2026]);
  assert.deepEqual(m.investYears(new Date('2026-10-08T00:00:00Z')), [2026]);
});
fixed('F29', "Daniel's Average keeps a model run filed a few hours after the storm's fix", () => {
  const t = (h) => new Date(Date.parse('2026-10-08T00:00:00Z') + h * 3600e3).toISOString();
  const line = (lon0, n, from) => ({ coords: Array.from({ length: n }, (_, i) => [-(lon0 - i * 0.5), 22 + i]), times: Array.from({ length: n }, (_, i) => t(from + i * 12)) });
  const avg = m.danielsAverage({ start: { t: t(0), lat: 22, lonW: 95 }, official: [{ t: t(24), lat: 24, lonW: 94 }, { t: t(48), lat: 26, lonW: 93 }],
    models: [{ tech: 'TVCN', init: '2026100803', ...line(95, 6, 3) }, { tech: 'HCCA', init: '2026100803', ...line(95.2, 6, 3) }], euro: [] });
  assert.deepEqual(avg.members, ['NHC official', 'TVCN consensus', 'HCCA consensus']);
});
fixed('F18', 'a new disturbance starts its own odds baseline; a number left from an earlier system never alerts', () => {
  const stormStage = state({ gulf: { area: '', formation7d: null, formation48: null }, internal: { baseline7d: 100, baseline48: 100, failCount: 0 }, storms: [forecastStorm()] });
  const a = m.build(stormStage, { area: 'Northwestern Caribbean Sea', formation7d: 20, formation48: 0, source: 'x' }, [forecastStorm()], ww());
  assert.equal(a.internal.baseline7d, 20); assert.equal(a.internal.baseline48, 0);
  const b = m.build(a, { area: 'Northwestern Caribbean Sea', formation7d: 30, formation48: 0, source: 'x' }, [forecastStorm()], ww());
  assert.deepEqual(m.diff(a, b).filter((c) => /odds/.test(c)), []);
});
fixed('F22', 'a storm that returns to the feed after its landfall hold is not announced as landing again', () => {
  const prior = state({ alertLevel: 'quiet', gulf: {}, storms: [], landfallOccurred: null, internal: { landfallAt: '2026-10-05T06:00:00Z', landfallState: 'MS', landfallStormId: 'al012026', failCount: 0 } });
  const cur = m.build(prior, null, [forecastStorm({ landfall: null, ashore: null })], ww());
  assert.ok(cur.landfallOccurred, 'the record is still reported for that storm');
  assert.doesNotMatch(m.diff(prior, cur).join(' | '), /Landfall in/);
});
fixed('F23', 'a second storm with a coastal forecast is announced once', () => {
  const near = forecastStorm({ id: 'al022026', name: 'Tropical Storm Near' }), far = forecastStorm({ id: 'al012026', name: 'Tropical Storm Far' });
  const cur = { ...state({ storms: [near, far] }), others: [{ id: 'al012026', name: 'Tropical Storm Far', threat: true, detail: 'is forecast to reach the coast near Dauphin Island, AL' }] };
  const ch = m.diff(state({ storms: [near] }), cur).join(' | ');
  assert.match(ch, /Another Gulf system: Tropical Storm Far/); assert.doesNotMatch(ch, /Tropical Storm Far is now a Gulf system/);
});
fixed('F24', 'when another storm takes over, its landfall is announced as new, not as a shift of the old one', () => {
  const prior = state({ storms: [forecastStorm({ id: 'al022026', name: 'Tropical Storm Old' })], landfall: { state: 'LA', eta: '2026-10-10T06:00:00Z', near: 'Cameron, LA' } });
  const cur = state({ storms: [forecastStorm({ id: 'al032026', name: 'Tropical Storm Different' })], landfall: { state: 'FL', eta: '2026-10-10T06:00:00Z', near: 'Destin, FL' } });
  const ch = m.diff(prior, cur).join(' | ');
  assert.match(ch, /Forecast track now reaches the coast near Destin, FL/); assert.doesNotMatch(ch, /shifted/);
});
fixed('F25', 'the second-storm clause keeps town names, states and times as written', () => {
  const other = forecastStorm({ id: 'al022026', name: 'Hurricane Other', winds: 90, gulfRisk: 'Forecast track reaches the coast near St. Petersburg, FL around Thu, Oct 8, 9 PM CT (approximate)' });
  const d = m.build(state(), null, [forecastStorm(), other], ww());
  assert.match(d.headline, /Also in the Gulf: Hurricane Other \(105 mph; forecast track reaches the coast near St\. Petersburg, FL around Thu, Oct 8, 9 PM CT/);
});
fixed('F10', 'a known Invest number is kept when model guidance has nothing usable, so it is not announced again', async () => {
  const prior = state({ gulf: { area: 'Southwestern Gulf of America', formation7d: 90, formation48: 70, invest: 'Invest 92L', source: 'x' }, internal: { baseline7d: 90, baseline48: 70, failCount: 0 },
    tracked: { invest: 'Invest 92L', stormId: null, name: 'Invest 92L', lastPos: { lat: 22, lonW: 95 } } });
  responses[TWO] = pre('Southwestern Gulf of America:\nNo (ALnn) tag in this heading.\n' + chances);
  responses['https://ftp.nhc.noaa.gov/atcf/aid_public/'] = '<html>no recent files</html>';
  // The Invest's a-deck reads fine but its newest run is two days old: guidance has nothing usable this check.
  responses['https://ftp.nhc.noaa.gov/atcf/aid_public/aal922026.dat.gz'] = gzipSync(['0', '12', '24'].map((tau, i) => `AL, 92, 2026100600, 03, TVCN, ${tau}, ${220 + i * 5}N, ${950 - i * 5}W, 30`).join('\n'));
  const d = await runMain(prior);
  assert.equal(d.gulf.invest, 'Invest 92L');
  assert.doesNotMatch(JSON.parse(await readFile('data/log.json', 'utf8'))[0].summary, /designated/);
});
fixed('F47', 'with no ntfy topic the private alert is not sent, not queued for retry, and its private text is never printed', async () => {
  process.env.PLAYS_JSON = JSON.stringify({ watch: 'PRIVATE_SENTINEL_F47' });
  const out = [], log = console.log;
  console.log = (...a) => { out.push(a.join(' ')); };
  try {
    const d = await runMain(state({ alertLevel: 'quiet', gulf: {} }));
    assert.equal(d.alertLevel, 'watch'); assert.equal(d.internal.pending, null, 'nothing to retry (F91)');
    assert.equal(out.join('\n').includes('PRIVATE_SENTINEL_F47'), false);
  } finally { console.log = log; delete process.env.PLAYS_JSON; }
});

// Browser push with web-push stubbed (no network, no keys).
async function withPush(send, fn) {
  const webpush = (await import('web-push')).default;
  const oldSend = webpush.sendNotification, oldVapid = webpush.setVapidDetails;
  Object.assign(process.env, { PUSH_API: 'https://fixture.invalid', PUSH_ADMIN_KEY: 'fixture', VAPID_PRIVATE_KEY: 'fixture', PUSH_DEADLINE_MS: '50' });
  webpush.setVapidDetails = () => {}; webpush.sendNotification = send;
  responses['https://fixture.invalid/subscriptions'] = [{ endpoint: 'https://fixture.invalid/device', keys: {} }];
  responses['https://fixture.invalid/prune'] = { removed: 1 };
  try { return await fn(); } finally {
    webpush.sendNotification = oldSend; webpush.setVapidDetails = oldVapid;
    for (const k of ['PUSH_API', 'PUSH_ADMIN_KEY', 'VAPID_PRIVATE_KEY', 'PUSH_DEADLINE_MS', 'TEST_PUSH']) delete process.env[k];
  }
}
const browserMsg = { privateTitle: '', publicTitle: 'Fixture', publicBody: 'Fixture', level: 'watch' };
fixed('F9', 'a push service that never answers cannot hold up delivery: the device counts as failed and is retried', async () => {
  let opts = null;
  await withPush((s, p, o) => { opts = o; return new Promise(() => {}); }, async () => {
    const t0 = Date.now();
    const d = await m.deliver(browserMsg);
    assert.ok(Date.now() - t0 < 2000, 'returned at the deadline'); assert.equal(d.browser, false); assert.equal(d.browserFailed.length, 1);
    assert.ok(opts.timeout > 0, 'each send has its own timeout');
  });
});
fixed('F45', 'a device whose keys can never be encrypted to is pruned, not retried on every alert', async () => {
  await withPush(async () => { throw new Error('Public key is not valid for specified curve'); }, async () => {
    const d = await m.deliver(browserMsg);
    assert.deepEqual(d.browserFailed, []); assert.ok(calls.includes('https://fixture.invalid/prune'));
  });
  const r = await worker.fetch(workerReq('/subscribe', { endpoint: PUSH_EP, keys: { p256dh: Buffer.from([4, ...Array(64).fill(7)]).toString('base64url'), auth: PUSH_KEYS.auth } }), { SUBS: memKV() });
  assert.equal(r.status, 400, 'the worker refuses a key that is not a curve point');
});
fixed('F38', 'TEST_PUSH sends a payload-free push, which the page shows as a test, never under the alert tag', async () => {
  const payloads = [];
  await withPush(async (s, p) => { payloads.push(p); }, async () => { process.env.TEST_PUSH = '1'; await m.main(); });
  assert.deepEqual(payloads, [null]);
});
fixed('F43', 'the worker spends no write on an unchanged re-registration, caps tap counters, and answers 503 when storage is full', async () => {
  const kv = memKV(), put = kv.put; let writes = 0;
  kv.put = async (...a) => { writes++; return put(...a); };
  const env = { SUBS: kv };
  assert.equal((await worker.fetch(workerReq('/subscribe', { endpoint: PUSH_EP, keys: PUSH_KEYS }), env)).status, 201);
  const w = writes;
  assert.equal((await worker.fetch(workerReq('/subscribe', { endpoint: PUSH_EP, keys: PUSH_KEYS }), env)).status, 200);
  assert.equal(writes, w, 'the daily re-registration of an unchanged subscription costs nothing');
  writes = 0;
  for (let i = 0; i < 130; i++) await worker.fetch(new Request('https://fixture.invalid/hit', { method: 'POST', body: 'share' }), env);
  assert.equal(writes, 100, 'tap counting stops at the daily cap');
  kv.put = async () => { throw new Error('KV put() limit exceeded for the day'); };
  assert.equal((await worker.fetch(workerReq('/subscribe', { endpoint: PUSH_EP.replace('fixture-device', 'other'), keys: PUSH_KEYS }), env)).status, 503);
});
fixed('F48', 'the usage report reads counts from one listing, not one read per counter', async () => {
  const a = new Map(); let gets = 0;
  const kv = { get: async (k) => { gets++; return a.get(k)?.value ?? null; }, getWithMetadata: async (k) => a.get(k) ?? null, put: async (k, value, o = {}) => { a.set(k, { value, metadata: o.metadata }); }, delete: async (k) => { a.delete(k); },
    list: async () => ({ keys: [...a].map(([name, v]) => ({ name, metadata: v.metadata })), list_complete: true }) };
  const env = { SUBS: kv, ADMIN_KEY: 'fixture-admin' };
  for (const e of ['share', 'share', 'alerts-open']) await worker.fetch(new Request('https://fixture.invalid/hit', { method: 'POST', body: e }), env);
  gets = 0;
  const r = await worker.fetch(new Request('https://fixture.invalid/stats', { headers: { 'x-key': 'fixture-admin' } }), env);
  const day = new Date().toISOString().slice(0, 10), j = await r.json();
  assert.equal(j.counts[day].share, 2); assert.equal(j.counts[day]['alerts-open'], 1); assert.equal(gets, 0);
});

// ---- alert triggers in CLAUDE.md that had no test (F80-F83, F86, F87, F89, F93) ----
test('odds alerts: crossing 40 or 60, a 20-point move since the last alert, and nothing for smaller moves', async () => {
  const at = (p7, p48, b7 = p7, b48 = p48) => state({ gulf: { area: 'Gulf of Mexico', formation7d: p7, formation48: p48 }, internal: { baseline7d: b7, baseline48: b48, failCount: 0 } });
  const odds = (a, b) => m.diff(a, b).filter((c) => /odds/.test(c));
  assert.deepEqual(odds(at(30, 10), at(40, 10)), ['7-day formation odds 30% -> 40%']);
  assert.deepEqual(odds(at(55, 10), at(60, 10)), ['7-day formation odds 55% -> 60%']);
  assert.deepEqual(odds(at(20, 10), at(39, 10)), [], 'under both thresholds and under 20 points');
  assert.deepEqual(odds(at(25, 10, 10), at(30, 10)), ['7-day formation odds 10% -> 30%'], '20 points since the last alert');
  assert.deepEqual(odds(at(50, 30), at(50, 45)), ['48-hour formation odds 30% -> 45%']);
  // After an alert the baseline moves to the new reading.
  responses[TWO] = pre('Gulf of Mexico:\nA low.\n* Formation chance through 48 hours...low...10 percent.\n* Formation chance through 7 days...medium...45 percent.');
  const d = await runMain(at(30, 10));
  assert.equal(d.internal.baseline7d, 45); assert.equal(d.internal.baseline48, 10);
});
test('coastal alerts: posted, changed and dropped are alerts, a warning raises the level, and Florida needs a Gulf storm', async () => {
  const a = state(), b = state(), c = state();
  b.watchesWarnings.MS = { level: 'watch', text: 'Hurricane Watch' };
  c.watchesWarnings.MS = { level: 'warning', text: 'Hurricane Warning' };
  assert.match(m.diff(a, b).join(' | '), /MS: tropical watch posted \(Hurricane Watch\)/);
  assert.match(m.diff(b, c).join(' | '), /MS: tropical warning posted \(Hurricane Warning\)/);
  assert.match(m.diff(c, a).join(' | '), /MS: tropical warning dropped/);
  assert.equal(m.build(state(), null, [], { ...ww(), MS: { level: 'warning', text: 'Hurricane Warning' } }).alertLevel, 'threat');
  for (const s of ['AL', 'FL', 'MS', 'LA']) responses[alertsURL(s)] = { features: [{ properties: { event: 'Tropical Storm Warning', status: 'Actual' } }, { properties: { event: 'Flood Watch', status: 'Actual' } }] };
  const g = await m.gatherAlerts(state(), false);
  assert.deepEqual(g.FL, {}, 'Atlantic-side Florida alerts do not count without a Gulf storm');
  assert.deepEqual(g.MS, { level: 'warning', text: 'Tropical Storm Warning' });
});
test('forecast landfall alerts: first reaches, no longer reaches, a state shift and a 12-hour timing shift', () => {
  const s = (lf) => state({ storms: [forecastStorm()], landfall: lf });
  const L = (st, eta) => ({ state: st, eta, near: st === 'MS' ? 'Biloxi, MS' : 'Mobile, AL' });
  const lf = (a, b) => m.diff(a, b).filter((c) => /landfall|reaches the/i.test(c)).join(' | ');
  assert.match(lf(s(null), s(L('MS', '2026-10-10T06:00:00Z'))), /now reaches the coast near Biloxi, MS/);
  assert.match(lf(s(L('MS', '2026-10-10T06:00:00Z')), s(null)), /no longer reaches/);
  assert.match(lf(s(L('MS', '2026-10-10T06:00:00Z')), s(L('AL', '2026-10-10T06:00:00Z'))), /shifted MS -> AL/);
  assert.match(lf(s(L('MS', '2026-10-10T06:00:00Z')), s(L('MS', '2026-10-10T18:00:00Z'))), /timing moved/);
  assert.equal(lf(s(L('MS', '2026-10-10T06:00:00Z')), s(L('MS', '2026-10-10T17:00:00Z'))), '', 'an 11-hour shift is log-only');
});
test('storm lifecycle alerts: forms, changes type or category, dissipates; winds within a class do not alert', () => {
  const S = (x) => state({ storms: x });
  const td = forecastStorm({ name: 'Tropical Depression Nine', type: 'Tropical Depression', winds: 30, category: 0 });
  const ts = { ...td, name: 'Tropical Storm Isaias', type: 'Tropical Storm', winds: 45 };
  const h1 = { ...ts, name: 'Hurricane Isaias', type: 'Hurricane', winds: 70, category: 1 };
  const d = (a, b) => m.diff(S(a), S(b)).join(' | ');
  assert.match(d([], [td]), /Tropical Depression Nine is now a Gulf system/);
  assert.match(d([td], [ts]), /Tropical Depression Nine is now Tropical Storm Isaias/);
  assert.match(d([h1], [{ ...h1, winds: 85, category: 2 }]), /is now Category 2/);
  assert.equal(d([h1], [{ ...h1, winds: 80 }]), '', 'a stronger Category 1 is not an alert');
  assert.match(d([ts], []), /no longer an active Gulf storm/);
});
test('NHC unreachable twice in a row sends one private outage notice, on the second check only', async () => {
  process.env.NTFY_TOPIC = 'fixture-private';
  try {
    let d = await runMain(state(), { twoFails: true, feedFails: true });
    assert.equal(calls.filter((u) => u === 'https://ntfy.sh/').length, 0);
    d = await runMain(d, { twoFails: true, feedFails: true });
    assert.equal(d.internal.failCount, 2); assert.equal(calls.filter((u) => u === 'https://ntfy.sh/').length, 1);
    assert.equal(JSON.parse(await readFile('data/log.json', 'utf8'))[0].outagePush, true);
  } finally { delete process.env.NTFY_TOPIC; }
});
test("alert text: the owner's Play text and the Google line go only to the private channel", async () => {
  process.env.PLAYS_JSON = JSON.stringify({ threat: 'PLAY_SENTINEL' });
  Object.assign(process.env, { NTFY_TOPIC: 'fixture-private', PUBLIC_NTFY_TOPIC: 'fixture-public' });
  const sent = [], mock = globalThis.fetch;
  globalThis.fetch = async (u, o) => { if (String(u) === 'https://ntfy.sh/') { sent.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({}) }; } return mock(u, o); };
  try {
    const msg = m.composeMessage({ level: 'threat', changes: ['Alert level MONITORING -> THREAT'], headline: 'Headline', google: 'Google summary' });
    assert.match(msg.privateBody, /PLAY_SENTINEL/); assert.match(msg.privateBody, /Google AI ensemble/);
    assert.doesNotMatch(msg.publicBody, /PLAY_SENTINEL|Google AI ensemble/);
    await m.deliver(msg);
    assert.match(sent.find((s) => s.topic === 'fixture-private').message, /PLAY_SENTINEL/);
    assert.deepEqual(sent.map((s) => s.topic), ['fixture-private'], 'only the private topic: the public ntfy feed is retired');
  } finally { globalThis.fetch = mock; for (const k of ['PLAYS_JSON', 'NTFY_TOPIC', 'PUBLIC_NTFY_TOPIC']) delete process.env[k]; }
});
test('the Google ensemble summary keeps only aggregate numbers, never member tracks', () => {
  const rows = ['track_id,sample,valid_time,lat,lon,maximum_sustained_wind_speed_knots'];
  for (let s = 0; s < 12; s++) for (let h = 0; h <= 48; h += 12) {
    const t = new Date(Date.parse('2026-10-08T12:00:00Z') + h * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
    rows.push(['AL092026', s, t, ((s < 8 ? 24 : 21) + h / 6).toFixed(1), '-89.0', 50 + h].join(','));
  }
  const g = m.summarizeGoogle(rows.join('\n'), ['AL092026'], '2026-10-08T12:00:00Z');
  assert.equal(g.members, 12); assert.equal(g.hits, 8); assert.equal(g.coast.MS, 8);
  assert.ok(Object.values(g).every((v) => !Array.isArray(v)), 'no arrays of positions anywhere in the summary');
});
test('outlook-stage map: Atlantic development areas touching the Gulf only, never Pacific ones', async () => {
  const poly = (pts, basin) => ({ geometry: { type: 'Polygon', coordinates: [pts] }, properties: { basin, prob7day: '70%', risk7day: 'High' } });
  responses[MAPQ(3)] = { features: [poly([[-92, 24], [-90, 24], [-90, 26], [-92, 24]], 'Atlantic'), poly([[-60, 15], [-58, 15], [-58, 17], [-60, 15]], 'Atlantic'), poly([[-95, 19], [-94, 19], [-94, 20], [-95, 19]], 'Eastern Pacific')] };
  responses[MAPQ(2)] = { features: [] }; responses[MAPQ(398)] = { features: [] };
  const map = await m.gatherMap({ area: 'Gulf of Mexico', source: 'NHC outlook' }, null);
  assert.equal(map.kind, 'outlook'); assert.equal(map.features.filter((f) => f.properties.role === 'area').length, 1);
});

// ---- Owner-approved changes, Oct 7 2026 (review items F8, F7, F44) ----
fixed('F8', 'while a storm is tracked, only the outlook entry tagged with its Invest is that system; another designated Invest at 40%+ is announced once', async () => {
  const prior = state({ alertLevel: 'threat', gulf: { area: '', formation7d: null, formation48: null }, storms: [forecastStorm({ id: 'al092026', pos: { lat: 22, lonW: 94 } })],
    landfall: { state: 'AL', eta: '2026-10-10T08:00:00Z', near: 'Mobile, AL' }, internal: { failCount: 0, othersAlerted: [] },
    tracked: { invest: 'Invest 92L', stormId: 'al092026', name: 'Tropical Storm Test', lastPos: { lat: 22, lonW: 94 }, since: '2026-10-08T03:00:00Z' } });
  const two = (head, p7) => '<pre>Tropical Weather Outlook\n1000 AM CDT Thu Oct 8 2026\n\nFor the North Atlantic...\n\n' + head + ':\nAnother low.\n* Formation chance through 48 hours...low...20 percent.\n* Formation chance through 7 days...medium...' + p7 + ' percent.</pre>';
  const run = async (p, head, p7) => { responses[TWO] = two(head, p7); responses[FEED] = { activeStorms: [storm({ id: 'al092026', latitudeNumeric: 22, longitudeNumeric: -94 })] }; responses['https://fixture.invalid/tcm'] = TCM;
    const d = await runMain(p); return { d, summary: JSON.parse(await readFile('data/log.json', 'utf8'))[0].summary }; };
  let r = await run(prior, 'Eastern Gulf of America (AL93)', 30);
  assert.equal(r.d.tracked.invest, 'Invest 92L'); assert.equal(r.d.gulf.formation7d, null, 'the other entry is not the tracked system');
  assert.doesNotMatch(r.summary, /designated|odds|Another Gulf system/);
  r = await run(r.d, 'Eastern Gulf of America (AL93)', 50);
  assert.match(r.summary, /Another Gulf system: Invest 93L \(Eastern Gulf of America\) has a 50% chance of forming within 7 days/);
  r = await run(r.d, 'Eastern Gulf of America (AL93)', 60);
  assert.doesNotMatch(r.summary, /Another Gulf system|odds/, 'announced once');
  r = await run(r.d, 'Northwestern Gulf of America', 70);
  assert.doesNotMatch(r.summary, /Another Gulf system|designated|odds/, 'an untagged entry beside a storm is only listed');
  r = await run(r.d, 'Western Gulf of America (AL92)', 90);
  assert.equal(r.d.gulf.formation7d, 90, 'the entry tagged with our Invest is still our system');
  // Invest numbers are reused: an AL93 beside a later storm is a new system and is announced.
  const later = { ...r.d, storms: [forecastStorm({ id: 'al122026', pos: { lat: 22, lonW: 94 } })], tracked: { invest: 'Invest 97L', stormId: 'al122026', name: 'Tropical Storm Later', lastPos: { lat: 22, lonW: 94 }, since: '2026-10-08T03:00:00Z' },
    internal: { ...r.d.internal, othersAlerted: ['Invest 93L@al092026'] } };
  responses[TWO] = two('Northeastern Gulf of America (AL93)', 70); responses[FEED] = { activeStorms: [storm({ id: 'al122026', latitudeNumeric: 22, longitudeNumeric: -94 })] }; responses['https://fixture.invalid/tcm'] = TCM;
  const d2 = await runMain(later);
  assert.match(JSON.parse(await readFile('data/log.json', 'utf8'))[0].summary, /Another Gulf system: Invest 93L/);
  assert.deepEqual(d2.internal.othersAlerted, ['Invest 93L@al122026'], 'only this storm\'s announcements are remembered');
  // When the storm leaves and the Invest announced beside it takes over, it is not "designated" a second time.
  const cur = m.build(d2, { area: 'Northeastern Gulf of America', formation7d: 70, formation48: 20, invest: 'Invest 93L', source: 'x' }, [], ww());
  assert.doesNotMatch(m.diff(d2, cur).join(' | '), /designated/);
});
fixed('F7', "a storm-feed outage during a storm reaches the owner after two checks, even while the outlook still loads", async () => {
  process.env.NTFY_TOPIC = 'fixture-private';
  try {
    const prior = state({ alertLevel: 'threat', gulf: { area: '', formation7d: null, formation48: null }, storms: [forecastStorm({ pos: { lat: 25, lonW: 88 } })], tracked: { stormId: 'al012026' }, landfall: { state: 'AL', eta: '2026-10-10T08:00:00Z', near: 'Mobile, AL' } });
    responses[TWO] = quietOutlook();
    let d = await runMain(prior, { feedFails: true });
    assert.equal(d.internal.downCount, 1); assert.equal(calls.filter((u) => u === 'https://ntfy.sh/').length, 0);
    d = await runMain(d, { feedFails: true });
    assert.equal(d.internal.downCount, 2); assert.equal(calls.filter((u) => u === 'https://ntfy.sh/').length, 1, 'one private notice');
    assert.equal(JSON.parse(await readFile('data/log.json', 'utf8'))[0].outagePush, true);
    // An unreadable outlook during the storm stage is not an outage of the storm's own source.
    responses[FEED] = { activeStorms: [storm({ latitudeNumeric: 25, longitudeNumeric: -88 })] }; responses['https://fixture.invalid/tcm'] = TCM;
    d = await runMain(d, { twoFails: true }); d = await runMain(d, { twoFails: true });
    assert.equal(d.internal.downCount, 0);
  } finally { delete process.env.NTFY_TOPIC; }
});
fixed('F44', 'the public ntfy feed is retired (owner, Oct 7); the private topic carries its own token only', async () => {
  Object.assign(process.env, { NTFY_TOPIC: 'fixture-private', PUBLIC_NTFY_TOPIC: 'fixture-public', PUBLIC_NTFY_TOKEN: 'tk_fixture' });
  const sent = [], mock = globalThis.fetch;
  globalThis.fetch = async (u, o) => { if (String(u) === 'https://ntfy.sh/') { sent.push({ topic: JSON.parse(o.body).topic, auth: o.headers.Authorization }); return { ok: true, status: 200, json: async () => ({}) }; } return mock(u, o); };
  try {
    await m.deliver(m.composeMessage({ level: 'watch', changes: ['Fixture change'], headline: 'Fixture' }));
    assert.deepEqual(sent.map((s) => s.topic), ['fixture-private'], 'leftover public settings send nothing');
    assert.equal(sent[0].auth, undefined);
    process.env.NTFY_TOKEN = 'tk_private_fixture'; sent.length = 0;
    await m.deliver(m.composeMessage({ level: 'watch', changes: ['Fixture change'], headline: 'Fixture' }));
    assert.deepEqual(sent, [{ topic: 'fixture-private', auth: 'Bearer tk_private_fixture' }]);
  } finally { globalThis.fetch = mock; for (const k of ['NTFY_TOPIC', 'PUBLIC_NTFY_TOPIC', 'PUBLIC_NTFY_TOKEN', 'NTFY_TOKEN']) delete process.env[k]; }
});
