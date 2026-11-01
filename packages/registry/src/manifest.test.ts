import { describe, expect, test } from 'bun:test';
import { projectNameFromManifest } from './manifest';

describe('projectNameFromManifest', () => {
  test('reads project.name from kortix.yaml', () => {
    expect(projectNameFromManifest('project:\n  name: Acme\n')).toBe('Acme');
    expect(projectNameFromManifest('project:\n  name: "Acme Ops" # shown in the dashboard\n')).toBe('Acme Ops');
  });

  test('returns null when no project block names one', () => {
    expect(projectNameFromManifest(null)).toBeNull();
    expect(projectNameFromManifest('agents:\n  name: not-a-project\n')).toBeNull();
  });
});
