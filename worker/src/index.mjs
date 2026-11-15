// Cloudflare Worker for the follow-up bot: Telegram webhook (instant replies), a 5-minute clock for
// reminders, and one Durable Object that owns the state. One bot serves several people: each person
// (profile) has his own page on the site, his own state here, and his own index in the shared channel.
// The schedule itself is computed on GitHub (bot/sync.mjs) from each person's page and pushed here.
//
// The bot token reaches this Worker from the GitHub sync job (the repo secret TELEGRAM_TOKEN), so it
// is set in one place only. A token is accepted only if Telegram confirms it belongs to BOT_ID.
import { DurableObject } from 'cloudflare:workers';
import { makeBot } from '../../bot/core.mjs';

// keep in step with the site (bot/profiles in sync.mjs and the pages under /khaled and /mohamed)
const PROFILES = {
  khaled: { key: 'khaled', name: 'خالد', ns: '', admin: true },
  mohamed: { key: 'mohamed', name: 'محمد', ns: 'm', admin: false },
};

async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return [...new Uint8Array(s)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const syncKey = token => hmacHex(token, 'manhaj-sync-v1');
const hookKey = async token => (await hmacHex(token, 'manhaj-webhook-v1')).slice(0, 48);
const CHUNK = 100000;

export class BotState extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.P = null; this.tok = null; this.queue = Promise.resolve(); }

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
  marks(S) {
    const { sched, books, ...rest } = S;
    return { state: JSON.stringify(rest), sched: (S.schedKey || '') + ':' + Object.keys(sched || {}).length + ':' + (S.legacyAt || ''), books: books ? books.length + ':' + (S.schedKey || '') : '' };
  }
  async load() {
    if (this.P) return;
    // one-time move from the single-person layout: that state becomes Khaled's
    if (!(await this.ctx.storage.get('p:khaled:state:n')) && (await this.ctx.storage.get('state:n'))) {
      const st = (await this.getBig('state')) || {};
      await this.putBig('p:khaled:state', st);
      const sc = await this.getBig('sched'); if (sc) await this.putBig('p:khaled:sched', sc);
      const bk = await this.getBig('books'); if (bk) await this.putBig('p:khaled:books', bk);
      await this.ctx.storage.put({ shared: { channel: st.channel || null }, chats: st.owner ? { [st.owner]: 'khaled' } : {} });
    }
    this.shared = (await this.ctx.storage.get('shared')) || { channel: null };
    this.chats = (await this.ctx.storage.get('chats')) || {};
    this.P = {};
    for (const k of Object.keys(PROFILES)) {
      const st = (await this.getBig(`p:${k}:state`)) || {};
      st.sched = (await this.getBig(`p:${k}:sched`)) || {};
      st.books = await this.getBig(`p:${k}:books`);
      this.P[k] = { S: st, saved: this.marks(st) };
    }
    this.savedMeta = JSON.stringify([this.shared, this.chats]);
  }
  async save() {
    for (const [k, p] of Object.entries(this.P)) {
      const m = this.marks(p.S), { sched, books, ...rest } = p.S;
      if (m.state !== p.saved.state) await this.putBig(`p:${k}:state`, rest);
      if (m.sched !== p.saved.sched) await this.putBig(`p:${k}:sched`, sched);
      if (m.books !== p.saved.books && books) await this.putBig(`p:${k}:books`, books);
      p.saved = m;
    }
    const meta = JSON.stringify([this.shared, this.chats]);
    if (meta !== this.savedMeta) { await this.ctx.storage.put({ shared: this.shared, chats: this.chats }); this.savedMeta = meta; }
  }
  // run one person's bot over his state, with the shared channel injected and read back
  async run(pk, token, fn) {
    const P = this.P[pk], before = this.shared.channel && this.shared.channel.id;
    P.S.channel = this.shared.channel;
    const bot = makeBot({ state: P.S, token, apiBase: this.env.TG_API, now: new Date(), profile: PROFILES[pk] });
    let out;
    try { out = await fn(bot); } catch (e) { console.error(pk, e && e.stack || e); out = { ok: false, error: String(e) }; }
    P.S = bot.state();
    this.shared.channel = P.S.channel || null;
    const after = this.shared.channel && this.shared.channel.id;
    if (after && after !== before) for (const [k, o] of Object.entries(this.P)) if (k !== pk) { o.S.sums = {}; o.S.indexMsgs = []; } // a new channel: the others rebuild their index there
    return out;
  }
  lock(fn) { const p = this.queue.then(fn, fn); this.queue = p.catch(() => {}); return p; } // one event at a time

  async tg(token, method, body) {
    return fetch(`${this.env.TG_API}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()).catch(() => ({}));
  }

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
    if (path === '/botname') { // public: the page's "link the bot" button needs the bot's username
      if (!this.uname) { const me = await fetch(`${this.env.TG_API}/bot${token}/getMe`).then(r => r.json()).catch(() => ({})); this.uname = me.ok ? me.result.username : ''; }
      return Response.json({ username: this.uname }, { headers: { 'access-control-allow-origin': '*' } });
    }
    if (path === '/tg') {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== await hookKey(token)) return new Response('forbidden', { status: 403 });
    } else if (path.startsWith('/sync/')) {
      if (req.headers.get('X-Sync-Key') !== await syncKey(token)) return new Response('forbidden', { status: 403 });
      if (path === '/sync/setup') { // point Telegram's webhook at this Worker
        const r = await this.tg(token, 'setWebhook', { url: `${req.headers.get('X-Origin')}/tg`, secret_token: await hookKey(token), allowed_updates: ['message', 'callback_query', 'my_chat_member'] });
        return Response.json(r);
      }
    } else if (path !== '/tick') return new Response('not found', { status: 404 });

    return this.lock(async () => {
      await this.load();
      let out = { ok: true };
      if (path === '/tg') {
        await this.onUpdate(token, body || {});
        await this.save();
        return new Response('ok'); // always 200 to Telegram, so it does not resend
      }
      if (path === '/tick') {
        for (const pk of Object.keys(PROFILES)) if (this.P[pk].S.owner) await this.run(pk, token, bot => bot.tick());
        await this.save();
        return Response.json(out);
      }
      const pk = PROFILES[url.searchParams.get('p')] ? url.searchParams.get('p') : 'khaled';
      const P = this.P[pk];
      if (path === '/sync/data') out = (await this.run(pk, token, bot => bot.applyData(body))) || { ok: true };
      else if (path === '/sync/info') {
        const S = P.S, ks = Object.keys(S.sched || {}).sort();
        out = { key: S.schedKey || '', cover: ks[ks.length - 1] || '', settings: S.settings || {}, settingsVer: S.settingsVer || 0, hasOwner: !!S.owner };
      } else if (path === '/sync/legacy') {
        // one-time move of the state kept on GitHub before Cloudflare (Khaled's)
        if (pk === 'khaled' && !P.S.owner && body && body.state && body.state.owner) {
          const L = body.state; L.lastUpdate = Math.max(0, (L.offset || 1) - 1); delete L.offset; L.legacyAt = Date.now();
          P.S = L; this.chats[L.owner] = 'khaled'; if (L.channel && !this.shared.channel) this.shared.channel = L.channel;
          out = { ok: true, moved: true };
        } else out = { ok: true, moved: false };
      } else out = { ok: false, error: 'unknown path' };
      await this.save();
      return Response.json(out);
    });
  }

  // route a Telegram update to the person it belongs to
  async onUpdate(token, u) {
    const mc = u.my_chat_member, m = u.message, q = u.callback_query;
    if (mc) { const pk = this.chats[mc.from && mc.from.id]; if (pk) await this.run(pk, token, bot => bot.handleUpdate(u)); return; }
    const chat = m ? m.chat.id : q && q.message ? q.message.chat.id : null;
    if (!chat) return;
    let pk = this.chats[chat];
    const st = m && /^\/start(?:@\w+)?\s+(\w+)/.exec(m.text || '');
    if (st && PROFILES[st[1]]) {   // "link the bot" button on a person's page: /start <person>
      const want = st[1], W = this.P[want].S;
      if (pk && pk !== want) { await this.tg(token, 'sendMessage', { chat_id: chat, text: `حسابك مربوط بصفحة ${PROFILES[pk].name}، فلا يمكن ربطه بصفحة ${PROFILES[want].name} أيضًا.` }); return; }
      if (W.owner && W.owner !== chat) { await this.tg(token, 'sendMessage', { chat_id: chat, text: `صفحة ${PROFILES[want].name} مربوطة بحساب آخر.` }); return; }
      this.chats[chat] = want; W.owner = chat; pk = want;
    }
    if (!pk) {
      if (m && m.chat.type === 'private') await this.tg(token, 'sendMessage', { chat_id: chat, text: 'افتح صفحتك في موقع «منهج البناء الفكري» واضغط «🤖 اربط البوت بصفحتك».' });
      return;
    }
    await this.run(pk, token, bot => bot.handleUpdate(u));
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/tg' || url.pathname === '/botname' || url.pathname.startsWith('/sync/')) {
      const stub = env.BOT.get(env.BOT.idFromName('main'));
      const h = new Headers(req.headers); h.set('X-Origin', url.origin);
      return stub.fetch('https://bot' + url.pathname + url.search, { method: req.method, headers: h, body: req.method === 'POST' ? await req.text() : undefined });
    }
    return new Response('منهج البناء الفكري: البوت يعمل ✓', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
  async scheduled(event, env, ctx) {
    const stub = env.BOT.get(env.BOT.idFromName('main'));
    ctx.waitUntil(stub.fetch('https://bot/tick', { method: 'POST' }));
  },
};
