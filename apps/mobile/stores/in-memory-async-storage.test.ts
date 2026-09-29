import { expect, test } from 'bun:test';

// Bun runs every test file in one module registry. A second AsyncStorage mock
// with its own Map breaks whichever file imports a persisted store later, so
// only in-memory-async-storage.ts may register one.
test('only the shared module mocks AsyncStorage', () => {
  const grep = Bun.spawnSync(
    // The pattern is split so this file does not match itself.
    ['git', 'grep', '--untracked', '-l', 'mock.module(' + "'@react-native-async-storage/", '--', '.'],
    { cwd: `${import.meta.dir}/..` },
  );
  const files = grep.stdout.toString().trim().split('\n').filter(Boolean);
  expect(files).toEqual(['stores/in-memory-async-storage.ts']);
});
