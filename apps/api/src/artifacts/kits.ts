// The artifact types and their kits. An artifact is always HTML; its type picks
// the kit (one <style> + one <script>) the content server injects into the
// entry page, so an author writes plain semantic HTML and gets a document, a
// deck, a design board or a dashboard. `page` gets no kit. The kits are the
// format contract: `ARTIFACT_TYPES[].format` documents them for agents (the
// kortix-artifacts skill and `kortix artifacts types`), and `starter` is a
// complete example and the "start blank" template.
//
// Every injected node carries `data-kortix-kit`, so the doc editor strips them
// before it saves. Kit scripts talk to the embedding Kortix page with
// postMessage `{ kortix: 'artifact', op, ... }`; the page is a cross-origin
// sandbox (CSP `sandbox`, no same-origin), so nothing else crosses.

export const ARTIFACT_TYPE_KEYS = ['page', 'doc', 'slides', 'board', 'dashboard'] as const;
export type ArtifactType = (typeof ARTIFACT_TYPE_KEYS)[number];

const BASE = String.raw`
:root{color-scheme:light dark;--k-bg:#fff;--k-fg:#1f1f1f;--k-muted:#666;--k-border:#e2e2e2;--k-card:#f6f6f5;--k-code:#f2f2f1;--k-accent:#0099ff;
--k-green:#199338;--k-red:#e5484d;--k-orange:#d18b19;--k-purple:#ab80d6;--k-yellow:#cca300;--k-blue:#2b91f7;
--k-sans:ui-sans-serif,-apple-system,'Segoe UI','Helvetica Neue','Noto Sans',sans-serif;
--k-serif:ui-serif,'New York','Iowan Old Style',Charter,Georgia,serif;
--k-mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--k-bg:#161616;--k-fg:#ececec;--k-muted:#a0a0a0;--k-border:#2e2e2e;--k-card:#1e1e1e;--k-code:#232323}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
`;

const DOC_CSS = String.raw`
html{background:var(--k-bg);color:var(--k-fg);font:16px/1.65 var(--k-sans)}
body{max-width:740px;margin:0 auto;padding:72px 24px 128px;outline:none}
h1{font:600 2.5rem/1.15 var(--k-serif);letter-spacing:-.02em;margin:0 0 .5rem}
h2{font:600 1.65rem/1.25 var(--k-serif);letter-spacing:-.01em;margin:3rem 0 .75rem}
h3{font:600 1.15rem/1.35 var(--k-sans);margin:2rem 0 .5rem}
h4{font:600 1rem/1.4 var(--k-sans);margin:1.5rem 0 .4rem}
p,ul,ol,dl{margin:0 0 1rem}
ul,ol{padding-left:1.5rem}li{margin:.25rem 0}li>ul,li>ol{margin:.25rem 0 0}
strong{font-weight:600}
a{color:var(--k-accent);text-underline-offset:2px}
.byline,.meta{color:var(--k-muted);font-size:.875rem;margin:0 0 2rem;display:flex;gap:.5rem;flex-wrap:wrap}
.lede{font-size:1.15rem;line-height:1.6;color:var(--k-fg)}
blockquote{margin:0 0 1rem;padding:.1rem 0 .1rem 1rem;border-left:3px solid var(--k-border);color:var(--k-muted)}
aside,.callout{background:var(--k-card);border:1px solid var(--k-border);border-radius:10px;padding:.9rem 1.1rem;margin:0 0 1rem}
aside>:last-child,.callout>:last-child{margin-bottom:0}
code{font:.88em var(--k-mono);background:var(--k-code);padding:.12em .35em;border-radius:5px}
pre{background:var(--k-code);border-radius:10px;padding:1rem 1.1rem;overflow:auto;font-size:.82rem;line-height:1.55;margin:0 0 1rem}
pre code{background:none;padding:0;font-size:inherit}
table{width:100%;border-collapse:collapse;font-size:.9rem;margin:0 0 1.25rem}
th,td{border:1px solid var(--k-border);padding:.5rem .75rem;text-align:left;vertical-align:top}
th{background:var(--k-card);font-weight:500}
hr{border:0;border-top:1px solid var(--k-border);margin:2.5rem 0}
img,svg,video,canvas{max-width:100%;height:auto}
figure{margin:1.75rem 0}figcaption{color:var(--k-muted);font-size:.82rem;margin-top:.5rem}
.wide{width:min(1100px,calc(100vw - 48px));position:relative;left:50%;transform:translateX(-50%)}
kbd{font:.8em var(--k-mono);border:1px solid var(--k-border);border-bottom-width:2px;border-radius:4px;padding:.05em .35em}
body[contenteditable=true]{caret-color:var(--k-accent)}
body[contenteditable=true] :focus{outline:none}
@media (max-width:640px){body{padding:40px 16px 96px}h1{font-size:2rem}table{display:block;overflow-x:auto}}
@media print{body{padding:0;max-width:none}a{color:inherit}}
`;

// Edit bridge: the Kortix page turns editing on, runs formatting commands, and
// asks for the edited HTML. The answer drops every injected kit node.
const DOC_JS = String.raw`
(function(){
var P=window.parent!==window?window.parent:null;
function send(m){if(P){m.kortix='artifact';P.postMessage(m,'*')}}
addEventListener('message',function(e){
  var m=e.data;if(!m||m.kortix!=='artifact'||e.source!==P)return;
  if(m.op==='edit'){document.body.contentEditable=m.on?'true':'false';if(m.on)document.body.focus()}
  else if(m.op==='exec'){document.execCommand(m.cmd,false,m.arg||null)}
  else if(m.op==='get'){
    var root=document.documentElement.cloneNode(true);
    root.querySelectorAll('[data-kortix-kit]').forEach(function(n){n.remove()});
    var b=root.querySelector('body');if(b){b.removeAttribute('contenteditable')}
    send({op:'html',id:m.id,html:'<!doctype html>\n'+root.outerHTML});
  }
});
document.addEventListener('input',function(){send({op:'dirty'})});
send({op:'ready',type:'doc',editable:true});
})();
`;

