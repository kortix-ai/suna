'use client';

import { useTranslations } from 'next-intl';

import { useState, useCallback } from 'react';
import { MapPin } from 'lucide-react';
import { AnimatedBg } from '@/components/ui/animated-bg';
import { useIsMobile } from '@/hooks/utils';
import { useAuth } from '@/components/AuthProvider';
import { useRouter } from 'next/navigation';
import {
  useCreateOpenCodeSession,
  useOpenCodeAgents,
  useOpenCodeProviders,
  useOpenCodeCommands,
} from '@/hooks/opencode/use-opencode-sessions';
import { SessionChatInput } from '@/components/session/session-chat-input';
import { toast } from '@/lib/toast';
import type { Command } from '@/hooks/opencode/use-opencode-sessions';
import { useOpenCodeLocal } from '@/hooks/opencode/use-opencode-local';
import { useOpenCodeConfig } from '@/hooks/opencode/use-opencode-config';

// Mobile users are redirected at the edge by middleware (hyper-fast)
// This page only renders for desktop users

export default function BerlinPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const isMobile = useIsMobile();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const router = useRouter();
  const { user, isLoading } = useAuth();
  const createSession = useCreateOpenCodeSession();

  // Fetch agents, providers, commands from OpenCode server
  const { data: agents } = useOpenCodeAgents();
  const { data: providers } = useOpenCodeProviders();
  const { data: commands } = useOpenCodeCommands();
  const { data: config } = useOpenCodeConfig();

  // Unified model/agent/variant state
  const local = useOpenCodeLocal({ agents, providers, config });

  const handleSend = useCallback(
    async (text: string, _files?: unknown) => {
      if (!text.trim() || isSubmitting) return;

      if (!user && !isLoading) {
        router.push('/auth');
        return;
      }

      setIsSubmitting(true);
      try {
        const options: Record<string, unknown> = {};
        if (local.agent.current) options.agent = local.agent.current.name;
        if (local.model.currentKey) options.model = local.model.currentKey;
        if (local.model.variant.current) options.variant = local.model.variant.current;

        const session = await createSession.mutateAsync();

        sessionStorage.setItem(`opencode_pending_prompt:${session.id}`, text);
        if (Object.keys(options).length > 0) {
          sessionStorage.setItem(`opencode_pending_options:${session.id}`, JSON.stringify(options));
        }

        router.push(`/sessions/${session.id}`);
      } catch (error) {
        setIsSubmitting(false);
        toast.error('Failed to create session');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isSubmitting, user, isLoading, createSession, router, local.agent.current, local.model.currentKey, local.model.variant.current],
  );

  const handleCommand = useCallback((_cmd: Command) => {
    // On landing pages, slash commands are a no-op
  }, []);

  return (
    <main className="w-full">
      <section className="w-full relative overflow-hidden">
        <div className="relative flex flex-col items-center w-full px-4 sm:px-6 pb-8 sm:pb-10">
          <AnimatedBg
            variant="hero"
            sizeMultiplier={isMobile ? 0.7 : 1}
            blurMultiplier={isMobile ? 0.6 : 1}
          />

          <div className="relative z-10 pt-20 sm:pt-24 md:pt-32 mx-auto h-full w-full max-w-6xl flex flex-col items-center justify-center min-h-[60vh] sm:min-h-0">
            <div className="flex flex-col items-center justify-center gap-3 sm:gap-4 pt-12 sm:pt-20 max-w-4xl mx-auto pb-6 sm:pb-7">
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/5 border border-primary/10">
                <MapPin className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium text-primary">{tHardcodedUi.raw('appHomeBerlinPage.line92JsxTextBerlinGermany')}</span>
              </div>
              
              <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-medium tracking-tighter text-balance text-center px-4 sm:px-2">
                Kortix.
              </h1>
              
              <div className="text-center space-y-2 max-w-3xl px-4">
                <h2 className="text-lg sm:text-xl md:text-2xl font-medium tracking-tight text-muted-foreground">{tHardcodedUi.raw('appHomeBerlinPage.line101JsxTextDeinAutonomerKiWorker')}</h2>
                <p className="text-sm sm:text-base text-muted-foreground/80 font-normal text-balance leading-relaxed">{tHardcodedUi.raw('appHomeBerlinPage.line104JsxTextGebautFurKomplexeAufgabenEntwickeltFurAllesDer')}</p>
              </div>

              <div className="flex flex-col items-center w-full max-w-3xl mx-auto gap-2 flex-wrap justify-center px-4 sm:px-0">
                <div className="w-full relative">
                  <SessionChatInput
                    onSend={handleSend}
                    disabled={isSubmitting}
                    placeholder={tHardcodedUi.raw('appHomeBerlinPage.line113JsxAttrPlaceholderBeschreibeDeineAufgabe')}
                    agents={local.agent.list}
                    selectedAgent={local.agent.current?.name ?? null}
                    onAgentChange={(name) => local.agent.set(name ?? undefined)}
                    models={local.model.list}
                    selectedModel={local.model.currentKey ?? null}
                    onModelChange={(m) => local.model.set(m ?? undefined, { recent: true })}
                    variants={local.model.variant.list}
                    selectedVariant={local.model.variant.current ?? null}
                    onVariantChange={(v) => local.model.variant.set(v ?? undefined)}
                    commands={commands || []}
                    onCommand={handleCommand}
                    autoFocus={false}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
