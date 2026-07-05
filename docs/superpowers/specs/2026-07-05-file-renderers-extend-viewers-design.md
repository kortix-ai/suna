# File renderers on extend.ai viewers — design

**Date:** 2026-07-05
**Status:** Approved
**Scope:** `apps/web/src/features/file-renderers/` — PDF, DOCX, XLSX, CSV/TSV view paths

## Problem

The four document view paths are uneven:

- **PDF** renders in a plain browser `<iframe>` — no consistent toolbar, no search/thumbnails, browser-dependent chrome, poor dark mode.
- **DOCX** uses `docx-preview` as a continuous scroll on a hard-coded white background — no pages, no zoom, no outline.
- **XLSX** uses Univer + ExcelJS (~500 KB) with complex imperative mount/teardown code and a duplicated retry path.
- **CSV** uses PapaParse + AG Grid (~200 KB) with a bespoke toolbar.

Four engines, four interaction vocabularies, none of them excellent.

## Decision

Replace all four view paths with the extend.ai viewer components (MIT, shadcn-registry-distributed, source vendored into our repo), rebuilt with Kortix-owned chrome.

Decisions made with Jay:

1. **Full replacement** — extend viewers become the only view path everywhere (full file viewer + inline tool previews). Legacy engines are deleted. Syncfusion stays for XLSX *editing* only.
2. **Kortix chrome** — extend's toolbars, upload buttons, and theme toggles are stripped; controls are rebuilt as kortix-design-system components.
3. **Hand-vendor** — fetch registry JSONs from `https://www.extend.ai/ui/r/{name}.json`, extract only the viewer files, rewire imports to our existing ui primitives. No shadcn CLI (it would pull registry deps that collide with our customized `button`/`input`/`popover`).

## Engines (verified 2026-07-05)

| Format | Vendored file(s) | npm deps (all MIT) |
|---|---|---|
| PDF | `pdf-viewer.tsx` (~50 KB src) | `@embedpdf/*` suite ^2.14.4 (core, engines, models, 11 plugins — PDFium WASM), `pdf-lib` |
| DOCX | `docx-viewer.tsx` + `docx-annotation-card.tsx` | `@extend-ai/react-docx` ^0.7.5, `@tanstack/react-virtual` |
| XLSX | `xlsx-viewer.tsx` | `@extend-ai/react-xlsx` 0.13.4 (WASM sheets engine, d3, regl) |
| CSV/TSV | `csv-viewer.tsx` | `@glideapps/glide-data-grid` 6.0.4-alpha24, `papaparse` (already present) |
| shared | `document-viewer-sidebar.tsx` (~3 KB) | — |

