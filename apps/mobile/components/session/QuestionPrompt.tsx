/**
 * QuestionPrompt — the agent's question, shown in place of the chat input.
 *
 * The card is the `Composer` card (`rounded-3xl border border-border
 * bg-background p-2`, same `px-4 pb-3 pt-1` inset), so answering reads as
 * typing a reply. One question at a time: the question, its options as plain
 * rows, a text field for your own answer, then the composer's control row
 * (Skip · Back · step · send).
 *
 * A single-choice option answers on tap and moves on. Multi-choice options
 * toggle; send moves on. The last step sends every answer. Rules live in
 * `lib/session/question-prompt.ts`.
 */

import React, { useCallback, useState } from 'react';
import { Keyboard, ScrollView, TextInput, View } from 'react-native';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { COMPOSER_CONTROL_HIT_SLOP } from '@/components/kortix/composer';
import { PressableSurface } from '@/components/kortix/pressable-surface';
import { INPUT_FONT_FAMILY, INPUT_FONT_SIZE } from '@/components/kortix/pill-input';
import { ArrowUpIcon, CheckIcon } from '@/lib/icons';
import { THEME } from '@/lib/utils/theme';
import {
  pickQuestionOption,
  questionStepAnswer,
  questionStepLabel,
} from '@/lib/session/question-prompt';
import type { QuestionAnswer, QuestionRequest } from '@/lib/opencode/types';

/** About five option rows, then the list scrolls. */
const MAX_OPTIONS_HEIGHT = 260;

interface QuestionPromptProps {
  request: QuestionRequest;
  onReply: (requestId: string, answers: QuestionAnswer[]) => void;
  onReject: (requestId: string) => void;
}

export function QuestionPrompt({ request, onReply, onReject }: QuestionPromptProps) {
  const { colorScheme } = useColorScheme();
  const colors = THEME[colorScheme === 'dark' ? 'dark' : 'light'];

  const questions = request.questions;
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<QuestionAnswer[]>(() => questions.map(() => []));
  const [drafts, setDrafts] = useState<string[]>(() => questions.map(() => ''));
  const [replying, setReplying] = useState(false);

  const question = questions[step];
  const options = question?.options ?? [];
  const isMulti = question?.multiple ?? false;
  const showCustom = question?.custom !== false;
  const picked = answers[step] ?? [];
  const draft = drafts[step] ?? '';
  const isLast = step === questions.length - 1;
  const stepAnswer = question ? questionStepAnswer(question, picked, draft) : [];
  const canSend = stepAnswer.length > 0;
  const stepLabel = questionStepLabel(step, questions.length);

  const advance = useCallback(
    (answer: QuestionAnswer) => {
      const next = answers.map((a, i) => (i === step ? answer : a));
      setAnswers(next);
      if (isLast) {
        Keyboard.dismiss();
        setReplying(true);
        onReply(request.id, next);
        return;
      }
      setStep(step + 1);
    },
    [answers, step, isLast, onReply, request.id],
  );

  const pick = useCallback(
    (label: string) => {
      if (!question) return;
      const next = pickQuestionOption(question, picked, label);
      if (isMulti) {
        setAnswers(answers.map((a, i) => (i === step ? next : a)));
        return;
      }
      setDrafts(drafts.map((d, i) => (i === step ? '' : d)));
      advance(next);
    },
    [question, picked, isMulti, answers, drafts, step, advance],
  );

  const send = useCallback(() => {
    if (canSend) advance(stepAnswer);
  }, [canSend, advance, stepAnswer]);

  const skip = useCallback(() => {
    Keyboard.dismiss();
    setReplying(true);
    onReject(request.id);
  }, [onReject, request.id]);

  if (replying || !question) return null;

  return (
    <View className="px-4 pb-3 pt-1">
      <View className="rounded-3xl border border-border bg-background p-2">
        <View className="gap-0.5 px-2 pb-2 pt-1">
          <Text className="font-roobert-medium text-base leading-6">{question.question}</Text>
          {isMulti ? (
            <Text className="font-roobert text-sm text-muted-foreground">Select all that apply</Text>
          ) : null}
        </View>

        {options.length > 0 ? (
          <ScrollView
            style={{ maxHeight: MAX_OPTIONS_HEIGHT }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {options.map((opt) => {
              const isPicked = picked.includes(opt.label);
              return (
                <PressableSurface
                  key={opt.label}
                  onPress={() => pick(opt.label)}
                  accessibilityRole={isMulti ? 'checkbox' : 'button'}
                  accessibilityState={isMulti ? { checked: isPicked } : undefined}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    borderRadius: 16,
                    backgroundColor: isPicked || pressed ? colors.secondary : 'transparent',
                  })}
                >
                  <View className="flex-1 gap-0.5">
                    <Text className="font-roobert text-base leading-6">{opt.label}</Text>
                    {opt.description ? (
                      <Text className="font-roobert text-sm text-muted-foreground" numberOfLines={2}>
                        {opt.description}
                      </Text>
                    ) : null}
                  </View>
                  {isMulti && isPicked ? <Icon as={CheckIcon} size={16} /> : null}
                </PressableSurface>
              );
            })}
          </ScrollView>
        ) : null}

        {showCustom ? (
          <TextInput
            value={draft}
            onChangeText={(t) => setDrafts(drafts.map((d, i) => (i === step ? t : d)))}
            onSubmitEditing={send}
            placeholder={options.length > 0 ? 'Or type your own answer' : 'Type your answer'}
            placeholderTextColor={colors.mutedForeground}
            autoFocus={options.length === 0}
            returnKeyType="send"
            submitBehavior="blurAndSubmit"
            accessibilityLabel="Your answer"
            className="text-foreground"
            style={{
              fontFamily: INPUT_FONT_FAMILY,
              fontSize: INPUT_FONT_SIZE,
              minHeight: 40,
              paddingHorizontal: 12,
              paddingTop: 10,
              paddingBottom: 12,
            }}
          />
        ) : null}

        <View className="flex-row items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="rounded-full"
            hitSlop={COMPOSER_CONTROL_HIT_SLOP}
            onPress={skip}
          >
            <Text>Skip</Text>
          </Button>
          {step > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full"
              hitSlop={COMPOSER_CONTROL_HIT_SLOP}
              onPress={() => setStep(step - 1)}
            >
              <Text>Back</Text>
            </Button>
          ) : null}
          <View className="flex-1" />
          {stepLabel ? (
            <Text className="font-roobert text-sm text-muted-foreground">{stepLabel}</Text>
          ) : null}
          {showCustom || isMulti ? (
            <Button
              variant={canSend ? 'default' : 'secondary'}
              size="icon-md"
              className="rounded-full"
              hitSlop={COMPOSER_CONTROL_HIT_SLOP}
              onPress={send}
              disabled={!canSend}
              accessibilityLabel={isLast ? 'Send answer' : 'Next question'}
            >
              <Icon as={ArrowUpIcon} size={18} />
            </Button>
          ) : null}
        </View>
      </View>
    </View>
  );
}
