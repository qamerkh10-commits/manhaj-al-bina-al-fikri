// The site's assistant: one question from a person's page → Cloudflare Workers AI (free daily allowance).
// It answers in Arabic and may propose actions; the page shows them and runs them only when the person confirms.
import { models, gemini } from './gemini.mjs';
// glm-5.3-flash was withdrawn from Workers AI (found 24 Nov 2026); Gemini answers first when its key is set
export const AI_MODELS = ['@cf/zai-org/glm-5.3', '@cf/google/gemma-4-26b-a4b-it'];
export const AI_DAILY = 80;   // questions per person per day, so the free allowance is never used up

const SYSTEM = name => `أنت «مساعد الخطة» في موقع «منهج البناء الفكري»، وتكلّم ${name || 'صاحب الصفحة'} وحده عن خطته في القراءة والسماع.
مهمتك:
١) تجيب عن أسئلته عن خطته من «حالة الصفحة» المرفقة فقط: ورد يوم معيّن، متى يبدأ كتاب أو ينتهي، ما الكتاب التالي، ما الذي في المكتبة… ولا تخترع كتابًا أو تاريخًا ليس فيها؛ وإن لم تجد الجواب فيها فقل ذلك بوضوح.
٢) تجيب عن أي سؤال عام (علم، كتاب، مؤلف، نصيحة في القراءة) جوابًا قصيرًا صادقًا، وتقول «لا أعلم» إن لم تكن متأكدًا، ولا تنسب قولًا أو نصًّا لعالم أو كتاب إلا إن كنت متأكدًا منه. وفي الفتوى والأحكام الشرعية التفصيلية تذكر أنه يُرجع فيها إلى أهل العلم.
٣) إن طلب تعديلًا في خطته فاقترحه في actions، ولا تقل إنه نُفّذ: هو يرى الاقتراح ويضغط «نفّذ» بنفسه.
٤) وأنت أيضًا رفيقه وأنيسه في الطلب: إن أراد أن يدردش أو يفضفض أو يتكلم في أي شيء فجاريه بودّ ولطف كصديق قريب، واسأله عن حاله وعن قراءته، وشجّعه إن فتر، وافرح معه إن أنجز، ومازحه مزاحًا مؤدبًا إن مازحك. ولا تحوّل كل كلام إلى الخطة، ولا تعظ إلا إن طلب.

اكتب بالعامية المصرية المهذبة القريبة من كلامه (أو بالفصحى إن كتب بها)، بلا تكلّف ولا مقدمات؛ قصيرًا في الدردشة، ومفصّلًا بقدر الحاجة إن سأل سؤالًا يحتاج تفصيلًا.

٥) معك بحث في الإنترنت: إن سأل عن شيء تحتاج فيه معلومة من الإنترنت (خبر، كتاب لا تعرفه، طبعة، رابط، شرح على يوتيوب، معلومة لست متأكدًا منها، أو طلب صراحة «ابحث») فلا تخمّن، بل أجب أولًا بهذا فقط: {"search": "عبارة بحث قصيرة"}، فتصلك النتائج في رسالة، ثم تجيب منها وتذكر روابط المصادر التي أخذت منها. ولا تطلب البحث لما تعرفه يقينًا أو لما هو في حالة الصفحة.

أجب دائمًا بكائن JSON واحد فقط بهذا الشكل، بلا أي نص خارجه:
{"reply": "جوابك", "actions": []}

الأفعال الممكنة في actions (استعمل id الكتب كما هي في حالة الصفحة حرفيًّا، ولا تخترع id):
- {"type":"hide","id":"…"}: يشيل كتابًا من الجدول (يبقى في المكتبة).
- {"type":"restore","id":"…"}: يرجّع كتابًا من المكتبة إلى الجدول.
- {"type":"move_before","id":"…","ref":"…"}: يقدّم كتابًا ليُقرأ قبل كتاب آخر.
- {"type":"add_book","title":"…","author":"…","pages":200,"ref":"id كتاب يُقرأ الجديد قبله (اختياري)","lane":"A|B|C"}: يضيف كتابًا جديدًا ليس في الخطة. اسأله عن عدد الصفحات إن لم يذكره.
- {"type":"add_book","shari":true,"kind":"book|course","title":"…","author":"…","pages":عدد الصفحات أو الدروس,"level":0-4,"science":"sh-aqida|sh-quran|sh-hadith|sh-fiqh|sh-usul|…","url":"…"}: يضيف كتابًا أو دورة إلى مسار العلوم الشرعية.
- {"type":"set_pages","id":"…","pages":300}: يغيّر عدد صفحات كتاب.
- {"type":"mark_read","id":"…"} أو مع "undo":true: يعلّم كتابًا أنه قُرئ كله، أو يلغي ذلك.
- {"type":"tick","date":"YYYY-MM-DD","task":"id المهمة"} أو مع "undo":true: يعلّم مهمة يوم أنها تمّت.
- {"type":"vacation","from":"YYYY-MM-DD","to":"YYYY-MM-DD","label":"…"}: يضيف أيام إجازة بلا قراءة.
- {"type":"remove_vacation","from":"YYYY-MM-DD"}: يحذف إجازة.
- {"type":"note","date":"YYYY-MM-DD","text":"…"}: يكتب ملاحظة ليوم.
- {"type":"open_tab","tab":"…"}: يفتح تبويبًا في الصفحة.
إن لم يطلب تعديلًا فاجعل actions فارغة. وإن كان طلبه غامضًا (أي كتاب يقصد مثلًا) فاسأله ولا تقترح فعلًا.`;

