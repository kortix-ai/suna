// The two legacy Review addresses (`/projects/:id/review` and
// `/projects/:id/customize/review`) must keep working after KRTX-2444 merged
// the Review Center into the Repo page: each one redirects to the merged
// review section (`reviewHref`) and rebuilds the query verbatim, so a shared
// `?id=<review item id>` deep link still opens the same review item. The
// rebuild is the part worth pinning: `URLSearchParams`-reconstruction must
// preserve multi-value keys, drop `undefined` values and produce no `?` for
// an empty query.
import { describe, expect, mock, test } from 'bun:test';

const redirected: string[] = [];

mock.module('next/navigation', () => ({
  redirect: (url: string) => {
    redirected.push(url);
  },
}));

const { default: legacyReviewPage } = await import('./page');
const { default: legacyCustomizeReviewPage } = await import(
  '../(capabilities)/customize/review/page'
);

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function props(id: string, searchParams: PageProps['searchParams']): PageProps {
  return { params: Promise.resolve({ id }), searchParams };
}

describe('legacy review addresses redirect to the merged review section', () => {
  test('/projects/:id/review keeps the query', async () => {
    redirected.length = 0;
    await legacyReviewPage(props('p1', Promise.resolve({ id: 'demo-item-1' })));
    expect(redirected).toEqual(['/projects/p1/files/review?id=demo-item-1']);
  });

  test('/projects/:id/customize/review keeps the query, including multi-value keys', async () => {
    redirected.length = 0;
    await legacyCustomizeReviewPage(
      props('p1', Promise.resolve({ id: 'demo-item-1', tag: ['a', 'b'] })),
    );
    expect(redirected).toEqual(['/projects/p1/files/review?id=demo-item-1&tag=a&tag=b']);
  });

  test('both drop undefined values and send an empty query as no suffix', async () => {
    redirected.length = 0;
    await legacyReviewPage(props('p1', Promise.resolve({ gone: undefined })));
    await legacyCustomizeReviewPage(props('p2', Promise.resolve({})));
    expect(redirected).toEqual(['/projects/p1/files/review', '/projects/p2/files/review']);
  });
});
