/**
 * ProjectHome — the project screen when no chat is open (COR-34).
 *
 * The Kortix symbol sits dead centre, alone (Jay, 2026-09-21: no sentence, no
 * project name), and the chat input is pinned to the bottom. Nothing else: no
 * starter chips, cards, or lists. The floating header (hamburger · agent pill ·
 * `···`, which opens the project sheet) is the project screen's chrome, shared
 * with the thread, not part of this content.
 *
 * The chat input is one card: text on top, then add files · agent chip · send.
 * The chip names the agent (KRTX-247) and opens the agent and model sheet.
 * Each file uploads when it is picked (`useComposerAttachments`, COR-185), so
 * the send waits for the uploads and hands their parts to ProjectScreen,
 * which creates the session with them. The agents and models are web's,
 * built by `@kortix/sdk` (`useComposerModels`); a model pick is sent as
 * `model`. A gateway project that offers no model never starts a
 * session: Send opens the connect-provider sheet and keeps the draft
 * (KRTX-251, `planComposerSend`).
 *
 * Layout:
 * - The symbol (`ProjectHero`) is absolutely centred in the keyboard-avoiding
 *   area. At rest that area is the whole screen; while typing it is the part
 *   above the keyboard, so the symbol never sits under the composer. It is
 *   large at rest and scales down with the keyboard.
 * - At rest the composer sits at the thread composer's distance from the
 *   bottom (SessionPage pads `insets.bottom`, SessionChatInput adds `pb-3`).
 * - The composer follows the keyboard down to KEYBOARD_GAP above it once it appears.
 *
 * The draft lives in `HomeComposer`, not here: a keystroke re-renders the
 * composer card only, never the hero (a Skia canvas), the sheets or the model
 * resolution.
 */

import * as React from 'react';
import {
  resolveComposerAgent,
  resolveComposerModel,
  resolveModelDefault,
  type SessionPromptPart,
} from '@kortix/sdk';
import { newConfigPrompt } from '@kortix/shared';
import { Keyboard, Pressable, View } from 'react-native';
import {
  KeyboardAvoidingView,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import Reanimated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Composer } from '@/components/kortix/composer';
import type { SheetRef } from '@/components/kortix/sheet';
import { useToast } from '@/components/kortix/toast-provider';
import { FloatingMenuButton } from '@/components/session/FloatingMenuButton';
import { ConnectProviderSheet } from '@/components/session/ConnectProviderSheet';
import { ModelPickerSheet } from '@/components/session/ModelPickerSheet';
import { ProjectHero } from '@/components/session/ProjectHero';
import { AttachSheet, type AttachSheetRef } from '@/components/session/AttachSheet';
import { useComposerAttachments } from '@/components/session/useComposerAttachments';
import { useRecoverPendingPick } from '@/components/session/useRecoverPendingPick';
import { useComposerModels, useProjectDetail } from '@/lib/projects/hooks';
import type { AttachedFile } from '@/lib/session/attachments';
import { uploadErrorMessage } from '@/lib/session/composer-uploads';
import { takeComposerFocus } from '@/lib/onboarding/composer-handoff';
import { draftKey } from '@/lib/session/composer-draft';
import { useComposerDraft } from '@/lib/session/use-composer-draft';
import { isModelUnavailable, sessionModelRef, selectComposerModel } from '@/lib/session/composer-model';
import { planComposerSend } from '@/lib/session/send-plan';
import { useLocalConfigStore } from '@/lib/session/local-config';
import { composerChip, homeAgentPick, threadAgents, type PickerOption } from '@/lib/session/composer-config';
import {
  firstPromptPicks,
  modelOptionKey,
  modelPickerOptions,
  offeredModelCount,
  pickerModelName,
} from '@/lib/session/model-picker';
import type { Agent } from '@/lib/session/runtime-data';

/** One identity while the project detail loads, so the sheet's agent memo does not churn. */
const EMPTY_AGENTS: Agent[] = [];

/** The thread composer's own bottom padding (SessionChatInput's `pb-3`), so
 *  this composer rests at the same distance from the safe-area bottom. `pb-3`
 *  under the `px-4` edge: vertical is one step below horizontal (design.md §2). */
const COMPOSER_BOTTOM_GAP = 12;
/** Composer to keyboard while the keyboard is up. The same 12pt as the thread. */
const KEYBOARD_GAP = 12;

export interface ProjectHomeSubmit {
  text: string;
  files: AttachedFile[];
  /** The uploaded files' prompt parts, in `files` order (`takeForSend`). */
  fileParts: SessionPromptPart[];
  /** The session `model` of a pick (`sessionModelRef`), or null to use the project default. */
  model: string | null;
  /**
   * The thinking level to run the first message on, with the model it belongs
   * to. Null when no level is set (`firstPromptPicks`).
   */
  picks: { model: { providerID: string; modelID: string }; variant: string } | null;
  /** The agent to start the session on. Null: none is sent and the server decides. */
  agent: string | null;
}

