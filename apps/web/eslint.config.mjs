import { readFileSync } from 'node:fs';
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

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
          selector: "ImportSpecifier[imported.name=/OpenCode/i]",
          message: 'Import a runtime-neutral alias from @kortix/sdk.',
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
];

export default eslintConfig;