const SLIDES_CSS = String.raw`
html,body{margin:0;height:100%;overflow:hidden;background:#0d0d0d;font-family:var(--k-sans)}
body>section{position:absolute;left:50%;top:50%;width:1920px;height:1080px;padding:120px 144px;margin:0;
  transform:translate(-50%,-50%) scale(var(--k-scale,.5));display:none;flex-direction:column;justify-content:center;gap:40px;
  background:var(--k-bg);color:var(--k-fg);font-size:40px;line-height:1.4;overflow:hidden}
body>section.k-on{display:flex}
section h1{font-size:120px;line-height:1.02;letter-spacing:-.035em;font-weight:600;margin:0}
section h2{font-size:76px;line-height:1.08;letter-spacing:-.025em;font-weight:600;margin:0}
section h3{font-size:48px;line-height:1.2;font-weight:600;margin:0}
section p,section ul,section ol{margin:0;max-width:1500px}
section li{margin:.35em 0}section ul,section ol{padding-left:1.2em}
section small,section .muted{color:var(--k-muted)}
section .kicker{font:500 28px/1 var(--k-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--k-muted)}
section .big{font-size:200px;line-height:1;font-weight:600;letter-spacing:-.04em}
section code{font-family:var(--k-mono);font-size:.85em}
section pre{font:28px/1.5 var(--k-mono);background:var(--k-code);padding:40px 48px;border-radius:24px;margin:0;overflow:hidden}
section img,section svg,section video{max-width:100%;max-height:100%;object-fit:contain}
section table{border-collapse:collapse;font-size:32px}section th,section td{padding:16px 28px;border-bottom:2px solid var(--k-border);text-align:left}
section .cols{display:grid;grid-template-columns:1fr 1fr;gap:96px;align-items:center}
section .cols-3{display:grid;grid-template-columns:repeat(3,1fr);gap:64px}
section .card{background:var(--k-card);border-radius:28px;padding:48px}
section.title{justify-content:flex-end;padding-bottom:160px}
section.center{align-items:center;text-align:center}
section.dark{--k-bg:#111;--k-fg:#f4f4f4;--k-muted:#9a9a9a;--k-card:#1d1d1d;--k-code:#1d1d1d;--k-border:#333}
section.accent{--k-bg:#0099ff;--k-fg:#fff;--k-muted:rgba(255,255,255,.75);--k-card:rgba(255,255,255,.14)}
section.image{padding:0}section.image>img{width:100%;height:100%;max-width:none;max-height:none;object-fit:cover}
section aside.notes{display:none}
.k-bar{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);display:flex;align-items:center;gap:4px;padding:4px;border-radius:999px;
  background:rgba(20,20,20,.82);color:#eee;font:500 12px/1 var(--k-sans);backdrop-filter:blur(8px);transition:opacity .25s;z-index:9;user-select:none}
.k-bar button{all:unset;cursor:pointer;width:28px;height:28px;display:grid;place-items:center;border-radius:999px}
.k-bar button:hover{background:rgba(255,255,255,.12)}
.k-bar span{min-width:52px;text-align:center;font-variant-numeric:tabular-nums}
body.k-idle .k-bar{opacity:0}body.k-idle{cursor:none}
.k-prog{position:fixed;left:0;top:0;height:2px;background:#0099ff;transition:width .25s;z-index:9}
body.k-grid{overflow:auto;height:auto;display:grid;grid-template-columns:repeat(auto-fill,384px);gap:28px;padding:28px;justify-content:center}
body.k-grid>section{display:flex;position:relative;left:auto;top:auto;transform:scale(.2);transform-origin:0 0;margin:0 -1536px -864px 0;cursor:pointer;
  border-radius:40px;outline:8px solid transparent}
body.k-grid>section.k-on{outline-color:#0099ff}
body.k-grid .k-bar,body.k-grid .k-prog{display:none}
@media print{@page{size:1920px 1080px;margin:0}html,body{height:auto;overflow:visible;background:none}
  body>section{display:flex!important;position:relative;left:0;top:0;transform:none;break-after:page}.k-bar,.k-prog{display:none}}
`;

