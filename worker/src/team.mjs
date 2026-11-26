// «الفريق» (Khaled, 26 Nov 2026: «جيميناي يعمل حاجة ويسلمها لنموذج تاني، والنموذج ده يسلمها لتالت، وبعد كدا تروح
// لجيميناي يصيغ الإجابة»). After Gemini's draft:
//   2) Qwen 3.8 (Cloudflare) — the critic: errors against the source, what is missing, what to cut;
//   3) GLM 5.3 (Cloudflare) — a second angle: an example, an objection and its answer, a link to what came before;
//   4) Gemini — writes the final answer from the draft and both notes, in the caller's JSON shape.
// Any step that fails is skipped; if the last Gemini step fails, the draft is returned as it was.
import { gemini, models } from './gemini.mjs';

const CRITIC = ['@cf/qwen/qwen3.8-27b', '@cf/google/gemma-4-26b-a4b-it'];
const ANGLE = ['@cf/zai-org/glm-5.3', '@cf/google/gemma-4-26b-a4b-it', '@cf/qwen/qwen3.8-27b'];
const short = s => String(s || '').trim();
const nameOf = m => /qwen/.test(m) ? 'Qwen' : /glm/.test(m) ? 'GLM' : /gemma/.test(m) ? 'Gemma' : /llama/.test(m) ? 'Llama' : m;

async function cfText(env, list, sys, user, max = 1400) {
  if (!env.AI) return null;
  for (const model of list) {
    try { const r = await env.AI.run(model, { messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], max_tokens: max, temperature: 0.3, chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'low' });
      const msg = (r && r.choices && r.choices[0] && r.choices[0].message) || {};
      const t = short(r && (r.response || msg.content)); if (t) return { text: t.slice(0, 4000), model };
    } catch (e) { }
  }
  return null;
}

// sys: the caller's system prompt (it defines the final JSON shape); source: the page text or the plan's state
export async function teamPolish(env, { keys, sys, question, source, draft, shape }) {
  const steps = [];
  const base = `السؤال: ${short(question).slice(0, 1500)}\n\nالمصدر:\n${short(source).slice(0, 8000) || '(لا نص)'}\n\nمسودة الإجابة:\n${short(draft).slice(0, 5000)}`;
  const c1 = await cfText(env, CRITIC, 'أنت ناقد علمي دقيق. تقرأ مسودة إجابة كتبها مساعد آخر وتقارنها بالمصدر. اكتب ملاحظات قصيرة فقط، بلا مقدمات ولا إعادة كتابة.',
    base + '\n\nاذكر في نقاط قصيرة: (١) ما يخالف المصدر أو ينسب إليه ما ليس فيه، (٢) ما نقص نقصًا مهمًّا، (٣) ما يحسن حذفه. وإن كانت سليمة فقل «سليمة».');
  if (c1) steps.push(nameOf(c1.model));
  const c2 = await cfText(env, ANGLE, 'أنت معلّم متمرّس. تضيف زاوية لم تذكرها المسودة، في نقاط قصيرة، بلا مقدمات.',
    base + (c1 ? `\n\nملاحظات الناقد الأول:\n${c1.text}` : '') + '\n\nأضف زاوية مختلفة مفيدة للقارئ: مثالًا يوضّح، أو اعتراضًا وجوابه، أو ربطًا بما قبله أو بما بعده. ثلاث نقاط على الأكثر.');
  if (c2) steps.push(nameOf(c2.model));
  if (!c1 && !c2) return null;
  const final = `${base}${c1 ? `\n\nملاحظات المراجع الأول (${nameOf(c1.model)}):\n${c1.text}` : ''}${c2 ? `\n\nإضافة المراجع الثاني (${nameOf(c2.model)}):\n${c2.text}` : ''}`
    + `\n\nاكتب الإجابة النهائية للقارئ: صحّح ما نبّه عليه المراجعان إن كان صحيحًا، وأدخل المفيد من إضافتهما في موضعه، واحذف الحشو. بعربية فصيحة سهلة منظمة، بلا ذكر للمراجعين ولا للمسودة. أعد JSON فقط بالشكل: ${shape || '{"reply":"…","actions":[]}'}`;
  for (const model of models()) {
    try { const g = await gemini(env, model, sys, [{ role: 'user', content: final }], { keys, bare: 1, json: 1 }); if (short(g.text)) return { text: g.text, steps, model } }
    catch (e) { if (/ (400) /.test(' ' + e.message + ' ') && !/not found|is not supported|unknown/i.test(e.message)) break }
  }
  return null;
}
