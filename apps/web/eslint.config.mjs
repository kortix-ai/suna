import { dirname } from 'path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

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

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'react/no-unescaped-entities': 'off',
      'react-hooks/exhaustive-deps': 'warn',
      '@next/next/no-img-element': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
      'prefer-const': 'warn',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: sdkBoundaryLegacyFiles,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@opencode-ai/sdk', '@opencode-ai/sdk/*'],
              message: 'apps/web must use @kortix/sdk. OpenCode is an SDK implementation detail.',
            },
            {
              group: [
                '@kortix/sdk/opencode-client',
                '@kortix/sdk/opencode-errors',
                '@kortix/sdk/event-stream',
                '@kortix/sdk/server-store',
                '@kortix/sdk/sync-store',
                '@kortix/sdk/sandbox-connection-store',
                '@kortix/sdk/opencode-pending-store',
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
              group: ['@/lib/api', '@/lib/api/*', '@/lib/auth-token'],
              message: 'Kortix API access belongs in @kortix/sdk.',
            },
          ],
        },
      ],
    },
  },
];

export default eslintConfig;
