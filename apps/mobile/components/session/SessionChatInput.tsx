/**
 * SessionChatInput — chat input with agent/model/variant toolbar and @mentions.
 *
 * Matches the Computer frontend's chat input:
 * - Left toolbar: Agent selector, Model selector, Variant (thinking) toggle
 * - Right toolbar: Send / Stop buttons
 * - Multiline text input
 * - @mention autocomplete for files, agents, and sessions
 */

import React, { forwardRef, useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  TextInput,
  ScrollView,
  Platform,
  Animated,
  StyleSheet,
  ActionSheetIOS,
  Alert,
  Image,
  Keyboard,
  useWindowDimensions,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { useColorScheme } from 'nativewind';
import { Ionicons } from '@expo/vector-icons';
import {
  Infinity as InfinityIcon,
  Slash as SlashIcon,
  Info as InfoIcon,
  X as XIcon,
  Plus as PlusIcon,
  Paperclip as PaperclipIcon,
  Settings as SettingsIcon,
  ChevronRight as ChevronRightIcon,
} from 'lucide-react-native';
import { Icon } from '@/components/ui/icon';
import { BottomSheetModal, BottomSheetView, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { getAuthToken } from '@/api/config';

import type { Agent, FlatModel, Command } from '@/lib/opencode/hooks/use-opencode-data';
import type { Session } from '@/lib/platform/types';
import { MentionSuggestions } from './MentionSuggestions';
import { useMentions, type TrackedMention, type MentionItem } from './useMentions';
import { Text as RNText } from 'react-native';
import { useThemeColors, getToggleTrackBg, getToggleActiveBg, getSheetBg } from '@/lib/theme-colors';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { SheetBackdrop, sheetHandleIndicatorStyle, useSheetBackground } from '@/components/kortix/sheet';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AttachedFile {
  /** Local URI on device (file:// or content://) */
  uri: string;
  /** Display name */
  name: string;
  /** MIME type */
  mimeType: string;
  /** File size in bytes (may be undefined for some pickers) */
  size?: number;
  /** True if this is an image and should show a preview thumbnail */
  isImage: boolean;
}

export interface PromptOptions {
  agent?: string;
  model?: { providerID: string; modelID: string };
  variant?: string;
}

export type { TrackedMention } from './useMentions';

// ─── AutoContinue configuration (shared with frontend) ────────────────────────

export type AutoContinueMode = 'autowork' | 'autowork1' | 'autowork2' | 'autowork3';

interface AutoContinueAlgorithm {
  id: AutoContinueMode;
  label: string;
  role: string;
  description: string;
  commandName: string;
  bestFor: string;
  strengths: string[];
  weaknesses: string[];
  howItWorks: string;
}

const AUTOCONTINUE_ALGORITHMS: AutoContinueAlgorithm[] = [
  {
    id: 'autowork',
    label: 'Kraemer',
    role: 'Connector',
    description: 'Fast TDD loop — reliable for clear specs',
    commandName: 'autowork',
    bestFor: 'Clear specs, coding tasks, "just build it" work',
    strengths: [
      'Reliable and balanced speed/cost',
      'Solid TDD discipline — writes tests first, implements, verifies',
      'No overhead from extra validation passes',
    ],
    weaknesses: [
      'Can miss subtle edge cases that need deeper second-pass reasoning',
      'No adversarial self-review — trusts its own DONE claim',
    ],
    howItWorks:
      'The original autowork algorithm. Runs an autonomous loop where the agent works until it emits DONE, then enters a verification phase where it self-reviews and emits VERIFIED. Simple binary loop — no staged validators, no critic, no phase system.',
  },
  {
    id: 'autowork1',
    label: 'Kubet',
    role: 'Validator',
    description: 'Adversarial review — catches hidden issues',
    commandName: 'autowork1',
    bestFor: 'Correctness-critical tasks — ops planning, complex logic, risk analysis',
    strengths: [
      'Catches hidden issues through forced adversarial self-review',
      'Most reliable outcomes across all task types',
      '3-level validator pipeline ensures nothing slips through',
      'Async process critic monitors efficiency during work',
    ],
    weaknesses: [
      'Slower and more expensive due to validation passes',
      'May over-engineer simple tasks that do not need 3 levels of review',
    ],
    howItWorks:
      'After the agent claims DONE, the system drives it through a 3-level validator pipeline. Level 1 (Format) — Are all files valid? Does the build pass? Any syntax errors? Level 2 (Quality) — Do tests pass? Are requirements traced? Any anti-patterns? Level 3 (Top-notch) — Adversarial edge cases, performance review, regression sweep. The agent must pass each level before advancing. An async critic also nudges the agent if it stalls.',
  },
  {
    id: 'autowork2',
    label: 'Ino',
    role: 'Decomposer',
    description: 'Kanban cards — structured per-module work',
    commandName: 'autowork2',
    bestFor: 'Multi-domain tasks — investigations, audits, research, modular systems',
    strengths: [
      'Strong structured breakdown into discrete work units',
      'Each card goes through its own review/test cycle',
      'Thorough coverage of individual domains',
    ],
    weaknesses: [
      'Can underscope if it misses cards for certain requirements',
      'Integration mistakes between independently built parts',
      'Most expensive due to per-card overhead',
    ],
    howItWorks:
      'Work is organized as a kanban board with explicit prefixes: [BACKLOG], [IN PROGRESS], [REVIEW], [TESTING], [DONE]. Cards advance sequentially and the system enforces progress markers. After all cards hit [DONE], a final integration check runs.',
  },
  {
    id: 'autowork3',
    label: 'Saumya',
    role: 'Architect',
    description: 'Entropy search — diverge then compress',
    commandName: 'autowork3',
    bestFor: 'Design, strategy, architecture — problems with ambiguity',
    strengths: [
      'Fastest and cheapest across all tasks',
      'Produces clean, well-architected solutions',
      'Genuine strategic exploration — not fake variations',
    ],
    weaknesses: [
      'Implementation detail correctness can slip',
      'Upfront exploration adds no value on spec-driven tasks',
      'Tests may validate components without catching integration bugs',
    ],
    howItWorks:
      'Uses five entropy-phased stages: EXPAND (diverge problem framings), BRANCH (crystallize distinct candidates), ATTACK (candidates cross-attack), RANK (score + pick one path), COMPRESS (execute winner with TDD). Phase markers ensure it does not converge early.',
  },
];

const DEFAULT_AUTOCONTINUE_MODE: AutoContinueMode = 'autowork';

interface SessionChatInputProps {
  onSend: (text: string, options: PromptOptions, mentions?: TrackedMention[]) => void;
  onStop?: () => void;
  isBusy?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Agent/model/variant config */
  agent?: Agent | null;
  agents?: Agent[];
  model?: FlatModel | null;
  models?: FlatModel[];
  modelKey?: { providerID: string; modelID: string } | null;
  variant?: string | null;
  variants?: string[];
  onAgentChange?: (name: string) => void;
  onModelChange?: (providerID: string, modelID: string) => void;
  onVariantCycle?: () => void;
  onVariantSet?: (variant: string | null) => void;
  /** Data for @mentions */
  sessions?: Session[];
  currentSessionId?: string | null;
  sandboxUrl?: string;
  /** Called when the user submits while agent is busy — enqueue instead of send */
  onEnqueue?: (text: string) => void;
  /** Slot rendered above the text input inside the card (used for queue UI) */
  inputSlot?: React.ReactNode;
  /** Emits whether the draft currently has non-whitespace content */
  onDraftChange?: (hasText: boolean) => void;
  /** Slash commands fetched from server */
  commands?: Command[];
  /** Called when a command is submitted (staged command + optional args) */
  onCommand?: (command: Command, args?: string) => void;
  /** Hides config toolbar (agent/model/variant selectors) — used for onboarding */
  onboardingMode?: boolean;
  /** Initial text to populate the input with (e.g. restored after question prompt) */
  initialText?: string;
  /** Called whenever the input text changes — used to track current text externally */
  onTextChange?: (text: string) => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function SessionChatInput({
  onSend,
  onStop,
  isBusy = false,
  disabled = false,
  placeholder = 'Ask anything...',
  agent,
  agents = [],
  model,
  models = [],
  modelKey,
  variant,
  variants = [],
  onAgentChange,
  onModelChange,
  onVariantCycle,
  onVariantSet,
  sessions = [],
  currentSessionId,
  sandboxUrl,
  onEnqueue,
  inputSlot,
  onDraftChange,
  commands = [],
  onCommand,
  onboardingMode = false,
  initialText = '',
  onTextChange,
}: SessionChatInputProps) {
  const [text, setText] = useState(initialText);
  const inputRef = useRef<TextInput>(null);
  const cursorRef = useRef(0);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const themeColors = useThemeColors();

  // Config sheet — imperative BottomSheetModal ref (same pattern as ProjectPicker).
  const configSheetRef = useRef<BottomSheetModal>(null);
  const openConfigSheet = useCallback(() => {
    Keyboard.dismiss();
    requestAnimationFrame(() => {
      configSheetRef.current?.present();
    });
  }, []);

  // ── Slash commands ───────────────────────────────────────────────────────

  const [slashFilter, setSlashFilter] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [stagedCommand, setStagedCommand] = useState<Command | null>(null);

  // ── Mentions ────────────────────────────────────────────────────────────

  const mention = useMentions({
    agents,
    sessions,
    currentSessionId,
    sandboxUrl,
  });

  const [autocontinueMode, setAutocontinueMode] = useState<AutoContinueMode | null>(null);
  const [showAutoSheet, setShowAutoSheet] = useState(false);
  const [showActionsSheet, setShowActionsSheet] = useState(false);

  // ── File attachments ─────────────────────────────────────────────────────

  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  const removeAttachedFile = useCallback((index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const addFiles = useCallback((files: AttachedFile[]) => {
    setAttachedFiles((prev) => [...prev, ...files]);
  }, []);

  const handleAttachPress = useCallback(() => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['Cancel', 'Photo Library', 'Camera', 'Browse Files'],
          cancelButtonIndex: 0,
        },
        async (buttonIndex) => {
          if (buttonIndex === 1) {
            const result = await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ['images'],
              allowsMultipleSelection: true,
              quality: 0.9,
            });
            if (!result.canceled) {
              addFiles(result.assets.map((a) => ({
                uri: a.uri,
                name: a.fileName || a.uri.split('/').pop() || 'image.jpg',
                mimeType: a.mimeType || 'image/jpeg',
                size: a.fileSize,
                isImage: true,
              })));
            }
          } else if (buttonIndex === 2) {
            const { status } = await ImagePicker.requestCameraPermissionsAsync();
            if (status !== 'granted') {
              Alert.alert('Permission required', 'Camera access is needed to take photos.');
              return;
            }
            const result = await ImagePicker.launchCameraAsync({ quality: 0.9 });
            if (!result.canceled) {
              addFiles([{
                uri: result.assets[0].uri,
                name: result.assets[0].fileName || `photo_${Date.now()}.jpg`,
                mimeType: result.assets[0].mimeType || 'image/jpeg',
                size: result.assets[0].fileSize,
                isImage: true,
              }]);
            }
          } else if (buttonIndex === 3) {
            const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
            if (!result.canceled) {
              addFiles(result.assets.map((a) => ({
                uri: a.uri,
                name: a.name,
                mimeType: a.mimeType || 'application/octet-stream',
                size: a.size,
                isImage: (a.mimeType || '').startsWith('image/'),
              })));
            }
          }
        },
      );
    } else {
      // Android: use a simple Alert for choice
      Alert.alert('Attach file', 'Choose source', [
        {
          text: 'Photo Library',
          onPress: async () => {
            const result = await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ['images'],
              allowsMultipleSelection: true,
              quality: 0.9,
            });
            if (!result.canceled) {
              addFiles(result.assets.map((a) => ({
                uri: a.uri,
                name: a.fileName || a.uri.split('/').pop() || 'image.jpg',
                mimeType: a.mimeType || 'image/jpeg',
                size: a.fileSize,
                isImage: true,
              })));
            }
          },
        },
        {
          text: 'Browse Files',
          onPress: async () => {
            const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
            if (!result.canceled) {
              addFiles(result.assets.map((a) => ({
                uri: a.uri,
                name: a.name,
                mimeType: a.mimeType || 'application/octet-stream',
                size: a.size,
                isImage: (a.mimeType || '').startsWith('image/'),
              })));
            }
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }, [addFiles]);

  const availableAutoAlgorithms = useMemo(
    () =>
      AUTOCONTINUE_ALGORITHMS.filter((alg) =>
        Array.isArray(commands) && commands.some((c) => c.name === alg.commandName),
      ),
    [commands],
  );

  const currentAutoAlgorithm = useMemo(
    () => availableAutoAlgorithms.find((alg) => alg.id === autocontinueMode) || null,
    [availableAutoAlgorithms, autocontinueMode],
  );

  useEffect(() => {
    if (autocontinueMode && !currentAutoAlgorithm) {
      setAutocontinueMode(null);
    }
  }, [autocontinueMode, currentAutoAlgorithm]);

  const handleTextChange = useCallback(
    (newText: string) => {
      setText(newText);
      onTextChange?.(newText);
      cursorRef.current = newText.length;
      mention.handleTextChange(newText, newText.length);

      // Slash command detection (disabled while a command is staged)
      if (!stagedCommand) {
        const match = newText.match(/^\/(\S*)$/);
        if (match) {
          setSlashFilter(match[1]);
          setSlashIndex(0);
        } else {
          setSlashFilter(null);
        }
      }
    },
    [mention, stagedCommand],
  );

  const handleSelectionChange = useCallback(
    (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      cursorRef.current = e.nativeEvent.selection.end;
    },
    [],
  );

  const handleMentionSelect = useCallback(
    (item: MentionItem) => {
      const newText = mention.selectMention(item, text);
      setText(newText);
      cursorRef.current = newText.length;
      setTimeout(() => inputRef.current?.focus(), 50);
    },
    [mention, text],
  );

  const filteredCommands = useMemo(() => {
    if (slashFilter === null) return [];
    const q = slashFilter.toLowerCase();
    return commands.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.description && c.description.toLowerCase().includes(q)),
    );
  }, [commands, slashFilter]);

  const handleSelectCommand = useCallback(
    (cmd: Command) => {
      setStagedCommand(cmd);
      setText('');
      setSlashFilter(null);
      setSlashIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    },
    [],
  );

  // ── Animated placeholder ────────────────────────────────────────────────
  const placeholderVariants = useMemo(
    () => [
      placeholder,
      'Ask about any file in this project',
      'Ask for changed files and diffs',
      'Ask to compact when context is full',
      'Reference files with @',
    ],
    [placeholder],
  );

  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const slideAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (text.trim().length > 0) return;

    const interval = setInterval(() => {
      // Exit: fade out + slide up
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(slideAnim, {
          toValue: -8,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start(() => {
        // Switch text
        setPlaceholderIndex((i) => (i + 1) % placeholderVariants.length);
        // Reset position to below
        slideAnim.setValue(8);
        // Enter: fade in + slide up to center
        Animated.parallel([
          Animated.timing(fadeAnim, {
            toValue: 1,
            duration: 350,
            useNativeDriver: true,
          }),
          Animated.timing(slideAnim, {
            toValue: 0,
            duration: 350,
            useNativeDriver: true,
          }),
        ]).start();
      });
    }, 6000);

    return () => clearInterval(interval);
  }, [text, placeholderVariants.length, fadeAnim, slideAnim]);

  // Reset animation when user clears input
  useEffect(() => {
    if (text.trim().length === 0) {
      fadeAnim.setValue(1);
      slideAnim.setValue(0);
    }
  }, [text, fadeAnim, slideAnim]);

  const showAnimatedPlaceholder = text.trim().length === 0 && !inputSlot && !stagedCommand;
  // ────────────────────────────────────────────────────────────────────────

  const canSend = (text.trim().length > 0 || attachedFiles.length > 0) && !disabled && !isUploading;
  const hasDraftText = text.trim().length > 0;
  const hasContent = text.trim().length > 0 || attachedFiles.length > 0;

  useEffect(() => {
    onDraftChange?.(hasDraftText);
  }, [hasDraftText, onDraftChange]);

  const hasToolbar = agents.length > 0 || models.length > 0;

  const handleSubmit = useCallback(async () => {
    // Slash command popover open — select highlighted command
    if (slashFilter !== null && filteredCommands.length > 0) {
      handleSelectCommand(filteredCommands[slashIndex]);
      return;
    }

    if (mention.isOpen) {
      mention.dismiss();
      return;
    }

    // Staged command — execute it with args
    if (stagedCommand) {
      const args = text.trim();
      onCommand?.(stagedCommand, args || undefined);
      setText('');
      setStagedCommand(null);
      return;
    }

    const trimmed = text.trim();
    if (!trimmed || disabled) return;

    // Dismiss the keyboard on send so the user sees the new message land
    // (matches WhatsApp / iMessage behavior on phones).
    Keyboard.dismiss();

    if (autocontinueMode && onCommand) {
      const alg = AUTOCONTINUE_ALGORITHMS.find((a) => a.id === autocontinueMode);
      const command = alg && commands.find((c) => c.name === alg.commandName);
      if (command) {
        onCommand(command, trimmed || undefined);
        setText('');
        setSlashFilter(null);
        setSlashIndex(0);
        mention.reset();
        return;
      }
    }

    // If the agent is busy and we have an enqueue handler, queue instead of sending
    if (isBusy && onEnqueue) {
      onEnqueue(trimmed);
      setText('');
      mention.reset();
      return;
    }

    const options: PromptOptions = {};
    if (agent?.name) options.agent = agent.name;
    if (modelKey) options.model = modelKey;
    if (variant) options.variant = variant;

    const trackedMentions = mention.mentions.length > 0 ? [...mention.mentions] : undefined;
    const filesToUpload = [...attachedFiles];

    // Clear input immediately for snappy UX
    setText('');
    setAttachedFiles([]);
    mention.reset();

    if (filesToUpload.length > 0 && sandboxUrl) {
      setIsUploading(true);
      try {
        const xmlParts: string[] = [];

        // Upload files. The server (/file/upload) guarantees collision-free
        // destinations — if two files share a name it auto-suffixes and
        // returns the actual written path. (Ported from web 04f8296.)
        await Promise.all(
          filesToUpload.map(async (f, idx) => {
            const safeName = f.name.replace(/[^a-zA-Z0-9._-]/g, '_');
            const optimisticPath = `/workspace/uploads/${safeName}`;

            const formData = new FormData();
            formData.append('path', '/workspace/uploads');
            formData.append('file', { uri: f.uri, name: safeName, type: f.mimeType } as any);

            const token = await getAuthToken();
            const res = await fetch(`${sandboxUrl}/file/upload`, {
              method: 'POST',
              headers: token ? { Authorization: `Bearer ${token}` } : {},
              body: formData,
            });

            // Use the server-returned path (collision-free) or fall back to optimistic
            const uploadedPath = res.ok
              ? ((await res.json() as Array<{ path: string }>)[0]?.path ?? optimisticPath)
              : optimisticPath;

            xmlParts[idx] = `<file path="${uploadedPath}" mime="${f.mimeType}" filename="${f.name}">\nThis file has been uploaded and is available at the path above.\n</file>`;
          }),
        );

        const xmlBlock = xmlParts.join('\n');
        const finalText = xmlBlock ? `${trimmed}\n\n${xmlBlock}` : trimmed;
        onSend(finalText, options, trackedMentions);
      } catch {
        // Upload failed — still send the message without file refs
        onSend(trimmed, options, trackedMentions);
      } finally {
        setIsUploading(false);
      }
    } else {
      onSend(trimmed, options, trackedMentions);
    }
  }, [text, disabled, onSend, agent, modelKey, variant, mention, isBusy, onEnqueue, slashFilter, filteredCommands, slashIndex, handleSelectCommand, stagedCommand, onCommand, autocontinueMode, commands, attachedFiles, sandboxUrl]);

  // Variant display
  const variantLabel = variant
    ? variant.charAt(0).toUpperCase() + variant.slice(1)
    : 'Default';

  return (
    <>
      <View>
        {/* Slash command suggestions — above the input */}
        {slashFilter !== null && filteredCommands.length > 0 && (
          <SlashCommandSuggestions
            commands={filteredCommands}
            selectedIndex={slashIndex}
            onSelect={handleSelectCommand}
            isDark={isDark}
          />
        )}

        {/* Mention suggestions — above the input (same condition as frontend) */}
        {slashFilter === null && mention.isOpen && (mention.items.length > 0 || mention.fileSearchLoading) && (
          <MentionSuggestions
            items={mention.items}
            selectedIndex={mention.selectedIndex}
            isLoading={mention.fileSearchLoading}
            onSelect={handleMentionSelect}
          />
        )}

        {/* Text input area */}
        <View className="px-3 pt-1 pb-2">
          <View className="rounded-2xl px-3 pt-2 pb-1 bg-card border border-border">
            {/* Queue / question slot — rendered above textarea */}
            {inputSlot}

            {/* Attached file previews */}
            {attachedFiles.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ marginBottom: 6 }}
                contentContainerStyle={{ gap: 6, paddingVertical: 2 }}
              >
                {attachedFiles.map((f, idx) => (
                  <View
                    key={idx}
                    style={{
                      position: 'relative',
                      borderRadius: 8,
                      overflow: 'hidden',
                      backgroundColor: isDark ? withAlpha(THEME.dark.foreground, 0.06) : withAlpha(THEME.light.foreground, 0.04),
                    }}
                  >
                    {f.isImage ? (
                      <Image
                        source={{ uri: f.uri }}
                        style={{ width: 52, height: 52, borderRadius: 8 }}
                        resizeMode="cover"
                      />
                    ) : (
                      <View style={{ width: 52, height: 52, alignItems: 'center', justifyContent: 'center', padding: 4 }}>
                        <Ionicons name="document-outline" size={22} color={isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground} />
                        <RNText
                          numberOfLines={2}
                          style={{ fontSize: 9, color: isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground, textAlign: 'center', marginTop: 2 }}
                        >
                          {f.name}
                        </RNText>
                      </View>
                    )}
                    {/* Remove button */}
                    <Button
                      variant="ghost"
                      className="h-auto w-auto gap-0 rounded-full p-0 active:bg-transparent active:opacity-20"
                      onPress={() => removeAttachedFile(idx)}
                      style={{
                        position: 'absolute',
                        top: 2,
                        right: 2,
                        width: 16,
                        height: 16,
                        borderRadius: 8,
                        // Fixed dark scrim + light icon regardless of app
                        // theme — this overlay sits on top of an arbitrary
                        // user photo/file thumbnail, not a themed surface.
                        backgroundColor: withAlpha(THEME.light.foreground, 0.55),
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      hitSlop={4}
                    >
                      <XIcon size={9} color={THEME.dark.foreground} strokeWidth={3} />
                    </Button>
                  </View>
                ))}
              </ScrollView>
            )}

            {/* Staged command badge */}
            {stagedCommand && (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingBottom: 6,
                  gap: 8,
                }}
              >
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 10,
                    paddingVertical: 5,
                    borderRadius: 8,
                    backgroundColor: isDark ? withAlpha(THEME.dark.foreground, 0.06) : withAlpha(THEME.light.foreground, 0.04),
                    borderWidth: 1,
                    borderColor: isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.06),
                  }}
                >
                  <Ionicons
                    name="terminal-outline"
                    size={12}
                    color={isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground}
                    style={{ marginRight: 6 }}
                  />
                  <RNText
                    style={{
                      fontSize: 13,
                      fontFamily: 'Roobert-Medium',
                      color: isDark ? THEME.dark.foreground : THEME.light.foreground,
                      maxWidth: 220,
                    }}
                    numberOfLines={1}
                  >
                    /{stagedCommand.name}
                  </RNText>
                  <Button
                    variant="ghost"
                    className="h-auto w-auto gap-0 rounded-md p-0 active:bg-transparent active:opacity-20"
                    onPress={() => { setStagedCommand(null); setText(''); }}
                    hitSlop={8}
                    style={{ marginLeft: 6 }}
                  >
                    <Ionicons name="close" size={12} color={isDark ? THEME.light.mutedForeground : THEME.dark.mutedForeground} />
                  </Button>
                </View>
                {stagedCommand.description && (
                  <RNText
                    numberOfLines={1}
                    style={{
                      fontSize: 11,
                      fontFamily: 'Roobert',
                      color: isDark ? THEME.light.mutedForeground : THEME.dark.mutedForeground,
                      flex: 1,
                    }}
                  >
                    {stagedCommand.description}
                  </RNText>
                )}
              </View>
            )}

            <>
                {/* TextInput + animated placeholder wrapper */}
                <View style={{ position: 'relative' }}>
                  {showAnimatedPlaceholder && (
                    <Animated.Text
                      pointerEvents="none"
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: Platform.OS === 'ios' ? 5 : 3,
                        fontSize: 14,
                        color: isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground,
                        opacity: fadeAnim,
                        transform: [{ translateY: slideAnim }],
                        zIndex: 1,
                      }}
                    >
                      {placeholderVariants[placeholderIndex]}
                    </Animated.Text>
                  )}
                  <TextInput
                    ref={inputRef}
                    value={text}
                    onChangeText={handleTextChange}
                    onSelectionChange={handleSelectionChange}
                    placeholder={stagedCommand ? 'Enter details and press send, or tap X to cancel' : ''}
                    placeholderTextColor={isDark ? THEME.light.mutedForeground : THEME.dark.mutedForeground}
                    multiline
                    maxLength={10000}
                    style={{
                      maxHeight: 100,
                      fontSize: 14,
                      lineHeight: 20,
                      color: isDark ? THEME.dark.foreground : THEME.light.foreground,
                      paddingTop: Platform.OS === 'ios' ? 5 : 3,
                      paddingBottom: Platform.OS === 'ios' ? 5 : 3,
                      minHeight: 32,
                    }}
                    onSubmitEditing={handleSubmit}
                    blurOnSubmit={false}
                    returnKeyType="default"
                    editable={!disabled}
                  />
                </View>

                {/* Compact toolbar row — minimal like Slack */}
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 4, paddingBottom: 2 }}>
                  {/* Left: "+" button + compact context indicators */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    {!onboardingMode && (
                      <Button
                        variant="ghost"
                        className="h-auto w-auto gap-0 rounded-full p-0 active:bg-transparent active:opacity-70"
                        onPress={() => setShowActionsSheet(true)}
                        hitSlop={6}
                        style={{
                          width: 26,
                          height: 26,
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderRadius: 13,
                          backgroundColor: isDark ? withAlpha(THEME.dark.foreground, 0.06) : withAlpha(THEME.light.foreground, 0.04),
                        }}
                      >
                        <PlusIcon size={14} color={isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground} strokeWidth={2} />
                      </Button>
                    )}

                    {/* Compact config label */}
                    <Button
                      variant="ghost"
                      className="h-auto w-auto gap-0 rounded-full p-0 active:bg-transparent active:opacity-70"
                      onPress={openConfigSheet}
                      hitSlop={6}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 6,
                        paddingVertical: 3,
                        borderRadius: 12,
                      }}
                    >
                      <Text
                        numberOfLines={1}
                        style={{
                          fontSize: 13,
                          fontFamily: 'Roobert',
                          color: isDark ? THEME.light.mutedForeground : THEME.dark.mutedForeground,
                          maxWidth: 140,
                        }}
                      >
                        {agent?.name ? agent.name.charAt(0).toUpperCase() + agent.name.slice(1) : 'Agent'}
                        {model?.modelName ? ` · ${model.modelName}` : ''}
                        {variant ? ` · ${variantLabel}` : ''}
                      </Text>
                      <Ionicons
                        name="chevron-down"
                        size={9}
                        color={isDark ? THEME.dark.border : THEME.light.border}
                        style={{ marginLeft: 2 }}
                      />
                    </Button>

                    {/* Compact autocontinue indicator — only when mode is active */}
                    {!!autocontinueMode && currentAutoAlgorithm && (
                      <Button
                        variant="ghost"
                        className="h-auto w-auto gap-0 rounded-full p-0 active:bg-transparent active:opacity-70"
                        onPress={() => setShowAutoSheet(true)}
                        hitSlop={6}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          paddingHorizontal: 6,
                          paddingVertical: 3,
                          borderRadius: 10,
                          backgroundColor: withAlpha(THEME.accent.purple, isDark ? 0.15 : 0.12),
                        }}
                      >
                        <View style={{
                          width: 5,
                          height: 5,
                          borderRadius: 2.5,
                          backgroundColor: THEME.accent.purple,
                          marginRight: 4,
                        }} />
                        <Text
                          style={{
                            fontSize: 11,
                            fontFamily: 'Roobert-Medium',
                            color: THEME.accent.purple,
                          }}
                          numberOfLines={1}
                        >
                          {currentAutoAlgorithm.label}
                        </Text>
                      </Button>
                    )}
                  </View>

                  {/* Right: queue + send/stop */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {isBusy && canSend && onEnqueue && (
                      <Button
                        variant="ghost"
                        className="h-auto w-auto gap-0 rounded-full p-0 active:bg-transparent active:opacity-70"
                        onPress={handleSubmit}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          paddingHorizontal: 8,
                          paddingVertical: 3,
                          borderRadius: 12,
                          backgroundColor: isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.06),
                        }}
                      >
                        <Ionicons name="list-outline" size={11} color={isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground} style={{ marginRight: 3 }} />
                        <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground }}>
                          Queue
                        </Text>
                      </Button>
                    )}
                    {isBusy ? (
                      <Button
                        variant="ghost"
                        className="h-auto w-auto gap-0 rounded-full p-0 active:bg-transparent active:opacity-70"
                        onPress={onStop}
                        style={{
                          width: 26,
                          height: 26,
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderRadius: 13,
                          backgroundColor: themeColors.primary,
                        }}
                      >
                        <Ionicons name="stop" size={12} color={themeColors.primaryForeground} />
                      </Button>
                    ) : hasContent ? (
                      <Button
                        variant="ghost"
                        className="h-auto w-auto gap-0 rounded-full p-0 opacity-100 active:bg-transparent active:opacity-70"
                        onPress={handleSubmit}
                        disabled={!canSend}
                        style={{
                          width: 26,
                          height: 26,
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderRadius: 13,
                          backgroundColor: canSend ? themeColors.primary : (isDark ? THEME.dark.border : THEME.light.border),
                        }}
                      >
                        <Ionicons
                          name="arrow-up"
                          size={14}
                          color={canSend ? themeColors.primaryForeground : (isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground)}
                        />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        className="h-auto w-auto gap-0 rounded-full p-0 opacity-100 active:bg-transparent active:opacity-70"
                        onPress={handleSubmit}
                        disabled={true}
                        style={{
                          width: 26,
                          height: 26,
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderRadius: 13,
                          backgroundColor: isDark ? THEME.dark.border : THEME.light.border,
                        }}
                      >
                        <Ionicons name="arrow-up" size={14} color={isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground} />
                      </Button>
                    )}
                  </View>
                </View>
              </>
          </View>
        </View>


      </View>

      {/* Actions bottom sheet — attach, config, autocontinue */}
      <ActionsSheet
        visible={showActionsSheet}
        onClose={() => setShowActionsSheet(false)}
        isDark={isDark}
        onAttach={() => { setShowActionsSheet(false); setTimeout(handleAttachPress, 300); }}
        onConfig={() => { setShowActionsSheet(false); setTimeout(openConfigSheet, 300); }}
        onAutoContinue={availableAutoAlgorithms.length > 0 ? () => { setShowActionsSheet(false); setTimeout(() => setShowAutoSheet(true), 300); } : undefined}
        autocontinueLabel={autocontinueMode ? (currentAutoAlgorithm?.label || 'Auto') : 'Off'}
        autocontinueActive={!!autocontinueMode}
        configLabel={`${agent?.name ? agent.name.charAt(0).toUpperCase() + agent.name.slice(1) : 'Agent'}${model?.modelName ? ` · ${model.modelName}` : ''}${variant ? ` · ${variantLabel}` : ''}`}
        onboardingMode={onboardingMode}
      />

      {/* Config bottom sheet — agent, model, variant (dynamic-sized) */}
      <ConfigSheet
        ref={configSheetRef}
        isDark={isDark}
        agents={agents}
        selectedAgent={agent || null}
        onAgentChange={(name) => { onAgentChange?.(name); }}
        models={models}
        selectedModel={model || null}
        onModelChange={(pid, mid) => { onModelChange?.(pid, mid); }}
        variants={variants}
        selectedVariant={variant || null}
        onVariantSet={(v) => onVariantSet?.(v)}
      />

      <AutoContinueSheet
        visible={showAutoSheet}
        onClose={() => setShowAutoSheet(false)}
        selected={autocontinueMode}
        onSelect={(mode) => setAutocontinueMode(mode)}
        algorithms={availableAutoAlgorithms}
        isDark={isDark}
      />
    </>
  );
}

