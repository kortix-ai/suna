'use client';

import { useTranslations } from '@/i18n/use-translations';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { errorToast, successToast } from '@/components/ui/toast';
import { Plus } from '@/features/icon/icons/plus';
import { createAccount, type KortixAccount } from '@kortix/sdk';
import { useMutation } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';

export function CreateAccountModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (account: KortixAccount) => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [name, setName] = useState('');

  const mutation = useMutation({
    mutationFn: createAccount,
    onSuccess: (account) => {
      successToast(tHardcodedUi.raw('i18nComplete.text6e0267412c1a'));
      onCreated?.(account);
      setName('');
      onOpenChange(false);
    },
    onError: (error: Error) =>
      errorToast(error.message || tHardcodedUi.raw('i18nComplete.textd1890b442952')),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return errorToast(tHardcodedUi.raw('i18nComplete.text75b62a7daa4c'));
    mutation.mutate({ name: trimmed });
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) setName('');
        onOpenChange(next);
      }}
    >
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>
            {tHardcodedUi.raw('componentsAccountsCreateAccountModal.line64JsxTextCreateAnAccount')}
          </ModalTitle>
          <ModalDescription>
            {tHardcodedUi.raw(
              'componentsAccountsCreateAccountModal.line67JsxTextGroupPeopleProjectsAndBillingUnderOneAccount',
            )}
          </ModalDescription>
        </ModalHeader>
        <form onSubmit={handleSubmit}>
          <ModalBody>
            <div className="space-y-1.5">
              <Label htmlFor="create-account-name">
                {tHardcodedUi.raw('componentsAccountsCreateAccountModal.line72JsxTextAccountName')}
              </Label>
              <Input
                id="create-account-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={tHardcodedUi.raw(
                  'componentsAccountsCreateAccountModal.line77JsxAttrPlaceholderAcmeAgi',
                )}
                autoFocus
              />
              <p className="text-muted-foreground text-xs">
                {tHardcodedUi.raw(
                  'componentsAccountsCreateAccountModal.line81JsxTextYouCanInviteMembersAndAddProjectsAfter',
                )}
              </p>
            </div>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline-ghost"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              {tHardcodedUi.raw('i18nComplete.text19766ed6ccb2')}
            </Button>
            <Button type="submit" className="gap-1.5" disabled={mutation.isPending}>
              {mutation.isPending ? <Loading /> : <Plus />}
              {tHardcodedUi.raw('componentsAccountsCreateAccountModal.line99JsxTextCreateAccount')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
