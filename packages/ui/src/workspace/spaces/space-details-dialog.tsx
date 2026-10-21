'use client';

import type { ProjectSpace } from '@kortix/sdk';
import { HashIcon, RobotIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { useLocale, useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import { EntityAvatar } from '../../primitives/entity-avatar';
import { Label } from '../../primitives/label';
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from '../../primitives/modal';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../primitives/tabs';
import { UserAvatar } from '../../primitives/user-avatar';
import { participantLabel } from '../../session/participants/session-participants';
import { agentLabel, type SpacePerson } from './space-timeline';

export type SpaceDetailsTab = 'about' | 'members';

/**
 * A channel's details, opened from `# name` in the header: About (name,
 * description, when it was made, Archive) and Members (the people and agents
 * of its loaded threads). Edit opens the rename dialog, which edits both the
 * name and the description.
 */
export function SpaceDetailsDialog({
  space,
  roster,
  tab,
  onTabChange,
  onOpenChange,
  onEdit,
  onArchive,
}: {
  space: ProjectSpace;
  roster: { people: SpacePerson[]; agents: string[] };
  /** Null: closed. */
  tab: SpaceDetailsTab | null;
  onTabChange: (tab: SpaceDetailsTab) => void;
  onOpenChange: (open: boolean) => void;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const t = useTranslations('spaces.details');
  const locale = useLocale();
  const created = new Date(space.created_at).toLocaleDateString(locale, { dateStyle: 'long' });
  const memberCount = roster.people.length + roster.agents.length;
  return (
    <Modal open={tab !== null} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle className="flex min-w-0 items-center gap-1">
            <HashIcon className="size-4 shrink-0" />
            <span className="truncate">{space.slug}</span>
          </ModalTitle>
        </ModalHeader>
        <Tabs value={tab ?? 'about'} onValueChange={(value) => onTabChange(value as SpaceDetailsTab)} className="gap-0">
          <TabsList type="underline" size="sm" className="w-full shrink-0 justify-start gap-4 px-5">
            <TabsTrigger value="about" className="w-fit flex-none">
              {t('about')}
            </TabsTrigger>
            <TabsTrigger value="members" className="w-fit flex-none gap-1.5">
              {t('members')}
              <span className="text-muted-foreground tabular-nums">{memberCount}</span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="about">
            <ModalBody className="pt-2">
              <dl className="divide-border divide-y">
                <DetailRow label={t('name')} action={<EditButton field={t('name')} onClick={onEdit} />}>
                  #{space.slug}
                </DetailRow>
                <DetailRow
                  label={t('description')}
                  action={<EditButton field={t('description')} onClick={onEdit} />}
                >
                  {space.description || <span className="text-muted-foreground">{t('noDescription')}</span>}
                </DetailRow>
                <DetailRow label={t('created')}>{created}</DetailRow>
              </dl>
              {space.is_default ? null : (
                <div className="flex items-center justify-between gap-4 border-t pt-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{t('archiveTitle')}</p>
                    <p className="text-muted-foreground text-xs text-pretty">{t('archiveHint')}</p>
                  </div>
                  <Button variant="destructive" size="sm" onClick={onArchive}>
                    {t('archive')}
                  </Button>
                </div>
              )}
            </ModalBody>
          </TabsContent>
          <TabsContent value="members">
            <ModalBody className="space-y-5 pt-4">
              {roster.people.length > 0 ? (
                <section className="space-y-2">
                  <Label>{t('people')}</Label>
                  <ul>
                    {roster.people.map((person) => {
                      const name = participantLabel(person);
                      return (
                        <li key={person.id} className="flex min-h-10 items-center gap-2.5">
                          <UserAvatar email={person.email ?? ''} name={name} avatarUrl={person.avatarUrl} size="md" />
                          <span className="truncate text-sm">{name}</span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null}
              {roster.agents.length > 0 ? (
                <section className="space-y-2">
                  <Label>{t('agents')}</Label>
                  <ul>
                    {roster.agents.map((agent) => (
                      <li key={agent} className="flex min-h-10 items-center gap-2.5">
                        <EntityAvatar icon={RobotIcon} label={agentLabel(agent)} size="md" />
                        <span className="truncate text-sm">{agentLabel(agent)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <p className="text-muted-foreground text-xs text-pretty">{t('membersHint')}</p>
            </ModalBody>
          </TabsContent>
        </Tabs>
      </ModalContent>
    </Modal>
  );
}

function DetailRow({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0 space-y-0.5">
        <dt className="text-sm font-medium">{label}</dt>
        <dd className="text-sm text-pretty wrap-anywhere">{children}</dd>
      </div>
      {action}
    </div>
  );
}

/** "Edit", named for the row it edits: a screen reader has no row. */
function EditButton({ field, onClick }: { field: string; onClick: () => void }) {
  const t = useTranslations('spaces.details');
  return (
    <Button
      variant="blue-ghost"
      size="sm"
      className="shrink-0"
      aria-label={t('editField', { field })}
      onClick={onClick}
    >
      {t('edit')}
    </Button>
  );
}
