import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

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
    /* The module that binds DEFAULT_ICON_WEIGHT onto the SSR icons, plus the
       test that checks the binding against the raw entry. Nothing else may
       reach past it. */
    files: ['src/lib/icons/ssr.tsx', 'src/lib/icons/ssr.test.tsx'],
    rules: { 'no-restricted-imports': 'off' },
  },
];

export default eslintConfig;
