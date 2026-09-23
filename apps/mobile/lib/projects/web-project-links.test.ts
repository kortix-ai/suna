import { describe, expect, test } from 'bun:test';

import { projectCustomizeWebUrl, projectMembersWebUrl } from './web-project-links';

describe('projectMembersWebUrl', () => {
  test('builds the members url', () => {
    expect(projectMembersWebUrl('https://kortix.com', 'proj-1')).toBe(
      'https://kortix.com/projects/proj-1/members'
    );
  });

  test('strips a trailing slash from the frontend url', () => {
    expect(projectMembersWebUrl('https://kortix.com/', 'proj-1')).toBe(
      'https://kortix.com/projects/proj-1/members'
    );
  });

  test('encodes the project id', () => {
    expect(projectMembersWebUrl('https://kortix.com', 'proj 1/2')).toBe(
      'https://kortix.com/projects/proj%201%2F2/members'
    );
  });
});

describe('projectCustomizeWebUrl', () => {
  test('builds the customize url', () => {
    expect(projectCustomizeWebUrl('https://kortix.com', 'proj-1')).toBe(
      'https://kortix.com/projects/proj-1/customize'
    );
  });

  test('strips a trailing slash from the frontend url', () => {
    expect(projectCustomizeWebUrl('https://kortix.com/', 'proj-1')).toBe(
      'https://kortix.com/projects/proj-1/customize'
    );
  });

  test('encodes the project id', () => {
    expect(projectCustomizeWebUrl('https://kortix.com', 'proj 1/2')).toBe(
      'https://kortix.com/projects/proj%201%2F2/customize'
    );
  });
});