const SLIDES_JS = String.raw`
(function(){
var P=window.parent!==window?window.parent:null;
var S=[].slice.call(document.querySelectorAll('body>section'));if(!S.length)return;
var i=Math.min(S.length-1,Math.max(0,(parseInt(location.hash.slice(1),10)||1)-1));
var bar=document.createElement('div');bar.className='k-bar';bar.setAttribute('data-kortix-kit','');
bar.innerHTML='<button aria-label="Previous slide">&#8249;</button><span></span><button aria-label="Next slide">&#8250;</button><button aria-label="All slides">&#9638;</button><button aria-label="Full screen">&#10530;</button>';
var prog=document.createElement('div');prog.className='k-prog';prog.setAttribute('data-kortix-kit','');
document.body.appendChild(prog);document.body.appendChild(bar);
var b=bar.querySelectorAll('button'),label=bar.querySelector('span');
function fit(){document.documentElement.style.setProperty('--k-scale',Math.min(innerWidth/1920,innerHeight/1080))}
function show(n){i=Math.max(0,Math.min(S.length-1,n));S.forEach(function(s,k){s.classList.toggle('k-on',k===i)});
  label.textContent=(i+1)+' / '+S.length;prog.style.width=((i+1)/S.length*100)+'%';
  try{history.replaceState(null,'','#'+(i+1))}catch(e){}
  if(P)P.postMessage({kortix:'artifact',op:'slide',index:i,count:S.length},'*')}
function grid(on){document.body.classList.toggle('k-grid',on)}
function full(){var d=document;if(d.fullscreenElement){d.exitFullscreen()}else if(d.documentElement.requestFullscreen){d.documentElement.requestFullscreen().catch(function(){})}}
b[0].onclick=function(e){e.stopPropagation();show(i-1)};b[1].onclick=function(e){e.stopPropagation();show(i+1)};
b[2].onclick=function(e){e.stopPropagation();grid(true)};b[3].onclick=function(e){e.stopPropagation();full()};
addEventListener('keydown',function(e){if(e.target.isContentEditable||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;var k=e.key;
  if(k==='ArrowRight'||k==='ArrowDown'||k===' '||k==='PageDown'||k==='Enter'){e.preventDefault();grid(false);show(i+1)}
  else if(k==='ArrowLeft'||k==='ArrowUp'||k==='PageUp'||k==='Backspace'){e.preventDefault();show(i-1)}
  else if(k==='Home')show(0);else if(k==='End')show(S.length-1);
  else if(k==='f'||k==='F')full();else if(k==='g'||k==='G')grid(!document.body.classList.contains('k-grid'));
  else if(k==='Escape')grid(false)});
document.addEventListener('click',function(e){if(e.target.closest('a,button,input,textarea,select,summary,[onclick]'))return;
  var s=e.target.closest('body>section');if(document.body.classList.contains('k-grid')){if(s){grid(false);show(S.indexOf(s))}return}
  show(e.clientX<innerWidth*.3?i-1:i+1)});
var tx=0;addEventListener('touchstart',function(e){tx=e.touches[0].clientX},{passive:true});
addEventListener('touchend',function(e){var d=e.changedTouches[0].clientX-tx;if(Math.abs(d)>40)show(d<0?i+1:i-1)});
var t;function wake(){document.body.classList.remove('k-idle');clearTimeout(t);t=setTimeout(function(){document.body.classList.add('k-idle')},2200)}
addEventListener('mousemove',wake);
addEventListener('message',function(e){var m=e.data;if(!m||m.kortix!=='artifact'||e.source!==P)return;if(m.op==='goto')show(m.index)});
addEventListener('resize',fit);fit();show(i);wake();
if(P)P.postMessage({kortix:'artifact',op:'ready',type:'slides',count:S.length},'*');
})();
`;

const BOARD_CSS = String.raw`
html,body{margin:0;height:100%;overflow:hidden;font-family:var(--k-sans)}
body{background-color:#ebebea;background-image:radial-gradient(rgba(0,0,0,.13) 1px,transparent 1px);background-size:20px 20px;cursor:default;touch-action:none}
@media (prefers-color-scheme:dark){body{background-color:#1b1b1b;background-image:radial-gradient(rgba(255,255,255,.09) 1px,transparent 1px)}}
body.k-pan,body.k-pan *{cursor:grab!important}body.k-panning,body.k-panning *{cursor:grabbing!important}
.k-world{position:absolute;left:0;top:0;transform-origin:0 0;display:flex;flex-wrap:wrap;align-items:flex-start;gap:160px;padding:64px;width:max-content;max-width:7200px}
.k-frame{position:relative;flex:none}
.k-world.k-abs{display:block;width:1px;height:1px;padding:0}.k-world.k-abs>.k-frame{position:absolute}
.artboard{position:relative;background:#fff;color:#111;box-shadow:0 0 0 1px rgba(0,0,0,.06),0 8px 28px rgba(0,0,0,.08);overflow:hidden;
  font-family:var(--k-sans);color-scheme:light;width:1440px;min-height:200px}
.k-label{position:absolute;left:0;bottom:100%;margin-bottom:calc(8px * var(--k-inv,1));font:500 calc(13px * var(--k-inv,1))/1 var(--k-sans);color:#777;white-space:nowrap;
  pointer-events:auto;cursor:pointer;user-select:none}
.k-label:hover{color:#0099ff}
.k-zoom{position:fixed;right:16px;bottom:16px;display:flex;align-items:center;gap:2px;padding:4px;border-radius:10px;background:var(--k-bg);color:var(--k-fg);
  box-shadow:0 0 0 1px var(--k-border),0 4px 16px rgba(0,0,0,.08);font:500 12px/1 var(--k-sans);z-index:9;user-select:none}
.k-zoom button{all:unset;cursor:pointer;height:26px;min-width:26px;padding:0 6px;display:grid;place-items:center;border-radius:6px;box-sizing:border-box}
.k-zoom button:hover{background:var(--k-card)}.k-zoom span{min-width:44px;text-align:center;font-variant-numeric:tabular-nums}
`;

