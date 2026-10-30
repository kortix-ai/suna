import { describe, expect, test } from 'bun:test';
import { permissionRulesAllowing } from './session-permission-prompt';

describe('permissionRulesAllowing ("Allow in config")', () => {
  test('adds the capability beside the rules already there', () => {
    expect(permissionRulesAllowing({ bash: 'ask', edit: { '*.env': 'deny', '*': 'allow' } }, 'bash')).toEqual({
      bash: 'allow',
      edit: { '*.env': 'deny', '*': 'allow' },
    });
  });

  test('a bare action becomes the "*" fallback', () => {
    expect(permissionRulesAllowing('ask', 'edit')).toEqual({ '*': 'ask', edit: 'allow' });
    expect(permissionRulesAllowing(undefined, 'webfetch')).toEqual({ webfetch: 'allow' });
  });

  test('"*" allows everything and flattens every rule', () => {
    expect(permissionRulesAllowing({ bash: { 'rm *': 'deny' }, edit: 'ask' }, '*')).toEqual({
      bash: 'allow',
      edit: 'allow',
      '*': 'allow',
    });
  });
});
