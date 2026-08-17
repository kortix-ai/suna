'use client';

/**
 * `CustomProviderPanel` — the Custom tab's whole body.
 *
 * ## Why this is a tab and not a section
 *
 * It used to be section 4 of the API-keys screen, behind an "Add a custom
 * provider" button. That put a job almost nobody does — pointing Kortix at a
 * self-hosted or unlisted OpenAI-compatible endpoint — at the bottom of the
 * screen EVERYBODY uses to paste an Anthropic key, where it was one more
 * heading to read past on the way to nothing.
 *
 * A tab costs the people who need it one click and costs everyone else
 * nothing, which is the trade a tab exists to make.
 *
 * ## Why it is a LIST, not a lone form
 *
 * The tab used to be one thing: a bordered card of six fields floating in an
 * otherwise empty pane, with no connection to the API-keys list one tab over
 * and no evidence that a custom provider you added last week exists at all.
 * Two problems, one fix — the same shape `provider-connect.tsx` uses:
 *
 *  1. *It read as a different product.* Same job (give this project a
 *     credential for a model endpoint), completely different screen. Now it is
 *     the same flat two-column row — identity left, value right, one axis down
 *     the page — so the two tabs are visibly one surface.
 *  2. *Nothing ever showed what you had already added.* A custom provider
 *     leaves exactly one trace on the server: the project secret
 *     `CUSTOM_<ID>_API_KEY` the form writes (see `custom-provider-form.tsx`).
 *     That is enough to list them, so the tab now opens on what this project
 *     already has, with the form under it.
 *
 * There is deliberately no Remove control on those rows. Deleting the secret
 * would NOT remove the provider — the provider itself lives in the repo's
 * `.opencode/opencode.jsonc`, which this app does not own — so a button
 * promising removal here would be lying about what it did.
 *
 * `CustomProviderForm` keeps the same fields, the same submit and the same
 * mutation; only its markup moved onto this row language. `onDone` still
 * returns the reader to the API keys tab, because "done" means the provider
 * now has a key like any other and the list is where it shows up.
 */

import { Skeleton } from '@/components/ui/skeleton';
import { ProviderLogo } from '@/features/providers/provider-branding';
import { listProjectSecrets } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { CheckCircleIcon as Check } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';

import { CustomProviderForm } from './custom-provider-form';

/** The one secret name shape `CustomProviderForm` writes. */
const CUSTOM_SECRET_PATTERN = /^CUSTOM_(.+)_API_KEY$/;

/**
 * Provider ids that already have a key on this project, recovered from the
 * secret names. Exported for the test that pins the round trip against the
 * name the form builds.
 */
export function customProviderIdsFromSecrets(names: string[]): string[] {
  const ids = new Set<string>();
  for (const name of names) {
    const match = CUSTOM_SECRET_PATTERN.exec(name);
    if (match?.[1]) ids.add(match[1].toLowerCase().replace(/_/g, '-'));
  }
  return [...ids].sort();
}

/** One added custom provider — same row grid as the API keys list. */
function CustomProviderRow({ id }: { id: string }) {
  return (
    <div className="grid gap-1.5 py-1.5 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] sm:items-center sm:gap-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <ProviderLogo providerID={id} name={id} size="small" />
        <span className="text-foreground truncate text-sm">{id}</span>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <span
          role="status"
          title="Key saved"
          aria-label="Key saved"
          className="flex shrink-0 items-center"
        >
          <Check className="text-kortix-green size-3.5 shrink-0" weight="fill" />
        </span>
        <span className="text-muted-foreground truncate text-xs">
          Key saved · declared in <span className="font-mono">.opencode/opencode.jsonc</span>
        </span>
      </div>
    </div>
  );
}

function AddedCustomProviders({ projectId }: { projectId: string }) {
  // Same query key the API-keys tab already fills, so this is a cache read in
  // every path that matters — no extra round trip for a list this small.
  const secrets = useQuery({
    queryKey: qk.project.secrets(projectId),
    queryFn: () => listProjectSecrets(projectId),
    ...contract('config'),
  });

  if (secrets.isPending) {
    return <Skeleton className="h-8 rounded-md" />;
  }

  const data = secrets.data;
  const items = Array.isArray(data) ? data : (data?.items ?? []);
  const ids = customProviderIdsFromSecrets(items.map((item) => item.name));
  if (ids.length === 0) return null;

  return (
    <div className="flex flex-col">
      {ids.map((id) => (
        <CustomProviderRow key={id} id={id} />
      ))}
    </div>
  );
}

export function CustomProviderPanel({
  projectId,
  canWrite = false,
  onDone,
}: {
  projectId: string;
  canWrite?: boolean;
  /** Called on a successful save — hosts send the reader back to the API keys
   *  list, where the new provider now has a row. */
  onDone?: () => void;
}) {
  if (!canWrite) {
    return (
      <div className="flex min-h-[200px] flex-col items-center justify-center gap-1 px-6 text-center">
        <p className="text-foreground text-sm">Read-only access</p>
        <p className="text-muted-foreground max-w-xs text-xs text-pretty">
          Ask an owner of this project to connect a custom provider.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 px-5 py-5">
      {/* The one sentence on the screen, in the same slot the API keys tab puts
          its own — this tab is for the endpoint the catalog does not carry. */}
      <p className="text-muted-foreground px-0.5 text-xs text-pretty">
        Point this project at any OpenAI-compatible endpoint — self-hosted, on-prem, or a provider
        that isn't in the catalog. Everything the catalog does carry belongs on the API keys tab.
      </p>

      <AddedCustomProviders projectId={projectId} />

      <CustomProviderForm projectId={projectId} onDone={() => onDone?.()} />
    </div>
  );
}
