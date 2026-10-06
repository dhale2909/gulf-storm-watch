// Subscriber store for Daniel's Storm Page browser notifications (Cloudflare Worker + KV).
// The page registers a device here; the hourly check fetches the list and sends the pushes itself.
const ORIGIN = 'https://dhale2909.github.io';
const cors = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors } });
const MAX_BODY = 4096; // a push subscription is well under 1 KB

// Only real browser push services are accepted as endpoints, so this worker can never be pointed at an
// arbitrary server (its test push is a signed POST to whatever endpoint is registered).
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];
function validEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 1500) return false;
  let u; try { u = new URL(endpoint); } catch { return false; }
  return u.protocol === 'https:' && !u.username && !u.password && PUSH_HOSTS.some((re) => re.test(u.hostname));
}
const b64len = (s, n) => typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s) && (() => { try { return fromB64url(s).length === n; } catch { return false; } })();
async function readJSON(req) {
  const len = +(req.headers.get('content-length') || 0);
  if (len > MAX_BODY) return null;
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function keyFor(endpoint) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- "Send me a test": one push to the device that asks, so a new subscriber can see delivery work ----
// The push carries no payload (so no encryption is needed here); sw.js shows a fixed test message for it.
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (str) => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - str.length % 4) % 4)), (c) => c.charCodeAt(0));

async function vapidAuth(endpoint, env) {
  const pub = fromB64url(env.VAPID_PUBLIC_KEY); // 65-byte uncompressed point: 0x04 | x | y
  const jwk = { kty: 'EC', crv: 'P-256', x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), d: env.VAPID_PRIVATE_KEY };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.PAGE_URL })}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  return `vapid t=${unsigned}.${b64url(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

async function sendTest(endpoint, env) {
  // Bounded, and never follows a redirect away from the push service.
  const r = await fetch(endpoint, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { Authorization: await vapidAuth(endpoint, env), TTL: '60', Urgency: 'high', 'Content-Length': '0' } });
  return r.status;
}

// Serialise test requests per device inside this isolate: KV reads are eventually consistent, so two requests
// arriving together could both see "no recent test". Within one isolate they now run one after the other.
// (Across Cloudflare locations the five-minute spacing is best-effort; a device can only ever test itself.)
const inflight = new Map();
function serialised(key, fn) {
  const prev = inflight.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  inflight.set(key, run.finally(() => { if (inflight.get(key) === run) inflight.delete(key); }));
  return run;
}

// ---- usage counts: one number per event per day (no identity, no addresses). Visits are counted by Cloudflare ----
// Web Analytics on the page; these cover what that cannot see: alert sign-ups and taps.
const EVENTS = ['alerts-open', 'share', 'ntfy-tap', 'subscribe', 'unsubscribe', 'test'];
async function count(env, e) {
  if (!EVENTS.includes(e)) return;
  const k = `stat:${e}:${new Date().toISOString().slice(0, 10)}`;
  try { await env.SUBS.put(k, String((+(await env.SUBS.get(k)) || 0) + 1), { expirationTtl: 400 * 86400 }); } catch {} // best effort; a lost count is fine
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // The page reports a tap (sendBeacon, plain text body: the event name).
    if (req.method === 'POST' && url.pathname === '/hit') {
      const e = (await req.text()).slice(0, 32).trim();
      await count(env, e);
      return new Response(null, { status: 204, headers: cors });
    }

    // A registered device asks for its own test push; at most one every 5 minutes per device.
    if (req.method === 'POST' && url.pathname === '/test') {
      const body = await readJSON(req);
      if (!body || !validEndpoint(body.endpoint)) return json({ error: 'bad endpoint' }, 400);
      const key = await keyFor(body.endpoint);
      const reg = await env.SUBS.getWithMetadata(key);
      if (!reg || !reg.metadata) return json({ error: 'not registered' }, 404);
      if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return json({ error: 'test sending not configured' }, 503);
      return serialised(key, async () => {
        if (await env.SUBS.get(`test:${key}`)) return json({ error: 'try again in a few minutes' }, 429);
        await env.SUBS.put(`test:${key}`, '1', { expirationTtl: 300 });
        await count(env, 'test');
        try {
          const status = await sendTest(body.endpoint, env);
          return json({ ok: status >= 200 && status < 300, status }, status >= 200 && status < 300 ? 200 : 502);
        } catch (e) {
          return json({ ok: false, error: `push service not reached: ${e.name === 'TimeoutError' ? 'timed out' : 'send failed'}` }, 502);
        }
      });
    }

    // Devices (public, rate-limited by Cloudflare's free tier): register or remove themselves.
    if (req.method === 'POST' && (url.pathname === '/subscribe' || url.pathname === '/unsubscribe')) {
      const sub = await readJSON(req);
      if (!sub || !validEndpoint(sub.endpoint)) return json({ error: 'bad subscription' }, 400);
      const key = await keyFor(sub.endpoint);
      if (url.pathname === '/unsubscribe') { await env.SUBS.delete(key); await count(env, 'unsubscribe'); return json({ ok: true }); }
      // p256dh is a 65-byte P-256 public key, auth a 16-byte secret, both base64url.
      if (!sub.keys || !b64len(sub.keys.p256dh, 65) || !b64len(sub.keys.auth, 16)) return json({ error: 'bad keys' }, 400);
      // Keep the subscription in metadata so a single list() call returns everything.
      const existing = await env.SUBS.getWithMetadata(key);
      await env.SUBS.put(key, '1', { metadata: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, added: existing?.metadata?.added || Date.now() } });
      if (!existing?.metadata) await count(env, 'subscribe');
      return json({ ok: true }, 201);
    }

    // The tracker (holds ADMIN_KEY): list every subscription, or prune dead ones after sending.
    if (!env.ADMIN_KEY || req.headers.get('x-key') !== env.ADMIN_KEY) return json({ error: 'forbidden' }, 403);
    if (req.method === 'GET' && url.pathname === '/subscriptions') {
      const out = [];
      let cursor;
      do {
        const page = await env.SUBS.list({ cursor, prefix: '' });
        for (const k of page.keys) if (!k.name.startsWith('test:') && k.metadata?.endpoint) out.push(k.metadata);
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
      return json(out);
    }
    // Owner's usage report: registered devices (with the day each was added) and the event counts by day.
    if (req.method === 'GET' && url.pathname === '/stats') {
      const devices = [], counts = {};
      let cursor;
      do {
        const page = await env.SUBS.list({ cursor, prefix: '' });
        for (const k of page.keys) {
          if (k.metadata?.endpoint) devices.push({ added: new Date(k.metadata.added || 0).toISOString().slice(0, 10), service: new URL(k.metadata.endpoint).hostname });
          else if (k.name.startsWith('stat:')) { const [, e, day] = k.name.split(':'); (counts[day] ||= {})[e] = +(await env.SUBS.get(k.name)) || 0; }
        }
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
      return json({ devices: devices.length, byService: devices.reduce((m, d) => ({ ...m, [d.service]: (m[d.service] || 0) + 1 }), {}), addedByDay: devices.reduce((m, d) => ({ ...m, [d.added]: (m[d.added] || 0) + 1 }), {}), counts });
    }
    if (req.method === 'POST' && url.pathname === '/prune') {
      const body = await readJSON(req);
      const endpoints = Array.isArray(body?.endpoints) ? body.endpoints.filter((e) => typeof e === 'string').slice(0, 500) : [];
      for (const e of endpoints) await env.SUBS.delete(await keyFor(e));
      return json({ removed: endpoints.length });
    }
    return json({ error: 'not found' }, 404);
  },
};
