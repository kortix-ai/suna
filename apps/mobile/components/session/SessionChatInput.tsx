/**
 * SessionChatInput — the thread's chat input.
 *
 * The card is `Composer`, the same one the project home renders (design.md
 * §5): text on top, then add · model · send. This file adds what only a thread
 * has: @mentions, slash commands, the message queue slot, file upload at pick
 * (`useComposerAttachments`, COR-185),
 * AutoContinue, and the model sheet with the active model's thinking levels.
 * The agent is chosen in the model sheet's Agent tab (`ModelPickerSheet`).
 */

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  TextInput,
  Pressable,
  StyleSheet,
  Keyboard,
  useWindowDimensions,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { useColorScheme } from 'nativewind';
import {
  InfinityIcon,
  InfoIcon,
  StackIcon,
  XIcon,
  TerminalIcon,
  CaretLeftIcon,
  CheckIcon,
} from '@/lib/icons';
import { Icon } from '@/components/ui/icon';
import Svg, { Line } from 'react-native-svg';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SessionPromptPart } from '@kortix/sdk';
import type { AttachedFile } from '@/lib/session/attachments';
import { planComposerSend } from '@/lib/session/send-plan';
import { uploadErrorMessage } from '@/lib/session/composer-uploads';
import { useToast } from '@/components/kortix/toast-provider';
import { useComposerAttachments } from './useComposerAttachments';
import { useRecoverPendingPick } from './useRecoverPendingPick';
import { useComposerDraft } from '@/lib/session/use-composer-draft';
import { AttachSheet, type AttachSheetRef } from './AttachSheet';
import { SessionFilesSheet } from './SessionFilesSheet';

import type { Agent, FlatModel, Command } from '@/lib/opencode/hooks/use-opencode-data';
import type { Session } from '@/lib/platform/types';
import { MentionSuggestions, SuggestionCard, SuggestionRow } from './MentionSuggestions';
import { useMentions, type TrackedMention, type MentionItem } from './useMentions';
import { useSkillMentions } from './useSkillMentions';
import { suggestionMenuTakesSubmit } from '@/lib/session/skill-mentions';
import { getSheetBg } from '@/lib/theme-colors';
import { THEME, withAlpha } from '@/lib/utils/theme';
import {
  SheetBackdrop,
  type SheetRef,
  KortixBottomSheetModal,
} from '@/components/kortix/sheet';
import { Composer, COMPOSER_CONTROL_HIT_SLOP } from '@/components/kortix/composer';
import { sessionFileMentionLabel, type SessionFile } from '@/lib/session/session-files';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { ModelPickerSheet } from './ModelPickerSheet';
import { composerChip, type PickerOption } from '@/lib/session/composer-config';
import { modelPickerOptions, pickerModelName } from '@/lib/session/model-picker';

// ─── Types ───────────────────────────────────────────────────────────────────

export type { AttachedFile } from '@/lib/session/attachments';

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

/** The uploaded files a send carries (COR-185): the prompt's file parts and the picked files behind them. */
export interface SendAttachments {
  fileParts: SessionPromptPart[];
  files: AttachedFile[];
}

interface SessionChatInputProps {
  onSend: (
    text: string,
    options: PromptOptions,
    mentions?: TrackedMention[],
    attachments?: SendAttachments,
  ) => void;
  onStop?: () => void;
  isBusy?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** The agent a send runs on, and all agents for @mentions and the model sheet's Agent tab. */
  agent?: Agent | null;
  agents?: Agent[];
  /** Picks the agent from the model sheet's Agent tab. Omit to hide the tab. */
  onAgentChange?: (name: string) => void;
  /** The Agent tab's `+`: starts a new session that creates an agent. */
  onCreateAgent?: () => void;
  model?: FlatModel | null;
  models?: FlatModel[];
  /** The model list is not known yet: the composer chip hides instead of flashing a label. */
  modelsLoading?: boolean;
  /**
   * The project's catalog loaded with no model (`isModelUnavailable`): the
   * chip reads "Connect model", and Send calls `onConnectModel` instead of
   * sending, and the draft stays (KRTX-251). One flag for both, so they agree.
   */
  modelUnavailable?: boolean;
  /** "Connect provider" in the model sheet's empty state, and Send while `modelUnavailable`. */
  onConnectModel?: () => void;
  modelKey?: { providerID: string; modelID: string } | null;
  variant?: string | null;
  variants?: string[];
  onModelChange?: (providerID: string, modelID: string) => void;
  onVariantSet?: (variant: string | null) => void;
  /** Data for @mentions */
  sessions?: Session[];
  currentSessionId?: string | null;
  sandboxUrl?: string;
  /** The project the thread belongs to: files upload to it at pick (COR-185). */
  projectId?: string;
  /** The thread can carry files (it has a project session). False refuses a send with files. */
  canAttach?: boolean;
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
  /** Initial text to populate the input with (e.g. restored after question prompt) */
  initialText?: string;
  /** Called whenever the input text changes — used to track current text externally */
  onTextChange?: (text: string) => void;
  /** Persists the typed text under this key (`draftKey`, COR-143). Omit for no draft. */
  draftKey?: string | null;
}

