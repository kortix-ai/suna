import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readCloneParam } from './clone-param';

describe('readCloneParam', () => {
  test('returns the item id', () => {
    expect(readCloneParam(new URLSearchParams('clone=item-1'))).toBe('item-1');
  });

  test('returns null when absent', () => {
    expect(readCloneParam(new URLSearchParams(''))).toBeNull();
  });

  test('returns null for an empty or whitespace value', () => {
    expect(readCloneParam(new URLSearchParams('clone='))).toBeNull();
    expect(readCloneParam(new URLSearchParams('clone=%20%20'))).toBeNull();
  });

  test('trims surrounding whitespace', () => {
    expect(readCloneParam(new URLSearchParams('clone=%20item-1%20'))).toBe('item-1');
  });
});

describe('readCloneParam integration — form state seeding', () => {
  const source = readFileSync(join(import.meta.dir, 'new-workspace-page.tsx'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  test('the page imports readCloneParam', () => {
    expect(code).toContain("from '@/features/workspace/new/clone-param'");
    expect(code).toContain('readCloneParam');
  });

  test('the page uses useSearchParams to read the clone param', () => {
    expect(code).toContain("from 'next/navigation'");
    expect(code).toContain('useSearchParams');
    expect(code).toContain('const searchParams = useSearchParams()');
  });

  test('the page seeds templateId from the clone param via lazy initializer', () => {
    expect(code).toContain('readCloneParam(new URLSearchParams(searchParams?.toString() ?? \'\'))');
    expect(code).toContain('const cloneItemId = readCloneParam');
    expect(code).toContain('templateId: cloneItemId');
    expect(code).toContain('useState<NewWorkspaceFormState>(() =>');
    // Verify it is a lazy initializer with both INITIAL_FORM_STATE and templateId.
    expect(code).toContain('...INITIAL_FORM_STATE');
    // Verify the lazy initializer pattern (function not value).
    expect(code.match(/useState<NewWorkspaceFormState>\(\(\) =>/)).not.toBeNull();
  });

  test('the page shows a note when templateId is seeded', () => {
    expect(code).toContain('state.templateId');
    expect(code).toContain('This workspace will be seeded from the template you picked.');
    expect(code).toContain('text-muted-foreground');
    expect(code).toContain('text-center');
    expect(code).toContain('text-xs');
  });
});
