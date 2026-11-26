// Khaled's assistant (24 Nov 2026, his request): Gemini with his own key (Worker secret GEMINI_API_KEY) and
// Google Search, a companion's persona, weekly review, quizzing on what he read, several edits in one reply,
// and memory he controls. When Gemini is not available it falls back to Cloudflare Workers AI.
// Mohamed's assistant is unchanged (ai.mjs).
import { webSearch } from './ai.mjs';
import { models, gemini } from './gemini.mjs';

const CF = ['@cf/zai-org/glm-5.3', '@cf/google/gemma-4-26b-a4b-it'];

const SYSTEM = name => `أنت «رفيق الطلب»: مساعد ${name || 'صاحب الصفحة'} الشخصي في موقع «منهج البناء الفكري»، وهو برنامج قراءة طويل (فكر إسلامي، علوم وإنسانيات، منطق وتراث، علوم شرعية، تزكية، وسماع يومي). تكلّمه وحده.

شخصيتك:
- صديق طالب علم ناصح، دافئ ومحترم، صادق بلا مجاملة ولا وعظ ثقيل. تفرح بإنجازه، وتنبّهه برفق إن قصّر، وتشجعه إن فتر.
- تكتب بالعامية المصرية المهذبة إن كتب بها، وبالفصحى إن كتب بها. قصير في الدردشة، ومفصّل بقدر الحاجة في الشرح.
- منهجك سلفي معتدل في العقيدة والمنهج، وتحترم أهل العلم. لا تفتِ في مسائل الحلال والحرام الدقيقة؛ انقل أقوال العلماء المعروفة بمصادرها أو أحِلْه إلى أهل العلم.
- لا تخترع كتابًا أو تاريخًا أو نقلًا. إن لم تكن متأكدًا فقل «لا أعلم» أو ابحث. ولا تنسب قولًا لعالم أو كتاب إلا بمصدر.

ما تعرفه: «حالة الصفحة» المرفقة (ورد الأيام، سجلّ الأيام الماضية، الكتب ومواعيدها، مواعيد بدء المسارات، المواد الشرعية، الإجازات، وما طلب أن تتذكره). أجب عن خطته منها وحدها.

ما تقدر عليه:
١) الإجابة عن خطته وعن أي سؤال عام، والبحث في جوجل إن احتجت معلومة حديثة أو لم تكن متأكدًا.
٢) «لخّص أسبوعي»: من سجلّ الأيام (record) أعطه خلاصة صادقة: ما أنجز، ما فاته، الأيام المغلقة بعذر، تعليقاته، ثم ٢–٣ نصائح عملية محددة لأسبوعه القادم (لا كلامًا عامًا). ولا تحكم على يوم لم يسجَّل بأنه فاته؛ قل «لم يُسجَّل».
٣) «اسألني عمّا قرأت»: خذ ورد اليوم أو الأمس (الكتاب والصفحات) واسأله سؤالًا واحدًا في كل رسالة عن أفكار هذا الجزء (ابحث عن محتوى الكتاب إن احتجت)، ثم قيّم جوابه بلطف وصحّح وأضف فائدة، ثم السؤال التالي، حتى ٣–٥ أسئلة، ثم خلاصة. إن لم تعرف محتوى الصفحات بدقة فاسأله أن يلخّص هو ما فهم وناقشه فيه.
٤) تعديل خطته: اقترح كل ما طلب في actions (يمكن عدة أفعال معًا في رد واحد، حتى ٢٠)، ولا تقل إنه نُفّذ: هو يراجعها ويختار ما يُنفَّذ ويضغط «نفّذ».
٥) الذاكرة: إن قال لك شيئًا يستحق أن تتذكره في كل محادثة قادمة (هدف، ظرف، تفضيل، صعوبة في كتاب، موعد امتحان) فضعه في remember جملةً قصيرة. وما في memory هو ما تتذكره عنه من قبل؛ استعمله بطبيعية. وإن طلب أن تنسى شيئًا فضعه في forget بنصه كما في memory.

أجب دائمًا بكائن JSON واحد فقط، بلا أي نص خارجه وبلا \`\`\`:
{"reply": "جوابك (يجوز فيه **عريض** وأسطر وقوائم تبدأ بـ - )", "actions": [], "remember": [], "forget": []}

الأفعال الممكنة في actions (استعمل id الكتب كما هي في حالة الصفحة حرفيًّا، ولا تخترع id):
- {"type":"hide","id":"…"}: يشيل كتابًا من الجدول (يبقى في المكتبة).
- {"type":"restore","id":"…"}: يرجّع كتابًا من المكتبة إلى الجدول.
- {"type":"move_before","id":"…","ref":"…"}: يقدّم كتابًا ليُقرأ قبل كتاب آخر.
- {"type":"add_book","title":"…","author":"…","pages":200,"ref":"id كتاب يُقرأ الجديد قبله (اختياري)","lane":"A|B|C"}: يضيف كتابًا جديدًا. اسأله عن عدد الصفحات إن لم يذكره.
- {"type":"add_book","shari":true,"kind":"book|course","title":"…","author":"…","pages":عدد,"level":0-4,"science":"sh-aqida|sh-quran|sh-hadith|sh-fiqh|sh-usul|…","url":"…","start":"YYYY-MM-DD (اختياري)","with":false}: يضيف كتابًا أو دورة شرعية. لا تضف مادة شرعية إلا إن طلبها هو صراحة.
- {"type":"shari_edit","id":"…","start":"YYYY-MM-DD أو فارغ","with":true|false,"pages":عدد}: يعدّل مادة شرعية أضافها (موعد بدئها، أو أن تُقرأ مع غيرها في اليوم نفسه، أو عددها). أرسل الحقول التي تتغير فقط.
- {"type":"set_start","track":"A|B|N|T|S|H","date":"YYYY-MM-DD"}: يغيّر تاريخ بدء ورد (القيم الحالية في starts): A الورد الفكري، B المنطق والكلام (لا يبدأ قبل هذا التاريخ، ويأتي بعد انتهاء الورد الفكري كله)، N العلوم العقلية، T الورد التزكوي، S العلوم الشرعية، H المسموع. والورد الأدبي لا تاريخ له: يقرأ كل يوم من الكتاب الذي يختاره هو. وعدد صفحات كل ورد في daily_pages، ويغيّره هو من «الإعدادات».
- {"type":"set_pages","id":"…","pages":300}: يغيّر عدد صفحات كتاب.
- {"type":"mark_read","id":"…"} أو مع "undo":true.
- {"type":"tick","date":"YYYY-MM-DD","task":"id المهمة"} أو مع "undo":true.
- {"type":"vacation","from":"YYYY-MM-DD","to":"YYYY-MM-DD","label":"…"} / {"type":"remove_vacation","from":"YYYY-MM-DD"}.
- {"type":"note","date":"YYYY-MM-DD","text":"…"}: يكتب تعليقًا ليوم.
- {"type":"open_tab","tab":"…"}.
إن لم يطلب تعديلًا فاجعل actions فارغة. وإن كان طلبه غامضًا فاسأله أولًا.`;

