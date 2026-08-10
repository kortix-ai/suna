'use client';

import { listAccounts, provisionWorkspace } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import {
  SignInIcon as LogIn,
  ChatsIcon as MessagesSquare,
  SparkleIcon as Sparkles,
} from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useWorkspacePicker } from '@/features/marketplace/marketplace-workspace-picker';
import { useAuth } from '@/features/providers/auth-provider';
import { installMarketplaceItemAsSession } from '@/lib/marketplace-client';
import { isManagedGitUnavailableError } from '@/lib/onboarding/ensure-first-workspace';

// First-party use-case templates ship in the bundled `kortix-starter` registry,
// so a use-case slug maps to the catalog id the install-session resolves by.
const TEMPLATE_CATALOG_NAMESPACE = 'kortix-starter';

// Same sentinel the unified AddToWorkspaceModal uses: "create a workspace inline,
// then install into it" as one Select choice next to the existing workspaces.
const NEW_WORKSPACE = '__new__';

export function TemplateSessionInstallDialog({
  templateId,
  title,
  open,
  onOpenChange,
}: {
  templateId: string;
  title?: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();
  const pathname = usePathname();
  const signInHref = `/auth?returnUrl=${encodeURIComponent(pathname ?? '/')}`;

  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [opening, setOpening] = useState(false);

  const { workspaces, workspacesQuery } = useWorkspacePicker({ open, enabled: !!user });
  const activeWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.status === 'active'),
    [workspaces],
  );

  useEffect(() => {
    if (!open) return;
    setError(null);
    setOpening(false);
    setNewWorkspaceName(title ?? '');
  }, [open, title]);

  // Default the target once the list is known: the first workspace, or inline
  // creation when the account genuinely has none.
  useEffect(() => {
    if (!open || target || !workspacesQuery.isSuccess) return;
    setTarget(activeWorkspaces[0]?.workspace_id ?? NEW_WORKSPACE);
  }, [open, target, workspacesQuery.isSuccess, activeWorkspaces]);

  async function openSession() {
    setOpening(true);
    setError(null);
    try {
      let workspaceId = target;
      if (target === NEW_WORKSPACE) {
        const accounts = await listAccounts();
        // No `personal_account` flag on this API — the bootstrapped personal
        // account is the one where the caller is the primary owner.
        const account = accounts.find((a) => a.is_primary_owner) ?? accounts[0];
        if (!account) throw new Error('No account available to create a workspace in');
        const workspace = await provisionWorkspace({
          account_id: account.account_id,
          name: newWorkspaceName.trim() || title || 'My workspace',
          starter_template: 'general-knowledge-worker',
        });
        // qk.workspaces.scope(): every account's list AND the accountless slot.
        // qk.workspaces.list(...) forms are SIBLINGS under this prefix, so the
        // prefix is the only shape that reaches all of them in one call.
        queryClient.invalidateQueries({ queryKey: qk.workspaces.scope() });
        workspaceId = workspace.workspace_id;
      }
      const { session_id } = await installMarketplaceItemAsSession(
        workspaceId,
        `${TEMPLATE_CATALOG_NAMESPACE}:${templateId}`,
      );
      router.push(`/workspaces/${workspaceId}/sessions/${session_id}`);
    } catch (e) {
      setError(
        isManagedGitUnavailableError(e)
          ? "Managed git isn't set up on this server — an admin needs to connect GitHub in Git settings before workspaces can be created."
          : (e as Error).message || 'Could not open the install session',
      );
      setOpening(false);
    }
  }

  const confirmDisabled =
    opening || !target || (target === NEW_WORKSPACE && newWorkspaceName.trim().length === 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogTitle className="sr-only">
          Set up {title ?? 'this automation'} with the agent
        </DialogTitle>

        <div className="flex flex-col p-6">
          <div className="flex items-center gap-2.5">
            <span className="bg-foreground ring-background flex size-9 items-center justify-center rounded-lg ring-4">
              <Sparkles className="text-background size-4.5" />
            </span>
            <div>
              <h3 className="text-foreground text-sm font-medium">Set it up with the agent</h3>
              <p className="text-muted-foreground text-xs">Guided install, inside your workspace</p>
            </div>
          </div>

          <p className="text-muted-foreground mt-4 text-sm leading-relaxed">
            We&apos;ll open a chat in your workspace and an agent will walk you through it — ask for
            the details it needs, connect your accounts, and turn it on when you&apos;re ready.
            Nothing runs until you say go.
          </p>

          <div className="mt-5">
            {error && <p className="text-destructive mb-3 text-sm">{error}</p>}

            {authLoading ? (
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <Loading className="size-4" /> Checking your account…
              </div>
            ) : !user ? (
              <div className="border-border/60 bg-muted/30 flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-8 text-center">
                <span className="bg-foreground text-background flex size-11 items-center justify-center rounded-xl">
                  <LogIn className="size-5" />
                </span>
                <div>
                  <p className="text-foreground text-sm font-medium">
                    Sign in to install this automation
                  </p>
                  <p className="text-muted-foreground mx-auto mt-1 max-w-xs text-xs leading-relaxed">
                    Sign in to pick a workspace and open the install chat — we&apos;ll bring you
                    right back here.
                  </p>
                </div>
              </div>
            ) : workspacesQuery.isPending ? (
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <Loading className="size-4" /> Loading your workspaces…
              </div>
            ) : workspacesQuery.isError ? (
              <div className="border-border/60 bg-muted/30 rounded-xl border px-4 py-4">
                <p className="text-foreground text-sm font-medium">
                  Couldn&apos;t load your workspaces
                </p>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {(workspacesQuery.error as Error)?.message || 'The request failed.'}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={() => workspacesQuery.refetch()}
                >
                  Try again
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-sm">Open the install chat in</Label>
                  <Select value={target} onValueChange={setTarget}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose a workspace" />
                    </SelectTrigger>
                    <SelectContent>
                      {activeWorkspaces.map((workspace) => (
                        <SelectItem key={workspace.workspace_id} value={workspace.workspace_id}>
                          {workspace.name}
                        </SelectItem>
                      ))}
                      <SelectItem value={NEW_WORKSPACE}>＋ New workspace</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {target === NEW_WORKSPACE && (
                  <div className="space-y-1.5">
                    <Label className="text-sm" htmlFor="use-case-new-workspace-name">
                      Workspace name
                    </Label>
                    <Input
                      id="use-case-new-workspace-name"
                      value={newWorkspaceName}
                      onChange={(e) => setNewWorkspaceName(e.target.value)}
                      placeholder="My workspace"
                      autoFocus
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="mt-5 flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={opening}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            {!authLoading && !user ? (
              <Button asChild size="sm">
                <Link href={signInHref}>
                  <LogIn className="size-4" /> Sign in to continue
                </Link>
              </Button>
            ) : (
              <Button size="sm" disabled={confirmDisabled} onClick={openSession}>
                {opening ? (
                  <>
                    <Loading className="size-4" />{' '}
                    {target === NEW_WORKSPACE ? 'Creating workspace…' : 'Opening chat…'}
                  </>
                ) : (
                  <>
                    <MessagesSquare className="size-4" />{' '}
                    {target === NEW_WORKSPACE
                      ? 'Create workspace & install'
                      : 'Open install session'}
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
