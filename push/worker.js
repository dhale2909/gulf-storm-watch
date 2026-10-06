// Subscriber store for Daniel's Storm Page browser notifications (Cloudflare Worker + KV).
// The page registers a device here; the hourly check fetches the list and sends the pushes itself.
const ORIGIN = 'https://dhale2909.github.io';
const cors = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors } });

async function keyFor(endpoint) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

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
        const page = await env.SUBS.list({ cursor });
        for (const k of page.keys) if (k.metadata?.endpoint) out.push(k.metadata);
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
