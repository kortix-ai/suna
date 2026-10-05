import { beforeEach, describe, expect, test } from 'bun:test';
import { useSessionFilesRequestStore } from './session-files-request-store';

describe('session files request store', () => {
  beforeEach(() => useSessionFilesRequestStore.setState({ request: null }));

  test('take returns the request for its session once, then null', () => {
    useSessionFilesRequestStore.getState().requestOpen('s-1');
    const taken = useSessionFilesRequestStore.getState().take('s-1');
    expect(taken?.sessionId).toBe('s-1');
    expect(useSessionFilesRequestStore.getState().take('s-1')).toBeNull();
  });

  test('take for another session leaves the request in place', () => {
    useSessionFilesRequestStore.getState().requestOpen('s-1');
    expect(useSessionFilesRequestStore.getState().take('s-2')).toBeNull();
    expect(useSessionFilesRequestStore.getState().request?.sessionId).toBe('s-1');
  });

  test('a repeat request gets a new id, so a subscriber sees it again', () => {
    useSessionFilesRequestStore.getState().requestOpen('s-1');
    const first = useSessionFilesRequestStore.getState().request?.id;
    useSessionFilesRequestStore.getState().take('s-1');
    useSessionFilesRequestStore.getState().requestOpen('s-1');
    expect(useSessionFilesRequestStore.getState().request?.id).not.toBe(first);
  });
});
