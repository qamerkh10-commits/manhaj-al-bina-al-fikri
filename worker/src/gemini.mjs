// Gemini (Google) with Google Search, on the key in the Worker secret GEMINI_API_KEY (Khaled set it, 24 Nov 2026),
// or on a job's own key (GEMINI_KEY_KHALED / _MOHAMED / _SEARCH / _VOICE) when he sets one: see keysFor below.
// Used by both people's assistants: Khaled's (aik.mjs) and Mohamed's (ai.mjs). Cloudflare Workers AI stays the fallback.
// The key may be a Google AI Studio key (generativelanguage) or a Google Cloud express-mode key (Vertex AI,
// keys like «AQ.…»): the first endpoint that accepts it is remembered for the rest of this Worker's life.
// 24 Nov 2026: Google says gemini-3.8-flash is current; the lite model has the most generous free quota
export const GEMINI = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-3.8-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.7-flash'];

const ENDS = [
  { name: 'studio', url: m => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, search: { google_search: {} } },
  { name: 'vertex', url: m => `https://aiplatform.googleapis.com/v1/publishers/google/models/${m}:generateContent`, search: { googleSearch: {} } },
];
const goodBy = new Map(); let okModel = null;   // the endpoint that accepted each key, and the model that answered
export const models = () => okModel ? [okModel].concat(GEMINI.filter(m => m !== okModel)) : GEMINI;
const authErr = (status, msg) => status === 401 || status === 403 || /api key|unauthenticated|permission|credential/i.test(msg || '');

// A key for each job (Khaled, 26 Nov 2026: «أكتر من api key… كل واحد يعمل حاجة»). Each job uses its own secret first,
// then the general GEMINI_API_KEY, so a job whose own key is missing, used up (429) or refused still answers.
// Keys made in different Google Cloud projects have separate free quotas; keys in one project share it.
// Each job may have backups (his request: «لكل واحد بديل… لما واحد يخلص التاني ياخد مكانه»): NAME, NAME_2 … NAME_5.
// Order: the job's own keys, then the general keys (GEMINI_API_KEY, _2 … _5), then the other jobs' keys as a last resort.
const KEY_OF = { khaled: 'GEMINI_KEY_KHALED', mohamed: 'GEMINI_KEY_MOHAMED', search: 'GEMINI_KEY_SEARCH', voice: 'GEMINI_KEY_VOICE' };
const many = (env, base) => [env[base], env[base + '_2'], env[base + '_3'], env[base + '_4'], env[base + '_5']];
export const keysFor = (env, job) => {
  const own = KEY_OF[job] ? many(env, KEY_OF[job]) : [], gen = many(env, 'GEMINI_API_KEY');
  const others = Object.values(KEY_OF).filter(b => b !== KEY_OF[job]).flatMap(b => many(env, b));
  return [...new Set([...own, ...gen, ...others].filter(Boolean))];
};
// a key that ran out (429) is set aside for 10 minutes, so a question does not wait on it; a refused key for an hour
const restUntil = new Map();
const rest = (key, ms) => restUntil.set(key, Date.now() + ms);
const awake = key => !(restUntil.get(key) > Date.now());

export async function gemini(env, model, sys, msgs, opt = {}) {
  const all = opt.keys && opt.keys.length ? opt.keys : [env.GEMINI_API_KEY].filter(Boolean);
  const keys = all.filter(awake).concat(all.filter(k => !awake(k)));   // resting keys only if every key is resting
  let err = null;
  for (const key of keys) {
    try { const r = await geminiKey(key, model, sys, msgs, opt); restUntil.delete(key); return r }
    catch (e) {
      err = e; const m = / (429|401|403) /.exec(' ' + e.message + ' ');
      if (!m) throw e;                                   // not about the key (a bad request, a model that is gone)
      rest(key, m[1] === '429' ? 10 * 60e3 : 60 * 60e3);  // used up or refused: the next key takes its place
    }
  }
  throw err || new Error(model + ' no key');
}

async function geminiKey(key, model, sys, msgs, opt) {
  let last = '';const good = goodBy.get(key);
  for (const e of good ? [good] : ENDS) {
    const body = { systemInstruction: { parts: [{ text: sys }] },
      contents: msgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      ...(opt.bare ? {} : { tools: [e.search] }), generationConfig: { temperature: 0.4, maxOutputTokens: 8192 } };
    const r = await fetch(e.url(model), { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    const msg = (j.error && j.error.message) || '';
    if (!r.ok && (r.status === 429 || (r.status === 400 && /search|tool|grounding/i.test(msg))) && !opt.bare) return geminiKey(key, model, sys, msgs, { ...opt, bare: 1 });   // search not allowed on this key: answer without it
    if (!r.ok) { last = `${model} ${e.name} ${r.status} ${msg.slice(0, 700)}`; if (!good && authErr(r.status, msg)) continue; throw new Error(last); }
    goodBy.set(key, e); okModel = model;
    const c = (j.candidates || [])[0] || {};
    const text = ((c.content && c.content.parts) || []).filter(p => p.text && !p.thought).map(p => p.text).join('');
    const g = c.groundingMetadata || {};
    const sources = (g.groundingChunks || []).map(x => x.web).filter(Boolean).slice(0, 6).map(w => ({ title: String(w.title || '').slice(0, 120), url: w.uri }));
    return { text, sources, queries: (g.webSearchQueries || []).slice(0, 4) };
  }
  throw new Error(last || model + ' no endpoint');
}
