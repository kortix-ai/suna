'use client';

import { type FormEvent, useState } from 'react';

import { CaretRightIcon, PlusIcon, StackSimpleIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';

import { agentsInSpace, listSpaces, readProjectFile, writeProjectFile } from '@kortix/sdk';
import { qk, useProjectConfig } from '@kortix/sdk/react';

import { customizePath, uiRoutes } from '../../lib/routes';
import { cn } from '../../lib/utils';
import { useUiPathname, useUiRouter, useUiSearchParams } from '../../providers/ui-provider';
import { Button } from '../../primitives/button';
import { Field, FieldLabel } from '../../primitives/field';
import { Input } from '../../primitives/input';
import Loading from '../../primitives/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '../../primitives/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../primitives/select';
import {
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '../../primitives/sidebar';
import { errorToast, successToast } from '../../primitives/toast';
import { useActiveDomain } from '../../internal/stores/active-domain-store';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import {
  addSpaceToManifest,
  slugifySpace,
  spaceBlocks,
  SPACE_TEMPLATES,
} from '../space/space-templates';

const MANIFEST_PATH = 'kortix.yaml';

/**
 * Spaces — a collapsible section in the project sidebar that lists the project's
 * domains as spaces. Selecting one sets the active space (`active-domain-store`);
 * the whole workspace then scopes to it: which agents you can start, the
 * sessions you see, and Customize. `All spaces` clears the scope. A project with
 * no spaces still shows the section header so the user can create the first one,
 * unless they lack write access, in which case it renders nothing.
 */
export function ProjectSpacesNav({ projectId }: { projectId: string }) {
  const config = useProjectConfig(projectId);
  const [active, setActive] = useActiveDomain(projectId);
  const router = useUiRouter();
  const pathname = useUiPathname();
  const spaceParam = useUiSearchParams().get('space');
  // Pages that read the active space (Customize, Goals, Artifacts) stay put
  // and rescope; from any other page, choosing a space opens its home.
  const here = pathname.replace(/\/$/, '');
  const routes = uiRoutes();
  const under = (root: string | null) => !!root && (here === root || here.startsWith(`${root}/`));
  const readsActiveSpace =
    here === routes.project(projectId).replace(/\/$/, '') ||
    [customizePath(projectId), routes.goals(projectId), routes.artifacts(projectId)].some(under);
  const [open, setOpen] = useState(true);
  const [creating, setCreating] = useState(false);
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_FILE_WRITE).allowed === true;

  // Declared spaces (an empty one included) plus the ones agents reference:
  // a space someone just created, before any agent joins it, is listed.
  const agents = config?.agents ?? [];
  const spaces = listSpaces(config);
  const select = (slug: string | null) => {
    setActive(slug);
    // The space home is the project home with the space active.
    if (!readsActiveSpace) router.push(routes.project(projectId));
    // A list page's ?space= wins over the active space: drop it.
    else if (spaceParam) router.replace(pathname);
  };

  // Nothing to show and nothing to do: keep a plain project unchanged.
  if (spaces.length === 0 && !canWrite) return null;

  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="group/menu-button text-sidebar-foreground"
        >
          <span className="shrink-0">
            <StackSimpleIcon />
          </span>
          <span className="truncate">Spaces</span>
          <CaretRightIcon
            weight="bold"
            className={cn(
              'text-muted-foreground ml-auto size-3.5 shrink-0 transition-transform',
              open && 'rotate-90',
            )}
          />
        </SidebarMenuButton>
      </SidebarMenuItem>
      {open ? (
        <SidebarMenuSub>
          {spaces.length > 0 ? (
            <SpaceRow
              label="All spaces"
              selected={active === null}
              onSelect={() => select(null)}
            />
          ) : null}
          {spaces.map((space) => (
            <SpaceRow
              key={space.name}
              label={space.label || space.name}
              count={agentsInSpace(space.name, agents).length}
              selected={active === space.name}
              onSelect={() => select(space.name)}
            />
          ))}
          {canWrite ? (
            <SidebarMenuSubItem>
              <SidebarMenuSubButton asChild>
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="text-muted-foreground"
                >
                  <PlusIcon className="size-3.5 shrink-0" />
                  <span className="truncate">New space</span>
                </button>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ) : null}
        </SidebarMenuSub>
      ) : null}
      {canWrite ? (
        <NewSpaceModal projectId={projectId} open={creating} onOpenChange={setCreating} />
      ) : null}
    </>
  );
}

function SpaceRow({
  label,
  count,
  selected,
  onSelect,
}: {
  label: string;
  count?: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={selected}>
        <button type="button" onClick={onSelect}>
          <span className="truncate">{label}</span>
          {count !== undefined ? (
            <span className="text-muted-foreground ml-auto tabular-nums">{count}</span>
          ) : null}
        </button>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

/** Create a new Space: a name + a template preset, written as `domains.<slug>`
 *  into `kortix.yaml`. */
function NewSpaceModal({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState(SPACE_TEMPLATES[0]!.id);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || pending) return;

    const template = SPACE_TEMPLATES.find((t) => t.id === templateId) ?? SPACE_TEMPLATES[0]!;
    const slug = slugifySpace(trimmed);
    setPending(true);
    try {
      const file = await readProjectFile(projectId, MANIFEST_PATH, 'main');
      if (!file.revision) throw new Error('Could not read the project manifest.');
      const content = addSpaceToManifest(file.content, {
        slug,
        label: trimmed,
        blocks: spaceBlocks(template, slug),
      });
      await writeProjectFile(projectId, {
        path: MANIFEST_PATH,
        ref: 'main',
        content,
        expected_revision: file.revision,
      });
      await queryClient.invalidateQueries({ queryKey: qk.project.detail(projectId) });
      successToast(`Space “${trimmed}” created.`);
      setName('');
      setTemplateId(SPACE_TEMPLATES[0]!.id);
      onOpenChange(false);
    } catch (error) {
      errorToast(error instanceof Error ? error.message : 'Could not create the space.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>New space</ModalTitle>
          <ModalDescription>
            A space groups agents, sessions and a layout under one name.
          </ModalDescription>
        </ModalHeader>
        <form onSubmit={handleSubmit}>
          <ModalBody>
            <Field>
              <FieldLabel htmlFor="space-name">Name</FieldLabel>
              <Input
                id="space-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Sales"
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="space-template">Template</FieldLabel>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger id="space-template" className="w-full cursor-pointer text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SPACE_TEMPLATES.map((template) => (
                    <SelectItem key={template.id} value={template.id} className="cursor-pointer">
                      <span className="flex flex-col">
                        <span>{template.label}</span>
                        <span className="text-muted-foreground text-xs">{template.description}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button type="button" variant="outline-ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? <Loading className="size-4 shrink-0" /> : null}
              Create space
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
