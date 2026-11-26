// «مساعد القراءة» in Khaled's PDF reader (26 Nov 2026, his request: «واحد يساعد في القراءة وتحليل الصفح… وأديه أوامر
// كضيف هنا بوك مارك بعنوان كذا… صوتي»). It gets the image of the page (so scanned books work too), the page text when
// the file has one, what he selected, his bookmarks' titles and the last few exchanges; it answers and may return
// commands for the reader (bookmark, note, go to a page, highlight, link bookmarks, book mode, zoom).
// Keys: GEMINI_KEY_READER and its backups, then the general keys (keysFor in gemini.mjs).
import { gemini, models } from './gemini.mjs';

export const READ_DAILY = 150;   // requests per day, so the free allowance is never used up

const SYS = `أنت «مساعد القراءة» لخالد داخل قارئ الكتب في صفحته. خالد طالب علم يقرأ كتبًا فكرية وشرعية وأدبية.
يصلك: صورة الصفحة الحالية (وقد يصل نصها)، وطلبه، وربما كلام حدّده، وعناوين علاماته في هذا الكتاب.
- اقرأ الصورة جيدًا. أجب بعربية فصيحة سهلة، منظمة بنقاط قصيرة، ملتزمًا بما في الصفحة، ولا تنسب إليها ما ليس فيها.
- إن سأل عن شيء خارج الصفحة فأجب بعلمك وقل إنه من خارج الصفحة. وإن لم تتبين الصورة فقل ذلك.
- «حلّل الحجة»: الدعوى، ثم المقدمات، ثم الأدلة، ثم الاعتراضات الممكنة وجوابها، ثم تقويم مختصر.
- إن طلب أمرًا على القارئ (علامة، تعليق، انتقال، تظليل، ربط، وضع الكتاب، تكبير) فنفّذه بإرجاعه في actions، واجعل reply جملة قصيرة تقول ما فعلت.
- إن كان كلامه صوتيًّا فقد يكون فيه أخطاء تفريغ؛ افهم مقصوده.
أعد JSON فقط بهذا الشكل: {"reply":"…","actions":[…]}
الأوامر الممكنة في actions:
{"type":"bookmark","title":"…","parent":"عنوان علامة موجودة لتكون تحتها (اختياري)","page":رقم الصفحة (اختياري، الافتراضي الحالية)}
{"type":"note","text":"…","page":رقم (اختياري)}
{"type":"go","page":رقم}  {"type":"next"}  {"type":"prev"}
{"type":"highlight","text":"عبارة من الصفحة كما هي حرفيًّا"}
{"type":"link","a":"عنوان علامة","b":"عنوان علامة","label":"وصف (اختياري)"}
{"type":"book_mode","on":true}  {"type":"zoom","value":"in|out|fit"}`;

function parse(t) {
  const s = String(t || ''); const a = s.indexOf('{'), b = s.lastIndexOf('}');
  try { const j = JSON.parse(a >= 0 && b > a ? s.slice(a, b + 1) : s); return { reply: String(j.reply || '').slice(0, 6000), actions: Array.isArray(j.actions) ? j.actions.slice(0, 12) : [] } }
  catch (e) { return s.trim() ? { reply: s.trim().slice(0, 6000), actions: [] } : null }
}

export async function askReader(env, { keys, ask, image, text, book, page, sel, bms, history, voice }) {
  if (!keys || !keys.length) return { ok: false, error: 'مساعد القراءة غير مفعّل: أضف مفتاح GEMINI_KEY_READER أو المفتاح العام.' };
  const parts = [];
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ''));
  if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
  parts.push({ text: `الكتاب: «${String(book || '').slice(0, 200)}». الصفحة: ${String(page || '').slice(0, 20)}.`
    + (text ? `\nنص الصفحة كما استُخرج من الملف (قد يكون ناقصًا أو مقلوب الترتيب):\n${String(text).slice(0, 8000)}` : '')
    + (sel ? `\nالكلام الذي حدّده: «${String(sel).slice(0, 2000)}»` : '')
    + (Array.isArray(bms) && bms.length ? `\nعلاماته في هذا الكتاب: ${bms.slice(0, 60).map(x => String(x).slice(0, 80)).join(' | ')}` : '')
    + `\n\n${voice ? 'قال بصوته' : 'كتب'}: ${String(ask || '').slice(0, 2000)}` });
  const past = (Array.isArray(history) ? history : []).slice(-6).map(h => ({ role: h && h.role === 'assistant' ? 'assistant' : 'user', content: String((h && h.content) || '').slice(0, 1500) })).filter(h => h.content);
  while (past.length && past[0].role !== 'user') past.shift();
  const msgs = past.concat([{ role: 'user', parts }]);
  const errs = [];
  for (const model of models()) {
    try { const g = await gemini(env, model, SYS, msgs, { keys, bare: 1, json: 1 }); const j = parse(g.text); if (j && (j.reply || j.actions.length)) return { ok: true, ...j, model }; errs.push(model + ' empty') }
    catch (e) { errs.push(String(e.message || e).slice(0, 300)); if (/ (400) /.test(' ' + e.message + ' ') && !/not found|is not supported|unknown/i.test(e.message)) break }
  }
  console.error('reader', errs.join(' || '));
  return { ok: false, error: 'تعذّر الرد الآن. جرّب بعد قليل.' };
}
