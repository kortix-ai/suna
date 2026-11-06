# Generative UI — plan 3: project flag, kill switch, prompt injection, channel guards

> **Superseded (2026-10-24):** generative UI is always on. The `genui` project flag, the `GENUI_ENABLED` kill switch and the `KORTIX_GENUI` sandbox env described below were deleted. Every session lists the `kortix-genui` system skill. See `../SKILL.md`.

> **Superseded delivery (2026-10-13):** the prompt-injection tasks below (`genui-instruction.ts`, `/tmp/kortix/genui.md`, pi `genuiPromptSection`) were replaced by the `kortix-genui` managed system skill, which the flag shows or hides. See rule 4 in `../SKILL.md`. The flag, kill switch and channel-guard tasks still hold.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Load the **testing** skill before Task 1.

**Goal:** A project owner turns on `genui`; every new session of that project (and any session rebuilt from scratch) teaches the agent the catalog; with the flag off, nothing about a session changes; no chat channel or CLI output ever shows OpenUI source.

**Architecture:** The API resolves `genui` (project flag AND the `GENUI_ENABLED` kill switch) into one sandbox env var, `KORTIX_GENUI=1|0`, at provisioning. kortixd turns `KORTIX_GENUI=1` into the prompt text from `buildGenuiPrompt()` (Tasks 3 and 4, removed: see there). Slack/Teams relay text and CLI output pass through `genuiToMarkdown`.

**Tech Stack:** Hono API (`apps/api`), kortixd (`apps/kortix-sandbox-agent-server`, Bun, no-semicolon style), `@kortix/sdk/genui`, Bun test.

**Spec:** `.agents/skills/genui/references/spec.md` §4 (stories 8, 12, 13), §5.4, §8.1 R-FLAG-1, R-CHAN-1. Master plan: `plan.md` (deltas D5, D6).

**Depends on:** plan-1 merged into the branch (`@kortix/sdk/genui`), plan-2 decision GO.

## Global Constraints

See `plan.md`. Specific to this plan:
- `process.env` is read only in `apps/api/src/config.ts` (API lint rule).
- The flag is boot-only: it is read at provisioning, and an in-place restart keeps the sandbox env, so a running or restarted session keeps its prompt until a new session starts. Do not add `KORTIX_GENUI` to pi `RUNTIME_ENV_NAMES`.
- Flag off ⇒ the pi system prompt is byte-for-byte what it is on `dev` today (spec R-FLAG-1).

## Review Focus

- `KORTIX_GENUI` missing entirely (old API, new kortixd) → treated as off.

---

### Task 1: The `genui` project flag (7 sites)

**Files:**
- Modify: `packages/api-contract/src/index.ts` (`FeatureFlagMapSchema`, ~L55-68)
- Modify: `packages/api-contract/src/__tests__/schemas.test.ts` (fixture ~L147, key list ~L749)
- Modify: `packages/sdk/src/core/rest/projects-client/projects.ts` (`FeatureFlagKey` union ~L64, `FEATURE_FLAG_KEYS` ~L102)
- Modify: `packages/sdk/src/core/rest/projects-client/projects.test.ts` (~L976)
- Modify: `apps/api/src/feature-flags/registry.ts` (new entry after `pi_harness`, ~L322)
- Modify: `packages/ui/src/internal/lib/use-project-feature-flags.ts` (~L42, ~L60, trailing `isLoading`)
- Modify: `apps/web/translations/{en,de,es,fr,it,ja,pt,sr,zh}.json` (next to `"pi_harness"`, en ~L1007)

**Interfaces:**
- Produces: `FeatureFlagKey` includes `'genui'`; `resolveFeatureFlag(metadata, 'genui'): boolean`; web `useProjectFeatureFlags(projectId).genui: boolean`.

- [ ] **Step 1: List every holder before editing (registry header instruction)**

Run: `rg -l "reminders" --glob '!node_modules' . | xargs rg -l "pi_harness"`
Expected: the 7 files above plus tests that do not hardcode keys (`unit-feature-flag-drift.test.ts`, `unit-feature-flags.test.ts`, `menu-registry.flags.test.ts`). If the list differs, add each extra file to this task.

- [ ] **Step 2: Write the failing tests (the two hand-written key lists)**

