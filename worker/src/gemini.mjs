// Gemini (Google) with Google Search, on the key in the Worker secret GEMINI_API_KEY (Khaled set it, 24 Nov 2026).
// Used by both people's assistants: Khaled's (aik.mjs) and Mohamed's (ai.mjs). Cloudflare Workers AI stays the fallback.
// The key may be a Google AI Studio key (generativelanguage) or a Google Cloud express-mode key (Vertex AI,
// keys like «AQ.…»): the first endpoint that accepts it is remembered for the rest of this Worker's life.
// 24 Nov 2026: Google says gemini-3.8-flash is current; the lite model has the most generous free quota
export const GEMINI = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-3.8-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.7-flash'];

const ENDS = [
  { name: 'studio', url: m => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, search: { google_search: {} } },
  { name: 'vertex', url: m => `https://aiplatform.googleapis.com/v1/publishers/google/models/${m}:generateContent`, search: { googleSearch: {} } },
];
let good = null, okModel = null;   // the endpoint that accepted the key, and the model that answered
export const models = () => okModel ? [okModel].concat(GEMINI.filter(m => m !== okModel)) : GEMINI;
const authErr = (status, msg) => status === 401 || status === 403 || /api key|unauthenticated|permission|credential/i.test(msg || '');

export async function gemini(env, model, sys, msgs, opt = {}) {
  let last = '';
  for (const e of good ? [good] : ENDS) {
    const body = { systemInstruction: { parts: [{ text: sys }] },
      contents: msgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      ...(opt.bare ? {} : { tools: [e.search] }), generationConfig: { temperature: 0.4, maxOutputTokens: 8192 } };
    const r = await fetch(e.url(model), { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    const msg = (j.error && j.error.message) || '';
    if (!r.ok && (r.status === 429 || (r.status === 400 && /search|tool|grounding/i.test(msg))) && !opt.bare) return gemini(env, model, sys, msgs, { bare: 1 });   // search not allowed on this key: answer without it
    if (!r.ok) { last = `${model} ${e.name} ${r.status} ${msg.slice(0, 700)}`; if (!good && authErr(r.status, msg)) continue; throw new Error(last); }
    good = e; okModel = model;
    const c = (j.candidates || [])[0] || {};
    const text = ((c.content && c.content.parts) || []).filter(p => p.text && !p.thought).map(p => p.text).join('');
    const g = c.groundingMetadata || {};
    const sources = (g.groundingChunks || []).map(x => x.web).filter(Boolean).slice(0, 6).map(w => ({ title: String(w.title || '').slice(0, 120), url: w.uri }));
    return { text, sources, queries: (g.webSearchQueries || []).slice(0, 4) };
  }
  throw new Error(last || model + ' no endpoint');
}
