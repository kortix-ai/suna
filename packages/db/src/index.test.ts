import { describe, test, expect } from 'bun:test';
import * as db from './index';

describe('package index re-exports', () => {
  test('exposes the createDb client factory', () => {
    expect(typeof db.createDb).toBe('function');
  });

  test('exposes the kortix schema namespace object', () => {
    expect(db.schema).toBeDefined();
    expect(db.schema.kortixSchema).toBeDefined();
  });

  test('re-exports the core kortix tables', () => {
    const expected = [
      'accounts',
      'accountMembers',
      'projects',
      'projectMembers',
      'sandboxes',
      'deployments',
      'kortixApiKeys',
    ] as const;
    for (const name of expected) {
      expect(db[name]).toBeDefined();
    }
  });

  test('re-exports the kortix enums', () => {
    const expected = [
      'sandboxStatusEnum',
      'deploymentStatusEnum',
      'projectStatusEnum',
      'apiKeyTypeEnum',
      'accountRoleEnum',
      'projectRoleEnum',
    ] as const;
    for (const name of expected) {
      expect(db[name]).toBeDefined();
    }
  });

  test('re-exports the public basejump tables', () => {
    expect(db.apiKeys).toBeDefined();
    expect(db.accountUser).toBeDefined();
    expect(db.billingCustomersInBasejump).toBeDefined();
  });

  test('namespaced schema and named table refer to the same object', () => {
    expect(db.accounts).toBe(db.schema.accounts);
  });

  test('does not collide the public apiKeys with the kortix kortixApiKeys', () => {
    expect(db.apiKeys).not.toBe(db.kortixApiKeys);
  });
});
