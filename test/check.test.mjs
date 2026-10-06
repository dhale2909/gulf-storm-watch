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
  for (const id of [6, 7, 8, 9, 12]) responses[`${MAPSRV}/${id}/query?where=1%3D1&outFields=*&f=geojson&geometryPrecision=2`] = { features: [] };
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
// gap(): still open, by owner decision (coastline geometry is a proposal; see STORM-REVIEW-2.md R7/R8). fixed(): a regression test now.
const gap = (id, name, fn) => test(`${id}: ${name}`, { todo: 'Open: coastline geometry proposal (STORM-REVIEW-2.md R7/R8) awaiting owner decision' }, fn);
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
  const p = state({ gulf: { area: 'Gulf of Mexico', formation7d: 50, formation48: 50 }, internal: { baseline7d: 50, baseline48: 50, pending: { privateTitle: 'Fixture', privateBody: 'Fixture', publicTitle: 'Fixture', publicBody: 'Fixture', level: 'watch', failed: ['private'], attempts: 1 } } });
  try { await runMain(p); assert.equal(sent, 0); }
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

gap('R7', 'an offshore position south of the configured coastline is not observed landfall', async () => {
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

gap('R8', 'oblique crossing solves the path against coastline segments, not the endpoint latitude', async () => {
  responses[FEED] = { activeStorms: [storm({ latitudeNumeric: 28, longitudeNumeric: -92, lastUpdate: '2026-10-08T12:00:00Z' })] };
  responses['https://fixture.invalid/tcm'] = '<pre>FORECAST VALID 09/1200Z 31.0N 84.0W</pre>';
  // At the intersection: lonW=92-8f, lat=28+3f. COAST_N segment
  // (86.5,30.35)->(85.7,30.1) has lat=30.35 + .3125*(lonW-86.5).
  const f = 4.06875 / 5.5;
  const expected = Date.parse('2026-10-08T12:00:00Z') + f * 86400000;
  const got = Date.parse((await m.gatherStorms(state()))[0].landfall.eta);
  assert.ok(Math.abs(got - expected) < 1000, `crossing differs by ${Math.round((got - expected) / 60000)} min`);
});

gap('R8', 'nearest-town state and announced landfall state agree at the Louisiana delta', async () => {
  responses[FEED] = { activeStorms: [storm({ latitudeNumeric: 28, longitudeNumeric: -89.35 })] };
  responses['https://fixture.invalid/tcm'] = '<pre>FORECAST VALID 09/1200Z 29.5N 89.3W</pre>';
  const lf = (await m.gatherStorms(state()))[0].landfall;
  assert.equal(lf.state, lf.near.split(', ')[1]);
});

fixed('R9', 'text-advisory fallback survives a failing map layer, not only an empty layer', async () => {
  const MAP = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';
  for (const id of [6,7,8,9,12]) responses[`${MAP}/${id}/query?where=1%3D1&outFields=*&f=geojson&geometryPrecision=2`] = { features: [] };
  responses[`${MAP}/8/query?where=1%3D1&outFields=*&f=geojson&geometryPrecision=2`] = new Error('fixture cone unavailable');
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
const PUSH_KEYS = { p256dh: Buffer.from([4, ...Array(64).fill(7)]).toString('base64url'), auth: Buffer.alloc(16, 9).toString('base64url') };

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
