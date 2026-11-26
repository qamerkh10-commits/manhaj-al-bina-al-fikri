// «مساعد القراءة» in Khaled's PDF reader (26 Nov 2026, his request: «واحد يساعد في القراءة وتحليل الصفح… وأديه أوامر
// كضيف هنا بوك مارك بعنوان كذا… صوتي»). It gets the image of the page (so scanned books work too), the page text when
// the file has one, what he selected, his bookmarks' titles and the last few exchanges; it answers and may return
// commands for the reader (bookmark, note, go to a page, highlight, link bookmarks, book mode, zoom).
// Keys: GEMINI_KEY_READER and its backups, then the general keys (keysFor in gemini.mjs). With no key, or when every
// key is used up, it reads the page on Cloudflare's own models (no key needed): Gemma 4, then Qwen 3.8, then Llama 4,
// which read a scanned Arabic page correctly in a test (26 Nov 2026).
import { gemini, models } from './gemini.mjs';
import { deepseek, dsKeys } from './deepseek.mjs';
import { teamPolish } from './team.mjs';

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

const CF_VISION = ['@cf/google/gemma-4-26b-a4b-it', '@cf/qwen/qwen3.8-27b', '@cf/meta/llama-4-scout-17b-16e-instruct'];
const CF_TEXT = ['@cf/qwen/qwen3.8-27b', '@cf/google/gemma-4-26b-a4b-it', '@cf/zai-org/glm-5.3'];
const OCR_ASK = 'انسخ نص هذه الصفحة كما هو حرفيًّا وبترتيبه من أعلاها إلى أسفلها، بلا تعليق ولا تلخيص ولا علامات تنسيق. وإن كان فيها حواشٍ فضعها في آخرها بعد سطر «الحواشي:».';
const REVIEW_SYS = 'أنت مراجع علمي دقيق. تراجع إجابة كتبها مساعد آخر عن صفحة من كتاب، على نص الصفحة نفسه. أعد JSON فقط.';

// a Cloudflare model run with thinking turned off (so the words go to the answer); the first that answers wins
async function cfRun(env, list, messages, max) {
  for (const model of list) {
    try { const r = await env.AI.run(model, { messages, max_tokens: max, temperature: 0.2, chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'low' });
      const msg = (r && r.choices && r.choices[0] && r.choices[0].message) || {};
      const t = r && (r.response || msg.content); if (t && String(t).trim()) return { text: String(t), model };
    } catch (e) { }
  }
  return null;
}
// «القارئ»: the text of a scanned page, read from its image
async function ocrPage(env, m) {
  if (!env.AI || !m) return null;
  return cfRun(env, CF_VISION, [{ role: 'user', content: [{ type: 'text', text: OCR_ASK }, { type: 'image_url', image_url: { url: `data:${m[1]};base64,${m[2]}` } }] }], 3500);
}
// «المراجع»: a second model checks the answer against the page text (DeepSeek if it did not write it, else Cloudflare)
async function review(env, { pageText, ask, reply, byDeepseek }) {
  const user = `نص الصفحة:\n${pageText.slice(0, 9000)}\n\nطلب القارئ: ${String(ask).slice(0, 1500)}\n\nالإجابة المقترحة:\n${reply}\n\nراجع الإجابة على نص الصفحة: صحّح ما يخالف النص أو ينسب إليه ما ليس فيه، وأكمل ما نقص نقصًا مهمًّا، وأبقِ الصحيح بأسلوبه. أعد JSON فقط: {"reply":"الإجابة بعد المراجعة","actions":[]}`;
  if (!byDeepseek && dsKeys(env).length) try { const d = await deepseek(env, REVIEW_SYS, [{ role: 'user', content: user }], { json: true }); const j = parse(d.text); if (j && j.reply) return { reply: j.reply, by: d.model } } catch (e) { }
  if (env.AI) { const r = await cfRun(env, CF_TEXT, [{ role: 'system', content: REVIEW_SYS }, { role: 'user', content: user }], 2500); if (r) { const j = parse(r.text); if (j && j.reply) return { reply: j.reply, by: r.model } } }
  return null;
}

const field = (t, k) => { try { const s = String(t || ''), a = s.indexOf('{'), b = s.lastIndexOf('}'); const j = JSON.parse(s.slice(a, b + 1)); return typeof j[k] === 'string' ? j[k] : '' } catch (e) { return '' } };

