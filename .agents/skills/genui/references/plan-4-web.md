# Generative UI — plan 4: web (`apps/web`, also the Electron desktop shell)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. ALSO REQUIRED before the first `className`: `.agents/skills/kortix-brand/SKILL.md`, then `.agents/skills/kortix-design-system/SKILL.md`. Before Task 8: `agent-browser skills get core`.

**Goal:** Assistant messages on web and desktop render ```` ```openui ```` blocks as Kortix-native cards, comparisons, charts, maps, tabs, and accordions while streaming, with a per-user off switch, markdown on copy/export, and one telemetry event per live block.

**Architecture:** `MarkdownCode` (the one place every fence resolves) detects the fence with `genuiVersionFromClassName` and renders a lazily loaded `GenuiMessageBlock`. That component passes `webGenuiComponents` (built on `@/components/ui/*`) to the SDK's `GenuiBlock`. Charts (recharts) and the map (mapcn + maplibre-gl) are separate lazy chunks. Images and links reuse the markdown renderer's own `MarkdownImage` / `MarkdownLink`, so trust policy, sandbox proxying, and click-to-load stay identical to markdown.

**Tech Stack:** Next.js 16, React 19, Streamdown, `@kortix/sdk/genui/react`, recharts 3 (already a dependency), mapcn (MIT) + maplibre-gl 6, Phosphor icons, next-intl, Bun test + `react-dom/server`, agent-browser.

**Spec:** `.agents/skills/genui/references/spec.md` §6, §8.1 R-WEB-1, R-STREAM-1 (web), R-A11Y-1, R-OBS-1, §8.4. Master plan: `plan.md` (deltas D8, Global Constraints).

**Depends on:** plan-1 (SDK). Independent of plan-3 for code; Task 8 verification needs plan-3 merged into the branch.

## Global Constraints

See `plan.md`. Specific to this plan:
- `MARKDOWN_COMPONENTS` in `unified-markdown.tsx` keeps a stable identity (its comment at L72-83): values that change go through `MarkdownRenderContext`, never through a rebuilt components object.
- No new spinner: pending heavy nodes use `Loading` from `@/components/ui/loading`.
- Icons: `@phosphor-icons/react` with the `*Icon` names. mapcn ships `lucide-react` imports; Task 5 replaces them.
- Reserved heights (no layout jump): Table pending 160px, charts 220px (matches `cost-chart.tsx`), map 280px.
- `.agents/skills/kortix-brand/scripts/audit.sh <changed files>` is clean before the PR.

## Review Focus

- Unterminated ```` ```openui ```` fence after the stream ends (turn aborted mid-block): Streamdown treats an unclosed fence as running to the end, so `MarkdownCode` still receives `language-openui` with partial code and `isStreaming=false`. Pinned in Task 1 ("partial block after the stream ends renders no source").
- A share page (`trust="untrusted"`) shows a block: images must stay click-to-load. Pinned in Task 3 (Image uses `MarkdownImage`, which applies `policy.remoteImages`).

---

### Task 1: Route ```` ```openui ```` fences to the generative UI block

**Files:**
- Modify: `apps/web/package.json` (dependency `"@openuidev/lang-core": "0.3.1"`)
- Modify: `apps/web/src/components/markdown/code/markdown-code.tsx`
- Modify: `apps/web/src/components/markdown/unified-markdown.tsx` (context value gains `trust`; `code` renderer passes it; export `useMarkdownRenderContext`, `MarkdownImage`, `MarkdownLink`)
- Create: `apps/web/src/features/genui/genui-message-block.tsx` (minimal in this task; Task 2 completes it)
- Test: `apps/web/src/components/markdown/code/markdown-code.test.tsx` (extend)

**Interfaces:**
- Consumes: `genuiVersionFromClassName` (plan-1).
- Produces: `MarkdownCodeProps.trust?: MarkdownTrust`; `GenuiMessageBlock({ code, version, isStreaming, trust })` default export; `useMarkdownRenderContext(): { isStreaming: boolean; proxy: (url?: string) => string | undefined; policy: Readonly<MarkdownPolicy>; trust: MarkdownTrust }`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/components/markdown/code/markdown-code.test.tsx` (it already imports `describe`, `expect`, `test`, `renderToStaticMarkup`, `MarkdownCode`, and defines `render`):

```tsx
describe('generative UI fences', () => {
  const block = 'root = Stack([b])\nb = Badge("ok")';
  for (const className of ['language-openui', 'language-openui-lang']) {
    test(`${className} never renders the code card or its source`, () => {
      const html = render({ children: block, className, isStreaming: false });
      expect(html).not.toContain('root = Stack');
      expect(html).not.toContain('<pre');
    });
  }

  test('partial block after the stream ends renders no source', () => {
    const html = render({ children: 'root = Stack([b])\nb = Bad', className: 'language-openui', isStreaming: false });
    expect(html).not.toContain('root = Stack');
  });

  test('other fences keep the code card', () => {
    const html = render({ children: 'const a = 1', className: 'language-ts', isStreaming: false });
    expect(html).toContain('const a = 1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && bun test src/components/markdown/code/markdown-code.test.tsx`
Expected: FAIL — the openui cases render the Shiki code card containing `root = Stack`.

- [ ] **Step 3: Add the dependency and the context field**

Add `"@openuidev/lang-core": "0.3.1"` to `apps/web/package.json` dependencies (zod 3.25.76 is already there); `pnpm install --filter Kortix-Computer-Frontend` (the `name` in `apps/web/package.json`).

In `unified-markdown.tsx`:

```tsx
interface MarkdownRenderContextValue {
  isStreaming: boolean;
  proxy: (url: string | undefined) => string | undefined;
  policy: Readonly<MarkdownPolicy>;
  trust: MarkdownTrust;
}

const MarkdownRenderContext = React.createContext<MarkdownRenderContextValue>({
  isStreaming: false,
  proxy: (url) => url,
  policy: markdownPolicy('untrusted'),
  trust: 'untrusted',
});

/** For components rendered inside markdown (generative UI): the same policy, proxy, and trust. */
export function useMarkdownRenderContext(): MarkdownRenderContextValue {
  return useContext(MarkdownRenderContext);
}
```

In `UnifiedMarkdown`, include `trust` in the memoized value:

```tsx
    const renderContext = useMemo(
      () => ({ isStreaming, proxy, policy, trust }),
      [isStreaming, proxy, policy, trust],
    );
```

Change the `code` renderer to pass trust:

```tsx
  code: function MarkdownCodeRenderer(props: { children?: React.ReactNode; className?: string }) {
    const { isStreaming, policy, trust } = useContext(MarkdownRenderContext);
    return <MarkdownCode {...props} isStreaming={isStreaming} setupLinks={policy.setupLinks} trust={trust} />;
  },
```

Move the bodies of `MARKDOWN_COMPONENTS.a` (L133) and `MARKDOWN_COMPONENTS.img` (L269) into two exported named functions above the object, and reference them from the object, so identity stays stable:

```tsx
export function MarkdownLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  // body moved verbatim from MARKDOWN_COMPONENTS.a
}

