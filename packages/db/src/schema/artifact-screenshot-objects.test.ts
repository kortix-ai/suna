import { expect, test } from 'bun:test';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { artifactCommentScreenshotObjects } from './kortix';

test('screenshot receipts remain private and survive project/account cascades until object cleanup', () => {
  const config = getTableConfig(artifactCommentScreenshotObjects);
  expect(config.enableRLS).toBe(true);
  expect(config.policies).toEqual([]);
  expect(config.foreignKeys).toHaveLength(1);
  const relation = config.foreignKeys[0]!;
  expect(relation.onDelete).toBe('set null');
  expect(relation.reference().columns.map(column => column.name)).toEqual(['comment_id']);
  expect(config.columns.some(column => column.name === 'project_id')).toBe(true);
  expect(config.columns.find(column => column.name === 'upload_confirmed')?.notNull).toBe(true);
  expect(config.columns.some(column => column.name === 'account_id')).toBe(false);
  expect(config.indexes.some(entry => entry.config.columns.some(column => 'name' in column && column.name === 'next_attempt_at'))).toBe(true);
});
