'use client';

import { type FormEvent, type ReactNode, useState } from 'react';

import { spaceTabKey, spaceTabs, type ManifestSpace, type SpaceTab } from '@kortix/sdk';
import { useArtifacts, useFeatureFlag, useProjectApps } from '@kortix/sdk/react';
import {
  AppWindowIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  FileTextIcon,
  FolderSimpleIcon,
  LinkSimpleIcon,
  PencilSimpleIcon,
  SquaresFourIcon,
  StackSimpleIcon,
  TargetIcon,
  XIcon,
} from '@phosphor-icons/react';

import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
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
import { Switch } from '../../primitives/switch';
import { errorToast, successToast } from '../../primitives/toast';
import { useTabLabel } from './space-tab-panels';
import { appendSpaceTab, setSpaceTabs } from './space-templates';
import { useManifestWrite } from './use-space-manifest';

type Ask = 'link' | 'files' | 'edit' | null;

const VIEW_ICON = {
  goals: <TargetIcon />,
  apps: <AppWindowIcon />,
  artifacts: <FileTextIcon />,
} as const;

/**
 * The "+" beside a space's tabs: add a view (Goals, Apps, Artifacts, a
 * folder), pin an App or an Artifact, add a link or a board, or edit the tabs.
 * Every choice is one commit to `spaces.<slug>.tabs` in `kortix.yaml`.
 */
