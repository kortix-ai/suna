'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Plus, Search } from 'lucide-react';
import { HiMiniSparkles } from 'react-icons/hi2';
import { CORE_SKILLS, GKW_SKILLS } from '../data';
import { PageHead } from '../primitives';

function SkillItem({ name, desc }: { name: string; desc: string }) {
  return (
    <div className="border-border/60 bg-card hover:bg-muted/30 flex items-start gap-2.5 rounded-md border p-2.5 transition-colors">
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

export function SkillsPage() {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
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

      {core.length > 0 && <SkillGroup label="Core" count={core.length} skills={core} />}
      {gkw.length > 0 && (
        <SkillGroup
          label="General Knowledge Worker"
          count={gkw.length}
          skills={gkw}
          className="mt-5"
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
}: {
  label: string;
  count: number;
  skills: [string, string][];
  className?: string;
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
          <SkillItem key={n} name={n} desc={d} />
        ))}
      </div>
    </div>
  );
}