const BOARD_JS = String.raw`
(function(){
var P=window.parent!==window?window.parent:null;
var boards=[].slice.call(document.querySelectorAll('body>.artboard'));if(!boards.length)return;
var world=document.createElement('div');world.className='k-world';world.setAttribute('data-kortix-kit','');
boards[0].parentNode.insertBefore(world,boards[0]);
boards.forEach(function(a,n){var fr=document.createElement('div');fr.className='k-frame';world.appendChild(fr);
  var l=document.createElement('div');l.className='k-label';l.textContent=a.getAttribute('data-name')||('Artboard '+(n+1));
  l.onclick=function(e){e.stopPropagation();focusOn(a)};fr.appendChild(l);fr.appendChild(a);
  if(a.hasAttribute('data-x')){world.classList.add('k-abs');fr.style.left=a.getAttribute('data-x')+'px';fr.style.top=(a.getAttribute('data-y')||0)+'px'}
});
var ui=document.createElement('div');ui.className='k-zoom';ui.setAttribute('data-kortix-kit','');
ui.innerHTML='<button aria-label="Zoom out">&#8722;</button><span></span><button aria-label="Zoom in">+</button><button aria-label="Zoom to fit">Fit</button>';
document.body.appendChild(ui);var B=ui.querySelectorAll('button'),pct=ui.querySelector('span');
var z=1,x=0,y=0;
function apply(){world.style.transform='translate('+x+'px,'+y+'px) scale('+z+')';document.documentElement.style.setProperty('--k-inv',1/z);pct.textContent=Math.round(z*100)+'%'}
function zoomAt(f,cx,cy){var nz=Math.min(8,Math.max(.05,z*f));x=cx-(cx-x)*nz/z;y=cy-(cy-y)*nz/z;z=nz;apply()}
function box(els){var r=null;els.forEach(function(a){var L=a.offsetLeft,T=a.offsetTop,o=a.offsetParent;while(o&&o!==world){L+=o.offsetLeft;T+=o.offsetTop;o=o.offsetParent}
  var q={l:L,t:T-24,r:L+a.offsetWidth,b:T+a.offsetHeight};r=r?{l:Math.min(r.l,q.l),t:Math.min(r.t,q.t),r:Math.max(r.r,q.r),b:Math.max(r.b,q.b)}:q});return r}
function fitTo(r,pad){var w=innerWidth-pad*2,h=innerHeight-pad*2;z=Math.min(1,w/(r.r-r.l),h/(r.b-r.t));x=(innerWidth-(r.r-r.l)*z)/2-r.l*z;y=(innerHeight-(r.b-r.t)*z)/2-r.t*z;apply()}
function fitAll(){fitTo(box(boards),48)}
function focusOn(a){var r=box([a]);fitTo(r,32);z=Math.min(z,2);apply()}
B[0].onclick=function(){zoomAt(1/1.25,innerWidth/2,innerHeight/2)};B[1].onclick=function(){zoomAt(1.25,innerWidth/2,innerHeight/2)};B[2].onclick=fitAll;
addEventListener('wheel',function(e){e.preventDefault();if(e.ctrlKey||e.metaKey){zoomAt(Math.exp(-e.deltaY*(e.ctrlKey?.01:.002)),e.clientX,e.clientY)}else{x-=e.deltaX;y-=e.deltaY;apply()}},{passive:false});
var drag=null,space=false;
addEventListener('keydown',function(e){if(e.target.isContentEditable||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;
  if(e.code==='Space'){space=true;document.body.classList.add('k-pan');e.preventDefault()}
  else if(e.key==='0'&&e.shiftKey||e.key==='!'){fitAll()}else if(e.key==='0'&&(e.metaKey||e.ctrlKey)){e.preventDefault();zoomAt(1/z,innerWidth/2,innerHeight/2)}
  else if((e.key==='='||e.key==='+')&&(e.metaKey||e.ctrlKey)){e.preventDefault();zoomAt(1.25,innerWidth/2,innerHeight/2)}
  else if(e.key==='-'&&(e.metaKey||e.ctrlKey)){e.preventDefault();zoomAt(1/1.25,innerWidth/2,innerHeight/2)}});
addEventListener('keyup',function(e){if(e.code==='Space'){space=false;document.body.classList.remove('k-pan')}});
addEventListener('pointerdown',function(e){var onBoard=e.target.closest('.artboard');if(e.target.closest('.k-zoom'))return;
  if(space||e.button===1||!onBoard){drag={x:e.clientX-x,y:e.clientY-y};document.body.classList.add('k-panning');e.preventDefault()}});
addEventListener('pointermove',function(e){if(drag){x=e.clientX-drag.x;y=e.clientY-drag.y;apply()}});
addEventListener('pointerup',function(){drag=null;document.body.classList.remove('k-panning')});
addEventListener('dblclick',function(e){var a=e.target.closest('.artboard');if(a&&!e.target.closest('a,button,input,textarea'))focusOn(a)});
addEventListener('message',function(e){var m=e.data;if(!m||m.kortix!=='artifact'||e.source!==P)return;if(m.op==='fit')fitAll()});
function start(){fitAll();if(P)P.postMessage({kortix:'artifact',op:'ready',type:'board',count:boards.length},'*')}
if(document.readyState==='complete')start();else addEventListener('load',start);
var rt;addEventListener('resize',function(){clearTimeout(rt);rt=setTimeout(fitAll,120)});
})();
`;

