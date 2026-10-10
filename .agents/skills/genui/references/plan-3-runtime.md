# Generative UI — plan 3: project flag, kill switch, prompt injection, channel guards

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Load the **testing** skill before Task 1.

**Goal:** A project owner turns on `genui`; every new session of that project (and any session rebuilt from scratch) teaches the agent the catalog on both harnesses; with the flag off, nothing about a session changes; no chat channel or CLI output ever shows OpenUI source.

**Architecture:** The API resolves `genui` (project flag AND the `GENUI_ENABLED` kill switch) into one sandbox env var, `KORTIX_GENUI=1|0`, at provisioning. kortixd turns `KORTIX_GENUI=1` into the prompt text from `buildGenuiPrompt()`: on OpenCode as an instruction file appended to `instructions`, on pi as a section of the root agent's `systemPrompt()`. Slack/Teams relay text and CLI output pass through `genuiToMarkdown`.

**Tech Stack:** Hono API (`apps/api`), kortixd (`apps/kortix-sandbox-agent-server`, Bun, no-semicolon style), `@kortix/sdk/genui`, Bun test.

**Spec:** `.agents/skills/genui/references/spec.md` §4 (stories 8, 12, 13), §5.4, §8.1 R-FLAG-1, R-CHAN-1. Master plan: `plan.md` (deltas D5, D6).

**Depends on:** plan-1 merged into the branch (`@kortix/sdk/genui`), plan-2 decision GO.

## Global Constraints

See `plan.md`. Specific to this plan:
- `process.env` is read only in `apps/api/src/config.ts` (API lint rule).
- The literal `KORTIX_GENUI` appears in exactly two files: `apps/api/src/projects/lib/genui-env.ts` and `apps/kortix-sandbox-agent-server/src/services/sandbox-env/genui-instruction.ts`.
- The flag is boot-only: it is read at provisioning, and an in-place restart keeps the sandbox env, so a running or restarted session keeps its prompt until a new session starts. Do not add `KORTIX_GENUI` to `OPENCODE_RUNTIME_ENV_NAMES` or pi `RUNTIME_ENV_NAMES`.
- Flag off ⇒ the composed OpenCode config and the pi system prompt are byte-for-byte what they are on `dev` today (spec R-FLAG-1, snapshot-asserted in Tasks 3 and 4).

## Review Focus

- A sandbox that was provisioned with the flag on, then restarted with the flag off, still has `/tmp/kortix/genui.md` from the earlier boot → the OpenCode instruction must disappear. Pinned in Task 3 ("flag off removes a stale file").
- `KORTIX_GENUI` missing entirely (old API, new kortixd) → treated as off. Pinned in Task 3 (`genuiEnabled({})`).

---

### Task 1: The `genui` project flag (7 sites)

**Files:**
- Modify: `packages/api-contract/src/index.ts` (`FeatureFlagMapSchema`, ~L55-68)
- Modify: `packages/api-contract/src/__tests__/schemas.test.ts` (fixture ~L147, key list ~L749)
- Modify: `packages/sdk/src/core/rest/projects-client/projects.ts` (`FeatureFlagKey` union ~L64, `FEATURE_FLAG_KEYS` ~L102)
- Modify: `packages/sdk/src/core/rest/projects-client/projects.test.ts` (~L976)
- Modify: `apps/api/src/feature-flags/registry.ts` (new entry after `pi_harness`, ~L322)
- Modify: `apps/web/src/lib/use-project-feature-flags.ts` (~L42, ~L60, trailing `isLoading`)
- Modify: `apps/web/translations/{en,de,es,fr,it,ja,pt,sr,zh}.json` (next to `"pi_harness"`, en ~L1007)

**Interfaces:**
- Produces: `FeatureFlagKey` includes `'genui'`; `resolveFeatureFlag(metadata, 'genui'): boolean`; web `useProjectFeatureFlags(projectId).genui: boolean`.

- [ ] **Step 1: List every holder before editing (registry header instruction)**

Run: `rg -l "meta_agent" --glob '!node_modules' . | xargs rg -l "pi_harness"`
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

