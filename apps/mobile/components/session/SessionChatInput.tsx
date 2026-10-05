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
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { useColorScheme } from 'nativewind';
import {
  InfinityIcon,
  StackIcon,
  XIcon,
  TerminalIcon,
} from '@/lib/icons';
import { Icon } from '@/components/ui/icon';
import type { SessionPromptPart } from '@kortix/sdk';
import type { AttachedFile } from '@/lib/session/attachments';
import { planComposerSend } from '@/lib/session/send-plan';
import { uploadErrorMessage } from '@/lib/session/composer-uploads';
import { useToast } from '@/components/kortix/toast-provider';
import { useComposerAttachments } from './useComposerAttachments';
import { useRecoverPendingPick } from './useRecoverPendingPick';
import { useComposerDraft } from '@/lib/session/use-composer-draft';
import { AttachSheet, type AttachSheetRef } from './AttachSheet';
import { useSessionFilesRequestStore } from '@/stores/session-files-request-store';
import { useToolFilePreviewStore } from './tool/shared/navigation';

import type { Agent, FlatModel, Command } from '@/lib/session/runtime-data';
import type { Session } from '@/lib/session/types';
import { MentionSuggestions, SuggestionCard, SuggestionRow } from './MentionSuggestions';
import { useMentions, type TrackedMention, type MentionItem } from './useMentions';
import { useSkillMentions } from './useSkillMentions';
import { suggestionMenuTakesSubmit } from '@/lib/session/skill-mentions';
import { type SheetRef } from '@/components/kortix/sheet';
import { AutoContinueSheet, useAutoContinue } from './autocontinue';
import { Composer, COMPOSER_CONTROL_HIT_SLOP } from '@/components/kortix/composer';
import { sessionFileMentionLabel, type SessionFile } from '@/lib/session/session-files';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { ModelPickerSheet } from './ModelPickerSheet';
import { composerChip, type PickerOption } from '@/lib/session/composer-config';
import { useLocalConfigStore } from '@/lib/session/local-config';
import { modelOptionKey, modelPickerOptions, pickerModelName } from '@/lib/session/model-picker';

// ─── Types ───────────────────────────────────────────────────────────────────

export type { AttachedFile } from '@/lib/session/attachments';

export interface PromptOptions {
  agent?: string;
  model?: { providerID: string; modelID: string };
  variant?: string;
}

