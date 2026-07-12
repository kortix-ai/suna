import { beforeEach, describe, expect, test } from 'bun:test';

import { useRuntimePendingStore } from './runtime-pending-store';

type PendingState = ReturnType<typeof useRuntimePendingStore.getState>;
type PermissionRequest = Parameters<PendingState['addPermission']>[0];
type QuestionRequest = Parameters<PendingState['addQuestion']>[0];

const q = (id: string, sessionID = 'ses_1'): QuestionRequest =>
  ({
    id,
    sessionID,
    questions: [{ question: 'pick one', options: [{ label: 'a' }, { label: 'b' }] }],
  }) as unknown as QuestionRequest;

const perm = (id: string, sessionID = 'ses_1'): PermissionRequest =>
  ({
    id,
    sessionID,
    permission: 'bash',
    patterns: ['ls *'],
    metadata: {},
    always: ['ls *'],
  }) as unknown as PermissionRequest;

beforeEach(() => {
  useRuntimePendingStore.getState().clear();
});

describe('useRuntimePendingStore — resolved questions', () => {
  test('addQuestion stores a pending question', () => {
    useRuntimePendingStore.getState().addQuestion(q('req_1'));
    expect(useRuntimePendingStore.getState().questions.req_1).toBeDefined();
  });

  test('removeQuestion drops it and records it as resolved', () => {
    const store = useRuntimePendingStore.getState();
    store.addQuestion(q('req_1'));
    store.removeQuestion('req_1');
    const state = useRuntimePendingStore.getState();
    expect(state.questions.req_1).toBeUndefined();
    expect(state.resolvedQuestionIds).toContain('req_1');
  });

  test('a resolved question can never be resurrected by a later addQuestion', () => {
    const store = useRuntimePendingStore.getState();
    store.addQuestion(q('req_1'));
    store.removeQuestion('req_1');
    // Simulates SSE reconnect hydrate / question.asked echo / self-heal poll.
    store.addQuestion(q('req_1'));
    expect(useRuntimePendingStore.getState().questions.req_1).toBeUndefined();
  });

  test('resolving one question does not block a different question', () => {
    const store = useRuntimePendingStore.getState();
    store.addQuestion(q('req_1'));
    store.removeQuestion('req_1');
    store.addQuestion(q('req_2'));
    expect(useRuntimePendingStore.getState().questions.req_2).toBeDefined();
  });

  test('removeQuestion is idempotent and does not duplicate the resolved id', () => {
    const store = useRuntimePendingStore.getState();
    store.addQuestion(q('req_1'));
    store.removeQuestion('req_1');
    store.removeQuestion('req_1');
    const ids = useRuntimePendingStore
      .getState()
      .resolvedQuestionIds.filter((id) => id === 'req_1');
    expect(ids).toHaveLength(1);
  });

  test('resolved id history is bounded', () => {
    const store = useRuntimePendingStore.getState();
    for (let i = 0; i < 250; i++) {
      store.addQuestion(q(`req_${i}`));
      store.removeQuestion(`req_${i}`);
    }
    expect(useRuntimePendingStore.getState().resolvedQuestionIds.length).toBeLessThanOrEqual(200);
  });

  test('clear() wipes resolved history so a fresh session can ask again', () => {
    const store = useRuntimePendingStore.getState();
    store.addQuestion(q('req_1'));
    store.removeQuestion('req_1');
    store.clear();
    expect(useRuntimePendingStore.getState().resolvedQuestionIds).toHaveLength(0);
    store.addQuestion(q('req_1'));
    expect(useRuntimePendingStore.getState().questions.req_1).toBeDefined();
  });
});

describe('useRuntimePendingStore — resolved permissions', () => {
  test('removePermission drops it and records it as resolved', () => {
    const store = useRuntimePendingStore.getState();
    store.addPermission(perm('prm_1'));
    store.removePermission('prm_1');
    const state = useRuntimePendingStore.getState();
    expect(state.permissions.prm_1).toBeUndefined();
    expect(state.resolvedPermissionIds).toContain('prm_1');
  });

  test('a resolved permission can never be resurrected by a later addPermission', () => {
    const store = useRuntimePendingStore.getState();
    store.addPermission(perm('prm_1'));
    store.removePermission('prm_1');
    // Simulates SSE reconnect hydrate / permission.asked echo / self-heal poll.
    store.addPermission(perm('prm_1'));
    expect(useRuntimePendingStore.getState().permissions.prm_1).toBeUndefined();
  });

  test('resolving one permission does not block a different one', () => {
    const store = useRuntimePendingStore.getState();
    store.addPermission(perm('prm_1'));
    store.removePermission('prm_1');
    store.addPermission(perm('prm_2'));
    expect(useRuntimePendingStore.getState().permissions.prm_2).toBeDefined();
  });

  test('resolved permission history is bounded', () => {
    const store = useRuntimePendingStore.getState();
    for (let i = 0; i < 250; i++) {
      store.addPermission(perm(`prm_${i}`));
      store.removePermission(`prm_${i}`);
    }
    expect(useRuntimePendingStore.getState().resolvedPermissionIds.length).toBeLessThanOrEqual(
      200,
    );
  });
});

describe('useRuntimePendingStore — auto-approve sessions', () => {
  test('setAutoApproveAll flags and unflags a session', () => {
    const store = useRuntimePendingStore.getState();
    store.setAutoApproveAll('ses_1', true);
    expect(useRuntimePendingStore.getState().autoApproveAllSessions.ses_1).toBe(true);
    store.setAutoApproveAll('ses_1', false);
    expect(useRuntimePendingStore.getState().autoApproveAllSessions.ses_1).toBeUndefined();
  });

  test('flags are per-session', () => {
    const store = useRuntimePendingStore.getState();
    store.setAutoApproveAll('ses_1', true);
    expect(useRuntimePendingStore.getState().autoApproveAllSessions.ses_2).toBeUndefined();
  });

  test('clear() resets auto-approve flags', () => {
    const store = useRuntimePendingStore.getState();
    store.setAutoApproveAll('ses_1', true);
    store.clear();
    expect(useRuntimePendingStore.getState().autoApproveAllSessions.ses_1).toBeUndefined();
  });
});
