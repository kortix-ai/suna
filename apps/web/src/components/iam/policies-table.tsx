'use client';

// Permission policies table — used by both the group-detail and the
// member-detail pages. The shape mirrors Cloudflare's policy editor:
// Scope · Applies to · Roles, with a Create policy modal that walks
// scope → applies to → roles.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  Download,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { SectionCard } from '@/components/ui/section-card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  type AccountGroup,
  type BulkImportEntry,
  type IamPolicy,
  type IamRole,
  type PolicyConditions,
  type PolicyEffect,
  type PolicyScopeType,
  type PolicyTemplate,
  type PrincipalType,
  type ProjectGroup,
  type ResourceType,
  applyPolicyTemplate,
  bulkImportPolicies,
  createPolicy,
  deletePolicy,
  listGroups,
  listPolicies,
  listPolicyTemplates,
  listProjectGroups,
  listRoles,
  updatePolicy,
} from '@/lib/iam-client';
import {
  listAccountMembers,
  listProjectsForAccount,
  type AccountMember,
  type KortixProject,
} from '@/lib/projects-client';

// ─── Resource-type metadata (UI labels + which pickers are wired) ─────────

const RESOURCE_TYPE_META: Record<
  PolicyScopeType,
  { label: string; inputKind: 'select' | 'text' }
> = {
  account: { label: 'Everything', inputKind: 'select' },
  project: { label: 'Individual Projects', inputKind: 'select' },
  project_group: { label: 'Project Groups', inputKind: 'select' },
  member: { label: 'Individual Members', inputKind: 'select' },
  group: { label: 'Individual Groups', inputKind: 'select' },
  // Sub-resources without dedicated pickers — admins paste the
  // sandbox/trigger/channel id directly. Acceptable for v1; a richer
  // picker can land once these surfaces stabilise.
  sandbox: { label: 'Individual Sandboxes', inputKind: 'text' },
  trigger: { label: 'Individual Triggers', inputKind: 'text' },
  channel: { label: 'Individual Channels', inputKind: 'text' },
};

// ─── PoliciesTable ─────────────────────────────────────────────────────────

interface PoliciesTableProps {
  accountId: string;
  principalType: PrincipalType;
  principalId: string;
  principalLabel: string;
  canManage: boolean;
}