export async function askReader(env, { keys, ask, image, text, book, page, sel, bms, history, voice, check, team }) {
  if ((!keys || !keys.length) && !env.AI && !dsKeys(env).length) return { ok: false, error: 'مساعد القراءة غير مفعّل بعد.' };
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ''));
  let pageText = String(text || '').slice(0, 9000), ocr = null;
  const head = pt => `الكتاب: «${String(book || '').slice(0, 200)}». الصفحة: ${String(page || '').slice(0, 20)}.`
    + (pt ? `\nنص الصفحة (قد يكون ناقصًا أو مقلوب الترتيب):\n${pt}` : '')
    + (sel ? `\nالكلام الذي حدّده: «${String(sel).slice(0, 2000)}»` : '')
    + (Array.isArray(bms) && bms.length ? `\nعلاماته في هذا الكتاب: ${bms.slice(0, 60).map(x => String(x).slice(0, 80)).join(' | ')}` : '')
    + `\n\n${voice ? 'قال بصوته' : 'كتب'}: ${String(ask || '').slice(0, 2000)}`;
  const past = (Array.isArray(history) ? history : []).slice(-6).map(h => ({ role: h && h.role === 'assistant' ? 'assistant' : 'user', content: String((h && h.content) || '').slice(0, 1500) })).filter(h => h.content);
  while (past.length && past[0].role !== 'user') past.shift();
  const errs = [];
  let res = null;
  // 1) Gemini reads the image itself
  if (keys && keys.length) {
    const tail = team && !pageText && m ? '\n\n(إن كان طلبه سؤالًا لا أمرًا فأضف في JSON حقل "page_text" فيه نص الصفحة كما تقرؤه من الصورة.)' : '';
    const parts = (m ? [{ inlineData: { mimeType: m[1], data: m[2] } }] : []).concat([{ text: head(pageText) + tail }]);
    for (const model of models()) {
      try { const g = await gemini(env, model, SYS, past.concat([{ role: 'user', parts }]), { keys, bare: 1, json: 1 }); const j = parse(g.text); if (j && (j.reply || j.actions.length)) { res = { ...j, model }; const pt = field(g.text, 'page_text'); if (pt && !pageText) { pageText = pt.slice(0, 9000); ocr = pageText } break } errs.push(model + ' empty') }
      catch (e) { errs.push(String(e.message || e).slice(0, 300)); if (/ (400) /.test(' ' + e.message + ' ') && !/not found|is not supported|unknown/i.test(e.message)) break }
    }
  }
  // 2) the team: «القارئ» turns the page into text, «المفكّر» (DeepSeek) thinks with it
  if (!res && dsKeys(env).length) {
    if (!pageText && m) { const o = await ocrPage(env, m); if (o) { pageText = o.text.slice(0, 9000); ocr = pageText } }
    if (pageText) try { const d = await deepseek(env, SYS, past.concat([{ role: 'user', content: head(pageText) }]), { json: true }); const j = parse(d.text); if (j && (j.reply || j.actions.length)) res = { ...j, model: d.model, team: ocr ? 'القارئ ثم المفكّر' : 'المفكّر' }; else errs.push('deepseek empty') }
    catch (e) { errs.push(String(e.message || e).slice(0, 200)) }
  }
  // 3) Cloudflare's own vision models answer from the image (no key needed)
  if (!res && env.AI) {
    const content = [{ type: 'text', text: head(pageText) }];
    if (m) content.push({ type: 'image_url', image_url: { url: `data:${m[1]};base64,${m[2]}` } });
    const r = await cfRun(env, CF_VISION, [{ role: 'system', content: SYS }].concat(past, [{ role: 'user', content }]), 2500);
    if (r) { const j = parse(r.text); if (j && (j.reply || j.actions.length)) res = { ...j, model: r.model, fallback: 1 }; else errs.push(r.model + ' empty') } else errs.push('cloudflare none');
  }
  if (!res) { console.error('reader', errs.join(' || ')); return { ok: false, error: 'تعذّر الرد الآن. جرّب بعد قليل.' } }
  // «الفريق»: Gemini's draft goes to Qwen (critic), then GLM (a second angle), then back to Gemini to write the answer
  if (team && /gemini/.test(res.model || '') && !(res.actions || []).length && String(res.reply || '').length > 250 && env.AI) {
    const tp = await teamPolish(env, { keys, sys: SYS, question: ask, source: pageText, draft: res.reply });
    if (tp) { const j = parse(tp.text); if (j && j.reply) { res.reply = j.reply; res.team = ['Gemini'].concat(tp.steps, ['Gemini']).join(' ← '); check = false } }
  }
  // 4) «المراجع»: for an analysis or a quiz (or when he asks), a second model checks the answer on the page text
  if (check && res.reply && env.AI) {
    if (!pageText && m) { const o = await ocrPage(env, m); if (o) { pageText = o.text.slice(0, 9000); ocr = pageText } }
    if (pageText) { const rv = await review(env, { pageText, ask, reply: res.reply, byDeepseek: /^deepseek/.test(res.model) }); if (rv) { res.reply = rv.reply; res.reviewed = rv.by } }
  }
  return { ok: true, ...res, ocr: ocr || undefined };
}
