import { expect, test } from 'bun:test';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  artifactCommentThreads,
  artifactCommentWriteLimits,
  artifactComments,
  artifactEvents,
  driveCommitAuthors,
  sessionSandboxIdentities,
} from './kortix';

for (const table of [
  artifactCommentThreads,
  artifactCommentWriteLimits,
  artifactComments,
  artifactEvents,
  driveCommitAuthors,
  sessionSandboxIdentities,
]) {
  test(`${getTableConfig(table).name} declares default-deny row level security`, () => {
    const config = getTableConfig(table);
    expect(config.enableRLS).toBe(true);
    expect(config.policies).toEqual([]);
  });
}