`apps/web/src/lib/use-project-feature-flags.ts`: add `const genui = useFeatureFlag(projectId, 'genui');` after the `piHarness` line, add `genui: genui.enabled,` to the returned map, and move the trailing `isLoading:` so it reads from the newly-last hook (`isLoading: genui.isLoading,` if `genui` is now last).

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
git add packages/api-contract packages/sdk/src/core/rest/projects-client apps/api/src/feature-flags apps/web/src/lib/use-project-feature-flags.ts apps/web/translations
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

/** Read by kortixd (services/sandbox-env/genui-instruction.ts). Boot-only. */
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

### Task 3: kortixd — instruction file for OpenCode

**Files:**
- Create: `apps/kortix-sandbox-agent-server/src/services/sandbox-env/genui-instruction.ts`
- Test: `apps/kortix-sandbox-agent-server/src/__tests__/genui-instruction.test.ts`
- Modify: `apps/kortix-sandbox-agent-server/src/harness/open-code/lifecycle.ts` (`buildOpencodeConfigContent` options ~L375 and existence check ~L420-423; instruction loop ~L484-492; `writeComposedConfig` ~L2064-2085; option threading ~L1001/L1020)
- Modify: `apps/kortix-sandbox-agent-server/src/__tests__/opencode-config-composition.test.ts`
- Modify: `apps/kortix-sandbox-agent-server/package.json`

**Interfaces:**
- Consumes: `buildGenuiPrompt` from `@kortix/sdk/genui`.
- Produces: `GENUI_INSTRUCTION_PATH = '/tmp/kortix/genui.md'`, `genuiEnabled(env): boolean`, `genuiPromptText(): string` (memoized), `writeGenuiInstruction(env, path?): string | null`; `buildOpencodeConfigContent` option `genuiInstructionPath?: string | null`.

- [ ] **Step 1: Write the failing test**

`apps/kortix-sandbox-agent-server/src/__tests__/genui-instruction.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { genuiEnabled, genuiPromptText, writeGenuiInstruction } from '@/services/sandbox-env/genui-instruction'

const dir = () => mkdtempSync(join(tmpdir(), 'genui-'))

describe('genui instruction', () => {
  test('only KORTIX_GENUI=1 enables it; missing means off', () => {
    expect(genuiEnabled({ KORTIX_GENUI: '1' })).toBe(true)
    expect(genuiEnabled({ KORTIX_GENUI: '0' })).toBe(false)
    expect(genuiEnabled({})).toBe(false)
  })

  test('flag on writes the generated prompt', () => {
    const path = join(dir(), 'genui.md')
    expect(writeGenuiInstruction({ KORTIX_GENUI: '1' }, path)).toBe(path)
    const text = readFileSync(path, 'utf8')
    expect(text).toBe(genuiPromptText())
    expect(text).toContain('```openui')
  })

  test('flag off removes a stale file from an earlier boot', () => {
    const path = join(dir(), 'genui.md')
    writeFileSync(path, 'stale')
    expect(writeGenuiInstruction({ KORTIX_GENUI: '0' }, path)).toBeNull()
    expect(existsSync(path)).toBe(false)
  })

  test('the prompt text is computed once', () => {
    expect(genuiPromptText()).toBe(genuiPromptText())
  })
})
```

In `apps/kortix-sandbox-agent-server/src/__tests__/opencode-config-composition.test.ts`, add next to the existing `secretCapabilitiesInstructionPath` case (~L91), using the same env fixture that case uses:

```ts
  test('appends the genui instruction only when its file exists', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'genui-')), 'genui.md')
    writeFileSync(file, 'genui')
    const withFile = JSON.parse(buildOpencodeConfigContent(env, { genuiInstructionPath: file }))
    expect(withFile.instructions).toContain(file)
    const without = JSON.parse(buildOpencodeConfigContent(env, { genuiInstructionPath: null }))
    expect(without.instructions ?? []).not.toContain(file)
    // Flag off ⇒ the composed config is identical to a config built without the option (spec R-FLAG-1).
    expect(buildOpencodeConfigContent(env, { genuiInstructionPath: null })).toBe(buildOpencodeConfigContent(env, {}))
  })
