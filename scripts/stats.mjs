#!/usr/bin/env node
// Usage report for Daniel's Storm Page: registered browser-notification devices and daily taps. Run: npm run stats
import { readFile } from 'node:fs/promises';
const env = Object.fromEntries((await readFile('.env', 'utf8')).split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split(/=(.*)/s).slice(0, 2).map((x) => x.trim().replace(/^"|"$/g, ''))));
const r = await fetch(`${env.PUSH_API}/stats`, { headers: { 'x-key': env.PUSH_ADMIN_KEY } });
if (!r.ok) { console.error(`stats -> HTTP ${r.status}`); process.exit(1); }
const s = await r.json();
console.log(`Browser notification devices registered: ${s.devices}  ${Object.entries(s.byService).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
console.log('Devices added by day:', Object.entries(s.addedByDay).sort().map(([d, n]) => `${d} +${n}`).join('  ') || 'none');
const events = ['alerts-open', 'subscribe', 'unsubscribe', 'test', 'ntfy-tap', 'share'];
console.log('\nday         ' + events.map((e) => e.padStart(12)).join(''));
for (const day of Object.keys(s.counts).sort()) console.log(day.padEnd(12) + events.map((e) => String(s.counts[day][e] || 0).padStart(12)).join(''));
if (!Object.keys(s.counts).length) console.log('(no taps counted yet)');
console.log('\nSite visits: Cloudflare dashboard -> Analytics & Logs -> Web Analytics (once the site is added there).');
