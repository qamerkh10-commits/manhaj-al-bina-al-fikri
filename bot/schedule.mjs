// Runs the app's own scheduling engine (index.html) headless, so the bot always sends exactly what the app shows.
import fs from 'node:fs';

export async function buildSchedule(indexPath, settings, from, to) {
  const { JSDOM, VirtualConsole } = await import('jsdom');
  const html = fs.readFileSync(indexPath, 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://manhaj.local/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
    beforeParse(w) {
      for (const [k, v] of Object.entries(settings || {})) w.localStorage.setItem(k, v);
      w.HTMLElement.prototype.scrollIntoView = function () {};
      w.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
      if (w.HTMLDialogElement) w.HTMLDialogElement.prototype.showModal = function () {};
      w.scrollTo = () => {};
    },
  });
  const js = `(()=>{const o={};const e=toD(${JSON.stringify(to)});
    for(let d=toD(${JSON.stringify(from)});d<=e;d.setDate(d.getDate()+1)){const k=iso(d);const segs=DAYS[k]?DAYS[k].segs:[];
      const tasks=dayTasks(k).map(x=>{const m=/^s(\\d+)-/.exec(x.id);const g=m?segs[+m[1]]:null;return {id:x.id,txt:x.txt,pg:g&&!g.rv?(g.b-g.a+1):0}});
      o[k]={tasks,why:tasks.length?'':reason(k)}}
    return JSON.stringify({days:o,fin:FIN?iso(FIN):null})})()`;
  const out = JSON.parse(dom.window.eval(js));
  await new Promise(r => setTimeout(r, 200)); // let the page's pending async work settle before closing
  dom.window.close();
  return out;
}
