// DeepSeek (his keys, 26 Nov 2026): Worker secrets DEEPSEEK_API_KEY and DEEPSEEK_API_KEY_2 … _6, tried in turn.
// Text only (it does not read images): it thinks with the page text in «مساعد القراءة» and backs up both assistants
// after Gemini. A key that is refused (401), out of balance (402) or busy (429) is set aside and the next one is used.
// DeepSeek is paid by use: keys of one account share one balance.
const URL_ = 'https://api.deepseek.com/chat/completions';
export const dsKeys = env => [...new Set(['', '_2', '_3', '_4', '_5', '_6'].map(s => env['DEEPSEEK_API_KEY' + s]).filter(Boolean))];
const restUntil = new Map();
const awake = k => !(restUntil.get(k) > Date.now());

export async function deepseek(env, sys, msgs, opt = {}) {
  const all = dsKeys(env);
  if (!all.length) throw new Error('deepseek no key');
  const keys = all.filter(awake).concat(all.filter(k => !awake(k)));
  const model = env.DEEPSEEK_MODEL || 'deepseek-chat';
  let last = '';
  for (const key of keys) {
    const body = { model, messages: [{ role: 'system', content: sys }].concat(msgs.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }))),
      temperature: 0.4, max_tokens: opt.max || 3000, ...(opt.json ? { response_format: { type: 'json_object' } } : {}) };
    let r, j;
    try { r = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify(body) }); j = await r.json().catch(() => ({})); }
    catch (e) { last = 'deepseek network ' + String(e.message || e).slice(0, 120); continue; }
    if (r.ok) { restUntil.delete(key); const c = (j.choices || [])[0] || {}; return { text: (c.message && c.message.content) || '', model: 'deepseek:' + model }; }
    const msg = (j.error && j.error.message) || '';
    last = `deepseek ${r.status} ${msg.slice(0, 200)}`;
    if (r.status === 401 || r.status === 402) restUntil.set(key, Date.now() + 60 * 60e3);   // refused or no balance: an hour
    else if (r.status === 429 || r.status >= 500) restUntil.set(key, Date.now() + 2 * 60e3);
    else throw new Error(last);                                                             // a bad request: not the key
  }
  throw new Error(last || 'deepseek failed');
}
