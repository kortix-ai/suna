'use client';

// Self-host: create + connect the platform's GitHub App entirely from the web
// UI — click "Create GitHub App" → GitHub's create+install flow → back here,
// connected. No CLI, no SSH. Only relevant in single-account mode; on cloud
// the App is env-configured (`configured` is always true and `source` is
// 'env'), so the create-form branch never renders there — see the
// isSingleAccountMode() gate at the call site in accounts/[id]/page.tsx.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Github } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  type GitHubAppStatus,
  getGitHubAppStatus,
  startGitHubAppManifest,
} from '@kortix/sdk/platform-client';

const GITHUB_APP_STATUS_KEY = ['github-app-status'];

/**
 * Build + submit a same-window POST form to GitHub's "create app from
 * manifest" endpoint. GitHub only accepts the manifest via a POST body field
 * (`manifest`, JSON-stringified) with `state` as a query param on the
 * action URL — a GET or a client-side redirect won't do, so this constructs
 * a real <form> in the DOM and submits it, which navigates the browser away
 * from the SPA to GitHub.
 */
function submitManifestForm(
  githubCreateUrl: string,
  state: string,
  manifest: Record<string, unknown>,
) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = `${githubCreateUrl}${githubCreateUrl.includes('?') ? '&' : '?'}state=${encodeURIComponent(state)}`;
  form.style.display = 'none';
  const field = document.createElement('input');
  field.type = 'hidden';
  field.name = 'manifest';
  field.value = JSON.stringify(manifest);
  form.appendChild(field);
  document.body.appendChild(form);
  form.submit();
}

interface GitHubAppSetupCardProps {
  canManage: boolean;
}

export function GitHubAppSetupCard({ canManage }: GitHubAppSetupCardProps) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [org, setOrg] = useState('');
  const [reconfiguring, setReconfiguring] = useState(false);

  const statusQuery = useQuery({
    queryKey: GITHUB_APP_STATUS_KEY,
    queryFn: () => getGitHubAppStatus(),
    staleTime: 10_000,
  });

  // GitHub's install flow ends with the backend 302-ing back here with
  // `?github=connected` once the app is created + installed. Surface it once,
  // strip the param so a refresh doesn't re-toast, and refetch status so the
  // connected view appears without a manual reload.
  const githubReturnFlag = searchParams.get('github');
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally only reacts to the `github` flag — re-running on every searchParams/queryClient identity change (incl. our own replace() below) would loop.
  useEffect(() => {
    if (githubReturnFlag !== 'connected') return;
    successToast('GitHub connected');
    const next = new URLSearchParams(searchParams.toString());
    next.delete('github');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    queryClient.invalidateQueries({ queryKey: GITHUB_APP_STATUS_KEY });
  }, [githubReturnFlag]);

  const startMutation = useMutation({
    mutationFn: () => startGitHubAppManifest({ org: org.trim() || undefined }),
    onSuccess: ({ github_create_url, manifest, state }) => {
      submitManifestForm(github_create_url, state, manifest);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to start GitHub App setup'),
  });

  if (!canManage) return null;

  if (statusQuery.isLoading) {
    return (
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-64" />
        </div>
        <Skeleton className="h-24 w-full rounded-md" />
      </div>
    );
  }

  // Non-fatal: the existing GitHub connections card below runs off its own
  // query, so a hiccup here just hides this summary rather than blocking the
  // whole Git tab.
  if (statusQuery.isError || !statusQuery.data) return null;

  const status: GitHubAppStatus = statusQuery.data;
  const showCreateForm = !status.configured || reconfiguring;

  return (
    <div className="space-y-4">
      <div className="space-y-0.5">
        <p className="text-foreground text-sm font-medium">GitHub App</p>
        <p className="text-muted-foreground text-xs">
          {status.configured
            ? 'The GitHub App that powers repository imports and installs for this instance.'
            : "Creates a GitHub App owned by your org; you'll pick which repos to grant at install."}
        </p>
      </div>

      {showCreateForm ? (
        <div className="bg-popover space-y-4 rounded-md border px-4 py-5">
          <div className="space-y-1.5">
            <Label className="text-xs">GitHub organization (optional)</Label>
            <Input
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              placeholder="e.g. Essentia-Innovation"
              disabled={startMutation.isPending}
              variant="popover"
            />
            <p className="text-muted-foreground text-xs">
              Leave blank to create the App under your personal GitHub account instead of an
              organization.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              className="gap-1.5"
              disabled={startMutation.isPending}
              onClick={() => startMutation.mutate()}
            >
              {startMutation.isPending ? (
                <Loading className="size-4 shrink-0" />
              ) : (
                <Github className="size-4" />
              )}
              {startMutation.isPending ? 'Redirecting to GitHub' : 'Create GitHub App'}
            </Button>
            {reconfiguring ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={startMutation.isPending}
                onClick={() => setReconfiguring(false)}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="bg-popover flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3.5">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-foreground truncate text-sm font-medium">
                {status.owner ?? 'GitHub App'}
              </span>
              <Badge variant="success" size="sm">
                Connected
              </Badge>
            </div>
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
              {status.slug ? (
                <a
                  href={`https://github.com/apps/${status.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-foreground inline-flex items-center gap-1"
                >
                  {status.slug}
                  <ExternalLink className="size-3" />
                </a>
              ) : null}
              {status.installation_id ? <span>Installation {status.installation_id}</span> : null}
            </div>
          </div>
          {status.source !== 'env' ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setReconfiguring(true)}>
              Reconfigure
            </Button>
          ) : (
            <span className="text-muted-foreground text-xs">Configured via environment</span>
          )}
        </div>
      )}
    </div>
  );
}
