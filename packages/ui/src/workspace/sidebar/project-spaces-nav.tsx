'use client';

import { type FormEvent, useState } from 'react';

import { CaretRightIcon, HashIcon, PlusIcon, StackSimpleIcon } from '@phosphor-icons/react';

import { listSpaces } from '@kortix/sdk';
import { useFeatureFlag, useProjectConfig, useRoomConversations } from '@kortix/sdk/react';

import { useTranslations } from '../../i18n';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { useActiveSpace } from '../../internal/stores/active-space-store';
import { uiRoutes } from '../../lib/routes';
import { cn } from '../../lib/utils';
import { UiLink as Link, useUiPathname, useUiRouter } from '../../providers/ui-provider';
import { Button } from '../../primitives/button';
import { CountBadge } from '../../primitives/count-badge';
import { Field, FieldLabel } from '../../primitives/field';
import { Input } from '../../primitives/input';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '../../primitives/modal';
import { RadioGroup, RadioGroupItem } from '../../primitives/radio-group';
import {
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '../../primitives/sidebar';
import { Textarea } from '../../primitives/textarea';
import { errorToast, successToast } from '../../primitives/toast';
import { addSpaceToManifest, slugifySpace, SPACE_TEMPLATES } from '../space/space-templates';
import { useManifestWrite } from '../space/use-space-manifest';

/**
 * Spaces in the project sidebar, listed like channels: `# name` and the unread
 * count of the space's room. A declared space with no agents is listed. A row
 * opens the space page and makes the space active, so the project home's
 * composer starts only its agents. A project with no spaces still shows the
 * section to a viewer who may create one, and nothing to anyone else.
 */
export function ProjectSpacesNav({ projectId }: { projectId: string }) {
  const t = useTranslations('spaces');
  const config = useProjectConfig(projectId);
  const [, setActive] = useActiveSpace(projectId);
  const pathname = useUiPathname();
  const roomsOn = useFeatureFlag(projectId, 'agent_rooms').enabled;
  const rooms = useRoomConversations(roomsOn ? projectId : null);
  const [open, setOpen] = useState(true);
  const [creating, setCreating] = useState(false);
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_FILE_WRITE).allowed === true;
  const spaces = listSpaces(config);
  const unread = new Map((rooms.data ?? []).map((room) => [room.name, room.unread]));
  const here = pathname.replace(/\/$/, '');

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
          <span className="truncate">{t('nav.title')}</span>
          <CaretRightIcon
            weight="bold"
            className={cn('text-muted-foreground ml-auto size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
          />
        </SidebarMenuButton>
      </SidebarMenuItem>
      {open ? (
        <SidebarMenuSub>
          {spaces.map((space) => {
            const href = uiRoutes().space(projectId, space.name);
            const count = unread.get(space.name) ?? 0;
            return (
              <SidebarMenuSubItem key={space.name}>
                <SidebarMenuSubButton asChild isActive={!!href && here.endsWith(href.replace(/\/$/, ''))}>
                  {href ? (
                    <Link href={href} onClick={() => setActive(space.name)}>
                      <HashIcon className="text-muted-foreground size-3.5 shrink-0" />
                      <span className={cn('truncate', count > 0 && 'text-foreground font-medium')}>
                        {space.label || space.name}
                      </span>
                      {count > 0 ? (
                        <CountBadge count={count} className="ml-auto" aria-label={t('nav.unread', { count })} />
                      ) : null}
                    </Link>
                  ) : (
                    <span>{space.label || space.name}</span>
                  )}
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            );
          })}
          {canWrite ? (
            <SidebarMenuSubItem>
              <SidebarMenuSubButton asChild>
                <button type="button" onClick={() => setCreating(true)} className="text-muted-foreground">
                  <PlusIcon className="size-3.5 shrink-0" />
                  <span className="truncate">{t('nav.new')}</span>
                </button>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ) : null}
        </SidebarMenuSub>
      ) : null}
      {canWrite ? <NewSpaceModal projectId={projectId} open={creating} onOpenChange={setCreating} /> : null}
    </>
  );
}

/** Create a space: a name, a description and the starting tabs, written as
 *  `spaces.<slug>` into `kortix.yaml`. Then open it. */
function NewSpaceModal({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('spaces');
  const write = useManifestWrite(projectId);
  const router = useUiRouter();
  const config = useProjectConfig(projectId);
  const [, setActive] = useActiveSpace(projectId);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [templateId, setTemplateId] = useState<string>(SPACE_TEMPLATES[0]!.id);
  const [pending, setPending] = useState(false);
  const trimmed = name.trim();
  const slug = slugifySpace(trimmed);
  const taken = !!trimmed && listSpaces(config).some((space) => space.name === slug);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!trimmed || taken || pending) return;
    const template = SPACE_TEMPLATES.find((candidate) => candidate.id === templateId) ?? SPACE_TEMPLATES[0]!;
    setPending(true);
    try {
      await write((yaml) => addSpaceToManifest(yaml, { slug, label: trimmed, description, tabs: template.tabs }));
      successToast(t('create.created'));
      setName('');
      setDescription('');
      setTemplateId(SPACE_TEMPLATES[0]!.id);
      onOpenChange(false);
      setActive(slug);
      const href = uiRoutes().space(projectId, slug);
      if (href) router.push(href);
    } catch (error) {
      errorToast(t('create.error'), { description: error instanceof Error ? error.message : undefined });
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{t('create.title')}</ModalTitle>
          <ModalDescription>{t('create.description')}</ModalDescription>
        </ModalHeader>
        <form onSubmit={handleSubmit}>
          <ModalBody className="space-y-4">
            <Field>
              <FieldLabel htmlFor="space-name">{t('create.name')}</FieldLabel>
              <Input
                id="space-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('create.namePlaceholder')}
                aria-invalid={taken || undefined}
                autoFocus
              />
              {trimmed ? (
                <p className="text-muted-foreground text-xs">
                  {taken ? t('create.taken', { slug }) : <span className="font-mono">#{slug}</span>}
                </p>
              ) : null}
            </Field>
            <Field>
              <FieldLabel htmlFor="space-description">{t('create.about')}</FieldLabel>
              <Textarea
                id="space-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t('create.aboutPlaceholder')}
                rows={2}
              />
            </Field>
            <Field>
              <FieldLabel>{t('create.template')}</FieldLabel>
              <RadioGroup value={templateId} onValueChange={setTemplateId} className="gap-0">
                {SPACE_TEMPLATES.map((template) => (
                  <label
                    key={template.id}
                    htmlFor={`space-template-${template.id}`}
                    className="hover:bg-hover flex cursor-pointer items-start gap-3 rounded-md px-2 py-2 transition-colors"
                  >
                    <RadioGroupItem id={`space-template-${template.id}`} value={template.id} className="mt-0.5" />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-foreground text-sm">{t(`templates.${template.id}.label`)}</span>
                      <span className="text-muted-foreground text-xs">{t(`templates.${template.id}.description`)}</span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </Field>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button type="button" variant="outline-ghost" onClick={() => onOpenChange(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={pending || !trimmed || taken} aria-busy={pending || undefined}>
              {t('create.submit')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
