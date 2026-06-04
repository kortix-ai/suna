/**
 * QuestionPrompt — compact mobile-native question UI for OpenCode sessions.
 *
 * Renders inside the chat input card area, replacing the text input.
 * Compact sizing to match the frontend's inline chip style.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Keyboard,
  Text as RNText,
} from 'react-native';
import { Text } from '@/components/ui/text';
import { useColorScheme } from 'nativewind';
import { Ionicons } from '@expo/vector-icons';
import { useThemeColors } from '@/lib/theme-colors';
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

  const borderColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const mutedColor = isDark ? '#888' : '#777';
  const fgColor = isDark ? '#F8F8F8' : '#121215';
  const themeColors = useThemeColors();
  const pillActiveBg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)';
  const pillActiveBorder = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)';
  const selectedBg = isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.04)';
  const selectedBorder = isDark ? 'rgba(248,248,248,0.15)' : 'rgba(18,18,21,0.12)';

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
        backgroundColor: isDark ? '#1a1a1d' : '#ffffff',
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
          <RNText style={{ color: isDark ? '#ccc' : '#444', fontFamily: 'Roobert-Medium', fontSize: 11 }}>
            {headerSummary}
          </RNText>
        </RNText>
        <TouchableOpacity
          onPress={reject}
          hitSlop={10}
          style={{ width: 22, height: 22, alignItems: 'center', justifyContent: 'center' }}
          activeOpacity={0.6}
        >
          <Ionicons name="close" size={13} color={mutedColor} />
        </TouchableOpacity>
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
                  <TouchableOpacity
                    key={i}
                    onPress={() => { setTab(i); setEditing(false); }}
                    onLayout={(e) => {
                      tabLayouts.current[i] = {
                        x: e.nativeEvent.layout.x,
                        width: e.nativeEvent.layout.width,
                      };
                    }}
                    activeOpacity={0.7}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
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
                        borderColor: isAnswered ? fgColor : (isActive ? mutedColor : (isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)')),
                        backgroundColor: isAnswered ? (isDark ? 'rgba(248,248,248,0.1)' : 'rgba(18,18,21,0.06)') : 'transparent',
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
                  </TouchableOpacity>
                );
              })}

              <TouchableOpacity
                onPress={() => { setTab(questions.length); setEditing(false); }}
                onLayout={(e) => {
                  tabLayouts.current[questions.length] = {
                    x: e.nativeEvent.layout.x,
                    width: e.nativeEvent.layout.width,
                  };
                }}
                activeOpacity={0.7}
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
              </TouchableOpacity>
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
                  <TouchableOpacity
                    key={i}
                    onPress={() => setTab(i)}
                    activeOpacity={0.6}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
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
                        borderColor: done ? fgColor : (isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)'),
                        backgroundColor: done ? (isDark ? 'rgba(248,248,248,0.1)' : 'rgba(18,18,21,0.06)') : 'transparent',
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
                  </TouchableOpacity>
                );
              })}

              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8 }}>
                <TouchableOpacity
                  onPress={submit}
                  activeOpacity={0.8}
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
                </TouchableOpacity>
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
                  <TouchableOpacity
                    key={i}
                    onPress={() => selectOption(i)}
                    activeOpacity={0.7}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
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
                        borderColor: isPicked ? fgColor : (isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)'),
                        backgroundColor: isPicked ? (isDark ? 'rgba(248,248,248,0.1)' : 'rgba(18,18,21,0.06)') : 'transparent',
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
                            color: isPicked ? fgColor : (isDark ? 'rgba(248,248,248,0.8)' : 'rgba(18,18,21,0.8)'),
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
                  </TouchableOpacity>
                );
              })}

              {/* Type your own answer */}
              {showCustom && !editing && (
                <TouchableOpacity
                  onPress={() => selectOption(options.length)}
                  activeOpacity={0.7}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 4,
                    paddingVertical: 3,
                    gap: 6,
                  }}
                >
                  <Ionicons
                    name="pencil-outline"
                    size={10}
                    color={isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)'}
                  />
                  <RNText style={{ fontSize: 14, color: mutedColor, fontFamily: 'Roobert' }}>
                    Type your own answer
                  </RNText>
                </TouchableOpacity>
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
                      backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
                      borderWidth: 1,
                      borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
                      borderRadius: 7,
                    }}
                  />
                  <TouchableOpacity
                    onPress={() => handleCustomSubmit(customInputs[tab])}
                    activeOpacity={0.8}
                    style={{
                      height: 32,
                      paddingHorizontal: 10,
                      backgroundColor: themeColors.primary,
                      borderRadius: 7,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <RNText style={{ color: themeColors.primaryForeground, fontSize: 12, fontFamily: 'Roobert-Medium' }}>
                      {isMulti ? 'Add' : 'Go'}
                    </RNText>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => { setEditing(false); Keyboard.dismiss(); }}
                    hitSlop={8}
                    style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}
                    activeOpacity={0.6}
                  >
                    <Ionicons name="close" size={14} color={mutedColor} />
                  </TouchableOpacity>
                </View>
              )}

              {/* Next button for multi-select */}
              {!isSingle && isMulti && !editing && (
                <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 6 }}>
                  <TouchableOpacity
                    onPress={() => { setTab(tab + 1); setEditing(false); }}
                    disabled={currentAnswers.length === 0}
                    activeOpacity={0.8}
                    style={{
                      paddingHorizontal: 14,
                      paddingVertical: 6,
                      borderRadius: 7,
                      backgroundColor: currentAnswers.length > 0
                        ? (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)')
                        : (isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)'),
                      opacity: currentAnswers.length > 0 ? 1 : 0.4,
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
                  </TouchableOpacity>
                </View>
              )}
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}
