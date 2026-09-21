/**
 * ProjectHome — the project screen when no chat is open (COR-34).
 *
 * The Kortix symbol sits dead centre, alone (Jay, 2026-09-21: no sentence, no
 * project name), and the chat input is pinned to the bottom. Nothing else: no
 * starter chips, cards, or lists. The floating header (hamburger · agent pill ·
 * `···`, which opens the project sheet) is the project screen's chrome, shared
 * with the thread, not part of this content.
 *
 * The chat input is one card: text on top, then add files · model · send.
 * Files cannot upload yet (the session's sandbox does not exist), so they ride
 * along in the submit and ProjectScreen uploads them after the session
 * connects. The model comes from the project catalog and is sent as
 * `opencode_model`.
 *
 * Layout:
 * - The symbol (`ProjectHero`) is absolutely centred in the keyboard-avoiding
 *   area. At rest that area is the whole screen; while typing it is the part
 *   above the keyboard, so the symbol never sits under the composer. It is
 *   large at rest and scales down with the keyboard.
 * - At rest the composer sits at the thread composer's distance from the
 *   bottom (SessionPage pads `insets.bottom`, SessionChatInput adds `pb-3`).
 * - The composer follows the keyboard down to KEYBOARD_GAP above it once it appears.
 */

import * as React from 'react';
import { Keyboard, Pressable, View } from 'react-native';
import {
  KeyboardAvoidingView,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import Reanimated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Composer } from '@/components/kortix/composer';
import type { SheetRef } from '@/components/kortix/sheet';
import { AgentPill } from '@/components/session/AgentPill';
import { ProjectHeaderActions } from '@/components/session/ProjectHeaderActions';
import { FloatingMenuButton } from '@/components/session/FloatingMenuButton';
import { ModelPickerSheet } from '@/components/session/ModelPickerSheet';
import { ProjectHero } from '@/components/session/ProjectHero';
import { AttachSheet, type AttachSheetRef } from '@/components/session/AttachSheet';
import { useProjectDetail, useProjectModelCatalog } from '@/lib/projects/hooks';
import type { AttachedFile } from '@/lib/session/attachments';
import {
  composerModelLabel,
  effectiveComposerModel,
  selectComposerModel,
} from '@/lib/session/composer-model';
import { useLocalConfigStore } from '@/lib/opencode/hooks/use-local-config';
import {
  composerPillLabel,
  homeAgentName,
  pickableAgents,
  type PickerOption,
} from '@/lib/session/composer-config';
import { openProjectModelsOnWeb } from '@/lib/session/connect-model';
import { catalogPickerModels, firstPromptPicks, modelPickerOptions } from '@/lib/session/model-picker';

/** One identity while the project detail loads, so the agent memo does not churn. */
const EMPTY_AGENTS: NonNullable<ReturnType<typeof useProjectDetail>['data']>['config']['agents'] = [];

/** The thread composer's own bottom padding (SessionChatInput's `pb-3`), so
 *  this composer rests at the same distance from the safe-area bottom. `pb-3`
 *  under the `px-4` edge: vertical is one step below horizontal (design.md §2). */
const COMPOSER_BOTTOM_GAP = 12;
/** Composer to keyboard while the keyboard is up. The same 12pt as the thread. */
const KEYBOARD_GAP = 12;

export interface ProjectHomeSubmit {
  text: string;
  files: AttachedFile[];
  /** Gateway wire id, or null to use the project default. */
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
  /** Parent handles the create+connect flow for a brand-new session. */
  onSubmitNewSession: (input: ProjectHomeSubmit) => void;
  onOpenDrawer: () => void;
  /** Opens the project sheet (agents, skills, schedules, review, models, secrets). */
  onOpenMore: () => void;
}

