'use client';

/* eslint-disable @next/next/no-img-element */

import {
  listProjectsForAccount,
  updateProjectTrigger,
  upsertProjectSecret,
  type KortixProject,
} from '@kortix/sdk/projects-client';
import { Bot, Check, Clock, KeyRound, Loader2, LogIn, Plug, Puzzle, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from '@/components/ui/stepper';
import { useAuth } from '@/features/providers/auth-provider';
import { useToolConnect } from '@/hooks/connectors/use-tool-connect';
import {
  getTemplate,
  installTemplate,
  type TemplateDetail,
  type TemplateRequirement,
} from '@/lib/templates-client';
import { cn } from '@/lib/utils';

import { TemplateSessionInstallDialog } from './template-session-install-dialog';

const STEPS = ['Review', 'Configure', 'Connect', 'Go live'] as const;

// V2: when on, "Use this template" opens a guided install *session* in the
// project (an agent sets it up in chat) instead of the multi-step wizard.
const SESSION_INSTALL = process.env.NEXT_PUBLIC_TEMPLATE_SESSION_INSTALL === 'true';

// ── brand logos via the public Simple Icons CDN (cdn.simpleicons.org/<slug>) ──
const LOGO_ALIAS: Record<string, string> = { gh: 'github' };

function brandFor(name: string): string | null {
  const n = name.toLowerCase();
  if (n.includes('github') || n.startsWith('gh_') || n.startsWith('gh-')) return 'github';
  if (n.includes('stripe')) return 'stripe';
  if (n.includes('slack')) return 'slack';
  if (n.includes('linear')) return 'linear';
  if (n.includes('gmail')) return 'gmail';
  if (n.includes('google')) return 'google';
  if (n.includes('notion')) return 'notion';
  if (n.includes('openai')) return 'openai';
  if (n.includes('hubspot')) return 'hubspot';
  return null;
}

function Logo({ slug, className }: { slug: string; className?: string }) {
  const [err, setErr] = useState(false);
  const brand = LOGO_ALIAS[slug] ?? slug;
  if (err) return <Plug className={cn('text-muted-foreground size-5', className)} />;
  return (
    <img
      src={`https://cdn.simpleicons.org/${encodeURIComponent(brand)}`}
      alt=""
      className={cn('size-5 object-contain', className)}
      onError={() => setErr(true)}
    />
  );
}

/** White chip holding a brand logo — the connector/app tile. */
function LogoTile({ slug, className }: { slug: string; className?: string }) {
  return (
    <span
      className={cn(
        'ring-border/70 flex size-9 items-center justify-center rounded-lg bg-white shadow-sm ring-1',
        className,
      )}
    >
      <Logo slug={slug} />
    </span>
  );
}

export function UseTemplateButton({
  templateId,
  className,
  variant,
  size,
  label = 'Use this template',
}: {
  templateId: string;
  className?: string;
  variant?: React.ComponentProps<typeof Button>['variant'];
  size?: React.ComponentProps<typeof Button>['size'];
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button className={className} variant={variant} size={size} onClick={() => setOpen(true)}>
        <Sparkles className="size-4" />
        {label}
      </Button>
      {SESSION_INSTALL ? (
        <TemplateSessionInstallDialog templateId={templateId} open={open} onOpenChange={setOpen} />
      ) : (
        <TemplateInstallDialog templateId={templateId} open={open} onOpenChange={setOpen} />
      )}
    </>
  );
}

interface Installed {
  projectId: string;
  requirements: TemplateRequirement[];
  triggerSlugs: string[];
}

function TemplateInstallDialog({
  templateId,
  open,
  onOpenChange,
}: {
  templateId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [step, setStep] = useState(0);
  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [projects, setProjects] = useState<KortixProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState<Installed | null>(null);

  const [connectedSlugs, setConnectedSlugs] = useState<Set<string>>(new Set());
  const [savedSecrets, setSavedSecrets] = useState<Set<string>>(new Set());
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [savingSecret, setSavingSecret] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [activating, setActivating] = useState(false);

  const { user, isLoading: authLoading } = useAuth();
  const pathname = usePathname();
  const signInHref = `/auth?returnUrl=${encodeURIComponent(pathname ?? '/')}`;

  const connect = useToolConnect(projectId, () => {});

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setError(null);
    setDetail(null);
    setInstalled(null);
    setInstalling(false);
    setConnectedSlugs(new Set());
    setSavedSecrets(new Set());
    setSecretValues({});
    setLive(false);
    setActivating(false);
    getTemplate(templateId)
      .then((d) => {
        setDetail(d);
        const seed: Record<string, string> = {};
        for (const inp of d.inputs) if (inp.default) seed[inp.key] = inp.default;
        setInputs(seed);
      })
      .catch((e: Error) => setError(e.message));
    if (!user) {
      setProjects([]);
      setProjectId('');
      return;
    }
    listProjectsForAccount()
      .then((list) => {
        const active = (list ?? []).filter((p) => p.status === 'active');
        setProjects(active);
        setProjectId((prev) => prev || active[0]?.project_id || '');
      })
      .catch(() => setProjects([]));
  }, [open, templateId, user]);

  const previewConnectors = detail?.requirements.filter((r) => r.kind === 'connector') ?? [];
  const previewSecrets = detail?.requirements.filter((r) => r.kind === 'secret') ?? [];
  const previewChannels = detail?.requirements.filter((r) => r.kind === 'channel') ?? [];
  const agents = detail?.installs.filter((i) => i.type === 'registry:agent') ?? [];
  const skills = detail?.installs.filter((i) => i.type === 'registry:skill') ?? [];
  const hasSchedule = detail?.inputs.some((i) => i.type === 'cron') ?? false;
  const requiredInputs = detail?.inputs.filter((i) => i.required !== false) ?? [];
  const missingInput = requiredInputs.some((i) => !inputs[i.key]?.trim());
  const selectedProject = projects.find((p) => p.project_id === projectId);

  // Brand logos for the cover — connectors, channels, and apps inferred from secrets.
  const appSlugs = Array.from(
    new Set(
      [
        ...previewConnectors.map((c) => c.key),
        ...previewChannels.map((c) => c.key),
        ...previewSecrets.map((s) => brandFor(s.key)),
      ].filter(Boolean) as string[],
    ),
  ).slice(0, 4);

  const installConnectors = installed?.requirements.filter((r) => r.kind === 'connector') ?? [];
  const installSecrets = installed?.requirements.filter((r) => r.kind === 'secret') ?? [];
  const installChannels = installed?.requirements.filter((r) => r.kind === 'channel') ?? [];
  const allConnected = installConnectors.every((c) => connectedSlugs.has(c.key));
  const allSecretsSaved = installSecrets.every((s) => savedSecrets.has(s.key));

  async function runInstall() {
    if (!projectId) return;
    setInstalling(true);
    setError(null);
    try {
      const res = await installTemplate(templateId, { project_id: projectId, inputs });
      const reqs = res.requirements ?? [];
      setInstalled({
        projectId: res.project_id,
        requirements: reqs,
        triggerSlugs: res.trigger_slugs ?? [],
      });
      setConnectedSlugs(
        new Set(reqs.filter((r) => r.kind === 'connector' && r.status === 'reused').map((r) => r.key)),
      );
      setSavedSecrets(
        new Set(reqs.filter((r) => r.kind === 'secret' && r.status === 'reused').map((r) => r.key)),
      );
      setStep(2);
    } catch (e) {
      setError((e as Error).message || 'Install failed');
    } finally {
      setInstalling(false);
    }
  }

  async function handleConnect(slug: string) {
    const res = await connect.mutateAsync(slug).catch(() => null);
    if (res?.connected) setConnectedSlugs((p) => new Set(p).add(slug));
  }

  async function saveSecret(name: string) {
    const value = secretValues[name]?.trim();
    if (!value || !projectId) return;
    setSavingSecret(name);
    setError(null);
    try {
      await upsertProjectSecret(projectId, { name, value });
      setSavedSecrets((p) => new Set(p).add(name));
    } catch (e) {
      setError((e as Error).message || 'Could not save the key');
    } finally {
      setSavingSecret(null);
    }
  }

  async function activate() {
    if (!installed || installed.triggerSlugs.length === 0) return;
    setActivating(true);
    setError(null);
    try {
      await Promise.all(
        installed.triggerSlugs.map((slug) =>
          updateProjectTrigger(installed.projectId, slug, { enabled: true }),
        ),
      );
      setLive(true);
    } catch (e) {
      setError((e as Error).message || 'Could not turn it on');
    } finally {
      setActivating(false);
    }
  }

  const busyGuard = connect.isPending || installing || activating;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[92vh] gap-0 overflow-hidden p-0 sm:max-w-3xl"
        onInteractOutside={(e) => busyGuard && e.preventDefault()}
        onEscapeKeyDown={(e) => busyGuard && e.preventDefault()}
      >
        <DialogTitle className="sr-only">
          Set up {detail?.title ?? 'automation'} from a template
        </DialogTitle>

        <div className="grid sm:grid-cols-[300px_1fr]">
          {/* ── Left: cover ──────────────────────────────────────────────── */}
          <aside className="from-muted/60 via-background to-primary/[0.08] border-border/60 relative hidden flex-col gap-6 border-r bg-gradient-to-br p-6 sm:flex">
            <div className="absolute inset-0 bg-[url('/grain-texture.png')] bg-repeat opacity-[0.08]" />
            <div className="relative flex flex-col gap-5">
              <div className="flex items-center -space-x-2">
                <span className="bg-foreground ring-background flex size-9 items-center justify-center rounded-lg ring-4">
                  <Sparkles className="text-background size-4.5" />
                </span>
                {appSlugs.map((slug) => (
                  <LogoTile key={slug} slug={slug} className="ring-background ring-4" />
                ))}
              </div>
              <div>
                <p className="text-muted-foreground font-mono text-[11px] tracking-wider uppercase">
                  Set up automation
                </p>
                {detail ? (
                  <h2 className="text-foreground mt-1 text-lg leading-snug font-medium text-balance">
                    {detail.title}
                  </h2>
                ) : (
                  <div className="mt-2 space-y-1.5">
                    <div className="bg-foreground/10 h-4 w-4/5 animate-pulse rounded" />
                    <div className="bg-foreground/10 h-4 w-2/5 animate-pulse rounded" />
                  </div>
                )}
              </div>
            </div>

            <div className="relative">
              <p className="text-muted-foreground mb-2.5 font-mono text-[11px] tracking-wider uppercase">
                What it sets up
              </p>
              <ul className="space-y-1.5">
                {!detail &&
                  [0, 1, 2].map((i) => (
                    <li key={i} className="flex items-center gap-2.5">
                      <span className="bg-foreground/10 size-6 shrink-0 animate-pulse rounded" />
                      <span className="bg-foreground/10 h-3.5 w-28 animate-pulse rounded" />
                    </li>
                  ))}
                {agents.map((a) => (
                  <CoverItem key={a.name} icon={<Bot className="size-3.5" />} label={`Agent · ${a.name}`} />
                ))}
                {previewConnectors.map((c) => (
                  <CoverItem key={c.key} icon={<Logo slug={c.key} className="size-3.5" />} label={c.label} />
                ))}
                {previewChannels.map((c) => (
                  <CoverItem key={c.key} icon={<Logo slug={c.key} className="size-3.5" />} label={`${c.label} channel`} />
                ))}
                {hasSchedule && <CoverItem icon={<Clock className="size-3.5" />} label="Schedule" />}
                {previewSecrets.map((s) => (
                  <CoverItem key={s.key} icon={<KeyRound className="size-3.5" />} label={s.label} />
                ))}
                {skills.map((s) => (
                  <CoverItem key={s.name} icon={<Puzzle className="size-3.5" />} label={`Skill · ${s.name}`} />
                ))}
              </ul>
            </div>

            <p className="text-muted-foreground/80 relative mt-auto text-xs leading-relaxed">
              Guarded by default — sensitive steps stop at an approval gate before they run.
            </p>
          </aside>

          {/* ── Right: working area ──────────────────────────────────────── */}
          <div className="flex min-h-[540px] flex-col">
            <div className="border-border/60 border-b py-4 pr-14 pl-6">
              <Stepper value={step} count={STEPS.length} className="w-full">
                {STEPS.map((s, i) => (
                  <StepperItem key={s} step={i} completed={live && i === 3} className="not-last:flex-1">
                    <StepperTrigger className="gap-2" tabIndex={-1}>
                      <StepperIndicator>
                        {i < step || (live && i === 3) ? <Check className="size-3.5" /> : i + 1}
                      </StepperIndicator>
                      <StepperTitle className="hidden text-xs sm:block">{s}</StepperTitle>
                    </StepperTrigger>
                    {i < STEPS.length - 1 && <StepperSeparator />}
                  </StepperItem>
                ))}
              </Stepper>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              {error && <p className="text-destructive mb-3 text-sm">{error}</p>}
              {!detail && !error && (
                <div className="text-muted-foreground flex h-[320px] items-center justify-center gap-2 text-sm">
                  <Loader2 className="size-4 animate-spin" /> Loading template…
                </div>
              )}

              {detail && step === 0 && (
                <div className="space-y-5">
                  <p className="text-muted-foreground text-sm leading-relaxed">{detail.description}</p>

                  {authLoading ? (
                    <div className="text-muted-foreground flex items-center gap-2 text-sm">
                      <Loader2 className="size-4 animate-spin" /> Checking your account…
                    </div>
                  ) : !user ? (
                    <div className="border-border/60 bg-muted/30 flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-8 text-center">
                      <span className="bg-foreground text-background flex size-11 items-center justify-center rounded-xl">
                        <LogIn className="size-5" />
                      </span>
                      <div>
                        <p className="text-foreground text-sm font-medium">
                          Sign in to install this automation
                        </p>
                        <p className="text-muted-foreground mx-auto mt-1 max-w-xs text-xs leading-relaxed">
                          You&apos;re previewing everything it sets up. Sign in to pick a project and
                          install — we&apos;ll bring you right back here.
                        </p>
                      </div>
                    </div>
                  ) : projects.length === 0 ? (
                    <div className="border-border/60 bg-muted/30 rounded-xl border px-4 py-4">
                      <p className="text-foreground text-sm font-medium">No projects yet</p>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        Create a project first, then come back to install this template into it.
                      </p>
                      <Button asChild size="sm" variant="outline" className="mt-3">
                        <Link href="/projects">Go to projects</Link>
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <Label className="text-sm">Install into</Label>
                      <Select value={projectId} onValueChange={setProjectId}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Choose a project" />
                        </SelectTrigger>
                        <SelectContent>
                          {projects.map((p) => (
                            <SelectItem key={p.project_id} value={p.project_id}>
                              {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-muted-foreground text-xs">
                        Nothing runs yet — you&apos;ll connect accounts and turn it on at the end.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {detail && step === 1 && (
                <div className="space-y-5">
                  <p className="text-muted-foreground text-sm">
                    Set the template&apos;s options. You can change these any time later.
                  </p>
                  {detail.inputs.map((inp) => (
                    <div key={inp.key} className="space-y-1.5">
                      <Label htmlFor={inp.key} className="text-sm">
                        {inp.label}
                      </Label>
                      <Input
                        id={inp.key}
                        value={inputs[inp.key] ?? ''}
                        placeholder={inp.default}
                        onChange={(e) => setInputs((p) => ({ ...p, [inp.key]: e.target.value }))}
                      />
                      {inp.help && <p className="text-muted-foreground text-xs">{inp.help}</p>}
                    </div>
                  ))}
                </div>
              )}

              {detail && step === 2 && installed && (
                <div className="space-y-3">
                  <p className="text-muted-foreground text-sm">
                    Committed to your project. Connect the accounts and add the key — brokered
                    server-side, so a raw token never reaches the agent.
                  </p>
                  {installConnectors.map((c) => {
                    const done = connectedSlugs.has(c.key);
                    const busy = connect.isPending && connect.variables === c.key;
                    return (
                      <div
                        key={c.key}
                        className={cn(
                          'border-border/60 flex items-center gap-3 rounded-xl border px-4 py-3',
                          done && 'border-kortix-green/40 bg-kortix-green/[0.05]',
                        )}
                      >
                        <LogoTile slug={c.key} />
                        <div className="min-w-0 flex-1">
                          <p className="text-foreground text-sm font-medium capitalize">{c.label}</p>
                          {c.provider && (
                            <p className="text-muted-foreground text-xs">via {c.provider}</p>
                          )}
                        </div>
                        {done ? (
                          <span className="text-kortix-green flex items-center gap-1 text-xs font-medium">
                            <Check className="size-3.5" /> Connected
                          </span>
                        ) : (
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => handleConnect(c.key)}>
                            {busy ? <Loader2 className="size-3.5 animate-spin" /> : 'Connect'}
                          </Button>
                        )}
                      </div>
                    );
                  })}
                  {installSecrets.map((s) => {
                    const done = savedSecrets.has(s.key);
                    const brand = brandFor(s.key);
                    return (
                      <div
                        key={s.key}
                        className={cn(
                          'border-border/60 rounded-xl border px-4 py-3',
                          done && 'border-kortix-green/40 bg-kortix-green/[0.05]',
                        )}
                      >
                        <div className="flex items-center gap-3">
                          {brand ? (
                            <LogoTile slug={brand} />
                          ) : (
                            <span className="bg-muted flex size-9 items-center justify-center rounded-lg">
                              <KeyRound className="text-muted-foreground size-4" />
                            </span>
                          )}
                          <p className="text-foreground flex-1 text-sm font-medium">{s.label}</p>
                          {done && (
                            <span className="text-kortix-green flex items-center gap-1 text-xs font-medium">
                              <Check className="size-3.5" /> Saved
                            </span>
                          )}
                        </div>
                        {!done && (
                          <div className="mt-2.5 flex gap-2">
                            <Input
                              type="password"
                              placeholder={`Paste ${s.key}`}
                              value={secretValues[s.key] ?? ''}
                              onChange={(e) =>
                                setSecretValues((p) => ({ ...p, [s.key]: e.target.value }))
                              }
                            />
                            <Button
                              size="sm"
                              disabled={savingSecret === s.key || !secretValues[s.key]?.trim()}
                              onClick={() => saveSecret(s.key)}
                            >
                              {savingSecret === s.key ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                'Save'
                              )}
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {installChannels.map((c) => (
                    <div
                      key={c.key}
                      className="border-border/60 flex items-center gap-3 rounded-xl border border-dashed px-4 py-3"
                    >
                      <LogoTile slug={c.key} />
                      <div className="min-w-0 flex-1">
                        <p className="text-foreground text-sm font-medium capitalize">{c.label}</p>
                        <p className="text-muted-foreground text-xs">
                          Optional — connect from Settings → Channels any time
                        </p>
                      </div>
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/projects/${installed.projectId}`}>Open</Link>
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {detail && step === 3 && installed && !live && (
                <div className="space-y-4">
                  <p className="text-muted-foreground text-sm">
                    Here&apos;s what will run once you turn it on.
                  </p>
                  <div className="border-border/60 divide-border/60 divide-y rounded-xl border text-sm">
                    <RecapRow k="Automation" v={detail.title} />
                    {detail.inputs.map((inp) => (
                      <RecapRow key={inp.key} k={inp.label} v={inputs[inp.key] || inp.default || '—'} />
                    ))}
                    <RecapRow
                      k="Connected"
                      v={
                        installConnectors
                          .filter((c) => connectedSlugs.has(c.key))
                          .map((c) => c.label)
                          .join(' · ') || 'none yet'
                      }
                    />
                  </div>
                  {(!allConnected || !allSecretsSaved) && (
                    <p className="text-muted-foreground text-xs">
                      You can turn it on now and finish connecting later — runs wait on anything
                      that isn&apos;t connected yet.
                    </p>
                  )}
                </div>
              )}

              {detail && step === 3 && installed && live && (
                <div className="flex h-[320px] flex-col items-center justify-center text-center">
                  <div className="bg-kortix-green/10 text-kortix-green mb-4 flex size-14 items-center justify-center rounded-2xl">
                    <Check className="size-7" />
                  </div>
                  <p className="text-foreground text-base font-medium">It&apos;s live</p>
                  <p className="text-muted-foreground mx-auto mt-1.5 max-w-xs text-sm leading-relaxed">
                    The schedule is on. It makes its first run at the next scheduled time — watch it
                    land in your project.
                  </p>
                </div>
              )}
            </div>

            {/* ── Footer ────────────────────────────────────────────────── */}
            <div className="border-border/60 flex items-center justify-between gap-2 border-t px-6 py-4">
              {step === 3 && installed ? (
                live ? (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                      Close
                    </Button>
                    <Button asChild size="sm">
                      <Link href={`/projects/${installed.projectId}`}>Open project</Link>
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="ghost" size="sm" disabled={activating} onClick={() => onOpenChange(false)}>
                      Not now
                    </Button>
                    <Button
                      size="sm"
                      disabled={activating || installed.triggerSlugs.length === 0}
                      onClick={activate}
                    >
                      {activating ? (
                        <>
                          <Loader2 className="size-4 animate-spin" /> Turning on…
                        </>
                      ) : (
                        <>
                          <Sparkles className="size-4" /> Turn it on
                        </>
                      )}
                    </Button>
                  </>
                )
              ) : (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={step === 0 || installing || step >= 2}
                    onClick={() => setStep((s) => Math.max(0, s - 1))}
                  >
                    Back
                  </Button>
                  {step === 0 &&
                    (authLoading ? (
                      <Button size="sm" disabled>
                        Continue
                      </Button>
                    ) : !user ? (
                      <Button asChild size="sm" disabled={!detail}>
                        <Link href={signInHref}>
                          <LogIn className="size-4" /> Sign in to continue
                        </Link>
                      </Button>
                    ) : (
                      <Button size="sm" disabled={!detail || !projectId} onClick={() => setStep(1)}>
                        Continue
                      </Button>
                    ))}
                  {step === 1 && (
                    <Button size="sm" disabled={!projectId || missingInput || installing} onClick={runInstall}>
                      {installing ? (
                        <>
                          <Loader2 className="size-4 animate-spin" /> Installing…
                        </>
                      ) : (
                        <>
                          <Check className="size-4" /> Install into {selectedProject?.name ?? 'project'}
                        </>
                      )}
                    </Button>
                  )}
                  {step === 2 && (
                    <Button size="sm" onClick={() => setStep(3)}>
                      {allConnected && allSecretsSaved ? 'Finish' : 'Finish later'}
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CoverItem({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <li className="flex items-center gap-2.5">
      <span className="text-muted-foreground flex size-6 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="text-foreground/90 truncate text-[13px]">{label}</span>
    </li>
  );
}

function RecapRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <span className="text-muted-foreground w-28 shrink-0 text-xs">{k}</span>
      <span className="text-foreground font-medium">{v}</span>
    </div>
  );
}
