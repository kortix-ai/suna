'use client';

import { Users, KeyRound, Zap, LayoutGrid, Radio } from 'lucide-react';
import { motion } from 'framer-motion';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { TeamTab } from './team-tab';
import { CredentialsTab } from './credentials-tab';
import { TriggersTab } from './triggers-tab';
import { ChannelsTab } from './channels-tab';
import { TicketSettingsTab } from './ticket-settings-tab';

export type SettingsSection = 'team' | 'credentials' | 'triggers' | 'channels' | 'board';

const SECTIONS: Array<{ value: SettingsSection; label: string; icon: typeof Users; hint: string }> = [
  { value: 'team', label: 'Team', icon: Users, hint: 'Agents, humans, and roles' },
  { value: 'credentials', label: 'Credentials', icon: KeyRound, hint: 'API keys and secrets' },
  { value: 'triggers', label: 'Triggers', icon: Zap, hint: 'Cron jobs and webhooks' },
  { value: 'channels', label: 'Channels', icon: Radio, hint: 'Slack, email, and inbound routes' },
  { value: 'board', label: 'Board', icon: LayoutGrid, hint: 'Columns, fields, and templates' },
];

const TRIGGER_CLS = cn(
  'data-[state=active]:shadow-none',
  'data-[state=active]:ring-0',
  'data-[state=active]:bg-background data-[state=active]:text-foreground',
  'data-[state=active]:border-border/60',
);

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
  const current = SECTIONS.find((s) => s.value === section) ?? SECTIONS[0];

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <Tabs
        value={section}
        onValueChange={(v) => onSectionChange(v as SettingsSection)}
        className="flex h-full min-h-0 flex-col gap-0"
      >
        <div className="shrink-0">
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="mx-auto w-full max-w-3xl px-4 pt-12 sm:px-6"
          >
            <header>
              <h1 className="text-xl font-semibold tracking-tight text-foreground">
                Settings
              </h1>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {current.hint}.
              </p>
            </header>

            <div className="mt-6">
              <TabsList>
                {SECTIONS.map((s) => (
                  <TabsTrigger
                    key={s.value}
                    value={s.value}
                    className={cn('flex-none px-3', TRIGGER_CLS)}
                  >
                    <s.icon />
                    {s.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
          </motion.div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          <motion.div
            key={section}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="h-full"
          >
            {section === 'team' && <TeamTab projectId={projectId} />}
            {section === 'credentials' && <CredentialsTab projectId={projectId} />}
            {section === 'triggers' && (
              <TriggersTab projectId={projectId} projectPath={projectPath ?? ''} />
            )}
            {section === 'channels' && <ChannelsTab projectId={projectId} />}
            {section === 'board' && <TicketSettingsTab projectId={projectId} />}
          </motion.div>
        </div>
      </Tabs>
    </div>
  );
}
