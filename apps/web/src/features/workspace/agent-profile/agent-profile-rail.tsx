'use client';

import type { AgentProfile, AgentProfileSection } from '@kortix/sdk';
import { useAgentProfile, useAgentProfileMutations, useVisibleAgents } from '@kortix/sdk/react';
import {
  BookOpenTextIcon,
  CalendarDotsIcon,
  CaretRightIcon,
  NotePencilIcon,
  PlugsConnectedIcon,
  RobotIcon,
  SlidersHorizontalIcon,
  TrashIcon,
  UsersThreeIcon,
  WrenchIcon,
} from '@phosphor-icons/react';
import { useEffect, useState, type ComponentType } from 'react';

import { Avatar, AvatarFallback, AvatarGroup, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { errorToast, successToast } from '@/components/ui/toast';
import { useMediaQuery } from '@/hooks/utils/use-media-query';
import { useCustomizeStore } from '@/stores/customize-store';

import { AgentProfileAutomationsDialog } from './agent-profile-automations-dialog';
import {
  AdvancedDialog,
  InstructionsDialog,
  IntegrationsDialog,
} from './agent-profile-capability-dialogs';
import { AgentProfileKnowledgeDialog } from './agent-profile-knowledge-dialog';
import { AgentProfileReviewDialog, AgentProfileTestDialog } from './agent-profile-review-dialog';
import { AgentProfileSkillsDialog } from './agent-profile-skills-dialog';
import {
  activeProfileSections,
  indexedKnowledgeSourceCount,
  profileDraftCount,
} from './agent-profile-utils';

type DialogName = AgentProfileSection | 'review' | 'test' | null;

interface AgentProfileRailProps {
  projectId: string;
  enabled: boolean;
}

interface SectionDefinition {
  id: AgentProfileSection;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

const SECTIONS: SectionDefinition[] = [
  { id: 'instructions', label: 'Instructions', icon: NotePencilIcon },
  { id: 'integrations', label: 'Integrations', icon: PlugsConnectedIcon },
  { id: 'knowledge', label: 'Knowledge', icon: BookOpenTextIcon },
  { id: 'skills', label: 'Skills', icon: WrenchIcon },
  { id: 'automations', label: 'Automations', icon: CalendarDotsIcon },
  { id: 'advanced', label: 'Advanced', icon: SlidersHorizontalIcon },
];

function summaryFor(profile: AgentProfile, section: AgentProfileSection): string {
  const sections = activeProfileSections(profile);
  if (section === 'instructions') {
    return sections.instructions?.prompt?.trim() || 'Add agent instructions';
  }
  if (section === 'integrations') {
    const count = sections.integrations?.length ?? 0;
    const pending =
      sections.integrations?.filter((item) => item.status === 'pending_publication').length ?? 0;
    return count === 0
      ? 'No integrations'
      : `${count} integration${count === 1 ? '' : 's'}${pending ? ` · ${pending} draft` : ''}`;
  }
  if (section === 'knowledge') {
    const count = profile.knowledge_sources.length;
    const indexed = indexedKnowledgeSourceCount(profile.knowledge_sources);
    return count === 0
      ? 'No private sources'
      : `${count} private source${count === 1 ? '' : 's'} · ${indexed} indexed`;
  }
  if (section === 'skills') {
    const count = sections.skills?.length ?? 0;
    return count === 0 ? 'No skills' : `${count} skill${count === 1 ? '' : 's'}`;
  }
  if (section === 'automations') {
    const count = sections.automations?.length ?? 0;
    const active = sections.automations?.filter((item) => item.enabled).length ?? 0;
    return count === 0 ? 'No scheduled tasks' : `${active} active · ${count} total`;
  }
  const workspace = sections.advanced?.workspace ?? 'runtime';
  const model = sections.instructions?.model;
  return model ? `${model} · ${workspace} workspace` : `${workspace} workspace`;
}

function initials(name: string | null, fallback: string): string {
  const parts = (name || fallback).trim().split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

function ProfilePanel({
  projectId,
  onRequestClose,
}: {
  projectId: string;
  onRequestClose?: () => void;
}) {
  const agents = useVisibleAgents({ projectId });
  const [agentName, setAgentName] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const openCustomize = useCustomizeStore((state) => state.openCustomize);

  useEffect(() => {
    if (agents.length === 0) return;
    if (agentName && agents.some((agent) => agent.name === agentName)) return;
    setAgentName(agents[0]?.name ?? null);
  }, [agentName, agents]);

  const profileQuery = useAgentProfile(projectId, agentName);
  const mutations = useAgentProfileMutations(projectId, agentName);
  const profile = profileQuery.data;
  const activeEditors = profile?.draft?.active_editors ?? [];
  const onConflict = () => void profileQuery.refetch();

  const discard = async () => {
    if (!profile?.draft) return;
    try {
      await mutations.discard.mutateAsync({ expectedRevision: profile.draft.revision });
      successToast('Agent profile draft discarded');
      setDiscardOpen(false);
    } catch (error) {
      onConflict();
      errorToast(error instanceof Error ? error.message : 'Draft could not be discarded');
    }
  };

  const statusLabel = profile
    ? profile.status === 'publishing'
      ? 'In review'
      : profile.draft
        ? 'Draft'
        : 'Published'
    : 'Loading';

  return (
    <div
      className="bg-background flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="agent-profile-panel"
    >
      <header className="border-border shrink-0 border-b px-4 py-3">
        <div className="flex items-center gap-2 pr-8">
          <span className="bg-foreground text-background inline-flex size-8 shrink-0 items-center justify-center rounded-sm">
            <RobotIcon className="size-4" />
          </span>
          <Select value={agentName ?? ''} onValueChange={setAgentName}>
            <SelectTrigger
              aria-label="Agent profile"
              className="h-8 min-w-0 flex-1 border-0 bg-transparent px-1 shadow-none"
            >
              <SelectValue placeholder="Select an agent" />
            </SelectTrigger>
            <SelectContent>
              {agents.map((agent) => (
                <SelectItem key={agent.name} value={agent.name}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {profile?.draft ? (
            <Hint label="Discard draft">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Discard profile draft"
                onClick={() => setDiscardOpen(true)}
              >
                <TrashIcon className="size-3.5" />
              </Button>
            </Hint>
          ) : null}
        </div>

        <div className="mt-2 flex min-h-6 items-center gap-2">
          <Badge
            size="xs"
            variant={
              profile?.status === 'publishing' ? 'info' : profile?.draft ? 'warning' : 'success'
            }
          >
            {statusLabel}
          </Badge>
          {profile?.is_default ? (
            <span className="text-muted-foreground text-xs">Default agent</span>
          ) : null}
          {profile?.draft ? (
            <span className="text-muted-foreground ml-auto text-xs tabular-nums">
              {profileDraftCount(profile)} change{profileDraftCount(profile) === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>

        {activeEditors.length > 0 ? (
          <div className="mt-2 flex items-center gap-2">
            <AvatarGroup>
              {activeEditors.slice(0, 3).map((editor) => (
                <Avatar
                  key={editor.user_id}
                  size="sm"
                  title={editor.display_name ?? 'Active editor'}
                >
                  {editor.avatar_url ? <AvatarImage src={editor.avatar_url} alt="" /> : null}
                  <AvatarFallback>{initials(editor.display_name, editor.user_id)}</AvatarFallback>
                </Avatar>
              ))}
            </AvatarGroup>
            <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
              <UsersThreeIcon className="size-3" />
              {activeEditors.length} editing
            </span>
          </div>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {agents.length === 0 ? (
          <div className="flex min-h-40 items-center justify-center px-5 text-center">
            <p className="text-muted-foreground text-sm">No configurable agents found.</p>
          </div>
        ) : profileQuery.isLoading ? (
          <div className="flex min-h-40 items-center justify-center">
            <Loading className="size-5" />
          </div>
        ) : profileQuery.isError ? (
          <div className="space-y-3 px-5 py-8 text-center">
            <p className="text-destructive text-sm" role="alert">
              {profileQuery.error instanceof Error
                ? profileQuery.error.message
                : 'Agent profile could not be loaded.'}
            </p>
            <div className="flex justify-center gap-2">
              <Button variant="outline" size="sm" onClick={() => profileQuery.refetch()}>
                Retry
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  onRequestClose?.();
                  openCustomize('agents');
                }}
              >
                Open agent settings
              </Button>
            </div>
          </div>
        ) : profile ? (
          <nav aria-label="Agent capabilities" className="px-4 py-2">
            {SECTIONS.map((section) => {
              const SectionIcon = section.icon;
              return (
                <button
                  key={section.id}
                  type="button"
                  className="border-border hover:bg-muted/50 focus-visible:ring-ring group flex min-h-[66px] w-full items-center gap-3 border-b px-1 text-left transition-colors outline-none focus-visible:ring-2"
                  onClick={() => setDialog(section.id)}
                >
                  <span className="bg-muted inline-flex size-9 shrink-0 items-center justify-center rounded-sm">
                    <SectionIcon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{section.label}</span>
                    <span className="text-muted-foreground mt-0.5 block truncate text-xs">
                      {summaryFor(profile, section.id)}
                    </span>
                  </span>
                  <CaretRightIcon className="text-muted-foreground size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" />
                </button>
              );
            })}
          </nav>
        ) : null}
      </div>

      <footer className="border-border shrink-0 border-t p-3">
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!profile?.draft}
            onClick={() => setDialog('test')}
          >
            Test draft
          </Button>
          <Button size="sm" disabled={!profile?.draft} onClick={() => setDialog('review')}>
            Review &amp; publish
          </Button>
        </div>
      </footer>

      {profile ? (
        <>
          {dialog === 'instructions' ? (
            <InstructionsDialog
              open={dialog === 'instructions'}
              onOpenChange={(next) => !next && setDialog(null)}
              profile={profile}
              mutations={mutations}
              onConflict={onConflict}
            />
          ) : null}
          {dialog === 'integrations' ? (
            <IntegrationsDialog
              open={dialog === 'integrations'}
              onOpenChange={(next) => !next && setDialog(null)}
              profile={profile}
              mutations={mutations}
              onConflict={onConflict}
            />
          ) : null}
          {dialog === 'knowledge' ? (
            <AgentProfileKnowledgeDialog
              open={dialog === 'knowledge'}
              onOpenChange={(next) => !next && setDialog(null)}
              profile={profile}
              mutations={mutations}
              onConflict={onConflict}
            />
          ) : null}
          {dialog === 'skills' ? (
            <AgentProfileSkillsDialog
              open={dialog === 'skills'}
              onOpenChange={(next) => !next && setDialog(null)}
              profile={profile}
              mutations={mutations}
              onConflict={onConflict}
            />
          ) : null}
          {dialog === 'automations' ? (
            <AgentProfileAutomationsDialog
              open={dialog === 'automations'}
              onOpenChange={(next) => !next && setDialog(null)}
              profile={profile}
              mutations={mutations}
              onConflict={onConflict}
            />
          ) : null}
          {dialog === 'advanced' ? (
            <AdvancedDialog
              open={dialog === 'advanced'}
              onOpenChange={(next) => !next && setDialog(null)}
              profile={profile}
              mutations={mutations}
              onConflict={onConflict}
            />
          ) : null}
          {dialog === 'review' ? (
            <AgentProfileReviewDialog
              open={dialog === 'review'}
              onOpenChange={(next) => !next && setDialog(null)}
              profile={profile}
              mutations={mutations}
              onConflict={onConflict}
            />
          ) : null}
          {dialog === 'test' ? (
            <AgentProfileTestDialog
              open={dialog === 'test'}
              onOpenChange={(next) => !next && setDialog(null)}
              profile={profile}
              mutations={mutations}
              onConflict={onConflict}
            />
          ) : null}
          <ConfirmDialog
            open={discardOpen}
            onOpenChange={setDiscardOpen}
            title="Discard profile draft"
            description="All unpublished capability changes for this agent are discarded."
            confirmLabel="Discard draft"
            confirmVariant="destructive"
            confirmIcon={<TrashIcon className="size-3.5" />}
            isPending={mutations.discard.isPending}
            onConfirm={() => void discard()}
          />
        </>
      ) : null}
    </div>
  );
}

export function AgentProfileRail({ projectId, enabled }: AgentProfileRailProps) {
  const isWide = useMediaQuery('(min-width: 1280px)');
  const [sheetOpen, setSheetOpen] = useState(false);

  if (!enabled) return null;

  if (isWide) {
    return (
      <aside
        className="border-border flex min-h-0 w-[360px] min-w-[360px] shrink-0 basis-[360px] overflow-hidden border-l"
        aria-label="Agent capability profile"
      >
        <ProfilePanel projectId={projectId} />
      </aside>
    );
  }

  return (
    <>
      <Hint label="Agent capability profile">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="bg-background/90 absolute top-2 right-2 z-20 backdrop-blur-sm"
          onClick={() => setSheetOpen(true)}
        >
          <RobotIcon className="size-4" />
          Agent
        </Button>
      </Hint>
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="w-full max-w-[420px] p-0 sm:max-w-[420px]">
          <SheetHeader className="sr-only">
            <SheetTitle>Agent capability profile</SheetTitle>
            <SheetDescription>Configure the selected agent.</SheetDescription>
          </SheetHeader>
          <ProfilePanel projectId={projectId} onRequestClose={() => setSheetOpen(false)} />
        </SheetContent>
      </Sheet>
    </>
  );
}
