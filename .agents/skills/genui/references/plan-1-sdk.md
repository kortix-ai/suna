# Generative UI — plan 1: `@kortix/sdk/genui` and `@kortix/sdk/genui/react`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. ALSO REQUIRED: load the **sdk** skill (`.agents/skills/sdk/SKILL.md`) before Task 1 — its TDD, export, and verdict rules apply to every task here.

**Goal:** Ship the framework-free genui core and the headless React renderer as two new `@kortix/sdk` subpaths, with unbranded default components for third-party hosts.

**Architecture:** `src/genui/` wraps `@openuidev/lang-core` in one adapter: a 24-component catalog (17 blocks + 7 sub-items) built from zod schemas, a prompt builder, a streaming parser that adds Kortix validation (`validate.ts`) and structural sharing (`share.ts`), and a deterministic markdown fallback. `src/genui/react/` renders a parse result through a host-supplied component map, memoized per node, with one error boundary per block.

**Tech Stack:** TypeScript 5.9, `@openuidev/lang-core` 0.3.1, `zod/v4` from zod 3.25.76, React 19, Bun test, `react-test-renderer`, `react-dom/server`.

**Spec:** `.agents/skills/genui/references/spec.md` (§5, §6, §8.1 R-SDK-1, R-STREAM-1, R-SEC-1). Master plan: `plan.md` (Global Constraints, contracts, deltas D1–D4).

