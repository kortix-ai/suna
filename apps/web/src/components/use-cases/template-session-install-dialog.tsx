'use client';

import { listAccounts, listConnectors, provisionProject } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { SignInIcon as LogIn } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from '@/i18n/use-translations';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';

import { cn, faviconUrlForHostname } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import { Field, FieldLabel } from '@kortix/ui/field';
import { Input } from '@kortix/ui/input';
import Loading from '@kortix/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@kortix/ui/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kortix/ui/select';
import { errorToast, successToast } from '@kortix/ui/toast';
import { useProjectPicker } from '@/features/marketplace/marketplace-project-picker';
import { prepareMarketplaceInstallSessionNavigation } from '@/features/marketplace/marketplace-session-navigation';
import { useAuth } from '@/features/providers/auth-provider';
import { getMarketplaceItem, installMarketplaceItemAsSession } from '@/lib/marketplace-client';
import { isManagedGitUnavailableError } from '@kortix/ui/internal/lib/onboarding/provision-errors';

// First-party use-case templates ship in the bundled `kortix-starter` registry,
// so a use-case slug maps to the catalog id the install-session resolves by.
const TEMPLATE_CATALOG_NAMESPACE = 'kortix-starter';

// Same sentinel the marketplace AddToProjectModal uses: "create a project
// inline, then install into it" as one Select choice next to the projects.
const NEW_PROJECT = '__new__';

/** The part of a `registry:template` catalog item this dialog reads. The
 *  catalog sends it on the item detail; `MarketplaceItemDetail` does not
 *  type it. */
interface TemplateShape {
  agents?: Record<string, { skills?: string[] }>;
  connectors?: Array<{ slug: string; app?: string }>;
  triggers?: Array<{ slug: string; name?: string }>;
}

