/**
 * Edit profile — a bottom sheet with the display name field and Save. The
 * Account page opens it from its Edit profile row.
 *
 * `ref.open()` resets the field to the saved name, so a cancelled edit never
 * comes back the next time the sheet opens.
 */

import * as React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { Sheet, SheetBody, SheetHeader, type SheetRef } from '@/components/kortix/sheet';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { useLanguage } from '@/contexts';
import { PROFILE_NAME_MAX_LENGTH } from '@/hooks/useProfileEditor';

export interface EditProfileSheetProps {
  /** The saved display name. */
  name: string;
  saving: boolean;
  /** Resolves `true` when the name saved; the sheet then closes. */
  onSave: (name: string) => Promise<boolean>;
}

export const EditProfileSheet = React.forwardRef<SheetRef, EditProfileSheetProps>(
  function EditProfileSheet({ name, saving, onSave }, ref) {
    const { t } = useLanguage();
    const insets = useSafeAreaInsets();
    const sheetRef = React.useRef<SheetRef>(null);
    const [draft, setDraft] = React.useState(name);

    React.useImperativeHandle(
      ref,
      () => ({
        open: () => {
          setDraft(name);
          sheetRef.current?.open();
        },
        close: () => sheetRef.current?.close(),
      }),
      [name]
    );

    const trimmed = draft.trim();
    const canSave = !saving && trimmed.length > 0 && trimmed !== name.trim();

    const save = async () => {
      if (!canSave) return;
      if (await onSave(trimmed)) sheetRef.current?.close();
    };

    return (
      <Sheet ref={sheetRef} enablePanDownToClose>
        <SheetHeader title={t('nameEdit.title', 'Edit profile')} />
        <SheetBody className="gap-4">
          <SheetTextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={t('nameEdit.yourNamePlaceholder', 'Your name')}
            autoCapitalize="words"
            autoCorrect={false}
            maxLength={PROFILE_NAME_MAX_LENGTH}
            editable={!saving}
            returnKeyType="done"
            onSubmitEditing={save}
            accessibilityLabel={t('nameEdit.displayName', 'Display name')}
          />
          <Button size="lg" className="rounded-full" disabled={!canSave} onPress={save}>
            <Text>{saving ? t('nameEdit.saving', 'Saving…') : t('common.save', 'Save')}</Text>
          </Button>
        </SheetBody>
        <View style={{ height: insets.bottom }} />
      </Sheet>
    );
  }
);
