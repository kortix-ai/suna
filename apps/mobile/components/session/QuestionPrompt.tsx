/**
 * QuestionPrompt — compact mobile-native question UI for OpenCode sessions.
 *
 * Renders inside the chat input card area, replacing the text input.
 * Compact sizing to match the frontend's inline chip style.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  ScrollView,
  TextInput,
  Keyboard,
  Text as RNText,
} from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { useColorScheme } from 'nativewind';
import { Ionicons } from '@expo/vector-icons';
import { useThemeColors } from '@/lib/theme-colors';
import { THEME, withAlpha } from '@/lib/utils/theme';
import type {
  QuestionRequest,
  QuestionInfo,
  QuestionAnswer,
} from '@/lib/opencode/types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface QuestionPromptProps {
  request: QuestionRequest;
  onReply: (requestId: string, answers: QuestionAnswer[]) => void;
  onReject: (requestId: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function QuestionPrompt({
  request,
  onReply,
  onReject,
}: QuestionPromptProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const questions = request.questions;
  const isSingle = questions.length === 1 && !questions[0].multiple;

  const [tab, setTab] = useState(0);
  const [answers, setAnswers] = useState<QuestionAnswer[]>(() =>
    questions.map(() => []),
  );
  const [customInputs, setCustomInputs] = useState<string[]>(() =>
    questions.map(() => ''),
  );
  const [editing, setEditing] = useState(false);
  const [replying, setReplying] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const tabScrollRef = useRef<ScrollView>(null);
  const tabLayouts = useRef<Record<number, { x: number; width: number }>>({});

  const isConfirm = tab === questions.length;
  const currentQuestion = questions[tab] as QuestionInfo | undefined;
  const isMulti = currentQuestion?.multiple ?? false;
  const options = currentQuestion?.options ?? [];
  const currentAnswers = answers[tab] ?? [];
  const showCustom = currentQuestion?.custom !== false;

  // Reset state when request changes (new question arrives)
  const prevRequestIdRef = useRef(request.id);
  useEffect(() => {
    if (prevRequestIdRef.current !== request.id) {
      prevRequestIdRef.current = request.id;
      setTab(0);
      setAnswers(questions.map(() => []));
      setCustomInputs(questions.map(() => ''));
      setEditing(false);
      setReplying(false);
    }
  }, [request.id, questions]);

  // Auto-scroll tab pills to keep active tab visible
  useEffect(() => {
    const layout = tabLayouts.current[tab];
    if (layout && tabScrollRef.current) {
      // Scroll so the active pill is roughly centered
      const scrollTo = Math.max(0, layout.x - 60);
      tabScrollRef.current.scrollTo({ x: scrollTo, animated: true });
    }
  }, [tab]);

  // Auto-focus input when editing
  useEffect(() => {
    if (editing) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [editing]);

  // Auto-activate custom input for single questions with no options
  useEffect(() => {
    if (isSingle && options.length === 0 && showCustom) {
      setEditing(true);
    }
  }, [request.id, isSingle, options.length, showCustom]);

  // -----------------------------------------------------------------------
  // Handlers
  // -----------------------------------------------------------------------

  const pick = useCallback(
    (answer: string, isCustom = false) => {
      const next = [...answers];
      next[tab] = [answer];
      setAnswers(next);

      if (isCustom) {
        const nextCustom = [...customInputs];
        nextCustom[tab] = answer;
        setCustomInputs(nextCustom);
      }

      if (isSingle) {
        setReplying(true);
        onReply(request.id, [[answer]]);
        return;
      }

      setTab(tab + 1);
      setEditing(false);
    },
    [answers, customInputs, tab, isSingle, request.id, onReply],
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
      if (showCustom && optIndex === opts.length) {
        setEditing(true);
        return;
      }
      const opt = opts[optIndex];
      if (!opt) return;

      if (isMulti) {
        toggle(opt.label);
      } else {
        pick(opt.label);
      }
    },
    [currentQuestion?.options, isMulti, showCustom, toggle, pick],
  );

  const handleCustomSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) {
        setEditing(false);
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
        setEditing(false);
        const nextCustom = [...customInputs];
        nextCustom[tab] = '';
        setCustomInputs(nextCustom);
        return;
      }

      pick(trimmed, true);
      setEditing(false);
      Keyboard.dismiss();
    },
    [isMulti, answers, customInputs, tab, pick],
  );

  const submit = useCallback(() => {
    setReplying(true);
    const finalAnswers = questions.map((_, i) => answers[i] ?? []);
    onReply(request.id, finalAnswers);
  }, [answers, questions, request.id, onReply]);

  const reject = useCallback(() => {
    setReplying(true);
    onReject(request.id);
  }, [request.id, onReject]);

  if (replying) return null;

  // -----------------------------------------------------------------------
  // Header summary
  // -----------------------------------------------------------------------

  const headerSummary = (() => {
    if (isSingle) {
      const q = questions[0];
      const trimmedHeader = q.header?.trim();
      if (trimmedHeader && trimmedHeader !== q.question.trim()) {
        return trimmedHeader;
      }
      return 'Question';
    }
    const answered = answers.filter((a) => a.length > 0).length;
    return `${answered} of ${questions.length} answered`;
  })();

  // -----------------------------------------------------------------------
  // Colors
  // -----------------------------------------------------------------------

  const borderColor = isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.08);
  const mutedColor = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const fgColor = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const themeColors = useThemeColors();
  const pillActiveBg = isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.05);
  const pillActiveBorder = isDark ? withAlpha(THEME.dark.foreground, 0.15) : withAlpha(THEME.light.foreground, 0.12);
  const selectedBg = isDark ? withAlpha(THEME.dark.foreground, 0.06) : withAlpha(THEME.light.foreground, 0.04);
  const selectedBorder = isDark ? withAlpha(THEME.dark.foreground, 0.15) : withAlpha(THEME.light.foreground, 0.12);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor,
        borderRadius: 14,
        overflow: 'hidden',
        marginHorizontal: 16,
        marginBottom: 6,
        backgroundColor: isDark ? THEME.dark.popover : THEME.light.popover,
      }}
    >
      {/* ── Header ── */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 10,
          paddingVertical: 6,
        }}
      >
        <Ionicons
          name="chatbubble-ellipses-outline"
          size={12}
          color={mutedColor}
        />
        <RNText
          style={{ flex: 1, fontSize: 11, marginLeft: 6, color: mutedColor, fontFamily: 'Roobert' }}
          numberOfLines={1}
        >
          {!isSingle && `${questions.length} questions \u00B7 `}
          <RNText style={{ color: isDark ? THEME.dark.foreground : THEME.light.foreground, fontFamily: 'Roobert-Medium', fontSize: 11 }}>
            {headerSummary}
          </RNText>
        </RNText>
        <Button
          variant="ghost"
          size="icon"
          onPress={reject}
          hitSlop={10}
          className="h-auto w-auto items-center justify-center p-0 active:bg-transparent active:opacity-70"
          style={{ width: 22, height: 22 }}
        >
          <Ionicons name="close" size={13} color={mutedColor} />
        </Button>
      </View>

      {/* ── Body ── */}
      <View style={{ borderTopWidth: 1, borderTopColor: borderColor }}>
        {/* Tab pills (multi-question only) */}
        {!isSingle && (
          <View style={{ borderBottomWidth: 1, borderBottomColor: borderColor }}>
            <ScrollView
              ref={tabScrollRef}
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{
                paddingHorizontal: 6,
                paddingVertical: 4,
                gap: 3,
              }}
            >
              {questions.map((q, i) => {
                const isAnswered = (answers[i]?.length ?? 0) > 0;
                const isActive = tab === i;
                return (
                  <Button
                    key={i}
                    variant="ghost"
                    onPress={() => { setTab(i); setEditing(false); }}
                    onLayout={(e) => {
                      tabLayouts.current[i] = {
                        x: e.nativeEvent.layout.x,
                        width: e.nativeEvent.layout.width,
                      };
                    }}
                    className="h-auto w-auto flex-row items-center active:bg-transparent active:opacity-80"
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 3,
                      borderRadius: 6,
                      borderWidth: 1,
                      borderColor: isActive ? pillActiveBorder : 'transparent',
                      backgroundColor: isActive ? pillActiveBg : 'transparent',
                      gap: 4,
                    }}
                  >
                    <View
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: 2.5,
                        borderWidth: 1.5,
                        borderColor: isAnswered ? fgColor : (isActive ? mutedColor : (isDark ? withAlpha(THEME.dark.foreground, 0.15) : withAlpha(THEME.light.foreground, 0.15))),
                        backgroundColor: isAnswered ? (isDark ? withAlpha(THEME.dark.foreground, 0.1) : withAlpha(THEME.light.foreground, 0.06)) : 'transparent',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {isAnswered && <Ionicons name="checkmark" size={8} color={fgColor} />}
                      {!isAnswered && isActive && (
                        <View style={{ width: 2.5, height: 2.5, borderRadius: 1.25, backgroundColor: fgColor }} />
                      )}
                    </View>
                    <RNText
                      style={{
                        fontSize: 12,
                        fontFamily: isActive ? 'Roobert-Medium' : 'Roobert',
                        color: isActive ? fgColor : mutedColor,
                      }}
                    >
                      {q.header || `Q${i + 1}`}
                    </RNText>
                  </Button>
                );
              })}

              <Button
                variant="ghost"
                onPress={() => { setTab(questions.length); setEditing(false); }}
                onLayout={(e) => {
                  tabLayouts.current[questions.length] = {
                    x: e.nativeEvent.layout.x,
                    width: e.nativeEvent.layout.width,
                  };
                }}
                className="h-auto w-auto active:bg-transparent active:opacity-80"
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: isConfirm ? pillActiveBorder : 'transparent',
                  backgroundColor: isConfirm ? pillActiveBg : 'transparent',
                }}
              >
                <RNText
                  style={{
                    fontSize: 12,
                    fontFamily: isConfirm ? 'Roobert-Medium' : 'Roobert',
                    color: isConfirm ? fgColor : mutedColor,
                  }}
                >
                  Confirm
                </RNText>
              </Button>
            </ScrollView>
          </View>
        )}

        {/* Content area */}
        <View style={{ paddingHorizontal: 8, paddingVertical: 6 }}>
          {isConfirm ? (
            /* ── Confirm / review tab ── */
            <View>
              {questions.map((q, i) => {
                const ans = answers[i] ?? [];
                const done = ans.length > 0;
                return (
                  <Button
                    key={i}
                    variant="ghost"
                    onPress={() => setTab(i)}
                    className="h-auto w-auto flex-row items-center justify-start rounded-none active:opacity-70"
                    style={{
                      paddingVertical: 4,
                      opacity: done ? 1 : 0.4,
                    }}
                  >
                    <View
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: 2.5,
                        borderWidth: 1.5,
                        borderColor: done ? fgColor : (isDark ? withAlpha(THEME.dark.foreground, 0.15) : withAlpha(THEME.light.foreground, 0.15)),
                        backgroundColor: done ? (isDark ? withAlpha(THEME.dark.foreground, 0.1) : withAlpha(THEME.light.foreground, 0.06)) : 'transparent',
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginRight: 7,
                      }}
                    >
                      {done && <Ionicons name="checkmark" size={8} color={fgColor} />}
                    </View>
                    <RNText
                      style={{ flex: 1, fontSize: 12, color: fgColor, fontFamily: 'Roobert' }}
                      numberOfLines={1}
                    >
                      {q.header || q.question}
                    </RNText>
                    <RNText
                      style={{ fontSize: 12, color: mutedColor, maxWidth: '40%', marginLeft: 6, fontFamily: 'Roobert' }}
                      numberOfLines={1}
                    >
                      {ans.length > 0 ? ans.join(', ') : '\u2014'}
                    </RNText>
                  </Button>
                );
              })}

              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8 }}>
                <Button
                  variant="ghost"
                  onPress={submit}
                  className="h-auto w-auto active:bg-transparent active:opacity-80"
                  style={{
                    backgroundColor: themeColors.primary,
                    paddingHorizontal: 16,
                    paddingVertical: 7,
                    borderRadius: 8,
                  }}
                >
                  <RNText
                    style={{
                      color: themeColors.primaryForeground,
                      fontSize: 13,
                      fontFamily: 'Roobert-Medium',
                    }}
                  >
                    Submit
                  </RNText>
                </Button>
              </View>
            </View>
          ) : currentQuestion ? (
            /* ── Question content ── */
            <View>
              {/* Question text */}
              <RNText
                style={{
                  fontSize: 12,
                  fontFamily: 'Roobert-Medium',
                  color: fgColor,
                  lineHeight: 16,
                  marginBottom: 2,
                }}
              >
                {currentQuestion.question}
                {isMulti && (
                  <RNText style={{ fontFamily: 'Roobert', fontStyle: 'italic', color: mutedColor }}>
                    {' '}(select multiple)
                  </RNText>
                )}
              </RNText>

              {/* Options — compact rows */}
              {options.map((opt, i) => {
                const isPicked = currentAnswers.includes(opt.label);
                return (
                  <Button
                    key={i}
                    variant="ghost"
                    onPress={() => selectOption(i)}
                    className="h-auto w-auto flex-row items-center justify-start active:bg-transparent active:opacity-80"
                    style={{
                      paddingHorizontal: 4,
                      paddingVertical: 3,
                      borderRadius: 6,
                      borderWidth: 1,
                      borderColor: isPicked ? selectedBorder : 'transparent',
                      backgroundColor: isPicked ? selectedBg : 'transparent',
                      gap: 6,
                    }}
                  >
                    <View
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: isMulti ? 2.5 : 6,
                        borderWidth: 1,
                        borderColor: isPicked ? fgColor : (isDark ? withAlpha(THEME.dark.foreground, 0.2) : withAlpha(THEME.light.foreground, 0.15)),
                        backgroundColor: isPicked ? (isDark ? withAlpha(THEME.dark.foreground, 0.1) : withAlpha(THEME.light.foreground, 0.06)) : 'transparent',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {isPicked && <Ionicons name="checkmark" size={8} color={fgColor} />}
                    </View>

                    <View style={{ flex: 1 }}>
                      <RNText style={{ fontSize: 14, lineHeight: 18, fontFamily: 'Roobert' }}>
                        <RNText
                          style={{
                            fontFamily: 'Roobert-Medium',
                            color: isPicked ? fgColor : (isDark ? withAlpha(THEME.dark.foreground, 0.8) : withAlpha(THEME.light.foreground, 0.8)),
                          }}
                        >
                          {opt.label}
                        </RNText>
                        {opt.description && (
                          <RNText style={{ color: mutedColor }}>
                            {' '}{opt.description}
                          </RNText>
                        )}
                      </RNText>
                    </View>
                  </Button>
                );
              })}

              {/* Type your own answer */}
              {showCustom && !editing && (
                <Button
                  variant="ghost"
                  onPress={() => selectOption(options.length)}
                  className="h-auto w-auto flex-row items-center justify-start active:bg-transparent active:opacity-70"
                  style={{
                    paddingHorizontal: 4,
                    paddingVertical: 3,
                    gap: 6,
                  }}
                >
                  <Ionicons
                    name="pencil-outline"
                    size={10}
                    color={isDark ? withAlpha(THEME.dark.foreground, 0.25) : withAlpha(THEME.light.foreground, 0.2)}
                  />
                  <RNText style={{ fontSize: 14, color: mutedColor, fontFamily: 'Roobert' }}>
                    Type your own answer
                  </RNText>
                </Button>
              )}

              {/* Custom input */}
              {editing && (
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 6 }}>
                  <TextInput
                    ref={inputRef}
                    placeholder="Type your answer..."
                    placeholderTextColor={mutedColor}
                    value={customInputs[tab]}
                    onChangeText={(t) => {
                      const next = [...customInputs];
                      next[tab] = t;
                      setCustomInputs(next);
                    }}
                    onSubmitEditing={() => handleCustomSubmit(customInputs[tab])}
                    returnKeyType={isMulti ? 'done' : 'go'}
                    style={{
                      flex: 1,
                      height: 32,
                      paddingHorizontal: 10,
                      fontSize: 13,
                      color: fgColor,
                      backgroundColor: isDark ? withAlpha(THEME.dark.foreground, 0.05) : withAlpha(THEME.light.foreground, 0.03),
                      borderWidth: 1,
                      borderColor: isDark ? withAlpha(THEME.dark.foreground, 0.1) : withAlpha(THEME.light.foreground, 0.08),
                      borderRadius: 7,
                    }}
                  />
                  <Button
                    variant="ghost"
                    onPress={() => handleCustomSubmit(customInputs[tab])}
                    className="h-auto w-auto items-center justify-center active:bg-transparent active:opacity-80"
                    style={{
                      height: 32,
                      paddingHorizontal: 10,
                      backgroundColor: themeColors.primary,
                      borderRadius: 7,
                    }}
                  >
                    <RNText style={{ color: themeColors.primaryForeground, fontSize: 12, fontFamily: 'Roobert-Medium' }}>
                      {isMulti ? 'Add' : 'Go'}
                    </RNText>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onPress={() => { setEditing(false); Keyboard.dismiss(); }}
                    hitSlop={8}
                    className="h-auto w-auto items-center justify-center p-0 active:bg-transparent active:opacity-70"
                    style={{ width: 32, height: 32 }}
                  >
                    <Ionicons name="close" size={14} color={mutedColor} />
                  </Button>
                </View>
              )}

              {/* Next button for multi-select */}
              {!isSingle && isMulti && !editing && (
                <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 6 }}>
                  <Button
                    variant="ghost"
                    onPress={() => { setTab(tab + 1); setEditing(false); }}
                    disabled={currentAnswers.length === 0}
                    className="h-auto w-auto active:bg-transparent active:opacity-80"
                    style={{
                      paddingHorizontal: 14,
                      paddingVertical: 6,
                      borderRadius: 7,
                      backgroundColor: currentAnswers.length > 0
                        ? (isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.05))
                        : (isDark ? withAlpha(THEME.dark.foreground, 0.03) : withAlpha(THEME.light.foreground, 0.02)),
                    }}
                  >
                    <RNText
                      style={{
                        fontSize: 12,
                        fontFamily: 'Roobert-Medium',
                        color: currentAnswers.length > 0 ? fgColor : mutedColor,
                      }}
                    >
                      Next
                    </RNText>
                  </Button>
                </View>
              )}
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}
