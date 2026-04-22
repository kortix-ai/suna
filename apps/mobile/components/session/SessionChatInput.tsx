/**
 * SessionChatInput — chat input with agent/model/variant toolbar and @mentions.
 *
 * Matches the Computer frontend's chat input:
 * - Left toolbar: Agent selector, Model selector, Variant (thinking) toggle
 * - Right toolbar: Send / Stop buttons
 * - Multiline text input
 * - @mention autocomplete for files, agents, and sessions
 */

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  Modal,
  ScrollView,
  Platform,
  Animated,
  StyleSheet,
  ActionSheetIOS,
  Alert,
  Image,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';
import { Text } from '@/components/ui/text';
import { useColorScheme } from 'nativewind';
import { Ionicons } from '@expo/vector-icons';
import {
  Infinity as InfinityIcon,
  Slash as SlashIcon,
  Info as InfoIcon,
  X as XIcon,
  Plus as PlusIcon,
  Mic as MicIcon,
  Paperclip as PaperclipIcon,
  Settings as SettingsIcon,
  ChevronRight as ChevronRightIcon,
} from 'lucide-react-native';
import { Icon } from '@/components/ui/icon';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { getAuthToken } from '@/api/config';

import type { Agent, FlatModel, Command } from '@/lib/opencode/hooks/use-opencode-data';
import type { Session } from '@/lib/platform/types';
import { MentionSuggestions } from './MentionSuggestions';
import { AudioWaveform } from '@/components/attachments/AudioWaveform';
import { useMentions, type TrackedMention, type MentionItem } from './useMentions';
import { Text as RNText } from 'react-native';
import { useThemeColors } from '@/lib/theme-colors';

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
    role: 'Executor',
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
  /** Audio recording */
  onAudioRecord?: () => void;
  onCancelRecording?: () => void;
  onSendAudio?: () => void;
  isRecording?: boolean;
  recordingDuration?: number;
  audioLevels?: number[];
  isTranscribing?: boolean;
  /** Transcribed text to inject into the input (set by parent after voice transcription) */
  pendingTranscription?: string | null;
  /** Called after the transcription text has been consumed */
  onTranscriptionConsumed?: () => void;
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
  onAudioRecord,
  onCancelRecording,
  onSendAudio,
  isRecording = false,
  recordingDuration = 0,
  audioLevels = [],
  isTranscribing = false,
  pendingTranscription,
  onTranscriptionConsumed,
}: SessionChatInputProps) {
  const [text, setText] = useState(initialText);
  const inputRef = useRef<TextInput>(null);
  const cursorRef = useRef(0);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const themeColors = useThemeColors();

  // Config sheet
  const [showConfigSheet, setShowConfigSheet] = useState(false);

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

  // ── Consume pending transcription from parent ────────────────────────────
  useEffect(() => {
    if (pendingTranscription) {
      setText((prev) => prev ? `${prev} ${pendingTranscription}` : pendingTranscription);
      onTranscriptionConsumed?.();
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [pendingTranscription, onTranscriptionConsumed]);

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

  // Format duration as M:SS
  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

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
          <View className="rounded-2xl px-3 pt-2 pb-1 bg-background border border-border">
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
                      backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
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
                        <Ionicons name="document-outline" size={22} color={isDark ? '#a1a1aa' : '#71717a'} />
                        <RNText
                          numberOfLines={2}
                          style={{ fontSize: 9, color: isDark ? '#a1a1aa' : '#71717a', textAlign: 'center', marginTop: 2 }}
                        >
                          {f.name}
                        </RNText>
                      </View>
                    )}
                    {/* Remove button */}
                    <TouchableOpacity
                      onPress={() => removeAttachedFile(idx)}
                      style={{
                        position: 'absolute',
                        top: 2,
                        right: 2,
                        width: 16,
                        height: 16,
                        borderRadius: 8,
                        backgroundColor: 'rgba(0,0,0,0.55)',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      hitSlop={4}
                    >
                      <XIcon size={9} color="#fff" strokeWidth={3} />
                    </TouchableOpacity>
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
                    backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                    borderWidth: 1,
                    borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
                  }}
                >
                  <Ionicons
                    name="terminal-outline"
                    size={12}
                    color={isDark ? '#a1a1aa' : '#71717a'}
                    style={{ marginRight: 6 }}
                  />
                  <RNText
                    style={{
                      fontSize: 13,
                      fontFamily: 'Roobert-Medium',
                      color: isDark ? '#F8F8F8' : '#121215',
                      maxWidth: 220,
                    }}
                    numberOfLines={1}
                  >
                    /{stagedCommand.name}
                  </RNText>
                  <TouchableOpacity
                    onPress={() => { setStagedCommand(null); setText(''); }}
                    hitSlop={8}
                    style={{ marginLeft: 6 }}
                  >
                    <Ionicons name="close" size={12} color={isDark ? '#71717a' : '#a1a1aa'} />
                  </TouchableOpacity>
                </View>
                {stagedCommand.description && (
                  <RNText
                    numberOfLines={1}
                    style={{
                      fontSize: 11,
                      fontFamily: 'Roobert',
                      color: isDark ? '#71717a' : '#a1a1aa',
                      flex: 1,
                    }}
                  >
                    {stagedCommand.description}
                  </RNText>
                )}
              </View>
            )}

            {/* Recording mode — replaces text input while recording */}
            {isRecording ? (
              <View style={{ paddingVertical: 8 }}>
                <View style={{ alignItems: 'center', justifyContent: 'center', height: 40 }}>
                  <AudioWaveform isRecording={true} audioLevels={audioLevels} />
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 6 }}>
                  <TouchableOpacity
                    onPress={onCancelRecording}
                    activeOpacity={0.7}
                    hitSlop={8}
                    style={{
                      width: 26,
                      height: 26,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 13,
                      backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                    }}
                  >
                    <XIcon size={13} color={isDark ? '#d4d4d8' : '#52525b'} strokeWidth={2} />
                  </TouchableOpacity>
                  <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.4)' }}>
                    {isTranscribing ? 'Transcribing...' : formatDuration(recordingDuration)}
                  </Text>
                  <TouchableOpacity
                    onPress={onSendAudio}
                    activeOpacity={0.7}
                    style={{
                      width: 26,
                      height: 26,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 13,
                      backgroundColor: themeColors.primary,
                    }}
                  >
                    <Ionicons name="arrow-up" size={14} color={themeColors.primaryForeground} />
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
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
                        color: isDark ? '#999999' : '#6e6e6e',
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
                    placeholderTextColor={isDark ? '#555' : '#aaa'}
                    multiline
                    maxLength={10000}
                    style={{
                      maxHeight: 100,
                      fontSize: 14,
                      lineHeight: 20,
                      color: isDark ? '#F8F8F8' : '#121215',
                      paddingTop: Platform.OS === 'ios' ? 5 : 3,
                      paddingBottom: Platform.OS === 'ios' ? 5 : 3,
                      minHeight: 32,
                    }}
                    onSubmitEditing={handleSubmit}
                    blurOnSubmit={false}
                    returnKeyType="default"
                    editable={!disabled && !isTranscribing}
                  />
                </View>

                {/* Compact toolbar row — minimal like Slack */}
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 4, paddingBottom: 2 }}>
                  {/* Left: "+" button + compact context indicators */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    {!onboardingMode && (
                      <TouchableOpacity
                        onPress={() => setShowActionsSheet(true)}
                        activeOpacity={0.7}
                        hitSlop={6}
                        style={{
                          width: 26,
                          height: 26,
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderRadius: 13,
                          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                        }}
                      >
                        <PlusIcon size={14} color={isDark ? '#a1a1aa' : '#71717a'} strokeWidth={2} />
                      </TouchableOpacity>
                    )}

                    {/* Compact config label */}
                    <TouchableOpacity
                      onPress={() => setShowConfigSheet(true)}
                      activeOpacity={0.7}
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
                          fontSize: 11,
                          fontFamily: 'Roobert',
                          color: isDark ? '#71717a' : '#a1a1aa',
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
                        color={isDark ? '#52525b' : '#d4d4d8'}
                        style={{ marginLeft: 2 }}
                      />
                    </TouchableOpacity>

                    {/* Compact autocontinue indicator — only when mode is active */}
                    {!!autocontinueMode && currentAutoAlgorithm && (
                      <TouchableOpacity
                        onPress={() => setShowAutoSheet(true)}
                        activeOpacity={0.7}
                        hitSlop={6}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          paddingHorizontal: 6,
                          paddingVertical: 3,
                          borderRadius: 10,
                          backgroundColor: isDark ? 'rgba(109,40,217,0.15)' : 'rgba(99,102,241,0.12)',
                        }}
                      >
                        <View style={{
                          width: 5,
                          height: 5,
                          borderRadius: 2.5,
                          backgroundColor: isDark ? '#c4b5fd' : '#6366f1',
                          marginRight: 4,
                        }} />
                        <Text
                          style={{
                            fontSize: 11,
                            fontFamily: 'Roobert-Medium',
                            color: isDark ? '#c4b5fd' : '#4c1d95',
                          }}
                          numberOfLines={1}
                        >
                          {currentAutoAlgorithm.label}
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>

                  {/* Right: queue + mic/send/stop */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {isBusy && canSend && onEnqueue && (
                      <TouchableOpacity
                        onPress={handleSubmit}
                        activeOpacity={0.7}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          paddingHorizontal: 8,
                          paddingVertical: 3,
                          borderRadius: 12,
                          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
                        }}
                      >
                        <Ionicons name="list-outline" size={11} color={isDark ? '#a1a1aa' : '#71717a'} style={{ marginRight: 3 }} />
                        <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: isDark ? '#a1a1aa' : '#71717a' }}>
                          Queue
                        </Text>
                      </TouchableOpacity>
                    )}
                    {isBusy ? (
                      <TouchableOpacity
                        onPress={onStop}
                        activeOpacity={0.7}
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
                      </TouchableOpacity>
                    ) : hasContent ? (
                      <TouchableOpacity
                        onPress={handleSubmit}
                        disabled={!canSend}
                        activeOpacity={0.7}
                        style={{
                          width: 26,
                          height: 26,
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderRadius: 13,
                          backgroundColor: canSend ? themeColors.primary : (isDark ? '#232324' : '#E5E7EB'),
                        }}
                      >
                        <Ionicons
                          name="arrow-up"
                          size={14}
                          color={canSend ? themeColors.primaryForeground : (isDark ? '#999999' : '#6e6e6e')}
                        />
                      </TouchableOpacity>
                    ) : onAudioRecord ? (
                      <TouchableOpacity
                        onPress={onAudioRecord}
                        activeOpacity={0.7}
                        style={{
                          width: 26,
                          height: 26,
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderRadius: 13,
                          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                        }}
                      >
                        <MicIcon size={14} color={isDark ? '#a1a1aa' : '#71717a'} strokeWidth={2} />
                      </TouchableOpacity>
                    ) : (
                      <TouchableOpacity
                        onPress={handleSubmit}
                        disabled={true}
                        activeOpacity={0.7}
                        style={{
                          width: 26,
                          height: 26,
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderRadius: 13,
                          backgroundColor: isDark ? '#232324' : '#E5E7EB',
                        }}
                      >
                        <Ionicons name="arrow-up" size={14} color={isDark ? '#999999' : '#6e6e6e'} />
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              </>
            )}
          </View>
        </View>


      </View>

      {/* Actions bottom sheet — attach, config, autocontinue */}
      <ActionsSheet
        visible={showActionsSheet}
        onClose={() => setShowActionsSheet(false)}
        isDark={isDark}
        onAttach={() => { setShowActionsSheet(false); setTimeout(handleAttachPress, 300); }}
        onConfig={() => { setShowActionsSheet(false); setTimeout(() => setShowConfigSheet(true), 300); }}
        onAutoContinue={availableAutoAlgorithms.length > 0 ? () => { setShowActionsSheet(false); setTimeout(() => setShowAutoSheet(true), 300); } : undefined}
        autocontinueLabel={autocontinueMode ? (currentAutoAlgorithm?.label || 'Auto') : 'Off'}
        autocontinueActive={!!autocontinueMode}
        configLabel={`${agent?.name ? agent.name.charAt(0).toUpperCase() + agent.name.slice(1) : 'Agent'}${model?.modelName ? ` · ${model.modelName}` : ''}${variant ? ` · ${variantLabel}` : ''}`}
        onboardingMode={onboardingMode}
      />

      {/* Config bottom sheet — agent, model, variant */}
      <Modal
        visible={showConfigSheet}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowConfigSheet(false)}
      >
        <ConfigSheet
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
          onClose={() => setShowConfigSheet(false)}
        />
      </Modal>

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
  const activeBg = isDark ? 'rgba(109,40,217,0.18)' : 'rgba(99,102,241,0.16)';
  const inactiveBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';
  const activeColor = isDark ? '#C4B5FD' : '#4C1D95';
  const mutedColor = isDark ? '#a1a1aa' : '#71717a';

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 20,
        backgroundColor: isActive ? activeBg : inactiveBg,
        borderWidth: isActive ? 1 : 0,
        borderColor: isActive ? (isDark ? 'rgba(192,132,252,0.4)' : 'rgba(99,102,241,0.4)') : 'transparent',
      }}
      hitSlop={6}
    >
      <Text
        style={{
          fontSize: 12,
          fontFamily: 'Roobert-Medium',
          color: isActive ? (isDark ? '#F8F8F8' : '#1f2937') : mutedColor,
          marginLeft: 0,
        }}
        numberOfLines={1}
      >
        {label}
      </Text>
      <Ionicons
        name="chevron-down"
        size={10}
        color={isActive ? (isDark ? '#c4b5fd' : '#4c1d95') : mutedColor}
        style={{ marginLeft: 4 }}
      />
    </TouchableOpacity>
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
  const insets = useSafeAreaInsets();
  const muted = isDark ? '#a1a1aa' : '#71717a';
  const fgColor = isDark ? '#F8F8F8' : '#121215';
  const bg = isDark ? '#1a1a1d' : '#FFFFFF';

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

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={0.4}
        pressBehavior="close"
      />
    ),
    [],
  );

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
      handleIndicatorStyle={{
        backgroundColor: isDark ? '#3F3F46' : '#D4D4D8',
        width: 36,
        height: 5,
        borderRadius: 3,
      }}
      backgroundStyle={{
        backgroundColor: bg,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
      }}
      backdropComponent={renderBackdrop}
    >
      <BottomSheetView style={{ paddingBottom: insets.bottom + 8 }}>
        {/* Header */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 20,
            paddingTop: 6,
            paddingBottom: 10,
          }}
        >
          <Text
            style={{
              fontSize: 18,
              fontFamily: 'Roobert-SemiBold',
              color: fgColor,
            }}
          >
            Actions
          </Text>
          <TouchableOpacity onPress={onClose} hitSlop={10}>
            <Icon as={XIcon} size={20} color={muted} strokeWidth={2.2} />
          </TouchableOpacity>
        </View>

        {/* Settings-style rows: plain stroked lucide icon, title + subtitle,
            chevron, and a thin divider between rows (no per-row card bg). */}
        <View style={{ paddingHorizontal: 20 }}>
          {rows.map((row, idx) => {
            const isLast = idx === rows.length - 1;
            return (
              <React.Fragment key={row.key}>
                <TouchableOpacity
                  onPress={row.onPress}
                  activeOpacity={0.7}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: 14,
                  }}
                >
                  <Icon
                    as={row.icon}
                    size={18}
                    color={isDark ? 'rgba(248,248,248,0.8)' : 'rgba(18,18,21,0.8)'}
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
                    color={isDark ? 'rgba(248,248,248,0.35)' : 'rgba(18,18,21,0.35)'}
                    strokeWidth={2.2}
                  />
                </TouchableOpacity>
                {!isLast && (
                  <View
                    style={{
                      height: 1,
                      backgroundColor: isDark
                        ? 'rgba(248,248,248,0.08)'
                        : 'rgba(18,18,21,0.08)',
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
  const insets = useSafeAreaInsets();
  const [detailAlg, setDetailAlg] = useState<AutoContinueAlgorithm | null>(null);
  const isActive = selected !== null;
  const currentAlg = algorithms.find((alg) => alg.id === selected) || null;
  const defaultMode = useMemo(() => {
    const preferred = algorithms.find((alg) => alg.id === DEFAULT_AUTOCONTINUE_MODE);
    return preferred?.id ?? algorithms[0]?.id ?? null;
  }, [algorithms]);

  const muted = isDark ? '#a1a1aa' : '#71717a';
  const border = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)';
  const bg = isDark ? '#121215' : '#FFFFFF';

  useEffect(() => {
    if (!visible) {
      setDetailAlg(null);
    }
  }, [visible]);

  if (algorithms.length === 0) return null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: bg }}>
        <View style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 6 }}>
          <View
            style={{
              width: 36,
              height: 5,
              borderRadius: 3,
              backgroundColor: isDark ? '#3F3F46' : '#D4D4D8',
            }}
          />
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 12 }}>
          <Text style={{ fontSize: 20, fontFamily: 'Roobert-SemiBold', color: isDark ? '#F8F8F8' : '#121215' }}>
            AutoContinue
          </Text>
          <TouchableOpacity onPress={onClose} hitSlop={10}>
            <Ionicons name="close" size={24} color={muted} />
          </TouchableOpacity>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          showsVerticalScrollIndicator={false}
        >
          <View>
            <TouchableOpacity
              onPress={() => { onSelect(null); onClose(); }}
              activeOpacity={0.7}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingVertical: 14,
                paddingHorizontal: 20,
                backgroundColor: !isActive ? (isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)') : 'transparent',
              }}
            >
              <InfinityOffIcon color={muted} size={18} />
              <View style={{ marginLeft: 12, flex: 1 }}>
                <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: isDark ? '#F8F8F8' : '#121215' }}>
                  Off
                </Text>
                <Text style={{ fontSize: 12, color: muted, marginTop: 2 }}>
                  Manual — you send each message
                </Text>
              </View>
              {!isActive && <Ionicons name="checkmark" size={18} color={isDark ? '#c4b5fd' : '#4c1d95'} />}
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => {
                if (!isActive && defaultMode) {
                  onSelect(defaultMode);
                }
              }}
              activeOpacity={0.7}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingVertical: 14,
                paddingHorizontal: 20,
                backgroundColor: isActive ? 'rgba(99,102,241,0.08)' : 'transparent',
              }}
            >
              <InfinityIcon color={isActive ? (isDark ? '#c4b5fd' : '#4c1d95') : muted} strokeWidth={2.2} size={18} />
              <View style={{ marginLeft: 12, flex: 1 }}>
                <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: isDark ? '#F8F8F8' : '#121215' }}>
                  On
                </Text>
                <Text style={{ fontSize: 12, color: muted, marginTop: 2 }}>
                  {isActive && currentAlg
                    ? `Running ${currentAlg.label}`
                    : 'Pick an algorithm and the agent will continue on its own'}
                </Text>
              </View>
              {isActive && <Ionicons name="checkmark" size={18} color={isDark ? '#c4b5fd' : '#4c1d95'} />}
            </TouchableOpacity>
          </View>

          <View style={{ marginTop: 20, paddingHorizontal: 20 }}>
            <Text style={{ fontSize: 12, color: muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
              Algorithms
            </Text>
          </View>

          {algorithms.map((alg, idx) => {
            const isSelected = selected === alg.id;
            return (
              <TouchableOpacity
                key={alg.id}
                onPress={() => {
                  onSelect(alg.id);
                  onClose();
                }}
                activeOpacity={0.7}
                style={{
                  paddingVertical: 14,
                  paddingHorizontal: 20,
                  borderBottomWidth: idx < algorithms.length - 1 ? StyleSheet.hairlineWidth : 0,
                  borderBottomColor: border,
                  backgroundColor: isSelected ? (isDark ? 'rgba(255,255,255,0.04)' : 'rgba(99,102,241,0.07)') : 'transparent',
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: isDark ? '#F8F8F8' : '#111827' }}>
                      {alg.label}
                    </Text>
                    <Text style={{ fontSize: 11, color: muted, marginTop: 1 }}>
                      {alg.role}
                    </Text>
                    <Text style={{ fontSize: 12, color: isDark ? '#d4d4d8' : '#4b5563', marginTop: 6 }} numberOfLines={1}>
                      {alg.description}
                    </Text>
                  </View>
                  <TouchableOpacity
                    hitSlop={10}
                    onPress={() => setDetailAlg(alg)}
                    style={{ padding: 6, marginHorizontal: 4 }}
                  >
                    <InfoIcon size={18} color={muted} />
                  </TouchableOpacity>
                  {isSelected && (
                    <Ionicons name="checkmark" size={18} color={isDark ? '#C4B5FD' : '#4C1D95'} />
                  )}
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {detailAlg && (
          <View style={[StyleSheet.absoluteFillObject, { backgroundColor: bg, zIndex: 50 }]}> 
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: insets.top + 10, paddingHorizontal: 20, paddingBottom: 12 }}>
              <TouchableOpacity onPress={() => setDetailAlg(null)} hitSlop={12} style={{ marginRight: 12 }}>
                <Ionicons name="chevron-back" size={22} color={muted} />
              </TouchableOpacity>
              <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: isDark ? '#F8F8F8' : '#121215' }}>
                {detailAlg.label}
              </Text>
              <TouchableOpacity
                onPress={() => {
                  onSelect(detailAlg.id);
                  setDetailAlg(null);
                  onClose();
                }}
                style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 4 }}
                hitSlop={10}
              >
                <Text style={{ color: isDark ? '#c4b5fd' : '#4c1d95', fontFamily: 'Roobert-Medium', fontSize: 13 }}>
                  Use
                </Text>
                <Ionicons name="checkmark" size={18} color={isDark ? '#c4b5fd' : '#4c1d95'} />
              </TouchableOpacity>
            </View>
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 32 }}
              showsVerticalScrollIndicator={false}
            >
              <Text style={{ color: muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                Role
              </Text>
              <Text style={{ fontSize: 14, marginBottom: 16, color: isDark ? '#F8F8F8' : '#121215' }}>
                {detailAlg.role}
              </Text>

              <Text style={{ color: muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                Description
              </Text>
              <Text style={{ fontSize: 14, color: isDark ? '#d4d4d8' : '#374151', marginBottom: 16 }}>
                {detailAlg.description}
              </Text>

              <Text style={{ color: muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                Best for
              </Text>
              <Text style={{ fontSize: 14, color: isDark ? '#d4d4d8' : '#374151', marginBottom: 16 }}>
                {detailAlg.bestFor}
              </Text>

              <View style={{ flexDirection: 'row', marginTop: 4 }}>
                <View style={{ flex: 1, marginRight: 12 }}>
                  <Text style={{ color: muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                    Strengths
                  </Text>
                  {detailAlg.strengths.map((s, idx) => (
                    <Text key={idx} style={{ fontSize: 13, color: isDark ? '#bbf7d0' : '#166534', marginBottom: 6 }}>
                      • {s}
                    </Text>
                  ))}
                </View>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={{ color: muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                    Weaknesses
                  </Text>
                  {detailAlg.weaknesses.map((s, idx) => (
                    <Text key={idx} style={{ fontSize: 13, color: isDark ? '#fed7aa' : '#9a3412', marginBottom: 6 }}>
                      • {s}
                    </Text>
                  ))}
                </View>
              </View>

              <Text style={{ color: muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginTop: 20, marginBottom: 8 }}>
                How it works
              </Text>
              <Text style={{ fontSize: 13, lineHeight: 20, color: isDark ? '#e4e4e7' : '#1f2937' }}>
                {detailAlg.howItWorks}
              </Text>
            </ScrollView>
          </View>
        )}
      </View>
    </Modal>
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
  const bgColor = isDark ? '#1e1e20' : '#FFFFFF';
  const borderColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)';
  const selectedBg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)';
  const fgColor = isDark ? '#F8F8F8' : '#121215';
  const mutedColor = isDark ? '#888' : '#999';

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
          <TouchableOpacity
            key={cmd.name}
            onPress={() => onSelect(cmd)}
            activeOpacity={0.6}
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
          </TouchableOpacity>
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

function ConfigSheet({
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
  onClose,
}: {
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
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<ConfigTab>('agent');
  const fgColor = isDark ? '#F8F8F8' : '#121215';
  const mutedColor = isDark ? '#a1a1aa' : '#71717a';
  const selectedBg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)';
  const tabBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
  const tabActiveBg = isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.08)';

  // Filter tabs to only show ones with content
  const visibleTabs = TAB_CONFIG.filter((t) => {
    if (t.key === 'agent') return agents.length > 0;
    if (t.key === 'model') return models.length > 0;
    if (t.key === 'thinking') return variants.length > 0;
    return false;
  });

  return (
    <View style={{ flex: 1, backgroundColor: isDark ? '#121215' : '#FFFFFF' }}>
      {/* Handle */}
      <View style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 6 }}>
        <View
          style={{
            width: 36,
            height: 5,
            borderRadius: 3,
            backgroundColor: isDark ? '#3F3F46' : '#D4D4D8',
          }}
        />
      </View>

      {/* Header */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 20,
          paddingBottom: 12,
        }}
      >
        <Text style={{ fontSize: 20, fontFamily: 'Roobert-SemiBold', color: fgColor }}>
          Configuration
        </Text>
        <TouchableOpacity onPress={onClose} activeOpacity={0.7} hitSlop={10}>
          <Ionicons name="close" size={24} color={mutedColor} />
        </TouchableOpacity>
      </View>

      {/* Tabs */}
      <View
        style={{
          flexDirection: 'row',
          marginHorizontal: 20,
          marginBottom: 16,
          borderRadius: 12,
          backgroundColor: tabBg,
          padding: 3,
        }}
      >
        {visibleTabs.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              onPress={() => setActiveTab(tab.key)}
              activeOpacity={0.7}
              style={{
                flex: 1,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                paddingVertical: 8,
                borderRadius: 10,
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
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Content */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Agent tab */}
        {activeTab === 'agent' && agents.filter((a) => !a.hidden).map((a) => {
          const isSelected = selectedAgent?.name === a.name;
          return (
            <TouchableOpacity
              key={a.name}
              onPress={() => onAgentChange(a.name)}
              activeOpacity={0.6}
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
            </TouchableOpacity>
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
                    color: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)',
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
                  <TouchableOpacity
                    key={`${m.providerID}/${m.modelID}`}
                    onPress={() => onModelChange(m.providerID, m.modelID)}
                    activeOpacity={0.6}
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
                  </TouchableOpacity>
                );
              })}
            </View>
          ));
        })()}

        {/* Thinking tab */}
        {activeTab === 'thinking' && (
          <>
            <TouchableOpacity
              onPress={() => onVariantSet(null)}
              activeOpacity={0.6}
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
            </TouchableOpacity>
            {variants.map((v) => {
              const isSelected = selectedVariant === v;
              return (
                <TouchableOpacity
                  key={v}
                  onPress={() => onVariantSet(v)}
                  activeOpacity={0.6}
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
                </TouchableOpacity>
              );
            })}
          </>
        )}
      </ScrollView>
    </View>
  );
}
