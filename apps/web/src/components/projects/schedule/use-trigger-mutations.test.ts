import type { FireProjectTriggerResponse, ProjectTrigger } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

// Only the network and notification boundaries are replaced. React Query and
// the hook itself execute for real (including mutationFn and lifecycle callbacks).
const fire = mock(
  async (_projectId: string, _slug: string): Promise<FireProjectTriggerResponse> => ({
    status: 'fired',
  }),
);
const deleteTrigger = mock(async (_projectId: string, _slug: string): Promise<void> => {});
const success = mock((_message: string, _options?: { description?: string }) => {});
const error = mock((_message: string, _options?: { description?: string }) => {});
mock.module('@kortix/sdk', () => ({
  fireProjectTrigger: fire,
  deleteProjectTrigger: deleteTrigger,
}));
mock.module('@/components/ui/toast', () => ({ successToast: success, errorToast: error }));

const { useTriggerMutations } = await import('./use-trigger-mutations');

const trigger: ProjectTrigger = {
  slug: 'daily-check',
  path: 'kortix.yaml#triggers.daily-check',
  name: 'Daily check',
  type: 'cron',
  agent: 'assistant',
  model: null,
  enabled: true,
  cron: '0 9 * * *',
  run_at: null,
  timezone: 'UTC',
  secret_env: null,
  run: null,
  mode: null,
  interval_seconds: null,
  expect_event_within_seconds: null,
  event: null,
  prompt_template: 'Check status',
  session_mode: 'fresh',
  session_id: null,
  session_key: null,
  filter: null,
  session_access: { mode: 'private', memberIds: [], groupIds: [] },
  last_fired_at: null,
};

function renderMutations(
  overrides: Partial<Parameters<typeof useTriggerMutations>[0]> = {},
  messages?: Record<string, string>,
) {
  const invalidate = mock(() => {});
  const onRemoved = mock(() => {});
  const deletedNoun = mock((_trigger: ProjectTrigger) => 'horaire');
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: 0 } } });
  let mutations: ReturnType<typeof useTriggerMutations> | undefined;
  function Probe() {
    mutations = useTriggerMutations({
      projectId: 'test-project',
      invalidate,
      onRemoved,
      deletedNoun,
      runFailureKey: 'text9c18cb990345',
      ...overrides,
    });
    return null;
  }
  const probe = createElement(QueryClientProvider, { client }, createElement(Probe));
  renderToString(
    messages
      ? createElement(
          NextIntlClientProvider,
          { locale: 'en', timeZone: 'UTC', messages: { hardcodedUi: { i18nComplete: messages } } },
          probe,
        )
      : probe,
  );
  if (!mutations) throw new Error('Hook did not render');
  return { ...mutations, invalidate, onRemoved, deletedNoun };
}

beforeEach(() => {
  fire.mockReset();
  fire.mockResolvedValue({ status: 'fired' });
  deleteTrigger.mockReset();
  deleteTrigger.mockResolvedValue(undefined);
  success.mockClear();
  error.mockClear();
});

