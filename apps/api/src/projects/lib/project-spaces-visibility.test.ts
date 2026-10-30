import { describe, expect, test } from 'bun:test';

import { spaceSessionVisibility } from './project-spaces';

describe('the sharing a session filed into a space gets', () => {
  test('a new channel thread is project-visible', () => {
    expect(spaceSessionVisibility('channel')).toBe('project');
  });

  test('a DM thread is private, a fork of one too', () => {
    expect(spaceSessionVisibility('dm')).toBe('private');
    expect(spaceSessionVisibility('dm', 'project')).toBe('private');
  });

  test('a fork keeps its source sharing, never wider', () => {
    expect(spaceSessionVisibility('channel', 'private')).toBe('private');
    expect(spaceSessionVisibility('channel', 'project')).toBe('project');
  });

  test('a fork of a restricted session is private: its grants are not copied', () => {
    expect(spaceSessionVisibility('channel', 'restricted')).toBe('private');
  });
});