function textOf(r) {
  if (!r) return '';
  if (typeof r === 'string') return r;
  if (typeof r.response === 'string') return r.response;
  if (r.response && typeof r.response === 'object') return JSON.stringify(r.response);
  const c = r.choices && r.choices[0] && r.choices[0].message;
  if (c) return typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
  if (Array.isArray(r.output)) { for (const o of r.output) for (const p of (o.content || [])) if (p.text) return p.text; }
  return '';
}
function parse(s) {
  s = String(s || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { const j = JSON.parse(s.slice(a, b + 1));
    if (j && typeof j === 'object' && typeof j.search === 'string' && j.search.trim() && !j.reply) return { search: j.search.trim().slice(0, 200), reply: '', actions: [] };
    if (j && typeof j === 'object') return { reply: String(j.reply || ''), actions: Array.isArray(j.actions) ? j.actions.slice(0, 10) : [] }; } catch (e) {} }
  return s ? { reply: s, actions: [] } : null;   // the model answered in plain words: show them
}

export async function askAI(env, { name, messages, ctx }) {
  const sys = SYSTEM(name) + '\n\nحالة الصفحة الآن (JSON):\n' + JSON.stringify(ctx || {}).slice(0, 24000);
  const msgs = [{ role: 'system', content: sys }].concat((Array.isArray(messages) ? messages : []).slice(-10)
    .map(m => ({ role: m && m.role === 'assistant' ? 'assistant' : 'user', content: String((m && m.content) || '').slice(0, 2000) })));
  let err = '', searched = [];
  if (env.GEMINI_API_KEY) {   // Gemini searches Google itself; the links it used are added under the answer
    const talk = msgs.slice(1); while (talk.length && talk[0].role !== 'user') talk.shift();
    // review 24 Nov 2026: Gemini searches Google itself, so it gets no «ask me to search» rule (that made it loop through every model)
    const gsys = sys.replace(/٥\) معك بحث في الإنترنت[\s\S]*?\n\n/, '');
    for (const model of models()) {
      try { const g = await gemini(env, model, gsys, talk); const j = parse(g.text);
        if (j && j.search) { err = model + ' asked to search'; break; }   // leave it to the Cloudflare path, which searches
        if (j && !j.search && (j.reply || j.actions.length)) {
          const src = g.sources.filter(x => x.url && !j.reply.includes(x.url)).slice(0, 4);
          const reply = j.reply + (src.length ? '\n\nالمصادر:\n' + src.map(x => `- ${x.title || 'مصدر'}: ${x.url}`).join('\n') : '');
          return { ok: true, reply, actions: j.actions, model, searched };
        }
        err = model + ' empty';
      } catch (e) { err = String(e && e.message || e).slice(0, 200); if (/ 40[13] |API key/i.test(err)) break; }
    }
  }
  for (let round = 0; round < 3; round++) {
    let j = null;
    for (const model of AI_MODELS) {
      for (const fmt of [true, false]) {
        try {
          const r = await env.AI.run(model, { messages: msgs, max_tokens: 1400, temperature: 0.3, ...(fmt ? { response_format: { type: 'json_object' } } : {}) });
          j = parse(textOf(r));
          if (j && (j.search || j.reply || j.actions.length)) { j.model = model; break; }
          j = null; err = 'empty answer';
        } catch (e) { err = String(e && e.message || e).slice(0, 200); }
      }
      if (j) break;
    }
    if (!j) break;
    if (!j.search) return { ok: true, reply: j.reply, actions: j.actions, model: j.model, searched };
    // the model asked to look something up: search, hand it the results, and ask again
    const res = round < 2 ? await webSearch(env, j.search) : [];
    searched.push(j.search);
    msgs.push({ role: 'assistant', content: JSON.stringify({ search: j.search }) });
    msgs.push({ role: 'user', content: (res.length ? `نتائج البحث عن «${j.search}»:\n` + res.map((x, i) => `${i + 1}. ${x.title}\n${x.url}\n${x.snippet}`).join('\n\n') : `لم يرجع البحث عن «${j.search}» بنتائج.`)
      + '\n\nأجب الآن سؤاله الأخير من هذه النتائج (ولا تطلب بحثًا آخر إلا لضرورة)، واذكر روابط ما أخذت منه، بكائن JSON {"reply":…,"actions":[]}.' });
  }
  return { ok: false, error: 'المساعد لا يعمل الآن، جرّب بعد قليل.', detail: err };
}

