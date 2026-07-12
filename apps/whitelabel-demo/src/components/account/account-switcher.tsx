'use client';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { kortix } from '@/lib/kortix';
import type { KortixAccount } from '@kortix/sdk';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

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
      toast.success('Team account created');
      if (account.account_id) onCreated(account.account_id);
    },
    onError: () => toast.error('Could not create the account'),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon" aria-label="New account">
          <Plus className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New team account</DialogTitle>
          <DialogDescription>
            A team account groups projects and members. You can invite teammates after it&apos;s
            created.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="account-name">Account name</Label>
            <Input
              id="account-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Inc."
            />
          </div>
          <DialogFooter className="mt-4">
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending && <Loader2 className="size-4 animate-spin" />}
              Create account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
