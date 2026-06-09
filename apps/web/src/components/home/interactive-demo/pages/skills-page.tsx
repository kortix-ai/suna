'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { HiMiniSparkles } from 'react-icons/hi2';
import { CORE_SKILLS, GKW_SKILLS } from '../data';
import { PageHead } from '../primitives';

export const demoSkillId = (name: string) => `demo-skill-${name}`;

function SkillItem({
  name,
  desc,
  focused,
}: {
  name: string;
  desc: string;
  focused?: boolean;
}) {
  return (
    <div
      id={demoSkillId(name)}
      className={cn(
        'border-border/60 bg-card hover:bg-muted/30 flex items-start gap-2.5 rounded-md border p-2.5 transition-colors',
        focused && 'border-kortix-green/60 bg-kortix-green/5 ring-kortix-green/40 ring-2',
      )}
    >
      <span className="border-border bg-muted/40 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border">
        <HiMiniSparkles className="text-foreground/70 size-3" />
      </span>
      <div className="min-w-0">
        <div className="text-foreground truncate font-mono text-xs font-medium">{name}</div>
        <div className="text-muted-foreground mt-0.5 line-clamp-2 text-xs leading-snug">{desc}</div>
      </div>
    </div>
  );
}

export function SkillsPage({ focusedSkill }: { focusedSkill?: string | null } = {}) {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();

  useEffect(() => {
    if (!focusedSkill) return;
    setQ('');
    const t = window.setTimeout(() => {
      document
        .getElementById(demoSkillId(focusedSkill))
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 150);
    return () => window.clearTimeout(t);
  }, [focusedSkill]);
  const match = ([n, d]: [string, string]) =>
    !query || n.toLowerCase().includes(query) || d.toLowerCase().includes(query);
  const core = CORE_SKILLS.filter(match);
  const gkw = GKW_SKILLS.filter(match);
  const total = CORE_SKILLS.length + GKW_SKILLS.length;

  return (
    <div>
      <PageHead
        title="Skills"
        sub={`${total} skills · packaged once, reused by every agent`}
        action={
          <Button variant="default" size="sm">
            <Plus className="size-3.5" /> New skill
          </Button>
        }
      />

      <div className="border-border bg-card mb-4 flex h-9 items-center gap-2 rounded-md border px-3">
        <Search className="text-muted-foreground size-3.5 shrink-0" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search 71 skills…"
          className="placeholder:text-muted-foreground/60 text-foreground w-full bg-transparent text-sm outline-none"
        />
        {q && (
          <button
            onClick={() => setQ('')}
            className="text-muted-foreground hover:text-foreground text-xs"
          >
            Clear
          </button>
        )}
      </div>

      {core.length > 0 && (
        <SkillGroup
          label="Core"
          count={core.length}
          skills={core}
          focusedSkill={focusedSkill}
        />
      )}
      {gkw.length > 0 && (
        <SkillGroup
          label="General Knowledge Worker"
          count={gkw.length}
          skills={gkw}
          className="mt-5"
          focusedSkill={focusedSkill}
        />
      )}
      {core.length === 0 && gkw.length === 0 && (
        <div className="text-muted-foreground py-10 text-center text-sm">
          No skills match “{q}”.
        </div>
      )}
    </div>
  );
}

function SkillGroup({
  label,
  count,
  skills,
  className,
  focusedSkill,
}: {
  label: string;
  count: number;
  skills: [string, string][];
  className?: string;
  focusedSkill?: string | null;
}) {
  return (
    <div className={className}>
      <div className="mb-2 flex items-center gap-2 px-0.5">
        <span className="text-foreground text-sm font-semibold">{label}</span>
        <Badge size="sm" variant="muted">
          {count}
        </Badge>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {skills.map(([n, d]) => (
          <SkillItem key={n} name={n} desc={d} focused={focusedSkill === n} />
        ))}
      </div>
    </div>
  );
}
