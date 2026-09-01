'use client';

import { createSubprojectInstallSession, listAccounts, provisionProject } from '@kortix/sdk';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import Loading from '@/components/ui/loading';
import { useProjectPicker } from '@/features/projects/use-project-picker';
import { useAuth } from '@/features/providers/auth-provider';
import { isManagedGitUnavailableError } from '@/lib/onboarding/ensure-first-project';

// A use-case slug is handed to the subproject install-session as the subproject
// identifier. The marketplace catalog this used to resolve against
// (`kortix-starter:<slug>`) was removed with the marketplace, and the subproject
// index is what replaces it.
//
// UNVERIFIED, on purpose: no subproject with a use-case slug exists in the index
// yet, so this install answers 404 until that catalog content is published.
// The alternative was dropping the only CTA on an indexed acquisition page.
// Same sentinel the unified AddToProjectModal uses: "create a project inline,
// then install into it" as one Select choice next to the existing projects.
const NEW_PROJECT = '__new__';

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
  const [newProjectName, setNewProjectName] = useState('');
  const [opening, setOpening] = useState(false);

  const { projects, projectsQuery } = useProjectPicker({ open, enabled: !!user });
  const activeProjects = useMemo(
    () => projects.filter((p) => p.status === 'active'),
    [projects],
  );

  useEffect(() => {
    if (!open) return;
    setError(null);
    setOpening(false);
    setNewProjectName(title ?? '');
  }, [open, title]);

  // Default the target once the list is known: the first project, or inline
  // creation when the account genuinely has none.
  useEffect(() => {
    if (!open || target || !projectsQuery.isSuccess) return;
    setTarget(activeProjects[0]?.project_id ?? NEW_PROJECT);
  }, [open, target, projectsQuery.isSuccess, activeProjects]);

  async function openSession() {
    setOpening(true);
    setError(null);
    try {
      let projectId = target;
      if (target === NEW_PROJECT) {
        const accounts = await listAccounts();
        // No `personal_account` flag on this API — the bootstrapped personal
        // account is the one where the caller is the primary owner.
        const account = accounts.find((a) => a.is_primary_owner) ?? accounts[0];
        if (!account) throw new Error('No account available to create a project in');
        const project = await provisionProject({
          account_id: account.account_id,
          name: newProjectName.trim() || title || 'My project',
          starter_template: 'general-knowledge-worker',
        });
        // qk.projects.scope(): every account's list AND the accountless slot.
        // qk.projects.list(...) forms are SIBLINGS under this prefix, so the
        // prefix is the only shape that reaches all of them in one call.
        queryClient.invalidateQueries({ queryKey: qk.projects.scope() });
        projectId = project.project_id;
      }
      const { session_id } = await createSubprojectInstallSession(projectId, templateId);
      // nav-contract: prefetch-only — `session_id` comes back from the install
      // POST, and the project may be provisioned in the same click, so neither
      // half of this href exists before the click.
      router.push(`/projects/${projectId}/sessions/${session_id}`);
    } catch (e) {
      setError(
        isManagedGitUnavailableError(e)
          ? "Managed git isn't set up on this server — an admin needs to connect GitHub in Git settings before projects can be created."
          : (e as Error).message || 'Could not open the install session',
      );
      setOpening(false);
    }
  }

  const confirmDisabled =
    opening ||
    !target ||
    (target === NEW_PROJECT && newProjectName.trim().length === 0);

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
              <p className="text-muted-foreground text-xs">Guided install, right in your project</p>
            </div>
          </div>

          <p className="text-muted-foreground mt-4 text-sm leading-relaxed">
            We&apos;ll open a chat in your project and an agent will walk you through it — ask for
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
                    Sign in to pick a project and open the install chat — we&apos;ll bring you right
                    back here.
                  </p>
                </div>
              </div>
            ) : projectsQuery.isPending ? (
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <Loading className="size-4" /> Loading your projects…
              </div>
            ) : projectsQuery.isError ? (
              <div className="border-border/60 bg-muted/30 rounded-xl border px-4 py-4">
                <p className="text-foreground text-sm font-medium">
                  Couldn&apos;t load your projects
                </p>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {(projectsQuery.error as Error)?.message || 'The request failed.'}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={() => projectsQuery.refetch()}
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
                      <SelectValue placeholder="Choose a project" />
                    </SelectTrigger>
                    <SelectContent>
                      {activeProjects.map((p) => (
                        <SelectItem key={p.project_id} value={p.project_id}>
                          {p.name}
                        </SelectItem>
                      ))}
                      <SelectItem value={NEW_PROJECT}>＋ New project</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {target === NEW_PROJECT && (
                  <div className="space-y-1.5">
                    <Label className="text-sm" htmlFor="use-case-new-project-name">
                      Project name
                    </Label>
                    <Input
                      id="use-case-new-project-name"
                      value={newProjectName}
                      onChange={(e) => setNewProjectName(e.target.value)}
                      placeholder="My project"
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
                    {target === NEW_PROJECT ? 'Creating project…' : 'Opening chat…'}
                  </>
                ) : (
                  <>
                    <MessagesSquare className="size-4" />{' '}
                    {target === NEW_PROJECT ? 'Create project & install' : 'Open install session'}
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
