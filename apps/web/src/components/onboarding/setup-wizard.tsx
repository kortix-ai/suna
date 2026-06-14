'use client';

import { useTranslations } from 'next-intl';

/**
 * SetupWizard — dynamic onboarding shown between boot overlay and the dashboard.
 *
 * Steps are computed at runtime based on billing status:
 * - Auto Top-up (cloud-only, hidden when billing is disabled)
 * - LLM Providers
 * - Default Model — pick which model to use by default
 * - Tool API Keys (opt-in configure modal, cloud pre-configured)
 * - Get Started — launches the onboarding chat session
 */

import { AutoTopupCard } from '@/components/billing/auto-topup-card';
import type { FlatModel } from '@/components/session/session-chat-input';
import { flattenModels } from '@/components/session/session-chat-input';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { PROVIDER_LABELS, ProviderLogo } from '@/features/providers/provider-branding';
import { useModelStore } from '@/hooks/opencode/use-model-store';
import { useOpenCodeProviders } from '@/hooks/opencode/use-opencode-sessions';
import { backendApi } from '@/lib/api-client';
import { authenticatedFetch } from '@/lib/auth-token';
import { isBillingEnabled } from '@/lib/config';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useProviderModalStore } from '@/stores/provider-modal-store';
import { getActiveOpenCodeUrl } from '@/stores/server-store';
import {
  ArrowLeft,
  BookOpen,
  Bot,
  Check,
  ChevronRight,
  CreditCard,
  ExternalLink,
  Flame,
  Image as ImageIcon,
  Key,
  Loader2,
  MessageSquare,
  Mic,
  Search,
  Settings2,
  Sparkles,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useRef, useState } from 'react';
import { saveToolKeys } from './save-tool-keys';

// ─── Step definitions ───────────────────────────────────────────────────────

type StepDef = { label: string; icon: React.ComponentType<{ className?: string }> };

// ─── Step indicator (dots + label) ──────────────────────────────────────────

function StepIndicator({ current, steps }: { current: number; steps: StepDef[] }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex items-center justify-center gap-1.5">
        {steps.map((_, i) => (
          <motion.div
            key={i}
            layout
            className={cn(
              'rounded-full transition-colors duration-300',
              i === current
                ? 'bg-foreground h-1.5 w-6'
                : i < current
                  ? 'bg-foreground/40 h-1.5 w-1.5'
                  : 'bg-foreground/15 h-1.5 w-1.5',
            )}
          />
        ))}
      </div>
      <p className="text-muted-foreground/40 text-xs font-medium tracking-wider uppercase">
        {steps[current]?.label}
      </p>
    </div>
  );
}

// ─── Overlay modal (for configure forms) ────────────────────────────────────

function ConfigureModal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center">
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 cursor-pointer bg-black/50 backdrop-blur-xs"
        onClick={onClose}
      />
      {/* Panel */}
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="bg-background relative z-10 mx-4 flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl border shadow-xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <h3 className="text-foreground/90 text-sm font-medium">{title}</h3>
          <Button
            onClick={onClose}
            variant="ghost"
            size="icon-sm"
            className="text-foreground/40 hover:text-foreground/70"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 pb-5">{children}</div>
      </motion.div>
    </div>
  );
}

// ─── Cloud badge ────────────────────────────────────────────────────────────

function CloudBadge({ text }: { text?: string }) {
  return (
    <div className="mx-auto flex w-fit items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
      <Zap className="h-3 w-3" />
      {text || 'Included with your Kortix credits'}
    </div>
  );
}

// ─── Step 0: Welcome ─────────────────────────────────────────────────────────

