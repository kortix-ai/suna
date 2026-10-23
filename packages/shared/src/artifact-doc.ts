/**
 * The look of a Kortix doc artifact, in one stylesheet scoped to `.kx-doc`.
 * The API serves a doc with it (`<body class="kx-doc">`, also what prints to
 * PDF), and the web editor renders the same document with it, so what a person
 * edits is what a reader opens. Colors are `--kx-doc-*` variables: the served
 * page follows `prefers-color-scheme`, the app sets them from its own theme.
 */
export const ARTIFACT_DOC_CSS = `
.kx-doc{--kx-doc-bg:#fff;--kx-doc-fg:#1f1f1f;--kx-doc-muted:#6b6b6b;--kx-doc-border:#e4e4e2;--kx-doc-subtle:#f5f5f3;--kx-doc-accent:#0b7bd6;
  background:var(--kx-doc-bg);color:var(--kx-doc-fg);font:16px/1.7 ui-sans-serif,-apple-system,'Segoe UI','Helvetica Neue','Noto Sans',sans-serif;
  -webkit-font-smoothing:antialiased;max-width:760px;margin:0 auto;padding:72px 32px 128px;box-sizing:border-box;word-wrap:break-word}
@media (prefers-color-scheme:dark){body.kx-doc{--kx-doc-bg:#171717;--kx-doc-fg:#ececec;--kx-doc-muted:#9c9c9c;--kx-doc-border:#2e2e2e;--kx-doc-subtle:#212121;--kx-doc-accent:#4aa8ff}}
html:has(body.kx-doc){background:var(--kx-doc-bg)}
.kx-doc *{box-sizing:border-box}
.kx-doc :where(h1,h2,h3){font-family:ui-serif,'New York','Iowan Old Style',Charter,Georgia,serif;font-weight:600;color:var(--kx-doc-fg)}
.kx-doc h1{font-size:2.4rem;line-height:1.15;letter-spacing:-.02em;margin:0 0 .6em}
.kx-doc h2{font-size:1.6rem;line-height:1.25;letter-spacing:-.01em;margin:2.2em 0 .6em}
.kx-doc h3{font-size:1.2rem;line-height:1.35;margin:1.8em 0 .5em}
.kx-doc h4{font-size:1rem;line-height:1.4;margin:1.5em 0 .4em;font-weight:600}
.kx-doc :where(p,ul,ol,blockquote,pre,table,figure,hr){margin:0 0 1em}
.kx-doc ul,.kx-doc ol{padding-left:1.5em}
.kx-doc li{margin:.2em 0}.kx-doc li>p{margin:0}
.kx-doc ul[data-type=taskList]{list-style:none;padding-left:.2em}
.kx-doc ul[data-type=taskList] li{display:flex;gap:.55em;align-items:flex-start}
.kx-doc ul[data-type=taskList] li>label{margin-top:.2em}
.kx-doc ul[data-type=taskList] li>div{flex:1}.kx-doc ul[data-type=taskList] p{margin:0}
.kx-doc input[type=checkbox]{accent-color:var(--kx-doc-accent)}
.kx-doc strong{font-weight:600}
.kx-doc a{color:var(--kx-doc-accent);text-decoration:underline;text-underline-offset:2px}
.kx-doc blockquote{border-left:3px solid var(--kx-doc-border);padding:.1em 0 .1em 1em;color:var(--kx-doc-muted)}
.kx-doc code{font:.88em ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace;background:var(--kx-doc-subtle);border-radius:5px;padding:.12em .35em}
.kx-doc pre{background:var(--kx-doc-subtle);border-radius:10px;padding:1em 1.1em;overflow-x:auto;font-size:.85rem;line-height:1.55}
.kx-doc pre code{background:none;padding:0;font-size:inherit}
.kx-doc hr{border:0;border-top:1px solid var(--kx-doc-border);margin:2.4em 0}
.kx-doc :where(img,video){display:block;max-width:100%;height:auto;border-radius:8px;margin:0 0 1em}
.kx-doc video{width:100%;background:#000}
.kx-doc pre.mermaid,.kx-doc .kx-diagram{background:none;text-align:center;padding:.5em 0;margin:0 0 1em}
.kx-doc .kx-diagram svg{max-width:100%;height:auto}
.kx-doc img.ProseMirror-selectednode,.kx-doc video.ProseMirror-selectednode{outline:2px solid var(--kx-doc-accent)}
.kx-doc table{width:100%;border-collapse:collapse;font-size:.92rem;table-layout:auto}
.kx-doc :where(th,td){border:1px solid var(--kx-doc-border);padding:.5em .75em;text-align:left;vertical-align:top;position:relative}
.kx-doc th{background:var(--kx-doc-subtle);font-weight:500}
.kx-doc :where(th,td)>p{margin:0}
.kx-doc mark{background:#fff3a3;color:inherit;border-radius:2px}
.kx-doc .ProseMirror{outline:none}
.kx-doc .ProseMirror p.is-editor-empty:first-child::before,.kx-doc .ProseMirror .is-empty::before{content:attr(data-placeholder);color:var(--kx-doc-muted);opacity:.6;float:left;height:0;pointer-events:none}
.kx-doc .selectedCell::after{content:'';position:absolute;inset:0;background:var(--kx-doc-accent);opacity:.12;pointer-events:none}
.kx-doc .tableWrapper{overflow-x:auto}
@media (max-width:640px){.kx-doc{padding:40px 18px 96px}.kx-doc h1{font-size:1.9rem}}
@media print{@page{margin:18mm 16mm}.kx-doc{max-width:none;padding:0;--kx-doc-bg:#fff;--kx-doc-fg:#111}.kx-doc a{color:inherit}.kx-doc :where(h1,h2,h3){break-after:avoid}.kx-doc :where(pre,table,img,blockquote){break-inside:avoid}}
`;
