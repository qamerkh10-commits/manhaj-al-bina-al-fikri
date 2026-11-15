// Strict daily follow-up bot for «منهج البناء الفكري».
// Runs as a short job every few minutes (GitHub Actions): reads new Telegram updates, sends what is due, saves state.
// State is AES-256-GCM encrypted with a key derived from the bot token, so it can live in a public repo.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSchedule } from './schedule.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.TELEGRAM_TOKEN;
if (!TOKEN) { console.error('TELEGRAM_TOKEN is missing (add it in Settings → Secrets → Actions)'); process.exit(1); }
const BASE = process.env.TG_API || 'https://api.telegram.org';
const STATE_FILE = process.env.STATE_FILE || path.join(DIR, '..', 'state.enc');
const INDEX = process.env.INDEX_FILE || path.join(DIR, '..', 'index.html');
const TZ = 'Africa/Cairo';
const CFG = {
  morning: 7,                 // the day's card is sent at 7:00
  reminders: [15, 20, 22.5, 23.5], // escalating reminders while the day is unfinished
  close: 2,                   // a day stays open until 2:00 after midnight, then what is left becomes debt
  weeklyDay: 5, weeklyHour: 9, // Friday report
  excusesPerMonth: 2,
  minSummaryWords: 8,
  debtAlarm: 8,
};

/* ---------- time ---------- */
function now() {
  const d = process.env.FAKE_NOW ? new Date(process.env.FAKE_NOW) : new Date();
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const g = t => p.find(x => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour: (+g('hour') % 24) + +g('minute') / 60 };
}
const addDays = (k, n) => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const dow = k => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const nA = n => Number(n).toLocaleString('ar-EG');
const fL = k => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }); };
const tasksN = n => n === 1 ? 'مهمة واحدة' : n === 2 ? 'مهمتان' : n <= 10 ? `${nA(n)} مهام` : `${nA(n)} مهمة`;
const daysN = n => n === 1 ? 'يوم واحد' : n === 2 ? 'يومان' : n <= 10 ? `${nA(n)} أيام` : `${nA(n)} يومًا`;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

/* ---------- encrypted state ---------- */
const KEY = crypto.createHash('sha256').update('manhaj-bot-state:' + TOKEN).digest();
function load() {
  try {
    const b = Buffer.from(fs.readFileSync(STATE_FILE, 'utf8'), 'base64');
    const dc = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12)); dc.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([dc.update(b.subarray(28)), dc.final()]).toString('utf8'));
  } catch (e) { if (fs.existsSync(STATE_FILE)) console.error('state could not be read, starting fresh:', e.message); return null; }
}
function save(st) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(st), 'utf8'), c.final()]);
  fs.writeFileSync(STATE_FILE, Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64'));
}

