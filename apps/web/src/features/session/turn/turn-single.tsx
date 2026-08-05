'use client';

/**
 * The two turns that render as a single row instead of head + segments + tail:
 * shell mode (one bash tool part) and a compaction card.
 *
 * Extracted verbatim from `SessionTurnImpl`'s two early returns. Which one
 * applies is decided in `useTurnModel` as `singleRowKind`, so the decision is
 * data rather than control flow that skips hooks.
 */

import { ConnectProviderDialog } from '@/features/session/model-selector';
import { TurnErrorDisplay } from '@/features/session/session-error-banner';
import { ToolPartRenderer } from '@/features/session/tool/tool-renderers';
import { StackIcon as Layers } from '@phosphor-icons/react';
import { SandboxUrlDetector } from '../sandbox-url-detector';
import type { SessionTurnProps } from '../session-chat';
import type { TurnModel } from './use-turn-model';

export function TurnSingle({ model, props }: { model: TurnModel; props: SessionTurnProps }) {
  const {
    singleRowKind,
    shellModePart,
    nextPermission,
    turnError,
    turnErrorDetails,
    connectProviderOpen,
    setConnectProviderOpen,
    response,
  } = model;
  const { sessionId, disableToolNavigation, onPermissionReply, providers } = props;

  // ============================================================================
  // Shell mode — short-circuit rendering
  // ============================================================================

  if (singleRowKind === 'shell') {
    return (
      <div className="space-y-1">
        <ToolPartRenderer
          part={shellModePart!}
          sessionId={sessionId}
          disableNavigation={disableToolNavigation}
          permission={nextPermission?.tool ? nextPermission : undefined}
          onPermissionReply={onPermissionReply}
          defaultOpen
        />
        {turnError && (
          <TurnErrorDisplay
            errorText={turnError}
            errorDetails={turnErrorDetails}
            className="mt-2"
          />
        )}
        <ConnectProviderDialog
          open={connectProviderOpen}
          onOpenChange={setConnectProviderOpen}
          providers={providers}
        />
      </div>
    );
  }

  // ============================================================================
  // Compaction mode — render as a distinct card, no user bubble / logo / steps
  // ============================================================================

  if (singleRowKind === 'compaction') {
    return (
      <div className="group/turn">
        <div className="border-border/60 bg-card/50 overflow-hidden rounded-2xl border">
          <div className="border-border/40 bg-muted/40 flex items-center gap-2 border-b px-4 py-2.5">
            <Layers className="text-muted-foreground/70 size-3.5" />
            <span className="text-muted-foreground/70 text-xs font-medium tracking-wider uppercase">
              Compaction
            </span>
          </div>
          <div className="text-muted-foreground/90 [&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground [&_strong]:text-foreground/90 px-4 py-3 text-sm">
            <SandboxUrlDetector content={response} isStreaming={false} />
          </div>
        </div>
      </div>
    );
  }

  return null;
}