export function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  // body moved verbatim from MARKDOWN_COMPONENTS.img
}

const MARKDOWN_COMPONENTS = {
  // …
  a: MarkdownLink,
  // …
  img: MarkdownImage,
  // …
};
```

- [ ] **Step 4: Route the fence**

`apps/web/src/features/genui/genui-message-block.tsx` (minimal; Task 2 replaces the body):

```tsx
'use client';

import type { MarkdownTrust } from '@/components/markdown/markdown-policy';

export interface GenuiMessageBlockProps {
  code: string;
  version: number;
  isStreaming: boolean;
  trust: MarkdownTrust;
}

export default function GenuiMessageBlock(_props: GenuiMessageBlockProps) {
  return null;
}
```

In `markdown-code.tsx`, add imports and the lazy component next to `MermaidRenderer`:

```tsx
import type { MarkdownTrust } from '@/components/markdown/markdown-policy';
import { genuiVersionFromClassName } from '@kortix/sdk/genui';

// Generative UI pulls in lang-core and the block components; load it only once a block exists.
const GenuiMessageBlock = lazy(() => import('@/features/genui/genui-message-block'));
```

Add to `MarkdownCodeProps`:

```tsx
  /** Writer trust of the surrounding markdown; generative UI fallbacks render with the same trust. */
  trust?: MarkdownTrust;
```

and, as the first statement inside `MarkdownCode` after `const code = …`:

```tsx
  const genuiVersion = genuiVersionFromClassName(codeClassName);
  if (genuiVersion !== null) {
    return (
      <Suspense fallback={null}>
        <GenuiMessageBlock code={code} version={genuiVersion} isStreaming={Boolean(isStreaming)} trust={trust ?? 'untrusted'} />
      </Suspense>
    );
  }
```

Destructure `trust` in the function parameters.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd apps/web && bun test src/components/markdown/code/markdown-code.test.tsx src/components/markdown/unified-markdown.test.tsx src/components/markdown/stream-words.test.ts
npx tsc --noEmit -p . 2>&1 | rg -v "preview-fit.test|easy-panel-logic.test" | rg "error TS" | head
```

Expected: tests PASS; no new `error TS` lines (the ~15 known errors in the 2 listed test files are filtered).

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/components/markdown apps/web/src/features/genui
git commit -m "feat(web): route openui fences to the generative UI block"
```

---

### Task 2: `GenuiMessageBlock` — renderer, fallback, preference, telemetry

**Files:**
- Modify: `apps/web/src/features/genui/genui-message-block.tsx`
- Create: `apps/web/src/features/genui/use-genui-enabled.ts`
- Modify: `apps/web/src/stores/user-preferences-store.ts`
- Modify: `apps/web/src/lib/track.ts`
- Test: `apps/web/src/features/genui/genui-message-block.test.tsx`

**Interfaces:**
- Consumes: `GenuiBlock`, `GenuiBlockEvent`, `GenuiNode` (plan-1); `UnifiedMarkdown`; `webGenuiComponents`, `GenuiPending` (Task 3; this task imports them, so create Task 3's `components/index.ts` and `components/pending.tsx` exactly as written there before Step 4).
- Produces: `useGenuiEnabled(): boolean`; store field `preferences.genuiEnabled?: boolean`, action `setGenuiEnabled(enabled: boolean)`; `PANEL_EVENTS` gains `'genui_block'`.

- [ ] **Step 1: Write the failing test**

`apps/web/src/features/genui/genui-message-block.test.tsx`:

```tsx
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { PANEL_EVENTS } from '@/lib/track';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';

import GenuiMessageBlock from './genui-message-block';

const CODE = 'root = Stack([a, b])\na = Stat("Revenue", "12k")\nb = Callout("info", "Book by Friday")';
const html = () =>
  renderToStaticMarkup(<GenuiMessageBlock code={CODE} version={1} isStreaming={false} trust="agent" />);

describe('GenuiMessageBlock', () => {
  test('renders the block as UI by default', () => {
    useUserPreferencesStore.setState((s) => ({ preferences: { ...s.preferences, genuiEnabled: undefined } }));
    const out = html();
    expect(out).toContain('Revenue');
    expect(out).toContain('Book by Friday');
    expect(out).not.toContain('root = Stack');
  });

  test('the personal off switch renders the markdown fallback', () => {
    useUserPreferencesStore.getState().setGenuiEnabled(false);
    const out = html();
    expect(out).toContain('<strong>Revenue:</strong> 12k');
    useUserPreferencesStore.getState().setGenuiEnabled(true);
  });

  test('genui_block is a closed telemetry event', () => {
    expect(PANEL_EVENTS).toContain('genui_block');
  });
});
```

(If the store test needs localStorage, stub both `localStorage` and `window.localStorage` at the top of the file, as other store tests in `apps/web` do — see `rg -l "localStorage" apps/web/src/stores/*.test.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun test src/features/genui/genui-message-block.test.tsx`
Expected: FAIL — `setGenuiEnabled` is not a function; `PANEL_EVENTS` lacks `genui_block`; the stub renders nothing.

- [ ] **Step 3: Store, hook, and event**

`apps/web/src/stores/user-preferences-store.ts`: add to `UserPreferences`:

```ts
  /**
   * Render generative UI blocks as UI (true) or as their markdown fallback (false).
   * Legacy persisted preferences predate this key: read sites use `?? true`.
   */
  genuiEnabled?: boolean;
```

add `genuiEnabled: true,` to `DEFAULT_PREFERENCES`, `setGenuiEnabled: (enabled: boolean) => void;` to `UserPreferencesState`, and next to `setConversationDensity`:

```ts
      setGenuiEnabled: (enabled) => get().patchPreferences({ genuiEnabled: enabled }),
```

`apps/web/src/features/genui/use-genui-enabled.ts`:

```ts
import { useUserPreferencesStore } from '@/stores/user-preferences-store';

/** The viewer's generative UI preference. Default on. */
export function useGenuiEnabled(): boolean {
  return useUserPreferencesStore((s) => s.preferences.genuiEnabled ?? true);
}
```

`apps/web/src/lib/track.ts`: add `'genui_block',` as the last entry of `PANEL_EVENTS`.

- [ ] **Step 4: The real block**

`apps/web/src/features/genui/genui-message-block.tsx`:

```tsx
'use client';

import { useCallback, useRef } from 'react';
import { GenuiBlock, type GenuiBlockEvent } from '@kortix/sdk/genui/react';

import type { MarkdownTrust } from '@/components/markdown/markdown-policy';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { track } from '@/lib/track';

import { GenuiPending, webGenuiComponents } from './components';
import { useGenuiEnabled } from './use-genui-enabled';

export interface GenuiMessageBlockProps {
  code: string;
  version: number;
  isStreaming: boolean;
  trust: MarkdownTrust;
}

