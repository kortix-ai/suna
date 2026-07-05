# File Renderers on extend.ai Viewers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four document view paths (PDF, DOCX, XLSX, CSV/TSV) in `apps/web/src/features/file-renderers/` with vendored extend.ai viewer components carrying Kortix-owned chrome, and delete the legacy engines.

**Architecture:** Each format gets a folder containing the vendored extend viewer (imports rewired to our ui primitives, hugeicons→lucide via a compat shim, upload/theme-toggle chrome stripped) plus a thin adapter that keeps today's prop contract, so consumers only change import paths. Legacy engines (iframe PDF, docx-preview, Univer+ExcelJS, AG Grid) are deleted per format as each migration lands.

**Tech Stack:** EmbedPDF ^2.14.4 (PDFium WASM, self-hosted), `@extend-ai/react-docx` ^0.7.5, `@extend-ai/react-xlsx` 0.13.4, `@glideapps/glide-data-grid` 6.0.4-alpha24, papaparse (present), lucide-react (present), next-themes (present), bun:test.

**Spec:** `docs/superpowers/specs/2026-07-05-file-renderers-extend-viewers-design.md`

**Discovery amendment to spec:** The vendored extend toolbars are already composed from our own ui primitives (`Button`, `Input`, `Select`, `Tooltip`, `Separator`, `ScrollArea`, `Tabs`, `DropdownMenu`, `Popover`) — they inherit kortix tokens automatically. "Kortix chrome" therefore means: strip upload + theme-toggle blocks, swap icons to lucide, and apply the polish pass (Task 7) — not a from-scratch toolbar rebuild. `shared/viewer-chrome.tsx` from the spec is realized as the compat shim + spinner shim + polish constants.

## Global Constraints

- All work in `apps/web`. Run commands from `apps/web` unless a path is given.
- Execution happens in a dedicated worktree (Task 0). Node 22 (`nvm use 22`) — `pnpm worktree start` fails on Node 26.
- Package manager: `pnpm`. Tests: `bun test` (co-located, `bun:test`, component assertions via `renderToStaticMarkup` — no testing-library). No comments in test files.
- Registry source of truth: `https://www.extend.ai/ui/r/{name}.json`. Vendor fetch always goes through `scripts/vendor-extend-viewer.mjs` (Task 1) so refreshes are repeatable.
- Never install `@hugeicons/*`. All vendored icon usage goes through `src/features/file-renderers/shared/hugeicons-compat.tsx`.
- Exact dep versions: `@embedpdf/*@^2.14.4`, `pdf-lib@^1.17.1`, `@extend-ai/react-docx@^0.7.5`, `@extend-ai/react-xlsx@0.13.4`, `@glideapps/glide-data-grid@6.0.4-alpha24`, `@tanstack/react-virtual@^3.13.12`, `@embedpdf/pdfium@2.14.4` (devDependency, wasm source only).
- Keep `marked@^15.0.7` (glide peer wants ^16 — accepted warning; our viewer doesn't use glide's markdown cells). Add missing glide peers `lodash` + `react-responsive-carousel`.
- New user-facing strings: plain English (the hardcodedUi i18n codemod extracts later). Existing translation keys that move files keep their keys.
- Syncfusion `SpreadsheetViewer` (XLSX editing), `papaparse`, and the `Promise.withResolvers` polyfill are untouched.
- Barrel `src/features/file-renderers/index.tsx` keeps its export names; XLSX stays out of the barrel.
- Commit after every task; prefix `refactor(web):` unless stated otherwise.

---

### Task 0: Worktree setup

**Files:** none (environment only)

- [ ] **Step 1: Create the worktree**

```bash
cd /Users/jay/root/kortix/suna
nvm use 22
pnpm worktree start file-renderers-extend
```

Expected: a new worktree (path printed by the command, conventionally a sibling `suna-file-renderers-extend` directory) on branch `file-renderers-extend`.

- [ ] **Step 2: Copy gitignored env keys (middleware 500s without them)**

```bash
cp /Users/jay/root/kortix/suna/apps/web/.env.keys <worktree>/apps/web/.env.keys
```

- [ ] **Step 3: Install and sanity-check**

```bash
cd <worktree> && pnpm install
cd apps/web && bun test src/features/file-renderers/pdf-renderer.test.ts
```

Expected: install succeeds; the existing PDF test passes (1 pass).

All subsequent tasks run inside the worktree.

---

### Task 1: Vendor tooling + shared shims + portal div

**Files:**
- Create: `apps/web/scripts/vendor-extend-viewer.mjs`
- Create: `apps/web/src/features/file-renderers/shared/hugeicons-compat.tsx`
- Create: `apps/web/src/features/file-renderers/shared/spinner.tsx`
- Create: `apps/web/src/features/file-renderers/shared/hugeicons-compat.test.tsx`
- Modify: `apps/web/src/app/layout.tsx` (portal div before `</body>`, ~line 415)

**Interfaces:**
- Produces: `node scripts/vendor-extend-viewer.mjs <registry-name> <out-dir>` — writes each registry file into `<out-dir>`.
- Produces: `hugeicons-compat.tsx` exports `HugeiconsIcon` (props `{ icon, className?, size?, strokeWidth? }`) and the aliases `ArrowLeft01Icon, ArrowRight01Icon, Comment01Icon, Download01Icon, FileDiffIcon, MinusSignCircleIcon, Moon02Icon, MoreHorizontalIcon, PlusSignCircleIcon, RotateClockwiseIcon, Search01Icon, SidebarLeftIcon, Upload01Icon` (all `LucideIcon`).
- Produces: `spinner.tsx` exports `Spinner({ className })` — KortixLoader at 16px, drop-in for the vendored `<Spinner className="size-4" />`.

- [ ] **Step 1: Write the vendor fetch script**