function WelcomePane({ onNext }: { onNext: () => void }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="flex flex-col items-center gap-10 text-center">
      {/* Kortix logo — large, centered */}
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      >
        <KortixLogo variant="logomark" size={38} />
      </motion.div>

      {/* Welcome text */}
      <div className="space-y-3">
        <motion.h1
          className="text-foreground/90 text-2xl font-medium tracking-tight"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
        >
          {tHardcodedUi.raw('componentsOnboardingSetupWizard.line174JsxTextWelcomeToYourKortix')}
        </motion.h1>
        <motion.p
          className="text-muted-foreground/50 mx-auto max-w-xs text-sm leading-relaxed"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.25, ease: [0.16, 1, 0.3, 1] }}
        >
          {tHardcodedUi.raw(
            'componentsOnboardingSetupWizard.line182JsxTextLetAposSGetYouSetUpThis',
          )}
        </motion.p>
      </div>

      {/* CTA */}
      <motion.div
        className="w-full"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.35, ease: [0.16, 1, 0.3, 1] }}
      >
        <Button onClick={onNext} size="lg" className="w-full shadow-none">
          {tHardcodedUi.raw('componentsOnboardingSetupWizard.line198JsxTextGetStarted')}
          <ChevronRight className="h-4 w-4" />
        </Button>
      </motion.div>
    </div>
  );
}

// ─── Step: How It Works ──────────────────────────────────────────────────────

