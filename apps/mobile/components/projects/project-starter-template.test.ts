import test from 'node:test';
import assert from 'node:assert/strict';

import { starterTemplateForManagedProject } from './project-starter-template';

test('mobile managed project creation scaffolds with the one general-knowledge-worker starter', () => {
  assert.equal(starterTemplateForManagedProject(), 'general-knowledge-worker');
});