function AutoContinueButton({
  isDark,
  isActive,
  label,
  onPress,
}: {
  isDark: boolean;
  isActive: boolean;
  label: string;
  onPress: () => void;
}) {
  const activeBg = withAlpha(THEME.accent.purple, isDark ? 0.18 : 0.16);
  const inactiveBg = isDark ? withAlpha(THEME.dark.foreground, 0.05) : withAlpha(THEME.light.foreground, 0.04);
  const activeColor = THEME.accent.purple;
  const mutedColor = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;

  return (
    <Button
      variant="ghost"
      className="h-auto w-auto gap-0 rounded-full p-0 active:bg-transparent active:opacity-80"
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 20,
        backgroundColor: isActive ? activeBg : inactiveBg,
        borderWidth: isActive ? 1 : 0,
        borderColor: isActive ? withAlpha(THEME.accent.purple, 0.4) : 'transparent',
      }}
      hitSlop={6}
    >
      <Text
        style={{
          fontSize: 12,
          fontFamily: 'Roobert-Medium',
          color: isActive ? (isDark ? THEME.dark.foreground : THEME.light.foreground) : mutedColor,
          marginLeft: 0,
        }}
        numberOfLines={1}
      >
        {label}
      </Text>
      <Ionicons
        name="chevron-down"
        size={10}
        color={isActive ? (THEME.accent.purple) : mutedColor}
        style={{ marginLeft: 4 }}
      />
    </Button>
  );
}

