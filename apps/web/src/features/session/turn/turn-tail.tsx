'use client';

/**
 * The rows below a turn's assistant segments: the screen-reader mirror, the
 * streamed / inline / response text, the busy + retry indicators, the error
 * banner, the action bar and the Connect Provider dialog.
 *
 * Extracted verbatim from `SessionTurnImpl`'s render. It renders a fragment on
 * purpose — the caller owns the wrappers.
 */

import { Button } from '@/components/ui/button';
import { SessionRetryDisplay, TurnErrorDisplay } from '@/features/session/session-error-banner';
import { ConnectProviderDialog } from '@/features/session/model-selector';
import type { ToolPart } from '@/ui';
import { CheckIcon, TerminalWindowIcon as Terminal } from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../../icon/icon';
import { SandboxUrlDetector } from '../sandbox-url-detector';
import { SessionBusyIndicator } from '../session-busy-indicator';
import type { SessionTurnProps } from '../session-chat';
import { SessionTurnMeta } from '../session-turn-meta';
import { ThrottledMarkdown } from './throttled-markdown';
import { AnsweredQuestionCard } from './turn-segment';
import type { TurnModel } from './use-turn-model';

export function TurnTail({ model, props }: { model: TurnModel; props: SessionTurnProps }) {
  const {
    working,
    response,
    hasSteps,
    hasReasoning,
    shouldUseInlineContent,
    inlineContentParts,
    commandForTurn,
    answeredQuestionParts,
    retryInfo,
    retryMessage,
    retrySecondsLeft,
    throttledStatus,
    tHardcodedUi,
    turnError,
    turnErrorDetails,
    copied,
    handleCopy,
    turnEndedAt,
    turnDurationMs,
    costInfo,
    connectProviderOpen,
    setConnectProviderOpen,
  } = model;
  const { providers } = props;

  return (
    // The old markup made these siblings of the segment list inside
    // `group/turn space-y-2.5`. Flattened into their own row they lose
    // that 10px rhythm unless it is restored here.
    <div className="space-y-2.5">
      {/* ── Screen reader ── */}
      <div className="sr-only" aria-live="polite">
        {!working && response ? response : ''}
      </div>

      {/* Inline content: text and answered questions rendered in natural order.
			    Works both during streaming and after completion. */}
      {working && !hasSteps && !shouldUseInlineContent && response && (
        <div className="min-w-0 text-sm">
          <ThrottledMarkdown content={response} isStreaming />
        </div>
      )}
      {shouldUseInlineContent ? (
        <div className="space-y-3">
          {(() => {
            // Find the last text item index — it might still be streaming
            let lastTextIdx = -1;
            if (working) {
              for (let i = inlineContentParts!.length - 1; i >= 0; i--) {
                if (inlineContentParts![i].type === 'text') {
                  lastTextIdx = i;
                  break;
                }
              }
            }
            return inlineContentParts!.map((item, idx) => {
              if (item.type === 'text') {
                const isStreaming = idx === lastTextIdx;
                const text = isStreaming ? item.part.text! : item.part.text!.trim();
                return (
                  <div key={item.id} className="min-w-0 text-sm">
                    {isStreaming ? (
                      <ThrottledMarkdown content={text} isStreaming />
                    ) : (
                      <SandboxUrlDetector content={text} isStreaming={false} />
                    )}
                  </div>
                );
              }
              return <AnsweredQuestionCard key={item.id} part={item.part} />;
            });
          })()}
        </div>
      ) : (
        <>
          {/* Response section for text-only turns (no tools/steps content) */}
          {!working &&
            !hasSteps &&
            response &&
            (commandForTurn ? (
              <div className="border-border/60 from-muted/15 to-background overflow-hidden rounded-2xl border bg-gradient-to-b">
                <div className="border-border/50 bg-muted/25 flex items-center gap-2 border-b px-3 py-2">
                  <Terminal className="text-muted-foreground size-3.5 shrink-0" />
                  <span className="text-foreground font-mono text-xs">/{commandForTurn.name}</span>
                  {commandForTurn.args && (
                    <span className="text-muted-foreground truncate text-xs">
                      {commandForTurn.args}
                    </span>
                  )}
                </div>
                <div className="px-3 py-2.5 text-sm">
                  <SandboxUrlDetector content={response} isStreaming={false} />
                </div>
              </div>
            ) : (
              <div className="text-sm">
                <SandboxUrlDetector content={response} isStreaming={false} />
              </div>
            ))}

          {/* Answered question parts — shown after the response text only when
				    NONE of the upstream renderers fire. The steps section above is
				    gated by `working || hasSteps || hasReasoning`; if any of those
				    is true, the question parts have already been rendered inline
				    there as AnsweredQuestionCards. Mirroring that guard's inverse
				    here is the only way to avoid the double-render that showed up
				    on interrupted sessions that contained reasoning but no tool
				    steps (e.g. "Planning a process for questions" → user answers
				    → interrupt; hasSteps=false, working=false, hasReasoning=true,
				    and without the !hasReasoning check the card rendered twice). */}
          {!hasSteps && !working && !hasReasoning && answeredQuestionParts.length > 0 && (
            <div className="mt-3 space-y-2">
              {answeredQuestionParts.map(({ part }) => (
                <AnsweredQuestionCard key={part.id} part={part as ToolPart} />
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Working status indicator (always at the end while working) ── */}
      {working && (
        <div className="space-y-2">
          {retryInfo && retryMessage && (
            <SessionRetryDisplay
              message={retryMessage}
              attempt={retryInfo.attempt}
              secondsLeft={retrySecondsLeft}
            />
          )}
          <SessionBusyIndicator
            statusText={throttledStatus || undefined}
            retryLabel={
              retryInfo
                ? String(
                    tHardcodedUi.raw('componentsSessionSessionChat.line3820JsxTextWaitingToRetry'),
                  )
                : undefined
            }
          />
        </div>
      )}

      {/* ── Error (abort / failure banner) ── */}
      {turnError && <TurnErrorDisplay errorText={turnError} errorDetails={turnErrorDetails} />}

      {/* Question prompt — now rendered inside the chat input card (questionSlot) */}

      {/* ── Action bar (copy + turn meta) ── */}
      {!working && response && (
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleCopy}
            aria-label={copied ? 'Copied' : 'Copy response'}
          >
            <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
              <AnimatePresence initial={false} mode="popLayout">
                <motion.span
                  key={copied ? 'check' : 'copy'}
                  initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
                  animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
                  exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
                  transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
                  className="absolute inset-0 inline-flex items-center justify-center"
                >
                  {copied ? (
                    <CheckIcon className="text-foreground size-4" />
                  ) : (
                    <Icon.Copy className="size-4" />
                  )}
                </motion.span>
              </AnimatePresence>
            </span>
          </Button>
          <SessionTurnMeta
            endedAt={turnEndedAt}
            durationMs={turnDurationMs}
            cost={costInfo}
            className="flex items-center justify-center"
          />
        </div>
      )}

      <ConnectProviderDialog
        open={connectProviderOpen}
        onOpenChange={setConnectProviderOpen}
        providers={providers}
      />
    </div>
  );
}
