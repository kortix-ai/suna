import { describe, expect, test } from 'bun:test';
import {
  normalizePermissionResourceType,
  serializePermissionResourceType,
} from './resource-type-compat';

describe('Workspace IAM resource compatibility', () => {
  test('normalizes the canonical Workspace resource to the persisted IAM resource', () => {
    expect(normalizePermissionResourceType('workspace')).toBe('project');
    expect(normalizePermissionResourceType('project')).toBe('project');
  });

  test('preserves the caller namespace in effective-permission responses', () => {
    expect(serializePermissionResourceType('project', 'workspace')).toBe('workspace');
    expect(serializePermissionResourceType('project', 'project')).toBe('project');
    expect(serializePermissionResourceType('account', undefined)).toBe('account');
  });

  test('rejects unknown resource types instead of widening authorization', () => {
    expect(normalizePermissionResourceType('not-a-resource')).toBeUndefined();
    expect(normalizePermissionResourceType(null)).toBeUndefined();
  });
});
