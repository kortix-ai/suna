'use client';

import { errorToast, successToast } from '../../../primitives/toast';
import { triggerRunActions, triggerToastEntity } from './trigger-toast';
import type { UiTranslator } from '../../../i18n';
import { useTranslations } from '../../../i18n';
import { useUiRouter } from '../../../providers/ui-provider';
import { deleteProjectTrigger, fireProjectTrigger, type ProjectTrigger } from '@kortix/sdk';
import { useMutation } from '@tanstack/react-query';

/**
 * The run and delete mutations both trigger surfaces fire — the Triggers tab
 * (`schedule-view.tsx`) and the agent page's Triggers section
 * (the former agent Triggers section) kept two copies that had already drifted (the
 * run-failure toast key differed). Both get this one lifecycle, against their
 * own `qk.project.triggers(projectId)` key through `invalidate`.
 *
 * Host-specific behavior stays at the call site: the run-failure toast key
 * (`runFailureKey`, a `hardcodedUi.i18nComplete` key, `UiTranslator['raw']`'s
 * parameter type), the deleted row's localized noun (`deletedNoun`), what a
 * successful delete clears (`onRemoved`), and how `invalidate` reaches the
 * host's own query key / selection state.
 *
 * The toast bodies carry the entity row (kind glyph + trigger name) and, when
 * a fired run produced a session, the "Open session" action
 * (`triggerRunActions`) — the same toasts dev's inline copies showed before
 * the hook replaced them.
 */
export function useTriggerMutations({
  projectId,
  invalidate,
  deletedNoun,
  onRemoved,
  runFailureKey,
}: {
  projectId: string;
  invalidate: () => unknown;
  /** Localized by the host, so the section's kind fallback stays its own. */
  deletedNoun: (trigger: ProjectTrigger) => string;
  onRemoved: () => void;
  runFailureKey: Parameters<UiTranslator['raw']>[0];
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const router = useUiRouter();
  const run = useMutation({
    mutationFn: (trigger: ProjectTrigger) => fireProjectTrigger(projectId, trigger.slug),
    onSuccess: (res, trigger) => {
      const entity = triggerToastEntity(trigger);
      if (res.status === 'fired') {
        successToast(tI18nComplete.raw('textecbc89cd37a0'), {
          entity,
          ...(res.session_id
            ? {
                actions: triggerRunActions(
                  projectId,
                  res.session_id,
                  tI18nComplete.raw('textb205bb47f81a'),
                  router,
                ),
              }
            : { description: tI18nComplete.raw('text747e9e0e8e92') }),
        });
      } else if (res.status === 'queued') {
        successToast(tI18nComplete.raw('text661ff40a07e0'), {
          entity,
          description: res.reason ?? tI18nComplete.raw('text17cf41bd6a6f'),
        });
      } else {
        errorToast(tI18nComplete.raw(runFailureKey), { entity, description: res.error });
      }
      void invalidate();
    },
    onError: (err) =>
      errorToast(err instanceof Error ? err.message : tI18nComplete.raw('textfc56800b00af')),
  });
  const remove = useMutation({
    mutationFn: (trigger: ProjectTrigger) => deleteProjectTrigger(projectId, trigger.slug),
    onSuccess: (_data, trigger) => {
      const noun = deletedNoun(trigger);
      successToast(
        tI18nComplete('text65e31e8628a9', { value0: noun[0].toUpperCase(), value1: noun.slice(1) }),
        { entity: triggerToastEntity(trigger) },
      );
      onRemoved();
      void invalidate();
    },
    onError: (err) =>
      errorToast(err instanceof Error ? err.message : tI18nComplete.raw('text76bf191d6426')),
  });

  return { run, remove };
}
