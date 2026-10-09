# Generative UI — plan 5: mobile (`apps/mobile`, iOS and Android)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. ALSO REQUIRED before writing any component: `apps/mobile/AGENTS.md` and `apps/mobile/design.md` (§2 Spacing, §8 the show card, §9 Colour and theme).

**Goal:** Assistant messages on iOS and Android render ```` ```openui ```` blocks with mobile-native components while streaming, ship over the air on runtime `1.4.4` with no native module, and fall back to markdown when the viewer turns the feature off.

**Architecture:** `FencedCode` in `selectable-markdown.tsx` detects the fence and renders `GenuiMessageBlock`, which passes `mobileGenuiComponents` to the same SDK `GenuiBlock` the web uses. Components compose the app's primitives (`Text`, `Badge`, `Tabs`, `Separator`, a new minimal `Accordion`) on borderless `rounded-2xl` surfaces. Charts draw with `react-native-svg` from pure, tested geometry. The map follows design.md §8 (no embedded viewer that fights the transcript gesture): the transcript shows the place list with an "Open map" row, and the interactive MapLibre map opens fullscreen in a WebView, like the Mermaid fullscreen dialog.

**Tech Stack:** Expo SDK 56, React Native 0.85, react-native-markdown-display 7, `@kortix/sdk/genui/react`, react-native-svg 15.15, react-native-webview 13.16, reanimated 4.3, nativewind 4, zustand + AsyncStorage, Bun test.

**Spec:** `.agents/skills/genui/references/spec.md` §6, §8.1 R-MOB-1, R-STREAM-1 (mobile), R-A11Y-1. Master plan: `plan.md` (deltas D1, D8, D9).

**Depends on:** plan-1 (SDK). Verification in Task 7 needs plan-3 merged into the branch.

**Provenance:** `chart-geometry.ts` and `map-html.ts` and their 9 tests ran green, and typechecked, before this plan was written. The React Native components cannot render under Bun in this repo; they are verified by the mobile `tsc` baseline diff and on a device (Task 7).

## Global Constraints

See `plan.md`. Specific to this plan:
- No native module, no `runtimeVersion` change. `@openuidev/lang-core` and `zod` are pure JS; the MapLibre bundle is an asset.
- Primitives by direct path (`@/components/ui/text`, never a barrel). A missing capability goes into a primitive, not a screen (AGENTS.md).
- Colors from `global.css` classes or `THEME` + `withAlpha` (`lib/utils/theme.ts`). No hex. SVG and WebView colors use `withAlpha(token, alpha)`: native renderers cannot parse `hsl(0 0% 100%)` (design.md §9).
- Surfaces: borderless `rounded-2xl` (`bg-card` / `bg-secondary`). No descriptions under settings rows (standing mobile UI rule).
- Spinner: `KortixLoader` from `@/components/kortix/kortix-loader`. No skeletons.
- Android mirrors iOS.

## Review Focus

- A build older than the OTA receives a reply with a block → it shows the raw fence as a code block (accepted, spec R-MOB-1); the OTA reaches it on next launch (`checkAutomatically: ON_LOAD`). Pinned in Task 7 Step 4 (old-build check).
- Model text inside the map WebView (`label: "</script>…"`) → stays data. Pinned in Task 5 (`map-html.test.ts`).

---

### Task 1: Dependencies, Metro resolution, and the preference store

**Files:**
- Modify: `apps/mobile/package.json`
- Create: `apps/mobile/stores/genui-store.ts`
- Test: `apps/mobile/stores/genui-store.test.ts`

**Interfaces:**
- Produces: `useGenuiStore` with `enabled: boolean` (default `true`) and `setEnabled(enabled: boolean): void`, persisted under AsyncStorage key `kortix-genui`.

- [ ] **Step 1: Add dependencies**

Add to `apps/mobile/package.json` dependencies: `"@openuidev/lang-core": "0.3.1"`, `"zod": "3.25.76"`. Run `pnpm install --filter kortix` (the `name` in `apps/mobile/package.json`).

- [ ] **Step 2: Prove Metro resolves the new subpaths**

`metro.config.js` sets no `unstable_enablePackageExports`; subpath exports rely on Expo's default. Prove it before writing components:

```bash
cd apps/mobile
npx expo export --platform ios --output-dir /tmp/genui-export --dump-sourcemap 2>&1 | tail -5
```

Add a temporary line `import '@kortix/sdk/genui/react';` to `app/_layout.tsx` before running it, and remove it after. Expected: export succeeds; `rg -l "createStreamingParser" /tmp/genui-export` finds the bundle. If resolution fails, add `config.resolver.unstable_enablePackageExports = true;` to `metro.config.js` before `module.exports`, re-run, and record it in the PR.

- [ ] **Step 3: Write the failing test**

`apps/mobile/stores/genui-store.test.ts`:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { describe, expect, test } from 'bun:test';

import { useGenuiStore } from './genui-store';

describe('genui store', () => {
  test('defaults to on', () => {
    expect(useGenuiStore.getState().enabled).toBe(true);
  });

  test('setEnabled persists the choice', async () => {
    useGenuiStore.getState().setEnabled(false);
    expect(useGenuiStore.getState().enabled).toBe(false);
    const raw = await AsyncStorage.getItem('kortix-genui');
    expect(JSON.parse(raw!).state.enabled).toBe(false);
    useGenuiStore.getState().setEnabled(true);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd apps/mobile && bun test stores/genui-store.test.ts`
Expected: FAIL — `Cannot find module './genui-store'`.

- [ ] **Step 5: Implement**

