import { describe, expect, test } from 'bun:test';

import { sessionTemplateBuilds } from '../snapshots/build-state';

describe('sessionTemplateBuilds', () => {
  test('excludes optional per-project accelerator builds', () => {
    const template = { id: 'template', slug: 'default', status: 'ready' as const };
    const accelerator = {
      id: 'accelerator',
      slug: 'default-warm',
      status: 'failed' as const,
    };

    expect(sessionTemplateBuilds([accelerator, template])).toEqual([template]);
  });

  test('keeps a custom template whose declared slug contains warm text', () => {
    const template = {
      id: 'template',
      slug: 'warm-worker',
      status: 'failed' as const,
    };

    expect(sessionTemplateBuilds([template])).toEqual([template]);
  });
});
