import type { QuestionAnswer, QuestionInfo } from '@/ui';

type CustomAnswerPlan =
  | { kind: 'ignore' }
  | { kind: 'reply'; answers: QuestionAnswer[] }
  | { kind: 'update'; answers: QuestionAnswer[]; tab: number };

export function planQuestionCustomAnswer(
  questions: QuestionInfo[],
  answers: QuestionAnswer[],
  tab: number,
  text: string,
): CustomAnswerPlan {
  const question = questions[tab];
  const value = text.trim();
  if (!question || question.custom === false || !value) return { kind: 'ignore' };
  const current = answers[tab] ?? [];
  if (question.multiple && current.includes(value)) return { kind: 'ignore' };
  const next = questions.map((_, index) => [...(answers[index] ?? [])]);
  next[tab] = question.multiple ? [...current, value] : [value];
  if (questions.length === 1 && !question.multiple) return { kind: 'reply', answers: next };
  return { kind: 'update', answers: next, tab: question.multiple ? tab : tab + 1 };
}
