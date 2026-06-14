'use client';

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { Label } from '@/components/ui/label';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  useAccountDeletionStatus,
  useCancelAccountDeletion,
  useDeleteAccountImmediately,
  useRequestAccountDeletion,
} from '@/hooks/account/use-account-deletion';
import { isBillingEnabled } from '@/lib/config';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import { DangerTriangleSolid } from '@mynaui/icons-react';
import { Clock } from 'lucide-react';
import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { LanguageSwitcher } from './language-switcher';

export function GeneralTab({ onClose }: { onClose: () => void }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const t = useTranslations('settings.general');
  const tCommon = useTranslations('common');
  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deletionType, setDeletionType] = useState<'grace-period' | 'immediate'>('grace-period');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const supabase = createClient();
  const { data: deletionStatus, isLoading: isCheckingStatus } = useAccountDeletionStatus();
  const requestDeletion = useRequestAccountDeletion();
  const cancelDeletion = useCancelAccountDeletion();
  const deleteImmediately = useDeleteAccountImmediately();
  const accountDeletionSupported = deletionStatus?.supported ?? !isCheckingStatus;

  useEffect(() => {
    const fetchUserData = async () => {
      setIsLoading(true);
      const { data } = await supabase.auth.getUser();
      if (data.user) {
        setUserName(data.user.user_metadata?.name || data.user.email?.split('@')[0] || '');
        setUserEmail(data.user.email || '');
        setAvatarUrl(data.user.user_metadata?.avatar_url || '');
      }
      setIsLoading(false);
    };

    fetchUserData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getInitials = (name: string) => {
    return (
      name
        .split(' ')
        .map((part) => part[0])
        .join('')
        .toUpperCase()
        .slice(0, 2) || 'U'
    );
  };

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (!file.type.startsWith('image/')) {
        errorToast(t('profilePicture.invalidType'));
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        errorToast(t('profilePicture.tooLarge'));
        return;
      }
      setAvatarFile(file);
      const previewUrl = URL.createObjectURL(file);
      setAvatarPreview(previewUrl);
    }
  };

  const uploadAvatar = async (userId: string): Promise<string> => {
    if (!avatarFile) return avatarUrl;

    setIsUploadingAvatar(true);
    try {
      const fileExt = (avatarFile.name.split('.').pop() || 'png').toLowerCase();
      const filePath = `${userId}/${Date.now()}.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(filePath, avatarFile, {
          cacheControl: '3600',
          upsert: true,
        });

      if (uploadError) throw uploadError;

      const {
        data: { publicUrl },
      } = supabase.storage.from('avatars').getPublicUrl(filePath);

      return publicUrl;
    } finally {
      setIsUploadingAvatar(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData.user?.id;

      if (!userId) throw new Error('User not found');

      const newAvatarUrl = avatarFile ? await uploadAvatar(userId) : avatarUrl;

      const { error } = await supabase.auth.updateUser({
        data: {
          name: userName,
          avatar_url: newAvatarUrl,
        },
      });

      if (error) throw error;

      if (avatarPreview) {
        URL.revokeObjectURL(avatarPreview);
        setAvatarPreview(null);
      }
      setAvatarFile(null);
      setAvatarUrl(newAvatarUrl);

      successToast(t('profileUpdated'));
    } catch (error) {
      console.error('Error updating profile:', error);
      const message = error instanceof Error && error.message ? error.message : '';
      errorToast(message || t('profileUpdateFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleRequestDeletion = async () => {
    try {
      if (deletionType === 'immediate') {
        await deleteImmediately.mutateAsync();
      } else {
        await requestDeletion.mutateAsync('User requested deletion');
      }
      setShowDeleteDialog(false);
      setDeleteConfirmText('');
      setDeletionType('grace-period');
    } catch {
      // Mutation onError already shows the user-facing message.
    }
  };

  const handleCancelDeletion = async () => {
    try {
      await cancelDeletion.mutateAsync();
      setShowCancelDialog(false);
    } catch {
      // Mutation onError already shows the user-facing message.
    }
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return '';
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  const openFilePicker = () => fileInputRef.current?.click();

  if (isLoading) {
    return (
      <div className="max-w-lg space-y-6 px-6 py-5">
        <div className="flex items-center gap-4">
          <Skeleton className="size-14 rounded-full" />
          <Skeleton className="h-8 w-28 rounded-full" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-16 w-full rounded-2xl" />
          <Skeleton className="h-16 w-full rounded-2xl" />
          <Skeleton className="h-16 w-full rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="w-full space-y-6 px-6 py-5">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={openFilePicker}
            disabled={isUploadingAvatar}
            className="group focus-visible:ring-ring relative shrink-0 cursor-pointer overflow-hidden rounded-md focus-visible:ring-2 focus-visible:outline-none"
            aria-label={t('profilePicture.upload')}
          >
            <Avatar className="border-border size-14 border">
              <AvatarImage src={avatarPreview || avatarUrl} alt={userName} />
              <AvatarFallback className="bg-muted text-sm font-medium">
                {getInitials(userName)}
              </AvatarFallback>
            </Avatar>
            {isUploadingAvatar ? (
              <span className="bg-foreground/20 absolute inset-0 flex items-center justify-center">
                <KortixLoader size="small" variant="white" />
              </span>
            ) : (
              <span
                className={cn(
                  'bg-foreground/20 duration-normal absolute inset-0 opacity-0 transition-opacity ease-out',
                  'group-hover:opacity-100 group-focus-visible:opacity-100',
                )}
                aria-hidden
              />
            )}
          </button>
          <div className="min-w-0 space-y-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={openFilePicker}
              disabled={isUploadingAvatar}
              className="text-foreground h-auto px-0 hover:bg-transparent"
            >
              {t('profilePicture.upload')}
            </Button>
            <p className="text-muted-foreground text-xs">{t('profilePicture.hint')}</p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept={tHardcodedUi.raw(
              'componentsSettingsUserSettingsModal.line596JsxAttrAcceptImage',
            )}
            onChange={handleAvatarChange}
            className="hidden"
          />
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">{t('name')}</Label>
            <Input
              type="text"
              id="name"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder={t('namePlaceholder')}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">{t('email')}</Label>
            <Input type="text" id="email" value={userEmail} disabled />
            <p className="text-muted-foreground text-xs">{t('emailCannotChange')}</p>
          </div>

          <LanguageSwitcher />
        </div>

        {isBillingEnabled() && accountDeletionSupported ? (
          <div className="space-y-2">
            <h2 className="text-foreground text-base font-semibold">{t('deleteAccount.title')}</h2>
            {deletionStatus?.has_pending_deletion ? (
              <Item variant="outline" className="border-destructive/25 items-start">
                <ItemMedia variant="icon">
                  <Clock />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{t('deleteAccount.scheduled')}</ItemTitle>
                  <ItemDescription className="font-medium">
                    {t('deleteAccount.scheduledDescription', {
                      date: formatDate(deletionStatus.deletion_scheduled_for),
                    })}{' '}
                    {t('deleteAccount.canCancel')}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowCancelDialog(true)}
                    disabled={cancelDeletion.isPending}
                  >
                    {t('deleteAccount.cancelButton')}
                  </Button>
                </ItemActions>
              </Item>
            ) : (
              <Item variant="outline" className="border-destructive/25 items-start">
                <ItemContent>
                  <ItemDescription>{t('deleteAccount.description')}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button variant="outline" size="sm" onClick={() => setShowDeleteDialog(true)}>
                    {t('deleteAccount.button')}
                  </Button>
                </ItemActions>
              </Item>
            )}
          </div>
        ) : null}
      </div>

      <div className="mt-auto flex flex-col-reverse gap-2 px-6 py-4 sm:flex-row sm:justify-end">
        <Button variant="outline-ghost" onClick={onClose} className="w-full sm:w-auto">
          {tCommon('cancel')}
        </Button>
        <Button onClick={handleSave} disabled={isSaving} className="w-full sm:w-auto">
          {isSaving ? tCommon('saving') : t('saveChanges')}
        </Button>
      </div>

      {isBillingEnabled() && accountDeletionSupported && (
        <>
          <Modal
            open={showDeleteDialog}
            onOpenChange={(open) => {
              setShowDeleteDialog(open);
              if (!open) {
                setDeleteConfirmText('');
                setDeletionType('grace-period');
              }
            }}
          >
            <ModalContent className="lg:max-w-md" variant="base">
              <ModalHeader>
                <ModalTitle>{t('deleteAccount.dialogTitle')}</ModalTitle>
              </ModalHeader>
              <ModalBody className="overflow-hidden">
                <MotionConfig transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}>
                  <motion.div layout className="space-y-4">
                    <motion.div layout>
                      <InfoBanner tone="warning" icon={DangerTriangleSolid}>
                        {deletionType === 'immediate'
                          ? t('deleteAccount.warningImmediate')
                          : t('deleteAccount.warningGracePeriod')}
                      </InfoBanner>
                    </motion.div>

                    <motion.div layout className="space-y-2">
                      <p className="text-sm font-medium">{t('deleteAccount.whenDelete')}</p>
                      <ul className="text-muted-foreground list-disc space-y-1.5 pl-4 text-xs sm:pl-5 sm:text-sm">
                        <li>{t('deleteAccount.agentsDeleted')}</li>
                        <li>{t('deleteAccount.threadsDeleted')}</li>
                        <li>{t('deleteAccount.credentialsRemoved')}</li>
                        <li>{t('deleteAccount.subscriptionCancelled')}</li>
                        <li>{t('deleteAccount.billingRemoved')}</li>
                        <AnimatePresence initial={false}>
                          {deletionType === 'grace-period' && (
                            <motion.li
                              key="scheduled-30-days"
                              className="list-item"
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: 'auto' }}
                              exit={{ opacity: 0, height: 0 }}
                            >
                              {t('deleteAccount.scheduled30Days')}
                            </motion.li>
                          )}
                        </AnimatePresence>
                      </ul>
                    </motion.div>

                    <motion.div layout className="space-y-3">
                      <Label className="text-sm">{t('deleteAccount.chooseDeletionType')}</Label>
                      <RadioGroup
                        value={deletionType}
                        onValueChange={(value) =>
                          setDeletionType(value as 'grace-period' | 'immediate')
                        }
                      >
                        <RadioGroupItem
                          value="grace-period"
                          id="grace-period"
                          label={t('deleteAccount.gracePeriodOption')}
                          description={t('deleteAccount.gracePeriodDescription')}
                          size="lg"
                          variant="outline"
                        />

                        <RadioGroupItem
                          value="immediate"
                          id="immediate"
                          label={t('deleteAccount.immediateOption')}
                          description={t('deleteAccount.immediateDescription')}
                          size="lg"
                          variant="outline"
                        />
                      </RadioGroup>
                    </motion.div>

                    <motion.div layout className="space-y-2">
                      <Label htmlFor="delete-confirm" className="text-sm">
                        {t('deleteAccount.confirmText')}
                      </Label>
                      <Input
                        type="text"
                        id="delete-confirm"
                        value={deleteConfirmText}
                        onChange={(e) => setDeleteConfirmText(e.target.value)}
                        placeholder={t('deleteAccount.confirmPlaceholder')}
                        autoComplete="off"
                      />
                    </motion.div>
                  </motion.div>
                </MotionConfig>
              </ModalBody>
              <ModalFooter className="w-full sm:justify-between">
                <Button
                  variant="outline-ghost"
                  onClick={() => {
                    setShowDeleteDialog(false);
                    setDeleteConfirmText('');
                    setDeletionType('grace-period');
                  }}
                  className="w-full sm:w-auto"
                >
                  {t('deleteAccount.keepAccount')}
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleRequestDeletion}
                  disabled={
                    requestDeletion.isPending ||
                    deleteImmediately.isPending ||
                    deleteConfirmText !== 'delete'
                  }
                  className="w-full sm:w-auto"
                >
                  {requestDeletion.isPending || deleteImmediately.isPending
                    ? tCommon('processing')
                    : t('deleteAccount.button')}
                </Button>
              </ModalFooter>
            </ModalContent>
          </Modal>

          <AlertDialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('deleteAccount.cancelDeletionTitle')}</AlertDialogTitle>
                <AlertDialogDescription className="text-muted-foreground text-xs sm:text-sm">
                  {t('deleteAccount.cancelDeletionDescription')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <Button
                  variant="outline-ghost"
                  onClick={() => setShowCancelDialog(false)}
                  className="w-full sm:w-auto"
                >
                  {tCommon('back')}
                </Button>
                <Button
                  onClick={handleCancelDeletion}
                  disabled={cancelDeletion.isPending}
                  className="w-full sm:w-auto"
                >
                  {cancelDeletion.isPending
                    ? tCommon('processing')
                    : t('deleteAccount.cancelDeletion')}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  );
}
