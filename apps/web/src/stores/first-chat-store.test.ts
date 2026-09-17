import { beforeEach, describe, expect, test } from 'bun:test';

import { useFirstChatStore } from './first-chat-store';

const pending = (projectId: string) => useFirstChatStore.getState().projectIds.includes(projectId);

describe('first chat store', () => {
  beforeEach(() => {
    useFirstChatStore.setState(useFirstChatStore.getInitialState(), true);
  });

  test('a project has no first chat until onboarding starts one', () => {
    expect(pending('p1')).toBe(false);
  });

  test('start marks one project and leaves others alone', () => {
    useFirstChatStore.getState().start('p1');

    expect(pending('p1')).toBe(true);
    expect(pending('p2')).toBe(false);
  });

  test('start twice keeps one entry', () => {
    useFirstChatStore.getState().start('p1');
    useFirstChatStore.getState().start('p1');

    expect(useFirstChatStore.getState().projectIds).toEqual(['p1']);
  });

  test('finish ends only that project', () => {
    useFirstChatStore.getState().start('p1');
    useFirstChatStore.getState().start('p2');
    useFirstChatStore.getState().finish('p1');

    expect(pending('p1')).toBe(false);
    expect(pending('p2')).toBe(true);
  });

  test('finish on a project without a first chat changes nothing', () => {
    const before = useFirstChatStore.getState();
    useFirstChatStore.getState().finish('p1');

    expect(useFirstChatStore.getState()).toBe(before);
  });
});
