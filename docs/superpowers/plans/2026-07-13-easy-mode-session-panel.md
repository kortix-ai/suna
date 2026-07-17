# Easy Mode / Advanced Mode Session Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the session action panel two modes — an Easy card home (Progress / Outputs / Context) that is the default for everyone, and Advanced (today's tool stepper, unchanged) — toggleable from Settings, the command palette, and the panel header.

**Architecture:** `features/session/action-panel/` splits into `shared/` (pure functions over `ToolPart[]`), `advanced/` (today's stepper, moved verbatim), and `easy/` (the new cards). Easy mode is a *lens* over the same `ToolPart[]` stream the stepper reads — no new data fetching, no changes to the 104 registered tool views. Tapping any Progress row reveals the real tool view via the existing `ToolPartRenderer`.

**Tech Stack:** Next.js (App Router), React 19, TypeScript, zustand + `persist`, Tailwind v4 + Kortix tokens, `bun test` for co-located unit tests, `motion/react` for animation.

## Global Constraints

- **Do not modify** anything under `features/session/tool/` — the 104 tool views and `tool/shared/registry.ts` are untouched. Easy mode consumes them through `ToolPartRenderer`.
- **Reuse, do not duplicate:** `normalizeName` and `getToolPrimaryArg` from `features/session/tool/tool-meta.ts`. Do not write a second name-normalizer.
- **Never fold `write` / `show` / `show_user` into a group step.** `features/session/session-activity-groups.ts` already establishes this rule (`NO_GROUP_ACTIVITY_TOOLS`) — each of these is a distinct artifact the user must be able to see. Import that set; do not redefine it.
- **Tool name normalization:** the registry holds ~200 keys because every tool registers snake_case, kebab-case, and an `oc-`-prefixed alias. Always normalize (`strip ^oc-`, `-` → `_`) before any lookup.
- **The narration fallback is load-bearing.** MCP tools have arbitrary `server/tool` names that cannot be enumerated, and future tools are unknown. Unknown tools must render "Used <humanized name>" — never a raw identifier, never a crash.
- **Copy strings:** plain string literals are fine (the codebase mixes `tHardcodedUi.raw(...)` with literals — e.g. `Actions`, `Browser`, `Wallpaper` in `session-layout.tsx` and `appearance-tab.tsx`). Do not invent new `hardcodedUi` keys; the extraction is automated.
- **Tests:** co-located `*.test.ts` next to the module, run with `bun test`. Follow `features/session/session-activity-groups.test.ts` as the style reference.
- **Motion:** all animation behind `prefers-reduced-motion`. Step rows stagger on first paint only — appending a live step must never re-animate the list.
- **Types:** `ToolPart.state` is `{ status: 'pending' | 'running' | 'completed' | 'error'; input?; output?; title?; metadata?; error? }`. Wall-clock timing lives at `state.time = { start, end }` and is **not** on the typed interface — read it via `(part.state as any).time`, exactly as `session-actions-panel.tsx:83` does today.

---

## File Structure

**Create:**
- `apps/web/src/features/session/action-panel/index.tsx` — mode selector
- `apps/web/src/features/session/action-panel/shared/collect-tool-parts.ts` — moved from the stepper
- `apps/web/src/features/session/action-panel/shared/narration.ts` — tool → family + sentence
- `apps/web/src/features/session/action-panel/shared/narration.test.ts`
- `apps/web/src/features/session/action-panel/shared/group-steps.ts` — collapse consecutive same-family calls
- `apps/web/src/features/session/action-panel/shared/group-steps.test.ts`
- `apps/web/src/features/session/action-panel/shared/derive-panels.ts` — outputs + context derivation
- `apps/web/src/features/session/action-panel/shared/derive-panels.test.ts`
- `apps/web/src/features/session/action-panel/advanced/advanced-panel.tsx` — today's stepper, moved
- `apps/web/src/features/session/action-panel/easy/easy-panel.tsx`
- `apps/web/src/features/session/action-panel/easy/progress-card.tsx`
- `apps/web/src/features/session/action-panel/easy/progress-view.tsx`
- `apps/web/src/features/session/action-panel/easy/step-row.tsx`
- `apps/web/src/features/session/action-panel/easy/outputs-card.tsx`
- `apps/web/src/features/session/action-panel/easy/context-card.tsx`
- `apps/web/src/features/session/action-panel/easy/panel-card.tsx` — the shared card shell + empty state

**Modify:**
- `apps/web/src/stores/user-preferences-store.ts` — add `panelMode`
- `apps/web/src/stores/user-preferences-store.test.ts` (create if absent)
- `apps/web/src/features/session/session-layout.tsx` — gate the tab strip, render `<ActionPanel>`
- `apps/web/src/features/accounts/settings/appearance-tab.tsx` — segmented control
- `apps/web/src/lib/menu-registry.ts` — `toggle-panel-mode` entry
- `apps/web/src/features/workspace/command-palette.tsx` — `togglePanelMode` handler
- `apps/web/src/app/(system)/debug/tools/page.tsx` — Easy-panel fixture

**Delete:**
- `apps/web/src/features/session/action-panel/session-actions-panel.tsx` (contents move to `advanced/advanced-panel.tsx` + `shared/collect-tool-parts.ts`)

---

### Task 1: `panelMode` preference

**Files:**
- Modify: `apps/web/src/stores/user-preferences-store.ts`
- Test: `apps/web/src/stores/user-preferences-store.test.ts` (create)

**Interfaces:**
- Produces: `export type PanelMode = 'easy' | 'advanced'`; `preferences.panelMode: PanelMode`; `setPanelMode(mode: PanelMode): void`; `togglePanelMode(): void`. Every later task consumes these.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/stores/user-preferences-store.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'bun:test';
import { useUserPreferencesStore } from './user-preferences-store';

describe('panelMode', () => {
  beforeEach(() => {
    useUserPreferencesStore.getState().resetPreferences();
  });

  it('defaults to easy', () => {
    expect(useUserPreferencesStore.getState().preferences.panelMode).toBe('easy');
  });

  it('setPanelMode switches to advanced', () => {
    useUserPreferencesStore.getState().setPanelMode('advanced');
    expect(useUserPreferencesStore.getState().preferences.panelMode).toBe('advanced');
  });

  it('togglePanelMode flips between the two modes', () => {
    const { togglePanelMode } = useUserPreferencesStore.getState();
    togglePanelMode();
    expect(useUserPreferencesStore.getState().preferences.panelMode).toBe('advanced');
    togglePanelMode();
    expect(useUserPreferencesStore.getState().preferences.panelMode).toBe('easy');
  });

  it('resetPreferences restores easy', () => {
    useUserPreferencesStore.getState().setPanelMode('advanced');
    useUserPreferencesStore.getState().resetPreferences();
    expect(useUserPreferencesStore.getState().preferences.panelMode).toBe('easy');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && bun test src/stores/user-preferences-store.test.ts`
Expected: FAIL — `panelMode` is `undefined`, not `'easy'`.

- [ ] **Step 3: Implement**

In `apps/web/src/stores/user-preferences-store.ts`:

Add the type near `TabSwitchModifier` (line ~13):

```ts
/** Session panel presentation: 'easy' = plain-language cards, 'advanced' = the tool stepper */
export type PanelMode = 'easy' | 'advanced';
```

Add to the `UserPreferences` interface (after `disableTabSelector`):

```ts
  /** Session action panel mode — defaults to 'easy' for all users */
  panelMode: PanelMode;
```

Add to the `UserPreferencesState` interface:

```ts
  /** Set the session panel mode */
  setPanelMode: (mode: PanelMode) => void;

  /** Flip between easy and advanced */
  togglePanelMode: () => void;
```

Add `panelMode: 'easy'` to **both** the initial `preferences` object (line ~74) and the `resetPreferences` object (line ~122).

Add the actions:

```ts
      setPanelMode: (mode) => {
        const current = get().preferences;
        set({ preferences: { ...current, panelMode: mode } });
      },

      togglePanelMode: () => {
        const current = get().preferences;
        set({
          preferences: {
            ...current,
            panelMode: current.panelMode === 'easy' ? 'advanced' : 'easy',
          },
        });
      },
```

Note: users with existing persisted state will have no `panelMode` key. Consumers must read it as `s.preferences.panelMode ?? 'easy'` — the same `??` defaulting `appearance-tab.tsx` already uses for `wallpaperId` and `disableTabSelector`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && bun test src/stores/user-preferences-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/stores/user-preferences-store.ts apps/web/src/stores/user-preferences-store.test.ts
git commit -m "feat(web): add panelMode preference defaulting to easy"
```

---

### Task 2: Narration — 104 tools to plain language

**Files:**
- Create: `apps/web/src/features/session/action-panel/shared/narration.ts`
- Test: `apps/web/src/features/session/action-panel/shared/narration.test.ts`

**Interfaces:**
- Consumes: `normalizeName` is *private* to `tool-meta.ts` — this task must **export** it from there (one-line change) rather than duplicate it. Also consumes `getToolPrimaryArg` from `tool-meta.ts`.
- Produces:
  - `export type StepFamily = 'explore' | 'edit' | 'run' | 'web' | 'create' | 'plan' | 'delegate' | 'sessions' | 'memory' | 'apps' | 'automations' | 'projects' | 'skills' | 'ask' | 'retired' | 'other'`
  - `export function familyForTool(toolName: string): StepFamily | 'hidden'`
  - `export function narrateStep(family: StepFamily, parts: ToolPart[]): string`
  - `export function humanizeToolName(toolName: string): string`

- [ ] **Step 1: Export `normalizeName` from tool-meta**

In `apps/web/src/features/session/tool/tool-meta.ts` line 16, change:

```ts
function normalizeName(name: string): string {
```

to:

```ts
export function normalizeName(name: string): string {
```

- [ ] **Step 2: Write the failing test**

Create `apps/web/src/features/session/action-panel/shared/narration.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import type { ToolPart } from '@/ui';
import { familyForTool, humanizeToolName, narrateStep } from './narration';

function part(tool: string, input: Record<string, unknown> = {}): ToolPart {
  return {
    type: 'tool',
    tool,
    callID: `c-${tool}-${Math.random()}`,
    state: { status: 'completed', input },
  } as unknown as ToolPart;
}

describe('familyForTool', () => {
  it('maps the explore family', () => {
    for (const t of ['read', 'glob', 'grep', 'list']) {
      expect(familyForTool(t)).toBe('explore');
    }
  });

  it('maps the edit family', () => {
    for (const t of ['write', 'edit', 'morph_edit', 'apply_patch']) {
      expect(familyForTool(t)).toBe('edit');
    }
  });

  it('maps the web family', () => {
    for (const t of ['web_search', 'websearch', 'web_fetch', 'webfetch', 'scrape_webpage']) {
      expect(familyForTool(t)).toBe('web');
    }
  });

  it('hides context-engine bookkeeping', () => {
    for (const t of ['prune', 'distill', 'compress', 'context_info']) {
      expect(familyForTool(t)).toBe('hidden');
    }
  });

  it('normalizes oc- prefixes and kebab-case aliases', () => {
    expect(familyForTool('oc-session_read')).toBe('sessions');
    expect(familyForTool('session-read')).toBe('sessions');
    expect(familyForTool('oc-trigger-create')).toBe('automations');
  });

  it('falls back to "other" for MCP and unknown tools', () => {
    expect(familyForTool('linear/create_issue')).toBe('other');
    expect(familyForTool('some_tool_shipped_next_year')).toBe('other');
  });
});

describe('narrateStep', () => {
  it('names a single written file', () => {
    expect(narrateStep('edit', [part('write', { filePath: '/a/report.md' })])).toBe(
      'Wrote report.md',
    );
  });

  it('counts multiple edits', () => {
    expect(
      narrateStep('edit', [
        part('edit', { filePath: '/a/one.ts' }),
        part('edit', { filePath: '/a/two.ts' }),
      ]),
    ).toBe('Updated 2 files');
  });

  it('counts reads', () => {
    expect(narrateStep('explore', [part('read'), part('read'), part('read')])).toBe('Read 3 files');
  });

  it('counts web searches', () => {
    expect(narrateStep('web', [part('web_search'), part('web_search')])).toBe(
      'Searched the web · 2 queries',
    );
  });

  it('never emits a raw tool name for unknown tools', () => {
    const line = narrateStep('other', [part('linear/create_issue')]);
    expect(line).toBe('Used Create Issue');
    expect(line).not.toContain('_');
    expect(line).not.toContain('/');
  });
});

describe('humanizeToolName', () => {
  it('strips the MCP server prefix and title-cases', () => {
    expect(humanizeToolName('linear/create_issue')).toBe('Create Issue');
    expect(humanizeToolName('oc-session_read')).toBe('Session Read');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/web && bun test src/features/session/action-panel/shared/narration.test.ts`
Expected: FAIL — `Cannot find module './narration'`.

- [ ] **Step 4: Implement**

Create `apps/web/src/features/session/action-panel/shared/narration.ts`:

```ts
/**
 * Plain-language narration for Easy mode.
 *
 * Turns the 104 registered tools into sentences a non-technical user can read.
 * The registry holds ~200 keys because every tool registers snake_case,
 * kebab-case and an `oc-` alias — `normalizeName` collapses those first.
 *
 * The `other` fallback is load-bearing: MCP tools have arbitrary `server/tool`
 * names that cannot be enumerated, and tools added after this ships are unknown
 * here. Neither may ever surface a raw identifier.
 */

import { getToolPrimaryArg, normalizeName } from '../../tool/tool-meta';
import type { ToolPart } from '@/ui';

export type StepFamily =
  | 'explore'
  | 'edit'
  | 'run'
  | 'web'
  | 'create'
  | 'plan'
  | 'delegate'
  | 'sessions'
  | 'memory'
  | 'apps'
  | 'automations'
  | 'projects'
  | 'skills'
  | 'ask'
  | 'retired'
  | 'other';

/** Context-engine bookkeeping — meaningless to this audience, so Easy mode omits it. */
const HIDDEN = new Set(['prune', 'distill', 'compress', 'context_info']);

const FAMILY_BY_TOOL: Record<string, StepFamily> = {};
function assign(family: StepFamily, tools: string[]) {
  for (const t of tools) FAMILY_BY_TOOL[t] = family;
}

assign('explore', ['read', 'glob', 'grep', 'list']);
assign('edit', ['write', 'edit', 'morph_edit', 'apply_patch']);
assign('run', ['bash', 'pty_spawn', 'pty_read', 'pty_write', 'pty_input', 'pty_kill']);
assign('web', [
  'web_search', 'websearch', 'web_fetch', 'webfetch',
  'scrape_webpage', 'scrapewebpage', 'image_search',
]);
assign('create', ['image_gen', 'video_gen', 'presentation_gen', 'show', 'show_user']);
assign('plan', [
  'todo_write', 'todowrite', 'task', 'task_create', 'task_get', 'task_list',
  'task_update', 'task_done', 'task_delete', 'task_start', 'task_message',
  'task_approve', 'task_cancel',
]);
assign('delegate', [
  'agent_spawn', 'agent_message', 'agent_status', 'agent_stop', 'agent_task',
  'agent_task_create', 'agent_task_get', 'agent_task_list', 'agent_task_update',
  'agent_task_start', 'agent_task_message', 'agent_task_approve', 'agent_task_cancel',
]);
assign('sessions', [
  'session_get', 'session_read', 'session_search', 'session_message', 'session_spawn',
  'session_lineage', 'session_stats', 'session_list', 'session_list_background',
  'session_list_spawned', 'session_start_background',
]);
assign('memory', ['memory', 'memory_search', 'mem_search', 'ltm_search', 'get_mem']);
assign('apps', [
  'connector_get', 'connector_list', 'connector_setup',
  'kortix_executor_call', 'kortix_executor_connectors',
  'kortix_executor_describe', 'kortix_executor_discover',
]);
assign('automations', [
  'triggers', 'trigger_create', 'trigger_delete', 'trigger_get', 'trigger_list',
  'trigger_pause', 'trigger_resume', 'trigger_test', 'trigger_update',
]);
assign('projects', [
  'project_create', 'project_delete', 'project_get',
  'project_list', 'project_select', 'project_update',
]);
assign('skills', ['skill']);
assign('ask', ['question', 'ask']);
assign('retired', [
  'integration_list', 'integration_connect', 'integration_search', 'integration_actions',
  'integration_run', 'integration_request', 'integration_exec',
]);

export function familyForTool(toolName: string): StepFamily | 'hidden' {
  const n = normalizeName(toolName);
  if (HIDDEN.has(n)) return 'hidden';
  return FAMILY_BY_TOOL[n] ?? 'other';
}

/** `linear/create_issue` → `Create Issue`. Never returns a raw identifier. */
export function humanizeToolName(toolName: string): string {
  const n = normalizeName(toolName);
  const leaf = n.includes('/') ? n.slice(n.lastIndexOf('/') + 1) : n;
  return leaf
    .replace(/_/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** The primary arg of the first part, if it has one (a filename, a query, …). */
function firstArg(parts: ToolPart[]): string {
  return parts.length ? getToolPrimaryArg(parts[0]) : '';
}

/**
 * One sentence for a group of same-family calls.
 * `parts` is guaranteed non-empty and homogeneous by `group-steps`.
 */
export function narrateStep(family: StepFamily, parts: ToolPart[]): string {
  const n = parts.length;
  const arg = firstArg(parts);

  switch (family) {
    case 'explore': {
      const reads = parts.filter((p) => normalizeName(p.tool) === 'read').length;
      if (reads === n) return `Read ${n} ${plural(n, 'file', 'files')}`;
      if (reads === 0) return 'Looked through your files';
      return `Looked through your files · ${reads} read`;
    }
    case 'edit': {
      if (n === 1) {
        const verb = normalizeName(parts[0].tool) === 'write' ? 'Wrote' : 'Updated';
        return arg ? `${verb} ${arg}` : `${verb} a file`;
      }
      return `Updated ${n} files`;
    }
    case 'run':
      return n === 1 ? 'Ran a command' : `Ran ${n} commands`;
    case 'web': {
      const searches = parts.filter((p) => {
        const t = normalizeName(p.tool);
        return t === 'web_search' || t === 'websearch' || t === 'image_search';
      }).length;
      if (searches === n) return `Searched the web · ${n} ${plural(n, 'query', 'queries')}`;
      if (searches === 0) return `Read ${n} ${plural(n, 'page', 'pages')}`;
      return `Searched and read ${n} ${plural(n, 'source', 'sources')}`;
    }
    case 'create': {
      const t = normalizeName(parts[0].tool);
      if (t === 'image_gen') return n === 1 ? 'Made an image' : `Made ${n} images`;
      if (t === 'video_gen') return n === 1 ? 'Made a video' : `Made ${n} videos`;
      if (t === 'presentation_gen') return 'Built a presentation';
      return arg ? `Showed you ${arg}` : 'Showed you the result';
    }
    case 'plan':
      return n === 1 ? 'Planned the work' : `Planned the work · ${n} steps`;
    case 'delegate':
      return n === 1 ? 'Asked a helper agent' : `Worked with ${n} helper agents`;
    case 'sessions':
      return 'Checked earlier work';
    case 'memory':
      return 'Recalled what you told it before';
    case 'apps':
      return arg ? `Connected to ${arg}` : 'Connected to an app';
    case 'automations':
      return n === 1 ? 'Set up an automation' : `Updated ${n} automations`;
    case 'projects':
      return arg ? `Opened ${arg}` : 'Opened your project';
    case 'skills':
      return arg ? `Used the ${arg} skill` : 'Used a skill';
    case 'ask':
      return 'Asked you a question';
    case 'retired':
      return 'Used an integration that has since been removed';
    case 'other':
      return `Used ${humanizeToolName(parts[0].tool)}`;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/web && bun test src/features/session/action-panel/shared/narration.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 6: Add the anti-rot coverage test**

The map must not silently fall behind the registry. Append to `narration.test.ts`:

```ts
import { ToolRegistry } from '../../tool/tool-renderers';
import '../../tool/tools/register';

describe('registry coverage', () => {
  it('every registered tool resolves to a family, hidden, or the fallback', () => {
    // ToolRegistry exposes its keys for this check — see Step 7.
    for (const key of ToolRegistry.keys()) {
      const family = familyForTool(key);
      expect(family).toBeTruthy();
      // 'other' is legal, but a *registered* tool landing there means the map
      // has fallen behind — surface it loudly.
      if (family === 'other') {
        throw new Error(`Registered tool "${key}" has no narration family — add it to narration.ts`);
      }
    }
  });
});
```

- [ ] **Step 7: Expose `keys()` on the registry**

In `apps/web/src/features/session/tool/shared/registry.ts`, add a `keys()` method to `ToolRegistry` returning the underlying Map's keys as `string[]`. This is additive and does not change `get()`/`register()` behavior — it is the only permitted change under `tool/`.

Then re-export it if `tool-renderers.tsx` does not already surface `ToolRegistry` (it does — the barrel exports it).

- [ ] **Step 8: Run and fix**

Run: `cd apps/web && bun test src/features/session/action-panel/shared/narration.test.ts`
Expected: PASS. If any registered key throws, add it to the right `assign(...)` list — that is the test doing its job.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/features/session/action-panel/shared/narration.ts \
        apps/web/src/features/session/action-panel/shared/narration.test.ts \
        apps/web/src/features/session/tool/tool-meta.ts \
        apps/web/src/features/session/tool/shared/registry.ts
git commit -m "feat(web): plain-language narration map for all registered tools"
```

---

### Task 3: Grouping consecutive calls into steps

**Files:**
- Create: `apps/web/src/features/session/action-panel/shared/collect-tool-parts.ts`
- Create: `apps/web/src/features/session/action-panel/shared/group-steps.ts`
- Test: `apps/web/src/features/session/action-panel/shared/group-steps.test.ts`

**Interfaces:**
- Consumes: `familyForTool`, `narrateStep`, `StepFamily` (Task 2); `isNoGroupActivityTool` from `features/session/session-activity-groups.ts`.
- Produces:
  - `export function collectToolParts(messages: MessageWithParts[] | undefined): ToolPart[]` (moved verbatim from `session-actions-panel.tsx:24-41`)
  - `export interface Step { id: string; family: StepFamily; label: string; parts: ToolPart[]; status: 'running' | 'error' | 'done'; durationMs?: number }`
  - `export function groupSteps(parts: ToolPart[]): Step[]`

- [ ] **Step 1: Move `collectToolParts`**

Create `apps/web/src/features/session/action-panel/shared/collect-tool-parts.ts` containing the **exact** body of `collectToolParts` from `session-actions-panel.tsx` lines 18-41 (JSDoc included), with these imports:

```ts
import { type MessageWithParts, type ToolPart, isToolPart, shouldShowToolPart } from '@/ui';
import { shouldShowToolPartInActionsPanel } from '../../tool/tool-renderers';
```

- [ ] **Step 2: Write the failing test**

Create `apps/web/src/features/session/action-panel/shared/group-steps.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import type { ToolPart } from '@/ui';
import { groupSteps } from './group-steps';

function part(
  tool: string,
  status: 'running' | 'completed' | 'error' = 'completed',
  input: Record<string, unknown> = {},
): ToolPart {
  return {
    type: 'tool',
    tool,
    callID: `c-${tool}-${Math.random()}`,
    state: { status, input },
  } as unknown as ToolPart;
}

describe('groupSteps', () => {
  it('returns no steps for no parts', () => {
    expect(groupSteps([])).toEqual([]);
  });

  it('collapses consecutive same-family calls into one step', () => {
    const steps = groupSteps([part('read'), part('read'), part('grep')]);
    expect(steps).toHaveLength(1);
    expect(steps[0].family).toBe('explore');
    expect(steps[0].parts).toHaveLength(3);
    expect(steps[0].label).toBe('Looked through your files · 2 read');
  });

  it('starts a new step when the family changes', () => {
    const steps = groupSteps([part('read'), part('bash'), part('read')]);
    expect(steps.map((s) => s.family)).toEqual(['explore', 'run', 'explore']);
  });

  it('never folds write / show / show_user — each is its own step', () => {
    const steps = groupSteps([
      part('write', 'completed', { filePath: '/a/one.md' }),
      part('write', 'completed', { filePath: '/a/two.md' }),
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0].label).toBe('Wrote one.md');
    expect(steps[1].label).toBe('Wrote two.md');
  });

  it('drops hidden context-engine tools entirely', () => {
    const steps = groupSteps([part('read'), part('prune'), part('read')]);
    // `prune` is dropped, so the two reads stay one contiguous group.
    expect(steps).toHaveLength(1);
    expect(steps[0].parts).toHaveLength(2);
  });

  it('marks a step running when any of its parts is running', () => {
    const steps = groupSteps([part('web_search', 'completed'), part('web_search', 'running')]);
    expect(steps[0].status).toBe('running');
  });

  it('marks a step errored when any of its parts errored', () => {
    const steps = groupSteps([part('bash', 'error')]);
    expect(steps[0].status).toBe('error');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/web && bun test src/features/session/action-panel/shared/group-steps.test.ts`
Expected: FAIL — `Cannot find module './group-steps'`.

- [ ] **Step 4: Implement**

Create `apps/web/src/features/session/action-panel/shared/group-steps.ts`:

```ts
/**
 * Collapse an ordered ToolPart[] into the story Easy mode tells.
 *
 * Consecutive calls in the same family become one step ("Read 6 files"), which
 * is what turns a 60-call run into an ~8-line narrative. Three tools are exempt:
 * write / show / show_user are distinct artifacts the user has to actually see,
 * so folding them would hide output. That rule already exists in
 * `session-activity-groups.ts` — we reuse it rather than restate it.
 */

import type { ToolPart } from '@/ui';
import { isNoGroupActivityTool } from '../../session-activity-groups';
import { type StepFamily, familyForTool, narrateStep } from './narration';

export interface Step {
  /** Stable across re-renders: the callID of the step's first part. */
  id: string;
  family: StepFamily;
  label: string;
  parts: ToolPart[];
  status: 'running' | 'error' | 'done';
  durationMs?: number;
}

function statusOf(parts: ToolPart[]): Step['status'] {
  if (parts.some((p) => p.state?.status === 'running' || p.state?.status === 'pending')) {
    return 'running';
  }
  if (parts.some((p) => p.state?.status === 'error')) return 'error';
  return 'done';
}

/**
 * Wall-clock duration of a step. `state.time` is not on the typed interface but
 * is present at runtime — `session-actions-panel.tsx` reads it the same way.
 */
function durationOf(parts: ToolPart[]): number | undefined {
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  for (const p of parts) {
    const time = (p.state as unknown as { time?: { start?: number; end?: number } }).time;
    if (typeof time?.start === 'number') start = Math.min(start, time.start);
    if (typeof time?.end === 'number') end = Math.max(end, time.end);
  }
  if (!Number.isFinite(start) || end <= start) return undefined;
  return end - start;
}

function finalize(family: StepFamily, parts: ToolPart[]): Step {
  return {
    id: parts[0].callID,
    family,
    label: narrateStep(family, parts),
    parts,
    status: statusOf(parts),
    durationMs: durationOf(parts),
  };
}

export function groupSteps(parts: ToolPart[]): Step[] {
  const steps: Step[] = [];
  let family: StepFamily | null = null;
  let buffer: ToolPart[] = [];

  const flush = () => {
    if (family && buffer.length) steps.push(finalize(family, buffer));
    family = null;
    buffer = [];
  };

  for (const part of parts) {
    const f = familyForTool(part.tool);
    if (f === 'hidden') continue; // dropped, and must not split a run

    // write / show / show_user each stand alone.
    if (isNoGroupActivityTool(part.tool)) {
      flush();
      steps.push(finalize(f, [part]));
      continue;
    }

    if (f !== family) {
      flush();
      family = f;
    }
    buffer.push(part);
  }
  flush();

  return steps;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/web && bun test src/features/session/action-panel/shared/group-steps.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/session/action-panel/shared/
git commit -m "feat(web): group tool parts into narrated steps for easy mode"
```

---

### Task 4: Derive Outputs and Context

**Files:**
- Create: `apps/web/src/features/session/action-panel/shared/derive-panels.ts`
- Test: `apps/web/src/features/session/action-panel/shared/derive-panels.test.ts`

**Interfaces:**
- Consumes: `familyForTool` (Task 2), `getToolPrimaryArg` + `normalizeName` (`tool-meta.ts`).
- Produces:
  - `export interface OutputItem { callID: string; name: string; path?: string; kind: 'file' | 'image' | 'video' | 'presentation' }`
  - `export interface ContextItem { callID: string; label: string; kind: 'file' | 'web' | 'tool' }`
  - `export function deriveOutputs(parts: ToolPart[]): OutputItem[]`
  - `export function deriveContext(parts: ToolPart[]): { files: ContextItem[]; web: ContextItem[]; tools: ContextItem[] }`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/features/session/action-panel/shared/derive-panels.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import type { ToolPart } from '@/ui';
import { deriveContext, deriveOutputs } from './derive-panels';

function part(tool: string, input: Record<string, unknown> = {}): ToolPart {
  return {
    type: 'tool',
    tool,
    callID: `c-${tool}-${JSON.stringify(input)}`,
    state: { status: 'completed', input },
  } as unknown as ToolPart;
}

describe('deriveOutputs', () => {
  it('is empty when the agent produced nothing', () => {
    expect(deriveOutputs([part('read', { filePath: '/a/x.ts' })])).toEqual([]);
  });

  it('collects written files', () => {
    const out = deriveOutputs([part('write', { filePath: '/a/report.md' })]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('report.md');
    expect(out[0].kind).toBe('file');
  });

  it('collects generated media', () => {
    const out = deriveOutputs([part('image_gen'), part('presentation_gen')]);
    expect(out.map((o) => o.kind)).toEqual(['image', 'presentation']);
  });

  it('deduplicates a file written more than once', () => {
    const out = deriveOutputs([
      part('write', { filePath: '/a/report.md' }),
      part('edit', { filePath: '/a/report.md' }),
    ]);
    expect(out).toHaveLength(1);
  });
});

describe('deriveContext', () => {
  it('partitions files, web sources, and tools', () => {
    const { files, web, tools } = deriveContext([
      part('read', { filePath: '/a/one.ts' }),
      part('read', { filePath: '/a/two.ts' }),
      part('web_fetch', { url: 'https://example.com/docs' }),
      part('bash', { command: 'ls' }),
    ]);
    expect(files).toHaveLength(2);
    expect(web).toHaveLength(1);
    expect(web[0].label).toBe('https://example.com/docs');
    expect(tools.some((t) => t.label === 'Bash')).toBe(true);
  });

  it('deduplicates a file read twice', () => {
    const { files } = deriveContext([
      part('read', { filePath: '/a/one.ts' }),
      part('read', { filePath: '/a/one.ts' }),
    ]);
    expect(files).toHaveLength(1);
  });

  it('excludes written files from context — they are outputs, not inputs', () => {
    const { files } = deriveContext([part('write', { filePath: '/a/new.md' })]);
    expect(files).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && bun test src/features/session/action-panel/shared/derive-panels.test.ts`
Expected: FAIL — `Cannot find module './derive-panels'`.

- [ ] **Step 3: Implement**

Create `apps/web/src/features/session/action-panel/shared/derive-panels.ts`:

```ts
/**
 * What the agent MADE (Outputs) versus what it LOOKED AT (Context).
 *
 * Both are derived from the same ToolPart[] the Progress list reads — Easy mode
 * adds no data source, it only re-partitions what is already there.
 */

import type { ToolPart } from '@/ui';
import { getToolPrimaryArg, normalizeName } from '../../tool/tool-meta';
import { humanizeToolName } from './narration';

export interface OutputItem {
  callID: string;
  name: string;
  path?: string;
  kind: 'file' | 'image' | 'video' | 'presentation';
}

export interface ContextItem {
  callID: string;
  label: string;
  kind: 'file' | 'web' | 'tool';
}

const WRITE_TOOLS = new Set(['write', 'edit', 'morph_edit', 'apply_patch']);
const READ_TOOLS = new Set(['read']);
const WEB_TOOLS = new Set([
  'web_fetch', 'webfetch', 'scrape_webpage', 'scrapewebpage', 'web_search', 'websearch',
]);

const MEDIA_KIND: Record<string, OutputItem['kind']> = {
  image_gen: 'image',
  video_gen: 'video',
  presentation_gen: 'presentation',
};

function filePathOf(part: ToolPart): string | undefined {
  const input = (part.state?.input ?? {}) as Record<string, unknown>;
  const p = input.filePath ?? input.file_path ?? input.path;
  return typeof p === 'string' && p ? p : undefined;
}

export function deriveOutputs(parts: ToolPart[]): OutputItem[] {
  const out: OutputItem[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    const tool = normalizeName(part.tool);

    if (WRITE_TOOLS.has(tool)) {
      const path = filePathOf(part);
      const name = getToolPrimaryArg(part);
      if (!name) continue;
      const key = path ?? name;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ callID: part.callID, name, path, kind: 'file' });
      continue;
    }

    const media = MEDIA_KIND[tool];
    if (media) {
      out.push({
        callID: part.callID,
        name: getToolPrimaryArg(part) || humanizeToolName(part.tool),
        kind: media,
      });
    }
  }

  return out;
}

export function deriveContext(parts: ToolPart[]): {
  files: ContextItem[];
  web: ContextItem[];
  tools: ContextItem[];
} {
  const files: ContextItem[] = [];
  const web: ContextItem[] = [];
  const tools: ContextItem[] = [];
  const seenFiles = new Set<string>();
  const seenWeb = new Set<string>();
  const seenTools = new Set<string>();

  for (const part of parts) {
    const tool = normalizeName(part.tool);

    if (READ_TOOLS.has(tool)) {
      const path = filePathOf(part) ?? getToolPrimaryArg(part);
      if (!path || seenFiles.has(path)) continue;
      seenFiles.add(path);
      files.push({ callID: part.callID, label: getToolPrimaryArg(part) || path, kind: 'file' });
      continue;
    }

    if (WEB_TOOLS.has(tool)) {
      const input = (part.state?.input ?? {}) as Record<string, unknown>;
      const label =
        (typeof input.url === 'string' && input.url) ||
        (typeof input.query === 'string' && input.query) ||
        getToolPrimaryArg(part);
      if (!label || seenWeb.has(label)) continue;
      seenWeb.add(label);
      web.push({ callID: part.callID, label, kind: 'web' });
      continue;
    }

    // Everything else is recorded once, by name, as "a tool that was used".
    const label = humanizeToolName(part.tool);
    if (seenTools.has(label)) continue;
    seenTools.add(label);
    tools.push({ callID: part.callID, label, kind: 'tool' });
  }

  return { files, web, tools };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && bun test src/features/session/action-panel/shared/derive-panels.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/session/action-panel/shared/derive-panels.ts \
        apps/web/src/features/session/action-panel/shared/derive-panels.test.ts
git commit -m "feat(web): derive outputs and context from tool parts"
```

---

### Task 5: Move the stepper to `advanced/` (pure refactor)

**Files:**
- Create: `apps/web/src/features/session/action-panel/advanced/advanced-panel.tsx`
- Delete: `apps/web/src/features/session/action-panel/session-actions-panel.tsx`
- Modify: `apps/web/src/features/session/session-layout.tsx:10` (import path)

**Interfaces:**
- Consumes: `collectToolParts` from `../shared/collect-tool-parts` (Task 3).
- Produces: `export const AdvancedPanel` — same props as today: `{ sessionId: string; messages: MessageWithParts[] | undefined }`.

**This task changes zero behavior.** Its whole value is that a reviewer can confirm that.

- [ ] **Step 1: Create the new file**

Create `advanced/advanced-panel.tsx` with the **entire contents** of `session-actions-panel.tsx` **except** the `collectToolParts` function (lines 18-41), which now lives in `shared/`. Rename the export `SessionActionsPanel` → `AdvancedPanel` (keep `memo`, keep the JSDoc). Fix imports:

```ts
import { collectToolParts } from '../shared/collect-tool-parts';
import {
  ToolPartRenderer,
  ToolSurfaceContext,
} from '../../tool/tool-renderers';
```

(`shouldShowToolPartInActionsPanel` is no longer imported here — it moved with `collectToolParts`.)

- [ ] **Step 2: Delete the old file**

```bash
git rm apps/web/src/features/session/action-panel/session-actions-panel.tsx
```

- [ ] **Step 3: Update the only consumer**

In `session-layout.tsx`, replace line 10:

```ts
import { SessionActionsPanel } from '@/features/session/action-panel/session-actions-panel';
```

with:

```ts
import { AdvancedPanel } from '@/features/session/action-panel/advanced/advanced-panel';
```

and at line 244, `<SessionActionsPanel .../>` → `<AdvancedPanel .../>`.

- [ ] **Step 4: Verify nothing else imported it**

Run: `cd apps/web && grep -rn "session-actions-panel\|SessionActionsPanel" src/`
Expected: no results. If any remain, update them.

- [ ] **Step 5: Typecheck**

Run: `cd apps/web && bun run typecheck` (or `npx tsc --noEmit` if no such script)
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add -A apps/web/src/features/session/
git commit -m "refactor(web): move actions stepper to action-panel/advanced"
```

---

### Task 6: The card shell and Progress card

**Files:**
- Create: `apps/web/src/features/session/action-panel/easy/panel-card.tsx`
- Create: `apps/web/src/features/session/action-panel/easy/progress-card.tsx`

**Interfaces:**
- Consumes: `Step` (Task 3).
- Produces:
  - `PanelCard` — props `{ title: string; count?: number; onExpand?: () => void; expandable?: boolean; drillIn?: boolean; children?: ReactNode; emptyArt?: ReactNode; emptyText?: string; isEmpty: boolean }`
  - `ProgressCard` — props `{ steps: Step[]; isRunning: boolean; onOpen: () => void }`

- [ ] **Step 1: Build the card shell**

Create `easy/panel-card.tsx`. A `PanelCard` is the reusable shell from the reference design: a rounded-md bordered card, a title row, and a right-hand chevron that either points right (`drillIn`) or rotates down (`expandable`). When `isEmpty`, it renders `emptyArt` above `emptyText` in muted type — the "promise" state.

```tsx
'use client';

import { cn } from '@/lib/utils';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { type ReactNode, useState } from 'react';

export function PanelCard({
  title,
  count,
  drillIn = false,
  onOpen,
  children,
  emptyArt,
  emptyText,
  isEmpty,
  defaultExpanded = false,
}: {
  title: string;
  count?: number;
  /** Chevron points right and the whole card is a button (Progress). */
  drillIn?: boolean;
  onOpen?: () => void;
  children?: ReactNode;
  emptyArt?: ReactNode;
  emptyText?: string;
  isEmpty: boolean;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const reduce = useReducedMotion();
  const open = drillIn ? false : expanded;

  return (
    <div className="border-border bg-card rounded-md border">
      <button
        type="button"
        onClick={() => (drillIn ? onOpen?.() : setExpanded((v) => !v))}
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-4 py-3 text-left"
      >
        <span className="flex items-baseline gap-1.5">
          <span className="text-foreground text-base font-semibold">{title}</span>
          {typeof count === 'number' && count > 0 && (
            <span className="text-muted-foreground text-xs tabular-nums">{count}</span>
          )}
        </span>
        {drillIn ? (
          <ChevronRight className="text-muted-foreground size-4 shrink-0" />
        ) : (
          <motion.span
            animate={{ rotate: open ? 180 : 0 }}
            transition={reduce ? { duration: 0 } : { duration: 0.2, ease: 'easeOut' }}
            className="text-muted-foreground shrink-0"
          >
            <ChevronDown className="size-4" />
          </motion.span>
        )}
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reduce ? { duration: 0 } : { duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4">
              {isEmpty ? (
                <div className="flex flex-col gap-3">
                  {emptyArt}
                  <p className="text-muted-foreground text-sm">{emptyText}</p>
                </div>
              ) : (
                children
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
```

- [ ] **Step 2: Build the Progress card**

Create `easy/progress-card.tsx`. Collapsed, it must be *alive*: while running it shows the current step's label with a shimmer; when idle it shows `N steps · duration`.

```tsx
'use client';

import { cn } from '@/lib/utils';
import { ChevronRight } from 'lucide-react';
import type { Step } from '../shared/group-steps';

function formatTotal(steps: Step[]): string {
  const total = steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
  if (!total) return `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`;
  const secs = Math.round(total / 1000);
  const time = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${steps.length} ${steps.length === 1 ? 'step' : 'steps'} · ${time}`;
}

export function ProgressCard({
  steps,
  isRunning,
  onOpen,
}: {
  steps: Step[];
  isRunning: boolean;
  onOpen: () => void;
}) {
  const current = steps[steps.length - 1];
  const subtitle = isRunning && current ? current.label : formatTotal(steps);

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={steps.length === 0}
      className="border-border bg-card hover:border-border/80 flex w-full cursor-pointer items-center justify-between gap-2 rounded-md border px-4 py-3 text-left transition-colors disabled:cursor-default"
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-foreground text-base font-semibold">Progress</span>
        <span
          className={cn(
            'text-muted-foreground truncate text-sm',
            isRunning && 'animate-pulse motion-reduce:animate-none',
          )}
        >
          {steps.length === 0 ? 'Nothing yet' : subtitle}
        </span>
      </span>
      <ChevronRight className="text-muted-foreground size-4 shrink-0" />
    </button>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/features/session/action-panel/easy/
git commit -m "feat(web): easy-mode card shell and progress card"
```

---

### Task 7: Progress drill-in view and step rows

**Files:**
- Create: `apps/web/src/features/session/action-panel/easy/step-row.tsx`
- Create: `apps/web/src/features/session/action-panel/easy/progress-view.tsx`

**Interfaces:**
- Consumes: `Step` (Task 3); `ToolPartRenderer` + `ToolSurfaceContext` from `../../tool/tool-renderers`.
- Produces:
  - `StepRow` — `{ step: Step; sessionId: string; index: number; expanded: boolean; onToggle: () => void }`
  - `ProgressView` — `{ steps: Step[]; sessionId: string; onBack: () => void; focusStepId?: string }`

- [ ] **Step 1: Build the step row**

Create `easy/step-row.tsx`. This is the escape hatch — tapping a row reveals the **real** tool views for that step.

```tsx
'use client';

import { cn } from '@/lib/utils';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ToolPartRenderer, ToolSurfaceContext } from '../../tool/tool-renderers';
import type { Step } from '../shared/group-steps';

function StatusDot({ status }: { status: Step['status'] }) {
  if (status === 'running') {
    return (
      <span className="relative flex size-2 shrink-0">
        <span className="bg-primary absolute inline-flex size-2 animate-ping rounded-full opacity-60 motion-reduce:animate-none" />
        <span className="bg-primary relative inline-flex size-2 rounded-full" />
      </span>
    );
  }
  return (
    <span
      className={cn(
        'size-2 shrink-0 rounded-full',
        status === 'error' ? 'bg-destructive' : 'bg-muted-foreground/40',
      )}
    />
  );
}

function formatDuration(ms?: number): string {
  if (!ms) return '';
  const secs = Math.round(ms / 1000);
  if (secs < 1) return '<1s';
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export function StepRow({
  step,
  sessionId,
  expanded,
  onToggle,
}: {
  step: Step;
  sessionId: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const reduce = useReducedMotion();

  return (
    <div className="border-border/60 border-b last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="hover:bg-muted/40 flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left transition-colors"
      >
        <StatusDot status={step.status} />
        <span
          className={cn(
            'text-foreground min-w-0 flex-1 truncate text-sm',
            step.status === 'error' && 'text-destructive',
          )}
        >
          {step.label}
        </span>
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {formatDuration(step.durationMs)}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reduce ? { duration: 0 } : { duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            {/* The escape hatch: the real tool views, unmodified. */}
            <div className="bg-muted/20 px-2 pb-2">
              <ToolSurfaceContext.Provider value="panel">
                {step.parts.map((part) => (
                  <ToolPartRenderer key={part.callID} part={part} sessionId={sessionId} defaultOpen />
                ))}
              </ToolSurfaceContext.Provider>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
```

- [ ] **Step 2: Build the drill-in view**

Create `easy/progress-view.tsx`. Rows stagger on **first paint only** — `hasAnimatedRef` guards against re-animating when a live step is appended.

```tsx
'use client';

import { Button } from '@/components/ui/button';
import { motion, useReducedMotion } from 'motion/react';
import { ChevronLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Step } from '../shared/group-steps';
import { StepRow } from './step-row';

export function ProgressView({
  steps,
  sessionId,
  onBack,
  focusStepId,
}: {
  steps: Step[];
  sessionId: string;
  onBack: () => void;
  /** Step to auto-expand and scroll to (set when a tool call is clicked in chat). */
  focusStepId?: string;
}) {
  const reduce = useReducedMotion();
  const [expandedId, setExpandedId] = useState<string | null>(focusStepId ?? null);
  const hasAnimatedRef = useRef(false);
  const focusRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    hasAnimatedRef.current = true;
  }, []);

  useEffect(() => {
    if (!focusStepId) return;
    setExpandedId(focusStepId);
    focusRef.current?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  }, [focusStepId, reduce]);

  const stagger = !reduce && !hasAnimatedRef.current;

  return (
    <div className="flex h-full flex-col">
      <div className="border-border flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back" className="h-7">
          <ChevronLeft className="size-4" />
        </Button>
        <span className="text-foreground text-sm font-medium">Progress</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {steps.map((step, i) => (
          <motion.div
            key={step.id}
            ref={step.id === focusStepId ? focusRef : undefined}
            initial={stagger ? { opacity: 0, y: 4 } : false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut', delay: stagger ? i * 0.02 : 0 }}
          >
            <StepRow
              step={step}
              sessionId={sessionId}
              expanded={expandedId === step.id}
              onToggle={() => setExpandedId((cur) => (cur === step.id ? null : step.id))}
            />
          </motion.div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/features/session/action-panel/easy/
git commit -m "feat(web): progress drill-in view with per-step tool escape hatch"
```

---

### Task 8: Outputs, Context, and the Easy panel

**Files:**
- Create: `apps/web/src/features/session/action-panel/easy/outputs-card.tsx`
- Create: `apps/web/src/features/session/action-panel/easy/context-card.tsx`
- Create: `apps/web/src/features/session/action-panel/easy/easy-panel.tsx`

**Interfaces:**
- Consumes: `PanelCard` (Task 6), `ProgressCard` (Task 6), `ProgressView` (Task 7), `groupSteps` + `Step` (Task 3), `deriveOutputs` + `deriveContext` (Task 4), `collectToolParts` (Task 3).
- Produces: `export const EasyPanel` — props `{ sessionId: string; messages: MessageWithParts[] | undefined }` (identical to `AdvancedPanel`, so `index.tsx` can swap them freely).

- [ ] **Step 1: Outputs card**

Create `easy/outputs-card.tsx`. Empty text is verbatim from the reference: *"View and open files created during this task."*

```tsx
'use client';

import { Icon } from '@/features/icon/icon';
import { useSessionBrowserStore } from '@/stores/session-browser-store';
import { FileText, Image, Presentation, Video } from 'lucide-react';
import type { OutputItem } from '../shared/derive-panels';
import { PanelCard } from './panel-card';

const KIND_ICON = {
  file: FileText,
  image: Image,
  video: Video,
  presentation: Presentation,
} as const;

export function OutputsCard({
  outputs,
  sessionId,
  defaultExpanded,
}: {
  outputs: OutputItem[];
  sessionId: string;
  /** Auto-expands when a run finishes with content — the payoff moment. */
  defaultExpanded: boolean;
}) {
  const revealFile = useSessionBrowserStore((s) => s.setFileOpen);

  return (
    <PanelCard
      title="Outputs"
      count={outputs.length}
      isEmpty={outputs.length === 0}
      defaultExpanded={defaultExpanded}
      emptyArt={<OutputsArt />}
      emptyText="View and open files created during this task."
    >
      <ul className="flex flex-col gap-1">
        {outputs.map((o) => {
          const Ico = KIND_ICON[o.kind];
          return (
            <li key={o.callID}>
              <button
                type="button"
                disabled={!o.path}
                onClick={() => o.path && revealFile(sessionId, o.path)}
                className="hover:bg-muted/50 flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors disabled:cursor-default"
              >
                <Ico className="text-muted-foreground size-4 shrink-0" />
                <span className="text-foreground truncate text-sm">{o.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </PanelCard>
  );
}

/** Soft placeholder art — a stacked-document glyph, matching the reference. */
function OutputsArt() {
  return (
    <div
      aria-hidden
      className="border-border/60 bg-muted/30 flex h-16 w-20 items-end justify-center gap-1 rounded-md border p-3"
    >
      <span className="bg-muted-foreground/30 h-4 w-1.5 rounded-sm" />
      <span className="bg-muted-foreground/30 h-7 w-1.5 rounded-sm" />
      <span className="bg-muted-foreground/30 h-5 w-1.5 rounded-sm" />
    </div>
  );
}
```

**Note:** verify `setFileOpen` is the actual action name on `session-browser-store` (the map noted `fileOpenBySession` reveal requests). Run `grep -n "fileOpen" src/stores/session-browser-store.ts` and use the real setter. If the store exposes a different name, use it — do not invent one.

- [ ] **Step 2: Context card**

Create `easy/context-card.tsx`. Empty text verbatim: *"Track tools and referenced files used in this task."*

```tsx
'use client';

import { FileText, Globe, Wrench } from 'lucide-react';
import type { ContextItem } from '../shared/derive-panels';
import { PanelCard } from './panel-card';

function Group({
  label,
  items,
  icon: Ico,
}: {
  label: string;
  items: ContextItem[];
  icon: typeof FileText;
}) {
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs font-medium">
        {label} ({items.length})
      </span>
      <ul className="flex flex-col gap-0.5">
        {items.map((it) => (
          <li key={it.callID} className="flex items-center gap-2 px-2 py-1">
            <Ico className="text-muted-foreground size-3.5 shrink-0" />
            <span className="text-foreground truncate text-sm">{it.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ContextCard({
  files,
  web,
  tools,
}: {
  files: ContextItem[];
  web: ContextItem[];
  tools: ContextItem[];
}) {
  const total = files.length + web.length + tools.length;

  return (
    <PanelCard
      title="Context"
      count={total}
      isEmpty={total === 0}
      emptyArt={<ContextArt />}
      emptyText="Track tools and referenced files used in this task."
    >
      <div className="flex flex-col gap-3">
        <Group label="Files read" items={files} icon={FileText} />
        <Group label="Web sources" items={web} icon={Globe} />
        <Group label="Tools used" items={tools} icon={Wrench} />
      </div>
    </PanelCard>
  );
}

/** Soft placeholder art — overlapping note cards, matching the reference. */
function ContextArt() {
  return (
    <div aria-hidden className="relative h-16 w-24">
      <span className="border-border/60 bg-muted/30 absolute top-3 left-0 h-10 w-8 rounded-sm border" />
      <span className="border-border/60 bg-muted/40 absolute top-1.5 left-6 h-12 w-9 rounded-sm border" />
      <span className="border-border/60 border-dashed bg-transparent absolute top-3 left-14 h-10 w-8 rounded-sm border" />
    </div>
  );
}
```

- [ ] **Step 3: The Easy panel**

Create `easy/easy-panel.tsx`. It owns the home/drill-in switch and the auto-expand-on-finish behavior, and it must honor `focusedToolCallId` (a tool call clicked in the chat) by opening Progress at that step.

```tsx
'use client';

import { useClearFocusedToolCall, useFocusedToolCallId } from '@/stores/kortix-computer-store';
import type { MessageWithParts } from '@/ui';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { collectToolParts } from '../shared/collect-tool-parts';
import { deriveContext, deriveOutputs } from '../shared/derive-panels';
import { groupSteps } from '../shared/group-steps';
import { ContextCard } from './context-card';
import { OutputsCard } from './outputs-card';
import { ProgressCard } from './progress-card';
import { ProgressView } from './progress-view';

export const EasyPanel = memo(function EasyPanel({
  sessionId,
  messages,
}: {
  sessionId: string;
  messages: MessageWithParts[] | undefined;
}) {
  const parts = useMemo(() => collectToolParts(messages), [messages]);
  const steps = useMemo(() => groupSteps(parts), [parts]);
  const outputs = useMemo(() => deriveOutputs(parts), [parts]);
  const context = useMemo(() => deriveContext(parts), [parts]);

  const isRunning = steps.some((s) => s.status === 'running');

  const [drilledIn, setDrilledIn] = useState(false);
  const [focusStepId, setFocusStepId] = useState<string | undefined>();

  // Auto-expand Outputs the moment a run finishes with something to show.
  const wasRunningRef = useRef(false);
  const [outputsDefaultOpen, setOutputsDefaultOpen] = useState(false);
  useEffect(() => {
    if (wasRunningRef.current && !isRunning && outputs.length > 0) {
      setOutputsDefaultOpen(true);
    }
    wasRunningRef.current = isRunning;
  }, [isRunning, outputs.length]);

  // A tool call clicked in the chat drills straight into Progress at that step.
  const focusedToolCallId = useFocusedToolCallId();
  const clearFocusedToolCall = useClearFocusedToolCall();
  useEffect(() => {
    if (!focusedToolCallId) return;
    const step = steps.find((s) => s.parts.some((p) => p.callID === focusedToolCallId));
    if (step) {
      setDrilledIn(true);
      setFocusStepId(step.id);
    }
    clearFocusedToolCall();
  }, [focusedToolCallId, steps, clearFocusedToolCall]);

  if (drilledIn) {
    return (
      <ProgressView
        steps={steps}
        sessionId={sessionId}
        focusStepId={focusStepId}
        onBack={() => {
          setDrilledIn(false);
          setFocusStepId(undefined);
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3">
      <ProgressCard steps={steps} isRunning={isRunning} onOpen={() => setDrilledIn(true)} />
      <OutputsCard
        outputs={outputs}
        sessionId={sessionId}
        defaultExpanded={outputsDefaultOpen}
      />
      <ContextCard files={context.files} web={context.web} tools={context.tools} />
    </div>
  );
});
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/session/action-panel/easy/
git commit -m "feat(web): easy-mode panel with progress, outputs and context cards"
```

---

### Task 9: Wire the mode into the panel

**Files:**
- Create: `apps/web/src/features/session/action-panel/index.tsx`
- Modify: `apps/web/src/features/session/session-layout.tsx`

**Interfaces:**
- Consumes: `EasyPanel` (Task 8), `AdvancedPanel` (Task 5), `panelMode` (Task 1).
- Produces: `export function ActionPanel(props: { sessionId: string; messages: MessageWithParts[] | undefined })`.

- [ ] **Step 1: The mode selector**

Create `action-panel/index.tsx`:

```tsx
'use client';

import { useUserPreferencesStore } from '@/stores/user-preferences-store';
import type { MessageWithParts } from '@/ui';
import { AdvancedPanel } from './advanced/advanced-panel';
import { EasyPanel } from './easy/easy-panel';

export function ActionPanel({
  sessionId,
  messages,
}: {
  sessionId: string;
  messages: MessageWithParts[] | undefined;
}) {
  // Users with preferences persisted before this shipped have no panelMode key.
  const mode = useUserPreferencesStore((s) => s.preferences.panelMode ?? 'easy');
  return mode === 'advanced' ? (
    <AdvancedPanel sessionId={sessionId} messages={messages} />
  ) : (
    <EasyPanel sessionId={sessionId} messages={messages} />
  );
}
```

- [ ] **Step 2: Gate the tab strip in `session-layout.tsx`**

Replace the `AdvancedPanel` import (from Task 5) with:

```ts
import { ActionPanel } from '@/features/session/action-panel';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';
```

Inside `SessionLayout`, add:

```ts
  const panelMode = useUserPreferencesStore((s) => s.preferences.panelMode ?? 'easy');
  const isEasy = panelMode === 'easy';
```

In Easy mode the panel is only ever the card home — the other views are engineer
surfaces. Force the view and skip their bodies entirely:

```ts
  const effectiveView: SessionPanelView = isEasy ? 'actions' : panelView;
  const showBrowser = !isEasy && effectiveView === 'browser';
  const showExplorer = !isEasy && effectiveView === 'explorer';
  const showTerminal = !isEasy && effectiveView === 'terminal';
  const showAudit = !isEasy && effectiveView === 'audit';
```

(Replace the four existing `show*` consts at lines 85-88. `panelView` and
`setPanelView` stay — `session-browser-store` keeps its state untouched, waiting
for Advanced.)

At line 244, `<AdvancedPanel .../>` → `<ActionPanel sessionId={sessionId} messages={messages} />`.

- [ ] **Step 3: Pass the mode to the header**

Change the `panelHeader` block to hand the switcher both the mode and a toggle:

```tsx
  const togglePanelMode = useUserPreferencesStore((s) => s.togglePanelMode);

  const panelHeader = (
    <PanelHeaderSwitcher
      view={effectiveView}
      onChangeView={(v) => setPanelView(sessionId, v)}
      isSidePanelOpen={isSidePanelOpen}
      onTogglePanel={handleTogglePanel}
      auditBadge={auditPendingCount}
      isEasy={isEasy}
      onToggleMode={togglePanelMode}
    />
  );
```

- [ ] **Step 4: Render the Easy header**

In `PanelHeaderSwitcher`, add `isEasy: boolean` and `onToggleMode: () => void` to the props type. At the top of the returned JSX, branch: when `isEasy`, render a plain title row and the discovery affordance instead of the `Tabs`:

```tsx
  if (isEasy) {
    return (
      <div className="flex shrink-0 items-center justify-between border-b p-2">
        <span className="text-foreground pl-2 text-sm font-medium">Activity</span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleMode}
            className="text-muted-foreground hover:text-foreground h-7 cursor-pointer text-xs"
          >
            Advanced
          </Button>
          <Hint
            side="bottom"
            sideOffset={4}
            delayDuration={300}
            label={
              <span className="flex items-center gap-1.5">
                {isSidePanelOpen ? 'Close' : 'Open'} panel
                <KbdGroup>
                  <Kbd className="font-mono">⌘I</Kbd>
                </KbdGroup>
              </span>
            }
          >
            <Button
              variant="ghost"
              size="icon"
              onClick={onTogglePanel}
              className="text-foreground h-7 cursor-pointer transition-colors"
            >
              <PanelRight className="h-4 w-4" />
            </Button>
          </Hint>
        </div>
      </div>
    );
  }
```

Leave the existing tabbed return as the `else` path, untouched, but add an
`Easy` button next to its panel toggle so Advanced users can get back:

```tsx
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleMode}
          className="text-muted-foreground hover:text-foreground h-7 cursor-pointer text-xs"
        >
          Easy
        </Button>
```

(Wrap the existing `Hint`+`Button` and this new button in a
`<div className="flex items-center gap-1">`.)

- [ ] **Step 5: Verify both modes render**

Run: `cd apps/web && bun run typecheck && bun test src/features/session/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/session/
git commit -m "feat(web): render easy or advanced panel by preference"
```

---

### Task 10: Settings toggle

**Files:**
- Modify: `apps/web/src/features/accounts/settings/appearance-tab.tsx`

**Interfaces:**
- Consumes: `panelMode`, `setPanelMode` (Task 1).

A segmented control, not a `Switch` — "Easy mode: off" tells a user nothing. Model it on the existing Color Mode control at lines 116-153 (same `bg-foreground/10 shadow-custom` pill), and add a description line beneath.

- [ ] **Step 1: Read the preference**

Add near the other selectors (line ~93):

```ts
  const panelMode = useUserPreferencesStore((s) => s.preferences.panelMode ?? 'easy');
  const setPanelMode = useUserPreferencesStore((s) => s.setPanelMode);
```

- [ ] **Step 2: Render the control**

Insert a new section **after** the Wallpaper block and **before** the Layout block (line ~171):

```tsx
      <div className="flex flex-col space-y-2">
        <label className="text-muted-foreground text-sm font-medium">Session panel</label>
        <div className="bg-foreground/10 shadow-custom flex w-fit items-center gap-1 rounded-sm p-0.5">
          <button
            type="button"
            onClick={() => setPanelMode('easy')}
            className="text-foreground inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-sm px-3 transition-colors duration-150 ease-out"
            style={{ backgroundColor: panelMode === 'easy' ? 'var(--background)' : 'transparent' }}
          >
            <span className="text-sm font-medium">Easy</span>
          </button>
          <button
            type="button"
            onClick={() => setPanelMode('advanced')}
            className="text-foreground inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-sm px-3 transition-colors duration-150 ease-out"
            style={{
              backgroundColor: panelMode === 'advanced' ? 'var(--background)' : 'transparent',
            }}
          >
            <span className="text-sm font-medium">Advanced</span>
          </button>
        </div>
        <p className="text-muted-foreground text-xs">
          {panelMode === 'easy'
            ? 'Shows what the agent is doing in plain language. Tap any step to see the details.'
            : 'Shows every tool call in full, with step-by-step navigation.'}
        </p>
      </div>
```

- [ ] **Step 3: Verify**

Run: `cd apps/web && bun run typecheck`
Expected: PASS.

Manually: open Settings → Appearance, flip the control, confirm the session panel swaps live (zustand is reactive, no reload needed).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/features/accounts/settings/appearance-tab.tsx
git commit -m "feat(web): session panel mode control in appearance settings"
```

---

### Task 11: Command palette toggle

**Files:**
- Modify: `apps/web/src/lib/menu-registry.ts`
- Modify: `apps/web/src/features/workspace/command-palette.tsx`

**Interfaces:**
- Consumes: `togglePanelMode` (Task 1).
- Produces: registry id `toggle-panel-mode`, `actionId: 'togglePanelMode'`.

- [ ] **Step 1: Register the command**

In `lib/menu-registry.ts`, add `SlidersHorizontal` to the lucide import if not already present (it is — line ~68). Add an entry immediately after `toggle-sidebar` (line 908):

```ts
  {
    id: 'toggle-panel-mode',
    label: 'Toggle Easy / Advanced Panel',
    icon: SlidersHorizontal,
    group: 'view',
    showIn: ['commandPalette'],
    kind: 'action',
    actionId: 'togglePanelMode',
    keywords: ['easy', 'advanced', 'simple', 'panel', 'session', 'detail', 'mode'],
    requiresSession: true,
  },
```

- [ ] **Step 2: Add the handler**

In `features/workspace/command-palette.tsx`, add the import:

```ts
import { useUserPreferencesStore } from '@/stores/user-preferences-store';
```

Add the callback near `handleToggleSidebar`:

```ts
  const handleTogglePanelMode = useCallback(() => {
    close();
    useUserPreferencesStore.getState().togglePanelMode();
  }, [close]);
```

Register it in the `actionHandlers` map (line ~1105) and add it to the dependency array:

```ts
      togglePanelMode: handleTogglePanelMode,
```

- [ ] **Step 3: Check the suppression list**

The map noted a `LEGACY_PALETTE_HIDDEN` set around line 130 that suppresses some registry ids. Run:

```bash
cd apps/web && grep -n -A15 "LEGACY_PALETTE_HIDDEN" src/features/workspace/command-palette.tsx
```

Confirm `toggle-panel-mode` is **not** in it. If the set is an allowlist rather than a denylist, add the id.

- [ ] **Step 4: Verify**

Run: `cd apps/web && bun run typecheck`
Expected: PASS.

Manually: open a session, hit `⌘K`, type "easy" — the command appears and flips the panel.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/menu-registry.ts apps/web/src/features/workspace/command-palette.tsx
git commit -m "feat(web): toggle easy/advanced panel from the command palette"
```

---

### Task 12: Debug fixture and end-to-end verification

**Files:**
- Modify: `apps/web/src/app/(system)/debug/tools/page.tsx`

- [ ] **Step 1: Add an Easy-panel fixture**

The debug page already renders every tool view with fixture data. Add a section at the top that feeds the **same fixture `ToolPart[]`** through `groupSteps` and renders `<EasyPanel>` inside a fixed-width column (`w-[420px] h-[600px] border rounded-md`), so both modes stay eyeball-checkable side by side. Read the file first to match its existing fixture shape and section conventions.

- [ ] **Step 2: Run the full check**

```bash
cd apps/web && bun test src/features/session/ src/stores/user-preferences-store.test.ts && bun run typecheck && bun run lint
```

Expected: all PASS.

- [ ] **Step 3: Drive the real app**

Use the `verify` skill (or `/run`) to boot the app and exercise the flow end to end:

1. Open a session with a completed run. The panel shows **Progress / Outputs / Context**, no tab strip.
2. Click **Progress** → the step list appears, narrated in plain language, **no raw tool names**.
3. Click a step → the real tool view expands beneath it.
4. Click a tool call **in the chat transcript** → the panel drills into Progress at that step, expanded. (This is the regression that is easiest to break silently.)
5. Click **Advanced** in the header → the stepper returns, tab strip and all, with prev/next and the slider working exactly as before.
6. `⌘K` → "easy" → the command flips it back.
7. Settings → Appearance → the segmented control reflects and changes the mode.
8. Start a new run → Progress ticks live and Outputs auto-expands when it finishes.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/\(system\)/debug/tools/page.tsx
git commit -m "test(web): easy-panel fixture on the tool debug page"
```

---

## Self-Review Notes

**Spec coverage:** every section of the design maps to a task — structure (5, 8, 9), narration incl. all 104 tools (2), grouping (3), Outputs/Context (4, 8), motion (6, 7), the three toggle surfaces (10, 11, and the header in 9), compatibility incl. the `focusToolCall` regression (8, 9, 12).

**Two known gaps, deliberately deferred:**
- The **one-time dismissible hint** for existing users (spec, "The toggle") is not a task. The header now carries a permanent `Advanced` button, which solves discovery more cheaply and permanently than a dismissible toast. If the hint is still wanted, it is a small follow-up.
- **Mobile.** The Drawer path renders `effectivePanelHeader` + `effectivePanelBody`, so Easy mode works there for free — but the card layout has not been designed for a 85dvh drawer. Verify in step 12.3 and file a follow-up if it is cramped.

**Two assumptions the implementer must confirm, not assume:**
- `session-browser-store`'s file-reveal setter name (Task 8, Step 1) — grep for it.
- `LEGACY_PALETTE_HIDDEN` is a denylist, not an allowlist (Task 11, Step 3) — read it.
