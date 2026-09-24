/**
 * The prompt of a schedule or a webhook, inside its detail sheet.
 *
 * Never an editable field in the sheet's scroll view (Jay, 2026-09-22): a
 * multiline input there takes the touch, so a scroll that starts on it focuses
 * it, shows the cursor, and raises the keyboard. The detail shows the prompt as
 * read-only text (`PromptPreview`). A tap pushes the editor in from the right
 * (`PromptEditView`, the `sheet-push` motion): the field is focused on purpose,
 * Save sits pinned under it, and Back returns to the detail.
 */
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SheetTextInput } from '@/components/kortix/SheetInput';
import { SheetTitleRow } from '@/components/kortix/sheet';
import { SheetBackButton } from '@/components/kortix/sheet-push';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { haptics } from '@/lib/haptics';
import { CaretRightIcon } from '@/lib/icons';

/** Read-only prompt tile. It scrolls with the sheet and never takes focus. */
export function PromptPreview({ value, onEdit }: { value: string; onEdit: () => void }) {
  return (
    <View className="gap-2">
      <Text variant="muted" className="px-4">
        Prompt
      </Text>
      <Pressable
        onPress={() => {
          haptics.tap();
          onEdit();
        }}
        accessibilityRole="button"
        accessibilityLabel="Edit prompt"
        accessibilityHint="Opens the prompt editor"
        className="flex-row items-center gap-3 overflow-hidden rounded-2xl bg-secondary px-4 py-3 active:bg-accent">
        <Text className="flex-1" numberOfLines={4}>
          {value.trim() || 'No prompt'}
        </Text>
        <Icon as={CaretRightIcon} size={16} className="text-muted-foreground/70" />
      </Pressable>
    </View>
  );
}

/** The pushed editor. `onSave` receives the new text; the caller goes back on success. */
export function PromptEditView({
  value,
  placeholders,
  saving,
  onSave,
  onBack,
}: {
  value: string;
  /** The template variables this trigger type fills, shown under the field. */
  placeholders: string;
  saving: boolean;
  onSave: (next: string) => void;
  onBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = React.useState(value);
  const changed = draft !== value && draft.trim().length > 0;

  return (
    <View className="flex-1">
      <SheetTitleRow
        title="Prompt"
        leading={
          <SheetBackButton
            onPress={() => {
              haptics.tap();
              onBack();
            }}
          />
        }
      />
      <BottomSheetScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 16, gap: 8 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        <SheetTextInput
          value={draft}
          onChangeText={setDraft}
          multiline
          autoFocus
          placeholder="What should the agent do?"
          accessibilityLabel="Prompt"
          style={{
            height: undefined,
            minHeight: 160,
            borderRadius: 16,
            paddingTop: 12,
            paddingBottom: 12,
            textAlignVertical: 'top',
          }}
        />
        <Text variant="muted" className="px-1">
          Placeholders: {placeholders}
        </Text>
      </BottomSheetScrollView>
      <View className="px-4 pt-3" style={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}>
        <Button size="lg" className="rounded-full" disabled={!changed || saving} onPress={() => onSave(draft)}>
          <Text>{saving ? 'Saving…' : 'Save prompt'}</Text>
        </Button>
      </View>
    </View>
  );
}