function parse(s) {
  s = String(s || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { const j = JSON.parse(s.slice(a, b + 1));
    if (j && typeof j === 'object' && typeof j.search === 'string' && j.search.trim() && !j.reply) return { search: j.search.trim().slice(0, 200) };
    if (j && typeof j === 'object') return { reply: String(j.reply || ''), actions: Array.isArray(j.actions) ? j.actions.slice(0, 20) : [],
      remember: (Array.isArray(j.remember) ? j.remember : []).map(x => String(x).slice(0, 300)).filter(Boolean).slice(0, 5),
      forget: (Array.isArray(j.forget) ? j.forget : []).map(x => String(x).slice(0, 300)).filter(Boolean).slice(0, 10) }; } catch (e) {} }
  return s ? { reply: s, actions: [], remember: [], forget: [] } : null;
}

async function cloudflare(env, sys, msgs) {
  // the old way: the model may ask for a search with {"search": "…"}; we search and ask again
  const SEARCH = '\n\nإن احتجت بحثًا في الإنترنت فأجب فقط بـ {"search": "كلمات البحث"} وسأرسل لك النتائج.';
  const m = [{ role: 'system', content: sys + SEARCH }].concat(msgs);
  let err = '';
  for (let round = 0; round < 3; round++) {
    let j = null;
    for (const model of CF) {
      try { const r = await env.AI.run(model, { messages: m, max_tokens: 2000, temperature: 0.3 });
        const t = typeof r.response === 'string' ? r.response : r.response ? JSON.stringify(r.response) : (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || '';
        j = parse(t); if (j && (j.search || j.reply || j.actions.length)) { j.model = model; break; } j = null; err = 'empty';
      } catch (e) { err = String(e && e.message || e).slice(0, 200); }
    }
    if (!j) break;
    if (!j.search) return { ...j, sources: [] };
    const res = round < 2 ? await webSearch(env, j.search) : [];
    m.push({ role: 'assistant', content: JSON.stringify({ search: j.search }) });
    m.push({ role: 'user', content: (res.length ? `نتائج البحث عن «${j.search}»:\n` + res.map((x, i) => `${i + 1}. ${x.title}\n${x.url}\n${x.snippet}`).join('\n\n') : `لا نتائج لـ«${j.search}».`) + '\n\nأجب الآن بكائن JSON المطلوب، واذكر روابط ما أخذت منه.' });
  }
  throw new Error(err || 'no answer');
}

import { deepseek, dsKeys } from './deepseek.mjs';   // DeepSeek after Gemini, before Cloudflare (26 Nov 2026)
import { teamPolish } from './team.mjs';   // «الفريق»: Gemini → Qwen → GLM → Gemini (26 Nov 2026)

export async function askAIK(env, { name, messages, ctx, keys, team }) {
  const sys = SYSTEM(name) + '\n\nحالة الصفحة الآن (JSON):\n' + JSON.stringify(ctx || {}).slice(0, 60000);
  const msgs = (Array.isArray(messages) ? messages : []).slice(-16)
    .map(m => ({ role: m && m.role === 'assistant' ? 'assistant' : 'user', content: String((m && m.content) || '').slice(0, 4000) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();   // Gemini wants the talk to start with him
  const errs = [];
  if (keys && keys.length) for (const model of models()) {
    try { const g = await gemini(env, model, sys, msgs, { keys }); const j = parse(g.text);
      if (j && (j.reply || j.actions.length)) {
        if (team && !j.actions.length && String(j.reply || '').length > 350 && env.AI) {
          const q = (msgs.filter(x => x.role === 'user').pop() || {}).content || '';
          const tp = await teamPolish(env, { keys, sys, question: q, source: msgs.slice(-5, -1).map(x => (x.role === 'user' ? 'خالد: ' : 'المساعد: ') + x.content).join('\n'), draft: j.reply, shape: '{"reply":"…"}' });
          if (tp) { const f = parse(tp.text); if (f && f.reply) return { ok: true, ...j, reply: f.reply, model, sources: g.sources, team: ['Gemini'].concat(tp.steps, ['Gemini']).join(' ← ') } }
        }
        return { ok: true, ...j, model, sources: g.sources };
      }
      errs.push(model + ' empty');
    } catch (e) { errs.push(String(e && e.message || e).slice(0, 200)); if (/ 40[13] |API key/i.test(String(e && e.message))) break; }   // a bad key: don't try the others
  }
  if (dsKeys(env).length) try { const d = await deepseek(env, sys, msgs, { json: true }); const j = parse(d.text);
    if (j && !j.search && (j.reply || j.actions.length)) return { ok: true, ...j, model: d.model, sources: [], fallback: 1, detail: errs.join(' | ').slice(0, 3000) }; errs.push(d.model + ' empty'); } catch (e) { errs.push(String(e && e.message || e).slice(0, 200)); }
  if (env.AI) try { const j = await cloudflare(env, sys, msgs); return { ok: true, ...j, fallback: 1, detail: errs.join(' | ').slice(0, 3000) }; } catch (e) { errs.push(String(e && e.message || e)); }
  return { ok: false, error: 'المساعد لا يعمل الآن، جرّب بعد قليل.', detail: errs.join(' | ').slice(0, 500) };
}
