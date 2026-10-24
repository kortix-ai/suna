import { expect, test } from 'bun:test';
import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import config from '../../next.config';

const resolved: NextConfig = await config(PHASE_DEVELOPMENT_SERVER);

// KRTX-3232: /dashboard has never been a page. Desktop builds shipped before
// June 2026 open it on launch, and bookmarks and old links still carry it. The
// redirect to the signed-in home was lost in a merge, so it answered the 404 page.
test('/dashboard redirects to the signed-in home', async () => {
  const redirects = (await resolved.redirects?.()) ?? [];
  const rule = redirects.find((candidate) => candidate.source === '/dashboard');
  expect(rule).toMatchObject({ destination: '/projects', permanent: false });
});
