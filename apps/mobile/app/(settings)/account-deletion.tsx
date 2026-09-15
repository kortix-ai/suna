/**
 * Delete account — opened from Account → Advanced → Delete account.
 *
 * Settings-list layout (apps/mobile/design.md):
 * - No deletion scheduled: What gets deleted, When (In 30 days / Immediately),
 *   and one destructive pill.
 * - Deletion scheduled: the date and a Cancel deletion pill.
 *
 * The pill opens ONE AlertDialog with two steps (lib/account-deletion/
 * confirm-flow.ts), for both timings:
 * 1. Type the confirm word (DELETE) → Continue.
 * 2. "Are you sure? Everything will be deleted." → Delete, which arms one
 *    second after the step appears.
 * Taps alone never delete. The steps swap inside one dialog, so two overlays
 * never stack. A failed request stays in step 2, shown in its description.
 */

import * as React from 'react';
import { Keyboard, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import {
  Calendar,
  Clock,
  CreditCard,
  FolderClosed,
  Info,
  KeyRound,
  Zap,
} from 'lucide-react-native';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { SettingsGroup, SettingsPage, SettingsRow } from '@/components/kortix/settings-list';
import { useToast } from '@/components/kortix/toast-provider';
import { useLanguage } from '@/contexts';
import {
  useAccountDeletionStatus,
  useCancelAccountDeletion,
  useDeleteAccountImmediately,
  useRequestAccountDeletion,
} from '@/hooks/useAccountDeletion';
import {
  FINAL_CONFIRM_ARM_DELAY_MS,
  canConfirmDeletion,
  canContinueToFinal,
  type DeleteConfirmStep,
} from '@/lib/account-deletion/confirm-flow';
import { haptics } from '@/lib/haptics';

type DeletionTiming = 'scheduled' | 'immediate';

const formatDate = (value: string | null | undefined) =>
  value
    ? new Date(value).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : '';

export default function AccountDeletionScreen() {
  const { t } = useLanguage();
  const router = useRouter();
  const toast = useToast();
  const { width: windowWidth } = useWindowDimensions();
  const { data: status, isLoading } = useAccountDeletionStatus();
  const requestDeletion = useRequestAccountDeletion();
  const cancelDeletion = useCancelAccountDeletion();
  const deleteImmediately = useDeleteAccountImmediately();

  const [timing, setTiming] = React.useState<DeletionTiming>('scheduled');
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [confirmStep, setConfirmStep] = React.useState<DeleteConfirmStep>('type');
  const [confirmText, setConfirmText] = React.useState('');
  const [finalArmed, setFinalArmed] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  // Blocks a second request from a double tap that lands before `isPending`
  // re-renders the button as disabled.
  const submittingRef = React.useRef(false);

  const immediate = timing === 'immediate';
  const confirmWord = t('accountDeletion.deletePlaceholder', 'DELETE');
  const isDeleting = requestDeletion.isPending || deleteImmediately.isPending;
  const canContinue = canContinueToFinal({ input: confirmText, word: confirmWord, busy: isDeleting });
  const canDelete = canConfirmDeletion({
    step: confirmStep,
    input: confirmText,
    word: confirmWord,
    armed: finalArmed,
    busy: isDeleting,
  });

  // Step 2's Delete button arms a moment after the question appears, so a
  // double tap on Continue cannot also press Delete.
  React.useEffect(() => {
    if (!confirmOpen || confirmStep !== 'final') return;
    setFinalArmed(false);
    const timer = setTimeout(() => setFinalArmed(true), FINAL_CONFIRM_ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, [confirmOpen, confirmStep]);

  const selectTiming = (value: DeletionTiming) => {
    haptics.selection();
    setTiming(value);
  };

  const openConfirm = () => {
    haptics.warning();
    setConfirmStep('type');
    setConfirmText('');
    setFinalArmed(false);
    setFailure(null);
    setConfirmOpen(true);
  };

  const continueToFinal = () => {
    if (!canContinue) return;
    Keyboard.dismiss();
    haptics.warning();
    setFailure(null);
    setConfirmStep('final');
  };

  const confirmDeletion = async () => {
    if (!canDelete || submittingRef.current) return;
    submittingRef.current = true;
    haptics.medium();
    setFailure(null);
    try {
      if (immediate) {
        // The hook signs out and clears every cached query on success.
        await deleteImmediately.mutateAsync();
        haptics.success();
        setConfirmOpen(false);
        router.replace('/');
      } else {
        // The status query updates in place: this screen switches to the
        // scheduled state behind the closing dialog.
        await requestDeletion.mutateAsync('User requested deletion from mobile');
        haptics.success();
        setConfirmOpen(false);
        toast.success(t('accountDeletion.deletionScheduled', 'Deletion scheduled'));
      }
    } catch (error: any) {
      haptics.warning();
      setFailure(
        error?.message || t('accountDeletion.failedToRequest', 'Failed to request account deletion')
      );
    } finally {
      submittingRef.current = false;
    }
  };

  const handleCancelDeletion = async () => {
    haptics.tap();
    try {
      await cancelDeletion.mutateAsync();
      haptics.success();
      toast.success(t('accountDeletion.deletionCancelled', 'Deletion cancelled'));
    } catch (error: any) {
      haptics.warning();
      toast.error(
        error?.message || t('accountDeletion.failedToCancel', 'Failed to cancel account deletion')
      );
    }
  };

  if (isLoading) {
    return (
      <SettingsPage>
        <View className="items-center py-16">
          <KortixLoader />
        </View>
      </SettingsPage>
    );
  }

  if (!status?.supported) {
    return (
      <SettingsPage>
        <SettingsGroup>
          <SettingsRow
            icon={Info}
            label={t('accountDeletion.notAvailableTitle', 'Not available on this server')}
          />
        </SettingsGroup>
      </SettingsPage>
    );
  }

  if (status.has_pending_deletion) {
    return (
      <SettingsPage>
        <SettingsGroup>
          <SettingsRow
            icon={Calendar}
            label={t('accountDeletion.scheduledFor', 'Scheduled for')}
            value={formatDate(status.deletion_scheduled_for)}
          />
        </SettingsGroup>
        <Button
          variant="secondary"
          size="lg"
          className="rounded-full"
          disabled={cancelDeletion.isPending}
          onPress={handleCancelDeletion}>
          <Text>
            {cancelDeletion.isPending
              ? t('accountDeletion.cancelling', 'Cancelling…')
              : t('accountDeletion.cancelDeletion', 'Cancel deletion')}
          </Text>
        </Button>
      </SettingsPage>
    );
  }

  return (
    <>
      <SettingsPage>
        <SettingsGroup title={t('accountDeletion.whatWillBeDeleted', 'What gets deleted')}>
          <SettingsRow
            icon={FolderClosed}
            label={t('accountDeletion.projectsAndSessions', 'Projects and sessions')}
          />
          <SettingsRow
            icon={KeyRound}
            label={t('accountDeletion.credentialsAndConnections', 'Credentials and connections')}
          />
          <SettingsRow
            icon={CreditCard}
            label={t('accountDeletion.subscriptionAndBilling', 'Subscription and billing')}
          />
        </SettingsGroup>

        <SettingsGroup title={t('accountDeletion.when', 'When')}>
          <SettingsRow
            icon={Clock}
            label={t('accountDeletion.in30Days', 'In 30 days')}
            checked={!immediate}
            right={null}
            onPress={() => selectTiming('scheduled')}
          />
          <SettingsRow
            icon={Zap}
            label={t('accountDeletion.immediately', 'Immediately')}
            checked={immediate}
            right={null}
            onPress={() => selectTiming('immediate')}
          />
        </SettingsGroup>

        <Button variant="destructive" size="lg" className="rounded-full" onPress={openConfirm}>
          <Text>{t('accountDeletion.deleteAccount', 'Delete account')}</Text>
        </Button>
      </SettingsPage>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          // Keep the dialog up until an in-flight request settles.
          if (!isDeleting) setConfirmOpen(open);
        }}>
        {/* Explicit width: the confirm field is `w-full`, which collapses to
            its content inside the native overlay wrappers (see AppearanceRow). */}
        <AlertDialogContent className="rounded-3xl" style={{ width: Math.min(windowWidth - 32, 420) }}>
          {confirmStep === 'type' ? (
            <>
              {/* Step 1: type the confirm word. */}
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {immediate
                    ? t('accountDeletion.deleteNowTitle', 'Delete account now?')
                    : t('accountDeletion.deleteTitle', 'Delete account?')}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {immediate
                    ? t(
                        'accountDeletion.deleteNowDescription',
                        'Your account and its data are deleted now. This cannot be undone.'
                      )
                    : t(
                        'accountDeletion.deleteScheduledDescription',
                        'Your account is deleted in 30 days. You can cancel before then.'
                      )}
                </AlertDialogDescription>
              </AlertDialogHeader>

              <Input
                value={confirmText}
                onChangeText={setConfirmText}
                placeholder={t('accountDeletion.typeDeleteToConfirm', {
                  text: confirmWord,
                  defaultValue: 'Type {{text}} to confirm',
                })}
                accessibilityLabel={t('accountDeletion.typeDeleteToConfirm', {
                  text: confirmWord,
                  defaultValue: 'Type {{text}} to confirm',
                })}
                autoFocus
                autoCapitalize="characters"
                autoCorrect={false}
                autoComplete="off"
                spellCheck={false}
                returnKeyType="next"
                onSubmitEditing={continueToFinal}
              />

              <AlertDialogFooter>
                <AlertDialogCancel asChild>
                  <Button variant="secondary" size="lg" className="rounded-full">
                    <Text>{t('common.cancel', 'Cancel')}</Text>
                  </Button>
                </AlertDialogCancel>
                <Button
                  variant="destructive"
                  size="lg"
                  className="rounded-full"
                  disabled={!canContinue}
                  onPress={continueToFinal}>
                  <Text>{t('common.continue', 'Continue')}</Text>
                </Button>
              </AlertDialogFooter>
            </>
          ) : (
            <>
              {/* Step 2: the second, separate question. */}
              <AlertDialogHeader>
                <AlertDialogTitle>{t('accountDeletion.finalTitle', 'Are you sure?')}</AlertDialogTitle>
                <AlertDialogDescription className={failure ? 'text-destructive' : undefined}>
                  {failure ??
                    (immediate
                      ? t(
                          'accountDeletion.finalDescriptionNow',
                          'Everything in your account is deleted now: projects, sessions, credentials, and billing. This cannot be undone.'
                        )
                      : t(
                          'accountDeletion.finalDescriptionScheduled',
                          'Everything in your account is deleted in 30 days: projects, sessions, credentials, and billing. You can cancel before then.'
                        ))}
                </AlertDialogDescription>
              </AlertDialogHeader>

              <AlertDialogFooter>
                <AlertDialogCancel asChild disabled={isDeleting}>
                  <Button variant="secondary" size="lg" className="rounded-full">
                    <Text>{t('common.cancel', 'Cancel')}</Text>
                  </Button>
                </AlertDialogCancel>
                <Button
                  variant="destructive"
                  size="lg"
                  className="rounded-full"
                  disabled={!canDelete}
                  onPress={confirmDeletion}>
                  <Text>
                    {isDeleting
                      ? t('accountDeletion.deleting', 'Deleting…')
                      : immediate
                        ? t('accountDeletion.deleteNow', 'Delete now')
                        : t('accountDeletion.deleteAccount', 'Delete account')}
                  </Text>
                </Button>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
