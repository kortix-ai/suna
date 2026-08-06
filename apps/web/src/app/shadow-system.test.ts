import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import tailwindcss from '@tailwindcss/postcss';
import { describe, expect, test } from 'bun:test';
import postcss, { type Rule } from 'postcss';

const WEB_ROOT = join(import.meta.dir, '../..');
const PACKAGE_JSON = join(WEB_ROOT, 'package.json');

const fixture = `
@import './globals.css';
@source inline("shadow-sm shadow-md shadow-lg shadow-none shadow-black/20 smooth-ring-neutral-400/40 sm:shadow-sm hover:shadow-md group-hover:shadow-md data-[state=open]:shadow-lg");

@utility test-independent-shadow-colors {
  @apply shadow-sm shadow-black/20 smooth-ring-neutral-400/40;
}
`;

async function compileFixture(): Promise<string> {
  const result = await postcss([tailwindcss()]).process(fixture, {
    from: join(import.meta.dir, 'shadow-system.fixture.css'),
  });
  return result.css;
}

function lastRule(css: string, selector: string): string {
  let found: Rule | undefined;
  postcss.parse(css).walkRules((rule) => {
    if (rule.selector === selector) found = rule;
  });
  if (!found) throw new Error(`Missing compiled selector: ${selector}`);
  return found.toString();
}

describe('Kortix smooth shadow system', () => {
  test('pins shadow-plugin to the reviewed release', () => {
    const packageJson = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(packageJson.dependencies['shadow-plugin']).toBe('2.1.0');
  });

  test('compiles the native aliases to matching smooth ring stacks', async () => {
    const css = await compileFixture();
    const sm = lastRule(css, '.shadow-sm');
    const md = lastRule(css, '.shadow-md');
    const lg = lastRule(css, '.shadow-lg');

    expect(sm).toContain('0 18px 47px');
    expect(md).toContain('0 17.54px 23.39px');
    expect(lg).toContain('0 25px 50px');

    for (const rule of [sm, md, lg]) {
      expect(rule).toContain('var(--smooth-ring-color)');
      expect(rule).toContain('0 0 0 var(--smooth-ring-width, 1px)');
      expect(rule).toContain('var(--color-neutral-300)');
      expect(rule).toContain('calc(30 * 1%)');
    }
  });

  test('keeps shadow and ring colors independent', async () => {
    const css = await compileFixture();
    const rule = lastRule(css, '.test-independent-shadow-colors');

    expect(rule).toContain('--tw-shadow-color:');
    expect(rule).toContain('--smooth-ring-color:');
    expect(rule).toContain('var(--smooth-ring-color)');
  });

  test('emits native variants and shadow-none', async () => {
    const css = await compileFixture();

    expect(css).toContain('.hover\\:shadow-md');
    expect(css).toContain('.sm\\:shadow-sm');
    expect(css).toContain('.group-hover\\:shadow-md');
    expect(css).toContain('.data-\\[state\\=open\\]\\:shadow-lg');
    expect(lastRule(css, '.shadow-none')).toContain('--tw-shadow: 0 0 #0000');
  });
});