```

(If `buildOpencodeConfigContent` returns an object rather than a string in this file's existing cases, drop the `JSON.parse` and compare with `toEqual`, matching the existing case.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter kortixd test -- src/__tests__/genui-instruction.test.ts src/__tests__/opencode-config-composition.test.ts`
Expected: FAIL — module `@/services/sandbox-env/genui-instruction` not found; unknown option `genuiInstructionPath`.

- [ ] **Step 3: Write the helper**

`apps/kortix-sandbox-agent-server/src/services/sandbox-env/genui-instruction.ts`:

```ts
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { buildGenuiPrompt } from '@kortix/sdk/genui'

/** Set by the API (projects/lib/genui-env.ts) at provisioning. Boot-only. */
export const GENUI_ENV_NAME = 'KORTIX_GENUI'
export const GENUI_INSTRUCTION_PATH = '/tmp/kortix/genui.md'

let promptText: string | null = null

export function genuiEnabled(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  return env[GENUI_ENV_NAME] === '1'
}

/** The generated catalog prompt, computed once per process. */
export function genuiPromptText(): string {
  promptText ??= buildGenuiPrompt()
  return promptText
}

/**
 * Flag on: write the prompt atomically and return the path. Flag off: remove any file an earlier
 * boot of this sandbox left behind, and return null, so OpenCode never reads a stale instruction.
 */
export function writeGenuiInstruction(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  path = GENUI_INSTRUCTION_PATH,
): string | null {
  if (!genuiEnabled(env)) {
    rmSync(path, { force: true })
    return null
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, genuiPromptText(), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
  return path
}
```

Add to `apps/kortix-sandbox-agent-server/package.json` dependencies: `"@kortix/sdk": "workspace:*"` and `"@openuidev/lang-core": "0.3.1"` (zod is already a dependency). Run `pnpm install --filter kortixd`.

- [ ] **Step 4: Thread the option through the OpenCode config**

In `lifecycle.ts`:

1. In the options type of `buildOpencodeConfigContent` (~L375), next to `secretCapabilitiesInstructionPath?: string | null`, add:

```ts
  genuiInstructionPath?: string | null
```

2. Next to the existence check for the secret-capabilities path (~L420-423), add the same check:

```ts
  const genuiInstructionPath =
    opts.genuiInstructionPath && existsSync(opts.genuiInstructionPath) ? opts.genuiInstructionPath : null
```

3. In the instruction loop (~L486), extend the list:

```ts
  for (const instructionPath of [secretCapabilitiesInstructionPath, opts.configReleaseNoticePath, genuiInstructionPath]) {
```

4. In `writeComposedConfig` (~L2064-2085), after the `writeSecretCapabilitiesInstruction(baseEnv)` try/catch, add:

```ts
  let genuiInstructionPath: string | null = null
  try {
    genuiInstructionPath = writeGenuiInstruction(baseEnv)
  } catch (error) {
    logger.warn('[opencode] genui instruction write failed; sessions start without generative UI', { error })
  }
```

and pass `genuiInstructionPath` in the options object given to `writeKortixOpencodeConfig`. If `writeKortixOpencodeConfig` copies fields one by one into `buildOpencodeConfigContent` (~L1001/L1020), add `genuiInstructionPath: opts.genuiInstructionPath` there too.

5. Import at the top, next to the secret-capabilities import (~L123):

```ts
import { writeGenuiInstruction } from '@/services/sandbox-env/genui-instruction'
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter kortixd test -- src/__tests__/genui-instruction.test.ts src/__tests__/opencode-config-composition.test.ts src/__tests__/runtime-env-allowlist-completeness.test.ts
cd apps/kortix-sandbox-agent-server && bun tsc --noEmit
```

Expected: PASS; typecheck exit 0. The allowlist test stays green because `lifecycle.ts` never reads `env.KORTIX_GENUI` directly.

- [ ] **Step 6: Commit**

```bash
git add apps/kortix-sandbox-agent-server pnpm-lock.yaml
git commit -m "feat(kortixd): teach OpenCode sessions the genui catalog when KORTIX_GENUI=1"
```