// ─── Component ───────────────────────────────────────────────────────────────

// Stable defaults so optional array props keep one identity across renders.
const EMPTY_AGENTS: Agent[] = [];
const EMPTY_MODELS: FlatModel[] = [];
const EMPTY_VARIANTS: string[] = [];
const EMPTY_SESSIONS: Session[] = [];
const EMPTY_COMMANDS: Command[] = [];

function SessionChatInputImpl({
  onSend,
  onStop,
  isBusy = false,
  disabled = false,
  placeholder = 'Ask anything',
  agent,
  agents = EMPTY_AGENTS,
  onAgentChange,
  onCreateAgent,
  model,
  models = EMPTY_MODELS,
  modelsLoading = false,
  modelUnavailable = false,
  onConnectModel,
  modelKey,
  variant,
  variants = EMPTY_VARIANTS,
  onModelChange,
  onVariantSet,
  sessions = EMPTY_SESSIONS,
  currentSessionId,
  sandboxUrl,
  projectId,
  canAttach = false,
  onEnqueue,
  inputSlot,
  onDraftChange,
  commands = EMPTY_COMMANDS,
  onCommand,
  initialText = '',
  onTextChange,
  draftKey = null,
}: SessionChatInputProps) {
  const [text, setText] = useState(initialText);
  useComposerDraft(draftKey, text, setText);
  const inputRef = useRef<TextInput>(null);
  const cursorRef = useRef(0);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const modelSheetRef = useRef<SheetRef>(null);
  // The model sheet's Agent tab: the thread's agents, the active one checked.
  const agentChoice = useMemo(
    () =>
      onAgentChange
        ? { agents, activeName: agent?.name ?? null, onSelect: onAgentChange, onCreate: onCreateAgent }
        : undefined,
    [agents, agent?.name, onAgentChange, onCreateAgent],
  );
  const openModelSheet = useCallback(() => {
    Keyboard.dismiss();
    requestAnimationFrame(() => {
      modelSheetRef.current?.open();
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

  // ── Skills ("#") ──────────────────────────────────────────────────────
  // The Skills page was removed from mobile (COR-160): a skill stays
  // reachable through the composer's own "#" trigger instead. Reuses the
  // project's `Command[]` list `/` already fetches, filtered to
  // `source === 'skill'` — see `lib/session/skill-mentions.ts`.
  const skill = useSkillMentions({ commands });

  const [autocontinueMode, setAutocontinueMode] = useState<AutoContinueMode | null>(null);
  const [showAutoSheet, setShowAutoSheet] = useState(false);
  const attachSheetRef = useRef<AttachSheetRef>(null);
  const filesSheetRef = useRef<SheetRef>(null);

  // ── File attachments ─────────────────────────────────────────────────────

  // A file starts uploading the moment it is picked; Send waits for the
  // uploads still in flight (`preparing`), then posts their handles.
  const toast = useToast();
  const attachments = useComposerAttachments(projectId);
  const [preparing, setPreparing] = useState(false);
  useRecoverPendingPick(attachments.add);

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
      skill.handleTextChange(newText, newText.length);

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
    [mention, skill, stagedCommand],
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

  const handleSkillSelect = useCallback(
    (item: MentionItem) => {
      const newText = skill.selectSkill(item, text);
      setText(newText);
      cursorRef.current = newText.length;
      setTimeout(() => inputRef.current?.focus(), 50);
    },
    [skill, text],
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

  const hasDraftText = text.trim().length > 0;

  useEffect(() => {
    onDraftChange?.(hasDraftText);
  }, [hasDraftText, onDraftChange]);

  const submitNow = useCallback(async () => {
    // Slash command popover open — select highlighted command
    if (slashFilter !== null && filteredCommands.length > 0) {
      handleSelectCommand(filteredCommands[slashIndex]);
      return;
    }

    if (mention.isOpen) {
      mention.dismiss();
      return;
    }

    // The `#` menu takes Send only while it shows rows. A draft ending in
    // `#word` that names no skill draws no menu, so Send sends it.
    if (suggestionMenuTakesSubmit({ isOpen: skill.isOpen, itemCount: skill.items.length })) {
      skill.dismiss();
      return;
    }

    const trimmedRaw = text.trim();
    const fileCount = attachments.files.length;
    const plan = planComposerSend({
      text: trimmedRaw,
      fileCount,
      disabled: disabled || preparing,
      isBusy,
      canQueue: Boolean(onEnqueue),
      canAttach,
      modelUnavailable,
      allowEmpty: Boolean(stagedCommand),
    });
    if (plan === 'noop') return;
    // No model: connect one first. Nothing is sent or queued; the draft,
    // the staged command, and the files stay.
    if (plan === 'connect-model') {
      Keyboard.dismiss();
      onConnectModel?.();
      return;
    }

    // Staged command — execute it with args
    if (stagedCommand) {
      onCommand?.(stagedCommand, trimmedRaw || undefined);
      setText('');
      setStagedCommand(null);
      return;
    }
    // Both refusals keep the text and the files in the composer.
    if (plan === 'refuse-busy-files') {
      toast.error('Wait for the reply to finish, then send your files.');
      return;
    }
    if (plan === 'refuse-no-session') {
      toast.error("Files can't be sent in this thread.");
      return;
    }

    // Dismiss the keyboard on send so the user sees the new message land
    // (matches WhatsApp / iMessage behavior on phones).
    Keyboard.dismiss();

    // A picked "#skill" token resolves like the staged "/" command above —
    // a structured dispatch that runs immediately, mirroring apps/web's
    // `planDraftSubmission` exactly (see `lib/session/skill-mentions.ts`).
    // A skill deleted since it was picked — or a draft that carries files or
    // `@` mentions, which a command dispatch cannot carry — degrades to the
    // "/name args" plain-text fallback and falls through to the normal send
    // path below, which sends the uploaded files and keeps the mentions.
    let trimmed = trimmedRaw;
    if (skill.mentions.length > 0) {
      const skillPlan = skill.resolveSubmission(text, fileCount > 0 || mention.mentions.length > 0);
      if (skillPlan.kind === 'command') {
        onCommand?.(skillPlan.command, skillPlan.args);
        setText('');
        attachments.clearAfterSend();
        mention.reset();
        skill.reset();
        return;
      }
      trimmed = skillPlan.text;
    }

    if (autocontinueMode && onCommand) {
      const alg = AUTOCONTINUE_ALGORITHMS.find((a) => a.id === autocontinueMode);
      const command = alg && commands.find((c) => c.name === alg.commandName);
      if (command) {
        onCommand(command, trimmed || undefined);
        setText('');
        setSlashFilter(null);
        setSlashIndex(0);
        mention.reset();
        skill.reset();
        return;
      }
    }

    // The agent is busy and there is an enqueue handler: queue instead of sending.
    if (plan === 'queue' && onEnqueue) {
      onEnqueue(trimmed);
      setText('');
      mention.reset();
      skill.reset();
      return;
    }

    const options: PromptOptions = {};
    if (agent?.name) options.agent = agent.name;
    if (modelKey) options.model = modelKey;
    if (variant) options.variant = variant;

    const trackedMentions = mention.mentions.length > 0 ? [...mention.mentions] : undefined;

    if (fileCount === 0) {
      // Clear input immediately for snappy UX
      setText('');
      mention.reset();
      skill.reset();
      onSend(trimmed, options, trackedMentions);
      return;
    }

    // With files: wait for every upload, then send their handles. A failed or
    // slow upload keeps the text and the files for another try.
    setPreparing(true);
    let sent: SendAttachments;
    try {
      sent = await attachments.takeForSend();
    } catch (err) {
      toast.error(uploadErrorMessage(err));
      setPreparing(false);
      return;
    }
    setPreparing(false);
    setText('');
    mention.reset();
    skill.reset();
    attachments.clearAfterSend();
    onSend(trimmed, options, trackedMentions, { fileParts: sent.fileParts, files: sent.files });
  }, [text, disabled, preparing, onSend, agent, modelKey, variant, mention, skill, isBusy, onEnqueue, canAttach, modelUnavailable, onConnectModel, toast, slashFilter, filteredCommands, slashIndex, handleSelectCommand, stagedCommand, onCommand, autocontinueMode, commands, attachments]);

  // One submission at a time: two taps inside one frame both read the same
  // draft (the cleared text has not rendered yet), so the second would send
  // it again. Released a frame after the submission settles.
  const submittingRef = useRef(false);
  const handleSubmit = useCallback(async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      await submitNow();
    } finally {
      requestAnimationFrame(() => {
        submittingRef.current = false;
      });
    }
  }, [submitNow]);

  // Web's groups and order (`lib/session/model-picker.ts`): the real upstream
  // provider, never the raw provider name (always "Kortix" under the gateway).
  const modelOptions = useMemo<PickerOption[]>(
    () => modelPickerOptions(models, (m) => `${m.providerID}/${m.modelID}`),
    [models],
  );

  const handleModelSelect = useCallback(
    (key: string) => {
      // A model id can contain "/", so the key is looked up, not split.
      const picked = models.find((m) => `${m.providerID}/${m.modelID}` === key);
      if (picked) onModelChange?.(picked.providerID, picked.modelID);
    },
    [models, onModelChange],
  );

  const thinking = useMemo(
    () => ({ levels: variants, selected: variant ?? null, onSelect: (level: string | null) => onVariantSet?.(level) }),
    [variants, variant, onVariantSet],
  );

  // `+` opens the Add sheet: Camera · Photos · Files, then Recent files. It only
  // attaches; AutoContinue lives in the model sheet, under Thinking.
  const hasAutoContinue = availableAutoAlgorithms.length > 0;
  const autoContinueRow = useMemo(
    () =>
      hasAutoContinue
        ? {
            value: autocontinueMode ? currentAutoAlgorithm?.label || 'On' : 'Off',
            // The AutoContinue sheet stacks over the model sheet; closing it returns there.
            onPress: () => setShowAutoSheet(true),
          }
        : undefined,
    [hasAutoContinue, autocontinueMode, currentAutoAlgorithm],
  );
  const handleAddPress = useCallback(() => {
    Keyboard.dismiss();
    attachSheetRef.current?.open();
  }, []);

  const handleSelectSessionFile = useCallback(
    (file: SessionFile) => {
      const newText = mention.addFileMention(sessionFileMentionLabel(file.path), text);
      cursorRef.current = newText.length;
      setText(newText);
    },
    [mention, text],
  );

  const cardHeader =
    inputSlot || stagedCommand ? (
      <View className="gap-2">
        {/* Queue / question slot */}
        {inputSlot}
        {stagedCommand ? (
          <View className="flex-row items-center gap-2">
            <View className="shrink flex-row items-center gap-1.5 rounded-full bg-secondary py-1.5 pl-3 pr-2">
              <Icon as={TerminalIcon} size={14} className="text-muted-foreground" />
              <Text variant="small" numberOfLines={1} className="shrink leading-5">
                /{stagedCommand.name}
              </Text>
              <Pressable
                onPress={() => {
                  setStagedCommand(null);
                  setText('');
                }}
                hitSlop={11}
                accessibilityRole="button"
                accessibilityLabel={`Remove command ${stagedCommand.name}`}
                className="active:opacity-60">
                <Icon as={XIcon} size={14} className="text-muted-foreground" />
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
    ) : null;

  return (
    <>
      <View>
        {/* Slash command suggestions — above the input */}
        {slashFilter !== null && filteredCommands.length > 0 && (
          <SlashCommandSuggestions
            commands={filteredCommands}
            selectedIndex={slashIndex}
            onSelect={handleSelectCommand}
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

        {/* Skill suggestions — above the input, opened by "#" (COR-160) */}
        {slashFilter === null && !mention.isOpen && skill.isOpen && skill.items.length > 0 && (
          <MentionSuggestions
            items={skill.items}
            selectedIndex={skill.selectedIndex}
            onSelect={handleSkillSelect}
          />
        )}

        {/* The project home's card (design.md §5): same edge, same bottom gap.
            `pb-3` under `px-4`: vertical padding is one step below horizontal
            (design.md §2). It is the gap above the keyboard while typing. */}
        <View className="px-4 pb-3 pt-1">
          <Composer
            inputRef={inputRef}
            value={text}
            onChangeText={handleTextChange}
            onSelectionChange={handleSelectionChange}
            onSubmit={handleSubmit}
            placeholder={stagedCommand ? 'Add details, then send' : placeholder}
            maxLength={10000}
            disabled={disabled || preparing}
            sending={preparing}
            allowEmptySend={!!stagedCommand}
            busy={isBusy}
            onStop={onStop}
            header={cardHeader}
            attachments={attachments.files}
            attachmentUploads={attachments.uploads}
            onAttach={handleAddPress}
            attachLabel="Add"
            onRemoveAttachment={attachments.remove}
            chip={
              modelsLoading
                ? null
                : composerChip({
                    connectModel: modelUnavailable,
                    agentName: agent?.name,
                    modelName: model ? pickerModelName(model) : undefined,
                  })
            }
            onChipPress={openModelSheet}
            accessory={
              autocontinueMode && currentAutoAlgorithm ? (
                <Button
                  variant="secondary"
                  size="icon-md"
                  className="rounded-full"
                  hitSlop={COMPOSER_CONTROL_HIT_SLOP}
                  onPress={() => setShowAutoSheet(true)}
                  accessibilityLabel={`AutoContinue, ${currentAutoAlgorithm.label}`}>
                  <Icon as={InfinityIcon} size={18} className="text-kortix-purple" />
                </Button>
              ) : null
            }
          />
        </View>
      </View>

      {/* Add sheet — Camera · Photos · Files, then Recent files. */}
      <AttachSheet ref={attachSheetRef} onPick={attachments.add}>
        <SettingsGroup>
          <SettingsRow
            icon={StackIcon}
            label="Recent files"
            onPress={() => attachSheetRef.current?.closeThen(() => filesSheetRef.current?.open())}
          />
        </SettingsGroup>
      </AttachSheet>

      {/* Recent files — the files this session produced; a row previews the file, "Add to chat" mentions it. */}
      <SessionFilesSheet
        ref={filesSheetRef}
        sessionId={currentSessionId}
        sandboxUrl={sandboxUrl}
        onSelect={handleSelectSessionFile}
      />

      {/* Model sheet — models by provider, thinking level of the active model */}
      <ModelPickerSheet
        ref={modelSheetRef}
        options={modelOptions}
        activeKey={model ? `${model.providerID}/${model.modelID}` : null}
        onSelect={handleModelSelect}
        thinking={thinking}
        onConnect={onConnectModel}
        agent={agentChoice}
        autoContinue={autoContinueRow}
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

/**
 * Memoized: the session thread re-renders on every streamed delta, and the
 * composer (three bottom-sheet modals) must skip those renders. Callers pass
 * stable callbacks and memoized array props.
 */
export const SessionChatInput = React.memo(SessionChatInputImpl);

function InfinityOffIcon({ color, size }: { color: string; size: number }) {
  return (
    <View style={{ width: size, height: size }}>
      <InfinityIcon color={color} size={size} />
      <Svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        style={{ position: 'absolute', left: 0, top: 0 }}
      >
        <Line x1={22} y1={2} x2={2} y2={22} stroke={color} strokeWidth={2} strokeLinecap="round" />
      </Svg>
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
    <KortixBottomSheetModal
      ref={sheetRef}
      enableDynamicSizing
      maxDynamicContentSize={Math.floor(screenHeight * 0.86)}
      enablePanDownToClose={!detailAlg}
      enableOverDrag={false}
      onDismiss={handleSheetDismiss}
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
              accessibilityLabel="Back"
              style={{ marginRight: 12 }}
            >
              <CaretLeftIcon size={22} color={muted} />
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
              <CheckIcon size={18} color={THEME.accent.purple} />
            </Button>
          </View>

          <View style={{ paddingHorizontal: 20 }}>
            <Text style={{ color: muted, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
              Role
            </Text>
            <Text style={{ fontSize: 14, marginBottom: 16, color: isDark ? THEME.dark.foreground : THEME.light.foreground }}>
              {detailAlg.role}
            </Text>

            <Text style={{ color: muted, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
              Description
            </Text>
            <Text style={{ fontSize: 14, color: isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground, marginBottom: 16 }}>
              {detailAlg.description}
            </Text>

            <Text style={{ color: muted, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
              Best for
            </Text>
            <Text style={{ fontSize: 14, color: isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground, marginBottom: 16 }}>
              {detailAlg.bestFor}
            </Text>

            <View style={{ flexDirection: 'row', marginTop: 4 }}>
              <View style={{ flex: 1, marginRight: 12 }}>
                <Text style={{ color: muted, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                  Strengths
                </Text>
                {detailAlg.strengths.map((s, idx) => (
                  <Text key={idx} style={{ fontSize: 13, color: THEME.accent.green, marginBottom: 6 }}>
                    • {s}
                  </Text>
                ))}
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={{ color: muted, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                  Weaknesses
                </Text>
                {detailAlg.weaknesses.map((s, idx) => (
                  <Text key={idx} style={{ fontSize: 13, color: THEME.accent.orange, marginBottom: 6 }}>
                    • {s}
                  </Text>
                ))}
              </View>
            </View>

            <Text style={{ color: muted, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, marginTop: 20, marginBottom: 8 }}>
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
                <Text style={{ fontSize: 13, color: muted, marginTop: 2 }}>
                  Manual — you send each message
                </Text>
              </View>
              {!isActive && <CheckIcon size={18} color={THEME.accent.purple} />}
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
              <InfinityIcon color={isActive ? (THEME.accent.purple) : muted} size={18} />
              <View style={{ marginLeft: 12, flex: 1 }}>
                <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: isDark ? THEME.dark.foreground : THEME.light.foreground }}>
                  On
                </Text>
                <Text style={{ fontSize: 13, color: muted, marginTop: 2 }}>
                  {isActive && currentAlg
                    ? `Running ${currentAlg.label}`
                    : 'Pick an algorithm and the agent will continue on its own'}
                </Text>
              </View>
              {isActive && <CheckIcon size={18} color={THEME.accent.purple} />}
            </Button>
          </View>

          <View style={{ marginTop: 20, paddingHorizontal: 20 }}>
            <Text style={{ fontSize: 13, color: muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
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
                    <Text style={{ fontSize: 13, color: muted, marginTop: 1 }}>
                      {alg.role}
                    </Text>
                    <Text style={{ fontSize: 13, color: isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground, marginTop: 6 }} numberOfLines={1}>
                      {alg.description}
                    </Text>
                  </View>
                  <Button
                    variant="ghost"
                    className="h-auto w-auto gap-0 rounded-md p-0 active:bg-transparent active:opacity-20"
                    hitSlop={10}
                    accessibilityLabel={`About ${alg.label}`}
                    onPress={() => setDetailAlg(alg)}
                    style={{ padding: 6, marginHorizontal: 4 }}
                  >
                    <InfoIcon size={18} color={muted} />
                  </Button>
                  {isSelected && (
                    <CheckIcon size={18} color={THEME.accent.purple} />
                  )}
                </View>
              </Button>
            );
          })}
        </View>
        </BottomSheetScrollView>
      )}
    </KortixBottomSheetModal>
  );
}

// ─── Slash Command Suggestions ───────────────────────────────────────────────

/** `/` commands: the mention list's card and rows, the command's name only. */
function SlashCommandSuggestions({
  commands,
  selectedIndex,
  onSelect,
}: {
  commands: Command[];
  selectedIndex: number;
  onSelect: (cmd: Command) => void;
}) {
  return (
    <SuggestionCard>
      {commands.map((cmd, i) => (
        <SuggestionRow key={cmd.name} label={cmd.name} selected={i === selectedIndex} onPress={() => onSelect(cmd)} />
      ))}
    </SuggestionCard>
  );
}
