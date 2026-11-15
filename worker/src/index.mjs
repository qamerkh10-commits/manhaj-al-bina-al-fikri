// Cloudflare Worker for the follow-up bot: Telegram webhook (instant replies), a 5-minute clock for
// reminders, and one Durable Object that owns the state. The schedule itself is computed on GitHub
// (bot/sync.mjs) from the app and pushed here through the /sync endpoints.
//
// The bot token reaches this Worker from the GitHub sync job (the repo secret TELEGRAM_TOKEN), so it
// is set in one place only. A token is accepted only if Telegram confirms it belongs to BOT_ID.
import { DurableObject } from 'cloudflare:workers';
import { makeBot } from '../../bot/core.mjs';

async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return [...new Uint8Array(s)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const syncKey = token => hmacHex(token, 'manhaj-sync-v1');
const hookKey = async token => (await hmacHex(token, 'manhaj-webhook-v1')).slice(0, 48);
const CHUNK = 100000;

export class BotState extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.mem = null; this.tok = null; this.queue = Promise.resolve(); }

  async token() { return this.env.TELEGRAM_TOKEN || this.tok || (this.tok = await this.ctx.storage.get('token')) || null; }
  async getBig(name) {
    const n = await this.ctx.storage.get(name + ':n');
    if (!n) return null;
    const keys = Array.from({ length: n }, (_, i) => `${name}:${i}`);
    const m = await this.ctx.storage.get(keys);
    return JSON.parse(keys.map(k => m.get(k)).join(''));
  }
  async putBig(name, value) { // values are split, so no single stored value gets near the size limit
    const s = JSON.stringify(value), parts = {};
    const n = Math.max(1, Math.ceil(s.length / CHUNK));
    for (let i = 0; i < n; i++) parts[`${name}:${i}`] = s.slice(i * CHUNK, (i + 1) * CHUNK);
    parts[name + ':n'] = n;
    await this.ctx.storage.put(parts);
  }
  async load() {
    if (this.mem) return this.mem;
    const st = (await this.getBig('state')) || {};
    st.sched = (await this.getBig('sched')) || {};
    st.books = await this.getBig('books');
    this.mem = st;
    this.saved = this.marks(st);
    return st;
  }
  marks(S) {
    const { sched, books, ...rest } = S;
    return { state: JSON.stringify(rest), sched: (S.schedKey || '') + ':' + Object.keys(sched || {}).length + ':' + (S.legacyAt || ''), books: books ? books.length + ':' + (S.schedKey || '') : '' };
  }
  async save(S) {
    const m = this.marks(S), { sched, books, ...rest } = S;
    if (m.state !== this.saved.state) await this.putBig('state', rest);
    if (m.sched !== this.saved.sched) await this.putBig('sched', sched);
    if (m.books !== this.saved.books && books) await this.putBig('books', books);
    this.saved = m;
  }
  lock(fn) { const p = this.queue.then(fn, fn); this.queue = p.catch(() => {}); return p; } // one event at a time

  async fetch(req) {
    const url = new URL(req.url), path = url.pathname;
    const raw = req.method === 'POST' ? await req.text() : '';
    let body = null; try { body = raw ? JSON.parse(raw) : null; } catch (e) {}

    // receive the token from the GitHub sync job; Telegram must confirm it is this bot's token
    if (path === '/sync/token') {
      const t = body && body.token;
      if (!t || String(t).split(':')[0] !== String(this.env.BOT_ID)) return new Response('forbidden', { status: 403 });
      if (t === await this.token()) return Response.json({ ok: true, changed: false });
      const me = await fetch(`${this.env.TG_API}/bot${t}/getMe`).then(r => r.json()).catch(() => ({}));
      if (!me.ok || String(me.result.id) !== String(this.env.BOT_ID)) return new Response('forbidden', { status: 403 });
      await this.ctx.storage.put('token', t); this.tok = t;
      return Response.json({ ok: true, changed: true });
    }
    const token = await this.token();
    if (!token) return new Response('no token yet', { status: 503 });
    if (path === '/tg') {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== await hookKey(token)) return new Response('forbidden', { status: 403 });
    } else if (path.startsWith('/sync/')) {
      if (req.headers.get('X-Sync-Key') !== await syncKey(token)) return new Response('forbidden', { status: 403 });
      if (path === '/sync/setup') { // point Telegram's webhook at this Worker
        const r = await fetch(`${this.env.TG_API}/bot${token}/setWebhook`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: `${req.headers.get('X-Origin')}/tg`, secret_token: await hookKey(token), allowed_updates: ['message', 'callback_query', 'my_chat_member'] }),
        });
        return Response.json(await r.json());
      }
    } else if (path !== '/tick') return new Response('not found', { status: 404 });

    return this.lock(async () => {
      let S = await this.load(), out = { ok: true };
      const bot = makeBot({ state: S, token, apiBase: this.env.TG_API, now: new Date() });
      try {
        if (path === '/tg') await bot.handleUpdate(body || {});
        else if (path === '/tick') await bot.tick();
        else if (path === '/sync/data') await bot.applyData(body);
        else if (path === '/sync/info') {
          const ks = Object.keys(S.sched || {}).sort();
          out = { key: S.schedKey || '', cover: ks[ks.length - 1] || '', settings: S.settings || {}, settingsVer: S.settingsVer || 0, hasOwner: !!S.owner };
        } else if (path === '/sync/legacy') {
          // one-time move of the state kept on GitHub before Cloudflare
          if (!S.owner && body && body.state && body.state.owner) {
            const L = body.state; L.lastUpdate = Math.max(0, (L.offset || 1) - 1); delete L.offset; L.legacyAt = Date.now();
            this.mem = L; out = { ok: true, moved: true };
          } else out = { ok: true, moved: false };
        } else out = { ok: false, error: 'unknown path' };
      } catch (e) { console.error(path, e && e.stack || e); out = { ok: false, error: String(e) }; }
      if (path !== '/sync/legacy' || !out.moved) this.mem = bot.state();
      await this.save(this.mem);
      return path === '/tg' ? new Response('ok') : Response.json(out); // always 200 to Telegram, so it does not resend
    });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/tg' || url.pathname.startsWith('/sync/')) {
      const stub = env.BOT.get(env.BOT.idFromName('main'));
      const h = new Headers(req.headers); h.set('X-Origin', url.origin);
      return stub.fetch('https://bot' + url.pathname, { method: req.method, headers: h, body: req.method === 'POST' ? await req.text() : undefined });
    }
    return new Response('منهج البناء الفكري: البوت يعمل ✓', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
  async scheduled(event, env, ctx) {
    const stub = env.BOT.get(env.BOT.idFromName('main'));
    ctx.waitUntil(stub.fetch('https://bot/tick', { method: 'POST' }));
  },
};