function HowItWorksPane({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="mx-auto w-full max-w-sm space-y-6">
      <div className="space-y-3 text-center">
        <div className="flex items-center justify-center">
          <div className="bg-muted/60 flex h-12 w-12 items-center justify-center rounded-full">
            <Key className="text-muted-foreground/50 h-5 w-5" />
          </div>
        </div>
        <div className="space-y-1.5">
          <h2 className="text-foreground/90 text-lg font-medium">
            {tHardcodedUi.raw('componentsOnboardingSetupWizard.line217JsxTextConnectYourAi')}
          </h2>
          <p className="text-muted-foreground/50 mx-auto max-w-xs text-sm leading-relaxed">
            {tHardcodedUi.raw(
              'componentsOnboardingSetupWizard.line219JsxTextKortixIsDesignedToWorkWithYourOwn',
            )}
          </p>
        </div>
      </div>

      {/* Options */}
      <div className="space-y-2">
        <div className="border-foreground/[0.06] bg-foreground/[0.02] flex items-start gap-3 rounded-2xl border px-3 py-3">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-2xl bg-emerald-500/10">
            <Sparkles className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="text-left">
            <p className="text-foreground/80 text-sm font-medium">
              {tHardcodedUi.raw(
                'componentsOnboardingSetupWizard.line231JsxTextCodingSubscriptions',
              )}
            </p>
            <p className="text-foreground/40 text-xs leading-relaxed">
              {tHardcodedUi.raw(
                'componentsOnboardingSetupWizard.line233JsxTextChatgptMaxClaudeProCodeOrSimilarBest',
              )}
            </p>
          </div>
        </div>

        <div className="border-foreground/[0.06] bg-foreground/[0.02] flex items-start gap-3 rounded-2xl border px-3 py-3">
          <div className="bg-foreground/[0.05] mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-2xl">
            <Key className="text-foreground/40 h-3.5 w-3.5" />
          </div>
          <div className="text-left">
            <p className="text-foreground/80 text-sm font-medium">
              {tHardcodedUi.raw('componentsOnboardingSetupWizard.line243JsxTextYourOwnApiKeys')}
            </p>
            <p className="text-foreground/40 text-xs leading-relaxed">
              {tHardcodedUi.raw(
                'componentsOnboardingSetupWizard.line245JsxTextOpenaiAnthropicGoogleOpenrouterBringAnyKeyYou',
              )}
            </p>
          </div>
        </div>

        {isBillingEnabled() && (
          <div className="border-foreground/[0.06] bg-foreground/[0.02] flex items-start gap-3 rounded-2xl border px-3 py-3">
            <div className="bg-foreground/[0.05] mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-2xl">
              <CreditCard className="text-foreground/40 h-3.5 w-3.5" />
            </div>
            <div className="text-left">
              <p className="text-foreground/80 text-sm font-medium">
                {tHardcodedUi.raw('componentsOnboardingSetupWizard.line256JsxTextKortixCredits')}
              </p>
              <p className="text-foreground/40 text-xs leading-relaxed">
                {tHardcodedUi.raw(
                  'componentsOnboardingSetupWizard.line258JsxTextDonAposTHaveAKeyYetWe',
                )}
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <Button onClick={onNext} size="lg" className="w-full shadow-none">
          {tHardcodedUi.raw('componentsOnboardingSetupWizard.line270JsxTextConnectAProvider')}
          <ChevronRight className="h-4 w-4" />
        </Button>

        <div className="flex justify-center pt-1">
          <Button onClick={onBack} variant="muted" size="xs" className="mx-auto">
            <ArrowLeft className="h-3 w-3" /> Back
          </Button>
        </div>
      </div>
    </div>
  );
}

/// ─── Step 1: Auto Top-up ────────────────────────────────────────────────────

function AutoTopupPane({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [saving, setSaving] = useState(false);
  const configRef = useRef<{ enabled: boolean; threshold: number; amount: number } | null>(null);

  const handleContinue = async () => {
    const config = configRef.current;
    if (!config) {
      onNext();
      return;
    }
    setSaving(true);
    try {
      await backendApi.post('/billing/auto-topup/configure', config);
    } catch {
      // Non-fatal — preference saved on next Settings visit
    }
    setSaving(false);
    onNext();
  };

  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <div className={cn('flex h-12 w-12 items-center justify-center rounded-full', 'bg-muted/60')}>
        <CreditCard className="text-muted-foreground/50 h-5 w-5" />
      </div>

      <div className="space-y-1.5">
        <h2 className="text-foreground/90 text-lg font-medium">
          {tHardcodedUi.raw('componentsOnboardingSetupWizard.line314JsxTextKortixCredits')}
        </h2>
        <p className="text-muted-foreground/50 mx-auto max-w-xs text-sm leading-relaxed">
          {tHardcodedUi.raw(
            'componentsOnboardingSetupWizard.line316JsxTextYouStartWithAFewFreeCreditsTo',
          )}
        </p>
      </div>

      <div className="border-foreground/[0.06] bg-foreground/[0.02] text-muted-foreground/60 rounded-2xl border p-3.5 text-sm leading-relaxed">
        {tHardcodedUi.raw(
          'componentsOnboardingSetupWizard.line321JsxTextCreditsAreUsedWhenYourAgentRunsOn',
        )}
      </div>

      {/* Shared auto top-up card */}
      <div className="bg-card/50 w-full rounded-2xl border p-4">
        <AutoTopupCard defaultEnabled={true} configRef={configRef} />
      </div>

      <Button onClick={handleContinue} disabled={saving} size="lg" className="w-full shadow-none">
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        Continue
        <ChevronRight className="h-4 w-4" />
      </Button>

      <div className="flex justify-center pt-1">
        <Button onClick={onBack} variant="muted" size="xs" className="mx-auto">
          <ArrowLeft className="h-3 w-3" /> Back
        </Button>
      </div>
    </div>
  );
}

function ProvidersPane({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { data: providersData, isLoading } = useOpenCodeProviders();
  const openProviderModal = useProviderModalStore((s) => s.openProviderModal);

  const connectedProviders = useMemo(() => {
    if (!providersData) return [];
    const ids = new Set(providersData.connected ?? []);
    return (providersData.all ?? []).filter((p) => ids.has(p.id));
  }, [providersData]);

  const hasLLM = connectedProviders.some((p) =>
    ['anthropic', 'openai', 'openrouter', 'google', 'groq', 'xai'].includes(p.id),
  );

  if (isLoading) {
    return (
      <div className="flex flex-col items-center space-y-4 py-16">
        <KortixLoader size="small" />
        <p className="text-muted-foreground/40 text-xs">
          {tHardcodedUi.raw('componentsOnboardingSetupWizard.line366JsxTextCheckingProviders')}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-sm space-y-6">
      <div className="space-y-3 text-center">
        <div className="flex items-center justify-center">
          <div
            className={cn(
              'flex h-12 w-12 items-center justify-center rounded-full',
              hasLLM ? 'bg-emerald-500/10' : 'bg-muted/60',
            )}
          >
            {hasLLM ? (
              <Check className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Sparkles className="text-muted-foreground/50 h-5 w-5" />
            )}
          </div>
        </div>
        <div className="space-y-1.5">
          <h2 className="text-foreground/90 text-lg font-medium">
            {hasLLM ? 'Providers Connected' : 'Connect a Provider'}
          </h2>
          <p className="text-muted-foreground/50 mx-auto max-w-xs text-sm leading-relaxed">
            {hasLLM
              ? 'Your agent is ready to use these models.'
              : 'Log in with your coding subscription, paste an API key, or skip to use Kortix credits.'}
          </p>
        </div>
      </div>

      {/* Connected providers list */}
      {hasLLM && connectedProviders.length > 0 && (
        <div className="space-y-1.5">
          {connectedProviders.map((p) => (
            <div
              key={p.id}
              className="border-foreground/[0.06] bg-foreground/[0.02] flex items-center gap-3 rounded-2xl border px-3 py-2"
            >
              <ProviderLogo providerID={p.id} name={p.name} size="small" />
              <span className="text-foreground/80 text-sm font-medium">
                {PROVIDER_LABELS[p.id] || p.name || p.id}
              </span>
              <Check className="ml-auto h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <Button
          onClick={() => openProviderModal('providers')}
          variant={hasLLM ? 'outline' : 'default'}
          size="lg"
          className="w-full shadow-none"
        >
          <Settings2 className="h-4 w-4" />
          {hasLLM ? 'Manage providers' : 'Connect a provider'}
        </Button>

        <Button
          onClick={onNext}
          variant={hasLLM ? 'default' : 'ghost'}
          size="lg"
          className={cn('w-full shadow-none', !hasLLM && 'text-muted-foreground/60')}
        >
          {hasLLM ? (
            <>
              Continue <ChevronRight className="h-4 w-4" />
            </>
          ) : (
            'Skip for now'
          )}
        </Button>

        <div className="flex justify-center pt-1">
          <Button onClick={onBack} variant="muted" size="xs" className="mx-auto">
            <ArrowLeft className="h-3 w-3" /> Back
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Step 2: Default Model ──────────────────────────────────────────────────

function DefaultModelPane({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { data: providersData, isLoading } = useOpenCodeProviders();
  const allModels = useMemo(() => flattenModels(providersData), [providersData]);
  const modelStore = useModelStore(allModels);

  // Resolve initial selection from global default or recent list
  const initialModel = useMemo(() => {
    if (modelStore.globalDefault) return modelStore.globalDefault;
    if (modelStore.recent.length > 0) return modelStore.recent[0];
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [selected, setSelected] = useState<{ providerID: string; modelID: string } | null>(
    initialModel ?? null,
  );

  // Group visible models by provider
  const grouped = useMemo(() => {
    const visible = allModels.filter((m) => modelStore.isVisible(m));
    const groups = new Map<string, FlatModel[]>();
    for (const m of visible) {
      const list = groups.get(m.providerID) || [];
      list.push(m);
      groups.set(m.providerID, list);
    }
    return Array.from(groups.entries()).sort((a, b) => {
      const la = PROVIDER_LABELS[a[0]] || a[0];
      const lb = PROVIDER_LABELS[b[0]] || b[0];
      return la.localeCompare(lb);
    });
  }, [allModels, modelStore]);

  const handleSelect = useCallback(
    (model: FlatModel) => {
      const key = { providerID: model.providerID, modelID: model.modelID };
      setSelected(key);

      // Set as global default — checked in useOpenCodeLocal BEFORE agent.model,
      // so it wins over server-configured agent defaults. Persisted in localStorage.
      modelStore.setGlobalDefault(key);
      // Also push to recent as a secondary signal
      modelStore.pushRecent(key);

      // Fire-and-forget: persist the default model on the server so it
      // survives across devices / reinstalls and is written to opencode.jsonc.
      const base = getActiveOpenCodeUrl();
      if (base) {
        authenticatedFetch(`${base}/kortix/preferences/model`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: `${model.providerID}/${model.modelID}` }),
        }).catch(() => {});
      }
    },
    [modelStore],
  );

  const handleContinue = useCallback(() => {
    onNext();
  }, [onNext]);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center space-y-4 py-16">
        <KortixLoader size="small" />
        <p className="text-muted-foreground/40 text-xs">
          {tHardcodedUi.raw('componentsOnboardingSetupWizard.line522JsxTextLoadingModels')}
        </p>
      </div>
    );
  }

  const hasModels = grouped.length > 0;

  return (
    <div className="mx-auto w-full max-w-sm space-y-5">
      <div className="space-y-3 text-center">
        <div className="flex items-center justify-center">
          <div className="bg-muted/60 flex h-12 w-12 items-center justify-center rounded-full">
            <Bot className="text-muted-foreground/50 h-5 w-5" />
          </div>
        </div>
        <div className="space-y-1.5">
          <h2 className="text-foreground/90 text-lg font-medium">
            {tHardcodedUi.raw('componentsOnboardingSetupWizard.line538JsxTextDefaultModel')}
          </h2>
          <p className="text-muted-foreground/50 mx-auto max-w-xs text-sm leading-relaxed">
            {hasModels
              ? 'Choose which model your agent uses by default. You can switch models anytime in chat.'
              : 'Connect a provider first to see available models.'}
          </p>
        </div>
      </div>

      {/* Model list */}
      {hasModels && (
        <div className="-mr-1 max-h-[280px] space-y-3 overflow-y-auto pr-1">
          {grouped.map(([providerID, models]) => (
            <div key={providerID} className="space-y-1">
              <div className="flex items-center gap-2 px-1 pb-1">
                <ProviderLogo providerID={providerID} name={models[0]?.providerName} size="small" />
                <span className="text-foreground/40 text-xs font-medium tracking-wider uppercase">
                  {PROVIDER_LABELS[providerID] || providerID}
                </span>
              </div>
              {models.map((model) => {
                const isSelected =
                  selected?.providerID === model.providerID && selected?.modelID === model.modelID;
                return (
                  <button
                    key={`${model.providerID}:${model.modelID}`}
                    onClick={() => handleSelect(model)}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-3 rounded-2xl border px-3 py-2 text-left transition-colors',
                      isSelected
                        ? 'border-foreground/20 bg-foreground/[0.04]'
                        : 'border-foreground/[0.06] bg-foreground/[0.01] hover:bg-foreground/[0.03]',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground/80 truncate text-sm font-medium">
                        {model.modelName}
                      </div>
                      <div className="text-foreground/30 truncate text-xs">{model.modelID}</div>
                    </div>
                    {isSelected && (
                      <Check className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="space-y-2">
        <Button onClick={handleContinue} size="lg" className="w-full shadow-none">
          {selected ? 'Continue' : 'Skip for now'} <ChevronRight className="h-4 w-4" />
        </Button>

        <div className="flex justify-center pt-1">
          <Button onClick={onBack} variant="muted" size="xs" className="mx-auto">
            <ArrowLeft className="h-3 w-3" /> Back
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Step 3: Tool secrets ───────────────────────────────────────────────────

const TOOL_SECRETS = [
  {
    key: 'TAVILY_API_KEY',
    label: 'Tavily',
    description: 'Web search',
    icon: Search,
    url: 'https://tavily.com',
  },
  {
    key: 'FIRECRAWL_API_KEY',
    label: 'Firecrawl',
    description: 'Web scraping',
    icon: Flame,
    url: 'https://firecrawl.dev',
  },
  {
    key: 'SERPER_API_KEY',
    label: 'Serper',
    description: 'Image search',
    icon: ImageIcon,
    url: 'https://serper.dev',
  },
  {
    key: 'REPLICATE_API_TOKEN',
    label: 'Replicate',
    description: 'AI media generation',
    icon: ImageIcon,
    url: 'https://replicate.com',
  },
  {
    key: 'CONTEXT7_API_KEY',
    label: 'Context7',
    description: 'Library docs search',
    icon: BookOpen,
    url: 'https://context7.com',
  },
  {
    key: 'ELEVENLABS_API_KEY',
    label: 'ElevenLabs',
    description: 'Voice generation',
    icon: Mic,
    url: 'https://elevenlabs.io',
  },
] as const;

function ToolKeysPane({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const isCloud = isBillingEnabled();
  const [modalOpen, setModalOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState(0);

  const filled = Object.values(values).filter((v) => v.trim()).length;

  const handleSave = useCallback(async () => {
    const toSave = Object.entries(values).filter(([, v]) => v.trim());
    if (toSave.length === 0) {
      setModalOpen(false);
      return;
    }

    setSaving(true);
    const base = getActiveOpenCodeUrl();
    const { succeeded, failed } = await saveToolKeys(toSave, async (key, value) => {
      const res = await authenticatedFetch(`${base}/env/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: value.trim() }),
      });
      return { ok: res.ok };
    });
    setSaving(false);
    setSavedCount(succeeded.length);

    if (failed.length > 0) {
      toast.error(
        succeeded.length > 0
          ? `Saved ${succeeded.length} of ${toSave.length} keys. Couldn't save: ${failed.join(', ')}`
          : `Couldn't save tool keys: ${failed.join(', ')}`,
      );
      // Keep the modal open so the user can retry the keys that failed.
      return;
    }
    setModalOpen(false);
  }, [values]);

  return (
    <>
      <div className="mx-auto w-full max-w-sm space-y-5">
        {/* Header */}
        <div className="space-y-3 text-center">
          <div className="flex items-center justify-center">
            <div className="bg-muted/60 flex h-12 w-12 items-center justify-center rounded-full">
              <Wrench className="text-muted-foreground/50 h-5 w-5" />
            </div>
          </div>
          <div className="space-y-1.5">
            <h2 className="text-foreground/90 text-lg font-medium">
              {tHardcodedUi.raw('componentsOnboardingSetupWizard.line660JsxTextToolApiKeys')}
            </h2>
            <p className="text-muted-foreground/50 mx-auto max-w-xs text-sm leading-relaxed">
              {tHardcodedUi.raw(
                'componentsOnboardingSetupWizard.line662JsxTextYourAgentUsesToolsLikeWebSearchScraping',
              )}
            </p>
          </div>
          {isCloud && (
            <CloudBadge
              text={tHardcodedUi.raw(
                'componentsOnboardingSetupWizard.line665JsxAttrTextIncludedWithYourKortixCredits',
              )}
            />
          )}
        </div>

        {/* Info box */}
        <div className="border-foreground/[0.06] bg-foreground/[0.02] text-muted-foreground/60 rounded-2xl border p-3.5 text-sm leading-relaxed">
          {isCloud ? (
            <>
              {tHardcodedUi.raw('componentsOnboardingSetupWizard.line672JsxTextAllToolKeysAre')}
              <span className="text-foreground/80 font-medium">pre-configured</span>
              {tHardcodedUi.raw(
                'componentsOnboardingSetupWizard.line672JsxTextAndUsageIsBilledThroughYourCreditsYou',
              )}
            </>
          ) : (
            <>
              {tHardcodedUi.raw(
                'componentsOnboardingSetupWizard.line677JsxTextAddApiKeysToEnableAgentCapabilitiesLike',
              )}
            </>
          )}
        </div>

        {/* Saved confirmation */}
        {savedCount > 0 && (
          <div className="flex items-center justify-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
            <Check className="h-3.5 w-3.5" />
            {savedCount} key{savedCount > 1 ? 's' : ''} saved
          </div>
        )}

        {/* Actions */}
        <div className="space-y-2">
          <Button
            variant="ghost"
            size="lg"
            onClick={() => setModalOpen(true)}
            className="w-full shadow-none"
          >
            <Settings2 className="h-4 w-4" />
            {isCloud ? 'Use my own API keys' : 'Configure tool keys'}
          </Button>

          <Button onClick={onNext} size="lg" className="w-full shadow-none">
            Continue <ChevronRight className="h-4 w-4" />
          </Button>

          <div className="flex justify-center pt-1">
            <Button onClick={onBack} variant="muted" size="xs" className="mx-auto">
              <ArrowLeft className="h-3 w-3" /> Back
            </Button>
          </div>
        </div>
      </div>

      {/* Configure modal */}
      <ConfigureModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={tHardcodedUi.raw('componentsOnboardingSetupWizard.line719JsxAttrTitleToolApiKeys')}
      >
        <div className="space-y-4">
          <p className="text-muted-foreground/50 text-xs leading-relaxed">
            {isCloud
              ? 'These keys will override the default Kortix-managed keys for these tools.'
              : 'Paste your API keys below. All fields are optional.'}
          </p>
          <div className="space-y-2">
            {TOOL_SECRETS.map((s) => {
              const Icon = s.icon;
              return (
                <div
                  key={s.key}
                  className="border-foreground/[0.06] bg-foreground/[0.02] flex items-start gap-3 rounded-2xl border p-2.5"
                >
                  <div className="bg-foreground/[0.05] mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-2xl">
                    <Icon className="text-foreground/40 h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-foreground/80 text-sm font-medium">{s.label}</span>
                      <span className="text-foreground/30 text-xs">{s.description}</span>
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-foreground/20 hover:text-foreground/50 ml-auto transition-colors"
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                    <Input
                      type="password"
                      placeholder={s.key}
                      value={values[s.key] || ''}
                      onChange={(e) => setValues((p) => ({ ...p, [s.key]: e.target.value }))}
                      className="h-8 font-mono text-xs"
                      autoComplete="off"
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex gap-2 pt-1">
            <Button
              variant="ghost"
              onClick={() => setModalOpen(false)}
              className="h-10 flex-1 text-sm shadow-none"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving}
              className="h-10 flex-1 text-sm shadow-none"
            >
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {tHardcodedUi.raw('componentsOnboardingSetupWizard.line769JsxTextSaving')}
                </>
              ) : filled > 0 ? (
                `Save ${filled} key${filled > 1 ? 's' : ''}`
              ) : (
                'Done'
              )}
            </Button>
          </div>
        </div>
      </ConfigureModal>
    </>
  );
}

// ─── Step 4: Get Started ────────────────────────────────────────────────────

function GetStartedPane({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="mx-auto w-full max-w-sm space-y-6">
      <div className="space-y-3 text-center">
        <div className="flex items-center justify-center">
          <div className="bg-primary/10 flex h-12 w-12 items-center justify-center rounded-full">
            <MessageSquare className="text-primary h-5 w-5" />
          </div>
        </div>
        <div className="space-y-1.5">
          <h2 className="text-foreground/90 text-lg font-medium">
            {tHardcodedUi.raw('componentsOnboardingSetupWizard.line795JsxTextYouAposReAllSet')}
          </h2>
          <p className="text-muted-foreground/50 mx-auto max-w-xs text-sm leading-relaxed">
            {tHardcodedUi.raw(
              'componentsOnboardingSetupWizard.line797JsxTextYourKortixAgentIsConfiguredAndReadyWe',
            )}
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <Button onClick={onNext} size="lg" className="w-full shadow-none">
          {tHardcodedUi.raw('componentsOnboardingSetupWizard.line807JsxTextStartOnboarding')}
          <ChevronRight className="h-4 w-4" />
        </Button>

        <div className="flex justify-center pt-1">
          <Button onClick={onBack} variant="muted" size="xs" className="mx-auto">
            <ArrowLeft className="h-3 w-3" /> Back
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Main wizard ────────────────────────────────────────────────────────────

export function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const showBilling = isBillingEnabled();

  const steps = useMemo<StepDef[]>(
    () => [
      { label: 'How It Works', icon: Key },
      { label: 'Providers', icon: Sparkles },
      ...(showBilling ? [{ label: 'Kortix Credits', icon: CreditCard }] : []),
      { label: 'Default Model', icon: Bot },
      { label: 'Tools', icon: Wrench },
      { label: 'Get Started', icon: MessageSquare },
    ],
    [showBilling],
  );

  const totalSteps = steps.length + 1; // +1 for Welcome

  const [step, setStep] = useState(0);

  const next = useCallback(() => {
    if (step < totalSteps - 1) setStep((s) => s + 1);
    else onComplete();
  }, [step, totalSteps, onComplete]);

  const back = useCallback(() => {
    if (step > 0) setStep((s) => s - 1);
  }, [step]);

  // Map current step index to the correct pane, accounting for Welcome + billing toggle
  const renderPane = useCallback(() => {
    // Step 0 is always the Welcome screen
    if (step === 0) return <WelcomePane onNext={next} />;

    // Offset by 1 for the Welcome step
    const configStep = step - 1;
    let idx = 0;
    if (configStep === idx) return <HowItWorksPane onNext={next} onBack={back} />;
    idx++;
    if (configStep === idx) return <ProvidersPane onNext={next} onBack={back} />;
    idx++;
    if (showBilling) {
      if (configStep === idx) return <AutoTopupPane onNext={next} onBack={back} />;
      idx++;
    }
    if (configStep === idx) return <DefaultModelPane onNext={next} onBack={back} />;
    idx++;
    if (configStep === idx) return <ToolKeysPane onNext={next} onBack={back} />;
    idx++;
    if (configStep === idx) return <GetStartedPane onNext={next} onBack={back} />;
    return null;
  }, [showBilling, step, next, back]);

  return (
    <div className="bg-background fixed inset-0 z-[80] flex flex-col items-center justify-center">
      {/* Back to dashboard — only on welcome step */}
      {step === 0 && (
        <Button
          onClick={() => router.push('/dashboard')}
          variant="muted"
          size="xs"
          className="absolute top-6 left-6 cursor-pointer"
        >
          <ArrowLeft className="h-3 w-3" />
          {tHardcodedUi.raw('componentsOnboardingSetupWizard.line882JsxTextBackToDashboard')}
        </Button>
      )}

      {/* Header: Logo + stepper — hidden on welcome step */}
      {step > 0 && (
        <div className="absolute inset-x-0 top-0 flex flex-col items-center gap-6 pt-8">
          <KortixLogo size={20} />
          <StepIndicator current={step - 1} steps={steps} />
        </div>
      )}

      {/* Step content */}
      <div className="w-full max-w-md px-6">
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            {renderPane()}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Footer — hidden on welcome step */}
      {step > 0 && (
        <p className="text-foreground/20 absolute bottom-6 text-xs">
          {tHardcodedUi.raw(
            'componentsOnboardingSetupWizard.line912JsxTextYouCanChangeAllOfThisLaterIn',
          )}
        </p>
      )}
    </div>
  );
}
