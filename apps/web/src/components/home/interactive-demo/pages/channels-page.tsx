'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';
import { ChevronDown, MessageSquare } from 'lucide-react';
import { PageHead } from '../primitives';

export function ChannelsPage() {
  const [showByo, setShowByo] = useState(false);
  return (
    <div>
      <PageHead
        title="Channels"
        sub="Run this project from chat — connect a Slack workspace and your agent responds in the channels you invite it to."
      />

      <div className="border-border bg-card overflow-hidden rounded-md border">
        <div className="flex flex-col items-start gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="border-border flex size-14 shrink-0 items-center justify-center rounded-lg border">
              <Icon.Slack className="size-7" />
            </span>
            <div className="min-w-0">
              <p className="text-foreground text-sm font-medium">
                Add Kortix to your Slack workspace
              </p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                One click — approve scopes in Slack and we&apos;ll wire this project to the
                workspace you choose. Tokens stay encrypted in this project&apos;s secrets.
              </p>
            </div>
          </div>
          <Button size="sm" className="shrink-0">
            <Icon.Slack className="size-3.5" /> Add to Slack
          </Button>
        </div>

        <button
          type="button"
          onClick={() => setShowByo((v) => !v)}
          className="border-border hover:bg-muted/30 flex w-full items-center justify-between gap-3 border-t px-4 py-3 text-left transition-colors"
          aria-expanded={showByo}
        >
          <div className="min-w-0">
            <p className="text-foreground text-sm font-medium">Bring your own Slack app</p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              For self-hosted setups or custom-scoped installs.
            </p>
          </div>
          <ChevronDown
            className={cn(
              'text-muted-foreground size-4 shrink-0 transition-transform',
              showByo && 'rotate-180',
            )}
          />
        </button>
        {showByo && (
          <div className="border-border text-muted-foreground border-t px-4 py-3 text-xs">
            Paste a Slack app manifest and your Bot User OAuth Token + Signing Secret — stored
            encrypted in <span className="text-foreground font-mono">project_secrets</span>.
          </div>
        )}
      </div>

      <div className="border-border/60 bg-muted/20 text-muted-foreground mt-3 flex items-center gap-2 rounded-md border px-3 py-2.5 text-xs">
        <MessageSquare className="size-3.5 shrink-0" />
        Invite the bot to any channel and{' '}
        <span className="text-foreground font-mono">@mention</span> it — a session spawns and the
        agent replies in-thread.
      </div>
    </div>
  );
}
