'use client';

import { listProjectsForAccount, type KortixProject } from '@kortix/sdk/projects-client';
import { Loader2, LogIn, MessagesSquare, Sparkles } from 'lucide-react';
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
import { installMarketplaceItemAsSession } from '@/lib/marketplace-client';

// First-party use-case templates ship in the bundled `kortix-starter` registry,
// so a use-case slug maps to the catalog id the install-session resolves by.
const TEMPLATE_CATALOG_NAMESPACE = 'kortix-starter';

export function TemplateSessionInstallDialog({
  templateId,
  title,
  open,
  onOpenChange,
}: {
  templateId: string;
  title?: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const router = useRouter();
  const { user, isLoading: authLoading } = useAuth();
  const pathname = usePathname();
  const signInHref = `/auth?returnUrl=${encodeURIComponent(pathname ?? '/')}`;

  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<KortixProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setOpening(false);
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
  }, [open, user]);

  async function openSession() {
    if (!projectId) return;
    setOpening(true);
    setError(null);
    try {
      const { session_id } = await installMarketplaceItemAsSession(
        projectId,
        `${TEMPLATE_CATALOG_NAMESPACE}:${templateId}`,
      );
      router.push(`/projects/${projectId}/sessions/${session_id}`);
    } catch (e) {
      setError((e as Error).message || 'Could not open the install session');
      setOpening(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogTitle className="sr-only">Set up {title ?? 'this automation'} with the agent</DialogTitle>

        <div className="flex flex-col p-6">
          <div className="flex items-center gap-2.5">
            <span className="bg-foreground ring-background flex size-9 items-center justify-center rounded-lg ring-4">
              <Sparkles className="text-background size-4.5" />
            </span>
            <div>
              <h3 className="text-foreground text-sm font-medium">Set it up with the agent</h3>
              <p className="text-muted-foreground text-xs">Guided install, right in your project</p>
            </div>
          </div>

          <p className="text-muted-foreground mt-4 text-sm leading-relaxed">
            We&apos;ll open a chat in your project and an agent will walk you through it — ask for the
            details it needs, connect your accounts, and turn it on when you&apos;re ready. Nothing runs
            until you say go.
          </p>

          <div className="mt-5">
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
                    Sign in to pick a project and open the install chat — we&apos;ll bring you right back
                    here.
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

          <div className="mt-5 flex items-center justify-between gap-2">
            <Button variant="ghost" size="sm" disabled={opening} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {!authLoading && !user ? (
              <Button asChild size="sm">
                <Link href={signInHref}>
                  <LogIn className="size-4" /> Sign in to continue
                </Link>
              </Button>
            ) : (
              <Button size="sm" disabled={!projectId || opening} onClick={openSession}>
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
      </DialogContent>
    </Dialog>
  );
}