`apps/mobile/stores/genui-store.ts`:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface GenuiState {
  /** Render generative UI blocks as UI (true) or as their markdown fallback (false). */
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

/** A device preference, like sounds: it survives sign-out. */
export const useGenuiStore = create<GenuiState>()(
  persist(
    (set) => ({
      enabled: true,
      setEnabled: (enabled) => set({ enabled }),
    }),
    { name: 'kortix-genui', storage: createJSONStorage(() => AsyncStorage) },
  ),
);
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd apps/mobile && bun test stores/genui-store.test.ts stores/sign-out-reset.test.ts
```

Expected: PASS. If `sign-out-reset.test.ts` enumerates persisted stores, add `kortix-genui` to the list of device preferences it keeps (the same list that keeps the sound store).

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/package.json pnpm-lock.yaml apps/mobile/stores/genui-store.ts apps/mobile/stores/genui-store.test.ts apps/mobile/metro.config.js
git commit -m "feat(mobile): genui dependencies and the Rich answers preference store"
```

---

### Task 2: Fence routing, the block, and text components

**Files:**
- Modify: `apps/mobile/components/kortix/selectable-markdown.tsx` (`FencedCode`, L182-194)
- Create: `apps/mobile/components/genui/genui-message-block.tsx`
- Create: `apps/mobile/components/genui/components/pending.tsx`, `layout.tsx`, `data.tsx`, `inline.tsx`, `index.ts`

**Interfaces:**
- Consumes: `genuiVersionOf` (plan-1), `GenuiBlock`, `GenuiComponentProps`, `GenuiComponentMap` (plan-1), `useGenuiStore` (Task 1).
- Produces: `GenuiMessageBlock({ code, version, isStreaming, renderMarkdown })`; `mobileGenuiComponents: GenuiComponentMap` (Tasks 3–5 add Accordion, charts, Map); `GenuiPending(node)`.

- [ ] **Step 1: Read the APIs this task composes**

```bash
cd apps/mobile
sed -n 1,90p components/ui/text.tsx      # variants: default h1 h2 h3 h4 p blockquote code lead large small muted
sed -n 1,66p components/ui/badge.tsx     # variants: default secondary destructive outline; children are <Text>
sed -n 1,68p components/ui/tabs.tsx      # rn-primitives Tabs: value + onValueChange
```

Facts already checked (2026-10-09): markdown links open through `openExternalLink(href: unknown)` in `components/markdown/markdown-text.tsx`; the app does not use `expo-image` (React Native `Image` it is); `lib/icons/index.ts` exports `InfoIcon`, `WarningIcon`, `CheckCircleIcon`, `ArrowUpRightIcon`, `MinusIcon`, `CaretDownIcon`, `CaretRightIcon`, `SquaresFourIcon`, but **not** `ArrowDownRightIcon` or `MapTrifoldIcon`. Add those two exactly as `SquaresFourIcon` is added:

```ts
import { ArrowDownRightIcon as ArrowDownRightGlyph } from 'phosphor-react-native/src/icons/ArrowDownRight';
import { MapTrifoldIcon as MapTrifoldGlyph } from 'phosphor-react-native/src/icons/MapTrifold';
// …
export const ArrowDownRightIcon = withAppWeight(ArrowDownRightGlyph, 'ArrowDownRightIcon');
export const MapTrifoldIcon = withAppWeight(MapTrifoldGlyph, 'MapTrifoldIcon');
```

- [ ] **Step 2: Pending and the block**

`apps/mobile/components/genui/components/pending.tsx`:

```tsx
import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { GenuiNode } from '@kortix/sdk/genui';

import { KortixLoader } from '@/components/kortix/kortix-loader';

/** Final heights of the components that would otherwise jump when they finish streaming. */
const RESERVED: Record<string, number> = { Table: 160, BarChart: 220, LineChart: 220, PieChart: 220 };

/** A node the model has not finished: heavy nodes hold their space with the Kortix loader; text nodes wait invisibly. */
export function GenuiPending(node: GenuiNode): ReactNode {
  const height = RESERVED[node.type];
  if (!height) return null;
  return (
    <View style={{ height }} className="items-center justify-center rounded-2xl bg-card" accessibilityState={{ busy: true }}>
      <KortixLoader />
    </View>
  );
}
```

`apps/mobile/components/genui/genui-message-block.tsx`:

```tsx
import { memo, type ReactNode } from 'react';
import { View } from 'react-native';
import { GenuiBlock } from '@kortix/sdk/genui/react';

import { useGenuiStore } from '@/stores/genui-store';

import { GenuiPending, mobileGenuiComponents } from './components';

export interface GenuiMessageBlockProps {
  code: string;
  version: number;
  isStreaming: boolean;
  /** The markdown renderer of the message (passed in to avoid an import cycle with selectable-markdown). */
  renderMarkdown: (markdown: string) => ReactNode;
}

export const GenuiMessageBlock = memo(function GenuiMessageBlock({ code, version, isStreaming, renderMarkdown }: GenuiMessageBlockProps) {
  const enabled = useGenuiStore((s) => s.enabled);
  return (
    <View className="my-2">
      <GenuiBlock
        code={code}
        version={version}
        streaming={isStreaming}
        enabled={enabled}
        components={mobileGenuiComponents}
        renderMarkdown={renderMarkdown}
        renderPending={GenuiPending}
      />
    </View>
  );
});
```

- [ ] **Step 3: Route the fence**

In `selectable-markdown.tsx`, add imports:

```tsx
import { genuiVersionOf } from '@kortix/sdk/genui';
import { GenuiMessageBlock } from '@/components/genui/genui-message-block';
```

above `FencedCode`, two stable fallback renderers (module level, so `GenuiBlock`'s memo holds):

```tsx
const genuiFallback = (isDark: boolean) => (markdown: string) =>
  markdown ? <SelectableMarkdownText isDark={isDark}>{markdown}</SelectableMarkdownText> : null;
const GENUI_FALLBACK_LIGHT = genuiFallback(false);
const GENUI_FALLBACK_DARK = genuiFallback(true);
```

and at the top of `FencedCode`, after `const isStreaming = useContext(OpenFenceContext);`:

```tsx
  // The raw first word of the info string: `fenceLanguage` may normalize `openui-lang` away.
  const genuiVersion = genuiVersionOf((node.sourceInfo ?? '').trim().split(/\s+/)[0] ?? '');
  if (genuiVersion !== null) {
    return (
      <GenuiMessageBlock
        code={fenceCode(node.content)}
        version={genuiVersion}
        isStreaming={isStreaming}
        renderMarkdown={isDark ? GENUI_FALLBACK_DARK : GENUI_FALLBACK_LIGHT}
      />
    );
  }
```

- [ ] **Step 4: Layout, data, and inline components**

`apps/mobile/components/genui/components/layout.tsx`:

```tsx
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import type { GenuiNode } from '@kortix/sdk/genui';
import type { GenuiComponentProps } from '@kortix/sdk/genui/react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Text } from '@/components/ui/text';

import { GenuiImageView } from './inline';
import { openGenuiLink } from './open-link';

export const kids = (value: unknown): GenuiNode[] => (Array.isArray(value) ? (value as GenuiNode[]) : []);

/** Phones are narrow: a Stack is always a column on mobile; StatRow handles its own grid. */
export function GenuiStack({ props, renderChild }: GenuiComponentProps) {
  return <View className="gap-3">{kids(props.children).map(renderChild)}</View>;
}

export function GenuiCard({ props, renderChild }: GenuiComponentProps) {
  const badges = kids(props.badges);
  const body = (
    <View className="gap-1 rounded-2xl bg-card p-4">
      {props.image ? <GenuiImageView src={props.image} alt="" /> : null}
      <Text variant="large">{props.title}</Text>
      {props.subtitle ? <Text variant="muted">{props.subtitle}</Text> : null}
      {props.body ? <Text>{props.body}</Text> : null}
      {badges.length > 0 ? <View className="mt-1 flex-row flex-wrap gap-1.5">{badges.map(renderChild)}</View> : null}
    </View>
  );
  return props.href ? (
    <Pressable accessibilityRole="link" onPress={() => openGenuiLink(props.href)}>
      {body}
    </Pressable>
  ) : (
    body
  );
}

export function GenuiTabs({ props, renderChild, streaming }: GenuiComponentProps) {
  const tabs = kids(props.tabs);
  const [value, setValue] = useState(tabs[0]?.id ?? '');
  if (tabs.length === 0) return null;
  // While streaming, show the tab being written so progress is visible (spec §6.3).
  const active = streaming ? tabs[tabs.length - 1]!.id : value;
  return (
    <Tabs value={active} onValueChange={setValue}>
      <TabsList>
        {tabs.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id}>
            <Text>{String(tab.props.label)}</Text>
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.id} value={tab.id}>
          <View className="gap-3 pt-3">{kids(tab.props.children).map(renderChild)}</View>
        </TabsContent>
      ))}
    </Tabs>
  );
}
```

`apps/mobile/components/genui/components/open-link.ts` — the same opener markdown links use (`handleLibraryLinkPress` → `openExternalLink`):

```ts
import { safeUrl } from '@kortix/sdk/genui';

import { openExternalLink } from '@/components/markdown/markdown-text';

/** Opens a URL the SDK already validated; re-checks it, because this is the last stop before the OS. */
export function openGenuiLink(href: unknown): void {
  const url = safeUrl(href);
  if (url) openExternalLink(url);
}
```

`apps/mobile/components/genui/components/data.tsx`:

```tsx
import { ScrollView, View } from 'react-native';
import type { GenuiComponentProps } from '@kortix/sdk/genui/react';

import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { ArrowDownRightIcon, ArrowUpRightIcon, MinusIcon } from '@/lib/icons';

import { kids } from './layout';

const TREND = { up: ArrowUpRightIcon, down: ArrowDownRightIcon, flat: MinusIcon } as const;
const CELL = 'min-w-24 px-3 py-2';

export function GenuiStat({ props }: GenuiComponentProps) {
  const trend = props.trend ? TREND[props.trend as keyof typeof TREND] : null;
  return (
    <View className="min-w-[45%] flex-1 gap-0.5 rounded-2xl bg-card p-3">
      <Text variant="muted" className="text-xs">
        {props.label}
      </Text>
      <Text className="text-xl font-semibold tabular-nums">
        {props.value}
        {props.unit ? <Text variant="muted"> {props.unit}</Text> : null}
      </Text>
      {props.delta ? (
        <View className="flex-row items-center gap-1">
          {trend ? <Icon as={trend} size={12} className="text-muted-foreground" /> : null}
          <Text variant="muted" className="text-xs tabular-nums">
            {props.delta}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export function GenuiStatRow({ props, renderChild }: GenuiComponentProps) {
  return <View className="flex-row flex-wrap gap-3">{kids(props.stats).map(renderChild)}</View>;
}

export function GenuiTable({ props }: GenuiComponentProps) {
  const columns = props.columns as string[];
  const rows = props.rows as unknown[][];
  return (
    <View className="overflow-hidden rounded-2xl bg-card">
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          <View className="flex-row bg-secondary">
            {columns.map((column, i) => (
              <Text key={i} className={`${CELL} text-xs font-medium`}>
                {column}
              </Text>
            ))}
          </View>
          {rows.map((row, r) => (
            <View key={r} className="flex-row">
              {columns.map((_, c) => (
                <Text key={c} className={`${CELL} text-sm ${typeof row[c] === 'number' ? 'tabular-nums' : ''}`}>
                  {String(row[c] ?? '')}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
      {props.caption ? (
        <Text variant="muted" className="px-3 pb-2 text-xs">
          {props.caption}
        </Text>
      ) : null}
    </View>
  );
}

/** On a phone a comparison reads best as one card per option, specs listed in the same order. */
export function GenuiCompare({ props }: GenuiComponentProps) {
  const specs = (props.specs as string[] | undefined) ?? [];
  return (
    <View className="gap-3">
      {kids(props.items).map((item) => (
        <View key={item.id} className="gap-2 rounded-2xl bg-card p-4">
          <View className="flex-row items-center justify-between">
            <Text variant="large">{String(item.props.name)}</Text>
            {props.winner === item.props.name ? (
              <Badge>
                <Text>Pick</Text>
              </Badge>
            ) : null}
          </View>
          {specs.map((spec, i) => (
            <View key={spec} className="flex-row justify-between gap-3">
              <Text variant="muted">{spec}</Text>
              <Text>{(item.props.values as string[])[i] ?? '—'}</Text>
            </View>
          ))}
          {((item.props.pros as string[] | undefined) ?? []).map((pro) => (
            <Text key={`+${pro}`}>+ {pro}</Text>
          ))}
          {((item.props.cons as string[] | undefined) ?? []).map((con) => (
            <Text key={`-${con}`} variant="muted">
              − {con}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

export function GenuiRankedList({ props }: GenuiComponentProps) {
  const items = kids(props.items);
  return (
    <View className="overflow-hidden rounded-2xl bg-card">
      {items.map((item, index) => (
        <View key={item.id}>
          {index > 0 ? <Separator /> : null}
          <View className="flex-row gap-3 px-4 py-3">
            <Text variant="muted" className="w-5 tabular-nums">
              {index + 1}
            </Text>
            <View className="flex-1 gap-0.5">
              <Text className="font-medium">
                {String(item.props.title)}
                {item.props.meta ? <Text variant="muted"> · {String(item.props.meta)}</Text> : null}
              </Text>
              <Text variant="muted">{String(item.props.reason)}</Text>
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}
```

`Pick` is user-visible: route it through the app's `t()` (`t('genui.pick', 'Pick')`) the way `AccountPage.tsx` does.

`apps/mobile/components/genui/components/inline.tsx`:

```tsx
import { Image, Pressable, View } from 'react-native';
import type { GenuiComponentProps } from '@kortix/sdk/genui/react';

import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { CheckCircleIcon, InfoIcon, WarningIcon } from '@/lib/icons';

import { openGenuiLink } from './open-link';

const BADGE_VARIANT = { neutral: 'secondary', good: 'default', warn: 'outline', bad: 'destructive' } as const;
const CALLOUT_ICON = { info: InfoIcon, warn: WarningIcon, success: CheckCircleIcon } as const;

export function GenuiBadge({ props }: GenuiComponentProps) {
  return (
    <Badge variant={BADGE_VARIANT[(props.tone ?? 'neutral') as keyof typeof BADGE_VARIANT]}>
      <Text>{props.label}</Text>
    </Badge>
  );
}

export function GenuiCallout({ props }: GenuiComponentProps) {
  const icon = CALLOUT_ICON[props.tone as keyof typeof CALLOUT_ICON] ?? InfoIcon;
  return (
    <View className="flex-row gap-3 rounded-2xl bg-secondary p-4">
      <Icon as={icon} size={18} className="mt-0.5 text-foreground" />
      <View className="flex-1 gap-0.5">
        {props.title ? <Text className="font-medium">{props.title}</Text> : null}
        <Text>{props.body}</Text>
      </View>
    </View>
  );
}

export function GenuiImageView({ src, alt }: { src: string; alt: string }) {
  return <Image source={{ uri: src }} accessibilityLabel={alt} className="h-44 w-full rounded-xl bg-secondary" resizeMode="cover" />;
}

export function GenuiImage({ props }: GenuiComponentProps) {
  return (
    <View className="gap-1">
      <GenuiImageView src={props.src} alt={props.alt} />
      {props.caption ? (
        <Text variant="muted" className="text-xs">
          {props.caption}
        </Text>
      ) : null}
    </View>
  );
}

export function GenuiLink({ props }: GenuiComponentProps) {
  return (
    <Pressable accessibilityRole="link" onPress={() => openGenuiLink(props.href)}>
      <Text className="underline">{props.label}</Text>
    </Pressable>
  );
}
```


`apps/mobile/components/genui/components/index.ts`:

```ts
import type { GenuiComponentMap } from '@kortix/sdk/genui/react';

import { GenuiCompare, GenuiRankedList, GenuiStat, GenuiStatRow, GenuiTable } from './data';
import { GenuiBadge, GenuiCallout, GenuiImage, GenuiLink } from './inline';
import { GenuiCard, GenuiStack, GenuiTabs } from './layout';

export { GenuiPending } from './pending';

export const mobileGenuiComponents: GenuiComponentMap = {
  Stack: GenuiStack,
  Card: GenuiCard,
  Tabs: GenuiTabs,
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

Until Tasks 3–5 add them, `Accordion`, charts, and `Map` render their markdown (the SDK renders a missing map entry as markdown).

- [ ] **Step 5: Typecheck against the baseline**

```bash
cd apps/mobile && npx tsc --noEmit -p tsconfig.json 2>&1 | rg "error TS" | sort > /tmp/genui-tsc.txt; wc -l < /tmp/genui-tsc.txt
rg "components/genui|genui-store|selectable-markdown" /tmp/genui-tsc.txt
```

Expected: the count equals the known baseline (5 errors: TS5097 ×2, TS2783 `lib/agents/hooks.ts`, TS2322 `lib/projects/hooks.ts:514`, TS2305 `lib/triggers/index.ts`); the second command prints nothing.

- [ ] **Step 6: Run the mobile suite**

Run: `cd apps/mobile && bun test`
Expected: PASS (no regression in `lib/markdown/*` tests).

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/components/genui apps/mobile/components/kortix/selectable-markdown.tsx apps/mobile/lib/icons
git commit -m "feat(mobile): render openui fences with mobile genui components"
```

---

### Task 3: Accordion primitive and component

**Files:**
- Create: `apps/mobile/components/ui/accordion.tsx`
- Create: `apps/mobile/components/genui/components/accordion.tsx`
- Modify: `apps/mobile/components/genui/components/index.ts`

**Interfaces:**
- Produces: `AccordionItem({ title, defaultOpen?, children })` primitive; `mobileGenuiComponents.Accordion`.

The app has no accordion primitive (`components/ui/` lists none). AGENTS.md: extend primitives, do not hand-roll in a screen. Motion follows the **animations-dev** skill: the chevron rotates in 200 ms ease-out; content appears without a height animation; reduced motion removes the rotation animation.

- [ ] **Step 1: The primitive**

`apps/mobile/components/ui/accordion.tsx`:

```tsx
import { useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, withTiming } from 'react-native-reanimated';

import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { CaretDownIcon } from '@/lib/icons';

export function AccordionItem({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const reducedMotion = useReducedMotion();
  const caret = useAnimatedStyle(() => ({
    transform: [
      { rotate: reducedMotion ? (open ? '180deg' : '0deg') : withTiming(open ? '180deg' : '0deg', { duration: 200, easing: Easing.out(Easing.quad) }) },
    ],
  }));
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        className="flex-row items-center justify-between px-4 py-3"
      >
        <Text className="flex-1 font-medium">{title}</Text>
        <Animated.View style={caret}>
          <Icon as={CaretDownIcon} size={16} className="text-muted-foreground" />
        </Animated.View>
      </Pressable>
      {open ? <View className="gap-3 px-4 pb-4">{children}</View> : null}
    </View>
  );
}
```

- [ ] **Step 2: The genui component**

`apps/mobile/components/genui/components/accordion.tsx`:

```tsx
import { View } from 'react-native';
import type { GenuiComponentProps } from '@kortix/sdk/genui/react';

import { AccordionItem } from '@/components/ui/accordion';
import { Separator } from '@/components/ui/separator';

import { kids } from './layout';

export function GenuiAccordion({ props, renderChild }: GenuiComponentProps) {
  return (
    <View className="overflow-hidden rounded-2xl bg-card">
      {kids(props.items).map((item, index) => (
        <View key={item.id}>
          {index > 0 ? <Separator /> : null}
          <AccordionItem title={String(item.props.title)}>{kids(item.props.children).map(renderChild)}</AccordionItem>
        </View>
      ))}
    </View>
  );
}
```

Add `Accordion: GenuiAccordion,` to `mobileGenuiComponents` (import from `./accordion`).

- [ ] **Step 3: Typecheck and test**

Run the Task 2 Step 5 and Step 6 commands. Expected: same baseline count, nothing under `components/genui` or `components/ui/accordion`; `bun test` PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/components/ui/accordion.tsx apps/mobile/components/genui
git commit -m "feat(mobile): accordion primitive and genui Accordion"
```

---

### Task 4: Charts (react-native-svg)

**Files:**
- Create: `apps/mobile/lib/genui/chart-geometry.ts`
- Test: `apps/mobile/lib/genui/chart-geometry.test.ts`
- Create: `apps/mobile/components/genui/components/charts.tsx`
- Modify: `apps/mobile/components/genui/components/index.ts`

**Interfaces:**
- Produces: `axisMax(series: number[][]): number`, `barRects(series, categories, width, height, gap?): BarRect[]`, `linePath(values, width, height, max): string`, `pieArcs(values, radius, inner): { path: string; index: number }[]`; `mobileGenuiComponents.BarChart`, `.LineChart`, `.PieChart`.

- [ ] **Step 1: Write the failing test**

`apps/mobile/lib/genui/chart-geometry.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { axisMax, barRects, linePath, pieArcs } from './chart-geometry';

describe('chart geometry', () => {
  test('axis max is the largest value and never 0', () => {
    expect(axisMax([[1, 5], [3]])).toBe(5);
    expect(axisMax([[0, 0]])).toBe(1);
    expect(axisMax([[Number.NaN, -2]])).toBe(1);
  });

  test('bars are bottom-aligned, scaled to the max, grouped per category', () => {
    const rects = barRects([[10, 5]], 2, 200, 100, 4);
    expect(rects).toHaveLength(2);
    expect(rects[0]).toMatchObject({ y: 0, height: 100, index: 0, series: 0 });
    expect(rects[1]).toMatchObject({ y: 50, height: 50, index: 1 });
    expect(rects[1]!.x).toBeGreaterThan(rects[0]!.x);
  });

  test('negative and missing values draw as 0', () => {
    const rects = barRects([[-3]], 2, 100, 100);
    expect(rects.map((r) => r.height)).toEqual([0, 0]);
  });

  test('line path spans the width', () => {
    expect(linePath([0, 10], 100, 50, 10)).toBe('M0.00,50.00 L100.00,0.00');
    expect(linePath([], 100, 50, 10)).toBe('');
  });

  test('pie arcs: one path per non-zero slice; all-zero draws nothing', () => {
    expect(pieArcs([1, 0, 1], 50, 30).map((a) => a.index)).toEqual([0, 2]);
    expect(pieArcs([0, 0], 50, 30)).toEqual([]);
    expect(pieArcs([5], 50, 30)[0]!.path.startsWith('M50.00,0.00')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && bun test lib/genui/chart-geometry.test.ts`
Expected: FAIL — `Cannot find module './chart-geometry'`.

- [ ] **Step 3: Write the geometry**

`apps/mobile/lib/genui/chart-geometry.ts`:

```ts
/** Pure chart geometry for react-native-svg. No React, no theme: unit-tested under Bun. */

export interface BarRect {
  x: number;
  y: number;
  width: number;
  height: number;
  series: number;
  index: number;
}

const finite = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Upper bound of the value axis: the largest value, never 0 (an all-zero chart still draws an axis). */
export function axisMax(series: number[][]): number {
  const max = Math.max(0, ...series.flat().map(finite));
  return max > 0 ? max : 1;
}

/** Grouped bars: one group per category, one bar per series, bottom-aligned to `height`. */
export function barRects(series: number[][], categories: number, width: number, height: number, gap = 4): BarRect[] {
  if (categories === 0 || series.length === 0) return [];
  const max = axisMax(series);
  const groupWidth = width / categories;
  const barWidth = Math.max(1, (groupWidth - gap * (series.length + 1)) / series.length);
  const rects: BarRect[] = [];
  for (let index = 0; index < categories; index++) {
    series.forEach((values, s) => {
      const value = Math.max(0, finite(values[index]));
      const barHeight = (value / max) * height;
      rects.push({
        x: index * groupWidth + gap + s * (barWidth + gap),
        y: height - barHeight,
        width: barWidth,
        height: barHeight,
        series: s,
        index,
      });
    });
  }
  return rects;
}

/** SVG path through `points` values spread evenly across `width`. */
export function linePath(values: number[], width: number, height: number, max: number): string {
  if (values.length === 0) return '';
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values
    .map((value, i) => {
      const x = values.length > 1 ? i * step : width / 2;
      const y = height - (Math.max(0, finite(value)) / max) * height;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

/** Donut slices as SVG paths centered on (r, r). A single non-zero slice draws a full ring. */
export function pieArcs(values: number[], radius: number, inner: number): { path: string; index: number }[] {
  const clean = values.map((v) => Math.max(0, finite(v)));
  const total = clean.reduce((sum, v) => sum + v, 0);
  if (total === 0) return [];
  const point = (angle: number, r: number) => [radius + r * Math.sin(angle), radius - r * Math.cos(angle)] as const;
  const arcs: { path: string; index: number }[] = [];
  let start = 0;
  clean.forEach((value, index) => {
    if (value === 0) return;
    // A full circle cannot be one arc command: stop just short of 2π.
    const sweep = Math.min((value / total) * Math.PI * 2, Math.PI * 2 - 1e-4);
    const end = start + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const [x0, y0] = point(start, radius);
    const [x1, y1] = point(end, radius);
    const [x2, y2] = point(end, inner);
    const [x3, y3] = point(start, inner);
    arcs.push({
      index,
      path: `M${x0.toFixed(2)},${y0.toFixed(2)} A${radius},${radius} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} L${x2.toFixed(2)},${y2.toFixed(2)} A${inner},${inner} 0 ${large} 0 ${x3.toFixed(2)},${y3.toFixed(2)} Z`,
    });
    start = end;
  });
  return arcs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && bun test lib/genui/chart-geometry.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: The chart component**

`apps/mobile/components/genui/components/charts.tsx`:

```tsx
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { useColorScheme } from 'nativewind';
import { genuiA11yText, genuiNodeToMarkdown } from '@kortix/sdk/genui';
import type { GenuiComponentProps } from '@kortix/sdk/genui/react';

import { Text } from '@/components/ui/text';
import { axisMax, barRects, linePath, pieArcs } from '@/lib/genui/chart-geometry';
import { THEME, withAlpha } from '@/lib/utils/theme';

import { kids } from './layout';

const HEIGHT = 160;
/** Monochrome series: one ink at falling strength (brand: no decorative color). */
const STEPS = [1, 0.7, 0.45, 0.25, 0.6, 0.35];

export function GenuiChart({ node, props }: GenuiComponentProps) {
  const { colorScheme } = useColorScheme();
  const ink = (alpha: number) => withAlpha((colorScheme === 'dark' ? THEME.dark : THEME.light).foreground, alpha);
  const [width, setWidth] = useState(0);
  const [showData, setShowData] = useState(false);

  const series = kids(props.series);
  const values = series.map((s) => (s.props.values as number[] | undefined) ?? []);
  const labels = ((props.categories ?? props.x ?? []) as string[]);
  const slices = kids(props.slices);
  const legend = node.type === 'PieChart' ? slices.map((s) => String(s.props.label)) : series.map((s) => String(s.props.name));

  let drawing: React.ReactNode = null;
  if (width > 0) {
    if (node.type === 'BarChart') {
      drawing = barRects(values, labels.length, width, HEIGHT).map((r) => (
        <Rect key={`${r.series}-${r.index}`} x={r.x} y={r.y} width={r.width} height={r.height} rx={2} fill={ink(STEPS[r.series]!)} />
      ));
    } else if (node.type === 'LineChart') {
      const max = axisMax(values);
      drawing = values.map((v, k) => <Path key={k} d={linePath(v, width, HEIGHT, max)} stroke={ink(STEPS[k]!)} strokeWidth={2} fill="none" />);
    } else {
      const radius = HEIGHT / 2;
      drawing = pieArcs(slices.map((s) => Number(s.props.value)), radius, radius * 0.6).map((arc) => (
        <Path key={arc.index} d={arc.path} fill={ink(STEPS[arc.index]!)} transform={`translate(${width / 2 - radius}, 0)`} />
      ));
    }
  }

  return (
    <View className="gap-2 rounded-2xl bg-card p-4" accessible accessibilityLabel={genuiA11yText(node) ?? undefined}>
      <View style={{ height: HEIGHT }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {width > 0 ? (
          <Svg width={width} height={HEIGHT}>
            {drawing}
          </Svg>
        ) : null}
      </View>
      {node.type !== 'PieChart' && labels.length > 0 ? (
        <View className="flex-row justify-between">
          <Text variant="muted" className="text-xs">
            {labels[0]}
          </Text>
          <Text variant="muted" className="text-xs">
            {labels[labels.length - 1]}
          </Text>
        </View>
      ) : null}
      <View className="flex-row flex-wrap gap-3">
        {legend.map((name, i) => (
          <View key={`${name}-${i}`} className="flex-row items-center gap-1.5">
            <View style={{ backgroundColor: ink(STEPS[i]!) }} className="size-2.5 rounded-sm" />
            <Text variant="muted" className="text-xs">
              {name}
            </Text>
          </View>
        ))}
      </View>
      <Text variant="muted" className="text-xs">
        Source: {String(props.source)}
      </Text>
      <Pressable accessibilityRole="button" onPress={() => setShowData((v) => !v)}>
        <Text variant="muted" className="text-xs underline">
          {showData ? 'Hide data' : 'Show data'}
        </Text>
      </Pressable>
      {showData ? <Text className="font-mono text-xs">{genuiNodeToMarkdown(node)}</Text> : null}
    </View>
  );
}
```

Route `Source:`, `Show data`, `Hide data` through `t()` (`genui.source`, `genui.showData`, `genui.hideData`). Add `BarChart: GenuiChart, LineChart: GenuiChart, PieChart: GenuiChart,` to `mobileGenuiComponents`.

- [ ] **Step 6: Typecheck and test**

Run the Task 2 Step 5 and Step 6 commands. Expected: unchanged baseline; `bun test` PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/lib/genui apps/mobile/components/genui
git commit -m "feat(mobile): genui charts on react-native-svg"
```

---

### Task 5: Map (place list in the transcript, MapLibre fullscreen)

**Files:**
- Create: `apps/mobile/components/genui/map/map-html.ts`
- Test: `apps/mobile/components/genui/map/map-html.test.ts`
- Create: `apps/mobile/components/genui/map/map-sheet.tsx`
- Create: `apps/mobile/components/genui/components/map.tsx`
- Create: `apps/mobile/assets/maplibre/maplibre-gl.webjs`, `apps/mobile/assets/maplibre/maplibre-gl-css.webjs`
- Modify: `apps/mobile/components/genui/components/index.ts`, `apps/mobile/package.json` (devDependency `maplibre-gl@6.x` for the copy script)

**Interfaces:**
- Produces: `scriptJson(value): string`, `mapDocument(input: MapDocumentInput): string`; `mobileGenuiComponents.Map`; env `EXPO_PUBLIC_GENUI_MAP_STYLE_URL`.

- [ ] **Step 1: Write the failing test**

`apps/mobile/components/genui/map/map-html.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { mapDocument, scriptJson } from './map-html';

describe('map document', () => {
  test('model text cannot close the script tag', () => {
    const json = scriptJson({ label: '</script><script>alert(1)</script>' });
    expect(json).not.toContain('</script>');
    expect(JSON.parse(json).label).toBe('</script><script>alert(1)</script>');
  });

  test('line and paragraph separators are escaped', () => {
    const raw = `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`;
    const json = scriptJson(raw);
    expect(json).toBe('"a\\u2028b\\u2029c"');
    expect(JSON.parse(json)).toBe(raw);
  });

  test('builds a document with markers as [lng, lat] and the route converted', () => {
    const html = mapDocument({
      script: 'var maplibregl = {};',
      css: '.x{}',
      styleUrl: 'https://tiles.example.com/style.json',
      markers: [{ lat: 48.85, lng: 2.35, label: '</script>evil' }],
      route: [[48.85, 2.35], [48.86, 2.36]],
      background: 'rgb(255,255,255)',
      routeColor: 'rgba(0,0,0,0.7)',
    });
    expect(html).toContain('"lngLat":[2.35,48.85]');
    expect(html).toContain('"route":[[2.35,48.85],[2.36,48.86]]');
    expect(html).not.toContain('</script>evil');
    expect(html).toContain('https://tiles.example.com/style.json');
    expect(html).toContain('"routeColor":"rgba(0,0,0,0.7)"');
    expect(html).not.toMatch(/#[0-9a-f]{6}/i);
  });

  test('a script asset containing </script> cannot break out', () => {
    const html = mapDocument({ script: 'x="</script>"', css: '', styleUrl: 's', markers: [], background: 'white', routeColor: 'black' });
    expect(html.match(/<\/script>/g)?.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && bun test components/genui/map/map-html.test.ts`
Expected: FAIL — `Cannot find module './map-html'`.

- [ ] **Step 3: Write the document builder**

`apps/mobile/components/genui/map/map-html.ts`:

```ts
/** The fullscreen map document for react-native-webview. Pure: unit-tested under Bun. */

export interface MapDocumentInput {
  /** maplibre-gl.js source, loaded from the bundled asset. */
  script: string;
  /** maplibre-gl.css source. */
  css: string;
  styleUrl: string;
  markers: { lat: number; lng: number; label: string; description?: string }[];
  /** [lat, lng] pairs, as the catalog stores them. */
  route?: [number, number][];
  zoom?: number;
  /** Page background and route color: theme tokens through `withAlpha`, never hex (mobile AGENTS.md). */
  background: string;
  routeColor: string;
}

// Built from char codes: the raw characters end a line inside a regex literal.
const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), 'g');
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), 'g');

/**
 * JSON that is safe inside an inline <script>: `<`, `>`, `&`, U+2028 and U+2029 are escaped, so model
 * text such as `</script><script>…` stays data. Every model-supplied value reaches the page through this.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(LINE_SEPARATOR, '\\u2028')
    .replace(PARAGRAPH_SEPARATOR, '\\u2029');
}

export function mapDocument(input: MapDocumentInput): string {
  const data = scriptJson({
    styleUrl: input.styleUrl,
    markers: input.markers.map((m) => ({ lngLat: [m.lng, m.lat], label: m.label, description: m.description ?? '' })),
    route: (input.route ?? []).map(([lat, lng]) => [lng, lat]),
    zoom: input.zoom ?? null,
    routeColor: input.routeColor,
  });
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>${input.css.replace(/<\/style/gi, '<\\/style')}
html,body,#map{margin:0;height:100%;background:${input.background}}
.kx-pop{font:14px -apple-system,system-ui,sans-serif}.kx-pop p{margin:4px 0 0;opacity:.7}</style></head>
<body><div id="map"></div>
<script>${input.script.replace(/<\/script/gi, '<\\/script')}</script>
<script>
(function(){
  var d = ${data};
  var map = new maplibregl.Map({ container: 'map', style: d.styleUrl, attributionControl: { compact: true } });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  var bounds = new maplibregl.LngLatBounds();
  d.markers.forEach(function (m) {
    var pop = document.createElement('div');
    pop.className = 'kx-pop';
    var title = document.createElement('strong');
    title.textContent = m.label;
    pop.appendChild(title);
    if (m.description) { var p = document.createElement('p'); p.textContent = m.description; pop.appendChild(p); }
    new maplibregl.Marker().setLngLat(m.lngLat).setPopup(new maplibregl.Popup({ offset: 24 }).setDOMContent(pop)).addTo(map);
    bounds.extend(m.lngLat);
  });
  map.on('load', function () {
    if (d.route.length > 1) {
      map.addSource('route', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: d.route } } });
      map.addLayer({ id: 'route', type: 'line', source: 'route', paint: { 'line-width': 3, 'line-color': d.routeColor } });
    }
    if (d.markers.length === 1) map.jumpTo({ center: d.markers[0].lngLat, zoom: d.zoom || 14 });
    else map.fitBounds(bounds, { padding: 48, animate: false, maxZoom: d.zoom || 16 });
  });
})();
</script></body></html>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && bun test components/genui/map/map-html.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Bundle MapLibre as assets**

Metro already treats `.webjs` as an asset (the Mermaid bundle uses it). Copy the pinned build:

```bash
cd apps/mobile
pnpm add -D maplibre-gl@6
cp node_modules/maplibre-gl/dist/maplibre-gl.js assets/maplibre/maplibre-gl.webjs
cp node_modules/maplibre-gl/dist/maplibre-gl.css assets/maplibre/maplibre-gl-css.webjs
ls -la assets/maplibre
```

Record both sizes in the PR: they ship in the OTA update. The CSS uses the `.webjs` extension only so Metro treats it as an asset; it is read as text.

- [ ] **Step 6: The fullscreen sheet**

`apps/mobile/components/genui/map/map-sheet.tsx` (asset loading copied from `MermaidRendererHost.tsx` L33-51; WebView flags from `MermaidBlock.tsx` L153-169; navigation guard `allowInlineDocumentLoad` from `mermaid-html.ts`):

```tsx
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useColorScheme } from 'nativewind';

import { KortixLoader } from '@/components/kortix/kortix-loader';
import { allowInlineDocumentLoad } from '@/components/markdown/mermaid/mermaid-html';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { THEME, withAlpha } from '@/lib/utils/theme';

import { mapDocument, type MapDocumentInput } from './map-html';

const SCRIPT = require('@/assets/maplibre/maplibre-gl.webjs');
const CSS = require('@/assets/maplibre/maplibre-gl-css.webjs');
const ORIGIN_WHITELIST = ['*'];

let bundle: Promise<{ script: string; css: string }> | null = null;
async function readText(moduleId: number): Promise<string> {
  const asset = await Asset.fromModule(moduleId).downloadAsync();
  return new File(asset.localUri ?? asset.uri).text();
}
/** Read once per app run; every later map reuses the strings. */
function loadBundle() {
  bundle ??= Promise.all([readText(SCRIPT), readText(CSS)]).then(([script, css]) => ({ script, css }));
  return bundle;
}

export function MapSheet({
  open,
  onOpenChange,
  title,
  data,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  data: Omit<MapDocumentInput, 'script' | 'css' | 'background' | 'routeColor'>;
}) {
  const { colorScheme } = useColorScheme();
  const theme = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void loadBundle().then(({ script, css }) => {
      if (!alive) return;
      setHtml(mapDocument({ ...data, script, css, background: withAlpha(theme.background, 1), routeColor: withAlpha(theme.foreground, 0.7) }));
    });
    return () => {
      alive = false;
    };
  }, [open, data, theme]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[85%] w-full p-0">
        <DialogTitle className="px-4 pt-4">{title}</DialogTitle>
        <View className="flex-1 overflow-hidden rounded-b-2xl">
          {html ? (
            <WebView
              source={{ html, baseUrl: '' }}
              originWhitelist={ORIGIN_WHITELIST}
              onShouldStartLoadWithRequest={allowInlineDocumentLoad}
              javaScriptEnabled
              cacheEnabled={false}
              incognito
              style={{ backgroundColor: 'transparent' }}
            />
          ) : (
            <View className="flex-1 items-center justify-center">
              <KortixLoader />
            </View>
          )}
        </View>
      </DialogContent>
    </Dialog>
  );
}
```

(Match `DialogContent` usage to `MermaidBlock.tsx` L210-230 — the fullscreen class names and close control there are the reference.)

- [ ] **Step 7: The transcript component**

`apps/mobile/components/genui/components/map.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { genuiA11yText } from '@kortix/sdk/genui';
import type { GenuiComponentProps } from '@kortix/sdk/genui/react';

import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { CaretRightIcon, MapTrifoldIcon } from '@/lib/icons';

import { MapSheet } from '../map/map-sheet';
import { kids } from './layout';
import { openGenuiLink } from './open-link';

const STYLE_URL = process.env.EXPO_PUBLIC_GENUI_MAP_STYLE_URL;

/** design.md §8: no embedded viewer in the transcript. The places are rows; the map opens fullscreen. */
export function GenuiMap({ node, props }: GenuiComponentProps) {
  const [open, setOpen] = useState(false);
  const markers = kids(props.markers);
  const data = useMemo(
    () => ({
      styleUrl: STYLE_URL ?? '',
      markers: markers.map((m) => ({
        lat: Number(m.props.lat),
        lng: Number(m.props.lng),
        label: String(m.props.label),
        description: m.props.description ? String(m.props.description) : undefined,
      })),
      route: props.route as [number, number][] | undefined,
      zoom: props.zoom as number | undefined,
    }),
    [markers, props.route, props.zoom],
  );

  return (
    <View className="overflow-hidden rounded-2xl bg-card" accessible accessibilityLabel={genuiA11yText(node) ?? undefined}>
      {STYLE_URL ? (
        <Pressable accessibilityRole="button" onPress={() => setOpen(true)} className="flex-row items-center gap-3 px-4 py-3">
          <Icon as={MapTrifoldIcon} size={18} className="text-foreground" />
          <Text className="flex-1 font-medium">Open map</Text>
          <Icon as={CaretRightIcon} size={16} className="text-muted-foreground" />
        </Pressable>
      ) : null}
      {markers.map((m, index) => (
        <View key={m.id}>
          {index > 0 || STYLE_URL ? <Separator /> : null}
          <Pressable
            accessibilityRole="link"
            onPress={() => openGenuiLink(`https://www.openstreetmap.org/?mlat=${m.props.lat}&mlon=${m.props.lng}#map=15/${m.props.lat}/${m.props.lng}`)}
            className="px-4 py-3"
          >
            <Text className="font-medium">{String(m.props.label)}</Text>
          </Pressable>
        </View>
      ))}
      <Text variant="muted" className="px-4 pb-3 text-xs">
        Source: {String(props.source)}
      </Text>
      {STYLE_URL ? <MapSheet open={open} onOpenChange={setOpen} title={markers.length === 1 ? String(markers[0]!.props.label) : 'Map'} data={data} /> : null}
    </View>
  );
}
```

Route `Open map`, `Map`, `Source:` through `t()`. Marker descriptions show in the fullscreen popups, not under the rows (no descriptions under rows). Add `Map: GenuiMap,` to `mobileGenuiComponents`. Add `EXPO_PUBLIC_GENUI_MAP_STYLE_URL=` with a comment to `apps/mobile/.env.example` next to the other `EXPO_PUBLIC_*` keys.

- [ ] **Step 8: Typecheck and test**

Run the Task 2 Step 5 and Step 6 commands. Expected: unchanged baseline; `bun test` PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/mobile/components/genui apps/mobile/assets/maplibre apps/mobile/package.json pnpm-lock.yaml apps/mobile/.env.example
git commit -m "feat(mobile): genui map as place rows with a fullscreen MapLibre view"
```

---

### Task 6: Settings row and copy paths

**Files:**
- Modify: `apps/mobile/components/settings/AccountPage.tsx` (Preferences group, ~L206-221; icon imports L20-28)
- Modify: `apps/mobile/components/session/turn/turn-actions.tsx` (~L80)
- Modify: `apps/mobile/components/markdown/ios-selection-fallback.tsx` (~L69)
- Modify: `apps/mobile/locales/*.json` (next to `"sounds"`)

**Interfaces:**
- Consumes: `useGenuiStore` (Task 1), `genuiToMarkdown` (plan-1).

- [ ] **Step 1: Settings row (no description, per the mobile rule)**

In `AccountPage.tsx`, add `SquaresFourIcon as SquaresFour,` to the `@/lib/icons` import, `import { Switch } from '@/components/ui/switch';`, `import { useGenuiStore } from '@/stores/genui-store';`, and inside the component:

```tsx
  const genuiEnabled = useGenuiStore((s) => s.enabled);
  const setGenuiEnabled = useGenuiStore((s) => s.setEnabled);
```

In the Preferences `SettingsGroup`, after the Sounds row:

```tsx
          <SettingsRow
            icon={SquaresFour}
            label={t('account.richAnswers', 'Rich answers')}
            right={<Switch checked={genuiEnabled} onCheckedChange={setGenuiEnabled} />}
          />
```

Add `"richAnswers": "Rich answers"` next to `"sounds"` in each `apps/mobile/locales/*.json` file.

- [ ] **Step 2: Copy paths**

`turn-actions.tsx` ~L80:

```tsx
    await Clipboard.setStringAsync(genuiToMarkdown(response));
```

`ios-selection-fallback.tsx` ~L69: wrap the copied string the same way. Add `import { genuiToMarkdown } from '@kortix/sdk/genui';` to both files.

Then: `rg -n "setStringAsync" apps/mobile/components/session apps/mobile/components/markdown | rg -v test` — every hit that copies assistant text goes through `genuiToMarkdown`; Mermaid's long-press (chart source) is not assistant prose and stays.

- [ ] **Step 3: Typecheck and test**

Run the Task 2 Step 5 and Step 6 commands. Expected: unchanged baseline; `bun test` PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/components apps/mobile/locales
git commit -m "feat(mobile): Rich answers setting; copy renders generative UI as markdown"
```

---

### Task 7: Device verification and the OTA

- [ ] **Step 1: Full local run**

```bash
cd apps/mobile && bun test
cd ../.. && pnpm test && pnpm test:verify --rev HEAD --branch genui
```

Expected: green; verify exits 0.

- [ ] **Step 2: Prepare the device check for Jay (no simulator — standing rule)**

Start Metro for the worktree and hand Jay the exact script; he runs it on his device (Expo Go on Android per his setup, or the dev build):
1. Project with `genui` on; send `Compare these two plans: Basic 10 USD with 3 projects; Pro 30 USD with unlimited projects.` → two option cards stream in, no `root = ` text at any moment.
2. Send `Show me revenue by quarter: Q1 120, Q2 150, Q3 170.` → bar chart, legend, Source line; Show data toggles the table.
3. A reply with a Map (with `EXPO_PUBLIC_GENUI_MAP_STYLE_URL` set) → place rows; Open map shows the fullscreen map; scrolling the transcript never moves a map.
4. Settings → Rich answers off → the same messages show text; on → UI again.
5. Copy on a turn with a block → pasted text has `[...]` / tables, not `root =`.
6. Light and dark theme; Android and iOS if both are at hand.

7. Streaming smoothness (spec §8.4): with the in-app Performance Monitor (Expo dev menu → Toggle performance monitor), stream the `ui-four-products` comparison with Rich answers on and then off; JS FPS during streaming should not drop more than 5 fps below the off run on the same device. Note the device model (prefer a low-end Android).

Record Jay's result in the PR. Any failure goes back into the task that owns it.

- [ ] **Step 3: Publish the OTA (needs Jay's explicit approval)**

Find the OTA process: `rg -n "eas update" .github/workflows apps/mobile/package.json | head`. Publishing to the production channel reaches every installed app; ask Jay before running it (release gate). After publishing, record the update ID and the runtime version (`1.4.4`) in the PR.

- [ ] **Step 4: Old-build check**

On a build without the OTA (or with the update disabled), open the same comparison message: it shows a code block with the OpenUI source — accepted (spec R-MOB-1). Relaunch with the OTA: it renders cards.

- [ ] **Step 5: Open PR 3**

Per the **contributing** skill: summary + test plan only; include `bun test` output, the tsc baseline diff, the asset sizes, Jay's device result, and the OTA update ID.