export function SpaceTabMenu({
  projectId,
  space,
  onAdded,
  children,
}: {
  projectId: string;
  space: ManifestSpace;
  /** Called with the new tab's key, to open it. */
  onAdded: (key: string) => void;
  children: ReactNode;
}) {
  const t = useTranslations('spaces');
  const write = useManifestWrite(projectId);
  const goalsOn = useFeatureFlag(projectId, 'goals').enabled;
  const artifactsOn = useFeatureFlag(projectId, 'artifacts').enabled;
  const apps = useProjectApps(projectId);
  const artifacts = useArtifacts(artifactsOn ? projectId : null, { limit: 20 });
  const [ask, setAsk] = useState<Ask>(null);
  const current = spaceTabs(space);
  const has = (type: SpaceTab['type']) => current.some((tab) => tab.type === type);

  const add = async (tab: SpaceTab) => {
    try {
      await write((yaml) => appendSpaceTab(yaml, space.name, tab));
      successToast(t('tabAdded'));
      onAdded(spaceTabKey(tab, current.length));
    } catch (error) {
      errorToast(t('saveError'), { description: error instanceof Error ? error.message : undefined });
      throw error;
    }
  };
  // A menu item that opens a modal lets the menu close first.
  const open = (next: Ask) => requestAnimationFrame(() => setAsk(next));
  const views = (['goals', 'apps', 'artifacts'] as const).filter(
    (type) => !has(type) && (type !== 'goals' || goalsOn) && (type !== 'artifacts' || artifactsOn),
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <SquaresFourIcon />
              {t('menu.view')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-48">
              {views.map((type) => (
                <DropdownMenuItem key={type} onSelect={() => void add({ type }).catch(() => {})}>
                  {VIEW_ICON[type]}
                  {t(`tabs.${type}`)}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem onSelect={() => open('files')}>
                <FolderSimpleIcon />
                {t('menu.folder')}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <AppWindowIcon />
              {t('menu.app')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
              {(apps.data ?? []).length === 0 ? (
                <DropdownMenuItem disabled>{t('menu.noApps')}</DropdownMenuItem>
              ) : (
                (apps.data ?? []).map((app) => (
                  <DropdownMenuItem
                    key={app.app_id}
                    onSelect={() => void add({ type: 'app', app: app.slug, label: app.name }).catch(() => {})}
                  >
                    <span className="truncate">{app.name}</span>
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {artifactsOn ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <FileTextIcon />
                {t('menu.artifact')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
                {(artifacts.data ?? []).length === 0 ? (
                  <DropdownMenuItem disabled>{t('menu.noArtifacts')}</DropdownMenuItem>
                ) : (
                  (artifacts.data ?? []).map((artifact) => (
                    <DropdownMenuItem
                      key={artifact.artifact_id}
                      onSelect={() =>
                        void add({ type: 'artifact', artifact: artifact.artifact_id, label: artifact.title }).catch(() => {})
                      }
                    >
                      <span className="truncate">{artifact.title}</span>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
          <DropdownMenuItem onSelect={() => open('link')}>
            <LinkSimpleIcon />
            {t('menu.link')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void add({ type: 'board', label: t('tabs.board'), blocks: [] }).catch(() => {})}>
            <StackSimpleIcon />
            {t('menu.board')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => open('edit')}>
            <PencilSimpleIcon />
            {t('menu.editTabs')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <TargetModal kind={ask === 'link' || ask === 'files' ? ask : null} onClose={() => setAsk(null)} onAdd={add} />
      {/* Keyed on open: every open starts from the tabs as they are now. */}
      <EditTabsModal
        key={ask === 'edit' ? 'open' : 'closed'}
        open={ask === 'edit'}
        onOpenChange={(next) => setAsk(next ? 'edit' : null)}
        tabs={[...current]}
        onSave={async (tabs) => {
          await write((yaml) => setSpaceTabs(yaml, space.name, tabs));
        }}
      />
    </>
  );
}

/** Ask for a link's url (and whether to embed it) or a folder's path. */
function TargetModal({
  kind,
  onClose,
  onAdd,
}: {
  kind: 'link' | 'files' | null;
  onClose: () => void;
  onAdd: (tab: SpaceTab) => Promise<void>;
}) {
  const t = useTranslations('spaces');
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const [embed, setEmbed] = useState(false);
  const [pending, setPending] = useState(false);
  const isLink = kind === 'link';
  const trimmed = value.trim();
  const valid = isLink ? /^https?:\/\/\S+$/i.test(trimmed) : trimmed.length > 0;

  const reset = () => {
    setValue('');
    setLabel('');
    setEmbed(false);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || pending) return;
    setPending(true);
    try {
      await onAdd(
        isLink
          ? { type: 'link', url: trimmed, ...(label.trim() ? { label: label.trim() } : {}), ...(embed ? { embed: true } : {}) }
          : { type: 'files', path: trimmed.replace(/^\/+|\/+$/g, ''), ...(label.trim() ? { label: label.trim() } : {}) },
      );
      reset();
      onClose();
    } catch {
      // The toast already said what failed; the dialog stays open to retry.
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal open={kind !== null} onOpenChange={(next) => (next ? null : onClose())}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{isLink ? t('add.linkTitle') : t('add.folderTitle')}</ModalTitle>
          <ModalDescription>{isLink ? t('add.linkHint') : t('add.folderHint')}</ModalDescription>
        </ModalHeader>
        <form onSubmit={submit}>
          <ModalBody className="space-y-4">
            <Field>
              <FieldLabel htmlFor="space-tab-target">{isLink ? t('add.url') : t('add.path')}</FieldLabel>
              <Input
                id="space-tab-target"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={isLink ? 'https://' : 'docs'}
                className={isLink ? undefined : 'font-mono'}
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="space-tab-label">{t('add.label')}</FieldLabel>
              <Input id="space-tab-label" value={label} onChange={(event) => setLabel(event.target.value)} />
            </Field>
            {isLink ? (
              <label htmlFor="space-tab-embed" className="flex items-center justify-between gap-3">
                <span className="text-foreground text-sm">{t('add.embed')}</span>
                <Switch id="space-tab-embed" checked={embed} onCheckedChange={setEmbed} />
              </label>
            ) : null}
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button type="button" variant="outline-ghost" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={!valid || pending} aria-busy={pending || undefined}>
              {t('add.submit')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}

/** Rename, reorder and remove a space's tabs. The room is not listed: it is always first. */
function EditTabsModal({
  open,
  onOpenChange,
  tabs,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tabs: SpaceTab[];
  onSave: (tabs: SpaceTab[]) => Promise<void>;
}) {
  const t = useTranslations('spaces');
  const [draft, setDraft] = useState<SpaceTab[]>(tabs);
  const [pending, setPending] = useState(false);
  const move = (from: number, to: number) =>
    setDraft((list) => {
      const next = [...list];
      const [tab] = next.splice(from, 1);
      next.splice(to, 0, tab!);
      return next;
    });
  const save = async () => {
    setPending(true);
    try {
      await onSave(
        draft.map((tab) => {
          const { label, ...rest } = tab;
          return label?.trim() ? { ...rest, label: label.trim() } : rest;
        }),
      );
      successToast(t('tabsSaved'));
      onOpenChange(false);
    } catch (error) {
      errorToast(t('saveError'), { description: error instanceof Error ? error.message : undefined });
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{t('edit.title')}</ModalTitle>
          <ModalDescription>{t('edit.description')}</ModalDescription>
        </ModalHeader>
        <ModalBody>
          {draft.length === 0 ? (
            <p className="text-muted-foreground py-4 text-sm">{t('edit.empty')}</p>
          ) : (
            <ul className="divide-border flex flex-col divide-y">
              {draft.map((tab, index) => (
                <EditRow
                  key={`${spaceTabKey(tab, index)}-${index}`}
                  tab={tab}
                  first={index === 0}
                  last={index === draft.length - 1}
                  onLabel={(label) => setDraft((list) => list.map((item, i) => (i === index ? { ...item, label } : item)))}
                  onUp={() => move(index, index - 1)}
                  onDown={() => move(index, index + 1)}
                  onRemove={() => setDraft((list) => list.filter((_, i) => i !== index))}
                />
              ))}
            </ul>
          )}
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button type="button" variant="outline-ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button type="button" onClick={save} disabled={pending} aria-busy={pending || undefined}>
            {t('edit.save')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function EditRow({
  tab,
  first,
  last,
  onLabel,
  onUp,
  onDown,
  onRemove,
}: {
  tab: SpaceTab;
  first: boolean;
  last: boolean;
  onLabel: (label: string) => void;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
}) {
  const t = useTranslations('spaces');
  const name = useTabLabel({ ...tab, label: undefined });
  const shown = tab.label?.trim() || name;
  return (
    <li className="flex items-center gap-2 py-2">
      <span className="text-muted-foreground w-20 shrink-0 truncate text-xs">{t(`tabs.${tab.type}`)}</span>
      <Input
        aria-label={t('edit.rename', { name: shown })}
        value={tab.label ?? ''}
        placeholder={name}
        onChange={(event) => onLabel(event.target.value)}
        className="h-8 min-w-0 flex-1"
      />
      <Button size="icon-sm" variant="ghost" disabled={first} onClick={onUp} aria-label={t('edit.moveUp', { name: shown })}>
        <ArrowUpIcon />
      </Button>
      <Button size="icon-sm" variant="ghost" disabled={last} onClick={onDown} aria-label={t('edit.moveDown', { name: shown })}>
        <ArrowDownIcon />
      </Button>
      <Button size="icon-sm" variant="ghost" onClick={onRemove} aria-label={t('edit.remove', { name: shown })}>
        <XIcon />
      </Button>
    </li>
  );
}
