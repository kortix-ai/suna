/**
 * Edit profile — a bottom sheet with the profile photo, the display name
 * field, and Save. The Account page opens it from its profile tile row.
 *
 * `ref.open()` resets the field to the saved name, so a cancelled edit never
 * comes back the next time the sheet opens.
 */

import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { Sheet, SheetBody, SheetHeader, useSheetBackground, type SheetRef } from '@/components/kortix/sheet';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { ProfilePicture } from '@/components/settings/ProfilePicture';
import { useLanguage } from '@/contexts';
import { PROFILE_NAME_MAX_LENGTH } from '@/hooks/useProfileEditor';
import { CameraIcon as Camera } from '@/lib/icons';

export interface EditProfileSheetProps {
  /** The saved display name. */
  name: string;
  saving: boolean;
  /** Resolves `true` when the name saved; the sheet then closes. */
  onSave: (name: string) => Promise<boolean>;
  /** The saved photo URL, empty when there is none. */
  avatarUrl: string;
  /** A photo upload is in flight. */
  uploading: boolean;
  /** Opens the system photo picker and uploads the chosen photo. */
  onChangePhoto: () => void;
}

export const EditProfileSheet = React.forwardRef<SheetRef, EditProfileSheetProps>(
  function EditProfileSheet({ name, saving, onSave, avatarUrl, uploading, onChangePhoto }, ref) {
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
          <ProfilePhoto name={draft || name} avatarUrl={avatarUrl} uploading={uploading} onPress={onChangePhoto} />
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

/**
 * The tappable profile photo at the top of the sheet: an 80pt `ProfilePicture`
 * with a camera badge, tap → the system photo picker (moved from the Account
 * page's old photo header, Jay, 2026-09-23).
 */
function ProfilePhoto({
  name,
  avatarUrl,
  uploading,
  onPress,
}: {
  name: string;
  avatarUrl: string;
  uploading: boolean;
  onPress: () => void;
}) {
  const { t } = useLanguage();
  // The badge's ring matches the sheet surface (`--popover`), not the page's
  // `--background` — the two tokens diverge in dark mode (rule 7, CLAUDE.md
  // Color: map by rendered appearance, not by name).
  const sheetBg = useSheetBackground();
  return (
    <View className="items-center">
      <Pressable
        onPress={onPress}
        disabled={uploading}
        accessibilityRole="button"
        accessibilityLabel={t('profile.changePhoto', 'Change profile photo')}
        hitSlop={8}
        className="active:opacity-80">
        <ProfilePicture imageUrl={avatarUrl} size={20} fallbackText={name} />
        {uploading ? (
          <View className="absolute inset-0 items-center justify-center rounded-full bg-background/60">
            <KortixLoader size="small" />
          </View>
        ) : null}
        {/* The ring in the sheet colour cuts the badge out of the photo edge. */}
        <View
          className="absolute -bottom-0.5 -right-0.5 size-7 items-center justify-center rounded-full border-2 bg-secondary"
          style={{ borderColor: sheetBg }}>
          <Icon as={Camera} size={14} className="text-foreground" />
        </View>
      </Pressable>
    </View>
  );
}
