'use client';

/**
 * An answered question as a row inside a burst.
 *
 * Answered questions used to render as a standalone card, which force-split the
 * burst around them: the turn read as burst → card → burst, and the card's
 * outlined panel was the loudest surface in a list of muted rows. But an
 * answered question IS a step of the turn — the agent asked, the user answered,
 * the work continued — so it renders like every other step: a chain row
 * ("Questions · 3 answered") that opens in place to the Q&A pairs.
 *
 * Shaped exactly like `ActivityGroupStep`: one component returning trigger +
 * content, rendered inside a `ChainOfThoughtStep` whose own `Disclosure` it
 * binds to. Trigger and content must be ONE child — `Disclosure` renders
 * exactly slots [0] and [1], and the step's rail already claims a slot, so as
 * siblings the content is silently dropped.
 */

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { cn } from '@/lib/utils';
import { isToolPart, type Part, type ToolPart } from '@/ui';
import { CaretRightIcon, ChatTeardropTextIcon } from '@phosphor-icons/react';
import { memo } from 'react';
import { normalizeActivityToolName } from '../session-activity-groups';

interface QuestionInput {
  question: string;
  options?: { label: string }[];
}

function readQuestions(part: ToolPart): QuestionInput[] {
  const input = (part.state as { input?: { questions?: unknown } } | undefined)?.input;
  return Array.isArray(input?.questions) ? (input.questions as QuestionInput[]) : [];
}

function readAnswers(part: ToolPart): string[][] {
  const metadata = (part.state as { metadata?: { answers?: unknown } } | undefined)?.metadata;
  return Array.isArray(metadata?.answers) ? (metadata.answers as string[][]) : [];
}

/**
 * True when this part has a renderable Q&A: a `question` call with both the
 * questions asked and the user's answers. Anything less (pending, dismissed,
 * malformed) falls through to the generic tool row instead.
 */
export function isAnsweredQuestionPart(part: Part): part is ToolPart {
  if (!isToolPart(part)) return false;
  if (normalizeActivityToolName(part.tool) !== 'question') return false;
  return readQuestions(part).length > 0 && readAnswers(part).length > 0;
}

function AnsweredQuestionStepImpl({ part, bare }: { part: ToolPart; bare?: boolean }) {
  const questions = readQuestions(part);
  const answers = readAnswers(part);
  const answeredCount = answers.filter((a) => a.length > 0).length;

  return (
    <>
      {/* One child only — DisclosureTrigger clones each child into its own
          clickable node, so a sibling caret would stack as a separate row. */}
      <DisclosureTrigger>
        <div
          className={cn(
            'text-foreground/80 hover:text-foreground',
            'flex w-full cursor-pointer items-center gap-3',
            'text-left text-sm leading-[1.5] transition-colors',
          )}
        >
          <ChatTeardropTextIcon className="text-muted-foreground size-4 flex-none" />
          <span className="font-medium">Questions</span>
          <span className="text-muted-foreground tabular-nums">{answeredCount} answered</span>
          <CaretRightIcon
            className={cn(
              'text-muted-foreground/40 size-3.5 flex-none',
              'transition-transform group-data-[state=open]/step:rotate-90',
            )}
          />
        </div>
      </DisclosureTrigger>
      <DisclosureContent>
        <div className="mt-3 space-y-2 pl-7">
          {questions.map((q, i) => {
            const answer = answers[i] || [];
            const answerText = answer.join(', ') || 'No answer';
            return (
              <div key={q.question} className="space-y-0.5">
                <div className="[&_*]:!text-muted-foreground [&_strong]:!text-muted-foreground [&_code]:!text-xs [&_li]:!my-0 [&_ol]:!my-0 [&_p]:!my-0 [&_p]:!text-xs [&_p]:!leading-relaxed [&_p]:!text-pretty [&_ul]:!my-0">
                  <UnifiedMarkdown content={q.question} />
                </div>
                <p className="text-foreground text-sm font-medium text-pretty">{answerText}</p>
              </div>
            );
          })}
        </div>
      </DisclosureContent>
    </>
  );
}

/** Same boundary as `ActivityStep`: the part keeps its identity until it
 *  changes, so the default shallow compare holds. */
export const AnsweredQuestionStep = memo(AnsweredQuestionStepImpl);
AnsweredQuestionStep.displayName = 'AnsweredQuestionStep';