export default function GenuiMessageBlock({ code, version, isStreaming, trust }: GenuiMessageBlockProps) {
  const enabled = useGenuiEnabled();
  // Only blocks the viewer watched stream count: a settled block that remounts (scroll, reload)
  // must not report again.
  const sawStreaming = useRef(isStreaming);
  if (isStreaming) sawStreaming.current = true;

  const renderMarkdown = useCallback(
    (markdown: string) => (markdown ? <UnifiedMarkdown content={markdown} trust={trust} /> : null),
    [trust],
  );

  const report = useCallback((event: GenuiBlockEvent) => {
    if (!sawStreaming.current) return;
    track('genui_block', {
      outcome: event.outcome,
      components: event.components.join(','),
      ms_to_first_paint: event.msToFirstPaint ?? -1,
      issue_count: event.issueCount,
      platform: 'web',
    });
  }, []);

  return (
    <div className="my-4" data-genui-block="">
      <GenuiBlock
        code={code}
        version={version}
        streaming={isStreaming}
        enabled={enabled}
        components={webGenuiComponents}
        renderMarkdown={renderMarkdown}
        renderPending={GenuiPending}
        onSettled={report}
      />
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web && bun test src/features/genui/genui-message-block.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/genui apps/web/src/stores/user-preferences-store.ts apps/web/src/lib/track.ts
git commit -m "feat(web): generative UI block with personal off switch and live-only telemetry"
```

---

### Task 3: Layout, data, and inline components

**Files:**
- Create: `apps/web/src/features/genui/components/layout.tsx` (Stack, Card, Tabs, Accordion)
- Create: `apps/web/src/features/genui/components/data.tsx` (Stat, StatRow, Table, Compare, RankedList)
- Create: `apps/web/src/features/genui/components/inline.tsx` (Badge, Callout, Image, Link)
- Create: `apps/web/src/features/genui/components/pending.tsx`
- Create: `apps/web/src/features/genui/components/index.ts`
- Test: `apps/web/src/features/genui/components/components.test.tsx`

**Interfaces:**
- Consumes: `GenuiComponentProps`, `GenuiComponentMap`, `GenuiNode` (plan-1); `MarkdownImage`, `MarkdownLink` (Task 1).
- Produces: `webGenuiComponents: GenuiComponentMap` (Tasks 4–5 add `BarChart`, `LineChart`, `PieChart`, `Map`); `GenuiPending(node: GenuiNode): ReactNode`.

- [ ] **Step 1: Write the failing test**

`apps/web/src/features/genui/components/components.test.tsx`:

```tsx
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { GenuiBlock } from '@kortix/sdk/genui/react';

import { GenuiPending, webGenuiComponents } from './index';

const md = (markdown: string) => <pre data-fallback="">{markdown}</pre>;
const render = (code: string) =>
  renderToStaticMarkup(
    <GenuiBlock code={code} streaming={false} components={webGenuiComponents} renderMarkdown={md} renderPending={GenuiPending} />,
  );

describe('web genui components', () => {
  test('layout, data, and inline components render without falling back', () => {
    const html = render(`root = Stack([top, bottom])
top = Stack([stats, card, table, cmp, list])
bottom = Stack([tabs, acc, note, link])
stats = StatRow([s1, s2])
s1 = Stat("Revenue", "12k", "+4%", "up")
s2 = Stat("Users", "900")
card = Card("Option A", "Close to the venue", "4.7 stars", null, null, [tag])
tag = Badge("Top pick", "good")
table = Table(["Name", "Value"], [["a", 1]], "Sample")
cmp = Compare([x, y], ["Price"], "X")
x = CompareItem("X", ["$10"], ["Cheap"])
y = CompareItem("Y", ["$20"], [], ["Pricey"])
list = RankedList([r1])
r1 = RankedItem("First", "Best overall")
tabs = Tabs([t1, t2])
t1 = Tab("One", [b1])
t2 = Tab("Two", [b2])
b1 = Badge("first")
b2 = Badge("second")
acc = Accordion([a1])
a1 = AccordionItem("Details", [b1])
note = Callout("warn", "Check the dates", "Note")
link = Link("Book", "https://example.com/book")`);
    for (const text of ['Revenue', '+4%', 'Option A', 'Top pick', 'Sample', 'Cheap', 'Pricey', 'First', 'One', 'Details', 'Check the dates', 'https://example.com/book']) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain('data-fallback');
  });

  test('pending heavy nodes reserve height; pending text nodes render nothing', () => {
    const table = renderToStaticMarkup(<>{GenuiPending({ id: 't', type: 'Table', props: {}, partial: true })}</>);
    expect(table).toContain('min-h-[160px]');
    const stat = renderToStaticMarkup(<>{GenuiPending({ id: 's', type: 'Stat', props: {}, partial: true })}</>);
    expect(stat).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun test src/features/genui/components/components.test.tsx`
Expected: FAIL — `Cannot find module './index'`.

- [ ] **Step 3: Pending**

`apps/web/src/features/genui/components/pending.tsx`:

```tsx
import type { ReactNode } from 'react';
import type { GenuiNode } from '@kortix/sdk/genui';

import Loading from '@/components/ui/loading';

/** Final heights of the components that would otherwise jump when they finish streaming. */
const RESERVED: Record<string, string> = {
  Table: 'min-h-[160px]',
  BarChart: 'min-h-[220px]',
  LineChart: 'min-h-[220px]',
  PieChart: 'min-h-[220px]',
  Map: 'min-h-[280px]',
};

/** A node the model has not finished. Heavy nodes hold their space with the one Kortix spinner; text nodes wait invisibly. */
export function GenuiPending(node: GenuiNode): ReactNode {
  const reserved = RESERVED[node.type];
  if (!reserved) return null;
  return (
    <div className={`${reserved} border-border flex w-full items-center justify-center rounded-lg border`} aria-busy="true">
      <Loading />
    </div>
  );
}
```

- [ ] **Step 4: Layout components**

`apps/web/src/features/genui/components/layout.tsx`:

```tsx
'use client';

import type { GenuiNode } from '@kortix/sdk/genui';
import type { GenuiComponentProps } from '@kortix/sdk/genui/react';

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

import { MarkdownImage, MarkdownLink } from '@/components/markdown/unified-markdown';

export const kids = (value: unknown): GenuiNode[] => (Array.isArray(value) ? (value as GenuiNode[]) : []);

export function GenuiStack({ props, renderChild }: GenuiComponentProps) {
  const row = props.direction === 'row';
  return (
    <div className={cn('gap-3', row ? 'flex flex-wrap [&>*]:min-w-[12rem] [&>*]:flex-1' : 'flex flex-col')}>
      {kids(props.children).map(renderChild)}
    </div>
  );
}

export function GenuiCard({ props, renderChild }: GenuiComponentProps) {
  const title = props.href ? <MarkdownLink href={props.href}>{props.title}</MarkdownLink> : props.title;
  return (
    <Card>
      {props.image ? <MarkdownImage src={props.image} alt="" /> : null}
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {props.subtitle ? <CardDescription>{props.subtitle}</CardDescription> : null}
      </CardHeader>
      {props.body || kids(props.badges).length > 0 ? (
        <CardContent className="flex flex-col gap-2">
          {props.body ? <p className="text-sm">{props.body}</p> : null}
          {kids(props.badges).length > 0 ? <div className="flex flex-wrap gap-1.5">{kids(props.badges).map(renderChild)}</div> : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

export function GenuiTabs({ props, renderChild, streaming }: GenuiComponentProps) {
  const tabs = kids(props.tabs);
  if (tabs.length === 0) return null;
  // While streaming, show the tab being written so progress is visible (spec §6.3).
  const value = streaming ? tabs[tabs.length - 1]!.id : undefined;
  return (
    <Tabs defaultValue={tabs[0]!.id} value={value}>
      <TabsList>
        {tabs.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id}>
            {String(tab.props.label)}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.id} value={tab.id} className="flex flex-col gap-3 pt-3">
          {kids(tab.props.children).map(renderChild)}
        </TabsContent>
      ))}
    </Tabs>
  );
}

export function GenuiAccordion({ props, renderChild }: GenuiComponentProps) {
  const items = kids(props.items);
  return (
    <Accordion type="multiple">
      {items.map((item) => (
        <AccordionItem key={item.id} value={item.id}>
          <AccordionTrigger>{String(item.props.title)}</AccordionTrigger>
          <AccordionContent className="flex flex-col gap-3">{kids(item.props.children).map(renderChild)}</AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

```

(Check `accordion.tsx`: if its `Accordion` does not accept `type="multiple"`, use the prop it does accept for multi-open; check `card.tsx` for the header/title pattern used in `/design-system` and match it.)

- [ ] **Step 5: Data components**

`apps/web/src/features/genui/components/data.tsx`:

```tsx
'use client';

import type { GenuiComponentProps } from '@kortix/sdk/genui/react';
import { ArrowDownRightIcon, ArrowUpRightIcon, MinusIcon } from '@phosphor-icons/react';

import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { MarkdownLink } from '@/components/markdown/unified-markdown';

import { kids } from './layout';

const TREND = { up: ArrowUpRightIcon, down: ArrowDownRightIcon, flat: MinusIcon } as const;

export function GenuiStat({ props }: GenuiComponentProps) {
  const Trend = props.trend ? TREND[props.trend as keyof typeof TREND] : null;
  return (
    <div className="border-border flex min-w-[8rem] flex-col gap-1 rounded-lg border p-3">
      <span className="text-muted-foreground text-xs">{props.label}</span>
      <span className="text-xl font-semibold tabular-nums">
        {props.value}
        {props.unit ? <span className="text-muted-foreground text-sm font-normal"> {props.unit}</span> : null}
      </span>
      {props.delta ? (
        <span className="text-muted-foreground flex items-center gap-1 text-xs tabular-nums">
          {Trend ? <Trend className="size-3.5" aria-hidden /> : null}
          {props.delta}
        </span>
      ) : null}
    </div>
  );
}

export function GenuiStatRow({ props, renderChild }: GenuiComponentProps) {
  return <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{kids(props.stats).map(renderChild)}</div>;
}

export function GenuiTable({ props }: GenuiComponentProps) {
  const columns = props.columns as string[];
  const rows = props.rows as unknown[][];
  return (
    <div className="border-border overflow-x-auto rounded-lg border">
      <Table>
        {props.caption ? <TableCaption>{props.caption}</TableCaption> : null}
        <TableHeader>
          <TableRow>
            {columns.map((column, i) => (
              <TableHead key={i}>{column}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, r) => (
            <TableRow key={r}>
              {columns.map((_, c) => (
                <TableCell key={c} className={cn(typeof row[c] === 'number' && 'tabular-nums text-right')}>
                  {String(row[c] ?? '')}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function GenuiCompare({ props }: GenuiComponentProps) {
  const items = kids(props.items);
  const specs = (props.specs as string[] | undefined) ?? [];
  return (
    <div className="border-border overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead />
            {items.map((item) => (
              <TableHead key={item.id} className={cn(props.winner === item.props.name && 'text-foreground font-semibold')}>
                {String(item.props.name)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {specs.map((spec, i) => (
            <TableRow key={spec}>
              <TableCell className="text-muted-foreground">{spec}</TableCell>
              {items.map((item) => (
                <TableCell key={item.id}>{(item.props.values as string[])[i] ?? '—'}</TableCell>
              ))}
            </TableRow>
          ))}
          <TableRow>
            <TableCell />
            {items.map((item) => (
              <TableCell key={item.id} className="align-top text-sm">
                <ul className="flex flex-col gap-1">
                  {((item.props.pros as string[] | undefined) ?? []).map((pro) => (
                    <li key={`+${pro}`}>+ {pro}</li>
                  ))}
                  {((item.props.cons as string[] | undefined) ?? []).map((con) => (
                    <li key={`-${con}`} className="text-muted-foreground">
                      − {con}
                    </li>
                  ))}
                </ul>
              </TableCell>
            ))}
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

export function GenuiRankedList({ props }: GenuiComponentProps) {
  return (
    <ol className="flex flex-col gap-2">
      {kids(props.items).map((item, index) => (
        <li key={item.id} className="border-border flex gap-3 rounded-lg border p-3">
          <span className="text-muted-foreground w-5 shrink-0 text-sm tabular-nums">{index + 1}</span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium">
              {item.props.href ? <MarkdownLink href={String(item.props.href)}>{String(item.props.title)}</MarkdownLink> : String(item.props.title)}
              {item.props.meta ? <span className="text-muted-foreground font-normal"> · {String(item.props.meta)}</span> : null}
            </span>
            <span className="text-muted-foreground text-sm">{String(item.props.reason)}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 6: Inline components and the map**

`apps/web/src/features/genui/components/inline.tsx`:

```tsx
'use client';

import type { GenuiComponentProps } from '@kortix/sdk/genui/react';
import { CheckCircleIcon, InfoIcon, WarningIcon } from '@phosphor-icons/react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { MarkdownImage, MarkdownLink } from '@/components/markdown/unified-markdown';

const BADGE_VARIANT = { neutral: 'secondary', good: 'default', warn: 'outline', bad: 'destructive' } as const;
const CALLOUT_ICON = { info: InfoIcon, warn: WarningIcon, success: CheckCircleIcon } as const;

export function GenuiBadge({ props }: GenuiComponentProps) {
  return <Badge variant={BADGE_VARIANT[(props.tone ?? 'neutral') as keyof typeof BADGE_VARIANT]}>{props.label}</Badge>;
}

export function GenuiCallout({ props }: GenuiComponentProps) {
  const Icon = CALLOUT_ICON[props.tone as keyof typeof CALLOUT_ICON] ?? InfoIcon;
  return (
    <Alert>
      <Icon aria-hidden />
      {props.title ? <AlertTitle>{props.title}</AlertTitle> : null}
      <AlertDescription>{props.body}</AlertDescription>
    </Alert>
  );
}

export function GenuiImage({ props }: GenuiComponentProps) {
  return (
    <figure className="flex flex-col gap-1">
      <MarkdownImage src={props.src} alt={props.alt} />
      {props.caption ? <figcaption className="text-muted-foreground text-xs">{props.caption}</figcaption> : null}
    </figure>
  );
}

export function GenuiLink({ props }: GenuiComponentProps) {
  return <MarkdownLink href={props.href}>{props.label}</MarkdownLink>;
}
```

(Check `badge.tsx` variant names — the excerpt shows `default`, `secondary`, `destructive`, `outline`, and a `solid` default parameter; check `alert.tsx` for how an icon child is placed. Adjust to the real APIs; do not add variants.)

`apps/web/src/features/genui/components/index.ts` (Tasks 4–5 add the chart and map lines):

```ts
import type { GenuiComponentMap } from '@kortix/sdk/genui/react';

import { GenuiCompare, GenuiRankedList, GenuiStat, GenuiStatRow, GenuiTable } from './data';
import { GenuiBadge, GenuiCallout, GenuiImage, GenuiLink } from './inline';
import { GenuiAccordion, GenuiCard, GenuiStack, GenuiTabs } from './layout';

export { GenuiPending } from './pending';

export const webGenuiComponents: GenuiComponentMap = {
  Stack: GenuiStack,
  Card: GenuiCard,
  Tabs: GenuiTabs,
  Accordion: GenuiAccordion,
  Stat: GenuiStat,
  StatRow: GenuiStatRow,
  Table: GenuiTable,
  Compare: GenuiCompare,
  RankedList: GenuiRankedList,
  Badge: GenuiBadge,
  Callout: GenuiCallout,
  Image: GenuiImage,
  Link: GenuiLink,
};
```

- [ ] **Step 7: Run tests and the brand audit**

```bash
cd apps/web && bun test src/features/genui
cd ../.. && .agents/skills/kortix-brand/scripts/audit.sh apps/web/src/features/genui
```

Expected: tests PASS; audit clean. Fix any audit finding by using the token it names; never silence it.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/features/genui
git commit -m "feat(web): genui layout, data, and inline components"
```

---

### Task 4: Charts (lazy)

**Files:**
- Create: `apps/web/src/features/genui/components/charts.tsx`
- Modify: `apps/web/src/features/genui/components/index.ts`
- Test: `apps/web/src/features/genui/components/charts.test.tsx`

**Interfaces:**
- Consumes: `ChartContainer`, `ChartTooltip`, `ChartTooltipContent`, `ChartConfig` from `@/components/ui/chart`; `genuiA11yText`, `genuiNodeToMarkdown` (plan-1).
- Produces: `webGenuiComponents.BarChart`, `.LineChart`, `.PieChart` (lazy wrappers).

- [ ] **Step 1: Write the failing test**

`apps/web/src/features/genui/components/charts.test.tsx`:

```tsx
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseGenui } from '@kortix/sdk/genui';

import { ChartView } from './charts';

const node = (code: string) => (parseGenui(code).root!.props.children as never[])[0]!;

describe('ChartView', () => {
  test('bar chart: accessible label, fixed height, source, and a Show data table', () => {
    const bar = node('root = Stack([c])\nc = BarChart(["Q1", "Q2"], [s], "billing export", "USD")\ns = Series("Revenue", [120, 150])');
    const html = renderToStaticMarkup(<ChartView node={bar} props={(bar as { props: Record<string, unknown> }).props} renderChild={() => null} streaming={false} />);
    expect(html).toContain('aria-label="Bar chart: Revenue. Source: billing export"');
    expect(html).toContain('h-[220px]');
    expect(html).toContain('billing export');
    expect(html).toContain('<details');
    expect(html).toContain('| Q1 | 120 |');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun test src/features/genui/components/charts.test.tsx`
Expected: FAIL — `Cannot find module './charts'`.

- [ ] **Step 3: Implement**

Check the chart color tokens first: `rg -n "\-\-chart-[1-5]" apps/web/src/app/globals.css`. Use `var(--chart-1)` … `var(--chart-4)` if they exist; if they do not, use `var(--foreground)` with the series index as opacity steps (1, .7, .45, .25) and note it in the PR.

`apps/web/src/features/genui/components/charts.tsx`:

```tsx
'use client';

import { genuiA11yText, genuiNodeToMarkdown, type GenuiNode } from '@kortix/sdk/genui';
import type { GenuiComponentProps } from '@kortix/sdk/genui/react';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, XAxis, YAxis } from 'recharts';

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';

const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-1)'];
const kids = (value: unknown): GenuiNode[] => (Array.isArray(value) ? (value as GenuiNode[]) : []);

function seriesData(labels: string[], series: GenuiNode[]) {
  return labels.map((label, i) => {
    const row: Record<string, string | number> = { label };
    series.forEach((s, k) => {
      row[`s${k}`] = (s.props.values as number[] | undefined)?.[i] ?? 0;
    });
    return row;
  });
}

function configFor(series: GenuiNode[]): ChartConfig {
  return Object.fromEntries(series.map((s, k) => [`s${k}`, { label: String(s.props.name), color: COLORS[k] }]));
}

/** One chart: drawn figure, source line, and a Show data table (the screen-reader path). */
export function ChartView({ node, props }: GenuiComponentProps) {
  const series = kids(props.series);
  const labels = (props.categories ?? props.x ?? []) as string[];
  let figure: React.ReactNode;
  if (node.type === 'PieChart') {
    const slices = kids(props.slices).map((s) => ({ label: String(s.props.label), value: Number(s.props.value) }));
    const config = Object.fromEntries(slices.map((s, i) => [s.label, { label: s.label, color: COLORS[i] }]));
    figure = (
      <ChartContainer config={config} className="h-[220px] w-full">
        <PieChart accessibilityLayer>
          <ChartTooltip content={<ChartTooltipContent nameKey="label" />} />
          <Pie data={slices} dataKey="value" nameKey="label" innerRadius={48} isAnimationActive={false}>
            {slices.map((s, i) => (
              <Cell key={s.label} fill={COLORS[i]} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
    );
  } else {
    const data = seriesData(labels, series);
    const Chart = node.type === 'LineChart' ? LineChart : BarChart;
    figure = (
      <ChartContainer config={configFor(series)} className="h-[220px] w-full">
        <Chart accessibilityLayer data={data} margin={{ left: 4, right: 8, top: 4 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
          <YAxis tickLine={false} axisLine={false} tickMargin={8} width={48} />
          <ChartTooltip content={<ChartTooltipContent />} />
          {series.map((s, k) =>
            node.type === 'LineChart' ? (
              <Line key={s.id} dataKey={`s${k}`} stroke={`var(--color-s${k})`} dot={false} isAnimationActive={false} />
            ) : (
              <Bar key={s.id} dataKey={`s${k}`} fill={`var(--color-s${k})`} radius={[2, 2, 0, 0]} isAnimationActive={false} />
            ),
          )}
        </Chart>
      </ChartContainer>
    );
  }
  return (
    <figure className="border-border flex flex-col gap-2 rounded-lg border p-3" aria-label={genuiA11yText(node) ?? undefined}>
      {figure}
      <figcaption className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
        <span>Source: {String(props.source)}</span>
      </figcaption>
      <details className="text-sm">
        <summary className="text-muted-foreground cursor-pointer text-xs">Show data</summary>
        <UnifiedMarkdown content={genuiNodeToMarkdown(node)} trust="agent" />
      </details>
    </figure>
  );
}

export default ChartView;
```

`Show data` and `Source:` are user-visible strings: move them to `apps/web/translations/en.json` under a new `genui` namespace (`"showData": "Show data"`, `"source": "Source: {source}"`) and read them with `useTranslations('genui')`; run the i18n completeness test.

In `components/index.ts`, add a lazy wrapper so recharts loads only with the first chart:

```tsx
import { lazy, Suspense } from 'react';
import type { GenuiComponentProps } from '@kortix/sdk/genui/react';

const LazyChart = lazy(() => import('./charts'));
function GenuiChart(props: GenuiComponentProps) {
  return (
    <Suspense fallback={GenuiPending(props.node)}>
      <LazyChart {...props} />
    </Suspense>
  );
}
```

and add `BarChart: GenuiChart, LineChart: GenuiChart, PieChart: GenuiChart,` to `webGenuiComponents` (rename `index.ts` to `index.tsx` for the JSX).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && bun test src/features/genui src/i18n/i18n-complete.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/genui apps/web/translations
git commit -m "feat(web): genui bar, line, and pie charts with Show data"
```

---

### Task 5: Map (mapcn, lazy, provider from env)

**Files:**
- Create: `apps/web/src/components/ui/map.tsx` (via the mapcn registry)
- Create: `apps/web/src/features/genui/components/map.tsx`
- Modify: `apps/web/src/features/genui/components/index.tsx`
- Modify: `apps/web/package.json` (`maplibre-gl`)
- Test: `apps/web/src/features/genui/components/map.test.tsx`

**Interfaces:**
- Consumes: mapcn `Map`, `MapMarker`, `MarkerContent`, `MarkerPopup`, `MapRoute`, `MapControls` (props verified from the registry file: `Map{center:[lng,lat], zoom, styles:{light,dark}, theme, …MapLibreOptions}`, `MapMarker{longitude, latitude}`, `MapRoute{coordinates:[lng,lat][]}`).
- Produces: `webGenuiComponents.Map`; env `NEXT_PUBLIC_GENUI_MAP_STYLE_URL` (one style for both themes) and optional `NEXT_PUBLIC_GENUI_MAP_STYLE_URL_DARK`.

mapcn's default basemap is CARTO, whose commercial use needs an enterprise license (spec Q1). The component therefore never uses mapcn's defaults: with no style env set, it renders the place list (delta D8).

- [ ] **Step 1: Install mapcn and swap its icons**

```bash
cd apps/web && pnpm dlx shadcn@latest add @mapcn/map
rg -n "lucide-react" src/components/ui/map.tsx package.json
```

Expected: `src/components/ui/map.tsx` exists; `maplibre-gl@^6` added. In `map.tsx`, replace `import { X, Minus, Plus, Locate, Maximize, Loader2 } from "lucide-react";` with Phosphor icons and the Kortix spinner:

```tsx
import { ArrowsOutIcon, CrosshairIcon, MinusIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import Loading from '@/components/ui/loading';
```

and replace each use: `X`→`XIcon`, `Minus`→`MinusIcon`, `Plus`→`PlusIcon`, `Locate`→`CrosshairIcon`, `Maximize`→`ArrowsOutIcon`, and the `Loader2` spinner element in `DefaultLoader` with `<Loading />`. If the installer added `lucide-react` to `package.json`, remove it. Re-run `rg -n "lucide-react" src/components/ui/map.tsx package.json` → no output.

- [ ] **Step 2: Write the failing test**

`apps/web/src/features/genui/components/map.test.tsx`:

```tsx
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseGenui } from '@kortix/sdk/genui';

import { GenuiMapView, mapBounds } from './map';

const map = (parseGenui('root = Stack([m])\nm = Map([a, b], "places tool")\na = Marker(48.85, 2.35, "A")\nb = Marker(48.86, 2.36, "B", "Second")').root!.props.children as never[])[0]! as {
  props: Record<string, unknown>;
};

describe('genui map', () => {
  test('without a configured style, renders the place list with source', () => {
    const html = renderToStaticMarkup(<GenuiMapView node={map as never} props={map.props} renderChild={() => null} streaming={false} styleUrl={undefined} />);
    expect(html).toContain('openstreetmap.org');
    expect(html).toContain('Second');
    expect(html).toContain('places tool');
  });

  test('bounds cover every marker as [lng, lat]', () => {
    expect(mapBounds([{ lat: 48.85, lng: 2.35 }, { lat: 48.86, lng: 2.36 }])).toEqual([[2.35, 48.85], [2.36, 48.86]]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/web && bun test src/features/genui/components/map.test.tsx`
Expected: FAIL — `Cannot find module './map'`.

- [ ] **Step 4: Implement**

`apps/web/src/features/genui/components/map.tsx`:

```tsx
'use client';

import { genuiA11yText, type GenuiNode } from '@kortix/sdk/genui';
import type { GenuiComponentProps } from '@kortix/sdk/genui/react';
import { useTheme } from 'next-themes';

import { Map, MapControls, MapMarker, MapRoute, MarkerContent, MarkerPopup } from '@/components/ui/map';
import { MarkdownLink } from '@/components/markdown/unified-markdown';

const kids = (value: unknown): GenuiNode[] => (Array.isArray(value) ? (value as GenuiNode[]) : []);

export function mapBounds(points: { lat: number; lng: number }[]): [[number, number], [number, number]] {
  const lngs = points.map((p) => p.lng);
  const lats = points.map((p) => p.lat);
  return [
    [Math.min(...lngs), Math.min(...lats)],
    [Math.max(...lngs), Math.max(...lats)],
  ];
}

function PlaceList({ markers, source }: { markers: GenuiNode[]; source: string }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <ul className="flex flex-col gap-1">
        {markers.map((m) => (
          <li key={m.id}>
            <MarkdownLink href={`https://www.openstreetmap.org/?mlat=${m.props.lat}&mlon=${m.props.lng}#map=15/${m.props.lat}/${m.props.lng}`}>
              {String(m.props.label)}
            </MarkdownLink>
            {m.props.description ? <span className="text-muted-foreground"> — {String(m.props.description)}</span> : null}
          </li>
        ))}
      </ul>
      <span className="text-muted-foreground text-xs">Source: {source}</span>
    </div>
  );
}

export function GenuiMapView({ node, props, styleUrl, styleUrlDark }: GenuiComponentProps & { styleUrl: string | undefined; styleUrlDark?: string }) {
  const { resolvedTheme } = useTheme();
  const markers = kids(props.markers);
  const points = markers.map((m) => ({ lat: Number(m.props.lat), lng: Number(m.props.lng) }));
  if (!styleUrl || points.length === 0) {
    return (
      <figure className="border-border rounded-lg border p-3" aria-label={genuiA11yText(node) ?? undefined}>
        <PlaceList markers={markers} source={String(props.source)} />
      </figure>
    );
  }
  const single = points.length === 1 ? points[0]! : null;
  const route = (props.route as [number, number][] | undefined)?.map(([lat, lng]) => [lng, lat] as [number, number]);
  return (
    <figure className="border-border flex flex-col gap-2 rounded-lg border p-3" aria-label={genuiA11yText(node) ?? undefined}>
      <div className="h-[280px] overflow-hidden rounded-md">
        <Map
          theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
          styles={{ light: styleUrl, dark: styleUrlDark ?? styleUrl }}
          center={single ? [single.lng, single.lat] : undefined}
          zoom={(props.zoom as number | undefined) ?? (single ? 14 : undefined)}
          bounds={single ? undefined : mapBounds(points)}
          fitBoundsOptions={{ padding: 40 }}
          // Scrolling the chat must never zoom the map; zoom uses the controls or pinch.
          scrollZoom={false}
        >
          <MapControls />
          {route && route.length > 1 ? <MapRoute coordinates={route} /> : null}
          {markers.map((m) => (
            <MapMarker key={m.id} longitude={Number(m.props.lng)} latitude={Number(m.props.lat)}>
              <MarkerContent />
              <MarkerPopup>
                <span className="text-sm font-medium">{String(m.props.label)}</span>
                {m.props.description ? <p className="text-muted-foreground text-xs">{String(m.props.description)}</p> : null}
              </MarkerPopup>
            </MapMarker>
          ))}
        </Map>
      </div>
      <figcaption className="text-muted-foreground text-xs">Source: {String(props.source)}</figcaption>
    </figure>
  );
}

export default function GenuiMap(props: GenuiComponentProps) {
  return (
    <GenuiMapView
      {...props}
      styleUrl={process.env.NEXT_PUBLIC_GENUI_MAP_STYLE_URL}
      styleUrlDark={process.env.NEXT_PUBLIC_GENUI_MAP_STYLE_URL_DARK}
    />
  );
}
```

Move `Source: {source}` to the `genui` translation namespace (Task 4). Check `map.tsx` (mapcn) for the exact `Theme` type and whether `MarkerContent` renders a default pin with no children; adjust to its API.

In `components/index.tsx`:

```tsx
const LazyMap = lazy(() => import('./map'));
function GenuiMapEntry(props: GenuiComponentProps) {
  return (
    <Suspense fallback={GenuiPending(props.node)}>
      <LazyMap {...props} />
    </Suspense>
  );
}
```

and add `Map: GenuiMapEntry,` to `webGenuiComponents`. Add `NEXT_PUBLIC_GENUI_MAP_STYLE_URL` (empty) with a comment to `apps/web/.env.example` if that file lists other `NEXT_PUBLIC_*` keys.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd apps/web && bun test src/features/genui
cd ../.. && .agents/skills/kortix-brand/scripts/audit.sh apps/web/src/features/genui apps/web/src/components/ui/map.tsx
```

Expected: PASS; audit clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ui/map.tsx apps/web/src/features/genui apps/web/package.json pnpm-lock.yaml apps/web/.env.example apps/web/translations
git commit -m "feat(web): genui map on mapcn, place list until a tile style is configured"
```

---

### Task 6: Settings row — "Rich answers"

**Files:**
- Modify: `apps/web/src/features/workspace/settings/tabs/appearance-tab.tsx`
- Modify: `apps/web/translations/{en,de,es,fr,it,ja,pt,sr,zh}.json` (`settings.appearance`, en ~L492)
- Test: `apps/web/src/features/workspace/settings/tabs/appearance-tab.genui.test.tsx`

**Interfaces:**
- Consumes: `useGenuiEnabled`, `setGenuiEnabled` (Task 2).
- Produces: `AppearanceTabView` props `genuiEnabled?: boolean`, `onGenuiEnabledChange?: (enabled: boolean) => void`; copy keys `richAnswers`, `richAnswersDescription`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AppearanceTabView } from './appearance-tab';

describe('Appearance: rich answers', () => {
  test('renders a labelled switch reflecting the preference', () => {
    const on = renderToStaticMarkup(<AppearanceTabView genuiEnabled />);
    expect(on).toContain('Rich answers');
    expect(on).toContain('aria-checked="true"');
    const off = renderToStaticMarkup(<AppearanceTabView genuiEnabled={false} />);
    expect(off).toContain('aria-checked="false"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun test src/features/workspace/settings/tabs/appearance-tab.genui.test.tsx`
Expected: FAIL — no "Rich answers" text.

- [ ] **Step 3: Implement**

Add to `AppearanceTabCopy` and `DEFAULT_APPEARANCE_TAB_COPY`:

```ts
  richAnswers: string;
  richAnswersDescription: string;
```

```ts
  richAnswers: 'Rich answers',
  richAnswersDescription: 'Show comparisons, charts, and maps as views you can read at a glance. Off shows the same answers as text.',
```

Add props `genuiEnabled = true` and `onGenuiEnabledChange = () => {}` to `AppearanceTabView`, and a section after "Conversation density":

```tsx
      <Separator />

      <section className="flex items-start justify-between gap-4 md:gap-10">
        <SettingsSubsectionHeader title={copy.richAnswers} description={copy.richAnswersDescription} />
        <Switch checked={genuiEnabled} onCheckedChange={onGenuiEnabledChange} aria-label={copy.richAnswers} />
      </section>
```

(import `Switch` from `@/components/ui/switch`). In the connected component, read and pass:

```tsx
  const genuiEnabled = useUserPreferencesStore((s) => s.preferences.genuiEnabled ?? true);
  const setGenuiEnabled = useUserPreferencesStore((s) => s.setGenuiEnabled);
```

```tsx
        richAnswers: t('richAnswers'),
        richAnswersDescription: t('richAnswersDescription'),
```

```tsx
      genuiEnabled={genuiEnabled}
      onGenuiEnabledChange={setGenuiEnabled}
```

Add `"richAnswers"` and `"richAnswersDescription"` to `settings.appearance` in all 9 translation files (English text, same convention as plan-3 Task 1 Step 5).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && bun test src/features/workspace/settings/tabs src/i18n/i18n-complete.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/workspace/settings/tabs apps/web/translations
git commit -m "feat(web): Rich answers switch in Appearance settings"
```

---

### Task 7: Copy and export never contain OpenUI source

**Files:**
- Modify: `apps/web/src/features/session/session-chat/transcript.tsx` (`handleCopy`, ~L2096-2108)
- Modify: `apps/web/src/features/session/header/export-transcript-modal.tsx` (`transcript` memo, ~L144)
- Test: `apps/web/src/features/genui/copy-export.test.ts`

**Interfaces:**
- Consumes: `genuiToMarkdown` (plan-1), `formatTranscript` (existing, `@kortix/sdk`).

- [ ] **Step 1: Write the failing test**

`apps/web/src/features/genui/copy-export.test.ts` pins the exact composition both call sites use:

```ts
import { describe, expect, test } from 'bun:test';
import { formatTranscript, DEFAULT_TRANSCRIPT_OPTIONS } from '@kortix/sdk';
import { genuiToMarkdown } from '@kortix/sdk/genui';

describe('export and copy', () => {
  test('an exported transcript carries markdown, not OpenUI source', () => {
    const messages = [
      {
        info: { id: 'm1', role: 'assistant', time: { created: 0 } },
        parts: [{ id: 'p1', type: 'text', text: 'Done.\n\n```openui\nroot = Stack([b])\nb = Badge("shipped")\n```' }],
      },
    ] as never;
    const out = genuiToMarkdown(formatTranscript({ id: 's', title: 'T', time: { created: 0 } } as never, messages, DEFAULT_TRANSCRIPT_OPTIONS));
    expect(out).toContain('[shipped]');
    expect(out).not.toContain('root = Stack');
  });
});
```

(Adjust the session/message fixture shape to `formatTranscript`'s parameter types — read its signature in `packages/sdk` with `rg -n "export function formatTranscript" packages/sdk/src`.)

- [ ] **Step 2: Run test to verify it passes (it tests the SDK composition), then make the call sites use it**

Run: `cd apps/web && bun test src/features/genui/copy-export.test.ts` → PASS.

In `export-transcript-modal.tsx`, wrap the memo result:

```tsx
import { genuiToMarkdown } from '@kortix/sdk/genui';
// …
    return genuiToMarkdown(
      formatTranscript(
        // …existing arguments unchanged…
      ),
    );
```

In `transcript.tsx` `handleCopy`, change the write to:

```tsx
  await navigator.clipboard.writeText(genuiToMarkdown(textToCopy));
```

with `import { genuiToMarkdown } from '@kortix/sdk/genui';`.

- [ ] **Step 3: Verify no other raw-text copy path exists**

Run: `rg -n "clipboard.writeText" apps/web/src/features/session | rg -v test`
Expected: every hit that copies assistant text goes through `genuiToMarkdown`; list any other hit in the PR and fix it the same way.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/features/session apps/web/src/features/genui/copy-export.test.ts
git commit -m "feat(web): copy and export render generative UI as markdown"
```

---

### Task 8: Unhide the flag, verify in the browser and in Electron

**Files:**
- Modify: `apps/api/src/feature-flags/registry.ts` (remove `catalogHidden: true` and its comment from the `genui` entry)
- Modify: `tests/e2e/specs/27-desktop-parity.spec.ts` (only if Step 4 finds a transcript seeding helper)

- [ ] **Step 1: Unhide**

Remove the two lines from the `genui` registry entry. Run `cd apps/api && bun test src/__tests__/unit-feature-flags.test.ts` → PASS.

- [ ] **Step 2: Full local test run**

```bash
pnpm test
pnpm test:verify --rev HEAD --branch genui
```

Expected: green; verify exits 0.

- [ ] **Step 3: Drive the real UI with agent-browser (recorded)**

With the worktree stack running (`pnpm worktree start genui`) and plan-3 merged into the branch:

```bash
SID=$(agent-browser session id --scope worktree --prefix genui)
agent-browser --session "$SID" record start output/genui-web.webm
```

Sign in at `http://localhost:20900/auth`, open a project with `genui` on (Settings → Experimental shows "Generative UI"), start a session, and send `Compare these two plans: Basic 10 USD with 3 projects; Pro 30 USD with unlimited projects.` Assert, with `agent-browser --session "$SID" snapshot` and `eval`:
1. While the reply streams, `document.querySelectorAll('[data-genui-block]').length >= 1` and no element's text contains `root = Stack`.
2. After it settles, a `table` exists inside `[data-genui-block]`.
3. Click the turn's Copy button; read the clipboard via `eval "navigator.clipboard.readText()"`; it contains `| Basic |` or `Basic` and not `root = Stack`.
4. Settings → Appearance → turn "Rich answers" off; the same message now renders markdown (no `[data-genui-block] table`, text still present). Turn it back on.
5. `agent-browser --session "$SID" network` shows a PostHog capture with event `genui_block` and properties without message text.
6. Repeat 1–2 in light and dark theme; repeat at 720 × 480 (`agent-browser --session "$SID" set viewport 720 480`): no horizontal page scroll, last row of the comparison visible.

7. Render discipline: add a temporary `console.count('GenuiStat ' + node.id)` in `GenuiStat`, send `Give me this week's key numbers: users 12400, revenue 48200 USD, churn 2.1%, tickets 312.`, and read `agent-browser --session "$SID" console`: each Stat id is counted once after it first appears (not once per tick). Remove the line.

`agent-browser --session "$SID" record stop`. Attach `output/genui-web.webm` to the PR via the **contributing** skill.

- [ ] **Step 3b: Regression gate (spec §8.4), measured — not an automated suite (tests/ forbids perf suites)**

Measure long tasks during one streamed reply, flag off vs flag on, same prompt (`Compare these four laptops …` with the `ui-four-products` context from `eval-prompts.json`), 3 runs each:

```bash
agent-browser --session "$SID" eval "window.__lt=[];new PerformanceObserver(l=>l.getEntries().forEach(e=>window.__lt.push(e.duration))).observe({type:'longtask',buffered:false});'ok'"
# send the prompt, wait for the turn to settle, then:
agent-browser --session "$SID" eval "JSON.stringify({count:window.__lt.length,total:Math.round(window.__lt.reduce((a,b)=>a+b,0))})"
```

Pass: flag-on median long-task total ≤ flag-off median + 5% (+ one lazy-chunk load on the first block of a page; report it separately). Record the 6 measurements in the PR.

Bundle: `pnpm --filter Kortix-Computer-Frontend build` on `dev` and on `genui`; compare the "First Load JS" of the session route. Pass: unchanged (genui, charts, and map are lazy chunks). Record both numbers.

- [ ] **Step 4: Desktop parity journey**

Run: `rg -n "assistant" tests/e2e/specs/*.spec.ts tests/e2e/helpers | rg -i "seed|fixture|transcript" | head`
If a helper seeds an assistant message, add one case to `27-desktop-parity.spec.ts` that seeds a message containing the Step 3 comparison block and asserts `[data-genui-block] table` is visible and not clipped at 720 × 480. Then run `E2E_DESKTOP_NATIVE=1 E2E_GREP='27 — desktop parity' pnpm test -- --browser-only`.
If no seeding helper exists, do not add a harness (tests/ rules); run the native journey unchanged to prove no regression, and state in the PR that genui desktop rendering was verified manually in the Electron shell (open the same session in `apps/desktop-electron` dev and repeat Step 3 checks 1, 2, 6).

- [ ] **Step 5: Commit and open PR 2**

```bash
git add apps/api/src/feature-flags/registry.ts tests/e2e/specs
git commit -m "feat(genui): show the Generative UI flag in project settings"
```

Open the PR per the **contributing** skill (summary + test plan only, no attribution footer), self-merge when verified, deploy dev, and repeat Step 3 checks 1–3 against `https://dev.kortix.com` (plan.md § Delivery).
