import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Glob } from 'bun';
import {
  type TriggerRuntimeCatalogStore,
  reconcileProjectTriggerRuntimeWithStore,
} from './trigger-runtime-catalog-core';
import { triggerScheduleRevision } from './trigger-schedule';
import type { GitTriggerSpec } from './triggers';

function trigger(slug: string, pinnedSessionId: string | null = null): GitTriggerSpec {
  return {
    slug,
    path: `kortix.yaml#triggers.${slug}`,
    name: slug,
    type: 'cron',
    agent: 'kortix',
    model: null,
    enabled: true,
    promptTemplate: 'Run',
    cron: '* * * * *',
    runAt: null,
    timezone: 'UTC',
    secretEnv: null,
    sessionMode: pinnedSessionId ? 'pinned' : 'fresh',
    pinnedSessionId,
    sessionKey: null,
    filter: null,
  };
}

describe('reconcileProjectTriggerRuntime', () => {
  test('upserts every readable trigger and removes only proven stale rows', async () => {
    const upserted: Array<{ slug: string; sessionId: string | null }> = [];
    const removed: string[] = [];
    const store: TriggerRuntimeCatalogStore = {
      list: async () => [
        {
          slug: 'keep',
          sessionId: null,
          scheduleRevision: triggerScheduleRevision(trigger('keep')),
        },
        { slug: 'stale' },
      ],
      upsert: async (_projectId, spec) => {
        upserted.push({ slug: spec.slug, sessionId: spec.pinnedSessionId });
      },
      remove: async (_projectId, slug) => {
        removed.push(slug);
      },
    };

    const result = await reconcileProjectTriggerRuntimeWithStore(
      'project-1',
      [trigger('keep'), trigger('new-pinned', 'session-1')],
      store,
    );

    expect(upserted).toEqual([{ slug: 'new-pinned', sessionId: 'session-1' }]);
    expect(removed).toEqual(['stale']);
    expect(result).toEqual({ upserted: 1, removed: 1 });
  });

  test('removes all rows when a readable manifest declares no triggers', async () => {
    const removed: string[] = [];
    const store: TriggerRuntimeCatalogStore = {
      list: async () => [{ slug: 'existing' }],
      upsert: async () => {},
      remove: async (_projectId, slug) => {
        removed.push(slug);
      },
    };

    await expect(reconcileProjectTriggerRuntimeWithStore('project-1', [], store)).resolves.toEqual({
      upserted: 0,
      removed: 1,
    });
    expect(removed).toEqual(['existing']);
  });

  // Regression guard for the merge with main's exact-slot scheduler. The
  // runtime catalog became the fire registry, and reconcile REMOVES any row
  // whose slug is absent from the specs it is handed. A caller that reads the
  // manifest without the `goals` opt-in therefore does not merely fail to
  // register goal triggers — it deletes the ones another caller registered, so
  // a `goals:` block flickers in on a UI read and is reaped by the next sweep.
  // This asserts the destructive half directly, so any future caller that
  // forgets the opt-in fails here instead of in production.
  test('a goal-derived trigger absent from the declared specs is REMOVED', async () => {
    const removed: string[] = [];
    const store: TriggerRuntimeCatalogStore = {
      list: async () => [{ slug: 'goal-platinum-seo' }, { slug: 'nightly' }],
      upsert: async () => {},
      remove: async (_projectId, slug) => {
        removed.push(slug);
      },
    };

    // What a goals-less `extractTriggers(manifest)` hands in: authored only.
    await reconcileProjectTriggerRuntimeWithStore('project-1', [trigger('nightly')], store);
    expect(removed).toEqual(['goal-platinum-seo']);
  });

  test('the same goal trigger survives when the specs include it', async () => {
    const removed: string[] = [];
    const store: TriggerRuntimeCatalogStore = {
      list: async () => [{ slug: 'goal-platinum-seo' }, { slug: 'nightly' }],
      upsert: async () => {},
      remove: async (_projectId, slug) => {
        removed.push(slug);
      },
    };

    await reconcileProjectTriggerRuntimeWithStore(
      'project-1',
      [trigger('nightly'), trigger('goal-platinum-seo')],
      store,
    );
    expect(removed).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The caller-side guard.
//
// The two tests above assert the destructive SEMANTICS of reconcile: a slug
// absent from the specs it is handed gets deleted. What they cannot catch is the
// bug the merge with main actually shipped — a CALLER that reads the manifest
// without the `{ goals }` opt-in. executor/sync.ts did exactly that, so goal
// rows created by a UI read (`loadTriggersForResponse`) were reaped by the next
// connector sweep and a `goals:` block flickered in and vanished again. Every
// existing test still passed, because every existing test hands reconcile its
// specs directly.
//
// So this guard reasons about the SOURCE. It finds every call to
// `reconcileProjectTriggerRuntime` anywhere under apps/api/src — including in
// files that do not exist yet — and traces the specs argument back to the
// `extractTriggers` call that produced it, demanding the goals option.
//
// Deliberately fails on "cannot prove", not just on "proved wrong": a call site
// written in a shape this analyzer does not recognize is reported as a failure,
// so the author must either add the opt-in or teach the analyzer. A guard that
// silently skips what it does not understand is the guard that let sync.ts
// through in the first place.
//
// Why not an executor/sync.ts integration test instead: `syncProjectConnectors`
// reads projects from the live DB, clones through the git proxy, and calls
// Pipedream — there is no seam to inject a manifest or a fake catalog store, and
// no fixture harness for one (see this task's blockers). A test built on mocks
// that do not exist would only look like coverage.

const API_SRC = resolve(import.meta.dir, '..');

/** Argument text between the parens opening at `open`, honoring nesting and
 *  string literals. */
function argsAt(source: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced parentheses');
}

/** Split an argument list on its top-level commas. */
function topLevelArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(args.slice(start, i));
      start = i + 1;
    }
  }
  out.push(args.slice(start));
  return out.map((a) => a.trim()).filter((a) => a.length > 0);
}

/** Every right-hand side assigned to `name` in `source`, including via an
 *  object-destructuring binding. */
function bindingsOf(source: string, name: string): string[] {
  const escaped = name.replace(/[$]/g, '\\$');
  const patterns = [
    // const { specs, errors } = loaded;
    new RegExp(String.raw`(?:const|let|var)\s*\{[^}]*\b${escaped}\b[^}]*\}\s*=\s*([^;\n]+)`, 'g'),
    // const triggers = ...;  |  loaded = ...;
    new RegExp(String.raw`\b${escaped}\b(?::[^=;\n]+)?\s*=\s*([\s\S]+?);`, 'g'),
  ];
  const out: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) out.push(match[1].trim());
  }
  return out;
}