In `packages/api-contract/src/__tests__/schemas.test.ts`, add `genui: false,` to the project fixture next to `pi_harness: false,` and `'genui',` to the key list next to `'pi_harness',` (keep the list's existing order rule: if it is sorted, insert sorted).
In `packages/sdk/src/core/rest/projects-client/projects.test.ts`, add `'genui',` to the sorted-compare list (~L976).

- [ ] **Step 3: Run them to verify they fail**

Run: `cd packages/api-contract && bun test src/__tests__/schemas.test.ts` and `cd packages/sdk && bun test src/core/rest/projects-client/projects.test.ts`
Expected: both FAIL — the schema and `FEATURE_FLAG_KEYS` do not contain `genui`.

- [ ] **Step 4: Add the key to the contract, the SDK, and the registry**

`packages/api-contract/src/index.ts`, inside `FeatureFlagMapSchema`:

```ts
  genui: z.boolean(),
```

`packages/sdk/src/core/rest/projects-client/projects.ts`: add `| 'genui'` to `FeatureFlagKey` and `'genui',` to `FEATURE_FLAG_KEYS` (same position rule as the neighbors).

`apps/api/src/feature-flags/registry.ts`, after the `pi_harness` entry:

```ts
  {
    key: 'genui',
    name: 'Generative UI',
    description:
      'The agent may answer with cards, comparisons, charts, maps, and tabs instead of long text. On ⇒ every new session of this project (and any session rebuilt from scratch) teaches the agent the Kortix generative UI catalog (KORTIX_GENUI=1 in kortixd). Off ⇒ the agent writes markdown only; blocks already in a transcript still render.',
    stability: 'experimental',
    available: () => true,
    platformDefault: () => false,
    enforcement: 'behavioral',
    enforcementNote:
      'Read at session provisioning (projects/lib/genui-env.ts → KORTIX_GENUI). An in-place restart keeps the sandbox env, so a running or restarted session keeps its prompt until a new session starts. The API kill switch GENUI_ENABLED=false forces it off for every project.',
    // Hidden until web renders blocks (plan-4 Task 8 removes this line).
    catalogHidden: true,
  },
```

- [ ] **Step 5: Web hook and translations**

`packages/ui/src/internal/lib/use-project-feature-flags.ts`: add `const genui = useFeatureFlag(projectId, 'genui');` after the `piHarness` line, add `genui: genui.enabled,` to the returned map, and move the trailing `isLoading:` so it reads from the newly-last hook (`isLoading: genui.isLoading,` if `genui` is now last).

In each of the 9 `apps/web/translations/*.json` files, add next to `"pi_harness"`:

```json
"genui": {
  "name": "Generative UI",
  "description": "The agent may answer with cards, comparisons, charts, maps, and tabs instead of long text."
},
```

Use the English text in all 9 files for now; the existing translation workflow localizes it (the same as other recently added flags — check `git log -p --follow apps/web/translations/de.json | rg -m1 -B2 -A4 pi_harness` to confirm the convention before writing).

- [ ] **Step 6: Run the flag tests to verify they pass**

```bash
cd packages/api-contract && bun test src/__tests__/schemas.test.ts
cd ../sdk && bun test src/core/rest/projects-client/projects.test.ts
cd ../../apps/api && bun test src/__tests__/unit-feature-flag-drift.test.ts src/__tests__/unit-feature-flags.test.ts
cd ../web && bun test src/lib/menu-registry.flags.test.ts src/i18n/i18n-complete.test.tsx
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/api-contract packages/sdk/src/core/rest/projects-client apps/api/src/feature-flags packages/ui/src/internal/lib/use-project-feature-flags.ts apps/web/translations
git commit -m "feat(flags): add the genui project flag (hidden, default off)"
```

---

### Task 2: Kill switch and the `KORTIX_GENUI` sandbox env

**Files:**
- Modify: `apps/api/src/config.ts` (next to `SESSION_TITLE_GENERATION_ENABLED`, ~L285)
- Create: `apps/api/src/projects/lib/genui-env.ts`
- Test: `apps/api/src/projects/lib/genui-env.test.ts`
- Modify: `apps/api/src/projects/lib/session-sandbox-env-build.ts` (`buildSessionSandboxEnvVars` return, ~L403-410)
- Modify: `apps/api/package.json` (dependencies)

**Interfaces:**
- Consumes: `resolveFeatureFlag(metadata, 'genui')` (Task 1).
- Produces: `GENUI_ENV_NAME = 'KORTIX_GENUI'`, `genuiEnvValue(metadata: unknown, enabled?: boolean): '1' | '0'`, `buildGenuiSandboxEnv(projectId: string): Promise<Record<string, string>>`; config `GENUI_ENABLED: boolean` (default true).

- [ ] **Step 1: Write the failing test**

`apps/api/src/projects/lib/genui-env.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { GENUI_ENV_NAME, genuiEnvValue } from './genui-env';

const on = { experimental: { genui: true } };
const off = { experimental: { genui: false } };

describe('genuiEnvValue', () => {
  test('flag on and kill switch open ⇒ 1', () => {
    expect(genuiEnvValue(on, true)).toBe('1');
  });
  test('flag off ⇒ 0', () => {
    expect(genuiEnvValue(off, true)).toBe('0');
  });
  test('no flag set ⇒ platform default (off) ⇒ 0', () => {
    expect(genuiEnvValue({}, true)).toBe('0');
    expect(genuiEnvValue(null, true)).toBe('0');
  });
  test('kill switch closed ⇒ 0 even with the flag on', () => {
    expect(genuiEnvValue(on, false)).toBe('0');
  });
  test('env name is the one kortixd reads', () => {
    expect(GENUI_ENV_NAME).toBe('KORTIX_GENUI');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bun test src/projects/lib/genui-env.test.ts`
Expected: FAIL — `Cannot find module './genui-env'`.

- [ ] **Step 3: Add the kill switch**

`apps/api/src/config.ts`, next to `SESSION_TITLE_GENERATION_ENABLED: optBoolTrue,`:

```ts
  // Generative UI kill switch. On by default; false ⇒ no session is taught the genui catalog,
  // whatever the project flag says. Blocks already in transcripts still render.
  GENUI_ENABLED: optBoolTrue,
```

- [ ] **Step 4: Write the helper**

`apps/api/src/projects/lib/genui-env.ts`:

```ts
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { config } from '../../config';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { db } from '../../shared/db';

/** Read by kortixd. Boot-only. */
export const GENUI_ENV_NAME = 'KORTIX_GENUI';

/** '1' only when the kill switch is open and the project flag is on. */
export function genuiEnvValue(metadata: unknown, enabled: boolean = config.GENUI_ENABLED): '1' | '0' {
  return enabled && resolveFeatureFlag(metadata, 'genui') ? '1' : '0';
}

export async function buildGenuiSandboxEnv(projectId: string): Promise<Record<string, string>> {
  const [row] = await db
    .select({ metadata: projects.metadata })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  return { [GENUI_ENV_NAME]: genuiEnvValue(row?.metadata) };
}
```

- [ ] **Step 5: Wire it into provisioning**

In `apps/api/src/projects/lib/session-sandbox-env-build.ts`, add the import next to the other `./` imports:

```ts
import { buildGenuiSandboxEnv } from './genui-env';
```

and in `buildSessionSandboxEnvVars`, next to `const sessionContextEnv = await buildSessionRuntimeContextEnv(input.sessionId);`:

```ts
  const genuiEnv = await buildGenuiSandboxEnv(input.projectId);
```

then spread it in the returned object after `...sessionContextEnv,`:

```ts
    ...genuiEnv,
```

Add to `apps/api/package.json` dependencies: `"@openuidev/lang-core": "0.3.1"`, and change `"zod": "^3.23.0"` to `"zod": "^3.25.0"` (`zod/v4` exists from 3.25; the lockfile already resolves 3.25.76). Run `pnpm install --filter kortix-api`.

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd apps/api && bun test src/projects/lib/genui-env.test.ts src/projects/lib/session-runtime-context.test.ts
pnpm --filter kortix-api lint
```

Expected: PASS; lint clean (no new suppressions).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/config.ts apps/api/src/projects/lib/genui-env.ts apps/api/src/projects/lib/genui-env.test.ts apps/api/src/projects/lib/session-sandbox-env-build.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): resolve the genui flag and kill switch into KORTIX_GENUI"
```

---

### Tasks 3 and 4: prompt injection (removed)

These tasks wrote the catalog into the prompt: an instruction file for the
OpenCode adapter (`harness/open-code/`, deleted on 2026-10-30) and a section of
pi's system prompt. The `kortix-genui` managed system skill replaced both on
2026-10-13 (rule 4 in `../SKILL.md`). Their steps are removed from this plan.

---

### Task 5: Channel and CLI guards

**Files:**
- Modify: `apps/api/src/projects/routes/turn-stream-handlers.ts` (`relayContent`, ~L540)
- Test: `apps/api/src/__tests__/unit-genui-relay.test.ts`
- Modify: `apps/cli/src/commands/sessions-chat.ts` (`partToText`, ~L106-112)
- Test: `apps/cli/src/commands/sessions-chat.genui.test.ts`
- Modify: `apps/cli/package.json`

**Interfaces:**
- Consumes: `genuiToMarkdown` (plan-1).
- Produces: `relayAnswerText(raw: string | undefined): string` exported from `turn-stream-handlers.ts`.

The agent sends Slack and Teams text only through explicit `slack send` / `teams send`, and the prompt forbids blocks there (rule 6). This guard covers the model breaking that rule. `markdownToMrkdwn` would otherwise post the block as a code sample.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/__tests__/unit-genui-relay.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { relayAnswerText } from '../projects/routes/turn-stream-handlers';

describe('relayAnswerText', () => {
  test('converts openui blocks to markdown before Slack/Teams formatting', () => {
    const text = relayAnswerText('Done.\n\n```openui\nroot = Stack([b])\nb = Badge("shipped")\n```\n');
    expect(text).toBe('Done.\n\n[shipped]');
  });
  test('plain text is trimmed and otherwise unchanged', () => {
    expect(relayAnswerText('  hello  ')).toBe('hello');
    expect(relayAnswerText(undefined)).toBe('');
  });
});
```

`apps/cli/src/commands/sessions-chat.genui.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { extractMessageText } from './sessions-chat';

describe('extractMessageText', () => {
  test('prints openui blocks as markdown', () => {
    const msg = {
      info: { id: 'm1', role: 'assistant' },
      parts: [{ id: 'p1', type: 'text', text: 'Here.\n\n```openui\nroot = Stack([b])\nb = Badge("ok")\n```' }],
    } as unknown as Parameters<typeof extractMessageText>[0];
    expect(extractMessageText(msg)).toBe('Here.\n\n[ok]');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && bun test src/__tests__/unit-genui-relay.test.ts` and `cd apps/cli && bun test src/commands/sessions-chat.genui.test.ts`
Expected: API FAIL — `relayAnswerText` not exported; CLI FAIL — output contains `root = Stack`.

- [ ] **Step 3: Implement**

In `turn-stream-handlers.ts`, add near the top-level helpers:

```ts
import { genuiToMarkdown } from '@kortix/sdk/genui';

/** Text relayed to Slack/Teams. Generative UI blocks become markdown first. */
export function relayAnswerText(raw: string | undefined): string {
  return genuiToMarkdown((raw ?? '').trim());
}
```

and in `relayContent` (~L540) replace `const text = (body.text ?? '').trim();` with:

```ts
  const text = relayAnswerText(body.text);
```

In `apps/cli/src/commands/sessions-chat.ts` `partToText`, replace `return (part as { text: string }).text;` with:

```ts
    return genuiToMarkdown((part as { text: string }).text);
```

and add `import { genuiToMarkdown } from '@kortix/sdk/genui';` next to the other `@kortix/sdk` imports. `messageToJson` (`--json`, ~L763) keeps raw text: JSON output is for programs, which can call `genuiToMarkdown` themselves.

Add to `apps/cli/package.json` dependencies: `"@openuidev/lang-core": "0.3.1"`, `"zod": "^3.25.0"`. Run `pnpm install --filter @kortix/cli`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && bun test src/__tests__/unit-genui-relay.test.ts && pnpm --filter kortix-api lint
cd ../cli && pnpm test
```

Expected: PASS; lint clean; CLI suite (including `lint:sdk-boundary`) green.

- [ ] **Step 5: Verify the runtime end to end on the worktree stack**

1. `pnpm worktree start genui` in the background; wait for `curl -s localhost:20908/v1/health`.
2. Seed a user and token (CLAUDE.md "Authenticating to the live API"), create a project, and turn the flag on with the same API call the settings page uses (`PATCH` the project's experimental flags — read the route from `packages/ui/src/internal/lib/use-project-feature-flags.ts`' SDK call).
3. Start a session; in the sandbox, run `cat /tmp/kortix/genui.md | head -3` through the session's terminal or `kortix` CLI. Expected: the file exists and starts with `# Generative UI`.
4. Send `Compare these two plans: Basic 10 USD with 3 projects; Pro 30 USD with unlimited projects.` Expected: the stored assistant text contains ```` ```openui ````.
5. Send `hi`. Expected: no ```` ```openui ````.
6. Turn the flag off, start a new session (an in-place restart keeps the old env). Expected: `/tmp/kortix/genui.md` does not exist; a comparison prompt returns markdown only.
7. Repeat steps 3–5 once with the project on pi (`pi_harness` on).

Record the commands and outputs in the PR body.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/projects/routes/turn-stream-handlers.ts apps/api/src/__tests__/unit-genui-relay.test.ts apps/cli pnpm-lock.yaml
git commit -m "feat(genui): never relay or print OpenUI source"
```
