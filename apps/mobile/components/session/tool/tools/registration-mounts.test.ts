import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const session = join(import.meta.dir, '..', '..');

test('both tool renderer mount points register tools at module load, not the renderer hub', () => {
  expect(readFileSync(join(session, 'SessionTurn.tsx'), 'utf8')).toMatch(/import ['"]\.\/tool\/tools\/register['"]/);
  expect(readFileSync(join(session, 'turn/activity-sheet.tsx'), 'utf8')).toMatch(/import ['"]@\/components\/session\/tool\/tools\/register['"]/);
  expect(readFileSync(join(session, 'tool/tool-part-renderer.tsx'), 'utf8')).not.toMatch(/import ['"]\.\/tools\/register['"]/);
});
