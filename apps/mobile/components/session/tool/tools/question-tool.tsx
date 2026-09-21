/**
 * `question` / `ask`. Port of apps/web `tool/tools/question-tool.tsx`:
 * - trigger (no icon): "Question" / "Questions" (`text-xs font-medium`), then
 *   - while the question is open: "Waiting for your answer" shimmering italic;
 *   - once answered: the single answer as subtitle, or "N of M answered" while
 *     several are partly answered, and an `N/M` badge (`text-primary/70`,
 *     tabular) pushed right;
 * - body (`max-h-96 space-y-3`, a top border between questions): each
 *   question as markdown (`text-foreground/80 text-xs`) over its answers —
 *   the label `font-medium` with the option description muted beside it, or
 *   "—"; no questions → `ToolEmptyState` "No questions".
 *
 * Answers come from `metadata.answers`, else the `"q"="a"` output pairs. The
 * turn keeps answered questions visible through `@kortix/sdk`
 * `getAnsweredQuestionParts`; this row only draws the answered state.
 *
 * Difference from web: web's renderer passes `hasActiveQuestion`. Mobile's
 * `ToolPartRenderer` does not yet, so when the prop is absent the row reads
 * the session's pending questions from the sync store by `callID`.
 *
 * `QuestionExpandedContent` below is the previous mobile body, kept for
 * `tool-part-renderer.tsx`'s legacy switch.
 */

import { useMemo } from 'react';
import { View } from 'react-native';
import type { ParsedQuestion } from '@kortix/sdk';
import { useColorScheme } from 'nativewind';
import { TextShimmer } from '@/components/kortix/text-shimmer';
import { Text } from '@/components/ui/text';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { useSyncStore } from '@/lib/opencode/sync-store';
import type { ToolPart } from '@/lib/opencode/types';
import { disclosureKey } from '@/lib/session/disclosure-store';
import {
  parseQuestionsInput,
  questionFallbackLabel,
  questionTrigger,
  resolveQuestionAnswers,
} from '@/lib/session/tools/web-question';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  ToolEmptyState,
  ToolMarkdown,
  partInput,
  partMetadata,
  partOutput,
  useToolRowVariant,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { FONT_MEDIUM, TURN_SPACE, TURN_TYPE, fg, mutedStrong, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';
import { getToolInput } from '../shared/tool-part';
import { ToolScroll } from '../shared/surface';

// One shared identity for "this question has no answer yet".
const NO_ANSWERS: string[] = [];

function AnswerText({ answers, options }: { answers: string[]; options: ParsedQuestion['options'] }) {
  const palette = useTurnPalette();
  if (answers.length === 0) {
    return (
      <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>
        —
      </Text>
    );
  }
  return (
    <View style={{ rowGap: webSpace(0.5) }}>
      {answers.map((label) => {
        const opt = options.find((o) => o.label === label);
        return (
          <Text key={label} variant="muted" selectable style={[TURN_TYPE.xs, { color: palette.foreground }]}>
            <Text variant="muted" style={[TURN_TYPE.xs, { fontFamily: FONT_MEDIUM, color: palette.foreground }]}>
              {label}
            </Text>
            {opt?.description ? (
              <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>
                {` ${opt.description}`}
              </Text>
            ) : null}
          </Text>
        );
      })}
    </View>
  );
}

function QuestionAnswerBlock({ question, index, answers }: { question: ParsedQuestion; index: number; answers: string[] }) {
  return (
    <View style={{ rowGap: TURN_SPACE.gap1_5 }}>
      <ToolMarkdown content={question.question || question.header || questionFallbackLabel(question, index)} />
      <AnswerText answers={answers} options={question.options} />
    </View>
  );
}

export function QuestionTool({ part, sessionId, defaultOpen, forceOpen, locked, hasActiveQuestion }: ToolProps) {
  const palette = useTurnPalette();
  const { colorScheme } = useColorScheme();
  const primary = colorScheme === 'dark' ? THEME.dark.primary : THEME.light.primary;
  const { chain } = useToolRowVariant();
  const input = partInput(part);
  const metadata = partMetadata(part);
  const output = partOutput(part);
  const pendingForCall = useSyncStore((s) =>
    hasActiveQuestion === undefined && sessionId
      ? (s.questions[sessionId] ?? []).some((q) => q.tool?.callID === part.callID)
      : false,
  );
  const active = hasActiveQuestion ?? pendingForCall;

  const questions = useMemo(() => parseQuestionsInput(input.questions), [input.questions]);
  const answers = useMemo(
    () => resolveQuestionAnswers(metadata.answers, output, questions.length),
    [metadata.answers, output, questions.length],
  );
  const trigger = questionTrigger({ total: questions.length, answers, hasActiveQuestion: active });
  const type = chain ? TURN_TYPE.rowSm : TURN_TYPE.xs;

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      trigger={
        <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap1_5 }}>
          <Text variant="muted" style={[type, { flexShrink: 0, fontFamily: FONT_MEDIUM, color: palette.foreground }]}>
            {trigger.label}
          </Text>
          {trigger.waiting ? (
            <TextShimmer duration={1} spread={2} numberOfLines={1} style={[type, { fontStyle: 'italic' }]}>
              Waiting for your answer
            </TextShimmer>
          ) : null}
          {trigger.subtitle ? (
            <Text
              variant="muted"
              numberOfLines={1}
              style={[type, { flexShrink: 1, fontFamily: FONT_MEDIUM, color: palette.mutedForeground }]}
            >
              {trigger.subtitle}
            </Text>
          ) : null}
          {trigger.badge ? (
            <Text
              variant="muted"
              style={[
                type,
                {
                  marginLeft: 'auto',
                  flexShrink: 0,
                  fontFamily: FONT_MEDIUM,
                  fontVariant: ['tabular-nums'],
                  color: withAlpha(primary, 0.7),
                },
              ]}
            >
              {trigger.badge}
            </Text>
          ) : null}
        </View>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {questions.length > 0 ? (
        <ToolScroll maxHeight={TURN_SPACE.outputMaxHeight}>
          {questions.map((q, i) => (
            <View
              key={`${i}:${q.question}`}
              style={
                i > 0
                  ? { marginTop: TURN_SPACE.gap3, paddingTop: TURN_SPACE.gap3, borderTopWidth: 1, borderTopColor: palette.border }
                  : undefined
              }
            >
              <QuestionAnswerBlock question={q} index={i} answers={answers[i] ?? NO_ANSWERS} />
            </View>
          ))}
        </ToolScroll>
      ) : (
        <ToolEmptyState message="No questions" />
      )}
    </BasicTool>
  );
}
ToolRegistry.register('question', QuestionTool);
ToolRegistry.register('ask', QuestionTool);

