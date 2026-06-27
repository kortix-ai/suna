import test from 'node:test';
import assert from 'node:assert/strict';

import { starterTemplateForManagedProject } from './project-starter-template.ts';

test('mobile managed project creation defaults to the minimal starter', () => {
  assert.equal(starterTemplateForManagedProject(false), 'minimal');
});

test('mobile managed project creation can opt into the general knowledge worker starter', () => {
  assert.equal(starterTemplateForManagedProject(true), 'general-knowledge-worker');
});
