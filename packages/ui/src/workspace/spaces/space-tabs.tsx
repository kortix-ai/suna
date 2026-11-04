'use client';

import type { ProjectSpace, ProjectSpaceTab, ProjectSpaceTabKind } from '@kortix/sdk';
import { useArtifacts, useFeatureFlag, useProjectApps, useSetProjectSpaceTabs } from '@kortix/sdk/react';
import { spaceDriveFolders } from '@kortix/shared';
import {
  AppWindowIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowSquareOutIcon,
  BrainIcon,
  CaretDownIcon,
  FileTextIcon,
  FolderSimpleIcon,
  type Icon,
  LinkSimpleIcon,
  ListBulletsIcon,
  PencilSimpleIcon,
  PlusIcon,
  XIcon,
} from '@phosphor-icons/react';
import { type FormEvent, type ReactNode, useState } from 'react';

import { framePolicy } from '../../files/viewer/preview-policy';
import { useProjectDrive } from '../../files/drives/use-drives';
import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../../primitives/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import { EmptyArt } from '../../primitives/empty-art';
import { EmptyState } from '../../primitives/empty-state';
import { Field, FieldLabel } from '../../primitives/field';
import Hint from '../../primitives/hint';
import { Input } from '../../primitives/input';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '../../primitives/modal';
import { TabsTrigger } from '../../primitives/tabs';
import { errorToast, successToast } from '../../primitives/toast';
import { MemoryView } from '../memory/memory-view';
import { AppTab, ArtifactTab } from '../space/space-tab-panels';
import {
  SPACE_TABS_MAX,
  appendTab,
  folderTitle,
  isLinkUrl,
  linkTitle,
  moveTab,
  newTabId,
  normalizeFolderPath,
  removeTab,
  renameTab,
  tabTitle,
} from './space-tab-list';

/** The glyph of each kind, in the add menu and the empty state of a tab whose target is gone. */
const KIND_ICON: Record<ProjectSpaceTabKind, Icon> = {
  threads: ListBulletsIcon,
  memory: BrainIcon,
  artifact: FileTextIcon,
  app: AppWindowIcon,
  folder: FolderSimpleIcon,
  link: LinkSimpleIcon,
};

/**
 * A space's stored tabs and the one write that replaces them. While a save
 * runs, the tab row shows the list being saved. A person may edit a DM they
 * own (every DM they see) or a channel they may edit (`can_edit`).
 */
export function useSpaceTabs(projectId: string, space: ProjectSpace) {
  const t = useTranslations('spaces.view.tabEdit');
  const mutation = useSetProjectSpaceTabs(projectId);
  const saved = space.tabs ?? [];
  const tabs = mutation.isPending && mutation.variables?.spaceId === space.space_id ? mutation.variables.tabs : saved;
  const canEdit = space.kind === 'dm' || space.can_edit === true;
  const save = (next: ProjectSpaceTab[]) =>
    mutation.mutateAsync({ spaceId: space.space_id, tabs: next }).catch((error: unknown) => {
      errorToast(t('saveError'), { description: error instanceof Error ? error.message : undefined });
      throw error;
    });
  return { tabs, canEdit, save };
}

type SpaceTabsState = ReturnType<typeof useSpaceTabs>;

/**
 * One stored tab in the tab row. A right click opens its menu; the open tab
 * also shows a caret that opens the same menu: Rename, Move left, Move right,
 * Remove. Removing offers Undo.
 */
