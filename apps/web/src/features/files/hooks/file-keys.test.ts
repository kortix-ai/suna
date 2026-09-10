import { describe, expect, test } from 'bun:test';
import { fileContentKeys as sdkContent, fileListKeys as sdkList, gitStatusKeys as sdkGit } from '@kortix/sdk/react';
import { fileContentKeys } from './use-file-content';
import { fileListKeys } from './use-file-list';
import { gitStatusKeys } from './use-git-status';

// The live stream invalidates the SDK's key families on `file.edited`
// (use-opencode-events/handle-event.ts). These hooks used to key on their own
// `['runtime-files', …]` families, so a file the agent wrote never reached the
// Files panel, the viewer or the status until the panel was reopened —
// measured in a real browser on the pi-js dev stack 2026-09-10.
describe('the runtime file hooks key on what the stream invalidates', () => {
  test('list, content and git status are the SDK families, not private copies', () => {
    expect(fileListKeys).toBe(sdkList);
    expect(fileContentKeys).toBe(sdkContent);
    expect(gitStatusKeys).toBe(sdkGit);
  });
  test('and the family prefix is the one handle-event.ts names', () => {
    expect(fileListKeys.all).toEqual(['opencode-files', 'list']);
    expect(fileContentKeys.all).toEqual(['opencode-files', 'content']);
    expect(gitStatusKeys.all).toEqual(['opencode-files', 'git-status']);
  });
});
