import { expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

/**
 * KRTX-2942: the managed-repository picker's search must survive a query the
 * server rejects. The route searches through GitHub, which answers some
 * queries with an error (502 here). The field used to `return null` whenever
 * its query was not `isSuccess`, so the error unmounted the picker and its
 * search input, and the operator could not correct the query.
 */

const real = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({
  ...real,
  listManagedGitRepositories: async (options?: { search?: string }) => {
    if (options?.search === 'bad:"') throw new Error('GitHub rejected the search query');
    const name = options?.search ? `synthetic/${options.search}` : 'synthetic/first';
    return { owner: 'synthetic', repositories: [{ full_name: name, default_branch: 'main' }] };
  },
}));
// The debounce is not under test: pass the value straight through.
mock.module('@/hooks/use-debounce', () => ({
  useDebounce: <T,>(value: T) => ({ debouncedValue: value, isLoading: false }),
}));

interface PickerProps {
  repos: { full_name: string }[];
  onSearchChange: (value: string) => void;
}
let mounts = 0;
function PickerStub(_props: PickerProps) {
  useEffect(() => {
    mounts += 1;
  }, []);
  return createElement('div', { 'data-testid': 'repo-picker' });
}
mock.module('@/features/projects/modal/github-import-pickers', () => ({
  RepositoryPicker: PickerStub,
  BranchPicker: () => null,
}));

const { ManagedImportField } = await import('./advanced-fields');

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** The mounted picker's props, or null once the field unmounted it. */
function picker(renderer: ReactTestRenderer): PickerProps | null {
  const found = renderer.root.findAllByType(PickerStub);
  return found.length ? (found[0]!.props as PickerProps) : null;
}

function text(renderer: ReactTestRenderer) {
  return JSON.stringify(renderer.toJSON());
}

test('a rejected search keeps the picker mounted and a corrected search returns results', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const state = { repoFullName: null, defaultBranch: 'main' } as never;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ManagedImportField, { state, onChange: () => {} }),
      ),
    );
  });
  await settle();
  expect(picker(renderer)?.repos.map((r) => r.full_name)).toEqual(['synthetic/first']);

  await act(async () => picker(renderer)?.onSearchChange('bad:"'));
  await settle();
  expect(picker(renderer)).not.toBeNull();
  expect(text(renderer)).toContain('Could not load repositories. Try again.');

  await act(async () => picker(renderer)?.onSearchChange('good'));
  await settle();
  expect(picker(renderer)?.repos.map((r) => r.full_name)).toEqual(['synthetic/good']);
  expect(text(renderer)).not.toContain('Could not load repositories');
  // One mount for the whole flow: the search input inside it never unmounted.
  expect(mounts).toBe(1);

  act(() => renderer.unmount());
});
