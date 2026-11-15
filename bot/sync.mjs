// GitHub side of the bot (runs hourly in Actions): computes the schedule from the app (index.html)
// with the settings stored in the bot, sends it to the Cloudflare Worker, and keeps the webhook set.
// On its first run it also moves the state the bot kept on GitHub before Cloudflare.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSchedule } from './schedule.mjs';
import { clock, addDays } from './core.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.TELEGRAM_TOKEN, WORKER = (process.env.WORKER_URL || '').replace(/\/$/, '');
if (!TOKEN || !WORKER) { console.error('TELEGRAM_TOKEN (secret) and WORKER_URL (variable) are required'); process.exit(1); }
// one page per person on the site; each person's schedule is computed from his own page and settings
const PEOPLE = [{ key: 'khaled', file: 'khaled/index.html' }, { key: 'mohamed', file: 'mohamed/index.html' }];
const ROOT = process.env.SITE_DIR || path.join(DIR, '..');
const LEGACY = process.env.LEGACY_FILE || path.join(DIR, '..', 'state.enc');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const KEY = crypto.createHmac('sha256', TOKEN).update('manhaj-sync-v1').digest('hex');

async function call(p, body) {
  const r = await fetch(WORKER + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Sync-Key': KEY, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${p} → ${r.status} ${t.slice(0, 200)}`);
  return JSON.parse(t);
}
function legacyState() {
  try {
    const b = Buffer.from(fs.readFileSync(LEGACY, 'utf8'), 'base64');
    const k = crypto.createHash('sha256').update('manhaj-bot-state:' + TOKEN).digest();
    const dc = crypto.createDecipheriv('aes-256-gcm', k, b.subarray(0, 12)); dc.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([dc.update(b.subarray(28)), dc.final()]).toString('utf8'));
  } catch (e) { return null; }
}

const today = clock(new Date()).date;
// hand the bot its token (kept only as a GitHub secret); the Worker checks it with Telegram before storing it
{
  const r = await fetch(WORKER + '/sync/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
  if (!r.ok) throw new Error('/sync/token → ' + r.status + ' ' + (await r.text()).slice(0, 100));
  console.log('token:', (await r.json()).changed ? 'stored' : 'already set');
}
for (const P of PEOPLE) {
  const INDEX = path.join(ROOT, P.file), q = '?p=' + P.key;
  let info = await call('/sync/info' + q);
  if (P.key === 'khaled' && !info.hasOwner) {
    const L = legacyState();
    if (L && L.owner) { const r = await call('/sync/legacy' + q, { state: L }); console.log('old GitHub state moved:', r.moved); info = await call('/sync/info' + q); }
  }
  const key = sha('v4' + sha(fs.readFileSync(INDEX, 'utf8')) + info.settingsVer + JSON.stringify(info.settings || {}));
  if (process.argv.includes('--force') || key !== info.key || !info.cover || info.cover < addDays(today, 30)) {
    const r = await buildSchedule(INDEX, info.settings || {}, addDays(today, -2), addDays(today, 90));
    const res = await call('/sync/data' + q, { ...r, key, settingsVer: info.settingsVer });
    console.log(P.key + ': schedule sent:', res.ok !== false, res.error || '');
  } else console.log(P.key + ': schedule up to date');
}
const w = await call('/sync/setup', {});
console.log('webhook:', w.ok, w.description || '');
