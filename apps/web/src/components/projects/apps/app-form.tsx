'use client';

import { useTranslations } from 'next-intl';
/**
 * Add / edit form for a single `[[apps]]` entry. Writes via POST or PATCH
 * to `/v1/projects/:id/apps[/:slug]`. Used by the Apps overlay's `create`
 * and `edit` sections.
 */

import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { IconAdd, IconLoader, IconRemove } from '@/components/ui/kortix-icons';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/lib/toast';

import { useCreateProjectApp, useUpdateProjectApp } from '@/hooks/projects/use-project-apps';
import type { CreateOrUpdateProjectAppInput, ProjectApp } from '@/lib/projects-apps-client';

interface AppFormProps {
  projectId: string;
  /** When set, the form is in edit mode. */
  existing?: ProjectApp;
  onDone: () => void;
}

interface EnvRow {
  key: string;
  value: string;
}

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}

export function AppForm({ projectId, existing, onDone }: AppFormProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const isEdit = !!existing;
  const createMut = useCreateProjectApp(projectId);
  const updateMut = useUpdateProjectApp(projectId);

  // Initialise from existing app or sensible blank slate.
  const [name, setName] = useState(existing?.name ?? '');
  const [slug, setSlug] = useState(existing?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(isEdit);
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [framework, setFramework] = useState(existing?.framework ?? '');
  const [sourceType, setSourceType] = useState<'git' | 'tar'>(existing?.source.type ?? 'git');
  const [gitRepo, setGitRepo] = useState(
    existing?.source.type === 'git' ? (existing.source.repo ?? '') : '',
  );
  const [gitBranch, setGitBranch] = useState(
    existing?.source.type === 'git' ? (existing.source.branch ?? '') : '',
  );
  const [gitRootPath, setGitRootPath] = useState(
    existing?.source.type === 'git' ? (existing.source.root_path ?? '') : '',
  );
  const [tarUrl, setTarUrl] = useState(existing?.source.type === 'tar' ? existing.source.url : '');
  const [buildCommand, setBuildCommand] = useState(existing?.build?.command ?? '');
  const [buildOutDir, setBuildOutDir] = useState(existing?.build?.out_dir ?? '');
  const [domains, setDomains] = useState<string>((existing?.domains ?? []).join('\n'));
  const [envRows, setEnvRows] = useState<EnvRow[]>(
    Object.entries(existing?.env ?? {}).map(([key, value]) => ({ key, value })),
  );

  // Auto-derive slug from name in create mode until the user edits the
  // slug field directly.
  useEffect(() => {
    if (!isEdit && !slugTouched) setSlug(deriveSlug(name));
  }, [name, isEdit, slugTouched]);

  const submitting = createMut.isPending || updateMut.isPending;

  const domainList = useMemo(
    () =>
      domains
        .split('\n')
        .map((d) => d.trim())
        .filter(Boolean),
    [domains],
  );
  const envObject = useMemo(() => {
    const out: Record<string, string> = {};
    for (const row of envRows) {
      const k = row.key.trim();
      if (k) out[k] = row.value;
    }
    return out;
  }, [envRows]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const input: CreateOrUpdateProjectAppInput = {
      slug: slug.trim() || undefined,
      name: name.trim() || undefined,
      enabled,
      framework: framework.trim() || null,
      domains: domainList,
      source:
        sourceType === 'git'
          ? {
              type: 'git',
              repo: gitRepo.trim() || null,
              branch: gitBranch.trim() || null,
              root_path: gitRootPath.trim() || null,
            }
          : { type: 'tar', url: tarUrl.trim() },
      build:
        buildCommand.trim() || buildOutDir.trim()
          ? { command: buildCommand.trim() || null, out_dir: buildOutDir.trim() || null }
          : null,
      env: envObject,
    };
    try {
      if (isEdit && existing) {
        await updateMut.mutateAsync({ slug: existing.slug, input });
        toast.success('App saved');
      } else {
        await createMut.mutateAsync(input);
        toast.success('App added');
      }
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save app');
    }
  }

  return (
    <form className="flex h-full flex-col" onSubmit={handleSubmit}>
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto flex max-w-2xl flex-col gap-5">
          {/* Identity */}
          <section className="flex flex-col gap-3">
            <h3 className="text-foreground text-sm font-medium">Basics</h3>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="app-name">Name</Label>
              <Input
                id="app-name"
                placeholder={tI18nHardcoded.raw(
                  'autoComponentsProjectsAppsAppFormJsxAttrPlaceholderMarketingSite3dbd4da7',
                )}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus={!isEdit}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="app-slug">
                {tI18nHardcoded.raw('autoComponentsProjectsAppsAppFormJsxTextURLSafeId73159819')}
              </Label>
              <Input
                id="app-slug"
                placeholder="marketing-site"
                value={slug}
                disabled={isEdit}
                onChange={(e) => {
                  setSlug(e.target.value);
                  setSlugTouched(true);
                }}
                required
              />
              <p className="text-muted-foreground text-xs">
                {isEdit
                  ? 'The id is fixed once an app is created.'
                  : 'Lowercase letters, digits, dashes. Auto-filled from the name.'}
              </p>
            </div>
            <div className="border-border/60 bg-muted/20 flex items-center justify-between gap-3 rounded-2xl border px-3 py-2.5">
              <div className="flex flex-col">
                <Label htmlFor="app-enabled" className="cursor-pointer">
                  Enabled
                </Label>
                <p className="text-muted-foreground text-xs">
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsAppsAppFormJsxTextWhenOffAutomatic03862174',
                  )}
                </p>
              </div>
              <Switch id="app-enabled" checked={enabled} onCheckedChange={setEnabled} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="app-framework">
                {tI18nHardcoded.raw(
                  'autoComponentsProjectsAppsAppFormJsxTextFrameworkOptional363cf93a',
                )}
              </Label>
              <Input
                id="app-framework"
                placeholder={tI18nHardcoded.raw(
                  'autoComponentsProjectsAppsAppFormJsxAttrPlaceholderNextVite774c6cb6',
                )}
                value={framework}
                onChange={(e) => setFramework(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                {tI18nHardcoded.raw('autoComponentsProjectsAppsAppFormJsxTextAHintForf08a90ef')}
              </p>
            </div>
          </section>

          {/* Source */}
          <section className="flex flex-col gap-3">
            <h3 className="text-foreground text-sm font-medium">
              {tI18nHardcoded.raw('autoComponentsProjectsAppsAppFormJsxTextSourceCode17814b75')}
            </h3>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={sourceType === 'git' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setSourceType('git')}
              >
                {tI18nHardcoded.raw(
                  'autoComponentsProjectsAppsAppFormJsxTextGitRepository8788e9fe',
                )}
              </Button>
              <Button
                type="button"
                variant={sourceType === 'tar' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setSourceType('tar')}
              >
                {tI18nHardcoded.raw(
                  'autoComponentsProjectsAppsAppFormJsxTextPrebuiltTarball0dcb58f3',
                )}
              </Button>
            </div>
            {sourceType === 'git' ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="git-repo">
                    {tI18nHardcoded.raw(
                      'autoComponentsProjectsAppsAppFormJsxTextRepositoryURL63f64b8e',
                    )}
                  </Label>
                  <Input
                    id="git-repo"
                    placeholder="https://github.com/you/site (leave blank to use this project's repo)"
                    value={gitRepo}
                    onChange={(e) => setGitRepo(e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="git-branch">Branch</Label>
                    <Input
                      id="git-branch"
                      placeholder={tI18nHardcoded.raw(
                        'autoComponentsProjectsAppsAppFormJsxAttrPlaceholderMainDefaults1ce15243',
                      )}
                      value={gitBranch}
                      onChange={(e) => setGitBranch(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="git-root">Subfolder</Label>
                    <Input
                      id="git-root"
                      placeholder={tI18nHardcoded.raw(
                        'autoComponentsProjectsAppsAppFormJsxAttrPlaceholderAppsWeb1e08c767',
                      )}
                      value={gitRootPath}
                      onChange={(e) => setGitRootPath(e.target.value)}
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tar-url">
                  {tI18nHardcoded.raw('autoComponentsProjectsAppsAppFormJsxTextTarballURL7093f44f')}
                </Label>
                <Input
                  id="tar-url"
                  placeholder="https://…/build.tgz"
                  value={tarUrl}
                  onChange={(e) => setTarUrl(e.target.value)}
                  required
                />
              </div>
            )}
          </section>

          {/* Build */}
          <section className="flex flex-col gap-3">
            <h3 className="text-foreground text-sm font-medium">
              {tI18nHardcoded.raw('autoComponentsProjectsAppsAppFormJsxTextBuildOptionalc15a138e')}
            </h3>
            <p className="text-muted-foreground text-xs">
              {tI18nHardcoded.raw('autoComponentsProjectsAppsAppFormJsxTextLeaveBothBlank57472108')}
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="build-cmd">Command</Label>
                <Input
                  id="build-cmd"
                  placeholder={tI18nHardcoded.raw(
                    'autoComponentsProjectsAppsAppFormJsxAttrPlaceholderPnpmBuilde2421ca5',
                  )}
                  value={buildCommand}
                  onChange={(e) => setBuildCommand(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="build-out">
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsAppsAppFormJsxTextOutputFolderfd532492',
                  )}
                </Label>
                <Input
                  id="build-out"
                  placeholder="dist"
                  value={buildOutDir}
                  onChange={(e) => setBuildOutDir(e.target.value)}
                />
              </div>
            </div>
          </section>

          {/* Domains */}
          <section className="flex flex-col gap-3">
            <h3 className="text-foreground text-sm font-medium">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsAppsAppFormJsxTextDomainsOptionalfb4dc02d',
              )}
            </h3>
            <Textarea
              placeholder={tI18nHardcoded.raw(
                'autoComponentsProjectsAppsAppFormJsxAttrPlaceholderMarketingExampledede1014',
              )}
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              rows={3}
            />
            <p className="text-muted-foreground text-xs">
              {tI18nHardcoded.raw('autoComponentsProjectsAppsAppFormJsxTextOnePerLine4dfb7f2a')}{' '}
              <code className="font-mono">
                {tI18nHardcoded.raw('autoComponentsProjectsAppsAppFormJsxTextStyleDev4d6d9c32')}
              </code>{' '}
              {tI18nHardcoded.raw(
                'autoComponentsProjectsAppsAppFormJsxTextURLAutomaticallyc0a71dc7',
              )}
            </p>
          </section>

          {/* Env */}
          <section className="flex flex-col gap-3">
            <h3 className="text-foreground text-sm font-medium">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsAppsAppFormJsxTextEnvironmentVariablesOptional9342f8a8',
              )}
            </h3>
            <div className="flex flex-col gap-2">
              {envRows.length === 0 && (
                <p className="text-muted-foreground text-xs">
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsAppsAppFormJsxTextAddPublicEnv9b115d33',
                  )}
                </p>
              )}
              {envRows.map((row, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    className="flex-1"
                    placeholder="NEXT_PUBLIC_API_URL"
                    value={row.key}
                    onChange={(e) =>
                      setEnvRows((rows) =>
                        rows.map((r, i) => (i === idx ? { ...r, key: e.target.value } : r)),
                      )
                    }
                  />
                  <Input
                    className="flex-[2]"
                    placeholder="https://api.example.com"
                    value={row.value}
                    onChange={(e) =>
                      setEnvRows((rows) =>
                        rows.map((r, i) => (i === idx ? { ...r, value: e.target.value } : r)),
                      )
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setEnvRows((rows) => rows.filter((_, i) => i !== idx))}
                    aria-label={tI18nHardcoded.raw(
                      'autoComponentsProjectsAppsAppFormJsxAttrAriaLabelRemoveb7171a78',
                    )}
                  >
                    <IconRemove className="size-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => setEnvRows((rows) => [...rows, { key: '', value: '' }])}
              >
                <IconAdd className="size-3.5" />
                {tI18nHardcoded.raw('autoComponentsProjectsAppsAppFormJsxTextAddVariable2fc325a3')}
              </Button>
            </div>
          </section>
        </div>
      </div>

      <div className="border-border/60 flex shrink-0 items-center justify-between gap-3 border-t px-5 py-3">
        <p className="text-muted-foreground hidden truncate text-xs sm:block">
          {tI18nHardcoded.raw('autoComponentsProjectsAppsAppFormJsxTextSavesToa1795d11')}
          <code className="font-mono">kortix.yaml</code>{' '}
          {tI18nHardcoded.raw('autoComponentsProjectsAppsAppFormJsxTextDeployWhenYou063c0c34')}
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={onDone} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting && <IconLoader className="size-3.5 animate-spin" />}
            {isEdit ? 'Save changes' : 'Add app'}
          </Button>
        </div>
      </div>
    </form>
  );
}