// ─── Actions Sheet ──────────────────────────────────────────────────────────

interface ActionsSheetProps {
  visible: boolean;
  onClose: () => void;
  isDark: boolean;
  onAttach: () => void;
  onConfig: () => void;
  onAutoContinue?: () => void;
  autocontinueLabel: string;
  autocontinueActive: boolean;
  configLabel: string;
  onboardingMode: boolean;
}

function ActionsSheet({
  visible,
  onClose,
  isDark,
  onAttach,
  onConfig,
  onAutoContinue,
  autocontinueLabel,
  autocontinueActive,
  configLabel,
  onboardingMode,
}: ActionsSheetProps) {
  const sheetBg = useSheetBackground();
  const insets = useSafeAreaInsets();
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const fgColor = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const bg = getSheetBg(isDark);

  // Sync `visible` prop to the imperative BottomSheetModal API so the caller
  // API stays unchanged. Dismiss originating from user gesture flows back
  // through onClose; programmatic dismissals are guarded by dismissingRef.
  const sheetRef = useRef<BottomSheetModal>(null);
  const dismissingRef = useRef(false);

  useEffect(() => {
    if (visible) {
      dismissingRef.current = false;
      sheetRef.current?.present();
    } else {
      dismissingRef.current = true;
      sheetRef.current?.dismiss();
    }
  }, [visible]);

  const handleSheetDismiss = useCallback(() => {
    if (!dismissingRef.current) onClose();
    dismissingRef.current = false;
  }, [onClose]);


  const rows: Array<{
    key: string;
    icon: typeof PaperclipIcon;
    label: string;
    description: string;
    onPress: () => void;
  }> = [];

  if (!onboardingMode) {
    rows.push({
      key: 'attach',
      icon: PaperclipIcon,
      label: 'Attach files',
      description: 'Photos, documents, or files',
      onPress: onAttach,
    });
  }
  rows.push({
    key: 'config',
    icon: SettingsIcon,
    label: 'Agent & Model',
    description: configLabel,
    onPress: onConfig,
  });
  if (onAutoContinue) {
    rows.push({
      key: 'autocontinue',
      icon: InfinityIcon,
      label: 'AutoContinue',
      description: autocontinueActive
        ? `Active · ${autocontinueLabel}`
        : 'Off — manual mode',
      onPress: onAutoContinue,
    });
  }

  return (
    <BottomSheetModal
      ref={sheetRef}
      enableDynamicSizing
      enablePanDownToClose
      enableOverDrag={false}
      onDismiss={handleSheetDismiss}
      handleIndicatorStyle={sheetHandleIndicatorStyle(isDark)}
      backgroundStyle={{
        backgroundColor: sheetBg,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
      }}
      backdropComponent={(p) => <SheetBackdrop {...p} opacity={0.4} />}
    >
      <BottomSheetView style={{ paddingBottom: insets.bottom + 8 }}>
        {/* Header — drag handle is the only affordance; swipe down or tap
            backdrop to dismiss. */}
        <View style={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: 10 }}>
          <Text
            style={{
              fontSize: 18,
              fontFamily: 'Roobert-SemiBold',
              color: fgColor,
            }}
          >
            Actions
          </Text>
        </View>

        {/* Settings-style rows: plain stroked lucide icon, title + subtitle,
            chevron, and a thin divider between rows (no per-row card bg). */}
        <View style={{ paddingHorizontal: 20 }}>
          {rows.map((row, idx) => {
            const isLast = idx === rows.length - 1;
            return (
              <React.Fragment key={row.key}>
                <Button
                  variant="ghost"
                  className="h-auto w-full gap-0 rounded-none justify-start p-0 active:bg-transparent active:opacity-70"
                  onPress={row.onPress}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: 14,
                  }}
                >
                  <Icon
                    as={row.icon}
                    size={18}
                    color={isDark ? withAlpha(THEME.dark.foreground, 0.8) : withAlpha(THEME.light.foreground, 0.8)}
                    strokeWidth={2.2}
                  />
                  <View style={{ marginLeft: 16, flex: 1 }}>
                    <Text
                      style={{
                        fontSize: 15,
                        fontFamily: 'Roobert-Medium',
                        color: fgColor,
                      }}
                    >
                      {row.label}
                    </Text>
                    <Text
                      style={{
                        marginTop: 2,
                        fontSize: 12,
                        fontFamily: 'Roobert',
                        color: muted,
                      }}
                      numberOfLines={1}
                    >
                      {row.description}
                    </Text>
                  </View>
                  <Icon
                    as={ChevronRightIcon}
                    size={16}
                    color={isDark ? withAlpha(THEME.dark.foreground, 0.35) : withAlpha(THEME.light.foreground, 0.35)}
                    strokeWidth={2.2}
                  />
                </Button>
                {!isLast && (
                  <View
                    style={{
                      height: 1,
                      backgroundColor: isDark
                        ? withAlpha(THEME.dark.foreground, 0.08)
                        : withAlpha(THEME.light.foreground, 0.08),
                    }}
                  />
                )}
              </React.Fragment>
            );
          })}
        </View>
      </BottomSheetView>
    </BottomSheetModal>
  );
}