---

### Task 4: kortixd — prompt section for pi

**Files:**
- Modify: `apps/kortix-sandbox-agent-server/src/harness/pi/runtime.ts` (`systemPrompt()`, ~L1484-1508; imports)
- Test: `apps/kortix-sandbox-agent-server/src/__tests__/genui-instruction.test.ts` (extend)

**Interfaces:**
- Consumes: `genuiEnabled`, `genuiPromptText` (Task 3).

pi reads instruction files but never writes them (only the OpenCode lifecycle writes `/tmp/kortix/*.md`), so pi gets the text directly instead of a file. Only the root agent gets it: a subagent's reply reaches the user through the parent, as text the parent rewrites.

- [ ] **Step 1: Write the failing test**

pi's `systemPrompt` is private. Test the exact rule it applies, as an exported pure function. Append to `genui-instruction.test.ts`:

```ts
import { genuiPromptSection } from '@/services/sandbox-env/genui-instruction'

describe('pi prompt section', () => {
  test('root agent with the flag on gets the catalog', () => {
    expect(genuiPromptSection({ KORTIX_GENUI: '1' }, false)).toBe(genuiPromptText())
  })
  test('subagents and flag-off sessions get nothing', () => {
    expect(genuiPromptSection({ KORTIX_GENUI: '1' }, true)).toBeNull()
    expect(genuiPromptSection({ KORTIX_GENUI: '0' }, false)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter kortixd test -- src/__tests__/genui-instruction.test.ts`
Expected: FAIL — `genuiPromptSection` is not exported.

- [ ] **Step 3: Implement**

Append to `genui-instruction.ts`:

```ts
/** pi: the catalog for the root agent when the flag is on; null for subagents and when off. */
export function genuiPromptSection(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  isChild: boolean,
): string | null {
  return !isChild && genuiEnabled(env) ? genuiPromptText() : null
}
```

In `pi/runtime.ts` `systemPrompt()`, after the secret-capabilities lines:

```ts
    const capabilities = this.readInstruction(SECRET_CAPABILITIES_INSTRUCTION_PATH)
    if (capabilities) parts.push(capabilities)
    const genui = genuiPromptSection(this.env, Boolean(child))
    if (genui) parts.push(genui)
```

and import next to the `SECRET_CAPABILITIES_INSTRUCTION_PATH` import (~L29):

```ts
import { genuiPromptSection } from '@/services/sandbox-env/genui-instruction'
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter kortixd test -- src/__tests__/genui-instruction.test.ts
pnpm --filter kortixd test
cd apps/kortix-sandbox-agent-server && bun tsc --noEmit
```

Expected: PASS; full kortixd suite green; typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/kortix-sandbox-agent-server
git commit -m "feat(kortixd): add the genui catalog to the pi root agent prompt"
```

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
2. Seed a user and token (CLAUDE.md "Authenticating to the live API"), create a project, and turn the flag on with the same API call the settings page uses (`PATCH` the project's experimental flags — read the route from `apps/web/src/lib/use-project-feature-flags.ts`' SDK call).
3. Start a session; in the sandbox, run `cat /tmp/kortix/genui.md | head -3` through the session's terminal or `kortix` CLI. Expected: the file exists and starts with `# Generative UI`.
4. Send `Compare these two plans: Basic 10 USD with 3 projects; Pro 30 USD with unlimited projects.` Expected: the stored assistant text contains ```` ```openui ````.
5. Send `hi`. Expected: no ```` ```openui ````.
6. Turn the flag off, start a new session (an in-place restart keeps the old env). Expected: `/tmp/kortix/genui.md` does not exist; a comparison prompt returns markdown only.
7. Repeat steps 3–5 once with the project on pi (`pi_harness` on, `llm_gateway` on).

Record the commands and outputs in the PR body.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/projects/routes/turn-stream-handlers.ts apps/api/src/__tests__/unit-genui-relay.test.ts apps/cli pnpm-lock.yaml
git commit -m "feat(genui): never relay or print OpenUI source"
```
