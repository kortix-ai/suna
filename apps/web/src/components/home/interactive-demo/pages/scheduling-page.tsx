'use client';

import { Button } from '@/components/ui/button';
import { InlineMeta } from '@/components/ui/inline-meta';
import { cn } from '@/lib/utils';
import { Clock, Plus } from 'lucide-react';
import { useState } from 'react';
import { INITIAL_JOBS, type ScheduleJob } from '../data';
import { PageHead, Panel, Row, Toggle } from '../primitives';

export function SchedulingPage() {
  const [jobs, setJobs] = useState<ScheduleJob[]>(INITIAL_JOBS);
  const toggle = (name: string) =>
    setJobs((js) => js.map((j) => (j.name === name ? { ...j, on: !j.on } : j)));
  const activeCount = jobs.filter((j) => j.on).length;

  return (
    <div>
      <PageHead
        title="Scheduling"
        sub={`${activeCount} active · cron triggers in your timezone, running 24/7`}
        action={
          <Button size="sm">
            <Plus className="size-3.5" /> New schedule
          </Button>
        }
      />
      <Panel>
        {jobs.map((job) => (
          <Row
            key={job.name}
            leading={
              <span
                className={cn(
                  'flex size-8 items-center justify-center rounded-lg border transition-colors',
                  job.on
                    ? 'border-kortix-green/20 bg-kortix-green/10 text-kortix-green'
                    : 'border-border bg-background text-muted-foreground',
                )}
              >
                <Clock className="size-4" />
              </span>
            }
            title={job.name}
            subtitle={
              <InlineMeta>
                <span className="font-mono">{job.cron}</span>
                <span>{job.when}</span>
                <span>{job.on ? `next ${job.next}` : 'paused'}</span>
              </InlineMeta>
            }
            trailing={<Toggle on={job.on} onClick={() => toggle(job.name)} />}
          />
        ))}
      </Panel>
    </div>
  );
}