describe('useTriggerMutations behavior', () => {
  test('waits for the run request before invalidating and never clears selection', async () => {
    const response = Promise.withResolvers<FireProjectTriggerResponse>();
    const started = Promise.withResolvers<void>();
    fire.mockImplementation(() => {
      started.resolve();
      return response.promise;
    });
    const hook = renderMutations();
    const pending = hook.run.mutateAsync(trigger);
    await started.promise;
    expect(fire).toHaveBeenCalledWith('test-project', trigger.slug);
    expect(hook.invalidate).not.toHaveBeenCalled();
    expect(hook.onRemoved).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();

    response.resolve({ status: 'fired' });
    await pending;
    expect(hook.invalidate).toHaveBeenCalledTimes(1);
    expect(hook.onRemoved).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  test('waits for deletion before clearing selection and invalidating', async () => {
    const response = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    deleteTrigger.mockImplementation(() => {
      started.resolve();
      return response.promise;
    });
    const hook = renderMutations();
    const pending = hook.remove.mutateAsync(trigger);
    await started.promise;
    expect(deleteTrigger).toHaveBeenCalledWith('test-project', trigger.slug);
    expect(hook.invalidate).not.toHaveBeenCalled();
    expect(hook.onRemoved).not.toHaveBeenCalled();
    expect(hook.deletedNoun).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();

    response.resolve();
    await pending;
    expect(hook.invalidate).toHaveBeenCalledTimes(1);
    expect(hook.onRemoved).toHaveBeenCalledTimes(1);
    expect(hook.deletedNoun).toHaveBeenCalledWith(trigger);
    expect(success).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  test.each([
    [{ status: 'fired', session_id: '12345678-abcdef' }, 'Started', 'Session 12345678…'],
    [{ status: 'fired' }, 'Started', 'Getting a session ready'],
    [{ status: 'queued', reason: 'Session is busy' }, 'Queued', 'Session is busy'],
    [{ status: 'queued' }, 'Queued', 'Busy right now — it will retry'],
    [{ status: 'queued', reason: '' }, 'Queued', ''],
  ] satisfies [FireProjectTriggerResponse, string, string][])(
    'runs %j and invalidates after the successful request',
    async (response, title, description) => {
      fire.mockResolvedValue(response);
      const hook = renderMutations();
      expect(hook.invalidate).not.toHaveBeenCalled();
      expect(await hook.run.mutateAsync(trigger)).toEqual(response);
      expect(fire).toHaveBeenCalledWith('test-project', trigger.slug);
      expect(success).toHaveBeenCalledTimes(1);
      expect(success).toHaveBeenCalledWith(title, { description });
      expect(error).not.toHaveBeenCalled();
      expect(hook.invalidate).toHaveBeenCalledTimes(1);
      expect(hook.onRemoved).not.toHaveBeenCalled();
    },
  );

  // Distinct keys currently have identical English copy. Give them distinct
  // translations to detect accidentally hardcoding either host's key.
  test.each(['text9c18cb990345', 'textfc56800b00af'] as const)(
    'uses host failure key %s for a failed run response',
    async (runFailureKey) => {
      fire.mockResolvedValue({ status: 'failed', error: 'Quota exceeded' });
      const messages = { text9c18cb990345: 'Schedule failed', textfc56800b00af: 'Agent failed' };
      const hook = renderMutations({ runFailureKey }, messages);
      await hook.run.mutateAsync(trigger);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(messages[runFailureKey], {
        description: 'Quota exceeded',
      });
      expect(success).not.toHaveBeenCalled();
      // A failed result is still an HTTP success: refresh its persisted status.
      expect(hook.invalidate).toHaveBeenCalledTimes(1);
    },
  );

  test.each([new Error('Network unavailable'), 'unknown failure'])(
    'reports rejected run %j without invalidating or clearing selection',
    async (failure) => {
      fire.mockRejectedValue(failure);
      const hook = renderMutations();
      await expect(hook.run.mutateAsync(trigger)).rejects.toBe(failure);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        failure instanceof Error ? failure.message : 'It could not start',
      );
      expect(success).not.toHaveBeenCalled();
      expect(hook.invalidate).not.toHaveBeenCalled();
      expect(hook.onRemoved).not.toHaveBeenCalled();
    },
  );

  test.each(['horaire', 'trigger'])(
    'deletes with the host noun %s and clears selection only after success',
    async (noun) => {
      const deletedNoun = mock((_trigger: ProjectTrigger) => noun);
      const hook = renderMutations({ deletedNoun });
      expect(hook.onRemoved).not.toHaveBeenCalled();
      await hook.remove.mutateAsync(trigger);
      expect(deleteTrigger).toHaveBeenCalledTimes(1);
      expect(deleteTrigger).toHaveBeenCalledWith('test-project', trigger.slug);
      expect(deletedNoun).toHaveBeenCalledTimes(1);
      expect(deletedNoun).toHaveBeenCalledWith(trigger);
      expect(success).toHaveBeenCalledTimes(1);
      expect(success).toHaveBeenCalledWith(`${noun[0].toUpperCase()}${noun.slice(1)} deleted`);
      expect(error).not.toHaveBeenCalled();
      expect(hook.onRemoved).toHaveBeenCalledTimes(1);
      expect(hook.invalidate).toHaveBeenCalledTimes(1);
    },
  );

  test.each([new Error('Delete denied'), 'unknown failure'])(
    'reports rejected deletion %j without success side effects',
    async (failure) => {
      deleteTrigger.mockRejectedValue(failure);
      const hook = renderMutations();
      await expect(hook.remove.mutateAsync(trigger)).rejects.toBe(failure);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        failure instanceof Error ? failure.message : 'Could not delete it',
      );
      expect(success).not.toHaveBeenCalled();
      expect(hook.deletedNoun).not.toHaveBeenCalled();
      expect(hook.onRemoved).not.toHaveBeenCalled();
      expect(hook.invalidate).not.toHaveBeenCalled();
    },
  );
});
