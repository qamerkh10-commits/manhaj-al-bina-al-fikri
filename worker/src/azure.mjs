// «القراءة الاحترافية» (28 Nov 2026, his request: «عايز نموذج OCR احترافي»): Microsoft Azure AI Vision «Read» reads a
// page image and returns every line and word with its place, so the reader lays an exact text layer over scanned pages.
// Free tier F0: 5000 pages a month, 20 calls a minute (it never bills; past the quota Azure refuses).
// Secrets (he sets them himself in Cloudflare): AZURE_VISION_KEY, AZURE_VISION_ENDPOINT (https://NAME.cognitiveservices.azure.com/).
// Image Analysis 4.0 first (one call); Read 3.2 (submit, then poll) when 4.0 is not offered in the resource's region.
export const AZ_MONTHLY = 4900;   // pages a month, kept under the free 5000

const box = pts => { const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]); const x = Math.min(...xs), y = Math.min(...ys); return [x, y, Math.max(...xs) - x, Math.max(...ys) - y] };
const fromPoly = a => box((a || []).map(p => [+p.x || 0, +p.y || 0]));                         // 4.0: [{x,y}×4]
const fromFlat = a => { const o = []; for (let i = 0; i + 1 < (a || []).length; i += 2) o.push([+a[i], +a[i + 1]]); return box(o.length ? o : [[0, 0]]) };   // 3.2: [x1,y1,…,x4,y4]
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function why(r) {
  const t = await r.text().catch(() => '');
  if (r.status === 429) return { ok: false, code: 'busy', retry: Math.min(60, +(r.headers.get('retry-after') || 10) || 10) };
  if (r.status === 401) return { ok: false, code: 'badkey', error: 'مفتاح Azure غير صحيح، أو لا يطابق عنوان الخدمة (Endpoint).' };
  if (r.status === 403 && /quota|volume/i.test(t)) return { ok: false, code: 'quota', error: 'انتهت صفحات Azure المجانية لهذا الشهر.' };
  return { ok: false, code: 'fail', status: r.status, error: 'تعذّرت القراءة من Azure (' + r.status + ').', detail: t.slice(0, 300) };
}

export async function azureRead(env, { image }) {
  const ep = String(env.AZURE_VISION_ENDPOINT || '').trim().replace(/\/+$/, ''), key = String(env.AZURE_VISION_KEY || '').trim();
  if (!ep || !key) return { ok: false, code: 'noazure' };
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ''));
  if (!m) return { ok: false, code: 'fail', error: 'لم تصل صورة الصفحة.' };
  const bin = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  const h = { 'Ocp-Apim-Subscription-Key': key, 'content-type': 'application/octet-stream' };
  // 1) Image Analysis 4.0: one call, lines and words with their polygons
  let r = await fetch(`${ep}/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read`, { method: 'POST', headers: h, body: bin });
  if (r.ok) {
    const j = await r.json(), md = j.metadata || {};
    const lines = ((j.readResult || {}).blocks || []).flatMap(b => b.lines || []).map(l => ({ text: l.text, box: fromPoly(l.boundingPolygon), words: (l.words || []).map(w => ({ text: w.text, box: fromPoly(w.boundingPolygon), c: w.confidence })) }));
    return { ok: true, engine: 'azure-4.0', w: md.width, h: md.height, lines };
  }
  if (r.status === 401 || r.status === 403 || r.status === 429) return why(r);
  const first = await why(r);
  // 2) Read 3.2 (the region has no 4.0): submit, then poll the result (the polls are free)
  r = await fetch(`${ep}/vision/v3.2/read/analyze?language=ar&readingOrder=natural`, { method: 'POST', headers: h, body: bin });
  if (r.status !== 202) { const e = await why(r); console.error('azure', first.status, first.detail, '|', e.status, e.detail); return e }
  const loc = r.headers.get('operation-location');
  for (let i = 0; i < 25; i++) {
    await sleep(i ? 1000 : 1500);
    const g = await fetch(loc, { headers: { 'Ocp-Apim-Subscription-Key': key } });
    if (g.status === 429) { await sleep(2500); continue }
    if (!g.ok) return why(g);
    const j = await g.json();
    if (j.status === 'failed') return { ok: false, code: 'fail', error: 'لم يستطع Azure قراءة الصفحة.' };
    if (j.status !== 'succeeded') continue;
    const rr = ((j.analyzeResult || {}).readResults || [])[0] || {};
    const lines = (rr.lines || []).map(l => ({ text: l.text, box: fromFlat(l.boundingBox), words: (l.words || []).map(w => ({ text: w.text, box: fromFlat(w.boundingBox), c: w.confidence })) }));
    return { ok: true, engine: 'azure-3.2', w: rr.width, h: rr.height, lines };
  }
  return { ok: false, code: 'busy', retry: 5, error: 'تأخر Azure في القراءة.' };
}