/* ---------- telegram ---------- */
async function tg(method, body) {
  const r = await fetch(`${BASE}/bot${TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({ ok: false }));
  if (!j.ok && !/message is not modified|query is too old|query ID is invalid/.test(j.description || '')) console.error(method, j.description || r.status);
  return j.result;
}
const MENU = { keyboard: [[{ text: '📋 ورد اليوم' }, { text: '📌 الدَّين' }], [{ text: '📊 تقريري' }, { text: '🙏 عذر' }], [{ text: '💾 نسخة للتطبيق' }]], resize_keyboard: true, is_persistent: true };
const send = (text, extra = {}) => tg('sendMessage', { chat_id: S.owner, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

/* ---------- state ---------- */
const N = now(), TODAY = N.date, YDAY = addDays(TODAY, -1);
let S = load() || {};
const BEFORE = JSON.stringify(S);
S = Object.assign({ owner: null, offset: 0, settings: {}, sched: {}, schedKey: '', fin: null, days: {}, debt: [], excuses: {}, await: null, startedOn: null, lastWeekly: '', debtMsg: null }, S);
const day = k => (S.days[k] ||= { done: {}, rem: {} });
const tasks = k => (S.sched[k] && S.sched[k].tasks) || [];

async function ensureSchedule(force) {
  const key = sha(sha(fs.readFileSync(INDEX, 'utf8')) + JSON.stringify(S.settings));
  if (!force && S.schedKey === key && S.sched[addDays(TODAY, 14)]) return;
  const r = await buildSchedule(INDEX, S.settings, addDays(TODAY, -2), addDays(TODAY, 60));
  const past = Object.fromEntries(Object.entries(S.sched).filter(([k]) => k < addDays(TODAY, -2) && k >= addDays(TODAY, -120)));
  S.sched = { ...past, ...r.days }; S.fin = r.fin; S.schedKey = key;
  console.log('schedule rebuilt');
}

/* ---------- day logic ---------- */
const isOpen = k => tasks(k).length && !day(k).closed && (k === TODAY || (k === YDAY && N.hour < CFG.close));
const allDone = k => tasks(k).every(t => day(k).done[t.id]);
const openDay = () => (isOpen(YDAY) && !allDone(YDAY) ? YDAY : null) || (tasks(TODAY).length ? TODAY : null);

function closeDays() {
  if (!S.startedOn) return;
  for (const k of Object.keys(S.sched).sort()) {
    if (k < S.startedOn || k >= TODAY || (k === YDAY && N.hour < CFG.close)) continue;
    const d = day(k);
    if (d.closed || !tasks(k).length) continue;
    if (d.completeAt) d.closed = 'done';
    else {
      d.closed = d.excused ? 'excused' : 'missed';
      tasks(k).filter(t => !d.done[t.id]).forEach(t => { if (!S.debt.some(x => x.k === k && x.id === t.id)) S.debt.push({ k, id: t.id }); });
      d.justMissed = true;
    }
  }
}
function streak() {
  let n = 0;
  const ks = Object.keys(S.sched).filter(k => k >= (S.startedOn || TODAY) && k <= TODAY && tasks(k).length).sort().reverse();
  for (const k of ks) {
    const d = day(k);
    if (d.completeAt) n++;
    else if (d.closed === 'excused' || !d.closed) continue; // excused days and still-open days neither add nor break
    else break;
  }
  return n;
}
function best() { let b = 0, n = 0; Object.keys(S.sched).filter(k => k >= (S.startedOn || TODAY) && tasks(k).length).sort().forEach(k => { const d = day(k); if (d.completeAt) { n++; b = Math.max(b, n); } else if (d.closed && d.closed !== 'excused') n = 0; }); return b; }
const bar = (a, b) => { const f = b ? Math.round(a / b * 10) : 0; return '▰'.repeat(f) + '▱'.repeat(10 - f); };
const short = t => { const s = t.replace(/^\S+\s+/, '').replace(/^اقرأ\s+/, ''); return s.length > 42 ? s.slice(0, 41) + '…' : s; };

function card(k) {
  const d = day(k), t = tasks(k), dn = t.filter(x => d.done[x.id]).length;
  let s = `📅 <b>${k === TODAY ? 'ورد اليوم' : 'ورد'} — ${fL(k)}</b>\n${bar(dn, t.length)}  ${nA(dn)} من ${nA(t.length)}\n\n`;
  s += t.map(x => `${d.done[x.id] ? '✅' : '⬜'} ${esc(x.txt)}`).join('\n');
  if (d.summary) s += `\n\n📝 <i>${esc(d.summary)}</i>`;
  if (d.completeAt) s += `\n\n🔥 تمّ الورد. السلسلة: ${daysN(streak())}`;
  else if (d.closed) s += `\n\n${d.closed === 'excused' ? '🙏 يوم بعذر' : '❌ فات اليوم'}، وما لم يتم صار دَينًا.`;
  else s += `\n\n⏳ يُغلق اليوم الساعة ${nA(CFG.close)} بعد منتصف الليل.`;
  const kb = t.map((x, i) => [{ text: (d.done[x.id] ? '✅ ' : '⬜ ') + short(x.txt), callback_data: `t|${k}|${i}` }]);
  if (dn < t.length && !d.closed) kb.push([{ text: '✅ أتممت الورد كله', callback_data: `a|${k}` }]);
  return { text: s, reply_markup: { inline_keyboard: kb } };
}
async function sendCard(k, prefix = '') {
  const c = card(k);
  const m = await send(prefix + c.text, { reply_markup: c.reply_markup });
  if (m) day(k).msg = m.message_id;
  const d = day(k);
  if (k === TODAY && !d.sent) { // first card of the day: reminders already past are skipped, so a late start sends no burst
    d.sent = true;
    CFG.reminders.forEach((h, i) => { if (N.hour >= h) d.rem[i] = true; });
  }
}
async function refreshCard(k, mid) {
  const c = card(k);
  await tg('editMessageText', { chat_id: S.owner, message_id: mid || day(k).msg, text: c.text, parse_mode: 'HTML', reply_markup: c.reply_markup });
}
function debtView() {
  S.debt = S.debt.filter(x => tasks(x.k).some(t => t.id === x.id) && !day(x.k).done[x.id]);
  if (!S.debt.length) return { text: '✅ لا دَين عليك. استمر.', reply_markup: { inline_keyboard: [] } };
  const items = S.debt.slice(0, 25);
  let s = `📌 <b>الدَّين: ${tasksN(S.debt.length)} لم تتم في وقتها</b>\nسدّده قبل أن يتراكم. اضغط المهمة حين تُتمّها.\n`;
  if (S.debt.length >= CFG.debtAlarm) s += `\n🚨 الدين كبير. خصّص يوم الجمعة لسداده.\n`;
  const kb = items.map(x => { const t = tasks(x.k).find(y => y.id === x.id); const i = tasks(x.k).indexOf(t); return [{ text: `⬜ ${fL(x.k).split('،')[0]}: ${short(t.txt)}`, callback_data: `t|${x.k}|${i}` }]; });
  return { text: s, reply_markup: { inline_keyboard: kb } };
}
async function sendDebt() { const v = debtView(); const m = await send(v.text, { reply_markup: v.reply_markup }); if (m) S.debtMsg = m.message_id; }

function stats(from, to) {
  let sch = 0, ok = 0, miss = 0, exc = 0, pg = 0, sums = 0;
  for (const k of Object.keys(S.sched).sort()) {
    if (k < from || k > to || k < (S.startedOn || TODAY) || !tasks(k).length) continue;
    const d = day(k); sch++;
    if (d.completeAt) ok++; else if (d.closed === 'excused') exc++; else if (d.closed) miss++;
    tasks(k).forEach(t => { if (d.done[t.id]) pg += t.pg || 0; });
    if (d.summary) sums++;
  }
  return { sch, ok, miss, exc, pg, sums, pct: sch ? Math.round(ok / sch * 100) : 0 };
}
function report(title, from, to) {
  const s = stats(from, to);
  const verdict = !s.sch ? 'لا أيام قراءة في هذه المدة.' : s.pct >= 90 ? '🌟 التزام ممتاز. هكذا تُبنى العقول.' : s.pct >= 70 ? '👍 مقبول، لكن لا ترضَ به. أين ضاعت الأيام الباقية؟' : '⛔ تراجع خطير. الخطة لا تعمل إلا بالمداومة، فابدأ من الغد بلا تأجيل.';
  return `📊 <b>${title}</b>\n\nأيام القراءة: ${nA(s.sch)}\n✅ أتممتها: ${nA(s.ok)}\n❌ فاتتك: ${nA(s.miss)}\n🙏 بعذر: ${nA(s.exc)}\n📖 صفحات قرأتها: ${nA(s.pg)}\n📝 خلاصات كتبتها: ${nA(s.sums)}\n\nنسبة الالتزام: <b>${nA(s.pct)}٪</b> ${bar(s.pct, 100)}\n🔥 السلسلة الحالية: ${daysN(streak())} · أفضلها: ${daysN(best())}\n📌 الدين: ${tasksN(S.debt.length)}\n\n${verdict}`;
}

/* ---------- actions ---------- */
async function markDone(k, id, val, mid) {
  const d = day(k);
  if (val) d.done[id] = true; else delete d.done[id];
  if (d.closed) { // paying a debt
    if (val) S.debt = S.debt.filter(x => !(x.k === k && x.id === id));
    else if (!S.debt.some(x => x.k === k && x.id === id)) S.debt.push({ k, id });
  }
  if (!d.closed && !d.completeAt && allDone(k)) {
    d.completeAt = Date.now();
    await refreshCard(k, mid);
    await send(`🔥 أحسنت! أتممت ورد ${k === TODAY ? 'اليوم' : fL(k)}.\nالسلسلة: <b>${daysN(streak())}</b> بلا انقطاع${S.debt.length ? `\n📌 وما زال عليك دَين ${tasksN(S.debt.length)}` : ''}`);
    return;
  }
  if (mid && mid === S.debtMsg) { const v = debtView(); await tg('editMessageText', { chat_id: S.owner, message_id: mid, text: v.text, parse_mode: 'HTML', reply_markup: v.reply_markup }); }
  else await refreshCard(k, mid);
}
async function askSummary(k) {
  S.await = { sum: k };
  await send(`✍️ <b>اكتب الآن أهم فكرة قرأتها${k === TODAY ? ' اليوم' : ' في ' + fL(k)}</b>\nسطران على الأقل (${nA(CFG.minSummaryWords)} كلمات فأكثر). لن تُحسب المهمة بدونها.`, { reply_markup: { force_reply: true, input_field_placeholder: 'أهم فكرة…' } });
}
async function onCallback(q) {
  tg('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
  const [a, k, i] = (q.data || '').split('|'), mid = q.message && q.message.message_id;
  if (!S.sched[k]) return send('هذا اليوم خارج المدى المحفوظ.');
  if (a === 't') {
    const t = tasks(k)[+i]; if (!t) return;
    if (t.id === 'sum' && !day(k).done.sum) return askSummary(k);
    return markDone(k, t.id, !day(k).done[t.id], mid);
  }
  if (a === 'a') {
    const d = day(k);
    tasks(k).forEach(t => { if (t.id !== 'sum') d.done[t.id] = true; });
    if (tasks(k).some(t => t.id === 'sum') && !d.done.sum) { await refreshCard(k, mid); return askSummary(k); }
    return markDone(k, tasks(k).find(t => t.id !== 'sum').id, true, mid);
  }
}
async function onDocument(m) {
  const doc = m.document;
  if (!/\.json$/i.test(doc.file_name || '')) return send('أرسل ملف التقدّم (.json) المصدَّر من التطبيق: الإعدادات ← تصدير التقدّم.');
  const f = await tg('getFile', { file_id: doc.file_id });
  if (!f) return send('تعذّر تنزيل الملف.');
  let o; try { o = await (await fetch(`${BASE}/file/bot${TOKEN}/${f.file_path}`)).json(); } catch (e) { return send('الملف غير صالح.'); }
  const keep = {}; for (const [k, v] of Object.entries(o)) if (k.startsWith('manhaj') && !['manhaj-notes', 'manhaj-tab2', 'manhaj-theme'].includes(k) && typeof v === 'string') keep[k] = v;
  if (!Object.keys(keep).length) return send('لم أجد في الملف إعدادات للخطة.');
  S.settings = keep;
  // take over what was ticked in the app
  try { const td = JSON.parse(keep['manhaj-todo'] || '{}'); for (const [k, v] of Object.entries(td)) if (v && v.done) Object.assign(day(k).done, v.done); } catch (e) {}
  await ensureSchedule(true);
  await send(`✅ تم تحديث جدولك وفق إعداداتك في التطبيق (الصفحات والسرعة والامتحانات وأيام الأدب).\nنهاية النواة: ${S.fin ? fL(S.fin) + ' ' + (+S.fin.slice(0, 4)).toLocaleString('ar-EG', { useGrouping: false }) : '—'}`);
  const k = openDay(); if (k) await sendCard(k);
}
async function sendBackup() {
  const o = { ...S.settings };
  const td = (() => { try { return JSON.parse(o['manhaj-todo'] || '{}'); } catch (e) { return {}; } })();
  const dd = (() => { try { return JSON.parse(o['manhaj-daydone'] || '{}'); } catch (e) { return {}; } })();
  for (const [k, d] of Object.entries(S.days)) {
    if (!d.done || !Object.keys(d.done).length) continue;
    td[k] = { custom: (td[k] && td[k].custom) || [], done: { ...((td[k] && td[k].done) || {}), ...d.done } };
    if (d.completeAt) dd[k] = true;
  }
  o['manhaj-todo'] = JSON.stringify(td); o['manhaj-daydone'] = JSON.stringify(dd);
  const fd = new FormData();
  fd.append('chat_id', String(S.owner));
  fd.append('caption', 'افتح التطبيق ← الإعدادات ← «استيراد ملف تقدّم» واختر هذا الملف، فتظهر علامات البوت في التطبيق.');
  fd.append('document', new Blob([JSON.stringify(o)], { type: 'application/json' }), `taqaddum-manhaj-${TODAY}.json`);
  await fetch(`${BASE}/bot${TOKEN}/sendDocument`, { method: 'POST', body: fd }).catch(e => console.error('sendDocument', e.message));
}
async function excuse(reason) {
  const mo = TODAY.slice(0, 7), used = S.excuses[mo] || 0;
  const k = openDay();
  if (!k || day(k).closed) return send('لا يوجد يوم قراءة مفتوح الآن.');
  if (day(k).completeAt) return send('أتممت ورد هذا اليوم فلا حاجة لعذر.');
  if (day(k).excused) return send('سجّلت عذرًا لهذا اليوم من قبل.');
  if (used >= CFG.excusesPerMonth) return send(`⛔ استنفدت أعذار هذا الشهر (${nA(CFG.excusesPerMonth)}). العذر لا يكون عادة.\nأتمّ ما تستطيع الآن، ولو صفحات قليلة.`);
  day(k).excused = reason; S.excuses[mo] = used + 1;
  await send(`🙏 قُبل العذر: «${esc(reason)}».\nلن تنكسر سلسلتك، لكن مهام اليوم تصير دَينًا إن لم تُتمّها.\nبقي لك ${nA(CFG.excusesPerMonth - used - 1)} عذر هذا الشهر.`);
}
const RULES = `<b>نظام المتابعة</b>
• ${nA(CFG.morning)} صباحًا يصلك ورد اليوم من الخطة نفسها (الصفحات والمسموع).
• اضغط كل مهمة حين تُتمّها. مهمة «أهم فكرة» لا تُحسب إلا إذا كتبت سطرين.
• إن لم تُتمّ الورد يصلك تذكير الساعة ٣ عصرًا، ثم ٨ مساءً، ثم ١٠:٣٠، ثم إنذار أخير ١١:٣٠.
• يُغلق اليوم الساعة ${nA(CFG.close)} بعد منتصف الليل: ما لم يتم يصير <b>دَينًا</b> يلاحقك كل صباح، و<b>تنكسر سلسلتك</b>.
• لك ${nA(CFG.excusesPerMonth)} عذر فقط في الشهر: يحمي السلسلة، لكن المهام تبقى دَينًا.
• كل جمعة يصلك تقرير الأسبوع ونسبة التزامك.
• «💾 نسخة للتطبيق» ترسل لك ملفًّا تستورده في التطبيق فتظهر فيه علاماتك. وإن غيّرت إعداداتك في التطبيق فأرسل لي ملف «تصدير التقدّم» ليتطابق الجدول.
⏱️ يرد البوت خلال دقائق، لا فورًا.`;

async function onMessage(m) {
  const txt = (m.text || '').trim();
  if (m.document) return onDocument(m);
  if (/^\/start/.test(txt)) {
    S.startedOn ||= TODAY;
    await tg('setMyCommands', { commands: [{ command: 'today', description: 'ورد اليوم' }, { command: 'debt', description: 'الدَّين' }, { command: 'report', description: 'تقريري' }, { command: 'excuse', description: 'عذر (اكتب السبب بعده)' }, { command: 'backup', description: 'نسخة للتطبيق' }, { command: 'help', description: 'نظام المتابعة' }] });
    await send(`السلام عليكم 👋\nأنا متابِعك اليومي في «منهج البناء الفكري». سأكون صارمًا معك.\n\n${RULES}`, { reply_markup: MENU });
    const k = openDay();
    if (k) await sendCard(k); else { const nx = Object.keys(S.sched).sort().find(x => x > TODAY && tasks(x).length); await send(`اليوم لا ورد عليك (${esc((S.sched[TODAY] || {}).why || '')}).${nx ? `\nأول ورد: ${fL(nx)}.` : ''}`); }
    return;
  }
  if (S.await && S.await.sum && txt && !txt.startsWith('/') && !/^(📋|📌|📊|🙏|💾)/.test(txt)) {
    const k = S.await.sum, words = txt.split(/\s+/).filter(Boolean).length;
    if (words < CFG.minSummaryWords) return send(`قصيرة جدًّا (${words <= 10 && words > 2 ? nA(words) + ' كلمات' : nA(words) + ' كلمة'}). اكتب ${nA(CFG.minSummaryWords)} كلمات على الأقل: ما الفكرة؟ ولماذا هي مهمة؟`, { reply_markup: { force_reply: true } });
    day(k).summary = txt.slice(0, 1500); S.await = null;
    await send('📝 حُفظت خلاصتك.', { reply_markup: MENU });
    return markDone(k, 'sum', true);
  }
  if (S.await && S.await.excuse && txt && !txt.startsWith('/') && !/^(📋|📌|📊|🙏|💾)/.test(txt)) { S.await = null; return excuse(txt.slice(0, 200)); }
  if (/^\/today|^📋/.test(txt)) { const k = openDay(); if (k) return sendCard(k); const nx = Object.keys(S.sched).sort().find(x => x > TODAY && tasks(x).length); return send(`لا ورد اليوم: ${esc((S.sched[TODAY] || {}).why || 'إجازة')}.${nx ? `\nالورد القادم: ${fL(nx)}.` : ''}${S.debt.length ? `\n📌 لكن عليك دَين ${tasksN(S.debt.length)}، وهذا وقت سداده.` : ''}`); }
  if (/^\/debt|^📌/.test(txt)) return sendDebt();
  if (/^\/report|^📊/.test(txt)) return send(report('تقريرك آخر ٣٠ يومًا', addDays(TODAY, -29), TODAY));
  if (/^\/excuse|^🙏/.test(txt)) { const r = txt.replace(/^\/excuse(@\w+)?|^🙏\s*عذر/, '').trim(); if (r) return excuse(r.slice(0, 200)); S.await = { excuse: true }; return send('ما عذرك اليوم؟ اكتبه في رسالة.', { reply_markup: { force_reply: true } }); }
  if (/^\/backup|^💾/.test(txt)) return sendBackup();
  if (/^\/help/.test(txt)) return send(RULES, { reply_markup: MENU });
  return send('استخدم الأزرار بالأسفل 👇', { reply_markup: MENU });
}

/* ---------- scheduled duties ---------- */
const REM = [
  n => `⏰ تذكير: لم تُنهِ ورد اليوم بعد. باقٍ ${tasksN(n)}.`,
  n => `⚠️ الساعة ٨ مساءً، وورد اليوم لم يتم (باقٍ ${tasksN(n)}). ابدأ الآن ولو بنصفه.`,
  n => `🚨 الوقت يضيق. إن لم تُتمّ الباقي (${tasksN(n)}) قبل الساعة ${nA(CFG.close)} صار دَينًا وانكسرت سلسلتك (${daysN(streak())}).`,
  n => `⛔ <b>إنذار أخير</b>: باقٍ ${tasksN(n)}. هذا وردك:`,
];
async function duties() {
  // 1) days that just closed unfinished
  const missed = Object.keys(S.days).filter(k => S.days[k].justMissed).sort();
  if (missed.length) {
    missed.forEach(k => delete S.days[k].justMissed);
    if (day(missed[missed.length - 1]).msg) await refreshCard(missed[missed.length - 1]);
    const exc = missed.every(k => day(k).closed === 'excused');
    const names = missed.map(k => fL(k).split('،')[0] + (day(k).closed === 'excused' ? ' (بعذر)' : '')).join('، ');
    await send(exc ? `🙏 أُغلق اليوم بعذر. ما لم يتم صار دَينًا (${tasksN(S.debt.length)}).` : `❌ <b>فاتك ورد: ${names}.</b>\nانكسرت السلسلة، وصار الباقي دَينًا عليك: ${tasksN(S.debt.length)}.\nلا تجعل يومين يفوتانك متتاليين.`);
  }
  // 2) morning card
  const t = tasks(TODAY), d = day(TODAY);
  if (t.length && !d.sent && N.hour >= CFG.morning) {
    let pre = `صباح الخير ☀️\n`;
    if (S.debt.length) pre += `📌 عليك دَين ${tasksN(S.debt.length)} من أيام سابقة: اضغط «📌 الدَّين».\n${S.debt.length >= CFG.debtAlarm ? '🚨 الدين يتراكم، ولن تلحق إن تركته.\n' : ''}`;
    await sendCard(TODAY, pre + '\n');
  }
  // 3) escalating reminders
  if (t.length && d.sent && !d.completeAt && !d.closed) {
    const due = CFG.reminders.map((h, i) => i).filter(i => N.hour >= CFG.reminders[i] && !d.rem[i]);
    if (due.length) {
      due.forEach(i => d.rem[i] = true);
      const i = due[due.length - 1], left = t.filter(x => !d.done[x.id]).length;
      if (i === CFG.reminders.length - 1) await sendCard(TODAY, REM[i](left) + '\n\n'); else await send(REM[i](left));
    }
  }
  // 4) weekly report
  if (dow(TODAY) === CFG.weeklyDay && N.hour >= CFG.weeklyHour && S.lastWeekly !== TODAY) {
    S.lastWeekly = TODAY;
    await send(report('تقرير الأسبوع', addDays(TODAY, -7), YDAY) + (S.debt.length ? '\n\nاليوم الجمعة إجازة من الجدول، فهو أنسب يوم لسداد الدين 👇' : ''));
    if (S.debt.length) await sendDebt();
  }
}

/* ---------- run ---------- */
await ensureSchedule(false);
const ups = (await tg('getUpdates', { offset: S.offset, timeout: 0, allowed_updates: ['message', 'callback_query'] })) || [];
for (const u of ups) {
  S.offset = u.update_id + 1;
  const m = u.message, q = u.callback_query;
  const chat = m ? m.chat.id : q && q.message ? q.message.chat.id : null;
  if (!chat) continue;
  if (!S.owner && m && /^\/start/.test(m.text || '')) S.owner = chat;
  if (chat !== S.owner) { if (m) await tg('sendMessage', { chat_id: chat, text: 'هذا بوت متابعة خاص.' }); continue; }
  try { if (m) await onMessage(m); else await onCallback(q); } catch (e) { console.error('update failed', e); }
}
if (S.owner) { closeDays(); await duties(); }
// keep the state small: drop day records older than ~13 months
for (const k of Object.keys(S.days)) if (k < addDays(TODAY, -400)) delete S.days[k];
if (JSON.stringify(S) !== BEFORE) { save(S); console.log('state saved'); if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'changed=1\n'); }
else console.log('no change');
