// Subscriber store for Daniel's Storm Page browser notifications (Cloudflare Worker + KV).
// The page registers a device here; the hourly check fetches the list and sends the pushes itself.
const ORIGIN = 'https://dhale2909.github.io';
const cors = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors } });

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
  const r = await fetch(endpoint, { method: 'POST', headers: { Authorization: await vapidAuth(endpoint, env), TTL: '60', Urgency: 'high', 'Content-Length': '0' } });
  return r.status;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // A registered device asks for its own test push; at most one every 5 minutes per device.
    if (req.method === 'POST' && url.pathname === '/test') {
      let body;
      try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!body || typeof body.endpoint !== 'string' || !body.endpoint.startsWith('https://')) return json({ error: 'bad endpoint' }, 400);
      const key = await keyFor(body.endpoint);
      const reg = await env.SUBS.getWithMetadata(key);
      if (!reg || !reg.metadata) return json({ error: 'not registered' }, 404);
      if (await env.SUBS.get(`test:${key}`)) return json({ error: 'try again in a few minutes' }, 429);
      await env.SUBS.put(`test:${key}`, '1', { expirationTtl: 300 });
      if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return json({ error: 'test sending not configured' }, 503);
      const status = await sendTest(body.endpoint, env);
      return json({ ok: status >= 200 && status < 300, status }, status >= 200 && status < 300 ? 200 : 502);
    }

    // Devices (public, rate-limited by Cloudflare's free tier): register or remove themselves.
    if (req.method === 'POST' && (url.pathname === '/subscribe' || url.pathname === '/unsubscribe')) {
      let sub;
      try { sub = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://') || sub.endpoint.length > 1500) return json({ error: 'bad subscription' }, 400);
      const key = await keyFor(sub.endpoint);
      if (url.pathname === '/unsubscribe') { await env.SUBS.delete(key); return json({ ok: true }); }
      if (!sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') return json({ error: 'bad keys' }, 400);
      // Keep the subscription in metadata so a single list() call returns everything.
      await env.SUBS.put(key, '1', { metadata: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, added: Date.now() } });
      return json({ ok: true }, 201);
    }

    // The tracker (holds ADMIN_KEY): list every subscription, or prune dead ones after sending.
    if (req.headers.get('x-key') !== env.ADMIN_KEY) return json({ error: 'forbidden' }, 403);
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
    if (req.method === 'POST' && url.pathname === '/prune') {
      const { endpoints = [] } = await req.json();
      for (const e of endpoints) await env.SUBS.delete(await keyFor(e));
      return json({ removed: endpoints.length });
    }
    return json({ error: 'not found' }, 404);
  },
};