export function ProjectHome({
  projectId,
  sending = false,
  onSubmitNewSession,
  onOpenDrawer,
  onOpenMore,
}: ProjectHomeProps) {
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = React.useState('');
  const [files, setFiles] = React.useState<AttachedFile[]>([]);
  const [model, setModel] = React.useState<string | null>(null);
  const modelSheetRef = React.useRef<SheetRef>(null);
  const attachSheetRef = React.useRef<AttachSheetRef>(null);

  // The same catalog, groups, and order as web and the thread
  // (`lib/session/model-picker.ts`).
  const { catalog, defaultModel, isLoading: catalogLoading } = useProjectModelCatalog(projectId);
  const catalogModels = React.useMemo(() => catalogPickerModels(catalog), [catalog]);
  const modelOptions = React.useMemo<PickerOption[]>(
    () => modelPickerOptions(catalogModels, (m) => m.modelID),
    [catalogModels],
  );
  // Thinking: the active model's levels, from the catalog. The level lives in
  // the store the thread reads (`modelVariants["kortix/<modelID>"]`), so a
  // level set here is the thread's level, and the other way round.
  const activeModel = effectiveComposerModel(model, defaultModel);
  const levels = React.useMemo(
    () => Object.keys(catalogModels.find((m) => m.modelID === activeModel)?.variants ?? {}),
    [catalogModels, activeModel],
  );
  const variantKey = activeModel ? `kortix/${activeModel}` : '';
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
  // A gateway project that offers no model: the pill asks to connect one. A
  // project without the gateway has no catalog, so the pill stays hidden.
  const noModelConnected = !catalogLoading && catalog !== undefined && modelOptions.length === 0;
  const modelLabel = noModelConnected
    ? 'Connect model'
    : composerModelLabel(
        modelOptions.map((o) => ({ modelID: o.key, modelName: o.label })),
        model,
        defaultModel,
      );
  // The thread's pill text: "{model} · {level}".
  const pillLabel = modelLabel && variant ? composerPillLabel(modelLabel, variant) : modelLabel;

  // Agent: home has no sandbox, so the choices are the project config's agents
  // (`/detail`). Web's order: the pick made here, else the project default,
  // else the last agent picked anywhere (`homeAgentName`). A pick also becomes
  // the store's last-used agent, which the thread's header reads.
  const { data: projectDetail } = useProjectDetail(projectId);
  const projectAgents = projectDetail?.config?.agents ?? EMPTY_AGENTS;
  const [pickedAgent, setPickedAgent] = React.useState<string | null>(null);
  const lastUsedAgent = useLocalConfigStore((s) => s.selectedAgent);
  const setLastUsedAgent = useLocalConfigStore((s) => s.setAgent);
  const agentName = React.useMemo(
    () =>
      homeAgentName(
        pickableAgents(projectAgents).map((a) => a.name),
        {
          picked: pickedAgent,
          projectDefault: projectDetail?.config?.default_agent ?? projectDetail?.config?.open_code_default_agent,
          lastUsed: lastUsedAgent,
        },
      ),
    [projectAgents, pickedAgent, projectDetail, lastUsedAgent],
  );
  const handleAgentChange = React.useCallback(
    (name: string) => {
      setPickedAgent(name);
      setLastUsedAgent(name);
    },
    [setLastUsedAgent],
  );

  const addFiles = React.useCallback((picked: AttachedFile[]) => {
    setFiles((prev) => [...prev, ...picked]);
  }, []);

  const restingGap = insets.bottom + COMPOSER_BOTTOM_GAP;
  const { progress } = useReanimatedKeyboardAnimation();
  const composerStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: progress.value * (restingGap - KEYBOARD_GAP) }],
  }));

  // Nothing is cleared on send. A successful send pushes the connecting state
  // over this screen, and the project stack remounts this screen once it is
  // covered (ProjectRoutes `homeKey`). A failed or gated send (credits,
  // network) leaves the prompt and files in place. Web does the same
  // (`clearOnSend={false}` on the home composer).
  const handleSubmit = React.useCallback(() => {
    const text = draft.trim();
    if ((!text && files.length === 0) || sending) return;
    // The thread's header reads the store: it then shows the agent this session runs on.
    if (agentName) setLastUsedAgent(agentName);
    onSubmitNewSession({
      text,
      files,
      model,
      picks: firstPromptPicks(activeModel, variant, levels),
      agent: agentName,
    });
  }, [draft, files, model, activeModel, variant, levels, agentName, setLastUsedAgent, sending, onSubmitNewSession]);

  return (
    <View className="flex-1 bg-background">
      {/* Floating menu button — opens the left drawer. */}
      <FloatingMenuButton onPress={onOpenDrawer}>
        {/* The agent, then the `···` button that opens the project sheet. */}
        <ProjectHeaderActions onOpenMore={onOpenMore}>
          <AgentPill agents={projectAgents} activeName={agentName} onChange={handleAgentChange} edge={false} />
        </ProjectHeaderActions>
      </FloatingMenuButton>

      <KeyboardAvoidingView className="flex-1" behavior="padding">
        <View className="flex-1">
          {/* Tap outside the field to close the keyboard. Not a control. */}
          <Pressable className="flex-1" onPress={Keyboard.dismiss} accessible={false} />

          <View
            pointerEvents="none"
            className="absolute inset-0 items-center justify-center">
            <ProjectHero />
          </View>

          <Reanimated.View className="px-4" style={[{ paddingBottom: restingGap }, composerStyle]}>
            <Composer
              value={draft}
              onChangeText={setDraft}
              onSubmit={handleSubmit}
              placeholder="Ask anything"
              disabled={sending}
              attachments={files}
              onAttach={() => {
                Keyboard.dismiss();
                attachSheetRef.current?.open();
              }}
              onRemoveAttachment={(index) =>
                setFiles((prev) => prev.filter((_, i) => i !== index))
              }
              modelLabel={pillLabel}
              onModelPress={() => {
                Keyboard.dismiss();
                modelSheetRef.current?.open();
              }}
            />
          </Reanimated.View>
        </View>
      </KeyboardAvoidingView>

      <AttachSheet ref={attachSheetRef} onPick={addFiles} />

      <ModelPickerSheet
        ref={modelSheetRef}
        options={modelOptions}
        activeKey={activeModel}
        thinking={thinking}
        onSelect={(modelID) => setModel(selectComposerModel(modelID, defaultModel))}
        onConnect={() => openProjectModelsOnWeb(projectId)}
      />
    </View>
  );
}
