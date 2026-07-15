'use client';

import {
  createProjectSession,
  listProjectsForAccount,
  type KortixProject,
} from '@kortix/sdk/projects-client';
import { Bot, Clock, KeyRound, Loader2, LogIn, MessagesSquare, Plug, Puzzle, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAuth } from '@/features/providers/auth-provider';
import { getTemplate, type TemplateDetail } from '@/lib/templates-client';
import { cn } from '@/lib/utils';

/** The opening turn the in-session agent receives — it drives the install as a chat. */
export function installSessionPrompt(d: TemplateDetail): string {
  return [
    `Help me install the "${d.title}" automation into this project. It's a Kortix use-case template (id: \`${d.id}\`).`,
    '',
    "Set it up as a short guided conversation — don't dump a form on me:",
    '1. First, tell me in a line or two what this adds (agent, schedule, what it does) and what you\'ll need from me (accounts, keys, a channel).',
    `2. Read the template's inputs and requirements first: \`kortix marketplace show ${d.id}\`.`,
    '3. Ask me for each input it needs — the repo, the schedule, the channel — pre-filling the template\'s defaults.',
    `4. Install it into this project with my answers: \`kortix marketplace install ${d.id} --project "$KORTIX_PROJECT_ID" --input key=value\` (one \`--input\` per value). That renders the inputs, merges its trigger/connector block into \`kortix.yaml\`, and commits — the trigger installs DISABLED.`,
    '5. Walk me through connecting what it needs — connectors in Settings → Connectors, API keys in Settings → Secrets, a Slack channel in Settings → Channels. Never ask me to paste a secret into the chat.',
    '6. Only after I confirm and the required accounts are connected, turn it on (enable its trigger).',
    "7. Confirm it's live and tell me when it first runs.",
    '',
    "Keep it brief and don't run anything until I say go.",
  ].join('\n');
}

export function TemplateSessionInstallDialog({
  templateId,
  open,
  onOpenChange,
}: {
  templateId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const router = useRouter();
  const { user, isLoading: authLoading } = useAuth();
  const pathname = usePathname();
  const signInHref = `/auth?returnUrl=${encodeURIComponent(pathname ?? '/')}`;

  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<KortixProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setDetail(null);
    setOpening(false);
    getTemplate(templateId)
      .then(setDetail)
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

  const connectors = detail?.requirements.filter((r) => r.kind === 'connector') ?? [];
  const secrets = detail?.requirements.filter((r) => r.kind === 'secret') ?? [];
  const channels = detail?.requirements.filter((r) => r.kind === 'channel') ?? [];
  const agents = detail?.installs.filter((i) => i.type === 'registry:agent') ?? [];
  const skills = detail?.installs.filter((i) => i.type === 'registry:skill') ?? [];
  const hasSchedule = detail?.inputs.some((i) => i.type === 'cron') ?? false;

  async function openSession() {
    if (!detail || !projectId) return;
    setOpening(true);
    setError(null);
    try {
      const sessionId = crypto.randomUUID();
      await createProjectSession(projectId, {
        session_id: sessionId,
        // Bind the base general agent explicitly — it's a declared agent in every
        // standard project, so this works even when the project has no
        // default_agent set (which `require_declared_agents` would otherwise reject).
        agent_name: 'kortix',
        initial_prompt: installSessionPrompt(detail),
      });
      router.push(`/projects/${projectId}/sessions/${sessionId}`);
    } catch (e) {
      setError((e as Error).message || 'Could not open the install session');
      setOpening(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogTitle className="sr-only">
          Set up {detail?.title ?? 'automation'} with the agent
        </DialogTitle>

        <div className="grid sm:grid-cols-[260px_1fr]">
          {/* ── Left: cover ─────────────────────────────────────────────── */}
          <aside className="from-muted/60 via-background to-primary/[0.08] border-border/60 relative hidden flex-col gap-5 border-r bg-gradient-to-br p-6 sm:flex">
            <div className="relative flex flex-col gap-4">
              <span className="bg-foreground ring-background flex size-9 items-center justify-center rounded-lg ring-4">
                <Sparkles className="text-background size-4.5" />
              </span>
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
                {connectors.map((c) => (
                  <CoverItem key={c.key} icon={<Plug className="size-3.5" />} label={c.label} />
                ))}
                {channels.map((c) => (
                  <CoverItem key={c.key} icon={<Plug className="size-3.5" />} label={`${c.label} channel`} />
                ))}
                {hasSchedule && <CoverItem icon={<Clock className="size-3.5" />} label="Schedule" />}
                {secrets.map((s) => (
                  <CoverItem key={s.key} icon={<KeyRound className="size-3.5" />} label={s.label} />
                ))}
                {skills.map((s) => (
                  <CoverItem key={s.name} icon={<Puzzle className="size-3.5" />} label={`Skill · ${s.name}`} />
                ))}
              </ul>
            </div>

            <p className="text-muted-foreground/80 relative mt-auto text-xs leading-relaxed">
              Guarded by default — nothing runs until you turn it on in the chat.
            </p>
          </aside>

          {/* ── Right: open-session panel ───────────────────────────────── */}
          <div className="flex min-h-[420px] flex-col p-6">
            <div className="flex items-center gap-2.5">
              <span className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
                <MessagesSquare className="size-4.5" />
              </span>
              <div>
                <h3 className="text-foreground text-sm font-medium">Set it up with the agent</h3>
                <p className="text-muted-foreground text-xs">Guided install, right in your project</p>
              </div>
            </div>

            <p className="text-muted-foreground mt-4 text-sm leading-relaxed">
              We&apos;ll open a chat in your project and an agent will walk you through it — ask for
              the details it needs, connect your accounts, and turn it on when you&apos;re ready.
            </p>

            <div className="mt-5 flex-1">
              {error && <p className="text-destructive mb-3 text-sm">{error}</p>}

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
                    <p className="text-foreground text-sm font-medium">Sign in to install this automation</p>
                    <p className="text-muted-foreground mx-auto mt-1 max-w-xs text-xs leading-relaxed">
                      Sign in to pick a project and open the install chat — we&apos;ll bring you right
                      back here.
                    </p>
                  </div>
                </div>
              ) : projects.length === 0 ? (
                <div className="border-border/60 bg-muted/30 rounded-xl border px-4 py-4">
                  <p className="text-foreground text-sm font-medium">No projects yet</p>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    Create a project first, then come back to set this up.
                  </p>
                  <Button asChild size="sm" variant="outline" className="mt-3">
                    <Link href="/projects">Go to projects</Link>
                  </Button>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label className="text-sm">Open the install chat in</Label>
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
                </div>
              )}
            </div>

            <div className="mt-4 flex items-center justify-between gap-2">
              <Button variant="ghost" size="sm" disabled={opening} onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              {!authLoading && !user ? (
                <Button asChild size="sm" disabled={!detail}>
                  <Link href={signInHref}>
                    <LogIn className="size-4" /> Sign in to continue
                  </Link>
                </Button>
              ) : (
                <Button size="sm" disabled={!detail || !projectId || opening} onClick={openSession}>
                  {opening ? (
                    <>
                      <Loader2 className="size-4 animate-spin" /> Opening chat…
                    </>
                  ) : (
                    <>
                      <MessagesSquare className="size-4" /> Open install session
                    </>
                  )}
                </Button>
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
