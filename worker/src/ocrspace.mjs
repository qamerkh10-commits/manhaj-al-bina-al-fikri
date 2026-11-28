// «القراءة الاحترافية» through OCR.space (28 Nov 2026: he has no credit card for Azure; OCR.space's free key needs only an
// email). Engine 3 read a scanned Arabic page with its diacritics correctly in a test (it once added a word, so the reader
// tells him to check what he quotes). It gives each line with its place; the reader spreads the line's words over it.
// Free plan: 25,000 pages a month, 500 a day, images up to 1MB. Secret (he sets it himself in Cloudflare): OCRSPACE_KEY.
// proRead(): Azure when its key is set (it knows every word's place), else OCR.space.
import { azureRead } from './azure.mjs';

export const OS_DAILY = 480, OS_MONTHLY = 24000;   // kept under the free 500 a day / 25,000 a month
export const proEngine = env => (env.AZURE_VISION_KEY && env.AZURE_VISION_ENDPOINT) ? 'azure' : env.OCRSPACE_KEY ? 'ocrspace' : '';

export async function ocrSpace(env, { image }) {
  const key = String(env.OCRSPACE_KEY || '').trim();
  if (!key) return { ok: false, code: 'noazure' };
  if (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(String(image || ''))) return { ok: false, code: 'fail', error: 'لم تصل صورة الصفحة.' };
  const f = new FormData();
  f.append('apikey', key); f.append('base64Image', image); f.append('language', 'ara'); f.append('OCREngine', '3');
  f.append('isOverlayRequired', 'true'); f.append('detectOrientation', 'false'); f.append('scale', 'false');
  let r;
  try { r = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body: f }) } catch (e) { return { ok: false, code: 'busy', retry: 8 } }
  const t = await r.text(); let j = null; try { j = JSON.parse(t) } catch (e) { }
  const msg = j ? [].concat(j.ErrorMessage || [], j.ErrorDetails || []).join(' ') : t.slice(0, 300);
  if (/api ?key|apikey/i.test(msg) && /invalid|not valid|wrong/i.test(msg)) return { ok: false, code: 'badkey', error: 'مفتاح OCR.space غير صحيح.' };
  if (/maximum|times within|limit/i.test(msg) || r.status === 429) return { ok: false, code: 'quota', error: 'انتهت صفحات OCR.space المجانية لليوم.' };
  if (r.status === 401 || r.status === 403) return { ok: false, code: 'badkey', error: 'مفتاح OCR.space غير صحيح أو غير مفعّل بعد (افتح رابط التفعيل في بريدك).' };
  if (!r.ok || !j || j.IsErroredOnProcessing) { console.error('ocrspace', r.status, msg.slice(0, 300)); return { ok: false, code: /timed? ?out|E101|busy/i.test(msg) || r.status >= 500 ? 'busy' : 'fail', retry: 8, error: 'تعذّرت القراءة من OCR.space.' } }
  const res = (j.ParsedResults || [])[0] || {}, L = ((res.TextOverlay || {}).Lines) || [];
  const bx = w => [+w.Left || 0, +w.Top || 0, +w.Width || 0, +w.Height || 0];
  const lines = L.map(l => {
    const ws = (l.Words || []).filter(w => String(w.WordText || '').trim()).map(w => ({ text: String(w.WordText).trim(), box: bx(w) }));
    if (!ws.length) return null;
    const x0 = Math.min(...ws.map(w => w.box[0])), y0 = Math.min(...ws.map(w => w.box[1])), x1 = Math.max(...ws.map(w => w.box[0] + w.box[2])), y1 = Math.max(...ws.map(w => w.box[1] + w.box[3]));
    return { text: String(l.LineText || ws.map(w => w.text).join(' ')).trim(), box: [x0, y0, x1 - x0, y1 - y0], words: ws };
  }).filter(Boolean);
  return { ok: true, engine: 'OCR.space', lines, text: String(res.ParsedText || '').trim() };
}

export async function proRead(env, { image }) {
  const e = proEngine(env);
  if (e === 'azure') { const r = await azureRead(env, { image }); if (r.ok) r.engine = 'Azure'; return r }
  if (e === 'ocrspace') return ocrSpace(env, { image });
  return { ok: false, code: 'noazure' };
}
