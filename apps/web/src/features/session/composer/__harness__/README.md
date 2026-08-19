# Composer browser harness

Mounts the **real** `ComposerEditor` in a real browser so the `@` and `/` menus
can be observed opening, positioning, navigating and selecting.

## Why this exists

`apps/web` has no DOM test environment — `bun test` runs headless with no
`document`, and there is no jsdom/happy-dom. Every assertion about the menus
was therefore made against pure functions (`buildSlashSections`,
`MenuNavState`, …) with the **mount path unproven**: whether the suggestion
plugin fires, whether `ReactRenderer` renders, whether the popup is positioned
and visible, and what any of it looks like.

That gap is why menu regressions could ship green.

## Run it

```bash
cd apps/web
OUT=/tmp/composer-harness && mkdir -p $OUT
bun build src/features/session/composer/__harness__/entry.tsx \
  --outdir $OUT --target browser --define 'process.env.NODE_ENV="development"'
```

Compile the app's real Tailwind so the harness renders with production tokens
(without it, every utility class is missing and the menus look unstyled):

```bash
cd apps/web && node -e "
const postcss=require('postcss'), tw=require('@tailwindcss/postcss'), fs=require('fs');
postcss([tw()]).process(fs.readFileSync('src/app/globals.css','utf8'),
  {from:'src/app/globals.css'}).then(r=>fs.writeFileSync(process.env.OUT+'/tailwind.css', r.css));
"
```

Then write `$OUT/index.html`:

```html
<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="./tailwind.css">
<!-- Required: the SDK reads a bare `process.env` on a non-Next host, which is a
     ReferenceError in the browser, not `undefined`. -->
<script>window.process={env:{NODE_ENV:'development'}};</script>
</head><body class="bg-background text-foreground">
<div id="root"></div><script type="module" src="./entry.js"></script></body></html>
```

Serve it (`python3 -m http.server 8791`) and drive it with Playwright.

## Hooks it exposes

- `window.__log` — every callback the editor fired, in order
  (`menu:true`, `empty:false`, …). Read this to see open/close boundaries.
- `window.__handle()` — the `ComposerEditorHandle`, for driving
  `insertAtCursor` / `setDocument` directly (this is how the type-ahead
  redirect path from `useComposerFocus` is reproduced).
- `window.__rerender()` — force a parent re-render, to prove a re-render does
  not tear down an open menu.
- `?state=1` — round-trip every log line through React state, mirroring the
  real composer's `onMenuOpenChange` → `setMenuOpen` → `useMenuRevalidation`.

## Not shipped

Nothing imports this. It is excluded from the app graph by having no importer,
not by config — keep it that way.
