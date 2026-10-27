'use client';

import Loading from '@kortix/ui/loading';

import { Button } from '@kortix/ui/button';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTrigger,
} from '@kortix/ui/modal';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kortix/ui/select';
import { kortix } from '@/lib/kortix';
import type { KortixAccount } from '@kortix/sdk';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorToast, successToast } from '@kortix/ui/toast';
import { PlusIcon } from '@phosphor-icons/react';

/**
 * Account switcher — a Select over `accounts.list()` plus a "New account" dialog
 * (`accounts.create`). The parent owns the accounts query + selected id; this is
 * the presentational switcher that reports the chosen account back up.
 */
export function AccountSwitcher({
  accounts,
  value,
  onChange,
  loading,
}: {
  accounts: KortixAccount[];
  value: string | null;
  onChange: (accountId: string) => void;
  loading: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <Select
        value={value ?? undefined}
        onValueChange={onChange}
        disabled={loading || accounts.length === 0}
      >
        <SelectTrigger className="w-[240px]">
          <SelectValue placeholder={loading ? 'Loading accounts…' : 'Select an account'} />
        </SelectTrigger>
        <SelectContent>
          {accounts.map((a) => (
            <SelectItem key={a.account_id} value={a.account_id}>
              <span className="truncate">{a.name ?? a.slug ?? a.account_id}</span>
              {a.is_primary_owner ? (
                <span className="ml-1 text-xs text-muted-foreground">(personal)</span>
              ) : null}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <NewAccountDialog onCreated={onChange} />
    </div>
  );
}

function NewAccountDialog({ onCreated }: { onCreated: (accountId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const qc = useQueryClient();

  const create = useMutation({
    mutationFn: () => kortix.accounts.create({ name: name.trim() }),
    onSuccess: (account) => {
      qc.invalidateQueries({ queryKey: ['accounts'] });
      setOpen(false);
      setName('');
      successToast('Team account created');
      if (account.account_id) onCreated(account.account_id);
    },
    onError: () => errorToast('Could not create the account'),
  });

  return (
    <Modal open={open} onOpenChange={setOpen}>
      <ModalTrigger asChild>
        <Button variant="outline" size="icon" aria-label="New account">
          <PlusIcon className="size-4" />
        </Button>
      </ModalTrigger>
      <ModalContent>
        <ModalHeader>
          <ModalTitle>New team account</ModalTitle>
          <ModalDescription>
            A team account groups projects and members. You can invite teammates after it&apos;s
            created.
          </ModalDescription>
        </ModalHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <ModalBody className="space-y-2">
            <Label htmlFor="account-name">Account name</Label>
            <Input
              id="account-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Inc."
            />
          </ModalBody>
          <ModalFooter>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending && <Loading className="size-4" />}
              Create account
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