```js
// apps/web/scripts/vendor-extend-viewer.mjs
// Usage: node scripts/vendor-extend-viewer.mjs pdf-viewer src/features/file-renderers/pdf
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const [name, outDir] = process.argv.slice(2);
if (!name || !outDir) {
  console.error('Usage: node scripts/vendor-extend-viewer.mjs <registry-name> <out-dir>');
  process.exit(1);
}

const res = await fetch(`https://www.extend.ai/ui/r/${name}.json`);
if (!res.ok) {
  console.error(`Registry fetch failed: ${res.status}`);
  process.exit(1);
}
const item = await res.json();
mkdirSync(outDir, { recursive: true });
for (const file of item.files) {
  const target = join(outDir, basename(file.path));
  writeFileSync(target, file.content);
  console.log(`${target} (${Math.round(file.content.length / 1024)}KB)`);
}
```

- [ ] **Step 2: Write the failing compat test**

```tsx
// apps/web/src/features/file-renderers/shared/hugeicons-compat.test.tsx
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Comment01Icon,
  Download01Icon,
  FileDiffIcon,
  HugeiconsIcon,
  MinusSignCircleIcon,
  Moon02Icon,
  MoreHorizontalIcon,
  PlusSignCircleIcon,
  RotateClockwiseIcon,
  Search01Icon,
  SidebarLeftIcon,
  Upload01Icon,
} from './hugeicons-compat';

