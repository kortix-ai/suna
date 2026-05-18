'use client';

/**
 * Project Settings hub — a single tab that absorbs Team, Triggers,
 * Credentials, and the existing Board config (columns/fields/templates).
 *
 * Why: the top-level tab bar was getting crowded (9 tabs). Top-level is
 * reserved for work surfaces (Board, Milestones, Sessions, Files, About);
 * set-once / rarely-touched configuration lives here.
 *
 * UX: sub-pills mirror the existing style used inside TicketSettingsTab
 * (rounded-full, filled when active). Section state is purely client-side
 * — URL sync is opt-in via the `initialSection` prop (wire up later if
 * needed for deep-links).
 */

import { type ComponentType } from 'react';
import { Users, KeyRound, Zap, LayoutGrid } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TeamTab } from './team-tab';
import { CredentialsTab } from './credentials-tab';
import { TriggersTab } from './triggers-tab';
import { TicketSettingsTab } from './ticket-settings-tab';

export type SettingsSection = 'team' | 'credentials' | 'triggers' | 'board';

/**
 * Controlled component: parent owns the section state so it survives
 * tab-away / tab-back on the outer project tab bar. Parent also uses
 * `section` to land legacy `setTab('team')` etc. on the right pill.
 */
export function ProjectSettingsTab({
  projectId,
  projectPath,
  section,
  onSectionChange,
}: {
  projectId: string;
  projectPath?: string | null;
  section: SettingsSection;
  onSectionChange: (s: SettingsSection) => void;
}) {
  const setSection = onSectionChange;

  return (
    <div className="h-full flex flex-col overflow-hidden bg-background">
      {/* Sub-nav — sticks at the top of the settings pane, same visual
          language as the pill nav inside TicketSettingsTab. */}
      <div className="shrink-0 border-b border-border/40 bg-background/95 backdrop-blur">
        <div className="container mx-auto max-w-3xl px-3 sm:px-4 py-2.5 flex items-center gap-1">
          <SectionPill active={section === 'team'} onClick={() => setSection('team')} icon={Users} label="Team" />
          <SectionPill active={section === 'credentials'} onClick={() => setSection('credentials')} icon={KeyRound} label="Credentials" />
          <SectionPill active={section === 'triggers'} onClick={() => setSection('triggers')} icon={Zap} label="Triggers" />
          <SectionPill active={section === 'board'} onClick={() => setSection('board')} icon={LayoutGrid} label="Board" />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {section === 'team' && <TeamTab projectId={projectId} />}
        {section === 'credentials' && <CredentialsTab projectId={projectId} />}
        {section === 'triggers' && (
          <TriggersTab projectId={projectId} projectPath={projectPath ?? ''} />
        )}
        {section === 'board' && <TicketSettingsTab projectId={projectId} />}
      </div>
    </div>
  );
}

function SectionPill({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[12px] transition-colors cursor-pointer',
        active
          ? 'bg-foreground text-background'
          : 'text-muted-foreground/70 hover:text-foreground hover:bg-muted/40',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}
