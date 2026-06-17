import { describe, expect, it } from 'vitest';
import { isReservedSlug, slugify } from './example-slugify';
import { projectFactory, resetSequence } from '../_support/factories';

describe('slugify', () => {
  it('lowercases and dasherizes a name', () => {
    expect(slugify('My Cool Project')).toBe('my-cool-project');
  });

  it('collapses runs of non-alphanumerics and trims edges', () => {
    expect(slugify('  Hello___World!! ')).toBe('hello-world');
  });

  it('produces an empty slug for symbol-only input', () => {
    expect(slugify('@#$%')).toBe('');
  });
});

describe('isReservedSlug', () => {
  it('flags slugs in the reserved set', () => {
    const reserved = new Set(['admin', 'api']);
    expect(isReservedSlug('admin', reserved)).toBe(true);
    expect(isReservedSlug('my-project', reserved)).toBe(false);
  });
});

describe('factory integration', () => {
  it('builds deterministic slugs from the shared factory', () => {
    resetSequence();
    const project = projectFactory();
    expect(slugify(project.name)).toBe(project.slug);
  });
});
