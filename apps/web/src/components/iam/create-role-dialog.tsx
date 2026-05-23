'use client';

// Create-role flow. Walks the user through: resource type → key + name +
// description → action picker (grouped + searchable). Validates locally
// against the action catalog so the user sees mistakes before submit.

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Loader2, Search } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
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
import {
  createRole,
  listActions,
  type ActionCatalogEntry,
  type ResourceType,
} from '@/lib/iam-client';

const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
  account: 'Account-level',
  project: 'Project',
  sandbox: 'Sandbox',
  trigger: 'Trigger',
  channel: 'Channel',
  member: 'Member',
  group: 'Group',
};

interface CreateRoleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
}

export function CreateRoleDialog({
  open,
  onOpenChange,
  accountId,
}: CreateRoleDialogProps) {
  const queryClient = useQueryClient();
  const router = useRouter();

  // Form state
  const [resourceType, setResourceType] = useState<ResourceType | ''>('');
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedActions, setSelectedActions] = useState<Set<string>>(new Set());
  const [actionSearch, setActionSearch] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);

  // Reset state on close so the next open is clean.
  useEffect(() => {
    if (!open) {
      setResourceType('');
      setKey('');
      setName('');
      setDescription('');
      setSelectedActions(new Set());
      setActionSearch('');
      setKeyTouched(false);
    }
  }, [open]);

  // Fetch the action catalog once per session — it's static for an account.
  const actionsQuery = useQuery({
    queryKey: ['iam-actions', accountId],
    queryFn: () => listActions(accountId),
    staleTime: 60 * 60_000,
  });

  // Auto-derive key from name on first edit, then leave it alone — typical
  // form pattern. Once the user touches the key field, stop auto-syncing.
  useEffect(() => {
    if (keyTouched) return;
    const derived = name
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64);
    setKey(derived);
  }, [name, keyTouched]);

  const keyError = useMemo(() => {
    if (!key) return null;
    if (!KEY_PATTERN.test(key)) {
      return 'Must start with a letter; lowercase letters, digits, or underscores only.';
    }
    if (key.length > 64) return 'Maximum 64 characters.';
    return null;
  }, [key]);

  // The action picker is filtered to the chosen resource type — Cloudflare
  // semantics: a role for `project` only grants project.* actions. Plus
  // `account` actions are always available to mix in for cross-cutting
  // permissions (read audit, manage members, etc.) on account-scoped roles.
  const availableActions = useMemo(() => {
    if (!resourceType) return [] as ActionCatalogEntry[];
    const all = actionsQuery.data ?? [];
    return all.filter((a) => a.resource_type === resourceType);
  }, [actionsQuery.data, resourceType]);

  const filteredActions = useMemo(() => {
    const q = actionSearch.trim().toLowerCase();
    if (!q) return availableActions;
    return availableActions.filter(
      (a) => a.action.toLowerCase().includes(q) || a.label.toLowerCase().includes(q),
    );
  }, [availableActions, actionSearch]);

  // Prune any previously-selected actions that no longer match the chosen
  // resource type (e.g. user picked actions then changed resource type).
  useEffect(() => {
    if (!resourceType) return;
    const valid = new Set(availableActions.map((a) => a.action));
    setSelectedActions((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const a of prev) {
        if (valid.has(a)) next.add(a);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [availableActions, resourceType]);

  const createMutation = useMutation({
    mutationFn: () =>
      createRole(accountId, {
        key: key.trim(),
        name: name.trim(),
        description: description.trim() || undefined,
        resourceType: resourceType as ResourceType,
        actions: [...selectedActions],
      }),
    onSuccess: (role) => {
      toast.success(`Created role "${role.name}"`);
      queryClient.invalidateQueries({ queryKey: ['iam-roles', accountId] });
      onOpenChange(false);
      router.push(`/accounts/${accountId}/roles/${role.role_id}`);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to create role'),
  });

  const ready =
    !!resourceType &&
    !!name.trim() &&
    !!key &&
    !keyError &&
    selectedActions.size > 0 &&
    !createMutation.isPending;

  function toggleAction(action: string) {
    setSelectedActions((prev) => {
      const next = new Set(prev);
      if (next.has(action)) next.delete(action);
      else next.add(action);
      return next;
    });
  }

  function selectAllVisible() {
    setSelectedActions((prev) => {
      const next = new Set(prev);
      for (const a of filteredActions) next.add(a.action);
      return next;
    });
  }

  function clearAll() {
    setSelectedActions(new Set());
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    createMutation.mutate();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (createMutation.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-4">
          <DialogTitle className="text-lg font-semibold tracking-tight">
            Create a role
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Bundle a set of actions a member or group can perform. The role
            becomes attachable in any policy on this account.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="space-y-5 px-6 py-5">
          {/* Resource type */}
          <div className="space-y-1.5">
            <Label>What kind of resource does this role apply to?</Label>
            <Select
              value={resourceType || undefined}
              onValueChange={(v) => setResourceType(v as ResourceType)}
              disabled={createMutation.isPending}
            >
              <SelectTrigger>
                <SelectValue placeholder="Pick a resource type..." />
              </SelectTrigger>
              <SelectContent>
                {(['account', 'project', 'sandbox', 'trigger', 'channel', 'member', 'group'] as ResourceType[]).map(
                  (rt) => (
                    <SelectItem key={rt} value={rt}>
                      {RESOURCE_TYPE_LABELS[rt]}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Policies attach this role at the matching scope. A Project role
              can only be granted on a project scope; an Account role grants
              account-wide privileges.
            </p>
          </div>

          {/* Name + key */}
          {resourceType && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="role-name">Name</Label>
                <Input
                  id="role-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Project Releaser"
                  maxLength={128}
                  required
                  disabled={createMutation.isPending}
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="role-key">Key</Label>
                <Input
                  id="role-key"
                  value={key}
                  onChange={(e) => {
                    setKey(e.target.value);
                    setKeyTouched(true);
                  }}
                  placeholder="project_releaser"
                  maxLength={64}
                  required
                  disabled={createMutation.isPending}
                  aria-invalid={!!keyError}
                  className={keyError ? 'border-destructive' : undefined}
                />
                {keyError ? (
                  <p className="text-xs text-destructive">{keyError}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Immutable identifier. Auto-derived from name until you edit it.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Description */}
          {resourceType && (
            <div className="space-y-1.5">
              <Label htmlFor="role-description">
                Description{' '}
                <span className="text-xs font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <Input
                id="role-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Can deploy a project but not modify its settings."
                maxLength={256}
                disabled={createMutation.isPending}
              />
            </div>
          )}

          {/* Action picker */}
          {resourceType && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>
                  Actions{' '}
                  <span className="text-xs font-normal text-muted-foreground">
                    ({selectedActions.size} selected)
                  </span>
                </Label>
                <div className="flex gap-2 text-xs">
                  <button
                    type="button"
                    onClick={selectAllVisible}
                    className="cursor-pointer text-muted-foreground hover:text-foreground"
                    disabled={createMutation.isPending}
                  >
                    Select all
                  </button>
                  <span className="text-muted-foreground/40">·</span>
                  <button
                    type="button"
                    onClick={clearAll}
                    className="cursor-pointer text-muted-foreground hover:text-foreground"
                    disabled={createMutation.isPending}
                  >
                    Clear
                  </button>
                </div>
              </div>

              {availableActions.length > 6 && (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={actionSearch}
                    onChange={(e) => setActionSearch(e.target.value)}
                    placeholder="Search actions..."
                    className="h-8 pl-8 text-sm"
                    disabled={createMutation.isPending}
                  />
                </div>
              )}

              {actionsQuery.isLoading && (
                <div className="rounded-2xl border border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
                  Loading action catalog...
                </div>
              )}

              {!actionsQuery.isLoading && availableActions.length === 0 && (
                <p className="rounded-2xl border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
                  No actions registered for this resource type yet.
                </p>
              )}

              {!actionsQuery.isLoading && availableActions.length > 0 && (
                <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-2xl border border-border/60 p-2">
                  {filteredActions.length === 0 ? (
                    <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                      No actions match &ldquo;{actionSearch}&rdquo;.
                    </p>
                  ) : (
                    filteredActions.map((a) => {
                      const checked = selectedActions.has(a.action);
                      return (
                        <button
                          key={a.action}
                          type="button"
                          onClick={() => toggleAction(a.action)}
                          disabled={createMutation.isPending}
                          className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors ${
                            checked ? 'bg-primary/5' : 'hover:bg-muted/40'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            readOnly
                            tabIndex={-1}
                            className="h-3.5 w-3.5 rounded border-border accent-primary"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-foreground">
                              {a.label}
                            </span>
                            <code className="block truncate text-xs font-mono text-muted-foreground">
                              {a.action}
                            </code>
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-6 py-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={createMutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!ready} className="gap-1.5">
              {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Create role
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