export function PoliciesTable({
  accountId,
  principalType,
  principalId,
  principalLabel,
  canManage,
}: PoliciesTableProps) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  // Non-null = the dialog is open in "edit" mode for that policy. Mutually
  // exclusive with createOpen — opening one closes the other.
  const [editTarget, setEditTarget] = useState<IamPolicy | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IamPolicy | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const queryKey = ['iam-policies', accountId, principalType, principalId];

  const policiesQuery = useQuery({
    queryKey,
    queryFn: () => listPolicies(accountId, { principalType, principalId }),
    staleTime: 20_000,
  });

  const rolesQuery = useQuery({
    queryKey: ['iam-roles', accountId],
    queryFn: () => listRoles(accountId),
    staleTime: 5 * 60_000,
  });

  const projectsQuery = useQuery({
    queryKey: ['projects-for-account', accountId],
    queryFn: () => listProjectsForAccount(accountId),
    staleTime: 30_000,
  });

  const accountMembersQuery = useQuery({
    queryKey: ['account-members', accountId],
    queryFn: () => listAccountMembers(accountId),
    staleTime: 30_000,
  });

  const accountGroupsQuery = useQuery({
    queryKey: ['account-groups', accountId],
    queryFn: () => listGroups(accountId),
    staleTime: 30_000,
  });

  const projectGroupsQuery = useQuery({
    queryKey: ['project-groups', accountId],
    queryFn: () => listProjectGroups(accountId),
    staleTime: 30_000,
  });

  const rolesById = useMemo(() => {
    const map = new Map<string, IamRole>();
    for (const r of rolesQuery.data ?? []) map.set(r.role_id, r);
    return map;
  }, [rolesQuery.data]);

  const projectsById = useMemo(() => {
    const map = new Map<string, KortixProject>();
    for (const p of projectsQuery.data ?? []) map.set(p.project_id, p);
    return map;
  }, [projectsQuery.data]);

  const deleteMutation = useMutation({
    mutationFn: (policyId: string) => deletePolicy(accountId, policyId),
    onSuccess: () => {
      toast.success('Policy removed');
      queryClient.invalidateQueries({ queryKey });
      setDeleteTarget(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to delete policy'),
  });

  const policies = policiesQuery.data ?? [];

  function exportPoliciesAsJson() {
    // Use role_key (not role_id) so the JSON is portable across accounts.
    // Role lookup table: role_id → role_key.
    const roleKeyById = new Map<string, string>();
    for (const r of rolesQuery.data ?? []) {
      roleKeyById.set(r.role_id, r.key);
    }
    const exportEntries: BulkImportEntry[] = policies.map((p) => ({
      principal_type: p.principal_type,
      principal_id: p.principal_id,
      scope_type: p.scope_type,
      scope_id: p.scope_id,
      role_key: roleKeyById.get(p.role_id) ?? '__unknown__',
      effect: p.effect,
      conditions: p.conditions,
    }));
    const payload = {
      exported_at: new Date().toISOString(),
      principal_label: principalLabel,
      policies: exportEntries,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `iam-policies-${principalType}-${principalId}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <SectionCard
        title="Permission policies"
        description={`Policies grant ${principalLabel} access to specific resources.`}
        action={
          canManage && (
            <div className="flex gap-1.5">
              {policies.length > 0 && (
                <Button
                  onClick={exportPoliciesAsJson}
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  title="Download policies as JSON (portable across accounts)"
                >
                  <Download className="h-4 w-4" />
                  Export
                </Button>
              )}
              <Button
                onClick={() => setImportOpen(true)}
                size="sm"
                variant="outline"
                className="gap-1.5"
                title="Bulk-import policies from JSON"
              >
                <Upload className="h-4 w-4" />
                Import
              </Button>
              <Button
                onClick={() => setTemplatesOpen(true)}
                size="sm"
                variant="outline"
                className="gap-1.5"
                title="Apply a curated set of policies in one click"
              >
                <Sparkles className="h-4 w-4" />
                From template
              </Button>
              <Button onClick={() => setCreateOpen(true)} size="sm" className="gap-1.5">
                <Plus className="h-4 w-4" />
                Grant access
              </Button>
            </div>
          )
        }
        flush
      >
      {policiesQuery.isError && (
        <div className="px-6 py-5">
          <p className="text-sm text-destructive">
            {(policiesQuery.error as Error)?.message || 'Failed to load policies'}
          </p>
        </div>
      )}

      {policiesQuery.isLoading && (
        <div className="divide-y divide-border/60">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="px-6 py-3">
              <Skeleton className="h-4 w-full" />
            </div>
          ))}
        </div>
      )}

      {!policiesQuery.isLoading && policies.length === 0 && (
        <EmptyState
          icon={KeyRound}
          size="sm"
          title="No access granted yet"
          description={
            canManage
              ? `Grant ${principalLabel} access to a project or the whole account.`
              : 'No permission policies have been attached.'
          }
        />
      )}

      {!policiesQuery.isLoading && policies.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 bg-muted/20 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              <th className="px-6 py-2.5 font-medium">Effect</th>
              <th className="px-3 py-2.5 font-medium">Scope</th>
              <th className="px-3 py-2.5 font-medium">Applies to</th>
              <th className="px-3 py-2.5 font-medium">Role</th>
              <th className="w-12 px-3 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {policies.map((p) => {
              const role = rolesById.get(p.role_id);
              const scopeLabel = RESOURCE_TYPE_META[p.scope_type]?.label ?? p.scope_type;
              const appliesTo =
                p.scope_type === 'account'
                  ? 'All resources in this account'
                  : p.scope_id === null
                    ? `All ${p.scope_type}s in this account`
                    : p.scope_type === 'project'
                      ? projectsById.get(p.scope_id)?.name ?? p.scope_id
                      : p.scope_id;
              const isDeny = p.effect === 'deny';
              const conditionBadges = summariseConditions(p.conditions);
              return (
                <tr key={p.policy_id} className="hover:bg-muted/20">
                  <td className="px-6 py-3">
                    <Badge
                      variant={isDeny ? 'destructive' : 'outline'}
                      size="sm"
                      className="uppercase tracking-wider"
                    >
                      {p.effect}
                    </Badge>
                  </td>
                  <td className="px-3 py-3 font-medium text-foreground">{scopeLabel}</td>
                  <td className="px-3 py-3 text-muted-foreground">{appliesTo}</td>
                  <td className="px-3 py-3">
                    {role ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline" size="sm">
                          {role.name}
                        </Badge>
                        {conditionBadges.map((c) => (
                          <Badge
                            key={c}
                            variant="outline"
                            size="sm"
                            className="gap-1 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                            title="Applies only when this condition is met"
                          >
                            <ShieldCheck className="h-3 w-3" />
                            {c}
                          </Badge>
                        ))}
                        {p.expires_at && (
                          <Badge
                            variant="outline"
                            size="sm"
                            className="border-amber-500/40 text-amber-700 dark:text-amber-300"
                            title={`Auto-revokes at ${new Date(p.expires_at).toLocaleString()}`}
                          >
                            expires in {formatExpiryShort(p.expires_at)}
                          </Badge>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">unknown role</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right">
                    {canManage && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-foreground"
                            aria-label="Policy actions"
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem
                            onSelect={() => setEditTarget(p)}
                            className="gap-2"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            Edit policy
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => setDeleteTarget(p)}
                            className="gap-2 text-destructive focus:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Remove policy
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      </SectionCard>

      <CreatePolicyDialog
        open={createOpen || !!editTarget}
        onOpenChange={(open) => {
          if (!open) {
            setCreateOpen(false);
            setEditTarget(null);
          } else if (!editTarget) {
            setCreateOpen(true);
          }
        }}
        accountId={accountId}
        principalType={principalType}
        principalId={principalId}
        principalLabel={principalLabel}
        roles={rolesQuery.data ?? []}
        projects={projectsQuery.data ?? []}
        members={accountMembersQuery.data ?? []}
        groups={accountGroupsQuery.data ?? []}
        projectGroups={projectGroupsQuery.data ?? []}
        editing={editTarget}
        onCreated={() => queryClient.invalidateQueries({ queryKey })}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Remove policy"
        description="This member or group will lose the permissions granted by this policy."
        confirmLabel="Remove policy"
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.policy_id);
        }}
      />

      <ApplyTemplateDialog
        open={templatesOpen}
        onOpenChange={setTemplatesOpen}
        accountId={accountId}
        principalType={principalType}
        principalId={principalId}
        projects={projectsQuery.data ?? []}
        projectGroups={projectGroupsQuery.data ?? []}
        onApplied={() => queryClient.invalidateQueries({ queryKey })}
      />

      <BulkImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        accountId={accountId}
        principalType={principalType}
        principalId={principalId}
        onImported={() => queryClient.invalidateQueries({ queryKey })}
      />
    </>
  );
}

// ─── Apply template dialog ─────────────────────────────────────────────────

// ─── Bulk import dialog ────────────────────────────────────────────────────

function BulkImportDialog({
  open,
  onOpenChange,
  accountId,
  principalType,
  principalId,
  onImported,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  accountId: string;
  principalType: PrincipalType;
  principalId: string;
  onImported: () => void;
}) {
  const [json, setJson] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [preview, setPreview] = useState<BulkImportEntry[] | null>(null);
  const [retargetToCurrent, setRetargetToCurrent] = useState(true);

  function parse() {
    setParseError(null);
    setPreview(null);
    if (!json.trim()) return;
    try {
      const data = JSON.parse(json);
      // Accept either the exported object shape ({ policies: [...] })
      // or a bare array of entries.
      let entries: BulkImportEntry[];
      if (Array.isArray(data)) {
        entries = data;
      } else if (data && Array.isArray(data.policies)) {
        entries = data.policies;
      } else {
        setParseError('Expected an array of policies or an object with a "policies" array.');
        return;
      }
      if (retargetToCurrent) {
        entries = entries.map((e) => ({
          ...e,
          principal_type: principalType,
          principal_id: principalId,
        }));
      }
      setPreview(entries);
    } catch (err) {
      setParseError((err as Error).message);
    }
  }

  const mutation = useMutation({
    mutationFn: () => {
      if (!preview) throw new Error('parse JSON first');
      return bulkImportPolicies(accountId, preview);
    },
    onSuccess: (res) => {
      const note =
        res.errors.length > 0
          ? ` (${res.errors.length} error${res.errors.length === 1 ? '' : 's'})`
          : '';
      toast.success(
        `Imported ${res.created} of ${res.attempted}; ${res.skipped} already existed${note}.`,
      );
      onImported();
      setJson('');
      setPreview(null);
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to import'),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Bulk import policies</DialogTitle>
          <DialogDescription>
            Paste JSON exported from this UI or built by hand. Entries
            reference roles by <span className="font-mono">role_key</span> so
            they&apos;re portable across accounts.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <textarea
            value={json}
            onChange={(e) => {
              setJson(e.target.value);
              setPreview(null);
              setParseError(null);
            }}
            placeholder='[{"principal_type":"member","principal_id":"...","scope_type":"project","scope_id":"...","role_key":"project_editor"}]'
            className="h-48 w-full resize-y rounded-md border border-border/60 bg-background p-2 font-mono text-xs"
            disabled={mutation.isPending}
          />

          <label className="flex cursor-pointer items-start gap-2 text-xs text-foreground">
            <input
              type="checkbox"
              checked={retargetToCurrent}
              onChange={(e) => setRetargetToCurrent(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 rounded border-border accent-primary"
              disabled={mutation.isPending}
            />
            <span>
              <span className="font-medium">Re-target to this {principalType}</span>
              <span className="block text-[11px] text-muted-foreground">
                Overrides the principal in every entry so you can import an
                export from a different member / group.
              </span>
            </span>
          </label>

          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={parse} disabled={mutation.isPending}>
              Parse & preview
            </Button>
            {preview && (
              <span className="text-xs text-muted-foreground">
                {preview.length} {preview.length === 1 ? 'entry' : 'entries'} parsed
              </span>
            )}
          </div>

          {parseError && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {parseError}
            </p>
          )}

          {preview && preview.length > 0 && (
            <div className="max-h-40 overflow-y-auto rounded-md border border-border/60 px-3 py-2 text-[11px]">
              {preview.map((e, i) => (
                <div key={i} className="flex items-center gap-2 py-0.5 font-mono">
                  <Badge variant="outline" size="sm" className="text-[9px]">
                    {e.effect ?? 'allow'}
                  </Badge>
                  <span className="text-foreground">{e.role_key}</span>
                  <span className="text-muted-foreground">on</span>
                  <span className="text-foreground">
                    {e.scope_type}
                    {e.scope_id ? `:${e.scope_id.slice(0, 8)}…` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!preview || preview.length === 0 || mutation.isPending}
            className="gap-1.5"
          >
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Import {preview ? `(${preview.length})` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ApplyTemplateDialog({
  open,
  onOpenChange,
  accountId,
  principalType,
  principalId,
  projects,
  projectGroups,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  accountId: string;
  principalType: PrincipalType;
  principalId: string;
  projects: KortixProject[];
  projectGroups: ProjectGroup[];
  onApplied: () => void;
}) {
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [scopeId, setScopeId] = useState<string>('');

  const templatesQuery = useQuery({
    queryKey: ['policy-templates', accountId],
    queryFn: () => listPolicyTemplates(accountId),
    enabled: open,
    staleTime: 5 * 60_000,
  });

  // Show only templates that fit the current principal type.
  const eligible = useMemo(() => {
    return (templatesQuery.data ?? []).filter((t) =>
      t.applies_to.includes(principalType),
    );
  }, [templatesQuery.data, principalType]);

  const selected: PolicyTemplate | undefined = useMemo(
    () => eligible.find((t) => t.key === selectedKey),
    [eligible, selectedKey],
  );

  const mutation = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error('pick a template');
      return applyPolicyTemplate(accountId, selected.key, {
        principal_type: principalType,
        principal_id: principalId,
        scope_id:
          selected.needs_scope_id === 'account' ? null : scopeId || null,
      });
    },
    onSuccess: (res) => {
      const created = res.created.length;
      const skipped = res.skipped.length;
      if (created > 0) {
        toast.success(
          `Applied template — ${created} ${created === 1 ? 'policy' : 'policies'} created${skipped > 0 ? `, ${skipped} skipped (already existed)` : ''}.`,
        );
      } else if (skipped > 0) {
        toast.info('Nothing applied — all policies already exist.');
      } else {
        toast.success('Template applied');
      }
      onApplied();
      setSelectedKey('');
      setScopeId('');
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to apply template'),
  });

  const needsScope =
    selected && selected.needs_scope_id !== 'account';
  const ready =
    !!selected && (!needsScope || !!scopeId);

  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Apply a policy template</DialogTitle>
          <DialogDescription>
            Templates are curated bundles — pick one and we&apos;ll create the
            matching policies in one shot. Skipped entries already existed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {templatesQuery.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : eligible.length === 0 ? (
            <p className="rounded-md border border-border/60 px-3 py-3 text-xs text-muted-foreground">
              No templates apply to this principal type.
            </p>
          ) : (
            <div className="space-y-1.5">
              {eligible.map((t) => {
                const isSelected = selectedKey === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => {
                      setSelectedKey(t.key);
                      setScopeId('');
                    }}
                    className={`flex w-full cursor-pointer flex-col gap-1 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                      isSelected
                        ? 'border-primary bg-primary/5'
                        : 'border-border/60 hover:bg-muted/40'
                    }`}
                    disabled={mutation.isPending}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-foreground">{t.name}</span>
                      <Badge variant="outline" size="sm" className="text-[10px]">
                        {t.entries.length}{' '}
                        {t.entries.length === 1 ? 'policy' : 'policies'}
                      </Badge>
                    </div>
                    <p className="text-[11px] text-muted-foreground">{t.description}</p>
                  </button>
                );
              })}
            </div>
          )}

          {needsScope && selected && (
            <div className="space-y-1.5">
              <Label>
                {selected.needs_scope_id === 'project' ? 'Project' : 'Project group'}
              </Label>
              <Select
                value={scopeId || undefined}
                onValueChange={setScopeId}
                disabled={mutation.isPending}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      selected.needs_scope_id === 'project'
                        ? 'Pick a project...'
                        : 'Pick a project group...'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {selected.needs_scope_id === 'project'
                    ? projects.length === 0
                      ? (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">
                          No projects in this account
                        </div>
                      )
                      : projects.map((p) => (
                          <SelectItem key={p.project_id} value={p.project_id}>
                            {p.name}
                          </SelectItem>
                        ))
                    : projectGroups.length === 0
                      ? (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">
                          No project groups yet
                        </div>
                      )
                      : projectGroups.map((g) => (
                          <SelectItem key={g.group_id} value={g.group_id}>
                            {g.name}
                          </SelectItem>
                        ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!ready || mutation.isPending}
            className="gap-1.5"
          >
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Apply template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Pure helpers live in ./policies-table-helpers — re-exported for the
// component below, unit-tested separately.
import {
  formatExpiryShort,
  isPlausibleCidr,
  summariseConditions,
  toLocalInput,
} from './policies-table-helpers';

// ─── Create policy dialog ──────────────────────────────────────────────────

interface CreatePolicyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  principalType: PrincipalType;
  principalId: string;
  /** Used in the summary sentence above the Create button. */
  principalLabel: string;
  roles: IamRole[];
  projects: KortixProject[];
  members: AccountMember[];
  groups: AccountGroup[];
  projectGroups: ProjectGroup[];
  /** Non-null = the dialog opens pre-filled to edit this policy in place
   * instead of creating new ones. Editing is single-role since a policy IS
   * a (principal, scope, role, effect) tuple — changing the role means
   * changing the row. */
  editing?: IamPolicy | null;
  onCreated: () => void;
}

function CreatePolicyDialog({
  open,
  onOpenChange,
  accountId,
  principalType,
  principalId,
  principalLabel,
  roles,
  projects,
  members,
  groups,
  projectGroups,
  editing,
  onCreated,
}: CreatePolicyDialogProps) {
  const isEditing = !!editing;
  const [effect, setEffect] = useState<PolicyEffect>('allow');
  const [scopeType, setScopeType] = useState<PolicyScopeType | ''>('');
  const [scopeId, setScopeId] = useState<string>('');
  const [selectedRoleIds, setSelectedRoleIds] = useState<Set<string>>(new Set());
  const [roleSearch, setRoleSearch] = useState('');

  // ─── Conditions sub-form (collapsed by default) ────────────────────
  // Hidden behind a disclosure because the common policy has no
  // conditions. The dialog stays simple unless the admin opts in.
  const [conditionsOpen, setConditionsOpen] = useState(false);
  const [requireMfa, setRequireMfa] = useState(false);
  const [ipCidrs, setIpCidrs] = useState<string[]>([]);
  const [cidrDraft, setCidrDraft] = useState('');
  const [cidrError, setCidrError] = useState<string | null>(null);

  // ─── Expiry preset ─────────────────────────────────────────────────
  // null = permanent; 'iso-string' = custom ISO; '1d'|'7d'|'30d'|'90d' =
  // relative preset, resolved to an ISO when sent. Most admins want
  // "auto-revoke in N days" so we keep the picker fast with presets.
  const [expiryPreset, setExpiryPreset] = useState<'permanent' | '1d' | '7d' | '30d' | '90d' | 'custom'>('permanent');
  const [expiryCustomISO, setExpiryCustomISO] = useState('');

  // Hydrate from the policy being edited whenever the dialog opens in edit
  // mode. Clearing happens via reset() on close.
  useEffect(() => {
    if (open && editing) {
      setEffect(editing.effect);
      setScopeType(editing.scope_type);
      setScopeId(editing.scope_id ?? '');
      setSelectedRoleIds(new Set([editing.role_id]));
      setRoleSearch('');
      const cond = editing.conditions ?? {};
      const cidrs = Array.isArray(cond.ip_cidrs) ? cond.ip_cidrs : [];
      const mfa = cond.require_mfa === true;
      setRequireMfa(mfa);
      setIpCidrs(cidrs);
      setCidrDraft('');
      setCidrError(null);
      // Auto-expand if there's anything to show — admins shouldn't have
      // to hunt for conditions they already configured.
      setConditionsOpen(cidrs.length > 0 || mfa);
      if (editing.expires_at) {
        setExpiryPreset('custom');
        setExpiryCustomISO(editing.expires_at);
      } else {
        setExpiryPreset('permanent');
        setExpiryCustomISO('');
      }
    }
  }, [open, editing]);

  // Auto-focus the next picker as the user advances. Feels more like a
  // conversation than a form: pick a scope → focus jumps to the picker for
  // resources of that scope → then to the roles list.
  const appliesToTriggerRef = useRef<HTMLButtonElement>(null);
  const rolesContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!scopeType || scopeType === 'account') return;
    // Wait one frame so the newly-rendered SelectTrigger is in the DOM.
    const id = requestAnimationFrame(() => appliesToTriggerRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [scopeType]);

  useEffect(() => {
    const rolesReady = scopeType === 'account' || (!!scopeType && !!scopeId);
    if (!rolesReady) return;
    const id = requestAnimationFrame(() => {
      const first = rolesContainerRef.current?.querySelector<HTMLButtonElement>('button');
      first?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [scopeType, scopeId]);

  // Reset whenever the dialog closes so the next open is clean.
  function reset() {
    setEffect('allow');
    setScopeType('');
    setScopeId('');
    setSelectedRoleIds(new Set());
    setRoleSearch('');
    setConditionsOpen(false);
    setRequireMfa(false);
    setIpCidrs([]);
    setCidrDraft('');
    setCidrError(null);
    setExpiryPreset('permanent');
    setExpiryCustomISO('');
  }

  /** Resolve the picker state into the value sent on the wire:
   *    permanent → null (no expiry)
   *    1d|7d|30d|90d → ISO N days from now
   *    custom → the custom-input ISO (or null if blank) */
  function buildExpiresAt(): string | null {
    if (expiryPreset === 'permanent') return null;
    if (expiryPreset === 'custom') {
      return expiryCustomISO.trim() ? expiryCustomISO.trim() : null;
    }
    const days =
      expiryPreset === '1d' ? 1 :
      expiryPreset === '7d' ? 7 :
      expiryPreset === '30d' ? 30 : 90;
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }

  /** Build the wire conditions object from the dialog state. Returns
   *  undefined when nothing is configured so the client doesn't send a
   *  spurious empty object on every save. */
  function buildConditions(): PolicyConditions | undefined {
    const out: PolicyConditions = {};
    if (ipCidrs.length > 0) out.ip_cidrs = ipCidrs;
    if (requireMfa) out.require_mfa = true;
    if (!out.ip_cidrs && !out.require_mfa) return undefined;
    return out;
  }

  function addCidr(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) {
      setCidrError(null);
      return;
    }
    if (!isPlausibleCidr(trimmed)) {
      setCidrError(`'${trimmed}' is not a valid IP or CIDR`);
      return;
    }
    if (ipCidrs.includes(trimmed)) {
      setCidrError('That CIDR is already in the list');
      return;
    }
    setIpCidrs((prev) => [...prev, trimmed]);
    setCidrDraft('');
    setCidrError(null);
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!scopeType) throw new Error('Pick a scope');
      if (selectedRoleIds.size === 0) throw new Error('Pick at least one role');
      const normalisedScopeId =
        scopeType === 'account'
          ? null
          : scopeId
            ? scopeId
            : null;

      // On edit we explicitly send `conditions` (possibly empty `{}`) so
      // clearing them clears the row. On create, omit when there are
      // none so the server stores `{}` by default.
      const builtConditions = buildConditions();
      const builtExpiresAt = buildExpiresAt();

      // Edit mode: in-place mutation of the existing row. Single role only —
      // a policy IS one (scope, role, effect) triplet.
      if (editing) {
        const [roleId] = Array.from(selectedRoleIds);
        await updatePolicy(accountId, editing.policy_id, {
          scopeType,
          scopeId: normalisedScopeId,
          roleId,
          effect,
          conditions: builtConditions ?? {},
          // Always send expires_at on edit (including null) so the
          // server clears any prior expiry when the admin picks
          // "permanent".
          expires_at: builtExpiresAt,
        });
        return;
      }

      // Create mode: one row per selected role (Cloudflare-style).
      for (const roleId of selectedRoleIds) {
        await createPolicy(accountId, {
          principalType,
          principalId,
          scopeType,
          scopeId: normalisedScopeId,
          roleId,
          effect,
          ...(builtConditions ? { conditions: builtConditions } : {}),
          ...(builtExpiresAt ? { expires_at: builtExpiresAt } : {}),
        });
      }
    },
    onSuccess: () => {
      toast.success(editing ? 'Policy updated' : 'Policy created');
      onCreated();
      reset();
      onOpenChange(false);
    },
    onError: (err: Error) =>
      toast.error(err.message || (editing ? 'Failed to update policy' : 'Failed to create policy')),
  });

  // Roles available for the chosen scope.
  //   - Everything scope (account)  → every role in the catalog
  //   - resource-specific scope     → ONLY roles tagged for that resource
  //
  // Cloudflare-style. Granting "Administrator" on a single project makes no
  // sense; the strict filter cuts the role list from ~15 down to ~4 for the
  // common case and removes a major source of confusion.
  const availableRoles = useMemo(() => {
    if (!scopeType) return [];
    if (scopeType === 'account') return roles;
    // Project groups expand to projects — show project roles, not a
    // separate "project_group" role family (which we don't ship).
    const effectiveType = scopeType === 'project_group' ? 'project' : scopeType;
    return roles.filter((r) => r.resource_type === effectiveType);
  }, [roles, scopeType]);

  // Whether we have enough to submit.
  const ready = (() => {
    if (!scopeType || selectedRoleIds.size === 0) return false;
    if (scopeType !== 'account' && !scopeId) return false;
    return true;
  })();

  function toggleRole(roleId: string) {
    // Editing a single policy → behave like a radio (one role per policy).
    // Creating → checkbox (one policy per selected role).
    if (isEditing) {
      setSelectedRoleIds(new Set([roleId]));
      return;
    }
    setSelectedRoleIds((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  }

  // Roles section is revealed once the user has named a real target.
  // For account-Everything that's immediate; otherwise wait for the picker.
  const showRoles = scopeType === 'account' || (!!scopeType && !!scopeId);

  // Search only kicks in when the role list is long enough to warrant it
  // (Everything scope shows the full catalog). For 1–6 roles it's just noise.
  const SEARCH_THRESHOLD = 6;
  const filteredRoles = useMemo(() => {
    if (!roleSearch.trim()) return availableRoles;
    const q = roleSearch.trim().toLowerCase();
    return availableRoles.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.description?.toLowerCase().includes(q),
    );
  }, [availableRoles, roleSearch]);

  // Human-readable summary fragments rendered above the Create button.
  const selectedRoleNames = useMemo(() => {
    if (selectedRoleIds.size === 0) return '';
    return availableRoles
      .filter((r) => selectedRoleIds.has(r.role_id))
      .map((r) => r.name)
      .join(', ');
  }, [availableRoles, selectedRoleIds]);

  const appliesToLabel = useMemo(() => {
    if (scopeType === 'account') return 'all resources in this account';
    if (scopeType === 'project') {
      return projects.find((p) => p.project_id === scopeId)?.name ?? 'this project';
    }
    if (scopeType === 'member') {
      const m = members.find((x) => x.user_id === scopeId);
      return m?.email ?? 'this member';
    }
    if (scopeType === 'group') {
      return groups.find((g) => g.group_id === scopeId)?.name ?? 'this group';
    }
    if (scopeType === 'project_group') {
      const g = projectGroups.find((pg) => pg.group_id === scopeId);
      return g
        ? `every project in ${g.name}`
        : 'every project in this group';
    }
    return 'this scope';
  }, [scopeType, scopeId, projects, members, groups, projectGroups]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (createMutation.isPending) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit policy' : 'Create policy'}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? 'Change the scope, role, or effect. The principal stays the same.'
              : 'Grant access to a scope. One policy is created per role.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* ── Step 1: Scope (always visible) ─────────────────────── */}
          <div className="space-y-1.5">
            <Label>Scope</Label>
            <Select
              value={scopeType || undefined}
              onValueChange={(v) => {
                setScopeType(v as PolicyScopeType);
                setScopeId('');
                setSelectedRoleIds(new Set());
              }}
              disabled={createMutation.isPending}
            >
              <SelectTrigger>
                <SelectValue placeholder="Pick a scope..." />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Account-level
                  </SelectLabel>
                  <SelectItem value="account">Everything</SelectItem>
                </SelectGroup>
                <SelectGroup>
                  <SelectLabel className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Resource-specific
                  </SelectLabel>
                  {(['project', 'project_group', 'member', 'group', 'sandbox', 'trigger', 'channel'] as PolicyScopeType[]).map(
                    (rt) => {
                      const meta = RESOURCE_TYPE_META[rt];
                      return (
                        <SelectItem key={rt} value={rt}>
                          {meta.label}
                          {meta.inputKind === 'text' && (
                            <span className="ml-2 text-[10px] text-muted-foreground">id paste</span>
                          )}
                        </SelectItem>
                      );
                    },
                  )}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          {/* ── Step 2: Applies to (only after a scope is picked) ─── */}
          {scopeType && (
            <div className="space-y-1.5">
              <Label>Applies to</Label>
              {scopeType === 'account' && (
                <p className="rounded-2xl border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
                  All resources in this account
                </p>
              )}
              {scopeType === 'project' && (
                <Select
                  value={scopeId || undefined}
                  onValueChange={setScopeId}
                  disabled={createMutation.isPending}
                >
                  <SelectTrigger ref={appliesToTriggerRef}>
                    <SelectValue placeholder="Pick a project..." />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.length === 0 ? (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">
                        No projects in this account
                      </div>
                    ) : (
                      projects.map((p) => (
                        <SelectItem key={p.project_id} value={p.project_id}>
                          {p.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              )}
              {scopeType === 'member' && (
                <Select
                  value={scopeId || undefined}
                  onValueChange={setScopeId}
                  disabled={createMutation.isPending}
                >
                  <SelectTrigger ref={appliesToTriggerRef}>
                    <SelectValue placeholder="Pick a member..." />
                  </SelectTrigger>
                  <SelectContent>
                    {members.length === 0 ? (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">
                        No members in this account
                      </div>
                    ) : (
                      members.map((m) => (
                        <SelectItem key={m.user_id} value={m.user_id}>
                          {m.email ?? m.user_id}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              )}
              {scopeType === 'group' && (
                <Select
                  value={scopeId || undefined}
                  onValueChange={setScopeId}
                  disabled={createMutation.isPending}
                >
                  <SelectTrigger ref={appliesToTriggerRef}>
                    <SelectValue placeholder="Pick a group..." />
                  </SelectTrigger>
                  <SelectContent>
                    {groups.length === 0 ? (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">
                        No groups in this account
                      </div>
                    ) : (
                      groups.map((g) => (
                        <SelectItem key={g.group_id} value={g.group_id}>
                          {g.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              )}
              {scopeType === 'project_group' && (
                <Select
                  value={scopeId || undefined}
                  onValueChange={setScopeId}
                  disabled={createMutation.isPending}
                >
                  <SelectTrigger ref={appliesToTriggerRef}>
                    <SelectValue placeholder="Pick a project group..." />
                  </SelectTrigger>
                  <SelectContent>
                    {projectGroups.length === 0 ? (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">
                        No project groups yet. Create one in Settings → Project
                        groups, then attach projects to it.
                      </div>
                    ) : (
                      projectGroups.map((g) => (
                        <SelectItem key={g.group_id} value={g.group_id}>
                          {g.name}
                          <span className="ml-2 text-[10px] text-muted-foreground">
                            ({g.project_count}{' '}
                            {g.project_count === 1 ? 'project' : 'projects'})
                          </span>
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              )}
              {scopeType !== 'account' &&
                RESOURCE_TYPE_META[scopeType]?.inputKind === 'text' && (
                  <>
                    <Input
                      value={scopeId}
                      onChange={(e) => setScopeId(e.target.value.trim())}
                      placeholder={`Paste the ${scopeType} id`}
                      className="font-mono text-xs"
                      disabled={createMutation.isPending}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      No picker yet for {scopeType}s. Find the id in the
                      resource&apos;s URL or detail page and paste it here.
                    </p>
                  </>
                )}
            </div>
          )}

          {/* ── Step 3: Roles (only after Applies-to is satisfied) ── */}
          {showRoles && (
            <div className="space-y-1.5">
              <Label>{isEditing ? 'Role' : 'Roles'}</Label>
              {!isEditing && availableRoles.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Each selected role becomes its own policy.
                </p>
              )}
              {availableRoles.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
                  No roles available for this scope.
                </p>
              ) : (
                <>
                  {availableRoles.length > SEARCH_THRESHOLD && (
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={roleSearch}
                        onChange={(e) => setRoleSearch(e.target.value)}
                        placeholder="Search roles..."
                        className="h-8 pl-8 text-sm"
                        disabled={createMutation.isPending}
                      />
                    </div>
                  )}
                  <div
                    ref={rolesContainerRef}
                    role={isEditing ? 'radiogroup' : 'group'}
                    className="max-h-64 space-y-1 overflow-y-auto rounded-2xl border border-border/60 p-2"
                  >
                    {filteredRoles.length === 0 ? (
                      <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                        No roles match &ldquo;{roleSearch}&rdquo;.
                      </p>
                    ) : (
                      filteredRoles.map((r) => {
                        const checked = selectedRoleIds.has(r.role_id);
                        return (
                          <button
                            key={r.role_id}
                            type="button"
                            role={isEditing ? 'radio' : 'checkbox'}
                            aria-checked={checked}
                            onClick={() => toggleRole(r.role_id)}
                            className={`flex w-full cursor-pointer items-start gap-3 rounded-md px-2.5 py-2 text-left transition-colors ${
                              checked ? 'bg-primary/5' : 'hover:bg-muted/40'
                            }`}
                            disabled={createMutation.isPending}
                          >
                            {/* Native input purely as the visual indicator —
                                clicks are absorbed by the wrapping button. */}
                            <input
                              type={isEditing ? 'radio' : 'checkbox'}
                              checked={checked}
                              readOnly
                              tabIndex={-1}
                              className={`mt-0.5 h-3.5 w-3.5 border-border accent-primary ${
                                isEditing ? 'rounded-full' : 'rounded'
                              }`}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-foreground">
                                  {r.name}
                                </span>
                                {r.is_system && (
                                  <Badge variant="outline" className="h-4 rounded-md px-1 text-[9px] font-normal">
                                    system
                                  </Badge>
                                )}
                              </div>
                              {r.description && (
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                  {r.description}
                                </p>
                              )}
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Optional: Deny toggle (subdued, after Roles) ──────── */}
          {showRoles && availableRoles.length > 0 && (
            <label className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={effect === 'deny'}
                onChange={(e) => setEffect(e.target.checked ? 'deny' : 'allow')}
                disabled={createMutation.isPending}
                className="mt-0.5 h-3.5 w-3.5 rounded border-border accent-destructive"
              />
              <span>
                Make this a <strong className="text-destructive">deny</strong> policy
                {effect === 'deny' && (
                  <span className="block text-[11px] text-muted-foreground">
                    Revokes the role&apos;s actions on this scope. Wins over any allow.
                  </span>
                )}
              </span>
            </label>
          )}

          {/* ── Optional: Expiry preset ───────────────────────────── */}
          {showRoles && availableRoles.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs">Auto-expire</Label>
              <div className="flex flex-wrap gap-1">
                {(
                  [
                    { key: 'permanent', label: 'Never' },
                    { key: '1d', label: '1 day' },
                    { key: '7d', label: '7 days' },
                    { key: '30d', label: '30 days' },
                    { key: '90d', label: '90 days' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => {
                      setExpiryPreset(opt.key);
                      setExpiryCustomISO('');
                    }}
                    className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                      expiryPreset === opt.key
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border/60 text-muted-foreground hover:bg-muted/40'
                    }`}
                    disabled={createMutation.isPending}
                  >
                    {opt.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setExpiryPreset('custom')}
                  className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                    expiryPreset === 'custom'
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border/60 text-muted-foreground hover:bg-muted/40'
                  }`}
                  disabled={createMutation.isPending}
                >
                  Custom
                </button>
              </div>
              {expiryPreset === 'custom' && (
                <Input
                  type="datetime-local"
                  value={expiryCustomISO ? toLocalInput(expiryCustomISO) : ''}
                  onChange={(e) =>
                    setExpiryCustomISO(
                      e.target.value ? new Date(e.target.value).toISOString() : '',
                    )
                  }
                  className="h-8 text-xs"
                  disabled={createMutation.isPending}
                />
              )}
              <p className="text-[11px] text-muted-foreground">
                {expiryPreset === 'permanent'
                  ? 'Policy stays in effect until you delete it.'
                  : `The engine ignores this policy after the chosen time.`}
              </p>
            </div>
          )}

          {/* ── Optional: Conditions (collapsed by default) ───────── */}
          {showRoles && availableRoles.length > 0 && (
            <div className="rounded-2xl border border-border/60">
              <button
                type="button"
                onClick={() => setConditionsOpen((v) => !v)}
                className="flex w-full items-center justify-between gap-2 rounded-2xl px-3 py-2.5 text-left text-xs font-medium text-muted-foreground hover:bg-muted/30"
                disabled={createMutation.isPending}
              >
                <span className="flex items-center gap-1.5">
                  {conditionsOpen ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                  Conditions
                  {(requireMfa || ipCidrs.length > 0) && (
                    <Badge variant="outline" size="sm" className="h-4 px-1 text-[9px] font-normal">
                      {(requireMfa ? 1 : 0) + (ipCidrs.length > 0 ? 1 : 0)}
                    </Badge>
                  )}
                </span>
                <span className="text-[11px] font-normal">
                  Restrict by IP or MFA
                </span>
              </button>
              {conditionsOpen && (
                <div className="space-y-4 border-t border-border/60 px-3 py-3">
                  {/* Require MFA */}
                  <label className="flex cursor-pointer items-start gap-2 text-xs text-foreground">
                    <input
                      type="checkbox"
                      checked={requireMfa}
                      onChange={(e) => setRequireMfa(e.target.checked)}
                      disabled={createMutation.isPending}
                      className="mt-0.5 h-3.5 w-3.5 rounded border-border accent-primary"
                    />
                    <span>
                      <strong>Require MFA</strong>
                      <span className="block text-[11px] text-muted-foreground">
                        Policy only applies when the session is verified with a second
                        factor (Supabase aal2).
                      </span>
                    </span>
                  </label>

                  {/* IP allowlist */}
                  <div className="space-y-1.5">
                    <div>
                      <Label className="text-xs">IP allowlist</Label>
                      <p className="text-[11px] text-muted-foreground">
                        Caller&apos;s IP must match one of these. Accepts IPv4 / IPv6
                        addresses or CIDRs (10.0.0.0/8, 2001:db8::/32). Empty = no
                        restriction.
                      </p>
                    </div>
                    {ipCidrs.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {ipCidrs.map((c) => (
                          <Badge
                            key={c}
                            variant="outline"
                            size="sm"
                            className="gap-1 pr-1 font-mono text-[11px]"
                          >
                            {c}
                            <button
                              type="button"
                              onClick={() =>
                                setIpCidrs((prev) => prev.filter((x) => x !== c))
                              }
                              className="rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                              aria-label={`Remove ${c}`}
                              disabled={createMutation.isPending}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    )}
                    <div className="flex gap-1.5">
                      <Input
                        value={cidrDraft}
                        onChange={(e) => {
                          setCidrDraft(e.target.value);
                          if (cidrError) setCidrError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ',') {
                            e.preventDefault();
                            addCidr(cidrDraft);
                          }
                        }}
                        placeholder="e.g. 10.0.0.0/8"
                        className="h-8 font-mono text-xs"
                        disabled={createMutation.isPending}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => addCidr(cidrDraft)}
                        disabled={!cidrDraft.trim() || createMutation.isPending}
                      >
                        Add
                      </Button>
                    </div>
                    {cidrError && (
                      <p className="text-[11px] text-destructive">{cidrError}</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Summary line (visible once ready) ─────────────────── */}
          {ready && (
            <div className="rounded-2xl border border-border/60 bg-muted/20 px-3 py-2.5 text-sm leading-relaxed text-foreground">
              <span className="text-muted-foreground">{principalLabel}</span> will
              be{' '}
              <strong className={effect === 'deny' ? 'text-destructive' : 'text-foreground'}>
                {effect === 'deny' ? 'denied' : 'allowed'}
              </strong>{' '}
              <strong>{selectedRoleNames}</strong> on{' '}
              <strong>{appliesToLabel}</strong>
              {(requireMfa || ipCidrs.length > 0) && (
                <>
                  {' '}
                  <span className="text-muted-foreground">when</span>{' '}
                  <strong>
                    {[
                      requireMfa && 'MFA is verified',
                      ipCidrs.length > 0 &&
                        `IP is in ${ipCidrs.length === 1 ? ipCidrs[0] : `${ipCidrs.length} ranges`}`,
                    ]
                      .filter(Boolean)
                      .join(' and ')}
                  </strong>
                </>
              )}
              .
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={createMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => createMutation.mutate()}
            disabled={!ready || createMutation.isPending}
            className="gap-1.5"
            variant={effect === 'deny' ? 'destructive' : 'default'}
          >
            {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {isEditing
              ? 'Save changes'
              : effect === 'deny'
                ? 'Create deny policy'
                : 'Create policy'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
