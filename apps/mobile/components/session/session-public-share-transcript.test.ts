/**
 * KRTX-2525: "Share transcript" shares the whole conversation while the
 * computer sleeps. The runtime cannot answer then, so the rows come from the
 * SDK's export loader, which falls back to the saved copy of this session.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'SessionPublicShareRows.tsx'), 'utf8');

test('the transcript rows come from the export loader, scoped to this session', () => {
  expect(source).toContain('await loadSessionExportMessages(runtimeSessionId, `${projectId}/${session.session_id}`)');
  expect(source).not.toContain('loadSessionTranscriptMessages(');
});
