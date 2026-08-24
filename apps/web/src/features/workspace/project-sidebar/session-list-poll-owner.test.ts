import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const sessionPage = readFileSync(
  new URL('../../../app/(app)/projects/[id]/sessions/[sessionId]/page.tsx', import.meta.url),
  'utf8',
);
const sidebarList = readFileSync(new URL('./project-session-list.tsx', import.meta.url), 'utf8');

test('the always-mounted sidebar is the only project-session list poll owner', () => {
  expect(sidebarList).toContain('projectSessionsRefetchInterval({');
  expect(sessionPage).not.toContain('projectSessionsRefetchInterval({');
});
