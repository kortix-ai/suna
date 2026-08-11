/**
 * Saves are fire-and-forget by design: a failed survey write must never block
 * navigation and must never raise a toast. The user asked to advance a step,
 * not to save a form.
 *
 * These are source-shape assertions. The properties being protected are
 * "persists through the SDK" and "swallows failures" — both are about what the
 * module is allowed to contain, and both would be trivially satisfiable by a
 * rendering test that never exercises the failure path.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'use-onboarding-answers.ts'), 'utf8');

describe('useOnboardingAnswers', () => {
  test('persists through the SDK, never a raw fetch', () => {
    expect(source).toContain('setWorkspaceOnboardingProfile');
    expect(source).not.toContain('fetch(');
  });

  test('swallows save failures instead of toasting', () => {
    expect(source).toContain('.catch(');
    expect(source).not.toContain('errorToast');
    expect(source).not.toContain('successToast');
  });

  test('exposes the answers and a save', () => {
    expect(source).toContain('export function useOnboardingAnswers');
    expect(source).toContain('return { answers, save }');
  });
});