const DASHBOARD_CSS = String.raw`
html{background:#f6f6f5;color:var(--k-fg);font:14px/1.5 var(--k-sans)}
@media (prefers-color-scheme:dark){html{background:#111}}
body{max-width:1320px;margin:0 auto;padding:40px 28px 72px}
body>header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin:0 0 28px}
body>header h1{font-size:1.6rem;line-height:1.2;letter-spacing:-.02em;font-weight:600;margin:0}
body>header p{color:var(--k-muted);margin:.35rem 0 0}
h2{font-size:1rem;font-weight:600;margin:2rem 0 .75rem}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:0 0 12px}
.kpi,.card{background:var(--k-bg);border:1px solid var(--k-border);border-radius:14px;padding:18px 20px;min-width:0}
.kpi .label{color:var(--k-muted);font-size:.8rem;font-weight:500}
.kpi .value{font-size:1.85rem;line-height:1.15;font-weight:600;letter-spacing:-.025em;margin:.35rem 0 .2rem;font-variant-numeric:tabular-nums}
.delta{font-size:.8rem;font-weight:500;font-variant-numeric:tabular-nums;color:var(--k-muted)}
.delta.up{color:var(--k-green)}.delta.down{color:var(--k-red)}
.delta.up::before{content:'\2191\00a0'}.delta.down::before{content:'\2193\00a0'}
.grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px}
.grid>.card{grid-column:span 3}.grid>.span-2{grid-column:span 2}.grid>.span-4{grid-column:span 4}.grid>.full,.grid>.span-6{grid-column:1/-1}
.card h3{font-size:.875rem;font-weight:600;margin:0 0 .15rem}
.card h3+p,.card .sub{color:var(--k-muted);font-size:.8rem;margin:0 0 .75rem}
.card>:last-child{margin-bottom:0}
table{width:100%;border-collapse:collapse;font-size:.85rem;font-variant-numeric:tabular-nums}
th{color:var(--k-muted);font-weight:500;text-align:left;padding:.45rem .5rem;border-bottom:1px solid var(--k-border)}
td{padding:.5rem;border-bottom:1px solid var(--k-border)}tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right}
.badge{display:inline-block;padding:.1rem .5rem;border-radius:999px;background:var(--k-card);font-size:.75rem;font-weight:500}
.badge.ok{color:var(--k-green)}.badge.warn{color:var(--k-orange)}.badge.bad{color:var(--k-red)}
figure.chart{margin:.5rem 0 0;min-height:var(--h,220px);position:relative}
figure.chart svg{display:block;width:100%;overflow:visible}
.k-legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--k-muted);font-size:.75rem;margin-top:8px}
.k-legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;vertical-align:0}
.k-tip{position:absolute;pointer-events:none;background:var(--k-fg);color:var(--k-bg);font-size:.75rem;padding:4px 8px;border-radius:6px;white-space:nowrap;transform:translate(-50%,-110%);opacity:0;transition:opacity .1s}
.spark{display:inline-block;width:96px;height:28px;vertical-align:middle}
@media (max-width:860px){.grid>.card,.grid>.span-2,.grid>.span-4{grid-column:1/-1}body{padding:24px 16px 48px}}
`;