export function StoredTabTrigger({
  tab,
  index,
  active,
  state,
}: {
  tab: ProjectSpaceTab;
  index: number;
  active: boolean;
  state: SpaceTabsState;
}) {
  const t = useTranslations('spaces.view.tabEdit');
  const [renaming, setRenaming] = useState(false);
  const { tabs, canEdit, save } = state;
  const remove = () => {
    const before = tabs;
    void save(removeTab(tabs, tab.id))
      .then(() =>
        successToast(t('removed', { name: tab.title }), {
          button: (
            <Button size="xs" variant="outline" onClick={() => void save(before).catch(() => undefined)}>
              {t('undo')}
            </Button>
          ),
        }),
      )
      .catch(() => undefined);
  };
  const actions = (Item: typeof DropdownMenuItem | typeof ContextMenuItem, Separator: typeof DropdownMenuSeparator) => (
    <>
      {/* A menu item that opens a modal lets the menu close first. */}
      <Item onSelect={() => requestAnimationFrame(() => setRenaming(true))}>
        <PencilSimpleIcon />
        {t('rename')}
      </Item>
      <Item disabled={index === 0} onSelect={() => void save(moveTab(tabs, tab.id, -1)).catch(() => undefined)}>
        <ArrowLeftIcon />
        {t('moveLeft')}
      </Item>
      <Item disabled={index === tabs.length - 1} onSelect={() => void save(moveTab(tabs, tab.id, 1)).catch(() => undefined)}>
        <ArrowRightIcon />
        {t('moveRight')}
      </Item>
      <Separator />
      <Item onSelect={remove}>
        <XIcon />
        {t('remove')}
      </Item>
    </>
  );
  const trigger = (
    <TabsTrigger value={tab.id} className="w-fit max-w-48 flex-none">
      <span className="truncate">{tab.title}</span>
    </TabsTrigger>
  );
  if (!canEdit) return trigger;
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
        <ContextMenuContent className="w-48">{actions(ContextMenuItem, ContextMenuSeparator)}</ContextMenuContent>
      </ContextMenu>
      {active ? (
        <DropdownMenu>
          <Hint label={t('options', { name: tab.title })} side="bottom">
            <DropdownMenuTrigger asChild>
              <Button size="icon-xs" variant="ghost" aria-label={t('options', { name: tab.title })} className="-ml-3 shrink-0">
                <CaretDownIcon />
              </Button>
            </DropdownMenuTrigger>
          </Hint>
          <DropdownMenuContent align="start" className="w-48">
            {actions(DropdownMenuItem, DropdownMenuSeparator)}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <RenameTabModal
        key={renaming ? 'open' : 'closed'}
        open={renaming}
        title={tab.title}
        onClose={() => setRenaming(false)}
        onSave={(title) => save(renameTab(tabs, tab.id, title))}
      />
    </>
  );
}

/**
 * The "+" at the end of the tab row: add a Threads or Memory tab, an artifact,
 * an App, a folder (the space's own files, or a path) or a link. The new tab
 * opens.
 */
export function AddTabMenu({
  projectId,
  space,
  state,
  onAdded,
}: {
  projectId: string;
  space: ProjectSpace;
  state: SpaceTabsState;
  onAdded: (id: string) => void;
}) {
  const t = useTranslations('spaces.view.tabEdit');
  const artifactsOn = useFeatureFlag(projectId, 'artifacts').enabled;
  const apps = useProjectApps(projectId);
  const artifacts = useArtifacts(artifactsOn ? projectId : null, { limit: 20 });
  const drive = useProjectDrive(projectId);
  const [ask, setAsk] = useState<'folder' | 'link' | null>(null);
  const { tabs, save } = state;
  const full = tabs.length >= SPACE_TABS_MAX;
  const name = space.kind === 'channel' ? space.slug : space.dm_agent_name;
  const ownFolder = name
    ? spaceDriveFolders(space.kind, name, drive.data?.personalFolder ?? null, space.visibility === 'private' ? space.space_id : null)?.files ?? null
    : null;

  const add = async (kind: ProjectSpaceTabKind, title: string, ref?: string) => {
    const tab: ProjectSpaceTab = { id: newTabId(kind, tabs), title: tabTitle(title, t(`kind.${kind}`)), kind, ...(ref ? { ref } : {}) };
    await save(appendTab(tabs, tab));
    onAdded(tab.id);
  };
  const quick = (kind: ProjectSpaceTabKind, title: string, ref?: string) => () => void add(kind, title, ref).catch(() => undefined);
  const open = (next: 'folder' | 'link') => requestAnimationFrame(() => setAsk(next));

  return (
    <>
      <DropdownMenu>
        <Hint label={full ? t('full', { max: SPACE_TABS_MAX }) : t('add')} side="bottom">
          <DropdownMenuTrigger asChild>
            <Button size="icon-xs" variant="ghost" aria-label={t('add')} disabled={full} className="ml-1 shrink-0">
              <PlusIcon />
            </Button>
          </DropdownMenuTrigger>
        </Hint>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem onSelect={quick('threads', t('kind.threads'))}>
            <ListBulletsIcon />
            {t('kind.threads')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={quick('memory', t('kind.memory'))}>
            <BrainIcon />
            {t('kind.memory')}
          </DropdownMenuItem>
          {artifactsOn ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <FileTextIcon />
                {t('kind.artifact')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
                {(artifacts.data ?? []).length === 0 ? (
                  <DropdownMenuItem disabled>{t('noArtifacts')}</DropdownMenuItem>
                ) : (
                  (artifacts.data ?? []).map((artifact) => (
                    <DropdownMenuItem key={artifact.artifact_id} onSelect={quick('artifact', artifact.title, artifact.artifact_id)}>
                      <span className="truncate">{artifact.title}</span>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <AppWindowIcon />
              {t('kind.app')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
              {(apps.data ?? []).length === 0 ? (
                <DropdownMenuItem disabled>{t('noApps')}</DropdownMenuItem>
              ) : (
                (apps.data ?? []).map((app) => (
                  <DropdownMenuItem key={app.app_id} onSelect={quick('app', app.name, app.slug)}>
                    <span className="truncate">{app.name}</span>
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderSimpleIcon />
              {t('kind.folder')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56">
              {ownFolder ? (
                <DropdownMenuItem onSelect={quick('folder', t('spaceFiles'), ownFolder)}>{t('spaceFiles')}</DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={() => open('folder')}>{t('otherFolder')}</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onSelect={() => open('link')}>
            <LinkSimpleIcon />
            {t('linkItem')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <TargetModal
        kind={ask}
        onClose={() => setAsk(null)}
        onAdd={(kind, ref) => add(kind, kind === 'link' ? linkTitle(ref) : folderTitle(ref), ref)}
      />
    </>
  );
}

/** Ask for a folder's Drive path or a link's https URL. */
function TargetModal({
  kind,
  onClose,
  onAdd,
}: {
  kind: 'folder' | 'link' | null;
  onClose: () => void;
  onAdd: (kind: 'folder' | 'link', ref: string) => Promise<void>;
}) {
  const t = useTranslations('spaces.view.tabEdit');
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const isLink = kind === 'link';
  const ref = isLink ? value.trim() : normalizeFolderPath(value);
  const valid = isLink ? isLinkUrl(ref) : ref.length > 0;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!kind || !valid || pending) return;
    setPending(true);
    try {
      await onAdd(kind, ref);
      setValue('');
      onClose();
    } catch {
      // The toast said what failed; the dialog stays open to retry.
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal open={kind !== null} onOpenChange={(next) => (next ? null : onClose())}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{isLink ? t('linkTitle') : t('folderTitle')}</ModalTitle>
          <ModalDescription>{isLink ? t('linkHint') : t('folderHint')}</ModalDescription>
        </ModalHeader>
        <form onSubmit={submit}>
          <ModalBody>
            <Field>
              <FieldLabel htmlFor="space-tab-ref">{isLink ? t('url') : t('path')}</FieldLabel>
              <Input
                id="space-tab-ref"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={isLink ? 'https://' : '/Company'}
                className={isLink ? undefined : 'font-mono'}
                autoFocus
              />
            </Field>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button type="button" variant="outline-ghost" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={!valid || pending} aria-busy={pending || undefined}>
              {t('submit')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}

function RenameTabModal({
  open,
  title,
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  onSave: (title: string) => Promise<unknown>;
}) {
  const t = useTranslations('spaces.view.tabEdit');
  const [value, setValue] = useState(title);
  const [pending, setPending] = useState(false);
  const valid = value.trim().length > 0;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || pending) return;
    setPending(true);
    try {
      await onSave(value);
      onClose();
    } catch {
      // The toast said what failed.
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{t('renameTitle')}</ModalTitle>
        </ModalHeader>
        <form onSubmit={submit}>
          <ModalBody>
            <Field>
              <FieldLabel htmlFor="space-tab-title">{t('name')}</FieldLabel>
              <Input id="space-tab-title" value={value} maxLength={60} onChange={(event) => setValue(event.target.value)} autoFocus />
            </Field>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button type="button" variant="outline-ghost" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={!valid || pending} aria-busy={pending || undefined}>
              {t('save')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}

/**
 * What a stored tab shows, by kind, with the views that already exist:
 * `threads` the space's thread list, `memory` its memory pages, `artifact`
 * the artifact viewer, `app` the live App, `folder` the host's Drive folder
 * view, `link` the page in a sandboxed frame. A target that is gone shows
 * a small empty state with "Remove tab" for a person who may edit.
 */
export function StoredTabPanel({
  projectId,
  space,
  tab,
  place,
  state,
  threads,
  renderFolder,
}: {
  projectId: string;
  space: ProjectSpace;
  tab: ProjectSpaceTab;
  place: string;
  state: SpaceTabsState;
  /** The Threads list, drawn by the view that owns the open thread. */
  threads: ReactNode;
  renderFolder?: (folder: { space: ProjectSpace; tab: 'files'; place: string; path: string; missing: ReactNode }) => ReactNode;
}) {
  const t = useTranslations('spaces.view.tabEdit');
  const removeAction = state.canEdit ? (
    <Button variant="outline" size="sm" onClick={() => void state.save(removeTab(state.tabs, tab.id)).catch(() => undefined)}>
      <XIcon />
      {t('remove')}
    </Button>
  ) : undefined;
  const missing = (
    <EmptyState
      className="min-h-full"
      media={<EmptyArt icon={KIND_ICON[tab.kind]} />}
      title={t('missing.title')}
      description={t('missing.description')}
      action={removeAction}
    />
  );
  const ref = tab.ref ?? '';
  switch (tab.kind) {
    case 'threads':
      return <>{threads}</>;
    case 'memory':
      return <MemoryView projectId={projectId} layerKey={space.space_id} place={place} />;
    case 'artifact':
      return <ArtifactTab projectId={projectId} artifactId={ref} missingAction={removeAction} />;
    case 'app':
      return <AppTab projectId={projectId} slug={ref} missingAction={removeAction} />;
    case 'folder':
      return ref && renderFolder ? <>{renderFolder({ space, tab: 'files', place, path: ref, missing })}</> : missing;
    case 'link':
      return isLinkUrl(ref) ? <LinkFrame url={ref} title={tab.title} /> : missing;
  }
}

/** A link tab: the page in a sandboxed frame, and a way out for a page that refuses to be framed. */
function LinkFrame({ url, title }: { url: string; title: string }) {
  const t = useTranslations('spaces.view.tabEdit');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border flex shrink-0 items-center gap-2 border-b px-5 py-1.5">
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{url}</span>
        <Button asChild size="sm" variant="ghost">
          <a href={url} target="_blank" rel="noopener noreferrer">
            <ArrowSquareOutIcon />
            {t('openLink')}
          </a>
        </Button>
      </div>
      <iframe src={url} title={title} sandbox={framePolicy('app', url).sandbox} className="bg-background min-h-0 w-full flex-1" />
    </div>
  );
}
