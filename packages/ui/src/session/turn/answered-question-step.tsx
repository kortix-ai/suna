'use client';

import { useTranslations } from '../../i18n';
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

import { UnifiedMarkdown } from '../../markdown/unified-markdown';
import { DisclosureContent } from '../../primitives/disclosure';
import { toToolView, type ToolCallBlock } from '@kortix/sdk';
import { ChatTeardropTextIcon } from '@phosphor-icons/react';
import { memo } from 'react';
import { isQuestionTool } from '@kortix/sdk';
import { ChainStepTrigger } from './chain-step-trigger';
import { ChainOfThought, ChainOfThoughtStep } from '../../primitives/chain-of-thought';

interface QuestionInput {
  question: string;
  options?: { label: string }[];
}

function readQuestions(call: ToolCallBlock): QuestionInput[] {
  const input = call.input as { questions?: unknown } | null | undefined;
  return Array.isArray(input?.questions) ? (input.questions as QuestionInput[]) : [];
}

function readAnswers(call: ToolCallBlock): string[][] {
  return toToolView(call).answers ?? [];
}

/**
 * True when this call has a renderable Q&A: a `question` call with both the
 * questions asked and the user's answers. Anything less (pending, dismissed,
 * malformed) falls through to the generic tool row instead.
 */
export function isAnsweredQuestionCall(call: ToolCallBlock): boolean {
  if (!isQuestionTool(call.name)) return false;
  return readQuestions(call).length > 0 && readAnswers(call).length > 0;
}

function AnsweredQuestionStepImpl({ call }: { call: ToolCallBlock; bare?: boolean }) {
  return <AnsweredQuestionsView questions={readQuestions(call)} answers={readAnswers(call)} />;
}

/** The answered-question chain row and its Q&A pairs: what a person picked or typed, under each question. */
function AnsweredQuestionsView({ questions, answers }: { questions: QuestionInput[]; answers: string[][] }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const answeredCount = answers.filter((a) => a.length > 0).length;

  return (
    <>
      {/* One child only — DisclosureTrigger clones each child into its own
          clickable node, so a sibling caret would stack as a separate row. */}
      <ChainStepTrigger
        icon={<ChatTeardropTextIcon className="text-muted-foreground size-4 flex-none" />}
        label={<span className="font-medium">{tI18nComplete.raw('text9a72221a2747')}</span>}
        trailing={
          <span className="text-muted-foreground tabular-nums">
            {answeredCount} {tI18nComplete.raw('text68c780cd132a')}
          </span>
        }
      />
      <DisclosureContent>
        <div className="mt-3 space-y-2 pl-7">
          {questions.map((q, i) => {
            const answer = answers[i] || [];
            const answerText = answer.join(', ') || tI18nComplete.raw('text7e49c68db30e');
            return (
              <div key={`${i}:${q.question}`} className="space-y-0.5">
                <div className="[&_*]:!text-muted-foreground [&_strong]:!text-muted-foreground [&_code]:!text-xs [&_li]:!my-0 [&_ol]:!my-0 [&_p]:!my-0 [&_p]:!text-xs [&_p]:!leading-relaxed [&_p]:!text-pretty [&_ul]:!my-0">
                  <UnifiedMarkdown content={q.question} trust="agent" />
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

/** A question answered after it parked, read back from the message that carried the answer. */
export interface ParkedQuestionAnswer {
  questions: QuestionInput[];
  answers: string[][];
}

/**
 * The answer to a parked question reaches the agent as a message the API
 * writes (`renderAnswerPrompt`, api projects/lib/pending-questions.ts):
 *
 *   You asked:
 *   > <question line>
 *   > <question line>
 *   <answer>
 *
 * one block per question. Null for any other text, so a person's own message
 * that happens to start the same way is never drawn as an answer: the API
 * sends this one as harness context (`synthetic`), and only that is parsed.
 */
export function parseParkedQuestionAnswer(text: string): ParkedQuestionAnswer | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== 'You asked:') return null;
  const pairs: { question: string[]; answer: string[] }[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith('> ') || line === '>') {
      const last = pairs.at(-1);
      // A quote line continues the question until its answer starts.
      if (last && last.answer.length === 0) last.question.push(line.slice(2));
      else pairs.push({ question: [line.slice(2)], answer: [] });
    } else if (line.trim() && pairs.length > 0) {
      pairs.at(-1)!.answer.push(line.trim());
    }
  }
  if (pairs.length === 0) return null;
  return {
    questions: pairs.map((p) => ({ question: p.question.join('\n').trim() })),
    answers: pairs.map((p) => (p.answer.length > 0 ? [p.answer.join(' ')] : [])),
  };
}

/** A parked question's answer as the chain row the session draws for an answered question. */
export function ParkedAnswerRow({ answer }: { answer: ParkedQuestionAnswer }) {
  return (
    <div data-testid="parked-answer" className="min-w-0">
      <ChainOfThought>
        <ChainOfThoughtStep>
          <AnsweredQuestionsView questions={answer.questions} answers={answer.answers} />
        </ChainOfThoughtStep>
      </ChainOfThought>
    </div>
  );
}

/** Same boundary as `ActivityStep`: the call keeps its identity until it
 *  changes, so the default shallow compare holds. */
export const AnsweredQuestionStep = memo(AnsweredQuestionStepImpl);
AnsweredQuestionStep.displayName = 'AnsweredQuestionStep';