// Charts: <figure class="chart" data-type="bar|line|area|donut|hbar" data-labels="a,b"
// data-series='{"Name":[1,2]}' data-format="number|currency|percent" data-height="220">.
// Sparklines: <span class="spark" data-values="1,4,2,6"></span>.
const DASHBOARD_JS = String.raw`
(function(){
var NS='http://www.w3.org/2000/svg';
var C=['var(--k-accent)','var(--k-green)','var(--k-orange)','var(--k-purple)','var(--k-red)','var(--k-yellow)','var(--k-blue)'];
function el(t,a,p){var n=document.createElementNS(NS,t);for(var k in a)n.setAttribute(k,a[k]);if(p)p.appendChild(n);return n}
function fmt(v,f,cur){if(f==='percent')return (Math.round(v*10)/10)+'%';
  var o={notation:Math.abs(v)>=10000?'compact':'standard',maximumFractionDigits:Math.abs(v)<10?2:1};
  if(f==='currency'){o.style='currency';o.currency=cur||'USD'}
  try{return new Intl.NumberFormat(undefined,o).format(v)}catch(e){return String(v)}}
function nice(max){if(max<=0)return 1;var p=Math.pow(10,Math.floor(Math.log10(max))),r=max/p;return (r<=1?1:r<=2?2:r<=2.5?2.5:r<=5?5:10)*p}
function parse(f){var s={},l=(f.getAttribute('data-labels')||'').split(',').map(function(x){return x.trim()}).filter(Boolean);
  try{s=JSON.parse(f.getAttribute('data-series')||'{}')}catch(e){}
  if(Array.isArray(s))s={Value:s};return {labels:l,series:Object.keys(s).map(function(k){return {name:k,values:s[k].map(Number)}})}}
function tipOf(f){var t=f.querySelector(':scope>.k-tip');if(!t){t=document.createElement('div');t.className='k-tip';f.appendChild(t)}return t}
function hover(f,node,text,x,y){node.addEventListener('mouseenter',function(){var t=tipOf(f);t.textContent=text;t.style.left=x+'px';t.style.top=y+'px';t.style.opacity=1});
  node.addEventListener('mouseleave',function(){tipOf(f).style.opacity=0})}
function legend(f,d){if(d.series.length<2&&f.getAttribute('data-type')!=='donut')return;var g=document.createElement('div');g.className='k-legend';
  var names=f.getAttribute('data-type')==='donut'?d.labels:d.series.map(function(s){return s.name});
  names.forEach(function(n,i){var s=document.createElement('span');s.innerHTML='<i style="background:'+C[i%C.length]+'"></i>';s.appendChild(document.createTextNode(n));g.appendChild(s)});f.appendChild(g)}
function draw(f){
  [].slice.call(f.querySelectorAll(':scope>svg,:scope>.k-legend,:scope>.k-tip')).forEach(function(n){n.remove()});
  var d=parse(f),type=f.getAttribute('data-type')||'bar',fm=f.getAttribute('data-format'),cur=f.getAttribute('data-currency');
  var W=Math.max(120,f.clientWidth),H=+f.getAttribute('data-height')||220;f.style.setProperty('--h',H+'px');
  var svg=el('svg',{viewBox:'0 0 '+W+' '+H,height:H,role:'img','aria-label':f.getAttribute('aria-label')||f.getAttribute('data-title')||'chart'});
  f.insertBefore(svg,f.firstChild);
  if(!d.series.length)return;
  if(type==='donut'||type==='pie'){var vals=d.series[0].values,tot=vals.reduce(function(a,b){return a+b},0)||1,R=Math.min(W,H)/2-4,cx=W/2,cy=H/2,a0=-Math.PI/2;
    vals.forEach(function(v,i){var a1=a0+v/tot*Math.PI*2,big=a1-a0>Math.PI?1:0,r2=type==='pie'?0:R*.62;
      var p=['M',cx+R*Math.cos(a0),cy+R*Math.sin(a0),'A',R,R,0,big,1,cx+R*Math.cos(a1),cy+R*Math.sin(a1),'L',cx+r2*Math.cos(a1),cy+r2*Math.sin(a1),'A',r2,r2,0,big,0,cx+r2*Math.cos(a0),cy+r2*Math.sin(a0),'Z'].join(' ');
      var n=el('path',{d:p,fill:C[i%C.length],stroke:'var(--k-bg)','stroke-width':2},svg);
      var m=(a0+a1)/2;hover(f,n,(d.labels[i]||'')+': '+fmt(v,fm,cur)+' ('+Math.round(v/tot*100)+'%)',cx+R*.8*Math.cos(m),cy+R*.8*Math.sin(m));a0=a1});
    if(type==='donut'){var tx=el('text',{x:cx,y:cy+6,'text-anchor':'middle','font-size':18,'font-weight':600,fill:'var(--k-fg)'},svg);tx.textContent=fmt(tot,fm,cur)}
    legend(f,d);return}
  var all=[].concat.apply([],d.series.map(function(s){return s.values})),mx=nice(Math.max.apply(null,all.concat([0]))),mn=Math.min.apply(null,all.concat([0]));
  if(type==='hbar'){var L=Math.min(160,W*.35),rowH=(H-8)/d.labels.length,bh=Math.max(4,rowH*.62/d.series.length);
    d.labels.forEach(function(lb,i){var t=el('text',{x:L-8,y:i*rowH+rowH/2+4,'text-anchor':'end','font-size':11,fill:'var(--k-muted)'},svg);t.textContent=lb;
      d.series.forEach(function(s,j){var v=s.values[i]||0,w=(W-L-48)*v/mx,y=i*rowH+(rowH-bh*d.series.length)/2+j*bh;
        var r=el('rect',{x:L,y:y,width:Math.max(1,w),height:bh-1,rx:3,fill:C[j%C.length]},svg);hover(f,r,lb+(d.series.length>1?' \u00b7 '+s.name:'')+': '+fmt(v,fm,cur),L+w,y);
        var vt=el('text',{x:L+w+6,y:y+bh/2+4,'font-size':11,fill:'var(--k-muted)'},svg);vt.textContent=fmt(v,fm,cur)})});legend(f,d);return}
  var pl=44,pb=22,pt=8,iw=W-pl-4,ih=H-pb-pt,lo=mn<0?-nice(-mn):0,span=mx-lo||1;
  function Y(v){return pt+ih-(v-lo)/span*ih}
  for(var g=0;g<=4;g++){var v=lo+span*g/4,yy=Y(v);el('line',{x1:pl,x2:W,y1:yy,y2:yy,stroke:'var(--k-border)','stroke-dasharray':g?'2 3':''},svg);
    var t=el('text',{x:pl-8,y:yy+4,'text-anchor':'end','font-size':11,fill:'var(--k-muted)'},svg);t.textContent=fmt(v,fm,cur)}
  var n=d.labels.length||d.series[0].values.length,step=iw/n,every=Math.ceil(n/Math.max(1,Math.floor(iw/64)));
  d.labels.forEach(function(lb,i){if(i%every)return;var t=el('text',{x:pl+step*i+step/2,y:H-6,'text-anchor':'middle','font-size':11,fill:'var(--k-muted)'},svg);t.textContent=lb});
  if(type==='bar'){var gw=step*.72,bw=gw/d.series.length;
    d.series.forEach(function(s,j){s.values.forEach(function(v,i){var x=pl+step*i+(step-gw)/2+j*bw,y=Y(Math.max(v,0)),h=Math.abs(Y(v)-Y(0));
      var r=el('rect',{x:x,y:y,width:Math.max(1,bw-2),height:Math.max(1,h),rx:Math.min(4,bw/4),fill:C[j%C.length]},svg);
      hover(f,r,(d.labels[i]||'')+(d.series.length>1?' \u00b7 '+s.name:'')+': '+fmt(v,fm,cur),x+bw/2,y)})})}
  else{d.series.forEach(function(s,j){var pts=s.values.map(function(v,i){return [pl+step*i+step/2,Y(v)]});var c=C[j%C.length];
    if(type==='area'){el('path',{d:'M'+pts[0][0]+','+Y(0)+' L'+pts.map(function(p){return p.join(',')}).join(' L')+' L'+pts[pts.length-1][0]+','+Y(0)+'Z',fill:c,'fill-opacity':.12},svg)}
    el('polyline',{points:pts.map(function(p){return p.join(',')}).join(' '),fill:'none',stroke:c,'stroke-width':2,'stroke-linejoin':'round','stroke-linecap':'round'},svg);
    pts.forEach(function(p,i){var dot=el('circle',{cx:p[0],cy:p[1],r:pts.length>24?2:3.5,fill:'var(--k-bg)',stroke:c,'stroke-width':2},svg);
      hover(f,dot,(d.labels[i]||'')+(d.series.length>1?' \u00b7 '+s.name:'')+': '+fmt(s.values[i],fm,cur),p[0],p[1])})})}
  legend(f,d)}
function spark(s){var v=(s.getAttribute('data-values')||'').split(',').map(Number).filter(function(x){return !isNaN(x)});if(v.length<2)return;
  var W=96,H=28,mx=Math.max.apply(null,v),mn=Math.min.apply(null,v),r=mx-mn||1;s.innerHTML='';
  var svg=el('svg',{viewBox:'0 0 '+W+' '+H,width:'100%',height:'100%',preserveAspectRatio:'none'},null);
  var up=v[v.length-1]>=v[0],c=s.getAttribute('data-color')||(up?'var(--k-green)':'var(--k-red)');
  el('polyline',{points:v.map(function(x,i){return (i/(v.length-1)*W)+','+(H-2-(x-mn)/r*(H-4))}).join(' '),fill:'none',stroke:c,'stroke-width':1.75,'vector-effect':'non-scaling-stroke'},svg);s.appendChild(svg)}
function all(){[].forEach.call(document.querySelectorAll('figure.chart'),draw);[].forEach.call(document.querySelectorAll('.spark'),spark)}
var ro=window.ResizeObserver?new ResizeObserver(function(es){es.forEach(function(e){if(e.target.matches('figure.chart'))draw(e.target)})}):null;
function start(){all();if(ro)[].forEach.call(document.querySelectorAll('figure.chart'),function(f){ro.observe(f)})}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
window.kortixCharts={draw:draw,refresh:all};
})();
`;