export interface ProjectHomeProps {
  projectId: string;
  /** A send is in flight: the composer keeps its content and locks. */
  sending?: boolean;
  /**
   * Parent handles the create+connect flow for a brand-new session. Resolves
   * `false` when the session was not started: the draft and files stay.
   */
  onSubmitNewSession: (input: ProjectHomeSubmit) => Promise<boolean>;
  onOpenDrawer: () => void;
  /**
   * Read-and-clear the draft text and files to seed the composer with, if any
   * — e.g. a project-home send the user cancelled from `SessionConnecting`
   * before it connected (COR-146: `ProjectScreen.handleCancelConnect`). Called
   * once, at mount; the parent's `homeKey` bump remounts this screen whenever
   * it has a draft to hand back, so a lazy initial read is enough — no effect
   * needed, and nothing here re-reads it on a later re-render. The files
   * upload again (`useComposerAttachments`'s `initialFiles`).
   */
  takeInitialDraft?: () => { text: string; files: AttachedFile[] };
}

export function ProjectHome({
  projectId,
  sending = false,
  onSubmitNewSession,
  onOpenDrawer,
  takeInitialDraft,
}: ProjectHomeProps) {
  const insets = useSafeAreaInsets();
  const toast = useToast();
  // One read at mount: the text seeds the draft, the files seed the uploads.
  const [initialDraft] = React.useState(() => takeInitialDraft?.() ?? { text: '', files: [] });
  // The first project, just created on `/new` (COR-161): open with the
  // keyboard up. One-shot, read once at mount.
  const [focusComposer] = React.useState(() => takeComposerFocus(projectId));
  const attachments = useComposerAttachments(projectId, { initialFiles: initialDraft.files });
  useRecoverPendingPick(attachments.add);
  const files = attachments.files;
  // Waiting for the uploads before the create: the send slot shows the loader.
  const [preparing, setPreparing] = React.useState(false);
  const modelSheetRef = React.useRef<SheetRef>(null);
  const connectSheetRef = React.useRef<SheetRef>(null);
  const attachSheetRef = React.useRef<AttachSheetRef>(null);

  // Agent: web's order (`resolveComposerAgent`): the pick made here, else the
  // project default, else — only when the project declares none — the last
  // agent picked anywhere, else the first. Home has no sandbox: the roster is
  // the project config's (`/detail`). A pick also becomes the store's
  // last-used agent, which the thread's chip reads while its roster loads.
  const { data: projectDetail } = useProjectDetail(projectId);
  const projectConfig = projectDetail?.config;
  const projectAgents = React.useMemo(
    () => (projectConfig ? threadAgents(projectConfig) : undefined),
    [projectConfig],
  );
  const defaultAgent = projectConfig?.default_agent ?? projectConfig?.open_code_default_agent ?? null;
  const [pickedAgent, setPickedAgent] = React.useState<string | null>(null);
  const lastUsedAgent = useLocalConfigStore((s) => s.selectedAgent);
  const setLastUsedAgent = useLocalConfigStore((s) => s.setAgent);
  const agentName = resolveComposerAgent({
    agents: projectAgents,
    defaultAgent,
    selectedAgent: homeAgentPick({ picked: pickedAgent, defaultAgent, lastUsed: lastUsedAgent }),
  }).selected;
  const handleAgentChange = React.useCallback(
    (name: string) => {
      setPickedAgent(name);
      setLastUsedAgent(name);
    },
    [setLastUsedAgent],
  );
  // The model sheet's Agent tab: the project config's agents. Its `+` starts
  // a new session on the shared "configure a new agent" prompt, through the
  // same path as a composer send.
  const handleCreateAgent = React.useCallback(() => {
    void onSubmitNewSession({
      text: newConfigPrompt('agent'),
      files: [],
      fileParts: [],
      model: null,
      picks: null,
      agent: null,
    });
  }, [onSubmitNewSession]);
  const agentChoice = React.useMemo(
    () => ({ agents: projectAgents ?? EMPTY_AGENTS, activeName: agentName, onSelect: handleAgentChange, onCreate: handleCreateAgent }),
    [projectAgents, agentName, handleAgentChange, handleCreateAgent],
  );

  // Models: the list web and the thread show (`useComposerModels`). The
  // default is `@kortix/sdk`'s: `/model-defaults` for this agent, then the
  // provider defaults. A pick equal to the default is no pick
  // (`selectComposerModel`): the session keeps following the default.
  const { gatewayEnabled, providers, models, modelDefaults, isLoading: modelsLoading, refetchModelCount } =
    useComposerModels(projectId);
  const globalDefault = useLocalConfigStore((s) => s.globalDefault) ?? undefined;
  // The pick persists in the store the thread reads (`agentModels`, per
  // agent), so it survives the remount after a send and the thread opens on
  // the same model and thinking level.
  const agentSlot = agentName ?? '_default';
  const pickedModel = useLocalConfigStore((s) => s.agentModels[agentSlot]);
  const setModelForAgent = useLocalConfigStore((s) => s.setModelForAgent);
  const { defaultModel, activeKey, explicit } = React.useMemo(() => {
    const modelInput = {
      models,
      serverDefault: resolveModelDefault(modelDefaults, agentName ?? undefined),
      globalDefault,
      providers,
    };
    const active = resolveComposerModel({ ...modelInput, picks: [pickedModel] });
    return {
      defaultModel: resolveComposerModel(modelInput).model,
      activeKey: active.model,
      explicit: active.explicit,
    };
  }, [models, modelDefaults, agentName, globalDefault, providers, pickedModel]);
  const activeModel = activeKey
    ? models.find((m) => m.providerID === activeKey.providerID && m.modelID === activeKey.modelID)
    : undefined;
  const modelOptions = React.useMemo<PickerOption[]>(
    () => modelPickerOptions(models, activeModel ?? null),
    [models, activeModel],
  );
  // Thinking: the active model's levels. The level lives in the store the
  // thread reads (`modelVariants["<providerID>/<modelID>"]`), so a level set
  // here is the thread's level, and the other way round.
  const levels = React.useMemo(() => Object.keys(activeModel?.variants ?? {}), [activeModel]);
  const variantKey = activeModel ? modelOptionKey(activeModel) : '';
  const storedVariant = useLocalConfigStore((s) => (variantKey ? (s.modelVariants[variantKey] ?? null) : null));
  const setStoredVariant = useLocalConfigStore((s) => s.setVariant);
  const variant = storedVariant && levels.includes(storedVariant) ? storedVariant : null;
  const thinking = React.useMemo(
    () => ({
      levels,
      selected: variant,
      onSelect: (level: string | null) => {
        if (variantKey) setStoredVariant(variantKey, level);
      },
    }),
    [levels, variant, variantKey, setStoredVariant],
  );
  // A gateway project that offers no model: the chip asks to connect one, and
  // Send opens the connect sheet instead of starting a session (KRTX-251).
  const modelUnavailable = isModelUnavailable({
    hasCatalog: gatewayEnabled,
    loading: modelsLoading,
    modelCount: offeredModelCount(models),
  });
  // The chip names the agent; the model name stands in when no agent
  // resolves. While the agents or the models load, the chip stays hidden.
  const chip = modelsLoading
    ? null
    : composerChip({
        connectModel: modelUnavailable,
        agentName,
        agentsLoading: !projectAgents,
        modelName: activeModel ? pickerModelName(activeModel) : null,
      });
  const openConnectSheet = React.useCallback(() => {
    connectSheetRef.current?.open();
  }, []);
  const openAttachSheet = React.useCallback(() => attachSheetRef.current?.open(), []);
  const openModelSheet = React.useCallback(() => modelSheetRef.current?.open(), []);
  const handleModelSelect = React.useCallback(
    (key: string) => {
      const picked = selectComposerModel(key, defaultModel ? modelOptionKey(defaultModel) : null);
      const m = picked ? models.find((x) => modelOptionKey(x) === picked) : undefined;
      setModelForAgent(agentSlot, m ? { providerID: m.providerID, modelID: m.modelID } : null);
    },
    [defaultModel, models, setModelForAgent, agentSlot],
  );

  const restingGap = insets.bottom + COMPOSER_BOTTOM_GAP;
  const { progress } = useReanimatedKeyboardAnimation();
  const composerStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: progress.value * (restingGap - KEYBOARD_GAP) }],
  }));

  // Nothing is cleared on send. A successful send pushes the connecting state
  // over this screen, and the project stack remounts this screen once it is
  // covered (ProjectRoutes `homeKey`). A failed or gated send (upload,
  // credits, network) leaves the prompt and files in place, and hands the
  // uploads back to the composer. Web does the same (`clearOnSend={false}` on
  // the home composer).
  const isSending = sending || preparing;
  const submitNow = React.useCallback(async (draft: string) => {
    const text = draft.trim();
    const plan = planComposerSend({
      text,
      fileCount: files.length,
      disabled: isSending,
      isBusy: false,
      canQueue: false,
      canAttach: true,
      modelUnavailable,
    });
    if (plan === 'noop') return;
    // No model: connect one first. The draft and files stay.
    if (plan === 'connect-model') {
      openConnectSheet();
      return;
    }
    let sent: { files: AttachedFile[]; fileParts: SessionPromptPart[] } = { files: [], fileParts: [] };
    if (files.length > 0) {
      setPreparing(true);
      try {
        sent = await attachments.takeForSend();
      } catch (err) {
        // `takeForSend` already handed the uploads back to the composer.
        toast.error(uploadErrorMessage(err));
        return;
      } finally {
        setPreparing(false);
      }
    }
    // The thread's header reads the store: it then shows the agent this session runs on.
    if (agentName) setLastUsedAgent(agentName);
    const ok = await onSubmitNewSession({
      text,
      files: sent.files,
      fileParts: sent.fileParts,
      model: explicit ? sessionModelRef(explicit) : null,
      picks: firstPromptPicks(activeKey ?? null, variant, levels),
      agent: agentName,
    });
    if (!ok) {
      attachments.reclaim(
        sent.files.map((f) => f.uploadId).filter((id): id is string => Boolean(id)),
      );
    }
  }, [
    files,
    isSending,
    modelUnavailable,
    openConnectSheet,
    attachments,
    toast,
    explicit,
    activeKey,
    variant,
    levels,
    agentName,
    setLastUsedAgent,
    onSubmitNewSession,
  ]);

  return (
    <View className="flex-1 bg-background">
      {/* Floating menu button — opens the left drawer. */}
      {/* No header controls: the agent is picked in the model sheet's Agent
          tab (Jay, 2026-09-23). */}
      <FloatingMenuButton onPress={onOpenDrawer} />

      <KeyboardAvoidingView className="flex-1" behavior="padding">
        <View className="flex-1">
          {/* Tap outside the field to close the keyboard. Not a control. */}
          <Pressable className="flex-1" onPress={Keyboard.dismiss} accessible={false} />

          {/* `box-none`: only the symbol takes touches (its hidden 5-second
              press); the space around it still reaches the Pressable above. */}
          <View
            pointerEvents="box-none"
            className="absolute inset-0 items-center justify-center">
            <ProjectHero />
          </View>

          <Reanimated.View className="px-4" style={[{ paddingBottom: restingGap }, composerStyle]}>
            <HomeComposer
              projectId={projectId}
              initialText={initialDraft.text}
              onSubmit={submitNow}
              autoFocus={focusComposer}
              disabled={isSending}
              sending={isSending}
              attachments={files}
              attachmentUploads={attachments.uploads}
              onAttach={openAttachSheet}
              onRemoveAttachment={attachments.remove}
              chip={chip}
              onChipPress={openModelSheet}
            />
          </Reanimated.View>
        </View>
      </KeyboardAvoidingView>

      <AttachSheet ref={attachSheetRef} onPick={attachments.add} />

      <ModelPickerSheet
        ref={modelSheetRef}
        options={modelOptions}
        activeKey={activeKey ? modelOptionKey(activeKey) : null}
        thinking={thinking}
        onSelect={handleModelSelect}
        onConnect={openConnectSheet}
        agent={agentChoice}
      />

      <ConnectProviderSheet
        ref={connectSheetRef}
        projectId={projectId}
        onRefetchModels={refetchModelCount}
      />
    </View>
  );
}