export type { TrackedMention } from './useMentions';
export type { AutoContinueMode } from './autocontinue';

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
  /** Focus the field at mount: it replaces a field that had the keyboard up. */
  autoFocus?: boolean;
  /** `nativeID` of the text field, for the thread's drag-to-dismiss area. */
  inputNativeID?: string;
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
   * The sandbox has not listed its agents yet (a new thread): the chip reads
   * the agent project home sent with, never the model name (`composerChip`).
   */
  agentsLoading?: boolean;
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
  onEnqueue?: (text: string, options: PromptOptions, mentions?: TrackedMention[]) => Promise<void>;
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
  autoFocus,
  inputNativeID,
  placeholder = 'Ask anything',
  agent,
  agents = EMPTY_AGENTS,
  onAgentChange,
  onCreateAgent,
  model,
  models = EMPTY_MODELS,
  modelsLoading = false,
  agentsLoading = false,
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
  // The rendered text, for handlers that must keep one identity across
  // keystrokes (the memoized sheets below take them as props).
  const textRef = useRef(text);
  textRef.current = text;
  const inputRef = useRef<TextInput>(null);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const modelSheetRef = useRef<SheetRef>(null);
  // The model sheet's Agent tab: the thread's agents, the active one checked.
  // The agent project home last sent with (`ProjectHome` → `setAgent`).
  const pendingAgentName = useLocalConfigStore((s) => s.selectedAgent);
  const agentChoice = useMemo(
    () =>
      onAgentChange
        ? { agents, activeName: agent?.name ?? null, onSelect: onAgentChange, onCreate: onCreateAgent }
        : undefined,
    [agents, agent?.name, onAgentChange, onCreateAgent],
  );
  const openModelSheet = useCallback(() => {
    modelSheetRef.current?.open();
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

  const auto = useAutoContinue(commands, onCommand);
  const [showAutoSheet, setShowAutoSheet] = useState(false);
  const attachSheetRef = useRef<AttachSheetRef>(null);

  // ── File attachments ─────────────────────────────────────────────────────

  // A file starts uploading the moment it is picked; Send waits for the
  // uploads still in flight (`preparing`), then posts their handles.
  const toast = useToast();
  const attachments = useComposerAttachments(projectId);
  const [preparing, setPreparing] = useState(false);
  useRecoverPendingPick(attachments.add);

  const handleTextChange = useCallback(
    (newText: string) => {
      textRef.current = newText;
      setText(newText);
      onTextChange?.(newText);
      mention.prune(newText);
      skill.prune(newText);

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
      mention.detect(textRef.current, e.nativeEvent.selection.end);
      skill.detect(textRef.current, e.nativeEvent.selection.end);
    },
    [mention, skill],
  );

  const handleMentionSelect = useCallback(
    (item: MentionItem) => {
      const newText = mention.selectMention(item, text);
      setText(newText);
      setTimeout(() => inputRef.current?.focus(), 50);
    },
    [mention, text],
  );

  const handleSkillSelect = useCallback(
    (item: MentionItem) => {
      const newText = skill.selectSkill(item, text);
      setText(newText);
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

    // A send keeps the keyboard up: the next message, or a queued follow-up,
    // is typed without reopening it. The list follows the sent message.

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

    if (auto.dispatch(trimmed)) {
      setText('');
      setSlashFilter(null);
      setSlashIndex(0);
      mention.reset();
      skill.reset();
      return;
    }

    const options: PromptOptions = {};
    if (agent?.name) options.agent = agent.name;
    if (modelKey) options.model = modelKey;
    if (variant) options.variant = variant;
    const trackedMentions = mention.mentions.length > 0 ? [...mention.mentions] : undefined;

    if (plan === 'queue' && onEnqueue) {
      // Keep the draft on a refused write; server acceptance is the durability boundary.
      try {
        await onEnqueue(trimmed, options, trackedMentions);
        setText('');
        mention.reset();
        skill.reset();
      } catch { /* The queue handler reports the refusal. */ }
      return;
    }

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
  }, [text, disabled, preparing, onSend, agent, modelKey, variant, mention, skill, isBusy, onEnqueue, canAttach, modelUnavailable, onConnectModel, toast, slashFilter, filteredCommands, slashIndex, handleSelectCommand, stagedCommand, onCommand, auto, attachments]);

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

  // Web's groups, order, and empty-search view (`lib/session/model-picker.ts`):
  // the real upstream provider, never the raw provider name (always "Kortix"
  // under the gateway).
  const modelOptions = useMemo<PickerOption[]>(
    () => modelPickerOptions(models, modelKey ?? null),
    [models, modelKey],
  );

  const handleModelSelect = useCallback(
    (key: string) => {
      // A model id can contain "/", so the key is looked up, not split.
      const picked = models.find((m) => modelOptionKey(m) === key);
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
  const hasAutoContinue = auto.algorithms.length > 0;
  const autoContinueRow = useMemo(
    () =>
      hasAutoContinue
        ? {
            value: auto.mode ? auto.current?.label || 'On' : 'Off',
            // The AutoContinue sheet stacks over the model sheet; closing it returns there.
            onPress: () => setShowAutoSheet(true),
          }
        : undefined,
    [hasAutoContinue, auto.mode, auto.current],
  );
  const handleAddPress = useCallback(() => {
    attachSheetRef.current?.open();
  }, []);
  const closeAutoSheet = useCallback(() => setShowAutoSheet(false), []);
  // One element for the whole mount: the memoized Add sheet skips keystrokes.
  const attachSheetExtras = useMemo(
    () => (
      <SettingsGroup>
        <SettingsRow
          icon={StackIcon}
          label="Recent files"
          // `SessionPage` hosts the Recent files sheet; the request opens it.
          onPress={() =>
            attachSheetRef.current?.closeThen(() => {
              if (currentSessionId) useSessionFilesRequestStore.getState().requestOpen(currentSessionId);
            })
          }
        />
      </SettingsGroup>
    ),
    [currentSessionId],
  );

  const { addFileMention } = mention;
  const handleSelectSessionFile = useCallback(
    (file: SessionFile) => {
      const newText = addFileMention(sessionFileMentionLabel(file.path), textRef.current);
      setText(newText);
    },
    [addFileMention],
  );

  // "Add to chat" in the transcript's file preview (attachments, mentions, tool
  // rows): the same mention Recent files writes. Held in a ref so the
  // registration does not churn on every keystroke.
  const addFileMentionRef = useRef((path: string) => handleSelectSessionFile({ path } as SessionFile));
  addFileMentionRef.current = (path: string) => handleSelectSessionFile({ path } as SessionFile);
  useEffect(() => {
    const { setAddToChat } = useToolFilePreviewStore.getState();
    setAddToChat((path) => addFileMentionRef.current(path));
    return () => setAddToChat(null);
  }, []);

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
            autoFocus={autoFocus}
            inputNativeID={inputNativeID}
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
                    pendingAgentName,
                    agentsLoading,
                    modelName: model ? pickerModelName(model) : undefined,
                  })
            }
            onChipPress={openModelSheet}
            accessory={
              auto.mode && auto.current ? (
                <Button
                  variant="secondary"
                  size="icon-md"
                  className="rounded-full"
                  hitSlop={COMPOSER_CONTROL_HIT_SLOP}
                  onPress={() => setShowAutoSheet(true)}
                  accessibilityLabel={`AutoContinue, ${auto.current.label}`}>
                  <Icon as={InfinityIcon} size={18} className="text-kortix-purple" />
                </Button>
              ) : null
            }
          />
        </View>
      </View>

      {/* Add sheet — Camera · Photos · Files, then Recent files. */}
      <AttachSheet ref={attachSheetRef} onPick={attachments.add}>
        {attachSheetExtras}
      </AttachSheet>

      {/* Model sheet — models by provider, thinking level of the active model */}
      <ModelPickerSheet
        ref={modelSheetRef}
        options={modelOptions}
        activeKey={model ? modelOptionKey(model) : null}
        onSelect={handleModelSelect}
        thinking={thinking}
        onConnect={onConnectModel}
        agent={agentChoice}
        autoContinue={autoContinueRow}
      />

      <AutoContinueSheet
        visible={showAutoSheet}
        onClose={closeAutoSheet}
        selected={auto.mode}
        onSelect={auto.setMode}
        algorithms={auto.algorithms}
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
