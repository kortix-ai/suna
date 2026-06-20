import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sourceUrl = new URL('./useAuth.ts', import.meta.url);

test('requesting an email code does not toggle global auth loading', async () => {
  const source = await readFile(sourceUrl, 'utf8');
  const magicCodeStart = source.indexOf('const signInWithMagicLink');
  const nextMethodStart = source.indexOf('/**\n   * Request password reset email', magicCodeStart);
  const magicCodeMethod = source.slice(magicCodeStart, nextMethodStart);

  assert.equal(magicCodeMethod.includes('setAuthState('), false);
});
