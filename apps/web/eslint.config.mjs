import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';
import { readFileSync } from 'node:fs';

const sdkBoundaryBaseline = JSON.parse(
  readFileSync(new URL('./src/sdk-boundary-baseline.json', import.meta.url), 'utf8'),
);
const sdkBoundaryLegacyFiles = [
  ...new Set(
    sdkBoundaryBaseline.map((entry) => {
      const [, file] = entry.split('\t');
      return `src/${file}`;
    }),
  ),
];
const sdkBoundaryShimFiles = ['src/lib/iam-client.ts'];

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'react/no-unescaped-entities': 'off',
      'react-hooks/exhaustive-deps': 'warn',
      '@next/next/no-img-element': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
      'prefer-const': 'warn',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'lucide-react',
                'lucide-react/*',
                'react-icons',
                'react-icons/*',
                '@mynaui/icons-react',
                '@mynaui/icons-react/*',
                '@icons-pack/react-simple-icons',
                '@icons-pack/react-simple-icons/*',
                '@hugeicons/react',
                '@hugeicons/react/*',
                '@hugeicons/core-free-icons',
                '@hugeicons/core-free-icons/*',
              ],
              message:
                'Icons come from @phosphor-icons/react. Global weight: src/lib/icons/icon-config.ts.',
            },
            {
              group: ['@phosphor-icons/react/dist/ssr', '@phosphor-icons/react/ssr'],
              message:
                "Server components import icons from '@/lib/icons/ssr' — those carry the app-wide weight. Phosphor's raw SSR entry silently defaults to 'regular'.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: [...sdkBoundaryLegacyFiles, ...sdkBoundaryShimFiles],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '*opencode*',
                '**/opencode*',
                '**/*opencode*',
                '@opencode-ai/sdk',
                '@opencode-ai/sdk/*',
              ],
              message: 'apps/web imports must use runtime-neutral @kortix/sdk surfaces.',
            },
            {
              group: [
                '@kortix/sdk/projects-client',
                '@kortix/sdk/platform-client',
                '@kortix/sdk/files',
                '@kortix/sdk/session',
                '@kortix/sdk/session/url',
                '@kortix/sdk/opencode-client',
                '@kortix/sdk/opencode-errors',
                '@kortix/sdk/event-stream',
                '@kortix/sdk/server-store',
                '@kortix/sdk/sync-store',
                '@kortix/sdk/sandbox-connection-store',
                '@kortix/sdk/opencode-pending-store',
                '@kortix/sdk/internal/*',
              ],
              message: 'Use the canonical @kortix/sdk or @kortix/sdk/react entry point.',
            },
            {
              group: [
                '@/hooks/opencode/*',
                '@/lib/opencode-sdk',
                '@/stores/server-store',
                '@/stores/opencode-*',
                '@/stores/pending-queue-store',
                '@/stores/pending-files-store',
              ],
              message: 'Runtime behavior belongs in @kortix/sdk, not apps/web.',
            },
            {
              group: ['@/lib/api', '@/lib/api/*', '@/lib/api-client', '**/api-client'],
              message: 'Kortix API access belongs in @kortix/sdk.',
            },
          ],
          paths: [
            {
              name: '@kortix/sdk',
              importNames: [
                'getClient',
                'getActiveOpenCodeUrl',
                'createKortixPty',
                'getKortixPtyWebSocketUrl',
                'removeKortixPty',
              ],
              message: 'Use the session-scoped @kortix/sdk facade or @kortix/sdk/react.',
            },
            {
              name: '@kortix/sdk/internal/server-store',
              importNames: ['getActiveOpenCodeUrl'],
              message: 'Runtime URL selection belongs in @kortix/sdk.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          // Scoped to the runtime SDK sources this guardrail actually cares
          // about (@kortix/sdk and anything opencode-named) — NOT every
          // import named "OpenCode" from anywhere. An earlier unscoped
          // version (`ImportSpecifier[imported.name=/OpenCode/i]`) also
          // fired on an unrelated brand-mark icon component imported from
          // '@/features/icon/icons/open-code', forcing it to export under a
          // confusing alias for no boundary-safety reason.
          selector:
            'ImportDeclaration[source.value=/(^@kortix\\/sdk(\\/|$))|opencode/i] > ImportSpecifier[imported.name=/OpenCode/i]',
          message: 'Import a runtime-neutral alias from @kortix/sdk.',
        },
        {
          // 176 hand-typed literals across 30 `project*` families produced
          // duplicate cache entries for one dataset (`['project-sessions',
          // id]` and `['project-session-inventory', id]` held the same
          // server response), silent write/read key mismatches, and
          // per-observer `staleTime` drift, because nothing forced two call
          // sites naming the same entity to agree on a key. This rule is
          // what makes the migration to `qk` permanent: a reintroduced
          // literal is a build failure, not something a reviewer has to
          // spot in a 100-file diff.
          //
          // The pattern matches the whole family rather than an allowlist,
          // so a NEW literal (`['project-widgets', id]`) is caught too.
          selector:
            "Property[key.name='queryKey'] > ArrayExpression > " +
            "Literal:first-child[value=/^projects?(-[a-z-]+)?$/]",
          message:
            'Query keys come from `qk` in @kortix/sdk/react. Never hand-type an entity key.',
        },
        {
          // Same as the rule above, but through a trailing `as const` —
          // THIS REPO'S OWN IDIOM (every `qk` member ends `as const`;
          // apps/web has 223 `] as const` sites). `as const` wraps the array
          // in a TSAsExpression, so `Property > ArrayExpression` never
          // matches: the array's immediate parent becomes the TSAsExpression,
          // not the Property. Probed directly against this rule set:
          // `queryKey: ['project-detail', id] as const` passed clean before
          // this selector existed. Same fix as the sibling `as const`
          // selectors below.
          selector:
            "Property[key.name='queryKey'] > TSAsExpression > ArrayExpression > " +
            "Literal:first-child[value=/^projects?(-[a-z-]+)?$/]",
          message:
            'Query keys come from `qk` in @kortix/sdk/react. Never hand-type an entity key.',
        },
        {
          // The migrated root itself is exactly as easy to hand-roll as the
          // literals above, and the rule above is blind to it: `'kx'` does
          // not match /^projects?(-[a-z-]+)?$/. qk.projects.scope() is
          // ['kx', 'projects'] and qk.project.scope(id) is ['kx', 'project',
          // id] (see packages/sdk/src/react/query-keys.ts) — three call
          // sites hand-typed ['kx', 'projects'] instead of calling the
          // factory, which is exactly the hole this closes.
          selector:
            "Property[key.name='queryKey'] > ArrayExpression > Literal:first-child[value='kx']",
          message:
            'Query keys come from `qk` in @kortix/sdk/react. Never hand-type an entity key.',
        },
        {
          // The `'kx'`-root rule's own `as const` blind spot — see the
          // family rule's `as const` sibling above for why the selector has
          // to change shape (TSAsExpression sits between the Property and
          // the ArrayExpression) rather than just widening a value pattern.
          selector:
            "Property[key.name='queryKey'] > TSAsExpression > ArrayExpression > " +
            "Literal:first-child[value='kx']",
          message:
            'Query keys come from `qk` in @kortix/sdk/react. Never hand-type an entity key.',
        },
        {
          // The four rules above only see a key written as the `queryKey:`
          // PROPERTY of an options object (`useQuery({ queryKey: [...] })`).
          // TanStack's direct cache API instead takes the key as a
          // positional first argument (`setQueryData(['project-detail',
          // id], data)`), which is structurally invisible to a
          // `Property[key.name='queryKey']` selector. That gap matters more
          // than the read side: a write parked on a key nobody reads is the
          // exact silent-failure class this migration exists to remove — a
          // stale `useQuery` observer never learns the write happened.
          // Covers every TanStack QueryClient method whose first positional
          // argument is (or can be) a query key.
          selector:
            "CallExpression[callee.property.name=/^(set|get)Quer(y|ies)Data$|^(remove|cancel|refetch|invalidate)Queries$/] > ArrayExpression:first-child > Literal:first-child[value=/^projects?(-[a-z-]+)?$|^kx$/]",
          message:
            'Query keys come from `qk` in @kortix/sdk/react. Never hand-type an entity key.',
        },
        {
          // The positional-call rule's own `as const` blind spot
          // (`setQueryData(['project-detail', id] as const, v)`) — same
          // TSAsExpression indirection, this time between the CallExpression
          // and its first-argument ArrayExpression instead of between a
          // Property and its value.
          selector:
            "CallExpression[callee.property.name=/^(set|get)Quer(y|ies)Data$|^(remove|cancel|refetch|invalidate)Queries$/] > TSAsExpression:first-child > ArrayExpression > Literal:first-child[value=/^projects?(-[a-z-]+)?$|^kx$/]",
          message:
            'Query keys come from `qk` in @kortix/sdk/react. Never hand-type an entity key.',
        },
      ],
    },
  },
  {
    /* The module that binds DEFAULT_ICON_WEIGHT onto the SSR icons, plus the
       test that checks the binding against the raw entry. Nothing else may
       reach past it. */
    files: ['src/lib/icons/ssr.tsx', 'src/lib/icons/ssr.test.tsx'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    /* fumadocs-mdx codegen output (gitignored, not tracked — see
       apps/web/.gitignore). It ships its own `@ts-nocheck` intentionally
       (skips type checking a generated re-export barrel) and is
       regenerated on every `next dev`/`next build`, so there is nothing to
       fix here; exclude it from linting entirely. */
    ignores: ['.source/**'],
  },
  {
    /* eslint-plugin-react-hooks@7 (pulled in by eslint-config-next@16's
       dependency bump) ships the "React Compiler" rule set enabled by
       default. As of 2026-08-04 that flags 402 pre-existing findings
       across 175 files in this codebase — none introduced by the Next 16
       upgrade. Downgraded to warnings here pending a dedicated audit; this
       is NOT a decision to accept them permanently. Breakdown at the time
       of downgrade:
       react-hooks/set-state-in-effect (211), react-hooks/refs (120),
       react-hooks/preserve-manual-memoization (21), react-hooks/purity (16),
       react-hooks/static-components (11), react-hooks/immutability (10),
       react-hooks/set-state-in-render (10), react-hooks/use-memo (2). */
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/set-state-in-render': 'warn',
      'react-hooks/use-memo': 'warn',
    },
  },
];

export default eslintConfig;
