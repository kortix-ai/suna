'use client';

import { useTranslations } from 'next-intl';

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
import { createAccount, type KortixAccount } from '@/lib/projects-client';
import { useMutation } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Icon } from '../icon/icon';

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
      successToast('Account created');
      onCreated?.(account);
      setName('');
      onOpenChange(false);
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to create account'),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return errorToast('Account name is required');
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
              Cancel
            </Button>
            <Button type="submit" className="gap-1.5" disabled={mutation.isPending}>
              {mutation.isPending ? <Loading /> : <Icon.Plus />}
              {tHardcodedUi.raw('componentsAccountsCreateAccountModal.line99JsxTextCreateAccount')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