function InfinityOffIcon({ color, size }: { color: string; size: number }) {
  return (
    <View style={{ width: size, height: size }}>
      <InfinityIcon color={color} size={size} strokeWidth={2.4} />
      <SlashIcon
        color={color}
        size={size}
        strokeWidth={2}
        style={{ position: 'absolute', left: 0, top: 0 }}
      />
    </View>
  );
}

interface AutoContinueSheetProps {
  visible: boolean;
  onClose: () => void;
  selected: AutoContinueMode | null;
  onSelect: (mode: AutoContinueMode | null) => void;
  algorithms: AutoContinueAlgorithm[];
  isDark: boolean;
}

function AutoContinueSheet({
  visible,
  onClose,
  selected,
  onSelect,
  algorithms,
  isDark,
}: AutoContinueSheetProps) {
  const sheetBg = useSheetBackground();
  const insets = useSafeAreaInsets();
  const [detailAlg, setDetailAlg] = useState<AutoContinueAlgorithm | null>(null);
  const isActive = selected !== null;
  const currentAlg = algorithms.find((alg) => alg.id === selected) || null;
  const defaultMode = useMemo(() => {
    const preferred = algorithms.find((alg) => alg.id === DEFAULT_AUTOCONTINUE_MODE);
    return preferred?.id ?? algorithms[0]?.id ?? null;
  }, [algorithms]);

  const { height: screenHeight } = useWindowDimensions();
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const border = isDark ? withAlpha(THEME.dark.foreground, 0.1) : withAlpha(THEME.light.foreground, 0.08);
  const bg = getSheetBg(isDark);

  // Bridge `visible` prop to the imperative BottomSheetModal API.
  const sheetRef = useRef<BottomSheetModal>(null);
  const dismissingRef = useRef(false);

  useEffect(() => {
    if (visible) {
      dismissingRef.current = false;
      sheetRef.current?.present();
    } else {
      dismissingRef.current = true;
      sheetRef.current?.dismiss();
    }
  }, [visible]);

  const handleSheetDismiss = useCallback(() => {
    if (!dismissingRef.current) onClose();
    dismissingRef.current = false;
  }, [onClose]);


  useEffect(() => {
    if (!visible) {
      setDetailAlg(null);
    }
  }, [visible]);

  if (algorithms.length === 0) return null;

  return (
    <BottomSheetModal
      ref={sheetRef}
      enableDynamicSizing
      maxDynamicContentSize={Math.floor(screenHeight * 0.86)}
      enablePanDownToClose={!detailAlg}
      enableOverDrag={false}
      onDismiss={handleSheetDismiss}
      handleIndicatorStyle={sheetHandleIndicatorStyle(isDark)}
      backgroundStyle={{
        backgroundColor: sheetBg,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
      }}
      backdropComponent={(p) => <SheetBackdrop {...p} opacity={0.4} />}
    >
      {detailAlg ? (
        /* Detail view — algorithm deep-dive with its own scroller. */
        <BottomSheetScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          showsVerticalScrollIndicator={false}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 6, paddingHorizontal: 20, paddingBottom: 12 }}>
            <Button
              variant="ghost"
              className="h-auto w-auto gap-0 rounded-full p-0 active:bg-transparent active:opacity-20"
              onPress={() => setDetailAlg(null)}
              hitSlop={12}
              style={{ marginRight: 12 }}
            >
              <Ionicons name="chevron-back" size={22} color={muted} />
            </Button>
            <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: isDark ? THEME.dark.foreground : THEME.light.foreground }}>
              {detailAlg.label}
            </Text>
            <Button
              variant="ghost"
              className="h-auto w-auto gap-0 rounded-md p-0 active:bg-transparent active:opacity-20"
              onPress={() => {
                onSelect(detailAlg.id);
                setDetailAlg(null);
                onClose();
              }}
              style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 4 }}
              hitSlop={10}
            >
              <Text style={{ color: THEME.accent.purple, fontFamily: 'Roobert-Medium', fontSize: 13 }}>
                Use
              </Text>
              <Ionicons name="checkmark" size={18} color={THEME.accent.purple} />
            </Button>
          </View>

          <View style={{ paddingHorizontal: 20 }}>
            <Text style={{ color: muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
              Role
            </Text>
            <Text style={{ fontSize: 14, marginBottom: 16, color: isDark ? THEME.dark.foreground : THEME.light.foreground }}>
              {detailAlg.role}
            </Text>

            <Text style={{ color: muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
              Description
            </Text>
            <Text style={{ fontSize: 14, color: isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground, marginBottom: 16 }}>
              {detailAlg.description}
            </Text>

            <Text style={{ color: muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
              Best for
            </Text>
            <Text style={{ fontSize: 14, color: isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground, marginBottom: 16 }}>
              {detailAlg.bestFor}
            </Text>

            <View style={{ flexDirection: 'row', marginTop: 4 }}>
              <View style={{ flex: 1, marginRight: 12 }}>
                <Text style={{ color: muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                  Strengths
                </Text>
                {detailAlg.strengths.map((s, idx) => (
                  <Text key={idx} style={{ fontSize: 13, color: THEME.accent.green, marginBottom: 6 }}>
                    • {s}
                  </Text>
                ))}
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={{ color: muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                  Weaknesses
                </Text>
                {detailAlg.weaknesses.map((s, idx) => (
                  <Text key={idx} style={{ fontSize: 13, color: THEME.accent.orange, marginBottom: 6 }}>
                    • {s}
                  </Text>
                ))}
              </View>
            </View>

            <Text style={{ color: muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginTop: 20, marginBottom: 8 }}>
              How it works
            </Text>
            <Text style={{ fontSize: 13, lineHeight: 20, color: isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground }}>
              {detailAlg.howItWorks}
            </Text>
          </View>
        </BottomSheetScrollView>
      ) : (
        /* List view — Off / On toggle + algorithm list. Top-level scroller so
           scroll gestures actually work inside the sheet. */
        <BottomSheetScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + 12 }}
          showsVerticalScrollIndicator={false}
        >
        {/* Header — drag handle + backdrop tap dismiss, no explicit close. */}
        <View style={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: 12 }}>
          <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: isDark ? THEME.dark.foreground : THEME.light.foreground }}>
            AutoContinue
          </Text>
        </View>

        <View>
          <View>
            <Button
              variant="ghost"
              className="h-auto w-full gap-0 rounded-none justify-start p-0 active:bg-transparent active:opacity-70"
              onPress={() => { onSelect(null); onClose(); }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingVertical: 14,
                paddingHorizontal: 20,
                backgroundColor: !isActive ? (isDark ? withAlpha(THEME.dark.foreground, 0.04) : withAlpha(THEME.light.foreground, 0.03)) : 'transparent',
              }}
            >
              <InfinityOffIcon color={muted} size={18} />
              <View style={{ marginLeft: 12, flex: 1 }}>
                <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: isDark ? THEME.dark.foreground : THEME.light.foreground }}>
                  Off
                </Text>
                <Text style={{ fontSize: 12, color: muted, marginTop: 2 }}>
                  Manual — you send each message
                </Text>
              </View>
              {!isActive && <Ionicons name="checkmark" size={18} color={THEME.accent.purple} />}
            </Button>

            <Button
              variant="ghost"
              className="h-auto w-full gap-0 rounded-none justify-start p-0 active:bg-transparent active:opacity-70"
              onPress={() => {
                if (!isActive && defaultMode) {
                  onSelect(defaultMode);
                }
              }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingVertical: 14,
                paddingHorizontal: 20,
                backgroundColor: isActive ? withAlpha(THEME.accent.purple, 0.08) : 'transparent',
              }}
            >
              <InfinityIcon color={isActive ? (THEME.accent.purple) : muted} strokeWidth={2.2} size={18} />
              <View style={{ marginLeft: 12, flex: 1 }}>
                <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: isDark ? THEME.dark.foreground : THEME.light.foreground }}>
                  On
                </Text>
                <Text style={{ fontSize: 12, color: muted, marginTop: 2 }}>
                  {isActive && currentAlg
                    ? `Running ${currentAlg.label}`
                    : 'Pick an algorithm and the agent will continue on its own'}
                </Text>
              </View>
              {isActive && <Ionicons name="checkmark" size={18} color={THEME.accent.purple} />}
            </Button>
          </View>

          <View style={{ marginTop: 20, paddingHorizontal: 20 }}>
            <Text style={{ fontSize: 12, color: muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
              Algorithms
            </Text>
          </View>

          {algorithms.map((alg, idx) => {
            const isSelected = selected === alg.id;
            return (
              <Button
                key={alg.id}
                variant="ghost"
                className="h-auto w-full gap-0 rounded-none justify-start p-0 active:bg-transparent active:opacity-70"
                onPress={() => {
                  onSelect(alg.id);
                  onClose();
                }}
                style={{
                  paddingVertical: 14,
                  paddingHorizontal: 20,
                  borderBottomWidth: idx < algorithms.length - 1 ? StyleSheet.hairlineWidth : 0,
                  borderBottomColor: border,
                  backgroundColor: isSelected ? (isDark ? withAlpha(THEME.dark.foreground, 0.04) : withAlpha(THEME.accent.purple, 0.07)) : 'transparent',
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: isDark ? THEME.dark.foreground : THEME.light.foreground }}>
                      {alg.label}
                    </Text>
                    <Text style={{ fontSize: 11, color: muted, marginTop: 1 }}>
                      {alg.role}
                    </Text>
                    <Text style={{ fontSize: 12, color: isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground, marginTop: 6 }} numberOfLines={1}>
                      {alg.description}
                    </Text>
                  </View>
                  <Button
                    variant="ghost"
                    className="h-auto w-auto gap-0 rounded-md p-0 active:bg-transparent active:opacity-20"
                    hitSlop={10}
                    onPress={() => setDetailAlg(alg)}
                    style={{ padding: 6, marginHorizontal: 4 }}
                  >
                    <InfoIcon size={18} color={muted} />
                  </Button>
                  {isSelected && (
                    <Ionicons name="checkmark" size={18} color={THEME.accent.purple} />
                  )}
                </View>
              </Button>
            );
          })}
        </View>
        </BottomSheetScrollView>
      )}
    </BottomSheetModal>
  );
}