describe('hugeicons-compat', () => {
  test('every alias used by the vendored viewers is a renderable icon', () => {
    const icons = [
      ArrowLeft01Icon,
      ArrowRight01Icon,
      Comment01Icon,
      Download01Icon,
      FileDiffIcon,
      MinusSignCircleIcon,
      Moon02Icon,
      MoreHorizontalIcon,
      PlusSignCircleIcon,
      RotateClockwiseIcon,
      Search01Icon,
      SidebarLeftIcon,
      Upload01Icon,
    ];
    for (const icon of icons) {
      const html = renderToStaticMarkup(<HugeiconsIcon icon={icon} className="size-4" />);
      expect(html).toContain('<svg');
      expect(html).toContain('size-4');
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/features/file-renderers/shared/hugeicons-compat.test.tsx`
Expected: FAIL — Cannot find module './hugeicons-compat'

- [ ] **Step 4: Write the compat shim**

```tsx
// apps/web/src/features/file-renderers/shared/hugeicons-compat.tsx
'use client';

import type { LucideIcon, LucideProps } from 'lucide-react';
import {
  ChevronLeft,
  ChevronRight,
  CircleMinus,
  CirclePlus,
  Download,
  Ellipsis,
  FileDiff,
  MessageSquare,
  Moon,
  PanelLeft,
  RotateCw,
  Search,
  Upload,
} from 'lucide-react';

// Drop-in replacements for @hugeicons/core-free-icons names used by the
// vendored extend.ai viewers, so vendor diffs stay minimal on refresh.
export const ArrowLeft01Icon = ChevronLeft;
export const ArrowRight01Icon = ChevronRight;
export const Comment01Icon = MessageSquare;
export const Download01Icon = Download;
export const FileDiffIcon = FileDiff;
export const MinusSignCircleIcon = CircleMinus;
export const Moon02Icon = Moon;
export const MoreHorizontalIcon = Ellipsis;
export const PlusSignCircleIcon = CirclePlus;
export const RotateClockwiseIcon = RotateCw;
export const Search01Icon = Search;
export const SidebarLeftIcon = PanelLeft;
export const Upload01Icon = Upload;

type HugeiconsIconProps = Omit<LucideProps, 'ref'> & { icon: LucideIcon };

export function HugeiconsIcon({ icon: Icon, ...props }: HugeiconsIconProps) {
  return <Icon {...props} />;
}
```

- [ ] **Step 5: Write the spinner shim**

```tsx
// apps/web/src/features/file-renderers/shared/spinner.tsx
'use client';

import { KortixLoader } from '@/components/ui/kortix-loader';
import { cn } from '@/lib/utils';

export function Spinner({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center justify-center', className)}>
      <KortixLoader customSize={16} />
    </span>
  );
}
```

(Verify `KortixLoader` accepts `customSize` — `src/components/ui/kortix-loader.tsx:19` documents it. If the prop is named differently, match the actual name.)

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test src/features/file-renderers/shared/hugeicons-compat.test.tsx`
Expected: PASS

- [ ] **Step 7: Add the Glide portal div**

In `apps/web/src/app/layout.tsx`, directly before the closing `</body>` (line ~415):

```tsx
        <div id="portal" className="fixed left-0 top-0 z-40" />
      </body>
```

- [ ] **Step 8: Commit**

```bash
git add apps/web/scripts/vendor-extend-viewer.mjs apps/web/src/features/file-renderers/shared apps/web/src/app/layout.tsx
git commit -m "refactor(web): add extend viewer vendor tooling, icon/spinner shims, glide portal"
```

---

### Task 2: CSV/TSV viewer (Glide Data Grid)

**Files:**
- Create: `apps/web/src/features/file-renderers/csv/csv-viewer.tsx` (vendored)
- Create: `apps/web/src/features/file-renderers/csv/csv-renderer.tsx` (adapter)
- Create: `apps/web/src/features/file-renderers/csv/csv-renderer.test.tsx`
- Modify: `apps/web/src/features/file-renderers/index.tsx:7` (barrel path)
- Modify: `apps/web/src/features/file-renderers/show-content-renderer.tsx:63` (lazy path)
- Modify: `apps/web/src/features/file-viewer/file-content-renderer.tsx:58-60` (lazy path)
- Delete: `apps/web/src/features/file-renderers/csv-renderer.tsx`, `apps/web/src/components/ui/data-grid.tsx`

**Interfaces:**
- Consumes: `HugeiconsIcon` + aliases and `Spinner` from Task 1.
- Produces: `CsvRenderer({ content: string; className?: string; compact?: boolean; containerHeight?: number })` — same contract as today; exported from the barrel as `CsvRenderer`.
- Vendored `CsvViewer({ className?, data?, search? })` stays internal to the folder.

- [ ] **Step 1: Install deps**

```bash
pnpm add @glideapps/glide-data-grid@6.0.4-alpha24 lodash react-responsive-carousel
```

Expected: success; a peer warning about `marked@^16` is acceptable (documented in Global Constraints).

- [ ] **Step 2: Vendor the viewer**

```bash
node scripts/vendor-extend-viewer.mjs csv-viewer src/features/file-renderers/csv
```

Expected output: `src/features/file-renderers/csv/csv-viewer.tsx (26KB)`

- [ ] **Step 3: Rewire vendored imports**

In `csv/csv-viewer.tsx`:

1. Replace the two hugeicons import statements
   (`import { HugeiconsIcon } from "@hugeicons/react"` and the multi-line
   `import { ...Icons } from "@hugeicons/core-free-icons"`) with a single:

```tsx
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Download01Icon,
  HugeiconsIcon,
  MinusSignCircleIcon,
  MoreHorizontalIcon,
  PlusSignCircleIcon,
  Search01Icon,
  Upload01Icon,
} from "@/features/file-renderers/shared/hugeicons-compat"
```

2. `import { Spinner } from "@/components/ui/spinner"` → `import { Spinner } from "@/features/file-renderers/shared/spinner"`

3. Strip upload chrome: grep `Upload01Icon` inside the file (beyond the import) — delete the upload `<Button>`/menu-item JSX block(s) and any now-unused upload handler state (`onUpload`, file-input refs). After this, `Upload01Icon` appears only in the import line; remove it from the import too.

- [ ] **Step 4: Verify the vendored file compiles**

```bash
pnpm exec tsc --noEmit 2>&1 | grep csv-viewer
```

Expected: no output (no errors in the file). Other pre-existing errors elsewhere are out of scope.

- [ ] **Step 5: Write the failing adapter test**

```tsx
// apps/web/src/features/file-renderers/csv/csv-renderer.test.tsx
import { describe, expect, test } from 'bun:test';

import { hasCsvContent } from './csv-renderer';

describe('hasCsvContent', () => {
  test('false for empty, whitespace, or missing content', () => {
    expect(hasCsvContent('')).toBe(false);
    expect(hasCsvContent('   \n\t')).toBe(false);
    expect(hasCsvContent(undefined)).toBe(false);
  });

  test('true for actual delimited content', () => {
    expect(hasCsvContent('a,b\n1,2')).toBe(true);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test src/features/file-renderers/csv/csv-renderer.test.tsx`
Expected: FAIL — Cannot find module './csv-renderer'

- [ ] **Step 7: Write the adapter**

```tsx
// apps/web/src/features/file-renderers/csv/csv-renderer.tsx
'use client';

import { lazy, Suspense } from 'react';
import { FileSpreadsheet } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { cn } from '@/lib/utils';

const CsvViewer = lazy(() =>
  import('./csv-viewer').then((m) => ({ default: m.CsvViewer })),
);

export function hasCsvContent(content: string | undefined | null): boolean {
  return Boolean(content && content.trim().length > 0);
}

interface CsvRendererProps {
  content: string;
  className?: string;
  compact?: boolean;
  containerHeight?: number;
}

export function CsvRenderer({ content, className, compact = false, containerHeight }: CsvRendererProps) {
  if (!hasCsvContent(content)) {
    return (
      <div className={cn('flex h-full w-full items-center justify-center', className)}>
        {compact ? (
          <div className="text-sm text-muted-foreground">No data</div>
        ) : (
          <div className="space-y-4 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-muted">
              <FileSpreadsheet className="h-8 w-8 text-muted-foreground" />
            </div>
            <div>
              <h3 className="text-lg font-medium text-foreground">No data</h3>
              <p className="text-sm text-muted-foreground">This file appears to be empty or invalid.</p>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn('h-full w-full', className)}
      style={containerHeight ? { height: containerHeight } : undefined}
    >
      <Suspense
        fallback={
          <div className="flex h-full w-full items-center justify-center">
            <KortixLoader size="medium" />
          </div>
        }
      >
        <CsvViewer data={content} search={!compact} className="h-full" />
      </Suspense>
    </div>
  );
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `bun test src/features/file-renderers/csv/csv-renderer.test.tsx`
Expected: PASS (the lazy `import('./csv-viewer')` never executes in the test — Glide's canvas code stays out of bun).

- [ ] **Step 9: Update consumers and delete legacy files**

1. `src/features/file-renderers/index.tsx:7`:
   `export { CsvRenderer } from './csv-renderer';` → `export { CsvRenderer } from './csv/csv-renderer';`
2. `src/features/file-renderers/show-content-renderer.tsx:63`:
   `import('./csv-renderer')` → `import('./csv/csv-renderer')`
3. `src/features/file-viewer/file-content-renderer.tsx:58-60`:
   `import('@/features/file-renderers/csv-renderer')` → `import('@/features/file-renderers/csv/csv-renderer')`
4. Delete old files and the AG Grid deps:

```bash
git rm apps/web/src/features/file-renderers/csv-renderer.tsx apps/web/src/components/ui/data-grid.tsx
pnpm remove ag-grid-community ag-grid-react
```

5. Verify nothing still references them:

```bash
grep -rn "ag-grid\|ui/data-grid" src/ ; echo "exit: $?"
```

Expected: no matches (exit 1 from grep).

- [ ] **Step 10: Typecheck + full renderer tests + commit**

```bash
pnpm exec tsc --noEmit
bun test src/features/file-renderers
git add -A
git commit -m "refactor(web): CSV/TSV viewer on Glide Data Grid, drop AG Grid"
```

---

### Task 3: PDF viewer (EmbedPDF / PDFium)

**Files:**
- Create: `apps/web/src/features/file-renderers/pdf/pdf-viewer.tsx` (vendored)
- Create: `apps/web/src/features/file-renderers/pdf/pdf-thumbnail-utils.ts` (vendored)
- Create: `apps/web/src/features/file-renderers/shared/document-viewer-sidebar.tsx` (vendored)
- Create: `apps/web/src/features/file-renderers/pdf/pdf-renderer.tsx` (adapter)
- Move: `apps/web/src/features/file-renderers/pdf-renderer.test.ts` → `apps/web/src/features/file-renderers/pdf/pdf-renderer.test.ts`
- Create: `apps/web/scripts/copy-pdfium.mjs`
- Modify: `apps/web/package.json` (`dev`/`build` scripts), `apps/web/.gitignore`
- Modify: barrel `index.tsx:4`, `show-content-renderer.tsx:62`, `file-content-renderer.tsx:49-51`, `src/components/file-editors/index.tsx:10`
- Delete: `apps/web/src/features/file-renderers/pdf-renderer.tsx`

**Interfaces:**
- Consumes: `HugeiconsIcon` + aliases, `Spinner` (Task 1).
- Produces: `PdfRenderer({ fileContent?: string | null; url?: string | null; className?: string; compact?: boolean })` and `base64PdfContentToBlob(fileContent: string): Blob` — same contract/export names as today.
- Produces: `shared/document-viewer-sidebar.tsx` — consumed again by Task 4.

- [ ] **Step 1: Install deps**

```bash
pnpm add @embedpdf/core@^2.14.4 @embedpdf/engines@^2.14.4 @embedpdf/models@^2.14.4 \
  @embedpdf/plugin-document-manager@^2.14.4 @embedpdf/plugin-interaction-manager@^2.14.4 \
  @embedpdf/plugin-render@^2.14.4 @embedpdf/plugin-rotate@^2.14.4 @embedpdf/plugin-scroll@^2.14.4 \
  @embedpdf/plugin-search@^2.14.4 @embedpdf/plugin-selection@^2.14.4 @embedpdf/plugin-thumbnail@^2.14.4 \
  @embedpdf/plugin-tiling@^2.14.4 @embedpdf/plugin-viewport@^2.14.4 @embedpdf/plugin-zoom@^2.14.4 \
  pdf-lib@^1.17.1
pnpm add -D @embedpdf/pdfium@2.14.4
```

- [ ] **Step 2: Self-host the PDFium wasm**

```js
// apps/web/scripts/copy-pdfium.mjs
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const wasm = join(dirname(require.resolve('@embedpdf/pdfium/package.json')), 'dist/pdfium.wasm');
const out = new URL('../public/pdfium/pdfium.wasm', import.meta.url).pathname;
mkdirSync(dirname(out), { recursive: true });
copyFileSync(wasm, out);
console.log(`Copied pdfium.wasm -> ${out}`);
```

In `apps/web/package.json` scripts, prepend the copy to `dev` and `build` (pnpm does not run `predev`/`prebuild` lifecycle scripts by default):

- `"dev": "node scripts/copy-pdfium.mjs && NODE_OPTIONS=..."` (prepend to the existing long command)
- `"build": "node scripts/copy-pdfium.mjs && next build"`

Append to `apps/web/.gitignore`:

```
public/pdfium/
```

Run once now: `node scripts/copy-pdfium.mjs` — expected: `Copied pdfium.wasm -> .../public/pdfium/pdfium.wasm`.

- [ ] **Step 3: Vendor the viewer + sidebar**

```bash
node scripts/vendor-extend-viewer.mjs pdf-viewer src/features/file-renderers/pdf
node scripts/vendor-extend-viewer.mjs document-viewer-sidebar src/features/file-renderers/shared
```

Expected: `pdf/pdf-viewer.tsx (79KB)`, `pdf/pdf-thumbnail-utils.ts (2KB)`, `shared/document-viewer-sidebar.tsx (3KB)`.

- [ ] **Step 4: Rewire vendored imports in `pdf/pdf-viewer.tsx`**

1. Replace both hugeicons imports with:

```tsx
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Download01Icon,
  HugeiconsIcon,
  MinusSignCircleIcon,
  MoreHorizontalIcon,
  PlusSignCircleIcon,
  RotateClockwiseIcon,
  Search01Icon,
  SidebarLeftIcon,
  Upload01Icon,
} from "@/features/file-renderers/shared/hugeicons-compat"
```

2. `@/components/ui/spinner` → `@/features/file-renderers/shared/spinner`
3. `@/components/ui/document-viewer-sidebar` → `@/features/file-renderers/shared/document-viewer-sidebar`
4. `@/components/pdf-thumbnail-utils` → `./pdf-thumbnail-utils`

In `pdf/pdf-thumbnail-utils.ts`, replace the CDN wasm URL (line ~4):

```ts
const PDFIUM_WASM_URL = "/pdfium/pdfium.wasm"
```

(delete the now-unused `PDFIUM_VERSION` constant).

Upload chrome: leave the vendored code prop-gated — the adapter passes `showUpload={false}` and never `onPdfUpload`, so no upload UI renders. Do not delete the code paths (minimal vendor diff).

- [ ] **Step 5: Typecheck the vendored files**

```bash
pnpm exec tsc --noEmit 2>&1 | grep -E "pdf-viewer|pdf-thumbnail|document-viewer-sidebar"
```

Expected: no output.

- [ ] **Step 6: Move the existing test (it must keep passing against the new adapter)**

```bash
git mv src/features/file-renderers/pdf-renderer.test.ts src/features/file-renderers/pdf/pdf-renderer.test.ts
```

The test imports `./pdf-renderer` — unchanged relative path, now resolving to the new adapter. Run: `bun test src/features/file-renderers/pdf/pdf-renderer.test.ts`
Expected: FAIL — Cannot find module './pdf-renderer' (adapter not written yet).

- [ ] **Step 7: Write the adapter**

```tsx
// apps/web/src/features/file-renderers/pdf/pdf-renderer.tsx
'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { cn } from '@/lib/utils';
import { PDFViewer } from './pdf-viewer';

export function base64PdfContentToBlob(fileContent: string): Blob {
  const binaryString = atob(fileContent);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type: 'application/pdf' });
}

interface PdfRendererProps {
  /** Base64 PDF content returned by /file/content. */
  fileContent?: string | null;
  /** Existing PDF object URL fallback. */
  url?: string | null;
  className?: string;
  compact?: boolean;
}

export function PdfRenderer({ fileContent, url, className, compact = false }: PdfRendererProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    if (!fileContent && !url) {
      setPdfUrl(null);
      setStatus('loading');
      return;
    }

    if (fileContent) {
      try {
        const blob = base64PdfContentToBlob(fileContent);
        const nextUrl = URL.createObjectURL(blob);
        setPdfUrl(nextUrl);
        setStatus('ready');
        return () => {
          URL.revokeObjectURL(nextUrl);
        };
      } catch (err) {
        console.error('[PdfRenderer] Error creating PDF URL:', err);
        setPdfUrl(null);
        setStatus('error');
      }
      return;
    }

    setPdfUrl(url ?? null);
    setStatus(url ? 'ready' : 'loading');
  }, [fileContent, url]);

  if (status === 'loading') {
    return (
      <div className={cn('flex h-full w-full items-center justify-center', className)}>
        <KortixLoader size="medium" />
      </div>
    );
  }

  if (status === 'error' || !pdfUrl) {
    return (
      <div className={cn('flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center', className)}>
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
          <AlertTriangle className="h-4 w-4 text-muted-foreground" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">
            {tHardcodedUi.raw('componentsFileRenderersPdfRenderer.line277JsxTextFailedToLoadPdf')}
          </p>
          {!compact && (
            <p className="mt-1 text-xs text-muted-foreground">
              {tHardcodedUi.raw('componentsFileRenderersPdfRenderer.line278JsxTextTheFileMayBeCorruptedOrInaccessible')}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <PDFViewer
      src={pdfUrl}
      showToolbar={!compact}
      showUpload={false}
      className={cn('h-full w-full', className)}
    />
  );
}
```

- [ ] **Step 8: Run the moved test**

Run: `bun test src/features/file-renderers/pdf/pdf-renderer.test.ts`
Expected: PASS.

- [ ] **Step 9: Update consumers, delete the old renderer**

1. `src/features/file-renderers/index.tsx:4`: `'./pdf-renderer'` → `'./pdf/pdf-renderer'`
2. `src/features/file-renderers/show-content-renderer.tsx:62`: `import('./pdf-renderer')` → `import('./pdf/pdf-renderer')`
3. `src/features/file-viewer/file-content-renderer.tsx:49-51`: `'@/features/file-renderers/pdf-renderer'` → `'@/features/file-renderers/pdf/pdf-renderer'`
4. `src/components/file-editors/index.tsx:10`: same path swap.
5. `git rm apps/web/src/features/file-renderers/pdf-renderer.tsx`
6. `grep -rn "file-renderers/pdf-renderer" src/` — expected: no matches.

- [ ] **Step 10: Typecheck + tests + commit**

```bash
pnpm exec tsc --noEmit
bun test src/features/file-renderers
git add -A
git commit -m "refactor(web): PDF viewer on EmbedPDF/PDFium with self-hosted wasm, drop iframe"
```

---

### Task 4: DOCX viewer (@extend-ai/react-docx)

**Files:**
- Create: `apps/web/src/features/file-renderers/docx/docx-viewer.tsx` (vendored)
- Create: `apps/web/src/features/file-renderers/docx/docx-annotation-card.tsx` (vendored)
- Create: `apps/web/src/features/file-renderers/shared/file-thumbnail.tsx` (vendored)
- Create: `apps/web/src/features/file-renderers/docx/docx-renderer.tsx` (adapter)
- Create: `apps/web/src/features/file-renderers/docx/docx-renderer.test.ts`
- Modify: barrel `index.tsx:14`, `show-content-renderer.tsx:67-68`, `file-content-renderer.tsx:52-54`, `src/components/file-editors/index.tsx:15`
- Delete: `apps/web/src/features/file-renderers/docx-renderer.tsx`, `apps/web/src/types/docx-preview.d.ts`

**Interfaces:**
- Consumes: Task 1 shims, Task 3's `shared/document-viewer-sidebar.tsx`.
- Produces: `DocxRenderer({ url?: string; blob?: Blob; className?: string; compact?: boolean })` — same contract as today (compact added, default false) — plus pure helper `resolveDocxSource({ url, blob, createObjectUrl })`.

- [ ] **Step 1: Install deps**

```bash
pnpm add @extend-ai/react-docx@^0.7.5 @tanstack/react-virtual@^3.13.12
```

- [ ] **Step 2: Vendor the viewer files**

```bash
node scripts/vendor-extend-viewer.mjs docx-viewer src/features/file-renderers/docx
node scripts/vendor-extend-viewer.mjs file-thumbnail src/features/file-renderers/shared
```

Expected: `docx/docx-viewer.tsx (46KB)`, `docx/docx-annotation-card.tsx (4KB)`, `shared/file-thumbnail.tsx (6KB)`.

- [ ] **Step 3: Rewire vendored imports in `docx/docx-viewer.tsx`**

1. Replace both hugeicons imports with:

```tsx
import {
  Comment01Icon,
  Download01Icon,
  FileDiffIcon,
  HugeiconsIcon,
  MinusSignCircleIcon,
  MoreHorizontalIcon,
  PlusSignCircleIcon,
  SidebarLeftIcon,
  Upload01Icon,
} from "@/features/file-renderers/shared/hugeicons-compat"
```

2. `@/components/ui/spinner` → `@/features/file-renderers/shared/spinner`
3. `@/components/ui/document-viewer-sidebar` → `@/features/file-renderers/shared/document-viewer-sidebar`
4. `@/components/ui/file-thumbnail` → `@/features/file-renderers/shared/file-thumbnail`
5. `@/components/ui/docx-annotation-card` → `./docx-annotation-card`

- [ ] **Step 4: Strip the theme toggle**

At `docx/docx-viewer.tsx` ~line 380 there is a toolbar `<Button>` (wrapped in a Tooltip) rendering `<HugeiconsIcon icon={Moon02Icon} className="size-4" />` that calls the night-mode setter. Delete that entire button block (including its Tooltip wrapper). Then remove `Moon02Icon` from the import. Theme now flows exclusively from the adapter's `isDark` prop.

Upload chrome: prop-gated — adapter passes `showUpload={false}`; leave code paths in place.

- [ ] **Step 5: Write the failing adapter test**

```ts
// apps/web/src/features/file-renderers/docx/docx-renderer.test.ts
import { describe, expect, test } from 'bun:test';

import { resolveDocxSource } from './docx-renderer';

describe('resolveDocxSource', () => {
  test('prefers blob over url and returns a revocable object URL', () => {
    const blob = new Blob(['fake'], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const created: Blob[] = [];
    const result = resolveDocxSource({
      url: 'https://example.com/doc.docx',
      blob,
      createObjectUrl: (b) => {
        created.push(b);
        return 'blob:mock-1';
      },
    });
    expect(result).toEqual({ src: 'blob:mock-1', revocable: true });
    expect(created).toEqual([blob]);
  });

  test('falls back to url without creating an object URL', () => {
    const result = resolveDocxSource({
      url: 'https://example.com/doc.docx',
      createObjectUrl: () => {
        throw new Error('should not be called');
      },
    });
    expect(result).toEqual({ src: 'https://example.com/doc.docx', revocable: false });
  });

  test('returns null src when no source is provided', () => {
    const result = resolveDocxSource({ createObjectUrl: () => 'blob:never' });
    expect(result).toEqual({ src: null, revocable: false });
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test src/features/file-renderers/docx/docx-renderer.test.ts`
Expected: FAIL — Cannot find module './docx-renderer'

- [ ] **Step 7: Write the adapter**

```tsx
// apps/web/src/features/file-renderers/docx/docx-renderer.tsx
'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { cn } from '@/lib/utils';
import { DocxViewerPreview } from './docx-viewer';

export function resolveDocxSource({
  url,
  blob,
  createObjectUrl,
}: {
  url?: string;
  blob?: Blob;
  createObjectUrl: (blob: Blob) => string;
}): { src: string | null; revocable: boolean } {
  if (blob) {
    return { src: createObjectUrl(blob), revocable: true };
  }
  return { src: url ?? null, revocable: false };
}

interface DocxRendererProps {
  url?: string;
  blob?: Blob;
  className?: string;
  compact?: boolean;
}

export function DocxRenderer({ url, blob, className, compact = false }: DocxRendererProps) {
  const { resolvedTheme } = useTheme();
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const { src: nextSrc, revocable } = resolveDocxSource({
      url,
      blob,
      createObjectUrl: (b) => URL.createObjectURL(b),
    });
    setSrc(nextSrc);
    return () => {
      if (revocable && nextSrc) URL.revokeObjectURL(nextSrc);
    };
  }, [url, blob]);

  if (!src) {
    return (
      <div className={cn('flex h-full w-full items-center justify-center', className)}>
        <KortixLoader size="medium" />
      </div>
    );
  }

  return (
    <DocxViewerPreview
      src={src}
      isDark={resolvedTheme === 'dark'}
      onIsDarkChange={() => {}}
      showToolbar={!compact}
      showUpload={false}
      className={cn('h-full w-full', className)}
    />
  );
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `bun test src/features/file-renderers/docx/docx-renderer.test.ts`
Expected: PASS.

- [ ] **Step 9: Update consumers, delete legacy**

1. `src/features/file-renderers/index.tsx:14`: `'./docx-renderer'` → `'./docx/docx-renderer'`
2. `src/features/file-renderers/show-content-renderer.tsx:67-68`: `import('./docx-renderer')` → `import('./docx/docx-renderer')`
3. `src/features/file-viewer/file-content-renderer.tsx:52-54`: `'@/features/file-renderers/docx-renderer'` → `'@/features/file-renderers/docx/docx-renderer'`
4. `src/components/file-editors/index.tsx:15`: same path swap.
5. Delete legacy:

```bash
git rm apps/web/src/features/file-renderers/docx-renderer.tsx apps/web/src/types/docx-preview.d.ts
pnpm remove docx-preview
grep -rn "docx-preview" src/ ; echo "exit: $?"
```

Expected grep: no matches. Also check for a global `docx-container`/`docx-preview` CSS block: `grep -rn "docx-container\|docx-preview" src/app/globals.css` — if present, delete that block.

- [ ] **Step 10: Typecheck + tests + commit**

```bash
pnpm exec tsc --noEmit
bun test src/features/file-renderers
git add -A
git commit -m "refactor(web): DOCX viewer on @extend-ai/react-docx, drop docx-preview"
```

---

### Task 5: XLSX viewer (@extend-ai/react-xlsx)

**Files:**
- Create: `apps/web/src/features/file-renderers/xlsx/xlsx-viewer.tsx` (vendored)
- Create: `apps/web/src/features/file-renderers/xlsx/xlsx-renderer.tsx` (adapter)
- Create: `apps/web/src/features/file-renderers/xlsx/xlsx-renderer.test.ts`
- Modify: `show-content-renderer.tsx:64-66`, `file-content-renderer.tsx:61-63`, barrel `index.tsx:8-11` (comment only)
- Delete: `apps/web/src/features/file-renderers/xlsx-renderer.tsx`

**Interfaces:**
- Consumes: Task 1 shims; `readFileAsBlob` from `@/features/files/api/opencode-files` (existing).
- Produces: `XlsxRenderer({ content?, filePath?, fileName, className?, sandboxId?, project?, onDownload?, isDownloading? })` — identical signature to today (extra props accepted for call-site compatibility even where unused). Stays out of the barrel; lazy-imported only. Pure helper `isBlobUrl(path: string)` exported for tests.

- [ ] **Step 1: Install dep, vendor viewer**

```bash
pnpm add @extend-ai/react-xlsx@0.13.4
node scripts/vendor-extend-viewer.mjs xlsx-viewer src/features/file-renderers/xlsx
```

Expected: `xlsx/xlsx-viewer.tsx (50KB)`.

- [ ] **Step 2: Rewire vendored imports in `xlsx/xlsx-viewer.tsx`**

1. Replace both hugeicons imports with:

```tsx
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Download01Icon,
  HugeiconsIcon,
  MinusSignCircleIcon,
  MoreHorizontalIcon,
  PlusSignCircleIcon,
  Search01Icon,
  Upload01Icon,
} from "@/features/file-renderers/shared/hugeicons-compat"
```

2. `@/components/ui/spinner` → `@/features/file-renderers/shared/spinner`

- [ ] **Step 3: Strip the theme toggle**

At `xlsx/xlsx-viewer.tsx` ~line 515: delete the toolbar button block rendering `<HugeiconsIcon icon={Moon02Icon} className="size-4" />` (including its Tooltip wrapper), then remove `Moon02Icon` from the import. Upload stays prop-gated (`showUpload={false}` from the adapter).

- [ ] **Step 4: Write the failing adapter test**

```ts
// apps/web/src/features/file-renderers/xlsx/xlsx-renderer.test.ts
import { describe, expect, test } from 'bun:test';

import { isBlobUrl } from './xlsx-renderer';

describe('isBlobUrl', () => {
  test('true only for blob: URLs', () => {
    expect(isBlobUrl('blob:http://localhost/abc')).toBe(true);
    expect(isBlobUrl('/workspace/report.xlsx')).toBe(false);
    expect(isBlobUrl('https://example.com/report.xlsx')).toBe(false);
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `bun test src/features/file-renderers/xlsx/xlsx-renderer.test.ts`
Expected: FAIL — Cannot find module './xlsx-renderer'

- [ ] **Step 6: Write the adapter**

```tsx
// apps/web/src/features/file-renderers/xlsx/xlsx-renderer.tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { FileSpreadsheet, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { cn } from '@/lib/utils';
import { XlsxViewerPreview } from './xlsx-viewer';

export function isBlobUrl(path: string): boolean {
  return path.startsWith('blob:');
}

interface XlsxRendererProps {
  content?: string | null;
  filePath?: string;
  fileName: string;
  className?: string;
  sandboxId?: string;
  project?: {
    sandbox?: {
      id?: string;
      sandbox_url?: string;
    };
  };
  onDownload?: () => void;
  isDownloading?: boolean;
}

export function XlsxRenderer({ filePath, fileName, className }: XlsxRendererProps) {
  const { resolvedTheme } = useTheme();
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const xlsxPath = filePath || fileName;

  useEffect(() => {
    if (!xlsxPath) return;
    let cancelled = false;
    let objectUrl: string | null = null;

    setSrc(null);
    setError(null);

    (async () => {
      try {
        if (isBlobUrl(xlsxPath)) {
          if (!cancelled) setSrc(xlsxPath);
          return;
        }
        const { readFileAsBlob } = await import('@/features/files/api/opencode-files');
        const blob = await readFileAsBlob(xlsxPath);
        if (cancelled) return;
        if (!blob || blob.size === 0) throw new Error('Empty file received');
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      } catch (e) {
        console.error('[XlsxRenderer] Error:', e);
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load spreadsheet');
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [xlsxPath, attempt]);

  const handleRetry = useCallback(() => setAttempt((n) => n + 1), []);

  if (error) {
    return (
      <div className={cn('flex h-full w-full items-center justify-center', className)}>
        <div className="space-y-3 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-muted">
            <FileSpreadsheet className="h-8 w-8 text-muted-foreground" />
          </div>
          <div>
            <h3 className="text-lg font-medium text-foreground">Failed to load spreadsheet</h3>
            <p className="mt-1 text-xs text-muted-foreground">{error}</p>
          </div>
          <Button onClick={handleRetry} variant="outline" size="sm">
            <RefreshCw className="mr-2 h-3 w-3" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!src) {
    return (
      <div className={cn('flex h-full w-full items-center justify-center', className)}>
        <KortixLoader size="medium" />
      </div>
    );
  }

  return (
    <XlsxViewerPreview
      src={src}
      fileName={fileName}
      isDark={resolvedTheme === 'dark'}
      onIsDarkChange={() => {}}
      showUpload={false}
      className={cn('h-full w-full', className)}
    />
  );
}
```

Note the old `.xls` legacy branch is gone: `@extend-ai/react-xlsx` receives whatever bytes we hand it; if it rejects legacy `.xls`, its error surfaces through the viewer's own error UI. Our adapter error state covers fetch/empty-file failures.

- [ ] **Step 7: Run test to verify it passes**

Run: `bun test src/features/file-renderers/xlsx/xlsx-renderer.test.ts`
Expected: PASS.

- [ ] **Step 8: Update consumers, delete legacy engines**

1. `src/features/file-renderers/show-content-renderer.tsx:64-66`: `import('./xlsx-renderer')` → `import('./xlsx/xlsx-renderer')`
2. `src/features/file-viewer/file-content-renderer.tsx:61-63`: `'@/features/file-renderers/xlsx-renderer'` → `'@/features/file-renderers/xlsx/xlsx-renderer'`
3. Barrel `index.tsx:8-11`: update the comment block to point at `./xlsx/xlsx-renderer` (still not exported).
4. Delete legacy:

```bash
git rm apps/web/src/features/file-renderers/xlsx-renderer.tsx
pnpm remove @univerjs/presets @univerjs/preset-sheets-core exceljs
grep -rn "univerjs\|exceljs" src/ ; echo "exit: $?"
```

Expected grep: no matches (the Univer CSS import lived inside the deleted file).

- [ ] **Step 9: Typecheck + tests + commit**

```bash
pnpm exec tsc --noEmit
bun test src/features/file-renderers
git add -A
git commit -m "refactor(web): XLSX viewer on @extend-ai/react-xlsx, drop Univer + ExcelJS"
```

---

### Task 6: Dead dependency sweep + full gates

**Files:**
- Modify: `apps/web/package.json` (remove `pdfjs-dist`)

**Interfaces:** none new.

- [ ] **Step 1: Remove the orphaned pdfjs-dist**

```bash
grep -rn "pdfjs" src/ --include='*.ts*' | grep -v "polyfills.ts"
```

Expected: no matches (only the comment in `src/lib/polyfills.ts` mentions it — update that comment to say the polyfill guards Safari < 17.4 generally, and delete the pdfjs-dist sentence).

```bash
pnpm remove pdfjs-dist
```

- [ ] **Step 2: Verify no stragglers from any migration**

```bash
grep -rn "docx-preview\|univerjs\|exceljs\|ag-grid\|hugeicons\|pdfjs-dist" src/ package.json ; echo "exit: $?"
```

Expected: no matches.

- [ ] **Step 3: Full gates**

```bash
pnpm exec tsc --noEmit
bun test src
pnpm build
```

Expected: typecheck clean; test suite passes (same pass count as `main` plus the new renderer tests); build succeeds — watch the build output for wasm/asset warnings from `@extend-ai/react-xlsx` (its `duke_sheets_wasm_bg.wasm` loads via bundler asset handling; if turbopack chokes, the known fix is serving it like pdfium — copy to `public/` and configure the loader — flag before improvising).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(web): drop orphaned pdfjs-dist, finish legacy renderer sweep"
```

---

### Task 7: Kortix polish pass + visual verification

**Files:**
- Modify: `pdf/pdf-viewer.tsx`, `docx/docx-viewer.tsx`, `xlsx/xlsx-viewer.tsx`, `csv/csv-viewer.tsx` (toolbar polish, in place)

**Interfaces:** none new — class-level changes only.

- [ ] **Step 1: Apply the polish checklist to each vendored toolbar**

Work file by file (pdf, docx, xlsx, csv). For each toolbar region:

1. **Tabular numbers** — every dynamic number (page `x / y` indicator, zoom percentage `Select`/trigger text, row/column counts, search result `n of m`): add `tabular-nums` to the element's className.
2. **Scale on press** — every toolbar icon `<Button>`: add `active:scale-[0.96] transition-transform` (exactly 0.96; buttons that only open menus included).
3. **Transition specificity** — grep each file for `transition-all`; replace with the specific property (`transition-colors`, `transition-transform`, or `transition-[margin-left]` for the thumbnail sidebar slide).
4. **Sidebar motion** — the PDF/DOCX thumbnail sidebar open/close (the `-ml-40` margin swap): ensure the transition is `transition-[margin-left] duration-200 ease-out` and wrap with a `motion-reduce:transition-none` variant.
5. **Hit areas** — toolbar icon buttons must be at least `size-8` visible with the 40px rule satisfied by toolbar padding; bump any `size-6`/`h-6` icon button to `size-8`.
6. **No keyboard animation** — verify page-jump via the page-number input and search-result navigation call scroll functions without smooth-scroll animation (search for `behavior: "smooth"` in scroll calls triggered by keyboard/search paths; change those to `"auto"`; pointer-initiated thumbnail clicks may keep smooth).

Record every change; the task's commit message body lists them as Before/After pairs.

- [ ] **Step 2: Typecheck + tests**

```bash
pnpm exec tsc --noEmit
bun test src/features/file-renderers
```

Expected: both clean.

- [ ] **Step 3: Visual verification (all four formats, light + dark, full + compact)**

1. Start the dev stack from the worktree root: `nvm use 22 && pnpm dev` (frontend on the worktree's assigned port).
2. Prepare fixtures: drop `sample.pdf`, `sample.docx`, `sample.xlsx`, `sample.csv` into an existing project workspace (any seeded local project; create files via the app's file upload).
3. For each format: open in the file viewer — verify toolbar renders (zoom, search, thumbnails where applicable), pages/grid render correctly, dark mode toggle of the app retints chrome (document pages stay white paper on dark canvas; CSV/XLSX grids retheme), compact/inline tool preview renders chrome-less.
4. Screenshot each (8 shots minimum: 4 formats × light/dark). Use the authed-Playwright magic-link cookie trick if auth blocks headless capture.
5. Fix anything broken before committing; re-screenshot after fixes.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "polish(web): kortix polish pass on document viewer chrome"
```

---

## Post-plan

After all tasks: run the repo's finishing flow (superpowers:finishing-a-development-branch) — push the branch, open a PR against `main` referencing the spec, attach the light/dark screenshots from Task 7 to the PR description.