interface ArtifactTypeDef {
  type: ArtifactType;
  name: string;
  description: string;
  /** How to write this type: the format contract, in Markdown. */
  format: string;
  /** A complete example; also the "start blank" template. */
  starter: string;
  kit?: { css: string; js: string };
}

const DOC_STARTER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Untitled doc</title></head>
<body>
<h1>Untitled doc</h1>
<p class="byline">Draft</p>
<p class="lede">Start with the answer in one or two sentences. The reader decides here whether to keep reading.</p>
<h2>Background</h2>
<p>Write the context the reader needs. Keep one idea per paragraph.</p>
<h2>Decision</h2>
<ul><li>One change per bullet.</li><li>Name the file, the route or the number.</li></ul>
<aside><strong>Open question.</strong> Say what is unknown and what would resolve it.</aside>
</body></html>
`;

const SLIDES_STARTER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Untitled deck</title></head>
<body>
<section class="title dark">
  <p class="kicker">Kortix · 2026</p>
  <h1>Untitled deck</h1>
  <p class="muted">A one-line subtitle</p>
</section>
<section>
  <p class="kicker">The problem</p>
  <h2>One idea per slide, said in one sentence</h2>
  <ul><li>Three bullets at most</li><li>Each one short</li><li>Numbers over adjectives</li></ul>
</section>
<section class="center">
  <p class="big">3×</p>
  <h3>faster with the new flow</h3>
</section>
<section class="accent">
  <h2>Thank you</h2>
</section>
</body></html>
`;