// ─── Slash Command Suggestions ───────────────────────────────────────────────

function SlashCommandSuggestions({
  commands,
  selectedIndex,
  onSelect,
  isDark,
}: {
  commands: Command[];
  selectedIndex: number;
  onSelect: (cmd: Command) => void;
  isDark: boolean;
}) {
  const bgColor = getSheetBg(isDark);
  const borderColor = isDark ? withAlpha(THEME.dark.foreground, 0.1) : withAlpha(THEME.light.foreground, 0.08);
  const selectedBg = isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.05);
  const fgColor = isDark ? THEME.dark.foreground : THEME.light.foreground;
  // Original literal pair (#888 dark / #999 light) put dark mode's value
  // *below* light mode's in lightness — the inverted "muted()" shape, not
  // the direct mutedStrong() shape used elsewhere in this file.
  const mutedColor = isDark ? THEME.light.mutedForeground : THEME.dark.mutedForeground;

  return (
    <View
      style={{
        marginHorizontal: 16,
        marginBottom: 4,
        borderRadius: 12,
        backgroundColor: bgColor,
        borderWidth: 1,
        borderColor,
        maxHeight: 220,
        overflow: 'hidden',
      }}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {commands.map((cmd, i) => (
          <Button
            key={cmd.name}
            variant="ghost"
            className="h-auto w-full gap-0 rounded-none justify-start p-0 active:bg-transparent active:opacity-60"
            onPress={() => onSelect(cmd)}
            style={{
              paddingHorizontal: 14,
              paddingVertical: 10,
              backgroundColor: i === selectedIndex ? selectedBg : 'transparent',
              borderBottomWidth: i < commands.length - 1 ? 1 : 0,
              borderBottomColor: borderColor,
            }}
          >
            <RNText
              style={{
                fontSize: 14,
                fontFamily: 'Roobert-Medium',
                color: fgColor,
              }}
            >
              /{cmd.name}
            </RNText>
            {cmd.description && (
              <RNText
                numberOfLines={2}
                style={{
                  fontSize: 12,
                  fontFamily: 'Roobert',
                  color: mutedColor,
                  marginTop: 2,
                }}
              >
                {cmd.description}
              </RNText>
            )}
          </Button>
        ))}
      </ScrollView>
    </View>
  );
}

