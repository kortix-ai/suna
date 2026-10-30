import { describe, expect, test } from 'bun:test';
import type { FileNode } from '../../../internal/files/types';
import type { FileListPage } from '../api/runtime-files';
import { fileListResult } from './use-file-list';

const node = (name: string): FileNode => ({
  name,
  path: `/workspace/a/${name}`,
  absolute: `/workspace/a/${name}`,
  type: 'file',
  ignored: false,
});

function query(pages: FileListPage[], over: Partial<Parameters<typeof fileListResult>[0]> = {}) {
  return {
    data: { pages },
    isLoading: false,
    isFetching: false,
    error: null as unknown,
    refetch: async () => undefined,
    hasNextPage: false,
    fetchNextPage: async () => undefined,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    ...over,
  };
}

// KRTX-1723: the explorer reads a folder in pages of 500.
describe('fileListResult', () => {
  const pages: FileListPage[] = [
    { nodes: [node('f0000.txt')], nextCursor: 'C2', truncated: true },
    { nodes: [node('f0500.txt')], nextCursor: 'C3', truncated: true },
  ];
  const data = pages.flatMap((p) => p.nodes);

  test('a failed "Load more" keeps the loaded rows: the error is the next page\'s, not the listing\'s', () => {
    const failure = new Error('503');
    const result = fileListResult(
      query(pages, { error: failure, isFetchNextPageError: true, hasNextPage: true }),
      data,
    );
    expect(result.error).toBeNull();
    expect(result.nextPageError).toBe(failure);
    expect(result.data).toHaveLength(2);
    expect(result.hasNextPage).toBe(true);
  });

  test('a failed first page is the listing\'s error', () => {
    const failure = new Error('500');
    const result = fileListResult(query([], { data: undefined, error: failure }), undefined);
    expect(result.error).toBe(failure);
    expect(result.nextPageError).toBeNull();
  });

  test('a cut last page without a cursor reads as truncated; one with a cursor does not', () => {
    const cut = fileListResult(query([{ nodes: data, nextCursor: null, truncated: true }]), data);
    expect(cut.truncated).toBe(true);
    expect(fileListResult(query(pages, { hasNextPage: true }), data).truncated).toBe(false);
    expect(fileListResult(query([{ nodes: data, nextCursor: null, truncated: false }]), data).truncated).toBe(false);
  });

  test('"Load more" has its own busy state: the refresh spinner stays off while it runs', () => {
    const result = fileListResult(query(pages, { isFetching: true, isFetchingNextPage: true }), data);
    expect(result.isFetching).toBe(false);
    expect(result.isFetchingNextPage).toBe(true);
  });
});