// ─── Legacy body (tool-part-renderer.tsx `getExpandedContent`) ───────────────

export function QuestionExpandedContent({ tool, isDark }: { tool: ToolPart; isDark: boolean }) {
  const input = getToolInput(tool);

  // Parse questions and answers from input or output
  const qaPairs = useMemo(() => {
    const pairs: { question: string; answer: string }[] = [];

    // First, try to get answers from output
    const outputAnswers = new Map<string, string>();
    const raw = (tool.state.status === 'completed' && 'output' in tool.state && tool.state.output)
      ? tool.state.output.trim() : '';

    if (raw) {
      // Try "question"="answer" format
      const pairMatches = [...raw.matchAll(/"([^"]+?)"\s*=\s*"([^"]*?)"/g)];
      for (const m of pairMatches) {
        outputAnswers.set(m[1], m[2]);
      }

      // Try JSON format
      if (outputAnswers.size === 0) {
        try {
          const parsed = JSON.parse(raw);
          const arr = Array.isArray(parsed) ? parsed : parsed?.questions;
          if (Array.isArray(arr)) {
            for (const item of arr) {
              if (item.question && item.answer) {
                outputAnswers.set(item.question, item.answer);
              }
            }
          }
        } catch {}
      }
    }

    // Get questions from input and merge with answers from output
    const questions = input.questions;
    if (Array.isArray(questions)) {
      for (const q of questions) {
        const qText = typeof q === 'object' ? q.question : typeof q === 'string' ? q : '';
        const inputAnswer = typeof q === 'object' ? q.answer || '' : '';
        const outputAnswer = outputAnswers.get(qText) || '';
        pairs.push({ question: qText, answer: inputAnswer || outputAnswer });
      }
      // Also add any output pairs not found in input
      for (const [question, answer] of outputAnswers) {
        if (!pairs.some(p => p.question === question)) {
          pairs.push({ question, answer });
        }
      }
      if (pairs.length > 0) return pairs;
    }

    // No input questions — use output pairs directly
    if (outputAnswers.size > 0) {
      for (const [question, answer] of outputAnswers) {
        pairs.push({ question, answer });
      }
      return pairs;
    }

    // Fallback: show raw output
    if (raw) return [{ question: '', answer: raw }];

    return pairs;
  }, [input, tool.state]);

  const answeredCount = qaPairs.filter(q => q.answer).length;

  if (qaPairs.length === 0) return null;

  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
      {qaPairs.map((qa, i) => (
        <View
          key={i}
          style={{
            paddingVertical: 6,
            borderBottomWidth: i < qaPairs.length - 1 ? 1 : 0,
            borderBottomColor: isDark ? withAlpha(THEME.dark.foreground, 0.04) : withAlpha(THEME.light.foreground, 0.03),
          }}
        >
          {!!qa.question && (
            <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: mutedStrong(isDark), lineHeight: 18 }}>
              {qa.question}
            </Text>
          )}
          {!!qa.answer && (
            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: fg(isDark), lineHeight: 18, marginTop: qa.question ? 2 : 0 }}>
              {qa.answer}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}
