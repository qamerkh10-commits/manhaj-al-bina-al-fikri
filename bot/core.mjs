// Bot logic, independent of where it runs: Cloudflare Worker in production, Node in tests.
// makeBot() wraps one stored state; the host saves bot.state() afterwards.
import VERSES from './verses.mjs';   // motivating verses from qafiyah.com, one is added to each main message
import WISDOM from './wisdom.mjs';   // scholars' words on time and knowledge, one sent each morning
const TZ = 'Africa/Cairo';
export const CFG = {
  morning: 7,                 // the day's card is sent at 7:00
  reminders: [15, 20, 22.5, 23.5], // escalating reminders while the day is unfinished
  close: 2,                   // a day stays open until 2:00 after midnight, then what is left becomes debt
  weeklyDay: 5, weeklyHour: 9, // Friday report
  excusesPerMonth: 2,
  minSummaryWords: 8,
  debtAlarm: 8,
};

/* ---------- time & text helpers ---------- */
export function clock(d) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const g = t => p.find(x => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour: (+g('hour') % 24) + +g('minute') / 60 };
}
export const addDays = (k, n) => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const dow = k => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const nA = n => Number(n).toLocaleString('ar-EG');
const fL = k => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }); };
const tasksN = n => n === 1 ? 'مهمة واحدة' : n === 2 ? 'مهمتان' : n <= 10 ? `${nA(n)} مهام` : `${nA(n)} مهمة`;
const daysN = n => n === 1 ? 'يوم واحد' : n === 2 ? 'يومان' : n <= 10 ? `${nA(n)} أيام` : `${nA(n)} يومًا`;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function makeBot({ state, token, apiBase = 'https://api.telegram.org', now = new Date(), profile = { key: '', name: '', ns: '', admin: true } }) {
const TOKEN = token, BASE = apiBase, PNAME = profile.name || '';
const K = n => 'manhaj-' + (profile.ns ? profile.ns + '-' : '') + n;   // this person's keys in the app's storage
async function tg(method, body) {
  const r = await fetch(`${BASE}/bot${TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({ ok: false }));
  if (!j.ok && !/message is not modified|query is too old|query ID is invalid/.test(j.description || '')) console.error(method, j.description || r.status);
  return j.result;
}
const MENU_V = 5;
const COMMANDS = [{ command: 'today', description: 'ورد اليوم' }, { command: 'debt', description: 'الدَّين' }, { command: 'report', description: 'تقريري' }, { command: 'excuse', description: 'عذر (اكتب السبب بعده)' }, { command: 'backup', description: 'نسخة للتطبيق' }, { command: 'channel', description: 'قناة الملخصات' }, { command: 'books', description: 'اختر كتابًا وسجّل ملخصه' }, { command: 'alerts', description: 'مواعيد التنبيه' }, { command: 'sync', description: 'رابط ربط صفحتك بالبوت' }, { command: 'help', description: 'نظام المتابعة' }];
const MENU_RE = /^(📋|📌|📊|🙏|💾|🎙️|📚)/;
const MENU = { keyboard: [[{ text: '📋 ورد اليوم' }, { text: '📌 الدَّين' }], [{ text: '📚 اختر كتابًا' }, { text: '🎙️ القناة' }], [{ text: '📊 تقريري' }, { text: '🙏 عذر' }], [{ text: '💾 نسخة للتطبيق' }]], resize_keyboard: true, is_persistent: true };
const send = (text, extra = {}) => tg('sendMessage', { chat_id: S.owner, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

/* ---------- state ---------- */
const N = clock(now), TODAY = N.date, YDAY = addDays(TODAY, -1);
let S = Object.assign({ owner: null, offset: 0, settings: {}, sched: {}, schedKey: '', fin: null, days: {}, debt: [], excuses: {}, await: null, startedOn: null, lastWeekly: '', debtMsg: null, books: null, channel: null, sums: {}, pending: {}, indexMsgs: [], settingsVer: 0, settingsPending: false, lastUpdate: 0 }, state || {});
const C = Object.assign({}, CFG, S.alerts || {});   // this person's alert times, set from his page
const DAYN = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const fmtH = h => { const hh = Math.floor(h), mm = Math.round((h - hh) * 60), h12 = ((hh + 11) % 12) + 1; return nA(h12) + (mm ? ':' + (mm < 10 ? '٠' : '') + nA(mm) : '') + (hh < 12 ? ' ص' : ' م'); };
// "al-0700-1500-2000-2230-2330-02-5-0900": morning, four reminders (x = off), close hour, weekly day, weekly time
function parseAlerts(x) {
  const a = x.split('-'); if (a.length !== 8) return null;
  const t = v => { if (v === 'x') return null; if (!/^\d{4}$/.test(v)) return undefined; const h = +v.slice(0, 2), m = +v.slice(2); return h > 23 || m > 59 ? undefined : h + m / 60; };
  const mo = t(a[0]), rs = a.slice(1, 5).map(t), cl = +a[5], wd = +a[6], wh = t(a[7]);
  if (mo == null || rs.includes(undefined) || !(cl >= 0 && cl <= 6) || !(wd >= 0 && wd <= 6) || wh == null) return null;
  return { morning: mo, reminders: rs.filter(v => v != null && v > mo).sort((u, v) => u - v), close: cl, weeklyDay: wd, weeklyHour: wh };
}
const alertsText = title => `${title}\n☀️ ورد الصبح: ${fmtH(C.morning)}\n⏰ التذكيرات: ${C.reminders.length ? C.reminders.map(fmtH).join('، ') : 'بلا تذكيرات'}\n🌙 آخر وقت لإتمام اليوم: ${fmtH(C.close)} بعد منتصف الليل\n📊 التقرير الأسبوعي: ${DAYN[C.weeklyDay]} ${fmtH(C.weeklyHour)}\n\nتغيّرها من صفحتك: الإعدادات ← «مواعيد تنبيهات البوت».`;
const day = k => (S.days[k] ||= { done: {}, rem: {} });
/* ---------- verses: each person walks his own shuffled order of the list, so none repeats until all are seen ---------- */
const order = (n, salt) => { const a = [...Array(n).keys()]; let h = 2166136261; for (const c of (profile.key || 'x') + salt) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  for (let i = a.length - 1; i > 0; i--) { h = (Math.imul(h, 1103515245) + 12345) >>> 0; const j = h % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const VORDER = order(VERSES.length, 'v'), WORDER = order(WISDOM.length, 'w');
const nextVerse = () => { if (!VERSES.length) return -1; const n = S.vn || 0; S.vn = n + 1; return VORDER[n % VORDER.length]; };
const verseHTML = i => { const v = VERSES[i]; if (!v) return ''; return `\n\n┈┈┈┈┈┈┈┈\n<i>${esc(v.text).replace(/ … /g, '\n       ')}</i>\n— <a href="${v.url}">${esc(v.poet)}</a>`; };
const withVerse = (text, i = nextVerse()) => { const v = verseHTML(i); return v && (text + v).length < 4000 ? text + v : text; };
const sendV = (text, extra = {}) => send(withVerse(text), extra);
const wisdomHTML = () => { if (!WISDOM.length) return ''; const n = S.wn || 0; S.wn = n + 1; const w = WISDOM[WORDER[n % WORDER.length]];
  const src = `«${esc(w.book)}»${w.ref ? '، ' + esc(w.ref) : ''}`;
  return `📜 <b>${w.theme === 'الوقت' ? 'في قيمة الوقت' : 'في طلب العلم'}</b>

${esc(w.text)}

— ${esc(w.who)} · ${w.url ? `<a href="${w.url}">${src}</a>` : src}`; };
const baseTasks = k => (S.sched[k] && S.sched[k].tasks) || [];
const bookById = id => (S.books || []).find(b => b.id === id);
// once a channel is linked, finishing a book adds a task: record its summary (it is ticked only by posting one)
const tasks = k => {
  const t = baseTasks(k);
  if (!S.channel || k < S.channel.since) return t;
  const rec = t.filter(x => x.last && x.bid).map(x => { const b = bookById(x.bid); return { id: 'rec-' + x.bid, rec: x.bid, txt: `🎙️ سجّل ملخصًا صوتيًا لكتاب «${b ? b.t : x.bid}» وانشره في القناة` }; });
  return rec.length ? t.concat(rec) : t;
};

/* ---------- day logic ---------- */
const isOpen = k => tasks(k).length && !day(k).closed && (k === TODAY || (k === YDAY && N.hour < C.close));
const allDone = k => tasks(k).every(t => day(k).done[t.id]);
const openDay = () => (isOpen(YDAY) && !allDone(YDAY) ? YDAY : null) || (tasks(TODAY).length ? TODAY : null);

function closeDays() {
  if (!S.startedOn) return;
  for (const k of Object.keys(S.sched).sort()) {
    if (k < S.startedOn || k >= TODAY || (k === YDAY && N.hour < C.close)) continue;
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
  else s += `\n\n⏳ يُغلق اليوم الساعة ${fmtH(C.close)} بعد منتصف الليل.`;
  const kb = t.map((x, i) => [{ text: (d.done[x.id] ? '✅ ' : '⬜ ') + short(x.txt), callback_data: `t|${k}|${i}` }]);
  if (dn < t.length && !d.closed) kb.push([{ text: '✅ أتممت الورد كله', callback_data: `a|${k}` }]);
  if (d.vi == null) d.vi = nextVerse();   // the day's verse stays the same when the card is edited
  return { text: withVerse(s, d.vi), reply_markup: { inline_keyboard: kb } };
}
async function sendCard(k, prefix = '') {
  const c = card(k);
  const m = await send(prefix + c.text, { reply_markup: c.reply_markup });
  if (m) { day(k).msg = m.message_id; day(k).sig = JSON.stringify(tasks(k).map(t => t.id)); }
  const d = day(k);
  if (k === TODAY && !d.sent) { // first card of the day: reminders already past are skipped, so a late start sends no burst
    d.sent = true;
    C.reminders.forEach((h, i) => { if (N.hour >= h) d.rem[i] = true; });
  }
}
async function refreshCard(k, mid) {
  if (!(mid || day(k).msg)) return;
  const c = card(k);
  await tg('editMessageText', { chat_id: S.owner, message_id: mid || day(k).msg, text: c.text, parse_mode: 'HTML', reply_markup: c.reply_markup });
}
function debtView() {
  S.debt = S.debt.filter(x => tasks(x.k).some(t => t.id === x.id) && !day(x.k).done[x.id]);
  if (!S.debt.length) return { text: '✅ لا دَين عليك. استمر.', reply_markup: { inline_keyboard: [] } };
  const items = S.debt.slice(0, 25);
  let s = `📌 <b>الدَّين: ${tasksN(S.debt.length)} لم تتم في وقتها</b>\nسدّده قبل أن يتراكم. اضغط المهمة حين تُتمّها.\n`;
  if (S.debt.length >= C.debtAlarm) s += `\n🚨 الدين كبير. خصّص يوم الجمعة لسداده.\n`;
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
    await sendV(`🔥 أحسنت! أتممت ورد ${k === TODAY ? 'اليوم' : fL(k)}.\nالسلسلة: <b>${daysN(streak())}</b> بلا انقطاع${S.debt.length ? `\n📌 وما زال عليك دَين ${tasksN(S.debt.length)}` : ''}`);
    return;
  }
  if (mid && mid === S.debtMsg) { const v = debtView(); await tg('editMessageText', { chat_id: S.owner, message_id: mid, text: v.text, parse_mode: 'HTML', reply_markup: v.reply_markup }); }
  else await refreshCard(k, mid);
}
async function askSummary(k) {
  S.await = { sum: k };
  await send(`✍️ <b>اكتب الآن أهم فكرة قرأتها${k === TODAY ? ' اليوم' : ' في ' + fL(k)}</b>\nسطران على الأقل (${nA(C.minSummaryWords)} كلمات فأكثر). لن تُحسب المهمة بدونها.`, { reply_markup: { force_reply: true, input_field_placeholder: 'أهم فكرة…' } });
}
async function onCallback(q) {
  tg('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
  const [a, k, i] = (q.data || '').split('|'), mid = q.message && q.message.message_id;
  if (a === 'noop') return;
  if (a === 'k') return chooseBook(+k);
  if (a === 'L') {
    if (k === 'find') { S.await = { find: true }; return send('🔎 اكتب جزءًا من اسم الكتاب أو المؤلف:', { reply_markup: { force_reply: true, input_field_placeholder: 'اسم الكتاب…' } }); }
    const v = k === 'home' ? booksMenu() : laneView(k, +i);
    return tg('editMessageText', { chat_id: S.owner, message_id: mid, text: v.text, parse_mode: 'HTML', reply_markup: v.reply_markup });
  }
  if (a === 'b') return publish(k, +i);
  if (a === 's') { if (!S.pending[k]) return send('هذا الملخص نُشر أو أُلغي من قبل.'); S.await = { search: k }; return send('🔎 اكتب جزءًا من اسم الكتاب أو المؤلف:', { reply_markup: { force_reply: true, input_field_placeholder: 'اسم الكتاب…' } }); }
  if (a === 'x') { delete S.pending[k]; return tg('editMessageText', { chat_id: S.owner, message_id: mid, text: 'تمام، لن يُنشر.' }); }
  if (!S.sched[k]) return send('هذا اليوم خارج المدى المحفوظ.');
  if (a === 't') {
    const t = tasks(k)[+i]; if (!t) return;
    if (t.id === 'sum' && !day(k).done.sum) return askSummary(k);
    if (t.rec) { if (day(k).done[t.id]) return send('سُجّل ملخص هذا الكتاب ونُشر ✅'); if (!S.channel) return send(CHANNEL_HOWTO); S.await = { rec: t.rec }; return send(`🎙️ أرسل الآن ريكورد ملخص «${esc(plain((bookById(t.rec) || {}).t || ''))}» (أو اكتبه)، وسأنشره في القناة مباشرة.\nلا تُحسب المهمة إلا بالنشر.`); }
    return markDone(k, t.id, !day(k).done[t.id], mid);
  }
  if (a === 'a') {
    const d = day(k);
    tasks(k).forEach(t => { if (t.id !== 'sum' && !t.rec) d.done[t.id] = true; });
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
  return setSettings(o, 'file');
}
async function setSettings(o, how) {
  const keep = {}; for (const [k, v] of Object.entries(o || {})) if ((profile.ns ? k.startsWith(K('')) : k.startsWith('manhaj')) && ![K('notes'), K('tab2'), K('theme'), K('mylinks'), K('synctoken'), K('alerts')].includes(k) && typeof v === 'string') keep[k] = v;
  if (!Object.keys(keep).length) return how === 'file' ? send('لم أجد في الملف إعدادات للخطة.') : null;
  const same = JSON.stringify(keep) === JSON.stringify(S.settings || {});
  S.settings = keep;
  // what was ticked in the app counts here too
  try {
    const td = JSON.parse(keep[K('todo')] || '{}');
    for (const [k, v] of Object.entries(td)) if (v && v.done && S.sched[k]) Object.assign(day(k).done, v.done);
    for (const k of [YDAY, TODAY]) { const d = day(k); if (isOpen(k) && !d.completeAt && tasks(k).length && allDone(k)) { d.completeAt = Date.now(); await refreshCard(k); await sendV(`🔥 أحسنت! أتممت ورد ${k === TODAY ? 'اليوم' : fL(k)} (من التطبيق).\nالسلسلة: <b>${daysN(streak())}</b> بلا انقطاع`); } }
  } catch (e) {}
  if (same && how !== 'file') return;
  S.settingsVer = (S.settingsVer || 0) + 1; S.settingsPending = how;
  if (how === 'file') await send('✅ استلمت إعداداتك. سيُعاد حساب جدولك وفقها خلال ربع ساعة تقريبًا، وأخبرك حين يتم.');
}
function ensureSyncToken() {
  if (!S.syncToken) { const b = new Uint8Array(18); crypto.getRandomValues(b); S.syncToken = btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  return S.syncToken;
}
const syncLinkMsg = () => profile.url ? `🔗 <b>اربط صفحتك بالبوت (مرة واحدة)</b>\nافتح هذا الرابط من الجهاز الذي تستخدم عليه التطبيق، وبعدها أي تعديل في صفحتك (عدد الصفحات، الامتحانات، نقل الكتب، علامات المهام) يصلني تلقائيًا:\n${profile.url}#sync=${ensureSyncToken()}\n\n⚠️ هذا الرابط لك وحدك، فلا ترسله لأحد.` : '';
async function sendBackup() {
  const o = { ...S.settings };
  const td = (() => { try { return JSON.parse(o[K('todo')] || '{}'); } catch (e) { return {}; } })();
  const dd = (() => { try { return JSON.parse(o[K('daydone')] || '{}'); } catch (e) { return {}; } })();
  for (const [k, d] of Object.entries(S.days)) {
    if (!d.done || !Object.keys(d.done).length) continue;
    td[k] = { custom: (td[k] && td[k].custom) || [], done: { ...((td[k] && td[k].done) || {}), ...d.done } };
    if (d.completeAt) dd[k] = true;
  }
  o[K('todo')] = JSON.stringify(td); o[K('daydone')] = JSON.stringify(dd);
  const fd = new FormData();
  fd.append('chat_id', String(S.owner));
  fd.append('caption', 'افتح التطبيق ← الإعدادات ← «استيراد ملف تقدّم» واختر هذا الملف، فتظهر علامات البوت في التطبيق.');
  fd.append('document', new Blob([JSON.stringify(o)], { type: 'application/json' }), `taqaddum-manhaj${profile.key ? '-' + profile.key : ''}-${TODAY}.json`);
  await fetch(`${BASE}/bot${TOKEN}/sendDocument`, { method: 'POST', body: fd }).catch(e => console.error('sendDocument', e.message));
}
async function excuse(reason) {
  const mo = TODAY.slice(0, 7), used = S.excuses[mo] || 0;
  const k = openDay();
  if (!k || day(k).closed) return send('لا يوجد يوم قراءة مفتوح الآن.');
  if (day(k).completeAt) return send('أتممت ورد هذا اليوم فلا حاجة لعذر.');
  if (day(k).excused) return send('سجّلت عذرًا لهذا اليوم من قبل.');
  if (used >= C.excusesPerMonth) return send(`⛔ استنفدت أعذار هذا الشهر (${nA(C.excusesPerMonth)}). العذر لا يكون عادة.\nأتمّ ما تستطيع الآن، ولو صفحات قليلة.`);
  day(k).excused = reason; S.excuses[mo] = used + 1;
  await send(`🙏 قُبل العذر: «${esc(reason)}».\nلن تنكسر سلسلتك، لكن مهام اليوم تصير دَينًا إن لم تُتمّها.\nبقي لك ${nA(C.excusesPerMonth - used - 1)} عذر هذا الشهر.`);
}
const RULES = `<b>نظام المتابعة</b>
• الساعة ${fmtH(C.morning)} يصلك ورد اليوم من الخطة نفسها (الصفحات والمسموع).
• اضغط كل مهمة حين تُتمّها. مهمة «أهم فكرة» لا تُحسب إلا إذا كتبت سطرين.
• ${C.reminders.length ? 'إن لم تُتمّ الورد يصلك تذكير الساعة ' + C.reminders.map(fmtH).join('، ثم ') + '، والأخير إنذار ومعه الورد.' : 'لا تذكيرات خلال اليوم (أوقفتها من صفحتك).'}
• يُغلق اليوم الساعة ${fmtH(C.close)} بعد منتصف الليل: ما لم يتم يصير <b>دَينًا</b> يلاحقك كل صباح، و<b>تنكسر سلسلتك</b>.
• لك ${nA(C.excusesPerMonth)} عذر فقط في الشهر: يحمي السلسلة، لكن المهام تبقى دَينًا.
• كل ${DAYN[C.weeklyDay]} الساعة ${fmtH(C.weeklyHour)} يصلك تقرير الأسبوع ونسبة التزامك.
• ⏰ تغيّر كل هذه المواعيد من صفحتك: الإعدادات ← «مواعيد تنبيهات البوت».
• «💾 نسخة للتطبيق» ترسل لك ملفًّا تستورده في التطبيق فتظهر فيه علاماتك. وإن غيّرت إعداداتك في التطبيق فأرسل لي ملف «تصدير التقدّم» ليتطابق الجدول.
🎙️ <b>الملخصات:</b> أرسل لي ريكورد أو ملخصًا مكتوبًا، واختر الكتاب، فأنشره في قناة «ملخصات البناء الفكري» بهاشتاج الكتاب وأحدّث الفهرس المثبّت. وكلما أنهيت كتابًا أضفت مهمة «سجّل ملخصه» لا تُحسب إلا بالنشر. (زر «🎙️ القناة»)`;

async function onMessage(m) {
  const txt = (m.text || '').trim();
  if (m.forward_origin && m.forward_origin.type === 'channel') {
    const c = m.forward_origin.chat, me = await tg('getMe'), cm = me && await tg('getChatMember', { chat_id: c.id, user_id: me.id });
    if (cm && cm.status === 'administrator') return linkChannel(c);
    return send('لست مشرفًا في هذه القناة بعد.\n' + CHANNEL_HOWTO);
  }
  if (m.document && /\.json$/i.test(m.document.file_name || '')) return onDocument(m);
  if (m.voice || m.audio || m.video_note || m.video || m.document) return onSummary(m);
  if (S.await && S.await.search && txt && !txt.startsWith('/') && !MENU_RE.test(txt)) {
    const hits = searchBooks(txt), pmid = S.await.search;
    if (!hits.length) return send('لم أجد كتابًا بهذا الاسم في الخطة. جرّب كلمة أخرى من العنوان أو اسم المؤلف.', { reply_markup: { force_reply: true } });
    S.await = null; return askBook(pmid, hits, 'اختر الكتاب:');
  }
  if (S.await && S.await.find && txt && !txt.startsWith('/') && !MENU_RE.test(txt)) {
    const hits = searchBooks(txt);
    if (!hits.length) return send('لم أجد كتابًا بهذا الاسم. جرّب كلمة أخرى من العنوان أو اسم المؤلف.', { reply_markup: { force_reply: true } });
    S.await = null;
    return send('📚 اختر الكتاب:', { reply_markup: { inline_keyboard: hits.map(i => [{ text: ((S.sums[S.books[i].id] || []).length ? '✅ ' : '') + shortT(S.books[i].t), callback_data: `k|${i}` }]) } });
  }
  if (S.await && S.await.rec && txt && !txt.startsWith('/') && !MENU_RE.test(txt)) return onSummary(m);
  const al = /^\/start(?:@\w+)?\s+al-([\w-]+)/.exec(txt);
  if (al) {
    const a = parseAlerts(al[1]);
    if (!a) return send('رابط المواعيد غير صالح. افتح صفحتك ← الإعدادات ← «مواعيد تنبيهات البوت»، واضغط «احفظ وأرسل للبوت» مرة أخرى.');
    S.alerts = a; Object.assign(C, a); S.startedOn ||= TODAY;
    const d = day(TODAY); if (d.sent) C.reminders.forEach((h, i) => { d.rem[i] = N.hour >= h; });   // no burst of reminders already past
    return send(alertsText('✅ <b>حُفظت مواعيدك:</b>'), { reply_markup: MENU });
  }
  if (/^\/alerts/.test(txt)) return send(alertsText('⏰ <b>مواعيد تنبيهاتك:</b>'));
  if (/^\/sync/.test(txt)) return profile.url ? send(syncLinkMsg()) : send('المزامنة غير متاحة.');
  if (/^\/start/.test(txt)) {
    S.startedOn ||= TODAY; S.menuV = MENU_V;
    await tg('setMyCommands', { commands: COMMANDS });
    await send(`السلام عليكم${PNAME ? ' يا ' + esc(PNAME) : ''} 👋\nأنا متابِعك اليومي في «منهج البناء الفكري». سأكون صارمًا معك.\n\n${RULES}`, { reply_markup: MENU });
    const k = openDay();
    if (k) await sendCard(k); else { const nx = Object.keys(S.sched).sort().find(x => x > TODAY && tasks(x).length); await send(`اليوم لا ورد عليك (${esc((S.sched[TODAY] || {}).why || '')}).${nx ? `\nأول ورد: ${fL(nx)}.` : ''}`); }
    if (profile.url) await send(syncLinkMsg());
    return;
  }
  if (S.await && S.await.sum && txt && !txt.startsWith('/') && !MENU_RE.test(txt)) {
    const k = S.await.sum, words = txt.split(/\s+/).filter(Boolean).length;
    if (words < C.minSummaryWords) return send(`قصيرة جدًّا (${words <= 10 && words > 2 ? nA(words) + ' كلمات' : nA(words) + ' كلمة'}). اكتب ${nA(C.minSummaryWords)} كلمات على الأقل: ما الفكرة؟ ولماذا هي مهمة؟`, { reply_markup: { force_reply: true } });
    day(k).summary = txt.slice(0, 1500); S.await = null;
    await send('📝 حُفظت خلاصتك.', { reply_markup: MENU });
    return markDone(k, 'sum', true);
  }
  if (S.await && S.await.excuse && txt && !txt.startsWith('/') && !MENU_RE.test(txt)) { S.await = null; return excuse(txt.slice(0, 200)); }
  if (/^\/today|^📋/.test(txt)) { const k = openDay(); if (k) return sendCard(k); const nx = Object.keys(S.sched).sort().find(x => x > TODAY && tasks(x).length); return send(`لا ورد اليوم: ${esc((S.sched[TODAY] || {}).why || 'إجازة')}.${nx ? `\nالورد القادم: ${fL(nx)}.` : ''}${S.debt.length ? `\n📌 لكن عليك دَين ${tasksN(S.debt.length)}، وهذا وقت سداده.` : ''}`); }
  if (/^\/debt|^📌/.test(txt)) return sendDebt();
  if (/^\/report|^📊/.test(txt)) return sendV(report('تقريرك آخر ٣٠ يومًا', addDays(TODAY, -29), TODAY));
  if (/^\/excuse|^🙏/.test(txt)) { const r = txt.replace(/^\/excuse(@\w+)?|^🙏\s*عذر/, '').trim(); if (r) return excuse(r.slice(0, 200)); S.await = { excuse: true }; return send('ما عذرك اليوم؟ اكتبه في رسالة.', { reply_markup: { force_reply: true } }); }
  if (/^\/backup|^💾/.test(txt)) return sendBackup();
  if (/^\/help/.test(txt)) return send(RULES, { reply_markup: MENU });
  if (/^\/books|^📚/.test(txt)) { const v = booksMenu(); return send(v.text, { reply_markup: v.reply_markup }); }
  if (/^\/channel|^🎙️/.test(txt)) return send(S.channel ? `🎙️ القناة المربوطة: «${esc(S.channel.title)}»\nالملخصات المنشورة: ${nA(Object.values(S.sums).reduce((a, x) => a + x.length, 0))}${S.indexMsgs[0] ? `\n<a href="${postLink(S.indexMsgs[0])}">افتح الفهرس</a>` : ''}\n\nأرسل ريكورد أو ملخصًا مكتوبًا لأنشره.` : CHANNEL_HOWTO);
  if (txt.split(/\s+/).length >= 25 && !txt.startsWith('/')) return onSummary(m);
  return send('استخدم الأزرار بالأسفل 👇', { reply_markup: MENU });
}

/* ---------- book browser: pick a book, then record ---------- */
const PAGE = 8;
const laneBooks = l => (S.books || []).map((b, i) => ({ b, i })).filter(x => x.b.l === l && x.b.s).sort((x, y) => x.b.s < y.b.s ? -1 : x.b.s > y.b.s ? 1 : x.i - y.i);
function booksMenu() {
  const kb = [[{ text: '⭐ كتبي الحالية', callback_data: 'L|cur|0' }]];
  ['A', 'B', 'C', 'L'].forEach(l => kb.push([{ text: `${LANE_NAME[l]} (${nA(laneBooks(l).length)})`, callback_data: `L|${l}|-1` }]));
  kb.push([{ text: '🔎 بحث باسم الكتاب', callback_data: 'L|find|0' }]);
  return { text: '📚 <b>اختر الكتاب الذي ستسجّل ملخصه</b>\nالكتب مرتبة بترتيب الخطة، و✅ بجوار ما لخّصته.', reply_markup: { inline_keyboard: kb } };
}
function laneView(l, page) {
  const list = l === 'cur' ? currentBooks().map(id => ({ b: bookById(id), i: S.books.findIndex(x => x.id === id) })) : laneBooks(l);
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  if (page < 0) page = Math.floor(Math.max(0, list.filter(x => x.b.s && x.b.s <= TODAY).length - 1) / PAGE); // open on the page you are reading now
  page = Math.min(Math.max(0, page), pages - 1);
  const kb = list.slice(page * PAGE, page * PAGE + PAGE).map(({ b, i }) => { const n = (S.sums[b.id] || []).length; return [{ text: (n ? `✅${n > 1 ? nA(n) : ''} ` : '') + shortT(b.t), callback_data: `k|${i}` }]; });
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '▶️ السابق', callback_data: `L|${l}|${page - 1}` });
    nav.push({ text: `${nA(page + 1)} / ${nA(pages)}`, callback_data: 'noop' });
    if (page < pages - 1) nav.push({ text: 'التالي ◀️', callback_data: `L|${l}|${page + 1}` });
    kb.push(nav);
  }
  kb.push([{ text: '↩️ المسارات', callback_data: 'L|home|0' }]);
  return { text: `📚 <b>${l === 'cur' ? '⭐ كتبك الحالية' : LANE_NAME[l]}</b>\nاضغط الكتاب، ثم أرسل الريكورد.${list.length ? '' : '\n\nلا كتب هنا الآن.'}`, reply_markup: { inline_keyboard: kb } };
}
async function chooseBook(bi) {
  const b = S.books[bi];
  if (!b) return;
  if (!S.channel) return send('لم تربط قناة الملخصات بعد.\n' + CHANNEL_HOWTO);
  S.await = { rec: b.id };
  const n = (S.sums[b.id] || []).length;
  await send(`🎙️ <b>${esc(plain(b.t))}</b>${b.a ? '\n✍️ ' + esc(b.a) : ''}${n ? `\n(لك عليه ${nA(n)} ملخص، وهذا سيكون الجزء ${nA(n + 1)})` : ''}\n\nسجّل الريكورد الآن وابعته هنا، أو اكتب الملخص، وسأنشره في القناة مباشرة.`);
}