/**
 * The home composer and its draft. The draft is state here, so a keystroke
 * re-renders this card only. `onSubmit` gets the draft as rendered.
 */
function HomeComposer({
  projectId,
  initialText,
  onSubmit,
  ...composer
}: {
  projectId: string;
  initialText: string;
  onSubmit: (draft: string) => Promise<void>;
  autoFocus: boolean;
  disabled: boolean;
  sending: boolean;
  attachments: AttachedFile[];
  attachmentUploads: React.ComponentProps<typeof Composer>['attachmentUploads'];
  onAttach: () => void;
  onRemoveAttachment: (index: number) => void;
  chip: React.ComponentProps<typeof Composer>['chip'];
  onChipPress: () => void;
}) {
  const [draft, setDraft] = React.useState(initialText);
  // Survives the OS killing the app (COR-143). ProjectScreen clears it once a
  // send starts a session.
  useComposerDraft(draftKey({ kind: 'project', projectId }), draft, setDraft);
  const draftRef = React.useRef(draft);
  draftRef.current = draft;

  // One submission at a time: two taps inside one frame both read the same
  // draft (the cleared text has not rendered yet), so the second would send
  // it again. Released a frame after the submission settles.
  const submittingRef = React.useRef(false);
  const handleSubmit = React.useCallback(async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      await onSubmit(draftRef.current);
    } finally {
      requestAnimationFrame(() => {
        submittingRef.current = false;
      });
    }
  }, [onSubmit]);

  return (
    <Composer
      {...composer}
      value={draft}
      onChangeText={setDraft}
      onSubmit={handleSubmit}
      placeholder="Ask anything"
    />
  );
}