/* ---------- web search: Google or Brave (if a key is set as a Worker secret), else DuckDuckGo, else Wikipedia ---------- */
const strip = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
export async function webSearch(env, q) {
  const tries = [];
  if (env.GOOGLE_KEY && env.GOOGLE_CX) tries.push(async () => {
    const j = await fetch(`https://www.googleapis.com/customsearch/v1?key=${env.GOOGLE_KEY}&cx=${env.GOOGLE_CX}&num=6&q=${encodeURIComponent(q)}`).then(r => r.json());
    return (j.items || []).map(x => ({ title: x.title, url: x.link, snippet: x.snippet || '' }));
  });
  if (env.BRAVE_KEY) tries.push(async () => {
    const j = await fetch(`https://api.search.brave.com/res/v1/web/search?count=6&q=${encodeURIComponent(q)}`, { headers: { 'X-Subscription-Token': env.BRAVE_KEY, accept: 'application/json' } }).then(r => r.json());
    return ((j.web && j.web.results) || []).map(x => ({ title: strip(x.title), url: x.url, snippet: strip(x.description) }));
  });
  tries.push(async () => {
    const h = await fetch('https://html.duckduckgo.com/html/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', 'accept-language': 'ar,en;q=0.8' }, body: 'q=' + encodeURIComponent(q) + '&kl=xa-ar' }).then(r => r.status === 200 ? r.text() : '');   // 202 = DuckDuckGo refused an automated search
    const out = [], re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m; while ((m = re.exec(h)) && out.length < 6) {
      let u = m[1]; const uu = /uddg=([^&]+)/.exec(u); if (uu) u = decodeURIComponent(uu[1]); if (u.startsWith('//')) u = 'https:' + u;
      if (/duckduckgo\.com\/y\.js/.test(u)) continue;   // ads
      out.push({ title: strip(m[2]), url: u, snippet: strip(m[3]) });
    }
    return out;
  });
  tries.push(async () => {
    const out = [];
    for (const lang of ['ar', 'en']) {
      const j = await fetch(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=4&format=json&utf8=1`, { headers: { 'user-agent': 'manhaj-bot/1.0' } }).then(r => r.json());
      for (const x of (j.query && j.query.search) || []) out.push({ title: x.title, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(x.title.replace(/ /g, '_'))}`, snippet: strip(x.snippet) });
      if (out.length) break;
    }
    return out;
  });
  for (const f of tries) { try { const r = await f(); if (r.length) return r; } catch (e) {} }
  return [];
}