**Provenance:** every code block in this file ran before the plan was written: 42 SDK tests in 7 files passed under Bun 1.3.14, and `tsc --noEmit` (TypeScript 5.9.3, the repo's strict base config) exited 0. Measured: a 4.4 KB block streamed in 70 ticks costs ~0.1–0.25 ms per tick; the prompt is ~7,000 chars (~1,760 tokens).

## Global Constraints

See `plan.md` § Global Constraints. The ones this plan must not break: optional peers only; root never imports `./genui`; `zod/v4`; lang-core pinned `0.3.1`; `safeUrl()` on every URL; never bump `version`.

## Review Focus

See `plan.md` § Review Focus items 1, 2, 3, 5 — their tests are in Tasks 2, 5, and 7 of this plan.

All commands run from the worktree root `/Users/jay/root/kortix/suna-genui`.

---

### Task 1: Package wiring for the two subpaths

**Files:**
- Modify: `packages/sdk/package.json` (`exports`, `publishConfig.exports`, `peerDependencies`, `peerDependenciesMeta`, `devDependencies`, `scripts.test`)
- Modify: `packages/sdk/src/index.isomorphic.test.ts` (`SUBPATH_TIERS` list ~L174-212; React filter ~L218)
- Modify: `packages/sdk/src/root-canonical.test.ts` (`NOT_ROOT_REACHABLE` ~L46-62)
- Create: `packages/sdk/src/genui/types.ts`, `packages/sdk/src/genui/index.ts`, `packages/sdk/src/genui/react/index.ts`

**Interfaces:**
- Produces: subpaths `@kortix/sdk/genui` → `src/genui/index.ts`, `@kortix/sdk/genui/react` → `src/genui/react/index.ts`; types `GenuiNode`, `GenuiIssue`, `GenuiIssueCode`, `GenuiParseResult`, `GenuiSegment`; const `GENUI_SCHEMA_VERSION = 1`.

- [ ] **Step 1: Add the export entries first (the existing tripwire tests are the failing tests)**

In `packages/sdk/package.json`, add to `exports` (workspace paths):

```json
"./genui": "./src/genui/index.ts",
"./genui/react": "./src/genui/react/index.ts",
```

and to `publishConfig.exports` (published paths):

```json
"./genui": { "types": "./dist/genui/index.d.ts", "import": "./dist/genui/index.js" },
"./genui/react": { "types": "./dist/genui/react/index.d.ts", "import": "./dist/genui/react/index.js" },
```

- [ ] **Step 2: Run the tripwire tests to verify they fail**

Run: `cd packages/sdk && bun test src/index.isomorphic.test.ts src/root-canonical.test.ts src/package-exports.test.ts`
Expected: FAIL — `SUBPATH_TIERS matches package.json exports (minus "." and "./react")` reports `./genui` and `./genui/react` missing; `root-canonical` cannot import the subpaths.

- [ ] **Step 3: Add dependencies and the test-script glob**

In `packages/sdk/package.json`:

```json
"peerDependencies": {
  "@openuidev/lang-core": "0.3.1",
  "@tanstack/react-query": "^5.75.2",
  "react": ">=18",
  "zod": "^3.25.0 || ^4.0.0"
},
"peerDependenciesMeta": {
  "@openuidev/lang-core": { "optional": true },
  "@tanstack/react-query": { "optional": true },
  "react": { "optional": true },
  "zod": { "optional": true }
},
```

Add to `devDependencies`: `"@openuidev/lang-core": "0.3.1"` and `"zod": "3.25.76"`.

Replace `scripts.test` so `.tsx` tests run (today only `*.test.ts` runs):

```json
"test": "find src \\( -name '*.test.ts' -o -name '*.test.tsx' \\) -print0 | sort -z | xargs -0 -n1 -P4 bun test --isolate",
```

Run: `pnpm install --filter @kortix/sdk`
Expected: lockfile gains `@openuidev/lang-core@0.3.1` (its postinstall does not run: root `.npmrc` has `ignore-scripts=true`).

- [ ] **Step 4: Create the types and the two barrels**

`packages/sdk/src/genui/types.ts`:

```ts
/** The schema version this build renders. A fence names its version in its language tag. */
export const GENUI_SCHEMA_VERSION = 1 as const;

/** One validated, render-ready component instance. Child slots hold `GenuiNode[]`. */
export interface GenuiNode {
  /** Stable React key: the statement name, else the slot path. Unique within one block. */
  id: string;
  /** Component name from the catalog, e.g. `BarChart`. */
  type: string;
  props: Record<string, unknown>;
  /** The model has not finished writing this statement yet. */
  partial: boolean;
}

export type GenuiIssueCode =
  | 'schema'
  | 'unknown-component'
  | 'wrong-child'
  | 'url'
  | 'depth'
  | 'version'
  | 'no-root'
  /** The stream ended inside this statement (turn aborted or failed). */
  | 'cut-off'
  /** Query, Mutation, or $state: not supported before Phase 4; never executed. */
  | 'unsupported-statement';

export interface GenuiIssue {
  code: GenuiIssueCode;
  component?: string;
  statementId?: string;
  message: string;
}

export interface GenuiParseResult {
  /** Root `Stack`, or null when nothing renderable exists yet. */
  root: GenuiNode | null;
  /** Statement names referenced but not written yet. */
  pending: string[];
  /** Everything dropped or repaired, for telemetry and debugging. Never shown to users. */
  issues: GenuiIssue[];
  streaming: boolean;
}

export type GenuiSegment =
  | { kind: 'markdown'; text: string }
  | { kind: 'genui'; code: string; version: number; closed: boolean };
```

`packages/sdk/src/genui/index.ts` (later tasks add one export line each):

```ts
export {
  GENUI_SCHEMA_VERSION,
  type GenuiIssue,
  type GenuiIssueCode,
  type GenuiNode,
  type GenuiParseResult,
  type GenuiSegment,
} from './types';
```

`packages/sdk/src/genui/react/index.ts` (Task 7 fills it):

```ts
export {};
```

- [ ] **Step 5: Register the tiers**

In `packages/sdk/src/index.isomorphic.test.ts`, add to `SUBPATH_TIERS`:

```ts
  { name: './genui', file: 'genui/index.ts', tier: 'isomorphic-core' },
```

and widen the React exemption in the `SUBPATH_TIERS matches package.json exports` test (React belongs in `./genui/react` exactly as in `./react`):

```ts
  const exportedSubpaths = Object.keys(pkg.exports).filter(
    (k) => k !== '.' && k !== './react' && k !== './genui/react',
  );
```

Rename that test's title to `'SUBPATH_TIERS matches package.json exports (minus ".", "./react", "./genui/react")'`.

In `packages/sdk/src/root-canonical.test.ts`, add to `NOT_ROOT_REACHABLE`:

```ts
  './genui', // optional peers (zod, lang-core): the root barrel must not pull them in
  './genui/react',
```

- [ ] **Step 6: Run the tripwire tests to verify they pass**

Run: `cd packages/sdk && bun test src/index.isomorphic.test.ts src/root-canonical.test.ts src/package-exports.test.ts`
Expected: PASS. (`public-surface` snapshots are updated once, in Task 9.)

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/package.json pnpm-lock.yaml packages/sdk/src/genui packages/sdk/src/index.isomorphic.test.ts packages/sdk/src/root-canonical.test.ts
git commit -m "feat(sdk): add @kortix/sdk/genui and /genui/react subpaths"
```

---

### Task 2: Fence detection and reply splitting

**Files:**
- Create: `packages/sdk/src/genui/fence.ts`
- Test: `packages/sdk/src/genui/fence.test.ts`
- Modify: `packages/sdk/src/genui/index.ts`

**Interfaces:**
- Produces: `genuiVersionOf(tag: string): number | null`, `genuiVersionFromClassName(className: string | undefined): number | null`, `splitGenui(text: string): GenuiSegment[]`.

- [ ] **Step 1: Write the failing test**

`packages/sdk/src/genui/fence.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { genuiVersionFromClassName, genuiVersionOf, splitGenui } from './fence';

describe('fence', () => {
  test('version tags', () => {
    expect(genuiVersionOf('openui')).toBe(1);
    expect(genuiVersionOf('OpenUI-Lang')).toBe(1);
    expect(genuiVersionOf('openui-v2')).toBe(2);
    expect(genuiVersionOf('python')).toBeNull();
    expect(genuiVersionFromClassName('language-openui-lang')).toBe(1);
    expect(genuiVersionFromClassName('language-openui-v2')).toBe(2);
    expect(genuiVersionFromClassName('language-ts')).toBeNull();
  });

  test('splits prose and blocks in order, keeps other fences as markdown', () => {
    const text = 'Intro\n\n```openui\nroot = Stack([x])\n```\n\n```ts\nconst a = 1\n```\nEnd';
    expect(splitGenui(text)).toEqual([
      { kind: 'markdown', text: 'Intro\n' },
      { kind: 'genui', code: 'root = Stack([x])', version: 1, closed: true },
      { kind: 'markdown', text: '\n```ts\nconst a = 1\n```\nEnd' },
    ]);
  });

  test('an openui tag inside another fence stays markdown', () => {
    const text = '````md\n```openui\nroot = Stack([])\n```\n````';
    expect(splitGenui(text)).toEqual([{ kind: 'markdown', text }]);
  });

  test('an unclosed block is still streaming', () => {
    expect(splitGenui('Hi\n```openui\nroot = Sta')).toEqual([
      { kind: 'markdown', text: 'Hi' },
      { kind: 'genui', code: 'root = Sta', version: 1, closed: false },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test src/genui/fence.test.ts`
Expected: FAIL — `Cannot find module './fence'`.

- [ ] **Step 3: Write the implementation**

`packages/sdk/src/genui/fence.ts`:

```ts
import type { GenuiSegment } from './types';

/** v1 fence tags. `openui-lang` is the tag OpenUI's own docs teach, so models also write it. */
const V1_TAGS = new Set(['openui', 'openui-lang']);
const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;

/** Schema version for a fence language tag, or null when the fence is not generative UI. */
export function genuiVersionOf(tag: string): number | null {
  const lang = tag.trim().toLowerCase();
  if (V1_TAGS.has(lang)) return 1;
  const match = /^openui-v(\d{1,3})$/.exec(lang);
  return match ? Number(match[1]) : null;
}

/** Same as `genuiVersionOf`, for a markdown renderer's `language-…` class name. */
export function genuiVersionFromClassName(className: string | undefined): number | null {
  const match = /(?:^|\s)language-([\w-]+)/.exec(className ?? '');
  return match ? genuiVersionOf(match[1]) : null;
}

/**
 * Split a reply into markdown and generative-UI segments, in order.
 * A generative-UI tag inside another fence stays markdown (an agent showing an example).
 * An unclosed generative-UI fence at the end is a block still streaming (`closed: false`).
 */
export function splitGenui(text: string): GenuiSegment[] {
  const segments: GenuiSegment[] = [];
  const lines = text.split('\n');
  let markdown: string[] = [];
  let fence: { marker: string; version: number | null; body: string[] } | null = null;

  const flushMarkdown = () => {
    if (markdown.length > 0) segments.push({ kind: 'markdown', text: markdown.join('\n') });
    markdown = [];
  };

  for (const line of lines) {
    if (!fence) {
      const open = OPEN_FENCE.exec(line);
      if (!open) {
        markdown.push(line);
        continue;
      }
      const version = genuiVersionOf(open[2] ?? '');
      fence = { marker: open[1]!, version, body: [] };
      if (version === null) markdown.push(line);
      else flushMarkdown();
      continue;
    }
    const trimmed = line.trim();
    const closes =
      trimmed.length >= fence.marker.length &&
      trimmed[0] === fence.marker[0] &&
      /^(`+|~+)$/.test(trimmed);
    if (!closes) {
      if (fence.version === null) markdown.push(line);
      else fence.body.push(line);
      continue;
    }
    if (fence.version === null) markdown.push(line);
    else segments.push({ kind: 'genui', code: fence.body.join('\n'), version: fence.version, closed: true });
    fence = null;
  }

  if (fence && fence.version !== null) {
    segments.push({ kind: 'genui', code: fence.body.join('\n'), version: fence.version, closed: false });
  }
  flushMarkdown();
  return segments;
}
```

Add to `packages/sdk/src/genui/index.ts`:

```ts
export { genuiVersionFromClassName, genuiVersionOf, splitGenui } from './fence';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk && bun test src/genui/fence.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/genui
git commit -m "feat(sdk/genui): detect openui fences and split replies"
```

---

### Task 3: URL safety

**Files:**
- Create: `packages/sdk/src/genui/urls.ts`
- Test: `packages/sdk/src/genui/urls.test.ts`
- Modify: `packages/sdk/src/genui/index.ts`

**Interfaces:**
- Produces: `safeUrl(raw: unknown): string | null`.

- [ ] **Step 1: Write the failing test**

`packages/sdk/src/genui/urls.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { safeUrl } from './urls';

describe('safeUrl', () => {
  test('allows only absolute http(s)', () => {
    expect(safeUrl('https://example.com/a b')).toBe('https://example.com/a%20b');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,<b>')).toBeNull();
    expect(safeUrl('/relative')).toBeNull();
    expect(safeUrl(42)).toBeNull();
    expect(safeUrl(`https://e.com/${'a'.repeat(3000)}`)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test src/genui/urls.test.ts`
Expected: FAIL — `Cannot find module './urls'`.

- [ ] **Step 3: Write the implementation**

`packages/sdk/src/genui/urls.ts`:

```ts
const MAX_URL_LENGTH = 2048;

/**
 * An absolute http(s) URL, normalized, or null. Model output reaches `href` and `src`
 * only through this function: lang-core does not enforce zod refinements such as `.url()`.
 */
export function safeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
}
```

Add to `index.ts`: `export { safeUrl } from './urls';`

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk && bun test src/genui/urls.test.ts`
Expected: PASS (1 test, 6 assertions).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/genui
git commit -m "feat(sdk/genui): allow only absolute http(s) URLs from model output"
```

---

### Task 4: Component catalog and prompt builder

**Files:**
- Create: `packages/sdk/src/genui/catalog.ts`, `packages/sdk/src/genui/prompt.ts`
- Test: `packages/sdk/src/genui/prompt.test.ts`
- Modify: `packages/sdk/src/genui/index.ts`

**Interfaces:**
- Consumes: `GenuiNode` (Task 1).
- Produces (internal to `src/genui/`): `GENUI_SPECS: Readonly<Record<string, GenuiComponentSpec>>`, `GENUI_LIBRARY: Library<string>`, `GENUI_BLOCKS`, `GENUI_MAX_DEPTH = 4`. Public: `buildGenuiPrompt(): string`, `GENUI_PROMPT_VERSION: string`.

Rules this task fixes for every later change to the catalog:
1. Positional order of `fields` is the OpenUI argument order. Required fields first; optional fields last. Never reorder an existing field: saved transcripts depend on it.
2. A slot uses `lazy: true` only when it can hold a component defined later (recursion). Lazy slots show `any[]` in the prompt signature, so their description names what they accept.
3. A new component enters the catalog only after web and mobile both render it and both are deployed (web deploy + mobile OTA). lang-core drops unknown components on old clients (delta D3).
4. Limits come from spec §6. Changing a limit is a spec change.

- [ ] **Step 1: Write the failing test**

`packages/sdk/src/genui/prompt.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { buildGenuiPrompt, GENUI_PROMPT_VERSION } from './prompt';

describe('prompt', () => {
  const prompt = buildGenuiPrompt();
  test('teaches every block and the Kortix rules, without tools or state', () => {
    for (const name of ['Stack(', 'Card(', 'BarChart(', 'Map(', 'Tabs(', 'Accordion(', 'RankedList(']) {
      expect(prompt).toContain(name);
    }
    expect(prompt).toContain('```openui');
    expect(prompt).toContain('Never invent numbers or coordinates');
    expect(prompt).not.toContain('Query(');
    expect(prompt).not.toContain('Mutation(');
    expect(prompt).not.toContain('$');
  });
  test('size and version', () => {
    console.log(`prompt chars=${prompt.length} ~tokens=${Math.round(prompt.length / 4)} version=${GENUI_PROMPT_VERSION}`);
    expect(prompt.length).toBeLessThan(16000);
    expect(GENUI_PROMPT_VERSION).toMatch(/^[0-9a-f]{8}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test src/genui/prompt.test.ts`
Expected: FAIL — `Cannot find module './prompt'`.

- [ ] **Step 3: Write the catalog**

`packages/sdk/src/genui/catalog.ts`:

```ts
import { createLibrary, defineComponent, type DefinedComponent, type Library } from '@openuidev/lang-core';
import { z } from 'zod/v4';

import type { GenuiNode } from './types';

/** A prop that holds child components. Validated by Kortix, because lang-core does not enforce `.min()`/`.max()`. */
export interface GenuiSlot {
  accepts: readonly string[];
  min: number;
  max: number;
  optional?: boolean;
  /** The slot can hold a component defined later (recursion). Costs prompt detail: the signature shows `any[]`. */
  lazy?: boolean;
}

export type GenuiChildToMarkdown = (node: GenuiNode) => string;

export interface GenuiComponentSpec {
  name: string;
  /** May appear directly inside a Stack, Tab, or AccordionItem. */
  block: boolean;
  /** Counts toward the nesting limit. */
  container: boolean;
  slots: Readonly<Record<string, GenuiSlot>>;
  /** URL props. `required`: an unsafe URL drops the node. `optional`: an unsafe URL drops the prop. */
  urls: Readonly<Record<string, 'required' | 'optional'>>;
  /** Full validation of a finished node (slot children already validated and counted). */
  strict: z.ZodType;
  /** Validation while the block streams: slot minimums are not enforced yet. */
  streaming: z.ZodType;
  toMarkdown(props: Record<string, any>, child: GenuiChildToMarkdown): string;
  /** Text equivalent for screen readers. Charts and maps only. */
  a11y?(props: Record<string, any>): string;
}

type Field = z.ZodType | GenuiSlot;
const isSlot = (field: Field): field is GenuiSlot => 'accepts' in field;

const defined: Record<string, DefinedComponent<any, string>> = {};
const specs: Record<string, GenuiComponentSpec> = {};

function refsOf(names: readonly string[]): z.ZodType {
  const refs = names.map((name) => {
    const component = defined[name];
    if (!component) throw new Error(`genui catalog: ${name} is used before it is defined`);
    return component.ref as z.ZodType;
  });
  return refs.length === 1 ? refs[0]! : z.union(refs as [z.ZodType, z.ZodType, ...z.ZodType[]]);
}

function component(input: {
  name: string;
  description: string;
  block?: boolean;
  container?: boolean;
  fields: Record<string, Field>;
  urls?: Record<string, 'required' | 'optional'>;
  toMarkdown: GenuiComponentSpec['toMarkdown'];
  a11y?: GenuiComponentSpec['a11y'];
}): void {
  const openui: Record<string, z.ZodType> = {};
  const strict: Record<string, z.ZodType> = {};
  const streaming: Record<string, z.ZodType> = {};
  const slots: Record<string, GenuiSlot> = {};
  for (const [key, field] of Object.entries(input.fields)) {
    if (!isSlot(field)) {
      openui[key] = field;
      strict[key] = field;
      streaming[key] = field;
      continue;
    }
    slots[key] = field;
    const item = field.lazy ? z.lazy(() => refsOf(field.accepts)) : refsOf(field.accepts);
    const strictArray = z.array(z.unknown()).min(field.min).max(field.max);
    const streamingArray = z.array(z.unknown()).max(field.max);
    openui[key] = field.optional ? z.array(item).optional() : z.array(item);
    strict[key] = field.optional ? strictArray.optional() : strictArray;
    streaming[key] = streamingArray.optional();
  }
  defined[input.name] = defineComponent({
    name: input.name,
    description: input.description,
    props: z.object(openui),
    component: input.name,
  });
  specs[input.name] = {
    name: input.name,
    block: input.block ?? true,
    container: input.container ?? false,
    slots,
    urls: input.urls ?? {},
    strict: z.object(strict),
    streaming: z.object(streaming),
    toMarkdown: input.toMarkdown,
    a11y: input.a11y,
  };
}

// ── Markdown helpers ────────────────────────────────────────────────────────

const cell = (value: unknown): string =>
  String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');

const mdTable = (head: string[], rows: unknown[][]): string =>
  [
    `| ${head.map(cell).join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${head.map((_, i) => cell(row[i] ?? '')).join(' | ')} |`),
  ].join('\n');

const nodes = (value: unknown): GenuiNode[] => (Array.isArray(value) ? (value as GenuiNode[]) : []);

const joinChildren = (value: unknown, child: GenuiChildToMarkdown, separator = '\n\n'): string =>
  nodes(value)
    .map(child)
    .filter((text) => text.length > 0)
    .join(separator);

const formatNumber = (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '';

const withUnit = (value: string, unit: unknown): string => (unit ? `${value} ${String(unit)}` : value);

const sourceLine = (source: unknown): string => `Source: ${String(source ?? '')}`;

function seriesTable(labels: string[], series: GenuiNode[], unit: unknown): string {
  const head = ['', ...series.map((s) => withUnit(String(s.props.name ?? ''), unit ? `(${unit})` : ''))];
  const rows = labels.map((label, i) => [
    label,
    ...series.map((s) => formatNumber((s.props.values as unknown[] | undefined)?.[i])),
  ]);
  return mdTable(head, rows);
}

const osmLink = (lat: number, lng: number): string =>
  `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`;

// ── Field shorthands ────────────────────────────────────────────────────────

const text = (max: number) => z.string().min(1).max(max);
const optText = (max: number) => z.string().max(max).optional();
const url = () => z.string().max(2048);

// ── Inline components ───────────────────────────────────────────────────────

component({
  name: 'Badge',
  description: 'Short status tag. tone: neutral, good, warn, bad',
  fields: { label: text(24), tone: z.enum(['neutral', 'good', 'warn', 'bad']).optional() },
  toMarkdown: (p) => `[${p.label}]`,
});

component({
  name: 'Link',
  description: 'A link to a source, booking page, or document',
  fields: { label: text(80), href: url() },
  urls: { href: 'required' },
  toMarkdown: (p) => `[${p.label}](${p.href})`,
});

component({
  name: 'Image',
  description: 'A picture. Use only URLs from tool results or files',
  fields: { src: url(), alt: text(200), caption: optText(200) },
  urls: { src: 'required' },
  toMarkdown: (p) => [`![${p.alt}](${p.src})`, p.caption ? `*${p.caption}*` : ''].filter(Boolean).join('\n\n'),
});

component({
  name: 'Callout',
  description: 'A key takeaway or warning. tone: info, warn, success',
  fields: { tone: z.enum(['info', 'warn', 'success']), body: text(400), title: optText(80) },
  toMarkdown: (p) => `> ${p.title ? `**${p.title}** ` : ''}${p.body}`,
});

// ── Data components ─────────────────────────────────────────────────────────

component({
  name: 'Stat',
  description: 'One key number. trend: up, down, flat',
  fields: {
    label: text(40),
    value: text(24),
    delta: optText(16),
    trend: z.enum(['up', 'down', 'flat']).optional(),
    unit: optText(12),
  },
  toMarkdown: (p) => `**${p.label}:** ${withUnit(String(p.value), p.unit)}${p.delta ? ` (${p.delta})` : ''}`,
});

component({
  name: 'StatRow',
  description: '2 to 4 Stats in a row, for the key numbers of an answer',
  fields: { stats: { accepts: ['Stat'], min: 2, max: 4 } },
  toMarkdown: (p, child) => nodes(p.stats).map((stat) => `- ${child(stat)}`).join('\n'),
});

component({
  name: 'Table',
  description: 'Rows a user scans or sorts. Up to 8 columns and 50 rows',
  fields: {
    columns: z.array(text(40)).min(1).max(8),
    rows: z.array(z.array(z.union([z.string().max(200), z.number()])).max(8)).max(50),
    caption: optText(120),
  },
  toMarkdown: (p) =>
    [p.caption ? `*${p.caption}*` : '', mdTable(p.columns as string[], p.rows as unknown[][])]
      .filter(Boolean)
      .join('\n\n'),
});

component({
  name: 'CompareItem',
  description: 'One option inside Compare. values line up with Compare specs',
  block: false,
  fields: {
    name: text(60),
    values: z.array(z.string().max(120)).max(12),
    pros: z.array(z.string().max(120)).max(5).optional(),
    cons: z.array(z.string().max(120)).max(5).optional(),
  },
  toMarkdown: (p) =>
    [
      `**${p.name}**`,
      ...((p.pros as string[] | undefined) ?? []).map((pro) => `- + ${pro}`),
      ...((p.cons as string[] | undefined) ?? []).map((con) => `- − ${con}`),
    ].join('\n'),
});

component({
  name: 'Compare',
  description: 'Side-by-side comparison of 2 to 4 options. specs are the row labels; winner names the pick',
  fields: {
    items: { accepts: ['CompareItem'], min: 2, max: 4 },
    specs: z.array(text(40)).max(12).optional(),
    winner: optText(60),
  },
  toMarkdown: (p, child) => {
    const items = nodes(p.items);
    const specsList = (p.specs as string[] | undefined) ?? [];
    const parts: string[] = [];
    if (specsList.length > 0) {
      parts.push(
        mdTable(
          ['', ...items.map((item) => String(item.props.name ?? ''))],
          specsList.map((spec, i) => [spec, ...items.map((item) => (item.props.values as string[])[i] ?? '—')]),
        ),
      );
    }
    parts.push(...items.map(child));
    if (p.winner) parts.push(`**Pick:** ${p.winner}`);
    return parts.join('\n\n');
  },
});

component({
  name: 'RankedItem',
  description: 'One entry inside RankedList',
  block: false,
  fields: { title: text(80), reason: text(240), meta: optText(80), image: url().optional(), href: url().optional() },
  urls: { image: 'optional', href: 'optional' },
  toMarkdown: (p) =>
    `**${p.title}** — ${p.reason}${p.meta ? ` (${p.meta})` : ''}${p.href ? ` [Open](${p.href})` : ''}`,
});

component({
  name: 'RankedList',
  description: 'A ranked recommendation, best first. Up to 10 items',
  fields: { items: { accepts: ['RankedItem'], min: 1, max: 10 } },
  toMarkdown: (p, child) => nodes(p.items).map((item, i) => `${i + 1}. ${child(item)}`).join('\n'),
});

// ── Charts ──────────────────────────────────────────────────────────────────

component({
  name: 'Series',
  description: 'One named series of numbers inside a chart',
  block: false,
  fields: { name: text(40), values: z.array(z.number()).max(365) },
  toMarkdown: (p) => `${p.name}: ${(p.values as number[]).map(formatNumber).join(', ')}`,
});

const chartA11y = (kind: string) => (p: Record<string, any>) =>
  `${kind}: ${nodes(p.series)
    .map((s) => s.props.name)
    .join(', ')}. Source: ${p.source}`;

component({
  name: 'BarChart',
  description: 'Amounts across up to 24 categories, up to 4 series. source names where the data came from',
  fields: {
    categories: z.array(text(40)).min(1).max(24),
    series: { accepts: ['Series'], min: 1, max: 4 },
    source: text(200),
    unit: optText(12),
  },
  toMarkdown: (p) =>
    `${seriesTable(p.categories as string[], nodes(p.series), p.unit)}\n\n${sourceLine(p.source)}`,
  a11y: chartA11y('Bar chart'),
});

component({
  name: 'LineChart',
  description: 'A trend over time: x labels, up to 4 series. source names where the data came from',
  fields: {
    x: z.array(text(40)).min(2).max(365),
    series: { accepts: ['Series'], min: 1, max: 4 },
    source: text(200),
    unit: optText(12),
  },
  toMarkdown: (p) => `${seriesTable(p.x as string[], nodes(p.series), p.unit)}\n\n${sourceLine(p.source)}`,
  a11y: chartA11y('Line chart'),
});

component({
  name: 'Slice',
  description: 'One part of a PieChart',
  block: false,
  fields: { label: text(40), value: z.number().nonnegative() },
  toMarkdown: (p) => `${p.label}: ${formatNumber(p.value)}`,
});

component({
  name: 'PieChart',
  description: 'Shares of a whole, 2 to 6 slices. source names where the data came from',
  fields: { slices: { accepts: ['Slice'], min: 2, max: 6 }, source: text(200), unit: optText(12) },
  toMarkdown: (p) => {
    const slices = nodes(p.slices);
    const total = slices.reduce((sum, s) => sum + (Number(s.props.value) || 0), 0);
    const lines = slices.map((s) => {
      const value = Number(s.props.value) || 0;
      const percent = total > 0 ? Math.round((value / total) * 100) : 0;
      return `- ${s.props.label}: ${withUnit(formatNumber(value), p.unit)} (${percent}%)`;
    });
    return `${lines.join('\n')}\n\n${sourceLine(p.source)}`;
  },
  a11y: (p) =>
    `Pie chart: ${nodes(p.slices)
      .map((s) => `${s.props.label} ${formatNumber(s.props.value)}`)
      .join(', ')}. Source: ${p.source}`,
});

// ── Map ─────────────────────────────────────────────────────────────────────

component({
  name: 'Marker',
  description: 'One place on a Map. Coordinates only from tool results or files',
  block: false,
  fields: {
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    label: text(60),
    description: optText(200),
  },
  toMarkdown: (p) =>
    `**${p.label}**${p.description ? ` — ${p.description}` : ''} ([map](${osmLink(p.lat, p.lng)}))`,
});

component({
  name: 'Map',
  description: 'Up to 25 places, optional route as [lat, lng] pairs, zoom 1-18. source names where the coordinates came from',
  fields: {
    markers: { accepts: ['Marker'], min: 1, max: 25 },
    source: text(200),
    route: z.array(z.array(z.number()).length(2)).max(500).optional(),
    zoom: z.number().int().min(1).max(18).optional(),
  },
  toMarkdown: (p, child) => `${nodes(p.markers).map((m) => `- ${child(m)}`).join('\n')}\n\n${sourceLine(p.source)}`,
  a11y: (p) =>
    `Map with ${nodes(p.markers).length} places: ${nodes(p.markers)
      .map((m) => m.props.label)
      .join(', ')}. Source: ${p.source}`,
});

// ── Card ────────────────────────────────────────────────────────────────────

component({
  name: 'Card',
  description: 'One item: a hotel, product, or person. body is plain text',
  fields: {
    title: text(80),
    body: optText(600),
    subtitle: optText(120),
    image: url().optional(),
    href: url().optional(),
    badges: { accepts: ['Badge'], min: 0, max: 4, optional: true },
  },
  urls: { image: 'optional', href: 'optional' },
  toMarkdown: (p, child) =>
    [
      `### ${p.title}`,
      p.subtitle ? `*${p.subtitle}*` : '',
      p.body ?? '',
      joinChildren(p.badges, child, ' '),
      p.image ? `![${p.title}](${p.image})` : '',
      p.href ? `[Open](${p.href})` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
});

// ── Containers ──────────────────────────────────────────────────────────────

export const GENUI_BLOCKS = [
  'Stack', 'Card', 'Stat', 'StatRow', 'Table', 'Compare', 'RankedList', 'BarChart', 'LineChart',
  'PieChart', 'Map', 'Tabs', 'Accordion', 'Badge', 'Callout', 'Image', 'Link',
] as const;
const INNER_BLOCKS = GENUI_BLOCKS.filter((name) => name !== 'Tabs' && name !== 'Accordion');

component({
  name: 'Tab',
  description: 'One tab inside Tabs: a label and its blocks',
  block: false,
  fields: { label: text(30), children: { accepts: INNER_BLOCKS, min: 1, max: 8, lazy: true } },
  toMarkdown: (p, child) => `#### ${p.label}\n\n${joinChildren(p.children, child)}`,
});

component({
  name: 'Tabs',
  description: '2 to 5 tabs. Use when content splits into views the user switches between',
  container: true,
  fields: { tabs: { accepts: ['Tab'], min: 2, max: 5 } },
  toMarkdown: (p, child) => joinChildren(p.tabs, child),
});

component({
  name: 'AccordionItem',
  description: 'One collapsible section inside Accordion',
  block: false,
  fields: { title: text(80), children: { accepts: INNER_BLOCKS, min: 1, max: 8, lazy: true } },
  toMarkdown: (p, child) => `#### ${p.title}\n\n${joinChildren(p.children, child)}`,
});

component({
  name: 'Accordion',
  description: 'Up to 10 collapsible sections, for details a reader may skip',
  container: true,
  fields: { items: { accepts: ['AccordionItem'], min: 1, max: 10 } },
  toMarkdown: (p, child) => joinChildren(p.items, child),
});

component({
  name: 'Stack',
  description: 'Layout. root is always a Stack. children: 1 to 12 blocks. direction: col (default) or row',
  container: true,
  fields: {
    children: { accepts: GENUI_BLOCKS, min: 1, max: 12, lazy: true },
    direction: z.enum(['col', 'row']).optional(),
  },
  toMarkdown: (p, child) => joinChildren(p.children, child),
});

export const GENUI_SPECS: Readonly<Record<string, GenuiComponentSpec>> = specs;

export const GENUI_LIBRARY: Library<string> = createLibrary({
  components: Object.values(defined),
  root: 'Stack',
});

/** Maximum container nesting (Stack, Tabs, Accordion) inside one block. */
export const GENUI_MAX_DEPTH = 4;
```

- [ ] **Step 4: Write the prompt builder**

`packages/sdk/src/genui/prompt.ts`:

```ts
import { GENUI_LIBRARY } from './catalog';

const PREAMBLE = `# Generative UI

Your replies are markdown. You MAY add generative UI blocks: fenced code blocks tagged \`openui\` that the
user's app renders as cards, comparisons, charts, maps, and tabs. Prose stays the default.

Use a UI block only when the content has structure:
- 2 or more options to compare, or a ranked recommendation
- 3 or more numbers, a time series, or a breakdown
- places with coordinates that came from a tool result or a file
- a status summary

Stay in prose for conversation, short answers (under about 3 sentences), explanations, opinions,
step-by-step instructions, and code. Code stays in ordinary code fences.

Format of a block:

\`\`\`openui
root = Stack([summary, list])
...
\`\`\``;

const RULES = [
  'Write at least one sentence of prose before the first block.',
  'At most 3 blocks per reply.',
  'Charts and maps use only data from tool results, files, or the user. Never invent numbers or coordinates. Always fill source.',
  'Images and links use only URLs from tool results, files, or the user.',
  'When the user asks for a chart, table, or comparison, use a block. When the user asks for plain text or no UI, write no block.',
  'Write openui blocks only in your chat reply. Never put them in messages you send to Slack, Teams, email, or files.',
];

const EXAMPLES = [
  `Example: a ranked recommendation (all values are placeholders).

Here are the three best options under your budget.

\`\`\`openui
root = Stack([stats, list])
stats = StatRow([checked, under])
checked = Stat("Options checked", "24")
under = Stat("Under budget", "9")
list = RankedList([a, b, c])
a = RankedItem("Option A", "Closest to the venue, best reviews", "4.7 stars")
b = RankedItem("Option B", "Quietest rooms", "4.6 stars")
c = RankedItem("Option C", "Lowest price", "4.4 stars")
\`\`\``,
  `Example: a chart from a tool result (all values are placeholders).

\`\`\`openui
root = Stack([chart])
chart = BarChart(["Q1", "Q2", "Q3"], [revenue], "billing export from the tool result", "USD")
revenue = Series("Revenue", [120, 150, 170])
\`\`\``,
];

/** The system-prompt section that teaches the model the Kortix generative UI catalog. */
export function buildGenuiPrompt(): string {
  return GENUI_LIBRARY.prompt({
    preamble: PREAMBLE,
    additionalRules: RULES,
    examples: EXAMPLES,
    toolCalls: false,
    bindings: false,
  });
}

/** FNV-1a of the prompt text. Telemetry and evaluation results carry it, so a prompt change is visible. */
export const GENUI_PROMPT_VERSION: string = (() => {
  let hash = 0x811c9dc5;
  for (const char of buildGenuiPrompt()) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
})();
```

Add to `index.ts`: `export { buildGenuiPrompt, GENUI_PROMPT_VERSION } from './prompt';`

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/sdk && bun test src/genui/prompt.test.ts`
Expected: PASS (2 tests). The log line prints `prompt chars=… ~tokens=… version=…`; record the three values in the commit body.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/genui
git commit -m "feat(sdk/genui): 17-block catalog and the generative UI prompt"
```

---

### Task 5: Streaming parser, Kortix validation, structural sharing

**Files:**
- Create: `packages/sdk/src/genui/validate.ts`, `packages/sdk/src/genui/share.ts`, `packages/sdk/src/genui/parse.ts`, `packages/sdk/src/genui/test-fixtures.ts`
- Test: `packages/sdk/src/genui/parse.test.ts`
- Modify: `packages/sdk/src/genui/index.ts`

**Interfaces:**
- Consumes: `GENUI_SPECS`, `GENUI_LIBRARY`, `GENUI_MAX_DEPTH` (Task 4); `safeUrl` (Task 3).
- Produces: `createGenuiParser(version?: number): GenuiParser` with `update(code, streaming): GenuiParseResult` (same input → same object; unchanged nodes keep identity); `parseGenui(code, version?)`; `unfinishedStatement(code, incomplete)`; internal `sanitizeTree`, `shareNodes`.

Three lang-core behaviors this task exists to correct (each has a test below):
1. It does not enforce zod refinements (`.max()`, `.min()`, `.url()`): `validate.ts` re-checks every node.
2. It marks **every** node `partial` while the input ends mid-statement (inside a string, most streaming ticks). Rendering that flag would collapse the whole block into placeholders on every tick. `unfinishedStatement` names the one statement being written (OpenUI Lang is one statement per line); only it, and inline nodes inside it, are partial.
3. It ignores `Query`/`Mutation`/`$state` silently: they are recorded as `unsupported-statement` and never become nodes.

- [ ] **Step 1: Write the fixture and the failing test**

`packages/sdk/src/genui/test-fixtures.ts`:

```ts
/** A valid block that uses StatRow, RankedList, and Callout. All values are placeholders. */
export const HOTEL = `root = Stack([stats, list, tip])
stats = StatRow([a, b])
a = Stat("Options checked", "24")
b = Stat("Under budget", "9", "+2", "up")
list = RankedList([h1, h2])
h1 = RankedItem("Option A", "Closest to the venue", "4.7 stars", null, "https://example.com/a")
h2 = RankedItem("Option B", "Quietest rooms")
tip = Callout("info", "Book by Friday", "Tip")`;
```

`packages/sdk/src/genui/parse.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { createGenuiParser, parseGenui } from './parse';
import { HOTEL } from './test-fixtures';

describe('parse + validate', () => {
  test('a valid block renders the whole tree with stable ids', () => {
    const { root, issues } = parseGenui(HOTEL);
    expect(issues).toEqual([]);
    expect(root?.type).toBe('Stack');
    const children = root?.props.children as { id: string; type: string }[];
    expect(children.map((c) => `${c.id}:${c.type}`)).toEqual(['stats:StatRow', 'list:RankedList', 'tip:Callout']);
  });

  test('duplicate references get unique ids', () => {
    const { root } = parseGenui('root = Stack([r])\nr = StatRow([a, a])\na = Stat("x", "1")');
    const stats = ((root?.props.children as { props: { stats: { id: string }[] } }[])[0]!).props.stats;
    expect(stats.map((s) => s.id)).toEqual(['a', 'a#1']);
  });

  test('drops javascript: links but keeps siblings', () => {
    const { root, issues } = parseGenui('root = Stack([bad, ok])\nbad = Link("x", "javascript:alert(1)")\nok = Badge("fine")');
    expect((root?.props.children as { type: string }[]).map((c) => c.type)).toEqual(['Badge']);
    expect(issues.map((i) => i.code)).toEqual(['url']);
  });

  test('an unsafe optional URL removes only that prop', () => {
    const { root } = parseGenui('root = Stack([c])\nc = Card("Title", "Body", null, "javascript:x")');
    const card = (root?.props.children as { props: Record<string, unknown> }[])[0]!;
    expect(card.props.title).toBe('Title');
    expect(card.props.image).toBeUndefined();
  });

  test('enforces limits lang-core skips', () => {
    const long = parseGenui(`root = Stack([n])\nn = Callout("info", "${'x'.repeat(401)}")`);
    // The only child fails, so the root Stack (min 1 child) fails too: the block renders its fallback.
    expect(long.root).toBeNull();
    expect(long.issues.map((i) => `${i.code}:${i.component}`)).toEqual(['schema:Callout', 'schema:Stack', 'no-root:undefined']);
    const many = parseGenui('root = Stack([r, ok])\nr = StatRow([a, a, a, a, a])\na = Stat("x", "1")\nok = Badge("kept")');
    expect((many.root?.props.children as { type: string }[]).map((c) => c.type)).toEqual(['Badge']);
  });

  test('rejects a component in the wrong slot', () => {
    const { root, issues } = parseGenui('root = Stack([s, ok])\ns = Series("x", [1])\nok = Badge("kept")');
    expect((root?.props.children as { type: string }[]).map((c) => c.type)).toEqual(['Badge']);
    expect(issues.map((i) => i.code)).toContain('wrong-child');
  });

  test('limits nesting depth to 4 containers', () => {
    const deep = 'root = Stack([a])\na = Stack([b])\nb = Stack([c])\nc = Stack([d])\nd = Stack([e])\ne = Badge("x")';
    const { issues } = parseGenui(deep);
    expect(issues.map((i) => i.code)).toContain('depth');
  });

  test('a block with no root reports no-root', () => {
    expect(parseGenui('a = Badge("x")').issues.map((i) => i.code)).toContain('no-root');
  });

  test('after the stream ends, an unfinished statement is dropped as cut-off; siblings stay', () => {
    const { root, issues } = parseGenui('root = Stack([a, b])\na = Badge("kept")\nb = Callout("info", "unfinish');
    expect((root?.props.children as { type: string }[]).map((c) => c.type)).toEqual(['Badge']);
    expect(issues.map((i) => i.code)).toContain('cut-off');
  });

  test('Query, Mutation, and $state are recorded and never become nodes', () => {
    const { root, issues } = parseGenui('root = Stack([b])\nb = Badge("x")\n$tab = "a"\nq = Query("tool", {})');
    expect((root?.props.children as { type: string }[]).map((c) => c.type)).toEqual(['Badge']);
    expect(issues.map((i) => i.code)).toContain('unsupported-statement');
  });

  test('a newer version is unsupported, not parsed', () => {
    expect(parseGenui(HOTEL, 2).issues.map((i) => i.code)).toEqual(['version']);
  });

  test('streaming: root appears first, children fill in, same input returns same object', () => {
    const parser = createGenuiParser();
    const early = parser.update(HOTEL.slice(0, 40), true);
    expect(early.root?.type).toBe('Stack');
    expect(early.pending.length).toBeGreaterThan(0);
    const again = parser.update(HOTEL.slice(0, 40), true);
    expect(again).toBe(early);
    const done = parser.update(HOTEL, false);
    expect(done.pending).toEqual([]);
    expect((done.root?.props.children as unknown[]).length).toBe(3);
  });

  test('mid-string ticks mark only the statement being written as partial', () => {
    // lang-core flags every node partial when the input ends inside a string; Kortix must not.
    const parser = createGenuiParser();
    const result = parser.update('root = Stack([a, b])\na = Badge("kept")\nb = Callout("info", "half a sente', true);
    const children = result.root?.props.children as { id: string; partial: boolean }[];
    expect(result.root?.partial).toBe(false);
    expect(children.map((c) => `${c.id}:${c.partial}`)).toEqual(['a:false', 'b:true']);
  });

  test('streaming relaxes slot minimums, the final parse enforces them', () => {
    const partial = 'root = Stack([r, ok])\nr = StatRow([a, b])\na = Stat("x", "1")\nok = Badge("kept")';
    const parser = createGenuiParser();
    const types = (result: ReturnType<typeof parser.update>) =>
      (result.root?.props.children as { type: string }[]).map((c) => c.type);
    expect(types(parser.update(partial, true))).toEqual(['StatRow', 'Badge']);
    expect(types(parser.update(partial, false))).toEqual(['Badge']);
  });

  test('parse cost: a 4 KB block streamed in 64-byte ticks stays under 2 ms per tick', () => {
    const rows = Array.from({ length: 50 }, (_, i) => `["Row ${i} with a longer descriptive label", ${i}, "an extra column of note text"]`).join(', ');
    const big = `root = Stack([t, c])\nt = Table(["Name", "Value", "Note"], [${rows}])\nc = BarChart(["a","b","c"], [s], "test data")\ns = Series("S", [1,2,3])\n${HOTEL.split('\n').slice(1).join('\n')}`;
    const parser = createGenuiParser();
    const started = performance.now();
    let ticks = 0;
    for (let i = 64; i < big.length + 64; i += 64) {
      parser.update(big.slice(0, i), true);
      ticks++;
    }
    const perTick = (performance.now() - started) / ticks;
    console.log(`bytes=${big.length} ticks=${ticks} ms/tick=${perTick.toFixed(3)}`);
    expect(big.length).toBeGreaterThan(4000);
    expect(perTick).toBeLessThan(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test src/genui/parse.test.ts`
Expected: FAIL — `Cannot find module './parse'`.

- [ ] **Step 3: Write the validation pass**

`packages/sdk/src/genui/validate.ts`:

```ts
import type { ElementNode } from '@openuidev/lang-core';

import { GENUI_MAX_DEPTH, GENUI_SPECS } from './catalog';
import type { GenuiIssue, GenuiNode } from './types';
import { safeUrl } from './urls';

const isElement = (value: unknown): value is ElementNode =>
  typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'element';

/**
 * Turn lang-core's element tree into render-ready `GenuiNode`s.
 *
 * lang-core checks types, enums, and required props only. This pass adds what it skips:
 * zod limits (lengths, counts, ranges), slot membership, nesting depth, URL safety, and
 * unique React keys. A node that fails is dropped and recorded in `issues`; its siblings render.
 */
export function sanitizeTree(
  root: ElementNode | null,
  options: {
    streaming: boolean;
    /**
     * Name of the statement the model is still writing, or null. lang-core marks EVERY node partial
     * while the input ends mid-statement, so "partial" is decided here instead (see parse.ts).
     */
    unfinished: string | null;
  },
): { root: GenuiNode | null; issues: GenuiIssue[] } {
  const issues: GenuiIssue[] = [];
  const usedIds = new Map<string, number>();
  const uniqueId = (base: string): string => {
    const seen = usedIds.get(base) ?? 0;
    usedIds.set(base, seen + 1);
    return seen === 0 ? base : `${base}#${seen}`;
  };

  function visit(
    value: unknown,
    path: string,
    depth: number,
    accepts: readonly string[],
    parentPartial: boolean,
  ): GenuiNode | null {
    if (!isElement(value)) return null;
    const { typeName, statementId } = value;
    // A named statement is partial only if it is the one being written; an inline node inherits.
    const partial = statementId !== undefined ? statementId === options.unfinished : parentPartial;
    const spec = GENUI_SPECS[typeName];
    if (!spec) {
      issues.push({ code: 'unknown-component', component: typeName, statementId, message: `Unknown component ${typeName}` });
      return null;
    }
    if (!accepts.includes(typeName)) {
      issues.push({ code: 'wrong-child', component: typeName, statementId, message: `${typeName} is not allowed here` });
      return null;
    }
    const nextDepth = spec.container ? depth + 1 : depth;
    if (nextDepth > GENUI_MAX_DEPTH) {
      issues.push({ code: 'depth', component: typeName, statementId, message: `Nesting deeper than ${GENUI_MAX_DEPTH}` });
      return null;
    }

    // The stream is over and this statement never finished: drop it instead of waiting forever.
    if (partial && !options.streaming) {
      issues.push({ code: 'cut-off', component: typeName, statementId, message: `${typeName} was cut off` });
      return null;
    }

    const id = uniqueId(statementId ?? path);
    const props: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(value.props)) {
      if (prop !== null && prop !== undefined) props[key] = prop;
    }

    for (const [key, slot] of Object.entries(spec.slots)) {
      const raw = props[key];
      if (raw === undefined) continue;
      const children = Array.isArray(raw) ? raw : [raw];
      props[key] = children
        .map((child, index) => visit(child, `${id}.${key}.${index}`, nextDepth, slot.accepts, partial))
        .filter((node): node is GenuiNode => node !== null);
    }

    for (const [key, need] of Object.entries(spec.urls)) {
      if (props[key] === undefined) continue;
      const safe = safeUrl(props[key]);
      if (safe) {
        props[key] = safe;
        continue;
      }
      issues.push({ code: 'url', component: typeName, statementId, message: `Unsafe URL in ${typeName}.${key}` });
      if (need === 'required') return null;
      delete props[key];
    }

    if (!partial) {
      const result = (options.streaming ? spec.streaming : spec.strict).safeParse(props);
      if (!result.success) {
        const first = result.error.issues[0];
        issues.push({
          code: 'schema',
          component: typeName,
          statementId,
          message: `${typeName}.${first?.path.join('.') ?? ''}: ${first?.message ?? 'invalid'}`,
        });
        return null;
      }
    }

    return { id, type: typeName, props, partial };
  }

  return { root: visit(root, 'root', 0, ['Stack'], false), issues };
}
```

- [ ] **Step 4: Write structural sharing**

`packages/sdk/src/genui/share.ts`:

```ts
import type { GenuiNode } from './types';

const isNode = (value: unknown): value is GenuiNode =>
  typeof value === 'object' && value !== null && 'id' in value && 'type' in value && 'props' in value;

function valueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((item, index) => valueEqual(item, b[index]));
}

function propsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => valueEqual(a[key], b[key]));
}

/**
 * Structural sharing across parses: a node whose type, `partial` flag, props, and children did not
 * change keeps the object from the previous parse. Renderers memoize on node identity, so a statement
 * that finished streaming renders once and never again while later statements stream in.
 */
export function shareNodes(
  root: GenuiNode | null,
  previous: ReadonlyMap<string, GenuiNode>,
): { root: GenuiNode | null; byId: Map<string, GenuiNode> } {
  const byId = new Map<string, GenuiNode>();

  function share(node: GenuiNode): GenuiNode {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node.props)) {
      props[key] = Array.isArray(value) && value.length > 0 && value.every(isNode) ? value.map(share) : value;
    }
    const before = previous.get(node.id);
    const kept =
      before && before.type === node.type && before.partial === node.partial && propsEqual(before.props, props)
        ? before
        : { ...node, props };
    byId.set(node.id, kept);
    return kept;
  }

  return { root: root ? share(root) : null, byId };
}
```

- [ ] **Step 5: Write the parser**

`packages/sdk/src/genui/parse.ts`:

```ts
import { createStreamingParser, type LibraryJSONSchema, type ValidationError } from '@openuidev/lang-core';

import { GENUI_LIBRARY } from './catalog';
import { shareNodes } from './share';
import { GENUI_SCHEMA_VERSION, type GenuiIssue, type GenuiNode, type GenuiParseResult } from './types';
import { sanitizeTree } from './validate';

let librarySchema: LibraryJSONSchema | null = null;
const schema = (): LibraryJSONSchema => (librarySchema ??= GENUI_LIBRARY.toJSONSchema());

const fromLangCore = (error: ValidationError): GenuiIssue => ({
  code: error.code === 'unknown-component' ? 'unknown-component' : 'schema',
  component: error.component,
  statementId: error.statementId,
  message: error.message,
});

const STATEMENT = /^\s*(\$?[A-Za-z_]\w*)\s*=/;

/**
 * The statement the model is still writing: OpenUI Lang puts one statement per line, so it is the
 * last non-empty line, when the input is incomplete. Null when that line has no `name =` yet.
 */
export function unfinishedStatement(code: string, incomplete: boolean): string | null {
  if (!incomplete) return null;
  const lines = code.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() === '') continue;
    return STATEMENT.exec(lines[i]!)?.[1] ?? null;
  }
  return null;
}

export interface GenuiParser {
  /**
   * Parse the block's full text so far. lang-core diffs against the previous call and
   * parses only the new text. The same input returns the same result object.
   */
  update(code: string, streaming: boolean): GenuiParseResult;
}

export function createGenuiParser(version: number = GENUI_SCHEMA_VERSION): GenuiParser {
  if (version !== GENUI_SCHEMA_VERSION) {
    const unsupported: GenuiParseResult = {
      root: null,
      pending: [],
      issues: [{ code: 'version', message: `Block version ${version}; this client renders ${GENUI_SCHEMA_VERSION}` }],
      streaming: false,
    };
    return { update: () => unsupported };
  }

  const parser = createStreamingParser(schema(), 'Stack');
  let last: { code: string; streaming: boolean; result: GenuiParseResult } | null = null;
  let previousNodes: ReadonlyMap<string, GenuiNode> = new Map();

  return {
    update(code, streaming) {
      if (last && last.code === code && last.streaming === streaming) return last.result;
      const raw = parser.set(code);
      const sanitized = sanitizeTree(raw.root, { streaming, unfinished: unfinishedStatement(code, raw.meta.incomplete) });
      const shared = shareNodes(sanitized.root, previousNodes);
      previousNodes = shared.byId;
      const { issues } = sanitized;
      const result: GenuiParseResult = {
        root: shared.root,
        pending: raw.meta.unresolved,
        issues: [...raw.meta.errors.map(fromLangCore), ...issues],
        streaming,
      };
      const unsupported = raw.queryStatements.length + raw.mutationStatements.length + Object.keys(raw.stateDeclarations).length;
      if (unsupported > 0) {
        result.issues.push({ code: 'unsupported-statement', message: `${unsupported} Query/Mutation/state statement(s) ignored` });
      }
      if (!streaming && !shared.root) result.issues.push({ code: 'no-root', message: 'The block has no valid root Stack' });
      last = { code, streaming, result };
      return result;
    },
  };
}

/** One-shot parse of a finished block. */
export function parseGenui(code: string, version: number = GENUI_SCHEMA_VERSION): GenuiParseResult {
  return createGenuiParser(version).update(code, false);
}
```

Add to `index.ts`: `export { createGenuiParser, parseGenui, type GenuiParser } from './parse';`

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/sdk && bun test src/genui/parse.test.ts`
Expected: PASS (15 tests). The log prints `bytes=4427 ticks=70 ms/tick=…`; the test fails above 2 ms per tick.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src/genui
git commit -m "feat(sdk/genui): streaming parser with Kortix validation and structural sharing"
```

---

### Task 6: Markdown fallback

**Files:**
- Create: `packages/sdk/src/genui/markdown.ts`
- Test: `packages/sdk/src/genui/markdown.test.ts`
- Modify: `packages/sdk/src/genui/index.ts`

**Interfaces:**
- Consumes: `GENUI_SPECS` (Task 4), `splitGenui` (Task 2), `parseGenui` (Task 5).
- Produces: `genuiNodeToMarkdown`, `genuiBlockToMarkdown`, `genuiToMarkdown`, `genuiA11yText`, `GENUI_UNSUPPORTED_NOTE`.

- [ ] **Step 1: Write the failing test**

`packages/sdk/src/genui/markdown.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { genuiToMarkdown } from './markdown';
import { HOTEL } from './test-fixtures';

describe('markdown fallback', () => {
  test('replaces blocks, keeps prose, never leaks source', () => {
    const md = genuiToMarkdown(`Here you go.\n\n\`\`\`openui\n${HOTEL}\n\`\`\`\n\nThanks.`);
    expect(md).toContain('Here you go.');
    expect(md).toContain('- **Options checked:** 24');
    expect(md).toContain('1. **Option A** — Closest to the venue (4.7 stars) [Open](https://example.com/a)');
    expect(md).toContain('> **Tip** Book by Friday');
    expect(md).toContain('Thanks.');
    expect(md).not.toContain('root =');
  });

  test('prose and blocks are separated by exactly one blank line', () => {
    expect(genuiToMarkdown('Done.\n\n```openui\nroot = Stack([b])\nb = Badge("shipped")\n```\n\nBye.')).toBe('Done.\n\n[shipped]\n\nBye.');
  });

  test('text without a block is returned as the same string', () => {
    const text = 'No UI here, even with the word openui.';
    expect(genuiToMarkdown(text)).toBe(text);
  });

  test('charts and maps carry their source', () => {
    const md = genuiToMarkdown(
      '```openui\nroot = Stack([c, m])\nc = BarChart(["Q1","Q2"], [s], "billing export", "USD")\ns = Series("Revenue", [1200, 1500])\nm = Map([p], "places tool")\np = Marker(48.85, 2.35, "Center")\n```',
    );
    expect(md).toContain('| Q1 | 1,200 |');
    expect(md).toContain('Source: billing export');
    expect(md).toContain('https://www.openstreetmap.org/?mlat=48.85&mlon=2.35');
    expect(md).toContain('Source: places tool');
  });

  test('tabs and accordion expand every panel', () => {
    const md = genuiToMarkdown(
      '```openui\nroot = Stack([t])\nt = Tabs([x, y])\nx = Tab("One", [b1])\ny = Tab("Two", [b2])\nb1 = Badge("first")\nb2 = Badge("second")\n```',
    );
    expect(md).toContain('#### One\n\n[first]');
    expect(md).toContain('#### Two\n\n[second]');
  });

  test('a broken block yields no raw source', () => {
    expect(genuiToMarkdown('Hi\n\n```openui\nthis is not openui at all\n```')).toBe('Hi');
  });

  test('a block cut off mid-statement keeps its valid parts and says so', () => {
    expect(genuiToMarkdown('```openui\nroot = Stack([a, b])\na = Badge("kept")\nb = Callout("info", "unfin')).toBe(
      '[kept]\n\n*Response was cut off.*',
    );
  });

  test('a newer version yields the unsupported note', () => {
    expect(genuiToMarkdown('```openui-v2\nroot = Stack([])\n```')).toBe('*This content needs a newer version of Kortix.*');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test src/genui/markdown.test.ts`
Expected: FAIL — `Cannot find module './markdown'`.

- [ ] **Step 3: Write the implementation**

`packages/sdk/src/genui/markdown.ts`:

```ts
import { GENUI_SPECS } from './catalog';
import { splitGenui } from './fence';
import { parseGenui } from './parse';
import { GENUI_SCHEMA_VERSION, type GenuiNode } from './types';

/** Shown in place of a block this build cannot read (a newer schema version). */
export const GENUI_UNSUPPORTED_NOTE = 'This content needs a newer version of Kortix.';

/** Shown under a block whose stream ended inside a statement. */
export const GENUI_CUT_OFF_NOTE = 'Response was cut off.';

/** Deterministic markdown for one node and its children. Unknown types yield ''. */
export function genuiNodeToMarkdown(node: GenuiNode): string {
  const spec = GENUI_SPECS[node.type];
  return spec ? spec.toMarkdown(node.props, genuiNodeToMarkdown) : '';
}

/** Screen-reader text for a chart or map node, else null. */
export function genuiA11yText(node: GenuiNode): string | null {
  return GENUI_SPECS[node.type]?.a11y?.(node.props) ?? null;
}

/** Markdown for one finished block. Never returns OpenUI source. */
export function genuiBlockToMarkdown(code: string, version: number = GENUI_SCHEMA_VERSION): string {
  if (version !== GENUI_SCHEMA_VERSION) return `*${GENUI_UNSUPPORTED_NOTE}*`;
  const { root, issues } = parseGenui(code, version);
  const body = root ? genuiNodeToMarkdown(root) : '';
  const cutOff = issues.some((issue) => issue.code === 'cut-off');
  return cutOff ? [body, `*${GENUI_CUT_OFF_NOTE}*`].filter(Boolean).join('\n\n') : body;
}

/**
 * A whole reply as plain markdown: every generative-UI block replaced by its markdown.
 * For copy, export, the CLI, chat channels, and any host that does not render UI.
 * Text without a generative-UI fence is returned unchanged (same string).
 */
export function genuiToMarkdown(text: string): string {
  if (!text.includes('openui')) return text;
  const segments = splitGenui(text);
  if (!segments.some((segment) => segment.kind === 'genui')) return text;
  return segments
    .map((segment) =>
      segment.kind === 'markdown'
        ? segment.text.replace(/^\n+|\n+$/g, '')
        : genuiBlockToMarkdown(segment.code, segment.version),
    )
    .filter((part) => part.trim().length > 0)
    .join('\n\n');
}
```

`packages/sdk/src/genui/index.ts` is now complete:

```ts
export { genuiVersionFromClassName, genuiVersionOf, splitGenui } from './fence';
export {
  GENUI_CUT_OFF_NOTE,
  GENUI_UNSUPPORTED_NOTE,
  genuiA11yText,
  genuiBlockToMarkdown,
  genuiNodeToMarkdown,
  genuiToMarkdown,
} from './markdown';
export { createGenuiParser, parseGenui, type GenuiParser } from './parse';
export { buildGenuiPrompt, GENUI_PROMPT_VERSION } from './prompt';
export {
  GENUI_SCHEMA_VERSION,
  type GenuiIssue,
  type GenuiIssueCode,
  type GenuiNode,
  type GenuiParseResult,
  type GenuiSegment,
} from './types';
export { safeUrl } from './urls';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk && bun test src/genui/markdown.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/genui
git commit -m "feat(sdk/genui): deterministic markdown fallback for every block"
```

---

### Task 7: Headless React renderer (`GenuiBlock`)

**Files:**
- Create: `packages/sdk/src/genui/react/genui-block.tsx`
- Test: `packages/sdk/src/genui/react/genui-block.test.tsx`
- Modify: `packages/sdk/src/genui/react/index.ts`

**Interfaces:**
- Consumes: `createGenuiParser`, `genuiBlockToMarkdown`, `genuiNodeToMarkdown`, `GENUI_SCHEMA_VERSION`, `GENUI_UNSUPPORTED_NOTE` (Tasks 5–6).
- Produces: `GenuiBlock`, `useGenuiParse`, `GenuiBlockProps`, `GenuiComponentProps`, `GenuiComponentMap`, `GenuiBlockEvent`, `GenuiOutcome` (exact shapes in `plan.md` § Interface contracts).

Two traps the prototype hit, already fixed in the code below:
1. `memo(function GenuiNodeView …)`: inside a named function expression, the name refers to the inner, unmemoized function. Children rendered through it re-render on every tick. The inner function is named `NodeView`.
2. Memo needs node identity to survive a re-parse. `shareNodes` (Task 5) provides it; the first test below fails without it (`a` renders 3 times instead of 1).

- [ ] **Step 1: Write the failing test**

`packages/sdk/src/genui/react/genui-block.test.tsx`:

```tsx
import { describe, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { GenuiBlock, type GenuiBlockEvent, type GenuiComponentMap, type GenuiComponentProps } from './genui-block';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const renders = new Map<string, number>();
const count = (id: string) => renders.set(id, (renders.get(id) ?? 0) + 1);

const Stack = ({ node, props, renderChild }: GenuiComponentProps) => {
  count(node.id);
  return <div data-type="Stack">{(props.children ?? []).map(renderChild)}</div>;
};
const Stat = ({ node, props }: GenuiComponentProps) => {
  count(node.id);
  return <span data-type="Stat">{`${props.label}=${props.value}`}</span>;
};
const Boom = (): never => {
  throw new Error('render failure');
};
const COMPONENTS: GenuiComponentMap = { Stack, Stat };
const renderMarkdown = (markdown: string) => <pre data-type="markdown">{markdown}</pre>;

const CODE = 'root = Stack([a, b, c])\na = Stat("A", "1")\nb = Stat("B", "2")\nc = Stat("C", "3")';

function mount(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

describe('GenuiBlock', () => {
  test('a finished statement renders once while later statements stream', () => {
    renders.clear();
    const props = { version: 1, components: COMPONENTS, renderMarkdown };
    const renderer = mount(<GenuiBlock {...props} code={CODE.slice(0, 44)} streaming />);
    // A tick that ends inside a string: lang-core marks every node partial here; Kortix must not.
    const midString = CODE.indexOf('"2"') + 1;
    act(() => renderer.update(<GenuiBlock {...props} code={CODE.slice(0, midString)} streaming />));
    const cut = CODE.indexOf('\nc =');
    act(() => renderer.update(<GenuiBlock {...props} code={CODE.slice(0, cut)} streaming />));
    act(() => renderer.update(<GenuiBlock {...props} code={CODE} streaming />));
    // "a" finished in the first tick and its node identity never changed afterwards.
    expect(renders.get('a')).toBe(1);
    expect(renderer.root.findAll((n) => n.props['data-type'] === 'Stat').map((n) => n.children.join(''))).toEqual([
      'A=1',
      'B=2',
      'C=3',
    ]);
  });

  test('disabled renders the markdown fallback', () => {
    const renderer = mount(
      <GenuiBlock code={CODE} streaming={false} enabled={false} components={COMPONENTS} renderMarkdown={renderMarkdown} />,
    );
    expect(renderer.root.findByProps({ 'data-type': 'markdown' }).children.join('')).toBe('**A:** 1\n\n**B:** 2\n\n**C:** 3');
  });

  test('a component missing from the host map renders that node as markdown', () => {
    const renderer = mount(
      <GenuiBlock code={CODE} streaming={false} components={{ Stack }} renderMarkdown={renderMarkdown} />,
    );
    expect(renderer.root.findAllByProps({ 'data-type': 'markdown' }).map((n) => n.children.join(''))).toEqual([
      '**A:** 1',
      '**B:** 2',
      '**C:** 3',
    ]);
  });

  test('a render error falls back to markdown and reports render_error', () => {
    const events: GenuiBlockEvent[] = [];
    const original = console.error;
    console.error = () => {};
    const renderer = mount(
      <GenuiBlock
        code={CODE}
        streaming={false}
        components={{ Stack, Stat: Boom }}
        renderMarkdown={renderMarkdown}
        onSettled={(event) => events.push(event)}
      />,
    );
    console.error = original;
    expect(renderer.root.findByProps({ 'data-type': 'markdown' })).toBeTruthy();
    expect(events.map((e) => e.outcome)).toEqual(['render_error']);
  });

  test('broken source renders nothing raw and reports parse_error', () => {
    const events: GenuiBlockEvent[] = [];
    const renderer = mount(
      <GenuiBlock code="not openui" streaming={false} components={COMPONENTS} renderMarkdown={renderMarkdown} onSettled={(e) => events.push(e)} />,
    );
    expect(renderer.toJSON()).toBeNull();
    expect(events[0]?.outcome).toBe('parse_error');
  });

  test('a block cut off mid-statement renders its valid part and the cut-off note', () => {
    const renderer = mount(
      <GenuiBlock code={'root = Stack([a, b])\na = Stat("A", "1")\nb = Stat("B", "'} streaming={false} components={COMPONENTS} renderMarkdown={renderMarkdown} />,
    );
    expect(renderer.root.findAll((n) => n.props['data-type'] === 'Stat').map((n) => n.children.join(''))).toEqual(['A=1']);
    expect(renderer.root.findByProps({ 'data-type': 'markdown' }).children.join('')).toBe('*Response was cut off.*');
  });

  test('a newer version shows the unsupported note', () => {
    const renderer = mount(
      <GenuiBlock code={CODE} version={2} streaming={false} components={COMPONENTS} renderMarkdown={renderMarkdown} />,
    );
    expect(renderer.root.findByProps({ 'data-type': 'markdown' }).children.join('')).toContain('newer version');
  });

  test('settled event names components, never content', () => {
    const events: GenuiBlockEvent[] = [];
    const props = { version: 1, components: COMPONENTS, renderMarkdown, onSettled: (e: GenuiBlockEvent) => events.push(e) };
    const renderer = mount(<GenuiBlock {...props} code={CODE} streaming />);
    act(() => renderer.update(<GenuiBlock {...props} code={CODE} streaming={false} />));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'rendered', components: ['Stack', 'Stat'], issueCount: 0 });
    expect(JSON.stringify(events[0])).not.toContain('A=1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test src/genui/react/genui-block.test.tsx`
Expected: FAIL — `Cannot find module './genui-block'`.

- [ ] **Step 3: Write the implementation**

`packages/sdk/src/genui/react/genui-block.tsx`:

```tsx
import {
  Component,
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ComponentType,
  type ReactNode,
} from 'react';

import {
  createGenuiParser,
  genuiBlockToMarkdown,
  genuiNodeToMarkdown,
  GENUI_CUT_OFF_NOTE,
  GENUI_SCHEMA_VERSION,
  GENUI_UNSUPPORTED_NOTE,
  type GenuiNode,
  type GenuiParser,
  type GenuiParseResult,
} from '../index';

/** Props every host component receives. `props` is already validated against the catalog. */
export interface GenuiComponentProps {
  node: GenuiNode;
  props: Record<string, any>;
  /** Render a child node (from a slot prop) through the same component map. */
  renderChild: (node: GenuiNode) => ReactNode;
  /** The block is still streaming. */
  streaming: boolean;
}

/** Component name → host component. A missing entry renders that node's markdown. */
export type GenuiComponentMap = Readonly<Partial<Record<string, ComponentType<GenuiComponentProps>>>>;

export type GenuiOutcome = 'rendered' | 'fallback' | 'parse_error' | 'render_error' | 'unsupported';

export interface GenuiBlockEvent {
  outcome: GenuiOutcome;
  /** Component names in the rendered tree, sorted, unique. Never content. */
  components: string[];
  /** Milliseconds from mount to the first rendered root, when one rendered. */
  msToFirstPaint: number | null;
  issueCount: number;
}

export interface GenuiBlockProps {
  /** The fence body so far. */
  code: string;
  /** Schema version from the fence tag (`genuiVersionOf`). */
  version?: number;
  streaming: boolean;
  components: GenuiComponentMap;
  /** The host's markdown renderer, for fallbacks. */
  renderMarkdown: (markdown: string) => ReactNode;
  /** A node the model has not finished. Default: nothing (no skeletons). */
  renderPending?: (node: GenuiNode) => ReactNode;
  /** false: the viewer turned generative UI off. The block renders as markdown. */
  enabled?: boolean;
  /** Fires once per block, when it stops streaming. */
  onSettled?: (event: GenuiBlockEvent) => void;
}

interface RenderContextValue {
  components: GenuiComponentMap;
  renderMarkdown: (markdown: string) => ReactNode;
  renderPending: (node: GenuiNode) => ReactNode;
  streaming: boolean;
}

const RenderContext = createContext<RenderContextValue | null>(null);
const renderNothing = () => null;

/** Memoized on node identity. The core parser keeps unchanged nodes identical across ticks. */
const GenuiNodeView = memo(function NodeView({ node }: { node: GenuiNode }) {
  // The inner function has its own name: inside it, `GenuiNodeView` must resolve to the memoized outer const.
  const context = useContext(RenderContext)!;
  const renderChild = useCallback((child: GenuiNode) => <GenuiNodeView key={child.id} node={child} />, []);
  if (node.partial) return <>{context.renderPending(node)}</>;
  const HostComponent = context.components[node.type];
  if (!HostComponent) return <>{context.renderMarkdown(genuiNodeToMarkdown(node))}</>;
  return <HostComponent node={node} props={node.props} renderChild={renderChild} streaming={context.streaming} />;
});

class BlockBoundary extends Component<
  { fallback: ReactNode; onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    this.props.onError();
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function collectTypes(node: GenuiNode | null, into: Set<string>): Set<string> {
  if (!node) return into;
  into.add(node.type);
  for (const value of Object.values(node.props)) {
    if (Array.isArray(value)) for (const child of value) if (child && typeof child === 'object' && 'type' in child) collectTypes(child as GenuiNode, into);
  }
  return into;
}

/** Parse the block on every render with one parser per block; same input returns the same result. */
export function useGenuiParse(code: string, version: number, streaming: boolean): GenuiParseResult {
  const parserRef = useRef<{ version: number; parser: GenuiParser } | null>(null);
  if (!parserRef.current || parserRef.current.version !== version) {
    parserRef.current = { version, parser: createGenuiParser(version) };
  }
  return parserRef.current.parser.update(code, streaming);
}

/** Render one generative-UI block. Never throws, never shows OpenUI source. */
export function GenuiBlock({
  code,
  version = GENUI_SCHEMA_VERSION,
  streaming,
  components,
  renderMarkdown,
  renderPending = renderNothing,
  enabled = true,
  onSettled,
}: GenuiBlockProps) {
  const result = useGenuiParse(code, version, streaming);
  const fallback = useMemo(
    () => (streaming ? '' : genuiBlockToMarkdown(code, version)),
    [code, version, streaming],
  );
  const mountedAt = useRef(performance.now());
  const firstPaint = useRef<number | null>(null);
  const renderError = useRef(false);
  if (result.root && firstPaint.current === null) firstPaint.current = performance.now() - mountedAt.current;

  const context = useMemo<RenderContextValue>(
    () => ({ components, renderMarkdown, renderPending, streaming }),
    [components, renderMarkdown, renderPending, streaming],
  );

  const unsupported = version !== GENUI_SCHEMA_VERSION;
  useEffect(() => {
    if (streaming || !onSettled) return;
    const outcome: GenuiOutcome = unsupported
      ? 'unsupported'
      : !enabled
        ? 'fallback'
        : renderError.current
          ? 'render_error'
          : result.root
            ? 'rendered'
            : 'parse_error';
    onSettled({
      outcome,
      components: [...collectTypes(result.root, new Set())].sort(),
      msToFirstPaint: firstPaint.current === null ? null : Math.round(firstPaint.current),
      issueCount: result.issues.length,
    });
    // Fires when streaming settles; later re-renders of a settled block do not re-fire.
  }, [streaming]); // eslint-disable-line react-hooks/exhaustive-deps

  if (unsupported) return <>{renderMarkdown(`*${GENUI_UNSUPPORTED_NOTE}*`)}</>;
  if (!enabled) return <>{renderMarkdown(genuiBlockToMarkdown(code, version))}</>;
  if (!result.root) return streaming ? null : <>{fallback ? renderMarkdown(fallback) : null}</>;

  return (
    <BlockBoundary fallback={renderMarkdown(fallback || genuiBlockToMarkdown(code, version))} onError={() => (renderError.current = true)}>
      <RenderContext.Provider value={context}>
        <GenuiNodeView node={result.root} />
      </RenderContext.Provider>
      {!streaming && result.issues.some((issue) => issue.code === 'cut-off') ? renderMarkdown(`*${GENUI_CUT_OFF_NOTE}*`) : null}
    </BlockBoundary>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk && bun test src/genui/react/genui-block.test.tsx`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/genui/react
git commit -m "feat(sdk/genui): headless GenuiBlock renderer, memoized per node"
```

---

### Task 8: Default components for third-party hosts

**Files:**
- Create: `packages/sdk/src/genui/react/default-components.tsx`
- Test: `packages/sdk/src/genui/react/default-components.test.tsx`
- Modify: `packages/sdk/src/genui/react/index.ts`

**Interfaces:**
- Consumes: `GenuiComponentMap`, `GenuiComponentProps` (Task 7), `genuiA11yText` (Task 6).
- Produces: `defaultGenuiComponents: GenuiComponentMap` — all 17 block names.

These defaults draw no charts and no map tiles: charts render as data tables with a source caption, the map as a place list with OpenStreetMap links. A host that wants drawn charts passes its own `BarChart`, `LineChart`, `PieChart`, `Map`. This keeps `@kortix/sdk` free of chart and map dependencies.

- [ ] **Step 1: Write the failing test**

`packages/sdk/src/genui/react/default-components.test.tsx`:

```tsx
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { defaultGenuiComponents } from './default-components';
import { GenuiBlock } from './genui-block';

const md = (markdown: string) => <pre>{markdown}</pre>;
const render = (code: string) =>
  renderToStaticMarkup(<GenuiBlock code={code} streaming={false} components={defaultGenuiComponents} renderMarkdown={md} />);

// The root holds two Stacks because one Stack takes at most 12 children.
const ALL = `root = Stack([top, bottom])
top = Stack([stats, card, table, cmp, list, bar, line])
bottom = Stack([pie, map, tabs, acc, note, img, link])
stats = StatRow([s1, s2])
s1 = Stat("Revenue", "12k", "+4%", "up", "USD")
s2 = Stat("Users", "900")
card = Card("Option A", "Close to the venue", "4.7 stars", null, "https://example.com/a", [tag])
tag = Badge("Top pick", "good")
table = Table(["Name", "Value"], [["a", 1], ["b", 2]], "Sample")
cmp = Compare([x, y], ["Price", "Rating"], "X")
x = CompareItem("X", ["$10", "4.5"], ["Cheap"], ["Small"])
y = CompareItem("Y", ["$20", "4.8"])
list = RankedList([r1])
r1 = RankedItem("First", "Best overall", "4.7 stars")
bar = BarChart(["Q1", "Q2"], [rev], "billing export", "USD")
rev = Series("Revenue", [1, 2])
line = LineChart(["Jan", "Feb"], [rev], "billing export")
pie = PieChart([p1, p2], "survey tool")
p1 = Slice("Yes", 3)
p2 = Slice("No", 1)
map = Map([m1], "places tool")
m1 = Marker(48.85, 2.35, "Center", "Main square")
tabs = Tabs([t1, t2])
t1 = Tab("One", [b1])
t2 = Tab("Two", [b2])
b1 = Badge("first")
b2 = Badge("second")
acc = Accordion([a1])
a1 = AccordionItem("Details", [b1])
note = Callout("warn", "Check the dates", "Note")
img = Image("https://example.com/i.png", "A picture", "Caption")
link = Link("Book", "https://example.com/book")`;

describe('defaultGenuiComponents', () => {
  test('renders every v1 component from one block', () => {
    const html = render(ALL);
    for (const expected of [
      'Revenue', '12k', 'Option A', 'Top pick', '<table', 'Sample', 'Cheap', 'Best overall',
      'Source: billing export', 'Source: survey tool', 'openstreetmap.org', 'role="tablist"', '<details',
      'Check the dates', 'alt="A picture"', 'href="https://example.com/book"',
    ]) {
      expect(html).toContain(expected);
    }
    expect(html).not.toContain('<pre>');
  });

  test('every block component has a default', () => {
    const names = ['Stack', 'Card', 'Stat', 'StatRow', 'Table', 'Compare', 'RankedList', 'BarChart', 'LineChart', 'PieChart', 'Map', 'Tabs', 'Accordion', 'Badge', 'Callout', 'Image', 'Link'];
    expect(Object.keys(defaultGenuiComponents).sort()).toEqual([...names].sort());
  });

  test('external links open safely', () => {
    expect(render('root = Stack([l])\nl = Link("x", "https://example.com")')).toContain('rel="noopener noreferrer"');
  });

  test('charts carry an accessible label', () => {
    expect(render('root = Stack([c])\nc = BarChart(["a"], [s], "src")\ns = Series("S", [1])')).toContain('aria-label="Bar chart: S. Source: src"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && bun test src/genui/react/default-components.test.tsx`
Expected: FAIL — `Cannot find module './default-components'`.

- [ ] **Step 3: Write the implementation**

`packages/sdk/src/genui/react/default-components.tsx`:

```tsx
import { useId, useState, type CSSProperties, type ReactNode } from 'react';

import { genuiA11yText, type GenuiNode } from '../index';
import type { GenuiComponentMap, GenuiComponentProps } from './genui-block';

/**
 * Unbranded default components for third-party hosts. Semantic HTML, themed through CSS variables
 * (`--genui-fg`, `--genui-muted`, `--genui-border`, `--genui-surface`, `--genui-accent`, `--genui-radius`).
 * Charts and maps render as accessible data tables and place lists: a host that wants drawn charts
 * passes its own components for those names. Kortix web and mobile pass their own map entirely.
 */

const v = (name: string, fallback: string) => `var(--genui-${name}, ${fallback})`;
const box: CSSProperties = {
  border: `1px solid ${v('border', 'rgba(0,0,0,.12)')}`,
  borderRadius: v('radius', '10px'),
  background: v('surface', 'transparent'),
  padding: 12,
};
const muted: CSSProperties = { color: v('muted', 'rgba(0,0,0,.6)'), fontSize: 13 };
const TONE: Record<string, string> = { good: '#15803d', warn: '#b45309', bad: '#b91c1c', neutral: 'inherit' };

const kids = (value: unknown): GenuiNode[] => (Array.isArray(value) ? (value as GenuiNode[]) : []);

function DataTable({ head, rows, caption }: { head: string[]; rows: unknown[][]; caption?: ReactNode }) {
  return (
    <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 14 }}>
      {caption ? <caption style={{ ...muted, textAlign: 'left', captionSide: 'bottom', paddingTop: 6 }}>{caption}</caption> : null}
      <thead>
        <tr>
          {head.map((cell, i) => (
            <th key={i} scope="col" style={{ textAlign: 'left', padding: '6px 8px', borderBottom: `1px solid ${v('border', 'rgba(0,0,0,.12)')}` }}>
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, r) => (
          <tr key={r}>
            {head.map((_, c) => (
              <td key={c} style={{ padding: '6px 8px' }}>
                {String(row[c] ?? '')}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function seriesRows(labels: string[], series: GenuiNode[]): unknown[][] {
  return labels.map((label, i) => [label, ...series.map((s) => (s.props.values as number[] | undefined)?.[i] ?? '')]);
}

const Stack = ({ props, renderChild }: GenuiComponentProps) => (
  <div style={{ display: 'flex', flexDirection: props.direction === 'row' ? 'row' : 'column', flexWrap: 'wrap', gap: 12 }}>
    {kids(props.children).map(renderChild)}
  </div>
);

const Card = ({ props, renderChild }: GenuiComponentProps) => (
  <article style={box}>
    {props.image ? <img src={props.image} alt="" style={{ width: '100%', borderRadius: 6, marginBottom: 8 }} /> : null}
    <h4 style={{ margin: 0 }}>{props.href ? <a href={props.href} target="_blank" rel="noopener noreferrer">{props.title}</a> : props.title}</h4>
    {props.subtitle ? <p style={muted}>{props.subtitle}</p> : null}
    {props.body ? <p style={{ margin: '6px 0 0' }}>{props.body}</p> : null}
    {kids(props.badges).length > 0 ? <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>{kids(props.badges).map(renderChild)}</div> : null}
  </article>
);

const Stat = ({ props }: GenuiComponentProps) => (
  <div style={{ ...box, minWidth: 120 }}>
    <div style={muted}>{props.label}</div>
    <div style={{ fontSize: 22, fontWeight: 600 }}>
      {props.value}
      {props.unit ? <span style={muted}> {props.unit}</span> : null}
    </div>
    {props.delta ? <div style={{ color: TONE[props.trend === 'down' ? 'bad' : props.trend === 'up' ? 'good' : 'neutral'] }}>{props.delta}</div> : null}
  </div>
);

const StatRow = ({ props, renderChild }: GenuiComponentProps) => (
  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>{kids(props.stats).map(renderChild)}</div>
);

const Table = ({ props }: GenuiComponentProps) => <DataTable head={props.columns} rows={props.rows} caption={props.caption} />;

const Compare = ({ props }: GenuiComponentProps) => {
  const items = kids(props.items);
  const specs: string[] = props.specs ?? [];
  return (
    <div style={box}>
      {specs.length > 0 ? (
        <DataTable
          head={['', ...items.map((item) => String(item.props.name))]}
          rows={specs.map((spec, i) => [spec, ...items.map((item) => (item.props.values as string[])[i] ?? '—')])}
        />
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${items.length}, 1fr)`, gap: 12, marginTop: 8 }}>
        {items.map((item) => (
          <div key={item.id}>
            <strong>{String(item.props.name)}{props.winner === item.props.name ? ' ✓' : ''}</strong>
            <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
              {((item.props.pros as string[] | undefined) ?? []).map((pro, i) => <li key={`p${i}`}>+ {pro}</li>)}
              {((item.props.cons as string[] | undefined) ?? []).map((con, i) => <li key={`c${i}`}>− {con}</li>)}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
};

const RankedList = ({ props }: GenuiComponentProps) => (
  <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 8 }}>
    {kids(props.items).map((item) => (
      <li key={item.id}>
        <strong>{item.props.href ? <a href={String(item.props.href)} target="_blank" rel="noopener noreferrer">{String(item.props.title)}</a> : String(item.props.title)}</strong>
        {item.props.meta ? <span style={muted}> · {String(item.props.meta)}</span> : null}
        <div>{String(item.props.reason)}</div>
      </li>
    ))}
  </ol>
);

const SeriesChart = ({ node, props }: GenuiComponentProps) => {
  const labels: string[] = props.categories ?? props.x ?? [];
  const series = kids(props.series);
  return (
    <figure style={{ ...box, margin: 0 }} aria-label={genuiA11yText(node) ?? undefined}>
      <DataTable head={['', ...series.map((s) => String(s.props.name))]} rows={seriesRows(labels, series)} caption={`Source: ${props.source}`} />
    </figure>
  );
};

const PieChart = ({ node, props }: GenuiComponentProps) => (
  <figure style={{ ...box, margin: 0 }} aria-label={genuiA11yText(node) ?? undefined}>
    <DataTable head={['', props.unit ?? '']} rows={kids(props.slices).map((s) => [s.props.label, s.props.value])} caption={`Source: ${props.source}`} />
  </figure>
);

const Map = ({ node, props }: GenuiComponentProps) => (
  <figure style={{ ...box, margin: 0 }} aria-label={genuiA11yText(node) ?? undefined}>
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {kids(props.markers).map((m) => (
        <li key={m.id}>
          <a href={`https://www.openstreetmap.org/?mlat=${m.props.lat}&mlon=${m.props.lng}#map=15/${m.props.lat}/${m.props.lng}`} target="_blank" rel="noopener noreferrer">
            {String(m.props.label)}
          </a>
          {m.props.description ? ` — ${String(m.props.description)}` : ''}
        </li>
      ))}
    </ul>
    <figcaption style={muted}>Source: {props.source}</figcaption>
  </figure>
);

const Tabs = ({ props, renderChild }: GenuiComponentProps) => {
  const tabs = kids(props.tabs);
  const [active, setActive] = useState(0);
  const base = useId();
  const current = tabs[Math.min(active, tabs.length - 1)];
  return (
    <div>
      <div role="tablist" style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${v('border', 'rgba(0,0,0,.12)')}` }}>
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            role="tab"
            id={`${base}-t${i}`}
            aria-selected={i === active}
            aria-controls={`${base}-p${i}`}
            onClick={() => setActive(i)}
            style={{ padding: '6px 10px', border: 0, background: 'none', borderBottom: i === active ? `2px solid ${v('accent', 'currentColor')}` : '2px solid transparent', cursor: 'pointer' }}
          >
            {String(tab.props.label)}
          </button>
        ))}
      </div>
      {current ? (
        <div role="tabpanel" id={`${base}-p${active}`} aria-labelledby={`${base}-t${active}`} style={{ paddingTop: 12, display: 'grid', gap: 12 }}>
          {kids(current.props.children).map(renderChild)}
        </div>
      ) : null}
    </div>
  );
};

const Accordion = ({ props, renderChild }: GenuiComponentProps) => (
  <div style={{ display: 'grid', gap: 6 }}>
    {kids(props.items).map((item) => (
      <details key={item.id} style={box}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{String(item.props.title)}</summary>
        <div style={{ paddingTop: 8, display: 'grid', gap: 12 }}>{kids(item.props.children).map(renderChild)}</div>
      </details>
    ))}
  </div>
);

const Badge = ({ props }: GenuiComponentProps) => (
  <span style={{ border: `1px solid ${v('border', 'rgba(0,0,0,.12)')}`, borderRadius: 999, padding: '1px 8px', fontSize: 12, color: TONE[props.tone ?? 'neutral'] }}>
    {props.label}
  </span>
);

const Callout = ({ props }: GenuiComponentProps) => (
  <aside role="note" style={{ ...box, borderLeft: `3px solid ${TONE[props.tone === 'warn' ? 'warn' : props.tone === 'success' ? 'good' : 'neutral']}` }}>
    {props.title ? <strong>{props.title} </strong> : null}
    {props.body}
  </aside>
);

const Image = ({ props }: GenuiComponentProps) => (
  <figure style={{ margin: 0 }}>
    <img src={props.src} alt={props.alt} style={{ maxWidth: '100%', borderRadius: 6 }} />
    {props.caption ? <figcaption style={muted}>{props.caption}</figcaption> : null}
  </figure>
);

const Link = ({ props }: GenuiComponentProps) => (
  <a href={props.href} target="_blank" rel="noopener noreferrer">
    {props.label}
  </a>
);

export const defaultGenuiComponents: GenuiComponentMap = {
  Stack,
  Card,
  Stat,
  StatRow,
  Table,
  Compare,
  RankedList,
  BarChart: SeriesChart,
  LineChart: SeriesChart,
  PieChart,
  Map,
  Tabs,
  Accordion,
  Badge,
  Callout,
  Image,
  Link,
};
```

`packages/sdk/src/genui/react/index.ts`:

```ts
export { defaultGenuiComponents } from './default-components';
export {
  GenuiBlock,
  useGenuiParse,
  type GenuiBlockEvent,
  type GenuiBlockProps,
  type GenuiComponentMap,
  type GenuiComponentProps,
  type GenuiOutcome,
} from './genui-block';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk && bun test src/genui/react/default-components.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/genui/react
git commit -m "feat(sdk/genui): unbranded default components for SDK hosts"
```

---

### Task 9: Public surface, install smoke, docs, gates

**Files:**
- Modify: `packages/sdk/src/public-surface.snapshot.json`, `packages/sdk/src/public-type-surface.snapshot.json` (regenerated)
- Modify: `packages/sdk/scripts/smoke-install.mjs`
- Modify: `packages/sdk/README.md`
- Create: `apps/web/content/docs/sdk/genui.mdx`
- Modify: `.agents/skills/genui/SKILL.md` (status line)

- [ ] **Step 1: Run the surface tests to verify they fail**

Run: `cd packages/sdk && bun test src/public-surface.test.ts src/public-type-surface.test.ts`
Expected: FAIL — snapshot lacks `./genui` and `./genui/react`.

- [ ] **Step 2: Regenerate the snapshots (additive only)**

```bash
cd packages/sdk
UPDATE_SURFACE_SNAPSHOT=1 bun test src/public-surface.test.ts
UPDATE_TYPE_SURFACE_SNAPSHOT=1 bun test src/public-type-surface.test.ts
git diff --stat src/public-surface.snapshot.json src/public-type-surface.snapshot.json
```

Expected: the diff only adds keys under `./genui` and `./genui/react`. If any existing key changes or disappears, stop: that is a breaking change (sdk skill).

- [ ] **Step 3: Extend the install smoke**

In `packages/sdk/scripts/smoke-install.mjs`, add `'zod@3.25.76'` and `'@openuidev/lang-core@0.3.1'` to the package list installed next to `react@19` and `@tanstack/react-query@5` (~L81-82), and add this check after the existing subpath imports (~L91-94):

```js
const genui = await import('@kortix/sdk/genui');
if (genui.GENUI_SCHEMA_VERSION !== 1) throw new Error('genui: wrong schema version');
if (genui.genuiToMarkdown('```openui\nroot = Stack([b])\nb = Badge("ok")\n```') !== '[ok]') {
  throw new Error('genui: markdown fallback broken in the published build');
}
await import('@kortix/sdk/genui/react');
```

- [ ] **Step 4: Document the surface**

Append to `packages/sdk/README.md`:

````md
## Generative UI (`@kortix/sdk/genui`)

When a project turns on the `genui` flag, the agent may answer with ` ```openui ` blocks:
cards, comparisons, charts, maps, tabs. Render them with the headless renderer and your own
components, or with the bundled defaults:

```tsx
import { genuiVersionFromClassName } from '@kortix/sdk/genui';
import { GenuiBlock, defaultGenuiComponents } from '@kortix/sdk/genui/react';

// Inside your markdown renderer's `code` override:
const version = genuiVersionFromClassName(className);
if (version !== null) {
  return (
    <GenuiBlock
      code={code}
      version={version}
      streaming={isStreaming}
      components={defaultGenuiComponents}
      renderMarkdown={(md) => <Markdown>{md}</Markdown>}
    />
  );
}
```

A host that renders no UI (email, a chat bot, a CLI) converts a reply with `genuiToMarkdown(text)`.

Install the optional peers: `npm i zod @openuidev/lang-core@0.3.1`. `@openuidev/lang-core`
sends one pseudonymous PostHog event at install time; set `OPENUI_TELEMETRY_DISABLED=1` or
`DO_NOT_TRACK=1` to turn it off. Runtime telemetry is off unless you opt in.
````

Create `apps/web/content/docs/sdk/genui.mdx`:

````mdx
---
title: Generative UI
description: Render the agent's cards, comparisons, charts, maps, and tabs in your own app.
---

The agent answers in markdown. When a project turns on **Generative UI**, the agent may add
` ```openui ` blocks for structured content: a ranked recommendation, a comparison, a chart from
tool data, places on a map. Prose stays the default; the agent uses a block only when the content
has structure.

## Render blocks

`@kortix/sdk/genui/react` exports `GenuiBlock`, a headless renderer. You pass a component for each
block name, or `defaultGenuiComponents` for unbranded HTML defaults.

| Prop | Meaning |
|---|---|
| `code` | The fence body so far |
| `version` | `genuiVersionFromClassName(className)` or `genuiVersionOf(tag)` |
| `streaming` | The message is still streaming |
| `components` | Block name → your component (`GenuiComponentProps`) |
| `renderMarkdown` | Your markdown renderer, used for fallbacks |
| `enabled` | `false` renders the block as markdown (a viewer setting) |
| `onSettled` | One event per block: outcome, component names, timing. Never content |

## Plain text hosts

`genuiToMarkdown(text)` replaces every block with deterministic markdown. Charts become tables with a
`Source:` line; maps become place lists; tabs and accordions expand.

## Blocks

Stack, Card, Stat, StatRow, Table, Compare, RankedList, BarChart, LineChart, PieChart, Map, Tabs,
Accordion, Badge, Callout, Image, Link. Limits (counts, lengths) are enforced by the SDK; a block that
breaks a limit is dropped and its siblings still render.

## Safety

Blocks hold data, never code. Every link and image URL must be absolute `http` or `https`. Generated
UI cannot run tools or change state.
````

In `.agents/skills/genui/SKILL.md`, replace the status line with:
`**Status: SDK layer shipped (`@kortix/sdk/genui`, `/genui/react`). Runtime, web, mobile: see references/plan.md.**`

- [ ] **Step 5: Run the SDK gates and paste the real output**

```bash
pnpm --filter @kortix/sdk typecheck
pnpm --filter @kortix/sdk test 2>&1 | tail -3
pnpm --filter @kortix/sdk run smoke:install
```

Expected: typecheck exit 0; test summary with 0 fail (baseline count + 42 new tests); smoke install exit 0. End the turn with the sdk skill verdict block: `**Shippable to production: YES / NO / NOT YET**` plus Verified / Unverified / Risk bullets.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk apps/web/content/docs/sdk/genui.mdx .agents/skills/genui/SKILL.md
git commit -m "docs(sdk/genui): public surface, install smoke, and docs"
```
