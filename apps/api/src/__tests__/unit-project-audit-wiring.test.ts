import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const accessSource = readFileSync(
  new URL('../workspaces/lib/access.ts', import.meta.url),
  'utf8',
);
const routesSource = readFileSync(
  new URL('../workspaces/routes/r1.ts', import.meta.url),
  'utf8',
);
// The managed-git POST /provision create path used to stamp this inline in
// `r1.ts`. Task 16 (workspace-switcher) extracted that handler's body into
// `runProvision`, shared with the streaming variant of the route, so its
// `setContextField('workspaceId', row.workspaceId);` call now lives here instead.
const provisionCoreSource = readFileSync(
  new URL('../workspaces/provision-core.ts', import.meta.url),
  'utf8',
);
const sessionsSource = readFileSync(
  new URL('../workspaces/lib/sessions.ts', import.meta.url),
  'utf8',
);

test('project account and project resolution propagate the central audit scope', () => {
  expect(accessSource).toContain(
    "setContextField('accountId', membership.accountId);",
  );
  expect(accessSource).toContain("setContextField('accountId', row.accountId);");
  expect(accessSource).toContain("setContextField('workspaceId', row.workspaceId);");
  // ONE project-creation path per file: `r1.ts`'s BYO-repo POST / handler,
  // and `provision-core.ts`'s managed-git `runProvision`. Neither alone has
  // both any more — checking them separately (instead of one combined count)
  // means a regression that drops EITHER stamp fails on its own file, not
  // just on a combined total that a compensating duplicate could mask.
  expect(routesSource.match(/setContextField\('workspaceId', row\.workspaceId\);/g)).toHaveLength(
    1,
  );
  expect(
    provisionCoreSource.match(/setContextField\('workspaceId', row\.workspaceId\);/g),
  ).toHaveLength(1);
  expect(sessionsSource).toContain("setContextField('sessionId', sessionId);");
});
