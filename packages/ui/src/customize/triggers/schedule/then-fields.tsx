'use client';

import { Label } from '../../../primitives/label';
import { type AutosizeTextAreaRef, Textarea } from '../../../primitives/textarea';
import { ModelSelector } from '../../../session/models/model-selector';
import { AgentSelector } from '../../../session/composer/session-chat-input';
import { useTranslations as useI18nTranslations } from '../../../i18n';
import {
  type Agent,
  flattenModels,
  modelProviderMode,
  useRuntimeProviders,
} from '@kortix/sdk/react';
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
  const models = useMemo(
    () => flattenModels(providers, { providerMode: modelProviderMode(providers) }),
    [providers],
  );

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
          rows={3}
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
          {/* `field`: the selector is the bordered h-9 box itself, like every
              Select in this form, not a chat chip inside a frame. */}
          <AgentSelector
            agents={agents}
            selectedAgent={draft.agent}
            appearance="field"
            onSelect={(agent) => patch({ agent })}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{tI18nComplete.raw('text5e2c614c23f0')}</Label>
          <ModelSelector
            models={models}
            providers={providers}
            selectedModel={draft.model}
            unsetLabel={tI18nComplete.raw('text57069bbd0d2e')}
            appearance="field"
            onSelect={(model) => patch({ model })}
          />
        </div>
      </div>
    </div>
  );
}