type Verdict = { ok: true; via: string } | { ok: false; reason: string };

/** Does `expr` — the specs argument of a reconcile call — provably come from an
 *  `extractTriggers` that was given the goals option? */
function provesGoalsOptIn(source: string, expr: string, depth = 0): Verdict {
  if (depth > 4) return { ok: false, reason: `assignment chain too deep to trace: "${expr}"` };

  if (expr.includes('extractTriggers')) {
    return /extractTriggers\s*\([^;]*\bgoals\b/.test(expr)
      ? { ok: true, via: expr }
      : { ok: false, reason: `builds specs from extractTriggers WITHOUT { goals }: "${expr}"` };
  }

  const ident = expr.replace(/\.specs$/, '').trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(ident)) {
    return {
      ok: false,
      reason: `specs argument is neither an extractTriggers call nor a traceable identifier: "${expr}"`,
    };
  }

  const rhss = bindingsOf(source, ident);
  if (rhss.length === 0) return { ok: false, reason: `cannot find where "${ident}" is bound` };

  let reached: string | null = null;
  for (const rhs of rhss) {
    const traceable = rhs.includes('extractTriggers') || /^[A-Za-z_$][\w$]*$/.test(rhs);
    // A literal that reaches no extractTriggers at all is the unreadable-manifest
    // fallback (`{ specs: [], errors: [...] }`) — it declares nothing, so it
    // cannot lose a goal trigger.
    if (!traceable) continue;
    const verdict = provesGoalsOptIn(source, rhs, depth + 1);
    if (!verdict.ok) return verdict;
    reached = verdict.via;
  }
  return reached
    ? { ok: true, via: reached }
    : { ok: false, reason: `nothing assigned to "${ident}" traces back to extractTriggers` };
}

interface CallSite {
  file: string;
  line: number;
  specsExpr: string;
}

