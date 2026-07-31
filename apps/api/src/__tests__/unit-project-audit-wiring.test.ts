import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const accessSource = readFileSync(
  new URL('../projects/lib/access.ts', import.meta.url),
  'utf8',
);
const routesSource = readFileSync(
  new URL('../projects/routes/r1.ts', import.meta.url),
  'utf8',
);
const sessionsSource = readFileSync(
  new URL('../projects/lib/sessions.ts', import.meta.url),
  'utf8',
);

test('project account and project resolution propagate the central audit scope', () => {
  expect(accessSource).toContain(
    "setContextField('accountId', membership.accountId);",
  );
  expect(accessSource).toContain("setContextField('accountId', row.accountId);");
  expect(accessSource).toContain("setContextField('projectId', row.projectId);");
  expect(routesSource.match(/setContextField\('projectId', row\.projectId\);/g)).toHaveLength(
    2,
  );
  expect(sessionsSource).toContain("setContextField('sessionId', sessionId);");
});
