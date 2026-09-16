import { expect, test } from 'bun:test';
import { compilePermissionRules, evaluatePermission, wildcardMatch } from './permission-policy.ts';

test('wildcard permissions cover multiline commands and preserve the final matching rule', () => {
  const command = "printf '%s\n' value";
  expect(evaluatePermission('bash', command, compilePermissionRules('allow')).action).toBe('allow');
  expect(evaluatePermission('bash', command, compilePermissionRules('deny')).action).toBe('deny');
  expect(
    evaluatePermission(
      'bash',
      command,
      compilePermissionRules({
        bash: { '*': 'deny', 'printf *': 'allow' },
      }),
    ).action,
  ).toBe('allow');
  expect(wildcardMatch('a\nb', 'a?b')).toBe(true);
});

test('a trailing space wildcard permits the bare command without permitting a longer executable name', () => {
  expect(wildcardMatch('git status', 'git status *')).toBe(true);
  expect(wildcardMatch('git status --short', 'git status *')).toBe(true);
  expect(wildcardMatch('git status-extra', 'git status *')).toBe(false);
  expect(wildcardMatch('git status\nnext', 'git status *')).toBe(false);
});

test('permission matching normalizes path separators and treats regular-expression syntax literally', () => {
  expect(wildcardMatch('src\\nested\\file.ts', 'src/*.ts')).toBe(true);
  expect(wildcardMatch('src/nested/file.ts', 'src\\*.ts')).toBe(true);
  expect(wildcardMatch('src/[name].ts', 'src/[name].ts')).toBe(true);
  expect(wildcardMatch('src/n.ts', 'src/[name].ts')).toBe(false);
});
