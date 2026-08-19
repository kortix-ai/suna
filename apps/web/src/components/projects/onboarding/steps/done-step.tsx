'use client';

/**
 * Step 5 — the finish line.
 *
 * "Open project" now does two things at once: completes onboarding AND
 * auto-sends the first message — the exact text previewed below — as the
 * new session's opening turn. There is no starter-tile picker any more:
 * three generic tiles ("Turn notes into actions", "Triage my inbox", "Watch
 * the market") plus an auto-sent message asked the user to choose twice for
 * the same outcome, and none of the tiles used what onboarding just
 * collected. One real, personalized opener beats three generic ones.
 *
 * The kickoff text itself lives in `onboarding-profile.ts`
 * (`buildOnboardingKickoffPrompt`) so this preview and the actual send always
 * say the same thing.
 */

import {
  CalendarBlankIcon as Calendar,
  ChatCircleIcon as ChatCircle,
  CheckCircleIcon as CheckCircle,
} from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';

import { buildOnboardingKickoffPrompt } from '../onboarding-profile';
import { StepShell } from '../step-shell';

export function DoneStep({
  domain,
  connectedCount,
  showFounderCall,
  onBookCall,
  onStart,
}: {
  /** The company-step's domain field, trimmed. Empty when skipped. */
  domain: string;
  connectedCount: number;
  /** Founder-concierge tier. The CTA used to live on the deleted welcome step. */
  showFounderCall?: boolean;
  onBookCall?: () => void;
  /** Completes onboarding AND fires the kickoff prompt as the first turn. */
  onStart: () => void;
}) {
  const kickoff = buildOnboardingKickoffPrompt(domain, connectedCount);

  return (
    <div className="flex flex-col gap-7">
      {/* The one celebratory beat in the flow, and it happens exactly once.
          Springs from 0.6 — never 0, because nothing appears out of nothing —
          with a trace of bounce that would be wrong anywhere else in the UI. */}
      <span className="bg-kortix-green/12 flex size-16 items-center justify-center rounded-lg">
        <CheckCircle className="text-kortix-green size-10" weight="fill" />
      </span>

      <StepShell
        title="Your command center is live"
        description={
          connectedCount > 0
            ? `${connectedCount} ${connectedCount === 1 ? 'tool' : 'tools'} connected. Opening starts your first conversation with Kortix.`
            : 'Opening starts your first conversation with Kortix.'
        }
        primaryLabel="Open project"
        onPrimary={onStart}
      >
        <div className="bg-popover flex items-start gap-3 rounded-md border px-4 py-4">
          <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-sm">
            <ChatCircle className="text-muted-foreground size-4" />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-muted-foreground text-xs font-medium">Your first message</p>
            <p className="text-foreground text-sm leading-6 text-pretty">{kickoff}</p>
          </div>
        </div>

        {/* Rehomed from the deleted welcome step. Quiet, below the prompts —
            it is an offer, not the main path. */}
        {showFounderCall && onBookCall && (
          <div className="mt-6 flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground h-10 gap-1.5"
              onClick={onBookCall}
            >
              <Calendar className="size-3.5" />
              Book a 20-minute setup call with Marko
            </Button>
          </div>
        )}
      </StepShell>
    </div>
  );
}
