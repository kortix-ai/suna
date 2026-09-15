/**
 * ProjectHome — the project screen when no chat is open (COR-34).
 *
 * Web parity with `ProjectHomeWelcomeBody`: the Kortix symbol and one fixed
 * sentence ("Give {project} something real to work on.") sit dead centre, and
 * the chat input is pinned to the bottom. Nothing else: no starter chips,
 * cards, or lists. The floating menu button and the dock are the project
 * screen's chrome, shared with the thread, not part of this content.
 *
 * The chat input is one card: text on top, then add files · model · send.
 * Files cannot upload yet (the session's sandbox does not exist), so they ride
 * along in the submit and ProjectScreen uploads them after the session
 * connects. The model comes from the project catalog and is sent as
 * `opencode_model`.
 *
 * Layout:
 * - The greeting is absolutely centred in the keyboard-avoiding area. At rest
 *   that area is the whole screen; while typing it is the part above the
 *   keyboard, so the greeting never sits under the composer.
 * - At rest the composer sits above the dock, at the thread composer's
 *   distance from the bottom (SessionPage pads `insets.bottom + 64`,
 *   SessionChatInput adds `pb-2`).
 * - The dock slides away with the keyboard, so the composer follows the
 *   keyboard down to KEYBOARD_GAP above it.
 */

import * as React from 'react';
import { Keyboard, Pressable, View } from 'react-native';
import {
  KeyboardAvoidingView,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import Reanimated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Menu } from 'lucide-react-native';

import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { Composer } from '@/components/kortix/composer';
import type { SheetRef } from '@/components/kortix/sheet';
import { ModelPickerSheet } from '@/components/session/ModelPickerSheet';
import { ProjectGreeting } from '@/components/session/ProjectGreeting';
import { useAttachmentPicker } from '@/components/session/useAttachmentPicker';
import { useProjectModelCatalog } from '@/lib/projects/hooks';
import type { AttachedFile } from '@/lib/session/attachments';
import {
  composerModelLabel,
  effectiveComposerModel,
  selectComposerModel,
} from '@/lib/session/composer-model';

/** The thread composer's distance from the safe-area bottom: 64 + pb-2. */
const DOCK_SLOT = 72;
/** Composer to keyboard while the keyboard is up. */
const KEYBOARD_GAP = 8;

export interface ProjectHomeSubmit {
  text: string;
  files: AttachedFile[];
  /** Gateway wire id, or null to use the project default. */
  model: string | null;
}

export interface ProjectHomeProps {
  projectId: string;
  /** Undefined while the project loads; the greeting says "it" until then. */
  projectName?: string;
  /** A send is in flight: the composer keeps its content and locks. */
  sending?: boolean;
  /** Parent handles the create+connect flow for a brand-new session. */
  onSubmitNewSession: (input: ProjectHomeSubmit) => void;
  onOpenDrawer: () => void;
}

export function ProjectHome({
  projectId,
  projectName,
  sending = false,
  onSubmitNewSession,
  onOpenDrawer,
}: ProjectHomeProps) {
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = React.useState('');
  const [files, setFiles] = React.useState<AttachedFile[]>([]);
  const [model, setModel] = React.useState<string | null>(null);
  const modelSheetRef = React.useRef<SheetRef>(null);

  const { models, defaultModel } = useProjectModelCatalog(projectId);

  const addFiles = React.useCallback((picked: AttachedFile[]) => {
    setFiles((prev) => [...prev, ...picked]);
  }, []);
  const pickFiles = useAttachmentPicker(addFiles);

  const restingGap = insets.bottom + DOCK_SLOT;
  const { progress } = useReanimatedKeyboardAnimation();
  const composerStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: progress.value * (restingGap - KEYBOARD_GAP) }],
  }));

  // Nothing is cleared on send. A successful send swaps this screen for the
  // connecting state, which unmounts it. A failed or gated send (credits,
  // network) leaves the prompt and files in place. Web does the same
  // (`clearOnSend={false}` on the home composer).
  const handleSubmit = React.useCallback(() => {
    const text = draft.trim();
    if ((!text && files.length === 0) || sending) return;
    onSubmitNewSession({ text, files, model });
  }, [draft, files, model, sending, onSubmitNewSession]);

  return (
    <View className="flex-1 bg-background">
      {/* Floating menu button — opens the left drawer. */}
      <View
        className="absolute left-4 z-10"
        style={{ top: insets.top + 8 }}
        pointerEvents="box-none">
        <Button
          variant="secondary"
          size="icon"
          onPress={onOpenDrawer}
          accessibilityLabel="Open menu"
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Icon as={Menu} size={20} className="text-foreground" />
        </Button>
      </View>

      <KeyboardAvoidingView className="flex-1" behavior="padding">
        <View className="flex-1">
          {/* Tap outside the field to close the keyboard. Not a control. */}
          <Pressable className="flex-1" onPress={Keyboard.dismiss} accessible={false} />

          <View
            pointerEvents="none"
            className="absolute inset-0 items-center justify-center px-8">
            <ProjectGreeting projectName={projectName} />
          </View>

          <Reanimated.View className="px-3" style={[{ paddingBottom: restingGap }, composerStyle]}>
            <Composer
              value={draft}
              onChangeText={setDraft}
              onSubmit={handleSubmit}
              placeholder="Ask anything"
              disabled={sending}
              attachments={files}
              onAttach={() => {
                Keyboard.dismiss();
                pickFiles();
              }}
              onRemoveAttachment={(index) =>
                setFiles((prev) => prev.filter((_, i) => i !== index))
              }
              modelLabel={composerModelLabel(models, model, defaultModel)}
              onModelPress={() => {
                Keyboard.dismiss();
                modelSheetRef.current?.open();
              }}
            />
          </Reanimated.View>
        </View>
      </KeyboardAvoidingView>

      <ModelPickerSheet
        ref={modelSheetRef}
        models={models}
        activeModel={effectiveComposerModel(model, defaultModel)}
        onSelect={(modelID) => setModel(selectComposerModel(modelID, defaultModel))}
      />
    </View>
  );
}
