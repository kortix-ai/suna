'use client';

import { legacyAnswerPayload, legacyAttachmentsShowInput } from '@/features/session/legacy-answer';
import { SandboxUrlDetector } from '@/features/session/sandbox-url-detector';
import { partInput, ToolSurfaceContext } from '@/features/session/tool/shared/infrastructure';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { ShowTool } from '@/features/session/tool/tools/show-tool';
import { useTranslations } from '@/i18n/use-translations';
import { useSessionComposerPrefillStore } from '@/stores/session-composer-prefill-store';
import type { ToolPart } from '@/ui';
import { ArrowBendDownRightIcon as ArrowBendDownRight } from '@phosphor-icons/react';
import { useContext, useMemo } from 'react';

/**
 * A legacy Suna `complete` / `ask` call, rendered as the deliverable it is:
 * the answer text as assistant prose, the attachments through `ShowTool`, and
 * the follow-up prompts as one-click composer prefills.
 *
 * Not registered by name: `ToolPartRenderer` dispatches here when
 * `isLegacyAnswerPart` matches the input shape. See `legacy-answer.ts`.
 */
export function LegacyAnswerTool({ part, sessionId }: ToolProps) {
  const t = useTranslations('sessionUi.legacyAnswer');
  const surface = useContext(ToolSurfaceContext);
  const input = partInput(part);
  const payload = useMemo(() => legacyAnswerPayload(input), [input]);

  // The attachments ride through the real `show` renderer, so a legacy
  // deliverable gets the same viewers, file actions, and dead-file fallback.
  const showPart = useMemo<ToolPart | null>(() => {
    const showInput = payload ? legacyAttachmentsShowInput(payload.attachments) : null;
    if (!showInput) return null;
    return {
      ...part,
      tool: 'show',
      state: {
        status: 'completed',
        input: showInput,
        output: '',
        title: 'show',
        metadata: {},
        time: {
          start: (part.state as { time?: { start?: number } }).time?.start ?? 0,
          end: (part.state as { time?: { end?: number } }).time?.end ?? 0,
        },
      },
    } as ToolPart;
  }, [part, payload]);

  if (!payload) return null;

  const followUps = surface === 'inline' && sessionId ? payload.followUps : [];

  return (
    <div data-component="legacy-answer" className="flex min-w-0 flex-col gap-3">
      {payload.text ? (
        <div className="min-w-0 text-sm">
          <SandboxUrlDetector content={payload.text} isStreaming={false} />
        </div>
      ) : null}
      {showPart ? <ShowTool part={showPart} sessionId={sessionId} /> : null}
      {followUps.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">{t('followUps')}</span>
          {followUps.map((prompt, index) => (
            <button
              key={`${index}:${prompt}`}
              type="button"
              data-slot="legacy-follow-up"
              onClick={() =>
                useSessionComposerPrefillStore.getState().setPrefill(sessionId!, prompt)
              }
              className="text-muted-foreground hover:text-foreground hover:bg-hover focus-visible:ring-ring duration-normal flex w-full cursor-pointer items-start gap-2 rounded-sm px-1 py-1 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              <ArrowBendDownRight className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0">{prompt}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
