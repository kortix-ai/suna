'use client';

import { createMarketplaceInstallSession, listAccounts, provisionProject } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Button } from '@/components/ui/marketing/button';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useProjectPicker } from '@/features/projects/use-project-picker';
import { prepareInstallSessionNavigation } from '@/features/session/install-session-navigation';
import { isManagedGitUnavailableError } from '@/lib/onboarding/ensure-first-project';
import { cn } from '@/lib/utils';
import { templateVisual } from './template-visual';
import type { MarketplaceTemplate } from './templates-catalog';

const NEW_PROJECT = '__new__';

/**
 * Install-from-the-public-marketplace dialog — `/marketplace/<slug>` for a
 * SIGNED-IN visitor.
 *
 * The public detail page has no project context (a visitor could have zero,
 * one, or many projects), unlike `TemplateInstallModal` which is always
 * mounted inside one project's `/marketplace` tab and already knows
 * `projectId`. So this dialog's only extra job, versus that modal, is picking
 * (or creating) the project first — same shape as `TemplateSessionInstallDialog`
 * in `components/use-cases`, not shared with it because that dialog's copy is
 * use-case-specific and it resolves a template slug through a different path.
 *
 * Once a project is picked, it is the exact same call
 * (`createMarketplaceInstallSession`) the in-project modal makes, so the two
 * surfaces can never install a template two different ways.
 */
export function PublicTemplateInstallDialog({
  template,
  open,
  onOpenChange,
}: {
  template: MarketplaceTemplate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { Icon, color, bgColor } = templateVisual(template.slug);

  const [error, setError] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState('');
  const [opening, setOpening] = useState(false);

  const { projects, projectsQuery, pickedProjectId, setPickedProjectId } = useProjectPicker({
    open,
  });
  const activeProjects = projects.filter((p) => p.status === 'active');
  // No project yet — default straight to "new project" rather than an
  // unusable empty select, mirroring `TemplateSessionInstallDialog`.
  const target =
    pickedProjectId || (projectsQuery.isSuccess && activeProjects.length === 0 ? NEW_PROJECT : '');

  useEffect(() => {
    if (!open) return;
    setError(null);
    setOpening(false);
    setNewProjectName(template.title);
  }, [open, template.title]);

  async function install() {
    setOpening(true);
    setError(null);
    try {
      let projectId = target;
      if (target === NEW_PROJECT) {
        const accounts = await listAccounts();
        const account = accounts.find((a) => a.is_primary_owner) ?? accounts[0];
        if (!account) throw new Error('No account available to create a project in');
        const project = await provisionProject({
          account_id: account.account_id,
          name: newProjectName.trim() || template.title,
          starter_template: 'general-knowledge-worker',
        });
        queryClient.invalidateQueries({ queryKey: qk.projects.scope() });
        projectId = project.project_id;
      }
      const { session_id } = await createMarketplaceInstallSession(projectId, template.slug);
      // Same helper every other install/uninstall call site uses — warms the
      // route and the session's start payload before navigating.
      const href = prepareInstallSessionNavigation(queryClient, router, projectId, session_id);
      onOpenChange(false);
      if (href) router.push(href);
    } catch (e) {
      setError(
        isManagedGitUnavailableError(e)
          ? "Managed git isn't set up on this server — an admin needs to connect GitHub in Git settings before projects can be created."
          : (e as Error).message || 'Could not start the install session',
      );
      setOpening(false);
    }
  }

  const confirmDisabled =
    opening || !target || (target === NEW_PROJECT && newProjectName.trim().length === 0);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-md" aria-label={`Install ${template.title}`}>
        <ModalHeader>
          <div className="flex items-center gap-3">
            <span
              className={cn(
                'border-border flex size-10 shrink-0 items-center justify-center rounded-md border shadow-2xs',
                bgColor,
                color,
              )}
            >
              <Icon weight="fill" className="size-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <ModalTitle>{template.title}</ModalTitle>
              <ModalDescription>Pick a project to install into.</ModalDescription>
            </div>
          </div>
        </ModalHeader>
        <ModalBody className="space-y-3">
          {error && <p className="text-destructive text-sm">{error}</p>}

          {projectsQuery.isPending ? (
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loading className="size-4" /> Loading your projects…
            </div>
          ) : projectsQuery.isError ? (
            <div className="border-border/60 bg-muted/30 rounded-md border px-4 py-4">
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
            <>
              <div className="space-y-1.5">
                <Label className="text-sm">Install into</Label>
                <Select value={target} onValueChange={setPickedProjectId}>
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
                  <Label className="text-sm" htmlFor="template-new-project-name">
                    Project name
                  </Label>
                  <Input
                    id="template-new-project-name"
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    placeholder="My project"
                    autoFocus
                  />
                </div>
              )}
            </>
          )}
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <span className="text-muted-foreground text-xs">
            Install opens a change request you review.
          </span>
          <Button onClick={install} disabled={confirmDisabled}>
            {opening ? <Loading className="size-4 shrink-0" /> : null}
            {opening
              ? target === NEW_PROJECT
                ? 'Creating project…'
                : 'Starting'
              : target === NEW_PROJECT
                ? 'Create project & install'
                : 'Install'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
