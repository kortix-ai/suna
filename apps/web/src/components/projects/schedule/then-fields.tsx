'use client';

import { Label } from '@/components/ui/label';
import { type AutosizeTextAreaRef, Textarea } from '@/components/ui/textarea';
import { ModelSelector } from '@/features/session/model-selector';
import { AgentSelector, flattenModels } from '@/features/session/session-chat-input';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { type Agent, useRuntimeProviders } from '@kortix/sdk/react';
import { useMemo, useRef } from 'react';

import { InlineError, type PatchDraft } from './composer-parts';
import { PromptVariableHints } from './event-trigger-fields';
import type { ComposerDraft } from './trigger-composer-logic';

/** Then: what the agent does, which agent, which model. */
export function ThenFields({
  agents,
  draft,
  patch,
  payloadSchema,
  error,
}: {
  agents: Agent[];
  draft: ComposerDraft;
  patch: PatchDraft;
  /** The chosen event's payload, for the variable chips. */
  payloadSchema: Record<string, unknown> | null | undefined;
  error?: string;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const promptRef = useRef<AutosizeTextAreaRef | null>(null);
  const { data: providers } = useRuntimeProviders();
  const models = useMemo(() => flattenModels(providers), [providers]);

  function insertVariable(token: string) {
    const el = promptRef.current?.textArea;
    const text = draft.instruction;
    const at = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? at;
    // Two chips in a row read as two words, not `}}{{`.
    const insert = at > 0 && !/\s/.test(text[at - 1]) ? ` ${token}` : token;
    patch({ instruction: `${text.slice(0, at)}${insert}${text.slice(end)}` });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + insert.length, at + insert.length);
    });
  }

  // Same shape as the detail sheet: a full-width rounded-md panel, not the
  // chat composer pill these selectors ship with.
  const panel = 'bg-popover flex w-full items-center rounded-md border px-2 py-1.5';
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Textarea
          value={draft.instruction}
          ref={promptRef}
          onChange={(e) => patch({ instruction: e.target.value })}
          aria-label={tI18nComplete.raw('text112f3ccb1b36')}
          aria-invalid={error ? true : undefined}
          placeholder={tI18nComplete.raw('text2438ee64fbf9')}
          rows={4}
          className="leading-relaxed"
        />
        <InlineError message={error} />
        {draft.kind === 'event' && draft.eventType ? (
          <PromptVariableHints payloadSchema={payloadSchema} onInsert={insertVariable} />
        ) : (
          <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
            {tI18nComplete.raw('text03956d4b33dc')}
          </p>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">{tI18nComplete.raw('text11b39c93777e')}</Label>
          <div className={panel}>
            <AgentSelector
              agents={agents}
              selectedAgent={draft.agent}
              triggerLabelClassName="max-w-none"
              onSelect={(agent) => patch({ agent })}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{tI18nComplete.raw('text5e2c614c23f0')}</Label>
          <div className={panel}>
            <ModelSelector
              models={models}
              providers={providers}
              selectedModel={draft.model}
              unsetLabel={tI18nComplete.raw('text57069bbd0d2e')}
              triggerLabelClassName="max-w-none"
              onSelect={(model) => patch({ model })}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
