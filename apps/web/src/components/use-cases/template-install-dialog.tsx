'use client';

import {
  listProjectsForAccount,
  updateProjectTrigger,
  upsertProjectSecret,
  type KortixProject,
} from '@kortix/sdk/projects-client';
import { Bot, Check, Clock, Hash, KeyRound, Loader2, Plug, Puzzle, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToolConnect } from '@/hooks/connectors/use-tool-connect';
import {
  getTemplate,
  installTemplate,
  type TemplateDetail,
  type TemplateRequirement,
} from '@/lib/templates-client';
import { cn } from '@/lib/utils';

const STEPS = ['Review', 'Configure', 'Connect', 'Go live'] as const;

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
      <TemplateInstallDialog templateId={templateId} open={open} onOpenChange={setOpen} />
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
    listProjectsForAccount()
      .then((list) => {
        const active = (list ?? []).filter((p) => p.status === 'active');
        setProjects(active);
        setProjectId((prev) => prev || active[0]?.project_id || '');
      })
      .catch(() => setProjects([]));
  }, [open, templateId]);

  const previewConnectors = detail?.requirements.filter((r) => r.kind === 'connector') ?? [];
  const previewSecrets = detail?.requirements.filter((r) => r.kind === 'secret') ?? [];
  const previewChannels = detail?.requirements.filter((r) => r.kind === 'channel') ?? [];
  const agents = detail?.installs.filter((i) => i.type === 'registry:agent') ?? [];
  const skills = detail?.installs.filter((i) => i.type === 'registry:skill') ?? [];
  const requiredInputs = detail?.inputs.filter((i) => i.required !== false) ?? [];
  const missingInput = requiredInputs.some((i) => !inputs[i.key]?.trim());
  const selectedProject = projects.find((p) => p.project_id === projectId);

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:max-w-xl"
        onInteractOutside={(e) => {
          if (connect.isPending || installing) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (connect.isPending || installing) e.preventDefault();
        }}
      >
        <DialogTitle className="sr-only">
          Set up {detail?.title ?? 'automation'} from a template
        </DialogTitle>
        <div className="border-border/60 flex items-center gap-3 border-b px-6 py-4">
          <div className="bg-foreground text-background flex size-9 items-center justify-center rounded-lg">
            <Sparkles className="size-4.5" />
          </div>
          <div className="min-w-0">
            <p className="text-muted-foreground font-mono text-[11px] tracking-wider uppercase">
              Set up automation
            </p>
            <p className="text-foreground truncate text-sm font-medium">
              {detail?.title ?? 'Loading…'}
            </p>
          </div>
        </div>

        <div className="border-border/60 flex items-center gap-1 border-b px-6 py-3">
          {STEPS.map((s, i) => (
            <div key={s} className="flex items-center gap-1">
              <div
                className={cn(
                  'flex items-center gap-2 rounded-full px-2.5 py-1 text-xs',
                  i === step
                    ? 'bg-foreground text-background'
                    : i < step
                      ? 'text-foreground'
                      : 'text-muted-foreground',
                )}
              >
                <span className="font-mono tabular-nums">{i + 1}</span>
                <span className="hidden sm:inline">{s}</span>
              </div>
              {i < STEPS.length - 1 && <div className="bg-border h-px w-3" />}
            </div>
          ))}
        </div>

        <div className="min-h-[320px] px-6 py-5">
          {error && <p className="text-destructive mb-3 text-sm">{error}</p>}
          {!detail && !error && (
            <div className="text-muted-foreground flex h-[280px] items-center justify-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" /> Loading template…
            </div>
          )}

          {detail && step === 0 && (
            <div className="space-y-4">
              <p className="text-muted-foreground text-sm leading-relaxed">{detail.description}</p>
              <p className="text-muted-foreground font-mono text-[11px] tracking-wider uppercase">
                This sets up
              </p>
              <ul className="space-y-2">
                {agents.map((a) => (
                  <SetupRow key={a.name} icon={<Bot className="size-4" />} label={`Agent · ${a.name}`} tag="New" />
                ))}
                {previewConnectors.map((c) => (
                  <SetupRow key={c.key} icon={<Plug className="size-4" />} label={c.label} tag="Connect" />
                ))}
                {previewChannels.map((c) => (
                  <SetupRow
                    key={c.key}
                    icon={<Hash className="size-4" />}
                    label={`${c.label} channel`}
                    tag="Optional"
                  />
                ))}
                {detail.inputs.some((i) => i.type === 'cron') && (
                  <SetupRow icon={<Clock className="size-4" />} label="Schedule" tag="New" />
                )}
                {previewSecrets.map((s) => (
                  <SetupRow key={s.key} icon={<KeyRound className="size-4" />} label={s.label} tag="You provide" tone="req" />
                ))}
                {skills.map((s) => (
                  <SetupRow key={s.name} icon={<Puzzle className="size-4" />} label={`Skill · ${s.name}`} tag="New" />
                ))}
              </ul>
              <div className="pt-1">
                <p className="text-muted-foreground mb-2 font-mono text-[11px] tracking-wider uppercase">
                  Install into
                </p>
                {projects.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    Sign in and create a project to install this template.
                  </p>
                ) : (
                  <select
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                    className="border-input bg-background text-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-1 focus-visible:outline-none"
                  >
                    {projects.map((p) => (
                      <option key={p.project_id} value={p.project_id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          )}

          {detail && step === 1 && (
            <div className="space-y-5">
              <p className="text-muted-foreground text-sm">
                Set the template's options. You can change these any time later.
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
                Committed to your project. Now connect the accounts and add the key — brokered
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
                      done && 'border-emerald-500/40 bg-emerald-500/[0.04]',
                    )}
                  >
                    <Plug className="text-muted-foreground size-4" />
                    <div className="min-w-0 flex-1">
                      <p className="text-foreground text-sm font-medium capitalize">{c.label}</p>
                      {c.provider && <p className="text-muted-foreground text-xs">via {c.provider}</p>}
                    </div>
                    {done ? (
                      <span className="flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
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
                return (
                  <div
                    key={s.key}
                    className={cn(
                      'border-border/60 rounded-xl border px-4 py-3',
                      done && 'border-emerald-500/40 bg-emerald-500/[0.04]',
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <KeyRound className="text-muted-foreground size-4" />
                      <p className="text-foreground flex-1 text-sm font-medium">{s.label}</p>
                      {done && (
                        <span className="flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
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
                  <Hash className="text-muted-foreground size-4" />
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground text-sm font-medium">{c.label}</p>
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
                Here's what will run once you turn it on.
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
                  You can turn it on now and finish connecting later — runs will wait on anything
                  that isn't connected yet.
                </p>
              )}
              <div className="bg-muted/40 border-border/60 rounded-xl border p-3">
                <p className="text-foreground text-xs font-medium">Guarded by default</p>
                <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                  Sensitive steps stop at an approval gate before they run. You review, then it goes.
                </p>
              </div>
            </div>
          )}

          {detail && step === 3 && installed && live && (
            <div className="flex h-[280px] flex-col items-center justify-center text-center">
              <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <Check className="size-7" />
              </div>
              <p className="text-foreground text-base font-medium">It's live</p>
              <p className="text-muted-foreground mx-auto mt-1.5 max-w-xs text-sm leading-relaxed">
                The schedule is on. It makes its first run at the next scheduled time — watch it land
                in your project.
              </p>
            </div>
          )}
        </div>

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
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={activating}
                  onClick={() => onOpenChange(false)}
                >
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
              {step === 0 && (
                <Button size="sm" disabled={!detail || !projectId} onClick={() => setStep(1)}>
                  Continue
                </Button>
              )}
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
      </DialogContent>
    </Dialog>
  );
}

function SetupRow({
  icon,
  label,
  tag,
  tone = 'new',
}: {
  icon: React.ReactNode;
  label: string;
  tag: string;
  tone?: 'new' | 'reuse' | 'req';
}) {
  return (
    <li className="border-border/60 flex items-center gap-3 rounded-lg border px-3 py-2.5">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-foreground flex-1 text-sm font-medium">{label}</span>
      <Badge
        variant="outline"
        className={cn(
          'font-mono text-[10px] tracking-wider uppercase',
          tone === 'reuse' && 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
          tone === 'req' && 'border-amber-500/40 text-amber-600 dark:text-amber-400',
        )}
      >
        {tag}
      </Badge>
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
