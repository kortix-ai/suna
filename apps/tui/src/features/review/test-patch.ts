/**
 * A two-file unified patch in the exact shape
 * `GET /projects/:id/change-requests/:crId/diff` returns in its `patch` field.
 *
 * It lives in its own module, not in a `*.test.tsx`: importing a fixture from a
 * test file also registers that file's `describe` blocks in the importer, which
 * made one `bun test <file>` run report both suites.
 */
export const TWO_FILE_PATCH: string = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,4 @@',
  ' const start = 1;',
  '-const stop = 2;',
  '+const stop = 3;',
  '+const extra = 4;',
  ' export { start };',
  'diff --git a/README.md b/README.md',
  'index 3333333..4444444 100644',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1,2 @@',
  ' # Title',
  '+A new line.',
  '',
].join('\n');
