/**
 * The agent asked a question and the run is blocked until it is answered.
 *
 * One `QuestionRequest` can carry several `QuestionInfo`s; this renders them
 * one at a time and submits the whole `string[][]` at the end, which is the
 * shape `answerQuestion(requestId, answers)` takes — one `string[]` per
 * question, in order.
 *
 * Keys (only while `focused`):
 *   j / k / ↑ / ↓  move the option cursor
 *   1 … 9          pick that option directly
 *   Space          toggle the option (multi-select questions only)
 *   Enter          answer — advances to the next question, or submits
 *   i              type a free-text answer (when the question allows one)
 *   Esc            reject the question, or leave the free-text field
 */

import type { QuestionInfo, QuestionRequest } from '@kortix/sdk';
import { useKeyboard } from '@opentui/react';
import { useCallback, useMemo, useState } from 'react';

import { clip } from '../../../lib/turn-layout.ts';
import { glyph, theme } from '../../../theme.ts';

/** The wire leaves `custom` undefined far more often than it sets it, and the
 *  web prompt treats undefined as "allowed" — one rule, both hosts. */
export function acceptsCustomAnswer(question: QuestionInfo | undefined): boolean {
  return question?.custom !== false;
}

export interface QuestionPromptProps {
  question: QuestionRequest;
  /** `session.answerQuestion` — one `string[]` per question in the request. */
  onAnswer: (requestId: string, answers: string[][]) => void;
  /** `session.rejectQuestion`. */
  onReject: (requestId: string) => void;
  focused: boolean;
  width: number;
}

export function QuestionPrompt({
  question: request,
  onAnswer,
  onReject,
  focused,
  width,
}: QuestionPromptProps) {
  const questions = request.questions;
  const [index, setIndex] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [answers, setAnswers] = useState<string[][]>(() => questions.map(() => []));
  const [custom, setCustom] = useState<string | null>(null);

  const question = questions[index] as QuestionInfo | undefined;
  const options = question?.options ?? [];
  const multiple = question?.multiple ?? false;
  const picked = useMemo(() => new Set(answers[index] ?? []), [answers, index]);

  const submit = useCallback(
    (next: string[][]) => {
      onAnswer(request.id, next);
    },
    [onAnswer, request.id],
  );

  const commit = useCallback(
    (values: string[]) => {
      const next = answers.map((entry, position) => (position === index ? values : entry));
      setAnswers(next);
      if (index + 1 < questions.length) {
        setIndex(index + 1);
        setCursor(0);
        return;
      }
      submit(next);
    },
    [answers, index, questions.length, submit],
  );

  useKeyboard((key) => {
    if (!focused) return;

    if (custom !== null) {
      if (key.name === 'escape') setCustom(null);
      return; // the <input> owns every other key while it is open
    }

    switch (key.name) {
      case 'escape':
        onReject(request.id);
        return;
      case 'j':
      case 'down':
        setCursor((value) => Math.min(value + 1, Math.max(options.length - 1, 0)));
        return;
      case 'k':
      case 'up':
        setCursor((value) => Math.max(value - 1, 0));
        return;
      case 'i':
        if (acceptsCustomAnswer(question)) setCustom('');
        return;
      case 'space': {
        if (!multiple) return;
        const label = options[cursor]?.label;
        if (!label) return;
        const current = answers[index] ?? [];
        const next = current.includes(label)
          ? current.filter((entry) => entry !== label)
          : [...current, label];
        setAnswers(answers.map((entry, position) => (position === index ? next : entry)));
        return;
      }
      case 'return': {
        if (multiple) {
          commit(answers[index] ?? []);
          return;
        }
        const label = options[cursor]?.label;
        if (label) commit([label]);
        return;
      }
      default:
        break;
    }

    // 1…9 pick an option directly.
    if (key.name && /^[1-9]$/.test(key.name)) {
      const label = options[Number(key.name) - 1]?.label;
      if (label) commit([label]);
    }
  });

  if (!question) return null;
  const body = Math.max(width - 4, 12);
  const position = questions.length > 1 ? ` (${index + 1}/${questions.length})` : '';

  return (
    <box
      flexDirection="column"
      border
      borderStyle="single"
      borderColor={focused ? theme.borderFocus : theme.border}
      title={`Question${position}`}
      titleColor={focused ? theme.fg : theme.dim}
      paddingLeft={1}
      paddingRight={1}
      width={Math.max(width, 16)}
    >
      <text fg={theme.fg} wrapMode="word" width={body}>
        {question.question || question.header}
      </text>
      {options.map((option, optionIndex) => {
        const selected = optionIndex === cursor;
        const checked = picked.has(option.label);
        const mark = multiple ? (checked ? '[x]' : '[ ]') : `${optionIndex + 1}.`;
        return (
          <text
            key={option.label}
            fg={selected ? theme.fg : theme.dim}
            bg={selected ? theme.surface : undefined}
          >
            <span fg={theme.accent}>{selected && focused ? glyph.selected : ' '}</span>
            {` ${mark} ${clip(option.label, Math.max(body - 6, 4))}`}
          </text>
        );
      })}
      {custom !== null ? (
        <box border borderStyle="single" borderColor={theme.borderFocus} width={body}>
          <input
            focused
            placeholder="Type an answer, Enter sends"
            value={custom}
            onInput={setCustom}
            // Zero-arg: `onSubmit`'s prop type is the intersection of the React
            // binding's `(value: string) => void` and the renderable's
            // `(event: SubmitEvent) => void`, so no typed parameter satisfies
            // both. `custom` is the authority (see docs/opentui-notes.md).
            onSubmit={() => {
              const text = custom.trim();
              setCustom(null);
              if (text) commit([text]);
            }}
          />
        </box>
      ) : (
        <text fg={theme.faint}>
          {clip(
            multiple
              ? 'Space select · Enter confirm · Esc reject'
              : `Enter answer · Esc reject${acceptsCustomAnswer(question) ? ' · i type' : ''}`,
            body,
          )}
        </text>
      )}
    </box>
  );
}
