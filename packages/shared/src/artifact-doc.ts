/**
 * The look of a Kortix doc artifact, in one stylesheet scoped to `.kx-doc`.
 * The API serves a doc with it (also what prints to PDF), and the web editor
 * renders the same document with it, so what a person edits is what a reader
 * opens. Every value is a Kortix token (`--foreground`, `--font-sans`,
 * `--spacing`, …): the app defines them, and the served page loads the kit
 * tokens (`BRAND_TOKENS_CSS`). Each element mirrors `UnifiedMarkdown`
 * (`@kortix/ui/markdown`), the Markdown look of chat and Files. An agent's
 * instructions on its page use the same look inside the page column
 * (`.kx-doc-inline`: no page width, margins or padding).
 */
export const ARTIFACT_DOC_CSS = `
.kx-doc{--s:var(--spacing,.23rem);color:var(--foreground);font-family:var(--font-sans);font-weight:500;font-size:var(--text-base,1rem);line-height:var(--leading-relaxed,1.625);
  -webkit-font-smoothing:antialiased;overflow-wrap:anywhere;max-width:46rem;margin:0 auto;padding:calc(var(--s)*16) max(16px,calc(var(--s)*8)) calc(var(--s)*32);box-sizing:border-box}
.kx-doc.kx-doc-inline{max-width:none;margin:0;padding:0}
.kx-doc *{box-sizing:border-box}
.kx-doc :where(.ProseMirror,main)>:first-child,.kx-doc>:first-child{margin-top:0}
.kx-doc :where(h1,h2,h3,h4,h5,h6){color:var(--foreground);font-weight:600;text-wrap:balance}
.kx-doc h1{font-size:var(--text-2xl,1.5rem);line-height:var(--leading-tight,1.25);letter-spacing:var(--tracking-tight,-.025em);margin:calc(var(--s)*10) 0 calc(var(--s)*4)}
.kx-doc h2{font-size:var(--text-xl,1.25rem);line-height:var(--leading-snug,1.375);margin:calc(var(--s)*8) 0 calc(var(--s)*3)}
.kx-doc h3{font-size:var(--text-lg,1.125rem);line-height:var(--leading-snug,1.375);margin:calc(var(--s)*6) 0 calc(var(--s)*2)}
.kx-doc :where(h4,h5,h6){font-size:var(--text-base,1rem);margin:calc(var(--s)*5) 0 var(--s)}
.kx-doc p{margin:calc(var(--s)*4) 0}
.kx-doc strong{font-weight:600}
.kx-doc :where(del,s){color:var(--muted-foreground)}
.kx-doc a{color:var(--kortix-blue);font-weight:500;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px;
  text-decoration-color:color-mix(in oklab,var(--kortix-blue) 40%,transparent)}
.kx-doc a:hover{text-decoration-color:var(--kortix-blue)}
.kx-doc :where(ul,ol){margin:calc(var(--s)*4) 0;padding-left:calc(var(--s)*6)}
.kx-doc ul{list-style:disc outside}
.kx-doc ul ul{list-style-type:circle}
.kx-doc ol{list-style:decimal outside}
.kx-doc li{margin:var(--s) 0;padding-left:var(--s)}
.kx-doc li::marker{color:var(--muted-foreground)}
.kx-doc li>p{margin:0}
.kx-doc li>:where(ul,ol){margin:var(--s) 0}
.kx-doc ul[data-type=taskList]{list-style:none;padding-left:0}
.kx-doc ul[data-type=taskList] li{display:flex;gap:calc(var(--s)*2);align-items:flex-start;padding-left:0}
.kx-doc ul[data-type=taskList] li>label{display:flex;padding-top:.3em}
.kx-doc ul[data-type=taskList] li>input{margin-top:.3em}
.kx-doc ul[data-type=taskList] li>div{flex:1;min-width:0}
.kx-doc ul[data-type=taskList] li>div>p,.kx-doc ul[data-type=taskList] li>p{margin:0}
.kx-doc ul[data-type=taskList] li>label>span{display:none}
.kx-doc ul[data-type=taskList] li[data-checked=true]>div{color:var(--muted-foreground)}
.kx-doc input[type=checkbox]{appearance:none;margin:0;flex:none;width:1rem;height:1rem;display:inline-grid;place-content:center;cursor:pointer;
  border:1px solid color-mix(in oklab,var(--muted-foreground) 60%,transparent);border-radius:var(--radius-sm,.25rem);background:var(--background)}
.kx-doc input[type=checkbox]::before{content:"";width:.625rem;height:.625rem;opacity:0;background:var(--primary-foreground);
  clip-path:polygon(14% 44%,0 65%,50% 100%,100% 16%,80% 0,43% 62%)}
.kx-doc input[type=checkbox]:checked{background:var(--primary);border-color:var(--primary)}
.kx-doc input[type=checkbox]:checked::before{opacity:1}
.kx-doc input[type=checkbox]:disabled{cursor:default}
.kx-doc blockquote{margin:calc(var(--s)*5) 0;padding-left:calc(var(--s)*6);border-left:2px solid var(--border);color:var(--muted-foreground);font-style:italic}
.kx-doc blockquote p{margin:calc(var(--s)*2) 0}
.kx-doc :not(pre)>code{font-family:var(--font-mono);font-size:.8rem;font-weight:500;letter-spacing:var(--tracking-tight,-.025em);color:var(--foreground);
  background:var(--card);border:1px solid var(--border);border-radius:var(--radius-sm,.25rem);padding:.08rem calc(var(--s)*1.5)}
.kx-doc :where(h1,h2,h3,h4,h5,h6) code{font-size:.9em}
.kx-doc .kx-code{margin:calc(var(--s)*5) 0;border:1px solid var(--border);border-radius:var(--radius-md,.375rem);background:var(--card);overflow:hidden}
.kx-doc .kx-code>figcaption{display:flex;align-items:center;justify-content:space-between;gap:calc(var(--s)*2);min-height:calc(var(--s)*8);
  padding:0 calc(var(--s)*2);font:500 var(--text-xs,.8125rem)/1 var(--font-mono);color:var(--muted-foreground);text-transform:lowercase;user-select:none}
.kx-doc pre{margin:calc(var(--s)*5) 0;overflow:auto;max-height:32rem;background:var(--popover);border:1px solid var(--border);border-radius:var(--radius-md,.375rem);
  padding:calc(var(--s)*2.5) calc(var(--s)*4);font:var(--text-xs,.8125rem)/1.65 var(--font-mono);letter-spacing:var(--tracking-tight,-.025em);white-space:pre;color:var(--foreground)}
.kx-doc .kx-code pre{margin:0;border:0;border-radius:0}
.kx-doc .kx-code>figcaption input{all:unset;font:inherit;color:inherit;width:16ch}
.kx-doc .kx-code[hidden]{display:none}
.kx-doc pre code{font:inherit;background:none;border:0;padding:0}
.kx-doc hr{border:0;border-top:1px solid var(--border);height:0;margin:calc(var(--s)*6) 0}
.kx-doc :where(img,video){display:block;max-width:100%;height:auto;margin:calc(var(--s)*5) 0;border-radius:var(--radius-lg,.625rem);
  outline:1px solid color-mix(in oklab,var(--foreground) 10%,transparent);outline-offset:-1px}
.kx-doc video{width:100%;background:var(--foreground)}
.kx-doc :where(.tableWrapper,.kx-table){margin:calc(var(--s)*5) 0;overflow-x:auto;border:1px solid var(--border);border-radius:var(--radius-md,.375rem)}
.kx-doc table{width:100%;margin:0;border-collapse:collapse;font-size:var(--text-sm,.875rem);line-height:1.5}
.kx-doc :where(th,td){padding:calc(var(--s)*2) calc(var(--s)*4);text-align:left;vertical-align:top;border-bottom:1px solid var(--border);position:relative;min-width:6rem}
.kx-doc tr:last-child>td{border-bottom:0}
.kx-doc th{background:var(--muted);font-weight:500}
.kx-doc :where(th,td)>p{margin:0}
.kx-doc pre.mermaid,.kx-doc .kx-diagram{background:none;border:0;text-align:center;padding:calc(var(--s)*2) 0;margin:calc(var(--s)*5) 0;max-height:none;white-space:normal}
.kx-doc .kx-diagram svg{max-width:100%;height:auto}
.kx-doc ::selection{background:color-mix(in oklab,var(--kortix-blue) 22%,transparent)}
.kx-doc .ProseMirror{outline:none}
.kx-doc .ProseMirror :where(img,video).ProseMirror-selectednode{outline:2px solid var(--kortix-blue)}
.kx-doc .ProseMirror p.is-editor-empty:first-child::before,.kx-doc .ProseMirror .is-empty::before{content:attr(data-placeholder);color:var(--muted-foreground);float:left;height:0;pointer-events:none}
.kx-doc .selectedCell::after{content:"";position:absolute;inset:0;background:var(--kortix-blue);opacity:.12;pointer-events:none}
@media (max-width:640px){.kx-doc{padding-top:calc(var(--s)*10)}}
@media print{@page{margin:18mm 16mm}
  body>:not(main){display:none!important}
  .kx-doc{max-width:none;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .kx-doc a{color:inherit;text-decoration-color:currentColor}
  .kx-doc :where(h1,h2,h3,h4){break-after:avoid;break-inside:avoid}
  .kx-doc :where(p,li){orphans:3;widows:3}
  .kx-doc :where(img,video,blockquote,.kx-diagram,tr,.kx-code>figcaption){break-inside:avoid}
  .kx-doc pre{max-height:none;overflow:visible;white-space:pre-wrap;overflow-wrap:anywhere}
  .kx-doc :where(.tableWrapper,.kx-table){overflow:visible}
  .kx-doc thead{display:table-header-group}
  .kx-doc :where(img,video){max-height:240mm;object-fit:contain}
  .kx-doc .kx-code>figcaption button{display:none}}
`;

/** The served page around `.kx-doc`: the page background follows the tokens. */
export const ARTIFACT_PAGE_CSS = `html,body{margin:0;background:var(--background);color:var(--foreground)}`;
