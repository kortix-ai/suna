import { beforeEach, describe, expect, test } from 'bun:test';

import type { PermissionRequest, QuestionRequest } from '@kortix/sdk/opencode-client';

import { useOpenCodePendingStore } from './opencode-pending-store';

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
  useOpenCodePendingStore.getState().clear();
});

describe('useOpenCodePendingStore — resolved questions', () => {
  test('addQuestion stores a pending question', () => {
    useOpenCodePendingStore.getState().addQuestion(q('req_1'));
    expect(useOpenCodePendingStore.getState().questions.req_1).toBeDefined();
  });

  test('removeQuestion drops it and records it as resolved', () => {
    const store = useOpenCodePendingStore.getState();
    store.addQuestion(q('req_1'));
    store.removeQuestion('req_1');
    const state = useOpenCodePendingStore.getState();
    expect(state.questions.req_1).toBeUndefined();
    expect(state.resolvedQuestionIds).toContain('req_1');
  });

  test('a resolved question can never be resurrected by a later addQuestion', () => {
    const store = useOpenCodePendingStore.getState();
    store.addQuestion(q('req_1'));
    store.removeQuestion('req_1');
    // Simulates SSE reconnect hydrate / question.asked echo / self-heal poll.
    store.addQuestion(q('req_1'));
    expect(useOpenCodePendingStore.getState().questions.req_1).toBeUndefined();
  });

  test('resolving one question does not block a different question', () => {
    const store = useOpenCodePendingStore.getState();
    store.addQuestion(q('req_1'));
    store.removeQuestion('req_1');
    store.addQuestion(q('req_2'));
    expect(useOpenCodePendingStore.getState().questions.req_2).toBeDefined();
  });

  test('removeQuestion is idempotent and does not duplicate the resolved id', () => {
    const store = useOpenCodePendingStore.getState();
    store.addQuestion(q('req_1'));
    store.removeQuestion('req_1');
    store.removeQuestion('req_1');
    const ids = useOpenCodePendingStore
      .getState()
      .resolvedQuestionIds.filter((id) => id === 'req_1');
    expect(ids).toHaveLength(1);
  });

  test('resolved id history is bounded', () => {
    const store = useOpenCodePendingStore.getState();
    for (let i = 0; i < 250; i++) {
      store.addQuestion(q(`req_${i}`));
      store.removeQuestion(`req_${i}`);
    }
    expect(useOpenCodePendingStore.getState().resolvedQuestionIds.length).toBeLessThanOrEqual(200);
  });

  test('clear() wipes resolved history so a fresh session can ask again', () => {
    const store = useOpenCodePendingStore.getState();
    store.addQuestion(q('req_1'));
    store.removeQuestion('req_1');
    store.clear();
    expect(useOpenCodePendingStore.getState().resolvedQuestionIds).toHaveLength(0);
    store.addQuestion(q('req_1'));
    expect(useOpenCodePendingStore.getState().questions.req_1).toBeDefined();
  });
});

describe('useOpenCodePendingStore — resolved permissions', () => {
  test('removePermission drops it and records it as resolved', () => {
    const store = useOpenCodePendingStore.getState();
    store.addPermission(perm('prm_1'));
    store.removePermission('prm_1');
    const state = useOpenCodePendingStore.getState();
    expect(state.permissions.prm_1).toBeUndefined();
    expect(state.resolvedPermissionIds).toContain('prm_1');
  });

  test('a resolved permission can never be resurrected by a later addPermission', () => {
    const store = useOpenCodePendingStore.getState();
    store.addPermission(perm('prm_1'));
    store.removePermission('prm_1');
    // Simulates SSE reconnect hydrate / permission.asked echo / self-heal poll.
    store.addPermission(perm('prm_1'));
    expect(useOpenCodePendingStore.getState().permissions.prm_1).toBeUndefined();
  });

  test('resolving one permission does not block a different one', () => {
    const store = useOpenCodePendingStore.getState();
    store.addPermission(perm('prm_1'));
    store.removePermission('prm_1');
    store.addPermission(perm('prm_2'));
    expect(useOpenCodePendingStore.getState().permissions.prm_2).toBeDefined();
  });

  test('resolved permission history is bounded', () => {
    const store = useOpenCodePendingStore.getState();
    for (let i = 0; i < 250; i++) {
      store.addPermission(perm(`prm_${i}`));
      store.removePermission(`prm_${i}`);
    }
    expect(useOpenCodePendingStore.getState().resolvedPermissionIds.length).toBeLessThanOrEqual(
      200,
    );
  });
});

describe('useOpenCodePendingStore — auto-approve sessions', () => {
  test('setAutoApproveAll flags and unflags a session', () => {
    const store = useOpenCodePendingStore.getState();
    store.setAutoApproveAll('ses_1', true);
    expect(useOpenCodePendingStore.getState().autoApproveAllSessions.ses_1).toBe(true);
    store.setAutoApproveAll('ses_1', false);
    expect(useOpenCodePendingStore.getState().autoApproveAllSessions.ses_1).toBeUndefined();
  });

  test('flags are per-session', () => {
    const store = useOpenCodePendingStore.getState();
    store.setAutoApproveAll('ses_1', true);
    expect(useOpenCodePendingStore.getState().autoApproveAllSessions.ses_2).toBeUndefined();
  });

  test('clear() resets auto-approve flags', () => {
    const store = useOpenCodePendingStore.getState();
    store.setAutoApproveAll('ses_1', true);
    store.clear();
    expect(useOpenCodePendingStore.getState().autoApproveAllSessions.ses_1).toBeUndefined();
  });
});