/* ---------- summaries channel ---------- */
const LANE_TAG = { A: 'الفكر_الإسلامي', B: 'العلوم_والإنسانيات', C: 'التراث_والمنطق_والكلام', L: 'الأدب' };
const LANE_NAME = { A: '📘 الفكر الإسلامي', B: '🔬 العلوم والإنسانيات', C: '🏛️ التراث والمنطق والكلام', L: '📜 الأدب' };
const plain = s => String(s).replace(/[ً-ٰٟـ]/g, '');
const norm = s => plain(s).replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').toLowerCase();
let TAGS = null;
function tagOf(id) {
  if (!TAGS) {
    TAGS = {}; const seen = {};
    const base = b => { const w = plain(b.t).replace(/[«»"']/g, '').split(/[:：(\[—–-]/)[0].replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).slice(0, 5); return w.join('_') || 'كتاب'; };
    (S.books || []).forEach(b => { const t = base(b); seen[t] = (seen[t] || 0) + 1; });
    (S.books || []).forEach(b => { let t = base(b); if (seen[t] > 1 && b.a) t += '_' + plain(b.a).replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/).slice(-1)[0]; TAGS[b.id] = '#' + t; });
  }
  return TAGS[id] || '#كتاب';
}
const postLink = mid => S.channel.username ? `https://t.me/${S.channel.username}/${mid}` : `https://t.me/c/${String(S.channel.id).replace(/^-100/, '')}/${mid}`;
const shortT = t => { const s = plain(t); return s.length > 48 ? s.slice(0, 47) + '…' : s; };
function currentBooks() {
  const seen = [];
  for (let i = 0; i <= 14 && seen.length < 6; i++) baseTasks(addDays(TODAY, -i)).forEach(t => { if (t.bid && !seen.includes(t.bid) && bookById(t.bid)) seen.push(t.bid); });
  return seen;
}
function searchBooks(q) {
  const ws = norm(q).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 1);
  if (!ws.length) return [];
  const out = [];
  (S.books || []).forEach((b, i) => { const h = norm(b.t + ' ' + b.a); if (ws.every(w => h.includes(w))) out.push(i); });
  const cur = currentBooks(); // books being read now come first, then shorter titles
  return out.sort((x, y) => (cur.includes(S.books[y].id) - cur.includes(S.books[x].id)) || S.books[x].t.length - S.books[y].t.length).slice(0, 8);
}
async function askBook(pmid, list, title) {
  const kb = list.map(i => [{ text: shortT(S.books[i].t), callback_data: `b|${pmid}|${i}` }]);
  kb.push([{ text: '🔎 كتاب آخر', callback_data: `s|${pmid}` }, { text: '❌ ليس ملخصًا', callback_data: `x|${pmid}` }]);
  await send(`🎙️ ${title}`, { reply_markup: { inline_keyboard: kb }, reply_parameters: { message_id: +pmid, allow_sending_without_reply: true } });
}
async function onSummary(m) {
  if (!S.channel) return send('لم تربط قناة الملخصات بعد.\n' + CHANNEL_HOWTO);
  const kind = m.voice ? 'voice' : m.audio ? 'audio' : m.video_note ? 'video_note' : m.video ? 'video' : m.document ? 'document' : 'text';
  const fr = m.from || {};
  S.pending[m.message_id] = { kind, text: kind === 'text' ? m.text : null, at: Date.now(), who: fr.username ? '@' + fr.username : (fr.first_name || PNAME) };
  if (S.await && S.await.rec) { const bi = S.books.findIndex(b => b.id === S.await.rec); S.await = null; if (bi >= 0) return publish(m.message_id, bi); }
  const cap = (m.caption || '').trim();
  if (cap) {
    const hits = searchBooks(cap);
    if (hits.length === 1) return publish(m.message_id, hits[0]);
    if (hits.length) return askBook(m.message_id, hits, `أكثر من كتاب يطابق «${esc(cap)}»، فأيّها تقصد؟`);
  }
  const cur = currentBooks().map(id => S.books.findIndex(b => b.id === id)).filter(i => i >= 0);
  return askBook(m.message_id, cur, cur.length ? 'هذا الملخص لأي كتاب؟ (هذه كتبك الحالية)' : 'هذا الملخص لأي كتاب؟ اضغط «🔎 كتاب آخر» واكتب اسمه.');
}
async function publish(pmid, bi) {
  const p = S.pending[pmid];
  if (!p) return send('هذا الملخص نُشر أو أُلغي من قبل.');
  const b = S.books[bi], n = (S.sums[b.id] || []).length + 1;
  const head = `${p.kind === 'text' ? '📝' : '🎙️'} <b>ملخص «${esc(plain(b.t))}»</b>${n > 1 ? ` · الجزء ${nA(n)}` : ''}\n${b.a ? '✍️ ' + esc(b.a) + '\n' : ''}${p.who ? '👤 ' + esc(p.who) + '\n' : ''}\n${tagOf(b.id)} #${LANE_TAG[b.l] || 'كتب'}`;
  let msg;
  if (p.kind === 'text') msg = await tg('sendMessage', { chat_id: S.channel.id, text: head + '\n\n' + esc(p.text).slice(0, 3700), parse_mode: 'HTML' });
  else if (p.kind === 'video_note') { msg = await tg('copyMessage', { chat_id: S.channel.id, from_chat_id: S.owner, message_id: +pmid }); if (msg) await tg('sendMessage', { chat_id: S.channel.id, text: head, parse_mode: 'HTML', reply_parameters: { message_id: msg.message_id } }); }
  else msg = await tg('copyMessage', { chat_id: S.channel.id, from_chat_id: S.owner, message_id: +pmid, caption: head, parse_mode: 'HTML' });
  if (!msg) return send('⚠️ تعذّر النشر في القناة. تأكد أن البوت ما زال مشرفًا فيها وله صلاحية «نشر الرسائل».');
  delete S.pending[pmid];
  (S.sums[b.id] ||= []).push({ m: msg.message_id, at: Date.now(), k: p.kind, by: p.who || '' });
  for (const k of Object.keys(S.sched)) { if (k > TODAY) continue; const t = tasks(k).find(x => x.rec === b.id); if (t && !day(k).done[t.id]) await markDone(k, t.id, true); }
  await updateIndex();
  await send(`✅ نُشر في القناة: <a href="${postLink(msg.message_id)}">${esc(plain(b.t))}</a>\n${tagOf(b.id)}`);
}
function indexChunks() {
  const ids = Object.keys(S.sums).filter(id => S.sums[id].length && bookById(id));
  const total = ids.reduce((a, id) => a + S.sums[id].length, 0);
  const lines = [`📚 <b>${PNAME ? 'فهرس ' + esc(PNAME) : 'فهرس ملخصات البناء الفكري'}</b>${PNAME ? ' · ملخصات البناء الفكري' : ''}\n${nA(ids.length)} كتاب · ${nA(total)} ملخص\nاضغط الرقم لتفتح الملخص، أو هاشتاج الكتاب في أي منشور لترى كل ملخصاته.`];
  for (const l of ['A', 'B', 'C', 'L']) {
    const g = ids.map(bookById).filter(b => b.l === l).sort((x, y) => plain(x.t).localeCompare(plain(y.t), 'ar'));
    if (!g.length) continue;
    lines.push(`\n<b>${LANE_NAME[l]}</b>`);
    g.forEach(b => lines.push(`• ${esc(plain(b.t))}${b.a ? ' — ' + esc(b.a) : ''}: ${S.sums[b.id].map((x, i) => `<a href="${postLink(x.m)}">${nA(i + 1)}</a>`).join(' · ')}`));
  }
  if (!ids.length) lines.push('\nلا ملخصات بعد، وأول ملخص سيظهر هنا.');
  const out = []; let cur = '';
  const vis = t => t.replace(/<[^>]+>/g, '').length;
  for (const ln of lines) { if (cur && vis(cur + '\n' + ln) > 3500) { out.push(cur); cur = ln; } else cur = cur ? cur + '\n' + ln : ln; }
  if (cur) out.push(cur);
  return out;
}
async function updateIndex() {
  if (!S.channel) return;
  const ch = indexChunks();
  for (let i = 0; i < Math.max(ch.length, S.indexMsgs.length); i++) {
    const text = ch[i] || '—';
    if (S.indexMsgs[i]) await tg('editMessageText', { chat_id: S.channel.id, message_id: S.indexMsgs[i], text, parse_mode: 'HTML', disable_web_page_preview: true });
    else {
      const m = await tg('sendMessage', { chat_id: S.channel.id, text, parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: true });
      if (m) { S.indexMsgs.push(m.message_id); await tg('pinChatMessage', { chat_id: S.channel.id, message_id: m.message_id, disable_notification: true }); }
    }
  }
}
async function linkChannel(c) {
  if (!profile.admin) return send('قناة الملخصات يربطها خالد، وأنت تنشر فيها ملخصاتك بفهرس خاص بك.');
  const same = S.channel && S.channel.id === c.id;
  S.channel = { id: c.id, title: c.title, username: c.username || null, since: same ? S.channel.since : TODAY };
  if (!same) { S.sums = {}; S.indexMsgs = []; }
  await updateIndex();
  await send(`✅ ربطت قناة «${esc(c.title)}».\nمن الآن: أرسل لي ريكورد أو ملخصًا مكتوبًا، واختر الكتاب، فأنشره في القناة بهاشتاج الكتاب وأضيفه إلى الفهرس المثبّت.\n💡 لتنشر بلا سؤال، اكتب جزءًا من اسم الكتاب في الكابشن مع الريكورد.\nوكلما أنهيت كتابًا أضفت إلى وردك مهمة «سجّل ملخصه».`);
}
async function onChatMember(u) {
  const c = u.chat;
  if (c.type !== 'channel' || !S.owner || u.from.id !== S.owner || !profile.admin) return;
  const st = u.new_chat_member.status;
  if (st === 'administrator') return linkChannel(c);
  if (S.channel && S.channel.id === c.id && ['left', 'kicked', 'member', 'restricted'].includes(st)) { S.channel = null; await send('⚠️ أُزيل البوت من القناة أو سُحب إشرافه، فتوقف نشر الملخصات. أعد إضافته مشرفًا لتعود.'); }
}
const CHANNEL_HOWTO = `<b>ربط قناة الملخصات</b>
١. في تيليجرام: ✏️ ← <b>New Channel</b>، واسمها «ملخصات البناء الفكري».
٢. افتح القناة ← اضغط اسمها بالأعلى ← <b>Administrators</b> ← <b>Add Admin</b> ← ابحث عن هذا البوت.
٣. فعّل: <b>Post Messages</b> و<b>Edit Messages of Others</b> و<b>Pin Messages</b>، ثم <b>Save</b>.
خلال دقائق يصلك تأكيد الربط. وإن لم يصل، فأعد توجيه (Forward) أي منشور من القناة إلى هنا.`;

/* ---------- scheduled duties ---------- */
const REM = [
  n => `⏰ تذكير: لم تُنهِ ورد اليوم بعد. باقٍ ${tasksN(n)}.`,
  (n, h) => `⚠️ الساعة ${fmtH(h)}، وورد اليوم لم يتم (باقٍ ${tasksN(n)}). ابدأ الآن ولو بنصفه.`,
  n => `🚨 الوقت يضيق. إن لم تُتمّ الباقي (${tasksN(n)}) قبل الساعة ${fmtH(C.close)} صار دَينًا وانكسرت سلسلتك (${daysN(streak())}).`,
  n => `⛔ <b>إنذار أخير</b>: باقٍ ${tasksN(n)}. هذا وردك:`,
];
async function duties() {
  // 0) today's tasks changed after the card was sent (a plan change): delete the outdated card and send the current one
  { const d = day(TODAY);
    if (d.sent && d.msg && !d.completeAt && !d.closed && tasks(TODAY).length && d.sig !== JSON.stringify(tasks(TODAY).map(t => t.id))) {
      await tg('deleteMessage', { chat_id: S.owner, message_id: d.msg }); d.msg = null;
      await sendCard(TODAY, '🔄 تعدّل ورد اليوم، وهذه بطاقته الجديدة:\n\n');
    } }
  // 1) days that just closed unfinished
  const missed = Object.keys(S.days).filter(k => S.days[k].justMissed).sort();
  if (missed.length) {
    missed.forEach(k => delete S.days[k].justMissed);
    if (day(missed[missed.length - 1]).msg) await refreshCard(missed[missed.length - 1]);
    const exc = missed.every(k => day(k).closed === 'excused');
    const names = missed.length > 3 ? daysN(missed.length) : missed.map(k => fL(k).split('،')[0] + (day(k).closed === 'excused' ? ' (بعذر)' : '')).join('، ');
    await sendV(exc ? `🙏 أُغلق اليوم بعذر. ما لم يتم صار دَينًا (${tasksN(S.debt.length)}).` : `❌ <b>فاتك ورد: ${names}.</b>\nانكسرت السلسلة، وصار الباقي دَينًا عليك: ${tasksN(S.debt.length)}.\nلا تجعل يومين يفوتانك متتاليين.`);
  }
  // 2) morning card
  const t = tasks(TODAY), d = day(TODAY);
  if (t.length && !d.sent && N.hour >= C.morning) {
    let pre = `صباح الخير ☀️\n`;
    if (S.debt.length) pre += `📌 عليك دَين ${tasksN(S.debt.length)} من أيام سابقة: اضغط «📌 الدَّين».\n${S.debt.length >= C.debtAlarm ? '🚨 الدين يتراكم، ولن تلحق إن تركته.\n' : ''}`;
    await sendCard(TODAY, pre + '\n');
  }
  // 2b) the day's word from the scholars (every day, reading day or not)
  if (N.hour >= C.morning && S.lastWisdom !== TODAY && WISDOM.length) { S.lastWisdom = TODAY; const w = wisdomHTML(); if (w) await send(w); }
  // 3) escalating reminders
  if (t.length && d.sent && !d.completeAt && !d.closed) {
    const due = C.reminders.map((h, i) => i).filter(i => N.hour >= C.reminders[i] && !d.rem[i]);
    if (due.length) {
      due.forEach(i => d.rem[i] = true);
      const i = due[due.length - 1], left = t.filter(x => !d.done[x.id]).length, ri = i === C.reminders.length - 1 ? 3 : Math.min(i, 2);
      if (ri === 3) await sendCard(TODAY, REM[3](left) + '\n\n'); else await sendV(REM[ri](left, C.reminders[i]));
    }
  }
  // 4) weekly report
  if (dow(TODAY) === C.weeklyDay && N.hour >= C.weeklyHour && S.lastWeekly !== TODAY) {
    S.lastWeekly = TODAY;
    await sendV(report('تقرير الأسبوع', addDays(TODAY, -7), YDAY) + (S.debt.length ? (C.weeklyDay === 5 ? '\n\nاليوم الجمعة إجازة من الجدول، فهو أنسب يوم لسداد الدين 👇' : '\n\nوهذا وقت مناسب لسداد الدين 👇') : ''));
    if (S.debt.length) await sendDebt();
  }
}

/* ---------- entry points ---------- */
async function handleUpdate(u) {
  if (u.update_id && u.update_id <= (S.lastUpdate || 0)) return; // Telegram retries a webhook it thinks failed
  if (u.update_id) S.lastUpdate = u.update_id;
  if (u.my_chat_member) return onChatMember(u.my_chat_member);
  const m = u.message, q = u.callback_query;
  const chat = m ? m.chat.id : q && q.message ? q.message.chat.id : null;
  if (!chat) return;
  if (!S.owner && m && /^\/start/.test(m.text || '')) S.owner = chat;
  if (chat !== S.owner) { if (m && m.chat.type === 'private') await tg('sendMessage', { chat_id: chat, text: 'هذا بوت متابعة خاص.' }); return; }
  closeDays();
  if (m) await onMessage(m); else await onCallback(q);
}
async function tick() {
  if (!S.owner) return;
  // Khaled's new plan starts from its beginning (23 Nov 2026): what was missed before stays in the record, no debt
  if (profile.key === 'khaled' && !S.kcoreReset) { S.kcoreReset = TODAY; S.debt = []; S.debtMsg = null; }
  // and the old week (before 23 Nov 2026) is not kept: no record, no report, no debt from it
  if (profile.key === 'khaled' && !S.kcoreReset2) { const K0 = '2026-11-23'; S.kcoreReset2 = TODAY; for (const k of Object.keys(S.sched)) if (k < K0) delete S.sched[k]; for (const k of Object.keys(S.days)) if (k < K0) delete S.days[k]; if (!S.startedOn || S.startedOn < K0) S.startedOn = K0; S.debt = S.debt.filter(x => x.k >= K0); }
  if (S.menuV !== MENU_V) {
    S.menuV = MENU_V;
    await tg('setMyCommands', { commands: COMMANDS });
    await send(`🆕 <b>تحديث:</b> صارت صفحتك على الموقع تتزامن مع البوت تلقائيًا: أي تعديل فيها (عدد صفحات كتاب، امتحان، نقل كتاب، علامة مهمة) يصلني وحده، بلا ملفات.\nيكفي أن تفتح رابطك الخاص مرة واحدة 👇`, { reply_markup: MENU });
    if (profile.url) await send(syncLinkMsg());
    if (S.channel && (S.indexMsgs || []).length) await updateIndex();
  }
  if (S.channel && !(S.indexMsgs || []).length) await updateIndex();
  closeDays();
  await duties();
  for (const [k, p] of Object.entries(S.pending)) if (Date.now() - p.at > 3 * 864e5) delete S.pending[k];
  for (const k of Object.keys(S.days)) if (k < addDays(TODAY, -400)) delete S.days[k]; // keep ~13 months of history
}
// new schedule window and book catalog, computed by the GitHub sync job from the app itself
async function applyData(data) {
  const from = Object.keys(data.days).sort()[0];
  const past = Object.fromEntries(Object.entries(S.sched).filter(([k]) => k < from && k >= addDays(TODAY, -120)));
  const sig = () => JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(i => (S.sched[addDays(TODAY, i)] || {}).tasks || []));
  const before = sig(), todayBefore = JSON.stringify(tasks(TODAY)), finBefore = S.fin;
  S.sched = { ...past, ...data.days }; S.fin = data.fin; S.books = data.books; S.schedKey = data.key; TAGS = null;
  if (S.settingsPending && data.settingsVer === S.settingsVer && S.owner) {
    const how = S.settingsPending; S.settingsPending = false;
    if (how !== 'file') {
      if (sig() === before && S.fin === finBefore) return;
      const d = day(TODAY), changedToday = JSON.stringify(tasks(TODAY)) !== todayBefore;
      await send(`🔄 تغيّر جدولك وفق تعديلاتك في صفحتك.\nنهاية النواة: ${S.fin ? fL(S.fin) + ' ' + (+S.fin.slice(0, 4)).toLocaleString('ar-EG', { useGrouping: false }) : '—'}`);
      if (changedToday && d.sent && !d.completeAt && !d.closed) await sendCard(TODAY, 'وردك اليوم بعد التعديل:\n\n');
      return;
    }
    await send(`✅ تم تحديث جدولك وفق إعداداتك في التطبيق (الصفحات والسرعة والامتحانات وأيام الأدب).\nنهاية النواة: ${S.fin ? fL(S.fin) + ' ' + (+S.fin.slice(0, 4)).toLocaleString('ar-EG', { useGrouping: false }) : '—'}`);
    const k = openDay(); if (k) await sendCard(k);
  }
}
return { handleUpdate, tick, applyData, prefs: o => setSettings(o, 'auto'), state: () => S };
}