const titleCase = (slug: string) =>
  slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * "Use this template" on a use-case page. Pick a project, see what the
 * template adds, which of its connectors the project already has, and what
 * happens after the click. The install session runs in the cloud, so the
 * reader stays on the page: the dialog closes and a toast offers the session,
 * exactly like the marketplace "Add to project".
 */
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();
  const pathname = usePathname();
  const signInHref = `/auth?returnUrl=${encodeURIComponent(pathname ?? '/')}`;
  const catalogId = `${TEMPLATE_CATALOG_NAMESPACE}:${templateId}`;

  const [target, setTarget] = useState('');
  // null = the reader has not typed: the name follows the template title.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { projects, projectsQuery } = useProjectPicker({ open, enabled: !!user });
  const activeProjects = useMemo(() => projects.filter((p) => p.status === 'active'), [projects]);

  const itemQuery = useQuery({
    queryKey: ['marketplace', 'item', catalogId],
    queryFn: () => getMarketplaceItem(catalogId),
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const templateTitle = itemQuery.data?.title ?? title ?? titleCase(templateId);
  const newProjectName = nameDraft ?? templateTitle;

  const isExisting = !!target && target !== NEW_PROJECT;
  const connectorsQuery = useQuery({
    queryKey: qk.project.connectors(target),
    queryFn: () => listConnectors(target, { includeSchemas: false }),
    enabled: open && isExisting,
  });

  // Default the target once the list is known: the first project, or inline
  // creation when the account genuinely has none.
  useEffect(() => {
    if (!open || target || !projectsQuery.isSuccess) return;
    setTarget(activeProjects[0]?.project_id ?? NEW_PROJECT);
  }, [open, target, projectsQuery.isSuccess, activeProjects]);

  const template = (itemQuery.data as { template?: TemplateShape } | undefined)?.template;
  // One row per kind. Agent and skill read as their catalog titles
  // ("CRM hygiene agent"), not slugs; the trigger by its name.
  const summary = useMemo(() => {
    if (!template) return [];
    const deps = itemQuery.data?.dependencyItems ?? [];
    const titled = (type: string, fallback: string[]) => {
      const titles = deps.filter((d) => d.type === type).map((d) => d.title);
      return (titles.length ? titles : fallback).join(', ');
    };
    const agents = Object.keys(template.agents ?? {});
    const skills = Object.values(template.agents ?? {}).flatMap((a) => a.skills ?? []);
    const triggers = (template.triggers ?? []).map((t) => t.name ?? t.slug);
    return [
      { key: 'agent', label: tI18nComplete.raw('text11b39c93777e'), value: titled('registry:agent', agents) },
      { key: 'skill', label: tI18nComplete.raw('text6df1bb18a59a'), value: titled('registry:skill', skills) },
      { key: 'trigger', label: tI18nComplete.raw('text8b9c643731c9'), value: triggers.join(', ') },
    ].filter((row) => row.value);
  }, [template, itemQuery.data, tI18nComplete]);

  const connectors = useMemo(() => {
    const installed = connectorsQuery.data?.connectors ?? [];
    return (template?.connectors ?? []).map((c) => {
      const app = c.app ?? c.slug;
      const match = installed.find((p) => p.slug === c.slug || p.slug === app);
      return {
        slug: c.slug,
        name: match?.name ?? titleCase(app),
        icon: match?.iconUrl ?? faviconUrlForHostname(`${app}.com`),
        connected: match ? (match.state ?? (match.status === 'active' ? 'connected' : '')) === 'connected' : false,
      };
    });
  }, [template, connectorsQuery.data]);
  const targetName =
    target === NEW_PROJECT
      ? newProjectName.trim() || templateTitle
      : (activeProjects.find((p) => p.project_id === target)?.name ?? '');

  const guardedOpenChange = (next: boolean) => {
    // Block closing mid-flight: losing the pending state would leave the
    // reader unsure whether the request landed.
    if (busy) return;
    onOpenChange(next);
  };

  async function onConfirm() {
    if (busy) return;
    setBusy(true);
    try {
      let projectId = target;
      if (target === NEW_PROJECT) {
        const accounts = await listAccounts();
        // No `personal_account` flag on this API — the bootstrapped personal
        // account is the one where the caller is the primary owner.
        const account = accounts.find((a) => a.is_primary_owner) ?? accounts[0];
        if (!account) throw new Error('No account available to create a project in');
        const project = await provisionProject({
          account_id: account.account_id,
          name: targetName,
          starter_template: 'general-knowledge-worker',
        });
        // qk.projects.scope(): every account's list AND the accountless slot.
        queryClient.invalidateQueries({ queryKey: qk.projects.scope() });
        projectId = project.project_id;
      }
      const { session_id } = await installMarketplaceItemAsSession(projectId, catalogId);
      // Same as the marketplace "Add to project": the install session sets up
      // in the cloud on its own, so the reader stays on this page. The toast
      // offers the session; the turn-done toast reports the result.
      const sessionHref = prepareMarketplaceInstallSessionNavigation(
        queryClient,
        router,
        projectId,
        session_id,
      );
      onOpenChange(false);
      successToast(
        tI18nComplete('text724b09397472', { name: templateTitle, project: targetName }),
        {
          description: tI18nComplete.raw('text1e007c47254d'),
          duration: 8000, // audit:allow toast display time in ms, not motion
          actions: [
            {
              label: tI18nComplete.raw(sessionHref ? 'textb205bb47f81a' : 'texted077f3d8125'),
              onClick: () => router.push(sessionHref ?? `/projects/${projectId}`),
            },
          ],
        },
      );
    } catch (e) {
      errorToast(tI18nComplete.raw('textf913d83d88a5'), {
        description: isManagedGitUnavailableError(e)
          ? "Managed git isn't set up on this server — a platform admin connects GitHub in the admin console before projects can be created."
          : (e as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onConfirm();
  };

  const confirmDisabled =
    busy || !target || (target === NEW_PROJECT && newProjectName.trim().length === 0);

  return (
    <Modal open={open} onOpenChange={guardedOpenChange}>
      <ModalContent className="lg:max-w-md" closeOnOutsideClick={!busy}>
        <ModalHeader>
          <ModalTitle>{tI18nComplete.raw('text38d076d39951')}</ModalTitle>
          <ModalDescription className="mt-1 line-clamp-2">{templateTitle}</ModalDescription>
        </ModalHeader>

        {authLoading ? (
          <ModalBody>
            <InlineLoading label={tI18nComplete.raw('textcaea68eeb986')} />
          </ModalBody>
        ) : !user ? (
          <>
            <ModalBody>
              <p className="text-foreground text-sm font-medium">
                {tI18nComplete.raw('text6e4987bfe9c3')}
              </p>
              <p className="text-muted-foreground mt-1 text-sm text-pretty">
                {tI18nComplete.raw('text6f4639c90fa3')}
              </p>
            </ModalBody>
            <ModalFooter className="sm:justify-between">
              <Button type="button" variant="outline-ghost" size="sm" onClick={() => onOpenChange(false)}>
                {tI18nComplete.raw('text19766ed6ccb2')}
              </Button>
              <Button asChild size="sm">
                <Link href={signInHref}>
                  <LogIn className="size-4" /> {tI18nComplete.raw('text607a80121c65')}
                </Link>
              </Button>
            </ModalFooter>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <ModalBody className="pt-4">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="use-case-target-project">
                  {tI18nComplete.raw('text985959785319')}
                </FieldLabel>
                <Select value={target} onValueChange={setTarget}>
                  <SelectTrigger id="use-case-target-project">
                    <SelectValue
                      placeholder={
                        projectsQuery.isPending
                          ? tI18nComplete.raw('text6970a1ced73d')
                          : tI18nComplete.raw('text8ba607b13cd0')
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {activeProjects.map((p) => (
                      <SelectItem key={p.project_id} value={p.project_id}>
                        {p.name}
                      </SelectItem>
                    ))}
                    <SelectItem value={NEW_PROJECT}>{tI18nComplete.raw('text6a5058ba5252')}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              {target === NEW_PROJECT ? (
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="use-case-new-project-name">
                    {tI18nComplete.raw('textdcd1d5223f73')}
                  </FieldLabel>
                  <Input
                    id="use-case-new-project-name"
                    value={newProjectName}
                    onChange={(e) => setNameDraft(e.target.value)}
                    placeholder={templateTitle}
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                </Field>
              ) : null}

              <div>
                <dl className="border-border rounded-lg border px-3 py-1.5">
                  {itemQuery.isPending ? (
                    <InlineLoading />
                  ) : (
                    summary.map((row) => (
                      <SummaryRow key={row.key} label={row.label}>
                        <span className="truncate">{row.value}</span>
                      </SummaryRow>
                    ))
                  )}
                  {connectors.length > 0 ? (
                    <SummaryRow label={tI18nComplete.raw('textc3d2e79ebdd0')}>
                      {connectors.map((c) => (
                        <span key={c.slug} className="flex min-w-0 items-center gap-1.5">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={c.icon} alt="" className="size-3.5 shrink-0" />
                          <span className="truncate">{c.name}</span>
                          <span
                            aria-hidden
                            className={cn(
                              'size-1.5 shrink-0 rounded-full',
                              c.connected ? 'bg-kortix-green' : 'bg-kortix-yellow',
                            )}
                          />
                          <span className="sr-only">
                            {c.connected
                              ? tI18nComplete.raw('text22965568d22a')
                              : tI18nComplete.raw('text0303e1824670')}
                          </span>
                        </span>
                      ))}
                    </SummaryRow>
                  ) : null}
                </dl>
                <p className="text-muted-foreground mt-2 text-xs text-pretty">
                  {tI18nComplete.raw('text1e007c47254d')}
                </p>
              </div>
            </ModalBody>

            <ModalFooter className="sm:justify-between">
              <Button
                type="button"
                variant="outline-ghost"
                size="sm"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                {tI18nComplete.raw('text19766ed6ccb2')}
              </Button>
              <Button type="submit" size="sm" disabled={confirmDisabled}>
                {busy ? <Loading className="size-3.5 shrink-0" /> : null}
                {busy ? tI18nComplete.raw('textc6de6f45c827') : tI18nComplete.raw('textdf0fbf9c008f')}
              </Button>
            </ModalFooter>
          </form>
        )}
      </ModalContent>
    </Modal>
  );
}

/** One label / value line of the summary. Values wrap as a row of items. */
function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-4 py-1.5 text-sm">
      <dt className="text-muted-foreground w-20 shrink-0">{label}</dt>
      <dd className="text-foreground flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        {children}
      </dd>
    </div>
  );
}

function InlineLoading({ label }: { label?: string }) {
  return (
    <div className="text-muted-foreground flex h-8 items-center gap-2 text-sm">
      <Loading className="size-4" />
      {label}
    </div>
  );
}