hugeicons (extend's icon lib) is **not** added — icons are swapped to lucide during vendoring.

## Architecture

```
features/file-renderers/
  pdf/
    pdf-viewer.tsx        vendored EmbedPDF viewer, Kortix chrome
    pdf-renderer.tsx      adapter — keeps current API (fileContent base64 / url, compact)
  docx/
    docx-viewer.tsx       vendored, Kortix chrome
    docx-annotation-card.tsx  vendored (comments / tracked changes)
    docx-renderer.tsx     adapter — keeps current API (blob / url)
  xlsx/
    xlsx-viewer.tsx       vendored, Kortix chrome
    xlsx-renderer.tsx     adapter — keeps current API (filePath/fileName, self-loading
                          via readFileAsBlob; stays out of barrel, lazy-only)
  csv/
    csv-viewer.tsx        vendored, Kortix chrome
    csv-renderer.tsx      adapter — keeps current API (content string, compact)
  shared/
    document-viewer-sidebar.tsx   vendored, restyled
    viewer-toolbar.tsx            new — shared Kortix chrome primitives
```

- **Adapters keep today's prop contracts**, so `file-content-renderer.tsx`, `file-editors/index.tsx`, and `show-content-renderer.tsx` keep their call sites (import paths update only). Barrel exports in `index.tsx` unchanged.
- All viewers remain `lazy()`-loaded in client components; WASM engines (PDFium, sheets) load at runtime, never during SSR.
- Glide Data Grid requires a portal element: add `<div id="portal" className="fixed top-0 left-0 z-40" />` at the app root.

### Data flow

| Source shape today | Adapter behavior |
|---|---|
| PDF: base64 `fileContent` or `url` | base64 → Blob → object URL (existing `base64PdfContentToBlob`), pass as viewer `src`; revoke on unmount |
| DOCX: `blob` or `url` | blob → object URL; pass as `src` |
| XLSX: `filePath` + `fileName` | keep self-loading via `readFileAsBlob(filePath)` → object URL → viewer |
| CSV: `content` string | pass directly as viewer `data` |

## Kortix chrome

One shared toolbar vocabulary across all four viewers (`shared/viewer-toolbar.tsx`):

- **Left — context:** page `3 / 12` (PDF/DOCX), sheet tabs (XLSX), `1,204 rows × 8 cols` (CSV).
- **Right — controls:** zoom out / percent / zoom in, fit-width, rotate (PDF only), search, thumbnails/outline toggle (PDF/DOCX), download.
- Kortix design system throughout: kortix-* tokens, `rounded-md`, lucide icons, tinted icon tiles for status/error states.
- Polish requirements (from emil-design-eng + make-interfaces-feel-better):
  - `tabular-nums` on page numbers, zoom %, row/col counts.
  - `active:scale-[0.96]` on toolbar buttons; transitions on specific properties only (never `transition: all`).
  - 150–250 ms ease-out (custom cubic-bezier) for sidebar/panel enter; exits subtler and faster.
  - No animation on keyboard-initiated page jumps or search-result navigation.
  - `prefers-reduced-motion` respected on all movement.
  - Minimum 40×40 px hit areas on toolbar controls.
- **Dark mode:** wired to `next-themes` `resolvedTheme` (their `isDark`/`onIsDarkChange` props satisfied internally; toggle UI removed). PDF/DOCX pages remain white paper on a dark canvas background; XLSX/CSV grids retheme fully.
- **Compact mode:** `compact` prop hides all chrome, fit-width — used by inline tool previews (`show-content-renderer.tsx`).

## Deletions

All verified single-consumer (grep 2026-07-05):

- `docx-preview` dep + `src/types/docx-preview.d.ts`
- `@univerjs/presets`, `@univerjs/preset-sheets-core` (+ its CSS import)
- `exceljs`
- `ag-grid-community`, `ag-grid-react`, `src/components/ui/data-grid.tsx`
- `pdfjs-dist` (already orphaned — no imports in src)
- old renderer files replaced by the new folders

Kept: `papaparse`, Syncfusion `SpreadsheetViewer` (editing path, untouched), `Promise.withResolvers` polyfill in `src/lib/polyfills.ts` (still guards Safari < 17.4).

## Error handling

- Loading: `KortixLoader` overlay (current pattern) until first render/`Rendered` event.
- Failure (corrupt file, network, unsupported legacy `.doc`/`.xls`): kortix error state — tinted icon tile, friendly message, **Retry** and **Download** actions. Legacy formats stay unsupported but get this nicer dead-end instead of a raw error string.
- i18n: follow the existing next-intl `hardcodedUi` extraction pattern for user-facing strings.

## Testing

Per repo testing skill (tests ship in the same change):

- Colocated bun:test units for adapter logic: base64→blob conversion, source resolution (blob vs url vs filePath), object-URL lifecycle, compact-mode prop mapping.
- Keep/update `pdf-renderer.test.ts` for the new adapter.
- Visual verification: dev stack restart, light + dark screenshots of all four formats in full and compact modes.

## Risks

- `@glideapps/glide-data-grid@6.0.4-alpha24` is an alpha pin chosen by extend — accepted; it's what their production viewer ships.
- WASM asset serving (PDFium, sheets engine) may need a `next.config` touch or public-asset copy — verify during implementation; fallback is their default loader.
- PDF path gets heavier than an iframe (EmbedPDF suite) — acceptable: lazy-loaded, and it buys search/thumbnails/zoom/selection. XLSX/CSV get ~700 KB lighter (Univer + AG Grid removed).
