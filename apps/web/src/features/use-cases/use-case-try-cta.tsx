'use client';

import { useAuth } from '@/components/AuthProvider';
import { Button } from '@/components/ui/marketing/button';
import { ArrowRight } from 'lucide-react';
import { useCallback } from 'react';

export function UseCaseTryCta({ slug, prompt }: { slug: string; prompt: string }) {
  const { user } = useAuth();

  const handleLaunch = useCallback(() => {
    const target = user ? '/projects' : '/auth';
    const url = `${target}?usecase=${encodeURIComponent(slug)}&prompt=${encodeURIComponent(prompt)}`;
    window.location.href = url;
  }, [slug, prompt, user]);

  return (
    <div className="space-y-3">
      <div className="border-border bg-card text-foreground rounded-md border p-4 font-mono text-sm">
        <span className="text-muted-foreground select-none">&gt; </span>
        {prompt}
      </div>
      <Button size="lg" onClick={handleLaunch}>
        Try this agent
        <ArrowRight className="size-3.5" />
      </Button>
    </div>
  );
}
