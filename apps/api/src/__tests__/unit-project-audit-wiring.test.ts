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
// The managed-git POST /provision create path used to stamp this inline in
// `r1.ts`. Task 16 (workspace-switcher) extracted that handler's body into
// `runProvision`, shared with the streaming variant of the route, so its
// `setContextField('projectId', row.projectId);` call now lives here instead.
const provisionCoreSource = readFileSync(
  new URL('../projects/provision-core.ts', import.meta.url),
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
  // ONE project-creation path per file: `r1.ts`'s BYO-repo POST / handler,
  // and `provision-core.ts`'s managed-git `runProvision`. Neither alone has
  // both any more — checking them separately (instead of one combined count)
  // means a regression that drops EITHER stamp fails on its own file, not
  // just on a combined total that a compensating duplicate could mask.
  expect(routesSource.match(/setContextField\('projectId', row\.projectId\);/g)).toHaveLength(
    1,
  );
  expect(
    provisionCoreSource.match(/setContextField\('projectId', row\.projectId\);/g),
  ).toHaveLength(1);
  expect(sessionsSource).toContain("setContextField('sessionId', sessionId);");
});
