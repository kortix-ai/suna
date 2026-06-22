import { Glob } from "bun";
import { resolve, dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { discoverFlows } from "./runner";
import { allFlows } from "./flow";

const FLOWS_DIR = resolve(import.meta.dir, "../flows");

export interface CatalogFlow {
  id: string;
  domain: string;
  tags: string[];
  requires: string[];
  todo: string | null;
  routes: string[];
  steps: string[];
}

export interface Catalog {
  totalFlows: number;
  totalSteps: number;
  totalRoutes: number;
  domains: { name: string; flows: CatalogFlow[] }[];
}

async function stepsByFlowId(): Promise<Map<string, string[]>> {
  const byId = new Map<string, string[]>();
  const glob = new Glob("*.flow.ts");
  const files: string[] = [];
  for await (const f of glob.scan({ cwd: FLOWS_DIR, absolute: true })) files.push(f);
  files.sort();
  const token = /flow\(\s*["'`]([A-Za-z0-9_.-]+)["'`]|(?:ctx\.)?step\(\s*["'`]([^"'`]+)["'`]/g;
  for (const file of files) {
    const text = await Bun.file(file).text();
    let current = "";
    let m: RegExpExecArray | null;
    token.lastIndex = 0;
    while ((m = token.exec(text)) !== null) {
      if (m[1] !== undefined) {
        current = m[1];
        if (!byId.has(current)) byId.set(current, []);
      } else if (m[2] !== undefined && current) {
        byId.get(current)!.push(m[2]);
      }
    }
  }
  return byId;
}

export async function buildCatalog(): Promise<Catalog> {
  await discoverFlows();
  const steps = await stepsByFlowId();
  const flows = allFlows();

  const byDomain = new Map<string, CatalogFlow[]>();
  const routeSet = new Set<string>();
  let totalSteps = 0;

  for (const f of flows) {
    const routes = f.meta.routes ?? [];
    for (const r of routes) routeSet.add(r.toUpperCase());
    const s = steps.get(f.id) ?? [];
    totalSteps += s.length;
    const entry: CatalogFlow = {
      id: f.id,
      domain: f.meta.domain,
      tags: f.meta.tags ?? [],
      requires: f.meta.requires ?? [],
      todo: f.meta.todo ?? null,
      routes,
      steps: s,
    };
    if (!byDomain.has(f.meta.domain)) byDomain.set(f.meta.domain, []);
    byDomain.get(f.meta.domain)!.push(entry);
  }

  const domains = [...byDomain.entries()]
    .map(([name, fs]) => ({
      name,
      flows: fs.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    totalFlows: flows.length,
    totalSteps,
    totalRoutes: routeSet.size,
    domains,
  };
}

export function renderCatalogHtml(cat: Catalog): string {
  const data = JSON.stringify(cat).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ke2e catalog — ${cat.totalFlows} flows</title>
<style>
:root{--bg:#0b0d10;--panel:#14181d;--mut:#8a94a6;--line:#222a33;--acc:#4493f8;--ok:#2ea043;--warn:#d29922;--fg:#e6edf3}
*{box-sizing:border-box}body{margin:0;font:13px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:18px 22px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:3}
h1{font-size:16px;margin:0 0 8px}
.stats{display:flex;gap:18px;flex-wrap:wrap;color:var(--mut);font-size:12px}
.stats b{color:var(--fg);font-size:15px}
.search{margin-top:12px;width:100%;max-width:520px;padding:8px 11px;border-radius:8px;border:1px solid var(--line);background:#0d1117;color:var(--fg);font-size:13px}
main{padding:14px 22px;max-width:1100px}
.dom{margin:18px 0 8px;font-size:13px;font-weight:700;color:var(--acc);text-transform:uppercase;letter-spacing:.04em}
.dom span{color:var(--mut);font-weight:400;text-transform:none;letter-spacing:0;margin-left:8px}
details{border:1px solid var(--line);border-radius:8px;margin:6px 0;background:var(--panel)}
summary{padding:10px 13px;cursor:pointer;list-style:none;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
summary::-webkit-details-marker{display:none}
.id{font-weight:700;font-family:ui-monospace,Menlo,monospace}
.badge{font-size:10px;padding:1px 7px;border-radius:20px;border:1px solid var(--line);color:var(--mut)}
.badge.tag{color:var(--acc);border-color:rgba(68,147,248,.4)}
.badge.req{color:var(--warn);border-color:rgba(210,153,34,.4)}
.badge.todo{color:var(--warn);background:rgba(210,153,34,.12)}
.count{margin-left:auto;color:var(--mut);font-size:11px}
.body{padding:4px 14px 12px;border-top:1px solid var(--line)}
.lbl{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin:10px 0 4px}
.route{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--fg);padding:2px 0}
.route .m{display:inline-block;width:58px;color:var(--acc);font-weight:700}
ol{margin:4px 0;padding-left:22px}li{margin:3px 0}
.empty{color:var(--mut);font-style:italic}
.hidden{display:none}
</style></head><body>
<header>
<h1>ke2e — end-to-end test catalog</h1>
<div class="stats">
<span><b>${cat.totalFlows}</b> flows</span>
<span><b>${cat.totalSteps}</b> asserted cases</span>
<span><b>${cat.totalRoutes}</b> routes covered</span>
<span><b>${cat.domains.length}</b> domains</span>
</div>
<input class="search" id="q" placeholder="filter by id, domain, route, step, tag…" autocomplete="off">
</header>
<main id="root"></main>
<script>
const CAT = JSON.parse(${JSON.stringify(data)});
const root = document.getElementById('root');
function badge(t,c){const s=document.createElement('span');s.className='badge '+(c||'');s.textContent=t;return s;}
function render(filter){
  root.innerHTML='';
  const f=(filter||'').toLowerCase();
  for(const dom of CAT.domains){
    const matches=dom.flows.filter(fl=>{
      if(!f)return true;
      const hay=[fl.id,fl.domain,...(fl.tags||[]),...(fl.routes||[]),...(fl.steps||[]),fl.todo||''].join(' ').toLowerCase();
      return hay.includes(f);
    });
    if(!matches.length)continue;
    const h=document.createElement('div');h.className='dom';
    h.innerHTML=dom.name+' <span>'+matches.length+' flow'+(matches.length>1?'s':'')+'</span>';
    root.appendChild(h);
    for(const fl of matches){
      const d=document.createElement('details');if(f)d.open=true;
      const s=document.createElement('summary');
      const id=document.createElement('span');id.className='id';id.textContent=fl.id;s.appendChild(id);
      for(const t of fl.tags||[])s.appendChild(badge(t,'tag'));
      for(const r of fl.requires||[])s.appendChild(badge('needs:'+r,'req'));
      if(fl.todo)s.appendChild(badge('todo','todo'));
      const c=document.createElement('span');c.className='count';
      c.textContent=(fl.steps.length||0)+' cases · '+(fl.routes.length||0)+' routes';s.appendChild(c);
      d.appendChild(s);
      const b=document.createElement('div');b.className='body';
      if(fl.todo){const td=document.createElement('div');td.className='empty';td.textContent='todo: '+fl.todo;b.appendChild(td);}
      if(fl.routes.length){const l=document.createElement('div');l.className='lbl';l.textContent='routes';b.appendChild(l);
        for(const r of fl.routes){const sp=r.split(/\\s+/);const rd=document.createElement('div');rd.className='route';
          rd.innerHTML='<span class="m">'+(sp[0]||'')+'</span>'+(sp.slice(1).join(' '));b.appendChild(rd);}}
      const l2=document.createElement('div');l2.className='lbl';l2.textContent='cases ('+fl.steps.length+')';b.appendChild(l2);
      if(fl.steps.length){const ol=document.createElement('ol');
        for(const st of fl.steps){const li=document.createElement('li');li.textContent=st;ol.appendChild(li);}b.appendChild(ol);}
      else{const e=document.createElement('div');e.className='empty';e.textContent='driven via CLI binary or external callback (no inline steps)';b.appendChild(e);}
      d.appendChild(b);root.appendChild(d);
    }
  }
  if(!root.children.length){const e=document.createElement('div');e.className='empty';e.textContent='no flows match "'+filter+'"';root.appendChild(e);}
}
document.getElementById('q').addEventListener('input',e=>render(e.target.value));
render('');
</script>
</body></html>`;
}

export async function writeCatalog(outPath: string): Promise<Catalog> {
  const cat = await buildCatalog();
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, renderCatalogHtml(cat));
  return cat;
}