type ConfigTab = 'agent' | 'model' | 'thinking';

const TAB_CONFIG: { key: ConfigTab; label: string; icon: string }[] = [
  { key: 'agent', label: 'Agent', icon: 'person-outline' },
  { key: 'model', label: 'Model', icon: 'hardware-chip-outline' },
  { key: 'thinking', label: 'Thinking', icon: 'flash-outline' },
];

const ConfigSheet = forwardRef<
  BottomSheetModal,
  {
    isDark: boolean;
    agents: Agent[];
    selectedAgent: Agent | null;
    onAgentChange: (name: string) => void;
    models: FlatModel[];
    selectedModel: FlatModel | null;
    onModelChange: (providerId: string, modelId: string) => void;
    variants: string[];
    selectedVariant: string | null;
    onVariantSet: (variant: string | null) => void;
  }
>(function ConfigSheet(
  {
    isDark,
    agents,
    selectedAgent,
    onAgentChange,
    models,
    selectedModel,
    onModelChange,
    variants,
    selectedVariant,
    onVariantSet,
  },
  ref,
) {
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  const [activeTab, setActiveTab] = useState<ConfigTab>('agent');
  const fgColor = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const mutedColor = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const selectedBg = isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.05);
  const tabBg = getToggleTrackBg(isDark);
  const tabActiveBg = getToggleActiveBg(isDark);
  // Sticky header bg must match the sheet bg so the area above the tabs
  // (around the drag handle) doesn't look like a different shade.
  const bg = useSheetBackground();


  // Filter tabs to only show ones with content
  const visibleTabs = TAB_CONFIG.filter((t) => {
    if (t.key === 'agent') return agents.length > 0;
    if (t.key === 'model') return models.length > 0;
    if (t.key === 'thinking') return variants.length > 0;
    return false;
  });

  const handleSheetChange = useCallback(
    (index: number) => {
      if (index < 0) return;
      if (visibleTabs.length === 0) return;
      if (!visibleTabs.some((t) => t.key === activeTab)) {
        setActiveTab(visibleTabs[0].key);
      }
    },
    [activeTab, visibleTabs],
  );

  return (
    <BottomSheetModal
      ref={ref}
      enableDynamicSizing
      maxDynamicContentSize={Math.floor(screenHeight * 0.86)}
      enablePanDownToClose
      enableOverDrag={false}
      onChange={handleSheetChange}
      handleIndicatorStyle={sheetHandleIndicatorStyle(isDark)}
      backgroundStyle={{
        backgroundColor: bg,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
      }}
      backdropComponent={(p) => <SheetBackdrop {...p} opacity={0.4} />}
    >
      {/* Top-level BottomSheetScrollView so scroll gestures work. Header +
          tabs are wrapped in a single sticky block (index 0) so they stay
          pinned while the items list scrolls underneath. The sheet still
          sizes to content via enableDynamicSizing; scroll only activates
          when content exceeds maxDynamicContentSize. */}
      <BottomSheetScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 12 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        stickyHeaderIndices={[0]}
      >
      {/* Sticky header block: title + tab bar. Solid bg so scrolled items
          don't show through. */}
      <View style={{ backgroundColor: bg }}>
        <View style={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: 12 }}>
          <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: fgColor }}>
            Configuration
          </Text>
        </View>
        <View
          style={{
            flexDirection: 'row',
            marginHorizontal: 20,
            marginBottom: 16,
            borderRadius: 9999,
            backgroundColor: tabBg,
            padding: 3,
          }}
        >
          {visibleTabs.map((tab) => {
            const isActive = activeTab === tab.key;
            return (
              <Button
                key={tab.key}
                variant="ghost"
                className="h-auto flex-1 shrink gap-0 rounded-full p-0 active:bg-transparent active:opacity-70"
                onPress={() => setActiveTab(tab.key)}
                style={{
                  flex: 1,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  paddingVertical: 8,
                  borderRadius: 9999,
                  backgroundColor: isActive ? tabActiveBg : 'transparent',
                  gap: 5,
                }}
              >
                <Ionicons
                  name={tab.icon as any}
                  size={14}
                  color={isActive ? fgColor : mutedColor}
                />
                <Text
                  style={{
                    fontSize: 13,
                    fontFamily: isActive ? 'Roobert-SemiBold' : 'Roobert-Medium',
                    color: isActive ? fgColor : mutedColor,
                  }}
                >
                  {tab.label}
                </Text>
              </Button>
            );
          })}
        </View>
      </View>

      {/* Content (items flow below the sticky header block) */}
      <View>
        {/* Agent tab */}
        {activeTab === 'agent' && agents.filter((a) => !a.hidden).map((a) => {
          const isSelected = selectedAgent?.name === a.name;
          return (
            <Button
              key={a.name}
              variant="ghost"
              className="h-auto w-full gap-0 rounded-none justify-start p-0 active:bg-transparent active:opacity-60"
              onPress={() => onAgentChange(a.name)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 20,
                paddingVertical: 14,
                backgroundColor: isSelected ? selectedBg : 'transparent',
              }}
            >
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    fontSize: 16,
                    fontFamily: isSelected ? 'Roobert-Medium' : 'Roobert',
                    color: fgColor,
                    textTransform: 'capitalize',
                  }}
                >
                  {a.name}
                </Text>
                {a.description ? (
                  <Text
                    style={{ fontSize: 13, fontFamily: 'Roobert', color: mutedColor, marginTop: 3 }}
                    numberOfLines={2}
                  >
                    {a.description}
                  </Text>
                ) : null}
              </View>
              {isSelected && (
                <Ionicons name="checkmark" size={20} color={fgColor} />
              )}
            </Button>
          );
        })}

        {/* Model tab — grouped by provider */}
        {activeTab === 'model' && (() => {
          // Group models by provider
          const groups: { providerID: string; providerName: string; models: typeof models }[] = [];
          const seen = new Map<string, typeof models>();
          for (const m of models) {
            const key = m.providerID;
            if (!seen.has(key)) {
              const group: typeof models = [];
              seen.set(key, group);
              groups.push({ providerID: key, providerName: m.providerName || key, models: group });
            }
            seen.get(key)!.push(m);
          }

          return groups.map((group) => (
            <View key={group.providerID}>
              {/* Provider header */}
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingHorizontal: 20,
                  paddingTop: 16,
                  paddingBottom: 8,
                }}
              >
                <Text
                  style={{
                    fontSize: 11,
                    fontFamily: 'Roobert-SemiBold',
                    color: mutedColor,
                    textTransform: 'uppercase',
                    letterSpacing: 0.8,
                  }}
                >
                  {group.providerName}
                </Text>
                <Text
                  style={{
                    fontSize: 11,
                    fontFamily: 'Roobert-Medium',
                    color: isDark ? withAlpha(THEME.dark.foreground, 0.2) : withAlpha(THEME.light.foreground, 0.2),
                  }}
                >
                  {group.models.length}
                </Text>
              </View>
              {/* Models in this provider */}
              {group.models.map((m) => {
                const isSelected =
                  selectedModel?.providerID === m.providerID &&
                  selectedModel?.modelID === m.modelID;
                return (
                  <Button
                    key={`${m.providerID}/${m.modelID}`}
                    variant="ghost"
                    className="h-auto w-full gap-0 rounded-none justify-start p-0 active:bg-transparent active:opacity-60"
                    onPress={() => onModelChange(m.providerID, m.modelID)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingHorizontal: 20,
                      paddingVertical: 12,
                      backgroundColor: isSelected ? selectedBg : 'transparent',
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text
                        style={{
                          fontSize: 15,
                          fontFamily: isSelected ? 'Roobert-Medium' : 'Roobert',
                          color: fgColor,
                        }}
                        numberOfLines={1}
                      >
                        {m.modelName || m.modelID}
                      </Text>
                      <Text
                        style={{ fontSize: 12, fontFamily: 'Roobert', color: mutedColor, marginTop: 2 }}
                        numberOfLines={1}
                      >
                        {m.modelID}
                      </Text>
                    </View>
                    {isSelected && (
                      <Ionicons name="checkmark" size={20} color={fgColor} />
                    )}
                  </Button>
                );
              })}
            </View>
          ));
        })()}

        {/* Thinking tab */}
        {activeTab === 'thinking' && (
          <>
            <Button
              variant="ghost"
              className="h-auto w-full gap-0 rounded-none justify-start p-0 active:bg-transparent active:opacity-60"
              onPress={() => onVariantSet(null)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 20,
                paddingVertical: 14,
                backgroundColor: !selectedVariant ? selectedBg : 'transparent',
              }}
            >
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    fontSize: 16,
                    fontFamily: !selectedVariant ? 'Roobert-Medium' : 'Roobert',
                    color: fgColor,
                  }}
                >
                  Default
                </Text>
                <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: mutedColor, marginTop: 3 }}>
                  Standard response
                </Text>
              </View>
              {!selectedVariant && (
                <Ionicons name="checkmark" size={20} color={fgColor} />
              )}
            </Button>
            {variants.map((v) => {
              const isSelected = selectedVariant === v;
              return (
                <Button
                  key={v}
                  variant="ghost"
                  className="h-auto w-full gap-0 rounded-none justify-start p-0 active:bg-transparent active:opacity-60"
                  onPress={() => onVariantSet(v)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 20,
                    paddingVertical: 14,
                    backgroundColor: isSelected ? selectedBg : 'transparent',
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text
                      style={{
                        fontSize: 16,
                        fontFamily: isSelected ? 'Roobert-Medium' : 'Roobert',
                        color: fgColor,
                        textTransform: 'capitalize',
                      }}
                    >
                      {v}
                    </Text>
                    <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: mutedColor, marginTop: 3 }}>
                      Extended thinking mode
                    </Text>
                  </View>
                  {isSelected && (
                    <Ionicons name="checkmark" size={20} color={fgColor} />
                  )}
                </Button>
              );
            })}
          </>
        )}
      </View>
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
});
