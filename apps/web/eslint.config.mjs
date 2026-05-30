import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

/**
 * Kortix design-system guard: chrome has exactly two radii. Every container /
 * box / panel is `rounded-2xl`; pills (buttons, badges) are `rounded-full`.
 * A bordered, padded box with `rounded-sm|md|lg|xl` is a hand-rolled container
 * that drifted off-brand — it should be `rounded-2xl` (or, better, composed
 * from `Card` / `SectionCard` / `InfoBanner`, which are `rounded-2xl` already).
 *
 * Heuristic: flag a className string only when it has BOTH a non-2xl container
 * radius AND a `border*` AND padding (`p-/px-/py-`). Requiring all three keeps
 * the sanctioned sub-element radii quiet: menu/list highlight rows
 * (`rounded-lg` without a border), avatars/thing-tiles, and raw micro-bits
 * (kbd keys, swatches, tiny icon squares) don't carry a border + padding box.
 * Genuine edge cases can opt out with an inline eslint-disable comment.
 */
const BAD_RADIUS = /\brounded-(?:sm|md|lg|xl)\b/;
const HAS_BORDER = /\bborder(?:-|\b)/;
const HAS_PADDING = /\b(?:p|px|py)-[\w./[\]-]+/;

const noHardcodedContainerRadius = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow non-2xl border-radius on bordered, padded containers (Kortix design system: containers are rounded-2xl).',
    },
    messages: {
      badRadius:
        'Container radius off-brand: this bordered, padded box uses {{radius}}. Kortix containers must be `rounded-2xl` (or compose Card/SectionCard/InfoBanner). Pills use `rounded-full`.',
    },
    schema: [],
  },
  create(context) {
    function check(node, raw) {
      if (typeof raw !== 'string') return;
      const match = raw.match(BAD_RADIUS);
      if (!match) return;
      if (!HAS_BORDER.test(raw)) return;
      if (!HAS_PADDING.test(raw)) return;
      context.report({
        node,
        messageId: 'badRadius',
        data: { radius: match[0] },
      });
    }
    return {
      Literal(node) {
        check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.raw);
      },
    };
  },
};

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    plugins: {
      'kortix-ds': {
        rules: {
          'no-hardcoded-container-radius': noHardcodedContainerRadius,
        },
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'react/no-unescaped-entities': 'off',
      'react-hooks/exhaustive-deps': 'warn',
      '@next/next/no-img-element': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
      'prefer-const': 'warn',
      'kortix-ds/no-hardcoded-container-radius': 'error',
    },
  },
];

export default eslintConfig;
