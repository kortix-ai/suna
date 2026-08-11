import test from 'node:test';
import assert from 'node:assert/strict';

import { starterTemplateForManagedWorkspace } from './workspace-starter-template';

test('mobile managed Workspace creation scaffolds with the one general-knowledge-worker starter', () => {
  assert.equal(starterTemplateForManagedWorkspace(), 'general-knowledge-worker');
});
