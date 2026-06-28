import { beforeEach, describe, expect, test } from 'bun:test';

import type { QuestionRequest } from '@opencode-ai/sdk/v2/client';

import { useOpenCodePendingStore } from './opencode-pending-store';

const q = (id: string, sessionID = 'ses_1'): QuestionRequest =>
  ({
    id,
    sessionID,
    questions: [{ question: 'pick one', options: [{ label: 'a' }, { label: 'b' }] }],
  }) as unknown as QuestionRequest;

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
    const ids = useOpenCodePendingStore.getState().resolvedQuestionIds.filter((id) => id === 'req_1');
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
