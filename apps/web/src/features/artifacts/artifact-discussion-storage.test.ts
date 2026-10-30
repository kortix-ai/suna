import { expect, test } from 'bun:test';
import { artifactDiscussionStorage } from './artifact-discussion-storage';

test('panel persistence isolates each viewer and preserves the resizable layout', () => {
  const values = new Map<string, string>();
  const storage = () => ({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  });
  const first = artifactDiscussionStorage('first', storage);
  const second = artifactDiscussionStorage('second', storage);
  first.setItem('layout', '[68,32]');
  expect(first.getItem('layout')).toBe('[68,32]');
  expect(second.getItem('layout')).toBeNull();
  second.setItem('layout', '[75,25]');
  expect(first.getItem('layout')).toBe('[68,32]');
  expect(second.getItem('layout')).toBe('[75,25]');
});

test('blocked storage, quota failures and an unknown viewer do not block the panel', () => {
  const blocked = artifactDiscussionStorage('viewer', () => {
    throw new Error('blocked');
  });
  expect(blocked.getItem('layout')).toBeNull();
  expect(() => blocked.setItem('layout', 'value')).not.toThrow();
  const full = artifactDiscussionStorage('viewer', () => ({
    getItem: () => null,
    setItem: () => {
      throw new Error('quota');
    },
  }));
  expect(() => full.setItem('layout', 'value')).not.toThrow();
  let accessed = false;
  const anonymous = artifactDiscussionStorage(undefined, () => {
    accessed = true;
    throw new Error('must not read');
  });
  expect(anonymous.getItem('layout')).toBeNull();
  anonymous.setItem('layout', 'value');
  expect(accessed).toBe(false);
});
