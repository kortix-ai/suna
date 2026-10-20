'use client';

import { useTranslations } from '../../i18n';
/**
 * QuestionPrompt — compact self-contained inline chip inside the chat input card.
 *
 * - Compact header row (icon + summary + dismiss/chevron)
 * - Expandable body with question options
 * - Single-question immediate submit on pick
 * - Multi-select toggle + Next/Confirm flow
 * - Custom answers typed in the main chat textarea (no nested input)
 */

import { cn } from '../../lib/utils';
import type { QuestionAnswer, QuestionInfo, QuestionRequest } from '../../internal/session-types';
import { CaretDownIcon, CaretLeftIcon, CaretRightIcon, CheckIcon } from '@phosphor-icons/react';
import React, { useCallback, useEffect, useImperativeHandle, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Close } from '../../icons/close';

// ---------------------------------------------------------------------------
// Lightweight markdown renderer for question text (no Shiki/KaTeX/Mermaid)
// ---------------------------------------------------------------------------

function QuestionMarkdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn('question-md', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-1 leading-relaxed">{children}</p>,
          strong: ({ children }) => (
            <strong className="text-foreground font-semibold">{children}</strong>
          ),
          em: ({ children }) => <em className="text-muted-foreground">{children}</em>,
          ul: ({ children }) => <ul className="my-0.5 list-disc pl-4">{children}</ul>,
          ol: ({ children }) => <ol className="my-0.5 list-decimal pl-4">{children}</ol>,
          li: ({ children }) => <li className="my-0">{children}</li>,
          code: ({ children }) => (
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">{children}</code>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary/80 underline underline-offset-2"
            >
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** The action the main send button should perform when a question is active. */
export type QuestionAction = 'send' | 'next' | 'submit' | 'add';

/** Methods exposed via ref for parent-driven interaction. */
export interface QuestionPromptHandle {
  /** Submit a custom answer (typed in the main chat textarea) for the current question. */
  submitCustomAnswer: (text: string) => void;
  /** Whether the current question accepts a custom text answer. */
  acceptsCustom: boolean;
  /** What action the main send button should show/perform. */
  action: QuestionAction;
  /** Whether the action can be performed right now (e.g. multi-select has selections). */
  canAct: boolean;
  /** Perform the current action (next/submit). Called by the main send button. */
  performAction: () => void;
}

interface QuestionPromptProps {
  request: QuestionRequest;
  onReply: (requestId: string, answers: QuestionAnswer[]) => void;
  onReject: (requestId: string) => void;
  /** Called whenever the question's action state changes (for syncing to the send button). */
  onActionChange?: (action: QuestionAction, canAct: boolean) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const QuestionPrompt = React.forwardRef<QuestionPromptHandle, QuestionPromptProps>(
  function QuestionPrompt({ request, onReply, onReject, onActionChange }, ref) {
    const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
    const tCommon = useTranslations('common');
    const questions = request.questions;
    const isSingle = questions.length === 1 && !questions[0].multiple;

    const [tab, setTab] = useState(0);
    const [answers, setAnswers] = useState<QuestionAnswer[]>(() => questions.map(() => []));
    const [replying, setReplying] = useState(false);
    // Collapsed hides the body so the transcript gets the height back.
    const [collapsed, setCollapsed] = useState(false);

    const isConfirm = tab === questions.length;
    const currentQuestion = questions[tab] as QuestionInfo | undefined;
    const isMulti = currentQuestion?.multiple ?? false;
    const options = currentQuestion?.options ?? [];
    const currentAnswers = answers[tab] ?? [];
    const currentAnswerSet = new Set(currentAnswers);
    const showCustom = currentQuestion?.custom !== false;

    // -----------------------------------------------------------------------
    // Handlers
    // -----------------------------------------------------------------------

    const pick = useCallback(
      (answer: string) => {
        const next = [...answers];
        next[tab] = [answer];
        setAnswers(next);

        if (isSingle) {
          setReplying(true);
          onReply(request.id, [[answer]]);
          return;
        }

        // Advance to next tab
        setTab(tab + 1);
      },
      [answers, tab, isSingle, request.id, onReply],
    );

    const toggle = useCallback(
      (answer: string) => {
        const existing = answers[tab] ?? [];
        const next = [...existing];
        const idx = next.indexOf(answer);
        if (idx === -1) next.push(answer);
        else next.splice(idx, 1);

        const updated = [...answers];
        updated[tab] = next;
        setAnswers(updated);
      },
      [answers, tab],
    );

    const selectOption = useCallback(
      (optIndex: number) => {
        const opts = currentQuestion?.options ?? [];
        const opt = opts[optIndex];
        if (!opt) return;

        if (isMulti) {
          toggle(opt.label);
        } else {
          pick(opt.label);
        }
      },
      [currentQuestion?.options, isMulti, toggle, pick],
    );

    /** Called by the parent (via ref) when the user types a custom answer in the main textarea and hits send. */
    const handleCustomSubmit = useCallback(
      (value: string) => {
        const trimmed = value.trim();
        if (!trimmed) return;

        // On the Confirm tab there is no "current question" to answer. Treat a
        // typed message as the user's intent to submit: send all collected
        // answers and carry the typed text along as an extra note on the last
        // question (the per-question reply contract has no separate channel for
        // a free-form message, and an answer list already accepts custom text).
        if (isConfirm) {
          const finalAnswers = questions.map((_, i) => answers[i] ?? []);
          const lastIdx = questions.length - 1;
          if (lastIdx >= 0) {
            finalAnswers[lastIdx] = [...finalAnswers[lastIdx], trimmed];
          }
          setReplying(true);
          onReply(request.id, finalAnswers);
          return;
        }

        if (isMulti) {
          const existing = answers[tab] ?? [];
          if (!existing.includes(trimmed)) {
            const next = [...existing, trimmed];
            const updated = [...answers];
            updated[tab] = next;
            setAnswers(updated);
          }
          return;
        }

        pick(trimmed);
      },
      [isConfirm, isMulti, answers, tab, pick, questions, request.id, onReply],
    );

    const advanceToNext = useCallback(() => {
      if (currentAnswers.length > 0) {
        setTab(tab + 1);
      }
    }, [currentAnswers.length, tab]);

    // Derive what action the main send button should represent
    const action: QuestionAction = (() => {
      if (isSingle) return 'send';
      if (isConfirm) return 'submit';
      // Any non-confirm tab in a multi-question flow shows "Next"
      return 'next';
    })();

    const canAct = (() => {
      if (action === 'submit') return true;
      if (action === 'next') return currentAnswers.length > 0;
      return true;
    })();

    const submit = useCallback(() => {
      setReplying(true);
      const finalAnswers = questions.map((_, i) => answers[i] ?? []);
      onReply(request.id, finalAnswers);
    }, [answers, questions, request.id, onReply]);

    const performAction = useCallback(() => {
      if (action === 'submit') {
        submit();
      } else if (action === 'next') {
        advanceToNext();
      }
      // 'send' is handled by SessionChatInput directly (custom answer)
    }, [action, submit, advanceToNext]);

    // Notify parent of action state changes
    useEffect(() => {
      onActionChange?.(action, canAct);
    }, [action, canAct, onActionChange]);

    // Expose imperative handle for parent-driven interaction
    useImperativeHandle(
      ref,
      () => ({
        submitCustomAnswer: handleCustomSubmit,
        acceptsCustom: showCustom && !isConfirm,
        action,
        canAct,
        performAction,
      }),
      [handleCustomSubmit, showCustom, isConfirm, action, canAct, performAction],
    );

    const reject = useCallback(() => {
      setReplying(true);
      onReject(request.id);
    }, [request.id, onReject]);

    // -----------------------------------------------------------------------
    // Once replied, hide completely
    // -----------------------------------------------------------------------

    if (replying) return null;

    // -----------------------------------------------------------------------
    // Render — the question docks onto the composer card as one surface:
    // a quiet `2 / 3 · Header` line, the question, then radio rows. Custom
    // answers are typed in the composer right below.
    // -----------------------------------------------------------------------

    const total = questions.length;
    const stepLabel = isConfirm
      ? tI18nComplete.raw('texteebdd24a77d9')
      : currentQuestion?.header?.trim() || '';
    const collapsedLabel = isConfirm
      ? stepLabel
      : (currentQuestion?.question ?? '')
          .replace(/[*_`#>]/g, '')
          .split('\n')[0]
          .trim() || stepLabel;

    return (
      <div className="relative isolate z-10 w-full">
        <div className="flex w-full items-center gap-2 px-3 py-1 pr-1.5">
          {/* The label is the disclosure: it toggles the body. Collapsed, it
              shows the question itself so the pending ask stays readable. */}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
            aria-controls={`${request.id}-panel`}
            className="text-muted-foreground hover:text-foreground flex min-h-6 min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-xs transition-colors"
          >
            {!isSingle && (
              <span className="shrink-0 tabular-nums">
                {Math.min(tab + 1, total)} / {total}
              </span>
            )}
            {(collapsed ? collapsedLabel : stepLabel) && (
              <span className={cn('min-w-0 truncate', collapsed && 'text-foreground')}>
                {!isSingle && (
                  <span aria-hidden="true" className="text-muted-foreground">
                    ·{' '}
                  </span>
                )}
                {collapsed ? collapsedLabel : stepLabel}
              </span>
            )}
            <CaretDownIcon
              className={cn(
                'duration-normal size-3 shrink-0 transition-transform ease-out motion-reduce:transition-none',
                collapsed && '-rotate-90',
              )}
            />
          </button>
          {!isSingle && !collapsed && (
            <div className="flex shrink-0 items-center">
              <button
                type="button"
                onClick={() => setTab(tab - 1)}
                disabled={tab === 0}
                aria-label={tCommon('back')}
                className="text-muted-foreground hover:text-foreground hover:bg-muted hit-area-2 inline-flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-30"
              >
                <CaretLeftIcon className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={advanceToNext}
                disabled={isConfirm || currentAnswers.length === 0}
                aria-label={tCommon('next')}
                className="text-muted-foreground hover:text-foreground hover:bg-muted hit-area-2 inline-flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-30"
              >
                <CaretRightIcon className="size-3.5" />
              </button>
            </div>
          )}
          {/* A real <button>: Enter AND Space activate it natively, and Space no
              longer scrolls the transcript out from under the question. */}
          <button
            type="button"
            onClick={reject}
            aria-label={tI18nComplete.raw('text31d11513a187')}
            className="text-muted-foreground hover:text-foreground hover:bg-muted hit-area-2 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors"
          >
            <Close className="size-3" />
          </button>
        </div>

        {/* Body — scrollable so long option lists don't blow up the card. The
            0fr/1fr grid row animates the collapse without measuring height. */}
        <div
          className={cn(
            'duration-normal grid transition-[grid-template-rows] ease-out motion-reduce:transition-none',
            collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
          )}
        >
          <div
            id={`${request.id}-panel`}
            aria-label={isSingle ? undefined : tI18nComplete.raw('text9a72221a2747')}
            inert={collapsed}
            className={cn(
              'duration-normal min-h-0 overflow-y-auto px-px transition-opacity ease-out motion-reduce:transition-none',
              collapsed ? 'pb-0 opacity-0' : 'max-h-[420px] pb-1.5',
            )}
          >
            {isConfirm ? (
              <div className="flex flex-col">
                {questions.map((q, i) => {
                  const ans = answers[i] ?? [];
                  const done = ans.length > 0;
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setTab(i)}
                      className="hover:bg-muted/60 flex w-full cursor-pointer items-baseline gap-4 rounded-lg px-3 py-2 text-left transition-colors"
                    >
                      <span className="text-muted-foreground w-28 shrink-0 truncate text-xs">
                        {q.header || q.question}
                      </span>
                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate text-sm',
                          done ? 'text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        {done ? ans.join(', ') : '—'}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : currentQuestion ? (
              <div className="flex flex-col gap-1.5">
                <div className="text-foreground max-h-[300px] overflow-y-auto px-3 text-sm leading-relaxed font-medium">
                  <QuestionMarkdown
                    content={
                      currentQuestion.question +
                      (isMulti ? tI18nComplete.raw('text79139c621384') : '')
                    }
                  />
                </div>

                <div className="flex flex-col">
                  {options.map((opt, i) => {
                    const isPicked = currentAnswerSet.has(opt.label);
                    // Adjacent picked rows join into one block: only the run's
                    // outer corners stay rounded.
                    const joinsAbove =
                      isPicked && currentAnswerSet.has(options[i - 1]?.label ?? '');
                    const joinsBelow =
                      isPicked && currentAnswerSet.has(options[i + 1]?.label ?? '');
                    const { title, recommended } = splitRecommended(opt.label);
                    return (
                      <button
                        key={opt.label}
                        type="button"
                        aria-pressed={isPicked}
                        onClick={() => selectOption(i)}
                        className={cn(
                          'group duration-normal flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors ease-out',
                          isPicked ? 'bg-muted' : 'hover:bg-muted/60',
                          joinsAbove && 'rounded-t-none',
                          joinsBelow && 'rounded-b-none',
                        )}
                      >
                        <span
                          className={cn(
                            'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border transition-colors',
                            isPicked
                              ? 'bg-foreground border-foreground'
                              : 'border-muted-foreground/40 group-hover:border-foreground/60',
                          )}
                        >
                          {isPicked && (
                            <CheckIcon weight="bold" className="text-background size-2.5" />
                          )}
                        </span>
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="flex min-w-0 items-baseline gap-2">
                            <span className="text-foreground text-sm font-medium">{title}</span>
                            {recommended && (
                              <span className="text-muted-foreground shrink-0 text-xs">
                                {recommended}
                              </span>
                            )}
                          </span>
                          {opt.description && (
                            <span className="text-muted-foreground text-xs leading-relaxed">
                              {opt.description}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  },
);

/** Agents mark the suggested option by suffixing its label with
 *  "(Recommended)". Show that as a quiet tag; the reply keeps the raw label. */
function splitRecommended(label: string): { title: string; recommended: string | null } {
  // Same result as `/^(.*?)\s*\((Recommended)\)\s*$/i`, whose `.*?` and `\s*`
  // backtrack quadratically on a long space run (CodeQL js/polynomial-redos):
  // the title is the text before the tag, trimmed, on one line.
  const match = /\((Recommended)\)\s*$/i.exec(label);
  const title = match ? label.slice(0, match.index).trimEnd() : '';
  return match && !/[\n\r\u2028\u2029]/.test(title)
    ? { title, recommended: match[1] }
    : { title: label, recommended: null };
}
