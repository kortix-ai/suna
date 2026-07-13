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
      'kortixApiKeys',
    ] as const;
    for (const name of expected) {
      expect(db[name]).toBeDefined();
    }
  });

  test('re-exports the kortix enums', () => {
    const expected = [
      'sandboxStatusEnum',
      'projectStatusEnum',
      'apiKeyTypeEnum',
      'accountRoleEnum',
      'projectRoleEnum',
    ] as const;
    for (const name of expected) {
      expect(db[name]).toBeDefined();
    }
  });

  test('re-exports the public tables', () => {
    expect(db.apiKeys).toBeDefined();
  });

  test('namespaced schema and named table refer to the same object', () => {
    expect(db.accounts).toBe(db.schema.accounts);
  });

  test('does not collide the public apiKeys with the kortix kortixApiKeys', () => {
    expect(db.apiKeys).not.toBe(db.kortixApiKeys);
  });

  test('does not export the retired hosted-deployment schema surface', () => {
    const retiredExports = [
      ['deployments'],
      ['deployment', 'Status', 'Enum'],
      ['deployment', 'Source', 'Enum'],
      ['deployments', 'Relations'],
      ['New', 'Deployment'],
      ['Deployment', 'Select'],
    ].map((parts) => parts.join(''));

    for (const name of retiredExports) {
      expect(name in db).toBe(false);
    }
  });
});