function reconcileCallSites(source: string, file: string): CallSite[] {
  const sites: CallSite[] = [];
  for (const match of source.matchAll(/reconcileProjectTriggerRuntime\s*\(/g)) {
    const at = match.index ?? 0;
    // Skip the declaration itself and any import/re-export mention.
    const before = source.slice(Math.max(0, at - 40), at);
    if (/\bfunction\s+$/.test(before)) continue;
    const open = at + match[0].length - 1;
    const args = topLevelArgs(argsAt(source, open));
    sites.push({
      file,
      line: source.slice(0, at).split('\n').length,
      // arg 0 is the project id; arg 1 is the specs; arg 2 (optional) is the store.
      specsExpr: (args[1] ?? '').replace(/\s+/g, ' ').trim(),
    });
  }
  return sites;
}

describe('every reconcileProjectTriggerRuntime caller opts into goal-derived specs', () => {
  const files = [...new Glob('**/*.ts').scanSync({ cwd: API_SRC })].filter(
    (f) => !f.endsWith('.test.ts'),
  );

  const sites = files.flatMap((f) =>
    reconcileCallSites(readFileSync(resolve(API_SRC, f), 'utf8'), f).map((s) => ({
      ...s,
      source: readFileSync(resolve(API_SRC, f), 'utf8'),
    })),
  );

  test('the scan actually found the known call sites', () => {
    // If this drops to zero the guard below passes vacuously — which is exactly
    // the failure mode a source-level check has to rule out first.
    expect(sites.length).toBeGreaterThanOrEqual(4);
    expect(new Set(sites.map((s) => s.file))).toEqual(
      new Set(['projects/lib/triggers.ts', 'projects/routes/r4.ts', 'executor/sync.ts']),
    );
  });

  for (const site of sites) {
    test(`${site.file}:${site.line} passes goals-aware specs`, () => {
      const verdict = provesGoalsOptIn(site.source, site.specsExpr);
      // The message is the whole value of this test: it has to tell the author
      // what to add, not just that something is wrong.
      expect(
        verdict.ok,
        verdict.ok
          ? ''
          : `${site.file}:${site.line} — ${verdict.reason}. reconcile DELETES any catalog row whose slug is absent from the specs it is handed, so a goals-less read reaps every goal-derived trigger in the project. Pass extractTriggers(manifest, { goals: goalTriggersEnabled(<project>.metadata) }).specs.`,
      ).toBe(true);
    });
  }

  // Positive controls. Without these the analyzer could be vacuously green —
  // "returns ok for everything" and "returns ok for the four real call sites"
  // are indistinguishable otherwise.
  test('the analyzer REJECTS the exact regression the merge shipped', () => {
    // executor/sync.ts as it stood: manifest read with no opt-in, specs handed
    // straight to reconcile.
    const regressed = `
      const triggers = extractTriggers(manifest);
      await reconcileProjectTriggerRuntime(projectId, triggers.specs);
    `;
    const verdict = provesGoalsOptIn(regressed, 'triggers.specs');
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.reason).toContain('WITHOUT { goals }');
  });

  test('the analyzer REJECTS an inline goals-less read', () => {
    const inline = 'extractTriggers(next).specs';
    expect(provesGoalsOptIn('', inline).ok).toBe(false);
  });

  test('the analyzer REJECTS a specs argument it cannot trace, rather than assuming it is fine', () => {
    expect(provesGoalsOptIn('const rows = await somethingElse();', 'rows').ok).toBe(false);
    expect(provesGoalsOptIn('', 'someHelper(manifest)').ok).toBe(false);
  });

  test('the analyzer ACCEPTS both shapes the real call sites use', () => {
    expect(provesGoalsOptIn('', 'extractTriggers(next, { goals: enabled(m) }).specs').ok).toBe(
      true,
    );
    // The indirect shape: destructured out of a ternary two hops away.
    const indirect = `
      let loaded: LoadedTriggers;
      try {
        loaded = manifest ? extractTriggers(manifest, { goals }) : { specs: [], errors: [] };
      } catch (error) {
        loaded = { specs: [], errors: [{ slug: '(manifest)', error: 'x' }] };
      }
      const { specs, errors } = loaded;
    `;
    expect(provesGoalsOptIn(indirect, 'specs').ok).toBe(true);
  });
});