const BOARD_STARTER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Untitled board</title>
<style>
.hero{padding:96px 120px;display:flex;flex-direction:column;gap:24px}
.hero h1{font-size:64px;line-height:1.05;letter-spacing:-.03em;margin:0;max-width:820px}
.hero p{font-size:20px;color:#555;margin:0;max-width:620px}
.btn{display:inline-block;background:#111;color:#fff;padding:14px 22px;border-radius:10px;font-weight:500;width:max-content}
.phone{padding:48px 24px;display:flex;flex-direction:column;gap:16px}
.phone h1{font-size:34px;line-height:1.1;letter-spacing:-.02em;margin:0}
</style></head>
<body>
<div class="artboard" data-name="Landing — desktop" style="width:1440px;height:900px">
  <div class="hero"><h1>Describe an idea and turn it into a design</h1><p>Each artboard is one screen, sized like the real device.</p><span class="btn">Get started</span></div>
</div>
<div class="artboard" data-name="Landing — mobile" style="width:390px;height:844px">
  <div class="phone"><h1>Describe an idea and turn it into a design</h1><span class="btn">Get started</span></div>
</div>
</body></html>
`;

const DASHBOARD_STARTER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Untitled dashboard</title></head>
<body>
<header><div><h1>Untitled dashboard</h1><p>Data as of 2026-10-23</p></div></header>
<div class="kpis">
  <div class="kpi"><div class="label">Revenue</div><div class="value">$128.4k</div><div class="delta up">12.4% vs last month</div></div>
  <div class="kpi"><div class="label">Active accounts</div><div class="value">1,284</div><div class="delta up">3.1%</div></div>
  <div class="kpi"><div class="label">Churn</div><div class="value">2.1%</div><div class="delta down">0.4 pts</div></div>
  <div class="kpi"><div class="label">Trend</div><div class="value"><span class="spark" data-values="4,6,5,8,9,12,14"></span></div></div>
</div>
<div class="grid">
  <div class="card span-4"><h3>Revenue by month</h3><p>Thousands of USD</p>
    <figure class="chart" data-type="area" data-format="currency" data-labels="May,Jun,Jul,Aug,Sep,Oct" data-series='{"2026":[82,91,97,104,114,128]}'></figure></div>
  <div class="card span-2"><h3>Plan mix</h3><p>Share of accounts</p>
    <figure class="chart" data-type="donut" data-labels="Free,Pro,Team" data-series='[620,480,184]'></figure></div>
  <div class="card full"><h3>Top accounts</h3>
    <table><thead><tr><th>Account</th><th>Plan</th><th class="num">Revenue</th></tr></thead>
    <tbody><tr><td>Account A</td><td><span class="badge ok">Team</span></td><td class="num">$12.0k</td></tr>
    <tr><td>Account B</td><td><span class="badge">Pro</span></td><td class="num">$8.4k</td></tr></tbody></table></div>
</div>
</body></html>
`;

const PAGE_STARTER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Untitled page</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:64px auto;padding:0 16px}</style></head>
<body><h1>Untitled page</h1><p>Any HTML, CSS and JavaScript. No kit is added.</p></body></html>
`;

export const ARTIFACT_TYPES: readonly ArtifactTypeDef[] = [
  {
    type: 'doc',
    name: 'Doc',
    description: 'A document to read: a spec, a report, a memo. People with edit access edit the text in place.',
    format: [
      'Write semantic HTML in <body>: one <h1>, then <p>, <h2>/<h3>, <ul>/<ol>, <table>, <pre><code>, <blockquote>, <figure>/<figcaption>, <img>, inline <svg>.',
      'The kit sets the typography (serif headings, 740px measure, light and dark). Add no layout CSS.',
      'Classes: `byline` (a muted meta line under the title), `lede` (the opening paragraph), `aside` or `.callout` (a boxed note), `.wide` (a table or diagram wider than the text).',
      'Editing in Kortix saves the rendered DOM: keep scripts out of a doc.',
    ].join('\n'),
    starter: DOC_STARTER,
    kit: { css: DOC_CSS, js: DOC_JS },
  },
  {
    type: 'slides',
    name: 'Slides',
    description: 'A 16:9 deck. Arrow keys, click or swipe to move; G shows all slides; F presents full screen; print saves a PDF.',
    format: [
      'Each direct child <section> of <body> is one 1920×1080 slide. Size type in px for that canvas: the kit scales it to fit.',
      'Defaults: h1 120px, h2 76px, h3 48px, body 40px. Keep one idea per slide and three bullets at most.',
      'Slide classes: `title` (bottom-aligned title slide), `center`, `dark`, `accent` (blue), `image` (a full-bleed <img> child).',
      'Inner classes: `kicker` (mono overline), `big` (a 200px number), `muted`, `cols` / `cols-3` (columns), `card` (a boxed panel).',
      '<aside class="notes"> inside a slide is hidden speaker notes.',
    ].join('\n'),
    starter: SLIDES_STARTER,
    kit: { css: SLIDES_CSS, js: SLIDES_JS },
  },
  {
    type: 'board',
    name: 'Board',
    description: 'A design canvas: artboards (screens, components, mockups) on an infinite board with pan and zoom.',
    format: [
      'Each direct child <div class="artboard" data-name="…" style="width:…px;height:…px"> of <body> is one artboard, sized like the real device (1440×900 desktop, 390×844 phone).',
      'Artboards flow left to right, 160px apart. Set data-x and data-y (px) on every artboard to place them yourself.',
      'Style the inside of an artboard with your own <style>: the kit resets only its frame (white, light scheme).',
      'Viewers: drag the canvas or hold Space to pan; pinch, Ctrl/Cmd+wheel or the buttons to zoom; double-click an artboard or its label to focus it.',
    ].join('\n'),
    starter: BOARD_STARTER,
    kit: { css: BOARD_CSS, js: BOARD_JS },
  },
  {
    type: 'dashboard',
    name: 'Dashboard',
    description: 'KPIs, charts and tables on a responsive grid. Charts are drawn from data attributes, no library needed.',
    format: [
      '<header> with an <h1> and a <p> (the as-of line). Then <div class="kpis"> of <div class="kpi"> (`.label`, `.value`, `.delta up|down`).',
      '<div class="grid"> (6 columns) of <div class="card"> (half width). Widths: `span-2`, `span-4`, `full`. A card opens with <h3> and an optional <p> subtitle.',
      "Charts: <figure class=\"chart\" data-type=\"bar|line|area|hbar|donut|pie\" data-labels=\"Jan,Feb\" data-series='{\"Series\":[1,2]}' data-format=\"number|currency|percent\" data-height=\"220\">. data-series may be a plain array for one series.",
      'Sparkline: <span class="spark" data-values="1,4,2,6">. Tables: `td.num` right-aligns. Status: <span class="badge ok|warn|bad">.',
      'After you change chart data from a script, call window.kortixCharts.refresh(). Any other library from a CDN also works.',
    ].join('\n'),
    starter: DASHBOARD_STARTER,
    kit: { css: DASHBOARD_CSS, js: DASHBOARD_JS },
  },
  {
    type: 'page',
    name: 'Page',
    description: 'Any HTML page: an app, a tool, a game, an explainer. No kit is added.',
    format: 'Any HTML, CSS and JavaScript. Supporting files (scripts, styles, images, data) are published beside index.html and referenced by relative path.',
    starter: PAGE_STARTER,
  },
];

export function artifactTypeDef(type: string): ArtifactTypeDef | undefined {
  return ARTIFACT_TYPES.find((t) => t.type === type);
}

/**
 * The entry page with its type's kit: the <style> goes first in <head> (the
 * author's CSS wins), the <script> last in <body> (the DOM exists when it runs).
 */
export function injectKit(html: string, type: string): string {
  const kit = artifactTypeDef(type)?.kit;
  if (!kit) return html;
  const style = `<style data-kortix-kit>${BASE}${kit.css}</style>`;
  const script = `<script data-kortix-kit>${kit.js}</script>`;
  const head = /<head[^>]*>/i.exec(html);
  let out = head
    ? html.slice(0, head.index + head[0].length) + style + html.slice(head.index + head[0].length)
    : style + html;
  const close = out.toLowerCase().lastIndexOf('</body>');
  out = close >= 0 ? out.slice(0, close) + script + out.slice(close) : out + script;
  return out;
}
